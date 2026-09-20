#!/usr/bin/env node
/**
 * 构建发布版：把 app/ 下的四个文件内联成 dist/ 里的单文件应用。
 *
 *   cd jimeng-console
 *   node build.js
 *
 * 两个必须遵守的约束（都是踩过坑的）：
 *
 * 1. 必须用「回调函数」形式的 String.replace。
 *    字符串形式的替换会把代码里的 `$$` / `$'` / `$&` 当成替换占位符吞掉，
 *    产物静默损坏，运行时表现为 `Identifier '$' has already been declared`。
 *
 * 2. 内联前必须检查脚本里有没有字面量 `</script`。
 *    哪怕出现在注释里，浏览器也会在那里提前结束脚本块，后面的代码全部丢失。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const APP = path.join(ROOT, 'app');
const DIST = path.join(ROOT, 'dist');
const OUT_NAME = '即梦批量生成控制台.html';

function read(rel) {
  const p = path.join(APP, rel);
  if (!fs.existsSync(p)) {
    console.error('✗ 缺少源文件：' + path.relative(ROOT, p));
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

function main() {
  const html = read('index.html');
  const css = read('styles.css');
  const api = read('api.js');
  const app = read('app.js');

  // ── 前置校验 1：字面量结束标签 ──────────────────────────────
  for (const [name, code] of [['api.js', api], ['app.js', app]]) {
    if (/<\/script/i.test(code)) {
      console.error('✗ ' + name + ' 中含有字面量 «</scr' + 'ipt»，内联后会截断脚本。');
      console.error('  请把它拆开写成 «</scr» + «ipt»» 或改写注释。');
      process.exit(1);
    }
  }

  // ── 前置校验 2：占位锚点必须存在 ────────────────────────────
  const CSS_ANCHOR = '<link rel="stylesheet" href="styles.css" />';
  const JS_ANCHOR = '<script src="api.js"></script>\n<script src="app.js"></script>';
  if (!html.includes(CSS_ANCHOR)) {
    console.error('✗ app/index.html 里找不到样式锚点：' + CSS_ANCHOR);
    process.exit(1);
  }
  if (!html.includes(JS_ANCHOR)) {
    console.error('✗ app/index.html 里找不到脚本锚点（两行必须相邻、换行符为 \\n）：');
    console.error('  ' + JS_ANCHOR.replace(/\n/g, '  ⏎  '));
    process.exit(1);
  }

  // ── 内联（回调函数形式，见文件头「约束 1」）──────────────────
  let out = html;
  out = out.replace(CSS_ANCHOR, function () { return '<style>\n' + css + '\n</style>'; });
  out = out.replace(JS_ANCHOR, function () {
    return '<script>\n' + api + '\n</script>\n<script>\n' + app + '\n</script>';
  });

  // ── 后置校验：确认代码没被改写 ──────────────────────────────
  const errors = [];
  const countIn = (s, re) => (s.match(re) || []).length;
  const countOut = (s, re) => (s.match(re) || []).length;

  if (countOut(out, /\$\$/g) !== countIn(api + app, /\$\$/g)) {
    errors.push('`$$` 数量不一致 —— 替换吞噬了字面量，产物已损坏');
  }
  // 裸 <script> 的期望数 = index.html 里**已有的内联脚本**数 + 内联进来的 api/app 两个。
  // （v0.21.0 起 index.html 的 <head> 多了一段「主题防闪」内联脚本，故不能再写死为 2。）
  const inlineScripts = countIn(html, /<script>/g);
  if (countOut(out, /<script>/g) !== inlineScripts + 2) {
    errors.push('<script> 块应为 ' + (inlineScripts + 2) + ' 个（内联 ' + inlineScripts + ' + api + app），实际 ' + countOut(out, /<script>/g) + ' 个');
  }
  if (countOut(out, /<style>/g) !== 1) {
    errors.push('<style> 块应为 1 个，实际 ' + countOut(out, /<style>/g) + ' 个');
  }
  if (out.includes('href="styles.css"') || out.includes('src="api.js"')) {
    errors.push('仍存在未内联的外部引用');
  }

  if (errors.length) {
    console.error('✗ 构建产物校验未通过：');
    errors.forEach((e) => console.error('   · ' + e));
    process.exit(1);
  }

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, OUT_NAME);
  fs.writeFileSync(outPath, out);

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log('✓ 构建完成');
  console.log('  源   app/     index.html ' + kb(html.length) +
              ' + styles.css ' + kb(css.length) +
              ' + api.js ' + kb(api.length) +
              ' + app.js ' + kb(app.length));
  console.log('  产物 ' + path.relative(ROOT, outPath).replace(/\\/g, '/') + '   ' + kb(out.length));
  console.log('  校验 $$ 保留 / script 块 ' + (inlineScripts + 2) + ' / style 块 1 / 无外部引用 → 全部通过');
}

main();
