'use strict';
/* ============================================================
   providers/openai.js —— OpenAI 图像生成适配器（0.42.0）

   当前支持的 model：DALL·E 3。
   同步返回：POST /v1/images/generations → { created, data: [{ url | b64_json }] }

   把同步返回包成"立即成功的异步任务" —— submit 拿到 taskId 后
   query 立即返回 state=succeeded + resultUrl。这样 image-jobs.js 的
   状态机不用区分 sync / async，poll 循环第一次就拿到 succeeded，
   走原有的 download 路径。

   ⚠ 约束：
   1. b64_json 暂不实现 —— 文档允许但需要自己 base64 解码成图字节；
      URL 路径更短、下载阶段 image-jobs.js 已经处理。
   2. 提交请求**不做自动重试**（沿用 _shared.js 顶层约定）。
   3. 密钥只进不出。
   4. size 字段：OpenAI 只接受三种固定值（1024x1024 / 1024x1792 /
      1792x1024）；registry 已声明 pixelMode=false，前端不会发像素模式。
      但服务端仍做最后一道校验，遇到不在 [1024x1024, 1024x1792, 1792x1024]
      的 size 直接 40001-style 报错，绝不发给服务商。
   ============================================================ */
const SHARED = require('./_shared');
const { callJson, mkErr, kindOfStatus, messageOfBody, SUBMIT_TIMEOUT_MS } = SHARED;

const OPENAI_FIXED_SIZES = ['1024x1024', '1024x1792', '1792x1024'];

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

  /* 把 size 字段按 OpenAI 要求归一。
     只接受 'WxH' 形态；UI 发的比例（'16:9' 等）或 'auto' 必须先转。
     registry 的 sizeSpec.fixedSizes 给 UI 展示，但实际转换在这里做。 */
  function normalizeSize(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return '1024x1024';   /* 不带 size → 用默认方形 */
    /* 已是 WxH 形态 */
    if (/^\d+x\d+$/i.test(raw)) {
      const lower = raw.toLowerCase();
      if (OPENAI_FIXED_SIZES.indexOf(lower) >= 0) return lower;
      return mkErr('param', 'OpenAI ' + modelId + ' 不支持的尺寸：' + raw + '（仅支持 ' + OPENAI_FIXED_SIZES.join(' / ') + '）');
    }
    /* 比例 → WxH */
    const ratioMap = { '1:1': '1024x1024', '16:9': '1792x1024', '9:16': '1024x1792' };
    const mapped = ratioMap[raw];
    if (!mapped) return mkErr('param', 'OpenAI ' + modelId + ' 不支持的比例：' + raw + '（仅 1:1 / 16:9 / 9:16）');
    return mapped;
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
      response_format: 'url'
    };
    if (so.quality) body.quality = so.quality;

    const r = await callJson({
      url: base + '/v1/images/generations',
      method: 'POST',
      headers: authHeaders(),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      body: body
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
    const resultUrl = first.url || null;
    if (!resultUrl) {
      /* b64_json 路径：未实现。明确告知上层「同步拿到了图但当前只支持 URL 路径」 */
      return mkErr('protocol', 'OpenAI 响应只回 b64_json 而非 URL，本版本暂不支持（请在请求中确保 response_format=url）');
    }
    /* 同步成功 —— 包成"立即成功的异步任务"，让 image-jobs.js 的状态机不用改 */
    const taskId = 'oai_' + Buffer.from(resultUrl).toString('base64').replace(/=+$/, '').slice(0, 32);
    return { taskId: taskId, resultUrl: String(resultUrl), usage: null, syncResult: true };
  }

  async function query(taskId) {
    /* 同步 provider：query 立即返 succeeded —— 不打外部网络。
       上层 image-jobs.js 拿到 succeeded 走 download 路径。 */
    if (!configured()) return mkErr('config', '未配置 OpenAI API Key');
    const id = String(taskId || '');
    if (!id || id.indexOf('oai_') !== 0) return mkErr('protocol', 'OpenAI 任务 ID 格式不正确');
    /* URL 从 taskId 还原：oai_<base64-url-fragment>，但提交时已 resultUrl 在调用栈里；
       image-jobs.js 实际拿到的不是 taskId 而是 download 用的 resultUrl。
       这里为了契约完整，仍尝试按本地上下文回 resultUrl，但更稳妥的是
       让调用方把 resultUrl 直接交给 download —— 见 image-jobs.js step()。 */
    return mkErr('protocol', 'OpenAI 同步任务应由 submit 阶段直接完成下载；此处不应被调用');
  }

  return {
    providerId: 'openai',
    modelId: modelId,
    configured, status, submit, query,
    _internals: { base, modelId, submitTimeoutMs: SUBMIT_TIMEOUT_MS, supportedSizes: OPENAI_FIXED_SIZES }
  };
}

module.exports = { makeOpenaiAdapter, id: 'openai' };