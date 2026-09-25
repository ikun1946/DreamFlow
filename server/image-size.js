'use strict';
/* ============================================================
   image-size.js —— 生图尺寸（宽高比 / 像素）的唯一事实来源

   为什么单独一个文件（2026-09-25）：
   尺寸规则**同时**被三处需要 —— 前端要即时校验与联动换算、服务端要
   在计费提交前再校验一次、测试要能把边界穷举掉。规则写两遍必然漂移，
   而这里的漂移代价是"提交出去被服务商拒绝"或"扣了钱拿到意想不到的尺寸"。
   所以规则只写在这一处，前端通过 /meta/options 拿同一份枚举与边界。

   ⚠ 规则直接来自服务商官方文档（workfisher-image-g-v2.5-flare 的 size 参数）：
     · `size` 接受**比例枚举**（1:1 / 16:9 / …）**或精确像素 `WxH`**；
     · 宽高须为 **16 的倍数**，且均 **≤ 3840**；
     · 最长边与最短边的比 **≤ 3:1**；
     · 总像素 **655360 – 8294400**。
   改这里之前先回查服务商文档 —— 这些数字不是我们定的。
   ============================================================ */

/* 比例枚举：与服务商文档逐项对齐（顺序按常用度排，界面直接按这个序渲染） */
const RATIOS = [
  { id: '1:1', w: 1, h: 1 },
  { id: '4:3', w: 4, h: 3 },
  { id: '3:4', w: 3, h: 4 },
  { id: '16:9', w: 16, h: 9 },
  { id: '9:16', w: 9, h: 16 },
  { id: '3:2', w: 3, h: 2 },
  { id: '2:3', w: 2, h: 3 },
  { id: '5:4', w: 5, h: 4 },
  { id: '4:5', w: 4, h: 5 },
  { id: '2:1', w: 2, h: 1 },
  { id: '1:2', w: 1, h: 2 },
  { id: '21:9', w: 21, h: 9 },
  { id: '9:21', w: 9, h: 21 },
  { id: '3:1', w: 3, h: 1 },
  { id: '1:3', w: 1, h: 3 }
];
/* 服务商还支持 `auto`（由它按提示词决定）。单独放，因为它不是"比例"。 */
const RATIO_AUTO = 'auto';

/* 分辨率档位（服务商文档：1k / 2k / 4k，默认 1k）。
   指定精确像素尺寸时服务商会忽略 resolution —— 但我们仍然把档位保留下来，
   因为"比例模式"下最终要把它一起发出去。 */
const RESOLUTIONS = ['1k', '2k', '4k'];

/* 像素预设：常见说法 → 具体尺寸。
   ⚠ 全部**必须是 16 的倍数** —— 服务商硬性要求，且文档明确表示违规行为"未说明"
      （既不保证报错也不保证自动调整），所以我们只能发确定合法的值。
   副作用是**不能**用教科书上的 1920×1080 / 1080×1920（1080 / 16 = 67.5，不是整数）：
     · 1080p  → 1920×1088（高度向上取到最近的 16 倍数）
     · 方形 1080 → 1088×1088
     · 竖屏 1080 → 1088×1920
   hint 如实写出实际像素，避免用户以为拿到的是 1920×1080。 */
const PRESETS = [
  { id: '1080p', label: '1080p', width: 1920, height: 1088, hint: '1920 × 1088（16 倍数对齐）' },
  { id: '2k', label: '2K', width: 2560, height: 1440, hint: '2560 × 1440' },
  { id: '4k', label: '4K', width: 3840, height: 2160, hint: '3840 × 2160（单边与总像素上限）' },
  { id: 'square', label: '方形', width: 1088, height: 1088, hint: '1088 × 1088' },
  { id: 'vertical', label: '竖屏 1080', width: 1088, height: 1920, hint: '1088 × 1920' }
];

/* 边界（与服务商文档一致） */
const LIMITS = {
  step: 16,           // 宽高必须是它的倍数
  min: 256,           // 单边下限：比"16 的倍数"更严一档，避免 16×16 这种无意义提交
  max: 3840,          // 单边上限
  minPixels: 655360,  // 总像素下限
  maxPixels: 8294400, // 总像素上限
  maxRatio: 3         // 长短边比上限
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* 把一个数吸附到最近的合法步长（16 的倍数），并钳在 [min, max]。
   为什么吸附而**不是**直接拒绝：界面上的步进器/联动换算天然会算出
   非 16 倍数的中间值（如 16:9 配 1080 得 1920×1080 没问题，
   但 4:3 配 1080 得 1440×1080 —— 合法；而 5:4 配 1000 就得吸附）。
   用户输入 1000 时"回落到最近的合法值"比"报错不改"体验好得多。 */
function snap(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  const stepped = Math.round(n / LIMITS.step) * LIMITS.step;
  return clamp(stepped, lo == null ? LIMITS.min : lo, hi == null ? LIMITS.max : hi);
}

function findRatio(id) {
  const key = String(id == null ? '' : id).trim();
  return RATIOS.find((r) => r.id === key) || null;
}

/* 比例 → 像素。以 area 为"目标总像素"反算，再吸附到合法网格。
   ⚠ 这里刻意**先放宽再收敛**：直接按比例 + 取整会算出 16 的倍数以外的值，
     所以吸附之后还要用 fitsLimits 复查一遍，必要时沿长边回退一格。
   返回 { width, height } —— 一定是合法的。 */
function ratioToSize(ratioId, targetPixels) {
  const r = findRatio(ratioId);
  if (!r) return null;
  const target = clamp(Number(targetPixels) || LIMITS.minPixels, LIMITS.minPixels, LIMITS.maxPixels);
  /* 由面积与比例解出宽：w = sqrt(area * rw / rh) */
  let w = Math.sqrt(target * (r.w / r.h));
  w = clamp(Math.round(w / LIMITS.step) * LIMITS.step, LIMITS.min, LIMITS.max);
  let h = clamp(Math.round((w * r.h / r.w) / LIMITS.step) * LIMITS.step, LIMITS.min, LIMITS.max);

  /* 收敛：沿长边逐步缩小，直到满足全部约束（最多试到下限，必然收敛）。 */
  let guard = 0;
  while (guard++ < 400) {
    const info = fitsLimits(w, h);
    if (info.ok) break;
    if (w >= h) w = clamp(w - LIMITS.step, LIMITS.min, LIMITS.max);
    else h = clamp(h - LIMITS.step, LIMITS.min, LIMITS.max);
    if (w === LIMITS.min && h === LIMITS.min) break;
  }
  return { width: w, height: h };
}

/* 由分辨率档位给一个"目标总像素"，供比例模式换算用。
   取值落在合法区间中段偏上，避免一上来就贴上限。 */
function pixelsOfResolution(res) {
  switch (String(res || '').toLowerCase()) {
    case '4k': return 8294400;   // 贴上限（3840×2160）
    case '2k': return 3686400;   // 2560×1440
    case '1k':
    default: return 2073600;     // 1920×1080
  }
}

/* 反算：给定像素尺寸，找一个"最贴近"的已知比例。
   用途是"手动改分辨率时同步反算并锁定宽高比"。取相对误差最小者；
   误差超过 2% 视为"自定义比例"（返回 null，界面显示"自定义"）。 */
function sizeToRatio(width, height) {
  const w = Number(width), h = Number(height);
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
  const actual = w / h;
  let best = null, bestErr = Infinity;
  RATIOS.forEach((r) => {
    const err = Math.abs(actual - (r.w / r.h)) / (r.w / r.h);
    if (err < bestErr) { bestErr = err; best = r; }
  });
  return bestErr <= 0.02 ? best.id : null;
}

/* 完整校验。返回 { ok, errors[], size }：
   · ok=true  → size 是可直接提交的 "WxH" 字符串
   · ok=false → errors 是给用户看的逐条原因；同时给出 nearest（回落建议） */
function validate(width, height) {
  const w = Number(width), h = Number(height);
  const errors = [];
  const int = (v) => isFinite(v) && Math.floor(v) === v;

  if (!int(w) || !int(h)) errors.push('宽高必须是整数');
  if (int(w) && int(h)) {
    if (w % LIMITS.step !== 0 || h % LIMITS.step !== 0) errors.push('宽高必须是 16 的倍数（当前 ' + w + '×' + h + '）');
    if (w > LIMITS.max || h > LIMITS.max) errors.push('单边不能超过 ' + LIMITS.max + ' 像素');
    if (w < LIMITS.min || h < LIMITS.min) errors.push('单边不能小于 ' + LIMITS.min + ' 像素');
    const px = w * h;
    if (px < LIMITS.minPixels) errors.push('总像素不能低于 ' + LIMITS.minPixels + '（当前 ' + px + '）');
    if (px > LIMITS.maxPixels) errors.push('总像素不能超过 ' + LIMITS.maxPixels + '（当前 ' + px + '）');
    const long = Math.max(w, h), short = Math.min(w, h);
    if (short > 0 && long / short > LIMITS.maxRatio) errors.push('长边与短边之比不能超过 3:1（当前 ' + (long / short).toFixed(2) + ':1）');
  }

  if (!errors.length) return { ok: true, errors: [], size: w + 'x' + h };
  return { ok: false, errors: errors, nearest: nearest(width, height) };
}

/* 回落：把用户输入校正到最近的合法尺寸。
   ⚠ 这里最重要的一条是**保住用户的构图意图（比例）**，而不是"随便给个合法的数"。
     所以策略是：先按用户给的宽高比定出目标比例，再在这个比例上找一个
     合法尺寸里"最接近用户输入总像素"的那一档。这样 1920×100（极端长条）
     会回落成 3:1 的合法尺寸，而不是被压成接近 1:1 的方块。
   返回 { width, height } —— 一定是合法的（最后有兜底）。 */
function nearest(width, height) {
  const rw = Number(width), rh = Number(height);
  /* 输入完全不可用时退回一个通用安全值 */
  if (!isFinite(rw) || !isFinite(rh) || rw <= 0 || rh <= 0) {
    return ratioToSize('1:1', LIMITS.minPixels);
  }

  /* ① 定目标比例：把输入比例钳到 [1/3, 3]（服务商上限），保住"横/竖"方向 */
  let aspect = rw / rh;
  if (aspect > LIMITS.maxRatio) aspect = LIMITS.maxRatio;
  if (aspect < 1 / LIMITS.maxRatio) aspect = 1 / LIMITS.maxRatio;

  /* ② 目标总像素 = 用户输入的总像素，钳进合法区间 */
  const targetPx = clamp(Math.round(rw * rh), LIMITS.minPixels, LIMITS.maxPixels);

  /* ③ 在"目标比例 + 目标像素"上解出宽高，再吸附到 16 网格。
        吸附会让比例略偏，所以拿吸附后的值做一次收敛（保持比例微调像素）。 */
  let w = clamp(Math.round(Math.sqrt(targetPx * aspect) / LIMITS.step) * LIMITS.step, LIMITS.min, LIMITS.max);
  let h = clamp(Math.round((w / aspect) / LIMITS.step) * LIMITS.step, LIMITS.min, LIMITS.max);

  /* ④ 收敛到全部约束内。策略：优先沿"离目标像素更远的那一轴"调整，
        这样最终尺寸在合法集合里离用户输入最近。 */
  let guard = 0;
  while (guard++ < 600) {
    const px = w * h;
    const long = Math.max(w, h), short = Math.min(w, h);
    if (short <= 0) break;
    if (long / short > LIMITS.maxRatio) {
      /* 比例超限：收长边 */
      if (w >= h) w = clamp(w - LIMITS.step, LIMITS.min, LIMITS.max);
      else h = clamp(h - LIMITS.step, LIMITS.min, LIMITS.max);
      continue;
    }
    if (px > LIMITS.maxPixels) {
      /* 超总像素：两轴等比缩（缩小的那一轴就算偏了也比违规强） */
      w = clamp(w - LIMITS.step, LIMITS.min, LIMITS.max);
      h = clamp(h - LIMITS.step, LIMITS.min, LIMITS.max);
      continue;
    }
    if (px < LIMITS.minPixels) {
      const nw = clamp(w + LIMITS.step, LIMITS.min, LIMITS.max);
      const nh = clamp(h + LIMITS.step, LIMITS.min, LIMITS.max);
      if (nw === w && nh === h) break;   /* 顶到单边上限仍不够 → 兜底 */
      w = nw; h = nh;
      continue;
    }
    if (fitsLimits(w, h).ok) break;
    /* 还剩未知违规（理论到不了）—— 收一格避免死循环 */
    w = clamp(w - LIMITS.step, LIMITS.min, LIMITS.max);
  }

  /* ⑤ 兜底：必须给出确定合法的值 */
  if (!fitsLimits(w, h).ok) {
    const base = ratioToSize(aspect >= 1 ? '16:9' : '9:16', LIMITS.minPixels);
    if (base) { w = base.width; h = base.height; }
  }
  return { width: w, height: h };
}

/* 综合校验：既可校验像素，也可校验比例枚举 / auto。
   这是**唯一**对外的主入口 —— 服务端与前端都走它。 */
function resolveSize(input) {
  const i = input || {};
  if (i.mode === 'ratio') {
    const id = String(i.ratio == null ? '' : i.ratio).trim();
    if (id === RATIO_AUTO || !id) {
      return { ok: true, mode: 'ratio', size: RATIO_AUTO, ratio: RATIO_AUTO,
        resolution: normResolution(i.resolution), errors: [] };
    }
    const r = findRatio(id);
    if (!r) return { ok: false, mode: 'ratio', errors: ['未知的宽高比：' + id], nearest: { mode: 'ratio', ratio: '1:1' } };
    /* 比例模式下：界面会把比例换算成具体像素显示，但**提交时仍发比例枚举** ——
       让服务商的 resolution 档位决定实际尺寸，比我们自己算的像素更贴近它的实现。 */
    return { ok: true, mode: 'ratio', size: id, ratio: id,
      resolution: normResolution(i.resolution), errors: [] };
  }
  /* 像素模式（默认）：显式给了宽高就按像素提交 */
  if (i.width != null && i.height != null) {
    const v = validate(i.width, i.height);
    if (v.ok) {
      return { ok: true, mode: 'pixels', size: v.size, width: Number(i.width), height: Number(i.height),
        ratio: sizeToRatio(i.width, i.height), resolution: null, errors: [] };
    }
    return { ok: false, mode: 'pixels', errors: v.errors, nearest: Object.assign({ mode: 'pixels' }, v.nearest) };
  }
  /* 什么都不给：交给服务商默认（等价于 size=auto） */
  return { ok: true, mode: 'ratio', size: RATIO_AUTO, ratio: RATIO_AUTO,
    resolution: normResolution(i.resolution), errors: [] };
}

function normResolution(res) {
  const v = String(res == null ? '' : res).trim().toLowerCase();
  return RESOLUTIONS.indexOf(v) >= 0 ? v : '1k';
}

/* 单个尺寸是否满足全部硬约束（供 ratioToSize 的收敛循环使用） */
function fitsLimits(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  const px = w * h;
  const errors = [];
  if (w % LIMITS.step !== 0 || h % LIMITS.step !== 0) errors.push('step');
  if (long > LIMITS.max) errors.push('max');
  if (short < LIMITS.min) errors.push('min');
  if (px < LIMITS.minPixels) errors.push('minPixels');
  if (px > LIMITS.maxPixels) errors.push('maxPixels');
  if (short > 0 && long / short > LIMITS.maxRatio) errors.push('ratio');
  return { ok: errors.length === 0, errors: errors };
}

/* 发给前端的一份"只读规格"（/meta/options 用）。
   前端据此渲染选项，不硬编码 —— 边界只会有一处定义。 */
function spec() {
  return {
    ratios: RATIOS.map((r) => ({ id: r.id, w: r.w, h: r.h })),
    auto: RATIO_AUTO,
    resolutions: RESOLUTIONS.slice(),
    presets: PRESETS.map((p) => Object.assign({}, p)),
    limits: Object.assign({}, LIMITS)
  };
}

module.exports = {
  RATIOS, RATIO_AUTO, RESOLUTIONS, PRESETS, LIMITS,
  findRatio, ratioToSize, sizeToRatio, pixelsOfResolution,
  validate, nearest, resolveSize, normResolution, fitsLimits, spec, snap
};
