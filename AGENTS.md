# AGENTS.md —— 给 AI agent 的项目约定

> 本文件是**任何 agent 接手本仓库时的第一份必读**。人也可以看，但它主要写给 agent。
> 最后核对：2026-09-20（版本 `v0.22.0`）

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
| `server/store.js` | JSON 持久化（原子写、滚动备份、迁移前备份） |
| `server/schema.js` | schemaVersion 与迁移框架（旧库升级唯一入口） |
| `desktop/main.js` | Electron 主进程（单实例、窗口、托盘、优雅退出） |
| `desktop/runtime-paths.js` | 桌面版目录布局唯一事实来源 |
| `desktop/legacy-import.js` | 旧版数据导入 + 完整性体检 |
| `electron-builder.yml` | 安装包配置 |

## 数据放在哪（桌面版）

| 位置 | 内容 |
|---|---|
| `%APPDATA%\即梦批量生成控制台\` | 配置、窗口状态、`logs\main.log` |
| `%USERPROFILE%\Videos\JimengConsole\` | `db.json`、`backup\`、`projects\<项目>\{assets,output}\` |

刻意分开：视频动辄几个 GB，不能放进会被云同步拖走的漫游目录。数据根可用 `JC_DATA_DIR` 覆盖（测试隔离、换盘都靠它）。

## 已知发布阻塞项（**尚未解决**）

对外公开分发前必须处理，别当成已经完成了：

1. 仓库**没有 `LICENSE`**
2. `dreamina.exe` 未签名、**未确认允许再分发** → 桌面版只检测、不内置
3. FFmpeg 是 **GPL 构建**且单个约 212 MB → 同样未内置
4. 安装包**无代码签名** → 使用者首次安装会看到 SmartScreen 警告

## 仓库是私有的

`https://github.com/ikun1946/jimeng-console.git` 是**私有库**（未登录访问 API 返回 404）。这决定了两件事：

- Release 附件下载需要登录且要有仓库权限，不能匿名分享
- **应用自身无法匿名读取 Release 信息** → 全自动更新在私有库上需要额外方案，详见 `docs/版本发布与更新流程.md` §6
