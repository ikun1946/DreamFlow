'use strict';
/* ============================================================
   helpers.js —— 测试公共设施

   三条纪律（对应 README「测试」一节）：
     1. **绝不碰真实数据目录**。每个测试文件用自己的临时沙箱，
        通过 runtime.configure({ dataDir }) 重定向数据根 ——
        这是唯一被支持的注入方式（paths.js 的 setRoots 已无生产调用方）。
     2. **临时目录落在仓库内**（`.test-tmp/`）而不是系统 /tmp：
        Git Bash + Node 下 `/tmp` 会被解析成 `C:\tmp\...` 而 ENOENT（实测踩过）。
        仓库内路径已被 .gitignore 忽略（见 `.gitignore` 的 `/_*` 附近）。
     3. **用完必删**。afterAll 里递归删除；进程异常退出时留下的小尾巴
        由 scripts/check-project.js 兜底提示。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.test-tmp');

let seq = 0;

/** 造一个独占临时目录。返回绝对路径（已 mkdir）。 */
function freshDir(tag) {
  seq += 1;
  const name = (tag || 'case') + '-' + process.pid + '-' + seq + '-' + Date.now();
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 递归删除（幂等，失败不抛）。 */
function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

/** 清掉整个 .test-tmp（在所有测试跑完后调用）。 */
function cleanTmpRoot() {
  rmrf(TMP_ROOT);
}

/** 写一个 JSON 文件（自动建父目录）。 */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), 'utf8');
  return file;
}

/** 读 JSON（失败返回 undefined）。 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return undefined; }
}

/** 读纯文本（失败返回 null）。 */
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

/** 造一个符合本仓库形状的"有数据"的库（用于恢复链 / 删除类测试）。 */
function sampleDb(over) {
  const now = new Date().toISOString();
  return Object.assign({
    schemaVersion: 3,
    projects: [{ id: 'pj_t1', name: '测试项目', description: '', settings: {}, defaultWorkspaceId: 'ws_t1', createdAt: now, updatedAt: now, lastOpenedAt: now, deletedAt: null }],
    workspaces: [{ id: 'ws_t1', projectId: 'pj_t1', name: '默认分镜', description: '', createdAt: now, updatedAt: now, lastOpenedAt: now, deletedAt: null }],
    storyboards: [],
    assets: [],
    settings: {
      delimiter: { type: 'custom', value: ';;' },
      defaults: { model: 'seedance2.0_vip', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' },
      queue: { concurrency: 2, autoRetry: true, maxRetry: 2 },
      adapter: { dreaminaAvailable: false, dreaminaVersion: null }
    },
    seq: 0,
    idempotency: {},
    cliJobs: {},
    logs: {},
    records: [],
    recordSeq: 0
  }, over || {});
}

/** 平台判断：Windows 专属断言用得上。 */
const IS_WIN = process.platform === 'win32';

/**
 * 在隔离子进程里跑一段 Node 脚本，返回 stdout。
 *
 * ⚠ 本机实测（Node 22 + Windows）`spawnSync(process.execPath, ...)` 与 `node -e`
 *   都会报 `EBUSY`。可行的路子是**经父 shell** 调 `node <临时文件>`。
 * ⚠ 环境变量必须用 `cmd.exe` 的 `set "K=V" &&` 语法，**不能**用 POSIX 的
 *   `K=V node ...` 前缀 —— execSync 在本机走的是 cmd.exe，前缀形式会被
 *   当成"命令不存在"（实测报 `'JC_DATA_DIR' 不是内部或外部命令`）。
 * ⚠ JC_DATA_DIR 必须在**进程启动时**就位：runtime.js 是在模块加载时读 env 的，
 *   在脚本文本里 `process.env.X = ...` 对它是无效的。
 */
function shellQuote(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}

function nodeRun(script, dataDir, extraEnv) {
  const { execSync } = require('child_process');
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const file = path.join(TMP_ROOT, '_probe-' + (seq++) + '-' + Date.now() + '.js');
  fs.writeFileSync(file, script, 'utf8');

  const envPairs = Object.assign({ JC_DATA_DIR: dataDir || '' }, extraEnv || {});
  const setVars = Object.keys(envPairs)
    .map((k) => 'set "' + k + '=' + String(envPairs[k]) + '"')
    .join(' && ');

  const isWin = process.platform === 'win32';
  const cmd = isWin
    ? setVars + ' && ' + shellQuote(process.execPath) + ' ' + shellQuote(file)
    : Object.keys(envPairs).map((k) => k + '=' + JSON.stringify(String(envPairs[k]))).join(' ')
      + ' ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(file);

  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 同 nodeRun，但只取出脚本用 `__RESULT__` 标记包起来的那段 JSON。
 *
 * 为什么需要：被测模块会往 stdout 打日志（`[store] 空库初始化完成` 之类），
 * 直接 JSON.parse 整段 stdout 会被日志污染（实测报
 * `Unexpected token 's', "[store] 空库初"...`）。
 * 约定脚本最后写一行：`console.log('__RESULT__' + JSON.stringify(payload))`。
 */
function nodeJson(script, dataDir, extraEnv) {
  // 调用方负责在脚本里输出 __RESULT__；这里只做提取
  const out = nodeRun(script, dataDir, extraEnv);
  const m = /__RESULT__([\s\S]*)$/.exec(out);
  if (!m) {
    throw new Error('子进程未输出 __RESULT__ 标记。原始 stdout：\n' + out);
  }
  return JSON.parse(m[1].trim());
}

module.exports = {
  REPO_ROOT, TMP_ROOT, IS_WIN,
  freshDir, rmrf, cleanTmpRoot,
  writeJson, readJson, readText,
  sampleDb, nodeRun, nodeJson,
  os
};
