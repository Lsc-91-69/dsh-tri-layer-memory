/**
 * test/l2-rolling.test.mjs — L2 滚动摘要的回归测试（覆盖区间不塌缩 + 信息不丢）。
 *
 * **为什么单独钉这一组**：修复前 `refreshDigest` 把 `uncovered`（新增的 3 轮）
 * 直接喂给模型，并把返回的 turnFrom/turnTo 当成新摘要的覆盖区间——每刷新一次，
 * L2 就从"24 轮"缩到"最后 3 轮"。而中间轮次的原文早已溢出 L1、只留在被丢弃的
 * 旧摘要里（L3 的 turn 记录保留率仅 2.1%），等于同时被 L2 抛弃、被 L3 敷衍。
 *
 * 这组测试钉四件事：
 * 1. 摘要输入必须同时包含**上一份摘要**与**新增轮原文**，且指令要求合并历史；
 * 2. 摘要声明的覆盖区间是**整个 L2 窗口**，不是本批输入的范围；
 * 3. 模型不可用退回抽取式时，旧摘要的要点仍然在（按节合并，不覆盖）；
 * 4. 端到端跑多轮 pre-step：后一次摘要调用的 prompt 里必须能看到前一份摘要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildDigest, mergeExtractiveDigest, renderDigestInput } from '../src/host/l2-short.ts'
import { apply } from '../src/host/index.ts'

/** 造一个最小 TurnSpan（形状与 l1-working.ts 一致）。 */
function span(turn, user, assistant) {
  const userText = `第${turn}轮：${user}`
  const assistantText = `第${turn}轮的结论：${assistant}`
  return {
    turn,
    startSeq: turn * 10,
    endSeq: turn * 10 + 3,
    messageSeqs: [turn * 10 + 1],
    userText: [userText],
    assistantText: [assistantText],
    toolNames: [],
    charCount: userText.length + assistantText.length,
    tokens: 0,
    projections: 0,
    open: false,
  }
}

/** 假 llm seam：每次返回带序号的四节摘要，并记录请求全文。 */
function rollingLlm() {
  const calls = []
  return {
    calls,
    service: {
      async *stream(request) {
        const text = String(request?.messages?.[0]?.content?.[0]?.text ?? '')
        calls.push({ request, text })
        const digest = [
          '## 任务主线',
          `- 摘要序号 ${calls.length - 1}`,
          '',
          '## 已完成的子任务',
          '- (none)',
          '',
          '## 关键决策与依据',
          '- (none)',
          '',
          '## 未决问题',
          '- (none)',
        ].join('\n')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: digest }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

/** 最小 Host ctx（与 injection.test.mjs 同形，另带一个 llm 服务）。 */
function mockContext(services = {}) {
  const listeners = new Map()
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener })
    },
    effect(fn) { fn() },
    inject(deps, callback) {
      if (!deps.every((dep) => ctx[dep] !== undefined)) return
      const child = Object.create(ctx)
      for (const dep of deps) child[dep] = ctx[dep]
      callback(child)
    },
    get() { return undefined },
    tools: { register(tool) { tools.push(tool); return () => {} }, schemas() { return [] } },
  }
  // 服务必须挂到 ctx 上：`ctx.inject(['llm'], cb)` 的软等待只在 `ctx.llm`
  // 存在时回调——忘了这行，整条 LLM 路径静默走"seam 缺席"，测试却看不出原因。
  Object.assign(ctx, services)
  return { ctx, listeners, tools, services }
}

/** 造合成会话事件（与 injection.test.mjs 的 fixture 同形）。 */
function syntheticEvents(from, to) {
  const events = []
  let seq = 0
  for (let turn = from; turn <= to; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({
      type: 'user/message',
      seq: seq++,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮：请修复滚动摘要的覆盖区间` }] },
    })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮结论：已按窗口区间记录，关键决策保留。` }] } },
    })
    events.push({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

// ── 1. 输入渲染：上一份摘要 + 新增轮 ──────────────────────────────────────

test('renderDigestInput：首次只有原文；滚动时同时带上一份摘要与新增轮', () => {
  const spans = [span(112, '新增诉求 A', '新增结论 B')]
  const first = renderDigestInput(spans, undefined)
  assert.doesNotMatch(first, /上一份摘要/, '首次摘要不该出现"上一份摘要"段')
  assert.match(first, /### turn 112/)

  const rolling = renderDigestInput(spans, '## 任务主线\n- turn 88: 关键决策 KEY-88')
  assert.match(rolling, /## 上一份摘要/, '滚动摘要必须明确标出上一份摘要')
  assert.match(rolling, /KEY-88/, '上一份摘要的正文必须真的进输入（不能只留个标题）')
  assert.match(rolling, /## 新增轮次原文/, '新增轮原文必须单独成段')
  assert.match(rolling, /### turn 112/)
  assert.ok(rolling.indexOf('## 上一份摘要') < rolling.indexOf('## 新增轮次原文'),
    '顺序必须是先历史、后新增（模型按这个顺序读）')
})

test('renderDigestInput：空白的上一份摘要按首次处理（不产生空段）', () => {
  const input = renderDigestInput([span(112, 'A', 'B')], '   \n  ')
  assert.doesNotMatch(input, /上一份摘要/)
})

// ── 2. 抽取式回退：旧摘要按节合并，不覆盖 ────────────────────────────────

test('mergeExtractiveDigest：旧摘要的结论保留，新轮条目追加，空节写 (none)', () => {
  const previous = [
    '## 任务主线',
    '- turn 88: KEY-88',
    '',
    '## 已完成的子任务',
    '- turn 89: DONE-89',
    '',
    '## 关键决策与依据',
    '- DEC-1',
    '',
    '## 未决问题',
    '- OPEN-1',
  ].join('\n')
  const fresh = [
    '## 任务主线',
    '- turn 112: NEW-112',
    '',
    '## 已完成的子任务',
    '- (none)',
    '',
    '## 关键决策与依据',
    '- 涉及的工具：pwsh',
    '',
    '## 未决问题',
    '- (none)',
  ].join('\n')
  const merged = mergeExtractiveDigest(previous, fresh)
  for (const marker of ['KEY-88', 'DONE-89', 'DEC-1', 'OPEN-1', 'NEW-112', '涉及的工具：pwsh']) {
    assert.ok(merged.includes(marker), `合并后丢了 ${marker}：\n${merged}`)
  }
  assert.ok(merged.indexOf('KEY-88') < merged.indexOf('NEW-112'), '旧条目应排在新条目之前')
})

test('mergeExtractiveDigest：同一节的重复条目不重复出现', () => {
  const previous = '## 任务主线\n- turn 88: SAME'
  const fresh = '## 任务主线\n- turn 88: SAME'
  const merged = mergeExtractiveDigest(previous, fresh)
  assert.equal(merged.split('SAME').length - 1, 1, '同一条不应被复制两份')
})

// ── 3. buildDigest：区间来自整个窗口、prompt 带旧摘要、回退也合并 ─────────

test('buildDigest：摘要声明的区间是整个 L2 窗口，输入里带上一份摘要与合并规则', async () => {
  const llm = rollingLlm()
  const digest = await buildDigest(llm.service, [span(112, '新诉求', '新结论')], {
    mode: 'llm',
    maxTokens: 4096,
    sessionId: 's-rolling',
    agent: { options: { provider: 'p', model: 'm' } },
    previousText: '## 任务主线\n- turn 88: KEY-88-PATH-D:\\work\\budget.ts',
    windowFrom: 96,
    windowTo: 120,
  })
  assert.ok(digest !== null)
  assert.equal(digest.via, 'llm')
  assert.equal(digest.turnFrom, 96, '区间起点必须是窗口起点，不是本批输入的起点')
  assert.equal(digest.turnTo, 120, '区间终点必须是窗口终点，不是本批输入的终点')
  assert.equal(llm.calls.length, 1)
  const prompt = llm.calls[0].text
  assert.match(prompt, /KEY-88-PATH-D:\\work\\budget\.ts/, '旧摘要的关键路径必须逐字进 prompt')
  assert.match(prompt, /A PREVIOUS digest/, '必须告诉模型"前面那份是上一份摘要"')
  assert.match(prompt, /Never drop an older item merely because it is old/, '必须明确禁止"只总结新的"')
})

test('buildDigest：模型不可用时回退抽取式，但旧摘要要点仍在（区间不塌）', async () => {
  const digest = await buildDigest(undefined, [span(112, '新诉求', '新结论')], {
    mode: 'llm',
    maxTokens: 4096,
    sessionId: 's-rolling',
    agent: { options: { provider: 'p', model: 'm' } },
    previousText: '## 任务主线\n- turn 88: KEY-88',
    windowFrom: 96,
    windowTo: 120,
  })
  assert.ok(digest !== null)
  assert.equal(digest.via, 'extractive')
  assert.equal(digest.fallback?.stage, 'llm-missing')
  assert.equal(digest.turnFrom, 96)
  assert.equal(digest.turnTo, 120)
  assert.match(digest.text, /KEY-88/, '回退到抽取式时旧摘要不能整份消失')
  assert.match(digest.text, /turn 112/, '新轮也要并进回退产物')
})

// ── 4. 端到端：多轮 pre-step 的区间与 prompt 传递 ─────────────────────────

test('端到端：多次刷新后 L2 覆盖仍是整个窗口，后一次 prompt 含前一份摘要', async () => {
  const llm = rollingLlm()
  const { ctx, listeners } = mockContext({ llm: llm.service })
  apply(ctx, {
    l1RetainTurns: 2,
    l2RetainTurns: 6,
    l2MinTurnsBeforeSummary: 2,
    l2Mode: 'llm',
    l3Enabled: false,
    mainlineEnabled: false,
    selfTestAfterBoot: false,
  })
  const entry = listeners.get('agent/pre-step')[0]
  assert.ok(entry !== undefined, 'pre-step 监听必须注册')
  const session = {
    id: 's-rolling-e2e',
    events: [],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const injected = []
  for (let turn = 1; turn <= 18; turn += 1) {
    session.events = syntheticEvents(1, turn)
    const decision = await entry.listener(
      { agent: { session }, turn, step: 1, signal: { aborted: false } },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const text = (decision?.messages ?? []).map((message) => message?.content?.[0]?.text ?? '').join('\n')
    if (text.length > 0) injected.push({ turn, text })
  }

  assert.ok(llm.calls.length >= 2, `至少应发生两次摘要调用，实际 ${llm.calls.length}`)
  // 第 2 次及以后的调用必须把前一份摘要带进输入。
  for (let i = 1; i < llm.calls.length; i += 1) {
    assert.match(llm.calls[i].text, /## 上一份摘要/, `第 ${i + 1} 次调用缺少上一份摘要`)
    assert.match(llm.calls[i].text, new RegExp(`摘要序号 ${i - 1}`), `第 ${i + 1} 次调用没带上前一份摘要的正文`)
  }
  // 最后一次注入必须声明覆盖整个窗口（l2RetainTurns=6），而不是 2 轮。
  const last = injected[injected.length - 1]
  const cover = /覆盖 turn (\d+)–(\d+)/.exec(last.text)
  assert.ok(cover !== null, `注入里应有覆盖区间：\n${last.text.slice(0, 300)}`)
  assert.equal(Number(cover[2]) - Number(cover[1]) + 1, 6,
    `L2 应覆盖 6 轮（整个窗口），实际 ${cover[1]}–${cover[2]}`)
})
