'use strict';
/* ============================================================
   14-image-credential.test.js —— 密钥不出现在任何出口（阶段 3/4 验收）

   计划 §5.3 与 §7「完成判据」各有一条硬要求：
     · 密钥不出现在页面响应、日志或仓库中；
     · 桌面版 IPC 只进不出（页面拿不回已存的密钥）。

   test/13 已经测了**保管模块**本身（落盘是密文、加密不可用不降级）。
   这里测**边界**：把密钥真的配上去，然后逐个出口去找它 ——
   HTTP 响应体、日志、以及"预加载桥面上到底暴露了哪些动作"。

   ⚠ 数据隔离：JC_DATA_DIR 指到仓库内 .test-tmp 沙箱。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('./helpers');

const SANDBOX = H.freshDir('image-credential');
process.env.JC_DATA_DIR = SANDBOX;

const { createServer } = require('../server/server');
const IP = require('../server/image-provider');

/* 一枚**独一无二**的哨兵密钥：方便在整个出口集合里做全文检索。
   刻意选一个不可能出现在代码/文档里的串，避免"本来就有"造成的假通过。 */
const SENTINEL = 'wfk_sentinel_9f3ac1_SHOULD_NEVER_LEAK';

let srv = null;
let base = '';

before(async () => {
  IP.setTransport((opts, cb) => cb({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { task_id: 'tk_probe' } })
  }));
  /* 用 configOverrides（而不是 config）—— 与 test/12 同一条路：
     走的是 loadConfig 的正常推导，端口/token 等缺省值才齐。 */
  srv = createServer({ configOverrides: { port: 0, token: '', workFisherApiKey: SENTINEL, allowFileOrigin: true } });
  const addr = await srv.start();
  base = 'http://127.0.0.1:' + addr.port;
});

/* 造一个"项目 + 默认分镜表 + 资产"。⚠ 必须先建 workspace，
   否则资产落库时缺默认分镜表会失败（test/12 的 makeAsset 同款步骤）。 */
async function makeAsset(name) {
  const proj = (await http('POST', '/api/v1/projects', { name: name || '项目' })).json.data.project;
  await http('POST', '/api/v1/projects/' + proj.id + '/workspaces', { name: '默认分镜' });
  const asset = (await http('POST', '/api/v1/assets?projectId=' + proj.id,
    { type: 'character', name: name || '资产', projectId: proj.id })).json.data;
  return { proj, asset };
}

after(async () => {
  if (srv) await srv.stop();
  H.rmrf(SANDBOX);
});

async function http(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: res.status, text, json };
}

describe('密钥边界：HTTP 出口', () => {
  test('GET /system/image-provider 不含密钥（只回配了没有）', async () => {
    const r = await http('GET', '/api/v1/system/image-provider');
    assert.equal(r.status, 200);
    assert.equal(r.json.code, 0);
    assert.equal(r.json.data.configured, true);
    assert.ok(!r.text.includes(SENTINEL), '响应体里出现了密钥');
    /* 连"疑似密钥字段"都不该有 */
    assert.equal(r.json.data.apiKey, undefined);
    assert.equal(r.json.data.key, undefined);
    assert.equal(r.json.data.workFisherApiKey, undefined);
  });

  test('取资产 / 列资产 都不含密钥', async () => {
    const { proj, asset } = await makeAsset('密钥测试');
    const one = await http('GET', '/api/v1/assets/' + asset.id + '?projectId=' + proj.id);
    const many = await http('GET', '/api/v1/assets?projectId=' + proj.id);
    assert.ok(!one.text.includes(SENTINEL));
    assert.ok(!many.text.includes(SENTINEL));
  });

  test('提交任务的响应不含密钥，也不含远端直链', async () => {
    const { proj, asset } = await makeAsset('提交测试');
    const r = await http('POST', '/api/v1/assets/' + asset.id + '/image-jobs?projectId=' + proj.id,
      { prompt: '一个测试提示词' });
    assert.ok(!r.text.includes(SENTINEL), '提交响应里出现了密钥');
    /* 远端直链同样不该出现在任何响应里（计划 §4.2） */
    const anyJob = JSON.stringify(r.json);
    assert.doesNotMatch(anyJob, /result_url|resultUrl/);
  });

  test('错误分支也不回密钥（未配/坏密钥时只给可操作提示）', async () => {
    /* 不走第二个 createServer（S.setImageJobs 是模块级单例，会被永久换掉 ——
       这是 test/12 踩过的坑）。改成直接在**服务层**用一枚无密钥的 provider 验：
       错误文案应当是可操作的"未配置 API Key"，且不含任何密钥材料。 */
    const S = require('../server/services');
    const { proj, asset } = await makeAsset('无密钥');
    const keyless = IP.makeImageProvider({ apiKey: '' }, {});
    await assert.rejects(
      () => S.submitImageJob(srv.store.load(), asset.id, { prompt: 'p' },
        { imageProvider: keyless }, { projectId: proj.id }),
      (e) => {
        assert.match(e.message, /API Key/, '应给出可操作的"未配置密钥"提示');
        assert.ok(!e.message.includes(SENTINEL), '错误信息里出现了密钥');
        return true;
      }
    );
  });

  test('日志接口（若有）不含密钥', async () => {
    const r = await http('GET', '/api/v1/system/logs');
    /* 该接口可能不存在（404）—— 存在就必须干净 */
    if (r.status === 200) assert.ok(!r.text.includes(SENTINEL));
    assert.ok(!r.text.includes(SENTINEL));
  });
});

describe('密钥边界：落盘与源码', () => {
  test('数据目录里的 db.json 不含密钥', async () => {
    const dbFile = path.join(SANDBOX, 'db.json');
    if (fs.existsSync(dbFile)) {
      const raw = fs.readFileSync(dbFile, 'utf8');
      assert.ok(!raw.includes(SENTINEL), 'db.json 里出现了密钥');
    }
    /* 整个沙箱目录扫一遍：任何文件都不该有明文密钥 */
    const stack = [SANDBOX];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        let buf;
        try { buf = fs.readFileSync(p); } catch (err) { continue; }
        assert.ok(!buf.includes(Buffer.from(SENTINEL)), '沙箱文件 ' + p + ' 出现了明文密钥');
      }
    }
  });

  test('server/ 源码里不写死任何密钥字面量', () => {
    const dir = path.join(__dirname, '..', 'server');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(src, /wf[k]?_[A-Za-z0-9]{16,}/, f + ' 里疑似写死了密钥');
      assert.ok(!src.includes(SENTINEL));
    }
  });
});

describe('密钥边界：桌面端桥面', () => {
  test('preload 只暴露写入/删除/状态，**没有** getKey', () => {
    /* 这条用**字符串检查**而不是 require：preload.js 依赖 electron，
       纯 Node 下 require 会抛。它挡的是"后来者顺手加了个 getKey"这类回归 ——
       那种改动会让"密钥只进不出"在无声中失效。 */
    const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
    assert.match(src, /imageKeyStatus:/, '应暴露 imageKeyStatus');
    assert.match(src, /imageSetKey:/, '应暴露 imageSetKey');
    assert.match(src, /imageClearKey:/, '应暴露 imageClearKey');
    assert.doesNotMatch(src, /imageGetKey/, '绝不能暴露取密钥的动作');
    /* 也不该把整个 ipcRenderer 交出去 */
    assert.doesNotMatch(src, /exposeInMainWorld\('JCDesktop',\s*ipcRenderer\s*\)/);
  });

  test('主进程 IPC 没有 getKey 通道', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    assert.match(src, /ipcMain\.handle\('image:keyStatus'/);
    assert.match(src, /ipcMain\.handle\('image:setKey'/);
    assert.match(src, /ipcMain\.handle\('image:clearKey'/);
    assert.doesNotMatch(src, /ipcMain\.handle\('image:getKey'/, '绝不能注册取密钥的通道');
  });

  test('密钥保管模块不暴露任何"整份导出"式的方法泄漏', () => {
    const mod = require('../desktop/image-key-store');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'jc-cred-'));
    const store = mod.makeImageKeyStore({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s),
        decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, '')
      },
      filePath: path.join(dir, mod.FILE_NAME)
    });
    store.setKey(SENTINEL);
    /* getKey 是给主进程注入用的，**它不该出现在 status 里** */
    const st = store.status();
    assert.ok(!JSON.stringify(st).includes(SENTINEL));
    assert.deepEqual(Object.keys(st).sort(), ['encryption', 'hasKey']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
