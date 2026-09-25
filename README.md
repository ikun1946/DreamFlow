# DreamFlow · 即梦批量生成控制台

面向 AI 短剧 / 分镜视频生产的**前后端完整项目**：前端是分镜批量管理工作台，后端是本地桥接服务，通过即梦官方**创作 CLI（`dreamina`）**完成真实视频生成，并可接入 **Work Fisher** 生成素材库图片资产（可选，未配密钥时不出现）。**无任何演示 / 模拟数据**。

- **仓库名 / 产物名**：`DreamFlow`（`git clone` 下来的文件夹也是它；安装包是 `DreamFlow-<版本>-x64-Setup.exe`，主程序 `DreamFlow.exe`）
- **中文产品名**：即梦批量生成控制台（界面标题、托盘、快捷方式显示的都是它）
- **两处仍叫 `JimengConsole`，且刻意保留**：应用 ID（`appId`，决定 Windows 能否原地升级）与数据目录（`%USERPROFILE%\Videos\JimengConsole\`）。这两处界面上都看不到，改名会让老用户以为项目全没了。
- **视频生成引擎**：创作 CLI（`dreamina`），**视频唯一的生成引擎**。画布 CLI（`dreamina-canvas`）已于 2026-09-18 彻底移除。
- **图片资产生图（可选）**：素材库图片可由第三方服务商 **Work Fisher**（模型 `workfisher-image-g-v2.5-flare`）生成。**未配置密钥时该功能完全不可见**，不影响任何既有流程。

> 📖 **本文件只放入门与导航**，深层内容分三处：
> **[docs/项目文档.md](docs/项目文档.md)** —— 完整说明书（结构 / 模块职责 / 依赖图 / 流程 / 配置 / 边界）
> **[docs/CHANGELOG.md](docs/CHANGELOG.md)** —— 完整变更记录（"为什么改、踩过什么坑、影响范围"）
> **[AGENTS.md](AGENTS.md)** —— 红线清单与关键文件地图（AI agent 接手请先读这份）

---

## 当前状态

| 项 | 值 |
| --- | --- |
| 当前版本 | `0.41.0`（唯一生效来源：`package.json`；`README`「当前版本」与 `docs/项目文档.md` 必须同步） |
| 支持平台 | Windows x64（网页版可在任何能跑 Node 18+ 的系统上自建运行） |
| 运行方式 | 网页版 `node server/index.js` → `http://127.0.0.1:8787/`；桌面版 `npm start`（开发）/ `npm run dist`（安装包） |
| 生成引擎 | 视频：`dreamina` 创作 CLI（**唯一**视频生成引擎）；图片资产：Work Fisher 生图（**可选**，未配密钥时功能不可见） |
| 运行时依赖 | **零 npm 依赖**：后端只用 Node 内置模块，前端是原生 HTML/CSS/JS；`electron` / `electron-builder` 只在打包期用到 |
| 自动化测试 | **323 个用例**（`npm test`，Node 内置 test runner） |
| 统一检查 | `npm run check`（16 节 46 项一致性检查）+ `npm run lint`（7 项静态检查） |
| 端到端验收 | `npm run smoke:web`（网页版连通性）、`npm run e2e`（业务流 53 项断言）、桌面版 `JC_DESKTOP_SMOKE=1`（见下） |
| 一键回归 | `npm run verify` = `check` + `lint` + `test` + `build:web` |

**当前已知限制**

- 素材图号表、生成记录快照、积分余额提醒均为**本地单机**语义，不涉及多用户并发与远端同步。
- 积分保护是**提醒式**的：`creditWarnBelow` 只在提交前提醒、不阻断，不保证余额充足。
- 长时间批量生成依赖本地 `dreamina` 登录态；登录失效需重新登录后手动续跑。
- 网页版**没有鉴权**，默认只监听 `127.0.0.1`；`token` 只在需要给同机其它程序访问时开启。

> ⚠ **对外公开分发前的阻塞项尚未全部解决**（签名证书未就位、`dreamina` 再分发授权未确认、干净 Windows 环境验收未做）。具体安装包是否签名须逐件验签；完整清单见 **[AGENTS.md](AGENTS.md)「已知发布阻塞项」**。

---

## 快速开始

```bash
cd DreamFlow
node server/index.js          # 启动后端（零依赖，无需 npm install）
```

浏览器打开 **http://127.0.0.1:8787/** —— 前端由后端托管，同源直连 `/api/v1`。
页面初始为空态，点「批量导入提示词」粘贴多段提示词（`;;` 分隔）即可创建真实分镜。

改完 `app/` 后必须重建发布版，否则 `dist/` 里留的是旧代码：

```bash
node build.js                 # 内联 app/ → dist/ 单文件版（自带四道校验，不通过即报错退出）
```

---

## 两种交付形态

同一份 `app/` 前端 + 同一套 `server/` 服务端，套两种外壳。差异集中在「谁启动服务、监听在哪、数据存哪」：

| | 网页版 | 应用版（Electron） |
|---|---|---|
| 启动方式 | 人工 `node server/index.js` | 双击 exe，主进程自启内嵌服务 |
| 监听端口 | 固定 `8787` | 随机端口（被占用也能启动） |
| 鉴权 | 默认无，可设 `JC_TOKEN` 开启 | 每次启动生成一次性 Token |
| 数据根 | `server/data/`（仓库内） | `%USERPROFILE%\Videos\JimengConsole\`（仓库外） |
| 配置与日志 | `server/config.json`，日志走终端 | `%APPDATA%\即梦批量生成控制台\` |
| 独有能力 | —— | 单实例、托盘常驻、应用内自更新、数据目录可迁移、外部工具自动定位、旧数据导入 |

网页版其实还有个子形态：`dist/` 里的单文件版，双击即用，但**现代 Chrome 会拦掉 `file://` 页面对本机后端的请求**，所以推荐用法仍是上面的 `127.0.0.1:8787`。

> 设计理由（为什么随机端口 + 一次性 Token、为什么数据根不放漫游目录）见 `docs/项目文档.md` §1.4 / §5.1 / §5.2。

---

## Windows 桌面版

```bash
npm install                   # 只为桌面端装 electron 与 electron-builder
npm start                     # 开发态直接起桌面窗口
npm run dist                  # 打 NSIS 安装包（约 106 MB）
npm run pack                  # 只出免安装目录（排障时更快）
npm run icons                 # 重新生成图标
```

**不携带 `dreamina` / `ffmpeg`**：创作 CLI 可在应用内一键安装（不需要 Git Bash）；ffmpeg 需自行安装，只影响封面抽帧与音频时长，不影响生成。

**数据放在哪** —— 桌面版不往安装目录写任何东西（装到 Program Files 后那里只读）：

| 位置 | 放什么 |
|---|---|
| `%APPDATA%\即梦批量生成控制台\` | `desktop-config.json`、`desktop-state.json`（窗口尺寸）、`logs\main.log` |
| `%USERPROFILE%\Videos\JimengConsole\` | `db.json`、`backup\`、`projects\<项目>\{assets,output}\` |

数据根可用 `JC_DATA_DIR` 环境变量覆盖，也可在设置面板里迁移。

**打包后自检**（确认界面真能画出来，而不是只看进程起没起）：

```powershell
$env:JC_DESKTOP_SMOKE=1; $env:JC_SMOKE_DELAY=3000
.\release\win-unpacked\DreamFlow.exe
```

会截图、落一份 DOM 快照、打印数据目录与工具路径，然后自己退出。打包版没有 DevTools，页面一抛异常就是"窗口开了但一片白"——`logs\main.log` 是唯一线索。

> 创作 CLI 的三态安装、应用内自更新的四道安全闸、旧数据导入的实现细节见 `docs/项目文档.md` §5.5 / §5.6。

---

## 目录速览

```
DreamFlow/
├── app/          前端源码（index.html / styles.css / api.js / constants.js / app.js）
├── server/       后端：本地桥接服务（零 npm 依赖）+ 运行时数据 server/data/
├── desktop/      Windows 桌面版（Electron 主进程）
├── dist/         发布版：由 app/ 构建而来，不要手改
├── build/        打包图标（**需入库** —— 源图删了就再也生成不出图标）
├── docs/         文档
├── scripts/      运维与门禁脚本（打包、备份、冒烟、e2e、检查）
└── release/      安装包产物（不入库）
```

**路径约定**：源码只进 `app/`、产物只进 `dist/`、文档只进 `docs/`、脚本只进 `scripts/`、后端只进 `server/`、桌面壳只进 `desktop/`；目录名用 ASCII，文件名可用中文。

> 逐个文件的职责、模块依赖图、「唯一事实来源」清单见 `docs/项目文档.md` §3 / §4。

**层级术语**：`Project`（项目）→ `Workspace`（代码里的名字，**界面上叫「分镜表」**）→ `Storyboard`（分镜）。`Asset`（素材）属于**项目**，所以同一项目下的所有分镜表共享一份素材库。后端**不存在**「当前项目」这种全局变量，作用域一律由 URL 携带并校验。

---

## 注意事项

1. **素材删除不可恢复且不留痕**：`DELETE /assets/{id}` 会同时删掉记录与磁盘图片，且**不写 `records` / `logs`** —— 误删后无法查证是谁、何时删的。`db.json.bak-*` 轮转备份保得住记录，保不住图片。
2. **代码靠 git、数据靠备份脚本** —— `server/data/` 被 `.gitignore` 排除，远端仓库里没有它。其中 `db.json`（分镜 / 素材 / 记录）与 `output/`（真实生成、**花过积分、不可再生成**）丢了就没了：

   ```bash
   bash scripts/backup-data.sh                              # → $HOME/dreamflow-backups/<时间戳>/
   JC_BACKUP_ROOT=/d/backups bash scripts/backup-data.sh    # 换目标位置（建议放到另一块盘）
   JC_BACKUP_KEEP=5 bash scripts/backup-data.sh             # 只保留最近 5 份（默认 10）
   ```

   > 恢复前先停掉 `node server/index.js`，否则运行中的服务会把覆盖回去的数据再写一遍。

3. **取消运行中任务只能停止本地跟踪**（CLI 没有取消命令），即梦侧照常计费。
4. **本地 API 的跨域已收窄到本地 Origin**；`Origin: null`（`file://` 打开发布版）默认放行，可用 `JC_ALLOW_FILE_ORIGIN=0` 关掉。
5. **真实生成需要已开通相应权限的即梦账号**：非会员账号会被服务端拒绝，任务以 `40300` 给出明确原因。
6. 分页控件、登录流程、虚拟滚动均未做（接口签名已按契约实现）。

完整功能边界见 `docs/项目文档.md` §10.1。

---

## 版本

当前版本：**`0.41.0`**

采用语义化版本 `MAJOR.MINOR.PATCH`：**MAJOR** 不兼容变更 · **MINOR** 向后兼容的新增能力 · **PATCH** 缺陷修复与文档更新。

门禁由 `npm test`（323 用例）、`npm run check`（46 项一致性检查）、`npm run lint`（7 项静态检查）、`npm run smoke:web`、`npm run e2e` 组成，`npm run verify` 一键串起。**这些数字由 `check-project.js` 第 16 节自动对账**，对不上就报错，所以不会悄悄过期。

**发版**：完整流程见 **[docs/版本发布与更新流程.md](docs/版本发布与更新流程.md)**。三句话版本：版本号要同步 `package.json`、README「当前版本」与 `docs/CHANGELOG.md` 新条目（另同步锁文件）；tag 要**单独 push**（普通 `git push` 不推 tag）；安装包只走 **GitHub Releases**，绝不进 git。

### 变更记录

完整变更记录见 **[docs/CHANGELOG.md](docs/CHANGELOG.md)**。
