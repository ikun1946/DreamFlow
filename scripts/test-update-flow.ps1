#!/usr/bin/env pwsh
# scripts/test-update-flow.ps1 -- update-flow regression (Phase 3, P2-7 / 3.2)
#
# Why this script:
#   The update chain (check / download / verify / invoke installer) used to
#   be verifiable only by clicking through the UI, which is why 163e62d
#   silently deleted the three update-source functions and went unnoticed
#   for several releases. This script drives the real chain end-to-end
#   and asserts the result.
#
# Acceptance (per docs/项目全面审查与改进流程.md P2-7):
#   * Runs to completion in one command and gives a clear pass/fail verdict
#   * Records the verdict (and log path) to docs/版本发布与更新流程.md
#   * Covers the "upgrade" step of the four-step clean-environment check
#
# Usage:
#   pwsh scripts/test-update-flow.ps1
#   pwsh scripts/test-update-flow.ps1 -Install    # actually invoke installer
#   pwsh scripts/test-update-flow.ps1 -SkipBuild  # skip the npm run build step
#
# Exit code: 0=pass, 1=fail
#
# ⚠ 需要**联网**（2026-09-23 起）：本脚本实际打的是**在线 GitHub 源**，
#   会真的下载一个上百 MB 的安装包。两个原因见下方 "set-update-source" 段的注释
#   （① 配置注入从未生效；② 0.35.6 起更新源已固定为 github）。
#   它在 .github/workflows/update-flow.yml 里由 Windows runner 执行 ——
#   runner 自带 PS 7 且有网络，所以那边跑得通。
#
# ⚠ 需要 PowerShell 7+（pwsh）。在 Windows PowerShell 5.1 下会于「启动 Electron」那一步失败：
#   Start-Process 继承环境时报「已添加项。字典中的关键字:"PATH"所添加的关键字:"Path"」
#   —— 5.1 枚举环境变量是大小写敏感的，而系统里同时存在 PATH / Path 两个键。
#   5.1 下前九步仍能跑完（含 package.json 的降级与恢复、mock 更新源的构造），但拿不到最终断言。
#   实测记录见 docs/CHANGELOG.md 的 0.30.0 一节。
[CmdletBinding()]
param(
  [switch]$Install = $false,
  [switch]$SkipBuild = $false,
  [int]$TimeoutSec = 180,
  [string]$OldVersion = '0.28.9'
)

# Force UTF-8 so Chinese filenames in package.json / config files parse correctly.
# Windows PowerShell 5.1 defaults to the system OEM codepage (e.g. GBK) which
# mojibakes every UTF-8 string we touch.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# Patch the script's error reporter to include the line number; default PS
# error format only shows "at line:1 col:51" because of the way -File works.
trap {
  $ln = '?'
  if ($_.InvocationInfo -and $_.InvocationInfo.Position) { $ln = $_.InvocationInfo.Position.Line }
  $msg = '?'
  if ($_.Exception) { $msg = $_.Exception.Message }
  Write-Host ("[error] line " + $ln + ": " + $msg)
  exit 1
}

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo  = Resolve-Path (Join-Path $here '..')
Set-Location $repo

# === 0. Prepare ===
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir  = Join-Path $repo ".test-tmp\update-flow-$stamp"
$logsDir = Join-Path $runDir 'logs'
$oldData = Join-Path $runDir 'old-data'
$oldCfg  = Join-Path $oldData 'desktop-config.json'
$newData = Join-Path $runDir 'new-data'
$updSrc  = Join-Path $runDir 'update-source'
$exeDir  = Join-Path $updSrc 'JimengConsole-Win-x64'
$newVer  = $null
$report  = [ordered]@{
  at          = (Get-Date).ToString('o')
  ok          = $false
  repo        = $repo
  runDir      = $runDir
  oldVersion  = $OldVersion
  steps       = @()
}
$script:stepNum = 0
# Fail 里要靠它收掉残留的 Electron 进程（见 Fail 的注释）
$script:electronProc = $null
function Save-Report() {
  # ⚠ 2026-09-23 补：**每记一步就落盘一次**，而不是等 Pass/Fail 才写。
  #   为什么：首次 CI 运行里脚本 16 步全跑完、断言全过，但那一步仍被 job 超时
  #   掐掉，而 report.json 是在最后才写的 —— 于是**现场全丢**，只剩一行
  #   "No files were found"（而且 .test-tmp 是隐藏目录，artifact 默认不收）。
  #   改成增量落盘后，无论后面卡在哪，前 16 步的证据都在磁盘上。
  #   用 -Compress 且限制深度：这里每步都要写，必须快；报告是给机器读的，不需要缩进。
  try {
    $reportPath = Join-Path $runDir 'report.json'
    ($script:report | ConvertTo-Json -Compress -Depth 8) | Set-Content -Path $reportPath -Encoding UTF8
  } catch {
    Write-Host ('[warn] 写 report.json 失败（已忽略）: ' + $_.Exception.Message)
  }
}
function Record($name, $data = @{}) {
  $script:stepNum++
  $entry = [ordered]@{ n = $script:stepNum; name = $name; data = $data }
  $script:report.steps += $entry
  $json = $data | ConvertTo-Json -Compress -Depth 5
  Write-Host ("[step {0:D2}] {1} {2}" -f $script:stepNum, $name, $json)
  Save-Report
}
# 还原 package.json 的降级改动（幂等：多调几次无害）。
# ⚠ 为什么 Pass/Fail 里也必须调：它们用 [Environment]::Exit **立即终止进程**，
#   会跳过 finally —— 若 Fail 是在 try 内部被调用的（例如"Electron 超时未退出"），
#   finally 里的还原就跑不到，仓库会留下一个版本号被降级的 package.json。
#   这不是假想：2026-09-22 真实发生过一次（版本被退成 0.28.9，见 docs/CHANGELOG.md）。
$script:pkgPath = $null
$script:pkgOriginal = $null
$script:pkgRestored = $false
function Restore-PackageJson() {
  if ($script:pkgRestored) { return }
  try {
    if ($script:pkgPath -and $script:pkgOriginal) {
      [System.IO.File]::WriteAllText($script:pkgPath, $script:pkgOriginal)
      $script:pkgRestored = $true
      Write-Host '[info] 已还原 package.json'
    }
  } catch {
    Write-Host ('[warn] 还原 package.json 失败 —— 请手工检查该文件！: ' + $_.Exception.Message)
  }
}
function Fail($why) {
  $script:report.ok = $false
  $script:report.error = $why
  Write-Host "[FAIL] $why" -ForegroundColor Red
  # ⚠ 2026-09-23 补：退出前**必须收掉 Electron 进程**。
  #   CI 的一步要等整棵进程树结束才算完 —— 若 Electron 还活着（无头驱动失效、
  #   或断言在它退出前就失败），这一步会一直挂着，最终把"测试失败"变成
  #   "job 20 分钟超时"，现场（report.json 之外的输出）全丢。
  #   实测：2026-09-23 首次 CI 运行就是这样被掐掉的。
  try {
    if ($script:electronProc -and -not $script:electronProc.HasExited) {
      $script:electronProc.Kill()
      $script:electronProc.WaitForExit(10000) | Out-Null
      Write-Host '[info] 已终止残留的 Electron 进程'
    }
  } catch { Write-Host ('[warn] 终止 Electron 失败（已忽略）: ' + $_.Exception.Message) }
  Restore-PackageJson      # 见其上方注释：硬退出会跳过 finally，必须在这里兜一次
  Save-Report
  Write-Host ("[info] Report written to: " + (Join-Path $runDir 'report.json'))
  # ⚠ 用 [Environment]::Exit 而不是 exit：前者**立即终止进程**，不经过 PS 的退出流程。
  #   后者在有未释放的 Start-Process 重定向句柄时可能不返回 —— 实测首次 CI 运行里
  #   脚本 16 步全跑完、断言全过，却卡在收尾不返回，最终撞 20 分钟 job 超时。
  [Environment]::Exit(1)
}
function Pass() {
  $script:report.ok = $true
  # 先打标记再落盘：万一下面出问题，日志里至少能看到"断言已全过"。
  Write-Host '[OK] All steps passed' -ForegroundColor Green
  Save-Report
  Write-Host ("[info] Report written to: " + (Join-Path $runDir 'report.json'))
  [Environment]::Exit(0)
}

New-Item -ItemType Directory -Path $runDir, $logsDir, $oldData, $newData, $updSrc, $exeDir -Force | Out-Null
# Clean any stale sibling tmp dirs that confuse the publish-mock step.
# ⚠ 用 foreach + -Path，而不是 `Get-ChildItem | Remove-Item` 管道写法（2026-09-23 修）：
#   某些受限 / 被包装的环境里 Remove-Item 不接受管道输入 —— 实测会报
#   "missing path operand" 让脚本在 prepare 阶段就退出。显式 -Path 在标准与受限环境下都可用。
$stale = @(Get-ChildItem -Path $repo\.test-tmp -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'update-flow-*' -and $_.FullName -ne $runDir })
foreach ($s in $stale) {
  # 用 try/catch，而不是 -ErrorAction SilentlyContinue（2026-09-23 修）：
  # 受限环境下的删除保护会抛 **terminating error**（如 safe-delete 的 FAIL_CLOSED），
  # SilentlyContinue 压不住它，脚本会在 prepare 阶段直接退出。
  # 清不掉旧残留只影响 mock 更新源，不该中断整条回归 —— 记一行警告继续跑。
  try {
    Remove-Item -Path $s.FullName -Recurse -Force -ErrorAction Stop
  } catch {
    Write-Host ("[warn] 旧残留清理失败（已忽略）: " + $s.Name + " — " + $_.Exception.Message)
  }
}
Record 'prepare' @{ runDir = $runDir }

# === 1. Seed "old version" userData ===
$fakeDb = [ordered]@{
  schemaVersion = 3
  projects       = @(@{ id = 'pj_t1'; name = 'update-flow test project'; defaultWorkspaceId = 'ws_t1';
    settings = @{}; createdAt = '2026-09-22T00:00:00.000Z'; updatedAt = '2026-09-22T00:00:00.000Z'
    lastOpenedAt = '2026-09-22T00:00:00.000Z'; deletedAt = $null })
  workspaces     = @(@{ id = 'ws_t1'; projectId = 'pj_t1'; name = 'main'; description = '';
    createdAt = '2026-09-22T00:00:00.000Z'; updatedAt = '2026-09-22T00:00:00.000Z'
    lastOpenedAt = '2026-09-22T00:00:00.000Z'; deletedAt = $null })
  storyboards    = @()
  assets         = @()
  settings       = @{ delimiter = @{ type = 'custom'; value = ';;' }
                    defaults   = @{ model = 'seedance2.0_vip'; ratio = '16:9'; resolution = '720p'; durationSec = 5 }
                    queue      = @{ concurrency = 2; autoRetry = $true; maxRetry = 2 } }
  seq            = 0
  idempotency    = @{}
  cliJobs        = @{}
  logs           = @{}
  records        = @()
  recordSeq      = 0
}
$fakeDbPath = Join-Path $oldData 'db.json'
ConvertTo-Json $fakeDb -Depth 5 | Set-Content -Path $fakeDbPath -Encoding UTF8
$dbHashBefore = (Get-FileHash -Path $fakeDbPath -Algorithm SHA256).Hash
Record 'seed-old-data' @{ dataDir = $oldData; dbSha256 = $dbHashBefore }

@{ dataDir = $oldData } | ConvertTo-Json | Set-Content -Path $oldCfg -Encoding UTF8

$assetDir = Join-Path $oldData 'projects\pj_t1\assets'
New-Item -ItemType Directory -Path $assetDir -Force | Out-Null
$assetPath = Join-Path $assetDir 'test.png'
[byte[]]$assetBytes = 1..255
[System.IO.File]::WriteAllBytes($assetPath, $assetBytes)
$assetHashBefore = (Get-FileHash -Path $assetPath -Algorithm SHA256).Hash
Record 'seed-asset' @{ path = $assetPath; sha256 = $assetHashBefore }

# === 2. Build "new version" + latest.yml ===
if (-not $SkipBuild) {
  Record 'build-start' @{}
  $buildOut = npm run build:web 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { Fail ("npm run build:web failed") }
  Record 'build-done' @{ distFile = (Get-Item dist\*.html).FullName }
}

$pkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ('[probe] pkg version=' + $pkg.version + ' name=' + $pkg.name)
$newVer = $pkg.version
Record 'read-new-version' @{ version = $newVer }

$updDist = Join-Path $updSrc 'dist'
# dist/ is a single file (`即梦批量生成控制台.html`); copy it directly.
# Avoid copying the source-tree to a path named 'dist' (other test tmp dirs may
# already have a 'dist' sibling -- Copy-Item can be ambiguous).
$updPkg = Join-Path $updSrc 'JimengConsole-Win-x64'
# JimengConsole-Win-x64/ is the folder name NSIS would produce for the
# release artifact; updater.fetchManifest expects version.yml at the parent
# (i.e. update-source/), and the file path in it points INSIDE this subdir.
Copy-Item -Path 'dist\*' -Destination $updPkg -Recurse -Force
$newHtmlName = (Get-Item $updPkg\*.html)[0].Name
$updPkgDist = Join-Path $updPkg $newHtmlName
Write-Host ('[probe] updPkgDist=' + $updPkgDist + ' exists=' + (Test-Path $updPkgDist))
$newHtmlSize = (Get-Item $updPkgDist).Length
$newHtmlSha  = (Get-FileHash $updPkgDist -Algorithm SHA512).Hash
$dateStamp   = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
Write-Host ('[probe] newHtmlName=' + $newHtmlName + ' size=' + $newHtmlSize + ' sha=' + $newHtmlSha.Substring(0, 20) + '...')

# hex -> base64 (use a for loop with no output to avoid capturing the per-iteration value)
$hex = $newHtmlSha.ToLowerInvariant()
$bytes = New-Object 'System.Collections.Generic.List[byte]'
for ($i = 0; $i -lt $hex.Length; $i += 2) {
  $bytes.Add([Convert]::ToByte($hex.Substring($i, 2), 16)) | Out-Null
}
$shaB64 = [Convert]::ToBase64String($bytes.ToArray())
Write-Host ('[probe] shaB64 len=' + $shaB64.Length)

$updHtmlPath = 'JimengConsole-Win-x64/' + $newHtmlName
$yml = @"
version: $newVer
files:
  - url: $updHtmlPath
    sha512: $shaB64
    size: $newHtmlSize
path: $updHtmlPath
sha512: $shaB64
releaseDate: $dateStamp
"@
$ymlPath = Join-Path $updSrc 'latest.yml'
Write-Host ('[probe] ymlPath=' + $ymlPath + ' ymlLen=' + $yml.Length)
$yml | Set-Content -Path $ymlPath -Encoding UTF8
Write-Host ('[probe] yml written')
Record 'publish-mock' @{ yml = $ymlPath; file = $newHtmlName; sha512 = $shaB64; size = $newHtmlSize }

# === 3. Drive Electron with JC_UPDATE_FLOW_TEST=1 ===
# Copy-Item source\* target copies files only; the projects\ subdir would be lost.
# Use (Get-ChildItem -Recurse) | Copy-Item to mirror the tree.
Get-ChildItem -Path $oldData -Recurse -File | Copy-Item -Destination $newData -Force
$nCopied = (Get-ChildItem $newData -Recurse -File).Count
Write-Host ("[probe] nCopied=" + $nCopied + ' newData=' + $newData)
Record 'simulate-data-copy' @{ from = $oldData; to = $newData; nFiles = $nCopied }

# ⚠ 2026-09-23：下面这段「把更新源写进配置」**已经失效，保留只为留痕**。
#   两个独立原因：
#     ① 写错了位置 —— 这里写的是 <newData>/desktop-config.json，而应用读的是
#        app.getPath('userData') 下的那一份（desktop/runtime-paths.js 的
#        `configPath = path.join(userData, CONFIG_FILE)`，与 JC_DATA_DIR 无关）。
#        实测证据：本机真实配置 %APPDATA%\即梦批量生成控制台\desktop-config.json
#        的键**只有 legacyImportChecked**，从未出现过 updates —— 即这一步
#        **从来没有生效过**。
#     ② 更新源已改为**固定**（0.35.6）：desktop/main.js 的 updateSource() 恒返回
#        内置的 github/ikun1946/DreamFlow，不再读任何配置文件。
#   ⇒ 本脚本实际跑的是**在线 GitHub 源**：需要联网，且会真的下载一个上百 MB 的
#     安装包（把 package.json 降级成 $OldVersion 后，线上必有更新可下）。
#   上面构造的 mock 更新源（$updSrc）因此也不再被读取 —— 一并保留，
#   将来若要做离线模式（给 updateSource 加一个受测试标志双键门控的后门）可直接复用。
#
#   ⚠ 注意：应用侧对"实际用了哪个源"有断言（见本文件末 assert-source），
#     所以这里即使再写错，也会在断言处暴露，而不是静默换个源跑完。
$newCfgPath = Join-Path $newData 'desktop-config.json'
Write-Host ('[probe] newCfgPath=' + $newCfgPath + ' exists=' + (Test-Path $newCfgPath))
if (-not (Test-Path $newCfgPath)) { Fail "desktop-config.json missing after copy: $newCfgPath" }
$cfgRaw = Get-Content $newCfgPath -Raw -Encoding UTF8
$cfg = $cfgRaw | ConvertFrom-Json
$cfg.dataDir = $newData
$cfg | Add-Member -NotePropertyName 'updates' -NotePropertyValue ([PSCustomObject]@{
  provider = 'local'; dir = $updSrc
}) -Force
ConvertTo-Json $cfg -Depth 5 | Set-Content -Path $newCfgPath -Encoding UTF8
Record 'set-update-source' @{ cfg = $newCfgPath; provider = 'local'; dir = $updSrc; effective = $false; why = '配置写到了应用不读的路径；且 0.35.6 起更新源已固定' }

# ⚠ 只替换 version 那一行的值，**不做整份 JSON 的重新序列化**（2026-09-23 修）。
#   原写法 `ConvertFrom-Json | ConvertTo-Json | Set-Content` 会把整份 package.json 重排
#   （4 空格缩进、`&&` 变成字面 `\u0026\u0026`）；若脚本中途被中断、finally 没跑到，
#   仓库里就留下一个「版本号回退 + 格式被破坏」的 package.json。
#   —— 2026-09-22 真实发生过一次：版本被退成 0.28.9（**正是本脚本 $OldVersion 的默认值**），
#      直到次日核对文档口径时才发现。这正是"改仓库文件前先想清楚失败路径"的实例。
#   改用正则替换 + 无 BOM 写回，原有格式逐字节保留。
$script:pkgOriginal = Get-Content 'package.json' -Raw -Encoding UTF8
$script:pkgPath = (Resolve-Path 'package.json').Path
try {
  $pkgPatched = $script:pkgOriginal -replace '("version"\s*:\s*")[^"]+(")', ('${1}' + $OldVersion + '${2}')
  [System.IO.File]::WriteAllText($script:pkgPath, $pkgPatched)
  Record 'downgrade-package-json' @{ asIfVersion = $OldVersion }

  $env:JC_DATA_DIR = $newData
  $env:JC_UPDATE_FLOW_TEST = '1'
  $env:HEADLESS_TEST = '1'   # Skip createWindow — no real display in CI / headless run.
  # 用 .NET API 清环境变量，而不是 `Remove-Item Env:...`（2026-09-23 修）：
  # 受限环境下 Remove-Item 被包装后会把 `Env:` 当成文件路径、抛 FAIL_CLOSED 终止脚本
  # （实测 reason=path-not-found）。SetEnvironmentVariable(name, $null) 不经过 provider，稳定。
  if ($Install) { $env:JC_UPDATE_FLOW_INSTALL = '1' }
  else { [Environment]::SetEnvironmentVariable('JC_UPDATE_FLOW_INSTALL', $null) }
  $env:JC_DESKTOP_SMOKE = '0'
  $env:ELECTRON_DISABLE_SANDBOX = '1'

  $logFile = Join-Path $logsDir "electron-$stamp.log"
  Record 'electron-start' @{ log = $logFile; install = $Install }

  $proc = Start-Process -FilePath 'node_modules\.bin\electron.cmd' `
    -ArgumentList '.' `
    -WorkingDirectory $repo `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -PassThru -NoNewWindow
  $script:electronProc = $proc   # Fail 时要靠它收尾，别让 CI 卡在进程树上

  $waited = $proc.WaitForExit($TimeoutSec * 1000)
  if (-not $waited) {
    try { $proc.Kill() } catch {}
    Fail "Electron did not exit within $TimeoutSec seconds"
  }
  $code = $proc.ExitCode
  Record 'electron-exit' @{ exitCode = $code; log = $logFile }

  # ⚠ 2026-09-23 补：等 `electron.cmd` 退出 ≠ Electron 整棵进程树退出。
  #   Electron 会派生 GPU / utility / crashpad 等子进程，它们可能比主进程活得久；
  #   而 CI 的一步要等**整棵进程树**结束才算完 —— 实测首次 CI 运行里脚本 16 步
  #   全跑完、断言全过，这一步却仍挂着直到 20 分钟 job 超时。
  #   按可执行文件路径收敛：只收本次仓库里的 electron，不误伤本机其它 Electron 应用。
  try {
    $repoEsc = [regex]::Escape($repo)
    $left = @(Get-Process -Name 'electron' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path -match $repoEsc })
    if ($left.Count) {
      Write-Host ('[info] 回收 ' + $left.Count + ' 个残留的 Electron 子进程')
      $left | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  } catch { Write-Host ('[warn] 回收 Electron 子进程失败（已忽略）: ' + $_.Exception.Message) }

  $body = Get-Content $logFile -Raw
  $m = [regex]::Match($body, '\[update-flow\] (\{[^\n]+\})')
  if (-not $m.Success) { Fail "No [update-flow] JSON line in electron output; see $logFile" }
  $flowReport = $m.Groups[1].Value | ConvertFrom-Json
  Record 'flow-report' $flowReport

  # ★ 断言"实际用的是哪个更新源"，应为固定的 github。
  #   为什么单独断言：本脚本上方那段"写配置换源"是失效的（见其上方注释），
  #   而**静默地用了另一个源**正是最难发现的那类问题 —— 回归跑了、绿了，
  #   却根本没测到你以为在测的那条路。将来若有人把更新源改回可配置，
  #   这里会立刻红，而不是无声地换个源跑完。
  $srcStep = @($flowReport.steps | Where-Object { $_.name -eq 'source' })[0]
  if (-not $srcStep) {
    Fail "flow report 里没有 source 步骤，无法确认实际使用的更新源"
  }
  Record 'assert-source' @{ provider = $srcStep.provider; dir = $srcStep.dir; repo = $srcStep.repo }
  if ($srcStep.provider -ne 'github') {
    Fail ("更新源应为固定的 github，实际为 '" + $srcStep.provider + "' —— 请检查 desktop/main.js 的 updateSource()")
  }
  if ($srcStep.provider -eq 'local' -or $srcStep.dir) {
    Fail "更新源仍带本地目录，说明配置注入意外生效了 —— 与 0.35.6 的固定源设计不符"
  }

  if (-not $flowReport.ok) { Fail ("update-flow self-check ok=false: error=" + $flowReport.error) }
}
finally {
  # 无 BOM 写回：原 `Set-Content -Encoding UTF8` 在 5.1 下会写入 BOM，
  # 与仓库里无 BOM 的 package.json 产生伪差异；WriteAllText 默认无 BOM。
  Restore-PackageJson
  Record 'restore-package-json' @{}
}

# === 4. Assert: data byte-for-byte unchanged ===
$dbHashAfter  = (Get-FileHash (Join-Path $newData 'db.json') -Algorithm SHA256).Hash
$assetHashAfter = (Get-FileHash $assetPath -Algorithm SHA256).Hash
Record 'assert-data' @{ dbSha256 = $dbHashAfter; assetSha256 = $assetHashAfter }

if ($dbHashAfter -ne $dbHashBefore) {
  Fail "db.json changed during update! before=$dbHashBefore after=$dbHashAfter"
}
if ($assetHashAfter -ne $assetHashBefore) {
  Fail "asset file changed during update! before=$assetHashBefore after=$assetHashAfter"
}

# === 5. All clear ===
$script:report.install = $Install
$script:report.newVersion = $newVer
Pass