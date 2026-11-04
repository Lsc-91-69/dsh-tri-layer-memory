#!/usr/bin/env node
/**
 * ablate-retrieval.mjs — 检索三项改动（3a 停用词 / 3b IDF / 3c digest 降权）的**消融实验**。
 *
 * 为什么需要它：任务 3 的验收要求"每一项单独加 vs 组合"的对比表。逐项开关必须跑
 * **生产那份打分循环**（`rankRecords`），不能在脚本里复制一份——复制了，下次改检索
 * 脚本会继续测旧逻辑，读数就变成假的。所以 `searchRecords` / `extractKeywords` 留了
 * `tuning` / `stopwords` 参数，本脚本用同一份实现换旋钮。
 *
 * 口径与 `verify-compression.mjs` 的"同轮副本对 top-N 的挤占"块完全一致：
 *   - 同一套 19 条探针（scripts/probes.mjs）；
 *   - 同一个库（**去重后的副本库**，`--db` 指定；真库的 1130 条副本会把 top-N 占满，
 *     量出来的是"副本挤占"而不是检索质量）；
 *   - `truthRank` = 生产检索返回的前 5 名里，第一条**正文包含 probe** 的本会话记录的名次；
 *     0 = 前 5 名都没有。这是子串口径，不等于"回答了问题"，最终仍需人看 top-3。
 *
 * 用法：
 *   node scripts/ablate-retrieval.mjs --db <去重副本.sqlite> --session <id>
 *   node scripts/ablate-retrieval.mjs --db <...> --session <id> --detail   # 逐条 rank 变化
 *   node scripts/ablate-retrieval.mjs --db <...> --session <id> --sweep    # digest 系数扫描
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import {
  BASE_STOPWORDS, STOPWORDS, buildDocFreq, extractKeywords, rankRecords, searchRecords,
} from '../src/host/l3-deep.ts'
import { FACTS } from './probes.mjs'

const require = createRequire(import.meta.url)
const argv = process.argv.slice(2)
const value = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at < 0 ? undefined : argv[at + 1]
}
const DB = value('db')
const SID = value('session')
const DETAIL = argv.includes('--detail')
const SWEEP = argv.includes('--sweep')
const LIMIT = Number(value('limit') ?? 5)

if (DB === undefined || SID === undefined) {
  console.error('用法：node scripts/ablate-retrieval.mjs --db <去重副本.sqlite> --session <id> [--detail] [--sweep]')
  process.exit(2)
}
if (!existsSync(DB)) {
  console.error(`找不到库：${DB}`)
  process.exit(2)
}

/** 读库（只读）。与 verify-compression 同解析方式。 */
function load(pickAll) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(DB, { readOnly: true })
  const q = pickAll ? 'SELECT * FROM records ORDER BY createdAt ASC' : 'SELECT * FROM records LIMIT 0'
  const rows = db.prepare(q).all()
  db.close()
  return rows.map((row) => ({
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
  }))
}

const records = load(true)
const own = records.filter((record) => record.sessionId === SID)
if (records.length === 0) {
  console.error('库里没有记录')
  process.exit(2)
}

/** 本会话里"正文包含 probe"的记录 = 这条事实的正确答案集合。 */
const truthOf = new Map()
for (const fact of FACTS) {
  const probe = fact.probe.toLowerCase()
  truthOf.set(fact.key, own.filter((record) => record.text.toLowerCase().includes(probe)))
}

/** 一轮配置下的全部读数。 */
function evaluate(label, tuning) {
  const rows = []
  for (const fact of FACTS) {
    const hits = searchRecords(records, fact.query, LIMIT, tuning)
    const truth = truthOf.get(fact.key)
    const rank = truth.length === 0 ? 0 : hits.findIndex((hit) => truth.some((t) => t.id === hit.id)) + 1
    // 症状 3 真正问的是「具体那一条能不能排上来」，而摘要命中会被子串口径记成"成功"。
    // 所以单列一个只看**非 digest** 正确答案的名次。
    const specific = truth.filter((record) => record.kind !== 'digest')
    const specificRank = specific.length === 0
      ? null
      : hits.findIndex((hit) => specific.some((t) => t.id === hit.id)) + 1
    const rangeOf = (hit) => `${hit.kind}:${hit.turnFrom}:${hit.turnTo}`
    rows.push({
      key: fact.key,
      rank,
      truth: truth.length,
      specificRank,
      specific: specific.length,
      top: hits.slice(0, 3),
      digestInTop: hits.filter((hit) => hit.kind === 'digest').length,
      charsTop3: hits.slice(0, 3).reduce((sum, hit) => sum + hit.text.length, 0) / Math.max(1, hits.slice(0, 3).length),
      top3SameTurn: hits.length >= 3 && new Set(hits.slice(0, 3).map(rangeOf)).size === 1,
    })
  }
  const count = (pick) => rows.filter(pick).length
  const withSpecific = rows.filter((row) => row.specific > 0)
  return {
    label,
    tuning,
    rows,
    top3: count((r) => r.rank > 0 && r.rank <= 3),
    top5: count((r) => r.rank > 0),
    sameTurn: count((r) => r.top3SameTurn),
    digestTop3: rows.reduce((sum, r) => sum + r.top.filter((h) => h.kind === 'digest').length, 0),
    digestTop5: rows.reduce((sum, r) => sum + r.digestInTop, 0),
    // 只看"具体记录"的召回：分母是"L3 里存在非 digest 正确答案"的探针数。
    specificTop3: withSpecific.filter((r) => r.specificRank !== null && r.specificRank > 0 && r.specificRank <= 3).length,
    specificTop5: withSpecific.filter((r) => r.specificRank !== null && r.specificRank > 0).length,
    specificTotal: withSpecific.length,
    avgTop3Chars: Math.round(rows.reduce((sum, r) => sum + r.charsTop3, 0) / rows.length),
  }
}

const CO = { stopwords: BASE_STOPWORDS, idf: false, digestWeight: 1 }
const A = { stopwords: STOPWORDS, idf: false, digestWeight: 1 }
const B = { stopwords: BASE_STOPWORDS, idf: true, digestWeight: 1 }
const C = { stopwords: BASE_STOPWORDS, idf: false, digestWeight: 0.5 }
const ALL = { stopwords: STOPWORDS, idf: true, digestWeight: 0.5 }

console.log(`库：${DB}（${records.length} 条记录 / ${own.length} 条本会话）`)
console.log(`探针：${FACTS.length} 条 · 前 ${LIMIT} 名 · truthRank = 首条"正文含 probe"的本会话记录的名次`)
console.log('')

const configs = [
  evaluate('现状（基线）', CO),
  evaluate('+3a 停用词', A),
  evaluate('+3b IDF', B),
  evaluate(`+3c digest×${C.digestWeight}`, C),
  evaluate('全部（3a+3b+3c）', ALL),
]

const pad = (s, n) => String(s).padEnd(n)
console.log('主表（口径 A：探针子串命中，digest 也算成功）')
console.log(`| ${pad('配置', 22)} | top-3 | top-5 | 前3同轮 | top-3 digest |`)
console.log(`|${'-'.repeat(24)}|-------|-------|---------|--------------|`)
for (const config of configs) {
  console.log(`| ${pad(config.label, 22)} | ${String(config.top3).padStart(5)}/${FACTS.length} | `
    + `${String(config.top5).padStart(5)}/${FACTS.length} | `
    + `${String(config.sameTurn).padStart(7)}/${FACTS.length} | ${String(config.digestTop3).padStart(12)} |`)
}
console.log('')
console.log(`副表（口径 B：只认**非 digest** 的具体记录；分母 = L3 里存在非 digest 正确答案的 ${configs[0].specificTotal} 条探针）`)
console.log(`| ${pad('配置', 22)} | 具体记录进 top-3 | 进 top-5 | top-3 平均正文长度 |`)
console.log(`|${'-'.repeat(24)}|------------------|----------|--------------------|`)
for (const config of configs) {
  console.log(`| ${pad(config.label, 22)} | ${String(config.specificTop3).padStart(10)}/${config.specificTotal} | `
    + `${String(config.specificTop5).padStart(4)}/${config.specificTotal} | ${String(config.avgTop3Chars).padStart(18)} 字符 |`)
}

if (DETAIL) {
  console.log('')
  console.log('逐条 rank（0 = 前 5 名里没有正确答案；— = L3 里根本没有这条事实）')
  const head = FACTS.map((f) => f.key)
  for (const config of configs) {
    console.log('')
    console.log(config.label)
    for (const row of config.rows) {
      console.log(`  ${row.truth === 0 ? '—' : String(row.rank).padStart(2)}  ${row.key}`
        + `  (L3 ${row.truth} 条 / 其中具体记录 ${row.specific} 条，具体记录名次 ${row.specificRank ?? '—'}` 
        + `${row.rank === 0 && row.truth > 0 ? '，未进前 5' : ''})`)
    }
  }
  void head
}

// ── 打分拆分：证明"分数退化"到底有没有被打断 ──────────────────────────
console.log('')
console.log('分数分布（19 条查询合并）：命中记录里"与最高分同分"的条数占比，越高说明排序越由 createdAt 决定')
for (const config of [configs[0], configs[4]]) {
  let hitsTotal = 0
  let tiedToTop = 0
  for (const fact of FACTS) {
    const ranked = rankRecords(records, fact.query, config.tuning)
    if (ranked.length === 0) continue
    const max = Math.max(...ranked.map((r) => r.score))
    hitsTotal += ranked.length
    tiedToTop += ranked.filter((r) => Math.abs(r.score - max) < 1e-9).length
  }
  console.log(`  ${pad(config.label, 22)} 命中 ${String(hitsTotal).padStart(5)} 条 · 与最高分同分 ${String(tiedToTop).padStart(5)} 条`
    + ` = ${((tiedToTop / hitsTotal) * 100).toFixed(1)}%`)
}

// ── digest 系数扫描 ──────────────────────────────────────────────────
if (SWEEP) {
  console.log('')
  console.log('digest 降权系数扫描（3a + 3b 已开）')
  console.log('| 系数 | 口径A top-3 | 口径B 具体 top-3 | 前3同轮 | top-3 digest | top-3 平均正文 |')
  console.log('|------|-------------|------------------|---------|--------------|----------------|')
  for (const w of [1, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const e = evaluate(`digest×${w}`, { stopwords: STOPWORDS, idf: true, digestWeight: w })
    console.log(`| ${String(w).padStart(4)} | ${String(e.top3).padStart(6)}/${FACTS.length}`
      + ` | ${String(e.specificTop3).padStart(11)}/${e.specificTotal}`
      + ` | ${String(e.sameTurn).padStart(7)}/${FACTS.length}`
      + ` | ${String(e.digestTop3).padStart(12)} | ${String(e.avgTop3Chars).padStart(13)} 字符 |`)
  }
}

// ── 词表建表耗时（IDF 的成本）────────────────────────────────────────
const allTerms = [...new Set(FACTS.flatMap((fact) => extractKeywords(fact.query, 16)))]
const time = (list) => {
  const t0 = process.hrtime.bigint()
  buildDocFreq(list, allTerms)
  return Number(process.hrtime.bigint() - t0) / 1e6
}
for (const size of [358, records.length]) {
  if (size > records.length) continue
  const corpus = records.slice(0, size)
  void time(corpus) // 预热（JIT + 正则缓存）
  const runs = 20
  let total = 0
  for (let i = 0; i < runs; i += 1) total += time(corpus)
  console.log('')
  console.log(`词表建表：${size} 条记录 × ${allTerms.length} 个查询词 → 平均 ${(total / runs).toFixed(2)} ms（${runs} 次）`)
}

// ── 三个已知失败案例的人工核对 ───────────────────────────────────────
console.log('')
console.log('三个已知失败案例：改前 / 改后的 top-3（人工看相关，不只看 probe 是否命中）')
for (const key of ['headroom 等插件因兼容性被删', 'memory-vault 与本插件的分工', 'pre-step 是必然被调用的钩子']) {
  const fact = FACTS.find((f) => f.key === key)
  console.log('')
  console.log(`■ ${key}`)
  console.log(`  查询：${fact.query}`)
  console.log(`  正确答案（正文含 "${fact.probe}"）：${truthOf.get(key).length} 条`
    + truthOf.get(key).map((r) => ` ${r.id}(${r.kind} turn${r.turnFrom}-${r.turnTo})`).join(''))
  for (const config of [configs[0], configs[4]]) {
    const hits = searchRecords(records, fact.query, 5, config.tuning)
    console.log(`  ${config.label}：`)
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i]
      const relevant = truthOf.get(key).some((t) => t.id === hit.id)
      const snippet = hit.text.replace(/\s+/g, ' ').slice(0, 90)
      console.log(`    #${i + 1}${relevant ? ' ✓' : '  '} [${hit.kind} turn${hit.turnFrom}-${hit.turnTo}] ${snippet}`)
    }
  }
}
