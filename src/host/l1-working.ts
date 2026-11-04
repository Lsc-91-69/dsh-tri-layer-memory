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

/**
 * 本插件注入消息的**完整头部行**。
 *
 * 识别投影块只认这一行（外加块内结构特征），不看长度、也不做模糊匹配：投影长度
 * 实测在 2.7k–12k tokens 之间浮动，任何按长度判断的规则都会同时漏判和误判。
 */
export const PROJECTION_HEADER = '# 三层记忆 · 本轮投影'

/**
 * 本插件注入消息在会话日志里的来源标签（`source.kind`）。
 *
 * 与 `platform.ts` 的 `PLUGIN_SOURCE_KIND` 是同一个值：那一处用于给**请求**打标签，
 * 这一处用于**识别回放**。放在本模块是因为 `projectTurns` 是纯函数，不该为了一个
 * 字符串去依赖带宿主类型的模块（否则 layers 测试要先装一堆东西）。
 */
export const PROJECTION_SOURCE_KIND = 'dsh-tri-layer-memory'

/**
 * 投影块必然包含的层标题。
 *
 * 用它们做**结构**判据，而不是只看头部行：用户完全可能把一份投影贴回来问"这是
 * 什么东西"，那样的消息也可能以头部行开头。要求同时出现至少两个层标题，能把
 * "贴了一行标题"与"贴了整份投影"分开。
 *
 * 注意不能要求四个标题全在：预算仲裁会整块丢弃 L3 索引（实测本会话 209 条投影里
 * 有 10 条没有 L3 块、3 条没有 L1 块），要求全在就会漏掉那些投影。
 */
const PROJECTION_SECTIONS = [
  '## L1 工作记忆',
  '## 里程碑主线骨架',
  '## L2 短期记忆',
  '## L3 深层记忆',
] as const

/**
 * 判断一条事件是不是**本插件自己注入的投影**。
 *
 * 为什么要认它：投影是注入物，不是对话。把它当对话算进 L1 窗口，会同时造成两个
 * 被实测证实的后果——窗口里三分之二是自己历次投影（本会话最近 8 轮 84,087 /
 * 127,101 tokens），以及 L2 每次摘要都要先重读一遍自己的历史输出（实测单次输入
 * 145,322 字符，其中 47,031 是投影）。
 *
 * 判据分两层，**先强后弱**：
 * 1. `source.kind` 在场时以它为准。用户粘贴同样的文本也是 `user/message`，但粘贴
 *    不出 `source.kind = dsh-tri-layer-memory` —— 这一层是"不会误伤"的保证。
 * 2. `source` 缺席（更早的日志、降级形态）时退回形状判据：完整头部行 + 至少两个
 *    层标题。此时理论上仍有伪造可能，但代价只是"用户贴进来的投影不被当对话"。
 *
 * @param event - 会话事件。
 * @returns `true` = 本插件注入的投影。
 */
export function isProjectionEvent(event: EventLike): boolean {
  if (event.type !== 'user/message') return false
  const data = (typeof event.data === 'object' && event.data !== null
    ? event.data
    : {}) as Record<string, unknown>
  const text = contentToText(messageBody(data))
  // 必要条件一：完整头部行是正文第一行（`trimStart` 只容忍宿主可能加的缩进，
  // 不做任何"包含即算"的放宽）。
  if (!text.trimStart().startsWith(PROJECTION_HEADER)) return false
  // 必要条件二：来源。有来源就以来源为准（强判据）。
  const source = data.source
  if (typeof source === 'object' && source !== null) {
    const kind = (source as Record<string, unknown>).kind
    if (typeof kind === 'string') return kind === PROJECTION_SOURCE_KIND
  }
  // 没有来源才看结构（弱判据）。
  let sections = 0
  for (const header of PROJECTION_SECTIONS) if (text.includes(header)) sections += 1
  return sections >= 2
}

/**
 * 一条工具结果的原文命中（供 L3 工具记录蒸馏用）。
 *
 * **为什么不放进 {@link TurnSpan}**：L1 的 `charCount` / `tokens` 是"这个窗口里有多少
 * 真实对话"的口径，工具正文已经算在里面了；如果把正文再挂到 span 上，任何按 span
 * 量体积的地方都会重复计一次。这里用回调把正文**递给收集者**，span 本身保持原样。
 */
export interface ToolResultHit {
  /** 事件 seq，用于回指原日志。 */
  seq: number
  /** 所属轮号。 */
  turn: number
  /** 工具名（`tool/call` 的 name，按 callId 回查）。 */
  name: string
  /** 正文（已由 {@link contentToText} 归一）。 */
  text: string
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
   *
   * **不含本插件自己注入的投影**（见 {@link isProjectionEvent}）：这里量的是
   * "这个窗口里有多少真实对话"，投影是插件塞进去的东西，算进来就成了自报数。
   */
  tokens: number
  /** 本轮被排除的本插件投影条数（仍是该轮的事件，只是不参与任何计数）。 */
  projections: number
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
  /**
   * L1 窗口内**真实对话的轮数**。
   *
   * 与 `hot.length` 不同：排除投影后，一轮可能只剩投影而没有对话（工具调用之间的
   * 空轮）。窗口的目标是"最近 N 轮真实对话"，所以补足时数的是这个字段。
   */
  dialogueTurns: number
  /** L1 窗口内被排除的本插件投影条数（不计入 {@link WorkingWindow.tokens}）。 */
  projections: number
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
 * @param onToolResult - 可选：每条 `tool/result` 的正文回调。**默认不调用**，因此
 *   普通投影（L1/L2/骨架）的开销与行为完全不变；只有 L3 工具蒸馏会传它。
 * @returns 按时间顺序的轮跨度（旧 → 新）。
 */
export function projectTurns(
  events: readonly EventLike[],
  onToolResult?: (hit: ToolResultHit) => void,
): TurnSpan[] {
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
      projections: 0,
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
    // 本插件自己的投影是**注入物，不是对话**：它仍属于这一轮（`endSeq` 已记下），
    // 但不进 `messageSeqs` / `charCount` / `tokens`，也不进 `userText`——后者是 L2
    // 摘要的输入，把历次投影喂回去等于让摘要重读自己的输出。实测本会话 209 条投影
    // 共 533,760 tokens 是这么被重复计入的。
    if (isProjectionEvent(event)) {
      current.projections += 1
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
      // 正文已经算过了，顺手递出去不增加第二次切词/估算；不传回调时这行只是
      // 一个 undefined 判断，普通投影的路径没有任何变化。
      if (onToolResult !== undefined && text.length > 0) {
        onToolResult({ seq, turn: current.turn, name: name ?? 'unknown', text })
      }
    }
  }
  if (current !== null) current.open = false
  return spans
}

/**
 * 收集指定轮的工具结果正文。
 *
 * 复用 {@link projectTurns} 的**同一套**轮归属与工具名回查逻辑：`tool/result` 只带
 * callId、工具名要从 `tool/call` 回查，这套规则一旦复制出第二份，下次修归属就会
 * 只修一处——那正是"看起来在工作"的经典形态。
 *
 * @param events - 会话事件数组。
 * @param wantTurn - 只回传这些轮的结果（其余轮的正文不复制，长会话里这是主要开销）。
 * @returns 命中的工具结果（旧 → 新）。
 */
export function collectToolResults(
  events: readonly EventLike[],
  wantTurn: (turn: number) => boolean,
): ToolResultHit[] {
  const out: ToolResultHit[] = []
  projectTurns(events, (hit) => {
    if (wantTurn(hit.turn)) out.push(hit)
  })
  return out
}

/**
 * `projectWorkingWindow` 的可选输入：描述"本轮"在事件数组里还看不见的部分。
 *
 * **为什么需要它（又一条"看起来在工作、实际没工作"的静默故障）**：
 * `agent/pre-step` 跑的时候，本轮用户消息**还没被 append 进 `session.events`**——
 * 日志顺序是 `turn/start` → `step/start` →（pre-step 在这里跑）→ `user/message`。
 * 也就是说，pre-step 的投影看到的本轮只有 `turn/start`、没有正文，看起来是个空轮。
 * 补足循环为了凑满 `keep` 个"有正文的轮"，就会多往前拉一个 turn：
 * 实测真实会话 turn 98–112 共 11 个轮次，每个轮的首条投影写成
 * `窗口内 9 个 turn（turn 90–98）`，而同一轮第二条（用户消息已落地）自我修正成
 * `8 个 turn（turn 91–98）`。**首条才是注入给模型的那条**，所以每轮开头模型的
 * L1 边界都是错的：多装一个本应溢出的旧轮、少报一个真实轮数。
 *
 * 传了它，补足循环与 `dialogueTurns` 都按"这一轮是真实对话"计，不再为它多拉一轮。
 * 不传时行为与旧版完全一致（读数、补算、折叠路径都走这条旧路）。
 */
export interface WorkingWindowOptions {
  /**
   * 当前轮号：调用方（pre-step）**已确认这一轮有用户输入**。
   *
   * 只有 `charCount === 0` 的该轮会被当作"有对话"；已有正文的轮不受影响。
   * 调用方必须只在真的拿到本轮输入时才传——传错等于凭空多算一个真实轮。
   */
  pendingTurn?: number | null
  /**
   * 当前轮已经可见、但事件数组里还没有的正文（pre-step 载荷里的本轮用户输入）。
   *
   * 用途有两个：确认 {@link pendingTurn} 那一轮确实有对话（空串不生效），以及把它的
   * 体积计入 `charCount` / `tokens`。不补的话，修复后的窗口会比修复前少报一整轮正文，
   * 读数上看起来像"为了修计数把真对话丢了"——那正是这次要避免的错误方向。
   *
   * 它只在该轮 `charCount === 0` 时才会被采用：如果事件里已经有正文（后一个 step、
   * 或日志落盘后重放），以事件为准，绝不重复计数。
   */
  pendingText?: string | null
}

/**
 * 从 `agent/pre-step` 载荷里取"本轮已经存在、但还没落进事件数组"的用户输入。
 *
 * **为什么必须从载荷取而不是从 `session.events` 取**：pre-step 的调用顺序是
 * `turn/start` → `step/start` →（本钩子）→ `user/message`。也就是说，本轮用户消息
 * 在钩子跑完之后才被 append，`projectWorkingWindow` 看到的本轮是一个空轮。旧代码
 * 因此为它多往前拉一个 turn，把窗口行写成"9 个 turn / turn 90–98"；同一轮第二条
 * 投影（消息已落地）又修正成"8 个 turn / turn 91–98"。**首条才是注入给模型看的**，
 * 所以每轮开头模型拿到的 L1 边界都是错的。实测受影响 11 个 turn（98–104、108、
 * 109、111、112）。
 *
 * `payload.messages` 是宿主本轮 claim 到的输入（`agent/pre-step` 载荷字段，见
 * agent-loop 的 `preStep`：`{ messages: claimed, ...{ turn, step }, signal }`），
 * 它正是随后会被写成 `user/message` 的那批消息，所以能在这里补上。
 *
 * **只认 `role === 'user'`**，并排除本插件自己注入的投影：投影是注入物，不是对话；
 * 把它算进当前轮会让"最近 N 轮真实对话"自报数——那正是 `projectTurns` 花力气
 * 排除投影的原因，不能在补丁里又漏回来。
 *
 * @param payload - `agent/pre-step` 的载荷（未信任值，逐字段做类型判断）。
 * @returns 窗口选项；载荷里没有本轮轮号或没有用户输入时为 `null`（保持旧行为）。
 */
export function pendingWindowInput(payload: unknown): WorkingWindowOptions | null {
  const turn = (payload as { turn?: unknown } | null)?.turn
  // 轮号必须可信：传一个错的轮号会让"当前轮"匹配到别的 span，等于凭空多算一轮。
  if (typeof turn !== 'number' || !Number.isFinite(turn)) return null
  const messages = (payload as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return null
  const parts: string[] = []
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue
    const message = raw as Record<string, unknown>
    if (message.role !== 'user') continue
    const text = contentToText(messageBody(message))
    if (text.length === 0) continue
    // 投影排除与 `isProjectionEvent` 同一套判据（强判据 source.kind 优先，弱判据
    // 退回"头部行 + 至少两个层标题"）。消息对象没有 `type` 字段，所以这里按
    // message 的形状单独判断，不直接把消息塞进 isProjectionEvent。
    if (isProjectionText(text, message.source)) continue
    parts.push(text)
  }
  // 没有用户输入就不传：一个真的没有对话的轮次（例如纯工具步）不该被当成真实轮。
  if (parts.length === 0) return null
  return { pendingTurn: turn, pendingText: parts.join('\n') }
}

/** {@link pendingWindowInput} 用的投影判据（与 {@link isProjectionEvent} 同源）。 */
function isProjectionText(text: string, source: unknown): boolean {
  if (!text.trimStart().startsWith(PROJECTION_HEADER)) return false
  if (typeof source === 'object' && source !== null) {
    const kind = (source as Record<string, unknown>).kind
    if (typeof kind === 'string') return kind === PROJECTION_SOURCE_KIND
  }
  let sections = 0
  for (const header of PROJECTION_SECTIONS) if (text.includes(header)) sections += 1
  return sections >= 2
}

/**
 * 计算 L1 工作记忆窗口。
 *
 * 保留策略：最近 `retainTurns` 轮**真实对话**进入 L1；更早的轮进入 `evicted`，
 * 交给 L2。压缩引擎的 recency guard 应 ≥ `retainTurns`，这样 L1 原文不会被任何
 * 自动压缩遮蔽——这是"选择性遗忘"的第一道闸门。
 *
 * 为什么按"真实对话轮数"而不是"turn 边界"计数：排除本插件自己的投影之后，一轮
 * 可能只剩投影、没有对话（工具调用之间的空轮）。按 turn 边界切，窗口里会混进
 * 这种空轮、少装真对话；所以从新往旧凑满 `retainTurns` 个有正文的轮为止。
 * 代价是 `hot` 可能多于 `retainTurns` 个 turn——这是刻意的，见 {@link dialogueTurns}。
 *
 * @param events - 会话事件数组。
 * @param retainTurns - L1 保留的真实对话轮数。
 * @param options - 可选：本轮尚未落进事件数组的状态，见 {@link WorkingWindowOptions}。
 * @returns L1 投影。
 */
export function projectWorkingWindow(
  events: readonly EventLike[],
  retainTurns: number,
  options?: WorkingWindowOptions,
): WorkingWindow {
  const spans = projectTurns(events)
  const keep = Math.max(1, Math.trunc(retainTurns))

  const pendingTurn = typeof options?.pendingTurn === 'number' && Number.isFinite(options.pendingTurn)
    ? options.pendingTurn
    : null
  const pendingText = typeof options?.pendingText === 'string' ? options.pendingText : ''
  // 当前轮在事件数组里还是空轮，但调用方确认它有用户输入：把正文补进这一轮的
  // span（只补 `charCount === 0` 的轮，事件已有正文时以事件为准，不重复计数）。
  // 补进 span 而不是只补汇总，是为了让 `hot` 自身保持自洽——L2/关键字/全量渲染
  // 都按 span 读，汇总与明细对不上就是下一次"读数不一致"故障。
  if (pendingTurn !== null && pendingText.length > 0) {
    const index = spans.findIndex((span) => span.turn === pendingTurn && span.charCount === 0)
    if (index >= 0) {
      spans[index] = {
        ...spans[index],
        userText: [pendingText],
        charCount: pendingText.length,
        tokens: estimateTokens(pendingText),
      }
    }
  }

  // "这一轮算不算真实对话"：有正文，或它就是调用方确认过的当前轮（正文可能还在
  // pre-step 载荷里、尚未落进事件数组）。
  const isPending = (span: TurnSpan): boolean =>
    pendingTurn !== null && span.turn === pendingTurn && span.charCount === 0
  const hasDialogue = (span: TurnSpan): boolean => span.charCount > 0 || isPending(span)
  // 补足：从默认切点开始数"有真对话的轮"，不够 keep 就继续往前扩展，直到凑满或到头。
  let splitAt = Math.max(0, spans.length - keep)
  let filled = 0
  for (let i = splitAt; i < spans.length; i += 1) if (hasDialogue(spans[i])) filled += 1
  while (filled < keep && splitAt > 0) {
    splitAt -= 1
    if (hasDialogue(spans[splitAt])) filled += 1
  }
  const evicted = spans.slice(0, splitAt)
  const hot = spans.slice(splitAt)
  const firstHot = hot[0]
  const lastEvicted = evicted[evicted.length - 1]

  let hotChars = 0
  let hotTokens = 0
  let hotProjections = 0
  let hotDialogue = 0
  for (const span of hot) {
    hotChars += span.charCount
    hotTokens += span.tokens
    hotProjections += span.projections
    if (hasDialogue(span)) hotDialogue += 1
  }
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
    dialogueTurns: hotDialogue,
    projections: hotProjections,
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
  // 措辞按**排除后的事实**写：
  // - 轮数报"真实对话轮数"（不是 turn 边界数），否则读者会以为窗口里装的是 8 个 turn；
  //   只有两者不相等（排除投影后出现了空轮）时才补一句括号说明——常见情况下窗口
  //   本来就等于保留轮数，多写那十几个 token 只是往预算里塞噪音；
  // - 投影条数单独报一行。旧文案只说"该窗口内的对话原文即上方内容"，而上方其实
  //   还混着本插件历次投影（实测占 59%）——那句话当时是半假的，现在由这行说清
  //   到底排除了多少条，读者不必猜。
  const spanNote = window.hot.length === window.dialogueTurns
    ? ''
    : `（窗口内 ${window.hot.length} 个 turn）`
  // 只留一行，而且只报"可核对的事实"：窗口边界、真实对话轮数、总轮数。
  //
  // 实测被砍掉的三行（共约 88 tokens/轮）为什么是零信息：
  // 1. "该窗口内的对话原文即上方内容，未做任何压缩"——块标题已经叫「工作记忆」，
  //    第一行也已经说"最近 N 轮真实对话"；再说一遍只是同义反复。
  // 2. "本插件自己历次注入的投影 N 条已排除，不计入下列占用"——N 是每一刻都在变的
  //    计数，模型无法据此做任何事；"不计入下列占用"在第三行被删后更是无所指。
  // 3. "估算占用：约 N tokens（启发式，非计量器数值）"——N 既不是预算也不是限额，
  //    却长得像限额。真实使用中它至少误导过两次（被当成上下文预算）。删。
  //
  // 保留下来的这一行仍是"可核对"的：turn 区间来自窗口自身，总轮数来自事件流，
  // 读者可以据此判断"窗口边界在哪、上面哪一段是可信原文"。
  const head = `## L1 工作记忆（Working Memory）\n`
    + `- 保留窗口：最近 ${window.dialogueTurns} 轮真实对话${spanNote}`
    + `（turn ${from}–${to}），共 ${window.totalTurns} 轮。`
  if (mode === 'marker') return head
  const body = window.hot
    .map((span) => `- turn ${span.turn}: ${span.userText.join(' / ').slice(0, 240) || '(无用户文本)'}`)
    .join('\n')
  return `${head}\n\n### 窗口内用户诉求\n${body}`
}
