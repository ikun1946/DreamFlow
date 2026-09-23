/* ============================================================
   api.js —— 接口层（唯一与后端耦合的地方）
   ------------------------------------------------------------
   本应用只以 http 模式运行：所有数据来自真实后端（server/），
   没有任何本地模拟数据。启动前需先启动后端：
     node server/index.js        # 默认 http://127.0.0.1:8787

   可选配置：在 index.html 引入本文件之前插入
     window.APP_CONFIG = { baseUrl: '...', token: '...', projectId: 'pj_1' };
   默认行为：
     - 页面由后端托管（http/https）→ baseUrl 取同源 /api/v1
     - 页面以 file:// 打开        → baseUrl 取 http://127.0.0.1:8787/api/v1
     - token 为空则不携带 Authorization 头

   约定（与 docs/前端页面与接口对接说明.md 一致）：
     - 统一响应信封 { code, message, data, traceId }，code !== 0 视为业务失败
     - 失败统一抛 ApiError(code, message, data, traceId)，由 app.js 统一 Toast
     - 列表接口顺带返回 stats，避免首屏串行两请求
     - 轮询接口只返回「有变化」的项
   ============================================================ */
(function (global) {
  'use strict';

  const DEFAULT_BASE = (/^https?:$/.test((global.location || {}).protocol || ''))
    ? '/api/v1'
    : 'http://127.0.0.1:8787/api/v1';

  /* ---------------------------------------------------------- 当前作用域
     多项目架构（2026-09-19）：前端持有 currentProjectId / currentWorkspaceId
     （指令 §25 明确允许——**只有前端**能有这个概念，后端一律 request-scoped）。
     这里把它们放在 CFG 上，与既有的 projectId 用法一脉相承：
     每个业务请求都显式带上作用域，后端据此过滤并校验父子关系。
     setScope() 是唯一的写入口，避免各处零散改写。 */
  const CFG = (global.APP_CONFIG = Object.assign({
    baseUrl: DEFAULT_BASE,
    token: '',
    projectId: 'pj_1',
    workspaceId: ''
  }, global.APP_CONFIG || {}));

  function setScope(o) {
    const s = o || {};
    if (s.projectId !== undefined) CFG.projectId = s.projectId || '';
    if (s.workspaceId !== undefined) CFG.workspaceId = s.workspaceId || '';
    return { projectId: CFG.projectId, workspaceId: CFG.workspaceId };
  }
  /* 业务请求的作用域参数。后端支持"路径 / 查询串"两种来源，这里统一走查询串，
     好处是旧式扁平路径与新的作用域化路径共用同一套拼接。 */
  function scopeQuery(extra) {
    const q = Object.assign({}, extra || {});
    if (CFG.projectId) q.projectId = CFG.projectId;
    if (CFG.workspaceId) q.workspaceId = CFG.workspaceId;
    return q;
  }

  /* 音频时长（秒）只在**确实读到了**的时候才放进 query：
     读不到就整项不传，让服务端去走 ffprobe 兜底，而不是传一个空串/NaN 上去。
     传 `undefined` 时 URL 序列化会整项丢掉，正是想要的行为。 */
  const secOrUndef = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

  /* ---------------------------------------------------------- 错误 */
  const ERR = {
    OK: 0,
    PARAM: 40001, UNAUTH: 40100, FORBIDDEN: 40300, NOTFOUND: 40400,
    CONFLICT: 40900, RATELIMIT: 42900, INTERNAL: 50000,
    CLI_DOWN: 51001, NO_CREDIT: 51002, AUDIT: 51003, UPSTREAM_TIMEOUT: 51004, INTERRUPTED: 51005,
    /* 外部工具状态（2026-09-21，与 server/util.js 严格对齐）。取值 511xx：
       与 510xx（CLI 运行期失败）区分开 —— 这一组表达的是"环境没装好"，
       是可以由用户安装/登录来解决的，界面据此显示"去处理"入口而非"重试"。 */
    CLI_NOT_FOUND: 51101, CLI_NOT_LOGGED_IN: 51102, CLI_PERMISSION_DENIED: 51103,
    FFMPEG_NOT_FOUND: 51104, FFPROBE_NOT_FOUND: 51105
  };

  /* 外部工具类码的判别集合 —— 前端不写散落的数字比较 */
  const TOOL_ERROR_CODES = [
    ERR.CLI_NOT_FOUND, ERR.CLI_NOT_LOGGED_IN, ERR.CLI_PERMISSION_DENIED,
    ERR.FFMPEG_NOT_FOUND, ERR.FFPROBE_NOT_FOUND
  ];
  const isToolError = (code) => TOOL_ERROR_CODES.indexOf(Number(code)) >= 0;

  class ApiError extends Error {
    constructor(code, message, data, traceId) {
      super(message || '请求失败');
      this.code = code; this.data = data; this.traceId = traceId;
    }
  }

  /* ---------------------------------------------- 默认枚举兜底（非演示数据）
     仅用于 GET /meta/options 返回前的骨架渲染与兜底；
     运行时选项以后端下发为准，前端不据此硬编码业务判断。 */
  const META = {
    projectName: '',
    /* 模型清单与归属以后端下发为准（server/models.js 是唯一事实来源）；
       此处仅为接口返回前的兜底。2026-09-18 画布 CLI 移除后只剩创作 CLI 的 6 个型号。 */
    models: [
      { value: 'seedance2.0',           label: 'Seedance 2.0',          enabled: true, engines: ['dreamina'], group: 'dreamina' },
      { value: 'seedance2.0fast',       label: 'Seedance 2.0 Fast',     enabled: true, engines: ['dreamina'], group: 'dreamina' },
      { value: 'seedance2.0_vip',       label: 'Seedance 2.0 VIP',      enabled: true, engines: ['dreamina'], group: 'dreamina' },
      { value: 'seedance2.0fast_vip',   label: 'Seedance 2.0 Fast VIP', enabled: true, engines: ['dreamina'], group: 'dreamina' },
      { value: 'seedance2.0mini',       label: 'Seedance 2.0 Mini',     enabled: true, engines: ['dreamina'], group: 'dreamina' },
      { value: 'seedance2.5',           label: 'Seedance 2.5',          enabled: true, engines: ['dreamina'], group: 'dreamina' }
    ],
    modelGroups: [
      { key: 'dreamina', label: '创作 CLI' }
    ],
    ratios: [
      { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
      { value: '1:1',  label: '1:1'  }, { value: '4:3',  label: '4:3' }
    ],
    resolutions: [
      { value: '480p', label: '480p' }, { value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }
    ],
    duration: {
      min: 4, max: 15, step: 1, defaultValue: 5,
      presets: [5, 10, 12], unit: 's', allowCustom: true
    },
    settings: {
      delimiterTypes: [
        { value: 'newline', label: '换行符' },
        { value: 'custom',  label: '自定义' }
      ],
      delimiterPresets: [';;', '|', '---'],
      concurrency: { min: 1, max: 5, defaultValue: 2 },
      autoRetry: { defaultValue: true, maxRetry: 2 }
    }
  };

  /* ---------------------------------------------------------- 工具 */
  const rid = (p) => p + Math.random().toString(36).slice(2, 8);

  /* 缩略图兜底：由 ID 派生稳定渐变（后端未提供图片资源时保持可读性） */
  const GRADS = [
    'linear-gradient(135deg,#2B3A55,#5B7A9E)',
    'linear-gradient(135deg,#4A3550,#9A6B8E)',
    'linear-gradient(135deg,#2F4A38,#5E9E78)',
    'linear-gradient(135deg,#5A4326,#B08D52)',
    'linear-gradient(135deg,#33384A,#6E7A99)',
    'linear-gradient(135deg,#54303A,#A06070)'
  ];
  function grad(seed) {
    let h = 0;
    for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) >>> 0;
    return GRADS[h % GRADS.length];
  }

  /* ---------------------------------------------------------- HTTP 路由 */
  function qs(query) {
    if (!query) return '';
    const pairs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(Array.isArray(v) ? v.join(',') : v));
    return pairs.length ? '?' + pairs.join('&') : '';
  }

  async function httpRoute(method, path, opt) {
    opt = opt || {};
    const url = CFG.baseUrl + path + qs(opt.query);
    let res;
    try {
      const headers = Object.assign(
        CFG.token ? { Authorization: 'Bearer ' + CFG.token } : {},
        opt.idempotencyKey ? { 'Idempotency-Key': opt.idempotencyKey } : {},
        opt.raw ? { 'Content-Type': opt.mime || 'application/octet-stream' } : { 'Content-Type': 'application/json' }
      );
      res = await fetch(url, {
        method,
        headers,
        body: opt.raw ? (opt.body || undefined) : (opt.body ? JSON.stringify(opt.body) : undefined)
      });
    } catch (e) {
      throw new ApiError(-1, '网络异常，请确认后端已启动（node server/index.js）');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!json) throw new ApiError(ERR.INTERNAL, '服务返回异常（HTTP ' + res.status + '）');
    if (json.code !== ERR.OK) throw new ApiError(json.code, json.message, json.data, json.traceId);
    return json.data;
  }

  function request(method, path, opt) { return httpRoute(method, path, opt); }

  /* 批量提交的幂等键 = 提交内容 + 2 秒时间桶。
     为什么不沿用 rid('')（每次调用随机）：那样连点两次就是两个不同的键，
     后端做得再幂等也拦不住重复提交 —— 而重复提交在这里等于**重复生成 + 重复扣费**。
     用时间桶让"同一批、同一瞬间"的重复请求落到同一个键上（连点 / 网络重发被吸收），
     而几秒之后的再次提交仍是新键（首次快速失败后立刻重提，不会被当成重放而不执行）。 */
  function submitKey(ids, dryRun) {
    const bucket = Math.floor(Date.now() / 2000);
    const src = (ids || []).slice().sort().join(',') + '|' + (dryRun ? 'dry' : 'real') + '|' + bucket;
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
    return 'sb_' + h.toString(36) + '_' + bucket.toString(36);
  }

  /* ---------------------------------------------------------- 对外 API */
  const api = {
    CFG, META, ERR, ApiError, TOOL_ERROR_CODES, isToolError,
    grad, setScope, scopeQuery,

    getOptions:   ()          => request('GET', '/meta/options', { query: scopeQuery() }),
    me:           ()          => request('GET', '/auth/me'),
    getAdapter:   ()          => request('GET', '/system/adapter'),
    adapterCheck: ()          => request('POST', '/system/adapter/check'),
    /* 创作 CLI 的安装 / 更新：走官方 CDN，见 server/cli-installer.js。
       ⚠ installCli 是长请求（要下 ~30 MB），调用方**必须**给加载态；
       request() 没有超时，所以慢网下它会一直等，不会中途被掐断。 */
    getCliStatus: ()          => request('GET', '/system/cli'),
    installCli:   ()          => request('POST', '/system/cli/install'),
    /* 数据目录（系统级，2026-09-23 新增）。
       ⚠ setDataDir 只负责"校验 + 搬数据 + 写配置"，**改动要重启应用才生效** ——
       当前进程的 store 已经把旧目录的 db.json 读进内存了（见 server/data-dir.js 注释）。
       mode: 'move' = 迁移并切换 / 'switch' = 仅切换。 */
    getRuntimePaths: ()        => request('GET', '/runtime/paths'),
    setDataDir:   (dir, mode)  => request('POST', '/runtime/data-dir', { body: { dir, mode } }),
    /* 画布 CLI 已移除：原先的 /system/adapter/login 与 /switch 两个画布专用入口随之删除 */
    dreaminaLogin: ()         => request('POST', '/system/adapter/dreamina/login'),
    dreaminaSwitch:()         => request('POST', '/system/adapter/dreamina/switch'),

    /* ---------------- Project / Workspace（多项目架构） ---------------- */
    listProjects: ()          => request('GET', '/projects'),
    createProject:(body)      => request('POST', '/projects', { body }),
    getProject:   (id)        => request('GET', '/projects/' + id),
    patchProject: (id, body)  => request('PATCH', '/projects/' + id, { body }),
    // 软删除：后端只打 deletedAt，不级联销毁数据
    deleteProject:(id)        => request('DELETE', '/projects/' + id),
    // 彻底删除：连磁盘文件、分镜、素材、生成记录一起删，**不可恢复**
    hardDeleteProject:(id)    => request('DELETE', '/projects/' + id, { query: { hard: '1' } }),
    // 彻底删除的预检：只统计（子项数量 / 文件数 / 磁盘占用 / 是否有任务在跑），不修改任何东西
    hardDeletePreview:(id)    => request('GET', '/projects/' + id + '/hard-delete-preview'),
    listWorkspaces:(projectId) => request('GET', '/projects/' + projectId + '/workspaces'),
    createWorkspace:(projectId, body) => request('POST', '/projects/' + projectId + '/workspaces', { body }),
    getWorkspace: (id)        => request('GET', '/workspaces/' + id),
    patchWorkspace:(id, body) => request('PATCH', '/workspaces/' + id, { body }),
    deleteWorkspace:(id)      => request('DELETE', '/workspaces/' + id),

    /* 分镜列表：有工作区作用域时走作用域化路径，否则回落到项目级路径（兼容旧行为） */
    listStoryboards: (query)  => request('GET',
      CFG.workspaceId ? '/workspaces/' + CFG.workspaceId + '/storyboards'
        : '/projects/' + CFG.projectId + '/storyboards',
      { query }),
    getProgress:  (ids)       => request('GET', '/storyboards/progress', { query: scopeQuery({ ids: ids.join(',') }) }),
    getStoryboard:(id)        => request('GET', '/storyboards/' + id, { query: scopeQuery() }),
    createStoryboard: (body)  => request('POST', '/storyboards', { body }),
    patchStoryboard: (id, body) => request('PATCH', '/storyboards/' + id, { body: body, query: scopeQuery() }),
    batchDuration:(ids, durationSec) => request('POST', '/storyboards/batch-duration', { body: { ids, durationSec }, query: scopeQuery() }),
    // dryRun=true：只组装命令、不派发给即梦（提交后在页面核对真实命令）
    batchSubmit:  (ids, concurrency, dryRun) => request('POST', '/storyboards/batch-submit', { body: { ids, concurrency, dryRun: !!dryRun }, idempotencyKey: submitKey(ids, dryRun), query: scopeQuery() }),
    // 干跑校验（不提交、不改状态）：返回各引擎完整命令 + 画布 CLI 本地校验结果
    dryRun:       (id)           => request('POST', '/storyboards/' + id + '/dry-run', { body: {}, query: scopeQuery() }),
    cancel:       (id)        => request('POST', '/storyboards/' + id + '/cancel', { body: {}, query: scopeQuery() }),
    retry:        (id)        => request('POST', '/storyboards/' + id + '/retry', { body: { resetProgress: true }, query: scopeQuery() }),
    batchDelete:  (ids, force) => request('POST', '/storyboards/batch-delete', { body: { ids, force: !!force }, query: scopeQuery() }),
    reorder:      (id, direction) => request('POST', '/storyboards/' + id + '/reorder', { body: { direction }, query: scopeQuery() }),

    // 素材属于**项目**：同一项目下所有页面共享一份素材库
    listAssets:   (query)     => request('GET', '/assets', { query: scopeQuery(query) }),
    // 素材设置：更新名称 / 文生图提示词（body: { name?, prompt? }，至少一项）/ 更换文件（更换保留素材 id 与全部分镜绑定）
    updateAsset:  (id, body)  => request('PATCH', '/assets/' + id, { body: body || {}, query: scopeQuery() }),
    // 素材被哪些分镜引用（项目级）。改类型前用它给出准确的"N 条分镜"提示。
    assetUsage:   (id)        => request('GET', '/assets/' + id + '/usage', { query: scopeQuery() }),
    replaceAsset: (id, file, name, durationSec) => request('POST', '/assets/' + id + '/file',
      { raw: true, mime: file.type, body: file,
        query: scopeQuery({ filename: file.name, name: name || undefined, durationSec: secOrUndef(durationSec) }) }),
    uploadAsset:  (file, type, durationSec) => request('POST', '/assets/upload',
      { raw: true, mime: file.type, body: file,
        query: scopeQuery({ type: type, name: file.name, durationSec: secOrUndef(durationSec) }) }),
    // 新建素材：只建元数据（名称 + 类型 + 可选提示词），文件之后用 replaceAsset 补
    createAsset:  (body)     => request('POST', '/assets', { body: body || {}, query: scopeQuery() }),
    // 删除素材（同时解除所有分镜绑定并清理磁盘文件）
    deleteAsset:  (id) => request('DELETE', '/assets/' + id, { query: scopeQuery() }),
    // 提示词文本导入资产：@ 分段自动识别 场景/道具/角色；apply=false 仅解析预览，true 落库
    importAssetPrompts: (rawText, apply) => request('POST', '/assets/import-prompts', { body: { rawText, apply: !!apply }, query: scopeQuery() }),
    bindAsset:    (id, assetId, role) => request('POST', '/storyboards/' + id + '/assets', { body: { assetId, role }, query: scopeQuery() }),
    unbindAsset:  (id, assetId) => request('DELETE', '/storyboards/' + id + '/assets/' + assetId, { query: scopeQuery() }),
    // 自动匹配（按素材名匹配图片参考与音色参考）：apply=false 仅预览不写库；overwrite 控制是否替换该类型已有绑定
    autoMatchAssets: (body) => request('POST', '/storyboards/auto-assets', { body, query: scopeQuery() }),
    // 按提示词里的「总时长」标注重算时长（向上进位）：apply 缺省 true 直接生效，传 false 只预览
    autoDuration: (body) => request('POST', '/storyboards/auto-duration', { body, query: scopeQuery() }),

    // 生成记录：追加式快照，分镜被改/被删都不影响已落盘的记录
    //   query: { page, pageSize, action, outcome, engine, model, keyword, from, to }
    listRecords:  (query)     => request('GET', '/records', { query: scopeQuery(query) }),
    getRecord:    (id)        => request('GET', '/records/' + id, { query: scopeQuery() }),
    deleteRecord: (id)        => request('DELETE', '/records/' + id, { query: scopeQuery() }),
    // 清空必须显式给口径：{ ids:[…] } / { before: ISO } / { all:true }（后端只清当前项目）
    clearRecords: (body)      => request('POST', '/records/clear', { body, query: scopeQuery() }),
    // 导出：format = md（默认，含完整提示词与命令）| csv（表格）| json（全量）
    exportRecords:(query)     => request('GET', '/records/export', { query: scopeQuery(query) }),

    importPreview:(rawText, delimiter) => request('POST', '/storyboards/import/preview', { body: { rawText, delimiter, trimEmpty: true, dedupe: true }, query: scopeQuery() }),
    importConfirm:(rawText, delimiter, defaults) => request('POST', '/storyboards/import', { body: { rawText, delimiter, defaults, insertPosition: 'top' }, idempotencyKey: rid(''), query: scopeQuery() }),

    // 设置：delimiter / defaults 属项目级（项目覆盖 ⊕ 全局默认），queue 属系统级
    getSettings:  ()          => request('GET', '/settings', { query: scopeQuery() }),
    putSettings:  (s)         => request('PUT', '/settings', { body: s, query: scopeQuery() }),
    resetSettings:(scopes)    => request('POST', '/settings/reset', { body: { scopes }, query: scopeQuery() })
  };

  global.Api = api;
})(window);
