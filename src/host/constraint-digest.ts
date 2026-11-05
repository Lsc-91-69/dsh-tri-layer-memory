/**
 * constraint-digest.ts — 把 `tool/call` 参数里的**约束原话**抽成 L3 的 `constraint` 记录。
 *
 * 为什么必须有这一层（实测，不是推断）：
 * `tool-digest.ts` 只读 `tool/result`，而"这些事故不许再犯"的原文大多写在
 * `tool/call.arguments` 里——写进 README 的章节、源码顶部的注释、测试名里的断言。
 * 差集测量（`.tmp-diff/REPORT.md`）确认：10 条硬约束里 **5 条的原文只存在于
 * `tool/call`**（P1 引擎互斥、P4 记忆层不能让对话失败、P5 cachePath 不用相对路径、
 * P6 绝不内联、P7 patch 行 name 必须可解析），而 `turn` 记录的原料是 user/assistant
 * 文本，**改 turn 抽取永远救不回**这 5 条。
 *
 * 边界（与 tool-digest.ts / l3-deep.ts 的分工，逐条对应宿主硬约束）：
 * 1. **独立池**：`constraint` 记录不计入 `l3MaxRecords`，自带条数上限（见
 *    {@link ConstraintCaptureSettings}），存活集合与"没有约束记录时"逐条相同。
 * 2. **不进注入**：只经 `memory_recall` 返回；L3 索引里只多报一行计数。
 * 3. **有界**：单条 ≤ `maxChars`，每会话 ≤ `maxPerSession` 条，整库 ≤ `maxRecords` 条。
 * 4. **可关**：`l3ConstraintDistill` 关闭后行为回到"不看 tool/call 参数"。
 * 5. **幂等**：同一轮只落一条；该轮所有 `tool/call` 一次收集完再写，因此"同轮多次
 *    调用"天然合并，不需要按调用逐条判等。
 * 6. **不碰 `kind='tool'` 那条路**：工具结果池的抽取与落库代码一行不改。
 *
 * 抽取策略（为什么是"句"而不是"行"/"段落"）：
 * - 行会被硬折行切断。实测 P7 的原文在参数里是两行：
 *   `* 2. patch 里每个行 name 必须能在 dependencies 里解析（否则 loader 报` +
 *   `*    "Cannot find package"）。` ——按行抽出来的句子断在括号里，读者无法据此行动。
 * - 段落（空行分隔）会把整段代码/整个函数一起拖进来：实测 16.5 万字符/会话，
 *   其中绝大多数与约束无关。
 * - 句子（先合并软换行，再按句末标点/换行切）实测 3.4 万字符/会话，五条硬约束
 *   全部完整命中，且单句 p95 只有 160 字符。
 *
 * @module dsh-tri-layer-memory/constraint-digest
 */
import type { MemoryRecord } from './l3-deep.ts'
import { constraintStrength } from './l3-deep.ts'
import type { ToolCallHit } from './l1-working.ts'
import { estimateTokens } from './l1-working.ts'

/**
 * 约束记录正文的第一行前缀。
 *
 * 与 `TOOL_RECORD_HEADER` 同样的理由：它必须出现在**正文里**而不只是 `kind` 里——
 * `memory_recall` 按记录通用格式渲染，模型先读到的是正文；把"这是工具参数里的原话、
 * 不是结论"写进正文，任何渲染路径都不会丢掉这句警告。
 */
export const CONSTRAINT_RECORD_HEADER = '约束原话（来自工具调用参数，非结论）'

/**
 * 判定"这句话含约束语义"的词表。
 *
 * 前 8 个是用户指定的口径（也是第一步量化的口径）；后 5 个是同义/强化词，实测让
 * 抽取多 10 句、少漏"严禁/切勿/不得"这类不带前 8 词的句子，成本可忽略。
 * **刻意不含"务必/应该"**：它们是"最好这样"，会把大段普通说明拉进来，稀释记录。
 */
export const CONSTRAINT_WORDS = '必须|不能|绝不|禁止|只能|除非|不要|避免|永远|永不|严禁|切勿|不得'

/** 判断一个字符串是否含约束语义（导出供测试与诊断用）。 */
export const CONSTRAINT_RE = new RegExp(CONSTRAINT_WORDS)

/**
 * 单句字符上限。
 *
 * 实测句子 p95 = 160 字符、最长 424（`unwrapSoftWrap` 合并折行后的一整条说明）。
 * 420 = 实测上限 + 一点余量：再大就会在"单条记录上限配到 800"时连一句都放不下
 * （头部两行 + 来源标签约占 190 字符），那会退化成"配了上限、一条不写"的静默故障。
 * 超过 420 的句子截断并标注——这类句子实测只有个位数，且截断处仍保留约束词本身。
 */
export const CONSTRAINT_SENTENCE_CHARS = 420

/** 每轮最多保留多少句（防止一条畸形参数把整轮预算吃光）。 */
export const CONSTRAINT_SENTENCES_PER_TURN = 120

/** 句末标点（判定"上一行是否已经说完"用，必须锚定结尾）。 */
const SENTENCE_END = /[。！？；!?;]$/

/** 半角句号单独判：`2.`（编号）、`e.g.`（缩写）不算句末。 */
const SENTENCE_END_DOT = /(?<![0-9])\.$/

/** 注释/说明类行（软换行合并只在这些行之间做，避免把代码行拼进句子）。 */
const TEXT_LINE = /^\s*([*#]|\/\/|[-+]\s|\d+[.)]\s|[^\x00-\x7F])/

/** 括号是否未闭合（未闭合说明这句话被折行切断了）。 */
function openParens(text: string): number {
  return (text.split('（').length - text.split('）').length)
    + (text.split('(').length - text.split(')').length)
    + (text.split('「').length - text.split('」').length)
}

/**
 * 把"被硬折行切断的句子"接回一行。
 *
 * 判据（三者满足其一，且上一行有实质长度、不以句末标点结尾）：
 * 1. 上一行与当前行都是注释/说明类行（`*`、`//`、`#`、列表项、CJK 起始）；
 * 2. 当前行有缩进（2 空格以上）——折行的续行几乎总是缩进；
 * 3. 上一行括号未闭合。
 *
 * 为什么不能只按"上一行没句末标点"就拼：实测代码行 `} catch (error: unknown) {`
 * 会被拼进下一行的注释，产生一条读起来像语法错误的"约束句"。
 *
 * @param text - 一段原始文本（工具参数的某个字符串值）。
 * @returns 折行已合并的文本（内容字面不变，只是换行变空格）。
 */
export function unwrapSoftWrap(text: string): string {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const prev = out[out.length - 1]
    if (prev === undefined || prev.length === 0 || line.length === 0) {
      out.push(line)
      continue
    }
    if (SENTENCE_END.test(prev) || SENTENCE_END_DOT.test(prev)) {
      out.push(line)
      continue
    }
    const bothText = TEXT_LINE.test(prev) && (TEXT_LINE.test(line) || /^\s{2,}/.test(raw))
    const continues = prev.length >= 20 && (bothText || openParens(prev) > 0)
    if (continues) out[out.length - 1] = `${prev} ${line}`
    else out.push(line)
  }
  return out.join('\n')
}

/**
 * 从一段文本里抽出"含约束词的句子"。
 *
 * @param text - 原始文本（未合并折行也可，函数内部会先合并）。
 * @returns 句子数组（原顺序，可能为空）。
 */
export function extractConstraintSentences(text: string): string[] {
  if (text.length === 0) return []
  const out: string[] = []
  for (const raw of unwrapSoftWrap(text).split(/(?<=[。！？；!?;])|\n/)) {
    const sentence = raw.trim()
    // 太短的片段（`}`、`});`、`---`）不是句子，即便碰巧含约束词也不算。
    if (sentence.length < 8) continue
    if (!CONSTRAINT_RE.test(sentence)) continue
    out.push(sentence.length > CONSTRAINT_SENTENCE_CHARS
      ? `${sentence.slice(0, CONSTRAINT_SENTENCE_CHARS)}…[截断]`
      : sentence)
  }
  return out
}

/**
 * 把 `data.arguments` 拆成可扫描的文本片段。
 *
 * **解析失败不丢内容**：参数可能是被截断的 JSON（长文件写到一半）或不是 JSON。
 * 解析成功时只扫字符串叶子（数字/布尔没有句子，而且整串 JSON 会把键名也带进来）；
 * 解析失败时退回扫描原文——宁可多扫几百个键名，也不要因为一次 parse 失败把整条
 * 参数里的约束静默丢掉。
 *
 * @param args - `tool/call.data.arguments` 原文。
 * @returns 文本片段（按出现顺序）。
 */
export function argumentTexts(args: string): string[] {
  if (args.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return [args]
  }
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(parsed)
  return out
}

/**
 * 从参数里取"这条调用作用在哪个文件/目标上"，只用于正文的分组标签。
 *
 * 取不到就返回空串（例如 `pwsh` 的 command、`subagent` 的 prompt 没有路径）。
 * 这里做的事是**展示**，不参与任何判等或检索，所以宽容即可。
 */
export function callTarget(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return ''
    for (const key of ['path', 'file_path', 'filePath', 'filename', 'target']) {
      const value = parsed[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    // 解析失败：没有标签，正文里只用工具名与 seq。
  }
  return ''
}

/** 一条约束句的来源信息（写进正文，供人回指原日志）。 */
interface ConstraintItem {
  seq: number
  tool: string
  target: string
  sentence: string
}

/** 从一轮的 `tool/call` 里抽出约束句（轮内去重，保留首次出现的来源）。 */
export function collectConstraintItems(calls: readonly ToolCallHit[]): ConstraintItem[] {
  const seen = new Set<string>()
  const out: ConstraintItem[] = []
  for (const call of calls) {
    const target = callTarget(call.args)
    for (const text of argumentTexts(call.args)) {
      for (const sentence of extractConstraintSentences(text)) {
        // 轮内去重：同一份文件在一次轮里被 write/edit 多次（或 edit 的 old/new 两侧
        // 都含同一句注释）时，同一句话只存一次。跨轮**不**去重：约束在后续轮里被
        // 重述，本身就是"它仍然有效"的证据。
        if (seen.has(sentence)) continue
        seen.add(sentence)
        out.push({ seq: call.seq, tool: call.name, target, sentence })
        if (out.length >= CONSTRAINT_SENTENCES_PER_TURN) return out
      }
    }
  }
  return out
}

/** 约束落库的开关与三个上限（与配置项一一对应）。 */
export interface ConstraintCaptureSettings {
  /** 总开关：false = 行为回到"不看 tool/call 参数"。 */
  enabled: boolean
  /** 单条记录正文字符上限。 */
  maxChars: number
  /** 每会话最多几条约束记录（达到后不再写；已有记录不删）。 */
  maxPerSession: number
  /** 整库最多几条约束记录（超出后按"约束强度"淘汰最弱/最新的）。 */
  maxRecords: number
}

/** 约束落库需要的存储窄接口（与 tool-digest 的同构，便于单测注入假库）。 */
export interface ConstraintCaptureStore {
  all(): readonly MemoryRecord[]
  put(input: {
    kind: MemoryRecord['kind']
    sessionId: string
    turnFrom: number
    turnTo: number
    text: string
    refs?: readonly string[]
  }): MemoryRecord
  /** 按 id 删除并落盘；返回实际删除条数。 */
  remove(ids: readonly string[]): number
}

/**
 * 超上限时的丢弃顺序：**先丢弱约束，同强度丢更晚的句子**。
 *
 * 为什么不是简单截尾：实测本会话 turn 1 的一轮里就有 73 条约束句（216 次工具调用
 * 把整个项目初始文件写了一遍），全文 9,270 字符。截尾会正好丢掉排在后面的
 * `两者绝不能同时启用`（P1）——那是 5 条致命约束之一。所以裁剪必须按"这句话有多硬"
 * 决定去留：`绝不/必须/禁止/永远` 这类强词优先留，同强度再按时间（早的留）。
 *
 * @param items - 当前保留的句子。
 * @returns 应被丢弃的那一条（强度最低、同强度最晚）。
 */
function weakestItem(items: readonly ConstraintItem[]): ConstraintItem {
  let worst = items[0] as ConstraintItem
  let worstScore = constraintStrength(worst.sentence)
  for (const item of items) {
    const score = constraintStrength(item.sentence)
    // `<=`：同强度时后面的（更晚的）算更弱，先丢。
    if (score <= worstScore) {
      worst = item
      worstScore = score
    }
  }
  return worst
}

/**
 * 把一轮的约束句编成一条 L3 记录的正文。
 *
 * 超上限时按"约束强度"裁剪（见 {@link weakestItem}），不是截尾：前者丢的是
 * "不要用临时变量"这种弱句，后者会正好丢 turn 1 后半段的致命约束。
 *
 * @param turn - 轮号。
 * @param calls - 本轮的 `tool/call`（未过滤）。
 * @param maxChars - 单条记录正文上限。
 * @param reserveChars - 调用方已预留的字符（0 = 不预留）。
 * @returns 正文；本轮没有任何约束句时返回 null（不落空记录）。
 */
export function buildConstraintRecordText(
  turn: number,
  calls: readonly ToolCallHit[],
  maxChars: number,
  reserveChars = 0,
): string | null {
  if (calls.length === 0) return null
  const items = collectConstraintItems(calls)
  if (items.length === 0) return null

  let argChars = 0
  for (const call of calls) argChars += call.args.length

  // 头部固定两行：第一行是"非结论"声明，第二行是**可核对的计数**（本轮调用几次、
  // 参数多少字符、抽出几句、存了几句）。计数是判断"这条记录可信到什么程度"的唯一
  // 依据——没有它，读者无法知道是不是还有句子在截断里。
  const header = (stored: number, dropped: number): string =>
    `${CONSTRAINT_RECORD_HEADER} · turn ${turn}\n`
    + `- 本轮工具调用 ${calls.length} 次 / 参数 ${argChars} 字符；抽出约束句 ${items.length} 条（轮内已去重）`
    + `，本记录存 ${stored} 条${dropped > 0 ? `，其余 ${dropped} 条因单条上限未存（先丢弱约束）` : ''}。\n`
    + '- 句子是从参数里**逐字**摘出的（折行处接成一行），没有改写；seq 可回指原日志。'

  const limit = Math.max(0, maxChars - reserveChars)
  // 预算不足时**减少句数而不是返回 null**：配了个上限却一条不写，是最难发现的
  // 静默故障（用户看到"开着"，库里什么也没有）。
  let pool: readonly ConstraintItem[] = items
  let text = `${header(items.length, 0)}\n${renderItems(pool)}`
  while (text.length > limit && pool.length > 1) {
    const drop = weakestItem(pool)
    pool = pool.filter((item) => item !== drop)
    text = `${header(pool.length, items.length - pool.length)}\n${renderItems(pool)}`
  }
  if (pool.length === 0 || limit < 40) return null
  // 兜底：渲染误差不能突破单条上限（上限是给用户看的硬承诺）。
  return text.length <= limit ? text : text.slice(0, limit)
}

/** 渲染句子块：每条句子的来源单独一行，句子本身缩进两格。 */
function renderItems(items: readonly ConstraintItem[]): string {
  const lines: string[] = []
  let lastGroup = ''
  for (const item of items) {
    const group = `${item.tool}${item.target.length > 0 ? ` · ${item.target}` : ''} · seq ${item.seq}`
    // 同一来源的连续句子只写一次来源标签，省掉每句 30 字符的重复。
    if (group !== lastGroup) {
      lines.push(`[${group}]`)
      lastGroup = group
    }
    lines.push(`  ${item.sentence}`)
  }
  return lines.join('\n')
}

/**
 * 为一轮落一条 `constraint` 记录（幂等：同一会话同一轮只写一条）。
 *
 * @param input - 存储、会话、轮号、该轮工具调用与上限。
 * @returns 新记录；未写入（开关关、无约束句、已存在、超每会话上限）时 null。
 */
export function captureConstraintRecord(input: {
  store: ConstraintCaptureStore
  sessionId: string
  turn: number
  calls: readonly ToolCallHit[]
  settings: ConstraintCaptureSettings
}): MemoryRecord | null {
  const { store, sessionId, turn, calls, settings } = input
  if (!settings.enabled) return null
  // 下限 800（与 config 钳制一致）：头部两行 + 来源标签约占 190 字符，再加一句
  // 420 字符的上限句子；低于它就只能落残句，那是"看起来在存"的另一种形态。
  if (settings.maxChars < 800 || settings.maxPerSession <= 0 || settings.maxRecords <= 0) return null
  const records = store.all()
  // 幂等：崩溃/重启后水位可能回退，同一轮被重新扫到时不重复落库。
  // **这一轮里的多次调用不会各自生成记录**——它们在一次扫描里被合并成同一条，
  // 所以"同轮多次调用"不是幂等的例外，而是它天然的样子。
  for (const record of records) {
    if (record.kind === 'constraint' && record.sessionId === sessionId && record.turnFrom === turn) return null
  }
  let sessionCount = 0
  const pool: MemoryRecord[] = []
  for (const record of records) {
    if (record.kind !== 'constraint') continue
    pool.push(record)
    if (record.sessionId === sessionId) sessionCount += 1
  }
  if (sessionCount >= settings.maxPerSession) return null

  const text = buildConstraintRecordText(turn, calls, settings.maxChars)
  if (text === null) return null

  // 整库上限：**不按新近度滚动**（那会先丢最早、也最可能是项目铁律的 turn 1 记录），
  // 而是按"约束强度"留下最硬的：强度 = 强约束词命中数；同强度时**丢更新的**，
  // 因为早期约束是项目奠基，晚期约束多半是一次性任务边界。
  const overflow = pool.length + 1 - settings.maxRecords
  if (overflow > 0) {
    const victims = [...pool]
      .sort((a, b) => (constraintStrength(a.text) - constraintStrength(b.text))
        || (b.createdAt - a.createdAt)
        || b.id.localeCompare(a.id))
      .slice(0, overflow)
      .map((record) => record.id)
    store.remove(victims)
  }

  return store.put({
    kind: 'constraint',
    sessionId,
    turnFrom: turn,
    turnTo: turn,
    text,
    // refs 与 tool 记录同理：不建边，避免在剪枝里享受入边豁免、反过来挤占主内容。
    refs: [],
  })
}

/** 估算一条约束正文的 token（供验收脚本复算，与 store 口径一致）。 */
export function constraintTextTokens(text: string): number {
  return estimateTokens(text)
}
