/**
 * test/layers.test.mjs — 三层记忆核心逻辑的行为测试。
 *
 * 直接 import `src/host/*.ts`（Node 22.18+/23.6+ 原生类型剥离），因此**不需要
 * 构建、不需要安装任何依赖**就能验证确定性逻辑。这也是把 config-core.ts /
 * l2-render.ts 从带 `@deepseek-ai/*` 依赖的模块里拆出来的原因。
 *
 * 只测行为，不测实现：断言"给定这些事件，L1 窗口是哪几轮""低于阈值且无人引用
 * 的记录会被剪掉"，而不是断言内部字段名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  estimateTokens,
  isProjectionEvent,
  pendingWindowInput,
  projectTurns,
  projectWorkingWindow,
  renderWorkingMemory,
  contentToText,
} from '../src/host/l1-working.ts'
import {
  DeepMemoryStore,
  extractKeywords,
  overlap,
  scoreRecords,
  selectPrunable,
} from '../src/host/l3-deep.ts'
import { L2_TRUNCATION_NOTE, arbitrateInjection } from '../src/host/budget.ts'
import {
  extractiveDigest,
  renderShortTermMemory,
  renderTurnsForSummary,
  resolveTarget,
} from '../src/host/l2-render.ts'
import { DEFAULTS, MEMORY_NAMESPACE, defaultStorageDir, resolveConfig } from '../src/host/config-core.ts'

/** 造一段合成会话日志：n 轮，每轮 user + assistant + 一个工具结果。 */
function syntheticEvents(turns) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    // ⚠ 这里的形状必须与真实会话日志一致，否则测试会忠实地验证一个错误假设。
    // DSH 的正文有两个位置：user/message 在 data.content，
    // assistant/message 与 tool/result 在 data.message.content。
    events.push({ type: 'user/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮的用户请求，关于记忆压缩` }] } })
    events.push({ type: 'assistant/message', seq: seq++, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮的结论。补充说明。` }] } } })
    const callId = `call-${turn}`
    events.push({ type: 'tool/call', seq: seq++, data: { turn, step: 1, callId, name: 'read_file', arguments: '{}' } })
    events.push({ type: 'tool/result', seq: seq++, data: { turn, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'x'.repeat(200) }] } } })
    events.push({ type: 'turn/end', seq: seq++, data: { turn } })
  }
  return events
}

// ── L1 工作记忆 ──────────────────────────────────────────────────────────

test('estimateTokens：CJK 按字计，ASCII 按 4 字符计', () => {
  assert.equal(estimateTokens('记忆压缩'), 4)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('记忆abcd'), 3)
  assert.equal(estimateTokens(''), 0)
})

test('projectTurns：按 turn/start 切分，并记录工具名与正文', () => {
  const spans = projectTurns(syntheticEvents(3))
  assert.equal(spans.length, 3)
  assert.deepEqual(spans.map((s) => s.turn), [1, 2, 3])
  assert.deepEqual(spans[0].toolNames, ['read_file'])
  assert.match(spans[0].userText[0], /第1轮的用户请求/)
  assert.equal(spans[0].open, false)
})

test('projectTurns：两种正文位置都要读到（真实日志形状回归）', () => {
  // 真实事故：这里曾经只读 data.content，于是 assistant/message 与 tool/result
  // 全部读空 —— memory_state 的 L1 占用被低估约 75 倍，且 L2 摘要退化成
  // 「只拿用户说的话做摘要」。fixture 当时也用了错形状，所以测试没拦住。
  const spans = projectTurns(syntheticEvents(1))
  const span = spans[0]

  // user/message：data.content
  assert.match(span.userText[0], /第1轮的用户请求/, 'user 正文应来自 data.content')
  // assistant/message：data.message.content
  assert.equal(span.assistantText.length, 1, 'assistant 正文必须被读到（data.message.content）')
  assert.match(span.assistantText[0], /第1轮的结论/, 'assistant 正文内容正确')
  // tool/result：data.message.content（200 个 x）
  assert.ok(span.charCount > 200, `charCount 应包含工具结果，实际 ${span.charCount}`)

  const expected = `第1轮的用户请求，关于记忆压缩`.length
    + `第1轮的结论。补充说明。`.length
    + 200
  assert.equal(span.charCount, expected, 'charCount 必须把三类正文都算进去')
})

test('projectTurns：工具名要经 toolCallId 回查 tool/call', () => {
  // tool/result 自己不带工具名，只带 toolCallId；名字在对应的 tool/call 上。
  const spans = projectTurns(syntheticEvents(1))
  assert.deepEqual(spans[0].toolNames, ['read_file'], '工具名应通过 callId 回查得到')
})

test('projectTurns：turn/start 之前的事件归入虚拟轮 -1，而不是被丢弃', () => {
  const events = [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '会话恢复时的注入' }] } },
    ...syntheticEvents(1),
  ]
  const spans = projectTurns(events)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].turn, -1)
  assert.equal(spans[1].turn, 1)
})

test('projectWorkingWindow：保留最近 N 轮，更早的进入 evicted', () => {
  const window = projectWorkingWindow(syntheticEvents(10), 4)
  assert.equal(window.totalTurns, 10)
  assert.equal(window.hot.length, 4)
  assert.equal(window.evicted.length, 6)
  assert.deepEqual(window.hot.map((s) => s.turn), [7, 8, 9, 10])
  assert.deepEqual(window.evicted.map((s) => s.turn), [1, 2, 3, 4, 5, 6])
  // 边界必须是"最后一条被淘汰轮的 seq"，L2 据此知道从哪里开始接管。
  assert.equal(window.boundarySeq, window.evicted[5].endSeq)
  assert.equal(window.hotStartSeq, window.hot[0].startSeq)
})

test('projectWorkingWindow：轮数少于保留数时全部留在 L1，无边界', () => {
  const window = projectWorkingWindow(syntheticEvents(2), 8)
  assert.equal(window.hot.length, 2)
  assert.equal(window.evicted.length, 0)
  assert.equal(window.boundarySeq, null)
})

test('projectWorkingWindow：retainTurns 至少保留 1 轮（0 会被夹到 1）', () => {
  const window = projectWorkingWindow(syntheticEvents(5), 0)
  assert.equal(window.hot.length, 1)
})

test('renderWorkingMemory：off 不产出；marker 只报边界不重复原文', () => {
  const window = projectWorkingWindow(syntheticEvents(5), 2)
  assert.equal(renderWorkingMemory(window, 'off'), null)
  const marker = renderWorkingMemory(window, 'marker')
  assert.match(marker, /L1 工作记忆/)
  assert.match(marker, /最近 2 轮/)
  // marker 形态的关键性质：不把用户原文再抄一遍。
  assert.doesNotMatch(marker, /第4轮的用户请求/)
  const full = renderWorkingMemory(window, 'full')
  assert.match(full, /第4轮的用户请求/)
})

test('L1 token 估算必须来自正文，不能来自字符计数（回归）', () => {
  // 真实事故：用量处写成 `estimateTokens(String(window.charCount))` —— 把字符数
  // 这个**数字**先转成字符串再估 token，得到的是"这个数字有几个字符"，而不是
  // "正文有多少 token"。一条 52 万字符的窗口被报成「约 2 tokens」。
  const window = projectWorkingWindow(syntheticEvents(3), 2)
  assert.ok(window.charCount > 0, '前提：窗口里有内容')

  // 逐轮 tokens 累加必须等于窗口 tokens。
  const hotSum = window.hot.reduce((n, s) => n + s.tokens, 0)
  assert.equal(window.tokens, hotSum, '窗口 tokens 应等于各轮 tokens 之和')
  assert.ok(window.tokens > 0, 'token 估算不能为 0')

  // 关键判据：token 估算应与字符数量级相当，而不是"字符数的位数"。
  // 旧实现下 charCount=1000 → String → "1000" → 约 1 token，比值会是 1/1000。
  assert.ok(window.tokens >= window.charCount / 4,
    `token 估算 ${window.tokens} 与字符数 ${window.charCount} 量级不符——疑似又在估计数而不是估正文`)
  assert.ok(window.tokens <= window.charCount,
    `token 估算 ${window.tokens} 不应超过字符数 ${window.charCount}`)

  // 注入块**不再**渲染这个数字：它长得像限额，实测被误读过两次（见 renderWorkingMemory
  // 的注释）。但"注入里不许出现估算占用"本身也是剪枝的验收点，要钉住。
  const marker = renderWorkingMemory(window, 'marker')
  assert.ok(marker !== null, 'marker 形态必须有输出')
  assert.doesNotMatch(marker, /估算占用/, '注入块不得再带估算占用行')
  assert.ok(estimateTokens(marker) <= 60,
    `L1 marker 应只剩块头+一行窗口事实，实际 ${estimateTokens(marker)} tokens`)
})

/** 造一条本插件注入的投影消息，形状与真实会话日志一致（source.kind + 完整头部行）。 */
function projectionEvent(seq, sections = ['## L1 工作记忆（Working Memory）', '## L2 短期记忆（Short-term Memory）', '## L3 深层记忆（Deep Memory）']) {
  return {
    type: 'user/message',
    seq,
    data: {
      content: [{ type: 'text', text: `# 三层记忆 · 本轮投影\n\n${sections.join('\n- x\n\n')}\n- 估算占用：约 999 tokens` }],
      source: { kind: 'dsh-tri-layer-memory', form: 'snapshot', sections: [{ name: 'dsh-tri-layer-memory', text: 'x' }] },
    },
  }
}

test('投影识别：本插件注入的投影被认出来（真实日志形状，含 source.kind）', () => {
  assert.equal(isProjectionEvent(projectionEvent(1)), true)
  // 预算仲裁会把某个块整块丢掉：只有两个层标题也必须是投影（实测 209 条里有 13 条如此）。
  assert.equal(isProjectionEvent(projectionEvent(2, ['## L1 工作记忆（Working Memory）', '## L3 深层记忆（Deep Memory）'])), true)
})

test('投影识别：用户粘贴同样的文本不会被误吞（source.kind 是强判据）', () => {
  const pasted = projectionEvent(1)
  pasted.data.source = { kind: 'user' }
  assert.equal(isProjectionEvent(pasted), false, '来源是 user 的同样文本必须当真对话')

  // 更狠的一种：头部行 + 只贴了一个层标题（没贴整份投影）。
  const partial = {
    type: 'user/message',
    seq: 2,
    data: {
      content: [{ type: 'text', text: '# 三层记忆 · 本轮投影\n\n## L1 工作记忆（Working Memory）\n这段是我抄的' }],
      source: { kind: 'user' },
    },
  }
  assert.equal(isProjectionEvent(partial), false)
})

test('投影识别：没有 source 的旧日志退回"头部行 + 至少两个层标题"', () => {
  const bare = projectionEvent(1)
  delete bare.data.source
  assert.equal(isProjectionEvent(bare), true, '旧日志也要能认出来')

  const barePartial = {
    type: 'user/message',
    seq: 2,
    data: { content: [{ type: 'text', text: '# 三层记忆 · 本轮投影\n\n## L1 工作记忆（Working Memory）\n用户抄的一段' }] },
  }
  assert.equal(isProjectionEvent(barePartial), false, '只贴一个层标题不算整份投影')
})

test('projectTurns：投影不进正文、不进 token、不进 L2 摘要输入（回归）', () => {
  // 真实故障：投影是 user 消息，于是被当成"未压缩的对话原文"。实测某会话最近 8 轮里
  // 84,087 / 127,101 tokens（55%）是插件自己历次注入的投影；而 L2 摘要的输入里也掺着
  // 它（一次摘要因此多读 47,031 字符）。
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '真正的问题' }] } },
    projectionEvent(2),
    projectionEvent(3),
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '真正的回答' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
  ]
  const [span] = projectTurns(events)
  assert.equal(span.projections, 2, '两条投影应被计数')
  assert.deepEqual(span.userText, ['真正的问题'], '投影不得进 userText（那是 L2 摘要的输入）')
  assert.deepEqual(span.messageSeqs, [1, 4], '投影不得进 messageSeqs')
  assert.equal(span.charCount, '真正的问题'.length + '真正的回答'.length, 'charCount 只算真对话')
  assert.equal(span.tokens, estimateTokens('真正的问题') + estimateTokens('真正的回答'))
})

test('projectWorkingWindow：投影让窗口变空时补足"真实对话轮数"', () => {
  // 场景：最后 4 个 turn 边界里，turn 5 只剩投影（工具调用之间的空轮），
  // turn 6/7 是投影之外什么都没有的边界。保留 2 轮真实对话 = turn 3、4。
  const events = []
  let seq = 0
  for (let turn = 1; turn <= 7; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    if (turn <= 4) {
      events.push({ type: 'user/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮的问题` }] } })
      events.push({ type: 'assistant/message', seq: seq++, data: { message: { content: [{ type: 'text', text: `第${turn}轮的回答` }] } } })
    } else {
      events.push(projectionEvent(seq++))
    }
    events.push({ type: 'turn/end', seq: seq++, data: { turn } })
  }
  const window = projectWorkingWindow(events, 2)
  // 窗口是**连续后缀**：turn 5–7 虽然是空轮（只有投影），但它们比 turn 3–4 更近，
  // 切在本轮边界之外会让 hotStartSeq/boundarySeq 自相矛盾。它们以 0 token 的代价
  // 跟着进来，真正的判据是"窗口里有 2 轮真对话"，不是"窗口里只有 2 个 turn"。
  assert.deepEqual(window.hot.map((s) => s.turn), [3, 4, 5, 6, 7], '窗口应向前补足到 2 轮真实对话')
  assert.equal(window.dialogueTurns, 2)
  assert.equal(window.evicted.length, 2, '只有 turn 1–2 溢出')
  assert.equal(window.projections, 3, '补进来的空轮里那 3 条投影仍被记为"已排除"')
  assert.equal(window.tokens, estimateTokens('第3轮的问题') + estimateTokens('第3轮的回答')
    + estimateTokens('第4轮的问题') + estimateTokens('第4轮的回答'), '空轮不得给窗口加 token')

  // 对照：按 turn 边界切（旧行为）时最后 2 个 turn 都是空轮，窗口里一个字的真对话都没有。
  const spans = projectTurns(events)
  assert.deepEqual(spans.slice(-2).map((s) => s.charCount), [0, 0], '前提：最后两个 turn 确实没有真对话')
  assert.deepEqual(spans.slice(-2).map((s) => s.turn), [6, 7])
  assert.ok(window.hot.reduce((n, s) => n + s.charCount, 0) > 0, '窗口里必须有真对话')
})

test('renderWorkingMemory：排除投影后如实报"最近 N 轮真实对话"与排除条数', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '第一轮问题' }] } },
    projectionEvent(2),
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
    { type: 'turn/start', seq: 4, data: { turn: 2 } },
    { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '第二轮问题' }] } },
    projectionEvent(6),
    projectionEvent(7),
    { type: 'turn/end', seq: 8, data: { turn: 2 } },
  ]
  const window = projectWorkingWindow(events, 2)
  const marker = renderWorkingMemory(window, 'marker')
  assert.ok(marker !== null, 'marker 形态必须有输出')
  assert.match(marker, /最近 2 轮真实对话/)
  // 剪枝后只留一行：投影条数、估算占用、"原文即上方"这三行都不再注入（零信息）。
  assert.doesNotMatch(marker, /投影 \d+ 条已排除/, '变动的投影计数不该进注入')
  assert.doesNotMatch(marker, /估算占用/, '估算占用会被误读成限额，已删')
  assert.doesNotMatch(marker, /该窗口内的对话原文/, '"原文即上方"是同义反复，已删')
  assert.ok(!marker.includes('999'), `不得把投影自身的估算数字带进 L1 块，实际：${marker}`)
  // 可核对的事实仍然在：turn 区间与总轮数必须与窗口同源。
  const first = window.hot[0]
  const last = window.hot[window.hot.length - 1]
  assert.match(marker, new RegExp(`turn ${first.turn}–${last.turn}`))
  assert.match(marker, new RegExp(`共 ${window.totalTurns} 轮`))
})

// ── L1 窗口的"首条投影多算一个 turn"回归（真实 bug）──────────────────────
//
// 真实故障：`agent/pre-step` 跑的时候，本轮用户消息**还没被 append 进事件数组**
// （顺序是 turn/start → step/start → 本钩子 → user/message）。于是本轮在
// `projectTurns` 里是一个空轮，补足循环为了凑满 keep 个"有正文的轮"多往前拉一个
// turn：实测真实会话 11 个 turn（98–104、108、109、111、112）的首条投影写成
// `窗口内 9 个 turn（turn 90–98）`，同轮第二条（消息已落地）才修正成 8 个。

/** 造 n 个"已结束且每轮都有正文"的轮，seq 从 0 开始。 */
function completedTurns(turns, prefix = '轮') {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({ type: 'user/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}${prefix}的问题` }] } })
    events.push({ type: 'turn/end', seq: seq++, data: { turn } })
  }
  return { events, next: seq }
}

test('projectWorkingWindow：当前轮正文未落地时不得多拉一个 turn（首条投影错、次条对的根因）', () => {
  const { events, next } = completedTurns(6)
  // pre-step 时刻的真实形状：当前轮 7 只有 turn/start，用户消息还没写进 events。
  const preStep = [...events, { type: 'turn/start', seq: next, data: { turn: 7 } }]
  assert.equal(projectTurns(preStep).at(-1).charCount, 0, '前提：当前轮在事件数组里确实是空轮')

  // 旧行为（不传 options）：把它当空轮，于是多往前拉一个 turn → 5 个 turn。
  const before = projectWorkingWindow(preStep, 4)
  assert.equal(before.hot.length, 5, '旧行为应复现"窗口内 5 个 turn"（4 个真实轮 + 多拉的一个）')
  assert.deepEqual(before.hot.map((s) => s.turn), [3, 4, 5, 6, 7])
  assert.equal(before.dialogueTurns, 4)

  // 修复后：把当前轮（含载荷里的正文）传进去，窗口只装最近 4 个 turn。
  const after = projectWorkingWindow(preStep, 4, { pendingTurn: 7, pendingText: '第7轮的问题' })
  assert.equal(after.hot.length, 4, '修复后窗口应为 4 个 turn，而不是为了凑数多拉一个')
  assert.deepEqual(after.hot.map((s) => s.turn), [4, 5, 6, 7])
  assert.equal(after.dialogueTurns, 4, '窗口内仍有 4 轮真实对话——不能靠少算一个真实轮来修计数')
  assert.equal(after.evicted.length, 3, '被移出的是真正的第 9/5 个轮（turn 3），它进入 L2')

  // 当前轮的正文必须计入窗口体积，否则修复会变成"少装一轮"。
  const expected = ['第4轮的问题', '第5轮的问题', '第6轮的问题', '第7轮的问题']
    .reduce((n, text) => n + estimateTokens(text), 0)
  assert.equal(after.tokens, expected, 'pending 轮的正文必须算进 tokens')
  assert.equal(after.charCount, '第4轮的问题第5轮的问题第6轮的问题第7轮的问题'.length)
  assert.equal(after.hot.reduce((n, s) => n + s.tokens, 0), after.tokens, 'hot 各轮之和仍须等于 window.tokens')
})

test('projectWorkingWindow：补上的当前轮若事件里已有正文，不重复计数', () => {
  const { events, next } = completedTurns(2)
  const withMessage = [
    ...events,
    { type: 'turn/start', seq: next, data: { turn: 3 } },
    { type: 'user/message', seq: next + 1, data: { content: [{ type: 'text', text: '第三轮的问题' }] } },
  ]
  const plain = projectWorkingWindow(withMessage, 2)
  const withPending = projectWorkingWindow(withMessage, 2, { pendingTurn: 3, pendingText: '第三轮的问题' })
  assert.deepEqual(withPending.hot.map((s) => s.turn), plain.hot.map((s) => s.turn))
  assert.equal(withPending.tokens, plain.tokens, '事件里已有正文时，pending 正文不得再算一遍')
  assert.equal(withPending.charCount, plain.charCount)
})

test('projectWorkingWindow：修复后首条投影与同轮第二条逐字一致（模型看到的边界不再漂移）', () => {
  const { events, next } = completedTurns(6)
  const preStep = [...events, { type: 'turn/start', seq: next, data: { turn: 7 } }]
  // 同一条轮，用户消息落地之后（第二条投影时刻）。
  const afterMessage = [
    ...preStep,
    { type: 'user/message', seq: next + 1, data: { content: [{ type: 'text', text: '第7轮的问题' }] } },
  ]
  const first = renderWorkingMemory(
    projectWorkingWindow(preStep, 4, { pendingTurn: 7, pendingText: '第7轮的问题' }),
    'marker',
  )
  const second = renderWorkingMemory(projectWorkingWindow(afterMessage, 4), 'marker')
  assert.equal(first, second, '首条投影必须与同轮第二条完全一致，包括"窗口内 N 个 turn"这一句')
  assert.doesNotMatch(first, /窗口内 \d+ 个 turn/, '修复后首条不应再出现"窗口内 N 个 turn"的自我修正')
  assert.match(first, /最近 4 轮真实对话（turn 4–7）/)
})

test('pendingWindowInput：从 pre-step 载荷取本轮用户输入，排除投影与非 user 角色', () => {
  const projected = projectionEvent(9)
  const options = pendingWindowInput({
    turn: 8,
    step: 1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '本轮真正的问题' }], source: { kind: 'user' } },
      // 投影是注入物，不是对话：混进来会让"最近 N 轮真实对话"自报数。
      { role: 'user', content: projected.data.content, source: { kind: 'dsh-tri-layer-memory' } },
      { role: 'assistant', content: [{ type: 'text', text: '不算' }] },
    ],
  })
  assert.deepEqual(options, { pendingTurn: 8, pendingText: '本轮真正的问题' })

  // 没有轮号 / 没有用户输入 → 保持旧行为（传错轮号会凭空多算一轮）。
  assert.equal(pendingWindowInput({ messages: [{ role: 'user', content: 'x' }] }), null)
  assert.equal(pendingWindowInput({ turn: 8, messages: [] }), null)
  assert.equal(pendingWindowInput({ turn: 8, messages: [{ role: 'user', content: [] }] }), null)
  assert.equal(pendingWindowInput(null), null)
})

test('contentToText：文本块保留，图片与工具调用折叠为占位符', () => {
  assert.equal(contentToText([{ type: 'text', text: 'hello' }]), 'hello')
  assert.equal(contentToText([{ type: 'image' }]), '[image]')
  assert.equal(contentToText([{ type: 'tool-call', name: 'bash' }]), '[tool-call bash]')
  assert.equal(contentToText('plain'), 'plain')
  assert.equal(contentToText(undefined), '')
})

// ── L3 深层记忆 ──────────────────────────────────────────────────────────

test('extractKeywords：中文二元组 + 英文词，且过滤停用词', () => {
  const keywords = extractKeywords('记忆压缩引擎的 selective forgetting 机制')
  assert.ok(keywords.includes('记忆'))
  assert.ok(keywords.includes('压缩'))
  assert.ok(keywords.includes('selective'))
  assert.ok(!keywords.includes('的'))
})

test('overlap：Jaccard 相似度，空集为 0', () => {
  assert.equal(overlap([], ['a']), 0)
  assert.equal(overlap(['a', 'b'], ['a', 'b']), 1)
  assert.ok(Math.abs(overlap(['a', 'b'], ['b', 'c']) - 1 / 3) < 1e-9)
})

test('scoreRecords：越新分越高；与任务关键词重叠越高分越高', () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000
  const fresh = {
    id: 'fresh', kind: 'turn', createdAt: now, sessionId: 's', turnFrom: 1, turnTo: 1,
    text: '记忆压缩', tokens: 10, keywords: ['记忆', '压缩'], refs: [],
  }
  const stale = { ...fresh, id: 'stale', createdAt: now - 30 * day }
  const scored = scoreRecords([fresh, stale], ['记忆', '压缩'], now)
  const byId = Object.fromEntries(scored.map((s) => [s.record.id, s.score]))
  assert.ok(byId.fresh > byId.stale, '新记录得分应高于 30 天前的同类记录')

  const offTopic = { ...fresh, id: 'off', keywords: ['园艺', '盆栽'] }
  const scored2 = scoreRecords([fresh, offTopic], ['记忆', '压缩'], now)
  const byId2 = Object.fromEntries(scored2.map((s) => [s.record.id, s.score]))
  assert.ok(byId2.fresh > byId2.off, '与任务链相关的记录得分应更高')
})

test('selectPrunable：低于阈值且无人引用的被剪；被引用的根节点保留', () => {
  const now = Date.now()
  const old = now - 90 * 24 * 60 * 60 * 1000
  const root = {
    id: 'root', kind: 'digest', createdAt: old, sessionId: 's', turnFrom: 1, turnTo: 5,
    text: '园艺笔记', tokens: 50, keywords: ['园艺'], refs: [],
  }
  const leaf = {
    id: 'leaf', kind: 'turn', createdAt: old, sessionId: 's', turnFrom: 6, turnTo: 6,
    text: '盆栽记录', tokens: 50, keywords: ['盆栽'], refs: ['root'],
  }
  const orphan = {
    id: 'orphan', kind: 'turn', createdAt: old, sessionId: 's', turnFrom: 7, turnTo: 7,
    text: '无关闲聊', tokens: 50, keywords: ['闲聊'], refs: [],
  }
  const scored = scoreRecords([root, leaf, orphan], ['记忆压缩'], now)
  const drop = selectPrunable(scored, 0.3, 100)
  assert.ok(drop.has('orphan'), '低分且无入边的记录应被剪')
  assert.ok(!drop.has('root'), '被 leaf 引用的根节点不应被剪（否则会扯断引用图）')
})

test('selectPrunable：超过 maxRecords 时继续淘汰低分者', () => {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const records = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`, kind: 'turn', createdAt: now - i * day, sessionId: 's',
    turnFrom: i, turnTo: i, text: `记忆压缩 ${i}`, tokens: 10, keywords: ['记忆', '压缩'], refs: [],
  }))
  const scored = scoreRecords(records, ['记忆', '压缩'], now)
  const drop = selectPrunable(scored, 0, 4)
  assert.equal(drop.size, 6)
  // 留下的必须是分数最高的那几个（即最新的）。
  const kept = records.filter((r) => !drop.has(r.id)).map((r) => r.id)
  assert.deepEqual(kept, ['r0', 'r1', 'r2', 'r3'])
})

test('DeepMemoryStore：JSONL 落盘 → 重新打开可读回，检索命中关键词', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-test-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    return store.open().then((kind) => {
      assert.equal(kind, 'jsonl')
      store.put({ kind: 'turn', sessionId: 's1', turnFrom: 1, turnTo: 1, text: '正则表达式三遍都没匹配上' })
      store.put({ kind: 'digest', sessionId: 's1', turnFrom: 2, turnTo: 5, text: '完成了插件脚手架搭建' })
      assert.equal(store.size, 2)
      assert.ok(existsSync(join(dir, 'deep-memory.jsonl')))
      assert.equal(readFileSync(join(dir, 'deep-memory.jsonl'), 'utf8').trim().split('\n').length, 2)

      const hits = store.search('正则', 5)
      assert.equal(hits.length, 1)
      assert.match(hits[0].text, /正则表达式/)
      assert.equal(store.search('不存在的词xyzzy', 5).length, 0)

      // 重开：数据必须还在。
      const reopened = new DeepMemoryStore(dir, 'jsonl')
      return reopened.open().then(() => {
        assert.equal(reopened.size, 2)
        assert.ok(reopened.get(hits[0].id))
        const stats = reopened.stats()
        assert.equal(stats.count, 2)
        assert.ok(stats.tokens > 0)
        reopened.close()
      })
    })
  } finally {
    // 注意：不在此处删除目录——上面的 promise 链还没跑完。由下面的用例清理。
  }
})

test('DeepMemoryStore：prune 会真正删记录并重写文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-prune-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    const old = Date.now() - 120 * 24 * 60 * 60 * 1000
    for (let i = 0; i < 6; i += 1) {
      store.put({ kind: 'turn', sessionId: 's', turnFrom: i, turnTo: i, text: `无关旧内容 ${i}`, createdAt: old })
    }
    const outcome = store.prune(['记忆压缩'], 0.5, 100, Date.now())
    assert.ok(outcome.removed.length > 0, '陈旧且与任务无关的记录应被剪掉')
    assert.equal(store.size, outcome.after)
    const reopened = new DeepMemoryStore(dir, 'jsonl')
    await reopened.open()
    assert.equal(reopened.size, store.size, '剪枝结果必须落盘')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DeepMemoryStore：maxTurnTo 从库里推出水位（重启后不再重蒸的依据）', async () => {
  // 真实故障：水位只活在内存里，进程一重启就归零，于是同一轮被反复蒸馏。
  // 修法是从库里推最大轮号——所以这个读数必须有测试，否则"水位持久化"没有观察面。
  const dir = mkdtempSync(join(tmpdir(), 'tlm-watermark-'))
  try {
    const store = new DeepMemoryStore(dir, 'jsonl')
    await store.open()
    assert.equal(store.maxTurnTo('s-1'), -1, '空库的初值必须是 -1（= 一轮都没蒸过）')
    store.put({ kind: 'turn', sessionId: 's-1', turnFrom: 1, turnTo: 1, text: '第一轮' })
    store.put({ kind: 'turn', sessionId: 's-1', turnFrom: 2, turnTo: 2, text: '第二轮' })
    store.put({ kind: 'turn', sessionId: 's-1', turnFrom: 7, turnTo: 7, text: '第七轮' })
    store.put({ kind: 'turn', sessionId: 's-2', turnFrom: 9, turnTo: 9, text: '别的会话第九轮' })
    store.put({ kind: 'digest', sessionId: 's-1', turnFrom: 1, turnTo: 8, text: '摘要' })
    assert.equal(store.maxTurnTo('s-1'), 7, '只看本会话的 turn 记录（digest 的 turnTo=8 不算）')
    assert.equal(store.maxTurnTo('s-2'), 9, '别的会话各算各的')
    assert.equal(store.maxTurnTo('s-1', 'digest'), 8, '类别可选，便于核对')
    store.close()

    // 重新打开（= 进程重启）后读数不变：这是"能从库推出水位"的全部意义。
    const reopened = new DeepMemoryStore(dir, 'jsonl')
    await reopened.open()
    assert.equal(reopened.maxTurnTo('s-1'), 7, '重启后仍能推出同一水位')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── L2 短期记忆（纯渲染部分）─────────────────────────────────────────────

test('extractiveDigest：保留用户诉求首行与工具清单，0 模型调用', () => {
  const spans = projectTurns(syntheticEvents(3))
  const digest = extractiveDigest(spans)
  assert.match(digest, /任务主线/)
  assert.match(digest, /第1轮的用户请求/)
  assert.match(digest, /read_file/)
  assert.match(digest, /未决问题/)
})

test('renderTurnsForSummary：逐轮截断，超长正文不会整体灌进摘要输入', () => {
  const spans = projectTurns(syntheticEvents(2))
  const text = renderTurnsForSummary(spans, 20)
  assert.match(text, /### turn 1/)
  assert.match(text, /\[user\]/)
  // 工具结果正文（200 个 x）不参与摘要输入：渲染只取 user/assistant 文本。
  assert.doesNotMatch(text, /x{50}/)
})

test('renderShortTermMemory：只报覆盖区间与欠账轮数（生成方式/压缩比/0 欠账已删）', () => {
  assert.match(renderShortTermMemory(null, 5), /尚无摘要.*5 轮/s)
  // "已有 0 轮溢出"是恒定的"一切正常"，对模型没有行动价值，不该占一行。
  assert.doesNotMatch(renderShortTermMemory(null, 0), /0 轮/)
  const text = renderShortTermMemory({
    text: '## 任务主线\n- 建插件', via: 'extractive',
    turnFrom: 1, turnTo: 6, tokens: 10, sourceTokens: 100, createdAt: Date.now(),
  }, 0)
  assert.match(text, /覆盖 turn 1–6/)
  assert.doesNotMatch(text, /extractive|压缩比|10x/, '摘要的生成方式与压缩比是给人看的元信息，不进注入')
  assert.doesNotMatch(text, /待摘要的溢出轮：0/)
  // 真有欠账时才报——那是"有一段内容不在任何摘要里"的唯一提示。
  assert.match(renderShortTermMemory({
    text: '摘要', via: 'llm', turnFrom: 1, turnTo: 6, tokens: 10, sourceTokens: 100, createdAt: Date.now(),
  }, 2), /待摘要的溢出轮：2/)
})

test('resolveTarget：优先会话最近路由，退到 agent options，都没有则 undefined', () => {
  assert.deepEqual(
    resolveTarget({ session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} }),
    { provider: 'p', model: 'm' },
  )
  assert.deepEqual(
    resolveTarget({ session: { requestHeader: () => undefined }, options: { provider: 'p2', model: 'm2' } }),
    { provider: 'p2', model: 'm2' },
  )
  assert.equal(resolveTarget({ session: {}, options: {} }), undefined)
  assert.equal(resolveTarget(null), undefined)
})

// ── 注入预算仲裁 ─────────────────────────────────────────────────────────

test('arbitrateInjection：预算充足时全部保留，顺序仍是 L1→L2→L3', () => {
  const blocks = [
    { id: 'l3', text: 'L3 索引内容', priority: 2, truncatable: true },
    { id: 'l1', text: 'L1 标记', priority: 0, truncatable: false },
    { id: 'l2', text: 'L2 摘要内容', priority: 1, truncatable: true },
  ]
  const result = arbitrateInjection(blocks, 10000)
  assert.deepEqual(result.kept.map((b) => b.id), ['l1', 'l2', 'l3'])
  assert.deepEqual(result.dropped, [])
  assert.deepEqual(result.truncated, [])
  assert.ok(result.tokens > 0)
  assert.equal(result.requestedTokens, result.tokens)
})

test('arbitrateInjection：预算紧张时按优先级丢低优先级的块', () => {
  const big = 'x'.repeat(4000) // ≈1000 tokens
  const blocks = [
    { id: 'l1', text: 'L1 标记', priority: 0, truncatable: false },
    { id: 'l2', text: big, priority: 1, truncatable: false },
    { id: 'l3', text: big, priority: 2, truncatable: false },
  ]
  const result = arbitrateInjection(blocks, 1100)
  // L1 与 L2 放得下；L3 被丢弃，且必须继续尝试而不是提前中止。
  assert.deepEqual(result.kept.map((b) => b.id), ['l1', 'l2'])
  assert.deepEqual(result.dropped, ['l3'])
  assert.ok(result.tokens <= 1100, `不得超预算，实际 ${result.tokens}`)
})

test('arbitrateInjection：可截断的块在剩余空间足够时被截断而非丢弃', () => {
  const blocks = [
    { id: 'l1', text: 'L1 标记', priority: 0, truncatable: false },
    // L2 用自己那条更短的截断说明（真实接线就是这样，见 index.ts 的 l2 候选）。
    { id: 'l2', text: 'y'.repeat(4000), priority: 1, truncatable: true, truncationNote: L2_TRUNCATION_NOTE },
  ]
  const result = arbitrateInjection(blocks, 300)
  assert.deepEqual(result.kept.map((b) => b.id), ['l1', 'l2'], 'L2 应被保留（截断）')
  assert.deepEqual(result.truncated, ['l2'])
  assert.deepEqual(result.dropped, [])
  assert.match(result.kept[1].text, /被截断|截断/)
  // 收尾说明必须点名**走得到的**取回路径：L2 摘要的正文不在 L3 里，只有
  // `memory_recall({ includeDigest: true })` 才拿得到；只说"可用 recall 取回"
  // 等于给了一条走不通的路（模型会召回一堆 L3 记录，却永远缺被截断的那段摘要）。
  assert.match(result.kept[1].text, /includeDigest/, '截断说明要写明 L2 摘要的取回方式')
  assert.ok(result.tokens <= 300, `截断后不得超预算，实际 ${result.tokens}`)
})

test('arbitrateInjection：没给 truncationNote 的块用默认说明（L3 索引走这条）', () => {
  const blocks = [
    { id: 'l1', text: 'L1 标记', priority: 0, truncatable: false },
    { id: 'l3', text: 'w'.repeat(4000), priority: 2, truncatable: true },
  ]
  const result = arbitrateInjection(blocks, 300)
  assert.deepEqual(result.truncated, ['l3'])
  assert.match(result.kept[1].text, /本块因注入预算被截断/, '默认说明要说明"为什么被截断"')
  assert.doesNotMatch(result.kept[1].text, /includeDigest/, '默认说明不该把 L2 专有的取回方式写给 L3')
})

test('arbitrateInjection：truncatable=false 的块要么整块保留要么整块丢弃', () => {
  const blocks = [{ id: 'l1', text: 'z'.repeat(4000), priority: 0, truncatable: false }]
  const result = arbitrateInjection(blocks, 100)
  assert.deepEqual(result.kept, [])
  assert.deepEqual(result.dropped, ['l1'], '不可截断且放不下 → 丢弃，绝不切一半')
})

test('arbitrateInjection：预算为 0 时不保留任何块，且不抛错', () => {
  const result = arbitrateInjection([{ id: 'l1', text: '标记', priority: 0, truncatable: true }], 0)
  assert.deepEqual(result.kept, [])
  assert.equal(result.tokens, 0)
  assert.equal(result.budgetTokens, 0)
})

test('arbitrateInjection：剩余空间太小（低于最小截断长度）时丢弃而不是留个碎片', () => {
  const blocks = [
    { id: 'l1', text: 'a'.repeat(400), priority: 0, truncatable: false }, // ≈100 tokens
    { id: 'l2', text: 'b'.repeat(4000), priority: 1, truncatable: true },
  ]
  const result = arbitrateInjection(blocks, 101) // 只剩约 1 token 给 L2
  assert.deepEqual(result.kept.map((b) => b.id), ['l1'])
  assert.deepEqual(result.dropped, ['l2'])
})

// ── 配置 ─────────────────────────────────────────────────────────────────

test('resolveConfig：缺省补齐、越界钳制、枚举回落', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULTS)
  const resolved = resolveConfig({
    l1RetainTurns: 999,          // 超过上限 64
    l2Mode: '不存在的模式',       // 枚举回落
    l3PruneMinScore: 5,          // 夹到 1
    l2MaxSummaryTokens: -10,     // 夹到下限 128
    l3Dir: '  C:\\tmp\\x  ',     // 去空白
  })
  assert.equal(resolved.l1RetainTurns, 64)
  assert.equal(resolved.l2Mode, DEFAULTS.l2Mode)
  assert.equal(resolved.l3PruneMinScore, 1)
  assert.equal(resolved.l2MaxSummaryTokens, 128)
  assert.equal(resolved.l3Dir, 'C:\\tmp\\x')
})

test('resolveConfig：非对象输入不抛错，退回默认', () => {
  assert.deepEqual(resolveConfig('nonsense'), DEFAULTS)
  assert.deepEqual(resolveConfig(null), DEFAULTS)
})

test('defaultStorageDir：显式配置优先，其次 $DSH_HOME，绝不返回相对路径', () => {
  assert.equal(defaultStorageDir('D:\\explicit\\dir'), 'D:\\explicit\\dir')
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'D:\\fake-dsh-home'
    assert.equal(defaultStorageDir(''), join('D:\\fake-dsh-home', 'tri-layer-memory'))
    delete process.env.DSH_HOME
    const fallback = defaultStorageDir('')
    assert.ok(fallback.length > 0)
    assert.ok(/^[A-Za-z]:[\\/]|^\//.test(fallback), `应为绝对路径，实际 ${fallback}`)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('MEMORY_NAMESPACE：必须是 kebab-case 的合法 settings namespace', () => {
  assert.equal(MEMORY_NAMESPACE, 'tri-layer-memory')
  assert.match(MEMORY_NAMESPACE, /^[a-z][a-z0-9-]*$/)
})
