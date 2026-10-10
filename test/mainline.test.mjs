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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    assert.ok(!tight.text.includes('## L3 深层记忆') || tight.text.includes('被截断'),
      '预算 200 应触发 L1/L2/L3 的降级')

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
