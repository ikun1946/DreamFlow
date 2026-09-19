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
const { DATA_DIR, OUTPUT_DIR, ASSET_DIR, DB_FILE } = require('./config');
const { nowIso } = require('./util');

let db = null;
let saveTimer = null;

function emptyDb() {
  return {
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
    cliJobs: {},         // storyboardId -> { submitId, state, command, argv, mode, cliModel, engine, ... }
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

function load() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // JSON.parse('null') 不抛异常却返回 null：必须按「损坏」处理，否则会被当成空库静默重建
      if (parsed && typeof parsed === 'object') db = parsed;
      else { quarantine(DB_FILE, '内容不是对象：' + String(parsed)); db = null; }
    } catch (e) { quarantine(DB_FILE, '解析失败：' + e.message); db = null; }
  }
  if (!db) { db = emptyDb(); saveNow(); console.log('[store] 空库初始化完成'); }
  // 兼容旧库：补齐缺失字段；丢弃历史演示数据
  if (!db.settings) db.settings = emptyDb().settings;
  if (!db.settings.adapter) db.settings.adapter = { dreaminaAvailable: false, dreaminaVersion: null };
  /* 清理画布 CLI 时代的字段（2026-09-18 画布 CLI 已移除）。
     不清掉的话，前端会读到 engine / cliAvailable / canvasAccount 这些已经没有任何含义的字段，
     界面上就会出现"画布 CLI 已就绪"之类的幽灵状态。 */
  ['engine', 'cliAvailable', 'cliVersion', 'canvasAccount', 'authUrl'].forEach((k) => { delete db.settings.adapter[k]; });
  delete db.settings.adapter.mode;
  /* 素材上的画布节点引用（cliNodeId / cliResourceId）：原本用于 `--ref node:<id>`，
     画布 CLI 移除后这些引用既不能提交也无处展示，一并清掉，避免留下"看起来还有用"的死字段。 */
  (db.assets || []).forEach((a) => { delete a.cliNodeId; delete a.cliResourceId; });
  // 兼容旧库：生成记录是后加的字段，老库没有 → 补空数组（不是"损坏"，不隔离）
  if (!Array.isArray(db.records)) db.records = [];
  if (!Number.isFinite(db.recordSeq)) db.recordSeq = 0;
  if (db.seededAt !== undefined) {
    // 旧版演示库（带种子标记）：清空重置，避免假数据流入真实链路
    const fresh = emptyDb();
    fresh.idempotency = db.idempotency || {};
    db = fresh;
    saveNow();
    console.log('[store] 检测到旧演示数据，已清空重置');
  }
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
    return fs.readdirSync(DATA_DIR)
      .filter((f) => f.startsWith('db.json.bak-'))
      .sort().reverse()
      .map((f) => path.join(DATA_DIR, f));
  } catch (e) { return []; }
}

function rotateBackup() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const now = Date.now();
    if (now - lastBackupAt < BACKUP_MIN_MS) return;
    const st = fs.statSync(DB_FILE);
    if (!st.size) return;
    const prev = listBackups()[0];
    if (prev && fs.readFileSync(prev, 'utf8') === fs.readFileSync(DB_FILE, 'utf8')) { lastBackupAt = now; return; }
    const bak = DB_FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE, bak);
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
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
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

function pushLog(storyboardId, level, msg) {
  const d = load();
  const arr = (d.logs[storyboardId] = d.logs[storyboardId] || []);
  arr.push({ level, msg, ts: nowIso() });
  if (arr.length > 50) arr.splice(0, arr.length - 50);
  save();
}

module.exports = { load, save, saveNow, flush, pushLog };
