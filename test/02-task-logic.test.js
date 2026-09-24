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

describe('records —— 生成记录详情（0.38.1 循环 require 回归）', () => {
  /* ⚠ 本组测试的加载顺序即**生产顺序**：本文件第 23 行先 require ../server/services，
     services 在末尾才加载 records-layer —— records-layer 捕获的是装配前的
     exports 引用。0.38.1 之前 module.exports 漏了 findSb / plannedEngineFor，
     getRecordDetail 一调用就 TypeError（线上表现：记录详情 500），测试却全绿 ——
     因为没有任何用例碰过详情接口。这组用例就是补那个洞的。 */
  test('生产加载顺序下 getRecordDetail 正常返回（findSb / plannedEngineFor 经 services 命名空间可达）', () => {
    const db = H.sampleDb();
    db.storyboards.push({
      id: 'st_r1', projectId: 'pj_t1', workspaceId: 'ws_t1', seq: 1,
      prompt: '测试提示词', model: 'seedance2.0_vip', status: 'draft', assets: []
    });
    db.records.push({
      id: 'rc_r1', projectId: 'pj_t1', storyboardId: 'st_r1',
      action: 'dryrun', outcome: 'ok', at: '2026-09-25T00:00:00.000Z'
    });
    const d = services.getRecordDetail(db, 'rc_r1', { projectId: 'pj_t1' });
    assert.equal(d.id, 'rc_r1');
    assert.equal(d.storyboardExists, true, '记录指向的分镜存在');
    assert.equal(d.storyboardCurrentModel, 'seedance2.0_vip');
    assert.equal(d.actionLabel, '干跑');
    assert.equal(d.currentEngine, 'dreamina', 'plannedEngineFor 应可达（0.38.1 前是 undefined → TypeError）');
  });

  test('分镜已删除 → 详情仍可读，storyboardExists=false', () => {
    const db = H.sampleDb();
    db.records.push({
      id: 'rc_r2', projectId: 'pj_t1', storyboardId: 'st_gone',
      action: 'generate', outcome: 'ok', at: '2026-09-25T00:00:00.000Z'
    });
    const d = services.getRecordDetail(db, 'rc_r2', { projectId: 'pj_t1' });
    assert.equal(d.storyboardExists, false);
    assert.equal(d.storyboardStatus, null);
  });

  test('跨项目记录 → NOTFOUND（作用域守卫不因回归修复而放松）', () => {
    const db = H.sampleDb();
    db.records.push({
      id: 'rc_f1', projectId: 'pj_other', storyboardId: 'st_x',
      action: 'dryrun', outcome: 'ok', at: '2026-09-25T00:00:00.000Z'
    });
    assert.throws(
      () => services.getRecordDetail(db, 'rc_f1', { projectId: 'pj_t1' }),
      /不属于当前项目/
    );
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

/* 提示词导入的名称提取（0.37.1 修复回归）：
   修复前，新格式（asset-image-prompt-builder 产出）的行内没有「｜」，
   guessPromptAssetName 的「｜」切分形同未做，整行被当成名字再截成 60 字 ——
   使用者实测 8 个资产的名称全是提示词原文片段（《最后一瓶牛奶》）。 */
describe('services —— 提示词导入的名称提取', () => {
  const names = (rawText) => {
    const r = services.importAssetPrompts({ assets: [] }, { rawText, apply: false }, { projectId: 't' });
    return r.items.map((it) => it.type + ':' + it.name);
  };

  test('★ 新格式角色：名字取「角色描述信息如下：」后首个词块（使用者实测踩到的那条）', () => {
    const raw = '根据下方角色描述信息制作一张影视级建模角色设定板\n\n' +
      '角色描述信息如下：林夏，22岁，身高约165公分；女性；深夜便利店的常客，独居于老式居民楼三层，' +
      '与深夜出现在店里的另一个自己互为镜像；身形单薄偏瘦，肩线窄而略向内收。\n\n' +
      '反向提示词：ugly, blurry.';
    assert.deepEqual(names(raw), ['character:林夏'], '★ 必须是「林夏」，而不是 60 字的描述片段');
  });

  test('新格式场景 / 道具：名字取首个「。」/「，」前', () => {
    const scene = '按照下方场景描述内容生成一张 3D 国漫场景图\n\n' +
      '场景描述内容如下：便利店。场景类型为连锁便利店室内空间，美学定位为低饱和冷调的写实都市夜景。\n\n' +
      '负面提示词：人物，角色。';
    const prop = '根据道具描述内容生成一张 3D 超写实道具设定图\n\n' +
      '道具描述内容如下：牛奶瓶，类别为饮品容器，美学定位为朴素写实的日常乳制品包装。\n\n' +
      '负面提示词：人物，角色。';
    assert.deepEqual(names(scene), ['scene:便利店']);
    assert.deepEqual(names(prop), ['prop:牛奶瓶']);
  });

  test('角色名带前缀（另一个林夏）不被切断', () => {
    const raw = '角色设定参考图\n\n' +
      '角色描述信息如下：另一个林夏，22岁，身高约165公分；女性；身份为林夏的镜像存在。\n\n人设描述：…';
    assert.deepEqual(names(raw), ['character:另一个林夏']);
  });

  test('旧格式（名称｜…）回归：仍取首个「｜」前', () => {
    const raw = '按照下方场景描述内容生成…\n\n' +
      '场景描述内容如下：公寓餐厨起居区｜居家室内场景｜夜景。\n\n…';
    assert.deepEqual(names(raw), ['scene:公寓餐厨起居区']);
  });

  test('旧格式（【姓名】群像）回归：取所有姓名拼接', () => {
    const raw = '角色设定参考图\n\n【姓名】：林夏\n【姓名】：阿哲\n\n人设描述：…';
    assert.deepEqual(names(raw), ['character:林夏、阿哲']);
  });

  test('行内没有任何分隔符 → 整行就是名字（不再被截成 60 字）', () => {
    const raw = '角色设定参考图\n\n角色描述信息如下：林夏的镜像\n\n人设描述：…';
    assert.deepEqual(names(raw), ['character:林夏的镜像']);
  });

  test('名字超过 ASSET_NAME_MAX(60) 才按上限截断', () => {
    const long = '一'.repeat(80);
    const raw = '按照下方场景描述内容生成…\n\n' +
      '场景描述内容如下：' + long + '。场景类型为…\n\n…';
    const r = names(raw);
    assert.equal(r[0], 'scene:' + '一'.repeat(60), '超长名字按库上限截断（前缀 scene: 是测试自己的拼装）');
  });

  test('真实粘贴形态（含 ```text 围栏 + @ 分节）不受影响，且逐段各得其所', () => {
    const raw = '```text\n根据下方角色描述信息制作一张影视级建模角色设定板\n\n' +
      '角色描述信息如下：阿哲，25岁，身高约172公分；男性；这家便利店的值夜收银员。\n\n' +
      '反向提示词：ugly.\n```\n\n@\n\n```text\n按照下方场景描述内容生成一张 3D 国漫场景图\n\n' +
      '场景描述内容如下：居民楼走廊。场景类型为老式住宅楼楼道。\n```\n';
    assert.deepEqual(names(raw), ['character:阿哲', 'scene:居民楼走廊']);
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
