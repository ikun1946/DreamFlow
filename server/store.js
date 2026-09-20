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
  } catch (e) {
    console.error('[store] db.json 不可用（' + why + '），且备份失败：' + e.message);
  }
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

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  /* ⚠ 这里以前还会 mkdir data/output 与 data/assets。那两处是旧的扁平布局，
     现在已经没有代码往里面写东西了；再建出来只会让"彻底删除项目"之后
     看起来还剩两个空目录，误导人以为没删干净。需要时由 paths.ensureProjectDirs 建项目目录。 */
  if (fs.existsSync(DB_FILE())) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE(), 'utf8'));
      // JSON.parse('null') 不抛异常却返回 null：必须按「损坏」处理，否则会被当成空库静默重建
      if (parsed && typeof parsed === 'object') db = parsed;
      else { quarantine(DB_FILE(), '内容不是对象：' + String(parsed)); db = null; }
    } catch (e) { quarantine(DB_FILE(), '解析失败：' + e.message); db = null; }
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

/* 自动轮转备份：每次即将写盘前，把磁盘上的「上一版」另存为 db.json.bak-<时间>，只留最近 KEEP 份。
   事故背景（2026-09-18）：一次误写把空库覆盖到真实数据上，因为没有任何历史版本，无法回滚、只能靠记忆重建。
   代价可控：最多每 2 分钟复制一次，且内容未变则跳过；保留 12 份 ≈ 覆盖最近 24 分钟的高频改动。 */
const BACKUP_KEEP = 12;
const BACKUP_MIN_MS = 2 * 60 * 1000;
let lastBackupAt = 0;

function listBackups() {
  try {
    return fs.readdirSync(DATA_DIR())
      .filter((f) => f.startsWith('db.json.bak-'))
      .sort().reverse()
      .map((f) => path.join(DATA_DIR(), f));
  } catch (e) { return []; }
}

function rotateBackup() {
  try {
    if (!fs.existsSync(DB_FILE())) return;
    const now = Date.now();
    if (now - lastBackupAt < BACKUP_MIN_MS) return;
    const st = fs.statSync(DB_FILE());
    if (!st.size) return;
    const prev = listBackups()[0];
    if (prev && fs.readFileSync(prev, 'utf8') === fs.readFileSync(DB_FILE(), 'utf8')) { lastBackupAt = now; return; }
    const bak = DB_FILE() + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE(), bak);
    lastBackupAt = now;
    listBackups().slice(BACKUP_KEEP).forEach((f) => { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } });
  } catch (e) { console.error('[store] 自动备份失败：', e.message); }
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
  rotateBackup();
  const tmp = DB_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE());
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

module.exports = { load, save, saveNow, flush, reload, pushLog };
