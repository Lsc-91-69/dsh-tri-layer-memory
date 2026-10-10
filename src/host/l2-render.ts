/**
 * l2-render.ts — L2 短期记忆的**纯**渲染与抽取逻辑（无 `@deepseek-ai/*` 依赖）。
 *
 * 与 `l2-short.ts` 分开是为了让确定性部分（摘要输入渲染、0-LLM 抽取、
 * 注入文本渲染、provider 解析）能被 Node 直接执行并单测；`l2-short.ts` 只留
 * 真正需要 `ctx.llm` seam 的调用。
 *
 * @module dsh-tri-layer-memory/l2-render
 */
import { estimateTokens } from './l1-working.ts'
import type { TurnSpan } from './l1-working.ts'

/**
 * L2 摘要**本该走模型却退回抽取式**的原因。
 *
 * 为什么要有这个类型：`buildDigest` 的回退是刻意的（摘要失败绝不能拖垮对话），
 * 但"刻意回退"和"静默回退"是两回事——回退原因一旦丢掉，观察面就只剩一个
 * `via: 'extractive'`，看不出是模型缺席、路由解析不到、还是调用真的抛了错。
 * 这个故障在真实会话里藏了很久（L2 一直是抽取式），根因就是被丢掉的这一行。
 */
export interface DigestFailure {
  /**
   * 失败发生在哪一步：
   * - `llm-missing`：`llm` seam 拿不到（服务缺席或获取路径没命中）；
   * - `target-missing`：provider/model 解析不到（无路由信息，或解析本身抛错）；
   * - `llm-error`：调用发出去了，但流以错误/取消/截断/空文本收尾。
   */
  stage: 'llm-missing' | 'target-missing' | 'llm-error'
  /** 面向人的一句话；`llm-error` 时带上异常消息原文。 */
  message: string
}

/**
 * 一次摘要调用的**可观察读数**（诊断用，不参与注入渲染）。
 *
 * **为什么要有它**：这个插件栽过的每一次静默故障，都是"观察面只有一句结论、
 * 没有读数"。截断这一次尤其如此——诊断只写了"summarization truncated at the
 * token cap"，而**到底是推理吃光了预算、还是模型写了 4000 tokens 的正文**，
 * 这两个根因的修法完全不同（前者要压推理，后者要压期望长度）。没有读数就只能猜，
 * 猜错的代价是再部署一轮、再等一个版本周期。
 *
 * 因此把能拿到的事实全部记下来：终止原因、请求里的上限、输入多大、正文产出多少、
 * provider 上报的用量原样（**推理 token 的真相在这里**：pi-ai 把推理折进
 * `outputTokens`，因此"推理 vs 正文"只能靠"上限 vs outputTokens vs 正文字符数"
 * 三者对不上来推断，见 l2-short.ts 的说明）。
 */
export interface DigestAttempt {
  /** 终止原因的实际值：`stop` / `max-tokens` / `error` / `aborted` / `none`（流没给 finish）。 */
  finish: string
  /** 请求里**实际发出**的输出上限。与配置比对可判断"上限是不是真的生效了"。 */
  maxTokens: number
  /** 摘要输入的字符数。 */
  inputChars: number
  /** 摘要输入的估算 token 数。 */
  inputTokens: number
  /** 模型产出的正文字符数（**丢弃前**的原始长度；这是判断"模型到底写了多少"的唯一依据）。 */
  outputChars: number
  /** provider 上报的用量，原样透传（无 `usage` 块时缺省）。 */
  usage?: unknown
  /** 撞上限时是否保住了正文（`false` 且 finish=max-tokens = 正文为空，只能回退）。 */
  salvaged: boolean
  /** 被边界裁掉的尾部字符数（`salvaged` 为真时才有意义）。 */
  droppedChars: number
  /** 截断点对齐到什么：`line`（行边界）/ `sentence`（句边界）/ `raw`（没有边界可对齐）。 */
  boundary: 'line' | 'sentence' | 'raw' | 'none'
  /**
   * 请求里带的 reasoningEffort；`inherit` = 没带（交给宿主/网关默认）。
   *
   * 注意与 {@link DigestAttempt.effortRetry} 一起读：`effortRetry` 为真时，
   * **最终那次**调用没有带这个字段（第一次因为不被支持被拒了，见 `firstFailure`）。
   */
  reasoningEffort: string
  /** 是否因该 effort 不被支持而**去掉该字段重试过一次**。 */
  effortRetry: boolean
  /** 重试前的原始失败消息（只有 `effortRetry` 为真时才有）。 */
  firstFailure?: string
}

/**
 * 句末标点的识别。
 *
 * 中文的 `。！？` 是**无歧义**的句末，后面紧跟下一个字也算（中文排版不加空格）。
 * 英文的 `.!?` 必须后接空白或结尾才算——否则 `v4.1`、`config.yml`、`l2-short.ts`
 * 里的点会被当成句号，把路径切成半截，那比不裁更糟（路径是必须逐字保留的事实）。
 */
const SENTENCE_END_GLOBAL = /[。！？]|[.!?](?=\s|$)/g

/** 文本是否**已经**落在句末标点上（那就是完整结尾，不该再裁）。 */
const ENDS_AT_SENTENCE = /[。！？]$|[.!?]$/

/** 最后一个句末标点的**结束位置**（含标点）；找不到时为 -1。 */
function lastSentenceEnd(text: string): number {
  let last = -1
  for (const match of text.matchAll(SENTENCE_END_GLOBAL)) last = (match.index ?? -1) + match[0].length
  return last
}

/**
 * 把一段**被输出上限截断**的正文裁到最后一个完整行/句边界。
 *
 * 为什么要裁而不是原样保留：摘要的尾部必然是半句话（`- 关键决策：把 inject 的`），
 * 半句话在注入里是噪声，还容易被读成"这就是结论"。裁到边界只损失半句，换来的是
 * 整段可读——而被整段丢弃（旧行为）损失的是**全部**。
 *
 * 规则（按这个顺序）：
 * 1. 已经以句末标点结尾 → 尾部本来就是完整的，原样保留（`droppedChars: 0`）；
 * 2. 否则退到**最近的一个边界**：行边界（换行）与句边界（句末标点）取更靠后的那个
 *    ——两者都保证"不切出半个句子"，取靠后的那个保证"少丢一点"；
 * 3. 一个边界都没有（单行、无标点的正文）→ **原样保留**并记为 `raw`。
 *    刻意不丢：一份没有句末标点的正文仍然是模型产出的摘要骨架，
 *    "没有完美边界"不该成为"全部丢弃"的理由——那正是本函数要修掉的旧行为。
 *
 * @param text - 模型产出的（可能被截断的）正文。
 * @returns 裁好的正文、丢弃的字符数、对齐到哪种边界。
 */
export function trimAtBoundary(text: string): {
  text: string
  droppedChars: number
  boundary: 'line' | 'sentence' | 'raw'
} {
  const whole = text.trimEnd()
  if (whole.length === 0) return { text: '', droppedChars: 0, boundary: 'raw' }
  if (ENDS_AT_SENTENCE.test(whole)) return { text: whole, droppedChars: 0, boundary: 'sentence' }

  const lastLine = whole.lastIndexOf('\n')
  const lastSentence = lastSentenceEnd(whole)
  const cut = Math.max(lastLine, lastSentence)
  if (cut <= 0) return { text: whole, droppedChars: 0, boundary: 'raw' }

  const head = whole.slice(0, cut).trimEnd()
  if (head.length === 0) return { text: whole, droppedChars: 0, boundary: 'raw' }
  return {
    text: head,
    droppedChars: whole.length - head.length,
    boundary: lastSentence > lastLine ? 'sentence' : 'line',
  }
}

/** 一次摘要的结果与出处。 */
export interface DigestResult {
  /** 摘要正文。 */
  text: string
  /** 生成方式。 */
  via: 'llm' | 'extractive'
  /** 覆盖的轮号区间起点。 */
  turnFrom: number
  /** 覆盖的轮号区间终点。 */
  turnTo: number
  /** 摘要正文的估算 token 数。 */
  tokens: number
  /** 被压缩原文的估算 token 数（用于计算压缩率）。 */
  sourceTokens: number
  /** 生成时间。 */
  createdAt: number
  /** LLM 模式下的 provider/model。 */
  target?: { provider: string; model: string }
  /**
   * 只在本该走模型（`mode === 'llm'`）却退回抽取式时出现——**这是唯一的失败原因出口**，
   * 由 `refreshDigest` 存进会话状态并暴露到 `memory_state`。
   */
  fallback?: DigestFailure
  /**
   * 本次摘要调用的读数（成功、被截断保留、失败都带）。
   *
   * 与 `fallback` 的分工：`fallback` 回答"为什么退回了抽取式"（只在失败时出现），
   * `attempt` 回答"这次调用到底发生了什么"（任何一次真发出去的调用都有）。
   * `attempt.salvaged === true` 表示**这份 LLM 摘要被截过但仍在用**——观察面上
   * 它必须与"完全失败"区分开，否则"截断"会被读成"没走模型"。
   */
  attempt?: DigestAttempt
}

/**
 * L2 摘要指令：要求结构化、保留可执行事实、**写明期望长度**，且不提及"被压缩"本身。
 *
 * 与 dsh-compaction-basic 的 checkpoint 指令同构但更短：L2 是每轮注入的滚动
 * 摘要，必须省 token；完整 checkpoint 由压缩引擎负责。
 *
 * **期望长度这一条是后补的，补它的理由是一条真实故障链**：指令过去只说
 * "use terse bullets"，**从没说过"写多长"**——于是"短"这件事全靠模型自觉。
 * 而它上游有两个数字都在暗示"可以很长"：请求里的输出上限（4096）是注入预算
 * （`injectionBudgetTokens`，默认 1200）的三倍多，而摘要**即便写满 4096，
 * 注入时也会被预算截掉大半**——写长了不但没用，还会撞上限（正文被整份丢弃，
 * 见 l2-short.ts 的截断保留）。现在把期望长度写死在一个与注入预算相称的量级上：
 * 约 600 tokens ≈ 默认注入预算的一半，另一半留给 L1 标记、L3 索引与注入块头。
 */
export const DIGEST_INSTRUCTION = [
  'Condense the conversation excerpt ABOVE into a short-term memory digest for this AI coding assistant.',
  'Output EXACTLY the Markdown structure below, keep every section, use terse bullets, write "(none)" for an empty section.',
  '',
  '## 任务主线',
  '- [用户的目标及其演变]',
  '',
  '## 已完成的子任务',
  '- [做完的事 + 关键结论]',
  '',
  '## 关键决策与依据',
  '- [决定了什么、为什么]',
  '',
  '## 未决问题',
  '- [尚未解决的点]',
  '',
  'Rules:',
  '- Length: keep the WHOLE digest under about 600 tokens (roughly 25-30 terse bullets). It is re-injected into every later turn, so shorter is strictly better.',
  '- When you must cut, drop the least important bullets first — never drop exact file paths, commands, error strings or numbers.',
  '- Preserve exact file paths, commands, error strings, identifiers and numbers.',
  '- Drop redundant tool output and intermediate chatter entirely.',
  '- Do NOT mention this summarization request or that content was compressed.',
  '- Output only the digest text; do not call any tool.',
].join('\n')

/**
 * 把轮跨度渲染成摘要输入：保留用户诉求与工具轨迹，逐轮截断正文。
 *
 * @param spans - 待压缩的轮跨度。
 * @param perTurnChars - 每段（用户/助手）最多保留的字符数。
 * @returns 供摘要模型阅读的正文。
 */
export function renderTurnsForSummary(spans: readonly TurnSpan[], perTurnChars = 4000): string {
  const parts: string[] = []
  for (const span of spans) {
    const tools = span.toolNames.length > 0 ? `\n  tools: ${span.toolNames.join(', ')}` : ''
    const user = span.userText.join('\n').slice(0, perTurnChars)
    const assistant = span.assistantText.join('\n').slice(0, perTurnChars)
    parts.push(
      `### turn ${span.turn}${tools}\n`
      + `[user]\n${user || '(none)'}\n`
      + `[assistant]\n${assistant || '(none)'}`,
    )
  }
  return parts.join('\n\n')
}

/**
 * 确定性抽取摘要（0 额外 LLM 调用）。
 *
 * 保留：每轮的用户诉求首行、出现过的工具、助手输出的首句结论。
 * 丢弃：工具正文、重复表述。这是"选择性遗忘"的最低成本实现。
 *
 * @param spans - 待压缩的轮跨度。
 * @returns 摘要正文。
 */
export function extractiveDigest(spans: readonly TurnSpan[]): string {
  const tools = new Set<string>()
  const asks: string[] = []
  const findings: string[] = []
  for (const span of spans) {
    for (const tool of span.toolNames) tools.add(tool)
    const ask = span.userText.join(' ').trim()
    if (ask.length > 0) asks.push(`- turn ${span.turn}: ${ask.split(/\r?\n/)[0]?.slice(0, 160) ?? ''}`)
    const said = span.assistantText.join(' ').trim()
    if (said.length > 0) findings.push(`- turn ${span.turn}: ${said.split(/(?<=[。.!?！？])\s*/)[0]?.slice(0, 160) ?? ''}`)
  }
  return [
    '## 任务主线',
    asks.length > 0 ? asks.join('\n') : '- (none)',
    '',
    '## 已完成的子任务',
    findings.length > 0 ? findings.slice(-12).join('\n') : '- (none)',
    '',
    '## 关键决策与依据',
    `- 涉及的工具：${tools.size > 0 ? [...tools].join(', ') : '(none)'}`,
    '',
    '## 未决问题',
    '- (none)',
  ].join('\n')
}

/**
 * 解析摘要调用应使用的 provider/model：优先取会话最近一次真实路由，
 * 退到 agent 自身选项。
 *
 * @param agent - pre-step 载荷里的 agent（未信任值）。
 * @returns provider/model；两者都无法解析时为 undefined。
 */
export function resolveTarget(agent: unknown): { provider: string; model: string } | undefined {
  const a = agent as {
    session?: { requestHeader?: () => { config?: { provider?: unknown; model?: unknown } } | undefined }
    options?: { provider?: unknown; model?: unknown }
  } | null
  const routed = a?.session?.requestHeader?.()?.config
  if (typeof routed?.provider === 'string' && routed.provider.length > 0
    && typeof routed.model === 'string' && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  if (typeof a?.options?.provider === 'string' && a.options.provider.length > 0
    && typeof a.options.model === 'string' && a.options.model.length > 0) {
    return { provider: a.options.provider, model: a.options.model }
  }
  return undefined
}

/**
 * 渲染 L2 注入块。
 *
 * @param digest - 当前摘要；null 表示尚未产生摘要。
 * @param pendingTurns - 已溢出 L1 但还没被摘要覆盖的轮数。
 * @returns 注入文本。
 */
export function renderShortTermMemory(digest: DigestResult | null, pendingTurns: number): string {
  if (digest === null) {
    return '## L2 短期记忆（Short-term Memory）\n'
      + `- 尚无摘要；已有 ${pendingTurns} 轮溢出 L1，等待下一次摘要。`
  }
  const ratio = digest.sourceTokens <= 0
    ? 'n/a'
    : `${Math.max(1, Math.round((digest.sourceTokens / Math.max(1, digest.tokens)) * 10) / 10)}x`
  return '## L2 短期记忆（Short-term Memory）\n'
    + `- 覆盖 turn ${digest.turnFrom}–${digest.turnTo}（生成方式 ${digest.via}，压缩比约 ${ratio}）。\n`
    + `- 待摘要的溢出轮：${pendingTurns}。\n\n`
    + digest.text
}

/** 估算一段摘要输入的 token 数（供 {@link DigestResult.sourceTokens} 使用）。 */
export function sourceTokensOf(excerpt: string): number {
  return estimateTokens(excerpt)
}
