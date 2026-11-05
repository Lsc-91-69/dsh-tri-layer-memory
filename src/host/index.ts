/**
 * index.ts — dsh-tri-layer-memory（三层记忆压缩引擎）Host 半边入口。
 *
 * Cordis 函数插件形态：exports `{ name, inject, Config, apply }`，**没有** default
 * export（混用两种形态会让 Loader 丢弃函数插件的 namespace）。
 *
 * 职责：
 * 1. 统一配置：向 `settings` 服务安装 `tri-layer-memory` 命名空间，
 *    面板与组合行共用同一份 schema（`ctx.inject(['settings'], …)` 反应式安装，
 *    设置服务缺席时插件照常工作，只是没有面板）。
 * 2. 三层级联：每轮 pre-step 投影 L1 → 摘要 L2 → 蒸馏 L3，并把当前投影注入请求。
 * 3. 按需回忆：注册 `memory_recall`（重名时自动改名）/ `memory_state` / `memory_verify`。
 * 4. 仲裁：探测 `ctx.compaction` 的实际实现并校验引擎互斥，**不抢占**该槽位。
 *
 * 全局生效：本插件挂载在 profile 的 host 平面（cordis.patch.yml 的 insert 行），
 * 不依赖任何 preset id，因此标准 / PTC / 极简 / cordis 预设下都自动工作。
 *
 * @module dsh-tri-layer-memory
 */
import { createUserMessage, PLUGIN_SOURCE_KIND } from './platform.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS, MEMORY_NAMESPACE, defaultStorageDir, resolveConfig } from './config-core.ts'
import type { TriLayerConfig } from './config-core.ts'
import { PROJECTION_HEADER, collectToolCalls, collectToolResults, contentToText, estimateTokens, messageBody, pendingWindowInput, projectWorkingWindow, renderWorkingMemory } from './l1-working.ts'
import type { EventLike, ToolCallHit, ToolResultHit, TurnSpan } from './l1-working.ts'
import { L2_TRUNCATION_NOTE, arbitrateInjection, fitMainline } from './budget.ts'
import type { Arbitration, InjectionBlock, MainlineFit } from './budget.ts'
import { buildDigest, callWithEffortRetry, extractiveDigest, renderShortTermMemory, resolveTarget } from './l2-short.ts'
import type { DigestAttempt, DigestFailure, DigestResult, LlmSeam } from './l2-short.ts'
import { DeepMemoryStore, extractKeywords } from './l3-deep.ts'
import type { MemoryRecord, PruneOutcome } from './l3-deep.ts'
import { captureToolRecord } from './tool-digest.ts'
import { captureConstraintRecord } from './constraint-digest.ts'
import {
  CAUSE_INSTRUCTION,
  applyCauses,
  attachCauses,
  causeCacheKey,
  extractMilestones,
  isTemplateCause,
  missingCauses,
  parseCauseReply,
  renderCauseRequest,
  withBoundaryClauses,
} from './milestones.ts'
import type { Milestone } from './milestones.ts'
import { buildDedupeTool, buildRecallTool, buildStateTool, buildVerifyTool } from './recall.ts'
import type { MemoryRuntime } from './recall.ts'
import { engineOf, resolveRecallToolName } from './integration.ts'
import { PROJECTION_KEY, createTriLayerProjection } from './projection.ts'
import type { ProjectionObservation, TriLayerFeedInput, TriLayerProjection } from './projection.ts'

/** Loader 诊断用的插件名。 */
export const name = 'dsh-tri-layer-memory'

/**
 * **空数组是刻意的。**
 *
 * `exports.inject` 是**硬依赖**：任何一项在宿主启动时缺席，插件 fiber 就永远停在
 * `pending`，宿主把"有条目未激活"当启动失败，**整个应用打不开**。实测崩溃信息：
 *   web boot: 1 entry did not activate
 *     dsh-tri-layer-memory: pending (waiting for service: settingsScope)
 * 三层记忆不该有这种能力，因此所有服务都在 apply 内部用 `ctx.inject([...], cb)`
 * 软等待——来了就启用，不来就少一块功能，插件始终 active。
 */
export const inject = []

/**
 * 惰性加载 schemastery 并构造设置面板的校验 schema。
 *
 * 刻意用动态 import：`@deepseek-ai/schemastery` 在宿主没有模块回退层时不可解析
 * （见 platform.ts 的说明）。拿不到就只跳过设置面板，L1/L2/L3 与三个模型工具
 * 照常工作——绝不能因为"面板渲染不出来"而让整个插件 failed to import。
 *
 * @returns schemastery schema，或 null 表示不可用。
 */
async function loadSettingsSchema(): Promise<unknown | null> {
  try {
    const mod = (await import('@deepseek-ai/schemastery')) as { default?: unknown }
    const z = (mod.default ?? mod) as {
      object: (shape: Record<string, unknown>) => unknown
      number: () => { default: (v: number) => unknown }
      string: () => { default: (v: string) => unknown }
      boolean: () => { default: (v: boolean) => unknown }
    }
    const num = (v: number): unknown => z.number().default(v)
    const str = (v: string): unknown => z.string().default(v)
    const bool = (v: boolean): unknown => z.boolean().default(v)
    return z.object({
      l1RetainTurns: num(DEFAULTS.l1RetainTurns),
      l1Inject: str(DEFAULTS.l1Inject),
      l1ProtectFromCompaction: bool(DEFAULTS.l1ProtectFromCompaction),
      l2RetainTurns: num(DEFAULTS.l2RetainTurns),
      l2Mode: str(DEFAULTS.l2Mode),
      l2MaxSummaryTokens: num(DEFAULTS.l2MaxSummaryTokens),
      // 内部调用的推理档位也必须进 schema：缺席的键会被 resolveConfig 当成"没配过"而回落默认，
      // 于是用户在组合行里把 inherit（完全不碰宿主推理配置）配好、面板一保存就被
      // 静默改回 low——那是一种"看起来生效、实际被改回去"的故障，正是本插件栽过的那类。
      internalCallReasoningEffort: str(DEFAULTS.internalCallReasoningEffort),
      l2Inject: bool(DEFAULTS.l2Inject),
      l2MinTurnsBeforeSummary: num(DEFAULTS.l2MinTurnsBeforeSummary),
      l2RefreshIntervalMs: num(DEFAULTS.l2RefreshIntervalMs),
      l3Enabled: bool(DEFAULTS.l3Enabled),
      l3Store: str(DEFAULTS.l3Store),
      l3Dir: str(DEFAULTS.l3Dir),
      l3Distill: bool(DEFAULTS.l3Distill),
      l3MaxRecords: num(DEFAULTS.l3MaxRecords),
      l3PruneMinScore: num(DEFAULTS.l3PruneMinScore),
      l3InjectIndex: bool(DEFAULTS.l3InjectIndex),
      // 工具细节池的四个键也必须在 schema 里：设置服务在场时它接管配置来源，
      // 缺席的键会被 resolveConfig 当成"没配过"而回落默认——那样用户在组合行里
      // 关掉工具落库、面板一保存就被静默改回开启，是同一族故障的又一次。
      l3ToolDistill: bool(DEFAULTS.l3ToolDistill),
      l3ToolRecordChars: num(DEFAULTS.l3ToolRecordChars),
      l3ToolMaxPerSession: num(DEFAULTS.l3ToolMaxPerSession),
      l3ToolMaxRecords: num(DEFAULTS.l3ToolMaxRecords),
      // 约束细节池的四个键同理：缺一个，面板保存就会把用户配的上限静默改回默认。
      l3ConstraintDistill: bool(DEFAULTS.l3ConstraintDistill),
      l3ConstraintRecordChars: num(DEFAULTS.l3ConstraintRecordChars),
      l3ConstraintMaxPerSession: num(DEFAULTS.l3ConstraintMaxPerSession),
      l3ConstraintMaxRecords: num(DEFAULTS.l3ConstraintMaxRecords),
      // 主线骨架的键也必须在 schema 里：设置服务在场时它接管配置来源，
      // 缺席的键会被 resolveConfig 当成"没配过"而回落到默认值——那样面板一保存，
      // 用户在组合行里配的骨架上限就被静默改回默认。
      mainlineEnabled: bool(DEFAULTS.mainlineEnabled),
      mainlineInject: bool(DEFAULTS.mainlineInject),
      mainlineMaxMilestones: num(DEFAULTS.mainlineMaxMilestones),
      mainlineMaxTokens: num(DEFAULTS.mainlineMaxTokens),
      mainlineCauseEnabled: bool(DEFAULTS.mainlineCauseEnabled),
      mainlineCauseMinBatch: num(DEFAULTS.mainlineCauseMinBatch),
      mainlineCauseMaxPerCall: num(DEFAULTS.mainlineCauseMaxPerCall),
      // 摘录长度同样必须进 schema：缺席的键会被 resolveConfig 当成"没配过"而回落默认，
      // 于是用户在组合行里把 0（只发标题）配好、面板一保存就被静默改回 200。
      mainlineCauseExcerptChars: num(DEFAULTS.mainlineCauseExcerptChars),
      recallDefaultLimit: num(DEFAULTS.recallDefaultLimit),
      recallMaxLimit: num(DEFAULTS.recallMaxLimit),
      recallToolName: str(DEFAULTS.recallToolName),
      injectionBudgetTokens: num(DEFAULTS.injectionBudgetTokens),
      integrationEngine: str(DEFAULTS.integrationEngine),
      integrationHeadroom: bool(DEFAULTS.integrationHeadroom),
      integrationMcpLens: bool(DEFAULTS.integrationMcpLens),
      integrationAudit: bool(DEFAULTS.integrationAudit),
      selfTestAfterBoot: bool(DEFAULTS.selfTestAfterBoot),
      verifyDetail: str(DEFAULTS.verifyDetail),
    })
  } catch {
    // 宿主未提供 schemastery：设置面板不可用，核心功能不受影响。
    return null
  }
}

/**
 * 静态系统提示段：说明三层记忆的存在与 recall 工具的用法。
 *
 * 刻意保持静态（不含实时读数），这样它落在系统提示里可以稳定复用 KV cache；
 * 实时读数由 `agent/pre-step` 的动态注入承担。
 */
const POLICY_SECTION = [
  '## 三层记忆压缩引擎',
  '本会话的上下文按人脑式三层记忆组织，你在任何时刻都可以这样理解自己的记忆：',
  '- **L1 工作记忆**：最近若干轮对话的完整原文，就在上方，未做任何压缩，最可信。',
  '- **L2 短期记忆**：较早内容的摘要，每轮自动注入，覆盖已完成子任务与关键决策。',
  '- **L3 深层记忆**：更早的内容已浓缩并持久化到本地，**不自动注入**。',
  '  当摘要里缺少你需要的细节（旧文件内容、已废弃方案、早期错误原文）时，',
  '  调用 recall 工具按关键词或 id 取回。不要凭印象编造被遗忘的内容——先查。',
].join('\n')

/**
 * 一次注入的**实际** token 记账（诊断用；刻意不进投影状态）。
 *
 * **为什么必须有它**：诊断文件过去只记"摘要调用花了多少"（`l2.attempt`）和
 * "骨架有几条"，却从不记"这一轮到底往上下文里塞了多少 token"。于是
 * "三层记忆压缩了 82 倍"这种话无法自证——那个 82 倍其实只是 **L2 摘要自己的
 * 输入/输出比**（见 l2-render 的 `renderShortTermMemory`），不是系统级压缩比；
 * 而系统级的分子（原始会话）与分母（实际注入）此前都没有落盘的读数。
 * 这是同一族缺陷的第七次：**读数看起来有，缺的正好是关键的加数**。
 *
 * 口径（全部用 {@link estimateTokens}，不引入第二套估算）：
 * - 四项都取**仲裁/裁剪之后、实际进投影的文本**（L2/L3 被截断的，按截断后的文本算）；
 * - `mainlineTokens` 取 `fitMainline` 的渲染后读数——骨架不进仲裁，但确实注入；
 *   漏掉它会让注入合计偏小、压缩比虚高，而它恰是"主内容不遗忘"的载体；
 * - `totalInjected` 是四项之和，**不含**投影消息头（`# 三层记忆 · 本轮投影`）与
 *   块间空行（两者合计实测 9–10 tokens，脚本里作为 messageTokens − totalInjected 单独报出）。
 *   刻意保持可加性：只有自洽的加法，才能让
 *   "四项之和 = 合计"成为一条会把"漏算一层"变成测试失败的断言，而不是一个
 *   看起来合理的数字。
 */
interface InjectionAccounting {
  /** L1 注入块（marker 形态下只是窗口边界声明，不等于 L1 原文窗口的体量）。 */
  l1Tokens: number
  /** L2 摘要块（含块头；被预算截断时按截断后文本算）。 */
  l2Tokens: number
  /** L3 索引块（含块头；被丢弃时为 0）。 */
  l3Tokens: number
  /** 主线骨架块（`fitMainline` 裁剪后的渲染文本，含块头与任务标题行）。 */
  mainlineTokens: number
  /** 四项之和（见上方说明：不含消息头与空行）。 */
  totalInjected: number
  /** 本次仲裁使用的预算（只约束 L1/L2/L3；骨架另有独立上限）。 */
  budgetTokens: number
  /** 因预算被**整块丢弃**的块 id（截断但仍在用的不算）。 */
  dropped: string[]
  /**
   * 本次注入发生的时刻（ISO）。
   *
   * 存在的理由：诊断文件每轮 pre-step 都会落盘一次（它要记 L2/骨架的失败原因），
   * 而注入本身可能因"内容没变"被跳过。没有这个时间戳，读者会把上一轮的注入数字
   * 当成这一轮的——比缺字段更糟。
   */
  at: string
}

/** 单个会话的记忆状态（WeakMap 键，随会话回收）。 */
interface SessionState {
  /** 当前 L2 摘要。 */
  digest: DigestResult | null
  /** 上次生成摘要的时间。 */
  lastDigestAt: number
  /**
   * 已蒸馏进 L3 的最高轮号（**进程内**水位，不是权威值）。
   *
   * 进程重启会丢掉它，所以它必须能从 L3 库重新推断：见
   * {@link SessionState.l3WatermarkSeeded} 与 refreshDigest 里的播种逻辑。
   * 只靠内存时实测同一轮被重复蒸馏 32 次（turn 1 有 32 份副本）。
   */
  l3HighWaterTurn: number
  /**
   * 本会话的水位是否已按 L3 库内容播种过。
   *
   * 为什么不直接判断 `l3HighWaterTurn === -1`：库里没有任何 turn 记录时（新会话）
   * 最大轮号正好就是 -1，两个状态无法区分，于是每一轮都会白扫一遍全库。
   */
  l3WatermarkSeeded: boolean
  /** 上次注入的投影文本（内容不变则不重复注入，省 token）。 */
  lastInjected: string | null
  /** 上次注入预算仲裁的结果（memory_state / memory_verify 报告用）。 */
  lastArbitration: Arbitration | null
  /** 上次**真正注入**的 token 记账；null = 本会话还没注入过。 */
  injection: InjectionAccounting | null
  /** 上次提取主线骨架时的 L1 溢出轮数；-1 表示本会话还没提取过。 */
  mainlineWaterMark: number
  /** 上次提取出的里程碑（溢出轮数不变时直接复用，避免每步重跑全量提取）。 */
  mainline: Milestone[]
  /**
   * 已经用 LLM 补过的 cause，键是 {@link causeCacheKey}（轮次区间 + 标题）。
   *
   * 必须缓存：{@link extractMilestones} 每次返回全新对象，水位一变就得把补过的因果
   * 贴回去，否则骨架会退回确定性标签，与 L3 里那份（已经回填过的）永久分叉。
   */
  mainlineCauses: Map<string, string>
  /**
   * 本会话**确认已落库**的里程碑键（{@link causeCacheKey}：轮次区间 + 标题）。
   *
   * 为什么要有它：展示分层会把更早的主线移出注入，并在骨架末尾写一行
   * "已存入 L3，用 recall 取回"。那句提示是**给模型的行动指令**，如果写入失败
   * （store 未就绪、后端抛错）却照常出现，模型会去查一个不存在的记录——比不提示更糟。
   * 所以提示行必须按这份集合逐条核对，不能按"应该写过"来写。
   */
  mainlineStored: Set<string>
  /**
   * 里程碑键 → L3 记录 id。
   *
   * 存在的理由：cause 回填后要把新正文写回**同一条**记录。旧实现靠"轮次区间先到先得"
   * 反查，同轮多条时只能改到第一条；有了这张表，每条里程碑都能精确改自己那条。
   */
  mainlineRecordIds: Map<string, string>
  /**
   * 是否已经给历史 turn 记录补过"未剪约束"段（每会话一次）。
   *
   * 为什么需要这个一次性开关：批量补写要把上百条记录重写一遍（虽然 `updateMany`
   * 只落盘一次），不该每个 pre-step 都试一遍。补写失败会保持 false，下一轮重试。
   */
  boundaryBackfillDone: boolean
  /**
   * 上次 L2 摘要**本该走模型却退回抽取式**的原因（成功或配置为 extractive 时为 null）。
   *
   * 存在的理由：`buildDigest` 的回退是刻意的（模型失败不能拖垮对话），但失败原因
   * 过去被一个静默 `catch {}` 吃掉，观察面上只剩 `via: 'extractive'`，看不出是
   * 模型缺席、路由解析不到还是调用抛错。桌面端的宿主日志不可见，`memory_state`
   * 是唯一可靠的观察面，所以原因必须存进状态、从这里出去。
   */
  l2Failure: DigestFailure | null
  /**
   * 上次摘要调用**实际发生了什么**（成功、被截断保留、失败都记）。
   *
   * 与 {@link l2Failure} 的分工：那个只在退回抽取式时有值，回答"为什么没走模型"；
   * 这个每次真发出调用都有值，回答"这次调用到底产出了多少正文、推理吃了多少预算"。
   * 只有它能把"推理吃光预算"与"模型写了很长"两种根因分开——而这两种根因的修法
   * 完全不同（前者压推理档位，后者压期望长度）。
   */
  l2Attempt: DigestAttempt | null
  /** 上次 L2 摘要失败时 llm seam 是从哪条路拿到的（诊断用；成功时也保留最后一条路）。 */
  llmSource: 'inject' | 'get' | 'none'
  /** 上次骨架 cause 回填失败的原因（成功或未触发时为 null）。 */
  causeFailure: DigestFailure | null
  /**
   * 上次 cause 回填调用**实际发生了什么**（成功、被截断、失败都记）。
   *
   * 与 {@link l2Attempt} 同形、同一个理由：这条调用走的是**同一条 seam、同一个模型**，
   * 因此"推理有没有吃光预算"是它唯一可能静默失效的方式——而它已经这么失效过整整
   * 一个版本周期（诊断里只有 `cause reply carried no parsable entries (0 chars)`，
   * 看不出是"模型没回"还是"推理把预算吃光了"）。0 字符 + `finish: max-tokens` 指向
   * 推理，0 字符 + `finish: stop` 指向模型真没说话，两条的修法完全不同。
   */
  causeAttempt: CauseAttempt | null
}

/**
 * 一次 cause 回填调用的读数（与 `DigestAttempt` 同形的诊断面）。
 *
 * 刻意不复用 `DigestAttempt`：那个接口带 `salvaged` / `droppedChars` / `boundary`
 * 三个**摘要专属**字段（摘要被截断后要按行边界裁掉半句话），而 cause 回填撞上限时
 * 是"**不裁**、把被截断的 JSON 直接交给宽容解析"——裁掉尾部反而会丢掉可能完整的
 * 最后一对键值。硬塞同一个类型只会让两边各记一堆恒为默认值的字段。
 */
interface CauseAttempt {
  /** 终止原因实际值：`stop` / `max-tokens` / `error` / `aborted` / `none`。 */
  finish: string
  /** 请求里实际发出的输出上限。 */
  maxTokens: number
  /** 请求正文（含摘录与指令）的字符数。 */
  inputChars: number
  /** 模型产出的正文字符数（**丢弃前**；0 = 推理吃光预算或模型没说话）。 */
  outputChars: number
  /** provider 上报的用量，原样透传。 */
  usage?: unknown
  /** 撞上限但**正文非空**：不再整批作废，交给宽容解析尽量救回条目。 */
  salvaged: boolean
  /** 最终那次调用实际带的档位；`inherit` = 没带（见 config-core 的 InternalCallEffort）。 */
  reasoningEffort: string
  /** 是否因该档位不被支持而**去掉字段重试过一次**。 */
  effortRetry: boolean
  /** 重试前的原始失败消息（只有 `effortRetry` 为真时才有）。 */
  firstFailure?: string
}

/**
 * 补算轨迹：一条会话从"投影注册"走到"feed 真的写进投影"的全过程（诊断用）。
 *
 * **存在的唯一理由**：这条链上有四段过去**全是静默**的——软等待回调有没有执行、
 * `ctx.get('sessions')` 拿不拿得到、`sessions.get(id)` 找不找得到、
 * `feedProjection` 有没有抛。任何一段断掉，观察面上都只是"思维栏空着"，
 * 而空着的原因（没注册 / 没补算 / 补算失败 / 补算了但没落地）需要完全不同的修法。
 * 每一段都记下来，{@link hydrateBlockedAt} 再把断点归成一个字段。
 */
interface HydrateTrace {
  sessionId: string
  updatedAt: string
  /** 注册段：软等待回调是否执行、注册表从哪条路可见、register 是否抛错。 */
  register: {
    /** `ctx.inject(['sessionProjections'], cb)` 的回调是否执行过。 */
    injectRan: boolean
    /** 注册表最终从哪条路拿到：软等待 / `ctx.get` / 属性代理 / 三条都不通。 */
    registryVia: 'inject' | 'get' | 'prop' | 'none'
    /** `registry.register()` 实际调用次数。 */
    calls: number
    /** 注册抛错的原文；没抛错为 null。 */
    error: string | null
  }
  /** 折叠段：框架把事件喂进 `apply` 的次数与结果（`apply` 是唯一的过程证据）。 */
  fold: {
    applies: number
    changed: number
    hydrated: number
    /** 冷读兜底（按累积事件派生读数）成功了几次。 */
    derived: number
    /** 派生抛错的原文；没抛错为 null。 */
    deriveError: string | null
    /** 读路径探针是否跑过（`stateOf` / `snapshot` 只探一次，避免每轮重复折叠）。 */
    probed: boolean
    /** 注册表里本 key 是否已注册（null = 探针没跑到）。 */
    stateRegistered: boolean | null
    stateRev: number | null
    stateUpdatedAt: number | null
    stateMainline: number | null
    /** 宿主 `snapshot()` 会发给客户端的那份值的 updatedAt（0 = 客户端显示"尚未就绪"）。 */
    servedUpdatedAt: number | null
    /** 读路径探针抛错的原文（`snapshot()` 抛错会让整条控制流基线失败）。 */
    servedError: string | null
    /** 本 key 的视图变化被框架广播出去的次数与最后一次 seq。 */
    broadcasts: number
    lastBroadcastSeq: number | null
  }
  /** 会话服务段：`ctx.get('sessions')` 与 `sessions.get(id)` 的归宿。 */
  sessions: {
    service: 'ok' | 'undefined' | 'threw' | 'untried'
    serviceError: string | null
    lookup: 'found' | 'undefined' | 'threw' | 'untried'
    lookupError: string | null
    /** 从 `session/created` 与 pre-step 载荷里直接捕获的活会话数（不依赖任何服务）。 */
    captured: number
  }
  /** 事件段：`session/created` 监听是否注册、触发几次、载荷是不是活会话。 */
  created: { registered: boolean; fired: number; live: number; emptyLog: number }
  /** 补算段：每次调用的路径与归宿。 */
  hydrate: {
    calls: number
    /** 各条路径各被调用几次（created / byId / byCapture）。 */
    byPath: Record<string, number>
    fed: number
    emptyLog: number
    sessionMissing: number
    threw: { path: string; message: string }[]
    /** 最终归宿：feed 有没有真的写进投影。 */
    feedLanded: boolean
  }
  /** 一眼看出断在哪一步；null = 这条链上没有断点。 */
  blockedAt: string | null
}

/** 造一条空的补算轨迹。 */
function newHydrateTrace(sessionId: string): HydrateTrace {
  return {
    sessionId,
    updatedAt: new Date().toISOString(),
    register: { injectRan: false, registryVia: 'none', calls: 0, error: null },
    fold: {
      applies: 0,
      changed: 0,
      hydrated: 0,
      derived: 0,
      deriveError: null,
      probed: false,
      stateRegistered: null,
      stateRev: null,
      stateUpdatedAt: null,
      stateMainline: null,
      servedUpdatedAt: null,
      servedError: null,
      broadcasts: 0,
      lastBroadcastSeq: null,
    },
    sessions: { service: 'untried', serviceError: null, lookup: 'untried', lookupError: null, captured: 0 },
    created: { registered: false, fired: 0, live: 0, emptyLog: 0 },
    hydrate: { calls: 0, byPath: {}, fed: 0, emptyLog: 0, sessionMissing: 0, threw: [], feedLanded: false },
    blockedAt: null,
  }
}

/**
 * 把整条链的归宿归成一个断点描述（诊断文件的"一眼看出"字段）。
 *
 * 顺序就是数据流顺序：注册 → 事件/折叠触发 → 补算 → feed 落地。第一个不成立
 * 的环节就是断点——因为后面的环节都依赖它，记后面的只会误导。
 *
 * @param trace - 补算轨迹。
 * @returns 断点描述；这条链没有断点时为 null。
 */
function hydrateBlockedAt(trace: HydrateTrace): string | null {
  if (!trace.register.injectRan && trace.register.registryVia === 'none') {
    return '注册段没跑：sessionProjections 的软等待回调没执行，ctx.get / ctx.sessionProjections 也都读不到'
  }
  if (trace.register.error !== null) {
    return `注册段抛错：registry.register() 失败——${trace.register.error}`
  }
  if (trace.register.calls === 0) {
    return '注册段没跑：三条路都没拿到注册表（sessionProjections 缺席或不在本上下文的可见范围）'
  }
  if (trace.hydrate.calls === 0) {
    return '补算从没被调用过：session/created 没送到本会话，框架也没有为它折叠过投影'
  }
  if (trace.hydrate.fed === 0 && trace.fold.derived === 0) {
    if (trace.hydrate.sessionMissing > 0) {
      return `补算找不到活会话：sessions 服务=${trace.sessions.service}，get(id)=${trace.sessions.lookup}`
    }
    if (trace.hydrate.emptyLog > 0) {
      return '补算拿到的会话日志为空（会话还没装载完 / 是子代理会话）'
    }
    if (trace.hydrate.threw.length > 0) {
      return `补算抛错：${trace.hydrate.threw[0].path} → ${trace.hydrate.threw[0].message}`
    }
    return '补算被调用过但没有任何一次成功（原因未归类）'
  }
  if (!trace.hydrate.feedLanded) {
    return '补算报了成功但 feed 没落地：投影实例与补算写的不是同一份 feed'
  }
  if (trace.fold.derived === 0
    && trace.fold.applies > 0 && trace.fold.changed === 0 && trace.fold.broadcasts === 0) {
    return 'feed 已落地但从未折进状态：框架没有为它重算视图（检查点已在日志末尾时不会重放）'
  }
  return null
}

/** 插件上下文的最小可用投影（避免 import 运行时的 cordis 类型）。 */
interface HostContext {
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }
  on: (event: string, listener: (...a: any[]) => any, options?: Record<string, unknown>) => void
  effect: (fn: () => unknown) => void
  inject: (deps: string[], callback: (scoped: HostContext) => void) => unknown
  get?: (name: string) => any
  tools?: { register: (tool: unknown) => unknown }
  settings?: { installSection: (...a: any[]) => void }
  /**
   * 会话投影注册表（`@deepseek-ai/dsh-session-projection` 的服务面）。
   *
   * 只在 `ctx.inject(['sessionProjections'], …)` 的软等待回调里读它——服务缺席时
   * 思维栏没有数据，插件其余部分照常工作。
   */
  sessionProjections?: { register: (definition: unknown) => () => void }
  /**
   * 会话存储（`ctx.sessions`）的最小面。
   *
   * 只在 `ctx.get('sessions')` 兜底路径上读，而且只在"框架折叠日志时本会话还没有
   * feed"那一刻读一次：用来把会话 id 换回活会话对象，好补算思维栏读数（见
   * `hydrateProjectionFeed`）。它绝不进 `exports.inject`（硬依赖缺席会拖死启动），
   * 拿不到就只是补算不了，投影照常工作。
   */
  sessions?: { get?: (id: string) => unknown }
}

/**
 * 渲染 L3 索引块（只报规模，不注入正文）。
 *
 * **工具记录只报条数，绝不报正文或主题**：工具细节池可能有几十条、每条几千字符，
 * 一旦进索引，每轮注入立刻按数量级膨胀。计数行是"可 recall"的提示，不是内容。
 *
 * 2026-11 剪枝：去掉了「近期主题」行（CJK 二元组碎片，召回路径不读它，见下方
 * 注释）、`约 N tokens` 与后端名。`keywords` 参数仍保留——它是调用方的既有契约，
 * 而且剪枝后本函数不再消费它；保留形状是为了让"删掉的那一行"只删渲染、不删数据。
 *
 * @param stats - L3 库的统计（含工具池/约束池条数）。
 * @param keywords - 当前任务链关键词（**已不参与渲染**，保留签名）。
 * @param recallName - 本插件 recall 工具的实际名字。
 * @param vaultNote - 另一个记忆库在场时的指引（无则为空串）。
 * @returns 注入文本。
 */
export function renderDeepIndex(
  stats: {
    count: number
    tokens: number
    backend: string | null
    tools?: number
    toolTokens?: number
    constraints?: number
    constraintTokens?: number
  },
  keywords: readonly string[],
  recallName: string,
  vaultNote: string,
): string {
  void keywords
  const lines = ['## L3 深层记忆（Deep Memory）']
  const tools = stats.tools ?? 0
  const constraints = stats.constraints ?? 0
  // 主内容口径单独报：工具池/约束池是独立预算，把它们加进"已持久化 N 条"会让主内容
  // 的规模读数随工具输出漂移，读者再也无法用这个数字判断"故事线有多大"。
  const mainCount = Math.max(0, stats.count - tools - constraints)
  if (mainCount === 0 && tools === 0 && constraints === 0) {
    lines.push(`- 库为空（后端 ${stats.backend ?? '未打开'}）。更早的内容尚未被蒸馏。`)
  } else {
    // 只报条数与"正文不在这里"。以下四项被删掉的理由（每一条都按"模型拿它做什么"
    // 检验过，答案都是"什么也不做"）：
    // - `近期主题`：由 CJK 二元组碎片拼成（实测出现 `user/message`、`seq`、`104`
    //   这种不像主题词的碎片）。召回路径**从不读它**——`memory_recall` 的输入只有
    //   query/id（见 recall.ts），关键词打分只读 L3 记录正文与记录自带 keywords。
    //   它唯一的读者是"模型看到这些词后自己改写 query"，而这一步没有任何实测证据。
    // - `约 N tokens`：模型不能据此做任何动作（不能删、不能扩容），却会让读者把它
    //   当成预算/限额。
    // - `（后端 sqlite）`：诊断信息，人在 memory_state 里能看到；对模型零行动价值。
    // - 工具池的 `约 N tokens`：同上，保留条数与"非结论"提醒即可。
    lines.push(`- 已持久化 ${mainCount} 条记录，**正文不在此处**。`)
    if (tools > 0) {
      // 只给计数与一句"它不是结论"。内容一律不进注入——这是硬约束。
      lines.push(`- 另有工具原始输出 ${tools} 条（可 recall，均为原始输出、非结论）。`)
    }
    if (constraints > 0) {
      // 约束池**必须单独报**：它是"人写下的规则原话"，不是工具输出。合并成一行会让
      // 模型以为约束也是原始输出（两者的可信度完全不同）。这一行是整条功能唯一的
      // 注入成本（实测 30 tokens 量级，见测试里的上界断言）。
      lines.push(`- 另有工具参数中的约束原话 ${constraints} 条（可 recall，是当时的原话、非结论）。`)
    }
  }
  lines.push(`- 需要细节时调用 \`${recallName}\`（关键词或 id）取回。`)
  if (vaultNote.length > 0) lines.push(vaultNote)
  return lines.join('\n')
}

/**
 * L3 索引的**保底形态**：一行计数 + recall 入口。
 *
 * **为什么必须保留这一行**：索引是"模型知道还有东西可以查"的唯一入口。它只有
 * 约 30 tokens，却决定了模型会不会去 recall；整块消失时，模型连"库里有 434 条"
 * 都不知道，表现就是"它不知道自己可以查"（实测 `dropped: ["l3"]`、`l3Tokens: 0`）。
 * 所以预算再紧也只允许它降级成这一行，不允许归零（降级由 budget.ts 的
 * `pinned/floorText` 保证；只有连一行都放不下时才会消失）。
 *
 * 与 {@link renderDeepIndex} 的分工：那个是完整索引（主内容条数 + 工具池条数 +
 * recall 用法 + vault 指引），这个是它的最小子集，**仍然带计数与工具名**——没有
 * 计数的"可以去查"和没有索引一样不可行动。
 *
 * @param count - L3 库里可 recall 的记录总数（含工具记录）。
 * @param recallName - 本插件 recall 工具的实际名字。
 * @returns 一行形态的索引。
 */
export function renderDeepIndexFloor(count: number, recallName: string): string {
  return '## L3 深层记忆（Deep Memory）\n'
    + `- 另有 ${count} 条记录可 recall（\`${recallName}\`，关键词或 id）。`
}

/**
 * 探测另一个记忆库（dsh-memory-vault）是否在场，并给出路由指引。
 *
 * 两个库语义不同，因此**不合并**结果：本插件管三层记忆的 L2/L3（会话内演化），
 * vault 管跨会话的稳定事实（用户偏好、项目约定、已定决策）。把两者的边界写进
 * 注入块，模型才知道该查哪一个——这比让两个 `memory_recall` 互相猜要可靠。
 *
 * @param context - 插件上下文。
 * @returns 指引行；vault 不在场时为空串。
 */
function vaultNote(context: HostContext): string {
  const tools = detectToolNames(context)
  if (!tools.has('memory_remember') || !tools.has('memory_recall')) return ''
  return '- 另有跨会话事实库（dsh-memory-vault）：用户偏好、项目约定、已定决策等**稳定事实**请用 `memory_recall`；'
    + '本插件管的是会话内的三层记忆，用上面的 recall 工具。'
}

/** 读当前 scope 的工具名集合（容错；失败返回空集）。 */
function detectToolNames(context: HostContext): Set<string> {
  const names = new Set<string>()
  try {
    const schemas = (context as { tools?: { schemas?: () => unknown } }).tools?.schemas?.()
    if (Array.isArray(schemas)) {
      for (const schema of schemas) {
        const name = (schema as { name?: unknown })?.name
        if (typeof name === 'string' && name.length > 0) names.add(name)
      }
    }
  } catch {
    // schema 投影失败只影响这一条指引，不影响投影本身。
  }
  return names
}

/**
 * 从会话对象安全读出事件数组。
 *
 * **这里踩过一个致命坑**：本插件最初只读 `session.events`，而 DSH 0.2.0-rc.2 的
 * `Session` **根本没有 `events` 属性**（只有 `snapshotEvents()` / `ownEvents()`）。
 * 于是它恒返回 `[]`，导致 L1 窗口、L2 摘要、主线骨架**在真实会话里全部静默失效**——
 * 而单测用的是 `{events}` 假会话，所以一路全绿也挡不住。症状是投影里只剩
 * L2/L3 的空壳文案、L1 段整段消失。
 *
 * 现在两条路都走：`events` 优先（兼容测试与旧宿主），退回 `snapshotEvents()`。
 */
function readEvents(session: unknown): EventLike[] {
  const target = session as { events?: unknown; snapshotEvents?: unknown } | null
  const direct = target?.events
  if (Array.isArray(direct)) return direct as EventLike[]

  const snapshot = target?.snapshotEvents
  if (typeof snapshot !== 'function') return []
  try {
    const out = (snapshot as () => unknown).call(target)
    return Array.isArray(out) ? (out as EventLike[]) : []
  } catch {
    // 会话未就绪时 snapshotEvents 可能抛错。读不到事件只是这一轮没有投影，
    // 绝不能让 agent/pre-step 挂掉。
    return []
  }
}

/** 从 L1 窗口抽取当前任务链关键词（用于 L3 剪枝评分）。 */
function taskKeywords(window: { hot: readonly TurnSpan[] }): string[] {
  const text = window.hot
    .map((span) => `${span.userText.join(' ')} ${span.toolNames.join(' ')}`)
    .join(' ')
  return extractKeywords(text)
}

/** 读出会话 id（缺失时用占位符，绝不写入 undefined）。 */
function sessionIdOf(session: unknown): string {
  const id = (session as { id?: unknown } | null)?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown'
}

/** 任务标题的字符上限，与 milestones.ts 的 TITLE_MAX 同值（同一行两种口径必然对不上）。 */
const TASK_TITLE_MAX = 40

/**
 * 进程内保留的补算轨迹与捕获会话数上限。
 *
 * 与投影的 MAX_FEEDS（64）同量级：轨迹和捕获表都按会话 id 索引（字符串，不能用
 * WeakMap 回收），不设上限的话长时间运行会无界增长。
 */
const MAX_TRACES = 64

/**
 * 去掉用户消息里的非文字噪声（图片占位、表情包指令、工具调用占位）。
 *
 * 与 milestones.ts 的 `cleanUserText` 同形：任务标题在注入块与骨架里是同一行文字，
 * 清洗规则不一致会让同一条任务在思维栏和上下文里显示成两个样子。
 *
 * @param text - 用户消息正文。
 * @returns 归一后的单行文本。
 */
function cleanUserText(text: string): string {
  return text
    .replace(/\[image\]/gi, '')
    .replace(/\[表情:[^\]]*\]/g, '')
    .replace(/\[tool-call [^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 会话初始任务的原话。
 *
 * `agent/inbox/spliced` 是唯一能取到"会话第一条任务"的地方：它早于 `turn/start`，
 * 落不进任何一轮，逐轮规则永远看不到它（正文在 `data.inserted[].content`，不是
 * `data.content`）。读法与 milestones.ts 的 `initialTaskText` 保持一致——那里没有
 * 导出这个函数，而它所在的文件不在本次改动范围内，所以这里按同一形状复刻一份。
 *
 * @param events - 会话事件数组。
 * @returns 初始任务原话；取不到时为空串。
 */
function initialTaskText(events: readonly EventLike[]): string {
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const inserted = (event.data as { inserted?: unknown } | undefined)?.inserted
    if (!Array.isArray(inserted)) continue
    for (const item of inserted) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const source = (typeof entry.source === 'object' && entry.source !== null
        ? entry.source
        : {}) as Record<string, unknown>
      if (source.kind !== 'user' && entry.role !== 'user' && source.role !== 'user') continue
      const text = cleanUserText(contentToText(entry.content))
      if (text.length > 0) return text
    }
  }
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = (typeof event.data === 'object' && event.data !== null
      ? event.data
      : {}) as Record<string, unknown>
    const source = (typeof data.source === 'object' && data.source !== null
      ? data.source
      : {}) as Record<string, unknown>
    if (source.kind !== 'user') continue
    const text = cleanUserText(contentToText(messageBody(data)))
    if (text.length > 0) return text
  }
  return ''
}

/**
 * 会话任务标题：优先用骨架里那条「任务」里程碑，否则直接从事件流取第一句用户话。
 *
 * **为什么不能只看 `state.mainline[0].title`**：骨架要等 L1 溢出、提取跑过之后才有值，
 * 于是新会话的前几轮里注入块只剩「（本会话尚无可提取的里程碑）」——而任务在第 1 轮
 * 就已经写在日志里了。任务标题是整份骨架的锚点，它不该等到有溢出轮才出现。
 *
 * 认 `category === '任务'` 而不是"第一条"：初始任务取不到时（例如首句只有「继续」），
 * 骨架的第一条会是别的里程碑，直接拿它当任务行就是在编一个不存在的任务。
 *
 * @param session - 会话对象。
 * @param state - 会话状态（含最近一次提取的骨架）。
 * @returns 任务标题；都没有时 undefined。
 */
function taskTitleOf(session: unknown, state: SessionState): string | undefined {
  const first = state.mainline[0]
  if (first !== undefined && first.category === '任务') return first.title
  const text = initialTaskText(readEvents(session))
  if (text.length === 0) return undefined
  return text.length <= TASK_TITLE_MAX ? text : `${text.slice(0, TASK_TITLE_MAX - 1)}…`
}

/**
 * 把当前会话的三层读数喂给思维栏投影。
 *
 * 宿主是唯一计算点，客户端只读完整值、不做任何派生。注意"喂进来"不等于"立刻可见"：
 * 投影是事件驱动的，`apply` 要等到**下一个提交事件**才把这份读数折进状态并发布
 * （见 projection.ts）——pre-step 之后的下一个事件通常就在本轮内，所以延迟是"半轮"
 * 而不是"一轮"。会话刚打开、一个事件都还没提交时，由 {@link hydrateProjectionFeed}
 * 在框架折叠日志的过程中补上。
 *
 * @param input - 会话、状态、L1 窗口、L3 存储、配置与 recall 工具名。
 */
/**
 * 思维栏里一条 `constraint` 记录最多显示多少字符。
 *
 * 为什么是"截断"而不是"像 tool 记录一样整个不显示"：两者性质不同——tool 记录是
 * 原始输出（噪音大、没有固定结构，几十条几千字符会把主线淹掉），而 constraint 是
 * **人写下的规则原话**，短的几十字符、长的也就几千；面板正是"人核对记忆里有没有
 * 那条铁律"的地方，藏起来等于让这个检查面失效。
 *
 * 但正文原样给也不行：实测本会话 turn 1 的一条约束记录 9,270 字符，40 条记录合计
 * 5 万字符，面板会整屏都是它。所以只显示开头（足够认出"哪一轮、哪句规则"），
 * 全文仍只在 L3，用 recall 按 id 取回——面板是检查面，不是阅读器。
 */
const PANEL_CONSTRAINT_CHARS = 300

/** 面板标记：让读者知道这段不是全文，以及全文怎么拿。 */
const PANEL_CONSTRAINT_TAIL = '\n…（面板只显示开头；全文用 recall 按 id 取回）'

/**
 * 把 L3 记录转成"思维栏可展示"的列表。
 *
 * 两条规则：`tool` 记录整个不进（原始输出会淹掉主线）；`constraint` 记录进，但
 * 正文截到 {@link PANEL_CONSTRAINT_CHARS}。计数仍按整库报（`stats` 含两类细节），
 * 记录列表只是展示面的裁剪——**不改存储，也不改 recall**。
 *
 * @param records - 库里的全部记录。
 * @returns 面板用的记录列表。
 */
export function panelRecords(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  const out: MemoryRecord[] = []
  for (const record of records) {
    if (record.kind === 'tool') continue
    if (record.kind === 'constraint' && record.text.length > PANEL_CONSTRAINT_CHARS) {
      out.push({ ...record, text: `${record.text.slice(0, PANEL_CONSTRAINT_CHARS)}${PANEL_CONSTRAINT_TAIL}` })
      continue
    }
    out.push(record)
  }
  return out
}

function feedProjection(input: {
  projection: TriLayerProjection
  session: unknown
  state: SessionState
  window: { hot: readonly TurnSpan[]; evicted: readonly TurnSpan[] }
  store: DeepMemoryStore
  settings: TriLayerConfig
  recallTool: { name: string }
}): void {
  const { projection, session, state, window, store, settings, recallTool } = input
  // L3 读数取自本地库，而库是**异步**打开的（apply 里 `void store.open()`）：会话在
  // 打开完成之前就被发布/折叠时，读库可能抛错。这里退化成"未打开"的空读数，
  // 而不是让整条 feed 丢掉——L1/L2/骨架与思维栏都不依赖 L3。
  let stats: { backend: string | null; count: number; tokens: number } = { backend: null, count: 0, tokens: 0 }
  let records: readonly MemoryRecord[] = []
  try {
    stats = store.stats()
    // 展示面裁剪见 {@link panelRecords}：tool 记录整个不显示，constraint 只显示开头
    // （全文用 recall）。存储与 recall 的语义不受影响。
    records = panelRecords(store.all())
  } catch {
    // 读不到库只是 L3 段显示为空；L1/L2/骨架照常发布。
  }
  projection.feed(sessionIdOf(session), {
    taskTitle: taskTitleOf(session, state),
    mainline: state.mainline,
    l1: {
      retainTurns: settings.l1RetainTurns,
      turns: window.hot.length,
      evicted: window.evicted.length,
    },
    l2: state.digest === null
      ? null
      : {
          summary: state.digest.text,
          turnFrom: state.digest.turnFrom,
          turnTo: state.digest.turnTo,
          mode: settings.l2Mode,
        },
    // L3 是跨会话共享的一个库：条数与记录都按整库报，不按本会话过滤——
    // 思维栏要回答的是"我的深层记忆里有什么"，不是"这个会话写了多少"。
    l3: { backend: stats.backend, count: stats.count, tokens: stats.tokens, records },
    recallTool: recallTool.name,
  })
}

/**
 * 装配三层记忆压缩引擎。
 *
 * @param ctx - 插件上下文。
 * @param config - 组合行配置（`cordis.patch.yml` 中本插件行的 `config:`）。
 */
export function apply(ctx: unknown, config: unknown = {}): void {
  const context = ctx as HostContext

  // ── 1. 统一配置 ──────────────────────────────────────────────────────
  // 组合行配置即 base 层；settings 服务在场时由它接管，退场时自动回落到 base。
  const entry: TriLayerConfig = resolveConfig({ ...DEFAULTS, ...(config as Record<string, unknown> ?? {}) })
  let readSettings: () => TriLayerConfig = () => entry
  let settings: TriLayerConfig = entry

  context.inject(['settings'], (settingsCtx) => {
    void loadSettingsSchema().then((schema) => {
      if (schema === null) {
        context.logger.warn(
          '[dsh-tri-layer-memory] 设置面板不可用：宿主未提供 @deepseek-ai/schemastery（模块回退层缺失）。'
          + '三层记忆与模型工具不受影响；配置仍可写在 cordis.patch.yml 的本插件行 config: 里。',
        )
        return
      }
      settingsCtx.settings?.installSection(context, MEMORY_NAMESPACE, schema, entry, {
        setSource: (current: () => TriLayerConfig) => { readSettings = current },
        onChange: () => {
          settings = resolveConfig(readSettings())
        },
        validate: (value: TriLayerConfig) => { resolveConfig(value) },
      })
    }).catch(() => {
      // 上面的 loadSettingsSchema 已吞掉解析失败；这里只兜 promise 链本身的意外。
    })
  })

  // ── 1b. 思维栏数据通道（session projection）──────────────────────────
  // 「思维栏」= 对话/轨迹旁边的第三个标签页。宿主是唯一计算点：每轮 pre-step 把三层
  // 读数喂进投影，客户端只读 `useProjection('tri-layer-memory')` 的完整值。
  //
  // 与 settings 同样**软等待**：`sessionProjections` 缺席只是没有思维栏数据，L1/L2/L3
  // 与三个模型工具照常工作。它绝不能进 `exports.inject`——那是硬依赖，缺席会让 fiber
  // 永远停在 pending，宿主据此判定启动失败（见文件顶部 inject 的说明）。
  //
  // `hydrate` 是"打开会话就有内容"的那条路：框架第一次读投影时会 init + 逐事件折叠
  // 整份会话日志，而 feed 过去只由 pre-step 写——进程刚起来时表是空的，折出来就是
  // 空骨架。回调在那里按会话 id 补算一次（见 hydrateProjectionFeed）。
  //
  // 诊断（`<sessionId>.hydrate.json`）：补算这条链上的每一步过去都是静默的——
  // `apply` 里的 hydrate 调用被 catch 吞掉、早退全是裸 return、`ctx.get('sessions')`
  // 拿不到也只是 undefined。于是"思维栏空着"与"补算从没被调用过"在观察面上同形。
  // 轨迹按会话记，写到**独立文件**：`*.diagnostics.json` 只在 pre-step 落盘，
  // 而补算发生在 pre-step 之外（session/created、框架折叠），混在一起会互相覆盖。
  const traces = new Map<string, HydrateTrace>()
  /**
   * 注册段的事实是**进程级**的（不分会话），单独记一份，落盘时并进每条轨迹。
   *
   * 分开的理由：注册发生在任何会话出现之前；把它塞进某条会话轨迹里，那条轨迹就
   * 会同时描述"注册"和"某个会话的补算"两件事，而两者未必同时发生。
   */
  const registration: HydrateTrace['register'] = { injectRan: false, registryVia: 'none', calls: 0, error: null }
  /** 从载荷里直接捕获的活会话（不依赖任何服务，兜底补算的第三条路）。 */
  const capturedSessions = new Map<string, unknown>()
  const traceOf = (sessionId: string): HydrateTrace => {
    let trace = traces.get(sessionId)
    if (trace === undefined) {
      trace = newHydrateTrace(sessionId)
      traces.set(sessionId, trace)
      // 会话数无上限时别把内存吃光：先丢最早的那批（与 feed 表的 64 条同量级）。
      if (traces.size > MAX_TRACES) {
        const oldest = traces.keys().next()
        if (!oldest.done) traces.delete(oldest.value)
      }
    }
    return trace
  }
  /** 记住一个活会话对象（按 id），供按 id 补算时兜底。 */
  const captureSession = (session: unknown): void => {
    const id = sessionIdOf(session)
    if (id === 'unknown') return
    capturedSessions.delete(id)
    capturedSessions.set(id, session)
    if (capturedSessions.size > MAX_TRACES) {
      const oldest = capturedSessions.keys().next()
      if (!oldest.done) capturedSessions.delete(oldest.value)
    }
    traceOf(id).sessions.captured = capturedSessions.size
  }
  /** 上次写盘的内容，避免同一份轨迹反复落盘。 */
  const lastTraceText = new Map<string, string>()
  /** 已排队等待合并写盘的会话（见 observe 里的微任务）。 */
  const traceDirty = new Set<string>()
  /**
   * 落盘一条补算轨迹（内容没变就跳过）。
   * @param trace - 补算轨迹。
   */
  const writeHydrateTrace = (trace: HydrateTrace): void => {
    try {
      trace.updatedAt = new Date().toISOString()
      // 注册段是进程级事实，落盘时并进来：轨迹自己不该假装知道注册发生在何时。
      trace.register = { ...registration }
      trace.hydrate.feedLanded = projection.hasFeed(trace.sessionId)
      trace.blockedAt = hydrateBlockedAt(trace)
      const text = JSON.stringify(trace, null, 2) + '\n'
      if (lastTraceText.get(trace.sessionId) === text) return
      lastTraceText.set(trace.sessionId, text)
      // 与 diagnostics 同目录、同命名纪律：文件名必须绑死会话 id，否则最后跑过的
      // 会话会覆盖它（那个坑在 diagnostics.json 上已经踩过一次）。
      const safe = trace.sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown'
      writeFileSync(join(defaultStorageDir(settings.l3Dir), `${safe}.hydrate.json`), text)
    } catch {
      // 诊断落盘失败绝不能影响记忆层本身。
    }
  }

  const projection = createTriLayerProjection({
    hydrate: (sessionId) => { hydrateProjectionFeedById(sessionId) },
    derive: (sessionId, events) => deriveFeedInput(sessionId, events),
    observe: (sessionId, observation: ProjectionObservation) => {
      const trace = traceOf(sessionId)
      trace.fold.applies += 1
      if (observation.changed) trace.fold.changed += 1
      if (observation.hydrated) trace.fold.hydrated += 1
      // 折叠是**同步循环**（框架一次折几百上千个事件），逐个落盘会把诊断本身变成性能
      // 问题；而只在 hydrate 里落盘又会漏掉"折完了才更新"的计数（apply 的观察回调在
      // 补算之后）。折中：置脏 + 微任务里合并写一次——一次折叠一个文件。
      if (!traceDirty.has(sessionId)) {
        traceDirty.add(sessionId)
        queueMicrotask(() => {
          traceDirty.delete(sessionId)
          writeHydrateTrace(traceOf(sessionId))
        })
      }
    },
  })
  /** 注册表句柄（`session/created` 的补算与读路径探针共用）。 */
  let registryRef: { register: (definition: unknown) => () => void } | undefined
  /** 投影是否已注册（防止软等待回调与兜底注册各注册一次）。 */
  let registered = false
  /**
   * 注册投影单元（幂等；三条路共用）。
   *
   * **为什么不能只在软等待回调里注册**：`ctx.inject(['sessionProjections'], cb)` 走的是
   * 声明式注入解析，与服务同一条可见性规则（isolate 标签 / 提供方 fiber 状态）。
   * 那条路一旦不成立，投影就永远不会注册，客户端读到的 key 恒为"能力缺席"——
   * 而这条链上的其它部分（pre-step 注入、诊断落盘、三个工具）全都照常工作，
   * 于是症状只剩"思维栏空着"。兜底注册在 `session/created` 与 pre-step 上各试一次，
   * 这两处都是**必然会被调用**的钩子。
   *
   * @param via - 本次是从哪条路拿到的注册表（诊断用）。
   * @returns 注册表句柄；三条路都不通时为 undefined。
   */
  const ensureRegistered = (via: 'inject' | 'get' | 'prop'): { register: (definition: unknown) => () => void } | undefined => {
    let registry = registryRef
    if (registry === undefined) {
      try {
        registry = context.get?.('sessionProjections') as typeof registry
      } catch {
        // `ctx.get` 在异常上下文里可能抛（代理取值本身会抛）。兜底路径不该让整轮挂掉。
        registry = undefined
      }
    }
    if (registry === undefined) {
      try {
        registry = (context as { sessionProjections?: typeof registry }).sessionProjections
      } catch {
        registry = undefined
      }
    }
    if (registry === undefined) return undefined
    registryRef = registry
    if (registered) return registry
    registered = true
    registration.registryVia = via
    try {
      registry.register(projection.definition)
      registration.calls += 1
    } catch (error: unknown) {
      // 注册抛错（例如同名 key 的 stateVersion 冲突）必须留痕：它同样只是"空面板"。
      registered = false
      registration.error = error instanceof Error ? error.message : String(error)
      context.logger.warn('[dsh-tri-layer-memory] 思维栏投影注册失败：%s',
        error instanceof Error ? error.message : String(error))
      return undefined
    }
    return registry
  }
  context.inject(['sessionProjections'], (projectionCtx) => {
    const registry = projectionCtx.sessionProjections
    if (registry === undefined) return
    registryRef = registry
    registration.injectRan = true
    projectionCtx.effect(() => {
      ensureRegistered('inject')
      // 服务退场时允许重新注册：否则重载后 registered 恒为 true，投影再也回不来。
      return () => { registered = false }
    })
    // 变更广播探针：宿主会不会把本 key 的视图变化推给客户端，只有这里看得到。
    // 它不改变任何行为——控制流自己也会订阅同一份 onChanged（drive 只在
    // listeners 非空时算视图，多一个订阅者不改变计算结果）。
    try {
      projectionCtx.effect(() => registry.onChanged?.((session: unknown, key: string, _value: unknown, seq: number) => {
        if (key !== PROJECTION_KEY) return
        const trace = traceOf(sessionIdOf(session))
        trace.fold.broadcasts += 1
        trace.fold.lastBroadcastSeq = seq
      }))
    } catch {
      // onChanged 缺席（旧宿主）只损失一条诊断，不影响投影。
    }
  })

  // 会话**发布**（新建、恢复、fork）时立刻补算一次：这是浏览器读到投影之前，
  // 我们唯一能拿到活会话对象的确定时机（`session/created` 的载荷就是 Session）。
  // 恢复出来的会话也走这条路——它的日志在 announce 时已经装好了。
  //
  // **刻意注册在软等待回调之外**：补算只需要会话对象，不需要投影服务在场；
  // 放进回调里会让"服务不可见"连带把补算一起废掉（那正是上一版修法的失效方式）。
  context.on('session/created', (session: unknown) => {
    const trace = traceOf(sessionIdOf(session))
    trace.created.registered = true
    trace.created.fired += 1
    // "载荷是不是活 Session"必须单独记：补算只认能从载荷里读出日志的对象，
    // 载荷形状一变（例如变成 {id} 摘要而不是 Session 实例）整条补算就会静默失效。
    const target = session as { snapshotEvents?: unknown; events?: unknown } | null
    if (typeof target?.snapshotEvents === 'function' || Array.isArray(target?.events)) {
      trace.created.live += 1
    }
    captureSession(session)
    ensureRegistered('get')
    hydrateProjectionFeed(session, 'created')
  })
  // 会话离场即丢掉 feed：feed 表按会话 id 索引（字符串，不能用 WeakMap 回收），
  // 不丢的话死会话会占着 MAX_FEEDS 的名额，把活会话的 feed 挤出去。
  context.on('session/disposed', (session: unknown) => {
    const id = sessionIdOf(session)
    projection.forget(id)
    capturedSessions.delete(id)
    writeHydrateTrace(traceOf(id))
  })

  // ── 1c. llm seam（L2 摘要与 cause 回填共用的唯一模型通路）──────────────
  // **为什么不是直接 `ctx.get('llm')`**：`ctx.get` 读的是**根隔离表**里的那个符号，
  // 因此对"在某个 isolate 作用域里 provide 出来的服务"恒返回 undefined——本机
  // 实测 `ctx.get('compaction')` 就是 undefined（profile 的 cordis.yml 给
  // compaction-basic 那一组写了 `isolate: { compaction: true }`），而那个引擎
  // 明明在跑。属性代理（`ctx.llm`）走的是 fiber 链，没有这个偏差，但它要求
  // 硬依赖注入——写进 `exports.inject` 会让服务缺席时 fiber 永远 pending，
  // 宿主判定"有条目未激活"直接拒绝启动（踩过的致命事故）。
  //
  // 所以这里用 `ctx.inject(['llm'], cb)` **软等待**：服务来了就把 seam 存下来，
  // 不来插件照常 active（L2 退回抽取式，并在 memory_state 里写明原因）。
  // `ctx.get` 保留为兜底：两条路都试，并把**实际命中哪条**记进诊断。
  let injectedLlm: LlmSeam | undefined
  let injectedSeen = false
  context.inject(['llm'], (llmCtx) => {
    const seam = (llmCtx as { llm?: LlmSeam }).llm
    if (seam === undefined) return
    injectedLlm = seam
    injectedSeen = true
  })
  const llmSeam = (): { llm: LlmSeam | undefined; source: 'inject' | 'get' | 'none' } => {
    if (injectedLlm !== undefined) return { llm: injectedLlm, source: 'inject' }
    let viaGet: LlmSeam | undefined
    try {
      viaGet = context.get?.('llm') as LlmSeam | undefined
    } catch {
      // `ctx.get` 在异常上下文里可能抛（代理取值本身会抛）。兜底路径不该让整轮挂掉。
      viaGet = undefined
    }
    if (viaGet !== undefined) return { llm: viaGet, source: 'get' }
    return { llm: undefined, source: injectedSeen ? 'inject' : 'none' }
  }

  /**
   * 把诊断快照写进 L3 目录旁边的 `diagnostics.json`，只在内容变化时落盘。
   *
   * **为什么要有这个文件**：桌面端的宿主日志对使用者不可见（`%APPDATA%` 下只有崩溃
   * 日志），`memory_state` 又需要模型主动调用——结果就是"静默失败"没有任何观察面。
   * 这个插件已经栽过两次：`readEvents` 读错字段导致 L1/L2/骨架整段失效，L1 token
   * 估算把字符数当文本估而报出"约 2 tokens"。两次都因为看不到内部状态而藏了很久。
   */
  let lastDiagnostics = ''
  const writeDiagnostics = (state: SessionState, sessionId: string): void => {
    try {
      const snapshot = {
        sessionId,
        updatedAt: new Date().toISOString(),
        llmSeam: state.llmSource,
        l2: {
          mode: settings.l2Mode,
          via: state.digest?.via ?? null,
          // 「部分可用」与「完全失败」必须能分开读：`truncated=true` 表示这份 **llm**
          // 摘要撞过输出上限、按边界裁过但仍在用；`failure` 只在退回抽取式时有值。
          // 两者混在一起，观察面就会把"截断"读成"没走模型"，修法方向也就跟着错。
          truncated: state.digest?.attempt?.salvaged === true,
          failure: state.l2Failure,
          // 上一次调用的读数：终止原因、请求上限、输入大小、**丢弃前的正文字符数**、
          // provider 用量原样、推理档位与是否重试过。截断故障的定性全靠这一段。
          attempt: state.l2Attempt,
        },
        mainline: {
          enabled: settings.mainlineEnabled,
          milestones: state.mainline.length,
          causeFailure: state.causeFailure,
          // cause 回填的调用读数（与上面 L2 的 attempt 同形、同一个理由）：0 字符 +
          // `max-tokens` 指向"推理吃光预算"，0 字符 + `stop` 指向"模型真没说话"，
          // 两者的修法完全不同——没有这一段就只能靠猜。
          causeAttempt: state.causeAttempt,
        },
        // 这一轮**实际注入**的 token 记账。此前只有"调用花多少 / 骨架几条"，
        // 没有"灌进上下文多少"——压缩比因此无法自证（见 InjectionAccounting）。
        injection: state.injection,
      }
      const text = JSON.stringify(snapshot, null, 2) + '\n'
      if (text === lastDiagnostics) return
      lastDiagnostics = text
      // 文件名必须带 sessionId：曾经是全局单文件 `diagnostics.json`，于是**最后跑过的
      // 会话覆盖它**——排查本会话时读到的是另一个新会话的状态（`milestones: 1`、
      // `llmSeam: none`），差点据此去修一个不存在的问题。诊断数据必须和来源绑死。
      const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown'
      writeFileSync(join(defaultStorageDir(settings.l3Dir), `${safe}.diagnostics.json`), text)
    } catch {
      // 诊断落盘失败绝不能影响记忆层本身。
    }
  }

  // ── 2. L3 存储 ───────────────────────────────────────────────────────
  const dir = defaultStorageDir(settings.l3Dir)
  const store = new DeepMemoryStore(dir, settings.l3Store)
  let storeReady = false
  // 打开失败要留痕：memory_dedupe 在"还没打开"与"打开失败"两种情况下必须给不同的话，
  // 否则模型会一直重试一个永远不会就绪的后端（又是"看起来在工作"）。
  let storeError: string | null = null
  if (settings.l3Enabled) {
    void store.open()
      .then((kind) => {
        storeReady = true
        if (kind === 'jsonl' && settings.l3Store === 'sqlite') {
          context.logger.warn('[dsh-tri-layer-memory] 请求 sqlite 后端但 node:sqlite 不可用，已退回 JSONL')
        }
        context.logger.info('[dsh-tri-layer-memory] L3 后端就绪：%s，%d 条记录（%s）', kind, store.size, dir)
      })
      .catch((error: unknown) => {
        storeError = error instanceof Error ? error.message : String(error)
        context.logger.warn('[dsh-tri-layer-memory] L3 后端打开失败（记忆层降级为 L1+L2）：%s', storeError)
      })
  }

  /**
   * 全量骨架快照：`<sessionId>.mainline.json`。
   *
   * **为什么要有这个文件**：注入里的骨架是**展示产物**——信息量剪枝删行、条数上限
   * 裁掉旧行、cause 被剥掉。用户的原则是"展示可以有损、存储不能有损"，而 L3 里
   * 存的是**一条一条的 milestone 记录**（可 recall，但不好人读"这一轮的主体是什么"）。
   * 快照把**未剪枝的完整骨架**整份留在本地，附上三份剪枝清单（被整条删的、被剥
   * cause 的、被移出注入的）与每条是否确认落库，供人工/工具复查。
   *
   * 它绝不进注入（不在任何 read/注入路径上），也不参与任何决策——只写不读。
   * 内容不变就不重写：每轮 pre-step 都会走到这里，无条件写盘等于用几 KB 的同步 IO
   * 换一个没人看的文件。
   */
  let lastMainlineSnapshot = ''
  const writeMainlineSnapshot = (input: { sessionId: string; state: SessionState; fit: MainlineFit }): void => {
    try {
      const { sessionId, state, fit } = input
      const brief = (m: Milestone): Record<string, unknown> => ({
        turn: m.turn,
        turnTo: m.turnTo ?? m.turn,
        title: m.title,
        cause: m.cause,
        category: m.category,
        tokens: m.tokens,
        stored: state.mainlineStored.has(causeCacheKey(m)),
      })
      const snapshot = {
        schema: 1,
        sessionId,
        updatedAt: new Date().toISOString(),
        note: '注入会剪枝（展示有损）；这里是未剪枝的全量骨架 + 剪枝清单（存储无损）。'
          + '更早的条目在 L3 的 milestone 记录里，可用 memory_recall 按「第 N 轮」取回。',
        totals: {
          milestones: state.mainline.length,
          injected: fit.kept,
          dropped: fit.dropped,
          infoPruned: fit.infoPruned,
          causeStripped: fit.causeStripped,
          boundaryKept: fit.boundaryKept,
          earlier: fit.earlier.length,
          stored: state.mainline.length === 0
            ? 0
            : state.mainline.filter((m) => state.mainlineStored.has(causeCacheKey(m))).length,
        },
        milestones: state.mainline.map((m) => ({ ...brief(m), line: milestoneLine(m) })),
        earlier: fit.earlier.map(brief),
        infoDropped: fit.infoDropped.map(brief),
        causeStripped: fit.causeStrippedList.map(brief),
      }
      const text = JSON.stringify(snapshot, null, 2) + '\n'
      if (text === lastMainlineSnapshot) return
      lastMainlineSnapshot = text
      const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown'
      writeFileSync(join(dir, `${safe}.mainline.json`), text)
    } catch {
      // 快照只是给人和工具复查的旁路；它失败不能影响注入，更不能拖垮这一轮。
    }
  }

  const sessions = new WeakMap<object, SessionState>()
  const stateOf = (session: unknown): SessionState => {
    const key = (typeof session === 'object' && session !== null ? session : {}) as object
    let state = sessions.get(key)
    if (state === undefined) {
      state = {
        digest: null,
        lastDigestAt: 0,
        l3HighWaterTurn: -1,
        l3WatermarkSeeded: false,
        lastInjected: null,
        lastArbitration: null,
        injection: null,
        mainlineWaterMark: -1,
        mainline: [],
        mainlineCauses: new Map(),
        mainlineStored: new Set(),
        mainlineRecordIds: new Map(),
        boundaryBackfillDone: false,
        l2Failure: null,
        l2Attempt: null,
        llmSource: 'none',
        causeFailure: null,
        causeAttempt: null,
      }
      sessions.set(key, state)
    }
    return state
  }

  // ── 3. recall 工具名仲裁（必须在注册前决定）──────────────────────────
  const recallTool = resolveRecallToolName(context as never, settings.recallToolName)
  if (recallTool.name !== 'memory_recall') {
    context.logger.info('[dsh-tri-layer-memory] recall 工具命名为 %s（%s）', recallTool.name, recallTool.reason)
  }

  // ── 4. 运行时（工具通过这个窄接口访问各层）──────────────────────────
  const runtime: MemoryRuntime = {
    ctx: context as never,
    config: () => ({
      recall: { defaultLimit: settings.recallDefaultLimit, maxLimit: settings.recallMaxLimit },
      l2: { inject: settings.l2Inject },
      l3: { dir, enabled: settings.l3Enabled },
    }),
    recallTool: () => recallTool,
    search: (query, limit) => store.search(query, limit),
    get: (id) => store.get(id),
    stats: () => store.stats(),
    digestText: (session) => stateOf(session).digest?.text ?? null,
    readings: (session) => {
      const state = stateOf(session)
      const window = projectWorkingWindow(readEvents(session), settings.l1RetainTurns)
      const covered = state.digest === null ? null : `turn ${state.digest.turnFrom}–${state.digest.turnTo}`
      const pending = state.digest === null
        ? window.evicted.length
        : window.evicted.filter((span) => span.turn > (state.digest as DigestResult).turnTo).length
      const stats = store.stats()
      // 本会话口径：L3 是跨会话共享的一个库，整库数字回答不了"这个会话写了多少"。
      // 记录自带 sessionId，扫一遍即可（memory_state 是低频调用，这点代价换掉一个
      // 会被误读的口径，值）。
      const readingsSessionId = sessionIdOf(session)
      let sessionCount = 0
      let sessionTokens = 0
      for (const record of store.all()) {
        if (record.sessionId !== readingsSessionId) continue
        sessionCount += 1
        sessionTokens += record.tokens
      }
      // 重复读数：只在 memory_state / memory_verify 这类低频调用里扫（O(n) 一次，
      // 不排序）。不要挪进 store.stats()——那个每轮投影都会调用一次。
      const duplicates = store.duplicateSummary()
      return {
        l1: {
          retainTurns: settings.l1RetainTurns,
          hotTurns: window.hot.length,
          totalTurns: window.totalTurns,
          evictedTurns: window.evicted.length,
          // 由各轮 tokens 累加而来（对真实文本估算）。曾经这里写成
          // `estimateTokens(String(window.charCount))`——把字符数当字符串估 token，
          // 52 万字符的窗口被报成"约 2 tokens"，偏差好几个数量级。
          tokens: window.tokens,
          charCount: window.charCount,
        },
        l2: {
          enabled: settings.l2Mode !== 'off',
          mode: settings.l2Mode,
          covered,
          tokens: state.digest?.tokens ?? 0,
          via: state.digest?.via ?? null,
          pendingTurns: pending,
          // 本该走模型却退回抽取式的原因。`via === 'extractive' && mode === 'llm'`
          // 时这里必有值——观察面（memory_state）因此能直接回答"为什么不是 LLM"。
          failure: state.l2Failure,
          // 这份摘要被截过但仍在用（不是失败，但也别当成完整摘要）。
          truncated: state.digest?.attempt?.salvaged === true,
          // 上一次调用的读数。`attempt.outputChars` 是"模型到底写了多少"的唯一依据：
          // 撞上限时 `outputChars === 0` = 推理吃光了预算；`outputChars` 很大 =
          // 模型真的写太长。两种根因的修法不同，所以这个数字必须报出来。
          attempt: state.l2Attempt,
          // seam 是从哪条路拿到的：inject（软等待，首选）/ get（兜底）/ none。
          // 排查"服务明明在、插件却拿不到"时，这一个字段就能定性。
          llmSource: state.llmSource,
        },
        l3: {
          enabled: settings.l3Enabled,
          backend: stats.backend,
          // 两个口径都给：L3 是**跨会话共享**的一个库，只报整库时"库里有 445 条"
          // 会被读成"这个会话写了 445 条"（用户报过这个口径问题）。字段名自己说明
          // 口径，比在注释里解释更可靠——memory_state 是给模型看的。
          libraryCount: stats.count,
          libraryTokens: stats.tokens,
          // 工具细节池单独报：它不进 `l3MaxRecords`，混在整库里读会让"主内容多大"
          // 这个数字随工具输出漂移。memory_state 要能分别回答两个问题。
          toolCount: stats.tools,
          toolTokens: stats.toolTokens,
          // 约束池同理，单独报：它和工具池是两个独立上限，合并读会让"主内容多大"
          // 同时被两类细节干扰。memory_state 是唯一能分别回答"约束存了多少"的出口。
          constraintCount: stats.constraints,
          constraintTokens: stats.constraintTokens,
          sessionCount,
          sessionTokens,
          dir,
          // 「库里有垃圾」唯一的观察面：组数 + 可删条数（+ 正文不一致的组数）。
          duplicateGroups: duplicates.groups,
          duplicateRecords: duplicates.records,
          duplicateDifferingGroups: duplicates.differingGroups,
        },
        injection: {
          budgetTokens: settings.injectionBudgetTokens,
          // `usedTokens` 只覆盖**仲裁层**（L1/L2/L3）；骨架不进仲裁（见 budget.ts 的
          // fitMainline），但它确实注入。只报前者会让"本轮投影用了多少"偏小，而读数
          // 偏小的代价和缺字段一样：压缩比会虚高。所以把两个口径都给出来。
          usedTokens: state.lastArbitration?.tokens ?? 0,
          requestedTokens: state.lastArbitration?.requestedTokens ?? 0,
          dropped: state.lastArbitration?.dropped ?? [],
          truncated: state.lastArbitration?.truncated ?? [],
          /** 含骨架的实际注入合计（与诊断文件的 injection.totalInjected 同源）。 */
          totalInjected: state.injection?.totalInjected ?? 0,
          /** 骨架块的渲染后 token（独立于仲裁预算）。 */
          mainlineTokens: state.injection?.mainlineTokens ?? 0,
        },
        recallTool,
        // 骨架 cause 回填的失败原因。放在这里（而不是塞进 L2 段）是因为它属于
        // 主线骨架，语义上不该混进短期记忆；memory_state 会把这一段原样带出去。
        mainline: {
          enabled: settings.mainlineEnabled,
          milestones: state.mainline.length,
          pendingCauses: missingCauses(state.mainline, state.mainlineCauses).length,
          causeFailure: state.causeFailure,
          // 与 L2 的 `attempt` 同形：终止原因、请求上限、输入大小、**丢弃前的正文字符数**、
          // provider 用量、推理档位与是否重试过。cause 回填"看起来在工作、实际没工作"
          // 的唯一可靠出口就是这一段（宿主日志在桌面端不可见）。
          causeAttempt: state.causeAttempt,
        },
      }
    },
    prune: (session): PruneOutcome => {
      const window = projectWorkingWindow(readEvents(session), settings.l1RetainTurns)
      return store.prune(
        taskKeywords(window),
        settings.l3PruneMinScore,
        settings.l3MaxRecords,
        Date.now(),
        {
          // 工具池**独立**于 l3MaxRecords：主内容池的上限与剪枝结果不因工具记录而改变。
          maxRecords: settings.l3ToolMaxRecords,
          maxPerSession: settings.l3ToolMaxPerSession,
        },
        {
          // 约束池同样独立，但保留规则不同：按约束强度保留（早期铁律不会被新记录挤掉）。
          maxRecords: settings.l3ConstraintMaxRecords,
          maxPerSession: settings.l3ConstraintMaxPerSession,
        },
      )
    },
    dedupe: (input) => {
      // 宁可明确报错，也不要返回"removed: 0"——那会被读成"库是干净的"。
      if (!settings.l3Enabled) {
        throw new Error('L3 已关闭（l3.enabled=false），没有可去重的库；本次未改动任何文件。')
      }
      if (store.backendKind === null) {
        throw new Error(storeError === null
          ? 'L3 后端仍在打开中（store 尚未就绪），本次未改动任何文件；请稍后重试。'
          : `L3 后端打开失败：${storeError}；本次未改动任何文件。`)
      }
      // 唯一写入者就是这里：改 store 的内存快照，再由 store 自己的后端 replace 落盘。
      return store.dedupe(input)
    },
    expectedEngine: () => settings.integrationEngine,
    lastProjection: (session) => stateOf(session).lastInjected,
  }

  // ── 5. 静态系统提示段 ────────────────────────────────────────────────
  context.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(() => {
      try {
        return promptCtx.systemPrompt.section({ name, order: 40, text: POLICY_SECTION })
      } catch (error: unknown) {
        // 同一层重复注册同名 section 会抛错（例如插件被挂载两次）。丢掉这段
        // 静态说明只损失一段提示词；动态投影仍会带出同样的信息。
        context.logger.warn('[dsh-tri-layer-memory] 系统提示段注册失败（跳过）：%s',
          error instanceof Error ? error.message : String(error))
        return () => {}
      }
    })
  })

  // ── 6. 每轮动态注入（三层投影）───────────────────────────────────────
  /**
   * 冷读兜底：用**折叠过程中累积到的事件**自己算一份读数。
   *
   * **这是本次故障的根因补丁**。客户端打开一个已存在的会话时，宿主走 session-query
   * 的 prepared 路径：`sessions.prepare(...)` 造一个**还没发布**的 Session，再
   * `registry.restore(checkpoint, events, 0, …)` 折整份日志取投影值——客户端拿到的
   * 第一帧就是这份值。那一刻：
   * - `session/created` 还没发（发布在第一帧之后，见 history.ts 的 promote）；
   * - `sessions.get(id)` 拿不到 prepared 会话（`prepare` 的语义就是不进活表）；
   * 所以"按 id 找回活会话再补算"在**这个时刻必然失败**，而 feed 表是空的（新进程
   * 一次 pre-step 都没跑过）→ 折出来 `updatedAt: 0` → 面板"尚未就绪"。
   * 事件是 `apply` 唯一拿得到的东西，因此也是该时刻唯一可用的数据源。
   *
   * 派生的读数**如实缺 L2**：摘要是模型产物、只活在会话状态里，新进程还没生成它。
   * 面板显示"尚无摘要"是诚实的，编一份出来才是骗人。
   *
   * @param sessionId - 正在折叠的会话 id。
   * @param events - 累积到的事件（按 seq 升序）。
   * @returns 一份可喂进投影的读数；算不出时为 null。
   */
  function deriveFeedInput(sessionId: string, events: readonly unknown[]): TriLayerFeedInput | null {
    const trace = traceOf(sessionId)
    try {
      const list = events as EventLike[]
      if (list.length === 0) return null
      const window = projectWorkingWindow(list, settings.l1RetainTurns)
      const mainline = settings.mainlineEnabled ? extractMilestones(list) : []
      // L3 读数是本地库的口径，与"哪条路算出来的"无关；库读不到就退化成空读数。
      let stats: { backend: string | null; count: number; tokens: number } = { backend: null, count: 0, tokens: 0 }
      let records: readonly MemoryRecord[] = []
      try {
        stats = store.stats()
        // 与 feedProjection 同口径：tool 记录不进面板，constraint 只显示开头。
        records = panelRecords(store.all())
      } catch {
        // 读不到库只是 L3 段为空，L1/骨架照常发布。
      }
      trace.fold.derived += 1
      return {
        taskTitle: derivedTaskTitle(list, mainline),
        mainline,
        l1: {
          retainTurns: settings.l1RetainTurns,
          turns: window.hot.length,
          evicted: window.evicted.length,
        },
        l2: null,
        l3: { backend: stats.backend, count: stats.count, tokens: stats.tokens, records },
        recallTool: recallTool.name,
      }
    } catch (error: unknown) {
      // 派生失败只是这次没有内容（按状态渲染，与派生之前一致），但必须留痕。
      trace.fold.deriveError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  /**
   * 从事件流推任务标题（与 {@link taskTitleOf} 同口径，但不依赖会话状态对象）。
   *
   * @param events - 会话事件数组。
   * @param mainline - 已提取的骨架（优先用其中那条「任务」）。
   * @returns 任务标题；取不到时为 null。
   */
  function derivedTaskTitle(events: readonly EventLike[], mainline: readonly Milestone[]): string | null {
    const first = mainline[0]
    if (first !== undefined && first.category === '任务') return first.title
    const text = initialTaskText(events)
    if (text.length === 0) return null
    return text.length <= TASK_TITLE_MAX ? text : `${text.slice(0, TASK_TITLE_MAX - 1)}…`
  }

  /**
   * 读路径探针：注册表里本会话现在是什么状态（`stateOf`），以及宿主会发给客户端
   * 的那份值长什么样（`snapshot`）。每个会话只探一次。
   *
   * **为什么必须探**：客户端显示"尚未就绪"的判据是它收到的值 `updatedAt === 0`，
   * 而那个值来自宿主的快照 / 落盘检查点行。只看我们自己的 feed 表回答不了
   * "客户端为什么不显示"——feed 有内容但没折进状态、状态有内容但快照抛错、
   * 状态停在上一份过期行，三者都会得到同一块空面板。
   *
   * @param session - 活会话对象。
   * @param trace - 该会话的补算轨迹。
   */
  function probeProjectionReadFace(session: unknown, trace: HydrateTrace): void {
    if (trace.fold.probed) return
    const registry = registryRef
    // 注册表还没拿到就先不探（而不是把 probed 置位后永远不探）：注册兜底可能在后一轮
    // 才成功，那时才是有意义的观察点。
    if (registry === undefined) return
    trace.fold.probed = true
    const reader = registry as {
      stateOf?: (s: unknown, key: string) => unknown
      snapshot?: (s: unknown, keys?: string[]) => { values?: Record<string, unknown> }
    }
    try {
      const state = reader.stateOf?.(session, PROJECTION_KEY) as
        | { rev?: unknown; updatedAt?: unknown; mainline?: unknown }
        | undefined
      trace.fold.stateRegistered = state !== undefined
      if (state !== undefined) {
        if (typeof state.rev === 'number') trace.fold.stateRev = state.rev
        if (typeof state.updatedAt === 'number') trace.fold.stateUpdatedAt = state.updatedAt
        if (Array.isArray(state.mainline)) trace.fold.stateMainline = state.mainline.length
      }
    } catch (error: unknown) {
      // stateOf 抛错本身就是重要证据：它跑在框架的读路径上。
      trace.fold.servedError = `stateOf: ${error instanceof Error ? error.message : String(error)}`
    }
    try {
      const snapshot = reader.snapshot?.(session, [PROJECTION_KEY])
      const value = snapshot?.values?.[PROJECTION_KEY] as { updatedAt?: unknown } | undefined
      if (value !== undefined && typeof value.updatedAt === 'number') {
        trace.fold.servedUpdatedAt = value.updatedAt
      }
    } catch (error: unknown) {
      const message = `snapshot: ${error instanceof Error ? error.message : String(error)}`
      trace.fold.servedError = trace.fold.servedError === null ? message : `${trace.fold.servedError}; ${message}`
    }
  }

  /**
   * 立刻算一遍某个会话的三层读数并喂进投影（"打开会话就有内容"）。
   *
   * **为什么需要它**：feed 过去只在 `agent/pre-step` 里写。进程刚起来时一次都没跑过，
   * 而框架**第一次读**投影时是 `init` + 逐事件 `apply` 折叠整份会话日志
   * （session-projection 的 buildCell/advanceCell）——折的是 feed 表，表是空的，
   * 于是用户打开 DSH 看到的是"记忆层尚未就绪"，要跑完一轮才补上。这个函数在
   * `session/created` 与折叠兜底里各被调用一次，把"跑完一轮才会算的东西"提前到
   * 打开会话时算。
   *
   * 骨架这里刻意**不走 `refreshMainline`**，而是自己提取：那条路会推进
   * `mainlineWaterMark` 水位，而 pre-step 只在"水位变了"时才提取并补因果（LLM 调用）。
   * 提前推进水位会让第一轮跳过 cause 回填，骨架从此停在确定性标签上——同一份骨架
   * 在 L3 里（已经补过因果的那份）和思维栏里会长成两个样子。所以这里只读地填一次
   * `state.mainline`，水位留给第一轮 pre-step 照常推进。
   *
   * **每一次调用与归宿都记进轨迹**：失败过去被一个静默 `catch {}` 吃掉，"补算抛错"
   * 与"补算没被调用过"因此长得一模一样——这正是这次故障查不动的直接原因。
   *
   * @param session - 活会话对象；空日志（新会话、子代理会话）直接跳过。
   * @param path - 本次是从哪条路来的（诊断用：created / byId:… / pre-step）。
   */
  function hydrateProjectionFeed(session: unknown, path: string): void {
    const trace = traceOf(sessionIdOf(session))
    trace.hydrate.calls += 1
    trace.hydrate.byPath[path] = (trace.hydrate.byPath[path] ?? 0) + 1
    try {
      const events = readEvents(session)
      // 空日志没有任何可显示的东西：新会话与子代理会话不该为一份空读数付 store 扫描
      // 与骨架提取的代价。
      if (events.length === 0) {
        trace.hydrate.emptyLog += 1
        if (path === 'created') trace.created.emptyLog += 1
        return
      }
      const state = stateOf(session)
      const window = projectWorkingWindow(events, settings.l1RetainTurns)
      if (settings.mainlineEnabled && state.mainline.length === 0) {
        state.mainline = extractMilestones(events)
        // cause 缓存是进程内的：刚启动时它是空的，这一行贴不回任何东西。留着是为了
        // 与 refreshMainline 同形——同一份状态，两条路都不该漏掉"把补过的因果贴回去"。
        attachCauses(state.mainline, state.mainlineCauses)
      }
      feedProjection({ projection, session, state, window, store, settings, recallTool })
      trace.hydrate.fed += 1
      probeProjectionReadFace(session, trace)
    } catch (error: unknown) {
      // 补算失败只是思维栏暂时没有内容；绝不能影响会话发布，也绝不能打断框架的折叠。
      // 但**必须留痕**：异常原文是判断"哪一步断的"的唯一依据。
      trace.hydrate.threw.push({ path, message: error instanceof Error ? error.message : String(error) })
    } finally {
      writeHydrateTrace(trace)
    }
  }

  /**
   * 按会话 id 补算（框架折叠时我们只有状态里的 id）。
   *
   * **三条路，按"离服务有多远"排序**，每条都记归宿：
   * 1. `ctx.get('sessions')` —— 读的是 isolate 标签表，服务在别的隔离域里时恒 undefined；
   * 2. `ctx.sessions`（属性代理）—— 沿 fiber 链走，可见性规则与 1 **不同**，
   *    一条不通不代表另一条不通（本机实测 `ctx.get('compaction')` 恒 undefined，
   *    而那个引擎明明在跑）；
   * 3. 从 `session/created` 与 pre-step 载荷里直接捕获的活会话 —— **不依赖任何服务**，
   *    是前两条都不通时唯一还能工作的那条。
   *
   * 三条都不通就只是补算不了——插件照常 active，投影照常注册（`sessions` 绝不进
   * `exports.inject`，见文件顶部说明），但原因会写进轨迹。
   *
   * @param sessionId - 状态里记着的会话 id。
   */
  function hydrateProjectionFeedById(sessionId: string): void {
    const trace = traceOf(sessionId)
    let live: unknown
    let path = 'byId:unresolved'
    try {
      const service = context.get?.('sessions') as { get?: (id: string) => unknown } | undefined
      trace.sessions.service = service === undefined ? 'undefined' : 'ok'
      if (service !== undefined) {
        live = service.get?.(sessionId)
        trace.sessions.lookup = live === undefined ? 'undefined' : 'found'
        if (live !== undefined) path = 'byId:sessions'
      }
    } catch (error: unknown) {
      // `ctx.get` 在异常上下文里可能抛（代理取值本身会抛）。兜底路径不该让折叠挂掉。
      trace.sessions.service = 'threw'
      trace.sessions.serviceError = error instanceof Error ? error.message : String(error)
    }
    if (live === undefined) {
      try {
        const viaProp = (context as { sessions?: { get?: (id: string) => unknown } }).sessions
        if (viaProp !== undefined) {
          live = viaProp.get?.(sessionId)
          if (live !== undefined) path = 'byId:prop'
        }
      } catch (error: unknown) {
        trace.sessions.lookupError = `prop: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (live === undefined) {
      const captured = capturedSessions.get(sessionId)
      if (captured !== undefined) {
        live = captured
        path = 'byId:capture'
      }
    }
    if (live === undefined) {
      trace.hydrate.calls += 1
      trace.hydrate.byPath[path] = (trace.hydrate.byPath[path] ?? 0) + 1
      trace.hydrate.sessionMissing += 1
      writeHydrateTrace(trace)
      return
    }
    hydrateProjectionFeed(live, path)
  }

  context.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    try {
      const session = payload?.agent?.session
      // pre-step 是**必然会被调用**的钩子：注册兜底、活会话捕获、读路径探针都挂在这里。
      // 投影服务因为可见性问题没等到、`session/created` 在监听注册之前就发完了，
      // 这两种情况都只能靠这条必然路径补回来。
      const trace = traceOf(sessionIdOf(session))
      captureSession(session)
      ensureRegistered('get')
      const state = stateOf(session)
      // 本轮用户消息要到本钩子**返回之后**才被 append 进事件数组（顺序是
      // turn/start → step/start → 本钩子 → user/message）。不把载荷里的本轮输入
      // 传进窗口，补足循环就会把当前空轮当成缺口、多往前拉一个 turn：实测 11 个
      // turn 的首条投影写成"窗口内 9 个 turn"，同轮第二条才自我修正成 8 个——
      // 而首条才是注入给模型的那条。传进去后首条与第二条读数一致。
      const window = projectWorkingWindow(
        readEvents(session),
        settings.l1RetainTurns,
        pendingWindowInput(payload) ?? undefined,
      )
      // seam 只解析一次、本轮共用：L2 摘要与 cause 回填走的是同一条通路，
      // 两处各自解析只会让"一条通、另一条不通"这种偏差更难发现。
      const seam = llmSeam()

      await refreshDigest({ state, window, payload, storeReady, store, settings, context, seam })
      // 骨架的提取放在 L3 蒸馏之后：里程碑的 refs 要指向**已存在**的细节记录，
      // 先蒸馏再提取，新溢出的那几轮的 turn 记录才赶得上被引用。
      const extracted = refreshMainline({ state, window, session: payload?.agent?.session, storeReady, store, settings })
      // 因果补全是**独立、节流、可降级**的一步：只在骨架真的变了的时候考虑，而且自己
      // 吞掉全部失败（它抛出去会被外层的 catch 接住，那会连带跳过这一轮的整个投影）。
      if (extracted) {
        // **等一小段，但不等到跑完**。宿主路由带 `reasoningEffort: "max"`，一次 cause
        // 调用可能跑十几秒——完整 await 等于拖慢用户每一轮对话。
        // 折中：快返回的调用（含测试里的假 seam）当场把 cause 填好，于是本轮投影就能
        // 带上因果；超过 CAUSE_INLINE_WAIT_MS 的慢调用转入后台，结果落在下一轮。
        // 两条路都不丢结果，也不阻塞对话。
        const pending = refreshMainlineCauses({
          state,
          session: payload?.agent?.session,
          storeReady,
          store,
          settings,
          context,
          agent: payload?.agent,
          signal: payload?.signal,
          seam,
        }).catch(() => { /* refreshMainlineCauses 自己记原因；这里只是兜底不让它逃逸 */ })
        await Promise.race([
          pending,
          new Promise((resolve) => { setTimeout(resolve, CAUSE_INLINE_WAIT_MS) }),
        ])
      }

      // 任务标题在第 1 轮就已经写在日志里，不该等骨架提取跑过才有值（见 taskTitleOf）。
      const taskTitle = taskTitleOf(session, state)
      // 第一次诊断落盘：L2 / 骨架 / cause 三条路都已跑完，原因字段都已确定。
      // 刻意在注入逻辑之前——注入可能因"内容没变"提前返回，而诊断不该被一起跳过。
      // 注入读数（injection）此刻还没有，由注入之后的那次补写（见下方 writeDiagnostics），
      // 于是这个文件同时满足两件事：失败原因不因注入异常而丢，注入数字又能落盘。
      writeDiagnostics(state, sessionIdOf(session))
      // 思维栏：把刚刷新的三层读数喂给投影。刻意放在注入逻辑之前——注入可能因为
      // "内容没变"提前返回，而思维栏是给人看的检查面，不该跟着注入一起被跳过。
      feedProjection({ projection, session, state, window, store, settings, recallTool })
      // 读路径探针（每个会话只探一次）与轨迹落盘：回答"客户端到底会收到什么"。
      // 放在 feed 之后，这样探到的是刚刚这份读数。
      probeProjectionReadFace(session, trace)
      writeHydrateTrace(trace)

      const candidates: InjectionBlock[] = []
      const l1 = renderWorkingMemory(window, settings.l1Inject)
      if (l1 !== null) candidates.push({ id: 'l1', text: l1, priority: 0, truncatable: false })
      if (settings.l2Inject) {
        const pending = state.digest === null
          ? window.evicted.length
          : window.evicted.filter((span) => span.turn > (state.digest as DigestResult).turnTo).length
        candidates.push({
          id: 'l2',
          text: renderShortTermMemory(state.digest, pending),
          priority: 1,
          truncatable: true,
          // L2 的截断说明与 L3 不同：摘要正文**不在 L3 里**（当前摘要只活在会话状态里，
          // 被新摘要取代时才落库），所以取回它必须点名 `includeDigest: true`。这条说明
          // 比默认那条更短——预算最紧时（实测 200 tokens）截断说明的长度直接决定
          // "还能留一段摘要"还是"整块丢弃"，措辞不能比它替换掉的那条更贵。
          truncationNote: L2_TRUNCATION_NOTE,
        })
      }
      if (settings.l3InjectIndex && settings.l3Enabled) {
        // L3 索引有**保底**：完整形态放不下时退到一行（见 budget.ts 的 pinned/floorText）。
        // 只有库里有记录时才 pin：空库的索引对模型没有行动价值，不值得占保底额度。
        const l3Stats = store.stats()
        candidates.push({
          id: 'l3',
          text: renderDeepIndex(l3Stats, taskKeywords(window), recallTool.name, vaultNote(context)),
          priority: 2,
          truncatable: true,
          ...(l3Stats.count > 0
            ? { pinned: true, floorText: renderDeepIndexFloor(l3Stats.count, recallTool.name) }
            : {}),
        })
      }

      // 统一预算仲裁：多注入方共存时由本插件按优先级分配，而不是各自往上下文里塞。
      const arbitration = arbitrateInjection(candidates, settings.injectionBudgetTokens)
      state.lastArbitration = arbitration

      // 骨架**不进仲裁**：它单独渲染、单独限额（理由见 budget.ts 的 fitMainline），
      // 位置固定在 L1 之后、L2 之前——先声明"哪一段是可信原文"，再给整条主线，
      // 然后才是滚动摘要与 L3 索引。
      //
      // `earlierStored` 逐条核对而不是按配置猜：展示分层会在骨架末尾写一行
      // "更早 N 条已存入 L3，用 recall 取回"。只有**当前这份骨架里每一条**都确认
      // 落库（`state.mainlineStored` 由 refreshMainline 写入成功后才填），那行提示
      // 才不会把模型引向一个不存在的记录。
      const mainline = settings.mainlineEnabled && settings.mainlineInject
        ? fitMainline(state.mainline, taskTitle, settings.mainlineMaxTokens, settings.mainlineMaxMilestones, {
          earlierStored: state.mainline.length > 0
            && state.mainline.every((milestone) => state.mainlineStored.has(causeCacheKey(milestone))),
          recallName: recallTool.name,
        })
        : null
      const blocks = arbitration.kept.map((block) => block.text)
      if (mainline !== null) {
        const afterL1 = arbitration.kept.findIndex((block) => block.id === 'l1')
        blocks.splice(afterL1 < 0 ? 0 : afterL1 + 1, 0, mainline.text)
      }
      if (blocks.length === 0) return decision

      // 头部行与 l1-working 的识别判据**共用同一个常量**：写两份字面量时，改一处
      // 忘了另一处，识别就会静默失效——投影会被重新算进 L1 窗口，而所有读数看起来正常。
      const text = `${PROJECTION_HEADER}\n\n${blocks.join('\n\n')}`
      // 内容未变则不重复注入：省 token，也避免同一份投影在 surface 里堆积。
      if (text === state.lastInjected) return decision
      state.lastInjected = text

      // ── 注入量记账（必须放在仲裁与 fitMainline **之后**）────────────────
      // 量的是"实际进投影的文本"：L2/L3 若被预算截断，按截断后的文本算；骨架若被
      // fitMainline 裁掉最旧的几条，按裁剪后的渲染文本算。若在仲裁之前量，得到的
      // 就是"打算注入多少"——那正是这次要修的那类看起来合理的假读数。
      const blockTokens = (id: 'l1' | 'l2' | 'l3'): number => {
        const kept = arbitration.kept.find((block) => block.id === id)
        return kept === undefined ? 0 : estimateTokens(kept.text)
      }
      const accounting: InjectionAccounting = {
        l1Tokens: blockTokens('l1'),
        l2Tokens: blockTokens('l2'),
        l3Tokens: blockTokens('l3'),
        // 骨架走独立上限、不进仲裁，但确实是注入的一部分。`fitMainline.tokens`
        // 已是渲染后实测值，直接用它，避免在这里第二次估算出第二种口径。
        mainlineTokens: mainline === null ? 0 : mainline.tokens,
        // 先占位再算合计：让"四项之和 = 合计"在下一行就成立，读代码的人不必去别处找。
        totalInjected: 0,
        budgetTokens: arbitration.budgetTokens,
        // 整块丢弃的才是 dropped；被截断但仍在用的不算（它的 token 已算进上面四项）。
        dropped: [...arbitration.dropped],
        at: new Date().toISOString(),
      }
      accounting.totalInjected = accounting.l1Tokens + accounting.l2Tokens
        + accounting.l3Tokens + accounting.mainlineTokens
      state.injection = accounting

      // 诊断**再写一次**：第一次写在本轮注入逻辑之前（见上方注释），那时注入读数
      // 还不存在。这里补写，让落盘快照带上刚刚实测的 injection 块。
      //
      // 为什么不是"把第一次的调用挪到这里"：注入块的构造/仲裁/渲染任何一处抛错，
      // 外层 try/catch 都会直接 return，后面所有步骤都会被跳过——包括诊断落盘。
      // 那会把这一轮的 "L2 为什么失败 / 骨架 cause 为什么没回填" 一起丢掉。
      // 两次写各保住一半事实：第一次保失败原因，第二次补注入读数。代价只是一次
      // 几 KB 的同步写（每轮最多两次），比丢掉任一半都便宜。
      writeDiagnostics(state, sessionIdOf(session))
      // 全量骨架快照（未剪枝）+ 剪枝清单：展示层可以省，本地必须留一份完整的。
      if (mainline !== null) {
        writeMainlineSnapshot({ sessionId: sessionIdOf(session), state, fit: mainline })
      }

      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
          }),
        ],
      }
    } catch (error: unknown) {
      // 记忆层永远不能让对话失败：注入失败即跳过本轮投影。
      context.logger.warn('[dsh-tri-layer-memory] 投影失败，本轮跳过注入：%s',
        error instanceof Error ? error.message : String(error))
      return decision
    }
  }, { prepend: true })

  // ── 7. 模型工具（软等待 tools：缺席就只是没有工具，插件照常 active）────
  context.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register(buildRecallTool(runtime)))
    toolCtx.effect(() => toolCtx.tools.register(buildStateTool(runtime)))
    toolCtx.effect(() => toolCtx.tools.register(buildVerifyTool(runtime)))
    toolCtx.effect(() => toolCtx.tools.register(buildDedupeTool(runtime)))
  })

  // ── 8. boot 自检 ─────────────────────────────────────────────────────
  if (settings.selfTestAfterBoot) {
    try {
      const engine = engineOf(context as never)
      if (engine.id === null) {
        context.logger.warn(
          '[dsh-tri-layer-memory] 自检：未检测到 ctx.compaction 压缩引擎。三层记忆不占用该槽位，'
          + '因此 L1/L2/L3 仍会工作，但 surface 级压缩由谁负责需要确认（compaction-basic 或 argp/instant/headroom 之一）。',
        )
      } else if (settings.integrationEngine !== 'auto' && settings.integrationEngine !== engine.id) {
        context.logger.warn(
          '[dsh-tri-layer-memory] 自检：引擎仲裁不一致——实际 %s，配置期望 %s。',
          engine.id, settings.integrationEngine,
        )
      }
      if (!settings.l3Enabled) {
        context.logger.info('[dsh-tri-layer-memory] 自检：L3 已禁用，记忆只覆盖 L1+L2（不跨会话）。')
      }
    } catch (error: unknown) {
      context.logger.warn('[dsh-tri-layer-memory] 自检异常（不影响运行）：%s',
        error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * 三层级联的推进：L1 溢出 → L2 摘要 → L3 蒸馏。
 *
 * 规则：
 * - L1 溢出但仍在 L2 保留窗口（`l2.retainTurns`）内的轮，交给摘要。
 * - 超出 L2 保留窗口的最旧部分，确定性浓缩后落 L3（不自动注入，只可 recall）。
 * - 被新摘要取代的旧摘要也落 L3，保证可逆：原文虽不再注入，但从未丢失。
 *
 * @param input - 会话状态、窗口、pre-step 载荷、存储与配置。
 */
async function refreshDigest(input: {
  state: SessionState
  window: { evicted: readonly TurnSpan[] }
  payload: any
  storeReady: boolean
  store: DeepMemoryStore
  settings: TriLayerConfig
  context: HostContext
  /** 本轮解析出的 llm seam（inject 软等待优先，ctx.get 兜底）。 */
  seam: { llm: LlmSeam | undefined; source: 'inject' | 'get' | 'none' }
}): Promise<void> {
  const { state, window, payload, storeReady, store, settings, context, seam } = input
  if (settings.l2Mode === 'off') return
  const evicted = window.evicted
  if (evicted.length === 0) return

  const session = payload?.agent?.session
  const sessionId = sessionIdOf(session)

  // 超出 L2 保留窗口的最旧部分 → L3。
  const overflowCount = Math.max(0, evicted.length - settings.l2RetainTurns)
  if (settings.l3Enabled && settings.l3Distill && storeReady && overflowCount > 0) {
    // 水位**播种**：从 L3 库里推本会话已蒸馏到的最大轮号，只在第一次用到时做一次。
    //
    // 为什么必须播种（而不是继续只靠内存字段）：`l3HighWaterTurn` 的初值是 -1，
    // 进程一重启就归零，于是"已经从 turn 1 蒸到 turn 95"这件事被忘掉，下一轮又从
    // turn 1 重蒸一遍。记录 id 由 createdAt + seq 生成，每重启一次就多一份副本——
    // 实测某会话 1188 条里 1044 条是重复，turn 1 有 32 份。
    //
    // 为什么选择"从库推"而不是单独落一个水位文件（两个方案二选一）：
    // - 不引入新的持久化状态，没有第二份真相，也就没有"水位文件和库不一致"这种故障；
    // - 能自愈：库里有独白就跳过，迁移/回滚/换机器都零成本；
    // - 库里的重复副本不影响结果——取的是最大轮号，不是条数。
    // 代价是每次进程启动多一次全库扫描（1480 条约 1ms），且它假设"最大轮号之前的
    // 轮都已处理过"——蒸馏本来就是按轮号升序推进的，这个假设与实现一致。
    //
    // 存量垃圾（重启期间已经写进去的副本：本会话实测 1044 条 / 整库 1130 条）**不在这里清**：
    // 那是用户数据，只由显式命令 scripts/dedupe-l3.mjs 处理（默认 dry-run，--apply 才删）。
    if (!state.l3WatermarkSeeded) {
      state.l3WatermarkSeeded = true
      const persisted = store.maxTurnTo(sessionId)
      if (persisted > state.l3HighWaterTurn) state.l3HighWaterTurn = persisted
    }
    // ── 工具细节池：与 turn 记录**独立**推进 ──────────────────────────────
    // 为什么水位不用 `l3HighWaterTurn`：那个水位在升级前就已经推到很后面（老会话的
    // turn 记录早写完了）。如果工具记录也受它约束，这次升级对"已经溢出的历史轮次"
    // 永远不生效——而漏掉的恰恰是最需要取回的那段。这里按"该轮有没有 tool 记录"
    // 判断，幂等由 captureToolRecord 保证。
    const overflowSpans = evicted.slice(0, overflowCount)
    const toolEnabled = settings.l3ToolDistill && settings.l3Enabled && storeReady
    if (toolEnabled && overflowSpans.length > 0) {
      const existingTurns = new Set<number>()
      for (const record of store.all()) {
        if (record.kind === 'tool' && record.sessionId === sessionId) existingTurns.add(record.turnFrom)
      }
      // 每会话上限先挡一道：满了就不必再读事件、切正文（长会话里这是主要开销）。
      const needCopy = existingTurns.size < settings.l3ToolMaxPerSession
      const wanted = new Set<number>()
      for (const span of overflowSpans) {
        if (existingTurns.has(span.turn)) continue
        if (wanted.size + existingTurns.size >= settings.l3ToolMaxPerSession) break
        wanted.add(span.turn)
      }
      const hitsByTurn = new Map<number, ToolResultHit[]>()
      if (needCopy && wanted.size > 0) {
        for (const hit of collectToolResults(readEvents(session), (turn) => wanted.has(turn))) {
          const list = hitsByTurn.get(hit.turn) ?? []
          list.push(hit)
          hitsByTurn.set(hit.turn, list)
        }
      }
      for (const span of overflowSpans) {
        const hits = hitsByTurn.get(span.turn)
        if (hits === undefined) continue
        try {
          captureToolRecord({
            store,
            sessionId,
            turn: span.turn,
            hits,
            settings: {
              enabled: settings.l3ToolDistill,
              maxChars: settings.l3ToolRecordChars,
              maxPerSession: settings.l3ToolMaxPerSession,
              maxRecords: settings.l3ToolMaxRecords,
            },
          })
        } catch (error: unknown) {
          // 工具细节是**可降级**的附加层：它写失败不能连带跳过同一轮的主内容蒸馏
          // 与 L2 摘要（外层 catch 会把整个投影一起丢掉）。但也绝不能静默——桌面端
          // 宿主日志不可见，所以这里至少留一条 warn。
          context.logger.warn('[dsh-tri-layer-memory] 工具记录落库失败（跳过该轮，主内容不受影响）：%s',
            error instanceof Error ? error.message : String(error))
        }
      }
    }
    // ── 约束细节池：读 `tool/call` 参数，与工具输出池**完全独立** ──────────
    //
    // 为什么必须单独走一条路：`tool/result` 只承载"工具做了什么"，而"不许做什么"
    // 的原文大多写在 `tool/call.arguments` 里（README 章节、源码注释、测试名）。
    // 实测 10 条硬约束里 5 条的原文只存在于这里，turn 记录（原料是 user/assistant
    // 文本）与 tool 记录（原料是 tool/result）都救不回。这是最后一个结构性盲区。
    //
    // 幂等按"该轮有没有 constraint 记录"判断（而不是复用工具池的 existingTurns）：
    // 两个池子可以分别被关掉/打开，共用一份判等会让关掉一个池子时另一个池子
    // 静默跳过整轮。同轮多次 `tool/call` 在一次扫描里全部收集、合并成一条记录，
    // 所以"同轮多次调用"不是幂等的例外。
    const constraintEnabled = settings.l3ConstraintDistill && settings.l3Enabled && storeReady
    if (constraintEnabled && overflowSpans.length > 0) {
      const existingTurns = new Set<number>()
      for (const record of store.all()) {
        if (record.kind === 'constraint' && record.sessionId === sessionId) existingTurns.add(record.turnFrom)
      }
      const wanted = new Set<number>()
      for (const span of overflowSpans) {
        if (existingTurns.has(span.turn)) continue
        if (wanted.size + existingTurns.size >= settings.l3ConstraintMaxPerSession) break
        wanted.add(span.turn)
      }
      const callsByTurn = new Map<number, ToolCallHit[]>()
      if (wanted.size > 0) {
        for (const call of collectToolCalls(readEvents(session), (turn) => wanted.has(turn))) {
          const list = callsByTurn.get(call.turn) ?? []
          list.push(call)
          callsByTurn.set(call.turn, list)
        }
      }
      for (const span of overflowSpans) {
        const calls = callsByTurn.get(span.turn)
        if (calls === undefined) continue
        try {
          captureConstraintRecord({
            store,
            sessionId,
            turn: span.turn,
            calls,
            settings: {
              enabled: settings.l3ConstraintDistill,
              maxChars: settings.l3ConstraintRecordChars,
              maxPerSession: settings.l3ConstraintMaxPerSession,
              maxRecords: settings.l3ConstraintMaxRecords,
            },
          })
        } catch (error: unknown) {
          // 与工具池同一条纪律：可降级、不能拖垮主内容蒸馏，但绝不静默。
          context.logger.warn('[dsh-tri-layer-memory] 约束记录落库失败（跳过该轮，主内容不受影响）：%s',
            error instanceof Error ? error.message : String(error))
        }
      }
    }
    for (const span of overflowSpans) {
      if (span.turn <= state.l3HighWaterTurn) continue
      store.put({
        kind: 'turn',
        sessionId,
        turnFrom: span.turn,
        turnTo: span.turn,
        // 分层抽取（约束/排除/失败/推断按类型各自留预算），**只用于 L3 turn 记录**：
        // 它不进注入，成本只有磁盘与剪枝频率。L2 摘要的回退路径仍用默认的 160 字
        // 抽取（那里的正文每轮都要注入），两条路径分开定价，见 l2-render.ts。
        //
        // 末尾再用 withBoundaryClauses 附上**未剪的约束原话**：分类预算是有限的，
        // 实测约一半约束句在 L3 里找不到片段；存储可以大、注入必须小，所以在这里
        // 保底而不是放宽蒸馏预算（后者会连带抬高 recall 的默认返回量）。
        text: withBoundaryClauses(extractiveDigest([span], { layered: true }), span.userText),
        refs: [],
      })
      state.l3HighWaterTurn = Math.max(state.l3HighWaterTurn, span.turn)
    }

    // ── 历史 turn 记录的"未剪约束"补写（每会话一次，批量落盘）─────────────
    //
    // 两件事都在这里做，因为它们都属于"存量存储有损"：
    // 1. **缺记录**：实测 131 轮里只有 99 条 turn 记录（旧版本去重/剪枝留下的空洞，
    //    第 100/107/110 轮整轮没有记录）。只补水位线以内、确实该蒸馏过的轮次，
    //    绝不动还在 L1/L2 窗口里的新轮——那会和高水位写入路径打架、制造重复。
    // 2. **缺约束原话**：存量的 turn 记录是旧实现写的，末尾没有约束段。
    //
    // 用 `updateMany`/一次 put 批量落盘：逐条 `update` 会变成上百次全表重写，卡住这一轮
    // 对话。上限（300 条 / 12 万字符）是给超长会话的保护：补不完的下一轮继续。
    if (!state.boundaryBackfillDone) {
      const turnRecords = new Map<number, MemoryRecord>()
      for (const record of store.all()) {
        if (record.kind === 'turn' && record.sessionId === sessionId) turnRecords.set(record.turnTo, record)
      }
      const patches: Array<{ id: string; text: string; tokens: number }> = []
      let addedChars = 0
      let created = 0
      for (const span of evicted) {
        if (patches.length + created >= 300 || addedChars >= 120_000) break
        const record = turnRecords.get(span.turn)
        if (record === undefined) {
          // 只补"按水位本该已经蒸馏过"的轮；新轮由正常写入路径负责，避免形成重复。
          if (span.turn > state.l3HighWaterTurn) continue
          const text = withBoundaryClauses(extractiveDigest([span], { layered: true }), span.userText)
          store.put({ kind: 'turn', sessionId, turnFrom: span.turn, turnTo: span.turn, text, refs: [] })
          created += 1
          continue
        }
        const text = withBoundaryClauses(record.text, span.userText)
        if (text === record.text) continue
        addedChars += text.length - record.text.length
        patches.push({ id: record.id, text, tokens: estimateTokens(text) })
      }
      if (patches.length === 0 && created === 0) {
        state.boundaryBackfillDone = true
      } else {
        try {
          const { updated: filled } = patches.length === 0 ? { updated: 0 } : store.updateMany(patches)
          state.boundaryBackfillDone = true
          context.logger.info('[dsh-tri-layer-memory] 历史 turn 记录补写：改 %d 条 / 新建 %d 条（+%d 字符）',
            filled, created, addedChars)
        } catch (error: unknown) {
          // 补写失败保持 false，下一轮重试；它只是存储增强，不能拖垮摘要与注入。
          context.logger.warn('[dsh-tri-layer-memory] 历史 turn 记录补写失败（下一轮重试）：%s',
            error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  // 仍在 L2 窗口内、且未被当前摘要覆盖的轮 → 生成/刷新摘要。
  //
  // **这里修过一次"覆盖区间塌缩"**：旧实现把 `uncovered`（新增的 3 轮）直接喂给
  // 模型，并把返回的 turnFrom/turnTo 当成新摘要的覆盖区间——于是每刷新一次，
  // L2 就从"24 轮"缩到"最后 3 轮"，而中间轮次的原文早已溢出 L1、只留在被丢弃的
  // 旧摘要里（L3 的 turn 记录保留率只有 2.1%，接不住这段）。滚动摘要的做法是：
  // 输入 = 上一份摘要 + 新增轮，输出区间 = 整个 L2 窗口（`forL2` 首尾）。
  // 旧摘要的结论通过输入延续，覆盖区间不再随刷新缩短；成本只有 1.25x（实测
  // 6,740 vs 5,373 tok/次），而全量重算是 7.2x（38,780 tok/次）。
  const forL2 = evicted.slice(overflowCount)
  const uncovered = state.digest === null
    ? forL2
    : forL2.filter((span) => span.turn > (state.digest as DigestResult).turnTo)
  if (uncovered.length < settings.l2MinTurnsBeforeSummary) return
  // 缺口：上一份摘要与新增轮之间漏了轮（例如 L1 一次大步溢出、或窗口大小被改小）。
  // 那些轮既不在摘要里、也不在本批输入里，只喂增量会让它们从 L2 消失。此时退化为
  // 全窗口重算（`forL2`），代价是一次更大的输入，但不会制造"看不见的缺口"。
  const coveredTo = state.digest === null ? -1 : (state.digest as DigestResult).turnTo
  const gap = coveredTo >= 0 && uncovered[0] !== undefined && uncovered[0].turn > coveredTo + 1
  const fed = gap ? forL2 : uncovered
  const now = Date.now()
  if (settings.l2RefreshIntervalMs > 0 && now - state.lastDigestAt < settings.l2RefreshIntervalMs) return

  try {
    const digest = await buildDigest(seam.llm, fed, {
      mode: settings.l2Mode,
      maxTokens: settings.l2MaxSummaryTokens,
      sessionId,
      agent: payload?.agent,
      // 推理档位随请求发出：摘要不需要深思，把预算让给正文（依据见 config-core.ts）。
      reasoningEffort: settings.internalCallReasoningEffort,
      // 滚动摘要：上一份摘要一起进输入，并在指令里要求保留其中仍有效的结论。
      // 首次摘要（state.digest === null）不带——那时 `uncovered` 就是整个窗口。
      ...(state.digest === null ? {} : { previousText: (state.digest as DigestResult).text }),
      // 区间报**整个 L2 窗口**，不是本批输入的范围（否则每次刷新都塌回 3 轮）。
      windowFrom: forL2[0]?.turn ?? uncovered[0]?.turn ?? 0,
      windowTo: forL2[forL2.length - 1]?.turn ?? uncovered[uncovered.length - 1]?.turn ?? 0,
      ...(payload?.signal === undefined ? {} : { signal: payload.signal }),
    })
    if (digest === null) return
    // 失败原因必须留下痕迹。**这是本次故障的观察面**：宿主日志在桌面端不可见，
    // memory_state 是唯一可靠出口；只写 logger 等于什么都没写。
    state.llmSource = seam.source
    // 读数无条件记下（成功也记）：只有"成功时也有读数"，才能判断"这份摘要是被
    // 截过的还是完整的"，以及"这次调用推理吃了多少"。
    state.l2Attempt = digest.attempt ?? null
    const failure = digest.via === 'llm' ? null : (digest.fallback ?? null)
    const changed = failure?.stage !== state.l2Failure?.stage || failure?.message !== state.l2Failure?.message
    state.l2Failure = failure
    if (failure !== null && changed) {
      // 只在原因**变化**时告警：l2RefreshIntervalMs 默认 0，每个合格步都会重试，
      // 逐轮刷同一条 warn 会把真正的信号淹掉。
      context.logger.warn('[dsh-tri-layer-memory] L2 摘要退回抽取式（%s）：%s',
        failure.stage, failure.message)
    }
    if (digest.attempt?.salvaged === true) {
      // 「截断但仍在用」也要留痕，但**不**算失败：它是可用产物，只是被裁过尾巴。
      // 用 info 而不是 warn——warn 是"需要修"，这一条是"修过、还能用"。
      context.logger.info('[dsh-tri-layer-memory] L2 摘要撞输出上限，已按边界截断保留 %d 字符（丢弃 %d，对齐 %s；请求上限 %d，输入 %d tokens）',
        digest.text.length, digest.attempt.droppedChars, digest.attempt.boundary,
        digest.attempt.maxTokens, digest.attempt.inputTokens)
    }
    // 旧摘要落 L3：被"遗忘"的内容必须可逆取回。
    const previous = state.digest
    if (previous !== null && settings.l3Enabled && settings.l3Distill && storeReady) {
      store.put({
        kind: 'digest',
        sessionId,
        turnFrom: previous.turnFrom,
        turnTo: previous.turnTo,
        text: previous.text,
        refs: [],
      })
    }
    state.digest = digest
    state.lastDigestAt = now
  } catch (error: unknown) {
    // buildDigest 自己已经吞掉了模型侧失败；能走到这里的是更外层的意外（例如
    // L3 落库失败）。同样记进状态，别只写日志。
    state.l2Failure = {
      stage: 'llm-error',
      message: `digest pipeline threw: ${error instanceof Error ? error.message : String(error)}`,
    }
    context.logger.warn('[dsh-tri-layer-memory] L2 摘要失败（本轮保留旧摘要）：%s',
      error instanceof Error ? error.message : String(error))
  }
}

/**
 * 一条里程碑在 L3 里的正文行。
 *
 * 与 `milestones.ts` 的骨架行逐字一致（`第 N 轮: 标题 — 原因`，跨轮 `第 N–M 轮`）：
 * `Milestone.tokens` 就是按这一行的口径估算的，两者必须同形，否则 L3 里记的
 * token 数会和它实际占用的对不上。（`renderMilestone` 未导出，因此这里复刻这一行。）
 *
 * @param milestone - 一条里程碑。
 * @returns 骨架行文本。
 */
function milestoneLine(milestone: Milestone): string {
  return renderMilestoneLine(milestone.turn, milestone.turnTo ?? milestone.turn, milestone.title, milestone.cause)
}

/**
 * 按骨架行口径渲染一条（轮次 + 标题 + cause）。
 *
 * 抽出来的理由：落库路径要渲染**接回来的旧 cause**（而不是 milestone 上那个模板标签），
 * 两处必须同形，否则 `tokens` 与实际占用的差会再出现一次。
 *
 * @param turn - 起始轮。
 * @param turnTo - 结束轮（等于 turn 时为单轮）。
 * @param title - 标题。
 * @param cause - 原因从句。
 * @returns 骨架行文本。
 */
function renderMilestoneLine(turn: number, turnTo: number, title: string, cause: string): string {
  const span = turnTo === turn ? `第 ${turn} 轮` : `第 ${turn}–${turnTo} 轮`
  return `${span}: ${title} — ${cause}`
}

/**
 * 主线骨架的推进：提取 + 落 L3。
 *
 * **只在 L1 溢出轮数变化时提取**（high-water mark）。提取是确定性全量扫描
 * （11,424 事件实测 72ms），而 `agent/pre-step` 每一步都会跑：不设限频的话，
 * 一个 50 轮、每轮 10 步的会话要白白付几百次全量扫描。溢出轮数变化恰好是
 * "会话又往前走了一轮"的确定性信号——它不变时，事件流里能产生新里程碑的东西也没变。
 *
 * 提取出的**新增**里程碑写进 L3，作为组织散落细节的根节点：它自己不带细节正文
 * （细节已经在 L3 的 turn/digest 记录里），只用 `refs` 指向同轮范围内**已存在**的
 * 那些记录。里程碑不新建 detail 记录——重复存储细节会让 L3 变成两份真相，
 * 而里程碑的全部价值就在于"给散落的细节加一个根，把它们组织成故事"。
 *
 * @param input - 会话状态、窗口、会话对象、存储与配置。
 * @returns 本次是否真的重新提取过（因果补全据此判断"里程碑集合变了没有"）。
 */
function refreshMainline(input: {
  state: SessionState
  window: { evicted: readonly TurnSpan[] }
  session: unknown
  storeReady: boolean
  store: DeepMemoryStore
  settings: TriLayerConfig
}): boolean {
  const { state, window, session, storeReady, store, settings } = input
  if (!settings.mainlineEnabled) {
    // 连缓存与水位一起清掉：重新打开时必须重新提取，而不是接着用一份过期骨架。
    state.mainline = []
    state.mainlineWaterMark = -1
    // cause 缓存同样清掉：它键在轮次区间上，留着只会在重开后贴出一份过期因果。
    state.mainlineCauses.clear()
    state.mainlineStored.clear()
    state.mainlineRecordIds.clear()
    return false
  }

  const mark = window.evicted.length
  if (mark === state.mainlineWaterMark) return false
  state.mainline = extractMilestones(readEvents(session))
  state.mainlineWaterMark = mark
  // 提取产出的是全新对象：把已经补到的 cause 贴回去，否则水位一变因果就全丢回确定性
  // 标签，而 L3 里那份（唯一持久化的版本）已经改过——同一个会话会有两份不同的骨架。
  attachCauses(state.mainline, state.mainlineCauses)
  if (!settings.l3Enabled || !storeReady) {
    // 存储不在场时清空"已落库"集合：提示行据此退化成"暂不可 recall"，不撒谎。
    state.mainlineStored.clear()
    state.mainlineRecordIds.clear()
    return true
  }

  const sessionId = sessionIdOf(session)
  // ── 落库：按**位置**认领，而不是按轮次区间去重 ──────────────────────────
  //
  // 旧实现只用 `turn:turnTo` 去重。那假设"一轮最多一条里程碑"，而提取器实际会
  // 在同一轮产出多条（第 1 轮的「任务 + 逐轮事件」、第 55 轮的「用户追问 + 压缩」）。
  // 后果是：**第二条及以后从未写入 L3**——它们在注入里看得见、被裁剪后却 recall 不到，
  // 正是"展示有损、存储也有损"。审计实测 90 条骨架里有 7 条处于这个状态。
  //
  // 新规则见 {@link persistMainlineRecords}：同一区间内，第 i 条里程碑认领第 i 条
  // 未被认领的旧记录——正文相同则跳过，不同则 `update` 就地刷新，没有则新建。
  const persisted = persistMainlineRecords({
    store,
    sessionId,
    milestones: state.mainline,
    backfilledCauses: new Set(state.mainlineCauses.keys()),
  })
  state.mainlineStored = persisted.stored
  state.mainlineRecordIds = persisted.recordIds
  // 把从 L3 旧记录里接回来的因果贴回内存：否则重启后第一次提取会用确定性标签渲染，
  // 而 L3 里是更具体的那份——同一会话两份骨架又分叉了。
  if (persisted.recovered.size > 0) {
    for (const [key, cause] of persisted.recovered) state.mainlineCauses.set(key, cause)
    attachCauses(state.mainline, state.mainlineCauses)
  }
  return true
}

/** {@link persistMainlineRecords} 的结果。 */
export interface MainlinePersistResult {
  /** 确认已落库的里程碑键（{@link causeCacheKey}）。 */
  stored: Set<string>
  /** 键 → 记录 id（cause 回填按它精确回写）。 */
  recordIds: Map<string, string>
  /** 本次新建 / 就地刷新的记录数（诊断用）。 */
  created: number
  updated: number
  /**
   * 从旧记录里**接回来**的因果（键 → cause）。
   *
   * 为什么需要它：cause 回填的缓存 `mainlineCauses` 只活在进程内存里，重启后是空的。
   * 如果落库时就地刷新正文，等于把 L3 里那份已经补好的 "为什么" 用确定性标签
   * （`原因不明`/`当轮测试通过`）覆盖掉——每重启一次就丢一层信息。这条路径让
   * "刷新"变成"以旧记录里更具体的那份为准"，既修了旧版本残留，又不做降级。
   */
  recovered: Map<string, string>
}

/**
 * 解析一条里程碑正文，拆出标题与 cause（纯函数，容错）。
 *
 * @param text - `第 N 轮[–M 轮]: 标题[ — 原因]`。
 * @returns 标题与原因；不是里程碑形态时返回 null。
 */
export function parseMilestoneLine(text: string): { title: string; cause: string } | null {
  const head = /^第 \d+(?:–\d+)? 轮: /.exec(text)
  if (head === null) return null
  const rest = text.slice(head[0].length)
  const at = rest.indexOf(' — ')
  if (at < 0) return { title: rest, cause: '' }
  return { title: rest.slice(0, at), cause: rest.slice(at + 3) }
}

/**
 * 把一批里程碑写成 L3 记录，并返回"哪些确认已落库"。
 *
 * **为什么按位置认领而不是按轮次区间去重**：一轮可能产出多条里程碑（「任务」与
 * 逐轮事件、用户追问与压缩事件）。旧实现用 `turn:turnTo` 做去重键，第二条会被
 * 静默跳过——它在注入里看得见，被展示分层裁掉后却 recall 不到。这正是用户原则里
 * 最不能违反的一条（展示可以有损，存储不能有损）。
 *
 * 认领规则（同一轮区间内，按 milestone 原顺序）：
 * 1. 有正文完全相同的未认领记录 → 已存，不写；
 * 2. 有未认领的旧记录 → `update` 就地刷新，**但因果不降级**：旧记录里的具体 cause
 *    优先于当前的模板标签（见 {@link MainlinePersistResult.recovered}）；
 * 3. 都没有 → 新建。
 *
 * 抽成导出函数而不是留在 `refreshMainline` 里，是为了让审计脚本能对**库副本**跑
 * 同一份落库逻辑——复制一份到脚本里，下次改这里时脚本会静默测旧行为。
 *
 * @param input - 存储（只用到 all/put/update）、会话 id、里程碑。
 * @returns 已落库键集合、键 → 记录 id、新建/刷新计数、接回来的因果。
 */
export function persistMainlineRecords(input: {
  store: Pick<DeepMemoryStore, 'all' | 'put' | 'update'>
  sessionId: string
  milestones: readonly Milestone[]
  /**
   * 本轮**由 LLM 回填**的里程碑键集合（{@link causeCacheKey}）。
   *
   * 用来区分"当前 cause 是模型补的具体因果"与"当前 cause 只是确定性标签"：后者不该
   * 覆盖 L3 里那条更具体的旧因果（重启后 cause 缓存在内存里是空的，直接刷新会把
   * `注入预算与优先级逻辑不符` 降级成 `当轮测试通过`——实测发生过，探针因此少一条）。
   */
  backfilledCauses?: ReadonlySet<string>
}): MainlinePersistResult {
  const { store, sessionId, milestones, backfilledCauses } = input
  const backfilled = backfilledCauses ?? new Set<string>()
  const recordsBySpan = new Map<string, MemoryRecord[]>()
  for (const record of store.all()) {
    if (record.kind !== 'milestone' || record.sessionId !== sessionId) continue
    const span = `${record.turnFrom}:${record.turnTo}`
    const pool = recordsBySpan.get(span)
    if (pool === undefined) recordsBySpan.set(span, [record])
    else pool.push(record)
  }
  const claimed = new Set<string>()
  const stored = new Set<string>()
  const recordIds = new Map<string, string>()
  const recovered = new Map<string, string>()
  let created = 0
  let updated = 0
  // 细节记录的快照只取一次：refs 要指向**已存在**的 turn/digest，而不是本轮新写的里程碑。
  const details = store.all().filter((record) => record.kind === 'turn' || record.kind === 'digest')

  for (const milestone of milestones) {
    const turnTo = milestone.turnTo ?? milestone.turn
    const key = causeCacheKey(milestone)
    const pool = recordsBySpan.get(`${milestone.turn}:${turnTo}`) ?? []
    const free = pool.filter((record) => !claimed.has(record.id))
    // 候选记录先算出来，再决定正文：旧记录里的具体 cause 可能比当前确定性标签更有信息。
    const candidate = free[0]
    const parsed = candidate === undefined ? null : parseMilestoneLine(candidate.text)
    const adoptCause = parsed !== null
      && parsed.title === milestone.title
      && parsed.cause.length > 0
      && parsed.cause !== milestone.cause
      // 旧记录里是模板标签时**不**采纳：`原因不明` 不该覆盖当前的确定性标签。
      && !isTemplateCause(parsed.cause)
      // 当前 cause 已经是本轮 LLM 回填的，就以它为准（它比旧记录更新）。
      && !backfilled.has(key)
    const cause = adoptCause ? parsed.cause : milestone.cause
    if (adoptCause) recovered.set(key, cause)
    const line = renderMilestoneLine(milestone.turn, turnTo, milestone.title, cause)

    const exact = free.find((record) => record.text === line)
    if (exact !== undefined) {
      claimed.add(exact.id)
      stored.add(key)
      recordIds.set(key, exact.id)
      continue
    }
    if (candidate !== undefined) {
      claimed.add(candidate.id)
      if (store.update(candidate.id, {
        text: line,
        // token 已经按上面那行的口径重算；不再沿用 milestone.tokens（它对应的是另一句 cause）。
        tokens: estimateTokens(line),
      })) updated += 1
      stored.add(key)
      recordIds.set(key, candidate.id)
      continue
    }
    const record = store.put({
      kind: 'milestone',
      sessionId,
      turnFrom: milestone.turn,
      turnTo,
      text: line,
      refs: details
        .filter((detail) => detail.turnFrom <= turnTo && detail.turnTo >= milestone.turn)
        .map((detail) => detail.id),
      tokens: estimateTokens(line),
    })
    claimed.add(record.id)
    pool.push(record)
    recordsBySpan.set(`${milestone.turn}:${turnTo}`, pool)
    stored.add(key)
    recordIds.set(key, record.id)
    created += 1
  }
  return { stored, recordIds, created, updated, recovered }
}

/** 补 cause 的等待上限（毫秒）。 */
const CAUSE_TIMEOUT_MS = 45_000

/**
 * pre-step 内联等待 cause 回填的上限。
 *
 * 超过它就**不再等**：调用转入后台，结果落在下一轮投影。取值在"让快调用当场生效"
 * 与"不让慢调用拖慢对话"之间——宿主路由带 `reasoningEffort: "max"`，把这里调到
 * 能把调用跑完的量级，就等于每一轮都阻塞十几秒。
 */
const CAUSE_INLINE_WAIT_MS = 1500

/**
 * 补 cause 的生成上限。
 *
 * 单次最多 20 条 × 每条 ≤20 字 ≈ 400 字，512 够用且留了余量；上限本身也是一种保护——
 * 生成被截断时只有尾部几条认不出来，前面的仍然完整可解析（见 {@link parseCauseReply}）。
 */
/**
 * cause 回填请求的输出上限。
 *
 * **这个数曾经是 512，那是错的**：宿主 profile 里模型路由带 `reasoningEffort: "max"`，
 * 推理 token 与正文共享同一个输出预算。512 会被推理全部吃掉，模型一个正文 token 都
 * 不剩——真实故障是"回复 0 字符"，`parseCauseReply` 自然解析不出任何条目，整条
 * cause 回填静默失效了整整一个版本周期。
 *
 * 4096 是给「推理 + 若干条 ≤20 字的原因」留出的余量。它是**内部工具调用的上限**，
 * 不是给人看的配置项，所以不进 settings schema。
 */
const CAUSE_MAX_TOKENS = 4096

/** {@link requestCauses} 的产出：回复正文 + 本次调用的读数。 */
interface CauseRun {
  text: string
  attempt: CauseAttempt
}

/**
 * 一次「补 cause」调用：发序号/轮次/标题 + 每条 `detail` 的一小段摘录，只收一个紧凑 JSON。
 *
 * 摘录是"不要编因果"这条修复的输入侧（见 {@link renderCauseRequest}），长度由
 * `mainlineCauseExcerptChars` 决定（0 = 退回只发标题）。
 *
 * 走与 L2 摘要**同一条** seam（`ctx.llm.stream` + `purpose: 'compaction'`），不另造
 * 模型通路：换模型、换网关、配额与路由都由宿主那一侧决定，这里不需要跟着改。
 *
 * **也走同一个档位与同一条重试退路**（{@link callWithEffortRetry}）。这一条曾经是
 * 自己实现的，于是它**没有带 `reasoningEffort`**——同一条 seam、同一个模型，
 * L2 那条路压住了推理、cause 这条路没有，推理就把 4096 的输出预算吃光，
 * 回复 0 字符、整批因果静默失效（诊断里只有 `cause reply carried no parsable entries`）。
 * 共用之后，两条路只可能同时生效或同时失效。
 *
 * @param llm - `ctx.llm` seam。
 * @param target - provider/model。
 * @param body - {@link renderCauseRequest} 的输出。
 * @param options - 会话 id、取消信号与**推理档位**。
 * @returns 模型回复的纯文本 + 本次调用的读数（`CauseRun`）。
 */
async function requestCauses(
  llm: LlmSeam,
  target: { provider: string; model: string },
  body: string,
  options: { sessionId: string; signal?: AbortSignal; reasoningEffort?: string },
): Promise<CauseRun> {
  const buildRequest = (effort: string | undefined): Record<string, unknown> => ({
    provider: target.provider,
    model: target.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: `${body}\n\n---\n\n${CAUSE_INSTRUCTION}` }],
        source: { kind: PLUGIN_SOURCE_KIND },
      }),
    ],
    maxTokens: CAUSE_MAX_TOKENS,
    sessionId: options.sessionId,
    purpose: 'compaction',
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  const run = await callWithEffortRetry(llm, buildRequest, options.reasoningEffort)
  // 终止原因是**证据**，不是"要不要丢"的判据，所以先把读数组装出来、任何分支都不丢它。
  // 刻意**不**因 `max-tokens` 抛错：被截断的 JSON 里前几对键值往往仍然完整，
  // 宽容解析能救一条是一条，这比整批作废更接近"可降级"（平台自己的 assembler
  // 也是这个约定：max-tokens 时保留 text 块，只丢无法安全执行的工具调用）。
  const attempt: CauseAttempt = {
    finish: run.finishKind,
    maxTokens: CAUSE_MAX_TOKENS,
    inputChars: body.length,
    outputChars: run.text.length,
    ...(run.usage === undefined ? {} : { usage: run.usage }),
    // 与 L2 的 `salvaged` 同义：撞了上限但正文非空，于是**没有**整批作废。
    salvaged: run.finishKind === 'max-tokens' && run.text.length > 0,
    reasoningEffort: run.effort,
    effortRetry: run.effortRetry,
    ...(run.firstFailure === undefined ? {} : { firstFailure: run.firstFailure }),
  }
  if (run.finishKind === 'error' || run.finishKind === 'aborted') {
    throw Object.assign(new Error(run.failureMessage ?? 'cause stream failed'), { attempt })
  }
  return { text: run.text, attempt }
}

/**
 * 取出 {@link requestCauses} 挂在异常上的读数。
 *
 * 异常是 `{message, attempt}` 而不是一个自定义类：跨模块的 `instanceof` 在打包后
 * 会随类身份分裂（本插件有 host/client 两个产物），而这里只需要一个字段。
 */
function attemptOf(error: unknown): CauseAttempt | undefined {
  const attempt = (error as { attempt?: unknown } | null | undefined)?.attempt
  return typeof attempt === 'object' && attempt !== null ? (attempt as CauseAttempt) : undefined
}

/**
 * 把回填后的 cause 同步进 L3 的里程碑记录。
 *
 * 骨架行是从记录的 `text` 渲染的，而 `Milestone` 只是内存里的一份提取产物：只改内存
 * 的话，重启后读者从 L3 拿到的仍是确定性标签——**回填等于没做**。
 *
 * 用 `causeCacheKey → recordId` 精确回写，而不是靠轮次区间反查：同一轮可能对应两条
 * 里程碑（第 1 轮的「任务」与逐轮条目），区间反查只能改到第一条，另一条会静默
 * 保留旧标签——那正是"取回的是残缺版"。
 *
 * @param store - L3 存储。
 * @param milestones - 已回填的骨架。
 * @param recordIds - {@link refreshMainline} 留下的键 → 记录 id。
 * @returns 实际改写的记录条数。
 */
function syncMilestoneRecords(
  store: DeepMemoryStore,
  milestones: readonly Milestone[],
  recordIds: ReadonlyMap<string, string>,
): number {
  let updated = 0
  for (const milestone of milestones) {
    const id = recordIds.get(causeCacheKey(milestone))
    if (id === undefined) continue
    const record = store.get(id)
    if (record === undefined || record.kind !== 'milestone') continue
    const line = milestoneLine(milestone)
    if (line === record.text) continue
    if (store.update(id, { text: line, tokens: milestone.tokens })) updated += 1
  }
  return updated
}

/**
 * 主线骨架的因果补全：给缺 cause 的里程碑补一句「为什么」。
 *
 * 骨架原本只记「做了什么 / 成没成」，回退链的因果不在其中——第 22→23→25 轮的三行
 * `未解决` 读不出"`TransparencyKey` 为什么会破坏鼠标命中"，**而那正是那三轮回退的
 * 因果链**。这一步用一次独立、节流的模型调用把"为什么"补上。
 *
 * 三条纪律，每一条都对应一种"记忆层拖垮对话"的可能：
 * 1. **独立**：服务缺席 / 调用失败 / 超时 / 输出不可解析，一律静默跳过，里程碑保持
 *    确定性标签。它绝不向外抛错——pre-step 的 catch 会连带跳过**整个投影**，
 *    为了补一句因果而丢掉这一轮的三层注入是本末倒置。
 * 2. **节流**：调用点卡在提取的水位上（集合没变就不考虑），且累计缺 cause 够
 *    `mainlineCauseMinBatch` 条才发一次，单次最多 `mainlineCauseMaxPerCall` 条。
 * 3. **可降级**：请求带摘录（`mainlineCauseExcerptChars`，0 则退回只发标题），
 *    拿不回就什么都不改。
 *
 * 摘录不是"顺手多发的正文"：没有它，模型只能从标题猜因果，而标题信息不够时它不会说
 * "不知道"，会编一个**听起来合理**的原因——那是比机械标签更糟的失败（自信地错）。
 *
 * @param input - 会话状态、会话对象、存储、配置与上下文。
 */
async function refreshMainlineCauses(input: {
  state: SessionState
  session: unknown
  storeReady: boolean
  store: DeepMemoryStore
  settings: TriLayerConfig
  context: HostContext
  agent: unknown
  signal?: unknown
  /** 本轮解析出的 llm seam（与 L2 摘要同一条，由调用方一次解析后共用）。 */
  seam: { llm: LlmSeam | undefined; source: 'inject' | 'get' | 'none' }
}): Promise<void> {
  const { state, session, storeReady, store, settings, context, seam } = input
  if (!settings.mainlineCauseEnabled || !settings.mainlineEnabled) return
  if (state.mainline.length === 0) return

  // 节流口径是"当前还缺多少条"，而不是"自上次调用以来新增了多少条"：被单次上限挡住的
  // 那部分本来就该在下一轮继续补，把它们算成新债只会让节流永远触发。
  const missing = missingCauses(state.mainline, state.mainlineCauses)
  if (missing.length < settings.mainlineCauseMinBatch) return

  // 三条早退路径**全部记原因**：它们过去都是裸 return，于是"回填没生效"在观察面上
  // 与"没到批量阈值"完全同形——排查时看不出是服务缺席、路由解析不到，还是压根没触发。
  const llm = seam.llm
  if (llm === undefined) {
    state.causeFailure = {
      stage: 'llm-missing',
      message: `llm seam unavailable for cause backfill (source=${seam.source}); ${missing.length} milestone(s) waiting`,
    }
    return
  }
  let target: { provider: string; model: string } | undefined
  try {
    target = resolveTarget(input.agent)
  } catch (error: unknown) {
    state.causeFailure = {
      stage: 'target-missing',
      message: `provider/model resolution threw for cause backfill: ${error instanceof Error ? error.message : String(error)}`,
    }
    return
  }
  if (target === undefined) {
    state.causeFailure = {
      stage: 'target-missing',
      message: 'no provider/model resolvable for cause backfill (agent.session.requestHeader().config / agent.options)',
    }
    return
  }

  const batch = missing.slice(0, settings.mainlineCauseMaxPerCall)
  const sessionId = sessionIdOf(session)
  const controller = new AbortController()
  // 会话被中止（用户打断）时同样放弃这次补全：它只是锦上添花。
  // 判 `addEventListener` 而不是直接调用——载荷里的 signal 在不同宿主版本上可能是
  // 一个只有 `aborted` 的普通对象，为它抛错等于让补全整条路径失效。
  const external = input.signal as { addEventListener?: unknown; removeEventListener?: unknown } | undefined
  const linkable = typeof external?.addEventListener === 'function' && typeof external?.removeEventListener === 'function'
  const onAbort = (): void => controller.abort()
  if (linkable) (external as EventTarget).addEventListener('abort', onAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 先 abort 再 reject：尊重 signal 的 seam 会立刻收尾，不尊重的也拦不住我们放弃等待。
      controller.abort()
      reject(new Error(`cause request timed out after ${CAUSE_TIMEOUT_MS}ms`))
    }, CAUSE_TIMEOUT_MS)
  })
  // 竞速输掉的一方（超时之后流才抛出/才被 abort）必须有人接住，否则会变成
  // 未处理的 rejection，在宿主日志里表现为一个与本插件无关的崩溃。
  timeout.catch(() => {})

  try {
    const work = requestCauses(llm, target, renderCauseRequest(batch, settings.mainlineCauseExcerptChars), {
      sessionId,
      signal: controller.signal,
      // 与 L2 摘要**同一个**档位键：两条路走同一条 seam、同一个模型，推理预算的
      // 约束也必须同源。这里漏掉过一次，后果是 cause 回填静默失效（见 requestCauses）。
      reasoningEffort: settings.internalCallReasoningEffort,
    })
    work.catch(() => {})
    const run = await Promise.race([work, timeout])
    // 读数无条件记下（成功也记）：只有"成功时也有读数"，才能判断这次调用产出了多少
    // 正文、推理吃了多少——"推理吃光预算"与"模型真没说话"在 0 字符时长得一样。
    state.causeAttempt = run.attempt
    if (run.attempt.salvaged) {
      // 「截断但仍在用」要留痕，但**不算失败**：被截断的 JSON 里前几对键值往往完整，
      // 宽容解析救回来的条目是可用产物，只是尾巴可能缺几条。
      context.logger.info('[dsh-tri-layer-memory] cause 回复撞输出上限，按宽容解析继续（正文 %d 字符 / 上限 %d tokens）',
        run.attempt.outputChars, run.attempt.maxTokens)
    }
    const applied = applyCauses(state.mainline, parseCauseReply(run.text))
    if (applied.length === 0) {
      // 拿到回复但一条都认不出来（正文为空、格式不符）同样是失败，别让它看起来像成功。
      // 消息里带上 finish 与正文字符数：0 字符 + max-tokens 指向推理吃光预算，
      // 0 字符 + stop 指向模型没按格式说话——两种修法完全不同，不能混成一句话。
      state.causeFailure = {
        stage: 'llm-error',
        message: `cause reply carried no parsable entries (${run.text.length} chars, finish=${run.attempt.finish})`,
      }
      return
    }
    for (const item of applied) state.mainlineCauses.set(item.cacheKey, item.cause)
    state.causeFailure = null
    const synced = settings.l3Enabled && storeReady
      ? syncMilestoneRecords(store, state.mainline, state.mainlineRecordIds)
      : 0
    context.logger.info('[dsh-tri-layer-memory] 骨架 cause 补全：%d 条（L3 同步 %d 条）', applied.length, synced)
  } catch (error: unknown) {
    // 调用读数在异常路径上同样要落地：这里恰恰是"0 字符 / 推理吃光预算"最常出现的地方，
    // 漏掉它等于把最需要读数的情形排除在观察面之外。
    const attempt = attemptOf(error)
    if (attempt !== undefined) state.causeAttempt = attempt
    // 会话被用户打断时这次调用本来就会被取消（signal 联动）：那不是失败，
    // 不该在日志里刷一条 warn——它会和真正的失败混在一起，让排查失去信号。
    const aborted = (input.signal as { aborted?: unknown } | undefined)?.aborted === true
    if (!aborted) {
      // 静默降级：没有 cause 的骨架仍是可用的骨架（确定性标签还在），
      // 而这一轮对话绝不该为一句"为什么"多等一次失败。
      state.causeFailure = {
        stage: 'llm-error',
        message: error instanceof Error ? error.message : String(error),
      }
      context.logger.warn('[dsh-tri-layer-memory] 骨架 cause 补全失败（保留确定性标签）：%s',
        error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (linkable) (external as EventTarget).removeEventListener('abort', onAbort)
  }
}
