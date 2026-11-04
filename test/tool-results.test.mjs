/**
 * tool-results.test.mjs — 工具输出进 L3（kind='tool'）的边界与三条硬约束。
 *
 * 覆盖：
 * 1. 摘录算法：按轮、时间序、去回执/去重、单条上限、头部优先（含"偏移 147 的探针
 *    曾被 62% 头切掉"的回归）、长摘录才留首尾。
 * 2. 落库：幂等、每会话上限、整库滚动上限、开关关闭时零写入、refs 必须为空。
 * 3. 剪枝：工具池独立于 l3MaxRecords；主内容 drop 集合与"没有工具记录"逐条相同；
 *    里程碑永不淘汰；工具池按新近度保留。
 * 4. 召回渲染：tool 记录必须一眼看出是"原始输出、非结论"。
 * 5. 注入：L3 索引只报工具条数，不报正文；token 增量有上界。
 * 6. 配置：默认值/钳制，且四个键都进了宿主 settings schema。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  TOOL_RECORD_HEADER,
  TOOL_RESULTS_PER_TURN,
  buildToolRecordText,
  captureToolRecord,
  headTail,
  isTrivialToolText,
} from '../src/host/tool-digest.ts'
import {
  scoreRecords,
  selectPrunable,
} from '../src/host/l3-deep.ts'
import { DEFAULTS, resolveConfig } from '../src/host/config-core.ts'
import { estimateTokens } from '../src/host/l1-working.ts'
import { buildRecallTool } from '../src/host/recall.ts'
import { renderDeepIndex } from '../src/host/index.ts'

const ROOT = join(import.meta.dirname, '..')

/** 造一条工具结果。 */
function hit(seq, name, text) {
  return { seq, turn: 1, name, text }
}

/** 造一条 L3 记录。 */
function record(id, kind, options = {}) {
  const text = options.text ?? `${kind} ${id}`
  return {
    id,
    kind,
    createdAt: options.createdAt ?? 1_000,
    sessionId: options.sessionId ?? 's-1',
    turnFrom: options.turnFrom ?? 1,
    turnTo: options.turnTo ?? 1,
    text,
    tokens: options.tokens ?? estimateTokens(text),
    keywords: options.keywords ?? ['probe'],
    refs: options.refs ?? [],
  }
}

/** 只实现 captureToolRecord 需要的三件事；顺序与真实 store 一致（追加在尾部）。 */
function fakeStore(initial = []) {
  const records = [...initial]
  let seq = 0
  return {
    records,
    all: () => records,
    put(input) {
      seq += 1
      const text = String(input.text ?? '')
      const created = Date.now() + seq
      const full = {
        id: `l3-test-${seq}`,
        kind: input.kind,
        createdAt: created,
        sessionId: input.sessionId,
        turnFrom: input.turnFrom,
        turnTo: input.turnTo,
        text,
        tokens: estimateTokens(text),
        keywords: [],
        refs: [...(input.refs ?? [])],
      }
      records.push(full)
      return full
    },
    remove(ids) {
      const drop = new Set(ids)
      const before = records.length
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (drop.has(records[i].id)) records.splice(i, 1)
      }
      return before - records.length
    },
  }
}

test('摘录：按时间序取前 10 条，跳过回执与重复，正文不超单条上限', () => {
  const hits = [
    hit(99, 'read', 'The file D:\\x\\y.ts has been updated successfully.'),
    hit(1, 'pwsh', `Path\n----\nD:\\work\n${'a'.repeat(3000)}`),
    hit(2, 'read', `<path>build.mjs</path>\n1: import { build } from 'esbuild'\n${'b'.repeat(800)}`),
    hit(2, 'read', `<path>build.mjs</path>\n1: import { build } from 'esbuild'\n${'b'.repeat(800)}`),
  ]
  const text = buildToolRecordText(7, hits, 3000)
  assert.ok(text !== null)
  assert.ok(text.startsWith(TOOL_RECORD_HEADER), '正文第一行必须是"原始输出"声明')
  assert.match(text, /turn 7/)
  assert.match(text, /本轮工具结果 4 条/)
  assert.ok(text.length <= 3000, `正文 ${text.length} 字符超过上限`)
  // 重复的 read 只留一条，"文件已写入"回执不出现。
  assert.equal((text.match(/\[2\] read/g) ?? []).length, 1)
  assert.ok(!text.includes('has been updated successfully'))
  // 时间序：seq 1 在 seq 2 前面。
  assert.ok(text.indexOf('seq 1 ·') < text.indexOf('seq 2 ·'))
})

test('摘录：只在开头出现的探针不会被 62/38 的首尾切法吃掉（回归）', () => {
  // 真实故障：1,229 字符的 read 结果里 esbuild 在偏移 147；按 62% 头切时
  // 228 字符的份额只剩 141 字符的头，恰好差 6 个字符。
  const text = `${'前'.repeat(147)}esbuild${'后'.repeat(1000)}`
  const out = headTail(text, 228)
  assert.ok(out.includes('esbuild'), '短份额必须只留开头，不能把开头再切一刀')
  assert.ok(out.length <= 228)
})

test('摘录：长份额留首尾，中间用截断标记说明丢了多少', () => {
  const text = `HEAD${'中'.repeat(3000)}TAIL`
  const out = headTail(text, 1200)
  assert.ok(out.startsWith('HEAD'))
  assert.ok(out.endsWith('TAIL'))
  assert.match(out, /\[截断 \d+ 字符\]/)
})

test('摘录：全是回执时返回 null（不落空记录）', () => {
  assert.equal(isTrivialToolText('OK'), true)
  assert.equal(isTrivialToolText('The file C:\\a.ts has been updated successfully.'), true)
  assert.equal(isTrivialToolText('Found 3 matches\nfoo.ts:1: bar'), false)
  assert.equal(buildToolRecordText(1, [hit(1, 'write', 'OK')], 3000), null)
  assert.equal(buildToolRecordText(1, [], 3000), null)
})

test('摘录：上限配得很小时减条数而不是静默不写', () => {
  const hits = Array.from({ length: 10 }, (_, i) => hit(i + 1, 'pwsh', `${i}-`.repeat(500)))
  const text = buildToolRecordText(1, hits, 600)
  assert.ok(text !== null, '小上限下仍应写出至少一条')
  assert.ok(text.length <= 600)
  assert.ok((text.match(/^\[\d+\] /gm) ?? []).length >= 1)
})

test('落库：开关关闭时零写入；开启时 kind/turn/refs 正确且幂等', () => {
  const store = fakeStore()
  const settings = { enabled: false, maxChars: 3000, maxPerSession: 24, maxRecords: 96 }
  const hits = [hit(1, 'pwsh', 'x'.repeat(300))]
  assert.equal(captureToolRecord({ store, sessionId: 's-1', turn: 3, hits, settings }), null)
  assert.equal(store.records.length, 0)

  const on = { ...settings, enabled: true }
  const rec = captureToolRecord({ store, sessionId: 's-1', turn: 3, hits, settings: on })
  assert.ok(rec !== null)
  assert.equal(rec.kind, 'tool')
  assert.equal(rec.turnFrom, 3)
  assert.equal(rec.turnTo, 3)
  assert.deepEqual(rec.refs, [], '工具记录绝不能有出边/入边，否则会挤占主内容')
  // 同一轮重复扫描（进程重启水位回退）不重复落库。
  assert.equal(captureToolRecord({ store, sessionId: 's-1', turn: 3, hits, settings: on }), null)
  assert.equal(store.records.length, 1)
})

test('落库：每会话上限按会话分别计数', () => {
  const store = fakeStore()
  const settings = { enabled: true, maxChars: 3000, maxPerSession: 2, maxRecords: 96 }
  const hits = [hit(1, 'pwsh', 'x'.repeat(300))]
  assert.ok(captureToolRecord({ store, sessionId: 's-1', turn: 1, hits, settings }))
  assert.ok(captureToolRecord({ store, sessionId: 's-1', turn: 2, hits, settings }))
  assert.equal(captureToolRecord({ store, sessionId: 's-1', turn: 3, hits, settings }), null, '本会话已满')
  assert.ok(captureToolRecord({ store, sessionId: 's-2', turn: 1, hits, settings }), '别的会话不受影响')
})

test('落库：整库上限是滚动窗口，最旧的工具记录先走', () => {
  const old = record('old', 'tool', { createdAt: 100 })
  const older = record('older', 'tool', { createdAt: 50 })
  const store = fakeStore([older, old])
  const settings = { enabled: true, maxChars: 3000, maxPerSession: 24, maxRecords: 2 }
  const rec = captureToolRecord({ store, sessionId: 's-2', turn: 9, hits: [hit(1, 'pwsh', 'y'.repeat(300))], settings })
  assert.ok(rec !== null)
  assert.equal(store.records.length, 2)
  assert.equal(store.records.some((r) => r.id === 'older'), false, '最旧的一条被挤出')
  assert.equal(store.records.some((r) => r.id === 'old'), true)
})

test('剪枝：工具池独立于 maxRecords，主内容 drop 集合与没有工具记录时逐条相同', () => {
  const now = 10_000_000
  const main = Array.from({ length: 40 }, (_, i) => record(`main-${i}`, i % 7 === 0 ? 'digest' : 'turn', {
    createdAt: now - i * 1000,
    keywords: i % 3 === 0 ? [] : ['probe'],
  }))
  const tools = Array.from({ length: 12 }, (_, i) => record(`tool-${i}`, 'tool', {
    createdAt: now - i * 500,
    keywords: [],
  }))
  const limits = { maxRecords: 4, maxPerSession: 4 }
  const withTools = selectPrunable(scoreRecords([...main, ...tools], ['probe'], now), 0, 10, limits)
  const withoutTools = selectPrunable(scoreRecords(main, ['probe'], now), 0, 10)
  const mainIds = new Set(main.map((r) => r.id))
  const a = [...withTools].filter((id) => mainIds.has(id)).sort()
  const b = [...withoutTools].sort()
  assert.deepEqual(a, b, '工具记录不许改变任何一条主内容的去留')
  const droppedTools = [...withTools].filter((id) => id.startsWith('tool-'))
  assert.equal(droppedTools.length, 8, '工具池只按自己的上限（4 条）淘汰')
  assert.equal(withTools.has('tool-0'), false, '保留最新的工具记录')
  assert.equal(withTools.has('tool-11'), true)
})

test('剪枝：里程碑在工具池存在时仍然一条不丢', () => {
  const now = 10_000_000
  const milestone = record('m-1', 'milestone', { createdAt: 1, keywords: [] })
  const turns = Array.from({ length: 20 }, (_, i) => record(`t-${i}`, 'turn', { createdAt: now - i, keywords: [] }))
  const tools = Array.from({ length: 5 }, (_, i) => record(`tool-${i}`, 'tool', { createdAt: now - i, keywords: [] }))
  const drop = selectPrunable(scoreRecords([milestone, ...turns, ...tools], [], now), 1, 2, { maxRecords: 2, maxPerSession: 2 })
  assert.equal(drop.has('m-1'), false, '里程碑永不被工具池或主内容上限挤掉')
})

test('召回：tool 记录必须渲染成"原始输出、非结论"', async () => {
  const toolRecord = record('l3-tool-1', 'tool', {
    text: `${TOOL_RECORD_HEADER} · turn 5\n- 本轮工具结果 2 条 / 900 字符；本记录摘录 1 条（其余未存）。\n[1] pwsh · seq 9 · 900 字符\nesbuild NOT resolvable`,
    turnFrom: 5,
    turnTo: 5,
  })
  const runtime = {
    ctx: {},
    config: () => ({ recall: { defaultLimit: 5, maxLimit: 20 }, l2: { inject: true }, l3: { dir: '', enabled: true } }),
    recallTool: () => ({ name: 'memory_recall', reason: 'test' }),
    search: () => [toolRecord],
    get: () => toolRecord,
    stats: () => ({ count: 1, tokens: 10, backend: 'sqlite', oldest: 0, newest: 1, tools: 1, toolTokens: 10 }),
    digestText: () => null,
  }
  const tool = buildRecallTool(runtime)
  const out = await tool.execute({ query: 'esbuild' }, { agent: { session: {} } })
  assert.match(out, /原始输出/)
  assert.match(out, /非结论/)
  assert.match(out, /不是结论/)
  assert.ok(out.includes('esbuild NOT resolvable'))
})

test('注入：L3 索引只报工具条数，不报正文；token 增量有上界', () => {
  const withTools = renderDeepIndex(
    { count: 120, tokens: 5000, backend: 'sqlite', tools: 20, toolTokens: 3000 },
    ['alpha', 'beta'],
    'memory_recall',
    '',
  )
  const without = renderDeepIndex({ count: 100, tokens: 2000, backend: 'sqlite', tools: 0, toolTokens: 0 }, ['alpha', 'beta'], 'memory_recall', '')
  assert.match(withTools, /已持久化 100 条记录/)
  // 剪枝验收：条数之外的规模元信息（tokens/后端名/主题词）都不再进注入。
  assert.doesNotMatch(withTools, /约 \d+ tokens|sqlite|近期主题|alpha|beta/,
    `L3 索引不该再带 tokens/后端/主题，实际：${withTools}`)
  assert.match(withTools, /工具原始输出 20 条/)
  assert.ok(!withTools.includes('SECRET-TOOL-BODY'), '工具正文绝不能进注入')
  const delta = estimateTokens(withTools) - estimateTokens(without)
  assert.ok(delta > 0 && delta <= 40, `工具计数行的 token 增量应 ≤40，实际 ${delta}`)
})

test('配置：四个键有默认值、可钳制，且都声明进了宿主 settings schema', () => {
  assert.equal(DEFAULTS.l3ToolDistill, true)
  assert.equal(DEFAULTS.l3ToolRecordChars, 3000)
  assert.equal(DEFAULTS.l3ToolMaxPerSession, 24)
  assert.equal(DEFAULTS.l3ToolMaxRecords, 96)
  assert.deepEqual(resolveConfig({}), DEFAULTS)

  assert.equal(resolveConfig({ l3ToolDistill: false }).l3ToolDistill, false)
  assert.equal(resolveConfig({ l3ToolRecordChars: 1 }).l3ToolRecordChars, 400)
  assert.equal(resolveConfig({ l3ToolRecordChars: 999_999 }).l3ToolRecordChars, 20_000)
  assert.equal(resolveConfig({ l3ToolMaxPerSession: 0 }).l3ToolMaxPerSession, 1)
  assert.equal(resolveConfig({ l3ToolMaxRecords: 0 }).l3ToolMaxRecords, 1)
  // 非布尔值的开关不能悄悄变成 true（回落默认值）。
  assert.equal(resolveConfig({ l3ToolDistill: 'yes' }).l3ToolDistill, DEFAULTS.l3ToolDistill)

  const source = readFileSync(join(ROOT, 'src/host/index.ts'), 'utf8')
  for (const line of [
    'l3ToolDistill: bool(DEFAULTS.l3ToolDistill)',
    'l3ToolRecordChars: num(DEFAULTS.l3ToolRecordChars)',
    'l3ToolMaxPerSession: num(DEFAULTS.l3ToolMaxPerSession)',
    'l3ToolMaxRecords: num(DEFAULTS.l3ToolMaxRecords)',
  ]) {
    assert.ok(source.includes(line), `settings schema 必须声明 ${line}`)
  }
  assert.ok(source.includes('maxPerSession: settings.l3ToolMaxPerSession'), '剪枝必须把每会话上限传下去')
  assert.ok(source.includes('maxRecords: settings.l3ToolMaxRecords'), '剪枝必须把整库上限传下去')
  assert.equal(TOOL_RESULTS_PER_TURN, 10)
})
