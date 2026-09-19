'use strict';
/* ============================================================
   task-state.js —— 分镜任务的状态迁移与「谁有权写」的唯一事实来源

   为什么要有这个文件（2026-09-19 修复）：
   状态写入原先散落在 services.js / worker.js 的 9 处 if 里各自为政，于是出现：
     · **取消后复活**：cancel 把状态置 canceled，但 worker 拿到 CLI 成功结果后
       直接写 succeeded —— 界面显示"已取消"，任务却变成"成功"；
     · **重复生成**：retry 没有任何状态校验，generating 也能 retry ⇒ 同一分镜
       同时跑两轮生成，直接**重复扣费**；
     · **幽灵写入**：强制删除运行中的分镜后，worker 仍往已消失的任务上写日志与
       生成记录，并把 cliJobs 条目重新建回来。
   本模块把「合法迁移」与「写入权限」收拢到一处，供上述所有写入点复用。

   两条规则：
   1. `ALLOWED` 是**当前真实行为**的固化（不是理想设计）——先把现状钉住，
      再把危险的那几条单独收掉（见 `canRetry`）。新增状态写入必须先在此登记。
   2. 写入权限按 `attemptId` 判定：每次派发分配一个新的 attemptId，只有
      「当前 attempt」有权改这个分镜；过期 attempt 的结果一律丢弃。
   ============================================================ */
const crypto = require('crypto');

const STATUS = {
  DRAFT: 'draft',
  QUEUED: 'queued',
  GENERATING: 'generating',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled'
};

/* from -> 允许到达的集合。逐条对应现有代码里的真实迁移；改这里等于改行为。
   写点对照（2026-09-19 核对）：
     draft      → queued        services.doSubmit
     queued     → generating    worker.runOne 派发
     queued     → canceled      services.cancel
     queued     → failed        worker.mapTaskError（CLI 不可用 / 参数校验失败，此时尚未进 generating）
     generating → succeeded     worker.runViaDreamina 成功收尾
     generating → failed        worker.mapTaskError
     generating → canceled      services.cancel
     generating → draft         worker.finishDryRun（干跑不派发，回到「未提交」）
     failed     → queued        services.retry / worker.mapTaskError 自动重试
     failed     → canceled      services.cancel（保留既有行为）
     canceled   → queued        services.retry
     succeeded  → queued        services.doSubmit（「提交所选」重新生成；retry 另有限制） */
const ALLOWED = {
  draft: [STATUS.QUEUED],
  queued: [STATUS.GENERATING, STATUS.CANCELED, STATUS.FAILED],
  generating: [STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELED, STATUS.DRAFT],
  failed: [STATUS.QUEUED, STATUS.CANCELED],
  canceled: [STATUS.QUEUED],
  succeeded: [STATUS.QUEUED]
};

/* 合法迁移判定。同态迁移（from === to）一律视为合法 —— 多处写入是幂等重写，
   不必为它们各登记一条。 */
function canTransition(from, to) {
  if (from === to) return true;
  const list = ALLOWED[from];
  return Array.isArray(list) && list.includes(to);
}

/* 抛错版：写入点用它把"不该发生的迁移"变成响亮的失败，而不是静默写坏状态。 */
function assertTransition(from, to) {
  if (canTransition(from, to)) return;
  const e = new Error('非法状态迁移：' + from + ' → ' + to);
  e.code = 50000;
  throw e;
}

const isRunning = (status) => status === STATUS.QUEUED || status === STATUS.GENERATING;
const isTerminal = (status) => status === STATUS.SUCCEEDED || status === STATUS.FAILED || status === STATUS.CANCELED;

/* 只有「失败」与「已取消」允许重试。
   刻意**不含** queued / generating / succeeded：
     · queued / generating → retry 会让同一分镜同时跑两轮，重复扣费；
     · succeeded → retry 与「提交所选」重复，走提交那条路即可（那条路会分配新 attempt）。
   界面上的重试按钮本就只在 failed 行出现，这里是把后端对齐到界面已有的意图。 */
function canRetry(status) { return status === STATUS.FAILED || status === STATUS.CANCELED; }

/* 可取消：排队中 / 生成中（以及失败后再取消这种无害的同义操作）。
   未提交（draft）无需取消；已完成（succeeded）不可取消 —— 与既有行为一致。 */
function canCancel(status) { return status !== STATUS.DRAFT && status !== STATUS.SUCCEEDED; }

/* 每次派发分配一个新的 attemptId。用它替代"只看 storyboardId"的旧判定：
   retry / 重新提交后，旧 attempt 的异步结果回来时 attemptId 已经对不上，直接丢弃。 */
function newAttemptId() {
  return 'at_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* 当前写入者是否仍持有该分镜的写入权 */
function ownsAttempt(sb, attemptId) {
  return !!sb && !!attemptId && sb.attemptId === attemptId;
}

module.exports = {
  STATUS, ALLOWED,
  canTransition, assertTransition,
  isRunning, isTerminal, canRetry, canCancel,
  newAttemptId, ownsAttempt
};
