'use strict';
/* ============================================================
   05-worker.test.js —— 队列层行为测试（P1-4）

   为什么单开一组：队列与**写入守卫**是另一条"最贵"的链路 ——
   并发档位算错会超发（多扣积分）、删除守卫失灵会产生"幽灵数据"
   （删了还被写回来）、重试边界错会无限重试或提前放弃。
   这些 bug 都只在"任务正在跑"的那一刻出现，人工几乎测不到。

   方式：**注入假 adapter**（不 spawn 真 CLI、不联网），
   走 tick / runOne 的**真实调度路径**，观察状态机与落库行为。

   ⚠ 数据隔离：JC_DATA_DIR 指到仓库内 .test-tmp 沙箱（AGENTS.md 红线）。
   ⚠ worker 的日志写入走 store.pushLog —— 它作用于 **store 自己加载的那个库**，
     所以测试必须拿 store.load() 返回的对象当 db（与生产一致），
     否则断言看的是另一个对象，等于没测。
   ============================================================ */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const H = require('./helpers');

const SANDBOX = H.freshDir('worker');
process.env.JC_DATA_DIR = SANDBOX;

const store = require('../server/store');
const TS = require('../server/task-state');
const { makeWorker } = require('../server/worker');

/* 与 server/config.js 同形状的最小配置：并发只由本地保护上限与用户设置决定 */
const CFG = {
  maxConcurrencySafety: 0,
  concCacheTtlMs: 30 * 1000,
  creditWarnBelow: 0,
  dreaminaCliPath: 'dreamina-fake',
  dryRun: false
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;

/** 空 fixture（含一个项目 + 一个工作区），队列参数可覆盖 */
function fixture(queueOver) {
  const db = H.sampleDb();
  db.storyboards = [];
  db.logs = {};
  db.cliJobs = {};
  db.records = [];
  db.settings.queue = Object.assign({ concurrency: 2, autoRetry: false, maxRetry: 0 }, queueOver || {});
  return db;
}

/** 把 fixture 落盘 → 让 store 重新加载 → 返回**store 自己那个 db 对象** */
function seed(db) {
  try { store.flush(); } catch (e) { /* 忽略：只是把上一轮的待写盘清掉 */ }
  H.writeJson(path.join(SANDBOX, 'db.json'), db);
  store.reload();
  return store.load();
}

function addSb(db, over) {
  seq += 1;
  const sb = Object.assign({
    id: 'st_w' + String(seq).padStart(3, '0'),
    projectId: 'pj_t1', workspaceId: 'ws_t1',
    seq: seq, prompt: '测试提示词 ' + seq,
    status: 'queued', progress: 0,
    model: 'seedance2.0_vip', durationSec: 5, ratio: '16:9', resolution: '720p',
    motion: 0.55, negativePrompt: '', retryCount: 0, assets: [],
    /* 显式给 null（不是 undefined）：下面的"取消后不得复活"用例靠它判断
       "迟到的成功结果有没有把产物地址写进去"，undefined 会让断言失去意义。 */
    videoUrl: null, coverUrl: null, remoteId: null,
    attemptId: TS.newAttemptId(), dirty: false, createdAt: new Date().toISOString()
  }, over || {});
  db.storyboards.push(sb);
  return sb;
}

/** 假 adapter：记录 runVideo 的调用，行为可被 over 覆盖 */
function fakeAdapter(over) {
  const a = {
    started: [],
    probe: async () => ({ available: true, credit: 999, message: '' }),
    buildSubmitArgs: () => ({ args: ['text2video'], cmd: 'text2video', model: 'seedance2.0_vip', res: '720p', durationSec: 5, notes: [] }),
    runVideo: async (db, sb) => {
      a.started.push(sb.id);
      return { ok: true, submitId: 'sub_' + sb.id, meta: { argv: ['text2video'], subcommand: 'text2video', cliModel: 'seedance2.0_vip' } };
    },
    downloadResult: async () => ({ videoUrl: 'cli://dreamina/x', coverUrl: null }),
    makeCover: async () => false
  };
  return Object.assign(a, over || {});
}

after(() => {
  try { store.flush(); } catch (e) { /* 忽略 */ }
  H.rmrf(SANDBOX);
});

describe('worker —— 并发档位与派发', () => {
  test('★ concurrency=2：一次 tick 最多派发 2 条，第 3 条留在队列', async () => {
    const db = seed(fixture({ concurrency: 2 }));
    [addSb(db), addSb(db), addSb(db)];

    let release; const gate = new Promise((r) => { release = r; });
    const adapter = fakeAdapter({
      runVideo: async (d, sb) => { adapter.started.push(sb.id); await gate; return { ok: true, submitId: 's_' + sb.id, meta: {} }; }
    });
    const w = makeWorker(CFG, { dreamina: adapter });

    await w.tick(db, () => {});
    await sleep(30);

    assert.equal(adapter.started.length, 2, '★ 一次 tick 只能派发 2 条（并发档位）');
    assert.equal(db.storyboards.filter((s) => s.status === 'generating').length, 2, '应有 2 条进入生成中');
    assert.equal(db.storyboards.filter((s) => s.status === 'queued').length, 1, '第 3 条必须仍在排队');
    assert.equal(w.state.running.size, 2, '内存里的运行表应与派发数一致');

    release();
    await sleep(40);
    assert.equal(w.state.running.size, 0, '任务结束后运行表应清空');
  });

  test('没有排队任务时 tick 直接返回（空闲快速路径，不白起 CLI）', async () => {
    const db = seed(fixture({ concurrency: 2 }));
    addSb(db, { status: 'draft' });
    let probed = 0;
    const adapter = fakeAdapter({ probe: async () => { probed++; return { available: true }; } });
    const w = makeWorker(CFG, { dreamina: adapter });
    await w.tick(db, () => {});
    assert.equal(probed, 0, '空闲时不该调用 probe（避免周期性白起进程）');
  });
});

describe('worker —— 写入守卫（幽灵数据防线）', () => {
  test('★ 跑动中被删除：迟到结果不得回写，且 submit_id 必须留在系统日志', async () => {
    const db = seed(fixture({ concurrency: 1 }));
    const sb = addSb(db);

    let release; const gate = new Promise((r) => { release = r; });
    const adapter = fakeAdapter({
      runVideo: async () => { await gate; return { ok: true, submitId: 'sub_ghost', meta: { argv: ['x'] } }; }
    });
    const w = makeWorker(CFG, { dreamina: adapter });

    await w.tick(db, () => {});
    await sleep(30);
    assert.equal(sb.status, 'generating', '前置条件：任务应已进入 generating');

    /* 模拟"彻底删除"：分镜从库里移除，它的 cliJobs 一并清掉 */
    db.storyboards = db.storyboards.filter((s) => s.id !== sb.id);
    delete db.cliJobs[sb.id];
    const logsBefore = (db.logs[sb.id] || []).length;

    release();
    await sleep(60);

    assert.equal(db.cliJobs[sb.id], undefined, '★ 不得为已删除的分镜重建 cliJobs（幽灵数据）');
    const logs = db.logs[sb.id] || [];
    assert.equal(logs.length, logsBefore, '★ 被拒后不得再往该分镜写日志');
    assert.ok(logs.every((l) => !/生成完成/.test(l.msg)), '★ 不得写"生成完成"');

    const sys = (db.logs.system || []).map((l) => l.msg).join('\n');
    assert.ok(/已丢弃/.test(sys), '应在系统日志留痕（说明这轮被丢弃）');
    assert.ok(/sub_ghost/.test(sys), '★ submit_id 必须留痕 —— 那是"钱已经花了"的唯一凭据');
  });

  test('★ 取消后不得复活：stale attempt 的结果被拒，状态保持 canceled', async () => {
    const db = seed(fixture({ concurrency: 1 }));
    const sb = addSb(db);

    let release; const gate = new Promise((r) => { release = r; });
    const adapter = fakeAdapter({
      runVideo: async () => { await gate; return { ok: true, submitId: 'sub_stale', meta: { argv: ['x'] } }; }
    });
    const w = makeWorker(CFG, { dreamina: adapter });

    await w.tick(db, () => {});
    await sleep(30);
    assert.equal(sb.status, 'generating');

    /* 模拟用户「取消」：状态改 canceled，并把 attemptId 清空（取消/重试都会换 attempt） */
    sb.status = TS.STATUS.CANCELED;
    sb.attemptId = null;

    release();
    await sleep(60);

    assert.equal(sb.status, TS.STATUS.CANCELED, '★ 迟到的成功结果不得把 canceled 改回 succeeded');
    assert.equal(sb.videoUrl, null, '不得写入产物地址');
  });

  test('★ 旧一轮的迟到结果不得覆盖新一轮（这一条专门盯 attempt 守卫，状态机此时是放行的）', async () => {
    /* 为什么还要单开一条：上面那条"取消后复活"实际上是被**状态机**拦住的
       （canceled → succeeded 不是合法迁移），把 attempt 守卫整个删掉它照样绿。
       而下面这个场景里状态机是**放行**的（generating → succeeded 合法），
       唯一的拦路虎就是 attempt 守卫 —— 实测：删掉守卫这条会红，上面那条不会。 */
    const db = seed(fixture({ concurrency: 1 }));
    const sb = addSb(db);
    const attemptA = sb.attemptId;

    /* 每一轮各配一道闸：这样才能"只放行旧的那一轮"，看清它单独做了什么 */
    const runs = [];
    const adapter = fakeAdapter({
      runVideo: async (d, s) => {
        const mine = s.attemptId;
        const rec = { attempt: mine, release: null };
        runs.push(rec);
        await new Promise((r) => { rec.release = r; });
        return { ok: true, submitId: 'sub_' + mine, meta: {} };
      }
    });
    const w = makeWorker(CFG, { dreamina: adapter });

    await w.tick(db, () => {});            // 第一轮：attempt A
    await sleep(30);
    assert.equal(runs.length, 1, '前置条件：第一轮应已派发');
    assert.equal(runs[0].attempt, attemptA);

    /* 模拟「取消」→「重试」：取消清空 attempt，重试分配新 attempt（services 里的真实路径） */
    sb.status = TS.STATUS.CANCELED; sb.attemptId = null;
    sb.status = TS.STATUS.QUEUED; sb.attemptId = TS.newAttemptId();   // attempt B

    await w.tick(db, () => {});            // 第二轮：attempt B（A 的回调仍持有 A）
    await sleep(30);
    assert.equal(runs.length, 2, '第二轮应已派发');
    assert.notEqual(runs[1].attempt, attemptA, '新一轮必须换 attempt');
    assert.equal(sb.status, TS.STATUS.GENERATING);

    runs[0].release();                     // 先放行**旧**那一轮
    await sleep(60);
    assert.equal(sb.status, TS.STATUS.GENERATING, '★ 旧一轮不得改写新一轮的状态');
    assert.equal(sb.videoUrl, null, '★ 旧一轮不得写入产物地址');
    assert.equal(db.records.length, 0, '★ 旧一轮不得落生成记录');
    const sys = (db.logs.system || []).map((l) => l.msg).join('\n');
    assert.ok(/已丢弃/.test(sys) && sys.includes('sub_' + attemptA),
      '★ 旧一轮的 submit_id 必须留在系统日志 —— 那一轮的钱已经花了');

    runs[1].release();                     // 再放行新一轮
    await sleep(60);
    assert.equal(sb.status, TS.STATUS.SUCCEEDED, '新一轮应正常成功');
    assert.ok(sb.videoUrl, '新一轮应写入产物地址');
    const recs = db.records.filter((r) => r.action === 'generate');
    assert.equal(recs.length, 1, '★ 只应落一条生成记录（旧一轮那条是噪音）');
    assert.equal(recs[0].submitId, 'sub_' + runs[1].attempt);
  });
});

describe('worker —— 失败重试边界', () => {
  test('★ autoRetry + maxRetry=2：共尝试 3 次后落 failed，且只落一条失败记录', async () => {
    const db = seed(fixture({ concurrency: 1, autoRetry: true, maxRetry: 2 }));
    const sb = addSb(db);

    const adapter = fakeAdapter({
      runVideo: async (d, s) => { adapter.started.push(s.id); return { ok: false, code: '51004', message: '上游超时' }; }
    });
    const w = makeWorker(CFG, { dreamina: adapter });

    for (let i = 0; i < 4; i++) { await w.tick(db, () => {}); await sleep(30); }

    assert.equal(adapter.started.length, 3, '一共应尝试 3 次（首次 + 2 次重试）');
    assert.equal(sb.retryCount, 2, 'retryCount 应停在 maxRetry=2');
    assert.equal(sb.status, 'failed', '重试用尽后应落 failed');
    assert.equal(sb.errorCode, '51004', '错误码应保留最后一次的');
    const recs = db.records.filter((r) => r.action === 'generate');
    assert.equal(recs.length, 1, '★ 只有最终失败才落记录（中间重试不记，避免记录页被刷满）');
    assert.equal(recs[0].outcome, 'failed');
  });

  test('autoRetry 关闭时：一次失败即落 failed，不重投', async () => {
    const db = seed(fixture({ concurrency: 1, autoRetry: false, maxRetry: 5 }));
    const sb = addSb(db);
    const adapter = fakeAdapter({
      runVideo: async (d, s) => { adapter.started.push(s.id); return { ok: false, code: '51004', message: '上游超时' }; }
    });
    const w = makeWorker(CFG, { dreamina: adapter });
    await w.tick(db, () => {});
    await sleep(40);
    assert.equal(adapter.started.length, 1, 'autoRetry=false 时不得重投');
    assert.equal(sb.status, 'failed');
    assert.equal(sb.retryCount, 0);
  });
});

describe('worker —— 孤儿回收（服务重启后的收尾）', () => {
  test('★ 库里有 generating、进程里没有 → 标中断，且**不自动重投**（避免无声再扣费）', () => {
    const db = seed(fixture({ autoRetry: true, maxRetry: 3 }));
    const sb = addSb(db, { status: 'generating', progress: 73, attemptId: TS.newAttemptId() });
    db.cliJobs[sb.id] = { engine: 'dreamina', state: 'submitting', submitId: 'sub_orphan', startedAt: new Date().toISOString() };

    const w = makeWorker(CFG, { dreamina: fakeAdapter() });
    const n = w.reconcileOrphans(db);

    assert.equal(n, 1, '应回收 1 条孤儿');
    assert.equal(sb.status, 'failed', '应标为失败（不是"永远生成中"）');
    assert.equal(sb.errorCode, '51005', '错误码应是 INTERRUPTED');
    assert.equal(sb.attemptId, null, '跟踪已断，本轮 attempt 应作废');
    assert.ok(/sub_orphan/.test(sb.errorMessage), '★ 应带上 submit_id（可用 query_result 续查，不必白扔一次生成）');
    assert.equal(db.storyboards.filter((s) => s.status === 'queued').length, 0,
      '★ 不得自动重投 —— 那会在用户不知情的情况下再扣一次积分');
    assert.equal(db.records.filter((r) => r.outcome === 'failed').length, 1, '应落一条失败记录');
    assert.ok((db.logs.system || []).some((l) => /启动清理/.test(l.msg)), '应在系统日志留痕');
  });

  test('没有孤儿的库：回收返回 0 且不改动任何东西', () => {
    const db = seed(fixture());
    addSb(db, { status: 'draft' });
    addSb(db, { status: 'succeeded' });
    const before = JSON.stringify(db.storyboards);
    const w = makeWorker(CFG, { dreamina: fakeAdapter() });
    assert.equal(w.reconcileOrphans(db), 0);
    assert.equal(JSON.stringify(db.storyboards), before, '不得改动非孤儿条目');
  });
});
