'use strict';
/* ============================================================
   data-dir —— 数据目录的查询与切换（2026-09-23 新增）

   这个功能碰的是用户真实数据，所以测试重点不是"能跑通"，而是
   **出错时原库是否完好**、以及**哪些路径必须被拒**。

   沙箱策略：用 runtime.configure() 把数据根与配置路径都指到临时目录，
   全程不碰真实库（与 01/02 两套的做法一致）。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const runtime = require('../server/runtime');
const DD = require('../server/data-dir');

const SANDBOX = H.freshDir('data-dir');

/* 造一个最小的可用库：db.json + projects/pj_1/... + backup/ */
function makeLib(root, tag) {
  fs.mkdirSync(path.join(root, 'projects', 'pj_1', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backup'), { recursive: true });
  H.writeJson(path.join(root, 'db.json'), H.sampleDb());
  fs.writeFileSync(path.join(root, 'projects', 'pj_1', 'assets', 'a.bin'), 'payload-' + (tag || 'x'));
  fs.writeFileSync(path.join(root, 'backup', 'old.json'), '{"k":1}');
  return root;
}

function dbWithActiveTask() {
  const db = H.sampleDb();
  db.storyboards = (db.storyboards || []).concat([{ id: 'sb_busy', workspaceId: 'ws_1', status: 'generating' }]);
  return db;
}

let ORIGINAL = null;

before(() => {
  ORIGINAL = runtime.snapshot();
  /* describe() 用 process.env.JC_DATA_DIR 实时判断"是否被环境变量锁定"，
     测试必须不受外部环境影响，否则带 JC_DATA_DIR 跑 npm test 时会误判。 */
  delete process.env.JC_DATA_DIR;
});

after(() => {
  if (ORIGINAL) runtime.configure(ORIGINAL);
});

describe('data-dir —— 目标目录校验（必须拒绝的路径）', () => {
  const lib = path.join(SANDBOX, 'lib');
  const cfg = path.join(SANDBOX, 'desktop-config.json');
  before(() => { makeLib(lib, 'v'); runtime.configure({ mode: 'desktop', dataDir: lib, configPath: cfg }); });

  test('合法目标：不存在的目录也能通过（会按需创建）', () => {
    const r = DD.validateTarget(path.join(SANDBOX, 'fresh-ok'));
    assert.equal(r.target, path.join(SANDBOX, 'fresh-ok'));
    assert.equal(r.exists, false);
  });

  test('★ 空值 / 相对路径 一律拒绝', () => {
    assert.throws(() => DD.validateTarget(''), /请填写目标目录/);
    assert.throws(() => DD.validateTarget('   '), /请填写目标目录/);
    assert.throws(() => DD.validateTarget('relative\\dir'), /绝对路径/);
  });

  test('★ 磁盘根目录被拒（否则会把整个盘当数据目录）', () => {
    const root = path.parse(path.resolve(SANDBOX)).root;
    assert.throws(() => DD.validateTarget(root), /磁盘根目录/);
  });

  test('★ 与当前数据目录相同 / 互为父子 一律拒绝', () => {
    assert.throws(() => DD.validateTarget(lib), /相同/);
    assert.throws(() => DD.validateTarget(path.join(lib, 'projects', 'inner')), /内部/);
    assert.throws(() => DD.validateTarget(path.dirname(lib)), /包含当前数据目录/);
  });

  test('★ 仓库内的 server/data 被拒（该目录不入 git，容易被误删）', () => {
    assert.throws(() => DD.validateTarget(path.join(runtime.CLI_DEFAULT_DATA_DIR, 'sub')), /server\/data/);
  });

  test('★ move 模式要求目标为空；switch 模式允许非空', () => {
    const notEmpty = path.join(SANDBOX, 'not-empty');
    fs.mkdirSync(notEmpty, { recursive: true });
    fs.writeFileSync(path.join(notEmpty, 'existing.txt'), 'x');

    assert.throws(() => DD.validateTarget(notEmpty, { requireEmpty: true }), /不是空的/);
    const r = DD.validateTarget(notEmpty, { requireEmpty: false });
    assert.equal(r.empty, false);
  });
});

describe('data-dir —— 描述当前状态', () => {
  test('桌面版 + 无环境变量 → canChange 为 true，且数据来自配置或默认', () => {
    const lib = path.join(SANDBOX, 'desc');
    const cfg = path.join(SANDBOX, 'desc-cfg.json');
    makeLib(lib, 'd');
    runtime.configure({ mode: 'desktop', dataDir: lib, configPath: cfg });

    const s = DD.describe();
    assert.equal(s.dataDir, path.resolve(lib));
    assert.equal(s.canChange, true);
    assert.equal(s.reason, null);
    assert.equal(s.isDesktop, true);
    assert.ok(s.moveEntries.includes('db.json'));
    assert.ok(s.moveEntries.includes('projects'));
    /* 日志与窗口状态属 userData，**不该**跟着库搬 */
    assert.ok(!s.moveEntries.includes('logs'));
  });

  test('★ 没有 configPath（网页版）→ 拒绝更改并给出可操作的原因', () => {
    runtime.configure({ mode: 'cli', dataDir: path.join(SANDBOX, 'web'), configPath: null });
    const s = DD.describe();
    assert.equal(s.canChange, false);
    assert.match(s.reason, /JC_DATA_DIR/);
    assert.throws(() => DD.change(H.sampleDb(), { dir: path.join(SANDBOX, 'x'), mode: 'switch' }), /不支持更改数据目录|JC_DATA_DIR/);
  });
});

describe('data-dir —— 迁移与切换（核心）', () => {
  test('★ move：数据被复制过去、原库保留、配置指向新目录', () => {
    const from = makeLib(path.join(SANDBOX, 'move-from'), 'm');
    const to = path.join(SANDBOX, 'move-to');
    const cfg = path.join(SANDBOX, 'move-cfg.json');
    runtime.configure({ mode: 'desktop', dataDir: from, configPath: cfg });

    const rep = DD.change(H.sampleDb(), { dir: to, mode: 'move' });

    assert.equal(rep.mode, 'move');
    assert.equal(rep.to, path.resolve(to));
    assert.deepEqual(rep.moved, ['db.json', 'projects', 'backup']);
    assert.equal(rep.needRestart, true);

    /* 新位置内容齐全 */
    assert.ok(fs.existsSync(path.join(to, 'db.json')));
    assert.ok(fs.existsSync(path.join(to, 'projects', 'pj_1', 'assets', 'a.bin')));
    assert.ok(fs.existsSync(path.join(to, 'backup', 'old.json')));
    assert.equal(fs.readFileSync(path.join(to, 'projects', 'pj_1', 'assets', 'a.bin'), 'utf8'), 'payload-m');

    /* ★ 原库必须原样保留 —— 复制而非移动 */
    assert.ok(fs.existsSync(path.join(from, 'db.json')));
    assert.equal(fs.readFileSync(path.join(from, 'projects', 'pj_1', 'assets', 'a.bin'), 'utf8'), 'payload-m');

    /* 配置已指向新目录 */
    const saved = H.readJson(cfg);
    assert.equal(path.resolve(saved.dataDir), path.resolve(to));
  });

  test('★ switch：只改指向，一个字节都不搬', () => {
    const from = makeLib(path.join(SANDBOX, 'sw-from'), 's');
    const to = path.join(SANDBOX, 'sw-to');
    fs.mkdirSync(to, { recursive: true });
    const cfg = path.join(SANDBOX, 'sw-cfg.json');
    runtime.configure({ mode: 'desktop', dataDir: from, configPath: cfg });

    const rep = DD.change(H.sampleDb(), { dir: to, mode: 'switch' });

    assert.equal(rep.mode, 'switch');
    assert.deepEqual(rep.moved, []);
    assert.equal(fs.readdirSync(to).length, 0, 'switch 不应写入任何文件');
    assert.equal(path.resolve(H.readJson(cfg).dataDir), path.resolve(to));
    assert.ok(fs.existsSync(path.join(from, 'db.json')), '原库不动');
  });

  test('★ 有生成任务在跑时拒绝迁移（否则会写坏数据）', () => {
    const from = makeLib(path.join(SANDBOX, 'busy-from'), 'b');
    const cfg = path.join(SANDBOX, 'busy-cfg.json');
    runtime.configure({ mode: 'desktop', dataDir: from, configPath: cfg });
    const to = path.join(SANDBOX, 'busy-to');

    assert.throws(() => DD.change(dbWithActiveTask(), { dir: to, mode: 'move' }), /生成任务在进行/);
    /* 被拒后既不能有产物，也不能改配置 */
    assert.ok(!fs.existsSync(path.join(to, 'db.json')));
    assert.ok(!fs.existsSync(cfg), '不应写配置');
  });

  test('★ move 到非空目录被拒（不覆盖别人的文件）', () => {
    const from = makeLib(path.join(SANDBOX, 'ne-from'), 'n');
    const cfg = path.join(SANDBOX, 'ne-cfg.json');
    runtime.configure({ mode: 'desktop', dataDir: from, configPath: cfg });

    const to = path.join(SANDBOX, 'ne-to');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'keep.txt'), 'do-not-touch');

    assert.throws(() => DD.change(H.sampleDb(), { dir: to, mode: 'move' }), /不是空的/);
    assert.equal(fs.readFileSync(path.join(to, 'keep.txt'), 'utf8'), 'do-not-touch');
    assert.ok(!fs.existsSync(cfg));
  });

  test('★ 配置路径不可写时：报错且不谎报成功（数据已就绪但指向未变）', () => {
    const from = makeLib(path.join(SANDBOX, 'ro-from'), 'r');
    /* 把"配置文件"指到一个不可能写入的位置：拿一个已存在的目录当文件路径 */
    const badCfg = path.join(SANDBOX, 'cfg-is-a-dir');
    fs.mkdirSync(badCfg, { recursive: true });
    runtime.configure({ mode: 'desktop', dataDir: from, configPath: badCfg });

    assert.throws(() => DD.change(H.sampleDb(), { dir: path.join(SANDBOX, 'ro-to'), mode: 'switch' }),
      /写配置失败/);
  });

  test('mode 参数非法时拒绝', () => {
    const from = makeLib(path.join(SANDBOX, 'mode-from'), 'x');
    runtime.configure({ mode: 'desktop', dataDir: from, configPath: path.join(SANDBOX, 'mode-cfg.json') });
    assert.throws(() => DD.change(H.sampleDb(), { dir: path.join(SANDBOX, 'mode-to') }), /mode 必须是/);
    assert.throws(() => DD.change(H.sampleDb(), { dir: path.join(SANDBOX, 'mode-to'), mode: 'copy' }), /mode 必须是/);
  });
});

describe('data-dir —— 活动任务计数口径', () => {
  test('与 projects.ACTIVE_STATUSES 同口径：queued / generating / cliJobs.submitting', () => {
    const empty = H.sampleDb();
    empty.storyboards = [];
    empty.cliJobs = {};
    assert.equal(DD.countActiveTasks(empty), 0);

    const db = H.sampleDb();
    db.storyboards = [
      { id: 'a', status: 'generating' },
      { id: 'b', status: 'queued' },
      { id: 'c', status: 'done' },
      { id: 'd', status: 'failed' }
    ];
    db.cliJobs = { j1: { state: 'submitting' }, j2: { state: 'done' } };
    assert.equal(DD.countActiveTasks(db), 3);
  });
});

/* ---------------------------------------------------------------
   路由层（接线验证）：上面测的是模块逻辑，这里验证"路由确实注册、
   错误码确实按契约返回"。真起服务、真打 HTTP —— 与 04 同一套路数。
   --------------------------------------------------------------- */
describe('data-dir —— HTTP 路由层', () => {
  const { createServer } = require('../server/server');
  const lib = path.join(SANDBOX, 'http-lib');
  let srv = null;
  let base = '';

  before(async () => {
    makeLib(lib, 'h');
    /* configPath = null 模拟网页版：此时本功能应当**明确拒绝**并说明原因。
       （桌面版的可改分支由上面的模块级用例覆盖，那里能直接注入 configPath。） */
    runtime.configure({ mode: 'cli', dataDir: lib, configPath: null });
    srv = createServer({ configOverrides: { port: 0, token: '' } });
    const addr = await srv.start();
    base = 'http://127.0.0.1:' + addr.port;
  });

  after(async () => {
    if (srv) await srv.stop();
  });

  test('GET /api/v1/runtime/paths → 200，并如实说明"不可改"的原因', async () => {
    const res = await fetch(base + '/api/v1/runtime/paths');
    assert.equal(res.status, 200);
    const env = await res.json();
    assert.equal(env.code, 0);
    assert.equal(env.data.canChange, false);
    assert.match(env.data.reason, /JC_DATA_DIR/);
    assert.ok(env.data.moveEntries.includes('db.json'));
  });

  test('★ POST /api/v1/runtime/data-dir 在不可改时被拒（业务错误码，不是默默成功）', async () => {
    const res = await fetch(base + '/api/v1/runtime/data-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: path.join(SANDBOX, 'nope'), mode: 'switch' })
    });
    /* ⚠ 本项目的业务失败走「HTTP 200 + envelope.code !== 0」，不是 HTTP 状态码
       （见 server/server.js 的 untrusted-origin 分支与 api.js 的约定）。
       所以这里断言的是 **code**，不是 status —— 第一版按 403 写，实测拿到的正是 200。 */
    const env = await res.json();
    assert.notEqual(env.code, 0, '必须返回非 0 业务码，而不是假装成功');
    assert.match(env.message, /JC_DATA_DIR|不支持更改数据目录/);

    /* 更关键的一条：被拒之后**不能有任何副作用** —— 目录没被创建、没有留下半成品。 */
    assert.ok(!fs.existsSync(path.join(SANDBOX, 'nope')), '被拒时不应创建目标目录');
  });
});
