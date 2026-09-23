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
    /* ⚠ 2026-09-22 修：`it.name.startsWith(s)` 原对**文件与目录一视同仁**，于是 skip 列表里的
       `.git` 把 `.gitignore` / `.gitattributes` 一并跳过了 —— 这是 `.gitignore` 长期扫不到的
       **第二道**障碍（第一道是 §10 只认带扩展名的白名单，见 §10 注释）。
       skip 的本意是"不钻进这些目录树"（node_modules / .git / dist / release / .test-tmp / .workbuddy），
       所以前缀匹配只应对目录生效；同名文件仍由精确匹配处理。 */
    if (skip && skip.some((s) => it.name === s || (it.isDirectory() && it.name.startsWith(s)))) continue;
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
      fail('README 里找不到「当前版本：**x.y.z**」声明', '格式须为「当前版本：**`' + V + '`**」（脚本按此正则解析）');
    } else if (m[1] !== V) {
      fail('README 当前版本（' + m[1] + '）与 package.json（' + V + '）不一致',
        'README.md 里搜「当前版本」改掉');
    } else {
      ok('README 当前版本与 package.json 一致：' + V);
    }

    // README 是否包含当前版本的变更记录 —— 0.29.2 起**全部**搬到 docs/CHANGELOG.md。
    // 0.29.0 / 0.29.1 的条目同时在 README 末尾的指针与 CHANGELOG.md 里（搬迁后
    // 仍带 #### `V` 标记），所以两处都能命中；这里兼容两种形态。
    const changelog = read('docs/CHANGELOG.md') || '';
    const hasEntry = readme.includes('#### `' + V + '`') || readme.includes('## ' + V) || readme.includes('### ' + V) ||
                    (changelog.includes('#### `' + V + '`') || changelog.includes('## ' + V));
    if (!hasEntry) {
      fail('README / docs/CHANGELOG.md 缺少 ' + V + ' 的变更记录',
        '在 docs/CHANGELOG.md（0.29.2 起）或 README 历史段（0.29.0 / 0.29.1 兼容）里加一节「#### `' + V + '` — <日期>」');
    } else {
      ok('当前版本 ' + V + ' 的变更记录存在（README 或 docs/CHANGELOG.md）');
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
// 4. electron-builder.yml：图标引用与签名配置形状
// ════════════════════════════════════════════════════════════════
head('[4] electron-builder.yml 形状');

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

  // artifactName 与 updater 的**当前产物前缀**必须一致（否则更新器会拒掉自己的产物）
  // 2026-09-23 改：原先把 'JimengConsole-' 写死在门禁里 —— 换名（DreamFlow-）时它只会
  // 一直报"形状变了"，答不出"两处到底一不一致"。改为从 updater.js 源码提取
  // ARTIFACT_PREFIX 再比对：换名时门禁自动跟随，同时仍强制 yml 与 updater 一起改。
  // 注意：updSrc 在本节之后（§9）才定义，这里须自己读一次，不能复用。
  const ymlArt = /artifactName:\s*([A-Za-z0-9_.-]+)-\$\{version\}-x64-Setup\.\$\{ext\}/.exec(yml);
  const updPref = /^const ARTIFACT_PREFIX = '([^']+)';$/m.exec(read('desktop/updater.js') || '');
  if (!ymlArt) {
    fail('yml 里找不到 nsis 的 artifactName: <前缀>-${version}-x64-Setup.${ext}',
      '更新器的白名单靠它对齐，缺了会拒掉自己的产物');
  } else if (!updPref) {
    fail('读不到 desktop/updater.js 的 ARTIFACT_PREFIX',
      '门禁靠它比对 yml 的 artifactName 前缀');
  } else if (ymlArt[1] + '-' !== updPref[1]) {
    fail('yml 的 artifactName 前缀（' + ymlArt[1] + '-）与 updater.js 的 ARTIFACT_PREFIX（'
      + updPref[1] + '）不一致',
      '换名/改名时这两处必须同时改（见 updater.js 的「产物名换前缀」注释）');
  } else {
    ok('artifactName 前缀与 updater 的 ARTIFACT_PREFIX 一致：' + updPref[1]);
  }

  /* ⚠ 2026-09-22 加的：签名配置必须缩进在 `win:` 之下。
     electron-builder 26 的 schema 只认 win.signAndEditExecutable / win.signtoolOptions，
     写在**顶层**会让它直接中止构建（"configuration has an unknown property ..."）——
     CI 首次跑红就是这个，而本地 `npm run check` 当时完全查不出来（只有真跑 pack 才炸）。
     这一项把"要跑几分钟打包才能发现"的错，提前成一条 0.1 秒的门禁。 */
  const nestedOk = /^ {2}signAndEditExecutable:\s*true\s*$/m.test(yml) && /^ {2}signtoolOptions:\s*$/m.test(yml);
  const topLevelBad = /^signAndEditExecutable:/m.test(yml) || /^signtoolOptions:/m.test(yml);
  if (topLevelBad) {
    fail('签名配置写在顶层 —— electron-builder 26 会拒绝构建',
      '把 signAndEditExecutable / signtoolOptions 缩进到 win: 之下（见 yml 内注释）');
  } else if (!nestedOk) {
    fail('yml 里找不到 win: 之下的签名配置（signAndEditExecutable / signtoolOptions）',
      'P0-5 要求发布前有签名卡点；若确实要移除，请同步更新本检查与 test/03');
  } else {
    ok('签名配置嵌套正确（win.signAndEditExecutable / win.signtoolOptions）');
  }
}

// ════════════════════════════════════════════════════════════════
// 5. 是否误提交运行态数据 / 产物 / 密钥
// ════════════════════════════════════════════════════════════════
head('[5] 不该入库的文件');

const FORBIDDEN = [
  { p: 'server/data/db.json', why: '运行态数据库（含用户真实数据）' },
  { p: 'server/data', why: '运行态数据目录' },
  /* allowLocal：本地跑过 npm run pack / dist 时，release/ **本来就该存在**（已在 .gitignore 里）。
     这一项要拦的是"被提交进版本库"，不是"磁盘上存在" —— 否则开发者每次打完包都得先删掉
     release/ 才能过 check（2026-09-22 实测踩到：验证打包修复后 check 立刻误报）。 */
  { p: 'release', why: '安装包产物（上百 MB，可随时重建）', allowLocal: true },
  { p: '.env', why: '环境变量文件' },
  { p: 'desktop-config.json', why: '桌面端本机配置' },
  { p: 'desktop-state.json', why: '桌面端本机状态' }
];
let forbiddenHit = 0;
for (const f of FORBIDDEN) {
  if (!exist(f.p)) continue;
  if (f.allowLocal) {
    let tracked = [];
    try {
      tracked = require('child_process')
        .execFileSync('git', ['ls-files', f.p], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').map((x) => x.trim()).filter(Boolean);
    } catch (e) { /* 非 git 环境（如解压出来的副本）：无从判断，跳过 */ }
    if (!tracked.length) continue;   // 本地存在但未被跟踪 —— 正常，放行
    fail(f.p + '/ 里有文件被 git 跟踪（' + tracked.slice(0, 3).join('、') + (tracked.length > 3 ? ' 等' : '') + '），不应入库',
      '确认 .gitignore 生效，并用 git rm --cached 取消跟踪');
    forbiddenHit++;
    continue;
  }
  fail('存在 ' + f.p + '（' + f.why + '），不应入库', '确认 .gitignore 生效并删除');
  forbiddenHit++;
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
  const need = ['test', 'check', 'lint', 'verify', 'build:web'];
  const miss = need.filter((k) => !PKG.scripts[k]);
  if (miss.length) fail('package.json 缺少脚本：' + miss.join('、'));
  else ok('npm scripts 齐备：' + need.join(' / '));

  if (PKG.scripts.verify && !/npm run check/.test(PKG.scripts.verify)) {
    warn('verify 脚本未包含 check');
  }
  if (PKG.scripts.verify && !/npm run lint/.test(PKG.scripts.verify)) {
    warn('verify 脚本未包含 lint（静态检查）');
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

  /* ⚠ 2026-09-22 加的：`npm test` 必须**逐个列出**测试文件，不能用 glob。
     原因：Node 20 的 `node --test` 只接受文件/目录路径，不支持 glob 展开
     （glob 是 Node 21+ 才有的；而 Node 21+ 又不再支持目录参数）—— CI 跑的是
     Node 20，用 "test/*.test.js" 会让测试整步失败（首次 CI 红灯就是这个）。
     代价是新增测试文件要手动登记，所以这里用机器检查兜住"漏登记"，
     否则会出现"文件加了但 CI 从不跑它"的静默缺口。 */
  const testScript = (PKG && PKG.scripts && PKG.scripts.test) || '';
  const listed = [...testScript.matchAll(/test\/([A-Za-z0-9._-]+\.test\.js)/g)].map((m) => m[1]);
  const missing = testFiles.filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !testFiles.includes(f));
  if (!listed.length) {
    fail('package.json 的 test 脚本没有逐个列出测试文件：' + testScript,
      '必须写成 node --test test/01-xxx.test.js test/02-xxx.test.js …（Node 20 不支持 glob）');
  } else if (missing.length || extra.length) {
    fail('test 脚本与 test/ 目录不一致'
      + (missing.length ? '；未登记：' + missing.join('、') : '')
      + (extra.length ? '；登记了不存在的文件：' + extra.join('、') : ''),
      '把 test/ 下的 *.test.js 全部写进 package.json 的 test 脚本');
  } else {
    ok('test 脚本已逐个登记全部 ' + testFiles.length + ' 个测试文件（Node 20 兼容）');
  }
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

/* ⚠ 2026-09-22 补：原先只用「带扩展名的文本文件」白名单，于是 `.gitignore` 这类
   **无扩展名**文件永远不在扫描范围内 —— `.gitignore` 里的「仓库根是 jimeng-console/」
   注释因此长期漏检（P2-14 在清单里已被标 ✅，实际未改，直到 2026-09-22 人工复核才发现）。
   这里显式补上仓库根的无扩展名文本文件。 */
const TEXT_EXT_RE = /\.(md|yml|yaml|json|js|sh)$/;
const NO_EXT_TEXT = ['.gitignore', '.gitattributes', 'LICENSE'];
const legacyHits = [];
for (const f of walk(ROOT, [], NPM_SKIP.concat(['docs']))) {
  /* 自指豁免：本脚本为了描述这条规则，必然写出「仓库根是 jimeng-console」这句话 ——
     扩白名单后它会扫到自己（2026-09-22 实测踩到）。与 §11 / lint.js 同一处理。 */
  if (rel(f) === 'scripts/check-project.js') continue;
  const base = path.basename(f);
  if (!TEXT_EXT_RE.test(base) && !NO_EXT_TEXT.includes(base)) continue;
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

// ════════════════════════════════════════════════════════════════
// 11. 事实一致性：过期表述（P0-2）
// ════════════════════════════════════════════════════════════════
head('[11] 过期表述（"没有自动化测试"）');

/* 为什么有这一项（2026-09-21）：恢复测试后，代码注释与文档里仍有多处声称
   "本仓库没有自动化测试" —— 它会把后续 agent/人**反向指导**成跳过 npm test，
   把刚建好的门禁重新荒废。这类矛盾不会被版本号检查拦住，必须专门盯。
   两个豁免：① 历史记录类文件（变更日志、审查报告）本就会引用旧说法；
   ② 其余文件里若确属历史叙述，须在**同一行**写明「此前 / 已作废」等标记。 */
/* ⚠ 2026-09-22 补：原先只认三种说法，于是「自动化测试：待恢复最小集合」这类
   **同一件事的其它写法**全部漏检（`docs/项目审查与改进清单.md` 第 15 节的示例块就这么写着，
   直到人工复核才发现）。补两条，但**刻意不泛化到「未实现 / 待恢复」的裸词** ——
   `docs/更改文档.md` 里的「已知未实现项（边界）」是正当的功能边界说明，泛化会误伤。 */
const OUTDATED_RE = /没有自动化测试|已不保留自动化测试|自动化测试已删除|自动化测试[^\n]{0,6}待恢复|待恢复最小(化)?集合/;
const HISTORICAL_MARK_RE = /已作废|此前|历史|曾经|当时|删除过|已恢复|\d+\s*个用例/;
/* 豁免：① 历史记录类文件（变更日志、审查报告）本就会引用旧说法；
   ② 本脚本自身 —— 它为了描述规则必然写出这些词（自指陷阱，与 lint.js 同一处理）。 */
/* ⚠ 2026-09-22 补 `docs/CHANGELOG.md`：它 0.29.2 才新建，没进原始豁免名单 ——
   而变更日志**本就会引用旧说法**（0.29.4 那节为了说明问题，原样引用了
   「自动化测试：待恢复最小集合」）。属豁免原则第 ① 类的遗漏，不是新放宽。 */
const OUTDATED_EXEMPT = ['docs/更改文档.md', 'docs/项目全面审查与改进流程.md', 'docs/CHANGELOG.md', 'scripts/check-project.js'];
const outdatedHits = [];
for (const f of walk(ROOT, [], NPM_SKIP)) {
  if (!/\.(js|md)$/.test(f)) continue;
  const r = rel(f);
  if (OUTDATED_EXEMPT.includes(r)) continue;
  const t = read(r);
  if (t === null) continue;
  t.split('\n').forEach((line, i) => {
    if (!OUTDATED_RE.test(line)) return;
    if (HISTORICAL_MARK_RE.test(line)) return;
    outdatedHits.push(r + ':' + (i + 1));
  });
}
if (outdatedHits.length) {
  fail('仍有过期表述（本仓库已有 test/ 下的自动化测试）：' + outdatedHits.join('、'),
    '改为事实描述并指向 test/ 目录；确属历史叙述请在同一行写明「此前 / 已作废」等标记');
} else {
  ok('无"没有自动化测试"类过期表述（历史记录类文件已豁免）');
}

// ════════════════════════════════════════════════════════════════
// 12. 收尾清单一致性（AGENTS.md ↔ docs/项目文档.md §9，P0-3）
// ════════════════════════════════════════════════════════════════
head('[12] 收尾清单一致性');

/* 抽取"完成一项工作后的固定动作"下的有序列表，比较：条目数 + 每条首句
   （粗体引导语）+ 关键命令是否两处都在。
   为什么只比到这一层：两处文档的引用风格不同（「」 vs ""），逐字比较会因
   标点误报；而"条目漏了一条、命令只写在一处"才是真正让读者走错路的漂移。 */
function dodItems(md) {
  if (!md) return null;
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{2,3}\s*.*完成一项工作后的固定动作/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) break;   // 下一个标题 = 清单结束
    const m = /^\s*(\d+)\.\s+\*\*(.+?)\*\*/.exec(line);
    if (m) items.push({ no: Number(m[1]), lead: m[2].trim(), text: line });
  }
  return items;
}
const dodAgents = dodItems(read('AGENTS.md'));
const dodDoc = dodItems(read('docs/项目文档.md'));
if (!dodAgents || !dodAgents.length) {
  fail('AGENTS.md 里找不到「完成一项工作后的固定动作」的有序列表');
} else if (!dodDoc || !dodDoc.length) {
  fail('docs/项目文档.md 里找不到 §9 收尾清单的有序列表');
} else {
  const norm = (s) => s.replace(/[「」“”"]/g, '"').replace(/\s+/g, '');
  const diffs = [];
  if (dodAgents.length !== dodDoc.length) {
    diffs.push('条目数不同：AGENTS.md ' + dodAgents.length + ' 条 / 项目文档 ' + dodDoc.length + ' 条');
  }
  const n = Math.min(dodAgents.length, dodDoc.length);
  for (let i = 0; i < n; i++) {
    if (norm(dodAgents[i].lead) !== norm(dodDoc[i].lead)) {
      diffs.push('第 ' + (i + 1) + ' 条首句不同：AGENTS「' + dodAgents[i].lead + '」/ 文档「' + dodDoc[i].lead + '」');
    }
  }
  const KEY_CMDS = ['node build.js', 'npm run verify', 'git push origin main'];
  for (const cmd of KEY_CMDS) {
    const inA = dodAgents.some((x) => x.text.includes(cmd));
    const inD = dodDoc.some((x) => x.text.includes(cmd));
    if (inA !== inD) diffs.push('关键命令只出现在一处：`' + cmd + '`');
  }
  if (diffs.length) {
    fail('收尾清单两处不一致：' + diffs.join('；'),
      '以 AGENTS.md 为准同步 docs/项目文档.md §9（见 AGENTS.md 第 5 步）');
  } else {
    ok('AGENTS.md 与 docs/项目文档.md §9 一致（' + dodAgents.length + ' 条）');
  }
}

// ════════════════════════════════════════════════════════════════
// 13. docs/ 状态标记（P2-4）
// ════════════════════════════════════════════════════════════════
head('[13] docs/ 状态标记');

/* 每份 docs/*.md 头部必须有 `> 状态：现行` 或 `> 状态：历史（写于 vX.Y）`，
   让读者 1 分钟内能判断这份文档是现行契约还是历史设计 —— 历史上这里
   并存过两份互相重叠、各自落后的"项目说明"。 */
const docDir = path.join(ROOT, 'docs');
const docFiles = fs.existsSync(docDir)
  ? fs.readdirSync(docDir).filter((f) => /\.md$/.test(f))
  : [];
const noStatus = [];
for (const f of docFiles) {
  const t = read('docs/' + f) || '';
  if (!/^>\s*状态：/m.test(t)) noStatus.push(f);
}
if (!docFiles.length) {
  fail('docs/ 下没有任何 .md');
} else if (noStatus.length) {
  fail('docs/ 下缺少「状态：」标记：' + noStatus.join('、'),
    '每份文档头部加一行 `> 状态：现行` 或 `> 状态：历史（写于 vX.Y）`；文档地图见 docs/项目文档.md §12');
} else {
  ok('docs/ 下 ' + docFiles.length + ' 份文档均有状态标记');
}

// ════════════════════════════════════════════════════════════════
// 14. 路由计数一致性（P3-2）
// ════════════════════════════════════════════════════════════════
head('[14] 路由计数（server/routes.js ↔ docs/项目文档.md）');

/* 口径：**一个路由表项（一个正则）= 1 条**。文档里若给出"路径 + 方法"的
   另一口径（同一行含「组合」字样），按已写明口径豁免。
   为什么值得机器校验：文档里的"53 条"曾经与代码的 54 条并存了很久 ——
   "看起来精确的数字"最容易骗人，因为它让人以为有人核对过。 */
const routesSrc = read('server/routes.js') || '';
const routeCount = (routesSrc.match(/^\s*\['/gm) || []).length;
const docMd = read('docs/项目文档.md') || '';
const declared = /路由表实测\s*(\d+)\s*条/.exec(docMd);
if (!routeCount) {
  fail('server/routes.js 里数不到路由表项（形状变了？）');
} else if (!declared) {
  fail('docs/项目文档.md 里找不到「路由表实测 N 条」声明',
    '补一句形如「**路由表实测 ' + routeCount + ' 条**（`server/routes.js`）」');
} else {
  const mism = [];
  if (Number(declared[1]) !== routeCount) {
    mism.push('「路由表实测」写的是 ' + declared[1] + '，代码是 ' + routeCount);
  }
  docMd.split('\n').forEach((line, i) => {
    if (!/路由|接口数量/.test(line)) return;
    const m = /(\d+)\s*条/.exec(line);
    if (!m) return;
    if (Number(m[1]) === routeCount) return;
    if (/组合/.test(line)) return;   // 另一口径（路径 + 方法），文档里已写明
    mism.push('第 ' + (i + 1) + ' 行写的是 ' + m[1] + ' 条');
  });
  if (mism.length) {
    fail('路由计数与代码不一致：' + mism.join('；'),
      '口径：一个路由表项（一个正则）= 1 条；当前代码 = ' + routeCount + ' 条');
  } else {
    ok('路由计数与代码一致（' + routeCount + ' 条）');
  }
}

// ════════════════════════════════════════════════════════════════
// 15. git remote 与仓库声明一致（P3-1）
// ════════════════════════════════════════════════════════════════
head('[15] git remote 与仓库声明');

/* 2026-09-21：GitHub 仓库已改名为 DreamFlow，本地 remote 还指向旧名
   jimeng-console（靠 GitHub 的 301 重定向工作）。这一项把"声明"与"实际"
   钉在一起，避免文档说 DreamFlow、clone 下来却是 jimeng-console。 */
let remoteUrl = '';
try {
  remoteUrl = require('child_process')
    .execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' })
    .trim();
} catch (e) { /* 下面按空值报错 */ }
if (!remoteUrl) {
  fail('读不到 git remote origin（不在 git 仓库里？）');
} else {
  /* 接受四种等价写法（都指向同一个仓库）：
       https://github.com/<owner>/<repo>.git
       git@github.com:<owner>/<repo>.git
       ssh://git@github.com[:port]/<owner>/<repo>.git
       ssh://git@ssh.github.com:443/<owner>/<repo>.git   ← 本机在用这条（HTTPS 被墙时走 443 的 SSH）
     ⚠ 最后一种不是"另一个仓库"，别把它判成不一致。 */
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/(?:git@)?(?:ssh\.github\.com|github\.com)(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (!m) {
    fail('origin 不是 GitHub 地址：' + remoteUrl);
  } else if (m[1] !== 'ikun1946' || m[2] !== 'DreamFlow') {
    fail('origin 指向 ' + m[1] + '/' + m[2] + '，与声明（ikun1946/DreamFlow）不一致',
      '方案 A（推荐）：git remote set-url origin https://github.com/ikun1946/DreamFlow.git'
      + '（或 ssh://git@ssh.github.com:443/ikun1946/DreamFlow.git）；'
      + '方案 B：改文档承认旧仓库名 —— 二选一，别让两者继续漂移');
  } else {
    ok('origin 与声明一致：' + m[1] + '/' + m[2]);
  }
}

// ════════════════════════════════════════════════════════════════
// 16. 文档里的数量口径与实际一致（用例数 / 检查项数）
// ════════════════════════════════════════════════════════════════
head('[16] 文档中的数量口径');

/* 为什么加这一项：README「版本」一节写着「npm test（N 用例）、npm run check（N 项一致性检查）」，
   而这两个数字已经漂移过两轮 —— 用例从 89 涨到 95 时没跟上，检查项从 40 涨到 42 时也没跟上。
   数字是读者判断"这套门禁有多厚"的唯一依据，写错比不写更糟；而它偏偏是最容易被忘掉的一类改动
   （加测试、加检查都在别的文件里，没人会想到回头改 README）。所以交给机器盯。

   口径（写在这里，免得下次又靠猜）：
     · 用例数 = test/*.test.js 里**字面量** `test(` 的个数，与 `node --test` 报的 tests 数一致；
       ⚠ 若将来用循环批量生成用例，静态计数会偏小 —— 那时请把 README 改成实际数字，并在此注明原因。
     · 检查项数 = 本脚本实际执行的检查数（就是最后汇总里打印的那个数）。
       本项自己也算一次检查，所以此刻的 `checks + 1` 就是最终总数。 */
const caseDir = path.join(ROOT, 'test');
const caseFiles = fs.existsSync(caseDir)
  ? fs.readdirSync(caseDir).filter((f) => f.endsWith('.test.js')).sort()
  : [];
let caseCount = 0;
caseFiles.forEach((f) => { caseCount += ((read('test/' + f) || '').match(/^\s*test\(/gm) || []).length; });
const expectedTotal = checks + 1;

const readmeText = read('README.md') || '';
const mCases = /`npm test`（(\d+) 用例）/.exec(readmeText);
const mChecks = /`npm run check`（(\d+) 项一致性检查）/.exec(readmeText);
const drift = [];
if (!mCases) drift.push('README 找不到「`npm test`（N 用例）」的写法');
else if (Number(mCases[1]) !== caseCount) drift.push('README 用例数写的是 ' + mCases[1] + '，实际 ' + caseCount);
if (!mChecks) drift.push('README 找不到「`npm run check`（N 项一致性检查）」的写法');
else if (Number(mChecks[1]) !== expectedTotal) drift.push('README 检查项数写的是 ' + mChecks[1] + '，实际 ' + expectedTotal);

/* AGENTS.md 的门禁表里有同样两个数字（agent 一进来就先看这张表，错了会把 agent 带偏） */
const agentsText = read('AGENTS.md') || '';
const aCases = /(\d+) 用例全通/.exec(agentsText);
const aChecks = /(\d+) 项全通/.exec(agentsText);
if (!aCases) drift.push('AGENTS.md 找不到「N 用例全通」的写法');
else if (Number(aCases[1]) !== caseCount) drift.push('AGENTS.md 用例数写的是 ' + aCases[1] + '，实际 ' + caseCount);
if (!aChecks) drift.push('AGENTS.md 找不到「N 项全通」的写法');
else if (Number(aChecks[1]) !== expectedTotal) drift.push('AGENTS.md 检查项数写的是 ' + aChecks[1] + '，实际 ' + expectedTotal);

/* ── README「当前状态」表格：口径的第二处落点（2026-09-22 · 0.29.3 补） ────────
   上面四条只认 README「版本」一节那句「`npm test`（N 用例）」的写法，而
   README 顶部「当前状态」表格里写着**另一份**口径：「**N 个用例**」与
   「N 节 M 项一致性检查」。实测 0.29.3 本轮：表格当时还留着 89 个用例 /
   15 节 40 项 —— 与实际相差 64 个用例、3 项检查，却因为正则根本匹配不到
   那两行而长期没被发现（§16 一直报 OK）。表格是读者第一眼看到的地方，
   错了比不写更糟，所以这里把四个数字一并钉住：用例数 / 检查项数 / 检查节数 / lint 项数。
   ⚠ 节数与 lint 项数直接数源码里的 `head('[N] ...')`，不硬编码 —— 加减小节时自动跟上。 */
const sectionCount = (fs.readFileSync(__filename, 'utf8').match(/^head\('\[/gm) || []).length;
const lintCount = ((read('scripts/lint.js') || '').match(/^head\('\[/gm) || []).length;

const mTableCases = /\*\*(\d+) 个用例\*\*/.exec(readmeText);
if (!mTableCases) drift.push('README「当前状态」表格找不到「**N 个用例**」的写法');
else if (Number(mTableCases[1]) !== caseCount) {
  drift.push('README 表格用例数写的是 ' + mTableCases[1] + '，实际 ' + caseCount);
}

const mTableChecks = /(\d+) 节 (\d+) 项一致性检查/.exec(readmeText);
if (!mTableChecks) drift.push('README 表格找不到「N 节 M 项一致性检查」的写法');
else {
  if (Number(mTableChecks[1]) !== sectionCount) {
    drift.push('README 表格写的检查节数是 ' + mTableChecks[1] + '，实际 ' + sectionCount);
  }
  if (Number(mTableChecks[2]) !== expectedTotal) {
    drift.push('README 表格写的检查项数是 ' + mTableChecks[2] + '，实际 ' + expectedTotal);
  }
}

const mTableLint = /(\d+) 项静态检查/.exec(readmeText);
if (!mTableLint) drift.push('README 表格找不到「N 项静态检查」的写法（lint 项数）');
else if (Number(mTableLint[1]) !== lintCount) {
  drift.push('README 表格写的 lint 项数是 ' + mTableLint[1] + '，实际 ' + lintCount);
}

/* AGENTS.md 的「N 项全通」有两处（check 与 lint），上面对了第一处，
   这里补 lint 那一处 —— 0.29.3 之前它写的是 6 项，而 lint 早已是 7 项。 */
const aFullPass = [...agentsText.matchAll(/(\d+) 项全通/g)].map((m) => Number(m[1]));
if (!aFullPass.includes(lintCount)) {
  drift.push('AGENTS.md 的「N 项全通」里没有 lint 的实际项数 ' + lintCount
    + '（现有：' + aFullPass.join(' / ') + '）');
}

if (drift.length) {
  fail('文档里的数量口径与实际不一致：' + drift.join('；'),
    '改 README「版本」一节那句话 + AGENTS.md 的门禁表即可（口径见本文件第 16 节注释）');
} else {
  ok('文档数量口径与实际一致（' + caseCount + ' 用例 / ' + expectedTotal + ' 项检查）');
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
