// _build.mjs — 把 shell + style + payload + app 拼成「思维栏 v0.html」。
import { readFileSync, writeFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL('./' + f, import.meta.url), 'utf8')
const shell = read('_shell.html')
const style = read('_style.css')
const app = read('_app.js')
const payload = read('_payload.json')

// 内联 JSON：`</script>` 会把脚本块提前关掉，必须打断（数据里确实有 `</` 片段）。
const safeJson = payload.replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028|\u2029/g, (m) => '\\u' + m.charCodeAt(0).toString(16))

const out = shell
  .replace('/*STYLE*/', style.trimEnd())
  .replace('/*DATA*/', safeJson.trim())
  .replace('/*APP*/', app.trimEnd())

const dest = new URL('./思维栏 v0.html', import.meta.url)
writeFileSync(dest, out, 'utf8')
console.error(`[build] ${dest.pathname}  ${(out.length / 1024).toFixed(1)} KB`)
// 自检：占位符必须都换掉了
for (const p of ['/*STYLE*/', '/*DATA*/', '/*APP*/']) {
  if (out.includes(p)) { console.error(`[build] FAIL 占位符未替换: ${p}`); process.exitCode = 1 }
}
