// _tokens.mjs — 从 ui-theme client.js 里抽出 design_platform 的 token 定义，落地成 _tokens.css
import { readFileSync, writeFileSync } from 'node:fs'
const s = readFileSync(new URL('./_theme.js', import.meta.url), 'utf8')
const i = s.indexOf('design_platform_css_default = ')
if (i < 0) { console.error('not found'); process.exit(1) }
const start = s.indexOf('"', i) + 1
// 找到未转义的收尾引号
let j = start
while (j < s.length) {
  if (s[j] === '\\') { j += 2; continue }
  if (s[j] === '"') break
  j += 1
}
const raw = s.slice(start, j)
const css = JSON.parse('"' + raw + '"')
writeFileSync(new URL('./_tokens.css', import.meta.url), css, 'utf8')
console.error(`[tokens] ${css.length} chars`)
// 只打印 alias 层里跟本任务相关的
for (const line of css.split(';')) {
  if (/--dsw-alias-(bg|label|border|brand|state|button|fill|chart)/.test(line)) continue
}
