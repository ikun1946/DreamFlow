'use strict';
/* ============================================================
   audio-budget.test.js —— 音频参考的预算（数量 + 总时长）与空素材新建
   运行：node --test server/audio-budget.test.js

   背景（2026-09-20 用户要求）：
     · 音频槽位由单值改为**多值**（一个分镜常有多角色，各自的音色是不同文件）；
     · 绑定音频不仅要有**数量**限制，还要有**总时长**限制，总时长不得超过 15 秒；
     · 音频素材按「角色名+音色」命名（「林晚音色」），自动匹配要能同时关联图片与音色。

   本文件钉住四件事：
     ① 空素材新建（POST /assets）与"建完再补文件"（名称不被文件名覆盖）
     ② 音频可多绑；数量上限按模型；**总时长上限**；时长未知一律拒绝
     ③ 音频名解析（音色后缀只对音频生效，图片路径一字未改）
     ④ 自动匹配同时绑图片与音色，且超预算的进 overLimit 并带原因

   ⚠ 与 project-isolation.test.js 同款防护：store.load 换成内存假库、
     save/pushLog 换成空实现，全程不碰 server/data/db.json。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const store = require('./store');
let DB = null;
store.load = () => DB;
store.pushLog = () => {};
store.save = () => {};
store.saveNow = () => {};
store.flush = () => {};

const { makeRouter } = require('./routes');
const S = require('./services');
const { ERR } = require('./util');
const { fail } = require('./util');

const adapter = {
  resolveMaxConcurrency: async () => ({ max: 0, source: 'none(不限制)' }),
  dreamina: {
    peek: () => ({ available: true, credit: 9999 }),
    lastProbe: () => ({ available: true, credit: 9999 }),
    probe: async () => ({ available: true, credit: 9999 }),
    buildSubmitArgs: () => ({ args: ['text2video'], notes: [] })
  }
};
const dispatch = makeRouter({ idempotencyTtlMs: 60000, uploadMaxBytes: 1024 * 1024, projectId: 'pj_1' }, adapter);

/* ---------------- 极简 req/res 桩（与 project-isolation.test.js 同款） ---------------- */
function mockReq(method, url, body, headers) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  const isBuf = Buffer.isBuffer(body);
  req.headers = Object.assign(
    { host: 'localhost', 'content-type': isBuf ? 'application/octet-stream' : 'application/json' },
    headers || {}
  );
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined && body !== null) {
      req.emit('data', isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}
function mockRes() {
  const res = { statusCode: 0, headers: null, raw: '' };
  res.setHeader = () => {};
  res.writeHead = (code, h) => { res.statusCode = code; res.headers = h; };
  res.end = (b) => { res.raw = b ? String(b) : ''; };
  res.destroy = () => {};
  return res;
}
async function call(method, path, body, headers) {
  const res = mockRes();
  const pathname = decodeURIComponent(path.split('?')[0]);
  try {
    await dispatch(mockReq(method, path, body, headers), res, pathname);
  } catch (e) { fail(res, e); }
  return JSON.parse(res.raw || '{}');
}
const dataOf = async (m, p, b, h) => {
  const j = await call(m, p, b, h);
  assert.equal(j.code, 0, m + ' ' + p + ' 应成功，实际 code=' + j.code + ' msg=' + j.message);
  return j.data;
};
const codeOf = async (m, p, b, h) => (await call(m, p, b, h)).code;
const msgOf = async (m, p, b, h) => (await call(m, p, b, h)).message;

/* ---------------- 假库 ---------------- */
const PJ = 'pj_1', WS = 'ws_1';
const Q = '?projectId=' + PJ + '&workspaceId=' + WS;

function fixture(opts) {
  const o = opts || {};
  return {
    schemaVersion: 3,
    projects: [{ id: PJ, name: 'P', settings: {}, defaultWorkspaceId: WS, deletedAt: null }],
    workspaces: [{ id: WS, projectId: PJ, name: 'W', deletedAt: null }],
    storyboards: [{
      id: 'st_1', projectId: PJ, workspaceId: WS, seq: 1,
      prompt: o.prompt || '', status: 'draft', assets: [],
      model: o.model || 'seedance2.0', durationSec: 5, ratio: '16:9', resolution: '720p'
    }],
    assets: [], records: [],
    settings: {
      delimiter: { type: 'custom', value: ';;' },
      defaults: { model: 'seedance2.0', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' },
      queue: { concurrency: 2, autoRetry: false, maxRetry: 2 },
      adapter: {}
    },
    seq: 1, idempotency: {}, cliJobs: {}, logs: {}, recordSeq: 0
  };
}
/* 夹具构造：直接塞素材（非被测路径）。url 为 null = 没有本地文件。 */
function seed(db, name, type, durationSec) {
  const a = {
    id: 'as_' + name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + Math.random().toString(36).slice(2, 5),
    projectId: PJ, name, type, url: null, thumbUrl: null,
    width: 0, height: 0, size: 0, tags: [], createdAt: new Date().toISOString(),
    gradSeedKey: 'g', origin: 'prompt'
  };
  if (type === 'audio') a.durationSec = durationSec === undefined ? 3 : durationSec;
  db.assets.push(a);
  return a;
}
const sb = (db) => db.storyboards[0];

/* ============================================================
   ① 空素材新建
   ============================================================ */
test('新建空素材：只填名称与类型即可，url/thumbUrl/时长均为空，origin 标记为 manual', async () => {
  DB = fixture();
  const a = await dataOf('POST', '/assets' + Q, { name: '林晚', type: 'character' });
  assert.equal(a.name, '林晚');
  assert.equal(a.type, 'character');
  assert.equal(a.url, null, '空素材没有文件');
  assert.equal(a.thumbUrl, null);
  assert.equal(a.durationSec, null, '没有文件就没有时长');
  assert.ok(a.grad, '占位渐变仍要能算出来（前端靠它显示无图卡片）');
  const raw = DB.assets.find((x) => x.id === a.id);
  assert.equal(raw.origin, 'manual');
  assert.equal(raw.projectId, PJ, '素材归属当前项目');
});

test('新建空素材：名称必填、超长、类型非法都要被拒', async () => {
  DB = fixture();
  assert.equal(await codeOf('POST', '/assets' + Q, { name: '  ', type: 'character' }), ERR.PARAM, '空名称被拒');
  assert.equal(await codeOf('POST', '/assets' + Q, { name: 'x'.repeat(61), type: 'character' }), ERR.PARAM, '超 60 字被拒');
  assert.equal(await codeOf('POST', '/assets' + Q, { name: 'n', type: '不存在的类型' }), ERR.PARAM, '类型非法被拒');
  assert.equal(DB.assets.length, 0, '被拒时不得留下半成品素材');
});

test('新建空素材可带提示词；音频空素材时长记 null（不是 0）', async () => {
  DB = fixture();
  const a = await dataOf('POST', '/assets' + Q, { name: '林晚', type: 'character', prompt: '文生图提示词' });
  assert.equal(a.prompt, '文生图提示词');
  const au = await dataOf('POST', '/assets' + Q, { name: '林晚音色', type: 'audio' });
  assert.equal(au.durationSec, null, '时长未知必须是 null，不能是 0（0 会被当成"已知且为零"）');
});

/* ============================================================
   ② 音频预算：多值 / 数量 / 总时长 / 时长未知
   ============================================================ */
test('音频可多绑：连绑两条音频两条都在（改前第二条会顶掉第一条）', async () => {
  DB = fixture();
  const a1 = seed(DB, '林晚音色', 'audio', 3);
  const a2 = seed(DB, '顾言音色', 'audio', 4);
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: a1.id, role: 'audio' });
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: a2.id, role: 'audio' });
  const bound = sb(DB).assets.filter((r) => r.role === 'audio');
  assert.equal(bound.length, 2, '两条音色都要在');
  assert.deepEqual(bound.map((r) => r.assetId).sort(), [a1.id, a2.id].sort());
});

test('重复绑同一条音频是幂等的：不重复计数、也不重复写', async () => {
  DB = fixture();
  const a = seed(DB, '林晚音色', 'audio', 3);
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: a.id, role: 'audio' });
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: a.id, role: 'audio' });
  assert.equal(sb(DB).assets.filter((r) => r.role === 'audio').length, 1);
});

test('音频数量上限：按当前模型算（seedance2.0 是 3 个），第 4 条被拒', async () => {
  DB = fixture({ model: 'seedance2.0' });   // 上限 3
  const ids = [1, 2, 3, 4].map((i) => seed(DB, '音色' + i, 'audio', 1).id);
  for (let i = 0; i < 3; i++) {
    await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: ids[i], role: 'audio' });
  }
  const code = await codeOf('POST', '/storyboards/st_1/assets' + Q, { assetId: ids[3], role: 'audio' });
  assert.equal(code, ERR.PARAM, '超出数量上限必须被拒');
  assert.match(await msgOf('POST', '/storyboards/st_1/assets' + Q, { assetId: ids[3], role: 'audio' }), /数量超限/);
  assert.equal(sb(DB).assets.filter((r) => r.role === 'audio').length, 3, '被拒的那条不得写进去');
});

test('音频总时长上限：3 条 6 秒合计 18 秒 > 15 秒，第三条被拒且原因是时长', async () => {
  DB = fixture({ model: 'seedance2.5' });   // 数量上限 10，本用例只考时长
  const ids = [1, 2, 3].map((i) => seed(DB, '音色' + i, 'audio', 6).id);
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: ids[0], role: 'audio' });
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: ids[1], role: 'audio' });
  const msg = await msgOf('POST', '/storyboards/st_1/assets' + Q, { assetId: ids[2], role: 'audio' });
  assert.match(msg, /总时长超限/, '必须是时长原因，不能报成数量原因');
  assert.match(msg, /15/, '错误信息要写明上限是多少秒');
  assert.equal(sb(DB).assets.filter((r) => r.role === 'audio').length, 2);
});

test('音频总时长上限的边界：合计恰好 15.0 秒必须能通过', async () => {
  DB = fixture({ model: 'seedance2.5' });
  const ids = [1, 2, 3].map((i) => seed(DB, '音色' + i, 'audio', 5).id);   // 5+5+5 = 15
  for (const id of ids) {
    await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: id, role: 'audio' });
  }
  assert.equal(sb(DB).assets.filter((r) => r.role === 'audio').length, 3, '恰好等于上限应放行（浮点容差）');
});

test('时长未知的音频不允许绑定，错误信息要给出可操作的出路', async () => {
  DB = fixture();
  const a = seed(DB, '林晚音色', 'audio', null);   // durationSec = null
  const msg = await msgOf('POST', '/storyboards/st_1/assets' + Q, { assetId: a.id, role: 'audio' });
  assert.match(msg, /时长/, '要说清是时长问题');
  assert.match(msg, /重新选择一次文件/, '要给可操作的出路');
  assert.equal(sb(DB).assets.length, 0, '不得写入');
});

test('已绑里有时长未知的音频时，再绑别的音频也要被拦（否则总时长不可信）', async () => {
  DB = fixture();
  const bad = seed(DB, '坏音色', 'audio', null);
  const good = seed(DB, '好音色', 'audio', 2);
  sb(DB).assets.push({ assetId: bad.id, role: 'audio' });     // 夹具直接造出"已绑但时长未知"
  const msg = await msgOf('POST', '/storyboards/st_1/assets' + Q, { assetId: good.id, role: 'audio' });
  assert.match(msg, /坏音色/, '要点名是哪一条缺时长');
  assert.equal(sb(DB).assets.filter((r) => r.role === 'audio').length, 1, '新的那条不得写入');
});

test('解绑后总时长回落，原来被拒的音频可以再绑上', async () => {
  DB = fixture({ model: 'seedance2.5' });
  const a = seed(DB, '音色A', 'audio', 10);
  const b = seed(DB, '音色B', 'audio', 10);   // 10+10=20 > 15
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: a.id, role: 'audio' });
  assert.equal(await codeOf('POST', '/storyboards/st_1/assets' + Q, { assetId: b.id, role: 'audio' }), ERR.PARAM);
  await dataOf('DELETE', '/storyboards/st_1/assets/' + a.id + Q);
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: b.id, role: 'audio' });
  assert.equal(sb(DB).assets.filter((r) => r.role === 'audio').length, 1);
});

test('图片槽位不受音频预算影响：角色仍可多绑、场景仍单值', async () => {
  DB = fixture();
  const c1 = seed(DB, '林晚', 'character');
  const c2 = seed(DB, '顾言', 'character');
  const s1 = seed(DB, '客厅', 'scene');
  const s2 = seed(DB, '厨房', 'scene');
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: c1.id, role: 'character' });
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: c2.id, role: 'character' });
  assert.equal(sb(DB).assets.filter((r) => r.role === 'character').length, 2, '角色是多值');
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: s1.id, role: 'scene' });
  await dataOf('POST', '/storyboards/st_1/assets' + Q, { assetId: s2.id, role: 'scene' });
  assert.equal(sb(DB).assets.filter((r) => r.role === 'scene').length, 1, '场景仍是单值（后绑的替换前一个）');
});

test('预算规则：数量与时长**同时**生效，先撞到哪个就报哪个', () => {
  DB = fixture({ model: 'seedance2.0' });    // 数量上限 3
  const s = sb(DB);
  /* 3 条 1 秒 = 3 秒，数量刚好用满 */
  [1, 2, 3].forEach((i) => { const a = seed(DB, '音' + i, 'audio', 1); s.assets.push({ assetId: a.id, role: 'audio' }); });
  const more = seed(DB, '音4', 'audio', 1);
  const r = S.checkAudioBudget(s, DB, [more]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'count', '数量先撞上就报数量');
  assert.equal(S.audioBudgetOf(s, DB).sec, 3);
  assert.equal(S.audioBudgetOf(s, DB).count, 3);
});

/* ============================================================
   ③ 音频名解析：音色后缀只对音频生效
   ============================================================ */
test('音色名解析：「林晚音色」在音频下匹配主体是「林晚」', () => {
  const k = S.nameKeys('林晚音色', 'audio');
  assert.equal(k.core, '林晚', '音频要把「音色」当噪声剥掉，主体才是角色名');
  assert.equal(k.group, '林晚');
});

test('图片路径一字未改：「林晚音色」当图片素材时匹配主体仍是整串', () => {
  const k = S.nameKeys('林晚音色', 'character');
  assert.equal(k.core, '林晚音色', '图片的噪声词表与改动前逐字节相同，不得剥「音色」');
  /* 不传 type 时（历史调用形态）也必须与图片一致 */
  assert.deepEqual(S.nameKeys('林晚音色'), k);
});

test('音频名解析不影响原有噪声词：音频/配音/音效 仍然会被剥', () => {
  assert.equal(S.nameKeys('林晚音频', 'audio').core, '林晚');
  assert.equal(S.nameKeys('林晚音频', 'character').core, '林晚');
});

/* ============================================================
   ④ 自动匹配：同时绑图片与音色
   ============================================================ */
test('自动匹配同时关联图片与音色：提示词含「林晚」→ 角色与音色都绑上', async () => {
  DB = fixture({ prompt: '林晚走进厨房。角色音色：林晚 音色＝清亮偏柔女声。' });
  const c = seed(DB, '林晚', 'character');
  const au = seed(DB, '林晚音色', 'audio', 3);
  const prev = await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + WS, { ids: ['st_1'], apply: false });
  const row = prev.rows.find((r) => r.id === 'st_1');
  assert.ok(row, '该分镜应出现在预览里');
  const roles = row.toBind.map((m) => m.role).sort();
  assert.deepEqual(roles, ['audio', 'character'], '图片与音色都要命中');
  assert.equal(prev.stats.boundImages, 1, '统计要拆出图片数');
  assert.equal(prev.stats.boundAudios, 1, '统计要拆出音色数');

  await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + WS, { ids: ['st_1'], apply: true });
  const bound = sb(DB).assets.map((r) => r.role).sort();
  assert.deepEqual(bound, ['audio', 'character'], '应用后两条都要真的绑上');
  assert.equal(sb(DB).assets.find((r) => r.role === 'audio').assetId, au.id);
  assert.equal(sb(DB).assets.find((r) => r.role === 'character').assetId, c.id);
});

test('自动匹配的超时长音色进 overLimit，且带原因说明', async () => {
  DB = fixture({ prompt: '林晚走进厨房。林晚音色 很好听。', model: 'seedance2.5' });
  seed(DB, '林晚', 'character');
  seed(DB, '林晚音色', 'audio', 6);
  /* 先占掉 12 秒，再加 6 秒就会超过 15 秒 */
  const used = seed(DB, '占位音色', 'audio', 12);
  sb(DB).assets.push({ assetId: used.id, role: 'audio' });
  const prev = await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + WS, { ids: ['st_1'], apply: false });
  const row = prev.rows.find((r) => r.id === 'st_1');
  assert.equal(row.overLimit.length, 1, '超时长的音色要进 overLimit');
  assert.equal(row.overLimit[0].role, 'audio');
  assert.equal(row.overLimit[0].reason, 'duration', '必须带上是哪种原因');
  assert.ok(row.overLimit[0].message, '必须带可读的说明');
  assert.equal(prev.stats.boundAudios, 0, '它没有被绑上');
});

test('自动匹配遇到时长未知的音色：进 overLimit 且原因为 unknown-duration', async () => {
  DB = fixture({ prompt: '林晚走进厨房。林晚音色 很好听。', model: 'seedance2.5' });
  seed(DB, '林晚', 'character');
  seed(DB, '林晚音色', 'audio', null);
  const prev = await dataOf('POST', '/storyboards/auto-assets?workspaceId=' + WS, { ids: ['st_1'], apply: false });
  const row = prev.rows.find((r) => r.id === 'st_1');
  assert.equal(row.overLimit.length, 1);
  assert.equal(row.overLimit[0].reason, 'unknown-duration');
});

test('分镜列表下发音频上限与已用时长（前端据此显示"X / 上限"，不硬编码 15）', async () => {
  DB = fixture({ model: 'seedance2.5' });
  const a = seed(DB, '林晚音色', 'audio', 4);
  sb(DB).assets.push({ assetId: a.id, role: 'audio' });
  const list = await dataOf('GET', '/storyboards?workspaceId=' + WS);
  const row = (list.list || list.items || list).find((r) => r.id === 'st_1') || (list.list || list)[0];
  assert.equal(row.audioLimit, 10, 'seedance2.5 的音频数量上限是 10');
  assert.equal(row.audioSecTotal, 4, '已用时长要下发');
  assert.equal(row.audioSecMax, 15, '上限值由服务端下发');
  assert.deepEqual(row.audioSecUnknown, [], '没有时长未知的音频');
});

/* ============================================================
   ⑤ 时长探测：ffprobe 是可选依赖，失败不得影响上传
   ============================================================ */
test('时长探测：ffprobe 读不出来时返回 null 而不抛错（可选依赖不得让流程挂掉）', async () => {
  const { probeAudioDuration } = require('./dreamina-cli');
  assert.equal(typeof probeAudioDuration, 'function', '必须导出给 services 用');
  const sec = await probeAudioDuration('不存在的文件.mp3');
  assert.equal(sec, null, '文件不存在 → null，不抛错');
});

test('时长探测：真实音频文件能读出接近正确的秒数（本机有 ffprobe 时）', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const { probeAudioDuration } = require('./dreamina-cli');
  /* 造一个 2 秒的静音 wav（用 ffmpeg 生成到临时目录，不碰项目数据目录） */
  const tmp = path.join(os.tmpdir(), 'jc-audio-probe-' + Date.now() + '.wav');
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '2', tmp],
      { stdio: 'ignore', timeout: 20000, windowsHide: true });
  } catch (e) {
    /* 本机没有 ffmpeg：跳过（这个用例本就以"可选依赖"为前提） */
    return;
  }
  try {
    const sec = await probeAudioDuration(tmp);
    assert.ok(sec !== null, '有 ffprobe 时应能读出时长');
    assert.ok(Math.abs(sec - 2) < 0.3, '读出的时长应接近 2 秒，实际 ' + sec);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败无妨 */ }
  }
});

/* ============================================================
   ⑥ 派发时兜底：绑定之后模型被改小 / 有人手工改库，也不能悄悄多发音频
   ------------------------------------------------------------
   为什么要有这一道：绑定守卫挡住了两个写入点，但**模型可能在绑定之后被改小**
   （按 2.5 绑了 5 条音频、之后把分镜模型改成 2.0），也可能有人手工改过库。
   没有这一道，「音频总时长不得超过 15 秒」就不是一条真规则。
   ⚠ 这条用例需要"素材文件真实存在"（asset-lock 只把有本地文件的素材算进参考），
     所以用 paths.setRoots 把数据根指到临时目录 —— 绝不写真实数据目录。
   ============================================================ */
test('派发兜底：音频总时长超限时组装命令必须失败，而不是静默截断', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const PATHS = require('./paths');
  const { makeDreaminaAdapter } = require('./dreamina-cli');

  const tmp = path.join(os.tmpdir(), 'jc-dispatch-audio-' + Date.now());
  const assetDir = path.join(tmp, 'projects', PJ, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  /* setRoots 是"合并并返回当前值"，没有还原函数 —— 先取出原值，用完再写回 */
  const prevRoots = PATHS.setRoots({});
  PATHS.setRoots({ projects: path.join(tmp, 'projects') });
  try {
    /* 三条各 6 秒的音频：合计 18 秒 > 15 秒；文件真实存在所以会进参考表 */
    DB = fixture({ model: 'seedance2.5' });   // 数量上限 10，确保撞的是**时长**而不是数量
    const ids = [1, 2, 3].map((i) => {
      const a = seed(DB, '音色' + i, 'audio', 6);
      fs.writeFileSync(path.join(assetDir, a.id + '.mp3'), 'FAKE');
      a.url = PATHS.assetUrl(PJ, a.id + '.mp3');
      return a.id;
    });
    /* 夹具直接绑上（绕过绑定守卫），模拟"绑定之后模型被改小/手工改库" */
    ids.forEach((id) => sb(DB).assets.push({ assetId: id, role: 'audio' }));

    const adapter2 = makeDreaminaAdapter({ dreaminaCliPath: 'dreamina', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    assert.throws(
      () => adapter2.buildSubmitArgs(sb(DB), DB),
      (e) => /总时长/.test(e.message) && /15/.test(e.message),
      '超时长必须在组装命令时就失败，并说明是总时长问题'
    );

    /* 反证：把模型换回能容纳更多音频的型号、并减掉一条，就应当能正常组装 */
    sb(DB).assets = sb(DB).assets.filter((r) => r.assetId !== ids[2]);
    const built = adapter2.buildSubmitArgs(sb(DB), DB);
    assert.ok(Array.isArray(built.args) && built.args.length, '合规时应当正常组装出命令');
  } finally {
    PATHS.setRoots(prevRoots);   // 必须还原：否则后续用例会写到临时目录
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败无妨 */ }
  }
});

/* ============================================================
   ⑦ 前后端「多值槽位」表必须一致（静态检查）
   ------------------------------------------------------------
   为什么要有这条：多值/单值这件事**前后端各有一份表**
   （后端 server/services.js 的 ROLE_MULTI、前端 app/app.js 的 ROLE_META[x].multi），
   两处各写各的。改一处忘一处**不会报任何错**，只会静默不一致 ——
   2026-09-20 实际踩到：后端把 audio 改成多值了，前端还是单值，
   表现为"后端允许绑多个音色、界面上却连 ＋ 按钮都没有"。
   这种缺陷跑接口测试看不出来（接口是对的），只有看界面才会发现。
   ============================================================ */
test('多值槽位表：前后端的 audio/character/prop 与单值槽位必须一一对应', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const appJs = fs.readFileSync(path.join(ROOT, 'app', 'app.js'), 'utf8');

  /* 后端表：直接从模块读（它就是权威实现） */
  const backend = {};
  const svcSrc = fs.readFileSync(path.join(__dirname, 'services.js'), 'utf8');
  const m = /const ROLE_MULTI = \{([^}]*)\}/.exec(svcSrc);
  assert.ok(m, 'services.js 里应当有 const ROLE_MULTI = {...}');
  m[1].split(',').forEach((pair) => {
    const [k, v] = pair.split(':').map((x) => x.trim());
    if (k) backend[k.replace(/['"]/g, '')] = v === 'true';
  });

  /* 前端表：从 ROLE_META 里逐行取 multi */
  const frontend = {};
  const re = /(\w+):\s*\{[^}]*?multi:\s*(true|false)/g;
  let hit;
  while ((hit = re.exec(appJs)) !== null) frontend[hit[1]] = hit[2] === 'true';

  const roles = ['character', 'scene', 'prop', 'firstFrame', 'storyboard', 'audio'];
  roles.forEach((r) => {
    assert.ok(r in frontend, '前端 ROLE_META 缺 ' + r);
    /* 后端 ROLE_MULTI 只列**多值**的那些，没列出的按单值处理
       （isMultiRole = ROLE_MULTI[role] === true）—— 所以这里也要按"缺省即单值"比。 */
    assert.equal(frontend[r], backend[r] === true,
      '槽位 ' + r + ' 的多值设置在前后端不一致：后端=' + (backend[r] === true) + ' 前端=' + frontend[r] +
      '。两处必须同步，否则会出现"后端允许、界面不给入口"这类静默不一致。');
  });
  /* 音频这次必须是多值 —— 单值会让第二个音色顶掉第一个 */
  assert.equal(backend.audio, true, 'audio 必须是多值（一个分镜多角色各有音色）');
});
