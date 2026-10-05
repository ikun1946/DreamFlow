'use strict';
/* ============================================================
   env-setup.js —— 首次运行的「环境体检 + 一键配好」（0.48.0）

   目标：新用户装完应用就能用，不必自己去翻文档装创作 CLI 与 ffmpeg。
     · 体检（report）    逐项查：创作 CLI 装没装 / 登没登录 · ffmpeg 与 ffprobe 能不能跑 ·
                        数据目录可写 · 上游源连不连得上；
     · 配好（install）   把缺的装到 %USERPROFILE%\bin（与创作 CLI 同一个目录）：
                        CLI 复用 cli-installer.js，ffmpeg 从**上游官方发布页**现下现解；
     · 只引导不代劳      「登录即梦账号」要用浏览器授权（设备码），必须用户自己点 ——
                        这里只把状态如实报出来，不假装能自动完成。

   ⚠ 四条不能破的约束（前三条与 cli-installer.js 同一套纪律）：
     1. **不内置、不随包分发**任何第三方二进制 —— 一律运行时从上游取。FFmpeg 是 GPL 构建，
        随包分发会把分发主体变成我们自己；「运行时从上游搬运」这条口径由使用者 2026-10-05 确认，
        与本文件顶部这段话一起改之前请先回头问（见 AGENTS.md 的红线表）。
     2. **先验后用**：下载物必须先确认是合法 ZIP，解出来的必须是 PE，装完还要**真跑一次**
        `-version` 看它能不能执行（杀软拦截、半截文件都在这道闸上现形）。
     3. **失败不动用户手里那份**：新文件先进 `.new-<pid>` 暂存位，验证通过才备份旧文件并原子改名。
     4. **路径要现算**：装完必须立刻生效 —— config.js 只在启动时读一次，
        所以调用方一律走 resolvedTool()，而不是直接用 cfg.ffmpegPath。

   ⚠ 可注入：opts.deps 里的 fetchTo / extract / runTool / probeNetwork / tmpDir / isWritable
     都可以替换 —— test/20-env-setup.test.js 靠它跑假传输，不联网、不落真实目录。
   ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const CLI = require('./cli-installer');
const NP = require('./net-proxy');

/* 上游源（GitHub）在国内**必须**走系统代理才拉得下来（见 net-proxy.js 的实测记录），
   所以这里默认就用代理感知的 GET；单测注入 opts.deps.fetchTo 就能完全脱网。 */
const proxyFetchTo = (url, dest, onProgress) => CLI.downloadToFile(url, dest, onProgress, { get: NP.get });

/* 与创作 CLI 同一个目录：%USERPROFILE%\bin —— 官方 CLI 安装脚本用的默认位置，
   应用自己装的东西全部收在这一处，用户要清理/排查只用一个地方找。 */
const INSTALL_DIR = CLI.DEFAULT_INSTALL_DIR;
const FFMPEG_NAME = 'ffmpeg.exe';
const FFPROBE_NAME = 'ffprobe.exe';

/* ffmpeg / ffprobe 的上游发布页（**不内置、不随包分发**，运行时现下现解）。
   ⚠ 选 BtbN/FFmpeg-Builds 的理由：① Windows 上最通用的静态构建；② ffmpeg.exe 与 ffprobe.exe
   同在一个包里（我们两个都要，分开下两份反而更容易版本错配）；③ 用滚动的 `latest` 标签 ——
   URL 恒定、资产名恒定，不必先查 API 再拼地址（少一次会失败的往返）。
   换源要同步改 THIRD-PARTY-NOTICES.md 的 FFmpeg 一节，那里写着这段边界的完整说法。 */
const FFMPEG_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
const FFMPEG_SOURCE_NOTE = 'BtbN/FFmpeg-Builds（GitHub 上的 win64 GPL 静态构建）';

/* 一遍超时都留得比较宽：zip 有上百 MB，慢网几分钟很正常；
   超时只是兜底（防止连接挂着不动），不是"多久没下完就失败"。 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
const VERSION_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 4000;

/* 进度：与 cli-installer.js 同一套做法 —— 安装是长请求，前端靠轮询另一个接口看百分比。
   ⚠ 只记**一次安装**的状态（active 时上层会挡住新请求），不做队列。 */
let progress = null;
const progressOf = () => progress;
function setProgress(p) { progress = p; }
function clearProgress() { if (progress) progress.active = false; }

/* ---------------- 可执行文件路径解析 ---------------- */

/* ffmpeg / ffprobe 到底用哪个文件：
   ① 配置里显式写了路径（不是裸名字）→ 以用户为准（那是明确意图，不该被"我们装的那份"顶掉）；
   ② 本机 bin 目录里有"一键配好"装的那份 → 用它；
   ③ 否则回落到 PATH 上的裸名字（用户自己装过、且在 PATH 里）。
   ⚠ 每次调用都现算：装完不重启应用也要立刻生效（config.js 是启动时快照）。 */
function resolvedTool(cfg, which) {
  const isProbe = which === 'ffprobe';
  const bare = isProbe ? 'ffprobe' : 'ffmpeg';
  const managed = path.join(INSTALL_DIR, isProbe ? FFPROBE_NAME : FFMPEG_NAME);
  const cfgValue = String((cfg && (isProbe ? cfg.ffprobePath : cfg.ffmpegPath)) || '').trim();
  /* 显式路径（不是裸名字）优先 —— 用户明确指定了，就不该被我们装的那份顶掉 */
  if (cfgValue && cfgValue !== bare) return cfgValue;
  try { if (fs.statSync(managed).isFile()) return managed; } catch (e) { /* 还没装 */ }
  return cfgValue || bare;
}

/* ---------------- 小工具 ---------------- */

function runTool(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child = null;
    const settle = (r) => resolve(r);
    try {
      child = cp.execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return settle({ ok: false, error: err.message, stdout: String(stdout || ''), stderr: String(stderr || '') });
        settle({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) { return settle({ ok: false, error: e.message }); }
    if (child) child.on('error', (e) => settle({ ok: false, error: e.message }));
  });
}

/* 目录真的可写吗 —— 只有写进去再删掉才算数（只看 existsSync 不够）。
   与 data-dir.js 的 isWritable 同一套判据（那边没有导出，这里不为了复用去改它的对外形状）。 */
function isDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) { return false; }
}

/* 探测上游源通不通。走代理感知的 GET —— 直连能通但代理配错时，
   "探测说能通、下载却失败"会把人绕晕（反之也一样），两者必须同一条路。 */
function probeNetwork(url, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    try {
      req = NP.get(url, { method: 'HEAD', headers: { 'User-Agent': 'dreamflow' }, timeout: timeoutMs || PROBE_TIMEOUT_MS }, (res) => {
        res.resume();
        /* 3xx 也算通 —— GitHub 的 release 下载地址本来就会 302 到对象存储 */
        resolve({ ok: res.statusCode < 400, status: res.statusCode });
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

/* 跑一次 `-version`：这是"它到底能不能用"的唯一硬判据（存在 ≠ 能执行）。 */
async function toolCheck(bin, deps) {
  const run = (deps && deps.runTool) || runTool;
  const r = await run(bin, ['-version'], VERSION_TIMEOUT_MS);
  if (!r.ok) {
    const msg = String(r.error || '');
    const missing = /ENOENT|not found|系统找不到|is not recognized/i.test(msg);
    return { ok: false, path: bin, version: null, detail: missing ? '没有找到可执行文件' : ('执行失败：' + msg) };
  }
  const m = /^(\S+) version (\S+)/m.exec(r.stdout || '');
  return { ok: true, path: bin, version: m ? m[2] : null, detail: m ? '版本 ' + m[2] : '可用' };
}

/* ---------------- 可续传的下载（190 MB 的包一定会被掐断） ----------------
   为什么不能直接用 cli-installer.downloadToFile：那个是给 30 MB 的 CLI 用的，单流一次下完；
   而 ffmpeg 的包实测 190 MB，在国内的代理链路上**跑到 100 多秒就被上游 aborted**
   （2026-10-05 实测：137 秒后 read aborted）。所以这里带续传：
     · 断点从磁盘上那个 `.part-<pid>` 文件的实际大小取（不依赖进程内记账，进程被杀也能续）；
     · 每次重试用 `Range: bytes=<已有>-`；上游回 206 就追加，回 200（不认 Range）就从头写；
     · 回 416（Range 越界）说明**已经下完**，直接收尾（这是"最后一段刚好撞上中断"的形态）；
     · 攒够重试次数仍不完整才算失败，且失败时保留 .part 文件，下次调用接着下。
   ⚠ 只对支持 Range 的源有意义；不支持的源会回 200 走"从头写"分支，功能不受影响。 */
function downloadResumable(url, dest, onProgress, opts) {
  const o = opts || {};
  const getFn = o.get || proxyFetchTo;
  const maxAttempts = o.maxAttempts || 8;
  const part = dest + '.part-' + process.pid;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const sizeOf = () => { try { return fs.statSync(part).size; } catch (e) { return 0; } };

  function attempt(resolve) {
    const from = sizeOf();
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    /* 跟随重定向（最多 5 跳）。⚠ 每次重试都从**原始 URL** 重新走一遍跳转：
       GitHub 的资产地址是带签名与过期时间的 302 目标，攒着旧签名跨重试用会 403。
       所以"断点"只由 Range 头承载，目标地址每次现解析。 */
    const go = (u, redirects) => {
      const headers = { 'User-Agent': 'dreamflow' };
      if (from > 0) headers.Range = 'bytes=' + from + '-';
      let req, settled = false;
      const finish = (r) => { if (settled) return; settled = true; resolve(r); };
      try {
        req = getFn(u, { headers, timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
          const code = res.statusCode;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 5) return finish({ ok: false, error: '重定向次数过多', retryable: false });
            let next;
            try { next = new URL(res.headers.location, u).toString(); } catch (e) { return finish({ ok: false, error: '重定向地址不合法', retryable: false }); }
            return go(next, redirects + 1);
          }
          /* 416 = Range 越界：说明"已经下完"，是正常收尾而不是错误 */
          if (code === 416) { res.resume(); return finish({ ok: true, tmp: part, bytes: from, complete: true }); }
          if (code === 206 || (code === 200 && from === 0)) {
            const total = from + (Number(res.headers['content-length']) || 0);
            /* 200 = 上游不认 Range，这一份数据是从头开始的 → 必须截断，否则会拼出坏文件 */
            const file = fs.createWriteStream(part, { flags: code === 206 ? 'a' : 'w' });
            let got = from;
            res.on('data', (d) => {
              got += d.length;
              if (onProgress) { try { onProgress(got, total); } catch (e) { /* 回调不该影响下载 */ } }
            });
            res.on('error', (e) => { file.destroy(); finish({ ok: false, error: '下载中断：' + e.message, retryable: true, got: got, total: total }); });
            file.on('finish', () => {
              if (total && got < total) return finish({ ok: false, error: '下载不完整：' + got + ' / ' + total + ' 字节', retryable: true, got: got, total: total });
              finish({ ok: true, tmp: part, bytes: got });
            });
            file.on('error', (e) => finish({ ok: false, error: '写文件失败：' + e.message, retryable: true, got: got, total: total }));
            res.pipe(file);
            return;
          }
          res.resume();
          finish({ ok: false, error: '下载返回 HTTP ' + code, retryable: code >= 500 || code === 429, got: from });
        });
      } catch (e) { return finish({ ok: false, error: '发起下载失败：' + e.message, retryable: true }); }
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => finish({ ok: false, error: '下载失败：' + e.message, retryable: true }));
    };
    go(url, 0);
  }

  return (async () => {
    let last = null;
    for (let i = 1; i <= maxAttempts; i++) {
      const r = await new Promise((resolve) => attempt(resolve));
      if (r.ok) return r;
      last = r;
      if (r.retryable === false) return r;
      /* 递增退避：中断常成片发生，退避太短等于连打三次同样的坏链路 */
      if (i < maxAttempts) {
        if (progress) progress.step = (r.error || '下载中断') + '，正在重试（' + i + '/' + maxAttempts + '）…';
        await sleep(Math.min(1500 * i, 8000));
      }
    }
    return Object.assign({}, last, { error: (last && last.error ? last.error + '；' : '') + '重试 ' + maxAttempts + ' 次仍未下完（已保留进度，下次会接着下）' });
  })().catch((e) => ({ ok: false, error: (e && e.message) || '下载失败' }));
}

/* ---------------- 体检 ---------------- */

/* 逐项体检。deps 由 services 注入（那边才知道适配器/数据目录的实时状态）：
     cliStatus()       → cli-installer.status() 的结果（装没装 + 官方最新版本）
     cliAuth           → { available, account, message } 创作 CLI 的登录态（来自探测缓存）
     dataDir           → 数据根目录（判可写）
     probe             → true 才去联网（打开弹窗/手动重检时），启动时用缓存过的结果
   返回 { items, summary } —— 界面只按 items 渲染，判断逻辑全在这里（一处口径）。 */
async function report(cfg, deps) {
  const d = Object.assign({
    cliStatus: null, cliAuth: null, dataDir: null, probe: false,
    runTool: runTool, probeNetwork: probeNetwork, isWritable: isDirWritable
  }, deps || {});
  const items = [];

  /* ① 创作 CLI：装没装（本地文件）+ 登没登录（探测缓存）分两条说 ——
     两者缺的东西完全不同，合成一条会让用户不知道该装还是该登录。 */
  let cli = null;
  if (typeof d.cliStatus === 'function') {
    try { cli = await d.cliStatus(); } catch (e) { cli = null; }
  }
  const auth = d.cliAuth || null;
  const cliInstalled = !!(cli && cli.installed);
  items.push({
    id: 'cli', label: '创作 CLI（dreamina）', group: 'engine',
    ok: cliInstalled, fixable: true, action: 'cli',
    detail: cliInstalled
      ? ('已安装' + (cli.mtime ? '（' + String(cli.mtime).slice(0, 10) + '）' : '') + '：' + cli.path)
      : '未安装 —— 视频生成全靠它，不装这一项就没法出片',
    installable: cliInstalled ? (cli.needsUpdate ? '可更新' : null) : '可一键安装'
  });
  items.push({
    id: 'cliLogin', label: '即梦账号登录', group: 'engine',
    ok: !!(auth && auth.available), fixable: false, action: null,
    detail: (auth && auth.available)
      ? ('已登录' + (auth.account ? '：' + auth.account : ''))
      : '未登录 —— 登录要打开浏览器授权（设备码），这一步只能你自己点',
    installable: null
  });

  /* ② ffmpeg / ffprobe：能不能真跑一次。ffprobe 只影响"音频参考"，ffmpeg 只影响"产物封面"，
     所以这两项**不是**"没有就用不了"，文案要说清"缺了会少什么"。 */
  const ffPath = resolvedTool(cfg || {}, 'ffmpeg');
  const fpPath = resolvedTool(cfg || {}, 'ffprobe');
  const ff = await toolCheck(ffPath, d);
  const fp = await toolCheck(fpPath, d);
  items.push({
    id: 'ffmpeg', label: 'ffmpeg（产物封面抽帧）', group: 'tools',
    ok: ff.ok, fixable: process.platform === 'win32', action: 'ffmpeg',
    detail: ff.ok ? (ff.detail + '：' + ff.path) : ('未就绪（' + ff.detail + '）—— 缺它只是不生成封面缩略图，不影响出片'),
    installable: ff.ok ? null : (process.platform === 'win32' ? '可一键安装' : '请自行安装')
  });
  items.push({
    id: 'ffprobe', label: 'ffprobe（音频时长）', group: 'tools',
    ok: fp.ok, fixable: process.platform === 'win32', action: 'ffmpeg',
    detail: fp.ok ? (fp.detail + '：' + fp.path) : ('未就绪（' + fp.detail + '）—— 缺它时音频素材的时长读不出来，那种音频不允许绑定'),
    installable: fp.ok ? null : (process.platform === 'win32' ? '可一键安装（与 ffmpeg 同一个包）' : '请自行安装')
  });

  /* ③ 数据目录可写：真写一个探针文件再删掉（读写权限、杀软拦截都在这条上现形） */
  if (d.dataDir) {
    const writable = d.isWritable(d.dataDir);
    items.push({
      id: 'dataDir', label: '数据目录可写', group: 'local',
      ok: writable, fixable: false, action: null,
      detail: writable ? ('可写：' + d.dataDir) : ('不可写：' + d.dataDir + ' —— 换一个可写目录（设置 → 数据目录），或检查杀软拦截'),
      installable: null
    });
  }

  /* ④ 上游源连通性：只在 probe=true 时真去连（启动时用缓存，免得每次开页面都等 4 秒） */
  if (d.probe) {
    const net = await d.probeNetwork(FFMPEG_ZIP_URL, PROBE_TIMEOUT_MS);
    items.push({
      id: 'network', label: '上游源连通性', group: 'local',
      ok: !!net.ok, fixable: false, action: null,
      detail: net.ok ? ('可访问（HTTP ' + net.status + '）：' + FFMPEG_SOURCE_NOTE)
        : ('连不上（' + (net.error || ('HTTP ' + net.status)) + '）—— 装 CLI / ffmpeg 都需要它，检查代理或稍后再试'),
      installable: null
    });
  }

  const problems = items.filter((it) => !it.ok);
  return {
    at: new Date().toISOString(),
    source: FFMPEG_SOURCE_NOTE,
    items: items,
    summary: {
      total: items.length,
      ok: items.length - problems.length,
      problems: problems.length,
      /* 能自动修好的问题数 —— 界面据此决定「一键配好」按钮要不要亮 */
      fixable: problems.filter((it) => it.fixable).length
    }
  };
}

/* ---------------- 一键配好 ---------------- */

/* 下载 zip → 校验是 ZIP → 解压 → 找 ffmpeg.exe / ffprobe.exe → PE 校验 → 试运行 →
   备份旧文件 → 原子落位。任何一步失败都不动用户手上已有的那份。 */
async function installFfmpeg(cfg, opts) {
  const o = opts || {};
  const d = opts.deps || {};
  const fetchTo = d.fetchTo || ((url, dest, onProgress) => downloadResumable(url, dest, onProgress, { get: NP.get }));
  const extract = d.extract || extractZip;
  const run = d.runTool || runTool;
  const tmpDir = d.tmpDir || path.join(os.tmpdir(), 'dreamflow-ffmpeg-' + process.pid);
  /* 落位目录默认是"与创作 CLI 同一个 bin"，可被 opts.installDir 覆盖 ——
     单测与"真跑一遍但不碰用户环境"的验证都靠它（test/20）。 */
  const installDir = o.installDir || INSTALL_DIR;
  const steps = [];
  const log = (m) => { steps.push(m); if (progress) progress.step = m; if (o.onStep) { try { o.onStep(m); } catch (e) { /* 回调不该影响安装 */ } } };
  let tmpRoot = null;

  try {
    if (process.platform !== 'win32') {
      return { ok: false, error: '这个包是 Windows 构建，当前系统（' + process.platform + '）请自行安装 ffmpeg', steps };
    }
    tmpRoot = tmpDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    const zipPath = path.join(tmpRoot, 'ffmpeg.zip');

    log('正在从上游下载 ffmpeg（约 100 MB 以上，慢网需要几分钟）…');
    if (progress) { progress.phase = 'download'; progress.got = 0; progress.total = 0; }
    const dl = await fetchTo(FFMPEG_ZIP_URL, zipPath, (got, total) => {
      if (progress) { progress.got = got; progress.total = total || 0; progress.percent = total ? Math.round(got / total * 100) : null; }
    });
    if (!dl || !dl.ok) return { ok: false, error: '下载失败：' + ((dl && dl.error) || '未知原因'), steps };
    /* ⚠ 校验 / 解压要用 dl.tmp（`.part-<pid>` 暂存文件），**不是**传进去的 dest：
       downloadToFile 刻意不自动改名 —— "下完"和"落位"是两步，中间要插校验。
       2026-10-05 实测踩过：照 dest 去 stat，白等 75 秒才 ENOENT。 */
    const downloaded = dl.tmp || zipPath;
    const zipSize = fs.statSync(downloaded).size;
    log('下载完成（' + Math.round(zipSize / 1024 / 1024) + ' MB）');

    /* 上游出问题时最典型的表现是给回一个 HTML 错误页 —— 那种文件照样能"下载成功"，
       不解压就发现不了。ZIP 的魔数是最便宜的那道闸。 */
    if (!looksLikeZip(downloaded)) {
      return { ok: false, error: '下载到的不是 ZIP（上游可能返回了错误页），已丢弃', steps };
    }

    if (progress) progress.phase = 'extract';
    log('正在解压…');
    const ex = await extract(downloaded, path.join(tmpRoot, 'x'), { deps: d });
    if (!ex || !ex.ok) return { ok: false, error: '解压失败：' + ((ex && ex.error) || '未知原因'), steps };

    const found = findTools(path.join(tmpRoot, 'x'));
    if (!found.ffmpeg || !found.ffprobe) {
      return { ok: false, error: '包里没有找到 ' + FFMPEG_NAME + ' / ' + FFPROBE_NAME + '（上游包结构可能变了）', steps };
    }

    const placed = [];
    for (const which of ['ffmpeg', 'ffprobe']) {
      const src = found[which];
      const dest = path.join(installDir, which === 'ffprobe' ? FFPROBE_NAME : FFMPEG_NAME);
      if (progress) progress.phase = 'install';
      log('正在落位 ' + path.basename(dest) + '…');
      const r = await placeTool(src, dest, run);
      if (!r.ok) return { ok: false, error: path.basename(dest) + '：' + r.error, steps };
      placed.push(r);
    }

    log('完成：' + installDir);
    return { ok: true, dir: installDir, files: placed.map((p) => p.path), versions: placed.map((p) => p.version), steps };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '安装失败', steps };
  } finally {
    if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ } }
  }
}

function looksLikeZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    /* PK\x03\x04（普通）/ PK\x05\x06（空档）/ PK\x07\x08（分卷）都认 */
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch (e) { return false; }
}

/* 解压：用 Windows 自带的 bsdtar（System32\tar.exe，Win10 1803+）。
   为什么不用 PowerShell 的 Expand-Archive：PS 5.1 那个实现对某些 zip 会报
   "找不到中央目录结尾记录"（本机实测过 Node 官方 zip），不可靠；bsdtar 是 libarchive，
   解 zip 是它的基本功。 */
function extractZip(zipPath, destDir) {
  return new Promise((resolve) => {
    try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    cp.execFile('tar', ['-xf', zipPath, '-C', destDir], { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: err.message + (stderr ? ' / ' + String(stderr).slice(0, 200) : '') });
      resolve({ ok: true });
    });
  });
}

/* 在解压出来的树里找那两个可执行文件（上游把 bin/ 嵌在多层目录下，层级不固定） */
function findTools(root) {
  const out = { ffmpeg: null, ffprobe: null };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of entries) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { stack.push(full); continue; }
      const low = it.name.toLowerCase();
      if (low === FFMPEG_NAME && !out.ffmpeg) out.ffmpeg = full;
      else if (low === FFPROBE_NAME && !out.ffprobe) out.ffprobe = full;
    }
  }
  return out;
}

/* 落位：PE 校验 → 拷到 `<目标>.new-<pid>` → **真跑一次 -version** → 备份旧文件 → 原子改名。
   ⚠ 试运行必须发生在替换之前：杀软拦截、半截文件、架构不对（x86 包放到 x64 机器上通常也能跑，
   但万一）都在这道闸上现形，此时用户手里那份还是好的。 */
async function placeTool(src, dest, run) {
  try {
    if (!CLI.looksLikePE(src)) return { ok: false, error: '不是合法的 Windows 可执行文件（PE）' };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const staged = dest + '.new-' + process.pid;
    try { fs.unlinkSync(staged); } catch (e) { /* 上次残留 */ }
    fs.copyFileSync(src, staged);

    const probe = await run(staged, ['-version'], VERSION_TIMEOUT_MS);
    if (!probe.ok) {
      try { fs.unlinkSync(staged); } catch (e) { /* 尽力而为 */ }
      return { ok: false, error: '新文件无法执行（' + (probe.error || '未知原因') + '），已保留原文件' };
    }

    let backup = null;
    try {
      fs.accessSync(dest);
      backup = dest + '.bak-' + Date.now();
      fs.renameSync(dest, backup);
    } catch (e) { /* 原本没有 = 直接装 */ }
    try {
      fs.renameSync(staged, dest);
    } catch (e) {
      if (backup) { try { fs.renameSync(backup, dest); } catch (e2) { /* 回滚失败：如实报错 */ } }
      return { ok: false, error: '写入 ' + dest + ' 失败：' + e.message };
    }
    const v = /(?:ffmpeg|ffprobe) version (\S+)/.exec(probe.stdout || '');
    return { ok: true, path: dest, version: v ? v[1] : null, backup };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '写入失败' };
  }
}

/* 对外入口：装一个组件。component：'cli' | 'ffmpeg'（ffmpeg 这一项同时装 ffprobe）。 */
async function installComponent(cfg, component, opts) {
  const o = opts || {};
  setProgress({ active: true, component: component, phase: 'start', step: '准备中…', percent: null, got: 0, total: 0, at: new Date().toISOString() });
  try {
    if (component === 'cli') {
      const r = await CLI.install(cfg, o);
      return { component: component, ok: !!(r && r.ok), path: r && r.path, bytes: r && r.bytes, steps: (r && r.steps) || [], error: r && r.error };
    }
    if (component === 'ffmpeg') {
      const r = await installFfmpeg(cfg, o);
      return Object.assign({ component: component }, r);
    }
    return { component: component, ok: false, error: '未知的组件：' + component, steps: [] };
  } finally {
    clearProgress();
  }
}

module.exports = {
  INSTALL_DIR, FFMPEG_NAME, FFPROBE_NAME, FFMPEG_ZIP_URL, FFMPEG_SOURCE_NOTE,
  resolvedTool, runTool, isDirWritable, probeNetwork, toolCheck,
  looksLikeZip, findTools, placeTool, extractZip, downloadResumable,
  report, installFfmpeg, installComponent,
  progressOf
};
