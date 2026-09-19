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

  const CFG = (global.APP_CONFIG = Object.assign({
    baseUrl: DEFAULT_BASE,
    token: '',
    projectId: 'pj_1'
  }, global.APP_CONFIG || {}));

  /* ---------------------------------------------------------- 错误 */
  const ERR = {
    OK: 0,
    PARAM: 40001, UNAUTH: 40100, FORBIDDEN: 40300, NOTFOUND: 40400,
    CONFLICT: 40900, RATELIMIT: 42900, INTERNAL: 50000,
    CLI_DOWN: 51001, NO_CREDIT: 51002, AUDIT: 51003, UPSTREAM_TIMEOUT: 51004, INTERRUPTED: 51005
  };

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

  /* ---------------------------------------------------------- 对外 API */
  const api = {
    CFG, META, ERR, ApiError,
    grad,

    getOptions:   ()          => request('GET', '/meta/options'),
    me:           ()          => request('GET', '/auth/me'),
    getAdapter:   ()          => request('GET', '/system/adapter'),
    adapterCheck: ()          => request('POST', '/system/adapter/check'),
    /* 画布 CLI 已移除：原先的 /system/adapter/login 与 /switch 两个画布专用入口随之删除 */
    dreaminaLogin: ()         => request('POST', '/system/adapter/dreamina/login'),
    dreaminaSwitch:()         => request('POST', '/system/adapter/dreamina/switch'),

    listStoryboards: (query)  => request('GET', '/projects/' + CFG.projectId + '/storyboards', { query }),
    getProgress:  (ids)       => request('GET', '/storyboards/progress', { query: { ids: ids.join(',') } }),
    getStoryboard:(id)        => request('GET', '/storyboards/' + id),
    createStoryboard: (body)  => request('POST', '/storyboards', { body }),
    patchStoryboard: (id, body) => request('PATCH', '/storyboards/' + id, { body }),
    batchDuration:(ids, durationSec) => request('POST', '/storyboards/batch-duration', { body: { ids, durationSec } }),
    // dryRun=true：只组装命令、不派发给即梦（提交后在页面核对真实命令）
    batchSubmit:  (ids, concurrency, dryRun) => request('POST', '/storyboards/batch-submit', { body: { ids, concurrency, dryRun: !!dryRun }, idempotencyKey: rid('') }),
    // 干跑校验（不提交、不改状态）：返回各引擎完整命令 + 画布 CLI 本地校验结果
    dryRun:       (id)           => request('POST', '/storyboards/' + id + '/dry-run', { body: {} }),
    cancel:       (id)        => request('POST', '/storyboards/' + id + '/cancel', { body: {} }),
    retry:        (id)        => request('POST', '/storyboards/' + id + '/retry', { body: { resetProgress: true } }),
    batchDelete:  (ids, force) => request('POST', '/storyboards/batch-delete', { body: { ids, force: !!force } }),
    reorder:      (id, direction) => request('POST', '/storyboards/' + id + '/reorder', { body: { direction } }),

    listAssets:   (query)     => request('GET', '/assets', { query }),
    // 素材设置：更新名称 / 文生图提示词（body: { name?, prompt? }，至少一项）/ 更换文件（更换保留素材 id 与全部分镜绑定）
    updateAsset:  (id, body)  => request('PATCH', '/assets/' + id, { body: body || {} }),
    replaceAsset: (id, file, name) => request('POST',
      '/assets/' + id + '/file?filename=' + encodeURIComponent(file.name) + (name ? '&name=' + encodeURIComponent(name) : ''),
      { raw: true, mime: file.type, body: file }),
    uploadAsset:  (file, type) => request('POST', '/assets/upload?type=' + encodeURIComponent(type) + '&name=' + encodeURIComponent(file.name), { raw: true, mime: file.type, body: file }),
    // 删除素材（同时解除所有分镜绑定并清理磁盘文件）
    deleteAsset:  (id) => request('DELETE', '/assets/' + id),
    // 提示词文本导入资产：@ 分段自动识别 场景/道具/角色；apply=false 仅解析预览，true 落库
    importAssetPrompts: (rawText, apply) => request('POST', '/assets/import-prompts', { body: { rawText, apply: !!apply } }),
    bindAsset:    (id, assetId, role) => request('POST', '/storyboards/' + id + '/assets', { body: { assetId, role } }),
    unbindAsset:  (id, assetId) => request('DELETE', '/storyboards/' + id + '/assets/' + assetId),
    // 自动匹配参考图（v1 只按素材名称）：apply=false 仅预览不写库；overwrite 控制是否替换该类型已有绑定
    autoMatchAssets: (body) => request('POST', '/storyboards/auto-assets', { body }),
    // 按提示词里的「总时长」标注重算时长（向上进位）：apply 缺省 true 直接生效，传 false 只预览
    autoDuration: (body) => request('POST', '/storyboards/auto-duration', { body }),

    // 生成记录：追加式快照，分镜被改/被删都不影响已落盘的记录
    //   query: { page, pageSize, action, outcome, engine, model, keyword, from, to }
    listRecords:  (query)     => request('GET', '/records', { query }),
    getRecord:    (id)        => request('GET', '/records/' + id),
    deleteRecord: (id)        => request('DELETE', '/records/' + id),
    // 清空必须显式给口径：{ ids:[…] } / { before: ISO } / { all:true }
    clearRecords: (body)      => request('POST', '/records/clear', { body }),
    // 导出：format = md（默认，含完整提示词与命令）| csv（表格）| json（全量）
    exportRecords:(query)     => request('GET', '/records/export', { query }),

    importPreview:(rawText, delimiter) => request('POST', '/storyboards/import/preview', { body: { rawText, delimiter, trimEmpty: true, dedupe: true } }),
    importConfirm:(rawText, delimiter, defaults) => request('POST', '/storyboards/import', { body: { rawText, delimiter, defaults, insertPosition: 'top' }, idempotencyKey: rid('') }),

    getSettings:  ()          => request('GET', '/settings'),
    putSettings:  (s)         => request('PUT', '/settings', { body: s }),
    resetSettings:(scopes)    => request('POST', '/settings/reset', { body: { scopes } })
  };

  global.Api = api;
})(window);
