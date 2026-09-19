'use strict';
/* ============================================================
   model-limits.test.js —— 模型「参考素材上限」系列规则表的单元测试
   运行：node --test server/model-limits.test.js

   这一层是**配额口径的唯一事实来源**：添加资产弹窗的「已添加 X / 上限 Y」、
   自动匹配的剩余名额分配、组装 --image 时的截断，三处都走 limitsFor()。
   口径错了会同时影响三处，所以单独锁死。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const M = require('./models');

test('参考图上限：Seedance 2.5 系列 30 张', () => {
  assert.equal(M.imageLimitFor('seedance2.5'), 30);
  assert.equal(M.limitFamilyOf('seedance2.5'), 'seedance2.5');
  // 历史画布域名也要归一到同一系列
  assert.equal(M.imageLimitFor('seedance_2.5'), 30);
  assert.equal(M.limitFamilyOf('seedance_2.5'), 'seedance2.5');
});

test('参考图上限：Seedance 2.0 系列 9 张（全系列各型号一致）', () => {
  ['seedance2.0', 'seedance2.0fast', 'seedance2.0_vip', 'seedance2.0fast_vip', 'seedance2.0mini']
    .forEach((m) => {
      assert.equal(M.imageLimitFor(m), 9, m + ' 应为 9 张');
      assert.equal(M.limitFamilyOf(m), 'seedance2.0', m + ' 应归到 2.0 系列');
    });
  // 历史画布域名
  assert.equal(M.imageLimitFor('seedance_2.0_vip'), 9);
  assert.equal(M.imageLimitFor('seedance_2.0_fast_vip'), 9);
});

test('参考图上限：未知/空模型走最保守的兜底档，而不是无限制', () => {
  assert.equal(M.imageLimitFor('unknown_model'), 9);
  assert.equal(M.imageLimitFor(''), 9);
  assert.equal(M.imageLimitFor(undefined), 9);
  assert.equal(M.limitFamilyOf('unknown_model'), null);
});

test('limitsFor 与 imageLimitFor 同源（不得各算各的）', () => {
  ['seedance2.5', 'seedance2.0_vip', 'unknown_model'].forEach((m) => {
    assert.equal(M.imageLimitFor(m), M.limitsFor(m).image, m + ' 两处取值必须一致');
  });
});

test('上限表按系列配置：新增型号只要挂到系列正则上即生效', () => {
  // 规则表本身可被检视与扩展 —— 这是"便于后续扩展新模型"的落点
  assert.ok(Array.isArray(M.DREAMINA_LIMIT_RULES) && M.DREAMINA_LIMIT_RULES.length >= 2);
  const fams = M.DREAMINA_LIMIT_RULES.map((r) => r.family);
  assert.ok(fams.includes('seedance2.5') && fams.includes('seedance2.0'), '两个系列都要在表里');
  // 每条规则必须同时带 family / 正则 / 上限，缺一不可
  M.DREAMINA_LIMIT_RULES.forEach((r) => {
    assert.ok(r.family && r.re instanceof RegExp && r.limits && Number.isFinite(r.limits.image),
      '规则项 ' + JSON.stringify(r.family) + ' 结构不完整');
  });
  // 兜底档必须存在且是"最小"的一档（比 2.5 严）
  assert.ok(Number.isFinite(M.DREAMINA_LIMITS_DEFAULT.image));
  assert.ok(M.DREAMINA_LIMITS_DEFAULT.image <= M.imageLimitFor('seedance2.5'));
});
