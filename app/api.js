/* ============================================================
   api.js —— 接口层（唯一与后端耦合的地方）
   ============================================================
   两种模式，改一行即可切换：

     mock（默认）：全部 23 个接口由本地内存 + 模拟生成引擎实现，
                   前端可独立跑通、可演示、可给后端当契约参照。
     http        ：真实请求后端。路径、请求体、响应体、错误码
                   与《前端页面与接口对接说明.md》第 4/5 章完全一致。

   切换方式：在 index.html 里、引入本文件之前，先插一段内联配置，内容为
     window.APP_CONFIG = { apiMode: 'http', baseUrl: 'https://your-api.com/api/v1', token: '<token>' };
   （完整示例见 README.md「切换后端」一节）

   约定（与文档一致）：
     - 统一响应信封 { code, message, data, traceId }，code !== 0 视为业务失败
     - 失败统一抛 ApiError(code, message, data, traceId)，由 app.js 统一 Toast
     - 列表接口顺带返回 stats，避免首屏串行两请求
     - 轮询接口只返回「有变化」的项
   ============================================================ */
(function (global) {
  'use strict';

  const CFG = (global.APP_CONFIG = Object.assign({
    apiMode: 'mock',            // 'mock' | 'http'
    baseUrl: '/api/v1',
    projectId: 'pj_1',
    latency: [60, 180],         // mock 下模拟网络耗时，便于看到骨架屏
    tickMs: 1200
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

  /* ------------------------------------------------ 枚举（/meta/options） */
  const META = {
    projectName: '雨夜归途',
    models: [
      { value: 'dreamina-v3.0',     label: '即梦视频 3.0',  enabled: true },
      { value: 'dreamina-v2.5-pro', label: '即梦视频 2.5 Pro', enabled: true },
      { value: 'seedance-2.0',      label: 'Seedance 2.0', enabled: true },
      { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast', enabled: false, disabledReason: '当前账号未开通' }
    ],
    ratios: [
      { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
      { value: '1:1',  label: '1:1'  }, { value: '4:3',  label: '4:3' }
    ],
    resolutions: [
      { value: '480p', label: '480p' }, { value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }
    ],
    duration: {
      min: 1, max: 30, step: 1, defaultValue: 5,
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
  const now = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lat = () => Math.round(CFG.latency[0] + Math.random() * (CFG.latency[1] - CFG.latency[0]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  /* 缩略图占位：由 ID 派生稳定渐变，避免依赖任何外部图片资源 */
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

  /* ---------------------------------------------------------- 内存库 */
  const DB = { storyboards: [], assets: [], settings: null, seq: 0 };

  function seed() {
    DB.assets = [
      { id: 'as_c1', name: '林彻',   type: 'character', gradSeed: 'c1' },
      { id: 'as_c2', name: '苏晚',   type: 'character', gradSeed: 'c2' },
      { id: 'as_c3', name: '周敬',   type: 'character', gradSeed: 'c3' },
      { id: 'as_c4', name: '老陈',   type: 'character', gradSeed: 'c4' },
      { id: 'as_c5', name: '群演甲', type: 'character', gradSeed: 'c5' },
      { id: 'as_c6', name: '群演乙', type: 'character', gradSeed: 'c6' },
      { id: 'as_s1', name: '雨夜街道', type: 'scene' },
      { id: 'as_s2', name: '便利店',   type: 'scene' },
      { id: 'as_s3', name: '山谷',     type: 'scene' },
      { id: 'as_s4', name: '车内',     type: 'scene' },
      { id: 'as_s5', name: '天台',     type: 'scene' },
      { id: 'as_s6', name: '沙漠',     type: 'scene' },
      { id: 'as_p1', name: '收音机', type: 'prop' },
      { id: 'as_p2', name: '雨伞',   type: 'prop' },
      { id: 'as_p3', name: '手机',   type: 'prop' },
      { id: 'as_p4', name: '车钥匙', type: 'prop' }
    ].map((a) => Object.assign(a, {
      projectId: CFG.projectId,
      url: 'mock://asset/' + a.id,
      thumbUrl: 'mock://asset/' + a.id + '/thumb',
      width: 1024, height: 1024, tags: [],
      grad: grad(a.gradSeed || a.id)
    }));

    const A = (id, role) => ({ assetId: id, role });
    const rows = [
      ['无人机穿过云层下降，山谷中的湖泊逐渐显现，晨雾未散，镜头持续前推。', 10, 'dreamina-v3.0', '16:9', '1080p', 0.65, 'generating', 46, [A('as_c1', 'character'), A('as_c2', 'character'), A('as_s3', 'scene')]],
      ['深夜便利店，收银员抬头看向门口，暖黄灯管轻微闪烁，镜头缓慢横移。', 5, 'seedance-2.0', '16:9', '720p', 0.55, 'queued', 0, [A('as_c4', 'character'), A('as_s2', 'scene')]],
      ['老式收音机特写，旋钮被缓慢转动，指针扫过刻度，暖色台灯侧光。', 12, 'dreamina-v3.0', '4:3', '720p', 0.40, 'succeeded', 100, [A('as_c4', 'character'), A('as_s2', 'scene'), A('as_p1', 'prop')], { firstFrame: true, storyboard: true }],
      ['沙漠中一辆越野车扬起沙尘疾驰，长焦压缩空间，金色逆光。', 10, 'dreamina-v3.0', '16:9', '720p', 0.80, 'failed', 62, [A('as_c3', 'character'), A('as_s6', 'scene')], { errorCode: '51002', errorMessage: '积分不足，无法完成该分镜' }],
      ['雨夜街道积水倒映霓虹，穿风衣的人影背对镜头渐远。', 5, 'seedance-2.0', '9:16', '720p', 0.60, 'generating', 12, [A('as_c1', 'character'), A('as_s1', 'scene'), A('as_p2', 'prop')]],
      ['天台上两个人对坐，远处城市灯火，镜头缓慢环绕。', 10, 'dreamina-v2.5-pro', '16:9', '1080p', 0.45, 'queued', 0, [A('as_c1', 'character'), A('as_c2', 'character'), A('as_s5', 'scene')]],
      ['车内在雨中行驶，雨刷来回摆动，挡风玻璃外霓虹糊成光斑。', 5, 'seedance-2.0', '16:9', '720p', 0.50, 'succeeded', 100, [A('as_c4', 'character'), A('as_s4', 'scene'), A('as_p4', 'prop')], { firstFrame: true }],
      ['手机屏幕亮起，一条未读消息，拇指悬停在屏幕上。', 5, 'dreamina-v3.0', '9:16', '720p', 0.35, 'succeeded', 100, [A('as_c1', 'character'), A('as_s4', 'scene'), A('as_p3', 'prop')], { firstFrame: true, storyboard: true }]
    ];

    DB.storyboards = rows.map((r, i) => {
      const [prompt, durationSec, model, ratio, resolution, motion, status, progress, assets, extra] = r;
      const id = 'st_' + (1000 + i);
      const assetsAll = assets.slice();
      // 首帧图 / 分镜图 复用本行的场景素材：同一镜头的参考画面应当一致
      const sceneRef = assets.find((x) => x.role === 'scene');
      if (extra && extra.firstFrame && sceneRef) assetsAll.push(A(sceneRef.assetId, 'firstFrame'));
      if (extra && extra.storyboard && sceneRef) assetsAll.push(A(sceneRef.assetId, 'storyboard'));
      const done = status === 'succeeded';
      return {
        id, projectId: CFG.projectId, batchId: 'bt_21', seq: i + 1,
        prompt, negativePrompt: '', durationSec, model, ratio, resolution,
        seed: 'random', motion, status, progress,
        etaSeconds: status === 'generating' ? Math.max(2, Math.round((100 - progress) / 9)) : null,
        remoteId: status === 'queued' ? null : 'jm_' + (0x9f2c1a + i * 7919).toString(16),
        videoUrl: done ? 'mock://output/' + id + '.mp4' : null,
        coverUrl: done ? 'mock://output/' + id + '.jpg' : null,
        currentFrameUrl: null,
        elapsedMs: done ? 12000 + i * 2100 : null,
        retryCount: 0,
        errorCode: (extra && extra.errorCode) || null,
        errorMessage: (extra && extra.errorMessage) || null,
        canEditDuration: status !== 'succeeded',
        assets: assetsAll,
        createdAt: now(), startedAt: status === 'queued' ? null : now(),
        finishedAt: done ? now() : null,
        _dirty: true, _runtime: null
      };
    });

    DB.seq = DB.storyboards.length;
    DB.settings = {
      delimiter: { type: 'custom', value: ';;' },
      defaults: { model: 'dreamina-v3.0', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' },
      queue: { concurrency: 2, autoRetry: true, maxRetry: 2 },
      adapter: { mode: 'mock', cliAvailable: false, cliVersion: null }
    };
  }
  seed();

  /* ---------------------------------------------------------- 模拟生成引擎 */
  const engine = { timer: null, listeners: new Set() };

  function emit() { engine.listeners.forEach((cb) => { try { cb(); } catch (e) { /* noop */ } }); }

  function step() {
    const q = DB.settings.queue;
    const all = DB.storyboards;
    const running = all.filter((s) => s.status === 'generating');

    // 1. 排队 → 生成
    let slots = q.concurrency - running.length;
    if (slots > 0) {
      all.filter((s) => s.status === 'queued').slice(0, slots).forEach((s) => {
        s.status = 'generating';
        s.progress = 1;
        s.startedAt = now();
        s.remoteId = 'jm_' + rid('');
        s.etaSeconds = s.durationSec * 3;
        s._runtime = { inc: 5 + Math.random() * 10 };
        s._dirty = true;
      });
    }

    // 2. 推进生成中
    all.filter((s) => s.status === 'generating').forEach((s) => {
      const rt = (s._runtime = s._runtime || { inc: 5 + Math.random() * 10 });
      s.progress = Math.min(100, s.progress + rt.inc);
      s.etaSeconds = Math.max(0, Math.round((100 - s.progress) / 9));
      s._dirty = true;
      if (s.progress >= 100) {
        s.progress = 100; s.status = 'succeeded';
        s.videoUrl = 'mock://output/' + s.id + '.mp4';
        s.coverUrl = 'mock://output/' + s.id + '.jpg';
        s.finishedAt = now();
        s.elapsedMs = 9000 + Math.round(Math.random() * 12000);
        s.etaSeconds = 0;
        s.canEditDuration = false;   // 与文档 8.2 建议一致：完成后锁定时长
        s._runtime = null;
        s._dirty = true;
      }
    });

    // 3. 通知外部（前端可不依赖它，仅用于让 mock 场景下的 UI 及时刷新）
    if (all.some((s) => s._dirty)) emit();
  }

  function startEngine() {
    if (engine.timer || CFG.apiMode !== 'mock') return;
    engine.timer = setInterval(step, CFG.tickMs);
  }
  function stopEngine() {
    if (engine.timer) { clearInterval(engine.timer); engine.timer = null; }
  }

  /* ---------------------------------------------------------- 视图装配 */
  const assetOf = (id) => DB.assets.find((a) => a.id === id) || { id, name: '未知素材', grad: grad(id) };

  function decorate(s) {
    return Object.assign({}, s, {
      assets: s.assets.map((r) => {
        const a = assetOf(r.assetId);
        return { assetId: a.id, role: r.role, name: a.name, thumbUrl: a.thumbUrl, url: a.url, grad: a.grad };
      }),
      grad: grad(s.id)
    });
  }
  const bySeq = (a, b) => a.seq - b.seq;

  function stats() {
    const all = DB.storyboards;
    const c = { queued: 0, generating: 0, succeeded: 0, failed: 0, canceled: 0 };
    all.forEach((s) => c[s.status]++);
    const finished = c.succeeded + c.failed + c.canceled;
    const remain = all.length - finished;
    const avg = 14;   // 秒
    const conc = Math.max(1, DB.settings.queue.concurrency);
    return {
      total: all.length,
      queued: c.queued, generating: c.generating, succeeded: c.succeeded,
      failed: c.failed, canceled: c.canceled,
      overallProgress: all.length ? Math.round((finished / all.length) * 100) : 0,
      etaSeconds: remain ? Math.round((remain * avg) / conc) : 0
    };
  }

  /* ---------------------------------------------------------- mock 路由 */
  async function mockRoute(method, path, opt) {
    await sleep(lat());
    const q = opt.query || {};
    const b = opt.body || {};
    const m = (re) => (path.match(re) || []).slice(1);

    /* ---- 元数据 ---- */
    if (method === 'GET' && path === '/meta/options') {
      return Object.assign({}, META, { projectName: META.projectName });
    }
    if (method === 'GET' && path === '/auth/me') {
      return { userId: 'u_1', name: '张导', credits: 1280, plan: 'pro' };
    }
    if (method === 'GET' && path === '/system/adapter') {
      return Object.assign({}, DB.settings.adapter, {
        checkedAt: now(),
        message: DB.settings.adapter.cliAvailable
          ? 'jimeng CLI 已就绪'
          : '未检测到 jimeng CLI，任务将入队但不执行'
      });
    }

    /* ---- 设置 ---- */
    if (method === 'GET' && path === '/settings') return JSON.parse(JSON.stringify(DB.settings));
    if (method === 'PUT' && path === '/settings') {
      const s = b;
      if (s.queue && (s.queue.concurrency < 1 || s.queue.concurrency > 5)) {
        throw new ApiError(ERR.PARAM, '参数校验失败', { fields: [{ path: 'queue.concurrency', message: '范围为 1–5' }] });
      }
      if (s.delimiter && s.delimiter.type === 'custom' && !s.delimiter.value) {
        throw new ApiError(ERR.PARAM, '参数校验失败', { fields: [{ path: 'delimiter.value', message: '自定义分隔符不能为空' }] });
      }
      DB.settings = Object.assign({}, DB.settings, s, {
        adapter: Object.assign({}, DB.settings.adapter, (s.adapter || {}))
      });
      if (DB.settings.adapter.mode === 'cli' && !DB.settings.adapter.cliAvailable) stopEngine();
      else startEngine();
      return JSON.parse(JSON.stringify(DB.settings));
    }
    if (method === 'POST' && path === '/settings/reset') {
      const scopes = b.scopes || ['delimiter', 'defaults', 'queue'];
      if (scopes.includes('delimiter')) DB.settings.delimiter = { type: 'custom', value: ';;' };
      if (scopes.includes('defaults'))  DB.settings.defaults  = { model: 'dreamina-v3.0', ratio: '16:9', resolution: '720p', durationSec: 5, motion: 0.55, negativePrompt: '' };
      if (scopes.includes('queue'))     DB.settings.queue     = { concurrency: 2, autoRetry: true, maxRetry: 2 };
      return JSON.parse(JSON.stringify(DB.settings));
    }

    /* ---- 列表 + 统计 ---- */
    if (method === 'GET' && path === '/storyboards' || method === 'GET' && /^\/projects\/[^/]+\/storyboards$/.test(path)) {
      let list = DB.storyboards.slice().sort(bySeq);
      if (q.status) {
        const want = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
        if (want.length) list = list.filter((s) => want.includes(s.status));
      }
      if (q.keyword) {
        const k = String(q.keyword).toLowerCase();
        list = list.filter((s) => s.prompt.toLowerCase().includes(k) || s.id.includes(k) || (s.remoteId || '').includes(k));
      }
      const page = Number(q.page || 1), pageSize = Number(q.pageSize || 20);
      const total = list.length;
      const slice = list.slice((page - 1) * pageSize, page * pageSize);
      slice.forEach((s) => { s._dirty = false; });
      return { list: slice.map(decorate), page, pageSize, total, stats: stats() };
    }

    /* ---- 轮询：只返回有变化的项 ---- */
    if (method === 'GET' && path === '/storyboards/progress') {
      const ids = String(q.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      const changed = DB.storyboards.filter((s) => ids.includes(s.id) && s._dirty);
      changed.forEach((s) => { s._dirty = false; });
      return changed.map((s) => ({
        id: s.id, status: s.status, progress: Math.round(s.progress),
        etaSeconds: s.etaSeconds, currentFrameUrl: s.currentFrameUrl,
        videoUrl: s.videoUrl, coverUrl: s.coverUrl,
        retryCount: s.retryCount, errorCode: s.errorCode, errorMessage: s.errorMessage,
        canEditDuration: s.canEditDuration
      }));
    }

    /* ---- 单条 ---- */
    let mm = m(/^\/storyboards\/([^/]+)$/);
    if (mm.length) {
      const s = DB.storyboards.find((x) => x.id === mm[0]);
      if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
      if (method === 'GET') {
        return Object.assign(decorate(s), {
          cliCommand: 'jimeng video create --prompt "' + s.prompt + '" --model ' + s.model +
            ' --ratio ' + s.ratio + ' --duration ' + s.durationSec + 's --resolution ' + s.resolution +
            ' --motion ' + s.motion + ' --output ./output/' + s.id + '.mp4 --json',
          logs: (s._logs || []).slice(-20)
        });
      }
      if (method === 'PATCH') {
        if (b.durationSec != null && !s.canEditDuration) {
          throw new ApiError(ERR.CONFLICT, '分镜已完成，修改时长需重新生成');
        }
        if (b.durationSec != null) {
          const d = META.duration;
          const v = clamp(Math.round(Number(b.durationSec)), d.min, d.max);
          if (!isFinite(v)) throw new ApiError(ERR.PARAM, '时长不合法');
          s.durationSec = v;
        }
        ['prompt', 'model', 'ratio', 'resolution', 'seed', 'motion', 'negativePrompt'].forEach((k) => {
          if (b[k] != null) s[k] = b[k];
        });
        s._dirty = true;
        return decorate(s);
      }
      if (method === 'DELETE') {
        DB.storyboards = DB.storyboards.filter((x) => x.id !== s.id);
        renumber();
        return { deleted: [s.id] };
      }
    }

    mm = m(/^\/storyboards\/([^/]+)\/(cancel|retry)$/);
    if (mm.length && method === 'POST') {
      const s = DB.storyboards.find((x) => x.id === mm[0]);
      if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
      if (mm[1] === 'cancel') {
        if (s.status === 'succeeded') throw new ApiError(ERR.CONFLICT, '已完成的分镜无法取消');
        s.status = 'canceled'; s.progress = 0; s.etaSeconds = 0; s.finishedAt = now(); s._runtime = null;
      } else {
        s.status = 'queued'; s.progress = 0; s.etaSeconds = null;
        s.errorCode = null; s.errorMessage = null; s.retryCount++; s._runtime = null;
        s.canEditDuration = true;
      }
      s._dirty = true;
      return decorate(s);
    }

    mm = m(/^\/storyboards\/([^/]+)\/(assets|reorder)$/);
    if (mm.length && method === 'POST') {
      const s = DB.storyboards.find((x) => x.id === mm[0]);
      if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
      if (mm[1] === 'assets') {
        const role = b.role;
        const single = role !== 'character';
        if (single) s.assets = s.assets.filter((r) => r.role !== role);
        if (!s.assets.some((r) => r.assetId === b.assetId && r.role === role)) {
          s.assets.push({ assetId: b.assetId, role });
        }
      } else {
        const idx = DB.storyboards.slice().sort(bySeq).findIndex((x) => x.id === s.id);
        const to = b.direction === 'up' ? idx - 1 : idx + 1;
        const sorted = DB.storyboards.slice().sort(bySeq);
        if (to >= 0 && to < sorted.length) {
          const other = sorted[to];
          const t = s.seq; s.seq = other.seq; other.seq = t;
        }
      }
      s._dirty = true;
      return { id: s.id };
    }

    mm = m(/^\/storyboards\/([^/]+)\/assets\/([^/]+)$/);
    if (mm.length && method === 'DELETE') {
      const s = DB.storyboards.find((x) => x.id === mm[0]);
      if (!s) throw new ApiError(ERR.NOTFOUND, '分镜不存在');
      s.assets = s.assets.filter((r) => r.assetId !== mm[1]);
      s._dirty = true;
      return { id: s.id, removed: mm[1] };
    }

    /* ---- 批量 ---- */
    if (method === 'POST' && path === '/storyboards/batch-duration') {
      const updated = [], skipped = [];
      (b.ids || []).forEach((id) => {
        const s = DB.storyboards.find((x) => x.id === id);
        if (!s) return skipped.push({ id, reason: 'not_found', message: '分镜不存在' });
        if (!s.canEditDuration) return skipped.push({ id, reason: 'completed_locked', message: '已完成，已锁定时长' });
        s.durationSec = clamp(Math.round(Number(b.durationSec)), META.duration.min, META.duration.max);
        s._dirty = true; updated.push(id);
      });
      return { updated, skipped };
    }

    if (method === 'POST' && path === '/storyboards/batch-submit') {
      if (DB.settings.adapter.mode === 'cli' && !DB.settings.adapter.cliAvailable) {
        throw new ApiError(ERR.CLI_DOWN, '即梦 CLI 未连接，无法提交');
      }
      const accepted = [], rejected = [];
      (b.ids || []).forEach((id) => {
        const s = DB.storyboards.find((x) => x.id === id);
        if (!s) return rejected.push({ id, code: String(ERR.NOTFOUND), message: '分镜不存在' });
        if (s.status === 'generating' || s.status === 'queued') {
          return rejected.push({ id, code: String(ERR.CONFLICT), message: '该分镜已在队列中' });
        }
        if (s.errorCode === String(ERR.NO_CREDIT)) {
          return rejected.push({ id, code: String(ERR.NO_CREDIT), message: '积分不足，无法提交' });
        }
        s.status = 'queued'; s.progress = 0; s.errorCode = null; s.errorMessage = null;
        s.finishedAt = null; s.remoteId = null; s._dirty = true;
        accepted.push({ id, remoteId: null, status: 'queued' });
      });
      if (b.concurrency) DB.settings.queue.concurrency = clamp(Number(b.concurrency), 1, 5);
      startEngine();
      return { accepted, rejected };
    }

    if (method === 'POST' && path === '/storyboards/batch-delete') {
      const ids = b.ids || [];
      const running = DB.storyboards.filter((s) => ids.includes(s.id) && (s.status === 'generating' || s.status === 'queued'));
      if (running.length && !b.force) {
        throw new ApiError(ERR.CONFLICT, '存在运行中的分镜，请确认后强制删除', { ids: running.map((s) => s.id) });
      }
      const deleted = DB.storyboards.filter((s) => ids.includes(s.id)).map((s) => s.id);
      DB.storyboards = DB.storyboards.filter((s) => !ids.includes(s.id));
      renumber();
      return { deleted };
    }

    if (method === 'POST' && path === '/storyboards') {
      const d = DB.settings.defaults;
      const s = {
        id: rid('st_'), projectId: CFG.projectId, batchId: 'bt_21', seq: ++DB.seq,
        prompt: b.prompt || '', negativePrompt: b.negativePrompt || d.negativePrompt,
        durationSec: clamp(Number(b.durationSec || d.durationSec), META.duration.min, META.duration.max),
        model: b.model || d.model, ratio: b.ratio || d.ratio,
        resolution: b.resolution || d.resolution, seed: 'random',
        motion: b.motion != null ? b.motion : d.motion,
        status: 'queued', progress: 0, etaSeconds: null, remoteId: null,
        videoUrl: null, coverUrl: null, currentFrameUrl: null, elapsedMs: null,
        retryCount: 0, errorCode: null, errorMessage: null, canEditDuration: true,
        assets: [], createdAt: now(), startedAt: null, finishedAt: null,
        _dirty: true, _runtime: null
      };
      DB.storyboards.push(s);
      return decorate(s);
    }

    if (method === 'POST' && path === '/storyboards/import/preview') {
      const segs = splitSegments(b.rawText, b.delimiter);
      const existing = DB.storyboards.map((s) => s.prompt);
      const warnings = [];
      const out = segs.map((text, i) => {
        const dup = existing.includes(text);
        const tooLong = text.length > 2000;
        if (dup) warnings.push({ code: 'DUPLICATE', index: i + 1, message: '与已有分镜内容重复' });
        if (tooLong) warnings.push({ code: 'TOO_LONG', index: i + 1, message: '超过 2000 字' });
        return { index: i + 1, text, charCount: text.length, duplicate: dup, tooLong };
      });
      return { total: out.length, delimiterEcho: b.delimiter, segments: out, warnings };
    }

    if (method === 'POST' && path === '/storyboards/import') {
      const segs = splitSegments(b.rawText, b.delimiter);
      const d = Object.assign({}, DB.settings.defaults, b.defaults || {});
      const created = segs.map((text) => {
        const s = {
          id: rid('st_'), projectId: CFG.projectId, batchId: b.batchId || 'bt_21', seq: ++DB.seq,
          prompt: text, negativePrompt: d.negativePrompt || '',
          durationSec: clamp(Number(d.durationSec), META.duration.min, META.duration.max),
          model: d.model, ratio: d.ratio, resolution: d.resolution, seed: 'random',
          motion: d.motion, status: 'queued', progress: 0, etaSeconds: null, remoteId: null,
          videoUrl: null, coverUrl: null, currentFrameUrl: null, elapsedMs: null,
          retryCount: 0, errorCode: null, errorMessage: null, canEditDuration: true,
          assets: [], createdAt: now(), startedAt: null, finishedAt: null,
          _dirty: true, _runtime: null
        };
        DB.storyboards.push(s);
        return { id: s.id, seq: s.seq, status: s.status, prompt: s.prompt };
      });
      return { created, createdCount: created.length, batchId: 'bt_21', skipped: [] };
    }

    /* ---- 素材 ---- */
    if (method === 'GET' && path === '/assets') {
      const type = q.type || 'character';
      const kw = q.keyword ? String(q.keyword).toLowerCase() : '';
      let pool = DB.assets.filter((a) => a.type === type);
      if (kw) pool = pool.filter((a) => a.name.toLowerCase().includes(kw));
      const shot = q.inShotId ? DB.storyboards.find((s) => s.id === q.inShotId) : null;
      const usedIds = shot ? shot.assets.map((r) => r.assetId) : [];
      const view = (a) => Object.assign({}, a, { inCurrentShot: usedIds.includes(a.id) });
      const currentShot = usedIds.length
        ? DB.assets.filter((a) => usedIds.includes(a.id)).map(view)
        : [];
      return {
        currentShot,
        library: pool.map(view),
        counts: { currentShot: currentShot.length, library: pool.length }
      };
    }
    if (method === 'POST' && path === '/assets/upload') {
      throw new ApiError(ERR.INTERNAL, '演示环境未开启上传');
    }

    throw new ApiError(ERR.NOTFOUND, '接口不存在：' + method + ' ' + path);
  }

  function renumber() {
    DB.storyboards.slice().sort(bySeq).forEach((s, i) => { s.seq = i + 1; });
    DB.seq = DB.storyboards.length;
  }

  /* 拆分逻辑：与后端必须行为一致（trim 首尾、丢弃空段） */
  function splitSegments(rawText, delimiter) {
    const text = String(rawText || '');
    if (!text.trim()) return [];
    let parts;
    if (!delimiter || delimiter.type === 'newline' || !delimiter.value) {
      parts = text.split(/\r?\n/);
    } else {
      parts = text.split(delimiter.value);
    }
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
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
    const url = CFG.baseUrl + path + qs(opt.query);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          CFG.token ? { Authorization: 'Bearer ' + CFG.token } : {},
          opt.idempotencyKey ? { 'Idempotency-Key': opt.idempotencyKey } : {}
        ),
        body: opt.body ? JSON.stringify(opt.body) : undefined
      });
    } catch (e) {
      throw new ApiError(-1, '网络异常，请检查连接');
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!json) throw new ApiError(ERR.INTERNAL, '服务返回异常（HTTP ' + res.status + '）');
    if (json.code !== ERR.OK) throw new ApiError(json.code, json.message, json.data, json.traceId);
    return json.data;
  }

  function request(method, path, opt) {
    opt = opt || {};
    return CFG.apiMode === 'mock' ? mockRoute(method, path, opt) : httpRoute(method, path, opt);
  }

  /* ---------------------------------------------------------- 对外 API */
  const api = {
    CFG, META, ERR, ApiError,
    grad, assetOf,
    onEngineTick(cb) { engine.listeners.add(cb); return () => engine.listeners.delete(cb); },
    resumeEngine() { startEngine(); },

    getOptions:   ()          => request('GET', '/meta/options'),
    me:           ()          => request('GET', '/auth/me'),
    getAdapter:   ()          => request('GET', '/system/adapter'),

    listStoryboards: (query)  => request('GET', '/projects/' + CFG.projectId + '/storyboards', { query }),
    getProgress:  (ids)       => request('GET', '/storyboards/progress', { query: { ids: ids.join(',') } }),
    getStoryboard:(id)        => request('GET', '/storyboards/' + id),
    createStoryboard: (body)  => request('POST', '/storyboards', { body }),
    patchStoryboard: (id, body) => request('PATCH', '/storyboards/' + id, { body }),
    batchDuration:(ids, durationSec) => request('POST', '/storyboards/batch-duration', { body: { ids, durationSec } }),
    batchSubmit:  (ids, concurrency) => request('POST', '/storyboards/batch-submit', { body: { ids, concurrency }, idempotencyKey: rid('') }),
    cancel:       (id)        => request('POST', '/storyboards/' + id + '/cancel', { body: {} }),
    retry:        (id)        => request('POST', '/storyboards/' + id + '/retry', { body: { resetProgress: true } }),
    batchDelete:  (ids, force) => request('POST', '/storyboards/batch-delete', { body: { ids, force: !!force } }),
    reorder:      (id, direction) => request('POST', '/storyboards/' + id + '/reorder', { body: { direction } }),

    listAssets:   (query)     => request('GET', '/assets', { query }),
    bindAsset:    (id, assetId, role) => request('POST', '/storyboards/' + id + '/assets', { body: { assetId, role } }),
    unbindAsset:  (id, assetId) => request('DELETE', '/storyboards/' + id + '/assets/' + assetId),

    importPreview:(rawText, delimiter) => request('POST', '/storyboards/import/preview', { body: { rawText, delimiter, trimEmpty: true, dedupe: true } }),
    importConfirm:(rawText, delimiter, defaults) => request('POST', '/storyboards/import', { body: { rawText, delimiter, defaults, insertPosition: 'top' }, idempotencyKey: rid('') }),

    getSettings:  ()          => request('GET', '/settings'),
    putSettings:  (s)         => request('PUT', '/settings', { body: s }),
    resetSettings:(scopes)    => request('POST', '/settings/reset', { body: { scopes } })
  };

  global.Api = api;
})(window);
