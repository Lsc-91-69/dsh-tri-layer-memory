#!/usr/bin/env node
/**
 * measure-efficiency.mjs — 量三层记忆插件在不同会话长度下的**压缩效率**（只读）。
 *
 * 这个脚本只做一件事：把"插件每轮往上下文里塞了多少"和"会话里本来有多少原文"
 * 用同一把尺子（生产实现的 `estimateTokens`）分开量出来，不重算插件逻辑、不改 src。
 *
 * 口径（与 index.ts 的 `InjectionAccounting` 一致）：
 * - **注入块**：某一时刻最新一条投影的全文（`# 三层记忆 · 本轮投影` + L1 + 骨架 + L2 + L3）。
 *   块内再按四个标题切分，逐块量 token。这是"插件这一轮新写进去多少"。
 * - **累积投影**：从会话开始到该时刻，所有投影事件之和（扣掉被 `compaction/prune`
 *   遮蔽的）。这是"插件一共往上下文里加了多少"。
 * - **原始对话**：projectTurns 的每轮 tokens（user/assistant/tool 正文，不含投影）。
 * - **宿主 prompt**：assistant/message.data.usage 的 inputTokens + cacheReadTokens。
 *
 * 用法：
 *   node scripts/measure-efficiency.mjs --log .tmp-efficiency/s5b.jsonl
 *   node scripts/measure-efficiency.mjs --log .tmp-efficiency/s5b.jsonl --turns 10,20,30,50,80,120 --json out.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { estimateTokens, projectTurns, isProjectionEvent } from '../src/host/l1-working.ts'
import { DEFAULTS } from '../src/host/config-core.ts'

const require = createRequire(import.meta.url)

/** 与 projection.ts / index.ts 共用的块头。 */
const BLOCK_HEADERS = [
  ['l1', '## L1 工作记忆'],
  ['mainline', '## 里程碑主线骨架'],
  ['l2', '## L2 短期记忆'],
  ['l3', '## L3 深层记忆'],
]

function parseArgs(argv) {
  const out = { log: null, turns: [10, 20, 30, 50, 80, 120], json: null, limit: 0 }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--log') out.log = argv[++i]
    else if (a === '--turns') out.turns = argv[++i].split(',').map((x) => Number(x.trim())).filter(Number.isFinite)
    else if (a === '--json') out.json = argv[++i]
    else if (a === '--limit') out.limit = Number(argv[++i])
  }
  return out
}

/** 把投影全文按块头切成四块；缺失的块返回空串。 */
export function splitProjection(text) {
  const found = BLOCK_HEADERS
    .map(([id, header]) => ({ id, at: text.indexOf(header) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
  const out = { l1: '', mainline: '', l2: '', l3: '' }
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].at : text.length
    out[found[i].id] = text.slice(found[i].at, end).replace(/\s+$/, '')
  }
  return out
}

export function loadEvents(path) {
  if (path.endsWith('.zstd')) {
    const buf = readFileSync(path)
    const magic = (at) => buf[at] === 0x28 && buf[at + 1] === 0xb5 && buf[at + 2] === 0x2f && buf[at + 3] === 0xfd
    const events = []
    let i = 0
    while (i + 4 <= buf.length) {
      if (!magic(i)) { i += 1; continue }
      let next = i + 4
      while (next + 4 <= buf.length && !magic(next)) next += 1
      try {
        const text = require('node:zlib').zstdDecompressSync(buf.subarray(i, next)).toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim()
          if (!t) continue
          try { events.push(JSON.parse(t)) } catch { /* 非 JSON 行忽略 */ }
        }
      } catch { /* 坏帧跳过 */ }
      i = next
    }
    return events
  }
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function main() {
  const args = parseArgs(process.argv)
  if (args.log === null) {
    console.error('用法：node scripts/measure-efficiency.mjs --log <session.jsonl|session.v4.jsonl.zstd> [--turns 10,20,...] [--json out.json]')
    process.exit(2)
  }
  const logPath = resolve(args.log)
  if (!existsSync(logPath)) { console.error(`找不到日志：${logPath}`); process.exit(2) }
  const events = loadEvents(logPath).sort((a, b) => a.seq - b.seq)

  // 生产口径的轮跨度：user/assistant/tool 正文，排除本插件投影。
  const spans = projectTurns(events)
  const spanByTurn = new Map(spans.map((s) => [s.turn, s]))

  // 投影事件（isProjectionEvent 是生产判据）。
  const projections = []
  for (const e of events) {
    if (!isProjectionEvent(e)) continue
    const text = e.data?.content?.[0]?.text ?? ''
    if (text.length === 0) continue
    projections.push({ seq: e.seq, text, tokens: estimateTokens(text) })
  }

  // 宿主 compaction 的遮蔽记录：seq → 遮蔽时点。
  const shadowedAt = new Map()
  for (const e of events) {
    if (e.type !== 'compaction/prune') continue
    for (const seq of e.data?.shadowedSeqs ?? []) shadowedAt.set(seq, e.seq)
  }

  // 宿主 compaction 的范围替换：`surfaceOp = {op:'replace', startSeq, endSeq}`。
  // 落在范围内的投影/事件从 surface 上消失（被 checkpoint 摘要替代）。
  const replaces = events
    .filter((e) => e.surfaceOp !== undefined && typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace')
    .map((e) => ({ seq: e.seq, start: e.surfaceOp.startSeq, end: e.surfaceOp.endSeq }))

  // 轮序**只能按 turn/start 出现的顺序数**：`data.turn` 会被子代理/回退段复用
  //（实测 s971 里 seq 2857 的 tool/result 也带 turn=3），拿 turn 号当轮序会把
  // 后面的投影算进前面的轮。spans 的顺序才是时间顺序。
  const ordered = spans.filter((s) => s.startSeq >= 0)
  const rows = []

  for (let k = 1; k <= ordered.length; k += 1) {
    const span = ordered[k - 1]
    const N = k
    const endSeq = span.endSeq

    // 原始对话：前 N 轮的正文 token（生产口径 projectTurns 的 tokens）。
    let orig = 0
    for (let i = 0; i < k; i += 1) orig += ordered[i].tokens

    // 该时刻最新一条投影。
    let latest = null
    for (const p of projections) if (p.seq <= endSeq) latest = p
    const parts = latest === null ? null : splitProjection(latest.text)
    const inject = latest === null ? 0 : latest.tokens
    const blocks = {
      l1: parts === null ? 0 : estimateTokens(parts.l1),
      mainline: parts === null ? 0 : estimateTokens(parts.mainline),
      l2: parts === null ? 0 : estimateTokens(parts.l2),
      l3: parts === null ? 0 : estimateTokens(parts.l3),
    }

    // 累积投影：该时刻已注入、且没有被宿主 compaction 的 replace 范围吞掉的。
    // `append` 不是遮蔽（它只是追加），所以只看 replace 范围。
    let cumProj = 0
    let projCount = 0
    let shadowedProj = 0
    for (const p of projections) {
      if (p.seq > endSeq) break
      const covered = replaces.some((r) => r.seq <= endSeq && r.seq > p.seq && r.start <= p.seq && p.seq <= r.end)
      if (covered) { shadowedProj += 1; continue }
      cumProj += p.tokens
      projCount += 1
    }

    // 宿主 usage：该轮最后一个带 usage 的 assistant/message。
    let promptTokens = null
    let outputTokens = null
    for (const e of events) {
      if (e.seq > endSeq) break
      const u = e.data?.usage
      if (u === undefined || typeof u !== 'object') continue
      const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0
      const cache = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
      promptTokens = input + cache
      outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : null
    }

    // 本轮内**所有**投影之和：一个 turn 有多个 step，每步都注入一条快照，
    // 所以"每轮成本"不是最后一条的大小，而是这一轮写进去的全部。
    const roundStart = k === 1 ? -1 : ordered[k - 2].endSeq
    let roundInject = 0
    let roundProjCount = 0
    for (const p of projections) {
      if (p.seq <= roundStart) continue
      if (p.seq > endSeq) break
      roundInject += p.tokens
      roundProjCount += 1
    }

    rows.push({
      N,
      turn: span.turn,
      orig,
      inject,
      blocks,
      roundInject,
      roundProjCount,
      cumProj,
      projCount,
      shadowedProj,
      promptTokens,
      outputTokens,
      projAt: latest === null ? null : latest.seq,
    })
  }

  // ── 打印 ──
  console.log(`# 会话：${logPath}`)
  console.log(`# 总轮数 ${ordered.length}，事件 ${events.length}，投影 ${projections.length}`)
  console.log(`# 配置：l1RetainTurns=${DEFAULTS.l1RetainTurns} l2RetainTurns=${DEFAULTS.l2RetainTurns} mainlineMaxMilestones=${DEFAULTS.mainlineMaxMilestones} mainlineMaxTokens=${DEFAULTS.mainlineMaxTokens} injectionBudgetTokens=${DEFAULTS.injectionBudgetTokens}`)
  console.log('')
  console.log('| N | 原始对话 | 末条注入 | 本轮注入 | 条数 | L1 | 骨架 | L2 | L3 | 累积投影 | 存活/被吞 | 宿主 prompt |')
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  const limit = args.limit > 0 ? Math.min(args.limit, rows.length) : rows.length
  for (let i = 0; i < limit; i += 1) {
    const r = rows[i]
    console.log(`| ${r.N} | ${r.orig} | ${r.inject} | ${r.roundInject} | ${r.roundProjCount} | ${r.blocks.l1} | ${r.blocks.mainline} | ${r.blocks.l2} | ${r.blocks.l3} | ${r.cumProj} | ${r.projCount}/${r.shadowedProj} | ${r.promptTokens ?? '-'} |`)
  }

  // ── 目标点 ──
  console.log('')
  console.log('## 目标长度点')
  console.log('')
  console.log('| N | 原始对话 | 末条注入 | 本轮注入 | 累积投影 | 宿主 prompt | 压缩比(末条) | 压缩比(本轮) | 压缩比(含累积) |')
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  const picked = []
  for (const target of args.turns) {
    let row = rows.find((r) => r.N === target)
    if (row === undefined) row = rows[rows.length - 1]
    if (row === undefined) continue
    picked.push(row)
    const r1 = row.inject > 0 ? (row.orig / row.inject).toFixed(1) : '-'
    const r2 = (row.inject + row.cumProj) > 0 ? (row.orig / (row.inject + row.cumProj)).toFixed(2) : '-'
    console.log(`| ${row.N}${row.N !== target ? `(取最长 ${row.N})` : ''} | ${row.orig} | ${row.inject} | ${row.roundInject} | ${row.cumProj} | ${row.promptTokens ?? '-'} | ${r1} | ${row.roundInject > 0 ? (row.orig / row.roundInject).toFixed(1) : '-'} | ${r2} |`)
  }

  if (args.json !== null) {
    writeFileSync(args.json, JSON.stringify({ log: logPath, rounds: ordered.length, rows }, null, 2))
    console.log(`\n# 明细已写入 ${resolve(args.json)}`)
  }
}

main()



