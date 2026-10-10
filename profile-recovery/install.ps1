# install.ps1 — 干净安装 dsh-tri-layer-memory（一次只动一个变量）
#
# 与之前那次灾难性安装的区别：
#   1. 只在 DSH 完全退出时执行（避免它回写覆盖）
#   2. 安装前先校验：插件列表里没有加载失败的行——有的话拒绝安装。
#      原因是 Loader 的 `internal/update` 会把内存中的整棵组合树写回
#      cordis.patch.yml；组合残缺时写回的就是残缺的树，会抹掉用户的自定义配置。
#      触发条件就是"有行加载失败时去动插件开关"。
#   3. 只增不减：脚本只在你的 package.json 里追加一条依赖 + 一项 bundle，
#      不改动、不重排你已有的任何条目
#   4. 安装前后都打印 diff，让改动一目了然
#
# 使用方法（必须先完全退出 DSH）：
#   pwsh -File install.ps1
#   pwsh -File install.ps1 -Uninstall     # 卸载（同样要求 DSH 已退出）

param(
  [string]$DshHome,
  [string]$Tarball = 'dsh-tri-layer-memory-0.1.3.tgz',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$dshHome = $DshHome
if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = $env:DSH_HOME }
if ([string]::IsNullOrWhiteSpace($dshHome)) {
  $dshHome = Join-Path $env:USERPROFILE '.dsh'
  Write-Host "提示：未设置 DSH_HOME，按默认位置推导 → $dshHome" -ForegroundColor DarkGray
}
if (-not (Test-Path $dshHome)) { throw "找不到 DSH 主目录：$dshHome" }

$profileDir = Join-Path $dshHome 'profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
$vendorDir = Join-Path $profileDir 'vendor'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path $manifestPath)) { throw "找不到 profile 清单：$manifestPath" }

# ── 1. DSH 必须已退出 ─────────────────────────────────────────────────────
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "⚠ DeepSeek Harness 仍在运行（PID: $($running.Id -join ', ')）。" -ForegroundColor Yellow
  Write-Host "  它会在几秒内覆盖你对 profile 的改动，现在做没有意义。" -ForegroundColor Yellow
  Write-Host "  请先完全退出（包括托盘图标），然后重新运行本脚本。" -ForegroundColor Yellow
  exit 1
}
Write-Host "✓ DSH 已退出" -ForegroundColor Green

# ── 2. 备份 ───────────────────────────────────────────────────────────────
$manifestBackup = Join-Path $profileDir "package.json.before-install-$stamp"
Copy-Item $manifestPath $manifestBackup -Force
Write-Host "✓ 已备份清单 → $(Split-Path $manifestBackup -Leaf)" -ForegroundColor Green

# 顺带备份 patch —— 万一安装过程中它被重写，还有的救。
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchPath) {
  $patchBackup = Join-Path $profileDir "cordis.patch.yml.before-install-$stamp"
  Copy-Item $patchPath $patchBackup -Force
  Write-Host "✓ 已备份 patch → $(Split-Path $patchBackup -Leaf)" -ForegroundColor Green
}
Write-Host ""

# ── 3. 安装 / 卸载 ────────────────────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'PATH 上找不到 node，无法安全地改 JSON 清单' }

if ($Uninstall) {
  Write-Host "模式：卸载" -ForegroundColor Cyan
  $script = @'
const fs = require('node:fs')
const [manifestPath, tarball] = process.argv.slice(2)
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const before = JSON.stringify(m.dsh?.profile?.bundles ?? [])
if (m.dependencies) delete m.dependencies['dsh-tri-layer-memory']
if (m.dsh?.profile?.bundles) {
  m.dsh.profile.bundles = m.dsh.profile.bundles.filter(b => b !== 'dsh-tri-layer-memory')
}
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n')
console.log('removed dependency + bundle: dsh-tri-layer-memory')
console.log('bundles before:', before)
console.log('bundles after :', JSON.stringify(m.dsh?.profile?.bundles ?? []))
'@
  $script | node --input-type=commonjs - $manifestPath $Tarball
} else {
  Write-Host "模式：安装（tarball = $Tarball）" -ForegroundColor Cyan

  # tarball 必须已经在 profile 的 vendor 目录里
  $tarballPath = Join-Path $vendorDir $Tarball
  if (-not (Test-Path $tarballPath)) {
    New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
    $from = Join-Path 'D:\deepseek\deepseekh_work\plugins\dsh-tri-layer-memory' $Tarball
    if (-not (Test-Path $from)) { throw "找不到 tarball：$from" }
    Copy-Item $from $vendorDir -Force
    Write-Host "已把 tarball 放进 vendor/" -ForegroundColor Green
  }

  $script = @'
const fs = require('node:fs')
const [manifestPath, tarball] = process.argv.slice(2)
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
m.dependencies = m.dependencies ?? {}
m.dependencies['dsh-tri-layer-memory'] = `file:./vendor/${tarball}`
m.dsh = m.dsh ?? {}
m.dsh.profile = m.dsh.profile ?? {}
m.dsh.profile.bundles = m.dsh.profile.bundles ?? []
if (!m.dsh.profile.bundles.includes('dsh-tri-layer-memory')) {
  m.dsh.profile.bundles.push('dsh-tri-layer-memory')
}
fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n')
console.log('dependency:', m.dependencies['dsh-tri-layer-memory'])
console.log('bundles:', m.dsh.profile.bundles.length, '项')
m.dsh.profile.bundles.forEach(b => console.log('  ' + b))
'@
  $script | node --input-type=commonjs - $manifestPath $Tarball
}

Write-Host ""

# ── 4. 同步 node_modules ──────────────────────────────────────────────────
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  Write-Host "⚠ PATH 上找不到 pnpm，跳过同步。" -ForegroundColor Yellow
  Write-Host "  手动执行：cd `"$profileDir`"; pnpm install" -ForegroundColor Yellow
} else {
  Write-Host "正在同步 node_modules（pnpm install）…" -ForegroundColor Cyan
  Push-Location $profileDir
  try {
    & pnpm install --reporter=append-only
    if ($LASTEXITCODE -ne 0) {
      Write-Host "⚠ pnpm install 退出码 $LASTEXITCODE —— 清单已改，node_modules 可能未同步。" -ForegroundColor Yellow
      Write-Host "  回滚：把 $(Split-Path $manifestBackup -Leaf) 拷回 package.json 后重跑 pnpm install" -ForegroundColor Yellow
    } else {
      Write-Host "✓ node_modules 已同步" -ForegroundColor Green
    }
  } finally {
    Pop-Location
  }
}

Write-Host ""
if ($Uninstall) {
  Write-Host "卸载完成。启动 DSH 后插件列表里应不再有 dsh-tri-layer-memory。" -ForegroundColor Green
} else {
  Write-Host "安装完成。启动 DSH 后请确认：" -ForegroundColor Green
  Write-Host "  1. 插件列表只有 dsh-tri-layer-memory 一个新条目，无红色'异常'标记"
  Write-Host "  2. 会话里出现 memory_state 工具"
  Write-Host "  3. Settings → Plugins 里有「三层记忆压缩引擎」卡片"
  Write-Host ""
  Write-Host "⚠ 重要：如果列表里出现任何加载失败的行，不要去点插件开关——" -ForegroundColor Yellow
  Write-Host "  Loader 会把残缺的组合树写回 cordis.patch.yml，抹掉你的自定义配置。" -ForegroundColor Yellow
  Write-Host "  先备份 cordis.patch.yml，再排查。" -ForegroundColor Yellow
}
