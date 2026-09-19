'use strict';
/* ============================================================
   task-state.test.js —— 任务状态机与模型时长能力的单元测试
   运行：node --test server/

   ⚠ 刻意只测**纯模块**（task-state / models.clampDuration）：
   它们不依赖 store，不会碰 db.json。涉及持久化的行为（取消后不被覆盖、
   重试被拒、幂等、CORS）走 HTTP 端到端验证 —— 那才是它们的真实运行环境，
   也避免重演 2026-09-18 那次"测试脚本直接调业务函数把空库写进 db.json"的事故。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');

const TS = require('./task-state');
const models = require('./models');

const S = TS.STATUS;

test('状态机：重试只允许 failed / canceled', () => {
  assert.equal(TS.canRetry(S.FAILED), true, '失败可重试');
  assert.equal(TS.canRetry(S.CANCELED), true, '已取消可重试');
  // 下面三条正是会造成「同一分镜同时跑两轮、重复扣费」的入口，必须拒绝
  assert.equal(TS.canRetry(S.GENERATING), false, '生成中不可重试');
  assert.equal(TS.canRetry(S.QUEUED), false, '排队中不可重试');
  assert.equal(TS.canRetry(S.SUCCEEDED), false, '已完成不可重试（改用「提交所选」重新生成）');
  assert.equal(TS.canRetry(S.DRAFT), false, '未提交不可重试');
});

test('状态机：取消只排除 draft 与 succeeded', () => {
  assert.equal(TS.canCancel(S.QUEUED), true);
  assert.equal(TS.canCancel(S.GENERATING), true);
  assert.equal(TS.canCancel(S.FAILED), true, '保留既有行为：失败后再取消无害');
  assert.equal(TS.canCancel(S.DRAFT), false, '未提交无需取消');
  assert.equal(TS.canCancel(S.SUCCEEDED), false, '已完成不可取消');
});

test('状态机：迁移表覆盖真实写入点，且拒绝危险迁移', () => {
  // 合法
  assert.ok(TS.canTransition(S.DRAFT, S.QUEUED), '提交');
  assert.ok(TS.canTransition(S.QUEUED, S.GENERATING), '派发');
  assert.ok(TS.canTransition(S.GENERATING, S.SUCCEEDED), '成功收尾');
  assert.ok(TS.canTransition(S.GENERATING, S.CANCELED), '生成中取消');
  assert.ok(TS.canTransition(S.GENERATING, S.DRAFT), '干跑回到未提交');
  assert.ok(TS.canTransition(S.FAILED, S.QUEUED), '重试 / 自动重试');
  assert.ok(TS.canTransition(S.CANCELED, S.QUEUED), '取消后重试');
  assert.ok(TS.canTransition(S.SUCCEEDED, S.QUEUED), '「提交所选」重新生成');
  // 危险：取消之后不许再被写成成功（本次修复的核心）
  assert.equal(TS.canTransition(S.CANCELED, S.SUCCEEDED), false, '已取消不得复活为成功');
  assert.equal(TS.canTransition(S.SUCCEEDED, S.CANCELED), false, '已完成不得被取消');
  assert.equal(TS.canTransition(S.DRAFT, S.SUCCEEDED), false, '未提交不得直接成功');
  // 同态视为合法（多处是幂等重写）
  assert.ok(TS.canTransition(S.CANCELED, S.CANCELED), '重复取消是幂等的');
});

test('状态机：assertTransition 对非法迁移抛错', () => {
  assert.doesNotThrow(() => TS.assertTransition(S.GENERATING, S.SUCCEEDED));
  assert.throws(() => TS.assertTransition(S.CANCELED, S.SUCCEEDED), /非法状态迁移/);
});

test('状态机：isRunning / isTerminal', () => {
  assert.equal(TS.isRunning(S.QUEUED), true);
  assert.equal(TS.isRunning(S.GENERATING), true);
  assert.equal(TS.isRunning(S.DRAFT), false);
  assert.equal(TS.isTerminal(S.SUCCEEDED), true);
  assert.equal(TS.isTerminal(S.FAILED), true);
  assert.equal(TS.isTerminal(S.CANCELED), true);
  assert.equal(TS.isTerminal(S.GENERATING), false);
});

test('attemptId：只有当前 attempt 有写入权', () => {
  const sb = { id: 'st_1', attemptId: 'at_A' };
  assert.equal(TS.ownsAttempt(sb, 'at_A'), true, '当前 attempt 可写');
  assert.equal(TS.ownsAttempt(sb, 'at_B'), false, '旧 attempt 不可写（结果必须丢弃）');
  assert.equal(TS.ownsAttempt(sb, null), false, '取消后 attemptId 被清空 → 谁都不能写');
  assert.equal(TS.ownsAttempt({ id: 'st_2' }, 'at_A'), false, '历史数据无 attemptId 时不做放行');
  // 每次生成都是新 id
  assert.notEqual(TS.newAttemptId(), TS.newAttemptId());
});

test('模型时长能力：seedance2.5 到 30s，其余到 15s', () => {
  assert.equal(models.clampDuration('seedance2.5', 30), 30, '2.5 的 30s 必须保住（本次修复点）');
  assert.equal(models.clampDuration('seedance2.5', 20), 20);
  assert.equal(models.clampDuration('seedance2.5', 25), 25);
  assert.equal(models.clampDuration('seedance2.5', 60), 30, '超出则收到上限 30');
  assert.equal(models.clampDuration('seedance2.0_vip', 30), 15, '其他模型上限仍是 15');
  assert.equal(models.clampDuration('seedance2.0', 3), 4, '低于下限收到 4');
  assert.equal(models.clampDuration('seedance2.5', 4.4), 4, '四舍五入');
  assert.equal(models.clampDuration('seedance2.5', 4.6), 5);
  assert.equal(models.clampDuration('seedance2.5', NaN), 4, '非法值回落到下限');
  assert.equal(models.clampDuration('seedance2.5', null), 4);
});

test('模型时长能力：历史名字（画布域名）也要能归一', () => {
  assert.equal(models.clampDuration('seedance_2.5', 30), 30, '画布域名 seedance_2.5 归一到 seedance2.5');
  assert.equal(models.clampDuration('seedance_2.0_vip', 30), 15);
});

test('模型时长能力：未知模型走默认能力（4–15）', () => {
  assert.equal(models.clampDuration('unknown_model', 30), 15);
  assert.equal(models.clampDuration('unknown_model', 2), 4);
});
