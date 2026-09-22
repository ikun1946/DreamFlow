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
  FFPROBE_NOT_FOUND: 51105,       // 缺 ffprobe：无法读音频时长
  /* ---------------- 上游语义错误（0.29.1 补全） ----------------
     背景：原先 CLI 没回 submit_id / 任务在即梦侧失败 / 模型需要首次合规确认 这三种
     场景都走 ERR.INTERNAL（50000）+ 自由文本 —— 前端只能拿到 message 字符串判断。
     现在给它们各自的码：
       NO_SUBMIT_ID        即梦端没创建任务就拒绝返回（极少见，多半是账号异常）；
       UPSTREAM_FAILED      即梦端明确返回了 fail_status（业务失败，可重试看官方策略）；
       MODEL_NEEDS_FIRST_RUN 模型首次合规未完成（前端据此显示"先去 web 端跑一次"的引导）。
     这条与已有 ERR.INTERNAL 不冲突：上游语义明确失败 = 51006/51007/51008，
     真正"内部代码自己炸了"才继续走 50000。 */
  NO_SUBMIT_ID: 51006,
  UPSTREAM_FAILED: 51007,
  MODEL_NEEDS_FIRST_RUN: 51008
};

/* ---------------- 错误码元数据（阶段 3 错误码四件套 · 0.29.1） ----------------
   之前 ERR 只是**数字 → 名字**的映射；前端拿到的只有 code + 自由文本 message，
   要根据"这是什么错"做不同处理时只能正则匹配 message（脆）。

   这一表把每个错误码绑一份**结构化元数据**：
     · category   —— 大类（参数/权限/资源/并发/上游/内部/工具/外部工具）
     · retryable  —— 是否可在客户端自动重试（前端据此决定要不要再点提交按钮）
     · http       —— 对应的 HTTP 状态（默认 200 + code；这里登记的是真实原因，
                     留作未来"严格 REST 化"的迁移参考 —— 现在 fail() 一律回 200）
     · hint       —— 人类可读建议（前端可以原样弹给用户）

   这是 ERR 的**补充**，不是替代 —— 已有 71 处 `throw new ApiError(code, msg)`
   不必改用 ERR_INFO.xxx 重新传一次；想查元数据就 `ERR_INFO[code]`，缺则返回
   `null`（前端按"未知码"兜底）。 */
const ERR_CATEGORIES = {
  PARAM: 'param', NOTFOUND: 'notfound', CONFLICT: 'conflict',
  UNAUTH: 'forbidden', FORBIDDEN: 'forbidden',
  RATELIMIT: 'ratelimit', INTERNAL: 'internal',
  CLI_DOWN: 'cli', CLI_NOT_FOUND: 'tool', CLI_NOT_LOGGED_IN: 'tool',
  CLI_PERMISSION_DENIED: 'cli', FFMPEG_NOT_FOUND: 'tool',
  FFPROBE_NOT_FOUND: 'tool',
  NO_CREDIT: 'cli', AUDIT: 'internal', UPSTREAM_TIMEOUT: 'cli',
  INTERRUPTED: 'cli', NO_SUBMIT_ID: 'cli', UPSTREAM_FAILED: 'cli',
  MODEL_NEEDS_FIRST_RUN: 'cli'
};

const ERR_RETRYABLE = {
  PARAM: false, NOTFOUND: false, CONFLICT: false, UNAUTH: false,
  FORBIDDEN: false, RATELIMIT: true, INTERNAL: false,
  CLI_DOWN: false, CLI_NOT_FOUND: false, CLI_NOT_LOGGED_IN: false,
  CLI_PERMISSION_DENIED: false, FFMPEG_NOT_FOUND: false, FFPROBE_NOT_FOUND: false,
  NO_CREDIT: false, AUDIT: false, UPSTREAM_TIMEOUT: true, INTERRUPTED: true,
  NO_SUBMIT_ID: false, UPSTREAM_FAILED: false, MODEL_NEEDS_FIRST_RUN: false
};

const ERR_HINTS = {
  PARAM: '检查请求参数（必填 / 类型 / 长度）',
  NOTFOUND: '资源已被删除或不在当前作用域',
  CONFLICT: '当前状态不允许该操作（参考 message 调整后重试）',
  UNAUTH: '重新打开应用或在设置里填入令牌',
  FORBIDDEN: '检查账号权限 / 更新源访问权',
  RATELIMIT: '稍后重试',
  INTERNAL: '服务内部错误，详见日志',
  CLI_DOWN: '创作 CLI 不可用：检查进程是否启动 / 路径是否正确',
  CLI_NOT_FOUND: '安装创作 CLI 后重启服务',
  CLI_NOT_LOGGED_IN: '在设置抽屉中完成 CLI 登录',
  CLI_PERMISSION_DENIED: '检查会员权限 / 账号风控（不可自动重试）',
  FFMPEG_NOT_FOUND: '安装 ffmpeg 后重启（用于产物封面）',
  FFPROBE_NOT_FOUND: '安装 ffprobe 后重启（用于音频时长）',
  NO_CREDIT: '积分不足，去即梦 Web 端充值',
  AUDIT: '审计失败：详情见 data 字段',
  UPSTREAM_TIMEOUT: '上游超时，可自动重试',
  INTERRUPTED: '任务被服务重启中断，可用 submit_id 续查',
  NO_SUBMIT_ID: 'CLI 没创建任务就拒绝：通常账号异常，去 Web 端检查',
  UPSTREAM_FAILED: '即梦端任务失败：详见 message / data',
  MODEL_NEEDS_FIRST_RUN: '模型首次合规未完成：去即梦 Web 端跑一次后再回来重试'
};

const ERR_HTTP = {
  PARAM: 400, UNAUTH: 401, FORBIDDEN: 403, NOTFOUND: 404,
  CONFLICT: 409, RATELIMIT: 429, INTERNAL: 500,
  CLI_DOWN: 502, CLI_NOT_FOUND: 503, CLI_NOT_LOGGED_IN: 401,
  CLI_PERMISSION_DENIED: 403, FFMPEG_NOT_FOUND: 503, FFPROBE_NOT_FOUND: 503,
  NO_CREDIT: 402, AUDIT: 500, UPSTREAM_TIMEOUT: 504, INTERRUPTED: 500,
  NO_SUBMIT_ID: 502, UPSTREAM_FAILED: 502, MODEL_NEEDS_FIRST_RUN: 409
};

/* 取错误码元数据（缺则返回 null —— 前端按"未知码"兜底） */
function errInfo(code) {
  if (code === 0) return null;
  const name = Object.keys(ERR).find((k) => String(ERR[k]) === String(code));
  if (!name) return null;
  return {
    code: code,
    name: name,
    category: ERR_CATEGORIES[name] || 'unknown',
    retryable: ERR_RETRYABLE[name] === true,
    http: ERR_HTTP[name] || 500,
    hint: ERR_HINTS[name] || null
  };
}

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
  const baseData = isApi ? err.data : null;
  /* ⚠ 阶段 3 错误码四件套 · 第 4 件：把结构化元数据（category / retryable / hint）
     放进 data 字段（不放在顶层，避免破坏现有 {code, message, data, traceId} 信封）。
     ⚠ 不暴露 http（前端不需要；http 是给未来严格 REST 化用的）。
     ⚠ message 与 messageHint 是两件事：
       · message 是后端给的**当前具体原因**（含具体 id / 名称 / 数值），用来排查；
       · messageHint 是 ERR_HINTS 里的**通用建议**，用来直接给用户看。
       前端可拼接 "message + messageHint" 弹窗，避免"看不到自己干了什么"，
       也避免"看不到下一步该做什么"。 */
  const info = errInfo(code);
  const data = (function () {
    if (!baseData && !info) return null;
    return Object.assign({}, baseData || {}, {
      __err: info ? {
        name: info.name, category: info.category, retryable: info.retryable, messageHint: info.hint
      } : null
    });
  })();
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

module.exports = {
  ERR, ERR_CATEGORIES, ERR_RETRYABLE, ERR_HINTS, ERR_HTTP, errInfo,
  TOOL_ERROR_CODES, ApiError, traceId, rid, nowIso, clamp, sendJson, ok, fail, readBody, grad
};
