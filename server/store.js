'use strict';
/* ============================================================
   store.js —— JSON 持久化（原子写）
   设计文档 §2 的落地取舍：单用户本地桥接服务，SQLite → JSON 文件
   （原子写 = 临时文件 + rename），避免 Windows 原生模块编译依赖。
   空库启动：不预置任何演示数据，数据一律来自真实数据流
   （批量导入 / 接口创建）。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const configMod = require('./config');
/* ⚠ 这两个路径**不是常量**：桌面版会把数据根指到用户可写目录（见 runtime.js）。
   每次调用现取，绝不在这里解构快照 —— 否则桌面版会写进安装目录（Program Files 下只读）。 */
const DATA_DIR = () => configMod.DATA_DIR;
const DB_FILE = () => configMod.DB_FILE;
const { nowIso } = require('./util');
const schema = require('./schema');   // schema 版本与迁移框架（迁移唯一入口）

let db = null;
let saveTimer = null;

/* 空库：**不预置任何项目/工作区**。
   全新安装时首页应该是一张空的项目卡片墙 + 「创建项目」，而不是凭空多出一个
   用户没建过的项目。因此这里 projects/workspaces 为空、schemaVersion 直接是当前版本
   （空库没有旧数据可迁，跳过迁移）。 */
function emptyDb() {
  return {
    schemaVersion: schema.SCHEMA_VERSION,
    projects: [],
    workspaces: [],
    storyboards: [],
    assets: [],
    settings: {
      delimiter: { type: 'custom', value: ';;' },
      /* 默认模型用创作域名（2026-09-18 画布 CLI 移除后，画布域名 seedance_2.0_vip 已不再可用）。
         等价关系：seedance_2.0_vip ↔ seedance2.0_vip，底层是同一个模型，只是换了套命名。 */
      defaults: { model: 'seedance2.0_vip', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' },
      queue: { concurrency: 2, autoRetry: true, maxRetry: 2 },
      // 只有一个生成引擎（创作 CLI），故不再有 engine 优先项与画布 CLI 状态字段
      adapter: { dreaminaAvailable: false, dreaminaVersion: null }
    },
    seq: 0,
    idempotency: {},     // key -> { response, createdAt }
    cliJobs: {},         // storyboardId -> { submitId, state, command, argv, mode, cliModel, engine, projectId, workspaceId, ... }
    logs: {},            // storyboardId -> [{ level, msg, ts }]
    records: [],         // 生成记录：追加式快照（见 records.js），新记录在前
    recordSeq: 0         // 累计落过多少条（删记录不回退，用于展示"第 N 条"）
  };
}

/* 把不可用的 db.json 先另存为 .corrupt-<时间> 再重建，杜绝「静默清空」——
   事故当天正是因为没有这一步，空库直接覆盖了真实数据，事后无从追查。 */
function quarantine(file, why) {
  try {
    const bak = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, bak);
    console.error('[store] db.json 不可用（' + why + '），已备份为 ' + path.basename(bak) + '，随后重建空库');
    return bak;
  } catch (e) {
    console.error('[store] db.json 不可用（' + why + '），且备份失败：' + e.message);
    return null;
  }
}

/* ---------------- 损坏恢复：尝试从备份回退（2026-09-21 新增） ----------------
   原先的流程是"解析失败 → 隔离 → 建空库"，**从不尝试备份**。
   于是一次真实的磁盘损坏（或恶意写入）会让用户看到空项目列表 ——
   数据其实还躺在 db.json.bak-* 和 backup/ 里，只是没人去找。

   现在的恢复链（与 docs/项目审查与改进清单.md §12 一致）：
     读 db.json
       ├─ 成功且结构合法 → 正常启动
       ├─ JSON 损坏 → 尝试最新备份（db.json.bak-*，新→旧）
       ├─ 该备份也损坏 → 逐个尝试更旧的备份
       ├─ 轮转备份都不行 → 再试 backup/pre-schema-*.json（迁移前独立副本）
       └─ 全部失败 → 安全启动为空库，但**必须明确提示用户**

   ⚠ 三条纪律：
     1. 损坏的原文件**一定先隔离**（quarantine），不覆盖不丢证据；
     2. 回退成功必须**写日志**（含用的是哪份备份），别让"自动恢复"变成无声的篡改；
     3. 只有真的一个可用备份都没有，才落到空库 —— 且返回状态给上层去提示用户。

   返回 { db, recovered: true, from, corruptBak } 或 { db: null, recovered: false, corruptBak }。 */
const BACKUP_PREFIX = 'db.json.bak-';

/* 列候选备份：轮转备份（新→旧）在前，迁移前独立备份（新→旧）在后。
   为什么迁移备份排后面：它按版本命名、数量少、且可能很旧；
   轮转备份才是"最近的真实状态"。 */
function restoreCandidates() {
  const out = [];
  try {
    fs.readdirSync(DATA_DIR())
      .filter((f) => f.startsWith(BACKUP_PREFIX) && !f.includes('.corrupt-'))
      .sort().reverse()
      .forEach((f) => out.push(path.join(DATA_DIR(), f)));
  } catch (e) { /* 目录读不到就算了 */ }
  try {
    const bdir = path.join(DATA_DIR(), 'backup');
    fs.readdirSync(bdir)
      .filter((f) => /^pre-schema-v\d+-.*\.json$/.test(f))
      .sort().reverse()
      .forEach((f) => out.push(path.join(bdir, f)));
  } catch (e) { /* 没有 backup/ 目录是正常的 */ }
  return out;
}

/* 试读一个候选备份。要求"能解析 + 是对象 + 有 projects 数组 + **确实含数据**"——
   最后一点是关键（2026-09-21 加）：`rotateBackup` 在首次写入时会把**空库**存成 .bak，
   而"从空库恢复"是个假成功 —— 用户看到恢复日志、看到的却仍是空项目列表。
   所以空壳不当恢复目标，继续往下找更旧的备份；全都没有才落到"空库启动 + 明确告警"。
   ⚠ 结构对不上（无 projects 数组）也跳过：.bak 理论上可能是半截写入
     （原子写保证了主库不会，但备份是 copyFile 出来的）。 */
function tryLoadBackup(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.projects)) return null;
    const hasData = parsed.projects.length || (parsed.workspaces || []).length
      || (parsed.storyboards || []).length || (parsed.assets || []).length
      || (parsed.records || []).length;
    if (!hasData) return null;
    return parsed;
  } catch (e) { return null; }
}

/* 候选中是否有**有效**备份（含数据、可解析）。saveNow 用它决定"要不要留关键恢复点"。 */
function hasUsableBackup() {
  return listBackups().some((f) => !!tryLoadBackup(f));
}

/* 依次尝试候选备份，返回第一个可用的。找不到返回 null。 */
function recoverFromBackup() {
  const cands = restoreCandidates();
  for (const f of cands) {
    const db = tryLoadBackup(f);
    if (db) return { db, from: f };
  }
  return { db: null, from: null, tried: cands.length };
}

/* 迁移前额外留一份带版本号的备份（2026-09-19 多项目升级）。
   为什么不能只靠 rotateBackup：那个是**滚动**的（只留最近 12 份、且 2 分钟内只复制一次），
   一次迁移事故之后很容易被后续写入挤出保留窗口。迁移是不可逆的数据改写，
   必须有名字可辨识、不会被轮转挤掉的独立副本。
   ⚠ 备份失败即**中止迁移** —— 没有回退点的迁移不许做。 */
function backupBeforeMigration(fromVersion) {
  const dir = path.join(DATA_DIR(), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, 'pre-schema-v' + (fromVersion + 1) + '-' + ts + '.json');
  fs.copyFileSync(DB_FILE(), dest);
  console.log('[迁移] 迁移前备份：' + path.relative(path.join(__dirname, '..'), dest));
  return dest;
}

/* 最近一次"从备份恢复"的记录，供 /system/adapter 或首页提示用。
   ⚠ 只在**真的发生过恢复**时非空；正常启动一律为 null，不要给它加默认值。 */
let lastRecovery = null;
const recoveryInfo = () => lastRecovery;

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  /* ⚠ 这里以前还会 mkdir data/output 与 data/assets。那两处是旧的扁平布局，
     现在已经没有代码往里面写东西了；再建出来只会让"彻底删除项目"之后
     看起来还剩两个空目录，误导人以为没删干净。需要时由 paths.ensureProjectDirs 建项目目录。 */
  let corruptBak = null;
  if (fs.existsSync(DB_FILE())) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE(), 'utf8'));
      // JSON.parse('null') 不抛异常却返回 null：必须按「损坏」处理，否则会被当成空库静默重建
      if (parsed && typeof parsed === 'object') db = parsed;
      else { corruptBak = quarantine(DB_FILE(), '内容不是对象：' + String(parsed)); db = null; }
    } catch (e) { corruptBak = quarantine(DB_FILE(), '解析失败：' + e.message); db = null; }
  }

  /* ★ 损坏恢复：主库读不出来（或结构不可用）时，先去找备份，而不是直接空库。
     为什么这一步不能省：空库启动的表现是"项目全没了"，用户第一反应是数据丢了；
     而实际上 db.json.bak-* / backup/ 里往往还有完好的副本。 */
  if (!db && corruptBak) {
    const rec = recoverFromBackup();
    if (rec.db) {
      db = rec.db;
      lastRecovery = {
        at: nowIso(),
        from: rec.from,
        fromName: path.basename(rec.from),
        corruptBackup: corruptBak ? path.basename(corruptBak) : null
      };
      console.warn('[store] 主库损坏，已从备份恢复：' + path.basename(rec.from)
        + '（损坏原文件已保留为 ' + path.basename(corruptBak) + '）');
      /* 立刻把恢复结果写成新主库 —— 否则这次恢复只存在于内存，
         进程一退就又要再走一遍恢复链，且期间的新写入会落空。 */
      try { saveNow(); } catch (e) { console.error('[store] 恢复后写盘失败：' + e.message); }
    } else {
      console.error('[store] 主库损坏且没有可用备份（已试 ' + rec.tried + ' 份），将以空库启动'
        + '（损坏原文件保留为 ' + (corruptBak ? path.basename(corruptBak) : '（隔离失败）') + '）');
    }
  }

  if (!db) { db = emptyDb(); saveNow(); console.log('[store] 空库初始化完成'); return db; }

  /* 旧版演示库（带种子标记）：清空重置，避免假数据流入真实链路。
     这一步必须排在迁移**之前** —— 它丢弃的是数据本身，不是结构。 */
  if (db.seededAt !== undefined) {
    const fresh = emptyDb();
    fresh.idempotency = db.idempotency || {};
    db = fresh;
    saveNow();
    console.log('[store] 检测到旧演示数据，已清空重置');
    return db;
  }

  /* ---------------- 版本化迁移 ----------------
     这是结构变更的**唯一入口**。原先散落的 `if (!db.X)` 垫片与
     services.getOptions() 里"借 GET 请求改写并落盘"的模型名迁移，
     全部收敛到 schema.js 的迁移链里，从此可以回答"这个库是第几版、还需要跑什么"。

     ⚠ 失败处理：runMigrations 在克隆体上跑，抛错时 db 一个字节都没变。
       此时**拒绝写盘并让 load() 抛错** —— 服务起不来，远好于带着半迁移的库继续跑。
       旧库与迁移前备份都在磁盘上，可人工恢复。 */
  const fromVersion = schema.readVersion(db);
  if (fromVersion < schema.SCHEMA_VERSION) {
    console.log('[迁移] 检测到 schema v' + fromVersion + '，目标 v' + schema.SCHEMA_VERSION);
    backupBeforeMigration(fromVersion);
    try {
      const res = schema.runMigrations(db);
      saveNow();
      (res.log || []).forEach((m) => console.log('[迁移] ' + m));
      console.log('[迁移] 完成：' + res.ran.join(' → '));
    } catch (e) {
      console.error('[迁移] 失败，已拒绝写盘（磁盘上的旧库与迁移前备份均未被改动）：' + e.message);
      throw e;
    }
  }

  /* 非版本化的防御性兜底：只保证"字段存在"，不改数据结构、不做迁移。
     结构变更一律走上面的迁移链，不要往这里加。 */
  if (!Array.isArray(db.projects)) db.projects = [];
  if (!Array.isArray(db.workspaces)) db.workspaces = [];
  if (!Array.isArray(db.storyboards)) db.storyboards = [];
  if (!Array.isArray(db.assets)) db.assets = [];
  if (!Array.isArray(db.records)) db.records = [];
  if (!Number.isFinite(db.recordSeq)) db.recordSeq = 0;
  if (!db.cliJobs || typeof db.cliJobs !== 'object') db.cliJobs = {};
  if (!db.logs || typeof db.logs !== 'object') db.logs = {};
  if (!db.settings || typeof db.settings !== 'object') db.settings = emptyDb().settings;
  return db;
}

/* 自动轮转备份：把**上一份已落盘的内容**另存为 db.json.bak-<时间>，只留最近 KEEP 份。
   事故背景（2026-09-18）：一次误写把空库覆盖到真实数据上，因为没有任何历史版本，无法回滚、只能靠记忆重建。
   代价可控：最多每 2 分钟复制一次，且内容未变则跳过；保留 12 份 ≈ 覆盖最近 24 分钟的高频改动。

   ⚠ 2026-09-21 修一个会**削弱恢复链**的次序问题（两处，都实测复现过）：
   原实现是"写盘**前**无条件备份磁盘上的当前内容"。首次启动时磁盘上只有空库，于是：
     rotateBackup() 把**空库**存成 .bak → 再写入真实数据。
   后果：主库损坏时恢复链找到的"最新备份"是空库 —— 恢复"成功"却什么都没救回来，
   比直接报错更糟（用户以为没事）。
   还有第二处：BACKUP_MIN_MS 节流原先在"跳过"分支里也刷新计时，
   于是 2 分钟内发生的第二次真实变更**没有任何备份**。

   正确的口径：**备份的是"上一次成功落盘的内容"，而不是"即将被覆盖的内容"**。
   实现上分两步（都在 saveNow 里）：
     ① 写盘前：若当前磁盘内容与最新备份不同 → 先把磁盘内容存成一份 .bak（这是上一版的真实内容）
     ② 写盘后：不额外动作
   第①步在"首次写入真实数据"这个场景下，备份到的仍是空库 —— 这没问题，
   因为**空库不是有效恢复目标**：tryLoadBackup 会拒掉它（projects 为空且无其它集合）。
   真正有效的备份由**下一次**内容变化产生：那时磁盘上已经是真实数据了。 */
const BACKUP_KEEP = 12;
const BACKUP_MIN_MS = 2 * 60 * 1000;
let lastBackupAt = 0;

function listBackups() {
  try {
    return fs.readdirSync(DATA_DIR())
      .filter((f) => f.startsWith('db.json.bak-') && !f.includes('.corrupt-'))
      .sort().reverse()
      .map((f) => path.join(DATA_DIR(), f));
  } catch (e) { return []; }
}

function rotateBackup() {
  try {
    if (!fs.existsSync(DB_FILE())) return;
    const st = fs.statSync(DB_FILE());
    if (!st.size) return;
    const prev = listBackups()[0];
    /* 内容没变就不重复备份（比的是**内容**，不是时间） */
    if (prev && fs.readFileSync(prev, 'utf8') === fs.readFileSync(DB_FILE(), 'utf8')) return;
    const now = Date.now();
    if (now - lastBackupAt < BACKUP_MIN_MS) return;      // 节流只在"要备份"时生效
    const bak = DB_FILE() + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE(), bak);
    lastBackupAt = now;
    listBackups().slice(BACKUP_KEEP).forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } });
  } catch (e) { console.error('[store] 自动备份失败：', e.message); }
}

/* 与 rotateBackup 相同的动作，但**无视 2 分钟节流**。
   用在"内容即将发生结构性变化"的场合：当前没有比这更值得备份的时刻了。
   典型触发：内存里的库有真实数据、而磁盘上还没有对应的备份。
   ⚠ 与 rotateBackup 的区别要记牢：轮转是"定期留痕"，这里是"关键节点强制留痕"。 */
function forceBackup(tag) {
  try {
    if (!fs.existsSync(DB_FILE())) return null;
    if (!fs.statSync(DB_FILE()).size) return null;
    const bak = DB_FILE() + '.bak-' + (tag ? tag + '-' : '')
      + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE(), bak);
    lastBackupAt = Date.now();
    listBackups().slice(BACKUP_KEEP).forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } });
    return bak;
  } catch (e) { console.error('[store] 强制备份失败：', e.message); return null; }
}

/* 磁盘上的主库是否**含真实数据**。用于"要不要给这份状态留个恢复点"的判断。 */
function diskHasData() {
  try { return !!tryLoadBackup(DB_FILE()); } catch (e) { return false; }
}

/* ⚠️ 必须在库已加载时才能写盘。
   事故记录（2026-09-18）：一个只 require 了 services 的独立脚本（没调 load()）触发了 store.save()，
   模块内 db 仍是 null → JSON.stringify(null) 写出 "null" → 真实 db.json 被覆盖，数据全失。
   这里硬拦：宁可写不进去，也不能把空库/坏值盖到磁盘上的真实数据上。 */
function saveNow() {
  if (!db) {
    console.error('[store] 拒绝写盘：库尚未加载（请先调用 store.load()）。已阻止用空值覆盖 db.json。');
    return;
  }
  /* ★ 关键恢复点（2026-09-21）：**磁盘上已经是真实数据、却一份有效备份都没有**时，
     强制先留一份。这是"首次写入真实数据之后的第一次改动"那个时间点 ——
     再不留，磁盘上就真的只有一个副本了。
     判据刻意用"磁盘内容"而不是"内存内容"：要备份的是即将被覆盖的那份落盘数据。 */
  if (diskHasData() && !hasUsableBackup()) {
    const bak = forceBackup('first');
    if (bak) console.log('[store] 已建立关键恢复点：' + path.basename(bak));
  }
  rotateBackup();
  const tmp = DB_FILE() + '.tmp';
  const text = JSON.stringify(db, null, 1);
  /* ★ fsync（2026-09-21 补）：`writeFileSync` 只保证"交给了操作系统"，不保证落盘。
     断电 / 强制关机时，tmp 可能是**空的或半截**的，而 rename 本身是原子的 ——
     于是磁盘上会出现一个"原子地换上去、但内容是半截"的 db.json。
     rename 后主库就坏了，只能靠备份恢复（见上面的恢复链）。
     做法：打开 fd → write → fsync → close，然后再 rename。
     ⚠ 顺序不能反：先 fsync 数据、再 rename 目录项，中间崩溃只会丢这次写入，
       不会产生半截主库。 */
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 关闭失败不阻塞 rename */ } }
  }
  fs.renameSync(tmp, DB_FILE());
  /* 目录项本身也 fsync 一下：Linux 上 rename 的持久化要目录 fsync 才算数。
     非 POSIX 平台（Windows）会抛 EPERM/EISDIR —— 那里本就没有这个语义，忽略即可。 */
  fsyncDir(path.dirname(DB_FILE()));
}

/* 尽力而为地 fsync 目录。失败一律忽略：这只是提高崩溃持久性的额外一步，
   不该让一次正常的保存变成失败。 */
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    /* Windows 不允许对目录 fsync（EPERM/EISDIR/EBADF）；某些文件系统也不支持。
       没有这一步的后果只是"rename 可能晚一点落盘"，rename 本身仍是原子的。 */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 忽略 */ } }
  }
}

/* 合并写：单用户本地场景下 200ms 防抖足够，进程退出前 flush */
function save() {
  if (!db) {
    console.error('[store] 拒绝保存：库尚未加载（请先调用 store.load()）。已阻止用空值覆盖 db.json。');
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { saveNow(); } catch (e) { console.error('[store] 写盘失败', e.message); } }, 200);
}

function flush() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); } }

/* 丢弃内存副本，从磁盘重新读一次。
   只给桌面版的「从旧版导入数据」用 —— 导入会把磁盘上的 db.json 换成旧库，
   而内存里还留着导入前的库，不重读的话界面看到的还是旧数据。
   ⚠ 调用前**绝对不能先 flush()**：那会把内存里的库盖回刚导入的库上，
   等于把用户的导入结果抹掉。 */
function reload() { db = null; return load(); }

function pushLog(storyboardId, level, msg) {
  const d = load();
  const arr = (d.logs[storyboardId] = d.logs[storyboardId] || []);
  arr.push({ level, msg, ts: nowIso() });
  if (arr.length > 50) arr.splice(0, arr.length - 50);
  save();
}

module.exports = {
  load, save, saveNow, flush, reload, pushLog,
  recoveryInfo, restoreCandidates, recoverFromBackup, listBackups,
  forceBackup, diskHasData, hasUsableBackup
};
