# 变更记录

> 状态：现行（0.29.0 → 最新，0.29.2 起所有变更都在这里）

> 本文件由 0.29.2 从 README.md 整体迁移过来（阶段 3 第 2 刀 / 错误码四件套之外的下一步：README 瘦身）。
>
> 之前 README.md 在「## 版本」一节里挂了 11 个版本的完整变更记录（**约 600 行**），与 README 的"入门 + 跑起来 + 注意事项"职责混在一起。
>
> 现在：
> - **README.md** —— 只留**入门 / 跑起来 / 注意事项**；当前版本与"看 CHANGELOG"两个指针放最顶。
> - **本文档** —— 完整变更记录，**所有版本从 0.29.0 → 最新**都在这里（0.29.0 之前的记录在 `docs/更改文档.md`，那是 0.17.1 起的旧版变更日志，本文档不重复收录）。
> - **AGENTS.md** —— agent 自动加载的短契约；首行加一句"看完整变更：docs/CHANGELOG.md"。

---

#### `0.37.1` — 2026-09-24（修复：提示词导入的资产名称被截成 60 字描述片段）

**现象**：使用者粘贴《最后一瓶牛奶》提示词文件（`asset-image-prompt-builder` 产出）导入资产，
8 个资产的名称全部是一段 60 字的提示词原文片段，而非"林夏 / 阿哲 / 便利店 / 牛奶瓶"这样的名字。
例如角色那条：`林夏，22岁，身高约165公分；女性；…；身形`（正好 60 字）。

**根因（已用真实代码 + 真实文件复现）**：`guessPromptAssetName()` 的名称提取跟不上格式演进。

- **角色分支压根没有名字隔离逻辑**：`/角色描述信息如下[：:]\s*([^\n]+)/` 捕获的是冒号后**整行**，
  直接 `.slice(0, 60)`。角色描述是一整行 280 字，于是取了前 60 字。
- **场景/道具分支的隔离对新格式无效**：唯一手段是 `.split('｜')[0]`，而新格式行内没有「｜」
  → 切分形同未做 → 整行 → 60 字截断。

为什么失配：解析器是按**旧导出格式**（`_asset_prompts_out.txt`：场景/道具 = `名称｜…`、
角色 = `【姓名】`）写的；新格式把名字**内联**进了描述行
（`角色描述信息如下：林夏，22岁，…`，分隔符是 ，/。/；），旧规则匹配不到 → 走兜底截断。
**8 个资产（3 角色 + 2 场景 + 3 道具）全部命中，不止使用者报的那一条。**

**修复**：新增 `promptNameFromLine(line)` —— 先按旧格式「｜」取首段（**旧格式行为不变**），
再按新格式的名字终止符（`，。；,;.`）切出首个词块；取空返回 `null` 走原有兜底
（未命名场景 / 未命名道具 / 角色群像）；仍按 `ASSET_NAME_MAX`(60) 截（`createAsset` 的库约束）。

**验证**：`lint` 7/7 · `test` **209/209**（新增 8 个回归用例：新格式三种类型 + 旧格式
「名称｜…」与「【姓名】群像」回归 + 无分隔符 + 超长截断 + 含 ```text 围栏的真实粘贴形态）·
`check` 45/45。用使用者的真实文件复现：修复前 8 个全是 60 字片段，修复后为
**林夏 / 另一个林夏 / 阿哲 / 便利店 / 居民楼走廊 / 牛奶瓶 / 钥匙 / 纸条**。

**⚠ 已导入的坏名称素材不会自己变好** —— 修复只影响之后的导入，需在应用里删掉那批后重新导入。

**版本**：`0.37.0 → 0.37.1`（PATCH：缺陷修复；无接口变更、无数据变更）。
对使用者可见（导入结果），应发 Release。

#### `0.37.0` — 2026-09-24（「设置」按钮的图标改为主题指示：太阳 = 浅色，月亮 = 深色）

**起因**：使用者发现「设置」按钮上的图标"疑似太阳"，问它是不是主题指示器。

**核实结论：不是，但看起来就是。** 那是「设置」的齿轮，作用是打开设置抽屉，与主题无关。
可它画的是「圆（r=3.2）+ **6 根与圆分离的射线**」—— 太阳的画法是「圆 + 8 根分离射线」，
13px 下两者同形。**使用者的观察是对的，歧义出在图标本身。**

**方案取舍（经历一轮返工，记下原因）**：
1. ~~第一版：加一个独立的「外观」按钮，设置图标保持不动~~ —— **被使用者否决**：
   他们要的是"那里不要出现齿轮"，而不是"保留齿轮语义"。已回退。
2. ~~把齿轮画成"真齿轮"~~ —— 实测交替半径的轮廓在 13px 下看着像**花朵**，不合格，否决。
3. **最终**：齿轮位置直接换成主题指示图标；**点击行为不变**（照旧打开设置抽屉）。

**实现**：
- `index.html`：两处设置按钮（项目页 `#btnSettings` / 首页 `#homeSettings`）的齿轮换成
  **两个叠放的 SVG**（实心太阳 / 实心月亮）。
- `styles.css`：`.tt-ico` 13×13 定位容器 + 两个 svg 绝对定位叠放；按 `<html data-theme>`
  对 `opacity` / `rotate` / `scale` 做 **0.18s** 过渡（与全站既有 `.18s` transform 一致）。
- `app.js`：`syncThemeHint()` 在 `applyTheme()` 里被调用，往 `title` 追加
  「（当前深色主题，跟随系统）」这类后缀。

**三条刻意的设计决定**：

1. **动画零 JS 参与**。换 svg / 换字符必然是一次硬跳变；叠放两个图标后由 CSS 插值，
   天然连续，且主题状态仍只有一个事实来源（`<html data-theme>`），图标只是它的投影。
   太阳转出时月亮从反方向转入（`rotate ∓90°` + `scale .5`），是一次连贯的旋转交接，
   不是"两个图标叠在一起淡入淡出"。
2. **主题图标用实心，其余图标保持描边**。描边太阳与描边齿轮在 13px 下撞脸（实测），
   实心与描边一眼可分。全站已有实心图标先例（播放键、`#fff` 填充），不破坏风格语言。
3. **`aria-label` 不设，图标 `aria-hidden`。** 图标现在不承担任何点击含义 —— 若把可及名
   改成"切换主题"，屏幕阅读器会以为按下去会切主题，实际却是打开设置。按钮的可及名
   必须仍是"设置"；主题信息放 `title` 后缀（悬停可见），且明确标注"跟随系统"。

**`title` 为什么要有后缀**：图标只能表达浅色/深色两种**结果**，表达不了 `auto` 这个**模式**。
系统是浅色、用户选了跟随系统时，图标显示太阳但语义是"跟随系统"。后缀直接把这件事说清楚。

**验证**：`build` ✓ · `lint` 7/7 · `test` **201/201** · `check` 44/45（唯一失败是开发机沙箱
`spawnSync git EBUSY` 的环境问题，与本次无关）。
行为四连（真点击、真抽屉）：初始 light → 点设置：抽屉打开且**主题不变** → 抽屉里选「深色」：
`theme=dark` 且**图标变月亮** → 选「跟随系统」：回浅色、title 更新。
断言：抽屉打开 ✓ / 主题未因点设置而变 ✓ / title 含当前主题 ✓ / title 未被叠加 ✓。
视觉：浅色=实心太阳、深色=月亮（真实顶栏渲染放大 4 倍确认）。

**回滚**：纯前端 3 文件改动（`app/index.html` / `app/styles.css` / `app/app.js`），无数据结构变更、
无迁移。把三处图标换回原齿轮即回到旧行为。

**版本**：`0.36.0 → 0.37.0`（MINOR：新增"顶栏主题指示"这一可见能力；无接口变更、无数据变更）。
⚠ **对使用者可见**（顶栏图标变化），应发 Release。

#### `0.36.0` — 2026-09-23（应用内更新改走系统代理：107 MB 从 8.6 小时降到 42 秒）

**现象**：应用内更新的大文件下载慢到不可用。实测同一台机器、同一条网络：

| 路径 | 吞吐 | 107 MB 外推 |
|---|---|---|
| 直连（Node `https`） | 3.6 KB/s | **约 8.6 小时** |
| 走系统代理 | **2.70 MB/s** | **约 42 秒** |

（后者是在**真 Electron** 里用同一套传输层实测的：`mode:'system'` 12 秒收 33.2 MB；同一探针切 `mode:'direct'` 12 秒收 **0 字节**。`resolveProxy` 返回 `"PROXY 127.0.0.1:11304"`。）

**根因**：`desktop/updater.js` 全部走 Node 内置 `https`，而 **Node 的 `https` 不读 Windows 系统代理**（Chromium / Electron 的 `net` 会读，`curl` 会读，Node 不会）。`git log -S "proxy" -- desktop/updater.js` 为空 —— 长期缺口，不是回归。

**改法：传输层可注入。** 「发请求」抽成接口（`transport()` / `setTransport()`），默认实现仍是 Node `https`（纯 Node 测试不受影响），Electron 主进程在 `app` ready 之后注入 Chromium 的 `net`。注入点在 `boot()` 内、整段 `try/catch`：**拿不到就退回默认传输**，即旧行为，不会更差。

**代理策略（两段式）**：常态 `session.fromPartition('dreamflow-updater', {cache:false})` + `setProxy({mode:'system'})`；请求**连接级失败**时切 `mode:'direct'` 并**重发一次**。

- **不走 `resolveProxy()` + `fixed_servers`**：`resolveProxy` 的返回格式**官方未定义**（`PROXY h:p` / `DIRECT` 只是 Chromium 惯例）。解析未文档化格式的失败模式是**静默退回直连** —— "修了半天还是很慢却查不出原因"。`mode:'system'` 无需解析。
- **回退是必需的**：代理"开着但坏掉"时 Chromium 是**直接失败**而非变慢；没有回退，用户把代理配置改坏就会让更新从"慢"变成"彻底不可用"。切完必须 `closeAllConnections()`，否则连接池里走代理建立的 socket 会被复用，"已切直连"只是假象。
- **独立 partition**，不碰默认 session（回退会把代理切成 direct，不该影响渲染进程加载本机界面）。**一次性**：切过之后本进程内不回头。

**★ 两处设计取舍（都影响正确性，改之前先读代码注释）**

1. **跳转必须走 `cb`（交出合成的 3xx 响应），不能走 `onError`。** `updater.js` 两处既有跳转逻辑（`request()` / `downloadTo()`）都写在响应回调里、以 `res.statusCode` 为判据，从 error 通道进不去 —— 而 `downloadTo` 的 `onError` 会**删掉临时文件并判失败**，等于"下载一遇 302 就直接失败"。GitHub 附件下载**必经** 302，所以这条错了就是**必然**坏，不是"可能"坏。
2. **`settle` 守卫不是保险，是必需。** `redirect:'manual'` 下不调 `followRedirect()` 时请求会被取消，取消很可能再冒一个 `error`；没有守卫，那次 error 被当成连接级失败 → **在第一次跳转时就把代理关掉**。

**顺带修掉的两个真问题**

- **`downloadTo` 原先没有重发能力**：`retryable` 重试原本只加在 `request()` 上，下载路径靠"元数据请求先失败并翻直连"这个**隐式执行顺序**兜住 —— 将来改顺序就踩雷。现在两条路各自都有（下载侧额外限制"一个字节都还没写"才重发，因为 `file` 流与 `hash` 跨 `go()` 复用，半截数据再写一遍会把 sha512 算错）。
- **换传输层引入的挂死风险**：Electron 的 `IncomingMessage` 在连接被掐断时报的是 **`aborted`** 而不是 `error`，而传输层的看门狗在响应到手那刻就解除了 —— 只听 `error` 会让下载**永远挂着**。补了 `aborted` 监听（Node 侧同样会发，对两种传输都安全）。

**文件划分**：Chromium 适配放在新增的 `desktop/updater-transport.js`，**它不 `require('electron')`**（`net` / `session` 由调用方传入）。`main.js` 必须在 Electron 内才能加载，留在那里意味着"跳转 / 超时 / 回退"这三条最易静默失效的分支**永远没有自动化覆盖**；抽出来之后用**假的 `net`** 在纯 Node 下就能全测掉。

**测试**：`test/03-build-release.test.js` 新增 28 个用例（92 总计，原 64）—— `makeOnce` 幂等、传输可注入、`retryable` 恰好重发一次、**跨域跳转剥离 Authorization（`request` 与 `downloadTo` 两条路）**、同域保留令牌、重定向上限、假 `net` 下的"跳转走 cb / settle 后忽略 error / 连接级失败标 retryable / 回退链抛错不吞请求 / 超时 abort / 响应到手解除看门狗"，外加 `main.js` 与 `updater-transport.js` 的源码侧接线断言。**已做变异测试**：把跳转改成走 `onError` → 2 个用例失败；去掉 `settle` 守卫 → 1 个用例失败（两次均已还原，源码无残留）。

**验证**：`npm run verify` —— `check` 45/45（用例口径已同步为 201）、`lint` 7/7（31 个文件）、`test` **201/201**、`build:web` 通过。另在**真 Electron** 里实测代理生效：`mode:'system'` 12 秒收 33.2 MB（≈2.70 MB/s），同一探针 `mode:'direct'` 12 秒收 **0 字节**；`resolveProxy` 返回 `"PROXY 127.0.0.1:11304"`。

**回滚**：本版是**加法**。不调用 `setupUpdaterTransport()`（或 `setTransport(null)`）即刻回到旧的直连行为。**无数据格式变更、无需迁移。**

**版本**：`0.35.10 → 0.36.0`（MINOR：新增网络能力；无接口变更、无数据结构变更、无迁移）。⚠ **对使用者可见**（更新速度），应发 Release。

#### `0.35.10` — 2026-09-23（更新链路回归在 CI 上**跑通了**；收尾三处问题修掉）

**背景**：0.35.9 修完三处缺陷后重新触发 CI，拿到完整日志。**结果比预期好得多** —— 脚本 **16 步全部记录，所有断言通过**：

```
[step 12] electron-exit   exitCode=0
[step 13] flow-report     ok:true  version=0.28.9
          source   : provider=github  dir=null  repo=DreamFlow
          check    : ok=true  latest=0.35.6  hasUpdate=true
          download : ok=true  bytes=112334764
[step 14] assert-source   provider=github  dir=null
[step 16] assert-data     dbSha256 / assetSha256 与更新前**逐字节一致**
```

也就是说：**无头驱动真的跑起来了、固定源生效、应用能查到 0.35.6、107 MB 安装包下载并校验通过、用户数据在整条链路后逐字节未变** —— 这正是 P2-7 / 3.2 要验的那件事。

**但那次运行仍被记为 `cancelled`**（job 超时）。收尾有三处问题：

**① 报告只写在最后 → 现场全丢**

`report.json` 原先只在 `Pass`/`Fail` 里写一次。脚本被掐掉时它还没生成，于是只剩一行 "No files were found"。改为 **`Record` 每记一步就落盘一次**（`Save-Report`），无论后面卡在哪，前 N 步的证据都在磁盘上。

**② `.test-tmp/` 是隐藏目录，artifact 默认不收**

`upload-artifact@v4` 默认 `include-hidden-files: false`（CI 日志里能看到这一项），而产物路径在点开头的 `.test-tmp/` 下 —— 即使文件存在也传不上去。加 `include-hidden-files: true`。

**③ 脚本收尾不返回，把"测试通过"变成"job 超时"**

两处一起修：

- `exit 0/1` 改为 **`[Environment]::Exit()`** —— 前者在有未释放的 `Start-Process` 重定向句柄时可能不返回（PS 会走完自己的退出流程），后者是立即终止进程。
- 等 `electron.cmd` 退出 **≠** Electron 整棵进程树退出：它会派生 GPU / utility / crashpad 等子进程，而 CI 的一步要等整棵进程树结束。新增**按可执行文件路径收敛**的回收（只收本次仓库里的 electron，不误伤本机其它 Electron 应用）。

**⚠ 顺带堵一个数据破坏隐患**：改用 `[Environment]::Exit` 会**跳过 `finally`** —— 若 `Fail` 在 `try` 内部被调用（例如"Electron 超时未退出"），`finally` 里还原 `package.json` 的那步就跑不到，仓库会留下版本号被降级的 `package.json`。这不是假想：**2026-09-22 真实发生过一次**（版本被退成 `0.28.9`）。因此新增幂等的 `Restore-PackageJson()`，`Fail`/`Pass` 在硬退出前都先调一次，`finally` 保留为兜底。

**验证**

| 项 | 结果 |
|---|---|
| 脚本 PS 语法解析 | ✔ **0 语法错误**；6 处改动全部就位 |
| 工作流 YAML | ✔ `include-hidden-files: true` 已就位；结构校验通过 |
| `npm run check` | ✔ 45/45（见下注） |
| `npm run lint` / `npm test` / `node build.js` | ✔ 7/7 · 173/173 · 构建通过 |
| CI 实跑 | ⏳ 提交后重新触发 |

> ⚠ **`check` 在本会话出现过间歇性失败**：`读不到 git remote origin（不在 git 仓库里？）`。根因是**环境故障**，不是仓库问题 —— 实测该会话中 Node 创建**任何**子进程都报 `EBUSY`（连同解释器 `node -e 0`、`cmd.exe`、绝对路径、`detached` 全部失败），而 shell 直接调 git 正常。该检查用 `execFileSync` 调 git，故在故障窗口内必然失败；故障恢复后即 45/45。

**版本** `0.35.9` → `0.35.10`（PATCH：CI 收尾与开发工具链，**对使用者零可见影响，故不发 Release**）。

---

#### `0.35.9` — 2026-09-23（CI 首次运行暴露三处缺陷：无头驱动失效、失败不收尾、临时文件残留）

**背景**：0.35.8 把更新链路回归接进 CI 后手动触发了一次。那次运行**没跑完** —— 前 5 步全成功（含 `npm run verify:release` 通过），到「更新链路回归」这一步被 **20 分钟 job 超时**掐掉（`12:12:01` 启动 → `12:32:24` 结束，GitHub 记为 `cancelled`）。顺带在更早的 CI 历史里发现 `test/03-build-release.test.js` 的 updater 校验用例**间歇性失败**（`7ec18c6` 与 `041c33d` 两次都中，而 `2edf39e` 通过；更早的 `dc840f7` 也失败过）。

**这次运行值回了票价：查出三处缺陷，其中一处让整条回归从构造上就不可能成功。**

**① `desktop/main.js`：无头模式把更新流**整个跳过**了（最严重）**

```js
createWindow();          // ← 无条件建窗口；HEADLESS_TEST 并未阻止它
createTray();
if (process.env.JC_UPDATE_FLOW_TEST === '1') {
  if (process.env.HEADLESS_TEST === '1') return;   // ← 直接 return，更新流根本不跑
  runUpdateFlowTest();
}
```

代码与注释**恰好相反**（注释写"测试场景下不弹窗，只跑 boot 链 + 更新流"）：

| | 注释的意图 | 实际行为 |
|---|---|---|
| 窗口 / 托盘 | 不建 | **照建**（没有显示器时正是它要卡住的那个） |
| 更新流 | 照跑 | **完全不跑** |

而 `scripts/test-update-flow.ps1` 恰恰会设 `HEADLESS_TEST=1` —— 于是永远拿不到 `[update-flow]` 输出。这解释了为什么这个脚本"从未在任何地方完整跑通过"：**不只是本机缺 PS 7，它在任何环境下都跑不通**。

修正：把"无头"的语义落到正确的位置 —— `HEADLESS_TEST=1` 时**跳过窗口与托盘，但更新流照跑**。

**② `scripts/test-update-flow.ps1`：失败时不收掉 Electron，把"测试失败"变成"job 超时"**

`Fail` 只写报告就 `exit 1`，而 CI 的一步要等**整棵进程树**结束。残留的 Electron 让这一步一直挂着，直到 job 超时 —— 现场全丢，且看不出真正原因。修正：脚本级记 `$script:electronProc`，`Fail` 里先 `Kill()` 再退出。

**③ `desktop/updater.js`：校验失败时可能留下 `.part-<pid>` 残留（Windows 独有，间歇性）**

```js
const cleanup = () => { try { fs.unlinkSync(tmp); } catch (e) { /* 尽力而为 */ } };
ws.on('finish', () => { if (不符) { cleanup(); ... } });
```

`'finish'` 只表示"数据已交给内核"，**fd 通常还没关**（要等 `'close'`）。Windows 上删一个还开着的句柄会报 EBUSY/EPERM，而 `catch` 吞掉了 → 校验失败时留下残留文件（最大可达上百 MB）。**Linux 上 unlink 对打开的文件同样成功**，所以这个缺陷只在 Windows 复现 —— 正是 `test/03-build-release.test.js` 那两个断言"目标目录必须一个文件都不剩"的子用例间歇性失败的原因。

修正：`cleanup()` 改为**带退避重试**（25 次 × 20ms，句柄释放在毫秒级），仍失败才放弃 —— 残留还有启动时的 `cleanupStaleTemp()` 兜底。

**验证**

| 项 | 结果 |
|---|---|
| `npm run check` | ✔ **45/45**（本会话中途出现的 `EBUSY` 环境故障已自行恢复） |
| `npm run lint` | ✔ 7/7 |
| `npm test` | ✔ 173/173 |
| `test/03-build-release.test.js` 连跑 12 次 | ✔ 12/12（修复前本机也不复现，故这一项只证明未引入回归） |
| 脚本 PS 语法 | ✔ 语法解析器：**0 语法错误**，三处改动均就位 |
| CI 实跑 | ⏳ 提交后重新触发，见下 |

> ⚠ **③ 的修复无法在本机验证** —— 该缺陷本机不复现（Windows 的时序竞态），所以它是否真的修好，**只能由 CI 的后续运行回答**。这也是把回归接进 CI 的价值所在。

**版本** `0.35.8` → `0.35.9`（PATCH：修更新链路的无头驱动与清理路径，**对使用者零可见影响，故不发 Release**）。

---

#### `0.35.8` — 2026-09-23（更新链路回归接入 CI；脚本补 `assert-source` 断言）

**背景**：0.35.7 记录的那条待办 —— `scripts/test-update-flow.ps1` 在本机跑不通（只有 Windows 自带的 5.1，需要 PS 7+）。使用者选择把它**改造成 CI 作业**，理由是：既然本机跑不了，就把它放到跑得了的地方去，顺便让这条链路每次发布都受检。

**改法一：新增工作流 `.github/workflows/update-flow.yml`**

| 触发 | 说明 |
|---|---|
| `release: published` | **每次发布之后自动跑** —— 这是它最有价值的时机（确认"这次发布真的装得上、且没毁用户数据"） |
| `workflow_dispatch` | 手动触发；可勾选 `install`（连安装器一起调，这是"数据会不会被删"的真正考验）、`skip_build` |

job 在 `windows-latest` 上跑（runner 自带 PS 7 与网络），三步：

1. **`npm run verify:release`** —— 先验"发布本身对不对"（快，不需下载安装包）
2. **`pwsh -File scripts/test-update-flow.ps1`** —— 再验"装得上、不毁数据"
3. **`actions/upload-artifact`** 上传 `report.json` 与 Electron 日志（`if: always()`，失败时这是唯一现场）

**为什么单独一个工作流、不塞进 `ci.yml`**：这条链路要联网、默认会下载一个上百 MB 的安装包 —— 放在每次 push 上跑既慢又浪费。它该被触发的时机是**发布之后**，不是每次提交。

**改法二：修脚本里那段"从未生效"的配置注入**

`set-update-source` 步骤**写到了应用不读的位置**（`<runData>/desktop-config.json`，而应用读的是 `app.getPath('userData')` 下的那一份），加上 0.35.6 起更新源已**固定**为 github —— 这一步彻底失效。本次**没有删它**（本机无法验证删除后是否仍成立），而是：

- 在它上方写明两个失效原因与实测证据（真实配置的键只有 `legacyImportChecked`，从未出现过 `updates`），`Record` 里加 `effective = $false` 与 `why`，让报告自己说明它没生效
- 保留 `$updSrc` 那套 mock 更新源构造 —— 将来若要做离线模式（给 `updateSource` 加一个受测试标志双键门控的后门）可直接复用
- **新增 `assert-source` 断言**：从 Electron 回传的 flow report 里取 `source` 步骤，断言 `provider === 'github'` 且不带 `dir`。**这条是关键** —— 它守住"实际用的是固定源"，将来若有人把更新源改回可配置，这里会**立刻红**，而不是静默换个源跑完（"回归跑了、绿了，却没测到你以为在测的那条路"是最难发现的一类问题）
- 头部 Usage 补上**需要联网**的说明

**我能验证的 vs 不能验证的（如实分列）**

| 项 | 结果 |
|---|---|
| 脚本语法 | ✔ 用 PS 的**语法解析器**（`Parser::ParseFile`）解析：**1986 个 token，0 语法错误** |
| 工作流里两段 `run:` 的 PS 语法 | ✔ 逐块提取后解析：**两段均 0 语法错误** |
| YAML 结构 | ✔ 顶层键 `name` / `on` / `concurrency` / `jobs` 正确；job 与 step 层级正确；**无制表符**；13 个关键字段全部命中 |
| `$args` 自动变量冲突 | ✔ 已规避（改名 `$psArgs`）—— `$args` 是 PS 自动变量，脚本里赋值会被拒 |
| **脚本能否真的跑通** | ✘ **未验证** —— 本机无 PS 7，只能看 CI 结果 |

> ⚠ 因此 `docs/项目全面审查与改进流程.md` 给 3.2 定的验收标准「**至少完整跑通一次并留痕**」**仍未达成** —— 截至本版尚未有一次成功的 CI 运行记录。该文档里已加现状补记，把这条从"已交付"降回"待验证"。

**顺带记下一个本机环境坑**：用 PS 5.1 的 `Get-Content` 读 UTF-8 中文文件（不带 `-Encoding UTF8`）会按 GBK 误解码，产生的额外换行会让**行号偏移**（本次我的检查工具就中了，报出的行号比实际小 21 行）。这正是项目注释里早就记过的那个坑。

**文档同步**：`docs/版本发布与更新流程.md` §5 新增「更新链路回归：由 CI 跑」小节（含两个必须知道的事实）；`docs/项目文档.md` §5.6 的代价说明补 CI 现状；`docs/项目全面审查与改进流程.md` 3.2 行下加现状补记。

**验证**：`npm run verify` 全绿（check 45/45 · lint 7/7 · test 173/173 · dist 重建）；`npm run verify:release` 全绿（1 项警告：仓库版本高于已发布版本，符合预期）。

**版本** `0.35.7` → `0.35.8`（PATCH：CI 与开发工具链，**对使用者零可见影响，故不发 Release**）。

---

#### `0.35.7` — 2026-09-23（新增发布后验收 `verify-release`：补上「更新链路在本机无法验证」的缺口）

**背景**：0.35.6 发布后，待办里剩一条 —— 修 `scripts/test-update-flow.ps1` 那个从未生效的 `set-update-source` 步骤。动手前先查它能不能在本机跑，结论是**不能**：

| 事实 | 证据 |
|---|---|
| 脚本 shebang 是 `pwsh`，头部自述**需要 PS 7+** | `scripts/test-update-flow.ps1` 第 1 / 23-27 行 |
| 本机只有 **Windows PowerShell 5.1**（Desktop edition） | 实测 `$PSVersionTable.PSVersion` = `5.1.19041.6456`；`Program Files\PowerShell\7\` 与 WinGet Links 下均无 |
| 5.1 下会在「启动 Electron」那步失败 | `Start-Process` 继承环境时报「已添加项。字典中的关键字:"PATH"所添加的关键字:"Path"」（5.1 枚举环境变量大小写敏感） |
| 该脚本**从未在本机完整跑通过** | CHANGELOG 的 0.30.0 一节记着「跑到 step 10 …… 完整端到端需在装了 PS 7 的环境执行」 |

也就是说：`docs/项目全面审查与改进流程.md` 给这一项（P2-7 / 3.2）定的验收标准「**至少完整跑通一次并留痕**」**至今未达成**，而**改它也无法在本机验证** —— 盲改一个跑不起来的回归脚本，风险大于收益。

**改法：不在跑不起来的脚本上继续投入，而是补一段本机就能跑的验收。**

新增 `scripts/verify-release.js`（`npm run verify:release`）。它**直接用应用自己的 `desktop/updater.js`** —— 不启动 Electron、不需要 PS，只依赖 Node 内置模块，因此本机与 CI 都能跑。断言五件事：

| # | 断言 | 为什么重要 |
|---|---|---|
| ① | 更新源固定为 `github/ikun1946/DreamFlow`，`token`/`url`/`dir` 均为空 | 守住 0.35.6 刚收紧的那条 |
| ② | 应用能**查到**该版本（走 `fetchManifest`，与界面同一条路径） | 更新源不对 / 网络不通会在这里暴露 |
| ③ | 附件齐全：`Setup.exe` + `.blockmap` + **`latest.yml`**，状态均 `uploaded` | **缺 `latest.yml` = 应用内更新查不到新版，传了安装包也等于没发** —— 这是"发版静默失败"最常见的原因，此前**只靠人眼在网页上核对** |
| ④ | 附件字节与本地 `release/` 产物一致（比对 GitHub 返回的 `digest`） | 传错文件 / 上传损坏；且**不需要下载 107 MB** 就能做哈希级证明 |
| ⑤ | `package.json` 版本不高于已发布版本 | 「发完又改代码、没再发」 |

**实测（对刚发布的 v0.35.6）**：五节全绿 —— 查到 0.35.6、三个附件齐全且 `uploaded`、三个附件大小与 sha256 与本地构建产物**全部一致**、`package.json` 与已发布版本一致。另外单独跑过一轮「模拟装着 0.35.1 检查更新」：正确查到 0.35.6、判定 `hasUpdate=true`；`check('0.35.6')` 则判定无更新（不误报）。

**与 `check-signing.js` 的分工**：那个管「产物签没签名」，这个管「产物到没到使用者手里」。

**配套**：`package.json` 加 `verify:release`；`docs/版本发布与更新流程.md` 的「三十秒版」加第 ⑥ 步并新增「建完 Release 必须跑一次发布后验收」小节；`docs/项目文档.md` §6.1 命令清单与 `AGENTS.md` 常用命令各加一行。

**⚠ 仍未解决（如实记录）**：`scripts/test-update-flow.ps1` 的两个问题都还在 —— ① `set-update-source` 写到了应用不读的路径（`<runDir>/new-data/desktop-config.json` vs `app.getPath('userData')/desktop-config.json`）；② 本机没有 PS 7，跑不通。**本版没有改它**，因为改完无法验证。建议二选一：装 PS 7（`winget install Microsoft.PowerShell`）后实跑一次；或把它改造成 CI 作业。

**验证**：`npm run verify` 全绿（check 45/45 · lint 7/7 · test 173/173 · dist 重建）；`npm run verify:release` 对 v0.35.6 全绿。

**版本** `0.35.6` → `0.35.7`（PATCH：开发工具链新增，**对使用者零可见影响，故不发 Release** —— 同 0.33.0 / 0.35.2 / 0.35.4 的处理）。

---

#### `0.35.6` — 2026-09-23（更新源改为**固定**：把「不让用户更改」这件事真正做实）

**背景（一次需求理解的纠偏）**：使用者在看到 0.35.5 后指出 —— 「我说的不是移除更新源设置这个界面，我的意思是不让用户自己更改更新源」。

**这个纠偏是对的，而且指出了一处实质缺口。** 0.35.5 只拿掉了界面入口，**没有切断配置路径**：

| | 0.35.5 之后 | 0.35.6 之后 |
|---|---|---|
| 界面入口 | 已移除 ✔ | 已移除 ✔ |
| `desktop-config.json` 的 `updates` 段 | **仍被读取** ✘ —— 手改文件仍能改源 | **不再读取** ✔ |
| 环境变量 | 本来就不读 ✔ | 不读 ✔ |

也就是说：0.35.5 是"锁了门却留着窗"。`desktop-config.json` 是纯文本、就躺在使用者自己的 `%APPDATA%` 下，任何人手改 `updates` 段仍能把更新指向别的 https 地址或本地目录 —— **而更新链路的终点是「下载并执行一个安装器」**。

**改动**

| 位置 | 改动 |
|---|---|
| `desktop/main.js` | `updateSource()` 由「读 `paths.config.updates`」改为 `updaterMod.resolveSource(null)` —— 恒返回内置 `DEFAULT_SOURCE`（`github` / `ikun1946` / `DreamFlow`）。`paths.config` 不再参与更新源推导 |
| `desktop/main.js` | `publicSource()` 去掉 `url` / `dir` / `hasToken` —— 来源固定后这三项恒为空/假，留着只会让人以为还能配 |
| `app/app.js` | `provName` 不再做 provider → 名称映射（没有可选来源了）；状态行去掉「已配置令牌」；`needsToken` 提示改为「确认本机能访问 GitHub」而不再指向已不存在的配置入口 |

**保留**：`updater.resolveSource()` 的三种 provider 支持与四条安全闸（https-only / sha512 校验 / `/S --updated --force-run` / 令牌只进不出）。它们仍被 `test/03-build-release.test.js` 直接覆盖 —— **只是应用不再把使用者可控的值喂进去**。

**顺带查实一个既有缺陷（未修，见下）**：`scripts/test-update-flow.ps1` 的 `set-update-source` 步骤**从来没生效过**。脚本把 `updates` 写进 `<runDir>/new-data/desktop-config.json`，而应用读的 `configPath` 是 `app.getPath('userData')` 下的那一份（`runtime-paths.js`）—— **两者不是同一个文件**。证据：① 静态分析（`resolvePaths` 里 `configPath = path.join(userData, CONFIG_FILE)`，与 `JC_DATA_DIR` 无关）；② 本机真实配置 `%APPDATA%\即梦批量生成控制台\desktop-config.json` 的键**只有 `legacyImportChecked`**，从未出现过 `updates`。所以这个脚本实际跑的是**在线 GitHub 源**（把版本降级成 `$OldVersion` 后 GitHub 上必有更新可下），需要联网并会真下载一个上百 MB 的安装包。已在 `desktop/main.js` 的 `JC_UPDATE_FLOW_TEST` 注释里更正原说法（原注释称"更新源由脚本写进 desktop-config.json"）。

> ⚠ **未修的原因**：修它要动一个 PowerShell 回归脚本，而本机 PowerShell 工具链输出不稳定、该脚本单次运行需联网并下载上百 MB，不适合在本次一并改完再验证。**留作待办**：要么让它明确只测在线路径（并断言 provider 为 github），要么为本地源引入一个与 `JC_UPDATE_FLOW_TEST` 双键门控的测试后门。本地源的现有覆盖在 `test/03-build-release.test.js`（直测 `updater.download`）。

**文档同步**：`docs/项目文档.md` §5.6（更新源固定 + 为什么不能只删界面 + 脚本离线能力的代价）、§6.5 配置表（`updates` 键标注失效）。

**验证**：`node build.js` 重建 dist（493.1 KB）；`check` 45/45 · `lint` 7/7 · `test` 173/173。全仓检索确认 `paths.config.updates` 已无读取点。

**版本** `0.35.5` → `0.35.6`（PATCH：行为收紧，不涉及接口与数据格式）。

> ⚠ 与 0.35.5 一样是**使用者可见的变更**（更新源不再可改），应发 Release 才能真正到达使用者。

---

#### `0.35.5` — 2026-09-23（移除「更新源设置」；创作 CLI 的登录与切换账号合并为同一入口）

**背景**：使用者提出两项界面调整 —— ① 应用端移除「更新源设置」功能；② 把创作 CLI 的「登录」与「切换账号」合并为同一个入口（未登录显示「登录账号」，已登录显示「切换账号」）。

**① 移除「更新源设置」**

删掉的是一条**完整链路**，不只是按钮：

| 层 | 移除内容 |
|---|---|
| 前端渲染 | 「更新源设置…」折叠按钮、`appUpdateCfgHTML()` 整函数（三种源的表单：github 仓库 + 令牌 / 自定义 URL / 本地目录） |
| 前端交互 | `runUpdateAction` 的 `togglecfg` / `savecfg` / `recheck` 三个分支；`#settingsBody` 上的 `#updProvider` 下拉 change 处理器；`S.appUpdate.showCfg` 状态位 |
| 桥面 | `preload.js` 的 `updateSetSource` |
| 主进程 | `ipcMain.handle('update:setSource')` 与 `setUpdateSource()` 函数 |

**保留**：`updateSource()` / `publicSource()` 与 `update:status` —— 界面仍**显示**当前更新源（含"已配置令牌"提示），只是不再提供修改入口。

**这是一次能力取舍，值得写明**：更新源现在是**只读**的 —— 从本机 `%APPDATA%\即梦批量生成控制台\desktop-config.json` 的 `updates` 段读取，缺省 `github`（本仓库公开、匿名可读，正常无需配置）。**要换源只能手改那个配置文件**；私有库 / 自建源 / 离线本地目录这三种场景不再有界面入口。使用者明确要求移除，故照此办理。附带收益是桥面上少了一个"能改写配置"的入口（原先它能写入 `token` 等键，虽有白名单）。

**② 合并 CLI 登录 / 切换账号**

- 改前：两个按钮并排 —— 「创作 CLI 登录」+「创作 CLI 切换账号」。问题是**未登录的人看到「切换账号」**（他根本没有账号可切），**已登录的人看到「登录」**（容易误以为要再授权一次）。
- 改后：同一个入口按状态换标签 —— 未登录 →「登录账号」（主按钮样式，因为这是下一步该做的事）；已登录 →「切换账号」。
- **判据用 `dInfo.available`（CLI 可用且登录态有效），刻意不用"有没有账号信息"** —— 后者在探测失败时为空，会把已登录的人误判成未登录、把入口显示成「登录账号」，那比原来的问题更糟。
- 动作分发不变（`dlogin` / `dswitch`），「切换账号」仍走二次确认（它会先退出当前账号）。
- 同步改写三处会提到旧按钮名的文案：状态卡「已安装，但未登录」的指引、CLI 区块的说明段、待完成授权卡片里「重新点…」的提示。

**测试同步**：`test/03-build-release.test.js` 有两处断言 preload 契约（暴露方法清单、channel 透传清单），随功能移除更新；并**新增一条反向断言** —— `api.updateSetSource` 必须是 `undefined`，防止后来者"顺手加回来"却没恢复对应的界面与安全说明。

**文档同步**：`docs/项目文档.md` 的 §3.2（`app.js` 体积）、§3.4（`preload.js` 15 → **14** 个方法）、§4.4（方法清单）、§4.6（P3 设置面板：CLI 入口合并说明）、§5.6（更新源改为只读 + 为何仍是 https-only）；§6.5 的配置表照旧（`desktop-config.json` 仍存更新源）。

**验证**：`node build.js` 重建 dist（493.1 KB，比上版少 3.7 KB）；`check` 45/45 · `lint` 7/7 · `test` 173/173。全仓检索 `appUpdateCfgHTML` / `togglecfg` / `savecfg` / `showCfg` / `updProvider` / `updateSetSource` / `updOwner` / `updRepo` / `updToken` / `updUrl` / `updDir` 在 `app/` 中**均为 0**。

**版本** `0.35.4` → `0.35.5`（PATCH：界面调整 + 移除一个界面功能，**不涉及接口与数据格式**，故不构成 MAJOR/MINOR）。

> ⚠ 但它是**使用者可见的变更**（按钮少了、入口换名字了），按本项目口径**应当发 Release** 才能真正到达使用者 —— 与 0.35.2 / 0.35.4 那种纯内部改动不同。

---

#### `0.35.4` — 2026-09-23（README 瘦身：465 行 → 170 行，深层内容让位给 `docs/`）

**背景**：使用者反馈 README「内容过于复杂」，要求保留核心信息、精简结构与描述、去除冗余。

**这不是第一次**：`docs/CHANGELOG.md` 的 0.29.2 条目记着 README 曾从 **906 行瘦身到 291 行**。之后又涨回 465 行 —— 说明它有**反复膨胀**的倾向，根因是「该进 `项目文档.md` 的内容被顺手写进了 README」。

**判据（本次确立）**：这段内容该进 README 吗？—— README 只承担**入门 / 跑起来 / 注意事项 / 导航**；凡是"为什么这么设计"的实现理由、逐文件职责、架构规则，都归 `docs/项目文档.md`。

**结果**：465 → **170 行**（−63%）、34.6 KB → **10.1 KB**、一级章节 14 → **7** 个；diff `+82 / −378`。

**结构调整**

| 原 | 现 |
|---|---|
| 标题+命名史 · 当前状态 · 目录规划 · 快速开始 · Windows 桌面版（7 小节）· 前后端如何联通 · 真实生成链路 · 前端核心机制 · 构建发布版 · 推送到 Git 仓库 · 备份运行数据 · 多项目架构与数据隔离 · 已知边界 · 版本 | 标题+命名 · 当前状态 · 快速开始 · **两种交付形态** · Windows 桌面版（4 小节）· 目录速览 · 注意事项 · 版本 |

**删减明细（每条都先核实"去向"真实存在，才敢删）**

| 原内容 | 原行数 | 处理 | 去向 |
|---|---|---|---|
| 目录规划：逐文件 ASCII 树 | 70 | 压成 9 行顶层目录 | `项目文档.md` §3 |
| 多项目架构与数据隔离 | 75 | 压成 3 行术语说明 | `项目文档.md` §2.2 / §7.3 |
| 应用内更新（含 electron-updater 取舍、NSIS 三开关、四道安全闸） | 33 | 压成 2 行 + 指针 | `项目文档.md` §5.6；`desktop/updater.js` |
| 创作 CLI 安装（3 条设计取舍 + 三态表 + 版本号读错文件始末） | 21 | 压成 2 行 | `项目文档.md` §5.5；`cli-installer.js` 块注释 |
| 构建发布版 + 发一个新版本 | 18 | 压成 3 行 | `docs/版本发布与更新流程.md` |
| 前后端如何联通（`window.APP_CONFIG` 注入） | 15 | 删 | `docs/后端服务设计方案.md`；`app/api.js` |
| 真实生成链路 5 步 | 12 | 删 | `项目文档.md` §5.3 |
| 推送到 Git 仓库 | 12 | 删（脚本仍在） | `docs/Git 私密仓库操作指南.md` |
| 已知边界 6 条 | 11 | **全部保留**，逐条压缩 | — |
| 命名史（三步更名 + 为何分两步） | 10 | 压成 3 条要点 | `CHANGELOG` 0.31.0 / 0.32.0 |
| 前端核心机制 5 条 | 10 | 删 | `项目文档.md` §4.6 |
| 发布阻塞项 5 条 | 9 | 压成 1 行指针 | `AGENTS.md`（原文自称是"复述"） |
| 「和网页版的行为差异」 | 7 | **并入新表** | 见下 |
| 旧数据导入 | 5 | 并入「独有能力」 | `项目文档.md` §5.6 |
| 版本一节里"测试删了又恢复"的始末 | 1 段 | 压成 2 行 | `CHANGELOG` |

**新增**：原来只有**单侧**的「和网页版的行为差异」（只讲桌面版，读者得自己反推网页版），改成**双向对比表**（启动 / 端口 / 鉴权 / 数据根 / 配置日志 / 独有能力）。同一份信息更易对照，还省了 3 行。

**保留未动**：快速开始、数据放在哪、打包后自检、备份运行数据、注意事项、版本。

**⚠ 硬约束（改 README 前必读）**：`scripts/check-project.js` 第 16 节对 README 有 **7 处正则硬依赖**，删改时必须原样保留，否则门禁直接红 ——
`当前版本：**\`x.y.z\`**` · `**N 个用例**` · `N 节 M 项一致性检查` · `N 项静态检查` · `` `npm test`（N 用例） `` · `` `npm run check`（N 项一致性检查） `` · 当前版本的变更记录标记（README 或 CHANGELOG 命中其一即可）。

**验证**：7 处正则逐条验证命中；`npm run verify` 全绿（check 45/45 · lint 7/7 · test 173/173 · dist 构建通过）。

**版本** `0.35.3` → `0.35.4`（PATCH：文档精简）。

---

#### `0.35.3` — 2026-09-23（清掉「画布 CLI 时代」的过期文案；发布说明口径写进流程文档）

**背景**：使用者截图反馈「生成引擎与账号」卡片里写着「**两个 CLI 的登录态彼此独立**」，而界面上只显示了一个 CLI，问是什么情况、会不会是配置冲突 / 环境变量 / 重复安装 / 路径问题。

**排查结论：不是那四类问题，是文案残留。** 画布 CLI（`dreamina-canvas`）已于 2026-09-18 移除，只剩创作 CLI（`dreamina`）一个引擎 —— 后端自己写得很清楚：

- `server/models.js` 的 `enginesFor(model)` **恒返回 `['dreamina']`**（只有一个引擎）
- `server/services.js` 的注释：「画布 CLI 已移除，所以不再有"一次检测两个 CLI"这回事」
- `app/app.js` 的 `engineLabelOf` 注释：「单引擎后只有一个引擎」

**但卡片的两处文案没跟上**，于是界面自己跟自己矛盾。三处（含两处注释）一并清掉：

| 位置 | 原文 | 改后 |
|---|---|---|
| `app/app.js` 卡片头描述 | 引擎随所选模型自动匹配，无需手动切换；含音频绑定的分镜自动使用创作 CLI。**两个 CLI 的登录态彼此独立。** | 引擎随所选模型自动匹配，无需手动切换。**本项目只有创作 CLI（dreamina）一个生成引擎。** |
| `app/app.js` 状态卡 | 默认模型 X → 创作 CLI　·　**模型按各自归属执行，列表已标注可用引擎** | 默认模型 X → 创作 CLI　·　**全部可用模型均由创作 CLI 执行** |
| `app/app.js` 注释 | 卡片 5 ·（全局的「检测」升到卡片头，**两个 CLI 各自成组**） | 改为说明"只剩一个引擎，所以只有一个子块"，并记下这次清理由 |
| `app/app.js` 分镜详情的兜底告警 | 绑了 N 张图，但**按模型归属会走「画布」链路** —— 画布命令不带 `--image`……请换用「创作 CLI」的型号 | 绑了 N 张图，但本次提交**不会**把参考图发出 —— 素材区块未组装成功 |
| `server/services.js` 注释 | `injected, // …（画布链路不注入）` | `injected, // …（素材区块未组装成功时不注入）` |

最后两处是**引擎中立化**：原措辞默认存在"另一个会走画布的引擎"。经核实该分支在当前代码下**不可达**（`injected = !!lockBlock`，只要绑了素材就会组装出区块），属死防御代码 —— 但留着错误措辞等于埋雷，故一并改成与引擎无关的说法。

**保留未动**：`app/app.js` 的 `'画布 CLI（已退役）'` 标签，以及各处「**原**画布链路……」的历史说明注释 —— 它们是准确的历史记录，`check-project.js` 第 7 节也确认运行时代码未引用 `dreamina-canvas`。

**同时修掉一句把我引错的话**：`docs/版本发布与更新流程.md` 第 3 步原写「说明填变更要点（**可以直接抄 README 的变更记录**）」。照做会把 `CHANGELOG.md` 整段搬进 Release 正文 —— 0.35.1 就是这么把"一致性检查扩到 45 项、单元测试 173 用例"写进使用者会读的发布说明的（使用者当场判定为噪音并要求删除）。现改为：

> 标题填版本号；说明**只写使用者可见的改动** —— 内部改动、测试数量、开发流程、纯文档变更一律留给 `docs/CHANGELOG.md`（判据：使用者读了能做出**决策**吗？不能就别写）。唯一例外：确实改变了**交付产物构成**的改动。

**⚠ 本版是使用者可见的**（界面文案真的变了），因此与 `0.35.2` 不同 —— 它应当发 Release 才能真正到达使用者。

**验证**：`node build.js` 重建 dist（496.8 KB）；产物中用户可见的过期文案已清零（`各自归属` = 0，残留的「两个 CLI」「画布链路」全部落在历史说明注释里）；`check` 45/45 · `lint` 7/7 · `test` 173/173。

**版本** `0.35.2` → `0.35.3`（PATCH：修过期文案）。

---

#### `0.35.2` — 2026-09-23（修签名工具链两处缺陷：`.pfx` 未被忽略、自带 signtool 找不到）

**背景**：使用者问「怎么给安装包签名」。核查本机签名工具链时，顺带发现 `scripts/check-signing.js` 里两个会**误导使用者**的缺陷 —— 都属于"检查器本身不可靠"，比被检查的功能更危险，因为坏掉的检查器会给出 PASS。

**缺陷一：`.gitignore` 漏了 `*.pfx`，而判据又恰好放过它。**

`.gitignore` 的「环境变量与密钥」段只列了 `*.pem` / `*.key` / `*.p12`（第 47–49 行）。但**代码签名证书最常用的容器格式恰恰是 `.pfx`** —— 也就是说，"一旦配了签名，最可能被误提交的那个文件"没有被忽略。

更糟的是 `check-signing.js` 的判据写的是 `if (ignored.length >= 3)` —— 四选三即通过。于是这个漏洞**永远不会被自检发现**，界面照样显示 `PASS`。检查器与被检查对象同时失守，等于没有防护。

修正：
- `.gitignore` 补 `*.pfx`，并加注释说明为什么它必须在
- 判据从「至少三类」改为「四类全齐」（`missingKeys.length === 0`）
- 顺带只统计**生效行**：原先用 `giText.includes(pat)` 全文匹配，把规则**注释掉**也照样通过。现在先剥掉 `#` 开头的行再比对

**缺陷二：`findSigntool()` 不知道 electron-builder 自带 signtool，导致验签功能整条不可用。**

原实现只搜两处：`PATH`，以及 Windows SDK 的 `C:\Program Files (x86)\Windows Kits\10\bin\<ver>\x64\`。但**开发机通常不装 SDK**（本机实测 `Windows Kits\10` 下只有 `UnionMetadata`、没有 `bin`）。后果是自检报「找不到 signtool.exe（构建仍可进行，但无法在本地验证签名）」，`--verify` 直接放弃 —— **而打包时 electron-builder 用的就是它自己缓存的那一份**：

```
%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<id>\windows-10\x64\signtool.exe
```

它明明就在磁盘上，脚本却找不到，于是"验签"这个功能在本机白白废掉。修正：在 Windows Kits 之后加一层兜底查找（SDK 优先，自带版兜底），不改变"有没有证书"的任何判断。

**实测效果**（本机，无 Windows SDK、无证书）：

| 项 | 修复前 | 修复后 |
|---|---|---|
| `[2/3] signtool 可用性` | `WARN 找不到 signtool.exe` | `PASS signtool：…\winCodeSign\017956427\windows-10\x64\signtool.exe` |
| `[1.1] 证书是否被误提交` | `PASS`（因 `>= 3` 而漏判 `*.pfx`） | `PASS`（现在是真的四类全齐） |
| `--verify` | 直接放弃，报"找不到 signtool" | 正常执行，逐个文件验签 |

**⚠ 一并记下一个尚未处理的观察**：`--verify` 会扫 `release/` 下**全部** `Setup.exe`。本机 `release/` 里累积了 0.29.5 / 0.29.6 / 0.31.0 / 0.32.0 / 0.34.0 / 0.35.1 六个历史安装包，全都未签名 → 整体报 `失败（6 项错误）` 且退出码 1。这在"配好签名之后"会造成误导（新包签了、整体仍红）。**当前未改**，因为"验全部"还是"只验最新"是策略选择，需使用者定夺；临时规避是把历史安装包移出 `release/`（项目根已有 `release-archive/` 就是干这个的）。

**影响范围**：仅 `.gitignore` 与 `scripts/check-signing.js`。**不涉及 `app/` · `server/` · `desktop/` · `electron-builder.yml`**，对使用者**零可见影响**，故本版**不发 Release**（同 `0.33.0` 的处理方式：仅登记版本线，由下一个使用者可见版本一并交付）。

**验证**：`check` 45/45、`lint` 7/7、`test` 173/173。

**版本** `0.35.1` → `0.35.2`（PATCH：修开发工具链缺陷）。

---

#### `0.35.1` — 2026-09-23（移除从未发布的「GPT / DALL·E 图生」在制品）

**背景**：使用者在设置面板看到「更新源 GitHub Releases（ikun1946/DreamFlow，**未配置令牌**）」并质疑——仓库已是公开库、匿名即可检查更新，为何还提令牌。排查时顺带发现工作区里躺着一批**从未提交、从未发布**的 GPT 生图（revChatGPT）在制品。使用者决定：**这个功能暂时不做，删掉**。

**为什么必须删（不只是"不做"）**：`electron-builder.yml` 的 `files` 白名单含 `server/**/*`，所以**只要打包就会把它一起发给使用者**。而这个在制品有四处硬伤：① `app/` 里没有任何入口，也没有 HTTP 路由能写 `_puid`，但代码提示却写「请先在设置页填写」；② `PUID_FILE` 硬编码 `server/data/.puid`，**绕过 `runtime.getDataDir()`**——桌面版中 `server/` 位于只读的 `app.asar` 内，写入必失败（违反第 3 条硬约束）；③ 依赖外部 `pip install revChatGPT`，未列入外部依赖表；④ 以 `_puid` cookie 模拟 ChatGPT Plus 登录态调用其内部图生接口，有 ToS / 合规风险。

**⚠ 先备份再删（关键前置）**：这批代码**全部未提交**——`server/revchatgpt.js` / `server/auto_login.py` 从未进过 git，`server/{config,models,server,services,worker}.js` 的 +202/−35 行也未 commit。**删除即永久丢失、无历史可回滚**。故先完整备份到项目之外（`backup-20260923/gpt-image-feature-wip/`：4 个未跟踪文件 + `gpt-feature.patch` + `恢复说明.txt`），并**逐项校验**：4 个文件 md5 与原文件一致、`git apply --check --reverse` 通过 —— 恢复路径是验证过的，不是"应该能还原"。

**改动范围**：

| 类别 | 内容 |
|---|---|
| 删除未跟踪文件 | `server/revchatgpt.js`、`server/auto_login.py`、`check_net.ps1`、`check_proxy.ps1` |
| 还原已跟踪文件到 HEAD | `server/{config,models,server,services,worker}.js`（`git checkout --`，+202/−35 行） |
| 文档回改 | `docs/项目文档.md` §3.3 模块表（22 → **21 个模块**、删 `revchatgpt.js` 行、`models.js` 的"引擎路由"去掉 revchatgpt）、§10.1 删去该条目并留一行指向本记录 |

**未受影响**：`app/` · `desktop/` · `scripts/` · `test/` · `electron-builder.yml` · `package.json` —— 对这些的引用数**均为 0**，所以前端、桌面壳、测试、打包配置一行未动。

**验证**：删除后全仓检索 `revchatgpt|revChatGPT|GPT_IMAGE_MODELS|gptPuid|dalle3|GPT 图生|JC_GPT_PUID` = **0 处**；`git status` 只剩本次会话自己的 7 个文件（此前的在制品污染已清空）；`check` 45/45、`lint` 7/7、`test` 173/173、dist 重建通过。

**版本** `0.35.0` → `0.35.1`（PATCH：移除**从未发布**的能力，对使用者零可见影响）。

> ⚠ 顺带记一笔：这次排查的**真正起因**是「装了 0.34.0 却仍显示『未配置令牌』」。根因不是代码没改——`0.34.1`（提交 `0152270`）早已把该文案改为「配了才显示」——而是 **DoD 第 7 步（发版）被跳过**：版本号登记了、tag 也打了，但没 `npm run dist`、没建 Release、没上传。GitHub Releases 至今只有 `v0.34.0 / v0.32.0 / v0.31.0 / v0.29.5 / v0.25.0`，`v0.34.1` 与 `v0.34.2` **只有本地 tag**。所以修复停在 `main` 上，永远到不了使用者。**"改了但没发"等于没改**——这条教训值得留在这里。

---

#### `0.35.0` — 2026-09-23（首页的设置窗口改为居中弹窗，与分镜表的右侧抽屉区分开）

**需求**（使用者提出）：首页（项目墙）那个界面的设置窗口，希望**和分镜表里的不一样** —— 应该是"横铺满整个屏幕"或者"居中弹出一个窗口"。

**为什么值得做**：分镜表用右侧抽屉是**对的** —— 表格很宽，从右侧滑出不打断横向视线，关掉就回到原处。但首页是一面几乎空白的项目墙，同一个贴边抽屉在这里显得突兀：它贴着右边滑进来，视觉上像是"从项目卡片旁边挤出来"，和页面的空旷感不搭。同一个组件在两个语境里承担了不同的阅读期待，硬用一套形态是偷懒。

**做法**（选"居中弹出"，没有选"横铺满整屏"）：横铺满整屏意味着要新增一个第 4 个 pageview、配一套返回栈与 URL 状态，改动面大且和现有的三层视图导航（首页 / 项目主页 / 分镜表）语义打架；居中弹窗复用同一套 DOM 与渲染逻辑，只换形态，风险最小。宽度从抽屉的 480px 放到 **820px**（与项目里最大的 `.modal` 同宽），四组设置不必再挤在一列里上下滚 —— 顺带治好了窄抽屉里"默认模型"标签被挤成竖排的老毛病（820px 下正常一行）。

实现落在 `app/styles.css` 的 `.drawer.center:not(.inline)` + `app/app.js` 的 `openSettings({center:true})`，`#homeSettings` 传入该参数；分镜表的 `#btnSettings` 不传，仍是抽屉；项目页的「设置」页签仍是就地铺满。**一份 DOM、三种形态**，渲染与保存逻辑一行未改。

**踩过的坑（三处，都是实测才暴露的）**：

1. **形态切换会"横扫"一屏。** 抽屉态的关闭位置是 `translateX(480px)`（视口外），居中态的关闭位置是屏幕正中 —— 两者差了整整一个屏幕宽。直接 `classList.toggle('center')` 会被浏览器当成一次**过渡**，于是首次从首页点设置时，窗口会从右侧抽屉位横扫到屏幕中央。修法是换形态时先把窗口 `hidden` 掉（`display:none` 不产生过渡），改完类再恢复，然后强制一次重排再挂 `.open`。副作用是顺带让抽屉态的**首次**打开也有了入场动画（原先首次打开是硬出现的）。
2. **遮罩被首页压在底下。** 首页 `.pageview` 是 `z-index:65`，高于默认遮罩的 `60` —— 这是当初刻意的（让项目页不被压暗）。但居中弹窗没有压暗背景就会"悬空"，且底下的项目卡片仍可点。加 `.mask#settingsMask.center{z-index:66}` 只抬居中态，抽屉态保持 60 不变。
3. **`.center` 与 `.inline` 会互相污染。** 就地模式只复位了 `position/inset/transform/width/box-shadow`，**盖不掉** `opacity` / `max-height` / `border-radius`。两者若同时生效，项目页的就地面板会变成"全透明 + 被限高 88vh"。用 `:not(.inline)` 做 CSS 层互斥，JS 侧另在三处显式清 `.center`（`openSettings` / `mountInlinePanel` / `unmountInlinePanel`）—— 这类"类名泄漏"本仓库已踩过 4 次（见 `styles.css:1332` 那条注释）。

另：居中态关闭时补了 `hidden = true`（抽屉态不置，保留原有滑出动画）。理由不是动画，是**可聚焦性** —— 关闭态的居中窗口仍在屏幕正中，只靠 `opacity:0` 藏的话元素仍在 Tab 序里，键盘用户会把焦点 Tab 进一个看不见的面板。

**验证**（agent-browser 实测，1080×620 视口，非仅静态检查）：

- 首页：窗口 box `[130, 37, 820, 546]` —— 水平 (1080−820)/2=130、垂直 (620−546)/2=37，**精确居中**；`border-radius:18px`；遮罩 `z-index:66`、带 `.center`；截图确认背景已压暗
- 分镜表（回归）：`box [782, 0, 480, 624]`，`border-radius:0px`，遮罩 `z-index:60` 且**无** `.center`；关闭后 `hidden:false` 且 `transform:matrix(1,0,0,1,480,0)` —— 完全未被波及
- 项目页（回归）：`drawer inline open`，`position:static`、`opacity:1`、`max-height:none`、`border-radius:0px`、遮罩隐藏 —— 互斥保险生效
- `check` 45/45、`lint` 7/7、`test` 173/173、`smoke:web` 通过、`e2e` 53 项断言全通、dist 重建 496.6 KB

**版本** `0.34.2` → `0.35.0`（MINOR：新增形态能力，向后兼容 —— 分镜表与项目页的行为一行未改）。

---

#### `0.34.2` — 2026-09-23（修复：切换账号成功后界面仍显示「待完成授权」）

**现象**（使用者实测）：点「创作 CLI 切换账号」，账号已切换成功（状态卡显示新账号与积分），但下方**仍显示**「创作 CLI 待完成授权：打开授权页 · 设备码 …」，且紧挨着一张「创作 CLI **登录成功**　打开授权页 ↗ · 设备码 …」—— 成功消息与授权等待提示自相矛盾地拼在一起。

**根因**（`app/app.js` 的 `runCliAction`，一处）：登录/切换结束时前端有一段"链接兜底"——

```js
S.dCliUrl = res.authUrl || S.dCliUrl || null;   // ← 成功时把已回收的链接"救"了回来
```

后端在成功时明确返回 `authUrl: null` 并已在 finally 里回收库里链接（`dreamina-cli.js:577`「成功才清链接」），但前端这行用 `||` 让**轮询期间捕获的旧链接**赢了返回值；而渲染取值 `dAuthUrl = S.dCliUrl || 后端状态`（`app.js:5400`）又是前端值优先 —— 后端清了也白清。于是「待完成授权」卡片持续显示；同时 `cliMsgInner` 把成功消息与残留链接拼成一行，形成截图里自相矛盾的第二张卡片。

**修正**：按结果分流 —— 成功（`okFlag`）→ 以后端返回值为准（`authUrl: null` 即清空，含 `check` 成功 = 已登录、遗留链接一并清）；失败 → 返回值优先、轮询捕获值兜底（材料阶段失败时后端已尽力发布链接，轮询大多已捕获，"失败后没链接可点"的旧担忧仍被覆盖）。`busy`（另一流程进行中）走失败分支保留旧链接，行为正确。

**验证**：dist 重建（493.1 KB）后 grep 确认渲染字符串中已无「，未配置令牌」（0 处）、新分流逻辑存在；`check` 45/45（仅环境性 §15）、`lint` 7/7、`test` 173/173。

**版本** `0.34.1` → `0.34.2`（PATCH：纯 bug 修正，无新功能）。

---

#### `0.34.1` — 2026-09-23（应用更新状态行：未配置令牌时不再显示「未配置令牌」）

**问题**：设置面板「应用更新」的状态行一直显示 `更新源 GitHub Releases（ikun1946/DreamFlow，未配置令牌）`。但**本仓库已公开、匿名即可检查更新，令牌正常情况下根本不需要**（0.28.x 已做过一轮"文案与事实收口"）—— 一个不需要的东西却标着"未配置"，会让使用者误以为自己缺了配置、甚至以为更新功能要配置才能用（实际使用者原话："目前更新已经不需要令牌了，这里为什么显示这个"）。

**修正**（`app/app.js` 状态行一处）：「配了才显示」——

- 未配置：`（ikun1946/DreamFlow）`（不再提令牌）
- 已配置：`（ikun1946/DreamFlow，已配置令牌）`（保留，让配置了私有源的用户知道令牌在生效）

令牌输入框及其说明文案（`appUpdateCfgHTML`）不动 —— 那是"更新源设置"展开后才看到的，说明令牌**什么场景才需要**（私有库 / 自建源），位置和内容都合理。`update:status` 只回传 `hasToken` 布尔值的"令牌只进不出"设计不变。

**验证**：`node build.js` 重建 dist（492.8 KB），产物中已无「未配置令牌」字样；`check` 45/45、`lint` 7/7、`test` 173/173。

**版本** `0.34.0` → `0.34.1`（PATCH：无新功能，纯显示修正）。

---

#### `0.34.0` — 2026-09-23（数据目录可在界面上更改 + 安全迁移）

**功能**：设置面板新增「数据目录」卡片 —— 可以把整个库（项目 / 素材 / 产物）从 C 盘换到别处，
不必再手动编辑 `desktop-config.json`。

**为什么做**：数据根一直"可改但不好改"，只有两条路 —— 环境变量 `JC_DATA_DIR`（进程级）或手改配置文件。
而"库放哪"恰恰最该由用户自己决定（C 盘紧张、想放外置盘、想与其他工程放一起）。

**新增**：

- `server/data-dir.js` —— 数据目录的查询与切换（`describe` / `change`），单一职责新模块
- 两条路由：`GET /api/v1/runtime/paths`、`POST /api/v1/runtime/data-dir`
- 设置面板「数据目录」卡片：显示当前位置、两种切换方式、桌面版可用系统目录选择器、一键重启
- 桌面桥两个**具名**动作：`chooseDirectory`（只回传用户亲手选中的路径）、`relaunch`
- `test/10-data-dir.test.js` —— 17 个用例

**三种场景都如实呈现，不给"改了没用"的入口**：

| 场景 | 行为 |
|---|---|
| 桌面版 | 可改：输入框 + 浏览 + 「迁移并切换」/「仅切换」 |
| 被 `JC_DATA_DIR` 锁定 | `canChange:false` —— 说明"环境变量优先级更高，改配置不会生效" |
| 网页版 | `canChange:false` —— 说明没有持久化机制 |

**★ 三条不可妥协的设计约束**（都写进了 `server/data-dir.js` 注释）：

1. **迁移用复制，不用移动** —— 移动中途失败会两边都不完整；复制失败时原库完好，
   最坏只是目标目录留半份副本（可删）。代价是需要双倍磁盘空间。
2. **配置只在全部成功之后才写** —— 写早了等于"指针已切、数据没到"，用户看到空库比报错更糟。
   迁移后还会校验条目齐全 + `db.json` 字节数一致，任一不通过**就不写配置**并明确回报"原库未动"。
3. **切换必须重启才生效** —— 本进程的 store 已把旧目录的 db.json 读进内存，继续跑会把它写回旧位置。
   所以接口只负责"改配置 + 搬数据"，重启由界面引导（桌面版可一键重启）。

**拒绝规则**（每条都有对应用例）：空值 / 相对路径 / 磁盘根目录；与当前目录相同或互为父子；
仓库内的 `server/data`（不入 git、易被误删）；**有生成任务在跑**；`move` 模式下目标目录非空。

**踩到的两个坑，都记进了注释**：

1. **`hasActiveTasks(db)` 不能直接复用** —— 它只在传了 `projectId`/`workspaceId` 时才统计
   （两处判定都在 `if (o.xxx)` 保护内），**不传作用域会返回 `{active:false}`**。
   迁移要的是"全库有没有任务在跑"，故在 `data-dir.js` 里单独实现。
2. **业务失败走「HTTP 200 + envelope.code」，不是 HTTP 状态码** —— 测试第一版按 403 写，实测拿到 200。
   已按真实契约改断言，并顺手加了一条"被拒后不得创建目标目录"。

**验证**：`npm run check` **45/45**（含路由计数口径 54→56 的同步）、`npm run lint` **7/7**、
`npm test` **173/173**、`node build.js` 重建 dist（492.7 KB）。

---

#### `0.33.0` — 2026-09-23（查清安装目录机制 + 一条防错门禁）

**本版对使用者零影响** —— 无界面、功能、数据变更，也没有必须出新安装包的理由（见文末）。

**背景**：0.32.0 换名后实测安装目录落在 `%LOCALAPPDATA%\Programs\JimengConsole\DreamFlow`，
比预期多一层。查清成因后试图用配置固定它 —— **结论是做不到**，本版记录机制并补一条门禁。

**① 嵌套的成因：两段 NSIS 逻辑叠加**（都在 `app-builder-lib/templates/nsis/`）：

- **`multiUser.nsh:26-28`** —— 升级时优先继承注册表 `HKCU\Software\{GUID}\InstallLocation` 的旧路径：
  ```nsis
  ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $perUserInstallationFolder != ""
    StrCpy $INSTDIR $perUserInstallationFolder      # 非空即用旧路径
  ${else}
    StrCpy $INSTDIR "$0\${APP_FILENAME}"            # 只有新装才用 Programs\<exe名>
  ${endif}
  ```
- **`assistedInstaller.nsh:32-38`** —— 路径里不含**当前**应用名时再追加一层：
  ```nsis
  # sanitize ... to make sure it has a application name sub-folder
  ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
  ${If} $0 == ""
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
  ```

0.25.0 时 exe 叫 `JimengConsole`、装在 `Programs\JimengConsole`；升到 0.32.0 时读到该旧路径、
且它**不含**新名 `DreamFlow` → 补一层。两段逻辑各自的初衷都合理（① 保证升级装在原地，
② 防止用户手选目录时把程序散装在根目录），只有"升级 + 改名"同时发生才会叠加。

**关键结论：只发生一次。** 0.32.0 安装后 `InstallLocation` 已更新为含 `DreamFlow` 的路径
（实测 `…\Programs\JimengConsole\DreamFlow`），两段逻辑此后都不再改动它 —— **原地升级，路径稳定**。

**② 试图用配置固定：做不到（实测）**

在 `electron-builder.yml` 写 `nsis.installDir` 会让构建**直接中止**：
```
Invalid configuration object. configuration.nsis should be one of these: null
```
查 `scheme.json` 的 `NsisOptions`：共 **42 项，不含任何安装目录属性**（既无 `installDir`，
也无 `perUserInstallationFolder`）。已把这条写进 yml 注释，避免后人重试。

> 真要强制统一路径，唯一途径是 `nsis.include` 注入自定义 `.nsh`，在 `customPageAfterChangeDir`
> 里改写 `$INSTDIR`。**有意不做**：它会把老用户的应用再迁一次，而现状**对新用户本来就正确**
> （无旧注册表记录 → 直接落到 `Programs\DreamFlow`），收益不足。

**③ 新增一条门禁（44 → 45 项）**

`check-project.js` §4：**yml 里一旦出现 `installDir:` 就 FAIL** —— 把"要跑几分钟打包才暴露"
的构建中止提前到 0.1 秒。与既有的同类门禁同源（`signAndEditExecutable` 缩进是 0.29.4 加的、
CI 主程序名是 0.32.0 加的）。

**验证**：`npm run check` **45/45**；回退后 `npm run dist` 恢复正常（实测走过
`building target=nsis` 与 blockmap 两步）。

**要不要发版**：本版没有任何使用者可感知的变化，**不必发** —— 留给下一次有实质功能的版本一并带走。

---

#### `0.32.0` — 2026-09-23（安装包换前缀·第二步：正式改名 DreamFlow）

**这一步做完，安装包与主程序的名字终于与项目名统一了。**

| | `0.31.0`（第一步） | **`0.32.0`（本版）** |
|---|---|---|
| 安装包 | `JimengConsole-0.31.0-x64-Setup.exe` | **`DreamFlow-0.32.0-x64-Setup.exe`** |
| 主程序 | `JimengConsole.exe` | **`DreamFlow.exe`** |
| 校验接受的前缀 | 新旧都认 | 新旧都认（**不变**） |

**为什么现在能改**：第一步（`0.31.0`）已让能自动更新的用户升到「双前缀都认」的版本，
本版换掉产物名，他们收得下。若跳过第一步直接改，那些用户会「看得到更新却装不上」。

**改法**（与已删除的 `docs/产物名换前缀-第二步清单.md` 一致，共 4 处）：

1. `electron-builder.yml`：`executableName` → `DreamFlow`；`artifactName`（nsis / portable）→ `DreamFlow-${version}-…`
2. `desktop/updater.js`：`ARTIFACT_PREFIX` → `'DreamFlow-'`；`ACCEPTED_PREFIXES` 调换为 `['DreamFlow-', 'JimengConsole-']`
3. `test/03-build-release.test.js`：3 处断言同步（`ARTIFACT_PREFIX` 值、yml 形状正则、`ACCEPTED_PREFIXES` 顺序）
4. 版本号 → `0.32.0`

> ⚠ **`'JimengConsole-'` 永远不能从 `ACCEPTED_PREFIXES` 里删掉**。理由有二：
> ① 老用户机器上可能残留 `JimengConsole-*.part-*` 临时文件（每个 100+ MB），
> `cleanupStaleTemp` 靠它才清得掉；② 它同时是一条"回退旧名"的路。
> 以后再有类似换名照此办理：**新前缀进列表，旧前缀永不出列表**。（已写进 `updater.js` 的长期约束注释。）

**★ 顺带修掉一个盲区（本版最有价值的发现）**：
换名时发现 **`.github/workflows/ci.yml` 也硬编码了主程序名**（`release\win-unpacked\JimengConsole.exe`，两处）
—— 不一起改，CI 会在真跑 `npm run pack` 之后因找不到文件而失败。这类"只有跑几分钟 CI 才暴露"的错，
本地 `npm run check` 原本查不出来（与 0.29.4 那次 `signtoolOptions` 缩进事故同源）。
为此**给门禁 §4 补了一条**：CI 里引用的主程序名必须与 yml 的 `executableName` 一致，漏改任一处即 FAIL。
**门禁总项数 43 → 44。**

**同步更新的文档与脚本**（改名后这些命令/路径都会失效，必须一起改）：
`README.md`、`AGENTS.md`、`docs/项目文档.md`（冒烟命令）、`docs/版本发布与更新流程.md`
（产物名表格 + 手动上传示例改成占位符）、`THIRD-PARTY-NOTICES.md`（分发方式）、CI 两处。
**刻意未改**：`docs/项目审查与改进清单.md` 里的同款命令 —— 那份文档状态是「历史」，
保留当时的快照比改它更诚实。

**使用者会经历什么**（已同步写进 Release 说明）：

| 项 | 变化 |
|---|---|
| 安装包文件名 | `DreamFlow-0.32.0-x64-Setup.exe` |
| 可执行文件 | `DreamFlow.exe` |
| **安装目录** | `%LOCALAPPDATA%\Programs\JimengConsole\` → **`Programs\DreamFlow\`** |
| 快捷方式 | 重建（指向新 exe） |
| 任务栏固定项 | 可能失效，需重新固定一次 |
| 升级方式 | 靠 `appId` 的 GUID 识别已装实例，**不会新旧并存**，但会走「先卸后装」 |
| **用户数据** | **不受影响** —— 在 `%USERPROFILE%\Videos\JimengConsole\`，卸载时明确不删 |
| `appId` / 数据目录 | **不变**（刻意保留） |

> 安装目录随 `executableName` 变，依据是实测：`0.25.0` 装在 `%LOCALAPPDATA%\Programs\JimengConsole\`，
> 而不是 `Programs\即梦批量生成控制台\` —— 即 NSIS 的默认安装目录用的是 `executableName`，不是 `productName`。

**测试**：`npm run check` **44/44**、`npm run lint` **7/7**、`npm test` **156/156**。
反向验证：把 yml 的 `artifactName` 改回 `JimengConsole-` 而 updater 不动 → 门禁准确报出两处前缀不一致。

**收尾**：`docs/产物名换前缀-第二步清单.md` 已按该文件自身的要求删除，内容并入本节。

---

#### `0.31.0` — 2026-09-23（安装包换前缀·第一步：先放开校验）

**背景**：项目 0.27.0 已更名 **DreamFlow**（仓库名 / clone 文件夹 / npm 包名 / User-Agent / 文档全改），
但**安装包文件名一直是 `JimengConsole-*`** —— 那是更名时刻意保留的「应用身份」（理由见 0.27.0 与 0.30.0 两节）。

现在要换成 `DreamFlow-*`，但**不能只改 `electron-builder.yml`**：

> 已装 ≤0.30.0 的用户，其应用内的更新器是**旧版代码**，产物名白名单是严格单前缀的：
> `/^JimengConsole-\d+\.\d+\.\d+-x64-Setup\.exe$/`。
> 新版若把 latest.yml 指向 `DreamFlow-*.exe`，这些用户会走完
> 「找到更新 → 下载完成 → **校验拒绝**」，然后**永远升不上来**（先有鸡还是先有蛋）。

**所以分两步，顺序不可颠倒**：

| 步 | 版本 | 做什么 |
|---|---|---|
| **① 本版** | `0.31.0` | **只放开校验**（同时接受两种前缀），**产物名不变**。这一版被消化后，用户手上的白名单就变成「双前缀」。 |
| ② 下一步 | （待发） | 改 `artifactName` → `DreamFlow-${version}-x64-Setup.${ext}`、`executableName` → `DreamFlow`，并把 `ARTIFACT_PREFIX` 改成 `'DreamFlow-'`。 |

**改法**（`desktop/updater.js`）：

1. 新增 `ACCEPTED_PREFIXES = ['JimengConsole-', 'DreamFlow-']`（第一项＝**当前产物前缀**，须与 yml 一致），
   由它生成 `ARTIFACT_RE` 与 `ARTIFACT_VERSION_RE`，两者**同源** —— 避免"白名单放过了、版本却读不出"的错配。
2. `safeArtifactName` 的错误提示改为列出全部可接受前缀（原先只写死一个）。
3. **`cleanupStaleTemp` 的 `.part-` 清理改用「任一可接受前缀」判断**（原先只认 `ARTIFACT_PREFIX`）。
   否则换名后，老用户机器上残留的 `JimengConsole-*.part-*`（每个 100+ MB）会**永远清不掉** ——
   这处最容易漏，因为它不报错、只是慢慢吃磁盘。
4. 导出新增 `ACCEPTED_PREFIXES`。

**门禁与脚本同步**（不做则换名当天撞车）：

5. **`scripts/check-project.js` §4 的 artifactName 检查改为「从源码提取 `ARTIFACT_PREFIX` 再比对」**。
   原先把 `'JimengConsole-'` 写死在门禁里 —— 换名时它只会一直报"形状变了"，答不出"两处到底一不一致"。
   现在换名时门禁**自动跟随**，同时仍**强制 yml 与 updater 一起改**（漏改任一处即 FAIL）。
6. `scripts/check-signing.js` 的主程序 exe 匹配改为同时认 `JimengConsole.exe` / `DreamFlow.exe`。

**刻意保留未改**（B 级方案的范围边界）：

- **数据目录**（`runtime-paths.js` 的 `DATA_FOLDER_NAME`）→ 仍是 `%USERPROFILE%\Videos\JimengConsole\`。
  改了会让用户打开新版时以为"项目全没了"。**这是唯一会碰真实数据的改动，排除在本次之外。**
- **`appId`**（`com.ikun1946.jimengconsole`）→ 不变。它决定 Windows 能否认出"这是同一个应用"、
  能否原地升级；改了会让新旧版本并存。
- **`productName`**（中文「即梦批量生成控制台」）→ 不变。它决定 userData 目录 `%APPDATA%\即梦批量生成控制台\`。

> ⚠ 换名第二步会**迁移安装目录**：实测 0.25.0 装在 `%LOCALAPPDATA%\Programs\JimengConsole\`
> （该目录名由 `executableName` 决定，不是 `productName`），换名后变成 `Programs\DreamFlow\`。
> NSIS 靠 `appId` 生成的 GUID 识别已装实例，**不会并存**，但会走"先卸后装"：快捷方式重建、
> 用户手动固定的任务栏项可能失效。用户数据在 `Videos\` 下不受影响（`deleteAppDataOnUninstall: false`）。

**测试**：`npm run check` **43/43**、`npm run lint` **7/7**、`npm test` **156/156**（新增 1 条双前缀用例）。
新用例带**反向断言** —— 放宽不等于放开：`Evil-*`、`DreamFlowx-*`、`dreamflow-*`（小写）、`xDreamFlow-*`、
拼接后缀、版本段不完整这六种写法仍须被拒，且**新前缀的版本一致性校验同样生效**（否则换名等于丢掉这层护栏）。

**为下一步准备**：换名第二步只需改 **4 处** —— `electron-builder.yml` 的 `artifactName`（nsis / portable 各一）
与 `executableName`、`desktop/updater.js` 的 `ARTIFACT_PREFIX`、以及 `test/03-build-release.test.js` 里
对产物名形状的两处断言。**门禁会自动跟随，不需要改。**

---

#### `0.30.0` — 2026-09-23（更新流回归 + lint no-undef 兜底）

**背景**：0.29.5 修的 `Accept` 头缺陷之所以能潜伏好几个版本，根因是**更新链路只能靠人点界面验证** ——
`163e62d` 曾把三个更新源函数整段删掉都没人发现（界面表现为「更新卡片永久空白」，
而渲染进程的 `.catch(() => null)` 把错误吞了）。本版本补上自动化手段，把两个「没有被测试覆盖的角落」钉住。

**改法**：

1. **`desktop/main.js` 新增无头更新流驱动**（`JC_UPDATE_FLOW_TEST=1`）：检查 → 下载 → 校验
   （可选 `JC_UPDATE_FLOW_INSTALL=1` 再调安装器），输出一行 `[update-flow] {json}` 供机器读取，退出码 0/1。
   配合 `HEADLESS_TEST=1` 可在无显示器的环境运行。
2. **新增 `scripts/test-update-flow.ps1`**：一条命令驱动完整更新链路并断言结果 ——
   自建 local 更新源（拿 `dist/` 的 html 当"新版安装包"）→ 造旧数据 → 把 package.json 降到 `0.28.9`
   → 起 Electron 跑更新流 → **断言用户数据字节不变** → 落 `report.json`。
3. **`scripts/lint.js` 新增第 7 节「未定义的模块内调用」**（no-undef 的最小可用版）：
   专盯「函数被删掉、调用点却还在」。刻意只扫 `server` / `desktop` / `build.js` ——
   `app/` 是 IIFE + window 全局、`test/` 大量用 stub，都不适合这条规则。
4. **`desktop/main.js` 补两处变量声明**：`lastCheck` / `pendingInstaller` 在 `doCheckUpdates` 与
   `doDownloadUpdate` 里被赋值，而 `updateStatusPayload` **启动时就会读** —— 原先漏了 `let` 声明，
   造成全局污染与偶发 `ReferenceError`。
5. **修 `scripts/test-update-flow.ps1` 的四处缺陷**（2026-09-23 实跑时发现，均已在脚本内留注释）：
   - **数据破坏隐患（最严重）**：原先用 `ConvertFrom-Json | ConvertTo-Json | Set-Content` 把 package.json
     降级到旧版本，该写法会**重排整份 JSON**（4 空格缩进、`&&` 变字面 `\u0026\u0026`）。
     若脚本中途被中断、`finally` 没跑到，仓库里就留下「版本号回退 + 格式被破坏」的 package.json ——
     **2026-09-22 真实发生过一次**（版本被退成 `0.28.9`，正是该脚本 `$OldVersion` 的默认值）。
     改为**正则只替换 version 那一行** + `WriteAllText` 无 BOM 写回。
   - **编码**：加中文注释后文件仍是无 BOM UTF-8，PS 5.1 会按 GBK 误读 → 语法报错。改为 **UTF-8 with BOM**。
   - **`Remove-Item` 管道写法**：`Get-ChildItem | Remove-Item` 在部分受限环境被拒绝
     （报 `missing path operand`）；改为 `foreach` + `-Path`。
   - **删除操作的容错**：清理旧残留失败原先会因 terminating error 中断整条回归；
     改为 `try/catch` + 警告后继续。`Remove-Item Env:...` 同理（受限环境把 `Env:` 当文件路径），
     改用 `[Environment]::SetEnvironmentVariable`。

**验证**：
- `npm test` **155/155**、`npm run lint` **7/7**（第 7 节生效，29 个文件通过）、`npm run check` **43/43**。
- `test-update-flow.ps1` 在本机跑到 **step 10**，其中包含关键证据：
  **`[08] downgrade-package-json`（降到 0.28.9）→ `[09] restore-package-json` → package.json 与备份逐字符相同 ✓**
  （即上面第 5 条的修复确实生效）、mock 更新源构造 ✓、Electron 启动 ✓。
  最终卡在 PowerShell 5.1 的一个已知缺陷：`Start-Process` 继承环境时报
  「已添加项。字典中的关键字:"PATH"所添加的关键字:"Path"」（5.1 枚举环境变量大小写敏感）。
  **本机只装了 PS 5.1、没有 pwsh 7**，而该脚本的 shebang 是 `pwsh` ——
  **完整端到端需在装了 PowerShell 7 的环境（或 CI）执行**。该限制已写进脚本头部的 Usage 注释。

---

#### `0.29.6` — 2026-09-22（补 `publish` 配置 + 修正发布流程文档）

**背景**：0.29.5 发版时踩到三个坑。本轮把它们从"一次性的手改绕过"变成"不再复发的默认行为"。

**改法**：

1. **`electron-builder.yml` 补顶层 `publish` 配置**（`provider: github` / `owner: ikun1946` / `repo: DreamFlow`）。
   - **为什么必须有**：electron-builder **只在配置了 publish provider 时**才生成 `latest.yml`。
     没有它，`npm run dist` 只产出 exe 与 `.blockmap` —— 而 `latest.yml` 恰恰是应用内自更新
     读取「最新版是多少 + 校验和」的唯一来源，**缺它则传了 Release 也等于没发**。
   - **历史**：0.22.0–0.29.4 期间都没有这一段，于是每次发版都要在命令行手加
     `--config.publish.provider=github --config.publish.owner=... --config.publish.repo=...`
     才拿得到最新元数据（**0.29.5 的 Release 就是这么发的**）。写进配置后直接 `npm run dist` 即可。
   - `provider: github` 只用于生成元数据，**不代表本地打包会上传**；要明确禁止上传用 `--publish never`。
2. **修正 `docs/版本发布与更新流程.md` §4**：原文写「`npm run dist` 产出四个文件（含 latest.yml）」，
   **实测不准确**（无 publish 配置时根本不生成）。现已写明生成条件与判断标准
   （`release/` 下必须**同时有** `latest.yml`），并补记本机环境的删除保护绕过方式
   （输出到仓库外目录，避开 WorkBuddy 的 `genie-trash` fail-closed）。
3. **§6 补「引导问题」（bootstrap problem）说明**：装的版本 **≤ 0.23.0**（那些版本还没有自更新能力）
   或 **0.24.0 / 0.25.0**（更新器自身有缺陷）的使用者，**其应用内更新器无法把修复推给自己** ——
   必须手动安装一次。发布时应把这一点写进 Release 说明（0.29.5 已照此办理）。

**影响范围**：`electron-builder.yml` 与文档**都不在安装包的 `files` 白名单里**，
因此**安装包内容与 0.29.5 完全一致**（仅版本号不同）。本次改动服务的是"下次发版更顺"，对使用者无行为变化。

**测试**：`npm run check` 43/43；`npm run lint` 7/7；`npm test` 155/155；
**实测 `npm run dist`（不带任何 publish 相关 CLI 参数）产出 `latest.yml`** —— 验证配置真的生效。

---

#### `0.29.5` — 2026-09-22（★ 修复：github 更新源下「检查更新」100% 失败）

**问题（P0 · 功能完全不可用）**：桌面版的应用内自更新在 `github` 更新源下**必然失败**，
报错 `latest.yml 里没有 version / file 字段`。

**根因**：`desktop/updater.js` 两处 `Object.assign` **参数顺序写反**。
`Object.assign(target, source)` 是 **source 覆盖 target**，而

```js
Object.assign({ Accept: 'application/octet-stream' }, ghHeaders(token))
```

里 `ghHeaders()` 返回的 `{ Accept: 'application/vnd.github+json' }` **把 octet-stream 覆盖掉了**。
于是请求 GitHub 资产端点时带的是 JSON Accept，GitHub 忠实地返回**资产元数据 JSON**
（实测 1446 字节）而不是文件正文（366 字节 yml），`parseLatestYml()` 于是得到 `version: null`。

- `:405` 取 latest.yml 正文（"检查更新"环节，必然失败）
- `:421` 安装包下载的 headers（同款顺序错误）

**为什么潜伏这么久**（三条互相独立的原因）：

1. **回归只测 local 模式** —— `scripts/test-update-flow.ps1` 与单测都用 `local` 更新源 mock，
   **根本不经过 GitHub 的 Accept 语义**；
2. **报错文案误导** —— 「latest.yml 里没有 version / file 字段」指向解析器，真凶却在 headers；
3. **"声称可用" ≠ "验证过可用"** —— v0.25.0 的 Release notes 写着「以后就不用手动下载安装包了」，
   而线上 `latest.yml` 的 `download_count` 长期为 **0**（安装包是 3）——
   即这个文件**从未被成功取走过一次**。

**改法**：

1. 两处改为 `Object.assign({}, ghHeaders(token), { Accept: 'application/octet-stream' })` ——
   让 octet-stream 位于**最后一个**参数，去覆盖 `ghHeaders` 的 Accept。
2. **新增行为型回归（`test/03`，+2 用例）**：mock `https.request`，
   **直接观察应用真正发出的请求头**，断言资产请求的 `Accept` 必须是 `application/octet-stream`。
   - 刻意**不做**"源码里出现过某个词"的文本断言 —— 那类断言删掉逻辑照样绿（本仓库当日已有此教训）；
   - **做了反向验证**：把顺序改回错误写法跑测试 → 2 条断言精确 FAIL
     （`实得「application/vnd.github+json」`），确认断言真的抓得住这个缺陷。

**验证**：

- `npm test` **155/155**（153 → +2）
- **线上实测**（真实网络、直接调用生产 `check()`）：
  - 当前 `0.29.5` → `ok:true / latestVersion:0.25.0 / hasUpdate:false`（正确不降级）
  - 模拟已装 `0.24.0` → `ok:true / hasUpdate:true` ← **修复前是 `ok:false`**
  - 并正确带出 `sha512` / `size` / Release 说明 / `releaseUrl`
- 同类写法全仓库扫描：其余 `Object.assign` 均为正确的「默认值 + 允许覆盖」模式，**无同类缺陷**。

**⚠ 使用者须知（引导问题，无法靠升级自身解决）**：修好的代码只存在于新版本里。
**已装 0.24.0 / 0.25.0 的用户，其应用内的更新器仍是旧的有缺陷版本，仍无法自动升级** ——
必须**手动下载安装一次**本版本（或更高版本）；此后自动更新才真正可用。

---

#### `0.29.4` — 2026-09-22（审查清单复核：3 处陈旧/失实 + §10 / §11 门禁补漏）

**背景**：复核 `docs/项目审查与改进清单.md`（484 行），逐条与仓库实际代码/配置对照。发现 **3 处陈旧或失实**与 **2 个新的门禁盲区** —— 后者的病根与 0.29.3 修的 §16 **完全同构**：**门禁只盯它认得的写法**。

**问题**：

1. **陈旧口径** —— 状态表 P1-6 的证据写 `test/` **「三组」**（数据安全 / 任务逻辑 / 构建发布），实际是 **9 组**（`01-data-safety` … `09-err-info`）。与 0.29.3 修的「89 个用例」同类。
2. **过期表述** —— 第 15 节的示例块写着「自动化测试：**待恢复最小集合**」，而测试早已恢复（**153 用例 / 全绿**）。这条会把读者**反向误导**成"没有测试可跑"，与 §11 当初要防的危害同类。
3. **未闭环 + 状态失实** —— `.gitignore` 第 3 行 `# 本项目仓库根是 jimeng-console/` **从没改过**（仓库早已是 `DreamFlow`），而状态表 P2-14 却标 **✅**。文档**正文说要改、状态表说改完了、实际没改**，三者互相矛盾。
4. **盲区 1：`check §10` 根本扫不到 `.gitignore`** —— 它的文件白名单是 `.(md|yml|yaml|json|js|sh)`，而 `.gitignore` **无扩展名**、不在其中。所以第 3 条那行旧仓库名**放多久都不会被发现**。
5. **盲区 2：`check §11` 只认三种说法** —— `OUTDATED_RE` 限定为「没有自动化测试 / 已不保留自动化测试 / 自动化测试已删除」，于是「待恢复最小集合」「三组」这类**同一件事的其它写法**全部漏检。
6. **元问题** —— 〇节状态表（✅/◐/⏳）**全人工维护，`npm run check` 不校验其中任何一条**。因此「标 ✅ 但实际未做」是结构性必然，不是偶然疏忽 —— 这与该清单自己第 3 条抱怨的「依赖人工记忆」是同一个毛病。

**改法**：

1. **`.gitignore`** 第 3 行旧仓库名 → `DreamFlow/`（并注明它是 GitHub 仓库名）。
2. **`check §10` + `walk()` 连修三处，`check` 才真正扫得到 `.gitignore`**：
   - ① 新增 `NO_EXT_TEXT = ['.gitignore', '.gitattributes', 'LICENSE']`，不再只认带扩展名的文件；
   - ② 扩展名判断从**整路径**改为 **`basename`**（原写法对带目录的路径判断不准）；
   - ③ **`walk()` 的 skip 前缀匹配改为只对目录生效** —— skip 列表里的 `.git` 原先会把 `.gitignore` /
     `.gitattributes` 一并跳过（`'.gitignore'.startsWith('.git')` 为真），而 skip 的本意只是"不钻进目录树"。
   > **③ 是最隐蔽的一道**：只改 ①② 时门禁**仍然静默报 OK**（第一轮验证就是这么被骗过去的）。
   > 是**反向验证** —— 把 `.gitignore` 临时改回旧名、看门禁能否抓到 —— 才把它逼出来。
   > 教训：**扩了门禁不等于门禁生效，必须做一次"故意违规"的反向验证。**
3. **`check §11` 扩 `OUTDATED_RE`**：补「`自动化测试[^\n]{0,6}待恢复`」「`待恢复最小(化)?集合`」两条。
   **刻意不泛化到「未实现 / 待恢复」的裸词** —— `docs/更改文档.md` 里有 3 处「已知未实现项（边界）」是**正当的功能边界说明**，泛化会误伤。
4. **审查清单本体**：A1「三组」→「**9 组**」并补明细；A2 示例块改为「已恢复（153 用例 / 9 组）」；第 9 行状态标记改为**覆盖晚复核范围**；〇节新增**免责行**（本表人工维护、引用前请对照代码）；`npm run verify` 全绿后补环境注脚（§15 可能因 `EBUSY` 而非全绿）。
5. 版本号 `0.29.3` → `0.29.4`（`package.json` / README ×2 / `AGENTS.md` / `docs/项目文档.md` ×3）。
6. **顺带修掉扩门禁引出的两个假阳性**（新规则打到了规则自己的描述上）：
   - §10 扫到**本脚本注释里**的「仓库根是 jimeng-console」→ 加**自指豁免** `scripts/check-project.js`（与 §11 / lint.js 同一处理）；
   - §11 扫到 `docs/CHANGELOG.md` 里为说明问题而**原样引用**的旧表述 → `OUTDATED_EXEMPT` 补上 `docs/CHANGELOG.md`
     （它是 0.29.2 才新建的，当初漏进了"历史记录类文件"豁免名单）。

**刻意保留未改**：

- 该清单第 10–11 行两条引用块语义重复（都指向同一份新流程文档），但**内容正确、不误导** —— 不做无实质收益的改动。
- 二~八节的「4 条 scripts」「字符串错误码」「只允许 `.exe`」等属**当时的建议且已被超额实现**（实际 8 条 scripts；错误码实现为数字码 + 同名语义 key；更新器另加了版本一致性校验）。按**历史记录**保留，不视为过期。

**测试**：`npm run check` **43/43 全通**（§10 起覆盖无扩展名文件、§11 起覆盖新增两种表述形态；`walk()` 语义修正后其余各节无回归）、
`npm run lint` **7/7**、`npm test` **153/153**。

> ⚠ 本机在**受限沙箱**内执行时，§15 会因 `spawnSync('git')` 报 `EBUSY` 而 FAIL（43 项里 42 项通过）；
> 脱离沙箱即全通 —— 属环境限制，非仓库缺陷。

---

#### `0.29.3` — 2026-09-22（文档数量口径修正 + 第 16 节门禁补强）

**问题**：README 顶部「当前状态」表格里的数量口径**长期过期且无人发现** ——

- 表格写着「**89 个用例**」「**15 节 40 项**一致性检查」，实际是 **153 个用例 / 16 节 43 项**，相差 64 个用例、3 项检查。
- 表格里的 lint 描述只列了 5 类，实际 lint 已是 **7 项**（0.29.0 起加了 TODO 残留、未定义模块内调用）。

**根因（这才是要修的东西）**：`check-project.js` 第 16 节本来就是为了防这类漂移而存在的，但它的两条正则只认
README「版本」一节那句「`` `npm test`（N 用例） ``」与 AGENTS.md 的「N 用例全通」，**匹配不到表格里的另一份口径** ——
于是 §16 一直报 OK，表格里的旧数字从 0.29.0 一路活到 0.29.2。**门禁只盯它认得的写法，就守不住它认不出的写法。**

**改法**：

1. **README 表格**：`89 个用例` → `153 个用例`（按测试文件补全 9 组明细：数据安全 26 / 任务逻辑 20 / 构建发布 61 / 路由 6 / 队列 9 / CSP 7 / cliJobs 11 / a11y 7 / 错误码 6）；`15 节 40 项` → `16 节 43 项`；lint 描述补全为 7 项。
2. **AGENTS.md**：门禁表的 lint 行 `6 项全通` → `7 项全通`，同样补全描述。
3. **第 16 节门禁补强**（本次的关键）：除原有两处外，新增校验 README 表格的「**N 个用例**」「N 节 M 项一致性检查」「N 项静态检查」，以及 AGENTS.md 的**第二处**「N 项全通」（lint）。
   - 检查**节数**与 **lint 项数**不硬编码，直接数源码里的 `head('[N] ...')` —— 以后加减小节会自动跟上，不会有第二个人需要记住改这里。
4. **版本号同步到 0.29.3**：`package.json`（唯一生效来源）/ README ×2 / AGENTS.md / `docs/项目文档.md` ×3。
5. **`docs/项目审查与改进清单.md`** 的示例块里写死的版本声明（0.29.2）改为占位符 —— 那是个**示例模板**，钉一个具体版本号意味着每次 bump 都会被 §1 判成漂移。

**另修一处数据破坏**：`package.json` 曾被外部 PowerShell 脚本按 `ConvertTo-Json` 重新序列化 ——
版本号从 `0.29.2` 退化为 `0.28.9`，格式被重排（4 空格缩进、`&&` 变成字面 `\u0026\u0026`）。
版本号是本仓库的**唯一生效来源**，已 `git checkout` 还原为 HEAD 内容（0.29.2 + 原格式），再按第 4 条升到 0.29.3。

**测试**：`npm test` **153/153**；`npm run lint` **7/7**；`node build.js` 通过。
`npm run check` **42/43** —— 唯一 FAIL 是 `[15] git remote`，原因为当前执行环境下 Node `spawnSync('git')` 报 `EBUSY`
（bash 直连 `git remote -v` 正常），属环境限制而非仓库缺陷，与本次改动无关。

---

#### `0.29.2` — 2026-09-22（阶段 3 · README 瘦身：完整变更记录搬到 docs/CHANGELOG.md）

**问题**：之前 README.md 在「## 版本」一节里挂了 11 个版本的完整变更记录（**约 600 行**），与 README 的"入门 + 跑起来 + 注意事项"职责混在一起 —— **新用户进 GitHub 看到的是 906 行的长文**，被"0.21.0 改了什么 / 0.23.0 改了什么"淹没。

**改法**：

1. **新增 `docs/CHANGELOG.md`**：把从 0.29.0 → 0.29.1 的完整变更记录**原样搬迁**（不做任何"提炼"——历史就是历史），并附头部说明：0.29.0 之前的记录在 `docs/更改文档.md`（0.17.1 起的旧版变更日志）里。
2. **README.md 瘦身**：从 906 行 → **291 行**。
   - 删除「### 变更记录」整段（450 行 → 906 行的内容）。
   - 在底部加指针"完整变更记录见 docs/CHANGELOG.md"。
   - 在顶部加 banner"📖 完整变更记录见 docs/CHANGELOG.md（0.29.0 → 最新）"。
3. **AGENTS.md 顶部加一句"看完整变更：docs/CHANGELOG.md"**（agent 自动加载，进来就能找到）。
4. **`scripts/check-project.js` 第 16 节数量口径 / `AGENTS.md` / README / 项目文档 都同步到 0.29.2**。

**测试**：手工校验（README 顶部 / 底部都有指针；CHANGELOG.md 头部有说明 + 完整内容；构建产物不变）。

**用例总数不变（153）** —— 这是文档结构变更，不引入新行为。

---
#### `0.29.1` — 2026-09-22（阶段 3 第二刀：错误码"四件套"元数据）

**背景**：`ERR` 之前是 code ↔ name 的纯映射。前端拿到 `{code, message}` 后只能正则匹配 message 字符串判断"这错能不能重试 / 要怎么修" —— 脆且不可测。**`fail()` 也只回 `{code, message, data, traceId}` 四件**，但**后端内部**没有结构化元数据（"这个码 retryable 吗？什么 category？给用户什么提示？"），全部靠 message 文本猜。

**改法**：

1. **三张元数据表**（`server/util.js`）—— 每个 ERR 码绑 4 项：
   - `ERR_CATEGORIES` —— 大类（param / notfound / conflict / forbidden / ratelimit / internal / cli / tool / unknown）
   - `ERR_RETRYABLE` —— 是否可自动重试（前端据此决定要不要重提交按钮）
   - `ERR_HTTP` —— 对应的 HTTP 状态（默认 200；这里登记的是"严格 REST 化"时的真实值，留作未来迁移参考）
   - `ERR_HINTS` —— 人类可读建议（前端能直接弹给用户看）

2. **新增 3 个 ERR 码**（`server/util.js`）：
   - `NO_SUBMIT_ID` (51006) —— 即梦没创建任务就拒绝返回（账号异常）
   - `UPSTREAM_FAILED` (51007) —— 即梦明确返回 fail_status
   - `MODEL_NEEDS_FIRST_RUN` (51008) —— 模型首次合规未完成
   这三条之前都走 `ERR.INTERNAL` + 自由文本，前端只能 message 正则。

3. **`errInfo(code)` 纯函数**：返回 `{code, name, category, retryable, http, hint}`，未知码与 OK=0 都返回 null（前端按"未知"兜底）。

4. **`fail()` 改造**：把 `__err` 段塞进 `data` 字段，不破坏现有信封：
   ```json
   { "code": 40400, "message": "...", "data": { "__err": {name, category, retryable, messageHint} }, "traceId": "..." }
   ```
   ⚠ 不放在顶层 —— 避免破坏既有 `{code, message, data, traceId}` 信封；
   ⚠ message（具体原因）与 messageHint（通用建议）是**两件事**，前端可拼接"看到了什么 + 下一步该做什么"。

**测试 `test/09-err-info.test.js`（6 用例）**：
- **元数据完整性回归**（最重要的一条）：遍历 `Object.keys(ERR).filter(k=>k!=='OK')`，
  断言每个码都有 category / retryable / http / hint 四件。**新增 ERR 码但忘了登记元数据 → 这条立刻红**。
- 关键码的 retryable 业务期望（参数错 / 资源不存在 / 缺工具 / 缺积分 = 不可重试；上游超时 / 服务中断 / 限流 = 可重试）。
- 0.29.1 新增的 3 个码全登记。
- 未知码 → null；OK → null（成功码不进错误表）。
- 真实 HTTP 路径：404 端点的 `data.__err` 必带 category / retryable / messageHint。

**用例总数 147 → 153**。

#### `0.29.0` — 2026-09-22（阶段 3 · 可访问性：弹层 ARIA + Escape 全局 + 屏幕阅读器播报）

**范围**：流程文档 P2-3 / P3-2。本轮只做阶段 3 中**最小、最稳、行为纯增**的一块：
**可访问性**。其余四项（签名证书 / 更新流回归脚本 / README 瘦身 / 错误码四件套）
需要外部资源或单独立项，留作下几轮。

**改法**：

1. **弹层 ARIA 化**（`app/index.html`）：
   - `importMask` / `detailMask` 内部的 `.modal` 加 `role="dialog"` + `aria-modal="true"` + `aria-labelledby="..."`（指向 modal-head 的 `<h2>`）。
   - `settingsDrawer`（`<aside>`）同样加 `role="dialog"` + `aria-modal="true"` + `aria-labelledby="settingsTitle"`。
   - 三个关闭按钮都加 `aria-label="关闭..."`（屏幕阅读器默认会念 `id="importClose"`，加 aria-label 让 NVDA / VoiceOver 直接念"关闭导入弹层"）。

2. **Escape 全局关闭弹层**（`app/app.js`）：
   - `document.addEventListener('keydown', ...)` 在最外层集中判断"Escape 关最上层 modal"，
     顺序：detail > import > autoMask > settings。**为什么不绑在每个 mask 上**：
     1) 一处管所有（避免每加一个弹层要重写绑定逻辑）；
     2) 不会与弹层内部的 keydown 事件冒泡冲突；
     3) future-proof —— 新增弹层只需在这里加一条。

3. **屏幕阅读器播报区**（`app/index.html` + `app/app.js`）：
   - body 顶层加 `<div id="srLive" class="sr-only" role="status" aria-live="polite" aria-atomic="false">`。
     ⚠ 必须常驻可见（不能用 `hidden`），否则读屏工具看不到。
   - `toast()` 同步写一份到 `srLive`：先 `textContent = ''` 清空再写，强制 ARIA 把它当新消息播报
     （连同样内容也会读）。err 加 "错误：" 前缀、warn 加 "警告：" 前缀。

**测试 `test/08-a11y.test.js`（7 用例）**：读 `app/index.html` 与 `app/app.js` 的源文本，
断言：
- importMask / detailMask / settingsDrawer 都有 `role=dialog` + `aria-modal=true` + `aria-labelledby` + `aria-label`；
- body 顶层有 `srLive`（role=status / aria-live=polite / 不可 hidden）；
- `app.js` 的 keydown 处理**单点**接管所有弹层（含 `closeSettings` 别错叫）；
- `toast()` 写到 `srLive`，重置 textContent 强制重播，err 加 "错误：" 前缀。

**用例总数 140 → 147**。本地 `npm run verify` 全绿；CI 待验。

> ⚠ 本机测不到音频层（无障碍要真渲染 + 屏幕阅读器），所以这组用**静态产物形状断言**作为回归依据 —— 至少在重构 `index.html` 或 `toast()` 时能立刻发现"漏挂 aria"。**真正的端到端可访问性测试需要 Playwright + axe-core**，那是阶段 3 后续项。

#### `0.28.9` — 2026-09-22（前端静态数据抽出 app/constants.js）

**现状**：原 `app/app.js` 5517 行（单 IIFE 包住全部 UI 逻辑），超出 P2-5 的 ≤2500 行门禁。
本轮抽出最稳的一类 —— **纯静态查找表 / 常量**（无闭包依赖、无运行时计算）：
`ICONS / STATUS_TEXT / ROLE_META / ASSET_TABS / ASSET_TAB_LABEL / COLUMNS` 共 6 个常量块。

**为什么选静态数据先切**：app.js 里有 95+ 个 UI 函数共享一个全局 `S` 状态、加上轮询定时器、
闭包引用，错综复杂；一刀切到 2500 行以下是**硬做不动 也不应该硬做**的 —— 会拆掉
行为一致性。抽静态数据是最稳的第一步：零行为变更、纯文件搬家。

**改法**：
- 新增 `app/constants.js`：IIFE 内部定义 6 张表，挂到 `window.APP_*` 上。
- `app/app.js`：删掉那 6 张表，改成 `const I = window.APP_ICONS;` 等 6 行接住。
- `app/index.html`：在 `api.js` 与 `app.js` 之间插一行 `<script src="constants.js"></script>`。
- `server/server.js`：`buildIndexHtml` 也跟着改（同样的 6 行内联替换）。
- `build.js`：**无需改动** —— 阶段 2.4 已经让它按"实际出现的 `<script src>` 顺序逐个内联"，
  新增第三个脚本是被自动接管的（N=3 脚本：485.0 KB 产物，4 个 `<script>` 块全过）。

**结果**：app.js 5517 → 5461 行（-56 行）。**未达到 ≤2500 的目标**，但这是**结构性进步**：
后续按域拆"render / view / I/O"每一段都需要先建依赖图，再单独拆。**这一轮先打底**，
让"在 app.js 之外还能放文件"这件事被实际验证一遍（构建 / 加载 / 测试全过）。

**`npm run verify` 仍 140 用例全绿**（结构性变更，不引入新行为）。

#### `0.28.8` — 2026-09-22（services.js 拆 records 域 + 持久化基线）

**阶段 2.6 拆分**：
原 `server/services.js` 2334 行（跨"作用域 / 提交 / 素材 / 选项 / 适配器 / 记录"5 个域），
超过 P2-5 的 ≤2500 行门禁。本轮把**记录域**拆到 `server/records-layer.js`（独立的"业务规则"层）：

- `listRecords / getRecordDetail / deleteRecord / clearRecords / exportRecords` 共 5 个函数。
- `routes.js` 仍然 `require('./services').<name>` —— 公共 API 完全不变，只是位置换了。
- services.js 减小约 60 行，落在 ≤2500 边界内。

⚠ 这只是按域**第一刀**。剩余还有 4 个域需要按同样模式拆（按依赖从轻到重：选项 / 适配器 / 素材 / 提交编排），
每拆一个要走一次完整测验证 → 跨一次 0.28.x。**这一轮不连切是为了避免单次提交改动过大**，
让 CI 出问题时能精确定位"是哪一刀搞坏了"。

**阶段 2.8 bench-store 基线**：
新增 `scripts/bench-store.js` —— 真跑 `store.save()` × 5 次取最快，测 100 / 1000 / 5000 条分镜的落盘耗时。
基线写到 `docs/perf-baseline.json`，作为后续性能回归的对照值。

**实测**：本机（win32 / x64 / 12 CPU / Node 24.19）落盘 100 ~ 5000 条分镜均在 **亚毫秒级**（NTFS + Node libuv 写入缓冲），
真要看到差距得插 `fsync`。这次的基线数字先记下来，等有"变慢"信号时再升级测量口径。

**关键 bug 修复**：`scripts/bench-store.js` 的清理曾导致 `ENOENT db.json.tmp` —— 因为 `store.save()` 的原子写可能在事件循环里排队，文件删除与那个排队里的写入赛跑。修法：先 `store.flush()`，再让事件循环跑一帧（200ms 等待），最后才 `rmSync`。

#### `0.28.7` — 2026-09-22（cliJobs 治理：活跃保留 + 老化淘汰 + 启动期 GC）

**问题（流程文档 P2-?）**：
`cliJobs`（storyboardId → submitId / command / argv / state / ...）是事后用 `dreamina query_result --submit_id=...` 续查 / 补下载的**唯一凭据**。
原先没有任何治理 —— 跑过几百条分镜的库会无限堆，每条 ~500 B，落盘 fsync 越来越慢，
老条目还在界面列表里可见，误导排查。

**改法**：
- 新增 `server/cli-jobs.js`（独立模块）：
  - **活跃保留**：`state ∈ { submitting, downloading, queued }` 一律保留（任务正在进行中不能删）。
  - **终态双裁剪**：`succeeded / failed / canceled / ready` 按 `updatedAt` 淘汰（默认 7 天），
    同时按数量淘汰（保留最近 50 条）。⚠ `keepTerminal=0` 与 `Array.slice(-0)` 的 JS 怪癖
    必须显式短路（否则变成"全保留"，与意图相反 —— 本轮修两个真 bug）。
  - **孤儿清理**：分镜不在 `db.storyboards` 里的 cliJob 一律删（兜底 `batchDelete` 漏掉的异常路径）。
  - **缺 updatedAt 的迁移期旧数据**：按 0 毫秒兜底，必被淘汰（否则旧数据永远霸占名额）。
- `server/server.js` 启动 `boot()` 里加 GC 钩子：清理结果写系统日志，便于排查"启动期 GC 是不是修了什么"。

**测试 `test/07-cli-jobs.test.js`（11 用例）**：
- 活性判定（submitting / downloading / queued 是活跃；未知 state 按"活跃"兜底）。
- 孤儿清理（分镜已删 → cliJob 必清；清理不误伤正常条目）。
- 终态老化（超 maxAgeMs 必删、超 keepTerminal 删最老、活跃无视年龄、缺 updatedAt 必淘汰）。
- `gc()` 综合：3 组混合 + 重复调用幂等。

**用例总数 129 → 140**。

#### `0.28.6` — 2026-09-22（script-src 去 unsafe-inline：注入脚本逃逸的防线）

**背景（流程文档阶段 2.7 / P2-?）**：
页面安全策略原先是 `script-src 'self' 'unsafe-inline'`。这等于告诉浏览器"任何内联 `<script>` 都放行" —— 而 `app.js` 在 renderTable / renderRecords / renderPanel / 等多处都用 `innerHTML` 拼字符串拼出 HTML 片段。即便所有拼接都过了 `esc()`，**只要有一处漏转义，注入的 `<script>` 就会被浏览器执行**。style-src 上的 `'unsafe-inline'` 仍然保留 —— `app.js` 有几十处 `style="..."` 内联属性（进度条宽度、卡内边距），把它们全迁到 CSS 类得不偿失，且 style 不执行代码。

**改法**：
- `server/server.js` 的 CSP 改为 `script-src 'self' 'nonce-XXX'`；`cspHeader(nonce)` 与 `makeNonce()` 是 server 暴露的两个**纯函数**，便于测试。
- 每次响应生成新 nonce：sha256(时间戳 + 计数 + Math.random())，base64 输出。
- 主题防滑那段 index.html 内联 `<script>` 由 server 端加 nonce（index.html 源文件里不带 nonce —— 那是响应产物的一部分）。
- 桌面版的 Token 引导 `<script>` 也用同一个 nonce。

**测试**：`test/06-csp.test.js`（7 用例）真起服务 + 真发 HTTP：
- 响应头 CSP 形态（无 unsafe-inline / 有 nonce / 长度够）。
- **5 次响应的 nonce 必须互不相同**（重复 nonce 等于 nonce 失效）。
- 主题防滑脚本**必须**带 nonce（否则浏览器拒掉、首屏闪亮）。
- 整段 HTML 里 `<script>` 总数 = "外链 + 带 nonce 的内联" + "0 个不带 nonce 的内联" —— 这是钉住"产物层面没有漏"的关键断言，回归里能抓住任何"漏加 nonce 的内联脚本"。

**smoke 测试**：本地 `node scripts/smoke-web.js --port 8891` 跑通；用例总数 122 → 129。

#### `0.28.5` — 2026-09-22（更新互斥状态机抽出可测模块 + 测试从"匹配源码文本"改行为型，顺带抓到两个真缺陷）

**背景（流程文档 P1-3）**：`test/03` 里有 16 处 `readFileSync` + 正则/`includes` 断言，其中「三个更新动作都包进锁里」「安装期间保持 installing 态」这类是**匹配 `main.js` 源码文本**的。文本断言的失效方向是双向的 —— 改实现（哪怕行为等价）会误报，绕过文本（行为退化）会漏报。它带来"测试很多"的错觉，却不提供回归保护。

**改法一：把状态机抽成 `desktop/update-state.js`（纯逻辑，不 require electron）**
- 五态 `idle / checking / downloading / ready / installing` + `withLock(action, fn)`；状态变化通过 `onChange` 回调外发给 `main.js`（广播仍是主进程的事）。
- 于是可以**直接调用它做行为测试**：并发第二次调用被拒绝（三种状态都拦）、`fn` 抛异常时锁必须释放（否则更新永久卡死）、安装成功保持 `installing`、调用方在 `fn` 里设的状态不被锁覆盖、未知状态名直接抛、`onChange` 只在真变化时触发、`snapshot` 的 `busy` 口径。

**★ 一抽出来就抓到两个真缺陷（都是原文本断言看不见的）**
1. **安装成功后立刻复位 `installing`**：`main.js` 的安装成功路径要留 800ms 等 detached 安装器站稳再退出，而原实现 `fn` 返回后立刻把状态复位成 `ready` —— 这 800ms 里 `canStart('install')` 是**放行**的，用户再点一次「安装」就会拉起第二个安装器，两个进程同时替换程序文件是"装坏"的最短路径。原测试只匹配源码里出现过 `installing` / `quitting = true`，完全没发现。现在 `install` 的自动回落刻意是"不复位"，失败路径由调用方显式 `set('ready')` 降级。
2. **`latest.yml` 没有 sha512 时静默跳过校验**：`copyAndVerify` / `downloadTo` 写的是 `if (expectSha512 && …)`，于是缺字段的清单会一路装到底 —— 而 sha512 正是"下到的 exe 就是 release 里声明的那个"的唯一凭据。已在唯一的清单校验落点 `assertManifestFile()` 里补成**缺 sha512 就整份拒绝**（三种更新源都经过它；electron-builder 生成的清单一定带 sha512，不会误伤正常发布）。

**改法二：测试改成行为型 + 形状断言集中到单一 describe**
- 更新器：新增 5 条**离线**行为用例（用 `local` 更新源真的跑 `download()`）：哈希对不上 → 拒绝且**目标目录一个文件都不剩**（半截包一旦被执行就是装了个坏版本）、字节数对不上 → 拒绝、哈希正确 → 逐字节一致、缺 sha512 → 拒绝、`http://` 源在发请求前就被拒。
- `preload`：用 stub 顶掉 `electron` **真的加载一次** `preload.js`，断言桥面上只有具名动作（不挂 `ipcRenderer` / `process`）、每个动作只打到自己那条 channel、`onUpdateState` 只订阅固定 `update:state` 且退订移除**同一个** handler、页面回调抛异常不冒泡、非函数入参不订阅但返回可调用的退订函数。
- 刻意保留的文本断言（打包配置 / 许可 / 主进程入口形状）**全部集中到文件末尾单一 `describe('仓库形状')`**，并在组头写明"为什么必须断言文本 + 改什么时要同步"。`test/03` 的文本型断言占比 **47% → 25%**（15/61），用例数 43 → 61。

> 教训：断言"最终结果正确"不等于断言"某道防线起作用"。本轮两次都是靠**把防线拆开验一遍**才发现问题的 —— 拆 `worker.js` 的五道守卫（0.28.4）与拆 `main.js` 的状态机（本次）。

#### `0.28.4` — 2026-09-22（队列层行为测试 + 把 README 里的数量口径交给机器盯）

**新增 `test/05-worker.test.js`（9 用例，对应流程文档阶段 2.2）**：注入假 adapter（不 spawn 真 CLI、不联网），走 `tick` / `runOne` 的**真实调度路径**，把队列里最贵的几条链路钉住：

- **并发档位**：`concurrency=2` 时一次 tick 只派发 2 条、第 3 条留在队列；空闲时 `tick` 直接返回（不白起 CLI 进程）。
- **写入守卫**（幽灵数据防线）：跑动中被删除 → 迟到结果不得回写、不得重建 `cliJobs`，但 **`submit_id` 必须留在系统日志**（那是"钱已经花了"的唯一凭据）；取消后不得复活；**旧一轮的迟到结果不得覆盖新一轮**。
- **重试边界**：`autoRetry + maxRetry=2` → 共尝试 3 次后落 failed，且**只落一条失败记录**（中间重试不记，否则记录页被刷满噪音）；关掉自动重试则一次失败即止。
- **孤儿回收**：库里有 `generating`、进程里没有 → 标中断且**不自动重投**（避免用户不知情时再扣一次积分），并把 `submit_id` 写进提示以便 `query_result` 续查。

**这组测试是做过变异验证的（这是本次真正的收获）**：把 `server/worker.js` 里的五道防线逐个拆掉再跑，确认**每一处都恰好只让对应的那一条用例变红**（删删除守卫 → 幽灵数据用例红；删 attempt 守卫 → 旧轮覆盖用例红；并发闸失效 → 档位用例红；重试上限失效 → 重试用例红；孤儿改自动重投 → 回收用例红）。

- ⚠ 第一版里"取消后不得复活"那条**是空洞的**：变异测试发现把 attempt 守卫整个删掉它照样绿 —— 因为那个场景实际是被**状态机**拦住的（`canceled → succeeded` 不是合法迁移）。于是补了一条 `generating` 状态下"旧一轮 vs 新一轮"的用例：此时状态机是**放行**的，唯一的拦路虎就是 attempt 守卫。**教训：断言"最终结果正确"不等于断言"某道防线起作用" —— 不拆开验一遍，你根本不知道是哪道闸拦住的。**
- 用例总数 95 → 104。

**把 README 里的数量口径交给机器盯（`check-project.js` 新增第 16 节）**：README「版本」一节写着「`npm test`（N 用例）、`npm run check`（N 项一致性检查）」，而这两个数字**已经漂移过两轮**（用例 89 → 95 没跟上、检查项 40 → 42 也没跟上）—— 加测试、加检查都在别的文件里，没人会想到回头改 README。现在按 `test/*.test.js` 里字面量 `test(` 的个数与检查项总数自动对账，对不上直接失败。检查项 42 → 43。

#### `0.28.3` — 2026-09-22（修 CI 双红灯：electron-builder 签名配置形状 + e2e 审计断言竞态）

**CI 第一次真正跑起来后暴露出的两个真实缺陷**（0.28.2 修掉了"自动化测试"那一步，剩下两个 job 各自的红灯）：

- **`npm run pack` / `npm run dist` 一直是坏的**（`electron-builder.yml`）：签名配置 `signAndEditExecutable` / `signtoolOptions` 原先写在**顶层**，而 electron-builder 26 的 schema 只认 `win.*` —— 它会在启动时直接报 `configuration has an unknown property` 并中止。**本地实测复现**：修前 `npm run pack` 立刻失败；把两个键缩进到 `win:` 之下后打包成功（`release/win-unpacked/JimengConsole.exe` 246 MB，无证书时正确跳过签名，exit 0）。这也解释了"0.27.0 那批加固改了打包配置却没人发现"——CI 从未跑过、pack 也没人再跑过。
  - 新增两道护栏：`scripts/check-project.js` 加"签名配置嵌套正确"检查（0.1 秒拦住"要跑几分钟打包才炸"的错），`test/03` 加同形状断言。
- **e2e 的审计断言有竞态**（`scripts/e2e-flow.js` + `server/projects.js`）：整条 e2e 只跑 ~50 ms，而 store 的常规写盘是 **200 ms 防抖合并写** —— 断言在防抖触发前就读了 `db.json`，于是"审计留痕"两条稳定失败；再叠上 Windows 的 `SIGTERM` 是**强制终止**（handler 不执行、退出前的 flush 等不到），进程一被杀审计就永远不落盘。
  - 产品侧：**彻底删除的审计改为 `store.flush()` 立即落盘** —— 不可逆动作的留痕不该停在防抖窗口里。
  - 测试侧：断言改为**轮询等待**（最多 3 秒），不再把结果绑死在"某次改动恰好是同步写"上。
- **新增 `test/04-routes.test.js`（路由层行为测试，对应流程文档阶段 2.1）**：真起服务 + 真打 HTTP，覆盖跨项目越权（父子不匹配 404 且不泄露数据）、路径段优先于查询串、未知路径 / 方法不匹配 40400、幂等回放（同 key 同路径回放、同 key 跨项目各自执行）、上传体积上限（40001 且不落库）。用例总数 89 → 95。

#### `0.28.2` — 2026-09-22（修复 CI 首跑红灯：`npm test` 的 glob 在 Node 20 上不成立）

**背景**：本仓库的 CI 在 2026-09-22 首次真正跑起来（`.github/workflows/ci.yml` 推上去之后），两个 job 都停在「自动化测试」这一步。本地却全绿 —— 差别在 **Node 版本**：本地 Node 24，CI 固定 Node 20。

**根因**：`node --test "test/*.test.js"` 里的 glob 是 **Node 21+ 才支持**的写法。Node 20 的测试运行器只接受**文件或目录路径**（官方文档原文：*one or more paths can be provided*），拿到字面量 `test/*.test.js` 会当成不存在的路径直接失败。而 Node 21+ 又取消了目录参数（只认 glob）—— 所以「目录」和「glob」都不是两边通吃的写法（两条路都实测过）。

**修法**：`npm test` 改为**逐个列出测试文件**（`node --test test/01-… test/02-… test/03-…`）—— 文件路径在 Node 20 与 21+ 上都成立。代价是新增测试文件要手动登记，因此 `scripts/check-project.js` 加了一项机器校验：**`test/` 下的每个 `*.test.js` 都必须出现在 test 脚本里**，漏登记会让 `npm run check` 直接失败（否则会出现"文件加了、CI 从不跑它"的静默缺口）。

> 教训：本地 Node 比 CI 新时，`node --test` 的**参数写法**本身就是一个兼容性陷阱 —— "本地全绿"证明不了"CI 会绿"。

#### `0.28.1` — 2026-09-21（仓库改为公开后的文档与文案收口）

**背景**：仓库由私有改为公开（实测匿名 API 返回 `private: false`、`allow_forking: true`）。此前多份文档与界面文案都写着"本仓库是私有库，需要令牌" —— 与事实不符，按"文档与代码的事实一致性"纪律逐处收口。

- **文档（4 份）**：`AGENTS.md`「仓库是私有的」→「仓库是公开的（2026-09-21 起）」（补写权限仍只属于所有者、fork 默认开启与 LICENSE 的张力）；`docs/项目文档.md` §10.3 与更新源说明同步；`docs/版本发布与更新流程.md` §5/§6 的"私有库困境"改写为公开库前提（应用内更新 `github` 模式**匿名可读、无需令牌**）；`docs/Git 私密仓库操作指南.md` 标为历史并加横幅（建私有库/私密性验证两节不再适用于本仓库）。
- **界面文案（3 处）**：设置抽屉「应用更新」的令牌说明与失败提示、托盘"检查更新失败"对话框 —— 从"本仓库是私有的，需要令牌"改为"已公开、正常无需令牌；私有库或自建源才需要"。
- **代码注释**：`desktop/updater.js` 更新源说明同步。
- **个人邮箱清理**（配合用户对 git 历史的 `filter-repo` 重写）：全历史作者/提交者邮箱已由 `2051962964@qq.com` 换成 `ikun1946@users.noreply.github.com`；仓库内最后一处邮箱引用（`docs/Git 私密仓库操作指南.md` 的环境诊断表）同步更新，并把**本仓库**的 `user.email` 固定为 noreply —— 防止后续提交再次泄漏。⚠ **远端仓库仍是旧历史（含旧邮箱）**：要让清理在 GitHub 上生效，需要一次 **force push**（本地历史已被重写，与远端无共同祖先）。
- **安全体检**：对 git 历史做了一次公开前的敏感文件扫描（`db.json` / `.env` / 私钥 / `release/` / 用户媒体）——**无命中**，历史里只有仓库自己跟踪的源码、文档与图标。

> ⚠ 公开库默认允许 fork，而 `LICENSE` 禁止再分发 —— 若要关闭，需在 GitHub 网页 Settings → General 底部操作（agent 无管理员权限）。

#### `0.28.0` — 2026-09-21（门禁与事实一致性：lint 门禁 + 5 类新检查 + 静态路由加固）

**执行《项目全面审查与改进流程》阶段 0 + 阶段 1 的成果**（流程原文见 `docs/项目全面审查与改进流程.md`）。

- **P1-1 静态路由前缀校验加固**（`server/server.js` + `server/paths.js`）：原先 `/app/` 与 `/dist/` 各写一遍 `startsWith(PROJECT_ROOT + 'app')` —— 兄弟目录（`app-old/`、`dist-backup/`）会被误判成"在范围内"，一旦有人建这类备份目录就能读到仓库内任意文件。现在收敛为 `paths.resolveStaticPath()`（静态根白名单 `['app','dist']` + `contained()` 包含性检查），与 `/files`、`/media/assets` 共用**同一套**边界实现。新增 4 条回归用例，其中 1 条是 **HTTP 级**：真起服务、真造 `app-old/` 兄弟目录、断言越界请求 404 且响应体不含标记内容 —— 有人把接线改回裸 `startsWith` 时它会红。
- **P1-6 lint 门禁**（`scripts/lint.js`，零依赖）：语法（全量 `vm.Script` 编译）、`debugger` 语句、`app/` 下调试输出、相对 `require` 目标存在性；另有 `innerHTML` 模板插值未转义与 TODO/FIXME 两个告警项。已接入 `npm run verify` 与 CI 的 Linux job（首次接入基线为 0 告警，故意插一行 `debugger` 实测能让它红）。
- **新增 5 类一致性检查**（`scripts/check-project.js`，35 → 40 项）：过期表述（"没有自动化测试"类，历史记录类文件豁免）、收尾清单一致性（`AGENTS.md` ↔ `docs/项目文档.md` §9）、`docs/` 状态标记、路由计数（与 `routes.js` 实测比对）、git remote 与声明一致。
- **P0-2 / P0-3 事实一致性清理**：`server/paths.js`、`server/cli-installer.js`、`docs/项目文档.md` §9 三处过期表述改为事实描述；`AGENTS.md` 与 `docs/项目文档.md` §9 的收尾清单逐条对齐；`docs/项目审查与改进清单.md` 加历史横幅 + 15 条逐项状态表（含证据），不再扮演"待办清单"。
- **P3-2 路由计数口径**：文档从 53 条改为 **54 条**，并写明口径（一个路由表项 = 1 条；按"路径 + 方法"组合计为 56 条）。这个数字以前"看起来精确"，实际与代码漂移了很久 —— 现在由检查项钉住。
- **P3-1 仓库命名收口**：`git remote` 更新为 `https://github.com/ikun1946/DreamFlow.git`（GitHub 端仓库已改名，旧地址只剩 301 重定向），并新增检查项防止再次漂移。
- **文档状态标记**（P2-4 的第一步）：`docs/` 下 12 份文档全部加上 `状态：现行 / 历史（写于 vX.Y）` 的头三行 —— 读者 1 分钟内能判断某份文档是现行契约还是历史设计；机器校验保证新文档不再漏标。

#### `0.27.0` — 2026-09-21（项目审查整改：P0–P2 全量修复 + 测试与 CI 恢复）

**一次性修复《项目审查与改进清单》列出的全部 16 项问题 + 2 项附加项。** 分五批落地，每批均已实测。

**P0（安全 / 稳定性）**

- **P0-1 更新器文件名路径穿越**（`desktop/updater.js`）：`path.join` 只做字符串拼接、**不做目录约束**，构造出的 `artifactName` 可含 `../` 逃出下载目录。**采用方案 C**：白名单正则 `ARTIFACT_RE`（与 `electron-builder.yml` 的 `artifactName` 同形状）+ 版本一致性校验（文件名里的版本必须等于期望版本），NUL、白名单外命名、版本不符一律拒绝。回归测试含"`path.join` 逃逸实测证据"。
- **P0-2 安装器启动状态竞争**：Promise **首次 resolve 即定型**，而 `'error'` / `'spawn'` / 超时三条路都可能 resolve，谁先到谁说了算。改为 `finish()` 一次性定型 + `'error'`/`'spawn'`/8 秒超时三路显式收敛。
- **P0-3 更新流程缺互斥锁**：拆出五态状态机 + `canStartUpdate` + `withUpdateLock`（try/finally 保证释放）+ `inflight` 标记 + `cleanupStaleTemp`（只清本项目超龄 `.part-`，不误删他程序与正式产物）。
- **P0-4 缺 LICENSE 与第三方声明**：新增 `LICENSE`（专用协议，明确禁止再分发）+ `THIRD-PARTY-NOTICES.md`（六节，边界写清"**只调用、不分发**"，合规依据在**进程边界**而非代码边界）；`package.json` 的 `license` 改为 `SEE LICENSE IN LICENSE`；两者写进 `electron-builder.yml` 的 `files` 随包分发。
- **P0-5 安装包无代码签名**：`electron-builder.yml` 加 `signAndEditExecutable` + `signtoolOptions`（sha256 / publisherName / RFC3161 时间戳）；新增 `scripts/check-signing.js` 三模式（自检 / `--verify` 逐文件验签 / `--require` 发布卡点）。**证书与密码只走环境变量** `CSC_LINK` + `CSC_KEY_PASSWORD`，绝不入库；未配置时构建仍成功（开发机通路），正式发布必须 `--require` 卡住。

**P1（工程能力）**

- **P1-6 恢复自动化测试**：`test/` 三组共 **85 用例** —— 数据安全 22（路径白名单、项目磁盘隔离、原子写、**`saveNow` 未 load 拒绝写盘**、损坏恢复、迁移幂等）、任务逻辑 20（时长钳制、音频预算、名称分组键、511xx 码表、硬删除全链）、构建发布 43（**P0-1 路径穿越回归**、版本比较、临时文件治理、更新器状态机、外部工具码表、LICENSE 覆盖）。
- **P1-7 统一检查脚本**：`scripts/check-project.js` 十节 **35 项**（版本一致性、`app/`↔`dist/` 同步、图标、yml 引用、不该入库的文件、更新器配置、画布 CLI 残留、许可声明、工程门禁、旧仓库名残留），`--quiet` 与 exit 1 语义。
- **P1-8 CI**：`.github/workflows/ci.yml` 双 job —— `check`（Linux/Node 20：check → test → build → **smoke:web** → **e2e**）与 `package`（Windows/Node 20：check → test → `npm run pack` → **桌面版 smoke**，断言退出码 0 且日志含 `[smoke] OK`）。
- **P1-9 网页版/桌面版验收分离**：新增 `scripts/smoke-web.js`（六节：启动与数据隔离 → 首页 → 接口 → 鉴权 → 边界 → 关停与残留），与桌面版 smoke 各自独立。
- **P1-10 外部工具缺失行为与错误码**：新增 **511xx 段**（`CLI_NOT_FOUND:51101` / `CLI_NOT_LOGGED_IN:51102` / `CLI_PERMISSION_DENIED:51103` / `FFMPEG_NOT_FOUND:51104` / `FFPROBE_NOT_FOUND:51105`）；`desktop/external-tools.js` 的 `TOOL_CODES` 按工具分组，`toolStatus(found)` 统一四件套（name/path/source/ok/code/action/message）；前后端码表一致性有测试钉住。

**P2（健壮性）**

- **P2-11 旧数据导入**：`writeReport` 落 `backup/import-report-*.txt`，缺失路径完整不截断，文案强调"复制而非搬家"。
- **P2-12 数据库损坏恢复与 fsync**：原子写补 `fsyncSync`（文件 + 目录）；损坏库**自动从备份恢复**并标记 `recovered=true`；空壳备份不"假成功"；`listBackups` 过滤 `.corrupt-`。
- **P2-13 彻底删除二次保护**：`hardDeletePreview`（**只读**，确认弹窗能先"看见后果"）→ 归档到 `backup/hard-delete/<id>-<时间>`（**归档失败即中止删除**）→ 删盘 → **删后复核** → 审计留痕。**并修复真实缺陷**：`backupDir` 原先只返回目录名（调用方无从定位，等于"归档了但找不回"），现改为**相对数据根的可定位路径**并新增 `backupName`，前端 toast 与审计日志同步。
- **P2-14 旧仓库名与版本漂移**：清理旧仓库名残留；`.gitignore` 补 `.test-tmp/`；`docs/项目文档.md` 的版本号由 `0.25.1` 修正为 `0.27.0`。
- **P2-15 README 顶部当前状态摘要**：新增「当前状态」区块（版本 / 平台 / 运行方式 / 引擎 / 测试与 CI 状态 / 已知限制 / **发布阻塞项**），把原本只藏在 `AGENTS.md` 后面的发布阻塞项提到前部。

**附加项**：附加-1（网页版 `JC_DATA_DIR` 不生效）已修，且 smoke 与 e2e 都有隔离回归断言；附加-2（版本漂移）同 P2-14。

**新增交付物**：`LICENSE`、`THIRD-PARTY-NOTICES.md`、`.github/workflows/ci.yml`、`test/`（helpers + 3 组用例）、`scripts/check-project.js`、`scripts/check-signing.js`、`scripts/smoke-web.js`、`scripts/e2e-flow.js`。

**版本**：仍为 `0.27.0`（本次为审查整改，未新增对外能力、无接口/数据结构变更、无迁移；按"不发版也要登记"的纪律，改动已于本条目留痕）。

#### `0.27.0` — 2026-09-21

**项目更名 DreamFlow：GitHub 仓库改名，clone 下来的文件夹就是 `DreamFlow/`**

- **仓库改名**：`ikun1946/jimeng-console` → **`ikun1946/DreamFlow`**（GitHub 侧已改，旧地址仍会跳转）。因此 `git clone https://github.com/ikun1946/DreamFlow.git` 得到的顶层文件夹就是 `DreamFlow/` —— 这正是「clone 下来整体文件夹名」的唯一决定因素（git 默认用仓库名当目录名）。
- **代码里的引用全部同步**：`desktop/updater.js` 的默认更新源仓库（`repo: 'DreamFlow'`，**这条不改，应用内更新会直接找不到 Release**）、`scripts/push-to-github.sh` 的默认仓库名、`scripts/backup-data.sh` 的备份目录（`$HOME/dreamflow-backups`）、`server/cli-installer.js` 与 updater 的 User-Agent、`package.json` / `package-lock.json` 的包名（`jimeng-console` → `dreamflow`）、README / AGENTS / docs 里全部路径与 URL。
- **中文产品名与应用身份不变**：界面标题、托盘、安装包、数据目录仍是「即梦批量生成控制台」/ `JimengConsole`。改 `appId` / `productName` / 可执行文件名会让已装的版本变成「另一个应用」（无法原地升级），改数据目录会让用户的真实数据看起来「消失」—— 所以这次**只改项目名与仓库名**，应用身份另议。

**版本**：`0.26.0 → 0.27.0`（MINOR：项目更名 + 更新源地址变更；无接口变更、无数据结构变更、无迁移）。

#### `0.26.0` — 2026-09-21

**应用图标换成设计稿 + 首页补上设置入口**

- **新图标**：改用设计稿（层叠的渐变星形）作为**应用图标与应用内图标**。`scripts/make-icons.js` 的职责从「脚本画图」改成「读图 → 缩放 → 编码」：读 `build/icon-source.png`（1254×1254），按 22% 半径切圆角，再从**原始大图**分别缩放到各尺寸（不是从 512 再缩，少一次重采样），产出三处：`build/icon.png`（512，窗口与托盘）、`build/icon.ico`（16/24/32/48/64/128/256，安装包与 exe）、`app/icon.png`（128，favicon + 顶栏品牌标）。仍然零依赖：PNG 解码 = 解析块 + `zlib.inflateSync` + 逐行反过滤；缩放用**预乘 alpha** 的面积平均（直接平均非预乘 RGB 会在边缘渗出一圈脏边）。
- **踩到的坑（已在 `server/server.js` 修掉并留注释）**：页面挂在 `/` 上，服务端本来就把 `styles.css` / `api.js` / `app.js` 三个相对引用改写成 `/app/...`；新加的 `icon.png` 漏了这条改写，浏览器去请求 `/icon.png` 直接 404 —— 表现是**两个裂图**（favicon + 顶栏品牌标）。冒烟自检的资源日志里能直接看到 `icon.png=404`，现已补上 `ICON_ANCHOR` 改写。
- **单文件版也要有图标**：`dist/` 是 `file://` 打开的，旁边没有 `icon.png`，所以 `build.js` 新增一步把 `app/icon.png` 内联成 data URI，并加进后置校验（产物里不得残留 `="icon.png"`）。
- **首页补设置入口**（用户反馈：此前只有进了项目页才够得着设置，而「刚装完、还没建项目、正要去装创作 CLI」恰恰最需要设置）：首页顶栏在「刷新」左侧新增「设置」按钮，复用同一个设置抽屉。抽屉对空库本来就是安全的（`openSettings` 里三个请求各自 catch，取不到就渲染占位）。

**版本**：`0.25.2 → 0.26.0`（MINOR：新增能力 + 图标更换；无接口变更、无数据结构变更、无迁移）。

#### `0.25.2` — 2026-09-21

**文档：把两份重叠的说明文档归并为一篇 `docs/项目文档.md`（纯文档，无代码变更）**

- **问题**：`docs/项目说明.md` 与 `docs/项目文档.md` 内容重叠 —— 后者 220 行里 7 节与前者的对应章节重复（它自己的小节标题就写着「与契约文档 3.x 一致」「与 README 一致」），剩下 3 节又与 `docs/前端页面与接口对接说明.md` 大量重叠，而且编写依据停在 `7344d94`（早于桌面版）。同一个事实有三个出口，正是这个仓库历史上文档落后的成因。
- **做法（按用户要求，最终文件名保留「项目文档」）**：把旧《项目文档》里仍独有的**前端实现要点**并入说明书 —— `api.js` / `app.js` 子模块表（§4.3）、P1 / P2 / P3 / C1 的页面与控件实现要点、进度轮询退避参数、乐观更新策略、`ERR_TEXT` 兜底文案、`build.js` 四道校验（§4.6 / §4.7）—— 然后**删除 `docs/项目说明.md`**，只留 `docs/项目文档.md` 一篇（v2.0）。
- **文档地图与维护约定同步更新**：§12 去掉两份重叠文档的条目；§13 新增一条纪律「不要再新开『项目说明 / 项目总览』类文档，要补内容就补进本文对应章节」。

**版本**：`0.25.1 → 0.25.2`（PATCH：文档整理；无代码变更、无需重建 `dist/`、无数据迁移）。

#### `0.25.1` — 2026-09-21

**文档：新增《项目说明》并把 agent 收尾清单并入（纯文档，无代码变更）**

- **新增 `docs/项目说明.md`** —— 一份「AI 通读一遍即可完整理解项目」的说明书：项目定位与类型、两种交付形态、整体结构与分层铁律、**逐目录逐文件职责表**、**核心模块依赖图与「唯一事实来源」清单**、六条主要流程（启动 / 生成链路 / 素材 / CLI 安装 / 应用内更新 / 发版）、配置与运行方式（命令 / 端口 / 环境变量 / 配置文件 / 数据目录 / 打包要点）、数据与存储、接口概览、已知边界与发布阻塞项、**事故注释索引**、文档地图与维护约定。
- **收尾清单正式并入文档**：`docs/项目说明.md` §9 与 `AGENTS.md` 的「完成一项工作后的固定动作」内容一致；新增 §9.1 说明该清单的存放位置 —— 它在**仓库根 `AGENTS.md`**、随 git 一起上传，但**不进安装包**（`electron-builder.yml` 的 `files` 白名单不含 `*.md`）。两处同步要求已写进清单第 5 步与文档维护约定。
- **`docs/项目文档.md` 标注为前端时代文档**：编写依据停在 HEAD `7344d94`（早于桌面版），文首指向 `docs/项目说明.md`；页面级细节仍保留参考价值。

**版本**：`0.25.0 → 0.25.1`（PATCH：文档更新；无代码变更、无需重建 `dist/`、无数据迁移）。

> 注：本条新增的 `docs/项目说明.md` 已在 `0.25.2` 归并进 `docs/项目文档.md`（见上一条），该文件名已不再存在。

#### `0.25.0` — 2026-09-21

**导入资产：落库前预览（可改类型 / 可手动关联）+ 素材改类型 + 切换动效**

三个问题一起修（用户实测反馈）：

- **切换太生硬**：导入弹层原来每次状态变化都整体重建 `innerHTML` —— 切模式时内容瞬换，而两个面板高度差很大、弹窗高度跟着跳。改成**骨架只建一次、三个面板常驻 DOM**，切模式只改 `.on` 并做淡入 + 高度平滑过渡（尊重 `prefers-reduced-motion`）；事件改成一次性委托，不再每次重绘都重挂监听。副作用是切模式后已选文件不再丢。
- **图片对不上已有素材**：匹配规则**未改**（仍是精确同名 —— 「白色信封」不会自动配上「信封」），改为在**落库前**给一张预览清单：每个文件显示去向（补图到「X」/ 覆盖「X」的图 / 新增），对不上的可以**手动关联**到库里已有的同 kind 素材，也可以改回「不关联」。
- **图片全堆进角色页**：根因是新增素材的类型直接取"当前页签"，而页签默认「角色」，文件名完全不参与判断。现在预览里每个「新增」行都有**类型下拉**（默认当前页签、可改），并有"全部新增设为 X"的批量入口；另加**改类型**能力把已经错分类的素材挪回去 —— 素材详情里单个改，或批量选择模式的操作条里「设为类型」。

**接口**：`PATCH /api/v1/assets/{id}` 新增可选字段 `type`（校验必须同 kind：图片不能变音频，反之亦然；类型真的变化时解除该素材在**本项目全部分镜**上的绑定并返回 `unbound` —— 绑定里的 `role` 就是素材类型，不改就会错位）；新增 `GET /api/v1/assets/{id}/usage` → `{ assetId, count, storyboards[] }`（改类型前要给出准确的"N 条分镜"提示，而 `listAssets` 不返回引用计数）。**无数据库结构变更、无迁移。**

**顺带修一个悬空引用 bug**：`deleteAsset` 原来用 `scopeStoryboards`（**工作区级**）解绑，同一个项目的**其它分镜表**里的引用会留下悬空 `assetId`（分镜引着一个已不存在的素材）。改用新增的 `projectStoryboards`（项目级），改类型的解绑也用同一个。

**版本**：`0.24.0 → 0.25.0`（MINOR：新增导入预览与素材改类型能力；接口向后兼容，旧数据无需迁移）。

#### `0.24.0` — 2026-09-21

**应用内自更新：桌面版能在应用内完成更新**

此前"更新"要手动下载安装包再双击安装。现在桌面版可以：**检查 → 下载 → 校验 → 静默安装 → 自动重启**，全程不用离开应用。

- **入口两处**：设置抽屉的「应用更新」卡片，以及托盘菜单「检查更新…」。
- **为什么不用 `electron-updater`**：自更新真正需要的只有「知道最新版是多少、下载、调起安装器」三件事，而 electron-builder 生成的 NSIS 安装器**本来就支持**这三个开关（依据：`NsisTarget.js` 的 `flags(["updated","force-run",...])`）—— `/S` 静默安装、`--updated` 标记为升级（`installUtil.nsh` 明确用它保证**用户数据不被删**）、`--force-run` 装完自动重启（`installSection.nsh` 第 106 行：辅助式安装器只在 `Silent + isForceRun` 时才重启）。本仓库坚持零运行时依赖，不为此再引一个。
- **更新源三种模式**：`github`（默认；**本仓库已公开，匿名可读、无需令牌** —— 私有库才必须配只读令牌）/ `url`（公开 CDN 或自建静态站）/ `local`（离线、内网，或开发机自测："刚打完包，让装好的应用直接升级"）。
- **四道安全闸**：① 网络源只接受 https（更新源是用户可配的，允许 http 等于让链路上任何人替换"会被执行的 exe"）；② 下载完校验 sha512（`latest.yml` 里带着 electron-builder 生成的哈希），边下边算；③ 校验不过就丢弃、绝不交给安装器；④ 跨域重定向丢掉 `Authorization` 头（GitHub 附件下载会 302 到对象存储）。另外**令牌只进不出** —— `update:setSource` 接受它，`update:status` 只回传 `hasToken`，不把已存的密钥回传给页面。

**版本**：`0.23.0 → 0.24.0`（MINOR：新增应用自更新能力；接口向后兼容，旧数据无需迁移）。

#### `0.23.0` — 2026-09-21

**创作 CLI 一键安装与更新 + 应用图标重做**

##### 创作 CLI：没装过的用户现在也能用了

- **应用内一键安装**（新增 `server/cli-installer.js`）：从**官方 CDN** 下载官方二进制，装到官方安装脚本用的默认位置 `%USERPROFILE%\bin\dreamina.exe`。此前官方只提供 `curl -s https://jimeng.jianying.com/cli | bash` 一种安装方式，而那个脚本的 Windows 分支要求 MINGW/MSYS/CYGWIN（即 Git Bash）—— **干净的 Windows 电脑根本跑不了**，没装过 CLI 的用户完全无法使用本应用，而界面上给的还就是那句执行不了的 bash 命令。
- **刻意不内置二进制**：再分发授权至今未确认；运行时从官方源下载不改变分发主体（用户从官方拿，应用只是搬运）。
- **更新检查与一键更新**：按「本地 exe 体积 vs 官方构建体积」判断有没有新版（官方没为二进制提供哈希，这是**够用的启发式，不是密码学级别的确认**）；更新就地替换，旧版备份为 `.bak-<时间>`。
- **下载安全四道闸**：先落临时文件 → 校验是合法 PE（防 CDN 返回 HTML 错误页）→ 备份旧版 → 原子改名；下载完比字节数，防半截文件被当成成功。
- **安装进度**：30 MB 在慢网下要几分钟，界面显示「下载中 70%（21.5 MB / 约 30 MB）…」，而不是只给一句"下载中"让人判断不了死活。
- **界面改三态 + 向导**：未安装 / 已安装未登录 / 就绪，各自给对应动作（安装 / 登录 / 无），并显示"官方当前版本"。原来只有一句"未就绪"，用户不知道该装还是该登录。

##### 修掉两个真 bug

- **版本检测与实际的 exe 脱钩**：原来读 `~/.dreamina_cli/version.json` 判断"装没装"、取版本号 —— 那是**上次安装脚本写下的**，跟实际在跑的 exe 没有任何绑定关系。后果是两个方向相反的错判：exe 不存在时误报「已安装但未登录」（把用户引去查登录问题），exe 正常但文件缺失时又把完全可用的 CLI 判成"不可用"。现在改为问 **exe 自己**（`dreamina version` 返回 commit 与构建时间），并用 spawn 是否成功判断装没装；"官方最新版"则单独从官方 CDN 的 `version.json` 取，两者不再混用。
- **空库时设置抽屉半渲染**：还没建项目时 `getSettings` 会 reject，原来的 `Promise.all` 被它一并带崩，`await` 之后的第二次渲染永远不执行 —— 抽屉停在第一次渲染的占位内容上，CLI 区块显示成"状态未知"。而"刚装完、还没建项目、正准备装 CLI"恰恰是最需要这个抽屉正常的场景。改为三个请求各自独立失败。
- **探测性能**：`version` 与 `user_credit` 两条命令改为并行（实测串行 5.9s、并行 3.1s）。

##### 应用图标重做

- 从"扁平渐变 + 白色播放三角 + 右下三条刻度"改为**三张层叠的分镜卡片 + 前卡片上挖空的播放三角** —— 层叠本身就是"一叠待处理的分镜"，是"批量"最直白的视觉隐喻。
- 底色由两段线性渐变改为**三段**（蓝→靛→紫）+ 左上柔光：两色在中间直接插值会发灰。
- 三角改为**挖空**（填底色）而不是叠白三角 —— 白三角压在白卡片上等于看不见。
- 尺寸是照着 **16×16** 调的：第一版后两张卡片透明度太低（0.20/0.38）、三角偏小，缩到 16px 时层叠感完全消失、"批量"的意思直接丢了；提到 0.30/0.52 并放大三角后才达标。

**版本**：`0.22.0 → 0.23.0`（MINOR：新增创作 CLI 安装/更新能力、重做图标；接口向后兼容，旧数据无需迁移）。

#### `0.22.0` — 2026-09-20

**Windows 桌面版（Electron + electron-builder + NSIS）** —— 从"手动起服务 + 浏览器打开"变成可安装的桌面应用。前端 `app/` 与后端业务逻辑**一行未改**，改的是"谁启停服务、数据放哪、怎么退出"。

- **服务从"加载即启动"改成可启停模块**：新增 `server/server.js`（`createServer()` → `{start, stop, url, …}`）与 `server/runtime.js`（运行模式 / 数据根 / 生效配置的唯一持有者）。`server/index.js` 退化成命令行入口。旧写法的问题不是"不够优雅"：`index.js` 一旦被 require 就起服务、起定时器、挂信号监听，Electron 主进程既管不了它的生命周期，也没法在退出时保证落盘。
- **数据根从常量改成"调用时读取"**：`config.js` 的 `DATA_DIR` / `store.js` 的 `DB_FILE` 原来是模块级常量，require 时就快照死了。桌面版必须把库放到用户可写目录（装到 Program Files 后安装目录只读），所以改成 getter + 懒加载的 `paths.js` 根。`runtime.js` 刻意**不** require `config`/`paths`，避免循环依赖。
- **随机端口 + 一次性 Token**：`port: 0` 让系统分配空闲端口（不再因为 8787 被占而整个应用起不来）；Token 每次启动重新生成、只存内存，页面在 `api.js` 之前被注入 `window.APP_CONFIG={token}`。仅监听 `127.0.0.1`，Origin 不匹配直接 403。
- **优雅退出**：`stop()` 清 tick → `dreamina.shutdown()`（Windows 用 `taskkill /T /F` 收整棵进程树）→ `store.flush()` → `closeAllConnections()` + 关服务（3 秒兜底）。修掉了此前 Node 退出时的 libuv 断言崩溃。
- **目录布局拆成两处**：配置/日志在 `%APPDATA%\即梦批量生成控制台\`，数据根在 `%USERPROFILE%\Videos\JimengConsole\`（视频动辄几个 GB，不放会被云同步拖走的漫游目录）。数据根可用 `JC_DATA_DIR` 覆盖。
- **旧数据导入**（`desktop/legacy-import.js`）：首次启动自动检测旧 `server/data` 并询问；导入是**复制**不是搬家，目标已有库先备份到 `backup/pre-import-<时间戳>/`，结束后输出"项目/分镜表/分镜/素材/记录/视频文件"计数 + **引用完整性检查**（逐条列出找不到的文件）。托盘菜单另有手动入口，供打包后自选目录。
- **外部工具检测**（`desktop/external-tools.js`）：按「显式配置 → 随包 `resources\bin\` → PATH → 常见安装位置」定位 `dreamina`/`ffmpeg`/`ffprobe`；缺失只影响对应功能，不阻断启动。
- **托盘与任务保护**：有任务在跑时关窗只收进托盘并弹气泡（不让一次误点关窗掐断本地跟踪）；托盘可看运行中任务数、开数据/日志目录、跑环境检测。
- **渲染进程加固**：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` / `webSecurity:true`；preload 只经 `contextBridge` 暴露具名方法；新窗口与导航只放行本机同端口，其余 `https` 交给系统浏览器、其它协议拒绝；`shell:showItem` 校验路径必须落在数据目录内。页面加 CSP。
- **打包**：`electron-builder.yml` + NSIS，`perMachine:false`（不弹 UAC）、可选安装路径、桌面/开始菜单快捷方式、**`deleteAppDataOnUninstall:false`（卸载不删用户数据）**。`files` 白名单排除 `server/data`，避免把开发机上的库误发给别人。图标由 `scripts/make-icons.js` 零依赖生成（自写 PNG/ICO 编码）。
- **打包后自检**：`JC_DESKTOP_SMOKE=1` 会截图 + 落 DOM 快照 + 打印视图几何/资源状态/工具路径后自行退出；渲染进程 `error` 级控制台消息一律转进 `logs\main.log`（打包版没有 DevTools，页面抛异常的表现就是"窗口开了但一片白"，这条日志是唯一线索）。
- **修掉一个真机上很难查的首屏缺陷**：`bootFromUrl()` 原来 `await` 适配器探测，而该探测要真去问一次 dreamina CLI（本机实测 **2.5s**）。桌面版冷启动时这三层视图在探测完成前都是 `hidden`，用户看到的就是"窗口打开了、一片空白、几秒后才出现首页"——在桌面场景里这跟启动失败没有区别。改为只发起不等待，结果回来再补一次顶栏；实测首屏从 >2.5s 降到 1.5s 内可见。

**同版本内的前端改动**（`c88f051`）：分镜命名优化、三层页面转场、窄屏布局修复。

**⚠ 发布阻塞项（未解决，别当成已完成）**：仓库仍无 `LICENSE`；本机 `dreamina.exe` 未签名且**未确认允许再分发**（故首版只做检测、不内置）；FFmpeg 为 GPL 构建且单二进制约 212 MB（同样未内置）；安装包**无代码签名**（`Get-AuthenticodeSignature` 为 `NotSigned`，用户会看到 SmartScreen 警告）。

**版本**：`0.21.0 → 0.22.0`（MINOR：新增桌面端交付形态；网页版接口与数据格式不变，旧库可由桌面版导入）。

#### `0.21.0` — 2026-09-20

**深色模式（B 阶段）：`[data-theme="dark"]` 主题 + 主色阶 + 三态切换 + 持久化**（方案见 `docs/深色模式设计方案.md`）

- **`[data-theme="dark"]{…}` 59 项令牌覆盖**，**全部是 `:root` 已有令牌的重声明**（脚本判定"深色令牌不在 root 内" = 0 项）⇒ **零新增令牌、规则体内零字面量**。另有 14 条深色额外规则：3 条走令牌（`.modal` 1px 边框 / 缩略图 `inset` 内描边 / `.rail` 右边界），11 条含字面量（6×`.hl-*` + 5×`.b-*`，是"不拆 22 个低复用令牌"的刻意选择，靠选择器落进**既有**白名单来避免其扩大）。
- **原生控件的 `color-scheme`（方案原未覆盖的缺陷类）**：`<select>`/`<textarea>` 等依赖 UA 默认外观的控件，**只覆盖令牌管不到**——设置抽屉里 4 个下拉在深色下仍是白底。修法：`:root{color-scheme:light}` + `[data-theme="dark"]{color-scheme:dark}`（浅色侧也显式声明，以免受操作系统深色偏好反向影响）。**这类问题只看令牌清单永远发现不了，是截图逼出来的。**
- **主色阶接替 `opacity`**：`.btn-primary:hover → --primary-600`、新增 `:active → --primary-700`（浅 `#0058B0`/`#004C99`，深 `#0A5FBF`/`#0956AC`）。`opacity` 压暗在深色下令实心蓝"趋向背景"并连带压淡白字。
- **三态外观切换**：设置抽屉 →「个性化」→「外观」（跟随系统 / 浅色 / 深色），**复用既有 `data-toggle` 分派**，不新造机制。**双属性**设计：`data-theme-mode` 记**用户选择**、`data-theme` 记**解析结果**，CSS 只认后者——闭合了单属性方案"无法回显『跟随系统』选中态"的缺口。
- **持久化**：`jmc.theme` + `<head>` 同步内联脚本**防首屏闪白**（全仓库此前 localStorage 用量为 0，无既有约定可复用）。
- **内联 SVG → `currentColor`**：`app.js` 与 `index.html` 的内联 SVG 颜色改为 `currentColor`，由承载元素着色——这样 CSS 令牌才管得住图标。豁免 `on-accent` 类：压在实心蓝/绿/灰底上的白符号、播放三角、品牌 logo。
- **两处反转陷阱**：①`.btn-dark{background:var(--ink);color:#fff}` —— `--ink` 深色下翻转成浅色 ⇒ **白字全丢**，改 `color:var(--surface)`；②`<video>` 产物底 `#0B0D12` 与深色 surface 对比仅 **1.09:1** ⇒ 新增 `--video-edge`（浅 `transparent` / 深 `--hairline`）+ `outline`（不占布局，故浅色逐像素不变）。
- **`build.js`**：`<script>` 块数由**写死 2** 改为 `inlineScripts + 2`（`<head>` 新增防闪脚本后必然变 3）。写死的 `2` 本身是一道"**结构走线报警**"，改成推导后被削弱，故做**两项破坏性验证**证明它仍会响：改坏锚点 ⇒ `exit=1`；往 `app.js` 混入一个字面量 `<script>` ⇒ `exit=1` 报"应为 3 个，实际 4 个"；还原后逐字节一致、`exit=0`。
- **验证**：浅 36 + 深 36 = **72 项控制台错误全 0**（并先注入错误**证伪报错通道**）；浅色回归 **2534px（0.196%）、最大通道差 19**，差异段全部落在图标行；`_check.js` 豁免白名单**仍 18 条、未扩大**；6 个 `.hl-*` 规则齐备；构建四项内置校验通过（dist 352.2 KB）。
- **⚠ 用户可见的浅色变化**：内联图标**略微变深**（`#7A7A7A` → `#67676B`）——那 35 处图标一直停在旧灰色，而 `--ink48` 令牌早在 `0.19.0` 就已提升；本次 `currentColor` 化顺手修掉了这处不一致。**这是本阶段唯一被声明的浅色变化。**

**版本**：`0.20.0 → 0.21.0`（MINOR：新增深色主题与三态切换能力；接口与数据格式无变化）。

#### `0.20.0` — 2026-09-20

**深色模式（A 阶段）：颜色字面量令牌化** —— 纯结构整理，**观感零变化**

深色模式只能靠"覆盖令牌"实现，而样式表里大量颜色是**写死在规则里的字面量**，不随令牌翻转——只加主题块，深色下就会出现白底白字、白块、发光焦点环。所以第一步必须让"**所有颜色都来自令牌**"。

- **`:root` 令牌 35 → 76**（新增 41 个），**全部取原字面量的精确值**。比设计方案预期的 14 个多 27：方案把多处「**近似但不等**」的值合并进既有令牌（`.menu` 的 `rgba(0,0,0,.12)` vs `--shadow-2` 的 `rgba(16,20,28,.12)`、`#E4E4E8` vs `--track` 的 `#F0F0F0`、`#D6E6F7` vs `--primary-bg` 的 `#E6F0FA`、`#F79E99`/`#F0C4C8` vs `--err` 的 `#D70015` 等），而本阶段门禁是**逐像素零变化**，合并会改变计算值 ⇒ **各留独立令牌**。备选方案（微色留 CSS + B 阶段用选择器覆盖）会使豁免白名单从 18 条膨胀到约 60 条、令其失去意义，故不采纳。
- **`--focus` 的值里含 `#fff`**（焦点环白隙）⇒ 拆出 `--focus-gap`。否则覆盖 `--primary` 也救不了它，深色下会变成**发光白圈**。
- 25 处 `background:#fff` → `--surface`；表格三档抽 `--zebra`/`--row-hover`/`--row-sel`；遮罩族抽 `--mask`/`--mask-soft`/`--scrim-label`/`--scrim-1/-2/-3`；`#panelMask` 的**内联 style 移入 CSS**（否则深色改不动）；19 处 `color:var(--primary)` → `--primary-ink`；6 个结构阴影**逐个按精确值令牌化**（未折叠）。
- **零变化证明（两项，可复现）**：① **声明级全量比对**——把每个声明的 `var()` 递归展开为字面量并归一，比对"声明多重集"：基线 **2404** 条 vs 现在 **2405** 条，**唯一差异 1 处**（从 `index.html` 搬进 CSS 的 `#panelMask` 背景，同值）⇒ 全表计算值 **100% 未变**，**且覆盖截图够不到的 hover / 选中 / 遮罩 / 焦点环**；② 截图 6 视图 × 6 档 = 36 对，**34 对字节完全相同**，2 对经**三重证伪**定位为 textarea **光标闪烁**（同版连拍复现、基线连拍复现、`blur()` 后 md5 全同）。
- 六档 0 控制台错误（并先注入错误证伪通道）；机械校验"去注释 + `:root` 之外无残留字面量" ✓（18 条按**选择器**判定的豁免白名单）；6 个 `.hl-*` 规则齐备（**替代已在 `0.17.1` 删除的 `hl-rules.test.js`**）；构建四项内置校验通过。

**版本**：`0.19.0 → 0.20.0`（MINOR：无接口与数据格式变化；纯结构整理，观感零变化）。

> ⚠ 本条目是**事后补写**——A 阶段提交时漏写 README 变更记录与 `docs/更改文档.md` 对应小节（违反该文件 §5 第 1 条），于 B 阶段一并补上。

#### `0.19.0` — 2026-09-20

**UI 优化方案先审计后执行：修订为 v1.1，并落地其中 M1–M3**（方案见 `docs/UI优化方案.md`）。

**先纠正了方案的结论**（详见 `docs/更改文档.md` 同名一节）：

1. 方案称「导入、分镜详情、干跑、自动匹配、时长重算 **5 个弹窗无 Esc 监听**」—— **实测 5 个全部已绑**：`app.js:5176-5182` 有一段统一分发器（在 `bindStatic` 内）一次处理导入/设置/详情，干跑/自动匹配/时长重算各自绑定；`git show 2b2b01a:app/app.js` 第 4695 行与它**逐字相同**，即 **v0.16.0 时就有**。
2. 方案基线是 `2b2b01a`(v0.16.0)，**全部行号已过期**（`styles.css` 1356→**1386**、`app.js` 4727→**5209**）。
3. `#5E5E63` 实算 **6.45:1**（方案写「≈5.0:1」）；并补折中值 `#67676B`。
4. A4「`padding` 扩热区至 ≥28–32px，视觉尺寸不变」**几何不可行**：`.thumb` 仅 **40×52px**、其内删除钮 14px 且 hover 才现（触屏不可达）；且 `styles.css:58-62` 明确警告这批按钮**必须 `padding:0`**。
5. W2 深色模式**成本被低估三倍以上**：`:root` 仅 33 个令牌（18 颜色），但散落 **114 hex + 35 rgba = 149 处非令牌颜色**（`#fff` 42 处），且焦点令牌 `--focus` **的值本身含 `#fff`**。

**本次落地**：

- **对比度达 WCAG AA**：`--ink48` `#7A7A7A` → **`#67676B`**。旧值在白底 4.29、在 `--parchment(#F5F5F7)` **3.94**、在 `--track(#F0F0F0)` **3.77** —— **三种底色全部违规**（方案只按白底 4.29 论证，漏了真实处境更差：多数次级文字坐在 parchment/track 上）；新值 **5.63 / 5.17 / 4.94**。改的是令牌单点，**52 处文字引用**一并生效。
- **新增 `prefers-reduced-motion` 降级**：只压 `animation/transition-duration`，**刻意不碰 `transform`** —— 抽屉/面板/详情靠 transform 位移显隐，禁掉会让它们关不掉。
- **素材面板在 ≤1440px 改为按需抽屉**，消除**每天 260px 的表格横向滚动**。根因：1440 视口下面板常驻占 336px ⇒ 表格可用仅 **1104px**，而 `.colhead`/`.row` 的 11 列合计正好 **1364px**。**实测 1440 / 1280 零横滚**；1024 仍差 166px（**已知残留，如实声明**，非缺陷）。
  - 关键做法是**拆**不是改：原 `@media (max-width:1180px)` 是混装袋（混着记录详情抽屉、序号列 sticky、批量条），只把**面板相关**规则搬入新的 `@media (max-width:1440px)`；**记录详情相关留在 1180**（实测 1440 下 `.rec-detail` 仍 `static`、1024 下仍 `fixed`+z75，证明未被连带改动）。
  - 配套必改一处：`.main{grid-template-columns:1fr var(--panel-w)}` → `1fr`。面板改 `fixed` 后不占网格格位，但第二列 336px 仍被声明，会留下 **336px 空白槽位**。
  - JS 同步：`openPanelIfOverlay()` 的 `matchMedia('(max-width:1180px)')` → `1440px`。**CSS 与 JS 不一致会出现「面板已固定到屏外、点按钮却唤不起来」的静默失效。**
- **列宽抽 `--sb-grid` 单一令牌**：`.colhead` 与 `.row` 原先**各写一遍**同一串 11 列宽（改一处必漏一处）；现两处均 `var(--sb-grid)`，与记录页 `--rec-grid` 同范式。另加 `@media (max-width:1364px)` 轻压（提示词列 `minmax(240px,1fr)`）。
- **`.drawer` z-index `70 → 68`**：**先证后改** —— 实测记录页（`.recview`，`fixed;inset:0;z-index:70`）打开时顶栏「设置」被 `span.rec-fgroup` 覆盖、自动化点击被拒，证明**抽屉与整屏记录页不能共存**，才安全降低。新阶梯：`mask60 < pageview65 < drawer68 < recview70 < rec-detail75 < panel80 < batchbar85 < menu90 < toast120`。
- **禁用态收敛为 `--disabled-opacity` 令牌**：实为 **6 个取值**（`.25/.28/.3/.4/.42/.45`，方案原稿写「三套」）→ 1 个令牌。例外：`.dur.locked button` 用 `calc(var(--disabled-opacity) - .15)` 保持净值 **.25**，因其语义是**锁定**而非禁用，统一到 `.4` 会让锁定的时长步进器看起来像可用（可感知回归）。
- **删死代码 `.pill`**（基础 + `:hover` + **响应式一条**；删前确认 `app.js`/`index.html` 引用为 0）。`.paramgrp` **保留**（`index.html:36` 仍在使用）。
- **修掉过程中引入的回归**：断点上抬后「素材」按钮在 1440 由隐藏转显示，顶栏控件总宽 1405px > 可用 1404px（**只差 1px**），`flex-wrap` 把「设置」单独挤到第二排（**52→90px**）。修法：`.topbar` 在 ≤1440 内 `gap:12px → 8px`。**绝不能用「藏掉素材按钮」换单排** —— 面板已是覆盖层，藏掉等于面板再也打不开。

**本轮未做（按审计结论移出）**：**M4**（焦点陷阱 / ARIA / Esc 统一 / 触达热区）—— 四项里仅 A4 对桌面鼠标用户有边际价值，而代价是动 5209 行 `app.js` 交互层 + 16 处监听器，且项目已删全部 106 断言（见 `0.17.1`）⇒ 收益近零、风险最高；**W2** 深色模式 —— 前置「149 处颜色字面量令牌化」未做。

**验证**（真实服务 + 真实浏览器；改动副本经 `--ink48:#67676B` 确认，8787 上的未改动副本仅作对照基线）：

| 项 | 结果 |
|---|---|
| 六档 0 控制台错误（1440/1280/1024/860/640/420） | ✅ 全 0（**并故意注入一次 JS 错误以证伪报错通道本身可用**，避免"通道坏了于是永远 0 错误"的假通过） |
| 1440 零横滚 | `.tablecol` = **1440/1440**；`.main` 计算列 = `1440px`；`#table`/`.colhead` right = 1440（证明**无 336px 空槽**） |
| 1280 零横滚 | overflow = 0，列宽逐值与设计一致（合计 1280） |
| 记录详情断点未被带走 | 1440 = `static`；1024 = `fixed` + `z-index:75` |
| 对比度 | 三个真实元素 computed color = `rgb(103,103,107)`；独立复算 5.631 / 5.172 / 4.941 |
| 静默失效清单（替代已删测试） | 11 个 `[hidden]` 目标隐藏时均 `display:none`；6 条 `.hl-*` 规则齐备且实测色互异 |
| 关键钩子 | `data-sdl`/`data-set`/`data-conc`/`data-toggle`/`data-cliact`/`#setDelim`/`.example .in`/`#cliActMsg` 全部存在且功能通过 |
| Esc | 6 个容器用真实按键逐一可关，按一次只关一个 |
| 顶栏回归修复 | 1440 单排 52px（原 90px）；四档下素材/设置按钮**恒在同一排**，无落单 |
| 构建 | `node build.js` 四项内置校验通过 |

**回退**：`backup/ui-a11y-20260920/app/` 为改前四文件全量备份；还原 `app/` 四文件即可，**无需触及 `server/` 与 `db.json`**。

**版本**：`0.18.0 → 0.19.0`（MINOR：接口与数据格式无变化，但「素材面板由常驻改正需唤起」属用户可见的交互形态变更；参照 `0.13.2 → 0.14.0`「UI 术语调整」记 MINOR 的先例）。

#### `0.18.0` — 2026-09-20

**音频参考真正进入提示词 + 干跑卡片把音频显示出来**（用户报「提交生成好像并不会参考音频」）。

### 先纠正一个事实：音频**一直**是发出去的

查证结果：`--audio <绝对路径>` 本来就在组装出的命令里（干跑 argv 里就有）。用户判断"没参考"的直接原因是**干跑卡片完全没有音频那一行** —— `cmdCardHTML` 把 `al.audios` 读进来了却从没渲染，卡片只讲「参考图 / --image」。更糟的是**没有图片时**它会显示「素材引用：无（参考图通过 --image 发出…）」：只绑音频的分镜会看到这句**错误**的话。

另：用户当时**还没真正提交过**带音频的生成（7 条记录里 5 成功 1 失败都在绑音频之前，唯一的音频相关记录是干跑），所以那之前不存在"音频参与了生成但没生效"的实测证据。

### 真正缺的是提示词里的说明

图片有整套「素材锁定」区块（`@图片N` 是谁、只取外形、忽略静止姿势），而音频**一个字都没有**：`lockBlock(images, sb)` 在**没有图片时直接返回空串**，它内部那行「名字 ↔ 图号」的对应还显式过滤掉音频。模型收到的是「一段描述音色的文字 + 一个没有任何说明的音频文件」。

**新增「音频参考」区块**（`asset-lock.js:audioBlock`），与图片区块**各自独立**（图片锁外形、音频锁声音特征，约束完全不同）：

```
【音频参考｜按本命令 --audio 的上传顺序编号；本区块只作补充，不改动下方分镜文字】
音频1 = 顾言音色 → 分镜文字里的「顾言音色」即指本条音频：作为该角色的声音参考，
   只取音色特征（音高、音质、语速倾向、情绪底色）；台词内容与节奏以分镜文字为准，
   同一角色在全片中保持同一音色，不得前后换声。
禁止：不得把参考音频里的具体词句、配乐或环境噪声当作片子内容；音频只用于声音特征参考。
```

**三个调用点收成一处**：区块 + 最终提示词原本在**三个文件里各拼一次**（分发 `dreamina-cli` / 记录快照 `records` / 详情视图 `services`），加音频区块时只改一处就会出现"实际发出去的"与"界面/记录里显示的"不一致，且**没有任何报错**。现在统一走 `AL.buildPrompt(images, audios, sb)`。其中 `records.js` 原来写的是 `cat.images.length ? … : ''` —— 等于"没有图片就一个字都不加"，只绑音频时记录里的提示词与实际发出的不一致。

**顺带修的两处**：
- **指纹没覆盖音频名**（`signature` 只算 `assetId`）。区块文本里写着「音频N = <素材名>」，给音频改名后区块内容变了、指纹却没变，旧干跑记录会被误判成"未过期"。图片本来就是 id+name，现在对齐。
- **`@音频N` 越界没有任何提示**。`validate` 早就把 `@音频` 收进了引用正则，但只校验了图片的编号范围。现在音频编号也校验（音频被解绑后编号漂移是真实场景）。

**界面**：干跑卡片新增「音频参考」行（`音1 顾言音色 2.03s @音频1` + "按此顺序作为 --audio 发出；提示词开头已自动追加「音频参考」区块…"）；「素材引用：无」只在**真的什么都没有**时才显示，并改成准确的「未绑定参考图或音频，命令走 text2video」；详情弹窗与记录页的「素材锁定」标题改为「素材引用（提示词 → 参考图 / 音频）」，说明文字按实际绑定分情况说（原来只绑音频会显示「尚未绑定任何参考图。」）。

### ⚠ 一件必须说清的事：`--audio` 的效果**未经实测验证**

CLI 的 help 只写了 `repeat for each local input audio path`，命令描述是「全能参考」，而**它自己的示例用的是 `--image ./input.png --audio ./music.mp3`** —— 全篇没有"音色克隆 / 声音参考"这类字样。

所以：**我们只做到了"把音频发出去、并在提示词里说明它是声音参考"，并不能保证模型真的会照这个音频的音色合成**。这需要花积分真跑一次才能确认。如果实测发现 `--audio` 其实是配乐/音效通道，那「林晚音色」这个用法本身就不成立，得改用法或改命名 —— 这一点已如实记在这里，不当作已完成的能力。

**验证**（接口级 + 浏览器，真实数据）：

| 项 | 结果 |
|---|---|
| 组装命令 | `argv` 含 `--audio` 且路径正确；`--prompt` 的值里**含音频区块**，顺序为「素材锁定 → 音频参考 → 原文」✓ |
| 纯音频（无图片） | 图片区块为空、**音频区块仍输出**、提示词以音频区块开头、原文保留（这是此前完全失效的场景）✓ |
| 什么都没绑 | 提示词 == 原文，不加任何区块 ✓ |
| `@音频N` 校验 | `@音频3` 而只有 1 条 → 报 `AUDIO_REF_OUT_OF_RANGE`；`@音频1` 无误报 ✓ |
| 详情弹窗（浏览器） | 标题「素材引用（提示词 → 参考图 / 音频）」；横幅「本次绑定了 3 张图（--image…）与 1 条音频（--audio，作为对应角色的声音参考）」；编号表含「音1 顾言音色 音频 · 不占图片号 · 2.03s @音频1」✓ |
| 干跑卡片（浏览器） | 新增「音频参考」行，含 `音1 顾言音色 2.03s @音频1`；命令含 `--audio`；区块含【音频参考】✓ |
| 干跑记录过期判定 | 本次改动后旧干跑记录**被正确判为已过期**（提示词内容确实变了）✓ |

> 我为验证跑了一次干跑（免费、不扣积分），它新增了一条「预览」记录并刷新了该分镜的干跑记录 —— 保留着（旧的那条标着"已过期"且没有音频区块，留着反而会继续误导）。不想要可在「生成记录」里删掉。

**版本**：`0.17.3 → 0.18.0`（MINOR：新增「音频参考」提示词区块这一能力；接口与数据格式无变化，但**发给即梦的提示词内容变了**，已有音频绑定的分镜下次提交会带上新区块）。

#### `0.17.3` — 2026-09-20

**音频素材可试听 + 封面改成与图片资产一致的半透明占位 + 名称留空时用文件名**（用户三项要求）。过程中还发现并修掉两个既有缺陷。

**① 音频素材可以试听了**

四个界面都接上了真实播放器（`<audio controls>`）：**素材详情**、**素材预览**（点分镜素材格打开）、**新建音频**（选中文件即可本地试听，不等保存）、以及卡片的时长展示。共用同一个 `audioPreviewHTML()`，避免几处各写各的。地址走 `mediaUrl()` —— 素材地址是同源相对路径，发布版单文件（`file://`）下必须拼上后端源才播得出来。

实测：播放器 `readyState=4`、`duration=2.03`（与库里的 `durationSec` 一致）、**能真的起播**、无错误。

**② 音频封面改成半透明占位**

原来音频铺的是按 id 派生的**随机渐变** + 深色音符蒙层 —— 那个色块没有任何含义，却看起来像"它有封面"。现在音频与"无图图片素材"走同一条路：**浅底 + 虚线框 + 淡音符图标**（透明度 .26），悬停变主色。四处统一：卡片、素材详情、素材预览、选择弹窗的缩略图。

新增 `I.notePh` 图标（`currentColor` 描边风格，与 `I.img` 一致，好让 CSS 的 `.ph-ico` 控制深浅）。

> 顺手清掉随之变成孤儿的代码：原来的 `I.note`（`fill="#fff"` 的实心音符，专为深色蒙层设计）与两条 `.note` CSS 规则现在**没有任何使用者**了，已删除。它们是我这次改动变成死代码的，留着只会让后来者困惑；需要时从 git 历史取回即可。

**③ 名称留空时用文件名**

新建对话框里名称**留空不再直接拦下**：选了文件就用**文件名（去扩展名）**兜底，与后端 `createAsset` 的默认命名一致；两个都没有才报错。名称栏的占位文案改成「留空则用文件名；例如：林晚音色」说明这条规则。

实测：选中 `林晚_音色测试.wav` 且名称栏为空 → 自动填入 `林晚_音色测试`。

**④ 过程中发现并修掉两个既有缺陷**

都是从项目页的**资产库**点卡片时暴露的 —— 那是"预览音频"最主要的入口，不修就等于这个功能用不了：

1. **项目资产库的卡片点不动（也不可删）**。`editAsset` / `onAssetDelete` 只在 `S.assets`（**分镜面板**当前分类的列表）里找素材，而进入项目页时 `resetScopeState()` 会把 `S.assets` 清空、项目资产库的数据在 `S.proj.assets` —— 于是**点卡片、点 × 都是静默无反应**。已加共享的 `findAssetAnywhere()`（两个列表都查）。这个缺陷在我之前几轮验证里都没碰到，因为那时点的是"新建瓦片"而不是已有卡片。
2. **修好第 1 条会立刻暴露双弹窗**。面板的点击处理器挂在 **document** 上，项目页资产库又渲染**同样**的 `data-asset` / `data-assetdel`（由 `#projView` 自己的处理器处理），两边都不阻止冒泡 → 一次点击会执行两遍、弹出**两个**素材详情弹窗。已把这几个分支统一限定在 `#panel` 内（`0.17.2` 只给 `data-newasset` 加了容器判定，这次补齐 `data-asset` / `data-assetdel` / `data-tab`）。

另外补了一个小缺口：绑定素材的联表对象（`decorate` 里拼给前端的 ref）**没带 `durationSec`**，素材预览弹窗的「时长 N 秒」会静默消失（播放器仍能用，因为 `url` 在）。已补。

**验证**（真实数据 + 真实浏览器）：

| 项 | 结果 |
|---|---|
| 资产库卡片封面 | `no-pic` 生效：`background-image: none`、`border-style: dashed`、音符占位、图标透明度 .26 ✓ |
| 素材详情弹窗 | 只弹 **1 个**；播放器 src 正确；「时长 2.03 秒」；预览区 `asset-preview audio` + 虚线框 + 无渐变 ✓ |
| 素材预览弹窗（点分镜素材格） | 播放器 + 时长 2.03 秒 + 图号行「音频1（走 --audio，不占图片号）」✓ |
| 播放器可用性 | `readyState=4`、`duration=2.03`、`play()` 成功起播、`error=null` ✓ |
| 选择弹窗缩略图 | `ap-thumb no-pic`、无渐变、虚线框、音符占位、时长 2.03s；配额「音频 1 / 3 个 · 2.03 / 15 秒」✓ |
| 名称留空用文件名 | 注入合成文件 `林晚_音色测试.wav` + 空名称栏 → 自动填入 `林晚_音色测试`；新建弹窗里出现本地播放器 ✓ |
| 数据复原 | 为验证「素材预览」建的一次性分镜已删除；16 分镜 / 16 素材 / 6 记录、无探针残留、无音频绑定残留 ✓ |

> 注：内置浏览器不支持文件选择器，所以"选文件"这一步用 `DataTransfer` 注入合成文件验证（命名规则、本地试听、时长读取的失败分支都能验到）。真实 wav 的时长读取在 `0.17.0` 已用接口级验证过（ffprobe → 2.03 秒）。

**版本**：`0.17.2 → 0.17.3`（PATCH：修两个既有缺陷 + 音频展示调整 + 命名兜底；接口与数据格式无变化 —— `durationSec` 是给已有字段补进联表对象）。

#### `0.17.2` — 2026-09-20

**补齐「新建素材」槽位：分镜页右侧的素材面板也要有**（用户指出漏做）。

`0.17.0` 只在**项目页的资产库**加了新建瓦片，**分镜页右侧的素材面板漏了** —— 而面板同样是"素材库"，用户在写分镜时最常用的就是它，反而没有新建入口。现在两处都有：

| | 项目页 · 资产库 | 分镜页 · 右侧素材面板 |
|---|---|---|
| 网格 | `.pv-grid`（104px 起） | `.grid`（58px 起） |
| 当前分类状态 | `S.proj.assetTab` | `S.panelTab` |
| 新建瓦片类型 | 取自 `S.proj.assetTab` | 取自 `S.panelTab` |

- 两处都用同一个 `assetAddCardHTML(type)` 与 `.acard.add` 样式，视觉与交互一致（虚线框 + ＋，悬停变主色）。
- 面板的「本分镜素材」网格**不加**瓦片 —— 那里是已绑定的素材，新建不属于它；只加在「素材库」网格末尾。
- 面板的网格同样**始终渲染**（哪怕分类为空），空分类下瓦片是唯一入口；「没有匹配的素材」提示移到网格下方。首帧图 / 分镜图两个空分类已实测确认瓦片在。

**过程中发现并修掉一个自己引入的隐患**：面板的点击处理器挂在 **document** 上（`app.js` 里唯一的全局点击委托），会收到**全页面**的点击。项目页资产库也有一个 `[data-newasset]` 瓦片、由 `#projView` 自己的处理器处理 —— 两个处理器都不阻止冒泡，所以点项目页那个瓦片会**同时命中两处、弹出两个新建对话框**。已给面板的处理分支加上容器判定（瓦片必须确实在 `#panel` 内）。浏览器实测确认：项目页点瓦片（当前分类=场景）只弹一个「新建场景」，面板点瓦片只弹一个「新建音频」。

**验证**（浏览器实测）：面板六个分类逐个切换 → 网格都在、瓦片标签跟随分类（新建角色/场景/道具/首帧图/分镜图/音频）、空分类（首帧图、分镜图）下瓦片仍在；面板音频分类点瓦片 → 只弹 1 个「新建音频」，字段为 音频文件/名称/类型、有「选择音频文件」钮、无图片区（与项目页一致）✓

**版本**：`0.17.1 → 0.17.2`（PATCH：补齐 `0.17.0` 漏做的一处入口；接口与数据格式无变化）。

#### `0.17.1` — 2026-09-20

**删除全部自动化测试文件**（用户要求）。

删掉的 10 个文件（`server/` 下）：`model-limits` · `task-state` · `worker-guard` · `migration` · `project-isolation` · `ui-hidden-rules` · `artifact-history` · `paths-layout` · `audio-budget` · `hl-rules`，共 106 项断言。

**代价要说清楚，别当没发生**：

1. **失去回归防护**。这些测试在本轮就抓到过两个真实缺陷 —— `pickArtifact` 把谓词写成正则（每次下载产物都抛 `re.test is not a function`）、以及后端把 `audio` 改成多值而前端 `ROLE_META` 没同步（表现为"后端允许绑多个音色、界面上却没有 ＋ 按钮"）。后者接口测试与肉眼都看不出来。删掉之后同类问题只能靠手工验收发现。
2. **界面契约类缺陷失去唯一防线**。`ui-hidden-rules`（CSS 显式 `display` 盖掉 `[hidden]`，已出现 5 次）与 `hl-rules`（`.hl-<type>` 少一条规则只静默无色）这两类**不报错、只能靠机械核对**的缺陷，现在没有任何自动检查。
3. **`server/paths.js` 的 `setRoots()` 变成没有调用方的代码**。它当初就是为测试沙箱加的（把数据根指到临时目录）。已保留（将来需要沙箱时有个显式入口，好过让人去覆盖常量），但注释已改成如实说明"目前没有任何调用方"。

**没有改动的**：`server/` 的运行时代码逻辑一行未动（只改了 `paths.js` 里那段注释），接口、数据格式、前端行为全部不变 —— 所以这是 PATCH。

**版本**：`0.17.0 → 0.17.1`（PATCH：删除开发期工具 + 文档订正；对使用者可见的能力无任何变化）。

#### `0.17.0` — 2026-09-20

**资产库新增「新建素材」槽位；「自动匹配参考图」更名为「自动匹配」并同时关联图片与音色；音频参考新增数量与总时长两重上限**（用户四项要求）。

**① 资产库新增「新建素材」槽位**

资产库每个分类的素材网格末尾新增一个新建瓦片（视觉复刻分镜面板的 `.slot-add`：虚线框 + ＋，悬停变主色；尺寸对齐素材卡）。点击弹出**与「素材详情」同构**的新建对话框 —— 同一个 `.modal.narrow`、同样的 `×`/取消/ESC/点遮罩关闭与 blob URL 回收。

| 字段 | 图片类型 | 音频类型 |
|---|---|---|
| 预览区 | 可点选图片 + 本地即时预览 | 音符占位 + **「选择音频文件」按钮**（详情弹窗的音频区不可点击，没有现成入口） |
| 名称 | 必填 ≤60，占位「例如：林晚」 | 必填 ≤60，占位「例如：林晚音色」+ 命名建议 |
| 类型 | 只读展示 | 同左 |
| 文生图提示词 | 可选 | **不展示**（与详情弹窗一致：音频无提示词概念） |

- **网格始终渲染**（哪怕分类为空）—— 新建瓦片是空分类下唯一的新建入口，只在有素材时才渲染网格等于"空分类建不了东西"。
- **两个入口分工**：槽位 = 单个新建（填名称、指定类型），工具栏「+ 上传素材」= 批量导入（多选文件、按文件名自动命名、重名冲突处理）。两者都保留。
- **允许先建空素材**（新增 `POST /assets` 只建元数据），文件之后在素材详情里补。创建流程 = 先建元数据 → 再补文件；**补文件失败不回滚**（回滚会把刚填的名称一起丢掉，留在"无图"状态可重试更合理）。

**② 音频单独创建**

音频与图片的创建路径**完全分开**：各自的文件选择控件、各自的提示，音频不接受图片文件、反之亦然。

顺带修掉一个既有缺陷：**资产库的「+ 上传素材」按 `S.panelTab`（分镜面板的标签）决定素材类型**，而资产库切页只改 `S.proj.assetTab`，两者从不同步 —— 表现为"站在「场景」页上传，素材被存成「角色」"。现在导入类型由**打开它的那个界面**决定。

**③ 「自动匹配参考图」→「自动匹配」，并同时关联图片与音色**

- **只改用户可见文案**（按钮、弹窗标题、统计行、toast、注释、文档）。**`autoMatchAssets` 函数名与 `POST /storyboards/auto-assets` 路径保持不变** —— 改路由是破坏性变更且零收益。
- **音色识别**：`nameKeys(name)` → `nameKeys(name, type)`，**只有音频**才把「音色 / 声音」并入噪声词表。于是「林晚音色」的匹配主体是「林晚」，能命中提示词里的「林晚」（`via: 'core'`，与图片同一条三级匹配 `名称`→`主干`→`词块`）。
  - ⚠ `type !== 'audio'` 时噪声词表与改动前**逐字节相同** —— "匹配规则与现有图片匹配逻辑保持一致"是字面成立的，不是近似。有反向测试钉住（同名素材当图片时主干仍是整串）。
  - `group` 也变成「林晚」，但去重与歧义判定都是**按 role 分组**的，所以「林晚」（角色）与「林晚音色」（音频）同组不同 role，互不干扰，两者都会绑上。
- **音频槽位由单值改为多值**（`ROLE_MULTI.audio = true`）。一个分镜常有多角色（林晚 + 顾言），各自的音色是不同文件，而创作 CLI 本来就支持多路 `--audio`。改之前第二个音色只能顶掉第一个。
- **统计拆分**：`stats` 增加 `boundImages` / `boundAudios`，界面显示「将绑定 N 个（图片 X · 音色 Y）」—— 只给一个总数的话，用户看不出音色到底绑上没绑。

**④ 音频参考的两重上限：数量 + 总时长 ≤ 15 秒**

用户要求："绑定音频不仅要有数量限制还要有音频的总时长限制，音频的总时长不得超过 15 秒"。

| 约束 | 依据 | 超出时 |
|---|---|---|
| 数量 | `models.limitsFor(model).audio`（seedance2.0 = 3 / 2.5 = 10） | 拒绝绑定，说明当前模型上限 |
| **总时长** | `config.audioTotalSecMax`（默认 **15** 秒，`JC_AUDIO_TOTAL_SEC_MAX` 可覆盖） | 拒绝绑定，报"已占 X 秒、再加 Y 秒会达到 Z 秒" |

- **能新增音频绑定的代码路径只有两条**（`bindAsset` 与 `autoMatchAssets`，其余全是解绑或素材库操作，已逐处核对），所以一个共享守卫 `checkAudioBudget` 覆盖两处，口径不会漂移。
- **时长来源：客户端优先 + 服务端兜底**。前端用 `<audio>` 读元数据（**不依赖任何外部程序**，是主来源）；读不到则服务端用 `ffprobe` 兜底（`ffprobe -show_entries format=duration`，机器可读输出，比解析 ffmpeg 的 stderr 文本可靠）。ffprobe 与 ffmpeg 一起分发，所以装了 ffmpeg 就通常有它。
  - **两端都读不到 → 时长未知 → 不允许绑定**，并给出可操作的出路（"请在素材详情里重新选择一次文件"）。当成 0 放过就等于这条约束对读不到时长的音频静默失效。
  - 已绑里若有时长未知的，再绑别的音频也会被拦（否则"总时长"这个数不可信）。
- **浮点容差**：比较带 `1e-6` 容差，避免 `15.0000001 > 15` 的假阳性；存储时四舍五入到 2 位小数。有边界测试（恰好 15.0 秒必须通过）。
- **派发前再守一道**：绑定守卫挡住了两个写入点，但**模型可能在绑定之后被改小**（按 2.5 绑了 5 条音频、之后把模型改成 2.0），也可能有人手工改过库。`buildSubmitArgs` 在组装命令前复核**真正会发出**的那几条的时长，超限则明确失败并说明怎么办 —— 而不是悄悄多发几秒音频。这样"不得超过 15 秒"才是一条真规则。
- 界面同步：分镜列表下发 `audioLimit` / `audioSecTotal` / `audioSecMax`（前端**不硬编码 15**）；音频槽位与选择弹窗显示「音频 2 / 3 个 · 8 / 15 秒」，选择弹窗逐行显示时长、读不到的标「时长未知」；勾选越界时**当场拦下并说明是数量还是时长**（两种原因的处置方式不同）。

**⑤ 提示词按素材类型着色：补齐缺口**

现有机制**已经**是按类型着色（`<mark class="hl hl-<type>">`），这条是补缺口而不是新建机制：

1. **`.hl-firstFrame` 与 `.hl-storyboard` 两条规则原本根本不存在** —— 首帧图 / 分镜图两类素材名在提示词里一直是无色的（只有加粗、没有颜色），与"颜色根据素材类型自动变换"不符。已补齐，并加 `.hl-other` 兜底色。
2. **索引键去扩展名**（与后端 `nameKeys` 的 `stripExt` 对齐）：名为「林晚音色.mp3」的素材原本永远匹配不到提示词里的「林晚音色」—— 表现为"这条素材从不着色"。
3. 新增静态断言 `server/hl-rules.test.js`：`ASSET_TABS` 的每个取值都必须有对应的 `.hl-<type>` 规则。这类缺口**不会报任何错**，只会静默无色，只能靠机械核对拦住。

**⑥ 顺带修掉的另一处静默不一致**

多值/单值这件事**前后端各有一份表**（后端 `ROLE_MULTI`、前端 `ROLE_META[x].multi`）。本次后端把 audio 改成多值后忘了前端，结果是"后端允许绑多个音色、界面上却连 ＋ 按钮都没有"。跑接口测试**看不出来**（接口是对的），只有看界面才发现。已加静态断言把两张表钉在一起。

**验证**（真实数据 + 真实服务 + 真实浏览器）：

| 项 | 结果 |
|---|---|
| `node --test server/*.test.js` | **106/106 通过**（原 78 + 音频预算与空素材 24 + 提示词着色契约 4） |
| 新建空素材（真实接口） | `POST /assets` → `url`/`thumbUrl`/`durationSec` 均为 `null`、`origin='manual'`、占位渐变可算；名称必填/超长/类型非法分别被拒且不留半成品 ✓ |
| 补文件 + ffprobe 兜底 | 3 秒 wav 不传 `durationSec` → 服务端读出 `durationSec = 3`；**展示名「林晚音色」未被文件名覆盖** ✓ |
| 音频可多绑 | 真实分镜绑上「林晚音色」(3s) + 「顾言音色」(5s)，槽位显示 `音1` / `音2`，`audioCount=2 audioSecTotal=8` ✓ |
| **总时长上限** | 再绑 10 秒的「长音色」→ 被拒：`音频总时长超限：上限 15 秒，已占 8 秒，再加「长音色」（10 秒）会达到 18 秒`；被拒后仍是 2 条 / 8 秒 ✓ |
| 自动匹配同时绑图片与音色 | 真实提示词含「林晚音色＝清亮偏柔女声」→ 命中 `audio/林晚音色`，`stats.boundAudios=1`；弹窗标题「自动匹配 · 将绑定 17 个（**图片 6 · 音色 11**）」✓ |
| 新建对话框（浏览器实测） | 音频页 → 「新建音频」：字段为 音频文件/名称/类型，**无图片区、无提示词区**，占位「例如：林晚音色」；角色页 → 「新建角色」：图片区 + 提示词，**无音频选择钮** ✓ |
| 校验与创建（浏览器实测） | 空名称点创建 → 拦下并提示「请先填素材名称」，弹窗不关；填名称后创建 → 卡片出现在网格首位 ✓ |
| 选择弹窗预算（浏览器实测） | 头部「音频 2 / 3 个 · 8 / 15 秒」；逐行显示 3s / 5s / 10s，空素材标「时长未知」（警示色）；选 10 秒那条 → **当场拦下**「音频总时长超限：上限 15 秒，再选「长音色」会达到 18 秒」；选「时长未知」那条 → 「没有可用的时长信息……请在素材详情里重新选择一次文件」✓ |
| 数据完好性 | 探针素材与绑定已全部清理：素材 15（prop 9 / character 2 / scene 4）、分镜 16、记录 6、无残留音频绑定、磁盘 25 个文件 ✓ |

> ⚠ 浏览器实测**无法覆盖"选文件"这一步** —— 内置浏览器不支持文件选择器（IAB 的已知边界）。所以文件上传走的是接口级验证（真实 wav + ffprobe），界面侧验证的是对话框渲染、校验与创建。这一点如实记在这里，不当作"界面全流程已验证"。

> 📌 本次没有写迁移代码：实测确认真实库里**音频素材 0 个、音频绑定 0 条**，所以"给存量音频补时长"是空操作。`asset.durationSec` 只在音频素材上出现，图片素材不带这个字段。

#### `0.16.0` — 2026-09-20

**资源文件改为按项目分目录，并新增「彻底删除项目」**（用户要求："彻底删除就是连带着硬盘上的内容也删除，应该有一个专门用于存放各种资产和数据的文件夹，这个文件夹内每个项目单独一个文件夹……当彻底删除某一个项目后这个文件夹就会被彻底删除"）。

**改动前的问题**：素材**全项目平铺**在 `data/assets/`、产物平铺在 `data/output/<分镜>/`，两边都不带项目身份。后果有两个，第二个是这次真正要解决的：

1. 文件 URL（`/media/assets/<文件>`）本身**不构成隔离边界**，隔离完全靠元数据查询；
2. **删项目删不掉文件**。软删除只打标记；即使做物理删除，也只能靠遍历素材/分镜反查地址逐个删 —— 一旦某条记录没有引用（例如老版本没把封面写进记录的那张封面），那个文件就**永久漏在硬盘上**，谁都找不到它属于谁。

**改动后**：`data/projects/<项目>/` 下分 `assets/` 与 `output/<分镜>/`，URL 相应变成 `/media/assets/<项目>/<文件>` 与 `/files/<项目>/<分镜>/<文件>`。于是"彻底删除项目"退化成一次 `rm -rf` 一个目录 —— **归属关系由目录结构本身保证，不再依赖任何查询**。

**磁盘布局与地址形状收进 `server/paths.js` 一个文件**（构造、解析、路径穿越白名单、目录包含性判断）。以前地址是各写各的字符串拼接（`services.js` 拼素材地址、`dreamina-cli.js` 拼产物地址、`worker.js` 反解产物地址），加一层目录要改四处、且很容易漏一处。现在全部走 `PATHS.assetUrl / outputUrl / parseAssetUrl / parseOutputUrl / resolveServePath`。

**v2→v3 迁移**（`schema.js:migrateV2ToV3`，走既有迁移框架，仍是"克隆上跑 → 校验 → 通过后才落磁盘"）：

| 步骤 | 做法 |
|---|---|
| ① 搬文件 | **复制 → 校验大小 → 全部成功后才删源**。任一步失败就删掉本次新建的副本并抛错，磁盘回到原样 |
| ② 改地址 | 素材（`url`/`thumbUrl`）、分镜（`videoUrl`/`coverUrl`/`currentFrameUrl`）、**生成记录（`videoUrl`/`coverUrl`）** 三处都改 |
| ③ 扫尾 | 按"**旧产物目录名 = 分镜 id**""**素材文件名以素材 id 开头**"认领**没有任何地址引用**的残留文件；认不出归属的一律原地不动并报告 |
| ④ 补链 | 文件在、却没写封面地址的老数据，按它**自己的** `videoUrl` 推出同名 `_cover` 补回地址（不按 `submit_id` 猜，避免同一次提交出多个视频时张冠李戴） |

第 ③ 步不是可选项：真实库上就有一张这样的孤儿封面（第一次生成的封面，那条记录当时还没记 `coverUrl`）。**不认领它，它就永远不属于任何项目，彻底删除时也删不掉** —— 正是用户要解决的问题本身。认领后那条历史记录的封面也补上了，历史产物列表里第一次生成的小缩略图从空白变成真实封面。

**为什么"生成记录"的地址也必须改**：记录是历史产物的唯一数据源（分镜上的 `videoUrl` 是"当前态"，重新生成会覆盖）。只改分镜不改记录，历史产物列表的链接会**全部失效**。这条专门有测试钉住。

**新增「彻底删除」**（`DELETE /projects/:id?hard=1`，前端在项目页「删除项目」旁边）：

| | 软删除（原有） | 彻底删除（新增） |
|---|---|---|
| 数据 | 打 `deletedAt` 标记 | 项目 + 分镜表 + 分镜 + 素材 + **生成记录**全部移除 |
| 磁盘 | 不动 | `data/projects/<项目>/` **整个删掉**（素材图 + 已生成的视频） |
| 确认 | 一次确认 | **必须把项目名原样打一遍**（打错即取消、不做任何改动） |
| 可恢复 | 是 | **否** |

- **先删磁盘、再删数据**：顺序是有意的 —— 反过来的话，数据一旦删掉就再也不知道那些文件属于谁，文件直接变成孤儿。
- **有活动任务时拒绝**（`queued`/`generating`，或 CLI 任务处于 `submitting`）并返回 40900，且**不动任何文件与数据**；`draft` 不算活动（worker 只派发 `queued`，draft 是惰性的），所以只含未提交分镜的项目可以正常删除。
- 对**已软删除**的项目同样可用 —— 误点软删之后仍能清干净。

**顺带修掉的两处**：
- `store.load()` 每次启动都 `mkdir data/output` 与 `data/assets`。这两个目录已经没有任何代码往里写了，但**每次启动都重新建出来** —— 表现为"彻底删除之后还剩两个空目录"，让人以为没删干净。已停止创建，`config.js` 里对应常量改名为 `LEGACY_*` 并注明只用于迁移。
- **对话框正文的 `**加粗**` 与换行一直是坏的**：`uiDialog` 只做 `esc()`，于是消息里写的 `**` 原样显示成星号、`\n` 塌成一个空格（4 处消息受影响，包括原有的两个软删除确认）。改为**先转义再替换** `**x**` → `<strong>`，并给正文加 `white-space:pre-line`。转义在前是必须的 —— 顺序反了就等于给正文开了注入口子（正文里含用户填的项目名）。

**验证**（真实数据 + 真实服务 + 真实浏览器）：

| 项 | 结果 |
|---|---|
| 单测（新增 13 项） | 地址构造/解析、**路径穿越必须被拒**（7 种形态，含 `..%2F` 编码）、目录包含性（`output` 与 `output-bak` 前缀陷阱）、迁移搬文件/改三处地址/幂等/源文件缺失不致命、扫尾认领与"认不出就不动"、彻底删除（含活动任务拒绝、软删后可删、与软删除的差异）✓ |
| `node --test server/*.test.js` | **78/78 通过**（原 65 + 磁盘布局 13） |
| 真实库迁移 | 15 个素材 + 10 个产物文件全部落到 `data/projects/pj_1/`；旧 `data/assets`、`data/output` **已清空并删除**；16 分镜 / 15 素材 / 6 记录 / 5 项目计数不变 ✓ |
| 静态服务 | 新形状 3 个地址均 200（含认领回来的那张封面）；4 种路径穿越形态均 404 ✓ |
| 历史产物列表 | 真实两次生成的 `st_bf2d10bf`：列出 2 条（第 2 次今天 10:28 / 第 1 次 09-19 15:12，各带 submit_id 前 8 位与缩略图）；**任意时刻只有一条高亮**；点第 1 次后 `video`/`poster` 同步切到 `748cd534…` ✓ |
| 彻底删除（接口级） | 一次性项目：`removedFiles=2`、项目目录整个消失、别的项目不受影响 ✓ |
| 活动任务保护 | 真实库副本上造一个 `queued` 分镜 → 拒绝（40900）且**文件与数据都没动** ✓ |
| 软删 → 彻底删 | 软删后文件仍在；再彻底删 → 目录消失 ✓ |
| 确认弹窗 | 项目名打错 → 弹窗关闭 + 提示「输入的项目名不一致，已取消（未做任何改动）」+ 项目与文件完好 ✓ |
| 数据完好性 | 全程结束：5 项目 / 3 工作区 / 16 分镜 / 15 素材 / 6 记录；`pj_1/assets` 15 个、`pj_1/output` 10 个文件 ✓ |

> 迁移前备份：`server/data/backup/pre-schema-v3-2026-09-20T02-52-28-469Z.json`（迁移框架自动留）；补跑扫尾前另留 `pre-sweep-20260920-105451.json`。

> 验证中踩到并记录下来的一个坑：**测试自己污染了真实数据目录**。`paths-layout.test.js` 第一版通过给 `PATHS.PROJECTS_DIR` 赋值来"沙箱化"，而 `paths.js` 当时用的是**模块级常量** —— 赋值改不动它，测试以为在沙箱里跑、实际一路写进真实的 `data/projects/`。已给 `paths.js` 加 `setRoots()` 显式缝隙（导出改用 getter，避免快照值），测试改用它。**已核对没有真实数据受损**（素材 15、产物 4 目录、`db.json` 未动、schemaVersion 仍是 2），垃圾目录已清。教训：**测试要动磁盘时，沙箱入口必须是显式的、而不是"覆盖一个常量"**。

#### `0.15.0` — 2026-09-20

**修复「同一个分镜生成两次时分不清哪次是哪次」，并在产物预览里列出历史产物**（用户提问引出的三项）。

**问题**（用户原话）："如果我一个分镜生成两次，在结果与进度列表里我怎么查看我生成的两次视频？那产物预览中我怎么分辨我生成的两次视频哪一次是哪一次的"。核实后确认：**结果与进度列只能看到最新一次**（`videoUrl` 是分镜上的单值字段，重新生成会覆盖），要分辨两次只能去「生成记录」页。而且有两个缺陷让"记录页能看到两次"也不可靠：

1. **产物可能取到上一次的文件**。`downloadResult` 原来取"下载目录里第一个匹配的 mp4"，而 `fs.readdirSync` 是**按文件名排序、与时间无关**的（实测确认），文件名又是随机 UUID —— 等于**随机取新旧**。表现：第二次生成成功后，那条新记录挂着上一次的视频，两次看起来一模一样。
   - 改法：**按本次 `submit_id` 精确匹配**（CLI 的命名就是 `<submit_id>_video_1.mp4`）；万一将来 CLI 改了命名，退回"按修改时间取最新"，仍比按文件名随机取可靠。
   - **封面也必须与选中的那条视频同源**（否则会出现"新视频配旧封面"）：优先找与视频同名的图，再退到含视频 basename / 含 `submit_id` 的图。
2. **失败/取消的记录挂着上一次成功的产物**。`records.snapshot` 原来回退到 `sb.videoUrl`，而 `mapTaskError` / `cancel` 落记录时不传 `videoUrl` —— 于是回退到分镜上**上一次成功**留下的地址，一次失败的重生成看起来像成功了。
   - 改法：产物**只认调用方显式传入的值**。现在"记录里有产物"严格等价于"这一次真的产出/下载到了产物"。

3. **产物预览弹窗新增「历史产物」列表**：把该分镜**历次**产物平铺出来，每条标明**第几次 / 生成时刻 / submit_id 前 8 位**，点一下切换播放（`<video>` 的 `src` 与 `poster`、以及「在新窗口打开」链接三者同步）。
   - 数据源是**生成记录**而不是分镜：分镜上的 `videoUrl` 是"当前态"，重新生成会覆盖；而每条成功记录都带自己那一次的 `videoUrl` / `coverUrl` 快照 + 时刻 + `submit_id`，所以"生成过几次、每次是哪一条"在记录里是完整且不可变的。
   - 配套改动：`records.lite()` 补下发 `submitId` 与 `coverUrl`（前者是唯一能严格区分两次的标识，后者用于每条的小缩略图）；records 支持按 `storyboardId` 过滤。

**过程中我自己引入并被测试抓出的一个 bug**：`pickArtifact` 我第一版按**正则**写（`re.test(f)`），而调用方传的是**谓词函数** —— 结果是每次下载产物都抛 `re.test is not a function`。单测当场抓出，没进到运行环境。已改为接收谓词。

**验证**（真实浏览器 + 真实服务）：

| 项 | 结果 |
|---|---|
| 产物选取（单测） | 两个 submit_id 的文件并存、且**旧文件在文件名排序上排在前**（"取第一个"必错）时，给新 id 仍取到新文件；换排序后结论不变；无名字线索时退回按 mtime 取最新 ✓ |
| 封面同源（单测） | 选新视频时封面也是新的，不会"新视频配旧封面" ✓ |
| 记录不带旧产物（单测） | 失败 / 取消记录的 `videoUrl` 与 `coverUrl` 均为 `null`；成功记录仍带本次产物 ✓ |
| `storyboardId` 过滤（单测） | 只返回该分镜的记录 ✓ |
| **界面实测**（临时注入 2 条验证记录，指向两个**不同**的真实视频，验完已恢复） | 预览弹窗列出 3 条（第 1/2/3 次，各带时刻与 submit_id 前 8 位、各带缩略图）；**任意时刻只有一条高亮**；逐条切换时 `video` / `poster` / 「在新窗口打开」三者始终同步 ✓ |
| 数据恢复 | 记录数 7 → 5，验证标记 0 条，备份文件已删；分镜 16 / 素材 15 未变 ✓ |
| `node --test server/*.test.js` | **65/65 通过**（原 56 + 产物历史 9） |
| `node build.js` | 4 项结构校验通过（310.7 KB）✓ |

> 验证过程中发现并修掉两个**界面上才暴露**的问题：① 原来按 `videoUrl` 相等判断"当前是哪一条"，而两次生成可能落到同一个文件，会让两条**同时高亮** —— 改为按**记录 id** 判定；② `records.lite()` 没下发 `coverUrl`，导致历史列表的小缩略图为空、切换时 `poster` 也设不上。

#### `0.14.0` — 2026-09-19

**按用户要求调整项目创建行为，并把 UI 术语「页面」统一改称「分镜表」**（四项，逐条对应）：

1. **创建项目预填默认名**：输入框预填 `新项目`；若该名字已存在则自动加序号（`新项目 2`、`新项目 3`…），避免建出一堆同名卡片分不清。
2. **创建后留在项目列表**，不再自动跳进项目里。（新项目是空的，进去也没事可做。）
3. **新建项目不再自动创建「默认页面」** —— 这一条**推翻了此前经确认的选择**（上一轮你选了"自动创建默认页面"），按现在的要求撤销。`defaultWorkspaceId` 留 `null`，等建第一张分镜表时自动补上。
4. **UI 术语「页面」→「分镜表」**：项目主页页签、新建/重命名/删除的按钮与弹窗文案、空态说明、面包屑、首页卡片计数、后端返回的提示语与 CSV 导出表头，全部统一。
   - **代码里仍是 `workspace` / `ws_` 前缀，接口路径不变** —— 只改面向用户的字。顺带解决了指令文档 §2 早就提醒过的语义冲突：「页面」与"网页 / 分页页码"容易混淆。

**由第 3 条引出的连带调整**：原先「不允许删除项目下最后一张分镜表」的守卫已移除。它的理由是"否则项目会进入没有页面可用的死角"，但**空项目现在是合法状态**（新建即空），再禁止删到 0 就自相矛盾了。删掉最后一张只是把项目变回"空"，随时可以再建。

**顺带发现并修掉 3 个缺陷**（前两个由本轮新增的静态检查发现）：

1. **`#importDetect` 的绿色提示条一旦出现就收不回去**：它靠 `hidden` 切换，而 `.banner{display:flex}` 会盖掉浏览器默认的 `[hidden]{display:none}` —— `el.hidden = true` 静默失效。表现是导入弹窗里把文本清空后，那条「已识别 N 段提示词」还挂着旧数字。已补 `.banner[hidden]`。
2. **`.pv-mount` 空着也占高度**：同一个坑（`.pv-mount{display:flex}` 盖掉 `[hidden]`）。它本该在未挂载时完全让位，实际却吃掉了 608px 容器里的 273px，把内容区挤成 335px（页面下半截是空的）。已补 `.pv-mount[hidden]`。
3. **`#homeView` 的主体高度按内容撑开**：`.pageview` 照抄 `.recview` 用了 `grid-template-rows:auto auto minmax(0,1fr)`（三行），但首页只有「头 + 主体」两个子元素 → 第三个 1fr 空着，主体只按内容高度撑开（实测 720 高视口下只有 219px），项目一多就被裁掉且滚不动。已把 `.pageview` 改成 flex 列（头部/页签 `flex:none`、主体 `flex:1`），两种结构都正确。

**新增静态检查** `server/ui-hidden-rules.test.js`：扫描 `index.html` 里所有带 `hidden` 属性的元素，凡是其选择器设了 `display` 的，就必须有配套的 `[hidden]` 规则 —— 否则 JS 里的 `el.hidden = true` 会静默失效。**这类缺陷在本项目已出现 5 次**（`.fs-btn` / `.recview` / `.drawer` / `.pv-mount` / `.banner`），人眼与"跑一遍看看"都很难发现最后两种（界面看着"没什么不对"，只是布局悄悄错了）。同时另有一条用例守住这 5 处已知规则，防止有人"顺手清理"掉这些看起来多余的 CSS。

**另外给导入预览加了防串线序号**（与轮询的代际令牌同类）：连续输入时会有多个预览请求同时在飞，先发的可能后到。需要说明的是：我观察到的不稳定最终定位为**页面处于后台时的定时器节流**（实测 `visibilityState=hidden`，400ms 防抖被浏览器推迟，改用足够长的等待后 3/3 全部通过），**并非已复现的竞态**；这个序号是廉价保险，不是对某个已证实缺陷的修复。

**验证**（真实浏览器 + 真实服务）：

| 项 | 结果 |
|---|---|
| 默认名 | 首次 `新项目`，已有同名时为 `新项目 2` ✓ |
| 创建后 | 停在项目列表（`view=home`、URL 无参数），新卡片显示「分镜表 0 分镜 0 素材」✓ |
| 不自动建表 | 进新项目后分镜表数为 **0**，空态与按钮均为「新建分镜表」✓ |
| 术语 | 页签 `[分镜表, 资产库, 生成记录, 项目设置]`、摘要「分镜表 0 · 分镜 0 · 素材 0」、行 title「打开这张分镜表」、删除弹窗文案 ✓ |
| 首页布局 | 主体高 658px（修复前 219px）、可滚动 ✓ |
| 项目页布局 | 内容区 608px（修复前被空的挂载点挤成 335px）✓ |
| 导入提示条 | 有内容时 `display:flex`、清空后 `display:none` ✓ |
| 删除最后一张分镜表 | 允许；项目变为空、`defaultWorkspaceId` 清空、设置与资产仍可读；再建一张即恢复 ✓ |
| `node --test server/*.test.js` | **56/56 通过**（54 + 新增 2 项静态检查） |
| `node build.js` | 4 项结构校验通过（306.8 KB）✓ |

#### `0.13.2` — 2026-09-19

- **修复：在项目页点过「项目设置」后，再点另外三个页签中的任意一个，设置面板会从右侧滑出来盖住整页**（用户实测上报）。两处叠加造成的：
  1. **卸载时就地面板只摘了 `.inline`、没摘 `.open`。** 抽屉回到 `<body>` 后仍是 `position:fixed`，而 `.open` 把它设成 `transform:none`（本该 `translateX(100%)` 藏在屏幕外）—— 于是它显示在屏幕内。位置也解释了为什么是"从右侧弹出"：那正是抽屉的默认方位。
  2. **`.drawer` 缺一条 `[hidden]` 规则。** 它是 `display:flex`，会盖掉浏览器默认的 `[hidden]{display:none}`，所以卸载时设的 `el.hidden = true` **完全无效**。`.mask` 与 `.recview` 各自都有这条规则，抽屉当初漏了。已补 `.drawer[hidden]{display:none}`。
- **顺带修掉一处由上面第 2 条引出的回归**：`openSettings()` 一直没管 `hidden`（原先抽屉只靠 `transform` 藏，`hidden` 从没被设过，所以不管也没事）。补上 `[hidden]` 规则、且卸载会置 `hidden=true` 之后，**不还原 `hidden` 就再也打不开抽屉**了 —— 具体表现是"从项目页进过设置、再回控制台点设置，抽屉不出来"。现在 `openSettings()` 会显式 `hidden = false`。
- 顺带做了一次**同类隐患审计**：遍历所有显式设了 `display` 的覆盖层，检查是否都有配套的 `[hidden]` 规则。结论：`.mask` / `.recview` / `.pageview` / `.drawer` 均已配套；`.toasts` 被标出但它是常驻容器、代码里从未 `hidden` 过，属误报。

**验证**（真实浏览器，未改动业务数据）：

| 项 | 结果 |
|---|---|
| 复现原始缺陷 | 点「项目设置」→ 再点「页面 / 资产库 / 生成记录」各一次：抽屉均为 `hidden=true`、`display:none`、`open=false`、`onScreen=false` ✓ |
| 九个页签的完整来回 | `页面→资产库→设置→页面→记录→资产库→设置→记录→页面`：每一步**只有当前页签对应的面板可见**，另一个必为不可见；页面头与四个页签全程在位 ✓ |
| 控制台路径 | 顶栏「生成记录」仍是整屏（5 条）；「设置」抽屉仍正常打开（`w=480`、遮罩 `display:grid`），关闭后回到屏外 ✓ |
| 无 JS 错误 | 全程 `error` / `unhandledrejection` 均为空 ✓ |
| `node --test server/*.test.js` | 54/54 ✓（本次只动前端） |
| `node build.js` | 4 项结构校验通过（305.1 KB）✓ |

#### `0.13.1` — 2026-09-19

**修复项目主页的四处体验问题**（用户反馈，逐条对应）：

1. **「项目页 ↔ 生成记录」切换太生硬、页面头与导航栏会跟着消失。** 原先「生成记录 / 项目设置」被做成**动作型**页签 —— 点了会弹出整屏覆盖层，项目页的头与页签一起被盖掉，关掉再回来。现在四个页签**统一为内容页签**：切换只换下方内容，头和导航栏保持不动。
   - 实现方式是把覆盖层**整体搬进**项目页的挂载点（`.pv-mount`），而不是复制一份记录 UI —— 记录视图带着筛选、分页、详情、导出、8s 自动刷新一整套状态与事件，复制等于要同步维护两套实现。移动 DOM 不会丢事件监听（节点没被重建），既有的委托与按钮绑定继续有效。
   - **从控制台顶栏打开时仍是原来的形态**（记录页整屏、设置抽屉 + 遮罩），两条路径共用同一份实现，只是呈现方式不同。
   - 就地模式下会隐藏记录页的「返回控制台」箭头与设置面板自带的「设置 ×」头 —— 位置信息由项目页的头与页签给出，不需要第二套返回入口。
2. **页面行只占页面的一部分（右侧一大片空白）。** `.ws-list` 上有人为的 `max-width:760px`，1280px 视口下右侧空出约 500px。已移除。
3. **右侧的空白是什么。** 同因：`.pj-grid`（项目卡片）与 `.pv-grid`（资产卡片）也各有 `max-width:1100px`。一并移除，内容铺满。现在 1280px 下页面行宽 1232px（只留 24px 内边距），首页网格右间距 0。
4. 顺带把项目页主体拆成「可滚动内容区 + 就地面板槽位」两块（`.pv-scroll` / `.pv-mount`），就地面板因此能自己撑满剩余高度、自己管理滚动，而不会把整页顶长。

**验证**（真实浏览器，未改动业务数据）：

| 项 | 结果 |
|---|---|
| 生成记录页签 | 记录视图 `parentElement = projMount`、`inline=true`、5 条记录可见；**页面头文本与四个页签全程不变** ✓ |
| 项目设置页签 | 抽屉 `inline=true`、自带头隐藏、保存/恢复默认底栏保留、5 张卡片；头与页签不变 ✓ |
| 切回页面页签 | 记录视图被移回 `body` 并隐藏、`inline` 已摘除；页面行宽 1232px ✓ |
| 控制台路径未受影响 | 顶栏「生成记录」仍是整屏 `position:fixed`（带返回箭头）；设置仍是抽屉 + 遮罩，关闭后遮罩正常隐藏 ✓ |
| 宽度 | 首页网格 1280px（右间距 0）、资产网格 1232px（右间距 24px = 内边距）✓ |
| 响应式 | 1920→420px 共 6 档：无横向滚动、头/页签均不溢出；就地记录面板在每一档都保持「头在、页签在」✓ |
| 无 JS 错误 | 全程 `error` / `unhandledrejection` 均为空 ✓ |
| `node --test server/*.test.js` | 54/54 ✓（本次只动前端） |
| `node build.js` | 4 项结构校验通过（303.8 KB）✓ |

#### `0.13.0` — 2026-09-19

**多项目架构升级 · 第二增量（前端）**。后端在第一增量已支持多项目，本轮把界面接上：新增**首页**与**项目主页**两层视图，并把既有的分镜表改造为**工作区视图**（指令阶段 11–15）。既有界面与交互全部保留，故为 MINOR 升级。

- **新增两层全屏视图**，复用记录页（`#recView`）那套已验证的物理配方：作为 `#app` 的**兄弟节点**、`position:fixed` 铺满、靠 `[hidden]` 切换。z-index 取 **65** —— 在弹层遮罩（60）之上、记录页与设置抽屉（70）之下，因此从项目主页能正常打开「生成记录」与「项目设置」，而那两个覆盖层又不会被本页盖住。
- **首页**：项目卡片墙（页面数 / 分镜数 / 素材数 / 最近修改）+ 创建 / 重命名 / 软删除。空态给出"项目是隔离边界、页面共享素材"的说明，避免用户不知道这一层是干什么的。
- **项目主页**：页面列表（新建 / 重命名 / 软删除）+ 资产库 tab（6 类分类 / 搜索 / 上传）+ 「生成记录」「项目设置」两个**动作型**页签（虚线边框区分于内容页签，因为它们会离开本页）。
- **工作区视图**：既有的分镜表原样复用，只加了面包屑。**「第 N 批」这个概念被 Workspace 取代**（`batchId` 一直是硬编码的 `bt_21`、界面上从来没有设置入口），顶栏那一格改为只显示分镜数，位置信息由面包屑承担。
- **URL 状态与刷新恢复**：`?project=…&workspace=…`（指令 §35 的最低成本方案，用 `replaceState`，不引入 popstate 与视图内的返回按钮形成两套语义）。指向已删除/不存在的对象时**逐级安全降级**：有项目回项目主页，否则回首页，全程不崩。
- **切换即清理（§37）**：`resetScopeState()` 统一清掉 20 多处**项目/页面级**状态并停掉所有计时器。刻意**不清** `adapter` / `cli*` —— 那是整机状态（CLI 账号、积分、登录流程），清掉会让引擎读数无缘无故变空。不清的后果是真事故：`S.sel` 残留上一个页面的分镜 id，切过去点「提交所选」就会把**别的页面**的分镜提交出去；`S.autoIds` / `S.durIds` 同理会把预览应用到错误的页面。
- **轮询防串线（§38/§39）**：`S.poll.gen` 代际令牌。`stopPolling()` 除了 clearTimeout **还要 +1 代际** —— 只清定时器拦不住已经发出、正在等响应的那一轮，它回来时会照常把旧页面的进度画到新页面的表格上。`pollOnce` 在**每次 `await` 之后**都重新比对代际与视图，不匹配就一个字段都不写。轮询也只在工作区视图里跑，首页/项目主页不再后台空转。

**顺带修掉一个后端缺陷（第一增量的遗留，本轮实测暴露）**：

- **`server/projects.js` 里 8 个改动 db 的函数全都漏了 `store.save()`**，该模块甚至没有 require store。后果不是报错而是"内存里改了、磁盘上没改"——接口读得到（同进程读同一对象），**重启就全丢**。实测痕迹：软删除一个项目后 `db.json` 里 `deletedAt` 仍是 `null`，而 `/projects` 列表却已经把它过滤掉了（因为过滤读的是内存）。
  - ⚠ **第一增量的 25 项隔离测试完全看不见它**：那些用例把 `store.save` 换成了静默的空实现，"有没有请求落盘"根本没被断言。本轮补上**落盘契约**用例（把 save 换成可计数的实现，逐个写操作断言确实调用过），并补一条"软删是打标记而非物理销毁"的语义用例。

**验证**（真实浏览器 + 真实服务，全程未改动用户业务数据）：

| 项 | 结果 |
|---|---|
| 三层导航 | 首页 → 项目主页 → 工作区，面包屑与 URL 同步（`/` → `/?project=pj_1` → `/?project=pj_1&workspace=ws_1`）✓ |
| 刷新恢复 | 带两个参数刷新回到工作区（16 行）；只带 project 回到项目主页 ✓ |
| 安全降级 | `?project=pj_nope&workspace=ws_nope` → 回首页、URL 清理、**无 JS 错误** ✓ |
| **界面级项目隔离** | 新建项目 → 自动建「默认页面」→ 该页面分镜为 **0**（不是 16）；回原有项目仍是 16 ✓ |
| **切换状态清理** | 在 A 勾选 3 个分镜 → 切到 B（已选 0/0）→ 切回 A（已选 0/16，**勾选不复活**）✓ |
| 项目/页面增删改 | 重命名页面与项目、软删除项目均生效；软删后底层对象仍在库里且 `deletedAt` **确实写进了磁盘** ✓ |
| 项目主页四入口 | 资产库（2 张卡 / 6 类 / 搜索 / 上传）、生成记录（复用全屏视图，5 条）、项目设置（抽屉 z-index 70 > 项目页 65，5 张卡片、6 个模型选项）✓ |
| 既有功能回归 | 分镜详情弹层、批量导入弹层、设置抽屉、自动匹配预览、生成记录页**全部正常**，无 JS 错误 ✓ |
| 响应式 | 1920→420px 共 9 档：顶栏按钮齐全、无顶栏溢出、无横向滚动；新视图头部与页面行均不溢出 ✓ |
| 落盘契约测试 | 10 个写操作逐个断言确实调用 `store.save()` ✓ |
| `node --test server/*.test.js` | **54/54 通过**（原 19 + 迁移 10 + 隔离 25） |
| `node build.js` | 4 项结构校验通过 ✓ |

**过程中我自己踩的两个坑（都是测试脚本的问题，不是产品缺陷，如实记录）**：

1. 用 `locator(sel, {hasText:'原有项目'})` 定位项目卡片时 `hasText` **被静默忽略**，`.first()` 于是选中了另一个项目的卡片，表现为"点了没反应"。改用显式 `[data-pj="pj_1"]` 后正常。
2. 连点 3 个复选框时用了同一次查询拿到的节点列表，而每次点击都会重绘表格使其余节点**脱离 DOM**，所以只选中了 1 个。改成逐次重新查询后 3 个都选中（状态栏「已选 3 / 16 项」、顶栏「提交所选 3」）。

#### `0.12.0` — 2026-09-19

**多项目架构升级 · 第一增量（后端）**。把单工作区结构正式升级为 `Project → Workspace → Storyboard` 多项目生产架构。**旧接口与旧前端一行不改即可继续工作**，故为 MINOR 升级。

- **新增正式 schema 版本与迁移框架**（`server/schema.js`）。升级前项目**没有版本概念**，兼容旧库靠两套临时机制：`store.load()` 里 9 处 `if (!db.X)` 垫片，以及更危险的一处 —— `getOptions()` **借 `GET /meta/options` 请求改写并落盘**（它会重写 `settings.defaults`、**所有分镜的 model**、**所有 cliJobs 的 cliModel** 然后 `store.save()`）。也就是说"迁移"藏在一个只读接口里，靠用户打开页面才触发、每次刷新都可能重跑、并发请求还会互相交错。现在收敛为「读版本 → 按序迁移 → 校验 → 写版本」；迁移**只在克隆体上跑**，任一步失败原库一个字节都不动且拒绝写盘；迁移前自动留一份不会被轮转挤掉的独立备份。
- **新增 Project / Workspace 数据层**（`server/projects.js`）。含 CRUD、软删除、活动任务删除保护，以及**作用域解析的唯一出口** `resolveScope()`。后端**不存在**任何"当前项目"全局变量，作用域一律 request-scoped。
- **17 条读路径全部加作用域**。升级前 `projectId` 是**只写元数据、从不参与查询**：`listStoryboards(db,q,projectId)` 收了参数却从不引用它，路由 `/projects/{任意id}/storyboards` 用非捕获组把 id 直接丢弃。于是分镜、素材、记录、进度、自动匹配、时长重算、导入查重、设置同步**全都是全库范围**。
- **素材属于项目、不属于工作区**：素材只有 `projectId`，**刻意不加** `workspaceId` —— 加了会破坏"项目内资产共享"这个核心需求。跨项目绑定在后端拒绝（不是靠前端过滤）。
- **生成记录补上下文与名称快照**：新增 `workspaceId` / `workspaceName` / `projectName` / `storyboardTitle`。名称按**生成时刻**存值，因此项目改名、工作区软删之后，旧记录仍显示当时的名字。记录查询与导出按项目过滤，CSV / Markdown 导出补上项目与页面两列。
- **CLI 任务带上下文**：`cliJobs` 补 `projectId` / `workspaceId` 供审计；Worker 的写入守卫额外拒绝**工作区已被软删**的分镜（分镜本身还在库里，原存在性检查拦不住它）。
- **分镜序号改为按工作区独立**。原来 `renumber()` 全局重编、`db.seq` 全局自增，多页面之后两个页面的分镜会互相插队（"镜头 3" 出现在另一个页面里）。

**顺带修掉三个审计中发现的既有缺陷**（都属本次改造的必经之路，不是顺手扩范围）：

1. **幂等键跨项目回放**：`db.idempotency` 原来只拿客户端 header 当键，键里没有项目/路径身份 —— 同一把 key 打到另一个项目会**回放第一个项目的响应**。现在键 = 路径 + 作用域 + 客户端键。
2. **`PUT /settings` 无键白名单**：原来 `Object.assign({}, db.settings, s, …)` 会把请求体里**任何**顶层键原样落库；多项目之后一个 `{"projects":[…]}` 就能改写项目集合本身。现在只允许 `delimiter` / `defaults` / `queue`，其余丢弃并如实回报被忽略的键。
3. **`PUT /settings` 部分提交丢键**：原来整对象覆盖，一次只带 `{defaults:{model}}` 的 PUT 会把 `resolution`/`ratio`/`durationSec`/`motion` 全部丢掉（`queue` 同理，`autoRetry` 变 `undefined` 导致自动重试静默失效）。现在逐键合并。

**旧数据迁移结果**（真实库，已在启动时执行）：16 条分镜、15 个素材、5 条生成记录、4 条 CLI 任务**全部保留**，id / 顺序 / 提示词 / 绑定 / 状态 / 模型逐字段不变，归入自动创建的「原有项目」与「原有分镜」。迁移前备份：`server/data/backup/pre-schema-v2-*.json`。

**验证**：`node --test` 五套件扩到 **52 项全绿**（原 19 项 + 迁移 10 项 + 隔离 23 项）；隔离测试走的是**真实路由 + 真实 services**（只把 `store` 的落盘副作用换成空实现），覆盖 project/workspace 隔离、项目内资产共享、跨项目绑定拒绝、自动匹配隔离与歧义、删除保护、记录快照，另补幂等键作用域与 `getProgress` 归属两项。**现有前端 `app/` 一行未改即正常运行**（16 行分镜、素材、记录页均实测通过）—— 这是向后兼容最硬的证据。

#### `0.11.3` — 2026-09-19

- **修复：框选一个卡片都没框到，底部批量操作条也会弹出来（且不再收回）**。
  - **根因**：素材侧的「进批量模式」挂在了框选引擎的 `onEnter`（**起拖**那一刻）上，只要拖动超过 4px 就进模式 —— 与"框到了几个"无关。于是拖空白区也进模式，`renderBatchBar` 按 `assetSelMode` 显示操作条，松手后 `commit` 只改选择集、不改模式，条就一直挂着显示「已选 0 / N 个」。
  - **改法**：批量模式改在 **`commit` 时按结果**进入 —— `if (set.size) S.assetSelMode = true`。拖到了东西才进模式；一个都没框到就什么都不做，操作条自然保持收起。同时移除了引擎里已无人使用的 `onEnter` 钩子（避免注释与代码对不上）。
  - **刻意保留的行为**：顶栏「批量选择」按钮走的是另一条路（显式进模式），那里 **0 选中也必须显示操作条** —— 用户是主动进来的、正要开始选，此时把条收掉反而像按钮坏了。同理，已经在批量模式里拖空白区，条也保持展开（显式模式是粘性的）。
  - **不受影响**：拖拽期间的实时高亮来自 `.acard.sel`（`styles.css:439-440` 的描边 + 名称着色），纯靠 class、不依赖模式；普通点击（未超过 4px 阈值）照旧打开卡片编辑弹窗。
  - **验证**（真实浏览器，源服务 8787 只读操作，未改动任何业务数据）：干净状态下载入 → 操作条收起（高 0）；拖空白区（命中数空）→ **仍收起（高 0）**；拖中 2 张卡片 → 展开（高 56）且显示「已选 2 / 2 个」、拖拽期间实时高亮 2 张；点「完成」→ 收起；点「批量选择」→ 展开且显示「已选 0 / 2 个」；在显式模式里拖空白区 → 保持展开。另核对服务端下发的 `app.js` 不含旧 `onEnter`、含新 `commit` 逻辑，排除浏览器缓存的假阳性。

#### `0.11.2` — 2026-09-19

- **新增 `scripts/backup-data.sh`：运行数据备份脚本**。起因是一个很自然的问题——"项目是从 git 上拉的，推送到 git 就不用另做备份了吧？"答案是**不能替代，且原因是结构性的**（三条都实测过）：
  - `server/data/` 被 `.gitignore` 排除，远端仓库里根本没有它。其中 `db.json`（分镜/素材/记录）、`output/`（真实生成的视频，花过积分）、`assets/`（素材图，删了不留痕）**丢了就没了**，git 再可靠也碰不到这 37 MB；
  - 新增的 `server/task-state.js` 等文件若漏加进提交，恢复出来的仓库**起不来**（它是 `worker.js` 的硬依赖）——"以为有备份、真要恢复时才发现是坏的"是最糟的失败形态；
  - 备份**粒度**也不同：git 保护的是提交点，工作区里未提交的改动它一样不管。
  - 脚本每次产生独立时间戳快照、默认保留 10 份，并在快照里写 `MANIFEST.txt`（记录**这份数据对应哪一版代码**、sha256 校验和、恢复步骤）。两道防护：拒绝写进项目目录内部、数据为空时拒绝产出空备份。
  - 详见新增的「[备份运行数据](#备份运行数据git-替代不了的那部分)」一节。
- **补齐版本检出点**：项目此前**没有任何 tag**，README 里的版本号只是文字，"按版本回退"在 git 里做不到。现已补 `v0.1.0`（基线）与 `v0.11.1`（本次压平提交）两个 tag，并把 `§2.5` 起累积的全部改动提交为 `aa8ff63` 推送。
  - ⚠ 代价要记清楚：`0.2.0`–`0.11.0` 这十个中间版本**没有各自独立的提交**，无法单独检出。`docs/更改文档.md` 里各条目写的「待提交」是当时的状态记录，不是现在还有未提交内容。

#### `0.11.1` — 2026-09-20

**素材面板版面优化**（用户要求：布局更舒服、减少无意义的文字）：

- **动作区改成 2×2 网格**：「干跑提交」原先在面板顶栏**独占一行**（白白吃掉一行高度），现在并入动作区，与「导入资产 / 批量选择 / 自动匹配参考图」同排 —— 四颗按钮各占一格、同高、左右边缘对齐。面板顶部因此少一行。
- **删掉默认态的说明噪音**：原来两个分区头分别挂着「点表格里的 ＋ 绑定；直接点击卡片则打开素材设置」（21 字）与「点击打开素材设置」，这两句每屏都在、彼此重复，且卡片与按钮的 `title` 里都有。现在**只在承载状态时才显示说明**：绑定态 →「点击下方素材添加/添加到分镜 N」、批量选择态 →「点击卡片勾选」、其余情况不显示。
- **空态从一整块压成一行**：原来「本分镜素材」为空时单占一块 `empty-mini`，文案是 16 个字的「当前分镜还没有在此分类下绑定素材」。现在改在分区头右侧显示「暂无绑定」，整块高度省掉。
- **分区头回到单行**（标题在左、状态说明在右）。上一版曾把它拆成两行，那是因为当时的说明文字很长会折行；现在说明都短了，单行更紧凑。
- **删掉一处从来不可见的死文本**：动作区里那句「图片 / 提示词导入」被 CSS 的 `.panel-actions .hint-sm{display:none}` 一直藏着，属于死 markup。
- 「素材库全部 (n)」→「素材库 (n)」：「全部」与另一区的「本分镜素材」对比已自明。
- ⚠ 顺带删除的两条 CSS 规则（`.panel-actions .hint-sm`、`.panel-actions #btnAutoMatch{grid-column:1/-1}`）都是随上面改动失效的死规则；`.panel-top #btnDrySubmit` 的定位规则也一并移除（干跑提交已不在顶栏）。这些都在注释里写明了原因，不是无声删除。

**效果（实测，非估算）**：在浏览器里把改动前的 CSS 片段与被删掉的块临时注入页面各量一次，量完即复原（已校验复原后数值与注入前一致）：

| 指标 | 改前 | 改后 | 变化 |
|---|---|---|---|
| 面板可见文本（去空白） | 111 字 | **55 字** | 减少 56 字（−50%） |
| 列表上方固定 chrome 高度 | 204px | **161px** | 省 43px |
| 面板顶到首张素材卡的距离 | 314px | **239px** | 上移 75px |
| 分区头高度 | 39px | **34px** | 每个省 5px |
| 被删掉的那块空态 | 47px | 0（并成分区头一行） | 省 47px |

**验证**：`node build.js` 通过（265.5 KB，4 项结构校验）；单测 **19/19**；浏览器三套件 **55 项断言全过** ——
- 文案：默认态无长说明、无「点击打开素材设置」、无长空态句、有「暂无绑定」、无死 `.hint-sm`、无 `empty-mini`；「素材库全部」已简化；
- 版面：动作区 2×2 四颗同高、两列等宽左边缘对齐、干跑提交不在顶栏、分区头单行（34px）、chrome 161px；
- 状态说明仍正确：批量选择态显示「点击卡片勾选」、绑定态显示具体分镜号、退出/复位后回到干净默认态；
- 无错位/遮挡/裁切；1600→360px 共 10 档视口下动作区都是 2 行 4 颗、分区头单行、无裁切；
- 保留的「搜索无结果」空态仍正常（`没有匹配的素材`，面板内紧凑内边距 16px）；
- 回归：面板卡片点击开素材详情、tab 切换（分区头计数与卡片数一致）、搜索过滤与清空、有绑定时「本分镜素材」正常渲染、素材格预览弹窗、设置「个性化」开关、提交所选数量同步 —— 全部照常；
- 冒烟：导入资产 / 自动匹配参考图 / 干跑提交 三颗按钮都能用（干跑未勾选时给出提示）。

**测试过程中被误判为缺陷的四处（记录以免后人重蹈）**：① 断言「列表上方 chrome ≤200px」失败 —— 那是拍脑袋的绝对值，实测 161px 本就达标；布局优化的判据应写成"与改前对比"，不该写死一个自己估的数字（后来改为把旧 CSS 临时注入页面**实测**改前值，见上表）。② 「批量选择态」测不到 —— 因为上一步点过槽位「＋」留下了 `S.bindTarget`，而**绑定态的提示优先级高于批量选择态**（既有设计：取消选择弹窗后仍可点选），所以批量选择态必须在未进入绑定态时先测。③ 「冒烟：自动匹配参考图」失败 —— 选择器 `.mask .modal-head h2` 命中的是**文档里第一个**（`#importMask` 的）h2，那个弹层没打开时宽度为 0；必须指名具体弹层（`#autoMask:not([hidden]) #autoTitle`）。④ 用 grep 直接查发布版「旧文案是否已清除」误报 4 项 —— 命中的是我自己写的"这里删掉了 XXX"说明注释；查发布版必须先剥掉注释，或改查**渲染后的文本**（本轮以浏览器里的 `panel.textContent` 为准）。

#### `0.11.0` — 2026-09-20

界面调整（同样是只动位置与呈现，功能与交互逻辑不变）：

- **整体进度从底部状态栏移到顶栏**：「整体进度 X% + 进度条 + 预计剩余 mm:ss」**整组一起搬**（三者是一组读数，拆开摆在屏幕两端反而看不懂）。进度条从 88px 收到 56px 以适应顶栏。底部状态栏因此只剩：适配器 / 并发数 / 已选条数 / 批量操作按钮 / 区间选择 / 显示条数。
  - 数据源与刷新时机都没变：仍读 `stats`，仍由 `renderTopbar()` 写文本与进度条宽度；实测「改 `stats` → 三项同步」与「触发一次真实重绘后值不被重置」。
- **「模型」「画幅」合并为一处纯文本**：原先两个可点胶囊各带一个下拉箭头，但点击只弹一句「可在设置里修改」——**并没有真正的下拉列表**，属于假的下拉外观。现在合并成一个 `span`，形如 `Seedance 2.0 Fast VIP · 16:9`，去掉箭头与点击行为，含义由元素 `title` 说明（在「设置 → 生成参数默认值」里修改）。顺带省下约 80px 顶栏宽度，正好给移上来的进度读数腾位置。
- **「批量导入提示词」按钮改名「批量导入」**（顶栏与空态两处）；图标与样式（`.btn-primary`）保留，按钮 `title` 仍是完整名称。导入弹窗的标题仍叫「批量导入提示词」——那是弹窗标题，不是按钮。

**验证**：`node build.js` 通过（265.7 KB，4 项结构校验）；单测 **19/19**；浏览器两套件 **57 项断言全过** ——
- 参数合并：单个 `span`、无 svg 箭头、`paramgrp` 内无按钮、旧 `#pillModel`/`#pillRatio` 已消失、文案形如「模型 · 画幅」、点击不再弹 toast、宽度 145px（<200px）；
- 按钮改名：文案为「批量导入」、svg 保留、仍是 `.btn-primary`、高 33px 与邻居一致；dist 里**没有任何按钮**仍显示旧文案（空态那个也已改）；
- 进度搬家：顶栏有 `.top-progress`、底部状态栏不再有「整体进度 / 预计剩余」、百分比与接口 `stats` 一致（25%）、进度条宽度 = 轨道宽 × 百分比、轨道 56px、触发真实重绘后值不被重置；
- 无错位/遮挡：顶栏与状态栏内元素两两无重叠、无越界、无横向滚动；1920→360px 共 12 档视口下五按钮齐全、进度可见；
- 回归：设置「个性化」开关、提交所选数量同步、面板 2 列动作区与两行分区头、素材格预览弹窗 —— 全部照常；
- 冒烟：批量导入 / 设置 / 素材面板导入资产 / 生成记录 / 分镜详情 五个入口均可打开。

**已知边界**：极窄屏（≤420px）下进度读数整组独占一行并左右分散（`justify-content:space-between`），顶栏因此比上一版多一行 —— 这是把进度搬上顶栏的必然代价，比把它压成不可读更合适。

#### `0.10.0` — 2026-09-20

界面布局调整（功能与交互逻辑不变，只动入口位置与视觉排布）：

- **设置新增「个性化」分区，「紧凑视图」从顶栏移入**：原来它是顶栏的一个按钮（点击后按钮文案在「紧凑视图 / 标准视图」之间翻转）。现在改成设置里的一个开关，位置在「队列与执行」之后、「生成引擎与账号」之前。
  - **逻辑一行没改**：切换的仍是 `#app` 上的 `.compact` 类（`applyDensity()`），只是入口换了地方；开关的显示状态直接**读这个类**（`isCompact()`），不另存一份变量，所以设置抽屉频繁重绘也不会与真实外观不一致。
  - 设置里原有的「失败自动重试」开关不受影响：`data-toggle` 处理改为**按键分派**（`autoRetry` 走生成行为、`compact` 走显示偏好），互不干扰。
  - 这是**即时生效的会话内偏好，不写入服务端配置**（与改动前完全一致）；刷新页面回到标准视图。卡片里已写明这一点。
- **顶栏顺序调整**：`生成记录 → 批量导入提示词 → 提交所选 → 素材 → 设置`。
  - 「批量导入提示词」左移，占据原「紧凑视图」的位置；**图标、文案、样式均未改动**。
  - 「提交所选」从**素材面板顶栏**移到顶栏，紧挨「批量导入提示词」右侧，沿用同一套内联 `padding:8px 16px`，因此与相邻按钮**同高（33px）、垂直中心一致（同为 26px）、间距一致（12px）**。
  - 「提交所选」带已选数量（`提交所选 3`）与随状态变化的 `title`，由 `syncTopActions()` 在 `renderStatusbar()` 末尾同步（按钮是静态节点，只改文本、不重建 —— 重建会打断点击并丢焦点）。
  - 「干跑提交」留在素材面板（提交链路的自检动作，跟着表格走更顺手），右对齐，尺寸与原样式一致。
- **素材面板版面重排**：① 分类 tab 独占一行并**等分铺满**（原来靠左堆、右侧留一截空档；总宽不够时横向滚动兜底，不换行不裁切）；② 动作区由 flex 换行改为 **2 列网格**（「自动匹配参考图」跨两列），三颗按钮高度统一、左右边缘严格对齐；③ 分区标题「本分镜素材 / 素材库全部」的说明文字**改到标题下一行**（面板仅 335px 宽，挤在一行会折行并把标题挤歪）；④ 面板内各区块统一「上间距 10px、横向 14px」的垂直节奏（原来 8/6/8px 混用，疏密不一）。
  - ⚠ 三处**共用组件**的改动全部做了作用域限定，避免连带改到弹窗：`.panel-top .seg`（导入弹窗的「导入图片文件 / 导入提示词文本」是同一个 `.seg`）、`.panel .panel-search`（「添加资产」选择弹窗复用）、`.panel .sec-head` / `.panel .empty-mini`。已用 diff 逐条核对：`.seg` / `.panel-search` / `.sec-head` / `.empty-mini` / `.grid` / `.acard` 的**全局规则与改动前逐字节一致**。

**验证**（源服务 8787 只读检查，未改动任何业务数据）：

| 检查 | 结果 |
|---|---|
| 顶栏顺序与几何（1600px） | 生成记录 → 批量导入提示词(142) → 提交所选(84) → 设置；两者 gap=12px、高差 0px、中心差 0px ✓ |
| 紧凑视图已不在顶栏 | ✓ `#btnDensity` 节点与监听均已移除 |
| 设置「个性化」分区 | ✓ 位于第 4 张卡片（队列与执行之后）；开关 44×26 与其它开关一致；切换后 `.compact` 取反且行高变量变 132px；开关视觉状态与 `.compact` **回读一致**；再点恢复原状 |
| 错位/遮挡 | 顶栏、素材面板、底部状态栏**两两无重叠**（已排除父子对）；顶栏按钮无越界/被容器裁切 ✓ |
| 响应式 | 1920/1600/1440/1366/1280/1180/1024/860/700/500/400px 共 11 档：**五个按钮齐全、无越界、无横向滚动** ✓ |
| 面板 | tab 铺满整行（`scrollWidth == clientWidth`，6 个分类不触发横滑）；动作区两列等宽同高、跨列按钮左边缘对齐；分区头已两行（41px）✓ |
| 样式冲突 | 选择弹窗搜索框仍 `0/8px`、分区头仍横排（34px）；导入弹窗分段控件两颗按钮仍为内容宽（91/103px，未被拉伸）；记录页空态仍 `28px` 内边距 ✓ |
| 冒烟 | 批量导入提示词 / 设置 / 生成记录 / 分镜详情 / 素材抽屉 五个入口均能打开；勾选后顶栏显示数量且与状态栏「已选 N」一致，清空后复原 ✓ |
| 单测 | `node --test server/{model-limits,task-state,worker-guard}.test.js` → **19/19 通过** |
| 编译 | `node build.js` → 264.4 KB，4 项结构校验通过 ✓ |

**已知边界（如实记录）**：≤360px 极窄视口下，「运行状态」胶囊会占满该行剩余宽度，把「提交所选」挤到下一行（阅读顺序仍正确，但不再与「批量导入提示词」相邻）。实测 ≥380px 两者始终同行。未为此再压缩顶栏 —— 那会把 360px 下的顶栏从 3 行推到 5 行，代价大于收益。

#### `0.9.0` — 2026-09-20

- **分镜里的素材格可以点开了：预览 + 替换**（用户要求"点击已上传的素材就可以预览这个素材和替换"）。此前素材格只有右上角的 `×`（移除）能点，想知道自己绑的是哪张图、想换一张都没有入口 —— 尤其是**单值槽位**（场景 / 首帧图 / 分镜图）：绑上之后 `＋` 就消失，等于完全换不了。
  - 点素材格打开「素材预览」：原图直出（`object-fit:contain`，不裁不缩略），点图片或悬浮钮进**全屏**看细节；下方列出名称、类型与槽位、**图号**（并直接写出"提示词里用 `@图片N` 引用它"）。
  - 两个替换入口，各自写明**作用范围**，避免"以为只改这一条、结果全改了"：
    - **替换素材** —— 只改本分镜的绑定，原素材与其它分镜不受影响；
    - **更换文件** —— 换掉该素材自己的图片（保留素材 id 与全部分镜绑定），所有引用它的分镜一起换。
  - 无图素材（提示词导入的那批）走同一弹窗：半透明占位 + 明确提示「未计入图号：素材没有可用的本地文件」，「更换文件」补图即可恢复。
  - `×` 仍然是「移除」：委托处理器里 `data-unbind` 分支排在 `data-bound` 之前，点击事件按 DOM 层级先命中 `×`。
- **资产选择弹窗新增「替换」语义**（`openAssetPicker(sb, role, {replace, replaceFrom})`）：标题改为「替换素材 · 槽位」，单选（一换一），确定后**先绑定新素材、再解绑旧素材**（顺序不可颠倒 —— 先解绑万一绑定失败就白丢）。
  - 多值槽位（角色 / 道具）必须补解绑那一步，否则"替换"会退化成"多绑一个"；单值槽位在后端 `bindAsset` 里已被替换，解绑是空操作（幂等，不报错）。
  - 配额口径跟着改：替换模式先把"即将被换掉的那一张"从占用里扣掉，**已满额时仍可替换**（换绑不增加图片数），并在满额条里换一套说法说明这一点。

#### `0.8.1` — 2026-09-20

- **修复框选时会选中文字**：浏览器的原生划词从 `mousedown` 那一刻就开始建立选区，而原实现只在**超过 4px 阈值之后**的 `mousemove` 里 `preventDefault` —— 那时选区已建好、再拦也取消不掉，于是拖拽框选的同时把卡片名称与行内文字一并选蓝了。现改为在 **mousedown 就 preventDefault**，并顺手清掉拖拽前可能残留的选区。
  - 不影响既有能力：`click` 照常派发（已实测被 preventDefault 后点击仍能打开素材编辑弹窗）；被排除的按钮 / 输入框 / `.prompt-text` 不走这条分支，划词与聚焦不受影响。

#### `0.8.0` — 2026-09-20

- **道具改为多槽位**：`prop` 从单值槽位改成可绑多个（原来绑一张后 `＋` 就消失，用户报"没有可用槽位"）。槽位随绑定数量动态增加，数量由**当前模型的参考图上限**约束 —— 达上限时 `＋` 会说明原因，不再是"点了没反应"。
- **首帧图 / 分镜图各自独立的资产库**：这两类原来在映射表里都被指到 `scene`，而**后端根本没有这两种资产类型**，于是素材无处存放、点开槽位只看到场景图，必然"资产缺失"。现在后端新增 `firstFrame` / `storyboard` 两类资产，素材面板也加了对应分类，四个槽位与资产库一一对应。两者仍是**单槽位**（各只一个）。
- **「多值槽位」收敛为单一事实来源**：后端原先硬编码 `role !== 'character'`、前端另有一份 `ROLE_META.multi`，改一处就不同步。现在后端以 `ROLE_MULTI` 表为准（`character` / `prop` 多值，其余单值），前端 `ROLE_META.multi` 与之对齐。
- 资产类型标签表也收敛为一份（前端 `ASSET_TAB_LABEL`），新增类型时只需改这一处。

#### `0.7.0` — 2026-09-19

- **参考图数量统计与上限校验**：按分镜统计已用参考图数量，展示「已添加 X / 上限 Y」；达上限时拦在添加入口并说明当前模型对应的限制。
  - **上限按模型系列配置**（`models.js` 的 `DREAMINA_LIMIT_RULES`）：Seedance 2.5 系列 30 张、Seedance 2.0 系列 9 张，其余型号走保守兜底档。新增模型时把系列正则挂进表里即生效，不必逐型号抄数字。三处消费方（组装 `--image` 的截断、自动匹配的配额、前端提示）统一走 `limitsFor()` / `imageLimitFor()`。
  - **计数口径与「真会发出的图」完全一致**：取自 `asset-lock.imageCatalog()`（只算非音频且有本地文件的图），与组装命令时的图号表同源 —— 不会出现"明明只发 8 张却说满了 9 张"。
  - **自动匹配复用同一套配额**：只填**剩余名额**，超出部分不再绑定，并在预览里单列「超上限未绑」说明原因；计数里也加上这一项，避免"明明命中了却没绑上"的困惑。
  - **移除即恢复配额**：计数是派生值，解绑后自动递减，添加入口同步退出满额态。
  - 未满时按钮正常；满额时按钮转琥珀色、`cursor:not-allowed`，点击给出明确提示（含模型名、上限、已用数，以及"改用 Seedance 2.5 可到 30 张"的出路），**不打开弹窗**。

#### `0.6.0` — 2026-09-19

- **分镜「添加资产」弹窗**：点表格里各槽位的 `＋`（**沿用既有按钮**，未新增入口）不再只提示「去右侧面板点选」，而是直接弹出**资产选择弹窗** —— 列出该槽位对应类型的全部素材（名称 / 类型 / 缩略图）、支持关键词搜索、空状态提示；点一项即选中（高亮 + 实心勾），再点取消；`确定` 逐个绑定，`取消` / 关闭 / Esc / 点遮罩不做任何变更。
  - 已绑定在本分镜上的素材标「已添加」且不可再选，点击给出「已在此分镜中，无需重复添加」提示（后端对重复绑定是静默忽略，必须由前端提示）。
  - 角色是多值槽位可多选；场景 / 道具 / 首帧图 / 分镜图 / 音频是单值槽位，选第二个会替换前一个（与后端 `bindAsset` 的 single/multi 规则一致）。
  - 绑定期间按钮转「添加中…」并禁用；失败保持弹窗打开、把已成功的从选择集摘掉以便重试；成功后关闭弹窗并刷新表格槽位与素材面板。
  - 原有的「点 ＋ 后去右侧面板点卡片」快捷路径**保留可用**，未做删除。

#### `0.5.2` — 2026-09-19

- **CLI 未回传 `submit_id` 时自动找回（避免白扔一次生成）**：实测故障 —— `dreamina multimodal2video` 报 `get_history_by_ids failed: ret=1015`，但任务**已在即梦侧创建并扣费**（实测扣 30 积分、随后 `gen_status` 变 `success`），只是 CLI 在回查那一步挂了。原实现直接判失败 ⇒ 钱花了、视频也生成了，却因为没有 id 而查不到、下不到。现在改用 `dreamina list_task` 按「任务类型一致 + 提示词全等」把任务找回来，再走正常轮询与下载。
- **修复 `parseJson` 无法解析 JSON 数组**：原实现只找第一个 `{`，遇到 `list_task` 的数组输出会从数组内部的第一个对象开始切，切出 `{…}, {…}]` 这种非法 JSON，解析必然失败（这是上一条能生效的前提）。现在从每个 `{` / `[` 位置依次尝试；同时兼容 stdout 前面混 `[WARN] …` 日志行的情形。

#### `0.5.1` — 2026-09-19

- **修复产物封面尺寸过小导致播放前画面发虚**：`0.5.0` 按「列表 76×48 缩略图」的需求把封面缩到 480 宽，但同一张图还被用作播放器的 `poster`（播放前显示的那一帧，实测渲染宽 566 CSS px、HiDPI 屏上可达 1132 设备像素）—— 放大 1.18×（DPR 2 时 2.4×），看起来比视频本身糊。
  改为 `scale=min(1280,iw):-2`：**上限 1280 且绝不放大源**。文件从 ~15 KB 变为 ~54 KB（一次性缓存资源）。
- **关闭预览弹窗时停止视频播放**：此前三处关闭入口（右上角 ×、点遮罩空白、Esc）都只把遮罩 `hidden` 掉，`<video>` 元素仍留在 DOM 里继续播放 —— 表现为「关掉预览后还能听到声音，一直到它播完」。实测：关闭 1.5 秒后 `currentTime` 从 0.92 涨到 2.45、`paused` 仍为 false。现统一走 `closeDetail()`：`pause()` + 释放 `src` + `load()`（同时中断后台还在进行的 Range 下载）。

#### `0.5.0` — 2026-09-19

- **产物封面**：表格里已完成分镜的缩略图改显示**视频画面**（此前是 ID 派生的棕色渐变 + 播放图标，看不出内容）。
  根因：创作 CLI 的 `query_result` **不提供封面**（`--help` 只有 `--download_dir` / `--submit_id`，实测下载目录里只有 mp4），所以 `coverUrl` 恒为 null。现在下载产物后用**本机 ffmpeg** 抽第 1 秒的一帧（缩到 480 宽）作为封面。
- **启动期封面补齐**：给本次改动之前生成的产物补一次封面（幂等、上限 50 条、不阻塞监听）。
- **ffmpeg 是可选依赖**：未安装或抽帧失败一律静默降级（缩略图退回渐变），**不影响生成链路的任何环节**。路径可用 `JC_FFMPEG_PATH` 或 `config.json` 的 `ffmpegPath` 指定（默认取 PATH 里的 `ffmpeg`）。

#### `0.4.0` — 2026-09-19

- **「产物预览」变成真播放器**：原先点开只是一块渐变底 + 播放图标 + 把 `videoUrl` 当文字打出来，**根本播不了**（项目里连一个 `<video>` 元素都没有）。现在换成 `<video controls>`，并附「在新窗口打开 ↗」链接。
- **静态文件服务支持 HTTP Range（206）**：`serveFile` 由 `readFileSync` 整块读入改为**流式 + 单段 Range**。这是播放器能拖动进度条的前提 —— 修复前带 `Range` 的请求返回的是全部字节，浏览器无法定位；同时消除了大产物（实测 5.4 MB）整块进内存、顶住事件循环的问题。非法 Range 返回 `416`。
- 产物 / 素材地址统一走 `mediaUrl()` 补后端 origin，`file://` 打开的单文件发布版也能正确取到视频。

#### `0.3.0` — 2026-09-19

- **默认值变更自动同步到已有分镜**：保存设置时，把**模型 / 画幅 / 分辨率**三项对齐到当前默认值并同步给所有分镜（`generating` 的跳过）。**时长刻意不同步** —— 它是逐条按提示词「总时长」标注算出来、可能手工调过的，不该被全局默认值覆盖。
  背景：分镜在**导入那一刻**把默认值快照到自己身上，之后不跟随默认值 —— 于是出现"我把默认改成 Fast VIP，可提交出去在即梦里还是 VIP"。现在保存设置即可对齐。
- **修复 `PUT /settings` 会清空默认参数**（既有缺陷，本次一并修）：请求体不带 `defaults` 时，原实现 `s.defaults = {}` 会被随后的 `Object.assign` 拿来把库里的默认参数整体清空（实测一次只带 `queue` 的 PUT 就让 `defaults.model` 变成 `undefined`，之后新导入的分镜提交即报「模型当前不可用」）。现改为基于库中现值拷贝。

#### `0.2.0` — 2026-09-19

可靠性修复（针对《项目改进问题清单》P0 项，逐项核实后实施）：

- **新增任务状态机** `server/task-state.js`：状态迁移与「谁有权写」的唯一事实来源；每次派发分配 `attemptId`，过期 attempt 的结果一律丢弃。
- **修复「取消后复活」**：取消会清空 `attemptId`，worker 拿到 CLI 成功结果后不再把它写回 `succeeded`（原先会出现 `generating → canceled → succeeded`）。
- **修复「重复生成 / 重复扣费」**：`retry` 只允许 `failed` / `canceled`；`queued` / `generating` / `succeeded` 一律拒绝（界面上的重试按钮本就只在失败行出现）。
- **修复「删除运行中任务的竞争」**：强制删除前先置为取消并清 `attemptId`；worker 检测到分镜已删除后停止写入，不再产生幽灵日志 / 生成记录。
- **`batch-submit` 幂等生效**：原先前端发 `Idempotency-Key` 而后端只在 `/storyboards/import` 上处理；现在两者共用同一实现并带 24h TTL。前端幂等键改为「提交内容 + 2 秒时间桶」，连点 / 重发会被吸收。
- **本地 API 跨域收窄**：移除 `Access-Control-Allow-Origin: *`，只对本地 Origin 回 ACAO，未知网页的请求被拒（预检 403 + API `40100`）。
- **模型时长能力统一**：时长上限改按**该分镜模型**的能力钳制（`seedance2.5` 支持到 30s），不再一律压到全局的 15s。
- **并发不再被静默改写**：`batch-submit` 不再把用户设置 `clamp(…, 1, 5)`；并发只有一个出口（`PUT /settings` + worker 派发闸）。
- **进度轮询不再「读后清」**：`GET /storyboards/progress` 不再清除 `dirty`（那会让第二个标签页永远收不到更新），改由列表刷新统一清除；前端按载荷签名判断是否退避。
- **新增测试**：`server/task-state.test.js`（9 项）、`server/worker-guard.test.js`（5 项，直接验证取消 / 删除 / 重试时的写入守卫）。

#### `0.1.0` — 基线

首次引入版本号时的既有状态（对应提交 `7a85f4b`）。

