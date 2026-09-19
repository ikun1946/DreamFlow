'use strict';
/* ============================================================
   worker-guard.test.js —— Worker 写入守卫的集成测试
   运行：node --test server/worker-guard.test.js

   验证的是本次修复的核心行为（不需要真实生成、不花积分）：
     · 取消之后，worker 拿到的"成功"结果不得把状态写回 succeeded
     · 分镜被删除后，worker 不得再写它（不产生幽灵日志 / 记录）
     · retry 换了新 attempt 之后，旧一轮的迟到结果必须被丢弃
     · 正常路径不受影响（该成功还是成功）

   ⚠ 安全前提：worker 内部会调 store.pushLog / store.save 与 REC.append，
   直接跑会写真实的 server/data/db.json（与 2026-09-18 那次事故同型）。
   所以这里**先把这几个副作用换成空实现**，再 require worker —— 全程只操作内存里的假库。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');

const store = require('./store');
store.pushLog = () => {};
store.save = () => {};
store.saveNow = () => {};
store.flush = () => {};
const REC = require('./records');
REC.append = () => {};

const { makeWorker } = require('./worker');

const CFG = {
  dryRun: false, creditWarnBelow: 0, dreaminaCliPath: 'dreamina',
  concCacheTtlMs: 60000, maxConcurrencySafety: 0
};

/* 假库：一条 queued 分镜 + 最小可用的 settings/cliJobs/logs */
function makeDb(sb) {
  return {
    storyboards: [sb],
    settings: { queue: { concurrency: 1, autoRetry: false, maxRetry: 2 } },
    cliJobs: {}, logs: {}, records: [], recordSeq: 0, seq: 1
  };
}
function makeSb(extra) {
  return Object.assign({
    id: 'st_t1', seq: 1, status: 'queued', attemptId: 'at_1', model: 'seedance2.0',
    durationSec: 5, assets: [], progress: 0, retryCount: 0, canEditDuration: true,
    prompt: '测试', ratio: '16:9', resolution: '720p', motion: 0.5
  }, extra || {});
}

/* 可控适配器：runVideo 停在 gate 上，直到测试调用 release() 才返回结果 */
function makeAdapter() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const adapter = {
    probe: async () => ({ available: true, credit: 100 }),
    buildSubmitArgs: () => ({ args: ['text2video'], notes: [] }),
    runVideo: async () => { await gate; return { ok: true, submitId: 'sub_abc12345', meta: { argv: ['text2video'] } }; },
    downloadResult: async () => ({ videoUrl: null, coverUrl: null })
  };
  return { adapter, release };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('取消后：worker 拿到的成功结果必须被丢弃（不得复活为 succeeded）', async () => {
  const sb = makeSb();
  const db = makeDb(sb);
  const { adapter, release } = makeAdapter();
  const worker = makeWorker(CFG, { dreamina: adapter });

  await worker.tick(db, () => {});
  await wait(40);
  assert.equal(sb.status, 'generating', '前提：已派发进入 generating');

  // 用户取消 —— 与 services.cancel 的两步一致
  sb.status = 'canceled';
  sb.attemptId = null;

  release();                 // CLI 随后返回"成功"
  await wait(60);

  assert.equal(sb.status, 'canceled', '取消后不得被写回 succeeded（本次修复的核心）');
  assert.equal(sb.videoUrl, undefined, '不得写入产物地址');
  assert.equal(sb.remoteId, undefined, '不得写入远端 ID');
  // 派发前的 state='submitting' 是合法留痕（那时还没取消），保留；
  // 被拒的是收尾写入 —— 不得补上 submit_id 与终态。
  assert.equal(db.cliJobs[sb.id].state, 'submitting', '被拒后不得补写终态');
  assert.equal(db.cliJobs[sb.id].submitId, undefined, '被拒后不得补写 submit_id');
});

test('被删除后：worker 不得再写这个分镜', async () => {
  const sb = makeSb();
  const db = makeDb(sb);
  const { adapter, release } = makeAdapter();
  const worker = makeWorker(CFG, { dreamina: adapter });

  await worker.tick(db, () => {});
  await wait(40);
  assert.equal(sb.status, 'generating');

  // 强制删除：分镜从库里消失，logs / cliJobs 一并清掉（与 services.batchDelete 一致）
  db.storyboards = [];
  delete db.cliJobs[sb.id];
  delete db.logs[sb.id];
  release();
  await wait(60);

  assert.equal(db.cliJobs[sb.id], undefined, '已删除的分镜不得被**重新建出** cliJobs（幽灵数据）');
  assert.equal(db.logs[sb.id], undefined, '不得给已删除的分镜写日志');
  assert.equal(sb.status, 'generating', '孤儿对象不再被推进（它已不在库里）');
});

test('retry 换新 attempt 后：旧一轮的迟到结果必须被丢弃', async () => {
  const sb = makeSb();
  const db = makeDb(sb);
  const { adapter, release } = makeAdapter();
  const worker = makeWorker(CFG, { dreamina: adapter });

  await worker.tick(db, () => {});
  await wait(40);
  assert.equal(sb.status, 'generating');
  assert.equal(sb.attemptId, 'at_1');

  // 用户重试：状态回 queued，并分配新 attempt（与 services.retry 一致）
  sb.status = 'queued';
  sb.attemptId = 'at_2';

  release();                 // 第一轮的结果现在才回来
  await wait(60);

  assert.equal(sb.status, 'queued', '旧 attempt 的结果不得覆盖新一轮的 queued');
  assert.equal(sb.attemptId, 'at_2', 'attempt 不应被改动');
  // 派发前那条 state='submitting' 是合法的（那时分镜还在、attempt 有效），保留；
  // 被拒的是**收尾写入** —— 不得补上 submit_id 与终态。
  assert.equal(db.cliJobs[sb.id].state, 'submitting', '旧轮不得写终态');
  assert.equal(db.cliJobs[sb.id].submitId, undefined, '旧轮不得补写 submit_id');
});

test('正常路径不受影响：未被打断时照常成功', async () => {
  const sb = makeSb();
  const db = makeDb(sb);
  const { adapter, release } = makeAdapter();
  const worker = makeWorker(CFG, { dreamina: adapter });

  await worker.tick(db, () => {});
  await wait(40);
  assert.equal(sb.status, 'generating');

  release();                 // 不打断，正常返回
  await wait(60);

  assert.equal(sb.status, 'succeeded', '正常路径必须照常成功（回归保护）');
  assert.equal(sb.progress, 100);
  assert.equal(sb.canEditDuration, false);
  assert.ok(db.cliJobs[sb.id], '正常路径仍要落 cliJobs（submit_id 是续查的唯一凭据）');
  assert.equal(db.cliJobs[sb.id].submitId, 'sub_abc12345');
});

test('派发前已被取消：worker 不得开跑', async () => {
  const sb = makeSb();
  const db = makeDb(sb);
  const { adapter } = makeAdapter();
  const worker = makeWorker(CFG, { dreamina: adapter });

  // tick 之前就取消了（模拟"排队中被取消"）
  sb.status = 'canceled';
  sb.attemptId = null;
  await worker.tick(db, () => {});
  await wait(40);

  assert.equal(sb.status, 'canceled', '取消后的分镜不得被派发');
});
