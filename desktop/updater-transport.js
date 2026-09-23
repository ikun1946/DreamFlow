'use strict';
/* ============================================================
   updater-transport.js —— 更新器的 Chromium 网络传输

   为什么单独一个文件（2026-09-23）：
   这段逻辑原本打算写在 desktop/main.js 里，而 main.js **必须**在 Electron 内
   才能加载（第一行就 require('electron') 拿 app / BrowserWindow）。后果是
   "本方案风险最高的那部分" —— 跳转处理、超时看门狗、代理回退 —— **无法被自动化
   测试覆盖**，只能靠人工跑一遍安装包下载来验。而那几条分支恰好都是
   "出错就静默失效"的类型（302 被当失败 → 下载直接挂；settle 后二次回调 → 状态错乱）。

   抽出来之后它只依赖调用方**传进来**的 `net` 对象（自己不 require electron），
   于是可以在纯 Node 下用一个假 net 把三条分支全测掉：
     · 跳转      → 必须交出一个 3xx 响应（**不能**当错误抛）
     · 连接级失败 → 先尝试切直连，再标 retryable 让上层重发
     · 超时      → 看门狗 abort，且 settle 之后不再二次回调

   ⚠ 三条 API 约束都来自官方文档，别凭印象改：
     1. `redirect` 默认是 `follow`。而 GitHub 的附件下载**必然** 302 到
        release-assets.githubusercontent.com；用默认值会让 updater.js 里
        "跨域跳转剥离 Authorization"那段永远不会被触发 ——
        令牌会被带到第三方主机，那是安全回归。所以必须 `manual`。
     2. `ClientRequest` **没有 setTimeout**（Node 的 req 有），
        超时只能用看门狗 + abort()。
     3. `IncomingMessage` 实现了 Readable，所以 updater.js 里的
        pipe() / on('data') / on('end') / on('error') 都能照用。

   与 updater.js 的接口约定（见那边的"传输层"注释）：
     request(url, opts, cb) -> req
       opts.method / opts.headers / opts.timeoutMs
       opts.onError(err)  —— 连接级失败；err.retryable === true 表示"已切直连，可重发"
       cb(res)            —— 响应**与跳转**都走这里
   ============================================================ */

function noop() { }

/* 合成一个"像 Node 响应"的对象来表示跳转。
   为什么不把跳转当错误交给 onError：updater.js 里两处既有跳转逻辑
   （request() 与 downloadTo()）都写在**响应回调**里、以 res.statusCode 为判据，
   走 error 通道根本进不去 —— 而 downloadTo 的 onError 会删掉临时文件并判失败，
   那等于"下载一遇到 302 就直接失败"。所以这里如实交出一个 3xx 响应，
   让"重发 + 跨域剥离令牌"那份**唯一实现**照常跑。 */
function makeRedirectResponse(statusCode, redirectUrl, responseHeaders) {
  /* location 用 redirectUrl（字符串），不用 responseHeaders.location ——
     后者的类型是 Record<string, string[]>（值是**数组**），直接塞进去会让
     `new URL(...)` 拿到数组，结果取决于隐式转换，不该赌。 */
  const headers = { location: redirectUrl };
  if (responseHeaders && typeof responseHeaders === 'object') {
    for (const [k, v] of Object.entries(responseHeaders)) {
      const key = String(k).toLowerCase();
      if (key === 'location') continue;
      headers[key] = Array.isArray(v) ? v[0] : v;
    }
  }
  return { statusCode: statusCode, headers: headers, resume: noop, destroy: noop };
}

/* net: Electron 的 net 模块（由 main.js 传进来，本文件不 require electron）
   ses: 更新器专用 Session
   hooks.onConnectionFail(): Promise<boolean> —— 尝试把代理切成直连，
                             返回 true 表示"这次真的切了"，于是标 retryable。 */
function makeElectronTransport(net, ses, hooks) {
  const onConnectionFail = (hooks && hooks.onConnectionFail) || function () { return Promise.resolve(false); };

  function request(url, opts, cb) {
    const o = opts || {};
    const req = net.request({
      method: o.method || 'GET',
      url: url,
      headers: Object.assign({ 'User-Agent': 'dreamflow-updater' }, o.headers || {}),
      session: ses,
      redirect: 'manual'
    });

    /* settled：已经交出结果（响应 / 跳转 / 失败）→ 后续事件一律忽略。
       ⚠ 这个标志是必需的，不是保险：`redirect` 之后该请求会被 Chromium 取消
         （manual 模式不调 followRedirect 的既定行为），取消很可能再冒一个
         'error' 出来。没有它，那次 error 会被当成"连接级失败"→ 把代理关掉，
         而这恰恰是"下载一遇 302 就切直连"的 bug。 */
    let settled = false;
    let timer = null;
    const clear = function () { if (timer) { clearTimeout(timer); timer = null; } };
    const settle = function (fn) { if (settled) return; settled = true; clear(); fn(); };

    /* 连接级失败（含超时）→ 先把 session 切成直连，再让上层重发一次。
       `switched` 只在"本次真的切了"时为真 —— 上层据此判断 retryable。 */
    const fail = function (e) {
      settle(function () {
        Promise.resolve()
          .then(function () { return onConnectionFail(); })
          .then(function (switched) {
            if (switched) e.retryable = true;
            if (typeof o.onError === 'function') o.onError(e);
          })
          .catch(function () { if (typeof o.onError === 'function') o.onError(e); });
      });
    };

    if (o.timeoutMs) {
      timer = setTimeout(function () {
        /* 先报超时再 abort：abort 可能同步抛出它自己的 error，
           顺序反了会把错误信息换成 Chromium 那句更难读的。 */
        fail(new Error('请求超时'));
        try { req.abort(); } catch (e) { /* 已经结束了 */ }
      }, o.timeoutMs);
    }

    req.on('response', function (res) { settle(function () { cb(res); }); });
    /* ⚠ 不调 followRedirect()：manual 模式下不调 = 该请求被取消（官方既定行为）。
       取消正是我们要的 —— 由上层重新发一个请求，好让"跨域剥离令牌"生效。
       ⚠ 这里**不能**走 fail()：302 是正常路径，把它当连接级失败
       会在第一次跳转时就把代理关掉，而那正是要避免的。 */
    req.on('redirect', function (statusCode, method, redirectUrl, responseHeaders) {
      settle(function () { cb(makeRedirectResponse(statusCode, redirectUrl, responseHeaders)); });
    });
    req.on('error', fail);

    req.end();
    return req;
  }

  return { request: request };
}

module.exports = { makeElectronTransport, makeRedirectResponse };
