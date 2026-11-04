#!/usr/bin/env node
/**
 * analyze-mainline.mjs — 主线条目（骨架）的信息量审计（只读）。
 *
 * 用户的问题很具体：60 条封顶、1,558 tok 的骨架里，有多少是
 * `仅对话，无代码变更` / `原因不明` 这类低信息量条目？如果占一半，骨架的一半 token
 * 就是浪费。
 *
 * 这个脚本不猜：它取**真实投影**里的骨架块，按 `— <cause>` 尾部标签逐条分类，
 * 分别统计条数、字符数、estimateTokens（与插件同一把尺子）。
 *
 * 用法：
 *   node scripts/analyze-mainline.mjs --log .tmp-efficiency/s5b.jsonl [--round 120]
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { estimateTokens, isProjectionEvent } from '../src/host/l1-working.ts'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const out = { log: null, round: null }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--log') out.log = argv[++i]
    else if (argv[i] === '--round') out.round = Number(argv[++i])
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

/** 低信息量 cause 标签：这些条目说完等于没说。 */
const LOW_CAUSES = new Set(['原因不明', '仅对话，无代码变更', '用户追问', '未解决', '排查中，无结论'])
const LOW_SUBSTR = ['根因不明', '无代码变更']

function classify(line) {
  // 形如 `  12. 第 43–44 轮: 连续 2 轮整轮失败 — 原因不明`
  const at = line.lastIndexOf(' — ')
  const cause = at >= 0 ? line.slice(at + 3).trim() : ''
  if (LOW_CAUSES.has(cause)) return { low: true, cause }
  if (LOW_SUBSTR.some((s) => cause.includes(s))) return { low: true, cause }
  return { low: false, cause }
}

function main() {
  const args = parseArgs(process.argv)
  if (args.log === null) { console.error('需要 --log'); process.exit(2) }
  const logPath = resolve(args.log)
  if (!existsSync(logPath)) { console.error(`找不到 ${logPath}`); process.exit(2) }
  const events = loadEvents(logPath)
  const projections = events.filter((e) => isProjectionEvent(e) && (e.data?.content?.[0]?.text ?? '').includes('## 里程碑主线骨架'))
  if (projections.length === 0) { console.error('日志里没有带骨架的投影'); process.exit(1) }

  const target = args.round === null ? projections.length - 1 : Math.min(args.round, projections.length) - 1
  const text = projections[target].data.content[0].text
  const start = text.indexOf('## 里程碑主线骨架')
  const end = text.indexOf('## L2 短期记忆')
  const block = text.slice(start, end < 0 ? text.length : end)
  const lines = block.split('\n').filter((l) => /^\s*\d+\.\s/.test(l))
  const ratio = block.match(/- 任务：(.+)/)?.[1]?.trim() ?? '(无标题)'

  let lowCount = 0, lowChars = 0, highCount = 0, highChars = 0
  const causes = new Map()
  const lowExamples = []
  for (const line of lines) {
    const { low, cause } = classify(line)
    causes.set(cause || '(无 cause)', (causes.get(cause || '(无 cause)') ?? 0) + 1)
    if (low) { lowCount += 1; lowChars += line.length; if (lowExamples.length < 5) lowExamples.push(line.trim()) }
    else { highCount += 1; highChars += line.length }
  }
  const blockTokens = estimateTokens(block)
  const lowTokens = estimateTokens(lines.filter((l) => classify(l).low).join('\n'))
  const highTokens = estimateTokens(lines.filter((l) => !classify(l).low).join('\n'))
  const headChars = block.length - lines.reduce((s, l) => s + l.length + 1, 0)

  console.log(`# ${logPath}`)
  console.log(`# 取第 ${target + 1} 条带骨架投影（seq=${projections[target].seq}）`)
  console.log('')
  console.log(`- 任务标题：${ratio}`)
  console.log(`- 骨架块：${blockTokens} tokens（${block.length} 字符），条目 ${lines.length} 条`)
  console.log(`- 块头/标题行：约 ${estimateTokens(block.slice(0, block.indexOf(lines[0]) === -1 ? block.length : block.indexOf(lines[0])))} tokens（${headChars} 字符）`)
  console.log('')
  console.log(`| 类别 | 条数 | 占比 | 字符 | token | token 占比 |`)
  console.log(`| --- | ---: | ---: | ---: | ---: | ---: |`)
  console.log(`| 低信息量（原因不明/仅对话/用户追问/未解决/无结论） | ${lowCount} | ${(lowCount / lines.length * 100).toFixed(0)}% | ${lowChars} | ${lowTokens} | ${(lowTokens / blockTokens * 100).toFixed(1)}% |`)
  console.log(`| 有信息量（验证/修复/部署/方向变更等） | ${highCount} | ${(highCount / lines.length * 100).toFixed(0)}% | ${highChars} | ${highTokens} | ${(highTokens / blockTokens * 100).toFixed(1)}% |`)
  console.log('')
  console.log('## cause 标签分布')
  console.log('')
  console.log(`| cause | 条数 |`)
  console.log(`| --- | ---: |`)
  for (const [c, n] of [...causes.entries()].sort((a, b) => b[1] - a[1])) console.log(`| ${c} | ${n} |`)
  console.log('')
  console.log('## 低信息量条目样例')
  for (const line of lowExamples) console.log(`- ${line}`)
}

main()
