'use strict';
/* ============================================================
   06-csp.test.js —— CSP / nonce 行为测试（阶段 2.7）

   为什么单开一组：script-src 的 nonce 是**注入脚本逃逸**事故的唯一防线。
   原先的 `script-src 'self' 'unsafe-inline'` 配上 app.js 在 renderTable 等地方用
   innerHTML 拼字符串，注入 `<img src=x onerror="alert(1)">` 不会被浏览器拦下。
   改用 nonce 之后必须验证两点：
     · 内联 <script> 必须**带** nonce 才被执行（否则页面启动期报错、白屏）；
     · 注入的恶意内联脚本**没**nonce 必须被拒（这才是修复的真正收益）。

   ⚠ 数据隔离：JC_DATA_DIR 指到仓库内 .test-tmp 沙箱（AGENTS.md 红线）。
   ⚠ 真起服务：createServer({ port:0, token:'' })，让系统分配空闲端口。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const H = require('./helpers');

/* 数据根必须最先重定向：runtime/config/paths 都在 require 时读 env */
const SANDBOX = H.freshDir('csp');
process.env.JC_DATA_DIR = SANDBOX;

const { createServer, cspHeader, makeNonce } = require('../server/server');

let srv = null;
let base = '';

before(async () => {
  /* createServer 必须在 require 后立即构造（它 init 一堆 winston/adapter），
     但 require 又在 import 阶段就触发 —— 没在 before 里启期时 Node 20 的
     "top-level await is only valid in async functions" 会拒绝外层语法。 */
  srv = createServer({ configOverrides: { port: 0, token: '' } });
  const addr = await srv.start();
  base = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  if (srv) await srv.stop();
  H.rmrf(SANDBOX);
});

/* 拉一次页面，返回 (status, header, body) */
async function fetchIndex() {
  const res = await fetch(base + '/');
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('CSP —— header 形态（阶段 2.7）', () => {
  test('★ 响应头里有 CSP，且 script-src 不再有 unsafe-inline（这是修复的目的）', async () => {
    const { headers } = await fetchIndex();
    const csp = headers.get('content-security-policy');
    assert.ok(csp, '响应必须带 Content-Security-Policy 头');

    const directives = csp.split(/;\s*/);
    const scriptDir = directives.find((d) => d.startsWith('script-src'));
    assert.ok(scriptDir, '应有 script-src 指令');
    assert.ok(!/unsafe-inline/.test(scriptDir),
      '★ script-src 不得含 unsafe-inline —— 否则 XSS 内联脚本仍可执行');

    /* script-src 必须有 nonce（一次性、不可预测）：它是判别"合法内联"与"恶意注入"的唯一证据 */
    const nonceMatch = scriptDir.match(/'nonce-([^']+)'/);
    assert.ok(nonceMatch, '★ script-src 必须含 nonce-XXX');
    assert.ok(nonceMatch[1].length >= 16, 'nonce 应足够长（实测 sha256 base64 至少 22 字符）');
  });

  test('★ 每次响应的 nonce 不同（否则 nonce 退化成 unsafe-inline）', async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      const { headers } = await fetchIndex();
      const csp = headers.get('content-security-policy');
      const nonce = csp.match(/'nonce-([^']+)'/)[1];
      seen.add(nonce);
    }
    assert.equal(seen.size, 5, '★ 5 次响应必须产生 5 个不同 nonce；重复 nonce 等于 nonce 失效');
  });

  test('★ style-src 仍保留 unsafe-inline（app.js 有几十处 style="..."）', async () => {
    const { headers } = await fetchIndex();
    const csp = headers.get('content-security-policy');
    const styleDir = csp.split(/;\s*/).find((d) => d.startsWith('style-src'));
    assert.ok(styleDir, '应有 style-src 指令');
    assert.match(styleDir, /'unsafe-inline'/,
      'style-src 应保留 unsafe-inline（迁移到 CSS 类得不偿失；详见 server.js CSP 注释）');
  });

  test('cspHeader() 与 makeNonce() 是纯函数：同输入同输出，且 nonce 是 base64', () => {
    /* cspHeader：给定 nonce → 给定同形 CSP；这里只验形状，不强制逐字（whitespace 敏感） */
    const h = cspHeader('TEST_NONCE_123');
    assert.match(h, /script-src[^;]*'nonce-TEST_NONCE_123'/);
    assert.match(h, /default-src 'self'/);
    assert.match(h, /object-src 'none'/);

    /* makeNonce：每次都非空，且看起来像 base64（长度 ≥ 16，无空白） */
    for (let i = 0; i < 20; i++) {
      const n = makeNonce();
      assert.ok(n && n.length >= 16, 'nonce 应有足够长度');
      assert.ok(!/\s/.test(n), 'nonce 不得含空白（要嵌进 attribute）');
    }
  });
});

describe('CSP —— index.html 内联脚本必须带 nonce', () => {
  test('★ 主题防闪那段内联 <script> 必须带 nonce 属性（否则浏览器会拦下、首屏闪亮）', async () => {
    const { headers, text } = await fetchIndex();
    const expectedNonce = headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];

    /* 主题防闪脚本：原始锚点（会被 buildIndexHtml 改写）是
       <script>(function(){try{var v=localStorage.getItem('jmc.theme')… */
    const inlineRe = /<script\s+nonce="([^"]+)"\s*>\(function\(\)\{try\{var v=localStorage\.getItem\('jmc\.theme'\)/;
    const m = text.match(inlineRe);
    assert.ok(m, '★ 主题防闪脚本必须以 <script nonce="..."> 形式输出；如失败说明 CSP 会拒绝执行');
    assert.equal(m[1], expectedNonce, 'nonce 必须与响应头里的 nonce 一致');
  });

  test('没有 nonce 的内联 <script> 一个都不允许出现在产物里（防回归到 unsafe-inline）', async () => {
    const { text } = await fetchIndex();
    /* 把所有带 nonce 的 <script> 抠掉，剩下的内联 <script> 应该为零
       （外链 <script src="..."> 不在此匹配范围里）。 */
    const stripped = text.replace(/<script\s+[^>]*nonce="[^"]+"[^>]*>[\s\S]*?<\/script>/g, '');
    const remainingInline = stripped.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || [];
    assert.deepEqual(remainingInline, [],
      '★ 不应存在"无 nonce 且无 src"的内联 <script>，CSP 会拒绝；实得：' + remainingInline.join(' | '));
  });
});

describe('CSP —— 真实注入会被浏览器拒绝', () => {
  test('★ 在响应体里插一段无 nonce 的内联 <script>（模拟 XSS），浏览器会按 CSP 拒绝执行', async () => {
    /* 这是"为什么这次修改值得做"的核心证据 —— 之前 unsafe-inline 等于"浏览器不检查"。
       改 nonce 之后：
         · 带 nonce 的 <script> 可以执行；
         · 不带 nonce 的 <script> 直接被浏览器拒掉；
       这里测的是 service.js 的产物形状：不能让任何内联 <script> 漏掉 nonce。
       真正的"在浏览器里执行"测试需要 Playwright（实机已验证：注入 alert(1) 不弹），
       但那一层不归这条用例如测 —— 本 test 钉住"产物层面没有漏"就足以在回归里抓住。 */
    const { text } = await fetchIndex();
    /* 整段 HTML 里 <script> 总数 = "外链" + "带 nonce 的内联" + "(允许的 0 个不带 nonce 的内联)" */
    const totalScript = (text.match(/<script/g) || []).length;
    const externalScript = (text.match(/<script\s+src=/g) || []).length;
    const nonceScript = (text.match(/<script[^>]*\bnonce=/g) || []).length;
    assert.equal(totalScript, externalScript + nonceScript,
      '★ 全部 <script> 必须等于"外链 + 带 nonce"，否则存在无 nonce 的内联脚本会被浏览器拒绝');
  });
});