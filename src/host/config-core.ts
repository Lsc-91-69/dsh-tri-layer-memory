/**
 * config-core.ts — 三层记忆配置的**无依赖**核心：类型、默认值、归一、路径解析。
 *
 * 刻意与 `config.ts` 分开，只为了一个目的：本模块不 import 任何
 * `@deepseek-ai/*` 包，因此可以被 Node 直接执行（Node 22.18+/23.6+ 的类型剥离），
 * 于是这些纯逻辑能在**不构建、不安装依赖**的前提下单测（见 test/layers.test.mjs）。
 *
 * **为什么所有键都是扁平的顶层标量**：客户端设置卡通过
 * `SettingsScope.set(field, value)` 写入，而该 API 的契约是"namespace 段内的
 * *标量*字段"。嵌套对象既写不进去，也无法用"字段是否出现在 user 层"来判断
 * 某个值是否被用户改过（面板要据此显示"已修改"）。因此这里刻意拍平。
 *
 * @module dsh-tri-layer-memory/config-core
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// 摘录的默认值与上界和渲染器共用同一对常量（见 milestones.ts 的说明）：一个范围只该
// 有一处真源，否则"配置允许 500、渲染器只认 200"这类分叉迟早会发生。它不引入任何
// `@deepseek-ai/*` 依赖，本模块"可被 Node 直接执行"的性质不受影响。
import { CAUSE_EXCERPT_CHARS, CAUSE_EXCERPT_MAX } from './milestones.ts'

/** 设置面板与组合行共用的 namespace。 */
export const MEMORY_NAMESPACE = 'tri-layer-memory' as const

/** L1 注入形态：`marker` 只报窗口边界，`full` 附完整原文，`off` 不注入。 */
export type L1InjectMode = 'marker' | 'full' | 'off'

/** L2 摘要来源：`llm` 走模型，`extractive` 走确定性抽取（0 额外请求）。 */
export type L2Mode = 'llm' | 'extractive' | 'off'

/**
 * **插件发起的内部工具调用**带的推理档位：`inherit` 不带该字段（交给宿主/网关默认），
 * 其余为显式档位。
 *
 * **为什么是"内部调用"而不是"L2 摘要"**：这个档位管的是本插件自己发出去的那几次
 * `ctx.llm.stream`——目前有两条路，L2 摘要（`refreshDigest`）与主线骨架的 cause 回填
 * （`refreshMainlineCauses`）。两条路走**同一条 seam、同一个模型**，因此推理预算的
 * 约束也必须同源。它曾经叫 `l2ReasoningEffort`，而那个名字是**错的**：它让后来加
 * cause 回填的人以为"这是 L2 的东西"，于是 cause 那条路**没有带档位**——同一条 seam
 * 上一条通、另一条静默失效（真实故障：cause 回复 0 字符）。名字必须描述它真正管的
 * 范围，否则下一个加内部调用的人还会漏掉。
 *
 * **为什么需要这个键**：内部调用与主对话共用宿主的路由，而路由的推理档位
 * （真实配置里是 `max`）会让推理 token 吃掉输出预算——宿主 pi-ai 适配器把推理
 * 折进 `outputTokens`，模型的 `max_tokens` 同时约束推理与正文。实测后果是
 * "4096 上限下正文 0 字符"，产物整份不可用。摘要与因果都不需要深思，把档位压到
 * `low` 就够，且能保证正文有预算。
 *
 * 为什么不默认 `off`：这台机器上的 `deepseek-v4.1-flash` 能力表里 `off` 映射为
 * null（**根本无法关掉推理**，只有 low/high/max 可选），传 `off` 会被宿主以
 * `UNSUPPORTED_REASONING_EFFORT` 拒绝。默认 `low` 是"这台机器能用、别的模型多半
 * 也认"的那一档；确实不认的模型由 l2-short.ts 的**去掉字段重试**兜住——那是两条路
 * 共用的同一个函数，不再各写一遍。
 */
export type InternalCallEffort = 'inherit' | 'off' | 'low' | 'high' | 'max'

/** L3 存储后端：`auto` 优先 SQLite（node:sqlite 内置）失败退 JSONL。 */
export type L3Store = 'auto' | 'sqlite' | 'jsonl'

/** 压缩引擎仲裁策略：`auto` 探测在场者，其余值强制校验期望引擎。 */
export type EngineMode = 'auto' | 'argp' | 'instant' | 'headroom' | 'basic' | 'none'

/** recall 工具命名策略：`auto` 在重名被占用时自动改名。 */
export type RecallToolName = 'auto' | 'memory_recall' | 'tri_recall'

/** 三层记忆的可调参数（扁平，全部为顶层标量）。 */
export interface TriLayerConfig {
  // ── L1 工作记忆 ──────────────────────────────────────────────────────
  /** 最近多少轮原文不做任何压缩。 */
  l1RetainTurns: number
  /** 每轮是否注入 L1 投影。 */
  l1Inject: L1InjectMode
  /** 是否把 L1 窗口作为压缩引擎 recency guard 的保护目标。 */
  l1ProtectFromCompaction: boolean

  // ── L2 短期记忆 ──────────────────────────────────────────────────────
  /** L1 溢出后仍在 L2 保留窗口内的轮数；更旧的进 L3。 */
  l2RetainTurns: number
  /** 摘要生成方式。 */
  l2Mode: L2Mode
  /** 单次摘要调用的生成上限。 */
  l2MaxSummaryTokens: number
  /**
   * 插件发起的**所有**内部调用（L2 摘要 + cause 回填）带的推理档位
   * （`inherit` = 不带，交给宿主默认）。
   *
   * 与 {@link l2MaxSummaryTokens} 的分工必须分清：那个是**输出上限**（推理 + 正文
   * 共享的总预算），这个是**推理占多少**。只调前者是在跟推理抢预算——上限调到
   * 4096 仍然截断，就是因为推理没有上限、也没有被压低。
   */
  internalCallReasoningEffort: InternalCallEffort
  /** 是否每轮注入 L2 摘要。 */
  l2Inject: boolean
  /** 少于这么多轮可压缩内容时不调用模型。 */
  l2MinTurnsBeforeSummary: number
  /** 摘要刷新的最小间隔毫秒；0 表示每个合格步都刷新。 */
  l2RefreshIntervalMs: number

  // ── L3 深层记忆 ──────────────────────────────────────────────────────
  /** 是否启用 L3。 */
  l3Enabled: boolean
  /** 存储后端。 */
  l3Store: L3Store
  /** 存储目录；空串表示用 {@link defaultStorageDir} 推导。 */
  l3Dir: string
  /** 是否把超出 L2 窗口的内容与旧摘要蒸馏进 L3。 */
  l3Distill: boolean
  /** 保留记录上限，超出后按剪枝分数淘汰。 */
  l3MaxRecords: number
  /** 确定性剪枝的保留阈值（0-1，越大剪得越狠）。 */
  l3PruneMinScore: number
  /** 是否把 L3 索引（不注入正文）附到每轮请求。 */
  l3InjectIndex: boolean

  // ── 主线骨架 ─────────────────────────────────────────────────────────
  /**
   * 是否从会话事件流提取「里程碑主线骨架」。
   *
   * 关掉后既不提取也不注入：提取是 72ms 量级（11,424 事件实测）的确定性扫描，
   * 不用它的会话不该为它付这份成本。
   */
  mainlineEnabled: boolean
  /** 是否把骨架块注入每轮请求（关掉后仍提取并落 L3，只是不注入）。 */
  mainlineInject: boolean
  /** 骨架条数上限，超出后从最旧的里程碑开始丢（越新越值钱）。 */
  mainlineMaxMilestones: number
  /**
   * 骨架**独立**的 token 上限，与 `injectionBudgetTokens` 互不影响。
   *
   * 主线骨架是"主内容不遗忘"这个承诺的载体：让它去和 L1/L2/L3 抢同一份预算，
   * 等于承诺本身打折（预算一紧，最先被丢的恰恰是最需要长期在场的它）。
   * 所以这里给它一条独立上限，而不是把它塞进 {@link arbitrateInjection} 的候选里。
   */
  mainlineMaxTokens: number
  /**
   * 是否用一次独立的 LLM 调用给里程碑补 `cause`（为什么）。
   *
   * 关掉后每条里程碑只剩确定性标签（`未解决`、`同一诉求连续 2 轮排查未解决`）——
   * 那是"成没成"，不是"为什么"，回退链的因果整段消失。默认开着。
   */
  mainlineCauseEnabled: boolean
  /**
   * 累计多少条里程碑缺 cause 才发一次调用（节流）。
   *
   * 因果是"攒一批一起问"才划算的：一条一发会让每轮都多一次模型往返，
   * 而骨架每次只新增一两条。
   */
  mainlineCauseMinBatch: number
  /** 单次最多补多少条：防止一次把整段骨架塞进同一个请求（发得越长，越容易超时与截断）。 */
  mainlineCauseMaxPerCall: number
  /**
   * 每条里程碑随请求发出的 `detail` 摘录字符数；`0` = 退回"只发标题"的旧行为。
   *
   * 为什么会有这个键：只发标题时模型手里没有证据，只能从标题猜因果——信息不够的就编一个
   * **听起来合理**的（第 1 轮真实原因是"用户提出任务"，却被写成"插件机制未初始化"）。
   * 摘录让"猜"变成"读"。`0` 这条退路必须保留：有人就是要省这次调用的输入 token。
   */
  mainlineCauseExcerptChars: number

  // ── 召回 ─────────────────────────────────────────────────────────────
  /** recall 默认返回条数。 */
  recallDefaultLimit: number
  /** recall 单次返回上限。 */
  recallMaxLimit: number
  /** recall 工具名策略。 */
  recallToolName: RecallToolName

  // ── 注入预算 ─────────────────────────────────────────────────────────
  /**
   * 每轮三层投影允许占用的 token 上限。
   *
   * 超出后按优先级仲裁：L1 标记（最便宜、锚定原文可信度）> L2 摘要（信息载荷，
   * 可截断）> L3 索引（只是索引，可丢弃，需要时用 recall 查）。
   * 这是"组合社区压缩插件"的落点——多个注入方共存时，由本插件负责分配。
   */
  injectionBudgetTokens: number

  // ── 社区组件协同 ─────────────────────────────────────────────────────
  /** 压缩引擎仲裁策略。 */
  integrationEngine: EngineMode
  /** 是否启用 dsh-headroom 的工具输出压缩协同。 */
  integrationHeadroom: boolean
  /** 是否启用 dsh-mcp-lens 的 MCP 工具面压缩协同。 */
  integrationMcpLens: boolean
  /** 是否把 dsh-context-doctor 的注入审计纳入验证输出。 */
  integrationAudit: boolean

  // ── 诊断 ─────────────────────────────────────────────────────────────
  /** boot 时跑一次组件矩阵自检，缺件只 warn 不崩。 */
  selfTestAfterBoot: boolean
  /** 验证输出粒度。 */
  verifyDetail: 'summary' | 'developer'
}

/** 默认值：与 README「配置矩阵」一节逐项对应。 */
export const DEFAULTS: TriLayerConfig = {
  l1RetainTurns: 8,
  l1Inject: 'marker',
  l1ProtectFromCompaction: true,

  l2RetainTurns: 24,
  l2Mode: 'llm',
  // 1024 曾经是错的：宿主路由带 `reasoningEffort: "max"`，推理 token 与正文共享
  // 这个输出预算，1024 会被推理全部吃掉 → L2 永远退回抽取式（真实故障）。
  // 4096 是给「推理 + 一段摘要」留出的余量。
  //
  // 但**只调这个数是不够的**：4096 实测仍然撞上限。真正的原因是推理侧没有约束
  // （见 internalCallReasoningEffort），而且指令里没写期望长度（见 DIGEST_INSTRUCTION）。
  // 上限本身保持 4096：它是"推理 + 正文"的总闸门，收紧它只会更容易截断。
  l2MaxSummaryTokens: 4096,
  // 内部调用不需要深思：压到 low 把预算让给正文。默认值的选择依据见 InternalCallEffort。
  internalCallReasoningEffort: 'low',
  l2Inject: true,
  l2MinTurnsBeforeSummary: 3,
  l2RefreshIntervalMs: 0,

  l3Enabled: true,
  l3Store: 'auto',
  l3Dir: '',
  l3Distill: true,
  l3MaxRecords: 500,
  l3PruneMinScore: 0.25,
  l3InjectIndex: true,

  mainlineEnabled: true,
  mainlineInject: true,
  mainlineMaxMilestones: 60,
  mainlineMaxTokens: 2500,
  mainlineCauseEnabled: true,
  mainlineCauseMinBatch: 3,
  mainlineCauseMaxPerCall: 20,
  // 200：实测 120 下 25 行失败原文只有 11 行能完整进摘录，200 是 25/25；
  // 而 240 成本更高、信号保留率反而更低。取值依据与成本数字见 CAUSE_EXCERPT_CHARS。
  mainlineCauseExcerptChars: CAUSE_EXCERPT_CHARS,

  recallDefaultLimit: 5,
  recallMaxLimit: 20,
  recallToolName: 'auto',

  injectionBudgetTokens: 1200,

  integrationEngine: 'auto',
  integrationHeadroom: true,
  integrationMcpLens: true,
  integrationAudit: true,

  selfTestAfterBoot: true,
  verifyDetail: 'summary',
}

/** 取整数并夹到闭区间；非有限值一律回落到 `fallback`。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 取枚举值；不在允许集合内一律回落到 `fallback`。 */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** 取布尔；只认显式布尔值，其余用 `fallback`。 */
function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 归一 + 钳制未经信任的原始配置。
 *
 * 面板写入、组合行配置、以及 loader 投影都在这里收口，因此下游可以假定：
 * 区间合法、枚举合法。越界值只会被夹到合法区间，不会让插件加载失败。
 *
 * @param raw - 原始配置（可能来自 YAML、设置面板或 undefined）。
 * @returns 可直接使用的完整配置。
 */
export function resolveConfig(raw: unknown): TriLayerConfig {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const pruneScore = typeof s.l3PruneMinScore === 'number' ? s.l3PruneMinScore : DEFAULTS.l3PruneMinScore
  return {
    // 上限 64 轮：再长的"工作记忆"实际上已经不是工作记忆了。
    l1RetainTurns: clampInt(s.l1RetainTurns, 1, 64, DEFAULTS.l1RetainTurns),
    l1Inject: pickEnum(s.l1Inject, ['marker', 'full', 'off'] as const, DEFAULTS.l1Inject),
    l1ProtectFromCompaction: pickBool(s.l1ProtectFromCompaction, DEFAULTS.l1ProtectFromCompaction),

    l2RetainTurns: clampInt(s.l2RetainTurns, 1, 512, DEFAULTS.l2RetainTurns),
    l2Mode: pickEnum(s.l2Mode, ['llm', 'extractive', 'off'] as const, DEFAULTS.l2Mode),
    l2MaxSummaryTokens: clampInt(s.l2MaxSummaryTokens, 128, 8192, DEFAULTS.l2MaxSummaryTokens),
    // `inherit` 必须在允许集合里：那是"完全不碰宿主推理配置"的退路，
    // 某些路由（或网关）就是要求调用方别插手段位。
    internalCallReasoningEffort: pickEnum(
      s.internalCallReasoningEffort,
      ['inherit', 'off', 'low', 'high', 'max'] as const,
      DEFAULTS.internalCallReasoningEffort,
    ),
    l2Inject: pickBool(s.l2Inject, DEFAULTS.l2Inject),
    l2MinTurnsBeforeSummary: clampInt(s.l2MinTurnsBeforeSummary, 1, 64, DEFAULTS.l2MinTurnsBeforeSummary),
    l2RefreshIntervalMs: clampInt(s.l2RefreshIntervalMs, 0, 3_600_000, DEFAULTS.l2RefreshIntervalMs),

    l3Enabled: pickBool(s.l3Enabled, DEFAULTS.l3Enabled),
    l3Store: pickEnum(s.l3Store, ['auto', 'sqlite', 'jsonl'] as const, DEFAULTS.l3Store),
    l3Dir: typeof s.l3Dir === 'string' ? s.l3Dir.trim() : DEFAULTS.l3Dir,
    l3Distill: pickBool(s.l3Distill, DEFAULTS.l3Distill),
    l3MaxRecords: clampInt(s.l3MaxRecords, 16, 100_000, DEFAULTS.l3MaxRecords),
    l3PruneMinScore: Math.min(1, Math.max(0, pruneScore)),
    l3InjectIndex: pickBool(s.l3InjectIndex, DEFAULTS.l3InjectIndex),

    mainlineEnabled: pickBool(s.mainlineEnabled, DEFAULTS.mainlineEnabled),
    mainlineInject: pickBool(s.mainlineInject, DEFAULTS.mainlineInject),
    // 500 条已远超"一眼看完"的极限：再多就不再是骨架，而是一份长文。
    mainlineMaxMilestones: clampInt(s.mainlineMaxMilestones, 1, 500, DEFAULTS.mainlineMaxMilestones),
    // 下限 200 保证"任务标题行 + 至少一条里程碑"装得下；上限 20000 保证它仍是个上限。
    mainlineMaxTokens: clampInt(s.mainlineMaxTokens, 200, 20_000, DEFAULTS.mainlineMaxTokens),
    mainlineCauseEnabled: pickBool(s.mainlineCauseEnabled, DEFAULTS.mainlineCauseEnabled),
    // 下限 1 = 缺一条就补（想实时看因果的人可以这么配）；上限 50 = 再高就不叫"攒一批"了。
    mainlineCauseMinBatch: clampInt(s.mainlineCauseMinBatch, 1, 50, DEFAULTS.mainlineCauseMinBatch),
    // 上限 100 与 recallMaxLimit 同量级：请求再长也只是省下几次往返，换来的是超时与截断。
    mainlineCauseMaxPerCall: clampInt(s.mainlineCauseMaxPerCall, 1, 100, DEFAULTS.mainlineCauseMaxPerCall),
    // 下限是 **0 而不是 1**：0 = 只发标题的旧行为，是一条必须留着的退路（省 token）。
    // 上限 500 与 CAUSE_EXCERPT_MAX 同源，渲染器也用同一个数兜底。
    mainlineCauseExcerptChars: clampInt(s.mainlineCauseExcerptChars, 0, CAUSE_EXCERPT_MAX, DEFAULTS.mainlineCauseExcerptChars),

    recallDefaultLimit: clampInt(s.recallDefaultLimit, 1, 50, DEFAULTS.recallDefaultLimit),
    recallMaxLimit: clampInt(s.recallMaxLimit, 1, 100, DEFAULTS.recallMaxLimit),
    recallToolName: pickEnum(s.recallToolName, ['auto', 'memory_recall', 'tri_recall'] as const, DEFAULTS.recallToolName),

    injectionBudgetTokens: clampInt(s.injectionBudgetTokens, 200, 8000, DEFAULTS.injectionBudgetTokens),

    integrationEngine: pickEnum(
      s.integrationEngine,
      ['auto', 'argp', 'instant', 'headroom', 'basic', 'none'] as const,
      DEFAULTS.integrationEngine,
    ),
    integrationHeadroom: pickBool(s.integrationHeadroom, DEFAULTS.integrationHeadroom),
    integrationMcpLens: pickBool(s.integrationMcpLens, DEFAULTS.integrationMcpLens),
    integrationAudit: pickBool(s.integrationAudit, DEFAULTS.integrationAudit),

    selfTestAfterBoot: pickBool(s.selfTestAfterBoot, DEFAULTS.selfTestAfterBoot),
    verifyDetail: pickEnum(s.verifyDetail, ['summary', 'developer'] as const, DEFAULTS.verifyDetail),
  }
}

/**
 * 解析 L3 持久化目录，绝不硬编码任何机器路径。
 *
 * 顺序：显式 `l3Dir` > `$DSH_HOME/tri-layer-memory` >
 * `<用户目录>/.dsh/tri-layer-memory` > `<临时目录>/dsh-tri-layer-memory`。
 *
 * @param configured - 配置里的 `l3Dir`（空串表示未设置）。
 * @returns 绝对目录路径（不保证已存在，调用方负责 mkdir）。
 */
export function defaultStorageDir(configured = ''): string {
  if (configured.length > 0) return configured
  const dshHome = process.env.DSH_HOME?.trim()
  if (dshHome !== undefined && dshHome.length > 0) return join(dshHome, 'tri-layer-memory')
  const userHome = process.env.USERPROFILE?.trim() || process.env.HOME?.trim()
  if (userHome !== undefined && userHome.length > 0) return join(userHome, '.dsh', 'tri-layer-memory')
  return join(tmpdir(), 'dsh-tri-layer-memory')
}
