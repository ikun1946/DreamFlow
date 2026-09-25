'use strict';
/* ============================================================
   config.js —— 服务配置
   优先级：loadConfig(overrides) > 环境变量 > server/config.json > 内置默认
   ⚠ 2026-09-18：画布 CLI（dreamina-canvas）已移除，本项目只使用创作 CLI（dreamina）。
      随之下线的配置项：cliPath / creditCeiling / probeTtlMs / modelCacheTtlMs。
   ⚠ 2026-09-20 桌面化：数据根不再写死，改由 runtime.js 提供（见该文件说明）。
      DATA_DIR / DB_FILE 仍可读，但**必须每次现取**，不能解构快照。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const runtime = require('./runtime');

const SERVER_DIR = __dirname;
const PROJECT_ROOT = path.join(SERVER_DIR, '..');

/* 配置文件位置：命令行版是 server/config.json；桌面版指向 userData 下的 config.json
   （安装目录只读，用户配置必须写在可写位置）。 */
function configFilePath() {
  return runtime.getConfigPath() || path.join(SERVER_DIR, 'config.json');
}

function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(configFilePath(), 'utf8')); }
  catch (e) { return {}; }
}

/* 读取本进程生效的配置。

   ⚠ 一旦加载过就直接复用同一份对象：services.js / dreamina-cli.js 里散落的
   loadConfig() 必须拿到**注入后的**结果，否则桌面版的随机端口与随机 Token
   会被默认值悄悄盖掉（那种故障表现为"页面打不开"或"接口全部 40100"）。
   overrides 只在启动时由入口传一次。 */
function loadConfig(overrides) {
  if (!overrides && runtime.getCurrentConfig()) return runtime.getCurrentConfig();

  const fileCfg = readConfigFile();
  const env = process.env;
  const cfg = {
    mode: runtime.getMode(),
    dataDir: runtime.getDataDir(),
    logsDir: runtime.getLogsDir(),
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
    /* ffprobe 可执行文件路径：只用于读**音频素材的时长**（音频参考的总时长有上限，
       见 audioTotalSecMax）。它与 ffmpeg 一起分发，所以装了 ffmpeg 就通常有它。
       和 ffmpeg 一样是**可选**依赖：缺失或失败时音频时长保持"未知"，
       不报错、不影响其他功能（但"时长未知"的音频不允许绑定，见 services.checkAudioBudget）。 */
    ffprobePath: env.JC_FFPROBE_PATH || fileCfg.ffprobePath || 'ffprobe',
    /* 单个分镜上「音频参考」的总时长上限（秒）。数量上限走 models.limitsFor(model).audio，
       这里是**时长**上限 —— 两者同时生效。
       默认 15 与本项目单镜时长上限一致（services.js 的 meta.duration.max）。 */
    audioTotalSecMax: Number(env.JC_AUDIO_TOTAL_SEC_MAX || fileCfg.audioTotalSecMax || 15),
    /* 是否允许 file:// 打开的前端（发布版单文件双击）访问本服务。
       浏览器对 file:// 页面发来的请求带 Origin: null，无法与"恶意网页里被沙箱化的
       iframe"区分开。默认 true = 保留发布版双击即用的既有体验；
       想要最严的本地 API 防护可置 false（此时只有 http://127.0.0.1:8787 打开的页面能用）。
       ⚠ 桌面版显式置 false：页面由内嵌服务自己托管，不需要给 file:// 开口子。 */
    allowFileOrigin: env.JC_ALLOW_FILE_ORIGIN ? env.JC_ALLOW_FILE_ORIGIN === '1' : fileCfg.allowFileOrigin !== false,
    /* 创作 CLI 探测（user_credit）的缓存 TTL。单次实测 8.4–9.5 秒，积分又是低频指标，
       故默认 5 分钟。env JC_DREAMINA_PROBE_TTL_MS 可覆盖。 */
    dreaminaProbeTtlMs: Number(env.JC_DREAMINA_PROBE_TTL_MS || fileCfg.dreaminaProbeTtlMs || 5 * 60 * 1000),
    /* fast 路径下"从未探测过"时允许等待的上限（毫秒）。超过就先用占位返回，
       由前端显示"读取中…"，绝不把一次 9 秒的探测变成用户点击后的等待。 */
    adapterFastWaitMs: Number(env.JC_ADAPTER_FAST_WAIT_MS || fileCfg.adapterFastWaitMs || 2500),
    /* ⚠ 已废弃（2026-09-19 多项目架构升级）：项目归属现在是 request-scoped 的 ——
       由 URL / 查询串携带并由后端校验，后端不存在"当前项目"这种全局配置
       （指令 §3.4 / §34 明确禁止）。这个字段仅为兼容旧 config.json / 环境变量而保留，
       不再参与任何作用域判断；启动时会提示它已失效。 */
    projectId: env.JC_PROJECT_ID || fileCfg.projectId || 'pj_1',
    /* ---------------- 图片资产生图（2026-09-25 · 阶段 2） ----------------
       网页版从这里读密钥（环境变量优先）；桌面版不吃这个字段 ——
       它由 Electron 主进程经 safeStorage 管理，通过 configOverrides 注入
       `imageKeyProvider` 函数（见 server.js 的注入链）。
       ⚠ 这个值**绝不允许**出现在任何响应、日志或前端构建物里
         （计划 §5.3：密钥不出现在页面响应、日志或仓库中）。 */
    workFisherApiKey: env.WORK_FISHER_API_KEY || fileCfg.workFisherApiKey || '',
    /* 服务商基址与模型：留空用 image-provider.js 的内置默认
       （https://api.work-fisher.com 与 workfisher-image-g-v2.5-flare）。
       可覆盖是为了"服务商换域名/换型号"时不必改代码，**不是**给用户配的选项。 */
    imageProviderBase: env.JC_IMAGE_PROVIDER_BASE || fileCfg.imageProviderBase || null,
    imageProviderModel: env.JC_IMAGE_PROVIDER_MODEL || fileCfg.imageProviderModel || null
  };

  if (overrides) Object.assign(cfg, overrides);
  /* port = 0 是合法值（让系统分配空闲端口），所以不能用 port || 8787 兜底 */
  if (!Number.isFinite(cfg.port) || cfg.port < 0 || cfg.port > 65535) cfg.port = 8787;

  runtime.setCurrentConfig(cfg);
  return cfg;
}

module.exports = {
  loadConfig,
  SERVER_DIR,
  PROJECT_ROOT,
  configFilePath,
  /* 用 getter 而不是快照值：桌面版会把数据根指到用户目录，
     任何在 require 时解构这三个值的写法都会拿到错目录。 */
  get DATA_DIR() { return runtime.getDataDir(); },
  get DB_FILE() { return path.join(runtime.getDataDir(), 'db.json'); },
  get LEGACY_OUTPUT_DIR() { return path.join(runtime.getDataDir(), 'output'); },
  get LEGACY_ASSET_DIR() { return path.join(runtime.getDataDir(), 'assets'); }
};
