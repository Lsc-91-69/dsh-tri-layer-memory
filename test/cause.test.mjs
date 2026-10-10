/**
 * test/cause.test.mjs — 里程碑 `cause`（因果）补全的行为测试。
 *
 * 骨架的 `cause` 原本是确定性标签（`未解决` / `验证通过` / `会话初始任务`）——它回答
 * "成没成"，不回答"为什么"。这一节测的是补上"为什么"的那条**独立、节流、可降级**的
 * 模型调用：什么时候发、发什么、拿回垃圾怎么办、回填到哪几个地方。
 *
 * 覆盖的失败模式都是"记忆层拖垮对话"那一类，因此断言的重点不只是"补上了"，
 * 还有**没补上时什么都没坏**：无服务不抛错、垃圾回复不崩、超时不阻塞、
 * 节流与总开关真的拦得住请求。
 *
 * ⚠ fixture 用真实事件形状：`user/message` 的正文在 `data.content`，
 * `assistant/message` 与 `tool/result` 的正文在 `data.message.content`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/host/index.ts'
import { DEFAULTS, resolveConfig } from '../src/host/config-core.ts'
import {
  CAUSE_CHARS,
  CAUSE_ERROR_ONLY_NOTE,
  CAUSE_EXCERPT_CHARS,
  CAUSE_EXCERPT_MAX,
  CAUSE_INSTRUCTION,
  applyCauses,
  attachCauses,
  causeExcerpt,
  extractMilestones,
  missingCauses,
  parseCauseReply,
  renderCauseRequest,
  titleReportsFailure,
} from '../src/host/milestones.ts'

// ── 夹具 ─────────────────────────────────────────────────────────────────

/**
 * 造一段合成会话：每轮 user + assistant + 一次"自检通过"的 pwsh 调用。
 *
 * 每轮恰好产出一条逐轮里程碑（有验证通过 → 过得了 `worth` 闸门），
 * 加上一条会话初始任务 = `turns + 1` 条。轮数因此可以精确控制"缺 cause 的条数"，
 * 这正是节流测试要的东西。
 *
 * @param turns - 轮数。
 * @returns 事件数组。
 */
function sessionEvents(turns) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({
      type: 'user/message',
      seq: seq++,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮：请处理记忆压缩任务，保留关键决策与因果` }] },
    })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮的结论：三层接线已完成，没有遗留问题。` }] } },
    })
    const callId = `call-${turn}`
    events.push({ type: 'tool/call', seq: seq++, data: { turn, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ description: `第${turn}轮自检` }) } })
    events.push({
      type: 'tool/result',
      seq: seq++,
      data: {
        turn,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: callId,
          // 长度必须过 40 字符，否则不算一次"验证通过"，这一轮就不产里程碑。
          content: [{ type: 'text', text: `第${turn}轮：全部通过（ok）PASS——三层接线自检完成，无遗留问题，可以继续下一步，不需要人工介入。` }],
        },
      },
    })
    events.push({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

/** 确定性标签：无 LLM 或补全失败时，骨架必须仍然是这两句之一。 */
const DETERMINISTIC = /— (?:会话初始任务|验证通过)/

/** 假 seam 的回复文本（`i` 从 1 开始，与请求里的序号一致）。 */
const stubCause = (i) => `桩原因${i}：测试回填`

/** 造一个假的 `ctx.llm` seam，记录每次请求；`respond` 决定回什么。 */
function fakeLlm(respond) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const reply = respond(options, calls.length)
      return (async function* () {
        // 直接抛错模拟"服务在流中途失败"。
        if (reply instanceof Error) throw reply
        yield { type: 'text-delta', index: 0, text: String(reply ?? '') }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * 造一个能精确控制**终止原因**的假 seam（`fakeLlm` 只会以 `stop` 收尾）。
 *
 * 需要它才能测出本次修复的核心分支：`max-tokens` 时"正文非空 → 宽容解析继续用"
 * 与"正文为空 → 才算失败"。`fakeLlm` 表达不了这两种形态。
 *
 * @param respond - `(options, callIndex) => {text?, kind?, failure?, usage?}`。
 * @returns 带 `calls` 的 seam。
 */
function fakeLlmWithFinish(respond) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const spec = respond(options, calls.length) ?? {}
      return (async function* () {
        const text = String(spec.text ?? '')
        if (text.length > 0) yield { type: 'text-delta', index: 0, text }
        // usage 是**独立的块类型**（TextAssembler 只在 `case 'usage'` 里收它），
        // 塞进 finish 的 reason 里会被静默忽略——那正是"读数看起来有、实际是空的"。
        if (spec.usage !== undefined) yield { type: 'usage', usage: spec.usage }
        yield {
          type: 'finish',
          reason: {
            kind: spec.kind ?? 'stop',
            ...(spec.failure === undefined ? {} : { failure: spec.failure }),
          },
        }
      })()
    },
  }
}

/** 默认回复：给请求里出现的每个序号补一句桩原因。 */
function replyAll(options) {
  const body = options?.messages?.[0]?.content?.[0]?.text ?? ''
  const out = {}
  for (const m of body.matchAll(/^(\d+)\. 第/gm)) out[m[1]] = stubCause(m[1])
  return JSON.stringify(out)
}

/** 造一个最小可用的 Host ctx（只实现 apply() 真正会碰的成员）。 */
function mockContext(services = {}) {
  const listeners = new Map()
  const tools = []
  const available = {
    tools: { register(tool) { tools.push(tool); return () => {} }, schemas() { return tools.map((t) => ({ name: t.name })) } },
    ...services,
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    // 真实 cordis 的 effect(fn) 会立即调用 fn，并把返回值当 disposer。
    effect(fn) { fn() },
    inject(deps, callback) {
      if (!deps.every((d) => available[d] !== undefined)) return
      const child = Object.create(ctx)
      for (const d of deps) child[d] = available[d]
      callback(child)
    },
    get(name) { return available[name] },
    ...available,
  }
  return { ctx, listeners, tools }
}

/** 让 apply() 里 fire-and-forget 的 store.open() 跑完。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * 挂载一次插件并返回推进函数。
 *
 * `agent.options` 必须给：`resolveTarget` 从这里解析 provider/model，缺了就等同于
 * "没有可用的模型路由"，补全路径会静默跳过（那会掩盖真正的失败）。
 */
function harness(config, services) {
  const { ctx, listeners, tools } = mockContext(services)
  apply(ctx, { l2Mode: 'extractive', selfTestAfterBoot: false, ...config })
  const entry = listeners.get('agent/pre-step')[0]
  assert.ok(entry !== undefined, 'pre-step 监听必须注册')
  const step = (session) => entry.listener(
    {
      agent: { session, options: { provider: 'test-provider', model: 'test-model' } },
      turn: 1,
      step: 1,
      signal: { aborted: false },
    },
    async () => ({ kind: 'enter', messages: [] }),
  )
  // 已注册的工具对象一并给出：诊断面就在它们身上，而"cause 回填到底发出了什么、
  // 拿到了什么"只有 memory_state 能看到（宿主日志在桌面端不可见）。
  return { step, tools }
}

/** 调一次 memory_state，拿回它的结构化输出（cause 侧诊断面的唯一出口）。 */
async function stateOf(harnessed, session) {
  const tool = harnessed.tools.find((t) => t.name === 'memory_state')
  assert.ok(tool !== undefined, 'memory_state 必须已注册')
  return tool.execute({}, { agent: { session } })
}

/** 取出 decision 里的投影文本（未注入时为空串）。 */
const textOf = (decision) => decision?.messages?.[0]?.content?.[0]?.text ?? ''

/** 从投影里切出骨架块。 */
function skeletonOf(text) {
  return text.split('\n\n').find((part) => part.includes('## 里程碑主线骨架')) ?? ''
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

/** 在临时目录里跑一段会话，返回该目录、假 seam 与投影。 */
async function run({ turns = 3, config = {}, respond = replyAll, services, llm: injected } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-cause-'))
  const llm = injected ?? fakeLlm(respond)
  const session = { id: 's-cause', events: sessionEvents(turns) }
  const harnessed = harness({ l3Dir: dir, l3Store: 'jsonl', ...config }, { llm, ...services })
  await tick()
  const decision = await harnessed.step(session)
  return {
    dir,
    llm,
    decision,
    text: textOf(decision),
    events: session.events,
    step: harnessed.step,
    session,
    tools: harnessed.tools,
    /** 本会话的 memory_state 输出（诊断面的唯一出口）。 */
    state: () => stateOf(harnessed, session),
  }
}

// ── 配置键：默认值、钳制、面板 schema 的口径 ─────────────────────────────

test('配置键：默认值 + 越界钳制（1–50 / 1–100）', () => {
  assert.equal(DEFAULTS.mainlineCauseEnabled, true, '默认开着（因果是骨架的另一半）')
  assert.equal(DEFAULTS.mainlineCauseMinBatch, 3)
  assert.equal(DEFAULTS.mainlineCauseMaxPerCall, 20)

  const low = resolveConfig({ mainlineCauseMinBatch: 0, mainlineCauseMaxPerCall: -5 })
  assert.equal(low.mainlineCauseMinBatch, 1, '下限 1')
  assert.equal(low.mainlineCauseMaxPerCall, 1, '下限 1')

  const high = resolveConfig({ mainlineCauseMinBatch: 999, mainlineCauseMaxPerCall: 9999 })
  assert.equal(high.mainlineCauseMinBatch, 50, '上限 50')
  assert.equal(high.mainlineCauseMaxPerCall, 100, '上限 100')

  const off = resolveConfig({ mainlineCauseEnabled: false })
  assert.equal(off.mainlineCauseEnabled, false)
  assert.equal(resolveConfig({ mainlineCauseEnabled: 'yes' }).mainlineCauseEnabled, true, '非布尔值回落默认')
})

test('配置键 mainlineCauseExcerptChars：默认 200 / 范围 0–500 / 0 不被当成"没配"', () => {
  assert.equal(DEFAULTS.mainlineCauseExcerptChars, 200)
  assert.equal(DEFAULTS.mainlineCauseExcerptChars, CAUSE_EXCERPT_CHARS, '默认值与渲染器共用同一个常量')
  assert.equal(CAUSE_EXCERPT_MAX, 500)

  // 0 是**有效值**而不是"未设置"：它是"只发标题"的退路，绝不能被钳到默认值上去。
  assert.equal(resolveConfig({ mainlineCauseExcerptChars: 0 }).mainlineCauseExcerptChars, 0,
    '0 必须原样保留（省 token 的退路）')
  assert.equal(resolveConfig({ mainlineCauseExcerptChars: -1 }).mainlineCauseExcerptChars, 0, '下限 0')
  assert.equal(resolveConfig({ mainlineCauseExcerptChars: 9999 }).mainlineCauseExcerptChars, 500, '上限 500')
  assert.equal(resolveConfig({ mainlineCauseExcerptChars: 'nonsense' }).mainlineCauseExcerptChars, 200,
    '非数值回落默认（不是 0：那是"用户主动关掉"，不该由垃圾值触发）')
})

test('默认摘录长度必须是"一条完整失败行装得下"的量级（120 不够，实测 8/25）', () => {
  // 这条断言守的是**取值依据**而不是那个数字本身：真实会话的 25 行 [失败] 里，
  // 每行形如 `[失败] {tool} {报错正文}`，剥掉工具自述后正文中位约 146 码点。
  // 120 只能完整装下 8 行，200 能装下 25 行——所以默认值必须 ≥160 这条线。
  assert.ok(CAUSE_EXCERPT_CHARS >= 160,
    `默认值 ${CAUSE_EXCERPT_CHARS} 太小：实测 120 下只有 8/25 条失败原文能完整进摘录`)
  // 上限也要够：不能出现"默认值被自己的上限夹住"这种自相矛盾的状态。
  assert.ok(CAUSE_EXCERPT_MAX >= CAUSE_EXCERPT_CHARS, '默认值不得超过钳制上限')
})

// ── cause 路径的推理档位：与 L2 摘要同一条 seam、同一个档位、同一条退路 ──────
//
// 这一节守的是一次**静默失效**：cause 回填曾经是自己实现的那条路，于是它没有带
// `reasoningEffort`。宿主路由是推理模型、推理与正文共享 `max_tokens`，4096 的输出
// 预算被推理吃光，回复 0 字符、`parseCauseReply` 一条都认不出来，整批因果静默失效。
// 诊断里只有 `cause reply carried no parsable entries (0 chars)`——看不出是推理吃光了
// 预算还是模型没说话。所以这里既测"档位真的发出去了"，也测"读数真的记下来了"。

test('cause 调用必须带 internalCallReasoningEffort（漏掉它就是 0 字符静默失效）', async () => {
  const { dir, llm, text, state } = await run({ turns: 3 })
  try {
    assert.equal(llm.calls.length, 1, '3 轮 = 4 条里程碑，够 mainlineCauseMinBatch 触发一次')
    assert.equal(llm.calls[0].reasoningEffort, DEFAULTS.internalCallReasoningEffort,
      '默认必须带 low：不指定时走网关默认（很贵），推理会把输出预算吃光')
    assert.equal(llm.calls[0].maxTokens, 4096, '输出上限是"推理 + 正文"的总闸门')

    const status = await state()
    const attempt = status.mainline.causeAttempt
    assert.ok(attempt, 'memory_state 必须带 cause 的调用读数（否则失效时无从定性）')
    assert.equal(attempt.reasoningEffort, DEFAULTS.internalCallReasoningEffort)
    assert.equal(attempt.effortRetry, false)
    assert.equal(attempt.finish, 'stop')
    assert.equal(attempt.salvaged, false)
    assert.ok(attempt.outputChars > 0, '正文必须非空（这就是"这次真的拿到东西了"的证据）')
    assert.equal(attempt.maxTokens, 4096)
    assert.ok(attempt.inputChars > 0, '请求正文规模必须记下来')
    assert.match(text, /— 桩原因/, '读数记下来不算完：因果必须真的回填进骨架')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('档位被拒（UNSUPPORTED_REASONING_EFFORT）：cause 去掉字段重试一次，不让因果永久失去模型', async () => {
  const llm = fakeLlmWithFinish((options, index) => {
    if (index === 1) {
      return {
        kind: 'error',
        failure: {
          message: 'pi-ai provider "test-provider" model "test-model" does not support reasoning effort "low"',
          code: 'UNSUPPORTED_REASONING_EFFORT',
        },
      }
    }
    const out = {}
    for (const m of (options?.messages?.[0]?.content?.[0]?.text ?? '').matchAll(/^(\d+)\. 第/gm)) out[m[1]] = stubCause(m[1])
    return { text: JSON.stringify(out) }
  })
  const { dir, text, state } = await run({ turns: 3, llm })
  try {
    assert.equal(llm.calls.length, 2, '第一次被拒后必须重试一次')
    assert.equal(llm.calls[0].reasoningEffort, DEFAULTS.internalCallReasoningEffort)
    assert.equal('reasoningEffort' in llm.calls[1], false, '重试必须去掉该字段')

    const attempt = (await state()).mainline.causeAttempt
    assert.equal(attempt.effortRetry, true)
    assert.equal(attempt.reasoningEffort, DEFAULTS.internalCallReasoningEffort,
      '记的是"想要哪一档"，不是"最终发了什么"——否则诊断里看不出重试发生过')
    assert.match(attempt.firstFailure, /does not support reasoning effort/)
    assert.equal(attempt.finish, 'stop', '重试后的那次才是最终结果')
    assert.match(text, /— 桩原因/, '重试成功后因果照常回填')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cause 撞 max-tokens 但正文非空：宽容解析继续用（截断的 JSON 前几对键值仍完整）', async () => {
  // 平台自己的约定：max-tokens 时保留 text 块，只丢无法安全执行的工具调用
  // （dsh-llm 的 assembler）。整批作废与平台相反，也会白白丢掉已经拿到的因果。
  const llm = fakeLlmWithFinish(() => ({
    text: '{"1":"首条完整","2":"第二条完整","3":"第三条被截',
    kind: 'max-tokens',
    usage: { inputTokens: 900, outputTokens: 4096, totalTokens: 4996 },
  }))
  const { dir, text, state } = await run({ turns: 3, llm })
  try {
    const status = await state()
    const attempt = status.mainline.causeAttempt
    assert.equal(attempt.finish, 'max-tokens')
    assert.equal(attempt.salvaged, true, '撞上限但正文非空 = 救回来了，不是失败')
    assert.equal(attempt.outputChars, 34, '记的是**丢弃前**的正文字符数')
    assert.deepEqual(attempt.usage, { inputTokens: 900, outputTokens: 4096, totalTokens: 4996 })
    // 关键：被截断的那份回复仍然解析出了前两条，而不是整批作废。
    assert.equal(status.mainline.causeFailure, null, '解析出了条目就不是失败')
    assert.match(text, /— 首条完整/)
    assert.match(text, /— 第二条完整/)
    assert.doesNotMatch(text, /第三条被截/, '被截断的半条不能进骨架')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cause 撞 max-tokens 且正文为空：这才算失败，且消息里必须能读出 finish 与字符数', async () => {
  // 真实观测的形状：推理把 4096 的预算吃光，一个正文字符都没剩。
  const llm = fakeLlmWithFinish(() => ({ kind: 'max-tokens' }))
  const { dir, text, state } = await run({ turns: 3, llm })
  try {
    const status = await state()
    const attempt = status.mainline.causeAttempt
    assert.equal(attempt.finish, 'max-tokens')
    assert.equal(attempt.outputChars, 0, '0 字符是"推理吃光预算"的判据')
    assert.equal(attempt.salvaged, false, '正文为空时没有任何可用内容')
    assert.equal(status.mainline.causeFailure?.stage, 'llm-error')
    assert.match(status.mainline.causeFailure.message, /no parsable entries/)
    assert.match(status.mainline.causeFailure.message, /0 chars/)
    assert.match(status.mainline.causeFailure.message, /finish=max-tokens/,
      'finish 必须进消息：0 字符 + max-tokens（推理吃光）与 0 字符 + stop（模型没说话）修法不同')
    // 失败也必须**什么都没坏**：骨架退回确定性标签，照常注入。
    assert.match(text, DETERMINISTIC)
    assert.doesNotMatch(text, /桩原因/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cause 读数的落点：memory_state 与诊断文件都必须带上 causeAttempt', async () => {
  const { dir, state } = await run({ turns: 3 })
  try {
    const status = await state()
    assert.ok(status.mainline.causeAttempt, 'memory_state 的 mainline 段必须带 causeAttempt')
    for (const key of ['finish', 'maxTokens', 'inputChars', 'outputChars', 'salvaged', 'reasoningEffort', 'effortRetry']) {
      assert.ok(key in status.mainline.causeAttempt, `读数缺 ${key}：观察面就少了这个维度`)
    }
    // 诊断文件是另一个落点（桌面端宿主日志不可见，这两个面是唯一可靠的出口）。
    const file = join(dir, 's-cause.diagnostics.json')
    assert.ok(existsSync(file), '诊断文件必须落盘（按会话分文件）')
    const diagnostics = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(diagnostics.mainline.causeAttempt, '诊断文件的 mainline 段同样必须带 causeAttempt')
    assert.equal(diagnostics.mainline.causeAttempt.finish, 'stop')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 提取口径：夹具本身的可预测性 ─────────────────────────────────────────

test('夹具口径：每轮一条 + 一条会话初始任务', () => {
  assert.equal(extractMilestones(sessionEvents(1)).length, 2, '1 轮 = 任务 + 1 条逐轮')
  assert.equal(extractMilestones(sessionEvents(3)).length, 4, '3 轮 = 任务 + 3 条逐轮')
  // 缺省 mainlineCauseMinBatch = 3：1 轮的两条**不足以**触发调用，3 轮的四条足够。
})

// ── 纯函数：请求渲染、宽容解析、回填 ─────────────────────────────────────

test('renderCauseRequest：序号/轮次/标题 + detail 摘录（默认 120 字）', () => {
  const milestones = [
    { turn: 22, title: '状态确认了：profile patch 里没有 compaction 覆盖', cause: '未解决', detail: '这里是几百字的用户原话与报错原文', category: '失败', tokens: 0 },
    { turn: 43, turnTo: 44, title: '音频非常奇怪，完全听不懂，但是有声音', cause: '同一诉求连续 2 轮排查未解决', detail: '同样是长正文', category: '指令', tokens: 0 },
  ]
  const slots = missingCauses(milestones, new Map())
  assert.deepEqual(slots.map((s) => s.index), [1, 2], '缺 cause 的按骨架顺序给出序号')

  const body = renderCauseRequest(slots)
  assert.match(body, /^1\. 第 22 轮｜状态确认了/, '行首是完整骨架里的序号')
  assert.match(body, /^2\. 第 43–44 轮｜音频非常奇怪/m, '跨轮条目用区间')
  // ⚠ 这条断言被**改过**：旧版是"detail 绝不进请求（省 token 的全部意义就在这里）"。
  // 它守的是旧行为，而旧行为正是要修的质量缺陷——模型手里没有证据，只能从标题猜因果，
  // 信息不够时不会说"不知道"，而是编一个听起来合理的原因（真实观测：第 1 轮的真实原因
  // 是"用户提出任务"，却被写成"插件机制未初始化"）。现在默认带摘录，旧行为改由
  // excerptChars=0 这条退路保证（下面的断言）。
  assert.match(body, /｜摘录：这里是几百字的用户原话与报错原文$/m, 'detail 摘录必须进请求（模型判断因果的证据）')
  assert.match(body, /^2\..*｜摘录：同样是长正文$/m)

  const old = renderCauseRequest(slots, 0)
  assert.equal(
    old,
    '1. 第 22 轮｜状态确认了：profile patch 里没有 compaction 覆盖\n'
    + '2. 第 43–44 轮｜音频非常奇怪，完全听不懂，但是有声音',
    'excerptChars=0 必须逐字退回旧行为（连分隔符都不留）',
  )
  assert.doesNotMatch(old, /用户原话/, '0 = 省 token 的退路：detail 一个字都不进请求')
})

test('renderCauseRequest：摘录按字符截断并加省略号，且不切断代理对（emoji）', () => {
  const slot = (detail) => ([
    { index: 1, milestone: { turn: 7, title: '标题', cause: '未解决', detail, category: '失败', tokens: 0 } },
  ])
  const excerptOf = (body) => body.split('｜摘录：')[1]

  // 短 detail：原样进请求，不加省略号。
  const short = excerptOf(renderCauseRequest(slot('用户说要修因果'), 120))
  assert.equal(short, '用户说要修因果', '没到上限就不许截断（省略号会让人以为后面还有）')

  // 长 detail：截到上限 + 一个省略号。
  const long = excerptOf(renderCauseRequest(slot('字'.repeat(300)), 20))
  assert.equal(long, `${'字'.repeat(20)}…`, `截断点必须恰好在上限处，实际 ${long}`)

  // emoji：按**码点**切，绝不能留下半个代理对（那会变成 \uD83D 这类乱码进请求）。
  const emoji = excerptOf(renderCauseRequest(slot('😀'.repeat(200)), 20))
  assert.equal([...emoji].length, 21, '20 个 emoji + 省略号（按码点算）')
  assert.equal((emoji.match(/😀/gu) ?? []).length, 20, 'emoji 一个都不许被切一半')
  assert.equal(emoji.length, 41, 'UTF-16 长度 = 20×2 + 1：没有半个代理对')
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    '摘录里不得出现孤立代理项')

  // 上限与 0 的边界：负数/NaN 一律当"不摘录"（不能退化成只有省略号）。
  assert.equal(excerptOf(renderCauseRequest(slot('正文'), -5)), undefined, '负数 = 不摘录')
  assert.equal(excerptOf(renderCauseRequest(slot('正文'), Number.NaN)), undefined, 'NaN = 不摘录')
  // 直接调用者传超上限的值时也要被夹住（配置路径已经夹过一次，这里兜底）。
  const capped = excerptOf(renderCauseRequest(slot('字'.repeat(2000)), 99_999))
  assert.equal(capped, `${'字'.repeat(CAUSE_EXCERPT_MAX)}…`, `直接调用也夹到 ${CAUSE_EXCERPT_MAX}`)
})

test('renderCauseRequest：detail 里的换行折成空格（"一行一条"的解析格式不被破坏）', () => {
  const detail = '第一段用户原话\n---\n[失败] pwsh「自检」\nAssertionError: boom'
  const slots = [
    { index: 1, milestone: { turn: 3, title: '标题一', cause: '未解决', detail, category: '失败', tokens: 0 } },
    { index: 2, milestone: { turn: 4, title: '标题二', cause: '未解决', detail: '第二段\n原话', category: '指令', tokens: 0 } },
  ]
  const body = renderCauseRequest(slots, 120)
  const lines = body.split('\n')
  assert.equal(lines.length, 2, `两条里程碑 = 两行；摘录不得把行拆开，实际 ${lines.length} 行`)
  // ⚠ 这条断言被**改过**：旧版期望 `---` 与「自检」原样出现。它们现在被清掉了——
  // `---` 是 detail 的分隔符（零信息），「自检」是**工具自述用途**（按模块约定只进 detail，
  // 实测平均吃掉每条失败行开头 41 码点）。留着它们等于用最宝贵的窗口装噪音。
  assert.match(lines[0], /｜摘录：第一段用户原话 \[失败\] pwsh AssertionError: boom$/, '换行折成空格')
  assert.match(lines[1], /｜摘录：第二段 原话$/)
  assert.doesNotMatch(body, /\n---\n/, 'detail 自己的 \\n---\\n 分隔符必须被折掉')
  assert.doesNotMatch(body, /「自检」/, '工具自述必须被剥掉（它占的是每行最宝贵的开头）')
  // 序号行的解析（回填只认序号）必须仍然只数出这两条。
  assert.deepEqual([...body.matchAll(/^(\d+)\. 第/gm)].map((m) => m[1]), ['1', '2'],
    '折行后"^序号. 第 N 轮"仍然一行一条（回填靠它对位）')
})

test('causeExcerpt：剥工具自述只剥**第一对**引号（报错正文里的引号必须留下）', () => {
  // 真实失败原文里带引号是常态：`active teammate "…" not found`、`api key: ****real is invalid`。
  // 把整行所有引号段都当自述剥掉会把正文切成碎片——那是比不剥更糟的失败。
  const detail = '[失败] send_message「Check the subagent」 active teammate "0fc8b43f" not found'
  const excerpt = causeExcerpt(detail, 200)
  assert.equal(excerpt, '[失败] send_message active teammate "0fc8b43f" not found',
    '只剥工具名后的第一对「」，正文里的英文引号原样保留')
})

test('causeExcerpt：去重 + 折叠 [image] + 去掉剥离标注（摘录里不得留零信息噪音）', () => {
  // 形状取自真实 detail（第 8–11 轮 / 第 16–17 轮）：重复的用户原话、连着三个图片占位、
  // 解释标题为什么干净的标注。它们占掉的是本该给报错原文的窗口。
  const detail = [
    '[image]',
    '[image]',
    '[image]',
    '1.插件列表报错 2.powershell安装报错',
    '---',
    '1.插件列表报错 2.powershell安装报错',
    '---',
    '[标题已剥离注入噪音：图片占位]',
  ].join('\n')
  const excerpt = causeExcerpt(detail, 200)
  assert.equal(excerpt, '[image] 1.插件列表报错 2.powershell安装报错',
    '图片占位折成一枚、重复行只留一次、剥离标注丢掉')
  assert.doesNotMatch(excerpt, /标题已剥离注入噪音/, '纯标注对"为什么"没有信息量')
})

test('causeExcerpt：多行时前几行共享预算（清洗省下的额度留给完整句子）', () => {
  // 这条守的是**被实测否掉的方案**：逐行分配预算（每行 40 字）会让 6 行各切成碎片，
  // 信号保留率从 88% 掉到 81%（真实会话 53 条实测）。所以实现刻意取开头，
  // 把清洗省下的额度全给前面几行——短的第二行必须仍然进得来。
  const detail = [
    '1.插件列表报错 2.powershell安装报错',
    '你执行到一半之后卡住了，然后目标我先暂停了',
  ].join('\n')
  const excerpt = causeExcerpt(detail, 200)
  assert.match(excerpt, /你执行到一半之后卡住了/, '第二行（真正的因果）必须仍然在摘录里')
  assert.match(excerpt, /^1\.插件列表报错/, '顺序不变：用户原话在前，不是重排过的')
  assert.ok([...excerpt].length <= 200 + 1, `总长不得超过上限+省略号，实际 ${[...excerpt].length}`)
})

test('causeExcerpt：第一行吃满预算时如实截断（不假装覆盖后面的行）', () => {
  // 已知边界要**诚实**：真正的原因若落在很长的第一行之后，200 字够不到就是够不到。
  // 逐行切碎能"覆盖"更多行，但那是以每行都不完整为代价换来的——实测更差。
  const detail = ['字'.repeat(500), '第二行'].join('\n')
  const excerpt = causeExcerpt(detail, 200)
  assert.ok([...excerpt].length <= 201, `不得超过上限，实际 ${[...excerpt].length}`)
  assert.doesNotMatch(excerpt, /第二行/, '预算被第一行吃满时，第二行进不来（这是如实截断）')
})

test('causeExcerpt：单行 detail 仍然是一整段（行分配不改变单行的行为）', () => {
  const excerpt = causeExcerpt('我要在 DSH 中创建一个新的插件', 200)
  assert.equal(excerpt, '我要在 DSH 中创建一个新的插件', '短单行原样返回，不加省略号')
})

test('CAUSE_INSTRUCTION：给了证据，还要明确允许说"不知道"（治本的另一半）', () => {
  assert.match(CAUSE_INSTRUCTION, /摘录/, '必须说明摘录是判断依据，否则模型不知道那串字是什么')
  assert.match(CAUSE_INSTRUCTION, /不要编/, '必须明确禁止凭标题编造因果')
  assert.match(CAUSE_INSTRUCTION, /原因不明/, '必须给出"不知道"这个可接受的答案')
  assert.match(CAUSE_INSTRUCTION, /≤20 个字符/, '字数上限不能因为加了几句话就丢掉')
  assert.match(CAUSE_INSTRUCTION, /JSON/, '输出形态不能丢（否则解析不到）')
})

// ── "工具报错被当成因果"这条修复（真实会话第 31/32/35 轮）────────────────────
//
// 真实现象（真机骨架逐字）：
// ```
// 28. 第 31 轮: 位置是在对话和轨迹的旁边，然后开始完成任务 — 目标子代理已不存在
// 29. 第 32 轮: 两份研究都在推进 — 目标子代理已不存在
// 31. 第 35 轮: 移植完成，修复轮在跑 — 目标子代理已不存在
// ```
// 三条标题都不是失败事件，cause 却是同一句工具报错。**查到的真实成因不是"模型侧"**：
// 第 32/35 轮的 `detail` 除了那条 `active teammate "…" not found` **什么都没有**
// （长度恰好 120 码点，逐字复刻在下面 leakEvents 里），第 31 轮也只有"用户原话 + 两条报错"。
// 请求把那唯一的报错原样递给了模型——模型把它当因果，是**照着给的证据**答的。
//
// 所以修法有两半，缺一不可：
// 1. 渲染侧（`causeEvidence`）：摘录 100% 是 `[失败]` 行、标题又在讲"顺利"时，给摘录加
//    角色标注（{@link CAUSE_ERROR_ONLY_NOTE}）。删掉它不行——"只发标题"是**已知会编**的
//    旧行为（第 1 轮的"插件机制未初始化"）。
// 2. 指令侧：把"报错不一定是因果"从"标题已过/已修好"扩到**一般判据**——报错只说明
//    "当时发生了什么"，只有与标题指向同一件事时才算因果。第 31 轮那种"用户原话 + 报错"
//    的摘录没有标注（有真实上下文），全靠这一半。

/**
 * 真实会话第 31/32/35 轮的最小复刻（形状逐字，见上面注释里的三行）。
 *
 * 事件是从真实 `session.v4.jsonl.zstd` 里读出来的：`send_message` 的 `arguments` 是
 * `{"target":"<agentId>","message":"…"}`（所以工具自述就是那个 id），`tool/result` 是
 * `isError: true` + `Error: active teammate "<agentId>" not found`。
 * 用这份夹具提取出的 `detail` 与真实会话**逐字一致**（第 32/35 轮都是 120 码点）。
 *
 * 第 1 轮不是凑数：会话第一条 `user/message` 承担"任务"条目、逐轮条目里会被跳过
 * （见 extractMilestones 里的 firstUserSeq），少了它，第 31 轮的用户原话就会被当成
 * "第一条"跳掉，形状当场走样。
 */
function leakEvents() {
  const agent = '0fc8b43f-5480-408e-a07a-bbb3701c8a8b'
  const events = []
  let seq = 0
  const start = (turn) => events.push({ type: 'turn/start', seq: seq++, data: { turn } })
  const end = (turn) => events.push({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  const user = (turn, text) => events.push({
    type: 'user/message', seq: seq++, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  })
  const prose = (turn, text) => events.push({
    type: 'assistant/message', seq: seq++, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })
  const failCall = (turn, callId, name, args, result) => {
    events.push({ type: 'tool/call', seq: seq++, data: { turn, step: 2, callId, name, arguments: JSON.stringify(args) } })
    events.push({
      type: 'tool/result',
      seq: seq++,
      data: {
        turn,
        step: 2,
        message: { role: 'tool', toolCallId: callId, isError: true, content: [{ type: 'text', text: result }] },
      },
    })
  }

  // 第 1 轮：会话第一条用户消息（承担"任务"条目）
  start(1)
  user(1, '我要在 DeepSeek Harness 中创建一个新的插件')
  prose(1, '先做核心逻辑再接线')
  events.push({ type: 'tool/call', seq: seq++, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ description: '第1轮自检' }) } })
  events.push({
    type: 'tool/result',
    seq: seq++,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '第1轮：全部通过（ok）PASS——三层接线自检完成，无遗留问题，可以继续下一步，不需要人工介入。' }] },
    },
  })
  end(1)

  // 第 21 轮：**标题在讲失败**（用户报告症状），摘录里的报错正是它的因果——反向样本。
  // 真实落库 cause = `client inject声明契约不符`，这一条**必须继续成立**。
  start(21)
  user(21, '你跑一半死了')
  prose(21, '契约检查有一条没过')
  failCall(21, 'c21', 'pwsh', { description: 'Run contract check' },
    '[dsh-tri-layer-memory] built lib/entry.js + lib/impl.js + lib/client.js\n'
    + '61/62 契约检查通过\nFAIL client inject 声明 slots + settings\n[exit code: 1]')
  end(21)

  // 第 31 轮：用户原话 + 两条报错（真实 detail 343 码点）
  start(31)
  user(31, '位置是在对话和轨迹的旁边，然后开始完成任务')
  prose(31, '两份研究都在推进')
  failCall(31, 'c31', 'send_message', { target: agent, message: '继续收紧提取器' }, `Error: active teammate "${agent}" not found`)
  end(31)

  // 第 32 轮：用户没说话（自动续跑），detail 里只有那条报错
  start(32)
  prose(32, '两份研究都在推进')
  failCall(32, 'c32', 'send_message', { target: agent, message: '继续' }, `Error: active teammate "${agent}" not found`)
  end(32)

  // 第 35 轮：同上，标题是"移植完成，修复轮在跑"
  start(35)
  prose(35, '移植完成，修复轮在跑')
  failCall(35, 'c35', 'send_message', { target: agent, message: '继续' }, `Error: active teammate "${agent}" not found`)
  end(35)
  return events
}

/** 夹具里那三条"标题顺利 + 摘录只有报错"的里程碑（按真实骨架里的标题取）。 */
const leakMilestones = () => extractMilestones(leakEvents())
  .filter((m) => m.title === '两份研究都在推进' || m.title === '移植完成，修复轮在跑')

test('titleReportsFailure：判据两端由真实会话校准（漏一端就把已修好的那一条弄坏）', () => {
  // 必须判"不是失败"：这三条就是要治的（它们的 cause 被写成了同一条工具报错）
  for (const title of ['两份研究都在推进', '移植完成，修复轮在跑', '位置是在对话和轨迹的旁边，然后开始完成任务']) {
    assert.equal(titleReportsFailure(title), false, `"${title}" 是一句顺利/中性的陈述，不该被判成失败`)
  }
  // 必须判"是失败"：第 21 轮那条的因果**正是**摘录里的报错（落库 cause = client inject声明契约不符）。
  // 判成"非失败"就会给它加"未必是原因"，等于把已经修好的那一条重新弄坏。
  for (const title of ['你跑一半死了', '测试断言失败（4 次）', '连续 2 轮整轮失败：Connection error.']) {
    assert.equal(titleReportsFailure(title), true, `"${title}" 在讲失败/卡住，摘录里的报错可能是它的因果`)
  }
})

test('renderCauseRequest：摘录 100% 是报错 + 标题顺利 → 加角色标注（真实第 32/35 轮逐字）', () => {
  const milestones = leakMilestones()
  assert.equal(milestones.length, 2, '夹具必须复现那两条（标题：两份研究都在推进 / 移植完成，修复轮在跑）')

  for (const [i, milestone] of milestones.entries()) {
    // 夹具保真断言：真实会话里第 32/35 轮的 detail 长度都是 120，且只有一条报错行。
    assert.equal([...milestone.detail].length, 120, `真实 detail 是 120 码点，实际 ${[...milestone.detail].length}`)
    assert.match(milestone.detail, /^\[失败\] send_message「0fc8b43f-5480-408e-a07a-bbb3701c8a8b」 active teammate "0fc8b43f-5480-408e-a07a-bbb3701c8a8b" not found$/,
      'detail 必须是真实那一行（工具自述 = agentId，报错正文里的引号原样）')

    const line = renderCauseRequest([{ index: i + 1, milestone }], 200)
    assert.match(line, /｜摘录：〔本轮工具报错，未必是原因〕\[失败\] send_message active teammate/,
      `摘录只有报错、标题却在讲顺利时必须标注角色，实际：${line}`)
    // 标注是**加法**：报错原文一个字都没丢（删掉它等于退回"只发标题"的编造路径）。
    assert.match(line, /not found$/, '报错正文必须完整保留（标注不是删证据）')
    assert.doesNotMatch(line, /^(\d+)\. 第 \d+ 轮｜[^｜]+$/, '摘录不许被整段拿掉')
  }
})

test('renderCauseRequest：反向样本不加标注（标题在讲失败 / 摘录里有用户原话）', () => {
  const all = extractMilestones(leakEvents())
  const body = renderCauseRequest(all.map((milestone, i) => ({ index: i + 1, milestone })), 200)
  const lineOf = (needle) => body.split('\n').find((l) => l.includes(needle))

  // ① 标题在讲失败：摘录里的报错**正是**因果，加标注会挡住它。
  assert.doesNotMatch(lineOf('你跑一半死了'), /未必是原因/, '第 21 轮那条的报错就是因果，不许标注')
  assert.match(lineOf('你跑一半死了'), /FAIL client inject 声明 slots/, '它的报错必须在摘录里（因果就藏在这）')

  // ② 摘录里有用户原话（第 31 轮）：模型有真实上下文，报错是配角，标注只是噪音。
  const mixed = lineOf('位置是在对话和轨迹的旁边')
  assert.doesNotMatch(mixed, /未必是原因/, '摘录里有用户原话时不加标注（那才是这条的上下文）')
  assert.match(mixed, /｜摘录：位置是在对话和轨迹的旁边，然后开始完成任务 \[失败\] send_message/,
    `用户原话在前、报错在后，顺序不变：${mixed}`)
})

test('CAUSE_INSTRUCTION：报错只说明"发生了什么"——判据从"标题已修好"扩到一般情形', () => {
  // 旧版只覆盖"标题显示已经过了/修好了"，所以漏掉了"标题显示这一轮顺利"（就是本次那三条）。
  assert.match(CAUSE_INSTRUCTION, /报错只说明"当时发生了什么"/, '必须给定性：报错是现象，不是因果')
  assert.match(CAUSE_INSTRUCTION, /指的是同一件事/, '必须给出可操作的判据（报错与标题指向同一件事才算因果）')
  assert.match(CAUSE_INSTRUCTION, /顺利的进展陈述/, '必须点名"标题是一句顺利陈述"这种情况')
  assert.match(CAUSE_INSTRUCTION, /翻译成一句原因/, '必须堵掉本次泄漏的具体形态：把报错原文翻成中文当因果')
  assert.match(CAUSE_INSTRUCTION, /未必是原因/, '指令必须解释摘录里那个标注是什么意思')
  assert.match(CAUSE_INSTRUCTION, /指出出处/, '结构约束：原因必须能从标题/摘录指出出处')
  // 老的两条许可不许被这次改写挤掉。
  assert.match(CAUSE_INSTRUCTION, /故意的探测/, '第 5 轮那条（探测被读成因果）的判据必须留着')
  assert.match(CAUSE_INSTRUCTION, /是可接受的答案/, '"原因不明"的许可不许被删')
})

test('角色标注体积有界：每条最多 14 码点，且不破坏"一行一条"的解析格式', () => {
  assert.ok([...CAUSE_ERROR_ONLY_NOTE].length <= 14,
    `标注必须短（它进每一条的摘录），实际 ${[...CAUSE_ERROR_ONLY_NOTE].length} 码点`)
  const slots = leakMilestones().map((milestone, i) => ({ index: i + 1, milestone }))
  const body = renderCauseRequest(slots, 200)
  assert.equal(body.split('\n').length, slots.length, '标注不得把行拆开')
  assert.deepEqual([...body.matchAll(/^(\d+)\. 第/gm)].map((m) => m[1]), ['1', '2'],
    '序号行仍然一行一条（回填靠它对位）')
  // 单条上界：标题 ≤40 + 摘录 ≤(200+1) + 结构 ≈20 + 标注 14。
  const perLine = Math.max(...body.split('\n').map((l) => l.length))
  assert.ok(perLine <= 40 + 200 + 1 + 20 + 14, `单条 ≤ ${40 + 200 + 1 + 20 + 14} 字符，实际 ${perLine}`)
})

test('请求体积有界：默认 20 条 ≈ 5.1K 字符，两个旋钮都拉满也不超过解析能承受的上界', () => {
  const slots = (count, detail) => Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    milestone: { turn: i + 1, title: '标'.repeat(40), cause: '未解决', detail, category: '失败', tokens: 0 },
  }))
  // 单条上限 = 标题 ≤40 + 摘录 ≤(limit+1) + 结构（序号/轮次/两个分隔符）≈20。
  const STRUCT = 20

  const def = renderCauseRequest(slots(20, '字'.repeat(5000)), DEFAULTS.mainlineCauseExcerptChars)
  assert.equal(def.split('\n').length, 20)
  const perLine = Math.max(...def.split('\n').map((l) => l.length))
  assert.ok(perLine <= 40 + (DEFAULTS.mainlineCauseExcerptChars + 1) + STRUCT,
    `单条 ≤ ${40 + DEFAULTS.mainlineCauseExcerptChars + 1 + STRUCT} 字符，实际 ${perLine}`)
  // ⚠ 这个界被**改过**：旧默认 120 时是 20×191=3,820；默认改成 200 之后是 20×261=5,220
  // （实测 5,101 字符 ≈ 889 token）。界本身仍然必须存在——它守的是"请求有界"，
  // 不是那个数字：体积失控会让超时与截断一起回来。
  assert.ok(def.length <= 20 * (40 + CAUSE_EXCERPT_CHARS + 1 + STRUCT),
    `默认 20 条请求 ≤ ${20 * (40 + CAUSE_EXCERPT_CHARS + 1 + STRUCT)} 字符，实际 ${def.length}`)

  const worst = renderCauseRequest(slots(100, '字'.repeat(5000)), CAUSE_EXCERPT_MAX)
  assert.equal(worst.split('\n').length, 100)
  assert.ok(worst.length <= 100 * (40 + CAUSE_EXCERPT_MAX + 1 + STRUCT),
    `最大旋钮组合 ≤ ${100 * (40 + CAUSE_EXCERPT_MAX + 1 + STRUCT)} 字符，实际 ${worst.length}`)
  // 体积是"贵"而不是"失控"：被截断的只有尾部几条，前面的序号行仍然完整可解析。
  assert.deepEqual(
    [...worst.matchAll(/^(\d+)\. 第/gm)].map((m) => m[1]).slice(0, 3),
    ['1', '2', '3'],
    '无论多长，序号行都完整',
  )
})

test('missingCauses：已经被 LLM 补过的（known 里有键）不再进候选', () => {
  const milestones = [
    { turn: 1, title: 'A', cause: '会话初始任务', detail: '', category: '任务', tokens: 0 },
    { turn: 2, title: 'B', cause: '验证通过', detail: '', category: '验证', tokens: 0 },
  ]
  assert.equal(missingCauses(milestones, new Map()).length, 2)
  assert.equal(missingCauses(milestones, new Map([['1:1#A', '补过的因果']])).length, 1, '按缓存键（区间 + 标题）排除')
})

test('parseCauseReply：紧凑 JSON / 围栏 / 数组 / 截断 / 逐行 都认，垃圾返回空', () => {
  const cases = [
    ['{"3":"采样率不匹配"}', 3, '采样率不匹配'],
    ['好的，结果如下：\n```json\n{"7":"TransparencyKey 破坏鼠标命中"}\n```\n希望有帮助。', 7, 'TransparencyKey 破坏鼠标命中'],
    ['[{"序号":5,"原因":"采样率不匹配"},{"序号":9,"cause":"缺路由头"}]', 5, '采样率不匹配'],
    ['{"3":"采样率不匹配","5":"半截 JSON 也救得回来"', 5, '半截 JSON 也救得回来'],
    ["{'4': '单引号键也认'}", 4, '单引号键也认'],
    ['3. 采样率不匹配\n5、缺路由头\n- 9) 孤儿进程残留', 9, '孤儿进程残留'],
  ]
  for (const [raw, index, expected] of cases) {
    const parsed = parseCauseReply(raw)
    assert.equal(parsed.get(index), expected, `解析 ${JSON.stringify(raw)} 的第 ${index} 条`)
  }

  assert.equal(parseCauseReply('抱歉，我无法完成这个请求。').size, 0, '垃圾回复一条都不认')
  assert.equal(parseCauseReply('').size, 0, '空回复不崩')
  assert.equal(parseCauseReply(undefined).size, 0, '未定义回复不崩')
  assert.equal(parseCauseReply('{"3":"   "}').size, 0, '空值丢弃（缺席由调用方按保持原样处理）')
  assert.equal(parseCauseReply('{"3":123}').size, 0, '非字符串值丢弃')
  // 模型把请求抄回来时不能当成一条 cause：那会让骨架原地复述标题。
  assert.equal(parseCauseReply('{"2":"第 22 轮｜状态确认了：profile patch"}').size, 0, '请求回显必须被丢掉')
  // 真实会话验证里撞到的一处：cause 本身以引号结尾时，剥包裹引号不能把最后一个字符吃掉。
  assert.equal(parseCauseReply('{"4":"构建产物里残留 type:\'json\'"}').get(4), "构建产物里残留 type:'json'")
  assert.equal(parseCauseReply('4. 「缺 x-opencode-session 路由头」').get(4), '缺 x-opencode-session 路由头', '包裹引号成对时仍要剥掉')
})

test('applyCauses：截到 20 字符并重算 tokens；attachCauses 把补过的贴回新骨架', () => {
  const milestones = [
    { turn: 1, title: '标题一', cause: '会话初始任务', detail: '', category: '任务', tokens: 0 },
  ]
  milestones[0].tokens = 40
  const applied = applyCauses(milestones, new Map([[1, '因'.repeat(40)]]))
  assert.equal(applied.length, 1)
  assert.equal(milestones[0].cause.length, CAUSE_CHARS, `cause 必须截到 ${CAUSE_CHARS} 字符`)
  assert.notEqual(milestones[0].tokens, 40, '骨架行变了，tokens 必须重算')
  assert.equal(applied[0].cacheKey, '1:1#标题一', '回填结果带缓存键（区间 + 标题）')

  // 越界序号（模型多给）与缺失序号（模型漏给）都不许影响别的条目。
  const other = [{ turn: 2, title: '标题二', cause: '验证通过', detail: '', category: '验证', tokens: 0 }]
  assert.equal(applyCauses(other, new Map([[9, '多余的']])).length, 0)
  assert.equal(other[0].cause, '验证通过', '没被回填的条目保持原样')

  // attachCauses：提取每次都返回全新对象，靠它跨轮保持因果。
  const fresh = [{ turn: 2, title: '标题二', cause: '验证通过', detail: '', category: '验证', tokens: 0 }]
  assert.equal(attachCauses(fresh, new Map([['2:2#标题二', '采样率不匹配']])), 1)
  assert.equal(fresh[0].cause, '采样率不匹配')
})

// ── 端到端：无服务 / 垃圾 / 缺项 / 节流 / 开关 / 截断 ─────────────────────

test('无 LLM 服务：不发请求、不抛错、cause 保持确定性标签，投影照常注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-cause-'))
  try {
    const { step } = harness({ l3Dir: dir, l3Store: 'jsonl' })
    await tick()
    const decision = await step({ id: 's-no-llm', events: sessionEvents(3) })
    const text = textOf(decision)

    assert.match(text, /## 里程碑主线骨架/, '没有 llm 服务也要照常注入骨架')
    assert.match(skeletonOf(text), DETERMINISTIC, 'cause 必须是提取给出的确定性标签')
    // 里程碑记录照常落库（补全失败不影响提取与持久化）。
    assert.ok(readRecords(dir).some((r) => r.kind === 'milestone'), '里程碑仍应落 L3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LLM 返回垃圾：不崩，cause 保持确定性标签，L3 记录不被改坏', async () => {
  const { dir, llm, text } = await run({ turns: 3, respond: () => '抱歉，我无法完成这个请求。' })
  try {
    assert.equal(llm.calls.length, 1, '请求确实发出去了（否则这条测试什么都没证明）')
    assert.match(skeletonOf(text), DETERMINISTIC, '解析不出来就保持原样')
    const records = readRecords(dir).filter((r) => r.kind === 'milestone')
    assert.ok(records.length > 0, '里程碑仍应落 L3')
    assert.ok(records.every((r) => !r.text.includes('抱歉')), '垃圾回复不得写进任何记录')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LLM 抛错 / 流失败：静默降级，不抛错，标签保持', async () => {
  const { dir, llm, text } = await run({ turns: 3, respond: () => new Error('upstream 500') })
  try {
    assert.equal(llm.calls.length, 1)
    assert.match(skeletonOf(text), DETERMINISTIC, '调用失败必须退回确定性标签')
    assert.match(text, /## L1 工作记忆/, '补全失败不得连累这一轮的三层投影')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LLM 缺项 + 超量：能填的照填，多出来的序号被忽略', async () => {
  const { dir, llm, text } = await run({
    turns: 3,
    respond: () => JSON.stringify([{ 序号: 2, 原因: '缺项也能填' }, { 序号: 99, 原因: '多余的' }]),
  })
  try {
    assert.equal(llm.calls.length, 1)
    const skeleton = skeletonOf(text)
    assert.match(skeleton, /— 缺项也能填/, '认得出的条目必须回填')
    assert.match(skeleton, DETERMINISTIC, '没给的条目保持确定性标签')
    assert.doesNotMatch(skeleton, /多余的/, '越界序号不得凭空造出一条 cause')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('节流：不足 mainlineCauseMinBatch 条时不发请求', async () => {
  // 1 轮 = 2 条里程碑 < 默认 3 → 一次都不发。
  const { dir, llm, text } = await run({ turns: 1 })
  try {
    assert.equal(llm.calls.length, 0, `缺 2 条时不该发请求（minBatch 默认 ${3}）`)
    assert.match(skeletonOf(text), DETERMINISTIC)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('节流：minBatch 配成 1 时，缺一条也发', async () => {
  const { dir, llm } = await run({ turns: 1, config: { mainlineCauseMinBatch: 1 } })
  try {
    assert.equal(llm.calls.length, 1, 'minBatch=1 时缺两条应立刻发一次')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mainlineCauseEnabled: false：完全不发请求', async () => {
  const { dir, llm, text } = await run({ turns: 5, config: { mainlineCauseEnabled: false } })
  try {
    assert.equal(llm.calls.length, 0, '总开关关掉后一条请求都不许发')
    assert.match(skeletonOf(text), DETERMINISTIC, '关掉后骨架只剩确定性标签')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mainlineCauseMaxPerCall：单次只补这么多条，其余留到下一轮', async () => {
  const { dir, llm, text } = await run({ turns: 9, config: { mainlineCauseMaxPerCall: 3 } })
  try {
    assert.equal(llm.calls.length, 1)
    const body = llm.calls[0].messages[0].content[0].text
    const asked = [...body.matchAll(/^(\d+)\. 第/gm)].map((m) => m[1])
    assert.deepEqual(asked, ['1', '2', '3'], '单次请求只带 3 条（上限生效）')

    const filled = [...skeletonOf(text).matchAll(/— 桩原因/g)].length
    assert.equal(filled, 3, '回填条数必须与请求条数一致')
    assert.match(skeletonOf(text), DETERMINISTIC, '没轮到的条目保持确定性标签')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：请求真的带上 detail 摘录（默认 120），模型读得到"用户说了什么"', async () => {
  const { dir, llm, text } = await run({ turns: 3 })
  try {
    assert.equal(llm.calls.length, 1)
    const body = llm.calls[0].messages[0].content[0].text
    assert.match(body, /｜摘录：第\d轮：请处理记忆压缩任务/, '摘录必须是该轮用户原话的开头（因果就藏在这里）')
    const asked = body.split('\n').filter((line) => /^\d+\. 第/.test(line))
    assert.equal(asked.length, 4, `每行一条，摘录不得破坏行结构（3 轮 = 任务 + 3 条），实际 ${asked.length}`)
    assert.match(body, /不要编/, '指令段随请求一起发出去：模型才知道摘录是什么、可以写"原因不明"')
    assert.equal([...skeletonOf(text).matchAll(/— 桩原因/g)].length, 4, '带摘录的请求照常回填')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端：mainlineCauseExcerptChars=0 时请求里没有摘录（退回只发标题，回填照常）', async () => {
  const { dir, llm, text, events } = await run({ turns: 3, config: { mainlineCauseExcerptChars: 0 } })
  try {
    assert.equal(llm.calls.length, 1, '关掉摘录不等于关掉回填')
    const body = llm.calls[0].messages[0].content[0].text
    // 只判里程碑那一段：指令段（CAUSE_INSTRUCTION）里当然会提到"摘录"这个词。
    const [milestones] = body.split('\n\n---\n\n')
    const lines = milestones.split('\n')
    assert.equal(lines.length, 4, '每行一条')
    for (const line of lines) {
      // 旧形态只有三个字段，**一个 ｜ 都不多**——多一个就是漏了摘录进去。
      assert.match(line, /^\d+\. 第 \d+(?:–\d+)? 轮｜[^｜\n]+$/,
        `0 = 旧行为：序号｜轮次｜标题，实际 ${line}`)
    }
    // 端到端对齐纯函数：证明 config 真的被接线到了渲染（而不是"恰好没摘录"）。
    assert.equal(milestones, renderCauseRequest(missingCauses(extractMilestones(events), new Map()), 0),
      '插件必须把 mainlineCauseExcerptChars=0 传给渲染器')
    assert.equal([...skeletonOf(text).matchAll(/— 桩原因/g)].length, 4, '退路上回填必须照常工作')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 回放用的"假 LLM"：**按修复前的模型行为**读请求作答，用来证明修复真的挡住了那条路径。
 *
 * 两条分支各自对应一次真实观测：
 * - 标题在讲失败（第 21 轮）：从报错里读出根因——真实落库 cause 就是 `client inject声明契约不符`。
 * - 标题是顺利陈述、摘录里只有一条工具报错、且**没有任何角色标注**：把它当成因果——
 *   真机骨架里那三条逐字就是 `目标子代理已不存在`。标注在场时这条分支走不到，
 *   于是退回「原因不明」。
 *
 * 它不是在"模拟某个模型"，而是在模拟**观测到的那次行为**：只要请求形态不变，
 * 它就会重放同一句泄漏——所以它是一条真正的回归闸门（把标注删掉，这条测试立刻红）。
 */
function replayCause(options) {
  const body = options?.messages?.[0]?.content?.[0]?.text ?? ''
  const out = {}
  for (const line of body.split('\n')) {
    const m = /^(\d+)\. 第 \d+(?:–\d+)? 轮｜([^｜\n]+)(?:｜摘录：([\s\S]*))?$/.exec(line)
    if (m === null) continue
    const [, index, title, raw] = m
    if (raw === undefined) { out[index] = '原因不明'; continue }
    const noted = raw.startsWith(CAUSE_ERROR_ONLY_NOTE)
    const excerpt = noted ? raw.slice([...CAUSE_ERROR_ONLY_NOTE].length) : raw
    if (titleReportsFailure(title)) {
      out[index] = /client inject 声明/.test(excerpt) ? 'client inject声明契约不符' : '原因不明'
      continue
    }
    // 摘录以报错行开头 = 模型看不到别的证据（真实第 32/35 轮就是这条）。
    if (excerpt.startsWith('[失败]') && !noted) {
      out[index] = /active teammate ".*" not found/.test(excerpt) ? '目标子代理已不存在' : '原因不明'
      continue
    }
    out[index] = '原因不明'
  }
  return JSON.stringify(out)
}

/** 用真实形状的夹具跑一次（`run` 只吃合成会话，这里要逐字复刻真机事件）。 */
async function runFixture(events, respond, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-cause-'))
  const llm = fakeLlm(respond)
  const harnessed = harness({ l3Dir: dir, l3Store: 'jsonl', ...config }, { llm })
  await tick()
  const session = { id: 's-leak', events }
  const decision = await harnessed.step(session)
  return { dir, llm, session, decision, text: textOf(decision) }
}

test('端到端（假 LLM 回放真实请求）：标题顺利 + 摘录只有报错 → 不会把报错当成因果', async () => {
  const { dir, llm, text } = await runFixture(leakEvents(), replayCause)
  try {
    // 先证明请求真的发出去了：不然"没有泄漏"只是因为压根没问。
    assert.equal(llm.calls.length, 1, '5 条缺 cause ≥ minBatch 3，必须发一次请求')
    const body = llm.calls[0].messages[0].content[0].text
    const asked = body.split('\n').filter((l) => /^\d+\. 第/.test(l))
    assert.equal(asked.length, 6, `每行一条（任务 + 第 1/21/31/32/35 轮），实际 ${asked.length}`)

    const skeleton = skeletonOf(text)
    // 核心：那两条的 cause 不许是那条工具报错（真机骨架里逐字是"目标子代理已不存在"）。
    assert.doesNotMatch(skeleton, /目标子代理已不存在/, '工具报错不许再进骨架当因果')
    assert.doesNotMatch(skeleton, /active teammate/, '报错原文（或其片段）也不许被抄进 cause')
    assert.match(skeleton, /第 32 轮: 两份研究都在推进 — 原因不明/)
    assert.match(skeleton, /第 35 轮: 移植完成，修复轮在跑 — 原因不明/)
    // 指令段必须随请求一起发出去（模型看不到那条一般判据，就只剩报错可写）。
    assert.match(body, /报错只说明"当时发生了什么"/, '一般判据必须在请求里')
    // L3 里同样不许留下那句报错当因果（回填是两处落点，见 syncMilestoneRecords）。
    for (const record of readRecords(dir).filter((r) => r.kind === 'milestone')) {
      assert.doesNotMatch(record.text, /目标子代理已不存在|active teammate/, `L3 记录不许带报错当因果：${record.text}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('端到端（假 LLM 回放真实请求）：标题是失败 + 摘录是对应报错 → 仍然能得出那个因果', async () => {
  const { dir, llm, text } = await runFixture(leakEvents(), replayCause)
  try {
    const body = llm.calls[0].messages[0].content[0].text
    const line = body.split('\n').find((l) => l.includes('你跑一半死了'))
    assert.ok(line !== undefined, '第 21 轮必须在请求里')
    assert.doesNotMatch(line, /未必是原因/, '标题在讲失败时不许加标注（会挡住真正的因果）')

    const skeleton = skeletonOf(text)
    // 正常路径不许被堵死：这一条的因果**正是**摘录里的报错。
    assert.match(skeleton, /第 21 轮: 你跑一半死了 — client inject声明契约不符/,
      '标题确实是失败时，摘录里的报错必须仍然能得出因果')
    assert.doesNotMatch(skeleton, /第 21 轮: 你跑一半死了 — 原因不明/, '不许把正常路径也降级成"不知道"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('「原因不明」仍然是被允许的输出：解析 → 回填 → 骨架与 L3 都认', async () => {
  // 纯函数层：解析得出来、写进去，且**不被当成"没答"丢掉**（丢掉就会退回确定性标签，
  // 那等于把"诚实地说不知道"变成一次失败——这条许可必须一直有效）。
  const parsed = parseCauseReply('{"1":"原因不明"}')
  assert.equal(parsed.get(1), '原因不明', '"原因不明"必须是可解析的正常取值')
  const milestones = [{ turn: 32, title: '两份研究都在推进', cause: '未解决', detail: '', category: '事件', tokens: 0 }]
  assert.equal(applyCauses(milestones, parsed).length, 1, '"原因不明"必须真的被回填')
  assert.equal(milestones[0].cause, '原因不明')

  // 端到端：模型全写"原因不明"时，骨架与 L3 都照常落（它不是错误路径）。
  const { dir, text } = await run({
    turns: 3,
    respond: () => JSON.stringify({ 1: '原因不明', 2: '原因不明', 3: '原因不明', 4: '原因不明' }),
  })
  try {
    assert.equal([...skeletonOf(text).matchAll(/— 原因不明/g)].length, 4, '四条都该写成"原因不明"')
    assert.ok(readRecords(dir).some((r) => r.kind === 'milestone' && r.text.includes('原因不明')),
      'L3 记录同样要带上"原因不明"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cause 长度被截到 ≤20 字符（模型不听话时的兜底）', async () => {  const long = '这是一句远超二十个字符上限的因果说明，模型没听话也不能让它进骨架'
  const { dir, text } = await run({ turns: 3, respond: () => JSON.stringify({ 2: long, 3: long, 4: long }) })
  try {
    const causes = [...skeletonOf(text).matchAll(/— (.+)$/gm)].map((m) => m[1])
    assert.ok(causes.length > 0, '骨架里应有带 cause 的行')
    for (const cause of causes) {
      assert.ok(cause.length <= CAUSE_CHARS, `每条 cause 必须 ≤${CAUSE_CHARS} 字符，实际 ${cause.length}：${cause}`)
    }
    assert.ok(causes.some((c) => c.endsWith('…')), '超长的那几条必须是被截断的')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 回填的落点：L3 记录 + 下一轮重新提取后的骨架 ─────────────────────────

test('回填后 L3 里的里程碑记录被改写（不是只改内存）', async () => {
  const { dir, text } = await run({ turns: 3 })
  try {
    const records = readRecords(dir).filter((r) => r.kind === 'milestone')
    assert.ok(records.length >= 3, `应有里程碑记录，实际 ${records.length}`)

    const filled = records.filter((r) => r.text.includes('桩原因'))
    assert.ok(filled.length >= 3, `L3 记录必须带上补好的 cause，实际 ${filled.length} 条`)
    // 记录文本与骨架行同形：`第 N 轮: 标题 — 原因`。
    for (const record of filled) {
      assert.match(record.text, /^第 \d+[–\d]* 轮: .+ — 桩原因\d+：测试回填$/, `记录行形态：${record.text}`)
    }
    // 注入块里的那几行也必须已经带上新 cause（回填不是只落库）。
    assert.match(skeletonOf(text), /— 桩原因1：测试回填/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('下一轮重新提取后，已补的 cause 不退回确定性标签（缓存贴回）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-cause-'))
  try {
    const llm = fakeLlm(replyAll)
    // l1RetainTurns 压到 2：水位是"已溢出 L1 的轮数"，只有它真的变了才会重新提取
    // （默认 8 轮以内水位恒为 0，这条测试就什么都没验证）。
    const { step } = harness({ l3Dir: dir, l3Store: 'jsonl', l1RetainTurns: 2 }, { llm })
    await tick()

    // 同一个会话对象推进（真实宿主里 session 是稳定的；换新对象等于换了一个会话）。
    const session = { id: 's-cause', events: sessionEvents(4) }
    const first = await step(session)
    assert.match(skeletonOf(textOf(first)), /— 桩原因1：测试回填/, '第一轮应补上')
    assert.equal(llm.calls.length, 1)

    // 会话往前走一轮：L1 溢出轮数变化 → 重新提取（全新对象）→ 必须把因果贴回去。
    session.events = sessionEvents(5)
    const second = await step(session)
    const skeleton = skeletonOf(textOf(second))
    assert.match(skeleton, /— 桩原因1：测试回填/, '重新提取后不得退回确定性标签')
    assert.match(skeleton, /第 5 轮/, '新增的轮次必须出现在骨架里')
    // 新增 1 条缺 cause < minBatch 3 → 不该再发请求（节流对增量同样生效）。
    assert.equal(llm.calls.length, 1, '只多了 1 条缺 cause，不该再发请求')

    // L3 里那份同样保持（记录不会被下一次提取覆盖回确定性标签）。
    const records = readRecords(dir).filter((r) => r.kind === 'milestone')
    assert.ok(records.some((r) => r.text.includes('桩原因1：测试回填')), 'L3 记录保持回填后的版本')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('minBatch 大于 maxPerCall 时仍然发得出去（计数看全部缺口，请求按上限截断）', async () => {
  const { dir, llm, text } = await run({
    turns: 9,
    config: { mainlineCauseMinBatch: 5, mainlineCauseMaxPerCall: 2 },
  })
  try {
    assert.equal(llm.calls.length, 1, '缺口按"全部缺 cause 的条数"算，不该因为单次上限而永远发不出去')
    const body = llm.calls[0].messages[0].content[0].text
    const asked = [...body.matchAll(/^(\d+)\. 第/gm)].map((m) => m[1])
    assert.deepEqual(asked, ['1', '2'], '请求按 maxPerCall 截断')
    assert.equal([...skeletonOf(text).matchAll(/— 桩原因/g)].length, 2, '只回填请求到的那几条')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LLM 挂住不返回：到点放弃等待，pre-step 照常返回（不阻塞对话）', async () => {
  // 这条守的是"绝不阻塞对话"这条承诺。宿主路由带 `reasoningEffort: "max"`，一次 cause
  // 调用可能跑十几秒——所以 pre-step **只等一小段**（CAUSE_INLINE_WAIT_MS），
  // 超过就让调用转入后台、结果落在下一轮投影。
  //
  // 注意别把上界写成"等满模型的响应时间"：那正是被修掉的旧行为（旧实现 await 8 秒，
  // 真机上甚至等不到就超时失败）。
  const dir = mkdtempSync(join(tmpdir(), 'tlm-cause-'))
  try {
    const hanging = {
      calls: [],
      stream() {
        // 永不 settle 的流：既不发块也不结束，模拟网关挂死（而不是明确报错）。
        return (async function* () {
          await new Promise(() => {})
        })()
      },
    }
    const { step } = harness({ l3Dir: dir, l3Store: 'jsonl' }, { llm: hanging })
    await tick()

    const t0 = Date.now()
    const decision = await step({ id: 's-hang', events: sessionEvents(3) })
    const elapsed = Date.now() - t0

    assert.ok(elapsed < 5_000, `必须到点放弃等待，实际等了 ${elapsed}ms`)
    assert.ok(elapsed >= 1_000, `应当先内联等一小段（否则快调用拿不到当场生效的机会），实际 ${elapsed}ms`)
    const text = textOf(decision)
    assert.match(text, /## 里程碑主线骨架/, '超时后这一轮的投影必须照常注入')
    assert.match(skeletonOf(text), DETERMINISTIC, '超时后 cause 保持确定性标签')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mainlineEnabled: false 时不补 cause（没有骨架就没有因果可补）', async () => {
  const { dir, llm } = await run({ turns: 5, config: { mainlineEnabled: false } })
  try {
    assert.equal(llm.calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
