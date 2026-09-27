'use strict';
/* ============================================================
   image-provider.js —— 生图 provider 适配器工厂（0.42.0）

   从原"只包 Work Fisher"的实现（0.41.0）重构为按 providerId / modelId
   分发的工厂。**共用 HTTP / 错误 / 脱敏工具**搬到 server/providers/_shared.js；
   三个适配器实现在 server/providers/{work-fisher,openai,stability}.js。

   注册表是声明式的（server/image-registry.js），加新 provider 只需：
     1) 在 registry 里加一条 provider + model 配置；
     2) 在 server/providers/ 加一个 adapter 文件；
     3) 在本文件的 adapterByProvider 索引里加一行。
   不需要改 services.js / app.js / image-size.js 任何位置。

   ⚠ 适配器接口契约（每个 adapter 都暴露这五项）：
     configured()                → boolean
     status()                    → { configured, provider, model, baseUrl }
     submit(prompt, opts)        → { taskId, resultUrl?, syncInlineBase64?, syncResult?, usage? } | { kind, message, ... }
     query(taskId)               → { state, resultUrl?, usage?, failReason? } | { kind, ... }
   image-jobs.js 的状态机**对所有 provider 一致**：
     · 异步 provider（Work Fisher）：submit 返 taskId；state=QUEUED；按 taskId 轮询 query
     · 同步 provider（OpenAI / Stability）：submit 同步返 resultUrl 或 base64；
       state 直接跳到 SAVING_RESULT；不轮询。
   ============================================================ */
const REGISTRY = require('./image-registry');

const WORK_FISHER = require('./providers/work-fisher');
const OPENAI = require('./providers/openai');
const STABILITY = require('./providers/stability');

const adapterByProvider = {
  'work-fisher': WORK_FISHER.makeWorkFisherAdapter,
  'openai': OPENAI.makeOpenaiAdapter,
  'stability': STABILITY.makeStabilityAdapter
};

/* 兼容旧 0.41.x 接口的导出 —— 旧代码（test/11、单测）以
   `makeImageProvider({ apiKey, baseUrl, model, transport })` 调用，
   仍要工作。返回的实例**也是**新形状的 adapter（暴露 configured/status/submit/query）。
*/
function makeImageProvider(cfg, opts) {
  const o = opts || {};
  /* 旧调用：cfg.apiKey / opts.baseUrl / opts.model
     新调用：cfg.apiKey / opts.providerId / opts.modelId / opts.baseUrl
     未指定 providerId / modelId → 默认 Work Fisher + v2.5 Flare，与 0.41.x 行为一致。 */
  const providerId = String(o.providerId || 'work-fisher');
  const factory = adapterByProvider[providerId];
  if (!factory) {
    const e = new Error('未注册的 provider：' + providerId);
    e.code = 'unknown_provider';
    throw e;
  }
  const entry = REGISTRY.requireProvider(providerId);
  /* 兼容旧调用 cfg.apiKey + opts.model（model 是裸 modelId）。
     若 caller 指定的 modelId 不在该 provider 下，回退到该 provider 的第一个 model —— 否则
     providerId=openai + modelId=workfisher-... 这种（启动时按 provider 默认 model 错配）会
     立即抛 unknown_model。 */
  let modelId = String(o.modelId || o.model || entry.models[0].modelId);
  let modelEntry = REGISTRY.findModel(providerId, modelId);
  if (!modelEntry) modelEntry = entry.models[0];
  modelId = modelEntry.modelId;
  return factory(cfg, { provider: entry, model: modelEntry }, o);
}

/* 暴露注册表，让调用方（services.js / image-jobs.js / main.js）能：
   · 知道一共有哪些 provider（用于 /system/image-providers）
   · 校验 providerId / modelId（无需自己再 import registry） */
const providersList = REGISTRY.listProviders;
const requireModel = REGISTRY.requireModel;
const defaultProviderId = REGISTRY.defaultProviderId;
const defaultModelId = REGISTRY.defaultModelId;

/* 重新导出 _shared 的传输层与脱敏工具 —— 单测与外部诊断可继续
   setTransport() / getRedact() 等。 */
const SHARED = require('./providers/_shared');
const setTransport = SHARED.setTransport;
const transport = SHARED.transport;
const redact = SHARED.redact;
const kindOfStatus = SHARED.kindOfStatus;
const messageOfBody = SHARED.messageOfBody;

/* 兼容 0.41.0 默认值（旧代码可能 import 这俩） */
const DEFAULT_BASE = 'https://api.work-fisher.com';
const DEFAULT_MODEL = 'workfisher-image-g-v2.5-flare';

module.exports = {
  makeImageProvider,
  /* 新接口（0.42.0） */
  listProviders: providersList,
  requireModel,
  defaultProviderId,
  defaultModelId,
  /* 兼容 0.41.x 导出（test/11 / 旧 import） */
  setTransport, transport, redact, kindOfStatus, messageOfBody,
  DEFAULT_BASE, DEFAULT_MODEL
};