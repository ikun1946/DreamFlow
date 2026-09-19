'use strict';
/* ============================================================
   routes.js —— /api/v1 路由表（23 个接口 + 幂等）
   路径、请求体、响应信封与 docs/前端页面与接口对接说明.md 一致。
   ============================================================ */
const store = require('./store');
const S = require('./services');
const { ERR, ApiError, ok, readBody, nowIso } = require('./util');

function queryOf(url) {
  const q = {};
  const i = url.indexOf('?');
  if (i < 0) return q;
  for (const kv of url.slice(i + 1).split('&')) {
    if (!kv) continue;
    const [k, v] = kv.split('=');
    q[decodeURIComponent(k)] = decodeURIComponent((v || '').replace(/\+/g, ' '));
  }
  return q;
}

/* 幂等记录 TTL：默认 24 小时（可用 server/config.json 的 idempotencyTtlMs 调整）。
   过期即清，避免 db.idempotency 无限膨胀 —— 它随每次提交增长，而提交是高频动作。 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function makeRouter(cfg, adapter) {
  const idemTtl = Number(cfg.idempotencyTtlMs) > 0 ? Number(cfg.idempotencyTtlMs) : IDEMPOTENCY_TTL_MS;

  function pruneIdempotency(db) {
    const m = db.idempotency || (db.idempotency = {});
    const cut = Date.now() - idemTtl;
    Object.keys(m).forEach((k) => {
      const at = Date.parse((m[k] && m[k].createdAt) || '') || 0;
      if (at && at < cut) delete m[k];
    });
  }

  /* 幂等包装：同一 Idempotency-Key 只真正执行一次，第二次直接回放第一次的响应。
     ⚠ 为什么给 batch-submit 补上（2026-09-19 修复）：前端一直在发这个头，
     但后端只在 /storyboards/import 上处理了 —— 而 batch-submit 才是**真正花钱**的那个：
     重复投递（连点、网络重发、代理重放）会重复生成、重复扣费。 */
  function withIdempotency(ctx, run) {
    const key = ctx.req.headers['idempotency-key'];
    if (!key) return Promise.resolve(run());
    pruneIdempotency(ctx.db);
    const hit = ctx.db.idempotency[key];
    if (hit) return Promise.resolve(hit.response);
    return Promise.resolve(run()).then((data) => {
      ctx.db.idempotency[key] = { response: data, createdAt: nowIso() };
      store.save();
      return data;
    });
  }

  // routes: [method, regex, handler(ctx)]
  const routes = [
    ['GET', /^\/meta\/options$/, async (ctx) => ok(ctx.res, await S.getOptions(ctx.db, adapter))],
    ['GET', /^\/auth\/me$/, async (ctx) => ok(ctx.res, { userId: 'u_1', name: '本地用户', credits: null, plan: 'local' })],
    ['GET', /^\/system\/adapter$/, async (ctx) => ok(ctx.res, await S.adapterStatus(ctx.db, adapter, true))],   // fast：优先回缓存，后台刷新
    // CLI 账户操作（长耗时：check 秒级；登录/切换含轮询等待，受 loginTimeoutMs 约束）
    // 画布 CLI 已移除，故不再有 /system/adapter/login 与 /switch 两个画布专用入口。
    ['POST', /^\/system\/adapter\/check$/, async (ctx) => ok(ctx.res, await S.adapterCheck(ctx.db, adapter))],
    // 创作 CLI（dreamina）的登录 / 切换账号（切换会先退出当前账号，界面需二次确认）
    ['POST', /^\/system\/adapter\/dreamina\/login$/, async (ctx) => ok(ctx.res, await S.adapterDreaminaLogin(ctx.db, adapter, ctx.cfg))],
    ['POST', /^\/system\/adapter\/dreamina\/switch$/, async (ctx) => ok(ctx.res, await S.adapterDreaminaSwitch(ctx.db, adapter, ctx.cfg))],

    /* 生成记录：追加式快照（成功/失败/取消/干跑各一条），分镜被删也不影响
       ⚠ 顺序要求：/records/export 与 /records/clear 必须排在 /records/{id} 之前，否则会被当成 id */
    ['GET', /^\/records$/, async (ctx) => ok(ctx.res, S.listRecords(ctx.db, ctx.query))],
    ['GET', /^\/records\/export$/, async (ctx) => ok(ctx.res, S.exportRecords(ctx.db, ctx.query, ctx.query.format))],
    ['POST', /^\/records\/clear$/, async (ctx) => ok(ctx.res, S.clearRecords(ctx.db, ctx.body))],
    ['GET', /^\/records\/([^/]+)$/, async (ctx) => ok(ctx.res, S.getRecordDetail(ctx.db, ctx.params[0]))],
    ['DELETE', /^\/records\/([^/]+)$/, async (ctx) => ok(ctx.res, S.deleteRecord(ctx.db, ctx.params[0]))],

    ['GET', /^\/settings$/, async (ctx) => ok(ctx.res, S.getSettings(ctx.db))],
    ['PUT', /^\/settings$/, async (ctx) => ok(ctx.res, await S.putSettings(ctx.db, ctx.body, adapter))],
    ['POST', /^\/settings\/reset$/, async (ctx) => ok(ctx.res, S.resetSettings(ctx.db, ctx.body))],

    // 列表（兼容两种路径，mock 也这么做了）
    ['GET', /^\/(?:projects\/[^/]+\/)?storyboards$/, async (ctx) => ok(ctx.res, S.listStoryboards(ctx.db, ctx.query, ctx.cfg.projectId))],
    ['GET', /^\/storyboards\/progress$/, async (ctx) => ok(ctx.res, S.getProgress(ctx.db, ctx.query.ids))],

    // 批量（先于 /storyboards/{id} 匹配）
    ['POST', /^\/storyboards\/batch-duration$/, async (ctx) => ok(ctx.res, S.batchDuration(ctx.db, ctx.body))],
    ['POST', /^\/storyboards\/batch-submit$/, async (ctx) => ok(ctx.res, await withIdempotency(ctx, () => S.batchSubmit(ctx.db, ctx.body, adapter, ctx.cfg)))],
    ['POST', /^\/storyboards\/batch-delete$/, async (ctx) => ok(ctx.res, S.batchDelete(ctx.db, ctx.body))],
    // 自动匹配参考图（只按素材名；apply=false 时仅预览不写库）
    ['POST', /^\/storyboards\/auto-assets$/, async (ctx) => ok(ctx.res, S.autoMatchAssets(ctx.db, ctx.body))],
    // 按提示词里的「总时长」标注重算时长（向上进位；apply=false 时仅预览）
    ['POST', /^\/storyboards\/auto-duration$/, async (ctx) => ok(ctx.res, S.autoDuration(ctx.db, ctx.body))],

    // 导入（先于 /storyboards/{id}）
    ['POST', /^\/storyboards\/import\/preview$/, async (ctx) => ok(ctx.res, S.importPreview(ctx.db, ctx.body))],
    // 与 batch-submit 共用同一套幂等实现（原先是就地内联的一份，行为一致，只是补上了 TTL 清理）
    ['POST', /^\/storyboards\/import$/, async (ctx) => ok(ctx.res, await withIdempotency(ctx, () => S.importConfirm(ctx.db, ctx.body)))],

    // 单条 CRUD 与行操作
    ['POST', /^\/storyboards$/, async (ctx) => ok(ctx.res, S.createStoryboard(ctx.db, ctx.body))],
    ['GET', /^\/storyboards\/([^/]+)$/, async (ctx) => ok(ctx.res, S.getStoryboard(ctx.db, ctx.params[0], ctx.cfg))],
    ['PATCH', /^\/storyboards\/([^/]+)$/, async (ctx) => ok(ctx.res, S.patchStoryboard(ctx.db, ctx.params[0], ctx.body))],
    // 干跑校验：返回将执行的完整命令（可选让 CLI 本地校验），不改任务状态
    ['POST', /^\/storyboards\/([^/]+)\/dry-run$/, async (ctx) => ok(ctx.res, await S.dryRunStoryboard(ctx.db, ctx.params[0], adapter, {}))],
    ['POST', /^\/storyboards\/([^/]+)\/(cancel|retry|reorder)$/, async (ctx) => {
      const op = ctx.params[1];
      if (op === 'cancel') return ok(ctx.res, S.cancel(ctx.db, ctx.params[0]));
      if (op === 'retry') return ok(ctx.res, S.retry(ctx.db, ctx.params[0]));
      return ok(ctx.res, S.reorder(ctx.db, ctx.params[0], ctx.body));
    }],
    ['POST', /^\/storyboards\/([^/]+)\/assets$/, async (ctx) => ok(ctx.res, S.bindAsset(ctx.db, ctx.params[0], ctx.body))],
    ['DELETE', /^\/storyboards\/([^/]+)\/assets\/([^/]+)$/, async (ctx) => ok(ctx.res, S.unbindAsset(ctx.db, ctx.params[0], ctx.params[1]))],

    // 素材
    ['GET', /^\/assets$/, async (ctx) => ok(ctx.res, S.listAssets(ctx.db, ctx.query))],
    // 创建 / 批量导入素材：原始字节上传（query: type + name，素材名默认取文件名去扩展名）
    ['POST', /^\/assets\/upload$/, async (ctx) => ok(ctx.res, S.createAsset(ctx.db, {
      type: ctx.query.type,
      filename: ctx.query.name,
      mime: ctx.req.headers['content-type'] || '',
      buffer: ctx.body
    }))],
    // 素材设置：重命名
    ['PATCH', /^\/assets\/([^/]+)$/, async (ctx) => ok(ctx.res, S.updateAsset(ctx.db, ctx.params[0], ctx.body))],
    // 素材设置：更换文件（原始字节；query: filename 用于扩展名校验与取名，name 为展示名覆盖）
    ['POST', /^\/assets\/([^/]+)\/file$/, async (ctx) => ok(ctx.res, S.replaceAsset(ctx.db, ctx.params[0], {
      filename: ctx.query.filename,
      name: ctx.query.name,
      mime: ctx.req.headers['content-type'] || '',
      buffer: ctx.body
    }))],
    // 提示词文本导入资产：@ 分段 → 自动识别 场景/道具/角色 → apply=false 预览 / true 落库
    ['POST', /^\/assets\/import-prompts$/, async (ctx) => ok(ctx.res, S.importAssetPrompts(ctx.db, ctx.body))],
    ['DELETE', /^\/assets\/([^/]+)$/, async (ctx) => ok(ctx.res, S.deleteAsset(ctx.db, ctx.params[0]))]
  ];

  return async function dispatch(req, res, pathname) {
    const db = store.load();
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = pathname.match(re);
      if (!m) continue;
      const ctx = {
        req, res, db, cfg,
        params: m.slice(1),
        query: queryOf(req.url),
        body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, cfg.uploadMaxBytes) : {}
      };
      return handler(ctx);
    }
    throw new ApiError(ERR.NOTFOUND, '接口不存在：' + req.method + ' ' + pathname);
  };
}

module.exports = { makeRouter, queryOf };
