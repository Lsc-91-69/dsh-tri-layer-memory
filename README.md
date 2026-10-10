# dsh-tri-layer-memory · 三层记忆压缩引擎

人脑式上下文压缩的**显式分层**实现：把会话上下文切成 L1 工作记忆 / L2 短期记忆 /
L3 深层记忆，再用一条从事件流确定性提取的**主线骨架**把它们串成"这个会话在做什么"，
配合"选择性遗忘 + 按需回忆 + 可逆存储"，并在对话/轨迹旁边给出一个可看的**思维栏**。

- **全局生效**：挂在 profile 的 host 平面，不读取任何 preset id，标准 / PTC /
  cordis / 极简预设下一律自动工作。
- **主线骨架独立计价**：整段会话被压成几十行里程碑，走自己的 `mainlineMaxTokens`，
  **不和三层抢注入预算**——预算一紧，最先被丢的不该是最需要长期在场的它。
- **桌面端为主，兼容 Web**：宿主半边用 Node 内置能力（含 `node:sqlite`），
  浏览器半边只依赖 `react` 与 `@deepseek-ai/dsh-client-store` 两个基线模块。
- **零代码耦合的深度融合**：不 `import` 任何子插件包，全部通过服务探测与工具表
  探测感知"谁在场"，缺件即降级。
- **原地自更新**：`scripts/deploy.mjs` 直接覆盖已安装目录的产物，不跑 pnpm、
  不动 manifest、不碰组合树（理由见「自更新机制」）。

---

## 一、架构：三层 + 主线骨架

| 层 | 内容 | 压缩策略 | 保留策略（默认） | 上限 | 注入形态 |
|---|---|---|---|---|---|
| **L1 工作记忆** | 最近 N 轮完整原文、当前任务主线 | **不压缩** | 最近 `l1RetainTurns` = 8 轮（1–64 可配） | 窗口内全留 | 每轮注入**窗口标记**（默认 `marker`，不重复原文） |
| **L2 短期记忆** | 较早的工具结果、已完成子任务、历史中间步骤 | LLM 摘要；失败退化为 0-LLM 确定性抽取 | 溢出 L1 后仍在 `l2RetainTurns` = 24 轮内（1–512 可配） | 单次摘要 `l2MaxSummaryTokens` = 1024（128–8192） | 每轮注入摘要正文 + 覆盖区间 + 压缩比 |
| **L3 深层记忆** | 任务初期的大段读取、已废弃方案、被淘汰的旧摘要、里程碑根节点 | 确定性浓缩 + 可复现剪枝（原子引用图思路） | 跨会话持久化，`l3MaxRecords` = 500（16–100000） | 见「真遗忘 = L3 剪枝」 | **不注入正文**，只注入规模与主题；模型用 `memory_recall` 按需取回 |
| **主线骨架** | 从事件流确定性提取的稀疏里程碑（谁要什么 / 做没做成 / 卡在哪） | 0-LLM 规则提取（+ 可选一次节流的 LLM 补 cause） | 覆盖整段会话 | 条数 `mainlineMaxMilestones` = 60（1–500）；**独立** token 上限 `mainlineMaxTokens` = 2500（200–20000） | 每轮注入；位置固定在 **L1 之后、L2 之前** |

### 主线骨架（Milestone Mainline）

L2 摘要是"最近发生了什么"的滚动视图，轮次一多只剩结论；L3 存的是原始正文。
骨架是第三样东西：**一眼看完整个会话**。它同时是"回退弧"的唯一载体——哪些需求
反复没做对（`第 11 轮: 还是很僵硬` → `第 21 轮: 还是很糊` → `第 46 轮: 还是不行`），
只有把几十轮压成几十行才看得出来。

四个收紧动作（每一条都是踩坑得出的）：

| 动作 | 规则 |
|---|---|
| 去重合并 | 同轮同「问题类」的失败并成一条，标题带「N 次尝试」。不合并的话失败会占掉骨架的 40% |
| 严重度分级 | `proto`（未读先改的协议错误）**永不进骨架**——模型下一次调用就能自我纠正；`parser`/`depmiss`/`timeout` 是瞬时失败，折叠进相邻条目；`pydep`/`lock`/`orphan`/`assert`/`net` 是阻塞 |
| 验证合并 | 验证通过**不单独成条**，只作「修复并验证通过」的原因从句；跨轮连续稳定期才并成一条区间 |
| 标题纪律 | ≤40 字符，形状 `{发生了什么} — {一句原因}`；只认人话（用户消息 / 助手结论句），工具自述用途与报错正文**一律只进 `detail`** |

提取是**纯函数、确定性**的：同一份事件流永远得到同一份骨架，不调模型、不读时钟
（实测口径：54 轮 / 11,424 事件 → 54 条 / 1,821 tokens，标题均 24.7 字符）。

`cause`（`—` 后面那句"为什么"）默认由一次**独立、节流、可降级**的模型调用补全，
细节见「启用时机」。

### 注入顺序与优先级仲裁

每轮投影是一整块文本，块头固定为 `# 三层记忆 · 本轮投影`，块序如下：

| 顺序 | 块 | 优先级 | 可截断 | 超预算时 |
|---|---|---|---|---|
| 1 | L1 窗口标记 | 0 | 否 | **永不丢弃**（只有几行，且是原文可信度的锚点） |
| 2 | **主线骨架** | —（不进仲裁） | 否（整条丢） | 只受自己的 `mainlineMaxTokens` / `mainlineMaxMilestones` 约束 |
| 3 | L2 摘要 | 1 | 是 | 先**截断**：一段被截到一半的摘要仍保留任务主线与关键决策，比完全消失有用 |
| 4 | L3 索引 | 2 | 是 | 先截断、再丢弃（它本来就只是索引，正文可用 recall 取回） |

`不可截断` 的块要么整块保留、要么整块丢弃——切一半会破坏语义。截断块的收尾说明
本身也占 token，因此预算计算先扣掉它再按比例收缩，宁可少留一点也不超预算。
`memory_state` 与 `memory_verify` 都会如实报告本轮用量、截断与丢弃了哪些块。

### 骨架为什么不进仲裁

`injectionBudgetTokens`（默认 1200）管的是 L1/L2/L3 三块的分配。骨架**不在其中**，
它有自己的一条独立上限（`mainlineMaxTokens`，默认 2500），超了只裁自己。

理由是承诺问题：骨架是"主内容不遗忘"这个承诺的载体，它必须在场，而不是"预算够的
时候在场"。让它去和 L1/L2/L3 抢同一份预算，等于让承诺随预算打折——真正需要长期
在场的它，会是最先被丢的那个。

裁剪规则（两种上限同向）：**保留任务标题行，从最旧的里程碑开始丢**。越新的越接近
"当前在哪、卡在哪"，越旧的越可能已被 L2/L3 覆盖；任务标题行是整份骨架的锚点，
丢了骨架就不再是"这个会话在做什么"。刻意整条丢而不是截断半行——半条里程碑是不可读的噪声。

### 级联怎么发生

每一步 `agent/pre-step` 时（顺序即代码顺序）：

1. `projectWorkingWindow()` 扫描会话事件，按 `turn/start` 切分轮次，取最近
   `l1RetainTurns` 轮作为 L1；更早的轮进入 `evicted`。
2. `refreshDigest()`：`evicted` 中超出 L2 窗口的最旧部分 → 确定性浓缩后落 L3
   （`kind: 'turn'`）；仍在 L2 窗口内的部分 → 交给摘要（`buildDigest`）。
3. `refreshMainline()`：L1 溢出轮数变化时重新提取骨架，**新增**里程碑落 L3
   （`kind: 'milestone'`，根节点，`refs` 指向同轮范围内**已存在**的 turn/digest 记录）。
   刻意排在 L3 蒸馏之后：先蒸馏再提取，新溢出那几轮的 turn 记录才赶得上被引用。
4. `refreshMainlineCauses()`：只在骨架真的变了时考虑补 cause。
5. 渲染 L1 / L2 / L3 三块 → `arbitrateInjection()` → 把骨架插到 L1 之后 → 与上次
   注入逐字比较，**内容未变则不重复注入**。
6. `feedProjection()` 把同一份读数喂给思维栏。它刻意排在注入逻辑**之前**——注入可能
   因"内容没变"提前返回，而思维栏是给人看的检查面，不该跟着一起被跳过。

### L1 注入为什么只是"标记"

L1 的原文本来就在 surface 里。再注入一遍既浪费 token，又可能让模型误以为存在两份
副本。因此 `l1Inject: marker` 只声明窗口边界与保护状态；需要窗口内用户诉求清单时
可切到 `full`，不需要就 `off`。

---

## 二、启用时机

### 挂载平面：profile bundle 层 → host 平面

`cordis.patch.yml` 由 profile 的 **bundle 层**应用，落在 **host 平面**，早于任何
preset 的 `agent.cordis.yml`。因此无论用户用 standard / ptc / cordis / minimal 预设，
本插件都自动生效——它不读取任何 preset id，也不出现在任何 preset 的行列表里。
（反面教材：`agent-instructions` 同时被三个 preset 各自列一遍，改一处漏两处。）

### 每个 step 触发，不是每轮

`agent/pre-step` 监听是**每个 step** 都会跑的（`{ prepend: true }`，先 `await next()`
拿决策，`reject` 或 `signal.aborted` 时什么都不做）。所以每一步都做了三道限频：

- **摘要**：受 `l2RefreshIntervalMs`（默认 0 = 不限）与"未被覆盖的轮数"约束；
- **骨架**：受 high-water mark 约束（溢出轮数不变就不重跑全量扫描）；
- **注入**：与上一次注入文本**逐字比较**，相同则直接返回原决策。

### L2 摘要的四个触发条件

四个条件全部满足才会真的发一次摘要（`l2Mode: off` 时整段跳过）：

| # | 条件 | 对应配置 |
|---|---|---|
| 1 | 摘要模式不是 `off` | `l2Mode` |
| 2 | 存在溢出 L1 的轮 | —（`evicted.length > 0`） |
| 3 | **未被当前摘要覆盖**的轮数 ≥ 阈值 | `l2MinTurnsBeforeSummary`（默认 3） |
| 4 | 距上次成功摘要已过最小间隔 | `l2RefreshIntervalMs`（默认 0，即不限） |

生成方式由 `l2Mode` 决定：`llm` 且 `ctx.llm` 在场、且能从会话最近一次路由（或
`agent.options`）解析出 provider/model 时走模型；**任何一步不满足就退回
`extractive` 确定性抽取**——摘要失败绝不能让整轮对话失败。

### L3 下沉条件

| 动作 | 条件 | 去重 |
|---|---|---|
| 轮 → L3（`kind: 'turn'`） | `evicted.length - l2RetainTurns > 0`（即溢出量**超出 L2 窗口**）且 `l3Enabled && l3Distill` 且后端已打开 | `l3HighWaterTurn` 水位：同一轮不重复落库 |
| 旧摘要 → L3（`kind: 'digest'`） | 新摘要取代旧摘要时 | 每条旧摘要落一次 |

L2 摘要的输入窗口始终是"溢出 L1 但仍在 `l2RetainTurns` 内"的那一段，与 L3 是否启用
无关：**关掉 L3 时，超出该窗口的最旧轮既不入库也不进摘要**。

### 骨架：high-water mark

`refreshMainline()` 只在 **L1 溢出轮数变化**时重新提取。提取是确定性全量扫描
（11,424 事件实测 72ms），而 pre-step 每一步都会跑——不设限频的话，一个 50 轮、
每轮 10 步的会话要白白付几百次全量扫描。溢出轮数变化恰好是"会话又往前走了一轮"
的确定性信号。

提取出的里程碑按 `(sessionId, turnFrom:turnTo)` 去重后落 L3；**不新建 detail 记录**——
细节本来就在 turn/digest 记录里，里程碑的全部价值是"给散落的细节加一个根"。
`mainlineEnabled: false` 时连缓存与水位一起清掉，重新打开必须重新提取。

### cause 回填：三重节流

| 闸门 | 规则 |
|---|---|
| 触发点 | 只在**本次真的重新提取过**（水位变了）时考虑 |
| 批量 | 当前缺 cause 的条数 ≥ `mainlineCauseMinBatch`（默认 3）才发一次调用 |
| 单次上限 | 最多补 `mainlineCauseMaxPerCall`（默认 20）条 |
| 请求内容 | 只发序号 / 轮次 / 标题，**不发 `detail`**（那是 L3 正文，几十条一起塞进 prompt 等于把省 token 反过来做） |
| 生成上限 | 512 tokens；每条 cause 截到 20 字符 |
| 超时 | 8 秒；会话被中止时联动取消 |
| 失败 | **静默降级**，骨架保持确定性标签，绝不向外抛错（抛出去会被外层 catch 接住，那会连带跳过这一轮的整个投影） |

补好的 cause 会写回两处：内存骨架（`state.mainline`）与 **L3 里的里程碑记录**
（`store.update`）。只改内存等于没做——重启后从 L3 读到的仍是确定性标签。此外
`mainlineCauses` 按"轮次区间 + 标题"缓存已补的因果，下次重提取时贴回去，否则同一个
会话在注入里和在 recall 里会长得不一样。

---

## 三、遗忘与召回

### 三级"遗忘"

| 级 | 触发 | 内容去哪了 |
|---|---|---|
| 1 | L1 窗口滑出 | 原文不再注入（但仍在 surface 历史里），交给 L2 |
| 2 | L2 摘要替换 | **旧摘要先落 L3**（`kind: 'digest'`）——这就是可逆性：内容不再注入上下文，但从未丢失 |
| 3 | L3 下沉 | 超出 L2 窗口的最旧轮确定性浓缩后落 L3（`kind: 'turn'`） |

前两级都只是"不再注入"，不是删除。**真正的遗忘只有一处：L3 剪枝。**

### 真遗忘 = L3 剪枝（0-LLM，完全可复现）

评分公式（四个分量对应原子引用图剪枝的四个直觉）：

```
score = 0.40 × relevance + 0.30 × recency + 0.20 × inbound + 0.10 × density
```

| 分量 | 权重 | 含义 |
|---|---|---|
| `relevance` | 0.40 | 与当前任务链关键词（取自 L1 窗口）的 Jaccard 重叠——"只保留与任务链相关的逻辑节点" |
| `recency` | 0.30 | 半衰期 7 天的指数衰减 |
| `inbound` | 0.20 | 被其他记录引用的次数（引用图的入边），按最大入边数归一 |
| `density` | 0.10 | 每 token 承载的关键词数（`min(1, 关键词数 / tokens × 12)`），奖励浓缩、惩罚注水 |

淘汰两遍：

1. **阈值**：分数低于 `l3PruneMinScore`（默认 0.25）**且没有任何入边**者被剪；
2. **上限**：淘汰后若仍超过 `l3MaxRecords`，按分数从低到高继续淘汰，但**保留根节点
   闭包**——仍被别的存活记录引用的节点不剪，否则会扯断引用图。

**里程碑（`kind === 'milestone'`）两遍淘汰都豁免，永不淘汰。** 现有规则保护的是
"被别的记录引用的节点"，而里程碑的引用方向恰好相反：它引用 turn/digest，不被任何
记录引用——照现有规则会被当成低分孤立节点误删。而它恰恰是全库唯一的主线：删掉它，
剩下的一堆 turn 记录就再也拼不回"这个会话发生过什么"。里程碑只有几十条、每条几十
token，留着不构成预算压力。

> **重要事实：剪枝目前只在 `memory_verify({ prune: true })` 时触发，没有自动调用。**
> `agent/pre-step` 里不剪、启动时不剪、没有定时器。日常运行下 L3 **只增长**；
> `l3MaxRecords` 是"剪枝那一刻"的上限，不是写入时的硬闸门（`put()` 从不检查条数）。
> 想让库收缩，就得显式调一次 `memory_verify` 并带上 `prune: true`。

### 按需取回：`memory_recall`

L3 正文不注入上下文，取回的唯一入口是 `memory_recall`：

| 参数 | 说明 |
|---|---|
| `query` | 关键词查询。中文按**二元组**匹配，英文按词；与记录正文和关键词做子串命中，按命中数排序、新近度打破平局 |
| `id` | 记录 id 精确取回（形如 `l3-<时间戳36>-<序号36>`） |
| `limit` | 最多返回条数，默认 `recallDefaultLimit`（5），硬上限 `recallMaxLimit`（20） |
| `includeDigest` | 是否同时附带当前会话的 L2 摘要（默认 false） |

`query` 与 `id` 都不给时，工具会返回库规模并提示用法；未命中时返回库内条数与
"换更短的关键词"的建议，而不是空响应。

---

## 四、配置矩阵（33 个键，完整表）

所有键都是 **namespace（`tri-layer-memory`）下的顶层标量**，原因见下。取值一律经过
`resolveConfig()` 归一：越界值被**夹到合法区间**，枚举非法回落默认值，非对象输入退回
全套默认——越界配置只会被夹住，不会让插件加载失败。

### L1 工作记忆
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `l1RetainTurns` | `8` | 1–64 | 最近多少轮原文不做任何压缩（上限 64：再长的"工作记忆"已经不是工作记忆了） |
| `l1Inject` | `marker` | `marker` / `full` / `off` | `marker` 只报窗口边界与保护状态；`full` 额外附窗口内用户诉求；`off` 不注入 |
| `l1ProtectFromCompaction` | `true` | 布尔 | 把 L1 窗口作为压缩引擎 recency guard 的保护目标 |

### L2 短期记忆
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `l2Mode` | `llm` | `llm` / `extractive` / `off` | 摘要生成方式；`extractive` 为 0 请求确定性抽取；LLM 失败也自动退回抽取 |
| `l2RetainTurns` | `24` | 1–512 | 溢出 L1 后仍留在 L2 窗口内的轮数；更旧的进 L3 |
| `l2MaxSummaryTokens` | `1024` | 128–8192 | 单次摘要调用的 `maxTokens` |
| `l2Inject` | `true` | 布尔 | 是否每轮注入 L2 块（尚无摘要时注入"等待中"说明） |
| `l2MinTurnsBeforeSummary` | `3` | 1–64 | 未被覆盖的轮少于此数时不调用摘要 |
| `l2RefreshIntervalMs` | `0` | 0–3600000 | 摘要刷新最小间隔（毫秒）；0 = 每个合格步都刷新 |

### L3 深层记忆
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `l3Enabled` | `true` | 布尔 | 关闭后记忆只覆盖 L1+L2，不跨会话 |
| `l3Store` | `auto` | `auto` / `sqlite` / `jsonl` | `auto` 优先 `node:sqlite`，不可用退 JSONL；显式 `sqlite` 不可用时退回并在日志里明确 warn，不静默降级 |
| `l3Dir` | `''` | 任意字符串（trim） | 空 = 按 `defaultStorageDir()` 推导（见「存储」） |
| `l3Distill` | `true` | 布尔 | 是否把超出 L2 窗口的轮与旧摘要写入 L3 |
| `l3MaxRecords` | `500` | 16–100000 | **剪枝时**的记录上限（不是写入闸门，见「真遗忘 = L3 剪枝」） |
| `l3PruneMinScore` | `0.25` | 0–1（越大剪得越狠） | 剪枝保留阈值 |
| `l3InjectIndex` | `true` | 布尔 | 只注入规模与主题，不注入正文 |

### 主线骨架（后续新增）
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `mainlineEnabled` | `true` | 布尔 | 是否从事件流提取骨架；关掉既不提取也不注入（提取是 72ms 量级的确定性扫描，不用它的会话不该付这份成本） |
| `mainlineInject` | `true` | 布尔 | 关掉后**仍提取并落 L3**，只是不注入 |
| `mainlineMaxMilestones` | `60` | 1–500 | 条数上限，超出后从最旧的里程碑开始丢（越新越值钱） |
| `mainlineMaxTokens` | `2500` | 200–20000 | 骨架**独立**的 token 上限，与 `injectionBudgetTokens` 互不影响（下限 200 保证"任务标题行 + 至少一条里程碑"装得下） |
| `mainlineCauseEnabled` | `true` | 布尔 | 是否用一次独立、节流的 LLM 调用补 `cause`；关掉后每条只剩确定性标签（"成没成"，不是"为什么"） |
| `mainlineCauseMinBatch` | `3` | 1–50 | 累计多少条里程碑缺 cause 才发一次调用（1 = 缺一条就补） |
| `mainlineCauseMaxPerCall` | `20` | 1–100 | 单次最多补多少条（请求越长越容易超时与截断） |

### 召回
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `recallToolName` | `auto` | `auto` / `memory_recall` / `tri_recall` | 重名被占用时自动改名（见「工具重名仲裁」） |
| `recallDefaultLimit` | `5` | 1–50 | recall 未指定 limit 时使用 |
| `recallMaxLimit` | `20` | 1–100 | 单次 recall 的硬上限 |

### 注入预算
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `injectionBudgetTokens` | `1200` | 200–8000 | 每轮 L1/L2/L3 三块投影的 token 上限；超出后按优先级仲裁（骨架不走这条预算） |

### 社区组件协同
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `integrationEngine` | `auto` | `auto` / `argp` / `instant` / `headroom` / `basic` / `none` | `auto` 接受探测到的引擎；指定值会校验并在不一致时告警 |
| `integrationHeadroom` | `true` | 布尔 | 启用 `dsh-headroom` 的工具输出压缩协同 |
| `integrationMcpLens` | `true` | 布尔 | 启用 `dsh-mcp-lens` 的 MCP 工具面协同 |
| `integrationAudit` | `true` | 布尔 | 把 `dsh-context-doctor` 的 `context_audit` 纳入验证输出 |

### 诊断
| 键 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `selfTestAfterBoot` | `true` | 布尔 | boot 时跑一次组件矩阵与引擎仲裁自检（缺件只 warn，不崩） |
| `verifyDetail` | `summary` | `summary` / `developer` | `memory_verify` 默认粒度；`developer` 附带修复指引 |

### 三个必须知道的配置事实

1. **`cordis.patch.yml` 里只列了一部分键作为组合级默认值**——目前是 9 个：
   `l1RetainTurns` / `l2RetainTurns` / `l2Mode` / `l3Enabled` / `l3Store` / `l3Dir` /
   `recallToolName` / `injectionBudgetTokens` / `integrationEngine`。其余 24 个键
   不在 patch 里，走 `config-core.ts` 的 `DEFAULTS`。组合行配置即 base 层，
   settings 服务在场时由它接管，退场时自动回落到 base。
2. **设置卡片目前渲染 26 个键**，7 个主线骨架键**还没有卡片控件**——它们只能写在
   `cordis.patch.yml` 本插件行的 `config:` 里（或直接写 settings scope）。
3. **但宿主的 settings schema 声明了全部 33 个键**，包括那 7 个。这不是冗余：
   settings 服务在场时它接管配置来源，schema 里缺席的键会被 `resolveConfig` 当成
   "没配过"而回落到默认值——那样面板一保存，用户在组合行里配的骨架上限就被静默改回默认。

> **为什么配置是扁平的**：客户端设置卡通过 `SettingsScope.set(field, value)` 写入，
> 该 API 的契约是"namespace 段内的**标量**字段"。嵌套对象既写不进去，也无法用
> "字段是否出现在 user 层"判断某个值是否被用户改过（面板据此显示"已覆盖"）。
> `test/contract.test.mjs` 把这条固化成断言：patch 里出现的每个键都必须在
> `TriLayerConfig` 中有同名顶层声明。

---

## 五、思维栏

对话 / 轨迹旁边的**第三个标签页**（`conversation.view` 槽位），把三层记忆的当前读数
直接摆给用户看——不用问模型，也不用翻日志。

### 座位

| 项 | 值 |
|---|---|
| 槽位 | `conversation.view`（list 协议） |
| `id` | `memory` |
| `order` | `20`（在 `chat` = 0 / `trajectory` = 10 之后） |
| `locale` | `tri-layer-memory`（与设置卡共用一个词条表） |
| `label` | **thunk**（`() => t("view.memory")`），切换语言时框架重新求值即可，不必重新注册槽位 |

### 数据通道：session projection

宿主是**唯一计算点**，客户端只读完整值、不做任何派生：

| 半边 | 做法 |
|---|---|
| 宿主 | `ctx.inject(['sessionProjections'], …)` **软等待**，来了就 `registry.register(projection.definition)`（`key: 'tri-layer-memory'`），并挂进 `effect` 以便卸载 |
| 客户端 | `props.useProjection(NS)` 读同一个 key（`NS = 'tri-layer-memory'`，与宿主的 `PROJECTION_KEY` 逐字一致） |

为什么需要一份"feed"而不是像上游那样纯折叠事件：三层读数里有两样东西**根本不来自
事件流**——L2 摘要是模型产物，L3 是跨会话共享的一个本地库。因此宿主在每轮 pre-step
把读数 `feed()` 进投影，投影的 `apply()` 在**轮边界**（`turn/start` / `turn/end`）
才把它折进状态；其余事件原样返回**同一个引用**（框架用 `Object.is` 判断要不要重算
视图与广播，返回新对象会产生无谓的下游工作与广播）。

投影体有两道上限：客户端视图里的 L3 记录最多 **200 条**（按新近度降序），进程内保留
的 feed 最多 **64 个会话**（会话 id 是字符串，没法用 WeakMap 自动回收）。状态里还带
一份 `sessionId`：状态会被投影缓存落盘、恢复时经 `stateSchema.parse()` 变成副本，
留着 id，恢复后的 `apply` 才能重新绑回本进程的活 feed。

`stateSchema` / `viewSchema` 是**真 Zod**（不是形状对的普通对象）：框架会真的
`parse()` 它们，校验失败发生在框架侧，插件收不到。

### 面板四段

| 段 | 内容 |
|---|---|
| 1. 任务标题 | 优先取骨架里 `category === '任务'` 的那条；没有就直接从事件流读会话第一句用户话。**第 1 轮就有值**，不等骨架提取 |
| 2. 主线骨架 | 每条一行：`第 N 轮: 标题 — 原因`（跨轮是 `第 N–M 轮`），标题旁给出骨架 token 合计 |
| 3. L2 摘要 | 覆盖区间 + 生成方式（`llm` / `extractive`）+ 摘要正文；无摘要时给"（尚无摘要）" |
| 4. L3 记忆网络 | 整库规模（条数 / tokens / 后端）+ 可折叠的记录列表（最近 200 条，每条带轮次区间、`kind`、token 与正文） |

拿不到投影值（宿主没注册该 key、插件在宿主侧降级，或本会话还没跑过一轮）时，面板显示
"记忆层尚未就绪"而不是抛错——一个面板的缺席绝不该把整个会话界面打挂。

### `useProjection` 与 `inject` 纪律

`useProjection` 是 **session 作用域槽位的标准 prop**，由框架自动绑定；它不是 Cordis
服务。所以客户端的 `inject` 保持 `["slots", "locale"]` **不变**——一个面板不值得多一次
"硬依赖缺席 → fiber 永远 pending → 宿主判启动失败"的机会。

这一点之所以重要：`exports.inject` 是**硬依赖**清单，而 `dsh.client.inject` 与
`exports.inject` 是同一条纪律的两侧。`settingsScope` 也是同理——它只走
`ctx.inject(["settingsScope"], registerCard)` 软等待（实测崩溃信息就是
`dsh-tri-layer-memory: pending (waiting for service: settingsScope)`）。
`test/contract.test.mjs` 与 `test/client.test.mjs` 都钉着"client inject 里不得出现
任何投影服务"。

---

## 六、模型工具

| 工具 | 说明 |
|---|---|
| `memory_recall`（重名时自动改名 `tri_recall`） | 从 L3 按关键词或 id 取回被压缩/被遗忘的内容；可选附带当前 L2 摘要 |
| `memory_state` | 三层实时读数 + 引擎仲裁 + 社区组件在场矩阵 + 本轮注入预算用量 |
| `memory_verify` | 逐项 PASS/SKIP/FAIL + 修复指引；`prune: true` 可顺带执行一次 L3 剪枝（**目前唯一会剪枝的入口**） |

### 工具重名仲裁

`dsh-memory-vault` 也注册 `memory_recall`，而 tools 注册器**对重名直接抛错**。
因此 `recallToolName: auto` 会在挂载时探测占用情况：被占用则本插件自动改名为
`tri_recall` 并在日志里说明原因。两个工具语义不同——vault 查长期事实库，本插件查
三层记忆的 L2/L3——所以不是覆盖，而是并存。

### 与 dsh-memory-vault 的边界

两个记忆库语义不同，因此**不合并结果**，而是在注入块里写清边界：

- **本插件**管会话内演化的三层记忆（L1 原文 / L2 摘要 / L3 蒸馏 + 主线骨架）；
- **dsh-memory-vault** 管跨会话的稳定事实（用户偏好、项目约定、已定决策）。

模型据此知道该查哪一个——这比让两个 `memory_recall` 互相猜要可靠。刻意**不**去直接读
vault 的存储域：`storageDomain.open()` 在 schema 不匹配时会**整体拒绝**，用自造的
schema 打开别人的私有域有破坏对方数据的风险，不值得。

### 引擎互斥仲裁

`ctx.compaction` 服务每个上下文**只允许一个实现**。本插件：

- **不占用**该槽位——三层记忆通过 `agent/pre-step` 注入 + 持久化召回工作，与任何
  压缩引擎正交共存；
- 按**引擎类名**判定当前激活者（`ArgpGraphEngine` / `InstantCompactionEngine` /
  `HeadroomCompactionEngine` / `BasicCompactionEngine`）；
- 校验它与 `integrationEngine` 是否一致，不一致时 `memory_verify` 报 WARN 并在 boot
  自检里 warn。

`cordis.patch.yml` **不动**宿主自带的 `compaction-basic`，也不插入任何第三方引擎行。
argp 与 instant 都注册工具 `recall`，**两者绝不能同时启用**。包内
`test/contract.test.mjs` 把"不覆盖 compaction-basic + 本 patch 只有本插件一行"
固化成断言。

---

## 七、安装、依赖与自包含

### 规范安装

```sh
# 1. 关闭 DSH —— pnpm 需要替换已加载的 node_modules，运行中的应用会锁住它们
# 2. 从 tarball 安装（会在 profile 内产生真实副本，解析才正常）
dsh plugin --profile desktop add "file:<本包目录>/dsh-tri-layer-memory-<版本>.tgz"
# 3. 启动 DSH
```

本包声明了 `dsh.bundle.patch`，安装即把 `cordis.patch.yml` 里的组件行插入 profile 的
组合树。**装完必须重启 DSH**：模块一旦被 import 过，同一 URL 再 import 只会拿到
ESM 缓存里的旧世代。

### 入口薄壳与 ESM 缓存

`lib/entry.js` 是一个薄壳，只做一次**带时间戳的动态 import** 去加载 `lib/impl.js`
（真正的实现）。原因是 Node 按 URL 缓存 ESM 模块：改完实现后重新激活插件，若不换
URL 就会继续跑上一次加载的那份，症状是"改了代码、重载了插件，报错一字不变"。

注意这**不覆盖**首次安装：模块从未成功 import 过时，Loader 会记住那次失败，必须重启
进程才能拿到新的模块世代。

### 依赖：只有两个运行时包

| 包 | 版本 | 角色 | 会不会出现在插件列表 |
|---|---|---|---|
| `@deepseek-ai/schemastery` | `^3.18.1` | 设置面板的配置校验 schema。**动态 import**：拿不到就只跳过设置面板，三层记忆与三个模型工具照常工作 | 否（不声明 `dsh.bundle.patch`） |
| `zod` | `^4.6.5` | 思维栏投影的 `stateSchema` / `viewSchema`（框架会真的 parse）。构建时**内联**进 `lib/impl.js`，产物里没有裸包 import | 否（普通库） |

`devDependencies` 里只有 `esbuild ^0.21.5`（仅构建需要；`lib/` 产物随仓库提交，最终
用户装插件时不需要它）。`engines.node >= 22.19` 是 `node:sqlite` 的要求。

### 为什么不随附第三方 DSH 插件

v0.1.2 起，本插件**不随附、不依赖任何第三方 DSH 插件**。`cordis.patch.yml` 里只有
它自己一行，插件列表里只有一个开关。

这么做的直接原因：随附第三方包 = 在用户插件列表里多出若干可开关的条目，而它们的
peer 范围一旦与宿主版本不匹配，就会被插件管理器标成红色 `incompatible-version`。
本插件装完本该是"一个开关"，结果列表里一排红标——**代价全由用户承担，收益却是零**
（三层记忆本体根本不需要它们）。

### 检测而不随附的社区组件

`integration.ts` 会在运行期探测这些组件是否在场，把结果纳入 `memory_state` /
`memory_verify` 的组件矩阵（输出里标 `shipped: false`）。**缺了它们不影响三层记忆**：

| 组件 | 与三层记忆的关系 |
|---|---|
| `dsh-argp` | L3 剪枝评分（新近度 / 相关度 / 引用入边 / 密度）的思路来源。它占用 `ctx.compaction`，本插件不占。⚠ 工具 `recall` 与 instant 重名，两者绝不能同时启用 |
| `dsh-mnemon` | 另一套三层记忆实现，与本插件**模型重叠**，建议二选一而非并联 |
| `dsh-headroom` | 工具输出压缩 + CCR 可逆存储，可作为 L2 工具结果压缩的现成实现。⚠ 无 bundle patch，需自行插行 |
| `dsh-context-doctor` | GitHub-only；装好后 `memory_verify` 自动纳入其 `context_audit` 注入审计 |
| `dsh-all-warmup` | 全局无感热身层，只做在场检测 |
| `@deepseek-ai/dsh-compaction-basic` | 宿主自带，本插件**不覆盖**。官方基础压缩引擎，必然可解析 |

以下三个曾经随附，但它们的 peer 声明是 `@deepseek-ai/* ^0.1.0-rc.6` 系列，与
DSH 0.2.0-rc.2 不匹配，装了只会得到红标，因此**已彻底移除**：
`dsh-compaction-instant` / `dsh-memory-vault` / `dsh-mcp-lens`。
DSH 升级到兼容版本后自行安装即可——检测逻辑仍在，矩阵会照常显示它们。

### ⚠ 平台约束：profile 插件如何解析 `@deepseek-ai/*`

DSH 0.2.0 起，profile 插件对 `@deepseek-ai/*` 的解析走**运行时解析表**，而不是旧版的
链接式回退层。官方原文（发布版 `app.asar` 内）：

> Runtime resolution **creates no links**; runtime resolution entries occupy their
> package names at `$DSH_HOME/profiles/node_modules`, and **every other name sees
> that directory as an ordinary ancestor**. Profile load removes the
> `.dsh-module-fallback` projections that link-backend releases wrote into a profile.

三个可操作的推论：

1. **`$DSH_HOME/profiles/node_modules` 不存在是正常的**——新版不建目录，名字是虚拟
   占用的。不要去手工创建它，也别指望它。
2. **解析取决于导入文件的祖先链**。插件必须**落在 profile 树内**（即
   `<profile>/node_modules/<pkg>` 的真实副本）才能看见那个虚拟祖先。
3. **`link:` 到 profile 之外的目录会让插件失去这个能力**——symlink 的 realpath 在
   树外，祖先链里没有 `profiles/node_modules`。这正是本插件最初
   `failed to import: Cannot find package '@deepseek-ai/dsh-llm'` 的根因。

**本插件因此刻意做到运行时零 `@deepseek-ai/*` 依赖**：`defineTool` /
`createUserMessage` / `BlockAssembler` 三个纯 helper 内联在
[`src/host/platform.ts`](src/host/platform.ts)（逐条对照官方源码实现），schemastery
走可失败的动态 import，zod 构建时内联。所以它**无论装在哪里都能工作**。

而 `dsh-argp` / `dsh-headroom` / `dsh-mnemon` 这类 import `@deepseek-ai/*` 的组件
**必须按规范安装**（落在 profile 树内）才能加载。它们默认禁用，装好且解析正常后去掉
对应行的 `disabled` 即可启用。

### `exports.inject` 必须为空数组

`lib/entry.js`（以及宿主半边）的 `inject` 是 `[]`，这是刻意的：

`exports.inject` 是**硬依赖**——任何一项服务在宿主启动时缺席，插件 fiber 就永远停在
`pending`，宿主把"有条目未激活"当启动失败，**整个应用打不开**。实测崩溃信息：

```
web boot: 1 entry did not activate
  dsh-tri-layer-memory: pending (waiting for service: settingsScope)
```

三层记忆不该有这种能力。因此**所有服务都在 `apply` 内部用 `ctx.inject([...], cb)`
软等待**：`settings` / `sessionProjections` / `systemPrompt` / `tools`——来了就启用
对应能力，不来就少一块功能，插件始终 active。`llm` 与 `compaction` 更进一步，只是
`ctx.get?.()` 的一次探测：拿不到就退回确定性抽取 / 报"未检测到引擎"，连等待都不需要。
`test/contract.test.mjs` 与 `test/mount.test.mjs` 都把这条钉成断言。

---

## 八、自更新机制：`scripts/deploy.mjs`

改了源码、构建完之后，把产物**原地**部署到已安装的 profile 目录：

```sh
node scripts/deploy.mjs                 # 部署到 desktop profile
node scripts/deploy.mjs --profile web   # 部署到别的 profile
node scripts/deploy.mjs --dry-run       # 只看要写哪些文件，不写任何东西
```

它做四件事：

1. **安全校验**：用 `realpathSync` 比较目标路径，**目标是链接就拒绝执行**——否则原地
   覆盖会改到工作区源目录本身，语义就错了（`link:` 安装请改用插件列表重装）。
2. **备份**：把现有的 `lib/`、`cordis.patch.yml`、`package.json` 复制到
   `<已安装目录>/.backup-<ISO 时间戳>/`。
3. **覆盖**：把本仓库的 `lib/*`、`package.json`、`cordis.patch.yml` 逐文件拷过去。
   **不跑 pnpm、不动 manifest、不碰组合树。**
4. **提示下一步**：重新激活一次插件。

`DSH_HOME` 只在 DSH 派生的 shell 里存在，独立运行时脚本会自己推导（`$DSH_HOME` →
`<用户目录>/.dsh`），找不到就报错而不是乱猜。

### 为什么不走 `dsh plugin add`

那条路要跑 pnpm、改 `package.json`、重建 `node_modules`。历史上它出过**三次事故**：

| # | 事故 | 后果 |
|---|---|---|
| 1 | 跨盘 junction 安装 | `ERR_PNPM_EPERM`，安装直接失败 |
| 2 | 失败的安装 | profile 的 bundle 选中列表被截断（11 项 → 9 项，插件"消失"） |
| 3 | `internal/update` → `tree.write()` | 把**残缺的组合树写回** `cordis.patch.yml`，抹掉用户的预设、默认模型与模型清单（267 行被重写成 28 行） |

原地部署绕开全部三个风险源：不跑 pnpm（无 1）、不改 manifest（无 2）、不碰组合树（无 3）。

### 换完之后

重新激活一次插件即可——`lib/entry.js` 是薄壳，每次激活都用 `?generation=<时间戳>`
重新 import `impl.js`，所以**宿主半边的新代码立刻生效，不需要重启进程**。
客户端半边（思维栏 + 设置卡）需要**刷新页面**重新 materialize。

### 回滚

- **轻量**：把 `.backup-<时间戳>/` 里的内容拷回已安装目录，再重新激活一次。
- **重度**（profile 文件本身被写坏，例如组合树被截断）：
  `profile-recovery/rollback.ps1`（要求 DSH **完全退出**，含托盘图标）会校验恢复源
  关键节后还原 `cordis.patch.yml` + `package.json`，并可选跑 `pnpm install` 卸载插件；
  `profile-recovery/restore-profile.ps1` 只恢复清单；`scripts/restore-bundles.mjs`
  把被丢掉的 bundle 项**只增不减**地补回清单（支持 `--dry-run`）。

---

## 九、存储

L3 默认落在 `$DSH_HOME/tri-layer-memory/`：

- `deep-memory.jsonl` — JSONL 后端：追加写、人类可读、可手工 grep、单行损坏只跳过该行；
  剪枝与就地更新走"写临时文件 + rename"整体重写。
- `deep-memory.sqlite` — SQLite 后端（`node:sqlite`，Node 22.19+ 内置，零依赖），
  惰性 import，不可用时自动退回 JSONL。

路径解析顺序：`l3Dir` > `$DSH_HOME/tri-layer-memory` >
`<用户目录>/.dsh/tri-layer-memory` > `<临时目录>/dsh-tri-layer-memory`。
**任何环节都不硬编码机器路径**——patch 里不含落盘路径，目录由插件在运行时推导
（历史教训：patch 写死作者本机目录，其他用户装完直接起不来）。
`test/contract.test.mjs` 里有一条条件式断言：一旦有人往 patch 里加带路径的行，它立刻生效。

一条记录的形状：`id` / `kind`（`turn` / `digest` / `artifact` / `milestone`）/
`createdAt` / `sessionId` / `turnFrom`–`turnTo` / `text` / `tokens` / `keywords` / `refs`。
`keywords` 由确定性抽取产生（英文按词、CJK 按二元组、去停用词），检索与剪枝评分共用。

---

## 十、验证

```sh
npm run verify     # = build + check + test
```

| 命令 | 内容 |
|---|---|
| `npm run build` | `src/host/index.ts` → `lib/impl.js`（esbuild；zod 内联，`@deepseek-ai/*` / `dsh-*` / `@wanyantiande/*` 外部化）；`src/entry.js` → `lib/entry.js`、`src/client.js` → `lib/client.js` 逐字复制 |
| `npm run check` | `scripts/verify-sources.mjs`（拒绝已退役的 v3 消息来源写法）+ `node --check` 三个产物 |
| `npm test` | `node --test "test/*.test.mjs"` |

当前状态：**75/75 契约检查 + 129 个测试全绿**。

| 测试文件 | 覆盖什么 |
|---|---|
| `test/layers.test.mjs` | 三层核心逻辑。**不需要构建、不需要安装任何依赖**：直接 import `src/host/*.ts`，靠 Node 22.18+/23.6+ 的原生类型剥离执行（这也是把 `config-core.ts` / `l2-render.ts` 从带 `@deepseek-ai/*` 依赖的模块里拆出来的原因） |
| `test/milestones.test.mjs` | 骨架提取器：失败簇合并、严重度分级、验证合并、标题来源纪律、目标震荡折叠、截断只落在语义单元边界 |
| `test/mainline.test.mjs` | 骨架**接线**：注入位置（L1 之后 L2 之前）、不受 `injectionBudgetTokens` 影响、`mainlineInject: false` 只提取不注入、超限丢最旧的、里程碑不被剪、`refs` 指向真实记录、high-water mark |
| `test/cause.test.mjs` | cause 回填链路：节流、单次上限、垃圾回复、超时、无 LLM 服务、回填后 L3 记录被改写、下一轮不退回标签 |
| `test/projection.test.mjs` | 思维栏投影：引用纪律（不关心的事件返回同一引用）、视图形状与 schema、200 条上限与新近度排序、`apply()` 真的喂读数 |
| `test/mount.test.mjs` | **离线挂载冒烟**：用 mock ctx 真跑一遍 `apply()`，直接 import `lib/impl.js`（真实产物）。覆盖三个工具 schema 合法性、参数校验、pre-step 注入与去重、服务缺席时的全部降级路径、42 轮 → L1 留 8 → L2 留 24 → 最旧蒸馏进 L3 的完整级联，以及 `readEvents` 的致命回归 |
| `test/client.test.mjs` | 客户端半边：`node:vm` 造最小浏览器环境，跑模块加载协议、导出形态、槽位注册、组件渲染、"改字段 → 变脏 → 保存 → 写入 scope"，以及思维栏四段的渲染与降级 |
| `test/contract.test.mjs` | 组装契约（75 项）：bundle 声明、行可解析、自包含、引擎互斥、客户端模块协议、扁平配置键、无硬编码路径、不绑定预设、入口薄壳形态、`inject` 为空数组、运行时零 `@deepseek-ai/*` 静态依赖、构建产物随仓库提交、投影 key 两侧一致 |

装配完成后在会话里让模型调用 `memory_state` 看三层读数，或 `memory_verify`
拿逐项判定与修复指引（`detail: 'developer'` 附带 6 条修复指引）。

---

## 十一、已知限制

诚实清单，避免误读本插件的能力边界：

1. **DSH 0.2.0-rc.2 的 `Session` 没有 `events` 属性**，只有 `snapshotEvents()` /
   `ownEvents()`。本插件最初只读 `session.events`，于是它恒返回 `[]`，导致 L1 窗口、
   L2 摘要、主线骨架**在真实会话里全部静默失效**——而单测用的是 `{events}` 假会话，
   所以一路全绿也挡不住。症状是投影里只剩 L2/L3 的空壳文案、L1 段整段消失。
   现在 `readEvents()` **两条路都走**：`events` 优先（兼容测试与旧宿主），退回
   `snapshotEvents()`，且 `snapshotEvents()` 抛错时返回空数组而不是让 pre-step 挂掉。
   这条坑有专门的回归测试（`test/mount.test.mjs`）。
2. **L3 是跨会话共享的**一个库。`memory_state` 与思维栏显示的是**整库**规模与记录，
   不按当前会话过滤——面板要回答的是"我的深层记忆里有什么"，不是"这个会话写了多少"。
   库里的里程碑记录靠 `sessionId` 区分会话，但条数、token 与记录列表是全局的。
3. **投影更新有半轮延迟**。`apply` 只在**轮边界**提交 feed（为了满足"无关事件返回同一
   引用"这条框架契约），因此刚跑完的那一轮读数，要到下一个 `turn/start` / `turn/end`
   才会出现在思维栏里。
4. **剪枝不是自动的**。唯一的入口是 `memory_verify({ prune: true })`；没有定时器、
   没有启动时清理、pre-step 里也不剪。因此 `l3MaxRecords` 只在剪枝那一刻被强制执行，
   日常运行下 L3 会持续增长——长期使用后库规模可能明显超过配置的上限。
5. **长用户消息的概括对纯中文超长小句会退化成按字切**。截断器只在语义单元边界落刀
   （小句标点 / 空白 / token 边界），而中文没有词边界可判——当整句是一个没有标点的
   长小句时，它只能按字切。省略号仍然跟在合法的边界之后，但那一刀可能落在词中间。
   中英混排与带标点的句子不受影响。
6. **`memory_state` 的 L1 占用是启发式估算，不是计量器数值**。它由 L1 窗口的字符数
   经 `estimateTokens(String(charCount))` 推导，量级粗糙（注入块自己也标注了
   "启发式，非计量器数值"）。要精确的 token 账，看 `memory_verify` 里的注入预算判定，
   或宿主自己的用量统计。
7. **本插件不是压缩引擎**。它不实现 `ctx.compaction`，因此 surface 级的
   range→summary 替换仍由 argp / instant / headroom / compaction-basic 负责。
   这是刻意的设计：`ctx.compaction` 只允许一个实现，而三层记忆的价值在于
   *分层注入 + 按需召回 + 骨架*，与引擎正交。若要接管该槽位，正确做法是继承
   `@deepseek-ai/dsh-compaction-basic` 的 `BasicCompactionEngine` 并覆写其
   `summarize()` 钩子（官方文档称其为"唯一子类定制钩子"）。
8. **L2 摘要需要会话已路由过至少一次请求**才能解析出 provider/model；在此之前
   （或 `ctx.llm` 缺席时）自动退回 `extractive` 确定性抽取。这是降级，不是失败——
   但 `llm` 模式下的摘要在新会话第一轮往往拿不到。
9. **SQLite 后端**依赖 `node:sqlite`；旧版 Node 或 `--no-experimental-sqlite` 下自动
   退回 JSONL（显式配 `l3Store: sqlite` 时会在日志里明确 warn，不会静默降级）。
10. **桌面端没有客户端 HMR**：改了 `src/client.js` 需重新构建、部署并刷新页面；
    Web 端在 `pnpm run dev:web` 运行时才会自动重载。宿主半边的改动经 `deploy.mjs`
    换完文件后，重新激活插件即可生效（薄壳的 `?generation=` 会绕开 ESM 缓存）。
11. **消息来源必须是 v4 的「生产者自有」kind**（0.1.3 已修）。DSH 0.2.0-rc.2 的会话
    格式 v4 在**写入时**拒绝 `{ kind: 'plugin', plugin: <名> }` 这条 v3 写法，报
    `format v4 message requires a producer-owned source kind`。因为本插件的注入发生在
    `agent/pre-step`，被拒绝的那条消息会让整轮对话在 `step/start` 之前失败，日志里只
    留下一个未闭合的 turn——表现是「某个老会话突然不能用了，新会话却正常」，重启进程
    才会恢复。现在两处都写 `{ kind: 'dsh-tri-layer-memory', ... }`，并由
    `npm run check`（`scripts/verify-sources.mjs`）机械拦截回归。
12. **被移除的组件**：`dsh-compaction-instant` / `dsh-memory-vault` / `dsh-mcp-lens`
    与 DSH 0.2.0-rc.2 不兼容（peer 声明落在范围外），已不再随附；检测逻辑仍在，
    升级 DSH 后可自行装回。**检测但不随附的组件**：`dsh-argp` / `dsh-mnemon` /
    `dsh-headroom` / `dsh-context-doctor`（详见「检测而不随附的社区组件」）。

---

## 十二、许可

MIT
