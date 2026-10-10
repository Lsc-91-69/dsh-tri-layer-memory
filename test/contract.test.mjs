/**
 * test/contract.test.mjs — dsh-tri-layer-memory 的静态组装契约测试。
 *
 * 无外部依赖，`node --test` 直接运行。这里固化的每一条都对应一个真实的
 * 失败模式（括号里是它曾经/可能造成的后果）：
 *
 * 1. bundle 声明与 patch 文件（缺了 → 装了包但不激活任何层）。
 * 2. patch 里每个行 name 必须能在 dependencies 里解析（否则 loader 报
 *    "Cannot find package"）。
 * 3. 自包含：本 patch **不覆盖 compaction-basic**（默认引擎由宿主决定，插件不抢
 *    那个槽位），且整个 patch 只有本插件一行（多一行就多一个可能报
 *    incompatible-version 的第三方包）。
 * 4. 客户端半边：`dsh.client` 必须有 `exports["./client"]`（否则模块扫描抛错）；
 *    ModuleLoader 的 id 必须等于包名；inject 必须是**服务名**而不是包名。
 * 5. 构建产物随仓库提交（GitHub 安装者不跑构建）。
 * 6. 配置键必须是扁平顶层标量（嵌套键在设置面板里 `set(field, value)` 写不进去）。
 * 7. patch 里不得出现硬编码的绝对路径（换台机器就起不来）。
 * 8. 不得引用任何 preset id（一旦引用就绑定了特定预设，破坏"全局生效"）。
 * 9. 不得使用不存在的 `installSettingsSection`（真实 API 是 ctx.settings.installSection）。
 * 10. 客户端半边不得 require `@deepseek-ai/dsh-client-runtime`（该包不存在）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
let checks = 0
const ok = (name) => { checks += 1; console.log(`PASS  ${name}`) }
const bad = (name, detail) => { checks += 1; failures.push(`${name}: ${detail}`); console.error(`FAIL  ${name}: ${detail}`) }
const expect = (cond, name, detail) => { if (cond) ok(name); else bad(name, detail) }

const read = (rel) => readFileSync(join(root, rel), 'utf8')

// ── 1. bundle 声明 ───────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'))
expect(pkg.name === 'dsh-tri-layer-memory', '包名正确', `实际 ${pkg.name}`)
expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch → ./cordis.patch.yml', '缺失或指向别的文件')
expect(existsSync(join(root, pkg.dsh?.bundle?.patch ?? 'nope')), 'cordis.patch.yml 存在', '文件缺失')

// ── 2. 客户端声明（dsh.client 必须配 exports["./client"]）────────────────
expect(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web', '缺失或不是 web')
const clientExport = pkg.exports?.['./client']
expect(typeof clientExport === 'string', 'exports["./client"] 存在', 'dsh.client 声明了但无 ./client 导出 → 模块扫描会抛错')
expect(clientExport === './lib/client.js', 'exports["./client"] → ./lib/client.js', `实际 ${String(clientExport)}`)

// ── 3. patch 行可解析 ────────────────────────────────────────────────────
const patchText = read('cordis.patch.yml')
const rows = [...patchText.matchAll(/^\s*-\s*id:\s*([\w.-]+)\s*\n\s*name:\s*['"]?([^'"\n\s]+)/gm)]
  .map((m) => ({ id: m[1], name: m[2] }))
expect(rows.length > 0, 'patch 解析出行定义', '未匹配到任何 - id/name 行')

const baseName = (spec) => {
  const parts = spec.split('/')
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}
const resolvable = new Set([pkg.name, ...Object.keys(pkg.dependencies ?? {})])
for (const row of rows) {
  const base = baseName(row.name)
  expect(resolvable.has(base), `行可解析: ${row.id} → ${row.name}`,
    `${base} 不在 dependencies 中（hoisted linker 下 loader 解析不到）`)
}

// ── 4. 自包含：只有本插件一行，不随附任何第三方组件 ──────────────────────
// 本 patch 不得动 compaction-basic：它是宿主自带、必然可解析的引擎，
// 由它承担 surface 级压缩，插件不该抢这个槽位。
expect(!/^\s*- id: compaction-basic\s*$/m.test(patchText),
  '本 patch 不覆盖 compaction-basic',
  'patch 里出现了 compaction-basic 行；默认引擎应由宿主决定，插件不该抢这个槽位')

// 整个 bundle 只有一行——就是本插件自己。这是"一个开关即用"的实现基础：
// 多一行就多一个可能因 peer 版本不匹配而报 incompatible-version 的第三方包。
expect(rows.length === 1 && rows[0].id === 'dsh-tri-layer-memory',
  'patch 只插入本插件一行（自包含）',
  `实际插入 ${rows.length} 行：${rows.map((r) => `${r.id}→${r.name}`).join(', ')}。`
  + '随附第三方包会让插件列表冒出额外条目，并可能因版本不兼容出现红标')

// dependencies 里只能有真正需要的运行时包（当前只有 schemastery，它不声明 bundle patch，
// 因此不会在插件列表里出现）。任何 `dsh-*` / `@wanyantiande/*` 都属于"随附第三方组件"。
const thirdPartyDeps = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => name.startsWith('dsh-') || name.startsWith('@wanyantiande/'),
)
expect(thirdPartyDeps.length === 0,
  'dependencies 不含第三方 DSH 插件',
  `发现 ${JSON.stringify(thirdPartyDeps)}；这些会在用户插件列表里变成可开关的条目，`
  + '并可能因 peer 范围与宿主版本不匹配而显示 incompatible-version')

// 与 DSH 0.2.0-rc.2 不兼容的三个包尤其不能回来。
for (const name of ['dsh-compaction-instant', 'dsh-memory-vault', 'dsh-mcp-lens']) {
  expect(!(name in (pkg.dependencies ?? {})), `不依赖不兼容的 ${name}`, '该包与当前 DSH 版本不兼容，装进去会在插件列表里报错')
  expect(!rows.some((r) => baseName(r.name) === name), `不插入 ${name} 的行`, '移除了依赖却仍插入行，loader 会解析失败')
}

// ── 5. 客户端半边契约 ────────────────────────────────────────────────────
const client = read('src/client.js')
expect(client.includes(`id: "dsh-tri-layer-memory"`), 'client 注册 id 与包名一致', 'ModuleLoader.load 的 id 不等于包名')
expect(client.includes('window.__ModuleLoader__.load'),
  'client 走 __ModuleLoader__.load 协议', '未使用模块加载协议，浏览器半边不会被 materialize')
expect(/exports\.apply\s*=/.test(client) && /exports\.inject\s*=/.test(client),
  'client 导出 apply 与 inject', '缺少 apply/inject 导出')
// 只匹配真实的 require 调用——注释里提到这个名字是刻意的提醒，不算违规。
const badRequires = [...client.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)]
  .map((m) => m[1])
  .filter((spec) => spec.startsWith('@deepseek-ai/dsh-client-runtime'))
expect(badRequires.length === 0,
  'client 未 require 不存在的 @deepseek-ai/dsh-client-runtime',
  `该包不存在，require 会在 materialize 时抛错；应使用 @deepseek-ai/dsh-client-store（实际 ${JSON.stringify(badRequires)}）`)

const injectMatch = /var inject\s*=\s*\[([^\]]*)\]/.exec(client)
const injectNames = injectMatch === null ? [] : injectMatch[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
expect(injectNames.includes('slots') && injectNames.includes('locale'),
  'client inject 声明 slots + locale', `实际 ${JSON.stringify(injectNames)}`)
// settingsScope 必须在软等待之列，不能是硬依赖——它是本次真实事故的直接原因。
expect(!injectNames.includes('settingsScope'),
  'client 不把 settingsScope 当硬依赖（改用 ctx.inject 软等待）',
  '硬依赖缺席会让插件 fiber 永远 pending，宿主判"有条目未激活"并拒绝启动整个应用')
expect(/ctx\.inject\(\s*\[["']settingsScope["']\]/.test(client),
  'client 用 ctx.inject([settingsScope], …) 软等待设置服务',
  '未找到软等待调用；卡片注册缺少可降级的获取途径')
expect(injectNames.every((n) => !n.includes('@')),
  'client inject 是 Cordis 服务名而非包名', `混入了包名：${JSON.stringify(injectNames.filter((n) => n.includes('@')))}`)

// 卡片 key 必须等于宿主注册的 settings namespace，否则卡片永远不渲染。
const nsMatch = /var NS\s*=\s*"([^"]+)"/.exec(client)
expect(nsMatch?.[1] === 'tri-layer-memory',
  'client 的 settings namespace 与包名/宿主一致', `client NS=${String(nsMatch?.[1])}`)
expect(client.includes('"settings.plugin.item"'),
  'client 注册到 settings.plugin.item 槽位', '未注册设置卡片槽位')

// ── 6. 宿主侧 API 正确性 ─────────────────────────────────────────────────
const indexTs = read('src/host/index.ts')
expect(!indexTs.includes('installSettingsSection'),
  '未使用不存在的 installSettingsSection',
  '该函数在 @deepseek-ai/dsh-settings 中不存在；真实 API 是 ctx.settings.installSection')
expect(indexTs.includes('installSection'),
  '使用真实的 ctx.settings.installSection', '未调用设置安装 API，面板拿不到命名空间')
expect(indexTs.includes("inject(['settings']"),
  'settings 以反应式 ctx.inject 安装', 'settings 服务缺席时面板会静默失效')

// ── 7. 配置键必须扁平（面板 set(field,value) 只认顶层标量）───────────────
const coreTs = read('src/host/config-core.ts')
const patchConfig = /- id: dsh-tri-layer-memory[\s\S]*?config:\n([\s\S]*?)\n\n/.exec(patchText)
const configKeys = patchConfig === null
  ? []
  : [...patchConfig[1].matchAll(/^\s{8}([A-Za-z][\w]*):/gm)].map((m) => m[1])
expect(configKeys.length > 0, '本插件行带 config 块', '未解析到 config 键')
for (const key of configKeys) {
  expect(new RegExp(`^\\s{2}${key}:`, 'm').test(coreTs),
    `config 键 ${key} 在 TriLayerConfig 中声明`,
    'patch 里的键与 config-core.ts 的扁平键不一致')
}

// ── 8. 无硬编码绝对路径 ──────────────────────────────────────────────────
const absPathHits = [...patchText.matchAll(/^\s*[-\w]+:\s*['"]?[A-Za-z]:[\\/]/gm)].map((m) => m[0].trim())
expect(absPathHits.length === 0,
  'patch 中无硬编码的盘符绝对路径',
  `发现 ${JSON.stringify(absPathHits)}；路径必须经 dshHomePath() 或留空由插件推导`)
// 若某行声明了落盘路径类配置键，必须经 loader 的 dshHomePath() 解析到 $DSH_HOME。
// 当前随附的行都不需要落盘（本插件自己的 l3Dir 留空，由 defaultStorageDir 在运行时
// 推导），因此这条是条件式断言：一旦有人加回带路径的行，它立刻生效。
const pathKeys = [...patchText.matchAll(/^\s*(cachePath|root|dir|storagePath)\s*:/gm)].map((m) => m[1])
if (pathKeys.length > 0) {
  expect(patchText.includes('dshHomePath('),
    `带路径配置的行（${pathKeys.join(', ')}）使用 dshHomePath()`,
    '写死路径换台机器就起不来；应改用 !!js dshHomePath(...)')
} else {
  expect(true, 'patch 中无需落盘路径的行（条件式检查已就绪）', '')
}

// ── 9. 不绑定任何预设 ────────────────────────────────────────────────────
const presetScanTargets = ['src/host/index.ts', 'src/host/integration.ts', 'src/host/config-core.ts']
const presetHits = []
for (const rel of presetScanTargets) {
  const text = read(rel)
  for (const preset of ['standard', 'ptc', 'minimal', 'cordis']) {
    // 只看是否把预设名当作配置/分支条件使用。
    if (new RegExp(`preset[\\w]*\\s*===\\s*['"]${preset}['"]|presetId\\s*===\\s*['"]${preset}['"]`).test(text)) {
      presetHits.push(`${rel}:${preset}`)
    }
  }
}
expect(presetHits.length === 0,
  '宿主源码不按预设 id 分支（全局生效）',
  `发现预设绑定：${presetHits.join(', ')}`)

// ── 10. 构建产物随仓库提交 ───────────────────────────────────────────────
expect(existsSync(join(root, 'lib/entry.js')), 'lib/entry.js 已提交', 'GitHub 安装者不跑构建，产物必须在仓库里')
expect(existsSync(join(root, 'lib/impl.js')), 'lib/impl.js 已提交', '实现产物缺失')
expect(existsSync(join(root, 'lib/client.js')), 'lib/client.js 已提交', '客户端半边产物缺失')
expect(pkg.main === './lib/entry.js' && pkg.exports?.['.'] === './lib/entry.js',
  'package.json 入口指向 lib/entry.js',
  '入口文件名必须与产物一致；换名字也是为了让 Node 的 ESM 缓存看到一个新 URL')
if (existsSync(join(root, 'lib/entry.js'))) {
  // 入口是薄壳：必须用带时间戳的动态 import 加载 impl.js，否则改完实现
  // 重载插件时会继续跑 ESM 缓存里的旧世代（症状：报错一字不变）。
  const entry = read('lib/entry.js')
  expect(/new URL\(['"]\.\/impl\.js['"],\s*import\.meta\.url\)/.test(entry),
    'lib/entry.js 是薄壳（动态 import ./impl.js）', '入口未使用薄壳模式，实现改动会被 ESM 缓存挡住')
  expect(/searchParams\.set\(['"]generation['"]/.test(entry),
    '入口动态 import 带时间戳（绕开 ESM 缓存）', '缺少 cache-busting 参数')
  expect(/export const name = ['"]dsh-tri-layer-memory['"]/.test(entry) && /export const inject/.test(entry),
    '入口静态导出 name / inject', 'Loader 需要静态读到 name 与 inject')

  // ── 最关键的一条：硬依赖必须为空 ─────────────────────────────────────
  // exports.inject 里的服务一旦在宿主启动时缺席，插件 fiber 永远停在 pending，
  // 宿主判"有条目未激活"并拒绝启动，整个应用打不开——然后它的崩溃恢复按钮会把
  // 残缺的组合树写回 cordis.patch.yml，抹掉用户的自定义配置。
  // 真实事故：web boot: 1 entry did not activate /
  //           dsh-tri-layer-memory: pending (waiting for service: settingsScope)
  const entryInject = /export const inject\s*=\s*(\[[^\]]*\])/.exec(entry)?.[1]
  expect(entryInject === '[]',
    'lib/entry.js 的 inject 为空数组（全部服务软等待）',
    `实际 inject = ${String(entryInject)}；任何硬依赖都可能让插件 pending 并拖死宿主启动`)

  const built = read('lib/impl.js')
  expect(!built.includes('installSettingsSection'), '实现未引用不存在的 API', 'lib/impl.js 里仍有 installSettingsSection')
  // 关键：实现不得有**静态**外部依赖。宿主模块回退层缺失时，任何
  // `import ... from "@deepseek-ai/..."` 都会让整个插件 failed to import。
  const staticExternal = [...built.matchAll(/^import[^;]*?from\s*["'](@deepseek-ai\/[^"']+|dsh-[^"']+)["']/gm)]
    .map((m) => m[1])
  expect(staticExternal.length === 0,
    'lib/impl.js 无静态外部依赖（只 import node 内置）',
    `发现静态外部依赖 ${JSON.stringify([...new Set(staticExternal)])}；应改用 platform.ts 的内联实现或动态 import`)
  expect(/await import\(["']@deepseek-ai\/schemastery["']\)/.test(built),
    'schemastery 走动态 import（拿不到时只跳过设置面板）',
    '未找到动态 import；设置面板的 schema 加载必须是可失败的')
  // 工具 output.schema 必须落在宿主支持的类型子集内：
  // ctx.tools.register 会对它跑 assertSupportedJsonSchema，
  // 作者侧的 `{ type: 'json' }` 会被直接拒绝并让整个插件注册失败。
  // 先剥掉注释再匹配——文档里提到这个坑不算违规。
  const codeOnly = built
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const badSchema = [...codeOnly.matchAll(/type:\s*["']json["']/g)].length
  expect(badSchema === 0,
    '实现中无 { type: "json" } 输出 schema',
    'assertSupportedJsonSchema 只接受 object/array/string/number/integer/boolean/null')
}

// ── 11. 宿主源码不得有 @deepseek-ai 的静态值导入 ─────────────────────────
const hostSources = [
  'src/host/index.ts', 'src/host/integration.ts', 'src/host/config-core.ts',
  'src/host/l1-working.ts', 'src/host/l2-short.ts', 'src/host/l2-render.ts',
  'src/host/l3-deep.ts', 'src/host/recall.ts', 'src/host/platform.ts',
  // 思维栏投影：它 import zod（普通库，不是 DSH 包），必须内联进产物而不是留下裸 import。
  'src/host/projection.ts',
]
for (const rel of hostSources) {
  const text = read(rel)
  const valueImports = [...text.matchAll(/^\s*import\s+(?!type\b)[^;\n]*?from\s+['"](@deepseek-ai\/[^'"]+)['"]/gm)]
    .map((m) => m[1])
  expect(valueImports.length === 0,
    `${rel} 无 @deepseek-ai 静态值导入`,
    `发现 ${JSON.stringify(valueImports)}；类型导入请写 import type，值请用 platform.ts 或动态 import`)
}

// ── 12. 思维栏：两侧 key 一致、标签页座位、依赖纪律 ───────────────────────
// 这一节守的是一条**跨进程接口**：宿主把值发布到 key 上，客户端按同一个 key 取。
// 两侧没有编译器帮忙对齐，key 写错只会表现为"标签页永远是空的"。
const projectionTs = read('src/host/projection.ts')
const projectionKey = /PROJECTION_KEY\s*=\s*['"]([^'"]+)['"]/.exec(projectionTs)?.[1]
expect(projectionKey === 'tri-layer-memory',
  '投影 key 是 tri-layer-memory', `实际 ${String(projectionKey)}`)
expect(new RegExp(`useProjection\\(\\s*NS\\s*\\)`).test(client),
  '客户端用 useProjection(NS) 读同一个 key',
  '未找到 useProjection(NS)；两侧的 key 必须逐字一致（client 的 NS = 宿主的 PROJECTION_KEY）')
const clientRequires = [...client.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
expect(clientRequires.every((spec) => spec === 'react' || spec === '@deepseek-ai/dsh-client-store'),
  '客户端只 require 基线模块（不引宿主半边）',
  `实际 ${JSON.stringify(clientRequires)}；浏览器半边与宿主半边是两条独立产物，跨引会在 materialize 时失败`)

// 硬依赖纪律：投影服务只能走 apply 内部的软等待。
expect(indexTs.includes("inject(['sessionProjections']"),
  'sessionProjections 以 ctx.inject 软等待',
  '投影服务缺席时必须只丢思维栏数据，不能进 exports.inject 拖死启动')
expect(!injectNames.some((name) => /projection/i.test(name)),
  'client inject 不含任何投影服务',
  `实际 ${JSON.stringify(injectNames)}；useProjection 是 session 作用域槽位的标准 prop，不是服务`)

// 标签页座位：conversation.view 是 list 槽位，id/order 就是"第三个标签"的定义。
expect(client.includes('"conversation.view"'), 'client 注册 conversation.view 槽位', '未找到思维栏槽位注册')
const viewSeat = /name:\s*"conversation\.view"[\s\S]{0,200}?id:\s*"memory"[\s\S]{0,200}?order:\s*20/.exec(client)
expect(viewSeat !== null, '思维栏 id=memory / order=20',
  'chat 是 order 0、trajectory 是 order 10；座位与已定稿的规格不一致会让标签顺序变化')
expect(/label:\s*function\s*\([^)]*\)\s*\{\s*return\s+t\(\s*["']view\.memory["']\s*\)/.test(client),
  '思维栏 label 是 thunk（跟随语言切换）',
  'label 必须是函数：字符串会在注册时定死语言，切换语言后标签不会变')

// zod：投影的 stateSchema/viewSchema 会被框架真的 parse，因此必须是真 Zod；
// 而它是普通库（无 @deepseek-ai peer），只能内联进产物——留下裸 import 的话，
// 宿主模块回退层解析不到它就会让整个插件 failed to import。
expect(typeof pkg.dependencies?.zod === 'string',
  'dependencies 声明 zod', '投影的运行时校验器需要真的 Zod')
if (existsSync(join(root, 'lib/impl.js'))) {
  const implText = read('lib/impl.js')
  const bareImports = [...implText.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'))
  expect(bareImports.length === 0,
    'lib/impl.js 只 import node 内置（zod 已内联）',
    `发现裸包 import ${JSON.stringify([...new Set(bareImports)])}；宿主解析不到时整个插件会 import 失败`)
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures.length}/${checks} 契约检查通过`)
if (failures.length > 0) {
  console.error('\n契约违规:')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
