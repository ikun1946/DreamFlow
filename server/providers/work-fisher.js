'use strict';
/* ============================================================
   providers/work-fisher.js —— Work Fisher 生图适配器（0.42.0）

   从原 server/image-provider.js 抽出（原 0.41.0 仅支持 v2.5-Flare）。
   异步模型：submit 返 taskId；上层按 taskId 轮询 query。

   ⚠ 约束（沿用 0.41.0 文件顶部的五条）：
   1. 只按 v2.5-flare 的官方示例实现（平铺参数）。Seedream 系参数在 metadata
      对象里 —— 想"顺手兼容"的结果通常是两边都写错。
   2. 提交路径是单数的 `image`：/v1/image/generations（不是 images）。
   3. 提交请求不做自动重试。
   4. 缺字段时报告协议错误，不猜。
   5. 密钥只进不出。
   ============================================================ */
const SHARED = require('./_shared');
const { callJson, mkErr, kindOfStatus, messageOfBody, SUBMIT_TIMEOUT_MS, QUERY_TIMEOUT_MS } = SHARED;

function makeWorkFisherAdapter(cfg, model, opts) {
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
    return { configured: configured(), provider: 'work-fisher', model: modelId, baseUrl: base };
  }
  function authHeaders() { return { 'Authorization': 'Bearer ' + apiKey() }; }

  async function submit(prompt, submitOpts) {
    if (!configured()) return mkErr('config', '未配置生图服务的 API Key');
    const text = String(prompt == null ? '' : prompt);
    if (!text.trim()) return mkErr('config', '提示词不能为空');

    const so = submitOpts || {};
    const body = {
      model: modelId,
      prompt: text,
      n: 1,
      quality: 'auto',
      output_format: 'png'
    };
    const size = so.size == null ? '' : String(so.size).trim();
    if (size) {
      body.size = size;
      if (size.indexOf('x') < 0) body.resolution = so.resolution || '1k';
    } else {
      body.resolution = so.resolution || '1k';
    }

    const r = await callJson({
      url: base + '/v1/image/generations',
      method: 'POST',
      headers: authHeaders(),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      body: body
    });
    if (!r) return mkErr('network', '请求服务商失败');
    if (r.kind) return r;
    if (r.status < 200 || r.status >= 300) {
      return mkErr(kindOfStatus(r.status), messageOfBody(r.raw, r.status), { status: r.status });
    }
    if (!r.json || typeof r.json !== 'object') {
      return mkErr('protocol', '提交响应不是合法 JSON（HTTP ' + r.status + '）');
    }
    const d = r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json;
    const taskId = d.task_id || d.id || null;
    if (!taskId) {
      return mkErr('protocol', '提交响应没有任务 ID（缺 task_id / id）', { status: r.status });
    }
    return { taskId: String(taskId), resultUrl: null, usage: null };
  }

  async function query(taskId) {
    if (!configured()) return mkErr('config', '未配置生图服务的 API Key');
    const id = String(taskId || '');
    if (!id) return mkErr('protocol', '缺少任务 ID');

    const r = await callJson({
      url: base + '/v1/image/generations/' + encodeURIComponent(id),
      method: 'GET',
      headers: authHeaders(),
      timeoutMs: QUERY_TIMEOUT_MS
    });
    if (!r) return mkErr('network', '请求服务商失败');
    if (r.kind) return r;
    if (r.status < 200 || r.status >= 300) {
      return mkErr(kindOfStatus(r.status), messageOfBody(r.raw, r.status), { status: r.status });
    }
    if (!r.json || typeof r.json !== 'object') {
      return mkErr('protocol', '查询响应不是合法 JSON（HTTP ' + r.status + '）');
    }
    const d = r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json;
    const rawStatus = String(d.status || d.state || '').toUpperCase();

    const usage = normalizeUsage(d.usage);

    if (/FAIL|ERROR|REJECT|CANCEL/.test(rawStatus)) {
      return {
        state: 'failed',
        failReason: String(d.error_message || d.fail_reason || d.message || d.reason || ('服务商状态：' + rawStatus)).slice(0, 300),
        usage: usage
      };
    }
    if (/SUCCESS|SUCCEED|DONE|COMPLETE/.test(rawStatus)) {
      const resultUrl = d.result_url || d.resultUrl || null;
      if (!resultUrl) return mkErr('protocol', '任务已成功但响应缺少结果地址（result_url）');
      return { state: 'succeeded', resultUrl: String(resultUrl), usage: usage };
    }
    return { state: /RUNNING|PROCESS/.test(rawStatus) ? 'running' : 'queued', rawStatus: rawStatus };
  }

  function normalizeUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const out = {};
    Object.keys(u).forEach((k) => {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (typeof v === 'string' && v && /^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    });
    return Object.keys(out).length ? out : null;
  }

  return {
    providerId: 'work-fisher',
    modelId: modelId,
    configured, status, submit, query,
    _internals: { base, modelId, submitTimeoutMs: SUBMIT_TIMEOUT_MS, queryTimeoutMs: QUERY_TIMEOUT_MS }
  };
}

module.exports = { makeWorkFisherAdapter, id: 'work-fisher' };