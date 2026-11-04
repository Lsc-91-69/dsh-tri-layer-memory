/**
 * l2-short.ts — 第二层：短期记忆（Short-term Memory）的模型侧。
 *
 * 内容：不太紧急的对话内容——较早的工具调用结果、已完成的子任务记录、
 *      历史中间步骤。
 * 策略：用 LLM 生成简明摘要，保留关键结论和决策依据，丢弃冗余细节；
 *      `extractive` 模式用确定性抽取代替模型调用（0 额外请求）。
 * 注入：每轮请求自动注入摘要，占用少量 token。
 *
 * 摘要调用走 `ctx.llm.stream()` 这一官方 seam（与
 * @deepseek-ai/dsh-compaction-basic 的 summarizer 同源），因此换模型/换网关时
 * 无需改动本插件。纯渲染与抽取逻辑在 `l2-render.ts`（可免构建单测）。
 *
 * @module dsh-tri-layer-memory/l2-short
 */
import { PLUGIN_SOURCE_KIND, TextAssembler, createUserMessage } from './platform.ts'
import type { TurnSpan } from './l1-working.ts'
import {
  DIGEST_INSTRUCTION,
  extractiveDigest,
  renderTurnsForSummary,
  resolveTarget,
  sourceTokensOf,
  trimAtBoundary,
} from './l2-render.ts'
import type { DigestAttempt, DigestFailure, DigestResult } from './l2-render.ts'

export * from './l2-render.ts'

/** 摘要调用需要的 LLM seam（只用到 stream 一个方法）。 */
export interface LlmSeam {
  stream: (options: Record<string, unknown>) => AsyncIterable<unknown>
}

/** 一次流调用的原始结果（未做任何"要不要丢"的判断）。 */
export interface CallRun {
  /** 装配出的正文（**丢弃前**的原文）。 */
  text: string
  /** 终止原因实际值；流没给 finish 时为 `none`。 */
  finishKind: string
  failureMessage?: string
  failureCode?: string
  usage?: unknown
  /**
   * **最终那次**调用实际带的档位；`inherit` = 没带该字段。
   *
   * 与 {@link effortRetry} 一起读：`effortRetry` 为真时最终那次是没带字段的，
   * 这个值仍是当初**想要**的那一档——"想要什么"与"最终发出什么"必须能分开，
   * 否则诊断里看不出重试发生过。
   */
  effort: string
  /** 是否因该 effort 不被支持而**去掉该字段重试过一次**。 */
  effortRetry: boolean
  /** 重试前的原始失败消息（只有 `effortRetry` 为真时才有）。 */
  firstFailure?: string
}

/**
 * 请求里该带什么档位：`inherit` 与缺省都表示"不带该字段"。
 *
 * 两条内部调用路（L2 摘要 / cause 回填）共用这一个判定，不各自实现——
 * "两条路各写一遍"正是 cause 回填漏掉档位的成因。
 */
export function effortOf(configured: string | undefined): string | undefined {
  return configured === undefined || configured === 'inherit' ? undefined : configured
}

/** 跑一次流，把 chunk 装配成文本 + 终止原因 + 用量。 */
async function runStream(llm: LlmSeam, request: Record<string, unknown>): Promise<CallRun> {
  const assembler = new TextAssembler()
  for await (const chunk of llm.stream(request)) assembler.push(chunk)
  // 局部断言出 `code`：宿主把适配器抛错归一成 `{kind, failure:{message, code}}`
  // （dsh-llm 的 adapterFailureChunk），而本插件内联的 TextAssembler 只声明了
  // message。`code` 是判断"effort 不被支持"的权威依据，因此这里就地取用，
  // 不改平台垫片（它逐字对齐官方实现，改动面越小越好）。
  const finish = assembler.finish as
    | { kind?: string; failure?: { message?: string; code?: string } }
    | undefined
  const run: CallRun = {
    text: assembler.textContent(),
    finishKind: finish?.kind ?? 'none',
    effort: 'inherit',
    effortRetry: false,
  }
  if (finish?.failure?.message !== undefined) run.failureMessage = finish.failure.message
  if (finish?.failure?.code !== undefined) run.failureCode = finish.failure.code
  const usage = assembler.reportedUsage
  if (usage !== undefined) run.usage = usage
  return run
}

/**
 * 该失败是不是"这个模型不支持我指定的 reasoningEffort"。
 *
 * 宿主在两个层面都会这么拒绝：服务层（`resolveCallWithInfo` 拿模型能力表校验）与
 * 适配器层（`resolveReasoningLevel`）。两层都会带 `UNSUPPORTED_REASONING_EFFORT`
 * 这个 code，但消息文案不同——所以 code 优先、文案兜底。
 */
function isUnsupportedEffort(run: CallRun): boolean {
  if (run.failureCode === 'UNSUPPORTED_REASONING_EFFORT') return true
  return /does not support reasoning effort/i.test(run.failureMessage ?? '')
}

/**
 * 带档位跑一次流；**明确被拒时去掉字段重试一次**。
 *
 * 这是两条内部调用路（L2 摘要、cause 回填）**共用**的那一段。抽出来不是为了少写几行，
 * 而是因为"各写一遍"已经造成过一次真实故障：cause 回填那条路是自己实现的，于是它
 * **没有带档位**——同一条 seam、同一个模型，摘要那条路通了，cause 那条路在 4096 上限下
 * 拿到 0 字符正文、整批因果静默失效。共用之后，"档位"与"被拒退路"只可能同时生效或
 * 同时失效，不会再出现一条通一条不通。
 *
 * 只在**明确被拒**时重试（code 优先、文案兜底），代价可控：别的模型（非推理模型、
 * 只认 `off` 的模型）不该因为这条默认值而永久失去这次内部调用。
 *
 * @param llm - `ctx.llm` seam。
 * @param buildRequest - 用给定档位构造请求（`undefined` = 不带该字段）。
 * @param effort - 配置里的档位；`inherit`/缺省 = 不带。
 * @returns 最后一次的流结果，附实际档位与"是否重试过"。
 */
export async function callWithEffortRetry(
  llm: LlmSeam,
  buildRequest: (effort: string | undefined) => Record<string, unknown>,
  effort: string | undefined,
): Promise<CallRun> {
  const requested = effortOf(effort)
  let run = await runStream(llm, buildRequest(requested))
  run.effort = requested ?? 'inherit'
  if (requested !== undefined && run.finishKind === 'error' && isUnsupportedEffort(run)) {
    const firstFailure = run.failureMessage ?? `reasoningEffort "${requested}" was rejected`
    run = await runStream(llm, buildRequest(undefined))
    run.effort = requested
    run.effortRetry = true
    run.firstFailure = firstFailure
  }
  return run
}

/** 一次摘要调用的结果。 */
export type SummarizeOutcome =
  | { kind: 'ok'; text: string; attempt: DigestAttempt }
  /** 撞了输出上限但**正文可用**：正文已按行/句边界裁过，仍按 llm 摘要使用。 */
  | { kind: 'truncated'; text: string; attempt: DigestAttempt }
  /** 真的没有可用正文（流错误/取消/空文本）——只有这一种才该退回抽取式。 */
  | { kind: 'failed'; message: string; attempt: DigestAttempt }

/**
 * 滚动摘要的额外规则（只在输入里带了上一份摘要时追加）。
 *
 * **为什么要单独写一段而不是改 `DIGEST_INSTRUCTION`**：那段指令是"压缩眼前这段原文"
 * 的语义，而这个规则是"把旧摘要并进新摘要、别丢历史结论"。两者是不同任务；混写会
 * 让没有上一份摘要的首次摘要也被要求"保留历史"，模型只能编。追加是显式的，也便于
 * 测量脚本区分两种调用。
 *
 * 这条规则是本次 Bug 1 修复的**信息不丢**保证：输入里给了旧摘要，但模型完全可以
 * 只总结新增轮次、把旧结论整段丢掉——那会让覆盖区间看起来是 24 轮、实际仍是 3 轮
 * 的信息量。规则必须直接禁止这种"只总结新的"。
 */
const ROLLING_DIGEST_RULES = [
  '',
  '- A PREVIOUS digest is included above. It covers earlier turns that are NO LONGER in the excerpt.',
  '- Produce ONE merged digest for the whole window: keep every still-valid goal, decision, file path, constraint, error string and open question from the previous digest, and fold in the new turns.',
  '- Never drop an older item merely because it is old; drop it only when it is explicitly superseded or no longer relevant.',
].join('\n')

/**
 * 把"上一份摘要 + 本轮新增轮原文"渲染成摘要输入。
 *
 * **为什么不是每次都把 24 轮原文全量重算**（实测数字见 .tmp-fix/sim-l2-window.mjs）：
 * 同一份冻结快照、同样 37 次刷新，全量重算输入合计 1,434,845 tok、均值 38,780 tok/次；
 * 滚动方案均值 6,740 tok/次（1.25x 于旧的"只喂增量"），而覆盖区间同样是 24 轮。
 * 全量是 7.2 倍成本，换来的只是"窗口内原文重新读一遍"——旧摘要已经承载了窗口外
 * 更早轮次的信息，而窗口内原文在上一轮刷新时刚被读过。
 *
 * **为什么必须带上一份摘要**：只喂新增轮会让模型只看见 3 轮，输出自然只剩 3 轮
 * （这正是修复前的塌缩机制）。带上旧摘要后，模型面对的是"24 轮窗口的延续"：
 * 输入里既有旧区间（88–111）的结论，也有新增区间（112–114）的原文。
 *
 * @param spans - 本轮新增的轮跨度（缺口时是全窗口）。
 * @param previousText - 上一份摘要正文；`undefined` = 首次摘要，输入只有原文。
 * @returns 供摘要模型阅读的正文。
 */
export function renderDigestInput(spans: readonly TurnSpan[], previousText: string | undefined): string {
  const fresh = renderTurnsForSummary(spans)
  if (previousText === undefined || previousText.trim().length === 0) return fresh
  return [
    '## 上一份摘要（覆盖更早的轮次；其中仍然有效的结论必须保留）',
    previousText.trim(),
    '',
    '## 新增轮次原文',
    fresh,
  ].join('\n')
}

/**
 * 把上一份摘要与本次抽取结果**按节合并**（确定性回退时也不能丢历史）。
 *
 * 为什么需要：`buildDigest` 的抽取式回退是"模型不可用"时的唯一产物，而抽取式
 * 只看本次传入的轮次。如果回退时直接用 `extractiveDigest(spans)` 覆盖旧摘要，
 * 那么一次模型故障就会让 L2 从 24 轮退回 3 轮——**修复了 LLM 路径却留下一条
 * 同样塌缩的回退路径**，属于"看起来在工作、实际没工作"的典型。
 *
 * 合并规则：
 * - 按 `## 标题` 分节，旧摘要的节顺序与条目优先保留；
 * - 新条目去重后追加到同名节；新出现的节追加在末尾；
 * - 每节最多保留最后 24 条（`extractiveDigest` 本身也只保留 12 条结论），
 *   避免旧摘要 + 新抽取无限膨胀；
 * - 某节没有任何条目时写 `- (none)`，保持与 `extractiveDigest` 同形。
 *
 * @param previous - 上一份摘要正文。
 * @param fresh - 本次抽取结果正文。
 * @returns 合并后的摘要正文。
 */
export function mergeExtractiveDigest(previous: string, fresh: string): string {
  const parse = (text: string): Map<string, string[]> => {
    const sections = new Map<string, string[]>()
    let current = ''
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd()
      const header = /^##\s+(.+?)\s*$/.exec(line)
      if (header !== null) {
        current = header[1] ?? ''
        if (!sections.has(current)) sections.set(current, [])
        continue
      }
      if (current.length === 0) continue
      const body = line.trim()
      if (body.length === 0 || body === '- (none)') continue
      sections.get(current)?.push(body)
    }
    return sections
  }
  const merged = new Map<string, string[]>()
  for (const [title, lines] of parse(previous)) merged.set(title, [...lines])
  for (const [title, lines] of parse(fresh)) {
    const target = merged.get(title)
    if (target === undefined) {
      merged.set(title, [...lines])
      continue
    }
    const seen = new Set(target)
    for (const line of lines) {
      if (seen.has(line)) continue
      target.push(line)
      seen.add(line)
    }
  }
  const out: string[] = []
  for (const [title, lines] of merged) {
    out.push(`## ${title}`)
    out.push(...(lines.length > 0 ? lines.slice(-24) : ['- (none)']))
    out.push('')
  }
  return out.join('\n').trimEnd()
}

/**
 * 用 LLM 生成一段短期记忆摘要。
 *
 * **撞到输出上限时不再丢弃正文**（这是本函数的核心纪律）。旧行为是
 * `finish.kind === 'max-tokens'` 直接抛错 → 整份摘要被丢掉 → 退回机械抽取。
 * 那个选择的代价被真实会话量过：LLM 摘要压缩比约 28x、读起来像任务简报；
 * 抽取式 85x、只是把原话拼起来。**一份被截断的 LLM 摘要信息量远大于抽取式**，
 * 而"因为不完美所以全丢"是最差的选择。宿主自己的 `BlockAssembler` 也是这么做的
 * （max-tokens 时保留 text/reasoning 块，只丢弃无法安全执行的工具调用），
 * 所以"截断仍可用"本来就是平台约定。
 *
 * 于是判定顺序变成：先取正文，再决定——
 * 1. 撞上限 + 正文非空 → 按行/句边界裁到最后一个完整单元，按 `truncated` 返回；
 * 2. 撞上限 + 正文为空（推理吃光了预算）→ 才算失败，退回抽取式；
 * 3. 正常收尾 + 正文非空 → `ok`；
 * 4. 流以 error/aborted 收尾，或正文为空 → `failed`。
 *
 * 另外：请求会带一个**有界的 reasoningEffort**（默认 `low`，可配 `inherit` 关掉）。
 * 理由是实测的——宿主 profile 里 `deepseek-v4.1-flash` 这类模型的推理 token 与正文
 * **共享同一个输出上限**（pi-ai 把推理折进 `outputTokens`），而它的能力表里
 * `off` 映射为 null（**根本无法关掉推理**，只有 low/high/max 可选）。不指定时
 * 走网关默认（很贵，实测 4096 上限下正文 0 字符）。指定后推理被压到低档，
 * 正文才有预算。若某个模型连该档位都不支持，**去掉字段重试一次**（共用
 * {@link callWithEffortRetry}），绝不因此让 L2 永远退回抽取式。
 *
 * @param llm - `ctx.llm` seam。
 * @param target - provider/model。
 * @param excerpt - {@link renderTurnsForSummary} 的输出。
 * @param options - 生成上限、会话 id、取消信号、reasoningEffort。
 * @returns 摘要结果（成功 / 截断可用 / 失败），三种都带本次调用的读数。
 */
export async function summarizeWithLlm(
  llm: LlmSeam,
  target: { provider: string; model: string },
  excerpt: string,
  options: {
    maxTokens: number
    sessionId: string
    signal?: AbortSignal
    reasoningEffort?: string
    /** 覆盖默认的摘要指令（滚动摘要要追加"保留历史要点"的规则）。 */
    instruction?: string
  },
): Promise<SummarizeOutcome> {
  const instruction = options.instruction ?? DIGEST_INSTRUCTION
  const buildRequest = (effort: string | undefined): Record<string, unknown> => ({
    provider: target.provider,
    model: target.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: `${excerpt}\n\n---\n\n${instruction}` }],
        source: { kind: PLUGIN_SOURCE_KIND },
      }),
    ],
    maxTokens: options.maxTokens,
    sessionId: options.sessionId,
    purpose: 'compaction',
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  const run = await callWithEffortRetry(llm, buildRequest, options.reasoningEffort)

  const attempt: DigestAttempt = {
    finish: run.finishKind,
    maxTokens: options.maxTokens,
    inputChars: excerpt.length,
    inputTokens: sourceTokensOf(excerpt),
    outputChars: run.text.length,
    ...(run.usage === undefined ? {} : { usage: run.usage }),
    salvaged: false,
    droppedChars: 0,
    boundary: 'none',
    reasoningEffort: run.effort,
    effortRetry: run.effortRetry,
    ...(run.firstFailure === undefined ? {} : { firstFailure: run.firstFailure }),
  }

  if (run.finishKind === 'error' || run.finishKind === 'aborted') {
    return { kind: 'failed', message: run.failureMessage ?? 'summarization stream failed', attempt }
  }

  if (run.finishKind === 'max-tokens') {
    const trimmed = trimAtBoundary(run.text)
    if (trimmed.text.length === 0) {
      // 正文为空 = 推理把整个输出预算吃光了（真实观测：同一条 seam 上 cause 回填
      // 在 4096 上限下拿到 0 字符）。此时没有任何可用内容，退回抽取式是对的。
      return {
        kind: 'failed',
        message: `summarization truncated at the token cap with no text (${run.text.length} chars)`,
        attempt,
      }
    }
    attempt.salvaged = true
    attempt.droppedChars = trimmed.droppedChars
    attempt.boundary = trimmed.boundary
    return { kind: 'truncated', text: trimmed.text, attempt }
  }

  if (run.text.length === 0) {
    return { kind: 'failed', message: 'summarization produced no text digest content', attempt }
  }
  return { kind: 'ok', text: run.text, attempt }
}

/**
 * 生成 L2 摘要：LLM 优先，失败或未配置 provider 时退回确定性抽取。
 *
 * 退回是有意的：摘要失败绝不能让整轮对话失败，而且抽取结果虽然更粗，
 * 仍然保留了"哪些轮发生了什么"的骨架。
 *
 * **但回退原因必须带出去**（`DigestResult.fallback`）。这个函数曾经用一个
 * 静默的 `catch {}` 把失败原因全部吃掉，于是"模型不可用"与"路由解析不到"与
 * "调用真的抛错"在观察面上长得一模一样——只剩一个 `via: 'extractive'`。
 * 真实会话里 L2 长期是抽取式，排查时无从下手，就是因为这一行。
 *
 * @param llm - `ctx.llm` seam，缺失时直接走抽取。
 * @param spans - 本轮**喂给模型**的轮跨度（新增轮；缺口时是完整窗口）。
 * @param options - 模式、上限、会话 id、信号、agent（解析 provider/model）、reasoningEffort，
 *   以及滚动摘要需要的 `previousText` / `windowFrom` / `windowTo`。
 * @returns 摘要结果（含出处、回退原因、本次调用读数与压缩率输入）；模式为 off 或无内容时为 null。
 */
export async function buildDigest(
  llm: LlmSeam | undefined,
  spans: readonly TurnSpan[],
  options: {
    mode: 'llm' | 'extractive' | 'off'
    maxTokens: number
    sessionId: string
    agent: unknown
    signal?: AbortSignal
    /** 摘要调用带的推理档位；`inherit`/缺省 = 不带该字段。 */
    reasoningEffort?: string
    /**
     * 上一份摘要正文（滚动摘要用）。
     *
     * 有它时：输入 = 上一份摘要 + 本批原文，指令追加"保留历史要点"的规则，
     * 抽取式回退也按节合并而不是覆盖。这是"覆盖区间 24 轮"与"信息不丢"
     * 同时成立的必要条件——只喂新增轮，模型只会总结新增轮。
     */
    previousText?: string
    /**
     * 输出区间（`DigestResult.turnFrom/turnTo`）。缺省用 `spans` 首尾。
     *
     * 为什么要能单独指定：滚动摘要喂的是**新增轮**，但摘要声明覆盖的是整个
     * L2 窗口（最近 `l2RetainTurns` 轮）。两者不一致时（修复前的塌缩正是
     * "声明区间 = 输入区间"造成的），注入读数会随刷新次数缩到 3 轮。
     */
    windowFrom?: number
    windowTo?: number
  },
): Promise<DigestResult | null> {
  if (options.mode === 'off' || spans.length === 0) return null
  const previousText = options.previousText === undefined || options.previousText.trim().length === 0
    ? undefined
    : options.previousText.trim()
  const excerpt = renderDigestInput(spans, previousText)
  const first = spans[0]
  const last = spans[spans.length - 1]
  const base = {
    turnFrom: options.windowFrom ?? first?.turn ?? 0,
    turnTo: options.windowTo ?? last?.turn ?? 0,
    sourceTokens: sourceTokensOf(excerpt),
    createdAt: Date.now(),
  }
  // 配置为 extractive 时本来就不该调模型：这不是失败，不带 fallback。
  if (options.mode !== 'llm') {
    const fresh = extractiveDigest(spans)
    const text = previousText === undefined ? fresh : mergeExtractiveDigest(previousText, fresh)
    return { ...base, text, via: 'extractive', tokens: sourceTokensOf(text) }
  }

  const failure = (stage: DigestFailure['stage'], message: string, attempt?: DigestAttempt): DigestResult => {
    // 回退时同样合并旧摘要：模型故障不能让 L2 从 24 轮退回 3 轮。
    const fresh = extractiveDigest(spans)
    const text = previousText === undefined ? fresh : mergeExtractiveDigest(previousText, fresh)
    return {
      ...base,
      text,
      via: 'extractive',
      tokens: sourceTokensOf(text),
      fallback: { stage, message },
      ...(attempt === undefined ? {} : { attempt }),
    }
  }

  if (llm === undefined) {
    // seam 缺席是最常见的一种：服务真的没装，或者获取路径（ctx.get / ctx.inject）
    // 在这个上下文里没命中。两者症状相同，所以消息里必须写清"拿不到"而不是"调用失败"。
    return failure('llm-missing', 'llm seam unavailable: neither ctx.inject([\'llm\']) nor ctx.get(\'llm\') yielded a service in this context')
  }

  // resolveTarget 会调用宿主对象上的 requestHeader()：它抛错时异常会从这里逃出去，
  // 而那会让整条 L2 路径连回退都走不到。解析失败必须与"解析不出来"同等对待。
  let target: { provider: string; model: string } | undefined
  try {
    target = resolveTarget(options.agent)
  } catch (error: unknown) {
    return failure('target-missing', `provider/model resolution threw: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (target === undefined) {
    return failure('target-missing', 'no provider/model resolvable from agent.session.requestHeader().config or agent.options')
  }

  try {
    const outcome = await summarizeWithLlm(llm, target, excerpt, {
      maxTokens: options.maxTokens,
      sessionId: options.sessionId,
      // 有上一份摘要时追加"合并历史"的规则：否则模型完全可能只总结新增的 3 轮，
      // 让"输入里带了旧摘要"变成摆设（覆盖区间对、信息量不对）。
      instruction: previousText === undefined
        ? DIGEST_INSTRUCTION
        : `${DIGEST_INSTRUCTION}${ROLLING_DIGEST_RULES}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    })
    if (outcome.kind === 'failed') {
      // 只有"真的没有可用正文"才走到这里。`attempt` 一起带出去：观察面上
      // "正文 0 字符"与"流报错"必须能分辨，否则又会退回"猜根因"。
      return failure('llm-error', outcome.message, outcome.attempt)
    }
    // ok 与 truncated 都算 llm 摘要：被截断的正文按边界裁过，仍在用。
    // `attempt.salvaged` 是"这份摘要被截过"的唯一出口（区别于完全失败）。
    return {
      ...base,
      text: outcome.text,
      via: 'llm',
      tokens: sourceTokensOf(outcome.text),
      target,
      attempt: outcome.attempt,
    }
  } catch (error: unknown) {
    // 捕获错误**对象**而不是 `catch {}`：这条消息是排查的唯一线索。
    // 走到这里的只剩"流本身抛了"（runStream 未把异常归一成 finish 的情况）。
    return failure('llm-error', error instanceof Error ? error.message : String(error))
  }
}
