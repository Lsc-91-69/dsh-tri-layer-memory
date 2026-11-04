/**
 * scripts/diff-probe.mjs — A3 的 Top 10：逐条查"现在还能不能取回"。
 *
 * 为什么不用自动打分排序直接出 Top 10：自动分只认"用户说的 + 含硬约束词"，
 * 排出来的是子代理报告里的编号句，不是**忘了会真的做错事**的那 10 条。所以这里
 * 把 10 条候选**手工列死**（每条都来自真实会话、带轮号），脚本只负责测量：
 * 1. 这句话现在落在哪一层（L1 / SURFACE / L2 / 骨架 / 检查点 / L3 / 完全没有）；
 * 2. 用生产 `searchRecords` 拿 top-3，并判断答案是否真的在里面。
 *
 * 查询串是**人话**（模型真会这样问），不是从答案里抽词——A3 里那版"用句子自己的
 * 关键词当查询"结果偏乐观，不能代表真实召回。
 *
 * 用法：node scripts/diff-probe.mjs
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { readSessionFile } from './lib-session-log.mjs'
import { estimateTokens, isProjectionEvent, projectWorkingWindow } from '../src/host/l1-working.ts'
import { searchRecords } from '../src/host/l3-deep.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '.tmp-diff')
mkdirSync(OUT, { recursive: true })
const SNAPSHOT = join(OUT, 'snapshot-20261104-1926')
const SESSION = process.argv[2]

/** 十条候选：每条 = 原文里的定位串 + 模型会问的话 + 忘了会做错什么。 */
const PROBES = [
  { id: 'P1', statement: '两个引擎绝不能同时启用', query: '两个压缩引擎同时启用 会怎样 引擎互斥 抛错', wrong: '同时启用 compaction-basic 与 argp → 启动即抛错（两个 owner 抢 ctx.compaction），应用打不开' },
  { id: 'P2', statement: '它会用内存快照回写', query: '去重 直接改 sqlite 宿主运行时 会被覆盖吗', wrong: '宿主运行时用外部脚本改库 → 插件下次写盘用内存快照整表覆盖，刚删的又回来、或删掉不该删的' },
  { id: 'P3', statement: '同步 profile 的依赖声明', query: '部署插件 同步 profile 依赖声明 pnpm 回滚', wrong: '只装 tarball 不改 profile package.json → 下一次 pnpm 操作回滚成旧 tgz，插件静默降级' },
  { id: 'P4', statement: '记忆层永远不能让对话失败', query: '记忆层注入失败 会不会影响对话', wrong: '注入/摘要抛错时不吞异常 → 整个对话轮失败，用户看到的是"插件把对话搞挂了"' },
  { id: 'P5', statement: '绝不要用相对路径', query: 'cachePath 相对路径 解析 $DSH_HOME 不要用相对路径', wrong: '用相对路径落盘 → 换个 cwd 就找不到库，记忆看起来"自己丢了"' },
  { id: 'P6', statement: '两份 cordis Service 定义', query: 'esbuild 外部化 @deepseek-ai 内联 两份 cordis Service', wrong: '把宿主包内联进产物 → 出现两份 cordis Service 定义，ctx.tools/settings 不是同一实例，工具注册静默失效' },
  { id: 'P7', statement: '必须能在 node_modules 解析', query: 'patch 插入的行 name 必须能在 node_modules 解析吗', wrong: '在 patch 里插一行依赖包内子路径 → 运行时解析不到，整行失效、插件表面装着其实没挂载' },
  { id: 'P8', statement: '有真实逻辑（参数 schema→JSON Schema）', query: 'defineTool 要不要 import 有没有真实逻辑', wrong: '以为 defineTool 是装饰性的不 import → 工具 schema 生成走错路径，参数校验失效' },
  { id: 'P9', statement: 'BEGIN IMMEDIATE', query: '整库重写 删表再插入 没有事务 会不会留下半截库', wrong: 'replace() 两条语句各自自动提交 → 中途失败留下"表已清空、只写回一部分"，2026-10 那次 digest 18→0 就是这样' },
  { id: 'P10', statement: '永久接受降级', query: 'L2 摘要 失败 退回抽取式 写进 state.digest 会怎样', wrong: '把抽取式残摘要写进 state.digest → 后续每轮都用它且不再重试，一次失败变成永久降级' },
]

const { events } = readSessionFile(join(SNAPSHOT, 'session.v4.jsonl.zstd'))
const window = projectWorkingWindow(events, 8)
const hotTurns = window.hot.map((s) => s.turn)

const shadowed = new Set()
const summaries = []
for (const event of events) {
  if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
    for (const seq of event.data?.shadowedSeqs ?? []) shadowed.add(seq)
    if (event.type === 'compaction/summary') summaries.push({ seq: event.seq, text: (event.data.summary ?? []).map((b) => b.text ?? '').join(''), range: event.data.shadowedRange })
  }
}
const surfaceFrom = Math.max(...summaries.map((s) => s.range?.end ?? -1))
const lastCheckpoint = summaries.at(-1)?.text ?? ''

function textOf(event) {
  if (event.type === 'tool/call') return `${event.data?.name ?? ''} ${event.data?.arguments ?? ''}`
  const message = event.data?.message ?? event.data
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

const starts = events.filter((e) => e.type === 'turn/start').map((e) => ({ seq: e.seq, turn: e.data.turn }))
const turnOf = (seq) => { let t = -1; for (const s of starts) { if (s.seq > seq) break; t = s.turn } return t }

const projections = events.filter((e) => isProjectionEvent(e))
const lastProjectionText = textOf(projections.at(-1))
const idx = (head) => lastProjectionText.indexOf(head)
const section = (start, ends) => {
  const from = idx(start)
  if (from < 0) return ''
  const to = ends.map((h) => idx(h)).filter((i) => i > from).sort((a, b) => a - b)[0] ?? lastProjectionText.length
  return lastProjectionText.slice(from, to)
}
const SEC = {
  l1: section('## L1 工作记忆（Working Memory）', ['## 里程碑主线骨架', '## L2 短期记忆', '## L3 深层记忆']),
  mainline: section('## 里程碑主线骨架（Milestone Mainline）', ['## L2 短期记忆', '## L3 深层记忆']),
  l2: section('## L2 短期记忆（Short-term Memory）', ['## L3 深层记忆']),
  l3: section('## L3 深层记忆（Deep Memory）', []),
}

const flatOf = (texts) => texts.map((t) => t.replace(/\s+/g, ' ')).join('\n')
const messages = events.filter((e) => ['user/message', 'assistant/message', 'tool/result', 'tool/call'].includes(e.type))
const L1TEXT = flatOf(messages.filter((e) => !isProjectionEvent(e) && hotTurns.includes(turnOf(e.seq))).map(textOf))
const SURFACE = flatOf(messages.filter((e) => !isProjectionEvent(e) && e.seq > surfaceFrom).map(textOf))

const records = await (async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(SNAPSHOT, 'deep-memory.sqlite'), { readOnly: true })
  const rows = db.prepare('SELECT * FROM records').all()
  db.close()
  return rows.map((row) => ({
    id: String(row.id), kind: String(row.kind), createdAt: Number(row.createdAt), sessionId: String(row.sessionId),
    turnFrom: Number(row.turnFrom), turnTo: Number(row.turnTo), text: String(row.text), tokens: Number(row.tokens),
    keywords: JSON.parse(String(row.keywords)), refs: JSON.parse(String(row.refs)),
  }))
})()
const ownRecords = records.filter((r) => r.sessionId === SESSION)
const ownFlat = flatOf(ownRecords.map((r) => r.text))

console.log(`探针会用到：L1 窗口 turn ${hotTurns[0]}–${hotTurns.at(-1)}；SURFACE 起点 seq ${surfaceFrom}（最后一次压缩遮蔽范围之后）\n`)
const results = []
for (const probe of PROBES) {
  const layers = {
    L1: L1TEXT.includes(probe.statement),
    SURFACE: SURFACE.includes(probe.statement),
    L2: SEC.l2.includes(probe.statement),
    骨架: SEC.mainline.includes(probe.statement),
    检查点: lastCheckpoint.includes(probe.statement),
    L3: ownFlat.includes(probe.statement),
  }
  const live = ['L1', 'SURFACE', 'L2', '骨架', '检查点'].filter((k) => layers[k])
  const hits = searchRecords(records, probe.query, 3)
  const hitProbe = hits.map((h) => h.text.includes(probe.statement))
  results.push({ ...probe, layers, live, hits: hits.map((h) => ({ kind: h.kind, session: h.sessionId.slice(0, 12), turn: `${h.turnFrom}-${h.turnTo}`, tokens: h.tokens, probe: h.text.includes(probe.statement), head: h.text.replace(/\s+/g, ' ').slice(0, 120) })), recallRank: hitProbe.findIndex(Boolean) + 1 || null })
  console.log(`### ${probe.id} [${probe.locate}]`)
  console.log(`  现在能读到: ${live.join(' / ') || '完全没有'}${layers.L3 ? '   （L3 仅 recall）' : ''}`)
  console.log(`  查询: ${probe.query}`)
  for (const [j, h] of hits.entries()) console.log(`    top${j + 1} ${h.kind} ${h.sessionId.slice(0, 12)} turn${h.turnFrom}-${h.turnTo} ${h.tokens}tok${h.text.includes(probe.statement) ? ' ★命中答案' : ''} :: ${h.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  console.log(`  → recall 把答案带回来了吗: ${results.at(-1).recallRank ? '是（top-' + results.at(-1).recallRank + '）' : '否'}\n`)
}
writeFileSync(join(OUT, 'probes.json'), JSON.stringify(results, null, 2))
console.log('已写 .tmp-diff/probes.json')
const ok = results.filter((r) => r.recallRank).length
console.log(`\n汇总：10 条里 recall top-3 带回答案 ${ok} 条；靠 L1/SURFACE 原文仍可读 ${results.filter((r) => r.live.includes('L1') || r.live.includes('SURFACE')).length} 条；落在 L3（只能 recall）${results.filter((r) => !r.live.length && r.layers.L3).length} 条；哪里都没有 ${results.filter((r) => !r.live.length && !r.layers.L3).length} 条`)
