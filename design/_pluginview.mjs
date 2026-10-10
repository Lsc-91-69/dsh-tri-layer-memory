// _pluginview.mjs — 把**插件源码**渲染出来的面板放进真实浏览器里看。
//
// 为什么需要它：`npm test` 只能断言"树里有什么节点"，样式一个字都测不到。
// 这个脚本用 node:vm 加载 src/client.js（与 test/client.test.mjs 同一套替身），
// 拿它真实渲染出的树 + 它自己注入的 CSS 字符串，拼成一个页面；
// 再用宿主主题里解析出来的 --dsw-* 值填 :root（宿主就是在 body 上定义这些变量的）。
// 数据用 design/DATA.json 的真实会话（81 轮 / 11 组 / 真实 L3 记录），不是手捏的小夹具。
//
// 产出：design/_pluginview.html（临时件，可重复生成；不是交付物）
import { readFileSync, writeFileSync } from 'node:fs'
import vm from 'node:vm'

const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const ROOT = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory'
const data = JSON.parse(readFileSync(`${DIR}\\DATA.json`, 'utf8'))
const tokens = JSON.parse(readFileSync(`${DIR}\\_resolved-tokens.json`, 'utf8'))

// ── React 替身（与测试同规则：渲染前游标归零）──────────────────────────
let hookCursor = 0
const hookStates = []
const React = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) } },
  useState(initial) {
    const i = hookCursor++
    if (i >= hookStates.length) hookStates.push(initial)
    return [hookStates[i], (v) => { hookStates[i] = v }]
  },
}

const styles = []
const documentStub = {
  head: { appendChild(node) { styles.push(node) } },
  createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
}

const loaded = []
const sandbox = {
  window: { __ModuleLoader__: { load(r) { loaded.push(r) } } },
  document: documentStub,
  Promise, Date, Object, Array, Map, Set, String, Number, JSON, Math, console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(readFileSync(`${ROOT}\\src\\client.js`, 'utf8'), sandbox, { filename: 'client.js' })

const dictionaries = []
const registrations = []
const ctx = {
  effect(fn) { fn() },
  locale: {
    bind() { return (key, params) => {
      const dict = dictionaries[0].dict.zh
      const tpl = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      return params === undefined ? tpl : tpl.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
    } },
    register(ns, dicts) { dictionaries.push({ ns, dict: dicts }); return () => {} },
  },
  slots: {
    // 与 test/client.test.mjs 同一套：真实实现是"等槽位声明后再跑"，这里直接跑生成器。
    inject(name, callback) {
      const iterator = callback()
      for (const item of iterator) registrations.push({ name, item })
    },
    register(options, component) { return { options, component } },
  },
}
loaded[0].factory((spec) => {
  if (spec === 'react') return React
  if (spec === '@deepseek-ai/dsh-client-store') return { createSnapshotStore(v) { return { set() {}, getSnapshot() { return v } } } }
  throw new Error('unexpected require: ' + spec)
}).apply(ctx)

const view = registrations.find((r) => r.name === 'conversation.view')
if (!view) throw new Error('conversation.view 没注册')

// ── 投影夹具：真实数据 ────────────────────────────────────────────────
const mainlineMax = Math.max(...data.mainline.map((m) => Math.max(m.turn, m.turnTo ?? m.turn)))
const projection = {
  taskTitle: data.taskTitle,
  mainline: data.mainline,
  mainlineTokens: data.mainlineTokens,
  l1: { retainTurns: 8, turns: 8, evicted: data.meta.turnCount - 8 },
  l2: { summary: data.l2.summary, turnFrom: data.l2.turnFrom, turnTo: data.l2.turnTo, mode: data.l2.mode },
  l3: {
    backend: data.l3.backend, count: data.l3.count, tokens: data.l3.tokens,
    sessionCount: data.l3.sessionCount, sessionTokens: data.l3.sessionTokens,
    sessionId: data.meta.sessionId,
    records: data.l3.records.slice(0, 40),
  },
  recallTool: 'memory_recall',
  updatedAt: Date.now(),
}

hookCursor = 0
const tree = view.item.component({
  t: ctx.locale.bind('tri-layer-memory'),
  useProjection: (key) => (key === 'tri-layer-memory' ? projection : undefined),
  inputActions: { setDraft(text) { globalThis.__LAST_DRAFT__ = text } },
  useInput: (selector) => selector({ draft: '' }),
})

// ── 序列化：React 替身树 → HTML ───────────────────────────────────────
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link'])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function attrs(props) {
  const out = []
  for (const k of Object.keys(props)) {
    if (k === 'key' || k === 'children' || k === 'onClick' || k === 'onChange') continue
    const v = props[k]
    if (v === undefined || v === null || v === false || typeof v === 'function') continue
    if (k === 'className') { out.push(`class="${esc(v)}"`); continue }
    if (k === 'open') { if (v) out.push('open'); continue }
    if (k === 'value') continue
    out.push(`${k}="${esc(v)}"`)
  }
  return out.length ? ' ' + out.join(' ') : ''
}
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object') return esc(node)
  const tag = node.type
  if (typeof tag !== 'string') return render(node.children) // 函数组件：替身里不会出现
  const inner = (node.children ?? []).map(render).join('')
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs(node.props)}>`
  return `<${tag}${attrs(node.props)}>${inner}</${tag}>`
}

// ── 宿主主题变量（dark / light 各一套）────────────────────────────────
// 插件里**没有一行硬编码 hex**：面板的颜色全靠 --dsw-*。所以这里必须两套都渲染，
// 否则"换主题会跟着变"就只是句空话。
function themeVars(which) {
  const out = []
  for (const name of Object.keys(tokens.all)) {
    const v = tokens.all[name][which]
    if (typeof v === 'string' && v.length > 0) out.push(`${name}:${v}`)
  }
  // static 层：解析脚本只导出了 alias，这里补上设计用到的那两个 amber（值取自 _tokens.css）
  out.push('--dsw-static-amber-500:#f59e0b', '--dsw-static-amber-600:#dd8629')
  return out
}

const css = styles[0].textContent
function page(which, label) {
  const light = which === 'light'
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>plugin view harness · ${label}</title>
<style>
:root{${themeVars(which).join(';')}}
html,body{margin:0;height:100%}
body{background:var(--dsw-alias-bg-base,${light ? '#fff' : '#151517'});color:var(--dsw-alias-label-primary,${light ? '#0f1115' : '#f9fafb'});
  font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",sans-serif;font-size:13px}
/* 模拟宿主对话视图的一栏（不是全窗口：面板真的活在这样的窄栏里） */
.pane{max-width:760px;margin:0 auto;min-height:100%}
</style>
<style id="plugin-css">${css}</style>
</head><body>
<div class="pane" id="pane">${render(tree)}</div>
</body></html>`
}

for (const which of ['dark', 'light']) {
  const html = page(which, which)
  writeFileSync(`${DIR}\\_pluginview${which === 'light' ? '-light' : ''}.html`, html, 'utf8')
  console.error(`[pluginview] 写出 _pluginview${which === 'light' ? '-light' : ''}.html  ${(html.length / 1024).toFixed(1)} KB`)
}
console.error(`[pluginview] CSS ${(css.length / 1024).toFixed(1)} KB，${themeVars('dark').length} 个主题变量`)
console.error(`[pluginview] mainline=${projection.mainline.length} 条 / mainlineMax=${mainlineMax} / l3=${projection.l3.records.length} 条`)
