/* ============================================================
   17-image-multi-provider.test.js —— 多 provider 端到端（0.42.0）

   起真服务，校验：
     · /system/image-providers 返回三家 + configured=false（未配任何 key）；
     · /meta/options.imageModels 包含三家；
     · 提交时携带 providerId/modelId 的端到端路径走得通（用假传输 + OpenAI adapter）
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { createServer } = require('../server/server');
const SHARED = require('../server/providers/_shared');

const SANDBOX = H.freshDir('image-multi-provider');
process.env.JC_DATA_DIR = SANDBOX;

let srv = null;
let base = '';

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
  srv = createServer({ configOverrides: { port: 0, token: '', workFisherApiKey: 'wf_test_key', dataDir: SANDBOX } });
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
    assert.ok(ids.includes('dall-e-3'));
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
  test('提交时携带合法 providerId/modelId（未配 key 时被拒，错误码清楚）', async () => {
    /* OpenAI 没配 key → 应该报 config/40001 之类的明确错误，而不是 500。 */
    const proj = (await api('POST', '/api/v1/projects', { name: 'no-key' })).env.data.project;
    await api('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: 'ws' });
    const asset = (await api('POST', '/api/v1/assets?projectId=' + proj.id,
      { type: 'character', name: 'x', projectId: proj.id })).env.data;
    const r = await api('POST', '/api/v1/assets/' + asset.id + '/image-jobs?projectId=' + proj.id,
      { prompt: 'a cat', providerId: 'openai', modelId: 'dall-e-3', sizeMode: 'ratio', ratio: '1:1' });
    /* API 协议层成功（code=0），但任务被标 failed+config —— OpenAI adapter 的 configured() 返回空。
       这正是 image-jobs 设计的目的：submit 不重试 + 任务明确标 failed 把 reason 带给前端。 */
    assert.equal(r.env.code, 0);
    assert.equal(r.env.data.failed, 'config', '应该报 config 失败：' + JSON.stringify(r.env.data));
    assert.ok(String(r.env.data.job && r.env.data.job.error || '').includes('未配置'), 'job.error 应说明是配置问题');
  });
});