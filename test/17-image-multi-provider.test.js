/* ============================================================
   17-image-multi-provider.test.js —— 多 provider 端到端（0.42.0）

   起真服务，校验：
     · /system/image-providers 返回三家，只有 OpenAI configured=true；
     · /meta/options.imageModels 包含三家；
     · 提交时携带 providerId/modelId 的端到端路径走得通（用假传输 + OpenAI adapter）
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { createServer } = require('../server/server');
const SHARED = require('../server/providers/_shared');
const { makeImageProvider } = require('../server/image-provider');
const fs = require('fs');
const path = require('path');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
  (function () { const b = Buffer.alloc(8); b.writeUInt32BE(64, 0); b.writeUInt32BE(48, 4); return b; })(),
  Buffer.from([8, 6, 0, 0, 0]), Buffer.alloc(64, 0xAA)
]);

const SANDBOX = H.freshDir('image-multi-provider');
process.env.JC_DATA_DIR = SANDBOX;

let srv = null;
let base = '';
let wfKeyEnabled = false;

async function api(method, p, body) {
  const opt = { method, headers: {} };
  let url = base + p;
  if (body !== undefined && body !== null) {
    opt.body = JSON.stringify(body);
    opt.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, opt);
  return { status: res.status, env: await res.json() };
}

before(async () => {
  /* ★ 0.42.0 修复：dataDir 必须显式指到沙箱，否则 createServer 退回到 server/data（污染真实数据）。
     与 test/12 / test/14 同样的隔离模式（参 AGENTS.md「测试的数据隔离铁律」）。
     ⚠ 同一个 node 进程下其它 test 文件可能更早 require('server/runtime')，使 ENV_DATA_DIR
     已被缓存为其它值（甚至 CLI_DEFAULT_DATA_DIR = server/data）。runtime.configure() 显式
     覆盖一次；这与 cfg.dataDir 覆盖同步生效在 store 上。 */
  const runtimeMod = require('../server/runtime');
  runtimeMod.configure({ dataDir: SANDBOX });
  srv = createServer({ configOverrides: { port: 0, token: '', dataDir: SANDBOX,
    imageKeyProvider: (id) => id === 'openai' ? 'openai_test_key' :
      (id === 'work-fisher' && wfKeyEnabled ? 'wf_test_key' : '') } });
  const addr = await srv.start();
  base = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  SHARED.setTransport(null);
  if (srv) await srv.stop();
  H.rmrf(SANDBOX);
});

describe('多 provider · HTTP 端点', () => {
  test('GET /system/image-providers 返回三家 + configured 标记', async () => {
    const r = await api('GET', '/api/v1/system/image-providers');
    assert.equal(r.env.code, 0);
    const ids = r.env.data.map((p) => p.providerId).sort();
    assert.deepEqual(ids, ['openai', 'stability', 'work-fisher']);
    /* 三个 provider 都列出 configured 字段（即便未配） */
    r.env.data.forEach((p) => {
      assert.equal(typeof p.configured, 'boolean', p.providerId + ' configured 必填');
      assert.ok(Array.isArray(p.models) && p.models.length > 0, p.providerId + ' models 非空');
    });
    assert.equal(r.env.data.find((p) => p.providerId === 'openai').configured, true);
    assert.equal(r.env.data.find((p) => p.providerId === 'work-fisher').configured, false);
  });
  test('GET /system/image-provider（旧端点）仍可访问（兼容默认 provider 状态）', async () => {
    const r = await api('GET', '/api/v1/system/image-provider');
    assert.equal(r.env.code, 0);
    /* 配置了 workFisherApiKey 的话 configured=true */
    if (r.env.data.configured) assert.equal(r.env.data.provider, 'work-fisher');
  });
  test('GET /meta/options 包含 imageModels 数组', async () => {
    /* meta 端点需要项目作用域；与 test/15 一致用 ?projectId=<proj> */
    const proj = (await api('POST', '/api/v1/projects', { name: 'meta-proj' })).env.data.project;
    const r = await api('GET', '/api/v1/meta/options?projectId=' + proj.id);
    assert.equal(r.env.code, 0);
    assert.ok(Array.isArray(r.env.data.imageModels), 'imageModels 必下发');
    assert.ok(r.env.data.imageModels.length >= 3, '至少三家');
    const ids = r.env.data.imageModels.map((m) => m.modelId).sort();
    assert.ok(ids.includes('workfisher-image-g-v2.5-flare'));
    assert.ok(ids.includes('gpt-image-2.5-flare'));
    assert.ok(ids.includes('stable-image-core'));
  });
  test('imageSizes（旧字段）也保留：默认 model 的 sizeSpec', async () => {
    const proj = (await api('POST', '/api/v1/projects', { name: 'meta-proj-2' })).env.data.project;
    const r = await api('GET', '/api/v1/meta/options?projectId=' + proj.id);
    assert.ok(r.env.data.imageSizes, 'imageSizes 兼容字段保留');
    assert.ok(Array.isArray(r.env.data.imageSizes.ratios));
  });
});

describe('多 provider · 提交体校验', () => {
  test('提交时携带未知 providerId → 40001', async () => {
    /* 服务层会校验：未知 provider → "未知的生图服务商：xxx" 错误。 */
    const proj = (await api('POST', '/api/v1/projects', { name: 'bad-provider' })).env.data.project;
    await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: 'ws' });
    const asset = (await api('POST', '/api/v1/assets?projectId=' + proj.id,
      { type: 'character', name: 'x', projectId: proj.id })).env.data;
    const r = await api('POST', '/api/v1/assets/' + asset.id + '/image-jobs?projectId=' + proj.id,
      { prompt: 'a cat', providerId: 'nope', modelId: 'nope', sizeMode: 'ratio', ratio: '1:1' });
    assert.notEqual(r.env.code, 0, '未知 provider 应被拒');
    assert.ok(String(r.env.data && r.env.data.message || JSON.stringify(r.env)).includes('nope'));
  });
  test('只配 OpenAI Key 时可提交并保存候选图', async () => {
    const proj = (await api('POST', '/api/v1/projects', { name: 'openai-only' })).env.data.project;
    await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: 'ws' });
    const asset = (await api('POST', '/api/v1/assets?projectId=' + proj.id,
      { type: 'character', name: 'x', projectId: proj.id })).env.data;
    SHARED.setTransport({ request(url, opts, cb) {
      assert.match(url, /api\.openai\.com\/v1\/images\/generations/);
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'gpt-image-2.5-flare');
      assert.equal(body.response_format, undefined);
      assert.equal(body.size, '1024x1024');
      cb({ statusCode: 200, headers: {}, body: JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) });
    } });
    const r = await api('POST', '/api/v1/assets/' + asset.id + '/image-jobs?projectId=' + proj.id,
      { prompt: 'a cat', providerId: 'openai', modelId: 'gpt-image-2.5-flare', sizeMode: 'ratio', ratio: '1:1' });
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.job.state, 'ready', JSON.stringify(r.env.data));
    assert.ok(r.env.data.job.previewUrl);
    const dbText = fs.readFileSync(path.join(SANDBOX, 'db.json'), 'utf8');
    assert.ok(!dbText.includes(PNG.toString('base64')), '生成图片的 base64 不能落库');
    SHARED.setTransport(null);
  });
  test('未配置的 Work Fisher 应在付费提交前被拒', async () => {
    const proj = (await api('POST', '/api/v1/projects', { name: 'no-wf-key' })).env.data.project;
    await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: 'ws' });
    const asset = (await api('POST', '/api/v1/assets?projectId=' + proj.id,
      { type: 'character', name: 'x', projectId: proj.id })).env.data;
    const r = await api('POST', '/api/v1/assets/' + asset.id + '/image-jobs?projectId=' + proj.id,
      { prompt: 'a cat', providerId: 'work-fisher', modelId: 'workfisher-image-g-v2.5-flare', ratio: '1:1' });
    assert.notEqual(r.env.code, 0);
    assert.match(JSON.stringify(r.env), /未配置 work-fisher/);
  });
  test('选 Sunburst 时实际请求也必须是 Sunburst', async () => {
    wfKeyEnabled = true;
    const proj = (await api('POST', '/api/v1/projects', { name: 'sunburst-route' })).env.data.project;
    await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: 'ws' });
    const asset = (await api('POST', '/api/v1/assets?projectId=' + proj.id,
      { type: 'character', name: 'x', projectId: proj.id })).env.data;
    let sentModel = null;
    SHARED.setTransport({ request(url, opts, cb) {
      if (opts.method === 'POST') {
        sentModel = JSON.parse(opts.body).model;
        return cb({ statusCode: 200, headers: {}, body: JSON.stringify({ task_id: 'mock_task_1' }) });
      }
      cb({ statusCode: 200, headers: {}, body: JSON.stringify({ status: 'queued' }) });
    } });
    try {
      const r = await api('POST', '/api/v1/assets/' + asset.id + '/image-jobs?projectId=' + proj.id,
        { prompt: 'a cat', providerId: 'work-fisher', modelId: 'workfisher-image-g-v2.5-sunburst', ratio: '1:1' });
      assert.equal(r.env.code, 0);
      assert.equal(sentModel, 'workfisher-image-g-v2.5-sunburst');
    } finally {
      srv.imageJobs.stopTimer();
      SHARED.setTransport(null);
      wfKeyEnabled = false;
    }
  });
});

describe('Stability 适配器 · 官方表单契约', () => {
  test('Ultra 使用 multipart 表单，并读取内联图片', async () => {
    const adapter = makeImageProvider({ apiKey: 'stability_test_key' },
      { providerId: 'stability', modelId: 'stable-image-ultra' });
    SHARED.setTransport({ request(url, opts, cb) {
      assert.match(url, /\/stable-image\/generate\/ultra$/);
      assert.match(opts.headers['Content-Type'], /^multipart\/form-data; boundary=/);
      assert.equal(opts.headers.Accept, 'application/json');
      assert.ok(Buffer.isBuffer(opts.body));
      assert.match(opts.body.toString('utf8'), /name="aspect_ratio"\r\n\r\n9:16/);
      assert.match(opts.body.toString('utf8'), /name="prompt"\r\n\r\na cat/);
      cb({ statusCode: 200, headers: {}, body: JSON.stringify({ image: PNG.toString('base64') }) });
    } });
    try {
      const result = await adapter.submit('a cat', { size: '9:16' });
      assert.equal(result.syncInlineBase64, PNG.toString('base64'));
      assert.equal(result.syncResult, true);
    } finally { SHARED.setTransport(null); }
  });
});
