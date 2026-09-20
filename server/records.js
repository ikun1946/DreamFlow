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
     · 身份    id / at / storyboardId / seq / projectId
     · 动作    action(generate|dryrun) / outcome(succeeded|failed|canceled|previewed)
     · 执行    engine / engineLabel / model / modelLabel / cliModel / mode
     · 参数    params{ratio,resolution,durationSec,motion,seed,negativePrompt}
     · 输入    prompt / promptWithLock / lockBlock / images[] / audios[] / skipped[]
     · 命令    command / argv / adapted[] / missing[] / refs[] / submitId
     · 产物    remoteId / resourceId / videoUrl / coverUrl
     · 结果    elapsedMs / startedAt / finishedAt / errorCode / errorMessage
   ============================================================ */
'use strict';

const store = require('./store');
const { nowIso, rid } = require('./util');
const AL = require('./asset-lock');
const models = require('./models');
const P = require('./projects');   // 项目/工作区归属与名称快照

const KEEP = 800;            // 最多保留的记录条数（新的在前，超出丢最旧）
const TEXT_CAP = 60000;      // 单条记录中单个文本字段的上限（防单条超大提示词把库撑爆）
const SUMMARY_LEN = 72;

const ACTION_LABEL = { generate: '真实生成', dryrun: '干跑' };
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
  const lockBlock = cat.images.length ? AL.lockBlock(cat.images, sb) : '';
  const prompt = String(sb.prompt == null ? '' : sb.prompt);
  const promptWithLock = lockBlock ? AL.compose(prompt, lockBlock) : prompt;
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
      (r.images || []).map((x) => x.name).join(' ')
    ].filter(Boolean).join(' ').toLowerCase().includes(kw));
  }
  return list;
}

function lite(r) {
  return {
    id: r.id, at: r.at,
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
    shortError: r.errorMessage ? clip(r.errorMessage, 90) : null
  };
}

function statsOf(list) {
  /* byEngine 保留 canvas 桶**只为统计 2026-09-18 之前落下的历史记录**：
     新记录恒为 dreamina（画布 CLI 已移除）。若把桶删掉，历史记录会在统计里凭空消失。 */
  const s = { total: list.length, succeeded: 0, failed: 0, canceled: 0, previewed: 0, images: 0, audioCount: 0, byEngine: { dreamina: 0, canvas: 0 }, byAction: { generate: 0, dryrun: 0 } };
  list.forEach((r) => {
    if (s[r.outcome] != null) s[r.outcome]++;
    if (s.byEngine[r.engine] != null) s.byEngine[r.engine]++;
    if (s.byAction[r.action] != null) s.byAction[r.action]++;
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

function exportRecords(db, q, format) {
  const list = filtered(db, q);
  const f = String(format || 'md').toLowerCase();
  const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19);
  const base = '生成记录_' + stamp;

  if (f === 'json') {
    return { filename: base + '.json', mime: 'application/json; charset=utf-8', content: JSON.stringify({ exportedAt: nowIso(), total: list.length, records: list }, null, 2) };
  }

  if (f === 'csv') {
    const head = ['时间', '项目', '分镜表', '动作', '结果', '引擎', '模型', 'CLI 型号', '镜头', '摘要', '画幅', '分辨率', '时长s', '图片数', '音频数', '耗时s', '提交ID', '产物地址', '错误码', '错误信息'];
    const rows = list.map((r) => [
      r.at, r.projectName || r.projectId || '', r.workspaceName || r.workspaceId || '',
      ACTION_LABEL[r.action] || r.action, OUTCOME_LABEL[r.outcome] || r.outcome,
      r.engineLabel, r.model, r.cliModel, r.seq, r.summary,
      (r.params || {}).ratio, (r.params || {}).resolution, (r.params || {}).durationSec,
      (r.images || []).length, (r.audios || []).length,
      r.elapsedMs == null ? '' : (r.elapsedMs / 1000).toFixed(1),
      r.submitId || '', r.videoUrl || '', r.errorCode || '', (r.errorMessage || '').replace(/\s+/g, ' ')
    ].map(csvCell).join(','));
    // BOM：Windows Excel 直接双击打开时中文才不会乱码
    return { filename: base + '.csv', mime: 'text/csv; charset=utf-8', content: '\ufeff' + head.map(csvCell).join(',') + '\r\n' + rows.join('\r\n') };
  }

  const lines = ['# 生成记录导出', '', '- 导出时刻：' + nowIso(), '- 记录条数：' + list.length, ''];
  const s = statsOf(list);
  lines.push('| 口径 | 条数 |', '| --- | --- |');
  lines.push('| 成功 | ' + s.succeeded + ' |', '| 失败 | ' + s.failed + ' |', '| 已取消 | ' + s.canceled + ' |', '| 干跑预览 | ' + s.previewed + ' |');
  lines.push('| 创作 CLI | ' + s.byEngine.dreamina + ' |');
  /* 画布 CLI 这一行只在确实存在历史记录时才输出 —— 否则导出里会永远挂着一行 0 */
  if (s.byEngine.canvas > 0) lines.push('| 画布 CLI（历史记录，已移除） | ' + s.byEngine.canvas + ' |');
  lines.push('');
  lines.push('---', '');
  list.forEach((r, i) => {
    lines.push('## ' + (i + 1) + '. ' + r.at + ' · ' + (ACTION_LABEL[r.action] || r.action) + ' · ' + (OUTCOME_LABEL[r.outcome] || r.outcome));
    lines.push('');
    lines.push('- 镜头：' + r.seq + '（分镜 ' + r.storyboardId + '）');
    /* 项目/页面用**生成时的名称快照**，而不是现查 —— 改名或软删后这里仍显示当时的名字 */
    lines.push('- 归属：' + (r.projectName || r.projectId || '—') + ' › ' + (r.workspaceName || r.workspaceId || '—'));
    lines.push('- 引擎：' + r.engineLabel + ' · 模型 ' + r.model + (r.modelLabel ? '（' + r.modelLabel + '）' : '') + ' → CLI 型号 ' + (r.cliModel || '—'));
    lines.push('- 参数：' + (fmtParams(r) || '—') + ' · 耗时 ' + fmtElapsed(r.elapsedMs));
    if (r.images && r.images.length) lines.push('- 素材锁定：' + r.images.map((x) => '图片' + x.n + '=' + x.name + '（' + x.roleLabel + '）').join('、'));
    if (r.audios && r.audios.length) lines.push('- 音频：' + r.audios.map((x) => '音频' + x.n + '=' + x.name).join('、'));
    if (r.submitId) lines.push('- 提交 ID：' + r.submitId);
    if (r.videoUrl) lines.push('- 产物：' + r.videoUrl);
    if (r.errorCode) lines.push('- 错误：' + r.errorCode + ' ' + (r.errorMessage || ''));
    lines.push('', '### 提交命令', '', '```', r.command || '（无）', '```', '');
    lines.push('### 提示词原文', '', '```', r.prompt || '（空）', '```', '');
    if (r.lockBlock) lines.push('### 素材锁定区块', '', '```', r.lockBlock, '```', '');
    lines.push('');
  });
  return { filename: base + '.md', mime: 'text/markdown; charset=utf-8', content: lines.join('\n') };
}

module.exports = {
  KEEP, ACTION_LABEL, OUTCOME_LABEL,
  append, snapshot, summaryOf,
  listRecords, getRecord, deleteRecord, clearRecords, exportRecords,
  statsOf, lite
};
