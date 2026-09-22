'use strict';
/* ============================================================
   cli-jobs.js —— cliJobs 的活性 / 老化治理（阶段 2.9）

   现状与问题：
     · cliJobs 是 { storyboardId -> { submitId, state, command, ... } }，
       用于"事后用 dreamina query_result --submit_id=... 续查 / 补下载"。
     · 现在没有任何治理 —— 跑过 200 条分镜的库就堆 200 条 cliJobs，
       有些分镜已被彻底删除 / 改写，但 cliJobs 条目仍留着（看上面 batchDelete
       那里也会显式 delete —— 删了的会清，没删的会留到老）。
     · 没大小/年龄上限的副作用：
         1. db.json 越来越大（每个条目 ~500 B，200 条 ≈ 100 KB），
            落盘一次要 fsync 全部 —— 性能与数据安全都受影响；
         2. 老条目仍在读盘端可见，前端拉到「干跑记录」之外的额外信息，
            看起来像"有什么任务没跑完"，误导排查。

   治理原则（2026-09-22 阶段 2.9）：
     · **活跃保留**：state ∈ { submitting, downloading, queued } 一律保留（任务正在进行中）。
     · **终态按时间淘汰**：succeeded / failed / canceled / null 等终态条目按 `updatedAt`
       算老化，超过 `maxAgeMs`（默认 7 天）就删掉；保留最近的 `keepTerminal` 条
       （默认 50）以保证短时内仍可续查 / 补下载。
     · **对齐 storyboards**：分镜已被彻底删除（db.storyboards 里没有）的 cliJob 一律删掉
       （这是 batchDelete 已经做的，兜底再次清理是给"漏删 / 异常路径"用的）。
     · **可观测**：返回 { kept, removed: { stale, orphan, oversize } }，方便测试与排查。

   ⚠ 唯一事实来源：本文件导出 gc(db, opts) —— 它是纯函数 + 副作用封装在同一处，
     其它模块**禁止**再写 cliJobs 治理逻辑（重复实现 = 治理行为漂移）。
   ============================================================ */

const DEFAULTS = {
  /* 终态条目最长保留 7 天。短到不占 db.json，长到用户断网几天回来还能续查。 */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /* 终态条目数上限：超出按 updatedAt 删最老的（即便没到 maxAgeMs）。
     50 条 ≈ 普通用户一个月跑不出来的量；保留更多只是"以防万一"。 */
  keepTerminal: 50
};

/* 终态：worker.js 的 mapTaskError / cancel / reconcileOrphans / doInstallUpdate 都会把 cliJobs[sbId].state 落到这些值之一。
   跑动中（submitting / downloading / queued）一定保留，不参与淘汰。 */
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'canceled', 'ready']);

function isActive(job) {
  /* 没 state / state 不是已知终态 → 一律视为"在跑"，保守不删。
     这里把 falsy 与缺 state 视为同一种情况（= 不删），因为 worker 不写 state 的
     条目要么是中途崩溃留下的半成品（重新跑一轮仍要续查），要么是迁移期旧数据。 */
  if (!job || typeof job !== 'object') return false;   // 真正"没东西"才不当活跃处理
  const s = String(job.state || '');
  return TERMINAL_STATES.has(s) === false;
}

/* 移除 db.cliJobs 里"分镜已不存在"的孤儿条目。
   ⚠ 不能只靠 batchDelete 那条逻辑清理 —— 异常路径（中途崩溃 / schema 迁移错位）
     可能留下孤儿。 */
function removeOrphanCliJobs(db) {
  const liveIds = new Set((db.storyboards || []).map((s) => s.id));
  let removed = 0;
  Object.keys(db.cliJobs).forEach((sbId) => {
    if (!liveIds.has(sbId)) { delete db.cliJobs[sbId]; removed++; }
  });
  return removed;
}

/* 把终态条目按 updatedAt 升序排，超过 keepTerminal 的或 updatedAt 早于 now - maxAgeMs 的删掉。
   ⚠ job.updatedAt 由 worker 写入时统一加上（worker.js runViaDreamina / runOne 里都有）；
   旧数据可能没有 —— 这时把 updatedAt 当 createdAt 兜底（= 0 毫秒 → 必被淘汰，保守安全）。 */
function trimTerminalCliJobs(db, now, opts) {
  const maxAgeMs = (opts && opts.maxAgeMs != null) ? opts.maxAgeMs : DEFAULTS.maxAgeMs;
  const keepTerminal = (opts && opts.keepTerminal != null) ? opts.keepTerminal : DEFAULTS.keepTerminal;
  const cutAt = now - maxAgeMs;

  /* 先分离活跃 / 终态：活跃一律保留 */
  const live = [];
  const terminal = [];
  Object.keys(db.cliJobs).forEach((sbId) => {
    const j = db.cliJobs[sbId];
    if (isActive(j)) live.push(sbId);
    else terminal.push(sbId);
  });

  /* 终态按 updatedAt 升序排（最老的在前），然后双向裁剪：
     1. updatedAt < cutAt → 必删；
     2. 留下按倒序取最后 keepTerminal 条，其余删。
     ⚠ 这两条重叠也安全 —— "被切掉的最老" 一定不会比留下的更"新鲜"。
     ⚠ keepTerminal = 0 时 slice(-0) === slice(0) === 整个数组（JS 怪癖），
       必须显式短路成"什么都不留"，否则就成了"全保留"——与意图相反。 */
  terminal.sort((a, b) => Number(db.cliJobs[a].updatedAt || 0) - Number(db.cliJobs[b].updatedAt || 0));
  const keepSet = keepTerminal > 0 ? new Set(terminal.slice(-keepTerminal)) : new Set();
  let removedByAge = 0;
  let removedBySize = 0;
  for (const sbId of terminal) {
    const j = db.cliJobs[sbId];
    const t = Number(j.updatedAt || 0);
    if (!keepSet.has(sbId)) { delete db.cliJobs[sbId]; removedBySize++; continue; }
    /* 缺 updatedAt（迁移期旧数据）必删 —— 留到 keepSet 里就永远霸占名额 */
    if (t === 0 || t < cutAt) { delete db.cliJobs[sbId]; removedByAge++; }
  }

  return { active: live.length, terminalKept: keepSet.size - removedByAge, removedByAge, removedBySize };
}

/* 治理入口：db 上执行一次 GC，返回本次清理数。
   ⚠ 调用方负责 db.save() —— GC 本身**不**触发落盘（测试里常要连续跑两次看差异）。 */
function gc(db, opts) {
  const now = (opts && opts.now) || Date.now();
  const orphan = removeOrphanCliJobs(db);
  const trim = trimTerminalCliJobs(db, now, opts);
  return {
    active: trim.active,
    terminalKept: trim.terminalKept,
    removedOrphan: orphan,
    removedByAge: trim.removedByAge,
    removedBySize: trim.removedBySize
  };
}

module.exports = { gc, removeOrphanCliJobs, trimTerminalCliJobs, isActive, TERMINAL_STATES, DEFAULTS };