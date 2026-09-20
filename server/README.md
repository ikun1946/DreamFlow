# server/ · 本地桥接服务

按 [`../docs/后端服务设计方案.md`](../docs/后端服务设计方案.md) 实现的后端：承载前端接口契约，通过**创作 CLI（`dreamina`）**完成真实视频生成。**项目无任何演示/模拟数据**——空库启动，数据一律来自真实数据流（批量导入 / 接口创建）。

> ⚠ 2026-09-18 画布 CLI（`dreamina-canvas`）已彻底移除，本项目只有这一个生成引擎；历史上依赖画布 CLI 的能力（画布节点引用、报价→确认的积分安全阀）随之下线。

## 运行

```bash
node server/index.js
# API      http://127.0.0.1:8787/api/v1
# 应用首页 http://127.0.0.1:8787/          ← 前端直连本服务（同源 /api/v1）
```

零 npm 依赖（Node ≥ 20 内置模块实现），无需 `npm install`。前端也可以 `node build.js` 构建出 `dist/` 单文件版，双击打开会自动连到 `http://127.0.0.1:8787/api/v1`（跨源由后端 CORS 放行）。

## 配置（可选）

环境变量优先，其次 `server/config.json`，最后内置默认：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` / `host` | `8787` / `127.0.0.1` | 监听地址 |
| `token` | 空（不校验） | 设置后 `/api/v1/*` 要求 `Authorization: Bearer <token>` |
| `dreaminaCliPath` | `dreamina` | 创作 CLI 可执行文件路径（唯一的生成引擎） |
| `creditWarnBelow` | `50` | 积分余额提醒阈值：余额低于它时提交前提醒（替代原画布链路的 `creditCeiling` 报价安全阀） |
| `dreaminaPollMs` | `900000` | 单任务等待窗口（即梦队列高峰期可达数十万条，15 分钟等不到是常态；超时不丢 submit_id，可事后续查） |
| `maxConcurrencySafety` | `0`（不限制） | **可选的本地保护上限**：设 >0 时才限制并发数（保护本机进程数用）；设 0 表示不限制 |
| `ffmpegPath` | `ffmpeg` | 产物封面（视频抽帧）用；**可选**，缺失时封面静默跳过 |
| `ffprobePath` | `ffprobe` | 读**音频素材时长**用；**可选**，与 ffmpeg 一起分发。读不到时长时该音频不允许绑定（见下） |
| `audioTotalSecMax` | `15` | 单个分镜上「音频参考」的**总时长**上限（秒）。与模型的数量上限（`limitsFor(model).audio`）**同时生效** |

> 并发数**不设人为上限**：即梦侧无公开的并发上限，真实配额由即梦服务端在运行时裁决——超出时服务端会拒绝并返回限流错误，后端已将其映射为明确的限流提示。`meta/options` 下发的 `settings.concurrency.max = 0` 即表示不限制（仅当配置了本地保护上限 `maxConcurrencySafety` 时才有具体值）。

## 生成引擎（创作 CLI，唯一引擎）

⚠ 2026-09-18 画布 CLI（`dreamina-canvas`）已彻底移除，系统只有**创作 CLI（`dreamina`）**一个生成引擎，路由恒为 `dreamina`。

- 可用模型（= 创作 CLI `text2video --model_version` 支持集，唯一事实来源 `server/models.js`）：`seedance2.0` / `seedance2.0fast` / `seedance2.0_vip` / `seedance2.0fast_vip` / `seedance2.0mini` / `seedance2.5`。
- **历史画布域名自动迁移**：旧数据里的 `seedance_2.0_vip` → `seedance2.0_vip`、`seedance_2.0_fast_vip` → `seedance2.0fast_vip`、`seedance_2.0_mini` → `seedance2.0mini`、`seedance_2.5` → `seedance2.5`（同一底层模型，无损改名）。
- **已下线模型**：`happyhorse_1.1` / `minimax_h3` / `wan_3.0` / `seedance_pro_fast` 仅画布 CLI 可用，创作 CLI 无对应型号 —— 存量分镜会被自动迁移到可用模型并写日志留痕。
- **积分安全阀替代**：原画布链路的「报价→确认 creditCeiling」下线，改为**提交前余额提醒**（`creditWarnBelow`，前端二次确认 + 任务日志留痕）。
- 提交前会按模型能力校验/适配并**写入任务日志留痕**（`seedance2.5` 支持 480p/720p/1080p + 4-30s + 纯音频参考；`seedance2.0_vip` 支持 4K；其余仅 720p + 4-15s）。

## 干跑自检（不连服务端 / 不扣费）

三种路径，都不会创建生成任务、不会消耗积分：

| 方式 | 用途 | 说明 |
|---|---|---|
| 页面 **「干跑提交」**（推荐） | 在页面上提交并核对真实命令 | 与正式提交**完全同一条链路**（同接口、同 worker、同组装出口），只多传 `dryRun:true`；worker 组装命令后不 spawn，命令写入分镜 `dryRunPlan`，前端自动弹出「干跑命令核对」弹层逐条展示。批次级、无需重启、不污染全局。详见 `docs/干跑测试指南.md` |
| `POST /api/v1/storyboards/{id}/dry-run` | 单条只读预览 | 返回路由结果 + 将执行的完整 argv/命令行。不提交、不改任务状态、不连服务端、不扣费。（原「画布 CLI 本地校验」依赖画布专属的 `--dry-run`，随画布 CLI 一并移除） |
| `JC_DRY_RUN=1 node server/index.js` | 全服务干跑 | worker 照常组装命令并写日志，但**不 spawn**；任务结束回到「未提交」。**用完必须去掉该变量**，否则所有任务（含正式提交）都不会真正执行——页面状态栏会显示「干跑模式」徽标作为提醒 |

> 命令组装只有一个出口（`worker.js` 的 `planFor()`），worker 派发与干跑校验共用，保证"展示的命令 == 实际执行的命令"。

## 生成链路（唯一链路，无模拟）

队列按 `queue.concurrency` 把 `queued` 任务派发给 worker：**派发前先把任务落库**，再由创作 CLI 适配层组装并执行 `dreamina text2video` / `multimodal2video`；拿到 `submit_id` 后轮询 `query_result` 至 `gen_status` 终态，产物经 `query_result --download_dir` 落盘并由 /files/ 提供。服务重启导致的本地跟踪中断由启动清理收尾（标失败 + 保留 submit_id 供续查，绝不自动重扣积分）。

## 目录

```
server/
├── index.js      入口：HTTP 服务、静态/首页路由、worker 调度
├── routes.js     /api/v1 路由表（接口 + Idempotency-Key）
├── services.js   业务逻辑（契约行为与 docs/前端页面与接口对接说明.md 逐条对齐）
├── worker.js     派发 worker（队列调度 / 单条任务 / 干跑 / 孤儿清理）
├── dreamina-cli.js  创作 CLI 适配层（探测缓存 / 参数组装 / 轮询 / 下载）
├── models.js     模型注册表（名称归一 / 能力边界 / 路由唯一事实来源）
├── store.js      JSON 持久化（原子写），空库启动
├── util.js       统一信封 / ApiError / 工具
├── config.js     配置加载
└── data/         运行时数据（db.json / backup/ / projects/<项目>/），不入库
```

## 已知边界

- 模型能力（分辨率 / 画幅 / 时长）来自 `server/models.js` 内建能力表（取自 CLI 官方 `-h` 输出）；越界参数按就近档位调整并写入任务日志。
- 素材通过创作 CLI 的 `--image` / `--audio` 直接引用本地文件（原画布 `--ref node:` 引用方式已随画布 CLI 移除）。素材上传接口已随占位功能一并移除，素材库当前无新增入口（绑定/解绑逻辑保留，素材存在时即用）。
- 取消运行中任务只能停止本地跟踪（CLI 无取消命令），即梦侧照常计费——接口 message 中已如实提示。
