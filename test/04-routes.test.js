'use strict';
/* ============================================================
   04-routes.test.js —— 路由层行为测试（P1-4）

   为什么单开一组：**路由与作用域是"最贵"的链路** —— 跨项目越权、父子校验、
   幂等回放、上传体积上限，这些 bug 都是数据级的（写错项目、重复扣积分、
   半个文件落库），人工巡检很难发现，必须靠行为测试钉住。
   test/01 覆盖模块级数据安全；这里覆盖**接线**：真起服务、真打 HTTP、真走路由表 ——
   mock 掉任何一层都测不到作用域解析与幂等包装的真实行为。

   ⚠ 数据隔离：JC_DATA_DIR 指到仓库内 .test-tmp 沙箱（AGENTS.md 红线）。
   ⚠ 起真服务：createServer({ configOverrides: { port: 0, … } })，port 0 让系统
     分配空闲端口，避免与开发中的 8787/8789 撞车。
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const H = require('./helpers');

/* 数据根必须最先重定向：runtime/config/paths 都在 require 时读 env */
const SANDBOX = H.freshDir('routes');
process.env.JC_DATA_DIR = SANDBOX;

const { createServer } = require('../server/server');

let srv = null;
let base = '';

before(async () => {
  /* uploadMaxBytes 特意调小（16 KB）：让"超限"用例传 32 KB 就能触发，
     不必真的传 30 MB —— 体积上限是路由层（readBody）的职责，与文件大小无关。 */
  srv = createServer({ configOverrides: { port: 0, token: '', uploadMaxBytes: 16 * 1024 } });
  const addr = await srv.start();
  base = 'http://127.0.0.1:' + addr.port;
});

after(async () => {
  if (srv) await srv.stop();
  H.rmrf(SANDBOX);
});

/* ---------------- HTTP 小工具 ---------------- */
async function api(method, path, body, headers) {
  const opt = { method, headers: Object.assign({}, headers || {}) };
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) {
      opt.body = body;
      opt.headers['Content-Type'] = opt.headers['Content-Type'] || 'application/octet-stream';
    } else {
      opt.body = JSON.stringify(body);
      opt.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(base + path, opt);
  const text = await res.text();
  let env = null;
  try { env = JSON.parse(text); } catch (e) { env = null; }
  return { status: res.status, env, text };
}
const okData = (r, label) => {
  assert.ok(r.env, (label || '') + ' 响应应为 JSON 信封，实得：' + String(r.text).slice(0, 200));
  assert.equal(r.env.code, 0, (label || '') + ' 期望 code=0，实得 ' + r.env.code + '：' + r.env.message);
  return r.env.data;
};

async function newProjectWithWorkspace(name) {
  const p = okData(await api('POST', '/api/v1/projects', { name: name }), '建项目');
  const pid = (p.project || p).id;
  const w = okData(await api('POST', '/api/v1/projects/' + pid + '/workspaces', { name: '主分镜表' }), '建工作区');
  const wid = (w.workspace || w).id;
  return { pid, wid };
}
const importPrompt = (pid, wid, text, idemKey) => api(
  'POST',
  '/api/v1/storyboards/import?projectId=' + pid + '&workspaceId=' + wid,
  { rawText: text },
  idemKey ? { 'Idempotency-Key': idemKey } : undefined
);
const listStoryboards = (pid, wid) => api('GET', '/api/v1/storyboards?projectId=' + pid + '&workspaceId=' + wid);

describe('路由 —— 作用域与父子校验（数据隔离底线）', () => {
  test('★ 跨项目越权：项目 A + 工作区 B 必须 404，且响应体不含 B 的任何数据', async () => {
    const A = await newProjectWithWorkspace('路由测试 A');
    const B = await newProjectWithWorkspace('路由测试 B');
    okData(await importPrompt(A.pid, A.wid, 'A项目独有内容-AAA'), 'A 导入');
    okData(await importPrompt(B.pid, B.wid, 'B项目独有内容-BBB'), 'B 导入');

    /* 组合请求：projectId=A + workspaceId=B（B 属于 B 项目）——
       这正是"父子不一致"，resolveScope 必须按"资源不存在"拒绝（不能以任一方为准）。 */
    const bad = await api('GET', '/api/v1/storyboards?projectId=' + A.pid + '&workspaceId=' + B.wid);
    assert.equal(bad.env && bad.env.code, 40400, '父子不匹配必须 40400，实得 ' + (bad.env && bad.env.code));
    assert.ok(!bad.text.includes('B项目独有内容-BBB'), '★ 404 响应体不得泄露 B 项目的数据');

    // 反向组合同样拒绝
    const bad2 = await api('GET', '/api/v1/storyboards?projectId=' + B.pid + '&workspaceId=' + A.wid);
    assert.equal(bad2.env && bad2.env.code, 40400, '反向父子不匹配也必须 40400');

    // 正例必须保住：正确的作用域能读到自己的数据
    const okA = okData(await listStoryboards(A.pid, A.wid), 'A 列表');
    assert.ok(JSON.stringify(okA).includes('A项目独有内容-AAA'), '正确作用域应读到 A 自己的分镜');
    assert.ok(!JSON.stringify(okA).includes('B项目独有内容-BBB'), '★ A 的列表不得混入 B 的数据');
  });

  test('路径段优先于查询串（scopeIdsOf 的既定优先级）', async () => {
    const A = await newProjectWithWorkspace('优先级 A');
    const B = await newProjectWithWorkspace('优先级 B');
    okData(await importPrompt(A.pid, A.wid, '优先级-A-数据'), 'A 导入');
    okData(await importPrompt(B.pid, B.wid, '优先级-B-数据'), 'B 导入');

    /* /projects/A/storyboards?projectId=B —— 路径段说了 A，查询串说了 B。
       按 scopeIdsOf：**路径优先**（查询串只在路径没给时才兜底）。
       所以必须返回 A 的数据，而不是 B 的、也不是"冲突 404"。 */
    const r = await api('GET', '/api/v1/projects/' + A.pid + '/storyboards?projectId=' + B.pid);
    const data = okData(r, '路径优先');
    const s = JSON.stringify(data);
    assert.ok(s.includes('优先级-A-数据'), '应返回路径段所指项目（A）的数据');
    assert.ok(!s.includes('优先级-B-数据'), '★ 不得被查询串改写成 B 的数据');
  });

  test('未知路径与"方法不匹配"都必须是 40400，且不落到别的 handler', async () => {
    const unknown = await api('GET', '/api/v1/definitely-not-a-route');
    assert.equal(unknown.env && unknown.env.code, 40400, '未知路径必须 40400');

    // /projects 只有 GET/POST；DELETE 没有定义 —— 不得落到 /projects/:id 的 DELETE 上
    const wrongMethod = await api('DELETE', '/api/v1/projects');
    assert.equal(wrongMethod.env && wrongMethod.env.code, 40400, '方法不匹配必须 40400');

    /* /system/cli/install 只有 POST。用 GET 打它必须 40400 ——
       如果误落到别的 handler，这条会红（副作用：真去装 CLI）。 */
    const wrongMethod2 = await api('GET', '/api/v1/system/cli/install');
    assert.equal(wrongMethod2.env && wrongMethod2.env.code, 40400, 'GET 不得触发 POST-only 路由');
  });
});

describe('路由 —— 幂等包装（防重复提交）', () => {
  test('★ 同一把 Idempotency-Key 打同一路径：第二次回放第一次的响应，不重复落库', async () => {
    const P = await newProjectWithWorkspace('幂等 同项目');
    const KEY = 'route-idem-same-' + Date.now();

    const first = okData(await importPrompt(P.pid, P.wid, '幂等-第一次', KEY), '第一次导入');
    assert.equal(first.createdCount, 1, '第一次应真的建 1 条');
    const afterFirst = okData(await listStoryboards(P.pid, P.wid), '第一次后列表');
    assert.equal(afterFirst.total, 1, '第一次后应只有 1 条');

    const second = await importPrompt(P.pid, P.wid, '幂等-第一次', KEY);
    assert.equal(second.env && second.env.code, 0, '第二次应回放成功响应');
    assert.deepEqual(second.env.data, first, '★ 第二次必须逐字段回放第一次的响应');
    const afterSecond = okData(await listStoryboards(P.pid, P.wid), '第二次后列表');
    assert.equal(afterSecond.total, 1, '★ 回放不得再建一条（否则就是重复扣积分的隐患）');
  });

  test('★ 同一把 key 打到另一个项目：必须各自执行（键里含作用域，禁止跨项目回放）', async () => {
    const A = await newProjectWithWorkspace('幂等 跨项目 A');
    const B = await newProjectWithWorkspace('幂等 跨项目 B');
    const KEY = 'route-idem-cross-' + Date.now();

    const ra = okData(await importPrompt(A.pid, A.wid, '跨项目-A-内容', KEY), 'A 导入');
    assert.equal(ra.createdCount, 1, 'A 应真的建 1 条');

    /* 同一把客户端 key 打到 B：键 = 路径 + projectId + workspaceId + 客户端 key，
       作用域不同 → 键不同 → 必须**各自执行**，而不是回放 A 的响应。
       （历史漏洞形态：键里没有作用域，B 拿到的是 A 的响应 —— 跨项目串线。） */
    const rb = await importPrompt(B.pid, B.wid, '跨项目-B-内容', KEY);
    const dataB = okData(rb, 'B 导入');
    assert.equal(dataB.createdCount, 1, '★ B 必须真的执行（不得回放 A 的响应）');
    assert.ok(JSON.stringify(dataB).includes('跨项目-B-内容'), 'B 的响应应是 B 自己的内容');

    const listB = okData(await listStoryboards(B.pid, B.wid), 'B 列表');
    assert.equal(listB.total, 1, 'B 项目里应有 1 条');
    assert.ok(JSON.stringify(listB).includes('跨项目-B-内容'));
  });
});

describe('路由 —— 上传体积上限', () => {
  test('★ 超限必须 40001（或连接被关闭），且不落库', async () => {
    const P = await newProjectWithWorkspace('上传上限');
    const before = okData(await api('GET', '/api/v1/assets?type=character&projectId=' + P.pid), '上传前素材数');

    // 正例：小文件（512 B < 16 KB 上限）应当成功
    /* ⚠ 扩展名必须合法（.png）—— createAsset 按类型校验扩展名，
       用 .bin 会先被"扩展名不合法"拒掉，测的就不是体积上限了。 */
    const small = Buffer.alloc(512, 1);
    const r1 = await api('POST', '/api/v1/assets/upload?type=character&name=small.png&projectId=' + P.pid,
      small, { 'Content-Type': 'image/png' });
    assert.equal(r1.env && r1.env.code, 0, '小文件应上传成功，实得 ' + (r1.env && r1.env.code));

    // 反例：32 KB > 16 KB 上限
    const big = Buffer.alloc(32 * 1024, 2);
    let code = null, errored = null;
    try {
      const r2 = await api('POST', '/api/v1/assets/upload?type=character&name=big.png&projectId=' + P.pid,
        big, { 'Content-Type': 'image/png' });
      code = r2.env ? r2.env.code : null;
    } catch (e) { errored = e; }
    assert.ok(errored || code === 40001,
      '★ 超限上传必须被拒（40001 或连接被关闭），实得 code=' + code + (errored ? '（连接错误：' + errored.message + '）' : ''));

    // 不落库：字符素材数只增加了"小文件"那一条
    const after = okData(await api('GET', '/api/v1/assets?type=character&projectId=' + P.pid), '上传后素材数');
    assert.equal(after.library.length, before.library.length + 1,
      '★ 超限的那次不得留下半截记录（前后应只差 1 条：成功的小文件）');
    assert.ok(after.library.every((a) => a.name !== 'big'), '超限文件不得出现在素材库里');
  });
});
