# restore-profile.ps1 — 恢复 desktop profile 的清单（在 DSH 关闭后运行）
#
# 背景：2026-10-06 的一次失败安装把运行中 DSH 的内存选中状态搞乱了，之后它一直在
# 用它自己的状态回写 package.json，导致 dsh.profile.bundles 被反复截断
# （观察到在 2 项与 6 项之间波动）。只要 DSH 开着就无法修复，因此本脚本要求
# 先确认进程已退出。
#
# 它做四件事：
#   1. 确认 DSH 已退出
#   2. 备份当前 package.json
#   3. 用恢复清单覆盖（= 你原本的 10 项 bundle + dsh-tri-layer-memory）
#   4. 跑 pnpm install 让 node_modules 与清单一致
#
# 使用方法：
#   pwsh -File restore-profile.ps1
#   pwsh -File restore-profile.ps1 -DshHome 'D:\.dsh'      # 非默认位置
#   pwsh -File restore-profile.ps1 -SkipInstall            # 只恢复清单

param(
  [string]$DshHome,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# DSH_HOME 只在 DSH 自己派生的 shell 里存在；直接在普通 PowerShell 里跑本脚本时
# 它是空的，所以必须自己推。顺序：-DshHome 参数 → $env:DSH_HOME → <用户目录>\.dsh。
$dshHome = $DshHome
if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = $env:DSH_HOME }
if ([string]::IsNullOrWhiteSpace($dshHome)) {
  $dshHome = Join-Path $env:USERPROFILE '.dsh'
  Write-Host "提示：未设置 DSH_HOME，按默认位置推导 → $dshHome" -ForegroundColor DarkGray
}
if (-not (Test-Path $dshHome)) { throw "找不到 DSH 主目录：$dshHome（可用 -DshHome 参数指定）" }

$profileDir = Join-Path $dshHome 'profiles\desktop'
$target = Join-Path $profileDir 'package.json'
$source = Join-Path $PSScriptRoot 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host "DSH 主目录 : $dshHome"
Write-Host "profile    : $profileDir"
Write-Host ""

if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录：$profileDir" }
if (-not (Test-Path $source)) { throw "找不到恢复清单：$source" }

# ── 1. 确认 DSH 已退出 ────────────────────────────────────────────────────
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "⚠ 检测到 DeepSeek Harness 仍在运行（PID: $($running.Id -join ', ')）。" -ForegroundColor Yellow
  Write-Host "  它正在持续回写 package.json，现在恢复会被立刻覆盖。" -ForegroundColor Yellow
  Write-Host "  请先完全退出 DSH（包括托盘图标），然后重新运行本脚本。" -ForegroundColor Yellow
  exit 1
}

# ── 2. 备份当前清单 ───────────────────────────────────────────────────────
$backup = Join-Path $profileDir "package.json.before-restore-$stamp"
Copy-Item $target $backup -Force
Write-Host "已备份当前清单 → $backup" -ForegroundColor Green

# ── 3. 覆盖为恢复清单 ─────────────────────────────────────────────────────
Copy-Item $source $target -Force
Write-Host "已写入恢复清单" -ForegroundColor Green

$manifest = Get-Content $target -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "现在的 bundle 列表（$($manifest.dsh.profile.bundles.Count) 项）:"
$manifest.dsh.profile.bundles | ForEach-Object { Write-Host "  $_" }

# ── 4. 同步 node_modules ──────────────────────────────────────────────────
# 必须跑一次。v0.1.2 起 dsh-tri-layer-memory 不再依赖任何第三方 DSH 插件，
# 因此 dsh-argp / dsh-mnemon / dsh-headroom / dsh-compaction-instant /
# dsh-memory-vault / dsh-mcp-lens 会全部被清除——它们就是插件列表里那排
# "异常"红标的来源（除最后三个与 0.2.0-rc.2 不兼容外，前三个也只是随附项，
# 现在改成"检测但不随附"）。
if ($SkipInstall) {
  Write-Host ""
  Write-Host "已跳过 pnpm install（-SkipInstall）。" -ForegroundColor Yellow
  Write-Host "注意：不跑这一步，那些第三方包仍留在 node_modules 里，插件列表会继续显示红标。" -ForegroundColor Yellow
} else {
  Write-Host ""
  Write-Host "正在同步 node_modules（pnpm install）…" -ForegroundColor Cyan
  Push-Location $profileDir
  try {
    & pnpm install --reporter=append-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host ""
      Write-Host "⚠ pnpm install 退出码 $LASTEXITCODE —— 清单已恢复，但 node_modules 可能未完全同步。" -ForegroundColor Yellow
      Write-Host "  可稍后在 profile 目录手动重试：pnpm install" -ForegroundColor Yellow
    } else {
      Write-Host "node_modules 已同步" -ForegroundColor Green
    }
  } finally {
    Pop-Location
  }
}

Write-Host ""
Write-Host "完成。现在可以启动 DSH。" -ForegroundColor Green
Write-Host "启动后请确认：" -ForegroundColor Green
Write-Host "  1. 插件列表只剩 dsh-tri-layer-memory（无红色'异常'标记）"
Write-Host "  2. memory_state 工具出现"
Write-Host "  3. compaction-basic 为 enabled"
