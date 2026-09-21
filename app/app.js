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

  /* 产物 / 素材地址：后端给的是 `/files/…`、`/media/assets/…` 这类**同源相对路径**。
     页面由后端托管时直接用没问题；但以 `file://` 打开发布版单文件时，相对路径会解析到
     本地磁盘（`file:///files/…`）→ 必然取不到。所以这里补上后端 origin，
     判定方式与 api.js 的 baseUrl 一致（绝对地址 / blob / data 原样返回）。 */
  function mediaUrl(u) {
    const s = String(u || '');
    if (!s) return '';
    if (/^(https?:|blob:|data:)/i.test(s)) return s;
    const m = String((Api.CFG && Api.CFG.baseUrl) || '').match(/^(https?:\/\/[^/]+)/i);
    return (m ? m[1] : '') + (s.charAt(0) === '/' ? s : '/' + s);
  }

  /* ------------------------------------------------ 错误码 → 文案兜底 */
  const ERR_TEXT = {
    40001: '参数不合法', 40100: '登录已失效，请重新登录', 40300: '没有权限',
    40400: '内容不存在', 40900: '当前状态不允许该操作', 42900: '请求过于频繁，已自动重试',
    50000: '服务异常，请稍后重试',
    51001: '即梦 CLI 未连接，请检查本地桥接服务',
    51002: '积分不足，无法生成该分镜',
    51003: '内容未通过审核，建议调整提示词后重试',
    51004: '生成超时，可稍后重试',
    51005: '生成被中断，可重试',
    /* 外部工具状态（2026-09-21，与 server/util.js 的 511xx 对齐）。
       后端在这类错误上会带**更具体**的 message，所以 errText 优先用 message；
       这几条只是"没有 message 时的兜底"，以及给"去处理"按钮提供文案锚点。 */
    51101: '未检测到创作 CLI（dreamina），无法生成视频',
    51102: '创作 CLI 已安装但未登录，请先登录即梦账号',
    51103: '即梦侧拒绝了本次提交（会员或权限不足，重试无效）',
    51104: '未检测到 ffmpeg，视频可正常生成但不会生成封面图',
    51105: '未检测到 ffprobe，无法读取音频时长，绑定音频会被拒绝'
  };
  const errText = (e) => (e && e.message) || ERR_TEXT[e && e.code] || '操作失败，请稍后重试';

  /* 工具类错误的「可执行解决动作」文案（2026-09-21）。
     后端在 511xx 错误的 data.action 里给出动作标识，这里映射成按钮文字。
     为什么放在前端：动作是**界面行为**（跳设置页 / 打开 CLI 安装），
     后端只该声明"该做什么"，不该知道界面长什么样。 */
  const TOOL_ACTION_TEXT = {
    'install-cli': '去安装创作 CLI',
    'cli-login': '去登录即梦账号',
    'install-ffmpeg': '去配置 ffmpeg / ffprobe',
    'upgrade-or-switch-model': '切换可用模型'
  };
  const toolActionText = (a) => (a && TOOL_ACTION_TEXT[a]) || null;

  /* ---------------------------------------------------------- 图标
     ⚠ v0.21.0（B 阶段）：内联 SVG 一律改用 `currentColor` 描边/填充，颜色交由**承载它的
        容器元素**（按钮/单元格/卡片）通过 CSS 的 `color` 提供 —— 这样深色模式下图标会
        随容器的语义令牌一起翻转。容器颜色见 styles.css 里各容器选择器旁的注释。
     三类**豁免**（保持写死的颜色，因为其所在上下文两主题都不变）：
       ① `I.tick` / `I.x` / `I.expand`：白描边，只落在**深色底/主色底/半透明 scrim** 上
          （勾选框、素材卡删除钮、全屏钮），白在深底上两主题都正确；
       ② `I.play`：黑色半透明圆底盘 + 白播放三角，压在缩略图/封面上；
       ③ `I.copy` / `I.img` / `I.notePh`：本就是 currentColor（由按钮/占位容器着色）。 */
  const I = {
    minus: '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M5.5 12h13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    plus:  '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    add:   '<svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    tick:  '<svg width="11" height="11" viewBox="0 0 24 24"><path d="M5.5 12.5l4 4L18.5 7.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    tickSm:'<svg width="9" height="9" viewBox="0 0 24 24"><path d="M5.5 12.5l4 4L18.5 7.5" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x:     '<svg width="9" height="9" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>',
    // 深色 ×：用于白底容器（弹层标题栏、详情栏）。I.x 是白描边，只适合深色底，别混用
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
    // 放大图标（深色描边，用于白底表格）：I.expand 是白描边，只适合深色底，别混用
    expandDark: '<svg width="12" height="12" viewBox="0 0 24 24"><path d="M14.5 4H20v5.5M9.5 20H4v-5.5M20 4l-6.5 6.5M4 20l6.5-6.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    // 复制图标：描边用 currentColor，由按钮的 color 控制（浅色块 / 深色代码块上都能用）
    copy:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="8.6" y="8.6" width="11.8" height="11.8" rx="2.4" stroke="currentColor" stroke-width="2"/><path d="M15.4 5.7A2.4 2.4 0 0013.3 4H6.4A2.4 2.4 0 004 6.4v6.9a2.4 2.4 0 001.7 2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    // 图片占位图标：描边用 currentColor，由 CSS 控制颜色与透明度（半透明占位样式）
    img:   '<svg width="42" height="42" viewBox="0 0 24 24" fill="none"><rect x="3" y="4.6" width="18" height="14.8" rx="3" stroke="currentColor" stroke-width="1.5"/><circle cx="8.7" cy="9.7" r="1.6" stroke="currentColor" stroke-width="1.5"/><path d="M3.7 16.4l4.5-4.1 3.3 2.9 3-2.5 5.8 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    /* 音符（占位用）：与 I.img 同为 currentColor 描边风格，好让音频与"无图图片素材"
       共用同一套半透明空槽位视觉（卡片 / 详情弹窗 / 素材预览 / 选择弹窗四处都用它）。
       ⚠ 必须用 currentColor 而不是写死 fill —— 它要落在浅色底上，由 CSS 的
       `.ph-ico{color:var(--ink);opacity:.26}` 控制深浅。 */
    notePh: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none"><circle cx="6.6" cy="17.6" r="2.6" stroke="currentColor" stroke-width="1.5"/><circle cx="16.4" cy="15.6" r="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M9.2 17.6V6.4l9.8-2.2v11.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  const STATUS_TEXT = { draft: '未提交', queued: '排队中', generating: '生成中', succeeded: '已完成', failed: '失败', canceled: '已取消' };
  /* 槽位定义：每个槽位 ↔ 一个**独立**的资产库（type 即资产类型）。
     ⚠ 2026-09-20 修两处：
       ① prop 从单值改为**多值**（原来绑一张就没了，用户报"没有可用槽位"）；
       ② firstFrame / storyboard 原来都被指到 'scene' —— 于是这两类素材无处存放，
          点开槽位只看到场景图、必然"资产缺失"。现在各有自己的库。
     `multi` 必须与后端 `services.js` 的 ROLE_MULTI 一致（两边都以此为准，改一处要同步另一处）。 */
  /* ⚠ multi 必须与后端 server/services.js 的 ROLE_MULTI **保持一致**（两处各有一份表，
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

  /* ---------------------------------------------------------- 状态 */
  const S = {
    /* ---------------- 多项目上下文（指令 §25：只有前端能有"当前项目"这个概念） ----------------
       view 决定当前显示哪一层：
         'home'      首页（项目列表）
         'project'   项目主页（分镜表列表 + 资产库 + 记录 + 项目设置）
         'workspace' 工作区视图（就是既有那张分镜表）
       cur 是**唯一的**当前作用域来源，Api.setScope() 由它同步过去；
       所有请求都显式带作用域，后端据此过滤（后端不存在"当前项目"全局变量）。 */
    view: 'home',
    cur: { projectId: '', workspaceId: '', project: null, workspace: null },
    home: { loading: false, error: null, list: [], total: 0 },
    proj: { loading: false, error: null, tab: 'pages', workspaces: [], assets: [], assetTab: 'character', assetKeyword: '' },

    list: [], stats: null, options: null, adapter: null, settings: null,
    sel: new Set(), filter: 'all', keyword: '',
    panelTab: 'character', panelKeyword: '', assets: [], assetCounts: { currentShot: 0, library: 0 },
    /* 全库「素材名(小写) → 类型」索引：给提示词里的素材名着色用。
       必须覆盖全部分类，否则场景/道具的名字着不出颜色。 */
    assetIndex: new Map(),
    assetBusy: null, assetMsg: '',
    assetSelMode: false, assetSel: new Set(),
    /* 区间选择的输入值：面板/状态栏会被频繁重绘，值必须留在 state 里，
       否则用户刚打完「起始」序号，一次重绘就把它清空了。 */
    assetRange: { from: '', to: '' }, selRange: { from: '', to: '' },
    bindTarget: null,            // { id, role }
    detailFull: null,            // 最近一次打开的详情数据（复制锁定区块 / 完整提示词用）
    loading: true, error: null, busy: false,
    page: 1, pageSize: 50,
    /* lastSig：上一轮 /storyboards/progress 的载荷签名。服务端不再"读后清" dirty，
       所以"有没有变化"改由前端按签名判断（详见 pollOnce）。
       gen：**轮询代际令牌**（指令 §38/§39）。切换项目/分镜表时 +1，
       在飞的旧响应回来时代际已变，直接丢弃 —— 否则 A 表的进度会画到 B 表的表格上。 */
    poll: { timer: null, idle: 0, lastSig: null, gen: 0 },
    imp: { raw: '', delimiter: { type: 'custom', value: ';;' }, preview: null, busy: false, timer: null, seq: 0, impType: null },   // impType = 本次导入的目标素材类型（由打开它的入口决定）
    cliBusy: null, cliMsg: '', cliUrl: null, cliUserCode: null, cliRaw: null,
    /* 创作 CLI 的安装/更新状态（来自 GET /system/cli，见 server/cli-installer.js）。
       null = 还没拉到；拉失败也保持 null，界面退回"不显示安装向导"而不是报错。 */
    cliInfo: null,
    /* 桌面版的应用更新状态（来自 window.JCDesktop.updateStatus）。
       网页版没有这个区块 —— 网页版的"更新"是在项目目录 git pull 后重启服务，
       不是应用内安装。 */
    appUpdate: null,
    settingsDirty: false,   // 抽屉本次打开期间用户是否已改动过设置（"先显示后刷新"的守卫）
    cliHint: null,          // 后端给的"下一步怎么做"提示（如手工执行 dreamina relogin）
    dCliUrl: null, dCliCode: null,   // 创作 CLI（dreamina）的授权链接与设备码，独立存放
    dryBusy: false,                 // 干跑提交进行中
    cmdRows: [], cmdAt: 0,                     // 命令核对面板数据
    autoBusy: false, autoRows: [], autoStats: null, autoIds: [], autoScopeAll: false, autoPending: false,   // 自动匹配
    durBusy: false, durRows: [], durStats: null, durIds: [], durScopeAll: false,       // 按时长标注重算
    /* 生成记录视图（全屏）：列表分页 + 筛选 + 选中详情。
       记录由后端在任务收尾时落盘（成功/失败/取消/干跑各一条），前端只读+删。 */
    rec: { loading: false, list: [], page: 1, pageSize: 20, total: 0, pageCount: 1, stats: null, kept: 0, capacity: 0 },
    recF: { action: 'all', outcome: 'all', engine: 'all', keyword: '', from: '', to: '' },
    recSel: null, recDetail: null, recDetailLoading: false, recTimer: null, recPoll: null,
    /* 模块级计时器（不在 S 里的那些）也要能在切换时清掉，这里统一收口 */
    patchTimers: {}, panelTimer: null
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
    /* 项目名与分镜表名改由面包屑呈现（多项目架构）：项目名来自 S.cur.project（真实数据），
       不再是后端 META 里的模块级常量。 */
    renderCrumb();
    /* 「第 N 批」这个概念已被 Workspace 取代（batchId 一直是硬编码的 'bt_21'，
       界面上从来没有设置入口）。分镜表名已经在面包屑里，这里只留分镜数。 */
    $('#scopeChip').textContent = (st.total || 0) + ' 个分镜';
    const d = S.settings && S.settings.defaults;
    /* 模型与画幅合并为一处纯文本（2026-09-20）：原先两个胶囊各带一个下拉箭头，但点了只弹一句
       "可在设置里修改"，并没有真正的下拉列表 —— 去掉假的下拉外观，合并成「模型 · 画幅」一行。
       具体含义由元素 title 说明，这里只放值，省下 ~80px 顶栏宽度。 */
    const mLabel = d ? (labelOf(opts().models, d.model) || d.model) : '—';
    $('#modelRatioTxt').textContent = mLabel + ' · ' + (d ? d.ratio : '—');
    /* 整体进度（2026-09-20 从底部状态栏移上来）：与底部同源，都读 S.stats，
       刷新时机也一致（renderTopbar 在 renderRowsOnly 里每轮轮询都会被调用）。 */
    const pct = st.overallProgress || 0;
    $('#tpPct').textContent = pct + '%';
    $('#tpBar').style.width = pct + '%';
    $('#tpEta').textContent = mmss(st.etaSeconds);
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
      /* 无图素材（提示词导入的那批）与卡片缩略图保持同一套半透明图片样式，不铺随机渐变 */
      const hasPic = !!(a.url && !/^(mock|cli):/.test(a.url) && a.type !== 'audio');
      const bg = hasPic
        ? 'background-image:url(' + a.url + ');background-size:cover;background-position:center;' : '';
      /* 图号徽标：这个号 = 提交时 --image 的上传顺序，也是提示词里该写的 @图片N。
         没有它，作者根本无法在提示词里指认「哪张图是谁」。 */
      const badge = a.imageIndex
        ? '<i class="imgnum" title="提交时作为第 ' + a.imageIndex + ' 张 --image 发出；提示词里用 @图片' + a.imageIndex + ' 引用它">图' + a.imageIndex + '</i>'
        : (a.audioIndex
            ? '<i class="imgnum aud" title="音频走 --audio，不占图片号">音' + a.audioIndex + '</i>'
            : (a.notCounted ? '<i class="imgnum bad" title="未计入图号：' + esc(a.notCounted) + '（后面的图号也不会因它顺延）">!</i>' : ''));
      /* 素材格本身可点（用户 2026-09-20 要求：点击已上传的素材即可预览与替换）。
         委托处理器里 data-unbind 分支排在前面，所以右上角的 × 仍然是「移除」，
         不会被这里抢走；框选引擎的 click 只在真正拖动过之后才吞，普通点击照常到达。 */
      const tip = esc(a.name) + (a.imageIndex ? '（图片' + a.imageIndex + '）' : '') + '　点击预览 / 替换';
      out += '<span class="thumb clickable' + (hasPic ? '' : ' no-pic') + '"' +
        ' data-bound="' + a.assetId + '" data-role="' + role + '"' +
        (hasPic ? ' style="' + bg + '--g:' + (a.grad || Api.grad(a.assetId)) + '"' : '') + ' title="' + tip + '">' +
        badge +
        '<span>' + esc(a.name) + '</span>' +
        '<button class="rm" data-unbind="' + a.assetId + '" data-role="' + role + '" title="移除">' + I.x + '</button>' +
        '</span>';
    });
    if (canAdd) {
      /* 参考图已达当前模型上限：按钮改成「满额」样式并说明原因。
         仍然可点（点击给出解释而不是毫无反应的禁用态），拦截在 data-bind 处理器里。 */
      /* 音频有两重上限（数量 + 总时长），图片只有数量 —— 提示语要说清是哪一条满了，
         否则用户看到"加不上"却不知道是该删一条还是该换短的音频。
         上限值都来自服务端（s.imageLimit / s.audioLimit / s.audioSecMax），不硬编码。 */
      let full = false, fullTip = '';
      if (role === 'audio') {
        const aMax = s.audioLimit;
        const secMax = s.audioSecMax;
        const overCount = aMax != null && (s.audioCount || 0) >= aMax;
        const overSec = secMax != null && Number(s.audioSecTotal || 0) >= Number(secMax);
        if (overCount || overSec) {
          full = true;
          fullTip = '已达音频上限：当前模型（' + esc(s.model) + '）最多 ' + aMax + ' 个' +
            (overSec ? '，且总时长已占 ' + s.audioSecTotal + ' / ' + secMax + ' 秒' : '') +
            '。可先移除一条，或改用时长更短的音频';
        }
      } else if (s.imageLimit != null && (s.imageCount || 0) >= s.imageLimit) {
        full = true;
        fullTip = '已达参考图上限：当前模型（' + esc(s.model) + '）最多 ' + s.imageLimit + ' 张，已用满 ' + s.imageCount + ' 张';
      }
      out += '<button class="slot-add' + (full ? ' full' : '') + '" data-bind="' + role + '" title="' +
        (full ? fullTip : '添加' + meta.label) + '">' + I.add + '</button>';
    }
    if (!items.length && !canAdd) out += '<span class="dash">—</span>';
    return out;
  }

  function resultHTML(s) {
    let inner;
    if (s.status === 'succeeded') {
      /* 有封面就用封面（产物视频抽出的那一帧），没有才退回 ID 派生的渐变。
         封面由后端在下载产物时用本机 ffmpeg 抽帧生成 —— 创作 CLI 本身不给封面。 */
      const cover = s.coverUrl ? mediaUrl(s.coverUrl) : null;
      inner = '<span class="result-thumb' + (cover ? ' has-cover' : '') + '" data-preview="' + s.id + '"' +
        ' style="--g:' + s.grad + (cover ? ';background-image:url(' + esc(cover) + ')' : '') + '"' +
        ' title="预览产物">' + I.play + '</span>';
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

  /* 提示词里的素材名着色：命中「全库素材名」的词按素材类型套不同颜色。
     实现要点：
     · 在**原文**上匹配再分段转义 —— 若先 esc 再替换，`&` → `&amp;` 会让下标全错位；
     · 名称按长度倒序拼成一条交替式正则，正则引擎优先匹配靠前的分支 ⇒ 长名先命中，
       「林晚」不会被更短的「林」抢走，重叠部分也不会重复标注。 */
  function highlightPrompt(text) {
    const src = String(text == null ? '' : text);
    const idx = S.assetIndex;
    if (!idx || !idx.size) return esc(src);
    const names = Array.from(idx.keys()).filter((n) => n.length >= 1)
      .sort((a, b) => b.length - a.length).slice(0, 500);
    if (!names.length) return esc(src);
    const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    let out = '', pos = 0, hit = false;
    for (const m of src.matchAll(re)) {
      hit = true;
      out += esc(src.slice(pos, m.index)) +
        '<mark class="hl hl-' + esc(idx.get(m[0].toLowerCase()) || 'other') + '">' + esc(m[0]) + '</mark>';
      pos = m.index + m[0].length;
    }
    return hit ? out + esc(src.slice(pos)) : esc(src);
  }

  function rowHTML(s) {
    const sel = S.sel.has(s.id);
    return '<div class="row' + (sel ? ' sel' : '') + '" data-id="' + s.id + '">' +
      '<div class="cell rail">' +
        '<span class="rail-num">' + s.seq + '</span>' +
        '<button class="cbx' + (sel ? ' on' : '') + '" data-check="1" title="选择">' + I.tick + '</button>' +
      '</div>' +
      '<div class="cell prompt">' +
        '<span class="titleline"><span class="shotno">分镜 ' + s.seq + '</span>' + durHTML(s) +
          '<span class="grow"></span>' +
          '<button class="zoom-btn" data-zoom="' + s.id + '" title="放大查看完整提示词（含素材名着色）">' + I.expandDark + '</button>' +
        '</span>' +
        '<span class="prompt-text">' + highlightPrompt(s.prompt) + '</span>' +
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
        '<svg width="44" height="44" viewBox="0 0 24 24"><rect x="2.5" y="4.5" width="19" height="15" rx="3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2.5 8.5h19" stroke="currentColor" stroke-width="1.3"/></svg>' +
        '<b>' + (S.keyword || S.filter !== 'all' ? '没有符合条件的分镜' : '还没有分镜') + '</b>' +
        '<span>' + (S.keyword || S.filter !== 'all' ? '试试清空搜索或切换筛选' : '把多段提示词粘进来，一次创建整批分镜') + '</span>' +
        (S.keyword || S.filter !== 'all' ? '' : '<button class="btn-primary" data-act="openImport" title="批量导入提示词">批量导入</button>') +
        '</div>';
      return;
    }
    host.innerHTML = S.list.map(rowHTML).join('');
    updateCheckAll();
  }

  /* ---------------------------------------------------------- 显示偏好（个性化） */
  /* 表格密度的**唯一事实来源是 `#app` 上的 `.compact` 类** —— 与原来顶栏那个
     「紧凑视图」按钮完全同一套逻辑，只是入口从顶栏挪进了设置的「个性化」分区。
     读状态一律读这个类（而不是另存一份变量），否则设置抽屉每次重绘都可能与真实外观不一致。 */
  function isCompact() {
    const el = $('#app');
    return !!(el && el.classList.contains('compact'));
  }
  function applyDensity(on) {
    const el = $('#app');
    if (el) el.classList.toggle('compact', !!on);
  }

  /* ---------------------------------------------------------- 主题（深色模式） */
  /* 三态外观：auto（跟随系统，默认）/ light / dark。
     **两个属性分工明确**（这是本设计的关键）：
       · <html data-theme-mode> = 用户的**选择**（auto|light|dark）—— 分段控件的选中态读它；
       · <html data-theme>      = 解析后的**实际主题**（light|dark）—— CSS 只认它。
     为什么不用 <html data-theme> 一个属性？因为 "auto" 解析后落到 light 或 dark，无法再区分
     "用户选了浅色" 与 "用户选跟随系统、系统恰是浅色"，分段控件就没法正确回显。
     落点必须在 <html> 而非 #app：.mask/.drawer/.recview/.pageview/.toasts 都是 #app 的兄弟/外部
     节点（见 index.html），放在 #app 上它们取不到令牌（与既有结构约束一致）。
     ⚠ 主题**绝不写入 S.settings**（它是"本页外观偏好"，与生成参数无关）——避免触发 settingsDirty
        或被服务端旧值覆盖；与 applyDensity 的既有语义保持一致。 */
  const THEME_KEY = 'jmc.theme';
  const THEME_VALUES = ['auto', 'light', 'dark'];
  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  /* 读"用户的选择"，唯一事实来源是 <html data-theme-mode>；非法/缺省回落 auto。 */
  function themeChoice() {
    const t = document.documentElement.dataset.themeMode;
    return THEME_VALUES.indexOf(t) >= 0 ? t : 'auto';
  }
  /* 读持久化镜像（只用于启动初始化与容错；运行期真相仍是 data-theme-mode）。 */
  function storedTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return THEME_VALUES.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  /* 应用某个选择：写 data-theme-mode + 解析出 data-theme。 */
  function applyTheme(v) {
    const val = THEME_VALUES.indexOf(v) >= 0 ? v : 'auto';
    const root = document.documentElement;
    root.dataset.themeMode = val;
    root.dataset.theme = (val === 'dark' || (val === 'auto' && systemDark())) ? 'dark' : 'light';
  }
  /* 切换主题（来自设置抽屉的分段控件）：应用 + 持久化（写失败静默，隐私模式下 localStorage 会抛）。 */
  function setTheme(v) {
    applyTheme(v);
    try { localStorage.setItem(THEME_KEY, themeChoice()); } catch (e) { /* 隐私模式忽略 */ }
  }
  /* 启动初始化：读持久化 → 应用；并监听系统偏好（**仅 auto 时**联动，显式选择不被系统覆盖）。 */
  function initTheme() {
    applyTheme(storedTheme());
    if (window.matchMedia) {
      try {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (themeChoice() === 'auto') applyTheme('auto'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
      } catch (e) { /* 旧浏览器忽略 */ }
    }
  }

  /* 顶栏主操作按钮的标签同步：「提交所选」要带上已选数量。
     按钮是 index.html 里的静态节点（不在任何会被重绘的容器里），所以只改文本、不重建节点 ——
     重建会打断进行中的点击，也会丢掉焦点与 hover 态。 */
  function syncTopActions() {
    const b = $('#btnSubmitSel');
    if (!b) return;
    b.textContent = '提交所选' + (S.sel.size ? ' ' + S.sel.size : '');
    b.title = S.sel.size
      ? '提交选中的 ' + S.sel.size + ' 个分镜'
      : '先在表格里勾选分镜，再点这里提交';
  }

  /* ---------------------------------------------------------- 素材面板 */
  /* 素材卡片的**唯一渲染处**（素材面板 与 项目资产库 共用）。
     ⚠ 为什么提到模块级：它原来嵌在 renderPanel 里面，项目资产库够不着，
     很容易就写成"再抄一份卡片 HTML"—— 而卡片上有 data-asset / data-assetdel
     这两个事件契约，抄一份就多一处会忘记同步的地方（表现为"点了没反应"）。
     改成显式传选项（selected / used），不再读环境的 S.assetSelMode。 */
  function assetCardHTML(a, o) {
    const opt = o || {};
    const isAudio = a.type === 'audio';
    /* 音频**没有可显示的封面**（音频文件抽不出有意义的缩略图），所以它和"无图图片素材"
       走同一条路：半透明空槽位（浅底 + 虚线框 + 淡图标），只是图标换成音符。
       原来音频铺按 id 派生的随机渐变 + 深色音符蒙层 —— 那是另一套视觉，看起来像"有封面"，
       实际上那个色块没有任何含义（用户要求改成与图片资产默认封面一致）。 */
    const hasPic = !!(a.url && !/^(mock|cli):/.test(a.url) && !isAudio);
    const phGlyph = hasPic ? '' : '<span class="ph-ico">' + (isAudio ? I.notePh : I.img) + '</span>';
    const picStyle = hasPic
      ? ' style="--g:' + a.grad + ';background-image:url(' + a.url + ');background-size:cover;background-position:center;"'
      : '';
    return '<div class="acard' + (opt.used ? ' used' : '') + (opt.selected ? ' sel' : '') +
      '" data-asset="' + a.id + '" title="' + esc(a.name) + '">' +
      '<span class="pic' + (hasPic ? '' : ' no-pic') + '"' + picStyle + '>' + phGlyph +
      '<span class="tick">' + I.tickSm + '</span>' +
      '<button class="rm" data-assetdel="' + a.id + '" title="删除素材">' + I.x + '</button></span>' +
      '<span class="nm">' + esc(a.name) + '</span>' +
    '</div>';
  }

  function renderPanel() {
    const tabs = ASSET_TABS;
    const tabLabel = ASSET_TAB_LABEL;
    const act = document.activeElement;
    const keepSearch = act && act.id === 'panelSearch' ? act.selectionStart : null;
    /* 分区头的说明只在**承载状态**时才出现：绑定目标（哪个分镜）/ 批量选择模式 / 本分类为空。
       默认态不再放"点击卡片打开素材设置"这类说明 —— 那是每屏都在、却没人看的噪音；
       卡片与按钮的 title 里都写着，且点一下就知道。 */
    const bindSeq = S.bindTarget ? (rowById(S.bindTarget.id) || {}).seq : null;
    const hintFor = (where) => {
      if (S.bindTarget) {
        const tail = bindSeq != null ? '到分镜 ' + bindSeq : '';
        return where === 'lib' ? '点击即可添加' + tail : '点击下方素材添加' + tail;
      }
      if (S.assetSelMode) return '点击卡片勾选';
      return '';
    };
    const curHint = hintFor('cur') || (S.assetCounts.currentShot ? '' : '暂无绑定');

    $('#panel').innerHTML =
      '<div class="panel-top">' +
        '<span class="seg">' + tabs.map((t) =>
          '<button data-tab="' + t + '"' + (S.panelTab === t ? ' class="on"' : '') + '>' + tabLabel[t] + '</button>').join('') + '</span>' +
      '</div>' +
      /* 动作区：2×2 网格，四颗按钮各占一格（同高、左右边缘对齐）。
         「干跑提交」原先在面板顶栏独占一行 —— 面板里白白吃掉一行高度，现在与素材动作同排。
         它原本那条「图片 / 提示词导入」提示文本从来没显示过（CSS 里 .panel-actions .hint-sm
         是 display:none），属于死文本，一并删除。 */
      '<div class="panel-actions">' +
        '<button class="btn-mini" data-assetact="openImport" title="两种模式：导入本地图片文件，或粘贴提示词文本（@ 分段自动识别 场景/道具/角色）"' + (S.assetBusy ? ' disabled' : '') + '>' + (S.assetBusy ? '导入中…' : '导入资产') + '</button>' +
        '<button class="btn-mini" data-assetact="batch" title="进入批量选择模式（操作在底部弹出的操作条中完成）"' + (S.assetBusy || S.assetSelMode ? ' disabled' : '') + '>批量选择</button>' +
        '<button class="btn-mini" id="btnAutoMatch" title="按素材名称在分镜提示词里匹配对应素材（图片与音色都匹配）并自动绑定（先预览，确认后再应用）"' + (S.autoBusy ? ' disabled' : '') + '>' + (S.autoBusy ? '匹配中…' : '自动匹配') + '</button>' +
        '<button class="btn-mini" id="btnDrySubmit" title="干跑：走完整提交链路组装命令，但不发送给即梦（不创建任务、不扣费），提交后在弹层里核对真实命令"' + (S.dryBusy ? ' disabled' : '') + '>' + (S.dryBusy ? '干跑中…' : '干跑提交') + '</button>' +
      '</div>' +
      (S.assetMsg ? '<div class="hint-sm asset-msg">' + esc(S.assetMsg) + '</div>' : '') +
      '<label class="panel-search">' + I.search +
        '<input id="panelSearch" placeholder="搜索' + tabLabel[S.panelTab] + '" value="' + esc(S.panelKeyword) + '" />' +
      '</label>' +
      '<div class="panel-list">' +
        /* 本分类为空时不再单占一块空态（原来那句"当前分镜还没有在此分类下绑定素材"有 16 个字），
           改在分区头右侧一行「暂无绑定」说清，省下一整块高度。 */
        '<div class="sec-head"><b>本分镜素材 (' + S.assetCounts.currentShot + ')</b><span class="grow"></span>' +
          (curHint ? '<span>' + curHint + '</span>' : '') + '</div>' +
        (S.assetCounts.currentShot
          ? '<div class="grid">' + S.assets.filter((a) => a.inCurrentShot).map(cardHTML).join('') + '</div>'
          : '') +
        '<div class="sec-head"><b>素材库 (' + S.assetCounts.library + ')</b><span class="grow"></span>' +
          (hintFor('lib') ? '<span>' + hintFor('lib') + '</span>' : '') + '</div>' +
        /* ⚠ 网格**始终渲染**（哪怕这一类为空）：新建瓦片在网格末尾，是空分类下唯一的新建入口。
           与项目页资产库同一套做法，别改成"只在有素材时才渲染网格"。 */
        '<div class="grid">' + S.assets.map(cardHTML).join('') + assetAddCardHTML(S.panelTab) + '</div>' +
        (S.assets.length ? '' : '<div class="empty-mini">没有匹配的素材</div>') +
      '</div>';

    function cardHTML(a) {
      return assetCardHTML(a, {
        selected: !!(S.assetSelMode && S.assetSel.has(a.id)),
        used: !!a.inCurrentShot
      });
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
    const snap = snapRange('as');          // 重绘前记下区间输入框，重绘后还原
    bar.innerHTML =
      '<div class="bb-inner">' +
        '<b class="bb-title">批量选择</b>' +
        '<span class="hint-sm">已选 <b>' + n + '</b> / ' + total + ' 个' +
          '<span class="mq-tip"> · 点卡片勾选，或在网格里按住拖拽框选（Ctrl / Shift 追加，Alt 减去）</span></span>' +
        '<span class="grow"></span>' +
        (total ? rangeHTML('as', total, S.assetRange) : '') +
        /* 反选只要有卡片就该可点：n=0 时反选=全选，n=total 时反选=全不选，两种都常用。
           （早先写成 n && n<total 才可点，导致"全选之后反而不能反选"——已修。） */
        '<button class="btn-mini" data-assetact="all"' + (total && n < total ? '' : ' disabled') + '>全选</button>' +
        '<button class="btn-mini" data-assetact="invert"' + (total ? '' : ' disabled') + ' title="反选：已选变未选、未选变已选">反选</button>' +
        '<button class="btn-mini" data-assetact="none"' + (n ? '' : ' disabled') + '>清空选择</button>' +
        /* 批量改类型（2026-09-21）：导入图片时类型取的是"当时所在页签"，很容易把场景/道具的图
           堆进角色分类。修这类历史错分类，一个个点开太慢 —— 这里给一条批量路径。
           音频只有一种类型，不显示。 */
        (n && S.panelTab !== 'audio'
          ? '<select class="btn-mini" id="bbTypeSel" title="把已选素材改成这个类型">' +
            ['character', 'scene', 'prop', 'firstFrame', 'storyboard'].map((t) => '<option value="' + t + '">' + esc(ASSET_TAB_LABEL[t]) + '</option>').join('') +
            '</select><button class="btn-mini" data-assetact="retype"' + (S.assetBusy ? ' disabled' : '') + '>设为该类型</button>'
          : '') +
        '<button class="btn-mini btn-danger" data-assetact="del"' + (S.assetBusy || !n ? ' disabled' : '') + '>' + (S.assetBusy === 'del' ? '删除中…' : '删除所选' + (n ? '（' + n + '）' : '')) + '</button>' +
        '<button class="btn-primary" data-assetact="exit">完成</button>' +
      '</div>';
    restoreRange('as', snap);
  }

  /* ============================================================
     快速多选：框选（marquee）+ 区间选择 + 全选 / 反选 / 清空
     素材面板与分镜列表共用同一套引擎，差异只在「哪些元素算一项」与「选择态怎么落地」。
     ============================================================ */

  /* 区间解析：把用户填的起止序号收敛到 [1, total]。
     非法/越界不报错中断，而是钳制到有效范围并把调整原因回给调用方去提示 ——
     用户要的是"越界时给个提示并自动收敛"，不是"填错就什么都不做"。 */
  function resolveRange(fromRaw, toRaw, total) {
    const num = (v) => {
      const n = parseInt(String(v == null ? '' : v).trim(), 10);
      return Number.isFinite(n) ? n : null;
    };
    let from = num(fromRaw), to = num(toRaw);
    const notes = [];
    if (from == null && to == null) return { from: 1, to: total, notes: ['未填序号，按全部处理'] };
    if (from == null) { from = 1; notes.push('起始未填，按 1 计'); }
    if (to == null) { to = total; notes.push('结束未填，按 ' + total + ' 计'); }
    if (from > to) { const t = from; from = to; to = t; notes.push('起止颠倒，已自动对调'); }
    if (from < 1) { from = 1; notes.push('起始小于 1，已收敛为 1'); }
    if (to > total) { to = total; notes.push('结束超过 ' + total + '，已收敛为 ' + total); }
    if (from > total) { from = total; notes.push('起始超过总数，已收敛为 ' + total); }
    if (to < 1) { to = 1; notes.push('结束小于 1，已收敛为 1'); }
    return { from, to, notes };
  }

  /* 框选引擎。cfg：
       areaSel   必须落在它里面才起拖（动态取，因为容器会被重绘重建）
       itemSel   项选择器（相对 host）
       idOf      el -> 稳定 id
       selSet()  读当前选择集（引擎只取快照，不直接改）
       commit(set)  提交新选择集（调用方负责写回 state 并重绘一次）
       applySel(el, on)  把单项选中态落到 DOM（拖拽期间每帧调用，必须廉价、幂等）
     关键取舍：
     · 拖拽期间**只改 class、不重绘**——每帧 renderTable/renderPanel 会把整列表重建，
       素材/分镜一多就卡；真正的选择集只在 mouseup 时提交一次；
     · 先批量读全部 rect、再统一写 class，避免读写交错触发 layout thrashing；
     · 起拖阈值 4px：没超过就当作普通点击，**不拦截**，卡片编辑弹窗照常打开；
     · 超过阈值则吞掉紧随的那次 click —— 浏览器在拖拽结束时会补发一次 click，
       不拦就会"框选完顺手把卡片打开成编辑弹窗"。 */
  const MARQUEE_THRESHOLD = 4;
  let swallowClickUntil = 0;   // 拖拽结束后的极短窗口内，吞掉补发的那一次 click

  function attachMarquee(host, cfg) {
    if (!host) return;
    let armed = false, dragging = false, box = null, sx = 0, sy = 0;
    let base = null, mode = 'replace', prev = null, cache = null, rects = null;

    /* 项的位置在拖拽期间是固定的（本引擎不做边缘自动滚动），所以矩形**只测一次**。
       每帧都 getBoundingClientRect 会强制回流：实测 416 行时平均 6.6ms/帧、
       还夹着一帧 129ms 的卡顿；改成缓存后每帧只剩 Set 运算与 class 差分。
       用户中途滚轮滚动时位置会失效 —— 监听 scroll 重测一次即可。 */
    const snapshot = () => {
      cache = $$(cfg.itemSel, host);
      rects = cache.map((el) => el.getBoundingClientRect());
    };
    const onScroll = () => { if (dragging) snapshot(); };

    const onDown = (e) => {
      if (e.button !== 0) return;
      const area = host.querySelector(cfg.areaSel) || host;
      if (!area.contains(e.target)) return;
      // 落在交互控件或可滚动文本上不启动：按钮/输入框有自己的动作，
      // .prompt-text 要留给用户划词复制，抢过来会毁掉原本的能力。
      if (e.target.closest('button, input, textarea, select, a, [data-no-marquee], .prompt-text, .codebox')) return;
      sx = e.clientX; sy = e.clientY;
      armed = true; dragging = false; box = null; prev = null;
      base = new Set(cfg.selSet());
      mode = (e.altKey || (e.ctrlKey && e.shiftKey)) ? 'sub' : ((e.ctrlKey || e.shiftKey) ? 'add' : 'replace');
      /* ⚠ 必须在 **mousedown** 就 preventDefault（用户报「框选会选中文字」）。
         浏览器的原生划词从 mousedown 那一刻就开始建立选区；原实现只在超过 4px 阈值的
         mousemove 里 preventDefault —— 那时选区已经建好，再拦也取消不掉，于是拖拽框选的
         同时把卡片名称、行内文字一并选蓝了。
         顺手清掉拖拽前可能残留的选区（上一次划词的结果）。
         不影响既有能力：click 事件照常派发；被排除的按钮 / 输入框 / .prompt-text
         根本不走这条分支，它们的划词与聚焦不受影响。 */
      e.preventDefault();
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    };

    const onMove = (e) => {
      if (!armed) return;
      if (!dragging) {
        if (Math.abs(e.clientX - sx) < MARQUEE_THRESHOLD && Math.abs(e.clientY - sy) < MARQUEE_THRESHOLD) return;
        dragging = true;
        snapshot();
        box = document.createElement('div');
        box.className = 'marquee';
        box.innerHTML = '<span class="mq-n"></span>';
        document.body.appendChild(box);
        document.addEventListener('scroll', onScroll, true);
        e.preventDefault();                  // 到这里才拦：阻止划词 / 原生拖拽
      }
      const x = e.clientX, y = e.clientY;
      const left = Math.min(sx, x), top = Math.min(sy, y);
      const w = Math.abs(x - sx), h = Math.abs(y - sy);
      box.style.left = left + 'px'; box.style.top = top + 'px';
      box.style.width = w + 'px'; box.style.height = h + 'px';

      const next = new Set(mode === 'replace' ? [] : base);
      let hit = 0;
      const changed = [];
      for (let i = 0; i < cache.length; i++) {
        const r = rects[i];
        if (r.right < left || r.left > left + w || r.bottom < top || r.top > top + h) continue;
        hit++;
        const id = cfg.idOf(cache[i]);
        if (mode === 'sub') next.delete(id); else next.add(id);
        if (!prev || prev.has(id) !== next.has(id)) changed.push(cache[i], next.has(id));
      }
      box.querySelector('.mq-n').textContent = hit ? String(hit) : '';
      for (let i = 0; i < changed.length; i += 2) cfg.applySel(changed[i], changed[i + 1]);   // 只改有变化的项
      prev = next;
    };

    const onUp = () => {
      if (!armed) return;
      armed = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('scroll', onScroll, true);
      if (box) { box.remove(); box = null; }
      if (dragging) {
        dragging = false;
        cfg.commit(prev || new Set(base));
        /* 吞掉浏览器在拖拽结束后补发的那一次 click。窗口取 100ms：补发的 click 与 mouseup
           同轮同步触发，100ms 绰绰有余；再长就会误吞用户拖完立刻点的按钮（实测 200ms 时
           紧随其后的「清空」被吞掉）。 */
        swallowClickUntil = Date.now() + 100;
      }
      prev = null; base = null; cache = null; rects = null;
    };

    host.addEventListener('mousedown', onDown);
  }

  /* 拖拽刚结束时吞掉一次 click（捕获阶段拦，早于任何委托处理器） */
  document.addEventListener('click', (e) => {
    if (Date.now() >= swallowClickUntil) return;
    swallowClickUntil = 0;
    e.stopPropagation(); e.preventDefault();
  }, true);

  /* 区间选择控件（素材面板与分镜列表共用一套标记与交互） */
  function rangeHTML(prefix, total, cur) {
    return '<span class="range-sel" title="按序号区间选择：填起止序号后点「选中区间」（越界会自动收敛到 1–' + total + '）">' +
      '<input type="number" class="input-xs" id="' + prefix + 'From" min="1" max="' + total + '" placeholder="起始" value="' + esc(cur.from) + '" data-range="' + prefix + '" />' +
      '<span class="range-dash">–</span>' +
      '<input type="number" class="input-xs" id="' + prefix + 'To" min="1" max="' + total + '" placeholder="结束" value="' + esc(cur.to) + '" data-range="' + prefix + '" />' +
      '<button class="btn-mini" data-rangego="' + prefix + '">选中区间</button>' +
    '</span>';
  }

  /* 重绘前记下区间输入框的值与光标，重绘后原样还原 ——
     面板与状态栏都会被频繁重绘（轮询、选中变化），不还原的话用户打到一半就失焦。 */
  function snapRange(prefix) {
    const from = document.getElementById(prefix + 'From');
    const to = document.getElementById(prefix + 'To');
    if (!from || !to) return null;
    const act = document.activeElement;
    const which = act === from ? 'From' : (act === to ? 'To' : null);
    return {
      from: from.value, to: to.value, which,
      caret: which ? act.selectionStart : 0
    };
  }
  function restoreRange(prefix, snap) {
    if (!snap) return;
    const from = document.getElementById(prefix + 'From');
    const to = document.getElementById(prefix + 'To');
    if (from) from.value = snap.from;
    if (to) to.value = snap.to;
    if (snap.which) {
      const el = snap.which === 'From' ? from : to;
      if (el) { el.focus(); try { el.setSelectionRange(snap.caret, snap.caret); } catch (e) { /* noop */ } }
    }
  }

  /* 区间选中（两个界面共用）。ids 是当前可见项的顺序数组；**追加**语义，不动原有选择 ——
     要重新来过先点「清空选择」。序号按「当前列表第 N 条」计（分页时不是全局 seq）。 */
  function applyRange(prefix, ids, rangeState, selSet, rerender) {
    const elFrom = document.getElementById(prefix + 'From');
    const elTo = document.getElementById(prefix + 'To');
    if (!ids.length) { toast('当前没有可选的项', 'err'); return; }
    const r = resolveRange(elFrom && elFrom.value, elTo && elTo.value, ids.length);
    rangeState.from = String(r.from); rangeState.to = String(r.to);
    if (elFrom) elFrom.value = r.from;
    if (elTo) elTo.value = r.to;
    for (let i = r.from; i <= r.to; i++) if (ids[i - 1]) selSet.add(ids[i - 1]);
    rerender();
    toast('已选中第 ' + r.from + '–' + r.to + ' 项（' + (r.to - r.from + 1) + ' 个）' +
      (r.notes.length ? '；' + r.notes.join('；') : ''), r.notes.length ? 'err' : 'ok');
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

  /* 匹配池必须是**全库**，不能只查当前面板分类：后端 GET /assets 强制带 type，所以四种类型
     各查一次再合并。只查当前分类的话，在「角色」页导入一批混着场景/道具的图，那些文件永远
     匹配不到自己的资产，最后全被当成新角色素材堆在角色分类下（用户实测踩到）。 */
  const ASSET_TYPES = ASSET_TABS;   // 全库遍历（高亮索引 / 匹配池）用同一份类型清单
  async function loadAllAssets() {
    const rs = await Promise.all(ASSET_TYPES.map((t) =>
      Api.listAssets({ projectId: Api.CFG.projectId, type: t }).catch(() => ({ library: [] }))));
    return rs.reduce((acc, r) => acc.concat(r.library || []), []);
  }

  /* 重建「素材名 → 类型」索引。索引一变就补一次行重绘，让提示词里的高亮跟着更新；
     索引没变则不重绘（避免每次 loadAssets 都闪一下）。失败就保持旧索引，不打断主流程。

     ⚠ 键要去扩展名（与后端 nameKeys 的 stripExt 对齐）：素材若是「林晚音色.mp3」这样的
     文件名命名，不去扩展名就永远匹配不到提示词里的「林晚音色」—— 表现为"这条素材从不着色"。
     扩展名规则与后端保持一致：末尾的点 + 1~5 位字母数字。 */
  const stripAssetExt = (n) => String(n || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  let assetIndexPending = null;
  function refreshAssetIndex() {
    if (assetIndexPending) return assetIndexPending;
    assetIndexPending = loadAllAssets()
      .then((lib) => {
        const idx = new Map();
        lib.forEach((a) => {
          const k = stripAssetExt(String(a.name || '').trim()).toLowerCase();
          if (k) idx.set(k, a.type);
        });
        const same = idx.size === S.assetIndex.size &&
          Array.from(idx).every(([k, v]) => S.assetIndex.get(k) === v);
        S.assetIndex = idx;
        /* 索引变了要重绘提示词单元格。注意不能用 renderRowsOnly() —— 它只更新进度/状态/勾选，
           不碰提示词文本，调了等于没调（2026-09-19 实际踩到：高亮一直不出来）。
           这里只重绘提示词、且保住各自的滚动位置，避免整表重绘打断 hover 与阅读位置。 */
        if (!same && S.list.length) {
          $$('#table .row').forEach((el) => {
            const s = rowById(el.dataset.id);
            const box = $('.prompt-text', el);
            if (!s || !box) return;
            const keep = box.scrollTop;
            box.innerHTML = highlightPrompt(s.prompt);
            box.scrollTop = keep;
          });
        }
      })
      .catch(() => { /* 索引拿不到就不高亮，不影响列表本身 */ })
      .then(() => { assetIndexPending = null; });
    return assetIndexPending;
  }

 async function planFiles(files) {
   const lib = await loadAllAssets();
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
    /* 返回**逐行**计划（每个唯一文件名一行），行上带自动匹配结果与可改的决策：
         matched   自动匹配到的资产（精确同名；null = 没匹配上）
         type      仅「新增」用：落库类型（默认当前页签，预览里可改）
         link      仅「未匹配」用：手动关联到的资产（null = 不关联，走新增）
         dupFiles  批次内同名文件（一律并存为新增，不参与决策）
       顺带把全库素材一起返回 —— 预览的「关联」下拉要用它列候选。
       ⚠ 匹配规则**没变**，仍是精确同名（见上方注释）；变的是"结果先给人看、可改"。 */
    const rows = [];
    for (const fs of groups.values()) {
      rows.push({
        file: fs[0],
        matched: byKey.get(normAssetKey(fileBaseName(fs[0]))) || null,
        type: S.imp.impType || S.panelTab,
        link: null,
        dupFiles: fs.slice(1)
      });
    }
    return { rows, lib };
  }

  /* 执行导入（预览页点「确认导入」后调用）。rows 来自 planFiles，决策已经在行上。
     分支（与改版前一致，只有"新增类型"从全局一个变成逐行可改）：
       · 手动关联   → 目标无图则补图、有图则覆盖（用户显式选的，不再走三选一）
       · 自动匹配无图 → 补图
       · 自动匹配有图 → 按 conflictAction：覆盖 / 跳过 / 并存（并存 = 另存为新资产）
       · 没匹配上   → 按行上的类型新增
       · 批次内同名 → 一律新增并存（沿用旧语义，不参与冲突决策） */
  async function executeImportPlan(rows, conflictAction) {
    const steps = [];
    rows.forEach((r) => {
      const newType = r.type || S.imp.impType || S.panelTab;
      const pushNew = (file) => steps.push({ kind: 'new', file, type: newType });
      if (r.link) {
        steps.push({ kind: r.link.url ? 'overwrite' : 'fill', file: r.file, asset: r.link });
      } else if (r.matched) {
        if (!r.matched.url) steps.push({ kind: 'fill', file: r.file, asset: r.matched });
        else if (conflictAction === 'overwrite') steps.push({ kind: 'overwrite', file: r.file, asset: r.matched });
        else if (conflictAction !== 'skip') pushNew(r.file);
        // 'skip' → 该行不入 steps
      } else {
        pushNew(r.file);
      }
      r.dupFiles.forEach(pushNew);
    });
    const skipCount = conflictAction === 'skip'
      ? rows.filter((r) => !r.link && r.matched && r.matched.url).length : 0;
    S.assetBusy = 'import'; S.assetMsg = '正在导入 ' + steps.length + ' 个文件…'; renderPanel();
    const stat = { fill: 0, new: 0, overwrite: 0, skip: skipCount };
    const errs = [];
    for (const st of steps) {
      try {
        if (st.kind === 'fill') await Api.replaceAsset(st.asset.id, st.file, st.asset.name);           // 补图：保留资产名
        else if (st.kind === 'overwrite') await Api.replaceAsset(st.asset.id, st.file, st.asset.name); // 覆盖：保留 id 与绑定
        else await Api.uploadAsset(st.file, st.type);
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

  /* 批量改类型：把已选素材改成同一个类型。
     改类型会**解绑所有引用它的分镜**（绑定的 role 就是素材类型），所以先汇总引用数、
     让用户确认，再逐个改 —— 与单个改类型的提示口径保持一致。 */
  async function batchRetype() {
    const sel = document.querySelector('#bbTypeSel');
    const type = sel && sel.value;
    const ids = Array.from(S.assetSel);
    if (!type || !ids.length || S.assetBusy) return;
    let refs = 0;
    try {
      const us = await Promise.all(ids.map((id) => Api.assetUsage(id).catch(() => ({ count: 0 }))));
      refs = us.reduce((s, u) => s + (u.count || 0), 0);
    } catch (e) { /* 查不到引用数就按 0 处理；后端仍会解绑并在返回里给 unbound */ }
    const okGo = await uiConfirm('批量修改素材类型',
      '把已选的 ' + ids.length + ' 个素材改为「' + (ASSET_TAB_LABEL[type] || type) + '」？' +
      (refs ? '\n\n它们共被 ' + refs + ' 条分镜引用，改类型会解除这些绑定。' : ''));
    if (!okGo) return;
    S.assetBusy = 'retype'; renderPanel();
    let done = 0; const errs = [];
    for (const id of ids) {
      try { await Api.updateAsset(id, { type: type }); done++; }
      catch (e) { errs.push(errText(e)); }
    }
    S.assetBusy = null;
    S.assetSel.clear(); S.assetSelMode = false;
    toast('已改类型 ' + done + ' 个' + (errs.length ? '，失败 ' + errs.length + ' 个：' + errs[0] : ''), errs.length ? 'err' : 'ok');
    await afterAssetMutated();
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
    refreshAssetIndex();   // 不 await：索引只影响提示词着色，晚到一步不拖累列表
  }

  /* ---------------------------------------------------------- 状态栏 */
  function renderStatusbar() {
    const st = S.stats || {};
    const n = S.sel.size;
    const engName = '创作 CLI';
    const engOk = !!(S.adapter && S.adapter.dreamina && S.adapter.dreamina.available);
    const snap = snapRange('sb');          // 状态栏会被轮询频繁重绘，区间输入框要还原
    $('#statusbar').innerHTML =
      (S.options && S.options.dryRun
        ? '<span class="drybadge" title="服务启动时带了 JC_DRY_RUN=1：所有提交都只组装命令、不派发">干跑模式</span><i class="sb-div"></i>'
        : '') +
      '<span>引擎 <b>' + engName + '</b>' + (engOk ? '' : '（未连接）') + '</span>' +
      '<i class="sb-div"></i>' +
      '<span>并发 <b>' + (S.settings ? S.settings.queue.concurrency : '—') + '</b></span>' +
      '<i class="sb-div"></i>' +
      '<span>已选 <b>' + n + '</b> / ' + S.list.length + ' 项</span>' +
      (S.list.length
        ? '<button class="btn-mini" data-batch="all"' + (n < S.list.length ? '' : ' disabled') + '>全选</button>' +
          '<button class="btn-mini" data-batch="invert" title="反选：已选变未选、未选变已选">反选</button>' +
          '<button class="btn-mini" data-batch="clear"' + (n ? '' : ' disabled') + '>清空</button>' +
          rangeHTML('sb', S.list.length, S.selRange)
        : '') +
      (n
        ? '<button class="btn-mini" data-batch="duration">批量改时长</button>' +
          '<button class="btn-mini" data-batch="reduration" title="读提示词里的「总时长：X.Xs」标注重算时长（小数向上进位）">按时长标注重算</button>' +
          '<button class="btn-mini" data-batch="delete">删除所选</button>'
        : '<button class="btn-mini" data-batch="reduration" title="不勾选时作用于全部「未提交」分镜：读「总时长：X.Xs」标注重算（小数向上进位）">按时长标注重算（全部）</button>') +
      '<span class="grow"></span>' +
      '<span>显示 <b>' + S.list.length + '</b> 条，共 <b>' + (st.total || 0) + '</b> 个分镜</span>';
    /* 「整体进度 X% + 进度条 + 预计剩余」已于 2026-09-20 整组移到顶栏（见 index.html 的
       .top-progress 与 renderTopbar）。三者是一组读数，拆开摆会看不懂，故整组一起搬；
       这里不再重复渲染，避免同一个数字在两处出现却各自刷新。 */
    restoreRange('sb', snap);
    syncTopActions();          // 「提交所选」的数量与 title 跟着勾选变化（按钮在顶栏，不在本容器内）
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

  /* 人类可读的字节数（2026-09-21）。硬删除确认弹窗要用它显示"将要释放的磁盘占用" ——
     直接给 "1234567890 字节" 在那个场景下没有意义。
     阈值用 1024 进制（与文件系统的显示口径一致），保留一位小数。 */
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }
  function fmtAt(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { d: '—', t: '' };
    return {
      d: pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
      t: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    };
  }
  /* 单行短时间戳（项目卡片 / 分镜表行用）。
     ⚠ 与记录列表的 fmtAt 分开：fmtAt 返回 {d,t} 两段，是为了在表格里对齐成两行单元格；
     这里要的是一句话，直接拼成字符串。 */
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return '今天 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
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

  /* 打开记录视图。两种呈现方式共用这一份实现：
       · 默认（从控制台顶栏「生成记录」进来）→ 整屏覆盖层，看完用返回箭头回控制台；
       · { inline: true }（从项目主页的「生成记录」页签进来）→ 就地嵌在项目页里，
         项目页的头与导航栏保持不动。 */
  function openRecords(o) {
    const inline = !!(o && o.inline);
    S.recSel = null; S.recDetail = null; S.rec.page = 1;
    const v = $('#recView');
    if (inline) mountInlinePanel('records');
    v.hidden = false; v.setAttribute('aria-hidden', 'false');
    stopPolling();                      // 记录页不轮询任务进度，省掉后台空转
    renderRecords();
    loadRecords(1);
    scheduleRecPoll();
  }
  function closeRecords() {
    const v = $('#recView');
    $('#recDetail').classList.remove('on');
    stopRecPoll();
    /* 就地模式：卸载面板并回到「分镜表」页签（不是去恢复整屏覆盖层的状态） */
    if (inlinePanel === 'records') {
      unmountInlinePanel();
      S.proj.tab = 'pages';
      renderProjHome();
      return;
    }
    v.hidden = true; v.setAttribute('aria-hidden', 'true');
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
        ? '<div class="rec-block"><h4>素材引用（编号 = --image / --audio 顺序）</h4><div class="rec-sect"><div class="rec-lock">' + lockRows + '</div>' +
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
        ? '<div class="rec-block"><h4>实际发出的提示词（原文 + 素材锁定 / 音频参考区块）<span class="grow"></span>' +
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

  /* ============================================================
     多项目导航：首页 → 项目主页 → 工作区视图
     ------------------------------------------------------------
     层级与显示（指令 §20/§23/§25）：
       首页      #homeView（全屏覆盖，z-index 65）—— 项目列表
       项目主页  #projView（全屏覆盖，z-index 65）—— 分镜表列表 / 资产库
       工作区    #app（既有的分镜表）—— 不覆盖，靠两个覆盖层隐藏来"露出来"
     #recView（记录页）与设置抽屉都是 z-index 70，压在项目主页之上，因此从项目主页
     能正常打开它们。**只有前端**持有"当前项目/分镜表"（S.cur）；后端一律 request-scoped。
     ============================================================ */

  /* 当前作用域同步到 Api 层（所有请求据此带上 projectId/workspaceId） */
  function applyScope() {
    Api.setScope({ projectId: S.cur.projectId, workspaceId: S.cur.workspaceId });
  }

  /* 清空一切**项目/分镜表级**的界面状态（指令 §37）。
     ⚠ 刻意不清 adapter / cli* / dCli* —— 那些是**整机**状态（CLI 账号、积分、登录流程），
     清掉会让引擎读数无缘无故变空。
     ⚠ 不清掉的话会出真事故：S.sel 里残留上一张分镜表的分镜 id，切过去后点「提交所选」
     就会把**别的分镜表**的分镜提交出去；S.autoIds / S.durIds 同理会把预览应用到错误的表。 */
  function resetScopeState() {
    // 计时器先停：晚到的回调会把旧作用域的数据写进新界面
    stopPolling();
    stopRecPoll();
    if (S.imp.timer) clearTimeout(S.imp.timer);
    if (S.panelTimer) clearTimeout(S.panelTimer);
    if (S.recTimer) clearTimeout(S.recTimer);
    Object.keys(S.patchTimers || {}).forEach((k) => clearTimeout(S.patchTimers[k]));
    S.patchTimers = {};
    S.panelTimer = null;

    // 分镜列表与选择
    S.list = []; S.stats = null;
    S.sel = new Set();               // ⚠ 必须赋新 Set（多处是整体重新赋值，不是 .clear()）
    S.selRange = { from: '', to: '' };
    S.page = 1; S.filter = 'all'; S.keyword = '';
    S.loading = true; S.error = null; S.busy = false;
    S.bindTarget = null; S.detailFull = null;

    // 素材面板
    S.assets = []; S.assetCounts = { currentShot: 0, library: 0 };
    S.assetIndex = new Map(); S.assetBusy = null; S.assetMsg = '';
    S.assetSel = new Set(); S.assetSelMode = false;
    S.assetRange = { from: '', to: '' };
    S.panelTab = 'character'; S.panelKeyword = '';

    // 导入 / 干跑 / 自动匹配 / 时长重算 的中间态
    S.imp = { raw: '', delimiter: S.imp.delimiter, preview: null, busy: false, timer: null, seq: 0 };
    S.cmdRows = []; S.dryBusy = false;
    S.autoBusy = false; S.autoRows = []; S.autoStats = null; S.autoIds = []; S.autoScopeAll = false; S.autoPending = false;
    S.durBusy = false; S.durRows = []; S.durStats = null; S.durIds = []; S.durScopeAll = false;

    // 记录视图
    S.rec = { loading: false, list: [], page: 1, pageSize: S.rec.pageSize, total: 0, pageCount: 1, stats: null, kept: 0, capacity: 0 };
    S.recF = { action: 'all', outcome: 'all', engine: 'all', keyword: '', from: '', to: '' };
    S.recSel = null; S.recDetail = null; S.recDetailLoading = false;

    // 关掉所有从旧作用域打开的弹层：它们的内容是按旧数据渲染的，留着会误导
    unmountInlinePanel();   // 项目页的就地面板（记录/设置）同样按旧作用域渲染，必须先卸掉
    ['importMask', 'detailMask', 'cmdMask', 'autoMask', 'durMask'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    closeMenu();
    closeDetail();      // 含 <video> 的暂停与释放，不能只 hidden
  }

  /* 页面层级：用于判断转场方向。首页 → 项目 → 分镜表是向前，反向是返回。 */
  const VIEW_DEPTH = { home: 0, project: 1, workspace: 2 };
  let viewMounted = false;
  let activeViewTransition = null;

  /* 实际切换显示层。只负责显隐与面包屑，不管数据加载（那是 enter* 的职责）。 */
  function applyView(name) {
    S.view = name;
    const home = $('#homeView'), proj = $('#projView'), app = $('#app');
    if (home) { home.hidden = name !== 'home'; home.setAttribute('aria-hidden', name === 'home' ? 'false' : 'true'); }
    if (proj) { proj.hidden = name !== 'project'; proj.setAttribute('aria-hidden', name === 'project' ? 'false' : 'true'); }
    /* 控制台只在工作区视图里露出来；首页/项目主页期间整体藏起（避免首屏闪一下空表格） */
    if (app) app.classList.toggle('hidden-view', name !== 'workspace');
    renderTopbar();
    /* 轮询只在工作区视图里跑（指令 §39）：离开工作区就停，回来时 ensurePolling 会重新拉起。
       代际令牌在 stopPolling 里 +1，所以在飞的旧响应也会被丢弃。 */
    if (name === 'workspace') ensurePolling(); else stopPolling();
  }

  /* 三层页面转场：优先用 View Transitions API 同时完成旧页退出和新页进入。
     首次启动不做动画，避免按 URL 恢复到分镜表时从空首页“飞进去”。
     不支持 API 或开启“减少动态效果”时直接切换，功能不受影响。 */
  function setView(name) {
    const previous = S.view;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = viewMounted && previous !== name && !reduced && typeof document.startViewTransition === 'function';
    viewMounted = true;
    if (!canAnimate) { applyView(name); return; }

    if (activeViewTransition && activeViewTransition.skipTransition) activeViewTransition.skipTransition();
    const root = document.documentElement;
    const direction = (VIEW_DEPTH[name] || 0) > (VIEW_DEPTH[previous] || 0) ? 'nav-forward' : 'nav-back';
    root.classList.remove('nav-forward', 'nav-back');
    root.classList.add(direction);

    const transition = document.startViewTransition(() => applyView(name));
    activeViewTransition = transition;
    transition.finished.catch(() => {}).finally(() => {
      if (activeViewTransition !== transition) return;
      activeViewTransition = null;
      root.classList.remove('nav-forward', 'nav-back');
    });
  }

  /* URL 状态（指令 §35 的最低成本方案）：?project=…&workspace=…
     用 replaceState 而不是 pushState —— 需求只要求"刷新能回到原处"，
     而视图内的返回按钮（首页 / 返回项目列表）已经覆盖了层级导航，
     引入 popstate 反而会和那些按钮形成两套语义。 */
  function syncUrl() {
    try {
      const u = new URL(window.location.href);
      if (S.cur.projectId) u.searchParams.set('project', S.cur.projectId); else u.searchParams.delete('project');
      if (S.cur.workspaceId) u.searchParams.set('workspace', S.cur.workspaceId); else u.searchParams.delete('workspace');
      window.history.replaceState(null, '', u.pathname + (u.search || ''));
    } catch (e) { /* 非 http(s) 环境（如 file://）下改 URL 会抛错，忽略即可 */ }
  }

  /* ---------------- 首页（项目列表） ---------------- */
  async function enterHome() {
    resetScopeState();
    S.cur = { projectId: '', workspaceId: '', project: null, workspace: null };
    applyScope();
    setView('home');
    syncUrl();
    await loadProjects();
  }

  async function loadProjects() {
    S.home.loading = true; S.home.error = null;
    renderHome();
    try {
      const res = await Api.listProjects();
      S.home.list = res.list || [];
      S.home.total = res.total || 0;
      S.home.error = null;
    } catch (e) {
      S.home.error = e;
      S.home.list = []; S.home.total = 0;
    } finally {
      S.home.loading = false;
      renderHome();
    }
  }

  /* ---------------- 项目主页 ---------------- */
  async function enterProject(projectId, opts2) {
    const o = opts2 || {};
    resetScopeState();
    S.cur = { projectId: projectId, workspaceId: '', project: null, workspace: null };
    applyScope();
    S.proj.tab = o.tab || 'pages';
    setView('project');
    syncUrl();
    await loadProjectHome();
  }

  async function loadProjectHome() {
    S.proj.loading = true; S.proj.error = null;
    renderProjHome();
    try {
      /* 三个请求并行：项目详情（拿名字与计数）、分镜表列表、项目资产。
         项目详情与分镜表列表都必须成功；资产失败只让资产 tab 空着，不阻断整页。 */
      const [pj, ws] = await Promise.all([
        Api.getProject(S.cur.projectId),
        Api.listWorkspaces(S.cur.projectId)
      ]);
      S.cur.project = pj;
      S.proj.workspaces = ws.list || [];
      S.proj.error = null;
      /* options / settings 是项目级的，顺手取一次：项目设置抽屉要用它渲染
         默认模型下拉与分隔符（否则只能退回 api.js 里的静态兜底列表）。 */
      try {
        const [o, st] = await Promise.all([Api.getOptions(), Api.getSettings()]);
        S.options = o; S.settings = st;
      } catch (e) { /* 不影响项目主页本身 */ }
      try {
        const a = await Api.listAssets({ type: S.proj.assetTab, keyword: S.proj.assetKeyword || undefined });
        S.proj.assets = a.library || [];
      } catch (e) { S.proj.assets = []; }
    } catch (e) {
      /* 项目不存在或已被删除 → 安全降级回首页（指令 §36：不能崩） */
      S.proj.error = e;
      S.proj.workspaces = [];
      if (e && (e.code === Api.ERR.NOTFOUND || e.code === 40400)) {
        toast('该项目不存在或已被删除，已返回项目列表', 'err');
        S.proj.loading = false;
        return enterHome();
      }
    } finally {
      S.proj.loading = false;
      renderProjHome();
      renderTopbar();
    }
  }

  /* ---------------- 工作区视图（既有分镜表） ---------------- */
  async function enterWorkspace(projectId, workspaceId, opts2) {
    const o = opts2 || {};
    resetScopeState();
    S.cur = { projectId: projectId, workspaceId: workspaceId, project: null, workspace: null };
    applyScope();
    setView('workspace');
    syncUrl();
    /* 先把作用域相关的元数据与列表拉起来（options/settings 都是项目级的，必须重取） */
    try {
      const [meta, st, ad, ws] = await Promise.all([
        Api.getOptions(), Api.getSettings(), Api.getAdapter(), Api.getWorkspace(workspaceId)
      ]);
      S.options = meta; S.settings = st; S.adapter = ad;
      S.cur.workspace = ws;
      /* 项目名从 meta 里取（后端已按作用域下发），避免为了面包屑再多打一次请求 */
      S.cur.project = meta.project || (ws.project ? { id: ws.project.id, name: ws.project.name } : null);
    } catch (e) {
      /* 分镜表/项目不存在或已删除 → 降级：有项目就回项目主页，否则回首页（§36） */
      toast('该分镜表不存在或已被删除', 'err');
      if (projectId) return enterProject(projectId);
      return enterHome();
    }
    if (o.workspace) S.cur.workspace = o.workspace;
    renderTopbar();
    await Promise.all([loadList({ skeleton: true }), loadAssets()]);
  }

  /* ---------------- 启动时按 URL 恢复（指令 §36） ---------------- */
  async function bootFromUrl() {
    let projectId = '', workspaceId = '';
    try {
      const u = new URL(window.location.href);
      projectId = u.searchParams.get('project') || '';
      workspaceId = u.searchParams.get('workspace') || '';
    } catch (e) { /* file:// 下取不到参数，走默认 */ }

    /* 只预取**整机级**的适配器状态（与项目无关，任何视图都可能用到）。
       options / settings 是**项目级**的，等作用域确定后由各自的 enter* 去取 ——
       在这里提前取会用默认作用域打一次无用请求。

       ⚠ 这里**不能 await**（2026-09-20 桌面版实测）：适配器探测要真去问一次
       dreamina CLI，冷启动实测 2.5s。await 的话这三层视图在探测完成前都还是
       hidden，用户看到的就是"窗口打开了、一片空白、几秒后才出现首页" ——
       在桌面版里这跟"启动失败"没有区别。适配器状态只喂顶栏/状态栏，
       所以改成只发起不等待，结果回来再补一次顶栏即可。 */
    loadAdapterOnly().then(() => { renderTopbar(); renderStatusbar(); });

    if (projectId && workspaceId) {
      /* URL 指向具体的分镜表 → 直接进工作区视图；enterWorkspace 内部对"不存在"有降级 */
      try {
        await enterWorkspace(projectId, workspaceId);
        return;
      } catch (e) { /* 落到下面的降级 */ }
    }
    if (projectId) {
      try {
        await enterProject(projectId);
        return;
      } catch (e) { /* 落到首页 */ }
    }
    /* 默认进首页（指令 §20：根入口进项目列表，而不是直接进旧分镜工作区） */
    await enterHome();
  }

  async function loadAdapterOnly() {
    try { S.adapter = await Api.getAdapter(); } catch (e) { /* 探测失败不影响首页 */ }
  }

  /* ---------------- 面包屑（顶栏，静态节点只改文本） ---------------- */
  function renderCrumb() {
    const home = $('#crumbHome'), sep1 = $('#crumbSep1'), pj = $('#projName'), sep2 = $('#crumbSep2'), ws = $('#crumbWs');
    if (!home || !pj) return;
    const inWorkspace = S.view === 'workspace';
    const name = (S.cur.project && S.cur.project.name) || '—';
    pj.textContent = name;
    pj.disabled = !S.cur.projectId || inWorkspace === false;
    pj.title = S.cur.projectId ? '返回项目主页' : '';
    if (sep2) sep2.hidden = !inWorkspace;
    if (ws) {
      ws.hidden = !inWorkspace;
      ws.textContent = (S.cur.workspace && S.cur.workspace.name) || '—';
    }
    if (sep1) sep1.hidden = false;
    home.disabled = false;
  }

  /* ---------------- 首页渲染 ---------------- */
  function renderHome() {
    const sum = $('#homeSummary');
    const body = $('#homeBody');
    if (!body) return;
    if (sum) sum.textContent = S.home.loading ? '加载中…' : ('共 ' + S.home.total + ' 个项目');

    if (S.home.loading && !S.home.list.length) {
      body.innerHTML = '<div class="pv-empty"><span class="s">加载中…</span></div>';
      return;
    }
    if (S.home.error) {
      body.innerHTML = '<div class="pv-empty">' +
        '<span class="t">项目列表加载失败</span>' +
        '<span class="s">' + esc(errText(S.home.error)) + '</span>' +
        '<button class="btn-outline" id="homeRetry">重试</button></div>';
      const b = $('#homeRetry'); if (b) b.addEventListener('click', () => loadProjects());
      return;
    }
    if (!S.home.list.length) {
      body.innerHTML = '<div class="pv-empty">' +
        '<span class="t">还没有项目</span>' +
        '<span class="s">项目是数据隔离的边界：不同项目的分镜表、分镜、素材与生成记录互不可见。<br>同一项目下的多张分镜表共享一份素材库。</span>' +
        '<button class="btn-primary" id="homeNew2">+ 创建第一个项目</button></div>';
      const b = $('#homeNew2'); if (b) b.addEventListener('click', () => onNewProject());
      return;
    }
    body.innerHTML = '<div class="pj-grid">' + S.home.list.map(pjCardHTML).join('') + '</div>';
  }

  function pjCardHTML(p) {
    const c = p.counts || {};
    const at = p.lastOpenedAt || p.updatedAt || p.createdAt;
    return '<div class="pj-card" data-pj="' + esc(p.id) + '" title="打开项目">' +
      '<span class="nm">' + esc(p.name) + '</span>' +
      '<span class="ds">' + (p.description ? esc(p.description) : '<span style="opacity:.6">（无描述）</span>') + '</span>' +
      '<span class="mt">' +
        '<span>分镜表 <b>' + (c.workspaces || 0) + '</b></span>' +
        '<span>分镜 <b>' + (c.storyboards || 0) + '</b></span>' +
        '<span>素材 <b>' + (c.assets || 0) + '</b></span>' +
        '<span>' + (at ? esc(fmtWhen(at)) : '') + '</span>' +
      '</span>' +
      '<span class="acts">' +
        '<button class="btn-mini" data-pjact="rename" data-pjid="' + esc(p.id) + '">重命名</button>' +
        '<button class="btn-mini btn-danger" data-pjact="del" data-pjid="' + esc(p.id) + '">删除</button>' +
      '</span>' +
    '</div>';
  }

  /* ---------------- 项目主页渲染 ---------------- */
  /* 四个都是**内容页签**：切换只换下方内容，视图头部与导航栏保持不动。
     （早先把「生成记录 / 项目设置」做成"动作型"页签、点了会弹整屏覆盖层，
     用户反馈那样切换太生硬、头和导航都跟着消失 —— 现在统一成内容页签。） */
  const PROJ_TABS = [
    { key: 'pages', label: '分镜表' },
    { key: 'assets', label: '资产库' },
    { key: 'records', label: '生成记录' },
    { key: 'settings', label: '项目设置' }
  ];

  /* ---------------- 项目主页的「就地面板」（记录 / 设置） ----------------
     把覆盖层整体**搬进** #projMount，于是项目页的头与导航栏保持不动，只有内容换掉。
     ⚠ 移动的是同一个 DOM 节点，不是复制一份：记录视图带着筛选、分页、详情、导出、
       8s 自动刷新一整套状态与事件，复制就等于要同步维护两套实现，迟早不一致。
       移动 DOM 不会丢事件监听（节点没被重建），既有的委托与按钮绑定继续有效。
     ⚠ 同一时刻最多挂一个；换页签、离开项目页、切换作用域都必须先卸载 ——
       否则面板会留在已隐藏的挂载点里，下次进来既看不到也点不到。 */
  let inlinePanel = null;   // 'records' | 'settings' | null

  function unmountInlinePanel() {
    if (!inlinePanel) return;
    const which = inlinePanel;
    inlinePanel = null;
    const mount = $('#projMount'), body = $('#projBody');
    if (mount) mount.hidden = true;
    if (body) body.hidden = false;

    if (which === 'records') {
      stopRecPoll();
      const d = $('#recDetail');
      if (d) d.classList.remove('on');       // 窄屏的详情抽屉类，别留给下次
      const v = $('#recView');
      if (v) {
        v.classList.remove('inline');
        if (v.parentElement !== document.body) document.body.appendChild(v);
        v.hidden = true;
        v.setAttribute('aria-hidden', 'true');
      }
      return;
    }

    /* 设置抽屉：必须**完整**走一遍关闭流程，不能只摘 .inline + 设 hidden。
       ⚠ 漏掉 .open 会留下一个"看不见的开关"：抽屉回到 body 后仍是 position:fixed，
         而 .open 让它 transform:none（本该 translateX(100%) 藏在屏幕外），
         于是下一次切到别的页签时它会**从右侧滑出来盖住整页**
         —— 用户实测报的正是这个现象（点项目设置 → 再点另外三个中的任意一个）。
       ⚠ 抽屉的 hidden 还必须配一条 CSS 才生效：.drawer 是 display:flex，
         会盖掉浏览器默认的 [hidden]{display:none}（见 styles.css 的 .drawer[hidden]）。 */
    const dr = $('#settingsDrawer');
    if (dr) {
      dr.classList.remove('inline', 'open');
      dr.hidden = true;
      dr.setAttribute('aria-hidden', 'true');
      if (dr.parentElement !== document.body) document.body.appendChild(dr);
    }
    const mk = $('#settingsMask');
    if (mk) mk.hidden = true;
    S.settingsDirty = false;
  }

  function mountInlinePanel(which) {
    const mount = $('#projMount'), body = $('#projBody');
    if (!mount || !body) return;
    if (inlinePanel === which) return;
    unmountInlinePanel();
    const el = which === 'records' ? $('#recView') : $('#settingsDrawer');
    if (!el) return;
    body.hidden = true;
    mount.hidden = false;
    el.classList.add('inline');
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    mount.appendChild(el);
    inlinePanel = which;
    /* 就地模式不要遮罩：遮罩会把项目页的头与导航一起压暗，正是要避免的效果 */
    if (which === 'settings') { const m = $('#settingsMask'); if (m) m.hidden = true; }
  }

  function renderProjTabs() {
    const tabs = $('#projTabs');
    if (!tabs) return;
    tabs.innerHTML = PROJ_TABS.map((x) =>
      '<button class="pv-tab' + (S.proj.tab === x.key ? ' on' : '') + '" data-ptab="' + x.key + '">' + esc(x.label) + '</button>'
    ).join('');
  }

  function renderProjHome() {
    const t = $('#projTitle'), s = $('#projSummary'), body = $('#projBody');
    if (!body) return;
    const p = S.cur.project;
    if (t) t.textContent = p ? p.name : (S.proj.loading ? '加载中…' : '—');
    if (s) {
      const c = (p && p.counts) || {};
      s.textContent = S.proj.loading ? '加载中…' : ('分镜表 ' + (c.workspaces || 0) + ' · 分镜 ' + (c.storyboards || 0) + ' · 素材 ' + (c.assets || 0));
    }
    renderProjTabs();
    if (S.proj.error && S.proj.error.code !== Api.ERR.NOTFOUND && S.proj.error.code !== 40400) {
      unmountInlinePanel();
      body.innerHTML = '<div class="pv-empty"><span class="t">项目加载失败</span><span class="s">' + esc(errText(S.proj.error)) + '</span></div>';
      return;
    }
    /* 记录 / 设置：面板已挂就不重复打开（重命名后 loadProjectHome 会重走这里），
       否则挂上并首次打开。 */
    if (S.proj.tab === 'records') {
      if (inlinePanel !== 'records') { mountInlinePanel('records'); openRecords({ inline: true }); }
      return;
    }
    if (S.proj.tab === 'settings') {
      if (inlinePanel !== 'settings') { mountInlinePanel('settings'); openSettings({ inline: true }); }
      return;
    }
    unmountInlinePanel();
    if (S.proj.tab === 'assets') return renderProjAssets();
    renderProjPages();
  }

  function renderProjPages() {
    const body = $('#projBody');
    if (!body) return;
    if (S.proj.loading && !S.proj.workspaces.length) {
      body.innerHTML = '<div class="pv-empty"><span class="s">加载中…</span></div>';
      return;
    }
    if (!S.proj.workspaces.length) {
      body.innerHTML = '<div class="pv-empty">' +
        '<span class="t">还没有分镜表</span>' +
        '<span class="s">分镜表是分镜的容器。同一项目下的所有分镜表共享本项目的素材库。</span>' +
        '<button class="btn-primary" id="projNewWs2">+ 新建分镜表</button></div>';
      const b = $('#projNewWs2'); if (b) b.addEventListener('click', () => onNewWorkspace());
      return;
    }
    body.innerHTML = '<div class="ws-list">' + S.proj.workspaces.map((w) =>
      '<div class="ws-row" data-ws="' + esc(w.id) + '" title="打开这张分镜表">' +
        '<span class="nm">' + esc(w.name) + '</span>' +
        (w.isDefault ? '<span class="def">默认</span>' : '') +
        '<span class="grow"></span>' +
        '<span class="meta">' + (w.storyboardCount || 0) + ' 个分镜' + (w.lastOpenedAt ? ' · ' + esc(fmtWhen(w.lastOpenedAt)) : '') + '</span>' +
        '<button class="btn-mini" data-wsact="rename" data-wsid="' + esc(w.id) + '">重命名</button>' +
        '<button class="btn-mini btn-danger" data-wsact="del" data-wsid="' + esc(w.id) + '">删除</button>' +
      '</div>'
    ).join('') + '</div>';
  }

  /* 资产库的「新建素材」瓦片：与分镜面板的 .slot-add 是同一套视觉语言（虚线框 + ＋），
     尺寸对齐 .acard（缩略图区 64px + 名称行），所以直接复用已有的 .acard.add 样式。
     为什么要有它：新建素材是资产库最主要的动作，此前只有工具栏的「+ 上传素材」
     （批量导入、按文件名自动命名），单个"起个名字"的新建没有入口。 */
  function assetAddCardHTML(type) {
    const label = ASSET_TAB_LABEL[type] || '素材';
    return '<div class="acard add" data-newasset="' + esc(type) + '" title="新建' + esc(label) + '">' +
      '<span class="pic">' + I.add + '</span>' +
      '<span class="nm">新建' + esc(label) + '</span>' +
    '</div>';
  }

  function renderProjAssets() {
    const body = $('#projBody');
    if (!body) return;
    const tabs = ASSET_TABS.map((k) =>
      '<button class="pv-tab' + (S.proj.assetTab === k ? ' on' : '') + '" data-atab="' + k + '">' + esc(ASSET_TAB_LABEL[k]) + '</button>'
    ).join('');
    /* ⚠ 网格**始终渲染**（哪怕这一类还没有素材）：新建瓦片就在网格末尾，
       那是空分类下唯一的新建入口 —— 只在有素材时才渲染网格，等于"空分类建不了东西"。 */
    const grid = '<div class="pv-grid">' +
      S.proj.assets.map((a) => assetCardHTML(a, {})).join('') +
      assetAddCardHTML(S.proj.assetTab) +
      '</div>';
    const empty = S.proj.assets.length ? '' :
      '<div class="pv-empty"><span class="t">这个分类下还没有素材</span>' +
      '<span class="s">素材属于<strong>项目</strong>，本项目下所有分镜表都能使用它；绑定到具体分镜的操作在分镜表里做。' +
      '点上面的「新建' + esc(ASSET_TAB_LABEL[S.proj.assetTab] || '素材') + '」建一个，或用右上角「+ 上传素材」批量导入。</span></div>';
    body.innerHTML =
      '<div class="pv-toolbar">' + tabs +
        '<span class="grow"></span>' +
        '<label class="panel-search" style="margin:0"><input id="projAssetKw" class="input-sm" placeholder="搜索素材" value="' + esc(S.proj.assetKeyword) + '" /></label>' +
        '<button class="btn-primary" id="projAssetUp">+ 上传素材</button>' +
      '</div>' + grid + empty;
  }

  /* ---------------- 项目 / 分镜表 的增删改 ---------------- */

  /* 新建项目的默认名：预填一个，省得用户"必须先想好名字才能建"。
     重名会让项目卡片看起来一模一样，所以拿现有名字比一下，重复就加序号。 */
  function defaultProjectName() {
    const used = new Set((S.home.list || []).map((p) => p.name));
    if (!used.has('新项目')) return '新项目';
    for (let i = 2; i < 1000; i++) {
      const n = '新项目 ' + i;
      if (!used.has(n)) return n;
    }
    return '新项目';
  }

  /* 新建分镜表的默认名：规则与新建项目一致，但只在当前项目内避免重名。 */
  function defaultWorkspaceName() {
    const used = new Set((S.proj.workspaces || []).map((w) => w.name));
    if (!used.has('新分镜表')) return '新分镜表';
    for (let i = 2; i < 1000; i++) {
      const n = '新分镜表 ' + i;
      if (!used.has(n)) return n;
    }
    return '新分镜表';
  }

  async function onNewProject() {
    const name = await uiPrompt('创建项目',
      '给项目起个名字。项目之间数据完全隔离，同一项目下的多张分镜表共享素材库。', defaultProjectName());
    if (name === null) return;
    const nm = String(name).trim();
    if (!nm) { toast('项目名称不能为空', 'err'); return; }
    try {
      const res = await Api.createProject({ name: nm });
      toast('项目「' + res.project.name + '」已创建', 'ok');
      /* 按用户要求：创建后**留在项目列表**，不自动跳进项目里。
         新项目是空的（也不再自动建分镜表），进去也没什么可做的，留在列表更符合预期。 */
      await loadProjects();
    } catch (e) { fail(e); }
  }

  async function onRenameProject(id, cur) {
    const name = await uiPrompt('重命名项目', '改名不会影响分镜、素材与生成记录；生成记录里仍显示生成当时的名字。', cur || '');
    if (name === null) return;
    const nm = String(name).trim();
    if (!nm) { toast('项目名称不能为空', 'err'); return; }
    try {
      await Api.patchProject(id, { name: nm });
      toast('已重命名', 'ok');
      if (S.view === 'project') await loadProjectHome(); else await loadProjects();
    } catch (e) { fail(e); }
  }

  async function onDeleteProject(id, name) {
    const okd = await uiConfirm('删除项目', '确定删除项目「' + name + '」？\n\n' +
      '这是**软删除**：项目、分镜表、分镜、素材与生成记录都不会被物理销毁，只是不再出现在列表里。' +
      '如果项目下还有生成中的任务，删除会被拒绝。');
    if (!okd) return;
    try {
      await Api.deleteProject(id);
      toast('项目已删除（软删除，数据仍保留）', 'ok');
      if (S.view === 'project' && S.cur.projectId === id) await enterHome();
      else await loadProjects();
    } catch (e) { fail(e); }
  }

  /* 彻底删除：连磁盘文件一起删，**不可恢复**。
     因为不可逆，要求用户**把项目名原样打一遍**才执行 —— 比一个"确定吗"的弹窗可靠得多
     （后者在习惯性确认下几乎拦不住），也与"软删除"在操作成本上拉开了差距。

     ★ 2026-09-21 补（清单 §13）：确认前先**展示要删掉什么**。
       原先弹窗只写"项目名 + ID"，用户根本不知道这次要删掉多少分镜、多少素材、
       多少个视频、占多少磁盘 —— 而这是唯一没有任何回退路径的操作。
       现在先调 hard-delete-preview 拿到真实统计并逐项列出：
         · 统计拿不到（网络/接口失败）时不阻断流程，退回原提示文案 ——
           一个统计接口的抖动不该让用户连删都删不了；
         · 有活动任务时预览里会带 activeTasks，直接拦在前面并说明，
           省掉一次"输入名字 → 被拒绝"的无谓往返。 */
  async function onHardDeleteProject(id, name) {
    let pv = null;
    try { pv = await Api.hardDeletePreview(id); }
    catch (e) { pv = null; }

    if (pv && pv.activeTasks) {
      toast('该项目还有 ' + pv.activeTasks.count + ' 个生成任务在跑，请先等待完成或取消任务', 'err');
      return;
    }

    let body = '这会**永久删除**项目「' + name + '」及其全部分镜表、分镜、素材、生成记录，' +
      '并删掉磁盘上的 data/projects/' + id + '/ 目录（含所有素材图与已生成的视频）。\n\n';
    if (pv) {
      const c = pv.counts || {}, d = pv.disk || {};
      body += '将要删除：\n'
        + '  · 分镜表 ' + (c.workspaces || 0) + ' 张 · 分镜 ' + (c.storyboards || 0) + ' 个\n'
        + '  · 素材 ' + (c.assets || 0) + ' 个 · 生成记录 ' + (c.records || 0) + ' 条\n'
        + '  · 磁盘文件 ' + (d.files || 0) + ' 个（视频 ' + (d.videos || 0)
        + ' · 封面 ' + (d.covers || 0) + ' · 图片 ' + (d.images || 0) + '），'
        + '共约 ' + fmtBytes(d.bytes || 0) + '\n\n'
        + '删除前会自动把该项目归档到 data/backup/hard-delete/（仅作留底，界面上无法恢复）。\n\n';
    }
    body += '此操作**无法撤销**。如果只是想让项目从列表里消失，请改用「删除项目」（软删除）。\n\n'
      + '确认请原样输入项目名：';

    const typed = await uiPrompt('彻底删除项目（不可恢复）', body, '');
    if (typed === null) return;
    if (String(typed).trim() !== name) { toast('输入的项目名不一致，已取消（未做任何改动）', 'err'); return; }
    try {
      const res = await Api.hardDeleteProject(id);
      const c = res.counts || {};
      toast('已彻底删除「' + res.name + '」：' + (res.removedFiles || 0) + ' 个文件、' +
        (c.storyboards || 0) + ' 个分镜、' + (c.assets || 0) + ' 个素材、' + (c.records || 0) + ' 条记录', 'ok');
      /* 归档位置要说出来：这是唯一能找回被删内容的途径。
         后端返回的 backupDir 是**相对数据根**的路径（如 backup/hard-delete/<id>-<时间>），
         直接拼在提示里，用户才知道去哪里翻。 */
      if (res.backupDir) {
        toast('删除前已归档到 data/' + res.backupDir + '（可手工找回）', 'ok');
      }
      /* 目录没删干净时必须说出来 —— 界面显示"已删除"但磁盘上还有残留，
         是最容易让人错过的那种问题。 */
      if (res.residualDir) {
        toast('注意：项目目录未能完全删除（可能有文件被占用），请手工检查 data/projects/' + id + '/', 'err');
      }
      await enterHome();
    } catch (e) { fail(e); }
  }

  async function onNewWorkspace() {
    if (!S.cur.projectId) return;
    const name = await uiPrompt('新建分镜表', '分镜表是分镜的容器。同一项目下的分镜表共享素材库，但分镜互相独立。', defaultWorkspaceName());
    if (name === null) return;
    const nm = String(name).trim();
    if (!nm) { toast('分镜表名称不能为空', 'err'); return; }
    try {
      const w = await Api.createWorkspace(S.cur.projectId, { name: nm });
      toast('分镜表「' + w.name + '」已创建', 'ok');
      await loadProjectHome();
    } catch (e) { fail(e); }
  }

  async function onRenameWorkspace(id, cur) {
    const name = await uiPrompt('重命名分镜表', '改名后旧的分镜、素材与生成记录都不受影响；生成记录里仍显示生成当时的名字。', cur || '');
    if (name === null) return;
    const nm = String(name).trim();
    if (!nm) { toast('分镜表名称不能为空', 'err'); return; }
    try {
      await Api.patchWorkspace(id, { name: nm });
      toast('已重命名', 'ok');
      await loadProjectHome();
    } catch (e) { fail(e); }
  }

  async function onDeleteWorkspace(id, name) {
    const okd = await uiConfirm('删除分镜表', '确定删除分镜表「' + name + '」？\n\n' +
      '这是**软删除**：表里的分镜与生成记录都保留，本项目的**素材库不受影响**（素材属于项目，不属于分镜表）。' +
      '如果表下还有生成中的任务，删除会被拒绝。');
    if (!okd) return;
    try {
      await Api.deleteWorkspace(id);
      toast('分镜表已删除（软删除）', 'ok');
      await loadProjectHome();
    } catch (e) { fail(e); }
  }

  /* 首页与项目主页的事件委托（内容每次重绘，所以挂在容器上委托） */
  function bindPageViews() {
    const home = $('#homeView');
    if (home) {
      home.addEventListener('click', (e) => {
        const act = e.target.closest('[data-pjact]');
        if (act) {
          const id = act.dataset.pjid;
          const p = S.home.list.find((x) => x.id === id);
          if (act.dataset.pjact === 'rename') return onRenameProject(id, p && p.name);
          if (act.dataset.pjact === 'del') return onDeleteProject(id, (p && p.name) || id);
          return;
        }
        const card = e.target.closest('[data-pj]');
        if (card) return enterProject(card.dataset.pj);
      });
    }
    const proj = $('#projView');
    if (proj) {
      proj.addEventListener('click', (e) => {
        /* 素材卡片：删除钮必须先于卡片点击处理（与素材面板同一套顺序），
           否则会被卡片处理器吞掉，表现为"点 × 却打开了素材详情"。
           这里直接复用 onAssetDelete / onAssetClick —— 进入项目主页时
           resetScopeState 已把 assetSelMode / bindTarget 清空，
           所以 onAssetClick 会走到"打开素材设置"这一条，正是项目资产库要的行为。 */
        const assetDel = e.target.closest('[data-assetdel]');
        if (assetDel) return onAssetDelete(assetDel.dataset.assetdel);
        const assetEl = e.target.closest('[data-asset]');
        if (assetEl) return onAssetClick(assetEl.dataset.asset);

        const tab = e.target.closest('[data-ptab]');
        if (tab) {
          const k = tab.dataset.ptab;
          S.proj.tab = k;
          /* 四个都是**内容页签**：只换下方内容，视图头部与导航栏保持不动。
             renderProjHome 内部负责挂载/卸载就地面板（记录 / 设置）。 */
          renderProjHome();
          if (k === 'assets') loadProjAssets();
          return;
        }
        const wsact = e.target.closest('[data-wsact]');
        if (wsact) {
          const id = wsact.dataset.wsid;
          const w = S.proj.workspaces.find((x) => x.id === id);
          if (wsact.dataset.wsact === 'rename') return onRenameWorkspace(id, w && w.name);
          if (wsact.dataset.wsact === 'del') return onDeleteWorkspace(id, (w && w.name) || id);
          return;
        }
        const atab = e.target.closest('[data-atab]');
        if (atab) { S.proj.assetTab = atab.dataset.atab; renderProjAssets(); loadProjAssets(); return; }
        if (e.target.id === 'projAssetUp') return openAssetImport(S.proj.assetTab);
        /* 新建瓦片：类型**只认当前资产库标签页**（S.proj.assetTab）。
           ⚠ 不能像批量导入那样读 S.panelTab —— 那是分镜面板的标签，资产库切页不会同步它，
             于是站在「场景」页新建会被存成「角色」。 */
        const newAsset = e.target.closest('[data-newasset]');
        if (newAsset) return createAssetFlow(newAsset.dataset.newasset);
        const row = e.target.closest('[data-ws]');
        if (row) return enterWorkspace(S.cur.projectId, row.dataset.ws);
      });
      // 资产搜索：250ms 防抖，与素材面板一致
      proj.addEventListener('input', (e) => {
        if (e.target.id !== 'projAssetKw') return;
        S.proj.assetKeyword = e.target.value;
        if (S.panelTimer) clearTimeout(S.panelTimer);
        S.panelTimer = setTimeout(() => loadProjAssets(true), 250);
      });
    }
    // 首页 / 项目主页 的按钮
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('#homeNew', () => onNewProject());
    on('#homeRefresh', () => loadProjects());
    /* 首页也要能进设置（2026-09-21 用户反馈：此前只有进了项目页才够得着设置，
       而"刚装完还没建项目、正要去装创作 CLI"恰恰是最需要设置的场景）。
       抽屉本身对空库是安全的：openSettings 里三个请求各自 catch，取不到就渲染占位。 */
    on('#homeSettings', () => openSettings());
    on('#projBack', () => enterHome());
    on('#projNewWs', () => onNewWorkspace());
    on('#projRename', () => { if (S.cur.project) onRenameProject(S.cur.project.id, S.cur.project.name); });
    on('#projDelete', () => { if (S.cur.project) onDeleteProject(S.cur.project.id, S.cur.project.name); });
    on('#projHardDelete', () => { if (S.cur.project) onHardDeleteProject(S.cur.project.id, S.cur.project.name); });
    on('#crumbHome', () => enterHome());
    on('#projName', () => { if (S.cur.projectId && S.view !== 'project') enterProject(S.cur.projectId); });
  }

  /* 项目主页的资产列表（按当前分类/关键词重取） */
  async function loadProjAssets(keepFocus) {
    try {
      const a = await Api.listAssets({ type: S.proj.assetTab, keyword: S.proj.assetKeyword || undefined });
      S.proj.assets = a.library || [];
    } catch (e) { S.proj.assets = []; }
    const pos = keepFocus ? (($('#projAssetKw') || {}).value || '').length : null;
    renderProjAssets();
    if (pos !== null) {
      const el = $('#projAssetKw');
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) { /* noop */ } }
    }
  }

  function render() { renderTopbar(); renderTable(); renderPanel(); renderStatusbar(); }

  /* 素材面板覆盖层化（模块层助手）：
     ≤1440px 时面板 fixed 在屏外（见 styles.css 主界面响应式段），须手动唤起/关闭。
     宽屏（>1440）面板常驻，matchMedia 不命中 → 两个函数都是空操作，行为与改造前完全一致。
     ⚠ 这里的 1440 必须与 styles.css 的 @media (max-width:1440px) 严格一致，
       否则会出现「面板已被 CSS 固定到屏外、点按钮却唤不起来」的静默失效。 */
  function openPanelIfOverlay() {
    if (!window.matchMedia('(max-width:1440px)').matches) return;
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

  /* 停止轮询。**同时把代际令牌 +1**（指令 §38）：只 clearTimeout 拦不住已经发出、
     正在等响应的那一轮 —— 它回来时会照常 Object.assign 到 S.list 并重绘，
     把上一张分镜表的进度画到新表的表格上。代际变了，那一轮自己就作废了。 */
  function stopPolling() {
    if (S.poll.timer) { clearTimeout(S.poll.timer); S.poll.timer = null; }
    S.poll.gen++;
  }
  function ensurePolling() {
    /* 轮询只在工作区视图里有意义（指令 §39）：首页/项目主页没有分镜表，
       继续轮询只是后台空转，还会在切回来时把过期数据写进界面。 */
    if (S.view !== 'workspace') return;
    if (S.poll.timer) return;
    if (document.hidden) return;
    if (!activeIds().length) return;
    S.poll.idle = 0;
    S.poll.lastSig = null;   // 新一轮轮询：清掉上一轮的载荷签名，否则首轮会被误判成"没变化"
    pollOnce();
  }

  async function pollOnce() {
    S.poll.timer = null;
    /* 本轮的身份快照。每次 await 之后都要重新比对：
       代际（切换过项目/分镜表）或视图（离开了工作区）变了，就丢弃这一轮的结果。 */
    const gen = S.poll.gen;
    const ws = S.cur.workspaceId;
    const stale = () => gen !== S.poll.gen || ws !== S.cur.workspaceId || S.view !== 'workspace';

    const ids = activeIds();
    if (!ids.length) return;                       // 全部终态 → 停止轮询

    const base = POLL_BASE();
    let delay = base;
    try {
      const changed = await Api.getProgress(ids.slice(0, 50));
      if (stale()) return;                         // 响应已属于上一轮 → 一个字段都不写
      /* 服务端已不再"读后清" dirty（原因见 services.getProgress：那会让第二个标签页
         永远收不到更新）。代价是它每轮都会把仍是 dirty 的行再回一遍，所以"有没有变化"
         改由这里按**载荷签名**判断：内容与上一轮完全相同就算无变化，照常退避。
         否则生成期间每轮都非空 ⇒ 永不退避，一直按 3s 打。 */
      const sig = changed.map((c) => c.id + ':' + c.status + ':' + c.progress + ':' + c.retryCount + ':' + (c.errorCode || '')).join('|');
      const sameAsLast = sig === S.poll.lastSig;
      S.poll.lastSig = sig;
      if (!changed.length || sameAsLast) {
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
        if (terminal) {
          await loadList({ skeleton: false });   // 收口时以服务端统计为准
          if (stale()) return;
        }
      }
    } catch (e) {
      if (stale()) return;
      S.poll.idle++;
      delay = Math.min(30000, base * Math.pow(2, S.poll.idle));   // 429 / 网络异常 → 指数退避，不打扰用户
      if (!e || e.code !== Api.ERR.RATELIMIT) fail(e);
    }
    /* 续期前再验一次身份：视图已切换就不要再排下一轮（stopPolling 已经 +1 代际，
       这里若还排下去就会留下一条"幽灵轮询链"）。 */
    if (stale()) return;
    if (activeIds().length && !document.hidden) S.poll.timer = setTimeout(pollOnce, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();            // 页面隐藏暂停
    else ensurePolling();                          // 恢复时立即拉一次（非工作区视图会被 ensurePolling 拦下）
  });

  /* ---------------------------------------------------------- 行内交互 */
  document.addEventListener('click', async (ev) => {
    const t = ev.target;

    /* 关闭下拉 */
    if (!t.closest('.menu') && !t.closest('[data-val]')) closeMenu();

    /* ---- 素材面板 ----
       ⚠ 本处理器挂在 **document** 上，会收到**全页面**的点击。项目页资产库会渲染**同样**的
       data-asset / data-assetdel / data-newasset（由 #projView 自己的处理器处理）——
       不限定容器的话两处都会执行：点一张卡片会弹出**两个**素材详情弹窗、点一次新建会弹出
       两个新建对话框（2026-09-20 实测踩到）。所以这几个分支都要求目标确实在 #panel 内。
       分镜面板里的事件顺序：删除钮必须先于卡片处理，否则会被卡片处理器吞掉。 */
    if (t.closest('#panel')) {
      const assetDel = t.closest('[data-assetdel]');
      if (assetDel) { await onAssetDelete(assetDel.dataset.assetdel); return; }
      const newAsset = t.closest('[data-newasset]');
      if (newAsset) { await createAssetFlow(S.panelTab); return; }
      const assetEl = t.closest('[data-asset]');
      if (assetEl) { await onAssetClick(assetEl.dataset.asset); return; }
      const tabEl = t.closest('[data-tab]');
      if (tabEl) { S.panelTab = tabEl.dataset.tab; S.panelKeyword = ''; await loadAssets(); return; }
    }

    /* ---- 表格行 ---- */
    const rowEl = t.closest('.row');
    if (!rowEl) return;
    const s = rowById(rowEl.dataset.id);
    if (!s) return;

    if (t.closest('[data-check]')) { S.sel.has(s.id) ? S.sel.delete(s.id) : S.sel.add(s.id); renderTable(); renderPanel(); renderStatusbar(); return; }

    if (t.closest('[data-zoom]')) {   // 提示词放大：全屏看完整文本，素材名照样着色
      openFullscreenText('分镜 ' + s.seq + ' · 提示词', highlightPrompt(s.prompt));
      return;
    }

    const step = t.closest('[data-step]');
    if (step) { stepDuration(s, Number(step.dataset.step)); return; }

    if (t.closest('[data-val]')) { openPresetMenu(t.closest('.dur'), s); return; }

    const bind = t.closest('[data-bind]');
    if (bind) {
      const role = bind.dataset.bind;
      /* 参考图已达上限 → 拦在这里并说明清楚，不弹选择弹窗。
         （弹窗内部还会再拦一道，防止配额在校准后变化；两处口径同源，都是后端下发的
           imageCount / imageLimit，即 models.js 系列规则表里的数。） */
      if (role !== 'audio' && s.imageLimit != null && (s.imageCount || 0) >= s.imageLimit) {
        toast('已达参考图上限：当前模型（' + s.model + '）最多 ' + s.imageLimit + ' 张，本分镜已用满 ' + s.imageCount +
          ' 张。请先移除部分图片释放名额' +
          (s.imageLimit < 30 ? '，或把该分镜改用 Seedance 2.5（上限 30 张）' : '') + '。', 'err');
        return;
      }
      /* bindTarget 保留原语义：它同时驱动素材面板的「本分镜素材」区与快捷点选路径
         （弹窗是显式路径，面板那条快捷路径仍然可用，见 onAssetClick ②）。 */
      S.bindTarget = { id: s.id, role };
      S.panelTab = ROLE_META[role].type;
      S.panelKeyword = '';
      await loadAssets();
      openPanelIfOverlay();   // 窄屏面板在屏外：点「＋」后主动唤起，弹窗关掉后仍可点选
      const added = await openAssetPicker(s, role);   // 弹出资产选择弹窗（本次新增的主路径）
      if (added) {
        // 确定后：收掉绑定态、刷新表格槽位（让「已添加资产」立刻显示）与素材面板
        S.bindTarget = null;
        await loadList({ skeleton: false });
        await loadAssets();
      }
      return;
    }
    const unb = t.closest('[data-unbind]');
    if (unb) { await unbind(s, unb.dataset.unbind); return; }

    /* 已绑定的素材格 → 预览 + 替换弹窗。必须排在 data-unbind 之后：
       × 是 .thumb 的子元素，先命中上面的分支才算「移除」，否则会变成点开预览。 */
    const bnd = t.closest('[data-bound]');
    if (bnd) { await openBoundAsset(s, bnd.dataset.role, bnd.dataset.bound); return; }

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
  /* 全屏查看器的公共外壳：遮罩 + 关闭钮 + Esc / 点空白退出。inner 由调用方给，返回 close()。 */
  function openFullscreenShell(innerHTML, extraClass) {
    const v = document.createElement('div');
    v.className = 'fs-viewer' + (extraClass ? ' ' + extraClass : '');
    v.style.zIndex = 300;
    v.innerHTML = innerHTML +
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

  function openFullscreenViewer(url, alt) {
    return openFullscreenShell('<img src="' + esc(url) + '" alt="' + esc(alt || '') + '" />');
  }

  /* 提示词全屏查看：内容已是转义过的 HTML（含素材名着色），面板内可滚动。
     点面板内部不会关闭 —— 关闭只在点遮罩本身时触发（外壳里判的是 ev.target === v）。 */
  function openFullscreenText(title, html) {
    return openFullscreenShell(
      '<div class="fs-panel">' +
        '<div class="fs-panel-head"><b>' + esc(title) + '</b></div>' +
        '<div class="fs-panel-body">' + html + '</div>' +
      '</div>', 'fs-textview');
  }

  /* ---------------- 新建素材（资产库的「新建…」瓦片） ----------------
     为什么单独做一个弹窗而不是复用「素材详情」：详情弹窗是**编辑既有素材**的，
     保存路径是"改名 / 换文件 / 改提示词"；新建需要的是"先建元数据、再补文件"，
     校验也不同（名称必填）。但两者的**视觉与关闭行为必须一致**，
     所以结构照抄 openAssetSettings：同一个 .modal.narrow + head/body/foot、
     同样支持 × / 取消 / ESC / 点遮罩关闭、关闭时回收 blob URL。

     ⚠ 音频与图片的创建路径**完全分开**（各自的文件选择控件与提示）：
     音频没有图片预览、没有文生图提示词（与详情弹窗一致），图片不接受音频文件。 */
  function openAssetCreate(type) {
    return new Promise((resolve) => {
      const isAudio = type === 'audio';
      const label = ASSET_TAB_LABEL[type] || '素材';
      const accept = isAudio ? 'audio/*' : 'image/*';
      /* 音频的时长上限提示取服务端下发的值，不硬编码 15（改了 config 界面要跟着变）。
         拿不到就退到 15 —— 与后端默认值一致，且这里只是**提示文案**，
         真正的硬上限在服务端（checkAudioBudget）。 */
      const secMax = Number((opts() || {}).audioSecMax) || 15;

      /* 预览区：图片可点选文件（与详情弹窗同一套 .asset-preview.pickable）；
         音频用与图片资产默认封面同一套的半透明空槽位 + **本地播放器** ——
         详情弹窗的音频区不可点击，没有现成的选文件入口，新建必须有。 */
      const previewHTML = isAudio
        ? '<div class="asset-preview audio" id="naAudioBox">' +
            '<span class="empty-ph">' + I.notePh + '<span>选择音频文件后可在这里试听</span></span>' +
          '</div>' +
          '<div class="row-inline"><span class="label-sm">音频文件</span>' +
            '<button class="btn-outline btn-sm" id="naPick">选择音频文件</button>' +
            '<span class="hint-sm" id="naFileName">未选择（也可以先建好，之后再补文件）</span>' +
          '</div>'
        : '<div class="asset-preview pickable" id="naPreview">' +
            '<span class="empty-ph">' + I.img + '<span>点击上传图片</span></span>' +
          '</div>';

      const promptHTML = isAudio ? '' :
        '<div class="sec-title" style="margin-top:12px">文生图提示词</div>' +
        '<div class="asset-promptwrap">' +
          '<textarea id="naPrompt" class="asset-prompt" placeholder="可选。该资产的文生图提示词，可粘贴整段（含风格要求、反向提示词）。" maxlength="10000"></textarea>' +
          '<span class="hint-sm" id="naPromptCount">0 / 10000</span>' +
        '</div>';

      const mask = document.createElement('div');
      mask.className = 'mask'; mask.style.zIndex = 200;
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>新建' + esc(label) + '</h2><span class="grow"></span>' +
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            previewHTML +
            '<div class="row-inline"><span class="label-sm">名称</span>' +
              '<input class="input-sm" id="naName" style="flex:1;min-width:0" maxlength="60" ' +
                'placeholder="' + (isAudio ? '留空则用文件名；例如：林晚音色' : '留空则用文件名；例如：林晚') + '" /></div>' +
            '<div class="row-inline"><span class="label-sm">类型</span><span class="hint-sm">' + esc(label) + '</span></div>' +
            (isAudio
              ? '<div class="hint-sm">建议按「<strong>角色名 + 音色</strong>」命名（如「林晚音色」）——' +
                  '自动匹配会把它关联到提示词里的「林晚」。' +
                  '音频参考有数量与总时长两重上限（总时长上限 ' + secMax + ' 秒）。</div>'
              : '') +
            promptHTML +
            '<input type="file" id="naFile" accept="' + accept + '" hidden />' +
          '</div>' +
          '<div class="modal-foot">' +
            '<span class="hint-sm" id="naHint"></span><span class="grow"></span>' +
            '<button class="btn-outline" data-cancel>取消</button>' +
            '<button class="btn-primary" data-ok>创建</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);

      let picked = null;              // 选中的文件（可为空 = 先建空素材）
      let pickedSec = null;           // 音频读到的时长（秒），读不到为 null
      let previewBlobUrl = null;
      const done = (v) => {
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
        mask.remove();
        resolve(v);
      };
      const hint = (t, kind) => {
        const el = mask.querySelector('#naHint');
        if (el) { el.textContent = t || ''; el.className = 'hint-sm' + (kind ? ' ' + kind : ''); }
      };

      const fileInput = mask.querySelector('#naFile');
      /* 没填名称时的默认名：**用所选文件的文件名**（去扩展名），与后端 createAsset 的
         默认命名一致。名称栏此刻是空的才自动填 —— 已经填了就不覆盖用户的输入。
         名称栏是空的且还没选文件时，栏位里给一个灰提示（placeholder）说明这条规则。 */
      function applyDefaultName(f) {
        if (!nameEl || !f) return;
        if (String(nameEl.value || '').trim()) return;
        const base = stripAssetExt(String(f.name || '')).trim();
        if (base) nameEl.value = base.slice(0, 60);
      }
      async function acceptFile(f) {
        if (!f) return;
        picked = f;
        applyDefaultName(f);
        if (isAudio) {
          const nameEl2 = mask.querySelector('#naFileName');
          if (nameEl2) nameEl2.textContent = f.name + '（读取时长…）';
          /* 本地试听：不等保存，选中就能听（与图片"选中即预览"同一个体验）。
             ⚠ 用 blob URL，关闭弹窗时必须回收（done 里统一 revoke）。 */
          if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
          previewBlobUrl = URL.createObjectURL(f);
          const box = mask.querySelector('#naAudioBox');
          if (box) box.innerHTML = '<audio controls preload="metadata" src="' + previewBlobUrl + '"></audio>';
          /* 前端读时长是**主来源**（不依赖任何外部程序）；读不到就留 null，
             服务端会用 ffprobe 兜底。两者都失败 → 时长未知 → 不允许绑定（后端守卫）。 */
          pickedSec = await readAudioDuration(f);
          if (nameEl2) {
            nameEl2.textContent = f.name + (pickedSec != null ? '（' + pickedSec.toFixed(2) + ' 秒）' : '（读不到时长，创建后由服务端再试）');
          }
          return;
        }
        // 图片：选中即本地预览（与详情弹窗同款，不等保存）
        if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = URL.createObjectURL(f);
        const box = mask.querySelector('#naPreview');
        if (box) {
          box.classList.add('has-pic');
          box.innerHTML = '<img src="' + previewBlobUrl + '" alt="预览" />';
        }
      }
      fileInput.addEventListener('change', () => { acceptFile(fileInput.files && fileInput.files[0]); });
      const pickBtn = mask.querySelector('#naPick');
      if (pickBtn) pickBtn.addEventListener('click', () => fileInput.click());
      const previewBox = mask.querySelector('#naPreview');
      if (previewBox) previewBox.addEventListener('click', () => fileInput.click());

      const promptEl = mask.querySelector('#naPrompt');
      if (promptEl) {
        promptEl.addEventListener('input', () => {
          const c = mask.querySelector('#naPromptCount');
          if (c) c.textContent = promptEl.value.length + ' / 10000';
        });
      }
      const nameEl = mask.querySelector('#naName');
      if (nameEl) nameEl.focus();

      const submit = () => {
        let name = String((nameEl && nameEl.value) || '').trim();
        /* 名称留空不直接拦：**有文件就用文件名兜底**（与后端默认命名一致）。
           两个都没有才报错 —— 那时确实没有任何可用的名字。 */
        if (!name && picked) name = stripAssetExt(String(picked.name || '')).trim();
        if (!name) {
          hint(picked ? '这个文件名取不出名称，请手动填一个' : '请填素材名称，或先选一个文件（会用文件名作为默认名称）', 'err');
          if (nameEl) nameEl.focus();
          return;
        }
        if (name.length > 60) { hint('素材名称不能超过 60 个字符', 'err'); return; }
        done({
          name: name,
          prompt: promptEl ? String(promptEl.value || '').trim() : '',
          file: picked,
          durationSec: pickedSec
        });
      };
      mask.querySelector('[data-ok]').addEventListener('click', submit);
      if (nameEl) {
        nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      }
      mask.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      mask.querySelector('[data-x]').addEventListener('click', () => done(null));
      mask.addEventListener('click', (ev) => { if (ev.target === mask) done(null); });
      document.addEventListener('keydown', function esc3(ev) {
        if (ev.key !== 'Escape') return;
        document.removeEventListener('keydown', esc3); done(null);
      });
    });
  }

  /* 读音频文件的时长（秒）。**不依赖任何外部程序**：浏览器自己解元数据。
     为什么需要它：音频参考有"总时长上限"，而时长只能从文件本身得到。
     ⚠ 并非所有格式都能读到（部分 .flac/.ogg 拿不到 duration），
       所以读不到时返回 null 而不是 0 —— 服务端还会用 ffprobe 兜底，
       两边都失败就是"未知"，绑定时会被明确拦下（而不是当成 0 悄悄放过）。 */
  function readAudioDuration(file) {
    return new Promise((resolve) => {
      let url = null;
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        if (url) URL.revokeObjectURL(url);
        resolve(v);
      };
      try {
        url = URL.createObjectURL(file);
        const a = new Audio();
        a.preload = 'metadata';
        a.addEventListener('loadedmetadata', () => {
          const d = Number(a.duration);
          finish(Number.isFinite(d) && d > 0 ? Math.round(d * 100) / 100 : null);
        });
        a.addEventListener('error', () => finish(null));
        /* 兜底超时：某些编码下浏览器既不触发 loadedmetadata 也不触发 error，
           不设上限的话"选完文件就卡住"。 */
        setTimeout(() => finish(null), 5000);
        a.src = url;
      } catch (e) { finish(null); }
    });
  }

  /* 新建流程：**先建元数据，再补文件**。
     为什么这个顺序：① 名称是用户唯一的输入，先落库才能保证它不丢；
     ② 空素材是合法状态（提示词导入产生的素材本来就没有文件）；
     ③ 补文件失败时**不回滚** —— 素材已存在且名称正确、显示「无图」，
        用户可在素材详情里重试；回滚会把刚填的名称一起丢掉，反而更糟。 */
  async function createAssetFlow(type) {
    if (S.assetBusy) return;
    const r = await openAssetCreate(type);
    if (!r) return;
    S.assetBusy = true;
    try {
      const body = { name: r.name, type: type };
      if (r.prompt) body.prompt = r.prompt;
      const created = await Api.createAsset(body);
      if (r.file) {
        try {
          await Api.replaceAsset(created.id, r.file, r.name, r.durationSec);
        } catch (e) {
          /* 素材已建成，只是文件没上去 —— 如实说明并指出怎么补，不要假装成功 */
          await loadProjAssets();
          if (S.proj.tab === 'assets') renderProjAssets();
          toast('素材「' + r.name + '」已创建，但文件上传失败：' + errText(e) + '。可在素材详情里重新上传。', 'err');
          return;
        }
      }
      toast('已新建' + (ASSET_TAB_LABEL[type] || '素材') + '「' + r.name + '」' +
        (r.file ? '' : '（还没有文件，可稍后在素材详情里补）'), 'ok');
      await loadProjAssets();
      if (S.proj.tab === 'assets') renderProjAssets();
      await loadAssets();          // 让分镜面板的素材面板也刷新（新建的素材应立即可用）
    } catch (e) {
      fail(e);
    } finally {
      S.assetBusy = false;
    }
  }

  /* 音频素材的预览内容：**有文件就给真实播放器**（`<audio controls>`），没有就给半透明占位。
     两个弹窗（素材详情 / 素材预览）共用同一份，避免两处各写各的、行为漂移。
     ⚠ 必须走 mediaUrl()：素材地址是 `/media/assets/...` 这种同源相对路径，
       发布版单文件（file://）下要拼上后端源才播得出来。 */
  function audioPreviewHTML(a) {
    if (a && a.url) {
      return '<audio controls preload="metadata" src="' + esc(mediaUrl(a.url)) + '"></audio>' +
        (Number.isFinite(a.durationSec) ? '<span class="hint-sm audio-dur">时长 ' + a.durationSec + ' 秒</span>' : '');
    }
    return '<span class="empty-ph">' + I.notePh + '<span>这个音频还没有文件</span></span>';
  }

  function openAssetSettings(asset) {
    return new Promise((resolve) => {
      const accept = asset.type === 'audio' ? 'audio/*' : 'image/*';
      // 图片用真实 <img> + object-fit:contain 完整展示（原用 background-size:cover 会裁掉四周）
      const hasPic = !!asset.url && asset.type !== 'audio';
      const previewHTML = (asset.type === 'audio')
        ? audioPreviewHTML(asset)
        : (asset.url ? '<img id="asPreviewImg" src="' + esc(asset.url) + '" alt="' + esc(asset.name) + '" />' : '');
      const kindLabel = ASSET_TAB_LABEL[asset.type] || asset.type;
      // 提示词编辑区：音频无提示词概念，不展示
      const isAudio = asset.type === 'audio';
      const promptVal = asset.prompt || '';
      /* 图片上的悬浮钮只留「全屏预览」：换图入口就是图片区本身（点击即选文件），
         再挂一个换图钮纯属重复。全屏要有图才有意义，故无图时先 hidden，
         选中文件后由 showLocalPreview 放出来。 */
      const fsBtn = isAudio ? '' :
        '<button class="fs-btn" id="asFull" title="全屏预览（查看细节）"' + (hasPic ? '' : ' hidden') + '>' + I.expand + '</button>';
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
            /* 无图时不铺渐变：改由 CSS 给一个半透明的「图片样式」占位（见 .asset-preview.pickable）；
               音频同理 —— 它本来就没有可显示的封面，用同一套半透明空槽位 + 播放器。 */
            '<div class="asset-preview' + (isAudio ? ' audio' : ' pickable' + (hasPic ? ' has-pic' : '')) + '">' +
              previewHTML +
              fsBtn +
              (!hasPic && !isAudio ? '<span class="empty-ph">' + I.img + '<span>点击上传图片</span></span>' : '') +
            '</div>' +
            '<div class="row-inline"><span class="label-sm">名称</span>' +
              '<input class="input-sm" id="asName" style="flex:1;min-width:0" maxlength="60" value="' + esc(asset.name) + '" /></div>' +
            /* 类型可改（2026-09-21）：导入图片时的类型取的是"当时所在页签"，页签默认「角色」，
               场景/道具的图很容易被堆进角色分类。这里给一个改回去的入口。
               音频只有一种类型，不展示下拉。 */
            (isAudio ? '' :
              '<div class="row-inline"><span class="label-sm">类型</span>' +
                '<select class="input-sm" id="asType">' +
                  ['character', 'scene', 'prop', 'firstFrame', 'storyboard']
                    .map((t) => '<option value="' + t + '"' + (asset.type === t ? ' selected' : '') + '>' + esc(ASSET_TAB_LABEL[t]) + '</option>').join('') +
                '</select>' +
                '<span class="hint-sm" id="asTypeHint"></span></div>') +
            promptHTML +
            /* 上传入口只有图片区本身（点击即选文件），下方不再有「素材文件 / 更换文件」行 */
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
      let currentImgUrl = hasPic ? asset.url : null;   // 当前预览图地址（本地新选的指向 blob URL）
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
        currentImgUrl = previewBlobUrl;
        /* 视图要跟着状态一起变，否则按钮/占位和实际能力对不上：
           · 空槽位的虚线框让位（.has-pic），点进去才知道已经有图了；
           · 无图时 hidden 的「全屏」钮放出来（无图点它没意义）。 */
        const box = mask.querySelector('.asset-preview');
        if (box) { box.classList.add('has-pic'); box.title = '点击更换图片'; }
        const fsBtnEl = mask.querySelector('#asFull');
        if (fsBtnEl) fsBtnEl.hidden = false;
      }
      const nameEl = mask.querySelector('#asName');
      const promptEl = mask.querySelector('#asPrompt');
      if (promptEl) {
        promptEl.addEventListener('input', () => {
          mask.querySelector('#asPromptCount').textContent = promptEl.value.length + ' / 10000';
        });
      }
      const fsEl = mask.querySelector('#asFull');
      if (fsEl) fsEl.addEventListener('click', () => { if (currentImgUrl) openFullscreenViewer(currentImgUrl, asset.name); });
      /* 图片区本身就是上传入口：整块可点。悬浮的「全屏」钮有自己的动作，
         点它时不能被这里抢走 —— 否则点全屏会弹出文件选择框。 */
      const previewBox = mask.querySelector('.asset-preview');
      if (previewBox && !isAudio) {
        previewBox.title = hasPic ? '点击更换图片' : '点击上传图片';
        previewBox.addEventListener('click', (ev) => {
          if (ev.target.closest('.fs-btn')) return;
          mask.querySelector('#asFile').click();
        });
      }
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
        const typeEl = mask.querySelector('#asType');
        done({ name: name, prompt: prompt, file: picked, type: typeEl ? typeEl.value : undefined });
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

  /* 打开素材详情并落库（改名 / 改提示词 / 换文件 / 改类型） */
  async function editAsset(assetId) {
    const a = findAssetAnywhere(assetId);
    if (!a) return;
    const r = await openAssetSettings(a);
    if (!r) return;
    const oldPrompt = a.prompt || '';
    const promptChanged = r.prompt !== undefined && r.prompt !== oldPrompt;
    const typeChanged = !!r.type && r.type !== a.type;
    if (!r.file && r.name === a.name && !promptChanged && !typeChanged) { toast('未做任何修改', 'ok'); return; }
    /* 改类型会**解绑所有引用它的分镜** —— 绑定的 role 就是素材类型，不改就会错位
       （一个道具挂在角色槽里）。所以先查准确的引用数、让用户确认，再动手。 */
    if (typeChanged) {
      let n = 0, names = [];
      try {
        const u = await Api.assetUsage(a.id);
        n = u.count || 0;
        names = (u.storyboards || []).map((x) => x.name).filter(Boolean);
      } catch (e) { /* 查不到引用数就按 0 处理；后端仍会解绑并在返回里给 unbound */ }
      const detail = n
        ? '该素材已被 ' + n + ' 条分镜引用，改类型会解除这些绑定：\n' +
          names.slice(0, 5).join('、') + (names.length > 5 ? ' 等' : '') + '\n\n确定要改类型吗？'
        : '把「' + a.name + '」从「' + (ASSET_TAB_LABEL[a.type] || a.type) + '」改为「' +
          (ASSET_TAB_LABEL[r.type] || r.type) + '」？';
      if (!(await uiConfirm('修改素材类型', detail))) return;
    }
    try {
      if (r.file) await Api.replaceAsset(a.id, r.file, r.name);
      /* 名称 / 类型 / 提示词：有变化才 PATCH（换文件那条分支已经带上了 name） */
      const patch = {};
      if (typeChanged) patch.type = r.type;
      if (!r.file && r.name !== a.name) patch.name = r.name;
      if (promptChanged) patch.prompt = r.prompt;
      if (Object.keys(patch).length) await Api.updateAsset(a.id, patch);
      toast('素材已更新', 'ok');
      /* 两个资产视图都要刷新：表格槽位上的名称/缩略图，以及项目资产库里的卡片 */
      await afterAssetMutated();
    } catch (e) { fail(e); }
  }

  /* ---------------------------------------------------------- 已绑定素材：预览 / 替换 */
  /* 点分镜素材格打开（用户 2026-09-20 要求：「点击已上传的素材就可以预览这个素材和替换」）。
     与「素材详情」(openAssetSettings) 的分工要说清楚，否则用户分不清两者 ——
     那里编辑的是**素材库里的资产本身**，改一次所有引用它的分镜都会跟着变；
     这里额外给了一个**本分镜作用域**的入口，两个按钮各自写明作用范围：
       · 替换素材 = 在本分镜中改绑素材库里的另一个资产（不动原素材，其它分镜不受影响）
       · 更换文件 = 换掉该资产自己的图片（与素材详情同效，会波及所有引用它的分镜）
     素材格上还有 ×（data-unbind）：那个仍然是「移除绑定」，委托处理器里排在本分支之前。 */
  function openBoundAsset(sb, role, assetId) {
    const meta = ROLE_META[role] || { label: role, type: role };
    const a = (sb.assets || []).find((x) => x.assetId === assetId && x.role === role);
    if (!a) { toast('该素材已不在本分镜中，请刷新后重试', 'err'); return Promise.resolve(false); }
    const isAudio = a.type === 'audio';
    const hasPic = !!(a.url && !/^(mock|cli):/.test(a.url) && !isAudio);
    const kindLabel = ASSET_TAB_LABEL[a.type] || a.type;
    /* 图号 = 提交时 --image 的上传顺序 = 提示词里该写的 @图片N，与后端 asset-lock.imageCatalog 同源。
       预览时把这句话摆出来，作者才知道该在提示词里怎么写。 */
    const numText = a.imageIndex
      ? '图片' + a.imageIndex + '（提交时第 ' + a.imageIndex + ' 张 --image；提示词里写 @图片' + a.imageIndex + ' 引用它）'
      : (a.audioIndex
          ? '音频' + a.audioIndex + '（走 --audio，不占图片号）'
          : '未占用图号');
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'mask'; mask.style.zIndex = 210;
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>素材预览</h2>' +
            '<span class="hint-sm">分镜 ' + sb.seq + ' · ' + esc(meta.label) + '</span>' +
            '<span class="grow"></span>' +
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            /* 有图就原图直出（object-fit:contain，不裁不缩略）；点击整块进全屏看细节。
               无图（提示词导入的那批）沿用「半透明图片占位」，与卡片视觉同一套语言。
               音频同属"没有可显示封面"这一类：半透明空槽位 + 真实播放器。 */
            '<div class="asset-preview' + (isAudio ? ' audio' : (hasPic ? ' has-pic zoomable' : '')) + '">' +
              (isAudio
                ? audioPreviewHTML(a)
                : (hasPic
                    ? '<img src="' + esc(a.url) + '" alt="' + esc(a.name) + '" />' +
                      '<button class="fs-btn" title="全屏预览（查看细节）">' + I.expand + '</button>'
                    : '<span class="empty-ph">' + I.img + '<span>该素材还没有图片</span></span>')) +
            '</div>' +
            '<div class="row-inline"><span class="label-sm">名称</span>' +
              '<span class="hint-sm">' + esc(a.name) + '</span></div>' +
            '<div class="row-inline"><span class="label-sm">类型</span>' +
              '<span class="hint-sm">' + esc(kindLabel) + ' · 槽位「' + esc(meta.label) + '」</span></div>' +
            '<div class="row-inline"><span class="label-sm">图号</span>' +
              '<span class="hint-sm">' + esc(numText) + '</span></div>' +
            (a.notCounted
              ? '<div class="banner warn"><span>未计入图号：' + esc(a.notCounted) +
                '（后面的图号不会因它顺延；点「更换文件」补上图片即可恢复）</span></div>'
              : '') +
            '<div class="hint-sm" style="line-height:1.9">' +
              '· <b>替换素材</b>：在本分镜中改绑素材库里的另一个资产，原素材与其它分镜不受影响。<br/>' +
              '· <b>更换文件</b>：把该素材的图片换成新文件，<b>所有</b>引用它的分镜都会一起换。' +
            '</div>' +
            '<input type="file" id="bpFile" accept="' + (isAudio ? 'audio/*' : 'image/*') + '" hidden />' +
          '</div>' +
          '<div class="modal-foot">' +
            '<span class="hint-sm" id="bpHint"></span><span class="grow"></span>' +
            '<button class="btn-outline" data-file title="把该素材的图片换成另一个本地文件；素材 id 与全部分镜绑定不变，但所有引用它的分镜都会跟着换图">更换文件</button>' +
            '<button class="btn-primary" data-swap title="在本分镜中改绑素材库里的另一个资产；原素材与其它分镜不受影响">替换素材</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);

      let busy = false, pickerOpen = false;
      const q = (s) => mask.querySelector(s);
      const setHint = (t) => { const el = q('#bpHint'); if (el) el.textContent = t || ''; };
      const done = () => { mask.remove(); resolve(true); };

      /* 预览区（含悬浮的全屏钮）统一走全屏查看器：这里看的就是原图本身，不再套第二层弹窗 */
      const box = q('.asset-preview');
      if (box && hasPic) {
        box.title = '点击全屏查看原图';
        box.addEventListener('click', () => openFullscreenViewer(a.url, a.name));
        /* 文件被删掉、但素材记录里还留着旧 url 时，<img> 会 404 成一张"碎图"。
           槽位里的背景图 404 是看不见的，这里却能看见 —— 所以退化成占位并说明原因。 */
        const img = box.querySelector('img');
        if (img) img.addEventListener('error', () => {
          box.classList.remove('zoomable');
          box.removeAttribute('title');
          img.remove();
          const fsb = box.querySelector('.fs-btn');
          if (fsb) fsb.remove();
          box.insertAdjacentHTML('afterbegin',
            '<span class="empty-ph">' + I.img + '<span>图片文件读不到（可能已被删除）<br/>点「更换文件」重新上传</span></span>');
          const bar = q('#bpHint');
          if (bar) bar.textContent = '图片文件读不到，可用「更换文件」补上';
        });
      }

      q('#bpFile').addEventListener('change', async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        ev.target.value = '';                       // 允许连续选同一个文件
        if (!f || busy) return;
        busy = true; setHint('上传中…');
        q('[data-file]').disabled = true; q('[data-swap]').disabled = true;
        try {
          await Api.replaceAsset(a.assetId, f, a.name);   // 保留素材 id 与全部分镜绑定
          toast('已更换「' + a.name + '」的图片', 'ok');
          await loadAssets();
          await loadList({ skeleton: false });     // 槽位缩略图立刻跟着换
          done();
        } catch (e) {
          busy = false; setHint('');
          q('[data-file]').disabled = false; q('[data-swap]').disabled = false;
          fail(e);
        }
      });

      q('[data-swap]').addEventListener('click', async () => {
        if (busy || pickerOpen) return;
        /* 替换复用同一个资产选择弹窗（数据源、类型过滤、配额口径都是同一套），
           只是切到 replace 语义：标题/提示不同，且单值槽位不被"已满额"拦住（换绑不增数）。
           预览弹窗先让位 —— 选择弹窗的 z-index 是 200，压不过这里的 210。 */
        pickerOpen = true;
        mask.style.display = 'none';
        const ok = await openAssetPicker(sb, role, { replace: true, replaceFrom: a.assetId });
        pickerOpen = false;
        mask.style.display = '';
        if (ok) {
          await loadAssets();
          await loadList({ skeleton: false });
          done();
        }
      });

      const close = () => { mask.remove(); resolve(false); };
      q('[data-x]').addEventListener('click', close);
      mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });
      document.addEventListener('keydown', function escBa(ev) {
        if (ev.key !== 'Escape') return;
        if (pickerOpen) return;                     // 选择弹窗自己处理 ESC，别把两层一起关掉
        document.removeEventListener('keydown', escBa); close();
      });
    });
  }

  /* ---------------------------------------------------------- 导入资产（双模式弹窗） */
  /* 模式一：导入本地图片/音频文件（按当前面板 tab 的类型上传，可多选）；
     模式二：粘贴提示词文本 → 后端按「@ 分段」自动识别 场景/道具/角色 → 预览 → 确认导入。
     提示词模式创建的资产暂无图片（渐变占位），点开详情弹窗可补图与编辑提示词。 */
  /* ⚠ 导入的目标类型必须由**打开它的那个界面**决定，不能一律读 S.panelTab：
     资产库切页只改 S.proj.assetTab，从不同步 S.panelTab —— 于是站在资产库的「场景」页
     上传，素材会被存成「角色」（分镜面板上次停留的分类）。这与"音频不与其他类型混用"
     是同一类问题，一并修掉。 */
  function openAssetImport(type) {
    S.imp.impType = type || S.panelTab;
    const isAudioTab = S.imp.impType === 'audio';
    /* 模式：'file' 选文件 / 'text' 粘提示词 / 'preview' 导入预览（确认后才落库） */
    let mode = (S.imp.lastMode === 'text' && !isAudioTab) ? 'text' : 'file';
    let pickedFiles = [];                     // 文件模式待传清单
    let parsed = null;                        // 文本模式解析结果
    let rawText = '';                         // 文本模式的唯一原文来源（面板 DOM 会被重绘）
    let plan = null;                          // 文件模式的导入计划 { rows, lib }
    let conflictAction = 'merge';             // 自动匹配到「已有图资产」时的处理：覆盖 / 跳过 / 并存
    let busy = false;
    const typeLabel = ASSET_TAB_LABEL;
    const tabLabel = ASSET_TAB_LABEL;
    /* 同 kind 的可选类型：图片只能在图片类之间改（角色/场景/道具/首帧/分镜），音频只有音色。
       跨 kind 后端会拒（见 services.updateAsset）—— 这里只列合法的，省得用户白试一遍。 */
    const typeChoices = isAudioTab ? ['audio'] : ['character', 'scene', 'prop', 'firstFrame', 'storyboard'];

    const mask = document.createElement('div');
    mask.className = 'mask'; mask.style.zIndex = 200;
    document.body.appendChild(mask);

    /* 骨架**只建一次**：三个面板常驻 DOM，切模式只改 .on 与内容，不再整体重建 innerHTML。
       为什么坚持这样（2026-09-21 用户反馈"切换太生硬"）：整体重建会把输入框的滚动位置、
       光标、焦点全丢掉；而且两个面板高度差很大 —— 重建时内容瞬换、弹窗高度跟着跳，
       观感就是"生硬"。 */
    mask.innerHTML =
      '<div class="modal narrow">' +
        '<div class="modal-head"><h2>导入资产</h2><span class="grow"></span>' +
          '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
        '<div class="modal-body" id="impBody">' +
          '<div class="seg" id="impSeg" style="margin-bottom:12px">' +
            '<button id="impModeFile">导入图片文件</button>' +
            (isAudioTab ? '' : '<button id="impModeText">导入提示词文本</button>') +
          '</div>' +
          '<div class="imp-pane" id="impPaneFile"></div>' +
          '<div class="imp-pane" id="impPaneText"></div>' +
          '<div class="imp-pane" id="impPanePrev"></div>' +
        '</div>' +
        '<div class="modal-foot" id="impFoot"></div>' +
      '</div>';
    const bodyEl = mask.querySelector('#impBody');
    const segEl = mask.querySelector('#impSeg');
    const paneFile = mask.querySelector('#impPaneFile');
    const paneText = mask.querySelector('#impPaneText');
    const panePrev = mask.querySelector('#impPanePrev');
    const footEl = mask.querySelector('#impFoot');

    const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    /* 高度平滑：先量旧高、改完再量新高，把差值做成过渡。
       ⚠ 必须在改内容**之前**量 —— 改完就量不到旧值了。系统开了"减少动态效果"就跳过。 */
    function withHeightTransition(fn) {
      const from = bodyEl.offsetHeight;
      fn();
      const to = bodyEl.offsetHeight;
      if (reducedMotion() || from === to) return;
      bodyEl.style.height = from + 'px';
      bodyEl.style.overflow = 'hidden';
      bodyEl.getBoundingClientRect();                    // 强制回流，让起始高度先生效
      bodyEl.style.transition = 'height .18s ease';
      bodyEl.style.height = to + 'px';
      setTimeout(() => { bodyEl.style.height = ''; bodyEl.style.overflow = ''; bodyEl.style.transition = ''; }, 220);
    }

    /* ---- 三个面板各自的渲染（都是纯字符串，由 render() 决定重绘哪一个） ---- */
    function renderFilePane() {
      return '<div class="hint-sm" style="margin-bottom:8px">选择一个或多个本地' + (isAudioTab ? '音频' : '图片') + '文件。文件名（忽略扩展名、首尾空格，大小写不敏感）与<b>全库任意分类</b>的资产名一致时，下一步会自动建议补图 / 覆盖。<b>下一步先给你看清单，确认后才真正导入。</b></div>' +
        '<button class="btn-mini" id="impPick"' + (busy ? ' disabled' : '') + '>选择文件…</button>' +
        '<input type="file" id="impFile" accept="' + (isAudioTab ? 'audio/*' : 'image/*') + '" multiple hidden />' +
        (pickedFiles.length
          ? '<div class="imp-files">' + pickedFiles.map((f, i) =>
              '<div class="imp-file"><span class="nm">' + esc(f.name) + '</span><span class="hint-sm">' + Math.max(1, Math.round(f.size / 1024)) + ' KB</span>' +
              '<button class="rm-mini" data-rmfile="' + i + '" title="移除">×</button></div>').join('') + '</div>'
          : '<div class="empty-mini" style="margin-top:8px">尚未选择文件</div>');
    }

    function renderTextPane() {
      if (isAudioTab) return '';
      return '<div class="hint-sm" style="margin-bottom:8px">粘贴多段文生图提示词，段与段之间用<b>单独一行的 @</b> 分隔。系统自动识别每段的资产类型（场景 / 道具 / 角色）与名称，并按类型归类导入。</div>' +
        '<textarea id="impText" class="asset-prompt tall" placeholder="角色描述信息如下：林晚…&#10;@&#10;按照下方场景描述内容生成…&#10;@&#10;根据道具描述内容生成…" spellcheck="false">' + esc(rawText) + '</textarea>' +
        '<div class="row-inline" style="margin-top:8px">' +
          '<button class="btn-mini" id="impParse"' + (busy ? ' disabled' : '') + '>解析预览</button>' +
          '<span class="hint-sm" id="impParseHint">' + (parsed
            ? '可导入 ' + parsed.items.length + ' 个资产' +
              ((parsed.duplicates || []).length ? '，重复跳过 ' + parsed.duplicates.length + ' 个' : '') +
              (parsed.skipped.length ? '，未识别 ' + parsed.skipped.length + ' 段' : '')
            : '粘贴后先解析，再确认导入') + '</span>' +
        '</div>' +
        (parsed ? renderParseResult(parsed) : '');
    }

    function renderFoot() {
      const head = '<span class="hint-sm" id="impFootHint"></span><span class="grow"></span>';
      if (mode === 'preview') {
        const n = plan ? plan.rows.reduce((s, r) => s + 1 + r.dupFiles.length, 0) : 0;
        return head + '<button class="btn-outline" id="impBack">返回修改</button>' +
          '<button class="btn-primary" id="impDoImport"' + (busy || !n ? ' disabled' : '') + '>确认导入 ' + n + ' 个文件</button>';
      }
      return head + '<button class="btn-outline" data-cancel>取消</button>' +
        (mode === 'file'
          ? '<button class="btn-primary" id="impDoFiles"' + (busy || !pickedFiles.length ? ' disabled' : '') + '>下一步：预览 ' + pickedFiles.length + ' 个文件</button>'
          : '<button class="btn-primary" id="impDoText"' + (busy || !parsed || !parsed.items.length ? ' disabled' : '') + '>' + (parsed && parsed.items.length ? '确认导入 ' + parsed.items.length + ' 个资产' : '确认导入') + '</button>');
    }

    function render() {
      paneFile.classList.toggle('on', mode === 'file');
      paneText.classList.toggle('on', mode === 'text');
      panePrev.classList.toggle('on', mode === 'preview');
      segEl.style.display = mode === 'preview' ? 'none' : '';
      const bFile = mask.querySelector('#impModeFile');
      const bText = mask.querySelector('#impModeText');
      if (bFile) bFile.classList.toggle('on', mode === 'file');
      if (bText) bText.classList.toggle('on', mode === 'text');
      /* ⚠ 只重绘**当前**面板：非当前面板的 DOM 留着不动，切回去时输入框的滚动/光标还在。
         这正是"面板常驻"的意义 —— 整体重建会把这些状态全丢掉（也就是"生硬"的来源）。 */
      if (mode === 'file') paneFile.innerHTML = renderFilePane();
      else if (mode === 'text') paneText.innerHTML = renderTextPane();
      else panePrev.innerHTML = renderPreviewPane();
      footEl.innerHTML = renderFoot();
    }

    /* 切模式：改状态 → 重绘 → 高度平滑 → 新面板淡入。
       预览是临时步骤，不写进"上次用的模式"（否则下次打开弹层直接落在预览页，却没有文件可导）。 */
    function setMode(next) {
      if (mode === next) return;
      if (next !== 'preview') S.imp.lastMode = next;
      withHeightTransition(() => { mode = next; render(); });
      const el = next === 'file' ? paneFile : (next === 'text' ? paneText : panePrev);
      if (!reducedMotion() && el) { el.classList.remove('imp-fade'); void el.offsetWidth; el.classList.add('imp-fade'); }
    }

    /* 导入预览：每个文件一行，去向 / 类型 / 关联都能在**落库前**改。
       为什么必须有这一步：匹配是**精确同名**，而实际文件名常常对不上（「白色信封」vs「信封」、
       「公寓卧室」vs 一长串场景描述）。改版前这些文件会**静默**按当前页签新增 —— 页签默认
       「角色」，于是场景/道具的图全堆进角色分类（用户 2026-09-21 实测反馈）。
       现在把结果摆出来：对不上的可以手动关联到已有素材，也可以改新素材的分类。 */
    function renderPreviewPane() {
      if (!plan) return '';
      const rows = plan.rows;
      /* 每行的"实际去向"：**手动关联优先于自动匹配** */
      const eff = (r) => (r.link ? (r.link.url ? 'overwrite' : 'fill')
        : (r.matched ? (r.matched.url ? 'conflict' : 'fill') : 'new'));
      let nFill = 0, nNew = 0, nConflict = 0;
      rows.forEach((r) => { const k = eff(r); if (k === 'fill') nFill++; else if (k === 'conflict') nConflict++; else nNew++; });
      const dupN = rows.reduce((s, r) => s + r.dupFiles.length, 0);
      const conflictRows = rows.filter((r) => eff(r) === 'conflict');
      /* 手动关联的候选：**同 kind** 的已有素材（图片素材只能关联图片，音频只能关联音频） */
      const cands = plan.lib.filter((a) => (isAudioTab ? a.type === 'audio' : a.type !== 'audio'));

      const rowsHTML = rows.map((r, i) => {
        const k = eff(r);
        const target = r.link || r.matched;
        let dest;
        if (k === 'fill') dest = '<span class="dest ok">补图到「' + esc(target.name) + '」</span>';
        else if (k === 'overwrite') dest = '<span class="dest warn">覆盖「' + esc(target.name) + '」的图</span>';
        else if (k === 'conflict') dest = '<span class="dest warn">与「' + esc(r.matched.name) + '」同名</span>';
        else dest = '<span class="dest">新增</span>';
        let ctl = '';
        if (k === 'new') {
          ctl += '<select data-imptype="' + i + '" title="新素材落在哪个分类">' +
            typeChoices.map((t) => '<option value="' + t + '"' + (r.type === t ? ' selected' : '') + '>' + typeLabel[t] + '</option>').join('') + '</select>';
        }
        if (!r.matched) {
          ctl += '<select data-implink="' + i + '" title="也可以关联到库里已有的素材（补图 / 覆盖）">' +
            '<option value="">不关联（新增）</option>' +
            cands.map((a) => '<option value="' + a.id + '"' + (r.link && r.link.id === a.id ? ' selected' : '') + '>' + esc(a.name) + (a.url ? '' : '（无图）') + '</option>').join('') +
            '</select>';
        }
        return '<div class="imp-row">' +
          '<span class="nm" title="' + esc(r.file.name) + '">' + esc(fileBaseName(r.file)) +
          (r.dupFiles.length ? '<span class="hint-sm">（另有 ' + r.dupFiles.length + ' 个同名并存）</span>' : '') + '</span>' +
          dest + ctl + '</div>';
      }).join('');

      const conflictBox = conflictRows.length
        ? '<div class="imp-choice">' +
            '<div class="hint-sm">上面 ' + conflictRows.length + ' 个文件与已有图片的资产同名，选择处理方式：</div>' +
            '<label class="checkline"><input type="radio" name="impAct" value="overwrite"' + (conflictAction === 'overwrite' ? ' checked' : '') + ' /> 覆盖原有图片（保留该资产与全部分镜绑定，只替换图片）</label>' +
            '<label class="checkline"><input type="radio" name="impAct" value="skip"' + (conflictAction === 'skip' ? ' checked' : '') + ' /> 跳过这些图片（不导入，原图不动）</label>' +
            '<label class="checkline"><input type="radio" name="impAct" value="merge"' + (conflictAction === 'merge' ? ' checked' : '') + ' /> 两者并存（保留原图，另存为新资产）</label>' +
          '</div>'
        : '';

      return '<div class="hint-sm">匹配规则：文件名（忽略扩展名与首尾空格，大小写不敏感）与资产名<b>完全一致</b>才算命中。对不上的可以在这里手动关联，或改新素材的分类。</div>' +
        '<div class="imp-sum">补图 <b>' + nFill + '</b> · 新增 <b>' + nNew + '</b>' +
          (nConflict ? ' · 同名冲突 <b>' + nConflict + '</b>' : '') +
          (dupN ? ' · 批次内同名 <b>' + dupN + '</b>' : '') + '</div>' +
        (nNew > 1 && typeChoices.length > 1
          ? '<div class="row-inline"><span class="hint-sm">把上面全部「新增」设为</span>' +
            '<select id="impBulkType">' + typeChoices.map((t) => '<option value="' + t + '">' + typeLabel[t] + '</option>').join('') + '</select>' +
            '<button class="btn-mini" id="impBulkApply">应用</button></div>'
          : '') +
        conflictBox +
        '<div class="imp-parse">' + rowsHTML + '</div>';
    }

    function renderParseResult(p) {
      const TYPE_CLS = { character: 'b-char', scene: 'b-scene', prop: 'b-prop' };
      const rows = p.items.map((it) =>
        '<div class="parse-item"><span class="type-badge ' + TYPE_CLS[it.type] + '">' + typeLabel[it.type] + '</span>' +
        '<span class="nm">' + esc(it.name) + '</span><span class="hint-sm">' + it.chars + ' 字</span></div>').join('');
      const skips = p.skipped.map((sk) =>
        '<div class="parse-item bad" title="' + esc(sk.preview || '') + '"><span class="type-badge b-skip">跳过</span>' +
        '<span class="nm">第 ' + sk.index + ' 段</span><span class="hint-sm">' + esc(sk.reason) + '</span></div>').join('');
      /* 重复段：库里已有同名同类资产，或本批里出现两次 —— 不会再建一份，单独列出来告知用户，
         否则他会以为"粘了 27 段怎么只导入 14 个"。 */
      const dups = (p.duplicates || []).map((d) =>
        '<div class="parse-item warn" title="' + (d.source === 'batch' ? '本批内前面已出现过同名段落' : '素材库里已有同名同类资产') + '">' +
        '<span class="type-badge b-conf">重复</span>' +
        '<span class="nm">' + esc(d.name) + '</span>' +
        '<span class="hint-sm">' + (d.source === 'batch' ? '本批内重复' : '已存在，跳过') + '</span></div>').join('');
      return '<div class="imp-parse"><div class="sec-head" style="margin:10px 0 6px"><b>识别结果（' +
        '角色 ' + p.items.filter((x) => x.type === 'character').length +
        ' · 场景 ' + p.items.filter((x) => x.type === 'scene').length +
        ' · 道具 ' + p.items.filter((x) => x.type === 'prop').length + '）</b></div>' + rows + dups + skips + '</div>';
    }

    /* 事件委托：骨架只建一次，所以监听器也**只挂一次**。
       以前是每次 render() 后重新 bind() —— 面板常驻之后那样会重复挂、越挂越多。
       委托的另一个好处：面板 innerHTML 怎么重绘，监听都还在。 */
    function wire() {
      mask.addEventListener('click', (ev) => {
        const t = ev.target;
        if (t === mask || t.closest('[data-x]') || t.closest('[data-cancel]')) { close(); return; }
        if (t.closest('#impModeFile')) { parsed = null; setMode('file'); return; }
        if (t.closest('#impModeText')) { setMode('text'); return; }
        if (t.closest('#impPick')) { const f = mask.querySelector('#impFile'); if (f) f.click(); return; }
        const rm = t.closest('[data-rmfile]');
        if (rm) { pickedFiles.splice(Number(rm.dataset.rmfile), 1); render(); return; }
        if (t.closest('#impBack')) { setMode('file'); return; }
        if (t.closest('#impBulkApply')) {
          const sel = mask.querySelector('#impBulkType');
          if (sel && plan) { plan.rows.forEach((r) => { if (!r.link && !r.matched) r.type = sel.value; }); render(); }
          return;
        }
        if (t.closest('#impParse')) { doParse(); return; }
        if (t.closest('#impDoFiles')) { doPlan(); return; }
        if (t.closest('#impDoImport')) { doImport(); return; }
        if (t.closest('#impDoText')) { doTextImport(); return; }
      });
      mask.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.id === 'impFile') {
          const fs = Array.from(t.files || []);
          for (const f of fs) if (!pickedFiles.some((x) => x.name === f.name && x.size === f.size)) pickedFiles.push(f);
          t.value = '';
          render();
          return;
        }
        if (t.name === 'impAct') { conflictAction = t.value; render(); return; }
        /* 预览里逐行改决策：类型（仅新增）/ 手动关联（仅未匹配） */
        if (t.dataset && t.dataset.imptype != null && plan) { plan.rows[Number(t.dataset.imptype)].type = t.value; render(); return; }
        if (t.dataset && t.dataset.implink != null && plan) {
          const row = plan.rows[Number(t.dataset.implink)];
          row.link = t.value ? (plan.lib.find((a) => a.id === t.value) || null) : null;
          render();
          return;
        }
      });
      mask.addEventListener('input', (ev) => { if (ev.target.id === 'impText') rawText = ev.target.value; });
    }

    /* ---- 动作：都从 wire() 的委托里调，只定义一次 ---- */
    async function doParse() {
      const textEl = mask.querySelector('#impText');
      if (textEl) rawText = String(textEl.value || '');
      if (!rawText.trim()) { toast('请先粘贴提示词文本', 'err'); return; }
      busy = true; render();
      try {
        parsed = await Api.importAssetPrompts(rawText, false);
        if (!parsed.items.length) {
          // 全是重复项时不能报"没识别出来" —— 那是两回事，提示语要对得上
          toast((parsed.duplicates || []).length
            ? '这些段落都已存在，没有新资产可导入'
            : '没有识别出任何资产段，请检查 @ 分隔与段首类型标识', 'err');
        }
      } catch (e) { parsed = null; fail(e); }
      busy = false;
      render();
    }

    async function doTextImport() {
      if (!parsed || !parsed.items.length || busy) return;
      busy = true; render();
      try {
        const r = await Api.importAssetPrompts(rawText, true);
        const c = { character: 0, scene: 0, prop: 0 };
        (r.created || []).forEach((x) => { c[x.type]++; });
        const dupN = (r.duplicates || []).length;
        toast('导入完成：角色 ' + c.character + ' · 场景 ' + c.scene + ' · 道具 ' + c.prop +
          (dupN ? '（重复已跳过 ' + dupN + ' 个）' : '') +
          (r.skipped.length ? '（未识别 ' + r.skipped.length + ' 段）' : ''), 'ok');
        close();
        await loadAssets();
        await loadList({ skeleton: false });
      } catch (e) { busy = false; render(); fail(e); }
    }

    /* 「下一步：预览」——算出计划并切到预览页。
       ⚠ 这里**不再直接导入**：计划先给人看、可改，确认后才落库。
       改版前的静默导入正是"图片全堆进角色页"的成因。 */
    async function doPlan() {
      if (!pickedFiles.length || busy) return;
      busy = true; render();
      try { plan = await planFiles(pickedFiles.slice()); }
      catch (e) { busy = false; render(); fail(e); return; }
      busy = false;
      setMode('preview');
    }

    /* 「确认导入」——按预览里的决策落库 */
    async function doImport() {
      if (!plan || busy) return;
      busy = true;
      const rows = plan.rows; const act = conflictAction;
      close();
      await executeImportPlan(rows, act);
    }

    function close() { document.removeEventListener('keydown', escImp); mask.remove(); }
    function escImp(ev) { if (ev.key === 'Escape') close(); }
    document.addEventListener('keydown', escImp);
    wire();
    render();
  }

  /* 删除单个素材（卡片右上角钮）；批量模式下同步清理勾选态 */
  /* 素材查找：资产可能在**两个列表**里 —— 分镜面板的 S.assets（当前分类）与
     项目资产库的 S.proj.assets。只查前者的话，从**项目资产库**点卡片 / 点删除会
     **静默无反应**：进入项目页时 resetScopeState 会把 S.assets 清空
     （2026-09-20 实测确认，卡片一直是"点不动的"）。两处都必须查。 */
  function findAssetAnywhere(assetId) {
    return S.assets.find((x) => x.id === assetId) ||
      (S.proj.assets || []).find((x) => x.id === assetId) || null;
  }

  /* 素材被改动 / 删除后的统一刷新：**两个资产视图是两套数据**，只刷一套另一套会显示过期内容。
     ⚠ loadList 只在确实处于某个分镜表里时才调 —— 项目页上没有分镜表，
       调用它会把列表接口打成 40000 并让 render() 去渲染一个不该出现的表格视图。 */
  async function afterAssetMutated() {
    await loadAssets();                       // 分镜面板（内部会 renderPanel）
    if (S.proj.tab === 'assets' && S.proj.projectId) {
      await loadProjAssets();
      renderProjAssets();
    }
    if (S.cur && S.cur.workspaceId) await loadList({ skeleton: false });
  }

  async function onAssetDelete(assetId) {
    const a = findAssetAnywhere(assetId);
    if (!a) return;
    if (!(await uiConfirm('删除素材', '确定删除素材「' + a.name + '」？将同时解除所有分镜的绑定。'))) return;
    try {
      await Api.deleteAsset(a.id);
      toast('素材已删除', 'ok');
      if (S.assetSel.has(a.id)) S.assetSel.delete(a.id);
      await afterAssetMutated();
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

  /* ---------------------------------------------------------- 分镜「添加资产」弹窗 */
  /* 从分镜表格的「＋」槽位进入：列出该槽位对应类型的**全部素材**（与右侧素材面板同源，
     都是 GET /assets?type=…），可搜索、可点选，确定后逐个绑定。
     交互约定：
       · 点一项 = 选中（高亮 + 打勾），再点一次 = 取消选中；
       · 角色是多值槽位 → 可多选；场景/道具/首帧图/分镜图/音频是单值槽位 → 只能选一个，
         选第二个会替换掉前一个（与后端 bindAsset 的 single/multi 规则一致）；
       · 已绑定在本分镜上的素材标「已添加」且不可再选 —— 重复添加在这里就被拦住并给出提示
         （后端对重复绑定是静默忽略，不会报错，所以必须由前端提示）；
       · 取消 / 关闭 / Esc / 点遮罩 → 不做任何变更。
     完成后由调用方刷新表格（loadList）与素材面板（loadAssets），让「已添加资产」立刻可见。 */
  /* 资产选择弹窗。opts.replace = true 时切到「替换」语义（由素材预览弹窗的「替换素材」按钮打开）：
       · 单选（一换一），确定后把本分镜原来绑的那个（opts.replaceFrom）解绑 —— 多值槽位
         （角色/道具）不会因此多出一个绑定；
       · 配额按「换掉一个」算，即已用满时仍可替换（换绑不增加图片数）；
       · 标题与提示改口为「替换」，避免用户以为是在新增。 */
  function openAssetPicker(sb, role, opts) {
    const meta = ROLE_META[role];
    const typeLabel = ASSET_TAB_LABEL[meta.type] || meta.type;
    const replacing = !!(opts && opts.replace);
    const replaceFrom = (opts && opts.replaceFrom) || null;
    return new Promise((resolve) => {
      const bound = new Set((sb.assets || []).filter((r) => r.role === role).map((r) => r.assetId));
      const sel = new Set();
      let list = [], keyword = '', busy = false, loaded = false;
      /* 本次已勾选的音频用量：条数 + 时长合计 + 有没有读不到时长的。
         为什么要在前端算：勾两个各 10 秒的音频时，界面必须知道"再加就超 15 秒了"，
         而不是等用户点了确定才由后端报错。后端仍会独立复核（前端只是提前拦）。 */
      function pickedSec() {
        let count = 0, sec = 0, unknown = 0;
        sel.forEach((id) => {
          const a = list.find((x) => x.id === id);
          if (!a) return;
          count++;
          if (Number.isFinite(a.durationSec)) sec += a.durationSec; else unknown++;
        });
        return { count: count, sec: Math.round(sec * 100) / 100, unknown: unknown };
      }
      /* 参考图配额：X = 该分镜当前**真会发出**的图片数（后端 imageCatalog 口径，只算有本地文件的），
         Y = 当前模型的上限（models.js 的系列规则表下发）。音频槽位不占图片名额，故不显示。
         打开时先用列表行的值（同一份服务端计算），随后拉一次详情校准。
         替换模式要先把「即将解绑的那一张」从占用里扣掉，否则满额时明明能换却换不了。 */
      const isImageRole = role !== 'audio';
      let quota = { count: sb.imageCount || 0, limit: sb.imageLimit != null ? sb.imageLimit : 9 };
      /* 音频走**另一套预算**：数量（audioLimit）+ 总时长（audioSecTotal / audioSecMax）。
         与图片名额互不影响 —— 图片不会因为多绑了音频而少一张，反之亦然。
         上限值全部来自服务端，前端不硬编码 15。 */
      let audioQ = {
        count: sb.audioCount || 0,
        limit: sb.audioLimit != null ? sb.audioLimit : 3,
        sec: Number(sb.audioSecTotal || 0),
        secMax: Number(sb.audioSecMax || 15)
      };
      const isFull = () => isImageRole && (quota.count - (replacing ? 1 : 0)) >= quota.limit;
      /* 音频的"已满"：数量满 或 时长满。时长的判定还要算上**本次已勾选的**时长
         （见 pickedSec()）—— 否则勾了两个各 10 秒的音频，界面会以为还能再加。 */
      const isAudioFull = () => {
        if (isImageRole) return false;
        const add = pickedSec();
        const cnt = audioQ.count - (replacing ? 1 : 0) + add.count;
        const sec = audioQ.sec + add.sec;
        return cnt >= audioQ.limit || sec >= audioQ.secMax - 1e-6;
      };
      const isReplace = () => replacing || !meta.multi;   // 单选语义（一换一）

      const mask = document.createElement('div');
      mask.className = 'mask'; mask.style.zIndex = 200;
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>' + (replacing ? '替换素材' : '添加资产') + ' · ' + meta.label + '</h2>' +
            '<span class="hint-sm">分镜 ' + sb.seq + '</span>' +
            '<span class="grow"></span>' +
            '<span class="ap-quota" id="apQuota"></span>' +   /* 图片与音频都显示配额，只是口径不同（见 renderQuota） */
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            '<label class="panel-search">' + I.search +
              '<input id="apSearch" placeholder="搜索' + typeLabel + '名称" /></label>' +
            '<div class="banner warn" id="apFull" hidden><span id="apFullTxt"></span></div>' +
            '<div class="sec-head"><b id="apCount">素材库</b><span class="grow"></span>' +
              '<span>' + (isReplace()
                ? '点击选中，再次点击取消（单选，确定后替换当前绑定的素材）'
                : '点击选中，再次点击取消（可多选）') + '</span></div>' +
            '<div class="ap-list" id="apList"></div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<span class="hint-sm" id="apHint">未选择</span>' +
            '<span class="grow"></span>' +
            '<button class="btn-outline" data-cancel>取消</button>' +
            '<button class="btn-primary" data-ok disabled>' + (replacing ? '替换' : '确定') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);

      const q = (s) => mask.querySelector(s);
      const visible = () => {
        const k = keyword.trim().toLowerCase();
        return k ? list.filter((a) => String(a.name || '').toLowerCase().includes(k)) : list;
      };

      /* 缩略图：有图用图；无图与音频都沿用面板那套「半透明图片占位」（与卡片视觉一致）。
         音频放音符占位而不是随机渐变 —— 渐变看着像"有封面"，实际没有任何含义。 */
      function thumbStyle(a) {
        const isAudio = a.type === 'audio';
        const hasPic = !!(a.url && !/^(mock|cli):/.test(a.url) && !isAudio);
        return hasPic
          ? 'background-image:url(' + a.url + ');background-size:cover;background-position:center;'
          : '';
      }
      const thumbCls = (a) => {
        const isAudio = a.type === 'audio';
        const hasPic = !!(a.url && !/^(mock|cli):/.test(a.url) && !isAudio);
        return 'ap-thumb' + (hasPic ? '' : ' no-pic');
      };
      const thumbGlyph = (a) => {
        const isAudio = a.type === 'audio';
        const hasPic = !!(a.url && !/^(mock|cli):/.test(a.url) && !isAudio);
        if (hasPic) return '';
        return '<span class="ph-ico">' + (isAudio ? I.notePh : I.img) + '</span>';
      };

      /* 配额状态：头部「已添加 X / 上限 Y」+ 满额时的说明条。满额后行不可选、确定不可点。
         音频走另一套口径（数量 + 总时长），提示语也换成对应的说法 ——
         "超时长了"和"条数满了"的处置方式完全不同，不能混成一句。 */
      function renderQuota() {
        const quotaEl = q('#apQuota');
        const bar = q('#apFull');
        if (!isImageRole) {
          const add = pickedSec();
          const cnt = audioQ.count - (replacing ? 1 : 0) + add.count;
          const sec = Math.round((audioQ.sec + add.sec) * 100) / 100;
          const overCount = cnt > audioQ.limit;
          const overSec = sec > audioQ.secMax + 1e-6;
          const full = overCount || overSec;
          if (quotaEl) {
            quotaEl.textContent = '音频 ' + cnt + ' / ' + audioQ.limit + ' 个 · ' + sec + ' / ' + audioQ.secMax + ' 秒';
            quotaEl.classList.toggle('full', full);
          }
          if (bar) {
            bar.hidden = !full;
            if (full) {
              q('#apFullTxt').textContent = overCount
                ? '音频数量超限：当前模型（' + (sb.model || '—') + '）最多 ' + audioQ.limit +
                  ' 个，当前会有 ' + cnt + ' 个。请少选几条，或改用支持更多音频的模型。'
                : '音频总时长超限：上限 ' + audioQ.secMax + ' 秒，当前会有 ' + sec +
                  ' 秒。请少选几条，或改用时长更短的音频。';
            }
          }
          return;
        }
        const full = isFull();
        if (quotaEl) {
          quotaEl.textContent = '已添加 ' + quota.count + ' / 上限 ' + quota.limit;
          quotaEl.classList.toggle('full', full);
        }
        if (bar) {
          bar.hidden = !full;
          if (full) {
            /* 替换模式下"已满额"的含义要换一套说法：这里扣掉的是即将被换掉的那一张，
               所以用户能做的动作是「换掉其中一张」而不是「先移除再加」。 */
            q('#apFullTxt').textContent = replacing
              ? '本分镜已用满 ' + quota.count + ' 张（上限 ' + quota.limit + '）。仍可替换其中一张 —— ' +
                '换绑不会增加图片数；要新增请先移除部分图片。'
              : '已达参考图上限：当前模型（' + (sb.model || '—') + '）最多 ' + quota.limit +
                ' 张，本分镜已用满 ' + quota.count + ' 张。请先移除部分图片释放名额' +
                (quota.limit < 30 ? '，或把该分镜改用 Seedance 2.5（上限 30 张）' : '') + '。';
          }
        }
      }

      function renderList() {
        const rows = visible();
        const host = q('#apList');
        q('#apCount').textContent = '素材库' + (loaded ? '（' + list.length + '）' : '');
        renderQuota();
        if (!loaded) { host.innerHTML = '<div class="empty-mini">加载中…</div>'; return; }
        if (!list.length) {
          host.innerHTML = '<div class="empty-mini">素材库里还没有' + typeLabel + '资产<br/>' +
            '<small>先在右侧素材面板「导入资产」，再回来添加</small></div>';
          return;
        }
        if (!rows.length) {
          host.innerHTML = '<div class="empty-mini">没有匹配「' + esc(keyword.trim()) + '」的资产</div>';
          return;
        }
        host.innerHTML = rows.map((a) => {
          const isBound = bound.has(a.id);
          const isSel = sel.has(a.id);
          /* 音频行把时长显示出来 —— 总时长有上限，不显示时长用户就没法判断该选哪几条。
             读不到时长要明确写「时长未知」：这种素材**绑不上**（后端守卫），
             在这里说清楚，比让用户选了再报错好。 */
          const dur = a.type === 'audio'
            ? '<span class="ap-dur' + (Number.isFinite(a.durationSec) ? '' : ' bad') + '">' +
                (Number.isFinite(a.durationSec) ? a.durationSec + 's' : '时长未知') + '</span>'
            : '';
          return '<div class="ap-row' + (isSel ? ' sel' : '') + (isBound ? ' bound' : '') + '" data-ap="' + a.id + '"' +
            ' title="' + esc(a.name) + (isBound ? '（已在此分镜中）' : '') + '">' +
            '<span class="' + thumbCls(a) + '" style="' + thumbStyle(a) + '">' + thumbGlyph(a) + '</span>' +
            '<span class="ap-name">' + esc(a.name) + '</span>' +
            dur +
            '<span class="ap-type">' + esc(ASSET_TAB_LABEL[a.type] || a.type) + '</span>' +
            (isBound ? '<span class="ap-bound">已添加</span>' : '') +
            '<span class="ap-tick">' + I.tick + '</span>' +
          '</div>';
        }).join('');
      }

      function renderFoot() {
        const n = sel.size;
        const names = Array.from(sel).map((id) => ((list.find((a) => a.id === id) || {}).name || id));
        q('#apHint').textContent = n ? (replacing ? '将替换为：' : '已选 ' + n + ' 个：') + names.join('、') : '未选择';
        const ok = q('[data-ok]');
        ok.disabled = busy || !n || (isImageRole ? isFull() : isAudioFull());
        ok.textContent = busy
          ? (replacing ? '替换中…' : '添加中…')
          : ((replacing ? '替换' : '确定') + (n ? '（' + n + '）' : ''));
        q('[data-cancel]').disabled = busy;
      }

      function toggle(a) {
        if (busy) return;
        if (isImageRole && isFull()) {
          toast('已达参考图上限：当前模型（' + (sb.model || '—') + '）最多 ' + quota.limit +
            ' 张，本分镜已用满 ' + quota.count + ' 张。请先移除部分图片，或改用上限更高的模型', 'err');
          return;
        }
        /* 音频：勾选前就把两重上限算清楚，并说明是**哪一种**满了 ——
           "删一条"和"换短的"是两个不同的动作，混成一句用户无从下手。 */
        if (!isImageRole && !sel.has(a.id)) {
          if (!Number.isFinite(a.durationSec)) {
            toast('音频「' + a.name + '」没有可用的时长信息，无法计入总时长上限。' +
              '请在素材详情里重新选择一次文件。', 'err');
            return;
          }
          const add = pickedSec();
          const cnt = audioQ.count - (replacing ? 1 : 0) + add.count + 1;
          const sec = Math.round((audioQ.sec + add.sec + a.durationSec) * 100) / 100;
          if (cnt > audioQ.limit) {
            toast('音频数量超限：当前模型（' + (sb.model || '—') + '）最多 ' + audioQ.limit +
              ' 个，再选会有 ' + cnt + ' 个', 'err');
            return;
          }
          if (sec > audioQ.secMax + 1e-6) {
            toast('音频总时长超限：上限 ' + audioQ.secMax + ' 秒，再选「' + a.name +
              '」会达到 ' + sec + ' 秒。请少选几条，或改用时长更短的音频', 'err');
            return;
          }
        }
        if (bound.has(a.id)) { toast('「' + a.name + '」已在此分镜中，无需重复添加', 'err'); return; }
        if (sel.has(a.id)) sel.delete(a.id);
        else {
          if (isReplace()) sel.clear();   // 单值槽位 / 替换模式：选了新的就换掉旧的（一换一）
          sel.add(a.id);
        }
        renderList(); renderFoot();
      }

      async function confirm() {
        if (busy || !sel.size) return;
        busy = true; renderFoot();
        const ids = Array.from(sel);
        const errs = [];
        for (const id of ids) {
          try { await Api.bindAsset(sb.id, id, role); }
          catch (e) { errs.push(((list.find((a) => a.id === id) || {}).name || id) + '：' + errText(e)); }
        }
        if (errs.length) {
          // 有失败就保持弹窗打开、把已成功的从选择集里摘掉，用户可直接重试
          busy = false;
          ids.forEach((id) => { if (!errs.some((x) => x.startsWith(((list.find((a) => a.id === id) || {}).name || id)))) sel.delete(id); });
          await refreshQuota();   // 成功的那些已占名额：把「已添加 X」同步到最新，避免重复占额
          renderList(); renderFoot();
          toast('添加失败 ' + errs.length + ' 个：' + errs.join('；'), 'err');
          return;
        }
        /* 替换模式：新绑定落库后再解绑原来那张（顺序不能反 —— 先解绑万一绑定失败就白丢了）。
           多值槽位（角色/道具）必须补这一步，否则"替换"会变成"多绑一个"；
           单值槽位在后端 bindAsset 里已被替换掉，这一步是空操作（filter 掉不存在的绑定不报错）。 */
        if (replacing && replaceFrom && !ids.includes(replaceFrom)) {
          try { await Api.unbindAsset(sb.id, replaceFrom); }
          catch (e) { toast('新素材已绑定，但旧绑定未能解除：' + errText(e), 'err'); }
        }
        toast(replacing
          ? '已替换分镜 ' + sb.seq + ' 的' + meta.label + '素材'
          : '已添加 ' + ids.length + ' 个' + meta.label + '到分镜 ' + sb.seq, 'ok');
        close(true);
      }

      function close(done) {
        document.removeEventListener('keydown', onKey);
        mask.remove();
        resolve(!!done);
      }
      const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(false); } };

      mask.querySelector('[data-x]').addEventListener('click', () => close(false));
      mask.querySelector('[data-cancel]').addEventListener('click', () => close(false));
      mask.querySelector('[data-ok]').addEventListener('click', confirm);
      mask.addEventListener('click', (ev) => { if (ev.target === mask) close(false); });
      document.addEventListener('keydown', onKey);
      mask.querySelector('#apSearch').addEventListener('input', (ev) => { keyword = ev.target.value; renderList(); });
      mask.addEventListener('click', (ev) => {
        const row = ev.target.closest('[data-ap]');
        if (!row) return;
        const a = list.find((x) => x.id === row.dataset.ap);
        if (a) toggle(a);
      });

      /* 拉一次详情校准配额（列表行的值可能已被轮询之外的操作改动过）——
         口径仍然后端算，前端不自己数。失败就沿用列表行的值，不阻断弹窗。 */
      async function refreshQuota() {
        try {
          const d = await Api.getStoryboard(sb.id);
          if (!d) return;
          if (isImageRole) {
            if (d.imageLimit != null) quota = { count: d.imageCount || 0, limit: d.imageLimit };
          } else if (d.audioLimit != null) {
            /* 音频：数量与总时长一起校准。秒数取服务端算的（它才是权威口径），
               勾选中的那部分由 pickedSec() 在前端叠加。 */
            audioQ = {
              count: d.audioCount || 0, limit: d.audioLimit,
              sec: Number(d.audioSecTotal || 0),
              secMax: Number(d.audioSecMax || audioQ.secMax)
            };
          }
        } catch (e) { /* 校准失败：保持现有配额值 */ }
      }

      renderList(); renderFoot();
      mask.querySelector('#apSearch').focus();

      /* 数据源 = 素材库（与右侧面板同一接口、同一份数据），只取该槽位对应的类型；
         同时拉一次分镜详情校准配额。两者并行，互不阻塞。 */
      Promise.all([
        Api.listAssets({ projectId: Api.CFG.projectId, type: meta.type })
          .then((res) => { list = (res && res.library) || []; })
          .catch((e) => { list = []; fail(e); }),
        refreshQuota()
      ]).then(() => { loaded = true; renderList(); renderFoot(); });
    });
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
    /* 音频参考：与图片同理，但**必须单独一行**。
       ⚠ 此前这里只渲染了参考图，音频一个字都没有 —— 后端其实已经把 --audio 发出去、
       也在提示词里注入了音频区块，用户却从卡片上看不到任何痕迹，据此判断
       "提交时没参考音频"（2026-09-20 用户报的就是这个）。纯音频的分镜尤其明显：
       卡片只显示"素材引用：无"。 */
    if (al.audios && al.audios.length) {
      rows.push('<dt>音频参考</dt><dd>' + al.audios.map((au) =>
        '<span class="lockrow"><i class="imgnum aud">音' + au.n + '</i>' + esc(au.name) +
        (Number.isFinite(au.durationSec) ? ' <span class="hint-sm">' + au.durationSec + 's</span>' : '') +
        ' <code>@音频' + au.n + '</code></span>').join('') +
        '　<span class="hint-sm">按此顺序作为 --audio 发出；提示词开头已自动追加「音频参考」区块，' +
        '把每条音频指定为对应角色的声音参考</span></dd>');
    }
    if (p.adapted && p.adapted.length) rows.push('<dt>参数适配</dt><dd>' + p.adapted.map(esc).join('<br/>') + '</dd>');
    if (p.missing && p.missing.length) rows.push('<dt>未匹配 flag</dt><dd style="color:#B25000">' + p.missing.map(esc).join('、') + '　<span class="hint-sm">模型规格里没有对应参数名，已跳过</span></dd>');
    /* 一条参考都没有时才说「无」—— 原来的文案是"无（参考图通过 --image 发出…）"，
       既自相矛盾，又会在只绑了音频时给出错误结论。 */
    if (!(al.images && al.images.length) && !(al.audios && al.audios.length)) {
      rows.push('<dt>素材引用</dt><dd><span class="hint-sm">无（未绑定参考图或音频，命令走 text2video，提示词不加区块）</span></dd>');
    }

    const argvHtml = (p.argv || []).length
      ? '<details class="cmd-details"><summary>argv 逐项（' + p.argv.length + ' 个）</summary><div class="codebox">' +
        esc(p.argv.map((a, i) => '[' + String(i).padStart(2, ' ') + '] ' + a).join('\n')) + '</div></details>'
      : '';

    const lockHtml = al.block
      ? '<details class="cmd-details" open><summary>提示词开头追加的区块（素材锁定 + 音频参考）　' +
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

  /* 长文本块右上角的悬浮复制钮。默认隐形、悬停才浮现（正文是整段密集文字，
     常驻按钮会压住开头几行），点击后原地变「已复制」再退回 —— 反馈落在按钮上，
     不必让用户去看角落的 toast。 */
  const copyBtnHTML = (what, title) =>
    '<button class="copy-btn" data-copy="' + what + '" title="' + title + '">' +
    I.copy + '<span>复制</span></button>';

  /* 复制成功后在按钮上原地显示「已复制」，1.4s 后复原 */
  function flashCopied(btn) {
    if (!btn || btn.classList.contains('done')) return;
    const label = btn.querySelector('span');
    const old = label ? label.textContent : '';
    btn.classList.add('done');
    if (label) label.textContent = '已复制';
    setTimeout(() => {
      btn.classList.remove('done');
      if (label) label.textContent = old;
    }, 1400);
  }

  function copyText(txt, okMsg, btn) {
    const done = () => { toast(okMsg); flashCopied(btn); };
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



  /* ------------------------------------------------ 自动匹配（按素材名称，图片与音色都匹配）
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
    const st = S.autoStats || { bound: 0, kept: 0, occupied: 0, noMatch: 0, overLimit: 0, storyboards: 0 };
    const rows = S.autoRows || [];
    const n = st.bound || 0;
    const ow = isAutoOverwrite();
    /* 把「图片 / 音色」拆开报：只给一个总数的话，用户看不出音色到底绑上没绑 ——
       而音色是这次新增的匹配目标，恰恰是最需要确认的部分。 */
    const bi = st.boundImages || 0, ba = st.boundAudios || 0;
    const split = '（图片 ' + bi + ' · 音色 ' + ba + '）';
    $('#autoTitle').textContent = '自动匹配 · 将绑定 ' + n + ' 个' + (n ? split : '');
    /* 超额未绑要出现在计数里 —— 否则用户会疑惑"明明命中了却没绑上"。
       图片名额口径与「添加资产」弹窗完全一致；音色另有**数量 + 总时长**两重上限。 */
    $('#autoHint').textContent = '扫描 ' + (st.storyboards || 0) + ' 条 · 命中 ' + n + ' · 已存在 ' +
      (st.kept || 0) + ' · 类型已占 ' + (st.occupied || 0) + ' · 无匹配 ' + (st.noMatch || 0) +
      (st.overLimit ? ' · 超上限未绑 ' + st.overLimit : '');
    $('#autoApply').disabled = !n || S.autoBusy;
    $('#autoApply').textContent = S.autoBusy ? '应用中…' : (n ? '应用（绑定 ' + n + ' 个）' : '无匹配，无需应用');

    const h = [];
    h.push('<div class="banner ' + (n ? 'warn' : 'err') + '"><span><b>匹配依据只有素材名称</b>（暂不做语义匹配）：' +
      '提示词里出现<b>素材全名</b> → 记 <code>名称</code>；出现剥掉「三视图 / 正面 / 设定图 / 角色」等描述词后的<b>主干</b> → 记 <code>主干</code>；' +
      '出现名称分词后的<b>词块</b> → 记 <code>词块</code>。默认<b>只增补、不覆盖</b>已有绑定；同一角色的多张素材（去描述词后同名）只取最优的一张。' +
      '依据词越长越可信，<code>词块</code>命中较松，请按下面的「依据」逐条确认。</span></div>');
    h.push('<div class="hint-sm"><b>图片与音色都会匹配</b>：音色素材按「角色名+音色」命名（如「林晚音色」），' +
      '匹配时会把「音色」当描述词剥掉，因此能关联到提示词里的「林晚」。' +
      '音色受<b>数量</b>与<b>总时长</b>两重上限约束，超出的会列在「超上限未绑」里并写明原因。</div>');
    h.push('<div class="hint-sm">作用范围：' + (S.autoScopeAll
      ? '未勾选分镜 → 全部「未提交」分镜（' + (st.storyboards || 0) + ' 条）'
      : '仅勾选的 ' + (S.autoIds || []).length + ' 条分镜') +
      '。这是预览，点底部「应用」才会写入分镜；绑定错了可在素材面板手动移除。</div>');

    rows.forEach((r) => {
      const tag = (m, cls) => '<span class="mk-tag ' + (cls || '') + '">' + esc(m.name) +
        '<i>' + esc(roleLabelOf(m.role)) + ' · ' + esc(viaLabelOf(m.via)) + '「' + esc(m.keyword) + '」</i></span>';
      const box = [];
      if (r.toBind.length) box.push('<div class="mk-line"><b>将绑定</b>' + r.toBind.map((m) => tag(m)).join('') + '</div>');
      /* 命中但没绑上：单独列出并说明**具体原因**。
         图片是"名额已满"；音色可能是数量超限、总时长超限、或时长未知 ——
         三种原因的处置方式完全不同，混成一句"超上限"会让人无从下手。 */
      if (r.overLimit && r.overLimit.length) {
        box.push('<div class="mk-line"><b>超上限未绑</b>' + r.overLimit.map((m) => {
          const why = m.message ? esc(m.message)
            : ('当前模型上限 ' + r.imageLimit + ' 张，本分镜已占 ' + r.imageCount + ' 张，名额已满');
          return '<span class="mk-tag occ">' + esc(m.name) + '<i>' + esc(roleLabelOf(m.role)) + ' · ' + why + '</i></span>';
        }).join('') + '</div>');
      }
      if (r.occupied.length) box.push('<div class="mk-line"><b>类型已占</b>' + r.occupied.map((o) =>
        '<span class="mk-tag occ">' + esc(o.want.name) + '<i>与已绑定的「' + esc(o.currentName) + '」同为' + esc(roleLabelOf(o.role)) +
        '，' + (ow ? '将替换' : '已跳过（勾选「覆盖同类型已有绑定」可替换）') + '</i></span>').join('') + '</div>');
      if (r.rivals.length) box.push('<div class="mk-line"><b>同类落选</b>' + r.rivals.map((m) => tag(m, 'rival')).join('') + '</div>');
      if (r.kept.length) box.push('<div class="mk-line"><b>已绑定</b>' + r.kept.map((m) => tag(m, 'done')).join('') + '</div>');
      if (!r.toBind.length && !r.occupied.length && !r.rivals.length && !(r.overLimit || []).length) {
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
      /* 报「图片 / 音色」两笔账：只报总数看不出音色绑上没绑，
         而音色是这次新增的匹配目标。超上限的也要报数，否则用户不知道有东西被跳过了。 */
      const bi = st.boundImages || 0, ba = st.boundAudios || 0;
      toast('已自动绑定 ' + (st.bound || 0) + ' 个参考（图片 ' + bi + ' · 音色 ' + ba + '）' +
        (st.occupied ? '，' + st.occupied + ' 个因类型已占而跳过' : '') +
        (st.overLimit ? '，' + st.overLimit + ' 个超上限未绑' : ''));
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

    // 全选 / 反选 / 区间：必须在「无选中就返回」之前处理 —— 没选中时正是要点全选的时候
    if (kind === 'all') {
      S.list.forEach((r) => S.sel.add(r.id));
      renderTable(); renderPanel(); renderStatusbar(); return;
    }
    if (kind === 'invert') {
      const next = new Set();
      S.list.forEach((r) => { if (!S.sel.has(r.id)) next.add(r.id); });
      S.sel = next;
      renderTable(); renderPanel(); renderStatusbar(); return;
    }
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
    /* 区间选择的「选中区间」按钮：素材面板与分镜列表共用一套标记，靠 data-rangego 区分目标 */
    const rg = e.target.closest('[data-rangego]');
    if (rg) {
      if (rg.dataset.rangego === 'as') {
        applyRange('as', S.assets.map((a) => a.id), S.assetRange, S.assetSel, renderPanel);
      } else {
        applyRange('sb', S.list.map((r) => r.id), S.selRange, S.sel, () => {
          renderTable(); renderPanel(); renderStatusbar();
        });
      }
      return;
    }
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
    /* 产物预览：切换到历史里的某一次产物。
       只换 <video> 的 src 与 poster，并把「在新窗口打开」同步过去 ——
       不重开弹窗（那会丢掉播放进度，也会闪一下）。 */
    const art = e.target.closest('[data-art]');
    if (art) {
      const v = $('#detailBody video');
      if (v) {
        v.pause();
        v.setAttribute('src', mediaUrl(art.dataset.art));
        if (art.dataset.cover) v.setAttribute('poster', mediaUrl(art.dataset.cover));
        else v.removeAttribute('poster');
        v.load();
      }
      $$('#detailBody .pv-hitem').forEach((b) => b.classList.toggle('on', b === art));
      const link = $('#detailBody .pv-openlink');
      if (link) link.setAttribute('href', mediaUrl(art.dataset.art));
      return;
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const d = S.detailFull || {};
      const al = d.assetLock || {};
      if (cp.dataset.copy === 'lockblock') copyText(al.block || '', '已复制素材锁定区块', cp);
      else if (cp.dataset.copy === 'promptwithlock') copyText(al.promptWithLock || '', '已复制注入后的完整提示词', cp);
      else if (cp.dataset.copy === 'detailprompt') copyText(d.prompt || '', '已复制提示词', cp);
      else if (cp.dataset.copy === 'detailcmd') copyText(d.cliCommand || '', '已复制 CLI 命令', cp);
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
      if (act === 'retype') { batchRetype(); return; }
      if (act === 'invert') {                    // 反选：已选变未选、未选变已选
        const next = new Set();
        S.assets.forEach((a) => { if (!S.assetSel.has(a.id)) next.add(a.id); });
        S.assetSel = next; renderPanel(); return;
      }
      if (act === 'del') { await deleteSelectedAssets(); return; }
      if (act === 'openImport') { if (!S.assetBusy) openAssetImport(S.panelTab); return; }
      return;
    }
    const locked = e.target.closest('[data-locked]');
    if (locked) toast('该分镜已完成生成，修改时长需重新生成', 'err');
  });

  // （旧「创建/批量导入素材」的文件选择回调已并入「导入资产」弹窗）

  /* 设计系统内的确认 / 输入弹层（替代原生 confirm/prompt） */
  /* 对话框正文只认两个最小标记：**加粗** 与换行。
     ⚠ 必须先 esc 再替换 —— 顺序反了就等于给正文开了注入口子（正文里可能含用户填的项目名）。
     以前这里只 esc，于是消息里写的 ** 会原样显示成星号、\n 会塌成一个空格。 */
  const richText = (s) => esc(String(s)).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  function uiDialog(opts) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'mask'; mask.style.zIndex = 200;
      mask.innerHTML =
        '<div class="modal narrow">' +
          '<div class="modal-head"><h2>' + esc(opts.title) + '</h2><span class="grow"></span>' +
            '<button class="icon-btn" data-x>' + I.xDark + '</button></div>' +
          '<div class="modal-body">' +
            (opts.message ? '<div style="font-size:13px;line-height:1.7;color:var(--ink80);white-space:pre-line">' + richText(opts.message) + '</div>' : '') +
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
    /* ⚠ 防串线（与轮询是同一类问题，指令 §38）：连续输入时会有多个预览请求同时在飞，
       先发的可能后到。不加序号的话**旧响应会盖掉新状态** ——
       实测现象：把文本框清空后，上一次请求的响应晚到，又把「已识别 0 段」改回「已识别 1 段」，
       绿色提示条重新冒出来（时好时坏，取决于两次请求的先后）。 */
    const seq = ++S.imp.seq;
    try {
      const res = await Api.importPreview(raw, S.imp.delimiter);
      if (seq !== S.imp.seq) return;          // 已有更新的请求发出 → 本次结果作废
      S.imp.preview = res;
    } catch (e) {
      if (seq !== S.imp.seq) return;
      fail(e); S.imp.preview = null;
    }
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
  async function openSettings(o) {
    const inline = !!(o && o.inline);
    if (inline) mountInlinePanel('settings');
    else $('#settingsMask').hidden = false;
    renderSettings();
    /* ⚠ 必须显式清掉 hidden：抽屉原来只靠 transform 藏到屏幕外，hidden 从来没被设过，
       所以 openSettings 一直没管它。自从补了 `.drawer[hidden]{display:none}`、
       且就地模式卸载时会把 hidden 置 true 之后，**不还原 hidden 就再也打不开抽屉**了
       （从项目页进过设置、再回控制台点设置，抽屉会是 display:none）。 */
    $('#settingsDrawer').hidden = false;
    $('#settingsDrawer').classList.add('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'false');
    try {
      /* 三个请求**各自独立失败**：任何一个挂掉都不该让整个抽屉停在半渲染状态。
         ⚠ 实测（2026-09-20）：空库（还没建项目）时 getSettings 会返回
         "当前没有任何项目，请先创建项目"，原来 Promise.all 被它一并 reject，
         于是 await 之后的第二次 renderSettings 永远不执行 —— 抽屉就停在
         第一次渲染的占位内容上，连 CLI 区块也跟着显示成"状态未知"。
         而"刚装完、还没建项目、正准备装创作 CLI"恰恰是最需要这个抽屉正常的场景。 */
      const [st, ad, ci] = await Promise.all([
        Api.getSettings().catch(() => null),
        Api.getAdapter().catch(() => null),
        Api.getCliStatus().catch(() => null)
      ]);
      if (ad) S.adapter = ad;
      if (ci) S.cliInfo = ci;
      /* 应用更新状态（只有桌面版有）。和上面几项一样单独失败即可 ——
         任何一项取不到都不该让整个设置抽屉打不开。
         合并时保留本地 UI 状态（showCfg / busy / error），只覆盖主进程给的字段。 */
      const J = window.JCDesktop;
      if (J && J.updateStatus) {
        const us = await J.updateStatus().catch(() => null);
        if (us) S.appUpdate = Object.assign({ showCfg: false }, S.appUpdate || {}, us);
      }
      /* 抽屉这时已经可交互了：如果用户在等待期间改过任何设置项，就别拿服务端的旧值盖回去，
         否则他的修改会当场回退（"先显示、后刷新"必须配这个守卫）。 */
      if (st && !S.settingsDirty) S.settings = st;
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
    /* 就地模式：卸载面板并回到「分镜表」页签 */
    if (inlinePanel === 'settings') {
      unmountInlinePanel();
      S.proj.tab = 'pages';
      renderProjHome();
      return;
    }
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

  /* ---------------- 创作 CLI 的安装向导 ----------------
     为什么要有这一段（2026-09-20）：官方只提供 `curl … | bash` 一种安装方式，
     而它的 Windows 分支要求 Git Bash —— 干净的 Windows 电脑跑不了。
     所以"让用户自己去装"这条路本来就不通，安装必须由应用代劳
     （从官方 CDN 下载，见 server/cli-installer.js）。

     界面要做成的核心一件事：**把"没装"和"装了没登录"分开说**。
     这两件事用户要做的动作完全不同（一个去装、一个去登录），
     而旧实现只有一句"未就绪"，还把 Windows 执行不了的 bash 命令当指引。 */

  function cliStateCardHTML(probing, ok, dInfo, dAcct, credit, creditAt, stale, info) {
    if (probing) {
      return '<div class="statecard">' + I.warn +
        '<span>状态读取中…（首次探测需要几秒，拿到结果后会自动更新，无需刷新）</span></div>';
    }
    const installed = info ? info.installed : null;

    /* 态 1：没装 —— 最需要被明确告知的状态 */
    if (installed === false) {
      return '<div class="statecard" style="background:var(--warn-bg);color:var(--warn)">' + I.warn +
        '<span><b>未安装</b>　·　没有它就无法生成视频' +
        '<span class="hint-sm" style="display:block">' +
        '创作 CLI 是即梦官方的命令行工具，本应用靠它调用生成能力。' +
        '点「安装创作 CLI」会从<b>即梦官方源</b>下载并装到 <code>' + esc(info.exePath) + '</code>' +
        '（与官方安装脚本用的位置一致，不经过第三方）。' +
        (info.latest && info.latest.ok && info.latest.version ? '　官方当前版本 ' + esc(info.latest.version) + '。' : '') +
        '</span></span></div>';
    }

    /* 态 2：装了但没登录 —— 只差一次授权，别说成"未就绪"让人摸不着头脑。
       ⚠ 必须要求 installed === true 才走这一支。installed 为 null 表示
       "安装状态还没拉到"（getCliStatus 失败或还没返回），这时**不能**说"已安装" ——
       在真的没装的机器上显示"已安装，但未登录"，正是本次要消灭的那类误导。 */
    if (installed === true && !ok) {
      return '<div class="statecard" style="background:var(--warn-bg);color:var(--warn)">' + I.warn +
        '<span><b>已安装，但未登录</b>' +
        '<span class="hint-sm" style="display:block">' +
        'CLI 已经就位，只差一次浏览器授权。点「创作 CLI 登录」，按提示在浏览器里完成即可。' +
        '</span></span></div>';
    }

    /* 态 2b：状态未知 / 不可用 —— 老实说"不知道"，并把可做的动作给出来。
       宁可说"没读到状态"，也不要编一个可能错的原因让用户去查错方向。 */
    if (!ok) {
      return '<div class="statecard" style="background:var(--warn-bg);color:var(--warn)">' + I.warn +
        '<span><b>当前不可用</b>' +
        (dInfo && dInfo.message ? '：' + esc(dInfo.message) : '') +
        '<span class="hint-sm" style="display:block">' +
        (installed === null
          ? '安装状态还没读到（可能是查询超时或网络不通）。点右上角「检测连接状态」重试；'
          : '') +
        '若 CLI 确实没装，点下面的「安装创作 CLI」由应用从官方源安装。' +
        '</span></span></div>';
    }

    /* 态 3：就绪 */
    const build = dInfo && dInfo.commit ? esc(String(dInfo.commit).slice(0, 7)) : null;
    return '<div class="statecard ok">' + I.check +
      '<span>已就绪' +
      (dAcct && dAcct.userId != null ? '　·　账号 <b>' + esc(String(dAcct.userId)) + '</b>' + (dAcct.vipLevel ? '（' + esc(dAcct.vipLevel) + '）' : '') : '') +
      (credit != null ? '　·　积分 <b>' + credit + '</b>' : '') +
      (creditAt ? '　<span class="hint-sm">读取于 ' + esc(creditAt) + (stale ? '（已过期，正在后台更新…）' : '') + '</span>' : '') +
      '<span class="hint-sm" style="display:block">' +
      (build ? '本机构建 <code>' + build + '</code>' : '') +
      (info && info.latest && info.latest.ok && info.latest.version ? '　·　官方当前版本 <b>' + esc(info.latest.version) + '</b>' : '') +
      (info && info.exePath ? '　·　<code>' + esc(info.exePath) + '</code>' : '') +
      '</span></span></div>';
  }

  /* 更新提示：只在"确实发现新版本"时出现，不打扰已经是最新的用户 */
  function cliUpdateNoticeHTML(info) {
    if (!info || !info.needsUpdate) return '';
    return '<div class="statecard" style="background:var(--primary-bg);color:var(--ink80)">' + I.warn +
      '<span>发现创作 CLI 新版本' +
      (info.latest && info.latest.version ? '（官方 ' + esc(info.latest.version) + '）' : '') +
      '<span class="hint-sm" style="display:block">' +
      (info.updateNote ? esc(info.updateNote) + '。' : '') +
      '点「更新创作 CLI」即可就地替换，旧版会自动备份保留。' +
      '</span></span></div>';
  }

  /* ---------------- 应用更新（仅桌面版） ----------------
     桌面版能在应用内完成更新：检查 → 下载 → 校验 → 静默安装 → 自动重启。
     网页版不渲染这个区块（网页版的"更新"是在项目目录 git pull 后重启服务，
     不是应用内安装 —— 别把两件事混在一起说）。
     真正的实现在 desktop/updater.js；这里只负责渲染与派发。 */
  function appUpdateHTML() {
    if (!(window.JCDesktop && window.JCDesktop.updateStatus)) return '';
    const u = S.appUpdate || {};
    const busy = u.busy || null;
    const dis = busy ? ' disabled' : '';
    const src = u.source || {};
    const provName = { github: 'GitHub Releases', url: '自定义 URL', local: '本地目录' }[src.provider] || src.provider || '—';
    const p = u.progress;

    let state = '';
    if (u.installing) {
      state = '<div class="statecard" style="background:var(--primary-bg);color:var(--ink80)">' + I.warn +
        '<span>正在安装更新，应用即将自动重启…<span class="hint-sm" style="display:block">安装器已经拉起，本窗口马上会关闭。重启后就是新版本。</span></span></div>';
    } else if (p && p.active) {
      const pct = p.total ? Math.floor(p.got / p.total * 100) : 0;
      state = '<div class="statecard" style="background:var(--primary-bg);color:var(--ink80)">' + I.warn +
        '<span>正在下载 ' + esc(String(p.version || '')) + '　<b>' + pct + '%</b>（' + (p.got / 1048576).toFixed(1) + ' MB' +
        (p.total ? ' / ' + (p.total / 1048576).toFixed(1) + ' MB' : '') + '）' +
        '<span class="hint-sm" style="display:block">下载完会自动校验 sha512、静默安装并重启。请勿关闭窗口。</span></span></div>';
    } else if (u.error) {
      state = '<div class="statecard" style="background:var(--warn-bg);color:var(--warn)">' + I.warn +
        '<span>' + esc(u.error) +
        (u.needsToken ? '<span class="hint-sm" style="display:block">读取 release 失败（可能需要令牌）。本仓库已公开、正常无需令牌；若你用的是私有库或自建源，请在下面的「更新源设置」里填只读访问令牌，或改用本地目录 / 自定义 URL。</span>' : '') +
        '</span></div>';
    } else if (u.lastCheck && u.lastCheck.ok) {
      state = u.lastCheck.hasUpdate
        ? '<div class="statecard" style="background:var(--primary-bg);color:var(--ink80)">' + I.warn +
          '<span>发现新版本 <b>' + esc(String(u.lastCheck.latestVersion)) + '</b>' +
          '<span class="hint-sm" style="display:block">当前 ' + esc(String(u.lastCheck.currentVersion)) + ' → 新版本 ' +
          esc(String(u.lastCheck.latestVersion)) + '。点「下载并安装」会自动完成：下载 → 校验 → 静默安装 → 重启应用。' +
          '你的数据都在安装目录之外，不受影响。</span></span></div>'
        : '<div class="statecard ok">' + I.check + '<span>已是最新版（' + esc(String(u.lastCheck.currentVersion)) + '）</span></div>';
    }

    const canInstall = !!(u.lastCheck && u.lastCheck.ok && u.lastCheck.hasUpdate) && !busy && !u.installing;
    const btns = canInstall
      ? '<button class="btn-mini btn-mini-cta" data-updact="install">下载并安装 ' + esc(String(u.lastCheck.latestVersion)) + '</button>'
      : '<button class="btn-mini" data-updact="check"' + dis + '>' + (busy === 'check' ? '检查中…' : '检查更新') + '</button>';

    return '<section class="scard">' +
      '<div class="scard-hd"><div class="scard-hd-t"><h3>应用更新</h3>' +
      '<p>桌面版可在应用内完成更新：下载 → 校验 → 静默安装 → 自动重启</p></div></div>' +
      '<div class="scard-bd">' +
        '<div class="statecard">' + I.check +
          '<span>当前版本 <b>' + esc(String(u.version || '?')) + '</b>　·　更新源 ' + esc(provName) +
          (src.provider === 'github'
            ? '（<code>' + esc(String(src.owner || '') + '/' + String(src.repo || '')) + '</code>' + (src.hasToken ? '，已配置令牌' : '，<b>未配置令牌</b>') + '）'
            : '') +
          '</span></div>' +
        state +
        '<div class="cli-actions">' + btns +
          '<button class="btn-mini" data-updact="togglecfg">' + (u.showCfg ? '收起更新源设置' : '更新源设置…') + '</button>' +
        '</div>' +
        (u.showCfg ? appUpdateCfgHTML(src) : '') +
      '</div></section>';
  }

  /* 更新源设置。⚠ 令牌输入框**永远不回填已存的值**：主进程只回传 hasToken，
     所以这里只提示"已配置/未配置"，用户想换就重新粘一个 —— 不把密钥在页面上再写一遍。 */
  function appUpdateCfgHTML(src) {
    const s = src || {};
    const opt = (v, label) => '<option value="' + v + '"' + (s.provider === v ? ' selected' : '') + '>' + label + '</option>';
    let fields = '';
    if (s.provider === 'url') {
      fields = '<div class="srow"><label>更新源地址</label>' +
        '<input id="updUrl" type="text" placeholder="https://example.com/updates" value="' + esc(String(s.url || '')) + '">' +
        '<p class="hint-sm">该地址下要有 <code>latest.yml</code> 和安装包（就是 <code>npm run dist</code> 在 <code>release/</code> 里产出的那两个文件）。必须是 https。</p></div>';
    } else if (s.provider === 'local') {
      fields = '<div class="srow"><label>本地目录</label>' +
        '<input id="updDir" type="text" placeholder="D:\\jimeng-release" value="' + esc(String(s.dir || '')) + '">' +
        '<p class="hint-sm">指向一个含 <code>latest.yml</code> 和安装包的目录 —— 适合离线/内网，或者"我刚打完包，让装好的应用直接升级"。</p></div>';
    } else {
      fields = '<div class="srow"><label>仓库</label>' +
        '<input id="updOwner" type="text" placeholder="owner" value="' + esc(String(s.owner || '')) + '" style="max-width:150px">' +
        '<input id="updRepo" type="text" placeholder="repo" value="' + esc(String(s.repo || '')) + '" style="max-width:190px"></div>' +
        '<div class="srow"><label>访问令牌</label>' +
        '<input id="updToken" type="password" placeholder="' + (s.hasToken ? '已配置（留空则不修改）' : '私有库必填；公有库可留空') + '">' +
        '<p class="hint-sm">本仓库已公开、匿名即可读取 release，一般无需令牌；仅私有库或自建源才需要。建议用<b>细粒度 PAT</b>：只勾这一个仓库的 <code>Contents: Read</code>。令牌只存在本机配置文件里，不会进安装包。</p></div>';
    }
    return '<div class="sblock" style="margin-top:10px">' +
      '<div class="sblock-hd"><b>更新源设置</b></div>' +
      '<div class="srow"><label>更新源</label><select id="updProvider">' +
        opt('github', 'GitHub Releases') + opt('url', '自定义 URL') + opt('local', '本地目录') +
      '</select></div>' +
      fields +
      '<div class="cli-actions"><button class="btn-mini" data-updact="savecfg">保存更新源</button>' +
      '<button class="btn-mini" data-updact="recheck">保存并检查更新</button></div>' +
      '</div>';
  }

  /* 按钮：按"当前该做什么"决定给哪几个 —— 没装就只给安装，别拿登录按钮干扰 */
  function cliActionsHTML(info, ok) {
    const busy = S.cliBusy;
    const dis = busy ? ' disabled' : '';
    const out = [];
    const installed = info ? info.installed : null;

    /* 没装、或"装没装还没读到"（null）→ 都给安装入口。
       对 null 宁可多给一个按钮：装过的人点它只是重装一遍（下载-校验-备份-替换，幂等），
       而真没装的人少了这个按钮就完全无从下手。 */
    if (installed !== true) {
      out.push('<button class="btn-mini btn-mini-cta" data-cliact="install"' + dis +
        ' title="从即梦官方源下载创作 CLI 并安装（约 30 MB），装到官方安装脚本使用的默认位置">' +
        (busy === 'install' ? '下载安装中…（约 30 MB，请勿关闭）' : '安装创作 CLI') + '</button>');
    } else if (info && info.needsUpdate) {
      out.push('<button class="btn-mini btn-mini-cta" data-cliact="install"' + dis +
        ' title="就地更新到官方最新版；旧版会备份成 .bak-<时间> 留在原处">' +
        (busy === 'install' ? '更新中…（约 30 MB，请勿关闭）' : '更新创作 CLI') + '</button>');
    }

    /* 登录 / 切换账号只在 CLI 确实存在时才有意义 */
    if (installed !== false) {
      out.push('<button class="btn-mini" data-cliact="dlogin"' + dis +
        ' title="创作 CLI 登录：若本地登录态仍有效，CLI 会直接复用、不重新授权">' +
        (busy === 'dlogin' ? '等待授权中…' : '创作 CLI 登录') + '</button>');
      out.push('<button class="btn-mini" data-cliact="dswitch"' + dis +
        ' title="切换创作 CLI 账号：会先退出当前账号再重新授权（有二次确认）">' +
        (busy === 'dswitch' ? '切换中（先退出再授权）…' : '创作 CLI 切换账号') + '</button>');
    }
    return out.join('');
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
      install: '正在从即梦官方源下载并安装创作 CLI（约 30 MB）…',
      dlogin: '已启动创作 CLI 登录流程：请在打开的浏览器中完成授权（最长等待约 10 分钟，完成后自动确认）…',
      dswitch: '正在退出创作 CLI 当前账号并重新授权（请在打开的浏览器中完成新账号登录，最长约 10 分钟）…'
    };
    S.cliBusy = kind; S.cliMsg = labels[kind]; S.cliRaw = null; S.cliHint = null;
    S.dCliUrl = null; S.dCliCode = null;
    renderSettings();
    /* 登录/切换：POST 等待授权期间，每 3s 轮询适配器状态，实时显示等待时长与授权链接。
       ⚠ 这里原来写的是 `kind !== 'check'`。加入 install 之后，那个条件会把**安装**
       也卷进来 —— 安装期间界面会错报"等待浏览器授权中"，把用户引向完全错误的方向。
       所以必须**显式列出**两种登录动作，而不是"非检测即登录"。 */
    var liveTimer = null, waited = 0, shownUrl = null;
    if (kind === 'dlogin' || kind === 'dswitch') {
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
    /* 安装进度：install 是一次长请求（30 MB，慢网下要几分钟），请求返回之前拿不到
       任何中间态。所以另开一个 1 秒轮询去问 GET /system/cli 的 progress 字段，
       **只改按钮文案**、不整块重绘 —— 整块重绘会打断用户正在看的滚动位置。 */
    var progTimer = null;
    if (kind === 'install') {
      progTimer = setInterval(async () => {
        try {
          const ci = await Api.getCliStatus();
          S.cliInfo = ci;
          const el = document.querySelector('[data-cliact="install"]');
          if (!el) return;
          const p = ci.progress;
          if (!p || !p.active) return;
          if (p.phase === 'download') {
            const pct = p.total ? Math.floor(p.got / p.total * 100) : 0;
            el.textContent = '下载中 ' + pct + '%（' + (p.got / 1048576).toFixed(1) + ' MB / 约 30 MB）…';
          } else {
            const nm = { verify: '校验文件', replace: '替换文件', sync: '同步官方状态' }[p.phase] || '收尾';
            el.textContent = '正在' + nm + '…';
          }
        } catch (e) { /* 进度查询失败不影响安装本身 */ }
      }, 1000);
    }
    try {
      /* install 是长请求（要下 ~30 MB，慢网下可能几十秒）—— S.cliBusy 在等待期间
         一直是 'install'，按钮显示"下载安装中…"并禁用，用户不会以为没反应而连点。 */
      const res = kind === 'check' ? await Api.adapterCheck()
        : kind === 'install' ? await Api.installCli()
        : kind === 'dlogin' ? await Api.dreaminaLogin()
        : await Api.dreaminaSwitch();
      S.adapter = Object.assign({}, S.adapter, res);
      const okFlag = kind === 'check' ? res.cliAvailable !== false : res.ok !== false;
      S.cliMsg = res.message || (okFlag ? '操作完成' : '操作未完成');
      /* 装完之后"官方最新版/要不要更新"这些也跟着变了，重拉一次安装状态，
         否则界面还停在"未安装"或"有新版"的旧结论上。 */
      if (kind === 'install') {
        try { S.cliInfo = await Api.getCliStatus(); } catch (e) { /* 拉不到就保留旧值 */ }
      }
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
    if (progTimer) clearInterval(progTimer);
    S.cliBusy = null;
    renderSettings();
  }
  /* ---------------- 应用更新的动作派发 ----------------
     桌面版走 IPC（window.JCDesktop）；网页版没有这个能力，函数会直接返回。 */
  async function runUpdateAction(kind) {
    const J = window.JCDesktop;
    if (!J || !J.updateCheck) return;
    const u = () => (S.appUpdate = S.appUpdate || {});

    if (kind === 'togglecfg') { u().showCfg = !u().showCfg; renderSettings(); return; }

    /* 保存更新源。⚠ 令牌留空 = **不修改**（不是清空）—— 界面不回填已存的密钥，
       用户不重新粘贴就应当保持原样。要清空得显式删掉配置文件里那一项。 */
    if (kind === 'savecfg' || kind === 'recheck') {
      const prov = ($('#updProvider') && $('#updProvider').value) || 'github';
      const patch = { provider: prov };
      if (prov === 'github') {
        if ($('#updOwner')) patch.owner = $('#updOwner').value.trim();
        if ($('#updRepo')) patch.repo = $('#updRepo').value.trim();
        const tk = $('#updToken') && $('#updToken').value.trim();
        if (tk) patch.token = tk;
      } else if (prov === 'url') {
        if ($('#updUrl')) patch.url = $('#updUrl').value.trim();
      } else {
        if ($('#updDir')) patch.dir = $('#updDir').value.trim();
      }
      try {
        const src = await J.updateSetSource(patch);
        if (src) u().source = src;
        u().error = null;
        toast('更新源已保存', 'ok');
      } catch (e) { u().error = errText(e); }
      renderSettings();
      if (kind === 'recheck') return runUpdateAction('check');
      return;
    }

    if (kind === 'check') {
      u().busy = 'check'; u().error = null; u().lastCheck = null; renderSettings();
      try {
        const r = await J.updateCheck();
        u().lastCheck = r;
        u().needsToken = !!(r && r.needsToken);
        if (r && !r.ok) u().error = r.error;
      } catch (e) { u().error = errText(e); }
      u().busy = null;
      renderSettings();
      return;
    }

    if (kind === 'install') {
      u().busy = 'download'; u().error = null; renderSettings();
      /* 下载是长请求（100+ MB），另开轮询显示百分比。只改按钮文案，不整块重绘 ——
         整块重绘会把用户正在看的内容刷掉。 */
      const timer = setInterval(async () => {
        try {
          const st = await J.updateStatus();
          S.appUpdate.progress = st.progress;
          const el = document.querySelector('[data-updact="install"]');
          if (el && st.progress && st.progress.active) {
            const pct = st.progress.total ? Math.floor(st.progress.got / st.progress.total * 100) : 0;
            el.textContent = '下载中 ' + pct + '%（' + (st.progress.got / 1048576).toFixed(1) + ' MB）…';
          }
        } catch (e) { /* 进度查询失败不影响下载本身 */ }
      }, 800);
      try {
        const d = await J.updateDownload();
        clearInterval(timer);
        if (!d.ok) {
          u().error = d.error; u().busy = null; u().needsToken = !!d.needsToken; renderSettings(); return;
        }
        /* 下载并校验通过 → 拉起安装器。应用会在约 800ms 后自行退出，
           安装器接手替换文件并重启，所以这里之后不需要再更新界面。 */
        u().installing = true; u().busy = null; renderSettings();
        await J.updateInstall();
      } catch (e) {
        clearInterval(timer);
        u().error = errText(e); u().busy = null; renderSettings();
      }
      return;
    }
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
      /* —— 卡片 4 · 个性化（显示偏好；2026-09-20 新增，原顶栏「紧凑视图」按钮并入此处） —— */
      '<section class="scard">' +
        '<div class="scard-hd"><div class="scard-hd-t">' +
          '<h3>个性化</h3><p>界面显示偏好，只影响本页外观，不改动任何生成参数</p></div></div>' +
        '<div class="scard-bd">' +
          '<div class="srow"><span class="k">紧凑视图</span>' +
            '<span class="switch' + (isCompact() ? ' on' : '') + '" data-toggle="compact" title="行高与缩略图缩小，同屏看到更多分镜"><i></i></span></div>' +
          '<p class="hint-sm">开启后行高 132px、素材格 32×40、产物格 56×36，一屏能多看几条分镜；关闭即标准视图。' +
            '与原来顶栏那个「紧凑视图」按钮是同一套逻辑（切换 <code>#app</code> 上的 <code>.compact</code> 类），' +
            '只是入口挪到了这里。此项为即时生效的显示偏好，不写入服务端配置，刷新后回到标准视图。</p>' +
          /* v0.21.0：外观（深色模式）。三态用 .seg 分段控件；选中态读 <html data-theme-mode>
             （用户的选择），而不是解析后的 <html data-theme> —— 否则"跟随系统"回显不出选中。 */
          '<div class="srow"><span class="k">外观</span>' +
            '<span class="seg" id="themeSeg">' +
              '<button data-toggle="theme" data-theme-val="auto"' + (themeChoice() === 'auto' ? ' class="on"' : '') + '>跟随系统</button>' +
              '<button data-toggle="theme" data-theme-val="light"' + (themeChoice() === 'light' ? ' class="on"' : '') + '>浅色</button>' +
              '<button data-toggle="theme" data-theme-val="dark"' + (themeChoice() === 'dark' ? ' class="on"' : '') + '>深色</button>' +
            '</span></div>' +
          '<p class="hint-sm">「跟随系统」随操作系统的浅色/深色偏好自动切换；「浅色 / 深色」是你的显式选择，优先于系统。' +
            '此项为即时生效的显示偏好，保存在本机（<code>localStorage</code> 的 <code>jmc.theme</code>），不写入服务端配置。</p>' +
        '</div>' +
      '</section>' +
      /* —— 卡片 5 · 生成引擎与账号（全局的「检测」升到卡片头，两个 CLI 各自成组） —— */
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
          /* —— 创作 CLI：唯一的生成引擎（画布 CLI 已移除）——
             三态（没装 / 装了没登录 / 就绪）+ 安装·更新入口。
             渲染见上面的 cliStateCardHTML / cliUpdateNoticeHTML / cliActionsHTML。
             ⚠ 这里不再出现 `curl … | bash` —— 那是官方脚本的安装命令，Windows 原生
             跑不了（它要求 Git Bash），把它当指引等于把没装 CLI 的用户卡死。 */
          '<div class="sblock">' +
            '<div class="sblock-hd"><b>创作 CLI（dreamina）</b></div>' +
            cliStateCardHTML(dreaminaProbing, dreaminaOk, dInfo, dAcct, dreaminaCredit, creditAt, dreaminaStale, S.cliInfo) +
            cliUpdateNoticeHTML(S.cliInfo) +
            '<p class="hint-sm">命令：<code>dreamina</code>　·　负责视频生成的全部链路（<code>--image</code> / <code>--audio</code> 混合参考）。' +
              '下方按钮作用于创作 CLI 自己的 OAuth 登录态；' +
              '<b>「切换账号」会先退出现有账号</b>（CLI 的 <code>relogin</code> 语义），因此会先弹一次确认</p>' +
            '<div class="cli-actions">' + cliActionsHTML(S.cliInfo, dreaminaOk) + '</div>' +
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
        /* —— 应用更新：只有桌面版渲染（网页版没有应用内更新）—— */
        appUpdateHTML() +
      '</section>';
  }

  /* ---------------------------------------------------------- 详情 / 预览 */
  /* 这个分镜历次生成的**产物**（按记录取，新的在前）。
     数据源是生成记录而不是分镜：分镜上的 videoUrl 是"当前态"，重新生成会覆盖；
     而每条成功记录都带自己那一次的 videoUrl / coverUrl 快照 + 生成时刻 + submit_id，
     所以"生成过几次、每次是哪一条"在记录里是完整且不可变的。
     ⚠ 只取真有产物文件的（跳过 cli: 这种只有远端 id、没下下来的）。 */
  async function artifactHistory(sbId) {
    try {
      const res = await Api.listRecords({ storyboardId: sbId, action: 'generate', pageSize: 50 });
      return (res.list || []).filter((r) => r.videoUrl && !/^cli:/.test(r.videoUrl));
    } catch (e) { return []; }
  }

  /* 历史产物列表。第 N 次按**时间正序**编号（记录是新的在前，所以倒着数），
     并显示生成时刻与 submit_id 前 8 位 —— 这两个是分辨"哪一次是哪一次"的硬依据。 */
  function histHTML(hist, curId) {
    const items = hist.map((r, i) => {
      const nth = hist.length - i;
      const cov = r.coverUrl ? mediaUrl(r.coverUrl) : null;
      /* ⚠ 判断"当前是哪一条"要按**记录 id**，不能按 videoUrl 相等 ——
         两次生成有可能落到同一个文件（例如第二次的产物选取退回"取最新"时命中了同一个），
         那时按 URL 比较会让两条同时高亮。 */
      return '<button class="pv-hitem' + (r.id === curId ? ' on' : '') + '"' +
        ' data-art="' + esc(r.videoUrl) + '"' +
        (r.coverUrl ? ' data-cover="' + esc(r.coverUrl) + '"' : '') +
        ' title="切换到这一次的产物">' +
        '<span class="pv-hthumb"' + (cov ? ' style="background-image:url(' + esc(cov) + ')"' : '') + '>' +
          (cov ? '' : I.play) + '</span>' +
        '<span class="pv-htxt">' +
          '<b>第 ' + nth + ' 次</b>' +
          '<span>' + esc(fmtWhen(r.at)) + '</span>' +
          '<span class="pv-hid">' + esc(String(r.submitId || '—').slice(0, 8)) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
    return '<div class="sec-title">历史产物（共 ' + hist.length + ' 次）' +
        '<span class="hint-sm">　点一次切换播放</span></div>' +
      '<div class="pv-hist">' + items + '</div>';
  }

  async function openDetail(s, previewOnly) {
    let full = s;
    try { full = await Api.getStoryboard(s.id); } catch (e) { /* 降级用列表数据 */ }
    const yes = '<span style="color:#248A3D">可修改</span>';
    const no = '<span style="color:#7A7A7A">已完成，已锁定时长</span>';
    $('#detailTitle').textContent = previewOnly ? ('产物预览 · 分镜 ' + full.seq) : ('分镜 ' + full.seq + ' · 详情');

    /* 产物预览（2026-09-19）：
       ① 真播放器 —— 原先只是一块渐变底 + 播放图标 + 把 videoUrl 当文字打出来，根本播不了。
          后端已支持 HTTP Range，所以进度条能拖。
       ② **历史产物列表** —— 同一个分镜生成多次时，分镜上只留最新一次，看不出有几次、
          更分不清哪次是哪次。这里把历次产物都列出来（带第几次 / 时间 / submit_id 前 8 位），
          点一下切换播放。默认选中与分镜当前 videoUrl 一致的那一条（即最新一次）。 */
    const hist = previewOnly ? await artifactHistory(full.id) : [];
    const cur = hist.find((r) => r.videoUrl === full.videoUrl) || hist[0] || null;
    const curUrl = (cur && cur.videoUrl) || (previewOnly ? full.videoUrl : null);
    const curCover = (cur && cur.coverUrl) || full.coverUrl || null;
    $('#detailBody').innerHTML =
      (previewOnly && curUrl
        ? '<video class="pv-video" controls preload="metadata" playsinline' +
            (curCover ? ' poster="' + esc(mediaUrl(curCover)) + '"' : '') +
            ' src="' + esc(mediaUrl(curUrl)) + '"></video>' +
          '<div class="pv-meta">' + esc(full.ratio) + ' · ' + full.durationSec + 's · ' + esc(full.resolution) +
            ' · <a class="pv-openlink" href="' + esc(mediaUrl(curUrl)) + '" target="_blank" rel="noopener">在新窗口打开 ↗</a></div>' +
          (hist.length > 1 ? histHTML(hist, cur ? cur.id : null) : '')
        : (previewOnly ? '<div class="pv-meta">这条分镜还没有产物（未生成或已失败）</div>' : '')) +
      '<div class="sec-title">提示词</div>' +
      '<div class="copywrap">' + copyBtnHTML('detailprompt', '复制提示词') +
        '<div style="font-size:12.5px;line-height:1.7;color:var(--ink80)">' + esc(full.prompt) + '</div>' +
      '</div>' +
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
          '<div class="copywrap on-dark">' + copyBtnHTML('detailcmd', '复制 CLI 命令') +
            '<div class="codebox">$ ' + esc(full.cliCommand) + '</div>' +
          '</div>'
        : '') +
      (full.logs && full.logs.length ? '<div class="sec-title">执行日志</div>' + full.logs.map((l) => '<div class="logline ' + esc(l.level || '') + '">' + esc(l.msg) + '</div>').join('') : '');
    S.detailFull = full;    // 供「复制区块 / 复制完整提示词」按钮取文本
    $('#detailMask').hidden = false;
  }

  /* 关闭详情 / 产物预览弹窗。
     ⚠ 必须先停掉 <video>（2026-09-19 用户上报的 bug）：
     只把遮罩 `hidden` 掉，视频元素仍留在 DOM 里**继续播放** —— 表现为"关掉预览窗口后
     还能听到声音，一直到它播完"。实测：关闭 1.5 秒后 currentTime 从 0.92 涨到 2.45、
     paused 仍为 false。三处关闭入口（右上角 ×、点遮罩空白、Esc）原先都只做了 hidden。
     pause() 停掉音频；removeAttribute('src') + load() 让浏览器释放解码器，
     并中断仍在进行的 Range 下载（否则窗口关了还在后台拉数据）。 */
  function closeDetail() {
    $$('#detailBody video').forEach((v) => {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* 元素可能已不存在 */ }
    });
    $('#detailMask').hidden = true;
  }

  /* ---------------------------------------------------------- 素材引用展示
     回答一个原本无解的问题：「有参考素材了，但谁参考哪一张 / 哪一条？」
     编号 = 提交时 --image / --audio 的上传顺序；区块 = 提交时自动追加在提示词最前面的对应说明。
     这里把三件事摆在一起：① 编号表（图片 + 音频）② 将追加的区块 ③ 注入后的完整提示词。 */
  function assetLockHTML(full) {
    const al = full.assetLock;
    if (!al) return '';
    const imgs = al.images || [];
    const auds = al.audios || [];
    const skipped = al.skipped || [];
    const issues = al.issues || [];
    if (!imgs.length && !auds.length && !skipped.length) return '';

    let h = '<div class="sec-title">素材引用（提示词 → 参考图 / 音频）</div>';

    /* 说明文字按"实际绑了什么"分情况说 —— 原来只有"有图/无图"两种分支，
       只绑音频时会显示「尚未绑定任何参考图。」，与事实不符（明明绑了音频）。 */
    const what = [];
    if (imgs.length) what.push('<b>' + imgs.length + '</b> 张图（<code>--image</code>，只取外形、忽略参考图的静止姿势）');
    if (auds.length) what.push('<b>' + auds.length + '</b> 条音频（<code>--audio</code>，作为对应角色的声音参考）');
    h += '<div class="banner ' + (al.injected ? 'ok' : 'warn') + '"><span>' + (al.injected
      ? '提交时会自动在提示词<b>最前面</b>追加下面的区块：把每条参考素材指定到具体主体 / 角色。原文一字不改。' +
        '本次绑定了 ' + what.join(' 与 ') + '。'
      : (imgs.length
          ? '本分镜绑定了 ' + imgs.length + ' 张图，但按模型归属会走<b>画布</b>链路 —— 画布命令不带 --image，图片与区块都不会发出。要真正用上参考素材，请换用「创作 CLI」的型号。'
          : '尚未绑定任何参考素材。')) + '</span></div>';

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
        '<span class="hint-sm">音频 · 不占图片号' +
        (Number.isFinite(au.durationSec) ? ' · ' + au.durationSec + 's' : ' · 时长未知') + '</span>' +
        '<code>@音频' + au.n + '</code></span>').join('') + '</div>';
    }
    skipped.forEach((sk) => {
      h += '<div class="banner err"><span>素材「' + esc(sk.name) + '」未计入编号：' + esc(sk.reason) +
        '　<span class="hint-sm">它后面的编号不会因它顺延，但请优先修复，避免编号与预期不符。</span></span></div>';
    });
    issues.forEach((it) => {
      h += '<div class="banner ' + (it.level === 'warn' ? 'warn' : '') + '"><span>' + esc(it.message) + '</span></div>';
    });

    if (al.block) {
      h += '<div class="sec-title" style="font-size:12px">将追加的区块（素材锁定 + 音频参考）' +
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
    /* 首页 / 项目主页 的事件委托与静态按钮（多项目架构）。
       两页的内容都是整体重绘的，所以事件一律挂在容器上委托，
       与 #recView / #panel 的做法一致。 */
    bindPageViews();

    /* 快速多选：素材网格与分镜列表各挂一次框选引擎。
       两边共用同一套拖拽/区间逻辑，差异只在「项选择器」与「选择态怎么落地」。
       普通点击（没超过 4px 阈值）不拦，卡片编辑弹窗照常打开，不影响既有习惯。

       ⚠ 批量模式改在 **commit 时按结果** 进入，不再挂在起拖上（用户报的缺陷：
       「框选没选中任何资产，底部也会弹出批量操作条」）。原实现只要拖过 4px 就进模式，
       哪怕一个卡片都没框到，操作条照样弹出来而且不再收回。现在拖到了东西才进模式；
       一个都没框到就什么都不做，底部条自然保持收起。

       注意「批量选择」按钮走的是**另一条路**（显式进模式），那里 0 选中也要显示操作条 ——
       用户是主动进来的、正要开始选，此时把条收掉反而像按钮坏了。 */
    attachMarquee($('#panel'), {
      areaSel: '.panel-list',
      itemSel: '.acard',
      idOf: (el) => el.dataset.asset,
      selSet: () => S.assetSel,
      applySel: (el, on) => el.classList.toggle('sel', on),
      commit: (set) => {
        S.assetSel = set;
        if (set.size) S.assetSelMode = true;   // 拖出了东西才进批量模式
        renderPanel();
      },
    });
    attachMarquee($('#table'), {
      areaSel: '#table',
      itemSel: '.row',
      idOf: (el) => el.dataset.id,
      selSet: () => S.sel,
      applySel: (el, on) => {
        el.classList.toggle('sel', on);
        const c = $('.cbx', el);
        if (c) c.classList.toggle('on', on);
      },
      commit: (set) => { S.sel = set; renderTable(); renderPanel(); renderStatusbar(); },
    });

    $('#btnImport').addEventListener('click', openImport);
    $('#importClose').addEventListener('click', closeImport);
    $('#importCancel').addEventListener('click', closeImport);
    $('#importMask').addEventListener('click', (e) => { if (e.target.id === 'importMask') closeImport(); });
    $('#btnSettings').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsMask').addEventListener('click', closeSettings);
    $('#detailClose').addEventListener('click', closeDetail);
    $('#detailMask').addEventListener('click', (e) => { if (e.target.id === 'detailMask') closeDetail(); });

    // 干跑命令核对弹层
    $('#cmdClose').addEventListener('click', closeCmd);
    $('#cmdOk').addEventListener('click', closeCmd);
    $('#cmdMask').addEventListener('click', (e) => { if (e.target.id === 'cmdMask') closeCmd(); });
    $('#cmdCopyAll').addEventListener('click', copyAllCmds);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#cmdMask').hidden) closeCmd(); });

    // 自动匹配弹层
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

    /* 「紧凑视图」按钮已从顶栏移除，改由设置 →「个性化」里的开关控制（见 renderSettings 与
       settingsBody 的 data-toggle 分派）。这里不再有 #btnDensity 的监听。 */
    $('#btnHistory').addEventListener('click', openRecords);

    /* 素材面板覆盖层化：≤1440px 时面板固定在屏外（CSS），顶栏「素材」唤起、遮罩/Esc 关闭。
       宽屏（>1440）面板常驻且按钮被 CSS 隐藏，这些函数在宽屏调用无副作用（matchMedia 不命中直接返回）。
       两个助手定义在模块层（bindStatic 之外）：表格点击委托里点「＋」也要唤起面板。 */
    $('#btnPanel').addEventListener('click', openPanelIfOverlay);
    $('#panelMask').addEventListener('click', closePanelIfOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#panel').classList.contains('open')) closePanelIfOverlay();
    });
    bindRecords();
    /* 「模型」「画幅」两个胶囊已合并为一个纯文本 span（#modelRatioTxt），不再可点，
       故原来那两句"点一下弹提示"的监听一并删除 —— 说明改由该元素的 title 承担。 */

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
      /* 应用更新（仅桌面版会渲染出这些按钮） */
      const updact = e.target.closest('[data-updact]');
      if (updact) { runUpdateAction(updact.dataset.updact); return; }
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
      /* 开关：按 data-toggle 的值分派。
         · autoRetry 改的是生成行为（写 S.settings.queue）
         · compact   改的是显示偏好（写 #app 的类，与旧顶栏按钮同源）
         · theme     改的是外观偏好（写 <html> 的 data-theme，持久化到 localStorage；**不碰 S.settings**）
         三者互不影响，各自只动自己的那一份状态。 */
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        const k = tg.dataset.toggle;
        if (k === 'autoRetry') S.settings.queue.autoRetry = !S.settings.queue.autoRetry;
        else if (k === 'compact') applyDensity(!isCompact());
        else if (k === 'theme') setTheme(tg.dataset.themeVal);   // .seg 三态：读 data-theme-val
        renderSettings(); return;
      }
    });
    // 默认参数下拉：change 即改本地状态，「保存设置」时统一 PUT
    $('#settingsBody').addEventListener('change', (e) => {
      /* 更新源下拉：切换后立即保存并重绘 —— 三种源的字段完全不同，
         不重绘用户就看不到该填什么。 */
      if (e.target.id === 'updProvider') {
        const J = window.JCDesktop;
        if (J && J.updateSetSource) {
          S.appUpdate = S.appUpdate || {};
          S.appUpdate.showCfg = true;
          J.updateSetSource({ provider: e.target.value }).then((src) => {
            if (src) S.appUpdate.source = src;
            renderSettings();
          }).catch(() => renderSettings());
        }
        return;
      }
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
        /* 默认模型 / 画幅 / 分辨率变更会同步到已有分镜（时长不同步）—— 必须告诉用户改了多少条，
           否则"我改了默认模型"和"我那 15 条分镜现在用什么"之间的关系仍然是隐形的。 */
        const sy = S.settings.synced;
        if (sy && sy.updated) {
          const head = sy.fields.length
            ? sy.fields.map((f) => f.label + ' ' + (f.from || '—') + ' → ' + f.to).join('；')
            : '对齐到当前默认值（' + sy.defaults.map((f) => f.label + ' ' + f.value).join('、') + '）';
          toast('已同步 ' + sy.updated + ' 条分镜：' + head +
            (sy.skippedGenerating ? '（' + sy.skippedGenerating + ' 条生成中已跳过）' : ''), 'ok');
        } else if (!(adj && adj.length)) {
          toast('设置已保存', 'ok');
        }
        closeSettings();
        await loadList({ skeleton: false });   // 同步后表格里的模型/画幅要立刻反映出来
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
      closeDetail();   // 同样要先停视频，否则 Esc 关窗后声音还在放
    });
  }
  const persetsFix = (v) => (v && v.trim()) ? v : ';;';

  /* ---------------------------------------------------------- 启动 */
  async function boot() {
    initTheme();   // 主题先于一切：解析持久化偏好 → 写 <html data-theme>，避免首屏闪色
    bindStatic();
    renderColhead();
    render();
    /* 启动顺序（多项目架构，指令 §20/§36）：
       先按 URL 解析出"应该进哪一层"，再加载那一层需要的数据。
       ⚠ 不能像以前那样无条件 loadList() —— 列表是**分镜表级**数据，
       没有确定当前分镜表之前拉它只会拿到旧项目的分镜（或空）。
       bootFromUrl 内部：?project&workspace → 工作区；?project → 项目主页；
       都没有 → 首页（项目列表）。目标不存在时逐级安全降级，不会崩。 */
    await bootFromUrl();
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
