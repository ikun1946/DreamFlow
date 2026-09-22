'use strict';
/* ============================================================
   07-cli-jobs.test.js —— cliJobs 治理的行为测试（阶段 2.9）

   为什么单开一组：cliJobs 是 "事后用 dreamina query_result --submit_id=... 续查 / 补下载" 的
   唯一凭据，但目前**没有任何治理** —— 跑过几百条分镜的库会无限堆，每条 ~500 B，
   落盘 fsync 越来越慢，老条目还在误导排查。本组钉住治理规则：
     · 活跃（submitting / downloading / queued）必保留；
     · 终态按 updatedAt + keepTerminal 双裁剪（age 与 size 都超才删）；
     · 孤儿（分镜已删）必清理；
     · 用户调 gc() 两次结果稳定（幂等）。
   ============================================================ */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const H = require('./helpers');

/* 数据根必须最先重定向：store 在 require 时读 env */
const SANDBOX = H.freshDir('cli-jobs');
process.env.JC_DATA_DIR = SANDBOX;

const cliJobsMod = require('../server/cli-jobs');

let now = 0;

describe('cli-jobs —— 活性判定（治理原则 #1）', () => {
  test('★ 活跃态（submitting / downloading / queued）保留：isActive 返回 true', () => {
    assert.equal(cliJobsMod.isActive({ state: 'submitting' }), true, 'submitting 在跑动中');
    assert.equal(cliJobsMod.isActive({ state: 'downloading' }), true);
    assert.equal(cliJobsMod.isActive({ state: 'queued' }), true);
  });

  test('终态（succeeded / failed / canceled / ready）不被视为活跃', () => {
    assert.equal(cliJobsMod.isActive({ state: 'succeeded' }), false);
    assert.equal(cliJobsMod.isActive({ state: 'failed' }), false);
    assert.equal(cliJobsMod.isActive({ state: 'canceled' }), false);
    assert.equal(cliJobsMod.isActive({ state: 'ready' }), false);
  });

  test('未知 state 一律按"活跃"兜底（保守：不删，宁可留到下一轮再看）', () => {
    assert.equal(cliJobsMod.isActive({ state: 'weird-thing' }), true, '未知 state 不删');
    assert.equal(cliJobsMod.isActive({}), true, '空对象也按"还没结案"处理 —— 删了会把"在跑"误清');
    assert.equal(cliJobsMod.isActive(null), false, 'null 视为无 cliJob（不是真在跑）');
    assert.equal(cliJobsMod.isActive(undefined), false);
  });
});

describe('cli-jobs —— 孤儿清理（治理原则 #2）', () => {
  test('★ 分镜已被删 → 它的 cliJob 必清理（兜底 batchDelete 漏掉的异常路径）', () => {
    const db = {
      storyboards: [{ id: 'sb_live' }],
      cliJobs: {
        sb_live: { state: 'succeeded', updatedAt: 1 },
        sb_gone: { state: 'failed', updatedAt: 2 },
        sb_also_gone: { state: 'succeeded', updatedAt: 3 }
      }
    };
    const n2 = cliJobsMod.removeOrphanCliJobs(db);
    assert.equal(n2, 2, '应删 2 条孤儿');
    assert.deepEqual(Object.keys(db.cliJobs).sort(), ['sb_live'], '★ 孤儿 cliJob 不得残留');
  });

  test('所有 cliJob 都有对应分镜：清理返回 0 且库不变', () => {
    const db = {
      storyboards: [{ id: 'a' }, { id: 'b' }],
      cliJobs: { a: { state: 'succeeded' }, b: { state: 'failed' } }
    };
    const before = JSON.stringify(db);
    assert.equal(cliJobsMod.removeOrphanCliJobs(db), 0);
    assert.equal(JSON.stringify(db), before, '不得改任何字段');
  });
});

describe('cli-jobs —— 终态老化（治理原则 #3）', () => {
  test('★ 终态超过 maxAgeMs：必删', () => {
    const db = {
      storyboards: [],
      cliJobs: {
        a: { state: 'succeeded', updatedAt: 1000 },                       // 极老
        b: { state: 'succeeded', updatedAt: 99999999999999 }             // 极新
      }
    };
    const r = cliJobsMod.trimTerminalCliJobs(db, 100000, { maxAgeMs: 10000 });
    assert.ok(!db.cliJobs.a, '★ 老于 maxAgeMs 必删');
    assert.ok(db.cliJobs.b, '新于 maxAgeMs 必留');
    assert.equal(r.removedByAge, 1);
  });

  test('★ 终态超过 keepTerminal：删最老的，保留最新 N 条', () => {
    const db = {
      storyboards: [],
      cliJobs: {
        a: { state: 'succeeded', updatedAt: 1 },
        b: { state: 'failed',    updatedAt: 2 },
        c: { state: 'succeeded', updatedAt: 3 },
        d: { state: 'failed',    updatedAt: 4 },
        e: { state: 'succeeded', updatedAt: 5 }
      }
    };
    /* maxAgeMs 设无限大（让 time-based 淘汰无效） —— 只看 size-based 是否生效 */
    const r = cliJobsMod.trimTerminalCliJobs(db, 1e15, { maxAgeMs: 1e20, keepTerminal: 2 });
    assert.deepEqual(Object.keys(db.cliJobs).sort(), ['d', 'e'], '★ 只留最近 2 条（updatedAt 最大的）');
    assert.equal(r.removedBySize, 3);
    assert.equal(r.removedByAge, 0);
  });

  test('★ 活跃（submitting / downloading / queued）一律保留，即便老或超额多', () => {
    const db = {
      storyboards: [],
      cliJobs: {
        live_old: { state: 'submitting', updatedAt: 1 },                 // 极老 + 活跃
        live_now: { state: 'downloading', updatedAt: 99999999999999 },
        done_old: { state: 'succeeded', updatedAt: 1 }                   // 极老 + 终态
      }
    };
    const r = cliJobsMod.trimTerminalCliJobs(db, 100000, { maxAgeMs: 10000, keepTerminal: 1 });
    assert.ok(db.cliJobs.live_old, '★ 活跃不管多老都保留（不然"在跑"会被 GC 误删）');
    assert.ok(db.cliJobs.live_now, '活跃保留');
    assert.ok(!db.cliJobs.done_old, '★ 终态按规则删除（updatedAt=1 < cutAt 且不在 keepSet）');
    assert.equal(r.active, 2, '★ 报告里说"留了 2 个活跃条目"');
    assert.equal(r.removedByAge, 1, '★ done_old 是因为"年龄"被淘汰的');
  });

  test('★ 缺 updatedAt 的历史数据：按 0 毫秒处理 → 必被淘汰（保守安全）', () => {
    const db = {
      storyboards: [],
      cliJobs: { legacy: { state: 'succeeded' /* no updatedAt */ } }
    };
    cliJobsMod.trimTerminalCliJobs(db, Date.now(), { maxAgeMs: 1e60, keepTerminal: 0 });
    assert.ok(!db.cliJobs.legacy, '★ 缺 updatedAt 的终态条目必被淘汰（避免旧数据永远霸占名额）');
  });
});

describe('cli-jobs —— gc() 综合行为', () => {
  /* storyboards = liveIds（孤儿不进！），cliJobs 里有 live / orphan / terminal 三组 */
  function mkDb(liveIds, orphanIds, terminalIds) {
    return {
      storyboards: liveIds.map((id) => ({ id })),
      cliJobs: Object.assign({},
        ...liveIds.map((id) => ({ [id]: { state: 'submitting', updatedAt: now - 1 } })),
        ...orphanIds.map((id) => ({ [id]: { state: 'succeeded', updatedAt: now - 1 } })),
        ...terminalIds.map((id, i) => ({ [id]: { state: 'succeeded', updatedAt: now - i } }))
      )
    };
  }

  test('★ 综合：孤儿清 + 终态按 updatedAt + keepTerminal 双裁剪 + 活跃不动', () => {
    const db = mkDb(['live1', 'live2'], ['gone1', 'gone2'], ['t1', 't2', 't3']);
    now = 1e10;
    const r = cliJobsMod.gc(db, { now, maxAgeMs: 1000, keepTerminal: 2 });
    /* 这里的设计口径：
       · live1 / live2 在 storyboards 里 → 保留（活跃不动）；
       · gone1 / gone2 / t1 / t2 / t3 都不在 storyboards 里 → 都被孤儿清理带走；
       · 所以最终留下的就是 live1 / live2。 */
    assert.equal(r.removedOrphan, 5, '★ 5 个孤儿（分镜不在 storyboards 里）清掉');
    assert.deepEqual(Object.keys(db.cliJobs).sort(), ['live1', 'live2'], '★ 只留 2 活跃');
    assert.equal(r.active, 2);
    assert.equal(r.terminalKept, 0, '★ 没有任何保留的终态（都被当成孤儿清掉了）');
  });

  test('★ 重复调用是幂等的：第二次返回 removedOrphan=0 / removedBySize=0', () => {
    /* 第一次故意造一个孤儿 + 一个"刚好到达 keepTerminal 上限"的库，
       第一次会清理（孤儿 + 0 终态），第二次就什么也没了。 */
    const db = mkDb(['live'], ['gone'], []);
    now = 1e10;
    const r1 = cliJobsMod.gc(db, { now, maxAgeMs: 1e20, keepTerminal: 10 });
    assert.equal(r1.removedOrphan, 1, '★ 第一次把孤儿清掉');
    assert.equal(r1.removedBySize + r1.removedByAge, 0, '第一次没有可清的终态（孤儿不在 keepTerminal 这条路上）');

    const after1 = JSON.stringify(db);
    const r2 = cliJobsMod.gc(db, { now, maxAgeMs: 1e20, keepTerminal: 10 });
    assert.deepEqual(r2, { active: r1.active, terminalKept: r1.terminalKept, removedOrphan: 0, removedByAge: 0, removedBySize: 0 },
      '第二次 gc 必须是 no-op');
    assert.equal(JSON.stringify(db), after1, '库字面值也不得变');
  });
});

after(() => { H.rmrf(SANDBOX); });