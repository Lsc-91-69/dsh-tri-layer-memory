/**
 * test/client.test.mjs — 客户端半边（设置面板）的行为测试。
 *
 * 为什么需要它：`src/client.js` 是手写的 plain-JS factory，不经过任何编译，
 * 因此**没有任何东西替它检查语法之外的问题**——引用错一个函数、key 写错、
 * 组件里访问了不存在的字段，都要等到用户打开设置面板才会发现。而这个文件在
 * 写完之后一次都没被执行过。
 *
 * 这里用 `node:vm` 造一个最小的浏览器环境（`window.__ModuleLoader__`、
 * `require`、`document`），把模块加载协议、导出形态、槽位注册、组件渲染、
 * 以及"改字段 → 变脏 → 保存 → 写入 scope"这条交互链全部跑一遍。
 *
 * 它验证的是**契约**（注册 id、key、协议）与**行为**（渲染不炸、保存真的写入），
 * 不验证像素——那属于浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 极简 React 替身：createElement 返回可检查的普通对象。
 *
 * `useState` 也必须在场：思维栏的"引用"按钮用它记住"刚引用了哪一条"的回执。
 * 替身按 React 的规则实现——**每次渲染前把槽位游标归零**（`beginRender()`），
 * 值跨渲染保留在 `hookStates` 里；setter 只写值，不触发重渲染（测试里的渲染
 * 是显式调用，要看到回执就自己再渲染一次）。
 */
let hookCursor = 0
let hookStates = []
const React = {
  /** 一次新渲染开始：hooks 槽位从 0 重新数。 */
  beginRender() { hookCursor = 0 },
  /** 一次全新挂载：连值一起清掉，避免用例之间互相串。 */
  resetHooks() { hookCursor = 0; hookStates = [] },
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (index >= hookStates.length) hookStates.push(initial)
    return [hookStates[index], (next) => { hookStates[index] = next }]
  },
}

/** `@deepseek-ai/dsh-client-store` 替身：createSnapshotStore 只需 set/getSnapshot。 */
function makeStoreModule() {
  return {
    createSnapshotStore(initial) {
      let value = initial
      return {
        set(next) { value = next },
        getSnapshot() { return value },
      }
    },
  }
}

/**
 * 在 vm 沙箱里执行 src/client.js，返回捕获到的注册信息。
 *
 * @returns `{ id, factory, document }`；模块未按协议注册时抛错。
 */
function loadClientModule() {
  const source = readFileSync(join(root, 'src/client.js'), 'utf8')
  const loaded = []
  const styles = []
  const document = {
    head: { appendChild(node) { styles.push(node) } },
    createElement() { return { setAttribute() {}, remove() {}, textContent: '' } },
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(registration) { loaded.push(registration) } } },
    document,
    Promise,
    Date,
    Object,
    Array,
    Map,
    Set,
    String,
    Number,
    JSON,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  assert.equal(loaded.length, 1, 'client.js 必须恰好调用一次 __ModuleLoader__.load')
  return { ...loaded[0], document, styles }
}

/** 造一个能跑通 apply() 的客户端 ctx。 */
function mockClientContext({ writable = true, status = 'ready' } = {}) {
  const registrations = []
  const dictionaries = []
  const effects = []
  const scopeValue = {
    l1RetainTurns: 8,
    l1Inject: 'marker',
    l1ProtectFromCompaction: true,
    l2Mode: 'llm',
    l2RetainTurns: 24,
    l2MaxSummaryTokens: 1024,
    l2MinTurnsBeforeSummary: 3,
    l2RefreshIntervalMs: 0,
    l2Inject: true,
    l3Enabled: true,
    l3Store: 'auto',
    l3Dir: '',
    l3Distill: true,
    l3MaxRecords: 500,
    l3PruneMinScore: 0.25,
    l3InjectIndex: true,
    recallToolName: 'auto',
    recallDefaultLimit: 5,
    recallMaxLimit: 20,
    injectionBudgetTokens: 1200,
    integrationEngine: 'auto',
    integrationHeadroom: true,
    integrationMcpLens: true,
    integrationAudit: true,
    verifyDetail: 'summary',
    selfTestAfterBoot: true,
  }
  const writes = []
  let snapshot = {
    status,
    value: status === 'ready' ? scopeValue : undefined,
    base: scopeValue,
    user: {},
    revision: 1,
    writable,
    mode: 'host',
  }
  const listeners = new Set()
  const scope = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(field, value) { writes.push({ op: 'set', field, value }); return Promise.resolve() },
    unset(field) { writes.push({ op: 'unset', field }); return Promise.resolve() },
  }
  const ctx = {
    effect(fn) { effects.push(fn()) },
    // 软等待：依赖全在场才调用回调（与 cordis 一致）。卡片注册走这条路，
    // 因此 settingsScope 缺席时插件仍 active，只是没有卡片。
    inject(deps, callback) {
      if (!deps.every((d) => ctx[d] !== undefined)) return
      callback(ctx)
    },
    get(name) { return ctx[name] },
    locale: {
      bind: () => (key) => key,
      register(ns, dict) { dictionaries.push({ ns, dict }); return () => {} },
    },
    settingsScope: { bind: () => scope },
    slots: {
      inject(name, callback) {
        // 真实实现是等待槽位声明后执行；这里直接执行，并把生成器里的注册取出来。
        const iterator = callback()
        for (const item of iterator) registrations.push({ name, item })
      },
      register(options, component) { return { options, component } },
    },
  }
  return {
    ctx, registrations, dictionaries, effects, writes, scope, getSnapshot: () => snapshot,
    // 两个贡献面（设置卡片 + 思维栏）按槽位名取：跨槽位的注册顺序没有语义，
    // 断言不该依赖"第 0 个是谁"。
    card: () => registrations.find((entry) => entry.name === 'settings.plugin.item'),
    view: () => registrations.find((entry) => entry.name === 'conversation.view'),
  }
}

/** 词条模板 → 可读文本（`{name}` 占位符按参数替换，与 locale 服务同规则）。 */
function translate(dict) {
  return (key, params) => {
    const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}

/**
 * 把 React 替身树折成**渲染后的纯文本**（按渲染顺序拼接）。
 *
 * 断言"用户看到什么"而不是"节点长什么样"：一行文字可能被拆进相邻的 span
 * （例如骨架行的原因从句要弱化显示），按节点 JSON 断言就永远匹配不上整行。
 */
function flattenText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'object') return flattenText(node.children ?? [])
  return String(node)
}

test('client.js 走 __ModuleLoader__ 协议，id 与包名一致', () => {
  const { id, factory } = loadClientModule()
  assert.equal(id, 'dsh-tri-layer-memory', 'id 必须是 npm 包名，否则浏览器不会 materialize')
  assert.equal(typeof factory, 'function')
})

test('factory 导出 apply / inject，且 inject 是 Cordis 服务名', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-store') return makeStoreModule()
    throw new Error(`unexpected require: ${spec}`)
  })
  assert.equal(typeof exports.apply, 'function')
  // vm 沙箱里的数组与本 realm 的原型不同，deepStrictEqual 会误报；先搬过来。
  //
  // 只允许声明**必需**服务：硬依赖缺席会让插件 fiber 永远 pending，宿主据此判
  // 启动失败——真实事故：
  //   web boot: 1 entry did not activate
  //     dsh-tri-layer-memory: pending (waiting for service: settingsScope)
  // 设置面板属于可降级能力，必须走 apply 内部的 ctx.inject() 软等待。
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale'])
  assert.ok(!Array.from(exports.inject).includes('settingsScope'),
    'settingsScope 不得出现在硬依赖里——它缺席时必须只丢卡片，不能拖死启动')
  // 基线模块表只有这两个可用；出现第三个说明用到了不存在的包。
  assert.ok(Array.from(exports.inject).every((name) => !name.includes('@')), 'inject 里不能出现包名')
})

test('settingsScope 缺席：不注册卡片、不抛错，插件仍 active', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  delete harness.ctx.settingsScope // 模拟宿主没有提供 settingsScope
  assert.doesNotThrow(() => exports.apply(harness.ctx), '服务缺席绝不能让 apply 抛错')
  assert.equal(harness.card(), undefined, '没有 settingsScope 就不该注册卡片')
  // 思维栏不依赖 settingsScope（它只读 session projection 的标准 prop），
  // 因此照常注册——这正是"服务缺席只丢一块能力"的样子。
  assert.ok(harness.view(), '思维栏不依赖 settingsScope，应当照常注册')
  // 词条与样式不依赖 settingsScope，应当照常注册（这样插件是"活着但降级"）。
  assert.equal(harness.dictionaries.length, 1, '词条注册不依赖 settingsScope')
})

test('apply() 注册设置卡片：槽位、key、locale、hooks 与 actions 齐备', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  assert.equal(harness.dictionaries.length, 1, '应注册一份词条')
  assert.equal(harness.dictionaries[0].ns, 'tri-layer-memory')
  assert.ok(harness.dictionaries[0].dict.zh.title && harness.dictionaries[0].dict.en.title, '中英词条都要有')

  assert.ok(harness.card(), '应注册设置卡片槽位贡献')
  const { name, item } = harness.card()
  assert.equal(name, 'settings.plugin.item')
  assert.equal(item.options.name, 'settings.plugin.item')
  // key 必须等于宿主注册的 settings namespace，否则卡片永远不渲染。
  assert.equal(item.options.key, 'tri-layer-memory')
  assert.equal(item.options.locale, 'tri-layer-memory')

  const injected = item.options.inject()
  assert.ok(injected.hooks.triLayerCard, 'hooks 隔间里要有投影源')
  assert.equal(typeof injected.actions.edit, 'function')
  assert.equal(typeof injected.actions.save, 'function')
  assert.equal(typeof injected.actions.resetField, 'function')
  assert.equal(typeof injected.actions.discard, 'function')
})

test('组件在 ready 状态下渲染出三层分组与保存按钮', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)
  const { item } = harness.card()
  const injected = item.options.inject()

  const tree = item.component({
    t: (key) => key,
    actions: injected.actions,
    useTriLayerCard: (selector) => selector(injected.hooks.triLayerCard.getSnapshot()),
  })

  const flat = JSON.stringify(tree)
  for (const group of ['groupL1', 'groupL2', 'groupL3', 'groupRecall', 'groupIntegration', 'groupDiag']) {
    assert.ok(flat.includes(group), `应渲染分组 ${group}`)
  }
  assert.ok(flat.includes('save'), '应有保存按钮')
  assert.ok(flat.includes('discard'), '应有放弃按钮')
  assert.ok(flat.includes('injectionBudgetTokens'), '应包含注入预算字段')
  assert.ok(flat.includes('l3Store'), '应包含存储后端字段')
})

test('未就绪 / 只读连接：给出说明而不是空白', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))

  const unavailable = mockClientContext({ status: 'unavailable' })
  exports.apply(unavailable.ctx)
  const unavailableTree = unavailable.card().item.component({
    t: (key) => key,
    actions: unavailable.card().item.options.inject().actions,
    useTriLayerCard: (selector) => selector(unavailable.card().item.options.inject().hooks.triLayerCard.getSnapshot()),
  })
  assert.ok(JSON.stringify(unavailableTree).includes('unavailable'), '宿主未注册命名空间时应提示')

  const readOnly = mockClientContext({ writable: false })
  exports.apply(readOnly.ctx)
  const readOnlyTree = readOnly.card().item.component({
    t: (key) => key,
    actions: readOnly.card().item.options.inject().actions,
    useTriLayerCard: (selector) => selector(readOnly.card().item.options.inject().hooks.triLayerCard.getSnapshot()),
  })
  assert.ok(JSON.stringify(readOnlyTree).includes('readOnly'), '只读连接应提示不可修改')
})

test('改字段 → 变脏 → 保存：写入真的到达 scope，且只写被改的字段', async () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)
  const injected = harness.card().item.options.inject()
  const project = () => injected.hooks.triLayerCard.getSnapshot()

  assert.equal(project().dirty, false, '初始不应是脏的')

  injected.actions.edit('l1RetainTurns', '12')
  assert.equal(project().dirty, true, '改字段后应变脏')
  assert.equal(project().fields.l1RetainTurns.text, '12')
  assert.equal(project().fields.l1RetainTurns.overridden, true, '暂存的改动应标记为已覆盖')

  await injected.actions.save()
  assert.deepEqual(harness.writes, [{ op: 'set', field: 'l1RetainTurns', value: 12 }],
    '只应写入被改动的那个字段')
  assert.equal(project().dirty, false, '保存后应清空暂存')

  // 放弃：暂存被清掉，不产生任何写入。
  const before = harness.writes.length
  injected.actions.edit('l2Mode', 'extractive')
  injected.actions.discard()
  await Promise.resolve()
  assert.equal(harness.writes.length, before, '放弃不应写入')
  assert.equal(project().dirty, false)
})

test('非法数字：标为无效且保存时不写入该字段', async () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)
  const injected = harness.card().item.options.inject()
  const project = () => injected.hooks.triLayerCard.getSnapshot()

  injected.actions.edit('l1RetainTurns', '不是数字')
  assert.equal(project().fields.l1RetainTurns.invalid, true, '半打的输入应标为无效')
  await injected.actions.save()
  assert.deepEqual(harness.writes, [], '无效字段不得写进持久文档')
})

test('重置：清空字段使其回到组合层默认值', async () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)
  const injected = harness.card().item.options.inject()

  // 模拟该字段已被用户覆盖过（user 层里有它）。
  harness.scope.getSnapshot().user = { l1RetainTurns: 12 }
  const spec = { field: 'l1RetainTurns', format: (v) => String(v), parse: (t) => ({ kind: 'set', value: Number(t) }) }
  injected.actions.resetField('l1RetainTurns', spec)
  await injected.actions.save()
  assert.deepEqual(harness.writes, [{ op: 'unset', field: 'l1RetainTurns' }],
    '重置应走 unset，让字段重新继承组合层')
})

test('样式只注入一次，且带 data-plugin 标记便于卸载', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)
  // effect 返回的 disposer 已被收集；样式节点在 document.head 上。
  assert.equal(harness.effects.length >= 1, true, '应通过 effect 登记副作用以便卸载')
})

// ── 思维栏（conversation.view）────────────────────────────────────────────

/** 造一份投影值（与 src/host/projection.ts 的 TriLayerView 同形）。 */
function projectionValue(overrides = {}) {
  return {
    taskTitle: '给 DSH 三层记忆插件加一个思维栏',
    mainline: [
      { turn: 1, title: '给 DSH 三层记忆插件加一个思维栏', cause: '会话初始任务', category: '任务' },
      { turn: 4, turnTo: 6, title: '投影注册失败', cause: '连续 3 轮未解决', category: '失败' },
    ],
    mainlineTokens: 22,
    l1: { retainTurns: 8, turns: 3, evicted: 0 },
    l2: { summary: '已完成规格阅读，正在实现投影。', turnFrom: 1, turnTo: 2, mode: 'extractive' },
    l3: {
      backend: 'sqlite',
      count: 3,
      tokens: 12,
      // 本会话口径与整库口径分开：面板要同时显示两者（L3 是共享库）。
      sessionCount: 2,
      sessionTokens: 9,
      sessionId: 'session-aaaabbbb-1111-2222-3333-444455556666',
      records: [
        // 一条本会话 + 一条别的会话：列表是整库的，所以"这条属于谁"必须逐条标出来
        // （别的会话的「第 3 轮」不带标记就和本会话的「第 3 轮」长得一样）。
        { id: 'l3-1', kind: 'turn', turnFrom: 1, turnTo: 1, text: '第 1 轮的正文', tokens: 4, sessionId: 'session-aaaabbbb-1111-2222-3333-444455556666', own: true },
        { id: 'l3-2', kind: 'turn', turnFrom: 3, turnTo: 3, text: '别的会话第 3 轮的正文', tokens: 5, sessionId: 'session-ccccdddd-9999-8888-7777-666655554444', own: false },
      ],
    },
    recallTool: 'memory_recall',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/**
 * 用真实词条渲染思维栏组件。
 *
 * @param harness - 客户端 ctx 夹具。
 * @param projection - 投影值。
 * @param extra - 额外的标准 prop（引用通道的 `inputActions` / `useInput`）。
 * @param remount - true（默认）时按"新挂载"清掉 hooks 值；同一挂载的再渲染传 false。
 */
function renderMemoryView(harness, projection, extra = {}, remount = true) {
  if (remount) React.resetHooks()
  React.beginRender()
  const t = translate(harness.dictionaries[0].dict.zh)
  return harness.view().item.component({
    t,
    useProjection: (key) => (key === 'tri-layer-memory' ? projection : undefined),
    ...extra,
  })
}

/** 收集树里所有 button 节点的文本与 onClick。 */
function collectButtons(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out)
    return out
  }
  if (node.type === 'button') out.push({ text: flattenText(node), onClick: node.props.onClick, title: node.props.title })
  for (const child of node.children ?? []) collectButtons(child, out)
  return out
}

test('思维栏：注册 conversation.view（id / order / locale / label thunk），且不新增服务依赖', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  // 防复发门禁：`useProjection` 是 session 作用域槽位的**标准 prop**，由框架自动绑定，
  // 不是 Cordis 服务。把它写进 inject 会让插件 fiber 永远停在 pending，宿主据此判定
  // "有条目未激活"并拒绝启动——这条断言就是为了让那次事故不再发生。
  const inject = Array.from(exports.inject)
  assert.deepEqual(inject, ['slots', 'locale'], '思维栏不得新增任何硬依赖')
  for (const forbidden of ['sessionProjections', 'sessionProjection', 'projections', 'useProjection', 'sessions']) {
    assert.ok(!inject.includes(forbidden), `inject 里不得出现 ${forbidden}：那是硬依赖，缺席会拖死启动`)
  }

  const view = harness.view()
  assert.ok(view, '应注册 conversation.view 槽位贡献')
  assert.equal(view.item.options.name, 'conversation.view')
  assert.equal(view.item.options.id, 'memory', 'list 槽位必须有 id：chat(0) / trajectory(10) 之外的第三个')
  assert.equal(view.item.options.order, 20, 'order 20：排在 chat 与 trajectory 之后')
  assert.equal(view.item.options.locale, 'tri-layer-memory')
  assert.equal(view.item.options.key, undefined, 'list 槽位用 id，不用 key')
  // label 必须是 thunk：语言切换时框架重新求值即可，不需要重新注册槽位。
  assert.equal(typeof view.item.options.label, 'function', 'label 必须是 thunk')
  assert.equal(view.item.options.label(), 'view.memory', '测试里的 t 是恒等函数，因此看到的是 key')
  assert.equal(harness.dictionaries[0].dict.zh['view.memory'], '思维栏', '词条必须在字典里，否则标签显示原始 key')
  assert.equal(harness.dictionaries[0].dict.en['view.memory'], 'Memory')
  assert.equal(typeof view.item.component, 'function')
})

test('思维栏：useProjection 返回 undefined 时不抛错，显示"尚未就绪"', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)
  const t = translate(harness.dictionaries[0].dict.zh)
  const component = harness.view().item.component

  const pending = flattenText(component({ t, useProjection: () => undefined }))
  assert.ok(pending.includes('记忆层尚未就绪'), '宿主没注册该 key 时应说明情况')
  assert.ok(!pending.includes('主线骨架'), '拿不到数据时不渲染四段')

  // 宿主更老、连 useProjection 都没绑定：同样只降级，不抛错。
  assert.doesNotThrow(() => component({ t }))
  assert.ok(flattenText(component({ t })).includes('记忆层尚未就绪'))
  // 形状不对（例如别的实现占了这个 key）也走同一条降级路径。
  assert.doesNotThrow(() => component({ t, useProjection: () => ({}) }))
  assert.ok(flattenText(component({ t, useProjection: () => ({}) })).includes('记忆层尚未就绪'))
})

test('思维栏：拿到投影值时渲染四段（任务 / 骨架 / L2 摘要 / L3 记忆网络）', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  const flat = flattenText(renderMemoryView(harness, projectionValue()))
  assert.ok(flat.includes('给 DSH 三层记忆插件加一个思维栏'), '第 1 段：任务标题')
  // 骨架行的形态与注入块一致（`第 N 轮: 标题 — 原因`，跨轮用区间）。
  assert.ok(flat.includes('第 1 轮: 给 DSH 三层记忆插件加一个思维栏 — 会话初始任务'), '第 2 段：骨架单轮行')
  assert.ok(flat.includes('第 4–6 轮: 投影注册失败 — 连续 3 轮未解决'), '第 2 段：骨架跨轮行')
  assert.ok(flat.includes('已完成规格阅读，正在实现投影。'), '第 3 段：L2 摘要')
  assert.ok(flat.includes('本会话 2 条 / 约 9 tokens · 整库 3 条 / 约 12 tokens · 后端 sqlite'),
    '第 4 段：L3 规模——本会话与整库两个口径都要有（共享库不许只报整库）')
  assert.ok(flat.includes('记录（最近 2 条）'), '第 4 段：记录列表（可折叠）')
  // 列表是整库的，所以每条都要自报所属会话——本会话与别的会话都要有标记。
  assert.ok(flat.includes('本会话'), '本会话的记录必须显式标出来（不是靠"不标就是本会话"猜）')
  assert.ok(flat.includes('其它会话'), '别的会话的记录必须可辨识：否则它的「第 3 轮」看着像本会话的')
  assert.ok(flat.includes('第 1 轮的正文'), '第 4 段：记录正文')
  assert.ok(flat.includes('按需召回：调用 memory_recall 取回正文。'), 'recallTool 也要显示出来')

  // key 必须与宿主注册的 projection key 逐字一致：写错的话 useProjection 永远 undefined。
  let asked = null
  harness.view().item.component({ t: (key) => key, useProjection: (key) => { asked = key; return undefined } })
  assert.equal(asked, 'tri-layer-memory')
})

test('思维栏：空骨架（有投影但还没有数据）也渲染四段说明，而不是空白', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  const empty = projectionValue({
    taskTitle: null, mainline: [], mainlineTokens: 0,
    l2: null, l3: { backend: null, count: 0, tokens: 0, sessionCount: 0, sessionTokens: 0, sessionId: 's-empty', records: [] },
  })
  const flat = flattenText(renderMemoryView(harness, empty))
  assert.ok(flat.includes('（尚未识别出任务标题）'))
  assert.ok(flat.includes('（本会话尚无可提取的里程碑）'))
  assert.ok(flat.includes('（尚无摘要）'))
  assert.ok(flat.includes('（库为空：更早的内容尚未被蒸馏）'))
  assert.ok(!flat.includes('记忆层尚未就绪'), '已经有投影值，就不是"尚未就绪"')
})

// ── 可引用：把一条记忆塞进输入框（走 conversation.view 的标准 prop）─────────
//
// 平台已经备好了端到端通路：`inputActions.setDraft(text)` 写草稿、
// `useInput(s => s.draft)` 读回草稿（见 packages/client/ui-conversation/src/client/
// contract/input.ts）。所以这里**不该**出现任何自造的跨半边协议或新服务依赖——
// 下面这几条断言就是在钉住"只用标准 prop"这件事。

test('思维栏：四类记忆都可引用，点击把引用块写进输入框草稿', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  const writes = []
  const tree = renderMemoryView(harness, projectionValue(), {
    inputActions: { setDraft(text) { writes.push(text) } },
    useInput: (selector) => selector({ draft: '' }),
  })

  const buttons = collectButtons(tree)
  // 任务 1 + 骨架 2 + L2 摘要 1 + L3 记录 2 = 6：凡是面板里出现的一条记忆都能被引用。
  // （夹具从 1 条 L3 记录加到 2 条，是为了让"本会话 / 其它会话"两种标记都被渲染到。）
  assert.equal(buttons.length, 6, '任务 / 每条骨架 / L2 摘要 / 每条 L3 记录都该有引用按钮')
  assert.ok(buttons.every((button) => button.text === '引用'), '按钮文案来自词条 memQuote')

  // 骨架第 2 条（跨轮）：引用块首行是标签，正文与面板显示逐字一致。
  assert.equal(buttons[2].title, '记忆引用 · 主线骨架 · 第 4–6 轮')
  buttons[2].onClick()
  assert.equal(writes[0], '[记忆引用 · 主线骨架 · 第 4–6 轮]\n第 4–6 轮: 投影注册失败 — 连续 3 轮未解决')

  buttons[0].onClick()
  assert.equal(writes[1], '[记忆引用 · 任务标题]\n给 DSH 三层记忆插件加一个思维栏')

  buttons[3].onClick()
  assert.equal(writes[2], '[记忆引用 · L2 摘要 · 覆盖 第 1–2 轮]\n第 1–2 轮: 已完成规格阅读，正在实现投影。')

  // L3 记录带 id：引用块里必须留下 id，否则模型没法用 recall 回查同一条。
  assert.equal(buttons[4].title, '记忆引用 · L3 l3-1 · 第 1 轮 · turn')
  buttons[4].onClick()
  assert.equal(writes[3], '[记忆引用 · L3 l3-1 · 第 1 轮 · turn]\n第 1 轮 · turn: 第 1 轮的正文')
})

test('思维栏：引用是追加不是覆盖；失败必须说出来（不静默）', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  // 模拟框架的活草稿：setDraft 之后 useInput 读到的就是新值（真实实现就是这样）。
  let draft = '先看看这个：'
  let fail = false
  const props = {
    inputActions: {
      setDraft(text) {
        if (fail) throw new Error('composer busy')
        draft = text
      },
    },
    useInput: (selector) => selector({ draft }),
  }

  const first = renderMemoryView(harness, projectionValue(), props)
  collectButtons(first)[0].onClick()
  assert.equal(draft, '先看看这个：\n\n[记忆引用 · 任务标题]\n给 DSH 三层记忆插件加一个思维栏',
    '用户已经写下的半句不能被覆盖：引用是往里追加')

  // 回执：同一次挂载的再渲染能看到"已引用"。
  const again = renderMemoryView(harness, projectionValue(), props, false)
  assert.ok(flattenText(again).includes('已引用：记忆引用 · 任务标题'), '点完要有回执')

  // 第二次引用继续追加在上一段之后。
  collectButtons(renderMemoryView(harness, projectionValue(), props, false))[1].onClick()
  assert.ok(draft.endsWith('[记忆引用 · 主线骨架 · 第 1 轮]\n第 1 轮: 给 DSH 三层记忆插件加一个思维栏 — 会话初始任务'))

  // 输入框不可写（例如正在提交）：必须说出来——一个点了没反应的按钮就是静默故障。
  fail = true
  collectButtons(renderMemoryView(harness, projectionValue(), props, false))[0].onClick()
  const failed = flattenText(renderMemoryView(harness, projectionValue(), props, false))
  assert.ok(failed.includes('引用失败'), '失败要有回执，绝不静默')
})

test('思维栏：引用标准 prop 缺席时只读降级——不渲染按钮，也不抛错', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  const tree = renderMemoryView(harness, projectionValue())
  assert.equal(collectButtons(tree).length, 0, '拿不到 inputActions 就不渲染引用按钮')
  assert.ok(flattenText(tree).includes('主线骨架'), '面板本身照常渲染，只是不可引用')

  // 只有 useInput、没有 inputActions：同样不能出现"点了没反应"的按钮。
  const half = renderMemoryView(harness, projectionValue(), { useInput: (selector) => selector({ draft: '' }) })
  assert.equal(collectButtons(half).length, 0)
})

// ── 设计移植：轮次分组 / 当前轮签名 / L3 会话分组 ─────────────────────────
//
// 这三块是新渲染层的骨架，也是**测试测不到样式**的部分里唯一能被断言的：
// 分组口径（组头报哪些轮）、当前轮的判定、会话分组的顺序与默认展开态。
// 样式本身（刻度线位置、字号分层、金色 chip）只能在浏览器里验，不在这里假装验过。

/** 收集树里所有满足判据的节点（按渲染顺序）。 */
function collectNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) collectNodes(child, predicate, out)
  return out
}

/** 造一条骨架条目（默认单轮）。 */
function entry(turn, title, cause = '原因', category = '任务', turnTo) {
  const e = { turn, title, cause, category }
  if (turnTo !== undefined) e.turnTo = turnTo
  return e
}

test('思维栏：骨架按轮次分组，组头报**实际包含的轮次**（只有连续段才压成区间）', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  // 桶宽 8：1–8 / 9–16 / 17–24。第一桶里故意挖空 3、5，并在 1 轮放两条（去重）。
  const projection = projectionValue({
    mainline: [
      entry(1, 'A'), entry(1, 'B'), entry(2, 'C'), entry(4, 'D'), entry(6, 'E'), entry(7, 'F'), entry(8, 'G'),
      entry(9, 'H'), entry(17, 'I'),
    ],
    l1: { retainTurns: 8, turns: 3, evicted: 0 },
  })
  const tree = renderMemoryView(harness, projection)
  const labels = collectNodes(tree, (n) => n.props && n.props.className === 'dsh_tlm_memGrpLabel')
    .map((n) => flattenText(n))

  assert.deepEqual(labels, ['第 1–2、4、6–8 轮', '第 9 轮', '第 17 轮'],
    '组头必须报实际包含的轮次：跨轮条目的"最小–最大"会让相邻分组互相重叠')
  // 1 轮有两条（A/B），标签里只能出现一次——不去重会印出「第 1、1、1–2 轮」。
  assert.ok(!labels[0].includes('1、1'), '同轮的多条里程碑要去重')

  const stats = collectNodes(tree, (n) => n.props && n.props.className === 'dsh_tlm_memGrpStat')
    .map((n) => flattenText(n))
  assert.deepEqual(stats, ['7 条', '1 条', '1 条'], '组头报的是这一组实际有几条')
})

test('思维栏：当前轮有金色刻度线与 chip —— 组、行两级都要标出来', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  // 引擎口径：L1 窗口 3 轮 + 已溢出 9 轮 = 第 12 轮；骨架也覆盖到第 12 轮。
  const covered = projectionValue({
    mainline: [entry(1, 'A'), entry(9, 'H'), entry(12, 'L')],
    l1: { retainTurns: 3, turns: 3, evicted: 9 },
  })
  const tree = renderMemoryView(harness, covered)

  assert.ok(flattenText(tree).includes('当前 第 12 轮'), 'chip 报当前轮')
  assert.ok(flattenText(tree).includes('骨架覆盖 第 1–12 轮 · 2 段'), 'chip 旁边同时报骨架覆盖范围')

  const nowChip = collectNodes(tree, (n) => n.props && n.props.className === 'dsh_tlm_memNowChip')[0]
  assert.ok(nowChip.props.title.includes('本会话已产生 12 轮'), '悬停提示要说清"当前轮"是哪个口径')
  assert.ok(nowChip.props.title.includes('骨架最远覆盖到第 12 轮'), '两个口径都摆出来，不假装精确')

  // 当前轮落在第 9–12 轮那一段里 → 那一段挂「当前」badge，行上带 isNow。
  const badges = collectNodes(tree, (n) => n.props && n.props.className === 'dsh_tlm_memNowBadge')
  assert.equal(badges.length, 1, '只有覆盖当前轮的那一组挂 badge')
  assert.equal(collectNodes(tree, (n) => n.props && typeof n.props.className === 'string'
    && n.props.className.indexOf('dsh_tlm_memRow') === 0 && n.props.className.includes('isNow')).length,
    1, '当前轮那一行要有 isNow（金色 2px 刻度线 + 高亮靠它）')

  // 引擎比骨架更靠前（里程碑还没跟上）：chip 照实报，但**不**硬把最后一行标成当前——
  // 把一个已经过去的轮指成"当前"比不标更糟。
  const ahead = projectionValue({
    mainline: [entry(1, 'A'), entry(9, 'H')],
    l1: { retainTurns: 3, turns: 3, evicted: 9 },
  })
  const aheadTree = renderMemoryView(harness, ahead)
  assert.ok(flattenText(aheadTree).includes('当前 第 12 轮'), 'chip 报的是引擎口径的当前轮')
  assert.ok(flattenText(aheadTree).includes('骨架覆盖 第 1–9 轮 · 2 段'), '覆盖范围分开报，读者能看出骨架滞后')
  assert.equal(collectNodes(aheadTree, (n) => n.props && n.props.className === 'dsh_tlm_memNowBadge').length, 0,
    '骨架没覆盖到当前轮时，没有任何一组该被标成当前')
  assert.equal(collectNodes(aheadTree, (n) => n.props && typeof n.props.className === 'string'
    && n.props.className.includes('isNow')).length, 0, '同样不许把最后一行硬标成当前')

  // 跨轮条目也要能命中：当前轮落在 4–6 区间里时整条算当前。
  const spanned = projectionValue({
    mainline: [entry(4, 'X', '原因', '失败', 6)],
    l1: { retainTurns: 8, turns: 5, evicted: 0 },
  })
  const spannedTree = renderMemoryView(harness, spanned)
  assert.equal(collectNodes(spannedTree, (n) => n.props && typeof n.props.className === 'string'
    && n.props.className.includes('isNow')).length, 1, '当前轮落在跨轮区间里时该行也算当前')
})

test('思维栏：L3 按会话分组——本会话排最前、默认展开；别的会话收起', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  // 别的会话的记录**排在前面**：分组顺序不能跟着输入顺序走，
  // 否则"哪一段是我的"要靠读者自己在整库列表里找。
  const projection = projectionValue({
    l3: {
      backend: 'sqlite', count: 9, tokens: 99, sessionCount: 1, sessionTokens: 4,
      sessionId: 'session-aaaabbbb-1111-2222-3333-444455556666',
      records: [
        { id: 'l3-other', kind: 'turn', turnFrom: 3, turnTo: 3, text: '别的会话的正文', tokens: 5, sessionId: 'session-ccccdddd-9999-8888-7777-666655554444', own: false },
        { id: 'l3-own', kind: 'turn', turnFrom: 1, turnTo: 1, text: '本会话的正文', tokens: 4, sessionId: 'session-aaaabbbb-1111-2222-3333-444455556666', own: true },
      ],
    },
  })
  const tree = renderMemoryView(harness, projection, {
    inputActions: { setDraft() {} },
    useInput: (selector) => selector({ draft: '' }),
  })
  const sessions = collectNodes(tree, (n) => n.type === 'details' && n.props && n.props.className === 'dsh_tlm_memSess')

  assert.equal(sessions.length, 2, '两个会话两个折叠块')
  assert.equal(sessions[0].props.open, true, '本会话默认展开')
  assert.equal(sessions[1].props.open, false, '别的会话默认收起')
  assert.ok(flattenText(sessions[0]).includes('本会话'), '本会话必须显式标出来，不靠"不标就是本会话"猜')
  assert.ok(flattenText(sessions[1]).includes('其它会话'), '别的会话要可辨识：它的「第 3 轮」看着和本会话的一样')
  assert.ok(flattenText(sessions[0]).includes('本会话的正文'))
  assert.ok(flattenText(sessions[1]).includes('别的会话的正文'))

  // 引用按钮跟着记录走，顺序 = 分组后的渲染顺序（本会话那条在前）。
  const buttons = collectButtons(tree)
  assert.equal(buttons[4].title, '记忆引用 · L3 l3-own · 第 1 轮 · turn')
  assert.equal(buttons[5].title, '记忆引用 · L3 l3-other · 第 3 轮 · turn')
})

test('思维栏：投影缺 l1（宿主更老）时当前轮退化到骨架口径，不抛错', () => {
  const { factory } = loadClientModule()
  const exports = factory((spec) => (spec === 'react' ? React : makeStoreModule()))
  const harness = mockClientContext()
  exports.apply(harness.ctx)

  const noL1 = projectionValue({ mainline: [entry(1, 'A'), entry(7, 'G')] })
  delete noL1.l1
  let tree
  assert.doesNotThrow(() => { tree = renderMemoryView(harness, noL1) }, '形状不全只该降级，不该抛')
  assert.ok(flattenText(tree).includes('当前 第 7 轮'), '没有 l1 读数时用骨架最远覆盖到的轮')
})
