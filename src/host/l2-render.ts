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

// ───────────────────────────────────────────────────────────────────────
// 分层抽取（L3 `turn` 记录专用；**不进注入**）
// ───────────────────────────────────────────────────────────────────────
//
// 为什么需要第二条路径而不是把 {@link extractiveDigest} 直接改强：
// `extractiveDigest` 同时是 **L2 注入正文**的回退产物（`buildDigest` 的
// `extractive` 分支）。把它的预算放大，等于让每轮注入跟着膨胀——而 turn 记录
// 只进 L3 库、按需 recall，两边的成本完全不同，必须分开定价。
//
// 另外，旧实现的 160 字上限**对所有内容一视同仁**：它按"第一个换行"取首行，
// 于是 user 侧的第一行常常是运行时注入块（`Time sampled…` / `<system-reminder>`
// 里的 skill 目录 / 裸 session id），160 字配额被样板吃光，真正的诉求与约束
// 一个字都没留下。实测 turn 89 的 57,470 字符 user 文本里 56,311 是 skill 目录、
// 815 是运行时上下文、78 是裸 session id——只按"首行"取，取到的是噪声。
//
// 所以分层抽取的第一道工序是**剥注入块**，第二道才是分类与预算。

/**
 * 单条分层记录正文的**硬上限**（字符）。
 *
 * 为什么是 3000：一条 turn 记录只进 L3、可 recall，不进注入，成本是磁盘与
 * 剪枝频率。3000 字符 ≈ 2400 tokens，对应"一次完整排查（16k tokens）"的
 * 约 15%——足以装下该轮全部约束、排除、报错与推断链，又不会让 L3 池翻十倍。
 * 超出的部分按类型优先级丢弃，并且**丢弃要可见**（见 {@link layeredDigest} 的
 * `dropped` 计数，测量脚本会读它）。
 */
export const LAYERED_DIGEST_MAX_CHARS = 3000

/**
 * 信息类型。顺序即**分类优先级**（一条片段只归一类）。
 *
 * `verified` 单独留一类只为一件事：让测量能如实报"验证结论的保留率"。
 * 它不占分层预算（价值密度低于约束/排除/失败/推断），只作为"结论行"的候选。
 */
export type FragmentKind = 'failure' | 'constraint' | 'excluded' | 'chain' | 'param' | 'verified' | 'other'

/** 从本轮原文切出的一个片段及其分类结果。 */
export interface DigestFragment {
  /** 轮号。 */
  turn: number
  /** 来自用户还是助手（测量要分侧看）。 */
  source: 'user' | 'assistant'
  /** 原句原文（未截断；截断在渲染时按预算做）。 */
  text: string
  /** 分类结果。 */
  kind: FragmentKind
  /** 命中的具体判据（自检与假阳性抽样用，不写进记录）。 */
  why: string
}

/** 分层模式下的预算与体积读数。 */
export interface LayeredDigestStats {
  /** 记录正文的字符数。 */
  chars: number
  /** 记录正文的估算 token 数。 */
  tokens: number
  /** 各类装进去的片段数与丢弃数（`dropped` = 候选里没装下的条数）。 */
  kept: Record<FragmentKind, number>
  dropped: Record<FragmentKind, number>
  /** 被剥掉的注入块数与被剥字符数（"原文里有多少是样板"的证据）。 */
  strippedBlocks: number
  strippedChars: number
}

/**
 * 注入块的**段首行**特征。命中即整段丢弃。
 *
 * 为什么按"段"而不是按行：这些块内部没有稳定结束标记（`<system-reminder>`
 * 除外），逐行剥离会在块中间漏掉几行，把 skill 目录的风格提示（"必须…"）
 * 当成用户约束。整段丢弃是唯一不漏的做法。
 *
 * 为什么不剥 `Agent xxx sent a message:` / `Background subagent xxx finished`：
 * 那是**子代理交回的真实报告**（turn 83 的 6,166 字符、turn 85 的 6,523 字符），
 * 是这些轮次里信息密度最高的部分。剥掉它等于只记"我派了个代理"。
 */
const INJECTED_BLOCK_HEAD: readonly { re: RegExp; label: string }[] = [
  { re: /^<system-reminder>/i, label: 'system-reminder' },
  { re: /^Current runtime context\./i, label: 'runtime-context' },
  { re: /^Time sampled while preparing/i, label: 'time-sample' },
  { re: /^Elapsed since the preceding/i, label: 'elapsed' },
  { re: /^Browser time zone for this request/i, label: 'browser-tz' },
  // 宿主的压缩检查点摘要：它是**上一份摘要**，不是本轮对话。留着会把"过去
  // 已经被压过的内容"再算成本轮原文，保留率因此虚高（turn 81 有 15,583 字符）。
  { re: /^This is an automatically generated checkpoint/i, label: 'checkpoint' },
  { re: /^<compacted-summary>/i, label: 'checkpoint' },
]

/**
 * 这块内容的**行级**兜底特征。
 *
 * 为什么在"整条消息判定"之外还要一层行级过滤：宿主有时把运行时信息追加在一条
 * 真实消息的末尾，整条丢弃会连用户写的要求一起丢掉。行级过滤只删那些以固定
 * 前缀开头的行——它们的共同点是**没有对话价值**（时间戳、时区、工作目录策略）。
 */
const INJECTED_LINE = /^(?:Time sampled while preparing|Browser time zone for this request|Elapsed since the preceding|Current runtime context\.|Current working directory:|Current DSH file policy:|Current DeepSeek Harness|Approval prompts are disabled|Delegation depth for|You are a coding agent|You are interacting with the user|You are a delegated subagent|You are the Team Lead|Tokens prefixed with @|Non-zero exits are reported|Anonymous telemetry)/i

/** 裸 session id / 裸 UUID 行：是参数，不是诉求。 */
const NAKED_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 约束类的硬情态词。
 *
 * 为什么不用宽泛的 `/必须|不能/`：实测里这两个词的高频假阳性来自代码注释与
 * 引用（"契约测试正是禁止随附这些包"是**别人的测试在约束**，不是本项目的约束），
 * 以及安抚语（"不要担心"）。前者无法靠词面区分（如实承认），后者可以——
 * 见 {@link CONSTRAINT_SOOTHE}。
 */
const CONSTRAINT_HARD = /必须|绝不能|绝不|严禁|禁止|只能|只允许|只接受|只支持|除非|前提是|不得|务必|不许|切勿|不准|永远不要|不可以|不要|别用|别把|别在|别再/

/** 安抚/劝阻语：`不要` 后面的宾语是情绪而不是行为时，不是约束。 */
const CONSTRAINT_SOOTHE = /不要(担心|怕|急|慌|紧)|不用(担心|怕|急)|不必(担心|怕|急)|别急|不要紧|不至于|不要客气|不用担心/

/** 双重否定：语义是"只能"，但词面看起来像否定约束，容易误读成限制。 */
const DOUBLE_NEGATION = /不能不说|不得不|不可能不|不会不|不禁/

/** 疑问句：`必须现在做吗？` 是提问，不是要求。 */
const QUESTION_TAIL = /(吗|呢|么)\s*[？?]?\s*$/

/** 排除类的强判据：决策动词，几乎只在"否掉某个方案"的语境出现。 */
const EXCLUDED_STRONG = /否掉|否决|不采用|不可行|行不通|试过不行|试了不行|放弃掉|放弃了|弃用|作废|推翻|排除掉|回滚|不做了|不走这条路|另选|替代方案/

/** 排除类的弱判据：`改为/改成` 本身是执行动作，必须配合决策语境才算排除。 */
const EXCLUDED_WEAK = /改为|改成|换成|替换为|不再用|不用这个/

/** 决策语境词：弱判据的护航条件。 */
const DECISION_CONTEXT = /方案|计划|本来|原来|原计划|问题|因为|否则|不行|不兼容|而非|试过|否|放弃|回滚/

/** 失败类的**形状**判据：这些几乎不会在正常叙述里出现。 */
// 注意 `E[A-Z]{3,}` 这类"看起来像 errno"的宽写法**不能用**：它会把 `EXACT`、
// `EVENT`、`EXTRA` 这些正常缩写一起吞进失败类（实测抽检里 8 条有 3 条是这种）。
// 只列举真实 errno 名字，代价是漏掉罕见码，换来的是这一类判据可以单独信任。
const FAILURE_SHAPE = /\[失败\]|^\s*FAIL\b|\b(?:Type|Reference|Syntax|Range|URI|Eval)Error\b|\b\w*Error\s*[:：]|\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EEXIST|EISDIR|ENOTDIR|ENOSPC|EAGAIN|ENOMEM)\b|\bERR_[A-Z_]+\b|exit code[:：\s]*\d+|Traceback \(most recent call last\)|^\s+at\s+\S+:\d+:\d+|\b\d+\s*(?:tests?|checks?|assertions?)\s+failed\b/

/** 失败类的中文判据：必须带动作主语，避免"失败率"这种名词短语。 */
const FAILURE_CN = /(测试|断言|构建|编译|命令|进程|脚本|部署|写入|安装|启动)\S{0,10}(失败|报错|抛错|挂了)|失败[:：]|报错[:：]/

/** 推断链：要求**成对**因果（只出现"因为"或只出现"说明"不算）。 */
const CHAIN_PAIR = /因为[\s\S]{0,160}?所以|由于[\s\S]{0,160}?(因此|所以|导致)|所以[\s\S]{0,60}?是因为|之所以[\s\S]{0,80}?是因为/

/** 推断链：显式根因/依据标记。 */
const CHAIN_ROOT = /根因是|根本原因是|依据是|证据是|由此(可见|推断)|据此|这说明|意味着|证明了|推论是|可推断/

/** 参数类的形状判据：只认"有形状"的参数，不认裸数字（否则行号会淹没一切）。 */
const PARAM_SHAPE = /[A-Za-z]:\\[^\s，。；）】]*|\d+\.\d+\.\d+|`[^`]{2,}`|\b\w+\.(?:ts|mjs|js|md|yml|yaml|json|sqlite|tgz|zst|rs|py)\b|--[a-z][a-z-]+|\b[A-Z][A-Z0-9_]{3,}\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]{2,}\b|\b\d+(?:\.\d+)?\s*(?:tokens?|ms|KB|MB|GB|条|轮|次|%)\b/

/** 验证结论的形状判据。 */
const VERIFIED_SHAPE = /实测|验证通过|已通过|复现了?|\b\d+\/\d+\b|\bPASS\b|全绿|确认了|测得|跑通了|通过率/

/** 片段只在**规则明确**时归类，否则落 `other`；这里是类名到记录标记的映射。 */
const KIND_LABEL: Record<FragmentKind, string> = {
  failure: '失败',
  constraint: '约束',
  excluded: '排除',
  chain: '推断',
  param: '参数',
  verified: '验证',
  other: '叙述',
}

/**
 * 分层预算：每类的份额（按可分配预算的比例）与单条上限（字符）。
 *
 * 分配原则（不是"平均分"）：
 * - 约束/排除**单条很短但价值最高**（中位 38 tokens），所以给大份额、小上限；
 * - 失败留**报错本体**（`Error: …` 那一行），上限略宽是因为堆栈首行常较长；
 * - 推断链留**一整条因果链**，上限收紧到 260——超过这个长度的"因为所以"
 *   通常是长篇论证，摘要价值低于它占的位置；
 * - 参数与叙述按剩余预算截断，份额最小。
 *
 * 份额之和为 1；实现上是**上限**而不是预留：某类用不完的预算不会被别的类
 * 抢走（记录短了不是问题，膨胀才是）。
 */
const KIND_BUDGET: readonly { kind: FragmentKind; share: number; perItem: number }[] = [
  { kind: 'constraint', share: 0.36, perItem: 320 },
  { kind: 'excluded', share: 0.18, perItem: 300 },
  { kind: 'failure', share: 0.18, perItem: 400 },
  { kind: 'chain', share: 0.10, perItem: 260 },
  { kind: 'param', share: 0.10, perItem: 200 },
  // 叙述的份额最小，且有**质量门槛**（见装填循环里的 `length < 20`）：这个类里
  // 绝大多数是过程播报，塞进记录只会把约束/报错的位置挤掉。
  { kind: 'other', share: 0.06, perItem: 180 },
]

/** 骨架行（诉求/结论）的单条上限。 */
const SKELETON_MAX_CHARS = 240

/**
 * 按句末标点切一行，**并且不切开 markdown 强调标记**。
 *
 * 规则细则（因为踩过）：
 * - `。**` 后面是空白/行尾 → `**` 是这句的收尾，切点落在 `**` **之后**；
 * - `。**` 后面紧跟文字 → `**` 是下一句的开头，整段不切（保守：宁可合并两句，
 *   也不要把星号粘到错误的句子尾部——第一版把 `**` 一律并回上一片段，结果
 *   `而且我自己的一个假设被数据否掉了。**` 这种串了别的段落收尾标记的句子进了记录）。
 *
 * @param line - 一行文本（已 trim）。
 * @returns 句子片段（保持原文，不补不删字符）。
 */
function splitLineAtSentence(line: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ''
    if (!/[。！？；!?;]/.test(ch)) continue
    let j = i + 1
    while (j < line.length && /[*`_]/.test(line[j] ?? '')) j += 1
    const next = line[j]
    const closesHere = j >= line.length || /\s/.test(next ?? '')
    if (!closesHere) continue
    const piece = line.slice(start, j).trim()
    if (piece.length > 0) out.push(piece)
    start = j
    i = j - 1
  }
  const tail = line.slice(start).trim()
  if (tail.length > 0) out.push(tail)
  return out
}

/**
 * 把一段正文按"行 → 句"切开，代码围栏内的行整体保留。
 *
 * 为什么围栏内不切句：`if (a) { b() }` 这类行按标点切会碎成无意义片段，
 * 而它们往往是"报错复现命令"的一部分，切开就等于丢掉可复现性。
 *
 * @param text - 一段正文（通常是一条 user / assistant 消息）。
 * @returns 片段文本（已 trim，保持原文顺序）。
 */
function splitFragmentText(text: string): string[] {
  const out: string[] = []
  let inFence = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    for (const piece of splitLineAtSentence(line)) {
      // 纯标记行（`**` / `` ` ``）不是内容。
      if (/^[*`_]+$/.test(piece)) continue
      out.push(piece)
    }
  }
  return out
}

/**
 * 把一条片段分类。
 *
 * 优先级：失败 > 约束 > 排除 > 推断 > 验证 > 参数 > 叙述。
 * 失败排最前是因为它的形状判据最可靠（`Error:` / `ENOENT` / 堆栈帧），
 * 一条报错里同时出现"必须"时，报错原文比约束词更该被保留。
 *
 * @param text - 片段原文。
 * @returns 类别与命中依据。
 */
export function classifyFragment(text: string): { kind: FragmentKind; why: string } {
  if (FAILURE_SHAPE.test(text)) return { kind: 'failure', why: 'shape' }
  if (FAILURE_CN.test(text)) return { kind: 'failure', why: 'cn-action' }

  // markdown 标题行要分两种，不能一棍子打成"标题"：
  // - **短标题**（≤24 字符、无句末标点）是导航，不是内容，判 `other`；
  // - **长标题**是"把结论写进了标题行"——实测 turn 88 的关键结论就是
  //   `## 测完了。**结论：…而且我自己的一个假设被数据否掉了。**`，整行被当成
  //   heading 丢掉，排除类因此一条都不剩。剥掉 `#` 前缀后按内容重新分类。
  const heading = /^#{1,6}\s+(.*)$/.exec(text)
  if (heading !== null) {
    const body = (heading[1] ?? '').trim()
    if (body.length <= 24 && !/[。！？；]/.test(body)) return { kind: 'other', why: 'heading' }
    return classifyFragment(body)
  }

  if (CONSTRAINT_SOOTHE.test(text)) return { kind: 'other', why: 'soothe' }
  if (DOUBLE_NEGATION.test(text)) return { kind: 'other', why: 'double-negation' }
  if (CONSTRAINT_HARD.test(text)) {
    if (QUESTION_TAIL.test(text)) return { kind: 'other', why: 'question' }
    return { kind: 'constraint', why: 'modal' }
  }

  if (EXCLUDED_STRONG.test(text) && !/不要放弃|别放弃|不能放弃/.test(text)) {
    return { kind: 'excluded', why: 'decision-verb' }
  }
  if (EXCLUDED_WEAK.test(text) && DECISION_CONTEXT.test(text)) {
    return { kind: 'excluded', why: 'weak+context' }
  }

  if (CHAIN_PAIR.test(text)) return { kind: 'chain', why: 'pair' }
  if (CHAIN_ROOT.test(text)) return { kind: 'chain', why: 'root-marker' }

  if (VERIFIED_SHAPE.test(text)) return { kind: 'verified', why: 'verified' }
  if (PARAM_SHAPE.test(text)) return { kind: 'param', why: 'shape' }
  return { kind: 'other', why: 'fallback' }
}

/**
 * 把**一条消息**切成带分类的片段，并剥掉注入物。
 *
 * 为什么按"消息"而不是按"空行分段"：运行时上下文块**内部**有空行
 * （`Current runtime context.` 后面隔一行才是 `Current working directory:`），
 * 按空行分段会把后半截当成真实内容留下——第一版实现就是这样把
 * `Current working directory: "D:\…"` 装进了参数类的。消息首行命中样板时
 * 整条丢弃，是这个数据集里唯一不漏的判据。
 *
 * @param text - 一条 user / assistant 消息。
 * @param turn - 所属轮号。
 * @param source - 用户还是助手。
 * @param sink - 承载输出与统计的可变对象。
 */
function collectFragments(
  text: string,
  turn: number,
  source: 'user' | 'assistant',
  sink: { fragments: DigestFragment[]; strippedBlocks: number; strippedChars: number },
): void {
  const head = text.trimStart().split(/\r?\n/)[0]?.trim() ?? ''
  if (INJECTED_BLOCK_HEAD.some((entry) => entry.re.test(head))) {
    sink.strippedBlocks += 1
    sink.strippedChars += text.length
    return
  }
  for (const sentence of splitFragmentText(text)) {
    // 行级兜底：真实消息里夹带的样板行（宿主把时间戳追加在末尾）。
    if (INJECTED_LINE.test(sentence)) {
      sink.strippedChars += sentence.length
      continue
    }
    // 占位符不是内容：`[image]` / `[tool-call grep]` 写进记录只会挤掉真句子。
    if (/^\[(?:image|tool-call)\b/i.test(sentence)) continue
    // 5 字符以下基本是噪声（`可以。` / `- B`）；但短约束句必须留（`不要内联`）。
    if (sentence.length < 5 && !CONSTRAINT_HARD.test(sentence)) continue
    const { kind, why } = classifyFragment(sentence)
    sink.fragments.push({ turn, source, text: sentence, kind, why })
  }
}

/**
 * 从一轮里切出全部片段（导出给测量脚本：保留率必须用**生产的同一套判据**，
 * 复制一份到脚本里，下次改判据就会静默地继续测旧逻辑）。
 *
 * @param spans - 轮跨度。
 * @returns 片段列表（保持原文顺序）与剥离统计。
 */
export function digestFragments(spans: readonly TurnSpan[]): {
  fragments: DigestFragment[]
  strippedBlocks: number
  strippedChars: number
} {
  const sink = { fragments: [] as DigestFragment[], strippedBlocks: 0, strippedChars: 0 }
  for (const span of spans) {
    for (const text of span.userText) collectFragments(text, span.turn, 'user', sink)
    for (const text of span.assistantText) collectFragments(text, span.turn, 'assistant', sink)
  }
  // 同一轮里重复出现的句子只留一次：user 引用助手的话、或子代理报告重复贴同一段，
  // 在长排查里很常见，不去重会让预算被同一句话吃光。
  const seen = new Set<string>()
  const fragments: DigestFragment[] = []
  for (const fragment of sink.fragments) {
    const key = `${fragment.turn}\u0000${fragment.text.replace(/\s+/g, ' ').slice(0, 60)}`
    if (seen.has(key)) continue
    seen.add(key)
    fragments.push(fragment)
  }
  return { fragments, strippedBlocks: sink.strippedBlocks, strippedChars: sink.strippedChars }
}

/**
 * 按句边界/逗号边界截断到 `max` 字符以内，并补 `…`。
 *
 * 为什么不硬切：`D:\deepseek\deepseekh_work\plugins\dsh-` 这样的半截路径比
 * 不写更糟（读的人会以为路径就长这样）。切点优先落在句末标点，其次逗号/顿号，
 * 最后才是空格。
 *
 * @param text - 原文。
 * @param max - 上限（含省略号）。
 * @returns 截断后的文本。
 */
function clipFragment(text: string, max: number): string {
  if (text.length <= max) return text
  const room = Math.max(8, max - 1)
  const head = text.slice(0, room)
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf('、'),
    head.lastIndexOf(' '),
  )
  const body = cut >= Math.floor(room / 2) ? head.slice(0, cut) : head
  return `${body.trimEnd()}…`
}

/**
 * 一轮的"诉求行"：第一条**非注入、非裸 id、非图片占位**的用户句子。
 *
 * 回退到助手第一句：turn 89 这种"用户只贴了一个 session id"的轮次，
 * 诉求在用户的字面文本里根本不存在，硬取首行只会记下一个裸 id。
 *
 * @param span - 本轮。
 * @param fragments - 已切好的片段（复用，避免二次切分）。
 * @returns 诉求文本；没有可用内容时为空串。
 */
function mainlineOf(span: TurnSpan, fragments: readonly DigestFragment[]): { text: string; kind: FragmentKind } | undefined {
  // 用户侧优先：诉求是"用户要什么"，助手的句子只是对它的解读。
  for (const text of span.userText) {
    const head = text.trimStart().split(/\r?\n/)[0]?.trim() ?? ''
    if (INJECTED_BLOCK_HEAD.some((entry) => entry.re.test(head))) continue
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      if (INJECTED_LINE.test(line)) continue
      if (/^\[(?:image|tool-call)\b/i.test(line)) continue
      // 裸 id 不是诉求：turn 89 的用户消息第一行就是 `session-97100ff2-…`，
      // 真正的诉求在第二行（"这是另一个回话的session-id…"）。
      if (NAKED_ID.test(line.replace(/[`*_\s]/g, ''))) continue
      return { text: clipFragment(line, SKELETON_MAX_CHARS), kind: classifyFragment(line).kind }
    }
  }
  // 回退：用户消息里没有可用内容（只贴了图片/只贴了 id）时，用助手第一句。
  const picked = fragments.find((f) => f.turn === span.turn && f.source === 'assistant')
  return picked === undefined
    ? undefined
    : { text: clipFragment(picked.text, SKELETON_MAX_CHARS), kind: picked.kind }
}

/**
 * 一轮的"结论行"：助手最后的、长度足够的句子。
 *
 * 为什么取末句而不是首句：首句通常是"我先把 X 读一遍"这种过程播报，真正的结论
 * （或真正要用户决策的问题）在最后。旧实现取首句，实测 turn 88 的记录是
 * `先做一 Time sampled…`——首句里连用户诉求都被样板吃掉了。
 *
 * @param span - 本轮。
 * @param fragments - 已切好的片段。
 * @returns 结论文本；没有时为空串。
 */
function conclusionOf(span: TurnSpan, fragments: readonly DigestFragment[]): { text: string; kind: FragmentKind } | undefined {
  const said = fragments.filter((f) => f.turn === span.turn && f.source === 'assistant')
  // 只挑"陈述型"句子当结论：报错是未决问题、排除/推断是决策依据——它们各有
  // 自己的预算与位置，拿它们充当"已完成的子任务"会让同一句话在两处打架。
  const statement = (f: DigestFragment): boolean => f.kind !== 'failure' && f.kind !== 'excluded' && f.kind !== 'chain'
  for (let i = said.length - 1; i >= 0; i -= 1) {
    const candidate = said[i]
    if (candidate !== undefined && statement(candidate) && candidate.text.length >= 12) {
      return { text: clipFragment(candidate.text, SKELETON_MAX_CHARS), kind: candidate.kind }
    }
  }
  for (const candidate of said) {
    if (statement(candidate)) return { text: clipFragment(candidate.text, SKELETON_MAX_CHARS), kind: candidate.kind }
  }
  return undefined
}

/** 记录正文的四个小节内容（按行；空数组渲染成 `(none)`）。 */
interface DigestSections {
  main: string[]
  done: string[]
  decisions: string[]
  unresolved: string[]
}

/**
 * 把四小节拼成正文。**四小节标题永远都在**——这是格式契约，测试依赖它。
 *
 * @param sections - 四小节的行。
 * @param toolLine - "涉及的工具"行（恒存在，与旧实现一致）。
 * @returns 记录正文。
 */
function renderSections(sections: DigestSections, toolLine: string): string {
  return [
    '## 任务主线',
    sections.main.length > 0 ? sections.main.join('\n') : '- (none)',
    '',
    '## 已完成的子任务',
    sections.done.length > 0 ? sections.done.join('\n') : '- (none)',
    '',
    '## 关键决策与依据',
    [...sections.decisions, toolLine].join('\n'),
    '',
    '## 未决问题',
    sections.unresolved.length > 0 ? sections.unresolved.join('\n') : '- (none)',
  ].join('\n')
}

/** 参与预算分配的类别（`verified` 并入 `other` 的预算，不单独占份额）。 */
type BudgetKind = Exclude<FragmentKind, 'verified'>

/**
 * 兜底裁剪的顺序：先删价值最低的类别，最后才动骨架行。
 *
 * 约束放最后，是因为它是这张表存在的**唯一理由**——如果连约束都要裁，
 * 那这条记录本来就不该占 3000 字符的预算。
 */
const TRIM_ORDER: readonly BudgetKind[] = ['other', 'param', 'chain', 'excluded', 'failure', 'constraint']

/**
 * 兜底裁剪：从**可选行**的尾部往前删，直到总长满足上限。
 *
 * 为什么不直接 `text.slice(0, limit)`：那会把尾部连"未决问题"这个小节标题
 * 一起切掉，记录就从"四小节"变成"三节半"——按标题解析的调用方会静默地
 * 读到一个不存在的节。删整行则永远只损失内容，不损失结构。
 *
 * @param skeleton - 骨架行（诉求/结论；会被就地裁剪）。
 * @param picked - 各类已装入的片段行（会被就地裁剪）。
 * @param toolLine - 工具行。
 * @param limit - 字符上限。
 * @param removed - 记录每类被裁掉的行数（调用方据此修正 kept/dropped）。
 * @returns 满足上限的正文。
 */
function fitSections(
  skeleton: DigestSections,
  picked: Record<BudgetKind, string[]>,
  toolLine: string,
  limit: number,
  removed: Record<FragmentKind, number>,
): string {
  const build = (): DigestSections => ({
    main: [...skeleton.main, ...picked.constraint],
    done: [...skeleton.done, ...picked.param, ...picked.other],
    decisions: [...picked.excluded, ...picked.chain],
    unresolved: [...picked.failure],
  })
  let text = renderSections(build(), toolLine)
  for (const kind of TRIM_ORDER) {
    while (text.length > limit && picked[kind].length > 0) {
      picked[kind].pop()
      removed[kind] += 1
      text = renderSections(build(), toolLine)
    }
    if (text.length <= limit) return text
  }
  const shrinkSkeleton: (keyof DigestSections)[] = ['unresolved', 'done', 'decisions', 'main']
  for (const key of shrinkSkeleton) {
    while (text.length > limit && skeleton[key].length > 0) {
      skeleton[key].pop()
      text = renderSections(build(), toolLine)
    }
    if (text.length <= limit) return text
  }
  // 极端情况：骨架行本身就超上限。此时只留标题与占位符——结构完整、内容为空，
  // 比"半个小节"诚实。
  skeleton.main = []
  skeleton.done = []
  skeleton.decisions = []
  skeleton.unresolved = []
  for (const kind of TRIM_ORDER) {
    removed[kind] += picked[kind].length
    picked[kind].length = 0
  }
  return renderSections(build(), toolLine)
}

/**
 * 分层抽取摘要（L3 `turn` 记录用；**不进注入**）。
 *
 * 与 {@link extractiveDigest} 的输出差异只在**内容**：四小节标题、`(none)`
 * 占位符、"涉及的工具"行全部保留，所以任何按下标/标题解析的调用方不受影响。
 *
 * 实现的四步（每一步都对应一类实测故障）：
 * 1. **剥注入块**——否则 160 字/3000 字都会被 skill 目录吃掉；
 * 2. **切句并分类**——用户诉求、约束、排除、报错、推断链分开对待；
 * 3. **按类型分配预算**——约束/排除优先全留，失败留报错本体，推断留一条完整链，
 *    参数与叙述吃剩余；
 * 4. **总长封顶**——`LAYERED_DIGEST_MAX_CHARS`，超出按类型优先级丢弃（丢弃数
 *    在 {@link LayeredDigestStats} 里可见，不做静默截断）。
 *
 * @param spans - 待压缩轮跨度（turn 记录通常只有一轮）。
 * @param options - `maxChars` 覆盖硬上限（测量/消融用）。
 * @returns 记录正文与体积读数。
 */
export function layeredDigest(
  spans: readonly TurnSpan[],
  options: { maxChars?: number } = {},
): { text: string; stats: LayeredDigestStats } {
  const limit = Math.max(240, options.maxChars ?? LAYERED_DIGEST_MAX_CHARS)
  const { fragments, strippedBlocks, strippedChars } = digestFragments(spans)

  const tools = new Set<string>()
  for (const span of spans) for (const tool of span.toolNames) tools.add(tool)

  // 骨架行先算，它占用的是**必留**预算（一轮至少要能看出"这轮在干什么/结论是什么"）。
  const skeleton: DigestSections = { main: [], done: [], decisions: [], unresolved: [] }
  // 骨架里的句子**保留类型标记**：诉求行本身常常就是一条约束或一条报错
  // （"必须先改 schema"），把标签丢掉等于让"这是约束"这个信息从记录里消失。
  // 同时把纯文本记进 `skeletonTexts`，片段装填时据此去重——否则同一句话会
  // 以"骨架行 + [约束] 行"出现两次，白占 200 字符。
  const skeletonTexts = new Set<string>()
  const skeletonLine = (turn: number, picked: { text: string; kind: FragmentKind }): string => (
    picked.kind === 'other'
      ? `- turn ${turn}: ${picked.text}`
      : `- turn ${turn} [${KIND_LABEL[picked.kind]}] ${picked.text}`
  )
  for (const span of spans.slice(-12)) {
    const main = mainlineOf(span, fragments)
    if (main !== undefined) {
      skeleton.main.push(skeletonLine(span.turn, main))
      skeletonTexts.add(main.text)
    }
    const conclusion = conclusionOf(span, fragments)
    if (conclusion !== undefined) {
      skeleton.done.push(skeletonLine(span.turn, conclusion))
      skeletonTexts.add(conclusion.text)
    }
  }
  const toolLine = `- 涉及的工具：${tools.size > 0 ? [...tools].join(', ') : '(none)'}`

  // 剩余预算 = 上限 − **真实渲染出来**的最小正文（四小节标题 + 骨架行 + 工具行 +
  // 占位符）。不用估算：差 200 字符就会让最后一行被硬切。
  let remaining = Math.max(0, limit - renderSections(skeleton, toolLine).length)

  // 各类的候选。`verified` 归到 `other` 的预算里（价值密度低于约束/排除，不该
  // 单独占份额；但仍要能计入"验证结论的保留率"，所以按片段本体单独记账）。
  const buckets = new Map<FragmentKind, DigestFragment[]>()
  for (const fragment of fragments) {
    const bucket: FragmentKind = fragment.kind === 'verified' ? 'other' : fragment.kind
    const list = buckets.get(bucket)
    if (list === undefined) buckets.set(bucket, [fragment])
    else list.push(fragment)
  }

  const picked: Record<BudgetKind, string[]> = {
    constraint: [], excluded: [], failure: [], chain: [], param: [], other: [],
  }
  const kept: Record<FragmentKind, number> = { failure: 0, constraint: 0, excluded: 0, chain: 0, param: 0, verified: 0, other: 0 }
  const dropped: Record<FragmentKind, number> = { failure: 0, constraint: 0, excluded: 0, chain: 0, param: 0, verified: 0, other: 0 }
  const keptVerified = new Set<DigestFragment>()

  for (const { kind, share, perItem } of KIND_BUDGET) {
    const candidates = buckets.get(kind) ?? []
    const cap = Math.min(Math.floor(remaining * share), remaining)
    const lines = picked[kind]
    let used = 0
    let took = 0
    for (const fragment of candidates) {
      // 叙述类有质量门槛：短句/过程播报不进记录（它们的共同点是"读完不知道发生了什么"）。
      if (fragment.kind === 'other' && fragment.text.length < 20) continue
      // 骨架里已经写过这句（诉求/结论），不再重复占位。
      if (skeletonTexts.has(fragment.text.trim())) continue
      // 裸 id 不是内容：它在参数行里出现时已经有上下文（"…在 L3 里有 47 条记录"）。
      if (NAKED_ID.test(fragment.text.replace(/[`*_\s]/g, ''))) continue
      const room = cap - used
      // 剩余空间装不下一行有意义的片段就不装了（不塞半句）。
      if (room < 48) break
      const line = `- turn ${fragment.turn} [${KIND_LABEL[kind]}] ${clipFragment(fragment.text, Math.min(perItem, room))}`
      if (line.length > room) continue
      lines.push(line)
      used += line.length + 1
      took += 1
      if (fragment.kind === 'verified') keptVerified.add(fragment)
    }
    kept[kind] = took
    dropped[kind] = candidates.length - took
    remaining -= used
  }
  // `other` 桶里混着 verified：按片段本体拆成两类各自的读数。
  kept.verified = keptVerified.size
  kept.other -= kept.verified
  dropped.verified = (buckets.get('other') ?? []).filter((f) => f.kind === 'verified').length - kept.verified
  dropped.other -= dropped.verified

  const trimmed: Record<FragmentKind, number> = { failure: 0, constraint: 0, excluded: 0, chain: 0, param: 0, verified: 0, other: 0 }
  const text = fitSections(skeleton, picked, toolLine, limit, trimmed)
  // 兜底裁剪删掉的片段要回到 `dropped`：统计必须与正文一致，否则"保留数"是假的。
  for (const kind of TRIM_ORDER) {
    kept[kind] -= trimmed[kind]
    dropped[kind] += trimmed[kind]
  }
  return {
    text,
    stats: {
      chars: text.length,
      tokens: estimateTokens(text),
      kept,
      dropped,
      strippedBlocks,
      strippedChars,
    },
  }
}

/**
 * 确定性抽取摘要（0 额外 LLM 调用）。
 *
 * 保留：每轮的用户诉求首行、出现过的工具、助手输出的首句结论。
 * 丢弃：工具正文、重复表述。这是"选择性遗忘"的最低成本实现。
 *
 * **默认（不传 `layered`）的输出与历史版本逐字一致**：它是 L2 注入正文的
 * 回退产物，体积直接进注入成本。分层抽取请用 {@link layeredDigest}（或传
 * `layered: true`），它只给 L3 turn 记录用。
 *
 * @param spans - 待压缩的轮跨度。
 * @param options - `layered: true` 时改走分层抽取（L3 记录路径）。
 * @returns 摘要正文。
 */
export function extractiveDigest(
  spans: readonly TurnSpan[],
  options: { layered?: boolean; maxChars?: number } = {},
): string {
  if (options.layered === true) {
    return layeredDigest(spans, options.maxChars === undefined ? {} : { maxChars: options.maxChars }).text
  }
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
 * 只报模型**能据此行动**的两件事：摘要覆盖了哪一段、还有多少轮没被覆盖。
 * 以下内容被删掉（每轮省约 20 tokens，且不影响任何判断）：
 * - `生成方式 extractive`：读摘要正文就知道它是抽取式还是概括式，标签本身不改变
 *   模型对这1000 字该怎么用的判断；
 * - `压缩比约 1.0x`：这是给人看的效率指标（memory_state 里仍有），不是模型可用的量；
 * - `待摘要的溢出轮：0`：0 是一个恒定的"一切正常"，只有 >0 才意味着有一段内容
 *   不在任何摘要里 —— 那时才值得占一行。
 *
 * @param digest - 当前摘要；null 表示尚未产生摘要。
 * @param pendingTurns - 已溢出 L1 但还没被摘要覆盖的轮数。
 * @returns 注入文本。
 */
export function renderShortTermMemory(digest: DigestResult | null, pendingTurns: number): string {
  if (digest === null) {
    return '## L2 短期记忆（Short-term Memory）\n'
      + (pendingTurns > 0
        ? `- 尚无摘要；已有 ${pendingTurns} 轮溢出 L1，等待下一次摘要。`
        : '- 尚无摘要。')
  }
  const pending = pendingTurns > 0 ? `\n- 待摘要的溢出轮：${pendingTurns}。` : ''
  return '## L2 短期记忆（Short-term Memory）\n'
    + `- 覆盖 turn ${digest.turnFrom}–${digest.turnTo}。${pending}\n\n`
    + digest.text
}

/** 估算一段摘要输入的 token 数（供 {@link DigestResult.sourceTokens} 使用）。 */
export function sourceTokensOf(excerpt: string): number {
  return estimateTokens(excerpt)
}
