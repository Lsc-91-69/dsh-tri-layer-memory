/**
 * test/dedupe.test.mjs — L3 去重（memory_dedupe）的行为测试。
 *
 * 背景是**真实事故**，不是假想：
 * 插件在内存里持有整份 L3 记录快照，持久化入口是 `backend.replace()`（整表重写）。
 * 外部脚本直接改 sqlite 后，插件下一次写盘把旧快照盖回去——去重结果被静默覆盖，
 * 中途还丢过 digest 和第三个会话的记录。根因是同一份数据有两个 owner。
 *
 * 所以这些用例盯的不是"函数返回了什么"，而是三条不能破的性质：
 * 1. dry-run 一个字节都不许改（用文件 size + sha256 证明）；
 * 2. 真删必须走 store 自己的内存快照 + 后端 replace（失败能整份回滚）；
 * 3. 重复是幂等的，且删完的 refs 不指向不存在的 id。
 *
 * 直接 import `src/host/*.ts`（Node 原生类型剥离），无需构建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeepMemoryStore } from '../src/host/l3-deep.ts'
import { buildDedupeTool } from '../src/host/recall.ts'

/** 库文件的字节数与 sha256：dry-run 必须两者都不变。 */
function fingerprint(path) {
  const bytes = readFileSync(path)
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** 造一条指定正文长度的记录（长度用于验证"保留最长"）。 */
function seed(store, input) {
  return store.put({
    kind: input.kind ?? 'turn',
    sessionId: input.sessionId ?? 's-1',
    turnFrom: input.turnFrom,
    turnTo: input.turnTo,
    text: input.text,
    refs: input.refs,
    createdAt: input.createdAt,
  })
}

test('dry-run 是默认值：报告计划删除，库文件 size 与 sha256 一个字节都不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-dry-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    seed(store, { turnFrom: 1, turnTo: 1, createdAt: 1000, text: '同一轮的同一次蒸馏产物' })
    seed(store, { turnFrom: 1, turnTo: 1, createdAt: 2000, text: '同一轮的同一次蒸馏产物' })
    seed(store, { turnFrom: 2, turnTo: 2, createdAt: 3000, text: '另一轮，只有一条' })
    const file = join(dir, 'deep-memory.jsonl')
    const before = fingerprint(file)

    // 不传 dryRun = dry-run。这是"参数默认安全"的回归断言。
    const outcome = store.dedupe()
    assert.equal(outcome.dryRun, true)
    assert.equal(outcome.applied, false)
    assert.equal(outcome.removed, 1)
    assert.equal(outcome.groups, 1)
    assert.equal(outcome.before, 3)
    assert.equal(outcome.after, 2)
    assert.equal(outcome.backupPath, null, 'dry-run 不建备份')
    assert.equal(outcome.groupDetails[0].copies, 2)
    // 组内正文一致 → 保留 createdAt 最新的那条（去重后检索名次不变）。
    assert.equal(outcome.groupDetails[0].keepId, store.all().find((r) => r.createdAt === 2000)?.id)

    const after = fingerprint(file)
    assert.deepEqual(after, before, 'dry-run 绝不能改动库文件（size 与 sha256 都必须一致）')
    assert.equal(existsSync(`${file}.bak-`), false)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply：保留最新、组内正文不一致时保留最长，并报告这些组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-apply-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    // 组 A：三份正文一致，时间戳 1s / 3s / 2s → 必须留 3s 那条。
    const a1 = seed(store, { turnFrom: 1, turnTo: 1, createdAt: 1000, text: '一轮：正文完全相同的副本' })
    seed(store, { turnFrom: 1, turnTo: 1, createdAt: 3000, text: '一轮：正文完全相同的副本' })
    const a3 = seed(store, { turnFrom: 1, turnTo: 1, createdAt: 2000, text: '一轮：正文完全相同的副本' })
    // 组 B：正文长度 4 / 24 / 12 → 必须留最长的 24（宁可多留信息，不为排序稳定丢内容）。
    seed(store, { turnFrom: 2, turnTo: 2, createdAt: 4000, text: '短句' })
    const bLong = seed(store, { turnFrom: 2, turnTo: 2, createdAt: 4100, text: '这一份是同一轮里最长的那条正文：保留了它就不丢信息。' })
    seed(store, { turnFrom: 2, turnTo: 2, createdAt: 4200, text: '中等长度的正文副本' })
    // 里程碑：引用组 B 的一张副本 → 必须被改指保留的那条，不能悬空。
    const milestone = seed(store, {
      kind: 'milestone',
      turnFrom: 2,
      turnTo: 2,
      createdAt: 5000,
      text: '里程碑：第二轮发生了什么',
      refs: [bLong.id, a1.id, 'l3-does-not-exist'],
    })

    const sizeBeforeApply = statSync(join(dir, 'deep-memory.jsonl')).size
    const outcome = store.dedupe({ dryRun: false })
    assert.equal(outcome.applied, true)
    assert.equal(outcome.dryRun, false)
    assert.equal(outcome.removed, 4, 'A 组删 2 条 + B 组删 2 条')
    assert.equal(outcome.groups, 2)
    assert.equal(outcome.after, 3)
    assert.equal(store.size, 3, '内存快照也必须同步（同一个 owner）')
    // A 组保留 3s，B 组保留最长。
    assert.ok(store.get(a3.id) === undefined, 'A 组旧的副本应被删')
    assert.ok(store.get(a1.id) === undefined, 'A 组 1s 的副本应被删')
    assert.ok(store.get(bLong.id) !== undefined, 'B 组应保留最长的那条')
    assert.equal(outcome.differingGroups, 1, '组 B 正文长度不一致，必须被点名')
    assert.equal(outcome.differingGroupDetails.length, 1)
    assert.equal(outcome.differingGroupDetails[0].turnFrom, 2)
    assert.equal(outcome.differingGroupDetails[0].keepId, bLong.id)

    // refs 不悬空：指向被删副本的边改指保留者；本来就不存在的 id 原样保留（不伪造）。
    const keeper = store.get(milestone.id)
    assert.deepEqual(keeper.refs, [bLong.id, outcome.groupDetails.find((g) => g.turnFrom === 1).keepId, 'l3-does-not-exist'])
    assert.equal(outcome.refsRewritten, 1, '只有指向被删副本（组 A 的 a1）的那条 refs 被改写；指向保留者的不动')

    // 备份：本次必须有一份 .bak，且大小与库文件一致。
    const backups = readdirSync(dir).filter((name) => name.includes('.bak-'))
    assert.equal(backups.length, 1, '真删前必须留下一份备份')
    assert.equal(outcome.backupPath, join(dir, backups[0]))
    // 备份必须是**删除前**的库：大小等于 apply 之前的文件大小，不是删除后的。
    assert.equal(statSync(outcome.backupPath).size, sizeBeforeApply)

    // 幂等：再跑一次什么都不删，也不再产生新备份。
    const again = store.dedupe({ dryRun: false })
    assert.equal(again.removed, 0)
    assert.equal(again.applied, false)
    assert.equal(again.backupPath, null)
    assert.equal(readdirSync(dir).filter((name) => name.includes('.bak-')).length, 1, '第二次不应产生新备份')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply 落盘失败时整份内存快照回滚：不留"内存删了、磁盘没删"的分叉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-rollback-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    seed(store, { turnFrom: 1, turnTo: 1, createdAt: 1000, text: '副本一' })
    seed(store, { turnFrom: 1, turnTo: 1, createdAt: 2000, text: '副本一' })
    const before = store.all().map((record) => record.id)
    // 模拟后端写盘失败（磁盘满、被锁）。这一步必须是"整份回滚"而不是部分生效。
    const backend = store.backend
    backend.replace = () => { throw new Error('disk full (simulated)') }
    assert.throws(() => store.dedupe({ dryRun: false }), /disk full/)
    assert.deepEqual(store.all().map((record) => record.id), before, '写盘失败后内存快照必须原样恢复')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite 后端：真删后独立连接读回的条数与 store 一致（replace 走事务）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-sqlite-'))
  try {
    const store = new DeepMemoryStore(dir, 'sqlite')
    const kind = await store.open()
    if (kind !== 'sqlite') {
      t.skip('本机 node:sqlite 不可用，跳过 sqlite 后端用例')
      return
    }
    seed(store, { turnFrom: 7, turnTo: 7, createdAt: 1000, text: 'sqlite 重复副本' })
    seed(store, { turnFrom: 7, turnTo: 7, createdAt: 2000, text: 'sqlite 重复副本' })
    seed(store, { turnFrom: 8, turnTo: 8, createdAt: 3000, text: '另一轮' })

    const outcome = store.dedupe({ dryRun: false })
    assert.equal(outcome.removed, 1)
    assert.ok(outcome.backupPath !== null && existsSync(outcome.backupPath), 'sqlite 真删前必须备份库文件')

    const { DatabaseSync } = await import('node:sqlite')
    const probe = new DatabaseSync(join(dir, 'deep-memory.sqlite'))
    const rows = probe.prepare('SELECT id FROM records').all()
    probe.close()
    assert.equal(rows.length, 2, '独立连接读回的条数必须与 store 一致')
    assert.equal(store.size, 2)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('memory_dedupe 工具：默认 dryRun，显式 false 才删，参数类型错误会被拦下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-tool-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    seed(store, { turnFrom: 3, turnTo: 3, createdAt: 1000, text: '工具用例副本' })
    seed(store, { turnFrom: 3, turnTo: 3, createdAt: 2000, text: '工具用例副本' })
    const tool = buildDedupeTool({ dedupe: (input) => store.dedupe(input) })

    assert.equal(tool.name, 'memory_dedupe')
    assert.match(tool.description, /默认 dry-run/i, '工具描述必须让模型知道默认不删')
    assert.match(tool.description, /删数据|删除记录/, '工具描述必须让模型知道这是会删数据的操作')

    const planned = await tool.execute({}, { agent: { session: undefined } })
    assert.equal(planned.dryRun, true)
    assert.equal(planned.removed, 1)
    assert.match(planned.summary, /dry-run/)
    assert.equal(store.size, 2, '默认调用不许删')

    const applied = await tool.execute({ dryRun: false }, { agent: { session: undefined } })
    assert.equal(applied.applied, true)
    assert.equal(applied.removed, 1)
    assert.equal(store.size, 1)
    assert.match(applied.summary, /已删除 1 条/)
    assert.ok(applied.backupPath !== null)

    await assert.rejects(() => tool.execute({ dryRun: 'yes' }, {}), /invalid arguments/)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('duplicateSummary：一次扫描给出组数/可删条数/不一致组数，会话过滤生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-summary-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    // 干净库必须报 0（不能把"没有重复"变成 O(n²) 的假阳性）。
    assert.deepEqual(store.duplicateSummary(), { groups: 0, records: 0, differingGroups: 0 })

    seed(store, { sessionId: 's-a', turnFrom: 1, turnTo: 1, createdAt: 1, text: '甲甲' })
    seed(store, { sessionId: 's-a', turnFrom: 1, turnTo: 1, createdAt: 2, text: '甲甲' })
    seed(store, { sessionId: 's-a', turnFrom: 2, turnTo: 2, createdAt: 3, text: '乙' })
    seed(store, { sessionId: 's-a', turnFrom: 2, turnTo: 2, createdAt: 4, text: '乙乙乙' })
    seed(store, { sessionId: 's-b', turnFrom: 1, turnTo: 1, createdAt: 5, text: '丙丙' })
    seed(store, { sessionId: 's-b', turnFrom: 1, turnTo: 1, createdAt: 6, text: '丙丙' })
    seed(store, { sessionId: 's-b', turnFrom: 1, turnTo: 1, createdAt: 7, text: '丙丙' })

    assert.deepEqual(store.duplicateSummary(), { groups: 3, records: 1 + 1 + 2, differingGroups: 1 })
    assert.deepEqual(store.duplicateSummary('s-b'), { groups: 1, records: 2, differingGroups: 0 })
    assert.deepEqual(store.duplicateSummary('s-a'), { groups: 2, records: 2, differingGroups: 1 })
    assert.deepEqual(store.duplicateSummary('nobody'), { groups: 0, records: 0, differingGroups: 0 })
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionId 限定：before/after 只数该会话，其它会话一条不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-session-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    for (let i = 0; i < 3; i += 1) seed(store, { sessionId: 's-a', turnFrom: 1, turnTo: 1, createdAt: 1000 + i, text: '会话 A 的副本' })
    for (let i = 0; i < 2; i += 1) seed(store, { sessionId: 's-b', turnFrom: 1, turnTo: 1, createdAt: 2000 + i, text: '会话 B 的副本' })

    const outcome = store.dedupe({ dryRun: false, sessionId: 's-a' })
    assert.equal(outcome.before, 3, 'before 必须是该会话的条数，不是整库 5')
    assert.equal(outcome.after, 1)
    assert.equal(outcome.removed, 2)
    assert.equal(outcome.groups, 1)
    assert.equal(store.size, 3, 's-a 剩 1 条 + s-b 2 条（不被动）')
    assert.equal(store.all().filter((record) => record.sessionId === 's-b').length, 2)

    // 再对整库跑一次：这次才处理 s-b，且 before/after 是整库口径。
    const rest = store.dedupe({ dryRun: false })
    assert.equal(rest.before, 3)
    assert.equal(rest.removed, 1)
    assert.equal(store.size, 2)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同长度但正文不同：也必须算"正文不一致"并点名（不能因为长度一样就当成副本）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-dedupe-samelength-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    // 两条长度相同（12 个字符）但内容完全不同：删哪一条都会丢信息。
    seed(store, { turnFrom: 9, turnTo: 9, createdAt: 1000, text: '甲甲甲甲甲甲甲甲甲甲甲甲' })
    seed(store, { turnFrom: 9, turnTo: 9, createdAt: 2000, text: '乙乙乙乙乙乙乙乙乙乙乙乙' })
    const summary = store.duplicateSummary()
    assert.equal(summary.groups, 1)
    assert.equal(summary.differingGroups, 1, '长度相同、内容不同必须算不一致')
    const outcome = store.dedupe({ dryRun: false })
    assert.equal(outcome.differingGroups, 1)
    assert.equal(outcome.groupDetails[0].identicalText, false)
    assert.equal(outcome.groupDetails[0].keepChars, 12)
    // 没有更长的那条可留 → 按 createdAt 保留最新的（2000 那条）。
    assert.equal(store.all()[0].text, '乙乙乙乙乙乙乙乙乙乙乙乙')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
