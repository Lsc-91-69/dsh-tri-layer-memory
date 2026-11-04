/**
 * scripts/diff-measure.mjs — 任务 A / B 的测量主体（只读）。
 *
 * 测量口径（刻意写死在这里，报告里的每个数字都来自这一份实现）：
 *
 * **理论内容（分母）**：会话日志里全部 `user/message`、`assistant/message`、`tool/call`、
 * `tool/result` 的正文。排除：本插件历次投影（production 的 `isProjectionEvent`）、
 * assistant 的 `reasoning` 块、system/developer 消息（不是"历史对话"）。
 *
 * **实际注入（分子）**：模型在最后一轮真正拿到的东西，分两块：
 * 1. `injection` = 日志里**最后一条投影消息**的正文（production 渲染出来的，非重算）；
 * 2. `L1verbatim` = L1 窗口内那几轮的原文（production `projectWorkingWindow` 算窗口）。
 * 另外单独记 `CKPT`（宿主压缩检查点摘要）——它不在插件注入口径里，但确实在 surface 上；
 * 不记它会把"还能读到的信息"误判成"完全没有"，这正是本次要避免的夸大。
 *
 * **信息分类（A2）**：句级。切句后按关键词优先级归类（顺序即优先级，故一条句子只归一类；
 * 多标签命中数另计，报告里单列，避免"因为优先级而少算"的误读）。
 *
 * **落层判定**：句子的原文是否在那一层的文本里（子串命中；mainline 的 40 字符截断
 * 用前缀命中判定）。
 *
 * 用法：
 *   node scripts/diff-measure.mjs a2          # A1+A2 分类表
 *   node scripts/diff-measure.mjs a3          # A3 危害排序 + searchRecords top-3
 *   node scripts/diff-measure.mjs b           # B 抽取式摘要保留率
 *   node scripts/diff-measure.mjs all         # 全跑
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { readSessionEvents, readSessionFile } from './lib-session-log.mjs'
import { contentToText, estimateTokens, isProjectionEvent, projectTurns, projectWorkingWindow } from '../src/host/l1-working.ts'
import { extractKeywords, searchRecords } from '../src/host/l3-deep.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, '.tmp-diff')
mkdirSync(OUT, { recursive: true })
/**
 * 冻结快照：会话是活的，测量期间日志还在增长（实测两次运行之间多出一个 turn，
 * 边界类句数 398→406）。所有数字都基于这一份副本，报告才可复现。
 */
const SNAPSHOT = join(OUT, 'snapshot-20261104-1926')

const SESSION = process.argv[2]
const CWD = 'D:\\deepseek\\deepseekh_work'
const DB_COPY = join(SNAPSHOT, 'deep-memory.sqlite')
/** L1 保留轮数：production 默认值（config-core.ts DEFAULTS.l1RetainTurns）。 */
const L1_RETAIN = 8

// ─────────────────────────────────────────────────────────────────────
// 语料
// ─────────────────────────────────────────────────────────────────────

/** 取一条消息事件的正文（assistant 只要 text 块，排除 reasoning）。 */
function textOf(event) {
  if (event.type === 'tool/call') return `${event.data?.name ?? ''} ${event.data?.arguments ?? ''}`
  const message = event.data?.message ?? event.data
  const content = message?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    return parts.join('\n')
  }
  return typeof content === 'string' ? content : ''
}

/**
 * seq → 轮号。
 *
 * `user/message` 事件**不带 `turn` 字段**（实测：`{"type":"user/message","seq":8,"data":{"content":[…]}}`），
 * 只有 turn/start、turn/end 与 assistant/tool 事件带。直接读 `data.turn` 会把 275 条
 * 用户消息全部标成 `turn -1`，于是它们永远落不进 L1 窗口（窗口按轮号判定）——
 * 那是"看起来算完了、其实整类都算错"的最典型形态，所以这里按 turn/start 的 seq
 * 区间做一次显式映射。
 */
function buildSeqToTurn(events) {
  const starts = events.filter((e) => e.type === 'turn/start').map((e) => ({ seq: e.seq, turn: e.data.turn }))
  return (seq) => {
    let turn = -1
    for (const s of starts) {
      if (s.seq > seq) break
      turn = s.turn
    }
    return turn
  }
}

function buildCorpus() {
  const { file, events } = readSessionFile(join(SNAPSHOT, 'session.v4.jsonl.zstd'))
  const turnOfSeq = buildSeqToTurn(events)
  const shadowed = new Set()
  const summaries = []
  for (const event of events) {
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      for (const seq of event.data?.shadowedSeqs ?? []) shadowed.add(seq)
      if (event.type === 'compaction/summary') {
        summaries.push({ seq: event.seq, text: (event.data.summary ?? []).map((b) => b.text ?? '').join(''), tokens: 0 })
      }
    }
  }
  for (const s of summaries) s.tokens = estimateTokens(s.text)

  const projections = []
  const messages = []
  for (const event of events) {
    if (!['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)) continue
    const text = textOf(event)
    const tokens = estimateTokens(text)
    const turn = event.data?.turn ?? turnOfSeq(event.seq)
    if (isProjectionEvent(event)) {
      projections.push({ seq: event.seq, turn, text, tokens })
      messages.push({ seq: event.seq, turn, kind: 'projection', text, tokens, shadowed: shadowed.has(event.seq) })
      continue
    }
    messages.push({
      seq: event.seq,
      turn,
      kind: event.type,
      text,
      tokens,
      shadowed: shadowed.has(event.seq),
      step: event.data?.step ?? -1,
    })
  }

  // L1 窗口（production 实现，末态）
  const spans = projectTurns(events)
  const window = projectWorkingWindow(events, L1_RETAIN)
  const hotTurns = window.hot.map((s) => s.turn)

  // 最后一条投影消息 = 模型最后一轮真正看到的注入块（production 渲染，非重算）
  const lastProjection = projections.at(-1)
  const sections = splitProjectionSections(lastProjection?.text ?? '')

  return { file, events, shadowed, summaries, projections, messages, spans, window, hotTurns, lastProjection, sections }
}

/**
 * 把注入块切成四段。
 *
 * **不能用「任何 `## ` 行都是段边界」**：L2 摘要正文自己就带 `## 任务主线` /
 * `## 已完成的子任务` 这类小标题（那是摘要模型按 DIGEST_INSTRUCTION 产出的结构），
 * 按"任何 ## 都切"会把 L2 正文全切碎、只留下两行块头——第一版就是这么错的，
 * 症状是 L2 段只有 31 tokens、L2 命中数全是 0。所以边界只认**注入格式自己的四个标题**。
 */
const SECTION_HEADS = [
  ['l1', '## L1 工作记忆（Working Memory）'],
  ['mainline', '## 里程碑主线骨架（Milestone Mainline）'],
  ['l2', '## L2 短期记忆（Short-term Memory）'],
  ['l3', '## L3 深层记忆（Deep Memory）'],
]

function splitProjectionSections(text) {
  const found = []
  for (const [key, head] of SECTION_HEADS) {
    const index = text.indexOf(head)
    if (index >= 0) found.push({ key, head, index })
  }
  found.sort((a, b) => a.index - b.index)
  const out = { l1: '', mainline: '', l2: '', l3: '', raw: text, tokens: estimateTokens(text) }
  for (const [i, section] of found.entries()) {
    const end = i + 1 < found.length ? found[i + 1].index : text.length
    out[section.key] = text.slice(section.index + section.head.length, end).trim()
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 分类
// ─────────────────────────────────────────────────────────────────────

/**
 * 七类信息的判据。顺序 = 优先级（一条句子只归第一类），多标签命中另行统计。
 * 判据是**中文为主、英文兜底**的，因为本项目会话 95% 是中文。
 */
const CLASSES = [
  {
    id: 'boundary',
    label: '边界/约束',
    re: /必须|不能|只能|禁止|严禁|前提是|除非|不得|务必|绝对不|绝不|不许|禁止|不可以|一定要|注意不|不要|切勿|禁止使用|不要用|别再|不能再/,
  },
  {
    id: 'excluded',
    label: '已排除的方案',
    re: /否掉|不采用|不可行|行不通|试过不行|放弃|改为|改成|排除掉|弃用|不用这个|否定|回退|撤回|推翻|不做了|不会再|反过来|另选|替代方案|放弃掉|作废/,
  },
  {
    id: 'failure',
    label: '失败与报错',
    re: /报错|错误|失败|异常|抛错|崩溃|挂掉|不匹配|ENOENT|Error:|error:|ERR_|exit code|exit 1|TypeError|ReferenceError|undefined is not|堆栈|traceback|超时|timeout|拒绝|denied|failed|Fail/,
  },
  {
    id: 'chain',
    label: '推断链',
    re: /因为|所以|依据是|由于|因此|原因是|根因|判断为|说明|意味着|导致|这就是为什么|据此|推论|可见|证明/,
  },
  {
    id: 'verified',
    label: '验证结论',
    re: /实测|验证|确认|已通过|测试通过|跑通|复现|观测到|测得|\d+\/\d+|PASS|FAIL|全绿|通过率|已修复|已生效/,
  },
  {
    id: 'params',
    label: '具体参数',
    // 旧版把裸数字 `\d{2,}` 也算"具体参数"，结果 40,523 句里 20,605 句（52%）被归到
    // 这一类——大部分是 grep 输出的行号。那不是"参数记糊了"，是判据太宽。现在只认
    // **有形状**的参数：盘符路径、x.y.z 版本、反引号标识符、带扩展名的文件、--flag、
    // SCREAMING_CASE、camelCase/snake_case 标识符、带单位的数值。
    re: /[A-Za-z]:\\[^\s，。；）】]*|\d+\.\d+\.\d+|`[^`]{2,}`|\b\w+\.(?:ts|mjs|js|md|yml|yaml|json|sqlite|tgz|zst|rs|py)\b|--[a-z][a-z-]+|\b[A-Z][A-Z0-9_]{2,}\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]{2,}\b|\b\d+(?:\.\d+)?\s*(?:tokens?|字符|ms|KB|MB|GB|条|轮|次|%)\b/,
  },
]

function splitSentences(text) {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；!?])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
}

function classify(sentence) {
  const hits = []
  for (const cls of CLASSES) if (cls.re.test(sentence)) hits.push(cls.id)
  const primary = hits.length > 0 ? hits[0] : 'other'
  return { primary, hits }
}

/** 所有归类句子（带出处）。投影消息本身不参与分类（它是"注入"，不是"历史"）。 */
function classifyCorpus(corpus) {
  const rows = []
  for (const message of corpus.messages) {
    if (message.kind === 'projection') continue
    if (message.text.trim().length === 0) continue
    for (const sentence of splitSentences(message.text)) {
      const { primary, hits } = classify(sentence)
      rows.push({
        turn: message.turn,
        seq: message.seq,
        kind: message.kind,
        sentence,
        tokens: estimateTokens(sentence),
        primary,
        hits,
      })
    }
  }
  return rows
}

// ─────────────────────────────────────────────────────────────────────
// 落层判定
// ─────────────────────────────────────────────────────────────────────

/** 句子在某一层里是否还能读到（子串；截断文本用 12 字符滑动片段兜底）。 */
function inText(sentence, haystacks) {
  const compact = sentence.replace(/\s+/g, ' ').trim()
  for (const hay of haystacks) {
    if (hay.length === 0) continue
    if (hay.includes(compact)) return true
    for (let i = 0; i + 12 <= compact.length; i += 6) {
      if (hay.includes(compact.slice(i, i + 12))) return true
    }
  }
  return false
}

/** 把一层的文本预先压平成"一个可搜字符串"（去空白、超长截断），避免每句都重建数组。 */
function flatten(texts) {
  return texts.map((t) => t.replace(/\s+/g, ' ')).join('\n')
}

function loadRecords() {
  const db = new DatabaseSync(DB_COPY, { readOnly: true })
  const rows = db.prepare('SELECT * FROM records').all()
  db.close()
  return rows.map((row) => ({
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
}

/**
 * 一层的文本。除了"插件注入的四块"，还必须算上 **SURFACE**：压缩之后仍然
 * 原样躺在 prompt 里的那些消息。
 *
 * 为什么必须有这一层（否则整张表都会错）：最后一次压缩只遮蔽 seq 4804–5484；
 * seq 5484 之后的消息**没有被摘要**，它们逐字在上下文里。用实测反推能对上：
 * 最后检查点 17,668 + seq>5484 的消息 357,101 + 系统提示 3,202 + 工具 schema 13,384
 * = 391,376，而 turn 120 实测 prompt 是 400,932（差 2.4%）。不算这一层，会把
 * "就在眼前逐字可读的 30 多万 token"记成"完全没有"，那是彻底的假读数。
 */
function lastShadowEnd(corpus) {
  let end = -1
  for (const s of corpus.summaries) {
    const e = corpus.events.find((ev) => ev.seq === s.seq)?.data?.shadowedRange?.end
    if (typeof e === 'number' && e > end) end = e
  }
  return end
}

/** 一层一层地判：L1 原文 → SURFACE（压缩后仍在 prompt） → L2 → 骨架 → 检查点 → L3 → 完全没有。 */
function assignLayer(row, corpus, flat, options = {}) {
  const surfaceFrom = options.surfaceFrom ?? lastShadowEnd(corpus)
  const strictCkpt = options.strictCkpt ?? true
  if (corpus.hotTurns.includes(row.turn)) return 'L1'
  if (options.useSurface !== false && row.seq > surfaceFrom) return 'SURFACE'
  if (inText(row.sentence, [flat.l2])) return 'L2'
  if (inText(row.sentence, [flat.mainline])) return 'MAINLINE'
  if (inText(row.sentence, [strictCkpt ? flat.ckptLast : flat.ckptAll])) return 'CKPT'
  if (inText(row.sentence, [flat.l3])) return 'L3'
  return 'NONE'
}

// ─────────────────────────────────────────────────────────────────────
// A1 + A2
// ─────────────────────────────────────────────────────────────────────

function runA2() {
  const corpus = buildCorpus()
  const records = loadRecords()
  const own = records.filter((r) => r.sessionId === SESSION)
  const rows = classifyCorpus(corpus)
  const surfaceFrom = lastShadowEnd(corpus)
  // 每层的可搜文本只压平一次：按 4 万句 × 135 条记录逐句重建数组，会把一次测量
  // 拖成分钟级（第一版实测跑不完），而且结果与"压平一次"完全等价。
  const flat = {
    l2: flatten([corpus.sections.l2]),
    mainline: flatten([corpus.sections.mainline]),
    ckptLast: flatten([corpus.summaries.at(-1)?.text ?? '']),
    ckptAll: flatten(corpus.summaries.map((s) => s.text)),
    l3: flatten(own.map((r) => r.text)),
  }
  for (const row of rows) row.layer = assignLayer(row, corpus, flat, { surfaceFrom })
  // 宽松口径（任一检查点即算 CKPT）：报告里作敏感性对照，说明"严格口径"没把小数字
  // 藏在口径选择里。
  for (const row of rows) row.layerLoose = assignLayer(row, corpus, flat, { surfaceFrom, strictCkpt: false })

  const totalTokens = corpus.messages.filter((m) => m.kind !== 'projection').reduce((s, m) => s + m.tokens, 0)
  const injectionTokens = corpus.sections.tokens
  const l1Tokens = corpus.window.tokens

  console.log(`\n===== A1 两端清单 =====`)
  console.log(`理论内容（全部历史正文，已排除投影与 reasoning）：${totalTokens} tokens / ${corpus.messages.filter((m) => m.kind !== 'projection').length} 条消息`)
  const byKind = new Map()
  for (const m of corpus.messages) {
    if (m.kind === 'projection') continue
    const k = byKind.get(m.kind) ?? { n: 0, tokens: 0 }
    k.n += 1
    k.tokens += m.tokens
    byKind.set(m.kind, k)
  }
  for (const [kind, k] of [...byKind].sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`  ${kind.padEnd(18)} ${String(k.n).padStart(5)} 条 / ${String(k.tokens).padStart(8)} tokens`)
  }
  console.log(`实际注入（最后一条投影消息，production 渲染）：${injectionTokens} tokens`)
  console.log(`  ├ L1 块（仅边界声明）    ${estimateTokens(corpus.sections.l1)} tokens`)
  console.log(`  ├ 主线骨架               ${estimateTokens(corpus.sections.mainline)} tokens`)
  console.log(`  ├ L2 摘要                ${estimateTokens(corpus.sections.l2)} tokens`)
  console.log(`  └ L3 索引                ${estimateTokens(corpus.sections.l3)} tokens`)
  console.log(`L1 窗口原文（turn ${corpus.hotTurns[0]}–${corpus.hotTurns.at(-1)}，${corpus.window.dialogueTurns} 轮）：${l1Tokens} tokens`)
  console.log(`模型实际可读的记忆层内容 = ${injectionTokens} + ${l1Tokens} = ${injectionTokens + l1Tokens} tokens`)
  console.log(`对照实测 prompt（turn 120）：400,932 tokens（其中插件注入占 ${(injectionTokens / 400932 * 100).toFixed(2)}%）`)

  console.log(`\n===== A2 按信息类型分类 =====`)
  const labelOf = Object.fromEntries(CLASSES.map((c) => [c.id, c.label]))
  labelOf.other = '其它'

  /**
   * 三条通道分开统计，刻意不合并成一张表：
   * 工具输出里有几万条"失败/参数"句子（grep 出来的代码、日志），把它们与用户说过的
   * "你必须 X"混在一起会得到一张什么都看不出的表。用户与助手正文才是"意图/约束/决策"
   * 的载体；工具通道单独看，才能回答"报错原文丢了多少"。
   */
  const groups = [
    ['dialogue', '对话正文（user + assistant）', (r) => r.kind === 'user/message' || r.kind === 'assistant/message'],
    ['toolcall', '工具调用（tool/call 参数）', (r) => r.kind === 'tool/call'],
    ['toolresult', '工具输出（tool/result）', (r) => r.kind === 'tool/result'],
  ]

  const tables = {}
  const buildTable = (subsetRows) => {
    const out = []
    for (const id of [...CLASSES.map((c) => c.id), 'other']) {
      const subset = subsetRows.filter((r) => r.primary === id)
      const layers = {}
      for (const r of subset) layers[r.layer] = (layers[r.layer] ?? 0) + 1
      out.push({
        id,
        label: labelOf[id],
        count: subset.length,
        tokens: subset.reduce((s, r) => s + r.tokens, 0),
        layers,
        lostCount: subset.filter((r) => r.layer === 'NONE').length,
        lostTokens: subset.filter((r) => r.layer === 'NONE').reduce((s, r) => s + r.tokens, 0),
        multi: subset.filter((r) => r.hits.length > 1).length,
      })
    }
    return out
  }
  const header = '| 类型 | 条数 | token | L1 | SURFACE | L2 | 骨架 | 检查点 | L3 | 完全没有 | 丢失 token | 丢失率 |'
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|'
  const fmt = (t) => [
    '',
    t.label,
    t.count,
    t.tokens,
    t.layers.L1 ?? 0,
    t.layers.SURFACE ?? 0,
    t.layers.L2 ?? 0,
    t.layers.MAINLINE ?? 0,
    t.layers.CKPT ?? 0,
    t.layers.L3 ?? 0,
    t.layers.NONE ?? 0,
    t.lostTokens,
    t.tokens === 0 ? '-' : `${Math.round(t.lostTokens / t.tokens * 100)}%`,
  ].join(' | ')

  for (const [key, label, filter] of groups) {
    const subset = rows.filter(filter)
    const table = buildTable(subset)
    tables[key] = table
    const tokens = subset.reduce((s, r) => s + r.tokens, 0)
    console.log('\n### ' + label + ' / ' + subset.length + ' 句 / ' + tokens + ' tokens')
    console.log(header)
    console.log(sep)
    for (const t of table) if (t.count > 0) console.log(fmt(t))
    const sum = table.reduce((a, t) => ({ n: a.n + t.count, tok: a.tok + t.tokens, lost: a.lost + t.lostCount, lostTok: a.lostTok + t.lostTokens }), { n: 0, tok: 0, lost: 0, lostTok: 0 })
    console.log(`| **合计** | ${sum.n} | ${sum.tok} | | | | | | ${sum.lost} | ${sum.lostTok} | |`)
  }
  tables.all = buildTable(rows)
  const sum = tables.all.reduce((a, t) => ({ n: a.n + t.count, tok: a.tok + t.tokens, lost: a.lost + t.lostCount, lostTok: a.lostTok + t.lostTokens }), { n: 0, tok: 0, lost: 0, lostTok: 0 })
  console.log(`\n句子覆盖率核对：分类句子 token 合计 ${sum.tok} vs 理论内容 ${totalTokens}（句子切分丢掉短句/空行，比值 ${(sum.tok / totalTokens * 100).toFixed(1)}%）`)
  const looseLost = rows.filter((r) => r.layerLoose === 'NONE')
  console.log(`口径敏感性：严格（只认最后一份检查点）完全没有 ${sum.lost} 句 / ${sum.lostTok} tokens；`
    + `宽松（任一检查点即算有）${looseLost.length} 句 / ${looseLost.reduce((s, r) => s + r.tokens, 0)} tokens`)

  writeFileSync(join(OUT, 'a2.json'), JSON.stringify({ totalTokens, injectionTokens, l1Tokens, hotTurns: corpus.hotTurns, tables, rows }, null, 2))
  console.log(`已写 .tmp-diff/a2.json（含 ${rows.length} 条句级明细）`)

  // 抽样：每类各 8 条，供报告引用。优先取"完全没有"的，因为那才是危害评估的输入。
  console.log(`\n===== 每类抽样（对话正文优先，各 8 条，带落层）=====`)
  for (const t of tables.all) {
    const subset = rows.filter((r) => r.primary === t.id)
    if (subset.length === 0) continue
    console.log(`\n### ${t.label}（共 ${t.count} 条 / ${t.tokens} tokens / 最严重层：${t.lostCount} 条完全没有）`)
    const dialogue = subset.filter((r) => r.kind === 'user/message' || r.kind === 'assistant/message')
    const pool = [...dialogue.filter((r) => r.layer === 'NONE').slice(0, 4), ...dialogue.filter((r) => r.layer !== 'NONE').slice(0, 2), ...subset.filter((r) => r.kind !== 'user/message' && r.kind !== 'assistant/message').slice(0, 2)]
    for (const [i, r] of pool.entries()) {
      console.log(`  [${t.id}-${i + 1}] turn ${r.turn} ${r.kind} [${r.layer}] ${r.tokens}tok :: ${r.sentence.replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
  return { corpus, rows, tables, totalTokens, injectionTokens, l1Tokens }
}

export { buildCorpus, classifyCorpus, loadRecords, assignLayer, CLASSES, OUT, SESSION, CWD, splitSentences, inText, SNAPSHOT, lastShadowEnd, flatten }

// ─────────────────────────────────────────────────────────────────────
// A3：危害排序 + 生产 searchRecords 实测
// ─────────────────────────────────────────────────────────────────────

/** 危害关键词：出现即上调严重度（这些词对应的错误后果最贵）。 */
const HARM_WORDS = ['部署', '契约', '回滚', '删除', '删坏', '双写', '覆盖', '数据', '崩溃', '禁止', '不得', '绝不能', '必须', 'profile', 'pnpm', 'schema', '事务', '备份']

/**
 * 一条句子"忘了会怎样"的**严重度打分**。
 *
 * 这不是精确科学：它是把"用户说的 > 助手说的"、"含硬约束词 > 含软约束词"、
 * "涉及部署/数据/契约 > 涉及局部实现"这三条排序直觉写成可复现的分数，好让 Top 10
 * 不是我挑出来的。分数相同的按轮次升序（更早的更需要 recall，因为更可能已被遮蔽）。
 */
function severityOf(row) {
  let score = 0
  if (row.kind === 'user/message') score += 40
  for (const word of HARM_WORDS) if (row.sentence.includes(word)) score += 6
  if (/(必须|不能|只能|禁止|绝不|不得|除非|前提是)/.test(row.sentence)) score += 20
  if (/(不采用|放弃|改为|否掉|推翻|回退|行不通)/.test(row.sentence)) score += 12
  if (row.sentence.length > 24) score += 3
  if (row.layer !== 'NONE') score -= 30
  return score
}

function runA3() {
  const corpus = buildCorpus()
  const records = loadRecords()
  const own = records.filter((r) => r.sessionId === SESSION)
  const rows = classifyCorpus(corpus)
  const surfaceFrom = lastShadowEnd(corpus)
  const flat = {
    l2: flatten([corpus.sections.l2]),
    mainline: flatten([corpus.sections.mainline]),
    ckptLast: flatten([corpus.summaries.at(-1)?.text ?? '']),
    l3: flatten(own.map((r) => r.text)),
  }
  for (const row of rows) row.layer = assignLayer(row, corpus, flat, { surfaceFrom })

  const candidates = rows
    .filter((r) => (r.primary === 'boundary' || r.primary === 'excluded')
      && (r.kind === 'user/message' || r.kind === 'assistant/message')
      && r.layer === 'NONE')
    .map((r) => ({ ...r, severity: severityOf(r) }))
    .sort((a, b) => (b.severity - a.severity) || (a.turn - b.turn))

  console.log(`A3 候选：完全没有、且属于边界/已排除的对话句 ${candidates.length} 条`)
  const out = []
  for (const row of candidates.slice(0, 40)) {
    // 查询串 = 生产 extractKeywords 从**这条句子本身**抽出的词（模拟"模型知道要找什么"）：
    // 这是对 recall 最有利的用法（模型手里还有句子里的关键词），因此结果偏乐观；
    // 报告里会明确写这一点，不拿它当"能召回"的上界之外的证据。
    const keywords = extractKeywords(row.sentence, 6)
    const query = keywords.join(' ')
    const hits = query.length === 0 ? [] : searchRecords(records, query, 3)
    const hitOwn = hits.findIndex((h) => h.sessionId === SESSION && h.turnFrom <= row.turn && h.turnTo >= row.turn)
    out.push({
      turn: row.turn,
      kind: row.kind,
      severity: row.severity,
      tokens: row.tokens,
      sentence: row.sentence,
      query,
      recallTop3: hits.map((h) => ({ id: h.id, kind: h.kind, session: h.sessionId.slice(0, 12), turn: `${h.turnFrom}-${h.turnTo}`, tokens: h.tokens, head: h.text.replace(/\s+/g, ' ').slice(0, 120) })),
      sameTurnHit: hitOwn >= 0,
      sameTurnRank: hitOwn >= 0 ? hitOwn + 1 : null,
    })
  }
  writeFileSync(join(OUT, 'a3.json'), JSON.stringify({ candidates: candidates.length, out }, null, 2))
  for (const [i, row] of out.entries()) {
    console.log(`\n[#${i + 1}] sev=${row.severity} turn ${row.turn} ${row.kind} ${row.tokens}tok`)
    console.log(`  句子: ${row.sentence.replace(/\s+/g, ' ').slice(0, 200)}`)
    console.log(`  查询: ${row.query || '(空)'}`)
    for (const [j, h] of row.recallTop3.entries()) {
      console.log(`   top${j + 1} ${h.kind} ${h.session} turn${h.turn} ${h.tokens}tok :: ${h.head}`)
    }
    console.log(`  同轮命中: ${row.sameTurnHit ? '是（top-' + row.sameTurnRank + '）' : '否'}`)
  }
  console.log(`\n已写 .tmp-diff/a3.json（${out.length} 条）`)
}

// ─────────────────────────────────────────────────────────────────────
// A4：五个真实场景的落地测试
// ─────────────────────────────────────────────────────────────────────

/**
 * 场景表：每个场景给
 * - `probes`：可以在原文里定位这条知识的关键片段（任一命中即"这条知识在这层里有"）；
 * - `query`：模型在最坏情况下会问的那句话（**由我按真人提问习惯写死**，不是从答案倒推）；
 * - `wrong`：忘了它会做的错事（报告用）。
 */
const SCENARIOS = [
  {
    id: 'S1',
    title: '部署插件时要不要同步 profile 的依赖声明？',
    probes: ['同步 profile', 'package.json.before-depsync', '回滚陷阱', 'pnpm 回滚'],
    query: '部署插件 同步 profile 依赖 pnpm 回滚 file tgz',
    wrong: '只 tarball 安装、不改 profile 的 package.json → 下一次 pnpm 操作把本地包回滚成旧 tgz，插件版本静默回退',
  },
  {
    id: 'S2',
    title: '去重能不能在宿主运行时用外部脚本直接改 sqlite？',
    probes: ['外部脚本', '直连 sqlite', '内存快照', '双 owner'],
    query: '去重 外部脚本 直连 sqlite 宿主运行时 内存快照 覆盖',
    wrong: '宿主运行时直连改库 → 插件下次写盘用旧内存快照整表覆盖回去（或半截库），删掉不该删的记录',
  },
  {
    id: 'S3',
    title: "B′ 方案（按事件类型粒度注入 / 改投影累积）能不能做？",
    probes: ['纯函数', '热禁用', '事件类型粒度', 'B′'],
    query: 'B 方案 按事件类型粒度 投影 纯函数契约 热禁用 抛错',
    wrong: '按事件类型粒度注入 → 破坏 projection 纯函数契约，投影被替换/移除时抛错，界面直接消失',
  },
  {
    id: 'S4',
    title: 'L2 摘要失败时退回抽取式、并把它写进 state.digest —— 这个降级能接受吗？',
    probes: ['永久接受降级', '退回抽取式', 'state.digest', 'buildDigest'],
    query: 'L2 摘要 失败 退回抽取式 state.digest 永久降级',
    wrong: '把抽取式结果写进 state.digest → 之后每一轮都拿这份残摘要，且不再重试，降级变永久',
  },
  {
    id: 'S5',
    title: '能不能两个压缩引擎行同时启用？',
    probes: ['绝不能同时启用', '两个引擎', 'compaction-basic 必须', '引擎互斥'],
    query: '两个压缩引擎 同时启用 compaction 引擎互斥 抛错',
    wrong: '两个引擎同时启用 → 直接抛错（启动即失败），或双写压缩结果导致历史被覆盖',
  },
]

function runA4() {
  const corpus = buildCorpus()
  const records = loadRecords()
  const own = records.filter((r) => r.sessionId === SESSION)
  const surfaceFrom = lastShadowEnd(corpus)
  const lastProj = corpus.sections

  // 每一层的可搜文本（A4 要回答"模型此刻能不能读到"，所以 SURFACE 也算一层）
  const surfaceText = flatten(corpus.messages.filter((m) => m.kind !== 'projection' && m.seq > surfaceFrom).map((m) => m.text))
  const l1Text = flatten(corpus.messages.filter((m) => m.kind !== 'projection' && corpus.hotTurns.includes(m.turn)).map((m) => m.text))

  console.log('A4 落地测试：五个真实场景\n')
  const results = []
  for (const scenario of SCENARIOS) {
    const hit = (hay) => scenario.probes.filter((p) => hay.includes(p))
    const layers = {
      L1原文: hit(l1Text),
      SURFACE逐字: hit(surfaceText),
      L2摘要: hit(flatten([lastProj.l2])),
      主线骨架: hit(flatten([lastProj.mainline])),
      最后检查点: hit(flatten([corpus.summaries.at(-1)?.text ?? ''])),
      L3记录: hit(flatten(own.map((r) => r.text))),
    }
    const recall = searchRecords(records, scenario.query, 3)
    // "recall 有没有把答案带回来"：看 top-3 的正文里有没有命中这条知识的探针片段。
    // 这是比"同轮命中"更严的判据——模型读到的必须是**这条约束本身**，而不是同轮别的废话。
    const recallProbe = recall.map((r) => scenario.probes.filter((p) => r.text.includes(p)))
    const recallHasAnswer = recallProbe.some((hits) => hits.length >= 2)
    // "下一次压缩之后"视角：宿主检查点与 SURFACE 原文都会被替换，只剩插件自己的四块。
    const pluginOnly = { L2摘要: layers.L2摘要, 主线骨架: layers.主线骨架, L3记录: layers.L3记录 }
    const survivesNextCompaction = Object.entries(pluginOnly).filter(([, v]) => v.length > 0).map(([k]) => k)
    // "能找到"的判据：命中的层里，至少有一层是**模型此刻真能读到的**
    // （L1 原文 / SURFACE / 注入块 / 检查点）；L3 只算"可 recall"。
    const readable = ['L1原文', 'SURFACE逐字', 'L2摘要', '主线骨架', '最后检查点'].filter((k) => layers[k].length > 0)
    const verdict = readable.length >= 2 ? '能找到' : (readable.length === 1 ? '只能找到残缺版' : '完全找不到')
    results.push({ id: scenario.id, title: scenario.title, query: scenario.query, layers, recall: recall.map((r) => ({ kind: r.kind, session: r.sessionId.slice(0, 12), turn: `${r.turnFrom}-${r.turnTo}`, tokens: r.tokens, head: r.text.replace(/\s+/g, ' ').slice(0, 140) })), verdict, wrong: scenario.wrong, recallHasAnswer, survivesNextCompaction })
    console.log(`### ${scenario.id} ${scenario.title}`)
    console.log(`  查询: ${scenario.query}`)
    for (const [k, v] of Object.entries(layers)) console.log(`  ${k.padEnd(12)} 命中: ${v.length > 0 ? v.join(' / ') : '—'}`)
    console.log(`  → 判定: ${verdict}    下一次压缩后仍留在插件四块的: ${survivesNextCompaction.join('/') || '无'}`)
    console.log(`  recall top-3（答案在这 3 条里？${recallHasAnswer ? '是' : '否'}）:`)
    for (const [j, r] of recall.entries()) console.log(`    top${j + 1} ${r.kind} ${r.sessionId.slice(0, 12)} turn${r.turnFrom}-${r.turnTo} ${r.tokens}tok 探针[${recallProbe[j].join(',') || '—'}] :: ${r.text.replace(/\s+/g, ' ').slice(0, 130)}`)
    console.log(`  忘了会做错: ${scenario.wrong}\n`)
  }
  writeFileSync(join(OUT, 'a4.json'), JSON.stringify(results, null, 2))
  console.log('已写 .tmp-diff/a4.json')
}

// ─────────────────────────────────────────────────────────────────────
// B：抽取式摘要的保留率
// ─────────────────────────────────────────────────────────────────────

function runB() {
  const corpus = buildCorpus()
  const records = loadRecords()
  const own = records.filter((r) => r.sessionId === SESSION && r.kind === 'turn')
  // 取轮号最大的 10 条 turn 记录（最新、也最可能是模型还会碰到的轮次）
  const picked = [...own].sort((a, b) => b.turnTo - a.turnTo).slice(0, 10)

  console.log('B 抽取式摘要保留率：原文 vs L3 turn 记录\n')
  const summary = []
  const perType = new Map()
  for (const record of picked) {
    const span = corpus.spans.find((s) => s.turn === record.turnFrom)
    const original = span === undefined
      ? corpus.messages.filter((m) => m.kind !== 'projection' && m.turn === record.turnFrom).map((m) => m.text).join('\n')
      : [span.userText.join('\n'), span.assistantText.join('\n')].filter((t) => t.length > 0).join('\n')
    const tokensOriginal = estimateTokens(original)
    const tokensRecord = estimateTokens(record.text)
    const sentences = splitSentences(original)
    const byType = {}
    let kept = 0
    let keptTokens = 0
    for (const sentence of sentences) {
      const { primary } = classify(sentence)
      const tokens = estimateTokens(sentence)
      const survived = record.text.replace(/\s+/g, ' ').includes(sentence.replace(/\s+/g, ' ').slice(0, Math.min(24, sentence.length)))
      const bucket = byType[primary] ?? { n: 0, tokens: 0, kept: 0, keptTokens: 0 }
      bucket.n += 1
      bucket.tokens += tokens
      if (survived) {
        bucket.kept += 1
        bucket.keptTokens += tokens
        kept += 1
        keptTokens += tokens
      }
      byType[primary] = bucket
      const agg = perType.get(primary) ?? { n: 0, tokens: 0, kept: 0, keptTokens: 0 }
      agg.n += 1
      agg.tokens += tokens
      agg.kept += survived ? 1 : 0
      agg.keptTokens += survived ? tokens : 0
      perType.set(primary, agg)
    }
    const exclusionSentences = sentences.filter((s) => /(不采用|放弃|改为|否掉|推翻|回退|行不通|不用)/.test(s))
    const exclusionKept = exclusionSentences.filter((s) => record.text.includes(s.slice(0, Math.min(24, s.length))))
    summary.push({
      turn: record.turnFrom,
      tokensOriginal,
      tokensRecord,
      ratio: tokensOriginal === 0 ? null : tokensRecord / tokensOriginal,
      sentences: sentences.length,
      kept,
      keptTokens,
      byType,
      exclusion: { n: exclusionSentences.length, kept: exclusionKept.length },
      recordText: record.text,
      originalHead: original.slice(0, 400),
    })
    console.log(`turn ${record.turnFrom}: 原文 ${tokensOriginal} tok / 记录 ${tokensRecord} tok = ${(tokensRecord / tokensOriginal * 100).toFixed(1)}%；句子 ${sentences.length} 条，记录里还剩 ${kept} 条；排除性句 ${exclusionSentences.length} → 剩 ${exclusionKept.length}`)
  }
  const totalOrig = summary.reduce((s, x) => s + x.tokensOriginal, 0)
  const totalRec = summary.reduce((s, x) => s + x.tokensRecord, 0)
  console.log(`\n10 轮合计：原文 ${totalOrig} tok → 记录 ${totalRec} tok（${(totalRec / totalOrig * 100).toFixed(1)}%，压缩 ${(totalOrig / totalRec).toFixed(1)}x）`)
  console.log('\n按信息类型的保留率（10 轮合计）：')
  const labelOf = Object.fromEntries(CLASSES.map((c) => [c.id, c.label]))
  labelOf.other = '其它'
  const typeRows = []
  for (const [id, agg] of [...perType].sort((a, b) => b[1].n - a[1].n)) {
    typeRows.push({ id, label: labelOf[id] ?? id, ...agg, rate: agg.n === 0 ? null : agg.kept / agg.n })
    console.log(`  ${(labelOf[id] ?? id).padEnd(8)} 句 ${String(agg.n).padStart(4)} 条 / ${String(agg.tokens).padStart(6)} tok → 保留 ${String(agg.kept).padStart(3)} 条（${(agg.kept / agg.n * 100).toFixed(1)}%）/ ${agg.keptTokens} tok`)
  }
  const totalExcl = summary.reduce((s, x) => s + x.exclusion.n, 0)
  const totalExclKept = summary.reduce((s, x) => s + x.exclusion.kept, 0)
  console.log(`\n排除性信息（\"不采用/放弃/改为/推翻\"）：原文 ${totalExcl} 条 → 记录里剩 ${totalExclKept} 条（${totalExcl === 0 ? '-' : (totalExclKept / totalExcl * 100).toFixed(1)}%）`)
  writeFileSync(join(OUT, 'b.json'), JSON.stringify({ summary, typeRows, totalOrig, totalRec, totalExcl, totalExclKept }, null, 2))
  console.log('已写 .tmp-diff/b.json')
}

const mode = process.argv[2] ?? 'a2'
if (mode === 'a2') runA2()
if (mode === 'a3') runA3()
if (mode === 'a4') runA4()
if (mode === 'b') runB()
