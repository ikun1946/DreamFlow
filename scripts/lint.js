#!/usr/bin/env node
/**
 * scripts/lint.js —— 零依赖静态检查（质量门禁）
 *
 * 对应 docs/项目全面审查与改进流程.md 的 P1-6。定位是**便宜的语法外门禁**：
 * check-project.js 管"仓库状态一致性"，这里管"代码里不该有的东西"。
 * 两者都刻意不引 eslint —— 本仓库的硬约束是零运行时依赖、不装 npm 也能开发，
 * 所以只用 Node 内置能力做能落地的检查。
 *
 * 检查项（FAIL = 退出码 1）：
 *   1. 语法：全部 .js 能被编译（等价 node --check，但一次进程跑完）
 *   2. debugger 语句
 *   3. app/ 下的 console.log / debug / info（前端调试残留）
 *   4. 相对 require 的目标文件存在（复制粘贴残留 / 改名漏改）
 *
 * 告警项（WARN = 只提示，不阻断）：
 *   5. innerHTML 行上的模板插值 `${...}` 未包 esc()/escAttr() 等安全函数
 *   6. TODO / FIXME 计数
 *
 * 用法：
 *   node scripts/lint.js            # 检查，有问题则退出码 1
 *   node scripts/lint.js --quiet    # 只输出 FAIL / WARN
 *
 * 已知边界（刻意保留，避免过度声称）：
 *   · 第 5 项只看**同一行**上的 `innerHTML` 与 `${...}`；本仓库前端主流写法是
 *     字符串拼接（`'<b>' + esc(x) + '</b>'`），拼接里的漏转义查不出来 ——
 *     那一类要靠 review 与 P1-2 的 CSP nonce 收口。
 *   · 注释里的关键词会被跳过（行首 // 或 * 的行不参与 2/3 项判定）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

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
function head(msg) { if (!QUIET) console.log('\n' + C.b + msg + C.x); }

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

const SKIP = ['node_modules', '.git', 'dist', 'release', '.test-tmp', '.workbuddy'];
function walk(dir, out) {
  out = out || [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const it of items) {
    if (SKIP.some((s) => it.name === s)) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SCAN_DIRS = ['app', 'server', 'desktop', 'scripts', 'test'];
const FILES = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), FILES);
if (fs.existsSync(path.join(ROOT, 'build.js'))) FILES.push(path.join(ROOT, 'build.js'));
const JS_FILES = FILES.filter((f) => /\.js$/.test(f));

/* 注释行判定：行首 // 或 *（块注释内）的行不参与关键词扫描。 */
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

console.log(C.b + '即梦批量生成控制台 —— 静态检查（lint）' + C.x);
console.log(C.d + '  范围：' + JS_FILES.length + ' 个 .js（app / server / desktop / scripts / test / build.js）' + C.x);

// ════════════════════════════════════════════════════════════════
// 1. 语法检查（等价 node --check，一次进程跑完）
// ════════════════════════════════════════════════════════════════
head('[1] 语法');

const syntaxErrors = [];
for (const f of JS_FILES) {
  const src = read(f);
  if (src === null) continue;
  /* shebang 行不是合法 JS，node 加载时会剥掉它，这里同样剥掉 */
  const code = src.replace(/^#![^\n]*/, '');
  try {
    new vm.Script(code, { filename: f });
  } catch (e) {
    syntaxErrors.push(rel(f) + '：' + e.message);
  }
}
if (syntaxErrors.length) {
  fail('语法错误 ' + syntaxErrors.length + ' 处：' + syntaxErrors.join('；'),
    'node --check <文件> 可复现');
} else {
  ok(JS_FILES.length + ' 个文件语法均通过');
}

// ════════════════════════════════════════════════════════════════
// 2. debugger 语句
// ════════════════════════════════════════════════════════════════
head('[2] debugger 语句');

const debuggerHits = [];
for (const f of JS_FILES) {
  const src = read(f);
  if (src === null) continue;
  src.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (/(^|[^\w.$])debugger(\s*;|\s*$|\s*[)\]}])/.test(line)) debuggerHits.push(rel(f) + ':' + (i + 1));
  });
}
if (debuggerHits.length) {
  fail('残留 debugger：' + debuggerHits.join('、'), '提交前删除（会中断调试器/断点）');
} else {
  ok('无 debugger 残留');
}

// ════════════════════════════════════════════════════════════════
// 3. app/ 下的调试输出
// ════════════════════════════════════════════════════════════════
head('[3] 前端调试输出（app/）');

const frontFiles = JS_FILES.filter((f) => rel(f).startsWith('app/'));
const frontLogs = [];
for (const f of frontFiles) {
  const src = read(f);
  if (src === null) continue;
  src.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (/console\.(log|debug|info)\s*\(/.test(line)) frontLogs.push(rel(f) + ':' + (i + 1));
  });
}
if (frontLogs.length) {
  fail('app/ 下残留调试输出：' + frontLogs.join('、'),
    '前端不该往用户控制台留调试输出；确需保留请加说明并把它从本规则里显式豁免');
} else {
  ok('app/ 无 console.log / debug / info');
}

// ════════════════════════════════════════════════════════════════
// 4. 相对 require 的目标存在（复制粘贴残留 / 改名漏改）
// ════════════════════════════════════════════════════════════════
head('[4] 相对 require 目标');

const requireMisses = [];
const REQ_RE = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
for (const f of JS_FILES) {
  const src = read(f);
  if (src === null) continue;
  let m;
  REQ_RE.lastIndex = 0;
  while ((m = REQ_RE.exec(src))) {
    const target = path.resolve(path.dirname(f), m[1]);
    /* Node 的解析顺序里够用的四种：原样 / +.js / +.json / +/index.js */
    const cands = [target, target + '.js', target + '.json', path.join(target, 'index.js')];
    if (!cands.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
      requireMisses.push(rel(f) + " → require('" + m[1] + "')");
    }
  }
}
if (requireMisses.length) {
  fail('相对 require 指向不存在的文件：' + requireMisses.join('、'),
    '多半是改名/搬文件时漏改；确认后修掉或删除死代码');
} else {
  ok('全部相对 require 目标存在');
}

// ════════════════════════════════════════════════════════════════
// 5. innerHTML 行上的模板插值（告警，不阻断）
// ════════════════════════════════════════════════════════════════
head('[5] innerHTML 模板插值（告警）');

const SAFE_EXPR = /\besc\(|\bescAttr\(|\bescUrl\(|encodeURIComponent\(|\bNumber\(|\bMath\.|\.length\b|JSON\.stringify\(/;
const interpHits = [];
for (const f of JS_FILES) {
  const src = read(f);
  if (src === null) continue;
  src.split('\n').forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (!/innerHTML/.test(line)) return;
    const re = /\$\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(line))) {
      if (!SAFE_EXPR.test(m[1])) interpHits.push(rel(f) + ':' + (i + 1) + ' `${' + m[1].trim() + '}`');
    }
  });
}
if (interpHits.length) {
  warn('innerHTML 行上 ' + interpHits.length + ' 处模板插值未包安全函数：' + interpHits.join('、'),
    '若数据来自用户/素材名，请用 esc() 包住；确属安全请在此清单里显式豁免');
} else {
  ok('innerHTML 行上无未转义的模板插值');
}

// ════════════════════════════════════════════════════════════════
// 6. TODO / FIXME 计数（告警）
// ════════════════════════════════════════════════════════════════
head('[6] TODO / FIXME');

/* ⚠ 正则用字符串拼接构造、且**跳过本文件**：本脚本为了描述规则必然要写出
   这两个词，否则会自己命中自己（自指陷阱）。 */
const TODO_RE = new RegExp('\\bTO' + 'DO\\b|\\bFIX' + 'ME\\b');
const todoHits = [];
for (const f of JS_FILES) {
  if (rel(f) === 'scripts/lint.js') continue;
  const src = read(f);
  if (src === null) continue;
  src.split('\n').forEach((line, i) => {
    if (TODO_RE.test(line)) todoHits.push(rel(f) + ':' + (i + 1));
  });
}
if (todoHits.length) {
  warn('TODO/FIXME ' + todoHits.length + ' 处：' + todoHits.join('、'),
    '本仓库惯例是"写清为什么"而不是留待办；建议逐条转成注释说明或立即处理');
} else {
  ok('无 TODO / FIXME');
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
