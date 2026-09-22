#!/usr/bin/env node
/**
 * scripts/e2e-flow.js —— 端到端业务流验证（清单 §5 交付要求）
 *
 * 与 smoke-web.js 的分工：
 *   smoke-web  = 「服务能不能起来、接口通不通、关掉干不干净」（连通性）
 *   e2e-flow   = 「一条真实业务链能不能从头跑到尾」（业务流程）
 * 两者都要跑：smoke 通过不代表业务链通过，业务链通过也不代表进程能干净退出。
 *
 * 本脚本走的是**真实服务器 + 真实 HTTP + 真实磁盘**，不 mock 任何一层，
 * 覆盖本次审查修复涉及的主要业务流程：
 *
 *   [1] 启动与数据隔离          —— 附加项-1（JC_DATA_DIR 生效）
 *   [2] 项目 / 工作区           —— P2-13 的载体
 *   [3] 素材：元数据 + 上传     —— 素材库主流程（含惰性建目录）
 *   [4] 分镜：创建 + 参数钳制   —— 任务逻辑（时长按模型能力钳）
 *   [5] 提示词导入资产          —— 双模式导入之一（@ 分段识别，先预览后落库）
 *   [6] 素材绑定 / 解绑         —— 引用与去重
 *   [7] 干跑（dry-run）         —— 提交前校验，不改任务状态
 *   [8] 硬删除预检（只读）      —— P2-13：确认弹窗必须能"看见后果"
 *   [9] 彻底删除 + 归档 + 审计  —— P2-13 全链
 *   [10] 磁盘一致性 + 关停清理  —— P0-3 残留文件 / 进程
 *
 * API 形状以服务端实现为准（已逐条核对，不臆测）：
 *   - GET  /projects                  → { list:[...], total:N }
 *   - POST /assets                    → { type, name, prompt }，type ∈ character|scene|prop|firstFrame|storyboard|audio
 *   - POST /assets/upload?type=&name= → 原始字节（Content-Type 即 mime）
 *   - POST /assets/import-prompts     → { rawText, apply }（字段名是 rawText，不是 text）
 *   - POST /storyboards/:id/assets    → { assetId, role }；返回 { id, bound }（不回整条分镜）
 *   - DELETE /projects/:id?hard=1     → { deleted, backupDir(相对数据根), backupName, counts, disk, ... }
 *   - 项目磁盘目录**惰性创建**：首次写素材时才 ensureProjectDirs，故建项目后目录不一定在
 *
 * ⚠ 数据隔离铁律：强制 JC_DATA_DIR 指到仓库内临时目录。
 *   绝不允许 e2e 落到 server/data（AGENTS.md 红线）。
 *   为什么是仓库内而不是 /tmp：Git Bash 下 /tmp 会被解析成 C:\tmp\... 而 ENOENT。
 *
 * 用法：
 *   node scripts/e2e-flow.js
 *   node scripts/e2e-flow.js --port 8790
 *   node scripts/e2e-flow.js --keep        # 保留临时数据目录，便于排查
 *
 * 退出码：0 = 全通；1 = 有失败
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ── 参数 ────────────────────────────────────────────────────────
function argVal(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const PORT = Number(argVal('port', 8789));
const KEEP = !!argVal('keep', false);

// ── 输出小工具 ──────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

let failed = 0;
let checks = 0;
const pass = (m) => { checks++; console.log(C.g + '  OK    ' + C.x + m); };
const fail = (m) => { checks++; failed++; console.log(C.r + '  FAIL  ' + C.x + m); };
const info = (m) => console.log(C.d + '         ' + m + C.x);
const head = (m) => console.log('\n' + C.b + m + C.x);

// ── HTTP 小工具 ─────────────────────────────────────────────────
function request(method, urlPath, headers, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    const payload = bodyObj === undefined || bodyObj === null
      ? null
      : (Buffer.isBuffer(bodyObj) ? bodyObj : Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    const h = Object.assign({}, headers || {});
    if (payload) {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      h['Content-Length'] = payload.length;
    }
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: urlPath, method, headers: h, timeout: timeoutMs || 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buf, body: buf.toString('utf8') });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), body: '', error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), body: '', error: new Error('超时') }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 发请求并解析统一信封；返回 { env, status, raw }。env 为 null 表示不是合法 JSON。 */
async function api(method, urlPath, bodyObj, headers) {
  const r = await request(method, urlPath, headers, bodyObj);
  let env = null;
  try { env = JSON.parse(r.body); } catch (e) { env = null; }
  return { env, status: r.status, raw: r };
}

/** 断言业务成功（code === 0），返回 data；失败记 FAIL 并返回 null。 */
function okData(res, label) {
  if (!res.env) { fail(label + ' —— 响应不是合法 JSON'); info((res.raw.body || '').slice(0, 200)); return null; }
  if (res.env.code !== 0) { fail(label + ' —— code=' + res.env.code + ' msg=' + res.env.message); return null; }
  return res.env.data;
}

const enc = encodeURIComponent;

/* listAssets 返回 { currentShot, library, counts }，且 **type 默认 'character'** ——
   不传 type 就拿不到 scene/prop。所以"素材总数"必须逐类型累加，
   不能拿一次默认查询的 library.length 当总数（实测踩到：导入 3 条却读到 0）。 */
const ASSET_TYPES = ['character', 'scene', 'prop', 'firstFrame', 'storyboard', 'audio'];
async function assetsOf(projectId, headers) {
  const byType = {};
  let total = 0;
  for (const t of ASSET_TYPES) {
    const d = okData(await api('GET',
      '/api/v1/projects/' + enc(projectId) + '/assets?type=' + enc(t), null, headers), '列出素材(' + t + ')');
    const lib = (d && d.library) || [];
    byType[t] = lib;
    total += lib.length;
  }
  return { byType, total };
}

/** PATH 白名单与 safeId 同形：pj_/ws_/st_/as_ + [A-Za-z0-9_-]，无需编码但保持习惯 */
const safe = (id) => id;

// ── 起服务 / 等待 / 关停 ────────────────────────────────────────
function waitReady(waitMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + (waitMs || 30000);
    (function tick() {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 2000 }, (res) => {
        res.resume(); resolve(true);
      });
      req.on('error', () => { if (Date.now() < deadline) setTimeout(tick, 300); else resolve(false); });
      req.on('timeout', () => { req.destroy(); if (Date.now() < deadline) setTimeout(tick, 300); else resolve(false); });
      req.end();
    })();
  });
}

function portOpen() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 1500 },
      (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// 1×1 PNG（最小合法图片，用于素材上传的字节流）
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// ── 主流程 ──────────────────────────────────────────────────────
(async function main() {
  console.log(C.b + '即梦批量生成控制台 —— 端到端业务流验证（E2E）' + C.x);
  info('端口 ' + PORT + ' · Node ' + process.versions.node);

  const dataDir = path.join(ROOT, '.test-tmp', 'e2e-flow-' + Date.now());
  fs.mkdirSync(dataDir, { recursive: true });
  info('数据目录 ' + dataDir + '（隔离，用完即删）');

  let child = null;
  let stdout = '';
  let stderr = '';

  const cleanup = () => {
    if (child && !child.killed) { try { child.kill('SIGTERM'); } catch (e) { /* 忽略 */ } }
    if (!KEEP) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
    else console.log(C.d + '         （--keep：保留 ' + dataDir + '）' + C.x);
  };

  try {
    // ══ [1] 启动与数据隔离 ════════════════════════════════════
    head('[1] 启动与数据隔离');
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        JC_DATA_DIR: dataDir,
        JC_PORT: String(PORT),
        JC_HOST: '127.0.0.1',
        JC_TOKEN: '',
        // 不连真实 CLI：探测也跳过，否则每次跑都要等好几秒
        JC_DREAMINA_CLI_PATH: process.platform === 'win32' ? 'nonexistent-e2e.exe' : 'nonexistent-e2e'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { stderr += '\n[spawn error] ' + e.message; });

    if (!await waitReady(30000)) {
      fail('服务未能在 30 秒内监听 ' + PORT);
      info('子进程输出：\n' + (stdout || '(空)') + (stderr ? '\n[stderr]\n' + stderr : ''));
      return;
    }
    pass('服务已监听 127.0.0.1:' + PORT);
    if (/数据目录.*e2e-flow/.test(stdout)) pass('JC_DATA_DIR 生效（附加项-1 回归）');
    else fail('启动横幅未显示被重定向的数据目录');
    if (fs.existsSync(path.join(ROOT, 'server', 'data'))) fail('★ server/data 被创建 —— 污染了真实数据目录');
    else pass('未污染 server/data');

    const dbFile = path.join(dataDir, 'db.json');
    const projRoot = path.join(dataDir, 'projects');

    // ══ [2] 项目 / 工作区 ═════════════════════════════════════
    head('[2] 项目 / 工作区');
    const proj = okData(await api('POST', '/api/v1/projects', { name: 'E2E 项目', description: '端到端验证' }), '创建项目');
    const projectId = proj && proj.project && proj.project.id;
    if (!projectId) { fail('创建项目未返回 id，后续流程无法继续'); return; }
    pass('创建项目 → ' + projectId);

    const wsRes = await api('POST', '/api/v1/projects/' + safe(projectId) + '/workspaces', { name: '主工作区' });
    const wsData = okData(wsRes, '创建工作区');
    const ws = wsData && (wsData.workspace || wsData);
    const workspaceId = ws && ws.id;
    if (!workspaceId) { fail('创建工作区未返回 id，后续流程无法继续'); return; }
    pass('创建工作区 → ' + workspaceId);

    /* listProjects 返回 { list, total }（不是裸数组）——按实现断言 */
    const lpData = okData(await api('GET', '/api/v1/projects'), '列出项目');
    const lpList = (lpData && lpData.list) || [];
    if (lpData && typeof lpData.total === 'number') pass('列表返回 { list, total=' + lpData.total + ' }');
    else fail('列表形状不符（期望 { list, total }）：' + JSON.stringify(lpData).slice(0, 120));
    if (lpList.some((p) => p.id === projectId)) pass('列表可查到刚建的项目');
    else fail('列表里查不到刚建的项目');

    const projDir = path.join(projRoot, projectId);

    // ══ [3] 素材：元数据 + 上传 ═══════════════════════════════
    head('[3] 素材：元数据 + 上传');
    const H = {};

    // 3a. 只建元数据（type 必须是 6 类之一，scene 是图片类）
    const metaAsset = okData(await api('POST', '/api/v1/assets',
      { type: 'scene', name: 'E2E 场景图', prompt: '一间靠窗的卧室' }, H), '新建素材元数据（scene）');
    const asAsset = (d) => d && (d.asset || d);
    const metaAssetId = asAsset(metaAsset) && asAsset(metaAsset).id;
    if (metaAssetId) pass('新建素材元数据 → ' + metaAssetId);
    else fail('新建素材元数据未返回 id');

    // 非法类型应被拒（40001）
    const badType = await api('POST', '/api/v1/assets', { type: 'image', name: 'x' }, H);
    if (badType.env && badType.env.code === 40001) pass('非法素材类型返回 40001（类型白名单生效）');
    else fail('非法素材类型未返回 40001，实际 ' + JSON.stringify(badType.env && badType.env.code));

    /* 3b. 原始字节上传（query: type + name；Content-Type 即 mime）
       ⚠ name 必须带**合法扩展名**：服务端按扩展名做类型白名单校验
         （图片 .png/.jpg/.jpeg/.webp/.gif/.bmp）。`name=上传的角色图` 无扩展名会被 40001 拒掉。 */
    const upUrl = '/api/v1/assets/upload?type=character&name=' + enc('上传的角色图.png');
    const upRes = await request('POST', upUrl, Object.assign({ 'Content-Type': 'image/png' }, H), PNG_1x1);
    let upEnv = null;
    try { upEnv = JSON.parse(upRes.body); } catch (e) { upEnv = null; }
    let upAssetId = null;
    if (!upEnv || upEnv.code !== 0) {
      fail('上传素材失败：' + (upEnv ? 'code=' + upEnv.code + ' msg=' + upEnv.message : '非 JSON'));
      info(upRes.body.slice(0, 200));
    } else {
      upAssetId = asAsset(upEnv.data) && asAsset(upEnv.data).id;
      pass('上传素材（PNG 字节流）→ ' + upAssetId);

      /* 项目磁盘目录是**惰性创建**的（首次写素材才 ensureProjectDirs）——
         所以这里才是检查目录落盘的时机，而不是建项目之后。 */
      if (fs.existsSync(projDir)) pass('项目目录已惰性创建 projects/<id>/');
      else fail('项目目录未创建：' + projDir);

      const assetDir = path.join(projDir, 'assets');
      if (fs.existsSync(assetDir) && fs.readdirSync(assetDir).length > 0) {
        pass('素材文件已落盘 projects/<id>/assets/（' + fs.readdirSync(assetDir).length + ' 个）');
      } else {
        fail('素材文件未落盘：' + assetDir);
      }
    }

    const assetsNow = await assetsOf(projectId, H);
    const assetCount = assetsNow.total;
    if (assetCount >= 2) pass('素材库共 ' + assetCount + ' 条（scene 元数据 + character 上传）');
    else fail('素材库条数异常：' + assetCount);

    // ══ [4] 分镜：创建 + 参数钳制 ════════════════════════════
    head('[4] 分镜：创建 + 参数钳制');
    const sbRes = await api('POST', '/api/v1/workspaces/' + safe(workspaceId) + '/storyboards',
      { prompt: 'E2E 分镜：一个女孩站在窗边', durationSec: 5 }, H);
    const sbData = okData(sbRes, '创建分镜');
    const sb = sbData && (sbData.storyboard || sbData);
    const sbId = sb && sb.id;
    if (!sbId) { fail('创建分镜未返回 id，后续流程无法继续'); return; }
    pass('创建分镜 → ' + sbId + '（status=' + (sb.status || '?') + ', 时长=' + (sb.durationSec != null ? sb.durationSec : '?') + 's）');

    if (sb.canEditDuration === true) pass('新建分镜 canEditDuration=true（草稿可改）');
    else fail('新建分镜 canEditDuration 应为 true，实际 ' + sb.canEditDuration);

    // 时长钳制：给一个远超上限的值，应被夹到区间内
    const patched = okData(await api('PATCH', '/api/v1/storyboards/' + safe(sbId), { durationSec: 999 }, H), '超限时长应被钳制而非报错');
    const patchedSb = patched && (patched.storyboard || patched);
    if (patchedSb && typeof patchedSb.durationSec === 'number' && patchedSb.durationSec < 999) {
      pass('时长 999s 被钳制为 ' + patchedSb.durationSec + 's（按模型能力）');
    } else {
      fail('时长钳制失效：' + JSON.stringify(patchedSb && patchedSb.durationSec));
    }

    // 非法时长应被拒（PARAM 40001）
    const badDur = await api('PATCH', '/api/v1/storyboards/' + safe(sbId), { durationSec: 'abc' }, H);
    if (badDur.env && badDur.env.code === 40001) pass('非法时长返回 40001（参数校验生效）');
    else fail('非法时长未返回 40001，实际 ' + JSON.stringify(badDur.env && badDur.env.code));

    // 不存在的分镜 → 40400
    const nf = await api('GET', '/api/v1/storyboards/st_not_exist_0000', null, H);
    if (nf.env && nf.env.code === 40400) pass('不存在的分镜返回 40400');
    else fail('不存在的分镜未返回 40400，实际 ' + JSON.stringify(nf.env && nf.env.code));

    // 路径穿越：分镜 id 里塞 ../ → 必须被白名单挡下（P0-1 同类防护）
    const traverse = await api('GET', '/api/v1/storyboards/' + encodeURIComponent('../../db.json'), null, H);
    if (traverse.env && traverse.env.code !== 0) pass('分镜 id 路径穿越被拒（code=' + traverse.env.code + '）');
    else fail('分镜 id 路径穿越未被拒');

    // ══ [5] 提示词导入资产 ═══════════════════════════════════
    head('[5] 提示词导入资产（@ 分段识别）');
    /* 字段名是 rawText（不是 text）—— 按实现断言。
       预览（apply=false）必须先于落库，且**只读**：预览前后素材数应一致。 */
    const beforeCount = assetCount;
    const promptText = [
      '场景描述内容：一间靠窗的卧室，晨光斜射',
      '道具描述内容：一只白瓷咖啡杯',
      '角色描述信息：林晚，黑色长发，白色衬衫'
    ].join('\n@\n');

    const previewData = okData(await api('POST', '/api/v1/assets/import-prompts',
      { rawText: promptText, apply: false }, H), '提示词导入预览');
    if (previewData) {
      const items = previewData.items || [];
      pass('导入预览成功（items=' + items.length + ', applied=' + previewData.applied + '）');
      if (previewData.applied === false) pass('预览 applied=false（未落库）');
      else fail('预览却 applied=true');
    }

    const afterPreview = await assetsOf(projectId, H);
    if (afterPreview.total === beforeCount) pass('预览只读：素材数未变（' + beforeCount + '）');
    else fail('预览竟修改了素材库：' + beforeCount + ' → ' + afterPreview.total);

    const applyData = okData(await api('POST', '/api/v1/assets/import-prompts',
      { rawText: promptText, apply: true }, H), '提示词导入落库');
    if (applyData) {
      const created = (applyData.created || []).length;
      pass('落库生效：新建 ' + created + ' 条（applied=' + applyData.applied + '）');
      const afterApply = await assetsOf(projectId, H);
      if (afterApply.total > beforeCount) pass('素材总数 ' + beforeCount + ' → ' + afterApply.total);
      else fail('落库未增加素材：' + beforeCount + ' → ' + afterApply.total);

      // 幂等：同文本再导入一次 → 全部落入 duplicates，不新增
      const dupData = okData(await api('POST', '/api/v1/assets/import-prompts',
        { rawText: promptText, apply: true }, H), '重复导入应去重');
      if (dupData && (dupData.duplicates || []).length > 0 && (dupData.created || []).length === 0) {
        pass('重复导入被去重（duplicates=' + dupData.duplicates.length + ', created=0）');
      } else {
        fail('重复导入未去重：created=' + JSON.stringify((dupData && dupData.created || []).length));
      }
    }

    // ══ [6] 素材绑定 / 解绑 ══════════════════════════════════
    head('[6] 素材绑定 / 解绑');
    if (upAssetId) {
      /* bindAsset 的入参是 { assetId, role }，返回 { id, bound } ——
         不回整条分镜，故绑定结果要通过 GET 复核。 */
      const bindData = okData(await api('POST', '/api/v1/storyboards/' + safe(sbId) + '/assets',
        { assetId: upAssetId, role: 'character' }, H), '绑定素材到分镜');
      if (bindData && bindData.bound === upAssetId) pass('绑定返回 { id, bound=' + bindData.bound + ' }');
      else fail('绑定返回值不符：' + JSON.stringify(bindData));

      const sb1Data = okData(await api('GET', '/api/v1/storyboards/' + safe(sbId), null, H), '读分镜复核绑定');
      const sb1 = sb1Data && (sb1Data.storyboard || sb1Data);
      const boundList = (sb1 && sb1.assets) || [];
      if (boundList.some((a) => a.assetId === upAssetId && a.role === 'character')) pass('分镜 assets 里已含该素材（role=character）');
      else fail('绑定后分镜 assets 里找不到该素材：' + JSON.stringify(boundList));

      // role 非法应被拒
      const badRole = await api('POST', '/api/v1/storyboards/' + safe(sbId) + '/assets',
        { assetId: upAssetId, role: 'nope' }, H);
      if (badRole.env && badRole.env.code === 40001) pass('非法 role 返回 40001');
      else fail('非法 role 未返回 40001，实际 ' + JSON.stringify(badRole.env && badRole.env.code));

      const usage = okData(await api('GET', '/api/v1/assets/' + safe(upAssetId) + '/usage', null, H), '查询素材引用');
      if (usage) pass('素材引用查询成功（' + JSON.stringify(usage).slice(0, 100) + '）');

      const unData = okData(await api('DELETE', '/api/v1/storyboards/' + safe(sbId) + '/assets/' + safe(upAssetId), null, H), '解绑素材');
      if (unData && unData.removed === upAssetId) pass('解绑返回 removed=' + unData.removed);
      else fail('解绑返回值不符：' + JSON.stringify(unData));

      const sb2Data = okData(await api('GET', '/api/v1/storyboards/' + safe(sbId), null, H), '读分镜复核解绑');
      const sb2 = sb2Data && (sb2Data.storyboard || sb2Data);
      if (!((sb2 && sb2.assets) || []).some((a) => a.assetId === upAssetId)) pass('解绑后分镜 assets 已移除该素材');
      else fail('解绑后仍能查到该素材');
    } else {
      fail('跳过绑定环节（上传素材未取得 id）');
    }

    // ══ [7] 干跑（dry-run）═══════════════════════════════════
    head('[7] 干跑校验');
    const dryData = okData(await api('POST', '/api/v1/storyboards/' + safe(sbId) + '/dry-run', {}, H), '干跑校验');
    if (dryData) {
      pass('干跑成功（' + JSON.stringify(dryData).slice(0, 140) + '）');
      const sbAfterDryData = okData(await api('GET', '/api/v1/storyboards/' + safe(sbId), null, H), '干跑后读分镜');
      const s2 = sbAfterDryData && (sbAfterDryData.storyboard || sbAfterDryData);
      if (s2 && s2.status === 'draft') pass('干跑未改变任务状态（仍为 draft）');
      else fail('干跑改变了任务状态：' + (s2 && s2.status));
    }

    // ══ [8] 硬删除预检（只读）════════════════════════════════
    head('[8] 硬删除预检（只读）');
    const beforeDbBytes = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
    const previewInfo = okData(await api('GET', '/api/v1/projects/' + safe(projectId) + '/hard-delete-preview', null, H), '硬删除预检');
    if (previewInfo) {
      pass('预检返回统计 counts=' + JSON.stringify(previewInfo.counts));
      if (previewInfo.disk && typeof previewInfo.disk.files === 'number') pass('预检含磁盘统计 disk=' + JSON.stringify(previewInfo.disk));
      else fail('预检缺磁盘统计');
    }
    const afterDbBytes = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
    if (beforeDbBytes && afterDbBytes && beforeDbBytes.equals(afterDbBytes)) {
      pass('预检是只读的（db.json 逐字节未变）');
    } else {
      fail('预检修改了 db.json —— 违反"只统计不修改"契约');
    }

    // ══ [9] 彻底删除 + 归档 + 审计 ═══════════════════════════
    head('[9] 彻底删除 + 归档 + 审计');
    // 9a. 软删除：只打 deletedAt，**不动磁盘、不删子数据**
    const softData = okData(await api('DELETE', '/api/v1/projects/' + safe(projectId), null, H), '软删除');
    if (softData) {
      if (softData.softDeleted === true) pass('软删除返回 softDeleted=true');
      else fail('软删除返回值不符：' + JSON.stringify(softData));
      if (fs.existsSync(projDir)) pass('软删除不动磁盘（项目目录仍在）');
      else fail('软删除竟然删掉了磁盘目录');
    }

    // 9b. 硬删除（?hard=1）。⚠ 项目此刻已软删除 —— 但硬删除**允许**对已软删项目执行
    const hardData = okData(await api('DELETE', '/api/v1/projects/' + safe(projectId) + '?hard=1', null, H), '彻底删除');
    if (hardData) {
      pass('彻底删除成功（removedFiles=' + hardData.removedFiles + '）');

      // backupDir 必须是**相对数据根**的可定位路径（P2-13 补强点）
      const backupDir = hardData.backupDir;
      const backupName = hardData.backupName;
      if (backupDir && !path.isAbsolute(backupDir) && !backupDir.includes('\\')) {
        pass('backupDir 是相对路径且已归一化为 POSIX 分隔符：' + backupDir);
      } else {
        fail('backupDir 应为相对数据根路径，实际 ' + JSON.stringify(backupDir));
      }
      if (backupName && typeof backupName === 'string') pass('backupName 已返回：' + backupName);
      else fail('backupName 缺失');

      // 归档目录必须真实存在，且能由 backupDir 定位到
      const absBackup = backupDir ? path.join(dataDir, ...backupDir.split('/')) : null;
      if (absBackup && fs.existsSync(absBackup)) pass('归档目录可定位且存在：' + backupDir);
      else fail('按 backupDir 定位不到归档目录：' + absBackup);

      // 归档内容必须含原项目文件（证明是"整份复制"而非建空目录）
      if (absBackup && fs.existsSync(path.join(absBackup, 'assets'))) pass('归档内含 assets/（整份复制生效）');
      else fail('归档内不含 assets/ —— 可能是空壳归档');

      // 项目目录应被移除
      if (!fs.existsSync(projDir)) pass('项目磁盘目录已彻底移除');
      else fail('彻底删除后项目目录仍在：' + projDir);

      // 归档目录**不应**在项目目录内（否则会一起被删）——这是设计的核心约束
      if (absBackup && path.relative(projDir, absBackup).split(path.sep)[0] === '..') pass('归档目录位于项目目录之外（不会被连带删除）');
      else fail('归档目录竟在项目目录内 —— 会被连带删除');

      // 残留标记应为 false
      if (hardData.residualDir === false) pass('residualDir=false（删后复核确认无残留）');
      else fail('residualDir 应为 false，实际 ' + hardData.residualDir);
    }

    // 9c. 删除不存在的项目 → 40400
    const delMissing = await api('DELETE', '/api/v1/projects/' + safe(projectId) + '?hard=1', null, H);
    if (delMissing.env && delMissing.env.code === 40400) pass('重复删除返回 40400');
    else fail('重复删除未返回 40400，实际 ' + JSON.stringify(delMissing.env && delMissing.env.code));

    // 9d. 审计留痕（写进 db.logs 的项目级 key，含归档路径）
    /* ⚠ 轮询等待，而不是"读一次就断言"：store 的常规写盘是 **200ms 防抖合并写**，
       而整条 e2e 只跑几十毫秒 —— 立刻读会稳定读到"还没落盘"的旧内容
       （2026-09-22 实测踩到：断言失败 + Windows 上 SIGTERM 是强制终止，
        进程被杀时连退出前的 flush 都等不到）。
       硬删除那条审计已经改成 flush 立即落盘；这里再叠一层轮询，
       是为了不把断言绑死在"某次改动恰好是同步写"上。 */
    const readDbText = () => (fs.existsSync(dbFile) ? fs.readFileSync(dbFile, 'utf8') : '');
    let dbText = readDbText();
    for (let i = 0; i < 30 && !/项目被彻底删除/.test(dbText); i++) {
      await new Promise((r) => setTimeout(r, 100));
      dbText = readDbText();
    }
    if (/项目被彻底删除/.test(dbText)) pass('审计日志已落库（含"项目被彻底删除"）');
    else fail('db.json 里找不到审计留痕');
    if (/已归档到/.test(dbText)) pass('审计日志含归档路径（可追溯）');
    else fail('审计日志缺归档路径');

    // 9e. 项目确实从库里消失了
    const lpAfter = okData(await api('GET', '/api/v1/projects'), '删除后重列项目');
    const lpAfterList = (lpAfter && lpAfter.list) || [];
    if (!lpAfterList.some((p) => p.id === projectId)) pass('项目已从项目列表中消失');
    else fail('项目仍在列表中');

    // ══ [10] 磁盘一致性 + 关停清理 ═══════════════════════════
    head('[10] 磁盘一致性 + 关停清理');
    const strays = [];
    (function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        let st;
        try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) walk(p);
        else if (/\.tmp$|\.part-/.test(name)) strays.push(path.relative(dataDir, p));
      }
    })(dataDir);
    if (strays.length === 0) pass('数据目录无 .tmp / .part- 残留（原子写干净）');
    else fail('发现临时残留：' + strays.join(', '));

    // 备份目录仍在（归档不该被清理逻辑误删）
    const backupRoot = path.join(dataDir, 'backup', 'hard-delete');
    if (fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).length > 0) pass('归档目录留存于 backup/hard-delete/');
    else fail('归档目录消失：' + backupRoot);

    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    if (!await portOpen()) pass('服务已优雅退出，端口 ' + PORT + ' 已释放');
    else { fail('SIGTERM 后端口仍被占用'); try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ } }
  } catch (e) {
    fail('未捕获异常：' + (e && e.stack || e));
    if (stdout) info('服务输出片段：\n' + stdout.slice(-1500));
  } finally {
    cleanup();
  }

  // ── 汇总 ──────────────────────────────────────────────────────
  console.log('');
  if (failed === 0) {
    console.log(C.g + C.b + '结果：通过' + C.x + C.d + '（' + checks + ' 项断言全部符合预期）' + C.x);
  } else {
    console.log(C.r + C.b + '结果：失败' + C.x + '（' + failed + ' / ' + checks + ' 项不符合预期）');
  }
  process.exitCode = failed === 0 ? 0 : 1;
})();
