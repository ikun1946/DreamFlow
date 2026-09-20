'use strict';
/* ============================================================
   artifact-history.test.js —— 多次生成时「哪一次是哪一次」的正确性
   运行：node --test server/artifact-history.test.js

   背景（用户提问）："如果一个分镜生成两次，在结果与进度列表里我怎么查看我生成的两次视频？
   产物预览中我怎么分辨哪一次是哪一次"。核实过程中发现两个缺陷，本文件把它们钉住：

     ① **产物可能取到上一次的文件**：downloadResult 原来取"目录里第一个匹配的 mp4"，
        而 fs.readdirSync 是**按文件名排序、与时间无关**的，文件名又是随机 UUID ——
        等于随机取新旧。表现：第二次生成成功后，那条新记录挂着上一次的视频。
     ② **失败/取消的记录挂着上一次成功的产物**：records.snapshot 原来回退到 sb.videoUrl，
        而 mapTaskError / cancel 落记录时不传 videoUrl。

   顺带钉住：封面必须与**选中的那条视频**同源（不能"新视频配旧封面"），
   以及 records 支持按 storyboardId 过滤（产物预览的历史列表靠它）。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');
store.pushLog = () => {};
store.save = () => {};
store.saveNow = () => {};
store.flush = () => {};

const { makeDreaminaAdapter } = require('./dreamina-cli');
const REC = require('./records');
const adapter = makeDreaminaAdapter({ dreaminaCliPath: 'dreamina' });
const isVideo = (f) => /\.(mp4|mov|webm)$/i.test(f);

/* 临时目录：用 `_` 前缀（本就在 .gitignore 里），用完即删 */
const TMP = path.join(__dirname, '..', '_artifact_test_tmp');
function freshTmp(files) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  files.forEach((f, i) => {
    const p = path.join(TMP, f);
    fs.writeFileSync(p, 'x');
    /* 显式设置修改时间，避免"同一毫秒内建的文件"让 mtime 回退分支失去意义 */
    const t = new Date(Date.now() + i * 1000);
    fs.utimesSync(p, t, t);
  });
  return fs.readdirSync(TMP);
}

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

/* 两个 submit_id：刻意让**旧的那条在文件名排序上排在前面**，
   这样"按文件名取第一个"的旧实现会取到旧的 —— 正是缺陷①的形态。
   （readdirSync 按文件名排序：'0000…' < 'ffff…'，所以旧 id 用 0 开头、新 id 用 f 开头。） */
const OLD_ID = '00000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = 'ffffffff-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('缺陷①：产物按 submit_id 精确匹配，而不是"取文件名排第一的那个"', () => {
  const all = freshTmp([
    OLD_ID + '_video_1.mp4',
    NEW_ID + '_video_1.mp4',
  ]);
  assert.equal(all[0], OLD_ID + '_video_1.mp4',
    '前提：旧文件在 readdir 顺序里排在前（所以"取第一个"会取到旧的，即缺陷①的形态）');

  assert.equal(adapter.pickArtifact(TMP, all, NEW_ID, isVideo), NEW_ID + '_video_1.mp4',
    '给新 submit_id 时必须取到新文件 —— 这正是修复前会取错的地方');
  assert.equal(adapter.pickArtifact(TMP, all, OLD_ID, isVideo), OLD_ID + '_video_1.mp4',
    '给旧 submit_id 时必须取到旧文件');

  // 反向再验一次：把新文件造成排序在前的那个，结论必须不变
  const all2 = freshTmp([
    NEW_ID + '_video_1.mp4',
    OLD_ID + '_video_1.mp4',
  ]);
  assert.equal(adapter.pickArtifact(TMP, all2, OLD_ID, isVideo), OLD_ID + '_video_1.mp4',
    '换排序后仍必须按 submit_id 命中，不受文件名顺序影响');
});

test('缺陷①兜底：文件名里没有 submit_id 时，退回"修改时间最新的那个"（而不是随机取）', () => {
  const all = freshTmp(['aaa_video_1.mp4', 'zzz_video_1.mp4']);   // zzz 后建 → 更新
  assert.equal(adapter.pickArtifact(TMP, all, 'not-in-any-name', isVideo), 'zzz_video_1.mp4',
    '没有名字线索时应取最新的，而不是按文件名排序取第一个');
});

test('缺陷①：目录里只有本次的文件时正常取到；没有任何视频时返回 null', () => {
  const one = freshTmp([NEW_ID + '_video_1.mp4']);
  assert.equal(adapter.pickArtifact(TMP, one, NEW_ID, isVideo), NEW_ID + '_video_1.mp4');
  assert.equal(adapter.pickArtifact(TMP, one, 'other-id', isVideo), NEW_ID + '_video_1.mp4',
    '只有一个候选时退回它（仍是本次下载的产物）');
  const none = freshTmp(['readme.txt']);
  assert.equal(adapter.pickArtifact(TMP, none, NEW_ID, isVideo), null, '没有视频就返回 null');
});

test('封面必须与选中的视频同源（不能"新视频配旧封面"）', () => {
  const all = freshTmp([
    OLD_ID + '_video_1.mp4', OLD_ID + '_video_1_cover.jpg',
    NEW_ID + '_video_1.mp4', NEW_ID + '_video_1_cover.jpg',
  ]);
  const vNew = adapter.pickArtifact(TMP, all, NEW_ID, isVideo);
  const vOld = adapter.pickArtifact(TMP, all, OLD_ID, isVideo);
  assert.equal(adapter.pickCover(all, vNew, NEW_ID), NEW_ID + '_video_1_cover.jpg');
  assert.equal(adapter.pickCover(all, vOld, OLD_ID), OLD_ID + '_video_1_cover.jpg');
  assert.equal(adapter.pickCover(all, null, NEW_ID), null, '没有视频就没有封面');
});

/* ---------------- 缺陷②：记录不得继承上一次的产物 ---------------- */
function fakeDb(sb) {
  return {
    storyboards: [sb], assets: [],
    projects: [{ id: 'pj_1', name: 'P', settings: {}, deletedAt: null }],
    workspaces: [{ id: 'ws_1', projectId: 'pj_1', name: 'W', deletedAt: null }],
    settings: { queue: {}, adapter: {} }, cliJobs: {}, logs: {}, records: [], recordSeq: 0
  };
}
const makeSb = (extra) => Object.assign({
  id: 'st_x', projectId: 'pj_1', workspaceId: 'ws_1', seq: 1, prompt: 'p', status: 'generating',
  model: 'seedance2.0', durationSec: 5, ratio: '16:9', resolution: '720p', assets: [],
  videoUrl: '/files/st_x/OLD_video_1.mp4', coverUrl: '/files/st_x/OLD_video_1_cover.jpg'
}, extra || {});

test('缺陷②：失败记录不带产物 —— 绝不回退到分镜上上一次成功的 videoUrl', () => {
  const sb = makeSb();                       // 分镜上留着上一次成功的产物
  const db = fakeDb(sb);
  const rec = REC.snapshot(db, sb, { action: 'generate', outcome: 'failed', errorCode: '51004', errorMessage: '超时' });
  assert.equal(rec.videoUrl, null, '失败记录不得带产物（否则看起来像成功了）');
  assert.equal(rec.coverUrl, null, '失败记录不得带封面');
});

test('缺陷②：取消记录不带产物', () => {
  const sb = makeSb({ status: 'canceled' });
  const db = fakeDb(sb);
  const rec = REC.snapshot(db, sb, { action: 'generate', outcome: 'canceled' });
  assert.equal(rec.videoUrl, null);
  assert.equal(rec.coverUrl, null);
});

test('缺陷②：成功记录仍然带产物（调用方显式传入才写）', () => {
  const sb = makeSb({ status: 'succeeded' });
  const db = fakeDb(sb);
  const rec = REC.snapshot(db, sb, {
    action: 'generate', outcome: 'succeeded',
    videoUrl: '/files/st_x/NEW_video_1.mp4', coverUrl: '/files/st_x/NEW_video_1_cover.jpg'
  });
  assert.equal(rec.videoUrl, '/files/st_x/NEW_video_1.mp4', '成功记录必须带本次的产物');
  assert.equal(rec.coverUrl, '/files/st_x/NEW_video_1_cover.jpg');
  assert.notEqual(rec.videoUrl, sb.videoUrl, '不能是分镜上遗留的旧地址');
});

test('缺陷②：干跑记录显式传 null，也不带产物', () => {
  const sb = makeSb({ status: 'draft' });
  const db = fakeDb(sb);
  const rec = REC.snapshot(db, sb, { action: 'dryrun', outcome: 'previewed', videoUrl: null, coverUrl: null });
  assert.equal(rec.videoUrl, null);
});

/* ---------------- 历史产物列表的数据源：按 storyboardId 过滤 ---------------- */
test('records 支持按 storyboardId 过滤（产物预览的历史列表靠它）', () => {
  const sb = makeSb();
  const db = fakeDb(sb);
  db.records = [
    { id: 'rc_1', at: '2026-09-19T10:00:00Z', projectId: 'pj_1', storyboardId: 'st_x', action: 'generate', outcome: 'succeeded', videoUrl: '/files/st_x/A.mp4', params: {}, images: [], audios: [] },
    { id: 'rc_2', at: '2026-09-19T11:00:00Z', projectId: 'pj_1', storyboardId: 'st_x', action: 'generate', outcome: 'failed', videoUrl: null, params: {}, images: [], audios: [] },
    { id: 'rc_3', at: '2026-09-19T12:00:00Z', projectId: 'pj_1', storyboardId: 'st_y', action: 'generate', outcome: 'succeeded', videoUrl: '/files/st_y/C.mp4', params: {}, images: [], audios: [] }
  ];
  const mine = REC.listRecords(db, { storyboardId: 'st_x' });
  assert.equal(mine.total, 2, '只返回这个分镜的记录');
  assert.deepEqual(mine.list.map((r) => r.id).sort(), ['rc_1', 'rc_2']);

  /* 历史产物列表的口径：只取"真的有产物"的那些，且各带自己的时间与提交 ID */
  const withArt = mine.list.filter((r) => r.videoUrl && !/^cli:/.test(r.videoUrl));
  assert.equal(withArt.length, 1, '失败那条没有产物，不进历史列表');
  assert.equal(withArt[0].videoUrl, '/files/st_x/A.mp4');
});
