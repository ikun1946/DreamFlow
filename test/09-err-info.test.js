'use strict';
/* ============================================================
   09-err-info.test.js —— 错误码四件套元数据（阶段 3 第二刀 · 0.29.1）

   为什么单开一组：
     ERR 之前是 code ↔ name 的纯映射，前端拿到 code 后只能看 message 字符串判断
     该做什么（脆）。这一组钉住"每个码都得有元数据"，回归里能立刻发现
     "新增了一个 ERR 码但忘了登记 ERR_CATEGORIES / ERR_RETRYABLE / ERR_HINTS"。

   ⚠ 数据隔离：JC_DATA_DIR 指到仓库内 .test-tmp 沙箱（AGENTS.md 红线）。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');

const H = require('./helpers');

/* 数据根必须最先重定向：runtime/config/paths 都在 require 时读 env */
const SANDBOX = H.freshDir('err-info');
process.env.JC_DATA_DIR = SANDBOX;

const { ERR, errInfo, ERR_CATEGORIES, ERR_RETRYABLE, ERR_HINTS, ERR_HTTP, ApiError } = require('../server/util');
const { createServer } = require('../server/server');

let srv = null;
let base = '';

async function api(method, path, body) {
  const opt = { method };
  if (body !== undefined) {
    opt.body = JSON.stringify(body);
    opt.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(base + path, opt);
  return { status: res.status, body: await res.json() };
}

describe('errInfo —— 已知码的元数据完整 (阶段 3 四件套)', () => {
  test('每个 ERR 码都有 category / retryable / http / hint 四件套', () => {
    /* 这是这条测试的核心目标：新增 ERR.* 码时若忘了登记元数据，这里会失败。
       ⚠ 排除 OK：OK 是成功码，不应该有"建议怎么修"这种 hint。 */
    const names = Object.keys(ERR).filter((k) => k !== 'OK');
    for (const name of names) {
      const code = ERR[name];
      const info = errInfo(code);
      assert.ok(info, name + ' 应该有元数据（errInfo(' + code + ') 不能为 null）');
      assert.equal(info.name, name, name + ' 的元数据 name 字段要对得上');
      assert.ok(typeof info.category === 'string' && info.category.length > 0,
        name + ' 必须有 category');
      assert.ok(['param', 'notfound', 'conflict', 'forbidden', 'ratelimit', 'internal',
        'cli', 'tool', 'unknown'].includes(info.category),
        name + ' category 必须在已知集合内，实得 ' + info.category);
      assert.equal(typeof info.retryable, 'boolean', name + ' retryable 必须是 boolean');
      assert.ok(typeof info.http === 'number' && info.http >= 400 && info.http < 600,
        name + ' http 必须是 4xx/5xx，实得 ' + info.http);
      assert.ok(typeof info.hint === 'string' && info.hint.length > 0,
        name + ' 必须有可读 hint（前端能直接弹给用户）');
    }
  });

  test('★ 几个关键码的 retryable 必须按业务期望（回归用）', () => {
    /* 这条是"行为断言"而非"形状断言"：单看元数据对不对没法保证 retryable 的方向。
       业务上：
         · 参数错 / 资源不存在 / 账号没权限 / 上游业务失败 / 缺工具 / 缺积分 —— 都不可重试；
         · 上游超时 / 服务中断 —— 可重试；
         · 限流 —— 可重试。 */
    assert.equal(errInfo(ERR.PARAM).retryable, false, '参数错不可重试');
    assert.equal(errInfo(ERR.NOTFOUND).retryable, false);
    assert.equal(errInfo(ERR.FORBIDDEN).retryable, false);
    assert.equal(errInfo(ERR.CLI_PERMISSION_DENIED).retryable, false, '会员拒绝不可重试');
    assert.equal(errInfo(ERR.FFMPEG_NOT_FOUND).retryable, false, '缺工具不可重试（要用户装）');
    assert.equal(errInfo(ERR.NO_CREDIT).retryable, false, '缺积分不可重试（要用户充）');
    assert.equal(errInfo(ERR.UPSTREAM_TIMEOUT).retryable, true, '上游超时可重试');
    assert.equal(errInfo(ERR.INTERRUPTED).retryable, true, '服务中断可重试（续查 submit_id）');
    assert.equal(errInfo(ERR.RATELIMIT).retryable, true, '限流可重试');
  });

  test('★ 0.29.1 新增的 3 个上游语义码都登记完整', () => {
    /* NO_SUBMIT_ID / UPSTREAM_FAILED / MODEL_NEEDS_FIRST_RUN 是本轮补的码，
       之前都用 ERR.INTERNAL + 自由文本 —— 测试钉住"以后再改的话别漏登记"。 */
    for (const name of ['NO_SUBMIT_ID', 'UPSTREAM_FAILED', 'MODEL_NEEDS_FIRST_RUN']) {
      const info = errInfo(ERR[name]);
      assert.ok(info, name + ' 应该有元数据');
      assert.equal(info.category, 'cli', name + ' 是 cli 类');
      assert.equal(info.retryable, false, name + ' 不可自动重试（MODEL_NEEDS_FIRST_RUN 是用户操作）');
      assert.ok(info.hint && info.hint.length > 0);
    }
  });

  test('★ 补充登记：0 是成功码，没元数据，errInfo(0) 返回 null', () => {
    /* OK = 0 不在错误表里 —— 不该让前端把它当错误看待。
       实际行为：OK 不会被 fail() 调用（那是 ok() 用的），但 errInfo(0) 必须
       显式返回 null，避免被误当作"未知错误"给用户弹"未知"提示。 */
    assert.equal(errInfo(0), null, 'OK 是成功码，不在错误元数据表里');
    assert.equal(errInfo(99999999), null, '不存在的码应返回 null，不是 {}');
  });
});

describe('fail() —— 错误响应带四件套元数据（HTTP 级）', () => {
  before(async () => {
    srv = createServer({ configOverrides: { port: 0, token: '' } });
    const addr = await srv.start();
    base = 'http://127.0.0.1:' + addr.port;
  });

  test('★ 真实 HTTP 响应：404 端点的 data.__err 必带 category / retryable / messageHint', async () => {
    /* 端点不存在 → ERR.NOTFOUND → fail() 应给前端带结构化元数据。
       之前只有 code + message + data + traceId，前端必须正则匹配 message —— 脆。
       现在 data.__err 里直接给 category / retryable / messageHint，前端按元数据分支。 */
    const r = await api('GET', '/api/v1/__no_such_path__');
    assert.equal(r.body.code, ERR.NOTFOUND);
    assert.ok(r.body.data, 'data 字段应存在');
    assert.ok(r.body.data.__err, '★ data.__err 必须存在 —— 这是四件套的第四件');
    const e = r.body.data.__err;
    assert.equal(e.name, 'NOTFOUND');
    assert.equal(e.category, 'notfound');
    assert.equal(e.retryable, false);
    assert.equal(typeof e.messageHint, 'string');
    assert.ok(e.messageHint.length > 0);
  });

  test('★ 真实 ApiError 抛出：也走 fail()，data.__err 仍带元数据', async () => {
    /* 找一处已知抛 ApiError 的路由来验证。projects 找不到时抛 NOTFOUND；
       POST 一个不存在的 project 下的 workspaces 也会触发。 */
    const r = await api('POST', '/api/v1/projects/pj_no_such_workspace_xx/workspaces', { name: 'x' });
    assert.equal(r.body.code, ERR.NOTFOUND);
    assert.ok(r.body.data && r.body.data.__err, 'data.__err 必须存在');
  });
});

after(async () => {
  if (srv) await srv.stop();
  H.rmrf(SANDBOX);
});