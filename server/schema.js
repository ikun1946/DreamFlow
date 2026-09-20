'use strict';
/* ============================================================
   schema.js —— 数据库 schema 版本与迁移框架

   为什么要有这个文件（2026-09-19 多项目架构升级）：
   升级前项目没有版本概念，兼容旧库靠的是**散落的临时判断** ——
     · store.load() 里 9 处 `if (!db.X) …` 垫片（含两处字段删除）；
     · services.getOptions() 里更危险的一处：**借 GET /meta/options 请求**
       改写 settings.defaults、**所有分镜的 model**、**所有 cliJobs 的 cliModel**，
       然后 store.save()。也就是说"迁移"藏在一个只读接口里，靠用户打开页面才触发，
       而且每次刷新都可能重跑。
   这两套都无法回答"这个库现在是第几版、还需要跑哪些迁移"，也无法保证幂等。
   本模块把它们收敛成正式机制：**读版本 → 按序迁移 → 校验 → 写版本**。

   两条纪律：
   1. **迁移只在克隆体上跑，全部成功才写回原对象。** 任一步抛错，原库一个字节都不动
      （写回用"清键 + 赋值"而不是换对象，因为 store.js 的模块级 db 引用被
       services / worker 广泛持有，换对象会让它们全部指向旧值）。
   2. **迁移必须幂等**：连跑两次不得重复建项目/工作区、不得重复迁移。
      每个 migrate* 函数自己负责判断"是否已经迁过"。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const models = require('./models');
const PATHS = require('./paths');   // 磁盘布局与资源 URL 形状的唯一事实来源

/* 当前 schema 版本。每次改数据结构就 +1，并在 MIGRATIONS 里挂上对应的迁移函数。 */
const SCHEMA_VERSION = 3;

/* 旧数据迁移后的归属。
   ⚠ 项目 id 刻意沿用现有数据里已经在用的 `pj_1`（storyboards/assets/records 三处的
   projectId 实测全是它）。这样迁移**只需要给分镜补 workspaceId，一个 projectId 都不用改写**，
   侵入面最小；顺带还让现有前端（CFG.projectId 默认 pj_1）一行不改就能继续工作 ——
   这本身就是"向后兼容"最硬的证据。
   工作区用 ws_1，与项目一一对应。 */
const LEGACY_PROJECT_ID = 'pj_1';
const LEGACY_WORKSPACE_ID = 'ws_1';
const LEGACY_PROJECT_NAME = '原有项目';    // 指令 §19：UI 名称不要用会让用户困惑的技术名
const LEGACY_WORKSPACE_NAME = '原有分镜';

/* 读取库版本。没有这个字段 = 升级前的旧库 = 第 1 版。
   非数字 / 小于 1 一律按 1 处理，避免坏值把迁移链算乱。 */
function readVersion(db) {
  const v = Number(db && db.schemaVersion);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/* ---------------- 模型名归一（原 getOptions 的副作用，搬到这里） ----------------
   两步，顺序不能反（与 services.getOptions 里原有的注释一致）：
     ① 无损改名：历史画布域名 → 创作域名。纯映射，不依赖任何探测。
     ② 替代迁移：改完仍跑不了的名字 → 换一个能跑的。
   ⚠ 第②步原来依赖 CLI 探测结果（"当前可用的模型"）。迁移里**不能**依赖探测 ——
   迁移必须确定、可重复，而探测结果随时会变。这里改用静态注册表的第一项作为落点，
   结果是确定的。 */
function normalizeModelName(name, log) {
  if (!name) return name;
  const renamed = models.dreaminaModelOf(name);
  if (renamed) {
    if (renamed !== name && log) log('模型名「' + name + '」是画布时代的旧名字，已无损改名为「' + renamed + '」');
    return renamed;
  }
  const fallback = models.DREAMINA_VIDEO_MODELS[0];
  if (log) log('模型名「' + name + '」已下线（创作 CLI 无对应型号），已迁移为「' + fallback + '」');
  return fallback;
}

/* ---------------- v1 → v2：单项目 → 多项目 ----------------
   只做增量，不删不改旧字段：
     · 建「原有项目」+「原有分镜」；
     · 给每个分镜补 workspaceId（projectId 原样保留）；
     · 素材不动（仍只有 projectId，指令 §11 明确不加 workspaceId）；
     · 记录/cliJobs 补上下文与名称快照；
     · 生成参数复制一份到 project.settings 作为项目覆盖，**全局那份保留**（§15.3 兼容策略，
       不一次大拆，读不到项目覆盖时回落到全局默认）；
     · 模型名归一（原 getOptions 的副作用）。 */
function migrateV1ToV2(db, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const now = (ctx && ctx.now) || (() => new Date().toISOString());
  const stamp = now();

  db.projects = Array.isArray(db.projects) ? db.projects : [];
  db.workspaces = Array.isArray(db.workspaces) ? db.workspaces : [];
  db.storyboards = Array.isArray(db.storyboards) ? db.storyboards : [];
  db.assets = Array.isArray(db.assets) ? db.assets : [];
  db.records = Array.isArray(db.records) ? db.records : [];
  db.cliJobs = db.cliJobs && typeof db.cliJobs === 'object' ? db.cliJobs : {};
  db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {};

  /* ① 旧项目。已存在就复用（幂等：连跑两次不会建出两个） */
  let proj = db.projects.find((p) => p.id === LEGACY_PROJECT_ID);
  if (!proj) {
    proj = {
      id: LEGACY_PROJECT_ID,
      name: LEGACY_PROJECT_NAME,
      description: '多项目架构升级时，由升级前的全部数据自动归入',
      settings: {},
      defaultWorkspaceId: LEGACY_WORKSPACE_ID,
      createdAt: stamp, updatedAt: stamp, lastOpenedAt: stamp,
      deletedAt: null
    };
    db.projects.push(proj);
    log('已创建「' + LEGACY_PROJECT_NAME + '」（' + LEGACY_PROJECT_ID + '）承接升级前的数据');
  }
  if (!proj.defaultWorkspaceId) proj.defaultWorkspaceId = LEGACY_WORKSPACE_ID;

  /* ② 旧工作区 */
  let ws = db.workspaces.find((w) => w.id === LEGACY_WORKSPACE_ID);
  if (!ws) {
    ws = {
      id: LEGACY_WORKSPACE_ID,
      projectId: LEGACY_PROJECT_ID,
      name: LEGACY_WORKSPACE_NAME,
      description: '升级前的全部分镜',
      createdAt: stamp, updatedAt: stamp, lastOpenedAt: stamp,
      deletedAt: null
    };
    db.workspaces.push(ws);
    log('已创建「' + LEGACY_WORKSPACE_NAME + '」（' + LEGACY_WORKSPACE_ID + '）承接升级前的分镜');
  }

  /* ③ 分镜补 workspaceId。**只补空的**，已有归属的分镜不动（幂等的关键）。 */
  let sbFixed = 0;
  db.storyboards.forEach((s) => {
    if (!s) return;
    if (!s.workspaceId) { s.workspaceId = LEGACY_WORKSPACE_ID; sbFixed++; }
    /* 权威归属是 workspace.projectId。冗余的 storyboard.projectId 保留（指令 §10.1 允许），
       但必须与权威一致 —— 冲突时以工作区为准，避免双事实来源打架。 */
    if (s.projectId !== LEGACY_PROJECT_ID) s.projectId = LEGACY_PROJECT_ID;
  });
  if (sbFixed) log('已为 ' + sbFixed + ' 条分镜补上 workspaceId');

  /* ④ 素材补 projectId（缺失或空才补）。素材**不加** workspaceId（指令 §11）。 */
  let asFixed = 0;
  db.assets.forEach((a) => { if (a && a.projectId !== LEGACY_PROJECT_ID) { a.projectId = LEGACY_PROJECT_ID; asFixed++; } });
  if (asFixed) log('已为 ' + asFixed + ' 个素材补上 projectId');

  /* ⑤ 记录补上下文与名称快照。
     ⚠ 名称必须是**生成时刻的快照**，不能用当前的 —— 项目/工作区改名后，
     旧记录要能显示"当时叫什么"（指令 §13/§47）。旧记录没有这些字段，
     只能按"它们确实属于升级前那个项目/工作区"来补，这与事实相符。 */
  let recFixed = 0;
  db.records.forEach((r) => {
    if (!r) return;
    if (!r.projectId) r.projectId = LEGACY_PROJECT_ID;
    if (!r.workspaceId) { r.workspaceId = LEGACY_WORKSPACE_ID; recFixed++; }
    if (!r.projectName) r.projectName = proj.name;
    if (!r.workspaceName) r.workspaceName = ws.name;
    /* 分镜标题快照：分镜本身没有 title 字段，沿用记录里已有的「镜头 N」形态 */
    if (!r.storyboardTitle) r.storyboardTitle = '镜头 ' + (r.seq != null ? r.seq : '?');
  });
  if (recFixed) log('已为 ' + recFixed + ' 条生成记录补上工作区上下文与名称快照');

  /* ⑥ cliJobs 补上下文（键仍是 storyboardId，指令 §14 允许另存 projectId 供审计） */
  let jobFixed = 0;
  Object.keys(db.cliJobs).forEach((sbId) => {
    const job = db.cliJobs[sbId];
    if (!job || typeof job !== 'object') return;
    const sb = db.storyboards.find((s) => s.id === sbId);
    const wsId = (sb && sb.workspaceId) || LEGACY_WORKSPACE_ID;
    if (job.workspaceId !== wsId || job.projectId !== LEGACY_PROJECT_ID) {
      job.workspaceId = wsId;
      job.projectId = LEGACY_PROJECT_ID;
      jobFixed++;
    }
  });
  if (jobFixed) log('已为 ' + jobFixed + ' 条 CLI 任务补上项目/工作区上下文');

  /* ⑦ 生成参数：复制一份进项目作为「项目覆盖」，全局那份**保留**做回落。
     delimiter 一并归入项目（服务端逻辑从不读它，只下发给前端，属纯前端偏好）。 */
  const gdef = db.settings.defaults || {};
  if (!proj.settings || typeof proj.settings !== 'object') proj.settings = {};
  if (!proj.settings.defaults) proj.settings.defaults = JSON.parse(JSON.stringify(gdef));
  if (!proj.settings.delimiter && db.settings.delimiter) {
    proj.settings.delimiter = JSON.parse(JSON.stringify(db.settings.delimiter));
  }
  /* 兜底补全全局 defaults 的缺失字段 —— 原来 store.load() **没有**这一步，
     而 getOptions 会直接读 `db.settings.defaults.model`，老库缺这个子树时会
     抛 TypeError 变成 50000。迁移顺手把这个隐患堵掉。 */
  if (!db.settings.defaults) db.settings.defaults = {};
  const D = db.settings.defaults;
  if (D.model == null) D.model = proj.settings.defaults.model || models.DREAMINA_VIDEO_MODELS[0];
  if (D.ratio == null) D.ratio = '16:9';
  if (D.resolution == null) D.resolution = '720p';
  if (D.durationSec == null) D.durationSec = 5;
  if (D.motion == null) D.motion = 0.55;
  if (D.negativePrompt == null) D.negativePrompt = '';
  if (!db.settings.queue) db.settings.queue = { concurrency: 2, autoRetry: true, maxRetry: 2 };
  if (!db.settings.adapter) db.settings.adapter = { dreaminaAvailable: false, dreaminaVersion: null };
  if (!db.settings.delimiter) db.settings.delimiter = { type: 'custom', value: ';;' };

  /* ⑧ 模型名归一（原 getOptions 的副作用搬到这里，只跑一次而不是每次刷新） */
  let renamed = 0;
  const before = D.model;
  D.model = normalizeModelName(D.model, log);
  if (D.model !== before) renamed++;
  db.storyboards.forEach((s) => {
    if (!s || !s.model) return;
    const nv = normalizeModelName(s.model);
    if (nv !== s.model) { s.model = nv; renamed++; }
  });
  Object.keys(db.cliJobs).forEach((id) => {
    const job = db.cliJobs[id];
    if (job && job.cliModel) {
      const nv = normalizeModelName(job.cliModel);
      if (nv !== job.cliModel) { job.cliModel = nv; renamed++; }
    }
  });
  if (renamed) log('已归一 ' + renamed + ' 处模型名（画布时代旧名 → 创作 CLI 等价名）');

  /* ⑨ 画布 CLI 时代的死字段：原来在 store.load() 里每次启动都删一遍，
     现在归入版本化迁移，只删一次。 */
  const deadAdapterKeys = ['engine', 'cliAvailable', 'cliVersion', 'canvasAccount', 'authUrl', 'mode'];
  deadAdapterKeys.forEach((k) => { delete db.settings.adapter[k]; });
  db.assets.forEach((a) => { if (a) { delete a.cliNodeId; delete a.cliResourceId; } });

  return { projectId: LEGACY_PROJECT_ID, workspaceId: LEGACY_WORKSPACE_ID, storyboardsFixed: sbFixed, assetsFixed: asFixed, recordsFixed: recFixed, jobsFixed: jobFixed };
}

/* ---------------- v2 → v3：资源文件按项目分区 ----------------
   把全项目平铺的 `data/assets/<file>` 与 `data/output/<分镜>/<file>`
   搬到 `data/projects/<项目>/assets|output/...`，并改写库里所有相关地址。

   为什么要做：素材原先混在同一个目录里，"彻底删除一个项目"根本删不干净。
   搬完之后"删项目 = 删一个文件夹"，物理隔离与逻辑隔离对齐。

   ⚠ 文件搬迁是**不可回滚的副作用**，所以不在这里直接做 —— 只把操作收进
   `ctx.fileOps`，由 runMigrations 在**校验通过之后**统一执行。否则校验失败时
   会出现"数据库还指着旧地址、文件却已经搬走"的半死状态。
   ⚠ 每个文件都是"复制 → 校验大小 → 删源"，且只在全部复制成功后进入删源阶段；
   任一步失败就删掉本次新建的副本并抛错，磁盘回到原样。 */
/* 分镜 → 项目。权威来源是所属工作区的 projectId；工作区缺失时退回分镜自己的字段。
   两个调用方（地址改写、残留扫尾）都要用，抽出来避免两套判定标准。 */
function projectIdOfStoryboard(db, sb) {
  if (!sb) return null;
  const ws = (db.workspaces || []).find((w) => w && w.id === sb.workspaceId);
  return PATHS.safeId((ws && ws.projectId) || sb.projectId);
}

/* 搬一个文件：复制 → 校验大小 → 删源。目标已存在且大小一致视为"上次搬过了"（幂等）。
   扫尾是"尽力而为"的活，单个文件失败不该让整个迁移挂掉，所以只返回 false 不抛错。 */
function moveFileIfNeeded(from, to, log) {
  try {
    const size = fs.statSync(from).size;
    if (fs.existsSync(to)) {
      if (fs.statSync(to).size === size) { fs.unlinkSync(from); return true; }
      log('⚠ 目标已存在且大小不同，保留两边：' + to);
      return false;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (fs.statSync(to).size !== size) {
      try { fs.unlinkSync(to); } catch (e2) { /* 尽力而为 */ }
      log('⚠ 复制后大小不一致，已放弃该文件：' + from);
      return false;
    }
    fs.unlinkSync(from);
    return true;
  } catch (e) {
    log('⚠ 搬迁失败（跳过，不影响其余文件）：' + from + ' —— ' + e.message);
    return false;
  }
}

/* 扫尾：把旧目录里"没有任何地址引用"的残留文件也认领到项目目录下。
   为什么必须做：按地址搬只能搬"有引用"的文件。老版本没把封面写进记录的产物，
   它的封面就成了没人引用的孤儿 —— 留在 data/output/ 里不属于任何项目，
   于是**彻底删除项目时删不掉它**，等于永久漏在硬盘上（用户要求的正是"删干净"）。
   认领规则（不猜）：
     · 旧产物目录的**目录名就是分镜 id** → 归属到该分镜的项目
     · 旧素材目录的文件名以**素材 id** 开头（as_xxx-<时间戳>.png）→ 按前缀认领
   认不出归属的一律原地不动并报告 —— 宁可留着，也不把别人的文件塞进某个项目。 */
function sweepLegacyFiles(db, log) {
  const say = log || (() => {});
  let moved = 0;
  const left = [];

  const sbRoot = PATHS.LEGACY_OUTPUT_DIR;
  if (fs.existsSync(sbRoot)) {
    fs.readdirSync(sbRoot).forEach((name) => {
      const src = path.join(sbRoot, name);
      let st;
      try { st = fs.statSync(src); } catch (e) { return; }
      if (!st.isDirectory()) { left.push(src); return; }
      const sb = (db.storyboards || []).find((s) => s && s.id === name);
      const pj = projectIdOfStoryboard(db, sb);
      if (!pj) { left.push(src); return; }               // 分镜已不存在：不知道归谁，留着
      fs.readdirSync(src).forEach((f) => {
        const from = path.join(src, f);
        try { if (fs.statSync(from).isDirectory()) { left.push(from); return; } } catch (e) { return; }
        if (moveFileIfNeeded(from, path.join(PATHS.sbOutputDir(pj, name), f), say)) moved++;
        else left.push(from);
      });
    });
  }

  const asRoot = PATHS.LEGACY_ASSET_DIR;
  if (fs.existsSync(asRoot)) {
    fs.readdirSync(asRoot).forEach((f) => {
      const from = path.join(asRoot, f);
      try { if (fs.statSync(from).isDirectory()) { left.push(from); return; } } catch (e) { return; }
      /* 素材文件名 = 素材 id + '-' + 替换时刻 + 扩展名，所以按 id 前缀认领 */
      const owner = (db.assets || []).find((a) => a && a.id && f.startsWith(a.id + '-'));
      const pj = owner ? PATHS.safeId(owner.projectId) : null;
      if (!pj) { left.push(from); return; }
      if (moveFileIfNeeded(from, path.join(PATHS.assetDir(pj), f), say)) moved++;
      else left.push(from);
    });
  }

  /* 顺带把"文件在、却没写封面地址"的老数据补上 —— 否则刚认领过来的封面
     在新位置同样没人引用，等于白搬。地址由它自己的 videoUrl 推出（同名 + _cover），
     不按 submitId 猜，避免同一次提交出多个视频时张冠李戴。 */
  const linkCover = (holder) => {
    if (!holder || holder.coverUrl || !holder.videoUrl) return false;
    const parsed = PATHS.parseOutputUrl(holder.videoUrl);
    if (!parsed) return false;
    const cover = path.basename(parsed.filename).replace(/\.[^.]+$/, '') + '_cover.jpg';
    if (!fs.existsSync(path.join(PATHS.sbOutputDir(parsed.projectId, parsed.storyboardId), cover))) return false;
    holder.coverUrl = PATHS.outputUrl(parsed.projectId, parsed.storyboardId, cover);
    return true;
  };
  let linked = 0;
  (db.storyboards || []).forEach((sb) => { if (linkCover(sb)) linked++; });
  (db.records || []).forEach((r) => { if (linkCover(r)) linked++; });
  if (linked) say('已为 ' + linked + ' 处产物补回封面地址（老版本没记录，文件其实一直都在）');

  if (moved) say('已认领 ' + moved + ' 个未被引用的残留文件到项目目录');
  if (left.length) {
    say('⚠ 有 ' + left.length + ' 个残留文件认不出归属，原地未动（确认无用后可手工清理）：' +
      left.slice(0, 5).join('、') + (left.length > 5 ? ' …' : ''));
  }
  return { moved, linked, left: left.length };
}

function migrateV2ToV3(db, ctx) {
  const log = (ctx && ctx.log) || (() => {});
  const fileOps = (ctx && ctx.fileOps) || [];

  db.assets = Array.isArray(db.assets) ? db.assets : [];
  db.storyboards = Array.isArray(db.storyboards) ? db.storyboards : [];
  db.records = Array.isArray(db.records) ? db.records : [];

  /* 目标路径 → { from, applies[] }。同一个文件可能被多处引用（分镜的当前产物 + 该次的记录），
     按目标去重，避免重复复制；地址改写回调全部收集起来，复制成功后再统一执行。 */
  const byTo = new Map();
  const add = (from, to, apply) => {
    if (!from || !to) return;
    if (!byTo.has(to)) byTo.set(to, { from, applies: [] });
    byTo.get(to).applies.push(apply);
  };

  /* ① 素材：/media/assets/<file> → /media/assets/<项目>/<file> */
  let asN = 0;
  db.assets.forEach((a) => {
    if (!a || !a.url) return;
    const m = /^\/media\/assets\/([^/]+)$/.exec(String(a.url));
    if (!m) return;                                  // 已是新形状（或空）
    const pj = PATHS.safeId(a.projectId);
    if (!pj) return;                                 // 无项目归属：留原地，不动
    const file = PATHS.safeFile(decodeURIComponent(m[1]));
    if (!file) return;
    const to = path.join(PATHS.assetDir(pj), file);
    add(path.join(PATHS.LEGACY_ASSET_DIR, file), to, () => {
      a.url = PATHS.assetUrl(pj, file);
      if (a.thumbUrl) a.thumbUrl = PATHS.assetUrl(pj, file);
    });
    asN++;
  });

  /* ② 产物：/files/<分镜>/<file> → /files/<项目>/<分镜>/<file>
     引用者有两类：分镜自己的 videoUrl/coverUrl/currentFrameUrl，以及**历史记录**的快照。
     记录必须一起改 —— 否则"历史产物"的链接会全部失效。 */
  let outN = 0;
  const fixHolder = (holder, key, sbId, pj) => {
    const m = /^\/files\/([^/]+)\/([^/]+)$/.exec(String(holder[key] || ''));
    if (!m) return;
    if (m[1] !== sbId) return;                       // 形状对但分镜对不上：不动
    const file = PATHS.safeFile(decodeURIComponent(m[2]));
    if (!file) return;
    const to = path.join(PATHS.sbOutputDir(pj, sbId), file);
    add(path.join(PATHS.LEGACY_OUTPUT_DIR, sbId, file), to, () => { holder[key] = PATHS.outputUrl(pj, sbId, file); });
    outN++;
  };
  const pjOfSb = (sbId) => {
    const sb = db.storyboards.find((s) => s && s.id === sbId);
    return sb ? projectIdOfStoryboard(db, sb) : null;
  };
  db.storyboards.forEach((sb) => {
    if (!sb) return;
    const pj = pjOfSb(sb.id);
    if (!pj) return;
    ['videoUrl', 'coverUrl', 'currentFrameUrl'].forEach((k) => fixHolder(sb, k, sb.id, pj));
  });
  db.records.forEach((r) => {
    if (!r || !r.storyboardId) return;
    const pj = pjOfSb(r.storyboardId) || PATHS.safeId(r.projectId);
    if (!pj) return;
    ['videoUrl', 'coverUrl'].forEach((k) => fixHolder(r, k, r.storyboardId, pj));
  });

  /* ⚠ 即使 byTo 为空（地址已是新形状）也必须往下走：旧目录里可能还留着
     "没有任何地址引用"的残留文件，扫尾要认领它们。早先这里直接 return，
     结果是已经迁过地址的库永远扫不到那些文件。 */
  if (byTo.size) log('将把 ' + byTo.size + ' 个资源文件搬到按项目分区的目录（素材引用 ' + asN + ' 处、产物引用 ' + outN + ' 处）');

  /* ③ 收进 fileOps：复制 → 校验 → （全部成功后）删源 + 改写地址 */
  fileOps.push(() => {
    const created = [];
    const sources = [];
    try {
      byTo.forEach((v, to) => {
        if (!fs.existsSync(v.from)) { log('⚠ 源文件不存在，跳过（该地址本来就是死链）：' + v.from); return; }
        const size = fs.statSync(v.from).size;
        if (fs.existsSync(to) && fs.statSync(to).size === size) { sources.push(v.from); return; }   // 已搬过（幂等）
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(v.from, to);
        if (fs.statSync(to).size !== size) throw new Error('复制后大小不一致：' + to);
        created.push(to);
        sources.push(v.from);
      });
    } catch (e) {
      /* 回滚：只删本次新建的副本，磁盘回到原样 */
      created.forEach((t) => { try { fs.unlinkSync(t); } catch (e2) { /* 尽力而为 */ } });
      throw new Error('资源文件搬迁失败（已回滚新建的副本，磁盘与数据库均未改动）：' + e.message);
    }
    /* 复制全部成功 —— 这时才改写地址并删源。
       ⚠ 删源只删"确实已搬到新位置"的那些。 */
    byTo.forEach((v) => v.applies.forEach((fn) => fn()));
    let removed = 0;
    sources.forEach((f) => { try { fs.unlinkSync(f); removed++; } catch (e) { /* 忽略 */ } });
    if (byTo.size) log('已搬迁 ' + byTo.size + ' 个资源文件到 data/projects/（删除旧位置 ' + removed + ' 个）');

    /* ④ 扫尾：认领没人引用的残留文件（必须在删旧目录之前） */
    sweepLegacyFiles(db, log);

    /* 旧目录若已空就删掉；还有残留就保留并提示 */
    [PATHS.LEGACY_ASSET_DIR, PATHS.LEGACY_OUTPUT_DIR].forEach((d) => {
      try {
        if (!fs.existsSync(d)) return;
        const rest = [];
        const walk = (cur) => fs.readdirSync(cur).forEach((f) => {
          const p = path.join(cur, f);
          if (fs.statSync(p).isDirectory()) walk(p); else rest.push(p);
        });
        walk(d);
        if (!rest.length) { fs.rmSync(d, { recursive: true, force: true }); return; }
        log('⚠ 旧目录 ' + path.basename(d) + ' 还剩 ' + rest.length + ' 个认不出归属的文件（未删除，确认无用后可手工清理）：' +
          rest.slice(0, 5).map((p) => path.basename(p)).join('、') + (rest.length > 5 ? ' …' : ''));
      } catch (e) { /* 清理失败不影响迁移结果 */ }
    });
  });

  return { moved: byTo.size };
}

/* 版本 → 迁移函数。键是**迁移前**的版本号。 */
const MIGRATIONS = {
  1: migrateV1ToV2,
  2: migrateV2ToV3
};

/* 迁移结果校验：宁可在这里失败，也不要写出一份静默损坏的库。
   只校验"不可能合法地变小"的量和归属完整性。 */
function validate(db, before) {
  const problems = [];
  const cnt = (x) => (Array.isArray(x) ? x.length : 0);
  if (cnt(db.storyboards) !== cnt(before.storyboards)) problems.push('分镜数量变化：' + cnt(before.storyboards) + ' → ' + cnt(db.storyboards));
  if (cnt(db.assets) !== cnt(before.assets)) problems.push('素材数量变化：' + cnt(before.assets) + ' → ' + cnt(db.assets));
  if (cnt(db.records) !== cnt(before.records)) problems.push('生成记录数量变化：' + cnt(before.records) + ' → ' + cnt(db.records));
  if (cnt(db.projects) < 1) problems.push('迁移后没有任何项目');
  if (cnt(db.workspaces) < 1) problems.push('迁移后没有任何工作区');

  const wsIds = new Set(db.workspaces.map((w) => w && w.id));
  const pjIds = new Set(db.projects.map((p) => p && p.id));
  db.storyboards.forEach((s) => {
    if (!s) return;
    if (!s.workspaceId) problems.push('分镜 ' + s.id + ' 没有 workspaceId');
    else if (!wsIds.has(s.workspaceId)) problems.push('分镜 ' + s.id + ' 指向不存在的工作区 ' + s.workspaceId);
    if (s.projectId && !pjIds.has(s.projectId)) problems.push('分镜 ' + s.id + ' 指向不存在的项目 ' + s.projectId);
  });
  db.workspaces.forEach((w) => {
    if (w && !pjIds.has(w.projectId)) problems.push('工作区 ' + w.id + ' 指向不存在的项目 ' + w.projectId);
  });
  return problems;
}

/**
 * 按序跑完所有待执行的迁移。
 *
 * ⚠ 在**克隆体**上跑：任一步抛错或校验不过，原对象一个字节都不动，
 *   调用方（store.load）据此拒绝写盘，磁盘上的旧库保持完好。
 * ⚠ 写回用"清键 + 赋值"而非替换对象：store.js 的模块级 db 引用被 services / worker
 *   广泛持有，换成新对象会让它们全部指向旧值。
 *
 * @returns {{from:number,to:number,ran:string[],log:string[],skipped:boolean}}
 */
function runMigrations(db, opts) {
  const o = opts || {};
  const from = readVersion(db);
  if (from >= SCHEMA_VERSION) return { from, to: from, ran: [], log: [], skipped: true };

  const draft = JSON.parse(JSON.stringify(db));
  const before = { storyboards: draft.storyboards, assets: draft.assets, records: draft.records };
  const ran = [], logs = [];
  const log = (m) => logs.push(m);
  /* 迁移函数**不能**自己动磁盘：文件搬迁不可回滚，必须等校验通过。
     它们把操作 push 进这里，由下面在校验之后统一执行。 */
  const fileOps = [];

  for (let v = from; v < SCHEMA_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (typeof fn !== 'function') throw new Error('缺少 v' + v + ' → v' + (v + 1) + ' 的迁移函数（schema.js 的 MIGRATIONS 表不完整）');
    fn(draft, { log, now: o.now, fileOps });
    draft.schemaVersion = v + 1;
    ran.push('v' + v + '→v' + (v + 1));
  }

  const problems = validate(draft, before);
  if (problems.length) {
    const e = new Error('迁移结果校验未通过：' + problems.join('；'));
    e.migrationProblems = problems;
    throw e;
  }

  /* 校验通过 → 先落磁盘副作用（搬文件），再写回内存对象。
     顺序不能反：文件搬完但内存没换，等于数据库还在旧地址，下次启动会重跑迁移（幂等，无害）；
     反过来（内存换了文件没搬）则是数据库指着不存在的文件，那才是坏的。 */
  fileOps.forEach((op) => op());
  Object.keys(db).forEach((k) => { delete db[k]; });
  Object.assign(db, draft);
  return { from, to: SCHEMA_VERSION, ran, log: logs, skipped: false };
}

module.exports = {
  SCHEMA_VERSION, MIGRATIONS,
  LEGACY_PROJECT_ID, LEGACY_WORKSPACE_ID, LEGACY_PROJECT_NAME, LEGACY_WORKSPACE_NAME,
  readVersion, runMigrations, migrateV1ToV2, migrateV2ToV3, normalizeModelName, validate,
  /* 扫尾单独导出：给"已经迁过地址、但旧目录里还留着孤儿文件"的库补跑一次 */
  sweepLegacyFiles
};
