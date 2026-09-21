# AGENTS.md —— 给 AI agent 的项目约定

> 本文件是**任何 agent 接手本仓库时的第一份必读**。人也可以看，但它主要写给 agent。
> 最后核对：2026-09-21（版本 `v0.25.0`）

## 这个项目是什么

**即梦批量生成控制台** —— 面向 AI 短剧 / 分镜视频生产的分镜批量管理工作台。两种交付形态，**共用同一份前端与后端业务代码**：

1. **网页版**：`node server/index.js` → 浏览器打开 `http://127.0.0.1:8787/`
2. **Windows 桌面版**：Electron 壳（`desktop/`）内嵌同一个服务，`npm start` 跑开发态，`npm run dist` 出 NSIS 安装包

技术栈刻意保持**零运行时依赖**：后端只用 Node 内置模块，前端是原生 HTML/CSS/JS。`package.json` 里的 electron / electron-builder 只是**打包期**依赖，不要往 dependencies 里加运行时库。

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
| 不要删 `build/icon.png` / `icon.ico` | 打包的输入，删了 `npm run dist` 会失败 |
| 不要删用户的 `db.json` 或 `projects/` | 用户的全部数据，**不可恢复** |
| 不要在应用里嵌 GitHub 令牌 | 安装包可解压，等于公开私有仓库读权限 |
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
npm run icons           # 重新生成图标
```

桌面版冒烟自检（打包后也能用）：

```powershell
$env:JC_DESKTOP_SMOKE=1; $env:JC_SMOKE_DELAY=3000
.\release\win-unpacked\JimengConsole.exe
```

判断标准：日志出现 `[smoke] OK`，且 `views` 里对应视图**高度不为 0**（高度 0 = 页面其实空白，历史上真出过这个 bug）。

## 测试与验证（重要）

**本仓库不保留自动化测试**（2026-09-20 按用户要求删除，见 README「版本」一节）。历史文档里写的 `node --test server/*.test.js → N/N 通过` 是**当时的真实记录**，那些文件已经不在仓库里了，不要再照着跑。

现在的回归方式：

- 改完后端 / 前端 → 手工验收关键流程
- 改了 `app/` → 必须 `node build.js` 重建 `dist/`，构建脚本自带校验
- 改了桌面端 → 跑上面的冒烟自检
- 发版前 → **真装一次**安装包（免安装目录跑得通 ≠ 安装器没问题）

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

**更新源三种模式**：`github`（默认，**私有库必须配令牌**）/ `url`（公开 CDN 或自建静态站）/ `local`（离线、内网、开发机自测）。local 模式也要走"复制 + 校验"，不能直接执行源文件 —— 校验与实际执行之间不能留时间窗。

**自动化测试真实应用时的坑**（2026-09-21 踩到）：必须先让 `desktop-config.json` 里 `legacyImportChecked: true`，否则首次启动会弹**旧数据导入对话框**并阻塞窗口创建。表现是调试端口 `/json` 一直返回 0 个目标、应用日志停在"外部工具"那一行 —— 看起来像"应用起不来"，实际是在等用户点按钮。

## 已知发布阻塞项（**尚未解决**）

对外公开分发前必须处理，别当成已经完成了：

1. 仓库**没有 `LICENSE`**
2. `dreamina.exe` 未签名、**未确认允许再分发** → 因此**不内置**，改为运行时从官方 CDN 下载（见上一节；这不改变分发主体，但"官方是否允许"这个问题本身仍未答复）
3. FFmpeg 是 **GPL 构建**且单个约 212 MB → 同样未内置
4. 安装包**无代码签名** → 使用者首次安装会看到 SmartScreen 警告

## 仓库是私有的

`https://github.com/ikun1946/jimeng-console.git` 是**私有库**（未登录访问 API 返回 404）。这决定了两件事：

- Release 附件下载需要登录且要有仓库权限，不能匿名分享
- **应用自身无法匿名读取 Release 信息** → 全自动更新在私有库上需要额外方案，详见 `docs/版本发布与更新流程.md` §6
