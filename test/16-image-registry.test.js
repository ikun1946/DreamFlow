/* ============================================================
   16-image-registry.test.js —— provider / model 注册表（0.42.0）

   为什么单独一组：注册表是"添加 provider / model 只需改一处声明"的核心事实来源。
   它错了会同时影响 HTTP / IPC / UI 三个层；这里把已声明的 provider / model / sizeSpec
   形状钉住，防止有人改了一处忘了另一处。
   ============================================================ */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const REGISTRY = require('../server/image-registry');

describe('注册表 · 基本形状', () => {
  test('三家 provider 都在（work-fisher / openai / stability）', () => {
    const list = REGISTRY.listProviders();
    const ids = list.map((p) => p.providerId);
    assert.deepEqual(ids.sort(), ['openai', 'stability', 'work-fisher']);
  });
  test('每个 provider 至少一个 model；modelId 不重复', () => {
    const seen = new Set();
    REGISTRY.listProviders().forEach((p) => {
      assert.ok((p.models || []).length > 0, p.providerId + ' 至少一个 model');
      (p.models || []).forEach((m) => {
        assert.ok(!seen.has(m.modelId), m.modelId + ' 重复');
        seen.add(m.modelId);
      });
    });
  });
  test('每个 model 必带 sizeSpec：ratios 非空', () => {
    REGISTRY.listProviders().forEach((p) => {
      (p.models || []).forEach((m) => {
        assert.ok(m.sizeSpec && Array.isArray(m.sizeSpec.ratios), m.modelId + '.sizeSpec.ratios');
        assert.ok(m.sizeSpec.ratios.length > 0, m.modelId + '.sizeSpec.ratios 不能为空');
        assert.ok(m.sizeSpec.limits, m.modelId + '.sizeSpec.limits');
      });
    });
  });
  test('每 provider 有 providerKeyEnv（用于网页版环境变量）', () => {
    REGISTRY.listProviders().forEach((p) => {
      assert.ok(p.providerKeyEnv, p.providerId + '.providerKeyEnv 必填');
    });
  });
});

describe('注册表 · 查找 / 校验', () => {
  test('findProvider 命中 / 未命中', () => {
    assert.ok(REGISTRY.findProvider('work-fisher'));
    assert.equal(REGISTRY.findProvider('nope'), null);
  });
  test('findModel 命中 / 未命中', () => {
    assert.ok(REGISTRY.findModel('work-fisher', 'workfisher-image-g-v2.5-flare'));
    assert.equal(REGISTRY.findModel('work-fisher', 'no-such-model'), null);
    assert.equal(REGISTRY.findModel('openai', 'workfisher-image-g-v2.5-flare'), null);   // model 不属于该 provider
  });
  test('requireModel 抛错带 code', () => {
    try { REGISTRY.requireModel('nope', 'x'); throw new Error('should have thrown'); }
    catch (e) { assert.equal(e.code, 'unknown_provider'); }
    try { REGISTRY.requireModel('work-fisher', 'nope'); throw new Error('should have thrown'); }
    catch (e) { assert.equal(e.code, 'unknown_model'); }
  });
  test('默认 provider / model 是 work-fisher + v2.5 flare', () => {
    assert.equal(REGISTRY.defaultProviderId(), 'work-fisher');
    assert.equal(REGISTRY.defaultModelId(), 'workfisher-image-g-v2.5-flare');
  });
});

describe('注册表 · 下发前端', () => {
  test('specForFrontend 是数组；每条带 providerId + modelId + sizeSpec', () => {
    const arr = REGISTRY.specForFrontend();
    assert.ok(Array.isArray(arr));
    assert.ok(arr.length >= 3);
    arr.forEach((m) => {
      assert.ok(m.providerId && m.modelId && m.sizeSpec, JSON.stringify(m));
    });
  });
});

describe('注册表 · sizeSpec 模型差异', () => {
  test('OpenAI GPT Image 允许像素模式；分辨率档位 null', () => {
    const m = REGISTRY.findModel('openai', 'gpt-image-2.5-flare');
    assert.equal(m.sizeSpec.pixelMode, true);
    assert.equal(m.sizeSpec.resolutions, null);
    assert.equal(m.sizeSpec.limits.step, 16);
  });
  test('Stability 同样不允许像素模式；分辨率档位 null', () => {
    const m = REGISTRY.findModel('stability', 'stable-image-core');
    assert.equal(m.sizeSpec.pixelMode, false);
    assert.equal(m.sizeSpec.resolutions, null);
  });
  test('Work Fisher v2.5-Flare 允许像素模式 + 分辨率档位', () => {
    const m = REGISTRY.findModel('work-fisher', 'workfisher-image-g-v2.5-flare');
    assert.equal(m.sizeSpec.pixelMode, true);
    assert.ok(Array.isArray(m.sizeSpec.resolutions) && m.sizeSpec.resolutions.length > 0);
    assert.ok(Array.isArray(m.sizeSpec.presets) && m.sizeSpec.presets.length > 0);
  });
});
