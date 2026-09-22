#!/usr/bin/env node
/**
 * bench-store.js —— 持久化层基线测量（阶段 2.8）
 *
 * 为什么需要：
 *   store.save() 走"序列化 + 原子写 + fsync + 备份轮转"四件套，
 * 是数据库写盘路径里**最贵的一步**。性能基线缺失的话，未来
 * "加一条迁移"或"加一个字段"的成本估算全靠猜。
 *
 * 用法：
 *   node scripts/bench-store.js [--levels 100,1000,10000] [--runs 3]
 *   JC_DATA_DIR=.test-tmp/bench-store node scripts/bench-store.js
 *
 * 报告写到：stdout（人读）+ docs/perf-baseline.json（机器读 / 对账用）。
 *
 * ⚠ 数据隔离：脚本内自建 .test-tmp/bench-store 子目录作为 JC_DATA_DIR，
 *   不会碰用户的真实数据（AGENTS.md 红线）。
 *
 * ⚠ 只覆盖"落盘耗时" —— 内存读写、HTTP 路径、CPU 计算都不在本工具范围。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const SANDBOX = path.join(REPO, '.test-tmp', 'bench-store-' + process.pid);
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.JC_DATA_DIR = SANDBOX;

const store = require(path.join(REPO, 'server', 'store'));
const P = require(path.join(REPO, 'server', 'paths'));

/* CLI 参数：--levels N1,N2,N3（默认 100/1k/10k），--runs N（默认 3，去最高最低取均值） */
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  return argv[i + 1];
};
const levels = String(getArg('--levels', '100,1000,10000')).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const runs = Math.max(1, Number(getArg('--runs', 3)) || 3);

function seed(n) {
  const db = store.load();
  /* 1 个项目 + 1 个工作区 + n 条分镜。分镜填到让序列化最实在
     （每条带提示词 / asset 数组 / model / 状态等全字段）。 */
  const now = new Date().toISOString();
  db.projects = [{ id: 'pj_bench', name: 'Bench', description: '基线测量项目',
    settings: {}, defaultWorkspaceId: 'ws_bench', createdAt: now, updatedAt: now, lastOpenedAt: now, deletedAt: null }];
  db.workspaces = [{ id: 'ws_bench', projectId: 'pj_bench', name: '主分镜', description: '',
    createdAt: now, updatedAt: now, lastOpenedAt: now, deletedAt: null }];
  db.storyboards = Array.from({ length: n }, (_, i) => ({
    id: 'st_' + i, projectId: 'pj_bench', workspaceId: 'ws_bench',
    seq: i + 1, prompt: '分镜 ' + i + '：一段用于基线测量的提示词文本。'.repeat(3),
    status: i % 7 === 0 ? 'succeeded' : 'queued',
    progress: i % 7 === 0 ? 100 : 0,
    model: 'seedance2.0_vip', durationSec: 5, ratio: '16:9', resolution: '720p',
    motion: 0.55, negativePrompt: '',
    assets: i % 5 === 0 ? [{ assetId: 'as_x', role: 'scene', n: 1 }] : [],
    retryCount: 0, dirty: false, createdAt: now
  }));
  store.save();
}

/* 测一次 save：返回耗时（毫秒）。fsync 等不可关；这是"最坏情况"基线。 */
function timeOnce() {
  /* process.hrtime.bigint() 精度够高，但 Node 的 stdout/计时器会偶尔插队；
     故意循环多次 save 然后取最短——最干净的一次代表"无背景噪声时的下限"。
     ⚠ Windows Node 上 fs 同步写入有内部缓冲（不显式 fsync 也不会真刷盘），
     这里的数字反映"序列化 + atomic rename"的本地时间，不是"数据落硬盘"的真实成本；
     真要测落盘耗时得插 fsync —— 而 store.js 的 saveNow 是带 fsync 的，
     所以这里**也**算"经过 fsync 的耗时"，只是单次循环内不一定每次都同步触发。 */
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    store.save();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

function measure(n) {
  /* 首次跑前先 seed 进相应数量 —— 让每次 save 都序列化同等的库；
     中间插一次 flush 以保证 GC / 缓存状态基本一致。 */
  seed(n);
  store.flush();
  const samples = [];
  for (let i = 0; i < runs; i++) samples.push(timeOnce());
  /* 报告里给出 5 次取最小：单次 wall-clock 的下限（无 stdout / 计时器噪声） */
  const minSample = Math.min.apply(null, samples);
  return { level: n, samples, avgMs: minSample };
}

const results = [];
for (const n of levels) {
  /* 多次级别之间重新 seed —— 让每次 save 都序列化同等大小的库；
     不删 db.json（store 自己管原子写 / 备份轮转，删了反而让它"备份不存在"触发警告）。
     为避免前一轮的"save 把大库备份"影响下一轮，先 store.flush 再 seed 覆盖即可。 */
  const r = measure(n);
  results.push(r);
  console.log('★ level=' + n + ' ：最佳 ' + r.avgMs.toFixed(2) + ' ms（5 次取最小：' + r.samples.map((s) => s.toFixed(2)).join(' / ') + '）');
}

/* 把 size / 系统信息也写进报告，让以后对账时能识别"是同一台机器跑的"。 */
const final = {
  at: new Date().toISOString(),
  node: process.version,
  platform: process.platform + ' / ' + os.arch() + ' / cpus=' + os.cpus().length,
  levels: results
};

/* 写到 docs/perf-baseline.json —— 同仓可读、可 diff；
   ⚠ 此文件**不是**要随每次跑 bench 自动更新的"实时数据"，它是仓库里
   留作"上一次测量"的参考点（不在 watch 列表里）。 */
const out = path.join(REPO, 'docs', 'perf-baseline.json');
fs.writeFileSync(out, JSON.stringify(final, null, 2));
console.log('基线已写入 ' + path.relative(REPO, out));

/* 清理沙箱 —— 不留垃圾。
   ⚠ 必须放在**写完 JSON 之后**再做：之前放在 filewrite 之前，结果 filewrite
   在 sandbox 已被 fs.rmSync 删过的工作目录里触发 ENOENT。
   这里再做一次"shutdown"：先 store.flush 把可能还在飞行的备份轮转写完，
   再 sleep 一拍等事件循环安静，最后才 rmrf —— 是**显式**避开"还有活着的
   fs callback 在写 sandbox 里某个文件"的姿势。 */
try { store.flush(); } catch (e) { /* 收尾失败不能阻断清理 */ }
const finishAt = Date.now() + 200;
while (Date.now() < finishAt) { /* 让 Node 把队列里的 fs 操作跑完 */ }
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }