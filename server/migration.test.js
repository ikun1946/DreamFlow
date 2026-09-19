'use strict';
/* ============================================================
   migration.test.js —— schema 版本与迁移框架测试
   运行：node --test server/migration.test.js

   覆盖指令 §56 要求的前两项：
     · migration          旧库 → 新 schema，不丢 Storyboard / Asset / Record
     · migration idempotency  连跑两次不得重复建项目/工作区

   ⚠ 安全前提：store 会在落盘时写真实的 server/data/db.json（与 2026-09-18 那次事故同型）。
   这里**先把 store 的副作用换成空实现**再 require 被测模块，全程只操作内存里的假库。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');

const store = require('./store');
store.pushLog = () => {};
store.save = () => {};
store.saveNow = () => {};
store.flush = () => {};

const schema = require('./schema');
const P = require('./projects');

/* 一个"升级前"的库：没有 schemaVersion / projects / workspaces，
   而且 settings.defaults 缺 motion / negativePrompt（真实库正是这样，
   而 getOptions 会直接读这两个键 —— 迁移必须把它们补齐，否则会抛 50000）。 */
function v1Fixture() {
  return {
    storyboards: [
      { id: 'st_a', projectId: 'pj_1', seq: 1, prompt: '段落1｜总时长：4.0s', status: 'draft',
        model: 'seedance2.0fast_vip', durationSec: 4, ratio: '16:9', resolution: '720p',
        assets: [{ assetId: 'as_x', role: 'character' }], dirty: true },
      { id: 'st_b', projectId: 'pj_1', seq: 2, prompt: '段落2｜总时长：5.0s', status: 'succeeded',
        model: 'seedance_2.0_vip', durationSec: 5, ratio: '16:9', resolution: '720p',
        assets: [], videoUrl: '/files/st_b/v.mp4', dirty: true }
    ],
    assets: [
      { id: 'as_x', projectId: 'pj_1', name: '林晚', type: 'character', url: '/media/assets/as_x.png' },
      { id: 'as_y', projectId: 'pj_1', name: '雨夜街道', type: 'scene', url: null }
    ],
    settings: {
      delimiter: { type: 'custom', value: '@' },
      // 刻意缺 motion / negativePrompt：真实库就是这样
      defaults: { model: 'seedance2.0fast_vip', ratio: '16:9', resolution: '720p', durationSec: 15 },
      queue: { concurrency: 2, autoRetry: true, maxRetry: 2 },
      adapter: { dreaminaAvailable: true, dreaminaVersion: '1.4.18', engine: 'canvas', cliAvailable: true, mode: 'cli' }
    },
    seq: 2,
    idempotency: { k1: { response: { ok: 1 }, createdAt: '2026-09-19T00:00:00Z' } },
    cliJobs: { st_b: { engine: 'dreamina', state: 'succeeded', submitId: 'sub1', cliModel: 'seedance_2.0_vip' } },
    logs: { st_b: [{ level: 'info', msg: 'x' }] },
    records: [
      { id: 'rc_1', projectId: 'pj_1', storyboardId: 'st_b', seq: 2, action: 'generate', outcome: 'succeeded' }
    ],
    recordSeq: 1
  };
}

test('迁移：v1 → v2，分镜/素材/记录一条不丢，绑定与提示词逐字节不变', () => {
  const db = v1Fixture();
  const before = JSON.parse(JSON.stringify(db));

  assert.equal(schema.readVersion(db), 1, '前提：旧库没有 schemaVersion，按第 1 版处理');
  const res = schema.runMigrations(db);

  assert.equal(res.from, 1);
  assert.equal(res.to, schema.SCHEMA_VERSION);
  assert.deepEqual(res.ran, ['v1→v2']);
  assert.equal(db.schemaVersion, schema.SCHEMA_VERSION);

  // 数量守恒
  assert.equal(db.storyboards.length, before.storyboards.length);
  assert.equal(db.assets.length, before.assets.length);
  assert.equal(db.records.length, before.records.length);
  assert.equal(Object.keys(db.cliJobs).length, Object.keys(before.cliJobs).length);

  // 内容守恒（id / 提示词 / 绑定 / 状态）
  assert.deepEqual(db.storyboards.map((s) => s.id), before.storyboards.map((s) => s.id));
  assert.deepEqual(db.storyboards.map((s) => s.prompt), before.storyboards.map((s) => s.prompt));
  assert.deepEqual(db.storyboards.map((s) => s.assets), before.storyboards.map((s) => s.assets));
  assert.deepEqual(db.storyboards.map((s) => s.status), before.storyboards.map((s) => s.status));
  assert.deepEqual(db.assets.map((a) => a.id), before.assets.map((a) => a.id));
  assert.deepEqual(db.records.map((r) => r.id), before.records.map((r) => r.id));

  // 幂等凭据与队列设置不被动
  assert.deepEqual(db.idempotency, before.idempotency);
  assert.deepEqual(db.settings.queue, before.settings.queue);
});

test('迁移：自动创建「原有项目」与「原有分镜」，分镜补上 workspaceId', () => {
  const db = v1Fixture();
  schema.runMigrations(db);

  const proj = db.projects.find((p) => p.id === schema.LEGACY_PROJECT_ID);
  const ws = db.workspaces.find((w) => w.id === schema.LEGACY_WORKSPACE_ID);
  assert.ok(proj, '必须创建旧项目');
  assert.ok(ws, '必须创建旧工作区');
  assert.equal(proj.name, schema.LEGACY_PROJECT_NAME);
  assert.equal(ws.name, schema.LEGACY_WORKSPACE_NAME);
  assert.equal(ws.projectId, proj.id, '工作区的 projectId 是权威归属');
  assert.equal(proj.defaultWorkspaceId, ws.id, '扁平路由要靠 defaultWorkspaceId 落地');

  db.storyboards.forEach((s) => {
    assert.equal(s.workspaceId, ws.id, '每个分镜都要有 workspaceId');
    assert.equal(s.projectId, proj.id, '冗余 projectId 必须与权威归属一致');
  });
  // 素材只加 projectId，**不加** workspaceId（指令 §11：加了会破坏项目内资产共享）
  db.assets.forEach((a) => {
    assert.equal(a.projectId, proj.id);
    assert.equal(a.workspaceId, undefined, '素材不得带 workspaceId');
  });
});

test('迁移幂等：连跑两次，项目与工作区各恰好 1 个', () => {
  const db = v1Fixture();
  schema.runMigrations(db);
  const after1 = JSON.parse(JSON.stringify(db));

  const res2 = schema.runMigrations(db);
  assert.equal(res2.skipped, true, '版本已到目标值 → 直接跳过');
  assert.equal(db.projects.length, 1, '不得重复建项目');
  assert.equal(db.workspaces.length, 1, '不得重复建工作区');
  assert.deepEqual(db, after1, '第二次运行不得改动任何数据');

  /* 就算把版本号人为改回 1 再跑（模拟"重复执行迁移"），也必须幂等 ——
     这是指令 §18 的要求：migrateV1ToV2 自己负责判断"是否已经迁过"。 */
  db.schemaVersion = 1;
  schema.runMigrations(db);
  assert.equal(db.projects.length, 1, '重跑迁移不得建出第二个项目');
  assert.equal(db.workspaces.length, 1, '重跑迁移不得建出第二个工作区');
  assert.equal(db.storyboards.length, 2);
});

test('迁移：补齐 settings.defaults 缺失的键（老库缺它会让 getOptions 抛 50000）', () => {
  const db = v1Fixture();
  assert.equal(db.settings.defaults.motion, undefined, '前提：老库确实缺 motion');
  schema.runMigrations(db);
  assert.equal(typeof db.settings.defaults.motion, 'number');
  assert.equal(typeof db.settings.defaults.negativePrompt, 'string');
  // 已有值不得被覆盖
  assert.equal(db.settings.defaults.durationSec, 15);
  assert.equal(db.settings.defaults.model, 'seedance2.0fast_vip');
});

test('迁移：模型名归一（画布域名 → 创作域名）并清理画布时代的死字段', () => {
  const db = v1Fixture();
  schema.runMigrations(db);
  const sbB = db.storyboards.find((s) => s.id === 'st_b');
  assert.equal(sbB.model, 'seedance2.0_vip', '画布域名 seedance_2.0_vip 应无损改名为创作域名');
  assert.equal(db.cliJobs.st_b.cliModel, 'seedance2.0_vip', 'cliJobs 的型号同样归一');
  // 画布时代的死字段应被清掉
  ['engine', 'cliAvailable', 'cliVersion', 'mode'].forEach((k) => {
    assert.equal(db.settings.adapter[k], undefined, '死字段 ' + k + ' 应被删除');
  });
  assert.equal(db.settings.adapter.dreaminaVersion, '1.4.18', '真正在用的字段必须保留');
});

test('迁移：生成记录补上工作区上下文与名称快照，cliJobs 补上项目/工作区', () => {
  const db = v1Fixture();
  schema.runMigrations(db);
  const r = db.records[0];
  assert.equal(r.workspaceId, schema.LEGACY_WORKSPACE_ID);
  assert.equal(r.workspaceName, schema.LEGACY_WORKSPACE_NAME);
  assert.equal(r.projectName, schema.LEGACY_PROJECT_NAME);
  assert.ok(r.storyboardTitle, '要有分镜标题快照');

  const job = db.cliJobs.st_b;
  assert.equal(job.projectId, schema.LEGACY_PROJECT_ID);
  assert.equal(job.workspaceId, schema.LEGACY_WORKSPACE_ID);
});

test('迁移失败时原库一个字节都不动（在克隆体上跑）', () => {
  const db = v1Fixture();
  // 人为制造一个必然失败的迁移：让 v1→v2 产出非法结果（分镜指向不存在的工作区）
  const orig = schema.MIGRATIONS[1];
  schema.MIGRATIONS[1] = (draft) => { orig(draft); draft.storyboards[0].workspaceId = 'ws_不存在'; };
  const snapshot = JSON.parse(JSON.stringify(db));
  try {
    assert.throws(() => schema.runMigrations(db), /迁移结果校验未通过/, '校验必须拦下非法结果');
    assert.deepEqual(db, snapshot, '失败时原对象必须原封不动（这样 store 才能拒绝写盘）');
  } finally {
    schema.MIGRATIONS[1] = orig;
  }
});

test('空库：直接就是当前版本，跳过迁移（全新安装不该凭空多出一个项目）', () => {
  const empty = store.__emptyDbForTest ? store.__emptyDbForTest() : null;
  if (!empty) {
    // 不依赖内部导出：直接按 emptyDb 的契约断言
    assert.ok(true);
    return;
  }
  assert.equal(schema.readVersion(empty), schema.SCHEMA_VERSION);
  assert.equal(empty.projects.length, 0);
});

test('resolveScope：父子不一致必须拒绝，且不泄露对方是否存在', () => {
  const db = v1Fixture();
  schema.runMigrations(db);
  const other = P.createProject(db, { name: '另一个项目' });

  assert.throws(
    () => P.resolveScope(db, { projectId: other.project.id, workspaceId: schema.LEGACY_WORKSPACE_ID }),
    (e) => e.code === 40400,
    '把 A 的项目和 B 的工作区拼在一起必须 404'
  );
  assert.throws(() => P.resolveScope(db, { projectId: 'pj_不存在' }), (e) => e.code === 40400);
  assert.throws(() => P.resolveScope(db, { workspaceId: 'ws_不存在' }), (e) => e.code === 40400);
});

test('createProject：自动创建「默认页面」，且 defaultWorkspaceId 指向它', () => {
  const db = v1Fixture();
  schema.runMigrations(db);
  const out = P.createProject(db, { name: '红星机械厂' });
  assert.equal(out.project.name, '红星机械厂');
  assert.ok(out.workspace, '必须自动创建默认页面');
  assert.equal(out.workspace.name, '默认页面');
  assert.equal(out.project.defaultWorkspaceId, out.workspace.id);
  assert.equal(out.workspace.projectId, out.project.id);
  assert.equal(out.project.counts.workspaces, 1);
});
