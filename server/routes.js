'use strict';
/* ============================================================
   routes.js —— /api/v1 路由表

   多项目架构（2026-09-19）后的两条结构性约定：

   1. **作用域来自请求，不来自全局**（指令 §3.4 / §34）。
      每个 handler 通过 scopeOf(ctx, …) 解析作用域，而作用域只可能来自三处：
        · 路径里的 /projects/:id 或 /workspaces/:id
        · 查询串里的 projectId / workspaceId
        · 都没有 → 旧式扁平请求，落到迁移创建的旧项目（**兼容路径**，
          它由数据决定，不是可变全局变量）
      本文件**不存在** currentProjectId 之类的模块级状态。

   2. **父子关系必须校验**（指令 §31）。
      带 /projects/A/workspaces/B 这种组合时，若 B.projectId !== A 则直接 404，
      不返回任何数据。校验在 projects.resolveScope 里统一做。

   旧路径全部保留（/storyboards/*、/assets/*、/records/*），因此这是**向后兼容**的
   MINOR 升级，而不是破坏性变更。
   ============================================================ */
const store = require('./store');
const S = require('./services');
const P = require('./projects');
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

/* 从路径里抓作用域前缀。
   ⚠ 顺序：先 workspaces 再 projects —— /workspaces/:id 不含项目段，
     但 /projects/:id/... 里可能还带 /workspaces/:id（本文件不生成这种路径，
     这里只是防御性解析）。 */
function scopeIdsOf(pathname, query) {
  const out = { projectId: null, workspaceId: null };
  const mw = /^\/workspaces\/([^/]+)(?:\/|$)/.exec(pathname);
  if (mw) out.workspaceId = decodeURIComponent(mw[1]);
  const mp = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (mp) out.projectId = decodeURIComponent(mp[1]);
  /* 查询串兜底：旧式扁平路径可以显式带 projectId/workspaceId。
     ⚠ 这正是"后端按 projectId 查询"的入口（指令 §29）——
     前端原来就在传 projectId，只是升级前后端把它丢掉了。 */
  if (!out.projectId && query && query.projectId) out.projectId = String(query.projectId);
  if (!out.workspaceId && query && query.workspaceId) out.workspaceId = String(query.workspaceId);
  return out;
}

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

  /* 作用域解析的唯一入口（handler 用它，而不是自己拼 projectId/workspaceId）。 */
  function scopeOf(ctx, opts) {
    const o = opts || {};
    return o.workspace
      ? P.requireWorkspaceScope(ctx.db, ctx.scopeIds)
      : P.resolveScope(ctx.db, ctx.scopeIds);
  }

  /* 幂等包装：同一 Idempotency-Key 只真正执行一次，第二次直接回放第一次的响应。

     ⚠ 键里必须带上**作用域**（2026-09-19 多项目升级修复的漏洞）：
     原实现直接拿客户端 header 当键，键里没有项目/路径身份 —— 同一把 key 打到
     另一个项目会回放第一个项目的响应，属于跨项目串线。现在键 = 路径 + 作用域 + 客户端键。
     （客户端那把 key 在 app/api.js 里是"提交内容 + 2 秒时间桶"，本身已能吸收连点。） */
  function withIdempotency(ctx, pathname, run) {
    const clientKey = ctx.req.headers['idempotency-key'];
    if (!clientKey) return Promise.resolve(run());
    const s = ctx.scopeIds || {};
    const key = [pathname, s.projectId || '', s.workspaceId || '', clientKey].join('\u0000');
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
    ['GET', /^\/meta\/options$/, async (ctx) => ok(ctx.res, await S.getOptions(ctx.db, adapter, scopeOf(ctx)))],
    ['GET', /^\/auth\/me$/, async (ctx) => ok(ctx.res, { userId: 'u_1', name: '本地用户', credits: null, plan: 'local' })],
    ['GET', /^\/system\/adapter$/, async (ctx) => ok(ctx.res, await S.adapterStatus(ctx.db, adapter, true))],   // fast：优先回缓存，后台刷新
    /* 创作 CLI 的安装 / 更新（走官方 CDN，见 services.cliStatus / cliInstall）。
       install 是长请求：要下 ~30 MB，慢网下可能几十秒 —— 前端必须给加载态，
       不能让用户以为按钮没反应（实测本机 2.2 秒，但那不是普遍情况）。 */
    ['GET', /^\/system\/cli$/, async (ctx) => ok(ctx.res, await S.cliStatus(adapter))],
    ['POST', /^\/system\/cli\/install$/, async (ctx) => ok(ctx.res, await S.cliInstall(adapter))],
    // CLI 账户操作（长耗时：check 秒级；登录/切换含轮询等待，受 loginTimeoutMs 约束）
    // 画布 CLI 已移除，故不再有 /system/adapter/login 与 /switch 两个画布专用入口。
    ['POST', /^\/system\/adapter\/check$/, async (ctx) => ok(ctx.res, await S.adapterCheck(ctx.db, adapter))],
    // 创作 CLI（dreamina）的登录 / 切换账号（切换会先退出当前账号，界面需二次确认）
    ['POST', /^\/system\/adapter\/dreamina\/login$/, async (ctx) => ok(ctx.res, await S.adapterDreaminaLogin(ctx.db, adapter, ctx.cfg))],
    ['POST', /^\/system\/adapter\/dreamina\/switch$/, async (ctx) => ok(ctx.res, await S.adapterDreaminaSwitch(ctx.db, adapter, ctx.cfg))],

    /* ---------------- Project / Workspace（多项目架构新增） ----------------
       ⚠ 顺序要求：/projects/:id/workspaces 必须排在 /projects/:id 之前吗？
       不必 —— 后者的正则带 `$`，不会误吃带子路径的请求。但为可读性仍按"深路径在前"排。 */
    ['GET', /^\/projects$/, async (ctx) => ok(ctx.res, P.listProjects(ctx.db))],
    ['POST', /^\/projects$/, async (ctx) => ok(ctx.res, P.createProject(ctx.db, ctx.body))],
    ['GET', /^\/projects\/([^/]+)\/workspaces$/, async (ctx) => ok(ctx.res, P.listWorkspaces(ctx.db, ctx.params[0]))],
    ['POST', /^\/projects\/([^/]+)\/workspaces$/, async (ctx) => ok(ctx.res, P.createWorkspace(ctx.db, ctx.params[0], ctx.body))],
    /* 彻底删除的**预检**（2026-09-21，清单 §13）：只统计、不修改任何东西。
       为什么单独给一个 GET：硬删除的确认弹窗必须展示"要删掉什么"
       （分镜表/分镜/素材/记录数、视频数、磁盘占用），而那些数字原先只在
       删除**成功后的返回值**里 —— 用户是在看不到后果的情况下按确认的。
       幂等、只读，所以用 GET；不影响任何既有路由（带子路径，排在 /projects/:id 之前）。 */
    ['GET', /^\/projects\/([^/]+)\/hard-delete-preview$/, async (ctx) => ok(ctx.res, P.hardDeletePreview(ctx.db, ctx.params[0]))],
    ['GET', /^\/projects\/([^/]+)$/, async (ctx) => ok(ctx.res, P.getProject(ctx.db, ctx.params[0]))],
    ['PATCH', /^\/projects\/([^/]+)$/, async (ctx) => ok(ctx.res, P.patchProject(ctx.db, ctx.params[0], ctx.body))],
    /* 删除项目。默认**软删除**（指令 §44/§45：只标 deletedAt，不做级联物理销毁）；
       带 `?hard=1` 时**彻底删除** —— 连磁盘文件、分镜、素材、生成记录一起抹掉，不可恢复。
       两条路都受"有活动任务则拒绝"的保护（见 projects.js）。 */
    ['DELETE', /^\/projects\/([^/]+)$/, async (ctx) => {
      const hard = ctx.query.hard === '1' || ctx.query.hard === 'true';
      return ok(ctx.res, hard ? P.hardDeleteProject(ctx.db, ctx.params[0]) : P.deleteProject(ctx.db, ctx.params[0]));
    }],
    ['GET', /^\/workspaces\/([^/]+)$/, async (ctx) => ok(ctx.res, P.getWorkspace(ctx.db, ctx.params[0]))],
    ['PATCH', /^\/workspaces\/([^/]+)$/, async (ctx) => ok(ctx.res, P.patchWorkspace(ctx.db, ctx.params[0], ctx.body))],
    ['DELETE', /^\/workspaces\/([^/]+)$/, async (ctx) => ok(ctx.res, P.deleteWorkspace(ctx.db, ctx.params[0]))],

    /* 生成记录：追加式快照（成功/失败/取消/干跑各一条），分镜被删也不影响
       ⚠ 顺序要求：/records/export 与 /records/clear 必须排在 /records/{id} 之前，否则会被当成 id */
    ['GET', /^\/records$/, async (ctx) => ok(ctx.res, S.listRecords(ctx.db, ctx.query, scopeOf(ctx)))],
    ['GET', /^\/records\/export$/, async (ctx) => ok(ctx.res, S.exportRecords(ctx.db, ctx.query, ctx.query.format, scopeOf(ctx)))],
    ['POST', /^\/records\/clear$/, async (ctx) => ok(ctx.res, S.clearRecords(ctx.db, ctx.body, scopeOf(ctx)))],
    ['GET', /^\/records\/([^/]+)$/, async (ctx) => ok(ctx.res, S.getRecordDetail(ctx.db, ctx.params[0], scopeOf(ctx)))],
    ['DELETE', /^\/records\/([^/]+)$/, async (ctx) => ok(ctx.res, S.deleteRecord(ctx.db, ctx.params[0], scopeOf(ctx)))],

    /* 设置：delimiter / defaults 属项目级，queue 属系统级（指令 §15）。
       返回的是"项目生效值"（项目覆盖 ⊕ 全局默认），未改动的前端读到的形状不变。 */
    ['GET', /^\/settings$/, async (ctx) => ok(ctx.res, S.getSettings(ctx.db, scopeOf(ctx)))],
    ['PUT', /^\/settings$/, async (ctx) => ok(ctx.res, await S.putSettings(ctx.db, ctx.body, adapter, scopeOf(ctx)))],
    ['POST', /^\/settings\/reset$/, async (ctx) => ok(ctx.res, S.resetSettings(ctx.db, ctx.body, scopeOf(ctx)))],

    /* 分镜列表。三种路径形态共用同一个 handler（作用域由路径/查询串解析）：
         /workspaces/:id/storyboards   推荐（工作区作用域，指令 §30）
         /projects/:id/storyboards     项目作用域 → 落到该项目的默认工作区（兼容）
         /storyboards                  旧式扁平路径（兼容）
       未给工作区时落到项目的 defaultWorkspaceId，因此升级前的前端调用方式继续可用。 */
    ['GET', /^\/(?:projects\/[^/]+\/)?storyboards$/, async (ctx) => ok(ctx.res, S.listStoryboards(ctx.db, ctx.query, scopeOf(ctx, { workspace: true })))],
    ['GET', /^\/workspaces\/([^/]+)\/storyboards$/, async (ctx) => ok(ctx.res, S.listStoryboards(ctx.db, ctx.query, scopeOf(ctx, { workspace: true })))],
    ['POST', /^\/workspaces\/([^/]+)\/storyboards$/, async (ctx) => ok(ctx.res, S.createStoryboard(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],
    ['GET', /^\/storyboards\/progress$/, async (ctx) => ok(ctx.res, S.getProgress(ctx.db, ctx.query.ids, scopeOf(ctx, { workspace: true })))],

    // 批量（先于 /storyboards/{id} 匹配）
    ['POST', /^\/storyboards\/batch-duration$/, async (ctx) => ok(ctx.res, S.batchDuration(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],
    ['POST', /^\/storyboards\/batch-submit$/, async (ctx) => ok(ctx.res, await withIdempotency(ctx, '/storyboards/batch-submit', () => S.batchSubmit(ctx.db, ctx.body, adapter, ctx.cfg, scopeOf(ctx, { workspace: true }))))],
    ['POST', /^\/storyboards\/batch-delete$/, async (ctx) => ok(ctx.res, S.batchDelete(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],
    // 自动匹配参考图（只按素材名；apply=false 时仅预览不写库）
    ['POST', /^\/storyboards\/auto-assets$/, async (ctx) => ok(ctx.res, S.autoMatchAssets(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],
    // 按提示词里的「总时长」标注重算时长（向上进位；apply=false 时仅预览）
    ['POST', /^\/storyboards\/auto-duration$/, async (ctx) => ok(ctx.res, S.autoDuration(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],

    // 导入（先于 /storyboards/{id}）
    ['POST', /^\/storyboards\/import\/preview$/, async (ctx) => ok(ctx.res, S.importPreview(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],
    // 与 batch-submit 共用同一套幂等实现（键里含作用域，见 withIdempotency）
    ['POST', /^\/storyboards\/import$/, async (ctx) => ok(ctx.res, await withIdempotency(ctx, '/storyboards/import', () => S.importConfirm(ctx.db, ctx.body, scopeOf(ctx, { workspace: true }))))],

    // 单条 CRUD 与行操作
    ['POST', /^\/storyboards$/, async (ctx) => ok(ctx.res, S.createStoryboard(ctx.db, ctx.body, scopeOf(ctx, { workspace: true })))],
    ['GET', /^\/storyboards\/([^/]+)$/, async (ctx) => ok(ctx.res, S.getStoryboard(ctx.db, ctx.params[0], ctx.cfg, scopeOf(ctx, { workspace: true })))],
    ['PATCH', /^\/storyboards\/([^/]+)$/, async (ctx) => ok(ctx.res, S.patchStoryboard(ctx.db, ctx.params[0], ctx.body, scopeOf(ctx, { workspace: true })))],
    // 干跑校验：返回将执行的完整命令（可选让 CLI 本地校验），不改任务状态
    ['POST', /^\/storyboards\/([^/]+)\/dry-run$/, async (ctx) => ok(ctx.res, await S.dryRunStoryboard(ctx.db, ctx.params[0], adapter, {}, scopeOf(ctx, { workspace: true })))],
    ['POST', /^\/storyboards\/([^/]+)\/(cancel|retry|reorder)$/, async (ctx) => {
      const op = ctx.params[1];
      const scope = scopeOf(ctx, { workspace: true });
      if (op === 'cancel') return ok(ctx.res, S.cancel(ctx.db, ctx.params[0], scope));
      if (op === 'retry') return ok(ctx.res, S.retry(ctx.db, ctx.params[0], scope));
      return ok(ctx.res, S.reorder(ctx.db, ctx.params[0], ctx.body, scope));
    }],
    ['POST', /^\/storyboards\/([^/]+)\/assets$/, async (ctx) => ok(ctx.res, S.bindAsset(ctx.db, ctx.params[0], ctx.body, scopeOf(ctx, { workspace: true })))],
    ['DELETE', /^\/storyboards\/([^/]+)\/assets\/([^/]+)$/, async (ctx) => ok(ctx.res, S.unbindAsset(ctx.db, ctx.params[0], ctx.params[1], scopeOf(ctx, { workspace: true })))],

    /* 素材：属于 **Project**（指令 §3.3）。
       项目级路径 /projects/:id/assets 与旧式 /assets（+ ?projectId=）都支持；
       同一项目的所有工作区共享同一份素材库。 */
    ['GET', /^\/projects\/([^/]+)\/assets$/, async (ctx) => ok(ctx.res, S.listAssets(ctx.db, ctx.query, scopeOf(ctx)))],
    ['GET', /^\/assets$/, async (ctx) => ok(ctx.res, S.listAssets(ctx.db, ctx.query, scopeOf(ctx)))],
    // 新建素材：只建元数据（名称 + 类型 + 可选提示词），文件之后由 /assets/:id/file 补
    ['POST', /^\/assets$/, async (ctx) => ok(ctx.res, S.createAssetMeta(ctx.db, ctx.body, scopeOf(ctx)))],
    // 创建 / 批量导入素材：原始字节上传（query: type + name，素材名默认取文件名去扩展名）
    ['POST', /^\/assets\/upload$/, async (ctx) => ok(ctx.res, await S.createAsset(ctx.db, {
      type: ctx.query.type,
      filename: ctx.query.name,
      mime: ctx.req.headers['content-type'] || '',
      buffer: ctx.body,
      durationSec: ctx.query.durationSec      // 音频时长（前端读到的；缺失则服务端 ffprobe 兜底）
    }, scopeOf(ctx)))],
    // 素材设置：重命名
    ['PATCH', /^\/assets\/([^/]+)$/, async (ctx) => ok(ctx.res, S.updateAsset(ctx.db, ctx.params[0], ctx.body, scopeOf(ctx)))],
    // 素材被哪些分镜引用（项目级）。改类型前用它给出准确的"N 条分镜"，而不是靠前端猜。
    // ⚠ 必须排在 /assets/:id 这类通配之前吗？不必 —— 那条是 PATCH/DELETE，这里是 GET，方法不同。
    ['GET', /^\/assets\/([^/]+)\/usage$/, async (ctx) => ok(ctx.res, S.assetUsage(ctx.db, ctx.params[0], scopeOf(ctx)))],
    // 素材设置：更换文件（原始字节；query: filename 用于扩展名校验与取名，name 为展示名覆盖）
    ['POST', /^\/assets\/([^/]+)\/file$/, async (ctx) => ok(ctx.res, await S.replaceAsset(ctx.db, ctx.params[0], {
      filename: ctx.query.filename,
      name: ctx.query.name,
      mime: ctx.req.headers['content-type'] || '',
      buffer: ctx.body,
      durationSec: ctx.query.durationSec
    }, scopeOf(ctx)))],
    // 提示词文本导入资产：@ 分段 → 自动识别 场景/道具/角色 → apply=false 预览 / true 落库
    ['POST', /^\/assets\/import-prompts$/, async (ctx) => ok(ctx.res, S.importAssetPrompts(ctx.db, ctx.body, scopeOf(ctx)))],
    ['DELETE', /^\/assets\/([^/]+)$/, async (ctx) => ok(ctx.res, S.deleteAsset(ctx.db, ctx.params[0], scopeOf(ctx)))]
  ];

  return async function dispatch(req, res, pathname) {
    const db = store.load();
    const query = queryOf(req.url);
    const scopeIds = scopeIdsOf(pathname, query);
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = pathname.match(re);
      if (!m) continue;
      const ctx = {
        req, res, db, cfg, query, scopeIds,
        params: m.slice(1),
        body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req, cfg.uploadMaxBytes) : {}
      };
      return handler(ctx);
    }
    throw new ApiError(ERR.NOTFOUND, '接口不存在：' + req.method + ' ' + pathname);
  };
}

module.exports = { makeRouter, queryOf, scopeIdsOf };
