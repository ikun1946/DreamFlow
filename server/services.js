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
const AL = require('./asset-lock');   // 素材图号 / 素材锁定区块 / 引用校验的唯一事实来源
const REC = require('./records');     // 生成记录：查询 / 详情 / 删除 / 清空 / 导出
const fs = require('fs');
const path = require('path');
const { ASSET_DIR, loadConfig } = require('./config');

/* 素材上传允许的扩展名（创建/批量导入共用） */
const ASSET_EXT = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']
};
const ASSET_TYPE_KIND = { character: 'image', scene: 'image', prop: 'image', audio: 'audio' };

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
  projectName: '雨夜归途',
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

function stats(db) {
  const all = db.storyboards;
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

function renumber(db) {
  db.storyboards.slice().sort(bySeq).forEach((s, i) => { s.seq = i + 1; });
  db.seq = db.storyboards.length;
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
function listStoryboards(db, q, projectId) {
  let list = db.storyboards.slice().sort(bySeq);
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
  return { list: slice.map((s) => decorate(db, s)), page, pageSize, total, stats: stats(db) };
}

function getProgress(db, idsParam) {
  const ids = String(idsParam || '').split(',').map((s) => s.trim()).filter(Boolean);
  const changed = db.storyboards.filter((s) => ids.includes(s.id) && s.dirty);
  changed.forEach((s) => { s.dirty = false; });
  store.save();
  return changed.map((s) => ({
    id: s.id, status: s.status, progress: Math.round(s.progress),
    etaSeconds: s.etaSeconds, currentFrameUrl: s.currentFrameUrl,
    videoUrl: s.videoUrl, coverUrl: s.coverUrl,
    retryCount: s.retryCount, errorCode: s.errorCode, errorMessage: s.errorMessage,
    canEditDuration: s.canEditDuration
  }));
}

function getStoryboard(db, id, cfg) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
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
async function dryRunStoryboard(db, id, adapter, opts) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
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

function createStoryboard(db, b) {
  const d = db.settings.defaults;
  const s = {
    id: rid('st_'), projectId: 'pj_1', batchId: 'bt_21', seq: ++db.seq,
    prompt: b.prompt || '', negativePrompt: b.negativePrompt != null ? b.negativePrompt : d.negativePrompt,
    durationSec: clamp(Math.round(Number(b.durationSec || d.durationSec)), META.duration.min, META.duration.max),
    model: b.model || d.model, ratio: b.ratio || d.ratio,
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

function patchStoryboard(db, id, b) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
  if (b.durationSec != null && !s.canEditDuration) {
    throw new ApiError(ERR.CONFLICT, '分镜已完成，修改时长需重新生成');
  }
  if (b.durationSec != null) {
    const v = Math.round(Number(b.durationSec));
    if (!isFinite(v)) throw new ApiError(ERR.PARAM, '时长不合法');
    s.durationSec = clamp(v, META.duration.min, META.duration.max);
  }
  ['prompt', 'model', 'ratio', 'resolution', 'seed', 'motion', 'negativePrompt'].forEach((k) => {
    if (b[k] != null) s[k] = b[k];
  });
  // 改了提示词、且这次没显式指定时长 → 时长自动跟随提示词里的「总时长」标注
  if (b.durationSec == null && b.prompt != null && s.canEditDuration) {
    const byPrompt = parsePromptDuration(s.prompt).seconds;
    if (byPrompt != null) s.durationSec = clamp(byPrompt, META.duration.min, META.duration.max);
  }
  s.dirty = true;
  store.save();
  return decorate(db, s);
}

function batchDuration(db, b) {
  const updated = [], skipped = [];
  (b.ids || []).forEach((id) => {
    const s = findSb(db, id);
    if (!s) return skipped.push({ id, reason: 'not_found', message: '分镜不存在' });
    if (!s.canEditDuration) return skipped.push({ id, reason: 'completed_locked', message: '已完成，已锁定时长' });
    s.durationSec = clamp(Math.round(Number(b.durationSec)), META.duration.min, META.duration.max);
    s.dirty = true; updated.push(id);
  });
  store.save();
  return { updated, skipped };
}

function batchSubmit(db, b, adapter, cfg) {
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
  return gate.then(() => doSubmit(db, b));
}

function doSubmit(db, b) {
  const accepted = [], rejected = [];
  const dry = b.dryRun === true;   // 本批次干跑：进队列组装命令但不派发
  (b.ids || []).forEach((id) => {
    const s = findSb(db, id);
    if (!s) return rejected.push({ id, code: String(ERR.NOTFOUND), message: '分镜不存在' });
    if (s.status === 'generating' || s.status === 'queued') {
      return rejected.push({ id, code: String(ERR.CONFLICT), message: '该分镜已在队列中' });
    }
    if (s.errorCode === String(ERR.NO_CREDIT)) {
      return rejected.push({ id, code: String(ERR.NO_CREDIT), message: '积分不足，无法提交' });
    }
    s.status = 'queued'; s.progress = 0; s.errorCode = null; s.errorMessage = null;
    s.finishedAt = null; s.remoteId = null; s.dirty = true;
    if (dry) s.submitDryRun = true; else s.submitDryRun = false;
    accepted.push({ id, remoteId: null, status: 'queued' });
  });
  if (b.concurrency != null) db.settings.queue.concurrency = clamp(Number(b.concurrency), 1, 5);
  store.save();
  return { accepted, rejected, dryRun: dry };
}

function cancel(db, id) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
  if (s.status === 'succeeded') throw new ApiError(ERR.CONFLICT, '已完成的分镜无法取消');
  if (s.status === 'draft') throw new ApiError(ERR.CONFLICT, '未提交的分镜无需取消，直接删除或编辑即可');
  const wasGenerating = s.status === 'generating';
  s.status = 'canceled'; s.progress = 0; s.etaSeconds = 0; s.finishedAt = nowIso(); s.dirty = true;
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

function retry(db, id) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
  s.status = 'queued'; s.progress = 0; s.etaSeconds = null;
  s.errorCode = null; s.errorMessage = null; s.retryCount++; s.dirty = true;
  s.canEditDuration = true;
  store.save();
  return decorate(db, s);
}

function batchDelete(db, b) {
  const ids = b.ids || [];
  const running = db.storyboards.filter((s) => ids.includes(s.id) && (s.status === 'generating' || s.status === 'queued'));
  if (running.length && !b.force) {
    throw new ApiError(ERR.CONFLICT, '存在运行中的分镜，请确认后强制删除', { ids: running.map((s) => s.id) });
  }
  const deleted = db.storyboards.filter((s) => ids.includes(s.id)).map((s) => s.id);
  db.storyboards = db.storyboards.filter((s) => !ids.includes(s.id));
  deleted.forEach((id) => { delete db.logs[id]; delete db.cliJobs[id]; });
  renumber(db);
  store.save();
  return { deleted };
}

function reorder(db, id, b) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
  const idx = db.storyboards.slice().sort(bySeq).findIndex((x) => x.id === s.id);
  const sorted = db.storyboards.slice().sort(bySeq);
  const to = b.direction === 'up' ? idx - 1 : idx + 1;
  if (to >= 0 && to < sorted.length) {
    const other = sorted[to];
    const t = s.seq; s.seq = other.seq; other.seq = t;
    s.dirty = true; other.dirty = true;
  }
  store.save();
  return { id: s.id };
}

function listAssets(db, q) {
  const type = q.type || 'character';
  const kw = q.keyword ? String(q.keyword).toLowerCase() : '';
  let pool = db.assets.filter((a) => a.type === type);
  if (kw) pool = pool.filter((a) => a.name.toLowerCase().includes(kw));
  pool = pool.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));   // 新素材在前
  const shot = q.inShotId ? findSb(db, q.inShotId) : null;
  const usedIds = shot ? shot.assets.map((r) => r.assetId) : [];
  const view = (a) => viewAsset(a, usedIds);
  const currentShot = usedIds.length ? db.assets.filter((a) => usedIds.includes(a.id)).map(view) : [];
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
function createAsset(db, opts) {
  const type = String(opts.type || '');
  const kind = ASSET_TYPE_KIND[type];
  if (!kind) throw new ApiError(ERR.PARAM, '素材类型不合法：' + type + '（支持 character/scene/prop/audio）');
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
  fs.writeFileSync(path.join(ASSET_DIR, fname), buf);
  const base = filename.replace(/\.[^.]+$/, '').trim() || ('素材-' + id.slice(3, 9));
  const asset = {
    id, projectId: 'pj_1', name: base, type,
    url: '/media/assets/' + fname,
    thumbUrl: kind === 'audio' ? null : '/media/assets/' + fname,
    width: 0, height: 0, size: buf.length, tags: [],
    createdAt: nowIso(), updatedAt: null,
    gradSeedKey: id, origin: 'upload'
  };
  db.assets.push(asset);
  store.save();
  return viewAsset(asset);
}

function bindAsset(db, id, b) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
  const role = b.role;
  if (!['character', 'scene', 'prop', 'audio', 'firstFrame', 'storyboard'].includes(role)) {
    throw new ApiError(ERR.PARAM, 'role 不合法');
  }
  if (!findAsset(db, b.assetId)) throw new ApiError(ERR.NOTFOUND, '素材不存在');
  const single = role !== 'character';
  if (single) s.assets = s.assets.filter((r) => r.role !== role);
  if (!s.assets.some((r) => r.assetId === b.assetId && r.role === role)) {
    s.assets.push({ assetId: b.assetId, role });
  }
  s.dirty = true;
  store.save();
  return { id: s.id };
}

function unbindAsset(db, id, assetId) {
  const s = findSb(db, id);
  if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
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
function autoMatchAssets(db, b) {
  const body = b || {};
  const apply = body.apply === true;
  const overwrite = body.overwrite === true;
  const dedupe = body.dedupe !== false;   // 默认开：同一角色（去噪后同名）的多张素材只绑一张
  const onlyDraft = body.onlyDraft !== false;
  const ids = Array.isArray(body.ids) ? body.ids : [];

  let pool = db.storyboards.slice();
  if (ids.length) pool = pool.filter((s) => ids.includes(s.id));
  else if (onlyDraft) pool = pool.filter((s) => s.status === 'draft');
  pool.sort((a, b2) => a.seq - b2.seq);

  const rows = [];
  const stat = { storyboards: pool.length, bound: 0, kept: 0, occupied: 0, noMatch: 0 };

  pool.forEach((s) => {
    const p = normKey(s.prompt);
    const hits = [];
    // ① 逐素材试匹配
    db.assets.forEach((a) => {
      const k = nameKeys(a.name);
      const hit = matchByText(p, k);
      if (!hit) return;
      hits.push({
        assetId: a.id, name: a.name, type: a.type, role: a.type,
        via: hit.via, keyword: hit.keyword, group: k.group,
        _score: (MATCH_SCORE[hit.via] || 0) + hit.keyword.length
      });
    });

    // ② 按 role 收敛：先同名去重（同一角色的多张素材只留最优），character 可多绑、其余取最高分
    const byRole = {};
    hits.forEach((h) => { (byRole[h.role] = byRole[h.role] || []).push(h); });
    const won = [];
    const rivals = [];   // 同一 role 命中多个时，落选的候选（告知用户"为什么没选它"）
    Object.keys(byRole).forEach((role) => {
      let list = byRole[role].slice().sort((x, y) => (y._score - x._score) || (y.name.length - x.name.length));
      if (dedupe) {
        const seen = {};
        list = list.filter((m) => (seen[m.group] ? false : (seen[m.group] = true)));
      }
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
      if (other && m.role !== 'character') {
        const oa = findAsset(db, other.assetId) || { name: '(已删除素材)' };
        occupied.push({ role: m.role, currentAssetId: other.assetId, currentName: oa.name, want: m });
        if (overwrite) toBind.push(m);
        return;
      }
      toBind.push(m);
    });

    if (apply && toBind.length) {
      toBind.forEach((m) => {
        if (m.role !== 'character' && overwrite) s.assets = s.assets.filter((r) => r.role !== m.role);
        if (!s.assets.some((r) => r.assetId === m.assetId && r.role === m.role)) {
          s.assets.push({ assetId: m.assetId, role: m.role, via: m.via, matchedBy: m.keyword, autoAt: nowIso() });
        }
      });
      s.dirty = true;
    }
    stat.bound += toBind.length;
    stat.kept += kept.length;
    stat.occupied += occupied.length;
    if (!won.length) stat.noMatch++;

    const strip = (m) => ({ assetId: m.assetId, name: m.name, type: m.type, role: m.role, via: m.via, keyword: m.keyword });
    rows.push({
      id: s.id, seq: s.seq, status: s.status, prompt: s.prompt,
      toBind: toBind.map(strip),
      kept: kept.map(strip),
      rivals: rivals.map(strip),
      occupied: occupied.map((o) => ({ role: o.role, currentAssetId: o.currentAssetId, currentName: o.currentName, want: strip(o.want) })),
      noMatch: won.length === 0
    });
  });

  if (apply) store.save();
  return {
    applied: apply, overwrite, scanned: pool.length,
    rows: rows.filter((r) => r.toBind.length || r.kept.length || r.occupied.length || r.rivals.length || r.noMatch),
    stats: stat
  };
}

/* ---------------- 按时长标注自动计算分镜时长 ----------------
   分镜稿的书写约定：段落头「段落1｜总时长：4.0s」，镜头行「镜1｜1.3s｜近景/…」。
   取值优先级：①「总时长」标注 → ② 各镜头秒数之和（标注缺失时的兜底）。
   取整：**一律向上进位**（Math.ceil）—— 分镜时长必须装得下整段内容，宁可多 1 秒；
   再按全局时长范围（META.duration）钳制，钳制过的在结果里标 clamped 并给出提示。 */

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

/** 按标注把 durationSec 换算成合法值 */
function durationFromPrompt(s, fallbackSec) {
  const p = parsePromptDuration(s.prompt);
  if (p.seconds == null) return { seconds: null, parsed: p };
  return { seconds: clamp(p.seconds, META.duration.min, META.duration.max), parsed: p, clamped: p.seconds !== clamp(p.seconds, META.duration.min, META.duration.max) };
}

/**
 * 批量按提示词重算时长。
 * body: { ids?: string[], apply?: boolean, onlyDraft?: boolean }
 * apply 缺省 **true**（这是"自动匹配"的语义，可直接生效）；传 false 则只预览。
 */
function autoDuration(db, b) {
  const body = b || {};
  const apply = body.apply !== false;
  const onlyDraft = body.onlyDraft !== false;
  const ids = Array.isArray(body.ids) ? body.ids : [];

  let pool = db.storyboards.slice();
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
    const target = clamp(parsed.seconds, META.duration.min, META.duration.max);
    row.target = target;
    row.clamped = target !== parsed.seconds;
    if (row.clamped) { row.clampReason = '超出全局时长范围 ' + META.duration.min + '–' + META.duration.max + 's'; stat.clamped++; }
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

function importPreview(db, b) {
  const segs = splitSegments(b.rawText, b.delimiter);
  const existing = db.storyboards.map((s) => s.prompt);
  const warnings = [];
  const out = segs.map((text, i) => {
    const dup = existing.includes(text);
    const tooLong = text.length > 2000;
    if (dup) warnings.push({ code: 'DUPLICATE', index: i + 1, message: '与已有分镜内容重复' });
    if (tooLong) warnings.push({ code: 'TOO_LONG', index: i + 1, message: '超过 2000 字' });
    const pd = parsePromptDuration(text);
    if (pd.mismatch) warnings.push({ code: 'DURATION_MISMATCH', index: i + 1, message: '标注总时长 ' + pd.declared + 's 与镜头之和 ' + pd.shotsSum + 's 不一致（按标注 ' + pd.declared + 's 计）' });
    if (pd.seconds != null && (pd.seconds < META.duration.min || pd.seconds > META.duration.max)) {
      warnings.push({ code: 'DURATION_CLAMPED', index: i + 1, message: '标注时长进位后为 ' + pd.seconds + 's，超出 ' + META.duration.min + '–' + META.duration.max + 's，将按边界值取' });
    }
    return {
      index: i + 1, text, charCount: text.length, duplicate: dup, tooLong,
      declaredTotal: pd.declared, shotSeconds: pd.shots, durationSec: pd.seconds   // 导入后实际会采用的时长
    };
  });
  return { total: out.length, delimiterEcho: b.delimiter, segments: out, warnings };
}

function importConfirm(db, b, idempotencyKey) {
  const segs = splitSegments(b.rawText, b.delimiter);
  const d = Object.assign({}, db.settings.defaults, b.defaults || {});
  const top = b.insertPosition !== 'bottom';
  if (top) db.storyboards.forEach((s) => { s.seq += segs.length; });
  const created = segs.map((text, i) => {
    const s = {
      id: rid('st_'), projectId: 'pj_1', batchId: b.batchId || 'bt_21',
      seq: top ? (i + 1) : ++db.seq,
      prompt: text, negativePrompt: d.negativePrompt || '',
      // 时长优先取提示词里的「总时长」标注（向上进位），没有标注才回落到默认值
      durationSec: (function () {
        const byPrompt = parsePromptDuration(text).seconds;
        return clamp(byPrompt != null ? byPrompt : Math.round(Number(d.durationSec)), META.duration.min, META.duration.max);
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
  renumber(db);
  store.save();
  return { created, createdCount: created.length, batchId: b.batchId || 'bt_21', skipped: [] };
}

function getSettings(db) {
  return JSON.parse(JSON.stringify(db.settings));
}

async function putSettings(db, s, adapter) {
  // 并发上限：不再按账号档位限制；仅当配置了本地保护上限（concMax>0）时校验上限
  let concMax = 0;
  try { concMax = (await adapter.resolveMaxConcurrency()).max; } catch (e) { /* 解析失败按不限制处理 */ }
  if (s.queue && (s.queue.concurrency < 1 || (concMax > 0 && s.queue.concurrency > concMax))) {
    throw new ApiError(ERR.PARAM, '参数校验失败', {
      fields: [{
        path: 'queue.concurrency',
        message: concMax > 0 ? '范围为 1–' + concMax + '（本地保护上限，可在 server/config.json 调整或设为 0 关闭）' : '须为不小于 1 的整数'
      }]
    });
  }
  if (s.delimiter && s.delimiter.type === 'custom' && !s.delimiter.value) {
    throw new ApiError(ERR.PARAM, '参数校验失败', { fields: [{ path: 'delimiter.value', message: '自定义分隔符不能为空' }] });
  }
  // 默认值须落在「当前默认模型」的能力范围内：大小写差异（720P / 720p）先归一，
  // 模型不支持的值按就近档位调整——调整项随响应返回（前端明确提示，不静默改）
  const adjustments = [];
  /* 能力表来自 models.js（唯一事实来源）。原实现在这里调画布 CLI 的 model list
     取"实时规格"，画布 CLI 移除后改用注册表内建的能力表。 */
  {
    const incoming = Object.assign({}, db.settings.defaults, s.defaults || {});
    const dmName = models.dreaminaModelOf(incoming.model);
    if (dmName) {
      const caps = models.capsFor(dmName);
      const resList = caps.resolutions;
      const ratioList = models.DREAMINA_RATIOS;
      const durRange = { min: caps.duration[0], max: caps.duration[1] };
      if (!s.defaults) s.defaults = {};
      if (resList.length) {
        const hit = resList.find((v) => String(v).toLowerCase() === String(incoming.resolution).toLowerCase());
        const pick = hit || resList.reduce((b, v) =>
          (Math.abs(resTier(v) - resTier(incoming.resolution)) < Math.abs(resTier(b) - resTier(incoming.resolution)) ? v : b), resList[0]);
        if (pick !== incoming.resolution) {
          adjustments.push('分辨率 ' + incoming.resolution + ' → ' + pick + '（模型 ' + incoming.model + ' 支持 ' + resList.join(' / ') + '）');
          s.defaults.resolution = pick;
        }
      }
      if (ratioList.length && !ratioList.includes(incoming.ratio)) {
        adjustments.push('画幅 ' + incoming.ratio + ' → ' + ratioList[0] + '（模型 ' + incoming.model + ' 支持 ' + ratioList.join(' / ') + '）');
        s.defaults.ratio = ratioList[0];
      }
      if (durRange) {
        const d = Number(incoming.durationSec);
        const clamped = Math.max(durRange.min, Math.min(durRange.max, d));
        if (clamped !== d) {
          adjustments.push('时长 ' + d + 's → ' + clamped + 's（模型 ' + incoming.model + ' 支持 ' + durRange.min + '–' + durRange.max + 's）');
          s.defaults.durationSec = clamped;
        }
      }
    }
  }

  /* adapter 下的字段全部只读（引擎只有创作 CLI 一个，不再有可写的引擎选择项）；
     显式重建而不是直接 merge，避免前端把自己读到的旧字段（如已删除的 engine）再写回库里。 */
  db.settings = Object.assign({}, db.settings, s, {
    adapter: {
      dreaminaAvailable: db.settings.adapter.dreaminaAvailable, // 只读
      dreaminaVersion: db.settings.adapter.dreaminaVersion      // 只读
    }
  });
  store.save();
  const out = getSettings(db);
  if (adjustments.length) {
    adjustments.forEach((a) => store.pushLog('system', 'info', '默认参数已按模型规格调整：' + a));
    out.adjustments = adjustments;
  }
  return out;
}

function deleteAsset(db, id) {
  const a = db.assets.find((x) => x.id === id);
  if (!a) throw new ApiError(ERR.NOTFOUND, '素材不存在');
  db.assets = db.assets.filter((x) => x.id !== id);
  // 解绑所有分镜上的引用
  db.storyboards.forEach((s) => { s.assets = (s.assets || []).filter((r) => r.assetId !== id); });
  // 删除本地文件（url 形如 /media/assets/as_xxx.png）
  if (a.url && a.url.startsWith('/media/assets/')) {
    try { fs.unlinkSync(path.join(ASSET_DIR, a.url.slice('/media/assets/'.length))); } catch (e) { /* 文件可能已不存在 */ }
  }
  store.save();
  return { deleted: id };
}

/* 素材设置：更新（名称 / 文生图提示词；两者至少传一项，只更新传了的部分）
   —— prompt 用于素材详情弹窗的提示词编辑：先有提示词占位资产，图后补 */
function updateAsset(db, id, body) {
  const a = findAsset(db, id);
  if (!a) throw new ApiError(ERR.NOTFOUND, '素材不存在');
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
function replaceAsset(db, id, opts) {
  const a = findAsset(db, id);
  if (!a) throw new ApiError(ERR.NOTFOUND, '素材不存在');
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
  const oldUrl = a.url;
  /* 文件名 = 素材id + 替换时刻（36进制时间戳）+ 扩展名。
     必须让 url 每次替换都变化：若沿用固定文件名（旧实现 a.id + ext），
     浏览器会命中 <img> 缓存继续显示旧图 —— 表现为"替换后图片没变"。 */
  const fname = a.id + '-' + Date.now().toString(36) + ext;
  fs.writeFileSync(path.join(ASSET_DIR, fname), buf);
  if (oldUrl && oldUrl.startsWith('/media/assets/') && oldUrl !== '/media/assets/' + fname) {
    try { fs.unlinkSync(path.join(ASSET_DIR, oldUrl.slice('/media/assets/'.length))); } catch (e) { /* 旧文件可能已不存在 */ }
  }
  a.url = '/media/assets/' + fname;
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

function importAssetPrompts(db, b) {
  const rawText = String((b && b.rawText) || '');
  if (!rawText.trim()) throw new ApiError(ERR.PARAM, '提示词文本为空');
  const parsed = parseAssetPromptSegments(rawText);
  const apply = !!(b && b.apply);
  if (!apply) {
    return Object.assign(parsed, { created: [], applied: false });
  }
  if (!parsed.items.length) {
    return Object.assign(parsed, { created: [], applied: true });
  }
  const TYPE_LABEL = { character: '角色', scene: '场景', prop: '道具' };
  const created = [];
  for (const it of parsed.items) {
    const id = rid('as_');
    const asset = {
      id, projectId: 'pj_1', name: it.name, type: it.type, prompt: it.prompt,
      url: null, thumbUrl: null,                  // 提示词资产：先占位，图后补（详情弹窗可上传）
      width: 0, height: 0, size: 0, tags: [],
      createdAt: nowIso(), updatedAt: null,
      gradSeedKey: id, origin: 'prompt'
    };
    db.assets.push(asset);
    created.push({ id, type: it.type, typeLabel: TYPE_LABEL[it.type], name: it.name, chars: it.chars });
  }
  store.save();
  return Object.assign(parsed, { created, applied: true });
}

function resetSettings(db, b) {
  const scopes = (b && b.scopes) || ['delimiter', 'defaults', 'queue'];
  if (scopes.includes('delimiter')) db.settings.delimiter = { type: 'custom', value: ';;' };
  if (scopes.includes('defaults'))  db.settings.defaults  = DEFAULT_SETTINGS().defaults;
  if (scopes.includes('queue'))     db.settings.queue     = DEFAULT_SETTINGS().queue;
  store.save();
  return getSettings(db);
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
async function getOptions(db, adapter) {
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

  /* ---------------- 默认值与历史数据的模型名归一 ----------------
     两件事必须分开做，顺序也不能反：
       ① **无损改名**：历史画布域名（seedance_2.0_vip）→ 创作域名（seedance2.0_vip）。
          同一底层模型，只是换了套命名；与"当前是否可用"无关，任何时候都能做。
       ② **替代迁移**：改完之后仍然跑不了的名字（原仅画布模型，创作 CLI 无对应能力）→
          改选一个当前可用的模型。
     ⚠ 铁律（2026-09-18 的教训）：只有「名字确实跑不了」才允许改写用户的选择。
       「名字有效、只是当前探测不可用」必须原样保留 —— 否则创作 CLI 探测瞬时失败时，
       用户设的 seedance2.0fast 会被静默换掉，之后所有新分镜都按别的模型跑。 */
  const avail = meta.models.filter((m) => m.enabled !== false).map((m) => m.value);
  const runnable = (v) => !!v && models.dreaminaModelOf(v) != null;
  const d = db.settings.defaults;
  let changed = false;
  let defaultsNotice = null;
  const renamedOnce = [];      // 收集本次发生的无损改名，供日志
  const canon = (v) => {
    if (!models.isLegacyName(v)) return v;
    const nv = models.dreaminaModelOf(v);
    renamedOnce.push(v + ' → ' + nv);
    return nv;
  };

  if (d.model) {
    const before = d.model;
    d.model = canon(d.model);
    if (d.model !== before) {
      changed = true;
      defaultsNotice = {
        model: d.model, reason: 'legacy', from: before,
        message: '默认模型「' + before + '」是画布 CLI 时代的旧名字，已按创作 CLI 的等价型号改名为「' + models.labelOf(d.model) + '」（同一个底层模型，无需重新选择）'
      };
    }
  }
  /* 改完名还是跑不了 → 替代迁移。只在"确实存在可用模型"时改；
     引擎整体不可用时（avail 为空）保留用户选择，只做标记。 */
  if (avail.length && d.model && !runnable(d.model)) {
    const alt = avail[0];
    if (alt && alt !== d.model) {
      defaultsNotice = {
        model: alt, reason: 'invalid', from: d.model,
        message: '默认模型「' + d.model + '」已随画布 CLI 一并下线（创作 CLI 无对应型号），已自动迁移为「' + models.labelOf(alt) + '」'
      };
      d.model = alt; changed = true;
    }
  }
  /* 名字有效但当前被禁用 → 保留用户的选择，只做标记。
     这里刻意不改 d.model：用户的显式配置优先于"当下探测到的一时不可用"。 */
  if (!defaultsNotice && d.model) {
    const dEntry = meta.models.find((m) => m.value === d.model);
    if (dEntry && dEntry.enabled === false) {
      defaultsNotice = { model: d.model, reason: 'unavailable', message: dEntry.disabledReason || dreaminaOff };
    }
  }
  meta.defaultsNotice = defaultsNotice;

  const pickCi = (list, cur) => (list || []).find((x) => String(x.value).toLowerCase() === String(cur).toLowerCase());
  const rMatch = pickCi(meta.resolutions, d.resolution);
  if (rMatch && rMatch.value !== d.resolution) { d.resolution = rMatch.value; changed = true; }
  const aMatch = pickCi(meta.ratios, d.ratio);
  if (aMatch && aMatch.value !== d.ratio) { d.ratio = aMatch.value; changed = true; }

  /* 历史分镜与 cliJobs 里的模型名同样归一（先无损改名，再替代迁移） */
  let migrated = 0, renamed = 0;
  const fixName = (v) => {
    const c = canon(v);
    if (c !== v) return c;                                   // 无损改名
    if (!runnable(c) && avail.length) { migrated++; return avail[0]; }   // 跑不了 → 替代
    return c;
  };
  db.storyboards.forEach((s) => {
    if (!s.model) return;
    const nv = fixName(s.model);
    if (nv !== s.model) { if (models.isLegacyName(s.model)) renamed++; s.model = nv; changed = true; }
  });
  Object.keys(db.cliJobs || {}).forEach((id) => {
    const job = db.cliJobs[id];
    if (job && job.cliModel) { const nv = fixName(job.cliModel); if (nv !== job.cliModel) job.cliModel = nv; }
  });
  if (changed || renamedOnce.length) {
    store.save();
    if (renamedOnce.length) {
      store.pushLog('system', 'info', '已将 ' + renamedOnce.length + ' 处画布时代的模型名改为创作 CLI 等价名：' + renamedOnce.slice(0, 8).join('、') + (renamedOnce.length > 8 ? ' …' : ''));
    }
    if (migrated) store.pushLog('system', 'warn', '已将 ' + migrated + ' 条分镜的已下线模型名迁移为可用模型（仅"创作 CLI 无对应型号"的才会迁移）');
  }
  if (defaultsNotice && (defaultsNotice.reason === 'invalid' || defaultsNotice.reason === 'legacy')) store.pushLog('system', 'warn', defaultsNotice.message);
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

function listRecords(db, q) { return REC.listRecords(db, q); }

function getRecordDetail(db, id) {
  const r = REC.getRecord(db, id);
  if (!r) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
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

function deleteRecord(db, id) {
  const out = REC.deleteRecord(db, id);
  if (!out.removed) throw new ApiError(ERR.NOTFOUND, '生成记录不存在（可能已被清理）');
  return out;
}

function clearRecords(db, body) {
  const out = REC.clearRecords(db, body);
  if (!out.removed && out.message) throw new ApiError(ERR.PARAM, out.message);
  return out;
}

function exportRecords(db, q, format) { return REC.exportRecords(db, q, format); }

module.exports = {
  META, DEFAULT_SETTINGS, splitSegments, stats,
  listStoryboards, getProgress, getStoryboard, createStoryboard, patchStoryboard,
  batchDuration, batchSubmit, cancel, retry, batchDelete, reorder,
  listAssets, createAsset, deleteAsset, updateAsset, replaceAsset, bindAsset, unbindAsset, autoMatchAssets, autoDuration, importPreview, importConfirm, dryRunStoryboard, importAssetPrompts,
  getSettings, putSettings, resetSettings, getOptions, adapterStatus, adapterCheck,
  adapterDreaminaLogin, adapterDreaminaSwitch,
  listRecords, getRecordDetail, deleteRecord, clearRecords, exportRecords
};
