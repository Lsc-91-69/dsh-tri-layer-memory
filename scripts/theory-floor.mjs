#!/usr/bin/env node
/**
 * theory-floor.mjs — 构造"理论下界 T(N)"，并和实测注入并排（只读）。
 *
 * 用户给的下界构造：
 *   T(N) = L1(N) + 摘要 + 索引 + 骨架
 * 其中 L1(N) 在 N > 8 之后是常数 → T(N) 应该是常数。
 *
 * 这个脚本把每一项都**实测**出来，而不是抄配置：
 * - L1(N)：`projectWorkingWindow(events[≤N], 8).tokens` —— 生产函数在真实前缀上算的
 *   最近 8 轮原文 token（这是"不可压缩"的那部分上下文）。
 * - 摘要 / 索引 / 骨架：取该时刻**真实投影**里对应块的 estimateTokens。
 * - 原始对话(N)：projectTurns 前缀的 tokens 之和。
 *
 * 用法：
 *   node scripts/theory-floor.mjs --log .tmp-efficiency/s5b.jsonl --rounds 10,20,30,50,80,120
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { estimateTokens, projectTurns, projectWorkingWindow, isProjectionEvent } from '../src/host/l1-working.ts'
import { DEFAULTS } from '../src/host/config-core.ts'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { log: null, rounds: [10, 20, 30, 50, 80, 120], json: null }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--log') out.log = argv[++i]
    else if (argv[i] === '--rounds') out.rounds = argv[++i].split(',').map(Number).filter(Number.isFinite)
    else if (argv[i] === '--json') out.json = argv[++i]
  }
  return out
}

function loadEvents(path) {
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
          try { events.push(JSON.parse(t)) } catch { /* 忽略 */ }
        }
      } catch { /* 忽略坏帧 */ }
      i = next
    }
    return events.sort((a, b) => a.seq - b.seq)
  }
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq)
}

function splitBlocks(text) {
  const headers = [['l1', '## L1 工作记忆'], ['mainline', '## 里程碑主线骨架'], ['l2', '## L2 短期记忆'], ['l3', '## L3 深层记忆']]
  const found = headers.map(([id, h]) => ({ id, at: text.indexOf(h) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)
  const out = { l1: '', mainline: '', l2: '', l3: '' }
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].at : text.length
    out[found[i].id] = text.slice(found[i].at, end).trim()
  }
  return out
}

function main() {
  const args = parseArgs(process.argv)
  if (args.log === null) { console.error('需要 --log'); process.exit(2) }
  const logPath = resolve(args.log)
  if (!existsSync(logPath)) { console.error(`找不到 ${logPath}`); process.exit(2) }
  const events = loadEvents(logPath)
  const spans = projectTurns(events).filter((s) => s.startSeq >= 0)
  const projections = []
  for (const e of events) {
    if (!isProjectionEvent(e)) continue
    const text = e.data?.content?.[0]?.text ?? ''
    if (text.length > 0) projections.push({ seq: e.seq, text })
  }

  const rows = []
  for (const target of args.rounds) {
    const k = Math.min(target, spans.length)
    const endSeq = spans[k - 1]?.endSeq ?? Infinity
    const prefix = events.filter((e) => e.seq <= endSeq)

    let orig = 0
    for (let i = 0; i < k; i += 1) orig += spans[i].tokens

    const window = projectWorkingWindow(prefix, DEFAULTS.l1RetainTurns)
    let latest = null
    for (const p of projections) { if (p.seq <= endSeq) latest = p; else break }
    const blocks = latest === null ? { l1: '', mainline: '', l2: '', l3: '' } : splitBlocks(latest.text)
    const l2 = estimateTokens(blocks.l2)
    const l3 = estimateTokens(blocks.l3)
    const mainline = estimateTokens(blocks.mainline)
    const marker = estimateTokens(blocks.l1)

    const tCtx = window.tokens + l2 + mainline + l3
    const tInject = marker + l2 + mainline + l3
    rows.push({
      N: k,
      orig,
      l1Original: window.tokens,
      l1Turns: window.dialogueTurns,
      l1Chars: window.charCount,
      l2,
      l3,
      mainline,
      marker,
      tCtx,
      tInject,
      perTurnOrig: Math.round(orig / k),
    })
  }

  console.log(`# ${logPath}`)
  console.log(`# 配置：l1RetainTurns=${DEFAULTS.l1RetainTurns} l2RetainTurns=${DEFAULTS.l2RetainTurns} injectionBudgetTokens=${DEFAULTS.injectionBudgetTokens}`)
  console.log('')
  console.log('## T(N) 构造')
  console.log('')
  console.log('| N | 原始对话 | L1窗口原文(8轮) | 窗口轮数 | L2摘要 | L3索引 | 骨架 | T_ctx(N) | T_inject(N) | 理论压缩比(ctx) |')
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of rows) {
    const ratio = r.tCtx > 0 ? (r.orig / r.tCtx).toFixed(1) : '-'
    console.log(`| ${r.N} | ${r.orig} | ${r.l1Original} | ${r.l1Turns} | ${r.l2} | ${r.l3} | ${r.mainline} | ${r.tCtx} | ${r.tInject} | ${ratio} |`)
  }
  console.log('')
  console.log('## 每轮平均')
  console.log('')
  console.log('| N | 每轮原始正文 | L1窗口原文/轮 |')
  console.log('| ---: | ---: | ---: |')
  for (const r of rows) console.log(`| ${r.N} | ${r.perTurnOrig} | ${r.l1Turns > 0 ? Math.round(r.l1Original / r.l1Turns) : '-'} |`)

  if (args.json !== null) writeFileSync(args.json, JSON.stringify(rows, null, 2))
}

main()
