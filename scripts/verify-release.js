#!/usr/bin/env node
/**
 * scripts/verify-release.js —— 发布后验收：确认「使用者真的能拿到这个版本」
 *
 * 用法：
 *   node scripts/verify-release.js              # 验最新 Release
 *   node scripts/verify-release.js v0.35.6      # 验指定 tag
 *
 * 退出码：0 = 通过；1 = 失败。**需要联网。**
 *
 * ── 为什么需要它（2026-09-23 加） ────────────────────────────────
 *
 * 本项目吃过一次「改了但没发版」的亏：v0.33.0 / v0.34.1 / v0.34.2 / v0.35.0
 * 都只打了 tag、没建 Release，修复停在 main 上，使用者永远拿不到 —— 直到
 * 使用者自己发现「明明改过了，装好的应用里还是老样子」。
 *
 * 而唯一能驱动真实更新链路的 scripts/test-update-flow.ps1 **需要 PS 7**，
 * 本机只装了 Windows PowerShell 5.1（会在「启动 Electron」那步失败），
 * 所以那条链路在本机**没有可执行的验收手段**。
 *
 * 这个脚本补上最要紧的一段：它**直接用应用自己的 desktop/updater.js**
 * （不启动 Electron、不需要 PS），打真实的已发布 Release，断言五件事 ——
 *
 *   ① 更新源是固定的官方仓库（0.35.6 起不可配置）
 *   ② 应用真的能「查到」这个版本（走 fetchManifest，与界面同一条路径）
 *   ③ Release 附件齐全：exe + .blockmap + latest.yml，且状态均为 uploaded
 *   ④ 附件字节与本地 release/ 里的构建产物一致（比对 GitHub 返回的 digest）
 *   ⑤ 仓库版本不高于已发布版本（防止「发完又改代码、没再发」）
 *
 * ③ 是最要命的一条：**缺 latest.yml 的话应用内更新会查不到新版** ——
 * 传了安装包也等于没发。这条以前只靠人眼在网页上核对。
 *
 * ⚠ 与 check-signing.js 的分工：那个管「产物签没签名」，这个管「产物到没到使用者手里」。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const updater = require('../desktop/updater.js');

const argv = process.argv.slice(2);
const wantTag = (argv.find((a) => /^v\d+\./.test(a)) || '').trim();

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

let failCount = 0;
let warnCount = 0;
const pass = (m) => console.log(C.g + '  PASS  ' + C.x + m);
const fail = (m) => { failCount++; console.log(C.r + '  FAIL  ' + C.x + m); };
const warn = (m) => { warnCount++; console.log(C.y + '  WARN  ' + C.x + m); };
const info = (m) => console.log(C.d + '        ' + m + C.x);
const head = (m) => console.log('\n' + C.b + m + C.x);

const sha256 = (file) =>
  'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

(async () => {
  console.log(C.b + 'DreamFlow —— 发布后验收' + C.x);
  console.log(C.d + '模式：' + (wantTag ? '指定 tag ' + wantTag : '最新 Release') + C.x);

  const src = updater.resolveSource(null);
  const apiBase = 'https://api.github.com/repos/' + src.owner + '/' + src.repo;

  /* ── ① 更新源固定 ───────────────────────────────────────────── */
  head('[1/5] 更新源是否固定为官方仓库');
  info('resolveSource(null) = ' + JSON.stringify(src));
  if (src.provider !== 'github') fail('更新源不是 github，而是 ' + src.provider);
  else if (!src.owner || !src.repo) fail('更新源缺少 owner / repo');
  else pass('更新源 = github/' + src.owner + '/' + src.repo);

  if (src.token || src.url || src.dir) {
    fail('更新源里出现了 token / url / dir —— 说明它又可被外部值影响了（0.35.6 起应为空）');
  } else {
    pass('token / url / dir 均为空（不可配置）');
  }

  /* ── ② 应用能否查到 ────────────────────────────────────────── */
  head('[2/5] 应用能否查到已发布版本（走 fetchManifest，与界面同一条路径）');
  const pkgVersion = require('../package.json').version;
  const r = await updater.check(pkgVersion, null);
  if (!r.ok) {
    fail('检查更新失败：' + r.error);
    info('提示：本机 curl / node 访问 api.github.com 可能需要代理配置。');
  } else {
    pass('查到最新版 ' + r.latestVersion + '（清单文件 ' + r.file + '，' + r.size + ' 字节）');
    if (!r.sha512) fail('latest.yml 里没有 sha512 —— 应用会整份拒绝（等于无法更新）');
    else pass('latest.yml 带 sha512');
  }

  /* ── ③ 附件齐全 ────────────────────────────────────────────── */
  head('[3/5] Release 附件是否齐全');
  const apiUrl = wantTag ? apiBase + '/releases/tags/' + wantTag : apiBase + '/releases/latest';
  const res = await updater.fetchText(apiUrl, { Accept: 'application/vnd.github+json' }, 512 * 1024);
  let rel = null;
  if (!res.ok) {
    fail('读取 Release 失败：' + res.error);
  } else {
    try { rel = JSON.parse(res.text); } catch (e) { fail('Release JSON 解析失败：' + e.message); }
  }

  if (rel) {
    if (rel.draft) fail('Release 仍是草稿（draft:true）—— 使用者看不到');
    else pass('Release 已发布（非草稿）');
    info('页面：' + rel.html_url);

    const assets = rel.assets || [];
    const names = assets.map((a) => a.name);
    info('附件：' + (names.join(' | ') || '（无）'));

    const setup = assets.filter((a) => /Setup\.exe$/i.test(a.name));
    if (setup.length !== 1) fail('Setup.exe 数量应为 1，实际 ' + setup.length);
    else pass('安装包存在：' + setup[0].name + '（' + setup[0].size + ' 字节）');

    /* ⚠ latest.yml 缺了，应用内更新就查不到新版 —— 传了安装包也等于没发。
       这条以前只靠人眼在网页上核对，是"发版静默失败"最常见的原因。 */
    const yml = assets.filter((a) => a.name === 'latest.yml');
    if (!yml.length) fail('★ 缺 latest.yml —— 应用内更新会查不到新版，等于没发');
    else pass('latest.yml 存在（应用内更新靠它找版本与校验和）');

    const bm = assets.filter((a) => /\.blockmap$/.test(a.name));
    if (!bm.length) warn('缺 .blockmap —— 差分更新会退化为整包下载（不影响能否更新）');
    else pass('.blockmap 存在');

    const notReady = assets.filter((a) => a.state && a.state !== 'uploaded');
    if (notReady.length) fail('有附件尚未上传完成：' + notReady.map((a) => a.name + '(' + a.state + ')').join('、'));
    else pass('全部附件状态为 uploaded');
  }

  /* ── ④ 字节一致性 ──────────────────────────────────────────── */
  head('[4/5] 附件字节与本地构建产物是否一致');
  if (!rel) {
    warn('上一步没拿到 Release，跳过');
  } else {
    let compared = 0;
    for (const a of rel.assets || []) {
      if (!a.digest) continue;                       // 旧附件可能没有 digest 字段
      const local = path.join(ROOT, 'release', a.name);
      if (!fs.existsSync(local)) continue;
      compared++;
      const st = fs.statSync(local);
      if (st.size !== a.size) { fail(a.name + '：大小不一致（本地 ' + st.size + ' / 远端 ' + a.size + '）'); continue; }
      const h = sha256(local);
      if (h !== a.digest) fail(a.name + '：sha256 不一致（本地 ' + h + ' / 远端 ' + a.digest + '）');
      else pass(a.name + '：大小与 sha256 均一致');
    }
    if (!compared) {
      warn('release/ 下没有与本次 Release 同名的产物，无法比对字节');
      info('（release/ 已 gitignore，换机器或清理过就会没有 —— 这不算失败）');
    }
  }

  /* ── ⑤ 版本一致性 ──────────────────────────────────────────── */
  head('[5/5] 仓库版本 vs 已发布版本');
  info('package.json = ' + pkgVersion + (rel && rel.tag_name ? '，已发布 = ' + rel.tag_name : ''));
  if (rel && rel.tag_name) {
    const pub = String(rel.tag_name).replace(/^v/, '');
    if (pub === pkgVersion) {
      pass('一致 —— 当前代码就是已发布的那一版');
    } else if (updater.isNewer(pkgVersion, pub)) {
      warn('仓库版本 ' + pkgVersion + ' 高于已发布的 ' + pub + ' —— 存在未发布改动');
      info('这正是 v0.33.0 / v0.34.1 / v0.34.2 / v0.35.0 出问题的那种状态：改了但没发。');
    } else {
      fail('已发布版本 ' + pub + ' 高于仓库的 ' + pkgVersion + ' —— 异常，请核对');
    }
    if (wantTag && rel.tag_name !== wantTag) fail('指定校验 ' + wantTag + '，但拿到的却是 ' + rel.tag_name);
  }

  /* ── 汇总 ──────────────────────────────────────────────────── */
  console.log('');
  if (failCount) {
    console.log(C.r + C.b + '结果：失败（' + failCount + ' 项错误，' + warnCount + ' 项警告）' + C.x);
    process.exit(1);
  }
  console.log(C.g + C.b + '结果：通过' + (warnCount ? '（' + warnCount + ' 项警告）' : '') + C.x);
  process.exit(0);
})().catch((e) => {
  console.error(C.r + '运行异常：' + ((e && e.stack) || e) + C.x);
  process.exit(1);
});
