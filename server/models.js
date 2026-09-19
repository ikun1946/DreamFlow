'use strict';
/* ============================================================
   models.js —— 模型注册表（创作 CLI 单一引擎）
   唯一事实来源：模型的名称归一、能力边界、以及"这个名字还能不能跑"。
   server/worker.js（路由/派发）、server/dreamina-cli.js（参数组装）、
   server/services.js（meta 下发/展示）都必须从这里取，禁止各自硬编码。

   ⚠ 2026-09-18：**画布 CLI（dreamina-canvas）已彻底移除**，本项目只使用创作 CLI（dreamina）。
   历史遗留的「画布域名」（seedance_2.0_vip / seedance_2.0_fast_vip / …）仍可能存在于旧数据里
   （设置默认值 / 分镜 / cliJobs / 生成记录），创作 CLI 不认这些名字，故保留 LEGACY_NAMES
   作为**纯数据迁移表**：它只回答"这个旧名字等价于哪个创作域名"，不再表示任何画布能力。

   实测依据（2026-09-18，CLI 原生输出）：
   · 创作 CLI：`dreamina text2video -h` 支持集（6 个）=
       seedance2.0 / seedance2.0fast / seedance2.0_vip /
       seedance2.0fast_vip / seedance2.0mini / seedance2.5
     multimodal2video 支持 image + video + audio 混合参考（原画布链路只支持 image）。
   · 画布域名 ↔ 创作域名的等价关系由画布目录的 aliases 字段证实，
     现仅用于把旧数据里的画布域名改写成创作域名。
   ============================================================ */

/* 创作 CLI 支持的全部视频模型（= text2video --model_version 公共支持集）。
   这就是本项目**可用模型的全部**。 */
const DREAMINA_VIDEO_MODELS = [
  'seedance2.0', 'seedance2.0fast', 'seedance2.0_vip',
  'seedance2.0fast_vip', 'seedance2.0mini', 'seedance2.5'
];

/* 【仅用于数据迁移】历史名字 → 创作 CLI --model_version。
     · 非 null = 可无损迁移（同一底层模型，只是换了套命名）；
     · null     = 创作 CLI 无对应能力（原仅画布模型，已随画布 CLI 一起下线），
                  迁移时只能改选别的可用模型。
   这张表**不参与任何能力判断** —— 判断能不能跑统一走 dreaminaModelOf()。 */
const LEGACY_NAMES = {
  /* 画布域规范名 → 创作域名（等价关系已证实） */
  'seedance_2.0_vip': 'seedance2.0_vip',
  'seedance_2.0_fast_vip': 'seedance2.0fast_vip',
  'seedance_2.0_mini': 'seedance2.0mini',
  'seedance_2.5': 'seedance2.5',
  /* 仅画布 CLI 有的第三方模型 / Seedance 1.0 Fast —— 无创作等价物 */
  'happyhorse_1.1': null,
  'happyhorse1.1': null,
  'minimax_h3': null,
  'minimaxh3': null,
  'wan_3.0': null,
  'wan3.0': null,
  'seedance_pro_fast': null,
  'seedance_1.0_fast': null,
  'seedance1.0fast': null
};

/* 展示名。保留历史名字的条目，是为了让**历史生成记录**还能正确显示当时用的是哪个模型。 */
const LABELS = {
  'seedance2.0': 'Seedance 2.0',
  'seedance2.0fast': 'Seedance 2.0 Fast',
  'seedance2.0_vip': 'Seedance 2.0 VIP',
  'seedance2.0fast_vip': 'Seedance 2.0 Fast VIP',
  'seedance2.0mini': 'Seedance 2.0 Mini',
  'seedance2.5': 'Seedance 2.5',
  /* 历史名字（画布域 / 已下线模型） */
  'seedance_2.0_vip': 'Seedance 2.0 VIP',
  'seedance_2.0_fast_vip': 'Seedance 2.0 Fast VIP',
  'seedance_2.0_mini': 'Seedance 2.0 Mini',
  'seedance_2.5': 'Seedance 2.5',
  'seedance_pro_fast': 'Seedance 1.0 Fast（已下线）',
  'happyhorse_1.1': 'HappyHorse 1.1（已下线）',
  'minimax_h3': 'MiniMax H3（已下线）',
  'wan_3.0': 'Wan 3.0（已下线）'
};

/* 创作 CLI 各模型的能力约束（来自 text2video -h / multimodal2video -h）。
   未实测过的型号一律走 DREAMINA_CAPS_DEFAULT —— 遵循"未验证的 CLI flag 禁止硬编码"。 */
const DREAMINA_CAPS = {
  'seedance2.5': { resolutions: ['480p', '720p', '1080p'], duration: [4, 30], audioOnly: true, note: '支持纯音频参考、最长 30s' },
  'seedance2.0_vip': { resolutions: ['720p', '1080p', '4k'], duration: [4, 15], audioOnly: false, note: '支持 4K' },
  'seedance2.0fast_vip': { resolutions: ['720p'], duration: [4, 15], audioOnly: false, note: '仅 720p' }
};
const DREAMINA_CAPS_DEFAULT = { resolutions: ['720p'], duration: [4, 15], audioOnly: false, note: '仅 720p' };
/* 创作 CLI 支持的画幅 */
const DREAMINA_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'];
/* 创作 CLI 参考素材数量上限（multimodal2video） */
/* ---------------- 参考素材数量上限：按**模型系列**配置（唯一事实来源） ----------------
   ⚠ 2026-09-19 改为「系列规则表」形式：新增模型时只要挂到对应系列的正则上即可，
     不必逐个型号抄一遍上限；将来某型号要单独放宽，在表的最前面插一条更具体的规则即可
     （`find` 取第一条命中的，越靠前优先级越高）。

   实测依据：Seedance 2.0 系列参考图上限 9 张、Seedance 2.5 系列 30 张。

   三个消费方都必须走 `limitsFor()`，禁止各自硬编码数字：
     · `dreamina-cli.js` 组装 `--image` 时截断（超出会丢图，必须留痕）
     · `services.autoMatchAssets` 自动匹配的**剩余名额**分配
     · `services.decorate` 下发给前端的 `imageLimit`（弹窗里的「已添加 X / 上限 Y」） */
const DREAMINA_LIMIT_RULES = [
  { family: 'seedance2.5', re: /^seedance2\.5/, limits: { image: 30, video: 10, audio: 10, total: 50 } },
  { family: 'seedance2.0', re: /^seedance2\./,  limits: { image: 9,  video: 3,  audio: 3,  total: 12 } }
];
/* 兜底：不在任何系列规则里的模型（含未实测过的新型号）走最保守的一档 */
const DREAMINA_LIMITS_DEFAULT = { image: 9, video: 3, audio: 3, total: 12 };

/* 引擎标签。'canvas' 仅用于**历史生成记录**的展示（那些记录确实是画布链路产生的），
   新代码不会再产生这个取值。 */
const ENGINE_LABELS = { dreamina: '创作 CLI', canvas: '画布 CLI（已退役）' };

/* ---------------- 名称与能力查询 ---------------- */

/* 该模型名对应的创作 CLI `--model_version`；不可用（含已下线的仅画布模型）则 null。
   **这是"这个名字还能不能跑"的唯一判据**，全项目统一用它。 */
function dreaminaModelOf(model) {
  if (!model) return null;
  if (DREAMINA_VIDEO_MODELS.includes(model)) return model;
  if (Object.prototype.hasOwnProperty.call(LEGACY_NAMES, model)) return LEGACY_NAMES[model];
  return null;
}

/* 名字是否被认识（含已下线/历史名字）—— 与"能不能跑"无关。
   用来区分"这是历史遗留名字，可以告诉你它变成了什么"和"这名字我完全没见过"。 */
function isKnown(model) {
  return !!model && (DREAMINA_VIDEO_MODELS.includes(model) ||
    Object.prototype.hasOwnProperty.call(LEGACY_NAMES, model));
}

/* 是否为**可无损迁移**的历史名字（历史画布域名 → 创作域名）。
   迁移纪律：先做这个名字归一（无损），再判断剩下那些"根本跑不了"的名字该怎么替代。 */
function isLegacyName(model) {
  return !!model && !DREAMINA_VIDEO_MODELS.includes(model) &&
    Object.prototype.hasOwnProperty.call(LEGACY_NAMES, model) && LEGACY_NAMES[model] != null;
}

/* 该模型可被哪些引擎执行。本项目只有一个引擎，故已知模型恒为 ['dreamina']。
   保留此函数是为了让 meta 下发 / 前端展示的字段结构不变，避免下游到处改形状。 */
function enginesFor(model) { return dreaminaModelOf(model) ? ['dreamina'] : []; }

/* 前端下拉分组键。单引擎后只剩 'dreamina'；'other' = 不在注册表。 */
function groupOf(model) { return dreaminaModelOf(model) ? 'dreamina' : 'other'; }

/* 同一引擎族判定。单引擎项目里所有可用模型同族 —— 保留是为了不改变迁移替代逻辑的形状。 */
function sameFamily(a, b) { return enginesFor(a).join() === enginesFor(b).join(); }

function labelOf(model) {
  if (LABELS[model]) return LABELS[model];
  return model;
}
function engineLabel(engine) { return ENGINE_LABELS[engine] || engine; }
function capsFor(dreaminaModel) { return DREAMINA_CAPS[dreaminaModel] || DREAMINA_CAPS_DEFAULT; }
/* 该模型所属的「上限系列」名（用于给用户解释"为什么是 9 张"）；不在任何系列里返回 null。
   传进来的可能是历史画布域名，故先归一到创作域名再判。 */
function limitFamilyOf(model) {
  const name = dreaminaModelOf(model) || String(model || '');
  const hit = DREAMINA_LIMIT_RULES.find((r) => r.re.test(name));
  return hit ? hit.family : null;
}
function limitsFor(model) {
  const name = dreaminaModelOf(model) || String(model || '');
  const hit = DREAMINA_LIMIT_RULES.find((r) => r.re.test(name));
  return hit ? hit.limits : DREAMINA_LIMITS_DEFAULT;
}
/* 参考图上限的快捷取值 —— 前端提示、自动匹配配额、组装截断三处都用它，保证同一个数 */
function imageLimitFor(model) { return limitsFor(model).image; }

/* 按**模型自身**的能力区间钳制时长（2026-09-19 修复）。
   此前 services.js 一律用全局 META.duration（4–15）钳制，于是 models.js 里
   写着 seedance2.5 支持 4–30、设置页也能选 30，但创建 / 导入 / 批量改 / 标注重算
   四处又把它压回 15 —— 用户看到的选项和真正落库的值不一致。
   传进来的可能是任意历史名字，故先归一到创作 CLI 域名再查能力表。 */
function clampDuration(model, sec) {
  const caps = capsFor(dreaminaModelOf(model) || model);
  const [min, max] = caps.duration || DREAMINA_CAPS_DEFAULT.duration;
  const v = Math.round(Number(sec));
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/* ---------------- 路由（唯一规则出口） ----------------
   本项目只有创作 CLI 一个引擎，所以路由不再有分支 —— 保留函数是为了让调用方
   不各自硬编码引擎名，也让"引擎"这个概念在记录/日志里仍有一个统一出口。
   入参 { model, hasAudio } 保留 hasAudio：它现在不影响路由，但会写进理由便于排查。 */
function routeEngine(o) {
  const opt = o || {};
  const engines = enginesFor(opt.model);
  const hasAudio = !!opt.hasAudio;
  let reason;
  if (engines.length === 0) {
    reason = isKnown(opt.model)
      ? '该模型已下线（原仅画布 CLI 可用），创作 CLI 无对应能力'
      : '模型不在注册表中，交由创作 CLI 校验';
  } else if (hasAudio) {
    reason = '含音频参考：创作 CLI 的 multimodal2video 支持 image + video + audio 混合参考';
  } else {
    reason = isLegacyName(opt.model)
      ? '历史画布域名，按创作 CLI 等价模型执行'
      : '本项目仅使用创作 CLI';
  }
  return { engine: 'dreamina', reason, engines, hasAudio };
}

module.exports = {
  DREAMINA_VIDEO_MODELS, LEGACY_NAMES,
  DREAMINA_RATIOS, DREAMINA_CAPS, DREAMINA_CAPS_DEFAULT,
  DREAMINA_LIMIT_RULES, DREAMINA_LIMITS_DEFAULT,
  dreaminaModelOf, isKnown, isLegacyName, enginesFor, groupOf, sameFamily,
  labelOf, engineLabel, capsFor, limitsFor, limitFamilyOf, imageLimitFor, clampDuration, routeEngine
};
