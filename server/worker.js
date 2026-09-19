'use strict';
/* ============================================================
   worker.js —— 创作 CLI 的派发与队列 worker
   （原 server/cli.js 的 worker 部分。2026-09-18 画布 CLI 彻底移除时拆分而来：
    画布 CLI 的适配层、参数组装、模型目录、OAuth 登录流程全部随之删除。）

   职责（全部只围绕创作 CLI / dreamina）：
   - tick(db, onDirty)            队列调度：并发闸 + 只派发 queued
   - runOne / runViaDreamina      单条任务的派发、落库与收尾
   - mapTaskError                 失败分类 + 自动重试 + 生成记录
   - finishDryRun                 干跑收尾（不 spawn、不扣费）
   - planFor                      干跑/核对用的完整命令预览（唯一出口）
   - resolveMaxConcurrency        并发上限（本地保护上限）
   - reconcileOrphans             启动期孤儿清理

   ⚠ 唯一事实来源：模型名称与能力一律取自 ./models，禁止在此硬编码。
   ⚠ 禁止再引入任何「另一个引擎」的概念 —— 本项目只有创作 CLI。
   ============================================================ */
const crypto = require('crypto');
const path = require('path');
const { ERR, nowIso } = require('./util');
const { OUTPUT_DIR } = require('./config');
const store = require('./store');
const models = require('./models');   // 模型注册表：名称归一/能力边界/路由的唯一事实来源
const TS = require('./task-state');   // 任务状态迁移与写入权限的唯一事实来源
const AL = require('./asset-lock');   // 素材锁定签名（干跑记录带指纹，用于判断记录是否过期）
const REC = require('./records');     // 生成记录：成功/失败/取消/干跑各落一条快照（落盘失败不影响任务）
const P = require('./projects');      // 项目/工作区归属（任务上下文与软删守卫）

function makeWorker(cfg, deps) {
  deps = deps || {};
  const state = {
    running: new Map()   // storyboardId -> { startedAt, submitId }
  };

  /* 本次任务绑定的音频（曾经决定"能否走画布"，现在只写进日志/路由理由里便于排查） */
  const hasAudioBound = (sb) => (sb.assets || []).some((r) => r.role === 'audio');

  /* ---------------- 写入守卫（2026-09-19 修复的核心） ----------------
     每次派发在 `runOne` 入口抓一份 attemptId，此后所有写入都要先过这道闸。
     三种情况一律拒绝写入，避免出现"取消后复活 / 幽灵记录 / 旧轮覆盖新轮"：

       deleted        分镜已被删除（强制删除 / 批量删除）——
                      继续写会把 logs / cliJobs 条目重新建回来，产生幽灵数据
       stale-attempt  attemptId 已变（cancel 清空 / retry 换新 / 重新提交）——
                      旧一轮的迟到结果不能覆盖新一轮
       illegal       状态机不允许的迁移（如 canceled → succeeded）

     注意：被拒时**不能**再往这个分镜的日志里写（那正是幽灵数据本身），
     要留痕就写系统日志。 */
  function guard(db, sb, attemptId, to) {
    if (!(db.storyboards || []).some((x) => x.id === sb.id)) return { ok: false, reason: 'deleted' };
    /* 工作区被软删 → 这次派发已失去父对象，不得继续写入（指令 §48：不能让 Worker 失去父对象）。
       注意分镜**本身还在库里**，所以上面那条存在性检查拦不住它 —— 必须单独判一次。 */
    if (sb.workspaceId && !P.workspaceOf(db, sb.workspaceId)) return { ok: false, reason: 'workspace-deleted' };
    if (attemptId && !TS.ownsAttempt(sb, attemptId)) return { ok: false, reason: 'stale-attempt' };
    if (!TS.canTransition(sb.status, to)) return { ok: false, reason: 'illegal:' + sb.status + '→' + to };
    return { ok: true };
  }

  /* 本次任务的项目/工作区上下文，供 cliJobs 落库与审计（指令 §14）。
     权威归属取自工作区；工作区缺失时退回分镜上的冗余 projectId。 */
  function jobContext(db, sb) {
    const ws = sb.workspaceId ? P.workspaceOf(db, sb.workspaceId) : null;
    return {
      projectId: (ws && ws.projectId) || sb.projectId || null,
      workspaceId: (ws && ws.id) || sb.workspaceId || null
    };
  }

  /* 被拒后的统一留痕：被删的写系统日志，其余写该分镜日志（此时它还在库里） */
  function noteRejected(db, sb, attemptId, what, why) {
    const msg = '【已丢弃】' + what + '：本轮已失效（' + why + '）' +
      (attemptId ? '　attempt=' + attemptId : '') + '　—— 未写入该分镜（避免覆盖新状态或产生幽灵数据）';
    if (why === 'deleted') store.pushLog('system', 'warn', msg + '　storyboard=' + sb.id);
    else store.pushLog(sb.id, 'warn', msg);
  }

  async function tick(db, onDirty) {
    // 空闲快速路径：没有排队/运行中的任务时直接返回——避免周期性白起 CLI 进程
    const hasQueued = db.storyboards.some((s) => s.status === 'queued');
    if (!hasQueued && state.running.size === 0) return;
    const D = deps.dreamina;
    if (!D) return;
    /* 探测有 5 分钟缓存与防重入，不会反复起进程；不可用就把任务留在队列
       （batch-submit 已按 51001 拒绝过新提交）。 */
    const p = await D.probe();
    if (!p || !p.available) return;
    const conc = await resolveMaxConcurrency();

    const runningCount = db.storyboards.filter((s) => s.status === 'generating' && state.running.has(s.id)).length;
    // 并发闸 = 用户设置；仅当配置了本地保护上限（>0）时才做上限钳制
    const userConc = Math.max(1, db.settings.queue.concurrency);
    const effConc = conc.max > 0 ? Math.min(userConc, conc.max) : userConc;
    const slots = effConc - runningCount;
    if (slots <= 0) return;

    const queued = db.storyboards.filter((s) => s.status === TS.STATUS.QUEUED).sort((a, b) => a.seq - b.seq);
    for (const sb of queued.slice(0, slots)) {
      // 占位防重复派发；attemptId 一并记下，便于排查"哪一轮在跑"
      state.running.set(sb.id, { startedAt: Date.now(), submitId: null, attemptId: sb.attemptId || null });
      runOne(db, sb, onDirty).catch((e) => console.error('[worker] 异常', e));
    }
  }

  /* extra（可选）:{ engine, command, argv, mode, cliModel, submitId } —— 把"本次实际用的命令"
     带进记录，否则只能按路由规则推演（CLI 不可用时推演结果未必等于真实意图） */
  function mapTaskError(db, sb, code, message, requestId, extra, attemptId) {
    const g = guard(db, sb, attemptId, TS.STATUS.FAILED);
    if (!g.ok) { noteRejected(db, sb, attemptId, '失败收尾（' + code + '）', g.reason); return; }
    sb.status = TS.STATUS.FAILED;
    sb.errorCode = code;
    sb.errorMessage = message + (requestId ? '（requestId: ' + requestId + '）' : '');
    sb.finishedAt = nowIso();
    sb.dirty = true;
    store.pushLog(sb.id, 'error', sb.errorCode + ' ' + sb.errorMessage);
    if (db.settings.queue.autoRetry && ['51004', '51005'].includes(String(code))) {
      if (sb.retryCount < db.settings.queue.maxRetry) {
        sb.status = TS.STATUS.QUEUED; sb.progress = 0; sb.errorCode = null; sb.errorMessage = null;
        sb.retryCount++; sb.dirty = true;
        /* 自动重试也要换 attempt：否则上一轮的迟到回调仍持有旧 attemptId，
           而这里已经把状态改回 queued —— 新派发会用新 attempt，旧的必须失效。 */
        sb.attemptId = TS.newAttemptId();
        store.pushLog(sb.id, 'info', '自动重试 ' + sb.retryCount + '/' + db.settings.queue.maxRetry);
      }
    }
    /* 只有"最终失败"才落记录：自动重试把状态改回 queued 时不能记，
       否则一次任务会因为每次重试各留一条失败记录，把记录页刷满噪音。 */
    if (sb.status === 'failed') {
      REC.append(db, sb, Object.assign({ action: 'generate', outcome: 'failed', errorCode: String(code), errorMessage: sb.errorMessage }, extra || {}));
    }
  }

  /* 干跑收尾：不 spawn、不连服务端、不扣费；把将要执行的命令留在任务上（状态回到「未提交」） */
  function finishDryRun(db, sb, onDirty, plan, attemptId) {
    const g = guard(db, sb, attemptId, TS.STATUS.DRAFT);
    if (!g.ok) { noteRejected(db, sb, attemptId, '干跑收尾', g.reason); return; }
    sb.status = TS.STATUS.DRAFT;
    sb.progress = 0; sb.etaSeconds = null; sb.startedAt = null; sb.finishedAt = nowIso();
    sb.errorCode = null; sb.errorMessage = null; sb.canEditDuration = true;
    sb.submitDryRun = false;   // 本批次标记用完即清，避免误伤后续真实提交
    sb.dryRunPlan = Object.assign({
      at: nowIso(), dryRun: true,
      scope: plan.scope || (cfg.dryRun ? 'service' : 'batch'),
      // 指纹：提示词 / 绑定 / 参数任一变化，此记录即过期（前端据此打「已过期」标）
      sig: AL.signature(sb, db),
      note: '未连接即梦服务端、未创建任务、未扣费；命令由后端组装，供核对'
    }, plan);
    sb.dirty = true;
    store.pushLog(sb.id, 'warn', '【干跑】未连接即梦服务端、未派发、未扣费；命令已记录到分镜「干跑记录」供核对');
    store.pushLog(sb.id, 'warn', '将执行：' + plan.command);
    /* 干跑也落一条记录（action=dryrun）：它是"这条命令当时长什么样"的唯一留痕，
       与之后真实生成的成功/失败记录并排看，才能解释"为什么两次命令不一样"。 */
    REC.append(db, sb, {
      action: 'dryrun', outcome: 'previewed',
      engine: 'dreamina', command: plan.command, argv: plan.argv,
      mode: plan.mode, cliModel: plan.model, adapted: plan.adapted,
      missing: plan.missing, refs: plan.refs, submitId: plan.submitId,
      videoUrl: null, coverUrl: null
    });
    store.save();
    onDirty();
  }

  /* 派发单条任务。唯一引擎 = 创作 CLI，故这里不再有引擎分支。 */
  async function runOne(db, sb, onDirty) {
    /* 本轮派发的写入凭证。取自已由 doSubmit / retry 分配的 sb.attemptId；
       历史数据没有这个字段时为 undefined —— 守卫会自动跳过 attempt 检查，
       行为与修复前一致（向后兼容）。 */
    const attemptId = sb.attemptId;
    try {
      const D = deps.dreamina;
      if (!D) {
        mapTaskError(db, sb, String(ERR.CLI_DOWN), '创作 CLI 适配器未加载（请重启服务）', null, null, attemptId);
        return;
      }
      /* 模型可用性前置校验：历史数据里可能存在已下线的名字（原仅画布模型）。
         正常路径下 getOptions 的归一化已把它们迁走，这里兜住"直接调接口写入"的情况。 */
      const dmName = models.dreaminaModelOf(sb.model);
      if (!dmName) {
        mapTaskError(db, sb, String(ERR.PARAM),
          '模型「' + sb.model + '」当前不可用（' +
          (models.isKnown(sb.model) ? '该型号已随画布 CLI 一并下线，创作 CLI 无对应能力' : '不在模型注册表中') +
          '）——请在设置或该分镜上改选一个可用模型', null, null, attemptId);
        return;
      }

      const isDry = cfg.dryRun === true || sb.submitDryRun === true;
      const dryScope = sb.submitDryRun === true ? 'batch' : (cfg.dryRun === true ? 'service' : null);

      /* 派发前最后一道检查：排队期间可能已被取消 / 删除 / 被新一轮取代。
         不查的话会出现"取消之后 worker 照样开跑并写成功"（就是本次修复的主问题）。 */
      const gDispatch = guard(db, sb, attemptId, TS.STATUS.GENERATING);
      if (!gDispatch.ok) { noteRejected(db, sb, attemptId, '派发', gDispatch.reason); return; }

      sb.status = TS.STATUS.GENERATING; sb.progress = 10; sb.startedAt = sb.startedAt || nowIso();
      sb.etaSeconds = sb.durationSec * 3; sb.errorCode = null; sb.errorMessage = null; sb.dirty = true;
      store.pushLog(sb.id, 'info', isDry
        ? '【干跑】开始组装命令（不连接服务端、不派发；来源：' + (dryScope === 'batch' ? '本次提交勾选干跑' : '服务端干跑模式') + '）'
        : '开始派发到创作 CLI');
      onDirty();

      const eng = models.routeEngine({ model: sb.model, hasAudio: hasAudioBound(sb) });
      store.pushLog(sb.id, 'info', '引擎：' + models.engineLabel(eng.engine) + '（' + eng.reason + '）');

      if (isDry) {
        let argv = null, adapted = [];
        try { const b = D.buildSubmitArgs(sb, db); argv = b.args; adapted = b.notes || []; }
        catch (e) { mapTaskError(db, sb, String(e.code || ERR.PARAM), e.message || '创作 CLI 参数校验失败', null, null, attemptId); return; }
        const cmd = (cfg.dreaminaCliPath || 'dreamina') + ' ' + argv.join(' ');
        store.pushLog(sb.id, 'info', 'spawn: ' + cmd);
        finishDryRun(db, sb, onDirty, { engine: 'dreamina', command: cmd, argv, adapted, mode: null, model: dmName, scope: dryScope }, attemptId);
        return;
      }

      await runViaDreamina(db, sb, onDirty, eng.reason, attemptId);
    } catch (e) {
      mapTaskError(db, sb, String(ERR.INTERRUPTED), 'worker 异常：' + (e.message || e), null, null, attemptId);
    } finally {
      state.running.delete(sb.id);
      onDirty();
    }
  }

  async function runViaDreamina(db, sb, onDirty, reason, attemptId) {
    const D = deps.dreamina;
    const hint = { engine: 'dreamina', engineReason: reason };
    const p = await D.probe();
    if (!p.available) { mapTaskError(db, sb, String(ERR.CLI_DOWN), p.message || '创作 CLI 不可用', null, hint, attemptId); return; }

    /* 积分余额提醒 —— 原画布链路有一个「报价→确认」的 creditCeiling 安全阀
       （报价超上限就在运行前停止、不扣费）。画布 CLI 移除后该能力不存在了：
       创作 CLI 没有报价接口，提交前无法知道确切消耗，所以改为**可核对的提醒**：
       余额低于阈值时写任务日志 + 落到 sb.creditWarning / cliJobs，事后能追溯；
       前端在提交前也会读同一个阈值（meta.creditWarnBelow）做二次确认。 */
    const warnBelow = Number(cfg.creditWarnBelow) || 0;
    if (warnBelow > 0 && typeof p.credit === 'number' && p.credit < warnBelow) {
      sb.creditWarning = { credit: p.credit, threshold: warnBelow, at: nowIso() };
      store.pushLog(sb.id, 'warn', '创作 CLI 积分偏低：当前 ' + p.credit + '（提醒阈值 ' + warnBelow +
        '）—— 提交可能因积分不足而失败，请先确认余额');
    } else if (sb.creditWarning && typeof p.credit === 'number' && p.credit >= warnBelow) {
      sb.creditWarning = null;   // 余额恢复就清掉，避免旧提醒一直挂在界面上
    }

    store.pushLog(sb.id, 'info', '引擎=创作 CLI（' + reason + '）');
    /* ⚠ 必须在派发前就把这次任务落库（2026-09-18 故障的修复）。
       原先只在 runVideo 返回**之后**才写 cliJobs —— 而这条异步链一旦中途死掉
       （服务被重启、未捕获异常等），库里就完全没有本次任务的痕迹：
       查不到 submit_id、也无法续查，界面上只表现为「永远生成中」且无从解释。
       先写 state='submitting'，runVideo 返回后再补 submit_id 与终态。 */
    state.running.set(sb.id, { startedAt: Date.now(), submitId: null, engine: 'dreamina' });
    db.cliJobs[sb.id] = Object.assign(db.cliJobs[sb.id] || {}, {
      engine: 'dreamina', state: 'submitting', startedAt: nowIso(), updatedAt: nowIso()
    }, jobContext(db, sb));
    store.save();

    let res;
    try {
      res = await D.runVideo(db, sb, {
        log: (lv, m) => store.pushLog(sb.id, lv, m),
        progress: (pct) => {
          /* 进度回调同样要守卫：取消 / 重试之后，旧一轮还在推进度，
             不拦就会把界面上的新状态又盖回"生成中 xx%"。 */
          if (!guard(db, sb, attemptId, TS.STATUS.GENERATING).ok) return;
          sb.progress = pct; sb.dirty = true; onDirty();
        }
      });
    } catch (e) {
      mapTaskError(db, sb, String(e.code || ERR.INTERNAL), (e.message || '创作 CLI 参数校验失败'), null, hint, attemptId);
      return;
    }
    /* runVideo 把「本次真正拼装出的参数」放在 res.meta 里回传（含 argv / 图号表 / 适配说明）。
       先把命令落进 cliJobs：失败记录也必须能看见"当时执行的到底是什么命令"。 */
    const m = res.meta || {};
    const cmdLine = m.argv ? ((cfg.dreaminaCliPath || 'dreamina') + ' ' + m.argv.join(' ')) : null;
    const dctx = Object.assign({}, hint, {
      command: cmdLine, argv: m.argv || null, mode: m.subcommand || null, cliModel: m.cliModel || null,
      adapted: m.adapted || [], submitId: res.submitId || null
    });
    /* ⚠ 收尾前先验写入权（2026-09-19 修复的关键一步）。
       CLI 是异步的，这一轮跑着的时候用户可能已经「取消」了这个分镜 —— 原先这里
       无条件写 succeeded，于是出现 generating → canceled → succeeded 的"取消后复活"。
       同样地，被强制删除的分镜不能再写 cliJobs（那会把已删条目重新建回来）。
       注意：被拒时**先**把已经拿到的 submit_id 记到系统日志 —— 那是"钱已经花了"的唯一凭据，
       丢了就再也查不到这次生成。 */
    const gFinish = guard(db, sb, attemptId, res.ok ? TS.STATUS.SUCCEEDED : TS.STATUS.FAILED);
    if (!gFinish.ok) {
      if (res.submitId) {
        store.pushLog('system', 'warn', '【已丢弃】生成结果：本轮已失效（' + gFinish.reason + '）' +
          '　storyboard=' + sb.id + '　submit_id=' + res.submitId +
          '　可用 dreamina query_result --submit_id=' + res.submitId + ' 续查或补下载');
      }
      noteRejected(db, sb, attemptId, '结果收尾', gFinish.reason);
      return;
    }
    /* 补齐命令与 submit_id。**即便任务失败或超时也必须落库** ——
       submit_id 是之后用 `dreamina query_result --submit_id=…` 续查结果、补下载的唯一凭据；
       原先只在 `if (cmdLine)` 里写、且不含 submitId，一旦超时这条线索就彻底丢了。 */
    db.cliJobs[sb.id] = Object.assign(db.cliJobs[sb.id] || {}, {
      command: cmdLine || (db.cliJobs[sb.id] && db.cliJobs[sb.id].command) || null,
      argv: m.argv || null, mode: m.subcommand || null, cliModel: m.cliModel || null,
      engine: 'dreamina', submitId: res.submitId || null,
      state: res.ok ? 'succeeded' : 'failed', updatedAt: nowIso()
    }, jobContext(db, sb));
    store.save();
    if (!res.ok) { mapTaskError(db, sb, res.code || String(ERR.INTERNAL), res.message || '创作 CLI 任务失败', null, dctx, attemptId); return; }
    const dl = await D.downloadResult(db, sb, res.submitId).catch(() => ({ videoUrl: null, coverUrl: null }));
    /* 下载是另一次异步等待，期间仍可能被取消 —— 再验一次写入权 */
    if (!guard(db, sb, attemptId, TS.STATUS.SUCCEEDED).ok) {
      noteRejected(db, sb, attemptId, '下载完成后的成功收尾', guard(db, sb, attemptId, TS.STATUS.SUCCEEDED).reason);
      return;
    }
    sb.status = TS.STATUS.SUCCEEDED; sb.progress = 100; sb.etaSeconds = 0;
    sb.remoteId = 'jm_' + String(res.submitId).slice(0, 8);
    sb.finishedAt = nowIso();
    sb.elapsedMs = state.running.get(sb.id) ? Date.now() - state.running.get(sb.id).startedAt : null;
    sb.canEditDuration = false;
    sb.videoUrl = dl.videoUrl || ('cli://dreamina/' + res.submitId);
    sb.coverUrl = dl.coverUrl || null;
    sb.dirty = true;
    REC.append(db, sb, Object.assign({}, dctx, {
      action: 'generate', outcome: 'succeeded',
      videoUrl: sb.videoUrl, coverUrl: sb.coverUrl
    }));
    store.pushLog(sb.id, 'info', '生成完成（创作 CLI）' + (dl.videoUrl ? '，产物已下载' : '（未取到下载文件，任务列表可见 submit_id）'));
    store.save();
    onDirty();
  }

  /* ---------------- 并发上限解析 ----------------
     即梦侧无公开并发上限，也不做账号档位假设：
     只返回本地保护上限 maxConcurrencySafety（默认 0 = 不限制）。
     （原实现还会读画布模型目录里的 maxConcurrency 显式字段，该来源随画布 CLI 一起删除。）
     真实配额由服务端在提交/运行时裁决，超限会返回限流错误（已映射为明确提示）。 */
  let concCache = null;   // { at, max, source }
  async function resolveMaxConcurrency(force) {
    const c = concCache;
    if (!force && c && Date.now() - c.at < cfg.concCacheTtlMs) return c;
    const max = cfg.maxConcurrencySafety || 0;
    concCache = { at: Date.now(), max, source: max > 0 ? 'safety(本地保护上限) ' + max : 'none(不限制)' };
    return concCache;
  }

  /* 干跑校验（POST /storyboards/{id}/dry-run 用）：
     返回路由结果 + 将执行的完整命令。因为只有创作 CLI 一个引擎，
     plans 里只会有 dreamina 一项。
     ⚠ 输出结构（routed / plans.dreamina / submitIdSample …）是接口契约的一部分，前端与文档都在用。 */
  async function planFor(db, sb, opts) {
    const submitId = crypto.randomUUID();
    const eng = models.routeEngine({ model: sb.model, hasAudio: hasAudioBound(sb) });
    const plans = {};
    if (deps.dreamina) {
      try {
        const b = deps.dreamina.buildSubmitArgs(sb, db);
        plans.dreamina = {
          engine: 'dreamina', cli: cfg.dreaminaCliPath || 'dreamina',
          command: (cfg.dreaminaCliPath || 'dreamina') + ' ' + b.args.join(' '),
          argv: b.args, subcommand: b.cmd, model: b.model, resolution: b.res, durationSec: b.durationSec,
          adapted: b.notes || [],
          cliDryRun: { supported: false, message: '创作 CLI 无 --dry-run；命令由适配层按能力表组装并本地校验' }
        };
      } catch (e) {
        plans.dreamina = { engine: 'dreamina', error: e.message || String(e) };
      }
    } else {
      plans.dreamina = { engine: 'dreamina', error: '创作 CLI 适配器未加载（请重启服务）' };
    }
    return {
      routed: { engine: eng.engine, reason: eng.reason, enginesOfModel: models.enginesFor(sb.model) },
      submitIdSample: submitId,
      dreaminaCliPath: cfg.dreaminaCliPath || 'dreamina',
      dryRunMode: cfg.dryRun,
      creditWarnBelow: cfg.creditWarnBelow,
      plans
    };
  }

  /* ---------------- 启动期孤儿清理 ----------------
     任务只能靠内存里的 state.running 推进，服务一重启这张表就空了，
     因此启动时任何还停在 generating 的分镜都**不可能**再被推进 ——
     必须显式收尾，否则它会永远挂在界面上显示「生成中」（2026-09-18 事故形态：
     进度停在 73% 永不变化，日志里既无完成也无失败）。

     刻意不走 mapTaskError：它会在 autoRetry 打开时自动重投，
     而这会在用户毫不知情的情况下再扣一次积分。这里只标失败，
     要不要重试交给界面上的「重试」按钮（用户自己决定）。
     若任务已经拿到 submit_id，一并写进提示 —— 用户可以用
     `dreamina query_result --submit_id=…` 续查结果或补下载，不必白扔一次生成。 */
  function reconcileOrphans(db) {
    const stuck = (db.storyboards || []).filter((s) => s.status === 'generating' && !state.running.has(s.id));
    if (!stuck.length) return 0;
    stuck.forEach((sb) => {
      const job = (db.cliJobs && db.cliJobs[sb.id]) || {};
      const tail = job.submitId
        ? '。该任务的 submit_id=' + job.submitId + '，可用 dreamina query_result --submit_id=' + job.submitId + ' 续查或补下载'
        : '（本次未取得 submit_id，需重新生成）';
      sb.status = TS.STATUS.FAILED;
      sb.attemptId = null;   // 跟踪已断，本轮 attempt 作废（用户点「重试」会分配新的）
      sb.errorCode = String(ERR.INTERRUPTED);
      sb.errorMessage = '服务重启导致本次生成的跟踪中断（进度百分比为按时间估算，不代表实际完成度）' + tail;
      sb.finishedAt = nowIso();
      sb.etaSeconds = 0;
      sb.canEditDuration = true;
      sb.dirty = true;
      store.pushLog(sb.id, 'warn', '启动清理：' + sb.errorMessage);
      REC.append(db, sb, {
        action: 'generate', outcome: 'failed',
        errorCode: sb.errorCode, errorMessage: sb.errorMessage,
        engine: job.engine || null, command: job.command || null,
        argv: job.argv || null, mode: job.mode || null, cliModel: job.cliModel || null,
        submitId: job.submitId || null
      });
    });
    store.save();
    store.pushLog('system', 'warn', '启动清理：' + stuck.length + ' 条「生成中」分镜已标记为中断（服务重启会丢失 CLI 任务跟踪）');
    console.log('[启动清理] ' + stuck.length + ' 条「生成中」分镜已标记为中断');
    return stuck.length;
  }

  /* ---------------- 启动期封面补齐 ----------------
     本次改动之前生成的产物没有封面（创作 CLI 不给，代码也没抽帧），表格里只能显示
     ID 派生的渐变缩略图。启动时补一次：只处理「已完成 + 有视频 + 无封面」的分镜。
     幂等：有 coverUrl 就跳过，makeCover 自身也会复用已存在的文件；
     失败或本机没有 ffmpeg 就静默跳过，绝不影响启动。上限 50 条，避免首次启动拖太久。 */
  async function backfillCovers(db) {
    const D = deps.dreamina;
    if (!D || typeof D.makeCover !== 'function') return 0;
    const targets = (db.storyboards || [])
      .filter((s) => s.status === 'succeeded' && s.videoUrl && !s.coverUrl).slice(0, 50);
    if (!targets.length) return 0;
    let done = 0;
    for (const sb of targets) {
      const abs = path.join(OUTPUT_DIR, decodeURIComponent(String(sb.videoUrl).replace(/^\/files\//, '')));
      const outName = path.basename(abs).replace(/\.[^.]+$/, '') + '_cover.jpg';
      const made = await D.makeCover(abs, path.join(path.dirname(abs), outName));
      if (!made) continue;
      sb.coverUrl = '/files/' + sb.id + '/' + encodeURIComponent(outName);
      sb.dirty = true;
      done++;
    }
    if (done) { store.save(); console.log('[封面补齐] ' + done + ' 条产物的封面已生成'); }
    return done;
  }

  return { tick, resolveMaxConcurrency, planFor, reconcileOrphans, backfillCovers, state };
}

module.exports = { makeWorker };
