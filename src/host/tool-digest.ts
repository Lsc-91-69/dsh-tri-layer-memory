/**
 * tool-digest.ts — 把工具结果（`tool/result`）蒸馏成 L3 的 `tool` 记录。
 *
 * 为什么要有这一层：现有 L3 的 `turn` 记录正文是 {@link extractiveDigest} 的产物，
 * 只留"任务主线 + 助手第一句 + 工具名清单"，**工具正文整段丢弃**。实测某会话
 * 106 万字符的工具输出在 L3 里一个字符都没有，于是"只出现在工具输出里的事实"
 * 永远无法 recall。本模块把那部分正文按**轮**聚合、按预算摘录后单独落库。
 *
 * 三条边界（与 index.ts / l3-deep.ts 的分工）：
 * 1. **不参与注入**：记录只经 `memory_recall` 返回；L3 索引只报条数，不报正文。
 * 2. **不挤占主内容**：`tool` 记录在 `selectPrunable` 里是独立池子，自带条数上限，
 *    不计入 `l3MaxRecords`；里程碑/turn 的存活集合与没有 tool 记录时逐条相同。
 * 3. **体积有硬上界**：单条 ≤ `maxChars`，每会话 ≤ `maxPerSession` 条，整库 ≤
 *    `maxRecords` 条。三个数字都是配置项（见 config-core.ts）。
 *
 * 摘录策略（为什么是"按轮 + 开头 + 最长"）：
 * - **按轮聚合**：一条 `tool/result` 最长实测 10 万字符，按事件一条记录会产生成千上万
 *   条记录、且丢掉"这属于哪一轮"的上下文；按轮聚合后条数与轮数同阶，还能用
 *   `turnFrom/turnTo` 直接定位回 turn 记录。
 * - **取时间序前 {@link TOOL_RESULTS_PER_TURN} 条**：一轮的工具序列开头是"命令/参数/
 *   先读了什么"，是复现当时处境最需要的部分；末尾的结论通常已被助手正文承载。
 * - **每条先留 250 字符开头**：这一小段足以让模型判断"这条结果是什么、命令是什么"。
 * - **剩余预算补给最长的一条**：长输出的开头往往只是 `<path>` 与行号，正文在后面；
 *   给它首尾两段比把预算均摊给一堆短结果更有信息量。
 * - **绝不保存"文件已写入"这类回执**：它们既占额度又不含事实（见 {@link isTrivialToolText}）。
 *
 * @module dsh-tri-layer-memory/tool-digest
 */
import type { MemoryRecord } from './l3-deep.ts'
import type { ToolResultHit } from './l1-working.ts'

/**
 * 工具记录正文的第一行前缀。
 *
 * 它必须出现在**正文里**而不只是 `kind` 字段里：`memory_recall` 的渲染按记录通用
 * 格式输出，模型先读到的是正文；把"这是原始输出、不是结论"写进正文，任何渲染路径
 * 都不会丢掉这句警告。
 */
export const TOOL_RECORD_HEADER = '工具原始输出（非结论）'

/** 每轮最多摘录几条工具结果（按时间序）。 */
export const TOOL_RESULTS_PER_TURN = 10

/** 每条结果的基础字符预算（开头部分）。 */
export const TOOL_BASE_SHARE_CHARS = 250

/**
 * 纯回执类正文：只有"做完了"三个字，没有可召回的事实。
 *
 * 只认**整条**匹配（`^...$`）且大小写不敏感：工具输出里出现 "success" 的正文很多，
 * 按"包含"过滤会误删真正的结果。
 */
const TRIVIAL_RE = /^(ok|okay|done|success|succeeded|written|file written|updated|no changes|no matches|已写入|已保存|成功|完成|无输出|\(no output\)|the file .+ has been (updated|written) successfully\.?|started subagent \S+)$/i

/** 判断一条工具正文是否没有保存价值（纯回执 / 过短）。 */
export function isTrivialToolText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 24) return true
  return TRIVIAL_RE.test(trimmed)
}

/** 摘录候选：去重、去回执之后的结果。 */
export interface ToolExcerpt {
  /** 渲染用的正文（可能被首尾截断）。 */
  text: string
  /** 是否整条保留（false = 首尾截断）。 */
  full: boolean
}

/**
 * 截取 `text` 的开头 + 结尾。
 *
 * 为什么不是纯 head：工具输出的**结尾**常常是"结果/报错"（退出码、异常栈、失败
 * 汇总），开头则是命令与参数。两头各留一段，比只留开头更接近"当时发生了什么"。
 *
 * @param text - 原始正文。
 * @param cap - 最多多少字符（含截断标记）。
 * @returns 截断后的正文。
 */
export function headTail(text: string, cap: number): string {
  if (text.length <= cap) return text
  const marker = (dropped: number): string => `\n……[截断 ${dropped} 字符]……\n`
  // 先减去标记本身的长度，保证返回值 ≤ cap（标记里的数字位数不确定，用上界估算）。
  const reserve = 40
  const room = Math.max(0, cap - reserve)
  // 短摘录**只留开头**：250 字符量级的份额里再切 62/38，头只剩一百多字符，连
  // "命令/第一行报错"都盖不住（实测某条 1,229 字符的 read 结果里 `esbuild` 在
  // 偏移 147，62% 的头恰好差 6 个字符）。份额够长（>400）时才值得两头都留：
  // 那时开头是命令、结尾是结果/报错，中间才是可以丢的正文。
  if (cap <= 400) {
    const head = room
    return `${text.slice(0, head)}${marker(text.length - head)}`
  }
  const head = Math.floor(room * 0.62)
  const tail = room - head
  const dropped = text.length - head - tail
  return `${text.slice(0, head)}${marker(dropped)}${text.slice(-tail)}`
}

/** 渲染一条轮记录时，每个槽位头部的固定开销（保守上界）。 */
const SLOT_HEADER_RESERVE = 56

/**
 * 把一轮的工具结果编成一条 L3 记录的正文。
 *
 * @param turn - 轮号。
 * @param hits - 本轮全部工具结果（未过滤）。
 * @param maxChars - 单条记录正文上限。
 * @returns 正文；本轮没有可保存的结果时返回 null（调用方不要落一条空记录）。
 */
export function buildToolRecordText(
  turn: number,
  hits: readonly ToolResultHit[],
  maxChars: number,
): string | null {
  const totalChars = hits.reduce((sum, hit) => sum + hit.text.length, 0)
  if (hits.length === 0 || totalChars === 0) return null

  // 去重（同一份文件的重复读取、同一命令的重复执行）与去回执。
  const seen = new Set<string>()
  const candidates: ToolResultHit[] = []
  for (const hit of hits) {
    if (isTrivialToolText(hit.text)) continue
    const key = `${hit.name}\u0000${hit.text.trim()}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(hit)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.seq - b.seq)

  // 头部行 + 槽位头部的固定开销先扣掉，剩下的才是正文预算。
  const headerFor = (count: number): string => `${TOOL_RECORD_HEADER} · turn ${turn}\n`
    + `- 本轮工具结果 ${hits.length} 条 / ${totalChars} 字符；本记录摘录 ${count} 条（其余未存）。`
    + '这是当时工具/命令的原始输出，**不是结论**，引用前请自行判断。\n'
  // 上限配得很小时**减少条数**而不是返回 null：返回 null 会让用户"配了个上限、
  // 看着生效、实际一条都不写"——这正是本项目反复出现的静默故障形态。
  let picked = candidates.slice(0, TOOL_RESULTS_PER_TURN)
  let budget = maxChars - headerFor(picked.length).length - picked.length * SLOT_HEADER_RESERVE
  while (picked.length > 1 && budget < 200) {
    picked = picked.slice(0, picked.length - 1)
    budget = maxChars - headerFor(picked.length).length - picked.length * SLOT_HEADER_RESERVE
  }
  if (budget < 100) return null
  const header = headerFor(picked.length)

  // 每条先给一个基础开头；剩余预算按长度降序补给长输出。
  const base = Math.min(TOOL_BASE_SHARE_CHARS, Math.floor(budget / picked.length))
  const shares = picked.map((hit) => Math.min(base, hit.text.length))
  let spent = shares.reduce((sum, share) => sum + share, 0)
  const order = picked
    .map((_hit, index) => index)
    .sort((a, b) => (picked[b]?.text.length ?? 0) - (picked[a]?.text.length ?? 0))
  for (const index of order) {
    if (spent >= budget) break
    const hit = picked[index]
    if (hit === undefined) continue
    const room = Math.min(budget - spent, hit.text.length - (shares[index] ?? 0))
    if (room <= 0) continue
    shares[index] = (shares[index] ?? 0) + room
    spent += room
  }

  const slots = picked.map((hit, index) => {
    const share = shares[index] ?? 0
    const body = headTail(hit.text.trim(), share)
    return `[${index + 1}] ${hit.name} · seq ${hit.seq} · ${hit.text.length} 字符${body.length < hit.text.trim().length ? ' · 仅首尾' : ''}\n${body}`
  })
  const text = `${header}${slots.join('\n\n')}`
  // 兜底：渲染误差不能突破单条上限（上限是给用户看的硬承诺，不能"大约"）。
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/** 工具记录落库的开关与三个上限（与配置项一一对应）。 */
export interface ToolCaptureSettings {
  /** 总开关：false = 行为回到"工具输出不落库"。 */
  enabled: boolean
  /** 单条记录正文字符上限。 */
  maxChars: number
  /** 每会话最多几条工具记录。 */
  maxPerSession: number
  /** 整库最多几条工具记录（超出后滚动淘汰最旧的工具记录）。 */
  maxRecords: number
}

/** 蒸馏所需的存储窄接口（便于单测注入假库）。 */
export interface ToolCaptureStore {
  all(): readonly MemoryRecord[]
  put(input: {
    kind: MemoryRecord['kind']
    sessionId: string
    turnFrom: number
    turnTo: number
    text: string
    refs?: readonly string[]
  }): MemoryRecord
  /** 按 id 删除并落盘；返回实际删除条数。 */
  remove(ids: readonly string[]): number
}

/**
 * 为一轮落一条 `tool` 记录（幂等：同一会话同一轮只写一条）。
 *
 * @param input - 存储、会话、轮号、该轮工具结果与上限。
 * @returns 新记录；未写入（开关关、无内容、已存在、超每会话上限）时 null。
 */
export function captureToolRecord(input: {
  store: ToolCaptureStore
  sessionId: string
  turn: number
  hits: readonly ToolResultHit[]
  settings: ToolCaptureSettings
}): MemoryRecord | null {
  const { store, sessionId, turn, hits, settings } = input
  if (!settings.enabled) return null
  if (settings.maxChars < 200 || settings.maxPerSession <= 0 || settings.maxRecords <= 0) return null

  const records = store.all()
  // 幂等：崩溃/重启后水位可能回退，同一轮被重新扫到时不重复落库。
  for (const record of records) {
    if (record.kind === 'tool' && record.sessionId === sessionId && record.turnFrom === turn) return null
  }
  let sessionCount = 0
  const toolRecords: MemoryRecord[] = []
  for (const record of records) {
    if (record.kind !== 'tool') continue
    toolRecords.push(record)
    if (record.sessionId === sessionId) sessionCount += 1
  }
  if (sessionCount >= settings.maxPerSession) return null

  const text = buildToolRecordText(turn, hits, settings.maxChars)
  if (text === null) return null

  // 整库上限是滚动窗口：新细节挤掉最旧的细节，而不是让最早的那个会话永久占满。
  const overflow = toolRecords.length + 1 - settings.maxRecords
  if (overflow > 0) {
    const oldest = [...toolRecords]
      .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, overflow)
      .map((record) => record.id)
    store.remove(oldest)
  }

  return store.put({
    kind: 'tool',
    sessionId,
    turnFrom: turn,
    turnTo: turn,
    text,
    // refs 刻意留空：tool 记录一旦被 milestone/turn 引用，就成了"根节点"，会在
    // 剪枝里享受入边豁免，反过来挤占主内容——那正是本功能要避免的方向。
    refs: [],
  })
}
