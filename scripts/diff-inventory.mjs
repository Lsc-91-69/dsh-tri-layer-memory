/**
 * scripts/diff-inventory.mjs — 测量任务 A/B 的第 0 步：摸清原料。
 *
 * 只做三件事，全部只读：
 * 1. 打开 .tmp-diff/ 里的**数据库副本**，按 sessionId × kind 统计记录数 / token / 轮区间；
 * 2. 列出每个会话的 turn 记录覆盖面，挑出"历史最长、蒸馏最完整"的候选会话；
 * 3. 打印一条 turn 记录正文 + 一条 digest 记录正文的头尾，确认记录形态与预期一致。
 *
 * 不做任何写操作，不碰真库。
 *
 * 用法：node scripts/diff-inventory.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const copy = join(root, '.tmp-diff', 'deep-memory.copy.sqlite')
if (!existsSync(copy)) {
  console.error(`[inventory] 找不到数据库副本：${copy}\n  先复制真库：Copy-Item C:\\Users\\admin\\.dsh\\tri-layer-memory\\deep-memory.sqlite ${copy}`)
  process.exit(1)
}

const db = new DatabaseSync(copy, { readOnly: true })
const rows = db.prepare('SELECT id, kind, sessionId, turnFrom, turnTo, tokens, length(text) AS chars, createdAt FROM records').all()

const bySession = new Map()
for (const r of rows) {
  let s = bySession.get(r.sessionId)
  if (s === undefined) {
    s = { sessionId: r.sessionId, kinds: new Map(), tokens: 0, chars: 0, turns: [] }
    bySession.set(r.sessionId, s)
  }
  const k = s.kinds.get(r.kind) ?? { n: 0, tokens: 0, chars: 0 }
  k.n += 1
  k.tokens += r.tokens
  k.chars += r.chars
  s.kinds.set(r.kind, k)
  s.tokens += r.tokens
  s.chars += r.chars
  s.turns.push([r.turnFrom, r.turnTo])
}

console.log(`总数：${rows.length} 条记录，${new Set(rows.map((r) => r.sessionId)).size} 个会话\n`)

const kindTotals = new Map()
for (const r of rows) {
  const k = kindTotals.get(r.kind) ?? { n: 0, tokens: 0, chars: 0 }
  k.n += 1
  k.tokens += r.tokens
  k.chars += r.chars
  kindTotals.set(r.kind, k)
}
console.log('== 按 kind 汇总 ==')
for (const [kind, k] of [...kindTotals].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${kind.padEnd(10)} n=${String(k.n).padStart(4)}  tokens=${String(k.tokens).padStart(6)}  chars=${String(k.chars).padStart(7)}`)
}

console.log('\n== 按会话汇总（按 turn 覆盖轮数降序）==')
const sessions = [...bySession.values()].map((s) => {
  const turnKind = s.kinds.get('turn')
  const maxTurn = s.turns.reduce((m, [a, b]) => Math.max(m, a, b), 0)
  return { ...s, nTurn: turnKind?.n ?? 0, maxTurn }
})
sessions.sort((a, b) => (b.nTurn - a.nTurn) || (b.tokens - a.tokens))
for (const s of sessions) {
  const detail = [...s.kinds].map(([k, v]) => `${k}:${v.n}`).join(' ')
  console.log(`  ${s.sessionId.padEnd(48)} maxTurn=${String(s.maxTurn).padStart(3)}  turn=${String(s.nTurn).padStart(3)}  tokens=${String(s.tokens).padStart(6)}  [${detail}]`)
}

const sample = rows.filter((r) => r.kind === 'turn').sort((a, b) => b.chars - a.chars)[0]
if (sample !== undefined) {
  const full = db.prepare('SELECT text FROM records WHERE id = ?').get(sample.id)
  console.log(`\n== 最长的一条 turn 记录（${sample.sessionId} turn ${sample.turnFrom}–${sample.turnTo}, ${sample.chars} 字符）==`)
  console.log(full.text.slice(0, 1800))
}
const digest = rows.filter((r) => r.kind === 'digest').sort((a, b) => b.chars - a.chars)[0]
if (digest !== undefined) {
  const full = db.prepare('SELECT text FROM records WHERE id = ?').get(digest.id)
  console.log(`\n== 最长的一条 digest 记录（${digest.sessionId} turn ${digest.turnFrom}–${digest.turnTo}, ${digest.chars} 字符）==`)
  console.log(full.text.slice(0, 2500))
}
db.close()
