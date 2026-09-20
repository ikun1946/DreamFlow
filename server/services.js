'use strict';
/* ============================================================
   services.js —— 业务逻辑层（23 个接口的实现 + 演示引擎）
   行为与 docs/前端页面与接口对接说明.md 逐条对齐（前端契约）：
   - 列表内联 stats；轮询只回 dirty 行；已完成分镜锁时长(40900)
   - 批量时长 updated/skipped；批量提交 accepted/rejected
   - 运行中删除需 force；分隔符拆分 trim 首尾、丢空段
   ============================================================ */
const { ERR, ApiError, rid, nowIso, clamp, grad } = require('./util');
const store = require('./store');
const models = require('./models');   // 模型注册表：归属/命名/路由的唯一事实来源
const TS = require('./task-state');   // 任务状态迁移与写入权限的唯一事实来源
const AL = require('./asset-lock');   // 素材图号 / 素材锁定区块 / 引用校验的唯一事实来源
const REC = require('./records');     // 生成记录：查询 / 详情 / 删除 / 清空 / 导出
const P = require('./projects');      // 项目/工作区归属与作用域解析的唯一出口
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const PATHS = require('./paths');    // 磁盘布局与资源 URL 形状的唯一事实来源
/* ⚠ 注意与上面的 `P`（= ./projects，项目/工作区数据层）区分开：两个 P 会重名。 */

/* 素材上传允许的扩展名（创建/批量导入共用） */
const ASSET_EXT = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']
};
/* 素材类型 → 上传校验用的种类（图片 / 音频）。
   ⚠ 2026-09-20 新增 firstFrame / storyboard 两类：它们**不是**场景素材。
   此前首帧图 / 分镜图两个槽位在映射表里被指到 'scene'，于是这两类素材无处存放、
   只能借场景库，点开槽位只看到场景图 → 用户报「提示资产缺失」。
   现在每个槽位有各自独立的资产库，一一对应（见前端 ROLE_META）。 */
const ASSET_TYPE_KIND = {
  character: 'image', scene: 'image', prop: 'image',
  firstFrame: 'image', storyboard: 'image',
  audio: 'audio'
};

/* **多值槽位**的唯一事实来源：这些 role 可以绑多个素材，其余为单值（再绑会替换）。
   ⚠ 原先后端硬编码成 `role !== 'character'`、前端另有一份 ROLE_META.multi ——
   两处各写各的，改一处就不同步。现在两边都以这份表为准。 */
const ROLE_MULTI = { character: true, prop: true };
const isMultiRole = (role) => ROLE_MULTI[role] === true;

/* 静态模型兜底（探测不可用时使用）：清单与归属全部来自模型注册表。
   2026-09-18 画布 CLI 移除后，可用模型 = 创作 CLI 支持的全部型号。 */
function staticModels() {
  return models.DREAMINA_VIDEO_MODELS.map((v) => ({
    value: v,
    label: models.labelOf(v),
    enabled: true,
    engines: models.enginesFor(v),
    group: models.groupOf(v)
  }));
}

/* ---------------- 静态枚举（与 app/api.js META 同源） ---------------- */
const META = {
  projectName: '',   // 项目名由请求作用域解析后填入（原来硬编码 '雨夜归途'，那是模块级常量、不是用户数据）
  models: staticModels(),
  // 模型下拉的分组维度：按引擎归属（前端据此渲染 optgroup）
  modelGroups: [
    { key: 'dreamina', label: '创作 CLI' }
  ],
  ratios: [
    { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
    { value: '1:1',  label: '1:1'  }, { value: '4:3',  label: '4:3' }
  ],
  resolutions: [
    { value: '480p', label: '480p' }, { value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }
  ],
  duration: { min: 4, max: 15, step: 1, defaultValue: 5, presets: [5, 10, 12], unit: 's', allowCustom: true },
  settings: {
    delimiterTypes: [
      { value: 'newline', label: '换行符' },
      { value: 'custom',  label: '自定义' }
    ],
    delimiterPresets: [';;', '|', '---'],
    concurrency: { min: 1, max: 5, defaultValue: 2 },
    autoRetry: { defaultValue: true, maxRetry: 2 }
  }
};

const DEFAULT_SETTINGS = () => ({
  delimiter: { type: 'custom', value: ';;' },
  // 默认模型用创作域名（画布域名已随画布 CLI 一起下线）
  defaults: { model: 'seedance2.0_vip', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' },
  queue: { concurrency: 2, autoRetry: true, maxRetry: 2 },
  adapter: { dreaminaAvailable: false, dreaminaVersion: null }   // 只读：创作 CLI 状态由探测写入
});

/* ---------------- 基础查询 ---------------- */
const bySeq = (a, b) => a.seq - b.seq;
const findAsset = (db, id) => db.assets.find((a) => a.id === id);
const findSb = (db, id) => db.storyboards.find((x) => x.id === id);

/* ============================================================
   作用域（多项目架构，2026-09-19）
   ------------------------------------------------------------
   铁律：**隔离必须由后端做**，绝不允许"查出全部再让前端过滤"（指令 §29/§30）。
   因此下面每个带 scope 的函数都真的按 scope 过滤，而不是把 scope 当提示。

   scope 由路由层用 P.resolveScope() 解析后传入（request-scoped，
   后端不存在任何"当前项目"全局变量，指令 §3.4/§34）。
   scope = { project, workspace, projectId, workspaceId }
   ============================================================ */

/* 当前作用域内的分镜。workspaceId 是分镜的归属键（指令 §3.2）。 */
function scopeStoryboards(db, scope) {
  return db.storyboards.filter((s) => s && s.workspaceId === scope.workspaceId);
}

/* 按 id 取分镜，并**校验它在本作用域内**。
   不在作用域内一律按"不存在"处理（404 而不是 403）—— 不泄露别的项目里是否存在这个 id。 */
function findScopedSb(db, id, scope) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
  if (s.workspaceId !== scope.workspaceId) {
    throw new ApiError(ERR.NOTFOUND, '分镜不属于当前分镜表：' + id);
  }
  return s;
}

/* 作用域内的素材。Asset 属于 **Project**（指令 §3.3），因此同一项目的所有工作区共享。 */
function scopeAssets(db, scope) {
  return db.assets.filter((a) => a && a.projectId === scope.projectId);
}

/* 取素材并校验它属于当前项目（跨项目绑定必须被拒，指令 §43）。 */
function findScopedAsset(db, id, scope) {
  const a = findAsset(db, id);
  if (!a) throw new ApiError(ERR.NOTFOUND, '素材不存在');
  if (a.projectId !== scope.projectId) {
    throw new ApiError(ERR.NOTFOUND, '素材不属于当前项目（素材 ' + id + '）');
  }
  return a;
}

/* 项目级生效设置：项目覆盖 ⊕ 全局默认（指令 §15.3 兼容策略，不一次大拆）。
   queue / adapter 保持系统级，不随项目变化。 */
const effectiveDefaults = (db, scope) => P.resolveProjectSettings(db, scope.projectId);
const effectiveDelimiter = (db, scope) => P.resolveProjectDelimiter(db, scope.projectId);

/* 展示用引擎归属：按「模型归属 + 音频绑定」推演（规则与 worker 派发同一出口，
   展示态不代入可用性回退——真实派发时的回退会写进任务日志）。 */
function plannedEngineFor(db, s) {
  return models.routeEngine({
    model: s.model,
    hasAudio: (s.assets || []).some((r) => r.role === 'audio')
  });
}

function decorate(db, s) {
  const pe = plannedEngineFor(db, s);
  /* 图号表在列表层也要算一次：表格槽位要显示「图片N」，干跑卡要判断记录是否过期。
     与详情、与创作 CLI 组装共用 asset-lock.js 的同一个函数，三处结果必然一致。 */
  const cat = AL.imageCatalog(s, db);
  const plan = s.dryRunPlan;
  const stale = !!(plan && plan.command) && (plan.sig ? plan.sig !== AL.signature(s, db) : true);
  return Object.assign({}, s, { dirty: undefined, _runtime: undefined, dryRunPlan: undefined, submitDryRun: undefined }, {
    plannedEngine: pe.engine,
    plannedEngineLabel: models.engineLabel(pe.engine),
    plannedEngineReason: pe.reason,
    // 干跑记录摘要（列表用；完整 plan 只在详情里返回）
    dryRunAt: (s.dryRunPlan && s.dryRunPlan.at) || null,
    dryRunCommand: (s.dryRunPlan && s.dryRunPlan.command) || null,
    dryRunStale: stale,
    pendingDryRun: s.submitDryRun === true,
    imageCount: cat.images.length,          // 本次会发出的图片数（= --image 个数）
    /* 该分镜当前模型允许的参考图上限 + 所属系列。前端「已添加 X / 上限 Y」与
       达上限时的拦截提示都读它 —— 上限只由 models.js 的系列规则表决定，别在别处算。 */
    imageLimit: models.imageLimitFor(s.model),
    imageLimitFamily: models.limitFamilyOf(s.model),
    audioCount: cat.audios.length,
    assets: (() => {
      /* 给每个绑定素材标上「图片N / 音频N」——图号与创作 CLI 的 --image 顺序同源，
         前端据此在槽位旁显示图号，作者才能知道自己该写 @图片N。 */
      const imgNo = {}, audNo = {}, why = {};
      cat.images.forEach((x) => { imgNo[x.assetId] = x.n; });
      cat.audios.forEach((x, i) => { audNo[x.assetId] = i + 1; });
      cat.skipped.forEach((x) => { why[x.assetId] = x.reason; });
      return (s.assets || []).map((r) => {
        const a = findAsset(db, r.assetId) || { id: r.assetId, name: '未知素材', gradSeedKey: r.assetId };
        return {
          assetId: a.id, role: r.role, name: a.name,
          thumbUrl: a.thumbUrl, url: a.url, type: a.type, grad: grad(a.gradSeedKey),
          imageIndex: imgNo[a.id] || null,      // 图片N（音频不占号）
          audioIndex: audNo[a.id] || null,
          notCounted: why[a.id] || null         // 未计入图号的原因（文件丢失/素材已删…）
        };
      });
    })(),
    grad: grad(s.id)
  });
}

/* 统计。**按作用域统计**（多项目升级）—— 原来统计整个库，
   于是项目 A 的页面里会显示项目 B 的进度与预计剩余。scope 缺省时保持全局行为。 */
function stats(db, scope) {
  const all = scope ? scopeStoryboards(db, scope) : db.storyboards;
  const c = { draft: 0, queued: 0, generating: 0, succeeded: 0, failed: 0, canceled: 0 };
  all.forEach((s) => { c[s.status] = (c[s.status] || 0) + 1; });
  const finished = c.succeeded + c.failed + c.canceled;
  const remain = c.queued + c.generating;   // draft 未提交，不计入生成剩余
  const avg = 14;
  const conc = Math.max(1, db.settings.queue.concurrency);
  return {
    total: all.length,
    draft: c.draft,
    queued: c.queued, generating: c.generating, succeeded: c.succeeded,
    failed: c.failed, canceled: c.canceled,
    overallProgress: all.length ? Math.round((finished / all.length) * 100) : 0,
    etaSeconds: remain ? Math.round((remain * avg) / conc) : 0
  };
}

/* 序号重编。**必须按工作区**（多项目升级）：seq 是分镜在页面内的展示序号，
   原来全局重编会让两个页面的分镜互相插队（bySeq 排序把它们混在一起，
   "镜头 3" 可能出现在另一个页面里）。 */
function renumber(db, scope) {
  const list = scope ? scopeStoryboards(db, scope) : db.storyboards;
  list.slice().sort(bySeq).forEach((s, i) => { s.seq = i + 1; });
  /* db.seq 保留为历史遗留计数（不再作为序号来源），新序号一律用 nextSeq 现算 */
  db.seq = db.storyboards.length;
}

/* 工作区内的下一个序号。不能用全局 db.seq —— 那样两个页面会共用一串号。 */
function nextSeq(db, scope) {
  return scopeStoryboards(db, scope).reduce((m, s) => Math.max(m, Number(s.seq) || 0), 0) + 1;
}

/* 分隔符拆分：与前端 splitSegments() 逐字一致 */
function splitSegments(rawText, delimiter) {
  const text = String(rawText || '');
  if (!text.trim()) return [];
  let parts;
  if (!delimiter || delimiter.type === 'newline' || !delimiter.value) {
    parts = text.split(/\r?\n/);
  } else {
    parts = text.split(delimiter.value);
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/* ---------------- 各接口实现 ---------------- */
/* 分镜列表。**只返回本工作区的分镜**（指令 §30：后端必须限定 workspaceId，
   并已由 resolveScope 校验该工作区确实属于请求里的项目）。 */
function listStoryboards(db, q, scope) {
  let list = scopeStoryboards(db, scope).sort(bySeq);
  if (q.status) {
    const want = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
    if (want.length) list = list.filter((s) => want.includes(s.status));
  }
  if (q.keyword) {
    const k = String(q.keyword).toLowerCase();
    list = list.filter((s) => s.prompt.toLowerCase().includes(k) || s.id.includes(k) || (s.remoteId || '').includes(k));
  }
  const page = Number(q.page || 1), pageSize = Number(q.pageSize || 20);
  const total = list.length;
  const slice = list.slice((page - 1) * pageSize, page * pageSize);
  slice.forEach((s) => { s.dirty = false; });
  store.save();
  return { list: slice.map((s) => decorate(db, s)), page, pageSize, total, stats: stats(db, scope) };
}

/* 进度轮询。⚠ 加作用域校验（指令 §30）：原来只按客户端传来的 id 查，
   任何调用方都能按 id 读到别的项目里分镜的进度与错误信息。 */
function getProgress(db, idsParam, scope) {
  const ids = String(idsParam || '').split(',').map((s) => s.trim()).filter(Boolean);
  /* ⚠ 不再「读后清」（2026-09-19 修复）。
     原实现在这里 `s.dirty = false`，等于让"谁先问谁消费掉这次变化"：同时开两个标签页时，
     A 拿到更新并把 dirty 清掉，B 之后只能收到空数组、界面永远停在旧进度上，
     极端情况下 B 会一直轮询却再也看不到任务结束（UI 永久卡在「生成中」）。
     现在只读取、不清除；dirty 由 listStoryboards（列表刷新）统一清 —— 那是"确实拿到过完整状态"
     的时点。代价是生成期间前端不再退避到 10s（每轮都有变化），对本地服务可忽略。
     前端侧配套：按载荷签名判断"真的没变"再退避，见 app/app.js 的 pollOnce。 */
  const changed = scopeStoryboards(db, scope).filter((s) => ids.includes(s.id) && s.dirty);
  return changed.map((s) => ({
    id: s.id, status: s.status, progress: Math.round(s.progress),
    etaSeconds: s.etaSeconds, currentFrameUrl: s.currentFrameUrl,
    videoUrl: s.videoUrl, coverUrl: s.coverUrl,
    retryCount: s.retryCount, errorCode: s.errorCode, errorMessage: s.errorMessage,
    canEditDuration: s.canEditDuration
  }));
}

function getStoryboard(db, id, cfg, scope) {
  const s = findScopedSb(db, id, scope);
  // 命令回显按「实际会被路由到的引擎」生成（与 worker 派发同一套判定）
  const pe = plannedEngineFor(db, s);

  /* 素材锁定：图号表 → 锁定区块 → 注入后的完整提示词（**原文一字未改**）。
     与创作 CLI 组装共用 asset-lock.js，保证「页面看到的」==「实际执行的」。 */
  const cat = AL.imageCatalog(s, db);
  const lockBlock = AL.lockBlock(cat.images, s);
  const promptWithLock = AL.compose(s.prompt, lockBlock);
  const lockIssues = AL.validate(s.prompt, cat.images, { skipped: cat.skipped });
  // 创作 CLI 的 multimodal2video 会把 ref 图真正发出去，锁定区块也随之注入
  const injected = !!lockBlock;

  const safePrompt = promptWithLock.replace(/"/g, '\\"');
  const dm = models.dreaminaModelOf(s.model) || s.model;
  const cmd = (cat.images.length || cat.audios.length) ? 'multimodal2video' : 'text2video';
  const cliCommand = (cfg.dreaminaCliPath || 'dreamina') + ' ' + cmd + ' --prompt "' + safePrompt +
    '" --duration ' + s.durationSec + ' --ratio ' + s.ratio +
    ' --video_resolution ' + String(s.resolution || '').toLowerCase() +
    ' --model_version ' + dm +
    cat.images.map((x) => ' --image <图片' + x.n + ':' + x.name + '>').join('') +
    '    # 创作 CLI（' + models.capsFor(dm).note + '）；提示词已含素材锁定区块' +
    (lockBlock ? '' : '（本分镜无图片，未追加）');
  /* 干跑记录是否过期：提示词 / 绑定素材 / 生成参数任一变化，旧记录里的命令就不再
     代表实际会执行的命令（例如加素材锁定前落的记录，命令里没有锁定区块）。
     判定靠落盘时的指纹 sig；旧版本没写 sig 的记录一律按「无法确认 → 过期」处理。 */
  const sigNow = AL.signature(s, db);
  const dryRunStale = !!(s.dryRunPlan && s.dryRunPlan.command) &&
    (s.dryRunPlan.sig ? s.dryRunPlan.sig !== sigNow : true);
  // 有干跑记录时优先展示「已验证的真实命令」，否则展示按路由推演的命令
  const finalCmd = (s.dryRunPlan && s.dryRunPlan.command)
    ? (s.dryRunPlan.command + '    # 干跑记录 ' + s.dryRunPlan.at + '（未连接服务端）' +
       (dryRunStale ? ' ⚠ 已过期：此后提示词/绑定/参数有变动，请重新干跑' : ''))
    : cliCommand;
  return Object.assign(decorate(db, s), {
    cliCommand: finalCmd,
    dryRunPlan: s.dryRunPlan || null,
    dryRunStale,                 // true = 旧记录，命令不可信，界面应提示重新干跑
    dryRunSig: sigNow,           // 当前指纹（前端可对比 dryRunPlan.sig）
    // 素材锁定：图号表 + 将追加的区块 + 注入后完整提示词 + 引用校验（原文始终可从这里拿 s.prompt）
    assetLock: {
      images: cat.images.map((x) => ({ n: x.n, assetId: x.assetId, name: x.name, role: x.role, roleLabel: x.roleLabel, via: x.via })),
      audios: cat.audios.map((x, i) => ({ n: i + 1, assetId: x.assetId, name: x.name })),
      skipped: cat.skipped,
      block: lockBlock,
      promptWithLock,
      injected,                 // 本次提交是否真的会注入（画布链路不注入）
      issues: lockIssues
    },
    logs: (db.logs[s.id] || []).slice(-20)
  });
}

/* 干跑校验：不提交、不改任务状态，只给出「提交后会执行的完整命令」。
   （原实现还支持让画布 CLI 做 --dry-run 本地校验；创作 CLI 没有该 flag，
    命令由适配层按能力表组装并本地校验，见 worker.planFor。） */
async function dryRunStoryboard(db, id, adapter, opts, scope) {
  const s = findScopedSb(db, id, scope);
  if (!adapter || typeof adapter.planFor !== 'function') {
    throw new ApiError(ERR.INTERNAL, '适配器不支持干跑校验（请重启服务）');
  }
  const plan = await adapter.planFor(db, s, {});
  return Object.assign({
    storyboardId: s.id, seq: s.seq, status: s.status,
    model: s.model, ratio: s.ratio, resolution: s.resolution, durationSec: s.durationSec,
    prompt: s.prompt,
    assets: (s.assets || []).map((r) => {
      const a = findAsset(db, r.assetId) || {};
      return { role: r.role, assetId: r.assetId, name: a.name || null };
    })
  }, plan);
}

/* 新建分镜。归属由作用域决定（不再硬编码 pj_1），序号在工作区内现算。 */
function createStoryboard(db, b, scope) {
  const d = effectiveDefaults(db, scope);
  /* 先定模型再钳时长：时长上限取决于**该分镜实际用的模型**（seedance2.5 到 30s，
     其余到 15s）。原先统一按全局 META.duration（4–15）钳，于是"设置页能选 30、
     创建出来却是 15"（2026-09-19 修复）。 */
  const model = b.model || d.model;
  const s = {
    id: rid('st_'), projectId: scope.projectId, workspaceId: scope.workspaceId,
    batchId: 'bt_21', seq: nextSeq(db, scope),
    prompt: b.prompt || '', negativePrompt: b.negativePrompt != null ? b.negativePrompt : d.negativePrompt,
    durationSec: models.clampDuration(model, b.durationSec || d.durationSec),
    model: model, ratio: b.ratio || d.ratio,
    resolution: b.resolution || d.resolution, seed: 'random',
    motion: b.motion != null ? Number(b.motion) : d.motion,
    status: 'draft', progress: 0, etaSeconds: null, remoteId: null,
    videoUrl: null, coverUrl: null, currentFrameUrl: null, elapsedMs: null,
    retryCount: 0, errorCode: null, errorMessage: null, canEditDuration: true,
    assets: [], createdAt: nowIso(), startedAt: null, finishedAt: null, dirty: true
  };
  db.storyboards.push(s);
  store.save();
  return decorate(db, s);
}

function patchStoryboard(db, id, b, scope) {
  const s = findScopedSb(db, id, scope);
  if (b.durationSec != null && !s.canEditDuration) {
    throw new ApiError(ERR.CONFLICT, '分镜已完成，修改时长需重新生成');
  }
  // 本次生效的模型：同一请求里既改模型又改时长时，要按**新模型**的能力钳
  const effModel = b.model != null ? b.model : s.model;
  if (b.durationSec != null) {
    const v = Math.round(Number(b.durationSec));
    if (!isFinite(v)) throw new ApiError(ERR.PARAM, '时长不合法');
    s.durationSec = models.clampDuration(effModel, v);
  }
  ['prompt', 'model', 'ratio', 'resolution', 'seed', 'motion', 'negativePrompt'].forEach((k) => {
    if (b[k] != null) s[k] = b[k];
  });
  // 改了提示词、且这次没显式指定时长 → 时长自动跟随提示词里的「总时长」标注
  if (b.durationSec == null && b.prompt != null && s.canEditDuration) {
    const byPrompt = parsePromptDuration(s.prompt).seconds;
    if (byPrompt != null) s.durationSec = models.clampDuration(effModel, byPrompt);
  }
  s.dirty = true;
  store.save();
  return decorate(db, s);
}

function batchDuration(db, b, scope) {
  const updated = [], skipped = [];
  (b.ids || []).forEach((id) => {
    const s = findSb(db, id);
    if (!s) return skipped.push({ id, reason: 'not_found', message: '分镜不存在' });
    /* 不在本页面内的一律按"不存在"处理，绝不改写（隔离由后端强制） */
    if (s.workspaceId !== scope.workspaceId) return skipped.push({ id, reason: 'not_found', message: '分镜不在当前分镜表内' });
    if (!s.canEditDuration) return skipped.push({ id, reason: 'completed_locked', message: '已完成，已锁定时长' });
    s.durationSec = models.clampDuration(s.model, b.durationSec);
    s.dirty = true; updated.push(id);
  });
  store.save();
  return { updated, skipped };
}

function batchSubmit(db, b, adapter, cfg, scope) {
  const D = adapter && adapter.dreamina;
  if (!D) return Promise.reject(new ApiError(ERR.CLI_DOWN, '创作 CLI 适配器未加载（请重启服务）'));
  /* 提交前的可用性闸。刻意**不**无条件强制探测：单次 `dreamina user_credit` 实测 8–9 秒，
     把它放到提交路径上就变成"点提交后卡 9 秒"（同 2026-09-18 设置弹窗那个坑）。
     这里取"新鲜缓存 → 最后已知值"这个非阻塞视角；只有从未探测过（服务刚启动）才限时等一次。
     真实可用性由 worker 在派发前再确认一遍 —— 不可用时任务留在队列，不会丢也不会误扣。 */
  const known = (typeof D.peek === 'function' ? D.peek() : null) ||
    (typeof D.lastProbe === 'function' ? D.lastProbe() : null);
  if (known && !known.available) {
    return Promise.reject(new ApiError(ERR.CLI_DOWN, known.message || '创作 CLI 未连接，无法提交'));
  }
  const gate = known
    ? Promise.resolve(known)
    : withTimeout(D.probe(), 2500, null).then((p) => {
      if (!p || !p.available) throw new ApiError(ERR.CLI_DOWN, (p && p.message) || '创作 CLI 未连接，无法提交');
      return p;
    });
  return gate.then(() => doSubmit(db, b, scope));
}

function doSubmit(db, b, scope) {
  const accepted = [], rejected = [];
  const dry = b.dryRun === true;   // 本批次干跑：进队列组装命令但不派发
  (b.ids || []).forEach((id) => {
    const s = findSb(db, id);
    if (!s) return rejected.push({ id, code: String(ERR.NOTFOUND), message: '分镜不存在' });
    /* ⚠ 跨页面/跨项目提交必须拒绝（指令 §30/§43）：否则构造一个请求就能把
       别的项目里排队的任务拉进来跑，等于绕过隔离。 */
    if (s.workspaceId !== scope.workspaceId) {
      return rejected.push({ id, code: String(ERR.NOTFOUND), message: '分镜不在当前分镜表内' });
    }
    if (TS.isRunning(s.status)) {
      return rejected.push({ id, code: String(ERR.CONFLICT), message: '该分镜已在队列中' });
    }
    if (s.errorCode === String(ERR.NO_CREDIT)) {
      return rejected.push({ id, code: String(ERR.NO_CREDIT), message: '积分不足，无法提交' });
    }
    TS.assertTransition(s.status, TS.STATUS.QUEUED);
    s.status = TS.STATUS.QUEUED; s.progress = 0; s.errorCode = null; s.errorMessage = null;
    s.finishedAt = null; s.remoteId = null; s.dirty = true;
    /* 每次提交都换一个新 attemptId：worker 只认当前 attempt，上一轮的迟到结果一律丢弃
       （重新生成同一分镜时，旧一轮的 CLI 回调不能再改这个分镜）。 */
    s.attemptId = TS.newAttemptId();
    if (dry) s.submitDryRun = true; else s.submitDryRun = false;
    accepted.push({ id, remoteId: null, status: 'queued' });
  });
  /* ⚠ 这里**不再**把并发写回设置（2026-09-19 修复）。
     原实现是 `clamp(Number(b.concurrency), 1, 5)` —— 前端每次提交都会带上当前设置，
     于是用户把并发设成 8 时，一次提交就被**静默改回 5**，界面配置与真实行为长期不一致。
     并发上限现在只有一个出口：PUT /settings（按本地保护上限校验）+ worker 派发闸。
     这里最多只做"不改动既有值"的合法性检查，避免把非法值写进库。 */
  if (b.concurrency != null) {
    const v = Number(b.concurrency);
    if (!Number.isFinite(v) || v < 1) {
      return { accepted, rejected, dryRun: dry, concurrencyRejected: { value: b.concurrency, message: '并发数须为不小于 1 的整数（本次未改动设置）' } };
    }
  }
  store.save();
  return { accepted, rejected, dryRun: dry };
}

function cancel(db, id, scope) {
  const s = findScopedSb(db, id, scope);
  if (s.status === 'succeeded') throw new ApiError(ERR.CONFLICT, '已完成的分镜无法取消');
  if (s.status === 'draft') throw new ApiError(ERR.CONFLICT, '未提交的分镜无需取消，直接删除或编辑即可');
  if (!TS.canCancel(s.status)) throw new ApiError(ERR.CONFLICT, '当前状态（' + s.status + '）无法取消');
  TS.assertTransition(s.status, TS.STATUS.CANCELED);
  const wasGenerating = s.status === 'generating';
  s.status = TS.STATUS.CANCELED; s.progress = 0; s.etaSeconds = 0; s.finishedAt = nowIso(); s.dirty = true;
  /* 清掉 attemptId —— 这是「取消后不再被覆盖」的关键：
     worker 手里那次派发持有的旧 attemptId 从此对不上，它拿到的 CLI 结果会被直接丢弃，
     不会再把这个分镜写回 succeeded（2026-09-19 修复：原先会出现
     generating → canceled → succeeded 的"取消后复活"）。 */
  s.attemptId = null;
  if (wasGenerating) {
    s.elapsedMs = s.startedAt ? Math.max(0, Date.now() - Date.parse(s.startedAt)) : s.elapsedMs;
    store.pushLog(s.id, 'warn', '已取消本地跟踪（CLI 无取消命令，即梦侧任务将继续并照常计费）');
  }
  /* 取消也是"一次提交的结果"，必须留痕：否则记录页上这次提交会凭空消失，
     看起来像"从没跑过"，与"跑了但被取消"是两种完全不同的事实。 */
  const job = db.cliJobs[s.id] || {};
  REC.append(db, s, {
    action: 'generate', outcome: 'canceled',
    command: job.command || null, argv: job.argv || null, mode: job.mode || null,
    cliModel: job.cliModel || null, engine: job.engine || undefined,
    submitId: job.submitId || null,
    errorCode: null,
    errorMessage: wasGenerating ? '已取消本地跟踪（即梦侧任务可能仍在运行并照常计费）' : '排队中被取消'
  });
  store.save();
  return decorate(db, s);
}

function retry(db, id, scope) {
  const s = findScopedSb(db, id, scope);
  /* ⚠ 状态限制（2026-09-19 修复）：原先 retry 没有任何校验，generating 也能 retry
     ⇒ 同一分镜同时跑两轮生成，**直接重复扣费**。现在只允许 failed / canceled。
     界面上的重试按钮本就只在失败行出现，这里是让后端对齐界面已有的意图。 */
  if (!TS.canRetry(s.status)) {
    throw new ApiError(ERR.CONFLICT,
      s.status === 'generating' || s.status === 'queued'
        ? '该分镜正在生成中，无法重试（如需中止请先「取消」）'
        : (s.status === 'succeeded' ? '该分镜已完成；如需重新生成请用「提交所选」' : '当前状态（' + s.status + '）不允许重试'));
  }
  TS.assertTransition(s.status, TS.STATUS.QUEUED);
  s.status = TS.STATUS.QUEUED; s.progress = 0; s.etaSeconds = null;
  s.errorCode = null; s.errorMessage = null; s.retryCount++; s.dirty = true;
  s.canEditDuration = true;
  s.attemptId = TS.newAttemptId();   // 新的一轮 = 新的 attempt，旧一轮的迟到结果一律丢弃
  store.save();
  return decorate(db, s);
}

function batchDelete(db, b, scope) {
  const ids = b.ids || [];
  const inScope = scopeStoryboards(db, scope);
  const scopedIds = new Set(inScope.map((s) => s.id));
  /* 不在本页面内的 id 一律按"不存在"处理、**绝不删除**（指令 §29/§30） */
  const mine = ids.filter((id) => scopedIds.has(id));
  const notInScope = ids.filter((id) => !scopedIds.has(id));

  const running = inScope.filter((s) => mine.includes(s.id) && TS.isRunning(s.status));
  if (running.length && !b.force) {
    throw new ApiError(ERR.CONFLICT, '存在运行中的分镜，请确认后强制删除', { ids: running.map((s) => s.id) });
  }
  /* ⚠ 强制删除运行中的分镜：先把它们置为 canceled 并清掉 attemptId，再删。
     为什么要多这一步（2026-09-19 修复）：worker 手里那次派发还持有旧 attemptId，
     直接物理删除的话它会继续往这个已消失的分镜上写日志 / 生成记录，并把 cliJobs
     条目重新建回来 —— 表现为"删除后任务又出现"、留下孤立的生成记录。
     先取消 = 让那次派发立即失去写入权（worker 侧按 attemptId + 存在性双重守卫）。 */
  running.forEach((s) => {
    s.status = TS.STATUS.CANCELED;
    s.attemptId = null;
    store.pushLog(s.id, 'warn', '运行中被强制删除：已先中止本地跟踪（CLI 无取消命令，即梦侧任务可能仍在运行并照常计费）');
  });
  const deleted = inScope.filter((s) => mine.includes(s.id)).map((s) => s.id);
  db.storyboards = db.storyboards.filter((s) => !deleted.includes(s.id));
  deleted.forEach((id) => { delete db.logs[id]; delete db.cliJobs[id]; });
  renumber(db, scope);
  store.save();
  return { deleted, canceledBeforeDelete: running.map((s) => s.id), notInScope };
}

function reorder(db, id, b, scope) {
  const s = findScopedSb(db, id, scope);
  /* 只在**本工作区内**换位：原来按全库排序取邻居，多工作区之后会把两个页面的
     分镜互换 seq，表现为"上移一下跳到了别的页面"。 */
  const sorted = scopeStoryboards(db, scope).slice().sort(bySeq);
  const idx = sorted.findIndex((x) => x.id === s.id);
  const to = b.direction === 'up' ? idx - 1 : idx + 1;
  if (to >= 0 && to < sorted.length) {
    const other = sorted[to];
    const t = s.seq; s.seq = other.seq; other.seq = t;
    s.dirty = true; other.dirty = true;
  }
  store.save();
  return { id: s.id };
}

/* 素材列表。**只返回本项目的素材**（指令 §29：禁止"查全部再让前端按 projectId 过滤"）。
   同一项目内的所有工作区都能看到同一份素材库（Asset 属于 Project，§3.3）。 */
function listAssets(db, q, scope) {
  const type = q.type || 'character';
  const kw = q.keyword ? String(q.keyword).toLowerCase() : '';
  const projectAssets = scopeAssets(db, scope);
  let pool = projectAssets.filter((a) => a.type === type);
  if (kw) pool = pool.filter((a) => a.name.toLowerCase().includes(kw));
  pool = pool.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));   // 新素材在前
  /* inShotId 也必须落在本工作区内 —— 否则可以借别的页面的分镜 id 反查它的绑定 */
  let usedIds = [];
  if (q.inShotId) {
    const shot = findSb(db, q.inShotId);
    if (shot && shot.workspaceId === scope.workspaceId) usedIds = shot.assets.map((r) => r.assetId);
  }
  const view = (a) => viewAsset(a, usedIds);
  const currentShot = usedIds.length ? projectAssets.filter((a) => usedIds.includes(a.id)).map(view) : [];
  return {
    currentShot,
    library: pool.map(view),
    counts: { currentShot: currentShot.length, library: pool.length }
  };
}

/* 对外视图（统一在此脱敏内部字段、派生渐变） */
function viewAsset(a, usedIds) {
  return Object.assign({}, a, {
    gradSeedKey: undefined,
    inCurrentShot: (usedIds || []).includes(a.id), grad: grad(a.gradSeedKey)
  });
}

/* ---------------- 创建 / 批量导入素材（本地上传，文件名默认为素材名） ---------------- */
function createAsset(db, opts, scope) {
  const type = String(opts.type || '');
  const kind = ASSET_TYPE_KIND[type];
  if (!kind) throw new ApiError(ERR.PARAM, '素材类型不合法：' + type + '（支持 ' + Object.keys(ASSET_TYPE_KIND).join('/') + '）');
  const filename = String(opts.filename || '');
  if (!filename) throw new ApiError(ERR.PARAM, '缺少文件名');
  const ext = (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!ASSET_EXT[kind].includes(ext)) {
    throw new ApiError(ERR.PARAM, type === 'audio'
      ? '音频素材仅支持 ' + ASSET_EXT.audio.join(' / ')
      : '图片素材仅支持 ' + ASSET_EXT.image.join(' / '));
  }
  const buf = opts.buffer;
  if (!buf || !buf.length) throw new ApiError(ERR.PARAM, '文件内容为空');
  const id = rid('as_');
  const fname = id + ext;
  /* 落到**本项目自己的目录**（data/projects/<项目>/assets/）——
     这样"彻底删除项目"只需删一个文件夹，不会牵动别的项目。 */
  PATHS.ensureProjectDirs(scope.projectId);
  fs.writeFileSync(path.join(PATHS.assetDir(scope.projectId), fname), buf);
  const base = filename.replace(/\.[^.]+$/, '').trim() || ('素材-' + id.slice(3, 9));
  const url = PATHS.assetUrl(scope.projectId, fname);
  const asset = {
    id, projectId: scope.projectId, name: base, type,
    url,
    thumbUrl: kind === 'audio' ? null : url,
    width: 0, height: 0, size: buf.length, tags: [],
    createdAt: nowIso(), updatedAt: null,
    gradSeedKey: id, origin: 'upload'
  };
  db.assets.push(asset);
  store.save();
  return viewAsset(asset);
}

function bindAsset(db, id, b, scope) {
  const s = findScopedSb(db, id, scope);
  const role = b.role;
  /* role 与资产类型一一对应（本项目 type 即 role），故直接以类型表为准，避免两处漂移 */
  if (!Object.keys(ASSET_TYPE_KIND).includes(role)) {
    throw new ApiError(ERR.PARAM, 'role 不合法');
  }
  /* ⚠ 跨项目绑定必须拒绝（指令 §43）：分镜所在工作区的项目 == 素材的 projectId。
     即使调用方构造请求传入别的项目的素材 id，也必须在这里被拦下 —— 这是隔离的最后一道闸。 */
  const asset = findScopedAsset(db, b.assetId, scope);
  const single = !isMultiRole(role);
  if (single) s.assets = s.assets.filter((r) => r.role !== role);
  if (!s.assets.some((r) => r.assetId === b.assetId && r.role === role)) {
    s.assets.push({ assetId: b.assetId, role });
  }
  s.dirty = true;
  store.save();
  return { id: s.id, bound: asset.id };
}

function unbindAsset(db, id, assetId, scope) {
  const s = findScopedSb(db, id, scope);
  s.assets = s.assets.filter((r) => r.assetId !== assetId);
  s.dirty = true;
  store.save();
  return { id: s.id, removed: assetId };
}

/* ---------------- 提示词自动匹配参考图（v1：只按素材名称） ----------------
   匹配依据**只有素材名**，不做语义 / 向量匹配。三级强度，逐级放宽：
     name —— 提示词里出现素材全名（去扩展名后；含去分隔符的紧凑形）
     core —— 出现名称主干：剥掉「三视图 / 设定图 / 参考图 / 角色」等描述词与分隔符后的最长词块
     part —— 出现名称按分隔符切出的其余词块（长度 ≥ 2）
   role 由素材类型直接映射（本项目 type 与 role 同名）；character 可多绑，其余为单值。
   默认**只增补、不覆盖**：该 role 已有别的素材时记为 occupied，需 overwrite=true 才替换。 */

const NAME_NOISE = [
  '三视图', '设定图', '定妆照', '参考图', '示意图', '概念图', '人设图', '立绘', '素材图',
  '角色设定', '场景设定', '道具设定', '角色', '人物', '场景', '道具', '音频', '配音', '音效',
  '全身', '半身', '上半身', '正面', '侧面', '背面', '特写', '近景', '远景', '图片', '图像', '照片',
  '设定', '定妆', '素材', '图', '照', '片'
];
const NAME_SPLIT = /[_\-—–·、,，.。:：;；/\\|()[\]{}（）【】<>《》「」『』"'`\s]+/;
const MATCH_SCORE = { name: 300, core: 200, part: 100 };

/* 归一：全角→半角、转小写（提示词与素材名两侧都要过一遍） */
function normKey(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase();
}
const stripExt = (name) => String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '');

/* 粘连式去噪：名称与描述词粘连时（「林雪正面」「小狗三视图」）把描述词剥掉。
   尾部剥任意噪声词（剥完至少剩 2 字），头部只剥长度 ≥ 2 的词（避免「图/照/片」等单字误伤） */
function stripNoiseWords(s) {
  let x = s;
  for (let guard = 0; guard < 6; guard++) {
    const before = x;
    for (const w of NAME_NOISE) {
      const wl = w.length;
      if (x.length - wl >= 2 && x.endsWith(w)) { x = x.slice(0, x.length - wl); break; }
      if (wl >= 2 && x.length - wl >= 2 && x.startsWith(w)) { x = x.slice(wl); break; }
    }
    if (x === before) break;
  }
  return x;
}

/* 素材名 → 候选关键词
   core 取「去噪形」优先（剥掉描述词后剩下的才是名字本身），而非最长的分词块——
   否则「林雪正面」会拿整串去匹配，永远命中不了提示词里的「林雪」。
   group = 去噪形，用于「同一角色的多张素材只绑一张」的同名去重。 */
function nameKeys(name) {
  const full = stripExt(name).trim();
  const flat = full.replace(/[\s_\-—–·]+/g, '');
  const stripped = stripNoiseWords(flat);
  const chunks = full.split(NAME_SPLIT).map((x) => x.trim())
    .filter((c) => c.length >= 2 && !NAME_NOISE.includes(c.toLowerCase()));
  const longest = chunks.slice().sort((a, b) => b.length - a.length)[0] || null;
  let core;
  if (stripped && stripped.length >= 2 && stripped !== flat) core = stripped;   // 去噪形更短 → 更可能是名字
  else core = longest || (stripped && stripped.length >= 2 ? stripped : null);
  const parts = [];
  [stripped].concat(chunks).forEach((c) => {
    if (c && c.length >= 2 && c !== core && c !== full && c !== flat && !parts.includes(c)) parts.push(c);
  });
  return { full, flat, core, parts, group: (stripped && stripped.length >= 2 ? stripped : flat) || full };
}

/* 单素材 × 单提示词（均已归一）：返回命中方式或 null */
function matchByText(promptNorm, kw) {
  const cands = [kw.full, kw.flat].filter((c) => c && c.length >= 2);
  for (const c of cands) {
    if (promptNorm.includes(normKey(c))) return { via: 'name', keyword: c };
  }
  if (kw.core && kw.core.length >= 2 && promptNorm.includes(normKey(kw.core))) {
    return { via: 'core', keyword: kw.core };
  }
  const part = (kw.parts || []).find((c) => c.length >= 2 && promptNorm.includes(normKey(c)));
  if (part) return { via: 'part', keyword: part };
  return null;
}

/**
 * 自动匹配并（可选）绑定参考图。
 * body: { ids?: string[], apply?: boolean, overwrite?: boolean, onlyDraft?: boolean }
 * 不传 ids 时默认只扫「未提交(draft)」的分镜；apply 默认 false（只预览不写库）。
 */
function autoMatchAssets(db, b, scope) {
  const body = b || {};
  const apply = body.apply === true;
  const overwrite = body.overwrite === true;
  const dedupe = body.dedupe !== false;   // 默认开：同一角色（去噪后同名）的多张素材只绑一张
  const onlyDraft = body.onlyDraft !== false;
  const ids = Array.isArray(body.ids) ? body.ids : [];

  /* 作用域（指令 §40）：分镜池限定在**当前工作区**，候选素材限定在**当前项目**。
     自动匹配绝不能跨项目 —— 否则会拿别的项目的素材名去命中本项目的提示词。 */
  let pool = scopeStoryboards(db, scope);
  if (ids.length) pool = pool.filter((s) => ids.includes(s.id));
  else if (onlyDraft) pool = pool.filter((s) => s.status === 'draft');
  pool.sort((a, b2) => a.seq - b2.seq);

  const projectAssets = scopeAssets(db, scope);
  const rows = [];
  const stat = { storyboards: pool.length, bound: 0, kept: 0, occupied: 0, noMatch: 0, overLimit: 0, ambiguous: 0 };

  pool.forEach((s) => {
    const p = normKey(s.prompt);
    const hits = [];
    // ① 逐素材试匹配（只在本项目的素材里找）
    projectAssets.forEach((a) => {
      const k = nameKeys(a.name);
      const hit = matchByText(p, k);
      if (!hit) return;
      hits.push({
        assetId: a.id, name: a.name, type: a.type, role: a.type,
        via: hit.via, keyword: hit.keyword, group: k.group,
        _score: (MATCH_SCORE[hit.via] || 0) + hit.keyword.length
      });
    });

    // ② 按 role 收敛
    const byRole = {};
    hits.forEach((h) => { (byRole[h.role] = byRole[h.role] || []).push(h); });
    const won = [];
    const rivals = [];      // 同一 role 命中多个时，落选的候选（告知用户"为什么没选它"）
    const ambiguous = [];   // 同名同类型的多个素材：报歧义，不绑（指令 §41）
    Object.keys(byRole).forEach((role) => {
      let list = byRole[role].slice().sort((x, y) => (y._score - x._score) || (y.name.length - x.name.length));

      /* ⚠ 指令 §41：同一项目内「同名同类型」的多个素材**不得静默挑一个绑上**，必须报歧义。
         原来的 dedupe 会按分数悄悄留一个 —— 那正是 §41 要禁的行为。现在这类候选整体转入
         ambiguous：既不绑、也不假装成"落选"糊过去。
         同时仍放进 rivals，这样**未改动的旧前端**至少还能在「同类落选」里看到它们，
         不会出现"预览里凭空少了几项却没有任何说明"。 */
      const byGroup = {};
      list.forEach((m) => { (byGroup[m.group] = byGroup[m.group] || []).push(m); });
      const conflicted = new Set(Object.keys(byGroup).filter((g) => byGroup[g].length > 1));
      if (conflicted.size) {
        list.forEach((m) => { if (conflicted.has(m.group)) { ambiguous.push(m); rivals.push(m); } });
        list = list.filter((m) => !conflicted.has(m.group));
        if (!list.length) return;
      }

      if (dedupe) {
        const seen = {};
        list = list.filter((m) => (seen[m.group] ? false : (seen[m.group] = true)));
      }
      /* ⚠ 这里与 ROLE_MULTI **不一致**：prop 在 ROLE_MULTI 里也是多值（bindAsset 与下面
         第③④步都走 isMultiRole），但自动匹配这里只让 character 保留全部命中、prop 被压成一张。
         这是**既有行为**，改它会让道具素材的匹配结果明显变化（本库 15 个素材里 9 个是道具），
         属于需要单独验证的行为变更，故本次多项目升级刻意不动，只记在这里备查。 */
      if (role === 'character') { won.push.apply(won, list); return; }
      list.slice(1).forEach((m) => rivals.push(m));
      won.push(list[0]);
    });

    // ③ 与现有绑定比对
    const existing = s.assets || [];
    const toBind = [], kept = [], occupied = [];
    won.forEach((m) => {
      const same = existing.some((r) => r.assetId === m.assetId && r.role === m.role);
      if (same) { kept.push(m); return; }
      const other = existing.find((r) => r.role === m.role);
      if (other && !isMultiRole(m.role)) {
        const oa = findAsset(db, other.assetId) || { name: '(已删除素材)' };
        occupied.push({ role: m.role, currentAssetId: other.assetId, currentName: oa.name, want: m });
        if (overwrite) toBind.push(m);
        return;
      }
      toBind.push(m);
    });

    /* ④ 参考图配额校验（2026-09-19 新增）：自动匹配必须与「添加资产」共用同一套统计，
       只填**剩余名额**，不得绕过上限。
       口径与组装命令时完全一致 —— 当前已占图数取自 AL.imageCatalog（只算真有本地文件、
       真会作为 --image 发出的图），上限取自 models.imageLimitFor（系列规则表）。
       替换同 role 的已有绑定不新增名额（老的那张让位）；character 是多值槽位，永远算新增。 */
    const limit = models.imageLimitFor(s.model);
    let used = AL.imageCatalog(s, db).images.length;
    const allowed = [], overLimit = [];
    toBind.forEach((m) => {
      const a = findAsset(db, m.assetId);
      const replaces = !isMultiRole(m.role) && existing.some((r) => r.role === m.role);
      if (replaces || !AL.countsAsImage(db, a, m.role)) { allowed.push(m); return; }
      if (used + 1 > limit) { overLimit.push(m); return; }   // 名额用完：不绑，留给用户手工取舍
      used++;
      allowed.push(m);
    });

    if (apply && allowed.length) {
      allowed.forEach((m) => {
        if (!isMultiRole(m.role) && overwrite) s.assets = s.assets.filter((r) => r.role !== m.role);
        if (!s.assets.some((r) => r.assetId === m.assetId && r.role === m.role)) {
          s.assets.push({ assetId: m.assetId, role: m.role, via: m.via, matchedBy: m.keyword, autoAt: nowIso() });
        }
      });
      s.dirty = true;
    }
    stat.bound += allowed.length;
    stat.kept += kept.length;
    stat.occupied += occupied.length;
    stat.overLimit = (stat.overLimit || 0) + overLimit.length;
    stat.ambiguous += ambiguous.length;
    if (!won.length) stat.noMatch++;

    const strip = (m) => ({ assetId: m.assetId, name: m.name, type: m.type, role: m.role, via: m.via, keyword: m.keyword });
    rows.push({
      id: s.id, seq: s.seq, status: s.status, prompt: s.prompt,
      imageCount: used, imageLimit: limit,          // 预览里显示「将占 X / 上限 Y」
      toBind: allowed.map(strip),
      overLimit: overLimit.map(strip),               // 命中但名额不够，未绑定（前端单独列出并说明）
      kept: kept.map(strip),
      rivals: rivals.map(strip),
      /* 同名同类型的歧义候选（指令 §41）：既不绑、也不静默丢弃。
         新前端可以单独渲染「同名歧义，请手工确认」；旧前端会从 rivals 里看到它们。 */
      ambiguous: ambiguous.map(strip),
      occupied: occupied.map((o) => ({ role: o.role, currentAssetId: o.currentAssetId, currentName: o.currentName, want: strip(o.want) })),
      noMatch: won.length === 0
    });
  });

  if (apply) store.save();
  return {
    applied: apply, overwrite, scanned: pool.length,
    rows: rows.filter((r) => r.toBind.length || r.kept.length || r.occupied.length || r.rivals.length || r.ambiguous.length || r.noMatch),
    stats: stat
  };
}

/* ---------------- 按时长标注自动计算分镜时长 ----------------
   分镜稿的书写约定：段落头「段落1｜总时长：4.0s」，镜头行「镜1｜1.3s｜近景/…」。
   取值优先级：①「总时长」标注 → ② 各镜头秒数之和（标注缺失时的兜底）。
   取整：**一律向上进位**（Math.ceil）—— 分镜时长必须装得下整段内容，宁可多 1 秒；
   再按**该分镜模型的时长能力**钳制（models.clampDuration），钳制过的在结果里标 clamped 并给出提示。 */

const RE_TOTAL_DUR = /总\s*时长\s*[：:]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:s|秒|sec)?/i;
const RE_PLAIN_DUR = /时\s*长\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:s|秒|sec)?/i;
const RE_SHOT_DUR = /(?:^|\n)[ \t]*(?:镜\s*头?\s*\d+|shot\s*\d+)\s*[｜|:：]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:s|秒|sec)?/gi;

/** 解析提示词里的时长信息：{ declared, shots, shotsSum, base, seconds, source, mismatch } */
function parsePromptDuration(prompt) {
  const text = String(prompt == null ? '' : prompt);
  const mTotal = text.match(RE_TOTAL_DUR);
  const mPlain = mTotal ? null : text.match(RE_PLAIN_DUR);
  const shots = [];
  const re = new RegExp(RE_SHOT_DUR.source, 'gi');   // 每次新建，避免全局正则 lastIndex 串味
  let g;
  while ((g = re.exec(text))) shots.push(Number(g[1]));
  const shotsSum = shots.length ? Math.round(shots.reduce((a, b) => a + b, 0) * 1000) / 1000 : null;
  const declared = mTotal ? Number(mTotal[1]) : (mPlain ? Number(mPlain[1]) : null);
  const base = declared != null ? declared : shotsSum;
  if (base == null || !(base > 0)) {
    return { declared: null, shots: [], shotsSum: null, base: null, seconds: null, source: null, mismatch: false };
  }
  return {
    declared, shots, shotsSum, base,
    seconds: Math.ceil(base),                        // 向上进位
    source: declared != null ? 'declared' : 'shots',
    // 标注与镜头之和不等 —— 稿件自身矛盾，提示用户核对（我们以标注为准）
    mismatch: declared != null && shotsSum != null && Math.abs(declared - shotsSum) > 0.05
  };
}

/** 按标注把 durationSec 换算成合法值（上限取该分镜模型的时长能力） */
function durationFromPrompt(s, fallbackSec) {
  const p = parsePromptDuration(s.prompt);
  if (p.seconds == null) return { seconds: null, parsed: p };
  const capped = models.clampDuration(s.model, p.seconds);
  return { seconds: capped, parsed: p, clamped: p.seconds !== capped };
}

/**
 * 批量按提示词重算时长。
 * body: { ids?: string[], apply?: boolean, onlyDraft?: boolean }
 * apply 缺省 **true**（这是"自动匹配"的语义，可直接生效）；传 false 则只预览。
 */
function autoDuration(db, b, scope) {
  const body = b || {};
  const apply = body.apply !== false;
  const onlyDraft = body.onlyDraft !== false;
  const ids = Array.isArray(body.ids) ? body.ids : [];

  /* 只扫**当前工作区**的分镜（指令 §30）。原来扫全库，于是项目 A 的页面里
     会把项目 B 的分镜一起重算时长。 */
  let pool = scopeStoryboards(db, scope);
  if (ids.length) pool = pool.filter((s) => ids.includes(s.id));
  else if (onlyDraft) pool = pool.filter((s) => s.status === 'draft');
  pool.sort((a, b2) => a.seq - b2.seq);

  const rows = [];
  const stat = { storyboards: pool.length, changed: 0, same: 0, skipped: 0, noDuration: 0, clamped: 0, mismatch: 0 };
  let sumBefore = 0, sumAfter = 0, declaredSum = 0, declaredCeilSum = 0;

  pool.forEach((s) => {
    const parsed = parsePromptDuration(s.prompt);
    sumBefore += s.durationSec;
    const row = { id: s.id, seq: s.seq, status: s.status, prompt: s.prompt, from: s.durationSec, parsed };

    // 已完成/生成中：时长已锁定，不动
    if (!s.canEditDuration || s.status === 'succeeded' || s.status === 'generating') {
      row.action = 'skipped';
      row.reason = '已完成或生成中，时长已锁定';
      stat.skipped++; sumAfter += s.durationSec; rows.push(row); return;
    }
    if (parsed.seconds == null) {
      row.action = 'noDuration';
      row.reason = '提示词里既没有「总时长」标注，也没有可解析的镜头秒数';
      stat.noDuration++; sumAfter += s.durationSec; rows.push(row); return;
    }
    const target = models.clampDuration(s.model, parsed.seconds);
    row.target = target;
    row.clamped = target !== parsed.seconds;
    if (row.clamped) {
      const cap = models.capsFor(models.dreaminaModelOf(s.model) || s.model).duration;
      row.clampReason = '超出模型 ' + s.model + ' 的时长范围 ' + cap[0] + '–' + cap[1] + 's';
      stat.clamped++;
    }
    if (parsed.mismatch) stat.mismatch++;
    if (parsed.declared != null) {
      declaredSum += parsed.declared;
      declaredCeilSum += Math.ceil(parsed.declared);   // 各段分别向上进位后的合计（理论上应等于 sumAfter）
    }

    if (target === s.durationSec) { row.action = 'same'; stat.same++; sumAfter += s.durationSec; rows.push(row); return; }
    row.action = 'change';
    if (apply) { s.durationSec = target; s.dirty = true; }
    stat.changed++; sumAfter += target;
    rows.push(row);
  });

  if (apply && stat.changed) store.save();
  return {
    applied: apply,
    rows: rows.filter((r) => r.action === 'change' || r.action === 'noDuration' || r.action === 'skipped' || r.clamped || (r.parsed && r.parsed.mismatch)),
    stats: Object.assign(stat, {
      sumBefore, sumAfter,
      declaredSum: declaredSum ? Math.round(declaredSum * 100) / 100 : null,
      declaredCeilSum: declaredCeilSum || null,
      // 一致 = 设定之和 恰好等于「各段标注分别向上进位后的合计」。
      // 注：逐条进位必然使合计 ≥ 标注总时长（12.3s 分三段 4.1 → 15s），这是刻意的：
      // 进位只在单条级别发生一次，不会跨段累积漂移，保证每段都装得下自己的内容。
      consistent: declaredCeilSum ? sumAfter === declaredCeilSum : null
    })
  };
}

function importPreview(db, b, scope) {
  const segs = splitSegments(b.rawText, b.delimiter);
  /* 重复检测只在**本工作区**内比对（指令 §30）：原来扫全库，于是别的项目里
     用过的提示词会被报成 DUPLICATE，而它们其实毫无关系。 */
  const existing = scopeStoryboards(db, scope).map((s) => s.prompt);
  /* 预览里"实际会采用的时长"必须与 importConfirm 的落库值同源：都按**当前生效的默认模型**
     的能力区间钳。否则 seedance2.5 下标注 30s 会被预览误报成"超出 4–15"，
     而真正导入进去的是 30（2026-09-19 修复）。 */
  const model = effectiveDefaults(db, scope).model;
  const cap = models.capsFor(models.dreaminaModelOf(model) || model).duration;
  const warnings = [];
  const out = segs.map((text, i) => {
    const dup = existing.includes(text);
    const tooLong = text.length > 2000;
    if (dup) warnings.push({ code: 'DUPLICATE', index: i + 1, message: '与已有分镜内容重复' });
    if (tooLong) warnings.push({ code: 'TOO_LONG', index: i + 1, message: '超过 2000 字' });
    const pd = parsePromptDuration(text);
    if (pd.mismatch) warnings.push({ code: 'DURATION_MISMATCH', index: i + 1, message: '标注总时长 ' + pd.declared + 's 与镜头之和 ' + pd.shotsSum + 's 不一致（按标注 ' + pd.declared + 's 计）' });
    const applied = pd.seconds == null ? null : models.clampDuration(model, pd.seconds);
    if (applied != null && applied !== pd.seconds) {
      warnings.push({ code: 'DURATION_CLAMPED', index: i + 1, message: '标注时长进位后为 ' + pd.seconds + 's，超出模型 ' + model + ' 的 ' + cap[0] + '–' + cap[1] + 's，将按边界值取 ' + applied + 's' });
    }
    return {
      index: i + 1, text, charCount: text.length, duplicate: dup, tooLong,
      declaredTotal: pd.declared, shotSeconds: pd.shots, durationSec: applied   // 导入后实际会采用的时长
    };
  });
  return { total: out.length, delimiterEcho: b.delimiter, segments: out, warnings };
}

function importConfirm(db, b, scope) {
  const segs = splitSegments(b.rawText, b.delimiter);
  /* 默认值取**项目级生效值**（项目覆盖 ⊕ 全局默认），与 importPreview 同源 */
  const d = Object.assign({}, effectiveDefaults(db, scope), b.defaults || {});
  const top = b.insertPosition !== 'bottom';
  /* ⚠ 序号重排必须限定在本工作区（多项目升级）：原来 `db.storyboards.forEach(s => s.seq += n)`
     会把**所有项目**的分镜序号一起推高，别的页面凭空多出一段空号。 */
  const inScope = scopeStoryboards(db, scope);
  if (top) inScope.forEach((s) => { s.seq += segs.length; });
  let next = nextSeq(db, scope) + (top ? 0 : 0);
  const created = segs.map((text, i) => {
    const s = {
      id: rid('st_'), projectId: scope.projectId, workspaceId: scope.workspaceId,
      batchId: b.batchId || 'bt_21',
      seq: top ? (i + 1) : next++,
      prompt: text, negativePrompt: d.negativePrompt || '',
      // 时长优先取提示词里的「总时长」标注（向上进位），没有标注才回落到默认值
      durationSec: (function () {
        const byPrompt = parsePromptDuration(text).seconds;
        return models.clampDuration(d.model, byPrompt != null ? byPrompt : Math.round(Number(d.durationSec)));
      })(),
      model: d.model, ratio: d.ratio, resolution: d.resolution, seed: 'random',
      motion: d.motion, status: 'draft', progress: 0, etaSeconds: null, remoteId: null,
      videoUrl: null, coverUrl: null, currentFrameUrl: null, elapsedMs: null,
      retryCount: 0, errorCode: null, errorMessage: null, canEditDuration: true,
      assets: [], createdAt: nowIso(), startedAt: null, finishedAt: null, dirty: true
    };
    db.storyboards.push(s);
    return { id: s.id, seq: s.seq, status: s.status, prompt: s.prompt };
  });
  renumber(db, scope);
  store.save();
  return { created, createdCount: created.length, batchId: b.batchId || 'bt_21', skipped: [] };
}

/* 生效设置 = **项目覆盖 ⊕ 全局默认**（指令 §15.3 的兼容策略，不一次大拆）。
   分层口径（指令 §15.1/§15.2）：
     · delimiter / defaults —— **项目级**创作默认值，可被 project.settings 覆盖；
     · queue（Worker 总并发）与 adapter（CLI 登录态）—— **系统级**，不复制到每个项目。
   返回的是**合并后的生效值**，所以未改动的前端读到的东西与升级前完全一样。 */
function getSettings(db, scope) {
  const eff = scope ? effectiveDefaults(db, scope) : (db.settings.defaults || {});
  const del = scope ? effectiveDelimiter(db, scope) : (db.settings.delimiter || {});
  const out = {
    delimiter: JSON.parse(JSON.stringify(del)),
    defaults: JSON.parse(JSON.stringify(eff)),
    queue: JSON.parse(JSON.stringify(db.settings.queue || {})),
    adapter: JSON.parse(JSON.stringify(db.settings.adapter || {}))
  };
  if (scope && scope.project) {
    out.project = { id: scope.project.id, name: scope.project.name };
    /* 哪些项是项目自己的覆盖（其余继承全局）。前端可据此提示"已覆盖 / 继承全局" */
    out.overridden = Object.keys((scope.project.settings && scope.project.settings.defaults) || {});
  }
  return out;
}

/* ---------------- 默认值变更 → 同步到已有分镜 ----------------
   为什么需要（2026-09-19 用户要求）：分镜在**导入那一刻**把默认模型/画幅/分辨率快照到自己身上，
   之后不跟随默认值。于是出现"我把默认改成 Fast VIP，可提交出去在即梦里还是 VIP"
   （实测踩到：16 条分镜在默认是 seedance2.0_vip 时导入，两小时后改默认，提交仍用旧模型）。

   同步范围：**模型 / 画幅 / 分辨率**三项。
   刻意**不同步时长** —— 时长是逐条按提示词的「总时长」标注算出来并可能手工调过的，
   不该被一个全局默认值覆盖（用户明确要求）。
   generating 的分镜跳过：它的 CLI 任务已经拿旧参数开跑，改字段只会让界面与实际执行对不上。

   ⚠ 触发时机是「保存设置即对齐」，**不是**只在默认值发生变化时：
   若只在变化时同步，"默认已经是 Fast VIP、但分镜还是 VIP"这种存量不一致就永远修不好
   （用户当前正是这个状态 —— 保存一次也不会动）。对齐语义也更符合直觉：
   设置面板上写的就是所有分镜将采用的参数。
   实测无害：模型/画幅/分辨率**没有任何逐条修改的界面入口**，所以不存在"被误伤的手工偏离"。

   ⚠ 多项目升级：同步范围**限定在当前项目**（指令 §30）。原来遍历全库，
   于是改项目 A 的默认值会把项目 B 的分镜参数一起改掉 —— 典型的跨项目串线。

   返回摘要供接口回传、前端提示；一条都没动时返回 null（不产生任何写入）。 */
const SYNC_FIELDS = [
  { key: 'model', label: '模型' },
  { key: 'ratio', label: '画幅' },
  { key: 'resolution', label: '分辨率' }
];

function syncDefaultsToStoryboards(db, before, after, scope) {
  let updated = 0, skippedGenerating = 0;
  /* scope 给定时只同步该工作区的分镜；未给定时保持旧的全局行为（供兼容路径调用） */
  const list = scope ? scopeStoryboards(db, scope) : db.storyboards;
  list.forEach((sb) => {
    if (sb.status === 'generating') { skippedGenerating++; return; }
    let touched = false;
    SYNC_FIELDS.forEach((f) => { if (after[f.key] != null && sb[f.key] !== after[f.key]) { sb[f.key] = after[f.key]; touched = true; } });
    if (touched) { sb.dirty = true; updated++; }
  });
  if (!updated) return null;
  return {
    // 默认值本次是否真的变了（用于把提示语说得更准确）；没变就只有条数有意义
    fields: SYNC_FIELDS.filter((f) => before[f.key] !== after[f.key])
      .map((f) => ({ field: f.key, label: f.label, from: before[f.key], to: after[f.key] })),
    defaults: SYNC_FIELDS.map((f) => ({ field: f.key, label: f.label, value: after[f.key] })),
    updated, skippedGenerating
  };
}

/* PUT /settings 允许写入的顶层键**白名单**。
   ⚠ 原实现是 `db.settings = Object.assign({}, db.settings, s, {adapter})` ——
   请求体里**任何**顶层键都会原样落进库，没有白名单。单项目时危害有限，
   多项目之后这就成了隔离漏洞：一个 `{"projects":[…]}` 或 `{"workspaces":[…]}` 就能直接改写
   项目集合本身。白名单之外的键一律丢弃，并在响应里如实回报被忽略的键。 */
const WRITABLE_SETTINGS = ['delimiter', 'defaults', 'queue'];

async function putSettings(db, s, adapter, scope) {
  const body = s || {};
  if (!scope || !scope.project) throw new ApiError(ERR.NOTFOUND, '保存设置需要项目上下文');
  const project = scope.project;
  const ignored = Object.keys(body).filter((k) => !WRITABLE_SETTINGS.includes(k));

  const prevDefaults = Object.assign({}, effectiveDefaults(db, scope));   // 同步前快照：用来判断"哪些项真的变了"

  // 并发上限（queue 是系统级）：仅当配置了本地保护上限（concMax>0）时校验
  let concMax = 0;
  try { concMax = (await adapter.resolveMaxConcurrency()).max; } catch (e) { /* 解析失败按不限制处理 */ }
  if (body.queue && (body.queue.concurrency < 1 || (concMax > 0 && body.queue.concurrency > concMax))) {
    throw new ApiError(ERR.PARAM, '参数校验失败', {
      fields: [{
        path: 'queue.concurrency',
        message: concMax > 0 ? '范围为 1–' + concMax + '（本地保护上限，可在 server/config.json 调整或设为 0 关闭）' : '须为不小于 1 的整数'
      }]
    });
  }
  if (body.delimiter && body.delimiter.type === 'custom' && !body.delimiter.value) {
    throw new ApiError(ERR.PARAM, '参数校验失败', { fields: [{ path: 'delimiter.value', message: '自定义分隔符不能为空' }] });
  }

  /* 默认值须落在「当前默认模型」的能力范围内：大小写差异（720P / 720p）先归一，
     模型不支持的值按就近档位调整——调整项随响应返回（前端明确提示，不静默改）。
     能力表来自 models.js（唯一事实来源）；原实现调画布 CLI 的 model list，已随画布 CLI 移除。 */
  const adjustments = [];
  /* ⚠ 逐键合并，不能整体替换（2026-09-19 既有缺陷，本次一并修）：
     原实现把整个 defaults 子对象覆盖过去，于是"只带 model 的 PUT"会把
     resolution/ratio/durationSec/motion/negativePrompt 全部丢掉（queue 同理，
     autoRetry/maxRetry 变 undefined，worker 的自动重试静默失效）。 */
  const nextDefaults = Object.assign({}, effectiveDefaults(db, scope));
  if (body.defaults) {
    Object.keys(body.defaults).forEach((k) => { if (body.defaults[k] !== undefined) nextDefaults[k] = body.defaults[k]; });
  }
  {
    const incoming = nextDefaults;
    const dmName = models.dreaminaModelOf(incoming.model);
    if (dmName) {
      const caps = models.capsFor(dmName);
      const resList = caps.resolutions;
      const ratioList = models.DREAMINA_RATIOS;
      const durRange = { min: caps.duration[0], max: caps.duration[1] };
      if (resList.length) {
        const hit = resList.find((v) => String(v).toLowerCase() === String(incoming.resolution).toLowerCase());
        const pick = hit || resList.reduce((b, v) =>
          (Math.abs(resTier(v) - resTier(incoming.resolution)) < Math.abs(resTier(b) - resTier(incoming.resolution)) ? v : b), resList[0]);
        if (pick !== incoming.resolution) {
          adjustments.push('分辨率 ' + incoming.resolution + ' → ' + pick + '（模型 ' + incoming.model + ' 支持 ' + resList.join(' / ') + '）');
          nextDefaults.resolution = pick;
        }
      }
      if (ratioList.length && !ratioList.includes(incoming.ratio)) {
        adjustments.push('画幅 ' + incoming.ratio + ' → ' + ratioList[0] + '（模型 ' + incoming.model + ' 支持 ' + ratioList.join(' / ') + '）');
        nextDefaults.ratio = ratioList[0];
      }
      if (durRange) {
        const d = Number(incoming.durationSec);
        const clamped = Math.max(durRange.min, Math.min(durRange.max, d));
        if (clamped !== d) {
          adjustments.push('时长 ' + d + 's → ' + clamped + 's（模型 ' + incoming.model + ' 支持 ' + durRange.min + '–' + durRange.max + 's）');
          nextDefaults.durationSec = clamped;
        }
      }
    }
  }

  /* 落库：delimiter / defaults 写**项目级**覆盖；queue 写**系统级**（§15.1）。
     adapter 保持只读，前端回传的旧字段一律不采纳。 */
  project.settings = Object.assign({}, project.settings || {});
  project.settings.defaults = nextDefaults;
  if (body.delimiter) project.settings.delimiter = Object.assign({}, project.settings.delimiter || {}, body.delimiter);
  if (body.queue) db.settings.queue = Object.assign({}, db.settings.queue || {}, body.queue);
  project.updatedAt = nowIso();

  /* 默认值变了就同步到**本项目**的已有分镜（模型 / 画幅 / 分辨率；时长不同步） */
  const synced = syncDefaultsToStoryboards(db, prevDefaults, nextDefaults, scope);
  store.save();
  const out = getSettings(db, scope);
  if (ignored.length) {
    /* 如实回报被丢弃的键 —— 静默忽略会让调用方以为写进去了 */
    out.ignored = ignored;
    store.pushLog('system', 'warn', '保存设置时忽略了不可写的键：' + ignored.join('、') + '（允许的键：' + WRITABLE_SETTINGS.join('、') + '）');
  }
  if (adjustments.length) {
    adjustments.forEach((a) => store.pushLog('system', 'info', '默认参数已按模型规格调整：' + a));
    out.adjustments = adjustments;
  }
  if (synced) {
    store.pushLog('system', 'info', '默认值变更已同步到项目「' + project.name + '」的 ' + synced.updated + ' 条分镜：' +
      synced.fields.map((f) => f.label + ' ' + f.from + ' → ' + f.to).join('；') +
      (synced.skippedGenerating ? '（' + synced.skippedGenerating + ' 条生成中已跳过）' : ''));
    out.synced = synced;
  }
  return out;
}

function deleteAsset(db, id, scope) {
  /* 只能删本项目的素材（指令 §29）。跨项目删除必须拒绝。 */
  const a = findScopedAsset(db, id, scope);
  db.assets = db.assets.filter((x) => x.id !== id);
  /* 解绑引用。⚠ 只遍历**本项目**的分镜即可 —— 跨项目绑定在 bindAsset 处已被拒绝，
     所以其它项目不可能引用这个素材。这里仍按工作区收敛一次，避免"万一"改写别处数据。 */
  scopeStoryboards(db, scope).forEach((s) => { s.assets = (s.assets || []).filter((r) => r.assetId !== id); });
  // 删除本地文件（url 形如 /media/assets/as_xxx.png）
  const file = PATHS.assetFileOf(a);
  if (file) { try { fs.unlinkSync(file); } catch (e) { /* 文件可能已不存在 */ } }
  store.save();
  return { deleted: id };
}

/* 素材设置：更新（名称 / 文生图提示词；两者至少传一项，只更新传了的部分）
   —— prompt 用于素材详情弹窗的提示词编辑：先有提示词占位资产，图后补 */
function updateAsset(db, id, body, scope) {
  const a = findScopedAsset(db, id, scope);
  body = body || {};
  const hasName = body.name !== undefined;
  const hasPrompt = body.prompt !== undefined;
  if (!hasName && !hasPrompt) throw new ApiError(ERR.PARAM, '至少提供 name 或 prompt 之一');
  if (hasName) {
    const name = String(body.name || '').trim();
    if (!name) throw new ApiError(ERR.PARAM, '素材名称不能为空');
    if (name.length > 60) throw new ApiError(ERR.PARAM, '素材名称不能超过 60 个字符');
    a.name = name;
  }
  if (hasPrompt) {
    const prompt = String(body.prompt || '').trim();
    if (prompt.length > 10000) throw new ApiError(ERR.PARAM, '提示词不能超过 10000 字符');
    a.prompt = prompt;
  }
  a.updatedAt = nowIso();
  store.save();
  return viewAsset(a);
}

/* 素材设置：更换文件（保留素材 id 与全部分镜绑定，只替换磁盘文件与访问地址）
   —— name 显式传入优先；否则沿用既有约定：取新文件名去扩展名 */
function replaceAsset(db, id, opts, scope) {
  const a = findScopedAsset(db, id, scope);
  const kind = ASSET_TYPE_KIND[a.type];
  const filename = String(opts.filename || '');
  if (!filename) throw new ApiError(ERR.PARAM, '缺少文件名');
  const ext = (filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!ASSET_EXT[kind].includes(ext)) {
    throw new ApiError(ERR.PARAM, kind === 'audio'
      ? '音频素材仅支持 ' + ASSET_EXT.audio.join(' / ')
      : '图片素材仅支持 ' + ASSET_EXT.image.join(' / '));
  }
  const buf = opts.buffer;
  if (!buf || !buf.length) throw new ApiError(ERR.PARAM, '文件内容为空');
  /* 文件名 = 素材id + 替换时刻（36进制时间戳）+ 扩展名。
     必须让 url 每次替换都变化：若沿用固定文件名（旧实现 a.id + ext），
     浏览器会命中 <img> 缓存继续显示旧图 —— 表现为"替换后图片没变"。 */
  const fname = a.id + '-' + Date.now().toString(36) + ext;
  /* 换文件也落在**本项目自己的目录**里（与 createAsset 同源）。
     项目 id 取素材记录上的 projectId —— 调用方已用 findScopedAsset 校验过它属于当前项目。 */
  PATHS.ensureProjectDirs(a.projectId);
  const oldFile = PATHS.assetFileOf(a);
  fs.writeFileSync(path.join(PATHS.assetDir(a.projectId), fname), buf);
  if (oldFile && oldFile !== path.join(PATHS.assetDir(a.projectId), fname)) {
    try { fs.unlinkSync(oldFile); } catch (e) { /* 旧文件可能已不存在 */ }
  }
  a.url = PATHS.assetUrl(a.projectId, fname);
  a.thumbUrl = kind === 'audio' ? null : a.url;
  a.size = buf.length;
  a.updatedAt = nowIso();
  const name = String(opts.name || '').trim();
  a.name = name || filename.replace(/\.[^.]+$/, '').trim() || a.name;
  store.save();
  return viewAsset(a);
}

/* ---------------- 提示词文本导入资产（先解析归类，再按类型落库） ----------------
   格式约定（与 _asset_prompts_out.txt 一致）：每段提示词之间以「单独一行的 @」分隔。
   类型识别：段内首部关键词 —— 角色描述信息 / 场景描述内容 / 道具描述内容；
   名称提取：紧跟「…描述内容/信息如下：」后的词块（场景/道具取首个「｜」前的名称）；
   角色群像段没有单一名称，改取所有【姓名】拼接。
   apply=false 只解析预览；apply=true 按识别类型逐条创建素材（无图片文件，
   url 为空 → 前端显示渐变占位，图后补，详情弹窗可继续编辑）。 */

const PROMPT_TYPE_RULES = [
  { type: 'prop',      re: /道具描述|道具设定|根据道具/ },
  { type: 'scene',     re: /场景描述|场景设定|按照下方场景|按照以下场景/ },
  { type: 'character', re: /角色描述信息|角色设定参考图|角色序列|【姓名】|人设描述/ }
];

function splitPromptSegments(rawText) {
  // 以「单独一行的 @」为分段依据；行首尾空白容忍，@ 允许连续多个
  const lines = String(rawText || '').split(/\r\n|\r|\n/);
  const segs = [];
  let cur = [];
  for (const line of lines) {
    if (/^\s*@+\s*$/.test(line)) { segs.push(cur); cur = []; }
    else cur.push(line);
  }
  segs.push(cur);
  return segs.map((ls) => ls.join('\n').trim()).filter((s) => s.length > 0);
}

function guessPromptAssetName(type, seg) {
  if (type === 'character') {
    const m = seg.match(/角色描述信息如下[：:]\s*([^\n]+)/);
    if (m) return m[1].trim().slice(0, 60);
    const names = [];
    for (const mm of seg.matchAll(/【姓名】[：:]\s*([^\n【]+)/g)) {
      const n = mm[1].trim();
      if (n && !names.includes(n)) names.push(n);
    }
    if (names.length) return names.join('、').slice(0, 60);
    return '角色群像';
  }
  const label = type === 'scene' ? '场景描述内容' : '道具描述内容';
  const m = seg.match(new RegExp(label + '如下[：:]\\s*([^\\n]+)'));
  if (!m) return null;
  const head = m[1].split('｜')[0].trim();          // 「公寓餐厨起居区｜居家室内场景｜…」取首段
  return head ? head.slice(0, 60) : null;
}

function parseAssetPromptSegments(rawText) {
  const segs = splitPromptSegments(rawText);
  const items = [];
  const skipped = [];
  segs.forEach((seg, i) => {
    const rule = PROMPT_TYPE_RULES.find((r) => r.re.test(seg));
    if (!rule) {
      skipped.push({ index: i + 1, reason: '未识别出资产类型（段首缺少 角色/场景/道具 描述标识）', preview: seg.slice(0, 60) });
      return;
    }
    const name = guessPromptAssetName(rule.type, seg) || (rule.type === 'scene' ? '未命名场景' : '未命名道具');
    items.push({ index: i + 1, type: rule.type, name, prompt: seg, chars: seg.length });
  });
  return { items, skipped, total: segs.length };
}

/* 素材去重键：类型 + 名称（首尾空格忽略、大小写不敏感）——
   与前端图片导入的名称匹配规则一致，两处判定同一个"这是同一条素材"。 */
function assetKey(type, name) { return String(type) + '\u0000' + String(name == null ? '' : name).trim().toLowerCase(); }

function importAssetPrompts(db, b, scope) {
  const rawText = String((b && b.rawText) || '');
  if (!rawText.trim()) throw new ApiError(ERR.PARAM, '提示词文本为空');
  const parsed = parseAssetPromptSegments(rawText);
  /* 去重：库里已有同「类型 + 名称」的视为重复，同一批里重复出现的段也只留第一段。
     不去重的话，把同一段提示词再粘一次就会整套复制一遍同名素材（2026-09-19 实测：
     重复导入一次，场景 / 道具各多出一份，库里从 27 条堆到 40 条）。
     ⚠ 只在本**项目**的素材里判重（指令 §29）—— 别的项目有同名素材不算重复。 */
  const known = new Map();                       // key -> 库中已存在的 asset.id；null = 本批内前面已出现
  scopeAssets(db, scope).forEach((a) => {
    const k = assetKey(a.type, a.name);
    if (!known.has(k)) known.set(k, a.id);
  });
  const items = [];
  const duplicates = [];
  parsed.items.forEach((it) => {
    const k = assetKey(it.type, it.name);
    if (known.has(k)) {
      const existingId = known.get(k);
      duplicates.push({
        index: it.index, type: it.type, name: it.name, existingId,
        source: existingId === null ? 'batch' : 'library'    // 同批重复 / 库里已有
      });
      return;
    }
    known.set(k, null);                          // 占位：本批后续同名的也按重复处理
    items.push(it);
  });
  const base = { items, skipped: parsed.skipped, duplicates, total: parsed.total };
  const apply = !!(b && b.apply);
  if (!apply) return Object.assign(base, { created: [], applied: false });
  if (!items.length) return Object.assign(base, { created: [], applied: true });
  const TYPE_LABEL = { character: '角色', scene: '场景', prop: '道具' };
  const created = [];
  for (const it of items) {
    const id = rid('as_');
    const asset = {
      id, projectId: scope.projectId, name: it.name, type: it.type, prompt: it.prompt,
      url: null, thumbUrl: null,                  // 提示词资产：先占位，图后补（详情弹窗可上传）
      width: 0, height: 0, size: 0, tags: [],
      createdAt: nowIso(), updatedAt: null,
      gradSeedKey: id, origin: 'prompt'
    };
    db.assets.push(asset);
    created.push({ id, type: it.type, typeLabel: TYPE_LABEL[it.type], name: it.name, chars: it.chars });
  }
  store.save();
  return Object.assign(base, { created, applied: true });
}

/* 恢复默认。分层口径同 getSettings：
   delimiter / defaults 属于**项目**，恢复默认 = **清掉项目覆盖**，于是自动回落到全局默认值
   （而不是把项目值写成硬编码常量 —— 那样"恢复默认"会把项目钉死在当前内置值上，
   之后改全局默认也带不动它）。queue 是系统级，直接复位为内置默认。 */
function resetSettings(db, b, scope) {
  const scopes = (b && b.scopes) || ['delimiter', 'defaults', 'queue'];
  const project = scope ? scope.project : null;
  if (project) {
    project.settings = Object.assign({}, project.settings || {});
    if (scopes.includes('delimiter')) delete project.settings.delimiter;   // 清覆盖 → 回落全局
    if (scopes.includes('defaults')) delete project.settings.defaults;
    project.updatedAt = nowIso();
  }
  if (scopes.includes('queue')) db.settings.queue = DEFAULT_SETTINGS().queue;
  store.save();
  return getSettings(db, scope);
}

/* 从实时模型规格里提取某个 flag 的值域（如 --ratio / --resolution） */
/* 分辨率档位权重（用于排序与「就近匹配」；不同模型大小写不同，故按小写归并） */
function resTier(v) {
  const k = String(v || '').toLowerCase();
  return ({ '480p': 480, '720p': 720, '768p': 768, '1080p': 1080, '2k': 1440, '4k': 2160 })[k] || 9999;
}

/* 逐模型规格：分辨率 / 画幅 / 时长区间（来源：实时目录每个 mode 的 flags） */
function modelSpecs(items) {
  const out = {};
  (items || []).forEach((m) => {
    const res = [], ratios = [];
    let dur = null;
    (m.modes || []).forEach((mo) => (mo.flags || []).forEach((f) => {
      if (f.flag === '--resolution' && Array.isArray(f.values)) {
        f.values.forEach((v) => { if (!res.some((x) => String(x).toLowerCase() === String(v).toLowerCase())) res.push(v); });
      }
      if (f.flag === '--ratio' && Array.isArray(f.values)) {
        f.values.forEach((v) => { if (!ratios.includes(v)) ratios.push(v); });
      }
      if (f.flag === '--duration' && f.min != null) {
        // 同一模型多个 mode 的时长区间取并集（宽松），提交时仍会按 mode 校验
        dur = dur
          ? { min: Math.min(dur.min, f.min), max: Math.max(dur.max, f.max), step: dur.step || f.step || 1 }
          : { min: f.min, max: f.max, step: f.step || 1 };
      }
    }));
    out[m.model] = { resolutions: res.sort((a, b) => resTier(a) - resTier(b)), ratios, duration: dur };
  });
  return out;
}

/* 大小写不敏感去重（保留首次出现的大小写），并按档位权重排序 */
function dedupeLevels(list) {
  const seen = new Set(), out = [];
  (list || []).forEach((v) => {
    const k = String(v).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k); out.push(v);
  });
  return out.sort((a, b) => resTier(a) - resTier(b));
}

/* ---------------- meta/options：静态 ∪ 实时模型目录 ∪ 动态并发上限 ---------------- */
async function getOptions(db, adapter, scope) {
  const meta = JSON.parse(JSON.stringify(META));
  // 服务级干跑模式（JC_DRY_RUN=1 / 配置文件 dryRun）：前端据此常驻提示「本服务不会真正派发」
  meta.dryRun = loadConfig().dryRun === true;
  try {
    const conc = await adapter.resolveMaxConcurrency();
    // 并发上限：不再按账号档位假设（即梦侧无公开上限）；max=0 表示不限制，
    // 仅在配置了本地保护上限（>0）时才下发具体数值
    meta.settings.concurrency = {
      min: 1,
      max: conc.max,
      defaultValue: conc.max > 0 ? Math.min(META.settings.concurrency.defaultValue, conc.max) : META.settings.concurrency.defaultValue
    };
    meta.settings.concurrencySource = conc.source;
  } catch (e) { /* 解析失败 → 静态兜底 */ }
  /* 模型列表：**唯一来源 = 模型注册表**（= 创作 CLI 支持集）。
     原实现这里读画布 CLI 的 `model list` 作为实时目录，画布 CLI 移除后该来源消失；
     而创作 CLI 没有"列出可用模型"的子命令，其支持集记录在 models.js（取自官方 -h 输出）。
     创作 CLI 的可用性（读探测缓存，不额外起进程）决定这些模型是否可选。 */
  let dreaminaOk = true;
  /* 不可用原因：优先用探测给出的原文（能区分"未安装/未登录/调用被拒/探测超时"），
     并把"这是临时状态"讲明白 —— 用户不该因为一次瞬时探测失败去改自己的默认模型。 */
  let dreaminaOff = '创作 CLI 未就绪（未安装或未登录）';
  try {
    const D = adapter.dreamina;
    const dp = D && typeof D.peek === 'function' ? D.peek() : null;
    if (dp) {
      dreaminaOk = !!dp.available;
      if (!dreaminaOk) {
        const det = dp.message ? String(dp.message).slice(0, 120) : '';
        dreaminaOff = '创作 CLI 当前不可用' + (det ? '（' + det + '）' : '') + '　—— 多为临时状态，恢复后自动可选';
      }
    }
  } catch (e) { /* 未知则不禁用 */ }

  meta.models = models.DREAMINA_VIDEO_MODELS.map((value) => {
    const caps = models.capsFor(value);
    const m = {
      value,
      label: models.labelOf(value),
      enabled: dreaminaOk,
      engines: models.enginesFor(value),
      group: models.groupOf(value),
      // 各模型自己的规格：前端据此动态过滤分辨率/画幅/时长下拉
      resolutions: caps.resolutions.slice(),
      ratios: models.DREAMINA_RATIOS.slice(),
      duration: { min: caps.duration[0], max: caps.duration[1], step: 1 },
      capsNote: caps.note
    };
    if (!dreaminaOk) m.disabledReason = dreaminaOff;
    return m;
  });
  const allRes = [];
  meta.models.forEach((m) => m.resolutions.forEach((v) => allRes.push(v)));
  if (allRes.length) meta.resolutions = dedupeLevels(allRes).map((v) => ({ value: v, label: v }));
  meta.ratios = models.DREAMINA_RATIOS.map((v) => ({ value: v, label: v }));
  // 积分余额提醒阈值（前端在提交前据此做二次确认；与 worker 派发前的提醒同源）
  meta.creditWarnBelow = loadConfig().creditWarnBelow;

  /* ---------------- 默认值：读**项目级生效值**，并只做"读时归一" ----------------
     ⚠ 这里**不再改写数据库**（2026-09-19 多项目升级的清理）。
     原实现借这个 GET 请求把 settings.defaults、**所有分镜的 model**、**所有 cliJobs 的
     cliModel** 一起改写并 store.save() —— 也就是说"迁移"藏在一个只读接口里，
     靠用户打开页面才触发、而且每次刷新都可能重跑，两个并发请求还会互相交错。
     现在这些一次性改写全部搬到 schema.js 的版本化迁移里（跑一次、可校验、幂等）。

     这里只保留"读时归一"：把历史模型名换成等价名**仅用于展示**，不写库。
     铁律不变（2026-09-18 的教训）：只有「名字确实跑不了」才提示用户需要改；
     「名字有效、只是当前探测不可用」必须原样保留 —— 否则探测瞬时失败时，
     用户设的 seedance2.0fast 会被误报成需要更换。 */
  const avail = meta.models.filter((m) => m.enabled !== false).map((m) => m.value);
  const runnable = (v) => !!v && models.dreaminaModelOf(v) != null;
  /* 展示用默认值：项目覆盖 ⊕ 全局默认（只读拷贝，不回写） */
  const d = Object.assign({}, effectiveDefaults(db, scope));
  let defaultsNotice = null;

  if (d.model) {
    const canonName = models.isLegacyName(d.model) ? models.dreaminaModelOf(d.model) : d.model;
    if (canonName !== d.model) {
      defaultsNotice = {
        model: canonName, reason: 'legacy', from: d.model,
        message: '默认模型「' + d.model + '」是画布 CLI 时代的旧名字，已按创作 CLI 的等价型号显示为「' + models.labelOf(canonName) + '」（同一个底层模型，无需重新选择）'
      };
      d.model = canonName;
    }
  }
  /* 名字确实跑不了（创作 CLI 无对应型号）→ 提示需要改选。**不写库**。 */
  if (avail.length && d.model && !runnable(d.model)) {
    const alt = avail[0];
    if (alt && alt !== d.model) {
      defaultsNotice = {
        model: alt, reason: 'invalid', from: d.model,
        message: '默认模型「' + d.model + '」已随画布 CLI 一并下线（创作 CLI 无对应型号），建议改选「' + models.labelOf(alt) + '」'
      };
    }
  }
  /* 名字有效但当前被禁用 → 保留用户的选择，只做标记 */
  if (!defaultsNotice && d.model) {
    const dEntry = meta.models.find((m) => m.value === d.model);
    if (dEntry && dEntry.enabled === false) {
      defaultsNotice = { model: d.model, reason: 'unavailable', message: dEntry.disabledReason || dreaminaOff };
    }
  }
  meta.defaultsNotice = defaultsNotice;

  /* 分辨率 / 画幅的大小写归一也只在返回值上做（例如历史值 720P → 720p） */
  const pickCi = (list, cur) => (list || []).find((x) => String(x.value).toLowerCase() === String(cur).toLowerCase());
  const rMatch = pickCi(meta.resolutions, d.resolution);
  if (rMatch && rMatch.value !== d.resolution) d.resolution = rMatch.value;
  const aMatch = pickCi(meta.ratios, d.ratio);
  if (aMatch && aMatch.value !== d.ratio) d.ratio = aMatch.value;

  /* 下发给前端的默认值 —— 与 /settings 同源，都是"项目生效值" */
  meta.defaults = d;

  /* 项目上下文：项目名不再取自模块级常量 META.projectName（原来硬编码 '雨夜归途'），
     而是请求作用域解析出来的真实项目。作用域缺失时（理论上不会）退回空名。 */
  meta.projectName = scope && scope.project ? scope.project.name : '';
  meta.project = scope && scope.project
    ? { id: scope.project.id, name: scope.project.name }
    : null;
  meta.workspace = scope && scope.workspace
    ? { id: scope.workspace.id, name: scope.workspace.name }
    : null;
  return meta;
}

/* 带上限的等待：到期返回 fallback。
   只用于「冷启动首次探测」这一种确实必须等待的场景 —— 单次创作 CLI 探测实测 8.4–9.5 秒，
   绝不能让它在请求路径上无限期地拖住响应。 */
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), guard])
    .finally(() => { if (timer) clearTimeout(timer); });
}

async function adapterStatus(db, adapter, fast) {
  const D = adapter.dreamina;
  const waitMs = loadConfig().adapterFastWaitMs || 2500;

  /* fast 模式（stale-while-revalidate）：**这条路径上绝不允许 await 真实探测**。
     2026-09-18 性能排查（实测数据）：原来是
       「有缓存就回缓存，缓存过期就 await D.probe()」，
     而创作 CLI 的探测缓存 TTL 是 60s、单次 user_credit 要 8.4–9.5 秒 ——
     于是「每 60 秒必有一次 /system/adapter 要等约 9 秒」，前端 openSettings() 又把这个耗时
     1:1 变成"点击设置后 11 秒才弹出"（实测：缓存新鲜 117ms ↔ 过期 10981ms）。
     现在的规则：
       · 有新鲜缓存        → 直接用；
       · 只有陈旧值        → 立即返回陈旧值（stale:true，creditAt 保留），刷新丢后台；
       · 从未探测过(冷启动) → 允许等，但上限 waitMs，超时用"读取中"占位返回。
     探测侧已有防重入，所以这里的后台刷新不会叠加成多个并发 CLI 进程。 */
  /* peek() 按 TTL 返回（过期 null）；lastProbe() 是"最后已知值"，供 fast 路径兜底。
     不能用 `D.peek() || D.probe(true)` —— 那会被"永远为真"的旧缓存短路，
     导致积分永不刷新（2026-09-18 的 bug，后端显示 105 / 实际 73）。 */
  const cachedDreamina = (D && typeof D.peek === 'function') ? D.peek() : null;
  const lastDreamina = (D && typeof D.lastProbe === 'function') ? D.lastProbe() : null;

  let dp = cachedDreamina;
  let freshDp = cachedDreamina;   // **仅新鲜值**：授权链接清理只信它（见下方守卫）
  let dreaminaProbing = false;

  if (fast) {
    if (D) {
      if (dp) {
        /* 新鲜，直接用 */
      } else if (lastDreamina) {
        dp = lastDreamina;                                    // 陈旧值兜底：立即响应
      } else {
        dreaminaProbing = true;
        dp = await withTimeout(D.probe(), waitMs, null);       // 从未探测过才等，且限时
        freshDp = dp;
        if (dp) dreaminaProbing = false;
      }
    }
    /* 后台刷新（fire-and-forget，非 force）：靠 peek 的 TTL 自然节流；
       探测侧有防重入，不会叠加成多个并发 CLI 进程。 */
    if (D && dp) D.probe().catch(() => {});
  } else {
    // 非 fast：调用方明确要求新鲜值 → 保持阻塞语义
    dp = D ? (dp || await D.probe().catch(() => null)) : null;
    freshDp = dp;
  }

  const dpAvail = !!(dp && dp.available);
  const dpMsg = (dp && dp.message) || '创作 CLI 状态读取中（探测未在预期时间内返回，稍后自动刷新）';

  let dreamina = null;
  if (dp) {
    dreamina = {
      available: dp.available, version: dp.version, credit: dp.credit,
      creditAt: dp.at ? new Date(dp.at).toISOString() : null,   // 积分读取时刻，界面据此说明新鲜度
      stale: dp.stale === true,                                 // 来自过期缓存 → 界面标注"后台更新中"
      account: dp.account, message: dp.message
    };
    db.settings.adapter.dreaminaAvailable = dp.available;
    db.settings.adapter.dreaminaVersion = dp.version;
  }
  store.save();
  return {
    /* 单引擎后 cliAvailable / cliVersion 指的就是创作 CLI；保留字段名是为了不破坏既有前端契约 */
    cliAvailable: dpAvail,
    cliVersion: (dp && dp.version) || null,
    dreaminaProbing,                  // 尚未探到 → 界面显示"读取中…"
    checkedAt: new Date((dp && dp.at) || Date.now()).toISOString(),
    message: dpMsg + (!dpAvail && db.settings.adapter.dreaminaAuthUrl
      ? '；若您已在浏览器完成授权但此处仍显示未登录，说明该授权会话已超时失效，请重新点「登录」获取新链接'
      : ''),
  /* 创作 CLI 的待完成授权（登录/切换进行中时前端轮询用；成功后自动清空）

     ⚠ 这里曾经把「正在用的链接」当成遗留链接清掉（2026-09-18「切换账号」故障）：
     GET /system/adapter 走的是 fast 模式，dp 可能来自 probe 的陈旧缓存 ——
     切换刚开始时缓存里还是旧账号 available:true，于是前端自己的 3s 状态轮询
     把刚落库、用户正要点的授权链接清空，界面永远渲染不出「打开授权页」，
     流程只能干等到超时。两道守卫缺一不可：
       ① 有登录/切换流程正在进行 → 链接正在被用，绝不清；
       ② 链接刚落库 60s 内 → 同样视为"正在被用"（即便流程已结束，例如中途重启服务）。
     ⚠ 另外：判据只允许用 **新鲜值** freshDp。fast 路径现在会在缓存过期时回陈旧值，
       若拿 dp 去判"已登录"，就等于用几分钟前的状态决定"这张链接没人用了"，风险更大。 */
  dreaminaAuth: (() => {
    const a = db.settings.adapter;
    const flowPending = D && typeof D.pending === 'function' ? D.pending() : false;
    const publishedAt = a.dreaminaAuthAt || 0;
    const justPublished = publishedAt > 0 && (Date.now() - publishedAt) < 60000;
    // 已处于登录态、且这张链接不是当前流程刚发布的 → 是遗留链接，清掉（例如用户在别处完成授权）
    if (!flowPending && !justPublished && freshDp && freshDp.available && a.dreaminaAuthUrl) {
      const gone = a.dreaminaAuthUrl;
      a.dreaminaAuthUrl = null;
      a.dreaminaUserCode = null;
      a.dreaminaAuthAt = null;
      store.save();
      try {
        store.pushLog('auth', 'info', '清理遗留的创作 CLI 授权链接（无流程进行中且已登录；' +
          '发布于 ' + new Date(publishedAt || 0).toISOString() + '，链接前缀 ' + String(gone).slice(0, 32) + '）');
      } catch (e) { /* 留痕失败不影响状态返回 */ }
    }
    return {
      authUrl: a.dreaminaAuthUrl || null,
      userCode: a.dreaminaUserCode || null,
      /* 是否处于「刚发布、正等用户授权」状态：前端据此渲染授权入口并提示有效期 */
      pending: flowPending,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null
    };
  })(),
    dreamina
  };
}

/* CLI 账户操作：检测（强探）。
   画布 CLI 已移除，所以不再有"一次检测两个 CLI"这回事；登录 / 切换账号见下方 dreamina 版本。 */
async function adapterCheck(db, adapter) {
  const D = adapter.dreamina;
  if (!D) throw new ApiError(ERR.INTERNAL, '创作 CLI 适配器未加载（请重启服务）');
  /* 必须强制重探（force）：用户点「检测连接状态」就是为了拿到实时的账号与积分，
     命中缓存就完全失去意义了。 */
  const dp = await D.probe(true).catch(() => null);
  if (dp) {
    db.settings.adapter.dreaminaAvailable = dp.available;
    db.settings.adapter.dreaminaVersion = dp.version;
    store.save();
  }
  return {
    /* 兼容既有前端字段名：cliAvailable 现在表示"唯一的那个 CLI（创作 CLI）是否就绪" */
    cliAvailable: !!(dp && dp.available),
    cliVersion: (dp && dp.version) || null,
    message: (dp && dp.message) || '创作 CLI 探测失败（未取得任何响应）',
    checkedAt: new Date().toISOString(),
    dreamina: dp ? {
      available: dp.available, version: dp.version, credit: dp.credit,
      creditAt: dp.at ? new Date(dp.at).toISOString() : null,
      account: dp.account, message: dp.message
    } : null
  };
}

/* 创作 CLI（dreamina）的登录与切换账号。
   与画布 CLI 的关键差别：**没有 --force 之类的"软"重登，切换必须先退出当前账号**，
   所以路由注释与界面文案都要把"会先退出"说在前面（前端另有二次确认弹层）。 */
async function adapterDreaminaLogin(db, adapter, cfg) {
  const D = adapter.dreamina;
  if (!D || typeof D.authLoginFlow !== 'function') throw new ApiError(ERR.INTERNAL, '创作 CLI 适配器不支持登录（请重启服务）');
  const out = await D.authLoginFlow(db, cfg.loginTimeoutMs, false);
  if (out.account) db.settings.adapter.dreaminaAccount = out.account;   // 缓存账号，供列表/状态直接读
  logDreaminaAuth('登录', out);
  store.save();
  return out;
}
async function adapterDreaminaSwitch(db, adapter, cfg) {
  const D = adapter.dreamina;
  if (!D || typeof D.switchAccount !== 'function') throw new ApiError(ERR.INTERNAL, '创作 CLI 适配器不支持切换账号（请重启服务）');
  /* relogin 会先退出当前账号，探测缓存里的「仍在线 + 旧积分」立刻就成了假象。
     先失效掉，让界面如实显示"已登出"，也避免后续判定依赖陈旧值。 */
  if (typeof D.invalidate === 'function') D.invalidate();
  const out = await D.switchAccount(db, cfg.loginTimeoutMs, true);
  if (out.account) db.settings.adapter.dreaminaAccount = out.account;
  logDreaminaAuth('切换账号', out);
  store.save();
  return out;
}

/* 创作 CLI 登录/切换的结果留痕：出问题时不必再靠 CLI 自己的日志反推。 */
function logDreaminaAuth(action, out) {
  try {
    store.pushLog('auth', out && out.ok ? 'info' : 'warn',
      '创作 CLI ' + action + '结束：ok=' + !!(out && out.ok) +
      '，reason=' + ((out && out.reason) || '-') +
      '，账号=' + (((out && out.account) && out.account.userId) || '未取得') +
      '，积分=' + ((out && out.credit != null) ? out.credit : '-') +
      '，提示=' + String((out && out.message) || '').slice(0, 200));
  } catch (e) { /* 留痕失败不能影响接口返回 */ }
}

/* ---------------- 生成记录（records.js 的接口层包装） ----------------
   记录本身是「落盘那一刻的快照」，永远可读；分镜被改被删都不影响它。 */

/* ---------------- 生成记录（项目作用域） ----------------
   记录属于**项目**（指令 §7/§13）。作用域由后端注入查询条件，绝不依赖前端过滤（§29）。
   ⚠ 记录里的 projectName / workspaceName 是**生成时刻的快照**，不是现查 ——
     项目改名或软删后，旧记录仍显示当时的名字（§47）。 */
function listRecords(db, q, scope) {
  return REC.listRecords(db, Object.assign({}, q, { projectId: scope.projectId }));
}

function getRecordDetail(db, id, scope) {
  const r = REC.getRecord(db, id);
  if (!r) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  /* 跨项目读记录必须拒绝：记录里含完整提示词、命令与产物地址 */
  if (r.projectId && r.projectId !== scope.projectId) {
    throw new ApiError(ERR.NOTFOUND, '生成记录不属于当前项目：' + id);
  }
  const sb = findSb(db, r.storyboardId);
  return Object.assign({}, r, {
    // 中文标签：列表走 records.lite() 会带，详情直接返回原记录，这里补齐
    actionLabel: REC.ACTION_LABEL[r.action] || r.action,
    outcomeLabel: REC.OUTCOME_LABEL[r.outcome] || r.outcome,
    // 分镜是否还在：只影响"能否跳回分镜"，不影响记录本身的完整性
    storyboardExists: !!sb,
    storyboardStatus: sb ? sb.status : null,
    storyboardCurrentModel: sb ? sb.model : null,
    // 若现在重跑，会走哪条链路（记录里的 engine 是当时的真实事实，两者不同属正常）
    currentEngine: sb ? plannedEngineFor(db, sb).engine : null
  });
}

function deleteRecord(db, id, scope) {
  const r = REC.getRecord(db, id);
  if (!r) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  if (r.projectId && r.projectId !== scope.projectId) {
    throw new ApiError(ERR.NOTFOUND, '生成记录不属于当前项目：' + id);
  }
  const out = REC.deleteRecord(db, id);
  if (!out.removed) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  return out;
}

/* 清空记录。⚠ 原实现的 {all:true} 会清掉**所有项目**的历史，多项目之后这是数据事故：
   现在只在本项目内清理。口径仍然要求显式给出（ids / before / action / all）。 */
function clearRecords(db, body, scope) {
  const b = Object.assign({}, body || {});
  const all = Array.isArray(db.records) ? db.records : [];
  const mine = all.filter((r) => r && (!r.projectId || r.projectId === scope.projectId));
  const foreignCount = all.length - mine.length;

  if (Array.isArray(b.ids) && b.ids.length) {
    /* 只允许删本项目的记录 */
    const allowed = new Set(mine.filter((r) => b.ids.includes(r.id)).map((r) => r.id));
    if (allowed.size !== b.ids.length) {
      throw new ApiError(ERR.NOTFOUND, '有 ' + (b.ids.length - allowed.size) + ' 条记录不属于当前项目，未做任何改动');
    }
  }
  const out = REC.clearRecords(db, Object.assign({}, b, { projectId: scope.projectId }));
  if (!out.removed && out.message) throw new ApiError(ERR.PARAM, out.message);
  if (foreignCount) out.note = '仅清理当前项目的记录；另有 ' + foreignCount + ' 条属于其它项目，未受影响';
  return out;
}

function exportRecords(db, q, format, scope) {
  return REC.exportRecords(db, Object.assign({}, q, { projectId: scope.projectId }), format);
}

module.exports = {
  META, DEFAULT_SETTINGS, splitSegments, stats,
  listStoryboards, getProgress, getStoryboard, createStoryboard, patchStoryboard,
  batchDuration, batchSubmit, cancel, retry, batchDelete, reorder,
  listAssets, createAsset, deleteAsset, updateAsset, replaceAsset, bindAsset, unbindAsset, autoMatchAssets, autoDuration, importPreview, importConfirm, dryRunStoryboard, importAssetPrompts,
  getSettings, putSettings, resetSettings, getOptions, adapterStatus, adapterCheck,
  adapterDreaminaLogin, adapterDreaminaSwitch,
  listRecords, getRecordDetail, deleteRecord, clearRecords, exportRecords
};
