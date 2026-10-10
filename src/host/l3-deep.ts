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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from './l1-working.ts'

/** 一条深层记忆记录。 */
export interface MemoryRecord {
  /** 稳定 id（`l3-<时间戳36>-<序号36>`）。 */
  id: string
  /**
   * `digest` L2 淘汰下来的摘要；`turn` 单轮原文；`artifact` 工具产物/文件读取；
   * `milestone` 主线骨架的一条里程碑。
   *
   * `milestone` 是**根节点**：它引用同轮范围内的 turn/digest 记录（`refs`），
   * 自己不携带细节正文——细节本来就在 L3 里，里程碑只是把散落的细节组织成故事。
   * 因此它永不参与剪枝（见 {@link selectPrunable}）：剪掉根节点等于把故事拆散。
   */
  kind: 'digest' | 'turn' | 'artifact' | 'milestone'
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

/** 中文停用词/高频虚词：参与关键词抽取但没有区分度。 */
const STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '我', '有', '就', '不', '人', '都', '一', '一个', '上', '也',
  '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'you', 'not',
  'but', 'have', 'has', 'had', 'its', 'it', 'is', 'of', 'to', 'in', 'on', 'as', 'at', 'by',
])

/**
 * 抽取关键词：英文按词、CJK 按二元组，去掉停用词，按出现频次取前 N。
 *
 * 刻意不引入分词依赖：二元组对中文检索足够好，且完全确定性，可单测。
 *
 * @param text - 任意正文。
 * @param limit - 最多返回多少个关键词。
 * @returns 去重后的关键词数组。
 */
export function extractKeywords(text: string, limit = 24): string[] {
  const counts = new Map<string, number>()
  const bump = (token: string): void => {
    if (token.length < 2 || STOPWORDS.has(token)) return
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
 * @param scored - {@link scoreRecords} 的输出。
 * @param minScore - 保留阈值。
 * @param maxRecords - 记录上限。
 * @returns 要删除的 id 集合。
 */
export function selectPrunable(
  scored: readonly ScoredRecord[],
  minScore: number,
  maxRecords: number,
): Set<string> {
  const referenced = new Set<string>()
  for (const { record } of scored) for (const ref of record.refs) referenced.add(ref)

  const drop = new Set<string>()
  for (const { record, score } of scored) {
    if (record.kind === 'milestone') continue
    if (score < minScore && !referenced.has(record.id)) drop.add(record.id)
  }
  const survivors = scored.filter((s) => !drop.has(s.record.id))
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
  return drop
}

/** 存储后端必须实现的接口。 */
export interface MemoryBackend {
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
  private readonly file: string

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
  private db: { exec: (sql: string) => void; prepare: (sql: string) => any; close: () => void }

  private constructor(db: SqliteBackend['db']) {
    this.db = db
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
      const db = new mod.DatabaseSync(join(dir, 'deep-memory.sqlite'))
      db.exec(
        'CREATE TABLE IF NOT EXISTS records ('
        + 'id TEXT PRIMARY KEY, kind TEXT NOT NULL, createdAt INTEGER NOT NULL, '
        + 'sessionId TEXT NOT NULL, turnFrom INTEGER NOT NULL, turnTo INTEGER NOT NULL, '
        + 'text TEXT NOT NULL, tokens INTEGER NOT NULL, keywords TEXT NOT NULL, refs TEXT NOT NULL)',
      )
      return new SqliteBackend(db)
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
    this.db.exec('DELETE FROM records')
    this.append(records)
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

  constructor(dir: string, prefer: 'auto' | 'sqlite' | 'jsonl' = 'auto') {
    this.dir = dir
    this.prefer = prefer
  }

  /**
   * 打开后端并载入已有记录。
   * @returns 实际使用的后端标识。
   */
  async open(): Promise<'sqlite' | 'jsonl'> {
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
    // 两个后端统一走整体重写：sqlite 的 INSERT OR REPLACE 能按主键覆盖，而 JSONL 是追加写，
    // 逐条 append 会在文件里留下同一 id 的两行——load 时就成了两条记录，比不更新更糟。
    this.backend?.replace(this.records)
    return true
  }

  /**
   * 关键词检索：先按关键词命中数排序，再按新近度打破平局。
   * @param query - 查询串。
   * @param limit - 最多返回条数。
   * @returns 命中的记录（新近度降序的平局顺序）。
   */
  search(query: string, limit: number): MemoryRecord[] {
    const terms = extractKeywords(query, 16)
    const needle = query.trim().toLowerCase()
    if (terms.length === 0 && needle.length === 0) return []
    const scored = this.records.map((record) => {
      let hits = 0
      const haystack = `${record.text}\n${record.keywords.join(' ')}`.toLowerCase()
      for (const term of terms) if (haystack.includes(term)) hits += 1
      const substring = needle.length > 1 && haystack.includes(needle) ? 2 : 0
      return { record, hits: hits + substring }
    })
    return scored
      .filter((s) => s.hits > 0)
      .sort((a, b) => (b.hits - a.hits) || (b.record.createdAt - a.record.createdAt))
      .slice(0, Math.max(0, limit))
      .map((s) => s.record)
  }

  /**
   * 执行确定性剪枝并落盘。
   * @param taskKeywords - 当前任务链关键词。
   * @param minScore - 保留阈值。
   * @param maxRecords - 记录上限。
   * @param now - 当前时间（注入以便测试）。
   * @returns 剪枝统计。
   */
  prune(taskKeywords: readonly string[], minScore: number, maxRecords: number, now = Date.now()): PruneOutcome {
    const scored = scoreRecords(this.records, taskKeywords, now)
    const drop = selectPrunable(scored, minScore, maxRecords)
    if (drop.size === 0) {
      return { before: this.records.length, after: this.records.length, removed: [], kept: this.records.map((r) => r.id) }
    }
    const removed = this.records.filter((r) => drop.has(r.id)).map((r) => r.id)
    this.records = this.records.filter((r) => !drop.has(r.id))
    this.backend?.replace(this.records)
    return { before: removed.length + this.records.length, after: this.records.length, removed, kept: this.records.map((r) => r.id) }
  }

  /** 统计信息，供 memory_state / memory_verify 输出。 */
  stats(): { count: number; tokens: number; backend: 'sqlite' | 'jsonl' | null; oldest: number | null; newest: number | null } {
    let tokens = 0
    for (const record of this.records) tokens += record.tokens
    const times = this.records.map((r) => r.createdAt)
    return {
      count: this.records.length,
      tokens,
      backend: this.backendKind,
      oldest: times.length === 0 ? null : Math.min(...times),
      newest: times.length === 0 ? null : Math.max(...times),
    }
  }

  /** 关闭后端。 */
  close(): void {
    this.backend?.close()
  }
}
