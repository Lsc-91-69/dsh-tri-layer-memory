/**
 * budget.ts — 注入预算仲裁（统一层的核心价值）。
 *
 * 三层记忆本身会往每一轮请求里加三块文本：L1 窗口标记、L2 摘要、L3 索引。
 * 而当 profile 里还装着别的注入方时（`dsh-memory-vault` 每轮注入最多
 * `injectLimit` 条事实、`dsh-mcp-lens` 替换整个 MCP 工具面、
 * `dsh-headroom` 压缩工具输出），上下文预算就不再是"本插件自己省着点"能解决的
 * ——需要有人按优先级分配。
 *
 * 本模块就是那个分配者：给定一份 token 预算，按优先级保留、必要时截断、最后丢弃。
 * 它是纯函数，因此可以脱离运行时单测（见 test/layers.test.mjs）。
 *
 * **为什么是"截断"而不只是"丢弃"**：L2 摘要的价值随长度单调递减，但归零很浪费
 * ——一段被截到一半的摘要仍然保留了任务主线和关键决策，比完全消失有用得多。
 *
 * **主线骨架不在这里仲裁**：它有自己的独立上限，见 {@link fitMainline}。
 *
 * @module dsh-tri-layer-memory/budget
 */
import { estimateTokens } from './l1-working.ts'
import { pruneMainlineForInjection, renderMainline, renderPrunedMainline } from './milestones.ts'
import type { Milestone } from './milestones.ts'

/** 参与仲裁的一块注入内容。 */
export interface InjectionBlock {
  /** 层级标识，用于报告"谁被丢了"。 */
  id: 'l1' | 'l2' | 'l3'
  /** 正文。 */
  text: string
  /**
   * 优先级，越小越先保留：
   * L1=0（只有窗口边界，最便宜且是原文可信度的锚点）、
   * L2=1（真正的信息载荷）、L3=2（只是索引，可以再查）。
   */
  priority: number
  /** 是否允许被截断；L1 是一行标记，截断没有意义。 */
  truncatable: boolean
  /**
   * 截断时的收尾说明（默认 {@link TRUNCATION_SUFFIX}）。
   *
   * 需要它是因为"剩下的怎么拿回来"因块而异：L3 索引按关键词/id 召回就行，而 L2
   * 摘要的正文不在 L3 里（见 {@link L2_TRUNCATION_NOTE}）。
   */
  truncationNote?: string
  /**
   * 是否为这块预留额度（而不是按优先级排队抢剩下的）。
   *
   * **为什么 L3 索引必须预留**：L3 索引是"模型知道还有东西可以 recall"的唯一入口，
   * 约 80–120 tokens，价值/体积比是全插件最高的。而旧实现让它排在 L2 后面抢剩余
   * 预算——预算 1000 时 L2 恰好不再被截断、吃满预算，L3 就被整块丢弃（实测
   * `dropped: ["l3"]`、`l3Tokens: 0`）。一个"调高预算反而更差"的非单调结果，
   * 根因不是预算不够，而是**没有保底**：索引这种"没有替代品"的块不能参与零和竞争。
   *
   * 预留额度会在其他块之前从预算里扣掉；未用完的部分仍会回到公共池（见
   * {@link arbitrateInjection} 的实现），所以它不会白占预算。
   */
  pinned?: boolean
  /**
   * 保底形态：整块放不下时至少注入这段（一行）。
   *
   * 与 {@link truncationNote} 的分工：截断是"把正文切一半再补一句收尾"，它要求正文
   * 本身可切；L3 索引切成半截就是一行断句，没有行动价值。所以索引的降级形态是
   * 重新渲染的**一行**（`另有 N 条可 recall`），而不是截断。
   *
   * 只在 `pinned === true` 时生效。
   */
  floorText?: string
}

/** 仲裁结果。 */
export interface Arbitration {
  /** 保留下来的块（按原优先级顺序）。 */
  kept: InjectionBlock[]
  /** 被完全丢弃的块 id。 */
  dropped: string[]
  /** 被截断的块 id。 */
  truncated: string[]
  /**
   * 被降级成保底形态（{@link InjectionBlock.floorText}）的块 id。
   *
   * 与 {@link truncated} 分开报：一个是"正文被切短"，一个是"换成了另一份更短的
   * 渲染"。混在一起，报告就无法回答"这一层到底还剩多少信息"。
   */
  degraded: string[]
  /** 保留内容的总估算 token 数。 */
  tokens: number
  /** 本次使用的预算。 */
  budgetTokens: number
  /** 仲裁前的总估算 token 数。 */
  requestedTokens: number
}

/** 截断后至少保留这么多字符，否则不如整块丢弃。 */
const MIN_TRUNCATED_CHARS = 120

/**
 * 截断块的**默认**收尾说明；它本身也占 token，必须算进预算。
 *
 * 块可以用 {@link InjectionBlock.truncationNote} 换一条更贴自己语义的说明——L2 摘要
 * 就换了，见 {@link L2_TRUNCATION_NOTE}。
 */
const TRUNCATION_SUFFIX = '\n…（本块因注入预算被截断；完整内容可用 recall 取回）'

/**
 * L2 摘要块专用的截断说明。
 *
 * **为什么要点名 `includeDigest`**：这句话是对模型说的"剩下的怎么拿回来"。L3 索引块
 * 按关键词/id 召回就行，但 **L2 摘要的正文不在 L3 里**——当前摘要只活在会话状态里
 * （`state.digest`），只有被新摘要取代时才会落库，而 `memory_recall` 默认不返回它。
 * 只说"可用 recall 取回"会让模型召回一堆 L3 记录，却永远拿不到被截断的摘要尾部，
 * 那是个"看起来给了出路、其实走不通"的说明。
 *
 * **为什么比默认那条更短**：预算压到下限时（实测 200 tokens），截断说明的长度直接
 * 决定这块是"还能留一段摘要"还是"整块丢弃"——把说明加长 19 tokens 后，同一个场景
 * 从截断（used 181）变成丢弃（used 139），模型手里什么都没剩下。所以换说明的前提是
 * 它必须比被替换的那条更便宜。
 */
export const L2_TRUNCATION_NOTE = '\n…（截断；全文用 recall + includeDigest: true 取回）'

/**
 * 尝试把一个块截断到 `remaining` 个 token 以内。
 *
 * 估算有误差，所以先按比例算一个起点，再逐步收缩直到确实放得下——
 * 宁可少留一点，也不能让投影超预算。
 *
 * @param block - 待截断的块。
 * @param remaining - 可用 token 数。
 * @returns 截断后的正文，或 null 表示放不下（应整块丢弃）。
 */
function truncateToFit(block: InjectionBlock, remaining: number): string | null {
  const suffix = block.truncationNote ?? TRUNCATION_SUFFIX
  const suffixCost = estimateTokens(suffix)
  const allowance = remaining - suffixCost
  if (allowance <= 0) return null
  const cost = Math.max(1, estimateTokens(block.text))
  let keepChars = Math.floor(block.text.length * (allowance / cost) * 0.9)
  for (let attempt = 0; attempt < 6 && keepChars >= MIN_TRUNCATED_CHARS; attempt += 1) {
    const text = `${block.text.slice(0, keepChars)}${suffix}`
    if (estimateTokens(text) <= remaining) return text
    keepChars = Math.floor(keepChars * 0.8)
  }
  return null
}

/**
 * 保底块（pinned）预留**完整**形态的条件：留下完整索引后，其他块至少还能分到
 * 这么多 token。
 *
 * **为什么需要这条门槛**：预算最紧时（实测 200）如果无条件为 L3 索引预留完整
 * 形态，摘要会被挤成 0；反过来，无条件只留一行又会让充裕预算下的完整索引也消失。
 * 120 是"摘要块头 + 覆盖区间 + 一句结论"的量级，低于它摘要就不再可读。
 *
 * 于是 200 档得到 L1(≈30) + L2(≈140) + L3 一行(≈30)，而 400 档及以上得到
 * 完整索引（≈120 + L2）。两档的保留内容都是**严格增加**的，不会出现旧实现里
 * "1000 比 800 更差"的非单调。
 */
const PINNED_FULL_ROOM = 120

/**
 * 按预算仲裁注入块。
 *
 * 规则：
 * 0. `pinned` 块（L3 索引）先预留额度：能留下完整形态且不影响摘要最低份额时留完整，
 *    否则留一行保底形态。**预留额度不占用别处的空间**——没用完的部分回公共池。
 * 1. 其余块按优先级升序依次尝试放入；能整块放下就整块放。
 * 2. 放不下但剩余预算还够 {@link MIN_TRUNCATED_CHARS} 个字符，就截断填入。
 * 3. 剩余预算太少则丢弃该块，并继续尝试优先级更低的块
 *    （低优先级块可能更小，仍有机会放进剩余空间）。
 * 4. `truncatable: false` 的块要么整块保留，要么整块丢弃——截断会破坏它的语义。
 *
 * **为什么把保底放在最前面**：旧实现完全按 `priority` 排队（L1 → L2 → L3），
 * 而 L2 是"能被截断、也会吃满剩余"的块。预算一高，L2 不再截断、整块放入，
 * L3 就一个 token 都不剩——**提高预算反而丢掉一层**。保底把"不可替代的索引"
 * 从零和竞争里摘出来：预算升高只会让它从一行升到完整，形态单调不变差。
 *
 * @param blocks - 待仲裁的块（顺序无关，按 `priority` 处理）。
 * @param budgetTokens - 本次允许的 token 上限。
 * @returns 仲裁结果。
 */
export function arbitrateInjection(
  blocks: readonly InjectionBlock[],
  budgetTokens: number,
): Arbitration {
  const budget = Math.max(0, Math.trunc(budgetTokens))
  const requested = blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0)
  const ordered = [...blocks].sort((a, b) => a.priority - b.priority)

  const kept: InjectionBlock[] = []
  const dropped: string[] = []
  const truncated: string[] = []
  const degraded: string[] = []

  // ── 阶段 0：为 pinned 块预留额度 ──────────────────────────────────────
  // 先扣掉"既不可截断、也不参与竞争"的块（L1 标记）：它是原文可信度的锚点，
  // 被保底块挤掉就整块消失，所以它的成本必须从可预留预算里先扣除。
  const hardCost = ordered
    .filter((block) => block.pinned !== true && !block.truncatable)
    .reduce((sum, block) => sum + estimateTokens(block.text), 0)

  // 只记"这个块预留了多少"；形态在阶段 2 按实际剩余预算重新判断（可能升级）。
  const reservedCost = new Map<string, number>()
  let reserved = 0
  for (const block of ordered) {
    if (block.pinned !== true) continue
    const fullCost = estimateTokens(block.text)
    const floorCost = block.floorText === undefined ? fullCost : estimateTokens(block.floorText)
    const room = Math.max(0, budget - hardCost - reserved)
    // 有保底形态时，只有"留完整形态后仍够摘要最低份额"才预留完整成本。
    // 没有保底形态的 pinned 块只能整块留或整块丢（语义与 truncatable:false 一致）。
    const keepFull = block.floorText === undefined || room - fullCost >= PINNED_FULL_ROOM
    const cost = keepFull ? fullCost : floorCost
    if (cost > room) continue
    reservedCost.set(block.id, cost)
    reserved += cost
  }

  // ── 阶段 1：非 pinned 块按优先级分配"公共池" ──────────────────────────
  // 公共池 = 总预算 − 已预留。预留没用完的部分会在阶段 2 自动回流。
  const openBudget = Math.max(0, budget - reserved)
  let usedByOpen = 0
  for (const block of ordered) {
    if (block.pinned === true) continue
    const cost = estimateTokens(block.text)
    const remaining = openBudget - usedByOpen
    if (cost <= remaining) {
      kept.push(block)
      usedByOpen += cost
      continue
    }
    if (block.truncatable) {
      const truncatedText = truncateToFit(block, remaining)
      if (truncatedText !== null) {
        kept.push({ ...block, text: truncatedText })
        usedByOpen += estimateTokens(truncatedText)
        truncated.push(block.id)
        continue
      }
    }
    dropped.push(block.id)
  }

  // ── 阶段 2：pinned 块落地 ─────────────────────────────────────────────
  // 按"总预算 − 已用"判断形态。公共池没花完时这里会自动升级成完整形态，
  // 这正是"预算升高 → 结果不减少"的那一半保证。
  let used = usedByOpen
  for (const block of ordered) {
    if (block.pinned !== true) continue
    const plan = reservedCost.get(block.id)
    if (plan === undefined) {
      dropped.push(block.id)
      continue
    }
    const available = budget - used
    const fullCost = estimateTokens(block.text)
    if (available >= fullCost) {
      kept.push(block)
      used += fullCost
      continue
    }
    const floorCost = block.floorText === undefined ? fullCost : estimateTokens(block.floorText)
    if (block.floorText !== undefined && available >= floorCost) {
      kept.push({ ...block, text: block.floorText })
      used += floorCost
      degraded.push(block.id)
      continue
    }
    dropped.push(block.id)
  }

  // 按优先级排回去，让投影读起来仍是 L1 → L2 → L3（调用方传入的顺序不作数）。
  kept.sort((a, b) => a.priority - b.priority)

  return {
    kept,
    dropped,
    truncated,
    degraded,
    tokens: used,
    budgetTokens: budget,
    requestedTokens: requested,
  }
}

/**
 * 估算其他注入方的已知占用，用于状态报告。
 *
 * 只报**可确知**的数字（配置里的条数上限、工具个数），不猜内容长度——
 * 猜出来的 token 数比没有数字更误导。
 *
 * @param contributors - 每个注入方的已知事实。
 * @returns 面向人的摘要行。
 */
export function describeContributors(
  contributors: ReadonlyArray<{ label: string; detail: string }>,
): string[] {
  return contributors.map((c) => `- ${c.label}：${c.detail}`)
}

// ── 主线骨架：独立上限，不进仲裁 ──────────────────────────────────────────

/** 骨架按独立上限裁剪后的结果。 */
export interface MainlineFit {
  /** 可直接注入的骨架文本（含块头与任务标题行）。 */
  text: string
  /** 裁剪后文本的估算 token 数。 */
  tokens: number
  /** 保留下来的里程碑条数。 */
  kept: number
  /** 因条数/token 上限被丢掉的里程碑条数。 */
  dropped: number
  /** 本次使用的独立上限。 */
  maxTokens: number
  /** 本次使用的条数上限。 */
  maxMilestones: number
  /** 是否发生过裁剪（报告用：静默裁剪比裁剪本身更危险）。 */
  trimmed: boolean
  /**
   * 因"标题也是空话"而整条不注入的条数（信息量剪枝，与上限裁剪无关）。
   *
   * 单独计数而不是并进 {@link dropped}：两者语义不同——一个是"装不下"，
   * 一个是"不值得装"。混在一起，报告就无法回答"省下来的到底是预算还是废话"。
   */
  infoPruned: number
  /** 因"标题自身就是结论"而只去掉 cause 的条数。 */
  causeStripped: number
  /** 信息量剪枝相对全量骨架省下的估算 token（未裁上限时）。 */
  prunedTokens: number
}

/**
 * 把主线骨架裁到它**自己的**上限以内。
 *
 * **为什么骨架不参与 {@link arbitrateInjection}**：那份仲裁是按优先级分配同一份
 * `injectionBudgetTokens`，预算一紧就先丢低优先级块。骨架恰恰是"主内容不遗忘"
 * 这个承诺的载体——它必须在场，而不是"预算够的时候在场"。让它去和 L1/L2/L3 抢
 * 同一份预算，等于让承诺随预算打折：真正需要长期在场的它，会是最先被丢的那个。
 * 所以这里给它一条独立上限：不与任何其他注入方竞争，超了只裁自己。
 *
 * 裁剪规则（两种上限同向）：**保留任务标题行，从最旧的里程碑开始丢**。
 * 越新的里程碑越接近"当前在哪、卡在哪"，越旧的越可能已被 L2/L3 覆盖；
 * 而任务标题行是整份骨架的锚点，丢了骨架就不再是"这个会话在做什么"。
 * 刻意整条丢而不是截断半行：半条里程碑是不可读的噪声，不如不要。
 *
 * @param milestones - {@link extractMilestones} 的输出（按 seq 升序）。
 * @param taskTitle - 会话任务标题；给了就保留在块首。
 * @param maxTokens - 骨架独立 token 上限。
 * @param maxMilestones - 骨架条数上限。
 * @returns 裁剪结果（里程碑为空时仍返回块头，调用方不必判空）。
 */
export function fitMainline(
  milestones: readonly Milestone[],
  taskTitle: string | undefined,
  maxTokens: number,
  maxMilestones: number,
): MainlineFit {
  const budget = Math.max(0, Math.trunc(maxTokens))
  const cap = Math.max(0, Math.trunc(maxMilestones))

  // 信息量剪枝先于上限裁剪：模板 cause 和纯空话条目本来就不该占"最近 N 条"的名额。
  // 顺序反过来的话，60 条上限里会先被空话占满，真实条目再被这条上限挤出去——
  // 那等于给废话发预算。清单（dropped/stripped）留在结果里供人工复核。
  const pruned = pruneMainlineForInjection(milestones)
  const fullTokens = estimateTokens(renderMainline(milestones, taskTitle))
  const prunedFullTokens = estimateTokens(renderPrunedMainline(pruned.lines, taskTitle))

  // 条数上限先夹一次：留最近的，理由与 token 裁剪一致。
  let kept = cap === 0 ? [] : pruned.lines.slice(Math.max(0, pruned.lines.length - cap))
  let dropped = pruned.lines.length - kept.length
  let text = renderPrunedMainline(kept, taskTitle)

  // token 上限是**渲染后**实测的：块头、标题行、行号前缀都算在内，
  // 这样"装得下"就是真的装得下，而不是按条目数估算出来的假保证。
  while (kept.length > 0 && estimateTokens(text) > budget) {
    kept = kept.slice(1)
    dropped += 1
    text = renderPrunedMainline(kept, taskTitle)
  }

  return {
    text,
    tokens: estimateTokens(text),
    kept: kept.length,
    dropped,
    maxTokens: budget,
    maxMilestones: cap,
    trimmed: dropped > 0,
    infoPruned: pruned.dropped.length,
    causeStripped: pruned.stripped.length,
    prunedTokens: fullTokens - prunedFullTokens,
  }
}
