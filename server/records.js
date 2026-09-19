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

  return {
    id: rid('rc_'),
    at: nowIso(),
    projectId: sb.projectId || 'pj_1',
    storyboardId: sb.id,
    seq: sb.seq,

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
    videoUrl: o.videoUrl !== undefined ? o.videoUrl : (sb.videoUrl || null),
    coverUrl: o.coverUrl !== undefined ? o.coverUrl : (sb.coverUrl || null),

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
  if (Array.isArray(b.ids) && b.ids.length) {
    const ids = b.ids;
    db.records = all.filter((r) => !ids.includes(r.id));
  } else if (b.before) {
    db.records = all.filter((r) => String(r.at || '') >= String(b.before));
  } else if (b.action) {
    db.records = all.filter((r) => r.action !== b.action);
  } else if (b.all === true) {
    db.records = [];
  } else {
    return { removed: 0, kept: all.length, message: '未指定清理口径（ids / before / action / all），未做任何改动' };
  }
  const removed = all.length - db.records.length;
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
    const head = ['时间', '动作', '结果', '引擎', '模型', 'CLI 型号', '镜头', '摘要', '画幅', '分辨率', '时长s', '图片数', '音频数', '耗时s', '提交ID', '产物地址', '错误码', '错误信息'];
    const rows = list.map((r) => [
      r.at, ACTION_LABEL[r.action] || r.action, OUTCOME_LABEL[r.outcome] || r.outcome,
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
