/**
 * constraint-digest.test.mjs — `tool/call` 参数里的约束原话进 L3（kind='constraint'）。
 *
 * 为什么单独一个测试文件：这条路的失败**全是静默的**——抽不出句子时只是"库里少一类
 * 记录"，磁盘、日志、面板都不会报错。所以每个边界都必须用真实片段钉住：
 *
 * 1. 抽取：折行合并（P7 回归）、只留含约束词的句子、编号 `2.` 不算句末、
 *    JSON 解析失败退化为原文扫描（不丢整条参数）。
 * 2. 正文：五条真实硬约束的原句必须逐字出现；超单条上限时减句而不是不写。
 * 3. 落库：开关、幂等（同轮多次调用合并一条）、每会话上限、整库按强度淘汰
 *    （turn 1 的铁律不能被新记录挤掉）。
 * 4. 剪枝：约束池独立于 l3MaxRecords，主内容 drop 集合与"没有约束记录"逐条相同。
 * 5. 注入：L3 索引只多一行计数，正文一个字符都不进注入；token 增量有上界。
 * 6. 配置：四个键有默认值、可钳制，且都声明进了宿主 settings schema。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONSTRAINT_RECORD_HEADER,
  CONSTRAINT_SENTENCE_CHARS,
  argumentTexts,
  buildConstraintRecordText,
  callTarget,
  captureConstraintRecord,
  collectConstraintItems,
  extractConstraintSentences,
  unwrapSoftWrap,
} from '../src/host/constraint-digest.ts'
import {
  CONSTRAINT_STRONG_RE,
  constraintStrength,
  scoreRecords,
  selectPrunable,
} from '../src/host/l3-deep.ts'
import { DEFAULTS, resolveConfig } from '../src/host/config-core.ts'
import { estimateTokens } from '../src/host/l1-working.ts'
import { panelRecords, renderDeepIndex } from '../src/host/index.ts'

const ROOT = join(import.meta.dirname, '..')

/** 一条 tool/call（只保留抽取需要的三个字段）。 */
function call(seq, name, args, turn = 1) {
  return { seq, turn, name, args }
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
    keywords: options.keywords ?? [],
    refs: options.refs ?? [],
  }
}

/** 只实现 captureConstraintRecord 需要的三件事；顺序与真实 store 一致（追加在尾部）。 */
function fakeStore(initial = []) {
  const records = [...initial]
  let seq = 0
  return {
    records,
    all: () => records,
    put(input) {
      seq += 1
      const text = String(input.text ?? '')
      const full = {
        id: `l3-c-${seq}`,
        kind: input.kind,
        createdAt: 10_000 + seq,
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

// ── 1. 抽取 ────────────────────────────────────────────────────────────────

test('抽取：P7 的折行原文必须接成完整一句（"（否则 loader 报" 不能断在括号里）', () => {
  // 真实片段（seq 479 的 write content）：续行以 `*` 开头 + 4 空格缩进。
  const raw = [
    ' * 1. bundle 声明与 patch 文件（缺了 → 装了包但不激活任何层）。',
    ' * 2. patch 里每个行 name 必须能在 dependencies 里解析（否则 loader 报',
    ' *    "Cannot find package"）。',
  ].join('\n')
  const sentences = extractConstraintSentences(raw)
  assert.equal(sentences.length, 1, `应只抽出第二条；实际 ${JSON.stringify(sentences)}`)
  assert.ok(sentences[0].includes('必须能在 dependencies 里解析'), '前半句在')
  assert.ok(sentences[0].includes('"Cannot find package"）。'), '续行必须被接回来，否则句子断在括号里')
})

test('抽取：代码行不会被拼进注释句子（"}" 结尾的行不算可续行）', () => {
  const raw = [
    '    } catch (error: unknown) {',
    '      // 记忆层永远不能让对话失败：注入失败即跳过本轮投影。',
  ].join('\n')
  const sentences = extractConstraintSentences(raw)
  assert.equal(sentences.length, 1)
  assert.equal(sentences[0], '// 记忆层永远不能让对话失败：注入失败即跳过本轮投影。')
  assert.ok(!sentences[0].startsWith('}'), '代码行不能成为句子的开头')
})

test('抽取：编号 `2.` 里的半角句号不算句末（否则每行都被切碎）', () => {
  assert.equal(unwrapSoftWrap('2. patch 行必须可解析（否则 loader 报\n    "Cannot find"）。'),
    '2. patch 行必须可解析（否则 loader 报 "Cannot find"）。')
})

test('抽取：只留含约束词的句子；不含约束词的整段被丢弃', () => {
  const text = [
    '# 普通说明：这个函数做加法。',
    '# 必须保留：cachePath 绝不要用相对路径。',
    'const x = 1',
  ].join('\n')
  const sentences = extractConstraintSentences(text)
  assert.deepEqual(sentences, ['# 必须保留：cachePath 绝不要用相对路径。'])
  // 太短的片段（`});`）即便含约束词也不算句子。
  assert.deepEqual(extractConstraintSentences('必须'), [])
})

test('抽取：JSON 解析失败退化为原文扫描（一次 parse 失败不能丢掉整条参数）', () => {
  const broken = '{"content":"配置必须显式给出 cachePath，绝不能省略'
  assert.deepEqual(argumentTexts(broken), [broken])
  assert.deepEqual(argumentTexts(''), [])
  const ok = JSON.stringify({ path: 'a.ts', content: 'x'.repeat(10), n: 3 })
  assert.deepEqual(argumentTexts(ok), ['a.ts', 'x'.repeat(10)])
})

test('抽取：callTarget 取 path/file_path，取不到时为空串', () => {
  assert.equal(callTarget(JSON.stringify({ path: 'src/a.ts' })), 'src/a.ts')
  // 两个键同时出现时取 `path`（本项目 write/edit 用的就是它；另一路径仅兜底）。
  assert.equal(callTarget(JSON.stringify({ file_path: 'b.ts', path: 'a.ts' })), 'a.ts')
  assert.equal(callTarget(JSON.stringify({ command: 'ls' })), '')
  assert.equal(callTarget('not-json'), '')
})

test('抽取：轮内去重（同一句被 write/edit 写两遍只存一次），跨轮不去重', () => {
  const sentence = '配置必须显式给出 cachePath，绝不能省略。'
  const calls = [
    call(1, 'write', JSON.stringify({ path: 'a.ts', content: sentence })),
    call(2, 'edit', JSON.stringify({ path: 'a.ts', old_string: sentence, new_string: sentence })),
  ]
  const items = collectConstraintItems(calls)
  assert.equal(items.length, 1, '同一句只出现一次')
  assert.equal(items[0].seq, 1, '保留首次出现的来源')
  assert.equal(items[0].target, 'a.ts')
})

// ── 2. 正文：五条真实硬约束 ───────────────────────────────────────────────

/** 五条硬约束的真实原文片段（来自 seq 231/283/387/479/543，逐字）。 */
const HARD_CONSTRAINTS = [
  ['P1', '两者绝不能同时启用'],
  ['P4', '记忆层永远不能让对话失败'],
  ['P5', 'dshHomePath 助手解析到 $DSH_HOME 内，绝不写死'],
  ['P6', '绝不内联，否则会出现两份 cordis Service 定义'],
  ['P7', 'patch 里每个行 name 必须能在 dependencies 里解析'],
]

test('正文：五条真实硬约束的原句逐字进记录，且头部声明"非结论"', () => {
  const calls = [
    call(231, 'write', JSON.stringify({
      path: 'scripts/build.mjs',
      content: ' *   外部化 @deepseek-ai/* 与 dsh-*：这些包由运行时（app.asar 内的 dsh\n *   node_modules 链）解析，绝不内联，否则会出现两份 cordis Service 定义。',
    })),
    call(283, 'write', JSON.stringify({
      path: 'src/host/index.ts',
      content: '    } catch (error: unknown) {\n      // 记忆层永远不能让对话失败：注入失败即跳过本轮投影。',
    })),
    call(387, 'write', JSON.stringify({
      path: 'cordis.patch.yml',
      content: '# 所有落盘路径一律经 loader 的 dshHomePath 助手解析到 $DSH_HOME 内，绝不写死\n# 某台机器的绝对路径（历史教训）。',
    })),
    call(479, 'write', JSON.stringify({
      path: 'test/contract.test.mjs',
      content: ' * 2. patch 里每个行 name 必须能在 dependencies 里解析（否则 loader 报\n *    "Cannot find package"）。',
    })),
    call(543, 'write', JSON.stringify({
      path: 'README.md',
      content: 'argp 与 instant 都注册工具 `recall`，**两者绝不能同时启用**。包内\n`test/contract.test.mjs` 把这条约束固化成断言。',
    })),
  ]
  const text = buildConstraintRecordText(1, calls, 6000)
  assert.ok(text !== null)
  assert.ok(text.startsWith(CONSTRAINT_RECORD_HEADER), '正文第一行必须自述"来自工具调用参数、非结论"')
  for (const [id, fragment] of HARD_CONSTRAINTS) {
    assert.ok(text.includes(fragment), `${id} 的原文必须逐字在记录里（缺：${fragment}）`)
  }
  assert.match(text, /turn 1/)
  assert.match(text, /本轮工具调用 5 次/)
  assert.ok(text.length <= 6000)
})

test('正文：超单条上限时减少句数（并写明丢了几句），绝不返回 null', () => {
  const body = Array.from({ length: 40 }, (_, i) => `第 ${i} 条：这个路径绝不能写死，必须显式给出。`).join('\n')
  const calls = [call(1, 'write', JSON.stringify({ path: 'a.ts', content: body }))]
  const text = buildConstraintRecordText(1, calls, 900)
  assert.ok(text !== null, '配了上限却一条不写是最难发现的静默故障')
  assert.ok(text.length <= 900)
  assert.match(text, /其余 \d+ 条因单条上限未存/)
})

test('正文：超上限时按约束强度裁剪——截尾会丢的 P1 必须留下（回归）', () => {
  // 真实故障：turn 1 全文 9,270 字符，默认上限曾是 6000。按"截尾"裁剪时，
  // `两者绝不能同时启用`（P1）排在 turn 1 后半段，正好被截掉；按强度裁剪后它必留。
  const weak = Array.from({ length: 40 }, (_, i) => `第 ${i} 条说明：不要用临时变量，避免重复读取。`).join('\n')
  const tail = 'argp 与 instant 都注册工具 `recall`，**两者绝不能同时启用**。'
  const calls = [call(1, 'write', JSON.stringify({ path: 'a.ts', content: `${weak}\n${tail}` }))]
  const text = buildConstraintRecordText(1, calls, 1200)
  assert.ok(text !== null)
  assert.ok(text.includes('两者绝不能同时启用'), '强约束不能被截尾丢掉')
  assert.ok(text.length <= 1200)
  assert.match(text, /其余 \d+ 条因单条上限未存（先丢弱约束）/)
})

test('正文：本轮没有任何约束句时返回 null（不落空记录）', () => {
  assert.equal(buildConstraintRecordText(1, [], 6000), null)
  assert.equal(buildConstraintRecordText(1, [call(1, 'pwsh', JSON.stringify({ command: 'ls -la' }))], 6000), null)
})

// ── 3. 落库 ────────────────────────────────────────────────────────────────

test('落库：开关关闭时零写入；开启时 kind/turn/refs 正确且幂等', () => {
  const store = fakeStore()
  const calls = [call(1, 'write', JSON.stringify({ path: 'a.ts', content: '这个路径必须显式给出。' }))]
  const settings = { enabled: false, maxChars: 6000, maxPerSession: 60, maxRecords: 300 }
  assert.equal(captureConstraintRecord({ store, sessionId: 's-1', turn: 3, calls, settings }), null)
  assert.equal(store.records.length, 0)

  const on = { ...settings, enabled: true }
  const rec = captureConstraintRecord({ store, sessionId: 's-1', turn: 3, calls, settings: on })
  assert.ok(rec !== null)
  assert.equal(rec.kind, 'constraint')
  assert.equal(rec.turnFrom, 3)
  assert.equal(rec.turnTo, 3)
  assert.deepEqual(rec.refs, [], '约束记录绝不能有出边/入边，否则会挤占主内容')
  // 同一轮重复扫描（进程重启水位回退）不重复落库。
  assert.equal(captureConstraintRecord({ store, sessionId: 's-1', turn: 3, calls, settings: on }), null)
  assert.equal(store.records.length, 1)
})

test('落库：同轮多次调用合并成一条记录（不是每 call 一条）', () => {
  const store = fakeStore()
  const settings = { enabled: true, maxChars: 6000, maxPerSession: 60, maxRecords: 300 }
  const calls = [
    call(10, 'write', JSON.stringify({ path: 'a.ts', content: '配置必须显式给出 cachePath。' })),
    call(11, 'edit', JSON.stringify({ path: 'b.ts', content: '库绝不能出现两份 Service。' })),
    call(12, 'pwsh', JSON.stringify({ command: 'npm run build' })),
  ]
  const rec = captureConstraintRecord({ store, sessionId: 's-1', turn: 5, calls, settings })
  assert.ok(rec !== null)
  assert.equal(store.records.length, 1, '同轮多次调用只落一条')
  assert.ok(rec.text.includes('cachePath'))
  assert.ok(rec.text.includes('两份 Service'))
  assert.ok(rec.text.includes('本轮工具调用 3 次'))
})

test('落库：每会话上限按会话分别计数', () => {
  const store = fakeStore()
  const settings = { enabled: true, maxChars: 6000, maxPerSession: 1, maxRecords: 300 }
  const calls = [call(1, 'write', JSON.stringify({ path: 'a.ts', content: '这个路径必须显式给出。' }))]
  assert.ok(captureConstraintRecord({ store, sessionId: 's-1', turn: 1, calls, settings }))
  assert.equal(captureConstraintRecord({ store, sessionId: 's-1', turn: 2, calls, settings }), null, '本会话已满')
  assert.ok(captureConstraintRecord({ store, sessionId: 's-2', turn: 1, calls, settings }), '别的会话不受影响')
})

test('落库：整库上限按约束强度淘汰——弱约束先走，turn 1 的铁律留下', () => {
  const strong = record('strong', 'constraint', {
    text: '两个引擎绝不能同时启用，必须抛错。',
    turnFrom: 1,
    createdAt: 100,
  })
  const weak = record('weak', 'constraint', {
    text: '这里不要用临时变量。',
    turnFrom: 9,
    createdAt: 9_000,
  })
  const store = fakeStore([strong, weak])
  const settings = { enabled: true, maxChars: 6000, maxPerSession: 60, maxRecords: 2 }
  const calls = [call(1, 'write', JSON.stringify({ path: 'a.ts', content: '这个路径必须显式给出。' }))]
  const rec = captureConstraintRecord({ store, sessionId: 's-2', turn: 20, calls, settings })
  assert.ok(rec !== null)
  assert.equal(store.records.length, 2)
  assert.equal(store.records.some((r) => r.id === 'weak'), false, '弱约束先被淘汰')
  assert.equal(store.records.some((r) => r.id === 'strong'), true, 'turn 1 的强约束必须留下')
})

// ── 4. 剪枝 ────────────────────────────────────────────────────────────────

test('剪枝：约束池独立于 maxRecords，主内容 drop 集合与没有约束记录时逐条相同', () => {
  const now = 10_000_000
  const main = Array.from({ length: 40 }, (_, i) => record(`main-${i}`, i % 7 === 0 ? 'digest' : 'turn', {
    createdAt: now - i * 1000,
    keywords: i % 3 === 0 ? [] : ['probe'],
  }))
  const pool = Array.from({ length: 12 }, (_, i) => record(`c-${i}`, 'constraint', {
    createdAt: now - i * 500,
    turnFrom: i + 1,
    // 让 turn 1 那条最强：剪枝必须优先留它。
    text: i === 0 ? '两个引擎绝不能同时启用，必须抛错，禁止并存。' : `不要写临时变量 ${i}。`,
    keywords: [],
  }))
  const limits = { maxRecords: 4, maxPerSession: 4 }
  const withPool = selectPrunable(scoreRecords([...main, ...pool], ['probe'], now), 0, 10, undefined, limits)
  const withoutPool = selectPrunable(scoreRecords(main, ['probe'], now), 0, 10)
  const mainIds = new Set(main.map((r) => r.id))
  const a = [...withPool].filter((id) => mainIds.has(id)).sort()
  const b = [...withoutPool].sort()
  assert.deepEqual(a, b, '约束记录不许改变任何一条主内容的去留')
  const droppedPool = [...withPool].filter((id) => id.startsWith('c-'))
  assert.equal(droppedPool.length, 8, '约束池只按自己的上限（4 条）淘汰')
  assert.equal(withPool.has('c-0'), false, 'turn 1 的强约束强度最高，必须留下')
})

test('剪枝：不传 constraintLimits 时行为与扩展前一致（旧调用方不受影响）', () => {
  const now = 10_000_000
  const recs = [
    record('a', 'constraint', { createdAt: now - 10, keywords: ['probe'] }),
    record('b', 'turn', { createdAt: now - 20, keywords: ['probe'] }),
  ]
  const drop = selectPrunable(scoreRecords(recs, ['probe'], now), 0, 10, { maxRecords: 10, maxPerSession: 10 })
  assert.equal(drop.size, 0, 'constraint 记录在旧调用路径里按普通记录处理')
})

test('剪枝：constraintStrength 按强约束词计数，弱句为 0', () => {
  assert.equal(constraintStrength('两个引擎绝不能同时启用，必须抛错'), 2)
  assert.equal(constraintStrength('这里不要用临时变量'), 0)
  assert.ok(CONSTRAINT_STRONG_RE.test('禁止内联'))
})

// ── 5. 注入 ────────────────────────────────────────────────────────────────

test('注入：L3 索引只多一行计数，正文一个字符都不进注入，token 增量有上界', () => {
  const SECRET = 'SECRET-CONSTRAINT-BODY 两个引擎绝不能同时启用'
  const withPool = renderDeepIndex(
    { count: 140, tokens: 5000, backend: 'sqlite', tools: 20, toolTokens: 3000, constraints: 20, constraintTokens: 2000 },
    ['alpha'],
    'memory_recall',
    '',
  )
  const without = renderDeepIndex(
    { count: 120, tokens: 3000, backend: 'sqlite', tools: 20, toolTokens: 3000, constraints: 0, constraintTokens: 0 },
    ['alpha'],
    'memory_recall',
    '',
  )
  assert.match(withPool, /已持久化 100 条记录/, '主内容口径必须扣掉两个细节池')
  assert.match(withPool, /约束原话 20 条/)
  assert.ok(!withPool.includes(SECRET), '约束正文绝不能进注入')
  const delta = estimateTokens(withPool) - estimateTokens(without)
  assert.ok(delta > 0 && delta <= 45, `约束计数行的 token 增量应 ≤45，实际 ${delta}`)
  // 没有约束记录时不多出任何一行（旧库的注入逐字不变）。
  assert.doesNotMatch(without, /约束原话/)
})

// ── 6. 配置 ────────────────────────────────────────────────────────────────

test('面板：constraint 进思维栏但正文截到 300 字符；tool 记录仍整个不进', () => {
  const long = record('c-long', 'constraint', { text: `约束原话（来自工具调用参数，非结论）· turn 1\n${'x'.repeat(1200)}` })
  const short = record('c-short', 'constraint', { text: '短约束：必须显式给出 cachePath。' })
  const tool = record('t-1', 'tool', { text: 'y'.repeat(100) })
  const turn = record('turn-1', 'turn', { text: 'turn body' })
  const out = panelRecords([long, short, tool, turn])
  assert.equal(out.some((r) => r.id === 't-1'), false, 'tool 记录仍不进面板')
  assert.equal(out.find((r) => r.id === 'c-short')?.text, short.text, '短的约束原样展示')
  const clipped = out.find((r) => r.id === 'c-long')
  assert.ok(clipped !== undefined, '长的约束也要出现（否则面板看不到铁律）')
  assert.ok(clipped.text.length <= 300 + 40, `截断后长度 ${clipped.text.length}`)
  assert.match(clipped.text, /全文用 recall/)
  assert.ok(clipped.text.startsWith('约束原话'), '保留头部，读者能认出这是约束记录')
})

test('schema：projection.ts 的 recordSchema.kind 是 z.string()，新增 kind 不需要 bump stateVersion', () => {
  // 用户要求"核实，别凭印象"：这里直接读源码，钉住"kind 不是枚举"这个前提。
  // 一旦有人把它改成 z.enum([...])，新增 kind 就会在 viewSchema.parse 时抛错
  // （抛在框架侧、插件收不到，表现是"思维栏空着"）——这条断言就是那个报警器。
  const source = readFileSync(join(ROOT, 'src/host/projection.ts'), 'utf8')
  assert.match(source, /const recordSchema = z\.object\(\{[\s\S]*?kind: z\.string\(\)/, 'recordSchema.kind 必须是 z.string()')
  assert.doesNotMatch(source, /kind: z\.enum\(/, 'recordSchema.kind 不能改成枚举（会拒绝新 kind）')
})

test('配置：四个键有默认值、可钳制，且都声明进了宿主 settings schema', () => {
  assert.equal(DEFAULTS.l3ConstraintDistill, true)
  assert.equal(DEFAULTS.l3ConstraintRecordChars, 12000)
  assert.equal(DEFAULTS.l3ConstraintMaxPerSession, 60)
  assert.equal(DEFAULTS.l3ConstraintMaxRecords, 300)
  assert.deepEqual(resolveConfig({}), DEFAULTS)

  assert.equal(resolveConfig({ l3ConstraintDistill: false }).l3ConstraintDistill, false)
  assert.equal(resolveConfig({ l3ConstraintRecordChars: 1 }).l3ConstraintRecordChars, 800)
  assert.equal(resolveConfig({ l3ConstraintRecordChars: 999_999 }).l3ConstraintRecordChars, 20_000)
  assert.equal(resolveConfig({ l3ConstraintMaxPerSession: 0 }).l3ConstraintMaxPerSession, 1)
  assert.equal(resolveConfig({ l3ConstraintMaxRecords: 0 }).l3ConstraintMaxRecords, 1)
  // 非布尔值的开关不能悄悄变成 true（回落默认值）。
  assert.equal(resolveConfig({ l3ConstraintDistill: 'yes' }).l3ConstraintDistill, DEFAULTS.l3ConstraintDistill)
  // 单句上限必须能被单条上限的钳制下限容纳：否则"配到下限"就会一句也写不下。
  assert.ok(CONSTRAINT_SENTENCE_CHARS <= 800, '单句上限必须能被 800 字符的单条下限容纳')

  const source = readFileSync(join(ROOT, 'src/host/index.ts'), 'utf8')
  for (const line of [
    'l3ConstraintDistill: bool(DEFAULTS.l3ConstraintDistill)',
    'l3ConstraintRecordChars: num(DEFAULTS.l3ConstraintRecordChars)',
    'l3ConstraintMaxPerSession: num(DEFAULTS.l3ConstraintMaxPerSession)',
    'l3ConstraintMaxRecords: num(DEFAULTS.l3ConstraintMaxRecords)',
  ]) {
    assert.ok(source.includes(line), `settings schema 必须声明 ${line}`)
  }
  assert.ok(source.includes('maxPerSession: settings.l3ConstraintMaxPerSession'), '剪枝必须把每会话上限传下去')
  assert.ok(source.includes('maxRecords: settings.l3ConstraintMaxRecords'), '剪枝必须把整库上限传下去')
})
