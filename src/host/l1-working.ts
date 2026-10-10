/**
 * l1-working.ts — 第一层：工作记忆（Working Memory）。
 *
 * 内容：最近 N 轮对话的完整原文，以及当前任务的主线内容。
 * 策略：不做任何压缩，始终以完整形式留在 surface 里；本模块只负责
 *       *投影*（哪些轮属于 L1、边界在哪、有多少 token），不修改会话。
 *
 * 本模块是纯函数：只读会话事件的叶子字段，不触碰 live 对象，不调用任何
 * service。因此可以脱离运行时单测（见 test/layers.test.mjs）。
 *
 * @module dsh-tri-layer-memory/l1-working
 */

/** 会话事件的最小可读投影（只取叶子字段，不持有 live 对象）。 */
export interface EventLike {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
}

/** 一轮对话在日志中的位置与体量。 */
export interface TurnSpan {
  /** 轮号（`turn/start` 事件携带的 turn）。 */
  turn: number
  /** `turn/start` 的 seq。 */
  startSeq: number
  /** `turn/end` 的 seq；轮仍开着时是当前最后一个 seq。 */
  endSeq: number
  /** 属于本轮的模型可见消息 seq（user/assistant/tool）。 */
  messageSeqs: number[]
  /** 用户输入原文（用于关键词与摘要输入）。 */
  userText: string[]
  /** 助手输出原文。 */
  assistantText: string[]
  /** 本轮出现过的工具名。 */
  toolNames: string[]
  /** 本轮正文总字符数（显示与剪枝评分用）。 */
  charCount: number
  /**
   * 本轮正文的 token 估算（对**真实文本**调 {@link estimateTokens}）。
   *
   * 曾经这里只有 `charCount`，而用量处写成 `estimateTokens(String(charCount))`
   * ——把字符数这个**数字**先转成字符串再估 token，得到的是"这个数字有几个字符"
   * 而不是"正文有多少 token"。实测一条 52 万字符的窗口被报成 `约 2 tokens`，
   * 偏差好几个数量级。token 必须从文本算，不能从计数算。
   */
  tokens: number
  /** 轮是否仍在进行。 */
  open: boolean
}

/** L1 投影结果。 */
export interface WorkingWindow {
  /** 会话里可识别的总轮数。 */
  totalTurns: number
  /** 保留在 L1 的轮（旧 → 新）。 */
  hot: TurnSpan[]
  /** L1 窗口的第一条 seq；无内容时为 null。 */
  hotStartSeq: number | null
  /** L1 窗口之前最后一条 seq（即 L2 区间的右边界）；无更早内容时为 null。 */
  boundarySeq: number | null
  /** 已溢出 L1、应进入 L2 的轮（旧 → 新）。 */
  evicted: TurnSpan[]
  /** L1 正文总字符数。 */
  charCount: number
  /** L1 正文的 token 估算（由各轮 `tokens` 累加，见 {@link TurnSpan.tokens}）。 */
  tokens: number
  /** 溢出部分正文总字符数。 */
  evictedCharCount: number
}

/** 估算文本 token 数：CJK 按 1 token/字，其余按 4 字符/token。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字、扩展 A、兼容表意、假名、谚文、全角标点。
    if (
      (code >= 0x2e80 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xff00 && code <= 0xffef)
    ) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 从任意事件数据里安全取出一个字符串叶子字段。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 取出一条消息事件的正文块。
 *
 * **DSH 的会话日志里消息正文有两个位置**，读错一个就会静默丢掉整类事件：
 * - `user/message`        → `data.content`
 * - `assistant/message`   → `data.message.content`
 * - `tool/result`         → `data.message.content`
 *
 * 历史上这里只读 `data.content`，导致助手正文与工具结果**全部读空**：
 * `memory_state` 的 L1 占用被低估约 75 倍，更严重的是 L2 摘要退化成
 * "只拿用户说的话做摘要"，助手的结论与工具输出一概不进摘要。
 *
 * @param data - 事件对象的 `data` 字段。
 * @returns 正文块（未信任值，交给 {@link contentToText} 归一）。
 */
export function messageBody(data: Record<string, unknown>): unknown {
  if (data.content !== undefined) return data.content
  const message = data.message
  if (typeof message === 'object' && message !== null) {
    return (message as Record<string, unknown>).content
  }
  return undefined
}

/**
 * 把一条消息事件的内容块压成纯文本。
 *
 * 只识别 `{type:'text', text}` 形态；图片、工具调用等非文本块折叠成占位符，
 * 保证摘要输入不丢"这里发生过什么"的信息，又不复制大块 base64。
 *
 * @param content - `event.data.content` 之类的未信任值。
 * @returns 纯文本（可能为空串）。
 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    const text = str(b.text)
    if (b.type === 'text' && text !== undefined) {
      parts.push(text)
      continue
    }
    if (b.type === 'image') parts.push('[image]')
    else if (b.type === 'tool-call' || b.type === 'tool_use') {
      const nm = str(b.name) ?? 'unknown'
      parts.push(`[tool-call ${nm}]`)
    }
  }
  return parts.join('\n')
}

/** 读出事件的 turn 号（`turn/start` / `turn/end` 携带）。 */
function turnOf(event: EventLike): number | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const turn = (data as Record<string, unknown>).turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
}

/**
 * 把会话事件流投影成轮跨度列表。
 *
 * 容错策略：没有 `turn/start` 的前导事件（例如会话恢复、系统注入）归入一个
 * 虚拟的 turn `-1`，这样它们仍可被 L2 摘要覆盖，而不是静默消失。
 *
 * @param events - 会话事件数组（`session.events`）。
 * @returns 按时间顺序的轮跨度（旧 → 新）。
 */
export function projectTurns(events: readonly EventLike[]): TurnSpan[] {
  const spans: TurnSpan[] = []
  let current: TurnSpan | null = null

  const openSpan = (turn: number, seq: number): TurnSpan => {
    const span: TurnSpan = {
      turn,
      startSeq: seq,
      endSeq: seq,
      messageSeqs: [],
      userText: [],
      assistantText: [],
      toolNames: [],
      charCount: 0,
      tokens: 0,
      open: true,
    }
    spans.push(span)
    return span
  }

  // 工具调用名登记表：tool/call 带 name，tool/result 只带 toolCallId，
  // 要按 callId 回查才能拿到工具名。
  const callNames = new Map<string, string>()

  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : 0
    const type = str(event.type) ?? ''
    if (type === 'turn/start') {
      if (current !== null) current.open = false
      current = openSpan(turnOf(event) ?? spans.length, seq)
      continue
    }
    if (current === null) current = openSpan(-1, seq)
    current.endSeq = seq

    if (type === 'turn/end') {
      current.open = false
      continue
    }
    const data = (typeof event.data === 'object' && event.data !== null
      ? event.data
      : {}) as Record<string, unknown>

    if (type === 'tool/call') {
      const callId = str(data.callId)
      const callName = str(data.name)
      if (callId !== undefined && callName !== undefined) callNames.set(callId, callName)
      continue
    }

    if (type === 'user/message') {
      const text = contentToText(messageBody(data))
      current.messageSeqs.push(seq)
      if (text.length > 0) current.userText.push(text)
      current.charCount += text.length
      current.tokens += estimateTokens(text)
      continue
    }
    if (type === 'assistant/message') {
      const text = contentToText(messageBody(data))
      current.messageSeqs.push(seq)
      if (text.length > 0) current.assistantText.push(text)
      current.charCount += text.length
      current.tokens += estimateTokens(text)
      continue
    }
    if (type === 'tool/result') {
      const text = contentToText(messageBody(data))
      const message = (typeof data.message === 'object' && data.message !== null
        ? data.message
        : {}) as Record<string, unknown>
      const callId = str(message.toolCallId) ?? str(data.toolCallId)
      const name = (callId === undefined ? undefined : callNames.get(callId))
        ?? str(message.name) ?? str(data.name) ?? str(data.toolName)
      current.messageSeqs.push(seq)
      if (name !== undefined && !current.toolNames.includes(name)) current.toolNames.push(name)
      current.charCount += text.length
      current.tokens += estimateTokens(text)
    }
  }
  if (current !== null) current.open = false
  return spans
}

/**
 * 计算 L1 工作记忆窗口。
 *
 * 保留策略：最近 `retainTurns` 轮（含正在进行的轮）进入 L1；更早的轮进入
 * `evicted`，交给 L2。压缩引擎的 recency guard 应 ≥ `retainTurns`，这样
 * L1 原文不会被任何自动压缩遮蔽——这是"选择性遗忘"的第一道闸门。
 *
 * @param events - 会话事件数组。
 * @param retainTurns - L1 保留轮数。
 * @returns L1 投影。
 */
export function projectWorkingWindow(
  events: readonly EventLike[],
  retainTurns: number,
): WorkingWindow {
  const spans = projectTurns(events)
  const keep = Math.max(1, Math.trunc(retainTurns))
  const splitAt = Math.max(0, spans.length - keep)
  const evicted = spans.slice(0, splitAt)
  const hot = spans.slice(splitAt)
  const firstHot = hot[0]
  const lastEvicted = evicted[evicted.length - 1]

  let hotChars = 0
  let hotTokens = 0
  for (const span of hot) { hotChars += span.charCount; hotTokens += span.tokens }
  let evictedChars = 0
  for (const span of evicted) evictedChars += span.charCount

  return {
    totalTurns: spans.length,
    hot,
    hotStartSeq: firstHot === undefined ? null : firstHot.startSeq,
    boundarySeq: lastEvicted === undefined ? null : lastEvicted.endSeq,
    evicted,
    charCount: hotChars,
    tokens: hotTokens,
    evictedCharCount: evictedChars,
  }
}

/**
 * 渲染 L1 注入块。
 *
 * `marker` 形态刻意保持极短：L1 的原文本来就在 surface 里，重复注入一遍既
 * 浪费 token 又可能让模型误以为有两份。这里只声明"窗口边界 + 保护状态"，
 * 让模型知道哪一段是可信原文。
 *
 * @param window - L1 投影。
 * @param mode - 注入形态。
 * @returns 注入文本；`off` 时返回 null。
 */
export function renderWorkingMemory(window: WorkingWindow, mode: 'marker' | 'full' | 'off'): string | null {
  if (mode === 'off' || window.hot.length === 0) return null
  const from = window.hot[0]?.turn ?? 0
  const to = window.hot[window.hot.length - 1]?.turn ?? from
  const head = `## L1 工作记忆（Working Memory）\n`
    + `- 保留窗口：最近 ${window.hot.length} 轮（turn ${from}–${to}），共 ${window.totalTurns} 轮。\n`
    + `- 该窗口内的对话原文即上方内容，未做任何压缩；较早的 ${window.evicted.length} 轮已进入 L2/L3。\n`
    + `- 估算占用：约 ${window.tokens} tokens（启发式，非计量器数值）。`
  if (mode === 'marker') return head
  const body = window.hot
    .map((span) => `- turn ${span.turn}: ${span.userText.join(' / ').slice(0, 240) || '(无用户文本)'}`)
    .join('\n')
  return `${head}\n\n### 窗口内用户诉求\n${body}`
}
