'use strict';
/* ============================================================
   legacy-import.js —— 把旧版（网页版）server/data 里的数据搬进桌面版数据目录

   为什么需要它：桌面版把数据根从"安装目录下的 server/data"改成了用户可写目录
   （见 runtime-paths.js）。这个改动如果不管旧数据，用户装完桌面版打开就是**空库** ——
   之前的项目、素材、生成记录全都"不见了"（其实还在原目录里，只是没人去看）。

   所以首次启动：检测旧目录 → 问用户 → 备份 → 复制 → 校验 → 出报告 → 保留原目录。

   三条刻意的选择：
   1. **只读旧目录，绝不删改**。导入是"复制"不是"搬家"。用户确认新库没问题之前，
      旧目录必须原样在。代价是多占一份磁盘，换的是"导入出错也退得回去"。
   2. **复制前先备份目标库**。目标目录里已经有库（重复导入 / 用户已经建过项目）时，
      先把旧库整份挪进 backup/，而不是直接盖掉。
   3. **校验以"库里引用的文件在不在"为准**，不是"复制了几个文件"。数量对得上但
      引用全断的库，对用户来说照样是坏的。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const DB_FILE = 'db.json';
const BACKUP_PREFIX = 'db.json.bak-';

const dec = (s) => { try { return decodeURIComponent(String(s)); } catch (e) { return String(s); } };

/* ---------------- 定位候选旧目录 ----------------
   自动检测只在**能确定**的地方找：
     · JC_LEGACY_DIR 环境变量（用户/脚本显式指定，优先级最高）
     · 开发态（仓库里直接跑）：<仓库根>/server/data
     · 打包态：<resources>/legacy/server/data（将来若要随包附带旧库，放这里）
   打包态**不猜**用户机器上的其它路径 —— 猜错目录去提示"发现旧数据"比不提示更糟。
   打包态走人工：托盘菜单「从旧版导入数据…」让用户自己选文件夹。 */
function detectCandidates(opts) {
  const o = opts || {};
  const out = [];
  const push = (d) => {
    if (!d) return;
    const r = path.resolve(String(d));
    if (out.indexOf(r) < 0) out.push(r);
  };
  push(process.env.JC_LEGACY_DIR);
  if (!o.isPackaged && o.appPath) push(path.join(o.appPath, 'server', 'data'));
  if (o.resourcesPath) push(path.join(o.resourcesPath, 'legacy', 'server', 'data'));
  return out.filter(looksLikeLegacy);
}

/* 像不像一个旧库：必须有 db.json，且解析得出来。 */
function looksLikeLegacy(dir) {
  try {
    const f = path.join(dir, DB_FILE);
    if (!fs.statSync(f).isFile()) return false;
    JSON.parse(fs.readFileSync(f, 'utf8'));
    return true;
  } catch (e) { return false; }
}

/* ---------------- 地址 → 绝对路径（在**任意**根下求值） ----------------
   ⚠ 这里刻意**不复用 server/paths.js**：那个模块的根由 runtime 决定，
   永远是"当前生效的数据根"，而导入时必须能对**旧根**求值（要检查旧库里的文件
   在不在）。所以按同一套规则另写一份纯函数版本。规则与 paths.js 保持一致：
     /media/assets/<项目>/<文件>    → <根>/projects/<项目>/assets/<文件>
     /media/assets/<文件>（旧形状）→ <根>/projects/<项目>/assets/<文件> 或 <根>/assets/<文件>
     /files/<项目>/<分镜>/<文件>   → <根>/projects/<项目>/output/<分镜>/<文件>
     /files/<分镜>/<文件>（旧形状）→ <根>/output/<分镜>/<文件> */
function resolveAssetFile(root, url, projectIdHint) {
  const u = String(url || '');
  let m = /^\/media\/assets\/([^/]+)\/([^/]+)$/.exec(u);
  if (m) return path.join(root, 'projects', dec(m[1]), 'assets', dec(m[2]));
  m = /^\/media\/assets\/([^/]+)$/.exec(u);
  if (!m) return null;
  const file = dec(m[1]);
  if (projectIdHint) {
    const inNew = path.join(root, 'projects', String(projectIdHint), 'assets', file);
    if (fs.existsSync(inNew)) return inNew;
  }
  return path.join(root, 'assets', file);
}

function resolveOutputFile(root, url) {
  const u = String(url || '');
  let m = /^\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u);
  if (m) return path.join(root, 'projects', dec(m[1]), 'output', dec(m[2]), dec(m[3]));
  m = /^\/files\/([^/]+)\/([^/]+)$/.exec(u);
  if (m) return path.join(root, 'output', dec(m[1]), dec(m[2]));
  return null;
}

/* cli: 开头的不是文件地址，是"远端资源句柄"，不该当文件校验（见 records.js）。 */
const isRemoteRef = (u) => /^cli:/i.test(String(u || ''));

function countFiles(dir, re) {
  let n = 0;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    items.forEach((it) => {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (re.test(it.name)) n++;
    });
  };
  walk(dir);
  return n;
}

/* ---------------- 体检：这个旧库有什么、缺什么 ---------------- */
function inspect(dir) {
  const dbFile = path.join(dir, DB_FILE);
  let db;
  try {
    db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  } catch (e) {
    return { ok: false, dir, error: 'db.json 读不出来：' + e.message };
  }
  const projects = (db.projects || []).filter(Boolean);
  const workspaces = (db.workspaces || []).filter(Boolean);
  const storyboards = (db.storyboards || []).filter(Boolean);
  const assets = (db.assets || []).filter(Boolean);
  const records = (db.records || []).filter(Boolean);

  /* 引用完整性：逐个引用去磁盘上找。去重是必须的 ——
     同一个封面会被分镜和它的历史记录同时引用，不去重会把缺失数虚报一遍。 */
  const seen = new Set();
  const missing = [];
  const check = (file, label) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    if (!fs.existsSync(file)) missing.push({ label, path: file });
  };
  assets.forEach((a) => {
    check(resolveAssetFile(dir, a.url, a.projectId), '素材 ' + (a.name || a.id || '?'));
    if (a.thumbUrl) check(resolveAssetFile(dir, a.thumbUrl, a.projectId), '素材缩略图 ' + (a.id || '?'));
  });
  storyboards.forEach((sb) => {
    ['videoUrl', 'coverUrl', 'currentFrameUrl'].forEach((k) => {
      if (!sb[k] || isRemoteRef(sb[k])) return;
      check(resolveOutputFile(dir, sb[k]), '分镜 ' + (sb.id || '?') + ' 的 ' + k);
    });
  });
  records.forEach((r) => {
    ['videoUrl', 'coverUrl'].forEach((k) => {
      if (!r[k] || isRemoteRef(r[k])) return;
      check(resolveOutputFile(dir, r[k]), '记录 ' + (r.id || '?') + ' 的 ' + k);
    });
  });

  const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)$/i;
  return {
    ok: true,
    dir,
    schemaVersion: Number(db.schemaVersion) || 1,
    dbBytes: (() => { try { return fs.statSync(dbFile).size; } catch (e) { return 0; } })(),
    counts: {
      projects: projects.length,
      workspaces: workspaces.length,
      storyboards: storyboards.length,
      assets: assets.length,
      records: records.length
    },
    files: {
      videos: countFiles(path.join(dir, 'projects'), VIDEO_RE) + countFiles(path.join(dir, 'output'), VIDEO_RE),
      checked: seen.size
    },
    missing
  };
}

/* ---------------- 递归复制（幂等） ----------------
   目标已存在且大小一致就跳过：重复导入时不该把几百 MB 视频再写一遍，
   也不该因为"文件已存在"直接报错失败。 */
function copyTree(src, dst, acc) {
  let items;
  try { items = fs.readdirSync(src, { withFileTypes: true }); } catch (e) { return acc; }
  fs.mkdirSync(dst, { recursive: true });
  items.forEach((it) => {
    const from = path.join(src, it.name);
    const to = path.join(dst, it.name);
    if (it.isDirectory()) { copyTree(from, to, acc); return; }
    if (!it.isFile()) return;                       // 符号链接/设备文件一律跳过
    let size = 0;
    try { size = fs.statSync(from).size; } catch (e) { return; }
    if (fs.existsSync(to)) {
      try { if (fs.statSync(to).size === size) { acc.skipped++; return; } } catch (e) { /* 覆盖 */ }
    }
    fs.copyFileSync(from, to);
    /* 复制后立刻比大小：磁盘满时 copyFileSync 可能只写了一半，
       不校验就会得到一个"看起来导入成功、其实视频损坏"的库。 */
    if (fs.statSync(to).size !== size) throw new Error('复制后大小不一致：' + to);
    acc.files++; acc.bytes += size;
  });
  return acc;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/* ---------------- 导入 ----------------
   顺序刻意是"先备份、再复制、最后校验"：任何一步失败，用户手上都还有
   （a）未被动过的旧目录，（b）backup/ 里的导入前目标库。 */
function importInto(srcDir, targetDir, opts) {
  const o = opts || {};
  const src = path.resolve(String(srcDir));
  const dst = path.resolve(String(targetDir));
  if (src === dst) throw new Error('旧目录和目标目录是同一个，无需导入');
  /* 互相包含时递归复制会自己吃自己（无限增长直到磁盘满），必须挡在前面 */
  if (dst.startsWith(src + path.sep)) throw new Error('目标目录在旧目录里面，会造成递归复制');
  if (src.startsWith(dst + path.sep)) throw new Error('旧目录在目标目录里面，会造成递归复制');
  if (!looksLikeLegacy(src)) throw new Error('这个目录里没有可用的 db.json：' + src);

  fs.mkdirSync(dst, { recursive: true });

  /* ① 目标已有库 → 整份挪进 backup/。不动原文件，只复制一份存档。 */
  let backupDir = null;
  const dstDb = path.join(dst, DB_FILE);
  if (fs.existsSync(dstDb)) {
    backupDir = path.join(dst, 'backup', 'pre-import-' + stamp());
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(dstDb, path.join(backupDir, DB_FILE));
    fs.readdirSync(dst).filter((n) => n.startsWith(BACKUP_PREFIX)).forEach((n) => {
      try { fs.copyFileSync(path.join(dst, n), path.join(backupDir, n)); } catch (e) { /* 尽力而为 */ }
    });
  }

  const acc = { files: 0, skipped: 0, bytes: 0 };

  /* ② 数据库 + 它自己的历史备份 */
  fs.copyFileSync(path.join(src, DB_FILE), dstDb);
  acc.files++;
  acc.bytes += fs.statSync(dstDb).size;
  fs.readdirSync(src).filter((n) => n.startsWith(BACKUP_PREFIX)).forEach((n) => {
    const to = path.join(dst, n);
    if (fs.existsSync(to)) { acc.skipped++; return; }
    try { fs.copyFileSync(path.join(src, n), to); acc.files++; acc.bytes += fs.statSync(to).size; } catch (e) { /* 尽力而为 */ }
  });

  /* ③ 资源：新布局 projects/ 与两种旧布局 assets/ + output/ 都要带上。
       旧布局即使"地址已经迁过"也可能残留无引用文件，漏掉就是丢素材。 */
  ['projects', 'assets', 'output'].forEach((name) => {
    const from = path.join(src, name);
    if (fs.existsSync(from)) copyTree(from, path.join(dst, name), acc);
  });

  /* ④ 校验：以**新目录**为准再体检一次，报告里直接给"还有没有缺文件" */
  const report = inspect(dst);
  return {
    ok: !!(report.ok && report.missing.length === 0),
    src, dst, backupDir,
    copied: { files: acc.files, skipped: acc.skipped, bytes: acc.bytes },
    report,
    before: o.before || null
  };
}

function mb(n) { return (Number(n || 0) / 1048576).toFixed(1) + ' MB'; }

/* 给人看的迁移报告（对话框正文）。缺失文件**必须列出来**：
   那是用户唯一能判断"这次导入丢没丢东西"的依据。 */
function summarize(r, maxMissing) {
  if (!r) return '（无报告）';
  const c = (r.report && r.report.counts) || {};
  const f = (r.report && r.report.files) || {};
  const lines = [
    '旧目录：' + r.src,
    '新目录：' + r.dst,
    '',
    '已导入：项目 ' + (c.projects || 0) + ' 个 · 分镜表 ' + (c.workspaces || 0) + ' 张 · 分镜 ' + (c.storyboards || 0) + ' 个',
    '　　　　素材 ' + (c.assets || 0) + ' 个 · 生成记录 ' + (c.records || 0) + ' 条 · 视频文件 ' + (f.videos || 0) + ' 个',
    '复制文件 ' + (r.copied.files || 0) + ' 个（' + mb(r.copied.bytes) + '）'
      + (r.copied.skipped ? '，跳过已存在 ' + r.copied.skipped + ' 个' : '')
  ];
  if (r.backupDir) lines.push('导入前备份：' + r.backupDir);
  const missing = (r.report && r.report.missing) || [];
  if (!missing.length) lines.push('', '文件完整性：库里的引用全部找到了对应文件。');
  else {
    const cap = maxMissing || 10;
    lines.push('', '⚠ 有 ' + missing.length + ' 处引用找不到文件（导入不会丢库，但这些素材/产物在界面上会是空）：');
    missing.slice(0, cap).forEach((m) => lines.push('　· ' + m.label));
    if (missing.length > cap) lines.push('　…… 其余 ' + (missing.length - cap) + ' 处见日志');
  }
  lines.push('', '旧目录已原样保留，确认无误后可自行删除。');
  return lines.join('\n');
}

/* 把导入报告写成磁盘上的一份档案（2026-09-21，清单 §11）。
   为什么要落盘而不是只打日志：
     · 打包后的桌面版**没有终端**，console.log 用户根本看不到；
     · 缺失引用清单可能几十上百条，对话框只显示前 10 条；
     · 出问题时（"我导入后素材少了"）需要一份**导入当时**的可回查记录 ——
       而库本身已经被导入覆盖，无法从中反推"当时缺了什么"。
   落点：<数据目录>/backup/import-report-<时间>.txt
     选 backup/ 而非 logs/：它属于"数据历史"，用户换盘/迁移时会跟着走；
     logs/ 是运行日志，容易被清理，也不该混入用户数据。
   返回写入路径；失败返回 null（调用方只记警告 —— 报告写不出来不该影响导入结果）。 */
function writeReport(targetDir, res) {
  if (!targetDir || !res) return null;
  const dir = path.join(String(targetDir), 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, 'import-report-' + stamp + '.txt');
  const c = (res.report && res.report.counts) || {};
  const f = (res.report && res.report.files) || {};
  const missing = (res.report && res.report.missing) || [];
  const head = [
    '旧数据导入报告',
    '时间：' + new Date().toISOString(),
    '结果：' + (res.ok ? '成功（引用全部找到）' : '完成，但有缺失引用'),
    '',
    '源目录：' + res.src,
    '目标目录：' + res.dst,
    res.backupDir ? '导入前备份：' + res.backupDir : '导入前备份：（目标原本没有库，无需备份）',
    '',
    '—— 库内容 ——',
    '项目 ' + (c.projects || 0) + ' 个 · 分镜表 ' + (c.workspaces || 0) + ' 张 · 分镜 ' + (c.storyboards || 0) + ' 个',
    '素材 ' + (c.assets || 0) + ' 个 · 生成记录 ' + (c.records || 0) + ' 条 · 视频文件 ' + (f.videos || 0) + ' 个',
    '',
    '—— 复制 ——',
    '复制文件 ' + (res.copied.files || 0) + ' 个（' + mb(res.copied.bytes) + '）'
      + (res.copied.skipped ? '，跳过已存在 ' + res.copied.skipped + ' 个' : ''),
    '',
    '—— 缺失引用（' + missing.length + ' 处）——'
  ];
  /* 报告里不给缺失清单设上限 —— 这正是落盘的意义所在（对话框那边才需要截断）。 */
  const body = missing.length
    ? missing.map((m) => '  ' + (m.label || '') + '  →  ' + (m.path || ''))
    : ['  （无）'];
  const tail = [
    '',
    '说明：导入是复制而非搬家，源目录未被改动，确认无误后可自行删除。',
    '若存在缺失引用：库本身是完整的，但对应素材/产物在界面上会显示为空；',
    '可按上面的路径去源目录找回文件，再从界面重新上传。'
  ];
  fs.writeFileSync(file, head.concat(body, tail).join('\n') + '\n', 'utf8');
  return file;
}

module.exports = {
  DB_FILE, BACKUP_PREFIX,
  detectCandidates, looksLikeLegacy,
  resolveAssetFile, resolveOutputFile,
  countFiles, inspect, importInto, summarize, writeReport
};
