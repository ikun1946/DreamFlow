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

// ════════════════════════════════════════════════════════════════
// 7. 调用了但没定义的本模块函数（no-undef 的最小可用版）
// ════════════════════════════════════════════════════════════════
head('[7] 未定义的模块内调用');

/* 为什么需要这一项（2026-09-22 实测踩到）：
   desktop/main.js 里的 updateSource / setUpdateSource / publicSource **三个函数的定义
   被误删**（163e62d），而所有调用点都留着 —— 整个应用内更新链路一调用就抛
   `ReferenceError: xxx is not defined`，渲染进程的 .catch(() => null) 又把它吞掉，
   界面表现为"更新卡片永远空白"，静默失效了几个版本都没人发现。
   教训：**功能没被任何测试调用时，删掉实现也没人知道**。

   这条检查就是那个"没被调用的功能"的兜底：扫"本文件里被调用、但本文件里没定义、
   也不是 JS/Node 内置"的标识符。刻意只扫 server / desktop / build.js ——
   app/ 是 IIFE + window 全局（跨文件注入），test/ 大量用 stub，都不适合这条规则。

   ⚠ 已知边界：这是**最小可用版**，不是完整作用域分析 ——
     它会先把注释与字符串剥掉，再把"像声明的位置"（function / const / let / var /
     解构 / 参数表 / catch / 对象键）里出现的标识符都当成"已定义"。
     因此它抓不住"定义在 if 分支里但分支没走到"这类；但能抓住"定义被整段删掉"。 */
const NO_UNDEF_FILES = JS_FILES.filter((f) => {
  const r = rel(f);
  return r.startsWith('server/') || r.startsWith('desktop/') || r === 'build.js';
});

/* 剥掉注释、字符串字面量与正则字面量（保留换行，便于报行号）。
   ⚠ 正则字面量的判定用"上一个有意义的字符"启发式：只有出现在
   `( , = : [ ! & | ? { } ; return` 之后（或行首）的 `/` 才算正则开始 ——
   否则 `a / b` 这种除法的 `/` 会被误判。实测：不处理正则会把
   `matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)` 里的 stylesheet 当标识符。 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevMeaningful = '';
  const regexAllowed = () => prevMeaningful === '' || '(,=:[!&|?{};'.includes(prevMeaningful) || prevMeaningful === '\n';
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += (src[i] === '\n' ? '\n' : ' '); i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === quote) { out += ' '; i++; break; }
        out += (src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      prevMeaningful = quote;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      /* 正则字面量：扫到未转义的 / 为止（不跨行） */
      let j = i + 1, closed = false, inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        for (let k = i; k <= j; k++) out += (src[k] === '\n' ? '\n' : ' ');
        i = j + 1;
        /* 正则后面的 flag 字母（g/i/m/s/u/y）也一并吃掉 */
        while (i < n && /[gimsuyd]/.test(src[i])) { out += ' '; i++; }
        prevMeaningful = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prevMeaningful = c;
    else if (c === '\n') prevMeaningful = '\n';
    i++;
  }
  return out;
}

/* JS 关键字 / 语法构件 —— 它们后面跟 `(` 不是"函数调用" */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'async', 'await', 'typeof', 'new',
  'delete', 'void', 'yield', 'super', 'constructor', 'this', 'do', 'else', 'try', 'finally', 'throw',
  'class', 'extends', 'instanceof', 'in', 'of', 'case', 'default', 'break', 'continue', 'static',
  'get', 'set', 'let', 'const', 'var', 'import', 'export', 'from', 'as', 'with', 'debugger', 'sequence'
]);

/* JS / Node 内置与全局 —— 出现在调用位置不算"未定义" */
const GLOBALS = new Set([
  'console', 'require', 'module', 'exports', 'process', 'globalThis', 'Buffer', 'URL', 'URLSearchParams',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'fetch', 'AbortController', 'TextEncoder', 'TextDecoder',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'Function', 'eval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'escape', 'unescape', 'atob', 'btoa', '__dirname', '__filename',
  'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array',
  'Uint32Array', 'Uint8ClampedArray', 'ArrayBuffer', 'DataView', 'SharedArrayBuffer', 'Atomics',
  'performance', 'crypto', 'navigator', 'localStorage', 'document', 'window', 'self', 'top', 'parent',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'alert', 'confirm', 'prompt',
  'customElements', 'HTMLElement', 'Event', 'CustomEvent', 'Node', 'Element', 'Image', 'Blob', 'File',
  'FormData', 'Headers', 'Request', 'Response', 'WebSocket', 'Worker', 'matchMedia', 'DOMException',
  /* 测试 / 构建脚本里常用的 Node 侧入口（不 require 也能用，或由调用方注入） */
  'gc', 'it', 'test', 'describe', 'before', 'after', 'beforeEach', 'afterEach'
]);

const undefHits = [];
for (const f of NO_UNDEF_FILES) {
  const raw = read(f);
  if (raw === null) continue;
  const src = stripCommentsAndStrings(raw.replace(/^#![^\n]*/, ''));

  const defined = new Set();
  const addAll = (text) => {
    let m;
    const re = /[A-Za-z_$][\w$]*/g;
    while ((m = re.exec(text))) defined.add(m[0]);
  };
  /* ① function NAME / class NAME */
  let m;
  const fnRe = /(?:^|[^\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = fnRe.exec(src))) defined.add(m[1]);
  const classRe = /(?:^|[^\w$.])class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(src))) defined.add(m[1]);
  /* ② const/let/var NAME = 与解构 { A, B } = / [ A, B ] = */
  const declRe = /(?:^|[^\w$.])(?:const|let|var)\s+([\s\S]{0,400}?)=/g;
  while ((m = declRe.exec(src))) {
    const head = m[1];
    if (/^\s*\{/.test(head) || /^\s*\[/.test(head)) addAll(head);
    else { const nm = /^\s*([A-Za-z_$][\w$]*)/.exec(head); if (nm) defined.add(nm[1]); }
  }
  /* ③ 参数表（function (...) / (...) =>）里的名字 */
  const paramRe = /\(([^()]{0,300})\)\s*(?:=>|\{)/g;
  while ((m = paramRe.exec(src))) addAll(m[1]);
  /* ④ catch (e) */
  const catchRe = /catch\s*\(([^)]*)\)/g;
  while ((m = catchRe.exec(src))) addAll(m[1]);
  /* ⑤ 对象字面量键（`foo: ...`）与解构目标 —— 保守起见都算"见过这个名字" */
  const keyRe = /(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g;
  while ((m = keyRe.exec(src))) defined.add(m[1]);
  /* ⑤b 取值器/设值器（`get DATA_DIR() {...}`）—— 也是"定义了名字"，不是调用 */
  const accRe = /(?:^|[^\w$.])(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = accRe.exec(src))) defined.add(m[1]);
  /* ⑤c 对象字面量里的**方法简写**：`{ request(url, opts, cb) {...} }`。
     它既不是 `function NAME` 也不是 `NAME:`，不加这条会被误报成"调用了未定义的
     request()"（2026-09-25 在 server/image-provider.js 的 defaultTransport 上真实踩到）。
     ⚠ 只认"行首（含缩进）到名字再到 ( 且行尾是 {" 的形状"，避免把普通调用也算进来。 */
  const methodRe = /(?:^|[{,;\n])\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g;
  while ((m = methodRe.exec(src))) defined.add(m[1]);
  /* ⑥ import/require 的别名已由 ② 覆盖；再兜一层：形如 NAME.sub / NAME = require */
  const assignRe = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  while ((m = assignRe.exec(src))) defined.add(m[1]);

  /* 调用点：前面不是 . / 标识符字符 / 引号（避免把 obj.foo( 与字符串算进来） */
  const callRe = /(?<![.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = callRe.exec(src))) {
    const name = m[1];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || defined.has(name)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    undefHits.push(rel(f) + ':' + line + ' ' + name + '()');
  }
}

if (undefHits.length) {
  fail('调用了但本文件没定义的函数：' + undefHits.join('、'),
    '多半是删实现时漏删调用点（desktop/main.js 的更新源三函数就是这样静默失效的）；'
    + '确认后补回定义或删掉调用');
} else {
  ok(NO_UNDEF_FILES.length + ' 个文件无"调用但未定义"的模块内函数');
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
