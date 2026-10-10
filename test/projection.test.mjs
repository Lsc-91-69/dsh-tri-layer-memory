/**
 * test/projection.test.mjs — 「思维栏」投影的契约与行为测试。
 *
 * 为什么需要它：投影是**跨进程的接口**——宿主算出 `TriLayerView`，框架把它送进
 * 浏览器，客户端 `useProjection('tri-layer-memory')` 按同一份形状渲染。两侧没有
 * 编译器帮忙对齐，key 写错、字段少一个、上限没做，全都只会在用户打开标签页时暴露。
 * 这里固化四件事：
 *
 * 1. **引用纪律**：不关心的事件必须返回同一个状态引用（框架用 `Object.is` 判断
 *    "要不要重算视图/广播"，返回新对象会产生无谓的下游工作）；
 * 2. **形状**：`wire.view` 的键集与 `TriLayerView` 逐字一致，且过得了 `viewSchema`；
 * 3. **上限**：`l3.records` 最多 200 条、按新近度降序（投影体不能随库无界增长）；
 * 4. **接线**：`apply()` 真的把当前读数喂进投影，且新会话第 1 轮就带上任务标题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_VIEW_RECORDS, PROJECTION_KEY, createTriLayerProjection } from '../src/host/projection.ts'
import { apply as applyHost } from '../src/host/index.ts'

/** 造一条 L3 记录（只填投影会读的字段）。 */
function record(index, createdAt, sessionId = 's-1') {
  return {
    id: `l3-${createdAt.toString(36)}-${index.toString(36)}`,
    kind: 'turn',
    createdAt,
    sessionId,
    turnFrom: index,
    turnTo: index,
    text: `第 ${index} 轮的正文`,
    tokens: 4,
    keywords: [],
    refs: [],
  }
}

/** 一份完整读数（各用例只改自己关心的部分）。 */
function feedInput(overrides = {}) {
  return {
    taskTitle: '给三层记忆插件加一个思维栏',
    mainline: [
      { turn: 1, title: '给三层记忆插件加一个思维栏', cause: '会话初始任务', detail: '', category: '任务', tokens: 12 },
      { turn: 4, turnTo: 6, title: '投影注册失败', cause: '连续 3 轮未解决', detail: '', category: '失败', tokens: 10 },
    ],
    l1: { retainTurns: 8, turns: 3, evicted: 0 },
    l2: { summary: '已完成规格阅读。', turnFrom: 1, turnTo: 2, mode: 'extractive' },
    l3: { backend: 'sqlite', count: 3, tokens: 12, records: [record(1, 1000), record(2, 2000), record(3, 3000)] },
    recallTool: 'memory_recall',
    ...overrides,
  }
}

/** 折一条轮边界事件（`apply` 只在这些事件上折 feed）。 */
function foldBoundary(definition, state, type = 'turn/end') {
  return definition.apply(state, { type, seq: 1, data: {} })
}

test('key 与客户端约定一致，init 给出完整空骨架', () => {
  const projection = createTriLayerProjection()
  assert.equal(PROJECTION_KEY, 'tri-layer-memory', '客户端 useProjection 用的就是这个字符串')
  assert.equal(projection.key, PROJECTION_KEY)
  assert.equal(projection.definition.key, PROJECTION_KEY)
  // **形状或折叠语义改了就必须动版本号**：框架只认 ver 与落盘行相等的缓存行，
  // 不等就丢掉、从 init 重新折叠。1 = 增加 l3 的本会话口径（sessionCount /
  // sessionTokens）。2 = **折叠语义变了**：读数不再只由 pre-step 写，`apply` 在
  // "本会话还没有 feed"时会补算一次——版本 1 的行是旧语义折出来的，会被
  // `restore` 当成可用行直接喂给客户端（而 `restore` 只在检查点之后的事件上调用
  // `apply`，检查点又总在日志末尾，于是补算这条路对老会话一次都走不到）。
  // 3 = **形状变了**：L3 记录多出 `sessionId` / `own`，`l3` 段多出 `sessionId`。
  //     版本 2 的行里那些记录**没有**这两个字段，`viewSchema.parse()` 会直接抛错
  //     （抛错发生在框架侧，插件收不到，表现就是"思维栏空着"）。
  assert.equal(projection.definition.stateVersion, 3, 'stateVersion 必须是非负整数，且随状态形状/折叠语义变化')

  const state = projection.definition.init({ id: 's-empty' }, 0)
  assert.equal(state.sessionId, 's-empty', '会话 id 要进状态：恢复后据此重新绑定活 feed')
  assert.equal(state.updatedAt, 0, '没喂过读数时 updatedAt 为 0（客户端据此显示"尚未就绪"）')
  assert.deepEqual(state.mainline, [])
  assert.equal(state.l2, null)
  assert.equal(state.l3.count, 0)
  assert.equal(state.l3.backend, null)
  assert.ok(Array.isArray(state.l3.records))

  // 空骨架也要过 schema：框架读缓存行时会真的 parse 一次。
  assert.doesNotThrow(() => projection.definition.stateSchema.parse(state))
  assert.doesNotThrow(() => projection.definition.wire.viewSchema.parse(projection.definition.wire.view(state)))
})

test('apply 对不关心的事件返回同一个引用（框架的 Object.is 闸门）', () => {
  const projection = createTriLayerProjection()
  const state = projection.definition.init({ id: 's-1' }, 0)
  const irrelevant = [
    { type: 'user/message', seq: 1, data: {} },
    { type: 'assistant/message', seq: 2, data: {} },
    { type: 'tool/result', seq: 3, data: {} },
    { type: 'compaction/summary', seq: 4, data: {} },
    { type: 'goal/change', seq: 5, data: {} },
    { seq: 6, data: {} },
    { type: 42, seq: 7, data: {} },
  ]
  for (const event of irrelevant) {
    assert.equal(projection.definition.apply(state, event), state,
      `事件 ${String(event.type)} 不该产生新状态引用`)
  }
})

test('feed + 轮边界：状态换新引用，视图带上读数；feed 没变则仍是同一引用', () => {
  const projection = createTriLayerProjection()
  let state = projection.definition.init({ id: 's-1' }, 0)

  projection.feed('s-1', feedInput(), 1_700_000_000_000)
  const afterFeed = foldBoundary(projection.definition, state)
  assert.notEqual(afterFeed, state, '读数变了，轮边界必须换新引用（否则框架不会重算视图）')
  assert.equal(afterFeed.updatedAt, 1_700_000_000_000)
  assert.equal(afterFeed.taskTitle, '给三层记忆插件加一个思维栏')

  // 第二次轮边界：feed 没有新内容 → 同一引用，零下游工作。
  assert.equal(foldBoundary(projection.definition, afterFeed), afterFeed)
  // 同一份内容再喂一次也不该推进版本（客户端不该为一样的读数重渲染）。
  projection.feed('s-1', feedInput(), 1_800_000_000_000)
  assert.equal(foldBoundary(projection.definition, afterFeed), afterFeed)
  assert.equal(afterFeed.updatedAt, 1_700_000_000_000, '内容没变，时间戳也不该动')

  // 会话之外的 feed 不会串到本会话上。
  projection.feed('s-other', feedInput({ taskTitle: '别的会话' }), 1_900_000_000_000)
  assert.equal(foldBoundary(projection.definition, afterFeed), afterFeed)
  state = afterFeed
})

test('view 的形状与 TriLayerView 接口逐字一致，且过得了 viewSchema', () => {
  const projection = createTriLayerProjection()
  projection.feed('s-1', feedInput())
  const state = foldBoundary(projection.definition, projection.definition.init({ id: 's-1' }, 0))
  const view = projection.definition.wire.view(state)

  assert.deepEqual(Object.keys(view).sort(), [
    'l1', 'l2', 'l3', 'mainline', 'mainlineTokens', 'recallTool', 'taskTitle', 'updatedAt',
  ], '键集就是接口：两侧靠它对齐')
  assert.equal(view.taskTitle, '给三层记忆插件加一个思维栏')
  assert.deepEqual(view.mainline[0], {
    turn: 1, title: '给三层记忆插件加一个思维栏', cause: '会话初始任务', category: '任务',
  }, '单轮条目不带 turnTo')
  assert.deepEqual(view.mainline[1], {
    turn: 4, turnTo: 6, title: '投影注册失败', cause: '连续 3 轮未解决', category: '失败',
  }, '跨轮条目带 turnTo')
  assert.equal(view.mainlineTokens, 22, '缺省按各条里程碑的 tokens 求和（与列表同一口径）')
  assert.deepEqual(view.l1, { retainTurns: 8, turns: 3, evicted: 0 })
  assert.deepEqual(view.l2, { summary: '已完成规格阅读。', turnFrom: 1, turnTo: 2, mode: 'extractive' })
  assert.equal(view.l3.backend, 'sqlite')
  assert.equal(view.l3.count, 3)
  assert.equal(view.l3.sessionCount, 3, '三条记录都属于本会话（sessionId=s-1）')
  assert.equal(view.l3.sessionTokens, 12)
  assert.equal(view.l3.sessionId, 's-1', 'L3 段要带本状态的会话 id（客户端据此不必自己猜）')
  assert.deepEqual(Object.keys(view.l3.records[0]).sort(),
    ['id', 'kind', 'own', 'sessionId', 'text', 'tokens', 'turnFrom', 'turnTo'],
    '记录条目字段固定：sessionId / own 是本次新增的"这条属于谁"')
  assert.equal(view.recallTool, 'memory_recall')
  assert.equal(typeof view.updatedAt, 'number')

  // 框架发布前会 parse 一次：形状不对就是运行时抛错，而抛错发生在框架侧。
  assert.doesNotThrow(() => projection.definition.wire.viewSchema.parse(view))
  // 视图引用稳定：同一个状态对象两次读取必须返回同一个引用（Object.is 广播闸门）。
  assert.equal(projection.definition.wire.view(state), view)
})

test('stateSchema 能解析落盘缓存回来的普通 JSON（checkpoint 前提）', () => {
  const projection = createTriLayerProjection()
  projection.feed('s-1', feedInput())
  const state = foldBoundary(projection.definition, projection.definition.init({ id: 's-1' }, 0))

  // 缓存的 val 是普通 JSON：恢复时框架会 stateSchema.parse(row.val) 再继续折叠。
  const restored = projection.definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(restored, state)
  assert.deepEqual(projection.definition.wire.view(restored), projection.definition.wire.view(state))
  // 恢复后的状态仍能重新绑回活 feed：这正是 sessionId 存在状态里的理由。
  projection.feed('s-1', feedInput({ taskTitle: '恢复之后的新标题' }))
  const next = foldBoundary(projection.definition, restored)
  assert.equal(next.taskTitle, '恢复之后的新标题')
})

test('l3.records 最多 200 条，且按新近度降序', () => {
  const records = []
  for (let index = 0; index < MAX_VIEW_RECORDS + 37; index += 1) records.push(record(index, 1_000 + index))
  // 故意打乱输入顺序：截断必须自己排序，不能依赖调用方的顺序。
  records.reverse()

  const projection = createTriLayerProjection()
  projection.feed('s-1', feedInput({ l3: { backend: 'jsonl', count: records.length, tokens: 999, records } }))
  const state = foldBoundary(projection.definition, projection.definition.init({ id: 's-1' }, 0))
  const view = projection.definition.wire.view(state)

  assert.equal(view.l3.records.length, MAX_VIEW_RECORDS, `最多 ${MAX_VIEW_RECORDS} 条`)
  assert.equal(view.l3.count, records.length, 'count 仍是整库条数，不是截断后的条数')
  assert.equal(view.l3.records[0].turnFrom, MAX_VIEW_RECORDS + 36, '第一条是最近的一条')
  const times = view.l3.records.map((entry) => parseInt(entry.id.split('-')[1], 36))
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index - 1] >= times[index], '必须按新近度降序')
  }
  assert.doesNotThrow(() => projection.definition.wire.viewSchema.parse(view))
})

test('L3 的两个口径：整库 count 与本会话 sessionCount 分开报（共享库不许被读成本会话的量）', () => {
  const records = [
    record(1, 1000),
    record(2, 2000),
    record(3, 3000, 's-other'),
    record(4, 4000, 's-other'),
    record(5, 5000, 's-third'),
  ]

  const projection = createTriLayerProjection()
  projection.feed('s-1', feedInput({ l3: { backend: 'sqlite', count: records.length, tokens: 20, records } }))
  const state = foldBoundary(projection.definition, projection.definition.init({ id: 's-1' }, 0))
  const view = projection.definition.wire.view(state)

  assert.equal(view.l3.count, 5, '整库口径：L3 是跨会话共享的库，总数就是全库')
  assert.equal(view.l3.sessionCount, 2, '本会话口径：只数 sessionId 等于本会话的那些')
  assert.equal(view.l3.sessionTokens, 8, '本会话 token 与条数同一口径')
  assert.equal(view.l3.records.length, 5, '记录列表仍是整库的（要看得到别的会话蒸馏了什么）')
  assert.doesNotThrow(() => projection.definition.wire.viewSchema.parse(view))
})

test('整库列表里每一条都自报所属会话：别的会话的「第 3 轮」不许看着像本会话的', () => {
  // 这是**误读风险**的修法：列表是整库的（选 (b) 而不是"只显示本会话"），但每条
  // 记录必须带上 `sessionId` 与宿主算好的 `own`。少了它们，读者会把别的会话的
  // 轮次号当成自己的——L3 的轮次只有配上会话 id 才有意义。
  const records = [
    record(1, 1000, 's-1'),
    record(2, 2000, 's-1'),
    record(3, 3000, 's-other'),
    record(4, 4000, 's-third'),
  ]

  const projection = createTriLayerProjection()
  projection.feed('s-1', feedInput({ l3: { backend: 'sqlite', count: 4, tokens: 16, records } }))
  const state = foldBoundary(projection.definition, projection.definition.init({ id: 's-1' }, 0))
  const view = projection.definition.wire.view(state)

  assert.equal(view.l3.sessionId, 's-1', 'L3 段带上本状态的会话 id')
  // 每一条都带 sessionId，且与原始记录逐条对应（顺序是新近度降序：4,3,2,1）。
  assert.deepEqual(view.l3.records.map((entry) => entry.sessionId),
    ['s-third', 's-other', 's-1', 's-1'], '每条的 sessionId 必须原样带出，不许丢')
  assert.deepEqual(view.l3.records.map((entry) => entry.own),
    [false, false, true, true], 'own 由宿主算好：客户端没有可靠的会话 id 可用来自己判')
  // 别的会话的记录**不是**被过滤掉——列表仍是整库的（选 (b) 的理由就在这里）。
  assert.equal(view.l3.records.length, 4, '整库列表不许被过滤成本会话的')
  assert.ok(view.l3.records.some((entry) => entry.own === false), '必须能看到别的会话蒸馏了什么')

  // 换个会话读同一份库：own 的判定必须跟着**读的会话**变，而不是跟着记录固化。
  const other = createTriLayerProjection()
  other.feed('s-other', feedInput({ l3: { backend: 'sqlite', count: 4, tokens: 16, records } }))
  const otherView = other.definition.wire.view(foldBoundary(other.definition, other.definition.init({ id: 's-other' }, 0)))
  assert.equal(otherView.l3.sessionId, 's-other')
  assert.deepEqual(otherView.l3.records.map((entry) => entry.own),
    [false, true, false, false], 'own 是"相对本会话"的，不是记录上的固定属性')

  assert.doesNotThrow(() => projection.definition.wire.viewSchema.parse(view))
})

// ── 接线：apply() → pre-step → 投影 ─────────────────────────────────────

/**
 * 造一个能跑通 `apply()` 的最小 Host ctx。
 *
 * `inject(deps, cb)` 与 cordis 一致：依赖全在场才调用回调（缺席就静默等待），
 * 这样"服务在场/缺席"两条路径都能被覆盖。
 */
function mockHostContext(services = {}) {
  const listeners = new Map()
  const registrations = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    effect(fn) { effects.push(fn()) },
    inject(deps, callback) {
      if (!deps.every((dep) => ctx[dep] !== undefined)) return
      const child = Object.create(ctx)
      for (const dep of deps) child[dep] = ctx[dep]
      callback(child)
    },
    get(name) { return ctx[name] },
  }
  Object.assign(ctx, services)
  return { ctx, listeners, registrations, effects }
}

/** 造一个会话事件流：初始任务 + 若干轮。 */
function sessionEvents(turns) {
  const events = []
  let seq = 0
  const push = (type, data) => { events.push({ type, seq: seq++, data }) }
  push('agent/inbox/spliced', {
    inserted: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '给 DSH 三层记忆插件加一个思维栏' }] }],
  })
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    push('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `第${turn}轮：继续` }] })
    push('assistant/message', { content: [{ type: 'text', text: `第${turn}轮完成。` }] })
    push('turn/end', { turn })
  }
  return events
}

/** 跑一次 pre-step，返回决策对象。 */
async function runPreStep(listeners, session, turn) {
  const entry = listeners.get('agent/pre-step')[0]
  return entry.listener(
    { agent: { session }, turn, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  )
}

test('sessionProjections 在场：apply() 注册投影，pre-step 把读数喂进状态', async () => {
  const { ctx, listeners, registrations } = mockHostContext({
    sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
  })
  applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', selfTestAfterBoot: false })

  assert.equal(registrations.length, 1, '应恰好注册一个投影单元')
  const definition = registrations[0]
  assert.equal(definition.key, 'tri-layer-memory')
  assert.equal(typeof definition.apply, 'function')
  assert.equal(typeof definition.wire.view, 'function')

  const session = { id: 's-live', events: sessionEvents(3) }
  const decision = await runPreStep(listeners, session, 3)
  const text = decision.messages[0].content[0].text
  assert.match(text, /三层记忆 · 本轮投影/)
  assert.match(text, /任务：给 DSH 三层记忆插件加一个思维栏/, '骨架块第一轮就该点明任务')

  // 宿主喂进来的读数要能被轮边界折进状态、并从 view 里读出来。
  const state = definition.apply(definition.init({ id: 's-live' }, 0), { type: 'turn/end', seq: 99, data: {} })
  const view = definition.wire.view(state)
  assert.equal(view.taskTitle, '给 DSH 三层记忆插件加一个思维栏')
  assert.equal(view.l1.retainTurns, 8)
  // 4 = 3 个真实轮 + 1 个虚拟轮（`turn/start` 之前的投递事件归入 turn -1，
  // 见 l1-working.ts 的 projectTurns）——它们同样属于 L1 窗口。
  assert.equal(view.l1.turns, 4, '三轮加一条轮前投递，都在 L1 窗口内')
  assert.equal(view.l1.evicted, 0)
  assert.equal(view.l2, null, '没有溢出轮就没有摘要')
  assert.equal(view.l3.count, 0)
  assert.equal(view.l3.backend, null, 'L3 关掉时后端未打开')
  assert.equal(view.recallTool, 'memory_recall')
  assert.ok(view.updatedAt > 0, '喂过读数后必须有时间戳')
  assert.ok(view.mainline.length >= 1, '骨架应含初始任务条目')
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(view), '宿主产出的值必须过 wire 校验')
})

test('sessionProjections 缺席：不注册投影，插件照常 active（不抛错）', async () => {
  const { ctx, listeners, registrations } = mockHostContext()
  assert.doesNotThrow(() => applyHost(ctx, { l3Enabled: false, selfTestAfterBoot: false }),
    '投影服务缺席绝不能让 apply 抛错')
  assert.equal(registrations.length, 0)
  // 核心的 pre-step 投影不依赖任何服务，必须照常注册。
  assert.ok(listeners.has('agent/pre-step'))
  const decision = await runPreStep(listeners, { id: 's-1', events: sessionEvents(2) }, 2)
  assert.match(decision.messages[0].content[0].text, /三层记忆 · 本轮投影/)
})

test('骨架还没提取出来时，注入块至少显示任务标题行（新会话不再只有"无可提取"）', async () => {
  const { ctx, listeners } = mockHostContext()
  applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', selfTestAfterBoot: false })

  // 第 1 步：会话还没有事件，骨架提取得到空数组，水位停在"溢出 0 轮"。
  const session = { id: 's-fresh', events: [] }
  const first = await runPreStep(listeners, session, 1)
  assert.match(first.messages[0].content[0].text, /本会话尚无可提取的里程碑/)
  assert.doesNotMatch(first.messages[0].content[0].text, /任务：/, '此时确实还不知道任务')

  // 第 2 步：任务已经在日志里了，但溢出轮数没变（还是 0），骨架不会重新提取——
  // 任务标题却已经可读。这正是用户看到的那一幕：有任务、却只有"无可提取"。
  session.events = sessionEvents(2)
  const second = await runPreStep(listeners, session, 1)
  const text = second.messages[0].content[0].text
  assert.match(text, /## 里程碑主线骨架/, '骨架块仍应在场')
  assert.match(text, /任务：给 DSH 三层记忆插件加一个思维栏/,
    '任务标题在第 1 轮就已知，不该等到有溢出轮')
})

// ── 冷启动：打开会话就该有内容（用户报的 bug）─────────────────────────────
//
// 症状：每次打开 DSH，思维栏都是空的（"记忆层尚未就绪"），要跑完一轮会话才显示
// 完整内容。成因在平台侧读路径：框架**第一次读**投影时是 `init` + 逐事件 `apply`
// 折叠整份会话日志（session-projection 的 buildCell/advanceCell），而 feed 只由
// `agent/pre-step` 写——进程刚起来时一次都没跑过，折出来就是空骨架。
//
// 所以断言必须绕开 pre-step：只折叠日志（加上"打开会话"那一记 session/created），
// 投影里就该有内容。

/** 模拟框架的惰性折叠：init + 逐事件 apply，全程不跑 pre-step。 */
function foldSession(definition, sessionId, events) {
  let state = definition.init({ id: sessionId }, 0)
  for (const event of events) state = definition.apply(state, event)
  return state
}

/** 触发一次监听（宿主事件在本测试里是同步派发的）。 */
function fire(listeners, event, payload) {
  const entries = listeners.get(event) ?? []
  for (const { listener } of entries) listener(payload)
  return entries.length
}

test('回归：没跑过 pre-step，会话一发布（session/created）投影里就有内容', () => {
  const { ctx, listeners, registrations } = mockHostContext({
    sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
  })
  applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', selfTestAfterBoot: false })
  const definition = registrations[0]

  const session = { id: 's-cold', events: sessionEvents(3) }
  assert.equal(fire(listeners, 'session/created', session), 1, '应注册 session/created 补算钩子')

  // 注意：这里没有 runPreStep —— 正是用户"打开 DSH 还没跑任何一轮"的那一幕。
  const state = foldSession(definition, 's-cold', session.events)
  const view = definition.wire.view(state)

  assert.ok(view.updatedAt > 0, '打开会话就该有读数（过去这里是 0，客户端显示"尚未就绪"）')
  assert.equal(view.taskTitle, '给 DSH 三层记忆插件加一个思维栏')
  assert.ok(view.mainline.length >= 1, '主线骨架在打开会话时就该从日志里提取出来')
  assert.equal(view.l1.turns, 4, 'L1 窗口同样来自日志：3 轮 + 轮前投递')
  assert.equal(view.l1.evicted, 0)
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(view))

  // 空日志（新会话 / 子代理会话）不该假装"就绪"：没有任何可显示的东西。
  const empty = { id: 's-empty', events: [] }
  fire(listeners, 'session/created', empty)
  const emptyState = foldSession(definition, 's-empty', [])
  assert.equal(definition.wire.view(emptyState).updatedAt, 0, '空会话仍是"尚未就绪"')
})

test('回归：session/created 没送到（HMR 重载/插件晚装载）时，折叠也能靠 sessions 服务补算', () => {
  const session = { id: 's-late', events: sessionEvents(2) }
  const { ctx, registrations } = mockHostContext({
    sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
    // ctx.get('sessions') 的兜底面：按 id 换回活会话。
    sessions: { get: (id) => (id === 's-late' ? session : undefined) },
  })
  applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', selfTestAfterBoot: false })
  const definition = registrations[0]

  // 刻意**不**派发 session/created：模拟插件是在会话发布之后才装载的。
  const state = foldSession(definition, 's-late', session.events)
  const view = definition.wire.view(state)
  assert.ok(view.updatedAt > 0, '折叠时就该按 id 找回活会话并补算')
  assert.equal(view.taskTitle, '给 DSH 三层记忆插件加一个思维栏')
  assert.equal(view.l1.turns, 3)

  // 会话作用域：找不回来的 id 不许贴别人的读数，也不许抛错。
  const other = foldSession(definition, 's-unknown', [{ type: 'turn/end', seq: 1, data: {} }])
  assert.equal(definition.wire.view(other).updatedAt, 0, '别的会话的读数绝不能串进来')
})

test('会话离场即丢掉 feed：死会话不占名额，也不会把旧读数贴给新会话', () => {
  const { ctx, listeners, registrations } = mockHostContext({
    sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
  })
  applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', selfTestAfterBoot: false })
  const definition = registrations[0]

  const session = { id: 's-doomed', events: sessionEvents(1) }
  fire(listeners, 'session/created', session)
  assert.ok(definition.wire.view(foldSession(definition, 's-doomed', session.events)).updatedAt > 0)

  assert.equal(fire(listeners, 'session/disposed', session), 1, '应注册 session/disposed 清理钩子')
  const after = foldSession(definition, 's-doomed', [{ type: 'turn/end', seq: 1, data: {} }])
  assert.equal(definition.wire.view(after).updatedAt, 0, 'feed 已随会话离场丢掉')
})

test('feed 一变就在下一个事件折叠（不再等轮边界）：半轮延迟的来源与修法', () => {
  const projection = createTriLayerProjection()
  const state = projection.definition.init({ id: 's-1' }, 0)

  projection.feed('s-1', feedInput(), 1_700_000_000_000)
  // 刻意用**非**轮边界事件：过去这里返回同一引用，读数要等到下一个 turn/start|turn/end
  // 才可见（用户看到的"半轮延迟"）。
  const folded = projection.definition.apply(state, { type: 'tool/result', seq: 7, data: {} })
  assert.notEqual(folded, state, 'feed 变了就该折，不该等到轮边界')
  assert.equal(folded.updatedAt, 1_700_000_000_000)
  assert.equal(folded.taskTitle, '给三层记忆插件加一个思维栏')

  // 折过之后同一份 feed 不再产生新引用（框架的 Object.is 闸门照旧）。
  assert.equal(projection.definition.apply(folded, { type: 'step/start', seq: 8, data: {} }), folded)
})

test('hydrate 回调抛错不会打断折叠：没有内容，但状态照常往前走', () => {
  let calls = 0
  const projection = createTriLayerProjection({
    hydrate() { calls += 1; throw new Error('补算炸了') },
  })
  const state = projection.definition.init({ id: 's-1' }, 0)
  let folded
  assert.doesNotThrow(() => { folded = projection.definition.apply(state, { type: 'turn/end', seq: 1, data: {} }) })
  assert.equal(folded, state, '补算失败 = 没有新内容，返回同一引用')
  assert.equal(calls, 1, '没有 feed 时才补算：失败不留半个 feed，所以下次折叠还会再试一次')
})

// ── 补算诊断：这条链上每一步过去都是静默的 ────────────────────────────────
//
// 用户报的故障是"重启后打开老会话，思维栏还是空的"。空着的原因至少有四种——
// 投影没注册 / 补算没被调用 / 补算失败 / 补算了但 feed 没落地——而它们在观察面上
// 过去完全同形（都是 `updatedAt: 0`）。下面这组用例固化的是"每一种都要留痕"：
// 轨迹文件里的 `blockedAt` 必须一眼指出断在哪一步。

/** 读一个会话的补算诊断（`<l3Dir>/<sessionId>.hydrate.json`）。 */
function readTrace(dir, sessionId) {
  const file = join(dir, `${sessionId}.hydrate.json`)
  assert.ok(existsSync(file), `补算诊断必须落盘：${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('补算诊断：成功路径没有断点（blockedAt: null），注册与 feed 落地都有据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-hydrate-ok-'))
  try {
    const session = { id: 's-ok', events: sessionEvents(2) }
    const { ctx, registrations } = mockHostContext({
      sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
      sessions: { get: (id) => (id === 's-ok' ? session : undefined) },
    })
    applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', l3Dir: dir, selfTestAfterBoot: false })
    const definition = registrations[0]

    // 刻意**不**派发 session/created：走折叠里的 byId 兜底那条路。
    const state = foldSession(definition, 's-ok', session.events)
    assert.ok(definition.wire.view(state).updatedAt > 0, '补算成功，投影里应有读数')
    // 折叠计数走微任务合并落盘（一次折叠一个文件），读文件前先让它跑完。
    await null

    const trace = readTrace(dir, 's-ok')
    assert.equal(trace.register.injectRan, true, '软等待回调应执行过')
    assert.equal(trace.register.calls, 1, '投影应恰好注册一次')
    assert.equal(trace.register.error, null)
    assert.equal(trace.sessions.service, 'ok', 'sessions 服务应拿得到')
    assert.equal(trace.sessions.lookup, 'found', 'get(id) 应找回活会话')
    assert.equal(trace.hydrate.byPath['byId:sessions'], 1, '本次补算走的是服务查找那条路')
    assert.equal(trace.hydrate.fed, 1)
    assert.equal(trace.hydrate.sessionMissing, 0)
    assert.equal(trace.hydrate.threw.length, 0)
    assert.equal(trace.hydrate.feedLanded, true, '最终归宿：feed 真的写进了投影')
    assert.ok(trace.fold.applies >= 1, '框架折叠过本会话（apply 被调用）')
    assert.equal(trace.blockedAt, null, '这条链上没有断点')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补算诊断：兜底拿不到 sessions 服务时不崩，且用折叠进来的事件自己算出内容', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-hydrate-nosvc-'))
  try {
    const { ctx, registrations } = mockHostContext({
      sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
      // 刻意不给 sessions：这是 isolate / 拓扑导致 ctx.get('sessions') 恒 undefined 的那一幕。
    })
    applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', l3Dir: dir, selfTestAfterBoot: false })
    const definition = registrations[0]

    let folded
    assert.doesNotThrow(() => {
      folded = foldSession(definition, 's-ghost', sessionEvents(1))
    }, '补算拿不到会话绝不能打断框架的折叠')
    // **这条断言就是本次故障的修法**：会话服务拿不到时，读数由折叠过程中累积的事件
    // 派生出来——客户端打开会话看到的是内容，而不是"记忆层尚未就绪"。
    // （修之前这里恒为 0：补算找不到会话 = 面板空着，而那一刻正是用户打开会话的时刻。）
    const view = definition.wire.view(folded)
    assert.ok(view.updatedAt > 0, '拿不到会话也要有内容：事件是那一刻唯一可用的数据源')
    assert.equal(view.taskTitle, '给 DSH 三层记忆插件加一个思维栏', '任务标题可以从事件流推出来')
    assert.ok(view.mainline.length >= 1, '骨架同样从事件流提取')
    assert.equal(view.l2, null, 'L2 摘要是模型产物：新进程还没生成，如实报 null 而不是编一份')
    await null

    const trace = readTrace(dir, 's-ghost')
    assert.equal(trace.sessions.service, 'undefined')
    assert.equal(trace.sessions.lookup, 'untried', '服务都没有，按 id 查找压根没发生过')
    assert.ok(trace.hydrate.sessionMissing >= 1, '服务拿不到这件事仍然要留痕')
    assert.equal(trace.hydrate.fed, 0, 'byId 补算一次都没成功')
    assert.ok(trace.fold.derived >= 1, '兜底派生接管了：读数由事件算出')
    assert.equal(trace.hydrate.feedLanded, true, '派生结果同样写进 feed（后续 apply 会折它）')
    assert.equal(trace.blockedAt, null, '有派生兜底，这条链没有断点')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补算诊断：补算抛错时异常原文进轨迹，折叠照常往前走', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-hydrate-throw-'))
  try {
    // 事件形状坏掉（读 data 就抛）：补算链里第一处读事件的地方就会炸。
    const broken = { type: 'turn/start', seq: 0, get data() { throw new Error('事件读不出来') } }
    const session = { id: 's-boom', events: [broken] }
    const { ctx, registrations } = mockHostContext({
      sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
      sessions: { get: (id) => (id === 's-boom' ? session : undefined) },
    })
    applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', l3Dir: dir, selfTestAfterBoot: false })
    const definition = registrations[0]

    let folded
    assert.doesNotThrow(() => {
      folded = foldSession(definition, 's-boom', [broken])
    }, '补算抛错绝不能打断折叠')
    assert.equal(definition.wire.view(folded).updatedAt, 0)
    await null

    const trace = readTrace(dir, 's-boom')
    assert.equal(trace.hydrate.fed, 0)
    assert.equal(trace.hydrate.threw.length, 1, '抛错必须留痕（过去是被静默 catch 吃掉的）')
    assert.match(trace.hydrate.threw[0].message, /事件读不出来/, '必须记异常原文，否则无法定位')
    assert.match(trace.blockedAt, /补算抛错/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补算诊断：session/created 的触发次数与"载荷是不是活会话"都记下来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-hydrate-created-'))
  try {
    const { ctx, listeners, registrations } = mockHostContext({
      sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
    })
    applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', l3Dir: dir, selfTestAfterBoot: false })
    assert.equal(registrations.length, 1)

    const live = { id: 's-live2', events: sessionEvents(1) }
    const empty = { id: 's-empty2', events: [] }
    assert.equal(fire(listeners, 'session/created', live), 1, 'session/created 监听应已注册')
    fire(listeners, 'session/created', empty)

    const liveTrace = readTrace(dir, 's-live2')
    assert.equal(liveTrace.created.registered, true)
    assert.equal(liveTrace.created.fired, 1)
    assert.equal(liveTrace.created.live, 1, '载荷是活 Session（能读出日志）')
    assert.equal(liveTrace.hydrate.byPath['created'], 1, '补算应来自 session/created 这条路')
    assert.equal(liveTrace.hydrate.fed, 1)
    assert.equal(liveTrace.hydrate.feedLanded, true)
    assert.equal(liveTrace.blockedAt, null)

    const emptyTrace = readTrace(dir, 's-empty2')
    assert.equal(emptyTrace.created.fired, 1)
    assert.equal(emptyTrace.created.live, 1, '空日志会话仍是活 Session——载荷形状是对的')
    assert.equal(emptyTrace.created.emptyLog, 1, '空日志要单独计数：它不是"补算坏了"')
    assert.equal(emptyTrace.hydrate.emptyLog, 1)
    assert.equal(emptyTrace.hydrate.fed, 0)
    assert.equal(emptyTrace.hydrate.feedLanded, false)
    assert.match(emptyTrace.blockedAt, /日志为空/, '空会话的断点说法必须与"找不到会话"区分开')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补算诊断：投影服务缺席时注册段留痕（指出投影永远不会注册）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-hydrate-noreg-'))
  try {
    const { ctx, listeners } = mockHostContext()  // 没有 sessionProjections
    assert.doesNotThrow(() => applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', l3Dir: dir, selfTestAfterBoot: false }))

    // pre-step 是必然会被调用的钩子：注册兜底与轨迹落盘都挂在那里。
    await runPreStep(listeners, { id: 's-noreg', events: sessionEvents(1) }, 1)

    const trace = readTrace(dir, 's-noreg')
    assert.equal(trace.register.injectRan, false, '服务缺席时软等待回调不该执行')
    assert.equal(trace.register.calls, 0)
    assert.equal(trace.register.registryVia, 'none')
    assert.match(trace.blockedAt, /注册段没跑/, '断点必须指到注册这一步')
    // 插件本身照常工作：pre-step 的注入与 feed 都不依赖投影服务。
    assert.equal(trace.hydrate.feedLanded, true, 'feed 仍会写进投影实例（只是没人读它）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补算诊断按会话分文件：两个会话的轨迹互不覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlm-hydrate-split-'))
  try {
    const alpha = { id: 's-alpha', events: sessionEvents(1) }
    const beta = { id: 's-beta', events: sessionEvents(2) }
    const { ctx, registrations } = mockHostContext({
      sessionProjections: { register(definition) { registrations.push(definition); return () => {} } },
      sessions: { get: (id) => (id === 's-alpha' ? alpha : id === 's-beta' ? beta : undefined) },
    })
    applyHost(ctx, { l3Enabled: false, l2Mode: 'extractive', l3Dir: dir, selfTestAfterBoot: false })
    const definition = registrations[0]

    foldSession(definition, 's-alpha', alpha.events)
    foldSession(definition, 's-beta', beta.events)
    await null

    const traceA = readTrace(dir, 's-alpha')
    const traceB = readTrace(dir, 's-beta')
    assert.equal(traceA.sessionId, 's-alpha')
    assert.equal(traceB.sessionId, 's-beta')
    // 曾经 diagnostics.json 是全局单文件，最后跑过的会话会覆盖它——同一课不能上第二次。
    assert.equal(traceA.hydrate.byPath['byId:sessions'], 1)
    assert.equal(traceB.hydrate.byPath['byId:sessions'], 1)
    assert.equal(traceA.hydrate.feedLanded, true)
    assert.equal(traceB.hydrate.feedLanded, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回归：状态还是落盘行（updatedAt: 0）而 feed 已经更新时，view 直接发布 feed 那份', () => {
  const projection = createTriLayerProjection()
  // 模拟 restore 从检查点行恢复出来的状态：rev / updatedAt 都是上一代进程留下的。
  // 真实故障里客户端读到的就是这份（updatedAt: 0 → 面板显示"记忆层尚未就绪"），
  // 而此刻 feed 表里其实已经有本进程算好的读数。
  const stale = { ...projection.definition.init({ id: 's-stale' }, 0), rev: 7, updatedAt: 0 }
  projection.feed('s-stale', feedInput(), 1_700_000_000_000)

  const view = projection.definition.wire.view(stale)
  assert.ok(view.updatedAt > 0, '有过期状态也要发布更新鲜的 feed：客户端不该再看到"尚未就绪"')
  assert.equal(view.taskTitle, '给三层记忆插件加一个思维栏')
  assert.ok(view.mainline.length >= 2, '骨架同样来自 feed')
  assert.doesNotThrow(() => projection.definition.wire.viewSchema.parse(view))

  // 状态折过同一份 feed 之后，view 回到按状态渲染（两者等价，状态那份还更完整）。
  const folded = projection.definition.apply(stale, { type: 'turn/end', seq: 9, data: {} })
  assert.equal(projection.definition.wire.view(folded).updatedAt, 1_700_000_000_000)

  // 空状态 + 没有 feed + 没有累积事件（例如 listing 读一份空行）→ 仍是"尚未就绪"，
  // 不能凭空造出内容来。
  const bare = createTriLayerProjection()
  const empty = bare.definition.init({ id: 's-bare' }, 0)
  assert.equal(bare.definition.wire.view(empty).updatedAt, 0)
})
