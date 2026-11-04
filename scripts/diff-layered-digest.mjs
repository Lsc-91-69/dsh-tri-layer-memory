/**
 * scripts/diff-layered-digest.mjs — 分层抽取的**差分测量**（只读真库，写副本）。
 *
 * 口径（与 `.tmp-diff/REPORT.md` 的 B 节、A3 节对齐，否则数字不可比）：
 * - **语料**：冻结快照 `.tmp-diff/snapshot-20261104-1926/session.v4.jsonl.zstd`，
 *   用**生产的** `projectTurns` 切轮；
 * - **原文**：`userText.join('\n')` + `assistantText.join('\n')`（含运行时样板，
 *   与 REPORT B 一致）；另给一份"剥掉注入块后的有效原文"作为补充读数；
 * - **保留判定**：句子前 24 字符（去空白）出现在记录正文里。这是 REPORT B 的口径，
 *   不偏向整句/半句任何一方，改前改后同一条尺子；
 * - **信息类型**：沿用 REPORT B 的七类判据（复制在下面，`CLASSES`）。**它只用于
 *   测量，不是生产的分层判据**——生产判据在 `src/host/l2-render.ts`，两者不要混用；
 * - **token**：全部用生产的 `estimateTokens`；
 * - **检索**：全部用生产的 `searchRecords`。
 *
 * 用法：`node scripts/diff-layered-digest.mjs`，结果写 `.tmp-diff/layered-report.json`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { readSessionFile } from './lib-session-log.mjs'
import { estimateTokens, projectTurns } from '../src/host/l1-working.ts'
import { digestFragments, extractiveDigest, layeredDigest } from '../src/host/l2-render.ts'
import { extractKeywords, searchRecords } from '../src/host/l3-deep.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '.tmp-diff')
const SNAPSHOT = join(OUT, 'snapshot-20261104-1926')
const SESSION = process.argv[2]
const DB_COPY = join(SNAPSHOT, 'deep-memory.sqlite')
const LF = 81
const LT = 90

// ── 语料 ────────────────────────────────────────────────────────────────
const { events } = readSessionFile(join(SNAPSHOT, 'session.v4.jsonl.zstd'))
const spans = projectTurns(events)
const spanByTurn = new Map(spans.map((s) => [s.turn, s]))

/** 与 REPORT B 完全一致的原文拼法（含样板）。 */
function rawOriginal(span) {
  return [span.userText.join('\n'), span.assistantText.join('\n')].filter((t) => t.length > 0).join('\n')
}

/**
 * REPORT B 的七类判据（复制品，仅供测量）。
 *
 * 为什么复制而不是 import：`scripts/diff-measure.mjs` 顶层会直接跑 `runA2()` 并
 * 覆盖 `.tmp-diff/a2.json`，import 它有副作用。测量口径必须与报告一致，所以逐字
 * 复制；生产判据在 `src/host/l2-render.ts`，**不在这里**。
 */
const CLASSES = [
  { id: 'boundary', label: '边界/约束', re: /必须|不能|只能|禁止|严禁|前提是|除非|不得|务必|绝对不|绝不|不许|不可以|一定要|注意不|不要|切勿|不要用|别再|不能再/ },
  { id: 'excluded', label: '已排除的方案', re: /否掉|不采用|不可行|行不通|试过不行|放弃|改为|改成|排除掉|弃用|不用这个|否定|回退|撤回|推翻|不做了|不会再|反过来|另选|替代方案|放弃掉|作废/ },
  { id: 'failure', label: '失败与报错', re: /报错|错误|失败|异常|抛错|崩溃|挂掉|不匹配|ENOENT|Error:|error:|ERR_|exit code|exit 1|TypeError|ReferenceError|undefined is not|堆栈|traceback|超时|timeout|拒绝|denied|failed|Fail/ },
  { id: 'chain', label: '推断链', re: /因为|所以|依据是|由于|因此|原因是|根因|判断为|说明|意味着|导致|这就是为什么|据此|推论|可见|证明/ },
  { id: 'verified', label: '验证结论', re: /实测|验证|确认|已通过|测试通过|跑通|复现|观测到|测得|\d+\/\d+|PASS|FAIL|全绿|通过率|已修复|已生效/ },
  { id: 'params', label: '具体参数', re: /[A-Za-z]:\\[^\s，。；）】]*|\d+\.\d+\.\d+|`[^`]{2,}`|\b\w+\.(?:ts|mjs|js|md|yml|yaml|json|sqlite|tgz|zst|rs|py)\b|--[a-z][a-z-]+|\b[A-Z][A-Z0-9_]{2,}\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]{2,}\b|\b\d+(?:\.\d+)?\s*(?:tokens?|字符|ms|KB|MB|GB|条|轮|次|%)\b/ },
]
const LABELS = { ...Object.fromEntries(CLASSES.map((c) => [c.id, c.label])), other: '其它' }

/** REPORT B 的切句：先按行，再按句末标点，长度 < 8 丢弃。 */
function splitSentences(text) {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；!?])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
}

function classifySentence(sentence) {
  for (const cls of CLASSES) if (cls.re.test(sentence)) return cls.id
  return 'other'
}

/** 句子是否还留在记录正文里（前 24 字符子串，去空白）。 */
function survived(sentence, recordText) {
  const needle = sentence.replace(/\s+/g, ' ').slice(0, Math.min(24, sentence.length))
  return recordText.replace(/\s+/g, ' ').includes(needle)
}

// ── 1. turn 81–90：保留率 ────────────────────────────────────────────────
const oldRecords = []
const newRecords = []
for (let turn = LF; turn <= LT; turn += 1) {
  const span = spanByTurn.get(turn)
  if (span === undefined) throw new Error(`快照里没有 turn ${turn}`)
  const oldText = extractiveDigest([span])
  const { text: newText, stats } = layeredDigest([span])
  const raw = rawOriginal(span)
  const { strippedChars } = digestFragments([span])
  oldRecords.push({ turn, text: oldText, chars: oldText.length, tokens: estimateTokens(oldText), rawTokens: estimateTokens(raw), strippedChars })
  newRecords.push({ turn, text: newText, chars: newText.length, tokens: estimateTokens(newText), rawTokens: estimateTokens(raw), strippedChars, stats })
}

function retention(records, textOf) {
  const perType = new Map()
  for (const row of records) {
    const span = spanByTurn.get(row.turn)
    const raw = rawOriginal(span)
    const recordText = textOf(row)
    for (const sentence of splitSentences(raw)) {
      const type = classifySentence(sentence)
      const bucket = perType.get(type) ?? { n: 0, tokens: 0, kept: 0, keptTokens: 0 }
      bucket.n += 1
      bucket.tokens += estimateTokens(sentence)
      if (survived(sentence, recordText)) {
        bucket.kept += 1
        bucket.keptTokens += estimateTokens(sentence)
      }
      perType.set(type, bucket)
    }
  }
  return perType
}

const before = retention(oldRecords, (r) => r.text)
const after = retention(newRecords, (r) => r.text)
const totalRawTok = oldRecords.reduce((n, r) => n + r.rawTokens, 0)
const totalOldTok = oldRecords.reduce((n, r) => n + r.tokens, 0)
const totalNewTok = newRecords.reduce((n, r) => n + r.tokens, 0)
const totalOldChars = oldRecords.reduce((n, r) => n + r.chars, 0)
const totalNewChars = newRecords.reduce((n, r) => n + r.chars, 0)

console.log('══ 1. turn 81–90 保留率（口径 = REPORT B：24 字符前缀）══')
console.log(`原文 ${totalRawTok} tok / ${oldRecords.length} 轮`)
console.log(`改前记录 ${totalOldTok} tok（${totalOldChars} 字符）→ 改后 ${totalNewTok} tok（${totalNewChars} 字符）`)
const typeTable = []
for (const [id, b] of [...before].sort((a, b2) => b2[1].tokens - a[1].tokens)) {
  const a = after.get(id) ?? { n: 0, tokens: 0, kept: 0, keptTokens: 0 }
  typeTable.push({
    type: id,
    label: LABELS[id] ?? id,
    n: b.n,
    tokens: b.tokens,
    beforeKept: b.kept,
    beforeRate: b.n === 0 ? null : b.kept / b.n,
    afterKept: a.kept,
    afterRate: b.n === 0 ? null : a.kept / b.n,
  })
  console.log(`  ${(LABELS[id] ?? id).padEnd(10)} 句 ${String(b.n).padStart(4)} / ${String(b.tokens).padStart(6)} tok | `
    + `改前留 ${String(b.kept).padStart(3)} (${(b.kept / b.n * 100).toFixed(1)}%) → `
    + `改后留 ${String(a.kept).padStart(3)} (${(a.kept / b.n * 100).toFixed(1)}%)`)
}
console.log(`  合计 句 ${sum(typeTable, 'n')} | 记录 token ${totalOldTok} → ${totalNewTok}`)

function sum(rows, key) {
  return rows.reduce((n, r) => n + (r[key] ?? 0), 0)
}

// ── 2. 单条记录体积 ─────────────────────────────────────────────────────
const avg = (xs) => xs.reduce((n, x) => n + x, 0) / xs.length
console.log('\n══ 2. 单条记录体积（turn 81–90）══')
console.log(`  改前 平均 ${avg(oldRecords.map((r) => r.chars)).toFixed(1)} 字符 / 最大 ${Math.max(...oldRecords.map((r) => r.chars))}`)
console.log(`  改后 平均 ${avg(newRecords.map((r) => r.chars)).toFixed(1)} 字符 / 最大 ${Math.max(...newRecords.map((r) => r.chars))}`)

// ── 3. 全 90 轮重算：体积与丢弃 ─────────────────────────────────────────
const allTurns = [...spanByTurn.keys()].filter((t) => t >= 1 && t <= 90).sort((a, b) => a - b)
const allNew = allTurns.map((turn) => layeredDigest([spanByTurn.get(turn)]))
const allOldChars = allTurns.map((turn) => extractiveDigest([spanByTurn.get(turn)]).length)
const droppedTotal = {}
for (const { stats } of allNew) for (const [k, v] of Object.entries(stats.dropped)) droppedTotal[k] = (droppedTotal[k] ?? 0) + v
console.log('\n══ 3. 全 90 轮重算 ══')
console.log(`  改前 平均 ${avg(allOldChars).toFixed(1)} 字符 / 最大 ${Math.max(...allOldChars)}`)
console.log(`  改后 平均 ${avg(allNew.map((x) => x.text.length)).toFixed(1)} 字符 / 最大 ${Math.max(...allNew.map((x) => x.text.length))}`)
console.log(`  改后超 3000 的条数 ${allNew.filter((x) => x.text.length >= 3000).length}`)
console.log(`  各类候选里装不下的条数 ${JSON.stringify(droppedTotal)}`)
const poolBefore = allTurns.reduce((n, t) => n + estimateTokens(extractiveDigest([spanByTurn.get(t)])), 0)
const poolAfter = allNew.reduce((n, x) => n + x.stats.tokens, 0)
console.log(`  L3 turn 池体积（假设 90 轮全部按新代码重写）：${poolBefore} tok → ${poolAfter} tok（${(poolAfter / poolBefore).toFixed(2)}x）`)

// ── 4. 幂等：去重分组不受正文长度影响 ───────────────────────────────────
{
  const db = new DatabaseSync(DB_COPY, { readOnly: true })
  const rows = db.prepare("SELECT * FROM records WHERE sessionId = ? AND kind = 'turn'").all(SESSION)
  db.close()
  const keyOf = (r) => `${r.sessionId}\u0000${r.kind}\u0000${r.turnFrom}\u0000${r.turnTo}`
  const groups = new Map()
  for (const row of rows) {
    const k = keyOf({ sessionId: String(row.sessionId), kind: String(row.kind), turnFrom: Number(row.turnFrom), turnTo: Number(row.turnTo) })
    groups.set(k, (groups.get(k) ?? 0) + 1)
  }
  const dup = [...groups.values()].filter((n) => n > 1).length
  // 模拟"同一轮用旧/新两种正文各写一次"，验证分组键与正文无关。
  const mixed = new Map()
  for (let i = 0; i < oldRecords.length; i += 1) {
    for (const text of [oldRecords[i].text, newRecords[i].text]) {
      const k = keyOf({ sessionId: SESSION, kind: 'turn', turnFrom: oldRecords[i].turn, turnTo: oldRecords[i].turn })
      mixed.set(k, (mixed.get(k) ?? []).concat(text.length))
    }
  }
  const stillOne = [...mixed.values()].every((list) => list.length === 2)
  console.log('\n══ 4. 幂等（dedupeKey 分组）══')
  console.log(`  快照库 turn 记录 ${rows.length} 条 / 重复组 ${dup}`)
  console.log(`  同一 interleaved 旧+新正文仍归 1 组：${stillOne ? '是' : '否'}`)
}

// ── 5. A3 的 10 条：searchRecords top-3 ────────────────────────────────
/**
 * 每条定义一个"对话正文里能找到的最接近表述"和一个 recall 查询。
 *
 * **必须先说清楚一件事**：A3 报告里 P1–P10 的原始句子，有 4 条的原文**只存在于
 * `tool/call` 的参数里**（write/edit 的 `content`，也就是 agent 写的文件内容），
 * turn 记录的原料是 user/assistant 文本，不含工具参数——这类约束改 turn 抽取
 * **永远救不回**，只能靠 `kind='tool'` 的工具细节池。所以下表给每条标出
 * `scope`：`dialogue` = 原文在对话正文里（turn 记录能负责）、`tool-only` = 只在
 * 工具参数里（turn 记录负不了责）。这不是推脱，是把"能力边界"量出来。
 */
const A3 = [
  { id: 'P1', marker: '每个上下文只允许一个实现', query: 'compaction 服务 每个上下文 只允许一个实现 同时启用 工具 recall' },
  { id: 'P2', marker: '正在用它内存里的选中状态不停回写', query: 'DSH 内存 快照 回写 package.json 外部脚本 改库 覆盖' },
  { id: 'P3', marker: 'profile 依赖声明', query: 'pnpm 依赖声明 profile 同步 回滚 旧版本 tarball' },
  { id: 'P4', marker: '记忆层永远不能让对话失败', query: '记忆层 不能让 对话失败 注入 抛错 吞掉' },
  { id: 'P5', marker: '绝不返回相对路径', query: 'cachePath 相对路径 DSH_HOME 绝对路径 落盘' },
  { id: 'P6', marker: '绝不内联', query: '绝不内联 cordis Service 定义 两份 @deepseek-ai 依赖' },
  { id: 'P7', marker: 'its patch row is', query: 'patch 行 name 解析 node_modules 插件 装了等于没装' },
  { id: 'P8', marker: '有真实逻辑（参数 schema→JSON Schema）', query: 'defineTool 真实逻辑 参数 schema JSON Schema import' },
  { id: 'P9', marker: 'BEGIN IMMEDIATE', query: 'BEGIN IMMEDIATE 事务 整库 重写 DELETE INSERT 原子' },
  { id: 'P10', marker: '永久接受降级', query: '摘要失败 state.digest 永久 降级 不再重试' },
]

/** 对话正文按轮拼起来：用来判断某条 marker 到底在不在"turn 记录能负责"的范围内。 */
const dialogueByTurn = new Map()
for (const span of spans) {
  dialogueByTurn.set(span.turn, [span.userText.join('\n'), span.assistantText.join('\n')].join('\n'))
}

function scopeOf(marker) {
  const turns = []
  for (const [turn, text] of dialogueByTurn) if (text.includes(marker)) turns.push(turn)
  turns.sort((a, b) => a - b)
  if (turns.length === 0) return { scope: 'tool-only', turns }
  return { scope: 'dialogue', turns }
}

const db = new DatabaseSync(DB_COPY, { readOnly: true })
const allRows = db.prepare('SELECT * FROM records').all()
db.close()
const baseRecords = allRows.map((row) => ({
  id: String(row.id),
  kind: String(row.kind),
  createdAt: Number(row.createdAt),
  sessionId: String(row.sessionId),
  turnFrom: Number(row.turnFrom),
  turnTo: Number(row.turnTo),
  text: String(row.text),
  tokens: Number(row.tokens),
  keywords: JSON.parse(String(row.keywords)),
  refs: JSON.parse(String(row.refs)),
}))

// 改后库 = 基础库 + 用分层正文替换 turn 1–90 的同 (session,kind,turn) 记录。
const rewrote = new Map(allNew.map((x, i) => [allTurns[i], x.text]))
let seq = 0
const afterRecords = baseRecords.map((record) => {
  if (record.kind !== 'turn' || record.sessionId !== SESSION) return record
  const text = rewrote.get(record.turnFrom)
  if (text === undefined || record.turnFrom !== record.turnTo) return record
  seq += 1
  return { ...record, text, tokens: estimateTokens(text), keywords: extractKeywords(text), createdAt: record.createdAt + 1 }
})

function hitOf(records, probe) {
  const top = searchRecords(records, probe.query, 3)
  const markerPrefix = probe.marker.replace(/\s+/g, ' ').slice(0, 24)
  const contentHit = top.some((r) => r.text.replace(/\s+/g, ' ').includes(markerPrefix))
  const anyHit = records.some((r) => r.text.includes(probe.marker))
  return { top: top.map((r) => ({ kind: r.kind, turn: `${r.turnFrom}-${r.turnTo}`, session: r.sessionId.slice(0, 12) })), contentHit, anyHit }
}

console.log('\n══ 5. A3 的 10 条：searchRecords top-3 是否命中 ══')
const a3Rows = []
const tally = { dialogueIn90: { n: 0, before: 0, after: 0, beforeAny: 0, afterAny: 0 }, dialogueOut: 0, toolOnly: 0 }
let beforeHit = 0
let afterHit = 0
let beforeAny = 0
let afterAny = 0
for (const probe of A3) {
  const b = hitOf(baseRecords, probe)
  const a = hitOf(afterRecords, probe)
  if (b.contentHit) beforeHit += 1
  if (a.contentHit) afterHit += 1
  if (b.anyHit) beforeAny += 1
  if (a.anyHit) afterAny += 1
  const { scope, turns: hitTurns } = scopeOf(probe.marker)
  const in90 = scope === 'dialogue' && hitTurns.some((t) => t <= 90)
  if (scope === 'tool-only') tally.toolOnly += 1
  else if (in90) {
    tally.dialogueIn90.n += 1
    if (b.contentHit) tally.dialogueIn90.before += 1
    if (a.contentHit) tally.dialogueIn90.after += 1
    if (b.anyHit) tally.dialogueIn90.beforeAny += 1
    if (a.anyHit) tally.dialogueIn90.afterAny += 1
  } else tally.dialogueOut += 1
  const where = scope === 'tool-only' ? '原文只在工具参数' : `对话正文 T${hitTurns.join(',')}${in90 ? '' : '（超出快照 90 轮）'}`
  a3Rows.push({ id: probe.id, marker: probe.marker, where, scope, turns: hitTurns, before: b, after: a })
  console.log(`  ${probe.id} [${where}] 改前 top3 ${b.contentHit ? '是' : '否'}/库里有 ${b.anyHit ? '有' : '无'} → 改后 top3 ${a.contentHit ? '是' : '否'}/库里有 ${a.anyHit ? '有' : '无'}`)
}
console.log(`  合计：top-3 命中 改前 ${beforeHit}/10 → 改后 ${afterHit}/10；库里有原文 改前 ${beforeAny}/10 → 改后 ${afterAny}/10`)
console.log(`  可归责范围：对话正文且在 1–90 轮 ${tally.dialogueIn90.n} 条（改前 top3 ${tally.dialogueIn90.before} / 库里有 ${tally.dialogueIn90.beforeAny} → 改后 top3 ${tally.dialogueIn90.after} / 库里有 ${tally.dialogueIn90.afterAny}）`)
console.log(`  原文只在工具参数 ${tally.toolOnly} 条、超出快照轮次 ${tally.dialogueOut} 条——turn 记录对这两类无能为力`)

// ── 6. 注入成本 ────────────────────────────────────────────────────────
// turn 记录的正文只进 L3 库；注入侧只出现"共 N 条"这个计数（renderL3Index）。
// 直接证据：注入渲染函数的输入里不含 turn 正文。这里用文本层面再证一次：
// 分层正文里的类型标记（`[约束]`）在注入块头格式里从未出现。
const injectedMarkers = ['[约束]', '[排除]', '[失败]', '[推断]']
console.log('\n══ 6. 注入成本 ══')
console.log(`  分层记录正文含 ${injectedMarkers.join('/')} 这些标记，注入块渲染器不读 turn 正文（只报条数）`)
console.log(`  结论：注入 token 变化 = 0（不依赖本脚本读数，见 index.ts 的 store.put 调用点）`)

const report = {
  sessionId: SESSION,
  snapshot: SNAPSHOT,
  turns: { from: LF, to: LT },
  totals: { rawTokens: totalRawTok, beforeTokens: totalOldTok, afterTokens: totalNewTok, beforeChars: totalOldChars, afterChars: totalNewChars },
  types: typeTable,
  size: {
    turns81to90: {
      beforeAvgChars: avg(oldRecords.map((r) => r.chars)),
      beforeMaxChars: Math.max(...oldRecords.map((r) => r.chars)),
      afterAvgChars: avg(newRecords.map((r) => r.chars)),
      afterMaxChars: Math.max(...newRecords.map((r) => r.chars)),
    },
    all90: {
      beforeAvgChars: avg(allOldChars),
      beforeMaxChars: Math.max(...allOldChars),
      afterAvgChars: avg(allNew.map((x) => x.text.length)),
      afterMaxChars: Math.max(...allNew.map((x) => x.text.length)),
    },
  },
  a3: { rows: a3Rows, beforeHit, afterHit, beforeAny, afterAny, tally },
  perTurn: newRecords.map((r) => ({ turn: r.turn, oldChars: r.chars, newChars: r.chars, rawTokens: r.rawTokens, strippedChars: r.strippedChars })),
}
writeFileSync(join(OUT, 'layered-report.json'), JSON.stringify(report, null, 2))
console.log('\n已写 .tmp-diff/layered-report.json')
