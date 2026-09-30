'use strict';
/* ============================================================
   providers/stability.js —— Stability AI 图像生成适配器（0.42.0）

   当前支持的 model：stable-image-core / stable-image-ultra（均走 v2beta）。

   同步返回：POST /v2beta/stable-image/generate/{core|ultra}
     请求：{ prompt, aspect_ratio, seed?, output_format }
     响应：{ image: <base64>, finish_reason, seed }
     鉴权：Authorization: Bearer <key>

   同步 provider 的契约与 OpenAI adapter 同形 —— submit 返
   { taskId, resultUrl, syncResult: true }，状态机走 SAVING_RESULT
   直接下载；不再走轮询。差异点：
   1. Stability 返回的是 base64 字符串，**不是 URL**；本 adapter 把它
      包成 data: URL（与下载阶段 https-only 不冲突 —— 详见 image-jobs.js
      downloadImage 的协议检查 —— 实际上 data: 也会被拒）。
      → 因此 Stability 的同步结果**不经过 https 下载**，而是直接解码落盘。
   2. 但为了与状态机兼容（image-jobs.js 的下载阶段假设 https URL），
      这里用 taskId 携带 base64 内容，image-jobs.js 的 step() 见到
      `syncInlineBase64` 字段时直接 decode 落盘，跳过下载阶段。

   ⚠ 约束：
   1. 提交请求**不做自动重试**。
   2. 密钥只进不出。
   3. aspect_ratio 必须是文档枚举；非法值直接 40001-style 报错，绝不发给服务商。
   ============================================================ */
const SHARED = require('./_shared');
const { callJson, mkErr, kindOfStatus, messageOfBody, SUBMIT_TIMEOUT_MS } = SHARED;
const { randomBytes } = require('crypto');

const STABILITY_ASPECT_RATIOS = [
  '1:1', '16:9', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21'
];

function makeStabilityAdapter(cfg, model, opts) {
  const o = opts || {};
  const c = cfg || {};
  const base = String(o.baseUrl || model.provider.defaultBaseUrl).replace(/\/+$/, '');
  const modelId = String(model.model.modelId);
  const endpoint = String(model.model.endpoint || 'core');

  function apiKey() {
    const v = typeof c.apiKey === 'function' ? c.apiKey() : c.apiKey;
    return typeof v === 'string' ? v.trim() : '';
  }
  function configured() { return apiKey().length > 0; }
  function status() {
    return { configured: configured(), provider: 'stability', model: modelId, baseUrl: base };
  }
  function authHeaders() { return { 'Authorization': 'Bearer ' + apiKey(), 'Accept': 'application/json' }; }

  function normalizeAspectRatio(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return '1:1';
    if (STABILITY_ASPECT_RATIOS.indexOf(raw) >= 0) return raw;
    return mkErr('param', 'Stability ' + modelId + ' 不支持的比例：' + raw + '（仅 ' + STABILITY_ASPECT_RATIOS.join(' / ') + '）');
  }

  async function submit(prompt, submitOpts) {
    if (!configured()) return mkErr('config', '未配置 Stability API Key');
    const text = String(prompt == null ? '' : prompt);
    if (!text.trim()) return mkErr('config', '提示词不能为空');

    const so = submitOpts || {};
    const aspect = normalizeAspectRatio(so.size);
    if (aspect && aspect.kind) return aspect;

    const fields = {
      prompt: text,
      aspect_ratio: aspect,
      output_format: 'png'
    };
    if (so.seed != null) fields.seed = Number(so.seed);
    /* Stability v2beta 文档要求 multipart/form-data；JSON 请求会被 415/400 拒绝。
       无文件上传时仍须按表单编码，边界每次随机以免提示词碰撞。 */
    const boundary = 'dreamflow-' + randomBytes(12).toString('hex');
    const rawBody = Buffer.from(Object.entries(fields).map(([name, value]) =>
      '--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' +
      String(value) + '\r\n').join('') + '--' + boundary + '--\r\n', 'utf8');

    const r = await callJson({
      url: base + '/v2beta/stable-image/generate/' + endpoint,
      method: 'POST',
      headers: Object.assign(authHeaders(), { 'Content-Type': 'multipart/form-data; boundary=' + boundary }),
      timeoutMs: Math.max(SUBMIT_TIMEOUT_MS, 120000),
      rawBody: rawBody,
      maxBodyBytes: SHARED.MAX_IMAGE_BODY_BYTES
    });
    if (!r) return mkErr('network', '请求 Stability 失败');
    if (r.kind) return r;
    if (r.status < 200 || r.status >= 300) {
      return mkErr(kindOfStatus(r.status), messageOfBody(r.raw, r.status), { status: r.status });
    }
    if (!r.json || typeof r.json !== 'object') {
      return mkErr('protocol', 'Stability 响应不是合法 JSON（HTTP ' + r.status + '）');
    }
    const b64 = r.json.image || null;
    if (!b64 || typeof b64 !== 'string') {
      return mkErr('protocol', 'Stability 响应缺少 image 字段（base64 字符串）');
    }
    /* ⚠ inlineBase64 携带的是**用户已付费生成的图**，不进 DB 不进网络，
       仅在 step() 阶段由 image-jobs.js decode 落盘到项目目录后即弃。 */
    const taskId = 'sta_' + Buffer.from(String(Date.now()) + Math.random().toString()).toString('base64').replace(/=+$/, '').slice(0, 32);
    return { taskId: taskId, syncInlineBase64: b64, usage: null, syncResult: true };
  }

  async function query(taskId) {
    /* 与 OpenAI adapter 同：同步 provider 不应被 query() —— 应由 submit() 同步完成。 */
    if (!configured()) return mkErr('config', '未配置 Stability API Key');
    return mkErr('protocol', 'Stability 同步任务不应触发 query()（应由 submit 阶段直接落盘）');
  }

  return {
    providerId: 'stability',
    modelId: modelId,
    configured, status, submit, query,
    _internals: { base, modelId, submitTimeoutMs: SUBMIT_TIMEOUT_MS, supportedAspectRatios: STABILITY_ASPECT_RATIOS, endpoint: endpoint }
  };
}

module.exports = { makeStabilityAdapter, id: 'stability' };
