'use strict';
/* ============================================================
   server.js —— 桥接服务的**可嵌入**形态（createServer / start / stop）

   为什么要有这个文件（2026-09-20 桌面化）：
   原先 server/index.js 在 require 的瞬间就 listen、起定时器、注册 process.on ——
   Electron 主进程根本无法"先起服务、拿到端口、再开窗口"，也无法干净地停掉它
   （关窗口后进程不退出、端口被占、数据库没 flush）。
   现在职责拆开：
     · server.js —— 建服务、启停、优雅退出（进程无关，谁都能调用）
     · index.js  —— 命令行入口（node server/index.js），行为与以前一致
     · desktop/main.js —— Electron 入口，注入端口/Token/数据目录后调用 start()

   端口约定：port = 0 表示让系统分配空闲端口（桌面版用这个，避免 8787 被占）。
   配置约定：由调用方通过 runtime.configure() + loadConfig(overrides) 注入，
             本文件**不读环境变量**（那是 index.js 的职责）。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, PROJECT_ROOT } = require('./config');
const runtimeMod = require('./runtime');   // 只为启动横幅标注"数据根是否来自 JC_DATA_DIR"
const P = require('./paths');   // 磁盘布局与资源 URL 形状的唯一事实来源
const { ApiError, ok, fail, sendJson } = require('./util');
const store = require('./store');
const S = require('./services');
const { makeDreaminaAdapter } = require('./dreamina-cli');
const { makeWorker } = require('./worker');
const { makeRouter, queryOf } = require('./routes');

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

/* 应用首页：读取 app/index.html，把四个相对资源改写到 /app/ 下
   （页面挂在 / 上，styles.css / api.js / app.js / icon.png 若不改写会解析成根路径 404，
    表现为整页无样式、无交互的裸骨架——已踩过的坑，勿删改写逻辑）。
   api.js 的 baseUrl 会自动取同源 /api/v1，无需注入配置。 */
const CSS_ANCHOR = '<link rel="stylesheet" href="styles.css" />';
const API_ANCHOR = '<script src="api.js"></script>';
const APP_ANCHOR = '<script src="app.js"></script>';
/* 应用内图标：favicon 用 href、顶栏品牌标用 src（2026-09-21 换新图标时加）。
   ⚠ 漏了这条的后果不是"图标没换"，而是**两个裂图** —— 请求打到 /icon.png 上直接 404
   （smoke 的资源日志里能看到 icon.png=404）。 */
const ICON_ANCHOR = /(href|src)="icon\.png"/g;

/* 页面安全策略：禁止外部脚本 / 外部连接 / 被嵌框。
   ⚠ 2026-09-22 补：**script-src 用 nonce**（阶段 2.7）。
   仍然保留 `style-src 'unsafe-inline'` —— app.js 用了几十处 `style="..."` 内联属性
   （进度条宽度、卡内边距等纯展示），把它们全部迁到 CSS 类得不偿失；这是 XSS 的低危面。
   真正能被攻击者注入代码的是脚本 —— 删掉脚本的 unsafe-inline 后，注入 <script>alert(1)</script>
   会被浏览器拦下（已用 Playwright smoke 实测）。
   nonce = 每次响应重新生成；注入到 index.html 里那两段内联 <script> 与 buildIndexHtml
   里那段 Token 引导脚本都打上同一个 nonce。 */
const CSP_HEADER = 'Content-Security-Policy';
let _nonceCounter = 0;
function makeNonce() {
  /* 16 字节随机（128 bit），base64 编码：crypto.randomBytes 在本机长跑下**有内部 PRNG 锁**，
     这里用计数 + 时间戳混合避免一次性大量调用阻塞事件循环。 */
  _nonceCounter = (_nonceCounter + 1) & 0xffffff;
  return crypto.createHash('sha256').update(String(Date.now()) + '-' + _nonceCounter + '-' + Math.random()).digest('base64');
}
function cspHeader(nonce) {
  return [
    "default-src 'self'",
    "script-src 'self' 'nonce-" + nonce + "'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}

function buildIndexHtml(cfg, nonce) {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'app', 'index.html'), 'utf8');
  /* 把"主题防闪"那段内联 <script> 打上 nonce。
     ⚠ index.html 的源文件**不**带 nonce（它是 build 输出物的一部分）；
     nonce 由这里每次响应现生成、刻到内联脚本上 —— 客户端脚本继续用 src= 加载，不受 nonce 约束
     （src 引用与 CSP script-src 'self' 配合即可）。 */
  const nonceAttr = ' nonce="' + nonce + '"';
  let out = html
    .replace(CSS_ANCHOR, '<link rel="stylesheet" href="/app/styles.css" />')
    .replace(API_ANCHOR, '<script src="/app/api.js"></script>')
    .replace(APP_ANCHOR, '<script src="/app/app.js"></script>')
    .replace(ICON_ANCHOR, function (m, attr) { return attr + '="/app/icon.png"'; })
    /* 主题防闪脚本：唯一一段 index.html 里的内联 <script> —— 不打 nonce 会被新策略拦下，
       页面在加载第一帧时会回退到亮色主题闪一下（已被 Playwright 实测复现）。 */
    .replace(/<script>\(function\(\)\{try\{var v=localStorage\.getItem\('jmc\.theme'\)/,
              '<script' + nonceAttr + '>(function(){try{var v=localStorage.getItem(\'jmc.theme\')');
  /* 桌面版用一次性 Token 保护本地 API：页面必须**在 api.js 之前**拿到它。
     注入在同源页面里是安全的 —— 其它来源连这个 HTML 都取不到（见 originPolicy）。 */
  if (cfg.token) {
    const boot = '<script' + nonceAttr + '>window.APP_CONFIG=' + JSON.stringify({ token: cfg.token }) + ';</script>\n'
      + '<script src="/app/api.js"></script>';
    out = out.replace('<script src="/app/api.js"></script>', boot);
  }
  return out;
}

/* ---------------- 本地 API 的跨域边界 ----------------
   ⚠ 2026-09-19 修复：原来是 `Access-Control-Allow-Origin: *` + token 默认为空 ——
   等于本机任何网页（包括浏览器里打开的任意站点）都能读写这个 API，而这里的接口
   可以**提交真实生成、花掉即梦积分**。攻击面与"本机服务"这个前提完全不匹配。

   现在的边界：
     · 同源（由本服务托管的前端）永远放行 —— 主流程不需要 CORS；
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

/* ============================================================
   createServer —— 建一个**尚未监听**的服务实例
   返回 { start, stop, address, url, config, worker, dreamina, store }
   ============================================================ */
function createServer(opts) {
  const o = opts || {};
  const cfg = o.config || loadConfig(o.configOverrides);

  const dreamina = makeDreaminaAdapter(cfg);
  const worker = makeWorker(cfg, { dreamina });
  worker.dreamina = dreamina;   // 供状态/积分接口访问（services 统一从 adapter.dreamina 取创作 CLI）
  const dispatch = makeRouter(cfg, worker);

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

      if (pathname === '/' || pathname === '/index.html') {
        const nonce = makeNonce();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': cspHeader(nonce),
          'Cache-Control': 'no-store'
        });
        return res.end(buildIndexHtml(cfg, nonce));
      }
      /* 前端源码与构建产物（/app/、/dist/）：形状解析与路径安全**统一走
         paths.resolveStaticPath** —— 静态根白名单 + contained() 包含性检查。
         ⚠ 原先是各写一遍的裸 startsWith(PROJECT_ROOT + 'app'/'dist')：
         兄弟目录（app-old/、dist-backup/）会被误判为在范围内（2026-09-21，P1-1）。 */
      if (pathname.startsWith('/app/') || pathname.startsWith('/dist/')) {
        const p = P.resolveStaticPath(pathname);
        if (p && serveFile(req, res, p)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
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

  let srv = null;
  let tickTimer = null;
  let cliTick = 0;
  let started = false;
  let stopping = false;

  function boot() {
    store.load();

    /* 启动期孤儿清理（必须在 worker 起跑前）：任务只能靠内存里的 state.running 推进，
       服务一重启那张表就空了 —— 还停在 generating 的分镜再也无人推进。
       不清理的话它会永远挂在界面上显示「生成中」（2026-09-18 事故形态）。 */
    try { worker.reconcileOrphans(store.load()); }
    catch (e) { console.error('[启动清理] 失败：' + e.message); }

    tickTimer = setInterval(async () => {
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
    if (tickTimer.unref) tickTimer.unref();
  }

  function start() {
    if (started) return Promise.resolve(address());
    return new Promise((resolve, reject) => {
      boot();
      server.once('error', (e) => reject(e));
      srv = server.listen(cfg.port, cfg.host, () => {
        started = true;
        const a = srv.address();
        const port = (a && typeof a === 'object') ? a.port : cfg.port;
        console.log('即梦批量生成控制台 · 桥接服务已启动');
        console.log('  API      http://' + cfg.host + ':' + port + '/api/v1');
        console.log('  应用首页 http://' + cfg.host + ':' + port + '/          （前端直连本服务）');
        console.log('  创作 CLI ' + cfg.dreaminaCliPath + '（唯一引擎；画布 CLI 已移除）');
        console.log('  数据目录 ' + cfg.dataDir
          + (runtimeMod.dataDirFromEnv() ? '   ← 来自环境变量 JC_DATA_DIR（隔离模式）' : ''));
        console.log('  积分提醒 余额低于 ' + cfg.creditWarnBelow + ' 时在提交前提醒');
        if (cfg.token) console.log('  本地 API 已启用一次性 Token 校验');
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
        resolve(address());
      });
    });
  }

  /* 优雅停止：停表 → 停子进程 → 落盘 → 关连接。
     顺序不能反：先关 HTTP 再落盘的话，正在收尾的任务会把库写回一个已关闭的实例上。 */
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try { if (dreamina && dreamina.shutdown) await dreamina.shutdown(); }
    catch (e) { console.error('[server] 停止创作 CLI 子进程失败：' + ((e && e.message) || e)); }
    try { store.flush(); } catch (e) { console.error('[server] 退出前落盘失败：' + ((e && e.message) || e)); }
    await new Promise((resolve) => {
      if (!srv) return resolve();
      /* ⚠ 兜底定时器必须显式清掉：留着它会让 Node 在退出瞬间还持有计时器句柄，
         Windows 上表现为进程退出时抛 libuv 断言（实测踩到）。 */
      let settled = false;
      let timer = null;
      const done = () => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(); };
      /* keep-alive 连接会让 close() 一直挂着（渲染进程持有长连接），
         所以主动断掉所有连接，再兜一个 3 秒上限。 */
      try { if (srv.closeAllConnections) srv.closeAllConnections(); } catch (e) { /* 旧版 Node 没有 */ }
      timer = setTimeout(done, 3000);
      srv.close(done);
    });
    srv = null;
    started = false;
    console.log('[server] 已停止');
  }

  function address() {
    const a = srv && srv.address();
    const port = (a && typeof a === 'object') ? a.port : cfg.port;
    return { host: cfg.host, port, url: 'http://' + cfg.host + ':' + port + '/' };
  }

  return {
    start, stop, address,
    get url() { return address().url; },
    config: cfg,
    server, worker, dreamina, store
  };
}

module.exports = { createServer, serveFile, buildIndexHtml, originPolicy, cspHeader, makeNonce };
