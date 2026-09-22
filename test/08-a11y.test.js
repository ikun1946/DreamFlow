'use strict';
/* ============================================================
   08-a11y.test.js —— 基础可访问性（阶段 3 / P2-3）

   这一组在浏览器内跑不了（aria 属性得真渲染才生效），
   所以它的"测试"是**断言产物形状**：把 app/index.html 的关键节点逐个点名，
   确认 role / aria-modal / aria-labelledby / aria-label 都齐全。

   ⚠ 数据隔离：读 app/index.html 与 app/app.js（JS 不会跑，
     只是读 + 正则）。
   ⚠ 不动 dist 产物（那是 build.js 的活，与本测试无关）。
   ============================================================ */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(REPO, 'app', 'index.html'), 'utf8');

describe('a11y —— 弹层关系与可关闭按钮 (P3)', () => {
  /* ⚠ 这里读的是 index.html 的源文件（不是 build 出来的单文件）。
     我们只对源做静态断言：测试在 mock 一个"正确搭建出来的产品"应有的产物形状。
     build.js 是否把这一切 inline 进去是 build.js 的活（已有 build.js 自身的校验）。 */

  function blockOf(id) {
    const re = new RegExp('<div class="mask" id="' + id + '"[\\s\\S]*?<\\/div>\\s*(?=<!--\\s*==========|<div class="mask")', 'm');
    const m = indexHtml.match(re);
    if (m) return m[0];
    /* 兜底：从 id 到 </div> 配对计数式取出 —— 处理遮罩里嵌套 .modal 等多 div 的情况 */
    const startIdx = indexHtml.indexOf('<div class="mask" id="' + id + '"');
    if (startIdx < 0) return null;
    let depth = 0, i = startIdx;
    while (i < indexHtml.length) {
      const open = indexHtml.indexOf('<div', i);
      const close = indexHtml.indexOf('</div>', i);
      if (open >= 0 && open < close) { depth++; i = open + 4; }
      else if (close >= 0) {
        depth--;
        if (depth === 0) return indexHtml.slice(startIdx, close + 6);
        i = close + 6;
      } else return null;
    }
    return null;
  }

  function drawerBlock() {
    const startIdx = indexHtml.indexOf('<aside class="drawer" id="settingsDrawer"');
    if (startIdx < 0) return null;
    /* drawer 用 </aside> 闭合，不是 </div> */
    const endIdx = indexHtml.indexOf('</aside>', startIdx);
    if (endIdx < 0) return null;
    return indexHtml.slice(startIdx, endIdx + '</aside>'.length);
  }

  test('importMask 内部是 role=dialog + aria-modal + aria-labelledby', () => {
    const block = blockOf('importMask');
    assert.ok(block, '应能定位 importMask 区块');
    assert.match(block, /role="dialog"/, 'importMask 内的 modal 应有 role=dialog');
    assert.match(block, /aria-modal="true"/);
    assert.match(block, /aria-labelledby="importTitle"/);
  });

  test('importMask 关闭按钮有 aria-label（屏幕阅读器能读出"关闭"而非"x"）', () => {
    const block = blockOf('importMask');
    assert.ok(block);
    assert.match(block, /id="importClose"[^>]*aria-label="关闭导入弹层"/);
  });

  test('detailMask 同样有 role + aria-modal + aria-label', () => {
    const block = blockOf('detailMask');
    assert.ok(block, '应能定位 detailMask 区块');
    assert.match(block, /role="dialog"/);
    assert.match(block, /aria-modal="true"/);
    assert.match(block, /aria-labelledby="detailTitle"/);
    assert.match(block, /aria-label="关闭详情弹层"/);
  });

  test('★ settingsDrawer 是 role=dialog + aria-modal + aria-labelledby', () => {
    const block = drawerBlock();
    assert.ok(block);
    assert.match(block, /role="dialog"/);
    assert.match(block, /aria-modal="true"/);
    assert.match(block, /aria-labelledby="settingsTitle"/);
    assert.match(block, /aria-label="关闭设置"/);
  });

  test('★ body 顶层有 role=status + aria-live=polite 的播报区（screen reader 用）', () => {
    const m = indexHtml.match(/<div id="srLive"[^>]*>/);
    assert.ok(m, 'srLive 区域必须存在');
    assert.match(m[0], /role="status"/);
    assert.match(m[0], /aria-live="polite"/);
    assert.ok(!m[0].includes('hidden'), 'srLive 必须常驻可见（visibility:hidden 也会让读屏听不到）');
  });
});

describe('a11y —— 键盘可达性（P3-2）', () => {
  const appJs = fs.readFileSync(path.join(REPO, 'app', 'app.js'), 'utf8');

  test('★ document 上挂了 keydown 处理：Escape 关闭最上层弹层', () => {
    /* 这是单点：所有可关闭层都在这里集中判断。抽到这一处的理由：
       · 一处管所有（避免每个 mask 各绑一份的重复代码 + 维护散落）；
       · 不会与 mask 上的 keydown 冲突（mask 在弹层里，再次冒泡有可能）；
       · future-proof：新增弹层只要在这里加一条。 */
    const m = appJs.match(/document\.addEventListener\('keydown',[\s\S]*?\}\);/);
    assert.ok(m, '应能找到 keydown 处理函数');
    assert.match(m[0], /e\.key\s*!==\s*'Escape'/, '应先判断 Escape 键');
    assert.match(m[0], /closeDetail\(\)/);
    assert.match(m[0], /closeImport\(\)/);
    assert.match(m[0], /closeSettings\(\)/, 'settings 抽屉的关闭钩子叫 closeSettings 别错叫');
  });

  test('toast() 同时写屏幕阅读器播报区（kind: err 加 "错误：" 前缀）', () => {
    /* 视觉 toast 有淡出，但读屏区域必须保留整段文本 —— 不能让"提交失败"说完就消失。
       实测：NVDA 会把整个 textContent 念出来。 */
    const m = appJs.match(/function toast\(msg, kind\)\s*\{[\s\S]*?const fail/);
    assert.match(m[0], /document\.getElementById\('srLive'\)/, 'toast 必须写到 srLive');
    assert.match(m[0], /live\.textContent\s*=/, '用 textContent 设置，避免 innerHTML 漏转义');
    assert.match(m[0], /kind\s*===\s*'err'\s*\?\s*'错误：'/, 'err 应有 "错误：" 前缀');
    /* ⚠ 重置 textContent 后再写入，强制 ARIA 把它当"新消息"播报（连同样内容也会读） */
    assert.match(m[0], /live\.textContent\s*=\s*''/, '先清空再写入，强制重新播报');
  });
});