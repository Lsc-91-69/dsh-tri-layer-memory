/**
 * test/mount.test.mjs — 离线挂载冒烟测试：用 mock ctx 真跑一遍 apply()。
 *
 * 为什么需要它：插件第一次挂载时踩到的两个坑（模块解析失败、`{ type: 'json' }`
 * 被 assertSupportedJsonSchema 拒绝）都只能在**运行时**暴露，而运行时的重载会
 * 被 Node 的 ESM 模块缓存挡住——一次重启才能验一次。这个测试把 apply() 的完整
 * 路径在本地跑通，让每次改动都能立刻验证，而不必消耗重启。
 *
 * 它直接 import `lib/impl.js`（真实产物，不是源码），因此同时验证了构建产物。
 * impl.js 只依赖 node 内置模块，所以无需任何宿主服务即可加载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/impl.js'

/** 宿主 assertSupportedJsonSchema 接受的基础类型（见 packages/core/tools/src/json-schema.ts）。 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/**
 * 递归校验一份 schema 是否落在宿主支持的子集内。
 *
 * 这是对 assertSupportedJsonSchema 的**规则复刻**，不是实现复刻：只检查
 * "每个节点必须有合法 type、关键字与 type 相容、properties/items 递归"。
 * 挂载期真实的抛错点就是 type 不在白名单，所以这条足以拦住同类问题。
 *
 * @param node - 待检查的 schema 节点。
 * @param path - 违规描述里用的位置。
 * @returns 违规列表。
 */
function schemaViolations(node, path) {
  const violations = []
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return [`${path} must be a schema object`]
  }
  if (Object.hasOwn(node, 'oneOf')) {
    const list = node.oneOf
    if (!Array.isArray(list) || list.length < 2) violations.push(`${path}.oneOf must have >= 2 schemas`)
    else list.forEach((entry, i) => violations.push(...schemaViolations(entry, `${path}.oneOf[${i}]`)))
    return violations
  }
  if (!Object.hasOwn(node, 'type')) {
    // 无 type 的注解型 schema 合法（标准的不受限 JSON 形态）。
    return violations
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}, got ${JSON.stringify(node.type)}`)
    return violations
  }
  const allowedFor = {
    properties: ['object'], required: ['object'], additionalProperties: ['object'],
    items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'],
  }
  for (const [key, types] of Object.entries(allowedFor)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      violations.push(`${path}.${key} is not supported on type "${node.type}"`)
    }
  }
  if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
    for (const [key, child] of Object.entries(node.properties)) {
      violations.push(...schemaViolations(child, `${path}.properties.${key}`))
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    violations.push(...schemaViolations(node.items, `${path}.items`))
  }
  return violations
}

/**
 * 造一个最小可用的 Host ctx。
 *
 * 只实现 apply() 真正会碰的成员：logger / on / effect / inject / get / tools /
 * settings。`inject(deps, cb)` 忠实模拟 cordis：**只有当全部依赖都在场时才调用
 * 回调**，并把它们挂到一个子 ctx 上；依赖缺席时静默等待。这正是插件必须能降级
 * 工作的场景，也让"有服务/无服务"两条路径都能被覆盖。
 *
 * @param services - 本用例提供的宿主服务（例如 systemPrompt / settings / llm）。
 * @returns mock ctx 与捕获到的注册物。
 */
function mockContext(services = {}) {
  const tools = []
  const listeners = new Map()
  const effects = []
  const sections = []
  const installed = []
  // tools 是宿主核心服务，默认在场；用例可显式传 { tools: undefined } 把它摘掉，
  // 用来验证"服务缺席时插件仍 active"。
  const toolsService = {
    register(tool) { tools.push(tool); return () => {} },
    schemas() { return tools.map((t) => ({ name: t.name })) },
  }
  const scoped = {}
  if (services.systemPrompt !== undefined) {
    scoped.systemPrompt = {
      section(section) { sections.push(section); return () => {} },
    }
  }
  if (services.settings !== undefined) {
    scoped.settings = {
      installSection(...args) { installed.push(args); },
    }
  }
  const available = { tools: toolsService, ...services, ...scoped }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    // 真实 cordis 的 effect(fn) 会**立即调用** fn，并把返回值当作 disposer。
    // 只收集不调用的话，所有走 effect 的注册（三个工具）都不会发生。
    effect(fn) { effects.push(fn()) },
    inject(deps, callback) {
      if (!deps.every((d) => available[d] !== undefined)) return
      const child = Object.create(ctx)
      for (const d of deps) child[d] = available[d]
      callback(child)
    },
    get(name) { return available[name] },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    ...available,
  }
  return { ctx, tools, listeners, effects, sections, installed }
}

test('inject 必须为空：硬依赖缺席会让插件 pending，进而拖死宿主启动', () => {
  assert.equal(name, 'dsh-tri-layer-memory')
  // 这是本次真实事故的回归断言。exports.inject 是**硬依赖**，任何一项在宿主启动时
  // 缺席，fiber 就永远停在 pending，宿主判定"有条目未激活"并拒绝启动：
  //   web boot: 1 entry did not activate
  //     dsh-tri-layer-memory: pending (waiting for service: settingsScope)
  // 全部服务改为 apply 内部 ctx.inject() 软等待后，这个数组必须保持为空。
  assert.deepEqual(inject, [], 'inject 必须为空数组——插件绝不能用硬依赖拖死宿主启动')
})

test('tools 在场：注册三个模型工具', () => {
  const { ctx, tools, listeners } = mockContext()
  assert.doesNotThrow(() => apply(ctx, {}), 'apply 抛错就等于插件挂载失败')
  assert.equal(tools.length, 3, '应注册 3 个模型工具')
  assert.ok(listeners.has('agent/pre-step'), '应注册 agent/pre-step 监听')
})

test('所有服务全部缺席：仍然 active，只是功能降级（不抛错、不留 pending）', () => {
  const { ctx, tools, listeners, sections } = mockContext({ tools: undefined })
  assert.doesNotThrow(() => apply(ctx, {}), '服务缺席绝不能让 apply 抛错')
  assert.equal(tools.length, 0, 'tools 缺席时不应注册任何工具')
  assert.equal(sections.length, 0, 'systemPrompt 缺席时不应注册提示段')
  // 关键：核心的 pre-step 投影不依赖任何服务，必须照常注册——
  // 这样即使宿主什么都没提供，插件也是"活着但降级"，而不是挂起。
  assert.ok(listeners.has('agent/pre-step'), 'pre-step 监听不依赖服务，应照常注册')
})

test('systemPrompt / settings 在场时：注册静态提示段与设置命名空间', () => {
  const { ctx, sections, installed } = mockContext({ systemPrompt: {}, settings: {} })
  apply(ctx, { selfTestAfterBoot: false })

  assert.equal(sections.length, 1, '应注册一个系统提示段')
  assert.equal(sections[0].name, 'dsh-tri-layer-memory')
  assert.equal(typeof sections[0].order, 'number')
  assert.match(sections[0].text, /三层记忆压缩引擎/)
  assert.match(sections[0].text, /L3 深层记忆/)
  // 静态段刻意不含实时读数：它要能稳定复用 KV cache。
  assert.doesNotMatch(sections[0].text, /本轮投影/)
})

test('systemPrompt 缺席时：不注册提示段，也不影响工具与监听', () => {
  const { ctx, tools, listeners, sections } = mockContext()
  assert.doesNotThrow(() => apply(ctx, { selfTestAfterBoot: false }))
  assert.equal(sections.length, 0)
  assert.equal(tools.length, 3)
  assert.ok(listeners.has('agent/pre-step'))
})

test('三个工具的 schema 全部落在宿主支持的类型子集内', () => {
  const { ctx, tools } = mockContext()
  apply(ctx, {})
  const names = tools.map((t) => t.name)
  assert.deepEqual(names, ['memory_recall', 'memory_state', 'memory_verify'])

  for (const tool of tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0, '工具必须有名字')
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} 必须有描述`)
    assert.ok(typeof tool.execute === 'function', `${tool.name} 必须有 execute`)

    // 挂载期真正的抛错点：ctx.tools.register 会跑 assertSupportedJsonSchema。
    const parameterViolations = schemaViolations(tool.parameters, `${tool.name}.parameters`)
    assert.deepEqual(parameterViolations, [], `${tool.name} 的参数 schema 不合规`)
    const outputViolations = schemaViolations(tool.output.schema, `${tool.name}.output.schema`)
    assert.deepEqual(outputViolations, [], `${tool.name} 的输出 schema 不合规`)

    assert.equal(tool.parameters.type, 'object', `${tool.name} 参数必须是 object 根`)
    assert.ok(tool.output.schema.type !== undefined, `${tool.name} 输出 schema 必须有 type`)
  }
})

test('memory_state / memory_verify 在空会话下也能执行并返回结构化结果', async () => {
  const { ctx, tools } = mockContext()
  apply(ctx, { l3Enabled: false, selfTestAfterBoot: false })
  const state = tools.find((t) => t.name === 'memory_state')
  const verify = tools.find((t) => t.name === 'memory_verify')

  const stateResult = await state.execute({}, { agent: { session: undefined } })
  assert.equal(stateResult.system, 'dsh-tri-layer-memory 三层记忆压缩引擎')
  assert.ok(stateResult.layers.L1 && stateResult.layers.L2 && stateResult.layers.L3, '三层读数都要在')
  assert.equal(stateResult.engine.className, '', 'mock ctx 下没有压缩引擎')

  const verifyResult = await verify.execute({ detail: 'developer' }, { agent: { session: undefined } })
  assert.equal(verifyResult.system, 'dsh-tri-layer-memory 验证报告')
  assert.ok(Array.isArray(verifyResult.verdicts) && verifyResult.verdicts.length >= 4, '应逐层给出判定')
  assert.ok(verifyResult.verdicts.some((v) => v.id === 'L3' && v.text.startsWith('SKIP')), 'L3 关闭时应为 SKIP')
})

test('工具参数校验：类型错误与枚举越界会被拦下', async () => {
  const { ctx, tools } = mockContext()
  apply(ctx, { l3Enabled: false, selfTestAfterBoot: false })
  const recall = tools.find((t) => t.name === 'memory_recall')

  await assert.rejects(
    () => recall.execute({ limit: 'not-a-number' }, { agent: {} }),
    /invalid arguments/,
    '字符串传给 number 参数应被拒绝',
  )
  const verify = tools.find((t) => t.name === 'memory_verify')
  await assert.rejects(
    () => verify.execute({ detail: 'nonsense' }, { agent: {} }),
    /invalid arguments/,
    '枚举外的取值应被拒绝',
  )
})

test('pre-step 监听会注入三层投影，且内容不变时不重复注入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-mount-'))
  try {
    const { ctx, listeners } = mockContext()
    apply(ctx, { l3Dir: dir, l3Enabled: true, l3Store: 'jsonl', l2Mode: 'extractive', selfTestAfterBoot: false })

    const entry = listeners.get('agent/pre-step')[0]
    // 造一个含 12 轮的合成会话：L1 默认保留 8 轮，应有 4 轮溢出。
    const events = []
    let seq = 0
    for (let turn = 1; turn <= 12; turn += 1) {
      events.push({ type: 'turn/start', seq: seq++, data: { turn } })
      events.push({ type: 'user/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮：请处理记忆压缩任务` }] } })
      events.push({ type: 'assistant/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮完成。` }] } })
      events.push({ type: 'turn/end', seq: seq++, data: { turn } })
    }
    const session = { id: 's-mount', events }
    const payload = { agent: { session }, turn: 12, step: 1, signal: { aborted: false } }
    const next = async () => ({ kind: 'enter', messages: [] })

    const first = await entry.listener(payload, next)
    assert.equal(first.messages.length, 1, '首轮应注入一条投影消息')
    const text = first.messages[0].content[0].text
    assert.match(text, /三层记忆 · 本轮投影/)
    assert.match(text, /L1 工作记忆/)
    assert.match(text, /L2 短期记忆/)
    assert.match(text, /最近 8 轮/, 'L1 默认保留 8 轮')
    assert.match(text, /较早的 4 轮已进入 L2\/L3/, '12 轮应有 4 轮溢出')
    assert.equal(first.messages[0].role, 'user', '注入必须是 user 角色消息')
    // v4 会话格式要求生产者自有的 kind：写 `{kind:'plugin'}` 会让整轮在写入时被拒绝。
    assert.equal(first.messages[0].source.kind, 'dsh-tri-layer-memory')
    assert.equal(first.messages[0].source.plugin, undefined, '不得再带已退役的 plugin 字段')

    // 内容未变 → 不重复注入（省 token，也避免同一份投影在 surface 里堆积）。
    const second = await entry.listener(payload, next)
    assert.equal(second.messages.length, 0, '投影未变化时不应重复注入')

    // 12 轮里 8 轮在 L1、4 轮在 L2 窗口内（l2RetainTurns 默认 24）→ 还没到 L3。
    // 此时 L3 后端已打开（目录已建），但尚未写入任何记录，所以只有目录没有文件。
    assert.ok(existsSync(dir), 'L3 后端应已打开（目录已创建）')

    // 再推进 30 轮：溢出超过 L2 保留窗口后应开始蒸馏进 L3。
    for (let turn = 13; turn <= 42; turn += 1) {
      events.push({ type: 'turn/start', seq: seq++, data: { turn } })
      events.push({ type: 'user/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮：继续` }] } })
      events.push({ type: 'turn/end', seq: seq++, data: { turn } })
    }
    await entry.listener(payload, next)
    // 用一个全新的 apply 重新打开同一个库，确认溢出内容确实被写进了 L3。
    const { ctx: ctx2, tools: tools2 } = mockContext()
    apply(ctx2, { l3Dir: dir, l3Enabled: true, l3Store: 'jsonl', selfTestAfterBoot: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const recall = tools2.find((t) => t.name === 'memory_recall')
    const result = await recall.execute({ query: '记忆压缩' }, { agent: { session } })
    // 必须断言**真的命中**：memory_recall 在未命中时同样会输出 "## L3 深层记忆"
    // 标题，只匹配标题等于什么都没验证。
    assert.match(result, /命中 \d+ 条/, `应真正检索到 L3 记录，实际输出：${result.slice(0, 200)}`)
    assert.match(result, /l3-/, '命中结果应带记录 id')
    assert.doesNotMatch(result, /未命中/, '不应是未命中分支')
    // 超出 L2 保留窗口的最旧轮应已作为 kind=turn 的记录落库。
    assert.match(result, /第1轮|第2轮|第3轮/, '最早溢出 L2 窗口的轮次应被蒸馏进 L3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('注入预算不足时按优先级降级，并在 memory_verify 里如实报告', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-budget-'))
  try {
    const { ctx, listeners, tools } = mockContext()
    // 预算压到下限：L1 标记放得下，L2 摘要会被截断，L3 索引大概率被丢。
    apply(ctx, {
      l3Dir: dir, l3Enabled: true, l3Store: 'jsonl', l2Mode: 'extractive',
      injectionBudgetTokens: 200, selfTestAfterBoot: false,
    })

    const events = []
    let seq = 0
    for (let turn = 1; turn <= 30; turn += 1) {
      events.push({ type: 'turn/start', seq: seq++, data: { turn } })
      events.push({ type: 'user/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮：记忆压缩任务，需要保留关键决策` }] } })
      events.push({ type: 'assistant/message', seq: seq++, data: { content: [{ type: 'text', text: `第${turn}轮完成。` }] } })
      events.push({ type: 'turn/end', seq: seq++, data: { turn } })
    }
    const session = { id: 's-budget', events }
    const entry = listeners.get('agent/pre-step')[0]
    const decision = await entry.listener(
      { agent: { session }, turn: 30, step: 1, signal: { aborted: false } },
      async () => ({ kind: 'enter', messages: [] }),
    )
    assert.equal(decision.messages.length, 1, '预算再紧也应注入点什么（至少是 L1 标记）')
    const text = decision.messages[0].content[0].text
    assert.match(text, /L1 工作记忆/, 'L1 是最高优先级，必须保留')
    // 预算 200 tokens 装不下完整的三块 → 必然发生截断或丢弃。
    const degraded = /被截断/.test(text) || !/L3 深层记忆/.test(text)
    assert.ok(degraded, `预算 200 应触发降级，实际投影：\n${text}`)

    // verify 必须如实报告预算使用情况，而不是假装一切正常。
    const verify = tools.find((t) => t.name === 'memory_verify')
    const report = await verify.execute({ detail: 'developer' }, { agent: { session } })
    const budgetVerdict = report.verdicts.find((v) => v.id === 'budget')
    assert.ok(budgetVerdict !== undefined, '验证报告应含 budget 判定')
    assert.match(budgetVerdict.text, /注入预算/)
    assert.ok(report.layers.injection.budgetTokens === 200, '报告里的预算应与配置一致')
    assert.ok(report.layers.injection.usedTokens <= 200, '报告里的实际用量不得超预算')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pre-step 监听在 next() 返回 reject 时不做任何事', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, { l3Enabled: false, selfTestAfterBoot: false })
  const entry = listeners.get('agent/pre-step')[0]
  const decision = await entry.listener(
    { agent: { session: { id: 's', events: [] } }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

test('readEvents：真实 Session 只有 snapshotEvents()，没有 events 属性（致命回归）', async () => {
  // 真实事故：DSH 0.2.0-rc.2 的 Session **没有 events 属性**，只有 snapshotEvents()。
  // 原实现只读 session.events → 恒返回 []，L1 窗口/L2 摘要/主线骨架在真实会话里
  // 全部静默失效；而所有单测都用 `{events: [...]}` 假会话，所以一路全绿也挡不住。
  // 症状：投影里只剩 L2/L3 的空壳文案，L1 段整段消失。
  const { ctx, listeners } = mockContext()
  apply(ctx, { selfTestAfterBoot: false })

  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '任务：造一个三层记忆插件' }] } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] } } },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
  ]

  // 只提供 snapshotEvents —— 这正是真实 Session 的形状。
  let called = 0
  const session = {
    id: 's-real',
    snapshotEvents() { called += 1; return events },
  }
  assert.equal('events' in session, false, '前提：这个假会话刻意没有 events 属性')

  const entry = listeners.get('agent/pre-step')[0]
  const decision = await entry.listener(
    { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )

  assert.ok(called > 0, '必须走 snapshotEvents() 这条路')
  assert.ok(Array.isArray(decision?.messages), 'pre-step 应返回 decision')
  // 关键断言：事件被真正读到了 —— 有 L1 段说明窗口非空。
  // 若 readEvents 退回只读 session.events，这里会只剩 L2/L3 空壳文案，L1 消失。
  const injected = (decision?.messages ?? [])
    .flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n')
  assert.match(injected, /工作记忆|里程碑/, `应注入 L1 或骨架段，实际注入：${injected.slice(0, 200)}`)
})

test('readEvents：snapshotEvents 抛错时不让 pre-step 挂掉', async () => {
  const { ctx, listeners } = mockContext()
  apply(ctx, { selfTestAfterBoot: false })
  const session = {
    id: 's-broken',
    snapshotEvents() { throw new Error('会话尚未就绪') },
  }
  const entry = listeners.get('agent/pre-step')[0]
  await assert.doesNotReject(async () => {
    await entry.listener(
      { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
      async () => ({ kind: 'enter', messages: [] }),
    )
  }, '会话未就绪不该让 pre-step 抛错')
})
