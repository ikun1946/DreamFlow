'use strict';
/* ============================================================
   15-image-size.test.js —— 生图尺寸：校验 / 换算 / 回落 / 透传

   为什么单开一组（2026-09-25）：尺寸是**第二个"错了就花钱"的输入** ——
   提示词写错最多生成一张废图，尺寸发错要么被服务商拒绝（浪费一次往返）、
   要么被它自行调整（扣了钱拿到与预期不符的图）。所以规则集中在
   server/image-size.js 一处，这里把边界穷举掉：

     A. 纯函数：预设合法性 / 五条硬边界 / 回落保方向 / 45 组比例×分辨率全合法
     B. provider 透传：比例模式带 resolution、像素模式不带（服务商声明会忽略）
     C. 服务级：提交体落库快照 / 非法输入 40000+nearest 且**不发请求** /
        设置默认值的保存与回落

   ⚠ 全程假传输，不接真实密钥、不产生任何费用。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const H = require('./helpers');

const SANDBOX = H.freshDir('image-size');
process.env.JC_DATA_DIR = SANDBOX;

const { createServer } = require('../server/server');
const IP = require('../server/image-provider');
const SZ = require('../server/image-size');

let srv = null;
let base = '';

/* ---------------- 假 API 传输（带请求体捕获） ---------------- */
function apiTransport(script) {
  const calls = [];
  const t = {
    calls: calls,
    request(url, opts, cb) {
      const isSubmit = /\/v1\/image\/generations$/.test(url);
      let body = null;
      try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = null; }
      calls.push({ url: url, isSubmit: isSubmit, body: body });
      setImmediate(() => {
        const r = script({ url: url, isSubmit: isSubmit, body: body, n: calls.length - 1 });
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
const submitOK = () => apiTransport((c) => (c.isSubmit
  ? { body: { data: { task_id: 'tk_' + c.n } } }
  : { body: { data: { status: 'SUCCESS', result_url: 'https://cdn.example.com/r.png' } } }));

/* ---------------- HTTP 助手（与 test/12 同形） ---------------- */
async function api(method, path, body) {
  const opt = { method: method, headers: { 'content-type': 'application/json' } };
  let url = base + path;
  if (body !== undefined) {
    opt.body = JSON.stringify(body);
    if (body && body.projectId && url.indexOf('projectId=') < 0) {
      url += (url.indexOf('?') < 0 ? '?' : '&') + 'projectId=' + encodeURIComponent(body.projectId);
    }
  }
  const res = await fetch(url, opt);
  return { status: res.status, env: await res.json() };
}
const dataOf = (r) => r.env.data;

async function makeAsset(name) {
  const proj = dataOf(await api('POST', '/api/v1/projects', { name: name || '项目' })).project;
  await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: '默认分镜' });
  const asset = dataOf(await api('POST', '/api/v1/assets?projectId=' + proj.id,
    { type: 'character', name: name || '资产', projectId: proj.id }));
  return { proj: proj, asset: asset };
}

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
   A. 纯函数：规则边界（服务商文档原文的逐条翻译）
   ============================================================ */
describe('image-size：预设与边界', () => {
  test('全部内置像素预设本身合法（预设非法等于开箱即坏）', () => {
    SZ.PRESETS.forEach((p) => {
      const v = SZ.validate(p.width, p.height);
      assert.equal(v.ok, true, p.id + '（' + p.width + '×' + p.height + '）应合法：' + v.errors.join('；'));
    });
    /* 1080 不是 16 的倍数 —— 预设必须用对齐值，这里钉死防止有人"顺手改回 1080" */
    assert.equal(SZ.validate(1920, 1080).ok, false);
    assert.equal(SZ.validate(1920, 1088).ok, true);
  });

  test('validate：五条硬边界逐条命中', () => {
    assert.match(SZ.validate(1000, 1000).errors.join(), /16 的倍数/);
    assert.match(SZ.validate(4000, 4000).errors.join(), /总像素/);          // 双 4000 超总像素
    /* 4000×288 = 115.2 万像素在总像素区间内，命中的是单边超限 + 比例超限（13.89:1） */
    assert.match(SZ.validate(4000, 288).errors.join(), /单边/);
    assert.match(SZ.validate(4000, 288).errors.join(), /3:1/);
    assert.match(SZ.validate(100, 100).errors.join(), /不能低于/);
    /* 恰好 3:1 是合法边界 —— errors 必须为空；下一行 3.84:1 才是超比例 */
    assert.equal(SZ.validate(3840, 1280).ok, true);
    assert.deepEqual(SZ.validate(3840, 1280).errors, []);
    assert.match(SZ.validate(3840, 1000).errors.join(), /3:1/);             // 超比例
    assert.match(SZ.validate(100.5, 1000).errors.join(), /整数/);
    assert.equal(SZ.validate(655360 / 3840 | 0, 0).ok, false);               // 高为 0 拒绝
  });

  test('nearest：回落保住方向与比例意图，且结果必合法', () => {
    const cases = [
      [5000, 500, 'landscape'],   // 极端横条 → 钳到 3:1 内、保持横向
      [100, 1920, 'portrait'],    // 极端竖条 → 保持纵向
      [1920, 1080, 'landscape'],  // 1080 不是 16 倍数 → 对齐到 1088
      [4000, 4000, 'square-ish'], // 超上限 → 缩到合法
      [100, 100, 'any']           // 过小 → 放大到下限
    ];
    cases.forEach(([w, h]) => {
      const n = SZ.nearest(w, h);
      assert.ok(n && n.width >= SZ.LIMITS.min && n.height >= SZ.LIMITS.min, w + '×' + h + ' 回落必须存在');
      assert.equal(SZ.validate(n.width, n.height).ok, true, w + '×' + h + ' → ' + n.width + '×' + n.height + ' 必须合法');
      const wantLandscape = w >= h;
      const gotLandscape = n.width >= n.height;
      if (Math.abs(w / h - 1) > 0.2) assert.equal(gotLandscape, wantLandscape, '方向必须保留');
      assert.ok(Math.max(n.width, n.height) / Math.min(n.width, n.height) <= SZ.LIMITS.maxRatio + 1e-9, '长宽比必须 ≤3:1');
    });
  });

  test('ratioToSize：15 比例 × 3 档分辨率共 45 组全部合法', () => {
    let total = 0;
    SZ.RATIOS.forEach((r) => {
      SZ.RESOLUTIONS.forEach((res) => {
        const s = SZ.ratioToSize(r.id, SZ.pixelsOfResolution(res));
        total++;
        const chk = SZ.validate(s.width, s.height);
        assert.equal(chk.ok, true, r.id + '@' + res + ' → ' + s.width + '×' + s.height + '：' + chk.errors.join('；'));
      });
    });
    assert.equal(total, 45);
    /* 未知比例拒绝 */
    assert.equal(SZ.ratioToSize('7:3', 2073600), null);
  });

  test('sizeToRatio 反算：2% 容差内命中枚举，偏离即自定义', () => {
    assert.equal(SZ.sizeToRatio(1920, 1088), '16:9');
    assert.equal(SZ.sizeToRatio(1664, 1248), '4:3');
    assert.equal(SZ.sizeToRatio(1440, 1440), '1:1');
    assert.equal(SZ.sizeToRatio(1000, 300), null);   // 3.33:1，偏离枚举 >2%
  });

  test('resolveSize：三条路径与错误携带 nearest', () => {
    const a = SZ.resolveSize({ mode: 'ratio', ratio: '16:9', resolution: '2k' });
    assert.equal(a.ok, true); assert.equal(a.size, '16:9'); assert.equal(a.resolution, '2k');
    const b = SZ.resolveSize({ mode: 'pixels', width: 1920, height: 1088 });
    assert.equal(b.ok, true); assert.equal(b.size, '1920x1088'); assert.equal(b.ratio, '16:9');
    const c = SZ.resolveSize({ mode: 'pixels', width: 1920, height: 1080 });
    assert.equal(c.ok, false);
    assert.equal(c.nearest.width, 1920); assert.equal(c.nearest.height, 1088);
    const d = SZ.resolveSize({ mode: 'ratio', ratio: 'auto' });
    assert.equal(d.ok, true); assert.equal(d.size, 'auto');
    /* 什么都不给 = auto（老客户端兼容） */
    const e = SZ.resolveSize({});
    assert.equal(e.ok, true); assert.equal(e.size, 'auto');
    assert.equal(SZ.resolveSize({ mode: 'ratio', ratio: '7:3' }).ok, false);
  });
});

/* ============================================================
   B. provider 透传：请求体形状
   ============================================================ */
describe('image-provider：size/resolution 透传', () => {
  test('比例模式：body.size=枚举 且带 resolution', async () => {
    const t = submitOK(); IP.setTransport(t);
    const p = IP.makeImageProvider({ apiKey: 'k' }, {});
    await p.submit('p', { size: '16:9', resolution: '2k' });
    const body = t.calls[0].body;
    assert.equal(body.size, '16:9');
    assert.equal(body.resolution, '2k');
  });

  test('像素模式：body.size=WxH 且**不发** resolution（服务商声明会忽略它）', async () => {
    const t = submitOK(); IP.setTransport(t);
    const p = IP.makeImageProvider({ apiKey: 'k' }, {});
    await p.submit('p', { size: '1920x1088', resolution: null });
    const body = t.calls[0].body;
    assert.equal(body.size, '1920x1088');
    assert.equal(body.resolution, undefined);
  });

  test('不带尺寸：只带 resolution（与 0.40.0 之前行为一致）', async () => {
    const t = submitOK(); IP.setTransport(t);
    const p = IP.makeImageProvider({ apiKey: 'k' }, {});
    await p.submit('p', {});
    const body = t.calls[0].body;
    assert.equal(body.size, undefined);
    assert.equal(body.resolution, '1k');
  });
});

/* ============================================================
   C. 服务级：提交落库 / 校验拒绝 / 设置默认值
   ============================================================ */
describe('服务级：尺寸快照与校验', () => {
  test('比例模式提交：任务快照带 size/resolution，透传到服务商请求体', async () => {
    const t = submitOK(); IP.setTransport(t);
    const { proj, asset } = await makeAsset('尺寸比例');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: '雪地少年', sizeMode: 'ratio', ratio: '16:9', resolution: '2k', projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.size, '16:9');
    assert.equal(r.env.data.job.resolution, '2k');
    assert.equal(t.calls[0].body.size, '16:9');
    assert.equal(t.calls[0].body.resolution, '2k');
  });

  test('像素模式提交：size=WxH 落库，服务商请求体不带 resolution', async () => {
    const t = submitOK(); IP.setTransport(t);
    const { proj, asset } = await makeAsset('尺寸像素');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: '雪地少年', sizeMode: 'pixels', width: 1920, height: 1088, projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.size, '1920x1088');
    assert.equal(t.calls[0].body.size, '1920x1088');
    assert.equal(t.calls[0].body.resolution, undefined);
  });

  test('非法像素（1920×1080）：40001 + nearest，且**没有**发出任何服务商请求', async () => {
    const t = submitOK(); IP.setTransport(t);
    const { proj, asset } = await makeAsset('尺寸非法');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: '雪地少年', sizeMode: 'pixels', width: 1920, height: 1080, projectId: proj.id });
    assert.equal(r.env.code, 40001);
    assert.match(r.env.message, /尺寸不合法/);
    assert.equal(r.env.data.nearest.width, 1920);
    assert.equal(r.env.data.nearest.height, 1088);
    assert.equal(t.calls.length, 0, '校验必须发生在计费提交之前');
  });

  test('未知比例：40001，不发请求', async () => {
    const t = submitOK(); IP.setTransport(t);
    const { proj, asset } = await makeAsset('未知比例');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: 'p', sizeMode: 'ratio', ratio: '7:3', projectId: proj.id });
    assert.equal(r.env.code, 40001);
    assert.equal(t.calls.length, 0);
  });

  test('老客户端（只发 prompt）：照常提交，size=auto 落库', async () => {
    const t = submitOK(); IP.setTransport(t);
    const { proj, asset } = await makeAsset('老客户端');
    const r = await api('POST', `/api/v1/assets/${asset.id}/image-jobs`,
      { prompt: 'p', projectId: proj.id });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.size, 'auto');
    assert.equal(r.env.data.job.resolution, '1k');
  });
});

describe('服务级：生图尺寸默认值（imageDefaults）', () => {
  test('GET /settings 缺省即给内置默认（16:9 · 1k），前端不必自己兜底', async () => {
    const { proj } = await makeAsset('默认值项目');
    const st = dataOf(await api('GET', '/api/v1/settings?projectId=' + proj.id));
    assert.equal(st.imageDefaults.sizeMode, 'ratio');
    assert.equal(st.imageDefaults.ratio, '16:9');
    assert.equal(st.imageDefaults.resolution, '1k');
  });

  test('PUT imageDefaults 像素模式：合法值原样保存、非法值回落并在响应里说明', async () => {
    const { proj } = await makeAsset('保存默认');
    /* 非法：1920×1080 → 回落 1920×1088，adjustments 明确回传（不静默改） */
    const bad = await api('PUT', '/api/v1/settings?projectId=' + proj.id,
      { imageDefaults: { sizeMode: 'pixels', width: 1920, height: 1080, resolution: '1k' } });
    assert.equal(bad.env.code, 0);
    assert.ok(Array.isArray(bad.env.data.adjustments) && bad.env.data.adjustments.length >= 1);
    assert.equal(bad.env.data.imageDefaults.width, 1920);
    assert.equal(bad.env.data.imageDefaults.height, 1088);
    assert.equal(bad.env.data.imageDefaults.ratio, null, '像素模式不该残留比例字段');

    /* 合法：比例模式保存后读回一致 */
    const good = await api('PUT', '/api/v1/settings?projectId=' + proj.id,
      { imageDefaults: { sizeMode: 'ratio', ratio: '9:16', resolution: '4k' } });
    assert.equal(good.env.code, 0);
    assert.equal(good.env.data.imageDefaults.ratio, '9:16');
    assert.equal(good.env.data.imageDefaults.resolution, '4k');
    const st = dataOf(await api('GET', '/api/v1/settings?projectId=' + proj.id));
    assert.equal(st.imageDefaults.ratio, '9:16');
    assert.equal(st.imageDefaults.width, null);
  });

  test('resetSettings 带 imageDefaults 作用域：清项目覆盖回落内置默认', async () => {
    const { proj } = await makeAsset('重置默认');
    await api('PUT', '/api/v1/settings?projectId=' + proj.id,
      { imageDefaults: { sizeMode: 'ratio', ratio: '1:1', resolution: '4k' } });
    const r = await api('POST', '/api/v1/settings/reset?projectId=' + proj.id, { scopes: ['imageDefaults'] });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.imageDefaults.ratio, '16:9');
    assert.equal(r.env.data.imageDefaults.resolution, '1k');
  });

  test('/meta/options 下发 imageSizes 规格（前端不硬编码的依据）', async () => {
    const { proj } = await makeAsset('规格项目');
    const o = dataOf(await api('GET', '/api/v1/meta/options?projectId=' + proj.id));
    assert.ok(o.imageSizes, 'imageSizes 必须存在');
    assert.ok(o.imageSizes.ratios.length >= 15);
    assert.deepEqual(o.imageSizes.resolutions, ['1k', '2k', '4k']);
    assert.equal(o.imageSizes.limits.step, 16);
    assert.equal(o.imageSizes.limits.max, 3840);
    assert.equal(o.imageSizes.limits.maxPixels, 8294400);
  });
});
