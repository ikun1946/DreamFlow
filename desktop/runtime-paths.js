'use strict';
/* ============================================================
   runtime-paths.js —— 桌面版的目录布局（唯一事实来源）

   布局（2026-09-20 桌面化定稿）：

     %APPDATA%\<产品名>\             ← Electron userData：只放配置与日志
       ├── desktop-config.json         桌面端配置（数据目录 / 外部工具路径）
       ├── desktop-state.json          窗口尺寸位置、上次会话
       └── logs\main.log               运行日志

     %USERPROFILE%\Videos\JimengConsole\   ← 用户数据根（可改）
       ├── db.json                     数据库（原子写 + 自动轮转备份）
       ├── backup\                     迁移前备份
       └── projects\<projectId>\       素材与产物，按项目分区
           ├── assets\
           └── output\

   两个刻意的选择：
   1. 数据根**不放 userData**。Windows 的 userData 在 Roaming 下，
      而这里的产物视频动辄几个 GB —— 放进漫游目录会被同步策略拖着走，
      而且 Electron 明确不建议在 userData 里放大文件。Videos 目录不漫游。
   2. 数据根**不放安装目录**。装到 Program Files 后安装目录只读，
      旧版把 db.json 写在 server/data 下的做法在那里直接写不进去。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const DATA_FOLDER_NAME = 'JimengConsole';
const CONFIG_FILE = 'desktop-config.json';
const STATE_FILE = 'desktop-state.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[paths] 写配置失败：' + file + ' —— ' + e.message);
    return false;
  }
}

/* 目录真的可写吗 —— 只有写进去再删掉才算数。
   只看 existsSync 是不够的：Program Files 下的目录存在但拒绝写入。 */
function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) { return false; }
}

function resolvePaths(app) {
  const userData = app.getPath('userData');
  const configPath = path.join(userData, CONFIG_FILE);
  const statePath = path.join(userData, STATE_FILE);
  const logsDir = path.join(userData, 'logs');
  const cfg = readJson(configPath) || {};

  const fallback = path.join(app.getPath('videos'), DATA_FOLDER_NAME);
  /* JC_DATA_DIR 是**显式覆盖**，优先级高于配置文件。两个用途：
       · 自动化冒烟测试把数据写进临时目录，不去碰用户真实库；
       · 用户想把库放到别的盘（比如 C 盘紧张时指到 D 盘）。
     它排在配置前面，是因为"我这次就用这个目录"必须能压过"上次记住的目录"，
     否则测试想隔离都隔离不掉。 */
  const envDir = process.env.JC_DATA_DIR ? String(process.env.JC_DATA_DIR).trim() : '';
  let dataDir = envDir ? path.resolve(envDir)
    : (cfg.dataDir ? path.resolve(String(cfg.dataDir)) : fallback);
  let usedFallback = false;
  if (!isWritable(dataDir)) {
    /* 配置里指定的目录写不进去（外置盘拔了 / 权限变了）：
       退回 userData 下的 data 目录，宁可占 C 盘也不能让应用起不来。
       ⚠ 这时**不能**悄悄用空库启动 —— 见 main.js 里的提示。 */
    const alt = path.join(userData, 'data');
    if (isWritable(alt)) { dataDir = alt; usedFallback = true; }
  }

  return {
    userData,
    configPath,
    statePath,
    logsDir,
    dataDir,
    defaultDataDir: fallback,
    usedFallback,
    config: cfg
  };
}

function saveConfig(p, patch) {
  const next = Object.assign({}, readJson(p.configPath) || {}, patch || {});
  return writeJson(p.configPath, next);
}

function readState(p) { return readJson(p.statePath) || {}; }
function saveState(p, patch) {
  const next = Object.assign({}, readState(p), patch || {});
  return writeJson(p.statePath, next);
}

module.exports = {
  DATA_FOLDER_NAME, CONFIG_FILE, STATE_FILE,
  resolvePaths, saveConfig, readState, saveState, isWritable, readJson, writeJson
};
