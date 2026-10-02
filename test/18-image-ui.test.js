'use strict';
/* 生图界面回归：执行真实尺寸控件代码，检查点击后提交值与选中态一致。
   只替换 DOM 最小接口，不访问用户数据、密钥或服务商；视觉布局另用真页面验证。 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registry = require('../server/image-registry');

function ui() {
  const source = fs.readFileSync(path.join(__dirname, '../app/app.js'), 'utf8');
  const providers = registry.listProviders().map((p) => ({
    providerId: p.providerId, label: p.providerLabel, configured: true,
    models: p.models.map((m) => ({ id: m.modelId, label: m.modelLabel }))
  }));
  const context = vm.createContext({
    S: { options: { imageModels: registry.specForFrontend() }, imageProvidersList: providers },
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  });
  vm.runInContext(source.slice(source.indexOf('  function configuredImageModels()'),
    source.indexOf('  /* 渲染「生图区」')), context);
  return context;
}

function node(attrs = {}, value = '') {
  const classes = new Set();
  return { value, hidden: false, textContent: '',
    classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: (c) => classes.has(c) },
    getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: () => {}
  };
}

function control(context, initial) {
  const modes = ['ratio', 'pixels'].map((m) => node({ 'data-iszmode': m }));
  const ratios = ['1:1', '16:9'].map((r) => node({ 'data-iszratio': r }));
  const nodes = { '#ipPrev': node(), '#ipWarn': node(), '#ipW': node(), '#ipH': node(),
    '[data-iszpane="ratio"]': node(), '[data-iszpane="pixels"]': node(),
    '[data-iszratiosel]': node({}, '16:9'), '[data-iszres]': node({}, '1k') };
  const handlers = {};
  const root = {
    dataset: { provider: 'work-fisher', model: registry.defaultModelId() },
    matches: () => true,
    querySelector: (s) => nodes[s] || modes.find((n) => s === '[data-iszmode="' + n.getAttribute('data-iszmode') + '"]'),
    querySelectorAll: (s) => s === '[data-iszmode]' ? modes : ratios,
    addEventListener: (type, fn) => { handlers[type] = fn; }
  };
  [...modes, ...ratios].forEach((n) => {
    n.closest = (s) => n.getAttribute(s.slice(1, -1)) == null ? null : n;
  });
  const ctl = context.wireImageSizeControl(root, 'ip', initial);
  return { ctl, nodes, ratios, click: (attr, value) => {
    const target = [...modes, ...ratios].find((n) => n.getAttribute(attr) === value);
    handlers.click({ target });
  } };
}

test('修改比例后再次切到像素：宽高跟随新比例，提交值与选中态一致', () => {
  const c = control(ui(), { sizeMode: 'ratio', ratio: '16:9', resolution: '1k' });
  c.click('data-iszmode', 'pixels');
  assert.ok(c.ctl.get().width > c.ctl.get().height);
  c.click('data-iszmode', 'ratio');
  c.click('data-iszratio', '1:1');
  c.click('data-iszmode', 'pixels');
  assert.equal(c.ctl.get().width, c.ctl.get().height);
  assert.equal(Number(c.nodes['#ipW'].value), c.ctl.get().width);
  assert.equal(c.ratios[0].getAttribute('aria-pressed'), 'true');
});

test('恢复默认或服务端回落：下拉、高亮和指定像素同步', () => {
  const c = control(ui(), { sizeMode: 'ratio', ratio: '16:9', resolution: '4k' });
  c.ctl.set({ sizeMode: 'pixels', width: 1088, height: 1920 });
  assert.equal(c.ctl.get().width, 1088);
  assert.equal(c.ctl.get().height, 1920);
  c.ctl.set({ sizeMode: 'ratio', ratio: '1:1', resolution: '1k' });
  assert.equal(c.nodes['[data-iszratiosel]'].value, '1:1');
  assert.equal(c.ratios[0].getAttribute('aria-pressed'), 'true');
  assert.equal(c.nodes['[data-iszpane="pixels"]'].hidden, true);
});

test('切到 Stability：不支持的比例/分辨率/像素模式在渲染和提交态中同时回落', () => {
  const context = ui();
  const spec = context.imgSizeSpec('stable-image-core');
  const value = { sizeMode: 'pixels', ratio: '3:4', resolution: '4k', width: 1920, height: 1088 };
  const next = context.imageSizeValue(spec, value);
  assert.equal(next.sizeMode, 'ratio');
  assert.equal(next.ratio, '1:1');
  assert.equal(next.resolution, null);
  const html = context.imageSizeControlHTML('ip', value, 'stability|stable-image-core');
  assert.match(html, /aria-pressed="true" data-iszratio="1:1"/);
  assert.match(html, /value="1:1" selected/);
  assert.doesNotMatch(html, /data-iszmode="pixels"|data-iszres/);
});

test('仅一家单模型服务商配置时，也能看见实际使用的服务商与模型', () => {
  const context = ui();
  context.S.imageProvidersList.forEach((p) => { p.configured = p.providerId === 'openai'; });
  const html = context.imageSizeControlHTML('ip', { ratio: '1:1' });
  assert.match(html, /for="ipModel"/);
  assert.match(html, /OpenAI · GPT Image 2.5 Flare/);
  assert.match(html, /data-provider="openai"/);
});

test('列表在模型名后显示对应档位的参考费用，未知价格不能显示为免费', () => {
  const context = ui();
  const wf = context.S.imageProvidersList.find((p) => p.providerId === 'work-fisher');
  const pricing = require('../server/image-pricing');
  wf.models.forEach((m) => { m.pricing = pricing.forModel(m.id); });
  const html = context.imageSizeControlHTML('ip', { ratio: '1:1', resolution: '2k' }, 'work-fisher|workfisher-image-g-v2.5-lowprice');
  assert.match(html, /Image G v2.5 低价版 · 参考约 ¥0.115\/张/);
  assert.equal(context.imagePriceText(null, '1k'), '参考价未提供');
  assert.equal(context.imagePriceText({ entries: [{ resolution: '1k', amount: 0.1 }] }, '4k'), '暂无对应参考价');
});

test('Seedream 切换后只显示分辨率，上游自动比例不会沿用旧的像素和比例', () => {
  const context = ui();
  const html = context.imageSizeControlHTML('ip', { sizeMode: 'pixels', width: 1920, height: 1088, ratio: '16:9', resolution: '4k' }, 'work-fisher|seedream-v5-flash-t2i');
  assert.match(html, /data-iszres/);
  assert.match(html, /1.5k/);
  assert.doesNotMatch(html, /data-iszmode|data-iszratiosel/);
  const value = context.imageSizeValue(context.imgSizeSpec('seedream-v5-flash-t2i'), { sizeMode: 'pixels', ratio: '16:9', resolution: '4k' });
  assert.equal(value.ratio, 'auto'); assert.equal(value.resolution, '1k'); assert.equal(value.sizeMode, 'ratio');
});

/* ============================================================
   生成图的下载钮与历史作用域（2026-10-02，静态回归）
   ⚠ 只做"产物形状"断言（读源码 + 正则），理由与 test/08 相同：真渲染另由
     smoke:web / e2e 兜底。**刻意不写整段切片匹配** —— 行号或缩进一改就碎，
     钉"关键结构存在"即可（下载钮用 .fs-btn、主预览与历史项都有、历史项有定位）。
   ============================================================ */
describe('生图界面：下载钮（静态回归）', () => {
  const REPO = path.join(__dirname, '..');
  const appJs = fs.readFileSync(path.join(REPO, 'app', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(REPO, 'app', 'styles.css'), 'utf8');
  const icons = fs.readFileSync(path.join(REPO, 'app', 'constants.js'), 'utf8');

  test('下载文件名：素材名 + 时间戳 + 扩展名，Windows 非法字符被替换', () => {
    const context = ui();
    const name = context.imageDownloadName('角色:小明/雪地*?"<>|', '/media/candidates/pj_1/as_9.PNG');
    assert.match(name, /^角色_小明_雪地_+-\d{12}\.png$/, '非法字符要换掉，扩展名取小写，时间戳 12 位');
    assert.ok(!/[\\/:*?"<>|]/.test(name), '结果里不能再有 Windows 非法字符');
    assert.match(context.imageDownloadName('', 'blob:http://127.0.0.1:1/uuid'), /^生成图片-\d{12}\.png$/, '空名回落默认名');
    assert.match(context.imageDownloadName('背影.', 'https://x/y.JPEG'), /^背影-\d{12}\.jpeg$/, '结尾的点要去掉，扩展名跟随原文件');
    /* 同一素材的两张历史图必须得到**不同**文件名（传各自的生成时刻）：否则连着下载几张，
       浏览器只会给出「素材名 (1)(2)」，文件名就认不出是哪张了。
       ⚠ 这条特意写进既有用例而不是新增一条 —— 截图里的静态用例计数按 test( 字面量统计。 */
    assert.notEqual(
      context.imageDownloadName('素材', '/media/candidates/pj_1/a.png', '2026-10-02T22:41:00.000Z'),
      context.imageDownloadName('素材', '/media/candidates/pj_1/b.png', '2026-10-02T22:42:00.000Z'),
      '不同生成时刻要给出不同文件名');
    assert.match(context.imageDownloadName('素材', '/media/candidates/pj_1/a.png', '不是时间'),
      /^素材-\d{12}\.png$/, '时刻不合法时回落当前时间');
  });

  test('主预览与历史项都有下载钮，且与全屏钮共用 .fs-btn 外观（CSS 只有一份）', () => {
    assert.match(icons, /download:\s*'<svg/, '图标集里要有 download 图标');
    /* 主预览（素材详情）：<a class="fs-btn dl-btn" id="asDownload" download=...> */
    assert.match(appJs, /class="fs-btn dl-btn" id="asDownload"[^>]*download=/, '主预览要有下载钮');
    /* 历史项：<a class="fs-btn" ... download=...>，且是 <img data-ipzoom> 的兄弟（不包裹 img） */
    assert.match(appJs, /class="fs-btn" href="' \+ esc\(url\) \+ '" download=/);
    assert.match(appJs, /data-ipzoom="' \+ esc\(url\) \+ '" \/>' \+/, '点历史图仍走全屏（下载钮不是它的包裹层）');
    /* 外观只有一份：基类 .fs-btn，容器各自只负责定位 */
    assert.match(css, /^\.fs-btn\{/m);
    assert.match(css, /^\.fs-btn\[hidden\]\{display:none\}/m, 'hidden 规则优先级不能降，否则 display:grid 会盖掉它');
    assert.match(css, /^\.fs-btn:hover\{background:var\(--scrim-3\)\}/m);
    assert.match(css, /^\.asset-preview \.fs-btn\{top:10px;right:10px\}/m, '全屏钮位置不得移动');
    assert.match(css, /^\.asset-preview \.fs-btn\.dl-btn\{right:48px\}/m, '下载钮贴在它左边');
    assert.match(css, /^\.img-history-item\{[^}]*position:relative/m, '历史项要有定位（否则钮跑到弹窗外）');
    assert.match(css, /^\.img-history-item:hover \.fs-btn\{opacity:1;pointer-events:auto\}/m);
  });
});
