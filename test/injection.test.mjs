/**
 * test/injection.test.mjs — 注入量记账（`injection`）的回归测试。
 *
 * **为什么单独钉这一组**：诊断文件过去只记"模型调用花了多少"（`l2.attempt`）与
 * "骨架有几条"，从不记"这一轮到底往上下文里灌了多少 token"。于是
 * `verify-compression.mjs` 只能拿会话日志的原始量对比一个估出来的数，
 * "压缩了 82 倍"这句话没法自证——而 82 倍其实只是 L2 摘要自己的输入/输出比。
 *
 * 这组测试钉三件事：
 * 1. **可加性**：L1 + L2 + L3 + 骨架 = `totalInjected`，而且每一项都等于注入
 *    文本里对应块的实际 token 数（不是候选、不是配置上限）。
 * 2. **骨架必须计入**：它走独立上限、不进仲裁，但确实是注入的一部分；漏掉它
 *    会让注入合计偏小、压缩比虚高。
 * 3. **两个观察面一致**：诊断文件的 `injection.totalInjected` 与
 *    `memory_state.layers.injection.totalInjected` 必须是同一个数。
 *
 * 与 mainline.test.mjs 同一策略：直接 import `src/host/index.ts`（Node 原生类型
 * 剥离），用最小 mock ctx 跑真实的 pre-step 链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/host/index.ts'
import { apply as applyBuilt } from '../lib/impl.js'
import { estimateTokens } from '../src/host/l1-working.ts'

// ── 夹具 ─────────────────────────────────────────────────────────────────

/**
 * 造一段合成会话：每轮 user + assistant + 一次工具调用。
 *
 * 形状必须与真实日志一致（`user/message` 正文在 `data.content`，
 * `assistant/message` / `tool/result` 在 `data.message.content`）——
 * 本项目已经因为 fixture 形状不对漏过一个"读不到助手正文"的致命 bug。
 *
 * @param from - 起始轮号。
 * @param to - 结束轮号（含）。
 * @returns 事件数组。
 */
function syntheticEvents(from, to) {
  const events = []
  let seq = 0
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
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮的结论：三层接线已完成，关键决策已记录。` }] } },
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

/** 最小可用 Host ctx（与 mainline.test.mjs 同形）。 */
function mockContext() {
  const listeners = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    effect(fn) { fn() },
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

/** 四个注入块的起始标题（L2 正文里还有别的 `##`，因此只能按这四个锚点切）。 */
const BLOCK_HEADERS = [
  '## L1 工作记忆',
  '## 里程碑主线骨架',
  '## L2 短期记忆',
  '## L3 深层记忆（Deep Memory）',
]

/**
 * 从投影全文里按四个锚点切块。
 *
 * @param text - pre-step 注入的投影全文。
 * @returns 四个块（顺序 L1 → 骨架 → L2 → L3）。
 */
function blocksOf(text) {
  const positions = BLOCK_HEADERS.map((header) => text.indexOf(header))
  for (let i = 0; i < positions.length; i += 1) {
    assert.ok(positions[i] >= 0, `投影里缺少块「${BLOCK_HEADERS[i]}」，实际：\n${text.slice(0, 400)}`)
    if (i > 0) assert.ok(positions[i] > positions[i - 1], `块顺序必须是 L1→骨架→L2→L3，实际偏移 ${positions.join(',')}`)
  }
  return positions.map((start, i) => {
    const end = i + 1 < positions.length ? positions[i + 1] : text.length
    return text.slice(start, end).replace(/\s+$/, '')
  })
}

/**
 * 挂载一次插件（同一个实例可推进多轮，state 才能跨轮保留）。
 *
 * @param options - 会话、覆盖配置、诊断目录。
 * @returns step()：推进一轮并返回本轮投影、诊断快照与 memory_state 读数。
 */
async function mount({ from = 1, to = 12, config = {}, session, dir, applyFn = apply } = {}) {
  const { ctx, listeners, tools } = mockContext()
  applyFn(ctx, {
    l2Mode: 'extractive',
    l3Store: 'jsonl',
    l3Enabled: true,
    selfTestAfterBoot: false,
    ...(dir === undefined ? {} : { l3Dir: dir }),
    ...config,
  })
  await tick()
  const entry = listeners.get('agent/pre-step')[0]
  assert.ok(entry !== undefined, 'pre-step 监听必须注册')
  const ctxSession = session ?? { id: 's-injection', events: syntheticEvents(from, to) }
  const stateTool = tools.find((t) => t.name === 'memory_state')
  const readDiagnostics = () => (dir === undefined
    ? null
    : JSON.parse(readFileSync(join(dir, `${ctxSession.id}.diagnostics.json`), 'utf8')))
  const step = async () => {
    const decision = await entry.listener(
      { agent: { session: ctxSession }, turn: to, step: 1, signal: { aborted: false } },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const text = (decision?.messages ?? []).map((m) => m?.content?.[0]?.text ?? '').join('\n')
    const status = await stateTool.execute({}, { agent: { session: ctxSession } })
    return { text, decision, status, diagnostics: readDiagnostics(), session: ctxSession }
  }
  return { step, dir }
}

/**
 * 挂载插件、跑一轮 pre-step，并读回投影 / 诊断 / memory_state。
 *
 * @param options - 轮次区间、覆盖配置、诊断目录。
 * @returns 投影全文、诊断快照与状态读数。
 */
async function runStep(options = {}) {
  const plugin = await mount(options)
  return plugin.step()
}

/** 跑一轮并把临时目录清理掉。 */
async function withTemp(options, body) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tlm-injection-'))
  try {
    return await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── 1. 可加性：四项之和 = 合计，且每一项都等于实际注入文本 ─────────────────

test('注入记账可加：L1+L2+L3+骨架 = totalInjected，且逐项等于注入文本里的真实块', async () => {
  await withTemp({}, async (dir) => {
    const { text, diagnostics, status } = await runStep({ dir })
    const injection = diagnostics.injection
    assert.ok(injection !== null && injection !== undefined, '诊断必须带 injection 块')

    const [l1, mainline, l2, l3] = blocksOf(text)
    assert.equal(injection.l1Tokens, estimateTokens(l1), 'L1Tokens 必须等于注入文本里 L1 块的实际估算')
    assert.equal(injection.mainlineTokens, estimateTokens(mainline), '骨架 token 必须按**渲染后**的块算')
    assert.equal(injection.l2Tokens, estimateTokens(l2), 'L2Tokens 必须等于注入文本里 L2 块的实际估算')
    assert.equal(injection.l3Tokens, estimateTokens(l3), 'L3Tokens 必须等于注入文本里 L3 块的实际估算')

    const sum = injection.l1Tokens + injection.l2Tokens + injection.l3Tokens + injection.mainlineTokens
    assert.equal(injection.totalInjected, sum, '四项之和必须等于 totalInjected（漏算一层就会被这条抓住）')
    assert.ok(injection.l1Tokens > 0 && injection.l2Tokens > 0 && injection.l3Tokens > 0,
      `三层都必须真的注入了，实际 ${JSON.stringify(injection)}`)
    assert.ok(injection.mainlineTokens > 0, '骨架必须被计入（它不进仲裁，但确实是注入的一部分）')
    assert.equal(injection.budgetTokens, 1200, 'budgetTokens 必须是本次仲裁实际用的预算')
    assert.match(String(injection.at), /^\d{4}-\d{2}-\d{2}T/, '必须记下本次注入的时刻，否则旧读数会被当成这一轮的')
    assert.ok(Array.isArray(injection.dropped) && injection.dropped.length === 0, '预算充足时不该有整块丢弃')

    // 消息头 + 三个块间空行是四项之外的固定开销：必须很小，且不能是"漏了一层"的量级。
    const overhead = estimateTokens(text) - injection.totalInjected
    assert.ok(overhead >= 0 && overhead <= 20,
      `四项之和与整条投影的差应只有消息头/空行（约 10 tokens），实际差 ${overhead}`)

    // 第二个观察面：memory_state 必须报同一个数（两个面读数不一致比缺字段更糟）。
    assert.equal(status.injection.totalInjected, injection.totalInjected,
      'memory_state 与诊断文件的注入合计必须是同一个数')
    assert.equal(status.injection.mainlineTokens, injection.mainlineTokens,
      'memory_state 也要报出骨架占用')
  })
})

// ── 2. L1 记账记的是注入块，不是原文窗口 ────────────────────────────────

test('L1Tokens 记的是注入块（marker），不是 L1 原文窗口的体量', async () => {
  await withTemp({}, async (dir) => {
    const { text, diagnostics } = await runStep({ dir })
    const [l1] = blocksOf(text)
    // 剪枝后 L1 只报窗口边界（"估算占用：约 N tokens"那行会被人误读成限额，已删）。
    // 但它记录的东西还在：原文窗口本身可能几十万 token，而这里只占十几个——
    // 两者必须是两件事，否则"注入量"与"原文仍在"会被混为一谈。
    assert.match(l1, /保留窗口：最近 \d+ 轮真实对话/, `L1 块应报窗口边界，实际：${l1}`)
    assert.doesNotMatch(l1, /估算占用/, '注入块不得再带"估算占用"行')
    assert.ok(diagnostics.injection.l1Tokens <= 60,
      `L1 marker 只有块头+一行（≤60 tokens），实际 ${diagnostics.injection.l1Tokens}`)
    assert.equal(diagnostics.injection.l1Tokens, estimateTokens(l1),
      '记账必须等于注入文本里 L1 块的实际估算')
  })
})

// ── 3. 预算紧张：丢弃如实记账，骨架仍计入 ────────────────────────────────

test('预算紧张时：L3 索引仍有保底（不得整块消失），四项之和仍等于合计，骨架不受影响', async () => {
  await withTemp({}, async (dir) => {
    const { text, diagnostics } = await runStep({
      from: 1, to: 40, dir, config: { injectionBudgetTokens: 200, l1RetainTurns: 8 },
    })
    const injection = diagnostics.injection
    // 修复前这里断言"必然发生整块丢弃"；但那恰好是本次要修的病：预算 200 时
    // L3 索引被整块丢掉（dropped: ["l3"]、l3Tokens: 0），模型连"可以去 recall"
    // 都不知道。现在的契约是：它必须降级成一行（degraded），而不是消失。
    assert.ok(injection.l3Tokens > 0,
      `预算 200 时 L3 索引也不得为 0，实际 ${JSON.stringify(injection)}`)
    assert.match(text, /memory_recall/, '模型必须能从注入文本知道用哪个工具去查')
    assert.match(text, /(已持久化 \d+ 条记录|另有 \d+ 条记录可 recall)/,
      'L3 索引必须带计数（模型据此知道有东西可查）')
    // 被丢弃的块 token 必须是 0：记成"候选大小"等于把没注入的钱算成花了。
    for (const id of injection.dropped) {
      assert.equal(injection[`${id}Tokens`], 0, `块 ${id} 已被整块丢弃，对应 token 必须为 0`)
    }
    // 仲裁层（不含骨架）不得超预算；骨架另有独立上限不参与这条。
    assert.ok(injection.l1Tokens + injection.l2Tokens + injection.l3Tokens <= injection.budgetTokens,
      '仲裁层用量不得超预算')
    assert.equal(injection.totalInjected,
      injection.l1Tokens + injection.l2Tokens + injection.l3Tokens + injection.mainlineTokens,
      '发生丢弃/截断时加法仍然必须成立')
  })
})

// ── 4. 骨架关闭 ─────────────────────────────────────────────────────────

test('mainlineInject: false：骨架不计入（0），四项之和仍等于合计', async () => {
  await withTemp({}, async (dir) => {
    const { text, diagnostics } = await runStep({ dir, config: { mainlineInject: false } })
    assert.equal(diagnostics.injection.mainlineTokens, 0, '骨架关掉时必须是 0，不能沿用上一轮的数')
    assert.doesNotMatch(text, /## 里程碑主线骨架/, '骨架关掉后不得出现在投影里')
    assert.equal(diagnostics.injection.totalInjected,
      diagnostics.injection.l1Tokens + diagnostics.injection.l2Tokens
      + diagnostics.injection.l3Tokens + diagnostics.injection.mainlineTokens,
      '关掉骨架后加法仍必须成立')
    assert.ok(diagnostics.injection.l1Tokens > 0, '其余三层照常注入')
  })
})

// ── 5. 内容没变、不重复注入：注入时刻必须停在真正注入的那一轮 ────────────────

test('内容未变不重复注入：injection.at 保持不变（旧读数不会冒充本轮）', async () => {
  await withTemp({}, async (dir) => {
    const session = { id: 's-injection-dedupe', events: syntheticEvents(1, 12) }
    // 必须复用**同一个插件实例**：换实例等于换 state，lastInjected 归零，注入当然会发生。
    const plugin = await mount({ dir, session })
    const first = await plugin.step()
    assert.ok(first.text.length > 0, '第一轮必须注入')
    assert.equal(first.decision.messages.length, 1)

    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = await plugin.step()
    assert.equal(second.decision.messages.length, 0, '内容没变时不得重复注入')
    assert.equal(second.diagnostics.injection.at, first.diagnostics.injection.at,
      '没有发生注入时，injection.at 必须停在上一轮——否则读者会把旧数字当成这一轮的')
    assert.equal(second.diagnostics.injection.totalInjected, first.diagnostics.injection.totalInjected)
    assert.notEqual(second.diagnostics.updatedAt, first.diagnostics.updatedAt,
      '诊断文件本身仍应每轮落盘（失败原因不能因不注入而丢）')
  })
})

// ── 6. 部署面：构建产物与源码行为一致 ─────────────────────────────────

test('lib/impl.js（部署产物）同样写出 injection 记账：字段没被构建丢掉', async () => {
  await withTemp({}, async (dir) => {
    const plugin = await mount({ dir, applyFn: applyBuilt })
    const { text, diagnostics } = await plugin.step()
    const injection = diagnostics.injection
    assert.ok(injection !== null && injection !== undefined, '构建产物的诊断必须带 injection 块')
    const [l1, mainline, l2, l3] = blocksOf(text)
    assert.equal(injection.l1Tokens, estimateTokens(l1))
    assert.equal(injection.mainlineTokens, estimateTokens(mainline))
    assert.equal(injection.l2Tokens, estimateTokens(l2))
    assert.equal(injection.l3Tokens, estimateTokens(l3))
    assert.equal(injection.totalInjected,
      injection.l1Tokens + injection.l2Tokens + injection.l3Tokens + injection.mainlineTokens)
    assert.ok(injection.mainlineTokens > 0, '部署面上骨架也必须计入（它是最容易被漏掉的那一项）')
  })
})
