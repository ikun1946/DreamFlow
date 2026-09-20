'use strict';
/* ============================================================
   logger.js —— 桌面版日志

   为什么需要它：打包成 exe 后用户看不到终端（windowsHide + 双击启动），
   而本项目大量诊断信息是走 console 的。没有落盘日志的话，
   "启动失败/白屏/接口 40100"这类问题在用户机器上完全无从查起。

   做法：把主进程的 console 输出同时写进 <logsDir>/main.log。
   单文件上限 2 MB，超过就滚动成 main.log.1（只留一代，够定位就行）。
   ⚠ 不记录 Token / 设备码：那些值只在内存里，从未进过 console。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
let logFile = null;
let installed = false;

function stamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(logFile);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(logFile, logFile + '.1');
  } catch (e) { /* 文件不存在或改名失败都不影响写日志 */ }
}

function write(level, args) {
  if (!logFile) return;
  const text = args.map((a) => {
    if (a instanceof Error) return (a.stack || a.message || String(a));
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFile, '[' + stamp() + '] [' + level + '] ' + text + '\n');
  } catch (e) { /* 磁盘满 / 无权限：绝不因为写日志失败而影响应用 */ }
}

/* 接管 console：保留原有输出（开发时仍能在终端看到），同时落盘。 */
function install(logsDir) {
  if (installed) return logFile;
  installed = true;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    logFile = path.join(logsDir, 'main.log');
  } catch (e) {
    logFile = null;
    return null;
  }
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = function () { write('info', Array.from(arguments)); orig.log.apply(console, arguments); };
  console.warn = function () { write('warn', Array.from(arguments)); orig.warn.apply(console, arguments); };
  console.error = function () { write('error', Array.from(arguments)); orig.error.apply(console, arguments); };
  return logFile;
}

function file() { return logFile; }

module.exports = { install, file, write };
