'use strict';
/* ============================================================
   paths.js —— 磁盘布局与资源 URL 形状的**唯一事实来源**

   为什么要有这个文件（2026-09-20 用户要求"每个项目单独一个文件夹"）：
   在此之前素材是**全项目平铺**在 `data/assets/` 里的，视频产物在 `data/output/<分镜>/`。
   后果是"彻底删除一个项目"根本删不干净 —— 它的素材混在别的项目里，只能逐个文件挑。
   现在改成按项目分区：

     data/projects/<projectId>/
       ├── assets/<file>                    项目上传/引用的素材
       └── output/<storyboardId>/<file>     该项目的产物（视频 + 封面）

   于是"删项目 = 删一个文件夹"，物理隔离与逻辑隔离（Project 是数据隔离边界）对齐了。

   URL 形状也跟着带上了项目段（**自描述**，服务端不需要查库就能定位文件，
   且分镜被删后记录里的产物链接仍然有效）：

     /media/assets/<projectId>/<file>
     /files/<projectId>/<storyboardId>/<file>

   ⚠ 旧形状（`/media/assets/<file>`、`/files/<sb>/<file>`）仍被识别，
   但**只作为兜底**：迁移（schema v2→v3）成功后就该没有文件留在旧目录里。
   保留它是因为迁移是"全有或全无"的 —— 万一某个文件搬不动，迁移会中止、
   数据库停在旧地址，这时旧形状还得能服务。

   ⚠ 路径安全：`<projectId>` / `<storyboardId>` / `<file>` 都来自 URL，**逐段白名单校验**，
   再加上 resolve 后的目录包含性检查（双保险）。单靠 startsWith 是不够的 ——
   前缀相同但不同目录的情况（如 output 与 output-bak）会漏过去。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const configMod = require('./config');
const runtime = require('./runtime');

/* 根目录放在一个**可替换的对象**里，而不是三个模块级常量 —— 所有函数都在**调用时**
   读 roots，而不是在 require 时定死。这样"把根指到别处"是一个显式动作（setRoots），
   而不是靠覆盖一个常量（那是改不动的：2026-09-20 实测踩到，有段代码以为重定向了根，
   其实一路写进了真实的 data/projects/）。
   ⚠ 生产代码不要调用 setRoots —— 目前**没有任何调用方**（测试沙箱走的是
   runtime.configure → runtime.onChange(resetRoots) 这条路，见 test/helpers.js）。
   留着它是为了给"把根指到别处"一个明确的入口，而不是让人去覆盖常量。 */
/* 派生根的默认值**每次现算**：数据根可以被桌面版重定向（见 runtime.js），
   而这三个目录必须跟着走，否则会出现"库在用户目录、素材还在安装目录"的撕裂状态。 */
function defaultRoots() {
  const dataDir = configMod.DATA_DIR;
  return {
    projects: path.join(dataDir, 'projects'),
    /* 迁移前的旧位置。只在两处用到：v2→v3 迁移读取，以及服务端的兜底路由。 */
    legacyAssets: path.join(dataDir, 'assets'),
    legacyOutput: path.join(dataDir, 'output')
  };
}
/* null = 用默认值；setRoots 之后才是一份显式覆盖（当前只有沙箱会用到）。 */
let roots = null;
const R = () => (roots || (roots = defaultRoots()));
function setRoots(r) { roots = Object.assign(defaultRoots(), r || {}); return Object.assign({}, roots); }
function resetRoots() { roots = null; return Object.assign({}, R()); }
runtime.onChange(resetRoots);

/* id 白名单：本项目所有 id 都是 `<前缀>_<字母数字>` 形状（pj_ / ws_ / st_ / as_ / rc_） */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/* 文件名白名单：不含路径分隔符、不含 ..（素材文件名是 `as_xxx-时间戳.png` 这类） */
const FILE_RE = /^[A-Za-z0-9._-]{1,200}$/;

const safeId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
const safeFile = (v) => (typeof v === 'string' && FILE_RE.test(v) && v !== '.' && v !== '..' ? v : null);

const projectDir = (pj) => path.join(R().projects, pj);
const assetDir = (pj) => path.join(projectDir(pj), 'assets');
const outputDir = (pj) => path.join(projectDir(pj), 'output');
const sbOutputDir = (pj, sb) => path.join(outputDir(pj), sb);
/* 图片生图的候选图目录（2026-09-25）。
   为什么放在项目目录里、而不是系统临时目录：候选图是"用户待确认的资产"，
   它必须
     · 与项目数据同生共死 —— 迁移数据根时跟着走，彻底删项目时被一并清掉；
     · 不受系统清理工具（tmp 清理、磁盘清理）影响 —— 放 /tmp 会被静默删掉，
       用户回来看到"生成成功但图没了"。
   也不放安装目录：装到 Program Files 后那里只读。 */
const candidateDir = (pj) => path.join(projectDir(pj), 'image-candidates');
/* 候选图的 URL 形状。与 assets 分开命名空间，是为了让 resolveServePath 能
   对候选图施加**比素材更严**的校验（候选图只在图片下载并校验成功后可读，
   且永远不把服务商直链交给页面）。 */
const candidateUrl = (pj, file) => '/media/candidates/' + pj + '/' + encodeURIComponent(file);

/* ---------------- URL 构造 ---------------- */
const assetUrl = (pj, file) => '/media/assets/' + pj + '/' + encodeURIComponent(file);
const outputUrl = (pj, sb, file) => '/files/' + pj + '/' + sb + '/' + encodeURIComponent(file);

/* 从资源地址里取出 { projectId, filename }；不认识的形状返回 null。
   只解析 URL 里的字符串，不碰磁盘 —— 调用方拿到的 projectId 仍需自行校验存在性。 */
function parseAssetUrl(url) {
  const m = /^\/media\/assets\/([^/]+)\/([^/]+)$/.exec(String(url || ''));
  if (!m) return null;
  const pj = safeId(decodeURIComponent(m[1]));
  const file = safeFile(decodeURIComponent(m[2]));
  return pj && file ? { projectId: pj, filename: file } : null;
}
function parseOutputUrl(url) {
  const m = /^\/files\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(String(url || ''));
  if (!m) return null;
  const pj = safeId(decodeURIComponent(m[1]));
  const sb = safeId(decodeURIComponent(m[2]));
  const file = safeFile(decodeURIComponent(m[3]));
  return pj && sb && file ? { projectId: pj, storyboardId: sb, filename: file } : null;
}

/* 素材的绝对路径。优先用地址里的项目段；地址是旧形状时退回按素材记录上的 projectId 定位
   （迁移前落库的老素材）。两条路都定位不到就返回 null（调用方按"文件不存在"处理）。 */
function assetFileOf(asset, projectIdHint) {
  if (!asset) return null;
  const p = parseAssetUrl(asset.url);
  if (p) return path.join(assetDir(p.projectId), p.filename);
  const pj = safeId(asset.projectId || projectIdHint);
  const legacy = /^\/media\/assets\/([^/]+)$/.exec(String(asset.url || ''));
  if (!pj || !legacy) return null;
  const file = safeFile(decodeURIComponent(legacy[1]));
  if (!file) return null;
  /* 旧形状：文件既可能在旧平铺目录，也可能已经在新目录（迁移中途） */
  const inNew = path.join(assetDir(pj), file);
  if (fs.existsSync(inNew)) return inNew;
  return path.join(R().legacyAssets, file);
}

/* 产物目录（下载目标 / 封面落点）。projectId 必传 —— 调用方从分镜的工作区推导。 */
function sbOutputDirOf(projectId, storyboardId) {
  const pj = safeId(projectId);
  const sb = safeId(storyboardId);
  if (!pj || !sb) return null;
  return sbOutputDir(pj, sb);
}

/* 旧地址（迁移前落的库）里那条产物现在在哪：先看新目录，再看旧目录。
   只在"地址还是旧形状"时用到。 */
function legacyOutputFile(file) {
  return file ? path.join(R().legacyOutput, file) : null;
}

/* ---------------- 服务端静态路由：URL 路径 → 绝对路径 ----------------
   返回 null 表示"这个路径不该被服务"（形状不合法或越界）。 */
function resolveServePath(pathname) {
  if (pathname.startsWith('/media/assets/')) {
    const rest = pathname.slice('/media/assets/'.length);
    const parts = rest.split('/').map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
    if (parts.length === 2) {
      const pj = safeId(parts[0]), file = safeFile(parts[1]);
      if (!pj || !file) return null;
      return contained(assetDir(pj), path.join(assetDir(pj), file));
    }
    if (parts.length === 1) {
      /* 旧形状兜底：全项目平铺目录（迁移成功后应为空） */
      const file = safeFile(parts[0]);
      if (!file) return null;
      return contained(R().legacyAssets, path.join(R().legacyAssets, file));
    }
    return null;
  }
  /* 图片生图的候选图（2026-09-25）：形状与素材同构（项目段 + 文件名），
     但目录是候选图专用 —— **只有已通过校验的候选图才会落在那里**，
     所以这里不需要再判断"校验过没有"。文件名由服务端生成（见 image-jobs.js），
     不接受任何外部输入拼装。 */
  if (pathname.startsWith('/media/candidates/')) {
    const rest = pathname.slice('/media/candidates/'.length);
    const parts = rest.split('/').map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
    if (parts.length !== 2) return null;
    const pj = safeId(parts[0]), file = safeFile(parts[1]);
    if (!pj || !file) return null;
    const dir = candidateDir(pj);
    return contained(dir, path.join(dir, file));
  }
  if (pathname.startsWith('/files/')) {
    const rest = pathname.slice('/files/'.length);
    const parts = rest.split('/').map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
    if (parts.length === 3) {
      const pj = safeId(parts[0]), sb = safeId(parts[1]), file = safeFile(parts[2]);
      if (!pj || !sb || !file) return null;
      const dir = sbOutputDir(pj, sb);
      return contained(dir, path.join(dir, file));
    }
    if (parts.length === 2) {
      /* 旧形状兜底：data/output/<分镜>/<文件> */
      const sb = safeId(parts[0]), file = safeFile(parts[1]);
      if (!sb || !file) return null;
      return contained(R().legacyOutput, path.join(R().legacyOutput, sb, file));
    }
    return null;
  }
  return null;
}

/* 目录包含性检查。⚠ 必须比较 `base + sep` 前缀，不能只 startsWith(base) ——
   否则 base 是 `.../output` 时，兄弟目录 `.../output-bak` 会被误判为在范围内。 */
function contained(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (t === b) return null;                       // 目标是目录本身，不是文件
  return t.startsWith(b + path.sep) ? t : null;
}

/* ---------------- 服务端静态路由（/app、/dist）：URL 路径 → 仓库内绝对路径 ----------------
   返回 null 表示"这个路径不该被服务"（形状不合法或越界）。

   ⚠ 为什么收进这里（2026-09-21，P1-1）：原先 server.js 对 /app/ 与 /dist/ 各写了一遍
   `p.startsWith(path.join(PROJECT_ROOT, 'app'))` —— 与 contained() 的教训正好相反：
   `app-old/`、`dist-backup/` 这类兄弟目录会被误判成"在范围内"。当前仓库没有这类目录，
   但一旦有人建一个（备份旧版前端是常见动作），越界就能读到仓库内任意文件。
   现在静态根收敛为**白名单常量**，边界判断只有 contained() 一个实现。 */
const STATIC_ROOTS = ['app', 'dist'];
function resolveStaticPath(pathname) {
  const p = String(pathname || '');
  const m = /^\/([^/]+)\/(.+)$/.exec(p);
  if (!m || !STATIC_ROOTS.includes(m[1])) return null;
  const base = path.join(configMod.PROJECT_ROOT, m[1]);
  return contained(base, path.join(configMod.PROJECT_ROOT, p));
}

/* 确保项目目录就位（上传素材 / 下载产物前调用） */
function ensureProjectDirs(projectId) {
  const pj = safeId(projectId);
  if (!pj) throw new Error('项目 id 不合法：' + projectId);
  fs.mkdirSync(assetDir(pj), { recursive: true });
  fs.mkdirSync(outputDir(pj), { recursive: true });
  return pj;
}

/* 确保候选图目录就位（下载候选图前调用；不放进 ensureProjectDirs ——
   没有用生图功能的项目不该凭空多出一个空目录）。 */
function ensureCandidateDir(projectId) {
  const pj = safeId(projectId);
  if (!pj) throw new Error('项目 id 不合法：' + projectId);
  fs.mkdirSync(candidateDir(pj), { recursive: true });
  return candidateDir(pj);
}

module.exports = {
  /* 用 getter 而不是快照值：schema.js 读的是 `PATHS.LEGACY_ASSET_DIR`，
     必须是**调用时**的值，setRoots 之后才能生效（测试沙箱依赖这一点）。 */
  get PROJECTS_DIR() { return R().projects; },
  get LEGACY_ASSET_DIR() { return R().legacyAssets; },
  get LEGACY_OUTPUT_DIR() { return R().legacyOutput; },
  setRoots, resetRoots,
  ID_RE, FILE_RE, safeId, safeFile,
  projectDir, assetDir, outputDir, sbOutputDir,
  candidateDir, candidateUrl,
  assetUrl, outputUrl, parseAssetUrl, parseOutputUrl,
  assetFileOf, sbOutputDirOf, legacyOutputFile,
  resolveServePath, contained, ensureProjectDirs, ensureCandidateDir,
  STATIC_ROOTS, resolveStaticPath
};
