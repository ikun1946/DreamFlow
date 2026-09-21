'use strict';
/* ============================================================
   cli-installer.js —— 即梦创作 CLI 的检测 / 下载 / 安装 / 更新

   为什么需要它（2026-09-20）：
   官方只提供一种安装方式：`curl -s https://jimeng.jianying.com/cli | bash`。
   而那个脚本的 Windows 分支要求 MINGW / MSYS / CYGWIN 环境（即 Git Bash），
   **干净的 Windows 电脑根本跑不了** —— 结果是没装过 CLI 的用户完全用不了本应用，
   而界面上给的还是一句 Windows 执行不了的 bash 命令。

   这里的做法是：**替用户做官方脚本本来就会做的那件事** ——
   从官方 CDN 下载官方二进制，装到官方脚本默认的位置（%USERPROFILE%\bin）。

   ⚠ 三条刻意的设计，改动前请先读完：

   1. **不把二进制打进安装包。** 打包分发别人的二进制属于"再分发"，
      而 dreamina 的再分发授权至今未确认（见 README「已知边界」）。
      "运行时从官方源下载"不改变分发主体 —— 用户从官方 CDN 拿，
      我们只是搬运。这一条是授权安全的关键，不要为了省事先把它内置换掉。

   2. **装到官方脚本的默认位置**（%USERPROFILE%\bin\dreamina.exe），
      而不是应用自己的目录。这样用户手工装的、我们用界面装的、官方脚本装的
      是**同一个文件**，不会出现"三份 CLI 互相不知道"的状态。

   3. **更新时就地替换，但先备份。** 旧 exe 改名成 .bak-<时间> 留在原地，
      新文件先下到临时路径、确认是合法 PE 再原子改名过去。
      理由：CLI 正在被别的进程占用时（Windows 不允许覆盖运行中的 exe），
      直接覆盖会失败甚至留下半截文件 —— 那等于把用户能用的 CLI 弄坏。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

/* 官方 CDN 基址。三个 URL 全部来自官方安装脚本
   （https://jimeng.jianying.com/cli）里的写死常量，不是猜的。
   ⚠ 路径里的 dreamina_cli_beta 说明这是 **beta 分发通道** —— 接口和行为没有
   稳定性承诺，CLI 哪天改了参数，本应用可能出现"能装上但跑不通"，
   而 test/ 下的 89 个用例只覆盖本地逻辑、覆盖不到官方 CDN 的接口变化。
   升级前请留意。 */
const CDN_BASE = 'https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp';
const VERSION_URL = CDN_BASE + '/version.json';
const BINARY_URL = CDN_BASE + '/dreamina_cli_beta/dreamina_cli_windows_amd64.exe';
const SKILL_URL = CDN_BASE + '/dreamina_cli_beta/SKILL.md';

/* 官方脚本用的状态目录与文件名，保持一致以便与官方工具链共存 */
const STATE_DIR = path.join(os.homedir(), '.dreamina_cli');
const STATE_VERSION_FILE = path.join(STATE_DIR, 'version.json');
const STATE_SKILL_FILE = path.join(STATE_DIR, 'dreamina', 'SKILL.md');
const DEFAULT_INSTALL_DIR = path.join(os.homedir(), 'bin');
const BINARY_NAME = 'dreamina.exe';

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;   // 30 MB，给足 10 分钟
const META_TIMEOUT_MS = 20 * 1000;

/* 安装进度（模块级单例）。
   为什么要有它：install() 是一次**长 HTTP 请求**，请求返回之前前端拿不到任何中间态。
   30 MB 在慢网下要几分钟，只显示"下载安装中…"用户无法判断是在走还是卡死了。
   所以进度必须存在一个能被 status() 读到的地方，让前端另开轮询去问。
   ⚠ 只记**一次安装**的状态（active 时新请求会被上层挡住），不做队列。 */
let progress = null;
const progressOf = () => progress;

/* ---------------- HTTP 小工具（零依赖，只用到内置 https） ---------------- */

/* 带重定向跟随的请求。CDN 可能会 302 到别的边缘节点。 */
function request(url, opts, cb) {
  const o = opts || {};
  let settled = false;
  const done = (err, res) => { if (!settled) { settled = true; cb(err, res); } };
  let req;
  try {
    req = https.request(url, {
      method: o.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'dreamflow' }, o.headers || {})
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((o.redirects || 0) >= 5) return done(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, url).toString();
        return request(next, Object.assign({}, o, { redirects: (o.redirects || 0) + 1 }), done);
      }
      done(null, res);
    });
  } catch (e) { return done(e); }
  req.setTimeout(o.timeoutMs || META_TIMEOUT_MS, () => {
    req.destroy(new Error('请求超时（' + (o.timeoutMs || META_TIMEOUT_MS) + 'ms）'));
  });
  req.on('error', done);
  req.end();
  return req;
}

function readAll(stream, cb) {
  const chunks = [];
  let size = 0;
  stream.on('data', (d) => { chunks.push(d); size += d.length; });
  stream.on('end', () => cb(null, Buffer.concat(chunks), size));
  stream.on('error', cb);
}

/* 读官方版本清单。**匿名可读**，这是"能不能检查更新"的关键。 */
function fetchLatest() {
  return new Promise((resolve) => {
    request(VERSION_URL, { timeoutMs: META_TIMEOUT_MS }, (err, res) => {
      if (err) return resolve({ ok: false, error: '取版本清单失败：' + err.message });
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, error: '版本清单返回 HTTP ' + res.statusCode });
      }
      readAll(res, (e2, buf) => {
        if (e2) return resolve({ ok: false, error: '读版本清单失败：' + e2.message });
        try {
          const j = JSON.parse(buf.toString('utf8'));
          resolve({
            ok: true,
            version: j.version || null,
            releaseDate: j.release_date || null,
            releaseNotes: j.release_notes || '',
            checkedAt: new Date().toISOString()
          });
        } catch (e3) { resolve({ ok: false, error: '版本清单不是合法 JSON：' + e3.message }); }
      });
    });
  });
}

/* 只看前两个字节是不是 "MZ"（Windows PE 的固定魔数）。
   为什么必须有这一步：CDN 或中间设备出问题时，很可能返回一个 HTML 错误页
   而不是二进制 —— 那种文件写进去照样是个"文件"，但一跑就报错，
   而且会把用户原本能用的 CLI 覆盖掉。MZ 检查是最便宜的那道闸。 */
function looksLikePE(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x4d && buf[1] === 0x5a;
  } catch (e) { return false; }
}

/* 装到哪：优先"就地更新"用户已配置的那个绝对路径，否则用官方默认位置。 */
function resolveTarget(cfg) {
  const configured = String((cfg && cfg.dreaminaCliPath) || '').trim();
  /* ⚠ 裸命令名（'dreamina'）不能当路径用。它要靠 PATH 解析，而 PATH 在**已启动**
     的进程里不会刷新 —— 我们刚把 exe 装进 %USERPROFILE%\bin，如果那个目录不在
     当前进程的 PATH 里，装完照样 spawn 不到，用户会看到"装完了还是不可用"。 */
  if (configured && (path.isAbsolute(configured) || /[\\/]/.test(configured))) {
    const abs = path.resolve(configured);
    return { dir: path.dirname(abs), file: abs, source: 'config' };
  }
  return { dir: DEFAULT_INSTALL_DIR, file: path.join(DEFAULT_INSTALL_DIR, BINARY_NAME), source: 'default' };
}

/* 问 CDN：二进制多大、什么时候构建的。用于判断"要不要更新"。 */
function headBinary() {
  return new Promise((resolve) => {
    request(BINARY_URL, { method: 'HEAD', timeoutMs: META_TIMEOUT_MS }, (err, res) => {
      if (err) return resolve({ ok: false, error: err.message });
      res.resume();
      if (res.statusCode !== 200) return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
      resolve({
        ok: true,
        size: Number(res.headers['content-length']) || 0,
        lastModified: res.headers['last-modified'] || null
      });
    });
  });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/* ---------------- 流式下载到临时文件 ---------------- */
function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve) => {
    const tmp = dest + '.part-' + process.pid;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch (e) { /* 尽力而为 */ } };

    let file;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      file = fs.createWriteStream(tmp);
    } catch (e) { return done({ ok: false, error: '无法写入目标目录：' + e.message }); }
    file.on('error', (e) => { cleanup(); done({ ok: false, error: '写文件失败：' + e.message }); });

    const go = (u, redirects) => {
      let req;
      try {
        req = https.get(u, { headers: { 'User-Agent': 'dreamflow' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 5) { cleanup(); return done({ ok: false, error: '重定向次数过多' }); }
            return go(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume(); cleanup();
            return done({ ok: false, error: '下载返回 HTTP ' + res.statusCode });
          }
          const total = Number(res.headers['content-length']) || 0;
          let got = 0;
          res.on('data', (d) => {
            got += d.length;
            if (onProgress) { try { onProgress(got, total); } catch (e) { /* 进度回调不该影响下载 */ } }
          });
          res.on('error', (e) => { cleanup(); done({ ok: false, error: '下载中断：' + e.message }); });
          res.pipe(file);
          file.on('finish', () => {
            /* ⚠ 必须比字节数：连接被中途掐断时 res 会正常 end，文件却是半截的。
               少了这一步，半截 exe 会被当成"下载成功"装上去。 */
            if (total && got !== total) {
              cleanup();
              return done({ ok: false, error: '下载不完整：收到 ' + got + ' / ' + total + ' 字节' });
            }
            done({ ok: true, tmp, bytes: got });
          });
        });
      } catch (e) { cleanup(); return done({ ok: false, error: '发起下载失败：' + e.message }); }
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => { cleanup(); done({ ok: false, error: '下载失败：' + e.message }); });
    };
    go(url, 0);
  });
}

/* 尽力下载一个小文件（version.json / SKILL.md）。失败不算安装失败。 */
function fetchTo(url, dest) {
  return new Promise((resolve) => {
    request(url, { timeoutMs: META_TIMEOUT_MS }, (err, res) => {
      if (err) return resolve({ ok: false, error: err.message });
      if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, error: 'HTTP ' + res.statusCode }); }
      readAll(res, (e2, buf) => {
        if (e2) return resolve({ ok: false, error: e2.message });
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
          resolve({ ok: true, bytes: buf.length });
        } catch (e3) { resolve({ ok: false, error: e3.message }); }
      });
    });
  });
}

/* ---------------- 综合状态：本地装没装 / 官方最新是什么 / 要不要更新 ---------------- */
async function status(cfg) {
  const target = resolveTarget(cfg);

  let local = null;
  try {
    const st = fs.statSync(target.file);
    local = { size: st.size, mtime: st.mtime.toISOString() };
  } catch (e) { /* 文件不存在 = 没装 */ }

  /* 两个网络请求并行：一个取官方版本号，一个取二进制的体积/构建时间。
     都不阻塞本地信息 —— 断网时界面仍要能显示"本机装没装、装的哪个路径"。 */
  const [latest, cdn] = await Promise.all([fetchLatest(), headBinary()]);

  /* 要不要更新？⚠ 官方**没有**给二进制提供哈希（官方安装脚本里只校验了
     SKILL.md 的 MD5，二进制是直接落盘），所以这里只能靠**体积**比：
     体积不同 ⇒ 必定是不同的构建；体积相同 ⇒ 极可能是同一构建
     （30 MB 的产物撞体积的概率可忽略）。
     这是"够用的启发式"，不是密码学级别的确认 —— 改这里之前先想清楚这一点。 */
  let needsUpdate = false;
  let updateNote = null;
  if (local && cdn.ok && cdn.size) {
    if (local.size !== cdn.size) {
      needsUpdate = true;
      updateNote = '官方当前构建 ' + cdn.size + ' 字节，本机是 ' + local.size + ' 字节';
    }
  }

  return {
    installed: !!local,
    path: target.file,
    target,
    size: local ? local.size : null,
    mtime: local ? local.mtime : null,
    latest,
    cdn,
    needsUpdate,
    updateNote
  };
}

/* ---------------- 安装 / 更新 ----------------
   顺序是"先下到临时文件 → 验 PE → 备份旧版 → 原子改名"。
   任何一步失败，用户手上都还有原来那个能用的 exe。 */
/* 对外只暴露这个包装：无论 installInner 是正常返回还是抛错，都保证把
   progress.active 清掉。少了这一步，前端会一直以为"还在下载"，
   进度轮询永远停不下来。
   用包装而不是在 installInner 内部写 try/finally，是为了不必把几十行
   主流程整体缩进一层（缩进变了 diff 就淹没在空白里，看不出真正的改动）。 */
async function install(cfg, opts) {
  try {
    return await installInner(cfg, opts);
  } finally {
    if (progress) progress.active = false;
  }
}

async function installInner(cfg, opts) {
  const o = opts || {};
  const steps = [];
  const log = (m) => {
    steps.push(m);
    if (o.onStep) { try { o.onStep(m); } catch (e) { /* 回调不该影响安装 */ } }
  };

  const target = resolveTarget(cfg);
  log('目标位置：' + target.file + '（' + (target.source === 'config' ? '来自配置，就地更新' : '官方默认位置') + '）');

  progress = { active: true, phase: 'download', got: 0, total: 0, startedAt: Date.now() };
  const report = (got, total) => {
    if (progress) { progress.got = got; if (total) progress.total = total; }
    if (o.onProgress) { try { o.onProgress(got, total); } catch (e) { /* 进度回调不该影响下载 */ } }
  };

  log('开始下载官方二进制（约 30 MB）…');
    const dl = await downloadToFile(BINARY_URL, target.file, report);
    if (!dl.ok) { progress.phase = 'failed'; return { ok: false, error: dl.error, steps }; }
    progress.phase = 'verify';
    log('下载完成：' + dl.bytes + ' 字节');

    if (!looksLikePE(dl.tmp)) {
      try { fs.unlinkSync(dl.tmp); } catch (e) { /* 尽力而为 */ }
      progress.phase = 'failed';
      return {
        ok: false, steps,
        error: '下载到的文件不是合法的 Windows 可执行文件（可能被网络中间设备替换或 CDN 返回了错误页），已丢弃。'
      };
    }
    log('校验通过：是合法的 Windows PE 可执行文件');
    progress.phase = 'replace';

  /* 备份旧版。⚠ 这一步能提前暴露"exe 正在被占用"（Windows 不允许改名运行中的 exe），
     比等到覆盖时才发现要好 —— 那时临时文件已经下完了。 */
  let backup = null;
  if (fs.existsSync(target.file)) {
    backup = target.file + '.bak-' + stamp();
    try {
      fs.renameSync(target.file, backup);
      log('已备份旧版：' + path.basename(backup));
    } catch (e) {
      try { fs.unlinkSync(dl.tmp); } catch (e2) { /* 尽力而为 */ }
      return {
        ok: false, steps,
        error: '旧版无法改名（多半是它正在被别的程序使用）：' + e.message
          + '。请关闭正在使用 dreamina 的程序后重试。'
      };
    }
  }

  try {
    fs.renameSync(dl.tmp, target.file);
    log('已安装到 ' + target.file);
  } catch (e) {
    if (backup) { try { fs.renameSync(backup, target.file); log('已回滚旧版'); } catch (e2) { /* 尽力而为 */ } }
    try { fs.unlinkSync(dl.tmp); } catch (e2) { /* 尽力而为 */ }
    return { ok: false, error: '安装失败（已回滚）：' + e.message, steps };
  }

  /* 同步官方的状态文件，让"我们装的"和"官方脚本装的"完全等价。
     官方脚本会写这两个：version.json（版本清单）+ dreamina/SKILL.md（给 agent 的技能文档）。
     ⚠ 两个都是**尽力而为**：写不进去不影响 CLI 本身能用，不该因此把安装判失败。 */
  progress.phase = 'sync';
  const v = await fetchTo(VERSION_URL, STATE_VERSION_FILE);
  log(v.ok ? '已同步版本清单 ' + STATE_VERSION_FILE : '⚠ 版本清单同步失败（不影响使用）：' + v.error);
  const s = await fetchTo(SKILL_URL, STATE_SKILL_FILE);
  log(s.ok ? '已同步 SKILL.md' : '⚠ SKILL.md 同步失败（不影响使用）：' + s.error);

  progress.phase = 'done';
  return {
    ok: true,
    path: target.file,
    bytes: dl.bytes,
    backup,
    steps
  };
}

module.exports = {
  CDN_BASE, VERSION_URL, BINARY_URL, SKILL_URL,
  STATE_DIR, STATE_VERSION_FILE, STATE_SKILL_FILE,
  DEFAULT_INSTALL_DIR, BINARY_NAME,
  fetchLatest, headBinary, resolveTarget, looksLikePE, downloadToFile,
  progressOf, status, install
};
