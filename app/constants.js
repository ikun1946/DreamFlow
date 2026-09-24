'use strict';
/* ============================================================
   constants.js —— 静态查找表 / 配置（阶段 2.5 拆分自 app.js）

   为什么单独抽出来（2026-09-22 阶段 2.5）：
     · 原文件 5517 行，超出 ≤2500 行门禁；
     · 单独抽出静态数据是最稳的**第一步** —— 没有运行时依赖、不闭包、
       直接挂在 window 上后 app.js 用 `const I = window.APP_ICONS;` 接住即可；
     · 这一刀不动行为、不改 API、不动 IIFE 里的状态机（那部分单独拆需要先建依赖图，
       是另一轮的工作，详见 README 变更记录 0.28.9 的解释）。

   ⚠ 加载顺序：constants.js 必须在 app.js **之前**加载（index.html 的 <script src> 顺序），
     否则 app.js 拿不到 window.APP_ICONS。

   ⚠ 与 styles.css 的关系：icon 与 column 表头里嵌了内联 SVG —— 那是"data URI 不值得、
     CSS 又说不清楚"的尺寸。这些内联 SVG 放在这里（与字面量同源），改时一找就到，
     不必去 CSS 翻 stroke-width。
   ============================================================ */

(function () {
  /* ---------- 图标（24×24 viewBox；color 由 CSS currentColor 控制） ---------- */
  const ICONS = {
    minus: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M5.5 12h13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    plus:  '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    add:   '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    tick:  '<svg width="11" height="11" viewBox="0 0 24 24"><path d="M5.5 12.5l4 4L18.5 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tickSm:'<svg width="9" height="9" viewBox="0 0 24 24"><path d="M5.5 12.5l4 4L18.5 7.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x:     '<svg width="9" height="9" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>',
    /* 深色 ×：用于白底容器（弹层标题栏、详情栏）。I.x 是白描边，只适合深色底，别混用 */
    xDark: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    up:    '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 14.5l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down:  '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M18 6.5l-1 14H7l-1-14" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    retry: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.7-6" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/><path d="M20.5 3.5v5h-5" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop:  '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>',
    play:  '<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.34)"/><path d="M9.5 7.5l7 4.5-7 4.5z" fill="#fff"/></svg>',
    clock: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 7.5v5l3.2 1.9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    alert: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 7.5v5.5M12 16.2h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    search:'<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2.2" fill="none"/><path d="M16.2 16.2L21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    warn:  '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M10.3 4.2L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M12 9.5v4M12 16.5h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 12.4l2.8 2.8L16 9.6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    expand:'<svg width="14" height="14" viewBox="0 0 24 24"><path d="M14.5 4H20v5.5M9.5 20H4v-5.5M20 4l-6.5 6.5M4 20l6.5-6.5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    /* 放大图标（深色描边，用于白底表格）：I.expand 是白描边，只适合深色底，别混用 */
    expandDark: '<svg width="12" height="12" viewBox="0 0 24 24"><path d="M14.5 4H20v5.5M9.5 20H4v-5.5M20 4l-6.5 6.5M4 20l6.5-6.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    /* 编辑图标（铅笔，0.38.0 新增）：与 expandDark 同为 currentColor 描边，用于分镜行内编辑提示词 */
    edit:  '<svg width="12" height="12" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    /* 复制图标：描边用 currentColor，由按钮的 color 控制（浅色块 / 深色代码块上都能用） */
    copy:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.4" stroke="currentColor" stroke-width="2"/><path d="M15.4 5.7A2.4 2.4 0 0013.3 4H6.4A2.4 2.4 0 004 6.4v6.9a2.4 2.4 0 001.7 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    /* 图片占位图标：描边用 currentColor，由 CSS 控制颜色与透明度（半透明占位样式） */
    img:   '<svg width="42" height="42" viewBox="0 0 24 24" fill="none"><rect x="3" y="4.6" width="18" height="14.8" rx="3" stroke="currentColor" stroke-width="1.5"/><circle cx="8.7" cy="9.7" r="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M3.7 16.4l4.5-4.1 3.3 2.9 3-2.5 5.8 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    /* 音符占位：与 I.img 同为 currentColor 描边，好让"无图图片素材"与"无音频"共用同一套半透明空槽位视觉。
       ⚠ 必须用 currentColor 而非写死 fill —— 它要落在浅色底上，由 CSS 的
       `.ph-ico{color:var(--ink);opacity:.26}` 控制深浅。 */
    notePh: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none"><circle cx="6.6" cy="17.6" r="2.6" stroke="currentColor" stroke-width="1.5"/><circle cx="16.4" cy="15.6" r="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M9.2 17.6V6.4l9.8-2.2v11.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  /* ---------- 分镜状态的中文标签 ---------- */
  const STATUS_TEXT = {
    draft: '未提交', queued: '排队中', generating: '生成中',
    succeeded: '已完成', failed: '失败', canceled: '已取消'
  };

  /* ---------- 资产类型元数据（与后端 services.js 的 ROLE_MULTI 一致） ----------
     ⚠ multi 必须与后端 server/services.js 的 ROLE_MULTI **保持一致**（两处各有一份表，
     改一处忘一处就会出现"后端允许绑多个、前端却不给 ＋ 按钮"这类静默不一致）。
     2026-09-20：audio 由单值改为多值 —— 一个分镜常有多角色，各自的音色是不同文件。 */
  const ROLE_META = {
    character:  { label: '角色',   type: 'character',  multi: true,  key: 'characters' },
    scene:      { label: '场景',   type: 'scene',      multi: false, key: 'scene' },
    prop:       { label: '道具',   type: 'prop',       multi: true,  key: 'prop' },
    firstFrame: { label: '首帧图', type: 'firstFrame', multi: false, key: 'firstFrame' },
    storyboard: { label: '分镜图', type: 'storyboard', multi: false, key: 'storyboard' },
    audio:      { label: '音频',   type: 'audio',      multi: true,  key: 'audio' }
  };

  /* 素材面板的 Tab 顺序与标签：与资产类型一一对应（6 类） */
  const ASSET_TABS = ['character', 'scene', 'prop', 'firstFrame', 'storyboard', 'audio'];
  const ASSET_TAB_LABEL = {
    character: '角色', scene: '场景', prop: '道具',
    firstFrame: '首帧图', storyboard: '分镜图', audio: '音频'
  };

  /* ---------- 分镜表列定义 ---------- */
  const COLUMNS = [
    { key: 'rail',   w: 44 },
    { key: 'prompt', w: 340, label: '分镜 / 提示词', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' },
    { key: 'character', w: 160, label: '角色', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6" stroke="currentColor" stroke-width="1.9" fill="none"/><path d="M5 20c1.2-3.6 3.8-5.4 7-5.4s5.8 1.8 7 5.4" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/></svg>' },
    { key: 'scene', w: 100, label: '场景', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" stroke-width="1.9" fill="none"/><circle cx="8.5" cy="10" r="1.6" stroke="currentColor" stroke-width="1.7" fill="none"/></svg>' },
    { key: 'prop', w: 100, label: '道具', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linejoin="round"/><path d="M4 8l8 4.5L20 8M12 12.5v8" stroke="currentColor" stroke-width="1.9" fill="none"/></svg>' },
    { key: 'firstFrame', w: 86, label: '首帧图', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M5 3.5v17" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M5 5.5h13l-2.6 3.8L18 13H5" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linejoin="round"/></svg>' },
    { key: 'storyboard', w: 84, label: '分镜图', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.9" fill="none"/><rect x="13" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.9" fill="none"/></svg>' },
    { key: 'audio', w: 84, label: '音频', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M9.5 4v10.1a2.9 2.9 0 1 1-1.5-2.55V6.2h7.4v5.4a2.9 2.9 0 1 1-1.5-2.55V4z" fill="currentColor"/></svg>' },
    { key: 'result', w: 190, label: '结果与进度', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2.5" y="5" width="13.5" height="14" rx="2.5" stroke="currentColor" stroke-width="1.9" fill="none"/><path d="M16.5 10.2l5-2.7v9l-5-2.7z" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linejoin="round"/></svg>' },
    { key: 'status', w: 94, label: '状态', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.9" fill="none"/><path d="M8.5 12.2l2.6 2.6 4.6-5" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    { key: 'acts', w: 82, label: '操作', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 8h10M18 8h2M4 16h4M12 16h8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="16" cy="8" r="2" stroke="currentColor" stroke-width="1.9" fill="none"/><circle cx="10" cy="16" r="2" stroke="currentColor" stroke-width="1.9" fill="none"/></svg>' }
  ];

  /* 暴露在 window 上 —— app.js 的 IIFE 内 `const I = window.APP_ICONS;` 接住。 */
  window.APP_ICONS = ICONS;
  window.APP_STATUS_TEXT = STATUS_TEXT;
  window.APP_ROLE_META = ROLE_META;
  window.APP_ASSET_TABS = ASSET_TABS;
  window.APP_ASSET_TAB_LABEL = ASSET_TAB_LABEL;
  window.APP_COLUMNS = COLUMNS;
})();