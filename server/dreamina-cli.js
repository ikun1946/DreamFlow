'use strict';
/* ============================================================
   dreamina-cli.js —— 「即梦创作 CLI」（dreamina）适配器
   ------------------------------------------------------------
   2026-09-18 画布 CLI（dreamina-canvas）已彻底移除，这是项目里**唯一**的生成引擎适配器。
   职责：
     · 登录态与积分余额探测（user_credit）
     · 视频任务提交（text2video / multimodal2video，支持图片+音频参考）
     · 轮询与结果下载（query_result --download_dir）
   实测协议要点（dreamina 1.4.18）：
     · 异步任务：提交返回 submit_id + gen_status(querying|success|fail)；
       --poll N 可等最多 N 秒；未终态时用 query_result 继续查
     · 分辨率一律小写（720p/1080p/480p/4k）；normResolution 保留对历史大写值
       （720P —— 原画布域写法）的兼容归一
     · 模型名：seedance2.0 / seedance2.0fast / seedance2.0_vip /
       seedance2.0fast_vip / seedance2.0mini / seedance2.5
     · multimodal2video 至少需 1 张图或视频（seedance2.5 允许纯音频）
     · 成功判定看 gen_status=success，不能只看退出码
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OUTPUT_DIR, ASSET_DIR } = require('./config');
const store = require('./store');
const { ERR, ApiError, nowIso } = require('./util');
const M = require('./models');
const AL = require('./asset-lock');

/* 模型清单与能力约束统一来自 server/models.js（唯一事实来源） */
const DREAMINA_MODELS = M.DREAMINA_VIDEO_MODELS;
const RATIOS = M.DREAMINA_RATIOS;
/* 分辨率归一化：接受历史大写值（720P，原画布域写法），映射到创作 CLI 的小写值 */
function normResolution(v) {
  const s = String(v || '').toLowerCase();
  if (s === '480p' || s === '720p' || s === '1080p' || s === '4k') return s;
  if (s === '2k') return '1080p';
  return '720p';
}

function makeDreaminaAdapter(cfg) {
  const bin = cfg.dreaminaCliPath || 'dreamina';
  const state = { probe: null, credit: null, running: new Map() };

  /* ---------------- spawn ---------------- */
  function rawSpawn(args, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(bin, args, { windowsHide: true, shell: false }); }
      catch (e) { return resolve({ kind: 'cli_down', reason: 'spawn 失败: ' + e.message }); }
      let stdout = '', stderr = '', done = false;
      const timer = setTimeout(() => {
        if (done) return; done = true;
        try { child.kill(); } catch (e) { /* noop */ }
        resolve({ kind: 'timeout', stdout, stderr, child });
      }, timeoutMs || 60000);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ kind: 'cli_down', reason: String(e.message || e) }); });
      child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ kind: 'exit', code, stdout, stderr }); });
    });
  }

  function parseJson(s) {
    const i = String(s || '').indexOf('{');
    if (i < 0) return null;
    try { return JSON.parse(String(s).slice(i)); } catch (e) { return null; }
  }

  async function call(args, timeoutMs) {
    const r = await rawSpawn(args, timeoutMs);
    if (r.kind === 'cli_down') return { kind: 'cli_down', reason: r.reason };
    if (r.kind === 'timeout') return { kind: 'timeout', stdout: r.stdout, stderr: r.stderr };
    const json = parseJson(r.stdout) || parseJson(r.stderr);
    if (r.code === 0) return { kind: 'ok', data: json, raw: r.stdout };
    return { kind: 'error', code: 'exit_' + r.code, message: (r.stderr || r.stdout || '').slice(0, 300) || ('退出码 ' + r.code), json };
  }

  /* ---------------- 探测（登录态 + 积分余额，60s 缓存） ---------------- */
  /* 探测缓存 TTL。为什么默认 5 分钟（原 60s）：
     单次 `dreamina user_credit` 实测 **8.4–9.5 秒**（真实网络调用），而积分是低频变化指标。
     60s 的 TTL 意味着"每分钟必然触发一次 ~9 秒的真实探测"，正是"点设置偶尔要等 11 秒"的来源。
     正确性不靠缩短 TTL 保证，而靠 services.adapterStatus 的 fast 路径**永不等待探测**
     （缓存过期就回陈旧值 + 后台刷新）。 */
  const PROBE_TTL_MS = Number(cfg && cfg.dreaminaProbeTtlMs) || 5 * 60 * 1000;

  /* 在飞探测：并发调用共用同一次 spawn。
     原实现没有这层，而 services.adapterStatus 的冷路径会**同时**发起两次 D.probe()
     （后台补探 + Promise.all 里的 await）→ 两个 user_credit 进程互相争用，实测把
     单次 9s 拖成 11s。 */
  let probing = null;

  async function probe(force) {
    const c = state.probe;
    if (!force && c && Date.now() - c.at < PROBE_TTL_MS) return c;
    if (probing) return probing;
    probing = (async () => {
      // version 从随安装写入的 version.json 读取（零进程开销）；可用性只靠一次 user_credit 探测
      let version = null;
      try {
        const vf = path.join(require('os').homedir(), '.dreamina_cli', 'version.json');
        version = JSON.parse(fs.readFileSync(vf, 'utf8')).version || null;
      } catch (e) { /* 文件缺失时退回未知 */ }
      const cr = await call(['user_credit'], 20000);
      const creditData = cr.kind === 'ok' && cr.data ? cr.data : null;
      const available = !!(version && creditData && typeof creditData.total_credit === 'number');
      state.probe = {
        at: Date.now(),
        available,
        version,
        credit: creditData ? creditData.total_credit : null,
        account: creditData ? { userId: creditData.user_id, vipLevel: creditData.vip_level } : null,
        message: available ? '即梦创作 CLI 已就绪（积分 ' + creditData.total_credit + '）'
          : (version ? '创作 CLI 已安装但未登录（dreamina login）' : '未检测到创作 CLI（dreamina）')
      };
      if (creditData) state.credit = { at: Date.now(), value: creditData.total_credit };
      return state.probe;
    })();
    try { return await probing; } finally { probing = null; }
  }
  const credit = async (force) => (await probe(force)).credit;

  /* 缓存视图。**必须遵守 TTL**：过期返回 null，让调用方知道"这不是新鲜值、该重新探测"。
     历史 bug（2026-09-18）：这里无脑返回缓存对象，而调用方写的是
     `peek() || probe(true)` —— 只要有缓存就短路，`probe(true)` 永不执行，
     结果积分只在服务启动后读过一次、之后永不刷新（后端显示 105，实际已 73）。 */
  function peek() {
    const c = state.probe;
    if (!c) return null;
    if (Date.now() - c.at >= PROBE_TTL_MS) return null;      // 过期 = 视为无缓存
    return { at: c.at, available: c.available, version: c.version, credit: c.credit, account: c.account, message: c.message };
  }

  /* 「最后已知值」——不看 TTL。
     和 peek() 的职责区分很重要：
       · peek() 回答"有没有可用的新鲜值"，过期必须返回 null（否则重演上面的积分不刷新 bug）；
       · lastProbe() 回答"最后一次探测看到了什么"，供 fast 路径**立即**响应并用 stale 标明陈旧，
         而不是让用户对着一个卡住的界面等 9 秒。 */
  function lastProbe() {
    const c = state.probe;
    if (!c) return null;
    return {
      at: c.at, available: c.available, version: c.version,
      credit: c.credit, account: c.account, message: c.message,
      stale: (Date.now() - c.at) >= PROBE_TTL_MS
    };
  }

  /* 账号/登录态变化后立即失效（否则要等 TTL 自然过期，用户会看到旧账号或旧积分） */
  function invalidate() {
    state.probe = null;
    state.credit = null;
  }

  /* ---------------- 登录 / 切换账号（OAuth Device Flow，dreamina 1.4.18 实测） ----------------
     命令面（`dreamina login -h` / `relogin -h` / `login checklogin -h`）：
       dreamina login [--headless]        已登录时直接「复用当前本地 OAuth 登录态」并退出（不再授权）
       dreamina relogin [--headless]      **先清掉本地登录态**，再强制走一次授权  ←「切换账号」用它
       dreamina login checklogin --device_code=<x> --poll=<秒>   查询授权结果（--poll 最多等 N 秒）
     与画布 CLI 的两点关键差异：
       ① 输出是**纯文本**（不是 JSON 信封）→ 必须容错解析，且解析失败时把原始输出回传；
       ② `relogin` 会**先退出当前账号**，没完成新授权就失去它 → 界面必须二次确认。
     授权链接在启动阶段就落库（publishAuthUrl），前端每 3s 轮询即可实时看到链接与设备码。 */
  /* 标签要同时覆盖英文与中文写法（单测发现漏了「设备码」就会解析失败）：
     device_code / device-code / deviceCode / 设备码；user_code / userCode / 用户码 / 验证码。
     注意「设备码」属于 device，不能再出现在 user code 的正则里，否则两个字段会互相串。 */
  const DEVICE_RE = /(?:device[_\s-]?code|设备码|设备识别码)\s*[:=：]?\s*(["']?)([A-Za-z0-9._-]{6,})\1/i;
  const USERCODE_RE = /(?:user[_\s-]?code|用户码|用户代码|验证码)\s*[:=：]?\s*([A-Za-z0-9]{4,}(?:[- ][A-Za-z0-9]{4,})?)/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 长流程进程句柄：边跑边可读输出、可查退出状态、可主动终止（与画布适配器同构）。

     ⚠ killedByTimeout() 必须暴露出来。历史故障（2026-09-18「切换账号」）：
     relogin 在预算内没吐出设备码就被这里静默 kill，上层拿到的只是"没有输出"，
     于是把「超时被杀 / CLI 报错 / 解析失败」三种原因糊成一句无用的提示，排查只能靠猜。
     spawn 同步抛错（EINVAL 等）也要兜住，否则会直接冒泡成 500。 */
  function startProcess(args, timeoutMs) {
    const t0 = Date.now();
    let child = null, spawnErr = null;
    try { child = spawn(bin, args, { windowsHide: true, shell: false }); }
    catch (e) { spawnErr = e; }

    let stdout = '', stderr = '', exited = false, exitCode = null, killedByTimeout = false;
    const timer = child ? setTimeout(() => {
      killedByTimeout = true;
      try { child.kill(); } catch (e) { /* noop */ }
    }, timeoutMs || 60000) : null;

    if (child) {
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => { exited = true; exitCode = -1; if (!spawnErr) spawnErr = e; });
      child.on('close', (code) => { exited = true; exitCode = code; if (timer) clearTimeout(timer); });
    } else {
      exited = true; exitCode = -1;
    }

    return {
      args: args.slice(),
      stdout: () => stdout, stderr: () => stderr,
      exited: () => exited, code: () => exitCode,
      killedByTimeout: () => killedByTimeout,
      spawnError: () => (spawnErr ? String((spawnErr && spawnErr.message) || spawnErr) : null),
      elapsedMs: () => Date.now() - t0,
      kill: () => { try { if (child) child.kill(); } catch (e) { /* noop */ } if (timer) clearTimeout(timer); }
    };
  }

  /* 容错解析授权材料：先按 JSON 兜底（万一后续版本改成信封），再按纯文本正则抓。
     抓不全不算错 —— 上层会把原始输出一并回传，用户仍可手工完成授权。 */
  function parseChallenge(text) {
    const s = String(text || '');
    const out = { verificationUri: null, userCode: null, deviceCode: null };
    const j = parseJson(s);
    if (j) {
      const d = j.data || j;
      const c = d.challenge || d;
      out.verificationUri = c.verificationUri || c.verification_uri || null;
      out.deviceCode = c.deviceCode || c.device_code || null;
      out.userCode = c.userCode || c.user_code || null;
    }
    if (!out.verificationUri) {
      const u = s.match(/https?:\/\/[^\s"'<>）)】]+/);
      if (u) out.verificationUri = u[0];
    }
    if (!out.deviceCode) { const m = s.match(DEVICE_RE); if (m) out.deviceCode = m[2]; }
    if (!out.userCode) {
      let m = s.match(USERCODE_RE);
      if (!m) m = s.match(/\b([A-Z0-9]{4}[- ][A-Z0-9]{4})\b/);
      if (m) out.userCode = m[1];
    }
    return out;
  }

  /* ---------------- 授权流程留痕 ----------------
     切换/登录出问题时，事后只能靠 CLI 自己的日志反推（2026-09-18 的教训）。
     这里把流程每一步写进 db.logs.auth，出问题直接看库就能定位到具体环节。
     注意：只记"是否解析到"，绝不记录 device_code / user_code 明文。 */
  function authLog(level, msg) {
    try { store.pushLog('auth', level, msg); } catch (e) { /* 留痕失败不能影响主流程 */ }
  }
  function trunc(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* 授权链接落库，供前端轮询显示；无变化不写盘。

     dreaminaAuthAt = 该链接的落库时刻。services.adapterStatus() 靠它判断"这是刚刚
     发布、正在用的链接"，绝不当作遗留链接清掉 —— 否则前端每 3s 的状态轮询会在
     切换进行中把用户正要点的授权链接清空（2026-09-18 故障的直接原因）。 */
  function publishAuthUrl(db, url, userCode, why) {
    const a = url || null, c = userCode || null;
    if ((db.settings.adapter.dreaminaAuthUrl || null) === a &&
        (db.settings.adapter.dreaminaUserCode || null) === c) return;
    if (!db.settings.adapter) db.settings.adapter = {};
    db.settings.adapter.dreaminaAuthUrl = a;
    db.settings.adapter.dreaminaUserCode = c;
    db.settings.adapter.dreaminaAuthAt = a ? Date.now() : null;
    store.save();
    authLog('info', (a ? '发布' : '清空') + '创作 CLI 授权链接（来源：' + (why || '未标注') +
      (a ? '；设备码' + (c ? '已取得' : '未取得') : '') + '）');
  }

  /* 是否已有登录/切换流程在进行中。services 侧据此决定"授权链接能不能清"。 */
  const pending = () => !!(state.loginProc && !state.loginProc.exited());

  /* 授权材料阶段的预算。--headless 的语义是「打印材料后立刻退出」，理论上几秒就够；
     但 2026-09-18 实测出现过 60s 内未返回、进程已被 kill 而旧登录态又已丢失的情况，
     故放宽到 120s，并让上层能分辨「被超时杀的」还是「CLI 自己报错的」。 */
  const MATERIAL_TIMEOUT_MS = 120000;
  const MANUAL_HINT = '可绕过界面手工完成：在终端执行 dreamina relogin，浏览器授权完成后回本页点「检测连接状态」。';

  async function authLoginFlow(db, timeoutMs, force) {
    if (state.loginProc && !state.loginProc.exited()) {
      authLog('warn', '拒绝启动：已有登录流程进行中（' + state.loginProc.args.join(' ') + '）');
      return { ok: false, reason: 'busy', message: '创作 CLI 已有登录流程进行中：请在浏览器完成授权，或等待其超时后重试', authUrl: null };
    }
    const budget = timeoutMs || 600000;
    const deadline = Date.now() + budget;
    const t0 = Date.now();
    let keepUrl = false;
    const args = force ? ['relogin', '--headless'] : ['login', '--headless'];
    authLog('info', '开始' + (force ? '切换账号（relogin）' : '登录（login）') +
      '：总预算 ' + Math.round(budget / 1000) + 's，材料阶段超时 ' + Math.round(MATERIAL_TIMEOUT_MS / 1000) + 's' +
      (force ? '；注意 relogin 会先退出当前账号' : ''));

    const proc = startProcess(args, MATERIAL_TIMEOUT_MS);
    state.loginProc = proc;
    try {
      while (!proc.exited() && Date.now() < deadline) await sleep(400);
      const text = (proc.stdout() || '') + '\n' + (proc.stderr() || '');
      const ch = parseChallenge(text);
      const killedByTimeout = proc.killedByTimeout();
      const spawnError = proc.spawnError();

      authLog(killedByTimeout || spawnError ? 'warn' : 'info',
        '授权材料阶段结束：退出码=' + String(proc.code()) +
        '，被超时终止=' + (killedByTimeout ? '是' : '否') +
        '，spawn错误=' + (spawnError || '无') +
        '，耗时=' + Math.round(proc.elapsedMs() / 1000) + 's' +
        '，输出 ' + text.trim().length + ' 字' +
        '；解析 uri=' + !!ch.verificationUri + ' deviceCode=' + !!ch.deviceCode + ' userCode=' + !!ch.userCode);

      // 未强制 + 本地态仍有效：CLI 打印「已复用当前本地 OAuth 登录态」并退出 → 视为已登录
      if (!force && proc.code() === 0 && /复用|reuse/i.test(text)) {
        const p = await probe(true);
        if (p.available) {
          authLog('info', '复用本地登录态成功（未重新授权）');
          return {
            ok: true, reason: 'reused', reused: true,
            message: '创作 CLI 已处于登录态（CLI 复用了本地 OAuth 登录态，无需重新授权）',
            authUrl: null, credit: p.credit, account: p.account
          };
        }
      }

      if (!ch.deviceCode) {
        keepUrl = true;                                   // 失败也要留住链接，用户还能手工完成
        publishAuthUrl(db, ch.verificationUri, ch.userCode, '材料阶段未取得 deviceCode，尽力保留');
        const p = await probe(true);
        /* 把「超时被杀 / spawn 失败 / 输出解析失败」三种原因分开说 ——
           否则用户和排查者都分不清是网络问题、CLI 问题还是需要手工操作。 */
        let why;
        if (spawnError) {
          why = '无法启动 dreamina 命令（' + spawnError + '），请确认创作 CLI 已安装且在 PATH 中';
        } else if (killedByTimeout) {
          why = (force ? 'relogin' : 'login') + ' 在 ' + Math.round(MATERIAL_TIMEOUT_MS / 1000) +
                ' 秒内未返回设备码，已被终止（通常是网络或即梦授权端响应异常）';
        } else {
          why = 'CLI 退出码 ' + String(proc.code()) + '，输出中未识别到设备码';
        }
        authLog('err', '未取得设备授权码：' + why + (force ? '；当前账号可能已被 relogin 退出' : ''));
        return {
          ok: false,
          reason: spawnError ? 'cli_down' : (killedByTimeout ? 'material_timeout' : 'no_device_code'),
          message: '未取得创作 CLI 的设备授权码：' + why + (force ? '。' + MANUAL_HINT : '，请重试。'),
          authUrl: ch.verificationUri, userCode: ch.userCode,
          raw: (text.trim() || '（CLI 无输出）').slice(0, 800),
          manualHint: MANUAL_HINT,
          available: p.available, credit: p.credit, account: p.account
        };
      }

      publishAuthUrl(db, ch.verificationUri, ch.userCode, '材料阶段解析成功');
      /* 轮询授权结果。--poll 是「最多等 N 秒」，故循环调用直到已登录或预算耗尽；
         成功判定用 probe().available（只有 user_credit 真拿到 total_credit 才算登录成功）。 */
      let lastMsg = '';
      let rounds = 0;
      while (Date.now() < deadline) {
        rounds++;
        const r = await rawSpawn(['login', 'checklogin', '--device_code=' + ch.deviceCode, '--poll=25'], 45000);
        lastMsg = ((r.stdout || '') + (r.stderr || '')).trim();
        const p = await probe(true);
        if (p.available) {
          authLog('info', '授权确认成功（第 ' + rounds + ' 轮，累计 ' + Math.round((Date.now() - t0) / 1000) + 's）');
          return {
            ok: true, reason: 'authorized',
            message: '创作 CLI 登录成功',
            authUrl: null, credit: p.credit, account: p.account
          };
        }
        if (/expire|invalid|失效|过期|已使用|不存在/i.test(lastMsg)) {
          authLog('warn', '第 ' + rounds + ' 轮判定设备码失效，停止等待：' + trunc(lastMsg, 160));
          break;   // 设备码失效，别死等
        }
        authLog('info', '第 ' + rounds + ' 轮仍在等待授权：' + (trunc(lastMsg, 120) || '（无输出）'));
      }

      keepUrl = true;
      const p = await probe(true);
      authLog('warn', '授权未完成即结束（累计 ' + Math.round((Date.now() - t0) / 1000) +
        's，' + rounds + ' 轮）：' + trunc(lastMsg, 160));
      return {
        ok: false, reason: 'not_authorized',
        message: '创作 CLI 登录未完成（尚未授权或已超时）—— 请在浏览器完成授权后重试，或重新点「登录」获取新链接。' + MANUAL_HINT,
        authUrl: ch.verificationUri, userCode: ch.userCode,
        raw: lastMsg.slice(0, 500),
        manualHint: MANUAL_HINT,
        available: p.available, credit: p.credit, account: p.account
      };
    } finally {
      state.loginProc = null;
      if (!keepUrl) publishAuthUrl(db, null, null, '流程成功结束，回收链接');   // 成功才清链接；失败保留供手工完成
    }
  }

  const switchAccount = (db, timeoutMs) => authLoginFlow(db, timeoutMs, true);

  /* ---------------- 组装参数（唯一映射出口） ---------------- */
  function buildSubmitArgs(sb, db, opts) {
    /* 图号表与 --image 顺序**同源**（asset-lock.js 是图号唯一定义处）：
       否则命令行里第 N 张图会与提示词里的「图片N」错位。 */
    const cat0 = AL.imageCatalog(sb, db);
    let images = cat0.images.map((x) => x.file);
    let lockImages = cat0.images.slice();
    let skipped = cat0.skipped.slice();
    const audios = cat0.audios.map((x) => x.file);
    const model = M.dreaminaModelOf(sb.model);
    if (!model) {
      throw new ApiError(ERR.PARAM, '创作 CLI 不支持模型 ' + sb.model + '（支持：' + M.DREAMINA_VIDEO_MODELS.join(' / ') + '）——请在模型列表中选择标注「创作 CLI」的模型');
    }
    const caps = M.capsFor(model);
    const lim = M.limitsFor(model);
    const notes = [];   // 参数适配留痕（写入任务日志，不做静默调整）

    // 分辨率：超出该模型支持集时，取「不高于请求值」的最近支持档
    const order = ['480p', '720p', '1080p', '4k'];
    let res = normResolution(sb.resolution);
    if (!caps.resolutions.includes(res)) {
      const reqIdx = order.indexOf(res);
      const lower = caps.resolutions.filter((r) => order.indexOf(r) <= reqIdx);
      const pick = lower.length ? lower[lower.length - 1] : caps.resolutions[0];
      notes.push('分辨率 ' + res + ' 不受 ' + model + ' 支持（' + caps.resolutions.join('/') + '），改用 ' + pick);
      res = pick;
    }

    // 时长：收敛到该模型支持区间
    let dur = Number(sb.durationSec) || 5;
    if (dur < caps.duration[0] || dur > caps.duration[1]) {
      const clamped = Math.max(caps.duration[0], Math.min(caps.duration[1], dur));
      notes.push('时长 ' + dur + 's 超出 ' + model + ' 支持范围 ' + caps.duration[0] + '-' + caps.duration[1] + 's，改用 ' + clamped + 's');
      dur = clamped;
    }

    // 画幅：不在创作 CLI 值域内则回落 16:9
    let ratio = sb.ratio;
    if (!RATIOS.includes(ratio)) { notes.push('画幅 ' + ratio + ' 不受创作 CLI 支持，改用 16:9'); ratio = '16:9'; }

    // 参考素材规则：2.0 家族必须至少 1 张图片或视频；纯音频参考仅 2.5 允许
    if (audios.length && !images.length && !caps.audioOnly) {
      throw new ApiError(ERR.PARAM, '模型 ' + model + ' 不接受纯音频参考（需至少 1 张图片或视频）；纯音频参考请改用 Seedance 2.5');
    }
    let truncated = false;
    if (images.length > lim.image) {
      notes.push('图片参考 ' + images.length + ' 张超出上限，仅前 ' + lim.image + ' 张生效');
      truncated = true;
      images = images.slice(0, lim.image);
      lockImages = lockImages.slice(0, lim.image);   // 图号只算**真正会发出**的图，避免尾部错位
      skipped = skipped.concat(cat0.images.slice(lim.image).map((x) => ({ assetId: x.assetId, name: x.name, reason: '超出该模型图片上限，未发出' })));
    }
    if (audios.length > lim.audio) { notes.push('音频参考 ' + audios.length + ' 条超出上限，仅前 ' + lim.audio + ' 条生效'); audios.splice(lim.audio); }

    /* 素材锁定：只在**确有图片**时追加（无图可锁）。原文一字不改，区块放在最前面。 */
    const lockBlock = AL.lockBlock(lockImages, sb);
    const issues = AL.validate(sb.prompt, lockImages, { truncated, skipped });
    const prompt = AL.compose(sb.prompt, lockBlock);

    const withRefs = images.length || audios.length;
    const cmd = withRefs ? 'multimodal2video' : 'text2video';
    const args = [cmd, '--prompt', prompt, '--duration', String(dur),
      '--ratio', ratio, '--video_resolution', res, '--model_version', model, '--poll', '30'];
    if (withRefs) {
      images.forEach((p) => args.push('--image', p));
      audios.forEach((p) => args.push('--audio', p));
    }
    return {
      args, cmd, model, ratio, res, durationSec: dur,
      images: images.length, audios: audios.length, notes,
      promptWithLock: prompt,     // 干跑核对面板要展示「实际发出去的提示词」
      lockBlock, imageCatalog: lockImages, lockIssues: issues, promptOriginal: sb.prompt
    };
  }

  /* ---------------- 提交 + 轮询 + 下载 ----------------
     hooks: { log(level, msg), progress(pct) } —— 供 worker 回传进度与日志 */
  async function runVideo(db, sb, hooks) {
    const log = (lv, m) => { if (hooks && hooks.log) hooks.log(lv, m); };
    const prog = (p) => { if (hooks && hooks.progress) hooks.progress(p); };
    const built = buildSubmitArgs(sb, db);
    log('info', '创作 CLI 提交：' + built.cmd + '（模型 ' + built.model + '，图 ' + built.images + '，音 ' + built.audios + '，' + built.res + '/' + built.durationSec + 's）');
    (built.notes || []).forEach((n) => log('warn', '参数适配：' + n));
    /* 素材锁定与引用校验：有图时区块已追加到 --prompt 开头（原文未改） */
    if (built.lockBlock) {
      log('info', '已追加「素材锁定」区块（' + built.images + ' 张图，图号顺序 = --image 顺序）：' +
        (built.imageCatalog || []).map((x) => '图片' + x.n + '=' + x.name).join('、'));
    }
    (built.lockIssues || []).forEach((it) => log(it.level === 'warn' ? 'warn' : 'info', '素材引用：' + it.message));
    /* meta：把「本次真正会执行的参数与拼装结果」回传调用方。
       生成记录要靠它落一条可回溯的快照（命令/图号/实际型号/适配说明），
       否则记录只能事后重算，而重算结果未必等于当时真正发出去的东西。 */
    const meta = {
      argv: built.args, subcommand: built.cmd, cliModel: built.model,
      resolution: built.res, durationSec: built.durationSec, ratio: built.ratio,
      adapted: built.notes || [], lockImages: built.imageCatalog || [],
      lockBlock: built.lockBlock || '', lockIssues: built.lockIssues || [],
      promptWithLock: built.promptWithLock, imageCount: built.images, audioCount: built.audios
    };
    let r = await call(built.args, Math.max(120000, (built.durationSec + 60) * 1000));
    if (r.kind === 'cli_down') return { ok: false, code: String(ERR.CLI_DOWN), message: '创作 CLI 不可用：' + r.reason, meta };
    const pick = (obj) => (obj && (obj.submit_id || (obj.data && obj.data.submit_id))) || null;
    const pickStatus = (obj) => (obj && (obj.gen_status || (obj.data && obj.data.gen_status))) || null;
    let submitId = pick(r.data || r.json);
    let status = pickStatus(r.data || r.json);

    // AigcComplianceConfirmationRequired：需先在即梦 Web 完成该模型首次生成
    const rawText = ((r.data && JSON.stringify(r.data)) || '') + ((r.json && JSON.stringify(r.json)) || '') + (r.message || '');
    if (/AigcComplianceConfirmationRequired|首次使用/i.test(rawText)) {
      return { ok: false, code: String(ERR.FORBIDDEN), message: '该模型需先在即梦 Web 端完成一次首次生成（合规确认），完成后重试即可', meta };
    }
    if (!submitId) {
      return { ok: false, code: String(ERR.INTERNAL), message: '创作 CLI 未返回 submit_id：' + ((r.message || (r.data ? JSON.stringify(r.data) : '')).slice(0, 200)), meta };
    }
    log('info', 'submit_id=' + submitId + '（gen_status=' + status + '）');
    prog(30);   // 已受理
    /* 说清进度到底是什么：即梦接口不返回百分比，下面的数字是**按时间爬坡的估算**。
       不写这句，界面上的 73% 很容易被读成"快好了"（2026-09-18 排查时就先被它误导过）。 */
    log('info', '注：进度百分比为按时间估算（非真实完成度）——10 分钟内从 30% 线性爬到 90%，之后封顶');

    const startedAt = Date.now();
    /* 等待窗口可配（JC_DREAMINA_POLL_MS / config.dreaminaPollMs，默认 15 分钟）。
       即梦队列高峰期可达三十万条，15 分钟等不到是常态；超时也**不会丢 submit_id** ——
       它会随返回值落进 cliJobs，可事后续查或补下载。 */
    const pollMs = Number(cfg.dreaminaPollMs) > 0 ? Number(cfg.dreaminaPollMs) : 15 * 60 * 1000;
    const deadline = startedAt + pollMs;
    let lastWaitLog = 0;
    while (status !== 'success' && status !== 'fail' && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5000));
      prog(Math.min(90, 30 + Math.round(((Date.now() - startedAt) / (10 * 60 * 1000)) * 60)));
      const q = await call(['query_result', '--submit_id', submitId], 30000);
      const body = q.data || q.json;
      status = pickStatus(body);
      if (status === 'success') {
        return { ok: true, submitId, body, meta };
      }
      if (status === 'fail') {
        const reason = (body && (body.fail_reason || (body.data && body.data.fail_reason))) || '未知原因';
        return { ok: false, code: String(ERR.INTERNAL), message: '创作 CLI 任务失败：' + reason, submitId, meta };
      }
      /* 每 2 分钟留一条等待记录：能回答"到底是在排队还是卡住了"。
         队列位置是唯一的真实信号，但只在部分 CLI 版本/子命令里返回 —— 拿不到就只记等待时长。 */
      if (Date.now() - lastWaitLog > 120000) {
        lastWaitLog = Date.now();
        const qi = body && (body.queue_info || (body.data && body.data.queue_info));
        log('info', '仍在等待（已等待 ' + Math.round((Date.now() - startedAt) / 1000) + 's，估算进度 ' +
          sb.progress + '%）' + (qi ? '　队列位置 ' + qi.queue_idx + ' / 共 ' + qi.queue_length : ''));
      }
    }
    if (status === 'success') return { ok: true, submitId, body: r.data || r.json, meta };
    return {
      ok: false, code: String(ERR.UPSTREAM_TIMEOUT),
      message: '创作 CLI 任务未在 ' + Math.round(pollMs / 60000) + ' 分钟内完成（submit_id=' + submitId +
        '）—— 任务在即梦侧通常仍在排队/生成中（高峰期队列可达三十余万条）。' +
        '续查：反复执行 `dreamina query_result --submit_id=' + submitId + '`，' +
        '看到 gen_status=success 后加 `--download_dir <输出目录>` 取回产物。' +
        '也可直接重试（会重新扣积分）',
      submitId, meta
    };
  }

  /* 下载产物到 output/<storyboardId>/，返回可访问 url */
  async function downloadResult(db, sb, submitId) {
    const dir = path.join(OUTPUT_DIR, sb.id);
    fs.mkdirSync(dir, { recursive: true });
    const r = await call(['query_result', '--submit_id', submitId, '--download_dir', dir], 120000);
    if (r.kind !== 'ok') return { videoUrl: null };
    const files = fs.readdirSync(dir).filter((f) => /\.(mp4|mov|webm|jpg|jpeg|png)$/i.test(f));
    const video = files.find((f) => /\.(mp4|mov|webm)$/i.test(f));
    const cover = files.find((f) => /\.(jpg|jpeg|png)$/i.test(f));
    return {
      videoUrl: video ? '/files/' + sb.id + '/' + encodeURIComponent(video) : null,
      coverUrl: cover ? '/files/' + sb.id + '/' + encodeURIComponent(cover) : null
    };
  }

  /* parseChallenge 一并导出：仅用于单元验证「授权材料解析」是否稳健
     （切换账号会先退出登录态，无法在真机反复试，必须靠样本单测覆盖）。 */
  return { probe, peek, lastProbe, credit, invalidate, authLoginFlow, switchAccount, pending, parseChallenge, buildSubmitArgs, runVideo, downloadResult, state, normResolution };
}

module.exports = { makeDreaminaAdapter, DREAMINA_MODELS, normResolution };
