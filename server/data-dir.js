'use strict';
/* ============================================================
   data-dir.js —— 数据目录的查询与切换（2026-09-23 新增）

   背景：数据根一直是"可改、但不好改"，只有两条路 ——
     · 环境变量 `JC_DATA_DIR`（进程级，改了要重启且只对下次生效）
     · 桌面版手动编辑 `%APPDATA%\<产品名>\desktop-config.json`
   本模块把它收成两个供界面调用的动作：`describe()` 与 `change()`。

   ★ 三条不可妥协的约束：

   1. **迁移用复制，不用移动。** 移动中途失败会两边都不完整；复制失败时原库完好，
      最坏情况只是目标目录留下一份半成品（用户可删）。代价是需要双倍磁盘空间。
   2. **配置只在全部成功之后才写。** 写早了等于"指针已切、数据没到" ——
      用户打开应用看到空库，比直接报错更糟。
   3. **切换必须重启才生效。** 本进程的 store 已经把旧目录的 db.json 读进了内存，
      继续跑会把它写回旧目录（或新旧各写一份）。所以本模块只负责"校验 + 搬数据 + 改配置"，
      重启由界面引导。

   ⚠ 只对**桌面版**开放（判据：`runtime.getConfigPath()` 非空）。网页版没有持久化
   数据目录的机制（只有 `JC_DATA_DIR`），那里直接拒绝并提示用环境变量。

   ⚠ 关于"活动任务"：**没有复用 projects.hasActiveTasks** —— 它只在传了
   projectId/workspaceId 时才统计（两处判定都在 `if (o.xxx)` 保护内），
   不传作用域会返回 `{active:false}`。迁移要的是"全库有没有任务在跑"，故单独实现。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { ERR, ApiError } = require('./util');
const runtime = require('./runtime');

/* 迁移时搬运的顶层条目。刻意**不搬**日志与窗口状态 ——
   它们属于 userData（`%APPDATA%\<产品名>\`），不是"用户的库"。 */
const MOVE_ENTRIES = ['db.json', 'projects', 'backup'];

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/* 原子写：先写 .tmp 再 rename。与 runtime-paths.writeJson 同款做法 ——
   这里不 require 它，因为 server/ 不该反向依赖 desktop/。 */
function writeJsonFile(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error('[data-dir] 写配置失败：' + p + ' —— ' + ((e && e.message) || e));
    return false;
  }
}

/* 目录真的可写吗 —— 只有写进去再删掉才算数（只看 existsSync 不够）。 */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) { return false; }
}

/* child 是否在 parent 内部（含相等返回 false，相等由调用方单独判） */
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const n of fs.readdirSync(p)) total += sizeOf(path.join(p, n));
    return total;
  } catch (e) { return 0; }
}

/* 全库活动任务数。与 projects.ACTIVE_STATUSES 保持同一口径
   （排队中 / 生成中，或 CLI 任务停在 submitting）。 */
function countActiveTasks(db) {
  const ACTIVE = ['queued', 'generating'];
  let n = 0;
  (db.storyboards || []).forEach((s) => { if (s && ACTIVE.includes(s.status)) n++; });
  const jobs = db.cliJobs || {};
  Object.keys(jobs).forEach((id) => { const j = jobs[id]; if (j && j.state === 'submitting') n++; });
  return n;
}

/* 统一的目标目录校验。抛 ApiError；通过则返回规范化后的绝对路径。
   抽出来是为了让 GET（预检）与 POST（执行）用**同一套**规则，
   避免界面上"看着能选、点下去才被拒"。 */
function validateTarget(dir, opts) {
  const o = opts || {};
  const raw = String(dir == null ? '' : dir).trim();
  if (!raw) throw new ApiError(ERR.PARAM, '请填写目标目录');
  if (!path.isAbsolute(raw)) throw new ApiError(ERR.PARAM, '请填写绝对路径，例如 D:\\JimengData');

  const target = path.resolve(raw);
  const current = path.resolve(runtime.getDataDir());

  if (target === path.parse(target).root) {
    throw new ApiError(ERR.PARAM, '不能把数据直接放在磁盘根目录（' + target + '）');
  }
  if (target === current) {
    throw new ApiError(ERR.PARAM, '目标目录与当前数据目录相同');
  }
  if (isInside(target, current)) {
    throw new ApiError(ERR.PARAM, '目标目录不能位于当前数据目录内部 —— 切换后会把库套进自己里面');
  }
  if (isInside(current, target)) {
    throw new ApiError(ERR.PARAM, '目标目录不能包含当前数据目录，否则旧库会被卷进新库');
  }
  if (isInside(target, runtime.CLI_DEFAULT_DATA_DIR)) {
    throw new ApiError(ERR.PARAM, '不能把数据放在项目的 server/data 下（该目录不入 git，容易被误删）');
  }

  const exists = fs.existsSync(target);
  const entries = exists ? fs.readdirSync(target) : [];
  if (o.requireEmpty && entries.length) {
    throw new ApiError(ERR.CONFLICT,
      '目标目录不是空的（已有 ' + entries.length + ' 项）。迁移只写入空目录，避免覆盖文件 —— '
      + '请换一个空目录，或改用「仅切换」',
      { target, entries: entries.slice(0, 20) });
  }
  if (!isWritable(target)) {
    throw new ApiError(ERR.PARAM, '目标目录不可写：' + target, { target });
  }

  return { target, exists, entries, empty: entries.length === 0 };
}

/* 当前状态快照 —— 界面的唯一数据来源。 */
function describe() {
  const cfgPath = runtime.getConfigPath();
  const envPinned = !!process.env.JC_DATA_DIR;
  const cfg = cfgPath ? (readJsonFile(cfgPath) || {}) : {};
  const dataDir = path.resolve(runtime.getDataDir());
  const configured = cfg.dataDir ? path.resolve(String(cfg.dataDir)) : null;

  let canChange = true;
  let reason = null;
  if (!cfgPath) { canChange = false; reason = '当前是网页版运行模式：数据目录由 JC_DATA_DIR 环境变量决定，请在启动服务前设置它'; }
  else if (envPinned) { canChange = false; reason = 'JC_DATA_DIR 环境变量的优先级高于配置文件，改配置不会生效 —— 请先取消该环境变量再启动'; }

  return {
    dataDir,
    configuredDir: configured,
    configPath: cfgPath || null,
    fromEnv: envPinned,
    mode: runtime.getMode(),
    isDesktop: runtime.isDesktop(),
    canChange,
    reason,
    moveEntries: MOVE_ENTRIES.slice()
  };
}

/* 切换数据目录。
     opts = { dir, mode: 'move' | 'switch' }
   —— 'move'   把库搬过去再切（目标必须是空目录）
   —— 'switch' 只改指向（目标可以是空目录，也可以是你已经手动搬好的目录）
   返回一份可展示的报告；**调用方必须提示用户重启**。 */
function change(db, opts) {
  const o = opts || {};
  const mode = o.mode === 'move' ? 'move' : (o.mode === 'switch' ? 'switch' : null);
  if (!mode) throw new ApiError(ERR.PARAM, "mode 必须是 'move'（迁移并切换）或 'switch'（仅切换）");

  const state = describe();
  if (!state.canChange) throw new ApiError(ERR.FORBIDDEN, state.reason || '当前模式不支持更改数据目录');

  const active = countActiveTasks(db);
  if (active > 0) {
    throw new ApiError(ERR.CONFLICT,
      '当前有 ' + active + ' 个生成任务在进行，迁移会让它们写坏数据 —— 请先等任务完成或取消',
      { activeCount: active });
  }

  const v = validateTarget(o.dir, { requireEmpty: mode === 'move' });
  const from = state.dataDir;
  const report = {
    mode, from, to: v.target,
    moved: [], skipped: [], bytes: 0,
    needRestart: true,
    configPath: state.configPath
  };

  if (mode === 'move') {
    for (const name of MOVE_ENTRIES) {
      const src = path.join(from, name);
      if (!fs.existsSync(src)) { report.skipped.push(name); continue; }
      try {
        fs.cpSync(src, path.join(v.target, name), { recursive: true });
      } catch (e) {
        throw new ApiError(ERR.INTERNAL,
          '复制 ' + name + ' 失败：' + ((e && e.message) || e)
          + '。**原库未受影响**，目标目录可能留有半份副本，可自行删除。',
          { failedEntry: name, from, to: v.target, report });
      }
      report.moved.push(name);
      report.bytes += sizeOf(src);
    }

    /* 校验：条目齐全 + db.json 字节数一致。不通过就**不写配置**。 */
    for (const name of report.moved) {
      if (!fs.existsSync(path.join(v.target, name))) {
        throw new ApiError(ERR.INTERNAL, '迁移校验失败：' + name + ' 未出现在目标目录。**配置未改动**，仍指向原库。',
          { report });
      }
    }
    const sDb = path.join(from, 'db.json');
    const tDb = path.join(v.target, 'db.json');
    if (fs.existsSync(sDb)) {
      const a = fs.statSync(sDb).size;
      const b = fs.existsSync(tDb) ? fs.statSync(tDb).size : -1;
      if (a !== b) {
        throw new ApiError(ERR.INTERNAL,
          '迁移校验失败：db.json 大小不一致（源 ' + a + ' 字节 / 目标 ' + b + ' 字节）。**配置未改动**，仍指向原库。',
          { report });
      }
    }
  }

  /* 最后一步才改配置 —— 到这里的每一道校验都已通过。 */
  const cfg = readJsonFile(state.configPath) || {};
  if (!writeJsonFile(state.configPath, Object.assign({}, cfg, { dataDir: v.target }))) {
    throw new ApiError(ERR.INTERNAL,
      '数据已就绪，但写配置失败：' + state.configPath + '。配置未变，应用重启后仍使用原目录。',
      { report });
  }

  return report;
}

module.exports = { describe, change, validateTarget, countActiveTasks, MOVE_ENTRIES };
