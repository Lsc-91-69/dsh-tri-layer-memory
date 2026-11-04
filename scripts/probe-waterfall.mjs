#!/usr/bin/env node
/**
 * probe-waterfall.mjs — 三层压缩的**token 瀑布**与**信息去向**（只读）。
 *
 * 为什么单独一个脚本：`verify-compression.mjs` 回答"省了多少 / 召回如何"，但它的
 * 数字是"最近 8 轮 vs 全量"的**两个点**；本脚本要的是**逐级**的箭头——
 * 原始 → L1 → L2 → L3 → 注入，每一级都写清分子分母，避免再出现"口径混算"。
 *
 * 口径纪律（每一级都只用自己的分子分母，不跨级复用）：
 *   1. **原始会话**：会话日志里全部事件的正文。再拆成三份：
 *      - 本插件投影（`source.kind = dsh-tri-layer-memory`）——注入物，不是对话；
 *      - 推理块 + 序列化开销——不进下一轮；
 *      - 真实对话正文 = user/assistant/tool-result 的 text 块（`contentToText` 口径）
 *        + `tool/call` 的参数（宿主会重放调用参数，所以算对话）。
 *   2. **L1 窗口**：用生产 `projectWorkingWindow(events, 8)` 的 `tokens`
 *      （只含真实对话正文，投影已被排除），另报"物理面"= 正文 + 调用参数 + 历史投影。
 *   3. **L2 摘要**：读诊断/最后一条投影里 L2 块的实际 token（一份摘要，不是累计）。
 *      分母是它覆盖区间（turn 77–100）的对话正文。
 *   4. **L3 库**：读 sqlite 里**本会话**的记录，按 kind 分开报 token。
 *      分母是 L3 负责的那段（turn 0–76）的对话正文。
 *   5. **注入合计**：诊断 `injection` 块（L1+L2+L3+骨架），与最后一条投影交叉核对。
 *
 * 用法：
 *   node scripts/probe-waterfall.mjs --session <id> [--db .tmp-probe/deep-memory.sqlite]
 *   node scripts/probe-waterfall.mjs --log .tmp-probe/session-xxx.v4.jsonl.zstd
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  contentToText,
  estimateTokens,
  messageBody,
  projectTurns,
  projectWorkingWindow,
} from '../src/host/l1-working.ts'
import { DEFAULTS } from '../src/host/config-core.ts'
import { FACTS } from './probes.mjs'

const require = createRequire(import.meta.url)
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SESSIONS = join(HOME, 'sessions')
const TRI = join(HOME, 'tri-layer-memory')
const DB = join(TRI, 'deep-memory.sqlite')
const PLUGIN = 'dsh-tri-layer-memory'
const PROJECTION_HEAD = '# 三层记忆 · 本轮投影'

function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const events = []
  let frames = 0
  let bad = 0
  const magic = (at) => buf[at] === 0x28 && buf[at + 1] === 0xb5 && buf[at + 2] === 0x2f && buf[at + 3] === 0xfd
  let i = 0
  while (i + 4 <= buf.length) {
    if (!magic(i)) { bad += 1; i += 1; continue }
    let next = i + 4
    while (next + 4 <= buf.length && !magic(next)) next += 1
    try {
      const text = require('node:zlib').zstdDecompressSync(buf.subarray(i, next)).toString('utf8')
      frames += 1
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try { events.push(JSON.parse(t)) } catch { /* 非 JSON 行忽略 */ }
      }
    } catch { bad += 1 }
    i = next
  }
  return { events, frames, bad }
}

/** 一条事件里"对话正文"的 token（与插件 L1 同口径：只取 text 块）。 */
function messageTokens(ev) {
  if (ev.type === 'user/message') return estimateTokens(contentToText(messageBody(ev.data ?? {})))
  if (ev.type === 'assistant/message' || ev.type === 'tool/result') {
    return estimateTokens(contentToText(messageBody(ev.data ?? {})))
  }
  return 0
}

/** `tool/call` 的参数（宿主重放调用参数，所以算"对话"）。 */
function callTokens(ev) {
  if (ev.type !== 'tool/call') return 0
  const d = ev.data ?? {}
  return estimateTokens(`${d.name ?? ''} ${JSON.stringify(d.arguments ?? d.input ?? '')}`)
}

/** 事件正文（旧脚本口径：含推理块、含投影；用于与历史数字对齐）。 */
function eventText(ev) {
  const d = ev.data ?? {}
  if (ev.type === 'user/message') return typeof d.content === 'string' ? d.content : JSON.stringify(d.content ?? '')
  if (ev.type === 'assistant/message' || ev.type === 'tool/result') {
    const c = d.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n')
  }
  if (ev.type === 'tool/call') return `${d.name ?? ''} ${JSON.stringify(d.arguments ?? d.input ?? '')}`
  return ''
}

function isProjection(ev) {
  if (ev.type !== 'user/message') return false
  if (ev.data?.source?.kind === PLUGIN) return true
  return eventText(ev).startsWith(PROJECTION_HEAD)
}

/** 读 L3 记录（sqlite 只读，失败退回 JSONL）。 */
function loadRecords(dbPath) {
  if (existsSync(dbPath)) {
    try {
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare('SELECT * FROM records ORDER BY createdAt ASC').all()
      db.close()
      return {
        backend: 'sqlite',
        records: rows.map((row) => ({
          id: String(row.id),
          kind: String(row.kind),
          sessionId: String(row.sessionId),
          turnFrom: Number(row.turnFrom),
          turnTo: Number(row.turnTo),
          text: String(row.text),
          tokens: Number(row.tokens),
        })),
      }
    } catch { /* 退回 JSONL */ }
  }
  const jsonl = join(TRI, 'deep-memory.jsonl')
  if (!existsSync(jsonl)) return { backend: null, records: [] }
  return {
    backend: 'jsonl',
    records: readFileSync(jsonl, 'utf8').split(/\r?\n/).filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r?.id !== undefined),
  }
}

function readDiagnostics(sid) {
  const path = join(TRI, `${sid}.diagnostics.json`)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function pickSession(explicit, logOverride) {
  if (logOverride !== undefined) {
    // 从日志路径反推会话 id（父目录名就是 `<sessionId>`），`--log` 也能打出真实 id。
    return { id: explicit ?? basename(dirname(resolve(logOverride))), log: logOverride }
  }
  const found = []
  for (const wk of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, wk)
    if (!statSync(dir).isDirectory()) continue
    for (const s of readdirSync(dir)) {
      const log = join(dir, s, 'session.v4.jsonl.zstd')
      if (!existsSync(log)) continue
      if (explicit !== undefined && s !== explicit) continue
      found.push({ id: s, log, mtime: statSync(log).mtimeMs })
    }
  }
  if (explicit !== undefined) return found[0] ?? null
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0] ?? null
}

function main() {
  const argv = process.argv.slice(2)
  const sessionArg = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : undefined
  const logArg = argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : undefined
  const dbArg = argv.includes('--db') ? argv[argv.indexOf('--db') + 1] : DB
  const picked = pickSession(sessionArg, logArg)
  if (picked === null) { console.error('找不到会话日志'); process.exit(2) }

  const { events, frames, bad } = decodeSessionLog(picked.log)
  const spans = projectTurns(events)
  const window = projectWorkingWindow(events, DEFAULTS.l1RetainTurns)
  const diag = readDiagnostics(picked.id)
  const promptStat = promptStats(events)
  const promptFirst = promptStat.first
  const promptLast = promptStat.last

  // ── 1) 原始会话：三份拆解 ─────────────────────────────────────────
  let rawLogTokens = 0
  let msgTokens = 0
  let callTok = 0
  let projTok = 0
  let projCount = 0
  const projTexts = []
  for (const ev of events) {
    rawLogTokens += estimateTokens(eventText(ev))
    if (isProjection(ev)) {
      const body = contentToText(ev.data?.content)
      projTok += estimateTokens(body)
      projCount += 1
      projTexts.push(body)
      continue
    }
    msgTokens += messageTokens(ev)
    callTok += callTokens(ev)
  }
  const conversation = msgTokens + callTok
  const other = rawLogTokens - conversation - projTok

  // ── 2) 各级区间的对话正文（插件 L1 口径：span.tokens，不含调用参数） ──
  const hotTurns = new Set(window.hot.map((s) => s.turn))
  const evictedTurns = window.evicted.map((s) => s.turn)
  // L2 覆盖区间：从最后一条投影的 L2 块读（没有就按 l2RetainTurns 推）。
  const lastProj = projTexts.at(-1) ?? ''
  const l2Range = /覆盖 turn (\d+)[–-](\d+)/.exec(lastProj)
  const l2From = l2Range === null ? null : Number(l2Range[1])
  const l2To = l2Range === null ? null : Number(l2Range[2])
  const inL2 = (t) => l2From !== null && t >= l2From && t <= l2To
  const sumTurns = (pick) => spans.filter((s) => pick(s.turn)).reduce((a, s) => a + s.tokens, 0)

  const l1Raw = sumTurns((t) => hotTurns.has(t))
  const l2Source = sumTurns((t) => inL2(t))
  const l3Source = sumTurns((t) => !hotTurns.has(t) && !inL2(t) && t >= 0)
  // L1 窗口的物理面：正文 + 调用参数 + 该窗口里的历史投影
  const recentFrom = window.hot[0]?.turn ?? 0
  let l1Call = 0
  let l1Proj = 0
  let l1ProjCount = 0
  for (const ev of events) {
    const turn = turnAtSeq.get(ev.seq)
    if (turn === undefined || turn < recentFrom) continue
    if (isProjection(ev)) { l1Proj += estimateTokens(contentToText(ev.data?.content)); l1ProjCount += 1 } else l1Call += callTokens(ev)
  }

  // ── 3) L2 摘要的 token（诊断优先，投影块兜底） ────────────────────
  const l2Block = /## L2 短期记忆（Short-term Memory）([\s\S]*?)(?=## L3 深层记忆|$)/.exec(lastProj)?.[1] ?? ''
  const l2Tokens = l2Block.length === 0 ? null : estimateTokens(`## L2 短期记忆（Short-term Memory）${l2Block}`)

  // ── 4) L3：本会话记录 ────────────────────────────────────────────
  const { backend, records } = loadRecords(dbArg)
  const own = records.filter((r) => r.sessionId === picked.id)
  const kinds = {}
  for (const r of own) {
    const slot = kinds[r.kind] ?? (kinds[r.kind] = { count: 0, tokens: 0 })
    slot.count += 1
    slot.tokens += r.tokens
  }
  const l3OwnTokens = own.reduce((a, r) => a + r.tokens, 0)
  const l3AllTokens = records.reduce((a, r) => a + r.tokens, 0)

  // ── 5) 注入合计（诊断）───────────────────────────────────────────
  const inj = diag?.injection ?? null
  const injected = inj === null ? null : inj.l1Tokens + inj.l2Tokens + inj.l3Tokens + inj.mainlineTokens

  // ── 6) 事实去向：每条探针最后落在哪一层 ──────────────────────────
  // 口径：**子串命中**。L1 = 最近 8 轮正文；L2 = 最后一条投影的 L2 块正文；
  // L3 = 本会话记录正文；都不是 = 丢（对"只出现在某轮"的事实，这一列才有意义）。
  const byTurnText = new Map()
  let cur = -1
  for (const ev of events) {
    if (ev.type === 'turn/start') { cur = ev.data?.turn ?? cur + 1; continue }
    if (isProjection(ev)) continue
    const text = messageTokens(ev) > 0 ? contentToText(messageBody(ev.data ?? {})) : eventText(ev)
    if (!text) continue
    byTurnText.set(cur, (byTurnText.get(cur) ?? '') + '\n' + text)
  }
  const factRows = FACTS.map((fact) => {
    const probe = fact.probe.toLowerCase()
    const turns = [...byTurnText.entries()].filter(([, text]) => text.toLowerCase().includes(probe)).map(([t]) => t)
    const inL1 = turns.some((t) => t >= recentFrom)
    const inL2 = l2Block.toLowerCase().includes(probe)
    const l3Hits = own.filter((r) => r.text.toLowerCase().includes(probe))
    return {
      key: fact.key,
      turns,
      inL1,
      inL2,
      l3Hits: l3Hits.length,
      layer: inL1 ? 'L1' : inL2 ? 'L2' : l3Hits.length > 0 ? 'L3' : (turns.length > 0 ? '丢失' : '从未出现'),
    }
  })

  // ── 输出 ──
  const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString())
  const ratio = (a, b) => (a === null || b === null || b === 0 ? '—' : `${(a / b).toFixed(1)}×`)
  const p = (s = '') => console.log(s)
  p(`# token 瀑布`)
  p()
  p(`会话 \`${picked.id}\` · ${frames} 帧（坏 ${bad}）· ${events.length} 事件 · ${spans.filter((s) => s.turn >= 0).length} 轮`)
  p()
  p('```')
  p(`原始会话（全量事件正文）                    ${num(rawLogTokens).padStart(9)} tok`)
  p(`  ├ 本插件历次投影（注入物，非对话）        ${num(projTok).padStart(9)} tok  ${projCount} 条 / 平均 ${Math.round(projTok / Math.max(1, projCount))}`)
  p(`  ├ 推理块 + 序列化（不进下一轮）           ${num(other).padStart(9)} tok`)
  p(`  └ 真实对话正文（消息 text + 调用参数）    ${num(conversation).padStart(9)} tok`)
  p(`        ├ 其中消息 text 块                  ${num(msgTokens).padStart(9)} tok`)
  p(`        └ 其中 tool/call 参数               ${num(callTok).padStart(9)} tok`)
  p(`              ↓ 进 L1 窗口（最近 ${DEFAULTS.l1RetainTurns} 轮：turn ${window.hot[0]?.turn}–${window.hot.at(-1)?.turn}）`)
  p(`L1 窗口（真实对话正文，插件口径）           ${num(l1Raw).padStart(9)} tok   ← ${ratio(msgTokens, l1Raw)}（相对消息正文）`)
  p(`  其中 tool/call 参数                       ${num(l1Call).padStart(9)} tok`)
  p(`  其中历史投影（物理留在 surface）          ${num(l1Proj).padStart(9)} tok  ${l1ProjCount} 条`)
  p(`  L1 窗口物理面（正文+参数+投影）           ${num(l1Raw + l1Call + l1Proj).padStart(9)} tok`)
  p(`              ↓ 溢出的进 L2（保留 ${DEFAULTS.l2RetainTurns} 轮）`)
  p(`L2 摘要（1 份，覆盖 turn ${l2From ?? '—'}–${l2To ?? '—'}）          ${num(l2Tokens).padStart(9)} tok   ← ${ratio(l2Source, l2Tokens)}（相对被覆盖轮正文）`)
  p(`  被覆盖轮的对话正文（分母）                ${num(l2Source).padStart(9)} tok`)
  p(`              ↓ 更早的进 L3`)
  p(`L3 库（本会话 ${own.length} 条）                       ${num(l3OwnTokens).padStart(9)} tok   ← ${ratio(l3Source, l3OwnTokens)}（相对 L3 负责轮正文）`)
  for (const [kind, slot] of Object.entries(kinds)) {
    p(`    ${kind.padEnd(10)} ${String(slot.count).padStart(4)} 条 / ${num(slot.tokens).padStart(8)} tok`)
  }
  p(`  L3 负责轮的对话正文（分母）               ${num(l3Source).padStart(9)} tok`)
  p(`L3 整库（跨会话 ${records.length} 条）                 ${num(l3AllTokens).padStart(9)} tok（后端 ${backend ?? '未打开'}）`)
  p(`              ↓ 每轮实际注入`)
  p(`注入合计（L1 块 + L2 + L3 + 骨架）          ${num(injected).padStart(9)} tok   ← ${ratio(conversation, injected)}（相对全部对话正文）`)
  p(`    L1 块 ${num(inj?.l1Tokens)} · L2 块 ${num(inj?.l2Tokens)} · L3 块 ${num(inj?.l3Tokens)} · 骨架 ${num(inj?.mainlineTokens)}`)
  p('```')
  p()
  p(`> **箭头上的压缩比**（分子/分母写清，不跨级复用）：`)
  p(`> - 对话正文 → L1：${num(msgTokens)} / ${num(l1Raw)} = **${ratio(msgTokens, l1Raw)}**（消息正文口径）`)
  p(`> - L2 覆盖轮 → L2 摘要：${num(l2Source)} / ${num(l2Tokens)} = **${ratio(l2Source, l2Tokens)}**`)
  p(`> - L3 负责轮 → L3 本会话：${num(l3Source)} / ${num(l3OwnTokens)} = **${ratio(l3Source, l3OwnTokens)}**`)
  p(`> - 全部对话 → 每轮注入：${num(conversation)} / ${num(injected)} = **${ratio(conversation, injected)}**`)
  p()
  p(`## 关键事实的最终落点（子串口径，${FACTS.length} 条探针）`)
  p()
  p(`| 事实 | 出现过的轮 | 落点 | L3 命中条数 |`)
  p(`|---|---|---|---:|`)
  for (const row of factRows) {
    p(`| ${row.key} | ${row.turns.length === 0 ? '—' : row.turns.slice(0, 6).join(',')}${row.turns.length > 6 ? '…' : ''} | **${row.layer}** | ${row.l3Hits} |`)
  }
  const lost = factRows.filter((r) => r.layer === '丢失')
  p()
  p(`> 落点判定顺序：最近 ${DEFAULTS.l1RetainTurns} 轮正文 → L2 摘要块 → 本会话 L3 记录 → 丢失。`)
  p(`> **"丢失"= 曾经在对话里出现过、但既不在 L1 窗口、也不在 L2 摘要、也不在 L3**——`)
  p(`> 这正是"看起来在工作、实际没记住"的形态，${lost.length} 条：${lost.map((r) => r.key).join('、') || '无'}`)
  p()
  p(`## 净影响`)
  p()
  p(`- 插件每轮注入：**${num(injected)} tok**（诊断 \`injection\` 块，实测）`)
  p(`- 插件写进会话日志的投影累计：**${num(projTok)} tok**（${projCount} 条，全是 user/message）`)
  p(`- 它"代表"掉的历史（L1 窗口之外的对话正文）：**${num(conversation - l1Raw)} tok**`)
  p(`- 但宿主**并不知道** L2/L3 存在：它不会因此少发历史。宿主报告的真实 prompt`)
  p(`  （\`inputTokens + cacheReadTokens\`）从 turn ${promptFirst.turn} 的 ${num(promptFirst.prompt)} 涨到`)
  p(`  turn ${promptLast.turn} 的 ${num(promptLast.prompt)}——**增长 ${num(promptLast.prompt - promptFirst.prompt)} tok，压缩没有作用到主上下文**。`)
  p()
  p(`> 口径提醒：宿主 prompt 的锯齿来自**宿主自己的 compaction**（本会话 3 次：turn 24/55/81），`)
  p(`> 不是三层记忆的功劳。三层记忆既不删会话事件，也不接管 \`ctx.compaction\`。`)
}

/** 宿主报告的 prompt（input + cacheRead），按轮取最大，返回最早/最晚两个轮。 */
function promptStats(events) {
  const perTurn = new Map()
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const u = ev.data?.usage
    if (u === undefined) continue
    const prompt = (typeof u.inputTokens === 'number' ? u.inputTokens : 0)
      + (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0)
    if (prompt <= 0) continue
    const turn = typeof ev.data?.turn === 'number' ? ev.data.turn : null
    if (turn === null) continue
    // 同一轮多步取**最大**：第一次调用的 prompt 往往还是半截上下文。
    const prev = perTurn.get(turn)
    if (prev === undefined || prompt > prev) perTurn.set(turn, prompt)
  }
  const turns = [...perTurn.keys()].sort((a, b) => a - b)
  if (turns.length === 0) return { first: { turn: '—', prompt: 0 }, last: { turn: '—', prompt: 0 } }
  return {
    first: { turn: turns[0], prompt: perTurn.get(turns[0]) },
    last: { turn: turns.at(-1), prompt: perTurn.get(turns.at(-1)) },
  }
}

// 事件 seq → 轮号（与 probe-triggers 同一套 turn/start 边界）。
const turnAtSeq = new Map()
function fillTurnAtSeq(events) {
  let current = -1
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      current = typeof ev.data?.turn === 'number' ? ev.data.turn : current + 1
      if (typeof ev.seq === 'number') turnAtSeq.set(ev.seq, current)
      continue
    }
    if (typeof ev.seq === 'number' && current >= 0) turnAtSeq.set(ev.seq, current)
  }
}

const _decode = decodeSessionLog
// main 里需要先填 turnAtSeq：包一层，避免在两个脚本里各写一份归属规则。
decodeSessionLog = function decodeAndFill(path) {
  const out = _decode(path)
  fillTurnAtSeq(out.events)
  return out
}

main()
