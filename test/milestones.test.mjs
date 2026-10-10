/**
 * test/milestones.test.mjs — 主线骨架提取器的行为测试。
 *
 * 直接 import `src/host/milestones.ts`（Node 22.18+/23.6+ 原生类型剥离），
 * 不需要构建、不需要安装任何依赖。
 *
 * ⚠ 事件形状必须与真实 DSH 会话日志一致：`user/message` 的正文在 `data.content`，
 * `assistant/message` 与 `tool/result` 在 `data.message.content`，工具名要经
 * `toolCallId` 回查 `tool/call`。上一轮就是因为 fixture 用了简化形状，一个
 * 「L1 只数到用户文本」的 bug 溜过了 51 个测试——所以这里宁可啰嗦也要造真形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractMilestones, renderMainline } from '../src/host/milestones.ts'

/**
 * 造一份真实形状的事件流。
 *
 * 每个方法都对应真实日志里的一个事件形态；刻意不提供"直接塞字符串"的快捷方式，
 * 因为被测试的正是"从哪个字段读正文"。
 */
function makeLog() {
  const events = []
  let seq = 0
  const push = (type, data) => { events.push({ type, seq: seq++, data }) }

  const api = {
    events,
    /** 会话第一条任务：只在这里，且早于 turn/start（正文在 data.inserted[].content）。 */
    inboxTask(text) {
      push('agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'r1' }, role: 'user', id: 'm1' }],
      })
      return api
    },
    turnStart(turn) { push('turn/start', { turn }); return api },
    /** user/message 的正文位置：data.content。 */
    user(text) {
      push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' } })
      return api
    },
    /** assistant/message 的正文位置：data.message.content。 */
    assistant(text) {
      push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })
      return api
    },
    /** 一次工具调用；返回 callId，供 result 配对。 */
    call(name, args) {
      const callId = `call-${seq}`
      push('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args ?? {}) })
      return callId
    },
    /** tool/result 的正文位置：data.message.content（自己不带工具名）。 */
    result(callId, text, isError = false) {
      push('tool/result', {
        turn: 1,
        step: 1,
        message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError, id: `r-${seq}` },
      })
      return api
    },
    tool(name, args, text, isError = false) { return api.result(api.call(name, args), text, isError) },
    /** 上下文压缩：摘要正文在 data.summary（content 块数组），不在 message.content。 */
    compaction(summaryText, shadowedTokenCount) {
      push('compaction/start', { compactionId: 'c1' })
      push('compaction/summary', {
        compactionId: 'c1',
        summary: [{ type: 'text', text: summaryText }],
        shadowedTokenCount,
      })
      return api
    },
    /** goal/change：操作在 data.operation，目标正文在 data.goal.objective（clear 时为空）。 */
    goal(operation, objective = '') {
      push('goal/change', {
        kind: 'goal/change',
        version: 1,
        operation,
        goal: { id: 'goal-1', revision: 1, objective, phase: 'active', maxGoalRounds: 12 },
      })
      return api
    },
    turnEnd(turn, reason = { kind: 'completed' }) { push('turn/end', { turn, reason }); return api },
  }
  return api
}

const titles = (ms) => ms.map((m) => m.title)

/**
 * 去掉"会话初始任务"那条。
 *
 * 规则如此：**会话第一条用户消息就是初始任务**（`agent/inbox/spliced` 里有更早的副本
 * 就优先用它），标题由这条「任务」条目承担——逐轮条目里会跳过这条消息，不再复述一遍。
 * 关心"这一轮发生了什么"的断言先把它滤掉。
 */
const turnItems = (ms) => ms.filter((m) => m.category !== '任务')

// ── 收紧①：同轮同问题类的失败合并 ────────────────────────────────────────

test('extractMilestones：同轮同问题类的失败合并成一条（3 次锁超时 → 1 条）', () => {
  const log = makeLog()
  log.turnStart(1)
  for (let i = 0; i < 3; i += 1) {
    log.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock at C:\\Users\\admin\\.dsh\\profiles\\web\\package.json.lock [exit code: 1]')
  }
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  // 153 次工具失败若不合并，会占掉骨架 40% 的篇幅——这是收紧的第一条规则。
  assert.equal(ms.length, 1, '同一问题类的 3 次尝试必须合并成 1 条')
  assert.equal(ms[0].title, 'profile 写入锁超时（3 次尝试）')
  assert.equal(ms[0].category, '失败')
  assert.equal(ms[0].cause, '未解决')
})

test('extractMilestones：同轮第二个 ≥2 次的阻塞簇补一条（断言类"验证发现问题"单独记）', () => {
  const log = makeLog()
  log.turnStart(1)
  for (let i = 0; i < 3; i += 1) {
    log.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock [exit code: 1]')
  }
  for (let i = 0; i < 2; i += 1) {
    log.tool('pwsh', { description: 'Run layer tests' }, 'FAIL 仍只用 CSS 逻辑像素适配 [exit code: 1]')
  }
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  // 这条规则是审计逼出来的：它救回了 profile 写入锁超时 ×3、sapi 孤儿进程 ×2、
  // 以及第 20/52 轮的断言失败簇（"验证发现问题"与"失败"不同类，必须单独可见）。
  assert.equal(ms.length, 2, '第二个 ≥2 次的阻塞簇必须补一条')
  assert.equal(ms[0].title, 'profile 写入锁超时（3 次尝试）')
  assert.match(ms[1].title, /测试断言失败：仍只用 CSS 逻辑像素适配/)
  assert.match(ms[1].title, /（2 次尝试）/)
  assert.equal(ms[1].cause, '未解决')
})

test('extractMilestones：label 自带计数时不再补「N 次尝试」（计数只出现一次）', () => {
  const log = makeLog()
  log.turnStart(1)
  // 锁超时 3 次 → 主簇；断言失败 2 次且抽不到断言名 → label 自己就带「（2 次）」。
  for (let i = 0; i < 3; i += 1) {
    log.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock [exit code: 1]')
  }
  for (let i = 0; i < 2; i += 1) {
    log.tool('pwsh', { description: 'Run layer tests' }, '[exit code: 1] FAIL')
  }
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 2)
  assert.equal(ms[0].title, 'profile 写入锁超时（3 次尝试）')
  // 补条目曾经再补一次后缀，标题成了「测试断言失败（2 次）（2 次尝试）」——同一个计数出现两次。
  assert.equal(ms[1].title, '测试断言失败（2 次）')
  assert.doesNotMatch(ms[1].title, /（2 次）（2 次尝试）/)
})

// ── 收紧②：严重度分级 ───────────────────────────────────────────────────

test('extractMilestones：proto 协议噪声永不进骨架', () => {
  const log = makeLog()
  log.turnStart(1)
  log.tool('edit', { file_path: 'src/host/index.ts' }, 'Error: cannot modify "src/host/index.ts": file has not been read — read the file, then retry', true)
  log.tool('edit', { file_path: 'src/host/index.ts' }, 'old_string was not found in the file', true)
  log.turnEnd(1)
  assert.deepEqual(extractMilestones(log.events), [], '未读先改这类协议错误模型下一次调用就能纠正，不构成任务状态变动')

  // 与真失败同轮时，proto 不参与计数："1 次"不能变成"3 次"。
  const log2 = makeLog()
  log2.turnStart(1)
  log2.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock [exit code: 1]')
  log2.tool('edit', { file_path: 'a.ts' }, 'file has not been read — read the file, then retry', true)
  log2.tool('edit', { file_path: 'a.ts' }, 'old_string was not found', true)
  log2.turnEnd(1)
  const ms = extractMilestones(log2.events)
  assert.equal(ms.length, 1)
  assert.equal(ms[0].title, 'profile 写入锁超时')
})

test('extractMilestones：瞬时失败（parser/depmiss/timeout）折叠进相邻条目，不单独成条', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('继续修复插件的缩放问题')
  log.tool('pwsh', { description: 'Run build script' }, 'ParserError: Unexpected token } [exit code: 1]')
  log.tool('pwsh', { description: 'Install bundle' }, 'Cannot find module "esbuild" [exit code: 1]')
  log.tool('pwsh', { description: 'Wait for build' }, 'command timed out after 240s')
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  const [main] = turnItems(ms)
  assert.equal(turnItems(ms).length, 1, '三条瞬时失败不得各自成条')
  // 第一条用户消息的标题归「任务」条目（逐轮条目不重复记它），逐轮条目只剩失败态。
  assert.equal(ms[0].title, '继续修复插件的缩放问题')
  assert.equal(main.title, '脚本解析错误')
  assert.equal(main.cause, '未解决', '瞬时失败仍让这一轮"有失败"，只是不占独立条目')
  for (const title of titles(turnItems(ms))) {
    assert.doesNotMatch(title, /ParserError|Cannot find module|timed out/, '瞬时失败的原文只该出现在 detail/审计里')
  }
})

// ── 真实日志形状：退出码与后台任务 ───────────────────────────────────────

test('extractMilestones：两种退出码写法都识别（pwsh 与后台任务）', () => {
  const pwsh = makeLog()
  pwsh.turnStart(1)
  pwsh.tool('pwsh', {}, "ModuleNotFoundError: No module named 'librosa' [exit code: 1]")
  pwsh.turnEnd(1)
  const a = extractMilestones(pwsh.events)
  assert.equal(a.length, 1)
  assert.match(a[0].title, /缺 Python 依赖：librosa/)

  const job = makeLog()
  job.turnStart(1)
  job.tool('job_output', { job_id: 'pwsh-94' }, "ModuleNotFoundError: No module named 'torchcrepe' [status: completed, exit code: 1]")
  job.turnEnd(1)
  const b = extractMilestones(job.events)
  // 只认 pwsh 的 `[exit code: 1]` 会整类漏检（ERR_PNPM_IGNORED_BUILDS 就是这么漏的）。
  assert.equal(b.length, 1, '`[status: completed, exit code: 1]` 必须与 `[exit code: 1]` 等价')
  assert.match(b[0].title, /缺 Python 依赖：torchcrepe/)
})

test('extractMilestones：退出码 0 不算失败（后台任务正常收尾）', () => {
  const log = makeLog()
  log.turnStart(1)
  log.tool('job_output', { job_id: 'pwsh-7' }, 'all good [status: completed, exit code: 0]')
  log.turnEnd(1)
  assert.deepEqual(extractMilestones(log.events), [])
})

test('extractMilestones：后台任务的失败经 job_output 回来，不能被漏掉', () => {
  const log = makeLog()
  log.turnStart(1)
  // 原工具只是把任务丢到后台，它的结果本身是成功的。
  log.tool('pwsh', { description: 'Install bundle in background', command: 'pnpm install' }, 'started job pwsh-94')
  // 真正的失败在 job_output 的返回值里，toolCallId 指向 job_output 而不是 pwsh。
  log.tool('job_output', { job_id: 'pwsh-94' }, 'Error: ERR_PNPM_IGNORED_BUILDS Ignored build scripts [status: completed, exit code: 1]')
  // 还在跑的后台任务不是失败。
  log.tool('job_output', { job_id: 'pwsh-95' }, '(no new output) [status: running]')
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  assert.match(ms[0].title, /ERR_PNPM_IGNORED_BUILDS/)
  assert.equal(ms[0].category, '失败')
})

// ── 真实日志形状：正文位置 ──────────────────────────────────────────────

test('extractMilestones：正文两种位置都读到（真实日志形状回归）', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('修复桌宠透明窗口')                       // 正文在 data.content
  log.assistant('我来看看 TransparencyKey 的命中问题。')
  log.tool('pwsh', { description: 'Run smoke test' }, 'Traceback (most recent call last): ... [exit code: 1]') // 正文在 data.message.content
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  const [main] = turnItems(ms)
  assert.equal(turnItems(ms).length, 1)
  // 标题来自 data.content：读错位置会退化成空标题。第一条用户消息由「任务」条目承担标题，
  // 逐轮条目不再复述它，改由这一轮的失败簇承担。
  assert.equal(ms[0].title, '修复桌宠透明窗口')
  assert.equal(ms[0].detail, '修复桌宠透明窗口')
  assert.equal(main.title, 'Traceback (most recent call…')
  // 工具结果来自 data.message.content：只读 data.content 的话这里读空，
  // 失败消失、原因会退化成"仅对话，无代码变更"。
  assert.equal(main.cause, '未解决')
})

test('extractMilestones：压缩里程碑的规模来自 data.summary（不在 message.content）', () => {
  const log = makeLog()
  const summaryText = '## 任务主线\n- 建插件'
  log.turnStart(1)
  log.compaction(summaryText, 597986)
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  assert.equal(ms[0].category, '压缩')
  // 第一轮这里读成 0 字符，压缩里程碑因此丢掉了全部规模信息。
  assert.match(ms[0].title, new RegExp(`摘要 ${summaryText.length} 字符，遮蔽 597986 tokens`))
  assert.equal(ms[0].cause, '窗口压力触发')
})

// ── 标题与 detail ──────────────────────────────────────────────────────

test('extractMilestones：标题 ≤40 字符，超长用户原话概括后全文进 detail', () => {
  const long = '在身体有一个位置转向另一个位置的时候黄过去的时候是直接可以说是闪过去，'
    + '而且待机的时候眼睛要可以到处看，另外表情也要能切换，不要一直不换'
  const log = makeLog()
  log.turnStart(1)
  log.user(long)
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  // 这一轮只有第一条用户消息：标题由「任务」条目承担，逐轮条目不重复记一遍。
  assert.equal(ms.length, 1)
  const [main] = ms
  assert.equal(main.category, '任务')
  assert.ok(long.length > 40, 'fixture 本身要超长')
  assert.ok(main.title.length <= 40, `标题必须 ≤40，实际 ${main.title.length}`)
  assert.ok(main.title.length < long.length, '超长原话必须被概括，而不是整段搬进标题')
  assert.equal(main.detail, long, '用户原话全文进 detail（进 L3，不进骨架）')
})

test('extractMilestones：骨架形态自检（标题 ≤40、按时间排序、token 与行一致）', () => {
  const log = makeLog()
  log.inboxTask('给插件加三层记忆，并在每轮注入')
  log.turnStart(1)
  log.user('修复插件在某些特定的缩放时，会出现异常过大的问题')
  log.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock [exit code: 1]')
  log.turnEnd(1)
  log.turnStart(2)
  log.user('还是无法拖动，我的要求是鼠标放在你身上按下时可以拖动')
  log.tool('pwsh', { description: 'Run drag tests' }, 'FAIL 待机轻晃单帧位移很小（< 0.3°） [exit code: 1]')
  log.turnEnd(2)

  const ms = extractMilestones(log.events)
  assert.ok(ms.length >= 3)
  for (const m of ms) {
    assert.ok(m.title.length <= 40, `标题超限：${m.title}（${m.title.length}）`)
    assert.ok(m.tokens > 0, '每条都要带 token 数，供 L3 预算用')
    assert.ok(m.category.length > 0)
  }
  assert.equal(ms[0].category, '任务', '会话初始任务永远排在最前')
  const turns = ms.map((m) => m.turn)
  assert.deepEqual(turns, [...turns].sort((a, b) => a - b), '骨架必须按轮次先后排列')
})

// ── 收紧⑤：跨轮合并 ───────────────────────────────────────────────────

test('extractMilestones：跨轮同因阻塞合并成一条，带 turnTo', () => {
  const log = makeLog()
  for (const turn of [2, 3, 4]) {
    log.turnStart(turn)
    log.tool('pwsh', { description: 'Retry with opencode-go' }, 'Missing x-opencode-session header [exit code: 1]')
    log.turnEnd(turn)
  }

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1, '连续 3 轮同一个阻塞问题应合并成 1 条')
  assert.equal(ms[0].turn, 2)
  assert.equal(ms[0].turnTo, 4)
  assert.match(ms[0].title, /缺 x-opencode-session 路由头，3 轮未解决/)
  assert.equal(ms[0].cause, '3 次尝试未过')
  assert.equal(ms[0].category, '失败')
})

// ── 收紧③：验证不单独成条 ─────────────────────────────────────────────

test('extractMilestones：验证通过不单独成条，只作"修复并验证通过"的原因从句', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('审批相关的问题还没解决')   // 第一条用户消息：标题归「任务」条目
  log.user('审批的时候还是思考中')
  log.tool('pwsh', { description: 'Run layer tests' }, 'FAIL 审批挂起时状态是 waiting [exit code: 1]')
  log.tool('pwsh', { description: 'Run layer tests' }, `ok 1\nok 2\nok 3\n${'通过'.repeat(20)}`)

  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(turnItems(ms).length, 1, '实测 69 条验证候选 → 0 条独立条目')
  assert.equal(ms[1].title, '审批的时候还是思考中')
  assert.equal(ms[1].cause, '修复并验证通过')
  assert.equal(ms[1].category, '回退', '"还是"是回退信号——骨架最值钱的一类')
})

// ── 真实日志形状：toolCallId 回查 ──────────────────────────────────────

test('extractMilestones：工具名与自述用途经 toolCallId 回查 tool/call', () => {
  const log = makeLog()
  log.turnStart(1)
  // tool/result 自己不带工具名：名字与 description 都在对应的 tool/call 上。
  const callId = log.call('pwsh', { description: 'Run layer tests' })
  log.result(callId, `ok 1\nok 2\n${'通过'.repeat(20)}`)
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  assert.equal(ms[0].title, 'Run layer tests')
  assert.equal(ms[0].cause, '验证通过（2 断言）')
  assert.equal(ms[0].category, '验证')
})

test('extractMilestones：会话初始任务从 agent/inbox/spliced 取（它早于 turn/start）', () => {
  const log = makeLog()
  // 53 条投递项里 52 条能在 user/message 找到同文，但会话第一条任务只在这里。
  log.inboxTask('给插件加一个语音播报，说话的时候要有音频')
  log.turnStart(1)
  log.tool('pwsh', { description: 'Check audio deps' }, "ModuleNotFoundError: No module named 'pysapi' [exit code: 1]")
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms[0].category, '任务')
  assert.equal(ms[0].title, '给插件加一个语音播报，说话的时候要有音频')
  assert.equal(ms[0].cause, '会话初始任务')
  assert.equal(ms[0].detail, '给插件加一个语音播报，说话的时候要有音频')

  // 没有投递事件时退回第一条 user/message。
  const log2 = makeLog()
  log2.turnStart(1)
  log2.user('把网页版也一起改掉')
  log2.turnEnd(1)
  const ms2 = extractMilestones(log2.events)
  assert.equal(ms2[0].category, '任务')
  assert.equal(ms2[0].title, '把网页版也一起改掉')
})

// ── 目标操作与首轮去重 ────────────────────────────────────────────────

test('extractMilestones：goal/change 只有 complete 才是"目标达成"', () => {
  const log = makeLog()
  log.turnStart(1)
  log.goal('create', '给插件搭一条语音流水线')
  log.goal('pause', '给插件搭一条语音流水线')
  log.goal('resume', '给插件搭一条语音流水线')
  log.goal('edit', '给插件搭一条语音流水线')
  log.turnEnd(1)
  log.turnStart(2)
  log.goal('complete', '给插件搭一条语音流水线')
  log.goal('clear', '')
  log.turnEnd(2)

  const ms = extractMilestones(log.events)
  // pause/edit/resume 一律写成"目标达成，自主运行结束"会让骨架自相矛盾（实测 9 条）。
  assert.deepEqual(ms.map((m) => m.cause), [
    '长任务转目标制，自动续跑',
    '目标被暂停（用户或系统）',
    '目标被恢复，继续自动续跑',
    '目标被改写',
    '目标达成，自主运行结束',
    '目标被清除，退出目标制',
  ])
  assert.deepEqual(titles(ms).slice(0, 5), [
    '建立目标：给插件搭一条语音流水线',
    '目标暂停：给插件搭一条语音流水线',
    '目标恢复：给插件搭一条语音流水线',
    '目标修订：给插件搭一条语音流水线',
    '目标完成：给插件搭一条语音流水线',
  ])
  // clear 没有 objective：标题不能留「目标 clear：」这种半截话。
  assert.equal(ms[5].title, '目标清除')
  assert.doesNotMatch(ms[5].title, /：$/)
  assert.equal(ms[5].category, '目标')
})

test('extractMilestones：第 1 轮不出现两行同题（第一条用户消息归「任务」条目）', () => {
  const log = makeLog()
  log.inboxTask('修复插件的缩放问题')
  log.turnStart(1)
  log.user('修复插件的缩放问题')   // 同一条消息在 user/message 里的副本
  log.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock [exit code: 1]')
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 2, '「任务」条目 + 这一轮真正发生了什么')
  assert.equal(ms[0].category, '任务')
  assert.equal(ms[0].title, '修复插件的缩放问题')
  // 逐轮条目改由失败簇承担标题，不再复述指令。
  assert.equal(ms[1].title, 'profile 写入锁超时')
  assert.equal(ms.filter((m) => m.title === '修复插件的缩放问题').length, 1, '第 1 轮不得出现两行同题')

  // 首句是无信息量的「继续」时不进 users：跳过的是**第一条 user/message 事件**，
  // 不是"第一条被记下的消息"——认错的话，真指令会整条从骨架里消失。
  const log2 = makeLog()
  log2.turnStart(1)
  log2.user('继续')
  log2.user('把网页版也一起改掉')
  log2.turnEnd(1)
  const ms2 = extractMilestones(log2.events)
  assert.equal(ms2.length, 2)
  assert.equal(ms2[1].title, '把网页版也一起改掉')
})

// ── 健壮性 ────────────────────────────────────────────────────────────

test('extractMilestones：异常输入不抛错（空流 / 未配对 callId / 非法 JSON 参数）', () => {
  assert.deepEqual(extractMilestones([]), [])

  const log = makeLog()
  log.turnStart(1)
  log.result('call-does-not-exist', 'boom [exit code: 1]')
  log.events.push({ type: 'tool/call', seq: 900, data: { callId: 'c9', name: 'pwsh', arguments: '{"description":' } })
  log.result('c9', 'ok 1\nok 2\n通过', false)
  log.turnEnd(1)

  let ms
  assert.doesNotThrow(() => { ms = extractMilestones(log.events) })
  assert.equal(ms.length, 1, '未配对的 callId 退化成"没有自述用途"，不丢失败')
  assert.match(ms[0].title, /boom/)
})

// ── 渲染 ──────────────────────────────────────────────────────────────

test('renderMainline：编号、轮次区间与任务标题；空输入不产出空块', () => {
  const ms = [
    { turn: 1, title: '写一个插件', cause: '会话初始任务', detail: '', category: '任务', tokens: 8 },
    { turn: 2, turnTo: 4, title: '缺路由头，3 轮未解决', cause: '3 次尝试未过', detail: '', category: '失败', tokens: 12 },
  ]
  const text = renderMainline(ms, '给 DSH 加三层记忆')
  assert.match(text, /^## 里程碑主线骨架/)
  assert.match(text, /- 任务：给 DSH 加三层记忆/)
  assert.match(text, / {2}1\. 第 1 轮: 写一个插件 — 会话初始任务/)
  assert.match(text, / {2}2\. 第 2–4 轮: 缺路由头，3 轮未解决 — 3 次尝试未过/)

  const empty = renderMainline([])
  assert.match(empty, /尚无可提取的里程碑/)
  assert.doesNotMatch(empty, /\n\s+1\./, '空输入不能渲染出编号行')

  // 端到端：extractMilestones → renderMainline 的行数 = 条数 + 块头。
  const log = makeLog()
  log.turnStart(1)
  log.tool('pwsh', {}, 'atomic-write: timed out waiting for the writer lock [exit code: 1]')
  log.turnEnd(1)
  const extracted = extractMilestones(log.events)
  const rendered = renderMainline(extracted).split('\n')
  assert.equal(rendered.length, extracted.length + 1)
  assert.match(rendered[1], /第 1 轮: profile 写入锁超时 — 未解决/)
})

// ── 缺口①：目标生命周期震荡（pause/resume/edit 是同一个事件，不是 N 个）──────────

const OBJ = '构建 DSH 插件「三层记忆压缩引擎」'

test('extractMilestones：目标震荡合并（同轮同类折叠 + 跨轮序列并成一条）', () => {
  const log = makeLog()
  log.turnStart(1)
  log.goal('create', OBJ)
  log.turnEnd(1)
  // 第 2 轮两次 edit 是同一个事件被记两遍（幂等重放），折叠成 1 次——不是"改了两次目标"。
  log.turnStart(2)
  log.goal('edit', OBJ)
  log.goal('edit', OBJ)
  log.turnEnd(2)
  // 第 3 轮发生上下文压缩：这一段已经翻篇，前后的震荡不许粘成一条。
  log.turnStart(3)
  log.compaction('## 摘要', 1000)
  log.turnEnd(3)
  // 第 4–7 轮：同一个目标的反复中断又续跑（第 5 轮两次 resume 再折叠一次）。
  log.turnStart(4)
  log.goal('pause', OBJ)
  log.turnEnd(4)
  log.turnStart(5)
  log.goal('resume', OBJ)
  log.goal('resume', OBJ)
  log.turnEnd(5)
  log.turnStart(6)
  log.goal('pause', OBJ)
  log.turnEnd(6)
  log.turnStart(7)
  log.goal('resume', OBJ)
  log.turnEnd(7)
  log.turnStart(8)
  log.goal('complete', OBJ)
  log.turnEnd(8)

  const goals = extractMilestones(log.events).filter((m) => m.category === '目标')
  // 8 条目标事件 → 4 条：建立 / 修订 / 一段震荡 / 完成。进出目标制各自成条。
  assert.equal(goals.length, 4, `目标条目应并成 4 条，实际：${goals.map((m) => m.title).join(' | ')}`)
  assert.equal(goals[0].title, `建立目标：${OBJ}`)
  assert.equal(goals[1].title, `目标修订：${OBJ}`, '同轮同类必须先折叠：两次 edit 只算 1 次')
  assert.equal(goals[2].title, '目标反复暂停/恢复 4 次', '次数 = 折叠后的操作次数（不是状态翻转次数）')
  assert.equal(goals[2].turn, 4)
  assert.equal(goals[2].turnTo, 7)
  assert.equal(goals[2].cause, '任务多次中断后续跑')
  assert.equal(goals[3].title, `目标完成：${OBJ}`)
  // 合并不得吃掉信息量：原始 objective 与每一次操作（含被折叠的那次）都要留在 detail。
  assert.match(goals[2].detail, new RegExp(OBJ))
  assert.equal((goals[2].detail.match(/resume/g) ?? []).length, 3, '第 5 轮的两次 resume 在 detail 里都要留着')
  // 计数是折叠后的（4 次），detail 保留的是原始事件（5 条，含被折叠的那次重复）。
  assert.equal((goals[2].detail.match(/第 \d+ 轮/g) ?? []).length, 5, 'detail 要能还原出被合并的每一次操作')
})

test('extractMilestones：震荡被 create/complete/clear 打断时另起一条', () => {
  const log = makeLog()
  log.turnStart(1)
  log.goal('pause', OBJ)
  log.turnEnd(1)
  log.turnStart(2)
  log.goal('resume', OBJ)
  log.turnEnd(2)
  log.turnStart(3)
  log.goal('clear', '')
  log.turnEnd(3)
  log.turnStart(4)
  log.goal('pause', OBJ)
  log.turnEnd(4)

  const goals = extractMilestones(log.events).filter((m) => m.category === '目标')
  // clear 是目标制的出口：它前后的 pause/resume 属于两段不同的生命周期。
  assert.deepEqual(goals.map((m) => m.title), [
    '目标反复暂停/恢复 2 次',
    '目标清除',
    `目标暂停：${OBJ}`,
  ])
  assert.equal(goals[0].turnTo, 2)
})

test('extractMilestones：震荡被实质工作/距离打断时另起一条', () => {
  // 距离：隔了 5 轮（中间 4 轮没有目标操作）就是两段独立的震荡，不并成一条。
  const far = makeLog()
  far.turnStart(1)
  far.goal('pause', OBJ)
  far.turnEnd(1)
  far.turnStart(6)
  far.goal('resume', OBJ)
  far.turnEnd(6)
  const farGoals = extractMilestones(far.events).filter((m) => m.category === '目标')
  assert.deepEqual(farGoals.map((m) => m.title), [`目标暂停：${OBJ}`, `目标恢复：${OBJ}`],
    '隔了 4 轮以上的两次操作不是"反复"，各记各的')

  // 跨轮卡住（≥2 轮同一个阻塞问题）同理：这一段是"卡住"，不是震荡。
  const stuck = makeLog()
  stuck.turnStart(1)
  stuck.goal('pause', OBJ)
  stuck.turnEnd(1)
  for (const turn of [2, 3]) {
    stuck.turnStart(turn)
    stuck.tool('pwsh', { description: 'Retry with opencode-go' }, 'Missing x-opencode-session header [exit code: 1]')
    stuck.turnEnd(turn)
  }
  stuck.turnStart(4)
  stuck.goal('resume', OBJ)
  stuck.turnEnd(4)
  const stuckGoals = extractMilestones(stuck.events).filter((m) => m.category === '目标')
  assert.deepEqual(stuckGoals.map((m) => m.title), [`目标暂停：${OBJ}`, `目标恢复：${OBJ}`])
  assert.ok(extractMilestones(stuck.events).some((m) => /2 轮未解决/.test(m.title)), '卡住的弧自己成条')
})

test('extractMilestones：震荡合并不得吞掉中止弧（反漏检）', () => {
  const log = makeLog()
  for (const turn of [1, 2]) {
    log.turnStart(turn)
    log.user('先停一下，你跑一半就卡住了')
    log.goal(turn === 1 ? 'pause' : 'resume', OBJ)
    log.turnEnd(turn, { kind: 'aborted' })
  }

  const ms = extractMilestones(log.events)
  // 目标震荡并成一条，但"连续 2 轮被用户中止"是另一件事，必须同时在场——
  // 合并规则最容易吃掉的就是这类真实信息。
  assert.ok(ms.some((m) => m.title === '目标反复暂停/恢复 2 次'),
    `震荡应并成一条：${ms.map((m) => m.title).join(' | ')}`)
  assert.ok(ms.some((m) => m.cause === '连续 2 轮被用户中止，未完成'),
    `中止弧不得被吞：${ms.map((m) => `${m.title} — ${m.cause}`).join(' | ')}`)
  assert.ok(ms.some((m) => m.category === '中断' || m.category === '指令'), '中止弧自己成条')
})

// ── 缺口②：工具描述 / 报错原文不得当标题 ──────────────────────────────────

test('extractMilestones：断言簇的标题是断言名，不是原始错误对象文本', () => {
  const log = makeLog()
  log.turnStart(1)
  log.assistant('先把挂掉的用例挑出来。')
  // 真实形态：node:test 的 `✖ 名字 (0.98ms)` 与错误对象转储混在同一条结果里。
  log.tool('pwsh', { description: 'Run layer tests' },
    "code: 'ERR_ASSERTION', actual: [], expected: [ 'memory_recall', 'memory_state' ], operator: 'deepStrictEqual' "
    + '✖ arbitrateInjection：预算充足时全部保留，顺序仍是 L1→L2→L3 (0.981ms) [exit code: 1]')
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  assert.match(ms[0].title, /^测试断言失败：arbitrateInjection/, `标题应是断言名，实际：${ms[0].title}`)
  assert.doesNotMatch(ms[0].title, /ERR_ASSERTION|actual|code:/, '原始错误对象文本绝不能当标题')
  // 报错正文与工具自述用途都退到 detail（进 L3，不进骨架）。
  assert.match(ms[0].detail, /arbitrateInjection/, 'detail 里要留着是哪条断言挂了')
  assert.match(ms[0].detail, /Run layer tests/, 'detail 里要留着是哪个工具自述用途')

  // 跑器自己的行（文件名、"failing tests" 汇总）不是断言名：抽不到就退化成通用标签。
  const runner = makeLog()
  runner.turnStart(1)
  runner.tool('pwsh', { description: 'Run tests' },
    "✖ test\\contract.test.mjs (92.4582ms) ✖ failing tests: 'test failed' [exit code: 1]")
  runner.turnEnd(1)
  const runnerMs = extractMilestones(runner.events)
  assert.equal(runnerMs[0].title, '测试断言失败（1 次）', '抽不到断言名时退化成通用标签，不许抄文件名')
})

test('extractMilestones：工具自述用途不得当标题（有助手正文时用正文的结论句）', () => {
  const log = makeLog()
  log.turnStart(1)
  log.assistant('用户还没回复。那我先确认推荐安装路径真的能跑通。')
  log.assistant('## 本轮结论\n\n本轮把推荐安装路径实测跑通了，不再只是文档承诺。')
  log.tool('pwsh', { description: 'Clean sandbox and final verify' }, `ok 1\nok 2\n${'通过'.repeat(20)}`)
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  // 取最后一段正文的结论句：标题行（##）不粘连正文，开场白（"那我先…"）不参与。
  assert.equal(ms[0].title, '本轮把推荐安装路径实测跑通了')
  assert.doesNotMatch(ms[0].title, /Clean sandbox/, '工具自述用途不是标题')
  assert.equal(ms[0].cause, '验证通过（2 断言）')
  assert.equal(ms[0].category, '事件')
})

test('extractMilestones：工具报错原文不得当标题，只能进 detail', () => {
  const log = makeLog()
  log.turnStart(1)
  log.assistant('这是我的疏忽——我误判了子代理已结束。它还在跑。')
  log.tool('send_message', { target: '0fc8b43f-5480-408e-a07a-bbb3701c8a8b' },
    'Error: active teammate "0fc8b43f-5480-408e-a07a-bbb3701c8a8b" not found', true)
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  assert.match(ms[0].title, /误判了子代理已结束/)
  assert.doesNotMatch(ms[0].title, /active teammate|0fc8b43f/, '报错原文（含机器 id）不能当标题')
  assert.match(ms[0].detail, /active teammate/, '原文退到 detail')
})

test('extractMilestones：粘贴的终端输出概括成一句人话，不从中间截断', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('PowerShell 7.6.6 PS C:\\Users\\admin> pwsh -File D:\\x\\restore-profile.ps1\n'
    + "Join-Path: D:\\x\\restore-profile.ps1:18 Line | 18 | $profileDir = Join-Path $env:DSH_HOME 'profiles\\desktop'\n"
    + "无法将自变量绑定到参数 'Path'，因为它为 null。\n"
    + 'PS C:\\Users\\admin> 命令行出现了这样的问题，然后目标我先暂停了，你需要整合成一个插件，可以直接开关')
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  assert.equal(ms.length, 1)
  // 标题 = 「报告 X 报错」+ 粘贴块**之后**的人话（用户的诉求往往写在粘贴块后面）。
  assert.match(ms[0].title, /^报告 PowerShell 脚本报错/)
  assert.match(ms[0].title, /整合成一个插件/)
  assert.doesNotMatch(ms[0].title, /PS C:\\|Join-Path|restore-profile/, '不许从粘贴块中间截断')
  assert.match(ms[0].detail, /PS C:\\Users\\admin>/, '粘贴原文全文进 detail')
})

test('extractMilestones：单次、当轮就解决的解析错误不记', () => {
  const log = makeLog()
  log.turnStart(1)
  log.assistant('先跑一次产物自检。')
  log.tool('pwsh', { description: 'Verify artifact contents' }, 'ParserError: Unexpected token } [exit code: 1]')
  log.tool('pwsh', { description: 'Rebuild and verify' }, `ok 1\nok 2\n${'通过'.repeat(20)}`)
  log.turnEnd(1)
  // 当轮就修好、且没有别的实质内容的瞬时失败不占骨架——它不是卡点也不是结论。
  assert.deepEqual(extractMilestones(log.events), [])

  // 对照组：同样的解析错误，但当轮没修好 → 仍要留下（否则"卡在哪"就丢了）。
  const open = makeLog()
  open.turnStart(1)
  open.assistant('产物自检脚本本身有语法错误，还没修。')
  open.tool('pwsh', { description: 'Verify artifact contents' }, 'ParserError: Unexpected token } [exit code: 1]')
  open.turnEnd(1)
  const openMs = extractMilestones(open.events)
  assert.equal(openMs.length, 1)
  // 单次瞬时失败不占标题（标题来自正文叙述），但"未解决"与原文都要留在骨架里。
  assert.equal(openMs[0].title, '产物自检脚本本身有语法错误')
  assert.equal(openMs[0].cause, '未解决')
  assert.match(openMs[0].detail, /ParserError/)
})

// ── 缺口③：长用户消息的标题是概括，不是截断原文 ─────────────────────────────
//
// 实测里最刺眼的一类标题：`我可以不通过pwsh -File D:\deepseek\deepseekh_…`（切在半截
// 路径上）、`1.再插件列表中有很多新添的有报错 2.powershell安装报错 3.插件…`（列表只截
// 前两项）。下面的用例逐条钉住修复：注入噪音先剥离、长消息让位给助手叙述、列表概括成
// 「提出 N 项要求」、截断只落在语义单元末尾。

/** 一条"装不进标题"的用户消息：40 字上限放不下，概括时最容易切在半截路径上。 */
const LONG_PATH_MSG = '我可以不通过pwsh -File D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory'
  + '\\profile-recovery\\install.ps1安装，改用插件列表里输入仓库地址或本地文件位置安装'

test('extractMilestones：注入噪音先剥离再取标题，原文照旧进 detail', () => {
  const noisy = '[image]\n'
    + '修复拖动的边界问题\n'
    + '<system-reminder>\nAdditional instructions from: upstream/AGENTS.md\n</system-reminder>\n'
    + 'Time sampled while preparing turn 25, step 3: 2026-10-07T16:55:14+08:00[Asia/Shanghai]\n'
    + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n'
    + 'Elapsed since the preceding model-visible message: 10m 6s.\n\n'
    + 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'
    + 'Current DSH file policy: workspace-write.\n\n'
    + 'Approval policy: ask.\n\n'
    + '# 三层记忆 · 本轮投影\n\n'
    + '## L1 工作记忆（Working Memory）\n- 保留窗口：最近 8 轮（turn 25–25）。\n'

  const log = makeLog()
  log.turnStart(1)
  log.user('先看看插件状态')       // 第一条用户消息的标题归「任务」条目
  log.turnEnd(1)
  log.turnStart(2)
  log.user(noisy)
  log.turnEnd(2)

  const ms = extractMilestones(log.events)
  const item = ms.find((m) => m.turn === 2)
  assert.ok(item !== undefined, `第 2 轮应有条目：${ms.map((m) => m.title).join(' | ')}`)
  assert.equal(item.title, '修复拖动的边界问题', '剥离噪音后剩下的才是用户真正说的话')
  for (const noise of ['Time sampled', 'Current runtime context', '三层记忆', 'system-reminder', 'image']) {
    assert.doesNotMatch(item.title, new RegExp(noise), `注入噪音不得进标题：${noise}`)
  }
  // 剥离只作用于标题：原文整段进 detail，并标注剥了哪几类（不丢信息）。
  assert.match(item.detail, /Time sampled while preparing turn 25/, '原文照旧保留')
  assert.match(item.detail, /# 三层记忆 · 本轮投影/)
  assert.match(item.detail, /\[标题已剥离注入噪音：/)
  for (const rule of ['时间采样行', '运行时上下文快照', '三层记忆投影块', 'system-reminder 块', '图片占位']) {
    assert.match(item.detail, new RegExp(rule), `detail 要记下剥离规则：${rule}`)
  }
})

test('extractMilestones：长用户消息用助手叙述概括，空话不得顶替', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('先看看插件状态')
  log.turnEnd(1)
  log.turnStart(2)
  log.assistant('明白，用插件列表 UI 安装才是正路。')
  // 有序列表的编号要连标点一起剥掉，否则会被断成「1」和「预设已修复」两个小句。
  log.assistant('## 1. 预设已修复\n\n`cordis.patch.yml` 还原完成：\n\n```\n267 行\n```')
  log.user(LONG_PATH_MSG)
  log.turnEnd(2)

  const item = extractMilestones(log.events).find((m) => m.turn === 2)
  assert.ok(item !== undefined)
  assert.equal(item.title, '预设已修复', '长用户消息的标题取助手那句的结论，而不是半截路径')
  assert.doesNotMatch(item.title, /\*\*|`|#/, 'markdown 记号不得进标题')

  // 助手那句是计数空话时不许顶替：`三件都做了` 指哪三件只有 detail 里有，比用户原话更没信息。
  const vague = makeLog()
  vague.turnStart(1)
  vague.user('先看看插件状态')
  vague.turnEnd(1)
  vague.turnStart(2)
  vague.assistant('三件都做了，而且过程中测试抓到一个真 bug。')
  vague.user(LONG_PATH_MSG)
  vague.turnEnd(2)
  const vagueItem = extractMilestones(vague.events).find((m) => m.turn === 2)
  assert.ok(vagueItem !== undefined)
  assert.match(vagueItem.title, /^我可以不通过pwsh/, '空话不能顶掉完整的用户概括')
  assert.doesNotMatch(vagueItem.title, /三件都做了/)

  // 用户消息不长（装得进标题）时，助手叙述不许抢：这条消息本身就是一句完整的概括。
  const short = makeLog()
  short.turnStart(1)
  short.user('先看看插件状态')
  short.turnEnd(1)
  short.turnStart(2)
  short.assistant('本轮把推荐安装路径实测跑通了。')
  short.user('现在这个压缩逻辑启用了吗')
  short.turnEnd(2)
  const shortItem = extractMilestones(short.events).find((m) => m.turn === 2)
  assert.equal(shortItem?.title, '现在这个压缩逻辑启用了吗')
})

test('extractMilestones：编号列表概括成「提出 N 项要求」，不截前两项', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('1.插件列表里新添的项报错\n2.powershell 安装报错\n3.插件面板处安装也报错\n你执行到一半卡住了')
  log.turnEnd(1)

  const ms = extractMilestones(log.events)
  // 截断读法只看到前两项，读者不知道一共提了几件事——N 加第一项的要点才是一句概括。
  assert.equal(ms[0].title, '提出 3 项要求：插件列表里新添的项报错')
  assert.doesNotMatch(ms[0].title, /2\.|powershell|插件面板/, '列表不许只截前两项')

  // 粘贴的脚本输出里自带 `1. 2. 3.` 检查清单：序列一断就停，数出来的是用户的要求。
  const pasted = makeLog()
  pasted.turnStart(1)
  pasted.user('1.目标还要继续吗？\n2.进入的时候 PowerShell 7.6.6\n'
    + 'PS C:\\Users\\admin> pwsh -File D:\\x\\restore.ps1\n启动后请确认：\n'
    + '  1. 插件列表只剩一个\n  2. memory_state 工具出现\n  3. compaction-basic 为 enabled\n'
    + 'PS C:\\Users\\admin>')
  pasted.turnEnd(1)
  const pastedMs = extractMilestones(pasted.events)
  assert.match(pastedMs[0].title, /提出 2 项要求：目标还要继续吗/, '脚本自己的检查清单不算用户的要求')
  assert.match(pastedMs[0].title, /^报告 PowerShell 脚本/, '粘贴块与列表是两件事，都要在标题里')
})

test('extractMilestones：截断只落在语义单元末尾（不切半截路径/半个词）', () => {
  const log = makeLog()
  log.turnStart(1)
  log.user('先看看插件状态')
  log.turnEnd(1)
  log.turnStart(2)
  // 没有助手叙述可依据：标题只能从用户原话概括，此时最容易被切在半截路径上。
  log.user(LONG_PATH_MSG)
  log.turnEnd(2)

  const item = extractMilestones(log.events).find((m) => m.turn === 2)
  assert.ok(item !== undefined)
  assert.ok(item.title.length <= 40, `标题必须 ≤40：${item.title}`)
  assert.ok(item.title.endsWith('…'), `超长原话必须截断：${item.title}`)
  // 省略号只能跟在完整语义单元后：半个路径（`…deepseekh_`）与半个词都是半成品。
  assert.doesNotMatch(item.title, /[A-Za-z0-9_]…$/, `省略号跟在半截 token 后：${item.title}`)
  assert.doesNotMatch(item.title, /-File…$/, '孤立参数（`-File`）后面必然还有值，不能拿它收尾')
  assert.match(item.title, /\\…$/, '长路径最多切到某个目录分隔符为止')

  // 句边界优先：有小句标点/空白可用时，省略号就落在那里。
  const clause = '把 install.ps1 的 DSH_HOME 推导逻辑改成从 profile 目录反查并且把未设置时的默认位置也写进日志'
  const second = makeLog()
  second.turnStart(1)
  second.user('先看看插件状态')
  second.turnEnd(1)
  second.turnStart(2)
  second.user(clause)
  second.turnEnd(2)
  const clauseItem = extractMilestones(second.events).find((m) => m.turn === 2)
  assert.ok(clauseItem !== undefined)
  const body = clauseItem.title.replace(/…$/, '')
  assert.ok(clause.startsWith(body), `标题必须是原话的前缀：${clauseItem.title}`)
  assert.match(clause[body.length] ?? '', /[\s，。、；：！？]/, '省略号必须跟在句边界之后')
})
