/**
 * test/layered-digest.test.mjs — 分层抽取（L3 `turn` 记录）的行为测试。
 *
 * 这些用例盯的不是"正文变长了"，而是四条不能被静默破坏的性质：
 * 1. **默认路径逐字不变**：`extractiveDigest(spans)` 仍是 L2 注入正文的回退产物，
 *    它的体积直接进每轮注入；分层只走 `layered: true`；
 * 2. **四小节结构保持**：任何上限、任何裁剪都不能切掉小节标题；
 * 3. **假阳性有明确处置**：安抚语/疑问/标题/双重否定不进约束类——判据不可靠时
 *    宁可归 `other`，也不要把噪声写进"约束"这一格；
 * 4. **丢弃可见**：装不下的片段必须计入 `stats.dropped`，不做静默截断。
 *
 * 直接 import `src/host/*.ts`（Node 原生类型剥离），无需构建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyFragment,
  digestFragments,
  extractiveDigest,
  LAYERED_DIGEST_MAX_CHARS,
  layeredDigest,
} from '../src/host/l2-render.ts'
import { DeepMemoryStore } from '../src/host/l3-deep.ts'

/** 造一个最小可用的 `TurnSpan`（其余字段对本模块无用）。 */
function span(turn, userText = [], assistantText = [], toolNames = []) {
  return {
    turn,
    startSeq: turn * 100,
    endSeq: turn * 100 + 99,
    messageSeqs: [],
    userText,
    assistantText,
    toolNames,
    charCount: 0,
    tokens: 0,
    projections: 0,
    open: false,
  }
}

const SECTIONS = ['## 任务主线', '## 已完成的子任务', '## 关键决策与依据', '## 未决问题']

function sectionOf(text, head) {
  const start = text.indexOf(head)
  if (start < 0) return ''
  const rest = text.slice(start + head.length)
  const next = SECTIONS.map((h) => rest.indexOf(h)).filter((i) => i >= 0)
  return next.length === 0 ? rest : rest.slice(0, Math.min(...next))
}

test('四小节结构保持，空小节有 (none) 占位', () => {
  const text = extractiveDigest([span(7, ['改一下'], [])], { layered: true })
  for (const head of SECTIONS) assert.ok(text.includes(head), `缺少小节 ${head}：${text}`)
  assert.match(sectionOf(text, '## 未决问题'), /^\s*- \(none\)/)
})

test('默认路径逐字不含分层标记：注入正文的体积不受分层改造影响', () => {
  const single = span(7, ['必须先改 schema'], ['Error: ENOENT: no such file or directory'])
  const plain = extractiveDigest([single])
  // 分层标记是"这条记录想告诉模型该按什么用"的提示，注入正文里不需要它，
  // 更不能因为开了分层就让注入正文变长。
  assert.doesNotMatch(plain, /\[(?:约束|排除|失败|推断|参数|验证)\]/)
  assert.equal(plain, extractiveDigest([single]), '默认路径必须是确定性的')

  const layered = extractiveDigest([single], { layered: true })
  assert.match(layered, /\[约束\]/)
  assert.match(layered, /\[失败\]/)
})

test('分层输出仍满足旧契约：任务主线/用户首行/工具名/未决问题都在', () => {
  const text = extractiveDigest([span(3, ['第3轮的用户请求'], [], ['read_file', 'pwsh'])], { layered: true })
  assert.match(text, /## 任务主线/)
  assert.match(text, /第3轮的用户请求/)
  assert.match(text, /read_file/)
  assert.match(text, /## 未决问题/)
})

test('约束句优先整句保留，不受 160 字上限', () => {
  const filler = '这是一段很长的上下文说明，用来把 160 字配额吃光。'.repeat(6)
  const constraint = '缓存路径绝不要用相对路径，必须解析 $DSH_HOME 后写绝对路径。'
  const text = extractiveDigest([span(3, [filler, constraint], [])], { layered: true })
  assert.ok(text.includes(constraint), `约束句必须整句保留：${text}`)
  assert.ok(text.length <= LAYERED_DIGEST_MAX_CHARS, `不得超过硬上限：${text.length}`)
})

test('假阳性抑制：安抚语/疑问/标题/双重否定不算约束', () => {
  assert.notEqual(classifyFragment('不要担心，这次部署没问题的。').kind, 'constraint')
  assert.notEqual(classifyFragment('必须现在改吗？').kind, 'constraint')
  assert.notEqual(classifyFragment('## 三个必须知道的偏差').kind, 'constraint')
  assert.notEqual(classifyFragment('这件事不能不说清楚。').kind, 'constraint')
  // 真正的硬约束仍要认出来（否则上一条就成了"什么都不判"）。
  assert.equal(classifyFragment('cachePath 绝不要用相对路径。').kind, 'constraint')
  assert.equal(classifyFragment('patch 每一行的 name 必须能在 node_modules 解析。').kind, 'constraint')
})

test('排除句进「关键决策与依据」，弱判据需要决策语境', () => {
  // 用户侧给一句真诉求，否则骨架会拿助手第一句当"诉求行"，排除句就跑到
  // 任务主线里去了（那是设计上允许的，但测不到这里的断言目标）。
  const text = extractiveDigest([span(5, ['改一下部署脚本'], [
    '试过不行，这个方案被否掉了。',
    '把端口改成 8080。',
  ])], { layered: true })
  assert.match(sectionOf(text, '## 关键决策与依据'), /\[排除\] 试过不行，这个方案被否掉了。/)
  // `改成` 单独出现是执行动作，不是"否掉了某个方案"。
  assert.doesNotMatch(text, /\[排除\] 把端口改成/)
})

test('失败类保留报错本体，并进「未决问题」', () => {
  const text = extractiveDigest([span(9, [], [
    '先试了一下。',
    "Error: ENOENT: no such file or directory, open 'D:\\x\\y.yml'",
  ])], { layered: true })
  assert.match(sectionOf(text, '## 未决问题'), /\[失败\] Error: ENOENT: no such file or directory/)
  // 报错行不该被当成"已完成的子任务"的结论行。
  assert.doesNotMatch(sectionOf(text, '## 已完成的子任务'), /ENOENT/)
})

test('推断链要求成对因果：单个「说明」不算', () => {
  assert.equal(classifyFragment('根因是宿主把 source.kind 当字符串拒绝。').kind, 'chain')
  assert.equal(classifyFragment('因为两处都写了同一条规则，所以第二处永远不生效。').kind, 'chain')
  assert.notEqual(classifyFragment('这里我说明一下刚才的做法。').kind, 'chain')
})

test('剥掉运行时注入块：时间戳/system-reminder/宿主检查点都不算本轮原文', () => {
  const injected = [
    'Time sampled while preparing turn 4, step 1: 2026-10-10T09:43:16+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.',
    '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n- `web-access`: 所有联网操作必须通过此 skill 处理。\n</system-reminder>',
    'This is an automatically generated checkpoint condensing an earlier span of the conversation.\n<compacted-summary>\n必须保留这一段历史约束。\n</compacted-summary>',
  ]
  const { fragments, strippedBlocks, strippedChars } = digestFragments([span(4, injected, ['真实结论。'])])
  assert.equal(strippedBlocks, 3, '三条注入消息必须整条被剥掉')
  assert.ok(strippedChars > 0)
  assert.ok(!fragments.some((f) => f.text.includes('web-access')), 'skill 目录不该进片段')
  assert.ok(!fragments.some((f) => f.text.includes('必须保留这一段历史约束')), '宿主检查点不该算本轮原文')
})

test('硬上限：装不下的片段计入 dropped，不做静默截断', () => {
  const many = Array.from({ length: 40 }, (_, i) => (
    `第 ${i} 条：必须遵守，不要把 profile 目录写进仓库，也不要把绝对路径写进测试夹具。`
  ))
  const { text, stats } = layeredDigest([span(1, many, many)])
  assert.ok(text.length <= LAYERED_DIGEST_MAX_CHARS, `实际 ${text.length} 字符`)
  assert.ok(stats.dropped.constraint > 0, `装不下的约束必须计入 dropped：${JSON.stringify(stats.dropped)}`)
  assert.equal(stats.kept.constraint + stats.dropped.constraint, 40, '候选 = 装入 + 丢弃')
})

test('maxChars 收紧后仍保持四小节结构', () => {
  const { text } = layeredDigest([span(1, ['必须做 A。'], ['结论是这个。'])], { maxChars: 260 })
  for (const head of SECTIONS) assert.ok(text.includes(head), `收紧后缺少小节 ${head}：${text}`)
  assert.ok(text.length <= 260, `实际 ${text.length}`)
})

test('确定性：同一输入两次输出逐字相同（去重与幂等的前提）', () => {
  const single = span(2, ['必须做 A。'], ['因为 A 依赖 B，所以先做 B。'])
  assert.equal(
    extractiveDigest([single], { layered: true }),
    extractiveDigest([single], { layered: true }),
  )
})

test('dedupeKey 只看 (session, kind, turnFrom, turnTo)：正文变长不影响分组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-layered-digest-'))
  const store = new DeepMemoryStore(dir, 'jsonl')
  await store.open()
  try {
    const single = span(12, ['必须做 A。'], ['因为 A 依赖 B，所以先做 B。'])
    const short = extractiveDigest([single])
    const long = extractiveDigest([single], { layered: true })
    assert.ok(long.length > short.length, '分层正文应该更长（否则这条测试什么都没证明）')
    store.put({ kind: 'turn', sessionId: 's-1', turnFrom: 12, turnTo: 12, text: short, refs: [] })
    store.put({ kind: 'turn', sessionId: 's-1', turnFrom: 12, turnTo: 12, text: long, refs: [] })
    const summary = store.duplicateSummary()
    assert.equal(summary.groups, 1, '同一轮的两份正文必须归到同一组')
    assert.equal(summary.records, 1)
    // 正文不一致要如实标出来（去重工具会提示"保留了最长的那条"）。
    assert.equal(summary.differingGroups, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
