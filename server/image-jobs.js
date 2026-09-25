'use strict';
/* ============================================================
   image-jobs.js —— 图片资产生图任务：状态机 / 轮询 / 安全下载 / 采用

   （2026-09-25，图片资产 GPT 生图计划 · 阶段 2）

   为什么单独一个模块、而不是塞进 services.js：
   这条链路同时碰三样"错了就不可回滚"的东西 —— **付费提交**、**外部下载的字节**、
   **用户的原始素材文件**。它们各自的失败模式与现有 cliJobs（本地子进程）完全不同，
   混进 services.js 会让"清孤儿"和"判断有无活动任务"互相干扰。
   所以这里是一个独立的状态机，只把"结果"通过 services 的既有出口落库。

   ⚠ 六条硬约束，改之前请先读完：
   1. **提交请求不做自动重试。** 提交是计费动作；超时后重发可能产生第二个远端任务。
      超时一律转为 `submission_unknown`，界面提示"到服务商控制台核对"，**禁止**自动重发。
   2. **轮询定时器由服务端持有。** 桌面版随主进程、网页版随服务进程存亡；前端只读
      本地任务状态（`GET .../current`），**不直接驱动**服务商查询。少了这条，
      "关闭弹窗不中断"与"重启后恢复"两个承诺都会落空。
   3. **下载只接受 https，且每次重定向重新检查。** 结果 URL 来自服务商响应，
      等于外部输入；允许 http 或跨过一个跳转就等于允许任何人在你的项目目录里写文件。
      还要限时间、限字节、校验图片特征 —— 拒绝 HTML 错误页与不完整图片。
   4. **采用时顺序不能变**：写新文件 → 校验 → 更新引用 → **强制刷盘** → 最后才删旧文件。
      中途任何一步失败都必须回滚数据库引用，**保留原图可用**（原图还在才谈得上回滚）。
   5. **同一资产只允许一个活动任务。** `submitting` / `queued` / `running` /
      `saving_result` / `ready` 任一存在时拒绝再次提交 —— 这是防"双击两次扣两次"的
      最后一道闸（前端禁用按钮只是体验，不是保证）。
   6. **绝不记录密钥、鉴权头、带签名参数的远端 URL。** 落库的只有本地任务 ID、
      服务商任务 ID、状态、时间、用量与**候选文件的相对名**。远端直链只存在于内存，
      用完即弃（结果直链约 24 小时过期，存下来也是死链）。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PATHS = require('./paths');

/* ---------------- 状态机 ----------------
   ⚠ 这些字符串是落库值，改名等于让已有任务变成"未知状态"。 */
const STATE = {
  SUBMITTING: 'submitting',                 // 已确认、尚未拿到服务商任务 ID
  QUEUED: 'queued',                         // 已拿到并保存任务 ID
  RUNNING: 'running',
  SAVING_RESULT: 'saving_result',           // 服务商成功，正在下载
  READY: 'ready',                           // 本地候选图可用，等待用户采用 / 放弃
  FAILED: 'failed',                         // 服务商失败或明确拒绝
  SUBMISSION_UNKNOWN: 'submission_unknown', // 提交结果不确定且无任务 ID —— 禁止自动重发
  APPLIED: 'applied',                       // 用户采用完毕
  DISCARDED: 'discarded'                    // 用户放弃
};
/* 活动态：存在任一条就**不允许**对同一资产再提交。
   注意 `ready` 也算活动 —— 它在等用户决定，此时再提交会产生第二张候选图争用同一个预览区。 */
const ACTIVE_STATES = [STATE.SUBMITTING, STATE.QUEUED, STATE.RUNNING, STATE.SAVING_RESULT, STATE.READY];

const POLL_INTERVAL_MS = 4000;         // 计划文档给的是"约每 3–5 秒"
const POLL_BACKOFF_MAX_MS = 30000;     // 查询连续失败时的退避上限（不做无限次重试）
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const MAX_REDIRECTS = 5;
/* 候选图文件名用的时间戳基数（36 进制，与 services.replaceAsset 同一约定） */
const stamp = () => Date.now().toString(36);

/* ============================================================
   图片特征校验
   为什么必须做：CDN 出问题时会返回一个 HTML 错误页（状态码还是 200）。
   不校验就写进候选目录，用户看到的是一张"打不开的图"，而错误现场已经被清理掉了。
   ⚠ 只认 PNG / JPEG / WebP —— 与服务商首版唯一支持的 output_format 对齐。
   不认 SVG（可执行脚本的载体），不认 GIF/BMP（服务商不会产出，出现即为异常）。 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  /* PNG: 89 50 4E 47 0D 0A 1A 0A */
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    /* PNG 的尺寸在 IHDR：宽/高各 4 字节大端，偏移 16 / 20 */
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    return { format: 'png', ext: '.png', mime: 'image/png', width: w, height: h };
  }
  /* JPEG: FF D8 FF */
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    const dim = jpegSize(buf);
    return { format: 'jpeg', ext: '.jpg', mime: 'image/jpeg', width: dim ? dim.width : null, height: dim ? dim.height : null };
  }
  /* WebP: RIFF....WEBP */
  if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp', ext: '.webp', mime: 'image/webp', width: null, height: null };
  }
  return null;
}

/* 扫 JPEG 的 SOFn 段取尺寸。找不到返回 null —— **不**因此判失败
   （尺寸只是"基本尺寸校验"的输入，不是格式合法性的判据）。 */
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    /* SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 都带尺寸 */
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7)
      || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      const h = buf.readUInt16BE(i + 5);
      const w = buf.readUInt16BE(i + 7);
      return { width: w, height: h };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/* 尺寸下限：一张真图不可能小于 16×16。这条能挡住"只截到文件头几十字节"的
   截断响应 —— 那种响应可能连 PNG 签名都凑齐了。 */
const MIN_DIM = 16;
function imageProblem(info) {
  if (!info) return '响应不是 PNG / JPEG / WebP 图片（可能是 HTML 错误页）';
  if (info.width != null && info.width < MIN_DIM) return '图片宽度异常（' + info.width + 'px）';
  if (info.height != null && info.height < MIN_DIM) return '图片高度异常（' + info.height + 'px）';
  return null;
}

/* ============================================================
   URL 安全检查（**每次跳转都要重跑**）
   ============================================================ */
/* 内网 / 本机地址黑名单。为什么要挡：结果 URL 是外部输入，
   一个被劫持的响应可以给出 `https://127.0.0.1:8787/...` 让服务端自己去打自己的
   本地接口（经典 SSRF）。本应用是本地单用户服务，"服务端去访问本机端口"
   没有任何正当用途。 */
const PRIVATE_HOST_RE = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,                    // link-local
  /^\[::1\]$/,
  /^\[?f[cd][0-9a-f]{2}:/i,         // IPv6 ULA
  /^\[?fe80:/i                      // IPv6 link-local
];
function urlProblem(raw) {
  let u;
  try { u = new URL(String(raw || '')); }
  catch (e) { return '结果地址无法解析'; }
  if (u.protocol !== 'https:') return '结果地址不是 https（' + u.protocol + '）';
  /* 主机名不能是裸 IP 的私网/本机地址。域名形式放过（域名解析到内网属于 DNS 问题，
     由操作系统与链路负责 —— 这里挡的是"响应体直接给出内网地址"这个明确攻击面）。 */
  if (PRIVATE_HOST_RE.some((re) => re.test(u.hostname))) {
    return '结果地址指向本机 / 内网（' + u.hostname + '）';
  }
  return null;
}

/* ============================================================
   安全下载：https-only + 每次跳转重检 + 限时限字节 + 图片特征校验
   返回 { ok: true, buf, info } 或 { ok: false, message }
   ============================================================ */
function downloadImage(rawUrl, opts) {
  const o = opts || {};
  const transport = o.transport;      // 可注入（单测用假传输，不发真请求）
  const maxBytes = o.maxBytes || MAX_DOWNLOAD_BYTES;
  const timeoutMs = o.timeoutMs || DOWNLOAD_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (m) => done({ ok: false, message: m });

    /* ① 只在 https 上继续 —— 位置不能挪进传输层 */
    const bad = urlProblem(rawUrl);
    if (bad) return fail(bad);

    const req = transport ? transport(rawUrl, { timeoutMs: timeoutMs })
      : https.get(rawUrl, { headers: { 'User-Agent': 'dreamflow-image-download' } });

    let timer = null;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

    timer = setTimeout(() => {
      try { if (req && req.destroy) req.destroy(new Error('下载超时')); } catch (e) { /* 已结束 */ }
      fail('下载结果图片超时');
    }, timeoutMs);
    if (timer.unref) timer.unref();

    req.on('error', (e) => { clear(); fail('下载结果图片失败：' + String((e && e.message) || e)); });

    req.on('response', (res) => {
      const status = res.statusCode;

      /* ② 跳转：**每次**重新检查协议与主机。把"检查一次"放在这里就等于
         让第一次的合法 URL 把后续任意地址带进来。 */
      if (status >= 300 && status < 400 && res.headers && res.headers.location) {
        clear();
        if ((o.redirects || 0) >= MAX_REDIRECTS) return fail('结果地址重定向次数过多');
        if (res.resume) res.resume();
        let next;
        try { next = new URL(res.headers.location, rawUrl).toString(); }
        catch (e) { return fail('结果地址重定向目标无法解析'); }
        return downloadImage(next, Object.assign({}, o, { redirects: (o.redirects || 0) + 1 }))
          .then((r) => done(r));
      }

      if (status !== 200) return fail('下载结果图片失败（HTTP ' + status + '）');

      /* ③ 字节上限。⚠ 边收边算，不看 Content-Length ——
         Content-Length 是对方声明的，可以撒谎或缺失。 */
      const chunks = [];
      let total = 0;
      let aborted = false;
      res.on('data', (d) => {
        total += d.length;
        if (total > maxBytes) {
          aborted = true;
          clear();
          try { res.destroy(); if (req.destroy) req.destroy(); } catch (e) { /* 已结束 */ }
          return fail('结果图片超过大小上限（' + Math.round(maxBytes / 1024 / 1024) + ' MB）');
        }
        chunks.push(d);
      });
      res.on('error', (e) => {
        if (aborted) return;
        clear();
        fail('下载结果图片中断：' + String((e && e.message) || e));
      });
      res.on('end', () => {
        if (aborted) return;
        clear();
        const buf = Buffer.concat(chunks);
        /* ④ 格式与尺寸。这是"HTML 假图片"与"截断图片"的唯一拦截点。 */
        const info = sniffImage(buf);
        const prob = imageProblem(info);
        if (prob) return fail(prob);
        done({ ok: true, buf: buf, info: info, contentType: (res.headers || {})['content-type'] || null });
      });
    });
    if (req.end && !transport) { /* https.get 已自动 end */ }
  });
}

/* ============================================================
   任务集合操作（db.imageJobs 的唯一读写口）
   ============================================================ */
function ensureMap(db) {
  if (!db.imageJobs || typeof db.imageJobs !== 'object' || Array.isArray(db.imageJobs)) db.imageJobs = {};
  return db.imageJobs;
}
const listOf = (db) => Object.keys(ensureMap(db)).map((k) => db.imageJobs[k]).filter(Boolean);
const byAsset = (db, assetId) => listOf(db).filter((j) => j.assetId === assetId);
const activeOfAsset = (db, assetId) => byAsset(db, assetId).find((j) => ACTIVE_STATES.includes(j.state)) || null;

/* 落库前的最后一道闸（约束 6）：任何"只应存在于内存"的字段在写盘前清掉。
   为什么要做成显式的一步而不是"记得别赋值"：这条链路上同时存在计费凭据与
   外部直链，任何一次顺手赋值都会静默进库 —— 而**已经写进 db.json 的密钥或直链
   是不可撤销的**（备份、日志、用户到处拷贝）。这里用白名单思路：只要不是
   明确允许持久化的字段，一律不写。 */
const PERSIST_FIELDS = [
  'id', 'projectId', 'assetId', 'prompt', 'model', 'state',
  'providerTaskId', 'candidateFile', 'appliedFile', 'usage', 'error', 'errorKind',
  'imageWidth', 'imageHeight', 'imageFormat', 'queryFailures',
  'createdAt', 'updatedAt'
];
function sanitizeForSave(job) {
  if (!job) return;
  Object.keys(job).forEach((k) => {
    /* `_` 前缀是运行态（如 _busy）。它在内存里必须保留（进程内互斥靠它），
       所以在**保存前**把它从当前对象上摘掉、保存后再放回 —— 调用方用
       saveClean(job, fn) 包一层，避免"为了落库而破坏内存语义"。 */
    if (k.charAt(0) === '_') return;
    if (PERSIST_FIELDS.indexOf(k) >= 0) return;
    delete job[k];
  });
}
function sanitizeAll(db) {
  const map = ensureMap(db);
  Object.keys(map).forEach((k) => sanitizeForSave(map[k]));
}

/* 对外的任务视图。**绝不**包含 resultUrl（远端直链不交给页面，见约束 6）。
   候选图地址由服务端按"本地任务 ID"拼出，页面拿到的永远是本地接口。 */
function viewJob(j, assetId) {
  if (!j) return null;
  return {
    jobId: j.id,
    assetId: assetId || j.assetId,
    projectId: j.projectId,
    state: j.state,
    prompt: j.prompt,
    model: j.model,
    providerTaskId: j.providerTaskId || null,
    usage: j.usage || null,
    error: j.error || null,
    /* 候选图**相对名** → 本地预览地址。只在这一处拼，页面拿不到直链。 */
    previewUrl: j.candidateFile ? PATHS.candidateUrl(j.projectId, j.candidateFile) : null,
    imageWidth: j.imageWidth || null,
    imageHeight: j.imageHeight || null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt
  };
}

/* ============================================================
   工厂：需要一个"运行时环境"
   env: {
     db,                       // 每次现取（store.load()）
     save(),                   // store.save()
     flush(),                  // store.flush()  —— 采用时必须强制刷盘
     provider,                 // makeImageProvider 的实例
     findAsset(assetId),       // 校验作用域 + 取资产；不属于当前项目时抛 ApiError
     assetFileOf(asset),       // 磁盘路径（复用 paths 的唯一事实来源）
     assetUrl(pj, file),       // URL 构造
     assetDir(pj),
     projectIdOfAsset(asset),  // 从资产推导项目（资产记录自带 projectId）
     log(level, msg),          // 落系统日志（已脱敏）
     now()                     // 便于测试注入时间
   }
   ============================================================ */

function makeImageJobs(env) {
  const e = env || {};
  const now = e.now || (() => new Date().toISOString());
  const log = e.log || (() => {});
  /* 统一的落库出口（约束 6）：任何一次写盘前先做白名单清洗，再临时摘掉运行态字段。
     为什么要收成一个出口：这个模块里有二十多处落库点，散着写就一定会漏一处 ——
     而漏一处的结果是"密钥/直链/运行态进 db.json"，不可撤销。 */
  function saveAll() {
    const db = e.db();
    sanitizeAll(db);
    const map = ensureMap(db);
    const held = [];
    Object.keys(map).forEach((k) => {
      const j = map[k];
      if (!j) return;
      Object.keys(j).forEach((f) => {
        if (f.charAt(0) === '_') { held.push([j, f, j[f]]); delete j[f]; }
      });
    });
    try { e.save(); } finally { held.forEach((h) => { h[0][h[1]] = h[2]; }); }
  }
  /* 轮询定时器：**服务端持有**（约束 2）。同一进程内只有一个 tick 循环，
     它扫描 db.imageJobs 里的活动任务，而不是给每个任务各起一个 timer ——
     每任务一个 timer 在"用户连开五个资产"时会产生五条并发查询，
     且重启后无法重建（timer 不在库里）。 */
  let tickTimer = null;
  let ticking = false;
  /* 下载传输可注入（单测用假传输，绝不发真请求）。与 provider 的传输层分开：
     一个是 JSON API、一个是图片字节流，约束完全不同（字节上限、格式校验）。
     ⚠ 归一成**函数**：真实形态可以是 `https` 模块（对象，带 .get）、
       也可以是 `https.get` 本身（函数）。生产代码只调用 `transport(url, opts)`，
       所以这里统一收口 —— 否则注入一个对象就会在选择点抛
       "transport is not a function"，而那正是本次测试暴露出来的形状错位。 */
  let downloadTransport = null;
  function setDownloadTransport(t) {
    if (!t) { downloadTransport = null; return; }
    if (typeof t === 'function') { downloadTransport = t; return; }
    if (typeof t.get === 'function') { downloadTransport = (url, opts) => t.get(url, opts); return; }
    if (typeof t.request === 'function') { downloadTransport = (url, opts) => t.request(url, opts); return; }
    throw new TypeError('downloadTransport 必须是函数，或带 get / request 的对象');
  }
  if (e.downloadTransport) setDownloadTransport(e.downloadTransport);

  /* ---------------- 创建任务（提交） ----------------
     调用方已校验过资产、提示词长度与作用域；这里只负责"防重复 + 状态机推进"。 */
  async function submit(asset, prompt, opts) {
    const o = opts || {};
    const db = e.db();
    const map = ensureMap(db);

    /* ① 同一资产只允许一个活动任务（约束 5）。这是最后一道闸 ——
       前端的按钮禁用只是体验；用户双击、两秒内两个标签页同时点、
       或者刷新页面后重放请求，都会走到这里。 */
    const running = activeOfAsset(db, asset.id);
    if (running) {
      /* ⚠ 形状必须与"新建成功"那一支一致：都回 `job`。
         曾经这里回的是 `existing`，于是前端要写两套取值逻辑，且"已有一个
         进行中的任务"这条最需要展示状态的分支反而最容易取不到 —— 计划 §4.2
         对这条接口的要求是"响应本地 jobId"，不区分是新建的还是复用的。 */
      return { job: viewJob(running, asset.id), created: false, existing: true };
    }

    const job = {
      id: 'ij_' + crypto.randomBytes(6).toString('hex'),
      projectId: asset.projectId,
      assetId: asset.id,
      /* 提示词**快照**：资产上的 prompt 之后可能被用户改掉，
         而这次任务花的是这一版提示词的钱，审计时必须以快照为准。 */
      prompt: prompt,
      model: o.model || null,
      state: STATE.SUBMITTING,
      providerTaskId: null,
      candidateFile: null,
      usage: null,
      error: null,
      createdAt: now(),
      updatedAt: now()
    };
    map[job.id] = job;
    saveAll();

    const r = await e.provider.submit(prompt);

    if (r && r.kind) {
      /* ② 超时 → submission_unknown（**不**自动重发，约束 1）。
         其余失败是"明确没建成任务"，直接 failed，用户可以手动再提交。 */
      if (r.kind === 'timeout') {
        job.state = STATE.SUBMISSION_UNKNOWN;
        job.error = '提交结果未知：请求超时，任务可能已在服务商侧创建。请到服务商控制台核对后再决定是否重新提交。';
      } else {
        job.state = STATE.FAILED;
        job.error = providerMessage(r);
        job.errorKind = r.kind;
      }
      job.updatedAt = now();
      saveAll();
      log('warn', '图片生图提交失败（资产 ' + asset.id + '，' + r.kind + '）：' + job.error);
      return { job: viewJob(job, asset.id), created: true, failed: r.kind };
    }

    job.providerTaskId = r.taskId;
    job.state = STATE.QUEUED;
    job.updatedAt = now();
    saveAll();
    log('info', '图片生图任务已提交（本地 ' + job.id + ' / 服务商 ' + r.taskId + '，资产 ' + asset.id + '）');
    /* ③ 立刻查一次，而不是干等一个轮询周期 ——
       服务商偶尔秒回结果，用户不应该为此多等 4 秒。 */
    await step(job);
    return { job: viewJob(job, asset.id), created: true };
  }

  /* 把 provider 的结构化错误翻成一句人话（错误码翻译由上层做，这里只管可读性） */
  function providerMessage(r) {
    const map = {
      config: '生图服务未配置（缺少 API Key）',
      auth: 'API Key 无效或已过期，请在设置中重新配置',
      no_credit: '生图服务余额不足，请到服务商控制台充值',
      ratelimit: '请求过于频繁（服务商限流），请稍后再试',
      audit: '内容审核未通过',
      protocol: '服务商响应异常（缺少必要字段）',
      network: '无法连接生图服务（检查网络或代理）',
      upstream: '生图服务暂时不可用，请稍后再试'
    };
    return (map[r.kind] || '生图服务调用失败') + (r.message ? '：' + r.message : '');
  }

  /* ---------------- 推进一个任务（查询 → 下载 → ready/failed） ----------------
     ⚠ 一个任务在同一时刻只应被推进一次。查询与下载都是异步的，
     "两个轮询周期重叠"会让同一个任务并发下载两次并写两个候选文件。
     用 job._busy 做进程内互斥（不落库：它是运行态，重启后自然清零）。 */
  async function step(job) {
    if (!job || job._busy) return;
    if (!ACTIVE_STATES.includes(job.state)) return;
    /* ready 是"等用户决定"，不需要也不应该继续查询服务商 */
    if (job.state === STATE.READY) return;
    if (job.state === STATE.SUBMITTING) return;       // 提交还没回来，没有 taskId 可查
    if (!job.providerTaskId) return;
    if (job.state === STATE.SAVING_RESULT) return;    // 上一次下载还在进行

    job._busy = true;
    try {
      const r = await e.provider.query(job.providerTaskId);
      if (r && r.kind) {
        /* 查询失败：保留 task_id，稍后再查（约束 1 只说提交不重试；查询可以）。
           退避靠轮询周期本身 + 连续失败计数，不做无限快重试。 */
        job.queryFailures = (job.queryFailures || 0) + 1;
        job.error = '查询任务状态失败（第 ' + job.queryFailures + ' 次）：' + providerMessage(r);
        job.updatedAt = now();
        saveAll();
        return;
      }
      job.queryFailures = 0;
      if (r.state === 'queued' || r.state === 'running') {
        job.state = r.state === 'running' ? STATE.RUNNING : STATE.QUEUED;
        job.updatedAt = now();
        saveAll();
        return;
      }
      if (r.state === 'failed') {
        job.state = STATE.FAILED;
        job.error = r.failReason || '服务商报告任务失败';
        job.usage = r.usage || null;
        job.updatedAt = now();
        saveAll();
        log('warn', '图片生图任务失败（本地 ' + job.id + ' / 服务商 ' + job.providerTaskId + '）：' + job.error);
        return;
      }
      /* 成功 → 下载并落候选图 */
      job.state = STATE.SAVING_RESULT;
      job.usage = r.usage || null;
      job.updatedAt = now();
      saveAll();

      const asset = e.findAssetForJob ? e.findAssetForJob(job) : null;
      if (!asset) {
        job.state = STATE.FAILED;
        job.error = '资产已被删除，结果不再保存';
        job.updatedAt = now();
        saveAll();
        return;
      }

      const dl = await downloadImage(r.resultUrl, { transport: downloadTransport });
      if (!dl.ok) {
        /* 下载失败**不改** job 的终态语义：结果链接约 24 小时内有效，
           用户可以手动点"重新保存结果"。所以退回到 running 语义上的可重查状态，
           但保留一句明确的原因 —— 直接判 failed 会让"重新保存"无处下手。
           ⚠ **绝不**把 resultUrl 落库（约束 6）。原先这里赋值给 job.resultUrl 并
           e.save()，注释说"落库前会被去掉"——但那个去处从来不存在，于是远端直链
           就真的一直留在 db.json 里（约 24 小时过期，之后是死数据，且是外部可追踪
           的地址）。"重新保存"（resave）本来就会重新查一次服务商拿新的直链，
           所以内存里留它也没有意义。 */
        job.state = STATE.RUNNING;
        job.error = '结果下载失败：' + dl.message + '（结果链接约 24 小时内有效，可稍后重试保存）';
        job.updatedAt = now();
        saveAll();
        log('warn', '图片生图结果下载失败（本地 ' + job.id + '）：' + dl.message);
        return;
      }

      /* 落候选文件。文件名由服务端生成（资产 id + 时间戳 + 扩展名），
         不接受任何外部输入拼装 —— 这是路径安全的唯一入口。 */
      const fname = job.assetId + '-' + stamp() + dl.info.ext;
      const dir = PATHS.ensureCandidateDir(job.projectId);
      const abs = path.join(dir, fname);
      try {
        fs.writeFileSync(abs, dl.buf);
      } catch (err) {
        job.state = STATE.RUNNING;
        job.error = '候选图写入失败：' + String((err && err.message) || err);
        job.updatedAt = now();
        saveAll();
        return;
      }
      job.candidateFile = fname;
      job.imageWidth = dl.info.width;
      job.imageHeight = dl.info.height;
      job.imageFormat = dl.info.format;
      job.resultUrl = null;               // 已落盘，内存里的直链不再需要
      job.state = STATE.READY;
      job.error = null;
      job.updatedAt = now();
      saveAll();
      log('info', '图片生图结果已保存（本地 ' + job.id + '，' + fname + '，'
        + (dl.info.width || '?') + '×' + (dl.info.height || '?') + '）');
    } finally {
      job._busy = false;
    }
  }

  /* ---------------- 采用（写新文件 → 刷盘 → 清旧，失败回滚） ---------------- */
  async function apply(asset, job) {
    if (!job) return { ok: false, message: '任务不存在' };
    if (job.state !== STATE.READY) return { ok: false, message: '任务不在可采用的待确认状态（当前：' + job.state + '）' };
    if (job.assetId !== asset.id) return { ok: false, message: '任务与资产不匹配' };
    if (!job.candidateFile) return { ok: false, message: '候选图不存在' };

    const dir = PATHS.candidateDir(job.projectId);
    const src = path.join(dir, job.candidateFile);
    if (!fs.existsSync(src)) return { ok: false, message: '候选图文件已被清理，无法采用' };

    /* ① 生成**新的带版本文件名**。为什么必须换名而不是原地覆盖：
       浏览器/WebView 会缓存 <img src>，沿用旧 URL 就是"采用成功了但界面还显示旧图"
       （services.replaceAsset 踩过同一个坑，注释写在那里）。 */
    const ext = path.extname(job.candidateFile) || '.png';
    const newName = asset.id + '-' + stamp() + ext;
    const assetDirPath = PATHS.assetDir(job.projectId);
    fs.mkdirSync(assetDirPath, { recursive: true });
    const dest = path.join(assetDirPath, newName);
    const oldFile = e.assetFileOf(asset);
    const oldUrl = asset.url;
    const oldThumb = asset.thumbUrl;
    const oldSize = asset.size;

    /* ② 先复制到目标位置（不删源：源是我们唯一的"新图"副本，
       万一后面刷盘失败还要靠它把界面恢复成"待采用"）。 */
    let buf;
    try { buf = fs.readFileSync(src); }
    catch (err) { return { ok: false, message: '读取候选图失败：' + String((err && err.message) || err) }; }
    try { fs.writeFileSync(dest, buf); }
    catch (err) { return { ok: false, message: '写入新图片失败：' + String((err && err.message) || err) }; }

    /* ③ 校验刚落盘的文件确实是合法图片（不是半个文件）。 */
    const info = sniffImage(buf);
    const prob = imageProblem(info);
    if (prob) {
      try { fs.unlinkSync(dest); } catch (err) { /* 忽略 */ }
      return { ok: false, message: '新图片校验未通过：' + prob };
    }

    /* ④ 更新引用（内存） */
    asset.url = e.assetUrl(job.projectId, newName);
    asset.thumbUrl = asset.url;
    asset.size = buf.length;
    asset.updatedAt = now();
    /* url 变了就要把引用它的分镜标脏，让缩略图刷新 */
    const touched = e.markDependentsDirty ? e.markDependentsDirty(asset.id) : 0;

    /* ⑤ **强制刷盘**。顺序不能反：先落库成功，旧文件才允许删。
       若这里失败，回滚内存引用并删掉刚写的新文件 —— 原图一个字节没动，
       所以"采用失败仍能打开原图"这条承诺是成立的。 */
    try {
      e.flush();
    } catch (err) {
      asset.url = oldUrl;
      asset.thumbUrl = oldThumb;
      asset.size = oldSize;
      try { fs.unlinkSync(dest); } catch (e2) { /* 忽略 */ }
      return { ok: false, message: '数据库落盘失败，已回滚（原图保持不变）：' + String((err && err.message) || err) };
    }

    /* ⑥ 到这里才清理：旧素材文件 + 候选文件。两者都失败了也不影响正确性
       （旧文件成为孤儿，由启动期 GC 兜底；候选文件同理）。 */
    if (oldFile && path.resolve(oldFile) !== path.resolve(dest)) {
      try { fs.unlinkSync(oldFile); } catch (err) { /* 可能已被并发替换 */ }
    }
    try { fs.unlinkSync(src); } catch (err) { /* 忽略 */ }

    job.state = STATE.APPLIED;
    job.candidateFile = null;
    job.appliedFile = newName;
    job.updatedAt = now();
    saveAll();
    log('info', '图片生图结果已采用（资产 ' + asset.id + ' → ' + newName + '，影响 ' + touched + ' 条分镜）');
    return { ok: true, asset: asset, job: viewJob(job, asset.id), affected: touched };
  }

  /* ---------------- 放弃（清理候选文件，远端任务不宣称已取消） ---------------- */
  function discard(asset, job) {
    if (!job) return { ok: false, message: '任务不存在' };
    if (job.state !== STATE.READY && job.state !== STATE.FAILED && job.state !== STATE.SUBMISSION_UNKNOWN) {
      /* ⚠ 只允许放弃"已结束"的任务。放弃一个还在跑的任务会让用户以为
         "任务取消了/不扣费了"，而服务商并没有取消接口 —— 那是撒谎。 */
      return { ok: false, message: '任务仍在进行中，无法放弃（服务商没有取消接口，远端任务可能继续计费）' };
    }
    if (job.candidateFile) {
      const f = path.join(PATHS.candidateDir(job.projectId), job.candidateFile);
      try { fs.unlinkSync(f); } catch (err) { /* 忽略 */ }
    }
    job.state = STATE.DISCARDED;
    job.candidateFile = null;
    job.updatedAt = now();
    saveAll();
    log('info', '图片生图结果已放弃（本地 ' + job.id + '）');
    return { ok: true, job: viewJob(job, asset.id) };
  }

  /* ---------------- 重新保存结果（下载失败后的手动重试） ----------------
     只对"有 task_id、且没落成候选图"的任务有意义：
     重新查一次服务商拿新的 result_url，再走一遍下载。 */
  async function resave(asset, job) {
    if (!job) return { ok: false, message: '任务不存在' };
    if (!job.providerTaskId) return { ok: false, message: '该任务没有服务商任务 ID，无法重新获取结果' };
    if (job.state === STATE.READY) return { ok: true, job: viewJob(job, asset.id) };
    if (job.candidateFile) return { ok: true, job: viewJob(job, asset.id) };
    job.state = STATE.RUNNING;
    job._busy = false;
    job.updatedAt = now();
    saveAll();
    await step(job);
    return { ok: true, job: viewJob(job, asset.id) };
  }

  /* ---------------- 轮询循环（服务端持有） ----------------
     扫描全部项目下的活动任务。查询失败时按连续失败次数退避到 30 秒上限，
     但**不放弃** —— 任务的 task_id 一直在库里，重启后照样继续查。 */
  function dueJobs(db) {
    const nowMs = Date.now();
    return listOf(db).filter((j) => {
      if (!j) return false;
      if (j.state === STATE.SUBMITTING) return false;    // 提交请求自己会推进
      if (j.state === STATE.READY) return false;         // 等用户决定
      if (!ACTIVE_STATES.includes(j.state)) return false;
      if (!j.providerTaskId) return false;
      const backoff = Math.min(POLL_INTERVAL_MS * Math.pow(2, Math.max(0, (j.queryFailures || 0) - 1)), POLL_BACKOFF_MAX_MS);
      const last = Date.parse(j.updatedAt || j.createdAt || '') || 0;
      return nowMs - last >= backoff;
    });
  }

  async function tick() {
    if (ticking) return { skipped: true };
    ticking = true;
    try {
      const db = e.db();
      const jobs = dueJobs(db);
      /* 串行推进：图片查询本身是低频的，且并发下载会抢带宽。
         一条一条来也让失败日志的顺序可读。 */
      for (const j of jobs) {
        try { await step(j); }
        catch (err) {
          j._busy = false;
          j.error = '推进任务时出错：' + String((err && err.message) || err);
          j.updatedAt = now();
          try { saveAll(); } catch (e2) { /* 忽略 */ }
          log('err', '图片生图任务推进异常（本地 ' + j.id + '）：' + j.error);
        }
      }
      return { checked: jobs.length };
    } finally { ticking = false; }
  }

  function startTimer() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      tick().catch((err) => log('err', '图片生图轮询循环异常：' + String((err && err.message) || err)));
    }, POLL_INTERVAL_MS);
    if (tickTimer.unref) tickTimer.unref();
  }
  function stopTimer() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  /* ---------------- 启动期恢复 ----------------
     只恢复**需要继续查服务商的**任务（约束 2 的"重启后恢复"）。
     ⚠ `ready` 不算"待恢复"：它在等**用户**决定（采用/放弃），没有东西可查 ——
       把它计进 resumed 会误导（日志说"恢复了 N 条"，其中一条其实什么都没做）。
     submitting 且没有 taskId 的条目无法续查（提交响应在内存里丢了），
     但它也**不能**自动重发 —— 转成 submission_unknown 交人工核对。 */
  function reconcile(db) {
    const map = ensureMap(db);
    let resumed = 0, unknown = 0;
    Object.keys(map).forEach((k) => {
      const j = map[k];
      if (!j) return;
      delete j._busy;                     // 运行态标记不跨进程
      if (!ACTIVE_STATES.includes(j.state)) return;
      if (j.state === STATE.READY) return;   // 等用户决定，不是等服务商
      if (j.providerTaskId) { resumed++; return; }
      j.state = STATE.SUBMISSION_UNKNOWN;
      j.error = '上次提交未取得任务 ID（应用重启）。请到服务商控制台核对后再决定是否重新提交。';
      j.updatedAt = now();
      unknown++;
    });
    if (resumed || unknown) saveAll();
    return { resumed, unknown };
  }

  /* ---------------- 孤儿候选文件清理 ----------------
     为什么需要：用户点了"采用"却在中途关掉应用、或候选图写完但任务记录随即被删，
     都会留下没有任务引用的候选文件。它们会一直占着项目数据目录。
     ⚠ 有界清理：只删**候选目录**里目录项，且只删不在 imageJobs 里的；
       绝不动 assets / output（那是用户原始素材与产物）。 */
  function gcCandidates(db) {
    const map = ensureMap(db);
    const keep = new Set();
    Object.keys(map).forEach((k) => {
      const j = map[k];
      if (j && j.candidateFile && j.projectId) keep.add(path.posix.join(j.projectId, j.candidateFile));
    });
    let removed = 0;
    const projectsRoot = PATHS.PROJECTS_DIR;
    let entries = [];
    try { entries = fs.readdirSync(projectsRoot); } catch (err) { return { removed: 0 }; }
    entries.forEach((pj) => {
      if (!PATHS.safeId(pj)) return;
      const dir = PATHS.candidateDir(pj);
      let files = [];
      try { files = fs.readdirSync(dir); } catch (err) { return; }
      files.forEach((f) => {
        if (!PATHS.safeFile(f)) return;
        if (keep.has(path.posix.join(pj, f))) return;
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (err) { /* 忽略 */ }
      });
      /* 目录空了就顺手删掉，别让"彻底删项目"之后还留一个空壳 */
      try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (err) { /* 忽略 */ }
    });
    return { removed };
  }

  /* ---------------- 资产 / 项目被删除时清理 ----------------
     用户删资产或整个项目时，对应的本地任务与候选文件一起清掉。
     对已提交的远端任务，**只停止本地使用其结果**，不承诺远端取消（约束 6）。 */
  function dropAsset(assetId) {
    const db = e.db();
    const map = ensureMap(db);
    let n = 0;
    Object.keys(map).forEach((k) => {
      const j = map[k];
      if (!j || j.assetId !== assetId) return;
      if (j.candidateFile) {
        try { fs.unlinkSync(path.join(PATHS.candidateDir(j.projectId), j.candidateFile)); } catch (err) { /* 忽略 */ }
      }
      delete map[k];
      n++;
    });
    if (n) saveAll();
    return { removed: n };
  }
  function dropProject(projectId) {
    const db = e.db();
    const map = ensureMap(db);
    let n = 0;
    Object.keys(map).forEach((k) => {
      const j = map[k];
      if (!j || j.projectId !== projectId) return;
      delete map[k];
      n++;
    });
    /* 项目目录整体是否删除由 projects.hardDeleteProject 决定；
       这里只清"任务记录 + 候选目录"，避免与那条路径抢着删同一个目录。 */
    try {
      const dir = PATHS.candidateDir(projectId);
      fs.readdirSync(dir).forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (err) { /* 忽略 */ } });
      fs.rmdirSync(dir);
    } catch (err) { /* 目录不存在 / 非空都无所谓 */ }
    if (n) saveAll();
    return { removed: n };
  }

  return {
    STATE, ACTIVE_STATES,
    /* 暴露 provider 实例：services 侧需要读它的 status()（只回"配了没有"）。
       为什么不从 server.js 单独再传一份：那会有两个"服务商客户端"的持有者，
       任何一处忘了更新就是"界面说已配置、提交却说没配"。这里是唯一出口。 */
    provider: e.provider || null,
    submit, step, apply, discard, resave,
    tick, startTimer, stopTimer, reconcile, gcCandidates,
    dropAsset, dropProject,
    /* 下载传输注入（单测用；生产不调用） */
    setDownloadTransport,
    activeOfAsset: (assetId) => activeOfAsset(e.db(), assetId),
    listOfAsset: (assetId) => byAsset(e.db(), assetId).map((j) => viewJob(j, assetId)),
    findJob: (jobId) => {
      const map = ensureMap(e.db());
      const j = map[jobId];
      return j ? viewJob(j, j.assetId) : null;
    },
    /* 内部用：拿到**可变**的任务对象（viewJob 是快照，改它不生效） */
    rawJob: (jobId) => ensureMap(e.db())[jobId] || null,
    /* 测试与排查用：不走网络地推进一次 */
    _dueJobs: () => dueJobs(e.db())
  };
}

module.exports = {
  makeImageJobs, STATE, ACTIVE_STATES,
  sniffImage, imageProblem, urlProblem, downloadImage,
  POLL_INTERVAL_MS, MAX_DOWNLOAD_BYTES, MIN_DIM
};
