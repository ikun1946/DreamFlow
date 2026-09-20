#!/usr/bin/env node
'use strict';
/* ============================================================
   index.js —— 命令行入口（node server/index.js，默认 127.0.0.1:8787）

   ⚠ 2026-09-20 桌面化拆分：服务本体已迁到 server/server.js（可嵌入、可启停）。
   本文件只剩三件事，不要再往里加服务逻辑：
     1. 把环境变量 / server/config.json 读成配置（loadConfig）
     2. 起服务、打启动横幅
     3. 处理 Ctrl+C / 退出信号，走同一个优雅停止路径

   Electron 版走的是 desktop/main.js → server.js 的 createServer()，与这里互不影响。
   ============================================================ */
const { loadConfig } = require('./config');
const { createServer } = require('./server');

const cfg = loadConfig();
const app = createServer({ config: cfg });

app.start().catch((e) => {
  console.error('[server] 启动失败：' + ((e && e.message) || e));
  process.exit(1);
});

let exiting = false;
function shutdown(signal) {
  if (exiting) return;
  exiting = true;
  console.log('\n[server] 收到 ' + signal + '，正在收尾…');
  app.stop().then(() => process.exit(0)).catch(() => process.exit(1));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
