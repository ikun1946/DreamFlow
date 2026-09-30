'use strict';
/* ============================================================
   image-size.js —— 生图尺寸（宽高比 / 像素）的数学原语 + per-model 适配（0.42.0）

   0.41.0 设计：所有尺寸规则**集中**在这一处（避免两处写必然漂移）。
   0.42.0 变更：尺寸规则**变成 per-model** —— Work Fisher、OpenAI GPT Image
     与 Stability 的比例/像素支持不同，硬塞进"一份规则"会导致其中一方出错。
   解法：把数学原语（snap / fitsLimits / validate / nearest / ratioToSize /
     sizeToRatio / pixelsOfResolution）保留为公共；具体 LIMITS / RATIOS /
     RESOLUTIONS / PRESETS 由 registry 的 sizeSpec 注入。

   ⚠ 调用方：
     · 前端控件：读 specForFrontend() 拿到所有 model 的 sizeSpec；
     · 服务端校验：resolveSize(input, modelId)；
     · 服务商端请求体：把 resolveSize 结果透传给对应 provider。
   不变量：所有这些都从同一份 registry 读，不会漂移。

   ⚠ 0.42.0 老客户端兼容：未传 modelId 时按"默认 model"（Work Fisher v2.5
     Flare）走 —— 与实施计划 §2 一致。
   ============================================================ */
const REGISTRY = require('./image-registry');

/* ---------------- 数学原语（与具体 model 无关） ---------------- */

/* 默认 limits —— 用于未传 modelId 的兜底，以及「与 model 无关的兜底校验」。
   实际校验时按 model sizeSpec.limits 覆盖。 */
const DEFAULT_LIMITS = {
  step: 16, min: 256, max: 3840, minPixels: 655360, maxPixels: 8294400, maxRatio: 3
};
const DEFAULT_RATIOS = REGISTRY.RATIO_ENUM.slice();
const DEFAULT_RESOLUTIONS = ['1k', '2k', '4k'];
const DEFAULT_PRESETS = [
  { id: '1080p', label: '1080p', width: 1920, height: 1088, hint: '1920 × 1088（16 倍数对齐）' },
  { id: '2k', label: '2K', width: 2560, height: 1440, hint: '2560 × 1440' },
  { id: '4k', label: '4K', width: 3840, height: 2160, hint: '3840 × 2160（单边与总像素上限）' },
  { id: 'square', label: '方形', width: 1088, height: 1088, hint: '1088 × 1088' },
  { id: 'vertical', label: '竖屏 1080', width: 1088, height: 1920, hint: '1088 × 1920' }
];
const RATIO_AUTO = 'auto';

/* 取某个 model 的"有效 spec"；缺省时回默认（Work Fisher v2.5 Flare） */
function specOf(modelId) {
  const m = modelId ? REGISTRY.findModel(providerFromModelId(modelId), modelId) : null;
  if (!m) {
    return {
      ratios: DEFAULT_RATIOS,
      resolutions: DEFAULT_RESOLUTIONS,
      fixedSizes: null,
      pixelMode: true,
      presets: DEFAULT_PRESETS,
      limits: DEFAULT_LIMITS
    };
  }
  return m.sizeSpec;
}

/* modelId 形如 "workfisher-image-g-v2.5-flare"，没有 providerId 前缀；
   反查 provider 扫一遍注册表；当前几十个模型，线性查找足够。 */
function providerFromModelId(modelId) {
  const id = String(modelId || '');
  for (const p of REGISTRY.listProviders()) {
    if (p.models.some((m) => m.modelId === id)) return p.providerId;
  }
  return REGISTRY.defaultProviderId();
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function snap(v, lo, hi, step) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  const s = step || DEFAULT_LIMITS.step;
  const minV = lo == null ? DEFAULT_LIMITS.min : lo;
  const maxV = hi == null ? DEFAULT_LIMITS.max : hi;
  const stepped = Math.round(n / s) * s;
  return clamp(stepped, minV, maxV);
}

function findRatio(spec, id) {
  const key = String(id == null ? '' : id).trim();
  return (spec.ratios || DEFAULT_RATIOS).find((rid) => rid === key) || null;
}

/* 比例 → 像素（保比例意图的回落，与 0.41.0 同算法，换 limits 参数） */
function ratioToSize(spec, ratioId, targetPixels) {
  if (arguments.length === 2) { targetPixels = ratioId; ratioId = spec; spec = null; }
  if (!spec) spec = specOf(null);
  const r = findRatio(spec, ratioId);
  if (!r) return null;
  const lim = spec.limits || DEFAULT_LIMITS;
  const targetPx = Number(targetPixels || (lim.minPixels + lim.maxPixels) / 2);
  if (!isFinite(targetPx) || targetPx <= 0) return null;
  const parts = String(r).split(':').map(Number);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const aspect = parts[0] / parts[1];

  let w = clamp(Math.round(Math.sqrt(targetPx * aspect) / lim.step) * lim.step, lim.min, lim.max);
  let h = clamp(Math.round((w / aspect) / lim.step) * lim.step, lim.min, lim.max);

  let guard = 0;
  while (guard++ < 600) {
    const px = w * h;
    const long = Math.max(w, h), short = Math.min(w, h);
    if (short <= 0) break;
    if (long / short > lim.maxRatio) {
      if (w >= h) w = clamp(w - lim.step, lim.min, lim.max);
      else h = clamp(h - lim.step, lim.min, lim.max);
      continue;
    }
    if (px > lim.maxPixels) {
      w = clamp(w - lim.step, lim.min, lim.max);
      h = clamp(h - lim.step, lim.min, lim.max);
      continue;
    }
    if (px < lim.minPixels) {
      const nw = clamp(w + lim.step, lim.min, lim.max);
      const nh = clamp(h + lim.step, lim.min, lim.max);
      if (nw === w && nh === h) break;
      w = nw; h = nh;
      continue;
    }
    if (fitsLimits(spec, w, h).ok) break;
    w = clamp(w - lim.step, lim.min, lim.max);
  }
  if (!fitsLimits(spec, w, h).ok) return null;
  return { width: w, height: h };
}

/* 像素 → 比例（2% 容差反猜枚举）
   ⚠ 兼容旧 2-arg sizeToRatio(w, h)。 */
function sizeToRatio(spec, w, h) {
  if (arguments.length === 2) { h = w; w = spec; spec = null; }
  if (!spec) spec = specOf(null);
  const ratios = spec.ratios || DEFAULT_RATIOS;
  const target = w / h;
  let best = null, bestDiff = Infinity;
  ratios.forEach((rid) => {
    const parts = String(rid).split(':').map(Number);
    const ratio = parts[0] / parts[1];
    const diff = Math.abs(ratio - target);
    if (diff < bestDiff) { bestDiff = diff; best = rid; }
  });
  return bestDiff / target <= 0.02 ? best : null;
}

/* 单尺寸是否满足所有硬约束（供收敛循环复用）
   ⚠ 兼容旧 2-arg fitsLimits(w, h)。 */
function fitsLimits(spec, w, h) {
  if (arguments.length === 2) { h = w; w = spec; spec = null; }
  if (!spec) spec = specOf(null);
  const lim = spec.limits || DEFAULT_LIMITS;
  const long = Math.max(w, h), short = Math.min(w, h);
  const px = w * h;
  const errors = [];
  if (!Number.isInteger(w) || !Number.isInteger(h)) errors.push('宽高必须是整数');
  else if (w % lim.step !== 0 || h % lim.step !== 0) errors.push('宽高必须是 ' + lim.step + ' 的倍数');
  if (long > lim.max) errors.push('单边超过 ' + lim.max);
  if (short < lim.min) errors.push('单边不能低于 ' + lim.min);
  if (px < lim.minPixels) errors.push('总像素不能低于 ' + lim.minPixels);
  if (px > lim.maxPixels) errors.push('总像素超过 ' + lim.maxPixels);
  if (short > 0 && long / short > lim.maxRatio) errors.push('长宽比超过 ' + lim.maxRatio + ':1');
  return { ok: errors.length === 0, errors };
}

/* 完整校验（像素）—— 给前端 reject 用。
   ⚠ 兼容旧 2-arg 调用 validate(w, h) —— 0.41.0 测试仍在用。 */
function validate() {
  let spec, w, h;
  if (arguments.length >= 3) { spec = arguments[0]; w = arguments[1]; h = arguments[2]; }
  else { spec = null; w = arguments[0]; h = arguments[1]; }
  if (!spec) spec = specOf(null);
  const lim = spec.limits || DEFAULT_LIMITS;
  w = Number(w); h = Number(h);
  if (!isFinite(w) || !isFinite(h)) {
    return { ok: false, errors: ['非数字'], nearest: nearest(spec, w, h) };
  }
  const v = fitsLimits(spec, w, h);
  if (v.ok) {
    return { ok: true, size: w + 'x' + h, width: w, height: h, ratio: sizeToRatio(spec, w, h), errors: [] };
  }
  return { ok: false, errors: v.errors, nearest: nearest(spec, w, h) };
}

/* 非法 → 离合法集最近（保方向 + 比例意图）
   ⚠ 兼容旧 2-arg nearest(w, h)。 */
function nearest(spec, w, h) {
  if (arguments.length === 2) { h = w; w = spec; spec = null; }
  if (!spec) spec = specOf(null);
  const lim = spec.limits || DEFAULT_LIMITS;
  const landscape = Number(w) >= Number(h);
  const ratio = (Number(w) || 1) / (Number(h) || 1);
  const targetPx = Math.max(lim.minPixels, Math.min(lim.maxPixels, (Number(w) || 1) * (Number(h) || 1)));
  /* 找方向一致 + 比例最近的枚举 */
  let bestR = null, bestDiff = Infinity;
  (spec.ratios || DEFAULT_RATIOS).forEach((rid) => {
    const parts = String(rid).split(':').map(Number);
    const r = parts[0] / parts[1];
    const dirOk = landscape ? r >= 1 : r <= 1;
    if (!dirOk) return;
    const d = Math.abs(r - ratio);
    if (d < bestDiff) { bestDiff = d; bestR = rid; }
  });
  if (!bestR) {
    /* 同方向找不到 → 回退用最接近原比例的（哪怕方向变了）；后面手工翻 */
    (spec.ratios || DEFAULT_RATIOS).forEach((rid) => {
      const parts = String(rid).split(':').map(Number);
      const r = parts[0] / parts[1];
      const d = Math.abs(r - ratio);
      if (d < bestDiff) { bestDiff = d; bestR = rid; }
    });
  }
  const sized = ratioToSize(spec, bestR, targetPx);
  if (sized) {
    /* 校准方向：用户原本是竖向（h > w）→ 翻成竖向；反之亦然 */
    if (!landscape && sized.width > sized.height) {
      return { mode: 'pixels', width: sized.height, height: sized.width };
    }
    return { mode: 'pixels', width: sized.width, height: sized.height };
  }
  return { mode: 'pixels', width: lim.min, height: lim.min };
}

function normResolution(spec, res) {
  if (arguments.length === 1) { res = spec; spec = null; }
  if (!spec) spec = specOf(null);
  const v = String(res == null ? '' : res).trim().toLowerCase();
  const list = spec.resolutions || [];
  return list.indexOf(v) >= 0 ? v : (list[0] || '1k');
}

function pixelsOfResolution(spec, res) {
  /* ⚠ 兼容旧 1-arg pixelsOfResolution(res) —— 0.41.0 测试仍在用。 */
  if (arguments.length === 1) { res = spec; spec = null; }
  if (!spec) spec = specOf(null);
  const map = { '1k': 1024 * 1024, '2k': 2560 * 1440, '4k': 3840 * 2160 };
  return map[normResolution(spec, res)] || 1024 * 1024;
}

/* ---------------- 综合 resolveSize（per-model） ---------------- */
function resolveSize(input, modelId) {
  const spec = specOf(modelId);
  const i = input || {};
  /* 像素模式：仅当 model 允许 */
  if (i.mode === 'pixels' || (i.width != null && i.height != null && i.sizeMode !== 'ratio')) {
    if (!spec.pixelMode) {
      return { ok: false, mode: 'pixels', errors: ['该模型不接受自定义像素'], nearest: { mode: 'ratio', ratio: (spec.ratios || DEFAULT_RATIOS)[0] } };
    }
    const v = validate(spec, i.width, i.height);
    if (v.ok) {
      return { ok: true, mode: 'pixels', size: v.size, width: v.width, height: v.height,
        ratio: v.ratio, resolution: null, errors: [] };
    }
    return { ok: false, mode: 'pixels', errors: v.errors, nearest: v.nearest };
  }
  /* 有些模型只接收分辨率档，不能把旧模型的比例强塞进 metadata。 */
  if (Array.isArray(spec.ratios) && !spec.ratios.length) {
    return { ok: true, mode: 'ratio', size: null, ratio: null,
      resolution: spec.resolutions ? normResolution(spec, i.resolution) : null, errors: [] };
  }
  /* 比例模式 */
  if (i.mode === 'ratio' || i.ratio != null) {
    const id = String(i.ratio == null ? '' : i.ratio).trim();
    if (!id || id === RATIO_AUTO) {
      return { ok: true, mode: 'ratio', size: RATIO_AUTO, ratio: RATIO_AUTO,
        resolution: normResolution(spec, i.resolution), errors: [] };
    }
    if (spec.fixedSizes && id.indexOf(':') < 0 && /^\d+\s*[\u00d7x]\s*\d+$/i.test(id)) {
      /* 保留旧模型 fixedSizes 协议的兼容分支；现行 GPT Image 用像素模式。 */
      return { ok: true, mode: 'ratio', size: id.toLowerCase().replace(/\s*[\u00d7]\s*/, 'x'),
        ratio: null, resolution: null, errors: [] };
    }
    const r = findRatio(spec, id);
    if (!r) return { ok: false, mode: 'ratio', errors: ['未知的宽高比：' + id], nearest: { mode: 'ratio', ratio: (spec.ratios || DEFAULT_RATIOS)[0] } };
    return { ok: true, mode: 'ratio', size: id, ratio: id,
      resolution: spec.resolutions ? normResolution(spec, i.resolution) : null, errors: [] };
  }
  /* 什么都没给 → auto */
  return { ok: true, mode: 'ratio', size: RATIO_AUTO, ratio: RATIO_AUTO,
    resolution: spec.resolutions ? normResolution(spec, i.resolution) : null, errors: [] };
}

/* 给前端的最小集 —— 暴露 ratios / resolutions / fixedSizes / pixelMode / presets / limits。
   之所以不带 provider / model 标识：上层 (image-registry.specForFrontend) 已经包了。 */
function specForFrontend(modelId) {
  const spec = specOf(modelId);
  return {
    ratios: (spec.ratios || DEFAULT_RATIOS).slice(),
    resolutions: spec.resolutions ? spec.resolutions.slice() : null,
    fixedSizes: spec.fixedSizes ? spec.fixedSizes.slice() : null,
    pixelMode: !!spec.pixelMode,
    presets: spec.presets ? spec.presets.slice() : null,
    auto: RATIO_AUTO,
    limits: Object.assign({}, spec.limits || DEFAULT_LIMITS)
  };
}

module.exports = {
  DEFAULT_LIMITS, DEFAULT_RATIOS, DEFAULT_RESOLUTIONS, DEFAULT_PRESETS,
  RATIO_AUTO,
  /* 0.41.0 老接口别名（测试在用） */
  LIMITS: DEFAULT_LIMITS,
  RATIOS: DEFAULT_RATIOS.map((rid, i) => {
    const parts = String(rid).split(':').map(Number);
    return { id: rid, w: parts[0], h: parts[1], _i: i };
  }),
  RESOLUTIONS: DEFAULT_RESOLUTIONS,
  PRESETS: DEFAULT_PRESETS,
  /* 0.42.0 新接口 */
  specOf, providerFromModelId,
  findRatio, ratioToSize, sizeToRatio, pixelsOfResolution,
  validate, nearest, resolveSize, normResolution, fitsLimits, snap,
  specForFrontend,
  /* 0.41.0 老接口别名 —— /meta/options 还在下发 imageSizes */
  spec: specForFrontend
};
