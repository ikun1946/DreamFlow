#!/usr/bin/env node
/**
 * scripts/check-project.js —— 统一项目检查脚本
 *
 * 对应 docs/项目审查与改进清单.md §7 的九项检查。定位是**发布前的廉价门禁**：
 * 这些错误都不该靠"发出去之后被用户发现"，但也不值得写进单元测试
 * （它们是"仓库状态"问题，不是"代码逻辑"问题）。
 *
 * 用法：
 *   node scripts/check-project.js            # 检查，有问题则退出码 1
 *   node scripts/check-project.js --quiet    # 只输出 FAIL / WARN
 *
 * 退出码：0 = 通过（可能有警告）；1 = 有失败项
 *
 * 零依赖：只用 Node 内置模块。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

// ── 输出小工具 ──────────────────────────────────────────────────
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

const failures = [];
const warnings = [];
let checks = 0;

function ok(msg) { checks++; if (!QUIET) console.log(C.g + '  OK    ' + C.x + msg); }
function fail(msg, hint) {
  checks++; failures.push(msg);
  console.log(C.r + '  FAIL  ' + C.x + msg);
  if (hint) console.log(C.d + '         → ' + hint + C.x);
}
function warn(msg, hint) {
  checks++; warnings.push(msg);
  if (QUIET) return;
  console.log(C.y + '  WARN  ' + C.x + msg);
  if (hint) console.log(C.d + '         → ' + hint + C.x);
}
function head(msg) {
  if (QUIET) return;
  console.log('\n' + C.b + msg + C.x);
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return null; } };
const exist = (p) => fs.existsSync(path.join(ROOT, p));

/* 目录遍历（跳过不该看的）。 */
function walk(dir, out, skip) {
  out = out || [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    if (skip && skip.some((s) => it.name === s || it.name.startsWith(s))) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, out, skip);
    else out.push(full);
  }
  return out;
}

const NPM_SKIP = ['node_modules', '.git', 'dist', 'release', '.test-tmp', '.workbuddy'];

console.log(C.b + '即梦批量生成控制台 —— 项目检查' + C.x);

// ════════════════════════════════════════════════════════════════
// 1. 版本号一致性：package.json ↔ README ↔ docs
// ════════════════════════════════════════════════════════════════
head('[1] 版本号一致性');

let PKG = null;
try { PKG = JSON.parse(read('package.json')); } catch (e) { /* 下面报错 */ }

if (!PKG) {
  fail('package.json 无法解析');
} else {
  const V = PKG.version;
  ok('package.json 版本：' + V);

  if (!/^\d+\.\d+\.\d+$/.test(V)) fail('版本号不是 x.y.z 形式：' + V);

  // README 里的"当前版本"声明
  const readme = read('README.md');
  if (readme === null) {
    fail('README.md 不存在');
  } else {
    const m = /当前版本[：:]\s*\*\*`?(\d+\.\d+\.\d+)`?\*\*/.exec(readme);
    if (!m) {
      fail('README 里找不到「当前版本：**x.y.z**」声明', '格式须为「当前版本：**`0.27.0`**」（脚本按此正则解析）');
    } else if (m[1] !== V) {
      fail('README 当前版本（' + m[1] + '）与 package.json（' + V + '）不一致',
        'README.md 里搜「当前版本」改掉');
    } else {
      ok('README 当前版本与 package.json 一致：' + V);
    }

    // README 是否包含当前版本的变更记录
    const hasEntry = readme.includes('#### `' + V + '`') || readme.includes('## ' + V) || readme.includes('### ' + V);
    if (!hasEntry) {
      fail('README 缺少 ' + V + ' 的变更记录',
        '在版本历史里加一节，形如「#### `' + V + '` — <日期>」');
    } else {
      ok('README 含 ' + V + ' 的变更记录');
    }
  }

  // docs 里的版本漂移
  const docsDir = path.join(ROOT, 'docs');
  if (fs.existsSync(docsDir)) {
    const drift = [];
    for (const f of walk(docsDir, [], NPM_SKIP)) {
      if (!/\.md$/.test(f)) continue;
      const t = read(rel(f));
      if (!t) continue;
      // 找形如 "当前版本 ... 0.2x.y" 的声明
      const mm = /当前版本[^\n]{0,20}?(\d+\.\d+\.\d+)/g;
      let g;
      while ((g = mm.exec(t))) {
        if (g[1] !== V) drift.push(rel(f) + '（写的是 ' + g[1] + '）');
      }
    }
    if (drift.length) {
      fail('文档里的「当前版本」与 package.json 不一致：' + drift.join('、'),
        'docs/*.md 里的版本号需同步到 ' + V);
    } else {
      ok('docs/ 下无「当前版本」漂移');
    }
  }
}

// ════════════════════════════════════════════════════════════════
// 2. app/ 与 dist/ 是否同步
// ════════════════════════════════════════════════════════════════
head('[2] app/ 与 dist/ 同步');

if (!exist('dist')) {
  warn('dist/ 不存在（未执行过 node build.js）',
    '发布前执行 npm run build:web；本地开发可忽略');
} else {
  /* build.js 把 app/ 内联成 dist/ 单文件版。
     判据不是"内容完全一致"，而是"app/ 的源文件都比 dist 产物旧"——
     若 app/ 有更新的文件，说明改了源码没重建。 */
  const distFiles = fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /\.(html|js|css)$/.test(f));
  if (!distFiles.length) {
    fail('dist/ 存在但里面没有构建产物');
  } else {
    let distNewest = 0;
    for (const f of distFiles) {
      distNewest = Math.max(distNewest, fs.statSync(path.join(ROOT, 'dist', f)).mtimeMs);
    }
    const srcFiles = walk(path.join(ROOT, 'app'), [], NPM_SKIP)
      .filter((f) => /\.(html|js|css)$/.test(f));
    const stale = srcFiles.filter((f) => fs.statSync(f).mtimeMs > distNewest);

    if (stale.length) {
      fail('app/ 有文件比 dist/ 产物更新（改了源码未重建）：' + stale.map(rel).join('、'),
        '执行 npm run build:web');
    } else {
      ok('dist/ 比 app/ 的源码新（共 ' + distFiles.length + ' 个产物）');
    }
  }
}

// ════════════════════════════════════════════════════════════════
// 3. 图标资源齐备
// ════════════════════════════════════════════════════════════════
head('[3] 图标资源');

const ICONS = ['build/icon-source.png', 'build/icon.png', 'build/icon.ico'];
const missingIcons = ICONS.filter((f) => !exist(f));
if (missingIcons.length) {
  fail('图标缺失：' + missingIcons.join('、'),
    missingIcons.includes('build/icon-source.png')
      ? 'icon-source.png 是图标母版（需手工放入），再执行 npm run icons 派生另两个'
      : '执行 npm run icons 生成');
} else {
  ok('三个图标齐备：' + ICONS.join('、'));
}

// ════════════════════════════════════════════════════════════════
// 4. electron-builder.yml 引用的图标存在
// ════════════════════════════════════════════════════════════════
head('[4] electron-builder.yml 图标引用');

const yml = read('electron-builder.yml');
if (yml === null) {
  fail('electron-builder.yml 不存在');
} else {
  const refs = [...yml.matchAll(/(?:^\s*icon:\s*|\bfrom:\s*)(build\/[A-Za-z0-9._-]+)/gm)].map((m) => m[1]);
  const uniq = [...new Set(refs)];
  if (!uniq.length) {
    fail('electron-builder.yml 里没有找到图标引用（icon: / from: build/...）');
  } else {
    const bad = uniq.filter((r) => !exist(r));
    if (bad.length) fail('electron-builder.yml 引用了不存在的图标：' + bad.join('、'));
    else ok('yml 引用的 ' + uniq.length + ' 个图标均存在：' + uniq.join('、'));
  }

  // artifactName 与 updater 的白名单必须同形状（否则更新器会拒掉自己的产物）
  const m = /artifactName:\s*JimengConsole-\$\{version\}-x64-Setup\.\$\{ext\}/.exec(yml);
  if (!m) {
    fail('yml 的 artifactName 形状变了，但 updater.js 的白名单正则是写死的',
      '须同时更新 desktop/updater.js 的 ARTIFACT_RE');
  } else {
    ok('artifactName 与 updater 白名单同形状');
  }
}

// ════════════════════════════════════════════════════════════════
// 5. 是否误提交运行态数据 / 产物 / 密钥
// ════════════════════════════════════════════════════════════════
head('[5] 不该入库的文件');

const FORBIDDEN = [
  { p: 'server/data/db.json', why: '运行态数据库（含用户真实数据）' },
  { p: 'server/data', why: '运行态数据目录' },
  { p: 'release', why: '安装包产物（上百 MB，可随时重建）' },
  { p: '.env', why: '环境变量文件' },
  { p: 'desktop-config.json', why: '桌面端本机配置' },
  { p: 'desktop-state.json', why: '桌面端本机状态' }
];
let forbiddenHit = 0;
for (const f of FORBIDDEN) {
  if (exist(f.p)) { fail('存在 ' + f.p + '（' + f.why + '），不应入库', '确认 .gitignore 生效并删除'); forbiddenHit++; }
}
if (!forbiddenHit) ok('未发现运行态数据 / 产物残留');

// 密钥类文件（在仓库内扫，排除 node_modules）
const keyFiles = walk(ROOT, [], NPM_SKIP).filter((f) => /\.(pem|key|p12|pfx|p8)$/i.test(f));
if (keyFiles.length) {
  fail('仓库内存在私钥/证书文件：' + keyFiles.map(rel).join('、'),
    '私钥绝不能入库，请移到仓库外并确认 .gitignore 已忽略');
} else {
  ok('仓库内无私钥/证书文件');
}

// gitignore 是否覆盖私钥
const gi = read('.gitignore') || '';
const needGi = ['*.pem', '*.key', '*.p12'];
const missGi = needGi.filter((p) => !gi.includes(p));
if (missGi.length) fail('.gitignore 未忽略私钥类型：' + missGi.join('、'));
else ok('.gitignore 已忽略私钥类型');

// Token 硬编码扫描（粗筛，命中即人工确认）
const scanDirs = ['server', 'desktop', 'app', 'scripts'].map((d) => path.join(ROOT, d));
let tokenHits = [];
for (const d of scanDirs) {
  for (const f of walk(d, [], NPM_SKIP)) {
    if (!/\.(js|json)$/.test(f)) continue;
    const t = read(rel(f));
    if (!t) continue;
    // 常见形态：ghp_xxx / ghp- / Bearer <长串> / token: '<20+ 字符>'
    const pats = [
      /\bgh[pousr]_[A-Za-z0-9]{20,}/,
      /\bgithub_pat_[A-Za-z0-9_]{20,}/,
      /['"]?token['"]?\s*[:=]\s*['"][A-Za-z0-9_\-]{32,}['"]/i
    ];
    if (pats.some((re) => re.test(t))) tokenHits.push(rel(f));
  }
}
if (tokenHits.length) {
  warn('疑似硬编码 Token：' + tokenHits.join('、'),
    '人工确认是否为真实凭据（配置项默认空字符串属正常）');
} else {
  ok('未发现疑似硬编码 Token');
}

// ════════════════════════════════════════════════════════════════
// 6. updater.js 默认仓库正确
// ════════════════════════════════════════════════════════════════
head('[6] 更新器配置');

const updSrc = read('desktop/updater.js');
if (updSrc === null) {
  fail('desktop/updater.js 不存在');
} else {
  if (/repo:\s*'DreamFlow'/.test(updSrc)) ok("updater 默认仓库为 'DreamFlow'");
  else fail("updater.js 的 DEFAULT_SOURCE.repo 不是 'DreamFlow'", '在 DEFAULT_SOURCE 里改正');

  if (/owner:\s*'ikun1946'/.test(updSrc)) ok("updater 默认 owner 为 'ikun1946'");
  else fail("updater.js 的 DEFAULT_SOURCE.owner 不是 'ikun1946'");

  // 旧仓库名残留
  if (/jimeng-console/.test(updSrc)) {
    fail('updater.js 里残留旧仓库名 jimeng-console',
      '更新源改名为 DreamFlow 后，旧名会导致 404');
  } else {
    ok('updater.js 无旧仓库名残留');
  }

  // HTTPS 与 SHA-512
  if (/https:\/\/(api\.)?github\.com/.test(updSrc)) ok('更新走 GitHub HTTPS');
  else warn('未检出 GitHub https 端点，请确认更新源是安全的');

  if (/sha512/i.test(updSrc)) ok('更新器处理 SHA-512 校验和');
  else fail('更新器未处理 SHA-512 —— 没有校验和的自动更新等于可被中间人替换');

  // 文件名白名单必须存在（P0-1）
  if (/function safeArtifactName/.test(updSrc) && /ARTIFACT_RE/.test(updSrc)) {
    ok('更新文件名走白名单校验（safeArtifactName）');
  } else {
    fail('缺少 safeArtifactName / ARTIFACT_RE —— 路径穿越防护被移除');
  }
}

// ════════════════════════════════════════════════════════════════
// 7. 是否残留 dreamina-canvas 的运行时代码引用
// ════════════════════════════════════════════════════════════════
head('[7] 画布 CLI（dreamina-canvas）残留');

const runtimeHits = [];
for (const d of ['server', 'desktop', 'app'].map((x) => path.join(ROOT, x))) {
  for (const f of walk(d, [], NPM_SKIP)) {
    const t = read(rel(f));
    if (t === null) continue;
    // 只看"真在调它"的形态，历史说明性注释（已退役/已移除）不算
    const lines = t.split('\n');
    lines.forEach((line, i) => {
      if (!/dreamina[-_]canvas/.test(line)) return;
      // 白名单：明确说明"已移除/已退役/不再是"的行
      if (/已移除|已退役|已下线|退役|移除|不再|deprecated|废弃/.test(line)) return;
      // 白名单：注释里讲历史的
      if (/^\s*(\*|\/\/)/.test(line) && /历史|此前|曾经|原 |过去/.test(line)) return;
      runtimeHits.push(rel(f) + ':' + (i + 1));
    });
  }
}
if (runtimeHits.length) {
  fail('疑似仍在引用画布 CLI：' + runtimeHits.join('、'),
    '画布 CLI 已彻底移除；如需保留历史说明，请在同行写明「已移除」');
} else {
  ok('运行时代码未引用 dreamina-canvas');
}

// 仓库内不得存在 canvas CLI 的配置项（如 cliPath）
const cfgSrc = read('server/config.js') || '';
if (/cliPath/.test(cfgSrc) && !/legacyCliPath/.test(cfgSrc)) {
  warn('config.js 里仍出现 cliPath（画布时代的配置项）');
} else {
  ok('config.js 无画布时代配置项');
}

// ════════════════════════════════════════════════════════════════
// 8. 许可与第三方声明（P0-4）
// ════════════════════════════════════════════════════════════════
head('[8] 许可与第三方声明');

if (!exist('LICENSE')) {
  fail('缺少 LICENSE 文件', 'P0-4：发布阻塞项');
} else {
  ok('LICENSE 存在');
  if (PKG && PKG.license === 'UNLICENSED') {
    fail('package.json 的 license 仍是 UNLICENSED（无信息量）',
      '改为 "SEE LICENSE IN LICENSE"');
  } else if (PKG && PKG.license) {
    ok('package.json license 字段：' + PKG.license);
  }
}

if (!exist('THIRD-PARTY-NOTICES.md')) {
  fail('缺少 THIRD-PARTY-NOTICES.md', 'P0-4：需说明 dreamina / FFmpeg / Electron 的分发边界');
} else {
  const t = read('THIRD-PARTY-NOTICES.md');
  const need = [
    { re: /dreamina/i, name: 'dreamina' },
    { re: /FFmpeg/i, name: 'FFmpeg' },
    { re: /GPL/i, name: 'GPL 边界' },
    { re: /Electron/i, name: 'Electron' }
  ];
  const miss = need.filter((n) => !n.re.test(t));
  if (miss.length) fail('THIRD-PARTY-NOTICES 未覆盖：' + miss.map((m) => m.name).join('、'));
  else ok('THIRD-PARTY-NOTICES 覆盖 dreamina / FFmpeg / GPL / Electron');
}

// LICENSE 与 THIRD-PARTY 必须被打进安装包
if (yml) {
  const packedLicense = /^\s*-\s*LICENSE\s*$/m.test(yml);
  const packedThird = /THIRD-PARTY-NOTICES\.md/.test(yml);
  if (!packedLicense) fail('electron-builder.yml 的 files 未包含 LICENSE（安装包内缺失授权声明）');
  else ok('安装包包含 LICENSE');
  if (!packedThird) warn('electron-builder.yml 的 files 未包含 THIRD-PARTY-NOTICES.md');
  else ok('安装包包含 THIRD-PARTY-NOTICES.md');
}

// ════════════════════════════════════════════════════════════════
// 9. 工程门禁：npm scripts 与测试文件
// ════════════════════════════════════════════════════════════════
head('[9] 工程门禁');

if (PKG && PKG.scripts) {
  const need = ['test', 'check', 'verify', 'build:web'];
  const miss = need.filter((k) => !PKG.scripts[k]);
  if (miss.length) fail('package.json 缺少脚本：' + miss.join('、'));
  else ok('npm scripts 齐备：' + need.join(' / '));

  if (PKG.scripts.verify && !/npm run check/.test(PKG.scripts.verify)) {
    warn('verify 脚本未包含 check');
  }
  if (PKG.scripts.verify && !/npm test/.test(PKG.scripts.verify)) {
    warn('verify 脚本未包含 test');
  }
} else {
  fail('package.json 缺少 scripts 段');
}

const testFiles = fs.existsSync(path.join(ROOT, 'test'))
  ? fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /\.test\.js$/.test(f))
  : [];
if (!testFiles.length) {
  fail('test/ 下没有任何 *.test.js（自动化测试被删了？）',
    'P1-6：至少要覆盖数据安全 / 任务逻辑 / 构建发布三组');
} else {
  ok('自动化测试文件 ' + testFiles.length + ' 个：' + testFiles.join('、'));
}

if (!exist('scripts/check-project.js')) fail('scripts/check-project.js 不在（自我检查）');
if (!exist('scripts/check-signing.js')) warn('缺少 scripts/check-signing.js（P0-5 签名自检）', '签名是发布阻塞项');

// CI
if (!exist('.github/workflows/ci.yml')) {
  fail('缺少 .github/workflows/ci.yml', 'P1-8：需 Linux 检查 + Windows 打包两个 job');
} else {
  const ci = read('.github/workflows/ci.yml');
  if (!/windows/i.test(ci)) warn('CI 里没有 Windows job（本项目目标平台是 Windows）');
  else ok('CI 含 Windows job');
  if (!/node-version/.test(ci)) warn('CI 未固定 Node 版本');
  else ok('CI 固定了 Node 版本');
}

// smoke
if (!exist('scripts/smoke-web.js')) {
  warn('缺少 scripts/smoke-web.js（网页版 smoke test）', 'P1-9：网页版与桌面版验收流程应分离');
} else {
  ok('网页版 smoke 脚本存在');
}

// E2E 业务流验证（清单 §5：端到端覆盖主要业务流程）
if (!exist('scripts/e2e-flow.js')) {
  warn('缺少 scripts/e2e-flow.js（端到端业务流验证）', '清单 §5：应覆盖建项目→素材→分镜→删除的完整链路');
} else {
  ok('端到端业务流脚本存在');
}
{
  const pkg = read('package.json');
  if (!/"e2e"\s*:/.test(pkg)) warn('package.json 未登记 e2e 脚本', '应可用 npm run e2e 一键跑端到端验证');
  else ok('npm run e2e 已登记');
  const ci = exist('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : '';
  if (ci && !/smoke:web/.test(ci)) warn('CI 未跑网页版 smoke', '应在 check job 里执行 npm run smoke:web');
  else if (ci) ok('CI 已包含网页版 smoke');
  if (ci && !/npm run e2e/.test(ci)) warn('CI 未跑端到端验证', '应在 check job 里执行 npm run e2e');
  else if (ci) ok('CI 已包含端到端验证');
}

// ════════════════════════════════════════════════════════════════
// 10. 补充：旧仓库名残留（P2-14）
// ════════════════════════════════════════════════════════════════
head('[10] 旧仓库名残留（jimeng-console 作为**仓库/路径**）');

const legacyHits = [];
for (const f of walk(ROOT, [], NPM_SKIP.concat(['docs']))) {
  if (!/\.(md|yml|yaml|json|js|sh)$/.test(f)) continue;
  const t = read(rel(f));
  if (t === null) continue;
  const lines = t.split('\n');
  lines.forEach((line, i) => {
    // 只关心"被当成仓库根名/路径"的用法，不关心历史叙述
    if (!/jimeng-console/.test(line)) return;
    if (/仓库根是\s*jimeng-console/.test(line)) legacyHits.push(rel(f) + ':' + (i + 1));
  });
}
if (legacyHits.length) {
  fail('残留旧仓库根名说明：' + legacyHits.join('、'),
    'P2-14：应改为 DreamFlow');
} else {
  ok('无旧仓库根名残留');
}

// ── 汇总 ────────────────────────────────────────────────────────
console.log('');
if (failures.length) {
  console.log(C.r + C.b + '结果：失败（' + failures.length + ' 项错误，'
    + warnings.length + ' 项警告 / 共检查 ' + checks + ' 项）' + C.x);
  if (QUIET) {
    console.log('');
    failures.forEach((f) => console.log(C.r + '  FAIL  ' + C.x + f));
  }
  process.exit(1);
}
console.log(C.g + C.b + '结果：通过（共检查 ' + checks + ' 项'
  + (warnings.length ? '，' + warnings.length + ' 项警告' : '') + '）' + C.x);
process.exit(0);
