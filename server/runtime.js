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

   ⚠ 2026-09-21 补：**JC_DATA_DIR 在网页版也必须生效**。
   修复前这里只认 configure() 程序化注入，而唯一的调用方是 desktop/main.js，
   于是 `JC_DATA_DIR=/tmp/x node server/index.js` 会被**静默忽略**、直接写进
   server/data —— 而 AGENTS.md 的红线恰恰写着"测试请用 JC_DATA_DIR 指到临时目录，
   别碰 server/data"。等于红线在网页版上是失效的，并且会污染真实库。
   现在读取顺序（高 → 低）：
     ① configure({ dataDir })   —— 桌面版/测试脚本的程序化注入，最高优先级
     ② 环境变量 JC_DATA_DIR      —— 网页版与 CI 的隔离手段
     ③ CLI_DEFAULT_DATA_DIR     —— server/data
   ============================================================ */
const path = require('path');

const CLI_DEFAULT_DATA_DIR = path.join(__dirname, 'data');

/* 环境变量只在**模块加载时**读一次，并记下"显式注入过 dataDir"这件事。
   为什么记：configure() 允许把 dataDir 显式设回 CLI_DEFAULT_DATA_DIR
   （桌面版换盘、或测试想恢复默认），如果每次都拿 env 覆盖，那种显式设置会被吃掉。 */
function envDataDir() {
  const raw = process.env.JC_DATA_DIR ? String(process.env.JC_DATA_DIR).trim() : '';
  if (!raw) return null;
  try { return path.resolve(raw); } catch (e) { return null; }
}

const ENV_DATA_DIR = envDataDir();

const state = {
  mode: 'cli',
  dataDir: ENV_DATA_DIR || CLI_DEFAULT_DATA_DIR,
  dataDirPinned: false,   // configure() 显式设过 dataDir 吗
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
  if (p.dataDir) {
    state.dataDir = path.resolve(String(p.dataDir));
    state.dataDirPinned = true;      // 显式注入，之后不再被 env 覆盖
  }
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

/* 数据根是否来自环境变量（供启动日志与文档说明用） */
const dataDirFromEnv = () => !state.dataDirPinned && !!ENV_DATA_DIR;

function setCurrentConfig(cfg) { currentConfig = cfg || null; return currentConfig; }
function getCurrentConfig() { return currentConfig; }

module.exports = {
  CLI_DEFAULT_DATA_DIR,
  configure, snapshot, onChange,
  getMode, isDesktop, getDataDir, getLogsDir, getConfigPath,
  setCurrentConfig, getCurrentConfig,
  dataDirFromEnv,
  /* 测试用：env 读取结果的只读快照（模块加载时定型，运行中改 env 不生效） */
  ENV_DATA_DIR
};
