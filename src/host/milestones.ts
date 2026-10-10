/**
 * milestones.ts — 主线骨架：把整段会话事件流压成一份「里程碑主线」。
 *
 * 这是可行性研究（`feasibility/extract.mjs`）的正式化移植。那份脚本在一个真实会话
 * （54 轮 / 11,424 事件 / 2,076 次工具调用 / 153 次失败结果）上验证过：
 * **54 条 / 2,593 字符 / 1,821 tokens**，标题均 24.7 字符、最长 40、超 40 的 0 条。
 *
 * 它填的是 L2 与 L3 之间的缺口：L2 摘要是"最近发生了什么"的滚动视图，轮次一多就
 * 只剩结论；L3 存的是原始正文。**主线骨架**是第三样东西——一眼看完整个会话的
 * 「谁要什么 / 做没做成 / 卡在哪」。它同时是"回退弧"的唯一载体：哪些需求反复没做对
 * （第 11「还是很僵硬」→ 21「还是很糊」→ 23「还是无法拖动」→ 46「还是不行」），
 * 只有把几十轮压成几十行才看得出来。
 *
 * 四个收紧动作（每条都是踩坑得出的，不是审美选择）：
 * 1. **去重合并** 同轮同「问题类」的失败 → 一条，标题带「N 次尝试」。实测 153 次工具
 *    失败 + 7 个整轮失败轮 → 12 条失败条目；不合并的话失败会占掉骨架的 40%。
 * 2. **严重度分级** `proto`（"file has not been read" 这类未读先改的协议错误）**永不进
 *    骨架**——模型下一次调用就能自我纠正，占候选的大多数（39 条）；`parser`/`depmiss`/
 *    `timeout` 是瞬时失败，折叠进相邻条目；`pydep`/`lock`/`orphan`/`assert`/`net` 是阻塞。
 * 3. **验证合并** 验证通过**不单独成条**（实测 69 条验证候选 → 0 条独立条目），只作为
 *    「修复并验证通过」的原因从句；只有跨轮连续稳定期才合并成一条区间。
 * 4. **标题生成** ≤40 字符，形状 `{发生了什么} — {一句原因}`；超长的用户原话概括后，
 *    全文进 `detail`（进 L3，不进骨架）。截断**只落在语义单元边界**（小句标点 / 空白之后），
 *    绝不切在半截路径或半个词上（见 {@link clipUnit}）——`我可以不通过pwsh -File
 *    D:\deepseek\deepseekh_…` 这类标题读者根本不知道要说什么。
 * 5. **标题来源只认人话**：用户消息（含粘贴的终端输出 → 概括成「报告 X 报错」）或助手正文的
 *    结论句。工具自述用途（`description`/命令原文）、报错正文、机器 id **一律只进 `detail`**——
 *    实测这两类噪音会占掉骨架的 1/4（`Clean sandbox and final verify`、
 *    `PowerShell 7.6.6 PS <user>> pws…`、`active teammate "0fc8b43f-5…`、
 *    `code: 'ERR_ASSERTION', actu…` 都是这么来的）。
 * 6. **目标生命周期是震荡，不是事件流**：`pause`/`resume`/`edit` 的连续序列属于**同一个目标的
 *    反复中断又续跑**。同轮同类先折叠成 1 次，跨轮序列并成一条（`目标反复暂停/恢复 N 次`）；
 *    只有被 `create`/`complete`/`clear` 或**实质工作**（阻塞失败 / 交付 / 新指令 / 压缩）打断才
 *    另起一条——否则一段跨越 20 轮的震荡会和中间的正常开发粘成一行。
 * 7. **注入噪音先剥离再取标题**：宿主与本插件每轮往**同一条用户消息**尾部追加的运行时上下文
 *    （`Time sampled while preparing turn N…`、`Current runtime context. …`、
 *    `# 三层记忆 · 本轮投影`、`<system-reminder>`、`[image]`）不是用户说的话，却会跟着原话
 *    一起进概括、把真正的诉求挤出 40 字额度（实测 `Time sampled while preparing turn 25…`
 *    这类行本身就能占满一整条标题）。剥离**只作用于标题**，原文照旧整段进 `detail`，
 *    并在那里标注剥离了哪几类（见 {@link userDetail}）。
 * 8. **长用户消息让位给助手叙述**：>40 字的用户消息装不进标题，取助手收尾那句的开头
 *    （见 {@link proseTitle}）——"用户说了什么"的截断不如"这一轮发生了什么"的概括。助手那句
 *    是空话（`三件都做了`）、机器残渣或语种跑偏时保留用户概括，见 {@link proseWorth}。
 *    编号列表（`1.xxx 2.xxx 3.xxx`）另有专门形态：`提出 N 项要求：{第一项要点}`，
 *    而不是把前两项截出来（见 {@link listSummary}）。
 *
 * 本模块是纯函数：只读事件的叶子字段，不触碰 live 对象、不调用任何 service，
 * 因此可以脱离运行时单测（见 test/milestones.test.mjs）。
 *
 * @module dsh-tri-layer-memory/milestones
 */
import { contentToText, estimateTokens, messageBody } from './l1-working.ts'
import type { EventLike } from './l1-working.ts'

/** 一条里程碑。 */
export interface Milestone {
  /** 轮号；跨轮里程碑是**起始**轮。 */
  turn: number
  /** 跨轮里程碑的结束轮；单轮条目不设此字段。 */
  turnTo?: number
  /** 发生了什么（≤40 字符）。 */
  title: string
  /** 「—」后面那句原因。 */
  cause: string
  /** 用户原话全文 / 原始日志。进 L3，不进骨架。 */
  detail: string
  /** 中文分类：指令|失败|回退|转向|压缩|交付|目标|任务|决策|验证|中断。 */
  category: string
  /** 本行渲染后的估算 token 数（与骨架 token 口径一致）。 */
  tokens: number
}

/** 标题上限：超限的骨架会退化成"把用户原话搬进标题"（第一轮实测均 47.8 token/条）。 */
const TITLE_MAX = 40
/** 原因从句上限：一句原因就够，两句是上限。 */
const CAUSE_MAX = 44
/**
 * 截断后至少要留下的字符数。
 *
 * 额度是 40 字，切在 10 字以内等于把这一条的信息量砍掉 3/4——那种时候宁可换个切点
 * （见 {@link clipUnit} 的第 ③ 条）。实测 `任务完成后也要说话…`（10 字）丢掉的正是
 * 后面那个"这个是语音包"的路径，读者反而更看不懂。
 */
const MIN_UNIT = 12

// ─────────────────────────── 词表 ───────────────────────────

/** 无信息量的用户输入：只有这些内容时不产生里程碑。 */
const STOP = new Set([
  '继续', '你好', 'hi', 'hello', 'ok', 'okay', '好的', '嗯', '继续完成任务', '继续完成', '在吗', '？', '?',
])

/** 方向变更信号：推翻前设 / 改主意 / 关掉某条路线。 */
const PIVOT: ReadonlyArray<readonly [string, RegExp]> = [
  ['不要', /不要|不用|不需要|无需|别再|别(?=[让把用发写说弄做])/],
  ['改为', /改为|改成|换成|换回|切换到|改用/],
  ['关闭', /关闭|关掉|停掉|先关|线关闭|禁用|去掉|移除|撤掉/],
  ['收窄', /只(?:要|需|保留|做)|仅限|只做/],
  ['重定范围', /重新|重来|推倒|推翻|算了/],
]

/** 回退信号：同一个问题再次没修好（骨架里最值钱的一类）。 */
const RETRY = /还是|仍然|依旧|依然|又一次|又卡|又(?:不|没)|再次|仍然不|还是不行|仍然无法/
/** 追问信号：用户要的是解释，不是改动。 */
const QUESTION = /[？?]|为什么|是不是|是否|指的是|什么意思|原因是什么|是什么|吗[？?]?$/
/** 用户确认类短句：无问号、无祈使，纯粹反馈结果。 */
const CONFIRM = /^(看到|好了|成了|可以了|成功|好的|行了|没问题|ok)/
/** 泛泛的催促/续跑（不含具体症状）——这种话本身不构成里程碑，标题让给失败事件。 */
const NUDGE = /^(你?又?卡住|继续|接着|重试|再来|还没|怎么还|你?又)/

/** 失败严重度：`noise` 永不进骨架 / `transient` 瞬时（折叠）/ `blocking` 阻塞（保留）。 */
type Level = 'noise' | 'transient' | 'blocking'

/**
 * 失败分类 —— 收紧的核心：同一「问题类」的多次尝试才是同一个事件。
 *
 * 刻意**没有 catch-all 正则**（否则会吃掉所有分类），兜底走 `other`。
 * 顺序即优先级：`proto` 必须在最前，否则"未读先改"会被后面的 depmiss 抢走
 * （正文里往往同时含 "not found"）。
 */
const CLASSES: ReadonlyArray<readonly [string, RegExp, Level, string]> = [
  ['proto', /file has not been read|old_string was not found|file no longer exists|old_string and new_string must differ|old_string matched 2 times|has not been read, then retry|re-read the file/i, 'noise', '协议错误（未读先改）'],
  ['pydep', /No module named|ModuleNotFoundError/i, 'blocking', '缺 Python 依赖'],
  ['sesshdr', /x-opencode-session/i, 'blocking', '缺 x-opencode-session 路由头'],
  ['orphan', /杀 pid=|taskkill|Stop-Process|孤儿|orphan|残留的 sapi/i, 'blocking', 'sapi 孤儿进程杀不掉'],
  ['lock', /atomic-write: timed out|writer lock/i, 'blocking', 'profile 写入锁超时'],
  ['sandbox', /sandbox: file access denied|escalation available/i, 'transient', '沙箱拒绝写入'],
  ['depmiss', /Cannot find module|ERR_PNPM|not registered|has no method|IO error for operation|: not found|找不到/i, 'transient', '依赖/目标不存在'],
  ['parser', /ParserError|SyntaxError|Invalid string escape|Expected unicode escape|Invalid or unexpected token|不允许空管|重定向运算符|表达式或语句中|后应为表达式/i, 'transient', '脚本解析错误'],
  ['timeout', /timed out after/i, 'transient', '命令超时'],
  ['assert', /(^|\s)FAIL(\s|$)|✖/, 'blocking', '测试断言失败'],
  ['net', /ECONNRESET|ETIMEDOUT|fetch failed|Connection error/i, 'blocking', '网络/连接错误'],
]

/**
 * 执行类工具：只有这些工具的结果会跑「正文级」判定。
 *
 * `job_output` / `job_kill` 必须在列：后台任务（`run_in_background`）的失败**不经过
 * 原工具**，`toolCallId` 指向的是 `job_output` 而不是 `pwsh`——漏掉这两个会整类漏检
 * （实测 `ERR_PNPM_IGNORED_BUILDS` 即如此）。
 *
 * 注意失败判定本身**不按工具名过滤**（任何工具的 `isError` / 非零退出码都算失败，
 * 这样后台任务的失败天然被覆盖）；白名单只用在"这条结果算不算一次验证"上——
 * 否则 `read` 一个叫 `host-smoke.mjs` 的测试文件，正文里的 `assert.ok` 会被误判成
 * 「验证通过」（实测第 19 轮即如此）。
 */
const EXEC_TOOLS = new Set(['pwsh', 'plugin_manager', 'job_output', 'job_kill', 'web_fetch'])

/**
 * 目标操作的中文名与原因从句。
 *
 * 「目标只有 create / complete 两种操作」是错觉：`edit`（改写目标）、`pause`/`resume`
 * （暂停/恢复自动续跑）、`clear`（退出目标制）同样会发 `goal/change`。把它们一律写成
 * 「目标达成，自主运行结束」，骨架就会自相矛盾——实测一个会话里出现 9 条
 * 「目标 pause：… — 目标达成」。`clear` 不在参考会话里，这里一并补上：它退出目标制，
 * 既不是达成也不是暂停。
 */
const GOAL_OP_CN: Record<string, string> = {
  create: '建立目标',
  complete: '目标完成',
  pause: '目标暂停',
  resume: '目标恢复',
  edit: '目标修订',
  clear: '目标清除',
}

/**
 * 会让目标"来回翻转"的三个操作。
 *
 * `create`/`complete`/`clear` 是目标制的进出（真实里程碑，各自成条），而这三个是同一段
 * 震荡的内部状态——实测一个会话里 10 条目标条目有 7 条属于同一个目标的反复暂停/恢复。
 */
const GOAL_OSC = new Set(['pause', 'resume', 'edit'])

/** 未知操作退化成 `operation=<op>`：宁可暴露原始字段，也不要编一句假结论。 */
const GOAL_OP_REASON: Record<string, string> = {
  create: '长任务转目标制，自动续跑',
  complete: '目标达成，自主运行结束',
  pause: '目标被暂停（用户或系统）',
  resume: '目标被恢复，继续自动续跑',
  edit: '目标被改写',
  clear: '目标被清除，退出目标制',
}

/** 分类的中文名（进 `Milestone.category`）。 */
const CATEGORY_CN: Record<string, string> = {
  task: '任务',
  goal: '目标',
  user: '指令',
  pivot: '转向',
  retry: '回退',
  decision: '决策',
  fail: '失败',
  fix: '验证',
  artifact: '交付',
  compact: '压缩',
  event: '事件',
  plan: '计划',
  interrupt: '中断',
}

// ─────────────────────────── 小工具 ───────────────────────────

/** 安全取对象：未信任值 → 空对象。 */
function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 安全取非空字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 安全取有限数字。 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 安全取数组：未信任值 → 空数组。 */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim()

/** 截断到 n 字符（含省略号，因此结果长度恰好 ≤ n）。 */
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/**
 * 句读：小句标点与空白之后都是可以安全落刀的地方。
 *
 * 刻意**不含路径分隔符**（`\` `/`）：切在 `…\plugins\dsh-tri-layer\` 上虽然不算半个词，
 * 但它是一条没有结尾的路径。路径分隔符由 {@link TOKEN_CHAR} 那条判据兜住——它只保证
 * "不切在 token 中间"，因此路径最多切到某个目录为止（实测第 37 轮的
 * `任务完成后也要说话，<user>\Downloads\…`）。
 */
const UNIT_END = /[，。、；：！？,;:!?）)》」』】\s]/
/** ASCII token 字符：截断绝不能落在它们中间——`…deepseekh_` 就是这么切出来的。 */
const TOKEN_CHAR = /[A-Za-z0-9_.-]/

/** 去掉截断处残留的句读、分隔符与空括号（`…memory_state /…`、`…引擎」(…` 这种尾巴要收干净）。 */
const trimTail = (s: string): string => s
  .replace(/[\s，。、；：！？,;:!?]+$/, '')
  .replace(/[（(「『【《[{]+$/, '')
  .replace(/\/+$/, '')
  .trim()

/**
 * 切点前的最后一个 token 必须"成词"。
 *
 * `我可以不通过pwsh -File…` 的切点落在 `-File` 后面——它是一个孤立参数，后面必然还有
 * 东西（文件名），拿它收尾等于把句子切在动词上。盘符（`D:`）同理。
 */
function tailOk(prefix: string): boolean {
  // 先去掉结尾的空白/路径分隔符：切点本来就落在它们之后，直接判会把它们当成"最后一个词"。
  const bare = prefix.replace(/[\s\\/]+$/, '')
  if (bare.length === 0) return false
  // 盘符（`D:`）：切在 `D:` 后面等于把路径的根丢给读者。
  if (/[A-Za-z]:$/.test(bare)) return false
  // 孤立参数（`-File`）：它后面必然还有值，拿它收尾等于把句子切在动词上。
  return !/(?:^|[\s\\/])-[A-Za-z][\w-]*$/.test(bare)
}

/**
 * 按语义单元截断到 n 字符（含省略号）。
 *
 * {@link clip} 是"到长度就切"，于是长出过两类读不懂的标题：切在半截路径上
 * （`我可以不通过pwsh -File D:\deepseek\deepseekh_…`）和切在半截词上。规则两条：
 * ① 切点只能落在**完整语义单元的末尾**——小句标点之后、或 token 边界（含路径分隔符，
 *    因此路径最多切到某个目录为止）；② 切点前的最后一个 token 必须成词（见 {@link tailOk}，
 *    它挡掉 `-File` 这类孤立参数与 `D:` 这类盘符）。
 *
 * 从右往左取**最长的合法切点**：40 字额度要尽量用满，切得越靠左丢掉的信息越多；
 * 全都短于 {@link MIN_UNIT} 时才退而求其次。中文没有词边界可判，所以对纯中文段
 * ② 退化成"按字切"，但省略号仍然跟在标点/空格/token 边界之后。
 */
function clipUnit(s: string, n: number): string {
  if (s.length <= n) return s
  const limit = n - 1
  const cuts: number[] = []
  for (let i = 1; i <= limit; i += 1) {
    const prev = s[i - 1] ?? ''
    const next = s[i] ?? ''
    if (UNIT_END.test(prev) || !TOKEN_CHAR.test(prev) || !TOKEN_CHAR.test(next)) cuts.push(i)
  }
  const pick = (min: number): string | null => {
    for (let k = cuts.length - 1; k >= 0; k -= 1) {
      const cut = cuts[k] ?? 0
      if (cut >= min && tailOk(s.slice(0, cut))) return `${trimTail(s.slice(0, cut))}…`
    }
    return null
  }
  return pick(MIN_UNIT) ?? pick(1) ?? `${trimTail(s.slice(0, limit))}…`
}

/** 取路径的文件名部分（两种分隔符都认）。 */
const baseName = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').split('/').pop() ?? ''

const uniq = <T>(a: readonly T[]): T[] => [...new Set(a)]

/**
 * 给簇标题补「N 次尝试」后缀——label 自带计数时不再补。
 *
 * `assert` 簇抽不到具体断言名时，label 本身就是「测试断言失败（N 次）」（见 {@link clusterize}）；
 * 补条目再补一次后缀，标题就成了「测试断言失败（2 次）（2 次尝试）」——同一个计数出现两次。
 */
function withAttempts(label: string, n: number): string {
  if (n <= 1) return label
  return /（\d+\s*次(?:尝试)?）$/.test(label) ? label : `${label}（${n} 次尝试）`
}

/** 取一条消息事件的正文：位置有两个，判断交给 l1-working 的 {@link messageBody}。 */
function messageText(data: Record<string, unknown>): string {
  return contentToText(messageBody(data))
}

/**
 * 抽出**非零**退出码。
 *
 * DSH 有两种写法：pwsh 的 `[exit code: 1]`，以及后台任务经 `job_output` 回来的
 * `[status: completed, exit code: 1]`。只认前者会整类漏检。
 * 退出码 0 不算失败——`[status: completed, exit code: 0]` 是后台任务正常收尾。
 * 刻意只认方括号形态：正文里裸写的 "exit code: 1"（例如日志回显）不是执行结果。
 */
function exitCodesIn(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/\[\s*(?:status:[^\]]*?,\s*)?exit code:\s*(\d+)\s*\]/g)) {
    const code = m[1]
    if (code !== undefined && code !== '0') found.push(code)
  }
  return uniq(found)
}

/**
 * 注入噪音 → 剥离后的文本 + 命中的规则名。
 *
 * 这些块不是用户说的话，而是宿主/本插件每轮**追加进同一条消息**的运行时上下文。
 * 它们混在原话里有两个后果：真正的诉求被挤出 40 字额度（`Time sampled while preparing
 * turn 25…` 一行就能占满一条标题），以及 `是否`/`为什么` 这类词把消息误判成"追问"。
 *
 * 前两类按**整段**处理：它们是消息尾部追加的块，块内每一段都是噪音，所以从标记处一直切到
 * 结尾——`Current runtime context.` 后面还跟着 `Current DSH file policy…`、
 * `Approval policy…` 等段落，只删标题行会漏掉大半。时间采样那三行逐行删，不依赖位置。
 * 剥离结果只用于**取标题**：原文照旧整段进 `detail`（见 {@link userDetail}）。
 */
function stripInjections(text: unknown): { text: string; rules: string[] } {
  let s = String(text ?? '')
  const rules: string[] = []
  /** 尾部块：从标记处切到结尾（块内全是噪音，没有用户的话）。 */
  const cutTail = (re: RegExp, label: string): void => {
    const at = s.search(re)
    if (at < 0) return
    s = s.slice(0, at)
    rules.push(label)
  }
  cutTail(/^[ \t]*#\s*三层记忆\s*[·・]\s*本轮投影/m, '三层记忆投影块')
  cutTail(/^[ \t]*Current runtime context\./m, '运行时上下文快照')
  const beforeLines = s
  s = s.replace(/^[ \t]*Time sampled while preparing\b[^\n]*/gm, '')
    .replace(/^[ \t]*Browser time zone for this request\b[^\n]*/gm, '')
    .replace(/^[ \t]*Elapsed since the preceding\b[^\n]*/gm, '')
  if (s !== beforeLines) rules.push('时间采样行')
  if (/<system-reminder>/i.test(s)) {
    s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    rules.push('system-reminder 块')
  }
  if (/\[image\]/i.test(s)) rules.push('图片占位')
  s = s.replace(/\[image\]/gi, '').replace(/\[表情:[^\]]*\]/g, '').replace(/\[tool-call [^\]]*\]/g, '')
  return { text: s, rules }
}

/** 去掉用户消息里的非文字噪声（注入噪音、图片占位、表情包指令、工具调用占位）。 */
function cleanUserText(text: unknown): string {
  return norm(cleanUserRaw(text))
}

/**
 * 同上，但**保留换行**。
 *
 * 粘贴的终端输出要靠行首锚点（提示符、`Line | 18`、`Traceback`）认出边界；先 `norm` 压成
 * 一行的话，这些锚点会连成一片、切不出"哪一段是机器输出"。
 */
function cleanUserRaw(text: unknown): string {
  return stripInjections(text).text
}

/**
 * 粘贴块的锚点：PowerShell / cmd 提示符、bash 提示符、`Traceback`、PS 的 `Line | 18`、
 * DSH 自己的退出码标记。
 *
 * 只认"机器输出必然带"的形态，不认路径或反斜杠——用户正常说"看一下 C:\x\y.py"不能被当成粘贴。
 */
const PASTE_MARK = /PS\s+[A-Za-z]:\\[^>\n]{0,80}>|[A-Za-z]:\\[^>\n]{0,60}>|Traceback \(most recent call last\)|^\s*\$\s+\S|\bLine \|\s*\d+|\[\s*(?:status:[^\]]*,\s*)?exit code:\s*\d+\s*\]/gm

/** 用户原话里的小句（与 {@link summarizeUser} 同一套切分，供粘贴块与正文块复用）。 */
function userClauses(text: string): string[] {
  return text.split(/[，。！？；、\n]+|\.\s+/).map((s) => s.trim()).filter(Boolean)
}

/** 逐小句累积到 `limit` 字为止（而不是取首句），保住"要什么 + 症状"这对组合。 */
function accumulate(clauses: readonly string[], limit: number): string {
  let out = ''
  for (const clause of clauses) {
    if (out.length === 0) {
      out = clause
      continue
    }
    if (out.length >= limit) break
    out = `${out}，${clause}`
  }
  return out
}

/** 去掉小句开头的连接词、结尾的冒号，以及粘在句尾的版本号残渣（`2.进入的时候PowerShell 7.6.6`）。 */
function trimClause(clause: string): string {
  return clause
    .replace(/^(?:然后|另外|还有|以及|接着|而且)[，,]?\s*/, '')
    .replace(/\s*(?:PowerShell|pwsh|PS)\s*\d[\d.]*\s*$/, '')
    .replace(/[：:，,]+$/, '')
}

/** 指代粘贴块本身的句子（"命令行出现了这样的问题"）——它没有独立信息，压掉粘贴块后就是废话。 */
function isReferralClause(clause: string): boolean {
  return /(?:这样|这个|上述|上面|刚才|以下)/.test(clause) && /(?:问题|报错|错误|输出|日志|命令)/.test(clause)
}

/**
 * 粘贴的终端/日志块 → 一句人话（`报告 PowerShell 脚本报错`）。
 *
 * 主题词只认最常见的三种，其余退化成"命令行"：宁可笼统，也不要从中间截断成
 * `PowerShell 7.6.6 PS <user>> pws…`——那是第一轮实测里最难读的一类标题。
 */
function pasteClause(paste: string): string {
  const topic = /PowerShell|pwsh|PS [A-Za-z]:\\/i.test(paste)
    ? 'PowerShell'
    : /Traceback|python|ModuleNotFound/i.test(paste) ? 'Python' : /\b(?:npm|pnpm)\b/i.test(paste) ? 'npm' : '命令行'
  const what = /-File |\.ps1/i.test(paste) ? `${topic} 脚本` : topic
  const verb = /报错|错误|失败|Error|Exception|无法|not found|exit code/i.test(paste) ? '报错' : '输出'
  return `报告 ${what}${verb}`
}

/** 把原话切成"粘贴块 + 前后人话"三段；没有粘贴块时返回 null。 */
function splitPaste(text: string): { before: string; paste: string; after: string } | null {
  const marks = [...text.matchAll(PASTE_MARK)]
  const first = marks[0]
  const last = marks[marks.length - 1]
  if (first === undefined || last === undefined || first.index === undefined || last.index === undefined) return null
  const start = first.index
  const end = last.index + last[0].length
  let before = text.slice(0, start)
  // 提示符前面那截（`PowerShell 7.6.6 `）属于粘贴块本身，不是用户说的话——人话必然含中文，
  // 纯 ASCII 的前缀一律并进粘贴块。
  if (!/[\u4e00-\u9fff]/.test(before)) before = ''
  return { before, paste: text.slice(before.length, end), after: text.slice(end) }
}

/**
 * 编号列表项：`1.xxx`、`2、xxx`、`3）xxx`，行内（空格分隔）与行间（换行分隔）两种写法都认。
 *
 * 只认**从 1 开始、编号连续递增**的序列：`2024.` 这类年份与 `1.5` 这类小数不是列表
 * （`[.、)）](?!\d)` 就是为后者加的）。少于两项不算列表——一句带编号的话不值得改写成列表形态。
 *
 * 序列**一断就停**（`used` 之后遇到不等于期望值的编号立刻收尾）：粘贴的脚本输出里
 * 常带自己的 `1. 2. 3.` 检查清单，一路扫下去会把用户真正的两项要求数成三项
 * （实测第 16 轮的 `提出 3 项要求：目标还要继续吗`——用户只提了两项）。
 */
function listItems(text: string): { n: number; first: string; before: string } | null {
  const marks = [...text.matchAll(/(?:^|[\s\n\r])(\d{1,2})\s*[.、)）](?!\d)\s*/g)]
  const used: Array<{ at: number; end: number }> = []
  let expect = 1
  for (const m of marks) {
    if (m.index === undefined) continue
    if (Number(m[1]) !== expect) {
      // 还没开始找（expect === 1）时跳过别的编号；一旦开始，断了就不再往后接。
      if (used.length > 0) break
      continue
    }
    used.push({ at: m.index, end: m.index + m[0].length })
    expect += 1
  }
  const first = used[0]
  const second = used[1]
  if (first === undefined || second === undefined) return null
  return { n: used.length, first: text.slice(first.end, second.at).trim(), before: text.slice(0, first.at).trim() }
}

/** 用户消息是不是编号列表形态（见 {@link listSummary}）。 */
const isListMessage = (text: string): boolean => listItems(text) !== null

/** 列表第一项的"要点"预算：再多就不是要点而是抄录了，还会把列表前后的上下文挤掉。 */
const GIST_MAX = 20
/** 列表前那句话的预算：它是补充，比要点更短。 */
const PRE_MAX = 16

/**
 * 小句累积到不超过 budget 为止。
 *
 * 与 {@link accumulate} 的区别：宁可少说一句，也不超预算——列表概括要和上下文一起挤进
 * 40 字，`accumulate` 那种"先加再判"的写法会让第二句顶到 28 字，把"关闭语音功能"这类
 * 前置决定整个挤出标题（实测第 47 轮）。
 */
function fitClauses(clauses: readonly string[], budget: number): string {
  let out = ''
  for (const clause of clauses) {
    const next = out.length === 0 ? clause : `${out}，${clause}`
    if (next.length > budget) break
    out = next
  }
  return out.length > 0 ? out : clipUnit(clauses[0] ?? '', budget)
}

/**
 * 编号列表 → `提出 N 项要求：{第一项要点}`。
 *
 * 列表被截断的读法最糟：`1.再插件列表中有很多新添的有报错 2.powershell安装报错 3.插件…`
 * 只看到前两项，读者不知道一共提了几件事。N 加第一项的要点才是一句概括。
 *
 * 列表前后的上下文（`那就线关闭语音功能，继续完善` / 粘贴的终端输出）是另外两件事——
 * 一个说"要求了什么"，一个说"报告了什么"——都在时一起写；超长就按信息优先级从右往左丢，
 * 列表概括是主体，永远留着。
 */
function listSummary(list: { n: number; first: string; before: string }, pasteClause: string, max: number): string {
  const clauses = (s: string): string[] => userClauses(s).map(trimClause).filter((c) => c.length > 0)
  const gist = fitClauses(clauses(list.first), GIST_MAX)
  const pre = fitClauses(clauses(list.before), PRE_MAX)
  const parts = [pre, pasteClause, `提出 ${list.n} 项要求：${gist}`].filter((s) => s.length > 0)
  let out = parts.join('，')
  while (out.length > max && parts.length > 1) {
    parts.shift()
    out = parts.join('，')
  }
  return clipUnit(out, max)
}

/**
 * 用户原话 → ≤40 字符概括：逐小句累积到 16 字为止。
 *
 * 逐句累积（而不是取首句）是为了保住"要什么 + 症状"这对组合，例如
 * 「继续，启用之后插件可以显示了，但是会话出现问题」→ 前两句。
 *
 * 粘了一整段终端输出时（实测第 15 轮：430 字里 90% 是 PowerShell 报错原文），先把粘贴块
 * 压成「报告 X 报错」，再按**原文顺序**把前后的人话接上去——用户的要求（"整合成一个可开关
 * 的插件"）往往写在粘贴块后面，取首句会把它整条丢掉。
 *
 * 三条形态各走各的：编号列表 → {@link listSummary}；粘贴块 → 「报告 X 报错」+ 前后人话；
 * 其余 → 逐小句累积。三条都以 {@link clipUnit} 收尾，绝不切在半截路径/半个词上。
 */
function summarizeUser(text: unknown, max = TITLE_MAX): string {
  const raw = cleanUserRaw(text).replace(/[“”"]/g, '')
  const paste = splitPaste(raw)
  const pasteText = paste === null ? '' : pasteClause(paste.paste)
  const list = listItems(raw)
  if (list !== null) return listSummary(list, pasteText, max)
  if (paste !== null) {
    // 粘贴块那句话排在最前：它是"用户报告了什么"，后面的人话才是"用户要什么"。
    // 人话里粘着的机器残渣（`2.进入的时候PowerShell 7.6.6`）由 trimClause 收尾。
    const clauses = [
      pasteText,
      ...userClauses(paste.before),
      ...userClauses(paste.after),
    ].map(trimClause).filter((c) => c.length > 0 && !isReferralClause(c))
    // 粘贴块已经把一大段机器输出压成了一句，阈值放宽到 32 字：否则用户真正的诉求
    // （往往写在粘贴块之后）会被"报告 X 报错"挤掉。
    return clipUnit(accumulate(clauses, 32) || norm(raw), max)
  }
  const t = cleanUserText(text).replace(/[“”"]/g, '')
  return clipUnit(accumulate(userClauses(t), 16) || t, max)
}

/**
 * 用户概括是不是"读不懂"的截断（`我可以不通过pwsh -File D:\deepseek\deepseekh_…`）。
 *
 * 省略号说明概括被砍过。这种标题必须让位给助手叙述——哪怕助手那句本身不长
 * （`预设已修复`），它至少是一句完整的话。
 */
const isCutSummary = (summary: string): boolean => summary.endsWith('…')

/**
 * 从结果正文抽断言名（收紧后仍要保留"验证发现问题"的具体点）。
 *
 * 两种测试跑器各用一套标记：`FAIL <名字>`（本项目的手写契约测试）与 `✖ <名字>`
 * （node:test 的失败行）。`✖` 必须在列：漏了它，`✖ arbitrateInjection：预算充足时全…`
 * 会退化成 `other` 类，标题就成了原始错误对象文本 `code: 'ERR_ASSERTION', actu…`。
 *
 * `✖` 的名字以计时后缀 ` (0.98ms)` 结尾，因此止于 `(`；`FAIL` 沿用原有边界，不动它的行为。
 * 跑器自己的**汇总行与文件名**（`✖ failing tests: 'test failed'`、`✖ test\contract.test.mjs`）
 * 长得像断言名但不是——它们是"某个文件挂了"，当标题等于什么都没说，一律丢掉。
 */
function assertsOf(text: string): string[] {
  const s = norm(text)
  const out: string[] = []
  for (const m of s.matchAll(/(?:^|\s)FAIL\s+([^\u2014]{2,44}?)(?=\s+FAIL\s|\s+[\u2014-]|$)/g)) {
    const name = m[1]
    if (name !== undefined) out.push(norm(name))
  }
  for (const m of s.matchAll(/(?:^|\s)✖\s+([^\u2014'"[\]]{2,60}?)(?=\s*\(\d|\s+✖\s|\s+FAIL\s|\s+[\u2014-]|$)/g)) {
    const name = norm(m[1] ?? '')
    if (name.length > 0 && !isRunnerLine(name)) out.push(name)
  }
  return uniq(out.filter((s2) => s2.length > 0))
}

/** 跑器自己的行（文件名、"failing tests" 汇总、光秃秃的 `test`）不是断言名。 */
function isRunnerLine(name: string): boolean {
  return /\.(?:mjs|cjs|js|ts|tsx|jsx)\b/i.test(name)
    || /^(?:failing tests|test|tests|suites|pass|fail)\b/i.test(name)
    || name.length < 4
}

/**
 * 错误正文 → 一句可读的"发生了什么"。
 *
 * 优先级：测试报告的 FAIL 断言名（最可读）→ JSON 里的 message 字段 → `cannot read`
 * 形态 → 正文本身。最后统一剥掉无信息量的外壳前缀（HTTP 状态码、"Error:"、stderr 标记）。
 */
function errorLine(raw: unknown): string {
  const text = norm(raw)
  if (text.length === 0) return '(无正文)'
  let out: string | null = null
  const fails = assertsOf(text)
  if (fails.length > 0) out = `断言失败：${fails.slice(0, 3).join('；')}`
  if (out === null) {
    const m = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (m?.[1] !== undefined) out = m[1].replace(/\\"/g, '"')
  }
  if (out === null) {
    const mr = text.match(/cannot read "([^"]+)"/)
    if (mr?.[1] !== undefined) out = `${baseName(mr[1])} 不存在`
  }
  if (out === null) out = text
  return out
    .replace(/^\d{3}:\s*/, '')
    .replace(/^(Error|ERROR|error)\s*[:：]\s*/, '')
    .replace(/^\[stderr\]\s*/, '')
    .replace(/^Upstream request failed:\s*/i, '')
    .replace(/^\[invalid_request_error\]\s*/i, '')
}

/** 取工具调用的自述用途（pwsh 的 description、命令、文件名……）。 */
function callTitle(args: Record<string, unknown> | null): string {
  if (args === null) return ''
  const description = str(args.description)
  if (description !== undefined && description.trim().length > 0) return norm(description)
  const command = str(args.command)
  if (command !== undefined) return clip(norm(command), 60)
  const filePath = str(args.file_path)
  if (filePath !== undefined) return baseName(filePath)
  const target = str(args.target)
  if (target !== undefined) return `${str(args.action) ?? ''} ${baseName(target)}`.trim()
  const action = str(args.action)
  if (action !== undefined) return action
  if (Array.isArray(args.files)) return `${args.files.length} 个文件`
  const query = str(args.query)
  if (query !== undefined) return norm(query)
  return ''
}

// ─────────────────────── 逐轮事实抽取 ───────────────────────

/**
 * 开场白：宣布意图而不是结论（"我来看看…"、"Let me check…"）。
 *
 * 这类句子当标题只会占位，实测它在助手正文里占比不低（每次读文件前都有一句）。
 * 只认"看/查/试/读"这类纯侦察动词，不碰真正的结论句。
 */
const PROSE_OPENING = /^(?:我?先?(?:来|去)?(?:看看|看一下|看下|查查|查一下|查下|试试|试一下|读读|读一下)|让我|接下来|下面(?:来看|来)|Let me\b|Now\b)/i

/**
 * 助手正文 → 可当标题的行。
 *
 * 表格行与代码围栏必须去掉：助手的长报告里这两样占了大半，一旦进标题就是纯噪音
 * （实测 `| 版本 | 条数 | tokens | 状态 |`）。标题行（`## 本轮最重要的产出：…`）反过来
 * **保留正文**——它往往就是这一轮的结论句，所以要连"这行是不是标题"一起带出去。
 */
function proseLines(text: string): Array<{ text: string; heading: boolean }> {
  const kept: Array<{ text: string; heading: boolean }> = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const heading = /^\s*#{1,6}\s/.test(line)
    const stripped = line
      .replace(/^\s*#{1,6}\s*/, '')
      // 有序列表的编号要连标点一起剥掉：只剥 `#` 的话，`## 1. 预设已修复` 会被
      // `\.\s+` 断成「1」和「预设已修复」两个小句，标题成了纯编号 `1，预设已修复`。
      .replace(/^\s*(?:\d{1,2}|[①②③④⑤⑥⑦⑧⑨⑩])[.、)）]\s*/, '')
      .replace(/^\s*\|.*$/, '')
      .replace(/^\s*[-*•]\s*/, '')
      .trim()
    // 逐行 norm：`norm` 会把换行也压成空格，整段一次 norm 等于把标题行和正文粘成一句
    // （`本轮最重要的产出：… 子代理在分析会话日志时` 就是这么来的）。
    // markdown 记号（`**`、`` ` ``、单星号强调）在标题里只占 token，一律剥掉。
    const clean = norm(stripped).replace(/\*\*|`|\*/g, '')
    if (clean.length > 0) kept.push({ text: clean, heading })
  }
  return kept
}

/**
 * 助手正文里的结论句 → 小句序列（选中的是**最后一段**有内容的正文）。
 *
 * 取最后一段：它是这一轮的收尾叙述（"本轮把推荐安装路径实测跑通了"），而开头那段通常是
 * 开场白。开场白与纯工具调用占位直接跳过、继续往前找；一段都没有就返回空，
 * 由调用方退回其他标题来源。
 *
 * 单独返回小句而不是标题，是因为"值不值得顶替用户原话"要看**首句**（见 {@link proseWorth}）：
 * 首句太短时 {@link clausesTitle} 会把两句拼起来，拼出来的那句已经看不出是衔接语了。
 */
function proseClauses(prose: readonly string[]): string[] {
  for (let i = prose.length - 1; i >= 0; i -= 1) {
    const clauses: string[] = []
    for (const line of proseLines(prose[i] ?? '')) {
      // 段落标签（`## 本轮结论`）不是结论句——拿它当标题等于什么都没说。判据是**内容为空**
      // （标签词表）或**短到不成句**（<4 字）；不能再宽：`## 1. 预设已修复` 剥掉编号后
      // 只剩 5 字，但它是这一轮的结论，按字数砍会把真结论一起丢掉（实测第 22 轮退化成
      // 下一行的 `cordis.patch.yml 还原完成`）。
      if (line.heading && (line.text.length < 4 || HEADING_LABEL.test(line.text))) continue
      // 正文里的半角逗号/分号也是断句（`找到了! 6.1 / 6.2 用 Conv1d-pointwise,6.3 才改成 Linear`）；
      // 用户原话那套切分不动——它被基线钉着。
      for (const part of line.text.split(/[，。！？；、\n]+|\.\s+|[,;]\s*/)) {
        // 正文常以 emoji 开头（`🎯 找到了!`）：标题里它只占 token，不承载信息。
        const clause = part.replace(/^[^\p{L}\p{N}]+/u, '').trim()
        if (clause.length > 0) clauses.push(clause)
      }
    }
    const head = clauses[0]
    if (head === undefined || isOpeningLine(head)) continue
    return clauses
  }
  return []
}

/**
 * 小句序列 → 标题。
 *
 * 首句够长就只用首句：正文的句子比用户原话长，累积两句会把真正的结论挤出去。
 * 收尾的句读必须去掉——`模板确认了，ui-trajectory 的注册写法就是我们要抄的：` 的冒号
 * 后面本来还有正文（代码块），标题以冒号收尾就是一句半截话。
 */
function clausesTitle(clauses: readonly string[]): string {
  const head = clauses[0]
  if (head === undefined) return ''
  const title = head.length >= 5 ? head : accumulate(clauses.slice(0, 2), 16)
  return title.length > 0 ? clipUnit(trimTail(title), TITLE_MAX) : ''
}

/** 助手叙述 → 标题（见 {@link proseClauses}）。 */
function proseTitle(prose: readonly string[]): string {
  return clausesTitle(proseClauses(prose))
}

/** 这句是不是开场白（见 {@link PROSE_OPENING}）。 */
function isOpeningLine(clause: string): boolean {
  return PROSE_OPENING.test(clause)
}

/** 助手开头短于这个长度就撑不起一个标题——`收到`、`这个模型很清晰` 都是承接上一句的衔接语。 */
const PROSE_MIN = 10

/** 段落标签：只占一行、不承载结论的标题行（`## 本轮结论`）。 */
const HEADING_LABEL = /^(?:本轮|本段|本节|以上|以下|下面|本次)?(?:结论|小结|总结|摘要|概览|概述|背景|说明|备注|附录|进展|要点|清单)$/

/** 计数空话：只说"做了几件"，不说做了什么。`三件`指哪三件只有 detail 里有，比用户原话更没信息。 */
const PROSE_VAGUE = /^(?:这?[一二三四五六七八九十两\d]+(?:件|样|个|条|项|步|件事|处)|这些|上述|以上|若干)(?:都|全|也)?(?:做|修|办|完成|处理|搞|干)/

/**
 * 对用户消息本身的确认/评价（`收到`、`这个模型很清晰`）——它是对话衔接语，不是这一轮的叙述。
 *
 * 拿它当标题，等于把"用户说了什么"换成"助手觉得用户说得对"，信息量反而更少。
 */
const PROSE_BANTER = /^(?:收到|明白了|好的|好问题|你说得?对|没错|同意|确实|这个?(?:模型|思路|想法|方案|说法|判断|设计|问题)[^，。！？]{0,14}?(?:清晰|不错|合理|聪明|很好|有效|正确))/

/**
 * 过程播报：宣布自己要汇报/总结（`我到了必须停下来汇报的节点 —— 进展很大`）。
 *
 * 和 {@link PROSE_OPENING} 同类——说的是"关于对话本身"，不是"这一轮做了什么"。
 * 实测第 38 轮就是它顶掉了用户那句更具体的"我新下载了一个说是有tts的文件"。
 */
const PROSE_BULLETIN = /^我(?:们)?[^，。！？]{0,10}(?:汇报|总结|交代|说明一下)/

/**
 * 助手那句能不能顶替用户原话（长用户消息优先助手叙述，见模块头第 8 条）。
 *
 * 五道否决，每一条都对应实测里的一类"换完更差的标题"：
 * 1. 机器残渣（`Themselfwerterrwebhttps://github.comIgn…`）——正文里夹了工具输出；
 * 2. 计数空话（`三件都做了`、`两件都修好了`）——比用户原话更没信息；
 * 3. 衔接语（`收到`、`这个模型很清晰`）与过程播报（`我到了必须停下来汇报的节点`）——
 *    说的是对话本身，不是这一轮做了什么；
 * 4. 语种跑偏（用户说中文、候选全是 ASCII，如 `All durable`）——多半是英文报告的小节残句；
 * 5. 撑不起标题的短句。
 *
 * 用户概括本身就被截断时（`cut`）只否决 1–4 里的机器残渣与空话：那时任何一句完整的人话
 * 都比半截路径强，哪怕它只有 5 个字（`预设已修复`）。
 */
function proseWorth(prose: string, head: string, userText: string, cut: boolean): boolean {
  if (prose.length === 0 || /:\/\//.test(prose)) return false
  if (PROSE_VAGUE.test(prose)) return false
  if (/[\u4e00-\u9fff]/.test(userText) && !/[\u4e00-\u9fff]/.test(prose)) return false
  if (cut) return true
  return !PROSE_BANTER.test(head) && !PROSE_BULLETIN.test(head) && prose.length >= PROSE_MIN
}

/**
 * 失败原文 → `detail`。
 *
 * 标题只说"卡在哪一类"（阻塞簇概括 / 断言名 / 助手正文），**工具自述用途与报错正文全部
 * 退到这里**：它们在 L3 里照旧可检索，留在骨架里只是噪音。上限 6 条——detail 进 L3，
 * 不是无底洞。
 */
function failDetail(turn: TurnFacts): string {
  if (turn.hard.length === 0) return ''
  return turn.hard.slice(0, 6).map((f) => {
    const desc = f.desc.length > 0 ? `「${clip(f.desc, 40)}」` : ''
    return `[失败] ${f.tool}${desc} ${f.line}`
  }).join('\n')
}

/**
 * 用户消息 → `detail`。
 *
 * 标题读的是剥离噪音后的 `text`，但**原文整段保留**：真的剥掉过东西时 `raw` 就是那一版原文，
 * 并在末尾标注剥了哪几类。这样"标题干净"与"信息不丢"两件事不冲突。
 */
function userDetail(users: readonly UserFact[]): string {
  const injected = uniq(users.flatMap((u) => u.injected ?? []))
  return [
    users.map((u) => u.raw ?? u.text).join('\n---\n'),
    injected.length > 0 ? `[标题已剥离注入噪音：${injected.join('、')}]` : '',
  ].filter((s) => s.length > 0).join('\n---\n')
}

/** 一轮对话在日志里的位置与结论。 */
interface TurnGroup {
  turn: number
  /** `turn/start` 的 seq。 */
  startSeq: number
  /** 本轮最后一条事件的 seq。 */
  endSeq: number
  /** 属于本轮的事件（不含 `turn/start` 自身）。 */
  events: EventLike[]
  /** `turn/end` 的 reason.kind；轮没闭合时为 null。 */
  end: string | null
  /** `turn/end` 的 reason.error.message。 */
  endErr: string | null
}

/**
 * 按 `turn/start` 切轮。
 *
 * `turn/start` 之前的投递/系统事件不属于任何轮，直接丢弃——它们在 `user/message`
 * 里还有副本，只有"会话第一条任务"必须单独从 `agent/inbox/spliced` 取（见
 * {@link initialTaskText}）。
 */
function groupTurns(events: readonly EventLike[]): TurnGroup[] {
  const groups: TurnGroup[] = []
  let current: TurnGroup | null = null
  for (const event of events) {
    const type = str(event.type) ?? ''
    const seq = num(event.seq) ?? 0
    if (type === 'turn/start') {
      current = {
        turn: num(rec(event.data).turn) ?? groups.length,
        startSeq: seq,
        endSeq: seq,
        events: [],
        end: null,
        endErr: null,
      }
      groups.push(current)
      continue
    }
    if (current === null) continue
    current.endSeq = seq
    current.events.push(event)
    if (type === 'turn/end') {
      const reason = rec(rec(event.data).reason)
      current.end = str(reason.kind) ?? null
      current.endErr = str(rec(reason.error).message) ?? null
    }
  }
  return groups.filter((g) => g.turn >= 1)
}

/** 一次工具调用的登记项（`tool/result` 自己不带工具名，必须按 callId 回查）。 */
interface CallInfo {
  name: string
  desc: string
}

/** 一条失败事实。 */
interface FailFact {
  seq: number
  tool: string
  desc: string
  codes: string[]
  isError: boolean
  cls: string
  level: Level
  label: string
  mods: string[]
  asserts: string[]
  line: string
}

interface VerifyFact { seq: number; desc: string; okCount: number }
interface ArtifactFact { seq: number; files: string[]; desc: string }
/**
 * 一条用户消息。
 *
 * `text` 是**剥离注入噪音后**的正文（标题与"追问/回退/转向"判定都读它）；
 * `raw` 只在真的剥掉过东西时才存原文，`injected` 记下剥了哪几类——两者都只服务 `detail`
 * （见 {@link userDetail}），保证"标题干净"不等于"信息丢了"。
 */
interface UserFact { seq: number; text: string; raw?: string; injected?: string[] }
interface CompactFact { seq: number; chars: number; shadowed: number }
interface GoalFact { seq: number; op: string; objective: string }
interface DenyFact { seq: number; tool: string; reason: string }
interface PermFact { seq: number; preset: string }
interface TodoFact { seq: number; n: number }

/** 同轮同问题类的失败簇。 */
interface Cluster {
  cls: string
  n: number
  level: Level
  label: string
  fails: FailFact[]
  seq: number
  lastSeq: number
}

/** 一轮的全部事实与派生结论。 */
interface TurnFacts {
  turn: number
  seq0: number
  seqEnd: number
  users: UserFact[]
  /** 助手正文（按时间顺序，已剥掉工具调用占位）——标题的第二个合法来源。 */
  prose: string[]
  fails: FailFact[]
  verifies: VerifyFact[]
  artifacts: ArtifactFact[]
  todos: TodoFact[]
  compacts: CompactFact[]
  goals: GoalFact[]
  perms: PermFact[]
  denies: DenyFact[]
  end: string | null
  endErr: string | null
  /** 非 noise 的失败。 */
  hard: FailFact[]
  nCalls: number
  clusters: Cluster[]
  /** 本轮最后一次"验证通过"的 seq（无则 -1）。 */
  lastVerify: number
  /** 先失败后通过。 */
  fixed: boolean
  /** 本轮验证通过的最大断言数。 */
  okCount: number
}

/** 逐轮抽取事实（只读叶子字段）。 */
function collectTurns(groups: readonly TurnGroup[], calls: ReadonlyMap<string, CallInfo>): TurnFacts[] {
  const facts: TurnFacts[] = []
  for (const group of groups) {
    const turn: TurnFacts = {
      turn: group.turn,
      seq0: group.startSeq,
      seqEnd: group.endSeq,
      users: [],
      prose: [],
      fails: [],
      verifies: [],
      artifacts: [],
      todos: [],
      compacts: [],
      goals: [],
      perms: [],
      denies: [],
      end: group.end,
      endErr: group.endErr,
      hard: [],
      nCalls: 0,
      clusters: [],
      lastVerify: -1,
      fixed: false,
      okCount: 0,
    }
    for (const event of group.events) {
      const type = str(event.type) ?? ''
      const seq = num(event.seq) ?? 0
      const data = rec(event.data)

      if (type === 'user/message') {
        if (str(rec(data.source).kind) !== 'user') continue
        // 剥离注入噪音后再判"这条消息有没有信息量"：噪音里也带问号与"是否"，
        // 不先剥掉的话，一条纯噪音消息会被当成用户追问、凭空长出一条里程碑。
        const original = messageText(data)
        const injected = stripInjections(original)
        const text = norm(injected.text)
        const bare = text.replace(/[，。！？、,.!?\s]/g, '')
        if (bare.length > 4 && !STOP.has(bare)) {
          const user: UserFact = { seq, text }
          if (injected.rules.length > 0) {
            user.raw = original
            user.injected = injected.rules
          }
          turn.users.push(user)
        }
        continue
      }

      if (type === 'assistant/message') {
        // 正文位置与 tool/result 相同（data.message.content），靠 messageBody 兜住两种形态。
        // **不在这里 norm**：标题行与正文的分行是有意义的（`## 结论\n\n正文`），先压成一行
        // 就等于把结论和正文粘成一句。
        const text = messageText(data).replace(/\[tool-call [^\]]*\]/g, '').trim()
        if (text.length > 0) turn.prose.push(text)
        continue
      }

      if (type === 'tool/result') {
        const message = rec(data.message)
        const call = calls.get(str(message.toolCallId) ?? '')
        const name = call?.name ?? 'tool'
        const desc = call?.desc ?? ''
        const text = messageText(data)
        const isError = message.isError === true
        const codes = exitCodesIn(text)
        if (isError || codes.length > 0) {
          const found = CLASSES.find(([, re]) => re.test(text))
          const mods = uniq([...text.matchAll(/No module named '([^']+)'/g)]
            .map((m) => m[1])
            .filter((s): s is string => s !== undefined))
          turn.fails.push({
            seq,
            tool: name,
            desc,
            codes,
            isError,
            cls: found?.[0] ?? 'other',
            level: found?.[2] ?? 'transient',
            label: found?.[3] ?? '其他失败',
            mods,
            asserts: assertsOf(text),
            line: clip(errorLine(text), 120),
          })
        } else {
          // 验证判定限定在执行类工具上：read 一个测试文件不是"验证通过"。
          const verifyish = /test|verify|验证|回归|断言|smoke|自检|check|检查|assert|跑测试|语法/i.test(desc)
          if (EXEC_TOOLS.has(name) && verifyish && text.length > 40
            && /(^|\s)ok(\s|$)|通过|PASS/.test(text)) {
            turn.verifies.push({ seq, desc: desc || name, okCount: (text.match(/(^|\s)ok(\s|$)/g) ?? []).length })
          }
        }
        continue
      }

      if (type === 'deliverables/presented') {
        const files = list(data.files)
        turn.artifacts.push({
          seq,
          files: files.map((f) => baseName(rec(f).path)),
          desc: norm(rec(files[0]).description),
        })
        continue
      }

      if (type === 'approval/decided') {
        const id = str(data.id)
        const asked = group.events.find((x) => str(x.type) === 'approval/asked' && str(rec(x.data).id) === id)
        if (/denied|reject/i.test(str(data.outcome) ?? '')) {
          turn.denies.push({
            seq,
            tool: str(rec(asked?.data).toolName) ?? '?',
            reason: norm(rec(asked?.data).reason),
          })
        }
        continue
      }

      if (type === 'command/run' && str(data.name) === 'permission') {
        turn.perms.push({ seq, preset: norm(data.args) })
        continue
      }

      if (type === 'todo/write') {
        turn.todos.push({ seq, n: list(data.todos).length })
        continue
      }

      if (type === 'compaction/start') {
        const summary = group.events.find((x) => str(x.type) === 'compaction/summary')
        turn.compacts.push({
          seq,
          // 摘要正文在 data.summary（content 块数组），不在 message.content ——
          // 第一轮这里读成 0 字符，压缩里程碑因此丢掉了全部规模信息。
          chars: contentToText(rec(summary?.data).summary).length,
          shadowed: num(rec(summary?.data).shadowedTokenCount) ?? 0,
        })
        continue
      }

      if (type === 'goal/change') {
        turn.goals.push({ seq, op: str(data.operation) ?? '', objective: norm(rec(data.goal).objective) })
      }
    }

    turn.nCalls = group.events.filter((e) => str(e.type) === 'tool/call').length
    turn.hard = turn.fails.filter((f) => f.level !== 'noise')
    facts.push(turn)
  }
  return facts
}

/** 同轮同问题类的失败 → 簇；并算出"先失败后通过"与断言数。 */
function clusterize(turn: TurnFacts): void {
  const byClass = new Map<string, FailFact[]>()
  for (const fail of turn.hard) {
    const bucket = byClass.get(fail.cls)
    if (bucket === undefined) byClass.set(fail.cls, [fail])
    else bucket.push(fail)
  }
  turn.clusters = [...byClass.entries()].map(([cls, bucket]) => {
    let label = bucket[0]?.label ?? '其他失败'
    if (cls === 'pydep' && bucket.flatMap((f) => f.mods).length > 0) {
      // 具体缺哪个依赖必须留在标题里：这是"下一步该装什么"的唯一线索。
      const mods = uniq(bucket.flatMap((f) => f.mods))
      label = `缺 Python 依赖：${mods.slice(0, 4).join('/')}${mods.length > 4 ? ` 等 ${mods.length} 个` : ''}`
    } else if (cls === 'assert') {
      const names = uniq(bucket.flatMap((f) => f.asserts))
      label = names.length > 0
        ? `测试断言失败：${clipUnit(names.slice(0, 2).join('；'), 30)}`
        : `测试断言失败（${bucket.length} 次）`
    } else if (cls === 'other' || cls === 'depmiss') {
      // 错误对象转储（`code: 'ERR_ASSERTION', actu…`）**不能当标题**——它是给机器看的，
      // 抽不到断言名就退化成通用标签。其余报错正文保留：`ERR_PNPM_IGNORED_BUILDS`、`boom`
      // 这类原文是"下一步该装什么"的唯一线索，换成通用标签反而丢信息。
      label = /(?:^|[^A-Za-z])code:\s*'|ERR_ASSERTION|AssertionError/.test(bucket.map((f) => f.line).join(' '))
        ? '测试断言失败'
        : clip(bucket[0]?.line ?? '', 34)
    }
    const seqs = bucket.map((f) => f.seq)
    return {
      cls,
      n: bucket.length,
      level: bucket[0]?.level ?? 'transient',
      label,
      fails: bucket,
      seq: seqs[0] ?? 0,
      lastSeq: Math.max(...seqs),
    }
  }).sort((a, b) => (b.level === 'blocking' ? 1 : 0) - (a.level === 'blocking' ? 1 : 0) || b.n - a.n)

  const lastVerify = Math.max(-1, ...turn.verifies.map((v) => v.seq))
  turn.lastVerify = lastVerify
  turn.fixed = turn.hard.length > 0 && lastVerify > Math.max(...turn.hard.map((f) => f.seq))
  turn.okCount = turn.verifies.length > 0 ? Math.max(...turn.verifies.map((v) => v.okCount)) : 0
}

// ─────────────────────── 跨轮合并（弧 / 区间）───────────────────────

/** 跨轮弧：连续整轮失败 / 连续被中止 / 同因阻塞。 */
interface Arc {
  type: 'abort' | 'turnerr' | 'blocking'
  from: number
  to: number
  turns: number[]
  dom: Cluster | undefined
  run: TurnFacts[]
}

/**
 * 找跨轮弧。
 *
 * 这是骨架里最贵的信息：5 轮整轮失败、3 轮同一个缺路由头、3 轮被用户中止——
 * 逐轮记会变成 11 行同义句，合并成 3 行才看得出"这段卡了多久"。
 */
function findArcs(facts: readonly TurnFacts[]): Arc[] {
  const arcs: Arc[] = []
  let i = 0
  while (i < facts.length) {
    const fact = facts[i]
    if (fact === undefined) break
    let j = i
    let type: Arc['type'] | null = null
    const isAbort = (k: string | null): boolean => k === 'aborted' || k === 'interrupted'
    if (isAbort(fact.end)) {
      type = 'abort'
      while (j + 1 < facts.length && isAbort(facts[j + 1]?.end ?? null)) j += 1
    } else if (fact.end === 'error') {
      type = 'turnerr'
      while (j + 1 < facts.length && facts[j + 1]?.end === 'error') j += 1
    } else {
      const dom = fact.clusters[0]
      if (dom !== undefined && dom.level === 'blocking' && !fact.fixed && fact.artifacts.length === 0) {
        type = 'blocking'
        while (j + 1 < facts.length) {
          const next = facts[j + 1]
          const nd = next?.clusters[0]
          if (next === undefined || nd === undefined || nd.cls !== dom.cls
            || next.fixed || next.artifacts.length > 0 || next.end === 'error') break
          j += 1
        }
        // 只有一轮就不算弧：单轮由逐轮规则负责。
        if (j === i) type = null
      }
    }
    if (type !== null && j > i) {
      const run = facts.slice(i, j + 1)
      arcs.push({
        type,
        from: fact.turn,
        to: facts[j]?.turn ?? fact.turn,
        turns: run.map((x) => x.turn),
        dom: fact.clusters[0],
        run,
      })
      i = j + 1
      continue
    }
    i += 1
  }
  return arcs
}

/** 连续 ≥2 轮"只有验证通过"的稳定期。 */
function findStableRuns(facts: readonly TurnFacts[]): TurnFacts[][] {
  const stable = new Set(facts
    .filter((r) => r.verifies.length > 0 && r.hard.length === 0 && r.artifacts.length === 0 && r.users.length === 0)
    .map((r) => r.turn))
  const runs: TurnFacts[][] = []
  let i = 0
  while (i < facts.length) {
    const fact = facts[i]
    if (fact === undefined || !stable.has(fact.turn)) {
      i += 1
      continue
    }
    let j = i
    while (j + 1 < facts.length && facts[j + 1] !== undefined && stable.has(facts[j + 1]!.turn)) j += 1
    if (j > i) runs.push(facts.slice(i, j + 1))
    i = j + 1
  }
  return runs
}

/** 连续两轮用户原话几乎相同（同一诉求被重复提出，例如第 43–44 轮）。 */
function findDupRuns(facts: readonly TurnFacts[], inArc: ReadonlySet<number>): Array<readonly [TurnFacts, TurnFacts]> {
  const runs: Array<readonly [TurnFacts, TurnFacts]> = []
  let i = 0
  while (i + 1 < facts.length) {
    const a = facts[i]
    const b = facts[i + 1]
    if (a === undefined || b === undefined || inArc.has(a.turn) || inArc.has(b.turn)
      || a.users.length === 0 || b.users.length === 0) {
      i += 1
      continue
    }
    const ta = cleanUserText(a.users[0]?.text).slice(0, 12)
    const tb = cleanUserText(b.users[0]?.text).slice(0, 12)
    if (ta.length >= 8 && ta === tb) {
      runs.push([a, b])
      i += 2
      continue
    }
    i += 1
  }
  return runs
}

// ─────────────────────── 任务标题 ───────────────────────

/**
 * 取会话初始任务的原话。
 *
 * **`agent/inbox/spliced` 是个陷阱，但必须读它**：53 条投递项里 52 条能在
 * `user/message` 找到同文（它是 `target:"next-turn"` 的投递副本，按轮归属读它
 * 会整体差 1 轮），**但会话第一条任务只在这里**——它早于 `turn/start`，落不进任何轮。
 * 正文在 `data.inserted[].content`（不是 `data.content`），`inserted: []` 是移除事件。
 */
function initialTaskText(events: readonly EventLike[]): string {
  for (const event of events) {
    if (str(event.type) !== 'agent/inbox/spliced') continue
    for (const item of list(rec(event.data).inserted)) {
      const entry = rec(item)
      const source = rec(entry.source)
      const role = str(entry.role) ?? str(source.role)
      const kind = str(source.kind)
      if (kind !== 'user' && role !== 'user') continue
      const text = cleanUserText(contentToText(entry.content))
      if (text.length > 0) return text
    }
  }
  for (const event of events) {
    if (str(event.type) !== 'user/message') continue
    if (str(rec(rec(event.data).source).kind) !== 'user') continue
    const text = cleanUserText(messageText(rec(event.data)))
    if (text.length > 0) return text
  }
  return ''
}

// ─────────────────────── 目标生命周期折叠 ───────────────────────

/** 目标震荡最多允许隔几轮：再远就是两段独立的震荡，不并成一条。 */
const GOAL_RUN_GAP = 3

/** 折叠后的目标操作：同轮同类已并成 1 次（`raw` 保留原始事件，次数与原文不丢）。 */
interface GoalStep {
  turn: number
  seq: number
  op: string
  objective: string
  raw: GoalFact[]
}

/** 一段目标操作序列：`merged` 表示它值得并成一条（跨轮的震荡）。 */
interface GoalRun {
  steps: GoalStep[]
  merged: boolean
}

/**
 * 同轮同类的目标操作折叠成 1 次。
 *
 * 实测第 2 轮的两次 `edit`、第 9 轮的两次 `resume` 是**同一个事件被记了两遍**
 * （工具重试/幂等重放），不是"改了两次目标"。折叠的是计数，原文仍在 `raw` 里。
 */
function foldGoalSteps(facts: readonly TurnFacts[]): GoalStep[] {
  const steps: GoalStep[] = []
  for (const turn of facts) {
    for (const goal of turn.goals) {
      const last = steps[steps.length - 1]
      if (last !== undefined && last.turn === turn.turn && last.op === goal.op) {
        last.raw.push(goal)
        continue
      }
      steps.push({ turn: turn.turn, seq: goal.seq, op: goal.op, objective: goal.objective, raw: [goal] })
    }
  }
  return steps
}

/**
 * 两次目标操作之间是否发生了"实质工作"，或者隔得太远。
 *
 * 判据只认**能切断震荡**的两样，外加距离：
 *
 * - **跨轮卡住**（≥2 轮的同一阻塞弧，{@link findArcs} 认出来的那种"卡了 N 轮"）或
 *   **上下文压缩**——两者都意味着这一段已经翻篇了。
 * - **距离**：隔了 3 轮以上还没等到下一次暂停/恢复，说明震荡中断，别把跨越 20 轮的
 *   一段正常开发粘成一行。
 *
 * 刻意**不算**打断的两样：用户消息（震荡期间用户正是在反复下达指令，实测第 12–13 轮
 * 就是同一条消息连发三遍）与单轮交付（长任务里隔一两轮就有一次，且交付自己就有条目——
 * 实测把它算成打断，一次震荡会被切成三行流水账）。
 */
function workedBetween(facts: readonly TurnFacts[], from: number, to: number, stuck: ReadonlySet<number>): boolean {
  if (to - from > GOAL_RUN_GAP) return true
  return facts.some((f) => f.turn > from && f.turn < to && (f.compacts.length > 0 || stuck.has(f.turn)))
}

/**
 * 目标操作序列 → 条目计划。
 *
 * `create`/`complete`/`clear` 各自成条（目标制的进出是真实里程碑）。`pause`/`resume`/`edit`
 * 的连续序列是同一个目标的震荡：**跨轮**时并成一条，同轮内仍逐条——同轮的不同操作是三个
 * 不同的事实，并起来反而看不出"暂停 → 恢复 → 改写"的顺序（契约测试也钉着这个映射）。
 */
function planGoalEntries(facts: readonly TurnFacts[], stuck: ReadonlySet<number>): GoalRun[] {
  const steps = foldGoalSteps(facts)
  const runs: GoalRun[] = []
  let i = 0
  while (i < steps.length) {
    const step = steps[i]
    if (step === undefined) break
    if (!GOAL_OSC.has(step.op)) {
      runs.push({ steps: [step], merged: false })
      i += 1
      continue
    }
    const group: GoalStep[] = [step]
    let j = i + 1
    while (j < steps.length) {
      const next = steps[j]
      if (next === undefined || !GOAL_OSC.has(next.op)) break
      const prev = group[group.length - 1]
      if (prev !== undefined && workedBetween(facts, prev.turn, next.turn, stuck)) break
      group.push(next)
      j += 1
    }
    runs.push({ steps: group, merged: new Set(group.map((s) => s.turn)).size > 1 })
    i = j
  }
  return runs
}

/** 震荡序列的标题：`目标反复暂停/恢复 5 次`（次数 = 折叠后的操作次数，不是状态翻转次数）。 */
function oscillationTitle(steps: readonly GoalStep[]): string {
  const ops = uniq(steps.map((s) => s.op))
    .map((op) => (GOAL_OP_CN[op] ?? op).replace(/^目标\s*/, ''))
    .join('/')
  return `目标反复${ops} ${steps.length} 次`
}

/** 震荡序列的 detail：原始 objective + 每次操作（折叠掉的那些也逐条留着）。 */
function oscillationDetail(steps: readonly GoalStep[]): string {
  const objective = steps.find((s) => s.objective.length > 0)?.objective ?? ''
  // 轮号取 step 的：`GoalFact` 只记了 op 与 objective，同轮的原始事件共用 step 的轮号。
  const events = steps.flatMap((s) => s.raw.map((g) => `第 ${s.turn} 轮 ${g.op}：${g.objective}`))
  return [objective, ...events].filter((s) => s.length > 0).join('\n')
}

// ─────────────────────── 提取 ───────────────────────

/** 内部条目：公开字段 + 排序用的 seq。 */
type Item = Milestone & { seq: number }

/** 一条里程碑的渲染行（骨架里的那一行）。 */
function renderMilestone(m: Milestone): string {
  const span = m.turnTo === undefined || m.turnTo === m.turn ? `第 ${m.turn} 轮` : `第 ${m.turn}–${m.turnTo} 轮`
  return `${span}: ${m.title} — ${m.cause}`
}

/**
 * 把会话事件流压成里程碑主线。
 *
 * 纯函数、确定性：同一份事件流永远得到同一份骨架，不调模型、不读时钟。
 *
 * @param events - 会话事件数组（`session.events` 形态，只读叶子字段）。
 * @returns 按 seq 排序的里程碑；没有可提取内容时返回空数组。
 */
export function extractMilestones(events: readonly EventLike[]): Milestone[] {
  const items: Item[] = []
  const add = (m: {
    turn: number
    turnTo?: number
    kind: string
    seq: number
    title: string
    cause: string
    detail?: string
  }): void => {
    const item: Item = {
      turn: m.turn,
      title: clip(norm(m.title), TITLE_MAX),
      cause: clip(norm(m.cause), CAUSE_MAX),
      detail: m.detail ?? '',
      category: CATEGORY_CN[m.kind] ?? m.kind,
      seq: m.seq,
      tokens: 0,
    }
    if (m.turnTo !== undefined && m.turnTo !== m.turn) item.turnTo = m.turnTo
    item.tokens = estimateTokens(renderMilestone(item))
    items.push(item)
  }

  const groups = groupTurns(events)

  // 工具名登记表：tool/result 只带 toolCallId，名字在对应的 tool/call 上。
  const calls = new Map<string, CallInfo>()
  for (const group of groups) {
    for (const event of group.events) {
      if (str(event.type) !== 'tool/call') continue
      const data = rec(event.data)
      const callId = str(data.callId)
      if (callId === undefined) continue
      let args: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(str(data.arguments) ?? '')
        args = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
      } catch {
        // 参数不是合法 JSON（流被截断等）：退化成"没有自述用途"，不影响失败判定。
        args = null
      }
      calls.set(callId, { name: str(data.name) ?? 'tool', desc: callTitle(args) })
    }
  }

  const facts = collectTurns(groups, calls)
  for (const turn of facts) clusterize(turn)

  const stableRuns = findStableRuns(facts)
  const inStableRun = new Set(stableRuns.flatMap((run) => run.map((r) => r.turn)))
  const arcs = findArcs(facts)
  const inArc = new Map<number, Arc>()
  for (const arc of arcs) for (const turn of arc.turns) inArc.set(turn, arc)
  const dupRuns = findDupRuns(facts, new Set(inArc.keys()))
  const inDup = new Set(dupRuns.flatMap(([a, b]) => [a.turn, b.turn]))

  // R0. 会话初始任务
  const taskText = initialTaskText(events)
  if (taskText.length > 0) {
    add({ turn: 1, kind: 'task', seq: -1, title: summarizeUser(taskText), cause: '会话初始任务', detail: taskText })
  }
  /**
   * 会话第一条 `user/message` 的 seq。
   *
   * 它的标题已经由上面那条「任务」条目承担（投递副本在 `agent/inbox/spliced`，
   * 同一条消息在 `user/message` 里还有一份）。逐轮条目再拿它当标题，第 1 轮就是两行同题：
   * 「第 1 轮: X — 会话初始任务」紧跟一条「第 1 轮: X — …」。轮次条目负责的是这一轮
   * *发生了什么*，指令本身由「任务」条目负责，所以逐轮条目里跳过它。
   *
   * 认的是**事件**而不是"第一条被记下的用户消息"：首句若是「继续」这类无信息量的输入，
   * 它本来就不进 `users`，此时下一条消息才是这一轮的正文，跳过它会把真指令整条丢掉。
   *
   * 只影响 R2：弧/稳定期/重复诉求三条跨轮规则仍看完整 `turn.users`。
   */
  const firstUserSeq = num(events.find((event) => str(event.type) === 'user/message'
    && str(rec(rec(event.data).source).kind) === 'user')?.seq)

  // R0b. 目标生命周期（create/complete/clear 各自成条；pause/resume/edit 的跨轮序列并成一条）
  // 「跨轮卡住」用的就是 R1 认出来的阻塞弧：单轮失败不算打断，跨轮复现才算。
  const stuckTurns = new Set(arcs.filter((a) => a.type === 'blocking').flatMap((a) => a.turns))
  for (const run of planGoalEntries(facts, stuckTurns)) {
    const first = run.steps[0]
    if (first === undefined) continue
    const last = run.steps[run.steps.length - 1]
    if (run.merged) {
      add({
        turn: first.turn,
        turnTo: last === undefined ? first.turn : last.turn,
        kind: 'goal',
        seq: first.seq,
        title: oscillationTitle(run.steps),
        cause: '任务多次中断后续跑',
        detail: oscillationDetail(run.steps),
      })
      continue
    }
    for (const step of run.steps) {
      const op = GOAL_OP_CN[step.op] ?? `目标 ${step.op}`
      // objective 为空（`clear` 常态如此）时不带冒号：`目标 clear：` 是半截话。
      const objective = clipUnit(step.objective, 32)
      add({
        turn: step.turn,
        kind: 'goal',
        seq: step.seq,
        title: objective.length > 0 ? `${op}：${objective}` : op,
        cause: GOAL_OP_REASON[step.op] ?? `operation=${step.op}`,
        detail: step.objective,
      })
    }
  }

  // R1. 跨轮弧
  for (const arc of arcs) {
    const first = arc.run[0]
    if (first === undefined) continue
    const user = first.users[0]
    const detail = userDetail(arc.run.flatMap((r) => r.users))
    if (arc.type === 'abort') {
      const instruction = user === undefined ? null : summarizeUser(user.text)
      add({
        turn: arc.from,
        turnTo: arc.to,
        kind: instruction === null ? 'interrupt' : 'user',
        seq: first.seq0,
        title: instruction ?? `连续 ${arc.turns.length} 轮被用户中止`,
        cause: `连续 ${arc.turns.length} 轮被用户中止，未完成`,
        detail,
      })
      continue
    }
    if (arc.type === 'turnerr') {
      const line = clip(errorLine(first.endErr ?? ''), 30)
      add({
        turn: arc.from,
        turnTo: arc.to,
        kind: 'fail',
        seq: first.seq0,
        title: `连续 ${arc.turns.length} 轮整轮失败：${line}`,
        cause: '同一上游错误连续复现',
        detail,
      })
      continue
    }
    const total = arc.run.reduce((sum, r) => sum + r.hard.length, 0)
    add({
      turn: arc.from,
      turnTo: arc.to,
      kind: 'fail',
      seq: arc.dom?.seq ?? first.seq0,
      title: `${clip(arc.dom?.label ?? '同一问题', 26)}，${arc.turns.length} 轮未解决`,
      cause: `${total} 次尝试未过`,
      detail,
    })
  }

  // R1b. 重复诉求合并
  for (const [a, b] of dupRuns) {
    const hard = a.hard.length + b.hard.length
    const fixed = a.fixed || b.fixed
    add({
      turn: a.turn,
      turnTo: b.turn,
      kind: 'user',
      seq: a.seq0,
      title: summarizeUser(a.users[0]?.text),
      cause: hard > 0
        ? (fixed ? '同一诉求，后续测试通过' : '同一诉求连续 2 轮排查未解决')
        : '同一诉求重复提出',
      detail: userDetail([a, b].flatMap((r) => r.users)),
    })
  }

  // R2. 逐轮里程碑
  for (const turn of facts) {
    if (inArc.has(turn.turn) || inStableRun.has(turn.turn) || inDup.has(turn.turn)) continue
    // 跳过会话第一条用户消息（见 R0 后的 firstUserSeq）：它的标题已经在「任务」条目里了。
    const users = firstUserSeq === undefined ? turn.users : turn.users.filter((u) => u.seq !== firstUserSeq)
    const user = users[0]
    const userText = user === undefined ? '' : cleanUserText(user.text)
    const isRetry = user !== undefined && RETRY.test(userText)
    const isQuestion = user !== undefined && QUESTION.test(userText)
    const isConfirm = user !== undefined && CONFIRM.test(userText) && userText.length <= 12
    const pivot = user !== undefined && !isQuestion ? PIVOT.find(([, re]) => re.test(userText)) : undefined
    const dom = turn.clusters[0]
    const blocked = dom !== undefined && dom.level === 'blocking'
    const userSum = user === undefined ? '' : summarizeUser(userText)
    const isNudge = user !== undefined && NUDGE.test(userText) && userSum.length <= 12
    const artifactDesc = turn.artifacts.find((x) => x.desc.length > 0)?.desc ?? ''
    const fileCount = uniq(turn.artifacts.flatMap((x) => x.files)).length

    const worth = turn.hard.length > 0 || turn.artifacts.length > 0 || turn.verifies.length > 0
      || turn.todos.length > 0 || turn.perms.length > 0 || turn.denies.length > 0
      || (user !== undefined && userText.length > 4)
    if (!worth) continue
    // 只有"目标里程碑 + 例行验证"的轮次不单独占一行：目标本身就是这一轮的结论。
    if (turn.goals.length > 0 && turn.hard.length === 0 && turn.artifacts.length === 0 && user === undefined) continue
    /**
     * 单次、当轮就解决的瞬时失败不记（实测第 40 轮：一次 `[eval]` 解析错误，同一轮就修好并
     * 跑通了测试）。这类事件在骨架里只会留一行"脚本解析错误"，既不是卡点也不是结论；
     * 真正带阻塞簇、交付、指令或计划的轮次不受影响。
     */
    const onlyTransient = turn.hard.length > 0 && turn.hard.every((f) => f.level === 'transient')
    if (onlyTransient && turn.fixed && user === undefined && !blocked
      && turn.artifacts.length === 0 && turn.denies.length === 0 && turn.perms.length === 0
      && turn.todos.length === 0) continue

    // ── 标题 ──
    const domTitle = dom === undefined ? '' : withAttempts(clipUnit(dom.label, 28), dom.n)
    /**
     * 助手正文有两个角色：**兜底**（没有用户指令、没有阻塞簇、没有交付时，由它说这一轮
     * 做了什么）与**顶替**（用户消息太长时，见模块头第 8 条）。
     *
     * 顶替要过三道闸：① 用户消息不是编号列表——列表概括（`提出 N 项要求`）本身已经是概括，
     * 不是截断，没有让位的理由；② 用户消息确实长（>40 字装不进标题）或概括已被截断；
     * ③ 助手那句值得顶替（见 {@link proseWorth}）。全过才换——用一句空话换掉完整的用户概括，
     * 正是"标题变短但信息变少"的来源。
     */
    const proseParts = proseClauses(turn.prose)
    const proseSum = clausesTitle(proseParts)
    const userCut = isCutSummary(userSum)
    const useProse = user !== undefined && !isListMessage(userText)
      && (userCut || userText.length > TITLE_MAX)
      && proseWorth(proseSum, proseParts[0] ?? '', userText, userCut)
    let title: string
    let kind: string
    if (blocked && user === undefined && artifactDesc.length === 0 && turn.hard.length >= 3 && (turn.hard[0]?.desc.length ?? 0) > 0) {
      // 重失败轮（≥3 次尝试、没有用户叙述）：标题仍用簇的概括，但计数取**本轮总次数**——
      // 「这一轮烧掉了 4 次尝试」比「某个簇 1 次」更接近真相。触发条件保留原样（首条失败
      // 带自述用途 = 真实命令失败），只是不再把那段自述用途搬进标题。
      title = `${clip(dom?.label ?? '同一问题', 24)}（${turn.hard.length} 次尝试）`
      kind = 'fail'
    } else if (blocked && (user === undefined || userSum.length < 6 || isConfirm || isNudge)) {
      // 阻塞簇（含断言名）优先于正文：它是"卡在哪"的唯一线索，正文只能排在它后面。
      // 曾经这里还有一条"用工具自述用途当标题"的分支（`Apply patches to 6.2 失败（4 次尝试）`），
      // 已删——工具描述不是人话，次数改由簇自己的计数承担。
      title = domTitle
      kind = 'fail'
    } else if (useProse) {
      // 长用户消息 + 有助手叙述：标题用助手的结论句，"指令"这个身份仍归用户消息
      // （分类/回退/转向判定的输入没变，变的只是标题那一句）。
      title = proseSum
      kind = pivot !== undefined ? 'pivot' : isRetry ? 'retry' : 'user'
    } else if (userSum.length > 0) {
      title = userSum
      kind = pivot !== undefined ? 'pivot' : isRetry ? 'retry' : 'user'
    } else if (artifactDesc.length > 0) {
      title = clipUnit(artifactDesc, TITLE_MAX)
      kind = 'artifact'
    } else if (proseSum.length > 0) {
      title = proseSum
      kind = 'event'
    } else if (domTitle.length > 0) {
      title = domTitle
      kind = 'fail'
    } else if (turn.artifacts.length > 0) {
      title = `交付 ${fileCount} 个文件`
      kind = 'artifact'
    } else {
      // 最后的兜底仍是验证的自述用途：没有正文可依据时，工具描述至少说明"跑了什么"。
      // 契约测试钉着这个形态（verify-only 的合成轮次要产出标题），真实会话里走不到这里。
      title = clipUnit(turn.verifies[0]?.desc ?? '例行验证', 34)
      kind = 'fix'
    }

    // ── 原因 ──
    const shortLabel = dom === undefined ? '' : clipUnit(dom.label.replace(/^测试断言失败：/, ''), 20)
    const showBlocker = kind !== 'fail' && blocked && !turn.fixed
    const out: string[] = []
    if (turn.hard.length > 0) {
      if (showBlocker) out.push(`受阻：${shortLabel}`)
      const state = turn.fixed ? (kind === 'fail' ? '当轮测试通过' : '修复并验证通过') : '未解决'
      // 「受阻」已含"没解决"之意，不再重复。
      if (!(showBlocker && state === '未解决')) out.push(state)
    } else if (turn.verifies.length > 0) {
      out.push(`验证通过${turn.okCount > 0 ? `（${turn.okCount} 断言）` : ''}`)
    }
    if (turn.artifacts.length > 0 && !title.startsWith('交付')) out.push(`交付 ${fileCount} 文件`)
    if (turn.denies.length > 0) out.push(`审批被拒 ${turn.denies.length} 次`)
    if (turn.perms.length > 0) out.push(`放权→${uniq(turn.perms.map((p) => p.preset)).join('/')}`)
    if (pivot !== undefined) out.push(`方向变更（${pivot[0]}）`)
    const endState = turn.end === 'error'
      ? `整轮失败：${clip(errorLine(turn.endErr ?? ''), 22)}`
      : (turn.end === 'aborted' || turn.end === 'interrupted') ? '轮次被中止' : null
    if (out.length === 0) {
      if (isConfirm) out.push('用户确认生效')
      else if (isQuestion) out.push('用户追问')
      else if (turn.todos.length > 0) out.push(`计划重排（${turn.todos[turn.todos.length - 1]?.n ?? 0} 项）`)
      else out.push(turn.nCalls >= 5 ? '排查中，无结论' : '仅对话，无代码变更')
    }
    // 原因最多 2 个短句（+ 必有句末状态）：骨架的信息密度靠这个上限维持。
    const trimmed = out.length > 2 ? out.slice(0, 2) : out
    if (endState !== null) trimmed.push(endState)

    add({
      turn: turn.turn,
      kind,
      seq: turn.seq0,
      title,
      cause: trimmed.join('，'),
      // 用户原话 + 失败原文：标题不承载的那部分信息（工具自述用途、报错正文、被剥离的
      // 注入噪音）在这里留下。
      detail: [userDetail(users), failDetail(turn)].filter((s) => s.length > 0).join('\n---\n'),
    })

    // 同轮出现第二个"阻塞簇"（不同问题类、≥2 次尝试）＝ 独立事件，补一条（每轮上限 2 条）。
    // 这条规则是审计逼出来的：它救回了 4 个真漏——profile 写入锁超时 ×3、sapi 孤儿进程 ×2、
    // 以及第 20/52 轮的断言失败簇（后者是"验证发现问题"，与失败不同类，必须单独可见）。
    const surfaced = new Set<Cluster>()
    if (kind === 'fail' && dom !== undefined) surfaced.add(dom)
    if (showBlocker && dom !== undefined) surfaced.add(dom)
    const extra = turn.clusters
      .filter((c) => c.level === 'blocking' && c.n >= 2 && !surfaced.has(c))
      .sort((a, b) => b.n - a.n)[0]
    if (extra !== undefined) {
      add({
        turn: turn.turn,
        kind: 'fail',
        seq: extra.seq,
        title: withAttempts(clipUnit(extra.label, 26), extra.n),
        cause: turn.lastVerify > extra.lastSeq ? '后续测试通过' : '未解决',
      })
    }
  }

  // R2b. 跨轮"持续验证通过"区间
  for (const run of stableRuns) {
    const first = run[0]
    const last = run[run.length - 1]
    if (first === undefined || last === undefined) continue
    add({
      turn: first.turn,
      turnTo: last.turn,
      kind: 'fix',
      seq: first.seq0,
      title: `持续验证通过（${run.length} 轮）`,
      cause: '稳定期，无新问题',
    })
  }

  // R3. 上下文压缩（带真实规模：摘要多少字符、遮蔽多少 token）
  for (const turn of facts) {
    for (const compact of turn.compacts) {
      add({
        turn: turn.turn,
        kind: 'compact',
        seq: compact.seq,
        title: `上下文压缩 — 摘要 ${compact.chars} 字符，遮蔽 ${compact.shadowed} tokens`,
        cause: '窗口压力触发',
      })
    }
  }

  // R4. 审批被拒
  for (const turn of facts) {
    for (const deny of turn.denies) {
      add({
        turn: turn.turn,
        kind: 'decision',
        seq: deny.seq,
        title: `审批被拒：${deny.tool}`,
        cause: clip(deny.reason, 40),
      })
    }
  }

  return items
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq: _seq, ...milestone }) => milestone)
}

/**
 * 渲染主线骨架（注入块 / L3 索引形态）。
 *
 * 行形态与可行性脚本的骨架逐字一致：`第 N 轮: 标题 — 原因`（跨轮是 `第 N–M 轮`），
 * 这样既有人读，也能被 diff 比对。
 *
 * @param milestones - {@link extractMilestones} 的输出。
 * @param taskTitle - 会话任务标题；给了就在块首点明，便于跨会话 recall 时认路。
 * @returns 注入文本；里程碑为空时仍返回块头（调用方不必判空）。
 */
export function renderMainline(milestones: readonly Milestone[], taskTitle?: string): string {
  const head = '## 里程碑主线骨架（Milestone Mainline）'
  const lines: string[] = [head]
  const title = taskTitle === undefined ? '' : norm(taskTitle)
  if (title.length > 0) lines.push(`- 任务：${clip(title, TITLE_MAX)}`)
  if (milestones.length === 0) {
    lines.push('- （本会话尚无可提取的里程碑）')
    return lines.join('\n')
  }
  lines.push(...milestones.map((m, index) => `${String(index + 1).padStart(3)}. ${renderMilestone(m)}`))
  return lines.join('\n')
}

// ─────────────────────── cause（因果）回填 ───────────────────────
//
// 提取产出的 `cause` 是**确定性标签**：`未解决`、`同一诉求连续 2 轮排查未解决`、
// `3 次尝试未过`。它们回答的是"成没成"，不是"为什么"——于是第 22→23→25 轮的回退
// 在骨架里只剩三行"未解决"，读者不知道 `TransparencyKey` 为什么会破坏鼠标命中，
// **而那正是那三轮回退的因果链**。这一节是补上"为什么"的入口：候选挑选、请求渲染、
// 宽容解析、回填。真正的模型调用在 index.ts（本模块是纯函数，不碰任何 service）。

/**
 * `cause` 的字符上限：20。
 *
 * 比标题（40）短一半是刻意的：它是一句因果，不是第二句标题。它挂在每一条里程碑
 * 后面，50 条骨架就是约 1,000 token 的固定开销——再长，骨架就从"一眼看完"变成
 * "要读两遍"，而读者要的只是一句"为什么会这样"。
 */
export const CAUSE_CHARS = 20

/**
 * 每条里程碑随请求发出的 `detail` 摘录**默认**字符数（配置键 `mainlineCauseExcerptChars`）。
 *
 * 这个数曾经是 **120，那是错的**，而且错因不是"短"而是"短加错地方"。用真实会话
 * （53 条里程碑、25 行 `[失败]`）量过：
 * - `detail` 的构成是"用户原话行 + `[失败]` 行 + `[image]` 占位 + `---` 分隔"；
 *   `[失败]` 行由 `failDetail` 渲染成 `[失败] {tool}「{desc}」 {line}`，而
 *   `{desc}` 是**工具自述用途**（`Probe healing with dummy API key` 这类）——
 *   按模块约定它"只进 detail"，但它恰好占据每条失败行的开头，实测平均吃掉 41 码点。
 * - 120 字下：25 行 `[失败]` 只有 **8 行**的报错正文能完整出现在摘录里；
 *   160 字下是 16 行，200 字下才是 25 行全部。
 * - 更糟的是"抓错摘录"：第 5 轮的因果本该是"用无效 key 探测认证恢复"（那正是
 *   工具自述），120 字把自述切掉、只留下 `AUTH: Authentication Fails ... is invalid`，
 *   模型于是把它读成"dummy key 无效致认证失败"——**原因写成了现象**。
 *
 * 200 的取法有两条依据（都是实测数字，不是感觉）。用真实会话（53 条里程碑 / 25 行
 * `[失败]`）量了三个方案：
 *
 * | 方案 | 信号保留率 | `[失败]` 正文完整可见 | 一批 20 条成本 |
 * | --- | --- | --- | --- |
 * | 取开头 120（旧默认） | 78% | 11/25 | 1,491 token |
 * | **取开头 200（本默认）** | **88%** | **25/25** | **1,850 token** |
 * | 取开头 240 | 84% | 25/25 | 2,038 token |
 *
 * 1. **够装下一条完整的失败行**：25/25 行完整可见，而不是 8–11/25——这正是"原因写成
 *    现象"的直接来源（第 5 轮把 `AUTH ... is invalid` 读成"dummy key 无效致认证失败"，
 *    而真实原因是**用无效 key 做的探测**）。
 * 2. **成本可接受**：默认批量（20 条 × 200 字）的请求体实测 1,855 token，比 120 的
 *    1,491 token 净增约 364 token／次——而这条调用是节流的（`mainlineCauseMinBatch`
 *    攒够一批才发一次）。再往上加（240）成本涨 183 token 而信号反而降到 84%，
 *    所以 200 是这条曲线上的拐点，不是随手取的一个数。
 */
export const CAUSE_EXCERPT_CHARS = 200

/**
 * 摘录字符数的**上限**（配置键 `mainlineCauseExcerptChars` 的钳制上界）。
 *
 * 与默认值一起放在这里而不是写死在 config-core：范围与默认值只该有一处真源，
 * 渲染器（本模块）与配置归一（config-core）共用同一对常量，改一处就够。
 */
export const CAUSE_EXCERPT_MAX = 500

/** 里程碑的稳定键：轮次区间（`turn:turnTo`）。L3 的里程碑记录就是按这个键去重的。 */
export function milestoneKey(m: Milestone): string {
  return `${m.turn}:${m.turnTo ?? m.turn}`
}

/**
 * cause 缓存的键：轮次区间 + 标题。
 *
 * 为什么不只用 {@link milestoneKey}：同一个区间可能对应**两条**里程碑——第 1 轮的
 * 「任务」与第 1 轮的逐轮条目都落在 `1:1`，只用区间会让它们共用一句因果（而它们说的
 * 是两件事）。带上标题即可分开；标题变了说明这条里程碑的陈述本身变了，那时重新问
 * 一次因果反而是对的。
 */
export function causeCacheKey(m: Milestone): string {
  return `${milestoneKey(m)}#${m.title}`
}

/** 一个待补 cause 的位置。 */
export interface CauseSlot {
  /** 它在**完整骨架**里的 1-based 序号（与 L3 落库顺序同源；注意注入块裁剪后行号会重排）。 */
  index: number
  milestone: Milestone
}

/**
 * 挑出还缺 cause 的里程碑。
 *
 * 判据是"**没有**被 LLM 补过"（`known` 里没有这个键），而不是"cause 为空"——
 * 提取总会给一个确定性标签，按"空"判等于永远不缺。
 *
 * @param milestones - 当前骨架。
 * @param known - 已经补过的 cause（键为 {@link causeCacheKey}）。
 * @returns 按骨架顺序排列的待补位置。
 */
export function missingCauses(
  milestones: readonly Milestone[],
  known: ReadonlyMap<string, string>,
): CauseSlot[] {
  const slots: CauseSlot[] = []
  milestones.forEach((milestone, i) => {
    if (known.has(causeCacheKey(milestone))) return
    slots.push({ index: i + 1, milestone })
  })
  return slots
}

/**
 * 工具自述的剥离：`[失败] pwsh「Probe healing with dummy API key」 报错正文` → `[失败] pwsh 报错正文`。
 *
 * **为什么只剥引号段、保留工具名**：引号里的是工具**自述用途**（`callTitle(args)` 的产物，
 * 按模块约定"只进 detail"），实测平均占 41 码点——它是摘录里最大的一块噪音，而且
 * 占的正是每行最宝贵的开头。工具名（`pwsh` / `send_message`）只占几个字符，却是
 * "这条失败来自哪一类动作"的锚，剥掉反而更难读。
 *
 * 必须**只剥第一对**引号：报错正文里也有引号（`active teammate "…" not found`、
 * `api key: ****real is invalid`），把整行所有引号段都当自述剥掉会把正文切成碎片。
 * 引号段限长 80：超长的不可能是自述用途（那是被当成参数值粘进来的正文）。
 */
const FAIL_TOOL_DESC = /^(\[失败\]\s*\S+)\s*(?:「[^」]{0,80}」|“[^”]{0,80}”|"[^"]{0,80}")(\s*)/
/** 纯 `[image]` 占位行（可能连着好几个）——折叠成一枚，不占 4 个字符 ×N。 */
const IMAGE_ONLY_LINE = /^(?:\[image\]\s*)+$/

/** `userDetail` 末尾的剥离标注：对"为什么"没有信息量，是纯噪音。 */
const INJECT_NOTE_LINE = /^\[标题已剥离注入噪音[：:].*\]$/

/**
 * 把 `detail` 拆成**摘录用的行**：单行化 → 去重 → 折叠图片占位 → 去掉纯标注 → 剥工具自述。
 *
 * 这一步是"摘录里全是噪音"这条修复的主体，每一小步都对应一处实测噪音：
 * - **去重**：真实 `detail` 里有完全重复的行（第 12–13 轮的同一句用户诉求出现两次、
 *   第 16–17 轮整段重复），实测 4/53 条里程碑共浪费 372 码点——那是预算的 3 倍。
 * - **折叠 `[image]`**：第 8–11 轮的摘录前 24 个字符是 `[image] [image] [image] `，
 *   零信息却占掉了整个窗口的 20%。
 * - **去掉剥离标注**：`[标题已剥离注入噪音：图片占位]` 只在解释标题为什么干净。
 * - **剥工具自述**：见 {@link FAIL_TOOL_DESC}，省下平均 41 码点／失败行。
 *
 * @param detail - 里程碑的 `detail`。
 * @returns 处理后的行（已 trim，可能为空数组）。
 */
function excerptRows(detail: string): string[] {
  const seen = new Set<string>()
  const rows: string[] = []
  for (const raw of detail.split('\n')) {
    let line = norm(raw)
    if (line.length === 0 || line === '---') continue
    if (INJECT_NOTE_LINE.test(line)) continue
    if (IMAGE_ONLY_LINE.test(line)) line = '[image]'
    if (line.startsWith('[失败]')) {
      // 再 norm 一次：剥掉自述后原位置的空白会留下双空格（`[失败] pwsh  AssertionError`），
      // 那是纯粹的 token 浪费，也不好看。
      line = norm(line.replace(FAIL_TOOL_DESC, '$1$2'))
    }
    if (seen.has(line)) continue
    seen.add(line)
    rows.push(line)
  }
  return rows
}

/**
 * 按**码点**截到 n 个字符，并收干净尾部。
 *
 * 两件事都必要：
 * - 按码点而不是 UTF-16 单元：`'😀'.slice(0, 1)` 会切出半个代理对，孤立代理项进请求
 *   只会变成乱码（甚至让整段 JSON 变形）。
 * - 收尾：如果切点落在一个 ASCII token 中间（`…dsh-tri-layer-memory\profile-recovery\`），
 *   退到最后一个句读/空白/token 边界；一个边界都没有（长路径、长英文）时才按码点硬切
 *   ——"没有完美边界"不是"整段丢掉"的理由，但也不该切出半个词。
 *
 * **`n` 是正文额度、不含省略号**（返回值最多 `n + 1` 个码点）。这与旧实现的
 * `slice(0, n) + '…'` 同口径：调用方按"limit 是正文长度"配的，改成含省略号会让
 * 每一条都少一个字。
 *
 * @param text - 已单行化的文本。
 * @param n - 正文的码点上限。
 * @returns 截好的文本（未截断时原样返回，不带省略号）。
 */
function clipPoints(text: string, n: number): string {
  const points = [...text]
  if (points.length <= n) return text
  const limit = Math.max(1, n)
  // 从右往左找最长的合法切点：切得越靠右丢得越少。
  for (let i = limit; i >= 1; i -= 1) {
    const prev = points[i - 1] ?? ''
    const next = points[i] ?? ''
    // 切在句读/空白之后，或切在一个 ASCII token 之外（两个字符至少有一侧不是 token 字符）。
    if (UNIT_END.test(prev) || !TOKEN_CHAR.test(prev) || !TOKEN_CHAR.test(next)) {
      const head = trimTail(points.slice(0, i).join(''))
      if (head.length > 0) return `${head}…`
    }
  }
  return `${trimTail(points.slice(0, limit).join(''))}…`
}

/**
 * 取 `detail` 的一小段摘录：**行级清洗** → 拼成一行 → 按码点截断（收干净边界）→ 加省略号。
 *
 * **单行化不是审美**：请求的解析格式是"一行一条里程碑"，`detail` 里的换行（用户原话之间
 * 是 `\n---\n`、失败原文是逐行 `[失败] …`）一旦漏进请求，模型看到的行数就对不上序号，
 * 而回填只认序号——错位会直接把 A 条的因果写到 B 条上。所以换行统一折成空格。
 *
 * **为什么不做"逐行分配预算"**（这是一个被实测否掉的方案，写在这里免得后人再试一遍）：
 * 直觉上"每行都给一点额度"能让更多行被看见，但真实会话（53 条里程碑 / 25 行 `[失败]`）
 * 量下来它更差——
 * | 方案 | 信号保留率 | [失败] 正文完整可见 | 一批 20 条成本 |
 * | --- | --- | --- | --- |
 * | 取开头 120（旧默认） | 78% | 11/25 | 1,491 token |
 * | 取开头 200（本实现） | **88%** | **25/25** | **1,855 token** |
 * | 逐行分配 @200 | 79–81% | 25/25 | 1,879 token |
 * 逐行分配把 6 行各切成 40 字碎片，行数变多了，但**每行都不完整**——而模型要从"这一行
 * 在说什么"读出因果，一个被切成两半的报错比一行完整的报错更难用。同一个 200 字的预算，
 * 全部给第一行能换来一个完整句子。所以这里刻意取开头，把行级清洗省下来的额度
 * （去重 372 码点 + 图片占位折叠 + 工具自述平均 41 码点/失败行）全部留给**前面几行**。
 *
 * 已知边界：真正的原因若落在第 3 行之后，200 字仍然够不到。这是"一条摘录"的固有上限，
 * 由 `mainlineCauseExcerptChars` 暴露给用户（上限 500），而不是靠切碎每一行来假装覆盖。
 *
 * @param detail - 里程碑的 `detail`（用户原话 / 报错原文，可能很长、可能含换行）。
 * @param limit - 摘录正文的字符上限；`0` 或负数表示不摘录。
 * @returns 单行摘录；不摘录或 `detail` 为空时返回空串（调用方据此退回只发标题）。
 */
export function causeExcerpt(detail: string, limit: number): string {
  const n = Number.isFinite(limit) ? Math.trunc(limit) : 0
  if (n <= 0) return ''
  const flat = excerptRows(detail).join(' ')
  if (flat.length === 0) return ''
  return clipPoints(flat, n)
}

/**
 * 一条里程碑实际进请求的摘录：{@link causeExcerpt} 的结果，外加**角色标注**（必要时）。
 *
 * 只在一种形状上加标注：**摘录里 100% 是 `[失败]` 行**，且**标题不讲失败**
 * （见 {@link titleReportsFailure}）。这是"报错被当成因果"最毒的形状——模型手里
 * 除了一条工具报错没有任何别的证据，而标题还在说这一轮是顺利的，于是报错就成了
 * 唯一能写的东西。真实会话第 32/35 轮就是逐字这个形状。
 *
 * 为什么**不**在这种形状下干脆不发摘录：`excerptChars = 0`（只发标题）是**已知会编**的
 * 旧行为——模型手里没证据时不会说"不知道"，而是编一个听起来合理的原因。摘录是加法，
 * 这里要做的是给它**定性**，不是把它拿掉。
 *
 * 反过来，只要摘录里有任何一条非 `[失败]` 行（用户原话、结论、交付描述），就不加标注：
 * 那种情况下模型有真实的上下文可用，报错行是**配角**，标注反而是噪音。
 *
 * @param title - 里程碑标题（判据的输入）。
 * @param detail - 里程碑的 `detail`。
 * @param limit - 摘录正文的码点上限。
 * @returns 可能带 {@link CAUSE_ERROR_ONLY_NOTE} 前缀的单行摘录；空 detail 时是空串。
 */
function causeEvidence(title: string, detail: string, limit: number): string {
  const excerpt = causeExcerpt(detail, limit)
  if (excerpt.length === 0) return ''
  if (titleReportsFailure(title)) return excerpt
  const rows = excerptRows(detail)
  if (rows.length === 0 || !rows.every((row) => row.startsWith('[失败]'))) return excerpt
  return `${CAUSE_ERROR_ONLY_NOTE}${excerpt}`
}

/**
 * 补 cause 的请求体：序号 / 轮次 / 标题，外加每条 `detail` 的一小段摘录。
 *
 * **摘录是修掉"编造因果"的那一半**：早先只发标题，模型手里没有证据，就只能从标题猜
 * 因果——标题信息够的猜得对（「link 安装无法解析依赖」），信息不够的就编一个**听起来
 * 合理**的：第 1 轮的真实原因是"用户提出任务"，被写成"插件机制未初始化"；第 19 轮
 * 「你跑一半死了」被写成"新会话模式切换正常"；第 22 轮被写成"预设参数覆盖了默认值"。
 * 那比原来的机械标签更糟——它是**自信地错**。摘录把"猜"变成"读"。
 *
 * 另一半在 {@link CAUSE_INSTRUCTION}：光给证据还不够，必须同时明确允许模型说
 * "原因不明"，否则它仍然会为了交差而补一个合理的故事。
 *
 * `excerptChars = 0` 退回旧行为（只发标题）——**这条退路必须留着**：摘录是纯粹的加法，
 * 有人就是要把这次调用的输入压到最小（省 token、省按输入计费的钱、或自建网关的上下文很窄），
 * 关掉它得到的必须仍是一个**完整可用**的请求（序号 / 轮次 / 标题都在），而不是残缺的请求。
 * 配置键 `mainlineCauseExcerptChars` 的取值范围因此从 0 起，而不是从 1 起。
 *
 * 体积（两个旋钮各自都被钳制，因此请求有界；下面的是**实测值**，样本是真实会话的
 * 53 条里程碑 / 25 行 `[失败]`）：
 * - 单条上限 = 标题 ≤40 + 摘录 ≤(limit+1)（截断时多一个省略号）+ 结构（序号 / 轮次 /
 *   两个分隔符）≈20；摘录带角色标注时再 +{@link CAUSE_ERROR_ONLY_NOTE} 的 14 码点
 *   ——标注**每条最多一个**，所以它给请求加的是 13×批大小 这个上界，不是无界项。
 * - 默认（`mainlineCauseMaxPerCall` 20 × `mainlineCauseExcerptChars` 200）：一批 20 条
 *   实测 3,383 字符 ≈ **1,850 token**（本模块 `estimateTokens` 口径）。旧默认 120 是
 *   1,491 token／批——净增约 360 token／批，换掉的是"原因写成现象"这类**自信地错**。
 * - 角色标注全批都触发的**最坏**情形（20 条都是"摘录 100% 是 `[失败]` 行 + 标题不讲失败"）：
 *   再 +280 码点 ≈ **+280 token／批**。真实会话（56 条里程碑）里这种形状只有 3 条，
 *   所以实测是：默认批（前 20 条）3,383 → 3,397 码点（**+14 token**），
 *   整骨架 56 条一次补满 6,242 → 6,284 码点（**+42 token**，+0.67%）。
 * - 指令段本身从约 600 码点长到 795 码点（+195 token／**次调用**，不是每行）。
 * - 全骨架 53 条一次补满（`mainlineCauseMaxPerCall` 拉到 100 的极端）：6,247 字符 ≈ 1,562 token。
 * - 两个旋钮都拉到最大（100 × 500）：54,083 字符 ≈ 24K token（中英混排）/ 56K（纯中文上界）。
 *   那是**用户显式选出来的组合**（默认值的约 15 倍），且仍与 L2 摘要调用同量级——摘要发的是
 *   整段溢出正文，比这个长得多。所以它是"贵"，不是"失控"：不会超过宿主上下文窗口，
 *   也不会让解析失效（回填只认序号，尾部被截断只损失后面几条，见 {@link parseCauseReply}）。
 *
 * @param slots - {@link missingCauses} 的输出（调用方已按单次上限截断）。
 * @param excerptChars - 每条附带的 `detail` 摘录字符数；`0` = 只发标题（旧行为）。
 *   超出 {@link CAUSE_EXCERPT_MAX} 会被夹住（配置路径已经夹过一次，这里对直接调用者兜底）。
 * @returns 每行一条里程碑的请求正文。
 */
export function renderCauseRequest(
  slots: readonly CauseSlot[],
  excerptChars: number = CAUSE_EXCERPT_CHARS,
): string {
  const limit = Math.min(
    CAUSE_EXCERPT_MAX,
    Math.max(0, Number.isFinite(excerptChars) ? Math.trunc(excerptChars) : 0),
  )
  return slots.map(({ index, milestone }) => {
    const span = milestone.turnTo === undefined || milestone.turnTo === milestone.turn
      ? `第 ${milestone.turn} 轮`
      : `第 ${milestone.turn}–${milestone.turnTo} 轮`
    const head = `${index}. ${span}｜${milestone.title}`
    const excerpt = causeEvidence(milestone.title, milestone.detail, limit)
    // detail 为空（有些里程碑只有标题，没有正文）时不追加空的「｜摘录：」——那只是噪音。
    return excerpt.length === 0 ? head : `${head}｜摘录：${excerpt}`
  }).join('\n')
}

/**
 * 补 cause 的指令段。
 *
 * 各条要求分别对应一种实测会毁掉结果的模型行为：写成"未解决"（等于没补）、复述标题
 * （骨架变成两遍同一句话）、输出解释性散文（解析不到）、**凭标题编一个听起来合理的
 * 因果**（最隐蔽的一种：它读起来毫无破绽，却是错的）。所以要求里同时给了**反例**、
 * **字数上限**、**唯一的输出形态**，以及一条明确的许可——**摘录不足以判断时就写
 * 「原因不明」**。
 *
 * 那条许可是治本的一半：只给证据、不说"可以不知道"，模型仍会为了交差而编。给了
 * 许可之后，"原因不明"是一个**诚实的**答案，而不是一次失败——它至少不会把读者
 * 引到一条不存在的因果链上（第 1 轮的"插件机制未初始化"就是这么来的）。
 *
 * 第二条许可是后来补的，对应另一类真实误读（**原因写成现象**）：第 5 轮的摘录里是
 * `AUTH: Authentication Fails ... is invalid`，模型就写"dummy key 无效致认证失败"——
 * 而那其实是一次**故意用无效 key 做的探测**（工具的用途自述就在同一行里），
 * 失败是预期的。所以指令必须说清：这一轮已经"过了"的时候，摘录里的报错要么是
 * 故意的探针、要么已经被修掉，它**不是**这一轮的因果。
 *
 * 第三条（下面这两段）是第三次补，治的是**同一类错误的另一半**：上面那条只覆盖了
 * "标题显示已经过了/修好了"，而真实会话里漏掉的是**标题显示这一轮顺利**的情况——
 * 第 31/32/35 轮的标题是"位置是在对话和轨迹的旁边，然后开始完成任务"/"两份研究都在推进"/
 * "移植完成，修复轮在跑"，摘录里只有一条 `active teammate "…" not found`（给已经结束的
 * 子代理发消息），三条 cause 被写成同一句"目标子代理已不存在"。
 *
 * 三条一起看，缺的是一条**一般判据**：报错只说明"当时发生了什么"，说明不了"为什么会这样"；
 * 只有当报错与标题**指的是同一件事**时它才算因果。所以新加的规则不再列举"什么时候不算"，
 * 而是先给定性（`[失败]` 行是**证据**，不是默认答案），再给可操作的判据（标题在讲失败/
 * 卡住 → 这条报错可能就是它卡在哪；标题是一句顺利的进展陈述 → 同轮的报错是**同时发生的
 * 另一件事**），最后堵掉这次泄漏的具体形态（把报错原文翻译成一句原因）。
 */
export const CAUSE_INSTRUCTION = [
  '上面是一个开发会话的主线里程碑，每行形如「序号. 轮次｜标题」，部分行后面跟着「｜摘录：…」。',
  '「摘录」是该条里程碑对应的用户原话或报错原文（已去重、已去掉工具自述），**可能被截断**，是你判断原因的证据。',
  '请为每一条补一句「为什么」——不是「做没做成」，而是**这件事为什么会这样**：',
  '哪个改动破坏了什么、报错的根因是什么、为什么要回退或换方案。',
  '**依据标题与摘录判断，不要编**：摘录没给、或从摘录里看不出因果时，直接写「原因不明」。',
  '你写的每个原因都必须能在标题或摘录里**指出出处**；指不出出处就写「原因不明」。',
  '**摘录里的报错只说明"当时发生了什么"，说明不了"为什么会这样"**——它是证据，不是默认答案。只有当报错与标题**指的是同一件事**时才算因果：标题在讲失败/卡住/没修好，而这条报错正是它卡在哪。',
  '**标题是一句顺利的进展陈述时（"X 在推进"、"X 完成"、"交付了 N 个文件"），同轮的报错是同时发生的另一件事**，不是这一轮的因果——尤其是"给已经结束的子代理发消息失败"、"某个 id/文件不存在"这类与标题无关的报错。摘录被标注了「本轮工具报错，未必是原因」时同样如此。那种情况请写「原因不明」。',
  '**不要把报错原文翻译成一句原因**：报错说"某个东西不存在"≠"这个东西不存在导致了这个里程碑"。标题显示已经过了/修好了时也一样，那报错可能是一次故意的探测、或后来被修掉的东西。',
  '「原因不明」是可接受的答案；凭标题猜一个听起来合理的原因是错的——宁可说不知道。',
  '硬性要求：每条 ≤20 个字符，一句话，不复述标题，不用句号收尾。',
  '只输出一个紧凑 JSON 对象，键是序号（字符串），值是原因：',
  '{"3":"TransparencyKey 破坏鼠标命中","7":"原因不明"}',
  '不要输出解释、前后缀、markdown 代码围栏或任何多余文字。',
].join('\n')

/** 请求回显的形态（`1. 第 22 轮｜标题`）：模型抄输入时不能把它当成一条 cause。 */
const ECHOED_LINE = /｜|\|\s*第\s*\d|^第\s*\d+\s*[–-]?\s*\d*\s*轮\s*[:：]/

/**
 * 标题是不是**在讲"失败/卡住"这件事本身**（而不是一句顺利的进展陈述）。
 *
 * 这是"工具报错被当成因果"这条修复的判据：`[失败]` 行是不是这一轮的因果，取决于
 * **标题在讲什么**，而摘录本身给不出这个信息。
 *
 * 用真实会话（`session-5b59b635`，56 条里程碑 / 10 条"标题非失败但摘录含 `[失败]`"）
 * 校准过这条判据的两端：
 * - 必须**不匹配**：`两份研究都在推进`、`移植完成，修复轮在跑`、
 *   `位置是在对话和轨迹的旁边，然后开始完成任务`——这三条就是本修复要治的那三条
 *   （它们的摘录里只有 `active teammate "…" not found`，模型把它写成了因果）。
 * - 必须**匹配**：`你跑一半死了`（第 21 轮）。它的摘录里是
 *   `FAIL client inject 声明 slots + settings`，而**那条报错正是这一轮的因果**
 *   （真实落库 cause = `client inject声明契约不符`）。判据若把它也算成"非失败标题"，
 *   就会给一条**本来正确**的因果加"未必是原因"，等于把已经修好的那一条重新弄坏。
 *   所以口语化的症状词（死/挂/卡住）必须在表里，不能只收"失败/错误"这类书面词。
 *
 * 刻意**不**收"修复/改用/改为"：它们描述的是动作，不是症状；`修复并验证通过` 这类标题
 * 的因果往往在用户原话里，不在报错行里。
 */
const TITLE_FAILURE = /失败|错误|报错|异常|崩溃|崩|卡住|卡死|卡在|挂了|挂住|死|超时|中止|中断|未解决|未修|未过|不通|不行|被拒|拒绝|退出码|无响应|not found|error/i

/**
 * 标题是否在讲失败/卡住（见 {@link TITLE_FAILURE}）。
 *
 * 导出是为了让契约测试能直接钉住判据的两端，而不是靠"渲染出来的字符串里有没有那句话"
 * 间接推断——判据本身错了，渲染层的断言会一起错，看不出来。
 *
 * @param title - 里程碑标题。
 * @returns 标题在报告一次失败/卡住时为 true。
 */
export function titleReportsFailure(title: string): boolean {
  return TITLE_FAILURE.test(title)
}

/**
 * "摘录里只有工具报错、标题却是一句顺利/中性的陈述"时，给摘录加的角色标注。
 *
 * **为什么是标注而不是删掉**：真实会话里那三条（第 31/32/35 轮）的 `detail`
 * **除了报错行什么都没有**（第 32/35 轮的 detail 长度恰好 120，就是一条
 * `[失败] send_message「{agentId}」 active teammate "…" not found`）。删掉它，请求就退回
 * "只发标题"——而那正是**编造因果**的老毛病（第 1 轮的"插件机制未初始化"就是这么来的）。
 * 留着它、但说清它的身份，既不丢证据，也不让模型把它默认当成答案。
 *
 * 措辞是"未必是原因"而不是"不是原因"：标题用中性词报告症状时（`预设又没了`、`思维栏为空`），
 * 同轮的报错可能真的是因果，判据不该替模型拍板，只该提醒它**别默认**。
 *
 * 14 个码点，且只在这种形状（摘录 100% 是 `[失败]` 行 + 标题不讲失败）下出现，
 * 所以它对请求体积的影响有界（见 {@link renderCauseRequest}）。
 */
export const CAUSE_ERROR_ONLY_NOTE = '〔本轮工具报错，未必是原因〕'

/** 成对的包裹引号：逐行形态（`3. "原因"`）会连引号一起被正则捕获。 */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'], ["'", "'"], ['「', '」'], ['『', '』'],
]

/**
 * 剥掉**成对**的包裹引号。
 *
 * 必须成对判：早先按"去掉首尾引号字符"实现时，`构建产物里残留 type:'json'` 这种
 * 本身以引号结尾的 cause 会被吃掉最后一个字符（真实会话验证里当场撞上）。
 */
function stripWrappingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) return text.slice(1, -1).trim()
  }
  return text
}

/** 归一并校验一条 cause：非字符串、空、回显一律丢弃（缺席由调用方按"保持原样"处理）。 */
function pushCause(out: Map<number, string>, index: unknown, value: unknown): void {
  const at = typeof index === 'number' ? index : Number(String(index ?? '').trim())
  if (!Number.isInteger(at) || at < 1 || at > 9999) return
  // 只认字符串：数字/布尔/嵌套对象都不是一句因果（`{"3":123}` 是模型在乱写），
  // 把它们 stringify 进骨架只会给读者一个"123"。
  if (typeof value !== 'string') return
  const cause = stripWrappingQuotes(norm(value).trim()).trim()
  if (cause.length === 0 || ECHOED_LINE.test(cause)) return
  out.set(at, cause)
}

/**
 * 收一个已解析的 JSON 值：对象是 `{序号: cause}`，数组是 `[{序号, cause}]` 或 `[序号, cause]`。
 *
 * 键名不挑食（`序号` / `index` / `id` / `seq` / `turn`）：模型换个键名不该让整批作废。
 */
function collectCauses(parsed: unknown, out: Map<number, string>): void {
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (Array.isArray(entry)) {
        pushCause(out, entry[0], entry[1])
        continue
      }
      const row = rec(entry)
      pushCause(out, row['序号'] ?? row.index ?? row.id ?? row.seq ?? row.turn, row['原因'] ?? row.cause ?? row.reason ?? row.why)
    }
    return
  }
  for (const [key, value] of Object.entries(rec(parsed))) pushCause(out, key, value)
}

/**
 * 取第一段成对括号里的文本（`{...}` 或 `[...]`）。
 *
 * 逐字符跟踪深度并跳过字符串字面量：模型在 JSON 前后各写一句"好的，这是结果："是常态，
 * 直接 `JSON.parse` 整段必然失败；只切出括号段才谈得上解析。
 *
 * @param text - 模型回复原文。
 * @returns 括号段；没有成对括号（含被截断的半截 JSON）时返回 null。
 */
function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/)
  if (start < 0) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * 宽容解析模型的回复 → `序号 → cause`。
 *
 * **宽容是要求，不是美德**：这条调用是可选增强，解析失败绝不能连累骨架本身。
 * 三种形态依次尝试，先成功的胜出：
 * 1. 成对括号里的 JSON（对象 / 数组，允许前后有废话与围栏）；
 * 2. 键值对扫描（`"3": "原因"` / `'3': '原因'`）——被 `max-tokens` 截断的 JSON
 *    往往只剩完整的前几对，能救几条是几条；
 * 3. 逐行 `3. 原因` / `3、原因` / `- 3) 原因`——模型没听话但意思到了。
 *
 * 认不出的条目**直接缺席**：调用方按"缺席即保持原样"处理，因此多余键、缺项、
 * 半截输出都不会让任何一条里程碑变成空 cause。
 *
 * @param raw - 模型回复（未信任值）。
 * @returns 序号到 cause 的映射；一条都没认出来时是空 Map。
 */
export function parseCauseReply(raw: unknown): Map<number, string> {
  const out = new Map<number, string>()
  const text = String(raw ?? '')
  if (text.trim().length === 0) return out

  const block = firstBalanced(text)
  if (block !== null) {
    try {
      collectCauses(JSON.parse(block), out)
    } catch {
      // 半截 JSON：落到下面的键值对扫描。
    }
  }
  if (out.size > 0) return out

  for (const m of text.matchAll(/["']?(\d{1,4})["']?\s*[:=]\s*["']([^"'\n]{1,80})["']/g)) {
    pushCause(out, m[1], m[2])
  }
  if (out.size > 0) return out

  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]\s*)?["']?(\d{1,4})["']?\s*[.、)）:：\-—]\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    pushCause(out, m[1], m[2])
  }
  return out
}

/** 一条被回填的 cause。 */
export interface AppliedCause {
  /** 被回填的里程碑在完整骨架里的 1-based 序号。 */
  index: number
  /** 里程碑的缓存键（{@link causeCacheKey}）。 */
  cacheKey: string
  /** 实际写入的 cause（已截到 {@link CAUSE_CHARS}）。 */
  cause: string
}

/** 把一条 cause 写进里程碑并重算 token（骨架行变了，计量口径必须跟着变）。 */
function setCause(milestone: Milestone, cause: string): void {
  milestone.cause = clip(norm(cause), CAUSE_CHARS)
  milestone.tokens = estimateTokens(renderMilestone(milestone))
}

/**
 * 回填 cause。
 *
 * 序号即 {@link CauseSlot.index}（完整骨架里的 1-based 序号）：模型只看到序号，
 * 回填也必须只认序号，中间不做任何猜测性的对齐。
 *
 * @param milestones - 当前骨架（**就地**修改）。
 * @param causes - {@link parseCauseReply} 的输出。
 * @returns 实际写入的条目（调用方据此更新 L3 与缓存）。
 */
export function applyCauses(
  milestones: readonly Milestone[],
  causes: ReadonlyMap<number, string>,
): AppliedCause[] {
  const applied: AppliedCause[] = []
  milestones.forEach((milestone, i) => {
    const raw = causes.get(i + 1)
    if (raw === undefined) return
    const cause = clip(norm(raw), CAUSE_CHARS)
    if (cause.length === 0) return
    setCause(milestone, cause)
    applied.push({ index: i + 1, cacheKey: causeCacheKey(milestone), cause: milestone.cause })
  })
  return applied
}

/**
 * 把已经补过的 cause 贴回新提取的骨架。
 *
 * {@link extractMilestones} 是纯函数，每次都返回**全新对象**——不贴回去，水位一变
 * 因果就全丢回确定性标签，而 L3 里那份（唯一持久化的版本）已经改过了：两边就此分叉，
 * 同一个会话在注入里和在 recall 里长得不一样。
 *
 * @param milestones - 新提取的骨架（**就地**修改）。
 * @param known - 已补过的 cause（键为 {@link causeCacheKey}）。
 * @returns 贴回去的条数。
 */
export function attachCauses(
  milestones: readonly Milestone[],
  known: ReadonlyMap<string, string>,
): number {
  let attached = 0
  for (const milestone of milestones) {
    const cause = known.get(causeCacheKey(milestone))
    if (cause === undefined || cause === milestone.cause) continue
    setCause(milestone, cause)
    attached += 1
  }
  return attached
}
