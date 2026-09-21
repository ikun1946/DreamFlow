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
  CLI_DOWN: 51001, NO_CREDIT: 51002, AUDIT: 51003, UPSTREAM_TIMEOUT: 51004, INTERRUPTED: 51005,
  /* ---------------- 外部工具状态（2026-09-21 新增） ----------------
     背景：dreamina / ffmpeg / ffprobe 缺失时，原先只有自由文本
     （external-tools.js 的 "未找到"、dreamina-cli.js 的静默 null）。
     前端拿不到稳定的判别依据，只能做字符串匹配 —— 脆且不可测。
     这一组码给"缺哪个工具 / 哪种失败"一个**可编程**的表达：
       后端错误响应 · 前端提示 · 日志文本 · 可执行解决动作 四件套都挂在它上面。
     取值区间 511xx，与已有的 510xx（CLI 运行期错误）分开，
     便于前端一眼区分"环境没装好"和"跑起来之后失败了"。 */
  CLI_NOT_FOUND: 51101,          // dreamina 可执行文件找不到
  CLI_NOT_LOGGED_IN: 51102,      // 装了但没登录（auth status 未通过）
  CLI_PERMISSION_DENIED: 51103,  // 被会员闸门/策略拒绝（不可重试）
  FFMPEG_NOT_FOUND: 51104,       // 缺 ffmpeg：无法抽封面
  FFPROBE_NOT_FOUND: 51105       // 缺 ffprobe：无法读音频时长
};

/* 外部工具类错误码的判别集合（前端/测试都用它，避免散落的 === 比较） */
const TOOL_ERROR_CODES = [
  ERR.CLI_NOT_FOUND, ERR.CLI_NOT_LOGGED_IN, ERR.CLI_PERMISSION_DENIED,
  ERR.FFMPEG_NOT_FOUND, ERR.FFPROBE_NOT_FOUND
];

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

module.exports = { ERR, TOOL_ERROR_CODES, ApiError, traceId, rid, nowIso, clamp, sendJson, ok, fail, readBody, grad };
