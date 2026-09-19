/* ============================================================
   app.js —— 状态、渲染与交互
   ---- 分层约定 ----
   api.js   只负责「请求 → 数据 / ApiError」，不碰 DOM
   app.js   只负责「数据 → DOM」与用户操作，不拼 URL
   ============================================================ */
(function () {
  'use strict';

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad2 = (n) => String(n).padStart(2, '0');
  const mmss = (sec) => sec ? pad2(Math.floor(sec / 60)) + ':' + pad2(sec % 60) : '--:--';
  const OPT = () => S.options || Api.META;

  /* ------------------------------------------------ 错误码 → 文案兜底 */
  const ERR_TEXT = {
    40001: '参数不合法', 40100: '登录已失效，请重新登录', 40300: '没有权限',
    40400: '内容不存在', 40900: '当前状态不允许该操作', 42900: '请求过于频繁，已自动重试',
    50000: '服务异常，请稍后重试',
    51001: '即梦 CLI 未连接，请检查本地桥接服务',
    51002: '积分不足，无法生成该分镜',
    51003: '内容未通过审核，建议调整提示词后重试',
    51004: '生成超时，可稍后重试',
    51005: '生成被中断，可重试'
  };
  const errText = (e) => (e && e.message) || ERR_TEXT[e && e.code] || '操作失败，请稍后重试';

  /* ---------------------------------------------------------- 图标 */
  const I = {
    minus: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M5.5 12h13" stroke="#333" stroke-width="2.4" stroke-linecap="round"/></svg>',
    plus:  '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13" stroke="#333" stroke-width="2.4" stroke-linecap="round"/></svg>',
    add:   '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13" stroke="#7A7A7A" stroke-width="1.9" stroke-linecap="round"/></svg>',
    tick:  '<svg width="11" height="11" viewBox="0 0 24 24"><path d="M5.5 12.5l4 4L18.5 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tickSm:'<svg width="9" height="9" viewBox="0 0 24 24"><path d="M5.5 12.5l4 4L18.5 7.5" fill="none" stroke="#0066CC" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x:     '<svg width="9" height="9" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>',
    // 深色 ×：用于白底容器（弹层标题栏、详情栏）。I.x 是白描边，只适合深色底，别混用
    xDark: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#7A7A7A" stroke-width="2" stroke-linecap="round"/></svg>',
    up:    '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 14.5l6-6 6 6" stroke="#7A7A7A" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down:  '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6" stroke="#7A7A7A" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    trash: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M18 6.5l-1 14H7l-1-14" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    retry: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.7-6" stroke="#D70015" stroke-width="1.9" fill="none" stroke-linecap="round"/><path d="M20.5 3.5v5h-5" stroke="#D70015" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop:  '<svg width="18" height="18" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="#7A7A7A"/></svg>',
    play:  '<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.34)"/><path d="M9.5 7.5l7 4.5-7 4.5z" fill="#fff"/></svg>',
    clock: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="#D2D2D7" stroke-width="1.8" fill="none"/><path d="M12 7.5v5l3.2 1.9" stroke="#D2D2D7" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    alert: '<svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="#D70015" stroke-width="1.8" fill="none"/><path d="M12 7.5v5.5M12 16.2h.01" stroke="#D70015" stroke-width="1.8" stroke-linecap="round"/></svg>',
    search:'<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" stroke="#7A7A7A" stroke-width="2.2" fill="none"/><path d="M16.2 16.2L21 21" stroke="#7A7A7A" stroke-width="2.2" stroke-linecap="round"/></svg>',
    warn:  '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M10.3 4.2L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0z" stroke="#B26A00" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M12 9.5v4M12 16.5h.01" stroke="#B26A00" stroke-width="1.8" stroke-linecap="round"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#248A3D" stroke-width="1.8" fill="none"/><path d="M8 12.4l2.8 2.8L16 9.6" stroke="#248A3D" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    note:  '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M9.5 4v10.1a2.9 2.9 0 1 1-1.5-2.55V6.2h7.4v5.4a2.9 2.9 0 1 1-1.5-2.55V4z" fill="#fff"/></svg>',
    expand:'<svg width="14" height="14" viewBox="0 0 24 24"><path d="M14.5 4H20v5.5M9.5 20H4v-5.5M20 4l-6.5 6.5M4 20l6.5-6.5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    swap:  '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 7h13M14 3.5L17.5 7 14 10.5M20 17H7M10 13.5L6.5 17l3.5 3.5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  const STATUS_TEXT = { draft: '未提交', queued: '排队中', generating: '生成中', succeeded: '已完成', failed: '失败', canceled: '已取消' };
  const ROLE_META = {
    character:  { label: '角色',   type: 'character', multi: true,  key: 'characters' },
    scene:      { label: '场景',   type: 'scene',     multi: false, key: 'scene' },
    prop:       { label: '道具',   type: 'prop',      multi: false, key: 'prop' },
    firstFrame: { label: '首帧图', type: 'scene',     multi: false, key: 'firstFrame' },
    storyboard: { label: '分镜图', type: 'scene',     multi: false, key: 'storyboard' },
    audio:      { label: '音频',   type: 'audio',     multi: false, key: 'audio' }
  };

  const COLUMNS = [
    { key: 'rail',   w: 44 },
    { key: 'prompt', w: 340, label: '分镜 / 提示词', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" stroke="#7A7A7A" stroke-width="2" stroke-linecap="round"/></svg>' },
    { key: 'character', w: 160, label: '角色', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><path d="M5 20c1.2-3.6 3.8-5.4 7-5.4s5.8 1.8 7 5.4" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linecap="round"/></svg>' },
    { key: 'scene', w: 100, label: '场景', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><circle cx="8.5" cy="10" r="1.6" stroke="#7A7A7A" stroke-width="1.7" fill="none"/></svg>' },
    { key: 'prop', w: 100, label: '道具', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linejoin="round"/><path d="M4 8l8 4.5L20 8M12 12.5v8" stroke="#7A7A7A" stroke-width="1.9" fill="none"/></svg>' },
    { key: 'firstFrame', w: 86, label: '首帧图', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M5 3.5v17" stroke="#7A7A7A" stroke-width="1.9" stroke-linecap="round"/><path d="M5 5.5h13l-2.6 3.8L18 13H5" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linejoin="round"/></svg>' },
    { key: 'storyboard', w: 84, label: '分镜图', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><rect x="13" y="13" width="8" height="8" rx="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/></svg>' },
    { key: 'audio', w: 84, label: '音频', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M9.5 4v10.1a2.9 2.9 0 1 1-1.5-2.55V6.2h7.4v5.4a2.9 2.9 0 1 1-1.5-2.55V4z" fill="#7A7A7A"/></svg>' },
    { key: 'result', w: 190, label: '结果与进度', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2.5" y="5" width="13.5" height="14" rx="2.5" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><path d="M16.5 10.2l5-2.7v9l-5-2.7z" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linejoin="round"/></svg>' },
    { key: 'status', w: 94, label: '状态', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><path d="M8.5 12.2l2.6 2.6 4.6-5" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    { key: 'acts', w: 82, label: '操作', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 8h10M18 8h2M4 16h4M12 16h8" stroke="#7A7A7A" stroke-width="1.9" stroke-linecap="round"/><circle cx="16" cy="8" r="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><circle cx="10" cy="16" r="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/></svg>' }
  ];

  /* ---------------------------------------------------------- 状态 */
  const S = {
    list: [], stats: null, options: null, adapter: null, settings: null,
    sel: new Set(), filter: 'all', keyword: '',
    panelTab: 'character', panelKeyword: '', assets: [], assetCounts: { currentShot: 0, library: 0 },
    assetBusy: null, assetMsg: '',
    assetSelMode: false, assetSel: new Set(),
    bindTarget: null,            // { id, role }
    detailFull: null,            // 最近一次打开的详情数据（复制锁定区块 / 完整提示词用）
    loading: true, error: null, busy: false,
    page: 1, pageSize: 50,
    poll: { timer: null, idle: 0 },
    imp: { raw: '', delimiter: { type: 'custom', value: ';;' }, preview: null, busy: false, timer: null },
    cliBusy: null, cliMsg: '', cliUrl: null, cliUserCode: null, cliRaw: null,
    settingsDirty: false,   // 抽屉本次打开期间用户是否已改动过设置（"先显示后刷新"的守卫）
    cliHint: null,          // 后端给的"下一步怎么做"提示（如手工执行 dreamina relogin）
    dCliUrl: null, dCliCode: null,   // 创作 CLI（dreamina）的授权链接与设备码，独立存放
    dryBusy: false,                 // 干跑提交进行中
    cmdRows: [], cmdAt: 0,                     // 命令核对面板数据
    autoBusy: false, autoRows: [], autoStats: null, autoIds: [], autoScopeAll: false, autoPending: false,   // 自动匹配参考图
    durBusy: false, durRows: [], durStats: null, durIds: [], durScopeAll: false,       // 按时长标注重算
    /* 生成记录视图（全屏）：列表分页 + 筛选 + 选中详情。
       记录由后端在任务收尾时落盘（成功/失败/取消/干跑各一条），前端只读+删。 */
    rec: { loading: false, list: [], page: 1, pageSize: 20, total: 0, pageCount: 1, stats: null, kept: 0, capacity: 0 },
    recF: { action: 'all', outcome: 'all', engine: 'all', keyword: '', from: '', to: '' },
    recSel: null, recDetail: null, recDetailLoading: false, recTimer: null, recPoll: null
  };
  const opts = () => S.options || Api.META;
  const rowById = (id) => S.list.find((r) => r.id === id);

  /* ---------------------------------------------------------- Toast */
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.transition = '.24s'; el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 2200);
    setTimeout(() => el.remove(), 2500);
  }
  const fail = (e) => toast(errText(e), 'err');

  /* ---------------------------------------------------------- 顶栏 */
  function renderTopbar() {
    const st = S.stats || {};
    $('#projName').textContent = (opts().projectName) || '未命名项目';
    $('#scopeChip').textContent = '第 1 批 · ' + (st.total || 0) + ' 个分镜';
    const d = S.settings && S.settings.defaults;
    $('#pillModelTxt').textContent = '模型 ' + (d ? (labelOf(opts().models, d.model) || d.model) : '—');
    $('#pillRatioTxt').textContent = '画幅 ' + (d ? d.ratio : '—');
    $('#runText').textContent = (st.generating || st.queued)
      ? '生成中 ' + (st.generating || 0) + ' · 排队中 ' + (st.queued || 0)
      : (st.total ? '全部就绪' : '—');
    const rs = $('.runstate');
    rs.classList.toggle('off', !S.adapter || !S.adapter.cliAvailable);
    rs.classList.toggle('err', !!S.error);
  }
  const labelOf = (arr, v) => { const o = (arr || []).find((x) => x.value === v); return o ? o.label : null; };

  /* ---------------------------------------------------------- 列头 */
  function selAllCounts() {
    const n = S.list.reduce((acc, r) => acc + (S.sel.has(r.id) ? 1 : 0), 0);
    return { n, total: S.list.length };
  }
  function updateCheckAll() {
    const el = document.querySelector('[data-checkall]');
    if (!el) return;
    const { n, total } = selAllCounts();
    el.classList.toggle('on', total > 0 && n === total);
    el.classList.toggle('partial', n > 0 && n < total);
  }
  function toggleCheckAll() {
    if (!S.list.length) return;
    const { n, total } = selAllCounts();
    if (n === total) S.sel.clear();
    else S.list.forEach((r) => S.sel.add(r.id));
    renderTable(); renderPanel(); renderStatusbar();
  }
  function renderColhead() {
    $('#colhead').innerHTML = COLUMNS.map((c) => {
      if (c.key === 'rail') {
        return '<div class="c-rail"><span>序号</span><button class="cbx" data-checkall="1" title="全选 / 取消全选">' + I.tick + '</button></div>';
      }
      return '<div>' + c.icon + '<span>' + c.label + '</span></div>';
    }).join('');
    const ca = document.querySelector('[data-checkall]');
    if (ca) ca.addEventListener('click', toggleCheckAll);
    updateCheckAll();
  }

  /* ---------------------------------------------------------- 时长控件 */
  function durHTML(s) {
    const d = opts().duration;
    if (!s.canEditDuration) {
      return '<span class="dur locked" title="已完成，修改时长需重新生成"><span class="val" data-locked="1">' + s.durationSec + 's</span></span>';
    }
    return '<span class="dur" data-dur="' + s.id + '">' +
      '<button data-step="-1" title="减 1 秒"' + (s.durationSec <= d.min ? ' disabled' : '') + '>' + I.minus + '</button>' +
      '<span class="val" data-val="1" title="点击选预设 / 双击直接输入">' + s.durationSec + 's</span>' +
      '<button data-step="1" title="加 1 秒"' + (s.durationSec >= d.max ? ' disabled' : '') + '>' + I.plus + '</button>' +
      '</span>';
  }

  /* ---------------------------------------------------------- 行 */
  function slotsHTML(s, role) {
    const meta = ROLE_META[role];
    const items = s.assets.filter((a) => a.role === role);
    const canAdd = meta.multi ? true : items.length === 0;
    let out = '';
    items.forEach((a) => {
      const bg = (a.url && !/^(mock|cli):/.test(a.url) && a.type !== 'audio')
        ? 'background-image:url(' + a.url + ');background-size:cover;background-position:center;' : '';
      /* 图号徽标：这个号 = 提交时 --image 的上传顺序，也是提示词里该写的 @图片N。
         没有它，作者根本无法在提示词里指认「哪张图是谁」。 */
      const badge = a.imageIndex
        ? '<i class="imgnum" title="提交时作为第 ' + a.imageIndex + ' 张 --image 发出；提示词里用 @图片' + a.imageIndex + ' 引用它">图' + a.imageIndex + '</i>'
        : (a.audioIndex
            ? '<i class="imgnum aud" title="音频走 --audio，不占图片号">音' + a.audioIndex + '</i>'
            : (a.notCounted ? '<i class="imgnum bad" title="未计入图号：' + esc(a.notCounted) + '（后面的图号也不会因它顺延）">!</i>' : ''));
      const tip = esc(a.name) + (a.imageIndex ? '（图片' + a.imageIndex + '）' : '');
      out += '<span class="thumb" style="' + bg + '--g:' + (a.grad || Api.grad(a.assetId)) + '" title="' + tip + '">' +
        badge +
        '<span>' + esc(a.name) + '</span>' +
        '<button class="rm" data-unbind="' + a.assetId + '" data-role="' + role + '" title="移除">' + I.x + '</button>' +
        '</span>';
    });
    if (canAdd) out += '<button class="slot-add" data-bind="' + role + '" title="添加' + meta.label + '">' + I.add + '</button>';
    if (!items.length && !canAdd) out += '<span class="dash">—</span>';
    return out;
  }

  function resultHTML(s) {
    let inner;
    if (s.status === 'succeeded') {
      inner = '<span class="result-thumb" data-preview="' + s.id + '" style="--g:' + s.grad + '" title="预览产物">' + I.play + '</span>';
    } else if (s.status === 'failed') {
      inner = '<span class="result-thumb failed" title="' + esc(s.errorMessage || '生成失败') + '">' + I.alert + '</span>';
    } else {
      inner = '<span class="result-thumb plain">' + I.clock + '</span>';
    }
    const cls = s.status === 'succeeded' ? 'ok' : (s.status === 'failed' ? 'err' : '');
    return inner +
      '<span class="progline"><span class="bar"><i class="' + cls + '" style="width:' + Math.round(s.progress) + '%"></i></span>' +
      '<span class="pct">' + Math.round(s.progress) + '%</span></span>';
  }

  function actsHTML(s) {
    const busy = S.busy;
    const gen = s.status === 'generating' || s.status === 'queued';
    return '' +
      '<button class="icon-act" data-act="up" title="上移"' + (busy ? ' disabled' : '') + '>' + I.up + '</button>' +
      '<button class="icon-act" data-act="down" title="下移"' + (busy ? ' disabled' : '') + '>' + I.down + '</button>' +
      (s.status === 'failed'
        ? '<button class="icon-act" data-act="retry" title="重试"' + (busy ? ' disabled' : '') + '>' + I.retry + '</button>'
        : (gen
            ? '<button class="icon-act" data-act="cancel" title="取消"' + (busy ? ' disabled' : '') + '>' + I.stop + '</button>'
            : '<button class="icon-act" data-act="detail" title="查看 CLI 命令与日志"' + (busy ? ' disabled' : '') + '>' + I.search + '</button>')) +
      '<button class="icon-act" data-act="del" title="删除"' + (busy ? ' disabled' : '') + '>' + I.trash + '</button>';
  }

  function rowHTML(s) {
    const sel = S.sel.has(s.id);
    return '<div class="row' + (sel ? ' sel' : '') + '" data-id="' + s.id + '">' +
      '<div class="cell rail">' +
        '<span class="rail-num">' + s.seq + '</span>' +
        '<button class="cbx' + (sel ? ' on' : '') + '" data-check="1" title="选择">' + I.tick + '</button>' +
      '</div>' +
      '<div class="cell prompt">' +
        '<span class="titleline"><span class="shotno">分镜 ' + s.seq + '</span>' + durHTML(s) + '</span>' +
        '<span class="prompt-text">' + esc(s.prompt) + '</span>' +
        '<span class="prompt-meta">模型 ' + esc(labelOf(opts().models, s.model) || s.model) + ' · ' + s.ratio + ' · ' + s.resolution + ' · motion ' + Number(s.motion).toFixed(2) + (s.imageCount ? ' · 参考图 ' + s.imageCount + ' 张' : '') + '</span>' +
      '</div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'character') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'scene') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'prop') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'firstFrame') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'storyboard') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'audio') + '</span></div>' +
      '<div class="cell result">' + resultHTML(s) + '</div>' +
      '<div class="cell"><span class="badge ' + s.status + '"><i class="bdot"></i>' + STATUS_TEXT[s.status] + '</span></div>' +
      '<div class="cell acts">' + actsHTML(s) + '</div>' +
    '</div>';
  }

  /* ---------------------------------------------------------- 表格三态 */
  function renderTable() {
    const host = $('#table');
    if (S.loading) {
      host.innerHTML = '<div class="skeleton">' + Array.from({ length: 4 }).map(() =>
        '<div class="sk-row">' +
          '<div class="sk" style="width:44px;height:26px"></div>' +
          '<div class="sk" style="flex:1;height:52px"></div>' +
          '<div class="sk" style="width:120px;height:52px"></div>' +
          '<div class="sk" style="width:80px;height:52px"></div>' +
          '<div class="sk" style="width:150px;height:20px"></div>' +
        '</div>').join('') + '</div>';
      return;
    }
    if (S.error) {
      host.innerHTML = '<div class="errorbox">' + I.warn +
        '<b>加载失败</b><span>' + esc(errText(S.error)) + '</span>' +
        '<button class="btn-outline" data-act="reload">重试</button></div>';
      return;
    }
    if (!S.list.length) {
      host.innerHTML = '<div class="empty">' +
        '<svg width="44" height="44" viewBox="0 0 24 24"><rect x="2.5" y="4.5" width="19" height="15" rx="3" stroke="#D2D2D7" stroke-width="1.3" fill="none"/><path d="M2.5 8.5h19" stroke="#D2D2D7" stroke-width="1.3"/></svg>' +
        '<b>' + (S.keyword || S.filter !== 'all' ? '没有符合条件的分镜' : '还没有分镜') + '</b>' +
        '<span>' + (S.keyword || S.filter !== 'all' ? '试试清空搜索或切换筛选' : '把多段提示词粘进来，一次创建整批分镜') + '</span>' +
        (S.keyword || S.filter !== 'all' ? '' : '<button class="btn-primary" data-act="openImport">批量导入提示词</button>') +
        '</div>';
      return;
    }
    host.innerHTML = S.list.map(rowHTML).join('');
    updateCheckAll();
  }

  /* ---------------------------------------------------------- 素材面板 */
  function renderPanel() {
    const tabs = ['character', 'scene', 'prop', 'audio'];
    const tabLabel = { character: '角色', scene: '场景', prop: '道具', audio: '音频' };
    const act = document.activeElement;
    const keepSearch = act && act.id === 'panelSearch' ? act.selectionStart : null;

    $('#panel').innerHTML =
      '<div class="panel-top">' +
        '<span class="seg">' + tabs.map((t) =>
          '<button data-tab="' + t + '"' + (S.panelTab === t ? ' class="on"' : '') + '>' + tabLabel[t] + '</button>').join('') + '</span>' +
        '<span class="grow"></span>' +
        '<button class="btn-primary" style="padding:8px 13px;font-size:11.5px" id="btnSubmitSel">提交所选' + (S.sel.size ? ' ' + S.sel.size : '') + '</button>' +
        '<button class="btn-outline" style="padding:8px 13px;font-size:11.5px" id="btnDrySubmit" title="干跑：走完整提交链路组装命令，但不发送给即梦（不创建任务、不扣费），提交后在弹层里核对真实命令"' + (S.dryBusy ? ' disabled' : '') + '>' + (S.dryBusy ? '干跑中…' : '干跑提交') + '</button>' +
      '</div>' +
      '<div class="panel-actions">' +
        '<button class="btn-mini" data-assetact="openImport" title="两种模式：导入本地图片文件，或粘贴提示词文本（@ 分段自动识别 场景/道具/角色）"' + (S.assetBusy ? ' disabled' : '') + '>' + (S.assetBusy ? '导入中…' : '导入资产') + '</button>' +
        '<button class="btn-mini" data-assetact="batch" title="进入批量选择模式（操作在底部弹出的操作条中完成）"' + (S.assetBusy || S.assetSelMode ? ' disabled' : '') + '>批量选择</button>' +
        '<button class="btn-mini" id="btnAutoMatch" title="按素材名称在分镜提示词里匹配对应素材并自动绑定（先预览，确认后再应用）"' + (S.autoBusy ? ' disabled' : '') + '>' + (S.autoBusy ? '匹配中…' : '自动匹配参考图') + '</button>' +
        '<span class="grow"></span>' +
        '<span class="hint-sm">' + (S.panelTab === 'audio' ? '支持音频文件' : '图片 / 提示词导入') + '</span>' +
      '</div>' +
      (S.assetMsg ? '<div class="hint-sm asset-msg">' + esc(S.assetMsg) + '</div>' : '') +
      '<label class="panel-search">' + I.search +
        '<input id="panelSearch" placeholder="搜索' + tabLabel[S.panelTab] + '" value="' + esc(S.panelKeyword) + '" />' +
      '</label>' +
      '<div class="panel-list">' +
        '<div class="sec-head"><b>本分镜素材 (' + S.assetCounts.currentShot + ')</b><span class="grow"></span><span>' +
          (S.bindTarget ? '点击下方素材添加到分镜 ' + (rowById(S.bindTarget.id) || {}).seq
            : (S.assetSelMode ? '批量选择中：点击卡片勾选' : '点表格里的 ＋ 绑定；直接点击卡片则打开素材设置')) + '</span></div>' +
        (S.assetCounts.currentShot
          ? '<div class="grid">' + S.assets.filter((a) => a.inCurrentShot).map(cardHTML).join('') + '</div>'
          : '<div class="empty-mini">当前分镜还没有在此分类下绑定素材</div>') +
        '<div class="sec-head"><b>素材库全部 (' + S.assetCounts.library + ')</b><span class="grow"></span>' +
          (S.assetSelMode ? '<span>点击卡片勾选</span>'
            : (S.bindTarget ? '<span>点击即可添加到分镜 ' + (rowById(S.bindTarget.id) || {}).seq + '</span>'
              : '<span>点击打开素材设置</span>')) + '</div>' +
        (S.assets.length
          ? '<div class="grid">' + S.assets.map(cardHTML).join('') + '</div>'
          : '<div class="empty-mini">没有匹配的素材</div>') +
      '</div>';

    function cardHTML(a) {
      const hasPic = a.url && !/^(mock|cli):/.test(a.url) && a.type !== 'audio';
      const mediaBg = hasPic
        ? 'background-image:url(' + a.url + ');background-size:cover;background-position:center;'
        : '';
      const glyph = a.type === 'audio' ? '<span class="note">' + I.note + '</span>' : '';
      // 提示词导入的资产还没有图片：渐变占位 + 「提示词」角标，点击详情弹窗可上传 / 编辑
      const pmark = (!hasPic && a.type !== 'audio' && (a.origin === 'prompt' || a.prompt))
        ? '<span class="pmark" title="提示词资产：尚未上传图片，点开可编辑提示词并补图">提示词</span>' : '';
      const selCls = (S.assetSelMode && S.assetSel.has(a.id)) ? ' sel' : '';
      return '<div class="acard' + (a.inCurrentShot ? ' used' : '') + selCls + '" data-asset="' + a.id + '" title="' + esc(a.name) + '">' +
        '<span class="pic" style="--g:' + a.grad + (mediaBg ? ';' + mediaBg : '') + '">' + glyph + pmark +
        '<span class="tick">' + I.tickSm + '</span>' +
        '<button class="rm" data-assetdel="' + a.id + '" title="删除素材">' + I.x + '</button></span>' +
        '<span class="nm">' + esc(a.name) + '</span>' +
      '</div>';
    }

    // 搜索时保留焦点与光标位置，避免每敲一个字就失焦
    if (keepSearch !== null) {
      const el = $('#panelSearch');
      if (el) { el.focus(); try { el.setSelectionRange(keepSearch, keepSearch); } catch (e) { /* noop */ } }
    }
    renderBatchBar();
  }

  /* 素材批量操作条：批量选择模式下自屏幕底部向上弹出，所有批量操作集中在此完成 */
  function renderBatchBar() {
    const bar = $('#batchbar');
    if (!bar) return;
    const on = !!S.assetSelMode;
    bar.classList.toggle('on', on);
    bar.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (!on) { bar.innerHTML = ''; return; }
    const total = S.assets.length;
    const n = S.assetSel.size;
    bar.innerHTML =
      '<div class="bb-inner">' +
        '<b class="bb-title">批量选择</b>' +
        '<span class="hint-sm">已选 <b>' + n + '</b> / ' + total + ' 个（点击素材卡片勾选）</span>' +
        '<span class="grow"></span>' +
        '<button class="btn-mini" data-assetact="all"' + (total && n < total ? '' : ' disabled') + '>全选</button>' +
        '<button class="btn-mini" data-assetact="none"' + (n ? '' : ' disabled') + '>清空选择</button>' +
        '<button class="btn-mini btn-danger" data-assetact="del"' + (S.assetBusy || !n ? ' disabled' : '') + '>' + (S.assetBusy === 'del' ? '删除中…' : '删除所选' + (n ? '（' + n + '）' : '')) + '</button>' +
        '<button class="btn-primary" data-assetact="exit">完成</button>' +
      '</div>';
  }

  /* ---------------- 批量导入图片 · 名称匹配自动处理 ----------------
     匹配规则（明确定义）：
     · 文件名忽略扩展名后与资产名比较；
     · 首尾空格忽略（两侧都 trim）；
     · 大小写不敏感（统一转小写比较）；
     · 名称内部字符（含中间空格、全角/半角）必须完全一致，不做归一；
     · 同名资产有多个时，优先取「尚未关联图片」的那个（补图优先于冲突），否则取最新创建的；
     · 批次内同名文件：第一个参与匹配决策，其余一律作为新资产并存入库（不弹窗、结果可预期）。
     行为分支：
     · 同名资产无图 → 自动补图（replaceAsset 保留资产 id/绑定，不干预）；
     · 同名资产有图 → 暂停导入弹冲突对话框：覆盖原图 / 跳过新图 / 两者并存；
     · 无同名 → 正常新增。除冲突项外其余文件不受影响，全部照常导入。 */
  function normAssetKey(s) { return String(s || '').trim().toLowerCase(); }
  function fileBaseName(f) { return String(f.name || '').replace(/\.[^.]+$/, '').trim(); }

  async function planFiles(files) {
    const res = await Api.listAssets({ projectId: Api.CFG.projectId, type: S.panelTab });
    const lib = res.library || [];
    const byKey = new Map();
    lib.forEach((a) => {
      const k = normAssetKey(a.name);
      const cur = byKey.get(k);
      // 优先无图资产参与匹配；都无图 / 都有图时取最新（listAssets 已按 createdAt 倒序）
      if (!cur || (cur.url && !a.url)) byKey.set(k, a);
    });
    const groups = new Map();
    for (const f of files) {
      const k = normAssetKey(fileBaseName(f));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    const plan = { autoFill: [], conflicts: [], plain: [], dupNew: [] };
    for (const fs of groups.values()) {
      const asset = byKey.get(normAssetKey(fileBaseName(fs[0])));
      if (!asset) plan.plain.push(fs[0]);
      else if (!asset.url) plan.autoFill.push({ file: fs[0], asset });
      else plan.conflicts.push({ file: fs[0], asset });
      for (let i = 1; i < fs.length; i++) plan.dupNew.push(fs[i]);
    }
    return plan;
  }

  async function executeImportPlan(plan, conflictAction) {
    const type = S.panelTab;
    const steps = [];
    plan.autoFill.forEach((it) => steps.push({ kind: 'fill', file: it.file, asset: it.asset }));
    plan.plain.forEach((f) => steps.push({ kind: 'new', file: f }));
    plan.dupNew.forEach((f) => steps.push({ kind: 'new', file: f }));
    if (conflictAction === 'overwrite') plan.conflicts.forEach((it) => steps.push({ kind: 'overwrite', file: it.file, asset: it.asset }));
    else if (conflictAction === 'merge') plan.conflicts.forEach((it) => steps.push({ kind: 'new', file: it.file }));
    // 'skip' → 冲突项不入 steps
    S.assetBusy = 'import'; S.assetMsg = '正在导入 ' + steps.length + ' 个文件…'; renderPanel();
    const stat = { fill: 0, new: 0, overwrite: 0, skip: conflictAction === 'skip' ? plan.conflicts.length : 0 };
    const errs = [];
    for (const st of steps) {
      try {
        if (st.kind === 'fill') await Api.replaceAsset(st.asset.id, st.file, st.asset.name);           // 补图：保留资产名
        else if (st.kind === 'overwrite') await Api.replaceAsset(st.asset.id, st.file, st.asset.name); // 覆盖：保留 id 与绑定
        else await Api.uploadAsset(st.file, type);
        stat[st.kind]++;
      } catch (e) { errs.push(st.file.name + '：' + errText(e)); }
    }
    S.assetBusy = null;
    const parts = [];
    if (stat.fill) parts.push('自动补图 ' + stat.fill);
    if (stat.new) parts.push('新增 ' + stat.new);
    if (stat.overwrite) parts.push('覆盖 ' + stat.overwrite);
    if (stat.skip) parts.push('跳过 ' + stat.skip);
    const summary = parts.join('，') || '无操作';
    S.assetMsg = '导入完成：' + summary + (errs.length ? '；失败 ' + errs.length + '：' + errs.join('；') : '');
    toast('导入完成：' + summary + (errs.length ? '，失败 ' + errs.length + ' 个' : ''), errs.length ? 'err' : 'ok');
    renderPanel();
    await loadAssets();
    await loadList({ skeleton: false });   // 同步表格槽位上的名称/缩略图
  }

  /* 批量删除素材：逐个调用删除接口，完成后退出批量模式 */
  async function deleteSelectedAssets() {
    if (!S.assetSel.size) { toast('请先勾选要删除的素材', 'err'); return; }
    const ids = Array.from(S.assetSel);
    if (!(await uiConfirm('批量删除素材', '确定删除已勾选的 ' + ids.length + ' 个素材？将同时解除所有分镜的绑定，且不可恢复。'))) return;
    S.assetBusy = 'del'; renderPanel();
    let okN = 0; const errs = [];
    try {
      for (const id of ids) {
        try { await Api.deleteAsset(id); okN++; S.assetSel.delete(id); }
        catch (e) { errs.push(id + '：' + errText(e)); }
      }
      toast('删除完成：成功 ' + okN + ' 个' + (errs.length ? '，失败 ' + errs.length + ' 个' : ''), errs.length ? 'err' : 'ok');
      S.assetSelMode = false;
      S.assetSel.clear();
    } finally { S.assetBusy = null; }
    renderPanel();
    await loadAssets();
  }

  async function loadAssets() {
    const target = S.bindTarget ? rowById(S.bindTarget.id) : null;
    try {
      const res = await Api.listAssets({
        projectId: Api.CFG.projectId,
        type: S.panelTab,
        keyword: S.panelKeyword || undefined,
        inShotId: target ? target.id : undefined
      });
      S.assets = res.library;
      S.assetCounts = res.counts;
    } catch (e) {
      S.assets = []; S.assetCounts = { currentShot: 0, library: 0 };
      fail(e);
    }
    renderPanel();
  }

  /* ---------------------------------------------------------- 状态栏 */
  function renderStatusbar() {
    const st = S.stats || {};
    const n = S.sel.size;
    const engName = '创作 CLI';
    const engOk = !!(S.adapter && S.adapter.dreamina && S.adapter.dreamina.available);
    $('#statusbar').innerHTML =
      (S.options && S.options.dryRun
        ? '<span class="drybadge" title="服务启动时带了 JC_DRY_RUN=1：所有提交都只组装命令、不派发">干跑模式</span><i class="sb-div"></i>'
        : '') +
      '<span>引擎 <b>' + engName + '</b>' + (engOk ? '' : '（未连接）') + '</span>' +
      '<i class="sb-div"></i>' +
      '<span>并发 <b>' + (S.settings ? S.settings.queue.concurrency : '—') + '</b></span>' +
      '<i class="sb-div"></i>' +
      '<span>已选 <b>' + n + '</b> 项</span>' +
      (n
        ? '<button class="btn-mini" data-batch="duration">批量改时长</button>' +
          '<button class="btn-mini" data-batch="reduration" title="读提示词里的「总时长：X.Xs」标注重算时长（小数向上进位）">按时长标注重算</button>' +
          '<button class="btn-mini" data-batch="delete">删除所选</button>' +
          '<button class="btn-mini" data-batch="clear">取消选择</button>'
        : '<button class="btn-mini" data-batch="reduration" title="不勾选时作用于全部「未提交」分镜：读「总时长：X.Xs」标注重算（小数向上进位）">按时长标注重算（全部）</button>') +
      '<span class="grow"></span>' +
      '<span>显示 <b>' + S.list.length + '</b> 条，共 <b>' + (st.total || 0) + '</b> 个分镜</span>' +
      '<i class="sb-div"></i>' +
      '<span>整体进度 <b>' + (st.overallProgress || 0) + '%</b></span>' +
      '<span class="minibar"><i style="width:' + (st.overallProgress || 0) + '%"></i></span>' +
      '<span>预计剩余 <b>' + mmss(st.etaSeconds) + '</b></span>';
  }

  /* ============================================================
     生成记录（全屏视图）
     ------------------------------------------------------------
     数据来源：后端在任务收尾时落的「快照」（records.js）——成功 / 失败 /
     取消 / 干跑各一条，分镜之后被改被删都不影响记录本身。
     本模块只做三件事：分页查询、按筛选条件重查、选中后拉详情。
     ============================================================ */
  const REC_ACTIONS = [
    { v: 'all', label: '全部' }, { v: 'generate', label: '真实生成' }, { v: 'dryrun', label: '干跑' }
  ];
  const REC_OUTCOMES = [
    { v: 'all', label: '全部结果' }, { v: 'succeeded', label: '成功' }, { v: 'failed', label: '失败' },
    { v: 'canceled', label: '已取消' }, { v: 'previewed', label: '仅预览' }
  ];
  const REC_COLS = [
    { key: 'time',  label: '时间',     cls: '' },
    { key: 'out',   label: '结果',     cls: '' },
    { key: 'eng',   label: '引擎',     cls: 'c-hide' },
    { key: 'sum',   label: '提示词摘要', cls: '' },
    { key: 'par',   label: '参数',     cls: 'c-hide' },
    { key: 'med',   label: '素材',     cls: 'c-hide' },
    { key: 'ela',   label: '耗时',     cls: 'c-hide' },
    { key: 'prod',  label: '产物',     cls: '' }
  ];

  const fmtElapsed = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');
  function fmtAt(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { d: '—', t: '' };
    return {
      d: pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
      t: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    };
  }
  /* 产物地址是后端相对路径（/files/…）：页面由后端托管时直接用，
     以 file:// 打开单文件版时补成绝对地址，否则点了会 404。 */
  function absUrl(u) {
    if (!u) return null;
    if (/^https?:/i.test(u)) return u;
    if (/^cli:/.test(u)) return null;
    const base = String(Api.CFG.baseUrl || '').replace(/\/api\/v1\/?$/, '');
    return base + u;
  }
  function recBadge(r) {
    if (r.action === 'dryrun') return '<span class="rec-badge dry">干跑</span>';
    if (r.outcome === 'succeeded') return '<span class="rec-badge ok">成功</span>';
    if (r.outcome === 'failed') return '<span class="rec-badge err">失败</span>';
    if (r.outcome === 'canceled') return '<span class="rec-badge warn">已取消</span>';
    return '<span class="rec-badge mute">' + esc(r.outcomeLabel || r.outcome || '—') + '</span>';
  }
  const recHasFilter = () => {
    const f = S.recF;
    return !!(f.action !== 'all' || f.outcome !== 'all' || f.engine !== 'all' || f.keyword || f.from || f.to);
  };
  /* 导出用：不带分页，只带筛选口径 */
  const recFilterQuery = () => ({
    action: S.recF.action, outcome: S.recF.outcome, engine: S.recF.engine,
    keyword: S.recF.keyword || undefined, from: S.recF.from || undefined, to: S.recF.to || undefined
  });

  function openRecords() {
    S.recSel = null; S.recDetail = null; S.rec.page = 1;
    const v = $('#recView');
    v.hidden = false; v.setAttribute('aria-hidden', 'false');
    stopPolling();                      // 记录页不轮询任务进度，省掉后台空转
    renderRecords();
    loadRecords(1);
    scheduleRecPoll();
  }
  function closeRecords() {
    const v = $('#recView');
    v.hidden = true; v.setAttribute('aria-hidden', 'true');
    $('#recDetail').classList.remove('on');
    stopRecPoll();
    ensurePolling();
  }
  /* 页面开着时缓慢自动刷新（8s）：任务在后台收尾后新记录会自己冒出来。
     两条纪律：① 详情打开时不刷（别把用户正在看的行抽走）；② 刷新后还原滚动位置。 */
  function stopRecPoll() { if (S.recPoll) { clearTimeout(S.recPoll); S.recPoll = null; } }
  function scheduleRecPoll() {
    stopRecPoll();
    S.recPoll = setTimeout(async () => {
      S.recPoll = null;
      if ($('#recView').hidden) return;
      if (!S.recSel) {
        const host = $('#recList');
        const top = host ? host.scrollTop : 0;
        await loadRecords(S.rec.page);
        const h2 = $('#recList');
        if (h2) h2.scrollTop = top;
      }
      scheduleRecPoll();
    }, 8000);
  }

  async function loadRecords(page) {
    if (page) S.rec.page = page;
    S.rec.loading = true;
    renderRecords();
    try {
      const res = await Api.listRecords(Object.assign({ page: S.rec.page, pageSize: S.rec.pageSize }, recFilterQuery()));
      S.rec.list = res.list || [];
      S.rec.total = res.total || 0;
      S.rec.page = res.page || 1;
      S.rec.pageCount = res.pageCount || 1;
      S.rec.stats = res.stats || null;
      S.rec.kept = res.kept || 0;
      S.rec.capacity = res.capacity || 0;
      // 翻页/改筛选后选中项可能已不在列表里：清掉选中，避免右侧挂着"看不见的那条"
      if (S.recSel && !S.rec.list.some((r) => r.id === S.recSel)) { S.recSel = null; S.recDetail = null; }
    } catch (e) {
      S.rec.list = []; S.rec.total = 0; S.rec.stats = null;
      fail(e);
    }
    S.rec.loading = false;
    renderRecords();
  }

  async function openRecordDetail(id) {
    S.recSel = id; S.recDetail = null; S.recDetailLoading = true;
    renderRecList(); renderRecDetail();
    try {
      S.recDetail = await Api.getRecord(id);
    } catch (e) { fail(e); S.recSel = null; }
    S.recDetailLoading = false;
    renderRecords();
  }

  function renderRecords() {
    const st = S.rec.stats || {};
    const act = (st.byAction || {});
    $('#recSummary').textContent = S.rec.loading && !S.rec.list.length
      ? '加载中…'
      : '匹配 ' + (S.rec.total || 0) + ' 条 · 库内 ' + (S.rec.kept || 0) + '/' + (S.rec.capacity || 0) +
        ' 条上限（成功 ' + (st.succeeded || 0) + ' · 失败 ' + (st.failed || 0) +
        ' · 已取消 ' + (st.canceled || 0) + ' · 干跑 ' + (act.dryrun || 0) + '）';
    renderRecBar();
    renderRecListHead();
    renderRecList();
    renderRecPager();
    renderRecDetail();
  }

  function renderRecBar() {
    const st = S.rec.stats || {};
    const act = st.byAction || {};
    const cntA = { all: st.total || 0, generate: act.generate || 0, dryrun: act.dryrun || 0 };
    const cntO = { all: st.total || 0, succeeded: st.succeeded || 0, failed: st.failed || 0, canceled: st.canceled || 0, previewed: st.previewed || 0 };
    const grp = (name, list, counts, cur) =>
      '<span class="rec-fgroup" data-fg="' + name + '">' + list.map((o) =>
        '<button data-f="' + name + '" data-v="' + o.v + '"' + (cur === o.v ? ' class="on"' : '') +
        (counts[o.v] ? '' : ' disabled') + '>' + esc(o.label) + '<i>' + (counts[o.v] || 0) + '</i></button>').join('') + '</span>';

    $('#recBar').innerHTML =
      '<span class="rec-filters">' +
        grp('action', REC_ACTIONS, cntA, S.recF.action) +
        grp('outcome', REC_OUTCOMES, cntO, S.recF.outcome) +
      '</span>' +
      '<label class="rec-search">' + I.search +
        '<input id="recKeyword" placeholder="搜索提示词 / 命令 / 错误 / 提交ID" value="' + esc(S.recF.keyword) + '" />' +
      '</label>' +
      (recHasFilter() ? '<button class="btn-mini" data-recact="resetf">重置筛选</button>' : '') +
      (act.dryrun ? '<button class="btn-mini" data-recact="cleardry" title="只删掉 action=干跑 的记录，真实生成记录保留">清理干跑记录（' + act.dryrun + '）</button>' : '') +
      '<span class="grow"></span>' +
      '<span class="hint-sm">时间</span>' +
      '<input type="date" class="input-sm rec-date" id="recFrom" value="' + esc(S.recF.from) + '" title="起始日期（含）" />' +
      '<span class="hint-sm">至</span>' +
      '<input type="date" class="input-sm rec-date" id="recTo" value="' + esc(S.recF.to) + '" title="结束日期（含）" />' +
      '<label class="hint-sm" style="display:inline-flex;align-items:center;gap:6px">每页 ' +
        '<select class="input-sm" id="recPageSize">' + [20, 50, 100].map((n) =>
          '<option value="' + n + '"' + (S.rec.pageSize === n ? ' selected' : '') + '>' + n + '</option>').join('') +
        '</select> 条</label>';
  }

  function renderRecListHead() {
    $('#recListHead').innerHTML = REC_COLS.map((c) =>
      '<span class="' + c.cls + '">' + esc(c.label) + '</span>').join('');
  }

  function renderRecList() {
    const host = $('#recList');
    if (S.rec.loading && !S.rec.list.length) {
      host.innerHTML = '<div class="empty-mini">加载中…</div>';
      return;
    }
    if (!S.rec.list.length) {
      host.innerHTML = '<div class="empty-mini">' +
        (recHasFilter() ? '没有符合筛选条件的记录' : '还没有生成记录<br/>提交（或干跑提交）后，任务收尾时会自动落一条记录') + '</div>';
      return;
    }
    host.innerHTML = S.rec.list.map((r) => {
      const t = fmtAt(r.at);
      const par = [r.ratio, r.resolution, (r.durationSec != null ? r.durationSec + 's' : null)].filter(Boolean).join(' · ');
      const med = '图' + (r.imageCount || 0) + (r.audioCount ? ' · 音' + r.audioCount : '');
      const abs = absUrl(r.videoUrl);
      let sub = '';
      if (r.outcome === 'failed') sub = '<span class="s2">' + esc(((r.errorCode || '') + ' ' + (r.shortError || '')).trim() || '失败') + '</span>';
      else if (r.action === 'dryrun') sub = '<span class="s2 mute">未发送给即梦，仅组装命令</span>';
      else if (r.outcome === 'canceled') sub = '<span class="s2 mute">已取消（即梦侧可能仍在跑）</span>';
      else if (abs) sub = '<span class="s2 mute">产物已就绪，可打开</span>';
      return '<div class="rec-row' + (S.recSel === r.id ? ' sel' : '') + '" data-rec="' + esc(r.id) + '">' +
        '<span class="rec-time"><b>' + t.d + '</b><span>' + t.t + '</span></span>' +
        '<span>' + recBadge(r) + '</span>' +
        '<span class="rec-cell c-hide">' + esc(r.engineLabel || '—') + '</span>' +
        '<span class="rec-sum"><span class="s1">镜头 ' + r.seq + ' · ' + esc(r.summary || '（无提示词）') + '</span>' + sub + '</span>' +
        '<span class="rec-cell c-hide">' + esc(par || '—') + '</span>' +
        '<span class="rec-cell c-hide">' + med + '</span>' +
        '<span class="rec-cell c-hide">' + fmtElapsed(r.elapsedMs) + '</span>' +
        (abs
          ? '<a class="rec-dl" data-dl="1" href="' + esc(abs) + '" target="_blank" rel="noopener" title="打开产物">↓</a>'
          : '<span class="rec-dl off" title="' + (r.action === 'dryrun' ? '干跑没有产物' : '没有可打开的产物文件') + '">—</span>') +
      '</div>';
    }).join('');
  }

  function renderRecPager() {
    const p = S.rec;
    const from = p.total ? (p.page - 1) * p.pageSize + 1 : 0;
    const to = Math.min(p.total, p.page * p.pageSize);
    $('#recPager').innerHTML =
      '<span>显示 <b>' + from + '–' + to + '</b> / 共 <b>' + p.total + '</b> 条</span>' +
      '<span class="grow"></span>' +
      '<button class="btn-mini" data-page="1"' + (p.page <= 1 ? ' disabled' : '') + '>首页</button>' +
      '<button class="btn-mini" data-page="prev"' + (p.page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span style="font-family:var(--mono);font-size:11.5px">第 ' + p.page + ' / ' + p.pageCount + ' 页</span>' +
      '<button class="btn-mini" data-page="next"' + (p.page >= p.pageCount ? ' disabled' : '') + '>下一页</button>' +
      '<button class="btn-mini" data-page="last"' + (p.page >= p.pageCount ? ' disabled' : '') + '>末页</button>';
  }

  function renderRecDetail() {
    const host = $('#recDetail');
    if (!host) return;
    const wide = window.innerWidth > 1180;
    host.classList.toggle('on', !wide && !!S.recSel);
    /* 注意：不能用 I.x —— 那是给深色素材卡片用的白色 ×，画在白底详情栏上等于隐形 */
    const closeBtn = '<button class="icon-btn rec-dclose" data-recact="closedetail" title="关闭详情">' + I.xDark + '</button>';

    if (!S.recSel) {
      host.innerHTML = '<div class="empty-mini">从左侧选一条记录<br/>查看完整提示词、素材图号与提交命令</div>';
      return;
    }
    if (S.recDetailLoading || !S.recDetail || S.recDetail.id !== S.recSel) {
      host.innerHTML = '<div class="empty-mini">加载详情…</div>';
      return;
    }
    const r = S.recDetail;
    const p = r.params || {};
    const t = fmtAt(r.at);
    const abs = absUrl(r.videoUrl);
    const paramTxt = [
      p.ratio, p.resolution,
      p.durationSec != null ? p.durationSec + 's' : null,
      p.motion != null ? 'motion ' + p.motion : null,
      p.seed ? 'seed ' + p.seed : null
    ].filter(Boolean).join(' · ');

    const banners = [];
    if (r.outcome === 'failed') banners.push('<div class="rec-banner err"><b>' + esc(r.errorCode || '失败') + '</b><br/>' + esc(r.errorMessage || '（无错误信息）') + '</div>');
    if (r.action === 'dryrun') banners.push('<div class="rec-banner info">干跑记录：命令由后端组装，<b>未发送给即梦</b>、未创建任务、未扣费。</div>');
    if (!r.storyboardExists) banners.push('<div class="rec-banner warn">原分镜已被删除 —— 本记录是提交当时的快照，仍然完整可读（记录与分镜分开存就是为了这个）。</div>');
    else if (r.currentEngine && r.currentEngine !== r.engine) banners.push('<div class="rec-banner warn">该分镜现在由<b>创作 CLI</b> 执行，与本记录的「' + esc(r.engineLabel) + '」不同 —— 记录是当时的真实事实，两者不一致属正常。</div>');

    const lockRows = (r.images || []).map((x) =>
      '<div class="r"><span class="n">图片' + x.n + '</span><span>' + esc(x.name) + '（' + esc(x.roleLabel || x.role || '') + '）</span></div>').join('')
      + (r.audios || []).map((x) =>
      '<div class="r"><span class="n aud">音频' + x.n + '</span><span>' + esc(x.name) + '</span></div>').join('');

    host.innerHTML =
      '<div class="rec-dhead">' +
        '<div class="rec-dtitle">' +
          '<h3>' + recBadge(r) + ' 镜头 ' + r.seq + '</h3>' +
          '<span class="sub">' + t.d + ' ' + t.t + ' · ' + esc(r.id) + '<br/>分镜 ' + esc(r.storyboardId) + (r.storyboardExists ? '' : '（已删除）') + '</span>' +
        '</div>' + closeBtn +
      '</div>' +
      banners.join('') +

      '<div class="rec-block"><h4>概览</h4><div class="rec-sect">' +
        '<dl class="rec-kv">' +
          '<dt>动作</dt><dd>' + esc(r.actionLabel || r.action) + ' · ' + esc(r.outcomeLabel || r.outcome) + '</dd>' +
          '<dt>引擎</dt><dd>' + esc(r.engineLabel) + (r.engineReason ? '（' + esc(r.engineReason) + '）' : '') + '</dd>' +
          '<dt>模型</dt><dd>' + esc(r.model) + (r.modelLabel && r.modelLabel !== r.model ? '（' + esc(r.modelLabel) + '）' : '') + '</dd>' +
          '<dt>CLI 型号</dt><dd>' + esc(r.cliModel || '—') + (r.mode ? ' · mode ' + esc(r.mode) : '') + '</dd>' +
          '<dt>参数</dt><dd>' + esc(paramTxt || '—') + '</dd>' +
          '<dt>耗时</dt><dd>' + fmtElapsed(r.elapsedMs) + (r.finishedAt ? '（完成于 ' + esc(String(r.finishedAt).slice(11, 19)) + '）' : '') + '</dd>' +
          (r.submitId ? '<dt>提交 ID</dt><dd>' + esc(r.submitId) + '</dd>' : '') +
          (r.resourceId ? '<dt>Resource</dt><dd>' + esc(r.resourceId) + '</dd>' : '') +
          (r.remoteId ? '<dt>远端 ID</dt><dd>' + esc(r.remoteId) + '</dd>' : '') +
          '<dt>重试次数</dt><dd>' + (r.retryCount || 0) + '</dd>' +
        '</dl>' +
        '<div class="rec-acts">' +
          (abs ? '<a class="btn-outline" href="' + esc(abs) + '" target="_blank" rel="noopener">打开产物</a>' : '') +
          '<button class="btn-mini" data-reccopy="prompt">复制提示词原文</button>' +
          (r.command ? '<button class="btn-mini" data-reccopy="cmd">复制提交命令</button>' : '') +
          (r.storyboardExists ? '<button class="btn-mini" data-recact="goto">跳到该分镜</button>' : '') +
          '<span class="grow"></span>' +
          '<button class="btn-mini btn-danger" data-recact="del">删除这条记录</button>' +
        '</div>' +
      '</div></div>' +

      ((r.images || []).length || (r.audios || []).length
        ? '<div class="rec-block"><h4>素材锁定（图号 = --image 顺序）</h4><div class="rec-sect"><div class="rec-lock">' + lockRows + '</div>' +
          ((r.skipped || []).length ? '<div class="rec-banner warn">未发出的绑定：' + (r.skipped || []).map((s) => esc(s.name) + '（' + esc(s.reason) + '）').join('、') + '</div>' : '') +
          '</div></div>'
        : '') +

      (r.adapted && r.adapted.length
        ? '<div class="rec-block"><h4>参数适配（后端按模型规格归一）</h4><div class="rec-sect"><div class="rec-note">' +
          r.adapted.map((x) => '· ' + esc(x)).join('<br/>') + '</div></div></div>' : '') +
      (r.missing && r.missing.length
        ? '<div class="rec-block"><h4>未找到对应 flag（已跳过）</h4><div class="rec-sect"><div class="rec-note">' + esc(r.missing.join(', ')) + '</div></div></div>' : '') +

      (r.command
        ? '<div class="rec-block"><h4>提交命令<span class="grow"></span><button class="btn-mini" data-reccopy="cmd">复制</button></h4>' +
          '<pre class="rec-pre cmd">' + esc(r.command) + '</pre></div>'
        : '') +

      '<div class="rec-block"><h4>提示词原文（' + (r.promptChars || 0) + ' 字）<span class="grow"></span>' +
        '<button class="btn-mini" data-reccopy="prompt">复制</button></h4>' +
        '<pre class="rec-pre">' + esc(r.prompt || '（空）') + '</pre></div>' +

      (r.promptWithLock && r.promptWithLock !== r.prompt
        ? '<div class="rec-block"><h4>实际发出的提示词（原文 + 素材锁定区块）<span class="grow"></span>' +
          '<button class="btn-mini" data-reccopy="promptlock">复制</button></h4>' +
          '<pre class="rec-pre">' + esc(r.promptWithLock) + '</pre></div>'
        : '') +

      '<div class="rec-note">记录在任务收尾时落盘，是一份<b>快照</b>：提示词、图号、参数、命令都取自当时，之后编辑分镜不会改写它。</div>';
  }

  /* ---- 生成记录：事件 ---- */
  async function doExportRecords() {
    const fmt = ($('#recFormat') || {}).value || 'md';
    try {
      const res = await Api.exportRecords(Object.assign({ format: fmt }, recFilterQuery()));
      if (!res || !res.content) { toast('没有可导出的记录', 'err'); return; }
      const blob = new Blob([res.content], { type: res.mime || 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = res.filename || ('生成记录.' + fmt);
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      toast('已导出 ' + res.filename, 'ok');
    } catch (e) { fail(e); }
  }
  async function doClearRecords(scope) {
    const n = scope === 'dryrun' ? ((S.rec.stats && S.rec.stats.byAction && S.rec.stats.byAction.dryrun) || 0) : S.rec.kept;
    const msg = scope === 'dryrun'
      ? '确定清理全部 ' + n + ' 条干跑记录？真实生成的记录会保留。'
      : '确定清空全部 ' + n + ' 条生成记录？记录是历史留痕，清空后无法恢复（分镜与素材不受影响）。';
    if (!(await uiConfirm(scope === 'dryrun' ? '清理干跑记录' : '清空生成记录', msg))) return;
    try {
      const res = await Api.clearRecords(scope === 'dryrun' ? { action: 'dryrun' } : { all: true });
      toast('已删除 ' + res.removed + ' 条记录', 'ok');
      S.recSel = null; S.recDetail = null;
      await loadRecords(1);
    } catch (e) { fail(e); }
  }
  async function doDeleteRecord() {
    const r = S.recDetail;
    if (!r) return;
    if (!(await uiConfirm('删除记录', '删除这条记录（' + r.id + '）？删除后无法恢复；对应的分镜不受影响。'))) return;
    try {
      await Api.deleteRecord(r.id);
      S.recSel = null; S.recDetail = null;
      toast('已删除该记录', 'ok');
      await loadRecords();
    } catch (e) { fail(e); }
  }
  function recCopy(what) {
    const r = S.recDetail;
    if (!r) return;
    if (what === 'prompt') copyText(r.prompt || '', '已复制提示词原文（' + (r.promptChars || 0) + ' 字）');
    else if (what === 'promptlock') copyText(r.promptWithLock || '', '已复制实际发出的提示词');
    else if (what === 'cmd') copyText(r.command || '', '已复制提交命令');
  }

  function bindRecords() {
    $('#recBack').addEventListener('click', closeRecords);
    $('#recRefresh').addEventListener('click', () => loadRecords(S.rec.page));
    $('#recExport').addEventListener('click', doExportRecords);
    $('#recClear').addEventListener('click', () => doClearRecords('all'));
    $('#recFormat').addEventListener('change', () => toast('导出格式：' + $('#recFormat').selectedOptions[0].textContent));

    // 筛选条：分段筛选 / 搜索 / 日期 / 每页条数
    $('#recBar').addEventListener('click', (e) => {
      const f = e.target.closest('button[data-f]');
      if (f) {
        S.recF[f.dataset.f] = f.dataset.v;
        loadRecords(1);
        return;
      }
      const act = e.target.closest('[data-recact]');
      if (act) {
        const k = act.dataset.recact;
        if (k === 'resetf') { S.recF = { action: 'all', outcome: 'all', engine: 'all', keyword: '', from: '', to: '' }; loadRecords(1); return; }
        if (k === 'cleardry') { doClearRecords('dryrun'); return; }
      }
    });
    $('#recBar').addEventListener('change', (e) => {
      if (e.target.id === 'recPageSize') { S.rec.pageSize = Number(e.target.value) || 20; loadRecords(1); return; }
      if (e.target.id === 'recFrom') { S.recF.from = e.target.value; loadRecords(1); return; }
      if (e.target.id === 'recTo') { S.recF.to = e.target.value; loadRecords(1); return; }
    });
    $('#recBar').addEventListener('input', (e) => {
      if (e.target.id !== 'recKeyword') return;
      S.recF.keyword = e.target.value;
      clearTimeout(S.recTimer);
      S.recTimer = setTimeout(() => loadRecords(1), 300);
    });

    // 列表：点行选中；产物链接不触发选中
    $('#recList').addEventListener('click', (e) => {
      if (e.target.closest('[data-dl]')) return;
      const row = e.target.closest('[data-rec]');
      if (!row) return;
      // 再点一次同一行：窄屏下详情是抽屉，可能已被 Esc 关掉 → 重绘把它重新滑出
      if (S.recSel === row.dataset.rec) { renderRecDetail(); return; }
      openRecordDetail(row.dataset.rec);
    });
    $('#recPager').addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]'); if (!b || b.disabled) return;
      const p = b.dataset.page;
      const to = p === 'prev' ? S.rec.page - 1 : p === 'next' ? S.rec.page + 1 : p === 'last' ? S.rec.pageCount : 1;
      loadRecords(Math.max(1, Math.min(S.rec.pageCount, to)));
    });
    // 详情栏内的按钮
    $('#recDetail').addEventListener('click', (e) => {
      const act = e.target.closest('[data-recact]');
      if (act) {
        const k = act.dataset.recact;
        if (k === 'del') { doDeleteRecord(); return; }
        if (k === 'goto') {
          const id = S.recDetail && S.recDetail.storyboardId;
          closeRecords();
          if (id) { S.sel.clear(); S.sel.add(id); renderStatusbar(); loadList({ skeleton: false }); }
          return;
        }
        if (k === 'closedetail') { S.recSel = null; S.recDetail = null; renderRecList(); renderRecDetail(); return; }
      }
      const cp = e.target.closest('[data-reccopy]');
      if (cp) recCopy(cp.dataset.reccopy);
    });
    // 窄屏切宽屏时，把抽屉态的详情收回来（避免残留 transform）
    window.addEventListener('resize', () => { if (!$('#recView').hidden) renderRecDetail(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#recView').hidden) {
        // Esc 优先关详情抽屉，再关整个记录页
        if (S.recSel && window.innerWidth <= 1180) { S.recSel = null; S.recDetail = null; renderRecList(); renderRecDetail(); return; }
        closeRecords();
      }
    });
  }

  function render() { renderTopbar(); renderTable(); renderPanel(); renderStatusbar(); }

  /* 素材面板窄屏抽屉化（模块层助手）：
     ≤1180px 时面板 fixed 在屏外（见 styles.css 主界面响应式段），须手动唤起/关闭。
     宽屏面板常驻，matchMedia 不命中 → 两个函数都是空操作，行为与改造前完全一致。 */
  function openPanelIfOverlay() {
    if (!window.matchMedia('(max-width:1180px)').matches) return;
    $('#panel').classList.add('open');
    $('#panelMask').hidden = false;
  }
  function closePanelIfOverlay() {
    $('#panel').classList.remove('open');
    $('#panelMask').hidden = true;
  }
  function renderRowsOnly() {
    // 轮询只改进度/状态时，避免整表重绘导致 hover 抖动
    $$('#table .row').forEach((el) => {
      const s = rowById(el.dataset.id);
      if (!s) return;
      const bar = $('.bar > i', el);
      if (bar) { bar.style.width = Math.round(s.progress) + '%'; bar.className = s.status === 'succeeded' ? 'ok' : (s.status === 'failed' ? 'err' : ''); }
      const pct = $('.pct', el);
      if (pct) pct.textContent = Math.round(s.progress) + '%';
      const badge = $('.badge', el);
      if (badge) { badge.className = 'badge ' + s.status; badge.textContent = STATUS_TEXT[s.status]; }
      const cbx = $('.cbx', el);
      if (cbx) cbx.classList.toggle('on', S.sel.has(s.id));
      el.classList.toggle('sel', S.sel.has(s.id));
    });
    renderStatusbar();
    renderTopbar();
    updateCheckAll();
  }

  /* ---------------------------------------------------------- 数据加载 */
  async function loadList(opts2) {
    opts2 = opts2 || {};
    if (opts2.skeleton !== false) { S.loading = true; S.error = null; renderTable(); }
    try {
      const res = await Api.listStoryboards({
        page: S.page, pageSize: S.pageSize,
        status: S.filter === 'all' ? undefined : S.filter,
        keyword: S.keyword || undefined,
        sort: 'seq:asc'
      });
      S.list = res.list;
      S.stats = res.stats;
      S.error = null;
    } catch (e) {
      S.error = e;
    } finally {
      S.loading = false;
      render();
      ensurePolling();
    }
  }

  async function loadMeta() {
    try {
      const [o, st, ad] = await Promise.all([Api.getOptions(), Api.getSettings(), Api.getAdapter()]);
      S.options = o; S.settings = st; S.adapter = ad;
    } catch (e) { fail(e); }
  }

  /* ---------------------------------------------------------- 轮询 */
  function activeIds() {
    return S.list.filter((s) => s.status === 'generating' || s.status === 'queued').map((s) => s.id);
  }
  const POLL_BASE = () => 3000;   // 契约：基线 3s，无变化退避至 10s 封顶

  function stopPolling() { if (S.poll.timer) { clearTimeout(S.poll.timer); S.poll.timer = null; } }
  function ensurePolling() {
    if (S.poll.timer) return;
    if (document.hidden) return;
    if (!activeIds().length) return;
    S.poll.idle = 0;
    pollOnce();
  }

  async function pollOnce() {
    S.poll.timer = null;
    const ids = activeIds();
    if (!ids.length) return;                       // 全部终态 → 停止轮询

    const base = POLL_BASE();
    let delay = base;
    try {
      const changed = await Api.getProgress(ids.slice(0, 50));
      if (!changed.length) {
        // 无变化 → 退避：3s → 6s → 10s 封顶
        S.poll.idle++;
        if (S.poll.idle >= 3) delay = Math.min(10000, base * Math.pow(2, S.poll.idle - 2));
      } else {
        S.poll.idle = 0;
        let terminal = false;
        changed.forEach((c) => {
          const s = rowById(c.id);
          if (!s) return;
          const wasActive = s.status === 'generating' || s.status === 'queued';
          Object.assign(s, c);
          s.grad = s.grad || Api.grad(s.id);
          if (wasActive && c.status !== 'generating' && c.status !== 'queued') terminal = true;
        });
        renderRowsOnly();
        if (terminal) await loadList({ skeleton: false });   // 收口时以服务端统计为准
      }
    } catch (e) {
      S.poll.idle++;
      delay = Math.min(30000, base * Math.pow(2, S.poll.idle));   // 429 / 网络异常 → 指数退避，不打扰用户
      if (!e || e.code !== Api.ERR.RATELIMIT) fail(e);
    }
    if (activeIds().length && !document.hidden) S.poll.timer = setTimeout(pollOnce, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();            // 页面隐藏暂停
    else ensurePolling();                          // 恢复时立即拉一次
  });

  /* ---------------------------------------------------------- 行内交互 */
  document.addEventListener('click', async (ev) => {
    const t = ev.target;

    /* 关闭下拉 */
    if (!t.closest('.menu') && !t.closest('[data-val]')) closeMenu();

    /* ---- 素材面板 ---- */
    // 卡片右上角的删除钮必须先于卡片点击处理，否则会被卡片处理器吞掉
    const assetDel = t.closest('[data-assetdel]');
    if (assetDel) { await onAssetDelete(assetDel.dataset.assetdel); return; }
    const assetEl = t.closest('[data-asset]');
    if (assetEl) { await onAssetClick(assetEl.dataset.asset); return; }
    const tabEl = t.closest('[data-tab]');
    if (tabEl) { S.panelTab = tabEl.dataset.tab; S.panelKeyword = ''; await loadAssets(); return; }

    /* ---- 表格行 ---- */
    const rowEl = t.closest('.row');
    if (!rowEl) return;
    const s = rowById(rowEl.dataset.id);
    if (!s) return;

    if (t.closest('[data-check]')) { S.sel.has(s.id) ? S.sel.delete(s.id) : S.sel.add(s.id); renderTable(); renderPanel(); renderStatusbar(); return; }

    const step = t.closest('[data-step]');
    if (step) { stepDuration(s, Number(step.dataset.step)); return; }

    if (t.closest('[data-val]')) { openPresetMenu(t.closest('.dur'), s); return; }

    const bind = t.closest('[data-bind]');
    if (bind) {
      S.bindTarget = { id: s.id, role: bind.dataset.bind };
      S.panelTab = ROLE_META[bind.dataset.bind].type;
      S.panelKeyword = '';
      toast('请从右侧「素材库全部」点选要添加的' + ROLE_META[bind.dataset.bind].label);
      await loadAssets();
      openPanelIfOverlay();   // 窄屏面板在屏外：点「＋」后必须主动唤起，否则无处点选
      return;
    }
    const unb = t.closest('[data-unbind]');
    if (unb) { await unbind(s, unb.dataset.unbind); return; }

    if (t.closest('[data-preview]')) { openDetail(s, true); return; }

    const act = t.closest('[data-act]');
    if (act) await onRowAction(s, act.dataset.act);
  });

  document.addEventListener('dblclick', (ev) => {
    const v = ev.target.closest('[data-val]');
    if (!v) return;
    const rowEl = v.closest('.row');
    const s = rowById(rowEl.dataset.id);
    closeMenu();
    startInlineEdit(v, s);
  });

  /* ---------------------------------------------------------- 时长 */
  const patchTimers = {};
  function stepDuration(s, delta) {
    const d = opts().duration;
    const next = Math.max(d.min, Math.min(d.max, s.durationSec + delta));
    if (next === s.durationSec) return;
    const prev = s.durationSec;
    s.durationSec = next;                       // 乐观更新
    renderRowsDur(s);
    clearTimeout(patchTimers[s.id]);
    patchTimers[s.id] = setTimeout(async () => {
      try {
        const fresh = await Api.patchStoryboard(s.id, { durationSec: s.durationSec });
        Object.assign(s, fresh);
        renderRowsDur(s);
      } catch (e) {
        s.durationSec = prev;                   // 回滚
        renderRowsDur(s);
        fail(e);
      }
    }, 300);                                    // 与文档一致：300ms 合并提交
  }
  function renderRowsDur(s) {
    const el = $('#table .row[data-id="' + s.id + '"]');
    if (!el) return;
    const box = $('.titleline', el);
    if (box) box.innerHTML = '<span class="shotno">分镜 ' + s.seq + '</span>' + durHTML(s);
    renderStatusbar();
  }
  function startInlineEdit(valEl, s) {
    const d = opts().duration;
    const cur = s.durationSec;
    valEl.innerHTML = '<input type="text" value="' + cur + '" />';
    const input = $('input', valEl);
    valEl.closest('.dur').classList.add('focus');
    input.focus(); input.select();
    const commit = async (ok) => {
      const dur = valEl.closest('.dur');
      if (ok) {
        const v = Math.max(d.min, Math.min(d.max, parseInt(input.value, 10) || cur));
        if (v !== cur) {
          const prev = cur;
          s.durationSec = v; renderRowsDur(s);
          try { Object.assign(s, await Api.patchStoryboard(s.id, { durationSec: v })); }
          catch (e) { s.durationSec = prev; fail(e); }
        }
      }
      dur.classList.remove('focus');
      renderRowsDur(s);
    };
    input.addEventListener('keydown', (e2) => {
      if (e2.key === 'Enter') commit(true);
      if (e2.key === 'Escape') commit(false);
      e2.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }

  /* ---------------------------------------------------------- 预设菜单 */
  function closeMenu() { const m = $('.menu'); if (m) m.remove(); }
  function openPresetMenu(durEl, s) {
    closeMenu();
    const d = opts().duration;
    const r = durEl.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = d.presets.map((p) =>
      '<button data-preset="' + p + '" class="' + (p === s.durationSec ? 'on' : '') + '">' + p + 's' +
      (p === s.durationSec ? '<span class="tick">' + I.tickSm + '</span>' : '') + '</button>').join('') +
      '<button data-custom="1">自定义秒数…</button>';
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    document.body.appendChild(menu);
    menu.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-preset]');
      const c = e.target.closest('[data-custom]');
      if (p) {
        closeMenu();
        const v = Number(p.dataset.preset);
        const prev = s.durationSec; s.durationSec = v; renderRowsDur(s);
        try { Object.assign(s, await Api.patchStoryboard(s.id, { durationSec: v })); renderRowsDur(s); }
        catch (err) { s.durationSec = prev; renderRowsDur(s); fail(err); }
      } else if (c) {
        closeMenu();
        startInlineEdit($('[data-val]', durEl), s);
      }
    });
  }

  /* ---------------------------------------------------------- 行操作 */
  async function onRowAction(s, act) {
    if (S.busy) return;
    try {
      if (act === 'up' || act === 'down') {
        await Api.reorder(s.id, act);
        await loadList({ skeleton: false });
        return;
      }
      if (act === 'cancel') {
        Object.assign(s, await Api.cancel(s.id));
        toast('已取消分镜 ' + s.seq);
        renderRowsOnly(); ensurePolling(); await loadList({ skeleton: false });
        return;
      }
      if (act === 'retry') {
        Object.assign(s, await Api.retry(s.id));
        toast('已重新排队', 'ok');
        render(); ensurePolling();
        return;
      }
      if (act === 'detail') { openDetail(s, false); return; }
      if (act === 'del') {
        if (!(await uiConfirm('删除分镜 ' + s.seq, '此操作不可撤销。'))) return;
        S.busy = true;
        try {
          await Api.batchDelete([s.id], true);
          S.sel.delete(s.id);
          toast('已删除');
          await loadList({ skeleton: false });
        } finally { S.busy = false; }
        return;
      }
    } catch (e) { fail(e); }
  }

  async function unbind(s, assetId) {
    try {
      await Api.unbindAsset(s.id, assetId);
      s.assets = s.assets.filter((a) => a.assetId !== assetId);
      renderTable(); await loadAssets();
      toast('已移除素材');
    } catch (e) { fail(e); }
  }

  /* 素材设置弹层：改名 / 更换文件（更换保留素材 id 与全部分镜绑定） */
  /* ---------------------------------------------------------- 全屏预览查看器 */
  /* 素材详情弹窗的图片全屏展示：原图直出、object-fit:contain 适配任意屏幕。
     退出方式：右上角关闭按钮 / ESC / 点击图片外空白区域。
     ESC 监听挂在捕获阶段并 stopPropagation——避免同一按键把底下的详情弹窗也关掉。 */
  function openFullscreenViewer(url, alt) {
    const v = document.createElement('div');
    v.className = 'fs-viewer';
    v.style.zIndex = 300;
    v.innerHTML =
      '<img src="' + esc(url) + '" alt="' + esc(alt || '') + '" />' +
      '<button class="fs-close" title="退出全屏 (Esc)">' + I.x + '</button>' +
      '<span class="fs-hint">按 Esc、点击空白处或右上角 × 退出全屏</span>';
    document.body.appendChild(v);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      v.remove();
    };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();            // 只消费这一次 ESC，别穿透到底下的详情弹窗
      close();
    };
    document.addEventListener('keydown', onKey, true);
    v.querySelector('.fs-close').addEventListener('click', close);
    v.addEventListener('click', (ev) => { if (ev.target === v) close(); });
    requestAnimationFrame(() => v.classList.add('on'));   // 下一帧再加 on，保证淡入动画生效
    return close;
  }

  function openAssetSettings(asset) {
    return new Promise((resolve) => {
      const accept = asset.type === 'audio' ? 'audio/*' : 'image/*';
      // 图片用真实 <img> + object-fit:contain 完整展示（原用 background-size:cover 会裁掉四周）
      const hasPic = !!asset.url && asset.type !== 'audio';
      const previewHTML = (asset.type === 'audio')
        ? '<span class="note">' + I.note + '</span>'
        : (asset.url ? '<img id="asPreviewImg" src="' + esc(asset.url) + '" alt="' + esc(asset.name) + '" />' : '');
      const kindLabel = { character: '角色', scene: '场景', prop: '道具', audio: '音频' }[asset.type] || asset.type;
      // 提示词编辑区：音频无提示词概念，不展示
      const isAudio = asset.type === 'audio';
      const promptVal = asset.prompt || '';
      // 全屏预览按钮：仅当有真实图片可看时出现；悬停预览区淡入（样式见 .fs-btn）
      // 图片上的悬浮操作钮：全屏 + 更换文件（与下方「更换文件」按钮同源，都触发同一个 #asFile）
      const fsBtn = hasPic
        ? '<button class="fs-btn" id="asFull" title="全屏预览（查看细节）">' + I.expand + '</button>' +
          '<button class="fs-btn pick" id="asPicPick" title="更换图片文件">' + I.swap + '</button>'
        : '';
      const promptHTML = isAudio ? '' :
        '<div class="sec-title" style="margin-top:12px">文生图提示词</div>' +
        '<div class="asset-promptwrap">' +
          '<textarea id="asPrompt" class="asset-prompt" placeholder="该资产的文生图提示词。可粘贴整段（含风格要求、反向提示词），生成图后仍可回来修改。" maxlength="10000">' + esc(promptVal) + '</textarea>' +
          '<span class="hint-sm" id="asPromptCount">' + promptVal.length + ' / 10000</span>' +
        '</div>';
      const mask = document.createElement('div');
      mask.className = 'mask'; mask.style.zIndex = 200;
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>素材详情</h2><span class="grow"></span>' +
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            '<div class="asset-preview' + (isAudio ? ' audio' : '') + '"' +
              (!hasPic && !isAudio ? ' style="--g:' + asset.grad + ';background-image:var(--g)"' : (isAudio ? ' style="--g:' + asset.grad + ';background-image:var(--g)"' : '')) + '>' +
              previewHTML +
              fsBtn +
              (!hasPic && !isAudio ? '<span class="empty-ph">尚未上传图片<br/><small>下方「更换文件」可补图</small></span>' : '') +
            '</div>' +
            '<div class="row-inline"><span class="label-sm">名称</span>' +
              '<input class="input-sm" id="asName" style="flex:1;min-width:0" maxlength="60" value="' + esc(asset.name) + '" /></div>' +
            (isAudio ? '' : '<div class="row-inline"><span class="label-sm">类型</span><span class="hint-sm">' + esc(kindLabel) + '</span></div>') +
            promptHTML +
            /* 更换入口已悬浮在图片上（.fs-btn.pick），有图时下方不再重复；
               仅无图（提示词占位 / 音频）保留此行作为补图 / 换文件入口 */
            (hasPic ? '' :
              '<div class="row-inline" style="margin-top:12px"><span class="label-sm">素材文件</span>' +
              '<button class="btn-mini" id="asPick">更换文件</button></div>') +
            '<input type="file" id="asFile" accept="' + accept + '" hidden />' +
          '</div>' +
          '<div class="modal-foot">' +
            '<span class="hint-sm" id="asFileHint"></span><span class="grow"></span>' +
            '<button class="btn-outline" data-cancel>取消</button>' +
            '<button class="btn-primary" data-ok>保存</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);

      let picked = null;
      let previewBlobUrl = null;                  // 本地即时预览用的 blob URL（关闭弹窗时回收）
      /* 选中文件后立即本地预览：不等保存。此前 change 只更新 picked 与提示文字，
         预览区是打开弹窗时一次性渲染的静态 HTML，状态变了视图没跟着更新 ——
         表现为"图片要等点确定之后才换"。保存逻辑不受影响（仍上传 picked 原文件）。 */
      function showLocalPreview(f) {
        if (isAudio) return;                      // 音频无图片预览概念
        let img = mask.querySelector('#asPreviewImg');
        if (!img) {                               // 无图资产补图：占位符让位，动态插入预览图
          const ph = mask.querySelector('.empty-ph');
          if (ph) ph.style.display = 'none';
          img = document.createElement('img');
          img.id = 'asPreviewImg';
          img.alt = asset.name;
          mask.querySelector('.asset-preview').appendChild(img);
        }
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = URL.createObjectURL(f);
        img.src = previewBlobUrl;
      }
      const nameEl = mask.querySelector('#asName');
      const promptEl = mask.querySelector('#asPrompt');
      if (promptEl) {
        promptEl.addEventListener('input', () => {
          mask.querySelector('#asPromptCount').textContent = promptEl.value.length + ' / 10000';
        });
      }
      const pickRow = mask.querySelector('#asPick');
      if (pickRow) pickRow.addEventListener('click', () => mask.querySelector('#asFile').click());
      const fsEl = mask.querySelector('#asFull');
      if (fsEl) fsEl.addEventListener('click', () => openFullscreenViewer(asset.url, asset.name));
      const pickEl = mask.querySelector('#asPicPick');
      if (pickEl) pickEl.addEventListener('click', () => mask.querySelector('#asFile').click());
      mask.querySelector('#asFile').addEventListener('change', (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;                            // 取消选择：picked 保持原状，无需恢复
        picked = f;
        showLocalPreview(f);                       // 选完立即看到新图
        mask.querySelector('#asFileHint').textContent = '将替换为 ' + f.name;
        const base = f.name.replace(/\.[^.]+$/, '');
        // 仅当名称为空时补默认名；已有名称（含原资产名）不动 —— 换图不应悄悄改资产名
        if (!nameEl.value.trim()) nameEl.value = base;
        ev.target.value = '';
      });
      const done = (v) => {
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);   // 回收本地预览资源
        mask.remove(); resolve(v);
      };
      mask.querySelector('[data-ok]').addEventListener('click', () => {
        const name = String(nameEl.value || '').trim();
        if (!name) { toast('素材名称不能为空', 'err'); nameEl.focus(); return; }
        const prompt = promptEl ? String(promptEl.value || '').trim() : undefined;
        done({ name: name, prompt: prompt, file: picked });
      });
      mask.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      mask.querySelector('[data-x]').addEventListener('click', () => done(null));
      mask.addEventListener('click', (ev) => { if (ev.target === mask) done(null); });
      document.addEventListener('keydown', function escAs(ev) {
        if (ev.key !== 'Escape') return;
        document.removeEventListener('keydown', escAs); done(null);
      });
      nameEl.focus(); nameEl.select();
    });
  }

  /* 打开素材详情并落库（改名 / 改提示词 / 换文件） */
  async function editAsset(assetId) {
    const a = S.assets.find((x) => x.id === assetId);
    if (!a) return;
    const r = await openAssetSettings(a);
    if (!r) return;
    const oldPrompt = a.prompt || '';
    const promptChanged = r.prompt !== undefined && r.prompt !== oldPrompt;
    if (!r.file && r.name === a.name && !promptChanged) { toast('未做任何修改', 'ok'); return; }
    try {
      if (r.file) await Api.replaceAsset(a.id, r.file, r.name);
      // 名称/提示词有变化才 PATCH（file 分支已带上 name，这里只补提示词或未换文件的场景）
      if (!r.file && (r.name !== a.name || promptChanged)) {
        await Api.updateAsset(a.id, { name: r.name, prompt: r.prompt });
      } else if (r.file && promptChanged) {
        await Api.updateAsset(a.id, { prompt: r.prompt });
      }
      toast('素材已更新', 'ok');
      await loadAssets();
      await loadList({ skeleton: false });   // 同步表格槽位上的名称/缩略图
    } catch (e) { fail(e); }
  }

  /* ---------------------------------------------------------- 导入资产（双模式弹窗） */
  /* 模式一：导入本地图片/音频文件（按当前面板 tab 的类型上传，可多选）；
     模式二：粘贴提示词文本 → 后端按「@ 分段」自动识别 场景/道具/角色 → 预览 → 确认导入。
     提示词模式创建的资产暂无图片（渐变占位），点开详情弹窗可补图与编辑提示词。 */
  function openAssetImport() {
    const isAudioTab = S.panelTab === 'audio';
    let mode = 'file';                        // 'file' | 'text' | 'conflict'
    let pickedFiles = [];                     // 文件模式待传清单
    let parsed = null;                        // 文本模式解析结果
    let importPlan = null;                    // 文件模式匹配计划（conflict 视图暂存）
    let conflictAction = 'merge';             // 冲突处理默认「两者并存」（最安全，不破坏原图）
    let busy = false;
    const typeLabel = { character: '角色', scene: '场景', prop: '道具', audio: '音频' };
    const tabLabel = { character: '角色', scene: '场景', prop: '道具', audio: '音频' };

    const mask = document.createElement('div');
    mask.className = 'mask'; mask.style.zIndex = 200;
    document.body.appendChild(mask);

    function render() {
      const filePane =
        '<div class="imp-pane">' +
          '<div class="hint-sm" style="margin-bottom:8px">选择一个或多个本地' + (isAudioTab ? '音频' : '图片') + '文件，导入到「' + tabLabel[S.panelTab] + '」分类。文件名（忽略扩展名、首尾空格，大小写不敏感）与资产名一致时：<b>无图资产自动补图</b>；<b>已有图资产会先询问</b>你覆盖 / 跳过 / 并存。</div>' +
          '<button class="btn-mini" id="impPick"' + (busy ? ' disabled' : '') + '>选择文件…</button>' +
          '<input type="file" id="impFile" accept="' + (isAudioTab ? 'audio/*' : 'image/*') + '" multiple hidden />' +
          (pickedFiles.length
            ? '<div class="imp-files">' + pickedFiles.map((f, i) =>
                '<div class="imp-file"><span class="nm">' + esc(f.name) + '</span><span class="hint-sm">' + Math.max(1, Math.round(f.size / 1024)) + ' KB</span>' +
                '<button class="rm-mini" data-rmfile="' + i + '" title="移除">×</button></div>').join('') + '</div>'
            : '<div class="empty-mini" style="margin-top:8px">尚未选择文件</div>') +
        '</div>';
      const textPane = isAudioTab ? '' :
        '<div class="imp-pane">' +
          '<div class="hint-sm" style="margin-bottom:8px">粘贴多段文生图提示词，段与段之间用<b>单独一行的 @</b> 分隔。系统自动识别每段的资产类型（场景 / 道具 / 角色）与名称，并按类型归类导入。</div>' +
          '<textarea id="impText" class="asset-prompt tall" placeholder="角色描述信息如下：林晚…&#10;@&#10;按照下方场景描述内容生成…&#10;@&#10;根据道具描述内容生成…" spellcheck="false"></textarea>' +
          '<div class="row-inline" style="margin-top:8px">' +
            '<button class="btn-mini" id="impParse"' + (busy ? ' disabled' : '') + '>解析预览</button>' +
            '<span class="hint-sm" id="impParseHint">' + (parsed ? '识别 ' + parsed.items.length + ' 段' + (parsed.skipped.length ? '，未识别 ' + parsed.skipped.length + ' 段' : '') : '粘贴后先解析，再确认导入') + '</span>' +
          '</div>' +
          (parsed ? renderParseResult(parsed) : '') +
        '</div>';
      const conflictPane = (mode === 'conflict' && importPlan) ? renderConflictPane() : '';
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>' + (mode === 'conflict' ? '导入资产 · 名称冲突' : '导入资产') + '</h2><span class="grow"></span>' +
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            (mode !== 'file' ? '' :
              '<div class="seg" style="margin-bottom:12px">' +
                '<button id="impModeFile"' + (mode === 'file' ? ' class="on"' : '') + '>导入图片文件</button>' +
                '<button id="impModeText"' + (mode === 'text' ? ' class="on"' : '') + '>导入提示词文本</button>' +
              '</div>') +
            (mode === 'file' ? filePane : (mode === 'conflict' ? conflictPane : textPane)) +
          '</div>' +
          '<div class="modal-foot">' +
            '<span class="hint-sm" id="impFootHint"></span><span class="grow"></span>' +
            (mode === 'conflict'
              ? '<button class="btn-outline" id="impBack">返回修改</button>' +
                '<button class="btn-primary" id="impDoConflict">确认导入</button>'
              : '<button class="btn-outline" data-cancel>取消</button>' +
                (mode === 'file'
                  ? '<button class="btn-primary" id="impDoFiles"' + (busy || !pickedFiles.length ? ' disabled' : '') + '>导入 ' + pickedFiles.length + ' 个文件</button>'
                  : '<button class="btn-primary" id="impDoText"' + (busy || !parsed || !parsed.items.length ? ' disabled' : '') + '>' + (parsed && parsed.items.length ? '确认导入 ' + parsed.items.length + ' 个资产' : '确认导入') + '</button>')) +
          '</div>' +
        '</div>';
      bind();
    }

    /* 冲突处理视图：列出「文件名 ↔ 已有图资产」的冲突项，三选一决策。
       其余文件（补图 / 正常新增 / 批次内同名并存）不受影响，只在此说明去向。 */
    function renderConflictPane() {
      const c = importPlan.conflicts;
      const rows = c.map((it) =>
        '<div class="parse-item warn"><span class="type-badge b-conf">冲突</span>' +
        '<span class="nm">' + esc(fileBaseName(it.file)) + '</span>' +
        '<span class="hint-sm">→ 资产「' + esc(it.asset.name) + '」已有图片</span></div>').join('');
      const notes = [];
      if (importPlan.autoFill.length) notes.push('<div class="hint-sm">' + importPlan.autoFill.length + ' 个文件将自动补入同名无图资产，无需处理。</div>');
      if (importPlan.plain.length) notes.push('<div class="hint-sm">' + importPlan.plain.length + ' 个文件无同名匹配，将正常新增。</div>');
      if (importPlan.dupNew.length) notes.push('<div class="hint-sm">另有 ' + importPlan.dupNew.length + ' 个批次内同名文件，将自动并存入库（不参与本选择）。</div>');
      return '<div class="imp-pane">' +
        '<div class="hint-sm" style="margin-bottom:6px">匹配规则：文件名（忽略扩展名与首尾空格，大小写不敏感）与资产名一致。以下文件与已有图片的资产同名，请选择处理方式：</div>' +
        '<div class="imp-parse">' + rows + '</div>' +
        '<div class="imp-choice">' +
          '<label class="checkline"><input type="radio" name="impAct" value="overwrite"' + (conflictAction === 'overwrite' ? ' checked' : '') + ' /> 覆盖原有图片（保留该资产与全部分镜绑定，替换图片）</label>' +
          '<label class="checkline"><input type="radio" name="impAct" value="skip"' + (conflictAction === 'skip' ? ' checked' : '') + ' /> 跳过该图片（不导入，原图不动）</label>' +
          '<label class="checkline"><input type="radio" name="impAct" value="merge"' + (conflictAction === 'merge' ? ' checked' : '') + ' /> 两者并存（保留原图，另存为新资产）</label>' +
        '</div>' +
        notes.join('') +
      '</div>';
    }

    function renderParseResult(p) {
      const TYPE_CLS = { character: 'b-char', scene: 'b-scene', prop: 'b-prop' };
      const rows = p.items.map((it) =>
        '<div class="parse-item"><span class="type-badge ' + TYPE_CLS[it.type] + '">' + typeLabel[it.type] + '</span>' +
        '<span class="nm">' + esc(it.name) + '</span><span class="hint-sm">' + it.chars + ' 字</span></div>').join('');
      const skips = p.skipped.map((sk) =>
        '<div class="parse-item bad" title="' + esc(sk.preview || '') + '"><span class="type-badge b-skip">跳过</span>' +
        '<span class="nm">第 ' + sk.index + ' 段</span><span class="hint-sm">' + esc(sk.reason) + '</span></div>').join('');
      return '<div class="imp-parse"><div class="sec-head" style="margin:10px 0 6px"><b>识别结果（' +
        '角色 ' + p.items.filter((x) => x.type === 'character').length +
        ' · 场景 ' + p.items.filter((x) => x.type === 'scene').length +
        ' · 道具 ' + p.items.filter((x) => x.type === 'prop').length + '）</b></div>' + rows + skips + '</div>';
    }

    function bind() {
      const fx = mask.querySelector('[data-x]'), cx = mask.querySelector('[data-cancel]');
      if (fx) fx.addEventListener('click', close);
      if (cx) cx.addEventListener('click', close);
      mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });

      const mFile = mask.querySelector('#impModeFile');
      const mText = mask.querySelector('#impModeText');
      if (mFile) mFile.addEventListener('click', () => { mode = 'file'; parsed = null; render(); });
      if (mText) mText.addEventListener('click', () => { mode = 'text'; render(); });

      if (mode === 'file') {
        mask.querySelector('#impPick').addEventListener('click', () => mask.querySelector('#impFile').click());
        mask.querySelector('#impFile').addEventListener('change', (ev) => {
          const fs = Array.from(ev.target.files || []);
          for (const f of fs) if (!pickedFiles.some((x) => x.name === f.name && x.size === f.size)) pickedFiles.push(f);
          ev.target.value = '';
          render();
        });
        mask.querySelectorAll('[data-rmfile]').forEach((b) => b.addEventListener('click', () => {
          pickedFiles.splice(Number(b.dataset.rmfile), 1); render();
        }));
        const go = mask.querySelector('#impDoFiles');
        if (go) go.addEventListener('click', async () => {
          if (!pickedFiles.length || busy) return;
          busy = true; go.disabled = true;
          mask.querySelector('#impFootHint').textContent = '正在匹配资产名称…';
          let plan;
          try { plan = await planFiles(pickedFiles.slice()); }
          catch (e) { busy = false; go.disabled = false; fail(e); return; }
          busy = false;
          if (plan.conflicts.length) { importPlan = plan; mode = 'conflict'; render(); }   // 暂停导入，等用户决策
          else { close(); await executeImportPlan(plan, null); }
        });
      } else if (mode === 'conflict') {
        mask.querySelectorAll('input[name="impAct"]').forEach((r) => r.addEventListener('change', () => { conflictAction = r.value; }));
        mask.querySelector('#impBack').addEventListener('click', () => { mode = 'file'; render(); });
        mask.querySelector('#impDoConflict').addEventListener('click', async () => {
          const plan = importPlan; const act = conflictAction;
          if (!plan || !plan.conflicts.length || busy) return;
          busy = true;
          close();
          await executeImportPlan(plan, act);
        });
      } else {
        const parseBtn = mask.querySelector('#impParse');
        const textEl = mask.querySelector('#impText');
        parseBtn.addEventListener('click', async () => {
          const text = String(textEl.value || '');
          if (!text.trim()) { toast('请先粘贴提示词文本', 'err'); return; }
          busy = true; parseBtn.disabled = true;
          mask.querySelector('#impParseHint').textContent = '解析中…';
          try {
            parsed = await Api.importAssetPrompts(text, false);
            if (!parsed.items.length) toast('没有识别出任何资产段，请检查 @ 分隔与段首类型标识', 'err');
          } catch (e) { parsed = null; fail(e); }
          busy = false;
          render();
        });
        const go = mask.querySelector('#impDoText');
        if (go) go.addEventListener('click', async () => {
          if (!parsed || !parsed.items.length || busy) return;
          busy = true; go.disabled = true;
          try {
            const r = await Api.importAssetPrompts(String(textEl.value || ''), true);
            const c = { character: 0, scene: 0, prop: 0 };
            (r.created || []).forEach((x) => { c[x.type]++; });
            toast('导入完成：角色 ' + c.character + ' · 场景 ' + c.scene + ' · 道具 ' + c.prop +
              (r.skipped.length ? '（另有 ' + r.skipped.length + ' 段未识别被跳过）' : ''), 'ok');
            close();
            await loadAssets();
            await loadList({ skeleton: false });
          } catch (e) { busy = false; go.disabled = false; fail(e); }
        });
      }
    }

    function close() { document.removeEventListener('keydown', escImp); mask.remove(); }
    function escImp(ev) { if (ev.key === 'Escape') close(); }
    document.addEventListener('keydown', escImp);
    render();
  }

  /* 删除单个素材（卡片右上角钮）；批量模式下同步清理勾选态 */
  async function onAssetDelete(assetId) {
    const a = S.assets.find((x) => x.id === assetId);
    if (!a) return;
    if (!(await uiConfirm('删除素材', '确定删除素材「' + a.name + '」？将同时解除所有分镜的绑定。'))) return;
    try {
      await Api.deleteAsset(a.id);
      toast('素材已删除', 'ok');
      if (S.assetSel.has(a.id)) S.assetSel.delete(a.id);
      await loadAssets();
      await loadList({ skeleton: false });
    } catch (e) { fail(e); }
  }

  async function onAssetClick(assetId) {
    // ① 批量选择模式：点击卡片 = 勾选 / 取消勾选
    if (S.assetSelMode) {
      S.assetSel.has(assetId) ? S.assetSel.delete(assetId) : S.assetSel.add(assetId);
      renderPanel();
      return;
    }
    // ② 已从表格的 ＋ 槽位进入绑定态：点击才执行绑定（绑定的唯一入口）
    if (S.bindTarget) {
      const target = rowById(S.bindTarget.id);
      if (!target) { S.bindTarget = null; renderPanel(); return; }
      try {
        await Api.bindAsset(target.id, assetId, S.bindTarget.role);
        toast('已添加到分镜 ' + target.seq, 'ok');
        S.bindTarget = null;
        await loadList({ skeleton: false });
        await loadAssets();
      } catch (e) { fail(e); }
      return;
    }
    // ③ 其余情况：打开素材设置（不再隐式添加到分镜）
    await editAsset(assetId);
  }

  /* ---------------------------------------------------------- 批量操作 */
  /* 提交前的积分余额提醒 —— 原画布链路有「报价→确认」的 creditCeiling 安全阀，
     创作 CLI 没有报价接口，无法预知确切消耗，所以改为"余额低于阈值就明确提醒"。
     阈值来自后端 meta.creditWarnBelow（与 worker 派发前的提醒同源，两处一致）。 */
  async function creditGate(count) {
    const threshold = Number((opts() || {}).creditWarnBelow) || 0;
    if (threshold <= 0) return true;                       // 未启用提醒
    const d = S.adapter && S.adapter.dreamina;
    if (!d || typeof d.credit !== 'number') return true;   // 拿不到余额就不拦（派发前 worker 还会再提醒一次）
    if (d.credit >= threshold) return true;
    return uiConfirm('创作 CLI 积分偏低',
      '当前积分 <b>' + d.credit + '</b>，提醒阈值 <b>' + threshold + '</b>。\n\n' +
      '即将提交 <b>' + count + '</b> 个分镜。创作 CLI 无法在提交前给出确切消耗，' +
      '积分不足时任务会在即梦侧失败（积分可能已被部分占用）。仍要继续吗？');
  }

  async function submitSelected() {
    if (!S.sel.size) { toast('请先勾选要提交的分镜', 'err'); return; }
    if (!(await creditGate(S.sel.size))) return;
    S.busy = true; renderTable();
    try {
      const ids = Array.from(S.sel);
      const res = await Api.batchSubmit(ids, S.settings.queue.concurrency);
      res.accepted.forEach((a) => { const s = rowById(a.id); if (s) { s.status = 'queued'; s.progress = 0; } });
      toast('已提交 ' + res.accepted.length + ' 个分镜' + (res.rejected.length ? '，' + res.rejected.length + ' 个被拒绝' : ''), res.rejected.length ? 'err' : 'ok');
      res.rejected.forEach((r) => { const s = rowById(r.id); if (s) { s.errorCode = r.code; s.errorMessage = r.message; } });
      await loadList({ skeleton: false });
      ensurePolling();
    } catch (e) { fail(e); }
    finally { S.busy = false; renderTable(); }
  }

  /* ------------------------------------------------ 干跑：提交后核对真实命令
     与「正式提交」完全同一条链路（同一批接口、同一个 worker、同一个命令组装出口），
     唯一区别是 worker 拿到 submitDryRun 后只把命令写回分镜、不 spawn 子进程。
     因此这里看到的命令 == 正式提交时会执行的命令（逐字一致）。 */
  async function drySubmitSelected() {
    if (!S.sel.size) { toast('请先勾选要干跑的分镜', 'err'); return; }
    const ids = Array.from(S.sel);
    S.dryBusy = true; renderPanel();
    const since = Date.now();
    try {
      const res = await Api.batchSubmit(ids, S.settings.queue.concurrency, true);
      const okIds = res.accepted.map((a) => a.id);
      if (!okIds.length) {
        toast('没有分镜进入干跑：' + (res.rejected[0] ? res.rejected[0].message : '未知原因'), 'err');
        return;
      }
      toast('干跑中：正在组装命令（不会发送给即梦）…');
      S.cmdRows = await waitDryRunPlans(okIds, since, 12000);
      renderCmdPanel();
      $('#cmdMask').hidden = false;
      await loadList({ skeleton: false });
    } catch (e) { fail(e); }
    finally { S.dryBusy = false; renderPanel(); }
  }

  /* 等 worker 产出干跑记录：1.5s 一拍，最多等 timeoutMs */
  async function waitDryRunPlans(ids, since, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    for (;;) {
      last = (await Promise.all(ids.map((id) => Api.getStoryboard(id).catch(() => null)))).filter(Boolean);
      const ready = last.filter((s) => s.dryRunPlan && Date.parse(s.dryRunPlan.at) >= since - 1500);
      if (ready.length === ids.length || Date.now() > deadline) return last;
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  function closeCmd() { $('#cmdMask').hidden = true; }

  function renderCmdPanel() {
    const rows = S.cmdRows || [];
    const done = rows.filter((s) => s.dryRunPlan);
    const pend = rows.filter((s) => !s.dryRunPlan);
    $('#cmdTitle').textContent = '干跑命令核对 · ' + done.length + ' 条' + (pend.length ? '（' + pend.length + ' 条未产出）' : '');
    $('#cmdFootHint').textContent = pendingHint(done, pend);

    const h = [];
    h.push('<div class="banner warn"><span><b>干跑：命令已生成，未发送给即梦。</b>' +
      '没有创建生成任务、没有消耗积分，分镜保持「未提交」状态 —— 可随时用「提交所选」正式提交。</span></div>');
    if (S.options && S.options.dryRun) {
      h.push('<div class="banner err"><span><b>注意：服务端处于干跑模式</b>（启动时带了 <code>JC_DRY_RUN=1</code> 或配置文件 dryRun:true）——' +
        '此时<b>所有</b>提交都不会真正派发，包括「提交所选」。恢复正常执行需重启服务并去掉该配置。</span></div>');
    }
    h.push('<div class="hint-sm">命令来自后端「唯一命令组装出口」（与 worker 派发共用），因此与正式提交逐字一致。' +
      '提交请求本身发的是 <code>POST /api/v1/storyboards/batch-submit</code>（体：ids + dryRun），命令不在请求体里、由后端组装。</div>');

    done.forEach((s) => h.push(cmdCardHTML(s)));
    pend.forEach((s) => h.push(
      '<div class="cmd-card">' +
        '<div class="cmd-card-head"><b>分镜 ' + s.seq + '</b><span class="hint-sm">' +
        (s.status === 'failed' ? '命令组装失败' : '命令尚未产出') + '</span></div>' +
        '<div class="hint-sm">' + esc(s.errorMessage || 'worker 尚未处理到该分镜，或组装阶段被拦下（详见分镜详情的执行日志）') + '</div>' +
      '</div>'));
    $('#cmdBody').innerHTML = h.join('');
  }

  function pendingHint(done, pend) {
    if (!done.length) return '命令未产出：请检查分镜详情里的执行日志';
    if (pend.length) return pend.length + ' 条未产出命令，请在分镜详情查看日志';
    return '共 ' + done.length + ' 条命令 · 服务端未连接即梦';
  }

  function cmdCardHTML(s) {
    const p = s.dryRunPlan || {};
    const v = s.__verify;
    const al = s.assetLock || { images: [], audios: [], block: '', injected: false, issues: [] };
    const rows = [];
    rows.push('<dt>执行引擎</dt><dd>' + esc(s.plannedEngineLabel || '—') +
      (p.mode ? '　模式 <b>' + esc(p.mode) + '</b>' : '') + '</dd>');
    rows.push('<dt>模型</dt><dd>' + esc(p.model || s.model) + '</dd>');
    rows.push('<dt>时长 / 画幅 / 分辨率</dt><dd>' + s.durationSec + 's · ' + esc(s.ratio) + ' · ' + esc(s.resolution) + '</dd>');
    rows.push('<dt>干跑时间</dt><dd>' + esc(p.at || '—') + '　<span class="hint-sm">来源：' +
      (p.scope === 'service' ? '服务端干跑模式' : '本次「干跑提交」') + '</span>' +
      (s.dryRunStale ? '　<b style="color:#B25000">⚠ 已过期</b>' : '') + '</dd>');
    if (p.submitId) rows.push('<dt>幂等键</dt><dd>' + esc(p.submitId) + '　<span class="hint-sm">仅预览，未落盘（正式提交时才写入）</span></dd>');
    /* 参考图号：把「命令里的第 N 张图」与「提示词里的 @图片N」摆在一起 */
    if (al.images && al.images.length) {
      rows.push('<dt>参考图</dt><dd>' + al.images.map((im) =>
        '<span class="lockrow"><i class="imgnum">图' + im.n + '</i>' + esc(im.name) +
        ' <span class="hint-sm">' + esc(im.roleLabel) + '</span> <code>@图片' + im.n + '</code></span>').join('') +
        '　<span class="hint-sm">按此顺序作为 --image 发出；提示词开头已自动追加「素材锁定」区块建立对应</span></dd>');
    }
    if (p.adapted && p.adapted.length) rows.push('<dt>参数适配</dt><dd>' + p.adapted.map(esc).join('<br/>') + '</dd>');
    if (p.missing && p.missing.length) rows.push('<dt>未匹配 flag</dt><dd style="color:#B25000">' + p.missing.map(esc).join('、') + '　<span class="hint-sm">模型规格里没有对应参数名，已跳过</span></dd>');
    if (!(al.images && al.images.length)) rows.push('<dt>素材引用</dt><dd><span class="hint-sm">无（参考图通过 --image 发出，见上方图号表）</span></dd>');

    const argvHtml = (p.argv || []).length
      ? '<details class="cmd-details"><summary>argv 逐项（' + p.argv.length + ' 个）</summary><div class="codebox">' +
        esc(p.argv.map((a, i) => '[' + String(i).padStart(2, ' ') + '] ' + a).join('\n')) + '</div></details>'
      : '';

    const lockHtml = al.block
      ? '<details class="cmd-details" open><summary>提示词开头追加的「素材锁定」区块　' +
        '<button class="btn-mini" data-copylock="' + esc(s.id) + '" style="margin-left:6px">复制区块</button></summary>' +
        '<div class="codebox">' + esc(al.block) + '</div></details>'
      : '';

    const lockIssues = (al.issues || []).length
      ? (al.issues || []).map((it) => '<div class="banner ' + (it.level === 'warn' ? 'warn' : 'ok') + '"><span>' + esc(it.message) + '</span></div>').join('')
      : '';

    const staleHtml = s.dryRunStale
      ? '<div class="banner warn"><span>这条记录生成于提示词 / 绑定素材 / 参数变动<b>之前</b>，命令已不代表实际会执行的内容，请重新干跑核对。</span></div>'
      : '';

    const vVerify = '';   // 「CLI 本地校验」是画布 CLI 的 --dry-run 专属能力，画布移除后不再提供

    return '<div class="cmd-card">' +
      '<div class="cmd-card-head"><b>分镜 ' + s.seq + '</b>' +
        '<span class="hint-sm">' + esc(s.prompt ? s.prompt.slice(0, 46) : '') + (s.prompt && s.prompt.length > 46 ? '…' : '') + '</span>' +
        '<span class="grow"></span>' +
        '<button class="btn-mini" data-copycmd="' + esc(s.id) + '">复制命令</button>' +
      '</div>' +
      staleHtml +
      '<div class="codebox">$ ' + esc(p.command || '') + '</div>' +
      lockHtml + lockIssues +
      '<dl class="kv">' + rows.join('') + '</dl>' +
      argvHtml + vVerify +
    '</div>';
  }

  function copyText(txt, okMsg) {
    const done = () => toast(okMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择文本', 'err'); }
      ta.remove();
    }
  }

  function copyAllCmds() {
    const done = (S.cmdRows || []).filter((s) => s.dryRunPlan);
    if (!done.length) { toast('没有可复制的命令', 'err'); return; }
    copyText(done.map((s) => '# 分镜 ' + s.seq + '（' + (s.dryRunPlan.engine || '') + (s.dryRunPlan.mode ? ' / ' + s.dryRunPlan.mode : '') + '）\n' + s.dryRunPlan.command).join('\n\n'),
      '已复制 ' + done.length + ' 条命令');
  }



  /* ------------------------------------------------ 自动匹配参考图（v1：只按素材名称）
     两步：先预览（apply:false，**不写库**）→ 用户确认后应用（apply:true）。
     作用范围：勾选了分镜 → 只处理勾选的；没勾选 → 处理全部「未提交」分镜。 */
  async function openAutoMatch() {
    if (S.autoBusy) return;
    const ids = Array.from(S.sel);
    S.autoBusy = true; renderPanel();
    try {
      const res = await Api.autoMatchAssets({ ids, apply: false, overwrite: isAutoOverwrite() });
      S.autoIds = ids;
      S.autoScopeAll = ids.length === 0;
      S.autoRows = res.rows || [];
      S.autoStats = res.stats || null;
      $('#autoMask').hidden = false;      // 先开弹层，交由 finally 统一复位并重绘
      if (!S.autoRows.some((r) => r.toBind.length)) toast('没有按名称匹配到素材：确认素材名是否出现在提示词里', 'err');
    } catch (e) { fail(e); }
    finally { setAutoBusy(false); }
  }

  /* busy 的唯一出口：置标志 + 重绘「当前可见的」面板。
     历史 bug（2026-09-18）：预览时先在 busy=true 的状态下 renderAutoPanel()，finally 里又只
     调 renderPanel()（素材面板）→ 弹层按钮永远停在「应用中…」且被禁用，用户根本无法点「应用」。
     根因是"先渲染、后复位标志"的时序 + 复位时漏绘弹层。此后一律经此函数改 busy。 */
  function setAutoBusy(v) {
    S.autoBusy = v;
    renderPanel();
    if (!$('#autoMask').hidden) renderAutoPanel();
    if (!v && S.autoPending) { S.autoPending = false; if (!$('#autoMask').hidden) openAutoMatch(); }   // 补跑被搁置的「覆盖」预览
  }

  const isAutoOverwrite = () => { const el = $('#autoOverwrite'); return !!(el && el.checked); };
  const roleLabelOf = (r) => (ROLE_META[r] || {}).label || r;
  const viaLabelOf = (v) => ({ name: '名称', core: '主干', part: '词块' }[v] || v);

  function closeAuto() { $('#autoMask').hidden = true; }

  function renderAutoPanel() {
    const st = S.autoStats || { bound: 0, kept: 0, occupied: 0, noMatch: 0, storyboards: 0 };
    const rows = S.autoRows || [];
    const n = st.bound || 0;
    const ow = isAutoOverwrite();
    $('#autoTitle').textContent = '自动匹配参考图 · 将绑定 ' + n + ' 个';
    $('#autoHint').textContent = '扫描 ' + (st.storyboards || 0) + ' 条 · 命中 ' + n + ' · 已存在 ' +
      (st.kept || 0) + ' · 类型已占 ' + (st.occupied || 0) + ' · 无匹配 ' + (st.noMatch || 0);
    $('#autoApply').disabled = !n || S.autoBusy;
    $('#autoApply').textContent = S.autoBusy ? '应用中…' : (n ? '应用（绑定 ' + n + ' 个）' : '无匹配，无需应用');

    const h = [];
    h.push('<div class="banner ' + (n ? 'warn' : 'err') + '"><span><b>匹配依据只有素材名称</b>（暂不做语义匹配）：' +
      '提示词里出现<b>素材全名</b> → 记 <code>名称</code>；出现剥掉「三视图 / 正面 / 设定图 / 角色」等描述词后的<b>主干</b> → 记 <code>主干</code>；' +
      '出现名称分词后的<b>词块</b> → 记 <code>词块</code>。默认<b>只增补、不覆盖</b>已有绑定；同一角色的多张素材（去描述词后同名）只取最优的一张。' +
      '依据词越长越可信，<code>词块</code>命中较松，请按下面的「依据」逐条确认。</span></div>');
    h.push('<div class="hint-sm">作用范围：' + (S.autoScopeAll
      ? '未勾选分镜 → 全部「未提交」分镜（' + (st.storyboards || 0) + ' 条）'
      : '仅勾选的 ' + (S.autoIds || []).length + ' 条分镜') +
      '。这是预览，点底部「应用」才会写入分镜；绑定错了可在素材面板手动移除。</div>');

    rows.forEach((r) => {
      const tag = (m, cls) => '<span class="mk-tag ' + (cls || '') + '">' + esc(m.name) +
        '<i>' + esc(roleLabelOf(m.role)) + ' · ' + esc(viaLabelOf(m.via)) + '「' + esc(m.keyword) + '」</i></span>';
      const box = [];
      if (r.toBind.length) box.push('<div class="mk-line"><b>将绑定</b>' + r.toBind.map((m) => tag(m)).join('') + '</div>');
      if (r.occupied.length) box.push('<div class="mk-line"><b>类型已占</b>' + r.occupied.map((o) =>
        '<span class="mk-tag occ">' + esc(o.want.name) + '<i>与已绑定的「' + esc(o.currentName) + '」同为' + esc(roleLabelOf(o.role)) +
        '，' + (ow ? '将替换' : '已跳过（勾选「覆盖同类型已有绑定」可替换）') + '</i></span>').join('') + '</div>');
      if (r.rivals.length) box.push('<div class="mk-line"><b>同类落选</b>' + r.rivals.map((m) => tag(m, 'rival')).join('') + '</div>');
      if (r.kept.length) box.push('<div class="mk-line"><b>已绑定</b>' + r.kept.map((m) => tag(m, 'done')).join('') + '</div>');
      if (!r.toBind.length && !r.occupied.length && !r.rivals.length) {
        box.push('<div class="hint-sm">未匹配到任何素材 —— 提示词里没有出现素材名或它的主干词</div>');
      }
      h.push('<div class="cmd-card"><div class="cmd-card-head"><b>分镜 ' + r.seq + '</b>' +
        '<span class="hint-sm">' + esc(String(r.prompt || '').slice(0, 60)) + (String(r.prompt || '').length > 60 ? '…' : '') + '</span></div>' +
        box.join('') + '</div>');
    });
    $('#autoBody').innerHTML = h.join('');
  }

  async function applyAutoMatch() {
    if (S.autoBusy) return;
    setAutoBusy(true);
    try {
      const res = await Api.autoMatchAssets({ ids: S.autoIds, apply: true, overwrite: isAutoOverwrite() });
      const st = res.stats || {};
      $('#autoMask').hidden = true;
      await loadList({ skeleton: false });
      await loadAssets();
      toast('已自动绑定 ' + (st.bound || 0) + ' 个参考图' +
        (st.occupied ? '，' + st.occupied + ' 个因类型已占而跳过' : ''));
    } catch (e) { fail(e); }
    // 失败时弹层仍开着 → setAutoBusy 会把按钮从「应用中…」恢复成可点击，避免卡死只能刷新页面
    finally { setAutoBusy(false); }
  }

  /* ------------------------------------------------ 按提示词「总时长」标注重算时长
     规则：优先读提示词里的「总时长：X.Xs」标注；没有标注则用各镜头秒数之和。
     取整一律「向上进位」（4.0→4、4.3→5）—— 分镜时长必须装得下整段内容，宁可多 1 秒。
     已完成/生成中的分镜时长已锁定，跳过。默认先预览再应用。 */
  async function openDurRecalc(ids) {
    if (S.durBusy) return;
    S.durBusy = true; renderStatusbar();
    try {
      const res = await Api.autoDuration({ ids, apply: false });
      S.durIds = ids;
      S.durScopeAll = ids.length === 0;
      S.durRows = res.rows || [];
      S.durStats = res.stats || null;
      $('#durMask').hidden = false;      // 先开弹层，交由 finally 统一复位并重绘
    } catch (e) { fail(e); }
    finally { setDurBusy(false); }
  }

  /* 同 setAutoBusy：busy 的唯一出口，避免「先渲染、后复位」导致按钮卡在「应用中…」且被禁用 */
  function setDurBusy(v) {
    S.durBusy = v;
    renderStatusbar();
    if (!$('#durMask').hidden) renderDurPanel();
  }

  function closeDur() { $('#durMask').hidden = true; }

  const durSourceLabel = (p) => {
    if (!p) return '—';
    if (p.source === 'declared') return '「总时长」标注 ' + p.declared + 's';
    if (p.source === 'shots') return '镜头秒数之和 ' + p.shotsSum + 's';
    return '—';
  };

  function renderDurPanel() {
    const st = S.durStats || { changed: 0, same: 0, skipped: 0, noDuration: 0, clamped: 0, mismatch: 0, storyboards: 0 };
    const rows = S.durRows || [];
    const n = st.changed || 0;
    const dr = (S.options && S.options.duration) || { min: 4, max: 15 };
    $('#durTitle').textContent = '按时长标注重算 · 将修改 ' + n + ' 条';
    $('#durHint').textContent = '扫描 ' + (st.storyboards || 0) + ' 条 · 修改 ' + n + ' · 已一致 ' + (st.same || 0) +
      ' · 无标注 ' + (st.noDuration || 0) + ' · 已锁定 ' + (st.skipped || 0) +
      (st.sumBefore !== st.sumAfter ? '　合计 ' + st.sumBefore + 's → ' + st.sumAfter + 's' : '');
    $('#durApply').disabled = !n || S.durBusy;
    $('#durApply').textContent = S.durBusy ? '应用中…' : (n ? '应用（改 ' + n + ' 条）' : '无需修改');

    const h = [];
    h.push('<div class="banner ' + (n ? 'warn' : 'ok') + '"><span>' +
      '规则：<b>优先取提示词里的「总时长：X.Xs」标注</b>；没有标注则用各镜头秒数之和。' +
      '<b>小数一律向上进位</b>（4.0s → 4、4.3s → 5）—— 分镜时长必须装得下整段内容，宁可多 1 秒。' +
      '超出可设范围（' + dr.min + '–' + dr.max + 's）的按边界值取并提示。</span></div>');
    if (st.mismatch) h.push('<div class="banner warn"><span><b>' + st.mismatch + ' 条的「总时长标注」与「镜头秒数之和」不一致</b>' +
      ' —— 稿件自身矛盾，目前以标注为准，建议回去核对分镜稿。</span></div>');
    if (st.declaredCeilSum != null && st.declaredSum != null) {
      const ok = st.consistent !== false;
      h.push('<div class="banner ' + (ok ? 'ok' : 'warn') + '"><span>' +
        '时长合计：标注总时长 <b>' + st.declaredSum + 's</b>　→　各段分别向上进位后 <b>' + st.declaredCeilSum + 's</b>' +
        '　→　实际设定合计 <b>' + st.sumAfter + 's</b>（当前 ' + st.sumBefore + 's）。' +
        (ok ? '合计一致 ✓'
            : '合计不完全一致，原因：' + [
                st.clamped ? st.clamped + ' 条被钳到范围边界' : '',
                st.noDuration ? st.noDuration + ' 条提示词无时长信息（沿用原值）' : '',
                st.skipped ? st.skipped + ' 条时长已锁定' : ''
              ].filter(Boolean).join('、') + '。') +
        '<br><span class="hint-sm">进位只在<b>单条</b>级别发生一次（4.3s→5s），不会跨段累积漂移；因此合计会略大于标注总和——这是为了保证每段都装得下自己的内容。</span></span></div>');
    }
    h.push('<div class="hint-sm">作用范围：' + (S.durScopeAll
      ? '未勾选分镜 → 全部「未提交」分镜' : '仅勾选的 ' + (S.durIds || []).length + ' 条') +
      '　·　以下为预览，点底部「应用」才写入。</div>');

    rows.forEach((r) => {
      const p = r.parsed || {};
      const tag = r.action === 'change' ? '<span class="mk-tag dur">' + r.from + 's → ' + r.target + 's</span>'
        : r.action === 'noDuration' ? '<span class="mk-tag occ">保持 ' + r.from + 's</span>'
        : r.action === 'skipped' ? '<span class="mk-tag rival">保持 ' + r.from + 's</span>'
        : '<span class="mk-tag done">已一致 ' + r.from + 's</span>';
      const lines = ['<div class="mk-line">' + tag + '<span class="hint-sm">依据：' + esc(durSourceLabel(p)) +
        (p.shots && p.shots.length ? '　镜头 ' + p.shots.join(' + ') + 's' : '') + '</span></div>'];
      if (r.clamped) lines.push('<div class="hint-sm" style="color:#B25000">进位后 ' + p.seconds + 's 超出可设范围，已按 ' + r.target + 's 取</div>');
      if (p.mismatch) lines.push('<div class="hint-sm" style="color:#B25000">标注 ' + p.declared + 's ≠ 镜头之和 ' + p.shotsSum + 's</div>');
      if (r.reason) lines.push('<div class="hint-sm">' + esc(r.reason) + '</div>');
      h.push('<div class="cmd-card"><div class="cmd-card-head"><b>分镜 ' + r.seq + '</b>' +
        '<span class="hint-sm">' + esc(String(r.prompt || '').slice(0, 56)) + (String(r.prompt || '').length > 56 ? '…' : '') + '</span></div>' +
        lines.join('') + '</div>');
    });
    if (!rows.length) h.push('<div class="banner ok"><span>没有需要处理的改动。</span></div>');
    $('#durBody').innerHTML = h.join('');
  }

  async function applyDurRecalc() {
    if (S.durBusy) return;
    setDurBusy(true);
    try {
      const res = await Api.autoDuration({ ids: S.durIds, apply: true });
      const st = res.stats || {};
      $('#durMask').hidden = true;
      await loadList({ skeleton: false });
      toast('已按提示词标注重算 ' + (st.changed || 0) + ' 条时长' +
        (st.sumBefore !== st.sumAfter ? '（合计 ' + st.sumBefore + 's → ' + st.sumAfter + 's）' : ''));
    } catch (e) { fail(e); }
    finally { setDurBusy(false); }
  }

  /* 批量操作（入口在底部状态栏，勾选后才出现） */
  async function onBatch(kind) {
    const ids = Array.from(S.sel);

    // 按时长标注重算：允许不选（不选 = 作用于全部「未提交」分镜）
    if (kind === 'reduration') { await openDurRecalc(ids); return; }

    if (!ids.length) return;

    if (kind === 'clear') { S.sel.clear(); renderTable(); renderPanel(); renderStatusbar(); return; }

    if (kind === 'duration') {
      const d = opts().duration;
      const input = await uiPrompt('批量改时长', '把选中的 ' + ids.length + ' 个分镜时长统一设为（' + d.min + '–' + d.max + ' 秒）：', String(d.defaultValue));
      if (input == null) return;
      const v = parseInt(input, 10);
      if (!isFinite(v)) { toast('请输入数字', 'err'); return; }
      try {
        const res = await Api.batchDuration(ids, v);
        toast('已更新 ' + res.updated.length + ' 个分镜' +
          (res.skipped.length ? '，' + res.skipped.length + ' 个已完成已锁定' : ''), res.skipped.length ? 'err' : 'ok');
        await loadList({ skeleton: false });
      } catch (e) { fail(e); }
      return;
    }

    if (kind === 'delete') {
      if (!(await uiConfirm('批量删除', '删除选中的 ' + ids.length + ' 个分镜？运行中的会一并停止，且不可撤销。'))) return;
      try {
        await Api.batchDelete(ids, true);
        S.sel.clear();
        toast('已删除 ' + ids.length + ' 个分镜');
        await loadList({ skeleton: false });
      } catch (e) { fail(e); }
    }
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-batch]');
    if (b) await onBatch(b.dataset.batch);
    if (e.target.closest('#btnSubmitSel')) await submitSelected();
    if (e.target.closest('#btnDrySubmit')) await drySubmitSelected();
    if (e.target.closest('#btnAutoMatch')) await openAutoMatch();
    const cc = e.target.closest('[data-copycmd]');
    if (cc) {
      const row = (S.cmdRows || []).find((s) => s.id === cc.dataset.copycmd);
      if (row && row.dryRunPlan) copyText(row.dryRunPlan.command, '已复制分镜 ' + row.seq + ' 的命令');
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const al = (S.detailFull && S.detailFull.assetLock) || {};
      if (cp.dataset.copy === 'lockblock') copyText(al.block || '', '已复制素材锁定区块');
      else if (cp.dataset.copy === 'promptwithlock') copyText(al.promptWithLock || '', '已复制注入后的完整提示词');
    }
    const cl = e.target.closest('[data-copylock]');
    if (cl) {
      // 按钮在 <details><summary> 里：不拦的话点一下会顺手把折叠区收起来
      e.preventDefault(); e.stopPropagation();
      const row = (S.cmdRows || []).find((s) => s.id === cl.dataset.copylock);
      const block = (row && row.assetLock && row.assetLock.block) || '';
      if (block) copyText(block, '已复制素材锁定区块');
      else toast('该分镜没有可复制的锁定区块', 'err');
    }
    if (e.target.closest('[data-act="reload"]')) await loadList();
    if (e.target.closest('[data-act="openImport"]')) openImport();
    const aa = e.target.closest('[data-assetact]');
    if (aa) {
      const act = aa.dataset.assetact;
      if (act === 'batch') { S.assetSelMode = !S.assetSelMode; S.assetSel.clear(); renderPanel(); return; }
      if (act === 'exit') { S.assetSelMode = false; S.assetSel.clear(); renderPanel(); return; }
      if (act === 'all') { S.assets.forEach((a) => S.assetSel.add(a.id)); renderPanel(); return; }
      if (act === 'none') { S.assetSel.clear(); renderPanel(); return; }
      if (act === 'del') { await deleteSelectedAssets(); return; }
      if (act === 'openImport') { if (!S.assetBusy) openAssetImport(); return; }
      return;
    }
    const locked = e.target.closest('[data-locked]');
    if (locked) toast('该分镜已完成生成，修改时长需重新生成', 'err');
  });

  // （旧「创建/批量导入素材」的文件选择回调已并入「导入资产」弹窗）

  /* 设计系统内的确认 / 输入弹层（替代原生 confirm/prompt） */
  function uiDialog(opts) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'mask'; mask.style.zIndex = 200;
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>' + esc(opts.title) + '</h2><span class="grow"></span>' +
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            (opts.message ? '<div style="font-size:13px;line-height:1.7;color:var(--ink80)">' + esc(opts.message) + '</div>' : '') +
            (opts.input ? '<input class="input-sm" id="uiDlgInput" style="width:100%" value="' + esc(opts.value || '') + '" />' : '') +
          '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn-outline" data-cancel>取消</button><span class="grow"></span>' +
            '<button class="btn-primary" data-ok>' + esc(opts.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      const done = (v) => { mask.remove(); resolve(v); };
      mask.querySelector('[data-ok]').addEventListener('click', () => done(opts.input ? ($('#uiDlgInput', mask) || {}).value ?? '' : true));
      mask.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      mask.querySelector('[data-x]').addEventListener('click', () => done(null));
      mask.addEventListener('click', (ev) => { if (ev.target === mask) done(null); });
      document.addEventListener('keydown', function esc2(ev) {
        if (ev.key !== 'Escape') return;
        document.removeEventListener('keydown', esc2); done(null);
      });
      if (opts.input) { const i = mask.querySelector('#uiDlgInput'); i.focus(); i.select(); }
    });
  }
  const uiConfirm = (title, message) => uiDialog({ title: title, message: message, okText: '确定' }).then((v) => v !== null);
  const uiPrompt = (title, message, value) => uiDialog({ title: title, message: message, input: true, value: value }).then((v) => (v === null ? null : String(v)));

  /* ---------------------------------------------------------- P2 导入 */
  function openImport() {
    S.imp.raw = ''; S.imp.preview = null;
    if (S.settings) S.imp.delimiter = Object.assign({}, S.settings.delimiter);
    $('#importText').value = '';
    $('#importCustom').value = S.imp.delimiter.value || '';
    renderImportChips(); renderImportPreview();
    $('#importMask').hidden = false;
    $('#importText').focus();
  }
  function closeImport() { $('#importMask').hidden = true; }

  function renderImportChips() {
    const presets = opts().settings.delimiterPresets;
    const cur = S.imp.delimiter;
    const isNewline = cur.type === 'newline';
    $('#importChips').innerHTML =
      '<button data-dl="newline"' + (isNewline ? ' class="on"' : '') + '>换行符</button>' +
      presets.map((p) => '<button data-dl="' + esc(p) + '"' + (!isNewline && cur.value === p ? ' class="on"' : '') + '>' + esc(p) + '</button>').join('') +
      '<button class="dashed" data-dl="__custom"' + (!isNewline && presets.indexOf(cur.value) < 0 ? ' class="on dashed"' : '') + '>自定义</button>';
  }

  function renderImportPreview() {
    const p = S.imp.preview;
    const box = $('#importPreview');
    if (!p) { box.innerHTML = '<div class="none">粘贴提示词后自动按分隔符识别分段</div>'; }
    else if (!p.segments.length) { box.innerHTML = '<div class="none">没有识别到内容</div>'; }
    else {
      box.innerHTML = p.segments.map((sg) =>
        '<div class="pr"><span class="idx">' + pad2(sg.index) + '</span>' +
        '<span class="txt">' + esc(sg.text) + '</span>' +
        (sg.duplicate ? '<span class="dup">重复</span>' : '') +
        (sg.tooLong ? '<span class="dup">超长</span>' : '') + '</div>').join('');
    }
    const n = p ? p.segments.length : 0;
    $('#importDetect').hidden = !p;
    $('#importDetectTxt').textContent = '已识别 ' + n + ' 段提示词，将创建 ' + n + ' 个分镜';
    $('#importOk').disabled = !n;
    $('#importOk').textContent = n ? '导入 ' + n + ' 个分镜' : '导入';
  }

  async function doPreview() {
    const raw = $('#importText').value;
    S.imp.raw = raw;
    if (!raw.trim()) { S.imp.preview = null; renderImportPreview(); return; }
    try {
      S.imp.preview = await Api.importPreview(raw, S.imp.delimiter);
    } catch (e) { fail(e); S.imp.preview = null; }
    renderImportPreview();
  }

  /* ---------------------------------------------------------- P3 设置 */
  /* 打开设置抽屉。
     ⚠ 性能纪律：抽屉的**可见性绝不能挂在网络请求上**。
     历史故障（2026-09-18 排查）：原实现是「串行 await 两个请求 → 才 renderSettings → 才显示抽屉」，
     而 GET /system/adapter 在创作 CLI 探测缓存过期时会等一次真实探测（单次 `dreamina user_credit`
     实测 8.4–9.5 秒）⇒ 用户点「设置」后约 11 秒界面毫无反应。
     实测：缓存新鲜 117 ms ↔ 缓存过期 10981 ms（每 60 秒必犯一次）。
     现在：S.settings / S.adapter 在 boot() 里已经加载过 → 先用现有数据立即渲染并打开抽屉，
     再**并发**（不是串行）拉最新值，到位后原地重渲染。 */
  async function openSettings() {
    renderSettings();
    $('#settingsMask').hidden = false;
    $('#settingsDrawer').classList.add('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'false');
    try {
      const [st, ad] = await Promise.all([Api.getSettings(), Api.getAdapter()]);
      S.adapter = ad;
      /* 抽屉这时已经可交互了：如果用户在等待期间改过任何设置项，就别拿服务端的旧值盖回去，
         否则他的修改会当场回退（"先显示、后刷新"必须配这个守卫）。 */
      if (!S.settingsDirty) S.settings = st;
      renderSettings();
      /* 冷启动时后端会用"读取中"占位限时返回（不为了一个 9 秒的探测卡住响应）→ 补拉一次，
         免得抽屉一直停在占位文案上。只在抽屉还开着时执行。 */
      if (ad && (ad.cliProbing || ad.dreaminaProbing)) {
        setTimeout(async () => {
          try {
            if (!$('#settingsDrawer').classList.contains('open')) return;
            S.adapter = await Api.getAdapter();
            renderSettings();
          } catch (e) { /* 补拉失败就保持占位，用户重开抽屉即可 */ }
        }, 4000);
      }
    } catch (e) { fail(e); }
  }
  function closeSettings() {
    $('#settingsMask').hidden = true;
    $('#settingsDrawer').classList.remove('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'true');
    S.settingsDirty = false;
  }

  /* 授权等待/结果那一行的内容。
     抽成函数是为了让轮询能原地更新文案，而不必每 3s 重建整块设置抽屉。 */
  function cliMsgInner() {
    return esc(S.cliMsg)
      + (S.dCliUrl ? '　<a href="' + esc(S.dCliUrl) + '" target="_blank" rel="noopener" style="color:var(--primary)">打开授权页 ↗</a>' : '')
      + (S.dCliCode ? '　设备码 <b>' + esc(S.dCliCode) + '</b>' : '')
      + (S.cliHint ? '<span class="hint-sm" style="display:block">' + esc(S.cliHint) + '</span>' : '');
  }
  function cliMsgHTML() {
    return S.cliMsg ? '<div class="hint-sm" id="cliActMsg">' + cliMsgInner() + '</div>' : '';
  }

  /* CLI 账户操作：检测 / 登录 / 切换账号（后端 spawn 创作 CLI，登录含最长 10 分钟授权等待）。
     2026-09-18 画布 CLI 移除后只剩这一套（原本还有画布 CLI 的 login/switch 两套独立登录）。 */
  async function runCliAction(kind) {
    if (S.cliBusy) return;
    /* 「创作 CLI 切换账号」会**先退出当前账号** —— 没完成新授权就会失去它。
       因此先弹二次确认，把后果说清楚再动手（原生 confirm 被 uiConfirm 取代，风格统一）。 */
    if (kind === 'dswitch') {
      const okGo = await uiConfirm('切换创作 CLI 账号？',
        '这会先退出创作 CLI（dreamina）当前登录的账号，然后重新走一次浏览器授权。\n\n' +
        '在此期间当前账号的登录态会消失：如果你没有在浏览器里完成新账号授权，就会回到「未登录」状态，' +
        '需要用新账号重新登录一次。');
      if (!okGo) return;
    }
    const labels = {
      check: '正在检测创作 CLI 连接…',
      dlogin: '已启动创作 CLI 登录流程：请在打开的浏览器中完成授权（最长等待约 10 分钟，完成后自动确认）…',
      dswitch: '正在退出创作 CLI 当前账号并重新授权（请在打开的浏览器中完成新账号登录，最长约 10 分钟）…'
    };
    S.cliBusy = kind; S.cliMsg = labels[kind]; S.cliRaw = null; S.cliHint = null;
    S.dCliUrl = null; S.dCliCode = null;
    renderSettings();
    // 登录/切换：POST 等待授权期间，每 3s 轮询适配器状态，实时显示等待时长与授权链接
    var liveTimer = null, waited = 0, shownUrl = null;
    if (kind !== 'check') {
      liveTimer = setInterval(async () => {
        waited += 3;
        try {
          var st = await Api.getAdapter();
          if (st.dreaminaAuth && st.dreaminaAuth.authUrl) {
            S.dCliUrl = st.dreaminaAuth.authUrl;
            S.dCliCode = st.dreaminaAuth.userCode || S.dCliCode;
          }
          S.cliMsg = '等待浏览器授权中（已等待 ' + waited + ' 秒）…完成后将自动确认';
          /* 只在授权链接首次出现/变化时才整块重绘；其余情况原地改文案。
             原先每 3s 重建 settingsBody：链接节点被反复销毁重建，用户点上去常常落空，
             同时丢焦点、跳滚动位置 —— 表现为"界面卡住、点不动"。 */
          if ((S.dCliUrl || null) !== shownUrl) { shownUrl = S.dCliUrl || null; renderSettings(); }
          else {
            const el = document.getElementById('cliActMsg');
            if (el) el.innerHTML = cliMsgInner(); else renderSettings();
          }
        } catch (e) { /* 轮询失败忽略 */ }
      }, 3000);
    }
    try {
      const res = kind === 'check' ? await Api.adapterCheck()
        : kind === 'dlogin' ? await Api.dreaminaLogin()
        : await Api.dreaminaSwitch();
      S.adapter = Object.assign({}, S.adapter, res);
      const okFlag = kind === 'check' ? res.cliAvailable !== false : res.ok !== false;
      S.cliMsg = res.message || (okFlag ? '操作完成' : '操作未完成');
      /* 后端流程结束时会回收链接，这里用本地已捕获的值兜底：
         只要流程中出现过链接就不丢 —— 否则用户会看到"等待授权"却没有任何可点的链接。 */
      S.dCliUrl = res.authUrl || S.dCliUrl || null;
      S.dCliCode = res.userCode || S.dCliCode || null;
      /* 失败时把 CLI 原始输出摆出来：解析不到授权材料时，用户还能照着原文手工完成授权 */
      S.cliRaw = res.raw || null;
      /* 后端给出的"下一步怎么办"（如手工执行 dreamina relogin）—— 缺了它，失败提示对用户不可行动 */
      S.cliHint = res.manualHint || null;
      toast(S.cliMsg, okFlag ? 'ok' : 'err');
      /* 账号变更后（登录/切换）积分与模型支持范围都可能变，再拉一次适配器状态统一刷新。 */
      if (kind !== 'check') {
        try { S.adapter = Object.assign({}, S.adapter, await Api.getAdapter()); }
        catch (e) { /* 刷新失败保留已有信息 */ }
      }
    } catch (e) {
      S.cliMsg = errText(e); fail(e);
    }
    if (liveTimer) clearInterval(liveTimer);
    S.cliBusy = null;
    renderSettings();
  }
  /* 模型下拉：单引擎后只有一组，但保留 optgroup 结构以兼容后端的 modelGroups 字段。
     禁用项在选项文字里带上原因。 */
  function modelOptionsHTML(o, current) {
    const src = (o.modelGroups && o.modelGroups.length)
      ? o.modelGroups
      : [{ key: 'dreamina', label: '创作 CLI' }];
    const groups = src.map((g) => ({ key: g.key, label: g.label, items: [] }));
    const byKey = {};
    groups.forEach((g) => { byKey[g.key] = g; });
    (o.models || []).forEach((m) => {
      const key = m.group || (Array.isArray(m.engines) && m.engines[0]) || 'dreamina';
      (byKey[key] || groups[0]).items.push(m);
    });
    return groups.filter((g) => g.items.length).map((g) =>
      '<optgroup label="' + esc(g.label) + '">' +
        g.items.map((m) => '<option value="' + esc(m.value) + '"' + (m.value === current ? ' selected' : '') +
          (m.enabled === false ? ' disabled' : '') + '>' + esc(m.label) +
          (m.enabled === false && m.disabledReason ? '（' + esc(m.disabledReason) + '）' : '') + '</option>').join('') +
      '</optgroup>').join('');
  }

  /* 引擎归属展示（规则与 server/models.js 的 routeEngine 一致，仅用于界面提示）。
     单引擎后只有一个引擎，这里保留函数是为了让"引擎"标签有个统一出口。 */
  function enginesOf(o, value) {
    const m = (o.models || []).find((x) => x.value === value);
    return (m && Array.isArray(m.engines) && m.engines.length) ? m.engines : ['dreamina'];
  }
  /* 取某模型的实时规格（分辨率 / 画幅 / 时长），后端按模型逐一下发 */
  function modelSpecOf(o, value) {
    const m = (o.models || []).find((x) => x.value === value);
    if (!m) return null;
    return {
      resolutions: m.resolutions || null,
      ratios: m.ratios || null,
      duration: m.duration || null
    };
  }

  function engineLabelOf(o, value, hasAudio) {
    const e = enginesOf(o, value);
    if (e.length === 1) return e[0] === 'dreamina' ? '创作 CLI' : '画布 CLI（已退役）';
    return '创作 CLI';
  }

  function renderSettings() {
    const s = S.settings || Api.META && { delimiter: { type: 'custom', value: ';;' }, defaults: {}, queue: {}, adapter: {} };
    const o = opts();
    const dur = o.duration;
    if (s.defaults) {
      // 归一化：默认时长收敛到 4–15s 区间；模型不在枚举中时回退到首个可用项
      s.defaults.durationSec = Math.max(dur.min, Math.min(dur.max, Number(s.defaults.durationSec) || dur.defaultValue));
      if (!o.models.some((m) => m.value === s.defaults.model)) {
        const firstEnabled = o.models.find((m) => m.enabled !== false);
        if (firstEnabled) s.defaults.model = firstEnabled.value;
      }
    }
    const presets = o.settings.delimiterPresets;
    const isNL = s.delimiter.type === 'newline';
    /* 引擎不再由用户选择：下发模型自带 engines 归属，运行时由后端自动匹配 */
    const dInfo = (S.adapter && S.adapter.dreamina) || null;
    const dreaminaOk = !!(dInfo && dInfo.available);
    const dreaminaCredit = dInfo ? dInfo.credit : null;
    /* 新鲜度标记：fast 路径现在会在探测缓存过期时先回"陈旧值"以免阻塞（见后端 adapterStatus），
       所以界面必须如实区分"读到的是刚探的"还是"几分钟前的"。 */
    const dreaminaStale = !!(dInfo && dInfo.stale);
    const dreaminaProbing = !!(S.adapter && S.adapter.dreaminaProbing);   // 创作状态尚未探到
    /* 创作 CLI 的账号与积分归属。
       2026-09-18 画布 CLI 已移除，界面上的积分、账号全部来自创作 CLI（dreamina）一个来源。 */
    const dAuth = (S.adapter && S.adapter.dreaminaAuth) || null;   // 待完成的创作 CLI 授权链接/设备码
    /* 授权链接/设备码：优先用本地已捕获的值（S.dCliUrl/dCliCode）。
       后端在"已登录"时会把遗留链接清掉，而切换进行中的轮询恰好会命中那个分支；
       只读 dAuth 会导致链接被清后再也渲染不出来，用户"等待授权"却无处可点（历史故障）。 */
    const dAuthUrl = S.dCliUrl || (dAuth && dAuth.authUrl) || null;
    const dAuthCode = S.dCliCode || (dAuth && dAuth.userCode) || null;
    const dAcct = dInfo ? dInfo.account : null;
    const hhmmss = (iso) => {
      try {
        const d = new Date(iso);
        return isNaN(d) ? null : d.toLocaleTimeString('zh-CN', { hour12: false });
      } catch (e) { return null; }
    };
    const creditAt = dInfo ? hhmmss(dInfo.creditAt) : null;
    // 当前默认模型的实时规格：分辨率/画幅/时长下拉只显示该模型支持的值
    const dmSpec = modelSpecOf(o, s.defaults.model);
    /* 默认模型的状态提示（后端 meta.defaultsNotice 下发）：
       · unavailable = 名字有效、但当前被引擎探测临时禁用 → 后端**保留**了用户的选择。这里必须
         说清楚，否则用户会以为"设置没生效"（历史故障：被静默换成通用模型 → 新分镜全走画布 → 40300）。
       · invalid     = 名称已失效、被自动迁移 → 告知迁移结果。 */
    const dmNotice = o.defaultsNotice || null;
    const resVals = (dmSpec && dmSpec.resolutions && dmSpec.resolutions.length)
      ? dmSpec.resolutions : (o.resolutions || []).map((x) => x.value);
    const ratioVals = (dmSpec && dmSpec.ratios && dmSpec.ratios.length)
      ? dmSpec.ratios : (o.ratios || []).map((x) => x.value);
    const durRange = (dmSpec && dmSpec.duration) || { min: o.duration.min, max: o.duration.max };
    /* 结构：卡片（.scard → .scard-hd 标题/说明 + .scard-bd 内容）→ 子块（.sblock，一个 CLI 一组）
       → 设置行（.srow）。顺序按使用频次递减：最常改的生成参数在前，状态与账号操作这些
       低频、高风险的内容集中在末尾的「生成引擎与账号」里，且各自的状态与按钮收进同一个子块。
       所有事件钩子（data-sdl / data-set / data-conc / data-toggle / data-cliact / #setDelim /
       .example .in / #cliActMsg）保持不变，交互逻辑零改动。 */
    $('#settingsBody').innerHTML =
      /* —— 卡片 1 · 生成参数默认值 —— */
      '<section class="scard">' +
        '<div class="scard-hd"><div class="scard-hd-t">' +
          '<h3>生成参数默认值</h3><p>导入或新增分镜时套用的默认值</p></div></div>' +
        '<div class="scard-bd">' +
          '<div class="srow"><span class="k">默认模型</span><select class="input-sm" data-set="model">' +
            modelOptionsHTML(o, s.defaults.model) +
          '</select></div>' +
          '<div class="srow"><span class="k">默认画幅</span><select class="input-sm" data-set="ratio">' +
            ratioVals.map((v) => '<option value="' + esc(v) + '"' + (v === s.defaults.ratio ? ' selected' : '') + '>' + esc(v) + '</option>').join('') +
          '</select></div>' +
          '<div class="srow"><span class="k">默认分辨率</span><select class="input-sm" data-set="resolution">' +
            resVals.map((v) => '<option value="' + esc(v) + '"' + (v === s.defaults.resolution ? ' selected' : '') + '>' + esc(v) + '</option>').join('') +
          '</select></div>' +
          '<div class="srow"><span class="k">默认时长</span><select class="input-sm" data-set="durationSec">' +
            (function () {
              let out = '';
              for (let v = durRange.min; v <= durRange.max; v++) {
                out += '<option value="' + v + '"' + (v === s.defaults.durationSec ? ' selected' : '') + '>' + v + 's</option>';
              }
              return out;
            })() +
          '</select></div>' +
          '<p class="hint-sm">画幅 / 分辨率 / 时长跟随当前默认模型（' + esc(labelOf(o.models, s.defaults.model) || s.defaults.model) + '）的实时规格，仅列出受支持的值</p>' +
        '</div>' +
      '</section>' +
      /* —— 卡片 2 · 提示词分隔符 —— */
      '<section class="scard">' +
        '<div class="scard-hd"><div class="scard-hd-t">' +
          '<h3>提示词分隔符</h3><p>导入时按此符号把粘贴文本拆分为多个分镜</p></div></div>' +
        '<div class="scard-bd">' +
          '<div class="chips">' +
            '<button data-sdl="newline"' + (isNL ? ' class="on"' : '') + '>换行符</button>' +
            presets.map((p) => '<button data-sdl="' + esc(p) + '"' + (!isNL && s.delimiter.value === p ? ' class="on"' : '') + '>' + esc(p) + '</button>').join('') +
            /* 注意：class 只能出现一次。原先写成 'class="dashed"' + (条件 ? ' class="on dashed"' : '')，
               拼出两个 class 属性 → HTML 取第一个 → 「自定义」被选中时高亮永远不显示。 */
            '<button' + (!isNL && presets.indexOf(s.delimiter.value) < 0 ? ' class="on dashed"' : ' class="dashed"') + ' data-sdl="__custom">自定义</button>' +
          '</div>' +
          '<div class="row-inline"><span class="label-sm">自定义符号</span>' +
            '<input class="input-sm input-delim" id="setDelim" value="' + esc(s.delimiter.value || '') + '" />' +
            '<span class="hint-sm">留空表示按换行拆分</span></div>' +
          '<div class="example"><span class="lab">拆分示例</span>' +
            '<span class="in">镜头推进' + esc(s.delimiter.value || '↵') + '雨滴落在玻璃窗</span>' +
            '<span class="out">拆分为 2 个分镜</span></div>' +
        '</div>' +
      '</section>' +
      /* —— 卡片 3 · 队列与执行 —— */
      '<section class="scard">' +
        '<div class="scard-hd"><div class="scard-hd-t">' +
          '<h3>队列与执行</h3><p>控制同时生成的分镜数量与失败处理（并发上限不做人为限制，超出即梦配额时由服务端拒绝并提示）</p></div></div>' +
        '<div class="scard-bd">' +
          '<div class="srow"><span class="k">并发数</span>' +
            '<span class="stepper"><button data-conc="-1">−</button><b>' + s.queue.concurrency + '</b><button data-conc="1">＋</button></span></div>' +
          '<div class="srow"><span class="k">失败自动重试（最多 ' + s.queue.maxRetry + ' 次）</span>' +
            '<span class="switch' + (s.queue.autoRetry ? ' on' : '') + '" data-toggle="autoRetry"><i></i></span></div>' +
        '</div>' +
      '</section>' +
      /* —— 卡片 4 · 生成引擎与账号（全局的「检测」升到卡片头，两个 CLI 各自成组） —— */
      '<section class="scard">' +
        '<div class="scard-hd">' +
          '<div class="scard-hd-t"><h3>生成引擎与账号</h3>' +
            '<p>引擎随所选模型自动匹配，无需手动切换；含音频绑定的分镜自动使用创作 CLI。两个 CLI 的登录态彼此独立。</p></div>' +
          '<button class="btn-mini" data-cliact="check"' + (S.cliBusy ? ' disabled' : '') + ' title="强探创作 CLI：读取登录态、账号与最新积分（强制重探，不受缓存影响）">' + (S.cliBusy === 'check' ? '检测中…' : '检测连接状态') + '</button>' +
        '</div>' +
        '<div class="scard-bd">' +
          (dmNotice && dmNotice.reason === 'unavailable'
            ? '<div class="statecard" style="background:var(--warn-bg);color:var(--warn)">' + I.warn +
              '<span>默认模型 <b>' + esc(labelOf(o.models, s.defaults.model) || s.defaults.model) + '</b> → <b>' + esc(engineLabelOf(o, s.defaults.model, false)) + '</b>　·　<b>当前不可用</b>：' + esc(dmNotice.message) +
              '<span class="hint-sm" style="display:block">你的选择已被<b>原样保留</b>（系统不会自动改写默认模型）。新分镜仍会使用它，等该引擎恢复可用后即可正常生成；若想立刻出片，请在上方「默认模型」里改选一个当前可用的模型。</span></span></div>'
            : '<div class="statecard ok">' + I.check +
              '<span>默认模型 <b>' + esc(labelOf(o.models, s.defaults.model) || s.defaults.model) + '</b> → <b>' + esc(engineLabelOf(o, s.defaults.model, false)) + '</b>　·　模型按各自归属执行，列表已标注可用引擎</span>' +
              (dmNotice && dmNotice.reason === 'invalid'
                ? '<span class="hint-sm" style="display:block">' + esc(dmNotice.message) + '</span>' : '') +
              '</div>') +
          /* —— 创作 CLI：唯一的生成引擎（画布 CLI 已移除）—— */
          '<div class="sblock">' +
            '<div class="sblock-hd"><b>创作 CLI（dreamina）</b></div>' +
            '<div class="statecard' + (dreaminaProbing ? '' : (dreaminaOk ? ' ok' : '')) + '">' +
              (dreaminaProbing || !dreaminaOk ? I.warn : I.check) +
              '<span>' + (dreaminaProbing
                ? '状态读取中…（首次探测需要几秒，拿到结果后会自动更新，无需刷新）'
                : (dreaminaOk
                  ? '已就绪' + (dInfo.version ? '　v' + esc(dInfo.version) : '') +
                    (dAcct && dAcct.userId != null ? '　·　账号 <b>' + esc(String(dAcct.userId)) + '</b>' + (dAcct.vipLevel ? '（' + esc(dAcct.vipLevel) + '）' : '') : '') +
                    (dreaminaCredit != null ? '　·　积分 <b>' + dreaminaCredit + '</b>' : '') +
                    (creditAt
                      ? '　<span class="hint-sm">读取于 ' + esc(creditAt) + (dreaminaStale ? '（已过期，正在后台更新…）' : '') + '</span>'
                      : '')
                  : '未就绪（安装：curl -s https://jimeng.jianying.com/cli | bash）')) +
            '</span></div>' +
            '<p class="hint-sm">命令：<code>dreamina</code>　·　负责视频生成的全部链路（<code>--image</code> / <code>--audio</code> 混合参考）。' +
              '下方按钮作用于创作 CLI 自己的 OAuth 登录态；' +
              '<b>「切换账号」会先退出现有账号</b>（CLI 的 <code>relogin</code> 语义），因此会先弹一次确认</p>' +
            '<div class="cli-actions">' +
              '<button class="btn-mini" data-cliact="dlogin"' + (S.cliBusy ? ' disabled' : '') + ' title="创作 CLI 登录：若本地登录态仍有效，CLI 会直接复用、不重新授权">' + (S.cliBusy === 'dlogin' ? '等待授权中…' : '创作 CLI 登录') + '</button>' +
              '<button class="btn-mini" data-cliact="dswitch"' + (S.cliBusy ? ' disabled' : '') + ' title="切换创作 CLI 账号：会先退出当前账号再重新授权（有二次确认）">' + (S.cliBusy === 'dswitch' ? '切换中（先退出再授权）…' : '创作 CLI 切换账号') + '</button>' +
            '</div>' +
          '</div>' +
          /* 待完成的创作 CLI 授权：后端在启动授权后就把链接落库，这里轮询显示，随时可点 */
          (dAuthUrl
            ? '<div class="statecard" style="background:var(--primary-bg);color:var(--ink80)">' + I.warn +
              '<span>创作 CLI 待完成授权：<a href="' + esc(dAuthUrl) + '" target="_blank" rel="noopener" style="color:var(--primary)">打开授权页 ↗</a>' +
              (dAuthCode ? '　设备码 <b>' + esc(dAuthCode) + '</b>' : '') +
              '<span class="hint-sm" style="display:block">在浏览器里打开上面的链接并完成授权；本页会自动确认。若设备码已失效，重新点「创作 CLI 登录」。</span></span></div>'
            : '') +
          cliMsgHTML() +
          /* 授权材料解析失败时，把 CLI 原始输出摆出来，用户仍可照着它手工完成授权 */
          (S.cliRaw ? '<details class="cmd-details"><summary>CLI 原始输出（解析授权材料失败时照此手工完成）</summary>' +
            '<div class="codebox">' + esc(S.cliRaw) + '</div></details>' : '') +
        '</div>' +
      '</section>';
  }

  /* ---------------------------------------------------------- 详情 / 预览 */
  async function openDetail(s, previewOnly) {
    let full = s;
    try { full = await Api.getStoryboard(s.id); } catch (e) { /* 降级用列表数据 */ }
    const yes = '<span style="color:#248A3D">可修改</span>';
    const no = '<span style="color:#7A7A7A">已完成，已锁定时长</span>';
    $('#detailTitle').textContent = previewOnly ? ('产物预览 · 分镜 ' + full.seq) : ('分镜 ' + full.seq + ' · 详情');
    $('#detailBody').innerHTML =
      (previewOnly && full.videoUrl
        ? '<div style="border-radius:12px;height:260px;background:' + full.grad + ';display:grid;place-items:center">' +
          '<div style="text-align:center;color:#fff">' + I.play + '<div style="margin-top:10px;font-size:12.5px">' + esc(full.ratio) + ' · ' + full.durationSec + 's · ' + esc(full.resolution) + '</div>' +
          '<div style="font-family:var(--mono);font-size:11px;opacity:.8;margin-top:4px">' + esc(full.videoUrl) + '</div></div></div>'
        : '') +
      '<div class="sec-title">提示词</div>' +
      '<div style="font-size:12.5px;line-height:1.7;color:var(--ink80)">' + esc(full.prompt) + '</div>' +
      assetLockHTML(full) +
      '<div class="sec-title">参数</div>' +
      '<dl class="kv">' +
        '<dt>时长</dt><dd>' + full.durationSec + 's　' + (full.canEditDuration ? yes : no) + '</dd>' +
        '<dt>模型</dt><dd>' + esc(labelOf(opts().models, full.model) || full.model) + '</dd>' +
        '<dt>执行引擎</dt><dd>' + esc(full.plannedEngineLabel || '—') +
          (full.plannedEngineReason ? '<span class="hint-sm" style="display:block">' + esc(full.plannedEngineReason) + '</span>' : '') + '</dd>' +
        '<dt>画幅 / 分辨率</dt><dd>' + esc(full.ratio) + ' · ' + esc(full.resolution) + '</dd>' +
        '<dt>远端 ID</dt><dd>' + esc(full.remoteId || '（尚未分配）') + '</dd>' +
        '<dt>重试次数</dt><dd>' + full.retryCount + '</dd>' +
        (full.errorMessage ? '<dt>失败原因</dt><dd style="color:#D70015">' + esc(full.errorMessage) + '</dd>' : '') +
      '</dl>' +
      (full.cliCommand
        ? '<div class="sec-title">将要执行的 CLI 命令' +
          (full.dryRunStale ? '　<span class="hint-sm" style="color:#B25000">⚠ 下方是<b>已过期</b>的干跑记录</span>' : '') + '</div>' +
          (full.dryRunStale
            ? '<div class="banner warn"><span>这条干跑记录是在提示词 / 绑定素材 / 参数变动<b>之前</b>生成的，命令内容已不代表实际会执行的内容。' +
              '请重新「干跑提交」后再核对。</span></div>'
            : '') +
          '<div class="codebox">$ ' + esc(full.cliCommand) + '</div>'
        : '') +
      (full.logs && full.logs.length ? '<div class="sec-title">执行日志</div>' + full.logs.map((l) => '<div class="logline ' + esc(l.level || '') + '">' + esc(l.msg) + '</div>').join('') : '');
    S.detailFull = full;    // 供「复制区块 / 复制完整提示词」按钮取文本
    $('#detailMask').hidden = false;
  }

  /* ---------------------------------------------------------- 素材锁定展示
     回答一个原本无解的问题：「有参考图了，但谁参考哪张图？」
     图号 = 提交时 --image 的上传顺序；区块 = 提交时自动追加在提示词最前面的对应说明。
     这里把三件事摆在一起：① 图号表 ② 将追加的区块 ③ 注入后的完整提示词。 */
  function assetLockHTML(full) {
    const al = full.assetLock;
    if (!al) return '';
    const imgs = al.images || [];
    const auds = al.audios || [];
    const skipped = al.skipped || [];
    const issues = al.issues || [];
    if (!imgs.length && !auds.length && !skipped.length) return '';

    let h = '<div class="sec-title">素材锁定（提示词 → 参考图）</div>';

    h += '<div class="banner ' + (al.injected ? 'ok' : 'warn') + '"><span>' + (al.injected
      ? '提交时会自动在提示词<b>最前面</b>追加下面的「素材锁定」区块：把每张参考图指定到具体主体/场景，' +
        '并明确要求<b>只取外形、忽略参考图的静止姿势</b>。原文一字不改。'
      : (imgs.length
          ? '本分镜绑定了 ' + imgs.length + ' 张图，但按模型归属会走<b>画布</b>链路 —— 画布命令不带 --image，图片与锁定区块都不会发出。要真正用上参考图，请换用「创作 CLI」的型号。'
          : '尚未绑定任何参考图。')) + '</span></div>';

    if (imgs.length) {
      h += '<div class="lockmap">' + imgs.map((im) =>
        '<span class="lockrow"><i class="imgnum">图' + im.n + '</i>' +
        '<b>' + esc(im.name) + '</b><span class="hint-sm">' + esc(im.roleLabel) +
        (im.via ? ' · 自动匹配' : ' · 手工绑定') + '</span>' +
        '<code>@图片' + im.n + '</code></span>').join('') + '</div>';
    }
    if (auds.length) {
      h += '<div class="lockmap">' + auds.map((au) =>
        '<span class="lockrow"><i class="imgnum aud">音' + au.n + '</i><b>' + esc(au.name) + '</b>' +
        '<span class="hint-sm">音频 · 不占图片号</span><code>@音频' + au.n + '</code></span>').join('') + '</div>';
    }
    skipped.forEach((sk) => {
      h += '<div class="banner err"><span>素材「' + esc(sk.name) + '」未计入图号：' + esc(sk.reason) +
        '　<span class="hint-sm">它后面的图号不会因它顺延，但请优先修复，避免编号与预期不符。</span></span></div>';
    });
    issues.forEach((it) => {
      h += '<div class="banner ' + (it.level === 'warn' ? 'warn' : '') + '"><span>' + esc(it.message) + '</span></div>';
    });

    if (al.block) {
      h += '<div class="sec-title" style="font-size:12px">将追加的「素材锁定」区块' +
        '<button class="btn-mini" style="margin-left:8px" data-copy="lockblock">复制区块</button></div>' +
        '<div class="codebox" id="lockBlockBox">' + esc(al.block) + '</div>' +
        '<div class="sec-title" style="font-size:12px">注入后的完整提示词（= 实际发给模型的文本）' +
        '<button class="btn-mini" style="margin-left:8px" data-copy="promptwithlock">复制完整提示词</button></div>' +
        '<div class="codebox" id="lockPromptBox">' + esc(al.promptWithLock || '') + '</div>';
    }
    return h;
  }

  /* ---------------------------------------------------------- 事件绑定 */
  function bindStatic() {
    $('#btnImport').addEventListener('click', openImport);
    $('#importClose').addEventListener('click', closeImport);
    $('#importCancel').addEventListener('click', closeImport);
    $('#importMask').addEventListener('click', (e) => { if (e.target.id === 'importMask') closeImport(); });
    $('#btnSettings').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsMask').addEventListener('click', closeSettings);
    $('#detailClose').addEventListener('click', () => { $('#detailMask').hidden = true; });
    $('#detailMask').addEventListener('click', (e) => { if (e.target.id === 'detailMask') $('#detailMask').hidden = true; });

    // 干跑命令核对弹层
    $('#cmdClose').addEventListener('click', closeCmd);
    $('#cmdOk').addEventListener('click', closeCmd);
    $('#cmdMask').addEventListener('click', (e) => { if (e.target.id === 'cmdMask') closeCmd(); });
    $('#cmdCopyAll').addEventListener('click', copyAllCmds);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cmdMask').hidden) closeCmd(); });

    // 自动匹配参考图弹层
    $('#autoClose').addEventListener('click', closeAuto);
    $('#autoCancel').addEventListener('click', closeAuto);
    $('#autoMask').addEventListener('click', (e) => { if (e.target.id === 'autoMask') closeAuto(); });
    $('#autoApply').addEventListener('click', applyAutoMatch);
    $('#autoOverwrite').addEventListener('change', () => {
      if ($('#autoMask').hidden) return;
      // 预览进行中先记下，等忙完自动补跑一次（否则勾选后界面仍是旧结果，容易误判）
      if (S.autoBusy) { S.autoPending = true; return; }
      openAutoMatch();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#autoMask').hidden) closeAuto(); });

    // 按时长标注重算弹层
    $('#durClose').addEventListener('click', closeDur);
    $('#durCancel').addEventListener('click', closeDur);
    $('#durMask').addEventListener('click', (e) => { if (e.target.id === 'durMask') closeDur(); });
    $('#durApply').addEventListener('click', applyDurRecalc);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#durMask').hidden) closeDur(); });

    $('#btnDensity').addEventListener('click', (e) => {
      const on = $('#app').classList.toggle('compact');
      e.currentTarget.textContent = on ? '标准视图' : '紧凑视图';
    });
    $('#btnHistory').addEventListener('click', openRecords);

    /* 素材面板窄屏抽屉化：≤1180px 时面板固定在屏外（CSS），顶栏「素材」唤起、遮罩/Esc 关闭。
       宽屏面板常驻且按钮被 CSS 隐藏，这些函数在宽屏调用无副作用（matchMedia 不命中直接返回）。
       两个助手定义在模块层（bindStatic 之外）：表格点击委托里点「＋」也要唤起面板。 */
    $('#btnPanel').addEventListener('click', openPanelIfOverlay);
    $('#panelMask').addEventListener('click', closePanelIfOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#panel').classList.contains('open')) closePanelIfOverlay();
    });
    bindRecords();
    $('#pillModel').addEventListener('click', () => toast('模型为全局默认值，可在「设置」里修改'));
    $('#pillRatio').addEventListener('click', () => toast('画幅为全局默认值，可在「设置」里修改'));

    // 素材面板搜索：防抖 250ms，仅刷新面板，不重绘表格
    $('#panel').addEventListener('input', (e) => {
      if (e.target.id !== 'panelSearch') return;
      S.panelKeyword = e.target.value;
      clearTimeout(S.panelTimer);
      S.panelTimer = setTimeout(loadAssets, 250);
    });

    $('#importText').addEventListener('input', () => {
      clearTimeout(S.imp.timer);
      S.imp.timer = setTimeout(doPreview, 400);   // 防抖 400ms，与文档一致
    });
    $('#importCustom').addEventListener('input', () => {
      S.imp.delimiter = { type: 'custom', value: $('#importCustom').value };
      renderImportChips();
      clearTimeout(S.imp.timer);
      S.imp.timer = setTimeout(doPreview, 400);
    });
    $('#importChips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-dl]'); if (!b) return;
      const v = b.dataset.dl;
      if (v === 'newline') S.imp.delimiter = { type: 'newline', value: '' };
      else if (v === '__custom') S.imp.delimiter = { type: 'custom', value: $('#importCustom').value || ';;' };
      else S.imp.delimiter = { type: 'custom', value: v };
      $('#importCustom').value = S.imp.delimiter.value || '';
      renderImportChips(); doPreview();
    });
    $('#importOk').addEventListener('click', async () => {
      if (S.imp.busy) return;
      S.imp.busy = true;
      const ok = $('#importOk'); const txt = ok.textContent;
      ok.disabled = true; ok.textContent = '导入中…';
      try {
        const res = await Api.importConfirm(S.imp.raw, S.imp.delimiter, (S.settings || {}).defaults);
        toast('已创建 ' + res.createdCount + ' 个分镜', 'ok');
        res.created.forEach((c) => S.sel.add(c.id));
        closeImport();
        await loadList({ skeleton: false });
      } catch (e) { fail(e); }
      finally { S.imp.busy = false; ok.disabled = false; ok.textContent = txt; }
    });

    /* 「抽屉先显示、数据后刷新」的配套守卫（见 openSettings）：抽屉一打开就可交互，
       只要用户在后台刷新返回之前碰过任何设置项，就标记 dirty，后续不再用服务端旧值覆盖。
       用捕获阶段挂一次，避免逐个处理器去加。 */
    ['click', 'change', 'input'].forEach((ev) =>
      $('#settingsBody').addEventListener(ev, () => { S.settingsDirty = true; }, true));
    $('#settingsBody').addEventListener('click', (e) => {
      const cliact = e.target.closest('[data-cliact]');
      if (cliact) { runCliAction(cliact.dataset.cliact); return; }
      const dl = e.target.closest('[data-sdl]');
      if (dl) {
        const v = dl.dataset.sdl;
        const presets = opts().settings.delimiterPresets;
        if (v === 'newline') S.settings.delimiter = { type: 'newline', value: '' };
        else if (v === '__custom') S.settings.delimiter = { type: 'custom', value: persetsFix($('#setDelim') && $('#setDelim').value) };
        else S.settings.delimiter = { type: 'custom', value: v };
        renderSettings(); return;
      }
      const conc = e.target.closest('[data-conc]');
      if (conc) {
        const lim = opts().settings.concurrency;
        const max = lim.max > 0 ? lim.max : Infinity;   // max=0 表示不限制
        S.settings.queue.concurrency = Math.max(lim.min, Math.min(max, S.settings.queue.concurrency + Number(conc.dataset.conc)));
        renderSettings(); return;
      }
      if (e.target.closest('[data-toggle]')) { S.settings.queue.autoRetry = !S.settings.queue.autoRetry; renderSettings(); return; }
    });
    // 默认参数下拉：change 即改本地状态，「保存设置」时统一 PUT
    $('#settingsBody').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-set]');
      if (!sel || !S.settings || !S.settings.defaults) return;
      const k = sel.dataset.set;
      if (k === 'model') {
        const spec = modelSpecOf(opts(), sel.value);
        const d = S.settings.defaults;
        d.model = sel.value;
        if (spec) {
          if (spec.resolutions && spec.resolutions.length) {
            // 大小写不敏感匹配优先（720P ↔ 720p），否则取该模型首选档位
            const hit = spec.resolutions.find((v) => String(v).toLowerCase() === String(d.resolution).toLowerCase());
            d.resolution = hit || spec.resolutions[0];
          }
          if (spec.ratios && spec.ratios.length && !spec.ratios.includes(d.ratio)) d.ratio = spec.ratios[0];
          if (spec.duration) d.durationSec = Math.max(spec.duration.min, Math.min(spec.duration.max, d.durationSec));
        }
        renderSettings();
        return;
      }
      if (k === 'durationSec') S.settings.defaults.durationSec = Number(sel.value);
      else S.settings.defaults[k] = sel.value;
    });
    $('#settingsBody').addEventListener('input', (e) => {
      if (e.target.id === 'setDelim') {
        S.settings.delimiter = { type: 'custom', value: e.target.value };
        const ex = $('.example .in', $('#settingsBody'));
        if (ex) ex.textContent = '镜头推进' + (e.target.value || '↵') + '雨滴落在玻璃窗';
      }
    });
    $('#settingsSave').addEventListener('click', async () => {
      try {
        S.settings = await Api.putSettings(S.settings);
        S.adapter = await Api.getAdapter();
        const adj = S.settings.adjustments;
        if (adj && adj.length) adj.forEach((a) => toast('已按模型规格调整：' + a, 'err'));
        else toast('设置已保存', 'ok');
        closeSettings();
        await loadList({ skeleton: false });
      } catch (e) { fail(e); }
    });
    $('#settingsReset').addEventListener('click', async () => {
      if (!(await uiConfirm('恢复默认', '恢复分隔符、默认参数与队列设置为默认值？'))) return;
      try {
        S.settings = await Api.resetSettings(['delimiter', 'defaults', 'queue']);
        renderSettings(); toast('已恢复默认', 'ok');
      } catch (e) { fail(e); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closeMenu();
      if (!$('#importMask').hidden) closeImport();
      if ($('#settingsDrawer').classList.contains('open')) closeSettings();
      $('#detailMask').hidden = true;
    });
  }
  const persetsFix = (v) => (v && v.trim()) ? v : ';;';

  /* ---------------------------------------------------------- 启动 */
  async function boot() {
    bindStatic();
    renderColhead();
    render();
    // 并行加载：列表/素材不等 meta——adapter 探测在冷启动时较慢，不应拖累首屏数据
    await Promise.all([loadMeta(), loadList(), loadAssets()]);
    // adapter 状态若仍在后台探测/刷新中，2.5s 后补拉一次纠正引擎状态显示
    setTimeout(async () => {
      try {
        const ad = await Api.getAdapter();
        S.adapter = ad;
        renderTopbar(); renderStatusbar();
        if ($('#settingsDrawer').classList.contains('open')) renderSettings();
      } catch (e) { /* 忽略 */ }
    }, 2500);
  }
  boot();
})();
