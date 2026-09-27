'use strict';
/* ============================================================
   providers/_shared.js —— 所有生图 provider 适配器共用的 HTTP / 错误工具

   为什么抽到独立文件：Work Fisher / OpenAI / Stability 都做同样的事
   （发请求、读响应、判错误、判超时、判脱敏），把可注入传输层放在这里，
   三个适配器都从这里 import 同一份，单测里 setTransport 一次所有适配器
   都用假传输。

   ⚠ 三条不变式（沿用 0.41.0 image-provider.js 顶部约束）：
   1. 提交请求**不做自动重试**。提交是计费动作；超时后重发可能产生第二个远端任务。
      超时一律如实报 `timeout`，由上层转成 `submission_unknown` 交给人工核对。
   2. 缺字段时报告协议错误，不猜。同步 provider 的同步成功也只认**协议约定的字段名**；
      缺了就报错 —— 猜一个下载地址等于把"下错文件"写进用户的素材库。
   3. 密钥只进不出。本模块的任何返回值（含错误对象的 data）都不得包含
      Authorization 头或密钥原文；日志同理（见 redact）。
   ============================================================ */
const https = require('https');

const SUBMIT_TIMEOUT_MS = 30 * 1000;
const QUERY_TIMEOUT_MS = 20 * 1000;
const MAX_BODY_BYTES = 512 * 1024;

let transportOverride = null;
function defaultTransport() {
  return {
    request(url, opts, cb) {
      const o = opts || {};
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
            if (total > MAX_BODY_BYTES) return fail(new Error('响应体过大'));
            total += d.length;
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

function redact(v) {
  const s = String(v == null ? '' : v);
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/([?&](?:token|key|signature|sig|expires|auth)=)[^&\s]+/gi, '$1<redacted>');
}

function mkErr(kind, message, extra) {
  return Object.assign({ kind: kind, message: redact(message) }, extra || {});
}

function kindOfStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'no_credit';
  if (status === 429) return 'ratelimit';
  return 'upstream';
}

function messageOfBody(body, status) {
  const text = String(body || '');
  if (text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const m = (j && j.error && (j.error.message || j.error.msg))
        || (j && (j.message || j.msg))
        || (j && j.error && typeof j.error === 'string' ? j.error : null);
      if (m) return String(m).slice(0, 300);
    } catch (e) { /* not JSON */ }
  }
  const t = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, 200);
  return '服务商返回 HTTP ' + status;
}

function callJson(opts) {
  const o = opts || {};
  const url = o.url;
  const headers = Object.assign({ 'Accept': 'application/json', 'Content-Type': 'application/json' }, o.headers || {});
  const body = o.body ? JSON.stringify(o.body) : null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    if (!/^https:\/\//i.test(url)) {
      return done(mkErr('config', '生图服务地址必须是 https：' + redact(url)));
    }
    try {
      transport().request(url, {
        method: o.method || 'GET',
        headers: headers,
        timeoutMs: o.timeoutMs,
        body: body
      }, (res) => {
        if (!res || res.error) {
          const msg = String((res && res.error && res.error.message) || (res && res.error) || '未收到响应');
          const kind = /超时|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg) ? 'timeout' : 'network';
          return done(mkErr(kind, kind === 'timeout' ? '请求服务商超时' : ('无法连接服务商：' + msg)));
        }
        if (typeof res.statusCode !== 'number') {
          return done(mkErr('protocol', '服务商响应缺少状态码'));
        }
        const raw = res.body == null ? '' : String(res.body);
        let json = null;
        if (raw) { try { json = JSON.parse(raw); } catch (e) { json = null; } }
        done({ status: res.statusCode, headers: res.headers || {}, json: json, raw: raw });
      });
    } catch (e) {
      done(mkErr('network', '发起请求失败：' + String((e && e.message) || e)));
    }
  });
}

module.exports = {
  SUBMIT_TIMEOUT_MS, QUERY_TIMEOUT_MS, MAX_BODY_BYTES,
  transport, setTransport, defaultTransport,
  redact, mkErr, kindOfStatus, messageOfBody,
  callJson
};