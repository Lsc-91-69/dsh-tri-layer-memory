#!/usr/bin/env node
/**
 * verify-compression.mjs — 量化「三层记忆到底省了多少、又丢没丢东西」。
 *
 * 这个脚本回答三个问题，每个都给数字：
 *
 *   1. 省不省 —— 原始会话 token vs **实际注入** token；两种口径都报（见下）。
 *   2. 丢没丢 —— L3 里到底还剩多少（含重复率）；关键事实在不在 L3。
 *   3. 找得回 —— 一组"只在历史里、不在最近 N 轮"的事实，用**生产同款检索**
 *      能不能召回、前 3 名里有没有正确答案。
 *
 * ── 数据来源（按可信度从高到低，逐个字段降级，绝不把"不知道"写成 0）────────
 *
 *   A. `<sessionId>.diagnostics.json` 的 `injection` 块 —— 插件自己记账的
 *      **实际注入**读数（v0.1.22+ 才有）。这是第一来源。
 *   B. 会话日志里**最后一条投影消息**（`source.kind = dsh-tri-layer-memory`）。
 *      把它按四个块头切开、用插件的 `estimateTokens` 重新量——这是"真正灌进
 *      上下文的那段文本"，历史会话也能用。诊断字段缺失时靠它。
 *   C. 会话日志里最近 `--l1Turns` 轮（默认 8）的原文 token —— 只覆盖 L1，
 *      而且**它不是注入块**（L1 注入的是 marker，原文本来就在 surface 里）。
 *      这是老诊断文件的最末兜底，输出里会明确标注。
 *
 * ── 压缩比：三种自洽口径 + 一个字面公式，别混着读 ───────────────────────
 *
 *   A 主口径：不压缩时整段对话都要重发 vs 最近窗口**实际留在上下文里的内容**。
 *     分母 = 最近 N 轮的真实正文 + 工具参数 + **插件自己的历史投影**。
 *     最后一项最容易被漏掉：一个 turn 内每步都会注入一次，历史投影于是占满了窗口
 *     （实测本会话 55%）。它们是物理留在 surface 里的，所以 A 必须算进去。
 *     插件自 v0.1.23 起把投影**排除出 L1 窗口的统计**（不再计入"估算占用"、也不再
 *     喂给 L2 摘要），但**没有**把它们从上下文里删掉——所以 B 会跳、A 不会动。
 *     把 A 的分母改成"排除投影"会把压缩比虚报近一倍，那正是这个脚本要拦的事。
 *   B：不算 tool/call 参数，分母用插件自己的 L1 窗口（现在是"仅真实对话"）。
 *   C：反事实——只保留最新一条投影、历史投影不重放，这是理论上限。
 *   D：字面公式（日志全量 / 最新一次注入）。日志全量含推理块与历次投影，
 *      **不是系统级压缩比**；只用于对齐历史上的说法。
 *
 *   投影块里自报的 "82.4x" 是 **L2 摘要自己的输入/输出比**
 *   （`digest.sourceTokens / digest.tokens`），不是上下文压缩比——脚本会把
 *   两个数并排打出来，避免再把它们当成同一件事。
 *
 *   "原始会话"也有三个口径：日志全量（含推理/投影）、对话正文（插件 L1 口径，
 *   含 tool/call 参数）、消息正文（不含 tool/call）。脚本全部打印，各自成对比较。
 *   推理块不会在下一轮重放，投影是本插件的输出——两者都不该算进"被压缩的原始量"。
 *
 * ── 召回验证：为什么不复制一份检索逻辑 ──────────────────────────────
 *
 *   `search()` 的打分循环已抽成 `src/host/l3-deep.ts` 的 `searchRecords()`（纯重构，
 *   规则一个字没改），本脚本直接 import 生产实现。复制一份到脚本里，下次改检索时
 *   脚本会静默地继续测旧逻辑——那正是这个项目反复栽的"看起来在工作"的坑。
 *
 * 只读：会话日志、诊断文件、L3 库。不改任何东西，可重复跑。
 *
 * 用法：
 *   node scripts/verify-compression.mjs                    # 自动挑最新的会话
 *   node scripts/verify-compression.mjs --session <id>
 *   node scripts/verify-compression.mjs --l1Turns 8 --limit 5
 *   node scripts/verify-compression.mjs --json
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { contentToText, estimateTokens, messageBody, projectTurns } from '../src/host/l1-working.ts'
import { searchRecords } from '../src/host/l3-deep.ts'
import { FACTS } from './probes.mjs'

const require = createRequire(import.meta.url)
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const SESSIONS = join(HOME, 'sessions')
const TRI = join(HOME, 'tri-layer-memory')
const DB = join(TRI, 'deep-memory.sqlite')
const PLUGIN = 'dsh-tri-layer-memory'
const PROJECTION_HEAD = '# 三层记忆 · 本轮投影'

// ───────────────────────── zstd 帧解码（会话日志是拼接的多帧）─────────────────────────

/** DSH 的 session.v4.jsonl.zstd 是**多个 zstd 帧拼在一起**，不是单个流。 */
function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const events = []
  let i = 0
  let frames = 0
  let bad = 0
  // magic: 28 B5 2F FD
  while (i + 4 <= buf.length) {
    if (!(buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd)) { bad += 1; i += 1; continue }
    let next = i + 4
    while (next + 4 <= buf.length && !(buf[next] === 0x28 && buf[next + 1] === 0xb5 && buf[next + 2] === 0x2f && buf[next + 3] === 0xfd)) next += 1
    const frame = buf.subarray(i, next)
    i = next
    try {
      const text = zstd(frame)
      frames += 1
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try { events.push(JSON.parse(t)) } catch { /* 非 JSON 行忽略 */ }
      }
    } catch { bad += 1 }
  }
  return { events, frames, bad }
}

/** 用 Node 内建 zstd（22.15+/24+）；没有就抛错，由调用方降级。 */
function zstd(frame) {
  const zlib = require('node:zlib')
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('no zstd support')
  return zlib.zstdDecompressSync(frame).toString('utf8')
}

// ───────────────────────── 文本与历史口径 ─────────────────────────

/** 一条事件的正文（与既有测量同口径；含 tool/call 的参数）。 */
function eventText(ev) {
  const d = ev.data ?? {}
  if (ev.type === 'user/message') return typeof d.content === 'string' ? d.content : JSON.stringify(d.content ?? '')
  if (ev.type === 'assistant/message' || ev.type === 'tool/result') {
    const c = d.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n')
  }
  if (ev.type === 'tool/call') return `${d.name ?? ''} ${JSON.stringify(d.arguments ?? d.input ?? '')}`
  return ''
}

/** 是否是本插件注入的投影消息（不是用户/子代理的原始输入）。 */
function isProjection(ev) {
  if (ev.type !== 'user/message') return false
  const kind = ev.data?.source?.kind
  if (kind === PLUGIN) return true
  const text = eventText(ev)
  return typeof text === 'string' && text.startsWith(PROJECTION_HEAD)
}

/**
 * 按轮聚合正文（旧 → 新），**跳过本插件自己的投影**。
 *
 * 为什么必须跳过：投影里几乎复述了所有历史术语。把它算进"某轮出现过这个词"，
 * 最近 8 轮会命中一切，召回验证的"只在历史里"就没法成立——这是口径问题，不是检索问题。
 *
 * @param events - 会话事件。
 * @returns 轮号 → 该轮正文。
 */
function textsByTurn(events) {
  const map = new Map()
  let current = -1
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      current = typeof ev.data?.turn === 'number' ? ev.data.turn : current + 1
      continue
    }
    if (isProjection(ev)) continue
    const text = eventText(ev)
    if (!text) continue
    map.set(current, (map.get(current) ?? '') + '\n' + text)
  }
  return map
}

/**
 * 按轮拆开三类 token：对话正文 / 本插件投影 / 工具调用参数。
 *
 * **为什么要拆**：插件 L1 的 `window.tokens` 把**本插件历次注入的投影**也当成
 * user 消息算进"原文窗口"（它们确实是会话里的 user 消息）。实测本会话最近 8 轮里
 * 97,793 / 139,765 是插件自己的投影——不拆开就会把"插件塞进去的东西"说成
 * "未压缩的对话原文"，压缩比会失真。三类都用 {@link contentToText}（只取 text 块，
 * 与插件 L1 同口径；推理块不会在下一轮重放，不该算进对话上下文）。
 *
 * @param events - 会话事件。
 * @returns 各轮的正文 / 投影 / 调用参数 token，投影条数，以及最新一条投影。
 */
function decomposeByTurn(events) {
  const msg = new Map()
  const proj = new Map()
  const call = new Map()
  const projCount = new Map()
  let projCountTotal = 0
  let latest = null
  let current = -1
  const bump = (map, value) => map.set(current, (map.get(current) ?? 0) + value)
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      current = typeof ev.data?.turn === 'number' ? ev.data.turn : current + 1
      continue
    }
    if (isProjection(ev)) {
      const body = contentToText(ev.data?.content)
      const tokens = estimateTokens(body)
      bump(proj, tokens)
      projCount.set(current, (projCount.get(current) ?? 0) + 1)
      projCountTotal += 1
      if (body.startsWith(PROJECTION_HEAD)) latest = { text: body, seq: ev.seq, at: ev.time ?? null, tokens }
      continue
    }
    if (ev.type === 'tool/call') {
      bump(call, estimateTokens(eventText(ev)))
      continue
    }
    if (ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
      bump(msg, estimateTokens(contentToText(messageBody(ev.data ?? {}))))
    }
  }
  return { msg, proj, call, projCount, projCountTotal, latest }
}

// ───────────────────────── 投影拆块 ─────────────────────────

/** 四个注入块的块头（L2 正文里还有别的 `##`，只能按这四个锚点切）。 */
const BLOCK_HEADERS = {
  l1: '## L1 工作记忆',
  mainline: '## 里程碑主线骨架',
  l2: '## L2 短期记忆',
  l3: '## L3 深层记忆',
}

/**
 * 从投影全文中切出四个块（缺哪个就返回 null）。
 * @param text - 投影全文。
 * @returns 各块正文。
 */
function splitProjection(text) {
  const found = Object.entries(BLOCK_HEADERS)
    .map(([id, header]) => ({ id, at: text.indexOf(header) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)
  const out = { l1: null, mainline: null, l2: null, l3: null }
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].at : text.length
    out[found[i].id] = text.slice(found[i].at, end).replace(/\s+$/, '')
  }
  return out
}

/** 从 L1 块里读"原文窗口的估算占用"（块自己声明的那个数）。 */
function declaredL1Window(l1Block) {
  const m = /估算占用：约 (\d+) tokens/.exec(l1Block ?? '')
  return m === null ? null : Number(m[1])
}

// ───────────────────────── L3 读取 ─────────────────────────

/**
 * 读 L3 全部记录（优先 sqlite 只读，退回 JSONL）。
 *
 * @param dbPath - 库路径。**允许覆盖**：验证检索质量必须在**去重后的副本库**上做，
 *   真库里 1130 条重复副本会把 top-N 全占满，量出来的是"副本挤占"而不是检索质量。
 *   传副本路径而不是让脚本自己 cp，是为了让"到底测的哪个库"留在命令行里可复核。
 */
function loadRecords(dbPath = DB) {
  if (existsSync(dbPath)) {
    try {
      const { DatabaseSync } = require('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare('SELECT * FROM records ORDER BY createdAt ASC').all()
      db.close()
      return {
        backend: 'sqlite',
        records: rows.map((row) => ({
          id: String(row.id),
          kind: String(row.kind),
          createdAt: Number(row.createdAt),
          sessionId: String(row.sessionId),
          turnFrom: Number(row.turnFrom),
          turnTo: Number(row.turnTo),
          text: String(row.text),
          tokens: Number(row.tokens),
          keywords: JSON.parse(String(row.keywords)),
          refs: JSON.parse(String(row.refs)),
        })),
      }
    } catch {
      // sqlite 打不开（旧 Node / 文件被锁）就退回 JSONL，绝不把"读不到"当成"库是空的"。
    }
  }
  const jsonl = dbPath.toLowerCase().endsWith('.jsonl') ? dbPath : join(TRI, 'deep-memory.jsonl')
  if (!existsSync(jsonl)) return { records: [], backend: null }
  const records = readFileSync(jsonl, 'utf8').split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((record) => record?.id !== undefined)
  return { records, backend: 'jsonl' }
}

// ───────────────────────── 关键事实 ─────────────────────────

// 19 条探针的**唯一**定义在 scripts/probes.mjs（本脚本与 ablate-retrieval.mjs 共用，
// 保证"改前 / 改后"是同一个分母）。

/**
 * 量一量"同一轮的副本"有没有挤占检索的前 N 名。
 *
 * 为什么要单独量：上面那份召回验证只统计 `eligible`（"只在历史里、不在最近窗口"）
 * 的事实，而长会话里最近 8 轮几乎命中一切，`eligible` 会退化成 0——那时"召回 0/0"
 * 是个空分母，什么也证明不了。这一块**不看资格**，直接对同一组事实跑生产检索，
 * 回答的是另一个问题：返回的 5 条里有多少是同一轮的副本、前 3 名是不是被同一轮
 * 占满。去重前后各跑一次，就能给出"副本挤占 top-N"的硬数字。
 *
 * @param options - 全库记录、本会话记录、事实清单、条数上限。
 * @returns 汇总与逐条明细。
 */
function measureDuplication({ records, own, sid, facts, limit }) {
  const results = facts.map((fact) => {
    const hits = searchRecords(records, fact.query, limit)
    const rangeOf = (hit) => `${hit.kind}:${hit.sessionId}:${hit.turnFrom}:${hit.turnTo}`
    const top3 = hits.slice(0, 3)
    const probe = fact.probe.toLowerCase()
    const groundTruth = own.filter((record) => record.text.toLowerCase().includes(probe))
    const truthRank = groundTruth.length === 0
      ? 0
      : hits.findIndex((hit) => groundTruth.some((gt) => gt.id === hit.id)) + 1
    return {
      key: fact.key,
      hitCount: hits.length,
      distinctTop5: new Set(hits.map(rangeOf)).size,
      top3SameTurn: top3.length >= 2 && new Set(top3.map(rangeOf)).size === 1,
      top3Distinct: new Set(top3.map(rangeOf)).size,
      truthRank: truthRank > 0 ? truthRank : null,
    }
  })
  const sum = (pick) => results.reduce((total, result) => total + pick(result), 0)
  return {
    queries: results.length,
    // 命中集合里"不同轮次"的平均数：分母是 hits，分子是去重后的范围数。等于 hits 说明零副本。
    hits: sum((r) => r.hitCount),
    distinctHits: sum((r) => r.distinctTop5),
    top3SameTurn: results.filter((r) => r.top3SameTurn).length,
    probeInTop3: results.filter((r) => r.truthRank !== null && r.truthRank <= 3).length,
    probeFound: results.filter((r) => r.truthRank !== null).length,
    results,
  }
}

/**
 * 跑召回验证。
 *
 * @param records - 全库记录（与生产 recall 同一集合）。
 * @param own - 本会话记录。
 * @param facts - 事实清单。
 * @param options - `limit`：与 recall 默认条数一致（5）；`recentFrom`：最近窗口起始轮。
 * @returns 逐条结果与汇总。
 */
function verifyRecall({ records, own, sid, facts, limit, recentFrom, byTurn }) {
  const results = facts.map((fact) => {
    const probe = fact.probe.toLowerCase()
    const inRecent = [...byTurn.entries()]
      .filter(([turn]) => turn >= recentFrom)
      .some(([, text]) => text.toLowerCase().includes(probe))
    const inHistory = [...byTurn.entries()]
      .filter(([turn]) => turn < recentFrom)
      .some(([, text]) => text.toLowerCase().includes(probe))
    const groundTruth = own.filter((record) => record.text.toLowerCase().includes(probe))
    // 即使 L3 里没有这条事实，也照常检索——"返回了 5 条但它不在这里"与"一条都没有"
    // 是两种不同的失败（检索 vs 蒸馏），读数必须能分开。
    const hits = searchRecords(records, fact.query, limit)
    const rank = groundTruth.length === 0
      ? 0
      : hits.findIndex((hit) => groundTruth.some((gt) => gt.id === hit.id)) + 1
    const eligible = inHistory && !inRecent
    const top = hits.slice(0, 3).map((hit, index) => ({
      rank: index + 1,
      id: hit.id,
      kind: hit.kind,
      turn: hit.turnFrom === hit.turnTo ? `turn ${hit.turnFrom}` : `turn ${hit.turnFrom}–${hit.turnTo}`,
      own: hit.sessionId === sid,
      relevant: groundTruth.some((gt) => gt.id === hit.id),
    }))
    return {
      key: fact.key,
      query: fact.query,
      eligible,
      skipReason: eligible ? null
        : (inRecent ? '最近窗口里也出现过（不是"只在历史里"）' : '历史里从未出现'),
      inHistory,
      inRecent,
      inL3: groundTruth.length > 0,
      groundTruth: groundTruth.length,
      hitCount: hits.length,
      retrieved: rank > 0,
      rank: rank > 0 ? rank : null,
      top3: rank > 0 && rank <= 3,
      // 前 3 名里出现过的不同轮次：3 条全都是同一轮的副本时，"前 3 有答案"要打折扣。
      top3DistinctTurns: new Set(hits.slice(0, 3).map((hit) => `${hit.kind}:${hit.turnFrom}:${hit.turnTo}`)).size,
      top,
    }
  })
  const judged = results.filter((result) => result.eligible)
  return {
    limit,
    total: results.length,
    eligible: judged.length,
    inL3: judged.filter((result) => result.inL3).length,
    retrieved: judged.filter((result) => result.retrieved).length,
    top3: judged.filter((result) => result.top3).length,
    results,
  }
}

// ───────────────────────── 主流程 ─────────────────────────

/** 找到会话日志（显式 id 或最新一个）。 */
function pickSession(explicit) {
  if (!existsSync(SESSIONS)) return null
  const found = []
  for (const wk of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, wk)
    if (!statSync(dir).isDirectory()) continue
    for (const s of readdirSync(dir)) {
      const log = join(dir, s, 'session.v4.jsonl.zstd')
      if (!existsSync(log)) continue
      if (explicit !== undefined && s !== explicit) continue
      found.push({ id: s, log, mtime: statSync(log).mtimeMs })
    }
  }
  if (explicit !== undefined) return found[0] ?? { id: explicit, log: null, mtime: 0 }
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0] ?? null
}

/** 读诊断文件里的 injection 块（没有就返回 null，不编造 0）。 */
function readDiagnostics(sid) {
  const path = join(TRI, `${sid}.diagnostics.json`)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * 决定每个数字的来源：诊断 → 投影消息 → 日志 L1（仅 L1）。
 *
 * @returns `{ values, source, detail }`；`values` 里拿不到的项是 null。
 */
function resolveInjection({ diag, lastProjection, l1WindowTokens }) {
  const acct = diag?.injection ?? null
  const blocks = lastProjection === null ? null : splitProjection(lastProjection.text)
  const fromBlocks = blocks === null ? null : {
    l1Tokens: blocks.l1 === null ? null : estimateTokens(blocks.l1),
    l2Tokens: blocks.l2 === null ? null : estimateTokens(blocks.l2),
    l3Tokens: blocks.l3 === null ? null : estimateTokens(blocks.l3),
    mainlineTokens: blocks.mainline === null ? 0 : estimateTokens(blocks.mainline),
  }
  const values = {
    l1Tokens: acct?.l1Tokens ?? fromBlocks?.l1Tokens ?? l1WindowTokens,
    l2Tokens: acct?.l2Tokens ?? fromBlocks?.l2Tokens ?? null,
    l3Tokens: acct?.l3Tokens ?? fromBlocks?.l3Tokens ?? null,
    mainlineTokens: acct?.mainlineTokens ?? fromBlocks?.mainlineTokens ?? null,
    budgetTokens: acct?.budgetTokens ?? null,
    dropped: acct?.dropped ?? null,
    at: acct?.at ?? null,
  }
  const allFour = values.l1Tokens !== null && values.l2Tokens !== null
    && values.l3Tokens !== null && values.mainlineTokens !== null
  values.totalInjected = acct?.totalInjected
    ?? (allFour ? values.l1Tokens + values.l2Tokens + values.l3Tokens + values.mainlineTokens : null)

  const source = acct !== null ? 'diagnostics.injection'
    : fromBlocks !== null ? 'log.lastProjection（旧诊断无 injection，按实际注入文本重新量）'
      : 'log.l1Window（只有 L1 原文可用，L2/L3/骨架未知）'
  return { values, source, blocks }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`)
    if (at < 0) return fallback
    const raw = argv[at + 1]
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
  }
  const explicit = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : undefined
  const dbAt = argv.indexOf('--db')
  const dbOverride = dbAt < 0 ? DB : argv[dbAt + 1]
  const asJson = argv.includes('--json')
  const l1Turns = flag('l1Turns', 8)
  const limit = flag('limit', 5) // 与 recall 的默认条数一致（config: recallDefaultLimit=5）

  const picked = pickSession(explicit)
  if (!picked) {
    console.error('找不到会话日志（在 $DSH_HOME/sessions/*/<id>/session.v4.jsonl.zstd 下）')
    process.exit(2)
  }
  const sid = picked.id
  if (picked.log === null) {
    console.error(`找不到会话 ${sid} 的日志`)
    process.exit(2)
  }

  // 1) 原始会话体量与轮次
  let decoded
  try {
    decoded = decodeSessionLog(picked.log)
  } catch (e) {
    console.error(`会话日志解码失败：${e.message}`)
    process.exit(2)
  }
  const spans = projectTurns(decoded.events)
  const byTurn = textsByTurn(decoded.events)
  const decomposed = decomposeByTurn(decoded.events)
  const lastProjection = decomposed.latest
  const sumMap = (map, turns) => turns.reduce((sum, turn) => sum + (map.get(turn) ?? 0), 0)
  const allTurns = [...new Set([...decomposed.msg.keys(), ...decomposed.proj.keys(), ...decomposed.call.keys()])]
  // 真实对话正文 = 消息正文 + 工具调用参数（不含推理块、不含本插件投影）。
  const rawConversationTokens = sumMap(decomposed.msg, allTurns) + sumMap(decomposed.call, allTurns)
  const rawMessageTokens = sumMap(decomposed.msg, allTurns)
  const rawProjectionTokens = sumMap(decomposed.proj, allTurns)
  // 旧脚本口径（所有事件正文，含推理块与投影）：用来和历史上的 "≈1,606,308" 对齐。
  let rawChars = 0
  let rawLogTokens = 0
  for (const ev of decoded.events) {
    const text = eventText(ev)
    if (!text) continue
    rawChars += text.length
    rawLogTokens += estimateTokens(text)
  }
  // 差值 = 推理块（assistant 的非 text 块）与 JSON 序列化开销；它们不进下一轮上下文。
  const rawOtherTokens = rawLogTokens - rawConversationTokens - rawProjectionTokens
  const turnCount = spans.filter((span) => span.turn >= 0).length

  // 2) L1 原文窗口：插件同款口径（projectTurns 的 span.tokens），再按来源拆开
  const recentSpans = spans.slice(-l1Turns)
  const recentTurns = recentSpans.map((span) => span.turn)
  const recentFrom = recentTurns[0] ?? 0
  const l1WindowTokens = recentSpans.reduce((sum, span) => sum + span.tokens, 0)
  const l1Msg = sumMap(decomposed.msg, recentTurns)
  const l1Call = sumMap(decomposed.call, recentTurns)
  const l1Proj = sumMap(decomposed.proj, recentTurns)
  const l1ProjCount = recentTurns.reduce((sum, turn) => sum + (decomposed.projCount.get(turn) ?? 0), 0)
  // 自检：插件窗口**只含真实对话正文**（v0.1.23 起 projectTurns 排除本插件投影）。
  // 对不上说明拆解口径和 projectTurns 又不一致了，必须报出来。
  const l1DecompositionOk = l1Msg === l1WindowTokens

  // 3) 注入量：诊断 → 投影 → L1 兜底
  const diag = readDiagnostics(sid)
  const { values, source, blocks } = resolveInjection({ diag, lastProjection, l1WindowTokens })

  // 4) L3
  const { records, backend } = loadRecords(dbOverride)
  const own = records.filter((record) => record.sessionId === sid)
  const sumTokens = (list) => list.reduce((sum, record) => sum + record.tokens, 0)
  const keyOf = (record) => `${record.kind}:${record.turnFrom}:${record.turnTo}`
  const distinctOwn = new Set(own.map(keyOf)).size
  const kinds = {}
  for (const record of own) {
    const slot = kinds[record.kind] ?? (kinds[record.kind] = { count: 0, tokens: 0 })
    slot.count += 1
    slot.tokens += record.tokens
  }
  const l3 = {
    backend: backend ?? diag?.l3?.backend ?? null,
    libraryCount: records.length,
    libraryTokens: sumTokens(records),
    sessionCount: own.length,
    sessionTokens: sumTokens(own),
    distinctSessionCount: distinctOwn,
    duplicateSessionCount: own.length - distinctOwn,
    kinds,
  }

  // 5) 召回验证
  const recall = verifyRecall({ records, own, sid, facts: FACTS, limit, recentFrom, byTurn })
  // 5b) 副本挤占 top-N：不看 eligible，去重前后各跑一次才有可比性。
  const duplication = measureDuplication({ records, own, sid, facts: FACTS, limit })

  // 6) 压缩比（分子分母都只算"真正进对话的内容"：无推理块、无序列化开销）
  const injectionTotal = values.totalInjected
  const canRatio = injectionTotal !== null && injectionTotal > 0
  const actualFootprint = l1Msg + l1Call + l1Proj
  const latestFootprint = l1Msg + l1Call + (lastProjection?.tokens ?? 0)
  const ratios = {
    // 字面公式：日志全量 / 最新一次注入。含投影与推理，只用于对齐历史说法，不是系统级压缩比。
    rawLogPerInjection: canRatio ? rawLogTokens / injectionTotal : null,
    // 主口径：不压缩时整段对话都要重发 vs 最近窗口实际留在上下文里的内容（含历史投影）。
    actual: actualFootprint > 0 ? rawConversationTokens / actualFootprint : null,
    // 同上，但两边都不算 tool/call 参数（插件 L1 口径；宿主是否重放调用参数未知）。
    pluginWindow: l1WindowTokens > 0 ? rawMessageTokens / l1WindowTokens : null,
    // 反事实：只保留最新一条投影、历史投影不重放时的上限。
    latestOnly: latestFootprint > 0 ? rawConversationTokens / latestFootprint : null,
    uncompressed: rawConversationTokens,
    actualFootprint,
    latestFootprint,
    projectionShare: actualFootprint > 0 ? l1Proj / actualFootprint : null,
  }

  const output = {
    session: sid,
    log: picked.log,
    snapshotAt: new Date().toISOString(),
    logFrames: decoded.frames,
    logBadFrames: decoded.bad,
    events: decoded.events.length,
    turns: turnCount,
    spans: spans.length,
    raw: {
      chars: rawChars,
      // 旧脚本口径：所有事件正文（含推理块、含本插件投影）。用于和 "≈1,606,308" 对齐。
      logTokens: rawLogTokens,
      // 真实对话正文：消息 text 块 + tool/call 参数（不含推理、不含投影）。
      conversationTokens: rawConversationTokens,
      messageTokens: rawMessageTokens,
      pluginProjectionTokens: rawProjectionTokens,
      pluginProjectionMessages: decomposed.projCountTotal,
      // 推理块 + JSON 序列化开销（不进下一轮上下文）。
      otherTokens: rawOtherTokens,
    },
    injection: {
      source,
      at: values.at,
      l1Tokens: values.l1Tokens,
      l2Tokens: values.l2Tokens,
      l3Tokens: values.l3Tokens,
      mainlineTokens: values.mainlineTokens,
      totalInjected: values.totalInjected,
      budgetTokens: values.budgetTokens,
      dropped: values.dropped,
      // L1 的注入块（marker）、L1 原文窗口、窗口里的历史投影，是三个不同的量。
      l1Window: {
        turns: recentSpans.length,
        from: recentTurns[0] ?? null,
        to: recentTurns.at(-1) ?? null,
        tokens: l1WindowTokens,
        realMessageTokens: l1Msg,
        toolCallTokens: l1Call,
        projectionTokens: l1Proj,
        projectionMessages: l1ProjCount,
        latestProjectionTokens: lastProjection?.tokens ?? null,
        decompositionOk: l1DecompositionOk,
      },
      // 旧诊断有 injection 块时，顺手核对一下：记账值 vs 实际投影文本（差太多说明有一处读数是假的）。
      crossCheck: blocks === null ? null : {
        projectionSeq: lastProjection?.seq ?? null,
        l1Tokens: blocks.l1 === null ? null : estimateTokens(blocks.l1),
        l2Tokens: blocks.l2 === null ? null : estimateTokens(blocks.l2),
        l3Tokens: blocks.l3 === null ? null : estimateTokens(blocks.l3),
        mainlineTokens: blocks.mainline === null ? null : estimateTokens(blocks.mainline),
        declaredL1Window: declaredL1Window(blocks.l1),
        messageTokens: estimateTokens(lastProjection.text),
      },
    },
    l3,
    recall,
    recallDuplication: duplication,
    ratios,
  }

  if (asJson) { console.log(JSON.stringify(output, null, 2)); return }

  const num = (n) => (n === null || n === undefined ? '—' : n.toLocaleString())
  const ratio = (n) => (n === null ? '—' : `${n.toFixed(1)}×`)

  console.log(`会话 ${sid}`)
  console.log(`日志 ${decoded.frames} 帧（坏 ${decoded.bad}）· ${decoded.events.length} 事件 · ${turnCount} 轮`)
  console.log(`快照 ${output.snapshotAt}（会话仍在运行的话，数字会随日志增长）`)
  console.log('')
  console.log('— 原始体量（三个口径，别混）—')
  console.log(`  日志全量（旧脚本口径）  ${rawLogTokens.toLocaleString()} tok / ${rawChars.toLocaleString()} 字符`)
  console.log('    含推理块与本插件投影；能和历史上的 ≈1,606,308 对齐，但不是"对话内容"')
  console.log(`  对话正文（插件 L1 口径） ${rawConversationTokens.toLocaleString()} tok`)
  console.log('    user/assistant/tool-result 的 text 块 + tool/call 参数；不含推理、不含投影')
  console.log(`    其中本插件历次投影 ${decomposed.projCountTotal} 条 / ${rawProjectionTokens.toLocaleString()} tok`
    + `；其余 ${rawOtherTokens.toLocaleString()} tok 是推理块/序列化（不进下一轮上下文）`)
  console.log('')
  console.log(`— 实际注入（来源：${source}）—`)
  const isL1Fallback = source.startsWith('log.l1Window')
  console.log(`  L1 工作记忆   ${num(values.l1Tokens).padStart(9)} tok   ${isL1Fallback ? '（原文窗口兜底，不是注入块！）' : '（marker 注入块）'}`)
  console.log(`  L2 短期摘要   ${num(values.l2Tokens).padStart(9)} tok`)
  console.log(`  L3 深层索引   ${num(values.l3Tokens).padStart(9)} tok`)
  console.log(`  主线骨架      ${num(values.mainlineTokens).padStart(9)} tok   （独立上限，不进仲裁但确实注入）`)
  console.log(`  ─────────────────────────────`)
  console.log(`  注入合计      ${num(injectionTotal).padStart(9)} tok`
    + (values.budgetTokens === null ? '' : `（仲裁预算 ${values.budgetTokens}，只约束 L1/L2/L3）`))
  if (values.dropped !== null) console.log(`  被整块丢弃    ${values.dropped.length === 0 ? '无' : values.dropped.join('/')}`)
  if (values.at !== null) console.log(`  注入时刻      ${values.at}`)
  console.log('')
  console.log(`— L1 窗口拆解（最近 ${recentSpans.length} 轮：turn ${recentTurns[0] ?? '—'}–${recentTurns.at(-1) ?? '—'}）—`)
  console.log(`  真实对话正文        ${l1Msg.toLocaleString().padStart(12)} tok`)
  console.log(`  工具调用参数        ${l1Call.toLocaleString().padStart(12)} tok`)
  console.log(`  本插件历次投影      ${l1Proj.toLocaleString().padStart(12)} tok`
    + `（${l1ProjCount} 条；最新一条 ${lastProjection === null ? '—' : lastProjection.tokens.toLocaleString()}）`)
  console.log('  ─────────────────────────────────')
  console.log(`  插件口径窗口        ${l1WindowTokens.toLocaleString().padStart(12)} tok`
    + '（只含真实对话正文：投影已被排除、调用参数不计）')
  console.log(`  含调用参数的实际面  ${ratios.actualFootprint.toLocaleString().padStart(12)} tok`
    + '（正文 + 调用参数 + 历史投影，全是物理留在 surface 的）')
  console.log(`  插件投影占比        ${(ratios.projectionShare * 100).toFixed(1).padStart(12)} %`)
  if (!l1DecompositionOk) {
    console.log(`  ⚠ 拆解自检失败：真实对话 ${l1Msg} ≠ 插件窗口 ${l1WindowTokens}`
      + ' —— 说明拆解口径和 projectTurns 不一致，别引用下面的比例。')
  }
  const cross = output.injection.crossCheck
  if (cross !== null && cross.declaredL1Window !== null) {
    console.log(`  投影块自报          ${cross.declaredL1Window.toLocaleString().padStart(12)} tok`
      + (cross.declaredL1Window !== l1WindowTokens
        ? `   ⚠ 与按日志重算的差 ${(l1WindowTokens - cross.declaredL1Window).toLocaleString()}`
          + '（两个原因：投影在注入当时量、日志在那之后又长过；以及旧版投影的"估算占用"'
          + '把本插件历次投影也算进去了——新版已排除）'
        : ''))
  }
  console.log('')
  console.log('— 压缩比（按"真实对话正文"算，三种口径）—')
  console.log(`  A. 实际每轮上下文面（含历史投影+调用参数）  `
    + `${rawConversationTokens.toLocaleString()} / ${ratios.actualFootprint.toLocaleString()} = ${ratio(ratios.actual).padStart(8)}   ← 主口径`)
  console.log(`  B. 不算调用参数（两边都只算消息正文）      `
    + `${rawMessageTokens.toLocaleString()} / ${l1WindowTokens.toLocaleString()} = ${ratio(ratios.pluginWindow).padStart(8)}`)
  console.log(`  C. 反事实：只保留最新一条投影              `
    + `${rawConversationTokens.toLocaleString()} / ${ratios.latestFootprint.toLocaleString()} = ${ratio(ratios.latestOnly).padStart(8)}`)
  console.log(`  D. 字面公式（日志全量 / 最新一次注入）     `
    + `${rawLogTokens.toLocaleString()} / ${num(injectionTotal)} = ${ratio(ratios.rawLogPerInjection).padStart(8)}   ← 不是系统级压缩比`)
  const declaredL2 = /压缩比约 ([\d.]+)x/.exec(blocks?.l2 ?? '')
  if (declaredL2 !== null) {
    console.log(`  注：投影块里自报的 ${declaredL2[1]}× 是 **L2 摘要自己的输入/输出比**（digest.sourceTokens / digest.tokens），`)
    console.log('      不是"三层记忆压缩了多少上下文"。A 才是上下文口径。')
  }
  if (ratios.projectionShare > 0.3) {
    console.log(`  ⚠ 这 8 轮的物理面里 ${(ratios.projectionShare * 100).toFixed(0)}% 是插件自己的历史投影（${l1ProjCount} 条）：`)
    console.log('     插件已把它们排除出 L1 窗口的统计（不计入"估算占用"、也不再喂给 L2 摘要），')
    console.log('     但它们**仍然物理留在会话日志与 surface 里**——排除窗口 ≠ 从上下文删掉。')
    console.log('     要真正压低物理占用，得让同一份投影不再逐步重注入（本脚本不改行为）。')
  }
  console.log('')
  console.log('— L3 深层记忆 —')
  console.log(`  整库 ${l3.libraryCount} 条 / ${l3.libraryTokens.toLocaleString()} tok（后端 ${l3.backend ?? '未打开'}）`)
  console.log(`  本会话 ${l3.sessionCount} 条 / ${l3.sessionTokens.toLocaleString()} tok`
    + `，去重后 ${l3.distinctSessionCount} 条（重复 ${l3.duplicateSessionCount} 条）`)
  if (l3.duplicateSessionCount > 0) {
    console.log(`    ⚠ 同一 (kind, turnFrom, turnTo) 有多份：进程重启后 l3HighWaterTurn 归零，会把同一轮重复蒸馏。`)
    console.log(`      重复会挤占检索结果的 top-N（同样的事实出现 5 次，别的事实就进不来了）。`)
  }
  for (const [kind, slot] of Object.entries(l3.kinds)) {
    console.log(`    ${kind.padEnd(10)} ${String(slot.count).padStart(5)} 条 / ${slot.tokens.toLocaleString().padStart(7)} tok`)
  }
  console.log('')
  console.log('— 关键事实召回（只在历史、不在最近窗口）—')
  console.log(`  合格事实 ${recall.eligible}/${recall.total} 条 · L3 里存在 ${recall.inL3} 条`
    + ` · 探针命中 ${recall.retrieved} 条（top-${recall.limit}）· 前 3 名含探针 ${recall.top3} 条`)
  console.log('  注：这里的"相关"是**子串口径**——记录正文包含 probe 就算命中。'
    + '它不等于"回答了问题"；摘要只提到术语时也会算命中，需要人工核对。')
  for (const result of recall.results) {
    if (!result.eligible) {
      console.log(`  ⊘ ${result.key} —— 不计入：${result.skipReason}`)
      continue
    }
    const verdict = result.top3 ? '前 3 名含探针' : result.retrieved ? `第 ${result.rank} 名含探针` : '未命中探针'
    console.log(`  ${result.retrieved ? '●' : '○'} ${result.key}`)
    console.log(`      查询：${result.query}`)
    console.log(`      L3 相关记录 ${result.groundTruth} 条 · 返回 ${result.hitCount} 条 · ${verdict}`
      + ` · 前 3 名覆盖 ${result.top3DistinctTurns} 个不同轮次`)
    for (const hit of result.top) {
      console.log(`        #${hit.rank} ${hit.relevant ? '✓' : ' '} ${hit.id} [${hit.kind}] ${hit.turn}`
        + (hit.own ? '（本会话）' : '（别的会话）'))
    }
  }

  console.log('')
  console.log('— 同轮副本对 top-N 的挤占（不看 eligible，去重前后可直接对比）—')
  console.log(`  ${duplication.queries} 条查询 · 返回 ${duplication.hits} 条命中`
    + ` · 去重后只剩 ${duplication.distinctHits} 个"不同轮次"（副本 ${duplication.hits - duplication.distinctHits} 条）`)
  console.log(`  前 3 名全是同一轮：${duplication.top3SameTurn}/${duplication.queries} 条查询`
    + ` · 前 3 名含答案探针：${duplication.probeInTop3}/${duplication.queries}`
    + ` · 前 5 名找得到探针：${duplication.probeFound}/${duplication.queries}`)
  for (const result of duplication.results.filter((r) => r.top3SameTurn)) {
    console.log(`    ⚠ ${result.key}：前 3 名同属一轮，探针${result.truthRank === null ? '不在前 5' : `排第 ${result.truthRank}`}`)
  }

  // 退出码保持 0：这是度量脚本，读数差不是"脚本失败"。
  if (recall.eligible === 0) {
    console.log('')
    console.log('⚠ 没有一条事实同时满足"历史里有、最近窗口里没有"——本次召回验证是空的，别引用上面的分母。')
  }
}

main()
