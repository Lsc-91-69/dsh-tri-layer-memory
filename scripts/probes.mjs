/**
 * probes.mjs — 19 条探针事实的**唯一**定义。
 *
 * 为什么单独成文件：`verify-compression.mjs`（口径验证）与 `ablate-retrieval.mjs`
 * （检索调参消融）必须跑**同一套探针**，否则"改前 11/19、改后 13/19"就不是同一个分母。
 * 探针一旦分两处维护，下次改一处、另一处静默不动，结论就再也对不上了。
 *
 * 字段：
 * - `probe`：事实的独特串。判断"L3 里哪条记录才是真的相关的那条"用的就是
 *   记录正文是否包含它（子串口径）。
 * - `query`：模型真会问的那句话（带"为什么/什么/怎么"）。检索的已知缺陷正是
 *   问题词会拉进一堆噪声——所以按真实问法测，别美化成关键词。
 *
 * 注意：这些事实是**这个项目**的历史；换会话时按同一形状替换即可。
 */
export const FACTS = [
  // ── 原有 7 条（保留，便于和历史结果对比；它们大多会被"最近窗口"判为不合格）──
  {
    key: 'stateVersion 必须 bump',
    probe: 'stateVersion',
    query: 'stateVersion 为什么要 bump？',
  },
  {
    key: 'snapshotEvents 才是有效接口',
    probe: 'snapshotEvents',
    query: 'snapshotEvents 和 events 有什么区别？',
  },
  {
    key: 'reasoningEffort 吃光预算',
    probe: 'reasoningEffort',
    query: 'reasoningEffort 为什么吃光了摘要预算？',
  },
  {
    key: 'bundle 列表被截断',
    probe: 'bundle',
    query: 'bundle 列表被截断时怎么办？',
  },
  {
    key: 'sanitizeProfile 抹 patch',
    probe: 'sanitizeProfile',
    query: 'sanitizeProfile 为什么会抹掉 patch？',
  },
  {
    key: 'cordis.patch.yml 不是挂载点',
    probe: 'cordis.patch.yml',
    query: 'cordis.patch.yml 为什么不是挂载点？',
  },
  {
    key: 'prepared 冷读不调 apply',
    probe: 'prepare',
    query: 'prepared 冷读为什么不走 apply？',
  },
  // ── 扩充分 ──
  {
    key: 'readEvents 读不到事件',
    probe: 'readEvents',
    query: '为什么 readEvents 读不到会话事件？',
  },
  {
    key: 'headroom 等插件因兼容性被删',
    probe: 'headroom',
    query: 'headroom 为什么被删掉了？',
  },
  {
    key: 'memory-vault 与本插件的分工',
    probe: 'memory-vault',
    query: 'memory-vault 和本插件是什么关系？',
  },
  {
    key: '0.2.0-rc.2 的兼容处理',
    probe: '0.2.0-rc.2',
    query: '0.2.0-rc.2 的兼容性问题怎么处理的？',
  },
  {
    key: '冷读路径不调 apply',
    probe: '冷读',
    query: '冷读路径为什么不调用 apply？',
  },
  {
    key: 'hydrate 补算机制',
    probe: 'hydrate',
    query: 'hydrate 补算是干什么的？',
  },
  {
    key: '思维栏为空事故',
    probe: '思维栏',
    query: '思维栏为什么是空的？',
  },
  {
    key: '75/75 契约基线',
    probe: '75/75',
    query: '75/75 契约是什么意思？',
  },
  // 下面四条是"只在历史里"的机制/环境事实：最近 8 轮（87–94）没有提过它们，
  // 因此可以真正检验"被压进 L3 之后还能不能取回"。其中 esbuild / incompatible-version
  // 在 L3 里一条都没有——那说明失败发生在**蒸馏**（根本没落库），不是检索。
  {
    key: 'pre-step 是必然被调用的钩子',
    probe: 'pre-step',
    query: 'pre-step 注入钩子为什么必须注册？',
  },
  {
    key: '注入预算的优先级',
    probe: '注入预算',
    query: '注入预算不够时先丢哪一层？',
  },
  {
    key: 'incompatible-version 触发条件',
    probe: 'incompatible-version',
    query: 'incompatible-version 是怎么触发的？',
  },
  {
    key: 'esbuild 缺失时的修法',
    probe: 'esbuild',
    query: 'esbuild 找不到时怎么修？',
  },
]
