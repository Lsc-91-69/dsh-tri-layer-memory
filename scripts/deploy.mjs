#!/usr/bin/env node
/**
 * deploy.mjs — 把本仓库的构建产物原地部署到已安装的 profile 里。
 *
 * **为什么不用 `dsh plugin add` / 重装 tarball**：
 * 那条路要跑 pnpm、改 package.json、重建 node_modules。历史上它出过三次事故——
 * 跨盘 junction 导致 EPERM、失败安装把 bundle 选中列表截断、以及 profile 被宿主
 * 整体重写（预设与模型配置消失）。
 *
 * 原地换文件绕开了全部三个风险源：不跑 pnpm、不动 manifest、不碰组合树。
 * 换完之后由调用方重新激活一次插件即可——`lib/entry.js` 是薄壳，每次激活都用
 * `?generation=<时间戳>` 重新 import `impl.js`，所以新代码立刻生效，不需要重启进程。
 *
 * **关于 profile 被重写（2026-10-09 查证，勿沿用旧结论）**：
 * 本注释曾经写「`internal/update` → `tree.write()` 把残缺组合树写回
 * `cordis.patch.yml`」——**那是 0.1.5 的架构，在 0.2.0-rc.2 上不成立**。
 * 本版里 `cordis.patch.yml` **不是挂载点**，它是被 `readProfilePatches` 读成补丁层
 * 再 insert 进根 Include 的；`tree.write()` 写的是挂载点自己的文件，即 **`cordis.yml`**。
 *
 * 实测的两个破坏者（都跟本脚本无关，但说明了为什么必须绕开 pnpm 与组合树）：
 *   A. 原生致命错误恢复——`main.js` 的 `disableAllPlugins()` 调 `sanitizeProfile()`，
 *      把 `cordis.patch.yml` 改名移走并把 bundles 整体替换成只有 2 项的
 *      `WEB_PROFILE.bundles`。触发点是「致命错误对话框 + 用户点『禁用全部插件』」。
 *   B. 包操作后的 reconcile——`dsh-plugin-manager` 在 pnpm 退出码 0 后按
 *      `bundleManifest()` 过滤，而它解析失败时**静默返回 undefined**，
 *      于是该 bundle 被**静默剔除**。所以**不要在 profile 上跑 pnpm**。
 * 体检工具：`node scripts/profile-guard.mjs`（只读，`--fix` 显式且幂等）。
 *
 * 用法：
 *   node scripts/deploy.mjs            # 部署到 desktop profile
 *   node scripts/deploy.mjs --profile web
 *   node scripts/deploy.mjs --dry-run  # 只看要做什么，不写
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileIdx = args.indexOf('--profile')
const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'desktop'

/** DSH_HOME 只在 DSH 派生的 shell 里存在，独立运行时要自己推。 */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const fallback = join(homedir(), '.dsh')
  if (!existsSync(fallback)) throw new Error(`找不到 DSH 主目录：${fallback}（可用 DSH_HOME 指定）`)
  return fallback
}

const installed = join(dshHome(), 'profiles', profile, 'node_modules', 'dsh-tri-layer-memory')
if (!existsSync(installed)) {
  throw new Error(`插件未安装到该 profile：${installed}\n请先用插件列表或 dsh plugin add 装一次，之后就能用本脚本原地更新。`)
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

console.log(`源      : ${root}`)
console.log(`目标    : ${installed}`)
console.log(`版本    : ${version}`)
console.log(dryRun ? '模式    : dry-run（不写任何东西）' : '模式    : 部署')
console.log('')

// ── 1. 安全校验：目标必须是真实目录 ────────────────────────────────────────
// 如果它是 link/junction（指向工作区），原地部署会改到源目录本身，语义就错了。
// 用 realpath 比较而不是 Stats.isSymbolicLink()：statSync 会跟随链接，测不出来；
// 而 Windows 的 junction 在不同 Node 版本里报告方式也不一致。
const real = realpathSync(installed)
if (real !== installed) {
  throw new Error(
    `目标是链接，真实路径为 ${real}。\n`
    + '本脚本只用于部署到真实目录（file: tarball 安装出来的那种）；\n'
    + '链接安装请改用插件列表或 dsh plugin add。',
  )
}

// ── 2. 备份现有产物 ───────────────────────────────────────────────────────
const backup = join(installed, `.backup-${stamp}`)
const payload = ['lib', 'cordis.patch.yml', 'package.json']

if (!dryRun) {
  mkdirSync(backup, { recursive: true })
  for (const entry of payload) {
    const src = join(installed, entry)
    if (!existsSync(src)) continue
    if (statSync(src).isDirectory()) {
      mkdirSync(join(backup, entry), { recursive: true })
      for (const f of readdirSync(src)) copyFileSync(join(src, f), join(backup, entry, f))
    } else {
      copyFileSync(src, join(backup, entry))
    }
  }
  console.log(`已备份 → ${backup}`)
}

// ── 3. 覆盖产物 ───────────────────────────────────────────────────────────
let copied = 0
for (const entry of payload) {
  const src = join(root, entry)
  if (!existsSync(src)) continue
  const dest = join(installed, entry)

  if (statSync(src).isDirectory()) {
    if (!dryRun) mkdirSync(dest, { recursive: true })
    for (const f of readdirSync(src)) {
      if (dryRun) { console.log(`  将写入 lib/${f}`); continue }
      copyFileSync(join(src, f), join(dest, f))
      copied += 1
    }
  } else {
    if (dryRun) { console.log(`  将写入 ${entry}`); continue }
    copyFileSync(src, dest)
    copied += 1
  }
}

if (dryRun) {
  console.log('\ndry-run 结束，没有写入任何文件。')
  process.exit(0)
}

console.log(`已写入 ${copied} 个文件`)

// ── 4. 同步 profile 的依赖声明 ────────────────────────────────────────────
//
// **为什么必须有这一步**：profile 的 `package.json` 里 `dependencies` 写着
// `file:<某版本的 .tgz>`。只管覆盖 `lib/` 而不改这一行，就等于留了一个回滚陷阱：
//
//   - 用户之后装/删**任何**插件 → 宿主跑一次 pnpm install
//   - pnpm 按声明把本插件**重新解包成那个旧 tgz** 的版本
//   - 我们刚部署的新代码被整体覆盖，而且**没有任何报错**
//
// 这不是假想：2026-10-23 和 10-27 各发生过一次，两次都表现为「部署成功、几天后
// 发现跑的还是旧版」。那种失败极难查——版本号在 node_modules 里，而人看的是 UI。
//
// 所以部署必须让**声明跟着产物一起走**：把这次版本的 tgz 落到 vendor/，并把声明
// 指向它。这样即使之后跑了 pnpm，装回来的也是这一版。
{
  const { readFileSync: rf, writeFileSync: wf, copyFileSync: cf } = await import('node:fs')
  const profileDir = join(dshHome(), 'profiles', profile)
  const pkgPath = join(profileDir, 'package.json')
  const vendorDir = join(profileDir, 'vendor')
  const tgzName = `dsh-tri-layer-memory-${version}.tgz`
  const tgzSrc = join(root, tgzName)
  const tgzDst = join(vendorDir, tgzName)

  if (!existsSync(tgzSrc)) {
    console.log('')
    console.log(`⚠ vendor 里没有 ${tgzName}（先跑 npm pack）。`)
    console.log('  依赖声明**未同步** —— 之后若跑 pnpm install，插件会被换回声明里的旧版本。')
  } else {
    mkdirSync(vendorDir, { recursive: true })
    cf(tgzSrc, tgzDst)
    const pkg = JSON.parse(rf(pkgPath, 'utf8'))
    pkg.dependencies = pkg.dependencies ?? {}
    const before = pkg.dependencies['dsh-tri-layer-memory']
    const spec = `file:${tgzDst.replace(/\\/g, '/')}`
    if (before === spec) {
      console.log(`依赖声明已是 v${version}，未改动`)
    } else {
      pkg.dependencies['dsh-tri-layer-memory'] = spec
      wf(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
      console.log(`依赖声明已同步 → v${version}`)
      if (before !== undefined) console.log(`  （原为 ${String(before).split('/').pop()}）`)
      console.log('  注意：pnpm-lock.yaml 仍是旧的；下次 pnpm install 会按新声明重装，属预期。')
    }
  }
}

console.log('')
console.log('下一步：重新激活插件，让薄壳用新的 ?generation= 重新 import impl.js。')
console.log('  宿主半边会立刻换新；客户端半边（思维栏）需要刷新页面重新 materialize。')
console.log('')
console.log(`回滚：把 ${backup} 里的内容拷回 ${installed}，再重新激活一次。`)
