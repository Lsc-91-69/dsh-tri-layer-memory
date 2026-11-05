/**
 * l3-deep.ts — 第三层：深层记忆（Deep Memory）。
 *
 * 内容：非常早期的、可能不再频繁使用的对话内容（任务初期的大段文件读取、
 *      已废弃的方案讨论、被 L2 淘汰的摘要）。
 * 策略：高度浓缩 + 确定性剪枝（参考 dsh-argp 的原子引用图剪枝思路），
 *      跨会话持久化到本地，**不主动注入正文**，仅通过 `memory_recall` 按需检索。
 *
 * 存储后端二选一，由 `config.l3.store` 决定：
 * - `sqlite`：`node:sqlite`（Node 22.19+ 内置，零依赖），惰性 import，
 *   缺失时自动退回 JSONL 而不是让插件挂掉。
 * - `jsonl`：追加写 + 启动时全量读入内存。人类可读、崩溃安全、可手工 grep。
 *
 * 存储路径永不硬编码，见 config.ts 的 {@link defaultStorageDir}。
 *
 * @module dsh-tri-layer-memory/l3-deep
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from './l1-working.ts'

/** 一条深层记忆记录。 */
export interface MemoryRecord {
  /** 稳定 id（`l3-<时间戳36>-<序号36>`）。 */
  id: string
  /**
   * `digest` L2 淘汰下来的摘要；`turn` 单轮原文；`artifact` 工具产物/文件读取；
   * `milestone` 主线骨架的一条里程碑；`tool` 单轮工具输出的摘录。
   *
   * `milestone` 是**根节点**：它引用同轮范围内的 turn/digest 记录（`refs`），
   * 自己不携带细节正文——细节本来就在 L3 里，里程碑只是把散落的细节组织成故事。
   * 因此它永不参与剪枝（见 {@link selectPrunable}）：剪掉根节点等于把故事拆散。
   *
   * `tool` 是**细节池**：它的存活规则与其它 kind 完全分开（见 {@link selectPrunable}），
   * 既不计入 `maxRecords`，也不产出任何入边——否则"细节"会反过来挤掉主内容。
   */
  kind: 'digest' | 'turn' | 'artifact' | 'milestone' | 'tool'
  /** 写入时间（epoch ms）。 */
  createdAt: number
  /** 来源会话 id。 */
  sessionId: string
  /** 覆盖的轮号区间起点。 */
  turnFrom: number
  /** 覆盖的轮号区间终点。 */
  turnTo: number
  /** 浓缩后的正文。 */
  text: string
  /** 估算 token 数。 */
  tokens: number
  /** 关键词（检索与剪枝评分用）。 */
  keywords: string[]
  /** 本条引用的其他记录 id（原子引用图的边）。 */
  refs: string[]
}

/** 剪枝评分结果。 */
export interface ScoredRecord {
  record: MemoryRecord
  score: number
  /** 得分构成，便于 verify 工具解释"为什么留下/丢弃"。 */
  parts: { recency: number; relevance: number; inbound: number; density: number }
}

/** 剪枝统计。 */
export interface PruneOutcome {
  before: number
  after: number
  removed: string[]
  kept: string[]
}

/** 一个重复组的明细（memory_dedupe 的返回值、外部脚本的报告共用同一形状）。 */
export interface DedupeGroupReport {
  /** 分组键：会话 + 类别 + 轮范围。 */
  key: string
  sessionId: string
  kind: MemoryRecord['kind']
  turnFrom: number
  turnTo: number
  /** 组内副本数（含保留的那条）。 */
  copies: number
  /** 保留的记录 id。 */
  keepId: string
  /** 保留那条的正文长度。 */
  keepChars: number
  /**
   * 组内正文是否完全一致。
   *
   * 比的是**正文内容**而不是长度：长度相同但内容不同的两份，删掉其中一份同样会丢信息，
   * 必须被点名（此时没有"更长的那条"可留，按 createdAt 最新的规则保留并报告）。
   */
  identicalText: boolean
  /** 将被删除（dryRun 时是"计划删除"）的记录 id。 */
  removedIds: string[]
}

/** 去重结果。 */
export interface DedupeOutcome {
  /** 是否只报告不写盘。 */
  dryRun: boolean
  /** 限定会话；整库时为 null。 */
  sessionId: string | null
  /** 范围内的记录数（传 sessionId 时是该会话，不传是整库）。 */
  before: number
  /** 处理后范围内记录数（dryRun 时是"将会变成"）。 */
  after: number
  /** 删除条数（dryRun 时为计划删除条数）。 */
  removed: number
  /** 重复组数。 */
  groups: number
  /** 组内正文不一致的组数（这些组保留了最长的那条；长度相同则保留最新的）。 */
  differingGroups: number
  /** 改写过的引用条数（指向被删副本的 refs 已改指保留的那条）。 */
  refsRewritten: number
  /** 引用被改写的记录条数。 */
  recordsWithRefUpdates: number
  /** 写盘前的备份文件；未写盘或无需删除时为 null。 */
  backupPath: string | null
  /** 真的写了盘。 */
  applied: boolean
  /** 每组明细（按可删条数降序）。 */
  groupDetails: DedupeGroupReport[]
  /** 正文不一致的组（信息量最大的那些，单独列出便于人读）。 */
  differingGroupDetails: DedupeGroupReport[]
}

/** 重复读数（memory_state 用）。 */
export interface DuplicateSummary {
  /** 至少有 2 条副本的组数。 */
  groups: number
  /** 可删条数（每组份数 - 1 之和）。 */
  records: number
  /** 其中正文不一致的组数。 */
  differingGroups: number
}

/** 中文停用词/高频虚词：参与关键词抽取但没有区分度。 */
export const BASE_STOPWORDS: ReadonlySet<string> = new Set([
  '的', '了', '和', '是', '在', '我', '有', '就', '不', '人', '都', '一', '一个', '上', '也',
  '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'you', 'not',
  'but', 'have', 'has', 'had', 'its', 'it', 'is', 'of', 'to', 'in', 'on', 'as', 'at', 'by',
])

/**
 * 疑问/诉求类高频词——**必须按二元组列**，不能按原词列。
 *
 * 为什么（实测，不是推断）：`extractKeywords` 对 CJK 只切二元组，`为什么` 在
 * 「为什么预设会消失」里切出来的是 `为什` + `什么`，整词 `为什么` 根本不会成为
 * token（只有当整个 CJK 段恰好是 3–6 字的独立段、例如「为什么 readEvents …」里的
 * 空格分隔段，才会额外整段成一个 token）。所以只把「为什么」「有没有」原样加进来
 * 等于没加：查询照样带着 `为什`/`什么`/`有没` 去命中所有含这些词的解释性长文，
 * 而解释性长文（尤其 digest）几乎必然含它们，于是"为什么"三个字把无关记录排到前面。
 *
 * 每个多字疑问词的二元组都拆开列：为什么→为什；是不是→是不；能不能→能不；
 * 要不要→要不；有没有→有没（`没有` 已在基础词里）。
 */
export const QUESTION_STOPWORDS: ReadonlySet<string> = new Set([
  '什么', '怎么', '为什', '为何', '如何', '是否', '哪个', '哪里', '哪一', '哪些',
  '多少', '可以', '需要', '应该', '怎样', '有没', '是不', '能不', '要不',
  // 整词形式也留一份：CJK 段短到 2–6 字时 `extractKeywords` 会额外把整段当一个 token。
  '为什么', '有没有', '是不是', '能不能', '要不要',
])

/** 生产检索用的停用词集合：基础虚词 + 疑问词。 */
export const STOPWORDS: ReadonlySet<string> = new Set([...BASE_STOPWORDS, ...QUESTION_STOPWORDS])

/**
 * 抽取关键词：英文按词、CJK 按二元组，去掉停用词，按出现频次取前 N。
 *
 * 刻意不引入分词依赖：二元组对中文检索足够好，且完全确定性，可单测。
 *
 * @param text - 任意正文。
 * @param limit - 最多返回多少个关键词。
 * @param stopwords - 停用词集合。默认生产用的 {@link STOPWORDS}；留出这个参数是为了
 *   让 `scripts/ablate-retrieval.mjs` 能拿**同一份实现**对比"加疑问词前/后"，
 *   而不是在脚本里复制一份切词。
 * @returns 去重后的关键词数组。
 */
export function extractKeywords(
  text: string,
  limit = 24,
  stopwords: ReadonlySet<string> = STOPWORDS,
): string[] {
  const counts = new Map<string, number>()
  const bump = (token: string): void => {
    if (token.length < 2 || stopwords.has(token)) return
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const words = text.toLowerCase().match(/[a-z0-9_][a-z0-9_.\-/]{1,}/g) ?? []
  for (const w of words) bump(w)
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) continue
    for (let i = 0; i + 1 < run.length; i += 1) bump(run.slice(i, i + 2))
    if (run.length >= 2 && run.length <= 6) bump(run)
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

/** 关键词集合的重叠度（Jaccard），两个空集视为 0。 */
export function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let hit = 0
  for (const token of a) if (setB.has(token)) hit += 1
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : hit / union
}

/**
 * 确定性剪枝评分（0-LLM，完全可复现）。
 *
 * 四个分量对应 dsh-argp 原子引用图剪枝的四个直觉：
 * - `recency`：越新越值钱，半衰期 7 天。
 * - `relevance`：与当前任务关键词的重叠度——"只保留与任务链相关的逻辑节点"。
 * - `inbound`：被别的记录引用得越多越像"根节点"，剪掉它会扯断引用图。
 * - `density`：每 token 承载的关键词数，奖励浓缩、惩罚注水。
 *
 * @param records - 待评分记录。
 * @param taskKeywords - 当前任务链关键词（来自 L1 窗口）。
 * @param now - 当前时间（epoch ms），注入以便测试。
 * @returns 与输入同序的评分结果。
 */
export function scoreRecords(
  records: readonly MemoryRecord[],
  taskKeywords: readonly string[],
  now: number,
): ScoredRecord[] {
  const inboundCount = new Map<string, number>()
  for (const record of records) {
    for (const ref of record.refs) inboundCount.set(ref, (inboundCount.get(ref) ?? 0) + 1)
  }
  const maxInbound = Math.max(1, ...inboundCount.values())
  const halfLife = 7 * 24 * 60 * 60 * 1000

  return records.map((record) => {
    const age = Math.max(0, now - record.createdAt)
    const recency = 0.5 ** (age / halfLife)
    const relevance = overlap(record.keywords, taskKeywords)
    const inbound = (inboundCount.get(record.id) ?? 0) / maxInbound
    const density = record.tokens <= 0
      ? 0
      : Math.min(1, (record.keywords.length / record.tokens) * 12)
    const score = 0.30 * recency + 0.40 * relevance + 0.20 * inbound + 0.10 * density
    return { record, score, parts: { recency, relevance, inbound, density } }
  })
}

/**
 * 工具记录（`kind === 'tool'`）的独立条数上限。
 *
 * **为什么单独成池，而不是共用 `l3MaxRecords`**：`tool` 记录是"细节"，turn/milestone
 * 是"主内容"。共用上限时，每写一条工具细节就必然顶掉一条主内容——实测量级下
 * （一个会话 2,320 条工具结果）主内容会被整批挤掉。分开以后，主内容池的存活集合
 * 与"没有工具记录时"逐条相同（{@link selectPrunable} 的 metric 不变），工具池自己
 * 滚动淘汰最旧的一条。这是本功能能成立的前提，不是优化。
 */
export interface ToolPruneLimits {
  /** 整库最多几条工具记录（滚动保留最新的）。 */
  maxRecords: number
  /** 每个会话最多几条工具记录（保留轮号最靠后的）。 */
  maxPerSession: number
}

/**
 * 选出要淘汰的记录 id。
 *
 * 两条规则叠加：
 * 1. 分数低于 `minScore` 且**没有任何入边**（不是别人引用的根）→ 淘汰。
 * 2. 淘汰后若仍超过 `maxRecords`，按分数从低到高继续淘汰，但保留根节点闭包。
 *
 * **里程碑（`kind === 'milestone'`）两条规则都不适用，永不淘汰。**
 * 现有规则保护的是"被别的记录引用的节点"（入边），而里程碑的引用方向恰好相反：
 * 它引用 turn/digest，不被任何记录引用——照现有规则会被当成低分孤立节点误删。
 * 而它恰恰是全库唯一的**主线**：删掉它，剩下的一堆 turn 记录就再也拼不回
 * "这个会话发生过什么"。里程碑只有几十条、每条几十 token，留着不构成预算压力。
 *
 * **工具记录（`kind === 'tool'`）走第三条完全独立的规则**（仅当传入 `toolLimits`）：
 * - 不参与上面两条规则，也不计入 `maxRecords` —— 细节不允许挤掉主内容；
 * - 只按"每会话最多 N 条、整库最多 M 条"滚动淘汰，保留最新的；
 * - 不享受入边豁免（本插件也不会给 tool 记录建入边，见 tool-digest.ts 的 refs 说明）。
 *
 * 不传 `toolLimits` 时行为与旧版完全一致（tool 记录按普通记录处理），这样已有单测
 * 与外部调用不会被这次扩展改变。
 *
 * @param scored - {@link scoreRecords} 的输出。
 * @param minScore - 保留阈值。
 * @param maxRecords - 主内容池的记录上限（**不含**工具记录）。
 * @param toolLimits - 工具记录池的上限；缺省 = 不做工具池特殊处理。
 * @returns 要删除的 id 集合。
 */
export function selectPrunable(
  scored: readonly ScoredRecord[],
  minScore: number,
  maxRecords: number,
  toolLimits?: ToolPruneLimits,
): Set<string> {
  const drop = new Set<string>()
  // 主内容池：传了 toolLimits 时先把 tool 记录摘出去，让下面的分数/上限规则
  // 与"库里从来只有主内容"逐条等价。这是"不许挤占主内容"的落点。
  const main = toolLimits === undefined ? scored : scored.filter((entry) => entry.record.kind !== 'tool')
  const referenced = new Set<string>()
  for (const { record } of main) for (const ref of record.refs) referenced.add(ref)

  for (const { record, score } of main) {
    if (record.kind === 'milestone') continue
    if (score < minScore && !referenced.has(record.id)) drop.add(record.id)
  }
  const survivors = main.filter((s) => !drop.has(s.record.id))
  if (survivors.length > maxRecords) {
    const byScore = [...survivors].sort((a, b) => (a.score - b.score) || a.record.createdAt - b.record.createdAt)
    for (const { record } of byScore) {
      if (survivors.length - drop.size <= maxRecords) break
      // 里程碑是主线骨架：上限压得再紧也留，宁可多几条也不让故事断掉。
      if (record.kind === 'milestone') continue
      // 根节点闭包：仍被别的存活记录引用的节点不淘汰。
      if (referenced.has(record.id) && !drop.has(record.id)) continue
      drop.add(record.id)
    }
  }

  if (toolLimits !== undefined) {
    const tools = scored.filter((entry) => entry.record.kind === 'tool')
    if (tools.length > 0) {
      // 旧 → 新；同一毫秒内按 id（id 内含自增序号）保持确定性。
      const ordered = [...tools].sort((a, b) =>
        (a.record.createdAt - b.record.createdAt) || a.record.id.localeCompare(b.record.id))
      // 每会话只留最新的 N 条。
      const perSession = new Map<string, number>()
      const keptBySession = new Set<string>()
      for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const record = ordered[i]?.record
        if (record === undefined) continue
        const seen = perSession.get(record.sessionId) ?? 0
        if (seen < toolLimits.maxPerSession) {
          perSession.set(record.sessionId, seen + 1)
          keptBySession.add(record.id)
        }
      }
      const kept: ScoredRecord[] = []
      for (const entry of ordered) {
        if (!keptBySession.has(entry.record.id)) drop.add(entry.record.id)
        else kept.push(entry)
      }
      // 整库上限：仍然从最旧的开始丢。
      const overflow = kept.length - toolLimits.maxRecords
      if (overflow > 0) for (const entry of kept.slice(0, overflow)) drop.add(entry.record.id)
    }
  }
  return drop
}

/** 文档频率表：`df` 是 term → 含该词的记录数，`n` 是建表时的语料条数。 */
export interface DocFreq {
  readonly n: number
  readonly df: ReadonlyMap<string, number>
}

/**
 * 检索打分的旋钮。
 *
 * **生产调用不传这个参数**（`DeepMemoryStore.search` 只传预先算好的 df 表），
 * 默认值就是线上行为。留出旋钮的唯一理由是：`scripts/ablate-retrieval.mjs` 要
 * 逐项开关 3a/3b/3c 做消融，而消融必须跑**这一份**打分循环——把循环复制到脚本里
 * 再改，下次改检索时脚本会静默地继续测旧逻辑，这个项目已经栽过这个坑。
 */
export interface SearchTuning {
  /** 切词用的停用词集合。 */
  stopwords?: ReadonlySet<string>
  /** 是否用 IDF 加权；`false` 时退回"命中几个词就几分"的等权计数（旧行为）。 */
  idf?: boolean
  /** `kind === 'digest'` 记录的得分系数；1 = 不降权。 */
  digestWeight?: number
  /** 预建的 df 表；缺省时按本次查询词现算（纯函数路径）。 */
  docFreq?: DocFreq
}

/**
 * digest 记录的检索降权系数。
 *
 * 为什么是 0.5：这个数是拿 19 条真实探针在**去重副本库**上扫出来的（不是拍脑袋，
 * 也不是只挑"命中率最高"的那个）。`scripts/ablate-retrieval.mjs --sweep` 的结果：
 *
 *   系数   探针 top-5   具体记录(非 digest) top-3   top-3 里 digest 槽位   平均正文
 *   1.0      16/17                 4/8                     37           1369 字符
 *   0.6      16/17                 5/8                     29           1098 字符
 *   **0.5    16/17                 5/8                     24            935 字符**
 *   0.4      15/17                 6/8                     16            652 字符
 *   0.3      15/17                 8/8                     13            565 字符
 *
 * （分母 17 = L3 里确实有答案的探针数；19 条里的 incompatible-version 与 esbuild
 *  在 L3 里一条记录都没有，属于蒸馏缺口、不是检索问题，见任务 4。）
 *
 * 选 0.5 而不是 0.3 的理由不是"命中率"，而是**丢的是谁**：0.5 把
 * 「memory-vault 和本插件的分工」这条**具体 turn 记录**从摘要堆里捞了回来
 * （w=1 时它进不了前 5），代价是「0.2.0-rc.2 的兼容处理」这条**只在摘要里**
 * 存在的事实掉出前 5——这正是"摘要让位给具体"想要的方向；再降到 0.4，
 * 第二条只能在摘要里找到的事实（snapshotEvents）也掉出去，那就不划算了。
 *
 * 机制上也说得通：digest 是"全库摘要"，篇幅约普通 turn 的 6 倍、几乎含任何词，
 * 靠"命中更多不同查询词"天然排在最前——那衡量的是摘要覆盖面，不是相关性。
 */
const DIGEST_WEIGHT = 0.5

/** 检索用的"可搜正文"：正文 + 关键词表，小写。抽成函数，保证 df 统计与打分用同一份文本。 */
function haystackOf(record: MemoryRecord): string {
  return `${record.text}\n${record.keywords.join(' ')}`.toLowerCase()
}

/**
 * 统计一组查询词的文档频率（df = 含该词的记录数）。
 *
 * 只统计"本次查询用到的词"，不建全库词表：全库词表在记录频繁变动时建一次就作废，
 * 而一次查询的词最多 16 个，O(N·16) 的一次扫描足够便宜。
 *
 * @param records - 语料。
 * @param terms - 查询词。
 * @returns `n` 与 `df` 表（没出现的词 df=0）。
 */
export function buildDocFreq(records: readonly MemoryRecord[], terms: readonly string[]): DocFreq {
  const df = new Map<string, number>()
  for (const term of terms) df.set(term, 0)
  if (terms.length === 0) return { n: records.length, df }
  for (const record of records) {
    const hay = haystackOf(record)
    for (const term of terms) if (hay.includes(term)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return { n: records.length, df }
}

/** 一条记录的检索打分结果。 */
export interface RankedRecord {
  record: MemoryRecord
  score: number
  /** 命中的不同查询词个数（整串命中也算 1）。用于"零命中就丢掉"，与 score 解耦。 */
  matched: number
}

/**
 * 检索打分（不排序、不截断）：**生产检索的全部数学都在这里**。
 *
 * 旧实现是"命中几个不同查询词就几分"（等权计数）。那等于把
 * 「为什么」和「headroom」当成同等重要的证据：136 条命中里 128 条同分 1，
 * 平局按 `createdAt` 降序打破——排序实际由"谁更新"决定，不是"谁更相关"。
 * 改用 IDF 加权（`log((N+1)/(df+1))`）后，全库都出现的词权重趋近 0，
 * 只在少数记录出现的词权重高，同分退化就被打断了。
 *
 * digest 另外降权：见 {@link DIGEST_WEIGHT}。
 *
 * @param records - 语料（生产传全库）。
 * @param query - 查询串。
 * @param tuning - 消融用旋钮；生产不传，走默认值。
 * @returns 命中至少一个词的记录及其得分（未排序）。
 */
export function rankRecords(
  records: readonly MemoryRecord[],
  query: string,
  tuning: SearchTuning = {},
): RankedRecord[] {
  const terms = extractKeywords(query, 16, tuning.stopwords ?? STOPWORDS)
  const needle = query.trim().toLowerCase()
  if (terms.length === 0 && needle.length === 0) return []
  const freq = (tuning.idf ?? true) ? (tuning.docFreq ?? buildDocFreq(records, terms)) : null
  const digestWeight = tuning.digestWeight ?? DIGEST_WEIGHT
  // IDF：df=0（只能靠子串跨边界命中）按"极少见"处理，即 log(N+1)，不返回 Infinity。
  const weightOf = (term: string): number => {
    if (freq === null) return 1
    return Math.log((freq.n + 1) / ((freq.df.get(term) ?? 0) + 1))
  }
  const out: RankedRecord[] = []
  for (const record of records) {
    const hay = haystackOf(record)
    let score = 0
    let matched = 0
    for (const term of terms) {
      if (!hay.includes(term)) continue
      matched += 1
      score += weightOf(term)
    }
    // 整串命中（含空格与标点的原问法）是强信号，给固定加成；旧实现是 +2 个 hit。
    if (needle.length > 1 && hay.includes(needle)) {
      matched += 1
      score += 2
    }
    // 用 matched 而不是 score 过滤：某个词若在全库都出现，IDF 权重恰好为 0，
    // 按 score>0 过滤会把"确实命中了"的记录误判成没命中。
    if (matched === 0) continue
    if (record.kind === 'digest') score *= digestWeight
    out.push({ record, score, matched })
  }
  return out
}

/**
 * 关键词检索的**纯函数**实现：按得分降序，平局按 `createdAt` 降序（保持确定性）。
 *
 * 为什么从 `DeepMemoryStore.search` 里抽出来：`scripts/verify-compression.mjs`
 * 要拿"生产用的同一套检索"去跑召回验证。复制一份打分循环到脚本里，下次改检索时
 * 脚本会静默地继续测旧逻辑——那正是本项目反复栽的"看起来在工作"的坑。
 * 抽成纯函数后，脚本 import 的就是这里，零漂移；`search` 只是薄薄一层委托。
 *
 * @param records - 全库记录（调用方负责给出与生产一致的集合）。
 * @param query - 查询串。
 * @param limit - 最多返回条数。
 * @param tuning - 消融用旋钮；生产不传。
 * @returns 命中的记录（得分降序，平局新近度降序）。
 */
export function searchRecords(
  records: readonly MemoryRecord[],
  query: string,
  limit: number,
  tuning: SearchTuning = {},
): MemoryRecord[] {
  return rankRecords(records, query, tuning)
    .sort((a, b) => (b.score - a.score) || (b.record.createdAt - a.record.createdAt))
    .slice(0, Math.max(0, limit))
    .map((s) => s.record)
}

/**
 * 去重分组键：同一会话 + 同一类别 + 同一轮范围 = 同一次蒸馏的产物。
 *
 * 三个字段用 NUL 分隔，避免 `a|b` 与 `a` `b` 这类拼接歧义（sessionId 来自宿主，
 * 虽然实际不含分隔符，但键的解析不该依赖"实际不会"）。
 *
 * @param record - 任意记录。
 * @returns 分组键。
 */
function dedupeKey(record: MemoryRecord): string {
  return `${record.sessionId}\u0000${record.kind}\u0000${record.turnFrom}\u0000${record.turnTo}`
}

/** 存储后端必须实现的接口。 */
export interface MemoryBackend {
  /** 实际落盘文件（去重前的备份要按它取路径）。 */
  readonly file: string
  load(): MemoryRecord[]
  append(records: readonly MemoryRecord[]): void
  /** 用给定记录集整体重写（剪枝后调用）。 */
  replace(records: readonly MemoryRecord[]): void
  close(): void
  /** 后端标识，供 status/verify 输出。 */
  readonly kind: 'sqlite' | 'jsonl'
}

/** JSONL 后端：追加写 + 启动读入，人类可读、可手工 grep。 */
export class JsonlBackend implements MemoryBackend {
  readonly kind = 'jsonl' as const
  readonly file: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'deep-memory.jsonl')
  }

  load(): MemoryRecord[] {
    if (!existsSync(this.file)) return []
    const out: MemoryRecord[] = []
    for (const line of readFileSync(this.file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as MemoryRecord
        if (typeof parsed?.id === 'string' && typeof parsed?.text === 'string') out.push(parsed)
      } catch {
        // 单行损坏（例如断电写了一半）只跳过该行，不让整库不可用。
      }
    }
    return out
  }

  append(records: readonly MemoryRecord[]): void {
    if (records.length === 0) return
    appendFileSync(this.file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
  }

  replace(records: readonly MemoryRecord[]): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8')
    renameSync(tmp, this.file)
  }

  close(): void {}
}

/** SQLite 后端：`node:sqlite` 内置模块，惰性 import。 */
export class SqliteBackend implements MemoryBackend {
  readonly kind = 'sqlite' as const
  readonly file: string
  private db: { exec: (sql: string) => void; prepare: (sql: string) => any; close: () => void }

  private constructor(db: SqliteBackend['db'], file: string) {
    this.db = db
    this.file = file
  }

  /**
   * 尝试打开 SQLite 后端。
   * @param dir - 存储目录。
   * @returns 后端实例；`node:sqlite` 不可用时返回 null，由调用方退回 JSONL。
   */
  static async open(dir: string): Promise<SqliteBackend | null> {
    try {
      mkdirSync(dir, { recursive: true })
      const spec = 'node:sqlite'
      const mod = (await import(/* @vite-ignore */ spec)) as { DatabaseSync: new (p: string) => any }
      const file = join(dir, 'deep-memory.sqlite')
      const db = new mod.DatabaseSync(file)
      db.exec(
        'CREATE TABLE IF NOT EXISTS records ('
        + 'id TEXT PRIMARY KEY, kind TEXT NOT NULL, createdAt INTEGER NOT NULL, '
        + 'sessionId TEXT NOT NULL, turnFrom INTEGER NOT NULL, turnTo INTEGER NOT NULL, '
        + 'text TEXT NOT NULL, tokens INTEGER NOT NULL, keywords TEXT NOT NULL, refs TEXT NOT NULL)',
      )
      return new SqliteBackend(db, file)
    } catch {
      // node:sqlite 在旧 Node 上不存在，或被 --no-experimental-sqlite 关闭。
      return null
    }
  }

  load(): MemoryRecord[] {
    const rows = this.db.prepare('SELECT * FROM records ORDER BY createdAt ASC').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as MemoryRecord['kind'],
      createdAt: Number(row.createdAt),
      sessionId: String(row.sessionId),
      turnFrom: Number(row.turnFrom),
      turnTo: Number(row.turnTo),
      text: String(row.text),
      tokens: Number(row.tokens),
      keywords: JSON.parse(String(row.keywords)) as string[],
      refs: JSON.parse(String(row.refs)) as string[],
    }))
  }

  append(records: readonly MemoryRecord[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO records (id,kind,createdAt,sessionId,turnFrom,turnTo,text,tokens,keywords,refs) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    for (const r of records) {
      stmt.run(r.id, r.kind, r.createdAt, r.sessionId, r.turnFrom, r.turnTo, r.text, r.tokens, JSON.stringify(r.keywords), JSON.stringify(r.refs))
    }
  }

  replace(records: readonly MemoryRecord[]): void {
    // DELETE + 逐条 INSERT **必须在同一个事务里**。
    //
    // 旧实现是两条独立语句（DELETE 自动提交，再逐条 INSERT 自动提交）：中途任何一步
    // 失败（磁盘满、进程被杀、SQLITE_FULL），库里留下的是"表已清空、只写回了一部分"
    // ——这正是 2026-10 那次事故里 digest 记录 18→0、第三个会话整段消失的形态。
    // 包成事务后，失败只会回到写之前的完整状态，不会再产生半截库。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM records')
      this.append(records)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 回滚本身失败时保留原始异常——那才是要看的诊断。
      }
      throw error
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 已关闭或连接失效：关闭失败没有可恢复的后果。
    }
  }
}

/** 深层记忆库：内存索引 + 可插拔后端。 */
export class DeepMemoryStore {
  private records: MemoryRecord[] = []
  private seq = 0
  private backend: MemoryBackend | null = null
  private readonly dir: string
  private readonly prefer: 'auto' | 'sqlite' | 'jsonl'
  /**
   * 查询词的 df 缓存（term → 含该词的记录数）。
   *
   * **只在按需检索时增量填充**，不预建全库词表；`records` 一变（put/update/prune/open）
   * 就整表丢弃，下次检索按当时的语料重算——宁可多算一次，也不让检索用过期计数
   * 去排序（错的分母 = 错的 IDF = 又一次"看起来在工作"）。
   */
  private dfCache: Map<string, number> | null = null

  constructor(dir: string, prefer: 'auto' | 'sqlite' | 'jsonl' = 'auto') {
    this.dir = dir
    this.prefer = prefer
  }

  /**
   * 打开后端并载入已有记录。
   * @returns 实际使用的后端标识。
   */
  async open(): Promise<'sqlite' | 'jsonl'> {
    this.dfCache = null
    if (this.prefer !== 'jsonl') {
      const sqlite = await SqliteBackend.open(this.dir)
      if (sqlite !== null) {
        this.backend = sqlite
        this.records = sqlite.load()
        return 'sqlite'
      }
      if (this.prefer === 'sqlite') {
        // 显式要求 sqlite 但不可用：退回 JSONL 并让调用方 warn，绝不静默丢数据。
        this.backend = new JsonlBackend(this.dir)
        this.records = this.backend.load()
        return 'jsonl'
      }
    }
    this.backend = new JsonlBackend(this.dir)
    this.records = this.backend.load()
    return 'jsonl'
  }

  /** 实际后端标识；未 open 时为 null。 */
  get backendKind(): 'sqlite' | 'jsonl' | null {
    return this.backend?.kind ?? null
  }

  /** 已载入的记录数。 */
  get size(): number {
    return this.records.length
  }

  /** 全部记录的只读快照。 */
  all(): readonly MemoryRecord[] {
    return this.records
  }

  /** 按 id 精确取回。 */
  get(id: string): MemoryRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  /**
   * 本会话在某一类记录上已落库的**最大轮号**；没有记录时返回 -1。
   *
   * **为什么需要它**：L3 蒸馏水位过去只活在 `SessionState` 的内存字段里
   * （`l3HighWaterTurn`，初值 -1）。进程重启 → 归零 → 同一个轮次被重新蒸馏一遍，
   * 而记录 id 由 `createdAt + seq` 生成，于是每次重启都长出一条新副本。实测某会话
   * 1188 条记录里有 1044 条是同 (kind, turnFrom, turnTo) 的重复，turn 1 一份 32 条
   * （≈ 32 次重启）。水位必须是**能从库里推出来**的量，否则它就不算被持久化。
   *
   * 取 `turnTo` 而不是 `turnFrom`：蒸馏按轮号升序推进，最大值就是"这之前都处理过"
   * 的边界。库里有垃圾（重复副本）不影响这个值——它只是最大值。
   *
   * @param sessionId - 会话 id（L3 是跨会话共享的一个库，不能跨会话取值）。
   * @param kind - 记录类别；水位只由 `turn` 记录决定，默认即是它。
   * @returns 最大 `turnTo`，无记录为 -1。
   */
  maxTurnTo(sessionId: string, kind: MemoryRecord['kind'] = 'turn'): number {
    let max = -1
    for (const record of this.records) {
      if (record.sessionId !== sessionId || record.kind !== kind) continue
      if (record.turnTo > max) max = record.turnTo
    }
    return max
  }

  /**
   * 写入一条记录。
   * @param input - 除 id/createdAt/keywords 外的字段；这三项自动推导。
   *   `tokens` 可显式给出（里程碑行已按骨架口径估算过，重算一遍只会引入第二种口径）。
   * @returns 落库后的完整记录。
   */
  put(input: {
    kind: MemoryRecord['kind']
    sessionId: string
    turnFrom: number
    turnTo: number
    text: string
    refs?: readonly string[]
    createdAt?: number
    tokens?: number
  }): MemoryRecord {
    this.seq += 1
    const createdAt = input.createdAt ?? Date.now()
    const record: MemoryRecord = {
      id: `l3-${createdAt.toString(36)}-${this.seq.toString(36)}`,
      kind: input.kind,
      createdAt,
      sessionId: input.sessionId,
      turnFrom: input.turnFrom,
      turnTo: input.turnTo,
      text: input.text,
      tokens: typeof input.tokens === 'number' && Number.isFinite(input.tokens)
        ? Math.max(0, Math.trunc(input.tokens))
        : estimateTokens(input.text),
      keywords: extractKeywords(input.text),
      refs: [...(input.refs ?? [])],
    }
    this.records.push(record)
    this.dfCache = null
    this.backend?.append([record])
    return record
  }

  /**
   * 按 id 就地更新一条记录并落盘。
   *
   * 为什么必须有它：里程碑的 `cause` 是**后补**的（先按确定性标签落库，LLM 补完因果
   * 再回填）。骨架行是从这条记录的 `text` 渲染的，只改内存里的 `Milestone` 而不改
   * 这里，重启后读者拿到的仍是旧标签——回填等于没做。
   *
   * @param id - 记录 id。
   * @param patch - 要覆盖的字段；给了 `text` 就一并重算 keywords 与 tokens
   *   （`tokens` 也可显式给出，里程碑行有自己的口径）。
   * @returns 是否命中并更新（id 不存在时 false，调用方不必先查一遍）。
   */
  update(id: string, patch: { text?: string; tokens?: number; refs?: readonly string[] }): boolean {
    const record = this.records.find((r) => r.id === id)
    if (record === undefined) return false
    const text = patch.text ?? record.text
    if (patch.text !== undefined) {
      record.text = patch.text
      record.keywords = extractKeywords(text)
    }
    record.tokens = typeof patch.tokens === 'number' && Number.isFinite(patch.tokens)
      ? Math.max(0, Math.trunc(patch.tokens))
      : estimateTokens(text)
    if (patch.refs !== undefined) record.refs = [...patch.refs]
    this.dfCache = null
    // 两个后端统一走整体重写：sqlite 的 INSERT OR REPLACE 能按主键覆盖，而 JSONL 是追加写，
    // 逐条 append 会在文件里留下同一 id 的两行——load 时就成了两条记录，比不更新更糟。
    this.backend?.replace(this.records)
    return true
  }

  /**
   * 批量就地更新：一次内存改动、**一次**落盘。
   *
   * 为什么需要它：`update()` 每改一条就整表重写一次（JSONL 追加写的约束，见下）。
   * 给历史 turn 记录补"未剪约束"时要改上百条，逐条 update 会变成上百次全表重写，
   * 在一个 pre-step 里做这件事等于卡住对话。批量版把所有改动先在内存里做完，
   * 最后只 `replace` 一次。
   *
   * @param patches - 要改的记录与字段；id 不存在或文本未变的条目会被跳过。
   * @returns { updated, unchanged }：实际改写条数与"已是最新"的条数。
   */
  updateMany(patches: ReadonlyArray<{ id: string; text: string; tokens?: number }>): { updated: number; unchanged: number } {
    let updated = 0
    let unchanged = 0
    for (const patch of patches) {
      const record = this.records.find((r) => r.id === patch.id)
      if (record === undefined || record.text === patch.text) {
        unchanged += 1
        continue
      }
      record.text = patch.text
      record.keywords = extractKeywords(patch.text)
      record.tokens = typeof patch.tokens === 'number' && Number.isFinite(patch.tokens)
        ? Math.max(0, Math.trunc(patch.tokens))
        : estimateTokens(patch.text)
      updated += 1
    }
    if (updated > 0) {
      this.dfCache = null
      this.backend?.replace(this.records)
    }
    return { updated, unchanged }
  }

  /**
   * 检索：委托给纯函数 {@link rankRecords}/{@link searchRecords}，并在这里维护 df 缓存。
   *
   * 为什么缓存按"查询词"增量建、而不是预建全库词表：预建表在每次 `put` 后就要整表
   * 重建，而蒸馏每轮都在 put；增量表只算本次真正用到的 ≤16 个词，且跨查询复用。
   *
   * @param query - 查询串。
   * @param limit - 最多返回条数。
   * @returns 命中的记录（得分降序，平局新近度降序）。
   */
  search(query: string, limit: number): MemoryRecord[] {
    return searchRecords(this.records, query, limit, { docFreq: this.docFreq(extractKeywords(query, 16)) })
  }

  /**
   * 取（并按需补齐）查询词的 df 表。
   * @param terms - 查询词。
   * @returns 与当前 `records` 规模一致的 df 表（缓存本身是就地增长的）。
   */
  private docFreq(terms: readonly string[]): DocFreq {
    const cache = this.dfCache ?? (this.dfCache = new Map<string, number>())
    const missing = terms.filter((term) => !cache.has(term))
    if (missing.length > 0) {
      const built = buildDocFreq(this.records, missing)
      for (const [term, count] of built.df) cache.set(term, count)
    }
    return { n: this.records.length, df: cache }
  }

  /**
   * 按 id 删除记录并落盘。
   *
   * 只给工具记录池的滚动上限用（见 tool-digest.ts）：它必须与 `put` 走**同一个**
   * 内存实例与后端，否则就会出现"外部删库被内存快照覆盖"的那类故障。
   *
   * @param ids - 要删除的记录 id。
   * @returns 实际删除条数（id 不存在时不计）。
   */
  remove(ids: readonly string[]): number {
    if (ids.length === 0) return 0
    const drop = new Set(ids)
    const before = this.records.length
    const kept = this.records.filter((record) => !drop.has(record.id))
    if (kept.length === before) return 0
    this.records = kept
    this.dfCache = null
    this.backend?.replace(this.records)
    return before - kept.length
  }

  /** 实际落盘文件的路径；后端未打开时为 null（去重备份用）。 */
  get storageFile(): string | null {
    return this.backend?.file ?? null
  }

  /**
   * 统计重复组：**一次 O(n) 扫描**，不排序、不做两两比较。
   *
   * 为什么单独出这个方法而不是塞进 `stats()`：`stats()` 在每轮投影（L3 索引）里都会
   * 被调用一次，而重复读数只在 `memory_state` / `memory_verify` 这类低频工具里需要。
   * 混进去等于让每轮注入都多付一次整库扫描——读数便宜，但没便宜到这个程度。
   *
   * @param sessionId - 只统计该会话；不传则整库。
   * @returns 重复组数、可删条数与正文不一致组数。
   */
  duplicateSummary(sessionId?: string): DuplicateSummary {
    const seen = new Map<string, { copies: number; text: string; differs: boolean }>()
    for (const record of this.records) {
      if (sessionId !== undefined && record.sessionId !== sessionId) continue
      const key = dedupeKey(record)
      const slot = seen.get(key)
      if (slot === undefined) {
        // 只存引用，不复制正文：没有重复时这里只是 O(n) 次 Map 写入。
        seen.set(key, { copies: 1, text: record.text, differs: false })
        continue
      }
      slot.copies += 1
      // 只有真的出现第二份副本才会比较正文，干净库不会因此变成 O(n²)。
      if (record.text !== slot.text) slot.differs = true
    }
    let groups = 0
    let records = 0
    let differingGroups = 0
    for (const slot of seen.values()) {
      if (slot.copies < 2) continue
      groups += 1
      records += slot.copies - 1
      if (slot.differs) differingGroups += 1
    }
    return { groups, records, differingGroups }
  }

  /**
   * 清理同一 `(sessionId, kind, turnFrom, turnTo)` 的重复副本。
   *
   * ── 为什么必须由 store 自己做（而不是外部脚本开库删行）────────────────
   * 这个库有**两个 owner** 时必然出事：插件在内存里持有一份记录快照，持久化入口是
   * `backend.replace(this.records)`（整表重写）。外部脚本直接改文件后，插件下一次
   * 写盘（剪枝、里程碑 cause 回填、工具池滚动）会把内存里的旧快照整表写回，把刚删掉
   * 的副本连同**别人刚写的记录**一起覆盖掉。2026-10 的真实事故就是这么丢的
   * （1491 条含重复被写回、digest 18→0、第三个会话整段消失）。
   * 因此去重必须改**这一份** `records` 再走**同一个** `replace`，让内存与磁盘永远
   * 是同一个写入者。
   *
   * ── 安全约束 ────────────────────────────────────────────────────────
   * - `dryRun` 默认 true：不显式传 false 就绝不写盘、不建备份。
   * - 写盘前先备份（`<库文件>.bak-<ISO 时间戳>`），备份校验大小不一致就中止，
   *   绝不带着"以为有备份"去删数据。
   * - 基于 id 删除而不是整表重建：删除集合之外的记录原对象保持不动（引用改写会复制
   *   新对象），失败时整份内存快照回滚，不会留下"内存已删、磁盘没删"的分叉。
   *
   * @param options - `dryRun` 默认 true；`sessionId` 限定单个会话。
   * @returns 结构化结果（含每组明细）。
   */
  dedupe(options: { dryRun?: boolean; sessionId?: string } = {}): DedupeOutcome {
    const dryRun = options.dryRun !== false
    const only = typeof options.sessionId === 'string' && options.sessionId.length > 0
      ? options.sessionId
      : undefined

    // 一次扫描建组，顺带数出**范围内的记录数**：`sessionId` 过滤时 before/after 必须是
    // 该会话的条数，不能拿整库数字冒充——那正是 memory_state 之前修过的口径错误。
    const groups = new Map<string, MemoryRecord[]>()
    let before = 0
    for (const record of this.records) {
      if (only !== undefined && record.sessionId !== only) continue
      before += 1
      const key = dedupeKey(record)
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [record])
      else list.push(record)
    }

    const removeTo = new Map<string, string>()
    const details: DedupeGroupReport[] = []
    for (const [key, group] of groups) {
      if (group.length < 2) continue
      // 组内保留**最长**的正文；长度一致时保留 `createdAt` 最新的一条——
      // 与 searchRecords 的平局顺序（createdAt 降序）一致，去重前后名次不变。
      let keeper = group[0] as MemoryRecord
      for (const record of group) {
        if (record.text.length > keeper.text.length) keeper = record
        else if (record.text.length === keeper.text.length && record.createdAt > keeper.createdAt) keeper = record
      }
      const identicalText = group.every((record) => record.text === keeper.text)
      const removedIds = group.filter((record) => record.id !== keeper.id).map((record) => record.id)
      for (const id of removedIds) removeTo.set(id, keeper.id)
      details.push({
        key,
        sessionId: keeper.sessionId,
        kind: keeper.kind,
        turnFrom: keeper.turnFrom,
        turnTo: keeper.turnTo,
        copies: group.length,
        keepId: keeper.id,
        keepChars: keeper.text.length,
        identicalText,
        removedIds,
      })
    }
    details.sort((a, b) => (b.copies - a.copies) || (a.turnFrom - b.turnFrom) || a.key.localeCompare(b.key))

    // 引用改写：只改**幸存**记录里的 refs。被删记录自身的 refs 随记录一起消失，
    // 把它们算进"改写了几处"只会让读数虚高。
    const refUpdates = new Map<string, string[]>()
    let refsRewritten = 0
    if (removeTo.size > 0) {
      for (const record of this.records) {
        if (record.refs.length === 0 || removeTo.has(record.id)) continue
        let changed = false
        const next = record.refs.map((ref) => {
          const mapped = removeTo.get(ref)
          if (mapped === undefined) return ref
          changed = true
          refsRewritten += 1
          return mapped
        })
        if (changed) refUpdates.set(record.id, [...new Set(next)])
      }
    }

    const after = before - removeTo.size
    const differingGroupDetails = details.filter((detail) => !detail.identicalText)
    const outcome: DedupeOutcome = {
      dryRun,
      sessionId: only ?? null,
      before,
      after,
      removed: removeTo.size,
      groups: details.length,
      differingGroups: differingGroupDetails.length,
      refsRewritten,
      recordsWithRefUpdates: refUpdates.size,
      backupPath: null,
      applied: false,
      groupDetails: details,
      differingGroupDetails,
    }
    if (dryRun || removeTo.size === 0) return outcome

    // ① 先把备份做完，再碰内存/磁盘：备份失败就原地放弃，本次不删任何东西。
    outcome.backupPath = this.backupBeforeWrite()

    // ② 改内存：过滤被删副本，并给需要改引用的记录换一份新对象（原对象保持可回滚）。
    const previous = this.records
    const next = previous
      .filter((record) => !removeTo.has(record.id))
      .map((record) => {
        const refs = refUpdates.get(record.id)
        return refs === undefined ? record : { ...record, refs }
      })

    // ③ 走后端自己的 replace 落盘（sqlite 已包事务）。失败则回滚内存，绝不留下
    //    "内存删了、磁盘没删"的分叉——那会让下一次写盘把删掉的副本又写回去。
    this.records = next
    this.dfCache = null
    try {
      this.backend?.replace(next)
    } catch (error) {
      this.records = previous
      this.dfCache = null
      throw error
    }
    outcome.applied = true
    return outcome
  }

  /**
   * 写盘前备份当前库文件，并校验大小。
   *
   * 为什么备份也走 store：备份的文件名必须以**后端真正在用的那个文件**为准。
   * 外部脚本按约定路径猜一个时，`l3.dir` 配置一旦改过就会备份错文件。
   *
   * @returns 备份文件路径。
   */
  private backupBeforeWrite(): string {
    const file = this.storageFile
    if (this.backend === null || file === null) {
      throw new Error('L3 后端未打开，无法在删除前备份；本次未改动任何记录。')
    }
    if (!existsSync(file)) {
      throw new Error(`找不到 L3 库文件 ${file}，无法在删除前备份；本次未改动任何记录。`)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = `${file}.bak-${stamp}`
    copyFileSync(file, target)
    // 只写了一份空文件（磁盘满、权限异常）比没有备份更危险：它会让人以为可以回滚。
    const source = statSync(file).size
    const copied = statSync(target).size
    if (copied === 0 || copied !== source) {
      throw new Error(`备份校验失败（源 ${source} B → 备份 ${copied} B：${target}）；本次未改动任何记录。`)
    }
    return target
  }

  /**
   * 执行确定性剪枝并落盘。
   * @param taskKeywords - 当前任务链关键词。
   * @param minScore - 保留阈值。
   * @param maxRecords - 主内容池上限（不含工具记录）。
   * @param now - 当前时间（注入以便测试）。
   * @param toolLimits - 工具记录池上限；不传 = 工具记录按普通记录处理（旧行为）。
   * @returns 剪枝统计。
   */
  prune(
    taskKeywords: readonly string[],
    minScore: number,
    maxRecords: number,
    now = Date.now(),
    toolLimits?: ToolPruneLimits,
  ): PruneOutcome {
    const scored = scoreRecords(this.records, taskKeywords, now)
    const drop = selectPrunable(scored, minScore, maxRecords, toolLimits)
    if (drop.size === 0) {
      return { before: this.records.length, after: this.records.length, removed: [], kept: this.records.map((r) => r.id) }
    }
    const removed = this.records.filter((r) => drop.has(r.id)).map((r) => r.id)
    this.records = this.records.filter((r) => !drop.has(r.id))
    this.dfCache = null
    this.backend?.replace(this.records)
    return { before: removed.length + this.records.length, after: this.records.length, removed, kept: this.records.map((r) => r.id) }
  }

  /** 统计信息，供 memory_state / memory_verify / L3 索引输出。 */
  stats(): {
    count: number
    tokens: number
    backend: 'sqlite' | 'jsonl' | null
    oldest: number | null
    newest: number | null
    /** 工具记录条数（独立细节池，见 {@link ToolPruneLimits}）。 */
    tools: number
    /** 工具记录占用的 token。 */
    toolTokens: number
  } {
    let tokens = 0
    let tools = 0
    let toolTokens = 0
    for (const record of this.records) {
      tokens += record.tokens
      if (record.kind === 'tool') {
        tools += 1
        toolTokens += record.tokens
      }
    }
    const times = this.records.map((r) => r.createdAt)
    return {
      count: this.records.length,
      tokens,
      backend: this.backendKind,
      oldest: times.length === 0 ? null : Math.min(...times),
      newest: times.length === 0 ? null : Math.max(...times),
      tools,
      toolTokens,
    }
  }

  /** 关闭后端。 */
  close(): void {
    this.backend?.close()
  }
}
