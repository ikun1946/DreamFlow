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
    tick:  '<svg width="11" height="11" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tickSm:'<svg width="9" height="9" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" stroke="#0066CC" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x:     '<svg width="9" height="9" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>',
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
    check: '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="#248A3D" stroke-width="1.8" fill="none"/><path d="M8 12.4l2.8 2.8L16 9.6" stroke="#248A3D" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  const STATUS_TEXT = { queued: '排队中', generating: '生成中', succeeded: '已完成', failed: '失败', canceled: '已取消' };
  const ROLE_META = {
    character:  { label: '角色',   type: 'character', multi: true,  key: 'characters' },
    scene:      { label: '场景',   type: 'scene',     multi: false, key: 'scene' },
    prop:       { label: '道具',   type: 'prop',      multi: false, key: 'prop' },
    firstFrame: { label: '首帧图', type: 'scene',     multi: false, key: 'firstFrame' },
    storyboard: { label: '分镜图', type: 'scene',     multi: false, key: 'storyboard' }
  };

  const COLUMNS = [
    { key: 'rail',   w: 44 },
    { key: 'prompt', w: 340, label: '分镜 / 提示词', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" stroke="#7A7A7A" stroke-width="2" stroke-linecap="round"/></svg>' },
    { key: 'character', w: 160, label: '角色', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.6" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><path d="M5 20c1.2-3.6 3.8-5.4 7-5.4s5.8 1.8 7 5.4" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linecap="round"/></svg>' },
    { key: 'scene', w: 100, label: '场景', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><circle cx="8.5" cy="10" r="1.6" stroke="#7A7A7A" stroke-width="1.7" fill="none"/></svg>' },
    { key: 'prop', w: 100, label: '道具', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M12 3.5l8 4.5v8l-8 4.5-8-4.5V8z" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linejoin="round"/><path d="M4 8l8 4.5L20 8M12 12.5v8" stroke="#7A7A7A" stroke-width="1.9" fill="none"/></svg>' },
    { key: 'firstFrame', w: 86, label: '首帧图', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M5 3.5v17" stroke="#7A7A7A" stroke-width="1.9" stroke-linecap="round"/><path d="M5 5.5h13l-2.6 3.8L18 13H5" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linejoin="round"/></svg>' },
    { key: 'storyboard', w: 84, label: '分镜图', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><rect x="13" y="13" width="8" height="8" rx="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/></svg>' },
    { key: 'result', w: 190, label: '结果与进度', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><rect x="2.5" y="5" width="13.5" height="14" rx="2.5" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><path d="M16.5 10.2l5-2.7v9l-5-2.7z" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linejoin="round"/></svg>' },
    { key: 'status', w: 94, label: '状态', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><path d="M8.5 12.2l2.6 2.6 4.6-5" stroke="#7A7A7A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
    { key: 'acts', w: 82, label: '操作', icon: '<svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 8h10M18 8h2M4 16h4M12 16h8" stroke="#7A7A7A" stroke-width="1.9" stroke-linecap="round"/><circle cx="16" cy="8" r="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/><circle cx="10" cy="16" r="2" stroke="#7A7A7A" stroke-width="1.9" fill="none"/></svg>' }
  ];

  /* ---------------------------------------------------------- 状态 */
  const S = {
    list: [], stats: null, options: null, adapter: null, settings: null,
    sel: new Set(), filter: 'all', keyword: '',
    panelTab: 'character', panelKeyword: '', assets: [], assetCounts: { currentShot: 0, library: 0 },
    bindTarget: null,            // { id, role }
    loading: true, error: null, busy: false,
    page: 1, pageSize: 50,
    poll: { timer: null, idle: 0 },
    imp: { raw: '', delimiter: { type: 'custom', value: ';;' }, preview: null, busy: false, timer: null }
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
  function renderColhead() {
    $('#colhead').innerHTML = COLUMNS.map((c) => {
      if (c.key === 'rail') return '<div class="c-rail">序号</div>';
      return '<div>' + c.icon + '<span>' + c.label + '</span></div>';
    }).join('');
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
      out += '<span class="thumb" style="--g:' + (a.grad || Api.grad(a.assetId)) + '" title="' + esc(a.name) + '">' +
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
        '<span class="prompt-meta">模型 ' + esc(s.model) + ' · ' + s.ratio + ' · ' + s.resolution + ' · motion ' + Number(s.motion).toFixed(2) + '</span>' +
      '</div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'character') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'scene') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'prop') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'firstFrame') + '</span></div>' +
      '<div class="cell"><span class="slots">' + slotsHTML(s, 'storyboard') + '</span></div>' +
      '<div class="cell result">' + resultHTML(s) + '</div>' +
      '<div class="cell"><span class="badge ' + s.status + '">' + STATUS_TEXT[s.status] + '</span></div>' +
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
  }

  /* ---------------------------------------------------------- 素材面板 */
  function renderPanel() {
    const tabs = ['character', 'scene', 'prop'];
    const tabLabel = { character: '角色', scene: '场景', prop: '道具' };
    const act = document.activeElement;
    const keepSearch = act && act.id === 'panelSearch' ? act.selectionStart : null;

    $('#panel').innerHTML =
      '<div class="panel-top">' +
        '<span class="seg">' + tabs.map((t) =>
          '<button data-tab="' + t + '"' + (S.panelTab === t ? ' class="on"' : '') + '>' + tabLabel[t] + '</button>').join('') + '</span>' +
        '<span class="grow"></span>' +
        '<button class="btn-primary" style="padding:8px 13px;font-size:11.5px" id="btnSubmitSel">提交所选' + (S.sel.size ? ' ' + S.sel.size : '') + '</button>' +
      '</div>' +
      '<label class="panel-search">' + I.search +
        '<input id="panelSearch" placeholder="搜索' + tabLabel[S.panelTab] + '" value="' + esc(S.panelKeyword) + '" />' +
      '</label>' +
      '<div class="panel-list">' +
        '<div class="sec-head"><b>本分镜素材 (' + S.assetCounts.currentShot + ')</b><span class="grow"></span><span>' +
          (S.bindTarget ? '点击下方素材添加到分镜 ' + (rowById(S.bindTarget.id) || {}).seq : '点表格里的 ＋ 后在此选择') + '</span></div>' +
        (S.assetCounts.currentShot
          ? '<div class="grid">' + S.assets.filter((a) => a.inCurrentShot).map(cardHTML).join('') + '</div>'
          : '<div class="empty-mini">当前分镜还没有在此分类下绑定素材</div>') +
        '<div class="sec-head"><b>素材库全部 (' + S.assetCounts.library + ')</b><span class="grow"></span><span>点击即可添加</span></div>' +
        (S.assets.length
          ? '<div class="grid">' + S.assets.map(cardHTML).join('') + '</div>'
          : '<div class="empty-mini">没有匹配的素材</div>') +
      '</div>';

    function cardHTML(a) {
      return '<div class="acard' + (a.inCurrentShot ? ' used' : '') + '" data-asset="' + a.id + '">' +
        '<span class="pic" style="--g:' + a.grad + '"><span class="tick">' + I.tickSm + '</span></span>' +
        '<span class="nm">' + esc(a.name) + '</span>' +
      '</div>';
    }

    // 搜索时保留焦点与光标位置，避免每敲一个字就失焦
    if (keepSearch !== null) {
      const el = $('#panelSearch');
      if (el) { el.focus(); try { el.setSelectionRange(keepSearch, keepSearch); } catch (e) { /* noop */ } }
    }
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
    $('#statusbar').innerHTML =
      '<span>适配器 <b>' + (S.adapter ? S.adapter.mode : '—') + '</b></span>' +
      '<span>并发 <b>' + (S.settings ? S.settings.queue.concurrency : '—') + '</b></span>' +
      '<span>已选 <b>' + n + '</b> 项</span>' +
      (n
        ? '<button class="btn-mini" data-batch="duration">批量改时长</button>' +
          '<button class="btn-mini" data-batch="delete">删除所选</button>' +
          '<button class="btn-mini" data-batch="clear">取消选择</button>'
        : '') +
      '<span class="grow"></span>' +
      '<span>显示 <b>' + S.list.length + '</b> 条，共 <b>' + (st.total || 0) + '</b> 个分镜</span>' +
      '<span>整体进度 <b>' + (st.overallProgress || 0) + '%</b></span>' +
      '<span class="minibar"><i style="width:' + (st.overallProgress || 0) + '%"></i></span>' +
      '<span>预计剩余 <b>' + mmss(st.etaSeconds) + '</b></span>';
  }

  function render() { renderTopbar(); renderTable(); renderPanel(); renderStatusbar(); }
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
  const POLL_BASE = () => (Api.CFG.apiMode === 'mock' ? 1200 : 3000);

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
        if (!confirm('删除分镜 ' + s.seq + '？此操作不可撤销。')) return;
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

  async function onAssetClick(assetId) {
    const role = S.bindTarget ? S.bindTarget.role : (S.panelTab === 'character' ? 'character' : S.panelTab);
    let targetId = S.bindTarget ? S.bindTarget.id : null;
    if (!targetId) {
      const selIds = Array.from(S.sel);
      if (selIds.length === 1) targetId = selIds[0];
      else if (selIds.length > 1) { toast('已选多条，请先在表格点某个分镜的 ＋ 槽位', 'err'); return; }
      else if (S.list.length === 1) targetId = S.list[0].id;
      else { toast('请先在表格里点某个分镜的 ＋ 槽位，再选择素材', 'err'); return; }
    }
    const target = rowById(targetId);
    if (!target) return;
    try {
      await Api.bindAsset(target.id, assetId, role);
      toast('已添加到分镜 ' + target.seq, 'ok');
      S.bindTarget = null;
      await loadList({ skeleton: false });
      await loadAssets();
    } catch (e) { fail(e); }
  }

  /* ---------------------------------------------------------- 批量操作 */
  async function submitSelected() {
    if (!S.sel.size) { toast('请先勾选要提交的分镜', 'err'); return; }
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

  /* 批量操作（入口在底部状态栏，勾选后才出现） */
  async function onBatch(kind) {
    const ids = Array.from(S.sel);
    if (!ids.length) return;

    if (kind === 'clear') { S.sel.clear(); renderTable(); renderPanel(); renderStatusbar(); return; }

    if (kind === 'duration') {
      const d = opts().duration;
      const input = prompt('把选中的 ' + ids.length + ' 个分镜时长统一设为（' + d.min + '–' + d.max + ' 秒）：', String(d.defaultValue));
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
      if (!confirm('删除选中的 ' + ids.length + ' 个分镜？运行中的会一并停止，且不可撤销。')) return;
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
    if (e.target.closest('[data-act="reload"]')) await loadList();
    if (e.target.closest('[data-act="openImport"]')) openImport();
    const locked = e.target.closest('[data-locked]');
    if (locked) toast('该分镜已完成生成，修改时长需重新生成', 'err');
  });

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
  async function openSettings() {
    try { S.settings = await Api.getSettings(); S.adapter = await Api.getAdapter(); } catch (e) { fail(e); }
    renderSettings();
    $('#settingsMask').hidden = false;
    $('#settingsDrawer').classList.add('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    $('#settingsMask').hidden = true;
    $('#settingsDrawer').classList.remove('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'true');
  }
  function renderSettings() {
    const s = S.settings || Api.META && { delimiter: { type: 'custom', value: ';;' }, defaults: {}, queue: {}, adapter: {} };
    const o = opts();
    const presets = o.settings.delimiterPresets;
    const isNL = s.delimiter.type === 'newline';
    $('#settingsBody').innerHTML =
      '<div class="sgroup"><b>提示词分隔符</b><span>导入时按此符号把粘贴文本拆分为多个分镜</span></div>' +
      '<div class="chips">' +
        '<button data-sdl="newline"' + (isNL ? ' class="on"' : '') + '>换行符</button>' +
        presets.map((p) => '<button data-sdl="' + esc(p) + '"' + (!isNL && s.delimiter.value === p ? ' class="on"' : '') + '>' + esc(p) + '</button>').join('') +
        '<button class="dashed" data-sdl="__custom"' + (!isNL && presets.indexOf(s.delimiter.value) < 0 ? ' class="on dashed"' : '') + '>自定义</button>' +
      '</div>' +
      '<div class="row-inline"><span class="label-sm">自定义符号</span>' +
        '<input class="input-sm" id="setDelim" style="width:180px" value="' + esc(s.delimiter.value || '') + '" />' +
        '<span class="hint-sm">留空表示按换行拆分</span></div>' +
      '<div class="example"><span class="lab">拆分示例</span>' +
        '<span class="in">镜头推进' + esc(s.delimiter.value || '↵') + '雨滴落在玻璃窗</span>' +
        '<span class="out">拆分为 2 个分镜</span></div>' +
      '<div class="hr"></div>' +
      '<div class="sgroup"><b>生成参数默认值</b><span>导入或新增分镜时套用的默认值</span></div>' +
      '<div class="srow"><span class="k">默认模型</span><span class="v" data-cyc="model">' + esc(labelOf(o.models, s.defaults.model) || s.defaults.model) + '</span></div>' +
      '<div class="srow"><span class="k">默认画幅与分辨率</span><span class="v" data-cyc="ratio">' + s.defaults.ratio + ' · ' + s.defaults.resolution + '</span></div>' +
      '<div class="srow"><span class="k">默认时长</span><span class="v" data-cyc="duration">' + s.defaults.durationSec + 's</span></div>' +
      '<div class="hr"></div>' +
      '<div class="sgroup"><b>队列与执行</b><span>控制同时生成的分镜数量与失败处理</span></div>' +
      '<div class="srow"><span class="k">并发数</span>' +
        '<span class="stepper"><button data-conc="-1">−</button><b>' + s.queue.concurrency + '</b><button data-conc="1">＋</button></span></div>' +
      '<div class="srow"><span class="k">失败自动重试（最多 ' + s.queue.maxRetry + ' 次）</span>' +
        '<span class="switch' + (s.queue.autoRetry ? ' on' : '') + '" data-toggle="autoRetry"><i></i></span></div>' +
      '<div class="hr"></div>' +
      '<div class="sgroup"><b>接口对接</b><span>与即梦 CLI 的本地桥接状态</span></div>' +
      '<div class="chips"><button data-mode="mock"' + (s.adapter.mode === 'mock' ? ' class="on"' : '') + '>Mock 模式</button>' +
        '<button data-mode="cli"' + (s.adapter.mode === 'cli' ? ' class="on"' : '') + '>CLI 模式</button></div>' +
      '<div class="statecard' + (s.adapter.cliAvailable ? ' ok' : '') + '">' +
        (s.adapter.cliAvailable ? I.check : I.warn) +
        '<span>' + (s.adapter.cliAvailable ? 'jimeng CLI 已就绪' : 'jimeng CLI 未检测到，任务将入队但不执行') + '</span></div>';
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
      '<div class="sec-title">参数</div>' +
      '<dl class="kv">' +
        '<dt>时长</dt><dd>' + full.durationSec + 's　' + (full.canEditDuration ? yes : no) + '</dd>' +
        '<dt>模型</dt><dd>' + esc(full.model) + '</dd>' +
        '<dt>画幅 / 分辨率</dt><dd>' + esc(full.ratio) + ' · ' + esc(full.resolution) + '</dd>' +
        '<dt>远端 ID</dt><dd>' + esc(full.remoteId || '（尚未分配）') + '</dd>' +
        '<dt>重试次数</dt><dd>' + full.retryCount + '</dd>' +
        (full.errorMessage ? '<dt>失败原因</dt><dd style="color:#D70015">' + esc(full.errorMessage) + '</dd>' : '') +
      '</dl>' +
      (full.cliCommand ? '<div class="sec-title">将要执行的 CLI 命令</div><div class="codebox">$ ' + esc(full.cliCommand) + '</div>' : '') +
      (full.logs && full.logs.length ? '<div class="sec-title">执行日志</div>' + full.logs.map((l) => '<div class="logline ' + esc(l.level || '') + '">' + esc(l.msg) + '</div>').join('') : '');
    $('#detailMask').hidden = false;
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

    $('#btnDensity').addEventListener('click', (e) => {
      const on = $('#app').classList.toggle('compact');
      e.currentTarget.textContent = on ? '标准视图' : '紧凑视图';
    });
    $('#btnHistory').addEventListener('click', () => toast('生成记录页不在本次对接范围内'));
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

    $('#settingsBody').addEventListener('click', (e) => {
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
        S.settings.queue.concurrency = Math.max(lim.min, Math.min(lim.max, S.settings.queue.concurrency + Number(conc.dataset.conc)));
        renderSettings(); return;
      }
      if (e.target.closest('[data-toggle]')) { S.settings.queue.autoRetry = !S.settings.queue.autoRetry; renderSettings(); return; }
      const mode = e.target.closest('[data-mode]');
      if (mode) { S.settings.adapter.mode = mode.dataset.mode; renderSettings(); return; }
      const cyc = e.target.closest('[data-cyc]');
      if (cyc) {
        const k = cyc.dataset.cyc;
        const o = opts();
        if (k === 'model') {
          const list = o.models.filter((m) => m.enabled);
          const i = list.findIndex((m) => m.value === S.settings.defaults.model);
          S.settings.defaults.model = list[(i + 1) % list.length].value;
        } else if (k === 'ratio') {
          const i = o.ratios.findIndex((r) => r.value === S.settings.defaults.ratio);
          const r = o.ratios[(i + 1) % o.ratios.length];
          const j = o.resolutions.findIndex((x) => x.value === S.settings.defaults.resolution);
          const res = o.resolutions[(j + 1) % o.resolutions.length];
          if (r.value === o.ratios[0].value && i !== -1) S.settings.defaults.resolution = res.value;
          S.settings.defaults.ratio = r.value;
        } else if (k === 'duration') {
          const d = o.duration;
          S.settings.defaults.durationSec = S.settings.defaults.durationSec >= d.max ? d.min : S.settings.defaults.durationSec + 1;
        }
        renderSettings(); return;
      }
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
        toast('设置已保存', 'ok');
        closeSettings();
        await loadList({ skeleton: false });
      } catch (e) { fail(e); }
    });
    $('#settingsReset').addEventListener('click', async () => {
      if (!confirm('恢复分隔符、默认参数与队列设置为默认值？')) return;
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
    await loadMeta();
    await loadList();
    await loadAssets();
    Api.resumeEngine();
    if (Api.CFG.apiMode === 'mock') {
      console.log('%c即梦批量生成控制台 · 演示数据运行中', 'color:#0066CC;font-weight:bold');
      console.log('接口层在 api.js，改 window.APP_CONFIG.apiMode = "http" 即切到真实后端');
    }
  }
  boot();
})();
