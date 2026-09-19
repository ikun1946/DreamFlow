'use strict';
/* ============================================================
   util.js —— 统一信封 / ApiError / 请求体读取 / 小工具
   与前端 app/api.js 的 httpRoute() 严格对齐：
   { code, message, data, traceId }，code !== 0 视为业务失败
   ============================================================ */
const crypto = require('crypto');

const ERR = {
  OK: 0,
  PARAM: 40001, UNAUTH: 40100, FORBIDDEN: 40300, NOTFOUND: 40400,
  CONFLICT: 40900, RATELIMIT: 42900, INTERNAL: 50000,
  CLI_DOWN: 51001, NO_CREDIT: 51002, AUDIT: 51003, UPSTREAM_TIMEOUT: 51004, INTERRUPTED: 51005
};

class ApiError extends Error {
  constructor(code, message, data) {
    super(message || '请求失败');
    this.code = code; this.data = data == null ? null : data;
  }
}

const traceId = () => crypto.randomBytes(4).toString('hex');
const rid = (p) => p + crypto.randomBytes(4).toString('hex');
const nowIso = () => new Date().toISOString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function ok(res, data, extraStatus) {
  sendJson(res, extraStatus || 200, { code: 0, message: 'ok', data: data == null ? null : data, traceId: traceId() });
}

function fail(res, err) {
  const isApi = err instanceof ApiError;
  const code = isApi ? err.code : ERR.INTERNAL;
  const message = isApi ? err.message : '服务内部错误';
  const data = isApi ? err.data : null;
  sendJson(res, 200, { code, message, data, traceId: traceId() });
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limitBytes || 1024 * 1024)) { reject(new ApiError(ERR.PARAM, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = (req.headers['content-type'] || '');
      if (!ct.includes('application/json')) return resolve(buf);   // 非 JSON = 原始字节（文件上传）
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch (e) { reject(new ApiError(ERR.PARAM, '请求体不是合法 JSON')); }
    });
    req.on('error', () => reject(new ApiError(ERR.INTERNAL, '读取请求体失败')));
  });
}

/* 与前端 api.js grad() 同源：由 ID 派生稳定渐变，保持演示视觉一致 */
const GRADS = [
  'linear-gradient(135deg,#2B3A55,#5B7A9E)',
  'linear-gradient(135deg,#4A3550,#9A6B8E)',
  'linear-gradient(135deg,#2F4A38,#5E9E78)',
  'linear-gradient(135deg,#5A4326,#B08D52)',
  'linear-gradient(135deg,#33384A,#6E7A99)',
  'linear-gradient(135deg,#54303A,#A06070)'
];
function grad(seed) {
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) >>> 0;
  return GRADS[h % GRADS.length];
}

module.exports = { ERR, ApiError, traceId, rid, nowIso, clamp, sendJson, ok, fail, readBody, grad };
