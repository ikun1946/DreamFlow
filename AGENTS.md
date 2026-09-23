# AGENTS.md —— 给 AI agent 的项目约定

> 本文件是**任何 agent 接手本仓库时的第一份必读**。人也可以看，但它主要写给 agent。
> 最后核对：2026-09-23（版本 `v0.32.0`）
> 看完整变更记录：[docs/CHANGELOG.md](docs/CHANGELOG.md)（0.29.0 → 最新）。
>
> 📖 **想「通读一遍就完整理解项目」** → 读 `docs/项目文档.md`（定位 / 结构 / 目录职责 / 模块依赖 / 主要流程 /
> 配置运行 / 数据 / 接口 / 收尾清单 / 边界 / 事故注释索引 / 文档地图）。本文件保留 agent 最需要的短契约。

## 这个项目是什么

**DreamFlow**（中文产品名：即梦批量生成控制台）—— 面向 AI 短剧 / 分镜视频生产的分镜批量管理工作台。
GitHub 仓库名与 clone 下来的文件夹名都是 `DreamFlow`；界面上显示的中文名仍是「即梦批量生成控制台」。
两种交付形态，**共用同一份前端与后端业务代码**：

1. **网页版**：`node server/index.js` → 浏览器打开 `http://127.0.0.1:8787/`
2. **Windows 桌面版**：Electron 壳（`desktop/`）内嵌同一个服务，`npm start` 跑开发态，`npm run dist` 出 NSIS 安装包

技术栈刻意保持**零运行时依赖**：后端只用 Node 内置模块，前端是原生 HTML/CSS/JS。`package.json` 里的 electron / electron-builder 只是**打包期**依赖，不要往 dependencies 里加运行时库。

## 完成一项工作后的固定动作（Definition of Done）

**每完成一件工作，收尾时按这个清单走一遍。顺序有意义，别跳步。**

1. **改完 `app/` 必须重建网页版**：`node build.js`。脚本自带校验（`$$` 是否被吞、script/style 块数量、有无残留外部引用），不通过会报错退出。忘了这步，`dist/` 里留的就是旧代码。
2. **真跑一遍才算完成**：`npm run verify`（check + test + build）全绿只是**入场券**，**"语法通过"不等于"能用"**。改 UI 就 `npm start` 或跑 `npm run smoke:web` / `npm run e2e` 实际点一遍；改后端就发真实请求验证。**不要把"应该能跑"当结论。**
3. **更新版本号（两处三地）**：`package.json`（唯一生效来源）+ `README.md` 的「当前版本」+「变更记录」。新增能力 → MINOR，修缺陷 / 改文档 → PATCH。
4. **写变更记录**：在 README「变更记录」顶部加一段。**写清"为什么改"和"踩过什么坑"**，不要只写"优化了 X" —— 这段是后来者唯一的上下文来源。
5. **同步受影响的文档**：改了接口 → 更新 `docs/前端页面与接口对接说明.md`；改了发布方式 → 更新 `docs/版本发布与更新流程.md`；**任何会改变架构描述的改动，都要在 `docs/更改文档.md` 留痕**（这份文档历史上就因为漏记而落后过好几个版本，2026-09-21 才补回来）；**改了本清单本身 → 同步 `docs/项目文档.md` §9**（两处内容必须一致，不一致时以本文件为准）。
6. **提交并推送**：`git add -A` → `git commit` → `git push origin main`。
7. **发版（可选，取决于是否要交付给使用者）**：见 `docs/版本发布与更新流程.md`。两个最容易忘的点：tag **必须单独 push**（`git push origin vX.Y.Z`，普通 push 不推 tag）；安装包只走 GitHub Releases，**绝不进 git**。

> ⚠️ **"做完但还没发版"也要在第 3 步登记版本号** —— 否则会出现"代码已经在 main 上、却没有任何版本号"的状态。2026-09-21 真实发生过一次（导入资产预览那批）。发版与否是第 7 步单独决定的，不影响第 3 步。

> 📄 同一份清单也镜像在 `docs/项目文档.md` §9（供通读者一次看完）。**改本清单请同步那处** —— agent 会自动加载本文件，不一定会读 `docs/`，所以两处不一致时以本文件为准。

## 要发版？先读这一篇

**`docs/版本发布与更新流程.md`** —— 完整流程（改版本号 → 打包 → 验证 → 提交 → 打 tag → 建 Release → 上传安装包），含使用者如何下载更新、数据安全与回滚、红线清单。

发版相关的三件事，一句话版本：

1. 版本号要同步**两处三地**：`package.json`（唯一生效来源）+ `README.md` 的「当前版本」+「变更记录」
2. tag 必须**单独 push**：`git push origin vX.Y.Z`（普通 `git push` 不推 tag）
3. 安装包只走 **GitHub Releases**，绝不进 git（`release/` 已 gitignore）

## 红线（违反会造成不可恢复的损失）

| 不要做 | 原因 |
|---|---|
| 不要提交 `server/data/` | 那是运行数据（含用户素材与视频），且已 gitignore |
| 不要提交 `release/` | 上百 MB 二进制，会把仓库撑爆 |
| 不要删 `build/icon-source.png` / `icon.png` / `icon.ico` | 源图删了就**再也生成不出**图标；产物删了 `npm run dist` 会失败。三者都已入库 |
| 不要删用户的 `db.json` 或 `projects/` | 用户的全部数据，**不可恢复** |
| 不要在应用里嵌 GitHub 令牌 | 安装包可解压，等于把仓库访问权交出去（公开库读权限虽已开放，令牌可能带写权限） |
| 不要往安装目录写数据 | 装到 Program Files 后那里只读；数据必须走用户目录 |
| 不要用真实数据做测试 | 测试请用 `JC_DATA_DIR` 指到临时目录，别碰 `server/data` |

## 常用命令

```bash
node server/index.js    # 网页版：起服务（零依赖，无需 npm install）
node build.js           # 把 app/ 内联成 dist/ 单文件网页版（改了 app/ 必须跑）
npm install             # 只在要跑桌面版时需要
npm start               # 桌面版开发态
npm run dist            # 出 NSIS 安装包 → release/
npm run pack            # 只出免安装目录 → release/win-unpacked/
npm run icons           # 由 build/icon-source.png 重新生成图标（build/icon.png、icon.ico、app/icon.png）
```

桌面版冒烟自检（打包后也能用）：

```powershell
$env:JC_DESKTOP_SMOKE=1; $env:JC_SMOKE_DELAY=3000
.\release\win-unpacked\DreamFlow.exe
```

判断标准：日志出现 `[smoke] OK`，且 `views` 里对应视图**高度不为 0**（高度 0 = 页面其实空白，历史上真出过这个 bug）。

## 测试与验证（重要）

**2026-09-21 起，本仓库已恢复一套最小但完整的自动化测试**（此前 2026-09-20 按用户要求删除过，同日晚些时候随"项目审查整改"一并补回）。历史文档里"仓库没有自动化测试"的表述**已作废**。

三档，各管一段，都要跑：

| 命令 | 管什么 | 现在的状态 |
|---|---|---|
| `npm test` | 单元 / 集成：`test/*.test.js`（数据安全 / 任务逻辑 / 构建发布 / 路由 / 队列 / CSP / cliJobs / a11y / 错误码四件套 九组） | **156 用例全通** |
| `npm run check` | 一致性门禁：`scripts/check-project.js`（版本漂移、dist 同步、图标、许可、更新器、旧名残留、过期表述、收尾清单一致性、docs 状态标记、路由计数、git remote、文档数量口径…） | **44 项全通** |
| `npm run lint` | 静态检查：`scripts/lint.js`（语法 / `debugger` / 前端调试输出 / 相对 require 目标 / 插值告警 / TODO 残留 / 未定义模块内调用） | **7 项全通** |
| `npm run smoke:web` | 网页版连通性：起真服务 → 首页 / 接口 / 鉴权 / 边界 → 关停无残留 | 通过 |
| `npm run e2e` | 端到端业务流：建项目 → 工作区 → 素材（元数据 + 上传）→ 分镜（创建 + 时长钳制）→ 提示词导入 → 绑定/解绑 → 干跑 → 硬删除预检 → 彻底删除 + 归档 + 审计 → 磁盘一致性 | **53 项断言全通** |
| `npm run verify` | 一键：`check` + `lint` + `test` + `build:web` | — |

**为什么 smoke 与 e2e 要分开**：smoke 的失败原因（服务起不来、端口没释放）与 e2e 的失败原因（业务链断裂、归档定位不到）几乎不重叠。混在一起看会互相干扰，也定位不到是哪一层坏了。

**仍然必须手工验的两件事**（自动化覆盖不到）：

- 改了 `app/` → `node build.js` 重建 `dist/`（构建脚本自带校验；`npm run check` 的 §2 会查"改了源码没重建"）
- 发版前 → **真装一次**安装包（免安装目录跑得通 ≠ 安装器没问题；干净 Windows 环境验收见 README「当前状态」）

⚠ **测试的数据隔离铁律**：`smoke:web` 与 `e2e` 都**强制**把 `JC_DATA_DIR` 指到仓库内 `.test-tmp/`，并在结束时删掉。它们**绝不允许**落到 `server/data`（会污染真实数据）。写新测试时同样遵守这一条，且临时目录要建在仓库内 —— Git Bash 下 `/tmp` 会被解析成 `C:\tmp\...` 而 ENOENT。

## 代码风格约定（照现有代码写，别另起一套）

- **注释用中文，且要解释「为什么」**，不是「这行在做什么」。这个仓库的注释密度很高，很多是**事故注释**（记录"以前这样写踩过什么坑"），改代码时**不要删掉它们** —— 那是防止同一个坑踩第二次的唯一记录
- 涉及数据路径、进程生命周期、安全边界的地方，改动前先读该文件顶部的块注释，那里通常已经解释了设计取舍
- 新增文件时在顶部写一段块注释说明职责与关键约束
- 关键设计只保留**一个事实来源**（如 `desktop/runtime-paths.js` 管目录布局、`server/paths.js` 管资源 URL 形状），不要在别处复制一份

## 关键文件地图

| 文件 | 职责 |
|---|---|
| `app/` | 前端源码（`index.html` / `styles.css` / `api.js` / `app.js`） |
| `server/server.js` | 可启停的服务模块（`createServer()` → `{start, stop, url}`） |
| `server/index.js` | 网页版命令行入口 |
| `server/runtime.js` | 运行模式 / 数据根 / 生效配置的唯一持有者 |
| `server/paths.js` | 磁盘布局与资源 URL 形状的唯一事实来源 |
| `server/cli-installer.js` | 创作 CLI 的下载 / 安装 / 更新（走官方 CDN，**不内置二进制**） |
| `server/store.js` | JSON 持久化（原子写、滚动备份、迁移前备份） |
| `server/schema.js` | schemaVersion 与迁移框架（旧库升级唯一入口） |
| `desktop/main.js` | Electron 主进程（单实例、窗口、托盘、优雅退出） |
| `desktop/runtime-paths.js` | 桌面版目录布局唯一事实来源 |
| `desktop/legacy-import.js` | 旧版数据导入 + 完整性体检 |
| `desktop/updater.js` | 应用自更新：检查 / 下载 / 校验 / 静默安装 / 自动重启 |
| `electron-builder.yml` | 安装包配置 |

## 数据放在哪（桌面版）

| 位置 | 内容 |
|---|---|
| `%APPDATA%\即梦批量生成控制台\` | 配置、窗口状态、`logs\main.log` |
| `%USERPROFILE%\Videos\JimengConsole\` | `db.json`、`backup\`、`projects\<项目>\{assets,output}\` |

刻意分开：视频动辄几个 GB，不能放进会被云同步拖走的漫游目录。数据根可用 `JC_DATA_DIR` 覆盖（测试隔离、换盘都靠它）。

## 创作 CLI 的安装能力（改动前必读）

应用内可以**一键安装 / 更新创作 CLI**（`server/cli-installer.js`，走官方 CDN）。这不是"顺手加的功能"：**没有 CLI 这个应用完全不可用**，而官方唯一的安装方式 `curl -s https://jimeng.jianying.com/cli | bash` 在干净的 Windows 上根本跑不了 —— 那个脚本的 Windows 分支要求 MINGW / MSYS / CYGWIN（即 Git Bash）。

**三条不能破的约束**（破了会分别踩到授权、互操作性、数据损坏三类问题）：

1. **绝不把 dreamina 二进制打进安装包。** 再分发授权至今未确认。必须保持"运行时从官方 CDN 下载"——用户从官方源拿，应用只是搬运，分发主体没变。
2. **装到 `%USERPROFILE%\bin\dreamina.exe`**（官方安装脚本用的默认位置），**不要**装进应用自己的目录。否则手工装的、应用装的会变成两份互不知道的 CLI，用户更新了其中一份，另一份还在用旧的。
3. **更新前必须备份旧文件、下载后必须校验是合法 PE。** CDN 出问题时可能返回一个 HTML 错误页；不校验就覆盖，等于把用户原本能用的 CLI 弄坏。

**两个容易搞混的判据**（历史上都错过）：

- **"装没装"要看 spawn 能不能起来**，不能看某个文件在不在。曾经读 `~/.dreamina_cli/version.json` 判断，结果 exe 不存在时照样报"已安装但未登录"，把用户引去查登录问题。
- **版本号有两个来源，不要混用**：exe 自己报的是 commit（`dreamina version` → `ec1b9fa`），官方 `version.json` 报的是语义版本（`1.4.18`）。前者是"本机在跑的构建"，后者是"官方当前发布版"。

## 应用内更新（改动前必读）

桌面版能在应用内完成更新：**检查 → 下载 → 校验 → 静默安装 → 自动重启**。实现在 `desktop/updater.js`；界面在设置抽屉的「应用更新」卡片，另有托盘菜单入口。

**为什么不用 electron-updater**：自更新需要的只有"知道最新版、下载、调安装器"三件事，而 electron-builder 的 NSIS 安装器**本来就支持**这三个开关（依据：`NsisTarget.js` 里的 `flags(["updated","force-run",...])`）。本仓库坚持零运行时依赖，不为此再引一个。

**四条不能破的约束**：

1. **只接受 https**（本地目录模式除外）。更新源是用户可配的；允许 http 就等于让链路上任何人替换"最新版是什么" —— 而那个结果是**会被执行的 exe**。
2. **下载后必须校验 sha512**。`latest.yml` 里带着 electron-builder 生成的哈希，边下边算（不额外读一遍磁盘）；校验不过就丢弃，**绝不交给安装器**。
3. **安装器必须用 `/S --updated --force-run` 调起**，三个都不能少：少 `--updated` 可能删掉用户数据（安装脚本明确依赖它）；少 `--force-run` 用户装完看不到任何变化（辅助式安装器只在"静默 + force-run"时才重启）；少 `/S` 会弹安装界面。
4. **令牌只进不出**。`update:setSource` 接受令牌，但 `update:status` 只回传 `hasToken` 布尔值 —— 不把已存的密钥回传给页面；跨域重定向时丢掉 `Authorization` 头（GitHub 附件下载会 302 到对象存储）。

**更新源三种模式**：`github`（默认；**本仓库已公开，匿名可读，无需令牌** —— 私有库才必须配只读令牌）/ `url`（公开 CDN 或自建静态站）/ `local`（离线、内网、开发机自测）。local 模式也要走"复制 + 校验"，不能直接执行源文件 —— 校验与实际执行之间不能留时间窗。

**自动化测试真实应用时的坑**（2026-09-21 踩到）：必须先让 `desktop-config.json` 里 `legacyImportChecked: true`，否则首次启动会弹**旧数据导入对话框**并阻塞窗口创建。表现是调试端口 `/json` 一直返回 0 个目标、应用日志停在"外部工具"那一行 —— 看起来像"应用起不来"，实际是在等用户点按钮。

## 已知发布阻塞项（2026-09-21 复核）

对外公开分发前必须处理。**前两项已落地，后三项仍未解决** —— 别把"已配置"当成"已可用"：

1. ~~仓库**没有 `LICENSE``~~ → **已解决**：新增 `LICENSE`（专用协议，明确禁止再分发）+ `THIRD-PARTY-NOTICES.md`（六节：随包分发 / 调用但不分发 / 开发期依赖 / 运行期零依赖 / 字体素材 / 全文获取）；`package.json` 的 `license` 字段改为 `SEE LICENSE IN LICENSE`；两者已写入 `electron-builder.yml` 的 `files`，随包分发。
2. `dreamina.exe` 未签名、**未确认允许再分发** → 因此**不内置**，改为运行时从官方 CDN 下载（见上一节；这不改变分发主体，但"官方是否允许"这个问题本身仍未答复）。
3. FFmpeg 是 **GPL 构建**且单个约 212 MB → 同样未内置。合规路径锁定为"**只调用、不分发**"，已在 `THIRD-PARTY-NOTICES.md` 写明边界在**进程边界**上、不在代码边界上。
4. ~~安装包**无代码签名**`~~ → **已配置，但证书未就位**：`electron-builder.yml` 加了 `signAndEditExecutable: true` + `signtoolOptions`（sha256 / publisherName / RFC3161 时间戳），配套 `scripts/check-signing.js`（自检 / `--verify` 逐文件验签 / `--require` 发布卡点）。**证书与密码只走环境变量** `CSC_LINK` + `CSC_KEY_PASSWORD`，绝不入库；**未配置时构建仍会成功**（开发机通路），所以正式发布前**必须**跑 `node scripts/check-signing.js --require` 卡住。
5. **干净 Windows 环境验收未做**：安装包在无 Node、无缓存的干净机器上的**首次安装 / 首启 / 升级 / 卸载**四步，尚未在真实干净环境完整跑过。

## 仓库是公开的（2026-09-21 起）

`https://github.com/ikun1946/DreamFlow.git` 是**公开库**（2026-09-21 由私有改为公开；匿名访问 API 返回 200）。这决定了四件事：

- Release 附件**可匿名下载**（任何人拿到链接即可下安装包）—— 但 `LICENSE` 明确**禁止再分发**：公开可见 ≠ 可再分发，把安装包转给他人仍属需要自行判断的边界
- **应用自身可以匿名读取 Release 信息** → 应用内更新的 `github` 模式**无需令牌**；私有库才必须配只读令牌（见 `docs/版本发布与更新流程.md` §6）
- **写权限仍只属于仓库所有者**：公开只放开"读"，提交与推送依然需要你自己的凭据（PAT 或 SSH key）
- ⚠ 公开库默认**允许 fork**（实测 `allow_forking: true`），而本仓库 `LICENSE` 写明未经许可不得复制分发 —— 若不希望被 fork，需到 Settings → General 底部关闭 Allow forking（网页操作，需要管理员身份）
