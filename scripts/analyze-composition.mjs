#!/usr/bin/env node
/**
 * analyze-composition.mjs — 拆开"上下文里到底剩了什么"（只读）。
 *
 * 前面的 measure-efficiency.mjs 量的是"插件注入多少"。这个脚本回答另一个问题：
 * **到了某一轮，surface 上真正还在的事件里，原文 / 插件投影 / 宿主 checkpoint 各占多少。**
 * 只有这个分解能回答"插件是净增还是净省"——因为压缩比的分母（原始对话）里有一大半
 * 早就被宿主 compaction 换成了 checkpoint，而投影是插件自己加进去的，不会被谁替掉。
 *
 * 存活判据：宿主的范围替换 `surfaceOp = {op:'replace', startSeq, endSeq}`。
 * 一个事件若落在某个**之后发生**的 replace 范围里，就从 surface 上消失。
 *
 * 用法：
 *   node scripts/analyze-composition.mjs --log .tmp-efficiency/s5b.jsonl --rounds 10,20,30,50,80,120
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { estimateTokens, projectTurns, isProjectionEvent, messageBody, contentToText } from '../src/host/l1-working.ts'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { log: null, rounds: [10, 20, 30, 50, 80, 120] }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--log') out.log = argv[++i]
    else if (argv[i] === '--rounds') out.rounds = argv[++i].split(',').map(Number).filter(Number.isFinite)
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
          try { events.push(JSON.parse(t)) } catch { /* 忽略 */ }
        }
      } catch { /* 忽略坏帧 */ }
      i = next
    }
    return events.sort((a, b) => a.seq - b.seq)
  }
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.seq - b.seq)
}

const CHECKPOINT_HEAD = 'This is an automatically generated checkpoint'

/** 事件正文（不含投影头部之外的元数据）。 */
function eventText(e) {
  if (e.type === 'tool/call') {
    const a = e.data?.arguments ?? e.data?.input
    return typeof a === 'string' ? a : (a === undefined ? '' : JSON.stringify(a))
  }
  return contentToText(messageBody(e.data ?? {}))
}

function main() {
  const args = parseArgs(process.argv)
  if (args.log === null) { console.error('需要 --log'); process.exit(2) }
  const logPath = resolve(args.log)
  if (!existsSync(logPath)) { console.error(`找不到 ${logPath}`); process.exit(2) }
  const events = loadEvents(logPath)
  const spans = projectTurns(events).filter((s) => s.startSeq >= 0)
  const replaces = events
    .filter((e) => e.surfaceOp !== undefined && typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace')
    .map((e) => ({ seq: e.seq, start: e.surfaceOp.startSeq, end: e.surfaceOp.endSeq }))

  const alive = (e, upto) => !replaces.some((r) => r.seq <= upto && r.seq > e.seq && r.start <= e.seq && e.seq <= r.end)

  console.log(`# ${logPath}`)
  console.log('')
  console.log('| N | surface原文 | 插件投影 | 宿主checkpoint | 系统/工具面 | 其它 | 合计 | 投影占比 |')
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const target of args.rounds) {
    const k = Math.min(target, spans.length)
    const upto = spans[k - 1]?.endSeq ?? Infinity
    const buckets = { orig: 0, proj: 0, checkpoint: 0, system: 0, other: 0 }
    const counts = { orig: 0, proj: 0, checkpoint: 0 }
    for (const e of events) {
      if (e.seq > upto) break
      if (!alive(e, upto)) continue
      if (isProjectionEvent(e)) {
        buckets.proj += estimateTokens(eventText(e))
        counts.proj += 1
        continue
      }
      if (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result' || e.type === 'tool/call') {
        const text = eventText(e)
        if (e.type === 'user/message' && text.startsWith(CHECKPOINT_HEAD)) buckets.checkpoint += estimateTokens(text)
        else { buckets.orig += estimateTokens(text); counts.orig += 1 }
        continue
      }
      if (e.type === 'system/message' || e.type === 'developer/message') {
        buckets.system += estimateTokens(eventText(e))
        continue
      }
      buckets.other += 0
    }
    const total = buckets.orig + buckets.proj + buckets.checkpoint + buckets.system
    const share = total > 0 ? ((buckets.proj / total) * 100).toFixed(1) : '-'
    console.log(`| ${k} | ${buckets.orig} | ${buckets.proj} | ${buckets.checkpoint} | ${buckets.system} | ${buckets.other} | ${total} | ${share}% |`)
  }
}

main()
