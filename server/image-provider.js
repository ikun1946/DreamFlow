'use strict';
/* ============================================================
   image-provider.js —— Work Fisher 生图服务商的调用客户端

   为什么单独一个文件（2026-09-25，图片资产 GPT 生图计划 · 阶段 1）：
   本模块要发**付费**的外部请求，而"付费请求写错了"是不可回滚的损失
   （重复提交 = 重复扣费）。所以它的首要设计目标是**可被假传输完整测掉** ——
   与 desktop/updater.js 同一条路子：网络一律走可注入的传输层，凭据一律走
   可注入的读取函数，于是 test/11-image-provider.test.js 能在不接真实密钥、
   不产生任何费用的前提下覆盖成功 / 失败 / 401 / 402 / 429 / 超时 / 缺字段。

   ⚠ 五条约束，改之前先读完：
   1. **只按 v2.5-flare 的官方示例实现，不做跨族兼容。** 服务商不同模型族的
      请求形状不一样（Seedream 系参数在 `metadata` 对象里、G-2 不支持
      output_format），而 v2.5 系是**平铺参数**。想"顺手兼容一下"的结果通常是
      两边都写错，且错误只在真花钱时才暴露。
   2. **提交路径是单数的 `image`。** `/v1/image/generations`（不是 images）。
      这条与服务商文档一致，且已在 0.38.x 复核中逐字段比对过。
   3. **提交请求不做自动重试。** 提交是计费动作，超时后重发可能产生第二个任务。
      超时一律如实报 `timeout`，由上层转成 `submission_unknown` 交给人工核对。
   4. **缺字段时报告协议错误，不猜。** 提交响应里 `id` / `task_id` 兼容取
      （都在用），但查询结果只认 `data.result_url`；缺了就报错 ——
      猜一个下载地址等于把"下错文件"写进用户的素材库。
   5. **密钥只进不出。** 本模块的任何返回值（含错误对象的 data）都不得包含
      Authorization 头或密钥原文；日志同理（见 redact）。
   ============================================================ */
const https = require('https');
const http = require('http');

const DEFAULT_BASE = 'https://api.work-fisher.com';
/* 首版唯一的模型。界面沿用用户口中的"GPT 生图"，技术名以此为准。 */
const DEFAULT_MODEL = 'workfisher-image-g-v2.5-flare';
const SUBMIT_TIMEOUT_MS = 30 * 1000;
const QUERY_TIMEOUT_MS = 20 * 1000;
/* 响应体上限：这两个接口只回 JSON 元数据（提交回 id、查询回状态与结果直链），
   几十 KB 都算异常。设上限是为了防"对端返回一个巨大错误页把内存吃光"。 */
const MAX_BODY_BYTES = 512 * 1024;

/* ---------------- 传输层（可注入） ----------------
   与 desktop/updater.js 同形：request(url, opts, cb) -> req。
   ⚠ 默认实现必须**属性访问式**调用 `https.request(...)`，不能解构缓存 ——
     单测的假传输是替换 transport 整体，但同仓库 updater 的先例说明
     "有人会直接替换 https.request 来观察请求头"（那条断言专测"令牌只进不出"），
     解构会让那种替换静默失效。
   ⚠ 语义差别（与 updater 不同，别照搬）：本模块的 cb 收到的是一个**已读完的响应对象**
     `{ statusCode, headers, body }`，不是流。理由：这两个接口的响应都很小，
     在这里一次性读完能让"状态码 + 响应体"作为一个原子单元被处理，
     避免"读了 statusCode 却忘了 resume() 导致连接挂着"这类泄漏。
     下载图片的流式处理**不在这里** —— 那是 image-jobs.js 的职责（它有自己的
     字节上限与图片特征校验，约束完全不同）。
   ⚠ 失败与成功**共用同一个参数位**：`cb({ error: e })` 表示失败，`cb({ statusCode, … })` 表示
     成功。不设第二参数 —— 单参数约定是 updater.js 的既有形状，且"多一个参数位"
     正是这次把成功响应错当失败的原因（见 callJson 里的注释）。 */
let transportOverride = null;

function defaultTransport() {
  return {
    request(url, opts, cb) {
      const o = opts || {};
      /* settled：只交出一次结果。对端"先回响应、再冒 error"（或看门狗先开火、
         随后 abort 又抛一次）在真实网络里都会发生，重复回调会让上层把一个
         成功响应二次处理成失败。 */
      let settled = false;
      let watchdog = null;
      const done = (v) => { if (settled) return; settled = true; if (watchdog) { clearTimeout(watchdog); watchdog = null; } cb(v); };
      const fail = (e) => done({ error: e });

      let req;
      try {
        req = https.request(url, {
          method: o.method || 'GET',
          headers: Object.assign({ 'User-Agent': 'dreamflow-image-provider' }, o.headers || {})
        }, (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (d) => {
            total += d.length;
            /* 上限：这两个接口只回 JSON 元数据，几十 KB 都算异常。
               不设的话，对端返回一个巨大错误页就能把内存吃光。 */
            if (total > MAX_BODY_BYTES) return fail(new Error('响应体过大'));
            chunks.push(d);
          });
          res.on('end', () => done({
            statusCode: res.statusCode,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8')
          }));
          res.on('error', fail);
        });
      } catch (e) { return fail(e); }

      req.on('error', fail);
      if (o.timeoutMs) {
        /* 看门狗与 req.setTimeout 都要有：setTimeout 只在**有活动时**计时，
           对端接受连接后一声不吭（半开连接）它不会响 —— 而在"付费提交"上
           一直等最危险：任务可能已经在服务商那边建好了。 */
        req.setTimeout(o.timeoutMs, () => req.destroy(new Error('请求超时')));
        watchdog = setTimeout(() => req.destroy(new Error('请求超时')), o.timeoutMs);
        if (watchdog.unref) watchdog.unref();
      }
      if (o.body) req.write(o.body);
      req.end();
      return req;
    }
  };
}

function transport() { return transportOverride || defaultTransport(); }
function setTransport(t) { transportOverride = t || null; }

/* ---------------- 脱敏（**唯一的**日志/错误出口） ----------------
   为什么单独抽一个函数：密钥与鉴权头进入日志是**不可撤销**的泄露
   （日志会被贴进 issue、会被打包带走）。散落各处的"记得别打密钥"迟早会漏一处，
   所以这里做成一处白名单：只保留允许出现的字段。 */
function redact(v) {
  const s = String(v == null ? '' : v);
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/([?&](?:token|key|signature|sig|expires|auth)=)[^&\s]+/gi, '$1<redacted>');
}

/* ---------------- 错误形状 ----------------
   本模块的失败**不直接抛 ApiError**（那会把 server/util 的耦合带进"可能被单元
   测试单独 require"的模块里）。它交出结构化的 `{ kind, message, status, data }`，
   由 image-jobs.js 翻译成对外的错误码 —— 这样错误码表仍然只有一个来源（server/util.js）。

   kind 取值（上层按它决定"能不能再试"）：
     config       —— 本机配置问题（没填密钥 / 密钥形状不对）
     auth         —— 401：密钥无效
     no_credit    —— 402：余额不足
     ratelimit    —— 429：限流
     audit        —— 内容审核拒绝（服务商明确拒绝，重发无意义）
     protocol     —— 响应缺必要字段（不猜）
     timeout      —— 超时（提交超时 → submission_unknown，禁止自动重发）
     network      —— 连不上 / DNS / TLS
     upstream     —— 服务商 5xx 或其他非预期状态码
     failed       —— 服务商明确报告任务失败（含 quota / 审核等业务失败） */
function mkErr(kind, message, extra) {
  return Object.assign({ kind: kind, message: redact(message) }, extra || {});
}

/* ---------------- HTTP 状态码 → kind ---------------- */
function kindOfStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'no_credit';
  if (status === 429) return 'ratelimit';
  if (status >= 500) return 'upstream';
  return 'upstream';
}

/* ---------------- 服务商错误体解析 ----------------
   服务商的错误响应形状不完全统一：可能是 `{ error: { message } }`、
   `{ message }`、也可能是纯文本。这里只做"尽力取一段可读的话"，
   取不到就给个基于状态码的兜底 —— **绝不**把整个响应体（可能含密钥回显）抛给前端。 */
function messageOfBody(body, status) {
  const text = String(body || '');
  /* 先试 JSON（有 200 字节内的纯 JSON 才值得解析，避免对大 HTML 做无谓 JSON.parse） */
  if (text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const m = (j && j.error && (j.error.message || j.error.msg))
        || (j && (j.message || j.msg))
        || (j && j.error && typeof j.error === 'string' ? j.error : null);
      if (m) return String(m).slice(0, 300);
    } catch (e) { /* 不是 JSON，往下走 */ }
  }
  /* 非 JSON：截一小段纯文本。⚠ 必须截断 —— 否则一个 HTML 错误页会被整段塞进 message。 */
  const t = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 200);
  return '服务商返回 HTTP ' + status;
}

/* ---------------- 发请求并读完整响应 ---------------- */
function callJson(opts) {
  const o = opts || {};
  const url = o.url;
  const headers = Object.assign({
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }, o.headers || {});
  const body = o.body ? JSON.stringify(o.body) : null;

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    /* 只接受 https 的 base。⚠ 位置不能挪进传输层：允许 http 就等于让链路上任何人
       替换"任务在哪、结果是什么"，而这个结果会被写进用户的项目数据目录。 */
    if (!/^https:\/\//i.test(url)) {
      return done(mkErr('config', '生图服务地址必须是 https：' + redact(url)));
    }

    try {
      transport().request(url, {
        method: o.method || 'GET',
        headers: headers,
        timeoutMs: o.timeoutMs,
        body: body
      /* ⚠ 回调是**单参数** `cb(res)`，沿用 updater.js 的传输层约定；
         「失败」只走 `res.error` 这一个字段，不占用第二个参数位 ——
         曾经这里写成 `(err, res)`，于是假传输（也是单参数）的响应对象落进了
         `err` 位、`res` 恒为 undefined，所有成功用例都被误报成 network。
         传输层的形状必须两边一致，改一边就得改另一边。 */
      }, (res) => {
        if (!res || res.error) {
          const msg = String((res && res.error && res.error.message) || (res && res.error) || '未收到响应');
          /* ⚠ 超时要与"连不上"分开：前者是**提交结果未知**（不能重发），
             后者是明确没发出去（可以重试）。混在一起会导致要么漏重试、要么重复扣费。 */
          const kind = /超时|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg) ? 'timeout' : 'network';
          return done(mkErr(kind, kind === 'timeout' ? '请求服务商超时' : ('无法连接服务商：' + msg)));
        }
        if (typeof res.statusCode !== 'number') {
          return done(mkErr('protocol', '服务商响应缺少状态码'));
        }
        const raw = res.body == null ? '' : String(res.body);
        let json = null;
        if (raw) { try { json = JSON.parse(raw); } catch (e) { json = null; } }
        /* ⚠ 单参数：done 只接一个值。曾经这里是 `done(null, {...})`，
           于是 resolve 出去的是 null，成功响应全被判成"请求失败"。 */
        done({ status: res.statusCode, headers: res.headers || {}, json: json, raw: raw });
      });
    } catch (e) {
      done(mkErr('network', '发起请求失败：' + String((e && e.message) || e)));
    }
  });
}

/* ============================================================
   客户端工厂
   cfg: { apiKey }        —— 由 createServer 注入（网页版读环境变量、桌面版读 safeStorage）
   opts: { baseUrl, model, transport } —— 测试与未来切换服务商时覆盖
   ============================================================ */
function makeImageProvider(cfg, opts) {
  const o = opts || {};
  const c = cfg || {};
  const base = String(o.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const model = String(o.model || DEFAULT_MODEL);

  /* apiKey 支持两种形态：字符串，或**函数**（每次现取）。
     为什么允许函数：桌面版的密钥可能在应用运行期间被用户写入/删除，
     快照住旧值会让"刚填的密钥不生效、删掉的密钥还能用"。
     与 dreamina 适配器"路径每次 spawn 现取"是同一条教训。 */
  function apiKey() {
    const v = typeof c.apiKey === 'function' ? c.apiKey() : c.apiKey;
    return typeof v === 'string' ? v.trim() : '';
  }
  function configured() { return apiKey().length > 0; }
  function status() {
    return {
      configured: configured(),
      provider: 'work-fisher',
      model: model,
      /* 只回"配了没有"，**绝不**回密钥本身或它的长度/前缀 */
      baseUrl: base
    };
  }

  function authHeaders() {
    return { 'Authorization': 'Bearer ' + apiKey() };
  }

  /* ---------------- 提交生图任务 ----------------
     请求体严格按 v2.5-flare 官方示例（平铺参数）：
       { model, prompt, n, resolution, quality, output_format }
     ⚠ 不做自动重试（约束 3）。 */
  async function submit(prompt) {
    if (!configured()) return mkErr('config', '未配置生图服务的 API Key');
    const text = String(prompt == null ? '' : prompt);
    /* 空 / 全空白在这里就拒绝，不花服务商一次往返（也不花一次钱）。
       长度上限由上层（image-jobs.js）按资产的 prompt 上限校验，这里不重复定义。 */
    if (!text.trim()) return mkErr('config', '提示词不能为空');

    const r = await callJson({
      url: base + '/v1/image/generations',
      method: 'POST',
      headers: authHeaders(),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      body: {
        model: model,
        prompt: text,
        n: 1,
        resolution: '1k',
        quality: 'auto',
        output_format: 'png'
      }
    });

    /* 传输级失败：原样上抛（kind 已区分 timeout / network） */
    if (!r) return mkErr('network', '请求服务商失败');
    if (r.kind) return r;

    if (r.status < 200 || r.status >= 300) {
      return mkErr(kindOfStatus(r.status), messageOfBody(r.raw, r.status), { status: r.status });
    }
    if (!r.json || typeof r.json !== 'object') {
      return mkErr('protocol', '提交响应不是合法 JSON（HTTP ' + r.status + '）');
    }
    /* ⚠ 字段兼容：`id` 与 `task_id` **都在被用**（文档两种写法都出现过），
       所以两个都认；但两个都没有时**不猜** —— 报协议错误。
       这里最忌讳"取个 id 字段凑合用"，因为 task_id 是后续查询与去重的唯一依据。 */
    const d = r.json.data && typeof r.json.data === 'object' ? r.json.data : r.json;
    const taskId = d.task_id || d.id || null;
    if (!taskId) {
      return mkErr('protocol', '提交响应没有任务 ID（缺 task_id / id）', { status: r.status });
    }
    return { taskId: String(taskId), raw: null };
  }

  /* ---------------- 查询任务 ----------------
     返回两种终态：
       进行中 → { state: 'queued' | 'running' }
       已结束 → { state: 'succeeded' | 'failed', resultUrl, usage, failReason }
     ⚠ 状态映射刻意**宽松**：服务商文档给出的状态枚举是
       PENDING / PROCESSING / SUCCESS / FAILURE 一套，但真实响应还有
       queued / running / succeeded / failed 等写法。这里做大小写无关的包含匹配，
       未知状态一律按"进行中"处理（**不**当失败）—— 把进行中误判为失败会让用户
       以为任务挂了去重新提交，那是一次不必要的付费。 */
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

    /* usage：服务商在终态回 `data.usage`（已结算用量）。**只在服务商给出时**记录 —— 
       绝不按"张数 × 单价"自己算，价格随时会变，算出来的数字会被用户当真。 */
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
      if (!resultUrl) {
        /* ⚠ 成功但没有结果地址 = 协议错误，不猜（约束 4）。 */
        return mkErr('protocol', '任务已成功但响应缺少结果地址（result_url）');
      }
      return { state: 'succeeded', resultUrl: String(resultUrl), usage: usage };
    }
    /* 未知或进行中：按 queued / running 回报（RUNNING 单独给 running，其余给 queued） */
    return { state: /RUNNING|PROCESS/.test(rawStatus) ? 'running' : 'queued', rawStatus: rawStatus };
  }

  /* ---------------- 用量归一 ----------------
     usage 的形状由服务商决定，这里只挑出**能确定是数字**的字段，
     原样保留其余键（未来加字段不必改代码），但**不做任何计算**。 */
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
    configured, status, submit, query,
    /* 仅供测试与排查：确认实际发出去的请求形状（**不含**密钥） */
    _internals: { base, model, submitTimeoutMs: SUBMIT_TIMEOUT_MS, queryTimeoutMs: QUERY_TIMEOUT_MS }
  };
}

module.exports = {
  makeImageProvider, DEFAULT_BASE, DEFAULT_MODEL,
  setTransport, transport,
  /* 单测直接用它验证脱敏与状态映射，不必绕经客户端 */
  redact, kindOfStatus, messageOfBody
};
