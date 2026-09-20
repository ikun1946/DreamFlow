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
const { loadConfig, PROJECT_ROOT } = require('./config');
const P = require('./paths');   // 磁盘布局与资源 URL 形状的唯一事实来源
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

/* 静态文件服务：流式发送 + 支持单段 HTTP Range（206）。
   ⚠ 2026-09-19 修复：原来用 readFileSync 整块读入再一次性写出，两个后果 ——
   · 产物视频（实测一条 5.4 MB）整块进内存，多开几个大产物会顶住事件循环；
   · 不返回 206 / Content-Range，浏览器**无法定位播放进度**：即使页面上放了
     <video>，拖进度条也得把整个文件重下一遍（实测带 Range 的请求收到的是全部字节）。
   现在按 Range 返回片段；浏览器据此可以边下边播、任意跳转。
   小文件仍走一次读取，避免为一张缩略图多开一条流。 */
const STREAM_MIN_BYTES = 256 * 1024;

function serveFile(req, res, absPath) {
  let st;
  try { st = fs.statSync(absPath); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(absPath)] || 'application/octet-stream';
  const total = st.size;
  let start = 0, end = total - 1, status = 200;

  const range = req.headers && req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      if (m[1] === '') { start = Math.max(0, total - Number(m[2] || 0)); end = total - 1; }   // bytes=-N：末尾 N 字节
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), total - 1); }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total, 'Accept-Ranges': 'bytes' });
        return res.end(), true;
      }
      status = 206;
    }
  }
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1
  };
  if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  if (total < STREAM_MIN_BYTES) { res.end(fs.readFileSync(absPath)); return true; }
  const rs = fs.createReadStream(absPath, { start, end });
  rs.on('error', () => { try { res.destroy(); } catch (e) { /* socket 可能已断 */ } });
  rs.pipe(res);
  return true;
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
/* ---------------- 本地 API 的跨域边界 ----------------
   ⚠ 2026-09-19 修复：原来是 `Access-Control-Allow-Origin: *` + token 默认为空 ——
   等于本机任何网页（包括浏览器里打开的任意站点）都能读写这个 API，而这里的接口
   可以**提交真实生成、花掉即梦积分**。攻击面与"本机服务"这个前提完全不匹配。

   现在的边界：
     · 同源（由本服务托管的前端，http://127.0.0.1:8787）永远放行 —— 主流程不需要 CORS；
     · 只对**本地** Origin 回 ACAO（127.0.0.1 / localhost / [::1]，含其它本地端口，
       方便用别的本地 dev server 调试前端）；
     · 非本地 Origin 一律不回 ACAO 并在 API 上直接拒绝 —— 未知网页的请求进不来；
     · `Origin: null`（file:// 打开发布版）默认放行以保留既有体验，
       可用 JC_ALLOW_FILE_ORIGIN=0 关掉（见 config.js 的说明）。 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function originPolicy(req, cfg) {
  const origin = req.headers['origin'];
  if (!origin) return { allow: true, echo: null, why: 'no-origin' };       // 同源导航 / curl
  if (LOCAL_ORIGIN_RE.test(origin)) return { allow: true, echo: origin, why: 'local' };
  if (origin === 'null') {
    return cfg.allowFileOrigin
      ? { allow: true, echo: 'null', why: 'file-origin-allowed' }
      : { allow: false, echo: null, why: 'file-origin-blocked' };
  }
  return { allow: false, echo: null, why: 'foreign-origin' };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(u.pathname);
  const apiRoute = pathname === '/api/v1' || pathname.startsWith('/api/v1/');
  const op = originPolicy(req, cfg);

  // 只对可信 Origin 回 ACAO；未知网页拿不到授权头，预检就会失败，真正的请求根本发不出去
  if (op.echo) {
    res.setHeader('Access-Control-Allow-Origin', op.echo);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  }
  if (req.method === 'OPTIONS') { res.writeHead(op.allow ? 204 : 403); return res.end(); }
  if (!op.allow) {
    if (apiRoute) return sendJson(res, 200, { code: 40100, message: '请求来源不被信任（' + op.why + '）', data: null, traceId: 'origin' });
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden: untrusted origin');
  }

  try {
    // 可选 Bearer 校验
    if (cfg.token) {
      const auth = req.headers['authorization'] || '';
      if (apiRoute && auth !== 'Bearer ' + cfg.token) {
        return sendJson(res, 200, { code: 40100, message: '未登录或 token 无效', data: null, traceId: 'auth' });
      }
    }

    if (pathname === '/' || pathname === '/index.html') return serveDemo(res);
    if (pathname.startsWith('/app/')) {
      const p = path.normalize(path.join(PROJECT_ROOT, pathname));
      if (!p.startsWith(path.join(PROJECT_ROOT, 'app'))) { res.writeHead(403); return res.end(); }
      if (serveFile(req, res, p)) return;
    }
    if (pathname.startsWith('/dist/')) {
      const p = path.normalize(path.join(PROJECT_ROOT, pathname));
      if (!p.startsWith(path.join(PROJECT_ROOT, 'dist'))) { res.writeHead(403); return res.end(); }
      if (serveFile(req, res, p)) return;
    }
    /* 资源文件（素材图 / 产物视频）：
       形状解析与路径安全**统一走 paths.resolveServePath** —— 逐段白名单校验
       （id / 文件名都来自 URL）+ 解析后的目录包含性检查，返回 null 就一律 404，
       不再"把路径拼出来碰运气"。旧的平铺形状由它内部兜底。
       ⚠ 原来这里的判定是 `p.startsWith(OUTPUT_DIR)` —— 前缀相同但不同目录
       （如 output 与 output-bak）会漏过去，是个真实的越界口子。 */
    if (pathname.startsWith('/files/') || pathname.startsWith('/media/assets/')) {
      const p = P.resolveServePath(pathname);
      if (p && serveFile(req, res, p)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
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
  /* 启动期封面补齐：给本次改动之前生成的产物补封面（创作 CLI 不给封面，靠本机 ffmpeg 抽帧）。
     不阻塞监听、失败静默 —— 详见 worker.backfillCovers 的说明。 */
  setTimeout(() => {
    worker.backfillCovers(store.load()).catch((e) => console.error('[封面补齐] 失败：' + (e && e.message)));
  }, 1200);
});

process.on('SIGINT', () => { store.flush(); srv.close(() => process.exit(0)); });
process.on('SIGTERM', () => { store.flush(); srv.close(() => process.exit(0)); });
