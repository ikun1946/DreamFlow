/* ============================================================
   records.js —— 生成记录（追加式「快照」，不是分镜的镜像）
   ------------------------------------------------------------
   为什么不直接读分镜：
     分镜是「可变的当前态」——提示词会被改、素材绑定会被增删、参数会被重算，
     删掉分镜后更是彻底消失。而「这次到底发出去什么、花了多久、产物在哪」
     属于历史事实，一旦发生就不该随后续编辑而改变。
     因此每条记录在**落盘那一刻**把当时的提示词、图号表、参数、命令、
     产物地址全部拷一份存下来。分镜之后怎么改、甚至被删，记录都仍然可读。

   记录只追加、不改写：一次提交产生一条（成功 / 失败 / 取消 / 干跑预览）。
   容量上限 KEEP 条，超出后丢弃最旧的（本地单用户场景，够回溯用）。

   字段分区（前端列表与详情共用同一份定义）：
     · 身份    id / at / kind / storyboardId / seq / projectId
     · 动作    action(generate|dryrun|image) / outcome(succeeded|failed|canceled|previewed)
     · 执行    engine / engineLabel / model / modelLabel / cliModel / mode
     · 参数    params{ratio,resolution,durationSec,motion,seed,negativePrompt}
     · 输入    prompt / promptWithLock / lockBlock / images[] / audios[] / skipped[]
     · 命令    command / argv / adapted[] / missing[] / refs[] / submitId
     · 产物    remoteId / resourceId / videoUrl / coverUrl
     · 结果    elapsedMs / startedAt / finishedAt / errorCode / errorMessage

   ⚠ 两类记录（2026-10-02 新增生图留痕）：
     · kind='video'（**历史记录没有这个字段，读时一律按 video 处理**）—— 分镜视频生成；
     · kind='image' —— 图片资产生图（见 imageSnapshot/appendImage）。生图记录**不挂分镜**，
       它的身份是 assetId/assetName，参数是 size/像素尺寸，产物是 candidateFile/appliedFile
       （本地相对名，绝不存服务商直链 —— 直链约 24 小时过期，见 image-jobs 约束 6）。
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { nowIso, rid } = require('./util');
const AL = require('./asset-lock');
const models = require('./models');
const P = require('./projects');   // 项目/工作区归属与名称快照
const IMGREG = require('./image-registry');   // 生图 provider/model 的中文标签（唯一事实来源）
const PATHS = require('./paths');   // 资源 URL 形状的唯一事实来源（结果图地址现拼，不落库）

const KEEP = 800;            // 最多保留的记录条数（新的在前，超出丢最旧）
const TEXT_CAP = 60000;      // 单条记录中单个文本字段的上限（防单条超大提示词把库撑爆）
const SUMMARY_LEN = 72;

const ACTION_LABEL = { generate: '真实生成', dryrun: '干跑', image: '生图' };
const OUTCOME_LABEL = { succeeded: '成功', failed: '失败', canceled: '已取消', previewed: '仅预览' };

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : t.slice(0, n) + '…';
}

/* 列表上的一句话摘要：优先取「场景：xxx」，否则取第一行有意义的文字 */
function summaryOf(prompt) {
  const t = String(prompt == null ? '' : prompt);
  const m = t.match(/场景\s*[:：]\s*([^\n]{1,80})/);
  if (m) return m[1].trim();
  const line = t.split(/\r?\n/).map((x) => x.trim()).find((x) => x && !/^段落\s*\d/.test(x));
  return clip((line || t.replace(/\s+/g, ' ').trim()), SUMMARY_LEN);
}

/* 引擎归属：能取到真实派发时用的就传 hint，否则按同一套路由规则推演。
   项目只有创作 CLI 一个引擎，所以这里恒为 'dreamina'；
   'canvas' 只会出现在 2026-09-18 之前落下的历史记录里。 */
function engineOf(db, sb, hint) {
  if (hint) return hint;
  try {
    const pe = models.routeEngine({
      model: sb.model,
      hasAudio: (sb.assets || []).some((r) => r.role === 'audio')
    });
    return pe.engine;
  } catch (e) { return 'dreamina'; }
}

/* 从「当前分镜」+「本次执行上下文」生成一条快照 */
function snapshot(db, sb, extra) {
  const o = extra || {};
  const cat = AL.imageCatalog(sb, db);
  /* 与分发时**同一份**区块组装（图片「素材锁定」+ 音频「音频参考」）：
     记录里存的就是实际发出去的那段提示词。以前这里写成 `cat.images.length ? … : ''`，
     等于"没有图片就一个字都不加" —— 只绑音频的分镜，记录里的提示词与实际发出的不一致。 */
  const blocks = AL.buildPrompt(cat.images, cat.audios, sb);
  const lockBlock = blocks.block;
  const prompt = String(sb.prompt == null ? '' : sb.prompt);
  const promptWithLock = blocks.prompt;
  const engine = engineOf(db, sb, o.engine);
  const job = (db.cliJobs && db.cliJobs[sb.id]) || {};
  const startedAt = sb.startedAt || o.startedAt || null;
  let elapsedMs = sb.elapsedMs != null ? sb.elapsedMs : (o.elapsedMs != null ? o.elapsedMs : null);
  if (elapsedMs == null && startedAt && o.outcome && o.outcome !== 'previewed') {
    const s = Date.parse(startedAt);
    if (!isNaN(s)) elapsedMs = Math.max(0, Date.now() - s);
  }
  const outcome = o.outcome || 'succeeded';

  /* 项目 / 工作区归属与**名称快照**（2026-09-19 多项目升级）。
     ⚠ 名称必须是"生成那一刻"的：项目改名、工作区改名或被软删之后，旧记录仍要能显示
     当时叫什么（指令 §13/§47）。所以这里存的是值，不是引用 —— 不做任何回填。
     归属优先从工作区推导（workspace.projectId 是权威来源，§10.1）。 */
  const ws = sb.workspaceId ? P.workspaceOf(db, sb.workspaceId) : null;
  const proj = ws ? P.projectOf(db, ws.projectId) : P.projectOf(db, sb.projectId);

  return {
    id: rid('rc_'),
    at: nowIso(),
    /* 新记录显式带 kind。历史记录没有这个字段，**读时一律按 video 处理**（见 imageSnapshot 注释），
       所以不写迁移脚本 —— 迁移会动到用户的记录库，而"缺省即 video"已经能正确读旧数据。 */
    kind: 'video',
    projectId: proj ? proj.id : (sb.projectId || null),
    projectName: proj ? proj.name : null,
    workspaceId: ws ? ws.id : (sb.workspaceId || null),
    workspaceName: ws ? ws.name : null,
    storyboardId: sb.id,
    seq: sb.seq,
    storyboardTitle: '镜头 ' + sb.seq,

    action: o.action || 'generate',
    outcome: outcome,

    engine: engine,
    engineLabel: models.engineLabel(engine),
    model: sb.model,
    modelLabel: models.labelOf(sb.model),
    cliModel: o.cliModel || models.dreaminaModelOf(sb.model) || sb.model,
    mode: o.mode || job.mode || null,
    engineReason: o.engineReason || null,

    params: {
      ratio: sb.ratio, resolution: sb.resolution, durationSec: sb.durationSec,
      motion: sb.motion != null ? sb.motion : null,
      seed: sb.seed != null ? sb.seed : null,
      negativePrompt: sb.negativePrompt || ''
    },

    title: '镜头 ' + sb.seq + (sb.model ? ' · ' + models.labelOf(sb.model) : ''),
    summary: summaryOf(prompt),
    prompt: clip(prompt, TEXT_CAP),
    promptChars: prompt.length,
    promptWithLock: o.action === 'dryrun' ? null : clip(promptWithLock, TEXT_CAP),
    lockBlock: lockBlock || null,

    images: cat.images.map((x) => ({ n: x.n, assetId: x.assetId, name: x.name, role: x.role, roleLabel: x.roleLabel, file: o.withPaths ? x.file : null })),
    audios: cat.audios.map((x, i) => ({ n: i + 1, assetId: x.assetId, name: x.name, file: o.withPaths ? x.file : null })),
    skipped: cat.skipped,
    assetCount: (sb.assets || []).length,

    command: o.command || job.command || null,
    argv: o.argv || job.argv || null,
    adapted: o.adapted || [],
    missing: o.missing || [],
    refs: o.refs || [],
    submitId: o.submitId || job.submitId || null,

    remoteId: o.remoteId || sb.remoteId || null,
    resourceId: o.resourceId || job.selectedResourceId || null,
    /* ⚠ 产物**只认调用方显式传进来的值**，绝不回退到 sb.videoUrl（2026-09-19 修复的缺陷）。
       原来写的是 `o.videoUrl !== undefined ? o.videoUrl : (sb.videoUrl || null)`，
       而 mapTaskError / cancel / reconcileOrphans 落记录时都不传 videoUrl ——
       于是回退到分镜上的 videoUrl，那是**上一次成功**留下的（doSubmit / retry 都不清它）。
       后果：一次失败或取消的重生成，记录里却挂着上一次的视频，看起来像成功了。
       现在"记录里有产物"严格等价于"这一次真的产出/下载到了产物"。
       成功路径由 worker 显式传 videoUrl/coverUrl（见 runViaDreamina），干跑显式传 null。 */
    videoUrl: o.videoUrl !== undefined ? o.videoUrl : null,
    coverUrl: o.coverUrl !== undefined ? o.coverUrl : null,

    startedAt: startedAt,
    finishedAt: o.finishedAt || sb.finishedAt || nowIso(),
    elapsedMs: elapsedMs,

    errorCode: o.errorCode || null,
    errorMessage: o.errorMessage || null,
    retryCount: sb.retryCount || 0
  };
}

/**
 * 追加一条记录。**永不抛异常**——落记录失败不能把正在跑的任务带崩。
 * @returns {object|null} 写入的记录
 */
function append(db, sb, extra) {
  if (!db || !sb) return null;
  try {
    const rec = snapshot(db, sb, extra);
    if (!Array.isArray(db.records)) db.records = [];
    db.records.unshift(rec);                       // 新的在前，列表天然按时间倒序
    if (db.records.length > KEEP) db.records.length = KEEP;
    db.recordSeq = (Number(db.recordSeq) || 0) + 1;
    store.save();
    return rec;
  } catch (e) {
    console.error('[records] 落记录失败（不影响任务）：' + (e && e.message));
    return null;
  }
}

/* ---------------- 生图记录（kind='image'） ----------------
   为什么视频与生图共用一张记录表：用户要的是**一个**「生成记录」页 ——
   "我花过哪些钱、生成了什么"这件事不因为产物是视频还是图片而分家。
   分家会让筛选、导出、清空全部要各写一套，且两边的历史口径会漂移。

   与视频记录的差异（刻意的）：
     · 身份是**素材**而不是分镜（生图不挂分镜，storyboardId/seq 恒为 null）；
     · 参数没有画幅/时长，只有 size（比例枚举或像素）+ 分辨率档 + 实际像素；
     · 产物是 candidateFile（候选图）/ appliedFile（已采用图）的**本地相对名**，
       地址在读取时由 paths.js 现拼 —— 直链不落库（过期即死数据）也不交给页面。 */

/* 生图记录的确定性 id：由本地任务 id 派生。
   为什么要确定性而不是 rid('rc_')：落记录是"咽喉点扫描"（saveAll 会扫全部任务），
   随机 id 无法回答"这个任务落过了没有"。确定性 id 让去重变成一次集合查找，
   服务重启 / reconcile / 重复 saveAll 都不会产生第二条。 */
const imageRecordId = (job) => (job && job.id ? 'rc_img_' + job.id : null);

/* 结果图的可打开地址。**只认本地相对名**，URL 形状由 paths.js 决定（唯一事实来源）。
   文件已不在（被清理 / 被采用后旧的候选被删）就返回 null —— 前端据此显示"文件已被清理"，
   而不是给一个必然 404 的链接。 */
function imageResultUrl(r) {
  const pj = PATHS.safeId(r.projectId);
  if (!pj) return null;
  const cand = PATHS.safeFile(r.candidateFile);
  if (cand) {
    try { if (fs.existsSync(path.join(PATHS.candidateDir(pj), cand))) return PATHS.candidateUrl(pj, cand); }
    catch (e) { /* 目录不存在等：当作没有 */ }
  }
  const applied = PATHS.safeFile(r.appliedFile);
  if (applied) {
    try { if (fs.existsSync(path.join(PATHS.assetDir(pj), applied))) return PATHS.assetUrl(pj, applied); }
    catch (e) { /* 同上 */ }
  }
  return null;
}

/* 从「当前素材」+「生图任务」生成一条不可变快照。
   ⚠ 素材可能已被删除（用户删了资产）——这时资产相关字段按空处理，记录本身仍然完整。 */
function imageSnapshot(db, asset, job, extra) {
  const o = extra || {};
  const id = imageRecordId(job);
  if (!id) return null;
  /* 项目 / 素材名的**快照**：与 snapshot() 同一理由 —— 项目或素材之后改名/软删，
     旧记录仍要显示当时叫什么。 */
  const pjId = job.projectId || (asset && asset.projectId) || null;
  const proj = pjId ? P.projectOf(db, pjId) : null;
  const ws = (asset && asset.workspaceId) ? P.workspaceOf(db, asset.workspaceId) : null;
  const provider = job.providerId ? IMGREG.findProvider(job.providerId) : null;
  const model = (job.providerId && job.modelId) ? IMGREG.findModel(job.providerId, job.modelId) : null;
  const prompt = String(job.prompt == null ? '' : job.prompt);
  const startedAt = job.createdAt || null;
  const finishedAt = job.updatedAt || nowIso();
  let elapsedMs = null;
  if (startedAt) {
    const s = Date.parse(startedAt);
    const f = Date.parse(finishedAt);
    if (!isNaN(s)) elapsedMs = Math.max(0, (isNaN(f) ? Date.now() : f) - s);
  }
  const outcome = o.outcome || (job.state === 'ready' ? 'succeeded' : 'failed');
  const assetName = o.assetName || (asset && asset.name) || null;

  return {
    id: id,
    at: nowIso(),
    kind: 'image',
    projectId: proj ? proj.id : pjId,
    projectName: proj ? proj.name : null,
    workspaceId: ws ? ws.id : ((asset && asset.workspaceId) || null),
    workspaceName: ws ? ws.name : null,
    /* 生图不挂分镜：显式置 null，前端按 kind 分支渲染（绝不显示"镜头 undefined"） */
    storyboardId: null,
    seq: null,
    storyboardTitle: null,

    assetId: job.assetId || (asset && asset.id) || null,
    assetName: assetName,

    action: 'image',
    outcome: outcome,

    /* engine 沿用视频记录的字段名承载"谁在干活"：生图的执行者就是服务商。
       置成 providerId（协议稳定字符串）而不是塞进 byEngine 的两个桶 ——
       statsOf 的 byEngine 只统计 dreamina/canvas，多一个键不会被计入，语义不变。 */
    engine: job.providerId || null,
    engineLabel: (provider && provider.providerLabel) || job.providerId || '生图服务',
    model: job.modelId || job.model || null,
    modelLabel: (model && model.modelLabel) || null,
    cliModel: null,
    mode: null,
    engineReason: null,
    providerId: job.providerId || null,
    providerLabel: (provider && provider.providerLabel) || null,
    modelId: job.modelId || null,

    title: '素材 ' + (assetName || job.assetId || ''),
    summary: summaryOf(prompt),
    prompt: clip(prompt, TEXT_CAP),
    promptChars: prompt.length,
    promptWithLock: null,
    lockBlock: null,

    /* 生图没有素材锁定 / 音频参考（这些是分镜的概念），留空数组让共用渲染不报错 */
    images: [], audios: [], skipped: [], assetCount: 0,

    params: {
      /* 沿用视频记录的 params 字段名（列表渲染读的是这一份），生图没有的置 null */
      ratio: null, resolution: job.resolution || null, durationSec: null,
      motion: null, seed: null, negativePrompt: ''
    },
    size: job.size || null,
    resolution: job.resolution || null,
    imageWidth: job.imageWidth || null,
    imageHeight: job.imageHeight || null,
    imageFormat: job.imageFormat || null,

    /* 费用**原样快照**，不在记录层折算 —— 各家 usage 形状不同（credits / tokens），
       折算要各自 provider 的知识，放这里就把两家规则焊死在记录层了。 */
    usage: job.usage || null,

    /* 产物：本地相对名（与 image-jobs 的候选/已采用字段一致），地址读时现拼 */
    candidateFile: job.candidateFile || null,
    appliedFile: job.appliedFile || null,
    autoApply: !!job.autoApply,

    command: null, argv: null, adapted: [], missing: [], refs: [],
    /* providerTaskId 是服务商任务号（不是带签名的直链），留作对账用 */
    submitId: job.providerTaskId || null,

    remoteId: null, resourceId: null,
    videoUrl: null, coverUrl: null,

    startedAt: startedAt,
    finishedAt: finishedAt,
    elapsedMs: elapsedMs,

    /* errorKind 是失败原因的分类（audit/auth/no_credit/ratelimit/timeout/network/
       upstream/protocol），界面据此直说原因；errorCode 与它同值，让既有（视频侧）
       读 errorCode 的展示逻辑直接可用。 */
    errorKind: job.errorKind || null,
    errorCode: job.errorKind || null,
    errorMessage: job.error || null,
    retryCount: 0
  };
}

/**
 * 追加一条生图记录。**幂等**：同一任务（确定性 id）只落一条。
 * **永不抛异常**——落记录失败不能把正在跑的任务带崩（纪律同 append()）。
 * @returns {object|null} 写入的记录；已存在或失败返回 null
 */
function appendImage(db, asset, job, extra) {
  if (!db || !job) return null;
  try {
    const id = imageRecordId(job);
    if (!id) return null;
    if (!Array.isArray(db.records)) db.records = [];
    if (db.records.some((r) => r && r.id === id)) return null;
    const rec = imageSnapshot(db, asset, job, extra);
    if (!rec) return null;
    db.records.unshift(rec);                       // 新的在前，列表天然按时间倒序
    if (db.records.length > KEEP) db.records.length = KEEP;
    db.recordSeq = (Number(db.recordSeq) || 0) + 1;
    store.save();
    return rec;
  } catch (e) {
    console.error('[records] 落生图记录失败（不影响任务）：' + (e && e.message));
    return null;
  }
}

/* ---------------- 查询 ---------------- */

const dateOf = (r) => String(r.at || '').slice(0, 10);

function filtered(db, q) {
  const o = q || {};
  let list = Array.isArray(db.records) ? db.records.slice() : [];
  /* 项目 / 工作区作用域必须由**后端**过滤，不能让前端拉全量再自己筛（指令 §29）。
     旧记录在 v1→v2 迁移时已补上归属，所以这里不会漏掉历史数据。 */
  if (o.projectId && o.projectId !== 'all') list = list.filter((r) => r.projectId === o.projectId);
  if (o.workspaceId && o.workspaceId !== 'all') list = list.filter((r) => r.workspaceId === o.workspaceId);
  /* 按分镜过滤：产物预览要列「这个分镜的历史产物」，数据源就是它历次生成的记录。
     （记录里每条都带自己那一次的 videoUrl / coverUrl 快照，所以历史是完整且不可变的。） */
  if (o.storyboardId && o.storyboardId !== 'all') list = list.filter((r) => r.storyboardId === o.storyboardId);
  /* 按类型过滤（video / image）。历史记录没有 kind 字段，一律按 video 处理。 */
  if (o.kind && o.kind !== 'all') list = list.filter((r) => (r.kind || 'video') === o.kind);
  if (o.action && o.action !== 'all') list = list.filter((r) => r.action === o.action);
  if (o.outcome && o.outcome !== 'all') list = list.filter((r) => r.outcome === o.outcome);
  if (o.engine && o.engine !== 'all') list = list.filter((r) => r.engine === o.engine);
  if (o.model && o.model !== 'all') list = list.filter((r) => r.model === o.model);
  if (o.from) list = list.filter((r) => dateOf(r) >= String(o.from));
  if (o.to) list = list.filter((r) => dateOf(r) <= String(o.to));
  const kw = o.keyword ? String(o.keyword).trim().toLowerCase() : '';
  if (kw) {
    list = list.filter((r) => [
      r.summary, r.prompt, r.title, r.command, r.errorMessage, r.errorCode,
      r.remoteId, r.submitId, r.model, r.modelLabel, r.storyboardId,
      /* 生图记录的关键词检索面：素材名与提供方/模型标签。少了素材名，
         用户按素材名搜生图历史会一条都搜不到（那正是最自然的搜法）。 */
      r.assetName, r.assetId, r.providerId, r.providerLabel, r.imageFormat,
      (r.images || []).map((x) => x.name).join(' ')
    ].filter(Boolean).join(' ').toLowerCase().includes(kw));
  }
  return list;
}

function lite(r) {
  return {
    id: r.id, at: r.at,
    /* 类型：历史记录没有该字段 → 一律 video。列表要据此分支（生图行没有镜头号）。 */
    kind: r.kind || 'video',
    /* 归属与生成时的名称快照：列表与导出都要能显示"这条属于哪个项目/页面"，
       且名称取自记录本身而不是现查（项目改名后仍显示当时的名字）。 */
    projectId: r.projectId || null, projectName: r.projectName || null,
    workspaceId: r.workspaceId || null, workspaceName: r.workspaceName || null,
    storyboardTitle: r.storyboardTitle || null,
    action: r.action, actionLabel: ACTION_LABEL[r.action] || r.action,
    outcome: r.outcome, outcomeLabel: OUTCOME_LABEL[r.outcome] || r.outcome,
    engine: r.engine, engineLabel: r.engineLabel,
    model: r.model, modelLabel: r.modelLabel, cliModel: r.cliModel, mode: r.mode,
    seq: r.seq, storyboardId: r.storyboardId,
    title: r.title, summary: r.summary, promptChars: r.promptChars,
    imageCount: (r.images || []).length,
    audioCount: (r.audios || []).length,
    ratio: r.params && r.params.ratio, resolution: r.params && r.params.resolution,
    durationSec: r.params && r.params.durationSec,
    elapsedMs: r.elapsedMs, finishedAt: r.finishedAt,
    videoUrl: r.videoUrl || null,
    /* coverUrl 也要下发：产物预览的「历史产物」列表用它做每条的小缩略图，
       切换时还要把它设成 <video> 的 poster（否则换到别的产物后，播放前那一帧还是旧的）。 */
    coverUrl: r.coverUrl || null,
    /* submitId 必须下发：同一个分镜生成多次时，它是**唯一能严格区分两次**的标识
       （产物预览的「历史产物」列表就靠它 + 生成时刻来标明"哪一次是哪一次"）。
       原来 lite() 没带这个字段，列表里拿不到，只能在详情里看。 */
    submitId: r.submitId || null,
    errorCode: r.errorCode || null,
    /* 失败分类（生图记录带 errorKind；视频记录恒为 null）。列表行要能直说
       "为什么失败"（审核 / 余额 / 限流…），所以一并下发。 */
    errorKind: r.errorKind || null,
    shortError: r.errorMessage ? clip(r.errorMessage, 90) : null,

    /* ---- 生图记录专用（视频行恒为 null，不影响既有字段）----
       为什么放在同一份 lite() 而不是另开函数：列表/导出是同一张表，
       分两份会让"是否带了某字段"随路径而异，前端就得写两套取值逻辑。 */
    assetId: r.assetId || null,
    assetName: r.assetName || null,
    providerId: r.providerId || null,
    providerLabel: r.providerLabel || null,
    modelId: r.modelId || null,
    size: r.size || null,
    imageWidth: r.imageWidth || null,
    imageHeight: r.imageHeight || null,
    imageFormat: r.imageFormat || null,
    usage: r.usage || null,
    applied: !!(r.kind === 'image' && r.appliedFile),
    /* 结果图地址：**读时现拼**（paths.js 唯一事实来源），文件已清理则为 null */
    resultUrl: (r.kind || 'video') === 'image' ? imageResultUrl(r) : null
  };
}

function statsOf(list) {
  /* byEngine 保留 canvas 桶**只为统计 2026-09-18 之前落下的历史记录**：
     新记录恒为 dreamina（画布 CLI 已移除）。若把桶删掉，历史记录会在统计里凭空消失。
     ⚠ 生图记录的 engine 是 providerId（如 work-fisher），不在桶里 → 不计入 byEngine，
       两个既有计数器的语义完全不变。 */
  const s = { total: list.length, succeeded: 0, failed: 0, canceled: 0, previewed: 0, images: 0, audioCount: 0, byEngine: { dreamina: 0, canvas: 0 }, byAction: { generate: 0, dryrun: 0 }, byKind: { video: 0, image: 0 } };
  list.forEach((r) => {
    if (s[r.outcome] != null) s[r.outcome]++;
    if (s.byEngine[r.engine] != null) s.byEngine[r.engine]++;
    if (s.byAction[r.action] != null) s.byAction[r.action]++;
    /* 类型计数：缺字段按 video（历史记录）。byKind 供筛选条「全部 / 视频 / 生图」带计数。 */
    const k = r.kind || 'video';
    if (s.byKind[k] != null) s.byKind[k]++;
    s.images += (r.images || []).length;
    s.audioCount += (r.audios || []).length;
  });
  s.withVideo = list.filter((r) => r.videoUrl && !/^cli:/.test(r.videoUrl)).length;
  return s;
}

function listRecords(db, q) {
  const o = q || {};
  const all = filtered(db, o);
  const page = Math.max(1, Number(o.page || 1));
  const pageSize = Math.min(200, Math.max(5, Number(o.pageSize || 20)));
  const slice = all.slice((page - 1) * pageSize, page * pageSize);
  return {
    list: slice.map(lite),
    page, pageSize, total: all.length,
    pageCount: Math.max(1, Math.ceil(all.length / pageSize)),
    stats: statsOf(all),
    kept: (db.records || []).length,
    capacity: KEEP
  };
}

function getRecord(db, id) {
  const r = (db.records || []).find((x) => x.id === id);
  return r || null;
}

function deleteRecord(db, id) {
  const before = (db.records || []).length;
  db.records = (db.records || []).filter((x) => x.id !== id);
  const removed = before - db.records.length;
  if (removed) store.save();
  return { removed: removed };
}

/**
 * 清空。四种口径，必须显式给一种，避免"手滑清库"：
 *   { ids: [...] }     只删这些 id
 *   { before: ISO }    删该时间点之前的
 *   { action: 'dryrun' | 'generate' }  只删某一类（例：清掉全部干跑记录）
 *   { all: true }      全清（前端需二次确认）
 */
function clearRecords(db, body) {
  const b = body || {};
  const all = Array.isArray(db.records) ? db.records : [];
  /* 作用域（指令 §29）：只清理**本项目**的记录。
     ⚠ 原来 {all:true} 会清掉全库历史 —— 多项目之后那就是把别的项目的记录一起抹掉，
     属于数据事故。projectId 缺失时保持旧的全量行为，供兼容路径使用。 */
  const inScope = (r) => !b.projectId || !r || !r.projectId || r.projectId === b.projectId;
  let removed = 0;
  const keep = (hit) => { if (hit) removed++; return !hit; };

  if (Array.isArray(b.ids) && b.ids.length) {
    const ids = new Set(b.ids);
    db.records = all.filter((r) => keep(inScope(r) && ids.has(r.id)));
  } else if (b.before) {
    db.records = all.filter((r) => keep(inScope(r) && String(r.at || '') < String(b.before)));
  } else if (b.action) {
    db.records = all.filter((r) => keep(inScope(r) && r.action === b.action));
  } else if (b.all === true) {
    db.records = all.filter((r) => keep(inScope(r)));
  } else {
    return { removed: 0, kept: all.length, message: '未指定清理口径（ids / before / action / all），未做任何改动' };
  }
  store.save();
  return { removed: removed, kept: (db.records || []).length };
}

/* ---------------- 导出 ---------------- */

const fmtElapsed = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');
const fmtParams = (r) => {
  const p = r.params || {};
  return [p.ratio, p.resolution, (p.durationSec != null ? p.durationSec + 's' : null)].filter(Boolean).join(' · ');
};
const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
/* 类型判定：缺 kind 的历史记录一律 video（与 filtered/lite 同一口径）。 */
const isImageRec = (r) => (r.kind || 'video') === 'image';
const imageDims = (r) => (r.imageWidth && r.imageHeight ? r.imageWidth + '×' + r.imageHeight : null);
/* 费用原样快照 → 一句可读文本。各家 usage 形状不同（credits / tokens / currency），
   这里只做扁平化展示，**不折算**（折算要 provider 知识，属于记录层之外）。 */
const fmtUsage = (u) => {
  if (!u || typeof u !== 'object') return '';
  return Object.keys(u).filter((k) => u[k] != null && u[k] !== '').map((k) => k + '=' + u[k]).join(' · ');
};

function exportRecords(db, q, format) {
  const list = filtered(db, q);
  const f = String(format || 'md').toLowerCase();
  const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19);
  const base = '生成记录_' + stamp;

  if (f === 'json') {
    return { filename: base + '.json', mime: 'application/json; charset=utf-8', content: JSON.stringify({ exportedAt: nowIso(), total: list.length, records: list }, null, 2) };
  }

  if (f === 'csv') {
    /* ⚠ 列顺序**不能改**（既有下游/用户脚本按位置读）；「类型」作为**最后一列**追加，
       这样视频行的既有 20 列位置一个都不动，生图行也不会错列。 */
    const head = ['时间', '项目', '分镜表', '动作', '结果', '引擎', '模型', 'CLI 型号', '镜头', '摘要', '画幅', '分辨率', '时长s', '图片数', '音频数', '耗时s', '提交ID', '产物地址', '错误码', '错误信息', '类型'];
    const rows = list.map((r) => {
      const img = isImageRec(r);
      const p = r.params || {};
      /* 生图行：没有分镜号，用「素材：<名字>」占摘要位；画幅/分辨率取 size/resolution；
         产物地址取**结果图**（现拼的本地地址）。列数与非生图行完全一致。 */
      const summary = img ? (['素材：' + (r.assetName || '—'), r.summary].filter(Boolean).join(' · ')) : r.summary;
      return [
        r.at, r.projectName || r.projectId || '', r.workspaceName || r.workspaceId || '',
        ACTION_LABEL[r.action] || r.action, OUTCOME_LABEL[r.outcome] || r.outcome,
        r.engineLabel, r.model, r.cliModel,
        img ? '' : r.seq, summary,
        img ? (r.size || '') : p.ratio, img ? (r.resolution || '') : p.resolution, img ? '' : p.durationSec,
        (r.images || []).length, (r.audios || []).length,
        r.elapsedMs == null ? '' : (r.elapsedMs / 1000).toFixed(1),
        r.submitId || '', img ? (imageResultUrl(r) || '') : (r.videoUrl || ''),
        r.errorCode || '', (r.errorMessage || '').replace(/\s+/g, ' '),
        img ? '生图' : '视频'
      ].map(csvCell).join(',');
    });
    // BOM：Windows Excel 直接双击打开时中文才不会乱码
    return { filename: base + '.csv', mime: 'text/csv; charset=utf-8', content: '\ufeff' + head.map(csvCell).join(',') + '\r\n' + rows.join('\r\n') };
  }

  const lines = ['# 生成记录导出', '', '- 导出时刻：' + nowIso(), '- 记录条数：' + list.length, ''];
  const s = statsOf(list);
  lines.push('| 口径 | 条数 |', '| --- | --- |');
  lines.push('| 成功 | ' + s.succeeded + ' |', '| 失败 | ' + s.failed + ' |', '| 已取消 | ' + s.canceled + ' |', '| 干跑预览 | ' + s.previewed + ' |');
  lines.push('| 视频生成 | ' + s.byKind.video + ' |', '| 图片生图 | ' + s.byKind.image + ' |');
  lines.push('| 创作 CLI | ' + s.byEngine.dreamina + ' |');
  /* 画布 CLI 这一行只在确实存在历史记录时才输出 —— 否则导出里会永远挂着一行 0 */
  if (s.byEngine.canvas > 0) lines.push('| 画布 CLI（历史记录，已移除） | ' + s.byEngine.canvas + ' |');
  lines.push('');
  lines.push('---', '');
  list.forEach((r, i) => {
    const img = isImageRec(r);
    lines.push('## ' + (i + 1) + '. ' + r.at + ' · ' + (ACTION_LABEL[r.action] || r.action) + ' · ' + (OUTCOME_LABEL[r.outcome] || r.outcome));
    lines.push('');
    /* 项目/页面用**生成时的名称快照**，而不是现查 —— 改名或软删后这里仍显示当时的名字 */
    lines.push('- 归属：' + (r.projectName || r.projectId || '—') + ' › ' + (r.workspaceName || r.workspaceId || '—'));
    if (img) {
      /* 生图记录没有分镜/命令，改为素材 + 服务商 + 尺寸 + 费用 + 结果图。 */
      lines.push('- 素材：' + (r.assetName || '—') + '（' + (r.assetId || '—') + '）');
      lines.push('- 服务商：' + (r.providerLabel || r.providerId || '—') + ' · 模型 ' + (r.modelLabel || r.model || '—'));
      lines.push('- 参数：' + ([r.size, r.resolution, imageDims(r)].filter(Boolean).join(' · ') || '—') + ' · 耗时 ' + fmtElapsed(r.elapsedMs));
      if (fmtUsage(r.usage)) lines.push('- 费用：' + fmtUsage(r.usage));
      const url = imageResultUrl(r);
      if (url) lines.push('- 结果图：' + url);
      if (r.errorCode || r.errorMessage) lines.push('- 错误：' + [r.errorCode, r.errorMessage].filter(Boolean).join(' '));
      lines.push('', '### 提示词原文', '', '```', r.prompt || '（空）', '```', '');
      return;
    }
    lines.push('- 镜头：' + r.seq + '（分镜 ' + r.storyboardId + '）');
    lines.push('- 引擎：' + r.engineLabel + ' · 模型 ' + r.model + (r.modelLabel ? '（' + r.modelLabel + '）' : '') + ' → CLI 型号 ' + (r.cliModel || '—'));
    lines.push('- 参数：' + (fmtParams(r) || '—') + ' · 耗时 ' + fmtElapsed(r.elapsedMs));
    if (r.images && r.images.length) lines.push('- 素材锁定：' + r.images.map((x) => '图片' + x.n + '=' + x.name + '（' + x.roleLabel + '）').join('、'));
    if (r.audios && r.audios.length) lines.push('- 音频参考：' + r.audios.map((x) => '音频' + x.n + '=' + x.name).join('、'));
    if (r.submitId) lines.push('- 提交 ID：' + r.submitId);
    if (r.videoUrl) lines.push('- 产物：' + r.videoUrl);
    if (r.errorCode) lines.push('- 错误：' + r.errorCode + ' ' + (r.errorMessage || ''));
    lines.push('', '### 提交命令', '', '```', r.command || '（无）', '```', '');
    lines.push('### 提示词原文', '', '```', r.prompt || '（空）', '```', '');
    if (r.lockBlock) lines.push('### 素材锁定 / 音频参考区块', '', '```', r.lockBlock, '```', '');
    lines.push('');
  });
  return { filename: base + '.md', mime: 'text/markdown; charset=utf-8', content: lines.join('\n') };
}

module.exports = {
  KEEP, ACTION_LABEL, OUTCOME_LABEL,
  append, snapshot, summaryOf,
  appendImage, imageSnapshot, imageResultUrl,
  listRecords, getRecord, deleteRecord, clearRecords, exportRecords,
  statsOf, lite
};
