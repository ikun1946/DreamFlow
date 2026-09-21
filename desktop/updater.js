'use strict';
/* ============================================================
   updater.js —— 应用自更新（检查 / 下载 / 静默安装 / 自动重启）

   为什么自己写、不引 electron-updater（2026-09-21 决策）：
   自更新真正需要的只有三件事 —— 知道"最新版是多少"、下载安装包、调起安装器。
   而 electron-builder 生成的 NSIS 安装器**本来就已经支持**这三个开关
   （依据：node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:579
     里的 flags(["updated","force-run",...])，以及 templates/nsis/installSection.nsh
     第 106 行"辅助式安装器在 Silent + isForceRun 时会自动重启应用"）：
       /S           静默安装
       --updated    标记为升级（installUtil.nsh 明确用它保证用户数据不被删）
       --force-run  安装完自动重启应用
   本仓库坚持零运行时依赖（服务端只用 Node 内置模块）。为一个已经具备的能力
   再引一个运行时依赖不划算，所以这里只做：取元数据 → 下载 → 校验 → 调安装器。

   ⚠ 四条硬约束，改之前请先读完：
   1. **安装前必须校验 sha512**。latest.yml 里带着 electron-builder 生成的哈希；
      不校验就直接执行下载来的 exe，等于把"任意代码执行"交给网络中间人。
   2. **网络更新源只接受 https**（本地目录模式除外）。更新源是配置项，
      不能让它变成降级攻击面。
   3. **安装器必须用 /S --updated --force-run 调起**。--updated 保证用户数据不被删；
      --force-run 让装完自动重启，用户不用再手动点一次图标。
   4. **下载与校验都在临时目录完成**，校验通过才允许被执行 —— 半截文件、
      被替换的文件都不该有机会运行。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const META_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;   // 安装包 100+ MB，给足

/* ---------------- 版本比较 ----------------
   只认 `major.minor.patch`（本项目的版本号就是语义化三段式，见 README「版本」）。
   预发布后缀（-beta 之类）不参与比较 —— 本项目没在用，真要用时再补，
   不要在这里写一套半吊子的 semver。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/* 返回 true 表示 b 比 a 新 */
function isNewer(b, a) {
  const vb = parseVersion(b), va = parseVersion(a);
  if (!vb || !va) return false;               // 任一边读不出来 → 一律当作"没有新版"，宁可不动
  for (let i = 0; i < 3; i++) {
    if (vb[i] > va[i]) return true;
    if (vb[i] < va[i]) return false;
  }
  return false;
}

/* ---------------- latest.yml 解析 ----------------
   electron-builder 生成的 latest.yml 结构固定（见 release/latest.yml）：

     version: 0.23.0
     files:
       - url: JimengConsole-0.23.0-x64-Setup.exe
         sha512: <base64>
         size: 111720671
     path: JimengConsole-0.23.0-x64-Setup.exe
     sha512: <base64>

   只解这几行，不引 YAML 库 —— 结构由打包工具保证，不是用户输入。 */
function parseLatestYml(text) {
  const out = { version: null, file: null, sha512: null, size: null };
  const lines = String(text || '').split(/\r?\n/);
  let inFiles = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^files:/.test(line)) { inFiles = true; continue; }
    if (/^\S/.test(line)) inFiles = /^files:/.test(line);      // 回到顶层键
    const m = /^\s*-?\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^['"]|['"]$/g, '').trim();
    if (key === 'version' && !out.version) { out.version = val; continue; }
    if (key === 'url' && inFiles && !out.file) { out.file = val; continue; }
    if (key === 'size' && inFiles && out.size === null) { out.size = Number(val) || null; continue; }
    if (key === 'sha512') {
      /* 顶层 sha512 与 files[0].sha512 通常相同；先出现的（files 里的）优先 */
      if (!out.sha512) out.sha512 = val;
      continue;
    }
    if (key === 'path' && !out.file) { out.file = val; continue; }
  }
  return out;
}

/* ---------------- HTTP 小工具 ---------------- */

/* 只允许 https（本地目录模式不走这里）。
   为什么强制：更新源是用户可配的，如果允许 http，链路上任何人
   都能替换"最新版是什么"和"安装包是什么" —— 而这个结果是**会被执行的 exe**。 */
function assertHttps(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('更新源必须是 https：' + u.protocol);
  return u;
}

function request(url, opts, cb) {
  const o = opts || {};
  let settled = false;
  const done = (err, res) => { if (!settled) { settled = true; cb(err, res); } };
  let req;
  try {
    assertHttps(url);
    req = https.request(url, {
      method: o.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'dreamflow-updater' }, o.headers || {})
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((o.redirects || 0) >= 5) return done(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, url).toString();
        /* ⚠ 跨域重定向必须丢掉 Authorization：GitHub 的 asset 下载会 302 到
           objects.githubusercontent.com，把令牌带过去等于把它交给第三方主机。 */
        const crossOrigin = new URL(next).host !== new URL(url).host;
        const headers = crossOrigin
          ? Object.fromEntries(Object.entries(o.headers || {}).filter(([k]) => k.toLowerCase() !== 'authorization'))
          : o.headers;
        return request(next, Object.assign({}, o, { headers, redirects: (o.redirects || 0) + 1 }), done);
      }
      done(null, res);
    });
  } catch (e) { return done(e); }
  req.setTimeout(o.timeoutMs || META_TIMEOUT_MS, () => req.destroy(new Error('请求超时')));
  req.on('error', done);
  req.end();
  return req;
}

function readAll(stream, limitBytes, cb) {
  const chunks = [];
  let size = 0;
  stream.on('data', (d) => {
    size += d.length;
    if (limitBytes && size > limitBytes) { stream.destroy(); return cb(new Error('响应过大（超过 ' + limitBytes + ' 字节）')); }
    chunks.push(d);
  });
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
  stream.on('error', cb);
}

/* 拉一个小文本（latest.yml / GitHub release JSON）。 */
function fetchText(url, headers, limitBytes) {
  return new Promise((resolve) => {
    request(url, { headers, timeoutMs: META_TIMEOUT_MS }, (err, res) => {
      if (err) return resolve({ ok: false, error: err.message });
      if (res.statusCode !== 200) {
        res.resume();
        /* 401/404 在私有库场景下最常见 —— 单独给出可行动的提示，别让用户去猜 */
        const hint = (res.statusCode === 404 || res.statusCode === 401 || res.statusCode === 403)
          ? '（私有仓库需要访问令牌，或更新源地址不对）' : '';
        return resolve({ ok: false, status: res.statusCode, error: 'HTTP ' + res.statusCode + hint });
      }
      readAll(res, limitBytes || 256 * 1024, (e2, buf) => {
        if (e2) return resolve({ ok: false, error: e2.message });
        resolve({ ok: true, text: buf.toString('utf8') });
      });
    });
  });
}

/* ---------------- 带校验的下载 ----------------
   ⚠ 校验是**边下边算**的：等 100+ MB 全落盘再读一遍算哈希要多花一次全盘 IO。
   任何一步不过关（哈希不符 / 字节数不符）都删掉临时文件并返回失败 ——
   绝不能把没验过的 exe 交给安装器执行。 */
function downloadTo(url, dest, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const tmp = dest + '.part-' + process.pid;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch (e) { /* 尽力而为 */ } };

    let file;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      file = fs.createWriteStream(tmp);
    } catch (e) { return done({ ok: false, error: '无法写入临时目录：' + e.message }); }
    file.on('error', (e) => { cleanup(); done({ ok: false, error: '写文件失败：' + e.message }); });

    const hash = crypto.createHash('sha512');
    let got = 0;

    /* headers 显式传参而不是闭包读 o.headers —— 跨域重定向时要换成"去掉令牌"的那份 */
    const go = (u, redirects, headers) => {
      let req;
      try {
        assertHttps(u);
        req = https.get(u, { headers: Object.assign({ 'User-Agent': 'dreamflow-updater' }, headers || o.headers || {}) }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 5) { cleanup(); return done({ ok: false, error: '重定向次数过多' }); }
            /* 同 fetchText：跨域重定向丢掉 Authorization */
            const nextUrl = new URL(res.headers.location, u).toString();
            if (new URL(nextUrl).host !== new URL(u).host) {
              const keep = Object.fromEntries(Object.entries(o.headers || {}).filter(([k]) => k.toLowerCase() !== 'authorization'));
              return go(nextUrl, redirects + 1, keep);
            }
            return go(nextUrl, redirects + 1, headers);
          }
          if (res.statusCode !== 200) {
            res.resume(); cleanup();
            return done({ ok: false, error: '下载返回 HTTP ' + res.statusCode });
          }
          const total = Number(res.headers['content-length']) || 0;
          res.on('data', (d) => {
            got += d.length;
            hash.update(d);
            if (o.onProgress) { try { o.onProgress(got, total); } catch (e) { /* 进度回调不该影响下载 */ } }
          });
          res.on('error', (e) => { cleanup(); done({ ok: false, error: '下载中断：' + e.message }); });
          res.pipe(file);
          file.on('finish', () => {
            if (o.expectSize && got !== o.expectSize) {
              cleanup();
              return done({ ok: false, error: '下载不完整：收到 ' + got + ' / ' + o.expectSize + ' 字节' });
            }
            const actual = hash.digest('base64');
            if (o.expectSha512 && actual !== o.expectSha512) {
              cleanup();
              return done({ ok: false, error: '校验不通过（sha512 不符），已丢弃下载的文件。可能是网络中间人替换或下载损坏。' });
            }
            done({ ok: true, tmp, bytes: got, sha512: actual });
          });
        });
      } catch (e) { cleanup(); return done({ ok: false, error: e.message }); }
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时')));
      req.on('error', (e) => { cleanup(); done({ ok: false, error: '下载失败：' + e.message }); });
    };
    go(url, 0, o.headers);
  });
}

/* ---------------- 更新源 ----------------
   三种模式，各自的适用场景：

     github  owner/repo [+ token]
       默认。**本仓库是私有的**，所以不带令牌会拿到 404 —— 这是设计如此，
       不是 bug。令牌是只读的细粒度 PAT，存在用户的配置目录里（不进安装包）。

     url     https 基址，提供 latest.yml + 安装包
       适合以后把安装包放到公开 CDN / 自建静态站 —— 那时就不需要令牌了。

     local   本地目录
       离线、内网、以及开发机自测（"我刚打完包，让装好的应用直接升级"）。

   ⚠ token 只存在本机配置文件里，**绝不写进安装包** —— 安装包是可解压的，
   把令牌打进去等于公开仓库读权限。 */
const DEFAULT_SOURCE = {
  provider: 'github',
  owner: 'ikun1946',
  repo: 'DreamFlow',
  token: '',
  url: '',
  dir: ''
};

function resolveSource(raw) {
  const s = Object.assign({}, DEFAULT_SOURCE, raw || {});
  if (['github', 'url', 'local'].indexOf(s.provider) < 0) s.provider = 'github';
  return s;
}

const ghHeaders = (token) => (token
  ? { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' }
  : { Accept: 'application/vnd.github+json' });

/* 取"最新版是什么"。成功时统一返回：
   { ok, version, file, sha512, size, notes, releaseUrl, downloadUrl, headers, localPath } */
async function fetchManifest(source) {
  if (source.provider === 'local') {
    if (!source.dir) return { ok: false, error: '没有配置本地更新目录' };
    const yml = path.join(source.dir, 'latest.yml');
    let text;
    try { text = fs.readFileSync(yml, 'utf8'); }
    catch (e) { return { ok: false, error: '读不到 ' + yml + '：' + e.message }; }
    const m = parseLatestYml(text);
    if (!m.version || !m.file) return { ok: false, error: 'latest.yml 里没有 version / file 字段' };
    const localPath = path.join(source.dir, m.file);
    if (!fs.existsSync(localPath)) return { ok: false, error: '目录里没有安装包：' + m.file };
    return {
      ok: true, version: m.version, file: m.file, sha512: m.sha512, size: m.size,
      notes: '', releaseUrl: null, downloadUrl: null, headers: null, localPath
    };
  }

  if (source.provider === 'url') {
    if (!source.url) return { ok: false, error: '没有配置更新源地址' };
    const base = String(source.url).replace(/\/+$/, '');
    const r = await fetchText(base + '/latest.yml', null);
    if (!r.ok) return { ok: false, error: '取 latest.yml 失败：' + r.error };
    const m = parseLatestYml(r.text);
    if (!m.version || !m.file) return { ok: false, error: 'latest.yml 里没有 version / file 字段' };
    return {
      ok: true, version: m.version, file: m.file, sha512: m.sha512, size: m.size,
      notes: '', releaseUrl: null,
      downloadUrl: base + '/' + encodeURIComponent(m.file), headers: null, localPath: null
    };
  }

  /* GitHub。先拿 release 元数据，再从里面取 latest.yml 的正文 ——
     不直接拼 releases/latest/download/xxx，因为私有库那条路需要 cookie 鉴权。 */
  const api = 'https://api.github.com/repos/' + encodeURIComponent(source.owner) + '/' + encodeURIComponent(source.repo);
  const r = await fetchText(api + '/releases/latest', ghHeaders(source.token), 512 * 1024);
  if (!r.ok) {
    return { ok: false, error: '取 GitHub release 失败：' + r.error, needsToken: !source.token };
  }
  let rel;
  try { rel = JSON.parse(r.text); } catch (e) { return { ok: false, error: 'GitHub 返回的不是 JSON' }; }

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const ymlAsset = assets.find((a) => a && a.name === 'latest.yml');
  if (!ymlAsset) return { ok: false, error: '这个 release 里没有 latest.yml 附件（发布时漏传了？）' };

  const yr = await fetchText(ymlAsset.url, Object.assign({ Accept: 'application/octet-stream' }, ghHeaders(source.token)), 256 * 1024);
  if (!yr.ok) return { ok: false, error: '取 latest.yml 内容失败：' + yr.error };
  const m = parseLatestYml(yr.text);
  if (!m.version || !m.file) return { ok: false, error: 'latest.yml 里没有 version / file 字段' };

  const exeAsset = assets.find((a) => a && a.name === m.file);
  if (!exeAsset) return { ok: false, error: '这个 release 里没有安装包附件：' + m.file };

  return {
    ok: true, version: m.version, file: m.file, sha512: m.sha512, size: m.size || exeAsset.size,
    notes: String(rel.body || ''), releaseUrl: rel.html_url || null,
    /* 用 API 资源地址 + octet-stream：公有库私有库都能下，且会 302 到真实对象存储 */
    downloadUrl: exeAsset.url,
    headers: Object.assign({ Accept: 'application/octet-stream' }, ghHeaders(source.token)),
    localPath: null
  };
}

/* ---------------- 进度状态 ----------------
   下载是长请求（100+ MB），前端在等待期间靠轮询这个对象显示百分比。 */
let progress = null;
const progressOf = () => progress;

/* ---------------- 检查更新 ---------------- */
async function check(currentVersion, rawSource) {
  const source = resolveSource(rawSource);
  const m = await fetchManifest(source);
  if (!m.ok) {
    return {
      ok: false, error: m.error, needsToken: m.needsToken === true,
      source: source.provider, currentVersion
    };
  }
  return {
    ok: true, source: source.provider, currentVersion,
    latestVersion: m.version,
    hasUpdate: isNewer(m.version, currentVersion),
    file: m.file, sha512: m.sha512 || null, size: m.size || null,
    notes: m.notes || '', releaseUrl: m.releaseUrl || null
  };
}

/* 本地模式也要校验：把源文件流式复制到目标，同时算 sha512。
   为什么不能直接原地使用：安装器要求"校验通过才执行"，如果直接用源文件，
   校验和实际执行之间会有时间窗；复制一份并校验，执行的就是被验过的那一份。 */
function copyAndVerify(src, dest, expectSha512, expectSize, onProgress) {
  return new Promise((resolve) => {
    const tmp = dest + '.part-' + process.pid;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch (e) { /* 尽力而为 */ } };

    let rs, ws;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      rs = fs.createReadStream(src);
      ws = fs.createWriteStream(tmp);
    } catch (e) { return done({ ok: false, error: '无法读取更新包：' + e.message }); }

    const hash = crypto.createHash('sha512');
    let got = 0;
    const total = expectSize || (() => { try { return fs.statSync(src).size; } catch (e) { return 0; } })();
    rs.on('data', (d) => {
      got += d.length;
      hash.update(d);
      if (onProgress) { try { onProgress(got, total); } catch (e) { /* 忽略 */ } }
    });
    rs.on('error', (e) => { cleanup(); done({ ok: false, error: '读取失败：' + e.message }); });
    ws.on('error', (e) => { cleanup(); done({ ok: false, error: '写入失败：' + e.message }); });
    ws.on('finish', () => {
      if (expectSize && got !== expectSize) { cleanup(); return done({ ok: false, error: '字节数不符：' + got + ' / ' + expectSize }); }
      const actual = hash.digest('base64');
      if (expectSha512 && actual !== expectSha512) {
        cleanup();
        return done({ ok: false, error: '校验不通过（sha512 不符），已丢弃。' });
      }
      done({ ok: true, tmp, bytes: got, sha512: actual });
    });
    rs.pipe(ws);
  });
}

/* ---------------- 下载安装包 ----------------
   产物落在系统临时目录（不是 userData）—— 100+ MB 的安装包是**一次性**的，
   没必要进会被漫游/备份的目录。 */
async function download(currentVersion, rawSource, destDir) {
  const source = resolveSource(rawSource);
  const m = await fetchManifest(source);
  if (!m.ok) return { ok: false, error: m.error, needsToken: m.needsToken === true };
  if (!isNewer(m.version, currentVersion)) {
    return { ok: false, error: '当前已是最新版（' + currentVersion + '）' };
  }

  const dest = path.join(destDir, m.file);
  progress = { active: true, phase: 'download', got: 0, total: m.size || 0, version: m.version, file: m.file };
  const report = (got, total) => { if (progress) { progress.got = got; if (total) progress.total = total; } };

  try {
    const r = m.localPath
      ? await copyAndVerify(m.localPath, dest, m.sha512, m.size, report)
      : await downloadTo(m.downloadUrl, dest, {
          headers: m.headers, expectSha512: m.sha512, expectSize: m.size, onProgress: report
        });
    if (!r.ok) { progress.phase = 'failed'; return { ok: false, error: r.error }; }

    /* 校验通过才改名到最终路径 —— 执行的就是被验过的那一份 */
    progress.phase = 'ready';
    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(r.tmp, dest);
    } catch (e) {
      try { fs.unlinkSync(r.tmp); } catch (e2) { /* 尽力而为 */ }
      progress.phase = 'failed';
      return { ok: false, error: '落盘失败：' + e.message };
    }
    progress.phase = 'done';
    return { ok: true, path: dest, version: m.version, bytes: r.bytes };
  } finally {
    if (progress) progress.active = false;
  }
}

/* ---------------- 调起安装器 ----------------
   ⚠ 这三个开关缺一不可（依据见文件头注释）：
        /S           静默安装（不弹界面）
        --updated    标记为升级 —— installUtil.nsh 明确用它保证**用户数据不被删**
        --force-run  装完自动重启应用（辅助式安装器只在 Silent + isForceRun 时才重启）
   本函数只负责"把安装器拉起来"；调用方随后必须 app.quit()，
   安装器会等本进程退出后再替换文件。 */
function install(installerPath) {
  return new Promise((resolve) => {
    if (!installerPath || !fs.existsSync(installerPath)) {
      return resolve({ ok: false, error: '安装包不存在：' + installerPath });
    }
    let child;
    try {
      child = spawn(installerPath, ['/S', '--updated', '--force-run'], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
    } catch (e) { return resolve({ ok: false, error: '调起安装器失败：' + e.message }); }
    child.on('error', (e) => resolve({ ok: false, error: '调起安装器失败：' + e.message }));
    child.unref();
    resolve({ ok: true });
  });
}

module.exports = {
  parseVersion, isNewer, parseLatestYml, fetchText, downloadTo,
  resolveSource, fetchManifest, DEFAULT_SOURCE,
  progressOf, check, download, install
};
