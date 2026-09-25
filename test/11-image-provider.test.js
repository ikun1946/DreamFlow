'use strict';
/* ============================================================
   11-image-provider.test.js —— Work Fisher 生图客户端（阶段 1）

   为什么必须用假传输：这是本项目第一个**会花钱**的外部调用。真跑一次就是真扣费，
   而这里要覆盖的分支（401 / 402 / 429 / 超时 / 缺字段）恰恰都是"出错时才走到"的 ——
   靠人工照着真密钥试，等于用真金白银去换一次覆盖率，既贵又不可能穷尽。

   假传输的形状与 desktop/updater.js 一致：request(url, opts, cb) -> req，
   但 cb 收到的是**已读完的响应对象** { statusCode, headers, body }
   （见 image-provider.js 的传输层注释），不是流。

   ⚠ 本文件不发任何真实网络请求，也不读任何真实密钥。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const IP = require('../server/image-provider');

/* ---------------- 假传输：记录请求 + 按脚本回响应 ----------------
   ⚠ 形状必须与 server/image-provider.js 的默认传输层**完全一致**：
     单参数 cb、失败走 `{ error }`。曾经这里写成 `cb(null, res)` 双参数，
     于是响应对象落进了错误的参数位，所有成功用例被误报成 network ——
     假传输与真传输的形状对不上时，测出来的成功是假的、失败也是假的。 */
function fakeTransport(handler) {
  const calls = [];
  return {
    calls: calls,
    request(url, opts, cb) {
      const rec = {
        url: url,
        method: (opts && opts.method) || 'GET',
        headers: (opts && opts.headers) || {},
        body: (opts && opts.body) || null,
        timeoutMs: opts && opts.timeoutMs
      };
      calls.push(rec);
      /* 异步交付，贴近真实传输（同步回调会让"先 settle 再注册"这类错误被掩盖） */
      setImmediate(() => {
        const r = handler(rec, calls.length - 1);
        if (r && r.error) return cb({ error: r.error });
        cb({
          statusCode: r.status || 200,
          headers: r.headers || {},
          body: r.body === undefined ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
        });
      });
      return { abort() { }, end() { } };
    }
  };
}

let savedTransport = null;
before(() => { savedTransport = IP.transport(); });
after(() => { IP.setTransport(savedTransport); });

const KEY = 'wf_test_key_do_not_log_0123456789';
const make = (opts) => IP.makeImageProvider({ apiKey: KEY }, opts);

/* ============================================================
   1. 请求形状：路径 / 鉴权头 / 请求体
   ============================================================ */
describe('请求形状（提交接口）', () => {
  test('提交走单数路径 /v1/image/generations，带 Bearer 与 Flare 请求体', async () => {
    const t = fakeTransport(() => ({ status: 200, body: { data: { task_id: 'tk_1' } } }));
    IP.setTransport(t);
    const p = make();
    const r = await p.submit('一只猫在窗台上');
    assert.equal(r.taskId, 'tk_1');

    assert.equal(t.calls.length, 1);
    const c = t.calls[0];
    /* ⚠ 单数 image（不是 images）—— 这条与服务商文档一致，写错了会 404 */
    assert.equal(c.url, IP.DEFAULT_BASE + '/v1/image/generations');
    assert.equal(c.method, 'POST');
    assert.equal(c.headers['Authorization'], 'Bearer ' + KEY);

    const body = JSON.parse(c.body);
    assert.equal(body.model, IP.DEFAULT_MODEL);
    assert.equal(body.model, 'workfisher-image-g-v2.5-flare');
    assert.equal(body.prompt, '一只猫在窗台上');
    /* 单次参数：n=1 / 1k / auto / png（官方默认值，显式传递无害） */
    assert.equal(body.n, 1);
    assert.equal(body.resolution, '1k');
    assert.equal(body.quality, 'auto');
    assert.equal(body.output_format, 'png');
    /* 平铺参数：v2.5 系**不**把参数包在 metadata 里（那是 Seedream 系的形状） */
    assert.equal(body.metadata, undefined);
  });

  test('查询走 /v1/image/generations/{task_id} 且对 id 做 URL 编码', async () => {
    const t = fakeTransport(() => ({ status: 200, body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/a.png' } } }));
    IP.setTransport(t);
    const p = make();
    const r = await p.query('tk/with space');
    assert.equal(r.state, 'succeeded');
    assert.equal(r.resultUrl, 'https://cdn.example.com/a.png');
    assert.equal(t.calls[0].url, IP.DEFAULT_BASE + '/v1/image/generations/tk%2Fwith%20space');
    assert.equal(t.calls[0].method, 'GET');
    /* GET 不带请求体 */
    assert.equal(t.calls[0].body, null);
  });

  test('提交超时窗口是 30 秒、查询是 20 秒（提交是计费动作，给足但不无限等）', async () => {
    const t = fakeTransport(() => ({ status: 200, body: { data: { id: 'x' } } }));
    IP.setTransport(t);
    const p = make();
    await p.submit('p');
    await p.query('x');
    assert.equal(t.calls[0].timeoutMs, 30 * 1000);
    assert.equal(t.calls[1].timeoutMs, 20 * 1000);
  });

  test('提交响应用 id 字段也能取到任务（两种写法都在被用）', async () => {
    IP.setTransport(fakeTransport(() => ({ status: 200, body: { data: { id: 12345 } } })));
    const r = await make().submit('p');
    assert.equal(r.taskId, '12345');
  });
});

/* ============================================================
   2. 错误分支：401 / 402 / 429 / 5xx
   ============================================================ */
describe('错误分支', () => {
  const cases = [
    { name: '401 → auth（密钥无效）', status: 401, kind: 'auth' },
    { name: '403 → auth（无权限）', status: 403, kind: 'auth' },
    { name: '402 → no_credit（余额不足）', status: 402, kind: 'no_credit' },
    { name: '429 → ratelimit（限流）', status: 429, kind: 'ratelimit' },
    { name: '500 → upstream', status: 500, kind: 'upstream' },
    { name: '503 → upstream', status: 503, kind: 'upstream' }
  ];
  cases.forEach((c) => {
    test('提交：' + c.name, async () => {
      IP.setTransport(fakeTransport(() => ({ status: c.status, body: { error: { message: 'boom ' + c.status } } })));
      const r = await make().submit('p');
      assert.equal(r.kind, c.kind);
      assert.equal(r.status, c.status);
      /* 服务商的错误说明要带出来（用户按原因处理），但不能带密钥 */
      assert.match(r.message, /boom/);
      assert.doesNotMatch(r.message, new RegExp(KEY));
    });
  });

  test('查询：401 也要如实报 auth，不能当成"任务还在跑"', async () => {
    IP.setTransport(fakeTransport(() => ({ status: 401, body: { message: 'invalid token' } })));
    const r = await make().query('tk_1');
    assert.equal(r.kind, 'auth');
  });

  test('非 JSON 的错误响应被截断成一段纯文本（防 HTML 错误页塞满 message）', async () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body>' + 'x'.repeat(5000) + '</body></html>';
    IP.setTransport(fakeTransport(() => ({ status: 502, body: html })));
    const r = await make().submit('p');
    assert.equal(r.kind, 'upstream');
    assert.ok(r.message.length <= 220, 'message 应被截断，实际 ' + r.message.length);
    assert.doesNotMatch(r.message, /<html>/);
  });
});

/* ============================================================
   3. 超时与网络：必须与"发不出去"分开
   ============================================================ */
describe('超时与网络', () => {
  test('提交超时 → kind=timeout（上层据此转 submission_unknown，禁止自动重发）', async () => {
    IP.setTransport(fakeTransport(() => ({ error: new Error('请求超时') })));
    const r = await make().submit('p');
    assert.equal(r.kind, 'timeout');
  });

  test('连接失败 → kind=network（明确没发出去，可以重试）', async () => {
    IP.setTransport(fakeTransport(() => ({ error: new Error('getaddrinfo ENOTFOUND api.work-fisher.com') })));
    const r = await make().submit('p');
    assert.equal(r.kind, 'network');
  });

  test('查询超时 → timeout，但**不**丢掉 task_id 的语义（由上层保留继续查）', async () => {
    IP.setTransport(fakeTransport(() => ({ error: new Error('timeout of 20000ms exceeded') })));
    const r = await make().query('tk_keep_me');
    assert.equal(r.kind, 'timeout');
  });

  test('传输层同步抛错也要被兜住（不能把异常漏成 500）', async () => {
    IP.setTransport({
      request() { throw new Error('socket 已被占用'); }
    });
    const r = await make().submit('p');
    assert.equal(r.kind, 'network');
  });
});

/* ============================================================
   4. 协议错误：缺字段时报告，不猜
   ============================================================ */
describe('协议错误（缺字段不猜）', () => {
  test('提交响应没有任务 ID → protocol', async () => {
    IP.setTransport(fakeTransport(() => ({ status: 200, body: { data: { status: 'ok' } } })));
    const r = await make().submit('p');
    assert.equal(r.kind, 'protocol');
    assert.match(r.message, /任务 ID/);
  });

  test('提交响应不是 JSON → protocol', async () => {
    IP.setTransport(fakeTransport(() => ({ status: 200, body: '<html>ok</html>' })));
    const r = await make().submit('p');
    assert.equal(r.kind, 'protocol');
  });

  test('查询成功但缺 result_url → protocol（绝不拼一个下载地址）', async () => {
    IP.setTransport(fakeTransport(() => ({ status: 200, body: { data: { status: 'SUCCESS' } } })));
    const r = await make().query('tk_1');
    assert.equal(r.kind, 'protocol');
    assert.match(r.message, /result_url/);
  });

  test('查询缺 task_id → protocol，且**不发**任何请求', async () => {
    const t = fakeTransport(() => ({ status: 200, body: {} }));
    IP.setTransport(t);
    const r = await make().query('');
    assert.equal(r.kind, 'protocol');
    assert.equal(t.calls.length, 0);
  });
});

/* ============================================================
   5. 状态映射与用量
   ============================================================ */
describe('状态映射与用量', () => {
  const ok = (status, extra) => fakeTransport(() => ({
    status: 200,
    body: { data: Object.assign({ status: status, result_url: 'https://cdn.example.com/r.png' }, extra || {}) }
  }));

  test('SUCCESS → succeeded', async () => {
    IP.setTransport(ok('SUCCESS'));
    assert.equal((await make().query('t')).state, 'succeeded');
  });

  test('FAILURE → failed，并带出原因', async () => {
    IP.setTransport(fakeTransport(() => ({ status: 200, body: { data: { status: 'FAILURE', error_message: '内容审核未通过' } } })));
    const r = await make().query('t');
    assert.equal(r.state, 'failed');
    assert.match(r.failReason, /内容审核/);
  });

  test('未知状态按"进行中"处理，**不**当失败（误判失败会诱导用户重复付费）', async () => {
    IP.setTransport(ok('SOMETHING_NEW'));
    const r = await make().query('t');
    assert.equal(r.state, 'queued');
    assert.equal(r.rawStatus, 'SOMETHING_NEW');
  });

  test('PROCESSING → running', async () => {
    IP.setTransport(ok('PROCESSING'));
    assert.equal((await make().query('t')).state, 'running');
  });

  test('PENDING → queued', async () => {
    IP.setTransport(ok('PENDING'));
    assert.equal((await make().query('t')).state, 'queued');
  });

  test('终态带回 data.usage，且只保留数字（不做任何折算）', async () => {
    IP.setTransport(ok('SUCCESS', { usage: { credits: 3, cost: '1.5', currency: 'CNY', note: 'x' } }));
    const r = await make().query('t');
    assert.equal(r.state, 'succeeded');
    assert.equal(r.usage.credits, 3);
    assert.equal(r.usage.cost, 1.5);
    /* 非数字字段（currency / note）被丢弃：界面只显示服务商结算的数字，
       保留 "CNY" 这种字符串会让前端以为可以自己拼价格 */
    assert.equal(r.usage.note, undefined);
    assert.equal(r.usage.currency, undefined);
    assert.equal(Object.keys(r.usage).sort().join(','), 'cost,credits');
  });

  test('没有 usage 时是 null（界面只在服务商已结算时显示扣费）', async () => {
    IP.setTransport(ok('SUCCESS'));
    assert.equal((await make().query('t')).usage, null);
  });
});

/* ============================================================
   6. 凭据边界：密钥只进不出
   ============================================================ */
describe('凭据边界', () => {
  test('未配置密钥时不发任何请求，直接给 config 错', async () => {
    const t = fakeTransport(() => ({ status: 200, body: { data: { id: 'x' } } }));
    IP.setTransport(t);
    const p = IP.makeImageProvider({});
    const r = await p.submit('p');
    assert.equal(r.kind, 'config');
    assert.equal(t.calls.length, 0);
    assert.equal(p.configured(), false);
  });

  test('status() 不回传密钥或其片段', async () => {
    const p = make();
    const s = p.status();
    assert.equal(s.configured, true);
    const dump = JSON.stringify(s);
    assert.doesNotMatch(dump, new RegExp(KEY));
    assert.doesNotMatch(dump, /wf_test/);
    assert.equal(s.model, 'workfisher-image-g-v2.5-flare');
  });

  test('apiKey 支持函数形态（桌面版密钥运行期可变，不能快照）', async () => {
    const t = fakeTransport(() => ({ status: 200, body: { data: { id: 'x' } } }));
    IP.setTransport(t);
    let cur = '';
    const p = IP.makeImageProvider({ apiKey: () => cur });
    assert.equal(p.configured(), false);
    cur = KEY;
    assert.equal((await p.submit('p')).taskId, 'x');
    assert.equal(t.calls[0].headers['Authorization'], 'Bearer ' + KEY);
  });

  test('非 https 的 base 被拒（防链路中间人替换"任务在哪"）', async () => {
    const t = fakeTransport(() => ({ status: 200, body: {} }));
    IP.setTransport(t);
    const p = make({ baseUrl: 'http://api.work-fisher.com' });
    const r = await p.submit('p');
    assert.equal(r.kind, 'config');
    assert.equal(t.calls.length, 0);
  });

  test('空提示词 / 全空白在本地就拒绝，不花服务商一次往返', async () => {
    const t = fakeTransport(() => ({ status: 200, body: {} }));
    IP.setTransport(t);
    const p = make();
    assert.equal((await p.submit('')).kind, 'config');
    assert.equal((await p.submit('   \n\t ')).kind, 'config');
    assert.equal(t.calls.length, 0);
  });
});

/* ============================================================
   7. 脱敏工具（唯一出口）
   ============================================================ */
describe('脱敏', () => {
  test('Bearer 令牌被替换', () => {
    assert.equal(IP.redact('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer <redacted>');
  });
  test('签名类查询参数被替换', () => {
    const out = IP.redact('https://cdn.example.com/a.png?token=SECRET&expires=123');
    assert.doesNotMatch(out, /SECRET/);
    assert.match(out, /token=<redacted>/);
  });
  test('普通文本不被改动', () => {
    assert.equal(IP.redact('任务已排队'), '任务已排队');
  });
});

describe('状态码映射表', () => {
  test('与 ERR 的语义对齐', () => {
    assert.equal(IP.kindOfStatus(401), 'auth');
    assert.equal(IP.kindOfStatus(402), 'no_credit');
    assert.equal(IP.kindOfStatus(429), 'ratelimit');
    assert.equal(IP.kindOfStatus(500), 'upstream');
  });
});
