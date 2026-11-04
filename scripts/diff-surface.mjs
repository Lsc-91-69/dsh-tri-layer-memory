/**
 * scripts/diff-surface.mjs — 用**实测 usage** 反推「模型真正看到的那一大团」是什么。
 *
 * 为什么必须先做这一步：任务书把"实际注入"定义为 L1+L2+L3索引+主线骨架（本会话实测
 * 2,651 tokens）。但宿主的 `assistant/message.usage` 说 turn 120 的 prompt 是
 * `inputTokens 5,412 + cacheReadTokens 395,520 ≈ 400,932` tokens。两者相差 150 倍，
 * 说明"模型看不到历史"这个前提在真机上并不成立——不先把这团东西拆开，后面
 * A2「落在哪一层」的分类会系统性错判（把还存在的东西记成"完全没有"）。
 *
 * 本脚本做三件只读的事：
 * 1. 按三种 surface 假说分别算 token，跟实测 usage 对账，看哪种能对上；
 * 2. 拆出投影累积量（本插件自己历次注入、还留在 surface 里的部分）；
 * 3. 列出每次压缩前后 usage 的落差，作为"压缩确实重置了 surface"的证据。
 *
 * 用法：node scripts/diff-surface.mjs [sessionId] [cwd]
 */
import { readSessionEvents } from './lib-session-log.mjs'
import { contentToText, estimateTokens, isProjectionEvent } from '../src/host/l1-working.ts'

const sessionId = process.argv[2]
const cwd = process.argv[3] ?? 'D:\\deepseek\\deepseekh_work'
const { events } = readSessionEvents(sessionId, cwd)

/** 只取正文（assistant 的 reasoning 块不算"模型看到的输入"以外的内容，且任务书要求排除）。 */
function messageText(event) {
  const message = event.data?.message ?? event.data
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

// ── 1. 事件分类 ──────────────────────────────────────────────────────
const shadowed = new Set()
for (const event of events) {
  if (event.type !== 'compaction/prune' && event.type !== 'compaction/summary') continue
  for (const seq of event.data?.shadowedSeqs ?? []) shadowed.add(seq)
}
const summaries = events.filter((e) => e.type === 'compaction/summary')
const summaryText = summaries.map((e) => (e.data.summary ?? []).map((b) => b.text ?? '').join('')).join('\n')
const summaryTokens = estimateTokens(summaryText)

const messageTypes = new Set(['user/message', 'assistant/message', 'tool/result', 'tool/call'])
const msgs = events.filter((e) => messageTypes.has(e.type))
let allTokens = 0
let unshadowedTokens = 0
let projectionTokens = 0
let projectionCount = 0
const perTurn = new Map()
for (const event of msgs) {
  let text = messageText(event)
  if (event.type === 'tool/call') text = `${event.data?.name ?? ''} ${event.data?.arguments ?? ''}`
  const tokens = estimateTokens(text)
  allTokens += tokens
  if (!shadowed.has(event.seq)) unshadowedTokens += tokens
  if (isProjectionEvent(event)) {
    projectionTokens += tokens
    projectionCount += 1
  }
  const turn = event.data?.turn ?? -1
  perTurn.set(turn, (perTurn.get(turn) ?? 0) + tokens)
}

// ── 2. 三种 surface 假说 ─────────────────────────────────────────────
const lastSummary = summaries[summaries.length - 1]
const lastShadowEnd = Math.max(...summaries.map((e) => e.data?.shadowedRange?.end ?? -1))
let afterLastShadowTokens = 0
for (const event of msgs) if (event.seq > lastShadowEnd) afterLastShadowTokens += estimateTokens(messageText(event) || `${event.data?.name ?? ''} ${event.data?.arguments ?? ''}`)

console.log(`会话 ${sessionId}`)
console.log(`消息事件 ${msgs.length} 条；被 compaction 遮蔽的 seq ${shadowed.size} 个`)
console.log(`\n== 假说对账（目标：turn 120 实测 prompt ≈ 400,932 tokens）==`)
console.log(`  H1 全部历史（不遮蔽）              : ${allTokens} tokens`)
console.log(`  H2 只留未被遮蔽的事件              : ${unshadowedTokens} tokens`)
console.log(`  H3 最后一份检查点 + 遮蔽点之后的事件 : ${summaryTokens + afterLastShadowTokens} tokens（其中检查点 ${summaryTokens}、之后 ${afterLastShadowTokens}）`)
console.log(`  H4 上一次检查点(旧) + 之后          : ${estimateTokens((summaries[summaries.length - 2]?.data.summary ?? []).map((b) => b.text ?? '').join('')) + afterLastShadowTokens} tokens`)

console.log(`\n== 投影累积（本插件自己历次注入、仍在日志里的消息）==`)
console.log(`  ${projectionCount} 条 / ${projectionTokens} tokens`)
console.log(`  占全部历史 ${(projectionTokens / allTokens * 100).toFixed(1)}%；占未遮蔽部分 ${(projectionTokens / unshadowedTokens * 100).toFixed(1)}%`)

console.log(`\n== 每次压缩前后 prompt 实测落差 ==`)
const usageByTurn = new Map()
for (const event of events) {
  if (event.type !== 'assistant/message' || event.data?.usage === undefined) continue
  const u = event.data.usage
  usageByTurn.set(event.data.turn, { input: u.inputTokens ?? 0, cache: u.cacheReadTokens ?? 0 })
}
for (const summary of summaries) {
  const turn = events.filter((e) => e.type === 'turn/start' && e.seq < summary.seq).at(-1)?.data?.turn
  const before = usageByTurn.get(turn)
  const after = usageByTurn.get((turn ?? 0) + 1) ?? usageByTurn.get((turn ?? 0) + 2)
  console.log(`  turn ${String(turn).padStart(3)}: 压缩前 ${String((before?.input ?? 0) + (before?.cache ?? 0)).padStart(7)} → 压缩后 ${String((after?.input ?? 0) + (after?.cache ?? 0)).padStart(7)} tokens（摘要 ${((summary.data.summary ?? []).map((b) => b.text ?? '').join('')).length} 字符）`)
}
const finalTurn = Math.max(...usageByTurn.keys())
const lastUsage = usageByTurn.get(finalTurn)
console.log(`\n最后一个有 usage 的 turn ${finalTurn}：uncached ${lastUsage.input} + cacheRead ${lastUsage.cache} = ${lastUsage.input + lastUsage.cache} tokens`)
