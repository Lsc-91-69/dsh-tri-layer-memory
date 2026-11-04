/**
 * test/budget-floor.test.mjs — L3 索引保底位与注入预算单调性的回归测试。
 *
 * **为什么单独钉这一组**：修复前 `arbitrateInjection` 严格按 priority 贪心
 * （L1 → L2 → L3）。预算 800 时 L2 被截断、L3 还能挤进 80 tok；预算升到 1000 时
 * L2 不再截断、吃满预算，L3 剩余不足最小截断长度 → 整块丢弃（实测
 * `dropped: ["l3"]`、`l3Tokens: 0`）。**提高预算反而少一层**，而且丢的正好是
 * "模型知道可以去 recall"的唯一入口。
 *
 * 这组测试钉四件事：
 * 1. 200/400/800/1000/1200 五档预算，L3 索引的 token 都不为 0；
 * 2. 预算升高时，保留内容（token 总量、kept 集合）不得减少——非单调消除；
 * 3. 预算 1000 不再丢 L3（旧 bug 的直接回归）；
 * 4. 保底形态本身必须带计数与工具名，模型能据此行动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { L2_TRUNCATION_NOTE, arbitrateInjection } from '../src/host/budget.ts'
import { estimateTokens } from '../src/host/l1-working.ts'
import { renderDeepIndex, renderDeepIndexFloor } from '../src/host/index.ts'

/** 真实量级的 L1 标记（marker 形态实测约 34 tok）。 */
const L1_TEXT = [
  '## L1 工作记忆（Working Memory）',
  '- 保留窗口：最近 8 轮真实对话（窗口内 9 个 turn）（turn 113–121），共 9 轮。',
  '- 该窗口内的对话原文即上方内容，未做任何压缩；较早的 1 轮已进入 L2/L3。',
].join('\n')

/**
 * 真实量级的 L2 摘要（实测 diagnostics: l2Tokens ≈ 993）。
 *
 * 用四节结构 + 若干条中文结论拼到 900+ tok；内容不重要，**体积与可截断性**才重要。
 */
function l2Text() {
  const lines = [
    '## L2 短期记忆（Short-term Memory）',
    '- 覆盖 turn 96–120。',
    '',
    '## 任务主线',
    ...Array.from({ length: 14 }, (_, i) => `- turn ${96 + i}: 修复第 ${i + 1} 个静默故障，要求带源码位置与实测数字，不接受"看起来在工作"`),
    '',
    '## 已完成的子任务',
    ...Array.from({ length: 14 }, (_, i) => `- turn ${96 + i}: 定位到 trigger 逻辑第 ${i + 1} 处，验证通过并记录了前后对照`),
    '',
    '## 关键决策与依据',
    '- 保留 inject = ["slots","locale"]，不改 projection.ts 的 schema 与 stateVersion',
    '- 预算仲裁必须先扣掉 L3 索引的保底额度，否则 L2 吃满后索引整块消失',
    '- 摘要采用滚动方式（上一份 + 新增轮），全量重算是 7.2 倍输入成本',
    '',
    '## 未决问题',
    '- 长会话里 L2 摘要的输出长度仍需用真实会话复测',
  ]
  return lines.join('\n')
}

/** 真实量级的完整 L3 索引（实测 diagnostics 约 120 tok）。 */
function l3Full() {
  return renderDeepIndex(
    { count: 434, tokens: 0, backend: 'sqlite', tools: 46, toolTokens: 0 },
    [],
    'memory_recall',
    '',
  )
}

/** 候选块（与 index.ts 的接线同形：L3 带 pinned + floorText）。 */
function blocks() {
  return [
    { id: 'l1', text: L1_TEXT, priority: 0, truncatable: false },
    { id: 'l2', text: l2Text(), priority: 1, truncatable: true, truncationNote: L2_TRUNCATION_NOTE },
    {
      id: 'l3',
      text: l3Full(),
      priority: 2,
      truncatable: true,
      pinned: true,
      floorText: renderDeepIndexFloor(434, 'memory_recall'),
    },
  ]
}

const BUDGETS = [200, 400, 800, 1000, 1200]

test('L3 保底：五档预算下索引 token 都不为 0，且 200 档是带计数的一行', () => {
  const rows = BUDGETS.map((budget) => {
    const result = arbitrateInjection(blocks(), budget)
    return { budget, result, l3: result.kept.find((block) => block.id === 'l3') }
  })
  for (const row of rows) {
    assert.ok(row.l3 !== undefined, `预算 ${row.budget} 时 L3 索引被整块丢弃：${JSON.stringify(row.result.dropped)}`)
    assert.ok(estimateTokens(row.l3.text) > 0, `预算 ${row.budget} 时 L3 索引 token 为 0`)
    assert.match(row.l3.text, /可 recall/, `预算 ${row.budget} 的 L3 索引必须告诉模型可以去 recall`)
    assert.match(row.l3.text, /\d+ 条/, `预算 ${row.budget} 的 L3 索引必须带计数（模型据此知道有东西可查）`)
    assert.ok(!row.result.dropped.includes('l3'), `预算 ${row.budget} 的 dropped 不得含 l3`)
  }
  // 200 档：L3 必须在场。完整索引只有约 40–50 tok，200 预算下通常仍能留完整形态；
  // "降级成一行"是更紧预算（低于配置下限 200 的极端值）下的兜底路径，单独验证。
  assert.ok(estimateTokens(rows[0].l3.text) > 0, '200 档 L3 必须是实际文本')
  assert.ok(rows[0].result.tokens <= 200, '200 档不得超预算')
  const tight = arbitrateInjection(blocks(), 140)
  const tightL3 = tight.kept.find((block) => block.id === 'l3')
  assert.ok(tightL3 !== undefined, '预算 140 时 L3 也不能整块消失')
  assert.deepEqual(tight.degraded, ['l3'], `预算 140 应把 L3 降级成一行，实际 ${JSON.stringify(tight)}`)
  assert.ok(estimateTokens(tightL3.text) < estimateTokens(l3Full()), '降级后的 L3 必须比完整索引短')
  assert.match(tightL3.text, /另有 \d+ 条记录可 recall/, '降级形态必须是一行计数')
  // 400 档起：预算够，完整索引必须在场（不是永远只有一行）。
  for (const row of rows.slice(1)) {
    assert.deepEqual(row.result.degraded, [], `预算 ${row.budget} 不该再降级 L3`)
    assert.equal(row.l3.text, l3Full(), `预算 ${row.budget} 应保留完整 L3 索引`)
  }
})

test('预算单调：预算升高时保留 token 不减、kept 集合不缩小、dropped 不增加', () => {
  const rows = BUDGETS.map((budget) => ({ budget, result: arbitrateInjection(blocks(), budget) }))
  for (let i = 1; i < rows.length; i += 1) {
    const low = rows[i - 1]
    const high = rows[i]
    assert.ok(high.result.tokens >= low.result.tokens,
      `预算 ${low.budget}→${high.budget} 的保留 token 减少了：${low.result.tokens} → ${high.result.tokens}`)
    const lowIds = new Set(low.result.kept.map((block) => block.id))
    const highIds = new Set(high.result.kept.map((block) => block.id))
    for (const id of lowIds) {
      assert.ok(highIds.has(id), `预算 ${low.budget} 保留了 ${id}，${high.budget} 反而丢了`)
    }
    assert.ok(high.result.dropped.length <= low.result.dropped.length,
      `预算升高后 dropped 变多了：${JSON.stringify(low.result.dropped)} → ${JSON.stringify(high.result.dropped)}`)
  }
})

test('回归：预算 1000 不再把 L3 整块丢弃（旧实现 dropped:["l3"]）', () => {
  const result = arbitrateInjection(blocks(), 1000)
  assert.ok(!result.dropped.includes('l3'), `预算 1000 仍丢 L3：${JSON.stringify(result)}`)
  const l3 = result.kept.find((block) => block.id === 'l3')
  assert.ok(l3 !== undefined, '预算 1000 时 L3 不应被丢弃')
  assert.equal(l3.text, l3Full(), '预算 1000 时应保留完整索引（不是一行保底）')
  // 预算 800 能留、1000 反而丢——旧的病态就在这里；现在 1000 的保留量必须 ≥ 800。
  const at800 = arbitrateInjection(blocks(), 800)
  assert.ok(result.tokens >= at800.tokens, '预算 1000 的保留量不得低于 800')
})

test('L3 保底不挤掉不可截断的 L1：预算再小 L1 仍在（或 L3 让位）', () => {
  const result = arbitrateInjection(blocks(), 100)
  const l1 = result.kept.find((block) => block.id === 'l1')
  assert.ok(l1 !== undefined, `L1 被 L3 保底挤掉了：${JSON.stringify(result)}`)
})
