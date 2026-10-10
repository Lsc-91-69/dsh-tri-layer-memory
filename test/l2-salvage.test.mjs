/**
 * test/l2-salvage.test.mjs — L2 摘要撞输出上限时的**取舍**测试。
 *
 * 为什么单独一个文件：这里钉死的是一条**取舍纪律**，而不是某个字段——
 * "撞到 max-tokens 时，正文非空就必须留下（按边界裁），只有正文为空才允许退回抽取式"。
 *
 * 旧行为是撞上限直接抛错 → 整份摘要丢弃 → 退回机械抽取。这个选择的代价被真实会话
 * 量过：LLM 摘要压缩比约 28x、读起来像任务简报；抽取式 85x、只是把原话拼起来。
 * **一份被截断的 LLM 摘要信息量远大于抽取式**，而"因为不完美所以全丢"是最差的选择。
 * 宿主自己的 `BlockAssembler` 也是这么做的（max-tokens 时保留 text/reasoning 块，
 * 只丢弃无法安全执行的工具调用），所以"截断仍可用"本来就是平台约定。
 *
 * 同时钉死第二件事：**截断必须与失败在观察面上可分辨**。诊断里 `truncated=true`
 * 表示"走了模型、产物被裁过尾巴仍在用"，`failure` 只在退回抽取式时出现——
 * 两者混在一起，排查时会把可用摘要当成故障，修法方向也跟着错。
 *
 * 用 `lib/impl.js`（真实构建产物）跑端到端，用 `src/host/l2-render.ts` 跑纯函数，
 * 与 l2-seam.test.mjs / layers.test.mjs 同一策略。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/impl.js'
import { DEFAULTS, resolveConfig } from '../src/host/config-core.ts'
import { trimAtBoundary } from '../src/host/l2-render.ts'

/**
 * 最小可用 Host ctx（与 l2-seam.test.mjs 同形）。
 *
 * @param options - services 是本 ctx 能提供的服务。
 * @returns mock ctx 与捕获到的注册物。
 */
function mockContext({ services = {} } = {}) {
  const tools = []
  const listeners = new Map()
  const available = {
    tools: { register(tool) { tools.push(tool); return () => {} }, schemas: () => tools.map((t) => ({ name: t.name })) },
    ...services,
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push({ listener, options })
    },
    effect(fn) { return fn() },
    inject(deps, callback) {
      if (!deps.every((d) => available[d] !== undefined)) return
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

/** 造一段合成会话日志：n 轮，每轮 user + assistant + 一次工具调用。 */
function syntheticSession({ turns = 12, id = 's-l2-salvage' } = {}) {
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
  session.requestHeader = () => ({
    config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max', maxTokens: 384000 },
    adapterDefaults: { maxTokens: true },
    tools: [],
  })
  return session
}

/**
 * 模型产出的**被截断**正文：最后一个 `## 未决问题` 条目停在半句话上。
 *
 * 形状刻意做成真实的 Markdown 结构：截断点落在"行中间"，正是网关在输出上限处
 * 掐断流时的样子（`block-end` 永远不会来）。
 */
const TRUNCATED_TEXT = [
  '## 任务主线',
  '- 修复 L2 摘要退回抽取式：撞上限时保留正文',
  '',
  '## 已完成的子任务',
  '- 已定位到推理与正文共享输出预算；诊断补了读数',
  '',
  '## 关键决策与依据',
  '- 决定按行边界裁剪，而不是整份丢弃',
  '',
  '## 未决问题',
  '- 还需要确认真实网关下的 reasoningEffort 这一',
].join('\n')

/** 截断点之前的**完整**部分（行边界）：测试用它断言"半句话没被留下"。 */
const KEPT_TEXT = TRUNCATED_TEXT.slice(0, TRUNCATED_TEXT.lastIndexOf('\n'))

/**
 * 假 llm seam。
 *
 * `chunks` 是每次调用要吐出的 chunk 序列；给函数时按调用序号（从 0 起）返回，
 * 用来构造"第一次被拒、第二次成功"这类重试场景。
 *
 * @param options - chunks 生成器、用量块。
 * @returns 记录调用的假服务。
 */
function fakeLlm({ chunks, usage } = {}) {
  const calls = []
  const defaultChunks = () => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: TRUNCATED_TEXT },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  return {
    calls,
    service: {
      async *stream(options) {
        const index = calls.length
        calls.push(options)
        const list = typeof chunks === 'function' ? chunks(index) : (chunks ?? defaultChunks())
        for (const chunk of list) {
          if (chunk !== undefined) yield chunk
        }
        if (usage !== undefined) yield { type: 'usage', usage }
      },
    },
  }
}

/** 摘要调用与 cause 调用共用同一条 seam，靠请求正文里的指令区分。 */
function digestCalls(llm) {
  return llm.calls.filter((c) => JSON.stringify(c.messages ?? '').includes('Condense the conversation excerpt'))
}

/**
 * 跑一轮 pre-step，并取回注入文本 / memory_state / memory_verify / 诊断文件。
 *
 * @param options - mock 服务、会话、插件配置、诊断目录。
 * @returns 各观察面的读数。
 */
async function runStep({ services = {}, session = syntheticSession(), config = {}, l3Dir } = {}) {
  const { ctx, tools, listeners } = mockContext({ services })
  apply(ctx, { l3Enabled: false, selfTestAfterBoot: false, ...(l3Dir === undefined ? {} : { l3Dir }), ...config })

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

  let diagnostics = null
  if (l3Dir !== undefined) {
    diagnostics = JSON.parse(readFileSync(join(l3Dir, `${session.id}.diagnostics.json`), 'utf8'))
  }
  return { injected, status, report, diagnostics, tools, ctx }
}

// ── 1. 撞上限但正文可用：留下（这是本次修复的核心）────────────────────────

test('撞 max-tokens 且正文非空：用截断后的正文，via 仍是 llm，不退回抽取式', async () => {
  const llm = fakeLlm()
  const { injected, status, report } = await runStep({
    services: { llm: llm.service },
    config: { l2MinTurnsBeforeSummary: 1 },
  })

  assert.equal(digestCalls(llm).length, 1, '应发出一次摘要调用')
  // 核心断言：**没有**退回抽取式。
  assert.equal(status.layers.L2.via, 'llm', '正文非空时必须保留，不能因为被截断就整份丢弃')
  assert.equal(status.layers.L2.failure, null, '截断保留不是失败，失败原因必须为 null')
  // 但必须能看出"被截过"。
  assert.equal(status.layers.L2.truncated, true, 'truncated 必须为 true：这是与"完全失败"的唯一分界')
  assert.match(injected, /生成方式 llm/, '注入的必须是 llm 摘要')
  assert.match(injected, /决定按行边界裁剪/, '保留的正文必须进注入')
  assert.doesNotMatch(injected, /还需要确认真实网关下的 reasoningEffort/, '半句话不得进注入')
})

test('截断保留：诊断里记下"部分可用"的全部读数（一次部署即可定性）', async () => {
  const llm = fakeLlm({ usage: { inputTokens: 1200, outputTokens: 4096, totalTokens: 5296 } })
  const dir = mkdtempSync(join(tmpdir(), 'tri-l2-salvage-'))
  try {
    const { status, report, diagnostics } = await runStep({
      services: { llm: llm.service },
      config: { l2MinTurnsBeforeSummary: 1 },
      l3Dir: dir,
    })

    // 诊断文件（用户唯一能直接看到的落盘面）。
    assert.ok(diagnostics !== null, '诊断文件必须落盘')
    assert.equal(diagnostics.l2.via, 'llm')
    assert.equal(diagnostics.l2.truncated, true, '诊断必须把"部分可用"与"完全失败"分开')
    const attempt = diagnostics.l2.attempt
    assert.ok(attempt, '诊断必须带本次调用的读数')
    assert.equal(attempt.finish, 'max-tokens', 'finish.kind 的实际值必须记下来')
    assert.equal(attempt.maxTokens, 4096, '请求里实际发出的输出上限必须记下来')
    assert.equal(attempt.outputChars, TRUNCATED_TEXT.length, '丢弃前的正文字符数必须记下来（0 = 推理吃光预算）')
    assert.equal(attempt.salvaged, true)
    assert.equal(attempt.boundary, 'line', '截断点必须落在行边界')
    assert.ok(attempt.droppedChars > 0, '必须记下被裁掉的字符数')
    assert.ok(attempt.inputTokens > 0, '输入摘录的规模必须记下来')
    assert.deepEqual(attempt.usage, { inputTokens: 1200, outputTokens: 4096, totalTokens: 5296 },
      'provider 用量必须原样带出（推理 token 的真相在这里）')
    assert.equal(attempt.reasoningEffort, DEFAULTS.internalCallReasoningEffort, '请求带的推理档位必须记下来')
    assert.equal(attempt.effortRetry, false)

    // memory_state（模型侧的观察面）。
    assert.equal(status.layers.L2.attempt.finish, 'max-tokens')
    assert.equal(status.layers.L2.attempt.outputChars, TRUNCATED_TEXT.length)

    // memory_verify：必须有一条"部分可用"的判定，且**不是**失败。
    const truncatedVerdict = report.verdicts.find((v) => v.id === 'L2-truncated')
    assert.ok(truncatedVerdict !== undefined, 'memory_verify 必须给出 L2-truncated 判定')
    assert.equal(truncatedVerdict.ok, true, '"部分可用"是可用产物，不该被判为失败')
    assert.match(truncatedVerdict.text, /部分可用/)
    assert.equal(report.verdicts.find((v) => v.id === 'L2-fallback'), undefined,
      '截断保留不得同时报"退回抽取式"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2. 只有正文为空才退回抽取式 ───────────────────────────────────────────

test('撞 max-tokens 且正文为空：这才退回 extractive，并记下"0 字符"', async () => {
  // 真实观测的形状：推理把 4096 的输出预算吃光，一个正文字符都没剩（同一条 seam 上
  // cause 回填就是这么拿到 0 字符的）。
  const llm = fakeLlm({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '（推理内容，正文零字符）' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
  })
  const { injected, status } = await runStep({
    services: { llm: llm.service },
    config: { l2MinTurnsBeforeSummary: 1 },
  })

  assert.equal(status.layers.L2.via, 'extractive', '正文为空时没有可用内容，退回抽取式是对的')
  assert.equal(status.layers.L2.truncated, false)
  assert.equal(status.layers.L2.failure?.stage, 'llm-error')
  assert.match(status.layers.L2.failure.message, /truncated at the token cap with no text/)
  assert.match(status.layers.L2.failure.message, /0 chars/, '消息里必须带实际字符数')
  assert.equal(status.layers.L2.attempt.finish, 'max-tokens')
  assert.equal(status.layers.L2.attempt.outputChars, 0, '正文 0 字符是"推理吃光预算"的判据')
  assert.equal(status.layers.L2.attempt.salvaged, false)
  assert.match(injected, /生成方式 extractive/)
})

// ── 3. 正常完成：行为不变 ─────────────────────────────────────────────────

test('正常收尾（stop）：行为不变，且不被误标为截断', async () => {
  const full = '## 任务主线\n- 完整的一段摘要。\n\n## 未决问题\n- (none)'
  const llm = fakeLlm({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: full },
      { type: 'block-end', index: 0, block: { type: 'text', text: full } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const { injected, status } = await runStep({
    services: { llm: llm.service },
    config: { l2MinTurnsBeforeSummary: 1 },
  })

  assert.equal(status.layers.L2.via, 'llm')
  assert.equal(status.layers.L2.failure, null)
  assert.equal(status.layers.L2.truncated, false, '正常完成不得被标成截断')
  assert.equal(status.layers.L2.attempt.finish, 'stop')
  assert.equal(status.layers.L2.attempt.outputChars, full.length)
  assert.equal(status.layers.L2.attempt.salvaged, false)
  assert.equal(status.layers.L2.attempt.droppedChars, 0)
  assert.equal(status.layers.L2.attempt.boundary, 'none')
  assert.match(injected, /完整的一段摘要/)
})

// ── 4. 推理档位：请求里真的带上了，且不被支持时会去掉重试 ─────────────────

test('摘要请求带上有界的推理档位（默认 low），把输出预算让给正文', async () => {
  const llm = fakeLlm({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '## 任务主线\n- 结论。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  await runStep({ services: { llm: llm.service }, config: { l2MinTurnsBeforeSummary: 1 } })

  const calls = digestCalls(llm)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, 'low',
    '默认必须带 low：这台机器上 deepseek-v4.1-flash 无法关掉推理（off 映射为 null），只能压档位')
  assert.equal(calls[0].maxTokens, DEFAULTS.l2MaxSummaryTokens)
})

test('internalCallReasoningEffort=inherit：完全不碰宿主推理配置（字段不发出）', async () => {
  const llm = fakeLlm({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '## 任务主线\n- 结论。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  await runStep({
    services: { llm: llm.service },
    config: { l2MinTurnsBeforeSummary: 1, internalCallReasoningEffort: 'inherit' },
  })

  const calls = digestCalls(llm)
  assert.equal(calls.length, 1)
  assert.equal('reasoningEffort' in calls[0], false, 'inherit = 不带该字段')
  const { status } = await runStep({
    services: { llm: fakeLlm().service },
    config: { l2MinTurnsBeforeSummary: 1, internalCallReasoningEffort: 'inherit' },
  })
  assert.equal(status.layers.L2.attempt.reasoningEffort, 'inherit')
})

test('档位被拒（UNSUPPORTED_REASONING_EFFORT）：去掉字段重试一次，不让 L2 永久失去模型', async () => {
  const llm = fakeLlm({
    chunks: (index) => (index === 0
      ? [{
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'pi-ai provider "opencode-go" model "x" does not support reasoning effort "low"',
            code: 'UNSUPPORTED_REASONING_EFFORT',
          },
        },
      }]
      : [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '## 任务主线\n- 去掉档位后成功。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
  })
  const { injected, status } = await runStep({
    services: { llm: llm.service },
    config: { l2MinTurnsBeforeSummary: 1 },
  })

  const calls = digestCalls(llm)
  assert.equal(calls.length, 2, '第一次被拒后必须重试一次')
  assert.equal(calls[0].reasoningEffort, 'low')
  assert.equal('reasoningEffort' in calls[1], false, '重试必须去掉该字段')
  assert.equal(status.layers.L2.via, 'llm', '重试成功后仍是 llm 摘要')
  assert.equal(status.layers.L2.attempt.effortRetry, true)
  assert.match(status.layers.L2.attempt.firstFailure, /does not support reasoning effort/)
  assert.match(injected, /去掉档位后成功/)
})

// ── 5. 纯函数：截断点必须落在行/句边界 ────────────────────────────────────

test('trimAtBoundary：行边界（摘要逐行结构的主要形态）', () => {
  const cut = trimAtBoundary('## 任务主线\n- 完整一行\n- 半句话被截断在')
  assert.equal(cut.text, '## 任务主线\n- 完整一行')
  assert.equal(cut.boundary, 'line')
  assert.equal(cut.droppedChars, '- 半句话被截断在'.length + 1)
})

test('trimAtBoundary：句边界（中文句号后不带空格也必须认出来）', () => {
  const cut = trimAtBoundary('已经完成的两句。第三句被截')
  assert.equal(cut.text, '已经完成的两句。')
  assert.equal(cut.boundary, 'sentence')
  assert.equal(cut.droppedChars, '第三句被截'.length)
})

test('trimAtBoundary：路径与版本号里的点号不得被当成句末', () => {
  const cut = trimAtBoundary('保留 v4.1 与 config.yml 的点号\n- 尾部被截')
  assert.equal(cut.text, '保留 v4.1 与 config.yml 的点号', '路径/版本号必须逐字保留，不能切出半截')
  assert.equal(cut.boundary, 'line')
})

test('trimAtBoundary：已经落在句末标点上 → 原样保留（没有截断）', () => {
  const cut = trimAtBoundary('结尾本来就是完整的。')
  assert.equal(cut.text, '结尾本来就是完整的。')
  assert.equal(cut.droppedChars, 0)
})

test('trimAtBoundary：一个边界都没有时**不丢**（没有完美边界不是全丢的理由）', () => {
  const cut = trimAtBoundary('没有标点也没有换行的半句')
  assert.equal(cut.text, '没有标点也没有换行的半句')
  assert.equal(cut.boundary, 'raw')
  assert.equal(cut.droppedChars, 0)
})

test('trimAtBoundary：空文本不产生内容', () => {
  const cut = trimAtBoundary('   \n  ')
  assert.equal(cut.text, '')
  assert.equal(cut.droppedChars, 0)
})

// ── 6. 配置键：扁平标量 + 合法值收口 ──────────────────────────────────────

test('internalCallReasoningEffort 是扁平标量，越界值回落默认', () => {
  assert.equal(DEFAULTS.internalCallReasoningEffort, 'low')
  assert.equal(resolveConfig({ internalCallReasoningEffort: 'inherit' }).internalCallReasoningEffort, 'inherit')
  assert.equal(resolveConfig({ internalCallReasoningEffort: 'max' }).internalCallReasoningEffort, 'max')
  assert.equal(resolveConfig({ internalCallReasoningEffort: 'garbage' }).internalCallReasoningEffort, DEFAULTS.internalCallReasoningEffort)
  assert.equal(resolveConfig({}).internalCallReasoningEffort, DEFAULTS.internalCallReasoningEffort)
})

test('宿主 settings schema 必须声明 internalCallReasoningEffort（否则面板一保存就被改回默认）', () => {
  // 静态断言而不是运行时装配：本检出里 `@deepseek-ai/schemastery` 缺自己的依赖
  // （cosmokit 只在 profile 的 node_modules 里），动态 import 必然失败 →
  // installSection 根本不会被调用，运行时探针在这里探不到任何东西。
  // 而"键漏在 schema 外"的后果是真实发生过的：面板保存会把用户配的值静默改回默认。
  const src = readFileSync(new URL('../src/host/index.ts', import.meta.url), 'utf8')
  assert.match(src, /internalCallReasoningEffort: str\(DEFAULTS\.internalCallReasoningEffort\)/,
    'schema 里必须声明这个键，且默认值取自 DEFAULTS（单一真源）')
  // 构建产物同样要带上：测试跑的是 lib/impl.js，源码对了但没重建等于没改。
  const built = readFileSync(new URL('../lib/impl.js', import.meta.url), 'utf8')
  assert.ok(built.includes('internalCallReasoningEffort'), '构建产物必须包含新键（源码改了要重新 build）')
})

test('改名零迁移成本：旧键 l2ReasoningEffort 不再出现在任何**代码**位置（只有一个真源）', () => {
  // 这个键是上一轮新加的、还没进过任何 patch，因此改名是零成本的；正因如此，
  // **不能留下旧名**——留一个"看起来还能用"的旧键，下一个人就会配它、然后发现没生效。
  // 允许注释里提到旧名（那是在解释"为什么改名"），不允许它以配置键的形态出现：
  // `l2ReasoningEffort:`（对象键 / schema 声明）或 `s.l2ReasoningEffort`（读取）。
  const files = ['../src/host/index.ts', '../src/host/config-core.ts', '../src/host/recall.ts']
  for (const file of files) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /l2ReasoningEffort\s*:/, `${file} 里不得残留旧键的对象键/schema 声明`)
    assert.doesNotMatch(src, /s\.l2ReasoningEffort|settings\.l2ReasoningEffort/, `${file} 里不得残留旧键的读取`)
  }
  const built = readFileSync(new URL('../lib/impl.js', import.meta.url), 'utf8')
  assert.doesNotMatch(built, /l2ReasoningEffort\s*:/, '构建产物里同样不得残留旧键')
  assert.ok(built.includes('internalCallReasoningEffort'), '构建产物必须带上新键')
})
