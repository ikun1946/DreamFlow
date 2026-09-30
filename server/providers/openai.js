'use strict';
/* ============================================================
   providers/openai.js —— OpenAI 图像生成适配器（0.42.0）

   当前支持的 model：GPT Image 2.5 Flare。
   同步返回：POST /v1/images/generations → { created, data: [{ b64_json }] }

   把同步返回包成"立即成功的异步任务" —— submit 拿到 taskId 后
   base64 只留在内存，image-jobs.js 验证图片并写入候选文件；不可落库。

   ⚠ 约束：
   1. GPT Image 只返回 b64_json，不能传旧模型的 response_format=url。
   2. 提交请求**不做自动重试**（沿用 _shared.js 顶层约定）。
   3. 密钥只进不出。
   4. 尺寸以 image-registry 的 model sizeSpec 为准，比例换成合法 WxH，
      像素模式在提交前再次校验，不把非法值发送到计费接口。
   ============================================================ */
const SHARED = require('./_shared');
const { callJson, mkErr, kindOfStatus, messageOfBody, SUBMIT_TIMEOUT_MS } = SHARED;
const SZ = require('../image-size');
const { randomBytes } = require('crypto');

function makeOpenaiAdapter(cfg, model, opts) {
  const o = opts || {};
  const c = cfg || {};
  const base = String(o.baseUrl || model.provider.defaultBaseUrl).replace(/\/+$/, '');
  const modelId = String(model.model.modelId);

  function apiKey() {
    const v = typeof c.apiKey === 'function' ? c.apiKey() : c.apiKey;
    return typeof v === 'string' ? v.trim() : '';
  }
  function configured() { return apiKey().length > 0; }
  function status() {
    return { configured: configured(), provider: 'openai', model: modelId, baseUrl: base };
  }
  function authHeaders() { return { 'Authorization': 'Bearer ' + apiKey() }; }

  /* 比例转成模型接受的 WxH；auto 原样交给服务商。 */
  function normalizeSize(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw || raw === 'auto') return 'auto';
    if (/^\d+x\d+$/i.test(raw)) {
      const wh = raw.toLowerCase().split('x').map(Number);
      const valid = SZ.validate(model.model.sizeSpec, wh[0], wh[1]);
      return valid.ok ? valid.size : mkErr('param', 'OpenAI ' + modelId + ' 不支持的尺寸：' + raw);
    }
    const sized = SZ.ratioToSize(model.model.sizeSpec, raw, 1024 * 1024);
    if (!sized) return mkErr('param', 'OpenAI ' + modelId + ' 不支持的比例：' + raw);
    return sized.width + 'x' + sized.height;
  }

  async function submit(prompt, submitOpts) {
    if (!configured()) return mkErr('config', '未配置 OpenAI API Key');
    const text = String(prompt == null ? '' : prompt);
    if (!text.trim()) return mkErr('config', '提示词不能为空');

    const so = submitOpts || {};
    const sizeResult = normalizeSize(so.size);
    if (sizeResult && sizeResult.kind) return sizeResult;

    const body = {
      model: modelId,
      prompt: text,
      n: 1,
      size: sizeResult,
      output_format: 'png'
    };
    if (so.quality) body.quality = so.quality;

    const r = await callJson({
      url: base + '/v1/images/generations',
      method: 'POST',
      headers: authHeaders(),
      timeoutMs: Math.max(SUBMIT_TIMEOUT_MS, 120000),
      body: body,
      maxBodyBytes: SHARED.MAX_IMAGE_BODY_BYTES
    });
    if (!r) return mkErr('network', '请求 OpenAI 失败');
    if (r.kind) return r;
    if (r.status < 200 || r.status >= 300) {
      return mkErr(kindOfStatus(r.status), messageOfBody(r.raw, r.status), { status: r.status });
    }
    if (!r.json || typeof r.json !== 'object') {
      return mkErr('protocol', 'OpenAI 提交响应不是合法 JSON（HTTP ' + r.status + '）');
    }
    const arr = Array.isArray(r.json.data) ? r.json.data : null;
    if (!arr || !arr.length) return mkErr('protocol', 'OpenAI 提交响应缺少 data 数组');
    const first = arr[0] || {};
    if (typeof first.b64_json !== 'string' || !first.b64_json) {
      return mkErr('protocol', 'OpenAI 响应缺少 b64_json 图片数据');
    }
    const taskId = 'oai_' + randomBytes(12).toString('hex');
    return { taskId: taskId, syncInlineBase64: first.b64_json, usage: r.json.usage || null, syncResult: true };
  }

  async function query(taskId) {
    /* 同步 provider 不应触发远端轮询。 */
    if (!configured()) return mkErr('config', '未配置 OpenAI API Key');
    const id = String(taskId || '');
    if (!id || id.indexOf('oai_') !== 0) return mkErr('protocol', 'OpenAI 任务 ID 格式不正确');
    return mkErr('protocol', 'OpenAI 同步任务应由 submit 阶段直接完成下载；此处不应被调用');
  }

  return {
    providerId: 'openai',
    modelId: modelId,
    configured, status, submit, query,
    _internals: { base, modelId, submitTimeoutMs: 120000 }
  };
}

module.exports = { makeOpenaiAdapter, id: 'openai' };
