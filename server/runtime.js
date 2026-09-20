'use strict';
/* ============================================================
   runtime.js —— 运行时环境（数据目录 / 运行模式 / 当前生效配置）

   为什么要有这个文件（2026-09-20 桌面化）：
   在此之前数据根是 config.js 里的**模块级常量** DATA_DIR = server/data，
   由 store.js / paths.js 在 require 时快照。桌面版必须把数据放到用户可写目录
   （安装到 Program Files 后安装目录不可写），而"改根目录"如果还靠改常量，
   就会重演 paths.js 注释里记过的那次事故 —— 以为重定向了根，其实一路写进真实目录。

   所以这里把三件事收成一处，且全部是**调用时读取**：
     · mode           'cli'（node server/index.js）或 'desktop'（Electron）
     · dataDir        数据库与项目资源的根
     · currentConfig  本进程生效的完整配置（loadConfig 的产物）

   ⚠ 本文件不 require './config' / './paths'（避免循环依赖）。数据根变化后
   需要重新推导派生目录的模块，用 onChange 注册回调。
   ============================================================ */
const path = require('path');

const CLI_DEFAULT_DATA_DIR = path.join(__dirname, 'data');

const state = {
  mode: 'cli',
  dataDir: CLI_DEFAULT_DATA_DIR,
  logsDir: null,          // null = 不单独收集日志（命令行版沿用终端输出）
  configPath: null        // null = server/config.json
};

let currentConfig = null;
const listeners = [];

function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

function emit() {
  listeners.forEach((fn) => {
    try { fn(); } catch (e) { console.error('[runtime] 变更回调失败：' + ((e && e.message) || e)); }
  });
}

/* 设置运行环境。必须在 loadConfig() 之前调用 —— 数据根会参与配置推导。
   目录变化会作废已加载的配置（端口 / Token 由下次 loadConfig 重新给）。 */
function configure(patch) {
  const p = patch || {};
  if (p.mode) state.mode = String(p.mode);
  if (p.dataDir) state.dataDir = path.resolve(String(p.dataDir));
  if (p.logsDir !== undefined) state.logsDir = p.logsDir ? path.resolve(String(p.logsDir)) : null;
  if (p.configPath !== undefined) state.configPath = p.configPath ? path.resolve(String(p.configPath)) : null;
  currentConfig = null;
  emit();
  return snapshot();
}

function snapshot() {
  return {
    mode: state.mode,
    dataDir: state.dataDir,
    logsDir: state.logsDir,
    configPath: state.configPath
  };
}

const getMode = () => state.mode;
const isDesktop = () => state.mode === 'desktop';
const getDataDir = () => state.dataDir;
const getLogsDir = () => state.logsDir;
const getConfigPath = () => state.configPath;

function setCurrentConfig(cfg) { currentConfig = cfg || null; return currentConfig; }
function getCurrentConfig() { return currentConfig; }

module.exports = {
  CLI_DEFAULT_DATA_DIR,
  configure, snapshot, onChange,
  getMode, isDesktop, getDataDir, getLogsDir, getConfigPath,
  setCurrentConfig, getCurrentConfig
};
