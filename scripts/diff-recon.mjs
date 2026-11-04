/**
 * scripts/diff-recon.mjs — 摸清会话日志的物理形态（只读）。
 *
 * 目的：在写"算差集"的脚本之前，先确认三件事：
 * 1. 会话日志解帧后有多少事件、`type` 分布如何；
 * 2. 一条 user/message、assistant/message、tool/call、tool/result 的形状
 *    （正文在哪、source 是什么、轮号从哪读）；
 * 3. 本插件历次投影消息长什么样（要按 production 的 isProjectionEvent 判据排除）。
 *
 * 用法：node scripts/diff-recon.mjs [sessionId]
 */
import { readSessionEvents } from './lib-session-log.mjs'
import { isProjectionEvent, PROJECTION_HEADER, projectTurns } from '../src/host/l1-working.ts'

const sessionId = process.argv[2]
// 会话目录按**会话当时的工作目录**命名，不是脚本执行目录：不传就会去找
// `--…dsh-tri-layer-memory--`，报出的 ENOENT 看起来像"这个会话没有日志"。
const cwd = process.argv[3] ?? 'D:\\deepseek\\deepseekh_work'
const { file, events } = readSessionEvents(sessionId, cwd)
console.log(`文件：${file}`)
console.log(`事件 ${events.length} 条\n`)

const types = new Map()
for (const e of events) types.set(e.type ?? '(no-type)', (types.get(e.type ?? '(no-type)') ?? 0) + 1)
console.log('== 事件类型直方图 ==')
for (const [t, n] of [...types].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${t}`)

console.log('\n== 每种类型的第一个样本（截 700 字符）==')
const shown = new Set()
for (const e of events) {
  const t = e.type ?? '(no-type)'
  if (shown.has(t)) continue
  shown.add(t)
  console.log(`\n--- ${t} ---`)
  console.log(JSON.stringify(e).slice(0, 700))
}

let projections = 0
for (const e of events) if (isProjectionEvent(e)) projections += 1
console.log(`\nisProjectionEvent 命中 ${projections} 条（PROJECTION_HEADER=${JSON.stringify(PROJECTION_HEADER)}）`)

const spans = projectTurns(events)
console.log(`\n== projectTurns 结果：${spans.length} 个 turn ==`)
for (const s of spans.slice(0, 8)) {
  console.log(`  turn ${s.turn}: seq ${s.startSeq}–${s.endSeq} chars=${s.charCount} user=${s.userText.join(' ').length}ch assistant=${s.assistantText.join(' ').length}ch tools=[${s.toolNames.join(',')}]`)
}
console.log(`  ...`)
for (const s of spans.slice(-4)) {
  console.log(`  turn ${s.turn}: seq ${s.startSeq}–${s.endSeq} chars=${s.charCount} user=${s.userText.join(' ').length}ch assistant=${s.assistantText.join(' ').length}ch tools=[${s.toolNames.join(',')}]`)
}
