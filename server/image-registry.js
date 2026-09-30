'use strict';
/* ============================================================
   image-registry.js —— 生图 provider / model 的声明式注册表（0.42.0）

   为什么独立一份声明式注册表（而不是把 provider 信息散落在适配器里）：
   · "这台 DreamFlow 装了哪些 provider"是一个**事实**，应当集中描述、便于审阅
     和按需增减；适配器只负责"接到 providerId / modelId 后怎么发请求"。
   · **尺寸规则是 per-model 的事实** —— Work Fisher / GPT Image 的 16 倍数 ≤3840
     约束来自各自模型。
     把 sizeSpec 挂在 model 上，/meta/options / 前端控件 / 服务端校验三方从
     同一份声明读，**永远不会漂移**。
   · **添加新 provider / model 只需在本文件追加一条 + 在 server/providers/ 新增
     一个适配器**，不用动 image-size.js / services.js / app/app.js 任何位置。

   0.42.5 已按 OpenAI / Stability 官方接口文档复核请求体与响应形状。
   ============================================================ */

/* 比例枚举 —— Work Fisher / OpenAI / Stability 都按比例发请求，
   只是可选子集不同。这里给"完整枚举"，每个 provider 在自己的
   sizeSpec.ratios 里裁剪；UI 也按 sizeSpec.ratios 渲染下拉。 */
const RATIO_ENUM = [
  '1:1', '4:3', '3:4', '16:9', '9:16',
  '3:2', '2:3', '5:4', '4:5',
  '2:1', '1:2', '21:9', '9:21', '3:1', '1:3'
];
const RATIO_AUTO = 'auto';

/* ---------------- 各 provider / model 的 sizeSpec ----------------
   字段含义：
   - ratios        支持的比例集合（不含 auto）；前端按这个渲染比例下拉
   - resolutions   支持的分辨率档；null 表示该 model 不接受分辨率参数
   - fixedSizes    像素模式被禁时的"固定尺寸"列表（OpenAI 用）；null 表示
                  该 model 不需要固定尺寸
   - pixelMode     是否允许用户输入自定义像素尺寸
   - presets       像素预设；仅 Work Fisher 用，其他 null
   - step / max / min / maxRatio / minPixels / maxPixels 与 0.41.0
     image-size.js LIMITS 一致；这里每个 model 自带一份
*/
const RATIO_ALL = RATIO_ENUM.slice();

/* Work Fisher —— v2.5 系（Flare / Sunburst）请求形状相同：
   平铺参数，比例枚举 + 分辨率档 + 像素模式均支持。 */
const WF_RATIOS = RATIO_ALL;
const WF_RESOLUTIONS = ['1k', '2k', '4k'];
const WF_PRESETS = [
  { id: '1080p', label: '1080p', width: 1920, height: 1088, hint: '1920 × 1088（16 倍数对齐）' },
  { id: '2k', label: '2K', width: 2560, height: 1440, hint: '2560 × 1440' },
  { id: '4k', label: '4K', width: 3840, height: 2160, hint: '3840 × 2160（单边与总像素上限）' },
  { id: 'square', label: '方形', width: 1088, height: 1088, hint: '1088 × 1088' },
  { id: 'vertical', label: '竖屏 1080', width: 1088, height: 1920, hint: '1088 × 1920' }
];
const WF_LIMITS = { step: 16, min: 256, max: 3840, minPixels: 655360, maxPixels: 8294400, maxRatio: 3 };

/* GPT Image 2.5 Flare：旧 DALL·E 3 已从 API 移除。新模型支持 16 倍数
   的自定义尺寸并同步返回 base64；规则仍通过 sizeSpec 下发。 */
const OAI_RATIOS = RATIO_ALL;
const OAI_LIMITS = { step: 16, min: 256, max: 3840, minPixels: 655360, maxPixels: 8294400, maxRatio: 3 };

/* Stability AI —— aspect_ratio 字符串枚举；不同 endpoint 支持的子集略有不同，
   这里给 v2beta/stable-image/generate/{core|sd3|ultra} 的常用子集。
   同步返回；只接受 aspect_ratio，不接受像素模式 / 分辨率。 */
const STA_RATIOS = ['1:1', '16:9', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21'];
const STA_LIMITS = { step: 1, min: 256, max: 1536, minPixels: 512 * 512, maxPixels: 1536 * 1536, maxRatio: 21 / 9 };

/* ---------------- 注册表 ----------------
   每个 provider 是一个独立 entry，包含元信息 + model 列表；
   model 列表里每个 model 自带 sizeSpec 与 endpoint。
   ⚠ providerId / modelId 是**协议稳定字符串**（会出现在落库与配置里），
   改名等于让已有配置变成"未知 provider"。
*/
const REGISTRY = [
  {
    providerId: 'work-fisher',
    providerLabel: 'Work Fisher',
    providerKeyEnv: 'WORK_FISHER_API_KEY',
    defaultBaseUrl: 'https://api.work-fisher.com',
    description: '素材库图片资产的生图服务（Work Fisher · Image G v2.5 Flare）',
    models: [
      {
        modelId: 'workfisher-image-g-v2.5-flare',
        modelLabel: 'Image G v2.5 Flare（官方推荐 · 文生图）',
        endpoint: 'image-generations',     /* 适配器内部据此拼路径 */
        supportsReferenceImage: false,
        sizeSpec: {
          ratios: WF_RATIOS,
          resolutions: WF_RESOLUTIONS,
          fixedSizes: null,
          pixelMode: true,
          presets: WF_PRESETS,
          limits: WF_LIMITS
        }
      },
      {
        modelId: 'workfisher-image-g-v2.5-sunburst',
        modelLabel: 'Image G v2.5 Sunburst（v2.5 族 · 文生图）',
        endpoint: 'image-generations',
        supportsReferenceImage: false,
        sizeSpec: {
          ratios: WF_RATIOS,
          resolutions: WF_RESOLUTIONS,
          fixedSizes: null,
          pixelMode: true,
          presets: WF_PRESETS,
          limits: WF_LIMITS
        }
      }
    ]
  },
  {
    providerId: 'openai',
    providerLabel: 'OpenAI',
    providerKeyEnv: 'OPENAI_API_KEY',
    defaultBaseUrl: 'https://api.openai.com',
    description: 'OpenAI 图像生成（GPT Image 2.5 Flare · 同步返回）',
    models: [
      {
        modelId: 'gpt-image-2.5-flare',
        modelLabel: 'GPT Image 2.5 Flare（OpenAI · 同步）',
        endpoint: 'image-generations',
        supportsReferenceImage: false,
        sizeSpec: {
          ratios: OAI_RATIOS,
          resolutions: null,             /* 不接受 resolution 字段 */
          fixedSizes: null,
          pixelMode: true,
          presets: null,
          limits: OAI_LIMITS
        }
      }
    ]
  },
  {
    providerId: 'stability',
    providerLabel: 'Stability AI',
    providerKeyEnv: 'STABILITY_API_KEY',
    defaultBaseUrl: 'https://api.stability.ai',
    description: 'Stability AI 图像生成（Stable Image Core/SD3/Ultra · 同步）',
    models: [
      {
        modelId: 'stable-image-core',
        modelLabel: 'Stable Image Core（Stability AI · 同步）',
        endpoint: 'core',
        supportsReferenceImage: false,
        sizeSpec: {
          ratios: STA_RATIOS,
          resolutions: null,
          fixedSizes: null,              /* aspect_ratio 字符串，不写像素 */
          pixelMode: false,
          presets: null,
          limits: STA_LIMITS
        }
      },
      {
        modelId: 'stable-image-ultra',
        modelLabel: 'Stable Image Ultra（Stability AI · 高质量）',
        endpoint: 'ultra',
        supportsReferenceImage: false,
        sizeSpec: {
          ratios: STA_RATIOS,
          resolutions: null,
          fixedSizes: null,
          pixelMode: false,
          presets: null,
          limits: STA_LIMITS
        }
      }
    ]
  }
];

/* ---------------- 查找辅助 ---------------- */
function findProvider(providerId) {
  const id = String(providerId || '').trim();
  return REGISTRY.find((p) => p.providerId === id) || null;
}
function findModel(providerId, modelId) {
  const p = findProvider(providerId);
  if (!p) return null;
  const m = p.models.find((x) => x.modelId === modelId);
  return m || null;
}
/* 旧 0.41.x 落库 / 旧客户端请求可能没带 model —— 默认 = Work Fisher v2.5 Flare，
   与实施计划 §2 老客户端兼容口径一致。 */
function defaultProviderId() { return 'work-fisher'; }
function defaultModelId() { return 'workfisher-image-g-v2.5-flare'; }
function defaultModelEntry() {
  return {
    providerId: defaultProviderId(),
    modelId: defaultModelId(),
    provider: findProvider(defaultProviderId()),
    model: findModel(defaultProviderId(), defaultModelId())
  };
}

/* ---------------- 列举 ---------------- */
function listProviders() { return REGISTRY.slice(); }
function listModels(providerId) {
  const p = findProvider(providerId);
  return p ? p.models.slice() : [];
}

/* ---------------- 校验 ----------------
   非法 providerId / modelId 由上层（routes / services）调用，给前端清晰错误。 */
function requireProvider(providerId) {
  const p = findProvider(providerId);
  if (!p) {
    const e = new Error('未知的生图服务商：' + providerId);
    e.code = 'unknown_provider';
    throw e;
  }
  return p;
}
function requireModel(providerId, modelId) {
  const p = requireProvider(providerId);
  const m = findModel(providerId, modelId);
  if (!m) {
    const e = new Error('未知的模型：' + providerId + '/' + modelId);
    e.code = 'unknown_model';
    throw e;
  }
  return { provider: p, model: m };
}

/* ---------------- 协议稳定字段：/meta/options 下发 ----------------
   给前端的最小集 —— providerId / modelId / label（足够 UI 渲染选择器），
   以及 sizeSpec（足够前端渲染尺寸控件）。不带 baseUrl、不带 providerKeyEnv。 */
function specForFrontend() {
  const out = [];
  REGISTRY.forEach((p) => {
    p.models.forEach((m) => {
      out.push({
        providerId: p.providerId,
        providerLabel: p.providerLabel,
        modelId: m.modelId,
        modelLabel: m.modelLabel,
        supportsReferenceImage: !!m.supportsReferenceImage,
        sizeSpec: m.sizeSpec
      });
    });
  });
  return out;
}

module.exports = {
  REGISTRY,
  RATIO_ENUM,
  RATIO_AUTO,
  findProvider, findModel,
  listProviders, listModels,
  requireProvider, requireModel,
  defaultProviderId, defaultModelId, defaultModelEntry,
  specForFrontend
};
