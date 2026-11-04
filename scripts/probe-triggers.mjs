#!/usr/bin/env node
/**
 * probe-triggers.mjs — 实测三层压缩的**触发时间线**与**长期增长趋势**（只读）。
 *
 * 这个脚本回答两件事，都要求"实测"而不是"读代码"：
 *
 *  A. 每一层到底在第几轮被触发？判据是生产代码里的那几个函数，不是本脚本复写的一份。
 *     - L1：{@link projectWorkingWindow}（`src/host/l1-working.ts`）—— 哪些轮留在窗口、
 *       哪些落到 `evicted`。
 *     - L2：`refreshDigest` 里 1849–1855 行的四步判定（evicted → forL2 → uncovered →
 *       `l2MinTurnsBeforeSummary` / `l2RefreshIntervalMs`）。那段是 async 函数的一部分
 *       （要调 LLM），无法直接 import；本脚本把**判定本身**按行照搬成纯状态机，并用
 *       日志里真实投影的 L2 覆盖区间与它逐轮对账（见 `--verify` 一节）——对不上就是
 *       判据漂移，必须报出来。
 *     - L3：同一函数 1758/1834 行：`overflowCount = evicted.length - l2RetainTurns`，
 *       只蒸馏 `evicted.slice(0, overflowCount)` 中 `turn > l3HighWaterTurn` 的轮。
 *
 *  B. 注入量随轮数怎么长？三种口径分开量，绝不混算：
 *     1. **注入块**（每轮新写进请求的那一条投影消息）：L1 marker + L2 摘要 + L3 索引
 *        + 主线骨架。这是"插件每轮花掉多少"。
 *     2. **历史投影累计**：历次投影都是 `user/message`，物理留在会话日志/surface 里，
 *        除非被宿主的 compaction 遮蔽。这是"插件一共往上下文里塞了多少"。
 *     3. **宿主报告的 inputTokens**（`assistant/message.data.usage`）：真实请求的大小，
 *        不经过任何估算函数。三者并排，才能说清"压缩到底是不是真的"。
 *
 * 数据来源：把会话日志 copy 到 `.tmp-probe/`（本脚本不碰真库、不写 src）。日志是
 * 多帧 zstd 拼接；解码逻辑与 `verify-compression.mjs` 同源（那是 I/O，不是判据）。
 *
 * 用法：
 *   node scripts/probe-triggers.mjs                       # 自动挑最新会话
 *   node scripts/probe-triggers.mjs --session <id>
 *   node scripts/probe-triggers.mjs --log .tmp-probe/session-xxx.v4.jsonl.zstd
 *   node scripts/probe-triggers.mjs --all                 # 打印全部 110 行（默认只打拐点）
 *   node scripts/probe-triggers.mjs --md > timeline.md    # 输出 Markdown
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  estimateTokens,
  projectTurns,
  projectWorkingWindow,
  renderWorkingMemory,
} from '../src/host/l1-working.ts'
import { DEFAULTS } from '../src/host/config-core.ts'
import { renderShortTermMemory } from '../src/host/l2-render.ts'

const require = createRequire(import.meta.url)
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SESSIONS = join(HOME, 'sessions')
const PLUGIN = 'dsh-tri-layer-memory'
const PROJECTION_HEAD = '# 三层记忆 · 本轮投影'

// 注入块的块头。与 budget.ts 的顺序一致（L1 → 骨架 → L2 → L3）。
const BLOCK_HEADERS = {
  l1: '## L1 工作记忆',
  mainline: '## 里程碑主线骨架',
  l2: '## L2 短期记忆',
  l3: '## L3 深层记忆',
}

/** 事件 seq → 轮号（由 {@link fillTurnOfSeq} 填充）。 */
const turnOfSeq = new Map()

// ───────────────────────── 日志解码（I/O）─────────────────────────

/**
 * DSH 的 session.v4.jsonl.zstd 是**多个 zstd 帧拼接**，不是单个流。
 * 按 magic（28 B5 2F FD）切帧、逐帧解压、拼回事件数组。
 */
function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const events = []
  let i = 0
  let frames = 0
  let bad = 0
  const magic = (at) => buf[at] === 0x28 && buf[at + 1] === 0xb5 && buf[at + 2] === 0x2f && buf[at + 3] === 0xfd
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

// ───────────────────────── 投影解析 ─────────────────────────

/** 从投影全文切出四个块（缺哪个返回 null）。 */
function splitProjection(text) {
  const found = Object.entries(BLOCK_HEADERS)
    .map(([id, header]) => ({ id, at: text.indexOf(header) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
  const out = { l1: null, mainline: null, l2: null, l3: null }
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].at : text.length
    out[found[i].id] = text.slice(found[i].at, end).replace(/\s+$/, '')
  }
  return out
}

/** L1 块自报的"估算占用"（窗口里真实对话的 token，插件自己算的）。 */
function declaredL1Tokens(l1) {
  const m = /估算占用：约 (\d+) tokens/.exec(l1 ?? '')
  return m === null ? null : Number(m[1])
}

/** L1 块自报的窗口轮数（"最近 N 轮真实对话"）。 */
function declaredL1Turns(l1) {
  const m = /最近 (\d+) 轮真实对话/.exec(l1 ?? '')
  return m === null ? null : Number(m[1])
}

/** L2 块自报的覆盖区间；没有摘要时返回 null。 */
function declaredL2Range(l2) {
  const m = /覆盖 turn (\d+)[–-](\d+)/.exec(l2 ?? '')
  return m === null ? null : { from: Number(m[1]), to: Number(m[2]) }
}

/** L2 块自报的生成方式（llm / extractive）与压缩比。 */
function declaredL2Meta(l2) {
  const via = /生成方式 (\w+)/.exec(l2 ?? '')
  const ratio = /压缩比约 ([\d.]+)x/.exec(l2 ?? '')
  return { via: via === null ? null : via[1], ratio: ratio === null ? null : Number(ratio[1]) }
}

// ───────────────────────── 逐轮状态机 ─────────────────────────

/**
 * 在某个 seq 处切一份会话前缀，用**生产函数**算 L1 窗口。
 *
 * 为什么按 seq 切而不是按 turn 号：`pre-step` 发生在新一轮 `turn/start` 之后、
 * 该轮消息之前。按 `turn/start` 的 seq 切，窗口里恰好是"到上一轮为止"的对话，
 * 与当时注入的投影逐字对齐。
 *
 * @param events - 全量事件。
 * @param seq - 切点（含该 seq 之前的事件）。
 * @returns L1 投影。
 */
function windowAt(events, seq) {
  return projectWorkingWindow(events.slice(0, seq + 1), DEFAULTS.l1RetainTurns)
}

/**
 * L2 触发判定（照搬 `refreshDigest` 1849–1855 行）。
 *
 * 原文：
 *   const forL2 = evicted.slice(overflowCount)
 *   const uncovered = state.digest === null ? forL2
 *     : forL2.filter((span) => span.turn > state.digest.turnTo)
 *   if (uncovered.length < settings.l2MinTurnsBeforeSummary) return
 *   if (settings.l2RefreshIntervalMs > 0 && now - state.lastDigestAt < settings.l2RefreshIntervalMs) return
 *
 * 这里把 `state` 换成显式的 `digestTo`（当前摘要覆盖到的最后一轮），其余逐字保留。
 * 为什么照搬而不是 import：`refreshDigest` 是闭包里调 LLM 的 async 函数，没有导出；
 * 判定本身只有三行，照搬后**必须与日志里真实的覆盖区间对账**（见 verifyReplay）。
 *
 * @param evicted - 已溢出 L1 的轮。
 * @param digestTo - 当前摘要覆盖到的最后一轮；null = 尚无摘要。
 * @returns 是否触发、触发时将被覆盖的轮。
 */
function l2Decision(evicted, digestTo) {
  const overflowCount = Math.max(0, evicted.length - DEFAULTS.l2RetainTurns)
  const forL2 = evicted.slice(overflowCount)
  const uncovered = digestTo === null ? forL2 : forL2.filter((span) => span.turn > digestTo)
  const triggered = uncovered.length >= DEFAULTS.l2MinTurnsBeforeSummary
  return { overflowCount, forL2, uncovered, triggered }
}

/**
 * L3 蒸馏判定（照搬 `refreshDigest` 1758 / 1834 行）。
 *
 * 原文只蒸馏 `evicted.slice(0, overflowCount)` 里 `turn > l3HighWaterTurn` 的轮，
 * 并把水位推到这些轮的最大 turn。**注意 `l2Mode === 'off'` 时整个函数在 1750 行就
 * return 了**，L3 这一步根本不会执行——这是级联停摆，脚本会把它标出来。
 */
function l3Decision(evicted, highWater) {
  const overflowCount = Math.max(0, evicted.length - DEFAULTS.l2RetainTurns)
  const spans = evicted.slice(0, overflowCount)
  const fresh = spans.filter((span) => span.turn > highWater)
  return { overflowCount, spans, fresh, nextHighWater: fresh.length === 0 ? highWater : fresh[fresh.length - 1].turn }
}

/**
 * 宿主 compaction 遮蔽了多少 seq。
 *
 * 投影是 `user/message`，会物理留在 surface 里；但宿主的 compaction 会把旧消息
 * shadow 掉。不扣掉这部分，"插件一共占了多少上下文"就会重复计入已被遗忘的内容。
 */
function shadowedSeqs(events) {
  const out = new Set()
  for (const ev of events) {
    if (ev.type !== 'compaction/prune') continue
    const seqs = ev.data?.shadowedSeqs
    if (Array.isArray(seqs)) for (const s of seqs) if (typeof s === 'number') out.add(s)
  }
  return out
}

/**
 * 宿主报告的真实 prompt 体量：`inputTokens + cacheReadTokens`。
 *
 * **为什么要加 cacheRead**：适配器把"缓存命中"的输入单独记账，只读 `inputTokens`
 * 会把它当成"这一轮只发了 5k token"。实测本会话最后一轮 `inputTokens=5,188`、
 * `cacheReadTokens=796,416`——真实 prompt 是 80 万，不是 5 千。两个数必须相加，
 * 否则"压缩到底有没有用"会得出相反的结论。
 *
 * 同一轮多步取**最大值**（该轮结束时上下文最大）。
 */
function promptByTurn(events) {
  const out = new Map()
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const usage = ev.data?.usage
    const input = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0
    const cache = typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
    const prompt = input + cache
    if (prompt <= 0) continue
    const turn = typeof ev.data?.turn === 'number' ? ev.data.turn : null
    if (turn === null) continue
    const prev = out.get(turn)
    if (prev === undefined || prompt > prev.prompt) out.set(turn, { prompt, input, cache })
  }
  return out
}

// ───────────────────────── 主流程 ─────────────────────────

function pickSession(explicit, logOverride) {
  if (logOverride !== undefined) {
    // 从日志路径反推会话 id（父目录名就是 `<sessionId>`）。目录名不像会话 id 时
    // （例如把日志 copy 到 `.tmp-probe/`），退回 `--session` 给的值。
    const dir = basename(dirname(resolve(logOverride)))
    const guess = dir.startsWith('session-') || dir.length === 36 ? dir : undefined
    return { id: explicit ?? guess ?? basename(logOverride), log: logOverride }
  }
  if (!existsSync(SESSIONS)) return null
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

/**
 * 事件 seq → 所属轮号。
 *
 * 投影消息（`user/message`）本身不带 `turn` 字段，只能按 `turn/start` 的 seq 区间
 * 反查归属。这与 `projectTurns` 的归属规则同源（同一套 turn/start 边界）。
 *
 * @param events - 全量事件（按 seq 升序）。
 */
function fillTurnOfSeq(events) {
  let current = -1
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      current = typeof ev.data?.turn === 'number' ? ev.data.turn : current + 1
      if (typeof ev.seq === 'number') turnOfSeq.set(ev.seq, current)
      continue
    }
    if (typeof ev.seq === 'number' && current >= 0) turnOfSeq.set(ev.seq, current)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const sessionArg = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : undefined
  const logArg = argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : undefined
  const all = argv.includes('--all')

  const picked = pickSession(sessionArg, logArg)
  if (picked === null) {
    console.error('找不到会话日志（$DSH_HOME/sessions/*/<id>/session.v4.jsonl.zstd），或用 --log 指定')
    process.exit(2)
  }
  const { events, frames, bad } = decodeSessionLog(picked.log)
  fillTurnOfSeq(events)
  const spans = projectTurns(events)

  // 1) 真实投影：按轮索引该轮**最后一条**（一轮可能多步，每步注入一次）。
  //    同时按轮累加"该轮一共注入了多少"——一轮多步时这个数才是真实的成本。
  const projByTurn = new Map()
  const projAgg = new Map()
  let projTotal = 0
  let projTokensTotal = 0
  for (const ev of events) {
    if (ev.type !== 'user/message') continue
    const kind = ev.data?.source?.kind
    if (kind !== PLUGIN) continue
    const text = Array.isArray(ev.data?.content)
      ? ev.data.content.map((b) => b?.text ?? '').join('\n')
      : String(ev.data?.content ?? '')
    if (!text.startsWith(PROJECTION_HEAD)) continue
    const tok = estimateTokens(text)
    projTotal += 1
    projTokensTotal += tok
    const turn = turnOfSeq.get(ev.seq) ?? null
    if (turn === null) continue
    projByTurn.set(turn, { seq: ev.seq, text, tokens: tok, blocks: splitProjection(text) })
    const agg = projAgg.get(turn) ?? { count: 0, tokens: 0 }
    agg.count += 1
    agg.tokens += tok
    projAgg.set(turn, agg)
  }

  // 2) 逐轮回放：在每轮 `turn/start` 处切前缀，用生产函数算 L1，再推 L2/L3 状态。
  //    这里还记录"该轮真实投影"的读数，用于对账。
  const rows = []
  let digestTo = null
  let highWater = -1
  let l2Calls = 0
  let l3Fresh = 0
  for (const span of spans) {
    if (span.turn < 0) continue
    const w = windowAt(events, span.startSeq)
    const l3 = l3Decision(w.evicted, highWater)
    const l2 = l2Decision(w.evicted, digestTo)
    // 先算 L3（真实实现里 L3 在 L2 判定之前），再算 L2。
    if (l3.fresh.length > 0) {
      highWater = l3.nextHighWater
      l3Fresh += l3.fresh.length
    }
    let l2TriggeredThisTurn = false
    if (l2.triggered) {
      digestTo = l2.uncovered[l2.uncovered.length - 1].turn
      l2Calls += 1
      l2TriggeredThisTurn = true
    }
    const proj = projByTurn.get(span.turn) ?? null
    const agg = projAgg.get(span.turn) ?? { count: 0, tokens: 0 }
    // 用**投影自己的 seq** 再切一次前缀：投影是"该步 pre-step 注入"的那份文本，
    // 只有切在同一 seq 上，重算值才应该与它逐字相等。用轮首 seq 切会差几百到几万
    // token（轮中又写入了消息），那种差是口径差，不是判据错。
    const atProj = proj === null ? null : windowAt(events, proj.seq)
    rows.push({
      turn: span.turn,
      hot: w.hot.length,
      dialogueTurns: w.dialogueTurns,
      l1Tokens: w.tokens,
      evicted: w.evicted.length,
      evictedNow: Math.max(0, w.evicted.length - (rows.at(-1)?.evicted ?? 0)),
      l2Triggered: l2TriggeredThisTurn,
      l2Calls,
      digestTo,
      l3HighWater: highWater,
      l3Fresh: l3.fresh.length,
      l2Uncovered: l2.uncovered.length,
      proj,
      projCount: agg.count,
      projTurnTokens: agg.tokens,
      projTokens: proj === null ? null : proj.tokens,
      replayDialogueTurns: atProj === null ? null : atProj.dialogueTurns,
      replayTokens: atProj === null ? null : atProj.tokens,
      projDeclaredL1: proj === null ? null : declaredL1Tokens(proj.blocks.l1),
      projDeclaredTurns: proj === null ? null : declaredL1Turns(proj.blocks.l1),
      projL2Range: proj === null ? null : declaredL2Range(proj.blocks.l2),
      projL2Meta: proj === null ? null : declaredL2Meta(proj.blocks.l2),
      projDropped: proj === null ? null
        : ['l1', 'mainline', 'l2', 'l3'].filter((id) => proj.blocks[id] === null),
    })
  }

  // 3) 关键拐点：状态**变化**的轮 + 用户点名的临界轮。
  const KEY_TURNS = new Set([3, 4, 8, 9, 10, 11, 12, 24, 25, 32, 33, 34, 56, 57])
  const keyRows = []
  let prev = null
  for (const row of rows) {
    const changed = prev === null
      || row.evicted !== prev.evicted
      || row.l2Calls !== prev.l2Calls
      || row.l3HighWater !== prev.l3HighWater
      || (row.l2Triggered !== prev.l2Triggered)
    if (changed || KEY_TURNS.has(row.turn)) keyRows.push(row)
    prev = row
  }

  // 4) 长期趋势：在 30/60/90/末轮处量"每轮注入"与"累计物理占用"。
  //    口径见文件头。历史投影累计只算**没被 compaction 遮蔽**的。
  const shadow = shadowedSeqs(events)
  const prompt = promptByTurn(events)
  const compactionTurns = events.filter((ev) => ev.type === 'compaction/start')
    .map((ev) => ev.data?.turn).filter((t) => typeof t === 'number')
  const marks = [30, 60, 90, rows.at(-1)?.turn ?? 0]
    .filter((t, i, a) => a.indexOf(t) === i && t <= (rows.at(-1)?.turn ?? 0))
  const trend = []
  for (const mark of marks) {
    let projCum = 0
    let projCount = 0
    let projShadowed = 0
    for (const ev of events) {
      if (ev.type !== 'user/message' || ev.data?.source?.kind !== PLUGIN) continue
      const t = turnOfSeq.get(ev.seq)
      if (t === null || t > mark) continue
      const text = Array.isArray(ev.data?.content) ? ev.data.content.map((b) => b?.text ?? '').join('\n') : ''
      if (!text.startsWith(PROJECTION_HEAD)) continue
      const tok = estimateTokens(text)
      projCount += 1
      if (shadow.has(ev.seq)) projShadowed += tok
      else projCum += tok
    }
    const row = rows.find((r) => r.turn === mark) ?? rows.filter((r) => r.turn <= mark).at(-1)
    const blocks = row?.proj?.blocks ?? null
    const injected = blocks === null ? null : {
      l1: estimateTokens(blocks.l1 ?? ''),
      mainline: blocks.mainline === null ? 0 : estimateTokens(blocks.mainline),
      l2: blocks.l2 === null ? 0 : estimateTokens(blocks.l2),
      l3: blocks.l3 === null ? 0 : estimateTokens(blocks.l3),
    }
    trend.push({
      mark,
      l1WindowTokens: row?.l1Tokens ?? null,
      injected,
      injectedTotal: injected === null ? null : injected.l1 + injected.mainline + injected.l2 + injected.l3,
      projCountTurn: row?.projCount ?? 0,
      projTurnTokens: row?.projTurnTokens ?? 0,
      projCount,
      projCum,
      projShadowed,
      hostPrompt: prompt.get(mark)?.prompt ?? null,
      compactions: compactionTurns.filter((t) => t <= mark).length,
    })
  }

  // 5) 对账：真实投影自报的 L1 轮数/占用 vs 生产函数重算。
  //    只对"有投影"的轮做；差值不该随版本漂移而无人发现。
  const mismatches = rows.filter((r) => r.proj !== null && r.projDeclaredL1 !== null)
    .filter((r) => r.projDeclaredL1 !== r.l1Tokens || r.projDeclaredTurns !== r.dialogueTurns)

  // ── 输出 ──
  const out = []
  const p = (line = '') => out.push(line)
  p(`# 三层压缩触发时间线`)
  p()
  p(`会话 \`${picked.id}\` · ${frames} 帧（坏 ${bad}）· ${events.length} 事件 · ${spans.filter((s) => s.turn >= 0).length} 轮`)
  p()
  p(`配置基线（生产默认值）：\`l1RetainTurns=${DEFAULTS.l1RetainTurns}\` · \`l2RetainTurns=${DEFAULTS.l2RetainTurns}\` · `
    + `\`l2MinTurnsBeforeSummary=${DEFAULTS.l2MinTurnsBeforeSummary}\` · \`l2RefreshIntervalMs=${DEFAULTS.l2RefreshIntervalMs}\` · `
    + `\`injectionBudgetTokens=${DEFAULTS.injectionBudgetTokens}\` · \`mainlineMaxTokens=${DEFAULTS.mainlineMaxTokens}\``)
  p()
  p(`> 列含义：**L1窗口** = \`projectWorkingWindow\` 的 \`dialogueTurns\`/\`tokens\`（生产函数重算）；`)
  p(`> **淘汰** = 本轮新溢出 L1 的轮数；**L2触发** = \`uncovered.length >= l2MinTurnsBeforeSummary\`；`)
  p(`> **L2覆盖** = 日志里真实投影自报的覆盖区间；**L3水位** = 重放状态机的 \`l3HighWaterTurn\`；`)
  p(`> **注入** = 该轮真实投影全文的 token（含头部行）；**丢弃** = 投影里缺失的块。`)
  p()
  p(`## 表 1 · 关键拐点（状态变化 + 临界轮）`)
  p()
  p(`| turn | L1窗口轮数 | L1 tok | 淘汰 | L2触发 | L2覆盖 | L3水位 | 该轮投影条数 | 注入 tok | 丢弃块 |`)
  p(`|---:|---:|---:|---:|:---:|:---|---:|---:|---:|:---|`)
  for (const row of (all ? rows : keyRows)) {
    const range = row.projL2Range === null ? '—' : `${row.projL2Range.from}–${row.projL2Range.to}`
    p(`| ${row.turn} | ${row.dialogueTurns} | ${row.l1Tokens.toLocaleString()} | ${row.evictedNow} | `
      + `${row.l2Triggered ? '✅' : '—'} | ${range} | ${row.l3HighWater} | `
      + `${row.projCount === 0 ? '—' : row.projCount} | `
      + `${row.projTokens === null ? '—' : row.projTokens.toLocaleString()} | `
      + `${row.projDropped === null ? '—' : (row.projDropped.length === 0 ? '无' : row.projDropped.join(','))} |`)
  }
  p()

  p(`## 表 2 · 长期趋势：注入量是恒定还是随轮数增长？`)
  p()
  p(`| 轮次 | 该轮注入条数 | 该轮注入 tok | L1块 | 骨架块 | L2块 | L3块 | **注入合计** | 历史投影累计 | 宿主真实 prompt | 宿主 compaction 次数 |`)
  p(`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`)
  for (const t of trend) {
    p(`| ${t.mark} | ${t.projCountTurn} | ${t.projTurnTokens.toLocaleString()} | `
      + `${t.injected === null ? '—' : t.injected.l1} | ${t.injected === null ? '—' : t.injected.mainline} | `
      + `${t.injected === null ? '—' : t.injected.l2} | ${t.injected === null ? '—' : t.injected.l3} | `
      + `**${t.injectedTotal === null ? '—' : t.injectedTotal.toLocaleString()}** | `
      + `${t.projCum.toLocaleString()}（${t.projCount} 条） | `
      + `${t.hostPrompt === null ? '—' : t.hostPrompt.toLocaleString()} | ${t.compactions} |`)
  }
  p()
  p(`> **"该轮注入 tok"** = 这一轮所有投影消息之和（一轮多步就多条，每步一条）。`)
  p(`> **"注入合计"** = 该轮最后一条投影全文（L1 marker + 骨架 + L2 + L3 + 头部行），即"稳态下一次请求多出来的量"。`)
  p(`> **"宿主真实 prompt"** = \`assistant/message.usage\` 的 \`inputTokens + cacheReadTokens\`，**不经任何估算函数**。`)
  p(`> 两者并排才能判断：插件的稳态增量是恒定的，但它写进会话日志的投影会累积——直到宿主 compaction 把那段历史整体替换掉。`)
  p()

  p(`## 表 3 · 对账：日志里真实投影 vs 生产函数重算`)
  p()
  // 只对"新版格式"（L1 块里写了"最近 N 轮真实对话"）的投影做逐条对账：
  // 历史投影混着 v0.1.7–v0.1.26 多个版本，旧版的 L1 块连"轮数"都不写，
  // 拿它跟当前判据比会得到一堆无意义的差值——那是版本差，不是判据错。
  const comparable = rows.filter((r) => r.proj !== null && r.projDeclaredTurns !== null)
  const oldFormat = rows.filter((r) => r.proj !== null && r.projDeclaredTurns === null).length
  p(`- 新版格式（可逐条对账）：${comparable.length} 轮；旧版格式（无轮数声明，不可比）：${oldFormat} 轮`)
  p(`- 对账切点：**用投影自己的 seq 切前缀**（同一时刻），不是轮首——只有这样才能逐字比较。`)
  p(`- 新版里 L1 轮数/token **不一致**：${comparable.filter((r) => r.projDeclaredL1 !== r.replayTokens || r.projDeclaredTurns !== r.replayDialogueTurns).length} 轮`)
  const mism = comparable.filter((r) => r.projDeclaredL1 !== r.replayTokens || r.projDeclaredTurns !== r.replayDialogueTurns)
  if (mism.length > 0) {
    p()
    p(`| turn | 重算轮数 | 投影自报轮数 | 重算 tok | 投影自报 tok | 差值 | 投影 seq |`)
    p(`|---:|---:|---:|---:|---:|---:|---:|`)
    for (const row of mism.slice(0, 40)) {
      p(`| ${row.turn} | ${row.replayDialogueTurns} | ${row.projDeclaredTurns} | ${row.replayTokens} | ${row.projDeclaredL1} | ${row.replayTokens - row.projDeclaredL1} | ${row.proj.seq} |`)
    }
  }
  p()

  p(`## 表 4 · 汇总`)
  p()
  p(`- 有真实投影的轮：${projByTurn.size} / ${rows.length}（首条投影在 turn ${Math.min(...projByTurn.keys())}——之前的轮插件尚未生效）`)
  p(`- 共 ${projTotal} 条投影 / ${projTokensTotal.toLocaleString()} tok（估算），平均 ${Math.round(projTokensTotal / Math.max(1, projTotal))} tok/条`)
  p(`- L2 摘要调用次数（重放判定）：${l2Calls} 次；真实投影里 L2 覆盖区间变化 ${countRangeChanges(rows)} 次`)
  p(`- L3 蒸馏推进的轮数（重放判定）：${l3Fresh} 轮；最终水位 ${highWater}`)
  p()
  console.log(out.join('\n'))
}

/** 数一数真实投影里 L2 覆盖区间变化了几次（= 实际发生了几次摘要调用）。 */
function countRangeChanges(rows) {
  let last = null
  let n = 0
  for (const row of rows) {
    const range = row.projL2Range
    if (range === null) continue
    const key = `${range.from}-${range.to}`
    if (key !== last) { n += 1; last = key }
  }
  return n
}

main()
