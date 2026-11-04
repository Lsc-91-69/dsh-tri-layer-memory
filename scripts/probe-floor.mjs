#!/usr/bin/env node
/**
 * probe-floor.mjs — 用 19 条探针估算"信息下界"（只读）。
 *
 * 问题：要能答对 `scripts/probes.mjs` 的 19 条事实，**最少**需要多少 token 留在
 * 可检索范围里？
 *
 * 方法（不拍脑袋）：
 * 1. 直接打开生产 L3 库（只读），按 `probe` 子串匹配记录——这就是 recall 会走的口径。
 * 2. 命中记录里取**最短的那条**的 `tokens`：那是"只要这一条就能答对"的最小单位。
 * 3. 用**贪心最小覆盖**（set cover）在命中的记录里选一组，覆盖尽可能多的 probe，
 *    求这一组的 tokens 之和——比逐条相加更接近真实下界（一条记录常覆盖多个事实）。
 * 4. 没命中的 probe 单独列出：那些事实在 L3 里根本不存在，任何 token 预算都答不对。
 *
 * 注意：这是**参考下界**，不是硬下界——它假设"一条记录 = 一个可直接引用的答案"，
 * 而真实回答可能需要跨记录的推理。
 *
 * 用法：
 *   node scripts/probe-floor.mjs [--db C:/Users/.../deep-memory.sqlite]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FACTS } from './probes.mjs'

const DEFAULT_DB = join(process.env.USERPROFILE ?? '', '.dsh', 'tri-layer-memory', 'deep-memory.sqlite')

function main() {
  const argv = process.argv.slice(2)
  let dbPath = DEFAULT_DB
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--db') dbPath = argv[i + 1]
  if (!existsSync(dbPath)) { console.error(`找不到库：${dbPath}`); process.exit(2) }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT id, kind, text, tokens, sessionId FROM records').all()
  db.close()

  console.log(`# 库：${dbPath}`)
  console.log(`# 记录 ${rows.length} 条`)
  console.log('')
  console.log('## 库构成')
  console.log('')
  console.log('| kind | 条数 | 总 tokens | 平均 tokens |')
  console.log('| --- | ---: | ---: | ---: |')
  const byKind = new Map()
  for (const r of rows) {
    const cur = byKind.get(r.kind) ?? { n: 0, t: 0 }
    cur.n += 1; cur.t += Number(r.tokens) || 0
    byKind.set(r.kind, cur)
  }
  for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1].t - a[1].t)) {
    console.log(`| ${k} | ${v.n} | ${v.t} | ${Math.round(v.t / v.n)} |`)
  }

  // 每条 probe 命中的记录（子串口径，与 recall 的匹配一致）。
  const matches = new Map()
  const misses = []
  for (const fact of FACTS) {
    const hit = rows.filter((r) => String(r.text).includes(fact.probe))
    if (hit.length === 0) misses.push(fact)
    else matches.set(fact, hit)
  }

  console.log('')
  console.log('## 19 条探针的命中与最小记录')
  console.log('')
  console.log('| # | 事实 | 命中条数 | 最短命中 tokens |')
  console.log('| ---: | --- | ---: | ---: |')
  let idx = 0
  for (const fact of FACTS) {
    idx += 1
    const hit = matches.get(fact)
    if (hit === undefined) { console.log(`| ${idx} | ${fact.key} | 0 | - |`); continue }
    const min = Math.min(...hit.map((r) => Number(r.tokens) || 0))
    console.log(`| ${idx} | ${fact.key} | ${hit.length} | ${min} |`)
  }

  // 贪心最小覆盖：每次选"覆盖未覆盖 probe 最多、且总 token 最小"的记录。
  const uncovered = new Set(FACTS.filter((f) => matches.has(f)))
  const chosen = []
  let guard = 0
  while (uncovered.size > 0 && guard < 100) {
    guard += 1
    let best = null
    let bestCover = 0
    let bestTokens = Infinity
    for (const r of rows) {
      const covered = [...uncovered].filter((f) => String(r.text).includes(f.probe))
      if (covered.length === 0) continue
      const t = Number(r.tokens) || 0
      if (covered.length > bestCover || (covered.length === bestCover && t < bestTokens)) {
        best = { r, covered }
        bestCover = covered.length
        bestTokens = t
      }
    }
    if (best === null) break
    chosen.push(best)
    for (const f of best.covered) uncovered.delete(f)
  }

  const greedyTokens = chosen.reduce((s, c) => s + (Number(c.r.tokens) || 0), 0)
  const singleBest = FACTS
    .filter((f) => matches.has(f))
    .reduce((s, f) => s + Math.min(...matches.get(f).map((r) => Number(r.tokens) || 0)), 0)

  console.log('')
  console.log('## 信息下界估算')
  console.log('')
  console.log(`- 19 条里 L3 能命中的：${FACTS.length - misses.length} 条；0 命中的：${misses.length} 条`)
  console.log(`- 逐条取最短命中再相加（上界式下界）：${singleBest} tokens`)
  console.log(`- 贪心最小覆盖（一条记录覆盖多条事实）：${chosen.length} 条记录 / ${greedyTokens} tokens`)
  console.log(`- 平均每条命中记录：${Math.round(rows.reduce((s, r) => s + (Number(r.tokens) || 0), 0) / rows.length)} tokens`)
  console.log('')
  console.log('### 0 命中的事实（L3 里根本没有）')
  for (const f of misses) console.log(`- ${f.key}（probe: ${f.probe}）`)
  console.log('')
  console.log('### 贪心选中的记录')
  for (const c of chosen) console.log(`- [${c.r.kind}] ${Number(c.r.tokens) || 0} tok — ${String(c.r.text).slice(0, 90).replaceAll('\n', ' ')}…`)
}

main()
