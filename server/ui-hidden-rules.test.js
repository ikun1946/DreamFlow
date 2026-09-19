'use strict';
/* ============================================================
   ui-hidden-rules.test.js —— 静态检查：能 `hidden` 的容器是否真有隐藏规则
   运行：node --test server/ui-hidden-rules.test.js

   为什么要有这个检查（同一类缺陷在本项目已出现 **4 次**）：
   CSS 里凡是给元素显式设了 `display`（flex / grid / block…）的选择器，
   都会**盖掉浏览器默认的 `[hidden]{display:none}`** ——
   于是 JS 里写的 `el.hidden = true` 静默失效，元素照样占位、照样可见。
   已踩过的四处：
     · `.asset-preview .fs-btn`（早有 `[hidden]` 规则，说明这个坑很早就遇到过）
     · `.recview`（记录页：靠 `[hidden]` 切换，补了规则才生效）
     · `.drawer`（设置抽屉：2026-09-19 卸载后就地面板时从右侧滑出来盖住整页）
     · `.pv-mount`（项目主页的就地面板槽位：空着也占 273px，把内容区挤小）
   人眼与"跑一遍看看"都很难发现最后一种 —— 界面看起来"没什么不对"，
   只是布局悄悄错了。所以这里做一次机械核对：**凡是 index.html 里带 `hidden`
   属性的元素，只要它的选择器设了 display，就必须有一条 `[hidden]` 规则。**

   ⚠ 放在 server/ 下是为了跟既有的测试一起被 `node --test server/*.test.js` 覆盖
   （README 只写了这一条命令，不额外维护第二套测试入口）。
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'app', 'styles.css'), 'utf8');

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 选择器 X 的规则块里是否显式设了 display */
function setsDisplay(sel) {
  const re = new RegExp('(^|[,\\s])' + escRe(sel) + '\\s*(,[^{]*)?\\{[^}]*\\}', 'm');
  const m = css.match(re);
  return !!m && /display\s*:/.test(m[0]);
}
/* 是否存在 X[hidden] 规则 */
function hasHiddenRule(sel) {
  return new RegExp(escRe(sel) + '\\[hidden\\]').test(css);
}

/* 从 index.html 里挑出所有带 hidden 属性的元素，取它们的 id 与 class */
function hideableSelectors() {
  const out = [];
  const tagRe = /<([a-zA-Z][\w-]*)([^>]*\shidden(?:\s|=|>)[^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[2];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    const cls = (attrs.match(/\bclass="([^"]+)"/) || [])[1];
    const sels = [];
    if (id) sels.push('#' + id);
    if (cls) cls.trim().split(/\s+/).forEach((c) => sels.push('.' + c));
    if (sels.length) out.push({ tag: m[1], id: id || null, classes: cls ? cls.trim().split(/\s+/) : [], sels });
  }
  return out;
}

test('凡是带 hidden 属性的元素，其选择器设了 display 就必须有配套的 [hidden] 规则', () => {
  const items = hideableSelectors();
  assert.ok(items.length > 0, '没在 index.html 里找到任何带 hidden 的元素 —— 解析逻辑可能失效了');

  const bad = [];
  for (const it of items) {
    // 只要**任一**选择器设了 display，就需要有对应的 [hidden] 规则兜住
    const needsRule = it.sels.filter(setsDisplay);
    if (!needsRule.length) continue;
    const covered = needsRule.some(hasHiddenRule);
    if (!covered) bad.push((it.id ? '#' + it.id : '') + (it.classes.length ? ' .' + it.classes.join('.') : '') + '（设了 display 的选择器：' + needsRule.join(', ') + '）');
  }
  assert.deepEqual(bad, [],
    '以下元素会 `hidden` 但缺 [hidden] 规则，JS 里设 hidden=true 会静默失效：\n  ' + bad.join('\n  '));
});

test('已知的四处历史坑都还在（防止有人"顺手清理"掉这些看起来多余的规则）', () => {
  const must = [
    ['.mask[hidden]', '弹层遮罩'],
    ['.recview[hidden]', '记录页全屏视图'],
    ['.pageview[hidden]', '首页 / 项目主页'],
    ['.drawer[hidden]', '设置抽屉（曾因此从右侧滑出盖住整页）'],
    ['.pv-mount[hidden]', '项目主页的就地面板槽位（曾因此吃掉 273px 高度）'],
  ];
  const missing = must.filter(([sel]) => !css.includes(sel)).map(([sel, why]) => sel + '（' + why + '）');
  assert.deepEqual(missing, [], '缺少必要的隐藏规则：\n  ' + missing.join('\n  '));
});
