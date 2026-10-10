/**
 * integration.ts — 社区组件的深度融合与仲裁逻辑。
 *
 * 原则（与 dsh-brain-compaction 一致，但组件集与判定规则针对三层记忆重写）：
 * 1. **零代码耦合**：不 import 任何子插件包。运行时一律靠服务探测
 *    （`ctx.get('compaction')` / `ctx.get('mnemonMemory')`…）与工具注册表探测
 *    （`ctx.tools.schemas()`）判断"谁在场"。缺装即降级，永不抛错。
 * 2. **引擎互斥仲裁**：`ctx.compaction` 每上下文只允许一个实现。
 *    `argp / instant / headroom / basic` 四者互斥，本插件按【引擎类名】判定
 *    当前激活者，并校验它与配置期望是否一致。
 * 3. **工具重名仲裁**：`memory_recall` 同时被 dsh-memory-vault 使用，
 *    tools 注册器对重名直接抛错。本插件在挂载时探测占用情况，自动改名。
 * 4. **记忆层不是压缩引擎**：三层记忆通过 `agent/pre-step` 注入 + 持久化召回
 *    工作，与任何压缩引擎正交共存，因此不需要抢占 `ctx.compaction`。
 *
 * @module dsh-tri-layer-memory/integration
 */
import type { Context } from '@deepseek-ai/cordis'

/** 集成组件目录。 */
export interface MemoryComponent {
  id: string
  label: string
  /** 组合树中的行 id（本插件 patch 里用的 id）。 */
  row: string
  /** 实际 npm 包名（无工具/无服务的组件用它做可解析性探测）。 */
  pkg: string
  kinds: Array<'engine' | 'memory' | 'mcp' | 'audit' | 'warmup'>
  tools: string[]
  /** 该组件提供的服务名（`ctx.get` 可探测）。 */
  services?: string[]
  defaultOn: boolean
}

/**
 * 组件清单。
 *
 * 工具名与服务名来自对 npm 产物的实际核对（不是 README 转述）：
 * - dsh-argp 1.9.1 / 0.3.2 均导出 recall_pruned / list_pruned / recall，并占据 ctx.compaction；
 * - dsh-memory-vault 的插件导出名是 `dsh-memory`，注册 memory_remember / memory_recall / memory_forget；
 * - @wanyantiande/dsh-headroom **没有 bundle patch**，只能由本 patch 显式插入行；
 * - dsh-mnemon 提供 mnemonMemory 服务与 16 个 mnemon_* 工具。
 */
export const COMPONENTS: MemoryComponent[] = [
  {
    id: 'argp',
    label: 'dsh-argp 原子引用图剪枝（0-LLM 压缩引擎，L3 剪枝思路来源）',
    row: 'tri-argp',
    pkg: 'dsh-argp',
    kinds: ['engine'],
    tools: ['recall_pruned', 'list_pruned', 'recall'],
    defaultOn: true,
  },
  {
    id: 'instant',
    label: 'dsh-compaction-instant 即时近无损引擎（备选，与 argp 互斥）',
    row: 'tri-instant',
    pkg: 'dsh-compaction-instant',
    kinds: ['engine'],
    tools: ['recall', 'search'],
    defaultOn: false,
  },
  {
    id: 'headroom',
    label: '@wanyantiande/dsh-headroom 工具输出压缩 + CCR 可逆存储（L2 工具结果压缩）',
    row: 'tri-headroom',
    pkg: '@wanyantiande/dsh-headroom',
    kinds: ['engine'],
    tools: ['headroom_retrieve'],
    defaultOn: false,
  },
  {
    id: 'basic',
    label: '@deepseek-ai/dsh-compaction-basic 官方基础引擎（默认在场，无模型工具）',
    row: 'compaction-basic',
    pkg: '@deepseek-ai/dsh-compaction-basic',
    kinds: ['engine'],
    tools: [],
    defaultOn: true,
  },
  {
    id: 'vault',
    label: 'dsh-memory-vault 跨会话记忆库（storage-domain 持久化，非 SQLite）',
    row: 'tri-memory-vault',
    pkg: 'dsh-memory-vault',
    kinds: ['memory'],
    tools: ['memory_remember', 'memory_recall', 'memory_forget'],
    defaultOn: true,
  },
  {
    id: 'mnemon',
    label: 'dsh-mnemon 三层记忆模型（运行时记忆 / 档案 / 记忆体）',
    row: 'tri-mnemon',
    pkg: 'dsh-mnemon',
    kinds: ['memory'],
    tools: [
      'mnemon_recall', 'mnemon_related', 'mnemon_status', 'mnemon_remember',
      'mnemon_view_route', 'mnemon_view_action', 'mnemon_memory_bodies',
    ],
    services: ['mnemonMemory'],
    defaultOn: false,
  },
  {
    id: 'lens',
    label: 'dsh-mcp-lens MCP 工具懒加载（减少常驻注入物）',
    row: 'tri-mcp-lens',
    pkg: 'dsh-mcp-lens',
    kinds: ['mcp'],
    tools: ['mcp_search', 'mcp_call'],
    defaultOn: true,
  },
  {
    id: 'doctor',
    label: 'dsh-context-doctor 注入物 Token 审计（GitHub-only，可选）',
    row: 'tri-context-doctor',
    pkg: 'dsh-context-doctor',
    kinds: ['audit'],
    tools: ['context_audit'],
    defaultOn: false,
  },
  {
    id: 'warmup',
    label: 'dsh-all-warmup 全局无感热身层（无模型工具）',
    row: 'tri-all-warmup',
    pkg: 'dsh-all-warmup',
    kinds: ['warmup'],
    tools: [],
    defaultOn: false,
  },
]

/** 本插件自己的稳定入口工具（不含可改名的 recall）。 */
export const MEMORY_TOOLS = ['memory_state', 'memory_verify'] as const

/**
 * 本包**随附**（= 由 cordis.patch.yml 插入行）的组件 id。
 *
 * 自 v0.1.2 起这是一个**空集**：本插件不随附、不依赖任何第三方 DSH 插件，
 * 整个 bundle 只有它自己一行。这样插件列表里只有一个开关，也不可能因为随附包的
 * peer 范围与宿主版本不匹配而出现 `incompatible-version` 红标。
 *
 * 其余组件只做**在场检测**：用户自行安装后矩阵会如实报告它们的状态（输出里标
 * `shipped: false` 以示区分）。检测不需要随包安装。
 */
export const SHIPPED_COMPONENTS: ReadonlySet<string> = new Set<string>()

/** 引擎类名 → 组件 id。 */
const ENGINE_CLASS_MAP: Record<string, string> = {
  ArgpGraphEngine: 'argp',
  InstantCompactionEngine: 'instant',
  HeadroomCompactionEngine: 'headroom',
  BasicCompactionEngine: 'basic',
}

/** 当前激活的压缩引擎。 */
export interface EngineInfo {
  /** 组件 id；类名不可识别时为 null。 */
  id: string | null
  /** 构造器名，原样保留以便诊断。 */
  className: string
}

/**
 * 判定当前 `ctx.compaction` 的实现。
 * @param ctx - 插件上下文。
 * @returns 引擎信息；服务缺失时 `{ id: null, className: '' }`。
 */
export function engineOf(ctx: Context): EngineInfo {
  const engine = ctx.get?.('compaction')
  const className = typeof (engine as { constructor?: { name?: unknown } } | undefined)?.constructor?.name === 'string'
    ? String((engine as { constructor: { name: string } }).constructor.name)
    : ''
  if (className === '') return { id: null, className: '' }
  return { id: ENGINE_CLASS_MAP[className] ?? null, className }
}

/**
 * 读当前 scope 的工具名集合。
 * @param ctx - 插件上下文。
 * @returns 工具名集合；schema 投影失败时返回空集而不是抛错。
 */
export function detectTools(ctx: Context): Set<string> {
  const names = new Set<string>()
  try {
    const schemas: unknown = (ctx as unknown as { tools?: { schemas?: () => unknown } }).tools?.schemas?.() ?? []
    if (Array.isArray(schemas)) {
      for (const schema of schemas) {
        const name = (schema as { name?: unknown })?.name
        if (typeof name === 'string' && name.length > 0) names.add(name)
      }
    }
  } catch {
    // schema 投影失败不阻断状态工具：只影响矩阵的在场判定。
  }
  return names
}

/**
 * 模块是否可解析（用于无模型工具、无服务暴露的组件）。
 * @param spec - npm 包名。
 * @returns 可解析为 true；无 `import.meta.resolve` 或解析失败为 false。
 */
export function moduleResolvable(spec: string): boolean {
  try {
    const meta = import.meta as unknown as { resolve?: (s: string) => string }
    if (typeof meta.resolve !== 'function') return false
    meta.resolve(spec)
    return true
  } catch {
    return false
  }
}

/**
 * 决定 recall 工具的最终名字。
 *
 * `memory_recall` 被 dsh-memory-vault 占用时改名 `tri_recall`：tools 注册器
 * 对重名直接抛错，而两个工具语义不同（vault 查长期事实库，本插件查三层记忆
 * 的 L2/L3）。显式配置 `recall.toolName` 时以配置为准。
 *
 * @param ctx - 插件上下文。
 * @param preference - 配置中的 `recall.toolName`。
 * @returns 最终工具名与决策原因。
 */
export function resolveRecallToolName(
  ctx: Context,
  preference: 'auto' | 'memory_recall' | 'tri_recall',
): { name: string; reason: string } {
  if (preference === 'memory_recall') return { name: 'memory_recall', reason: '配置显式指定' }
  if (preference === 'tri_recall') return { name: 'tri_recall', reason: '配置显式指定' }
  const taken = detectTools(ctx)
  if (taken.has('memory_recall')) {
    return { name: 'tri_recall', reason: 'memory_recall 已被 dsh-memory-vault 占用，自动改名以避免注册器重名抛错' }
  }
  return { name: 'memory_recall', reason: '未探测到重名占用' }
}

/** 组件在场性判定结果。 */
export interface ComponentState {
  id: string
  label: string
  row: string
  kinds: string[]
  expected: string[]
  present: string[]
  missing: string[]
  defaultOn: boolean
  state: 'active' | 'disabled' | 'missing'
}

/**
 * 组件在场性矩阵。
 * @param ctx - 插件上下文。
 * @param toolNames - {@link detectTools} 的结果。
 * @returns 每个组件的预期工具实际注册了几个。
 */
export function componentMatrix(ctx: Context, toolNames: Set<string>): ComponentState[] {
  const activeEngine = engineOf(ctx).id
  return COMPONENTS.map((c) => {
    const present = c.tools.filter((t) => toolNames.has(t))
    const missing = c.tools.filter((t) => !toolNames.has(t))
    const isEngine = c.kinds.includes('engine')

    if (c.tools.length === 0) {
      // 无模型工具的组件：引擎看 ctx.compaction 的类名，其余看包可解析性。
      const installed = isEngine ? activeEngine === c.id : moduleResolvable(c.pkg)
      return {
        id: c.id, label: c.label, row: c.row, kinds: c.kinds,
        expected: c.tools, present: [], missing: [], defaultOn: c.defaultOn,
        state: installed ? 'active' : (c.defaultOn ? 'missing' : 'disabled'),
      }
    }
    if (isEngine) {
      const state = activeEngine === c.id ? 'active' : (present.length > 0 ? 'active' : (c.defaultOn ? 'missing' : 'disabled'))
      return {
        id: c.id, label: c.label, row: c.row, kinds: c.kinds,
        expected: c.tools, present, missing, defaultOn: c.defaultOn, state,
      }
    }
    const servicePresent = (c.services ?? []).some((s) => ctx.get?.(s) !== undefined)
    const state = present.length > 0 || servicePresent ? 'active' : (c.defaultOn ? 'missing' : 'disabled')
    return {
      id: c.id, label: c.label, row: c.row, kinds: c.kinds,
      expected: c.tools, present, missing, defaultOn: c.defaultOn, state,
    }
  })
}

/**
 * 校验激活引擎与配置期望是否一致。
 * @param info - {@link engineOf} 的结果。
 * @param expected - 配置里的 `integration.engine`。
 * @returns 判定与面向人的说明。
 */
export function arbitrateEngine(
  info: EngineInfo,
  expected: 'auto' | 'argp' | 'instant' | 'headroom' | 'basic' | 'none',
): { ok: boolean; text: string } {
  if (info.id === null && info.className === '') {
    return {
      ok: expected === 'none',
      text: '未发现 ctx.compaction 压缩引擎：请检查 profile 组合（compaction-basic 或某个引擎行应处于启用状态）。'
        + '注意三层记忆本身不占用该槽位，因此这不影响 L1/L2/L3 工作。',
    }
  }
  if (expected === 'auto') {
    return { ok: true, text: `ctx.compaction = ${info.className}（识别为 ${info.id ?? '未知引擎'}），auto 策略接受。` }
  }
  if (expected === info.id) {
    return { ok: true, text: `ctx.compaction = ${info.className}，与配置期望 ${expected} 一致。` }
  }
  return {
    ok: false,
    text: `引擎仲裁失败：ctx.compaction = ${info.className}（${info.id ?? '未知'}），但配置期望 ${expected}。`
      + 'ctx.compaction 每上下文只允许一个实现——请在 cordis.patch.yml 中只保留一个未 disabled 的引擎行，'
      + '或把 integration.engine 改回 auto。',
  }
}

/**
 * 汇总三层记忆的实时状态（memory_state 的纯数据载荷）。
 * @param ctx - 插件上下文。
 * @param layers - 各层当前读数。
 * @param expectedEngine - 配置里的引擎期望。
 * @returns 可直接序列化的状态对象。
 */
export function buildStatus(
  ctx: Context,
  layers: {
    l1: { retainTurns: number; hotTurns: number; totalTurns: number; evictedTurns: number; tokens: number }
    l2: { enabled: boolean; mode: string; covered: string | null; tokens: number; via: string | null; pendingTurns: number }
    l3: { enabled: boolean; backend: string | null; count: number; tokens: number; dir: string }
    injection: {
      budgetTokens: number
      usedTokens: number
      requestedTokens: number
      dropped: string[]
      truncated: string[]
    }
    recallTool: { name: string; reason: string }
  },
  expectedEngine: 'auto' | 'argp' | 'instant' | 'headroom' | 'basic' | 'none',
): Record<string, unknown> {
  const toolNames = detectTools(ctx)
  const engine = engineOf(ctx)
  const matrix = componentMatrix(ctx, toolNames)
  const arbitration = arbitrateEngine(engine, expectedEngine)
  return {
    system: 'dsh-tri-layer-memory 三层记忆压缩引擎',
    layers: {
      L1: { label: '工作记忆', ...layers.l1 },
      L2: { label: '短期记忆', ...layers.l2 },
      L3: { label: '深层记忆', ...layers.l3 },
    },
    injection: {
      label: '本轮投影的注入预算',
      ...layers.injection,
      note: '按优先级仲裁：L1 标记 > L2 摘要（可截断）> L3 索引（可丢弃）。'
        + '这是多注入方共存时的统一分配点。',
    },
    recallTool: layers.recallTool,
    engine: { className: engine.className, id: engine.id, arbitration },
    components: matrix.map((m) => ({
      id: m.id, label: m.label, row: m.row, state: m.state,
      shipped: SHIPPED_COMPONENTS.has(m.id),
      toolsPresent: m.present, toolsMissing: m.missing,
    })),
    tools: { expected: [...MEMORY_TOOLS], present: [...MEMORY_TOOLS].filter((t) => toolNames.has(t)) },
    note: '矩阵只读，不修改任何组件。本插件不随附任何第三方组件（shipped 恒为 false），'
      + '矩阵只做在场检测：用户自行安装的组件一旦出现就会被如实报告，缺了也不影响三层记忆。'
      + '三层记忆与压缩引擎正交：引擎负责 surface 替换，本插件负责分层注入与持久化召回。',
  }
}
