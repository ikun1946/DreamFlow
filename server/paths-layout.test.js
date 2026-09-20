'use strict';
/* ============================================================
   paths-layout.test.js —— 资源文件的磁盘布局、地址形状、彻底删除
   运行：node --test server/paths-layout.test.js

   背景（2026-09-20 用户要求）："每个项目单独一个文件夹，项目里上传的引用的资产都在
   这个项目的文件夹中，当彻底删除某一个项目后这个文件夹就会被彻底删除"。
   之前素材是**全项目平铺**在 data/assets/ 里的，删项目根本删不干净。

   本文件钉住三件事：
     ① paths.js 的地址构造与解析（含**路径穿越必须被拒**）
     ② v2→v3 迁移：搬文件 + 改写地址（素材 / 分镜 / **历史记录** 三处都要改）
     ③ 彻底删除：删磁盘 + 删数据，且"有活动任务时拒绝"
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
store.pushLog = () => {};
store.save = () => {};
store.saveNow = () => {};
store.flush = () => {};

const PATHS = require('./paths');
const schema = require('./schema');
const PROJ = require('./projects');

/* 迁移会真的动磁盘，所以这里把「旧目录」指到项目内的临时目录 ——
   绝不能让测试碰到 data/ 下的真实数据。做法：临时把 paths 的常量替换掉。 */
const TMP = path.join(__dirname, '..', '_paths_test_tmp');
const LEGACY_ASSETS = path.join(TMP, 'legacy-assets');
const LEGACY_OUTPUT = path.join(TMP, 'legacy-output');
const PROJECTS = path.join(TMP, 'projects');

function sandbox() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(LEGACY_ASSETS, { recursive: true });
  fs.mkdirSync(LEGACY_OUTPUT, { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  /* ⚠ 必须用 setRoots，不能直接给 PATHS.PROJECTS_DIR 赋值 ——
     早先 paths.js 用的是模块级常量，赋值改不动它，于是测试以为沙箱化了、
     实际一路写进真实的 data/projects/（2026-09-20 实测踩到）。 */
  PATHS.setRoots({ projects: PROJECTS, legacyAssets: LEGACY_ASSETS, legacyOutput: LEGACY_OUTPUT });
}
test.beforeEach(sandbox);
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const w = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

/* 一个 v2 形状的库：地址都是"旧形状"，素材在旧平铺目录、产物在旧 output/<分镜>/ */
function v2Fixture() {
  return {
    schemaVersion: 2,
    projects: [{ id: 'pj_1', name: 'P1', settings: {}, defaultWorkspaceId: 'ws_1', deletedAt: null },
      { id: 'pj_2', name: 'P2', settings: {}, defaultWorkspaceId: 'ws_2', deletedAt: null }],
    workspaces: [{ id: 'ws_1', projectId: 'pj_1', name: 'W1', deletedAt: null },
      { id: 'ws_2', projectId: 'pj_2', name: 'W2', deletedAt: null }],
    storyboards: [{ id: 'st_1', projectId: 'pj_1', workspaceId: 'ws_1', seq: 1, prompt: 'p', status: 'succeeded', assets: [], model: 'seedance2.0', durationSec: 5, ratio: '16:9', resolution: '720p', videoUrl: '/files/st_1/v1.mp4', coverUrl: '/files/st_1/v1_cover.jpg' }],
    assets: [
      { id: 'as_1', projectId: 'pj_1', name: 'A1', type: 'character', url: '/media/assets/as_1.png', thumbUrl: '/media/assets/as_1.png' },
      { id: 'as_2', projectId: 'pj_2', name: 'A2', type: 'scene', url: '/media/assets/as_2.png', thumbUrl: null }
    ],
    records: [
      { id: 'rc_1', projectId: 'pj_1', storyboardId: 'st_1', at: '2026-09-19T08:00:00Z', action: 'generate', outcome: 'succeeded', videoUrl: '/files/st_1/v1.mp4', coverUrl: '/files/st_1/v1_cover.jpg' },
      { id: 'rc_2', projectId: 'pj_1', storyboardId: 'st_1', at: '2026-09-19T09:00:00Z', action: 'generate', outcome: 'failed', videoUrl: null, coverUrl: null },
      /* 别的项目的记录：用来证明"删干净"是**按项目**删，不是把记录表清空 */
      { id: 'rc_3', projectId: 'pj_2', storyboardId: 'st_9', at: '2026-09-19T10:00:00Z', action: 'generate', outcome: 'succeeded', videoUrl: null, coverUrl: null }
    ],
    settings: { defaults: {}, queue: {}, adapter: {} },
    seq: 1, idempotency: {}, cliJobs: {}, logs: {}, recordSeq: 2
  };
}
function seedLegacyFiles() {
  w(path.join(LEGACY_ASSETS, 'as_1.png'), 'IMG-1');
  w(path.join(LEGACY_ASSETS, 'as_2.png'), 'IMG-2');
  w(path.join(LEGACY_OUTPUT, 'st_1', 'v1.mp4'), 'VIDEO-1');
  w(path.join(LEGACY_OUTPUT, 'st_1', 'v1_cover.jpg'), 'COVER-1');
}

/* ---------------- ① 地址构造 / 解析 / 路径安全 ---------------- */
test('地址构造与解析：新形状带项目段，能原样解回来', () => {
  assert.equal(PATHS.assetUrl('pj_1', 'as_1.png'), '/media/assets/pj_1/as_1.png');
  assert.equal(PATHS.outputUrl('pj_1', 'st_1', 'v1.mp4'), '/files/pj_1/st_1/v1.mp4');
  assert.deepEqual(PATHS.parseAssetUrl('/media/assets/pj_1/as_1.png'), { projectId: 'pj_1', filename: 'as_1.png' });
  assert.deepEqual(PATHS.parseOutputUrl('/files/pj_1/st_1/v1.mp4'), { projectId: 'pj_1', storyboardId: 'st_1', filename: 'v1.mp4' });
  // 旧形状（无项目段）不被"新形状解析器"接受 —— 它由服务端的兜底分支处理
  assert.equal(PATHS.parseAssetUrl('/media/assets/as_1.png'), null);
  assert.equal(PATHS.parseOutputUrl('/files/st_1/v1.mp4'), null);
});

test('路径安全：穿越、越界、非法 id 一律被拒（静态服务只认白名单形状）', () => {
  const bad = [
    '/media/assets/pj_1/../../../server/data/db.json',
    '/media/assets/../db.json',
    '/media/assets/pj_1/..%2F..%2Fdb.json',
    '/media/assets/pj_1/a/b.png',
    '/files/pj_1/st_1/../../../db.json',
    '/files/pj_1/../pj_2/st_1/v1.mp4',
    '/files/pj_1/st_1/a/b.mp4'
  ];
  bad.forEach((u) => assert.equal(PATHS.resolveServePath(u), null, '必须拒绝：' + u));
  // 正常形状要能解析到项目目录下
  const ok = PATHS.resolveServePath('/media/assets/pj_1/as_1.png');
  assert.ok(ok && ok.endsWith(path.join('pj_1', 'assets', 'as_1.png')), '正常形状应解析到项目素材目录');
});

test('目录包含性：前缀相同但不是同一目录时必须拒绝（startsWith 的老毛病）', () => {
  const base = path.join(TMP, 'output');
  assert.equal(PATHS.contained(base, path.join(base, 'a.txt')), path.join(base, 'a.txt'));
  assert.equal(PATHS.contained(base, path.join(TMP, 'output-bak', 'a.txt')), null, 'output-bak 不属于 output');
  assert.equal(PATHS.contained(base, base), null, '目录本身不是可服务的文件');
});

/* ---------------- ② v2 → v3 迁移 ---------------- */
test('v2→v3：文件搬进 data/projects/<项目>/，旧位置被清空', () => {
  seedLegacyFiles();
  const db = v2Fixture();
  const res = schema.runMigrations(db);

  assert.equal(res.to, 3);
  assert.deepEqual(res.ran, ['v2→v3']);

  // 文件按项目落位
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_1', 'assets', 'as_1.png'), 'utf8'), 'IMG-1');
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_2', 'assets', 'as_2.png'), 'utf8'), 'IMG-2');
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_1', 'output', 'st_1', 'v1.mp4'), 'utf8'), 'VIDEO-1');
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_1', 'output', 'st_1', 'v1_cover.jpg'), 'utf8'), 'COVER-1');

  // 旧位置不再有文件 —— 搬空后整个旧目录被删掉（不是留个空壳）
  assert.equal(fs.existsSync(LEGACY_ASSETS), false, '旧素材目录搬空后应被删除');
  assert.equal(fs.existsSync(LEGACY_OUTPUT), false, '旧产物目录搬空后应被删除');
});

test('v2→v3：素材 / 分镜 / **历史记录** 三处地址都被改写（记录不改的话历史产物链接会全失效）', () => {
  seedLegacyFiles();
  const db = v2Fixture();
  schema.runMigrations(db);

  assert.equal(db.assets[0].url, '/media/assets/pj_1/as_1.png');
  assert.equal(db.assets[0].thumbUrl, '/media/assets/pj_1/as_1.png');
  assert.equal(db.assets[1].url, '/media/assets/pj_2/as_2.png');
  assert.equal(db.assets[1].thumbUrl, null, '本来为 null 的保持 null');
  assert.equal(db.storyboards[0].videoUrl, '/files/pj_1/st_1/v1.mp4');
  assert.equal(db.storyboards[0].coverUrl, '/files/pj_1/st_1/v1_cover.jpg');
  assert.equal(db.records[0].videoUrl, '/files/pj_1/st_1/v1.mp4', '历史记录的产物地址也要改');
  assert.equal(db.records[0].coverUrl, '/files/pj_1/st_1/v1_cover.jpg');
  assert.equal(db.records[1].videoUrl, null, '失败记录本来没有产物，改写后仍是 null');
});

test('v2→v3 幂等：再跑一次不重复搬、不改动任何东西', () => {
  seedLegacyFiles();
  const db = v2Fixture();
  schema.runMigrations(db);
  const snap = JSON.parse(JSON.stringify(db));

  const again = schema.runMigrations(db);
  assert.equal(again.skipped, true, '版本已到目标值 → 直接跳过');
  assert.deepEqual(db, snap, '第二次运行不得改动任何数据');
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_1', 'assets', 'as_1.png'), 'utf8'), 'IMG-1', '文件仍在');
});

test('v2→v3：源文件缺失时不让迁移失败（死链保持死链，其余照常搬）', () => {
  w(path.join(LEGACY_ASSETS, 'as_1.png'), 'IMG-1');       // 只放 as_1，故意不放 as_2
  w(path.join(LEGACY_OUTPUT, 'st_1', 'v1.mp4'), 'VIDEO-1');
  const db = v2Fixture();
  assert.doesNotThrow(() => schema.runMigrations(db), '缺一个文件不该让整个迁移失败');
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_1', 'assets', 'as_1.png'), 'utf8'), 'IMG-1');
  assert.equal(fs.existsSync(path.join(PROJECTS, 'pj_2', 'assets', 'as_2.png')), false, '缺失的那个不会凭空出现');
});

/* ---------------- ②b 扫尾：没人引用的残留文件 ---------------- */
test('扫尾：没人引用的残留文件按「目录名=分镜 id」认领，并给老数据补回封面地址', () => {
  const db = v2Fixture();
  /* 真实踩到的形状（2026-09-20 实测）：老版本没把封面写进记录，
     于是那张封面谁都不引用 —— 按地址搬搬不到它，留在旧目录里就不属于任何项目，
     彻底删除项目时也删不掉。 */
  db.storyboards[0].coverUrl = null;
  db.records[0].coverUrl = null;
  w(path.join(LEGACY_OUTPUT, 'st_1', 'v1_cover.jpg'), 'COVER-1');

  schema.runMigrations(db);

  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_1', 'output', 'st_1', 'v1_cover.jpg'), 'utf8'),
    'COVER-1', '残留封面应被认领到项目目录');
  assert.equal(fs.existsSync(LEGACY_OUTPUT), false, '认领干净后旧目录应被删除');
  assert.equal(db.storyboards[0].coverUrl, '/files/pj_1/st_1/v1_cover.jpg', '分镜应补回封面地址');
  assert.equal(db.records[0].coverUrl, '/files/pj_1/st_1/v1_cover.jpg', '老记录应补回封面地址');
});

test('扫尾：认不出归属的残留文件原地不动（宁可留着，也不塞进某个项目）', () => {
  const db = v2Fixture();
  /* 目录名不是任何分镜 id —— 归属无从判断 */
  w(path.join(LEGACY_OUTPUT, 'st_不认识', 'x.mp4'), 'ORPHAN');

  schema.runMigrations(db);

  assert.equal(fs.readFileSync(path.join(LEGACY_OUTPUT, 'st_不认识', 'x.mp4'), 'utf8'), 'ORPHAN',
    '认不出归属的文件必须留在原地');
  assert.equal(fs.existsSync(LEGACY_OUTPUT), true, '还有残留时旧目录不删');
});

/* ---------------- ③ 彻底删除 ---------------- */
function liveDbWithFiles() {
  seedLegacyFiles();
  const db = v2Fixture();
  schema.runMigrations(db);
  return db;
}

test('彻底删除：项目目录（素材 + 产物）与全部子数据一起消失', () => {
  const db = liveDbWithFiles();
  const before = {
    projects: db.projects.length, workspaces: db.workspaces.length,
    storyboards: db.storyboards.length, assets: db.assets.length, records: db.records.length
  };
  assert.ok(fs.existsSync(path.join(PROJECTS, 'pj_1', 'assets', 'as_1.png')), '前提：文件在');

  const out = PROJ.hardDeleteProject(db, 'pj_1');

  assert.equal(out.hard, true);
  assert.equal(out.removedFiles, 3, 'pj_1 有 1 个素材 + 1 个视频 + 1 个封面');
  assert.equal(fs.existsSync(path.join(PROJECTS, 'pj_1')), false, '项目目录必须整个消失');
  assert.equal(fs.existsSync(path.join(PROJECTS, 'pj_2')), true, '别的项目目录不受影响');
  assert.equal(fs.readFileSync(path.join(PROJECTS, 'pj_2', 'assets', 'as_2.png'), 'utf8'), 'IMG-2');

  assert.equal(db.projects.length, before.projects - 1);
  assert.equal(db.workspaces.length, before.workspaces - 1);
  assert.equal(db.storyboards.length, before.storyboards - 1);
  assert.equal(db.assets.length, before.assets - 1);
  /* pj_1 有 2 条记录，全删；pj_2 的那条必须留着 —— 证明是"按项目删"而不是清空记录表 */
  assert.equal(db.records.length, 1, '生成记录也要删（用户选择"全部删掉"），但只删本项目的');
  assert.equal(db.records[0].id, 'rc_3', '留下的应是别的项目的记录');
  assert.equal(db.projects.some((p) => p.id === 'pj_1'), false);
  assert.equal(db.records.some((r) => r.projectId === 'pj_1'), false);
});

test('彻底删除：有活动任务时必须拒绝，且不动任何文件', () => {
  const db = liveDbWithFiles();
  db.storyboards[0].status = 'generating';
  assert.throws(() => PROJ.hardDeleteProject(db, 'pj_1'), (e) => e.code === 40900);
  assert.ok(fs.existsSync(path.join(PROJECTS, 'pj_1', 'assets', 'as_1.png')), '被拒时不得动文件');
  assert.equal(db.projects.some((p) => p.id === 'pj_1'), true, '被拒时不得动数据');
});

test('彻底删除：对已软删除的项目也能执行（误点软删后仍能清干净）', () => {
  const db = liveDbWithFiles();
  PROJ.deleteProject(db, 'pj_1');                      // 先软删
  assert.ok(fs.existsSync(path.join(PROJECTS, 'pj_1')), '软删不动文件');
  assert.equal(db.projects.find((p) => p.id === 'pj_1').deletedAt != null, true);

  const out = PROJ.hardDeleteProject(db, 'pj_1');      // 再彻底删
  assert.equal(out.hard, true);
  assert.equal(fs.existsSync(path.join(PROJECTS, 'pj_1')), false);
  assert.equal(db.projects.some((p) => p.id === 'pj_1'), false);
});

test('软删除与彻底删除的区别：软删只打标记、文件与子数据全留', () => {
  const db = liveDbWithFiles();
  PROJ.deleteProject(db, 'pj_1');
  assert.equal(db.projects.find((p) => p.id === 'pj_1').deletedAt != null, true, '软删：打标记');
  assert.equal(db.storyboards.length, 1, '软删：分镜还在');
  assert.equal(db.assets.length, 2, '软删：素材还在');
  assert.equal(db.records.length, 3, '软删：记录还在');
  assert.ok(fs.existsSync(path.join(PROJECTS, 'pj_1', 'output', 'st_1', 'v1.mp4')), '软删：文件还在');
});
