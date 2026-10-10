// _selfcheck.mjs — 交付前自检（在最终 HTML 上跑，不看源文件）。
import { readFileSync } from 'node:fs'

const file = new URL('./思维栏 v0.html', import.meta.url)
const html = readFileSync(file, 'utf8')
const problems = []
const ok = []

// 1 · 无外部依赖（双击即开：无 CDN / 无字体 / 无本地引用）
const externals = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
if (externals.length) problems.push(`外部引用: ${JSON.stringify(externals)}`)
else ok.push('无任何 src/href 外部引用（无 CDN、无字体、无本地文件）')
if (/@import|@font-face|url\(/i.test(html)) problems.push('CSS 里有 @import / @font-face / url()')
else ok.push('CSS 无 @import / @font-face / url()')

// 2 · 内联数据规模
const m = html.match(/window\.__TLM__\s*=\s*(\{[\s\S]*?\});\n<\/script>/)
if (!m) problems.push('找不到内联 DATA')
else {
  const D = JSON.parse(m[1].replace(/<\\\/(script)/g, '</$1'))
  const ml = D.mainline.length
  const recs = D.l3.groups.reduce((s, g) => s + g.records.length, 0)
  if (ml < 40) problems.push(`骨架条目只有 ${ml} 条（要求 ≥40）`)
  else ok.push(`骨架条目 ${ml} 条（要求 ≥40）`)
  ok.push(`L3 记录 ${recs} 条 / ${D.l3.groups.length} 个会话分组；整库 ${D.l3.count} 条 ${D.l3.sessionCount} 本会话`)
  ok.push(`L2 摘要 ${D.l2.chars} 字符 / ${D.l2.sections.length} 节 / 覆盖 ${D.l2.turnFrom}–${D.l2.turnTo} 轮`)
  ok.push(`任务标题：${JSON.stringify(D.taskTitle)}`)
  // 数据完整性：每条骨架必须有 turn/title/cause/category/tokens
  const bad = D.mainline.filter((x) => typeof x.turn !== 'number' || !x.title || !x.cause || !x.category || typeof x.tokens !== 'number')
  if (bad.length) problems.push(`${bad.length} 条骨架字段不全`)
  else ok.push('每条骨架字段齐全（turn/title/cause/category/tokens）')
  const badRec = D.l3.groups.flatMap((g) => g.records).filter((r) => !r.text || typeof r.tokens !== 'number' || !r.kind)
  if (badRec.length) problems.push(`${badRec.length} 条 L3 记录字段不全`)
  else ok.push('每条 L3 记录字段齐全（kind/text/tokens/sessionId/own）')
  // 是否真有「其它会话」记录（问题 4 的前提）
  const otherGroups = D.l3.groups.filter((g) => !g.own)
  ok.push(`其它会话分组 ${otherGroups.length} 个（共 ${otherGroups.reduce((s, g) => s + g.records.length, 0)} 条）`)
}

// 3 · 禁止项
// 设计代码 = shell + style + app（数据是真实会话文本，里面出现 emoji/关键词不算设计问题）
const shell = readFileSync(new URL('./_shell.html', import.meta.url), 'utf8')
const style = readFileSync(new URL('./_style.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('./_app.js', import.meta.url), 'utf8')

// 「用了 scrollIntoView」只认**调用**，不认注释里提到它
const calls = [...html.matchAll(/\.scrollIntoView\s*\(/g)].length
if (calls) problems.push(`scrollIntoView 调用 ${calls} 处`)
else ok.push('无 scrollIntoView 调用（注释里明确写了不用它）')
if (/<img|background-image\s*:\s*url/i.test(html)) problems.push('有图片/CSS 图片')
else ok.push('无图片资源')
// 只在「会被渲染出来的字符串」里查 emoji：用字符扫描剥掉注释（避免正则里出现 // 触发解析歧义）
function stripComments(s) {
  let out = ''
  let i = 0
  let quote = null
  while (i < s.length) {
    const c = s[i], d = s[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += d ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return out
}
const design = stripComments(shell.replace(/<!--[\s\S]*?-->/g, '')) + stripComments(style) + stripComments(app)
const emojiDesign = design.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu)
if (emojiDesign) problems.push(`渲染内容里有 emoji: ${[...new Set(emojiDesign)].join(' ')}`)
else ok.push('渲染内容里无 emoji（注释里的箭头不算图标）')
const emojiData = (html.match(/[\u{1F300}-\u{1FAFF}]/gu) ?? [])
ok.push(`真实数据里出现的 emoji ${[...new Set(emojiData)].length} 种（原文照录，未当图标用）`)
if (/const\s+styles\s*=/.test(html)) problems.push('用了 const styles = {...}')
else ok.push('无 const styles 全局对象')
if (!/prefers-reduced-motion/.test(html)) problems.push('缺 prefers-reduced-motion 降级')
else ok.push('有 prefers-reduced-motion 降级')
// 4 · 色相审计：只允许声明的 token 值
const hexes = [...new Set([...html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((x) => x[0].toLowerCase()))]
ok.push(`内联 hex 色值 ${hexes.length} 个：${hexes.join(' ')}`)

console.log('=== PASS ===')
for (const l of ok) console.log('  · ' + l)
if (problems.length) { console.log('=== FAIL ==='); for (const l of problems) console.log('  ! ' + l); process.exitCode = 1 }
else console.log('=== 无 FAIL ===')
