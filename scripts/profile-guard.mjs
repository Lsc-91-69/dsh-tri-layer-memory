#!/usr/bin/env node
/**
 * profile-guard.mjs — 宿主「静默重写 profile」故障的**只读自检 + 显式恢复**。
 *
 * 背景（源码级结论，见 feasibility/run020/*.js，即运行版 0.2.0-rc.2 的 app.asar 产物）：
 *
 *   1. 原生致命错误恢复会把 profile 打回出厂状态。
 *      app.asar `lib/main.js:3465-3466`
 *        disableAllPlugins() → sanitizeProfile("dsh", profile, WEB_PROFILE.bundles)
 *      `sanitizeProfile`（dsh-app-boot/lib/index.js:1139-1154）做两件破坏性的事：
 *        · renameSync(cordis.patch.yml → cordis.patch.yml.bak-<unix ms>)   ← 用户补丁层被移走
 *        · writeProfileBundles(..., WEB_PROFILE.bundles)                     ← bundles 被覆写
 *      WEB_PROFILE.bundles 只有 ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"] 两项
 *      （main.js:3432 + app-boot PROFILE_TEMPLATES.web）。
 *      触发者是致命错误对话框里的「禁用全部插件」按钮（main.js:10973-10979），
 *      而致命错误最常见的来源是 `web boot: N entry did not activate`。
 *      每次触发前都会在 %APPDATA%\@deepseek-ai\dsh-desktop\logs\ 留下 crash-*.log。
 *
 *   2. 包操作后的 reconcile 会静默丢掉 bundle。
 *      dsh-plugin-manager/lib/index.js:238-266 `reconcile()`：
 *        bundles = previous.filter(名字 => 不在 dependencies 里 || bundleManifest(...) !== undefined)
 *      `bundleManifest` 解析失败（包暂时不可读、link 目标不在、manifest 缺 dsh.bundle）
 *      时该名字被**静默剔除**，不报错、不提示。只在「pnpm 安装成功且
 *      options.activateNewBundles !== false」时运行（index.js:669）。
 *      注意：插件管理器的 set_bundle 本身（index.js:1979-2005 `selectBundle`）
 *      是纯追加/过滤，不会重排，也不会动 cordis.patch.yml。
 *
 *   3. cordis.patch.yml 的三个写入者都**保留整份文档**（不会只写内存树）：
 *        · dsh-plugin-manager  writePluginEnabled  (index.js:881-916)
 *        · dsh-config-editor    edit()             (lib/index.js:69-135)
 *        · cordis-plugin-include Include.write()   (src/index.ts:337-340)
 *      所以「内存树残缺 → 落盘」这类事故，在 0.2.0-rc.2 里只可能打到
 *      **cordis.yml**（profile 根配置，Include 挂载点，app-boot
 *      lib/index.js:3704-3713 + loader-tree.ts:82-87 的 create→tree.write()），
 *      不会打到 cordis.patch.yml。cordis.yml 被写成 197 项的组合树就是这条路径的指纹。
 *
 * 本脚本**只读宿主文件**，唯一的写操作是：
 *   · 自己的报告（默认 <脚本目录>/../.profile-guard/）
 *   · 仅在显式给出 --fix 时，用 writeProfileBundles 同样的语义**只补不删**地补回缺失 bundle
 *     （补之前先 copy 一份 .before-guard-<ts> 备份）
 *
 * 用法：
 *   node scripts/profile-guard.mjs                    # 只检查，打印结论 + 写报告
 *   node scripts/profile-guard.mjs --json             # 只输出 JSON 报告
 *   node scripts/profile-guard.mjs --fix --dry-run    # 看会补什么，不写
 *   node scripts/profile-guard.mjs --fix              # 幂等补回缺失 bundle（只增不减）
 *   node scripts/profile-guard.mjs --profile web
 *   node scripts/profile-guard.mjs --no-report        # 不写报告文件
 *
 * 退出码：0 = 无问题；1 = 发现问题（--fix 修好后仍返回 0）；2 = 用法/环境错误。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const dryRun = has('--dry-run')
const doFix = has('--fix')
const jsonOnly = has('--json')
const writeReport = !has('--no-report')
const profileName = valueOf('--profile', 'desktop')

const scriptDir = dirname(fileURLToPath(import.meta.url))
const reportDir = valueOf('--report-dir', join(scriptDir, '..', '.profile-guard'))

// ── 期望值 ──────────────────────────────────────────────────────────────────
/** 宿主恢复会打回的出厂 bundle 集合（main.js:3432 / PROFILE_TEMPLATES.web）。 */
const HOST_RECOVERY_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * 用户应该有的 bundle（顺序敏感）。这是「补齐」的基准，**不用于删除**。
 * 与 restore-bundles.mjs 的 canonical 保持一致。
 */
const EXPECTED_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-schedule-bundle',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@smalltailqwq/dsh-client-ui-skin-deep-whale-manager',
  'dsh-meme',
  '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
  'dsh-live2d-avatar',
  'dsh-tri-layer-memory',
]

/** 用户补丁层里「丢了就等于新会话没有预设 / 模型配置」的 id。 */
const CRITICAL_PATCH_IDS = [
  'agent-preset-registry',
  'agent-default-model',
]

// ── 工具 ────────────────────────────────────────────────────────────────────
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

const profileDir = valueOf('--profile-dir', join(dshHome(), 'profiles', profileName))

function readText(p) {
  try { return readFileSync(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return undefined; throw e }
}

/**
 * 安装锚的 package.json 在 app.asar **里面**，Node 的 fs 看不见它。
 * 这里按 asar 格式（8 字节头 + JSON 目录表 + 数据区）直接读条目，
 * 免得把「安装自带的 bundle」误报成解析失败。
 */
function readAsarEntry(asarPath, entryPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    const headerBuf = Buffer.alloc(headerSize)
    readSync(fd, headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8'))
    const dataOffset = 16 + headerSize

    let node = header
    for (const part of entryPath.split('/')) {
      node = node.files?.[part]
      if (node === undefined) {
        if (process.env.PROFILE_GUARD_DEBUG) console.log(`  [asar] miss at "${part}" of "${entryPath}"`)
        return undefined
      }
    }
    if (node.files !== undefined || node.offset === undefined) {
      if (process.env.PROFILE_GUARD_DEBUG) console.log(`  [asar] not a file: "${entryPath}"`)
      return undefined
    }
    const buf = Buffer.alloc(node.size)
    readSync(fd, buf, 0, node.size, dataOffset + Number(node.offset))
    return buf
  } catch (e) {
    if (process.env.PROFILE_GUARD_DEBUG) console.log(`  [asar] error for "${entryPath}": ${e.message}`)
    return undefined
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 只读句柄，关不掉也不影响结论 */ }
  }
}

/** 从 asar 里读 package.json，取 `dsh` 字段（安装锚只用来判定 dsh.bundle 是否存在）。 */
function readAsarManifest(asarPath, packageName) {
  const buf = readAsarEntry(asarPath, `${packageName}/package.json`)
  if (buf === undefined) return undefined
  try { return JSON.parse(buf.toString('utf8')) } catch { return undefined }
}

/**
 * 复刻宿主 resolveBundleDir 的两段解析顺序（app-boot lib/index.js:901-908）：
 *   1. 安装锚（dsh 安装自带的 bundle，例如 @deepseek-ai/dsh-base）
 *   2. profile 自己的 package.json 所在目录
 * 只在两处都解析不到时才算真问题 —— 安装自带的 bundle 本来就不在 profile 的
 * dependencies 里，那不是异常。
 */
function resolveBundleDir(packageName, anchors) {
  for (const anchor of anchors) {
    if (anchor === undefined) continue
    // asar 内的安装锚：走 asar 读取
    const asarIdx = anchor.toLowerCase().indexOf('.asar')
    if (asarIdx >= 0) {
      const asarPath = anchor.slice(0, asarIdx + 5)
      // Windows 路径里的分隔符是 `\`，asar 目录表用 `/`，先归一化。
      // 注意：anchor 是 **package.json 文件**，必须先退到它所在目录（与宿主
      // packageDirFromAnchor 的语义一致），否则会拼出 `dsh/package.json/node_modules/...`。
      const anchorDir = dirname(anchor).replace(/\\/g, '/')
      const inner = anchorDir.slice(asarIdx + 6).replace(/^[/\\]+/, '').replace(/\\/g, '/')
      const dir = inner === '' ? '' : `${inner}/`
      if (process.env.PROFILE_GUARD_DEBUG) console.log(`  [asar] try ${asarPath} :: ${dir}node_modules/${packageName}/package.json`)
      if (readAsarEntry(asarPath, `${dir}node_modules/${packageName}/package.json`) !== undefined) {
        return { kind: 'asar', asarPath, inner: `${dir}node_modules/${packageName}` }
      }
      continue
    }
    const dir = join(dirname(anchor), 'node_modules', ...packageName.split('/'))
    if (existsSync(join(dir, 'package.json'))) return { kind: 'fs', dir }
  }
  return undefined
}

/** 读一个已解析到的包的 manifest；失败返回 undefined（对应宿主 bundleManifest 的 catch 分支）。 */
function optionalManifest(resolved) {
  if (resolved === undefined) return undefined
  if (resolved.kind === 'asar') return readAsarManifest(resolved.asarPath, `${resolved.inner.replace(/^\/+/, '')}`)
  return optionalManifestFromDir(resolved.dir)
}

function optionalManifestFromDir(dir) {
  if (dir === undefined) return undefined
  const text = readText(join(dir, 'package.json'))
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function fmtTime(ms) {
  if (ms === undefined) return undefined
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/**
 * 极小的 YAML 顶层序列扫描：只取每个 `- id:` 行，够用于「关键行是否还在」。
 * 不做完整 YAML 解析（不装依赖），因此**只报告、不据此改写**。
 */
function scanPatchIds(text) {
  const ids = []
  const re = /^\s*-\s*id:\s*(.+?)\s*$/gm
  let m
  while ((m = re.exec(text)) !== null) ids.push(m[1].replace(/^['"]|['"]$/g, ''))
  return ids
}

// ── 检查 ────────────────────────────────────────────────────────────────────
const findings = []
const add = (level, code, message, detail) => findings.push({ level, code, message, ...(detail === undefined ? {} : { detail }) })

const manifestPath = join(profileDir, 'package.json')
const patchPath = join(profileDir, 'cordis.patch.yml')
const rootPath = join(profileDir, 'cordis.yml')

if (!existsSync(profileDir)) {
  console.error(`找不到 profile 目录：${profileDir}`)
  process.exit(2)
}

const report = {
  generatedAt: new Date().toISOString(),
  profileDir,
  dryRun,
  fix: doFix,
  checks: {},
  findings,
  fixResult: undefined,
}

// 1) package.json / bundles
let manifest
const manifestText = readText(manifestPath)
if (manifestText === undefined) {
  add('error', 'manifest-missing', 'profile 的 package.json 不存在')
} else {
  try {
    manifest = JSON.parse(manifestText)
  } catch (e) {
    add('error', 'manifest-unparsable', `package.json 不是合法 JSON：${e.message}`)
  }
}

let bundles = []
if (manifest !== undefined) {
  bundles = manifest.dsh?.profile?.bundles ?? []
  report.checks.bundles = { count: bundles.length, list: bundles }

  if (bundles.length === 0) add('error', 'bundles-empty', 'dsh.profile.bundles 为空 —— 所有 bundle 层都不会加载')

  const exactHostRecovery = bundles.length === HOST_RECOVERY_BUNDLES.length
    && bundles.every((n, i) => n === HOST_RECOVERY_BUNDLES[i])
  if (exactHostRecovery) {
    add('error', 'bundles-host-recovery-signature',
      'bundles 恰好等于宿主的出厂恢复集合 —— 这是「致命错误恢复点了禁用全部插件」的指纹',
      { expected: HOST_RECOVERY_BUNDLES })
  }

  const missing = EXPECTED_BUNDLES.filter((n) => !bundles.includes(n))
  if (missing.length > 0) {
    add('warn', 'bundles-missing', `bundles 缺少 ${missing.length} 项`, { missing })
  }

  // 宿主 resolveBundleDir 的两段解析顺序（安装锚 → profile 目录）。
  // 只有两处都解析不到、或解析到却没有 dsh.bundle，才是真问题。
  const installAnchor = join(process.env.DSH_INSTALL_DIR ?? 'D:\\deepseek\\deepseek_win\\resources\\app.asar\\dsh', 'package.json')
  const anchors = [installAnchor, manifestPath]
  const unresolved = []
  const notABundle = []
  for (const name of bundles) {
    const resolved = resolveBundleDir(name, anchors)
    if (has('--debug')) console.log(`  [debug] ${name} -> ${resolved === undefined ? 'UNRESOLVED' : JSON.stringify(resolved)}`)
    if (resolved === undefined) { unresolved.push(name); continue }
    const meta = optionalManifest(resolved)
    if (has('--debug')) console.log(`  [debug]   manifest=${meta === undefined ? 'undefined' : `dsh.bundle=${JSON.stringify(meta.dsh?.bundle)}`}`)
    if (meta === undefined) { unresolved.push(name); continue }
    if (meta.dsh?.bundle === undefined) notABundle.push(name)
  }
  report.checks.bundleResolution = { installAnchor, unresolved, notABundle }

  if (unresolved.length > 0) {
    add('error', 'bundle-unresolvable',
      '这些 bundle 在安装锚与 profile 两处都解析不到 —— 宿主加载时会**静默跳过**（loadProfileDirectory 的 catch 分支），'
      + '而插件管理器的 reconcile 会把它从 bundles 里直接删掉', { unresolved })
  }
  if (notABundle.length > 0) {
    add('warn', 'bundle-declares-no-dsh-bundle',
      '这些 bundle 的 manifest 里没有 dsh.bundle —— 宿主加载会跳过，reconcile 也会删掉', { notABundle })
  }
}

// 2) cordis.patch.yml
const patchText = readText(patchPath)
if (patchText === undefined) {
  add('error', 'patch-missing', 'cordis.patch.yml 不存在 —— 用户补丁层已丢（宿主恢复会把它改名成 .bak-<ms>）')
} else {
  const ids = scanPatchIds(patchText)
  report.checks.patch = { bytes: Buffer.byteLength(patchText, 'utf8'), lines: patchText.split('\n').length, ids }

  const lost = CRITICAL_PATCH_IDS.filter((id) => !ids.includes(id))
  if (lost.length > 0) {
    add('error', 'patch-critical-ids-missing',
      `用户补丁层缺少关键条目（新会话会没有预设/模型配置）：${lost.join(', ')}`, { lost })
  }

  // 出厂模板指纹：只有注释头 + 空序列
  const stripped = patchText.replace(/^\s*#.*$/gm, '').trim()
  if (stripped === '[]' || stripped === '') {
    add('error', 'patch-is-empty-template',
      'cordis.patch.yml 是出厂空模板（宿主恢复删掉旧文件后由 initProfile 重建的形态）')
  }
}

// 3) cordis.yml —— 组合树回写指纹
const rootText = readText(rootPath)
if (rootText === undefined) {
  add('warn', 'root-config-missing', 'cordis.yml 不存在（宿主启动时会创建）')
} else {
  const topIds = (rootText.match(/^-\s+id:/gm) ?? []).length
  let rootMtime
  try { rootMtime = statSync(rootPath).mtimeMs } catch { /* 忽略：仅用于报告 */ }
  report.checks.rootConfig = { bytes: Buffer.byteLength(rootText, 'utf8'), topLevelIds: topIds, mtime: fmtTime(rootMtime) }

  // 出厂模板是「一个空序列 + 说明注释」。被写成组合树后条目数会远超 1。
  if (topIds > 5) {
    add('warn', 'root-config-holds-composed-tree',
      `cordis.yml 里已有 ${topIds} 条顶层条目 —— 宿主在启动时把**组合后的**内存树回写进了 profile 根配置`
      + '（Include.write → _writeFile）。这条路径是「内存树残缺就落盘」的唯一入口：'
      + '启动时若有 bundle 加载失败，回写下来的树就是残缺的。',
      { topLevelIds: topIds, mtime: fmtTime(rootMtime) })
  }
}

// 4) 宿主恢复 / 崩溃前兆
// 先看锁：DesktopProjectManager.withLock（main.js:3479-3513）在动 profile 前会用
// openSync(lock, 'wx') 独占创建 <profile>/lock 并写入自己的 pid，操作完 unlink。
// 这个文件存在 = **此刻有宿主进程正在写 profile**，是唯一能提前观察到的信号。
const lockPath = join(profileDir, 'lock')
if (existsSync(lockPath)) {
  const pidText = (readText(lockPath) ?? '').trim()
  const pid = Number.parseInt(pidText, 10)
  let alive = false
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true } catch (e) { alive = e.code !== 'ESRCH' }
  }
  report.checks.profileLock = { present: true, pid: Number.isSafeInteger(pid) ? pid : pidText, alive }
  add(alive ? 'warn' : 'info', 'profile-lock-present',
    alive
      ? `profile 锁存在且持有者 pid ${pid} 仍活着 —— 有宿主进程正在执行 profile 写操作（恢复或包操作），此刻不要动这些文件`
      : `profile 锁残留（pid ${pidText}，进程已不在）—— 上一次写操作可能被中断`,
    { pid, alive })
} else {
  report.checks.profileLock = { present: false }
}

const logDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop', 'logs')
const crashes = []
if (existsSync(logDir)) {
  for (const name of readdirSync(logDir)) {
    if (!name.startsWith('crash-') || !name.endsWith('.log')) continue
    const full = join(logDir, name)
    let st
    try { st = statSync(full) } catch { continue }
    const text = readText(full) ?? ''
    crashes.push({
      file: name,
      mtime: st.mtimeMs,
      time: fmtTime(st.mtimeMs),
      source: (/^source:\s*(.+)$/m.exec(text)?.[1] ?? '').trim(),
      firstError: (/^--- error ---\n([^\n]+)/m.exec(text)?.[1] ?? '').trim(),
    })
  }
  crashes.sort((a, b) => b.mtime - a.mtime)
}
report.checks.crashReports = { dir: logDir, count: crashes.length, recent: crashes.slice(0, 5) }

// 最近的宿主恢复指纹：.bak-<unix ms> 文件
const hostBackups = []
if (existsSync(profileDir)) {
  for (const name of readdirSync(profileDir)) {
    const m = /^cordis\.patch\.yml\.bak-(\d{10,16})(?:-\d+)?$/.exec(name)
    if (!m) continue
    let st
    try { st = statSync(join(profileDir, name)) } catch { continue }
    hostBackups.push({ name, size: st.size, hostTime: fmtTime(Number(m[1])), mtime: fmtTime(st.mtimeMs) })
  }
  hostBackups.sort((a, b) => String(b.hostTime).localeCompare(String(a.hostTime)))
}
report.checks.hostRecoveryBackups = { count: hostBackups.length, recent: hostBackups.slice(0, 5) }

if (hostBackups.length > 0) {
  const latest = hostBackups[0]
  add('info', 'host-recovery-happened-before',
    `profile 里存在 ${hostBackups.length} 个宿主恢复备份（最近：${latest.hostTime}，${latest.size} B）。`
    + '这些是 sanitizeProfile 的 renameSync 产物 —— 每次出现都意味着 bundles 曾被覆写成出厂 2 项。')
}

if (crashes.length > 0) {
  const c = crashes[0]
  add('info', 'crash-reports-present',
    `崩溃报告 ${crashes.length} 份，最近一份 ${c.time}（source=${c.source}）。`
    + '致命错误对话框出现后点「禁用全部插件」就是恢复动作本身。',
    { recent: crashes.slice(0, 3) })
}

// ── 恢复（显式、幂等、只增不减） ─────────────────────────────────────────────
const missingBundles = manifest === undefined
  ? []
  : EXPECTED_BUNDLES.filter((n) => !bundles.includes(n) && n in (manifest.dependencies ?? {}))

if (doFix && manifest !== undefined && missingBundles.length > 0) {
  const merged = []
  for (const name of EXPECTED_BUNDLES) if (bundles.includes(name) || missingBundles.includes(name)) merged.push(name)
  for (const name of bundles) if (!merged.includes(name)) merged.push(name)

  report.fixResult = { missing: missingBundles, from: bundles.length, to: merged.length, wrote: false, backup: undefined }

  if (dryRun) {
    report.fixResult.wrote = false
  } else {
    const backup = `${manifestPath}.before-guard-${Date.now()}`
    copyFileSync(manifestPath, backup)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: merged } }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    report.fixResult.wrote = true
    report.fixResult.backup = backup
    // 修完就重判：补回缺失项后，把对应的 bundles-missing 结论降级
    for (const f of findings) if (f.code === 'bundles-missing') f.level = 'info'
  }
} else if (doFix && missingBundles.length === 0 && manifest !== undefined) {
  report.fixResult = { missing: [], from: bundles.length, to: bundles.length, wrote: false, note: '无需补齐' }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const errors = findings.filter((f) => f.level === 'error')
const warns = findings.filter((f) => f.level === 'warn')
const infos = findings.filter((f) => f.level === 'info')
const ok = errors.length === 0

if (writeReport) {
  try {
    mkdirSync(reportDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(reportDir, `guard-${stamp}.json`), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(reportDir, 'latest.json'), JSON.stringify(report, null, 2) + '\n')
  } catch (e) {
    console.error(`（报告写入失败：${e.message}）`)
  }
}

if (jsonOnly) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  console.log(`profile : ${profileDir}`)
  console.log(`bundle  : ${bundles.length} 项`)
  console.log(`patch   : ${report.checks.patch ? `${report.checks.patch.lines} 行 / ${report.checks.patch.bytes} B` : '缺失'}`)
  console.log(`cordis.yml: ${report.checks.rootConfig ? `${report.checks.rootConfig.topLevelIds} 条顶层条目` : '缺失'}`)
  console.log('')
  for (const f of [...errors, ...warns, ...infos]) {
    const tag = f.level === 'error' ? '✗ ERROR' : f.level === 'warn' ? '! WARN ' : '· INFO '
    console.log(`${tag} [${f.code}] ${f.message}`)
    if (f.detail !== undefined) console.log(`         ${JSON.stringify(f.detail)}`)
  }
  console.log('')
  if (report.fixResult !== undefined) {
    console.log(dryRun
      ? `--fix --dry-run：将补回 ${report.fixResult.missing.length} 项 → ${report.fixResult.to} 项（未写盘）`
      : report.fixResult.wrote
        ? `--fix：已补回 ${report.fixResult.missing.length} 项 → ${report.fixResult.to} 项，备份 ${report.fixResult.backup}`
        : `--fix：${report.fixResult.note ?? '无需改动'}`)
  }
  console.log(ok ? '结论：未发现宿主重写痕迹。' : `结论：发现 ${errors.length} 个问题、${warns.length} 个警告。`)
  if (!ok && !doFix) console.log('（要补回缺失 bundle：node scripts/profile-guard.mjs --fix --dry-run 先看，再去掉 --dry-run）')
  if (writeReport) console.log(`报告：${join(reportDir, 'latest.json')}`)
}

process.exit(ok ? 0 : 1)
