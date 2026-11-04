/**
 * recall.ts — 统一召回入口与状态/验证工具。
 *
 * 四个模型工具：
 * - `memory_recall`（重名被占用时自动改名为 `tri_recall`）：按关键词或 id 从
 *   L3 深层记忆库精确取回，并可选附带当前 L2 摘要。
 * - `memory_state`：三层记忆的实时投影（各层读数 + 引擎仲裁 + 组件矩阵）。
 * - `memory_verify`：验证报告，逐项给出 PASS/SKIP/FAIL 与修复指引。
 * - `memory_dedupe`：清理 L3 同范围重复副本（默认 dry-run，真删前自动备份）。
 *   必须由插件自己删：外部脚本直连 sqlite 会被插件的内存快照整表覆盖回去。
 *
 * 工具定义走 `defineTool`（会做参数 schema → JSON Schema 的真实转换），
 * 因此本模块必须 import `@deepseek-ai/dsh-tools`，不能自己造一个恒等函数。
 *
 * @module dsh-tri-layer-memory/recall
 */
import { defineTool } from './platform.ts'
import type { DedupeOutcome, MemoryRecord, PruneOutcome } from './l3-deep.ts'
import { buildStatus, detectTools, componentMatrix, engineOf, arbitrateEngine, MEMORY_TOOLS, SHIPPED_COMPONENTS } from './integration.ts'

/**
 * 渲染一条记录为面向模型的文本。
 *
 * `tool` 记录必须**一眼看出是原始输出**：否则模型会把 grep/构建结果里的只言片语
 * 当成已经验证过的结论引用。警告写在正文之上（而不是只写进 kind 标签），因为
 * 读者最先扫到的是块标题与正文。
 */
function renderRecord(record: MemoryRecord, index: number): string {
  const when = new Date(record.createdAt).toISOString()
  const isTool = record.kind === 'tool'
  const heading = isTool
    ? `### [${index + 1}] ${record.id}  (tool · 工具原始输出 · turn ${record.turnFrom}–${record.turnTo} · **非结论**)`
    : `### [${index + 1}] ${record.id}  (${record.kind}, turn ${record.turnFrom}–${record.turnTo})`
  const warning = isTool
    ? '> ⚠ 这是当时工具/命令的**原始输出摘录**，不是结论，也不是已验证的事实。'
      + '引用前请自行判断；记录里写明"其余未存"的部分确实没有落库，需要时重跑命令或查原始日志。'
    : null
  return [
    heading,
    ...(warning === null ? [] : [warning]),
    `- 写入时间：${when}　估算 ${record.tokens} tokens　关键词：${record.keywords.slice(0, 8).join(', ') || '(无)'}`,
    '',
    record.text,
  ].join('\n')
}

/** 三层记忆运行时：由 index.ts 提供，工具只依赖这个窄接口。 */
export interface MemoryRuntime {
  /** 插件上下文（工具需要它做服务/工具表探测）。类型由 integration 的入口签名推断。 */
  ctx: Parameters<typeof buildStatus>[0]
  /** 当前配置的只读快照。 */
  config: () => {
    recall: { defaultLimit: number; maxLimit: number }
    l2: { inject: boolean }
    l3: { dir: string; enabled: boolean }
  }
  /** recall 工具的最终名字与决策原因。 */
  recallTool: () => { name: string; reason: string }
  /** L3 检索。 */
  search: (query: string, limit: number) => MemoryRecord[]
  /** 按 id 精确取回。 */
  get: (id: string) => MemoryRecord | undefined
  /** L3 统计。 */
  stats: () => {
    count: number
    tokens: number
    backend: string | null
    oldest: number | null
    newest: number | null
    tools: number
    toolTokens: number
  }
  /** 当前会话的 L2 摘要文本（无摘要时为 null）。 */
  digestText: (session: unknown) => string | null
  /** 当前会话各层读数（memory_state 用）。 */
  readings: (session: unknown) => {
    l1: { retainTurns: number; hotTurns: number; totalTurns: number; evictedTurns: number; tokens: number; charCount?: number }
    l2: {
      enabled: boolean
      mode: string
      covered: string | null
      tokens: number
      via: string | null
      pendingTurns: number
      /**
       * 本该走模型却退回抽取式的原因；正常时为 null。
       *
       * 类型刻意与 `l2-render.ts` 的 `DigestFailure` 同形而不 import 它：recall 是
       * 工具层，不该把记忆层的内部类型拖进来（也用不着）。
       */
      failure?: { stage: string; message: string } | null
      /** llm seam 实际命中的获取路径：inject / get / none。 */
      llmSource?: string
      /**
       * 这份 llm 摘要撞过输出上限、按行/句边界裁过但**仍在用**。
       *
       * 与 `failure` 是两件事：`failure` 是"没走成模型"（退回抽取式），这个
       * 是"走了模型、产物被裁过尾巴"。混在一起读会把可用的摘要当成故障。
       */
      truncated?: boolean
      /**
       * 上一次摘要调用的读数（成功/截断/失败都有）。
       *
       * 截断故障的定性全靠它：`finish` 是终止原因实际值，`maxTokens` 是请求里
       * 真发出去的上限，`outputChars` 是**丢弃前**的正文长度（0 = 推理吃光了预算），
       * `usage` 是 provider 上报的用量原样（推理 token 的真相在这里）。
       * 同样刻意与 `l2-render.ts` 的 `DigestAttempt` 同形而不 import。
       */
      attempt?: {
        finish: string
        maxTokens: number
        inputChars: number
        inputTokens: number
        outputChars: number
        usage?: unknown
        salvaged: boolean
        droppedChars: number
        boundary: string
        reasoningEffort: string
        effortRetry: boolean
        firstFailure?: string
      } | null
    }
    /**
     * L3 读数。两个口径都必须报：`library*` 是跨会话共享的整库规模，
     * `session*` 是**本会话**写进去的量——只给整库会被读成"本会话有这么多"。
     */
    l3: {
      enabled: boolean
      backend: string | null
      libraryCount: number
      libraryTokens: number
      /** 工具细节池条数（独立上限，不计入 l3MaxRecords）。 */
      toolCount: number
      /** 工具细节池 token。 */
      toolTokens: number
      sessionCount: number
      sessionTokens: number
      dir: string
      /**
       * 重复读数：同一 `(sessionId, kind, turnFrom, turnTo)` 有 ≥2 条副本的组数，
       * 以及可删条数。**这是"库里有垃圾"唯一的观察面**——没有它时，去重只能靠
       * 外部脚本 dry-run，而那个脚本必须在宿主关闭时才能安全跑。
       */
      duplicateGroups?: number
      duplicateRecords?: number
      /** 其中正文不一致的组数（去重会保留最长的那条，值得人看一眼）。 */
      duplicateDifferingGroups?: number
    }
    injection: {
      budgetTokens: number
      usedTokens: number
      requestedTokens: number
      dropped: string[]
      truncated: string[]
      /**
       * 含骨架的**实际**注入合计（与诊断文件的 `injection.totalInjected` 同源）。
       *
       * 与 `usedTokens` 的分工：那个只覆盖仲裁层（L1/L2/L3），骨架走独立上限、
       * 不进仲裁却确实注入。只给前者时，"本轮投影用了多少"会系统性偏小。
       */
      totalInjected?: number
      /** 骨架块的渲染后 token（独立于仲裁预算）。 */
      mainlineTokens?: number
    }
    recallTool: { name: string; reason: string }
    /** 主线骨架读数（含 cause 回填的失败原因与调用读数）。 */
    mainline?: {
      enabled: boolean
      milestones: number
      pendingCauses: number
      causeFailure: { stage: string; message: string } | null
      /**
       * 上次 cause 回填调用的读数（与 L2 的 `attempt` 同形）。
       *
       * 为什么必须带上：这条调用与 L2 摘要走同一条 seam、同一个模型，因此"推理吃光
       * 预算"是它唯一会**静默**失效的方式——它已经这么失效过（诊断里只有
       * `cause reply carried no parsable entries (0 chars)`，看不出 0 字符是推理还是
       * 模型没说话）。`finish` 与 `outputChars` 一起读才能定性。
       */
      causeAttempt?: {
        finish: string
        maxTokens: number
        inputChars: number
        outputChars: number
        usage?: unknown
        salvaged: boolean
        reasoningEffort: string
        effortRetry: boolean
        firstFailure?: string
      } | null
    }
  }
  /** 主动触发一次剪枝（verify 用）；用该会话的 L1 窗口作为任务链关键词来源。 */
  prune: (session: unknown) => PruneOutcome
  /**
   * 清理 L3 重复副本。
   *
   * 必须是**同一个 store 实例**上的操作：它改内存快照、再由同一后端的 `replace`
   * 落盘。外部脚本直接开库删行会让插件内存里的旧快照在下一次写盘时把删掉的副本
   * 写回来——2026-10 的事故就是这么丢数据的（详见 l3-deep.ts 的 `dedupe`）。
   */
  dedupe: (input: { dryRun?: boolean; sessionId?: string }) => DedupeOutcome
  /** 引擎期望配置。 */
  expectedEngine: () => 'auto' | 'argp' | 'instant' | 'headroom' | 'basic' | 'none'
  /** 最近一次注入的投影文本（诊断用）。 */
  lastProjection: (session: unknown) => string | null
}

/**
 * 构造召回工具。
 * @param runtime - 三层记忆运行时。
 * @returns 注册表就绪的工具定义。
 */
export function buildRecallTool(runtime: MemoryRuntime) {
  const toolName = runtime.recallTool().name
  return defineTool({
    name: toolName,
    description:
      '从三层记忆的深层记忆库（L3）按需取回被压缩/被遗忘的内容。'
      + 'L3 不自动注入上下文，只在这里检索：支持关键词（中文按二元组匹配）与记录 id 精确取回。'
      + '当模型发现缺少早期上下文、需要引用已废弃方案或旧文件读取结果时调用它。'
      + `当前实际工具名：${toolName}。`,
    parameters: {
      query: { type: 'string', description: '关键词查询（与记录正文和关键词做子串匹配）' },
      id: { type: 'string', description: '记录 id 精确取回（形如 l3-xxxx-1）' },
      limit: { type: 'number', description: '最多返回条数，默认取配置 recall.defaultLimit' },
      includeDigest: { type: 'boolean', description: '是否同时返回当前会话的 L2 摘要（默认 false）' },
    },
    output: {
      // 必须落在宿主支持的类型子集内（object/array/string/number/integer/boolean/null）。
      // 作者侧的 `{ type: 'json' }` 会被 ctx.tools.register 的 assertSupportedJsonSchema
      // 直接拒绝，导致整个插件注册失败——本工具返回的是文本，所以就是 string。
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value ?? '') }],
    },
    presentCall: (args: { query?: string; id?: string }) => ({
      card: 'generic',
      title: 'Recall deep memory',
      kind: 'read',
      rawInput: args?.id ?? args?.query ?? '',
    }),
    isConcurrencySafe: () => true,
    async execute(args: { query?: string; id?: string; limit?: number; includeDigest?: boolean }, exec: { agent?: { session?: unknown } }) {
      const config = runtime.config()
      const max = config.recall.maxLimit
      const limit = Number.isFinite(args?.limit) && (args.limit as number) > 0
        ? Math.min(max, Math.floor(args.limit as number))
        : Math.min(max, config.recall.defaultLimit)

      const sections: string[] = []
      if (args?.includeDigest === true) {
        const digest = runtime.digestText(exec?.agent?.session)
        sections.push(digest === null
          ? '## L2 短期记忆\n- 当前会话尚无摘要。'
          : `## L2 短期记忆（当前会话）\n${digest}`)
      }

      if (typeof args?.id === 'string' && args.id.length > 0) {
        const record = runtime.get(args.id)
        sections.push(record === undefined
          ? `未找到记录 id=${args.id}。可先用 query 关键词检索，或用 memory_state 查看库规模。`
          : `## L3 深层记忆（id 精确取回）\n${renderRecord(record, 0)}`)
        return sections.join('\n\n')
      }

      if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
        const stats = runtime.stats()
        return [
          ...sections,
          `缺少 query 或 id。L3 当前 ${stats.count} 条记录 / 约 ${stats.tokens} tokens（后端 ${stats.backend ?? '未打开'}）。`,
          '请提供 query（关键词）或 id（记录 id）。',
        ].join('\n\n')
      }

      const hits = runtime.search(args.query, limit)
      if (hits.length === 0) {
        const stats = runtime.stats()
        sections.push(
          `## L3 深层记忆\n未命中「${args.query}」。库内共 ${stats.count} 条记录 / 约 ${stats.tokens} tokens。`
          + '换更短的关键词、或改用更通用的术语再试；也可能相关内容仍在 L1/L2 中（见 memory_state）。',
        )
        return sections.join('\n\n')
      }
      sections.push(
        `## L3 深层记忆（命中 ${hits.length} 条，按相关度排序）\n`
        + hits.map((record, index) => renderRecord(record, index)).join('\n\n'),
      )
      return sections.join('\n\n')
    },
  })
}

/**
 * 构造状态工具。
 * @param runtime - 三层记忆运行时。
 * @returns 注册表就绪的工具定义。
 */
export function buildStateTool(runtime: MemoryRuntime) {
  return defineTool({
    name: 'memory_state',
    description:
      '查看三层记忆压缩引擎的实时状态：L1 工作记忆窗口（保留轮数/溢出轮数）、'
      + 'L2 短期记忆摘要（覆盖区间/生成方式/压缩比）、L3 深层记忆库（后端/条数/占用）、'
      + '当前 ctx.compaction 引擎与仲裁结果、各社区组件的在场矩阵。'
      + '怀疑记忆层异常或想知道"什么被遗忘了"时先调用它。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Tri-layer memory status', kind: 'read', rawInput: '' }),
    isConcurrencySafe: () => true,
    async execute(_args: unknown, exec: { agent?: { session?: unknown } }) {
      const session = exec?.agent?.session
      const readings = runtime.readings(session)
      const status = buildStatus(runtime.ctx, readings, runtime.expectedEngine())
      // `buildStatus`（integration.ts）只透传 l1/l2/l3/injection 四个读数段，
      // 而 L2 的失败原因就在 l2 段里、随 `...layers.l2` 自动带出；骨架那一段不在
      // 它的透传名单里，因此在这里显式补挂——排查"为什么没走 LLM"必须能一眼看到。
      return {
        ...status,
        mainline: readings.mainline ?? null,
        // seam 命中路径单独提一层：`layers.L2.llmSource` 是同一事实，但排查时
        // 先看顶层更直接（"服务在不在"与"插件拿没拿到"是两个问题）。
        llmSeam: { source: readings.l2.llmSource ?? 'none', missing: readings.l2.failure?.stage === 'llm-missing' },
      }
    },
  })
}

/**
 * 构造去重工具。
 *
 * **为什么这是个模型工具，而不是继续用外部脚本**：L3 的持久化入口是后端的
 * `replace(records)`（整表重写），而插件在内存里持有一份记录快照。外部脚本直接
 * 改 sqlite 后，插件下一次写盘会用旧快照把去重结果覆盖回去——同一份数据两个
 * owner，必然有一方被静默覆盖（2026-10 已实际发生：1491 条含重复被写回、
 * digest 18→0、第三个会话整段丢失）。让插件自己删，内存与磁盘才只有一个写入者。
 *
 * 工具默认 dry-run：这是**维护操作**，模型必须显式传 `dryRun: false` 才会删数据。
 *
 * @param runtime - 三层记忆运行时。
 * @returns 注册表就绪的工具定义。
 */
export function buildDedupeTool(runtime: MemoryRuntime) {
  /** 把结构化结果翻译成一段人读得懂的话（数字必须与 JSON 完全同源）。 */
  const summarize = (outcome: DedupeOutcome): string => {
    const num = (value: number): string => value.toLocaleString('en-US')
    // before/after 是**范围内**口径（传 sessionId 时是该会话，不传是整库），
    // 与 removed/groups 同源；不拿整库数字冒充会话数字——那种口径错误在 memory_state 上修过一次。
    const scope = outcome.sessionId === null ? '整库' : `会话 ${outcome.sessionId}`
    if (outcome.removed === 0) {
      return `没有可删的重复组——${scope}已经是去重状态（幂等）。范围内 ${num(outcome.before)} 条记录。`
    }
    const head = outcome.dryRun
      ? `dry-run（未改动任何文件）：${scope} ${num(outcome.before)} 条中将删除 ${num(outcome.removed)} 条`
        + `（${num(outcome.groups)} 个重复组），删除后 ${num(outcome.after)} 条。`
      : `已删除 ${num(outcome.removed)} 条（${num(outcome.groups)} 个重复组）：${scope} ${num(outcome.before)} → ${num(outcome.after)} 条；`
        + `删除前备份 ${outcome.backupPath ?? '(无)'}。`
    const differing = outcome.differingGroups > 0
      ? `其中 ${num(outcome.differingGroups)} 组正文不一致，保留的是**最长**的那条（长度相同则保留最新的）`
        + `（${outcome.differingGroupDetails.slice(0, 5).map((g) => `${g.kind === 'turn' ? '' : `${g.kind} `}第 ${g.turnFrom}–${g.turnTo} 轮`).join('、')}`
        + `${outcome.differingGroups > 5 ? ' 等' : ''}），不要为了排序稳定丢信息。`
      : '所有组内正文完全一致。'
    const refs = outcome.refsRewritten > 0
      ? `引用改写 ${num(outcome.refsRewritten)} 处（${num(outcome.recordsWithRefUpdates)} 条记录），`
        + '指向被删副本的 refs 已改指保留的那条，没有悬空引用。'
      : '没有记录引用被删的副本。'
    const tail = outcome.dryRun
      ? '确认无误后再次调用并显式传 dryRun:false 才会真正删除（删除前会先备份库文件）。'
      : ''
    return [head, differing, refs, tail].filter((part) => part.length > 0).join(' ')
  }

  return defineTool({
    name: 'memory_dedupe',
    description:
      '维护操作：清理 L3 深层记忆库里同一 (sessionId, kind, turnFrom, turnTo) 的重复副本。'
      + '**默认 dry-run**：只报告"计划删除多少条、哪些组"，不改库、不写盘；'
      + '只有显式传 dryRun:false 才会真的删除记录——这是会删数据的操作。'
      + '真删前会把当前库文件备份成 <库文件>.bak-<时间戳>，并把指向被删副本的 refs 改指保留的那条'
      + '（组内正文不一致时保留最长的那条，并在结果里点名这些组）。'
      + '幂等：没有重复时返回 removed: 0。'
      + '什么时候用：memory_state 的 L3 读数里 duplicateGroups > 0，或 recall 结果里同一轮出现多份。',
    parameters: {
      dryRun: {
        type: 'boolean',
        description: '默认 true（只报告，库文件一个字节都不改）。只有显式传 false 才真正删除记录。',
      },
      sessionId: {
        type: 'string',
        description: '只处理该会话的重复组；不传则整库（跨会话）去重。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'L3 dedupe (maintenance)', kind: 'read', rawInput: '' }),
    // 会删数据：与其它工具并发执行会让"计划"与"实际删除"交错，必须串行。
    isConcurrencySafe: () => false,
    async execute(args: { dryRun?: boolean; sessionId?: string }) {
      const outcome = runtime.dedupe({
        dryRun: args?.dryRun !== false,
        sessionId: typeof args?.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined,
      })
      return {
        ...outcome,
        // 明细可能很长（整库去重时上百组）：只带前 50 组，避免把维护操作的结果灌进上下文。
        groupDetails: outcome.groupDetails.slice(0, 50),
        groupDetailsShown: Math.min(50, outcome.groupDetails.length),
        differingGroupDetails: outcome.differingGroupDetails.slice(0, 50),
        summary: summarize(outcome),
      }
    },
  })
}

/**
 * 构造验证工具。
 * @param runtime - 三层记忆运行时。
 * @returns 注册表就绪的工具定义。
 */
export function buildVerifyTool(runtime: MemoryRuntime) {
  return defineTool({
    name: 'memory_verify',
    description:
      '验证三层记忆压缩引擎是否正常工作：逐项输出 L1/L2/L3 的 PASS/SKIP/FAIL、'
      + '引擎互斥仲裁结果、社区组件矩阵、以及可选的注入物成本审计（dsh-context-doctor）。'
      + '装配完成后、或排查"记忆没生效/recall 查不到"时调用。',
    parameters: {
      detail: { type: 'string', enum: ['summary', 'developer'], description: 'summary 精简；developer 附带修复指引' },
      prune: { type: 'boolean', description: '是否顺带执行一次 L3 确定性剪枝并报告结果' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Tri-layer memory verify', kind: 'read', rawInput: '' }),
    isConcurrencySafe: () => true,
    async execute(args: { detail?: string; prune?: boolean }, exec: { agent?: { session?: unknown } }) {
      const session = exec?.agent?.session
      const readings = runtime.readings(session)
      const engine = engineOf(runtime.ctx)
      const arbitration = arbitrateEngine(engine, runtime.expectedEngine())
      const toolNames = detectTools(runtime.ctx)
      const matrix = componentMatrix(runtime.ctx, toolNames)
      const detail = args?.detail === 'developer' ? 'developer' : 'summary'

      const verdicts: Array<{ id: string; ok: boolean; text: string }> = []
      verdicts.push({
        id: 'L1',
        ok: readings.l1.hotTurns > 0,
        text: readings.l1.hotTurns > 0
          ? `PASS  L1 工作记忆：保留 ${readings.l1.hotTurns}/${readings.l1.totalTurns} 轮（配置 ${readings.l1.retainTurns}），`
            + `溢出 ${readings.l1.evictedTurns} 轮，约 ${readings.l1.tokens} tokens。`
          : 'SKIP  L1 工作记忆：本会话尚未产生可识别的轮次（会话刚开始，或事件流不含 turn/start）。',
      })
      verdicts.push({
        id: 'L2',
        ok: readings.l2.enabled,
        text: readings.l2.enabled
          ? `PASS  L2 短期记忆：模式 ${readings.l2.mode}，覆盖 ${readings.l2.covered ?? '(尚无摘要)'}，`
            + `来源 ${readings.l2.via ?? '-'}，约 ${readings.l2.tokens} tokens，待摘要 ${readings.l2.pendingTurns} 轮。`
          : 'SKIP  L2 短期记忆：已由配置关闭（l2.mode=off）。',
      })
      // 「截断但仍在用」单独一条判定：它不是失败（PASS），但也**不是一份完整摘要**。
      // 过去这里只有"成功/退回抽取式"两种读法，于是"撞上限被裁过"这件事在观察面上
      // 完全不存在——而它恰恰是判断"该压推理档位还是该压期望长度"的唯一依据。
      if (readings.l2.truncated === true) {
        const attempt = readings.l2.attempt
        verdicts.push({
          id: 'L2-truncated',
          ok: true,
          text: `PASS  L2 摘要**部分可用**：撞输出上限后被按边界截断，仍在用（不是失败，未退回抽取式）。`
            + (attempt == null
              ? ''
              : `请求上限 ${attempt.maxTokens}，输入 ${attempt.inputTokens} tokens，`
                + `丢弃前正文 ${attempt.outputChars} 字符，裁掉 ${attempt.droppedChars} 字符（对齐 ${attempt.boundary}），`
                + `推理档位 ${attempt.reasoningEffort}。`)
            + '正文 0 字符才是"推理吃光预算"，那时才会退回抽取式；'
            + '这里的正文字符数 > 0，说明模型写出了内容、只是尾部被裁。',
        })
      }
      // 模式是 llm 却拿到抽取式摘要 = 配置承诺没兑现。这不是"降级"，是故障，
      // 必须给出原因（stage + 异常消息原文），否则排查只能靠猜。
      if (readings.l2.enabled && readings.l2.mode === 'llm' && readings.l2.via === 'extractive' && readings.l2.failure != null) {
        verdicts.push({
          id: 'L2-fallback',
          ok: false,
          text: `WARN  L2 摘要退回抽取式（模式 llm）：阶段 ${readings.l2.failure.stage} —— ${readings.l2.failure.message}`
            + `（llm seam 来源：${readings.l2.llmSource ?? 'none'}）。`
            + 'llm-missing = 服务没拿到（检查 inject 软等待是否触发）；target-missing = 路由解析不到（会话还没路由过请求？）；'
            + 'llm-error = 调用真的失败了，消息原文见上。',
        })
      }
      verdicts.push({
        id: 'L3',
        ok: readings.l3.enabled && readings.l3.backend !== null,
        text: readings.l3.enabled
          ? (readings.l3.backend === null
            ? `FAIL  L3 深层记忆：已启用但后端未打开（目录 ${readings.l3.dir}）。检查目录写权限。`
            : `PASS  L3 深层记忆：后端 ${readings.l3.backend}，整库 ${readings.l3.libraryCount} 条 / 约 ${readings.l3.libraryTokens} tokens`
              + `（本会话 ${readings.l3.sessionCount} 条 / 约 ${readings.l3.sessionTokens} tokens）；`
              + `其中工具原始输出 ${readings.l3.toolCount} 条 / 约 ${readings.l3.toolTokens} tokens`
              + '（独立细节池：不计入记录上限、不进注入、只可 recall）。')
          : 'SKIP  L3 深层记忆：已由配置关闭（l3.enabled=false）。',
      })
      verdicts.push({ id: 'engine', ok: arbitration.ok, text: `${arbitration.ok ? 'PASS' : 'WARN'}  ${arbitration.text}` })

      // 重复副本是"看起来在工作、实际在拖后腿"的典型：recall 的 top-N 被同一轮的
      // 多份副本占满，读数上却只表现为"库很大"。有重复就单独给一条 WARN 并指向
      // memory_dedupe——它走 store 自己的写盘路径，不会触发双 owner 覆盖。
      const duplicateGroups = readings.l3.duplicateGroups ?? 0
      if (readings.l3.enabled && duplicateGroups > 0) {
        const duplicateRecords = readings.l3.duplicateRecords ?? 0
        verdicts.push({
          id: 'L3-duplicates',
          ok: false,
          text: `WARN  L3 有 ${duplicateGroups} 个重复组、可删 ${duplicateRecords} 条`
            + '（同 (sessionId, kind, turnFrom, turnTo) 的多份副本）。'
            + '先用 memory_dedupe（默认 dry-run）看计划，确认后传 dryRun:false 让插件自己删；'
            + '不要用 scripts/dedupe-l3.mjs 直连 sqlite——宿主运行时它的改动会被插件的内存快照整表覆盖回去。',
        })
      }

      const injection = readings.injection
      const overBudget = injection.requestedTokens > injection.budgetTokens
      // 实际注入合计缺失（旧运行时对象）时退回"仲裁层 + 骨架"，不假装是 0。
      const injectedTotal = injection.totalInjected
        ?? (injection.usedTokens + (injection.mainlineTokens ?? 0))
      verdicts.push({
        id: 'budget',
        ok: !overBudget || injection.usedTokens <= injection.budgetTokens,
        text: injection.requestedTokens === 0
          ? 'SKIP  注入预算：本会话尚未注入过投影（会话刚开始，或 l1Inject/l2Inject 全关）。'
          : `PASS  注入预算：仲裁层 ${injection.usedTokens}/${injection.budgetTokens} tokens`
            + `（仲裁前 ${injection.requestedTokens}）；`
            + `骨架另 ${injection.mainlineTokens ?? 0} tokens（独立上限、不进仲裁）；`
            + `本轮实际注入合计 ${injectedTotal} tokens`
            + (injection.truncated.length > 0 ? `，截断 ${injection.truncated.join('/')}` : '')
            + (injection.dropped.length > 0 ? `，丢弃 ${injection.dropped.join('/')}` : '')
            + '。',
      })

      const pruneResult = args?.prune === true ? runtime.prune(session) : null
      const auditAvailable = toolNames.has('context_audit')

      const guidance = [
        '1) L1 不生效：确认会话已产生 turn/start 事件；retainTurns 过大会把更多轮留在原文里（更贵但更准）。',
        '2) L2 一直是"尚无摘要"：需要 (a) 溢出轮数 ≥ l2.minTurnsBeforeSummary，(b) l2.mode 非 off，'
          + '(c) 会话已路由过至少一次请求（用于解析 provider/model）。l2.mode=extractive 可在无模型时先验证链路。',
        '2b) L2 有摘要但来源是 extractive（模式 llm）：看 verdicts 里的 L2-fallback 与 '
          + 'layers.L2.failure —— stage 直接指明是 llm 服务没拿到（llm-missing）、路由解析不到（target-missing），'
          + '还是调用抛错（llm-error，带异常原文）。layers.L2.llmSource 说明 seam 是从 inject 还是 ctx.get 命中的。',
        '2c) L2 摘要是 llm 但被判为"部分可用"（L2-truncated / layers.L2.truncated=true）：'
          + '它撞了输出上限，已按行/句边界裁过并**仍在用**——这是可用产物，不是故障。'
          + 'layers.L2.attempt 给出定性依据：outputChars=0 才是"推理吃光预算"（那时才退回抽取式），'
          + 'outputChars 很大则是"模型写太长"，两条路的修法不同（前者调 internalCallReasoningEffort，后者收紧指令里的期望长度）。',
        '2c) 骨架 cause 没回填：看 mainline.causeFailure（同上三种 stage），以及 mainline.pendingCauses 是否达到 '
          + 'mainlineCauseMinBatch 的批量阈值——没到阈值时这一步根本不会触发，那不是失败。',
        '3) recall 查不到：L3 主内容只收 L2 淘汰下来的摘要；新内容仍在 L1/L2。先 memory_state 看覆盖区间。'
          + '工具输出单独成池（kind=tool）：它只按轮摘录、单轮最多 10 条结果，**不是全文存档**——'
          + '记录头会写明"本轮共 N 条、本记录摘录 M 条"；没被摘录到的片段确实没有落库，需要时只能重跑/重读原文。',
        '4) 投影被截断/丢弃：注入预算不够。调大 injectionBudgetTokens，或把 l1Inject 设为 marker、'
          + 'l3InjectIndex 关掉——两者都只是索引，正文仍可用 recall 取回。',
        `5) 注入物成本审计：${auditAvailable
          ? 'context_audit 已可用，调用它获得指令链/技能目录/工具 schema 的 token 成本与裁剪建议。'
          : '未安装 dsh-context-doctor（GitHub-only）：`dsh plugin --profile desktop add "github:Zhenyu98/dsh-context-doctor#main"`。'}`,
        '6) 引擎仲裁 WARN：ctx.compaction 只允许一个实现。确认 cordis.patch.yml 中 compaction-basic 与 argp/instant/headroom 恰好一个未 disabled，'
          + '或把 integration.engine 改回 auto。',
        '7) L3 有重复副本（verdicts 里的 L3-duplicates，或 layers.L3.duplicateGroups > 0）：'
          + '用 memory_dedupe 先看 dry-run 计划，确认后传 dryRun:false 让插件自己删（删除前自动备份）。'
          + '不要用外部脚本直连 sqlite——宿主运行时它的改动会被插件的内存快照整表覆盖回去。',
      ]

      return {
        system: 'dsh-tri-layer-memory 验证报告',
        at: new Date().toISOString(),
        verdicts,
        engine: { className: engine.className, id: engine.id, arbitration },
        recallTool: runtime.recallTool(),
        components: matrix.map((m) => ({
          id: m.id, state: m.state, shipped: SHIPPED_COMPONENTS.has(m.id),
          toolsPresent: m.present, toolsMissing: m.missing,
        })),
        layers: readings,
        prune: pruneResult,
        guidance: detail === 'developer' ? guidance : guidance.slice(0, 3),
        note: `本插件稳定入口：${MEMORY_TOOLS.join(' / ')}（recall 工具名随重名仲裁变化）。`,
      }
    },
  })
}
