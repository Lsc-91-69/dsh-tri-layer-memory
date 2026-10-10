/**
 * test/l2-seam.test.mjs — L2 摘要「本该走模型却退回抽取式」的**原因可见性**测试。
 *
 * 为什么单独一个文件：这个故障在真实会话里藏了很久（投影一直显示"生成方式
 * extractive"，84 次摘要、0 次走模型），因为 `buildDigest` 里那个 `catch {}` 把
 * 失败原因整个吃掉了——"模型缺席""路由解析不到""调用真的抛错"在观察面上长得
 * 一模一样。桌面端的宿主日志不可见，`memory_state` 是唯一可靠的观察面。
 *
 * 因此这里逐条钉死：三种失败各自**在 memory_state 的输出里**能被认出来，
 * 且抛错时异常消息原文被带上（不是"失败"两个字）。
 *
 * 用 `lib/impl.js`（真实构建产物）而不是源码，与 mount.test.mjs 同一策略：
 * 顺带验证"改动确实进了产物"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/impl.js'

/**
 * 最小可用 Host ctx。
 *
 * `inject(deps, cb)` 忠实模拟 cordis 的软等待：**依赖都在场时才回调**，并把服务
 * 挂到子 ctx 上。`injectSkips` 用来模拟"服务在（`ctx.get` 拿得到）但软等待没触发"
 * 的拓扑偏差——这正是 `llmSource` 字段要区分的情况。
 *
 * @param options - services 是本 ctx 能提供的服务；injectSkips 是软等待拿不到的依赖名。
 * @returns mock ctx 与捕获到的注册物。
 */
function mockContext({ services = {}, injectSkips = [] } = {}) {
  const tools = []
  const listeners = new Map()
  const available = { tools: { register(tool) { tools.push(tool); return () => {} }, schemas: () => tools.map((t) => ({ name: t.name })) }, ...services }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    effect(fn) { return fn() },
    inject(deps, callback) {
      if (!deps.every((d) => available[d] !== undefined && !injectSkips.includes(d))) return
      const child = Object.create(ctx)
      for (const d of deps) child[d] = available[d]
      callback(child)
    },
    get(name) { return available[name] },
    tools: available.tools,
    ...services,
  }
  return { ctx, tools, listeners }
}

/**
 * 造一段合成会话日志：n 轮，每轮 user + assistant + 一次成功的工具调用。
 *
 * 形状与 mainline.test.mjs 的夹具一致（含 `source.kind: 'user'` 与 tool/call + tool/result）：
 * 骨架提取需要真实的工具轨迹才会产出里程碑，否则 cause 回填那条路根本不会触发，
 * 测试就会"因为没触发"而通过，等于什么都没验证。
 */
function syntheticSession({ turns = 12, id = 's-l2-seam', header } = {}) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({
      type: 'user/message', seq: seq++,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮：请继续排查记忆层的 L2 摘要链路` }] },
    })
    events.push({
      type: 'assistant/message', seq: seq++, data: {
        turn, step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: `第${turn}轮结论：链路形状已确认。` }] },
      },
    })
    const callId = `call-${turn}`
    events.push({ type: 'tool/call', seq: seq++, data: { turn, step: 1, callId, name: 'pwsh', arguments: JSON.stringify({ description: `第${turn}轮自检` }) } })
    events.push({
      type: 'tool/result', seq: seq++, data: {
        turn, step: 1,
        message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: `第${turn}轮：全部通过` }] },
      },
    })
    events.push({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  }
  const session = { id, snapshotEvents: () => events, events }
  if (header !== undefined) session.requestHeader = () => header
  return session
}

/** 真实宿主折叠出来的请求头形状（`request/header` 事件的 data.header）。 */
const REAL_HEADER = {
  config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max', maxTokens: 384000 },
  adapterDefaults: { maxTokens: true },
  tools: [],
}

/** 假 llm seam：记录调用；`fail` 非空时在迭代开始处抛错。 */
function fakeLlm({ fail, text = '## 任务主线\n- 模型产出的摘要' } = {}) {
  const calls = []
  return {
    calls,
    service: {
      async *stream(options) {
        calls.push(options)
        if (fail !== undefined) throw new Error(fail)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
}

/** 摘要调用与 cause 调用共用同一条 seam，靠请求正文里的指令区分（两者 purpose 相同）。 */
function digestCalls(llm) {
  return llm.calls.filter((c) => JSON.stringify(c.messages ?? '').includes('Condense the conversation excerpt'))
}

/**
 * 跑一轮 pre-step，并取回 memory_state / memory_verify 的输出。
 *
 * @param options - mock 服务、会话、插件配置。
 * @returns 注入文本与两个工具的输出。
 */
async function runStep({ services = {}, injectSkips = [], session = syntheticSession(), config = {} } = {}) {
  const { ctx, tools, listeners } = mockContext({ services, injectSkips })
  apply(ctx, { l3Enabled: false, selfTestAfterBoot: false, ...config })

  const entry = listeners.get('agent/pre-step')[0]
  assert.ok(entry !== undefined, 'pre-step 监听必须注册')
  const decision = await entry.listener(
    { agent: { session }, turn: 12, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const injected = (decision?.messages ?? []).map((m) => m?.content?.[0]?.text ?? '').join('\n')

  const stateTool = tools.find((t) => t.name === 'memory_state')
  const verifyTool = tools.find((t) => t.name === 'memory_verify')
  const status = await stateTool.execute({}, { agent: { session } })
  const report = await verifyTool.execute({ detail: 'developer' }, { agent: { session } })
  return { injected, status, report, tools, ctx }
}

// ── 1. llm 缺席：失败原因必须可见 ─────────────────────────────────────────

test('llm 缺席：memory_state 里能看出"服务没拿到"，而不是静默回退', async () => {
  const { injected, status } = await runStep({ services: {} })

  // 摘要确实回退了（这是刻意的降级，不是故障本身）。
  assert.equal(status.layers.L2.via, 'extractive', 'llm 缺席时应退回抽取式')
  assert.equal(status.layers.L2.mode, 'llm', '模式仍是 llm —— 所以这是回退，不是配置')
  // 关键：原因必须出现在输出里。
  assert.ok(status.layers.L2.failure, 'memory_state 必须带出失败原因（这是本次故障的观察面）')
  assert.equal(status.layers.L2.failure.stage, 'llm-missing')
  assert.match(status.layers.L2.failure.message, /llm seam unavailable/)
  assert.equal(status.layers.L2.llmSource, 'none', '两条获取路径都没命中时 llmSource 应为 none')
  assert.equal(status.llmSeam.missing, true)
  // 注入块仍然给出一份可用的（抽取式）摘要，不能因为模型缺席就没有 L2。
  assert.match(injected, /生成方式 extractive/)
})

// ── 2. target 未解析：同样可见 ────────────────────────────────────────────

test('target 未解析：memory_state 里能看出"路由解析不到"', async () => {
  const llm = fakeLlm()
  // 会话没有 requestHeader()，也没有 agent.options → resolveTarget 返回 undefined。
  const { status } = await runStep({ services: { llm: llm.service }, session: syntheticSession({ header: undefined }) })

  assert.equal(status.layers.L2.via, 'extractive')
  assert.equal(status.layers.L2.failure?.stage, 'target-missing')
  assert.match(status.layers.L2.failure.message, /no provider\/model resolvable/)
  assert.equal(llm.calls.length, 0, '路由都解析不到时不该发出任何模型请求')
})

test('requestHeader() 自己抛错时：异常消息被带上，且不让整条 L2 路径挂掉', async () => {
  const llm = fakeLlm()
  const session = syntheticSession()
  session.requestHeader = () => { throw new Error('OFFLINE-HEADER-THREW') }
  const { status, injected } = await runStep({ services: { llm: llm.service }, session })

  assert.equal(status.layers.L2.via, 'extractive', '解析抛错必须回退，而不是把 pre-step 拖挂')
  assert.equal(status.layers.L2.failure?.stage, 'target-missing')
  assert.match(status.layers.L2.failure.message, /OFFLINE-HEADER-THREW/, '异常原文必须带出来')
  assert.match(injected, /L2 短期记忆/, '回退后仍要有 L2 段')
})

// ── 3. 调用抛错：消息原文必须可见 ─────────────────────────────────────────

test('调用抛错：memory_state 带上异常消息原文', async () => {
  const llm = fakeLlm({ fail: 'OFFLINE-STREAM-BOOM: provider rejected the request' })
  const { status, report } = await runStep({
    services: { llm: llm.service },
    session: syntheticSession({ header: REAL_HEADER }),
  })

  assert.equal(digestCalls(llm).length, 1, '路由可解析时应真的发出摘要请求（失败发生在流上，不是解析阶段）')
  assert.equal(status.layers.L2.via, 'extractive')
  assert.equal(status.layers.L2.failure?.stage, 'llm-error')
  assert.match(status.layers.L2.failure.message, /OFFLINE-STREAM-BOOM/)
  assert.match(status.layers.L2.failure.message, /provider rejected the request/, '异常消息必须完整带上，不能只说"失败"')
  // 验证报告也要如实报告，而不是给一个 PASS 让人以为一切正常。
  const fallbackVerdict = report.verdicts.find((v) => v.id === 'L2-fallback')
  assert.ok(fallbackVerdict !== undefined, 'memory_verify 应给出 L2-fallback 判定')
  assert.equal(fallbackVerdict.ok, false)
  assert.match(fallbackVerdict.text, /OFFLINE-STREAM-BOOM/)
})

// ── 4. 正向对照：通了就该显示 llm ────────────────────────────────────────

test('正向对照：llm 在场且路由可解析时真的走模型（via=llm，failure=null）', async () => {
  const llm = fakeLlm()
  const { injected, status } = await runStep({
    services: { llm: llm.service },
    session: syntheticSession({ header: REAL_HEADER }),
  })

  const calls = digestCalls(llm)
  assert.equal(calls.length, 1, '应发出一次摘要调用')
  assert.equal(calls[0].provider, 'opencode-go', 'provider 来自真实路由，不得硬编码')
  assert.equal(calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(calls[0].purpose, 'compaction', '与 compaction-basic 同源用途标记')
  assert.equal(status.layers.L2.via, 'llm')
  assert.equal(status.layers.L2.failure, null, '成功时不得残留失败原因')
  assert.equal(status.layers.L2.llmSource, 'inject', '软等待命中时应记为 inject')
  assert.match(injected, /生成方式 llm/)
  assert.match(injected, /模型产出的摘要/, '注入的必须是模型产出的正文')
})

test('软等待没触发但 ctx.get 拿得到时：llmSource=get，路径差异可见', async () => {
  const llm = fakeLlm()
  const { status } = await runStep({
    services: { llm: llm.service },
    injectSkips: ['llm'],
    session: syntheticSession({ header: REAL_HEADER }),
  })

  assert.equal(status.layers.L2.via, 'llm', 'ctx.get 兜底也应能拿到 seam')
  assert.equal(status.layers.L2.llmSource, 'get', '必须如实报告 seam 是从哪条路来的')
})

// ── 5. cause 回填：同一条 seam，同样要有可见的失败原因 ────────────────────

test('cause 回填失败：mainline.causeFailure 里能看到原因（不再静默）', async () => {
  const { status } = await runStep({
    services: {},
    session: syntheticSession({ header: REAL_HEADER }),
    config: { mainlineCauseEnabled: true, mainlineCauseMinBatch: 1 },
  })

  assert.ok(status.mainline !== null, 'memory_state 应带出骨架读数')
  assert.ok(status.mainline.milestones >= 1, `本会话应提取出里程碑，实际 ${status.mainline.milestones}`)
  assert.ok(status.mainline.causeFailure, '缺 llm 时 cause 回填的失败原因必须可见')
  assert.equal(status.mainline.causeFailure.stage, 'llm-missing')
  assert.match(status.mainline.causeFailure.message, /cause backfill/)
})

test('cause 回填抛错：mainline.causeFailure 带上异常消息原文', async () => {
  const llm = fakeLlm({ fail: 'OFFLINE-CAUSE-BOOM' })
  const { status } = await runStep({
    services: { llm: llm.service },
    session: syntheticSession({ header: REAL_HEADER }),
    config: { mainlineCauseEnabled: true, mainlineCauseMinBatch: 1 },
  })

  assert.ok(status.mainline.causeFailure, 'cause 回填失败必须可见')
  assert.equal(status.mainline.causeFailure.stage, 'llm-error')
  assert.match(status.mainline.causeFailure.message, /OFFLINE-CAUSE-BOOM/)
})
