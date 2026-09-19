'use strict';
/* ============================================================
   project-isolation.test.js —— 多项目隔离的端到端测试
   运行：node --test server/project-isolation.test.js

   覆盖指令 §56 要求的全部隔离类用例：
     project isolation / workspace isolation / shared project assets /
     cross-project bind rejection / auto-match isolation / auto-match ambiguity /
     delete protection / record snapshot
   另补两项本次审计新发现的漏洞：
     幂等键作用域（同一把 key 打不同项目不得回放）/ getProgress 归属校验

   ⚠ 走的是**真实路由 + 真实 services**，不是只调内部函数：
     store.load 被换成返回内存假库，store 的落盘/日志副作用被换成空实现，
     因此全程不碰 server/data/db.json（与 2026-09-18 那次数据事故同型的防护）。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const store = require('./store');
let DB = null;
store.load = () => DB;          // 路由里的 store.load() 全部指向内存假库
store.pushLog = () => {};
store.save = () => {};
store.saveNow = () => {};
store.flush = () => {};

const { makeRouter } = require('./routes');
const P = require('./projects');
const REC = require('./records');

const adapter = {
  resolveMaxConcurrency: async () => ({ max: 0, source: 'none(不限制)' }),
  dreamina: {
    peek: () => ({ available: true, credit: 9999 }),
    lastProbe: () => ({ available: true, credit: 9999 }),
    probe: async () => ({ available: true, credit: 9999 }),
    buildSubmitArgs: () => ({ args: ['text2video'], notes: [] })
  }
};
const dispatch = makeRouter({ idempotencyTtlMs: 60000, uploadMaxBytes: 1024 * 1024, projectId: 'pj_1' }, adapter);

/* ---------------- 极简 req/res 桩：够 readBody 与 ok() 用 ----------------
   ⚠ content-type 必须给对：readBody 靠它区分「JSON 请求体」与「原始字节上传」，
   不给就会把 JSON 当二进制塞进 body，表现为所有字段都是 undefined。 */
function mockReq(method, url, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  const isBuf = Buffer.isBuffer(body);
  req.headers = Object.assign(
    { host: 'localhost', 'content-type': isBuf ? 'application/octet-stream' : 'application/json' },
    headers || {}
  );
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined && body !== null) {
      req.emit('data', isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}
function mockRes() {
  const res = { statusCode: 0, headers: null, raw: '' };
  res.setHeader = () => {};
  res.writeHead = (code, h) => { res.statusCode = code; res.headers = h; };
  res.end = (b) => { res.raw = b ? String(b) : ''; };
  res.destroy = () => {};
  return res;
}
/* ⚠ 必须像 server/index.js 那样把 dispatch 包在 try/catch 里并交给 fail() ——
   路由本身不吞异常（ApiError 是抛出来的，由 index.js 统一转成 {code} 信封）。
   不包的话测试里拿到的是异常而不是业务错误码，断言全都会以"抛错"的形式失败。 */
const { fail } = require('./util');
async function call(method, path, body, headers) {
  const res = mockRes();
  const pathname = decodeURIComponent(path.split('?')[0]);
  try {
    await dispatch(mockReq(method, path, body, headers), res, pathname);
  } catch (e) {
    fail(res, e);
  }
  const json = JSON.parse(res.raw || '{}');
  return json;
}
const dataOf = async (m, p, b, h) => {
  const j = await call(m, p, b, h);
  assert.equal(j.code, 0, m + ' ' + p + ' 应成功，实际 code=' + j.code + ' msg=' + j.message);
  return j.data;
};
const codeOf = async (m, p, b, h) => (await call(m, p, b, h)).code;

/* ---------------- 假库 ---------------- */
function emptyFixture() {
  return {
    schemaVersion: 2,
    projects: [], workspaces: [], storyboards: [], assets: [],
    settings: {
      delimiter: { type: 'custom', value: ';;' },
      defaults: { model: 'seedance2.0fast_vip', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' },
      queue: { concurrency: 2, autoRetry: false, maxRetry: 2 },
      adapter: { dreaminaAvailable: true, dreaminaVersion: '1.4.18' }
    },
    seq: 0, idempotency: {}, cliJobs: {}, logs: {}, records: [], recordSeq: 0
  };
}
/* 直接往假库里塞素材（夹具构造，非被测路径）。
   url 为 null 表示"提示词资产"，不占参考图名额，也不涉及磁盘文件。 */
function seedAsset(db, projectId, name, type, id) {
  db.assets.push({
    id: id || ('as_' + Math.random().toString(36).slice(2, 8)),
    projectId, name, type, prompt: '', url: null, thumbUrl: null,
    width: 0, height: 0, size: 0, tags: [], createdAt: new Date().toISOString(), gradSeedKey: 'x', origin: 'prompt'
  });
  return db.assets[db.assets.length - 1];
}

/* 建立指令 §57 要求的验收场景：
     Project A → Workspace A1 / A2     Project B → Workspace B1 */
async function buildScenario() {
  DB = emptyFixture();
  const A = await dataOf('POST', '/projects', { name: '项目A' });
  const B = await dataOf('POST', '/projects', { name: '项目B' });
  const A2 = await dataOf('POST', '/projects/' + A.project.id + '/workspaces', { name: '第11-20集' });
  const A1 = A.workspace;          // 创建项目时自动建的「默认页面」
  const B1 = B.workspace;
  return { A: A.project, B: B.project, A1, A2, B1 };
}

/* ============================================================
   1. Workspace 隔离：A1 的分镜在 A2 不可见（指令 §59）
   ============================================================ */
test('workspace isolation：A1 的分镜在 A2 不可见，在 B 也不可见', async () => {
  const { A, B, A1, A2, B1 } = await buildScenario();

  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A1-01 的提示词' });
  assert.equal(sb.workspaceId, A1.id, '分镜归属必须落在请求的工作区');
  assert.equal(sb.projectId, A.id, '冗余 projectId 必须与工作区所属项目一致');

  const inA1 = await dataOf('GET', '/workspaces/' + A1.id + '/storyboards');
  assert.equal(inA1.total, 1, 'A1 自己看得到');
  assert.equal(inA1.list[0].id, sb.id);

  const inA2 = await dataOf('GET', '/workspaces/' + A2.id + '/storyboards');
  assert.equal(inA2.total, 0, 'A2 看不到 A1 的分镜');

  const inB1 = await dataOf('GET', '/workspaces/' + B1.id + '/storyboards');
  assert.equal(inB1.total, 0, 'B1 看不到 A 的分镜');

  /* 按 id 直取也必须被拦（不能靠"猜不到 id"当隔离） */
  assert.equal(await codeOf('GET', '/storyboards/' + sb.id + '?workspaceId=' + A2.id), 40400, '用 A2 的作用域取 A1 的分镜必须 404');
  assert.equal(await codeOf('GET', '/storyboards/' + sb.id + '?workspaceId=' + B1.id), 40400, '跨项目按 id 直取必须 404');
  assert.equal((await dataOf('GET', '/storyboards/' + sb.id + '?workspaceId=' + A1.id)).id, sb.id, '本工作区内按 id 直取正常');
});

/* ============================================================
   2. Project 隔离：A 的资产在 B 不可见（指令 §58）
   ============================================================ */
test('project isolation：A 的资产在 B 不可见', async () => {
  const { A, B } = await buildScenario();
  seedAsset(DB, A.id, '测试角色A', 'character');
  seedAsset(DB, B.id, '测试角色B', 'character');

  const inA = await dataOf('GET', '/projects/' + A.id + '/assets?type=character');
  assert.deepEqual(inA.library.map((a) => a.name), ['测试角色A'], 'A 只应看到自己的资产');

  const inB = await dataOf('GET', '/projects/' + B.id + '/assets?type=character');
  assert.deepEqual(inB.library.map((a) => a.name), ['测试角色B'], 'B 只应看到自己的资产');

  /* 旧式扁平路径 + projectId 查询串 —— 这正是"后端按 projectId 查询"的入口（指令 §29） */
  const flatA = await dataOf('GET', '/assets?type=character&projectId=' + A.id);
  assert.deepEqual(flatA.library.map((a) => a.name), ['测试角色A']);
});

/* ============================================================
   3. 同项目内资产共享：A1 创建 → A2 可见可用（指令 §58）
   ============================================================ */
test('shared project assets：A1 建的资产 A2 也能看到并用', async () => {
  const { A, A1, A2 } = await buildScenario();
  const asset = seedAsset(DB, A.id, '共享角色', 'character');

  const seenByA2 = await dataOf('GET', '/projects/' + A.id + '/assets?type=character');
  assert.equal(seenByA2.library.length, 1, '同项目的另一个工作区应看到同一份资产库');

  /* A2 的分镜要能真的绑上它 */
  const sb = await dataOf('POST', '/workspaces/' + A2.id + '/storyboards', { prompt: 'A2 的分镜' });
  await dataOf('POST', '/storyboards/' + sb.id + '/assets?workspaceId=' + A2.id, { assetId: asset.id, role: 'character' });
  const full = await dataOf('GET', '/storyboards/' + sb.id + '?workspaceId=' + A2.id);
  assert.equal(full.assets.length, 1, 'A2 应能用 A 的资产');
  assert.equal(full.assets[0].assetId, asset.id);
});

/* ============================================================
   4. 跨项目绑定必须拒绝（指令 §43）
   ============================================================ */
test('cross-project bind rejection：A 的分镜绑 B 的资产必须被拒，且不写入', async () => {
  const { A, B, A1 } = await buildScenario();
  const assetB = seedAsset(DB, B.id, 'B 的角色', 'character');
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A1 的分镜' });

  const code = await codeOf('POST', '/storyboards/' + sb.id + '/assets?workspaceId=' + A1.id, { assetId: assetB.id, role: 'character' });
  assert.equal(code, 40400, '跨项目绑定必须 404');

  const after = DB.storyboards.find((s) => s.id === sb.id);
  assert.equal(after.assets.length, 0, '被拒后不得留下任何绑定（不是"先写后报错"）');
});

test('跨项目操作资产（改名 / 换文件 / 删除）同样被拒', async () => {
  const { B } = await buildScenario();
  const assetB = seedAsset(DB, B.id, 'B 的角色', 'character');
  assert.equal(await codeOf('PATCH', '/assets/' + assetB.id + '?projectId=' + 'pj_不存在', { name: 'x' }), 40400);
  assert.equal(await codeOf('DELETE', '/assets/' + assetB.id + '?projectId=' + 'pj_不存在'), 40400);
  assert.ok(DB.assets.some((a) => a.id === assetB.id), '被拒的删除不得真的删掉资产');
});

/* ============================================================
   5. 自动匹配：只扫当前项目（指令 §40）
   ============================================================ */
test('auto-match isolation：只扫当前项目，别的项目的同名素材不会被绑上', async () => {
  const { A, B, A1 } = await buildScenario();
  const assetB = seedAsset(DB, B.id, '林晚', 'character');   // 只有 B 有「林晚」
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: '出场人物：林晚走进房间' });

  const prev = await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + A1.id, { ids: [sb.id], apply: false });
  assert.equal(prev.stats.bound, 0, 'A 里没有「林晚」→ 不该命中 B 的那一份');
  assert.equal(prev.stats.storyboards, 1);
  /* 注意：无命中的分镜**仍会出现一行**（noMatch=true，预览要能告诉用户"这条没匹配到"），
     所以这里不能断言 rows.length===0 —— 要断言的是"没有任何一行打算绑 B 的素材"。 */
  const allToBind = prev.rows.flatMap((r) => r.toBind);
  assert.equal(allToBind.length, 0, '不得有任何待绑定项');
  assert.equal(allToBind.some((m) => m.assetId === assetB.id), false, '绝不能绑到别的项目的素材');
  assert.equal(prev.rows[0].noMatch, true, '应如实报告"没有匹配"');

  // 给 A 也加一个同名素材 → 这时才应该命中，且命中的是 A 自己的
  const assetA = seedAsset(DB, A.id, '林晚', 'character');
  const prev2 = await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + A1.id, { ids: [sb.id], apply: false });
  assert.equal(prev2.stats.bound, 1, 'A 自己的素材应命中');
  assert.equal(prev2.rows[0].toBind[0].assetId, assetA.id, '必须命中本项目的那一份，而不是 B 的');
  assert.notEqual(prev2.rows[0].toBind[0].assetId, assetB.id);
});

/* ============================================================
   6. 自动匹配歧义：同名同类型多个 → ambiguous，不绑（指令 §41）
   ============================================================ */
test('auto-match ambiguity：同项目内同名同类型多个素材 → 报歧义且不自动绑定', async () => {
  const { A, A1 } = await buildScenario();
  const a1 = seedAsset(DB, A.id, '男主.png', 'character');
  const a2 = seedAsset(DB, A.id, '男主_三视图.png', 'character');
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: '出场人物：男主推开门' });

  const prev = await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + A1.id, { ids: [sb.id], apply: false });
  assert.equal(prev.stats.ambiguous, 2, '两个候选都算歧义');
  assert.equal(prev.stats.bound, 0, '歧义时一个都不绑');
  const row = prev.rows.find((r) => r.id === sb.id);
  assert.ok(row, '预览里必须出现这一行（不能让候选凭空消失）');
  assert.equal(row.toBind.length, 0, '不得静默挑一个绑上');
  assert.deepEqual(row.ambiguous.map((m) => m.assetId).sort(), [a1.id, a2.id].sort());
  // 旧前端不认 ambiguous 字段，靠 rivals 兜底展示，不能出现"预览里少了几项却无说明"
  assert.equal(row.rivals.length, 2, '歧义候选也要出现在 rivals 里，保证旧界面可见');

  // apply 之后库里也必须是空的
  await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + A1.id, { ids: [sb.id], apply: true });
  assert.equal(DB.storyboards.find((s) => s.id === sb.id).assets.length, 0, '歧义候选不得被绑定');
});

/* ============================================================
   7. 删除保护：有活动任务时禁止删除（指令 §48/§66）
   ============================================================ */
test('delete protection：存在活动任务时，工作区与项目删除都必须被拒', async () => {
  const { A, A1 } = await buildScenario();
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: '排队中的分镜' });
  sb.status = 'queued';                                   // 模拟已提交进队列
  DB.storyboards.find((s) => s.id === sb.id).status = 'queued';

  assert.equal(await codeOf('DELETE', '/workspaces/' + A1.id), 40900, '工作区删除必须被拒');
  assert.equal(await codeOf('DELETE', '/projects/' + A.id), 40900, '项目删除必须被拒');
  assert.ok(DB.workspaces.some((w) => w.id === A1.id), '被拒的删除不得真的删掉工作区');
  assert.ok(DB.projects.some((p) => p.id === A.id), '被拒的删除不得真的删掉项目');

  // 任务进入终态后即可删
  DB.storyboards.find((s) => s.id === sb.id).status = 'failed';
  const del = await dataOf('DELETE', '/workspaces/' + A1.id);
  assert.equal(del.softDeleted, true, '任务结束后应可软删除');
  const w = DB.workspaces.find((x) => x.id === A1.id);
  assert.ok(w.deletedAt, '必须是软删除（打 deletedAt 标记）');
  assert.ok(w.name, '底层数据不得被物理销毁');
});

test('delete protection：CLI 任务停在 submitting 也算活动任务', async () => {
  const { A, A1 } = await buildScenario();
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'x' });
  DB.cliJobs[sb.id] = { engine: 'dreamina', state: 'submitting', projectId: A.id, workspaceId: A1.id };
  assert.equal(await codeOf('DELETE', '/workspaces/' + A1.id), 40900, '已派发但未拿到终态时不得删除');
});

/* ============================================================
   8. 软删除语义（指令 §44/§45/§46/§64）
   ============================================================ */
test('软删除工作区：不影响项目资产、记录，也不影响同项目其它工作区', async () => {
  const { A, A1, A2 } = await buildScenario();
  const asset = seedAsset(DB, A.id, '项目资产', 'character');
  const sb2 = await dataOf('POST', '/workspaces/' + A2.id + '/storyboards', { prompt: 'A2 的分镜' });

  await dataOf('DELETE', '/workspaces/' + A1.id);

  const list = await dataOf('GET', '/projects/' + A.id + '/workspaces');
  assert.deepEqual(list.list.map((w) => w.id), [A2.id], '被软删的工作区默认不出现在列表里');
  assert.ok(DB.assets.some((a) => a.id === asset.id), '删工作区**不得**删除项目资产（指令 §46）');
  const still = await dataOf('GET', '/workspaces/' + A2.id + '/storyboards');
  assert.equal(still.total, 1, 'A2 不受影响');
  assert.equal(still.list[0].id, sb2.id);
});

test('不能删除项目下最后一个工作区（避免项目进入"没有页面可用"的死角）', async () => {
  const { B, B1 } = await buildScenario();
  assert.equal(await codeOf('DELETE', '/workspaces/' + B1.id), 40900, '最后一个工作区不得删除');
});

/* ============================================================
   9. Record 快照：改名/软删后旧记录仍显示生成时的名称（指令 §47）
   ============================================================ */
test('record snapshot：工作区改名并软删后，旧记录仍显示生成时的名称', async () => {
  const { A, A1, A2 } = await buildScenario();
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: '要生成的分镜' });
  const sbObj = DB.storyboards.find((s) => s.id === sb.id);

  // 用真实的 snapshot 落一条记录（模拟生成结束）
  const rec = REC.snapshot(DB, sbObj, { action: 'generate', outcome: 'succeeded' });
  DB.records.unshift(rec);
  assert.equal(rec.workspaceName, A1.name, '记录里必须有生成时刻的工作区名');
  assert.equal(rec.projectName, A.name, '记录里必须有生成时刻的项目名');
  assert.ok(rec.storyboardTitle, '记录里必须有分镜标题快照');

  // 改名 + 软删工作区
  await dataOf('PATCH', '/workspaces/' + A1.id, { name: '改过名的页面' });
  await dataOf('DELETE', '/workspaces/' + A1.id);

  const list = await dataOf('GET', '/records?projectId=' + A.id);
  assert.equal(list.list.length, 1, '记录必须保留（软删不清历史）');
  assert.equal(list.list[0].workspaceName, A1.name, '仍显示**生成时**的名字，不是改名后的');
  assert.equal(list.list[0].projectName, A.name);

  const detail = await dataOf('GET', '/records/' + rec.id + '?projectId=' + A.id);
  assert.equal(detail.workspaceName, A1.name, '详情同样用快照名');
});

test('记录按项目隔离：B 看不到 A 的记录，也不能按 id 直取', async () => {
  const { A, B, A1 } = await buildScenario();
  const sb = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'x' });
  const rec = REC.snapshot(DB, DB.storyboards.find((s) => s.id === sb.id), { outcome: 'succeeded' });
  DB.records.unshift(rec);

  const inA = await dataOf('GET', '/records?projectId=' + A.id);
  assert.equal(inA.list.length, 1);
  const inB = await dataOf('GET', '/records?projectId=' + B.id);
  assert.equal(inB.list.length, 0, 'B 不该看到 A 的记录');
  assert.equal(await codeOf('GET', '/records/' + rec.id + '?projectId=' + B.id), 40400, '跨项目按 id 直取必须 404');
});

/* ============================================================
   10. 本次审计新发现的漏洞：幂等键作用域 + getProgress 归属
   ============================================================ */
test('幂等键作用域：同一把 Idempotency-Key 打不同项目不得回放对方的响应', async () => {
  const { A, B, A1, B1 } = await buildScenario();
  const sbA = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A 的' });
  const sbB = await dataOf('POST', '/workspaces/' + B1.id + '/storyboards', { prompt: 'B 的' });

  const H = { 'idempotency-key': 'same-key-123' };
  const r1 = await dataOf('POST', '/storyboards/batch-submit?workspaceId=' + A1.id, { ids: [sbA.id], dryRun: true }, H);
  const r2 = await dataOf('POST', '/storyboards/batch-submit?workspaceId=' + B1.id, { ids: [sbB.id], dryRun: true }, H);

  assert.deepEqual(r1.accepted.map((x) => x.id), [sbA.id]);
  assert.deepEqual(r2.accepted.map((x) => x.id), [sbB.id], 'B 的请求必须真的执行，而不是回放 A 的响应');
  assert.notDeepEqual(r1, r2, '两个项目的响应不得相同（原实现会因为键里没有作用域而回放）');

  // 同一作用域 + 同一把 key 仍然要幂等（连点吸收）
  const r3 = await dataOf('POST', '/storyboards/batch-submit?workspaceId=' + A1.id, { ids: [sbA.id], dryRun: true }, H);
  assert.deepEqual(r3, r1, '同一作用域内重复投递仍应回放第一次的响应');
});

test('getProgress 归属校验：传别的项目的分镜 id 不得返回任何数据', async () => {
  const { A, B, A1, B1 } = await buildScenario();
  const sbA = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A 的' });
  DB.storyboards.find((s) => s.id === sbA.id).dirty = true;

  const mine = await dataOf('GET', '/storyboards/progress?ids=' + sbA.id + '&workspaceId=' + A1.id);
  assert.equal(mine.length, 1, '本工作区内应能读到');

  const foreign = await dataOf('GET', '/storyboards/progress?ids=' + sbA.id + '&workspaceId=' + B1.id);
  assert.equal(foreign.length, 0, '用别的项目的作用域读同一个 id 必须拿不到（原实现只按 id 查）');
});

/* ============================================================
   11. 向后兼容：升级前的调用方式必须继续可用
   ============================================================ */
test('向后兼容：旧式扁平路径与 /projects/:id/storyboards 仍可用', async () => {
  DB = emptyFixture();
  /* 模拟升级后的真实库：迁移创建的旧项目 pj_1 + 旧工作区 ws_1 */
  const schema = require('./schema');
  DB.projects.push({
    id: schema.LEGACY_PROJECT_ID, name: schema.LEGACY_PROJECT_NAME, description: '', settings: {},
    defaultWorkspaceId: schema.LEGACY_WORKSPACE_ID,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', deletedAt: null
  });
  DB.workspaces.push({
    id: schema.LEGACY_WORKSPACE_ID, projectId: schema.LEGACY_PROJECT_ID, name: schema.LEGACY_WORKSPACE_NAME,
    description: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', deletedAt: null
  });
  DB.storyboards.push({
    id: 'st_old', projectId: schema.LEGACY_PROJECT_ID, workspaceId: schema.LEGACY_WORKSPACE_ID, seq: 1,
    prompt: '旧分镜', status: 'draft', model: 'seedance2.0fast_vip', durationSec: 5, ratio: '16:9',
    resolution: '720p', assets: [], dirty: true
  });

  // 升级前前端就是这样调的：/projects/pj_1/storyboards
  const viaPrefix = await dataOf('GET', '/projects/' + schema.LEGACY_PROJECT_ID + '/storyboards?page=1&pageSize=50');
  assert.equal(viaPrefix.total, 1, '带项目前缀的旧路径必须仍能取到数据');
  assert.equal(viaPrefix.list[0].id, 'st_old');

  // 更老的扁平路径
  const flat = await dataOf('GET', '/storyboards');
  assert.equal(flat.total, 1, '完全扁平的老路径也必须仍可用');

  // 旧式 /settings 也必须返回升级前形状的对象（前端读 delimiter/defaults/queue）
  const st = await dataOf('GET', '/settings');
  assert.ok(st.delimiter && st.defaults && st.queue, '/settings 的形状不能变');

  // /meta/options 的项目名必须来自真实项目，而不是模块级常量
  const meta = await dataOf('GET', '/meta/options');
  assert.equal(meta.projectName, schema.LEGACY_PROJECT_NAME, '项目名要来自数据');
  assert.equal(meta.project.id, schema.LEGACY_PROJECT_ID);
  assert.equal(meta.workspace.id, schema.LEGACY_WORKSPACE_ID);
});

/* ============================================================
   12. 项目设置分层（指令 §15.3）
   ============================================================ */
test('设置分层：项目级默认值只影响本项目，queue 保持系统级', async () => {
  const { A, B, A1, B1 } = await buildScenario();

  // 只改 A 的默认模型（不传 delimiter / queue）—— 顺便验证"部分提交不丢键"
  await dataOf('PUT', '/settings?projectId=' + A.id, { defaults: { model: 'seedance2.5' } });

  const stA = await dataOf('GET', '/settings?projectId=' + A.id);
  assert.equal(stA.defaults.model, 'seedance2.5', 'A 的项目级默认值应生效');
  assert.equal(stA.defaults.ratio, '16:9', '未提交的键必须保留（原实现会整体覆盖导致丢键）');
  assert.ok(stA.defaults.durationSec != null, 'durationSec 不得变成 undefined');
  assert.ok(stA.queue.autoRetry !== undefined, 'queue 子对象不得被整体覆盖掉键');

  const stB = await dataOf('GET', '/settings?projectId=' + B.id);
  assert.equal(stB.defaults.model, 'seedance2.0fast_vip', 'B 不应受 A 的设置影响');
});

test('设置写入白名单：不可写的顶层键被丢弃并如实回报（防止借 PUT 改写项目集合）', async () => {
  const { A } = await buildScenario();
  const before = DB.projects.length;
  const out = await dataOf('PUT', '/settings?projectId=' + A.id, {
    defaults: { durationSec: 6 },
    projects: [{ id: 'pj_hack', name: '注入的项目' }],
    workspaces: [{ id: 'ws_hack' }]
  });
  assert.deepEqual(out.ignored.sort(), ['projects', 'workspaces'], '必须回报被忽略的键');
  assert.equal(DB.projects.length, before, '请求体里的 projects 绝不能落库');
  assert.equal(DB.projects.some((p) => p.id === 'pj_hack'), false);
  assert.equal(DB.workspaces.some((w) => w.id === 'ws_hack'), false);
});

test('保存设置只同步本项目分镜的参数（原来会把所有项目的分镜一起改）', async () => {
  const { A, B, A1, B1 } = await buildScenario();
  const sbA = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A 的' });
  const sbB = await dataOf('POST', '/workspaces/' + B1.id + '/storyboards', { prompt: 'B 的' });

  await dataOf('PUT', '/settings?projectId=' + A.id, { defaults: { model: 'seedance2.5' } });

  assert.equal(DB.storyboards.find((s) => s.id === sbA.id).model, 'seedance2.5', 'A 的分镜应被对齐');
  assert.equal(DB.storyboards.find((s) => s.id === sbB.id).model, 'seedance2.0fast_vip', 'B 的分镜不得被动');
});

/* ============================================================
   13. 分镜序号按工作区独立
   ============================================================ */
test('序号按工作区独立：两个页面的分镜不会互相插队', async () => {
  const { A1, A2 } = await buildScenario();
  const a1 = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A1 第一条' });
  const a2 = await dataOf('POST', '/workspaces/' + A2.id + '/storyboards', { prompt: 'A2 第一条' });
  assert.equal(a1.seq, 1, 'A1 的第一条应是 1');
  assert.equal(a2.seq, 1, 'A2 的第一条也应是 1（而不是接着 A1 数下去）');

  const a1b = await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'A1 第二条' });
  assert.equal(a1b.seq, 2, 'A1 的第二条应是 2');
});

/* ============================================================
   14. 导入的重复检测只在本工作区内
   ============================================================ */
test('导入预览：别的工作区用过的提示词不算重复', async () => {
  const { A1, A2 } = await buildScenario();
  await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: '同一段提示词' });

  const inA1 = await dataOf('POST', '/storyboards/import/preview?workspaceId=' + A1.id, { rawText: '同一段提示词', delimiter: { type: 'custom', value: ';;' } });
  assert.equal(inA1.warnings.filter((w) => w.code === 'DUPLICATE').length, 1, '本工作区内应判为重复');

  const inA2 = await dataOf('POST', '/storyboards/import/preview?workspaceId=' + A2.id, { rawText: '同一段提示词', delimiter: { type: 'custom', value: ';;' } });
  assert.equal(inA2.warnings.filter((w) => w.code === 'DUPLICATE').length, 0, '别的页面的内容不该算重复（原实现扫全库）');
});

/* ============================================================
   15. Project 列表与计数
   ============================================================ */
test('项目列表：软删的不出现，计数正确', async () => {
  const { A, B, A1, A2 } = await buildScenario();
  seedAsset(DB, A.id, '资产1', 'character');
  seedAsset(DB, A.id, '资产2', 'scene');
  await dataOf('POST', '/workspaces/' + A1.id + '/storyboards', { prompt: 'x' });

  const list = await dataOf('GET', '/projects');
  assert.equal(list.total, 2);
  const pa = list.list.find((p) => p.id === A.id);
  assert.equal(pa.counts.workspaces, 2, 'A 有 2 个工作区');
  assert.equal(pa.counts.assets, 2, 'A 有 2 个资产');
  assert.equal(pa.counts.storyboards, 1, 'A 有 1 个分镜');

  await dataOf('DELETE', '/projects/' + B.id);
  const list2 = await dataOf('GET', '/projects');
  assert.equal(list2.total, 1, '软删的项目不出现在列表里');
  assert.ok(DB.projects.some((p) => p.id === B.id), '但底层数据仍在');
});
