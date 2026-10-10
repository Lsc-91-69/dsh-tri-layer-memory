// _extract.mjs — 只读提取真实数据（会话骨架 + L3 记录），产出 DATA.json。
// 放在 design/ 下，不改任何 src/。可删。
//
// 骨架：直接 import 插件的 extractMilestones（真源，不是复刻）。
// L3  ：直接读 sqlite（node:sqlite 内置）。
// L2  ：会话日志里最后一次 context/compaction 事件（或 diagnostics）。
import { writeFileSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const SESSION_ID = 'session-5b59b635-915f-439d-bd73-a2da6543db8a'
const LOG = `C:\\Users\\admin\\.dsh\\sessions\\--D-deepseek-deepseekh_work--\\${SESSION_ID}\\session.v4.jsonl.zstd`
const DB = 'C:\\Users\\admin\\.dsh\\tri-layer-memory\\deep-memory.sqlite'
const OUT = new URL('./DATA.json', import.meta.url)

// ── 1. 读会话日志（按 zstd 魔数切帧，见 feasibility/lib.mjs） ──────────
const { decompressFrames } = await import('../../../feasibility/lib.mjs')
const { text, frames, failed } = decompressFrames(LOG)
const lines = text.split('\n').filter((l) => l.trim().length > 0)
const events = []
let badLines = 0
for (const line of lines) {
  try { events.push(JSON.parse(line)) } catch { badLines += 1 }
}
console.error(`[log] frames=${frames} failedFrames=${failed} lines=${lines.length} events=${events.length} badLines=${badLines}`)

// ── 2. 真源提取骨架 ────────────────────────────────────────────────
const { extractMilestones } = await import('../src/host/milestones.ts')
const milestones = extractMilestones(events)
console.error(`[milestones] n=${milestones.length}`)

// 任务标题：插件口径取第一轮用户原话（与 extractMilestones 的「任务」类里程碑同源）。
const firstTask = milestones.find((m) => m.category === '任务')
const taskTitle = firstTask ? firstTask.title : null

// ── 3. 轮次数 ──────────────────────────────────────────────────────
let turnCount = 0
for (const ev of events) if (ev.type === 'turn/start') turnCount += 1
console.error(`[turns] ${turnCount}`)

// ── 4. L3 记录 ────────────────────────────────────────────────────
const db = new DatabaseSync(DB, { readOnly: true })
const cols = db.prepare(`select name from pragma_table_info('records')`).all().map((r) => r.name)
console.error(`[db] columns=${cols.join(',')}`)
const all = db.prepare(`select * from records order by createdAt desc`).all()
console.error(`[db] rows=${all.length}`)

const pick = (row) => ({
  id: String(row.id),
  kind: String(row.kind ?? ''),
  turnFrom: Number(row.turnFrom ?? 0),
  turnTo: Number(row.turnTo ?? 0),
  text: String(row.text ?? ''),
  tokens: Number(row.tokens ?? 0),
  sessionId: String(row.sessionId ?? ''),
  own: String(row.sessionId ?? '') === SESSION_ID,
  createdAt: Number(row.createdAt ?? 0),
})
const records = all.map(pick)
const ownRecords = records.filter((r) => r.own)

// 会话短 id → 可读标签（用 sessions 目录里最后一次写入时间无关，仅取 id 前缀）
const sessions = new Map()
for (const r of records) {
  const key = r.sessionId
  const cur = sessions.get(key) ?? { sessionId: key, count: 0, tokens: 0, first: r.createdAt, last: r.createdAt }
  cur.count += 1
  cur.tokens += r.tokens
  cur.first = Math.min(cur.first, r.createdAt)
  cur.last = Math.max(cur.last, r.createdAt)
  sessions.set(key, cur)
}

// ── 5. L2 摘要：从会话日志里捞（compaction / summary 类事件） ────────
const types = new Map()
for (const ev of events) types.set(ev.type, (types.get(ev.type) ?? 0) + 1)
console.error('[types] ' + [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}=${v}`).join(' '))

// 最近一次 compaction/summary = 真实 L2 摘要（插件 L2 的正文来源就是它）。
const comps = events.filter((e) => e.type === 'compaction/summary')
const last = comps[comps.length - 1]
const summaryText = Array.isArray(last?.data?.summary)
  ? last.data.summary.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
  : String(last?.data?.summary ?? '')
// 覆盖区间：被遮蔽的事件落在哪些轮里。
const shadowedSeqs = new Set(Array.isArray(last?.data?.shadowedSeqs) ? last.data.shadowedSeqs : [])
let turnOf = new Map()
{
  let cur = -1
  for (const ev of events) {
    if (ev.type === 'turn/start') cur = ev.data?.turn ?? cur + 1
    turnOf.set(ev.seq, cur)
  }
}
const coveredTurns = [...shadowedSeqs].map((s) => turnOf.get(s)).filter((n) => typeof n === 'number' && n >= 0)
const l2View = last === undefined ? null : {
  summary: summaryText,
  turnFrom: coveredTurns.length ? Math.min(...coveredTurns) : 0,
  turnTo: coveredTurns.length ? Math.max(...coveredTurns) : 0,
  mode: 'llm',
  chars: summaryText.length,
  shadowedTokenCount: Number(last.data?.shadowedTokenCount ?? 0),
  atSeq: last.seq,
  totalSummaries: comps.length,
}
console.error(`[l2] ${l2View === null ? 'none' : `chars=${l2View.chars} turns=${l2View.turnFrom}-${l2View.turnTo} shadowedTokens=${l2View.shadowedTokenCount} of ${comps.length} summaries`}`)

const data = {
  meta: {
    sessionId: SESSION_ID,
    logPath: LOG,
    logBytes: readFileSync(LOG).length,
    frames,
    failedFrames: failed,
    events: events.length,
    badLines,
    turnCount,
    extractedAt: new Date().toISOString(),
  },
  taskTitle,
  mainline: milestones.map((m) => ({
    turn: m.turn,
    ...(m.turnTo !== undefined ? { turnTo: m.turnTo } : {}),
    title: m.title,
    cause: m.cause,
    category: m.category,
    tokens: m.tokens,
  })),
  mainlineTokens: milestones.reduce((s, m) => s + m.tokens, 0),
  l2: l2View,
  l3: {
    backend: 'sqlite',
    count: records.length,
    tokens: records.reduce((s, r) => s + r.tokens, 0),
    sessionCount: ownRecords.length,
    sessionTokens: ownRecords.reduce((s, r) => s + r.tokens, 0),
    sessionId: SESSION_ID,
    records: records.slice(0, 200),
    sessions: [...sessions.values()].sort((a, b) => b.count - a.count),
  },
  eventTypes: [...types.entries()].sort((a, b) => b[1] - a[1]),
}

writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8')
console.error(`[out] ${OUT.pathname}`)
console.error(`[summary] milestones=${data.mainline.length} mainlineTokens=${data.mainlineTokens} l3=${data.l3.count}/${data.l3.sessionCount}own sessions=${data.l3.sessions.length}`)
