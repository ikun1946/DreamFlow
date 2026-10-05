'use strict';
/* 分镜表列显隐（0.48.0）：设置 →「个性化 → 分镜表列」把分镜表里不想看的列收起来。
   「序号 / 结果与进度 / 操作」是骨架列，不可隐藏；其余 8 列逐列显示 / 隐藏。

   为什么这几条值得单独钉住 —— 这条链路的失效方式**全是静默的**，肉眼看不出：
     · 能点的列（constants.js 的 COLUMNS）与能藏的列（styles.css 的 --w-<key> / [data-colhide]）
       对不上 → 点一下没反应，界面不报错；
     · 隐藏用 display:none 或只置 0 轨道宽不清 padding → 列与表头错位一格 / 隐藏列仍有
       20px 溢出吃掉邻列左侧的点击（`*{box-sizing:border-box}` 下的 padding 撑宽）；
     · 只隐藏内容、不管 overflow:visible 的牌组列 → 隐藏后素材格仍浮在别的列上。
   所以这里把「四处必须同步」逐条钉死；真渲染（列真的消失、不错位、点击不串列）由
   `npm run smoke:web` 与人工过一遍兜底 —— 与 test/08 / test/18 同一取舍。 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(REPO, 'app', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'app', 'styles.css'), 'utf8');
const constsSrc = fs.readFileSync(path.join(REPO, 'app', 'constants.js'), 'utf8');

/* 列定义来自 constants.js 本身（不是在这里手抄一份列名），这样"新增一列忘了配套"
   才可能被这里发现；同理，模块切片里的白名单也是拿这份 COLUMN_TOGGLES 喂进去的。 */
const consts = (() => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(constsSrc, context);
  return context.window;
})();
const COLUMNS = Array.from(consts.APP_COLUMNS, (c) => ({ key: c.key, label: c.label, fixed: !!c.fixed }));
const TOGGLE_KEYS = Array.from(consts.APP_COLUMN_TOGGLES, (c) => c.key);
const FIXED_KEYS = ['rail', 'result', 'acts'];

/* 切片运行 app.js 的「列显隐」模块（纯函数：只碰 document.documentElement.dataset 与
   localStorage，不依赖 S / 渲染），配最小 DOM 与存储替身。 */
const COLHIDE_MARK = '/* ---------------------------------------------------------- 分镜表列显隐（0.48.0） */';
function colhideEnv(stored) {
  const start = appJs.indexOf(COLHIDE_MARK);
  const end = appJs.indexOf('/* 「设置」按钮上主题图标的可读文案', start);
  assert.ok(start >= 0 && end > start, 'app.js 里找不到列显隐模块（切片标记被改动？）');
  const store = new Map();
  if (stored != null) store.set('jmc.hiddenCols', stored);
  const html = { dataset: {} };
  const context = vm.createContext({
    COLUMN_TOGGLES: consts.APP_COLUMN_TOGGLES,
    document: { documentElement: html },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }
    }
  });
  vm.runInContext(appJs.slice(start, end), context);
  return { context, html, store };
}

describe('分镜表列显隐：列定义', () => {
  test('只有序号 / 结果与进度 / 操作 不可隐藏，其余 8 列都可显隐', () => {
    assert.equal(COLUMNS.length, 11, '分镜表共 11 列');
    assert.deepEqual(COLUMNS.filter((c) => c.fixed).map((c) => c.key), FIXED_KEYS,
      '骨架列必须是且仅是这三列');
    assert.deepEqual(TOGGLE_KEYS,
      ['prompt', 'character', 'scene', 'prop', 'firstFrame', 'storyboard', 'audio', 'status'],
      '可显隐列 = COLUMNS 里除骨架列以外的全部（少一列就是有一列点不到）');
    TOGGLE_KEYS.forEach((k) => {
      const col = COLUMNS.find((c) => c.key === k);
      assert.ok(col && col.label, '每颗 chip 都要有列名（' + k + '）');
    });
  });

  test('设置面板与表体都按同一份清单渲染/挂载 data-col（少一处就只剩表头或只剩数据消失）', () => {
    /* 表头：<div data-col="<key>">；槽位列：data-col="<role>"（角色名与列 key 同源） */
    assert.match(appJs, /'<div data-col="' \+ c\.key \+ '">'/,
      '表头单元格要带 data-col（列显隐的 CSS 挂载点）');
    assert.match(appJs, /return '<div class="c-rail" data-col="rail">/, '序号列头要带 data-col');
    assert.match(appJs, /class="cell cell-slots" data-col="' \+ role \+ '"/);
    assert.match(appJs, /'<div class="cell rail" data-col="rail">'/, '行内 rail 要带 data-col');
    assert.match(appJs, /'<div class="cell prompt" data-col="prompt">'/, '行内提示词列要带 data-col');
    assert.match(appJs, /<div class="cell" data-col="status">/, '行内状态列要带 data-col');
    /* 设置面板：chip 由 COLUMN_TOGGLES 生成，点击走委托 → toggleColHide（不写服务端） */
    assert.match(appJs, /'<div class="colhide"><span class="k">分镜表列<\/span>'/, '个性化卡片里要有列显隐块');
    assert.match(appJs, /data-coltoggle="' \+ esc\(c\.key\) \+ '"/, 'chip 必须由 COLUMN_TOGGLES 渲染');
    assert.match(appJs, /toggleColHide\(b\.dataset\.coltoggle\)/, '点击要落到 toggleColHide');
    assert.doesNotMatch(appJs, /data-coltoggle[\s\S]{0,400}Api\.putSettings/,
      '列显隐是纯显示偏好，不得写进服务端设置');
  });
});

describe('分镜表列显隐：CSS 三处必须同步', () => {
  test('每个可显隐列都有零宽轨道令牌 + 单元格清 padding + 内容不渲染', () => {
    TOGGLE_KEYS.forEach((k) => {
      assert.match(css, new RegExp('^html\\[data-colhide~="' + k + '"\\]\\{--w-' + k + ':0px\\}$', 'm'),
        '缺零宽轨道规则：' + k + '（只隐藏内容的话列宽还在，后面所有列会错位一格）');
      const scope = 'html[data-colhide~="' + k + '"] :is(.colhead,.row) > [data-col="' + k + '"]';
      assert.ok(css.includes(scope + '{padding:0}'),
        '缺清 padding 规则：' + k + '（border-box 下 padding 会把 0 宽单元撑成 20px，吃掉邻列点击）');
      assert.ok(css.includes(scope + ' > *{display:none}'),
        '缺内容不渲染规则：' + k + '（牌组列是 overflow:visible，光靠裁剪关不住）');
      const tokenDecls = (css.match(new RegExp('--w-' + k + ':', 'g')) || []).length;
      assert.ok(tokenDecls >= 2,
        '--w-' + k + ' 要同时在 :root 与 ≤1364 响应式段各声明一次（缺一份窄屏下该列藏不掉）');
    });
  });

  test('骨架列没有任何隐藏规则（序号 / 结果与进度 / 操作 必须始终显示）', () => {
    FIXED_KEYS.forEach((k) => {
      assert.doesNotMatch(css, new RegExp('data-colhide~="' + k + '"'), k + ' 不该能被隐藏');
    });
    assert.match(css, /^\s*--sb-grid:var\(--w-rail\) var\(--w-prompt\)/m,
      '--sb-grid 必须由逐列令牌组合 —— 否则隐藏列时列宽表会有第二份真相');
    assert.match(css, /^html\[data-colhide~="prompt"\]\{--w-prompt:0px\}$/m);
  });
});

describe('分镜表列显隐：偏好归一化与写入形态', () => {
  test('非法 key / 重复 / 乱序都被纠正（localStorage 是用户可改的，不能让界面失控）', () => {
    const { context } = colhideEnv(null);
    const norm = (v) => Array.from(context.normColHide(v));
    assert.deepEqual(norm('scene bogus scene 场景  '), ['scene'], '未知 key 丢掉、重复只留一份');
    assert.deepEqual(norm('status scene'), ['scene', 'status'], '按 COLUMNS 列序输出（存储值可读可 diff）');
    assert.deepEqual(norm(''), []);
    assert.deepEqual(norm(null), []);
    assert.deepEqual(norm(['audio', 'nope']), ['audio'], '数组形态（未来改用 JSON 存储）同样归一化');
  });

  test('<html data-colhide> 是唯一事实来源：写、翻转、全显示时移除属性', () => {
    const a = colhideEnv(null);
    a.context.applyColHide(['scene']);
    assert.equal(a.html.dataset.colhide, 'scene');
    a.context.applyColHide([]);
    assert.ok(!('colhide' in a.html.dataset), '全部显示时属性必须**被移除**（不是写空串）');

    /* 启动镜像 → 点 chip 翻转 → 持久化：三者的值必须一致 */
    const b = colhideEnv('audio');
    b.context.initColHide();
    assert.equal(b.html.dataset.colhide, 'audio', '启动时要按 localStorage 恢复');
    assert.deepEqual(Array.from(b.context.hiddenCols()), ['audio']);
    assert.equal(b.context.colHidden('audio'), true);

    assert.deepEqual(Array.from(b.context.toggleColHide('audio')), [], '再点一次 = 显示回来');
    assert.ok(!('colhide' in b.html.dataset));
    assert.equal(b.store.get('jmc.hiddenCols'), '', '存储同步为"都没有隐藏"');

    b.context.toggleColHide('scene');
    assert.equal(b.html.dataset.colhide, 'scene');
    assert.equal(b.store.get('jmc.hiddenCols'), 'scene', '存储是空格分隔的列 key');

    b.context.toggleColHide('bogus');
    assert.equal(b.html.dataset.colhide, 'scene', '未知 key 什么也不做');
    assert.equal(b.store.get('jmc.hiddenCols'), 'scene');
  });

  test('点列显隐不会被当成"改过设置"，后台刷新回来的最新设置不会被丢掉', () => {
    assert.match(appJs,
      /\['click', 'change', 'input'\][\s\S]{0,240}closest\('\[data-coltoggle\]'\)\) return;[\s\S]{0,120}S\.settingsDirty = true;/,
      'dirty 守卫必须放过 data-coltoggle（否则用户改个列就会让后台刷新的最新设置整份作废）');
  });
});
