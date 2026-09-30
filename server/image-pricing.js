'use strict';
/* 生图参考价格：公开的历史成交估算，不是账户报价、更不是提交后的实际账单。
   本地快照保证断网时仍可选模型；在线读取有独立时限与缓存，不能让设置再次一直读取中。
   只保留白名单模型的文生图单张样本，不暴露账户信息，也不把上游 model_price=0 当免费。 */
const SHARED = require('./providers/_shared');
const REGISTRY = require('./image-registry');
const snapshot = require('./work-fisher-prices.json');
const SOURCE = 'https://api.work-fisher.com/api/pricing';
let cached = Object.assign({ snapshot: true }, snapshot);
let nextCheck = 0;
let inflight = null;

function normalizePricing(payload, checkedAt) {
  const models = {};
  REGISTRY.listModels('work-fisher').forEach((m) => {
    const estimate = payload && payload.price_estimates && payload.price_estimates[m.modelId];
    const profile = estimate && estimate.entries && estimate.entries.length ? estimate
      : payload && payload.observed_prices && payload.observed_prices[m.modelId];
    const entries = profile && Array.isArray(profile.entries) ? profile.entries : [];
    models[m.modelId] = { entries: entries.filter((e) => {
      const p = e.params || {};
      return (p.input_image_count == null || String(p.input_image_count) === '0') &&
        (p.output_count == null || String(p.output_count) === '1') &&
        (p.n == null || String(p.n) === '1') &&
        typeof e.price_cny === 'number' && Number.isFinite(e.price_cny) && e.price_cny > 0;
    }).map((e) => ({ resolution: e.params && (e.params.resolution || e.params['metadata.resolution']) || null,
      quality: e.params && e.params.quality || null, amount: e.price_cny })) };
  });
  return { source: SOURCE, checkedAt, snapshot: false, models };
}

async function refresh() {
  if (Date.now() < nextCheck) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    let timer;
    try {
      const result = await Promise.race([
        SHARED.callJson({ url: SOURCE, method: 'GET', timeoutMs: 2000, maxBodyBytes: 4 * 1024 * 1024 }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2200); })
      ]);
      if (result && result.status === 200 && result.json && result.json.success === true && result.json.price_estimates) {
        cached = normalizePricing(result.json, new Date().toISOString());
        nextCheck = Date.now() + 10 * 60 * 1000;
      } else nextCheck = Date.now() + 60 * 1000;
    } finally { clearTimeout(timer); inflight = null; }
    return cached;
  })();
  return inflight;
}

function forModel(modelId, prices) {
  const p = prices || cached;
  return { source: p.source, checkedAt: p.checkedAt, snapshot: !!p.snapshot,
    currency: 'CNY', estimated: true, entries: (p.models[modelId] || {}).entries || [] };
}
module.exports = { refresh, forModel, normalizePricing };
