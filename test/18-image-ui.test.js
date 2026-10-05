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
    source.indexOf('  /* 把生图区接到弹窗上')), context);
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
   新建素材弹窗里的生图行（0.48.0，静态 + 行为混合）
   ⚠ 只做"形状 + 关键守卫"断言（读源码 + 正则 + 直接跑尺寸控件），理由与上面同一取舍：
     真渲染另由 smoke:web / 人工兜底。这里盯的是**改一次就静默坏掉**的那几处：
     参数行的 id 前缀（na）、按钮 id、按需创建的两条路径（只读不建 / 提交才建）。
   ============================================================ */
describe('新建素材弹窗：生成图片行', () => {
  const REPO = path.join(__dirname, '..');
  const appJs = fs.readFileSync(path.join(REPO, 'app', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(REPO, 'app', 'styles.css'), 'utf8');

  test('尺寸行（前缀 na）也带服务商 / 模型选择器，设置页（isz）不带', () => {
    const context = ui();
    const na = context.imageSizeControlHTML('na', { sizeMode: 'ratio', ratio: '1:1', resolution: '1k' });
    assert.match(na, /id="naModel"/, '新建弹窗的尺寸行要能选模型');
    assert.match(na, /data-iszprovidersel/, '复用同一套模型下拉');
    assert.match(na, /data-iszratio="1:1"/, '比例按钮同源');
    const isz = context.imageSizeControlHTML('isz', { sizeMode: 'ratio', ratio: '1:1', resolution: '1k' });
    assert.doesNotMatch(isz, /data-iszprovidersel/,
      '设置页管的是默认尺寸，模型在它上面那张卡里选 —— 这里再放一个就是两处真相');
  });

  test('bare 形态：仍出进度与历史，但**不再画第二份尺寸块**', () => {
    /* 这条必须跑真函数（不是只看调用方传了 bare）——
       只断言"调用处写了 bare:true"抓不到"实现里没认这个开关"：
       面板照样画一份自己的尺寸块，与新建弹窗那行参数各持一套选中值，
       用户改了上面那份、提交却用下面那份。 */
    const context = ui();
    const full = context.imagePanelHTML({}, {});
    const bare = context.imagePanelHTML({}, { bare: true });
    assert.match(full, /id="ipSizeHost"/, '默认形态（素材详情）仍要带尺寸块');
    assert.match(full, /尺寸/);
    assert.doesNotMatch(bare, /ipSizeHost/, 'bare 不得出现尺寸宿主');
    assert.doesNotMatch(bare, /图片生成/, 'bare 也不重复标题（标题由调用方画在参数行上方）');
    assert.match(bare, /id="ipBox"/, 'bare 仍要出进度条容器');
    assert.match(bare, /id="ipCmp"/, 'bare 仍要出对比区');
    assert.match(bare, /id="ipHistoryList"/, 'bare 仍要出历史图片');
  });

  test('参数行在左、生成按钮在右，并复用生图面板（bare）出进度与历史', () => {
    assert.match(appJs, /'<div class="na-gen">'/);
    assert.match(appJs, /'<div class="na-gen-params" id="naSizeHost">'/);
    assert.match(appJs, /imageSizeControlHTML\('na', S\.settings && S\.settings\.imageDefaults\)/);
    assert.match(appJs, /class="btn-outline" id="naGen"[^>]*>'\s*\+\s*\n?\s*I\.spark \+ ' 生成图片/);
    assert.match(appJs, /imagePanelHTML\(\{\}, \{ bare: true \}\)/, '面板只出状态/对比/历史，不再画第二份尺寸块');
    assert.match(appJs, /sizeIdp: 'na'/);
    assert.match(appJs, /genButtonId: 'naGen'/);
    /* CSS：一行两列，按钮不被压缩 */
    assert.match(css, /^\.na-gen\{display:flex;align-items:center;gap:12px/m);
    assert.match(css, /^\.na-gen-params\{flex:1 1 auto;min-width:0\}$/m);
    assert.match(css, /^\.na-gen > button\{flex:none/m);
    /* 提示词为空时先在弹窗里拦下，不做付费调用 */
    assert.match(appJs, /hint\('提示词不能为空 —— 生成图片用的就是上面的「文生图提示词」', 'err'\)/);
  });

  test('素材按需创建：只读路径不建、提交时才建、建完再点不会多出第二条', () => {
    /* ① 只读路径（历史 / 当前任务）拿到 null 必须直接跳过 ——
       否则"打开弹窗看一眼"就会凭空多出一条素材 */
    assert.match(appJs, /const aid = await idOf\(\);\s*\n\s*if \(disposed\) return;\s*\n\s*if \(!aid\) \{ historyJobs = \[\]/,
      '历史读取：还没资产就不读、不建');
    assert.match(appJs, /if \(!aid\) \{ job = null; render\(\); return; \}/,
      '当前任务读取：还没资产就不读、不建');
    /* ② 提交路径才建（ensureId 只在 submitImageJob 处出现一次） */
    assert.match(appJs, /const r = await Api\.submitImageJob\(await ensureId\(\), prompt, sz, providerId, modelId\)/);
    assert.match(appJs, /const ensureId = typeof o\.ensureAssetId === 'function' \? o\.ensureAssetId : idOf;/);
    /* ③ 幂等：已有 createdAsset / 正在创建，都不再建第二条 */
    assert.match(appJs, /async function ensureCreated\(\) \{\s*\n\s*if \(createdAsset\) return createdAsset\.id;\s*\n\s*if \(creatingAsset\) return creatingAsset;/,
      '重复点击 / 并发提交不得建出两条同名素材');
    /* ④ 建完之后的语义：创建 → 完成、取消 → 关闭，且"完成"只 PATCH 不新建 */
    assert.match(appJs, /if \(okBtn\) okBtn\.textContent = '完成'/);
    assert.match(appJs, /if \(cancelBtn\) cancelBtn\.textContent = '关闭'/);
    assert.match(appJs, /if \(createdAsset\) \{\s*\n\s*const patch = \{\}/, '已建过就只改名字 / 提示词');
    /* ⑤ 调用方（createAssetFlow）见到 created 只刷新，不再建 */
    assert.match(appJs, /if \(r\.created\) \{/, '弹窗内已创建时不能再建一条');
    assert.match(appJs, /const cancel = \(\) => done\(createdAsset \? \{ created: createdAsset \} : null\);/,
      '取消也要把"已创建"如实告诉调用方，否则用户回列表看不见它');
  });
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
