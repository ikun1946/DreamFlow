#!/usr/bin/env node
'use strict';
/* ============================================================
   index.js —— 即梦批量生成控制台 · 本地桥接服务入口
   运行：node server/index.js   （默认 127.0.0.1:8787）
   职责：
   - /api/v1/*   契约接口（routes.js）
   - /           前端 http 模式演示页（读取 app/index.html 注入 APP_CONFIG）
   - /app/*      开发版静态资源；/dist/* 发布版；/files/* 生成产物
   - worker：创作 CLI 队列（1.5s tick）

   ⚠ 2026-09-18：画布 CLI（dreamina-canvas）已彻底移除，本项目只使用创作 CLI（dreamina）。
     原 server/cli.js（画布适配层）已删除，worker 迁到 server/worker.js。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, PROJECT_ROOT, OUTPUT_DIR, ASSET_DIR } = require('./config');
const { ApiError, ok, fail, sendJson } = require('./util');
const store = require('./store');
const S = require('./services');
const { makeDreaminaAdapter } = require('./dreamina-cli');
const { makeWorker } = require('./worker');
const { makeRouter, queryOf } = require('./routes');

const cfg = loadConfig();
const dreamina = makeDreaminaAdapter(cfg);
const worker = makeWorker(cfg, { dreamina });
worker.dreamina = dreamina;   // 供状态/积分接口访问（services 统一从 adapter.dreamina 取创作 CLI）
const dispatch = makeRouter(cfg, worker);


/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac'
};

function serveFile(res, absPath) {
  try {
    const data = fs.readFileSync(absPath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(absPath)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch (e) { return false; }
}

/* 应用首页：读取 app/index.html，把三个相对资源改写到 /app/ 下
   （页面挂在 / 上，styles.css / api.js / app.js 若不改写会解析成根路径 404，
    表现为整页无样式、无交互的裸骨架——已踩过的坑，勿删改写逻辑）。
   api.js 的 baseUrl 会自动取同源 /api/v1，无需注入配置。 */
function serveDemo(res) {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'app', 'index.html'), 'utf8');
  const out = html
    .replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="/app/styles.css" />')
    .replace('<script src="api.js"></script>', '<script src="/app/api.js"></script>')
    .replace('<script src="app.js"></script>', '<script src="/app/app.js"></script>');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(out);
}

/* ---------------- 请求处理 ---------------- */
const server = http.createServer(async (req, res) => {
  // CORS：前端可能以 file:// 或其它本地端口打开
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(u.pathname);

  try {
    // 可选 Bearer 校验
    if (cfg.token) {
      const auth = req.headers['authorization'] || '';
      const apiRoute = pathname === '/api/v1' || pathname.startsWith('/api/v1/');
      if (apiRoute && auth !== 'Bearer ' + cfg.token) {
        return sendJson(res, 200, { code: 40100, message: '未登录或 token 无效', data: null, traceId: 'auth' });
      }
    }

    if (pathname === '/' || pathname === '/index.html') return serveDemo(res);
    if (pathname.startsWith('/app/')) {
      const p = path.normalize(path.join(PROJECT_ROOT, pathname));
      if (!p.startsWith(path.join(PROJECT_ROOT, 'app'))) { res.writeHead(403); return res.end(); }
      if (serveFile(res, p)) return;
    }
    if (pathname.startsWith('/dist/')) {
      const p = path.normalize(path.join(PROJECT_ROOT, pathname));
      if (!p.startsWith(path.join(PROJECT_ROOT, 'dist'))) { res.writeHead(403); return res.end(); }
      if (serveFile(res, p)) return;
    }
    if (pathname.startsWith('/files/')) {
      const p = path.normalize(path.join(OUTPUT_DIR, pathname.slice('/files/'.length)));
      if (!p.startsWith(OUTPUT_DIR)) { res.writeHead(403); return res.end(); }
      if (serveFile(res, p)) return;
    }
    if (pathname.startsWith('/media/assets/')) {
      const p = path.normalize(path.join(ASSET_DIR, decodeURIComponent(pathname.slice('/media/assets/'.length))));
      if (!p.startsWith(ASSET_DIR)) { res.writeHead(403); return res.end(); }
      if (serveFile(res, p)) return;
    }

    if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
      const sub = pathname.slice('/api/v1'.length) || '/';
      try {
        return await dispatch(req, res, sub);
      } catch (e) {
        return fail(res, e);
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    console.error('[server] 未处理异常', e);
    try { fail(res, e); } catch (e2) { /* socket 可能已断 */ }
  }
});

/* ---------------- 启动 ---------------- */
store.load();

/* 启动期孤儿清理（必须在 worker 起跑前）：任务只能靠内存里的 state.running 推进，
   服务一重启那张表就空了 —— 还停在 generating 的分镜再也无人推进。
   不清理的话它会永远挂在界面上显示「生成中」（2026-09-18 事故形态）。 */
try { worker.reconcileOrphans(store.load()); }
catch (e) { console.error('[启动清理] 失败：' + e.message); }

let cliTick = 0;
setInterval(async () => {
  try {
    if (Date.now() - cliTick < 1500) return;
    cliTick = Date.now();
    const db = store.load();
    await worker.tick(db, () => store.save());
  } catch (e) {
    /* 不能只打终端：否则「界面永远生成中」这类故障在库里查不到任何线索（2026-09-18 事故里
       worker 挂了却只在 stderr 留痕，用户和排查者都看不到）。runOne 已兜住单个任务的异常，
       这里兜的是 tick 自身的异常（CLI 探测 / 并发档位解析 / 落盘等）。 */
    console.error('[worker tick]', e);
    try { store.pushLog('system', 'err', 'worker 循环异常：' + ((e && e.message) || e)); }
    catch (e2) { /* 留痕失败不能反过来打断循环 */ }
  }
}, 800);

const srv = server.listen(cfg.port, cfg.host, () => {
  console.log('即梦批量生成控制台 · 桥接服务已启动');
  console.log('  API      http://' + cfg.host + ':' + cfg.port + '/api/v1');
  console.log('  应用首页 http://' + cfg.host + ':' + cfg.port + '/          （前端直连本服务）');
  console.log('  创作 CLI ' + cfg.dreaminaCliPath + '（唯一引擎；画布 CLI 已移除）');
  console.log('  积分提醒 余额低于 ' + cfg.creditWarnBelow + ' 时在提交前提醒');
  /* 旧配置里若还留着画布 CLI 时代的项，明确提示它们已经失效 ——
     静默忽略会让人以为"配置还在起作用"。 */
  if (cfg.legacyCliPath) console.log('  ⚠ 配置项 cliPath（' + cfg.legacyCliPath + '）已失效：画布 CLI 已移除，可自行删掉');
  if (cfg.legacyCreditCeiling) console.log('  ⚠ 配置项 creditCeiling（' + cfg.legacyCreditCeiling + '）已失效：请改用 creditWarnBelow（积分余额提醒阈值）');
  // 启动预热：后台探测创作 CLI（不阻塞监听），用户打开页面时探测缓存已热 → 首屏不再等待
  setTimeout(() => {
    if (dreamina && dreamina.probe) dreamina.probe(true).catch(() => {});
  }, 300);
});

process.on('SIGINT', () => { store.flush(); srv.close(() => process.exit(0)); });
process.on('SIGTERM', () => { store.flush(); srv.close(() => process.exit(0)); });
