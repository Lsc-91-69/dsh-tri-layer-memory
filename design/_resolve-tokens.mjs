// _resolve-tokens.mjs — 把 _tokens.css 里的 alias 层解析成真实 hex（深/浅两套），
// 供 HTML 直接内联使用（不依赖宿主运行时）。
import { readFileSync, writeFileSync } from 'node:fs'
const css = readFileSync(new URL('./_tokens.css', import.meta.url), 'utf8')

// 文件里有两组 `body{...}` / `body[data-ds-dark-theme]{...}`：
// 第 1 组是 static 层，第 2 组才是 alias 层（alias 引用 static）。
// 因此按出现顺序把块切开，取**最后**一组 alias 定义块。
function allBlocks() {
  const out = []
  let i = 0
  while (i < css.length) {
    const s = css.indexOf('{', i)
    if (s < 0) break
    // 必须做**配对括号**扫描：变量值里会出现 `}`（例如 `--dsw-xxx-800p:#1f1f1f5c}` 之后
    // 紧跟另一个声明），用 indexOf('}') 会把块截断在第一个 `}`，导致后半段的
    // alias（bg-layer-* / label-* / brand-*）全部读不到——第一版就是这么静默读空的。
    let depth = 0
    let e = s
    for (; e < css.length; e++) {
      if (css[e] === '{') depth++
      else if (css[e] === '}') { depth--; if (depth === 0) break }
    }
    out.push({ sel: css.slice(i, s).trim(), body: css.slice(s + 1, e) })
    i = e + 1
  }
  return out
}
const blocks = allBlocks()
const varsOf = (b) => {
  const m = new Map()
  if (!b) return m
  for (const decl of b.split(';')) {
    const k = decl.indexOf(':')
    if (k < 0) continue
    const name = decl.slice(0, k).trim()
    const val = decl.slice(k + 1).trim()
    if (name.startsWith('--')) m.set(name, val)
  }
  return m
}

// alias 层 = 含 `--dsw-alias-` 的那些块；light 取纯 body，dark 取带 dark-theme 的 body。
const aliasBlocks = blocks.filter((b) => b.body.includes('--dsw-alias-'))
const lightBlock = aliasBlocks.filter((b) => b.sel === 'body').pop()
const darkBlock = aliasBlocks.filter((b) => b.sel.includes('dark-theme')).pop()
console.error(`[blocks] ${blocks.length} aliasBlocks=${aliasBlocks.length} light=${lightBlock?.sel} dark=${darkBlock?.sel}`)
// 变量是**跨块**引用的：alias 块（第 3/4 个块）里的值全部指向 static 块
// （第 1/2 个块）里的调色板。所以每一套主题要把「static 块 + alias 块」合并成一张表。
const isDark = (sel) => sel.includes('dark-theme')
const staticLight = varsOf(blocks.filter((b) => b.sel === 'body' && !b.body.includes('--dsw-alias-')).pop()?.body)
const staticDark = varsOf(blocks.filter((b) => isDark(b.sel) && !b.body.includes('--dsw-alias-')).pop()?.body)
const base = new Map([...staticLight, ...varsOf(lightBlock?.body)])
const darkOver = new Map([...staticDark, ...varsOf(darkBlock?.body)])
console.error(`[maps] light=${base.size} dark=${darkOver.size}`)
console.error(`[probe] dark bg-layer-1 raw=${JSON.stringify(darkOver.get('--dsw-alias-bg-layer-1'))}`)
console.error(`[probe] dark static bluish-875=${JSON.stringify(darkOver.get('--dsw-static-neutral-bluish-875'))}`)

function resolve(name, over, depth = 0) {
  if (depth > 8) return null
  const v = over.get(name) ?? base.get(name)
  if (v === undefined) return null
  const m = v.match(/^var\((--[a-z0-9-]+)(?:,\s*(.+))?\)$/)
  if (m) {
    const inner = resolve(m[1], over, depth + 1)
    return inner ?? (m[2] ?? null)
  }
  return v
}

const WANT = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask', '--dsw-alias-bg-elevated', '--dsw-alias-bg-hover', '--dsw-alias-bg-active',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
  '--dsw-alias-label-quaternary', '--dsw-alias-label-caption', '--dsw-alias-label-inverse',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-secondary',
  '--dsw-alias-brand-primary', '--dsw-alias-brand-hover', '--dsw-alias-brand-fill',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-warning-primary',
  '--dsw-alias-button-primary-fill', '--dsw-alias-fill-1', '--dsw-alias-fill-2',
]
// 名字对不上就在两份表里把所有 alias 名打印出来
const names = new Set([...base.keys(), ...darkOver.keys()])
const aliases = [...names].filter((n) => n.startsWith('--dsw-alias-')).sort()

const out = { aliases, resolved: {} }
for (const n of WANT) out.resolved[n] = { dark: resolve(n, darkOver), light: resolve(n, base) }
// 全量 alias 解析（好让我按需挑，不用二次跑）
out.all = {}
for (const n of aliases) out.all[n] = { dark: resolve(n, darkOver), light: resolve(n, base) }

writeFileSync(new URL('./_resolved-tokens.json', import.meta.url), JSON.stringify(out, null, 2), 'utf8')
console.error(`[aliases] ${aliases.length}`)
for (const n of WANT) {
  const r = out.resolved[n]
  console.error(`${n}  dark=${r.dark}  light=${r.light}`)
}
