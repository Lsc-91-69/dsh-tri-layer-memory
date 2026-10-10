/**
 * platform.ts — 运行平台垫片：把三个 `@deepseek-ai/*` 纯 helper 内联进来。
 *
 * **为什么必须内联**：DSH 文档描述的模块回退层（`$DSH_HOME/profiles/node_modules`
 * 镜像安装依赖闭包，供 profile 插件回落到宿主的那一份 cordis / dsh-* ）在本机
 * 桌面构建里**不存在**：`%DSH_HOME%\profiles\node_modules` 从未被创建，
 * 也没有任何 ESM 代理包。后果是任何 import `@deepseek-ai/*` 的 profile 插件都会
 * `failed to import` —— 本 profile 里的 `dsh-meme` 正是如此（它的 `send_meme`
 * 工具在工具表里根本不存在）。
 *
 * 因此本插件不 import 任何 `@deepseek-ai/*`，改用下面三个内联实现。它们都是从
 * 官方源码逐条核对过的**纯函数**，不涉及服务实例，所以内联不会产生"两份 cordis
 * Service 定义"那类问题：
 *
 * - `createUserMessage` ← packages/llm/llm/src/message.ts:204（补 randomUUID + freeze）
 * - `defineTool`         ← packages/core/tools/src/schema.ts:545（保留参数校验语义）
 * - `BlockAssembler`     ← packages/llm/llm/src/assembler.ts:38（只保留文本路径）
 *
 * 一旦宿主补上回退层，可以改回 import —— 那时也应当改回，因为官方实现会做
 * `assertSupportedJsonSchema` 等额外校验。
 *
 * @module dsh-tri-layer-memory/platform
 */
import { randomUUID } from 'node:crypto'

// ── 消息构造 ─────────────────────────────────────────────────────────────

/**
 * 本插件在会话日志里的生产者 kind。
 *
 * DSH 0.2.0-rc.2 的会话格式 v4 要求消息来源「生产者自有」：
 * `{ kind: 'plugin', plugin: <名> }` 是已退役的 v3 写法，v4 在**写入时**直接拒绝
 * （`format v4 message requires a producer-owned source kind`）。因为本插件的注入
 * 发生在 `agent/pre-step`，那条消息一被拒绝，整轮对话就在 `step/start` 之前失败，
 * 日志里只留下一个没闭合的 turn。
 */
export const PLUGIN_SOURCE_KIND = 'dsh-tri-layer-memory'

/** 消息来源：插件注入的快照形态（与 time-context 的 v4 用法一致）。 */
export interface PluginMessageSource {
  kind: typeof PLUGIN_SOURCE_KIND
  form?: 'snapshot'
  sections?: Array<{ name: string; text: string }>
}

/** 构造一条 user 角色消息：补 `role` 与稳定 id，并冻结。 */
export function createUserMessage<T extends { content: unknown; source: unknown }>(
  input: T,
): T & { id: string; role: 'user' } {
  return Object.freeze({
    ...input,
    role: 'user' as const,
    id: randomUUID(),
  })
}

// ── 工具定义 ─────────────────────────────────────────────────────────────

/** 单个参数的作者侧声明（本插件只用到这几个关键字）。 */
export interface ParameterSpec {
  type?: string
  description?: string
  enum?: readonly unknown[]
  items?: ParameterSpec
  properties?: Record<string, ParameterSpec>
  required?: readonly string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

/** 参数名 → 参数声明。 */
export type ParameterSchemaSpec = Record<string, ParameterSpec>

/** 把作者侧参数声明编译成模型看到的 JSON Schema。 */
function compileParameter(spec: ParameterSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof spec.type === 'string') out.type = spec.type
  if (typeof spec.description === 'string') out.description = spec.description
  if (Array.isArray(spec.enum)) out.enum = [...spec.enum]
  if (spec.items !== undefined) out.items = compileParameter(spec.items)
  if (spec.properties !== undefined) {
    const properties: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(spec.properties)) properties[key] = compileParameter(value)
    out.type = 'object'
    out.properties = properties
    if (Array.isArray(spec.required)) out.required = [...spec.required]
  }
  if (spec.additionalProperties !== undefined) out.additionalProperties = spec.additionalProperties
  return out
}

/** 把参数表编译成 object 根 JSON Schema。 */
export function parameterSchemaToJson(spec: ParameterSchemaSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec)) properties[key] = compileParameter(value)
  return { type: 'object', properties }
}

/**
 * 校验模型给出的实参是否符合参数表。
 *
 * 官方实现走的是完整的 JSON Schema 校验器；这里只覆盖本插件实际用到的关键字
 * （string / number / boolean / enum / 必填），并在 execute 里再兜一层类型判断，
 * 因此模型传错参数只会得到一条清晰的错误，不会让工具崩溃。
 *
 * @returns 违规描述列表；空数组表示通过。
 */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string[] {
  const properties = (schema.properties ?? {}) as Record<string, ParameterSpec>
  const required = (schema.required ?? []) as readonly string[]
  if (args === null || typeof args !== 'object') return ['arguments must be an object']
  const record = args as Record<string, unknown>
  const violations: string[] = []
  for (const key of required) {
    if (record[key] === undefined) violations.push(`${key} is required`)
  }
  for (const [key, spec] of Object.entries(properties)) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (spec.type === 'string' && typeof value !== 'string') violations.push(`${key} must be a string`)
    else if (spec.type === 'number' && typeof value !== 'number') violations.push(`${key} must be a number`)
    else if (spec.type === 'boolean' && typeof value !== 'boolean') violations.push(`${key} must be a boolean`)
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      violations.push(`${key} must be one of ${spec.enum.map(String).join(' | ')}`)
    }
  }
  return violations
}

/** 工具运行上下文（官方 `ToolRunContext` 里本插件用到的字段）。 */
export interface ToolRunContext {
  agent?: { session?: unknown }
  signal?: AbortSignal
}

/** 注册表可接受的最小工具定义。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: unknown
    render: (args: unknown, value: unknown) => unknown
  }
  execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>
  presentCall?: (args: unknown) => unknown
  isConcurrencySafe?: (args: unknown) => boolean
  timeoutMs?: number
}

/** `defineTool` 的选项。 */
export interface DefineToolOptions {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: { schema: unknown; render: (args: never, value: never) => unknown }
  execute: (args: never, exec: ToolRunContext) => Promise<unknown>
  presentCall?: (args: never) => unknown
  isConcurrencySafe?: (args: never) => boolean
  timeoutMs?: number
}

/**
 * 定义并注册表就绪的工具。
 *
 * 与官方实现的语义一致：参数先编译成 JSON Schema，`execute` 先校验实参再调用
 * 业务函数；展示类回调（`presentCall`）在校验失败时降级为 undefined。
 */
export function defineTool(options: DefineToolOptions): ToolDefinition {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaToJson(options.parameters)
  const render = options.output.render
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema,
      render: (args: unknown, value: unknown) => render(args as never, value as never),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args as never, exec)
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.presentCall !== undefined) {
    const present = options.presentCall
    tool.presentCall = (args: unknown) => {
      // 展示可能发生在任意历史实参的重放上，绝不能抛错。
      if (validateArgs(parameters, args).length > 0) return undefined
      return present(args as never)
    }
  }
  if (options.isConcurrencySafe !== undefined) {
    const safe = options.isConcurrencySafe
    tool.isConcurrencySafe = (args: unknown) => (validateArgs(parameters, args).length > 0 ? false : safe(args as never))
  }
  return tool
}

// ── 流式文本装配 ─────────────────────────────────────────────────────────

/**
 * 只保留文本路径的块装配器。
 *
 * 官方 `BlockAssembler` 还处理 reasoning / tool-call 增量与重放信封；摘要调用
 * 只需要"把 text-delta 拼起来，并拿到 finish 与 usage"，因此这里只实现该子集，
 * 对未知块类型静默忽略（官方会 assertNever，但那是给已知协议用的）。
 */
export class TextAssembler {
  private readonly text = new Map<number, string>()
  private readonly order: number[] = []
  private usage: unknown
  private finishReason: { kind?: string; failure?: { message?: string } } | undefined

  /** 喂入一个流式块。 */
  push(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return
    const c = chunk as Record<string, unknown>
    switch (c.type) {
      case 'block-start':
        if (typeof c.index === 'number' && !this.text.has(c.index)) {
          this.order.push(c.index)
          this.text.set(c.index, '')
        }
        return
      case 'text-delta':
        if (typeof c.index === 'number' && typeof c.text === 'string') {
          if (!this.text.has(c.index)) this.order.push(c.index)
          this.text.set(c.index, (this.text.get(c.index) ?? '') + c.text)
        }
        return
      case 'block-end': {
        const block = c.block as { type?: string; text?: string } | undefined
        if (typeof c.index === 'number' && block?.type === 'text' && typeof block.text === 'string') {
          if (!this.text.has(c.index)) this.order.push(c.index)
          this.text.set(c.index, block.text)
        }
        return
      }
      case 'usage':
        this.usage = c.usage
        return
      case 'finish':
        this.finishReason = c.reason as { kind?: string; failure?: { message?: string } } | undefined
        return
      default:
        // reasoning / tool-call 增量与未知块：摘要用不到，忽略。
        return
    }
  }

  /** 终止原因（`error` / `aborted` / `max-tokens` / 正常）。 */
  get finish(): { kind?: string; failure?: { message?: string } } | undefined {
    return this.finishReason
  }

  /** provider 上报的用量（原样透传，不做结构假设）。 */
  get reportedUsage(): unknown {
    return this.usage
  }

  /** 按块序拼出的完整文本。 */
  textContent(): string {
    return this.order
      .slice()
      .sort((a, b) => a - b)
      .map((index) => this.text.get(index) ?? '')
      .join('\n')
      .trim()
  }
}
