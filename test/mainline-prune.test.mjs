/**
 * mainline-prune.test.mjs — 注入剪枝（低信息量条目）的判据与渲染。
 *
 * 这组测试钉的是**保守性**：宁可漏剪，不可误剪。每一条 keep 用例都是一次
 * "差点被一刀切删掉"的真实形状：
 * - `兼容性审计结果 — 未解决`：标题只是话题，`未解决` 是唯一的状态信息；
 * - `有遗忘部分和按需取回吗`：它是问句，但问的是具体机制，不是空话；
 * - `刚刚和你交流完了这一轮就出现了`：没有锚点、没有结论，但承载了一次现场描述。
 * 任何一条判据放宽（比如"问句就删""cause 模板就删"），这些用例都会先红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyMainline,
  hasConcreteAnchor,
  isPureChatter,
  isTemplateCause,
  pruneMainlineForInjection,
  renderMainline,
  renderPrunedMainline,
} from '../src/host/milestones.ts'
import { fitMainline } from '../src/host/budget.ts'
import { estimateTokens } from '../src/host/l1-working.ts'

/** 造一条里程碑（只填判据用得到的字段）。 */
function ms(turn, title, cause, turnTo) {
  const out = { turn, title, cause, detail: '', category: '事件', tokens: 0 }
  if (turnTo !== undefined) out.turnTo = turnTo
  return out
}

// ── 1. cause 判据 ─────────────────────────────────────────────────────────

test('isTemplateCause：模板标签集合，按标点切段后逐段判定', () => {
  for (const cause of ['原因不明', '根因不明', '用户追问', '未解决', '排查中，无结论', '仅对话，无代码变更', '稳定期，无新问题', '会话初始任务']) {
    assert.equal(isTemplateCause(cause), true, `"${cause}" 是模板标签`)
  }
  // 带对象/带结论的 cause 一律不是模板：删了会丢信息。
  for (const cause of ['未解决，方向变更（不要）', '验证通过', '网络中断', '同一上游错误连续复现', '后续测试通过', '改动致兼容问题']) {
    assert.equal(isTemplateCause(cause), false, `"${cause}" 不是模板标签`)
  }
})

// ── 2. 标题锚点 ───────────────────────────────────────────────────────────

test('hasConcreteAnchor：数字/ASCII/引号/结果词/领域词/时间指代都算锚点', () => {
  for (const title of [
    '部署完成 v0.1.22', 'a，0.1.5我已经装上了', '有了，可以处理l2思维链回退问题了',
    '你给的「三层记忆」在哪里', '移植完成，修复轮在跑', '上下文压缩 — 摘要 12426 字符',
    '继续，刚才你不生成了',
  ]) {
    assert.equal(hasConcreteAnchor(title), true, `"${title}" 应被认作有锚点`)
  }
  for (const title of ['兼容性审计结果', '状态确认（都是实测', '两份研究都在推进', '先做第一个']) {
    assert.equal(hasConcreteAnchor(title), false, `"${title}" 没有锚点`)
  }
})

test('isPureChatter：只认短、无锚点、无领域名词的纯问句/应答/指代', () => {
  for (const title of ['还有什么可以优化', '所有任务都完成了吗', '先做第一个', '可以，开始完成剩下的任务']) {
    assert.equal(isPureChatter(title), true, `"${title}" 是纯对话`)
  }
  // 反例（全部是"差点误删"的真实标题）。
  for (const title of [
    '有遗忘部分和按需取回吗',            // 问句，但问的是具体机制 → 领域词保护
    '为什么新会话又没有预设了，同时对话和思维栏中间的被删除了', // bug 报告
    '刚刚和你交流完了这一轮就出现了',      // 现场描述，不是寒暄
    '自更新成功 ✅',                      // 结果陈述
    '兼容性审计结果',                     // cause 才是状态
    '可以，你加油，预算无限',              // 寒暄的壳里包着一条授权：预算不设限
  ]) {
    assert.equal(isPureChatter(title), false, `"${title}" 不该被整条删掉`)
  }
})

// ── 3. 三档处置 ───────────────────────────────────────────────────────────

test('classifyMainline：cause 非模板 → keep；标题即结论 → strip；纯话 → drop', () => {
  assert.equal(classifyMainline(ms(1, '移植完成，修复轮在跑', '验证通过')), 'keep')
  assert.equal(classifyMainline(ms(2, '移植完成，修复轮在跑', '原因不明')), 'strip-cause')
  assert.equal(classifyMainline(ms(3, '还有什么可以优化', '仅对话，无代码变更')), 'drop')
  // 标题只是话题、cause 是唯一状态 → 不剪（判不准就留着）。
  assert.equal(classifyMainline(ms(4, '兼容性审计结果', '未解决')), 'keep')
  // 模板 cause + 有领域锚点的问句 → 只去 cause。
  assert.equal(classifyMainline(ms(5, '有遗忘部分和按需取回吗', '用户追问')), 'strip-cause')
})

test('pruneMainlineForInjection：三份清单互不重叠，行序与原骨架一致', () => {
  const list = [
    ms(1, '部署完成 v0.1.22', '验证通过'),
    ms(2, '兼容性审计结果', '未解决'),
    ms(3, '移植完成，修复轮在跑', '原因不明'),
    ms(4, '还有什么可以优化', '仅对话，无代码变更'),
    ms(5, '我创建之后你git上去，选项怎么选', '仅对话，无代码变更'),
  ]
  const result = pruneMainlineForInjection(list)
  assert.equal(result.lines.length, 4)
  assert.deepEqual(result.dropped.map((m) => m.turn), [4])
  assert.deepEqual(result.stripped.map((m) => m.turn), [3, 5])
  assert.deepEqual(result.lines.map((line) => line.milestone.turn), [1, 2, 3, 5])
  // 被去掉 cause 的行不能留下孤零零的 " — "。
  for (const line of result.lines) assert.doesNotMatch(line.text, /—\s*$/)
})

// ── 4. 注入渲染 ───────────────────────────────────────────────────────────

test('renderPrunedMainline：行号重排、块头与任务标题保留、空列表仍出块头', () => {
  const text = renderPrunedMainline(pruneMainlineForInjection([
    ms(10, '部署完成 v0.1.22', '验证通过'),
    ms(11, '移植完成，修复轮在跑', '原因不明'),
  ]).lines, '给 DSH 加三层记忆')
  assert.match(text, /^## 里程碑主线骨架（Milestone Mainline）/m)
  assert.match(text, /- 任务：给 DSH 加三层记忆/)
  assert.match(text, /^ {2}1\. 第 10 轮: 部署完成 v0\.1\.22 — 验证通过$/m)
  // 第二条：标题在，模板 cause 不在。
  assert.match(text, /^ {2}2\. 第 11 轮: 移植完成，修复轮在跑$/m)
  const empty = renderPrunedMainline([], '标题')
  assert.match(empty, /本会话尚无可提取的里程碑/)
})

// ── 5. 预算裁剪的顺序与计数 ───────────────────────────────────────────────

test('fitMainline：信息量剪枝先于上限裁剪，且三类计数分开报', () => {
  const list = [
    ms(1, '部署完成 v0.1.22', '验证通过'),
    ms(2, '还有什么可以优化', '仅对话，无代码变更'),
    ms(3, '移植完成，修复轮在跑', '原因不明'),
  ]
  const fit = fitMainline(list, '任务', 10_000, 60)
  assert.equal(fit.kept, 2, '纯对话条目被剪掉后只剩两条')
  assert.equal(fit.infoPruned, 1)
  assert.equal(fit.causeStripped, 1)
  assert.equal(fit.dropped, 0, '没有被上限丢掉的条目——两种"少一条"必须分开计')
  assert.equal(fit.trimmed, false)
  assert.ok(fit.prunedTokens > 0, '剪枝必须真的省下 token，否则就是白改名')
  assert.ok(fit.tokens < estimateTokens(renderMainline(list, '任务')), '注入文本必须比全量骨架短')
})

test('fitMainline：上限裁剪从最旧开始，剪枝不会让"最近 N 条"名额被空话占走', () => {
  const list = [
    ms(1, '部署完成 v0.1.22', '验证通过'),
    ms(2, '还有什么可以优化', '仅对话，无代码变更'),   // 空话：不该占名额
    ms(3, '移植完成，修复轮在跑', '原因不明'),
    ms(4, 'v0.1.25 已部署', '验证通过'),
  ]
  const fit = fitMainline(list, '任务', 10_000, 2)
  assert.equal(fit.kept, 2)
  assert.match(fit.text, /第 3 轮/)
  assert.match(fit.text, /第 4 轮/)
  assert.doesNotMatch(fit.text, /第 1 轮/)
  assert.equal(fit.dropped, 1, '第 1 轮是被条数上限挤掉的（不是被当空话删掉）')
  assert.equal(fit.infoPruned, 1)
  assert.equal(fit.trimmed, true)
})

test('fitMainline：全为空话时仍返回块头与任务标题（调用方不必判空）', () => {
  const fit = fitMainline([
    ms(1, '还有什么可以优化', '仅对话，无代码变更'),
    ms(2, '所有任务都完成了吗', '用户追问'),
  ], '任务标题', 1_000, 60)
  assert.equal(fit.kept, 0)
  assert.equal(fit.infoPruned, 2)
  assert.match(fit.text, /## 里程碑主线骨架/)
  assert.match(fit.text, /- 任务：任务标题/)
  assert.match(fit.text, /本会话尚无可提取的里程碑/)
})
