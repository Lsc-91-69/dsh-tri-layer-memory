/**
 * scripts/verify-sources.mjs — 拒绝已退役的 v3 消息来源写法。
 *
 * DSH 0.2.0-rc.2 的会话格式 v4 要求消息来源「生产者自有」：任何
 * `{ kind: 'plugin', plugin: <名> }` 的消息在**写入时**被拒绝，报
 * `format v4 message requires a producer-owned source kind`。
 *
 * 本插件的注入发生在 `agent/pre-step`，那条消息一被拒绝，整轮对话就在
 * `step/start` 之前失败 —— 日志里只剩一个没闭合的 turn，表现是「这个会话
 * 突然不能用了」，而新会话却正常。定位成本极高，所以这里机械地拦住它。
 *
 * 检查范围：src/ 下的实现（.ts/.js）与 lib/ 下的产物（.js）。
 * 注释先被剥掉，所以文档里可以继续提这个退役写法。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 退役写法：source.kind 写成字符串 'plugin'。 */
const RETIRED = /kind:\s*['"]plugin['"]/

/** 去掉块注释与整行注释，避免文档里的示例被误判。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n')
}

/** 递归收集 .ts / .js（跳过 sourcemap 与声明文件）。 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (/\.(ts|js)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const offenders = []
for (const file of [...collect(join(root, 'src')), ...collect(join(root, 'lib'))]) {
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    if (RETIRED.test(line)) offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
  })
}

if (offenders.length > 0) {
  console.error(
    '[verify-sources] 发现已退役的 v3 消息来源（v4 写入时会拒绝，整轮对话会失败）：\n'
    + offenders.map((line) => `  ${line}`).join('\n')
    + '\n  改成生产者自有的 kind，例如 { kind: PLUGIN_SOURCE_KIND }。',
  )
  process.exit(1)
}
console.log('[verify-sources] OK：没有已退役的 kind:\'plugin\' 消息来源')
