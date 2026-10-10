# rollback.ps1 — 把 desktop profile 完全回滚到 dsh-tri-layer-memory 介入之前
#
# 背景：2026-10-06 为安装 dsh-tri-layer-memory 而做的 profile 改动，以及随后那次
# 失败安装，导致运行中的 DSH 反复按自己的内存状态重写 profile 配置。结果：
#   - cordis.patch.yml 从 267 行被重写为 28 行（agent-preset-registry /
#     agent-default-model / llm-pi-ai 的 models 列表 / 皮肤启用状态全部丢失）
#     → 表现为「新会话的预设图标不见了」「只能初始化重新链接 opencode-go」
#   - package.json 的 dsh.profile.bundles 被反复截断
#
# 本脚本把它们恢复成介入之前的原始版本，并卸载那个插件。
#
# 恢复源（三份互为保险，脚本用的是最完整的一份）：
#   .backup-before-tlm\cordis.patch.yml   7777 B  2026-09-30   ← 本脚本使用
#   cordis.patch.yml.bak-1791287526777    7736 B  2026-10-06 17:59
#   cordis.patch.yml.bak-before-opencode-session 6608 B 2026-09-30 15:27
#
# 使用方法（必须先完全退出 DSH）：
#   pwsh -File rollback.ps1
#   pwsh -File rollback.ps1 -SkipInstall     # 只恢复文件，不动 node_modules

param(
  [string]$DshHome,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# DSH_HOME 只在 DSH 自己派生的 shell 里存在，普通 PowerShell 里是空的。
$dshHome = $DshHome
if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = $env:DSH_HOME }
if ([string]::IsNullOrWhiteSpace($dshHome)) {
  $dshHome = Join-Path $env:USERPROFILE '.dsh'
  Write-Host "提示：未设置 DSH_HOME，按默认位置推导 → $dshHome" -ForegroundColor DarkGray
}
if (-not (Test-Path $dshHome)) { throw "找不到 DSH 主目录：$dshHome（可用 -DshHome 参数指定）" }

$profileDir = Join-Path $dshHome 'profiles\desktop'
$backupDir = Join-Path $profileDir '.backup-before-tlm'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host "DSH 主目录 : $dshHome"
Write-Host "profile    : $profileDir"
Write-Host ""

if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录：$profileDir" }

# ── 1. 确认 DSH 已退出 ────────────────────────────────────────────────────
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "⚠ DeepSeek Harness 仍在运行（PID: $($running.Id -join ', ')）。" -ForegroundColor Yellow
  Write-Host "  它会在几秒内覆盖你恢复的文件，现在做没有任何意义。" -ForegroundColor Yellow
  Write-Host "  请先完全退出（包括托盘图标），然后重新运行本脚本。" -ForegroundColor Yellow
  exit 1
}
Write-Host "✓ DSH 已退出" -ForegroundColor Green

# ── 2. 校验恢复源 ─────────────────────────────────────────────────────────
$srcPatch = Join-Path $backupDir 'cordis.patch.yml'
$srcManifest = Join-Path $backupDir 'package.json'
foreach ($f in @($srcPatch, $srcManifest)) {
  if (-not (Test-Path $f)) { throw "缺少恢复源：$f" }
}

# 恢复源必须包含这些关键节，否则宁可不动。
$patchText = Get-Content $srcPatch -Raw
foreach ($needle in @('agent-preset-registry', 'selectedDefault', 'agent-default-model', 'llm-pi-ai')) {
  if ($patchText -notmatch [regex]::Escape($needle)) {
    throw "恢复源 cordis.patch.yml 缺少关键节 '$needle'，拒绝用它覆盖（以免二次损坏）"
  }
}
$srcPatchLines = ($patchText -split "`n").Count
Write-Host "✓ 恢复源校验通过：cordis.patch.yml 约 $srcPatchLines 行，关键节齐全" -ForegroundColor Green
Write-Host ""

# ── 3. 备份当前状态 ───────────────────────────────────────────────────────
foreach ($name in @('package.json', 'cordis.patch.yml')) {
  $live = Join-Path $profileDir $name
  if (Test-Path $live) {
    $dest = Join-Path $profileDir "$name.before-rollback-$stamp"
    Copy-Item $live $dest -Force
    Write-Host "已备份 $name → $(Split-Path $dest -Leaf)"
  }
}
Write-Host ""

# ── 4. 恢复 ───────────────────────────────────────────────────────────────
Copy-Item $srcPatch (Join-Path $profileDir 'cordis.patch.yml') -Force
Write-Host "✓ 已恢复 cordis.patch.yml" -ForegroundColor Green
Copy-Item $srcManifest (Join-Path $profileDir 'package.json') -Force
Write-Host "✓ 已恢复 package.json" -ForegroundColor Green

$manifest = Get-Content (Join-Path $profileDir 'package.json') -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "bundles（$($manifest.dsh.profile.bundles.Count) 项）:"
$manifest.dsh.profile.bundles | ForEach-Object { Write-Host "  $_" }
Write-Host "dependencies: $($manifest.dependencies.PSObject.Properties.Name -join ', ')"

# ── 5. 同步 node_modules ──────────────────────────────────────────────────
# 原始清单里没有 dsh-tri-layer-memory，这一步会把它从 node_modules 里卸掉。
if ($SkipInstall) {
  Write-Host ""
  Write-Host "已跳过 pnpm install（-SkipInstall）。" -ForegroundColor Yellow
  Write-Host "注意：不跑这一步，node_modules 里仍留着 dsh-tri-layer-memory。" -ForegroundColor Yellow
} else {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpm) {
    Write-Host ""
    Write-Host "⚠ PATH 上找不到 pnpm，跳过 node_modules 同步。" -ForegroundColor Yellow
    Write-Host "  稍后手动执行：cd `"$profileDir`"; pnpm install" -ForegroundColor Yellow
  } else {
    Write-Host ""
    Write-Host "正在同步 node_modules（pnpm install）…" -ForegroundColor Cyan
    Push-Location $profileDir
    try {
      & pnpm install --reporter=append-only
      if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠ pnpm install 退出码 $LASTEXITCODE —— 文件已恢复，node_modules 可能未同步。" -ForegroundColor Yellow
      } else {
        Write-Host "✓ node_modules 已同步（插件已卸载）" -ForegroundColor Green
      }
    } finally {
      Pop-Location
    }
  }
}

Write-Host ""
Write-Host "回滚完成。现在可以启动 DSH。" -ForegroundColor Green
Write-Host "启动后请确认三件事：" -ForegroundColor Green
Write-Host "  1. 新会话的预设图标回来"
Write-Host "  2. opencode-go 的模型清单无需重新配置即可用"
Write-Host "  3. 皮肤 / 插件列表与你 9/30 时的状态一致"
Write-Host ""
Write-Host "若确认环境正常，再决定要不要重装 dsh-tri-layer-memory（一次只动一个变量）。"
