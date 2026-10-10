// _gen.mjs — 从 DATA.json 生成「思维栏 v0.html」。
// 只新建 design/ 下的文件，不碰 src/。数据全部内联进 HTML，运行时零依赖。
import { readFileSync, writeFileSync } from 'node:fs'

const DATA = JSON.parse(readFileSync(new URL('./DATA.json', import.meta.url), 'utf8'))
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ── L2 摘要：把 markdown 折成 {h, items} 结构（内容一字不改） ──────────
const l2Sections = DATA.l2.summary.split(/\n(?=## )/).map((raw) => {
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const h = lines[0].replace(/^##\s*/, '')
  const items = []
  for (const line of lines.slice(1)) {
    if (/^-\s+/.test(line)) items.push({ t: 'li', v: line.replace(/^-\s+/, '') })
    else if (/^\s+-\s+/.test(line)) items.push({ t: 'sub', v: line.replace(/^\s*-\s+/, '') })
    else items.push({ t: 'p', v: line })
  }
  return { h, items }
})

// ── L3：按会话分组 ───────────────────────────────────────────────────
// 视图口径是整库前 200 条（MAX_VIEW_RECORDS）。原型里内联 200 条会把 HTML 撑到
// 250KB+，所以按 kind 分层抽样：里程碑全留（信息量最高）、轮次摘要取最近若干条。
// 抽样是**显式记录在 payload 里的**（shown / dropped），不在界面上假装是全部。
const KIND_LABEL = { milestone: '里程碑', turn: '轮次', digest: '摘要' }
const KIND_QUOTA = { milestone: Infinity, digest: Infinity, turn: 56 }
const sessMeta = new Map(DATA.l3.sessions.map((s) => [s.sessionId, s]))
const bySession = new Map()
const kindUsed = new Map()
let droppedRecords = 0
for (const r of DATA.l3.records) {
  const used = kindUsed.get(r.kind) ?? 0
  const quota = KIND_QUOTA[r.kind] ?? 8
  if (used >= quota) { droppedRecords += 1; continue }
  kindUsed.set(r.kind, used + 1)
  if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, [])
  bySession.get(r.sessionId).push(r)
}
const groups = [...bySession.entries()]
  .map(([sid, recs]) => {
    const meta = sessMeta.get(sid) ?? { count: recs.length, tokens: recs.reduce((s, r) => s + r.tokens, 0) }
    return {
      sessionId: sid,
      own: recs.some((r) => r.own),
      shown: recs.length,
      count: meta.count,
      tokens: meta.tokens,
      records: recs
        .map((r) => ({ id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind] ?? r.kind, turnFrom: r.turnFrom, turnTo: r.turnTo, tokens: r.tokens, text: r.text, createdAt: r.createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt || (a.turnFrom - b.turnFrom)),
    }
  })
  .sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0) || b.tokens - a.tokens)

// 当前轮 = 骨架里最后一条覆盖的轮次（抽取时刻的真实末端）。
const CURRENT_TURN = Math.max(...DATA.mainline.map((m) => Math.max(m.turn, m.turnTo ?? m.turn)))

const PAYLOAD = {
  meta: {
    sessionId: DATA.meta.sessionId,
    shortId: DATA.meta.sessionId.replace(/^session-/, '').slice(0, 8),
    extractedAt: DATA.meta.extractedAt,
    turnCount: DATA.meta.turnCount,
    currentTurn: CURRENT_TURN,
    logBytes: DATA.meta.logBytes,
    frames: DATA.meta.frames,
    events: DATA.meta.events,
    eventTypes: DATA.eventTypes.slice(0, 12),
  },
  taskTitle: DATA.taskTitle,
  mainline: DATA.mainline,
  mainlineTokens: DATA.mainlineTokens,
  l2: {
    turnFrom: DATA.l2.turnFrom,
    turnTo: DATA.l2.turnTo,
    mode: DATA.l2.mode,
    chars: DATA.l2.chars,
    shadowedTokenCount: DATA.l2.shadowedTokenCount,
    totalSummaries: DATA.l2.totalSummaries,
    atSeq: DATA.l2.atSeq,
    sections: l2Sections,
  },
  l3: {
    backend: DATA.l3.backend,
    count: DATA.l3.count,
    tokens: DATA.l3.tokens,
    sessionCount: DATA.l3.sessionCount,
    sessionTokens: DATA.l3.sessionTokens,
    viewRecords: DATA.l3.records.length,
    shownRecords: groups.reduce((s, g) => s + g.shown, 0),
    droppedRecords,
    sessionTotal: DATA.l3.sessions.length,
    kindQuota: KIND_QUOTA,
    groups,
  },
}
writeFileSync(new URL('./_payload.json', import.meta.url), JSON.stringify(PAYLOAD), 'utf8')
console.error(`[payload] mainline=${PAYLOAD.mainline.length} l2sections=${l2Sections.length} l3groups=${groups.length} l3shown=${PAYLOAD.l3.shownRecords}/${DATA.l3.records.length} bytes=${JSON.stringify(PAYLOAD).length}`)
console.error(`[payload] own group records=${groups.find((g) => g.own)?.records.length} other groups=${groups.filter((g) => !g.own).length}`)
