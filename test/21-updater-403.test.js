'use strict';
/* ============================================================
   更新器的 GitHub 403 判读（2026-10-05 用户实测踩到后补）

   症状：应用内点「检查更新」报
     「取 GitHub release 失败：HTTP 403（私有仓库需要访问令牌，或更新源地址不对）」
   而仓库是**公开的**、任何人可拉 —— 那句提示把人带偏了（去申请令牌，其实不需要）。

   真因（证据链都在下面的用例里）：
     · 同机**直连** api.github.com → 200，配额剩 58/60；
     · 同机**经系统代理** → 403，响应头 `X-RateLimit-Remaining: 0`，
       body 写明 `API rate limit exceeded for 54.179.5.44`（共享代理出口 IP）；
     · 应用走的是 Electron/Chromium 网络栈，**认系统代理** → 正好踩在被耗光的出口上。
   所以：公开库 + 403 ⇒ 绝大多数是**出口 IP 限流**，不是"要令牌"。
   本组用例钉三件事：判据要读响应头 / 文案要说人话 / 命中后要能自动切直连重发。
   ============================================================ */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const updater = require('../desktop/updater');

/* 造一个"像响应"的对象：只需 statusCode / headers，resume 用来吞掉未读正文。 */
const res = (statusCode, headers) => ({ statusCode: statusCode, headers: headers || {}, resume() {} });

describe('更新器：403 的判读（公开库不需要令牌）', () => {
  test('配额耗尽要被认出来 —— 靠响应头，不靠状态码', () => {
    /* 头被网关抹掉时，靠 fetchText 回填的 body 标记也要认 */
    assert.equal(updater.isRateLimited(res(403, { 'x-ratelimit-remaining': '0' })), true);
    assert.equal(updater.isRateLimited(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'core' })), true);
    assert.equal(updater.isRateLimited(res(403, { 'retry-after': '60' })), true);
    const byBody = res(403, {});
    byBody.__bodyMentionsRateLimit = true;
    assert.equal(updater.isRateLimited(byBody), true);

    /* 配额还剩 1 的 403 不是限流（例如被仓库规则挡了）→ 不许当成限流去切直连 */
    assert.equal(updater.isRateLimited(res(403, { 'x-ratelimit-remaining': '1' })), false);
    assert.equal(updater.isRateLimited(res(403, {})), false);
    assert.equal(updater.isRateLimited(res(404, { 'x-ratelimit-remaining': '0' })), false, '只有 403 是限流');
    assert.equal(updater.isRateLimited(null), false);
  });

  test('文案：403 限流不得再提"私有仓库需要访问令牌"（那是把用户带偏）', () => {
    const limited = res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) });
    const hint = updater.ghErrorHint(limited);
    assert.doesNotMatch(hint, /私有仓库/, '这是本次修掉的核心误报');
    assert.match(hint, /配额/, '要说清是配额用尽');
    assert.match(hint, /公开库不需要令牌/, '要明确"不用去申请令牌"');
    assert.match(hint, /出口 IP/, '要说清与出口 IP 有关（共享代理）');
    assert.match(hint, /直连/, '要说清应用会怎么处理');

    /* 401 / 404 才是"要令牌 / 地址不对"那两类，各自的提示不能串 */
    assert.match(updater.ghErrorHint(res(401, {})), /访问令牌/);
    assert.match(updater.ghErrorHint(res(404, {})), /不存在|没有发布/);
    assert.equal(updater.ghErrorHint(res(500, {})), '', '其它状态不硬塞提示');

    /* 403 但不像限流时，也要说"不需要令牌"，不能说私有库 */
    const other = updater.ghErrorHint(res(403, { 'x-ratelimit-remaining': '57' }));
    assert.doesNotMatch(other, /私有仓库/);
    assert.match(other, /不需要令牌|限流/);
  });

  test('fetchText 拿到 403 时：读 body 判限流，并给出正确提示', async () => {
    /* 注入假传输：返回一个 403，响应头没有限流信息，但 body 写着 rate limit exceeded
       —— 这正是本次实测的形态（代理出口被耗光）。 */
    const fakeBody = JSON.stringify({ message: 'API rate limit exceeded for 54.179.5.44.' });
    updater.setTransport({
      request(url, opts, cb) {
        /* ⚠ on 必须能触发 'data' 与 'end'：fetchText 收到 403 后要 readAll 收正文
           才能认出 "rate limit exceeded"；不触发 'end' 会让 promise 悬空。 */
        const r = {
          statusCode: 403, headers: {}, resume() {},
          on(ev, fn) {
            if (ev === 'data') setImmediate(() => fn(Buffer.from(fakeBody, 'utf8')));
            if (ev === 'end') setImmediate(fn);
            return r;
          }
        };
        setImmediate(() => cb(r));
        return { on() {}, end() {}, destroy() {} };
      }
    });
    try {
      const out = await updater.fetchText('https://api.github.com/repos/x/y/releases/latest', null, 4096);
      assert.equal(out.ok, false);
      assert.equal(out.status, 403);
      assert.doesNotMatch(out.error, /私有仓库/);
      assert.match(out.error, /配额/);
    } finally {
      updater.setTransport(null);
    }
  });

  test('命中限流：请求把代理切成直连并重发一次（而不是直接把错报给用户）', async () => {
    let calls = 0;
    let switched = 0;
    /* 第一次经"代理"拿到限流 403；切直连后第二次拿到 200。 */
    updater.setTransport({
      request(url, opts, cb) {
        calls++;
        const status = calls === 1 ? 403 : 200;
        const headers = calls === 1 ? { 'x-ratelimit-remaining': '0' } : {};
        const r = {
          statusCode: status, headers, resume() {},
          on(ev, fn) { if (ev === 'data') setImmediate(() => fn(Buffer.from('version: 0.48.0', 'utf8'))); if (ev === 'end') setImmediate(fn); return r; }
        };
        setImmediate(() => cb(r));
        return { on() {}, end() {}, destroy() {} };
      }
    });
    updater.setProxyUnusableHook(() => { switched++; return Promise.resolve(true); });
    try {
      const out = await updater.fetchText('https://api.github.com/repos/x/y/releases/latest', null, 4096);
      assert.equal(out.ok, true, '切直连后应当成功：' + out.error);
      assert.equal(switched, 1, '要请调用方切一次直连');
      assert.equal(calls, 2, '只重发一次（不能变成重试风暴）');
    } finally {
      updater.setProxyUnusableHook(null);
      updater.setTransport(null);
    }
  });

  test('切了直连仍是限流：只重发一次，不变成重试风暴', async () => {
    /* 上一条那个用例的第 2 次假响应是 200，所以"只重发一次"其实没被钉住 ——
       无限重试在那种假传输下根本显不出来。这里让**每次**都是限流 403，
       并且钩子一直答应"已切直连"（生产里 disableProxyOnce 只答应一次，
       但 updater.js 自己也必须有 `retried` 这道闸，不能只靠调用方自觉）。 */
    let calls = 0;
    updater.setTransport({
      request(url, opts, cb) {
        calls++;
        const r = {
          statusCode: 403, headers: { 'x-ratelimit-remaining': '0' }, resume() {},
          on(ev, fn) { if (ev === 'data') setImmediate(() => fn(Buffer.from('{"message":"rate limit exceeded"}', 'utf8'))); if (ev === 'end') setImmediate(fn); return r; }
        };
        setImmediate(() => cb(r));
        return { on() {}, end() {}, destroy() {} };
      }
    });
    updater.setProxyUnusableHook(() => Promise.resolve(true));
    try {
      const out = await updater.fetchText('https://api.github.com/repos/x/y/releases/latest', null, 4096);
      assert.equal(out.ok, false);
      assert.equal(calls, 2, '原请求 + 一次重发，就该停（超过就是重试风暴）');
      assert.match(out.error, /配额/);
    } finally {
      updater.setProxyUnusableHook(null);
      updater.setTransport(null);
    }
  });

  test('切不了直连（钩子缺失或返回 false）时，如实报限流，不静默吞掉', async () => {
    let calls = 0;
    updater.setTransport({
      request(url, opts, cb) {
        calls++;
        const r = {
          statusCode: 403, headers: { 'x-ratelimit-remaining': '0' }, resume() {},
          /* ⚠ 'end' 必须触发：fetchText 判 403 时要 readAll 收正文，
             不触发 'end' 的话 promise 永远悬空（node --test 会挂住，不是失败）。 */
          on(ev, fn) { if (ev === 'data') setImmediate(() => fn(Buffer.from('{"message":"rate limit exceeded"}', 'utf8'))); if (ev === 'end') setImmediate(fn); return r; }
        };
        setImmediate(() => cb(r));
        return { on() {}, end() {}, destroy() {} };
      }
    });
    /* 不注入钩子 —— 纯 Node / verify:release 就是这个形态 */
    try {
      const out = await updater.fetchText('https://api.github.com/repos/x/y/releases/latest', null, 4096);
      assert.equal(out.ok, false);
      assert.equal(calls, 1, '没有钩子就不要白白重发');
      assert.match(out.error, /配额/);
    } finally {
      updater.setTransport(null);
    }
  });

  test('更新源仍是固定的公开库（这条不能被"403 要令牌"的误报带偏成可配置）', () => {
    const s = updater.resolveSource(null);
    assert.equal(s.provider, 'github');
    assert.equal(s.owner, 'ikun1946');
    assert.equal(s.repo, 'DreamFlow');
    assert.equal(s.token, '', '公开库匿名可读，不嵌令牌（嵌了等于把访问权交出去）');
  });
});
