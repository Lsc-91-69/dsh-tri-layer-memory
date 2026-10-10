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

  // 渲染出来的数字必须与 window.tokens 一致。
  const marker = renderWorkingMemory(window, 'marker')
  assert.match(marker, new RegExp(`约 ${window.tokens} tokens`),
    '注入块里的估算占用应与 window.tokens 同源')
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

test('renderShortTermMemory：无摘要时说明等待中；有摘要时给出覆盖区间与压缩比', () => {
  assert.match(renderShortTermMemory(null, 5), /尚无摘要.*5 轮/s)
  const text = renderShortTermMemory({
    text: '## 任务主线\n- 建插件', via: 'extractive',
    turnFrom: 1, turnTo: 6, tokens: 10, sourceTokens: 100, createdAt: Date.now(),
  }, 0)
  assert.match(text, /覆盖 turn 1–6/)
  assert.match(text, /extractive/)
  assert.match(text, /10x/)
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
