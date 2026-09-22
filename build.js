#!/usr/bin/env node
/**
 * 构建发布版：把 app/ 下的外部脚本/样式引用内联成 dist/ 里的单文件应用。
 *
 *   cd DreamFlow
 *   node build.js
 *
 * 四个必须遵守的约束（都是踩过坑的）：
 *
 * 1. 必须用「回调函数」形式的 String.replace。
 *    字符串形式的替换会把代码里的 `$$` / `$'` / `$&` 当成替换占位符吞掉，
 *    产物静默损坏，运行时表现为 `Identifier '$' has already been declared`。
 *
 * 2. 内联前必须检查脚本里有没有字面量 `</script`。
 *    哪怕出现在注释里，浏览器也会在那里提前结束脚本块，后面的代码全部丢失。
 *
 * 3. 应用内图标（app/icon.png）必须内联成 data URI。
 *    单文件版是 file:// 打开的，旁边没有 icon.png —— 不内联就是 favicon 与顶栏品牌标两个裂图。
 *
 * 4. **支持 N 个脚本 / 样式**（2026-09-22 阶段 2.4）。
 *    之前硬编码 `api.js + app.js` 两个，阶段 2.5–2.6 拆分前端 / 后端后会出现更多脚本。
 *    现在按 `app/index.html` 里**实际出现**的 `<script src="...">` 与 `<link rel="stylesheet" href="...">`
 *    顺序逐个内联 —— 加文件只改 HTML，build.js 不需要跟着改。
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

/* 把 src 引用的脚本 + link 引用的样式表**按出现顺序**摘出来。
   这里只看"自己写的相对路径"，看到 http(s):// 或 // 之类就跳过 —— 留给浏览器照原样加载。 */
function collectExternal(html) {
  const scripts = [];
  const styles = [];
  for (const m of html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)) {
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(m[1])) continue;
    scripts.push(m[1]);
  }
  for (const m of html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g)) {
    if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(m[1])) continue;
    styles.push(m[1]);
  }
  return { scripts, styles };
}

function main() {
  const html = read('index.html');
  const { scripts, styles } = collectExternal(html);

  /* 应用内图标（favicon + 顶栏品牌标）在单文件版里必须内联成 data URI，
     否则 file:// 打开时找不到 icon.png（2026-09-21 换新图标时补）。 */
  const iconFile = path.join(APP, 'icon.png');
  if (!fs.existsSync(iconFile)) {
    console.error('✗ 缺少应用内图标：app/icon.png（跑 npm run icons 生成）');
    process.exit(1);
  }
  const iconUri = 'data:image/png;base64,' + fs.readFileSync(iconFile).toString('base64');

  // ── 前置校验 1：字面量结束标签 ──────────────────────────────
  for (const src of scripts) {
    const code = read(src);
    if (/<\/script/i.test(code)) {
      console.error('✗ ' + src + ' 中含有字面量 «</scr' + 'ipt»，内联后会截断脚本。');
      console.error('  请把它拆开写成 «</scr» + «ipt»» 或改写注释。');
      process.exit(1);
    }
  }

  // ── 内联（回调函数形式，见文件头「约束 1」）──────────────────
  let out = html;

  /* 样式表：逐个替换为内联 <style> 块。
     ⚠ 不一次性把所有 <link> 替换掉 —— 顺序可能影响 CSS 优先级（后面的覆盖前面的），
     也避免误伤带 media / integrity 属性的链接（这里只挑最普通的样式表）。 */
  for (const href of styles) {
    const css = read(href);
    const anchor = '<link rel="stylesheet" href="' + href + '" />';
    if (!out.includes(anchor)) {
      console.error('✗ app/index.html 里找不到样式锚点：' + anchor);
      process.exit(1);
    }
    out = out.replace(anchor, function () { return '<style>\n' + css + '\n</style>'; });
  }

  /* 脚本：逐个替换为内联 <script> 块。 */
  for (const src of scripts) {
    const code = read(src);
    const anchor = '<script src="' + src + '"></script>';
    if (!out.includes(anchor)) {
      console.error('✗ app/index.html 里找不到脚本锚点：' + anchor);
      process.exit(1);
    }
    out = out.replace(anchor, function () { return '<script>\n' + code + '\n</script>'; });
  }

  /* 图标引用：同时支持 favicon + 顶栏品牌标两个写法 */
  out = out.replace(/(href|src)="icon\.png"/g, function (m, attr) { return attr + '="' + iconUri + '"'; });

  // ── 后置校验：确认代码没被改写 ──────────────────────────────
  const errors = [];
  const countIn = (s, re) => (s.match(re) || []).length;

  /* $$ 校验：所有内联进来的脚本里的 $$ 必须保留。
     ⚠ 这里**累加**所有脚本里的 $$ 数，与产物的 $$ 数比对；单个脚本错漏一个就会爆。 */
  let expectedDoubleDollar = 0;
  for (const src of scripts) expectedDoubleDollar += countIn(read(src), /\$\$/g);
  if (countIn(out, /\$\$/g) !== expectedDoubleDollar) {
    errors.push('`$$` 数量不一致 —— 替换吞噬了字面量，产物已损坏');
  }

  /* <script> 块数 = HTML 里已有的内联脚本 + 内联进来的 N 个 */
  const inlineScripts = countIn(html, /<script>/g);
  if (countIn(out, /<script>/g) !== inlineScripts + scripts.length) {
    errors.push('<script> 块应为 ' + (inlineScripts + scripts.length) + ' 个（内联 ' + inlineScripts + ' + ' + scripts.length + ' 个脚本），实际 ' + countIn(out, /<script>/g) + ' 个');
  }
  /* <style> 块数 = HTML 里已有的内联样式 + 内联进来的 N 个 */
  const inlineStyles = countIn(html, /<style>/g);
  if (countIn(out, /<style>/g) !== inlineStyles + styles.length) {
    errors.push('<style> 块应为 ' + (inlineStyles + styles.length) + ' 个（内联 ' + inlineStyles + ' + ' + styles.length + ' 个样式表），实际 ' + countIn(out, /<style>/g) + ' 个');
  }

  /* 不能留下外部引用（脚本、样式、图标） */
  for (const src of scripts) {
    if (out.includes('src="' + src + '"') || out.includes("src='" + src + "'")) {
      errors.push('仍存在未内联的脚本引用：' + src);
    }
  }
  for (const href of styles) {
    if (out.includes('href="' + href + '"') || out.includes("href='" + href + "'")) {
      errors.push('仍存在未内联的样式引用：' + href);
    }
  }
  if (out.includes('="icon.png"')) {
    errors.push('应用内图标未内联（app/icon.png 的引用仍在）');
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
  const srcList = ['index.html', ...styles, ...scripts].map((f) => f + ' ' + kb(read(f).length)).join(' + ');
  console.log('✓ 构建完成');
  console.log('  源   app/     ' + srcList);
  console.log('  产物 ' + path.relative(ROOT, outPath).replace(/\\/g, '/') + '   ' + kb(out.length));
  console.log('  图标 app/icon.png 内联为 data URI  ' + kb(iconUri.length));
  console.log('  校验 $$ 保留 / script 块 ' + (inlineScripts + scripts.length) + ' / style 块 ' + (inlineStyles + styles.length) + ' / 图标已内联 / 无外部引用 → 全部通过');
}

main();