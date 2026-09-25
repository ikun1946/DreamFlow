'use strict';
/* ============================================================
   12-image-jobs.test.js —— 图片生图的任务与文件安全（阶段 2）

   为什么单开一组：这条链路上有三个"错了就不可回滚"的东西 ——
   **付费提交**、**外部下载的字节**、**用户的原始素材文件**。
   test/11 已经用假传输钉住了客户端的请求形状；这里钉的是**接线与副作用**：
   真起服务、真打 HTTP、真写磁盘，但传输全部是假的（不接密钥、不产生费用）。

   覆盖（对应计划 §7「自动化与隔离」）：
     · 路由与任务：跨项目访问、音频资产、空/长提示词、重复提交、提交超时、
       查询重试、重启恢复、资产删除清理、候选图清理
     · 文件安全：HTTPS 重定向到内网、非 https、HTML 假图片、过大/截断图片、
       保存失败回滚、候选文件不越界

   ⚠ 数据隔离：JC_DATA_DIR 指到仓库内 .test-tmp 沙箱（AGENTS.md 红线）。
   ⚠ 起真服务：port 0 让系统分配空闲端口。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('node:events');

const H = require('./helpers');

const SANDBOX = H.freshDir('image-jobs');
process.env.JC_DATA_DIR = SANDBOX;

const { createServer } = require('../server/server');
const IP = require('../server/image-provider');
const IJ = require('../server/image-jobs');

let srv = null;
let base = '';

/* ---------------- 假响应素材 ---------------- */
/* 一张最小合法 PNG：签名 + IHDR（64×48）+ 少量数据 */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
  (function () { const b = Buffer.alloc(8); b.writeUInt32BE(64, 0); b.writeUInt32BE(48, 4); return b; })(),
  Buffer.from([8, 6, 0, 0, 0]),
  Buffer.alloc(64, 0xAA)
]);
/* 尺寸过小（4×4）：过了签名检查但应被 MIN_DIM 拦掉 */
const TINY_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
  (function () { const b = Buffer.alloc(8); b.writeUInt32BE(4, 0); b.writeUInt32BE(4, 4); return b; })(),
  Buffer.from([8, 6, 0, 0, 0])
]);
/* 合法的最小 JPEG（120 宽 × 80 高）。
   ⚠ APP0 段必须自洽：`FF E0 <len:2>` 里的 len **包含长度字段自身**，
   所以 APP0 整段是 2(marker) + 16(len) 字节。原先的夹具只补了 8 字节负载
   却声明 16，解析器按声明跳段就会**跳过**后面的 SOF0，于是尺寸读不出来 ——
   那是夹具错，不是解析器错（解析器对合法 JPEG 是准的）。
   ⚠ SOF0 里的顺序是 **高度在前、宽度在后**（`FF C0 <len> <精度> <高:2> <宽:2>`），
   两边容易写反；下面按"先写高 80、再写宽 120"来对齐断言。 */
const JPEG = Buffer.concat([
  Buffer.from([0xFF, 0xD8]),                                    // SOI
  Buffer.from([0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF\0'), // APP0（长度声明 16）
  Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]),                     // APP0 剩余负载
  Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08]),                  // SOF0 + 精度
  (function () { const b = Buffer.alloc(4); b.writeUInt16BE(80, 0); b.writeUInt16BE(120, 2); return b; })(),
  Buffer.from([0x03]), Buffer.alloc(32, 0x11),                   // 分量数与数据
  Buffer.from([0xFF, 0xD9])                                      // EOI
]);

/* ---------------- 假 API 传输 ----------------
   ⚠ 形状必须与 image-provider.js 的默认传输层一致（单参数 cb、失败走 { error }）。 */
function apiTransport(script) {
  const calls = [];
  const t = {
    calls: calls,
    request(url, opts, cb) {
      const isSubmit = /\/v1\/image\/generations$/.test(url);
      calls.push({ url: url, isSubmit: isSubmit });
      setImmediate(() => {
        const r = script({ url: url, isSubmit: isSubmit, n: calls.length - 1 });
        if (r && r.error) return cb({ error: r.error });
        cb({
          statusCode: r.status || 200,
          headers: {},
          body: r.body === undefined ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
        });
      });
      return {};
    }
  };
  return t;
}

/* ---------------- 假下载传输 ----------------
   模拟 https.get 返回的对象：EventEmitter + destroy + 依次 emit response/data/end。 */
function downloadTransport(spec) {
  const calls = [];
  return {
    calls: calls,
    get(url, opts) { return this.request(url, opts); },
    request(url, opts) {
      calls.push(url);
      const req = new EventEmitter();
      req.destroy = function () { };
      setImmediate(() => {
        const s = typeof spec === 'function' ? spec(url, calls.length - 1) : spec;
        if (s.error) { req.emit('error', new Error(s.error)); return; }
        if (s.redirect) {
          const res = new EventEmitter();
          res.statusCode = s.status || 302;
          res.headers = { location: s.redirect };
          res.resume = function () { };
          res.destroy = function () { };
          req.emit('response', res);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = s.status || 200;
        res.headers = s.headers || { 'content-type': 'image/png' };
        res.destroy = function () { };
        req.emit('response', res);
        setImmediate(() => {
          if (s.chunks) {
            s.chunks.forEach((c) => res.emit('data', c));
          } else if (s.body !== undefined) {
            res.emit('data', Buffer.isBuffer(s.body) ? s.body : Buffer.from(s.body));
          }
          if (s.truncate) { res.emit('error', new Error('连接被重置')); return; }
          res.emit('end');
        });
      });
      return req;
    }
  };
}

/* ---------------- HTTP 小工具 ----------------
   ⚠ 作用域走**查询串**：本仓库所有资产接口的 scope 都由 URL/查询串携带
   （services.scopeOf → scopeIdsOf，唯一入口），body 里的 projectId 不参与作用域判定。
   前端 app/api.js 也是这么发的（scopeQuery() 把 projectId 拼进 query）。
   这里做个自动搬运：body 里有 projectId 就补到 query 上 —— 测试读起来仍像是
   "带 projectId 的调用"，但实际按服务端契约走。漏掉这一步，所有需要作用域的
   接口都会 40400（"素材不属于当前项目"）。 */
async function api(method, p, body) {
  const opt = { method, headers: {} };
  let url = base + p;
  if (body !== undefined && body !== null) {
    opt.body = JSON.stringify(body);
    opt.headers['Content-Type'] = 'application/json';
    if (body.projectId && url.indexOf('projectId=') < 0) {
      url += (url.indexOf('?') < 0 ? '?' : '&') + 'projectId=' + encodeURIComponent(body.projectId);
    }
  }
  const res = await fetch(url, opt);
  return { status: res.status, env: await res.json() };
}
const dataOf = (r) => r.env.data;

/* 建项目 + 资产（角色，无图）。
   作用域**两处都给**：查询串（前端 app/api.js 的 scopeQuery 走这里）+ body
   （部分接口显式读 body.projectId）。只给一处时，另一条读取路径会回落到默认
   项目上，于是"素材不属于当前项目"这类断言会连锁失败。被测的是生图链路，
   不是这种回落行为，所以两处都写、保证项目归属确定。 */
async function makeAsset(name, type) {
  const proj = dataOf(await api('POST', '/api/v1/projects', { name: name || '项目' })).project;
  await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: '默认分镜' });
  const asset = dataOf(await api('POST', '/api/v1/assets?projectId=' + proj.id,
    { type: type || 'character', name: name || '资产', projectId: proj.id }));
  return { proj: proj, asset: asset };
}

/* 一个"提交成功、查询成功、下载成功"的标准脚本 */
const happyScript = () => apiTransport((c) => (c.isSubmit
  ? { body: { data: { task_id: 'tk_ok' } } }
  : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/r.png', usage: { credits: 1 } } } }));

before(async () => {
  srv = createServer({ configOverrides: { port: 0, token: '', workFisherApiKey: 'wf_fake_key_for_tests' } });
  const addr = await srv.start();
  base = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  IP.setTransport(null);
  if (srv) await srv.stop();
  H.rmrf(SANDBOX);
});

/* ============================================================
   1. 配置状态：密钥只进不出
   ============================================================ */
describe('服务配置状态', () => {
  test('GET /system/image-provider 只回"配了没有"，不回密钥', async () => {
    const r = await api('GET', '/api/v1/system/image-provider');
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.configured, true);
    assert.equal(r.env.data.model, 'workfisher-image-g-v2.5-flare');
    const dump = JSON.stringify(r.env);
    assert.doesNotMatch(dump, /wf_fake_key_for_tests/);
    assert.equal(r.env.data.apiKey, undefined);
  });
});

/* ============================================================
   2. 提交：防重复 / 校验
   ============================================================ */
describe('提交任务', () => {
  test('提交成功 → 等到 ready，且候选图落盘、预览可读', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));

    const { proj, asset } = await makeAsset('提交成功');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: '一个少年站在雪地里', projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.created, true);
    assert.equal(r.env.data.job.state, 'ready');
    assert.equal(r.env.data.job.usage.credits, 1);
    /* 远端直链**不**交给页面（计划 §4.2：不把服务商直链交给页面） */
    assert.equal(r.env.data.job.resultUrl, undefined);
    assert.match(r.env.data.job.previewUrl, /^\/media\/candidates\//);

    /* 预览必须真能读（这条踩过：resolveServePath 少一支 → 候选图永远 404） */
    const pv = await fetch(base + r.env.data.job.previewUrl);
    assert.equal(pv.status, 200);
    assert.equal(pv.headers.get('content-type'), 'image/png');
  });

  test('同一资产重复提交被拒（不产生第二次付费提交）', async () => {
    /* 脚本停在 running：任务保持在活动态 */
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_slow' } } }
      : { body: { data: { status: 'PROCESSING' } } }));
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('重复提交');

    const first = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p1', projectId: proj.id });
    assert.equal(first.env.data.created, true);
    const submitCountAfterFirst = t.calls.filter((c) => c.isSubmit).length;

    const second = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p2', projectId: proj.id });
    assert.equal(second.env.data.created, false, '第二次必须复用活动任务而不是新建');
    assert.equal(second.env.data.job.jobId, first.env.data.job.jobId);
    assert.equal(t.calls.filter((c) => c.isSubmit).length, submitCountAfterFirst, '不得产生第二次提交');
  });

  test('带幂等键的重复提交也只会真正提交一次', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_idem' } } }
      : { body: { data: { status: 'PENDING' } } }));
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('幂等');
    const h = { 'Idempotency-Key': 'k-1' };

    /* ⚠ projectId 必须在查询串上（作用域唯一入口），原生 fetch 不会替我们搬 */
    const send = () => fetch(base + `/api/v1/assets/${asset.id}/image-jobs?projectId=${proj.id}`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, h),
      body: JSON.stringify({ prompt: 'same', projectId: proj.id })
    }).then((r) => r.json());
    const a = await send();
    const b = await send();
    assert.deepEqual(a.data, b.data, '第二次应回放第一次的响应');
    assert.equal(t.calls.filter((c) => c.isSubmit).length, 1);
  });

  test('空 / 全空白提示词被拒，且不发任何外部请求', async () => {
    const t = happyScript();
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('空提示词');

    for (const p of ['', '   ', '\n\t ']) {
      const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: p, projectId: proj.id });
      assert.notEqual(r.env.code, 0, '「' + p + '」不该被接受');
    }
    assert.equal(t.calls.length, 0, '本地就该拒绝，不该花服务商一次往返');
  });

  test('超长提示词明确报错、**不自动截断**', async () => {
    const t = happyScript();
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('长提示词');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: 'x'.repeat(10001), projectId: proj.id });
    assert.equal(r.env.code, 40001);
    assert.match(r.env.message, /10000/);
    assert.equal(t.calls.length, 0);
  });

  test('音频资产不能生图（界面隐藏只是体验，服务端也要挡）', async () => {
    const t = happyScript();
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('一段音频', 'audio');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id });
    assert.equal(r.env.code, 40001);
    assert.match(r.env.message, /只有图片资产/);
  });

  test('未配置密钥时拒绝提交（不能再花一次钱才发现）', async () => {
    /* ⚠ 这条**不能**用"再起一个 createServer"来测：services 里的 image-jobs 实例
       是**模块级单例**（setImageJobs），第二次 createServer 会把它永久换成无密钥
       的那一份，后面所有用例都会用错实例 —— 这正是本次一整片用例连锁失败的原因。
       也不走 HTTP 路由：路由在 makeRouter 时就把 adapter 闭包住了，换不掉。
       正确做法是直接在服务层验这条闸门：拿真实的资产，配一个空密钥的 provider。 */
    const S = require('../server/services');
    const { proj, asset } = await makeAsset('未配置密钥');
    const keyless = IP.makeImageProvider({ apiKey: '' }, {});
    await assert.rejects(
      () => S.submitImageJob(srv.store.load(), asset.id, { prompt: 'p' },
        { imageProvider: keyless }, { projectId: proj.id }),
      (e) => /API Key/.test(e.message)
    );
  });
});

/* ============================================================
   3. 跨项目越权
   ============================================================ */
describe('作用域（跨项目越权必须被拒）', () => {
  test('用别的 projectId 取不到该资产的生图状态', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const A = await makeAsset('甲项目');
    const B = await makeAsset('乙项目');

    await api('POST', `/api/v1/assets/${A.asset.id}/image-jobs`, { prompt: 'p', projectId: A.proj.id });

    const r = await api('GET', `/api/v1/assets/${A.asset.id}/image-jobs/current?projectId=${B.proj.id}`);
    assert.equal(r.env.code, 40400, '跨项目必须按"不存在"处理，不泄露对方是否存在');
  });

  test('用别的 projectId 采用不了该资产的任务', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const A = await makeAsset('甲采用');
    const B = await makeAsset('乙采用');

    const job = dataOf(await api('POST', `/api/v1/assets/${A.asset.id}/image-jobs`, { prompt: 'p', projectId: A.proj.id }));
    const r = await api('POST', `/api/v1/assets/${A.asset.id}/image-jobs/${job.job.jobId}/apply`, { projectId: B.proj.id });
    assert.equal(r.env.code, 40400);
  });

  test('任务的 assetId 与路径里的资产不一致时也拒绝', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const A = await makeAsset('甲匹配');
    const other = dataOf(await api('POST', '/api/v1/assets',
      { type: 'character', name: '另一个', projectId: A.proj.id }));
    const job = dataOf(await api('POST', `/api/v1/assets/${A.asset.id}/image-jobs`, { prompt: 'p', projectId: A.proj.id }));

    const r = await api('POST', `/api/v1/assets/${other.id}/image-jobs/${job.job.jobId}/apply`, { projectId: A.proj.id });
    assert.equal(r.env.code, 40400);
  });
});

/* ============================================================
   4. 提交超时 → submission_unknown（禁止自动重发）
   ============================================================ */
describe('提交超时', () => {
  test('提交超时转 submission_unknown，绝不自动重发', async () => {
    const t = apiTransport(() => ({ error: new Error('请求超时') }));
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('提交超时');

    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.state, 'submission_unknown');
    assert.match(r.env.data.job.error, /核对/);
    assert.equal(t.calls.length, 1, '超时后不得自动重发（那是第二次扣费）');
  });

  test('提交遇到 402 余额不足 → failed，可读原因带出来', async () => {
    IP.setTransport(apiTransport(() => ({ status: 402, body: { error: { message: 'insufficient balance' } } })));
    const { proj, asset } = await makeAsset('余额不足');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id });
    assert.equal(r.env.data.job.state, 'failed');
    assert.match(r.env.data.job.error, /余额不足/);
  });

  test('提交遇到 401 密钥无效 → failed，提示去配置', async () => {
    IP.setTransport(apiTransport(() => ({ status: 401, body: { message: 'invalid token' } })));
    const { proj, asset } = await makeAsset('密钥无效');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id });
    assert.equal(r.env.data.job.state, 'failed');
    assert.match(r.env.data.job.error, /API Key/);
  });
});

/* ============================================================
   5. 查询重试与重启恢复
   ============================================================ */
describe('查询重试与重启恢复', () => {
  test('查询失败不丢 task_id，后续继续查同一任务', async () => {
    let phase = 'fail';
    const t = apiTransport((c) => {
      if (c.isSubmit) return { body: { data: { task_id: 'tk_retry' } } };
      if (phase === 'fail') return { status: 500, body: { message: 'upstream busy' } };
      return { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/ok.png' } } };
    });
    IP.setTransport(t);
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));

    const { proj, asset } = await makeAsset('查询重试');
    const sub = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id });
    const jobId = sub.env.data.job.jobId;
    let cur = await api('GET', `/api/v1/assets/${asset.id}/image-jobs/current?projectId=${proj.id}`);
    assert.match(cur.env.data.job.error || '', /查询任务状态失败/);
    /* task_id 必须还在（丢了就只能重新提交 = 重复付费） */
    assert.equal(srv.imageJobs.rawJob(jobId).providerTaskId, 'tk_retry');

    phase = 'ok';
    srv.imageJobs.rawJob(jobId).updatedAt = new Date(Date.now() - 60000).toISOString();
    await srv.imageJobs.tick();

    cur = await api('GET', `/api/v1/assets/${asset.id}/image-jobs/current?projectId=${proj.id}`);
    assert.equal(cur.env.data.job.state, 'ready');
    /* 全程只提交过一次 */
    assert.equal(t.calls.filter((c) => c.isSubmit).length, 1);
    /* 查询用的是同一个 task_id */
    assert.ok(t.calls.some((c) => /tk_retry/.test(c.url)));
  });

  test('重启只恢复有 task_id 的未结束任务；submitting 无 ID 的转 submission_unknown', async () => {
    const db = srv.store.load();
    db.imageJobs = {
      ij_a: { id: 'ij_a', projectId: 'pj_x', assetId: 'as_x', state: 'running', providerTaskId: 'tk_a', createdAt: 'x', updatedAt: 'x' },
      ij_b: { id: 'ij_b', projectId: 'pj_x', assetId: 'as_y', state: 'submitting', providerTaskId: null, createdAt: 'x', updatedAt: 'x' },
      ij_c: { id: 'ij_c', projectId: 'pj_x', assetId: 'as_z', state: 'ready', providerTaskId: 'tk_c', createdAt: 'x', updatedAt: 'x' }
    };
    const rec = srv.imageJobs.reconcile(db);
    assert.equal(rec.resumed, 1, '只有 running + 有 taskId 的继续查');
    assert.equal(rec.unknown, 1, 'submitting 且无 ID 的转人工核对');
    assert.equal(db.imageJobs.ij_a.state, 'running');
    assert.equal(db.imageJobs.ij_b.state, 'submission_unknown');
    assert.equal(db.imageJobs.ij_c.state, 'ready', 'ready 不该被重启改动');
    assert.equal(db.imageJobs.ij_c.providerTaskId, 'tk_c');
    assert.equal(db.imageJobs.ij_b._busy, undefined);
    /* 清理，避免污染后续用例 */
    db.imageJobs = {};
    srv.store.saveNow();
  });

  test('放弃正在进行的任务被拒（服务商没有取消接口，不能假装已取消）', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_run' } } }
      : { body: { data: { status: 'PROCESSING' } } }));
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('放弃进行中');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const r = await api('DELETE', `/api/v1/assets/${asset.id}/image-jobs/${sub.job.jobId}`, { projectId: proj.id });
    assert.equal(r.env.code, 40900);
    assert.match(r.env.message, /服务商没有取消接口/);
  });

  test('放弃 ready 的任务会清掉候选文件', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('放弃现成');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const jobId = sub.job.jobId;
    const raw = srv.imageJobs.rawJob(jobId);
    const f = path.join(SANDBOX, 'projects', proj.id, 'image-candidates', raw.candidateFile);
    assert.ok(fs.existsSync(f), '候选图应已落盘');

    const r = await api('DELETE', `/api/v1/assets/${asset.id}/image-jobs/${jobId}`, { projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.state, 'discarded');
    assert.equal(fs.existsSync(f), false, '放弃后候选文件必须清掉');
  });
});

/* ============================================================
   6. 文件安全：下载侧
   ============================================================ */
describe('下载安全', () => {
  test('https 重定向到内网 → 拒绝（SSRF）', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_ssrf' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/r.png' } } }));
    IP.setTransport(t);
    /* 合法起点 → 302 到 127.0.0.1 */
    srv.imageJobs.setDownloadTransport(downloadTransport((url) => (url.indexOf('cdn.example.com') >= 0
      ? { redirect: 'https://127.0.0.1:8787/api/v1/projects' }
      : { body: PNG })));

    const { proj, asset } = await makeAsset('重定向内网');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.notEqual(job.state, 'ready', '绝不能落到 ready');
    assert.match(job.error || '', /本机|内网|https/);
  });

  test('结果地址不是 https → 拒绝', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_http' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'http://cdn.example.com/r.png' } } }));
    IP.setTransport(t);
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));

    const { proj, asset } = await makeAsset('http 结果');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.notEqual(job.state, 'ready');
    assert.match(job.error || '', /https/);
  });

  test('HTML 错误页（状态码 200）被识别为假图片', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_html' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/err.png' } } }));
    IP.setTransport(t);
    srv.imageJobs.setDownloadTransport(downloadTransport({
      body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      headers: { 'content-type': 'text/html' }
    }));

    const { proj, asset } = await makeAsset('HTML 假图');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.notEqual(job.state, 'ready');
    assert.match(job.error || '', /不是 PNG|HTML/);
    assert.equal(job.candidateFile, null, '绝不能留下一个"假图片"候选文件');
  });

  test('尺寸过小的图片被拒（只截到文件头的截断响应）', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_tiny' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/t.png' } } }));
    IP.setTransport(t);
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: TINY_PNG }));
    const { proj, asset } = await makeAsset('过小图');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.notEqual(job.state, 'ready');
    assert.match(job.error || '', /宽度异常|高度异常/);
  });

  test('超过字节上限的图片被拒', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_big' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/big.png' } } }));
    IP.setTransport(t);
    /* 分块推送，累计超过 MAX_DOWNLOAD_BYTES */
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 0x55)]);
    srv.imageJobs.setDownloadTransport(downloadTransport({
      chunks: Array.from({ length: 12 }, () => big)
    }));
    const { proj, asset } = await makeAsset('超大图');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.notEqual(job.state, 'ready');
    assert.match(job.error || '', /大小上限/);
  });

  test('下载中断（截断）不留候选文件', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_trunc' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/t.png' } } }));
    IP.setTransport(t);
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG.subarray(0, 6), truncate: true }));
    const { proj, asset } = await makeAsset('截断');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.notEqual(job.state, 'ready');
    assert.equal(job.candidateFile, null);
  });

  test('状态码非 200 的下载失败被如实报告', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_404' } } }
      : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/404.png' } } }));
    IP.setTransport(t);
    srv.imageJobs.setDownloadTransport(downloadTransport({ status: 404, body: 'nope' }));
    const { proj, asset } = await makeAsset('404 下载');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const job = srv.imageJobs.rawJob(sub.job.jobId);
    assert.match(job.error || '', /HTTP 404/);
  });

  test('URL 检查函数：内网 / http / 畸形地址', () => {
    assert.match(IJ.urlProblem('http://x.com/a.png'), /https/);
    assert.match(IJ.urlProblem('https://127.0.0.1/a.png'), /本机|内网/);
    assert.match(IJ.urlProblem('https://localhost/a.png'), /本机|内网/);
    assert.match(IJ.urlProblem('https://192.168.1.9/a.png'), /本机|内网/);
    assert.match(IJ.urlProblem('https://10.0.0.5/a.png'), /本机|内网/);
    assert.match(IJ.urlProblem('https://169.254.169.254/latest/meta-data'), /本机|内网/);
    assert.match(IJ.urlProblem('not a url'), /无法解析/);
    assert.equal(IJ.urlProblem('https://cdn.example.com/a.png'), null);
  });

  test('图片特征嗅探：PNG / JPEG 尺寸能读出来', () => {
    const p = IJ.sniffImage(PNG);
    assert.equal(p.format, 'png');
    assert.equal(p.width, 64);
    assert.equal(p.height, 48);
    const j = IJ.sniffImage(JPEG);
    assert.equal(j.format, 'jpeg');
    assert.equal(j.width, 120);
    assert.equal(j.height, 80);
    assert.equal(IJ.sniffImage(Buffer.from('GIF89a')), null);
    assert.equal(IJ.sniffImage(Buffer.alloc(0)), null);
  });
});

/* ============================================================
   7. 采用：顺序、回滚、引用刷新
   ============================================================ */
describe('采用结果', () => {
  test('采用换新文件名（保证浏览器缓存刷新），旧文件被清掉', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('采用换名');

    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs/${sub.job.jobId}/apply`, { projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.state, 'applied');

    const after = dataOf(await api('GET', `/api/v1/assets/${asset.id}?projectId=${proj.id}`));
    assert.match(after.url, new RegExp('^/media/assets/' + proj.id + '/' + asset.id + '-'));
    assert.equal(after.size, PNG.length);

    /* 新图能读到 */
    const pv = await fetch(base + after.url);
    assert.equal(pv.status, 200);

    /* 候选目录应已空（候选文件被清） */
    const cdir = path.join(SANDBOX, 'projects', proj.id, 'image-candidates');
    const left = fs.existsSync(cdir) ? fs.readdirSync(cdir) : [];
    assert.equal(left.length, 0, '采用后候选文件必须清掉');
  });

  test('采用会把引用该资产的分镜标脏（缩略图要刷新）', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('标脏');

    /* 工作区列表回的是 { project, list, total } —— 不是 workspaces */
    const ws = dataOf(await api('GET', `/api/v1/projects/${proj.id}/workspaces`)).list[0];
    const sb = dataOf(await api('POST', `/api/v1/workspaces/${ws.id}/storyboards?projectId=${proj.id}`,
      { prompt: '镜头一', projectId: proj.id }));
    await api('POST', `/api/v1/storyboards/${sb.id}/assets?projectId=${proj.id}`,
      { assetId: asset.id, role: 'character', projectId: proj.id });

    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs/${sub.job.jobId}/apply`, { projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.impact.count, 1, '影响范围要如实回报（界面据此提示）');

    const db = srv.store.load();
    const shot = db.storyboards.find((s) => s.id === sb.id);
    assert.equal(shot.dirty, true, '引用它的分镜必须被标脏');
  });

  test('采用失败（候选文件已被清理）时原图保持不变', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('原图不变');

    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const jobId = sub.job.jobId;
    const raw = srv.imageJobs.rawJob(jobId);
    const before = dataOf(await api('GET', `/api/v1/assets/${asset.id}?projectId=${proj.id}`));

    /* 手动删掉候选文件，模拟"被有界清理回收了" */
    fs.unlinkSync(path.join(SANDBOX, 'projects', proj.id, 'image-candidates', raw.candidateFile));

    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs/${jobId}/apply`, { projectId: proj.id });
    assert.equal(r.env.code, 40900);

    const after = dataOf(await api('GET', `/api/v1/assets/${asset.id}?projectId=${proj.id}`));
    assert.equal(after.url, before.url, '原图 URL 必须一个字节都不动');
    assert.equal(after.size, before.size);
  });

  test('采用后原始素材文件仍可打开（原图→新图是"写入后替换"，不是"先删后写"）', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('顺序安全');

    /* 先给资产放一张"原图"。⚠ projectId 走查询串（作用域唯一入口），不放请求头 —— 
       头部里的自定义字段服务端不读。 */
    const imgBody = Buffer.concat([PNG, Buffer.alloc(8, 0x01)]);
    const up = await fetch(base + `/api/v1/assets/${asset.id}/file?filename=orig.png&projectId=${proj.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: imgBody
    });
    assert.equal(up.status, 200);
    assert.equal((await up.json()).code, 0, '原图上传必须成功（否则这条用例测不到"先写后删"）');
    const withImg = dataOf(await api('GET', `/api/v1/assets/${asset.id}?projectId=${proj.id}`));
    const oldUrl = withImg.url;
    assert.ok(oldUrl, '原图应已就位');
    const oldPath = path.join(SANDBOX, 'projects', proj.id, 'assets', path.basename(oldUrl));
    assert.ok(fs.existsSync(oldPath));

    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs/${sub.job.jobId}/apply`, { projectId: proj.id });
    assert.equal(r.env.code, 0);

    const after = dataOf(await api('GET', `/api/v1/assets/${asset.id}?projectId=${proj.id}`));
    assert.notEqual(after.url, oldUrl, 'url 必须换名');
    assert.equal(fs.existsSync(oldPath), false, '旧文件在落库成功后才清');
    assert.equal((await fetch(base + after.url)).status, 200);
  });

  test('采用一个非 ready 的任务被拒', async () => {
    const t = apiTransport((c) => (c.isSubmit
      ? { body: { data: { task_id: 'tk_nr' } } }
      : { body: { data: { status: 'PROCESSING' } } }));
    IP.setTransport(t);
    const { proj, asset } = await makeAsset('非 ready 采用');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs/${sub.job.jobId}/apply`, { projectId: proj.id });
    assert.equal(r.env.code, 40900);
    assert.match(r.env.message, /可采用/);
  });
});

/* ============================================================
   8. 清理：资产删除 / 项目 / 孤儿候选文件
   ============================================================ */
describe('清理', () => {
  test('删除资产会一并清掉它的生图任务与候选文件', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('删资产');

    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    const jobId = sub.job.jobId;
    const raw = srv.imageJobs.rawJob(jobId);
    const f = path.join(SANDBOX, 'projects', proj.id, 'image-candidates', raw.candidateFile);
    assert.ok(fs.existsSync(f));

    const del = await api('DELETE', `/api/v1/assets/${asset.id}?projectId=${proj.id}`);
    assert.equal(del.env.code, 0);
    assert.equal(srv.imageJobs.rawJob(jobId), null, '任务记录必须被清掉');
    assert.equal(fs.existsSync(f), false, '候选文件必须被清掉');
  });

  test('孤儿候选文件被有界清理，且绝不动 assets / output', async () => {
    const { proj } = await makeAsset('孤儿清理');
    const cdir = path.join(SANDBOX, 'projects', proj.id, 'image-candidates');
    fs.mkdirSync(cdir, { recursive: true });
    const orphan = path.join(cdir, 'as_orphan-0000.png');
    fs.writeFileSync(orphan, PNG);
    /* 放一个用户素材，确认清理不会碰它 */
    const adir = path.join(SANDBOX, 'projects', proj.id, 'assets');
    fs.mkdirSync(adir, { recursive: true });   // 目录可能还没被任何写入创建过
    fs.writeFileSync(path.join(adir, 'as_user.png'), PNG);

    const r = srv.imageJobs.gcCandidates(srv.store.load());
    assert.ok(r.removed >= 1);
    assert.equal(fs.existsSync(orphan), false, '无引用的候选文件应被删');
    assert.ok(fs.existsSync(path.join(adir, 'as_user.png')), '用户素材绝不能被清');

    /* 引用中的候选文件必须保留 */
    const dir2 = path.join(SANDBOX, 'projects', proj.id, 'image-candidates');
    fs.mkdirSync(dir2, { recursive: true });
    const kept = path.join(dir2, 'as_kept-1111.png');
    fs.writeFileSync(kept, PNG);
    const db = srv.store.load();
    db.imageJobs['ij_keep'] = {
      id: 'ij_keep', projectId: proj.id, assetId: 'as_kept', state: 'ready',
      candidateFile: 'as_kept-1111.png', createdAt: 'x', updatedAt: 'x'
    };
    srv.store.saveNow();
    srv.imageJobs.gcCandidates(srv.store.load());
    assert.ok(fs.existsSync(kept), '仍被任务引用的候选文件不能被清');

    delete db.imageJobs['ij_keep'];
    srv.store.saveNow();
  });

  test('候选目录里的非法文件名不会被越界读取', async () => {
    const { proj } = await makeAsset('越界');
    /* resolveServePath 是路径安全的唯一入口，直接钉它 */
    const P = require('../server/paths');
    assert.equal(P.resolveServePath('/media/candidates/' + proj.id + '/../../db.json'), null);
    assert.equal(P.resolveServePath('/media/candidates/' + proj.id + '/a/b.png'), null);
    assert.equal(P.resolveServePath('/media/candidates/' + proj.id), null);
    assert.equal(P.resolveServePath('/media/candidates/..%2F..%2F/' + proj.id), null);
    /* 合法形状返回绝对路径 */
    const ok = P.resolveServePath('/media/candidates/' + proj.id + '/as_x-abc.png');
    assert.ok(ok && ok.endsWith('as_x-abc.png'));
  });
});

/* ============================================================
   9. current 接口语义
   ============================================================ */
describe('current 接口', () => {
  test('没有任务时返回 job=null（不是 404）', async () => {
    const { proj, asset } = await makeAsset('无任务');
    const r = await api('GET', `/api/v1/assets/${asset.id}/image-jobs/current?projectId=${proj.id}`);
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job, null);
    assert.equal(r.env.data.active, false);
  });

  test('已放弃的任务不再是 active，但仍可查到（留痕）', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('放弃后查询');
    const sub = dataOf(await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p', projectId: proj.id }));
    await api('DELETE', `/api/v1/assets/${asset.id}/image-jobs/${sub.job.jobId}`, { projectId: proj.id });

    const r = await api('GET', `/api/v1/assets/${asset.id}/image-jobs/current?projectId=${proj.id}`);
    assert.equal(r.env.data.active, false);
    assert.equal(r.env.data.job.state, 'discarded');
  });

  test('任务列表接口按资产返回全部历史', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('历史列表');
    await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p1', projectId: proj.id });
    /* 放弃后即可再提交 */
    const all = dataOf(await api('GET', `/api/v1/assets/${asset.id}/image-jobs?projectId=${proj.id}`)).jobs;
    await api('DELETE', `/api/v1/assets/${asset.id}/image-jobs/${all[0].jobId}`, { projectId: proj.id });
    await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: 'p2', projectId: proj.id });

    const r = await api('GET', `/api/v1/assets/${asset.id}/image-jobs?projectId=${proj.id}`);
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.jobs.length, 2);
  });
});

/* ============================================================
   10. 持久化边界：密钥与远端直链不入库
   ============================================================ */
describe('持久化边界', () => {
  test('db.json 里不出现密钥、鉴权头或远端直链', async () => {
    IP.setTransport(happyScript());
    srv.imageJobs.setDownloadTransport(downloadTransport({ body: PNG }));
    const { proj, asset } = await makeAsset('落库边界');
    await api('POST', `/api/v1/assets/${asset.id}/image-jobs`, { prompt: '一段不该被删的提示词', projectId: proj.id });
    srv.store.flush();

    const raw = fs.readFileSync(path.join(SANDBOX, 'db.json'), 'utf8');
    assert.doesNotMatch(raw, /wf_fake_key_for_tests/, '密钥绝不能进 db.json');
    assert.doesNotMatch(raw, /Bearer /, '鉴权头绝不能进 db.json');
    assert.doesNotMatch(raw, /cdn\.example\.com/, '远端直链绝不能进 db.json（约 24 小时就失效）');
    /* 提示词快照是要留的（审计需要） */
    assert.match(raw, /一段不该被删的提示词/);
  });

  test('schemaVersion 已是 4 且 imageJobs 存在', async () => {
    const db = srv.store.load();
    assert.equal(db.schemaVersion, 4);
    assert.equal(typeof db.imageJobs, 'object');
    assert.ok(!Array.isArray(db.imageJobs));
  });
});
