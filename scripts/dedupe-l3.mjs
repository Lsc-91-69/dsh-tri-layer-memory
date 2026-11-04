#!/usr/bin/env node
/**
 * dedupe-l3.mjs — 显式清理 L3 里的**同范围重复记录**（默认 dry-run，什么都不改）。
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 先别用这个脚本。优先用插件自己的工具 `memory_dedupe`（默认 dry-run，       │
 * │ 真删前自动备份，并且走 store 自己的写盘路径）。                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ── 为什么推荐插件工具：双 owner 事故（真实发生过）──────────────────────
 *
 * 本脚本直接打开 `deep-memory.sqlite` 删行。但**插件在内存里持有一整份记录快照**，
 * 它的持久化入口是 `backend.replace(this.records)`（整表 DELETE + INSERT）。
 * 于是在宿主**运行时**跑本脚本的结果是：
 *   1. 脚本删掉副本 → 磁盘干净；
 *   2. 插件内存里仍是旧的 1491 条（含重复）；
 *   3. 插件下一次写盘（剪枝 / 里程碑 cause 回填 / 工具池滚动）把整份旧快照写回；
 *   4. 去重结果被**静默覆盖**；更糟的是中途还丢过 digest（18→0）和第三个会话的记录。
 *
 * 根因不是"脚本写错了"，而是**同一份数据有两个 owner**。所以：
 * - 宿主运行时请用工具 `memory_dedupe`（它改的就是插件那一份内存快照，再由同一个
 *   后端落盘，永远只有一个写入者）；
 * - 本脚本只作**离线兜底**：用户真的关掉了应用、没有任何宿主进程时，才用它。
 *
 * ── 本脚本的自我保护 ────────────────────────────────────────────────────
 *
 * `--apply` 之前会检查"宿主可能正在运行"的信号（profile 锁 + sqlite 日志文件 +
 * 最近的诊断文件时间戳）。命中任一信号就**拒绝执行**，除非显式加 `--force`。
 * 注意这是**启发式**：profile 锁只在宿主执行 profile 写操作时存在，所以"没检测到"
 * 不等于"宿主没在跑"。真正可靠的判据只有一个——**关掉应用再跑**。
 *
 * ── 为什么要有这个命令，而且为什么它不该自动跑 ──────────────────────────
 *
 * v0.1.22 及更早版本里，L3 蒸馏水位 `l3HighWaterTurn` 只活在内存（`SessionState`），
 * 进程一重启就归零，于是同一个轮次被重新蒸馏一遍；记录 id 由 `createdAt + seq`
 * 生成，所以每重启一次就多一条副本。实测某会话 1188 条记录里 1044 条是同
 * `(sessionId, kind, turnFrom, turnTo)` 的副本（turn 1–12 各 32 份）。
 *
 * 这些副本有两个害处：
 * 1. **挤占检索的 top-N**：同一轮出现 5 次，别的事实就进不来（实测某次查询的前 3
 *    名全是同一轮的三个副本，且不含查询词里的那个事实）；
 * 2. 白占存储与统计口径（"已持久化 1480 条"里有 1044 条是垃圾）。
 *
 * 但它**不能自动清**：L3 是用户数据，删记录是不可逆动作。水位修复（从库推最大轮号）
 * 只保证"以后不再长新的"，存量怎么办必须由人显式决定。所以：
 * - 默认 dry-run，只打印将要删什么；
 * - 要真删得加 `--apply`；
 * - `--apply` 之前默认先写一份 `.bak` 备份（`--no-backup` 可关）。
 *
 * ── 保留哪一条 ────────────────────────────────────────────────────────
 *
 * 每个组保留**最新**的那条（`createdAt` 最大）。理由是检索的平局排序就是
 * `createdAt` 降序（见 l3-deep.ts 的 searchRecords）：保留最新的那条，等于让去重
 * 前后**那一组在排序里的名次完全不变**，不会因为清理而改变已有检索结果。
 * 若组内正文不一致（说明不是同一次蒸馏的产物），则改留最长的那条并报告——
 * 长度相同但内容不同时没有"更长"可留，按 createdAt 保留最新的，同样在报告里点名。
 * 宁可多留信息，也不为了排序稳定丢掉内容。
 *
 * ── 引用不悬空 ────────────────────────────────────────────────────────
 *
 * 里程碑记录的 `refs` 指向具体的 turn/digest 记录 id。删副本会让这些引用悬空
 * （指向不存在的 id），进而影响剪枝时的"根节点保护"。所以脚本会把**所有**记录里
 * 指向被删 id 的引用改写成指向同组保留的那条，并报告改写了多少处。
 *
 * 幂等：第二次跑会报告"没有可删的组"，退出码仍是 0。
 *
 * 用法：
 *   node scripts/dedupe-l3.mjs                      # dry-run 默认库
 *   node scripts/dedupe-l3.mjs --db <path> --all    # 指定库/文件，列全部重复组
 *   node scripts/dedupe-l3.mjs --session <id>       # 只处理一个会话
 *   node scripts/dedupe-l3.mjs --apply              # 真删（先写 .bak；宿主在跑会拒绝）
 *   node scripts/dedupe-l3.mjs --apply --force      # 明知宿主在跑也要删（后果自负）
 *   node scripts/dedupe-l3.mjs --json               # 机器可读输出
 *
 * 退出码：0 = 正常；1 = 运行错误；2 = 库不存在/参数问题；3 = 检测到宿主可能在运行、拒绝写盘。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const DEFAULT_DB = join(HOME, 'tri-layer-memory', 'deep-memory.sqlite')

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at < 0 ? undefined : argv[at + 1]
}

const apply = has('apply')
const force = has('force')
const asJson = has('json')
const listAll = has('all')
const noBackup = has('no-backup')
const onlySession = value('session')
const dbPath = value('db') ?? DEFAULT_DB
const verbose = has('verbose')

/**
 * 检测"宿主可能正在运行"的三类信号。
 *
 * 判据来源：`scripts/profile-guard.mjs` 的 profile 锁检查（宿主
 * `DesktopProjectManager.withLock` 用 `openSync(lock,'wx')` 独占创建
 * `<profile>/lock` 并写入自己的 pid，操作完 unlink）。
 *
 * **诚实说明**：这是一组**启发式**，不是"宿主在运行"的证明。profile 锁只在宿主
 * 执行 profile 写操作的那一小段时间存在；一个正在对话的宿主持有 sqlite 连接但
 * 通常没有锁、也没有 journal 文件。因此"没有信号"不能当作安全依据——最可靠的做法
 * 仍然是关掉应用再跑。
 *
 * @returns {{ running: boolean, signals: Array<{ kind: string, detail: string }>, checkedProfiles: number }}
 */
function detectHostActivity() {
  const signals = []
  const profilesDir = join(HOME, 'profiles')
  let checkedProfiles = 0
  if (existsSync(profilesDir)) {
    for (const name of readdirSync(profilesDir)) {
      const lockPath = join(profilesDir, name, 'lock')
      if (!existsSync(lockPath)) continue
      checkedProfiles += 1
      let pidText = ''
      try { pidText = readFileSync(lockPath, 'utf8').trim() } catch { pidText = '' }
      const pid = Number.parseInt(pidText, 10)
      let alive = false
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch (error) {
          // EPERM = 进程存在但没权限发信号（同为"活着"）；ESRCH = 进程不在。
          alive = error.code !== 'ESRCH'
        }
      }
      if (alive) {
        signals.push({ kind: 'profile-lock', detail: `${lockPath}（pid ${pid} 仍活着）` })
      }
    }
  }

  // sqlite 的日志文件只在写事务进行时存在（默认 rollback journal 模式）。
  for (const suffix of ['-journal', '-wal']) {
    const logPath = `${dbPath}${suffix}`
    if (existsSync(logPath)) signals.push({ kind: 'sqlite-log', detail: logPath })
  }

  // 宿主每轮投影都会写 <session>.diagnostics.json；10 分钟内写过 = 最近很可能在跑。
  //
  // 只认**看起来像真实会话 id** 的文件名（`session-<uuid>.diagnostics.json` 或
  // `<uuid>.diagnostics.json`）：本仓库的测试套件会用默认 l3Dir 跑 apply()，把
  // `s-1` / `s-fresh` / `s-l2-seam` 这类测试会话的诊断文件写进同一个目录。把测试
  // 噪声当成"宿主在运行"会让用户每次跑完测试后都被无故拒绝——那也是一种"看起来
  // 在工作"的守卫，比没有守卫更糟。
  const storageDir = join(HOME, 'tri-layer-memory')
  const recentMs = 10 * 60 * 1000
  const looksLikeHostSession = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i
  try {
    if (existsSync(storageDir)) {
      const now = Date.now()
      for (const name of readdirSync(storageDir)) {
        if (!name.endsWith('.diagnostics.json')) continue
        if (!looksLikeHostSession.test(name)) continue
        const mtime = statSync(join(storageDir, name)).mtimeMs
        if (now - mtime <= recentMs) {
          signals.push({
            kind: 'recent-diagnostics',
            detail: `${name}（${Math.round((now - mtime) / 1000)} 秒前写过）`,
          })
          break
        }
      }
    }
  } catch {
    // 读目录失败不影响主流程：它只是启发式信号之一。
  }

  return { running: signals.length > 0, signals, checkedProfiles }
}


/** 分组键：同一会话 + 同一类别 + 同一轮范围 = 同一次蒸馏的产物。 */
function groupKey(record) {
  return `${record.sessionId}\u0000${record.kind}\u0000${record.turnFrom}\u0000${record.turnTo}`
}

/**
 * 在一组同范围记录里挑出要保留的那条。
 *
 * @param group - 同组记录（任意顺序）。
 * @returns 保留的记录。
 */
function pickKeeper(group) {
  const longest = Math.max(...group.map((record) => record.text.length))
  const richer = group.filter((record) => record.text.length === longest)
  // 正文长度一致（正常情况）时留最新的：与检索的平局排序一致，名次不变。
  return richer.reduce((best, record) => (record.createdAt > best.createdAt ? record : best), richer[0])
}

/**
 * 规划删除：返回要删的 id、保留映射，以及按组的明细。
 *
 * @param records - 记录全集。
 * @returns 计划。
 */
function plan(records) {
  const groups = new Map()
  for (const record of records) {
    if (onlySession !== undefined && record.sessionId !== onlySession) continue
    const key = groupKey(record)
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [record])
    else list.push(record)
  }
  const removeTo = new Map() // 被删 id → 保留 id
  const details = []
  let differingGroups = 0
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    const keeper = pickKeeper(group)
    // 比**正文内容**而不是长度：同长度不同内容的两份，删一份同样会丢信息，
    // 必须点名（此时没有"更长的那条"，按 createdAt 保留最新的）。
    const identicalText = group.every((record) => record.text === keeper.text)
    if (!identicalText) differingGroups += 1
    const removed = group.filter((record) => record.id !== keeper.id)
    for (const record of removed) removeTo.set(record.id, keeper.id)
    details.push({
      key,
      kind: group[0].kind,
      sessionId: group[0].sessionId,
      turnFrom: group[0].turnFrom,
      turnTo: group[0].turnTo,
      copies: group.length,
      keepId: keeper.id,
      keepChars: keeper.text.length,
      removedIds: removed.map((record) => record.id),
      identicalText,
    })
  }
  return { groups, removeTo, details, differingGroups }
}

/**
 * 计算引用改写：返回 id → 新 refs（只含真的变了的）。
 *
 * @param records - 记录全集。
 * @param removeTo - 被删 id → 保留 id。
 * @returns 需要写回的记录与改写计数。
 */
function planRefs(records, removeTo) {
  const updates = []
  let rewritten = 0
  for (const record of records) {
    if (record.refs.length === 0) continue
    let changed = false
    const next = record.refs.map((ref) => {
      const mapped = removeTo.get(ref)
      if (mapped === undefined) return ref
      changed = true
      rewritten += 1
      return mapped
    })
    if (changed) updates.push({ id: record.id, refs: [...new Set(next)] })
  }
  return { updates, rewritten }
}

// ───────────────────────── sqlite / jsonl ─────────────────────────

function readSqlite(path) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path)
  const rows = db.prepare('SELECT * FROM records ORDER BY createdAt ASC').all()
  const records = rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    sessionId: String(row.sessionId),
    turnFrom: Number(row.turnFrom),
    turnTo: Number(row.turnTo),
    createdAt: Number(row.createdAt),
    text: String(row.text),
    tokens: Number(row.tokens),
    keywords: JSON.parse(String(row.keywords)),
    refs: JSON.parse(String(row.refs)),
  }))
  return { db, records }
}

function applySqlite(db, records, planned) {
  const drop = [...planned.removeTo.keys()]
  db.exec('BEGIN IMMEDIATE')
  try {
    const del = db.prepare('DELETE FROM records WHERE id = ?')
    for (const id of drop) del.run(id)
    const upd = db.prepare('UPDATE records SET refs = ? WHERE id = ?')
    for (const update of planned.refs.updates) upd.run(JSON.stringify(update.refs), update.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function readJsonl(path) {
  const records = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  return { records }
}

function applyJsonl(path, records, planned) {
  const drop = planned.removeTo
  const kept = records
    .filter((record) => !drop.has(record.id))
    .map((record) => {
      const update = planned.refs.updates.find((entry) => entry.id === record.id)
      return update === undefined ? record : { ...record, refs: update.refs }
    })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, kept.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8')
  renameSync(tmp, path)
  return kept.length
}

// ───────────────────────── 主流程 ─────────────────────────

function main() {
  if (!existsSync(dbPath)) {
    console.error(`找不到 L3 库：${dbPath}\n（用 --db <path> 指定，或检查 $DSH_HOME）`)
    process.exit(2)
  }
  const host = detectHostActivity()
  // 写盘前先过双 owner 这一关：宿主运行时直连 sqlite 删除，等于给插件内存里的
  // 旧快照一次"整表盖回去"的机会。dry-run 只读，不拦；--apply 必须 --force。
  if (apply && host.running && !force) {
    if (asJson) {
      console.log(JSON.stringify({ refused: true, reason: 'host-may-be-running', db: dbPath, host }, null, 2))
    } else {
      console.error('拒绝执行 --apply：检测到宿主可能在运行。')
      for (const signal of host.signals) console.error(`  · ${signal.kind}: ${signal.detail}`)
      console.error('')
      console.error('原因：插件在内存里持有一整份 L3 记录快照，它的持久化是整表重写。')
      console.error('      宿主运行时直连 sqlite 删行，去重结果会被插件下一次写盘静默覆盖回去；')
      console.error('      2026-10 的事故里还因此丢过 digest 和第三个会话的记录。')
      console.error('')
      console.error('正确做法（按优先级）：')
      console.error('  1) 用插件工具 memory_dedupe —— 默认 dry-run，确认后传 dryRun:false；')
      console.error('     它改的是插件自己那份内存快照，永远只有一个写入者。')
      console.error('  2) 真要用离线脚本：先关掉应用，再跑本命令。')
      console.error('  3) 明知宿主在跑仍要执行：加 --force（后果自负，脚本不再保护你）。')
    }
    process.exit(3)
  }
  if (!apply && host.running) {
    console.error('提示：检测到宿主可能在运行（' + host.signals.map((s) => s.kind).join('、') + '）。')
    console.error('      dry-run 只读，可以继续；但 --apply 会被拒绝——宿主运行时请改用 memory_dedupe。')
  }

  const isJsonl = dbPath.toLowerCase().endsWith('.jsonl')
  const opened = isJsonl ? readJsonl(dbPath) : readSqlite(dbPath)
  const { records } = opened
  const planned = plan(records)
  planned.refs = planRefs(records, planned.removeTo)
  const dropCount = planned.removeTo.size
  const afterCount = records.length - dropCount

  // 按会话汇总
  const bySession = new Map()
  for (const detail of planned.details) {
    const slot = bySession.get(detail.sessionId) ?? { removed: 0, groups: 0 }
    slot.removed += detail.removedIds.length
    slot.groups += 1
    bySession.set(detail.sessionId, slot)
  }

  const output = {
    db: dbPath,
    backend: isJsonl ? 'jsonl' : 'sqlite',
    applied: apply,
    host,
    before: records.length,
    after: afterCount,
    removed: dropCount,
    duplicateGroups: planned.details.length,
    differingGroups: planned.differingGroups,
    refsRewritten: planned.refs.rewritten,
    recordsWithRefUpdates: planned.refs.updates.length,
    sessions: [...bySession.entries()]
      .map(([sid, slot]) => ({ sessionId: sid, removed: slot.removed, duplicateGroups: slot.groups }))
      .sort((a, b) => b.removed - a.removed),
    groups: planned.details
      .sort((a, b) => (b.copies - a.copies) || (a.turnFrom - b.turnFrom))
      .map((detail) => ({
        kind: detail.kind,
        sessionId: detail.sessionId,
        turn: detail.turnFrom === detail.turnTo ? `turn ${detail.turnFrom}` : `turn ${detail.turnFrom}–${detail.turnTo}`,
        copies: detail.copies,
        keepId: detail.keepId,
        identicalText: detail.identicalText,
        removedIds: detail.removedIds,
      })),
  }

  if (apply && dropCount > 0) {
    if (!host.running) {
      // 启发式给不出"安全"结论：没信号 ≠ 宿主没在跑（例如 0.1.7 不写诊断、profile
      // 锁也不常驻）。这里把话说死，避免读者把"未检测到"当成"已验证安全"。
      console.error('注意：未检测到宿主在运行的信号（profile 锁 / sqlite 日志 / 最近诊断）——')
      console.error('      但这只是启发式，**不能证明**宿主没在跑。宿主运行时请改用插件工具 memory_dedupe。')
    }
    output.backup = null
    if (!noBackup && !isJsonl) {
      const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(dbPath, backup)
      output.backup = backup
    }
    if (isJsonl) applyJsonl(dbPath, records, planned)
    else applySqlite(opened.db, records, planned)
  }

  if (asJson) {
    if (!isJsonl) opened.db.close()
    console.log(JSON.stringify(output, null, 2))
    return
  }

  const num = (n) => n.toLocaleString()
  console.log(`L3 去重${apply ? '' : '（dry-run，未改动任何文件）'} — ${dbPath}（后端 ${output.backend}）`)
  console.log(`  记录      ${num(output.before)} → ${num(output.after)}（${apply ? '已删除' : '将删除'} ${num(dropCount)} 条）`)
  console.log(`  重复组    ${num(planned.details.length)} 组`
    + (planned.differingGroups > 0 ? `，其中 ${planned.differingGroups} 组内正文不一致（已改留最长的那条）` : '，组内正文完全一致'))
  if (planned.refs.rewritten > 0) {
    console.log(`  引用改写  ${num(planned.refs.rewritten)} 处（${num(planned.refs.updates.length)} 条记录）`
      + '：指向被删副本的 refs 已改指同组保留的那条，避免悬空')
  }
  if (dropCount === 0) {
    console.log('  没有可删的重复组——库已经是去重状态（幂等）。')
  } else {
    console.log('')
    console.log('  按会话：')
    for (const session of output.sessions) {
      console.log(`    ${session.sessionId}  -${num(session.removed)} 条（${session.duplicateGroups} 组）`)
    }
    const shown = listAll ? output.groups : output.groups.slice(0, 40)
    console.log('')
    console.log(`  按 (kind, 轮) 的重复份数${listAll ? '' : '（前 40 组，--all 看全部）'}：`)
    for (const group of shown) {
      console.log(`    ${group.kind.padEnd(10)} ${group.turn.padEnd(14)} ×${group.copies}`
        + (group.identicalText ? '' : '（正文不同）'))
    }
    if (shown.length < output.groups.length) console.log(`    …另有 ${output.groups.length - shown.length} 组`)
    if (verbose) {
      console.log('')
      console.log('  保留的记录 id：')
      for (const group of shown) console.log(`    ${group.keepId}  ← ${group.turn} ×${group.copies}`)
    }
  }
  console.log('')
  if (apply) {
    console.log(output.backup === null
      ? '已按上述计划删除（未留备份：--no-backup）。'
      : `已按上述计划删除；删除前备份到 ${output.backup}`)
    console.log('提醒：本脚本是**离线兜底**。只要宿主还在运行，它内存里那份旧快照就可能在下一次')
    console.log('      写盘（剪枝 / 里程碑 cause 回填 / 工具池滚动）时把刚删掉的副本写回来。')
    console.log('      下次直接用插件工具 memory_dedupe，别再用这个脚本——它才是唯一的写入者。')
  } else {
    console.log('未改动任何文件。确认无误后加 --apply 真正删除（会先写一份 .bak 备份）。')
    console.log('如果宿主正在运行，请改用插件工具 memory_dedupe（--apply 会因双 owner 风险被拒绝）。')
  }
  if (!isJsonl) opened.db.close()
}

main()
