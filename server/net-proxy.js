'use strict';
/* ============================================================
   net-proxy.js —— 让服务端的长下载走系统代理（2026-10-05 新增）

   为什么需要它：Node 的 `https.get` **不读** HTTP(S)_PROXY —— 而 GitHub 上的大文件直连
   会被中途掐断（本机实测：191 MB 的包连 1 MB 都没下完就 `read ECONNRESET`）。
   桌面版的更新器早就因为同一个原因改用 Chromium 网络栈（见 docs/CHANGELOG.md 的 0.36.0
   「107 MB 从 8.6 小时降到 42 秒」），但那套只在 Electron 里可用；
   服务端（网页版同样在跑）需要一个零依赖的等价物 —— 就是这里。

   做法：对着 HTTP 代理发 `CONNECT` 建隧道，隧道通后在它上面跑 TLS，
   再把这条 socket 交给 `https.get`（`agent:false` + `createConnection`）。
   于是重定向、状态码、流式读取、超时这些语义**仍然由 Node 自己提供**，这里只负责"修路"。

   代理地址取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（大小写都认）；
   本机地址按 NO_PROXY 的惯例绕过；代理 URL 里写了 user:pass 就发 Basic 认证头。
   ⚠ 刻意不引入依赖、也不接管请求本身：出问题时可以一行 `createConnection` 换回直连。
   ============================================================ */

const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

/* 这个目标该走哪个代理？返回 null = 直连。 */
function proxyFor(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch (e) { return null; }
  /* 本机地址一律直连（与 NO_PROXY 的惯例一致）：代理软件通常不代本机回环，
     真送过去只会多一跳甚至直接失败。 */
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) return null;

  const env = process.env;
  const raw = (u.protocol === 'https:'
    ? (env.HTTPS_PROXY || env.https_proxy)
    : (env.HTTP_PROXY || env.http_proxy)) || env.ALL_PROXY || env.all_proxy || '';
  if (!raw) return null;

  const noProxy = String(env.NO_PROXY || env.no_proxy || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const entry of noProxy) {
    if (entry === '*') return null;
    const bare = entry.replace(/^\./, '');
    if (host === bare || host.endsWith('.' + bare)) return null;
  }

  try {
    const p = new URL(raw.indexOf('://') >= 0 ? raw : ('http://' + raw));
    return {
      host: p.hostname,
      port: Number(p.port || 80),
      auth: p.username ? (decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password || '')) : ''
    };
  } catch (e) { return null; }
}

/* 建一条"经过代理"的 socket（CONNECT 隧道 + TLS）。失败一律回调错误，不抛。 */
function tunneledSocket(targetUrl, proxy, cb) {
  const u = new URL(targetUrl);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const raw = net.connect({ host: proxy.host, port: proxy.port });
  let settled = false;
  const fail = (e) => { if (settled) return; settled = true; try { raw.destroy(); } catch (e2) { /* 已断 */ } cb(e instanceof Error ? e : new Error(String(e))); };

  raw.setTimeout(20000, () => fail(new Error('连接代理超时：' + proxy.host + ':' + proxy.port)));
  raw.once('error', (e) => fail(new Error('连接代理失败：' + e.message)));
  raw.once('connect', () => {
    raw.setTimeout(0);
    raw.write('CONNECT ' + u.hostname + ':' + port + ' HTTP/1.1\r\n' +
      'Host: ' + u.hostname + ':' + port + '\r\n' +
      (proxy.auth ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.auth).toString('base64') + '\r\n' : '') +
      'Connection: keep-alive\r\n\r\n');
  });

  let head = '';
  const onData = (d) => {
    head += d.toString('latin1');
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > 8192) fail(new Error('代理返回的响应头异常'));
      return;
    }
    raw.removeListener('data', onData);
    const line = head.slice(0, head.indexOf('\r\n'));
    const code = Number((/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line) || [])[1]);
    if (code !== 200) return fail(new Error('代理拒绝 CONNECT：' + line));
    /* 隧道通了：在它上面跑 TLS。servername 必须给，否则 SNI 缺失会被上游拒。 */
    const t = tls.connect({ socket: raw, servername: u.hostname }, () => {
      if (settled) return;
      settled = true;
      cb(null, t);
    });
    t.once('error', (e) => fail(new Error('TLS 握手失败：' + e.message)));
  };
  raw.on('data', onData);
}

/* 与 `https.get(url, options, cb)` **同形**的入口：有代理就修路，没有就直连。
   调用方（downloadToFile / 探测）不必知道自己走没走代理。

   ⚠ 为什么必须挂在 **Agent** 上（踩过一次才写下来）：
     一开始这里传的是 `agent: false` + 请求级 `createConnection`，看着像标准用法，
     实测请求**根本没进隧道**（错误是 `connect ETIMEDOUT github.com:443`，
     而同一台机器 curl 走代理取同一个地址只要 1.8 秒）。原因是 `agent: false` 的语义是
     "用默认 Agent"，ClientRequest 于是走 `agent.addRequest()` 那条路，
     请求级的 `createConnection` 只在**没有 agent** 时才被读 —— 于是被静默忽略。
     更坑的是它不会报错：直连能通的域名（api.github.com）照样返回 200，
     一路测到"只有 release 资产拉不下来"才暴露，很容易误判成上游的问题。
     现在改成每个请求建一个自己的 Agent 并覆写它的 createConnection：
     隧道是"按目标"建的，本来就不该跨请求复用。 */
function get(url, options, cb) {
  const proxy = proxyFor(url);
  if (!proxy) return https.get(url, options, cb);
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (o, done) => tunneledSocket(url, proxy, done);
  return https.get(url, Object.assign({}, options || {}, { agent }), cb);
}

module.exports = { proxyFor, tunneledSocket, get };
