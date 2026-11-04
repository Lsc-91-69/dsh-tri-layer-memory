#!/usr/bin/env node
/**
 * verify-prune.mjs — 「零信息剪枝」的真实投影前后对比（只读）。
 *
 * 为什么不用重提取：日志里的骨架 cause 有一部分是运行时 LLM 回填的，重新
 * `extractMilestones` 会得到确定性标签——那就不是"同一条投影"了，对比数字也
 * 失去意义。所以本脚本**解析日志里那条真实投影的原文**，只把它替换成
 * "同一批条目 + 新渲染器"的文本，再量 token。改的是渲染，不是数据。
 *
 * 口径：
 * - 改前 = 日志里最新一条带骨架的投影原文（`# 三层记忆 · 本轮投影` 全文）。
 * - 改后 = 同一批数据过生产渲染器：L1 只留窗口边界行；骨架走
 *   `pruneMainlineForInjection` + `renderPrunedMainline`；L2 走
 *   `renderShortTermMemory`；L3 走 `renderDeepIndex`。
 * - token 尺子 = 生产 `estimateTokens`。
 *
 * 用法：
 *   node scripts/verify-prune.mjs --log .tmp-probe/session-5b59b635.v4.jsonl.zstd
 *   node scripts/verify-prune.mjs --log ... --json out.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { estimateTokens, isProjectionEvent, projectTurns } from '../src/host/l1-working.ts'
import { renderMainline, pruneMainlineForInjection, renderPrunedMainline } from '../src/host/milestones.ts'
void renderMainline // 全量渲染只作为对照（prunedTokens 的基线），本脚本不直接调用
import { renderShortTermMemory } from '../src/host/l2-render.ts'
import { renderDeepIndex } from '../src/host/index.ts'

const require = createRequire(import.meta.url)

const BLOCK_HEADERS = [
  ['l1', '## L1 工作记忆'],
  ['mainline', '## 里程碑主线骨架'],
  ['l2', '## L2 短期记忆'],
  ['l3', '## L3 深层记忆'],
]

function parseArgs(argv) {
  const out = { log: null, json: null, limit: 6 }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--log') out.log = argv[++i]
    else if (argv[i] === '--json') out.json = argv[++i]
    else if (argv[i] === '--limit') out.limit = Number(argv[++i])
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
          try { events.push(JSON.parse(t)) } catch { /* 坏行忽略 */ }
        }
      } catch { /* 坏帧忽略 */ }
      i = next
    }
    return events.sort((a, b) => a.seq - b.seq)
  }
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** 把投影全文按块头切成四块（顺序与注入一致）。 */
function splitProjection(text) {
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

/** 解析骨架块 → 里程碑对象（只取判据用到的字段；顺序保持）。 */
function parseMainline(block) {
  const out = []
  for (const line of block.split('\n')) {
    // 行号是 `padStart(3)`：1 位数有 2 个前导空格，2 位数只有 1 个，3 位数 0 个。
    const m = /^ *\d+\. 第 (\d+)(?:–(\d+))? 轮: (.+)$/.exec(line)
    if (m === null) continue
    const body = m[3]
    const at = body.lastIndexOf(' — ')
    const title = at < 0 ? body : body.slice(0, at)
    const cause = at < 0 ? '' : body.slice(at + 3)
    const item = { turn: Number(m[1]), title, cause, detail: '', category: '事件', tokens: 0 }
    if (m[2] !== undefined) item.turnTo = Number(m[2])
    out.push(item)
  }
  return out
}

/** 解析 L2 块 → renderShortTermMemory 的入参。 */
function parseDigest(block) {
  if (!block.includes('- 覆盖 turn')) {
    const m = /- 尚无摘要；已有 (\d+) 轮溢出/.exec(block)
    return { digest: null, pending: m === null ? 0 : Number(m[1]) }
  }
  const head = /- 覆盖 turn (\d+)–(\d+)（生成方式 ([^，]+)，压缩比约 ([^）]+)）/.exec(block)
  const pendingMatch = /- 待摘要的溢出轮：(\d+)/.exec(block)
  const bodyAt = block.indexOf('\n\n')
  const text = bodyAt < 0 ? '' : block.slice(bodyAt + 2)
  if (head === null) return { digest: null, pending: Number(pendingMatch?.[1] ?? 0) }
  return {
    digest: {
      text,
      via: head[3],
      turnFrom: Number(head[1]),
      turnTo: Number(head[2]),
      tokens: 1,
      sourceTokens: 1,
      createdAt: 0,
    },
    pending: Number(pendingMatch?.[1] ?? 0),
  }
}

/** 解析 L3 块 → renderDeepIndex 的入参。 */
function parseDeepIndex(block) {
  const main = /- 已持久化 (\d+) 条记录/.exec(block)
  const tools = /- 另有工具原始输出 (\d+) 条/.exec(block)
  const recall = /`([A-Za-z0-9_-]+)`（关键词或 id）/.exec(block)
  const vault = block.split('\n').filter((line) => line.startsWith('- 另有跨会话事实库')).join('\n')
  return {
    count: Number(main?.[1] ?? 0) + Number(tools?.[1] ?? 0),
    tools: Number(tools?.[1] ?? 0),
    recallName: recall?.[1] ?? 'memory_recall',
    vaultNote: vault,
  }
}

/** 一条投影 → 改后文本（只重渲染，不重提取）。 */
function rebuild(text) {
  const parts = splitProjection(text)
  const blocks = []

  // L1：新渲染只保留"块头 + 第一行"。第一行逐字未变，所以直接取旧块首行即可，
  // 不依赖重建窗口（重建需要"那一刻"的事件切片，容易引入人为差异）。
  const l1Lines = parts.l1.split('\n')
  blocks.push(l1Lines[0] + '\n' + (l1Lines[1] ?? ''))

  // 骨架：解析旧行 → 新剪枝 → 新渲染。任务标题行沿用旧块。
  const titleLine = /^- 任务：(.+)$/m.exec(parts.mainline)
  const taskTitle = titleLine?.[1]
  const milestones = parseMainline(parts.mainline)
  const pruned = pruneMainlineForInjection(milestones)
  // 注入上限默认值（60 条 / 1600 tokens）不在这里裁：本脚本量的是"剪枝本身"，
  // 上限裁剪会掩盖剪枝效果，也会让 60 条对比失真。日志里那条本来就没触上限。
  blocks.push(renderPrunedMainline(pruned.lines, taskTitle))

  // L2
  const { digest, pending } = parseDigest(parts.l2)
  blocks.push(renderShortTermMemory(digest, pending))

  // L3
  if (parts.l3.length > 0) {
    const deep = parseDeepIndex(parts.l3)
    blocks.push(renderDeepIndex(
      { count: deep.count, tokens: 0, backend: 'sqlite', tools: deep.tools, toolTokens: 0 },
      [],
      deep.recallName,
      deep.vaultNote,
    ))
  }

  const out = `# 三层记忆 · 本轮投影\n\n${blocks.join('\n\n')}`
  return { text: out, parts, milestones, pruned, taskTitle }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv)
if (args.log === null) {
  console.error('用法：node scripts/verify-prune.mjs --log <session.v4.jsonl.zstd> [--json out.json]')
  process.exit(2)
}
const logPath = resolve(args.log)
if (!existsSync(logPath)) { console.error(`找不到日志：${logPath}`); process.exit(2) }

const events = loadEvents(logPath)
const projections = []
for (const e of events) {
  if (!isProjectionEvent(e)) continue
  const text = e.data?.content?.[0]?.text ?? ''
  if (text.length === 0) continue
  projections.push({ seq: e.seq, text })
}
if (projections.length === 0) { console.error('日志里没有投影'); process.exit(1) }

// 最新一条带骨架的投影 = 验收点。
const target = [...projections].reverse().find((p) => p.text.includes('## 里程碑主线骨架')) ?? projections[projections.length - 1]
const beforeTokens = estimateTokens(target.text)
const rebuilt = rebuild(target.text)
const afterTokens = estimateTokens(rebuilt.text)

const beforeParts = splitProjection(target.text)
const afterParts = splitProjection(rebuilt.text)
const lines = []

const pct = (before, after) => (before <= 0 ? '-' : `${(((after - before) / before) * 100).toFixed(1)}%`)
lines.push(`# 零信息剪枝：真实投影前后对比`)
lines.push('')
lines.push(`日志：\`${logPath}\``)
lines.push(`取最新一条带骨架投影：seq=${target.seq}（共 ${projections.length} 条投影）`)
lines.push('')
lines.push('## 1. 块级 token（同一条投影、同一批数据）')
lines.push('')
lines.push('| 块 | 改前 | 改后 | 省 | 降幅 |')
lines.push('| --- | ---: | ---: | ---: | ---: |')
let sumBefore = 0
let sumAfter = 0
for (const id of ['l1', 'mainline', 'l2', 'l3']) {
  const b = estimateTokens(beforeParts[id])
  const a = estimateTokens(afterParts[id])
  sumBefore += b
  sumAfter += a
  const name = { l1: 'L1 marker', mainline: '骨架', l2: 'L2 摘要', l3: 'L3 索引' }[id]
  lines.push(`| ${name} | ${b} | ${a} | ${b - a} | ${pct(b, a)} |`)
}
const headerOverhead = estimateTokens(target.text) - sumBefore
lines.push(`| 消息头/空行（固定） | ${headerOverhead} | ${estimateTokens(rebuilt.text) - sumAfter} | - | - |`)
lines.push(`| **整条投影** | **${beforeTokens}** | **${afterTokens}** | **${beforeTokens - afterTokens}** | **${pct(beforeTokens, afterTokens)}** |`)
lines.push('')

// ── 骨架明细 ──
const pruned = rebuilt.pruned
const total = rebuilt.milestones.length
const keptRows = pruned.lines.length
lines.push('## 2. 骨架：条目与清单')
lines.push('')
lines.push(`- 改前：${total} 条 / ${estimateTokens(beforeParts.mainline)} tokens`)
lines.push(`- 改后：${keptRows} 条 / ${estimateTokens(afterParts.mainline)} tokens`)
lines.push(`- 整条删除（标题也是空话）：${pruned.dropped.length} 条`)
lines.push(`- 只去 cause（标题自身是结论）：${pruned.stripped.length} 条`)
lines.push(`- 保守保留整行（含模板 cause）：${keptRows - pruned.stripped.length} 条`)
lines.push('')
lines.push('### 整条删除清单（逐条人工复核用）')
lines.push('')
if (pruned.dropped.length === 0) lines.push('（无）')
for (const m of pruned.dropped) {
  const span = m.turnTo === undefined ? `第 ${m.turn} 轮` : `第 ${m.turn}–${m.turnTo} 轮`
  lines.push(`- ${span}: ${m.title} — ${m.cause}`)
}
lines.push('')
lines.push('### 只去 cause 的清单（标题逐字保留）')
lines.push('')
for (const m of pruned.stripped) {
  const span = m.turnTo === undefined ? `第 ${m.turn} 轮` : `第 ${m.turn}–${m.turnTo} 轮`
  lines.push(`- ${span}: ${m.title}  ← 删掉「${m.cause}」`)
}
lines.push('')
lines.push('### 保守保留整行的条目（cause 是唯一状态线索 / 判不准）')
lines.push('')
for (const line of pruned.lines) {
  if (line.trim !== 'keep') continue
  const span = line.milestone.turnTo === undefined ? `第 ${line.milestone.turn} 轮` : `第 ${line.milestone.turn}–${line.milestone.turnTo} 轮`
  lines.push(`- ${span}: ${line.milestone.title} — ${line.milestone.cause}`)
}
lines.push('')

// ── 改后正文 ──
lines.push('## 3. 改后投影正文（最新一条）')
lines.push('')
lines.push('```text')
lines.push(rebuilt.text)
lines.push('```')
lines.push('')

// ── 每轮多次注入 ──
const spans = projectTurns(events).slice().sort((a, b) => a.startSeq - b.startSeq)
const roundOf = []
let lastSeq = -1
let singleBefore = 0
let singleAfter = 0
for (const span of spans) {
  const batch = projections.filter((p) => p.seq > lastSeq && p.seq <= span.endSeq)
  lastSeq = span.endSeq
  if (batch.length === 0) continue
  let before = 0
  let after = 0
  for (const p of batch) {
    const b = estimateTokens(p.text)
    const a = estimateTokens(rebuild(p.text).text)
    before += b
    after += a
    singleBefore += b
    singleAfter += a
  }
  roundOf.push({ turn: span.turn, count: batch.length, before, after })
}
const injectedRounds = roundOf.filter((r) => r.count > 0)
const avgCount = injectedRounds.reduce((s, r) => s + r.count, 0) / Math.max(1, injectedRounds.length)
const avgBefore = injectedRounds.reduce((s, r) => s + r.before, 0) / Math.max(1, injectedRounds.length)
const avgAfter = injectedRounds.reduce((s, r) => s + r.after, 0) / Math.max(1, injectedRounds.length)
const totalProj = injectedRounds.reduce((s, r) => s + r.count, 0)
const avgSingleBefore = singleBefore / Math.max(1, totalProj)
const avgSingleAfter = singleAfter / Math.max(1, totalProj)
lines.push('## 4. 每轮多次注入（一轮有多个 step，每步一条快照）')
lines.push('')
lines.push(`- 有注入的轮数：${injectedRounds.length}（总轮数 ${spans.length}）`)
lines.push(`- 每轮平均注入条数：${avgCount.toFixed(2)} 条（改前改后一致——剪枝不改变注入次数）`)
lines.push(`- 单条投影平均：改前 ${Math.round(avgSingleBefore)} tokens → 改后 ${Math.round(avgSingleAfter)} tokens，省 ${Math.round(avgSingleBefore - avgSingleAfter)}（${pct(avgSingleBefore, avgSingleAfter)}）`)
lines.push(`- 每轮注入合计（平均）：改前 ${Math.round(avgBefore)} tokens → 改后 ${Math.round(avgAfter)} tokens，省 ${Math.round(avgBefore - avgAfter)}（${pct(avgBefore, avgAfter)}）`)
lines.push(`- 每轮注入合计（按平均条数折算）：${Math.round(avgCount * avgSingleBefore)} → ${Math.round(avgCount * avgSingleAfter)}`)
lines.push(`- 每轮注入合计（中位数）：改前 ${median(injectedRounds.map((r) => r.before))} → 改后 ${median(injectedRounds.map((r) => r.after))}`)
lines.push('')
lines.push('| 轮 | 条数 | 改前 | 改后 | 省 |')
lines.push('| ---: | ---: | ---: | ---: | ---: |')
for (const r of injectedRounds.slice(-10)) {
  lines.push(`| ${r.turn} | ${r.count} | ${r.before} | ${r.after} | ${r.before - r.after} |`)
}
lines.push('')

console.log(lines.join('\n'))

if (args.json !== null) {
  const outPath = resolve(args.json)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify({
    log: logPath,
    seq: target.seq,
    beforeTokens,
    afterTokens,
    blocks: { before: beforeParts, after: afterParts },
    milestones: rebuilt.milestones.length,
    keptRows,
    dropped: pruned.dropped,
    stripped: pruned.stripped,
    rounds: injectedRounds,
    text: rebuilt.text,
  }, null, 2))
  console.log(`\n# 明细已写入 ${outPath}`)
}

function median(list) {
  if (list.length === 0) return 0
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}
