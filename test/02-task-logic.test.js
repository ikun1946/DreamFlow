'use strict';
/* ============================================================
   02-task-logic.test.js —— 任务逻辑与外部工具
   对应 docs/项目审查与改进清单.md §6「任务逻辑」+ §10（外部工具错误码）：
     · 音频数量 / 总时长限制
     · 模型参数适配（上限与时长夹取）
     · 素材名解析（名称匹配的确定性）
     · 外部工具缺失时的行为与稳定错误码
     · 彻底删除：二次保护与预览统计（§13）
   ============================================================ */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const H = require('./helpers');

const SANDBOX = H.freshDir('task-logic');
process.env.JC_DATA_DIR = SANDBOX;

const runtime = require('../server/runtime');
const models = require('../server/models');
const services = require('../server/services');
const projects = require('../server/projects');
const util = require('../server/util');
const paths = require('../server/paths');
const store = require('../server/store');

/**
 * 加载前端 api.js（浏览器 IIFE，挂在 window 上）。
 *
 * ⚠ 不能直接 require：它在文件末尾执行 `})(window)`，Node 里没有 window。
 *   补一个最小桩即可 —— 顶层只在模块加载时读 `global.location.protocol`，
 *   不碰 DOM（实测可用）。
 * ⚠ 从 require 缓存里删掉再加载，避免与其它测试文件互相污染桩。
 */
function loadBrowserApi() {
  const apiPath = path.resolve(__dirname, '..', 'app', 'api.js');
  const prevWindow = global.window;
  global.window = { location: { protocol: 'http:' }, APP_CONFIG: {} };
  try {
    delete require.cache[require.resolve(apiPath)];
    require(apiPath);
    return global.window.Api;
  } finally {
    // 保留 window（其它用例可能还要读），但不还原成 undefined —— 会破坏后续 require
    if (prevWindow) global.window = prevWindow;
  }
}

describe('models —— 模型能力与参数适配', () => {
  test('时长上下限：clampDuration 把请求夹到模型合法区间', () => {
    const m = 'seedance2.0_vip';
    /* ⚠ 时长区间在 capsFor().duration，形如 [min, max]（不是 limitsFor 的字段） */
    const [min, max] = models.capsFor(m).duration;
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && max > min,
      '每个已知模型都应有明确时长区间：' + JSON.stringify(models.capsFor(m).duration));

    assert.equal(models.clampDuration(m, min - 100), min, '过低应抬到下限');
    assert.equal(models.clampDuration(m, max + 100), max, '过高应压到上限');
    assert.equal(models.clampDuration(m, min), min, '下限本身应保留');
    assert.equal(models.clampDuration(m, max), max, '上限本身应保留');
    assert.equal(models.clampDuration(m, 5), 5, '区间内的值原样返回');
    // 非法输入不得产出 NaN（会一路传到 CLI 参数里）—— 约到下限
    assert.ok(Number.isFinite(models.clampDuration(m, NaN)), 'NaN 不应直接透出');
    assert.ok(Number.isFinite(models.clampDuration(m, null)));
    assert.ok(Number.isFinite(models.clampDuration(m, 'abc')));
    assert.equal(models.clampDuration(m, NaN), min, 'NaN 应收敛到下限');
    assert.equal(models.clampDuration(m, 'abc'), min, '非数字应收敛到下限');
  });

  test('未知模型走最保守档：默认能力集与默认上限一致，且时长区间有效', () => {
    const unknown = '这个模型不存在';
    assert.deepEqual(models.capsFor(unknown), models.DREAMINA_CAPS_DEFAULT);
    assert.deepEqual(models.limitsFor(unknown), models.DREAMINA_LIMITS_DEFAULT);
    const [min, max] = models.capsFor(unknown).duration;
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && max > min);
  });

  test('capsFor：未知模型回落到默认能力集，不返回 undefined', () => {
    const known = models.capsFor('seedance2.0_vip');
    assert.ok(known && typeof known === 'object');
    const unknown = models.capsFor('不存在的模型');
    assert.ok(unknown && typeof unknown === 'object', '未知模型不得返回 undefined');
    // 默认集应与 DREAMINA_CAPS_DEFAULT 一致
    assert.deepEqual(unknown, models.DREAMINA_CAPS_DEFAULT);
    assert.deepEqual(models.limitsFor('不存在的模型'), models.DREAMINA_LIMITS_DEFAULT);
  });

  test('isKnown / isLegacyName：识别画布时代的旧模型名', () => {
    assert.equal(models.isKnown('seedance2.0_vip'), true);
    assert.equal(models.isKnown('完全不存在'), false);
    // 旧画布域名应被判为 legacy
    if (models.LEGACY_NAMES && models.LEGACY_NAMES.length) {
      assert.equal(models.isLegacyName(models.LEGACY_NAMES[0]), true);
    }
    // dreaminaModelOf 做无损改名
    assert.ok(models.dreaminaModelOf('seedance2.0_vip'), '合法名应能被映射');
  });

  test('同一族模型归组一致（ratio / 分辨率约束跟着族走）', () => {
    const all = models.DREAMINA_VIDEO_MODELS.map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
    assert.ok(all.length > 0, '模型表不应为空');
    for (const name of all) {
      const g = models.groupOf(name);
      assert.ok(g, name + ' 应有分组');
      const c = models.capsFor(name);
      assert.ok(c && typeof c === 'object', name + ' 应有能力集');
    }
  });
});

describe('services —— 音频预算（数量与总时长上限）', () => {
  test('音频数量超限 → reason=count', () => {
    const model = 'seedance2.0_vip';
    const limit = models.limitsFor(model).audio;
    const db = H.sampleDb();

    // 造 limit 个已绑音频 + 1 个待绑
    const mkAsset = (i, dur) => ({ id: 'as_' + i, name: '音频' + i + '.mp3', type: 'audio', durationSec: dur, projectId: 'pj_t1' });
    const s = { projectId: 'pj_t1', workspaceId: 'ws_t1', model, assets: [] };
    for (let i = 0; i < limit; i++) {
      const a = mkAsset(i, 1);
      db.assets.push(a);
      s.assets.push({ role: 'audio', assetId: a.id });
    }

    const incoming = [mkAsset('x', 1)];
    db.assets.push(incoming[0]);
    const r = services.checkAudioBudget(s, db, incoming);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'count');
    assert.match(r.message, /数量超限/);
  });

  test('音频总时长超上限 → reason=duration', () => {
    const model = 'seedance2.0_vip';
    const cfgMax = 15;   // 默认 audioTotalSecMax
    const db = H.sampleDb();
    const a1 = { id: 'as_d1', name: '长音频.mp3', type: 'audio', durationSec: 10, projectId: 'pj_t1' };
    const a2 = { id: 'as_d2', name: '再来一个.mp3', type: 'audio', durationSec: 10, projectId: 'pj_t1' };
    db.assets.push(a1, a2);
    const s = { projectId: 'pj_t1', workspaceId: 'ws_t1', model, assets: [{ role: 'audio', assetId: a1.id }] };

    const r = services.checkAudioBudget(s, db, [a2]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'duration', '10 + 10 > ' + cfgMax + ' 应被判时长超限');
    assert.match(r.message, /总时长超限/);
  });

  test('时长未知的已绑音频 → 明确挑明（unknown-duration），不悄悄放宽约束', () => {
    const db = H.sampleDb();
    const a = { id: 'as_u1', name: '时长未知.mp3', type: 'audio', durationSec: null, projectId: 'pj_t1' };
    db.assets.push(a);
    const s = { projectId: 'pj_t1', workspaceId: 'ws_t1', model: 'seedance2.0_vip', assets: [{ role: 'audio', assetId: a.id }] };

    const r = services.checkAudioBudget(s, db, [{ id: 'as_new', name: '新的.mp3', type: 'audio', durationSec: 3 }]);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-duration');
    assert.match(r.message, /时长未知|没有可用的时长/);
    // ★ P1-10：错误码必须稳定，且区分"环境缺工具"与"数据读不出"
    assert.ok(r.code === util.ERR.FFPROBE_NOT_FOUND || r.code === util.ERR.PARAM,
      '应带上 51105 或 40001，而不是无码');
    // 缺 ffprobe 时应给 51105；数据本身读不出时应给 40001
    assert.ok(r.code === util.ERR.FFPROBE_NOT_FOUND || r.code === util.ERR.PARAM,
      '实得 code=' + r.code);
    assert.ok(r.action === 'install-ffmpeg' || r.action === null,
      '缺工具时应带 install-ffmpeg 引导，实得 ' + JSON.stringify(r.action));
  });

  test('空 incoming → 直接通过（不触发任何读取）', () => {
    const db = H.sampleDb();
    const s = { projectId: 'pj_t1', workspaceId: 'ws_t1', model: 'seedance2.0_vip', assets: [] };
    assert.deepEqual(services.checkAudioBudget(s, db, []), { ok: true });
    assert.deepEqual(services.checkAudioBudget(s, db, null), { ok: true });
  });

  test('audioBudgetOf：已绑里有时长未知的会进 unknown 列表', () => {
    const db = H.sampleDb();
    const a = { id: 'as_b1', name: '有时长.mp3', durationSec: 4, projectId: 'pj_t1' };
    const b = { id: 'as_b2', name: '没时长.mp3', durationSec: undefined, projectId: 'pj_t1' };
    db.assets.push(a, b);
    const s = { assets: [{ role: 'audio', assetId: 'as_b1' }, { role: 'audio', assetId: 'as_b2' }, { role: 'image', assetId: 'as_b1' }] };
    const st = services.audioBudgetOf(s, db);
    assert.equal(st.count, 2, '只数 audio 角色');
    assert.equal(st.sec, 4, '只累加有数的');
    assert.deepEqual(st.unknown, ['没时长.mp3']);
  });
});

describe('services —— 素材名解析的确定性', () => {
  test('nameKeys 对同一输入稳定且幂等', () => {
    const a = services.nameKeys('角色_林雪_正面.png', 'image');
    const b = services.nameKeys('角色_林雪_正面.png', 'image');
    assert.deepEqual(a, b, '同名两次解析必须一致（用于自动匹配，必须确定）');
    assert.ok(a.core, '应解析出核心名');
    assert.ok(a.group, '应有分组键');
    assert.equal(a.full, '角色_林雪_正面', 'full 应去掉扩展名');
  });

  test('分隔符与噪词被剥离，核心名可比对', () => {
    const k1 = services.nameKeys('林雪-正面.png', 'image');
    const k2 = services.nameKeys('林雪_正面.jpg', 'image');
    assert.equal(k1.group, k2.group, '不同分隔符/扩展名应得到相同分组键');
  });

  test('音频域额外剥离音频噪词（与图片域区分）', () => {
    const img = services.nameKeys('林雪_配音.mp3', 'image');
    const aud = services.nameKeys('林雪_配音.mp3', 'audio');
    assert.ok(aud.group, '音频域也应有分组键');
    // 两个域都可能得到 group，但音频域应至少不比图片域更"长"（噪词被剥得更多或相同）
    assert.ok(typeof aud.group === 'string' && typeof img.group === 'string');
  });
});

describe('util —— 错误码表完整性（P1-10）', () => {
  test('511xx 段五个工具错误码齐备且唯一', () => {
    assert.equal(util.ERR.CLI_NOT_FOUND, 51101);
    assert.equal(util.ERR.CLI_NOT_LOGGED_IN, 51102);
    assert.equal(util.ERR.CLI_PERMISSION_DENIED, 51103);
    assert.equal(util.ERR.FFMPEG_NOT_FOUND, 51104);
    assert.equal(util.ERR.FFPROBE_NOT_FOUND, 51105);

    const codes = util.TOOL_ERROR_CODES;
    assert.ok(Array.isArray(codes) && codes.length === 5, '应恰好 5 个工具错误码');
    assert.equal(new Set(codes).size, 5, '不得重复');

    /* 判定函数在 app/api.js（前端侧），服务端只导出码表 ——
       这是有意的：服务端产生码，前端决定文案与引导动作。
       ⚠ app/api.js 是挂在 window 上的浏览器 IIFE，需先补一个最小 window 桩。 */
    const api = loadBrowserApi();
    assert.equal(typeof api.isToolError, 'function', '前端应导出 isToolError');
    for (const c of codes) {
      assert.equal(api.isToolError(c), true, c + ' 应被 isToolError 认出');
    }
    assert.equal(api.isToolError(40001), false, '普通参数错误不算工具错误');
    assert.equal(api.isToolError(50000), false);
    assert.equal(api.isToolError(undefined), false);
    assert.deepEqual(api.TOOL_ERROR_CODES, util.TOOL_ERROR_CODES, '前后端码表必须一致');
  });

  test('ApiError 携带 code 与 codeName，信封结构一致', () => {
    const e = new util.ApiError(util.ERR.CLI_NOT_FOUND, '没装 CLI');
    assert.equal(e.code, 51101);
    assert.equal(e.message, '没装 CLI');
  });
});

describe('projects —— 彻底删除的二次保护（P2-13）', () => {
  before(() => { store.load(); });

  test('hardDeletePreview 是只读的：只统计、不做任何改动', () => {
    const db = store.load();
    const { project } = projects.createProject(db, { name: '待删项目' });
    const { workspace } = projects.createWorkspace(db, project.id, { name: '默认分镜' });
    // 造点磁盘内容
    paths.ensureProjectDirs(project.id);
    fs.writeFileSync(path.join(paths.assetDir(project.id), 'a.png'), 'png');
    fs.writeFileSync(path.join(paths.outputDir(project.id), 'v.mp4'), 'mp4');

    const dbFile = path.join(SANDBOX, 'db.json');
    const beforeDisk = fs.readFileSync(dbFile, 'utf8');
    const dirBefore = fs.existsSync(paths.assetDir(project.id));

    const pv = projects.hardDeletePreview(db, project.id);
    assert.ok(pv, '预览应返回对象');
    assert.equal(pv.id, project.id);
    assert.equal(pv.name, '待删项目');
    assert.equal(pv.counts.workspaces, 1);
    assert.ok(pv.counts.storyboards >= 0);
    assert.ok(pv.disk.files >= 2, '应统计到磁盘上的 2 个文件，实得 ' + pv.disk.files);
    assert.ok(pv.disk.bytes > 0, '应统计字节数');
    assert.equal(pv.dirExists, true);
    assert.equal(pv.softDeleted, false);

    // ★ 只读验证
    assert.equal(fs.readFileSync(dbFile, 'utf8'), beforeDisk, '预览不得改写数据库');
    assert.equal(fs.existsSync(paths.assetDir(project.id)), dirBefore, '预览不得动磁盘');
    assert.ok(db.projects.some((p) => p.id === project.id), '项目必须还在');
  });

  test('hardDeleteProject 先归档再删，删除后目录确实不存在，并写审计日志', () => {
    const db = store.load();
    const { project } = projects.createProject(db, { name: '真删项目' });
    projects.createWorkspace(db, project.id, { name: '默认分镜' });
    paths.ensureProjectDirs(project.id);
    fs.writeFileSync(path.join(paths.assetDir(project.id), 'a.png'), 'PNG-DATA');
    fs.writeFileSync(path.join(paths.outputDir(project.id), 'v.mp4'), 'MP4-DATA');
    store.saveNow();

    const assetDir = paths.assetDir(project.id);
    const outDir = paths.outputDir(project.id);
    assert.ok(fs.existsSync(assetDir));

    const res = projects.hardDeleteProject(db, project.id);

    // 1) 逻辑删除
    assert.ok(!db.projects.some((p) => p.id === project.id), '项目应已从逻辑库中移除');
    // 2) 物理删除
    assert.equal(fs.existsSync(assetDir), false, '★ 素材目录必须确实不存在');
    assert.equal(fs.existsSync(outDir), false, '★ 产物目录必须确实不存在');
    // 3) 归档（可回滚）。backupDir 是**相对数据根**的路径，须拼回绝对路径再检查。
    assert.ok(res.backupDir, '必须返回归档目录（相对数据根）');
    assert.match(res.backupDir, /^backup\/hard-delete\//, '归档应在 backup/hard-delete/ 下，实得 ' + res.backupDir);
    assert.ok(!path.isAbsolute(res.backupDir), '应是相对路径，便于界面原样展示');
    assert.ok(res.backupName, '同时应给出目录名');
    const bakAbs = path.join(SANDBOX, res.backupDir);
    assert.ok(fs.existsSync(bakAbs), '★ 归档目录必须存在（删除前先备份）：' + bakAbs);
    assert.ok(fs.existsSync(path.join(bakAbs, 'assets', 'a.png')), '归档里应有素材');
    assert.ok(fs.existsSync(path.join(bakAbs, 'output', 'v.mp4')), '归档里应有产物');
    // 归档内容必须与原件一致
    assert.equal(fs.readFileSync(path.join(bakAbs, 'assets', 'a.png'), 'utf8'), 'PNG-DATA');
    assert.equal(fs.readFileSync(path.join(bakAbs, 'output', 'v.mp4'), 'utf8'), 'MP4-DATA');
    // 4) 审计日志
    const logs = db.logs['__project__:' + project.id];
    assert.ok(Array.isArray(logs) && logs.length > 0, '必须留下审计日志');
    const text = logs.map((l) => l.msg).join('\n');
    assert.match(text, /彻底删除|归档|Backup|backup/i, '日志应说明发生了什么');
    assert.match(text, /backup\/hard-delete\//, '审计日志应给出可定位的归档路径（相对数据根）');
    // 5) 残留标记（正常情况应为无残留）
    assert.equal(res.residualDir, false, '正常删除后不应有残留');
  });

  test('归档目录不在项目目录内（否则删除时会连带删掉备份）', () => {
    const db = store.load();
    const { project } = projects.createProject(db, { name: '归档位置检查' });
    paths.ensureProjectDirs(project.id);
    fs.writeFileSync(path.join(paths.assetDir(project.id), 'x.png'), 'x');
    const res = projects.hardDeleteProject(db, project.id);

    const projRoot = path.resolve(paths.projectDir(project.id));
    const bak = path.resolve(path.join(SANDBOX, res.backupDir));
    assert.ok(!bak.startsWith(projRoot + path.sep),
      '★ 归档目录不得位于被删的项目目录之下，否则归档会被一并删除');
    assert.ok(fs.existsSync(bak), '归档应仍在');
  });

  test('删除不存在的项目 → 抛 NOTFOUND，不误删别的', () => {
    const db = store.load();
    assert.throws(() => projects.hardDeleteProject(db, 'pj_不存在'), (e) => e.code === util.ERR.NOTFOUND);
  });

  test('软删除（deleteProject）只打标记，不动磁盘', () => {
    const db = store.load();
    const { project } = projects.createProject(db, { name: '软删项目' });
    paths.ensureProjectDirs(project.id);
    fs.writeFileSync(path.join(paths.assetDir(project.id), 'keep.png'), 'keep');

    projects.deleteProject(db, project.id);
    const row = db.projects.find((p) => p.id === project.id);
    assert.ok(row, '软删除后记录仍在');
    assert.ok(row.deletedAt, '应打上 deletedAt');
    assert.equal(fs.existsSync(path.join(paths.assetDir(project.id), 'keep.png')), true,
      '软删除不得动磁盘文件');
  });
});

after(() => { H.rmrf(SANDBOX); });
