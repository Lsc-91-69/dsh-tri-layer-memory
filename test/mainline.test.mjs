/**
 * test/mainline.test.mjs — 主线骨架（里程碑）接线的行为测试。
 *
 * 直接 import `src/host/*.ts`（Node 22.18+/23.6+ 原生类型剥离），因此不需要构建、
 * 不需要装依赖。覆盖的是**接线**，不是提取算法本身（那是 milestones.test.mjs 的事）：
 * 骨架有没有出现在注入里、位置对不对、受不受注入预算影响、什么时候提取、
 * 落进 L3 的记录长什么样、会不会被剪掉。
 *
 * ⚠ fixture 必须用真实事件形状：`user/message` 的正文在 `data.content`，
 * `assistant/message` 与 `tool/result` 的正文在 `data.message.content`。
 * 上一轮就是因为 fixture 用了错形状，让一个"读不到助手/工具正文"的 bug 溜过了 51 个测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/host/index.ts'
import { extractMilestones } from '../src/host/milestones.ts'
import { fitMainline } from '../src/host/budget.ts'
import { estimateTokens } from '../src/host/l1-working.ts'
import { scoreRecords, selectPrunable } from '../src/host/l3-deep.ts'

// ── 夹具 ─────────────────────────────────────────────────────────────────

/**
 * 造一段合成会话：每轮 user + assistant + 一次成功的 pwsh 调用。
 *
 * @param from - 起始轮号。
 * @param to - 结束轮号（含）。
 * @param seqStart - 起始 seq（多次追加时用递增的 seq，保证排序可预期）。
 * @returns 事件数组。
 */
function syntheticEvents(from, to, seqStart = 0) {
  const events = []
  let seq = seqStart
  for (let turn = from; turn <= to; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({
      type: 'user/message',
      seq: seq++,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮：请处理记忆压缩任务，保留关键决策` }] },
    })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮的结论：三层接线已完成。` }] } },
    })
    const callId = `call-${turn}`
    events.push({ type: 'tool/call', seq: seq++, data: { turn, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ description: `第${turn}轮自检` }) } })
    events.push({
      type: 'tool/result',
      seq: seq++,
      data: { turn, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: `第${turn}轮：全部通过` }] } },
    })
    events.push({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/** 造一个最小可用的 Host ctx（只实现 apply() 真正会碰的成员）。 */
function mockContext() {
  const listeners = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    // 真实 cordis 的 effect(fn) 会立即调用 fn，并把返回值当 disposer。
    effect(fn) { fn() },
    // 软等待语义：依赖全在场才调用回调（本测试不提供 settings/systemPrompt）。
    inject(deps, callback) {
      if (!deps.every((d) => ctx[d] !== undefined)) return
      const child = Object.create(ctx)
      for (const d of deps) child[d] = ctx[d]
      callback(child)
    },
    get() { return undefined },
    tools: { register(tool) { tools.push(tool); return () => {} }, schemas() { return [] } },
  }
  return { ctx, listeners, tools }
}

/** 让 apply() 里 fire-and-forget 的 store.open() 跑完。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * 挂载一次插件并返回推进函数。
 *
 * @param config - 组合行配置（覆盖 DEFAULTS）。
 * @returns `step(session)` 推进一轮并返回 decision。
 */
function harness(config) {
  const { ctx, listeners } = mockContext()
  apply(ctx, { l2Mode: 'extractive', selfTestAfterBoot: false, ...config })
  const entry = listeners.get('agent/pre-step')[0]
  assert.ok(entry !== undefined, 'pre-step 监听必须注册（投影不依赖任何宿主服务）')
  const step = (session) => entry.listener(
    { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  return { step }
}

/** 取出 decision 里的投影文本（未注入时为空串）。 */
const textOf = (decision) => decision?.messages?.[0]?.content?.[0]?.text ?? ''

/** 从投影里切出某一块（块之间用空行分隔）。 */
function blockOf(text, marker) {
  return text.split('\n\n').find((part) => part.includes(marker)) ?? ''
}

/** 读回 JSONL 里的全部记录。 */
function readRecords(dir) {
  const file = join(dir, 'deep-memory.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** 在临时目录里跑一段会话，返回该目录与最终投影。 */
async function runSession(config, events, sessionId = 's-mainline') {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-mainline-'))
  const { step } = harness({ l3Dir: dir, l3Store: 'jsonl', ...config })
  await tick()
  const decision = await step({ id: sessionId, events })
  return { dir, text: textOf(decision), decision }
}

// ── 注入：位置与内容 ─────────────────────────────────────────────────────

test('骨架块出现在投影里，位置在 L1 之后、L2 之前', async () => {
  const { dir, text } = await runSession({}, syntheticEvents(1, 10))
  try {
    const atL1 = text.indexOf('## L1 工作记忆')
    const atMainline = text.indexOf('## 里程碑主线骨架')
    const atL2 = text.indexOf('## L2 短期记忆')
    assert.ok(atL1 >= 0, `投影里应有 L1 块：\n${text}`)
    assert.ok(atMainline >= 0, `投影里应有骨架块：\n${text}`)
    assert.ok(atL2 >= 0, `投影里应有 L2 块：\n${text}`)
    assert.ok(atL1 < atMainline && atMainline < atL2,
      `骨架必须落在 L1 与 L2 之间，实际偏移 L1=${atL1} 骨架=${atMainline} L2=${atL2}`)

    // 骨架必须真的有内容，而不是只有一个块头。
    const skeleton = blockOf(text, '## 里程碑主线骨架')
    assert.match(skeleton, /- 任务：/, '块首应点明任务')
    assert.match(skeleton, /第 1 轮:/, '应含逐轮里程碑')
    assert.match(skeleton, /第 10 轮:/, '应覆盖到最新轮')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('骨架不受 injectionBudgetTokens 影响：预算压到下限也逐字不变', async () => {
  const events = syntheticEvents(1, 14)
  const tight = await runSession({ injectionBudgetTokens: 200 }, events)
  const loose = await runSession({ injectionBudgetTokens: 8000 }, events)
  try {
    const tightSkeleton = blockOf(tight.text, '## 里程碑主线骨架')
    const looseSkeleton = blockOf(loose.text, '## 里程碑主线骨架')
    assert.ok(tightSkeleton.length > 0, '预算 200 时骨架仍必须在场')

    // 预算收紧必须真的发生了（否则这条测试什么都没证明）。
    assert.ok(estimateTokens(tight.text) < estimateTokens(loose.text),
      `预算 200 的投影应小于预算 8000 的投影：${estimateTokens(tight.text)} vs ${estimateTokens(loose.text)}`)
    // 预算 200 时 L3 索引**不再整块消失**：完整索引只有约 40–50 tok，通常原样保留；
    // 更紧的预算才降级成一行（见 budget-floor.test.mjs）。
    const tightL3 = blockOf(tight.text, '## L3 深层记忆')
    assert.ok(tightL3.length > 0, '预算 200 时 L3 索引仍必须有一行保底')
    assert.match(tightL3, /memory_recall/, '索引必须让模型知道用哪个工具去查')
    assert.match(tightL3, /\d+ 条/, '索引必须带计数')
    // 预算收紧必须真的可见：要么 L3 是一行形态，要么 L2 被截断。
    assert.ok(!tightL3.includes('已持久化') || tight.text.includes('截断'),
      `预算 200 应触发 L3 降级或 L2 截断，实际 L3：${tightL3}`)

    // 骨架逐字相同，且一条不少——它走的是自己的独立上限。
    assert.equal(tightSkeleton, looseSkeleton, '骨架不应随注入预算变化')
    const numbered = tightSkeleton.split('\n').filter((line) => /^\s*\d+\./.test(line)).length
    assert.equal(numbered, extractMilestones(events).length, '预算再紧也不许裁掉骨架的条目')
  } finally {
    rmSync(tight.dir, { recursive: true, force: true })
    rmSync(loose.dir, { recursive: true, force: true })
  }
})

test('mainlineInject: false 时只提取落库、不注入', async () => {
  const { dir, text } = await runSession({ mainlineInject: false }, syntheticEvents(1, 10))
  try {
    assert.doesNotMatch(text, /里程碑主线骨架/, '关掉注入后骨架不得出现在投影里')
    assert.match(text, /L1 工作记忆/, '其余三层照常投影')
    const milestones = readRecords(dir).filter((r) => r.kind === 'milestone')
    assert.ok(milestones.length > 0, '不注入不等于不提取：骨架仍应落 L3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 独立上限：超限丢最旧的、保留任务标题行 ───────────────────────────────

test('骨架超 mainlineMaxTokens：丢最旧的里程碑，保留任务标题行', () => {
  const milestones = Array.from({ length: 40 }, (_, i) => ({
    turn: i + 1,
    title: `第 ${i + 1} 轮的里程碑标题，写得足够长以便撑爆独立上限`,
    cause: '排查中，无结论',
    detail: '',
    category: '任务',
    tokens: 40,
  }))
  const fit = fitMainline(milestones, '制作三层记忆插件', 300, 60)

  assert.ok(fit.trimmed, '40 条长标题必然超 300 tokens')
  assert.ok(fit.tokens <= 300, `裁剪后不得超上限，实际 ${fit.tokens}`)
  assert.match(fit.text, /- 任务：制作三层记忆插件/, '任务标题行必须保留')
  assert.match(fit.text, /第 40 轮/, '最新的里程碑必须保留')
  assert.doesNotMatch(fit.text, /第 1 轮/, '最旧的里程碑必须被丢掉')
  assert.equal(fit.kept + fit.dropped, 40, '每条里程碑要么保留要么被丢，不许凭空消失')
  const numbered = fit.text.split('\n').filter((line) => /^\s*\d+\./.test(line)).length
  assert.equal(numbered, fit.kept, '块头与标题行不算里程碑条目')

  // 条数上限同向：也是从最旧的开始丢。
  const capped = fitMainline(milestones, '制作三层记忆插件', 20_000, 5)
  assert.equal(capped.kept, 5)
  assert.equal(capped.dropped, 35)
  assert.match(capped.text, /第 40 轮/)
  assert.doesNotMatch(capped.text, /第 35 轮/, '条数上限同样丢最旧的')
  assert.ok(!capped.trimmed || capped.tokens <= 20_000)

  // 没有里程碑时仍返回块头与标题行（调用方不必判空）。
  const empty = fitMainline([], '制作三层记忆插件', 200, 60)
  assert.match(empty.text, /里程碑主线骨架/)
  assert.match(empty.text, /- 任务：制作三层记忆插件/)
  assert.equal(empty.kept, 0)
})

// ── 总开关 ───────────────────────────────────────────────────────────────

test('mainlineEnabled: false 时不提取也不注入（L3 里没有里程碑记录）', async () => {
  const events = syntheticEvents(1, 12)
  const off = await runSession({ mainlineEnabled: false }, events)
  const on = await runSession({}, events)
  try {
    assert.doesNotMatch(off.text, /里程碑主线骨架/, '关掉后不得注入骨架')
    assert.doesNotMatch(off.text, /- 任务：/, '关掉后连标题行都不该有')
    assert.equal(readRecords(off.dir).filter((r) => r.kind === 'milestone').length, 0,
      '关掉后不得提取，自然也不该往 L3 写里程碑')

    // 对照组：同一份会话在开关打开时必须写里程碑（否则上面的断言可能只是"什么都没跑"）。
    assert.ok(readRecords(on.dir).filter((r) => r.kind === 'milestone').length > 0,
      '对照：开关打开时同一份会话必须产出里程碑记录')
    assert.match(on.text, /里程碑主线骨架/)
  } finally {
    rmSync(off.dir, { recursive: true, force: true })
    rmSync(on.dir, { recursive: true, force: true })
  }
})

// ── L3：里程碑是根节点，永不淘汰 ─────────────────────────────────────────

test('kind: milestone 的记录在 selectPrunable 下不被淘汰（低分里程碑也不行）', () => {
  const now = Date.now()
  const old = now - 400 * 24 * 60 * 60 * 1000
  const milestone = {
    id: 'm1', kind: 'milestone', createdAt: old, sessionId: 's', turnFrom: 1, turnTo: 3,
    text: '第 1–3 轮: 做插件 — 未解决', tokens: 30, keywords: ['插件'], refs: ['t1'],
  }
  // t1 被里程碑引用（所以按现有规则它会作为"根"被保护），而里程碑自己**没有入边**。
  const detail = {
    id: 't1', kind: 'turn', createdAt: old, sessionId: 's', turnFrom: 1, turnTo: 1,
    text: '园艺盆栽笔记', tokens: 40, keywords: ['园艺'], refs: [],
  }
  const orphan = {
    id: 't2', kind: 'turn', createdAt: old, sessionId: 's', turnFrom: 9, turnTo: 9,
    text: '无关闲聊', tokens: 40, keywords: ['闲聊'], refs: [],
  }
  const scored = scoreRecords([milestone, detail, orphan], ['记忆压缩'], now)

  // 前提：里程碑确实低分、确实没有任何入边——也就是"现有规则会误删它"的那个形态。
  const milestoneScore = scored.find((s) => s.record.id === 'm1').score
  assert.ok(milestoneScore < 0.99, `里程碑必须是低分，实际 ${milestoneScore}`)
  assert.equal(scored.filter((s) => s.record.refs.includes('m1')).length, 0, '里程碑不应有任何入边')

  // 阈值拉满：低于阈值的孤立记录一律该被剪；里程碑必须例外。
  const byScore = selectPrunable(scored, 0.99, 100)
  assert.ok(!byScore.has('m1'), '里程碑是主线根节点，低分也不该被淘汰')
  assert.ok(byScore.has('t2'), '同批的低分孤立 turn 记录仍应被剪（豁免只给里程碑）')

  // 上限压到 0：第二遍淘汰也不许碰它。
  const byCap = selectPrunable(scored, 0.99, 0)
  assert.ok(!byCap.has('m1'), '条数上限再紧也不许淘汰里程碑')
})

test('里程碑的 refs 指向同轮范围内已存在的 turn/digest 记录，且不复制细节正文', async () => {
  // L1 只留 2 轮、L2 只留 1 轮：turns 1–5 会被蒸馏进 L3，里程碑才有东西可引用。
  const { dir } = await runSession({ l1RetainTurns: 2, l2RetainTurns: 1 }, syntheticEvents(1, 8))
  try {
    const records = readRecords(dir)
    const milestones = records.filter((r) => r.kind === 'milestone')
    assert.ok(milestones.length > 0, '应产出里程碑记录')
    const details = records.filter((r) => r.kind === 'turn' || r.kind === 'digest')
    assert.ok(details.length > 0, '应先把细节蒸馏进 L3（里程碑的引用目标）')

    const byId = new Map(records.map((r) => [r.id, r]))
    assert.ok(milestones.some((m) => m.refs.length > 0),
      '已被蒸馏的那些轮，其里程碑必须引用到细节记录')

    for (const milestone of milestones) {
      for (const ref of milestone.refs) {
        const target = byId.get(ref)
        assert.ok(target !== undefined, `refs 必须指向真实存在的记录：${ref}`)
        assert.ok(target.kind === 'turn' || target.kind === 'digest',
          `refs 只指向 turn/digest 细节记录，实际 ${target.kind}`)
        assert.ok(target.turnFrom <= milestone.turnTo && target.turnTo >= milestone.turnFrom,
          `refs 必须在里程碑的轮次范围内：里程碑 ${milestone.turnFrom}–${milestone.turnTo}，记录 ${target.turnFrom}–${target.turnTo}`)
      }
      // 不新建 detail 记录：里程碑只是根，正文必须独一无二（细节只存一份）。
      const copies = records.filter((r) => r.id !== milestone.id && r.text === milestone.text)
      assert.equal(copies.length, 0, `里程碑不得复制细节正文：${milestone.text}`)
      assert.match(milestone.text, /^第 \d+(-\d+)? 轮: /, '里程碑正文应是骨架行形态')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── high-water mark：溢出轮数不变就不重复提取 ────────────────────────────

test('high-water mark：L1 溢出轮数不变时不重新提取，变化时才提取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-mainline-mark-'))
  try {
    const { step } = harness({ l3Dir: dir, l3Store: 'jsonl', l1RetainTurns: 8 })
    await tick()
    const events = syntheticEvents(1, 10, 0) // 10 轮 − 8 = 溢出 2 轮
    const session = { id: 's-mark', events }

    const first = await step(session)
    assert.match(textOf(first), /里程碑主线骨架/, '首步应注入骨架')
    assert.doesNotMatch(textOf(first), /审批被拒/)

    // 追加一条"会改变骨架、但不改变溢出轮数"的事件：若这一步重新提取，
    // 骨架里就会多出「审批被拒」一行，投影随之变化，于是会有第二条注入消息。
    events.push({ type: 'approval/decided', seq: 60, data: { id: 'a1', outcome: 'denied' } })
    const second = await step(session)
    assert.equal(second.messages.length, 0, '溢出轮数没变 → 不重新提取，投影逐字不变')

    // 真正推进一轮（溢出 2 → 3）后必须重新提取：新事件与新一轮都要出现在骨架里。
    events.push(...syntheticEvents(11, 11, 61))
    const third = await step(session)
    assert.equal(third.messages.length, 1, '溢出轮数变化 → 重新提取，投影更新')
    const skeleton = blockOf(textOf(third), '## 里程碑主线骨架')
    assert.match(skeleton, /第 11 轮:/, '重新提取后应覆盖到新的一轮')
    assert.match(skeleton, /审批被拒/, '重新提取后应包含新追加的事件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 可恢复性回归：同轮多条、正文刷新、全量快照 ───────────────────────────

/** 造一份"同一轮产出两条里程碑"的事件流（目标事件 + 阻塞失败）。 */
function multiMilestoneEvents() {
  const events = []
  let seq = 0
  events.push({ type: 'turn/start', seq: seq++, data: { turn: 1 } })
  events.push({
    type: 'user/message', seq: seq++,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第1轮：请处理记忆压缩任务' }] },
  })
  events.push({ type: 'goal/change', seq: seq++, data: { operation: 'create', goal: { objective: '构建三层记忆插件' } } })
  events.push({
    type: 'tool/call', seq: seq++,
    data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ description: '跑测试' }) },
  })
  events.push({
    type: 'tool/result', seq: seq++,
    data: {
      turn: 1, step: 1, isError: true,
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'FAIL test/foo.test.mjs' }] },
    },
  })
  events.push({ type: 'turn/end', seq: seq++, data: { turn: 1, reason: { kind: 'completed' } } })
  events.push(...syntheticEvents(2, 4, seq).map((event) => ({ ...event, seq: event.seq + seq })))
  return events
}

test('同轮多条里程碑全部落 L3（回归：按轮区间去重会让第二条永久取不回）', async () => {
  const events = multiMilestoneEvents()
  const extracted = extractMilestones(events)
  const sameTurn = extracted.filter((m) => m.turn === 1 && (m.turnTo ?? m.turn) === 1)
  // 前提：夹具必须真的让同一轮产出 ≥2 条，否则这条测试什么都没证明。
  assert.ok(sameTurn.length >= 2, `夹具必须在第 1 轮产出 ≥2 条里程碑，实际 ${sameTurn.length}`)

  const { dir } = await runSession({ l1RetainTurns: 2 }, events)
  try {
    const records = readRecords(dir).filter((r) => r.kind === 'milestone')
    const turn1 = records.filter((r) => r.turnFrom === 1 && r.turnTo === 1)
    assert.equal(turn1.length, sameTurn.length,
      `同轮 ${sameTurn.length} 条里程碑必须各有记录，实际 ${turn1.length} 条`)

    // 逐条核对"这条骨架行取不回来"——取回就是能在 L3 里找到同文记录。
    const stored = new Set(records.map((r) => r.text))
    for (const milestone of extracted) {
      const span = milestone.turnTo === undefined || milestone.turnTo === milestone.turn
        ? `第 ${milestone.turn} 轮`
        : `第 ${milestone.turn}–${milestone.turnTo} 轮`
      const line = `${span}: ${milestone.title} — ${milestone.cause}`
      assert.ok(stored.has(line), `骨架行必须能逐字取回：${line}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重新提取时 L3 正文就地刷新，不产生同区间两份记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-mainline-refresh-'))
  try {
    const { step } = harness({ l3Dir: dir, l3Store: 'jsonl', l1RetainTurns: 4 })
    await tick()
    const events = syntheticEvents(1, 6)
    const session = { id: 's-refresh', events }
    await step(session)
    const before = readRecords(dir).filter((r) => r.kind === 'milestone')

    // 追加"会改变第 1 轮 cause"的事件（一次成功的验证），并推进新一轮触发重新提取。
    events.push({
      type: 'tool/result', seq: 900,
      data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'late', content: [{ type: 'text', text: '全部通过' }] } },
    })
    events.push(...syntheticEvents(7, 7, 901))
    await step(session)
    const after = readRecords(dir).filter((r) => r.kind === 'milestone')

    // 同一轮区间不许出现两份记录（旧实现的 update 路径靠"先到先得"，同轮多条会改错）。
    const spans = after.map((r) => `${r.turnFrom}:${r.turnTo}`)
    assert.equal(new Set(spans).size, spans.length, `同轮区间不得重复：${spans.join(', ')}`)
    // 记录只增不减：刷新是就地改写，不是删了重写。
    assert.ok(after.length >= before.length, '刷新后记录数不得变少')
    // 每条记录都必须是当前骨架里某条里程碑的逐字行。
    const current = new Set(extractMilestones(events).map((m) => {
      const span = m.turnTo === undefined || m.turnTo === m.turn ? `第 ${m.turn} 轮` : `第 ${m.turn}–${m.turnTo} 轮`
      return `${span}: ${m.title} — ${m.cause}`
    }))
    for (const record of after) {
      assert.ok(current.has(record.text), `L3 里残留了过期正文（取回会拿到旧版）：${record.text}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('全量骨架快照 <sessionId>.mainline.json：未剪枝 + 剪枝清单 + 落库核对', async () => {
  const events = multiMilestoneEvents()
  const { dir } = await runSession({}, events)
  try {
    const file = join(dir, 's-mainline.mainline.json')
    assert.ok(existsSync(file), `快照必须落盘：${file}`)
    const snapshot = JSON.parse(readFileSync(file, 'utf8'))
    const extracted = extractMilestones(events)
    assert.equal(snapshot.milestones.length, extracted.length,
      '快照必须保存**未剪枝**的全量骨架（展示可以省，本地不能省）')
    assert.equal(snapshot.totals.milestones, extracted.length)
    assert.ok(Array.isArray(snapshot.earlier), '要有"被移出注入"的清单')
    assert.ok(Array.isArray(snapshot.infoDropped), '要有"被信息量剪枝删掉"的清单')
    assert.ok(Array.isArray(snapshot.causeStripped), '要有"被剥掉 cause"的清单')
    assert.match(snapshot.note, /存储无损/, '快照要自己说明它和注入的区别')
    // 每条都要带"是否确认落库"，这样人复查时能直接看出 recoverability。
    for (const item of snapshot.milestones) {
      assert.equal(typeof item.stored, 'boolean', '每条里程碑必须标注是否已落库')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('L3 turn 记录里逐字保留约束原话（存储侧无损的回归）', async () => {
  const events = syntheticEvents(1, 6)
  // 给第 1 轮塞一条"分类预算会漏掉"的约束句：它不是失败/验证类，分层抽取不保证留下。
  events[1].data.content[0].text = '第1轮：请处理记忆压缩任务\n必须保留任务边界，不能把约束剪掉，避免只留标题'
  const { dir } = await runSession({ l1RetainTurns: 2, l2RetainTurns: 1 }, events)
  try {
    const turns = readRecords(dir).filter((r) => r.kind === 'turn' && r.turnFrom === 1)
    assert.ok(turns.length > 0, '第 1 轮应已溢出并蒸馏进 L3')
    assert.match(turns[0].text, /用户原话·约束（未剪）/, 'turn 记录要带未剪约束段')
    assert.match(turns[0].text, /必须保留任务边界，不能把约束剪掉，避免只留标题/,
      '约束原话必须逐字可取回（不是转述、不是截断）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('历史 turn 记录缺"未剪约束"段时会被批量补写（存量修复，不是只对新轮生效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-backfill-'))
  try {
    // 预置一条"旧版本写的"记录：没有约束段（真实历史记录就是这样）。
    const seeded = {
      id: 'l3-old-0001', kind: 'turn', createdAt: 1, sessionId: 's-backfill',
      turnFrom: 1, turnTo: 1, text: '## 任务主线\n- turn 1: 旧记录', tokens: 10, keywords: ['旧记录'], refs: [],
    }
    writeFileSync(join(dir, 'deep-memory.jsonl'), JSON.stringify(seeded) + '\n')

    const { step } = harness({ l3Dir: dir, l3Store: 'jsonl', l1RetainTurns: 2, l2RetainTurns: 1 })
    await tick()
    const events = syntheticEvents(1, 6)
    events[1].data.content[0].text = '第1轮：必须保留任务边界，不能把约束剪掉'
    await step({ id: 's-backfill', events })

    const record = readRecords(dir).find((r) => r.id === 'l3-old-0001')
    assert.ok(record !== undefined, '预置记录不能被新写入覆盖掉')
    assert.match(record.text, /用户原话·约束（未剪）/, '存量记录必须被补写，而不是只对新轮生效')
    assert.match(record.text, /必须保留任务边界，不能把约束剪掉/, '补进去的必须是用户原话（逐字）')
    assert.match(record.text, /旧记录/, '补写是**追加**，不许抹掉原有正文')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
