# 第三方组件声明（THIRD-PARTY-NOTICES）

本文件记录「即梦批量生成控制台」（仓库名 DreamFlow，下称"本软件"）所依赖、
调用或打包的第三方组件，以及各自的许可证与分发边界。

> **重要原则：第三方组件的许可证不会自动继承本软件自身的许可证，
> 本软件自身的许可证也不会覆盖第三方组件。**
> 本软件自身的授权条款见仓库根目录的 [`LICENSE`](./LICENSE)。
>
> 你在复制、分发或以任何方式使用下列组件时，必须遵守其各自的许可证。
> 若你的使用场景与某组件的许可证不兼容，责任由你自行承担。

最后更新：2026-09-21（对应本软件 v0.27.0）

---

## 一、随安装包分发的组件

这些组件会被 `npm run dist` 打进 NSIS 安装包，随本软件一起交付给最终用户。

### 1. Electron

| 项目 | 内容 |
|---|---|
| 版本 | `^44.4.3`（`devDependencies`） |
| 许可证 | MIT |
| 版权 | Copyright © Electron contributors；Chromium 部分版权归 The Chromium Authors |
| 用途 | 桌面版宿主运行时（窗口、托盘、IPC、自动更新调用） |
| 分发方式 | **随安装包分发**（Electron 运行时被合并进 `DreamFlow.exe` 与 `resources/`） |
| 义务 | 保留 MIT 许可证与版权声明（已由 electron-builder 自动写入 `LICENSES.chromium.html`） |

### 2. Chromium / Node.js（Electron 内置）

| 项目 | 内容 |
|---|---|
| 许可证 | BSD-3-Clause 及多个第三方许可证 |
| 分发方式 | 随安装包分发（Electron 内置） |
| 义务 | electron-builder 打包时自动生成 `LICENSES.chromium.html`，其中列出全部许可证全文 |

### 3. 应用图标（`build/icon-source.png` → `icon.png` / `icon.ico`）

| 项目 | 内容 |
|---|---|
| 来源 | 本项目自制，由 `scripts/make-icons.js` 生成 |
| 许可证 | 归本软件著作权人所有，适用本软件 [`LICENSE`](./LICENSE) |
| 分发方式 | 随安装包分发 |

---

## 二、调用但不随安装包分发的组件

这些组件由**用户自行安装**在本机，本软件仅通过命令行调用。
**安装包内不包含它们，本项目也不分发它们。**

### 4. 即梦创作 CLI（`dreamina`）

| 项目 | 内容 |
|---|---|
| 来源 | 由字节跳动 / 即梦官方提供（用户自行安装） |
| 许可证 | 归其权利人所有，本项目**未获得任何再分发授权** |
| 用途 | 图片 / 视频生成任务的唯一执行引擎 |
| 分发方式 | ⚠ **不随安装包分发**，不分发给第三方，不打包进 `release/` |

**分发边界说明：**

- 本软件的安装包**不包含** `dreamina` 可执行文件或任何其自带的资源、模型、词典。
- 本项目**不提供** `dreamina` 的下载链接、不镜像其安装源、不转存其二进制。
- 本软件仅在运行时通过 `PATH` 探测该命令，并由用户自行完成安装与登录。
- 使用 `dreamina` 需自行接受其权利人（即梦平台）的用户协议与授权条款，
  并自行确认账号、会员等级、生成额度等条件。

### 5. FFmpeg（`ffmpeg`）

| 项目 | 内容 |
|---|---|
| 来源 | https://ffmpeg.org/（用户自行安装） |
| 许可证 | ⚠ **取决于构建配置**：默认构建通常为 **LGPL-2.1-or-later**；启用 `--enable-gpl` 的构建为 **GPL-2.0-or-later**；若含 `libx264`、`libx265` 等则必为 GPL |
| 用途 | 从生成视频中抽帧，产出封面图 |
| 分发方式 | ⚠ **不随安装包分发**，由用户自行安装 |

**GPL 分发边界说明：**

- 本软件**仅以命令行调用** FFmpeg（独立的进程调用），**不链接**其库、
  **不静态嵌入**其代码、**不修改**其源码。
- 本软件安装包**不包含** FFmpeg 二进制或任何 GPL 组件。
- 因此本软件自身**不会**因调用 FFmpeg 而被 GPL 传染。这是关键的分发边界：
  **边界在进程边界上，不在代码边界上。**
- 若你打算**自行**把 FFmpeg（尤其是 GPL 构建）与本软件一并分发给他人，
  该分发行为即触发 GPL 义务（提供对应源码等），**由你自行承担合规责任**，
  且需注意本国专利许可情况。本项目不建议、不参与此类再分发。

### 6. FFprobe（`ffprobe`）

| 项目 | 内容 |
|---|---|
| 来源 | 随 FFmpeg 一同安装 |
| 许可证 | 与同一构建的 FFmpeg 一致（LGPL-2.1+ 或 GPL-2.0+） |
| 用途 | 读取音频时长，用于音频数量和总时长预算校验 |
| 分发方式 | ⚠ **不随安装包分发**，由用户自行安装 |

缺失 `ffprobe` 时的降级行为见 `server/dreamina-cli.js` 的 `ffprobeStatus()`
与 `server/services.js` 的 `checkAudioBudget()`（错误码 `51105`）。

---

## 三、开发期依赖（不随安装包分发的构建工具）

这些仅在 `npm install` / 打包阶段使用，不会出现在最终安装包中。
完整清单及其许可证见 `node_modules/` 中各包的 `LICENSE` 文件。

| 组件 | 版本 | 许可证 | 角色 |
|---|---|---|---|
| `electron` | `^44.4.3` | MIT | 桌面运行时（其运行时**会**随包分发，见 §1） |
| `electron-builder` | `^26.15.3` | MIT | 打包工具链，**仅供构建期使用** |
| `app-builder-bin` | （`electron-builder` 传递依赖） | MIT | 打包辅助二进制，**仅供构建期使用** |

---

## 四、运行期零依赖说明

本软件的**后端与前端在运行时不依赖任何 npm 包**：

- `server/**` 仅使用 Node.js 内置模块（`fs` / `path` / `http` / `child_process` 等）；
- `app/**` 为原生 HTML / CSS / JavaScript，不使用任何前端框架或 CDN 资源；
- 因此安装包内不含任何 JavaScript 第三方库，不存在前端库的许可证传递问题。

这条约束是刻意保持的，同时也是本项目体积与供应链风险偏低的原因。
若将来引入运行期依赖，必须同步更新本文件。

---

## 五、字体与素材

- 应用界面**不使用**任何外部字体文件，统一走系统字体栈
  （Windows 下回退到 `Segoe UI` / `Microsoft YaHei`），因此不涉字体授权。
- 安装包内**不含**任何图片素材、音乐、音效或模型文件。
- 用户通过本软件生成或导入的素材，其授权状态由用户自行确认，本项目不参与。

---

## 六、许可证全文获取

| 许可证 | 全文地址 |
|---|---|
| MIT | https://opensource.org/licenses/MIT |
| BSD-3-Clause | https://opensource.org/licenses/BSD-3-Clause |
| LGPL-2.1-or-later | https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html |
| GPL-2.0-or-later | https://www.gnu.org/licenses/old-licenses/gpl-2.0.html |

Electron 及其内置组件的许可证全文，由 electron-builder 在打包时
自动汇集为 `LICENSES.chromium.html` 并置于安装包内（`resources/` 旁），
可通过安装后的程序目录查看。
