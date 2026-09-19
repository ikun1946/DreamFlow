'use strict';
/* ============================================================
   config.js —— 服务配置
   优先级：环境变量 > server/config.json > 内置默认
   ⚠ 2026-09-18：画布 CLI（dreamina-canvas）已移除，本项目只使用创作 CLI（dreamina）。
     随之下线的配置项：cliPath / creditCeiling / probeTtlMs / modelCacheTtlMs。
   ============================================================ */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = __dirname;
const PROJECT_ROOT = path.join(SERVER_DIR, '..');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadConfig() {
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'config.json'), 'utf8')); }
  catch (e) { /* 无配置文件，用默认 */ }
  const env = process.env;
  return {
    port: Number(env.JC_PORT || fileCfg.port || 8787),
    host: env.JC_HOST || fileCfg.host || '127.0.0.1',
    token: env.JC_TOKEN || fileCfg.token || '',            // 空 = 不校验 Bearer
    /* 唯一的 CLI 可执行文件（创作 CLI）。旧配置里的 cliPath 已随画布 CLI 删除——
       为兼容遗留的 config.json / 环境变量仍读一次，但只用于在启动时提示"该配置已失效"。 */
    dreaminaCliPath: env.JC_DREAMINA_CLI_PATH || fileCfg.dreaminaCliPath || 'dreamina',
    legacyCliPath: env.JC_CLI_PATH || fileCfg.cliPath || null,
    region: env.JC_REGION || fileCfg.region || 'cn',
    /* 积分余额提醒阈值：创作 CLI 的积分低于它时，提交前会提醒（前端二次确认 + 任务日志留痕）。
       这是原画布链路 creditCeiling「报价→确认」安全阀的替代物 ——
       创作 CLI 没有报价接口，无法预知确切消耗，故改为"余额不足就明确提醒"。
       legacyCreditCeiling 只用于提示旧配置失效。 */
    creditWarnBelow: Number(env.JC_CREDIT_WARN_BELOW || fileCfg.creditWarnBelow || 50),
    legacyCreditCeiling: env.JC_CREDIT_CEILING || fileCfg.creditCeiling || null,
    // 干跑模式：置 1 时 worker 只组装命令、不 spawn（不连服务端/不扣费），用于提交链路自检
    dryRun: env.JC_DRY_RUN === '1' || fileCfg.dryRun === true,
    runTimeoutMs: Number(env.JC_RUN_TIMEOUT_MS || fileCfg.runTimeoutMs || 15 * 60 * 1000),
    loginTimeoutMs: Number(env.JC_LOGIN_TIMEOUT_MS || fileCfg.loginTimeoutMs || 10 * 60 * 1000),
    authGraceMs: Number(env.JC_AUTH_GRACE_MS || fileCfg.authGraceMs || 10 * 60 * 1000),
    // 创作 CLI 单任务的等待窗口。默认 15 分钟，但即梦队列高峰期可达三十万条，
    // 此时等不到结果是常态 —— 调大这个值即可继续等（超时也不会丢 submit_id，可事后续查）。
    dreaminaPollMs: Number(env.JC_DREAMINA_POLL_MS || fileCfg.dreaminaPollMs || 15 * 60 * 1000),
    // 并发上限：即梦侧无公开上限，也不按账号档位假设。
    // 只保留一个可选的“本地保护上限”，默认 0 = 不限制（保护本机进程数时才配置）。
    maxConcurrencySafety: Number(env.JC_MAX_CONC_SAFETY || fileCfg.maxConcurrencySafety || 0),
    concCacheTtlMs: 30 * 1000,
    uploadMaxBytes: Number(env.JC_UPLOAD_MAX_BYTES || fileCfg.uploadMaxBytes || 30 * 1024 * 1024),
    /* 幂等记录的保留时长（默认 24 小时）。相同 Idempotency-Key 在此期间只真正执行一次，
       第二次直接回放第一次的响应 —— 防止重复提交造成重复生成 / 重复扣费。 */
    idempotencyTtlMs: Number(env.JC_IDEMPOTENCY_TTL_MS || fileCfg.idempotencyTtlMs || 24 * 60 * 60 * 1000),
    /* ffmpeg 可执行文件路径：产物封面（视频抽帧）用它生成。
       创作 CLI 的 query_result 不提供封面，只能本地抽帧 —— 本机没装 ffmpeg 时
       封面生成静默跳过，缩略图退回 ID 派生的渐变（不影响任何其他功能）。
       装了但不在 PATH 里，就把绝对路径填这里。 */
    ffmpegPath: env.JC_FFMPEG_PATH || fileCfg.ffmpegPath || 'ffmpeg',
    /* 是否允许 file:// 打开的前端（发布版单文件双击）访问本服务。
       浏览器对 file:// 页面发来的请求带 `Origin: null`，无法与"恶意网页里被沙箱化的
       iframe"区分开。默认 true = 保留发布版双击即用的既有体验；
       想要最严的本地 API 防护可置 false（此时只有 http://127.0.0.1:8787 打开的页面能用）。 */
    allowFileOrigin: env.JC_ALLOW_FILE_ORIGIN ? env.JC_ALLOW_FILE_ORIGIN === '1' : fileCfg.allowFileOrigin !== false,
    /* 创作 CLI 探测（user_credit）的缓存 TTL。单次实测 8.4–9.5 秒，积分又是低频指标，
       故默认 5 分钟。env JC_DREAMINA_PROBE_TTL_MS 可覆盖。 */
    dreaminaProbeTtlMs: Number(env.JC_DREAMINA_PROBE_TTL_MS || fileCfg.dreaminaProbeTtlMs || 5 * 60 * 1000),
    /* fast 路径下"从未探测过"时允许等待的上限（毫秒）。超过就先用占位返回，
       由前端显示"读取中…"，绝不把一次 9 秒的探测变成用户点击后的等待。 */
    adapterFastWaitMs: Number(env.JC_ADAPTER_FAST_WAIT_MS || fileCfg.adapterFastWaitMs || 2500),
    projectId: env.JC_PROJECT_ID || fileCfg.projectId || 'pj_1'
  };
}

module.exports = { loadConfig, SERVER_DIR, PROJECT_ROOT, DATA_DIR, OUTPUT_DIR, ASSET_DIR, DB_FILE };
