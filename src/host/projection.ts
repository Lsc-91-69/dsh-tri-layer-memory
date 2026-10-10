/**
 * projection.ts — 「思维栏」的数据通道：把三层记忆的当前读数发布成 session projection。
 *
 * 对话/轨迹旁边的第三个标签页（`conversation.view`）不自己算任何东西：宿主每轮
 * pre-step 把三层读数喂进这里，`wire.view` 产出按 key 的完整值，框架负责送到浏览器。
 * 客户端用 `useProjection('tri-layer-memory')` 读——**key 是两侧唯一的接口**，
 * 因此 {@link PROJECTION_KEY} 与 `src/client.js` 里的字符串必须逐字一致。
 *
 * **为什么需要一份 feed，而不是像上游那样纯折叠事件**：上游每个 projection 单元
 * 都是「事件 → 状态」的纯函数，而三层记忆的读数里有两样东西根本不来自事件流——
 * L2 摘要是模型产物（要真的调一次 LLM），L3 是跨会话共享的一个本地库
 * （`store.stats()`）。宿主是唯一计算点，所以这里保留一份按会话的 feed：
 * `apply` 在 feed **真的变了**时把它折进状态，没变的 feed 原样返回同一个引用——
 * 框架用 `Object.is` 比较状态与视图，返回新对象会产生无谓的下游工作与广播。
 *
 * **为什么 `apply` 还要一个 `hydrate` 回调**：feed 过去只由 `agent/pre-step` 写，
 * 而进程刚起来时一次都没跑过。框架在**第一次读**投影时是 `init` + 逐事件 `apply`
 * 折叠整份会话日志（session-projection 的 `buildCell`/`advanceCell`），折的是 feed
 * 表——表是空的，于是"打开 DSH"看到的就是空骨架（客户端显示"记忆层尚未就绪"），
 * 要跑完一轮才补上。`hydrate` 让折叠本身就能补算：宿主按会话 id 找回活会话、算出
 * 三层读数写进 feed，紧接着的那次 `apply` 就把它折进状态。它只在该会话还没有 feed
 * 时被调用（每个会话每进程至多一次），失败也只是没有内容，不影响折叠。
 *
 * **为什么 `sessionId` 存在状态里**：feed 是进程内的活对象，而状态会被
 * session-projection-cache 落盘、恢复时经 `stateSchema.parse()` 变成一份**副本**。
 * 状态里留着会话 id，恢复后的 `apply` 才能重新绑回本进程的活 feed，而不是抱着
 * 一份过期的副本不动。
 *
 * @module dsh-tri-layer-memory/projection
 */
import { z } from 'zod'
import type { MemoryRecord } from './l3-deep.ts'
import type { Milestone } from './milestones.ts'

/** 投影 key：宿主注册与客户端读取共用的同一个字符串。 */
export const PROJECTION_KEY = 'tri-layer-memory'

/**
 * 客户端视图里 L3 记录的条数上限（按新近度降序取）。
 *
 * 投影体是要整体过线、进浏览器内存的：L3 是跨会话共享的库，长期使用后条数无上限，
 * 不设这道闸门的话，一个 key 的投影会随库增长而无界膨胀。
 */
export const MAX_VIEW_RECORDS = 200

/**
 * 进程内保留的 feed 条数上限。
 *
 * feed 按会话 id 索引，而会话 id 是字符串（不是对象），因此没法用 WeakMap 自动回收。
 * 留着这条上限，跨几十个会话之后内存占用仍有界。
 */
const MAX_FEEDS = 64

/**
 * 冷读兜底累积的事件条数上限（见 {@link ProjectionOptions.derive}）。
 *
 * 20,000 条覆盖了本机实测最长的会话（12,033 条）还留了余量。超限后不再累积，
 * 派生出来的读数会是一份"截断日志"的读数——比整块空面板好，而且这类超长会话
 * 只要跑过一轮 pre-step 就有 feed，走不到这条兜底。
 */
const MAX_DERIVE_EVENTS = 20_000

/** 骨架的一行（与 `Milestone` 同口径，但不带 detail/tokens——那是宿主内部的东西）。 */
export interface TriLayerMainlineEntry {
  /** 轮号；跨轮条目是起始轮。 */
  turn: number
  /** 跨轮条目的结束轮；单轮条目不设此字段。 */
  turnTo?: number
  /** 发生了什么。 */
  title: string
  /** 「—」后面那句原因。 */
  cause: string
  /** 中文分类。 */
  category: string
}

/** L1 工作记忆读数。 */
export interface TriLayerL1 {
  /** 保留轮数配置。 */
  retainTurns: number
  /** 当前留在窗口里的轮数。 */
  turns: number
  /** 已溢出、进入 L2/L3 的轮数。 */
  evicted: number
}

/** L2 短期记忆读数。 */
export interface TriLayerL2 {
  /** 摘要正文。 */
  summary: string
  /** 覆盖区间起点轮。 */
  turnFrom: number
  /** 覆盖区间终点轮。 */
  turnTo: number
  /** 摘要方式（llm / extractive）。 */
  mode: string
}

/**
 * L3 里的一条记录（正文照给：思维栏是给人看的检查面，不是模型上下文）。
 *
 * **`sessionId` 是必须的，不是可选的装饰**：L3 是**跨会话共享**的一个库，而列表是按
 * 新近度降序的整库前 200 条。没有它，别的会话的「第 3 轮」在思维栏里看起来和本会话的
 * 「第 3 轮」一模一样——那是一个真实的误读风险（读者会把别人会话的轮次当成自己的）。
 */
export interface TriLayerRecord {
  id: string
  kind: string
  turnFrom: number
  turnTo: number
  text: string
  tokens: number
  /** 这条记录**属于哪个会话**（L3 是共享库，轮次号只有配上它才有意义）。 */
  sessionId: string
  /**
   * 是不是**本会话**的记录。
   *
   * 由宿主算好再发布，而不是让客户端拿 `record.sessionId` 去和"自己的会话 id"比：
   * 客户端没有可靠的会话 id 来源（`useProjection` 只给投影值，槽位 props 里没有
   * session id），而"哪个是本会话"正是这个字段存在的全部意义——判错等于没加。
   */
  own: boolean
}

/** L3 深层记忆读数。 */
export interface TriLayerL3 {
  /** 实际后端；未打开时为 null。 */
  backend: string | null
  /** 库里的记录总数（跨会话共享）。 */
  count: number
  /** 库里的 token 合计。 */
  tokens: number
  /**
   * **本会话**写进库里的条数。
   *
   * L3 是跨会话共享的一个库，`count` 是整库规模——只看它会把"这个会话积累了多少"
   * 误读成整库的数字（用户报过这个口径问题）。两个口径一起给，读者不必自己去减。
   */
  sessionCount: number
  /** **本会话**写进库里的 token 合计。 */
  sessionTokens: number
  /** 本状态的会话 id：列表里 `own === true` 的那些就是它的记录。 */
  sessionId: string
  /** 最近 {@link MAX_VIEW_RECORDS} 条记录，按新近度降序。 */
  records: TriLayerRecord[]
}

/** 客户端读到的完整值（`useProjection(PROJECTION_KEY)` 的返回类型）。 */
export interface TriLayerView {
  /** 会话任务标题；还没识别出来时为 null。 */
  taskTitle: string | null
  /** 主线骨架。 */
  mainline: TriLayerMainlineEntry[]
  /** 骨架各行的 token 合计（与上面列表同一口径）。 */
  mainlineTokens: number
  /** L1 读数。 */
  l1: TriLayerL1
  /** 当前 L2 摘要；还没有摘要时为 null。 */
  l2: TriLayerL2 | null
  /** L3 读数与记录。 */
  l3: TriLayerL3
  /** 本插件 recall 工具的实际名字（重名仲裁后的结果）。 */
  recallTool: string
  /** 最近一次**内容变化**的时间（epoch ms）；0 表示还没喂过任何读数。 */
  updatedAt: number
}

/**
 * 运行时校验器。
 *
 * `stateSchema.parse()` / `viewSchema.parse()` 是**框架的运行时调用**（读缓存行、
 * 发布前校验），所以这里必须是真正的 Zod 而不是一个形状对的普通对象：校验失败
 * 就是抛错，而抛错发生在框架侧，插件收不到——因此 schema 与上面的接口必须逐字对应。
 */
const mainlineEntrySchema = z.object({
  turn: z.number(),
  turnTo: z.number().optional(),
  title: z.string(),
  cause: z.string(),
  category: z.string(),
})

const l1Schema = z.object({
  retainTurns: z.number(),
  turns: z.number(),
  evicted: z.number(),
})

const l2Schema = z.object({
  summary: z.string(),
  turnFrom: z.number(),
  turnTo: z.number(),
  mode: z.string(),
})

const recordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  turnFrom: z.number(),
  turnTo: z.number(),
  text: z.string(),
  tokens: z.number(),
  // 这两个字段必须进 schema：`viewSchema.parse()` 是框架在发布前真的会调的校验，
  // 少一个字段就是运行时抛错，而抛错发生在框架侧、插件收不到（表现为"思维栏空着"）。
  sessionId: z.string(),
  own: z.boolean(),
})

const l3Schema = z.object({
  backend: z.string().nullable(),
  count: z.number(),
  tokens: z.number(),
  sessionCount: z.number(),
  sessionTokens: z.number(),
  sessionId: z.string(),
  records: z.array(recordSchema),
})

const stateSchema = z.object({
  sessionId: z.string(),
  rev: z.number(),
  updatedAt: z.number(),
  taskTitle: z.string().nullable(),
  mainline: z.array(mainlineEntrySchema),
  mainlineTokens: z.number(),
  l1: l1Schema,
  l2: l2Schema.nullable(),
  l3: l3Schema,
  recallTool: z.string(),
})

const viewSchema = z.object({
  taskTitle: z.string().nullable(),
  mainline: z.array(mainlineEntrySchema),
  mainlineTokens: z.number(),
  l1: l1Schema,
  l2: l2Schema.nullable(),
  l3: l3Schema,
  recallTool: z.string(),
  updatedAt: z.number(),
})

/** 投影状态：feed 的最近一次内容 + 版本水位。 */
export interface ProjectionState {
  /** 本状态归属的会话 id（恢复后据此重新绑定活 feed）。 */
  sessionId: string
  /** 已折进本状态的 feed 版本；-1 表示还没折过任何读数。 */
  rev: number
  /** 最近一次内容变化的时间。 */
  updatedAt: number
  taskTitle: string | null
  mainline: TriLayerMainlineEntry[]
  mainlineTokens: number
  l1: TriLayerL1
  l2: TriLayerL2 | null
  l3: TriLayerL3
  recallTool: string
}

/** 宿主每轮喂进来的原始读数（这里只做归一与裁剪，不做任何计算）。 */
export interface TriLayerFeedInput {
  /** 会话任务标题；null/缺省表示还没识别出来。 */
  taskTitle?: string | null
  /** 主线骨架（`extractMilestones` 的输出，按时间升序）。 */
  mainline?: readonly Milestone[]
  /** 骨架的 token 数；缺省按各条里程碑的 tokens 求和。 */
  mainlineTokens?: number
  /** L1 窗口读数。 */
  l1: TriLayerL1
  /** 当前 L2 摘要；null 表示还没有。 */
  l2: TriLayerL2 | null
  /** L3 库读数与记录（顺序任意，这里按新近度降序截断）。 */
  l3: { backend: string | null; count: number; tokens: number; records: readonly MemoryRecord[] }
  /** 本插件 recall 工具的实际名字。 */
  recallTool: string
}

/**
 * 注册定义的最小结构面（对齐上游 `ProjectionDefinition`）。
 *
 * 刻意不 import `@deepseek-ai/dsh-session-projection`：那是宿主的包，插件在宿主
 * 模块回退层缺失时解析不到它，一个类型 import 也不值得让整个插件 import 失败。
 * 结构对得上就能注册，类型由宿主侧保证。
 */
export interface ProjectionDefinitionLike {
  key: string
  stateVersion: number
  stateSchema: { parse(value: unknown): unknown }
  init(header: { id?: unknown }, inheritedEventCount: number): ProjectionState
  apply(state: ProjectionState, event: { type?: unknown; seq?: unknown }): ProjectionState
  wire: {
    viewSchema: { parse(value: unknown): unknown }
    view(state: ProjectionState): TriLayerView
  }
}

/**
 * 一次 `apply` 的观察结果（诊断用；{@link ProjectionOptions.observe}）。
 *
 * 存在的理由：`apply` 是宿主侧唯一能看到"框架到底有没有把事件折进来"的地方，
 * 而这条链过去**完全没有观察面**——补算失败被 `try {} catch {}` 吞掉，
 * "框架从没调用过 apply" 与 "调用了但没 feed" 在外部看起来一模一样。
 */
export interface ProjectionObservation {
  /** 本次 apply 时本会话有没有 feed（false = 还没喂过读数，会尝试补算）。 */
  hasFeed: boolean
  /** 折进去的 feed 版本；没有 feed 时为 null。 */
  feedRev: number | null
  /** 返回的 state 是否是新引用（框架据此决定重算视图与广播）。 */
  changed: boolean
  /** 本次是否因为"本会话没有 feed"而调用了 hydrate。 */
  hydrated: boolean
  /** hydrate 调用之后本会话有没有 feed（false = 补算这一记没落地）。 */
  hasFeedAfterHydrate: boolean
}

/** 思维栏投影实例。 */
export interface TriLayerProjection {
  /** 注册用的 key（与 {@link PROJECTION_KEY} 同值）。 */
  readonly key: string
  /** 交给 `ctx.sessionProjections.register(...)` 的定义。 */
  readonly definition: ProjectionDefinitionLike
  /**
   * 写入本会话的当前读数。
   * @param sessionId - 会话 id（`session.id`）。
   * @param input - 三层读数。
   * @param now - 当前时间（注入以便测试）；只在内容变化时采用。
   */
  feed(sessionId: string, input: TriLayerFeedInput, now?: number): void
  /** 丢掉一个会话的 feed（会话回收时调用，避免 Map 无界增长）。 */
  forget(sessionId: string): void
  /**
   * 本会话当前有没有 feed（诊断用）。
   *
   * "补算到底有没有把读数写进去"只能在这里问：`feed` 是静默的，而写进去与否
   * 决定了 `apply` 能不能折出内容——也就是客户端读到的值是不是 `updatedAt: 0`。
   * @param sessionId - 会话 id。
   * @returns 有 feed 时为 true。
   */
  hasFeed(sessionId: string): boolean
  /**
   * 本会话当前 feed 的版本号（诊断用）。
   * @param sessionId - 会话 id。
   * @returns 版本号；没有 feed 时为 null。
   */
  feedRev(sessionId: string): number | null
}

/** feed 的内容快照（不含时间戳与版本：内容相同就不该产生新版本）。 */
interface FeedSnapshot {
  taskTitle: string | null
  mainline: TriLayerMainlineEntry[]
  mainlineTokens: number
  l1: TriLayerL1
  l2: TriLayerL2 | null
  l3: TriLayerL3
  recallTool: string
}

/**
 * 读一条事件的 seq（缺失或形状不对时为 -1）。
 *
 * 只用于判断"这次折叠是不是从日志开头开始的"——那是派生读数可信的前提。
 *
 * @param event - 框架喂进 `apply` 的事件。
 * @returns seq 数值；读不到时为 -1。
 */
function seqOf(event: unknown): number {
  const seq = (event as { seq?: unknown } | null)?.seq
  return typeof seq === 'number' ? seq : -1
}

/** 未喂过任何读数时的空骨架。 */
function emptySnapshot(): FeedSnapshot {  return {
    taskTitle: null,
    mainline: [],
    mainlineTokens: 0,
    l1: { retainTurns: 0, turns: 0, evicted: 0 },
    l2: null,
    l3: { backend: null, count: 0, tokens: 0, sessionCount: 0, sessionTokens: 0, sessionId: 'unknown', records: [] },
    recallTool: 'memory_recall',
  }
}

/**
 * 把宿主读数归一成快照：跨轮条目补上 `turnTo`、L3 记录按新近度降序截断，
 * 并按会话拆出"本会话写进 L3 的量"。
 *
 * 截断放在这里而不是调用方，是因为「最多 200 条」是**接口的一部分**：客户端、
 * 测试与未来的其他读取方都按这条契约来，只有一处实现才不会有人漏掉它。
 * 同理，本会话口径也在这里算：`feed` 拿得到会话 id，而记录自带 `sessionId`，
 * 让每个读取方各自去数一遍既重复又容易数错（截断后只剩 200 条）。
 *
 * @param input - 宿主读数。
 * @param sessionId - 本状态的会话 id（用来把整库读数拆成本会话口径）。
 * @returns 可直接进状态的快照。
 */
function normalize(input: TriLayerFeedInput, sessionId: string): FeedSnapshot {
  const mainline = (input.mainline ?? []).map((milestone): TriLayerMainlineEntry => {
    const entry: TriLayerMainlineEntry = {
      turn: milestone.turn,
      title: milestone.title,
      cause: milestone.cause,
      category: milestone.category,
    }
    if (milestone.turnTo !== undefined && milestone.turnTo !== milestone.turn) entry.turnTo = milestone.turnTo
    return entry
  })
  const records = [...input.l3.records]
    // 新近度降序：id 是 `l3-<时间戳36>-<序号36>`，同一毫秒内的多条按 id 打破平局，
    // 保证顺序确定（否则同一份库两次渲染可能给出不同的前 200 条）。
    .sort((a, b) => (b.createdAt - a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, MAX_VIEW_RECORDS)
    .map((record): TriLayerRecord => ({
      id: record.id,
      kind: record.kind,
      turnFrom: record.turnFrom,
      turnTo: record.turnTo,
      text: record.text,
      tokens: record.tokens,
      // 整库列表里每一条都必须自报所属会话：L3 是共享库，缺了它别的会话的「第 3 轮」
      // 会被读成本会话的（用户报过这个误读风险）。`own` 顺手算好，客户端不必自己判。
      sessionId: record.sessionId,
      own: record.sessionId === sessionId,
    }))
  // 本会话口径按**整库**记录算，不能按上面截断后的 200 条算：老会话的条数会因此变少。
  let sessionCount = 0
  let sessionTokens = 0
  for (const record of input.l3.records) {
    if (record.sessionId !== sessionId) continue
    sessionCount += 1
    sessionTokens += record.tokens
  }
  return {
    taskTitle: input.taskTitle ?? null,
    mainline,
    // token 口径与列表一致：`Milestone.tokens` 就是按那一行渲染后的估算，
    // 因此缺省值取各行求和，而不是另算一份"整块"的 token（两种口径必然对不上）。
    mainlineTokens: input.mainlineTokens ?? (input.mainline ?? []).reduce((sum, milestone) => sum + milestone.tokens, 0),
    l1: { ...input.l1 },
    l2: input.l2 === null ? null : { ...input.l2 },
    l3: {
      backend: input.l3.backend,
      count: input.l3.count,
      tokens: input.l3.tokens,
      sessionCount,
      sessionTokens,
      sessionId,
      records,
    },
    recallTool: input.recallTool,
  }
}

/** 思维栏投影的可选接线。 */
export interface ProjectionOptions {
  /**
   * 本会话还没有 feed 时的补算回调（宿主侧提供）。
   *
   * 框架在第一次读投影时会 `init` + 逐事件 `apply` 折叠整份会话日志，这里就是
   * "打开会话即补算"的入口：回调把读数写进 feed，紧随其后的 `apply` 折进状态。
   * 回调必须自己吞掉全部失败——它跑在框架的折叠里，抛出去会打断折叠。
   *
   * @param sessionId - 状态里记着的会话 id。
   */
  hydrate?: (sessionId: string) => void
  /**
   * 每次 `apply` 之后回调一次（诊断用；不改变任何行为）。
   *
   * **为什么需要它**：`apply` 是"框架有没有真的在折本会话"的唯一证据来源。
   * 没有它就只能看最终值——而"从没被折叠过"和"折了但没 feed"给出同一个空值。
   * 回调必须自己吞错：它跑在框架的折叠里。
   *
   * @param sessionId - 本次折叠的会话 id。
   * @param observation - 本次 apply 的结果读数。
   */
  observe?: (sessionId: string, observation: ProjectionObservation) => void
  /**
   * 冷读兜底：用**折叠过程中累积到的事件**自己算一份读数。
   *
   * **为什么必须有它**（这是本次故障的根因所在）：客户端打开一个已存在的会话时，
   * 宿主走的是 session-query 的 prepared 路径——`sessions.prepare(...)` 造一个
   * **还没发布**的 Session，然后 `registry.restore(checkpoint, events, 0, …)` 折整份
   * 日志取投影值，客户端拿到的第一帧就是这份值。那一刻：
   * - `session/created` 还没发（发布发生在第一帧之后）；
   * - `sessions.get(id)` 拿不到 prepared 会话（`prepare` 的语义就是不进活表）；
   * 所以"按 id 找回活会话再补算"那条路在这个时刻**必然失败**，而 feed 表是空的
   * （新进程一次 pre-step 都没跑过）→ 折出来就是 `updatedAt: 0` → 面板"尚未就绪"。
   *
   * `apply` 唯一拿得到的东西就是事件，因此这是该时刻**唯一**可用的数据源。
   * 回调自己吞错；返回 null 表示"这次算不出内容"。
   *
   * @param sessionId - 正在折叠的会话 id。
   * @param events - 本次折叠到目前为止累积的事件（按 seq 升序）。
   * @returns 一份可直接喂进投影的读数；算不出时为 null。
   */
  derive?: (sessionId: string, events: readonly unknown[]) => TriLayerFeedInput | null
}

/**
 * 造一个思维栏投影实例。
 *
 * @param options - 可选接线；目前只有 {@link ProjectionOptions.hydrate}。
 * @returns 投影实例（`definition` 交给 sessionProjections，`feed` 由 pre-step 调用）。
 */
export function createTriLayerProjection(options?: ProjectionOptions): TriLayerProjection {
  const hydrate = options?.hydrate
  const observe = options?.observe
  const derive = options?.derive
  /** 活 feed：会话 id → 最近一次读数。 */
  const feeds = new Map<string, { rev: number; json: string; value: FeedSnapshot; updatedAt: number }>()
  /**
   * 折叠过程中累积的事件：会话 id → 事件数组。
   *
   * **只在"本会话还没有 feed"时累积**（见 `apply`）：内存占用因此只与"冷会话"
   * 数量相关，而与会话长度无关——有 feed 的会话读数由宿主喂，不需要第二份副本。
   * 攒到 {@link MAX_DERIVE_EVENTS} 条就不再增长（超长会话退化成"派生一份截断的
   * 读数"，也比整块空面板好；这类会话本来就会有 feed）。
   */
  const seen = new Map<string, unknown[]>()
  /**
   * 视图缓存，按状态对象索引。
   *
   * 框架在状态引用变化时会调 `view`，并在**发布前**用 `Object.is` 比较两次原始视图
   * ——同一个状态对象永远得到同一个视图引用，才是"没有新内容就不广播"。
   */
  const views = new WeakMap<ProjectionState, TriLayerView>()
  let rev = 0

  const definition: ProjectionDefinitionLike = {
    key: PROJECTION_KEY,
    // **改动状态形状或折叠语义就必须动这个版本号**：框架只在 `ver` 与这里的值
    // 相等时才用落盘缓存行（`restore`/`viewCheckpoint`），不等就把它当过期行丢掉、
    // 从 `init` 重新折叠。所以形状变了却不改版本号，旧行会以"能解析但少字段"的形式
    // 被塞回来（Zod 直接抛错，而抛错发生在框架侧）。
    // 1 = 增加 l3 的本会话口径（sessionCount / sessionTokens，见 TriLayerL3）。
    // 2 = **折叠语义变了**：读数不再只由 pre-step 写，`apply` 在"本会话还没有 feed"
    //     时会补算一次（见 ProjectionOptions.hydrate）。版本 1 的行是"补算还没进
    //     代码时"折出来的——它们的 `rev = -1 / updatedAt = 0` 会被 `restore` 当成
    //     可用行直接喂给客户端，而 `restore` **只在检查点之后的事件上调用 `apply`**；
    //     检查点又总是写在日志末尾，于是补算这条路对老会话**一次都不会被走到**，
    //     面板继续显示"尚未就绪"。不动版本号 = 新代码对老会话永远不可达。
    // 3 = **形状变了**：L3 记录多出 `sessionId` / `own`，`l3` 段多出 `sessionId`
    //     （见 TriLayerRecord）。版本 2 的行里那些记录**没有**这两个字段，而
    //     `viewSchema.parse()` 会因此直接抛错（抛错在框架侧，插件收不到，表现就是
    //     "思维栏空着"）——这正是必须 bump 的原因，不是"顺手加一"。
    stateVersion: 3,
    stateSchema,
    init: (header) => ({
      sessionId: typeof header?.id === 'string' && header.id.length > 0 ? header.id : 'unknown',
      rev: -1,
      updatedAt: 0,
      ...emptySnapshot(),
    }),
    apply: (state, event) => {
      let feed = feeds.get(state.sessionId)
      let hydrated = false
      // 累积事件：**只在"本会话还没有 feed"时**攒，有 feed 的会话读数由宿主喂，
      // 不需要第二份副本（这条约束让内存占用只与"冷会话"数量相关，而不是会话长度）。
      // 为什么攒：冷读那一刻会话还没发布，`sessions.get(id)` 拿不到它——事件是唯一
      // 可用的数据源（见 ProjectionOptions.derive）。
      // **只从 seq 0 开始攒**：从日志开头折起的才代表整份日志，派生的读数才有意义；
      // 半路插进来的单条事件（已有 cell 的推进）攒出来的是残缺日志，那不该拿去
      // 顶替"尚未就绪"。
      if (feed === undefined && derive !== undefined) {
        const bucket = seen.get(state.sessionId)
        if (bucket === undefined) {
          if (seqOf(event) === 0) seen.set(state.sessionId, [event])
        } else if (bucket.length < MAX_DERIVE_EVENTS) {
          bucket.push(event)
        }
      }
      if (feed === undefined && hydrate !== undefined) {
        // 本进程还没喂过这个会话：插件晚于会话发布装载、HMR 重载，或者框架在
        // 会话发布之前就来读投影了。此刻框架正按日志折叠——这是唯一的补算时机。
        // 回调自己吞错；这里再兜一层，是因为折叠抛出去会打断整个投影单元。
        hydrated = true
        try {
          hydrate(state.sessionId)
        } catch {
          // 补算失败 = 这次折叠没有内容，与补算之前的行为一致。
        }
        feed = feeds.get(state.sessionId)
      }
      // 诊断：把"框架确实折过本会话"和"折的时候有没有 feed"记下来。observe 自己
      // 必须吞错——它跑在框架的折叠里，抛出去会打断整个投影单元。
      if (observe !== undefined) {
        try {
          observe(state.sessionId, {
            hasFeed: feed !== undefined,
            feedRev: feed?.rev ?? null,
            changed: feed !== undefined && !(feed.rev === state.rev && feed.updatedAt === state.updatedAt),
            hydrated,
            hasFeedAfterHydrate: feed !== undefined,
          })
        } catch {
          // 诊断回调失败只损失一条观察记录，绝不影响折叠。
        }
      }
      // 没有 feed、或 feed 就是状态里那一版（内容没变过）→ 原样返回同一个引用：
      // 框架据此跳过视图重算与广播。注意判定是"rev 与 updatedAt 都相同"而不是
      // 只看 rev：rev 是**进程内**计数器，恢复出来的状态带着上一个进程的 rev，
      // 与本次进程的计数器可能撞上同一个数。
      if (feed === undefined || (feed.rev === state.rev && feed.updatedAt === state.updatedAt)) return state
      // 折叠的时机**不再限定轮边界**：过去只认 turn/start|turn/end，于是 pre-step
      // 刚喂进来的读数要等到下一个轮边界才可见（用户看到的是"半轮延迟"）。现在
      // 只要 feed 真的变了就折——代价是框架多算一次视图，而这只发生在内容变化时。
      return { ...state, rev: feed.rev, updatedAt: feed.updatedAt, ...feed.value }
    },
    wire: {
      viewSchema,
      view: (state) => {
        const cached = views.get(state)
        if (cached !== undefined) return cached
        // 状态落后于现实时（落盘行 / 冷读折叠）优先发布更新鲜的那一份，
        // 而不是把一份过期状态渲染给客户端——见 fresherThanState。
        const built: TriLayerView = fresherThanState(state) ?? {
          taskTitle: state.taskTitle,
          mainline: state.mainline,
          mainlineTokens: state.mainlineTokens,
          l1: state.l1,
          l2: state.l2,
          l3: state.l3,
          recallTool: state.recallTool,
          updatedAt: state.updatedAt,
        }
        views.set(state, built)
        return built
      },
    },
  }

  /**
   * 写一份读数进 feed（返回对象的 `feed` 与 `view` 的派生兜底共用同一份实现）。
   *
   * @param sessionId - 会话 id。
   * @param input - 三层读数。
   * @param now - 时间戳；内容没变时不采用。
   */
  const writeFeed = (sessionId: string, input: TriLayerFeedInput, now = Date.now()): void => {
    const value = normalize(input, sessionId)
    const json = JSON.stringify(value)
    const previous = feeds.get(sessionId)
    // 内容没变就不推进版本：客户端不该为一份一模一样的读数重新渲染。
    if (previous !== undefined && previous.json === json) return
    rev += 1
    // 重插一次把该会话移到 Map 末尾，淘汰时先丢最久没更新的那个。
    feeds.delete(sessionId)
    feeds.set(sessionId, { rev, json, value, updatedAt: now })
    // feed 到了就不必再攒事件：读数由宿主喂，第二份副本只会白占内存。
    seen.delete(sessionId)
    if (feeds.size > MAX_FEEDS) {
      const oldest = feeds.keys().next()
      if (!oldest.done) feeds.delete(oldest.value)
    }
  }

  /**
   * 状态落后于现实时，返回更新鲜的那份视图；否则返回 null（按状态渲染）。
   *
   * 两条来源，按优先级：
   * 1. **feed 比状态新**：状态来自落盘检查点行，或折叠发生在 feed 落表之前——
   *    这正是真实故障里客户端读到 `updatedAt: 0` 的那条路。
   * 2. **状态空、又没有 feed**：用折叠过程中累积的事件派生一份（冷读路径；
   *    那一刻会话还没发布，`sessions.get(id)` 拿不到它，事件是唯一数据源）。
   *
   * @param state - 当前投影状态。
   * @returns 可直接发布的视图；没有更新鲜的内容时为 null。
   */
  const fresherThanState = (state: ProjectionState): TriLayerView | null => {
    let current = feeds.get(state.sessionId)
    if (current === undefined && derive !== undefined && state.updatedAt === 0) {
      const events = seen.get(state.sessionId)
      if (events !== undefined && events.length > 0) {
        try {
          const input = derive(state.sessionId, events)
          // 派生成功就写进 feed：后续 apply 会把它折进状态，下次读直接走状态。
          if (input !== null) {
            writeFeed(state.sessionId, input)
            current = feeds.get(state.sessionId)
          }
        } catch {
          // 派生失败 = 这次没有内容；按状态渲染（与派生之前的行为一致）。
        }
      }
    }
    if (current === undefined) return null
    // 状态就是这份 feed 折出来的 → 按状态渲染（两者等价，状态那份还更完整）。
    if (current.rev === state.rev && current.updatedAt === state.updatedAt) return null
    return { ...current.value, updatedAt: current.updatedAt }
  }

  return {
    key: PROJECTION_KEY,
    definition,
    feed: writeFeed,
    forget: (sessionId) => {
      feeds.delete(sessionId)
      seen.delete(sessionId)
    },
    hasFeed: (sessionId) => feeds.has(sessionId),
    feedRev: (sessionId) => feeds.get(sessionId)?.rev ?? null,
  }
}
