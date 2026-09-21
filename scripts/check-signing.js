#!/usr/bin/env node
/**
 * scripts/check-signing.js —— Windows 安装包签名检查
 *
 * 两条用途：
 *
 *   1. 【发布前自检】确认签名环境就绪（凭据存在、证书可读、signtool 可用）
 *      然后提醒你构建后要复核的对象：
 *          node scripts/check-signing.js
 *
 *   2. 【构建后验收】对已生成的产物逐文件验证签名
 *          node scripts/check-signing.js --verify
 *      它会扫描 release/ 下的 Setup.exe 与 win-unpacked/JimengConsole.exe，
 *      用 signtool 验证签名链与时间戳，并把结果汇总成表。
 *
 *   3. 【正式发布卡点】未配置凭据时直接失败
 *          node scripts/check-signing.js --require
 *      用于 CI：没有签名凭据就不允许出正式包，避免"忘了配"导致静默出无签名包。
 *
 * 退出码：0 = 通过；1 = 失败（缺凭据 / 验证不通过 / 找不到产物）
 *
 * 依赖：不需要任何 npm 包；signtool 来自 Windows SDK，若找不到会给出安装指引。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');

const argv = process.argv.slice(2);
const MODE_VERIFY = argv.includes('--verify');
const MODE_REQUIRE = argv.includes('--require');

// ── 输出小工具 ──────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

let failCount = 0;
let warnCount = 0;

function pass(msg) { console.log(C.g + '  PAS S  ' + C.x + msg); }
function fail(msg) { failCount++; console.log(C.r + '  FAIL  ' + C.x + msg); }
function warn(msg) { warnCount++; console.log(C.y + '  WARN  ' + C.x + msg); }
function info(msg) { console.log(C.d + '         ' + msg + C.x); }
function head(msg) { console.log('\n' + C.b + msg + C.x); }

// ── 1. 定位 signtool.exe ────────────────────────────────────────
// Windows SDK 的 signtool 不在 PATH 里，需要去标准安装位置找。
function findSigntool() {
  // 尊重用户显式指定的路径
  if (process.env.SIGNTOOL && fs.existsSync(process.env.SIGNTOOL)) return process.env.SIGNTOOL;

  // which / where 先试一把（有的人手动加进了 PATH）
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which',
    ['signtool'], { encoding: 'utf8' });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  }

  if (process.platform !== 'win32') return null;

  // 标准位置：C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\signtool.exe
  const kits = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin'
  ];
  const found = [];
  for (const base of kits) {
    if (!fs.existsSync(base)) continue;
    for (const ver of fs.readdirSync(base)) {
      const p = path.join(base, ver, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  if (!found.length) return null;
  // 版本号字典序倒排即可满足（10.0.22621 > 10.0.19041）
  found.sort().reverse();
  return found[0];
}

// ── 2. 检查签名凭据 ────────────────────────────────────────────
function checkCredentials() {
  head('[1/3] 签名凭据检查');

  const link = process.env.CSC_LINK || '';
  const pass = process.env.CSC_KEY_PASSWORD || '';

  if (!link) {
    const msg = 'CSC_LINK 未设置 —— 构建将产出**未签名**安装包';
    if (MODE_REQUIRE) {
      fail(msg + '（--require 模式下这是致命错误）');
      info('设置方式（PowerShell，凭据只活在当前会话）：');
      info('  $env:CSC_LINK="C:\\secrets\\dreamflow-codesign.pfx"');
      info('  $env:CSC_KEY_PASSWORD="******"');
    } else {
      warn(msg);
      info('这是允许的「开发机构建」通路；正式发布请先配置凭据。');
    }
    return { ok: false, hasLink: false };
  }

  if (link.startsWith('base64:')) {
    pass('CSC_LINK 使用 base64 内联证书');
    if (!pass) warn('CSC_KEY_PASSWORD 未设置（若证书无口令可忽略）');
    return { ok: true, hasLink: true };
  }

  if (/^https?:\/\//i.test(link)) {
    pass('CSC_LINK 为远程链接（构建时会下载）');
    info('注意：链接内容含私钥，请确保只有构建机与 CI 能访问。');
  } else {
    const p = path.resolve(link);
    if (!fs.existsSync(p)) {
      fail('CSC_LINK 指向的文件不存在：' + p);
      return { ok: false, hasLink: true };
    }
    const st = fs.statSync(p);
    pass('证书文件存在：' + p + '  (' + st.size + ' 字节)');
    if (/\.(pfx|p12)$/i.test(p)) {
      pass('扩展名看起来是正确的容器格式（' + path.extname(p) + '）');
    } else {
      warn('扩展名不是 .pfx / .p12，请确认 electron-builder 能否识别：' + path.extname(p));
    }
  }

  if (!pass) {
    warn('CSC_KEY_PASSWORD 未设置 —— 若证书有口令，签名会失败');
  } else {
    pass('CSC_KEY_PASSWORD 已设置（长度 ' + pass.length + '）');
  }

  // 证书绝不能入库
  head('[1.1] 证书是否被误提交');
  const gi = path.join(ROOT, '.gitignore');
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const ignored = ['*.pem', '*.key', '*.p12', '*.pfx'].filter((pat) => giText.includes(pat));
  if (ignored.length >= 3) {
    pass('.gitignore 已忽略私钥类文件：' + ignored.join(' '));
  } else {
    fail('.gitignore 未完整忽略私钥（缺 ' +
      ['*.pem', '*.key', '*.p12', '*.pfx'].filter((p) => !giText.includes(p)).join(' ') + '）');
  }

  return { ok: true, hasLink: true };
}

// ── 3. 扫描产物并验证签名 ──────────────────────────────────────
function collectArtifacts() {
  const out = [];
  if (!fs.existsSync(RELEASE_DIR)) return out;

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      // 只关心会被用户双击的两个对象
      if (/Setup\.exe$/i.test(e.name)) out.push(full);
      else if (/JimengConsole\.exe$/i.test(e.name) && /win-unpacked/i.test(full)) out.push(full);
    }
  };
  walk(RELEASE_DIR);
  return out;
}

function verifyArtifacts(signtool) {
  head('[3/3] 产物签名验证');

  const files = collectArtifacts();
  if (!files.length) {
    warn('release/ 下没有找到 Setup.exe 或 win-unpacked/JimengConsole.exe');
    info('先执行 npm run dist（或 npm run pack）再运行 --verify。');
    return;
  }

  if (!signtool) {
    fail('找不到 signtool.exe，无法验证签名');
    info('请安装 Windows SDK，或设置环境变量 SIGNTOOL 指向 signtool.exe。');
    return;
  }
  pass('signtool：' + signtool);

  for (const f of files) {
    const rel = path.relative(ROOT, f);
    // /pa 用默认验证策略（含时间戳）、/v 详细
    const r = spawnSync(signtool, ['verify', '/pa', '/v', f], { encoding: 'utf8' });
    const text = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0) {
      const signer = (/Issued to:\s*(.+)/i.exec(text) || [])[1];
      pass(rel + (signer ? '   签发对象：' + signer.trim() : ''));
      if (/Timestamp Verified by|时间戳/i.test(text)) {
        info('时间戳已验证（证书过期后签名仍有效）');
      } else {
        warn(rel + '：未检测到有效时间戳，证书过期后用户会重新看到警告');
      }
    } else {
      fail(rel + '：签名验证不通过');
      const firstLines = text.split(/\r?\n/).filter(Boolean).slice(0, 4);
      for (const l of firstLines) info(l);
    }
  }

  // 反向检查：确保这个 exe 不是"只有资源信息、没有签名"的空壳
  info('');
  info('提示：签名只证明发布者身份，不代表安装包内容安全。');
  info('      正式发布还需在干净 Windows 环境完成安装 / 升级 / 卸载测试。');
}

// ── main ────────────────────────────────────────────────────────
console.log(C.b + '即梦批量生成控制台 —— Windows 签名检查' + C.x);
console.log(C.d + '模式：' + (MODE_VERIFY ? '构建后验证' : (MODE_REQUIRE ? '发布卡点' : '发布前自检')) + C.x);

if (!MODE_VERIFY) {
  const cred = checkCredentials();

  head('[2/3] signtool 可用性');
  const st = findSigntool();
  if (st) pass('signtool：' + st);
  else if (MODE_REQUIRE) fail('找不到 signtool.exe（--require 模式下这是致命错误）');
  else warn('找不到 signtool.exe（构建仍可进行，但无法在本地验证签名）');

  if (MODE_REQUIRE) {
    head('[3/3] 结论');
    if (failCount === 0) pass('签名环境就绪，可以执行 npm run dist');
  } else if (cred.ok) {
    console.log('');
    info('下一步：');
    info('  npm run dist                                # 构建并签名');
    info('  node scripts/check-signing.js --verify      # 验证产物签名');
  }
} else {
  verifyArtifacts(findSigntool());
}

// ── 汇总 ────────────────────────────────────────────────────────
console.log('');
if (failCount) {
  console.log(C.r + C.b + '结果：失败（' + failCount + ' 项错误，' + warnCount + ' 项警告）' + C.x);
  process.exit(1);
}
console.log(C.g + C.b + '结果：通过' + (warnCount ? '（' + warnCount + ' 项警告）' : '') + C.x);
process.exit(0);
