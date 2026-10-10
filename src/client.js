/**
 * client.js — dsh-tri-layer-memory 的浏览器半边（Settings → Plugins 卡片 + 思维栏标签页）。
 *
 * 发布形态：**逐字复制**到 lib/client.js，不做任何转换（与 dsh-meme /
 * dsh-brain-compaction 一致）。运行时的契约是：
 *   window.__ModuleLoader__.load({ id: <npm 包名>, factory: (require) => exports })
 * 其中 `require` 只解析基线模块表里的模块：
 *   react / @deepseek-ai/dsh-client-store / @deepseek-ai/dsh-client-ui-slots /
 *   @deepseek-ai/dsh-client-ui-primitives / @deepseek-ai/dsh-client-ui-dockkit
 * **不要**去 require 那个叫 dsh-client-runtime 的包：它并不存在，会让整个
 * 客户端半边在 materialize 时抛错。这里只用 react 与 client-store。
 *
 * `inject` 是 **Cordis 服务名列表**（不是包名）：slots / locale / settingsScope。
 *
 * 两个贡献面：
 * 1. 卡片注册进 Slot `settings.plugin.item`（keyed 协议，**key 就是 settings
 *    namespace**）。宿主侧必须注册同名 namespace，否则 scope.status 永远不是 ready，
 *    卡片不会渲染——两边靠 `tri-layer-memory` 这个字符串对齐。
 * 2. 思维栏注册进 Slot `conversation.view`（list 协议，id/order 决定标签顺序），
 *    数据用标准 prop `useProjection('tri-layer-memory')` 读 session projection，
 *    因此**不需要**为它新增任何服务依赖。
 */
(function () {
  "use strict";

  function triLayerMemoryClientFactory(require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var clientStore = require("@deepseek-ai/dsh-client-store");
    var createSnapshotStore = clientStore.createSnapshotStore;

    /** settings namespace：必须与 src/host/config.ts 的 MEMORY_NAMESPACE 一致。 */
    var NS = "tri-layer-memory";

    // ── 样式（跟随主题 token，全部带兜底值）────────────────────────────
    var CSS = [
      ".dsh_tlm_card{display:flex;flex-direction:column;gap:12px;padding:4px 0}",
      ".dsh_tlm_head{display:flex;flex-direction:column;gap:4px}",
      ".dsh_tlm_title{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
      ".dsh_tlm_desc{font-size:12px;opacity:.75;line-height:1.5}",
      ".dsh_tlm_note{font-size:12px;opacity:.7;margin:0}",
      ".dsh_tlm_group{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:8px;padding:10px 12px}",
      ".dsh_tlm_groupTitle{font-size:12px;font-weight:600;opacity:.85;margin:0 0 8px}",
      ".dsh_tlm_row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(120px,1.2fr);gap:8px;align-items:center;padding:4px 0}",
      ".dsh_tlm_label{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dsh_tlm_labelText{font-size:13px}",
      ".dsh_tlm_hint{font-size:11px;opacity:.6;line-height:1.35}",
      ".dsh_tlm_badge{font-size:10px;opacity:.75;border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-left:6px}",
      ".dsh_tlm_input,.dsh_tlm_select{width:100%;box-sizing:border-box;padding:4px 6px;font:inherit;font-size:13px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.4));background:transparent;color:inherit}",
      ".dsh_tlm_invalid{border-color:var(--dsw-alias-state-error-primary,#d33)}",
      ".dsh_tlm_error{font-size:11px;color:var(--dsw-alias-state-error-primary,#d33)}",
      ".dsh_tlm_footer{display:flex;gap:8px;align-items:center}",
      ".dsh_tlm_btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.4));background:transparent;color:inherit;cursor:pointer}",
      ".dsh_tlm_btn[disabled]{opacity:.45;cursor:default}",
      ".dsh_tlm_dirty{font-size:11px;opacity:.75}",
      // ── 思维栏（conversation.view 的 memory 标签页）────────────────────
      // 全部走 --dsw-* 主题 token（带兜底值），不写死颜色：浅色/深色主题由宿主决定。
      ".dsh_tlm_mem{display:flex;flex-direction:column;gap:14px;padding:12px 14px;font-size:13px;line-height:1.55}",
      ".dsh_tlm_memHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
      ".dsh_tlm_memTitle{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}",
      ".dsh_tlm_memMeta{font-size:11px;opacity:.65}",
      ".dsh_tlm_memSection{display:flex;flex-direction:column;gap:6px}",
      ".dsh_tlm_memSectionHead{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;opacity:.85}",
      ".dsh_tlm_memCount{font-weight:400;opacity:.65}",
      ".dsh_tlm_memEmpty{margin:0;font-size:12px;opacity:.6}",
      ".dsh_tlm_memList{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}",
      ".dsh_tlm_memItem{overflow-wrap:anywhere}",
      ".dsh_tlm_memCause{opacity:.7}",
      ".dsh_tlm_memText{margin:0;font-size:12px;opacity:.9;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".dsh_tlm_memDetails{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28));border-radius:8px;padding:8px 10px}",
      ".dsh_tlm_memDetails>summary{cursor:pointer;font-size:12px;opacity:.8}",
      ".dsh_tlm_memRecs{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:6px}",
      ".dsh_tlm_memRec{overflow-wrap:anywhere}",
      ".dsh_tlm_memRecKind{font-size:11px;opacity:.7}",
      ".dsh_tlm_memRecText{display:block;font-size:12px;opacity:.85;white-space:pre-wrap}",
      ".dsh_tlm_memNote{margin:0;font-size:11px;opacity:.6}",
      // 引用按钮：内联小按钮，跟着正文基线走，不抢视线。
      ".dsh_tlm_memQuote{font:inherit;font-size:11px;line-height:1.4;padding:1px 6px;margin-left:6px;border-radius:4px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.4));background:transparent;color:inherit;cursor:pointer;vertical-align:baseline;white-space:nowrap}",
      ".dsh_tlm_memQuote:hover{border-color:var(--dsw-alias-label-primary,currentColor)}",
      ".dsh_tlm_memQuoteNote{margin:0;font-size:11px;opacity:.7}",
    ].join("");

    function useStyleOnce(ctx) {
      ctx.effect(function () {
        var el = document.createElement("style");
        el.setAttribute("data-plugin", NS);
        el.textContent = CSS;
        document.head.appendChild(el);
        return function () { el.remove(); };
      }, NS + ": styles");
    }

    // ── 词条（产品文案归 locale 所有）──────────────────────────────────
    var zh = {
      title: "三层记忆压缩引擎",
      description: "L1 工作记忆（原文）/ L2 短期记忆（摘要）/ L3 深层记忆（持久化 + 按需召回）。",
      note: "引擎行（argp / instant / headroom）与存储路径属于组合配置，需编辑 cordis.patch.yml 后重启；此处只调运行时可调项。",
      groupL1: "L1 · 工作记忆",
      groupL2: "L2 · 短期记忆",
      groupL3: "L3 · 深层记忆",
      groupRecall: "召回",
      groupIntegration: "社区组件协同",
      groupDiag: "诊断",
      l1RetainTurns: "保留轮数",
      l1RetainTurnsHint: "最近 N 轮原文不做任何压缩（默认 8）。",
      l1Inject: "注入形态",
      l1InjectHint: "marker 只报窗口边界；full 附完整原文；off 不注入。",
      l1ProtectFromCompaction: "保护工作记忆",
      l1ProtectFromCompactionHint: "把 L1 窗口作为压缩引擎 recency guard 的保护目标。",
      l2RetainTurns: "L2 保留轮数",
      l2RetainTurnsHint: "溢出 L1 后仍留在 L2 的轮数，更旧的进 L3（默认 24）。",
      l2Mode: "摘要方式",
      l2ModeHint: "llm 走模型；extractive 为 0 请求确定性抽取；off 关闭。",
      l2MaxSummaryTokens: "摘要生成上限",
      l2MaxSummaryTokensHint: "单次摘要调用的 maxTokens（默认 1024）。",
      l2Inject: "每轮注入摘要",
      l2InjectHint: "把当前摘要附到每轮请求。",
      l2MinTurnsBeforeSummary: "触发摘要的最少轮数",
      l2MinTurnsBeforeSummaryHint: "少于这么多轮可压缩内容时不调用模型（默认 3）。",
      l2RefreshIntervalMs: "摘要刷新间隔（毫秒）",
      l2RefreshIntervalMsHint: "0 表示每个合格步都刷新。",
      l3Enabled: "启用深层记忆",
      l3EnabledHint: "关闭后记忆只覆盖 L1+L2，不跨会话。",
      l3Store: "存储后端",
      l3StoreHint: "auto 优先 node:sqlite，不可用时退回 JSONL。",
      l3Dir: "存储目录",
      l3DirHint: "留空表示 $DSH_HOME/tri-layer-memory。",
      l3Distill: "蒸馏进 L3",
      l3DistillHint: "把超出 L2 窗口的内容与旧摘要写入 L3。",
      l3MaxRecords: "记录上限",
      l3MaxRecordsHint: "超出后按剪枝分数淘汰（默认 500）。",
      l3PruneMinScore: "剪枝阈值",
      l3PruneMinScoreHint: "0-1，越大剪得越狠；被引用的根节点不剪（默认 0.25）。",
      l3InjectIndex: "注入 L3 索引",
      l3InjectIndexHint: "只注入规模与主题，不注入正文。",
      recallDefaultLimit: "默认返回条数",
      recallDefaultLimitHint: "recall 未指定 limit 时使用。",
      recallMaxLimit: "返回上限",
      recallMaxLimitHint: "单次 recall 的硬上限。",
      injectionBudgetTokens: "注入预算（tokens）",
      injectionBudgetTokensHint: "每轮三层投影的上限。超出后按 L1 标记 > L2 摘要（可截断）> L3 索引（可丢弃）仲裁。",
      recallToolName: "recall 工具名",
      recallToolNameHint: "auto 在 memory_recall 被 dsh-memory-vault 占用时自动改名 tri_recall。",
      integrationEngine: "压缩引擎仲裁",
      integrationEngineHint: "auto 接受探测到的引擎；指定值会校验并在不一致时告警。",
      integrationHeadroom: "协同 headroom",
      integrationHeadroomHint: "启用 headroom 的工具输出压缩协同。",
      integrationMcpLens: "协同 mcp-lens",
      integrationMcpLensHint: "启用 MCP 工具面懒加载协同。",
      integrationAudit: "纳入注入审计",
      integrationAuditHint: "memory_verify 附带 dsh-context-doctor 的 context_audit。",
      selfTestAfterBoot: "启动自检",
      selfTestAfterBootHint: "boot 时输出组件矩阵与引擎仲裁 warn（缺件不崩）。",
      verifyDetail: "验证粒度",
      verifyDetailHint: "memory_verify 默认输出：summary / developer。",
      overridden: "已覆盖",
      reset: "重置",
      invalidNumber: "必须是数字",
      save: "保存",
      saving: "保存中…",
      saveFailed: "保存失败",
      discard: "放弃",
      unsaved: "有未保存的修改",
      readOnly: "当前连接为只读，无法修改配置。",
      unavailable: "宿主未注册该 settings 命名空间（插件未激活）。",
      // ── 思维栏（conversation.view）──────────────────────────────────
      // key 用点号只是命名习惯：locale 的 lookup 是**扁平**的 `dict[key]`，
      // 不做嵌套路径解析，因此这里与 `t('view.memory')` 逐字对应即可。
      "view.memory": "思维栏",
      memHeading: "三层记忆 · 思维栏",
      // 打开会话时宿主已经按日志补算过（session/created → 投影），所以这里不再是
      // "还没跑过一轮"的意思：要么宿主没注册这个投影，要么这个会话确实一轮都还没有。
      memNotReady: "记忆层尚未就绪：宿主没有注册该投影，或本会话还没有产生任何轮次。",
      memUpdated: "更新于 {time}",
      memTask: "任务标题",
      memNoTask: "（尚未识别出任务标题）",
      memMainline: "主线骨架",
      memMainlineEmpty: "（本会话尚无可提取的里程碑）",
      memTurn: "第 {turn} 轮",
      memTurnRange: "第 {from}–{to} 轮",
      memL2: "L2 短期记忆",
      memL2Cover: "覆盖 {span} · {mode}",
      memL2Empty: "（尚无摘要）",
      memL3: "L3 记忆网络",
      memL3Meta: "本会话 {sessionCount} 条 / 约 {sessionTokens} tokens · 整库 {count} 条 / 约 {tokens} tokens · 后端 {backend}",
      memL3Shared: "L3 是跨会话共享的一个库：前一个口径是本会话写进去的，后一个是整库总量。",
      memL3Empty: "（库为空：更早的内容尚未被蒸馏）",
      memRecords: "记录（最近 {n} 条）",
      memOtherSession: "其它会话 {id}",
      memOwnSession: "本会话",
      memTokens: "约 {tokens} tokens",
      memBackendNone: "未打开",
      memRecall: "按需召回：调用 {tool} 取回正文。",
      // ── 引用（可引用：把一条记忆塞进输入框）──────────────────────────
      // 走的是 `conversation.view` 的标准 prop（inputActions.setDraft），不新增服务依赖。
      memQuote: "引用",
      memQuoteTask: "记忆引用 · 任务标题",
      memQuoteMainline: "记忆引用 · 主线骨架 · {span}",
      memQuoteL2: "记忆引用 · L2 摘要 · 覆盖 {span}",
      memQuoteL3: "记忆引用 · L3 {id} · {span} · {kind}",
      memQuoted: "已引用：{label}（在输入框里，可继续补充再发送）",
      memQuoteFailed: "引用失败：输入框当前不可写。",
    };
    var en = {
      title: "Tri-layer Memory",
      description: "L1 working memory (verbatim) / L2 short-term (digest) / L3 deep (persisted, recalled on demand).",
      note: "Engine rows (argp / instant / headroom) and storage paths are composition config: edit cordis.patch.yml and restart. Only runtime-tunable keys live here.",
      groupL1: "L1 · Working memory",
      groupL2: "L2 · Short-term memory",
      groupL3: "L3 · Deep memory",
      groupRecall: "Recall",
      groupIntegration: "Community components",
      groupDiag: "Diagnostics",
      l1RetainTurns: "Retained turns",
      l1RetainTurnsHint: "Keep the last N turns verbatim, uncompressed (default 8).",
      l1Inject: "Injection form",
      l1InjectHint: "marker reports the window only; full appends the text; off disables.",
      l1ProtectFromCompaction: "Protect working memory",
      l1ProtectFromCompactionHint: "Treat the L1 window as the compaction engine's recency guard target.",
      l2RetainTurns: "L2 retained turns",
      l2RetainTurnsHint: "Turns kept in L2 after leaving L1; older ones go to L3 (default 24).",
      l2Mode: "Digest mode",
      l2ModeHint: "llm calls the model; extractive is deterministic and free; off disables.",
      l2MaxSummaryTokens: "Digest token cap",
      l2MaxSummaryTokensHint: "maxTokens for one summarization call (default 1024).",
      l2Inject: "Inject digest each turn",
      l2InjectHint: "Append the current digest to every request.",
      l2MinTurnsBeforeSummary: "Min turns before summarizing",
      l2MinTurnsBeforeSummaryHint: "Fewer compressible turns than this never call the model (default 3).",
      l2RefreshIntervalMs: "Digest refresh interval (ms)",
      l2RefreshIntervalMsHint: "0 refreshes at every eligible step.",
      l3Enabled: "Enable deep memory",
      l3EnabledHint: "When off, memory covers L1+L2 only and does not persist across sessions.",
      l3Store: "Store backend",
      l3StoreHint: "auto prefers node:sqlite and falls back to JSONL.",
      l3Dir: "Storage directory",
      l3DirHint: "Empty means $DSH_HOME/tri-layer-memory.",
      l3Distill: "Distill into L3",
      l3DistillHint: "Write content beyond the L2 window and superseded digests into L3.",
      l3MaxRecords: "Record ceiling",
      l3MaxRecordsHint: "Excess records are pruned by score (default 500).",
      l3PruneMinScore: "Prune threshold",
      l3PruneMinScoreHint: "0-1, higher prunes harder; referenced roots are never pruned (default 0.25).",
      l3InjectIndex: "Inject L3 index",
      l3InjectIndexHint: "Inject size and topics only, never the bodies.",
      recallDefaultLimit: "Default result limit",
      recallDefaultLimitHint: "Used when recall omits limit.",
      recallMaxLimit: "Result ceiling",
      recallMaxLimitHint: "Hard ceiling for one recall call.",
      injectionBudgetTokens: "Injection budget (tokens)",
      injectionBudgetTokensHint: "Ceiling for the per-turn three-layer projection. Over budget arbitrates L1 marker > L2 digest (truncatable) > L3 index (droppable).",
      recallToolName: "Recall tool name",
      recallToolNameHint: "auto renames to tri_recall when dsh-memory-vault already owns memory_recall.",
      integrationEngine: "Engine arbitration",
      integrationEngineHint: "auto accepts the detected engine; an explicit value is validated and warned on mismatch.",
      integrationHeadroom: "Coordinate headroom",
      integrationHeadroomHint: "Enable tool-output compression coordination.",
      integrationMcpLens: "Coordinate mcp-lens",
      integrationMcpLensHint: "Enable MCP tool-face lazy loading coordination.",
      integrationAudit: "Include injection audit",
      integrationAuditHint: "memory_verify includes dsh-context-doctor's context_audit.",
      selfTestAfterBoot: "Boot self-check",
      selfTestAfterBootHint: "Log the component matrix and engine arbitration at boot (missing parts never crash).",
      verifyDetail: "Verify detail",
      verifyDetailHint: "Default memory_verify level: summary / developer.",
      overridden: "Overridden",
      reset: "Reset",
      invalidNumber: "Must be a number",
      save: "Save",
      saving: "Saving…",
      saveFailed: "Save failed",
      discard: "Discard",
      unsaved: "Unsaved changes",
      readOnly: "This connection is read-only.",
      unavailable: "The Host did not register this settings namespace (plugin inactive).",
      // ── Memory view (conversation.view) ─────────────────────────────
      "view.memory": "Memory",
      memHeading: "Tri-layer Memory",
      memNotReady: "Memory layers are not ready yet: the Host registered no projection for this session, or this session has no turns yet.",
      memUpdated: "updated {time}",
      memTask: "Task",
      memNoTask: "(no task title recognized yet)",
      memMainline: "Milestone mainline",
      memMainlineEmpty: "(no milestone extracted for this session yet)",
      memTurn: "turn {turn}",
      memTurnRange: "turns {from}–{to}",
      memL2: "L2 short-term memory",
      memL2Cover: "covers {span} · {mode}",
      memL2Empty: "(no digest yet)",
      memL3: "L3 deep memory",
      memL3Meta: "this session {sessionCount} records / ~{sessionTokens} tokens · library {count} records / ~{tokens} tokens · backend {backend}",
      memL3Shared: "L3 is one library shared across sessions: the first figure is what this session wrote, the second is the whole library.",
      memL3Empty: "(library empty: nothing distilled yet)",
      memRecords: "Records (latest {n})",
      memOtherSession: "other session {id}",
      memOwnSession: "this session",
      memTokens: "~{tokens} tokens",
      memBackendNone: "not open",
      memRecall: "Recall on demand: call {tool} to read the bodies.",
      // Quoting rides the `conversation.view` standard prop (inputActions.setDraft);
      // it adds no service dependency.
      memQuote: "Quote",
      memQuoteTask: "Memory reference · task",
      memQuoteMainline: "Memory reference · mainline · {span}",
      memQuoteL2: "Memory reference · L2 digest · covers {span}",
      memQuoteL3: "Memory reference · L3 {id} · {span} · {kind}",
      memQuoted: "Quoted: {label} (it is in the composer; add your instruction and send)",
      memQuoteFailed: "Quote failed: the composer is not writable right now.",
    };

    // ── 字段规格（全部是 namespace 下的顶层标量）──────────────────────
    function numberField(field) {
      return {
        field: field,
        format: function (value) { return typeof value === "number" ? String(value) : ""; },
        parse: function (text) {
          var trimmed = String(text).trim();
          if (trimmed === "") return { kind: "clear" };
          var parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
        },
      };
    }
    function textField(field) {
      return {
        field: field,
        format: function (value) { return typeof value === "string" ? value : ""; },
        parse: function (text) { return { kind: "set", value: String(text) }; },
      };
    }
    function enumField(field, options) {
      return {
        field: field,
        options: options,
        format: function (value) { return typeof value === "string" ? value : ""; },
        parse: function (text) { return { kind: "set", value: String(text) }; },
      };
    }
    function booleanField(field) {
      return {
        field: field,
        format: function (value) { return value === true ? "true" : "false"; },
        parse: function (text) { return { kind: "set", value: String(text) === "true" }; },
      };
    }

    var GROUPS = [
      {
        titleKey: "groupL1",
        fields: [
          { field: "l1RetainTurns", kind: "number", spec: numberField("l1RetainTurns") },
          { field: "l1Inject", kind: "enum", spec: enumField("l1Inject", ["marker", "full", "off"]) },
          { field: "l1ProtectFromCompaction", kind: "toggle", spec: booleanField("l1ProtectFromCompaction") },
        ],
      },
      {
        titleKey: "groupL2",
        fields: [
          { field: "l2Mode", kind: "enum", spec: enumField("l2Mode", ["llm", "extractive", "off"]) },
          { field: "l2RetainTurns", kind: "number", spec: numberField("l2RetainTurns") },
          { field: "l2MaxSummaryTokens", kind: "number", spec: numberField("l2MaxSummaryTokens") },
          { field: "l2MinTurnsBeforeSummary", kind: "number", spec: numberField("l2MinTurnsBeforeSummary") },
          { field: "l2RefreshIntervalMs", kind: "number", spec: numberField("l2RefreshIntervalMs") },
          { field: "l2Inject", kind: "toggle", spec: booleanField("l2Inject") },
        ],
      },
      {
        titleKey: "groupL3",
        fields: [
          { field: "l3Enabled", kind: "toggle", spec: booleanField("l3Enabled") },
          { field: "l3Store", kind: "enum", spec: enumField("l3Store", ["auto", "sqlite", "jsonl"]) },
          { field: "l3Dir", kind: "text", spec: textField("l3Dir") },
          { field: "l3Distill", kind: "toggle", spec: booleanField("l3Distill") },
          { field: "l3MaxRecords", kind: "number", spec: numberField("l3MaxRecords") },
          { field: "l3PruneMinScore", kind: "number", spec: numberField("l3PruneMinScore") },
          { field: "l3InjectIndex", kind: "toggle", spec: booleanField("l3InjectIndex") },
        ],
      },
      {
        titleKey: "groupRecall",
        fields: [
          { field: "recallToolName", kind: "enum", spec: enumField("recallToolName", ["auto", "memory_recall", "tri_recall"]) },
          { field: "recallDefaultLimit", kind: "number", spec: numberField("recallDefaultLimit") },
          { field: "recallMaxLimit", kind: "number", spec: numberField("recallMaxLimit") },
          { field: "injectionBudgetTokens", kind: "number", spec: numberField("injectionBudgetTokens") },
        ],
      },
      {
        titleKey: "groupIntegration",
        fields: [
          { field: "integrationEngine", kind: "enum", spec: enumField("integrationEngine", ["auto", "argp", "instant", "headroom", "basic", "none"]) },
          { field: "integrationHeadroom", kind: "toggle", spec: booleanField("integrationHeadroom") },
          { field: "integrationMcpLens", kind: "toggle", spec: booleanField("integrationMcpLens") },
          { field: "integrationAudit", kind: "toggle", spec: booleanField("integrationAudit") },
        ],
      },
      {
        titleKey: "groupDiag",
        fields: [
          { field: "verifyDetail", kind: "enum", spec: enumField("verifyDetail", ["summary", "developer"]) },
          { field: "selfTestAfterBoot", kind: "toggle", spec: booleanField("selfTestAfterBoot") },
        ],
      },
    ];

    // ── 暂存式表单控制器（半打的数字不会写进持久文档）──────────────────
    function CardController(scope) {
      this.scope = scope;
      this.staged = new Map();
      this.listeners = new Set();
      this.saving = false;
      this.failed = false;
      var self = this;
      scope.subscribe(function () { self.publish(); });
    }
    CardController.prototype.bind = function (project) {
      var store = createSnapshotStore(project());
      this.listeners.add(function () { store.set(project()); });
      return store;
    };
    CardController.prototype.publish = function () {
      this.listeners.forEach(function (listener) {
        try { listener(); } catch (e) { /* 投影失败不能让整张表单失效 */ }
      });
    };
    CardController.prototype.sectionValue = function (field) {
      var snapshot = this.scope.getSnapshot();
      var value = snapshot.value;
      return value == null ? void 0 : value[field];
    };
    CardController.prototype.baseValue = function (field) {
      var base = this.scope.getSnapshot().base;
      return base == null ? void 0 : base[field];
    };
    CardController.prototype.stored = function (field) {
      var user = this.scope.getSnapshot().user;
      return user != null && Object.prototype.hasOwnProperty.call(user, field);
    };
    CardController.prototype.shell = function () {
      var snapshot = this.scope.getSnapshot();
      return {
        available: snapshot.status === "ready",
        writable: snapshot.writable,
        dirty: this.staged.size > 0,
        saving: this.saving,
        failed: this.failed,
      };
    };
    CardController.prototype.fieldView = function (spec) {
      var staged = this.staged.get(spec.field);
      if (staged === void 0) {
        return { text: spec.format(this.sectionValue(spec.field)), overridden: this.stored(spec.field), invalid: false };
      }
      var write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
      return {
        text: staged.text,
        overridden: write != null && write.kind === "set",
        invalid: write === void 0,
      };
    };
    CardController.prototype.stage = function (field, entry) {
      this.staged.set(field, entry);
      this.failed = false;
      this.publish();
    };
    CardController.prototype.actions = function () {
      var self = this;
      return {
        edit: function (field, text) { self.stage(field, { text: text, clear: false }); },
        resetField: function (field, spec) {
          self.stage(field, { text: spec.format(self.baseValue(field)), clear: true });
        },
        save: function () { return self.save(); },
        discard: function () {
          if (self.staged.size === 0 && !self.failed) return;
          self.staged.clear();
          self.failed = false;
          self.publish();
        },
      };
    };
    CardController.prototype.save = function () {
      if (this.staged.size === 0 || this.saving) return Promise.resolve();
      var self = this;
      var pending = [];
      this.staged.forEach(function (staged, field) {
        var spec = self.specs.get(field);
        if (staged.clear) {
          if (self.stored(field)) pending.push(self.scope.unset(field));
          return;
        }
        var write = spec.parse(staged.text);
        if (write === void 0) return;
        if (write.kind === "clear") {
          if (self.stored(field)) pending.push(self.scope.unset(field));
        } else {
          pending.push(self.scope.set(field, write.value));
        }
      });
      this.saving = true;
      this.failed = false;
      this.publish();
      // 返回 promise，让调用方（以及测试）能等到暂存真正清空。
      return Promise.all(pending).then(function () {
        self.saving = false;
        self.staged.clear();
        self.publish();
      }, function () {
        self.saving = false;
        self.failed = true;
        self.publish();
      });
    };
    CardController.prototype.prepare = function (groups) {
      var self = this;
      this.specs = new Map();
      groups.forEach(function (group) {
        group.fields.forEach(function (f) { self.specs.set(f.field, f.spec); });
      });
      return this;
    };

    // ── 卡片组件 ───────────────────────────────────────────────────────
    function TriLayerCard(props) {
      var t = props.t;
      var view = props.useTriLayerCard(function (s) { return s; });
      var actions = props.actions;

      if (!view.available) {
        return React.createElement(
          "div",
          { className: "dsh_tlm_card" },
          React.createElement("div", { className: "dsh_tlm_head" },
            React.createElement("div", { className: "dsh_tlm_title" }, t("title")),
            React.createElement("div", { className: "dsh_tlm_desc" }, t("description"))),
          React.createElement("p", { className: "dsh_tlm_note" }, t("unavailable")),
        );
      }

      function renderField(group, f) {
        var fieldView = view.fields[f.field];
        var label = React.createElement("div", { className: "dsh_tlm_label" },
          React.createElement("span", { className: "dsh_tlm_labelText" },
            t(f.field),
            fieldView.overridden ? React.createElement("span", { className: "dsh_tlm_badge" }, t("overridden")) : null),
          React.createElement("span", { className: "dsh_tlm_hint" }, t(f.field + "Hint")));

        var control;
        if (f.kind === "enum") {
          control = React.createElement("select", {
            className: "dsh_tlm_select",
            value: fieldView.text,
            disabled: !view.writable,
            onChange: function (e) { actions.edit(f.field, e.target.value); },
          }, f.spec.options.map(function (opt) {
            return React.createElement("option", { key: opt, value: opt }, opt);
          }));
        } else if (f.kind === "toggle") {
          control = React.createElement("select", {
            className: "dsh_tlm_select",
            value: fieldView.text === "true" ? "true" : "false",
            disabled: !view.writable,
            onChange: function (e) { actions.edit(f.field, e.target.value); },
          },
            React.createElement("option", { value: "true" }, "on"),
            React.createElement("option", { value: "false" }, "off"));
        } else {
          control = React.createElement("input", {
            className: fieldView.invalid ? "dsh_tlm_input dsh_tlm_invalid" : "dsh_tlm_input",
            type: "text",
            value: fieldView.text,
            disabled: !view.writable,
            onChange: function (e) { actions.edit(f.field, e.target.value); },
          });
        }

        return React.createElement("div", { className: "dsh_tlm_row", key: f.field },
          label,
          React.createElement("div", null,
            control,
            fieldView.invalid ? React.createElement("div", { className: "dsh_tlm_error" }, t("invalidNumber")) : null,
            React.createElement("button", {
              className: "dsh_tlm_btn",
              type: "button",
              disabled: !view.writable,
              onClick: function () { actions.resetField(f.field, f.spec); },
            }, t("reset"))));
      }

      return React.createElement(
        "div",
        { className: "dsh_tlm_card" },
        React.createElement("div", { className: "dsh_tlm_head" },
          React.createElement("div", { className: "dsh_tlm_title" }, t("title")),
          React.createElement("div", { className: "dsh_tlm_desc" }, t("description"))),
        React.createElement("p", { className: "dsh_tlm_note" }, t("note")),
        GROUPS.map(function (group) {
          return React.createElement("div", { className: "dsh_tlm_group", key: group.titleKey },
            React.createElement("p", { className: "dsh_tlm_groupTitle" }, t(group.titleKey)),
            group.fields.map(function (f) { return renderField(group, f); }));
        }),
        !view.writable ? React.createElement("p", { className: "dsh_tlm_note" }, t("readOnly")) : null,
        React.createElement("div", { className: "dsh_tlm_footer" },
          React.createElement("button", {
            className: "dsh_tlm_btn",
            type: "button",
            disabled: !view.writable || !view.dirty || view.saving,
            onClick: function () { actions.save(); },
          }, view.saving ? t("saving") : t("save")),
          React.createElement("button", {
            className: "dsh_tlm_btn",
            type: "button",
            disabled: !view.dirty || view.saving,
            onClick: function () { actions.discard(); },
          }, t("discard")),
          view.failed ? React.createElement("span", { className: "dsh_tlm_error" }, t("saveFailed"))
            : (view.dirty ? React.createElement("span", { className: "dsh_tlm_dirty" }, t("unsaved")) : null)),
      );
    }

    // ── 思维栏面板 ─────────────────────────────────────────────────────
    /** 轮次区间文本（单轮与跨轮两种写法）。 */
    function spanLabel(t, turn, turnTo) {
      return turnTo === undefined || turnTo === null || turnTo === turn
        ? t("memTurn", { turn: turn })
        : t("memTurnRange", { from: turn, to: turnTo });
    }

    /** 时间戳 → 本地时钟文本；格式化失败时退回原始数字，绝不让面板抛错。 */
    function formatClock(ms) {
      try {
        return new Date(ms).toLocaleTimeString();
      } catch (e) {
        return String(ms);
      }
    }

    /**
     * 思维栏：展示记忆网络与压缩内容（对话/轨迹旁边的第三个标签页），并把任意一条
     * 记忆**引用**进当前对话的输入框。
     *
     * 数据来自 session projection：`useProjection(NS)` 是 **session 作用域槽位的标准
     * prop**，由框架自动绑定——所以这里不需要声明任何 Cordis 服务（硬依赖缺席会让
     * 插件 fiber 永远 pending，宿主据此判定启动失败）。
     *
     * 引用同样只走标准 prop：`inputActions.setDraft` 写输入框、`useInput(s => s.draft)`
     * 读回当前草稿——两条都在 `conversation.view` 的 standardProps 里
     * （packages/client/ui-conversation/src/client/contract/input.ts 的 InputActions /
     * InputState）。**平台已经把这条端到端通路备好了**：不需要跨半边协议、不需要新
     * 服务、不需要宿主配合。标准 prop 缺席时（宿主换了实现）不渲染引用按钮，降级成
     * 只读展示，而不是抛错。
     *
     * 宿主没有注册该 key（或插件在宿主侧降级）时 `useProjection` 返回 undefined：
     * 此时显示"尚未就绪"而不是抛错——一个面板的缺席绝不该把整个会话界面打挂。
     */
    function TriLayerMemoryView(props) {
      var t = props.t;
      var view = typeof props.useProjection === "function" ? props.useProjection(NS) : undefined;

      // 引用通道。`useInput` 必须在组件顶层**无条件**调用（React hooks 规则）：标准
      // prop 的可用性是槽位级的常量，不会在两次渲染之间变。
      var inputActions = props.inputActions;
      var canQuote = inputActions !== undefined && inputActions !== null
        && typeof inputActions.setDraft === "function";
      var draft = typeof props.useInput === "function"
        ? props.useInput(function (state) { return state.draft; })
        : "";
      var quoteState = React.useState(null);
      var quoteNote = quoteState[0];
      var setQuoteNote = quoteState[1];

      /**
       * 把一条记忆追加进输入框草稿。
       *
       * **追加而不是替换**：用户可能已经写了半句指令，引用只是往里加一段证据；
       * 直接覆盖会把用户正在写的东西弄丢。
       *
       * 失败必须说出来（`memQuoteFailed`）：这个插件已经栽过两次"看起来在工作、
       * 其实什么都没发生"的静默故障，一个点了没反应的按钮就是第三次。
       *
       * @param label - 引用块首行的标签（例如「记忆引用 · 主线骨架 · 第 4–6 轮」）。
       * @param body - 被引用的正文。
       */
      function quote(label, body) {
        if (!canQuote) return;
        var block = "[" + label + "]\n" + body;
        var next = draft === undefined || draft === null || String(draft).trim().length === 0
          ? block
          : String(draft).replace(/\s+$/, "") + "\n\n" + block;
        try {
          inputActions.setDraft(next);
          setQuoteNote(t("memQuoted", { label: label }));
        } catch (e) {
          setQuoteNote(t("memQuoteFailed"));
        }
      }

      /** 一条记忆的引用按钮；标准 prop 缺席时返回 null（只读降级）。 */
      function quoteButton(label, body, key) {
        if (!canQuote) return null;
        return React.createElement("button", {
          className: "dsh_tlm_memQuote",
          type: "button",
          key: key,
          title: label,
          onClick: function () { quote(label, body); },
        }, t("memQuote"));
      }

      function section(title, count, children, key) {
        return React.createElement("section", { className: "dsh_tlm_memSection", key: key },
          React.createElement("div", { className: "dsh_tlm_memSectionHead" },
            React.createElement("span", null, title),
            count === null ? null : React.createElement("span", { className: "dsh_tlm_memCount" }, count)),
          children);
      }

      var body = [React.createElement("div", { className: "dsh_tlm_memHead", key: "head" },
        React.createElement("span", { className: "dsh_tlm_memTitle" }, t("memHeading")),
        view !== undefined && view !== null && view.updatedAt > 0
          ? React.createElement("span", { className: "dsh_tlm_memMeta" },
              t("memUpdated", { time: formatClock(view.updatedAt) }))
          : null)];

      // 形状不对（例如宿主侧换了实现）也走同一条降级路径：面板只负责显示，
      // 拿不到可用数据时它说明情况，不猜、不抛。
      if (view === undefined || view === null || typeof view.updatedAt !== "number" || view.updatedAt === 0) {
        body.push(React.createElement("p", { className: "dsh_tlm_memEmpty", key: "pending" }, t("memNotReady")));
        return React.createElement("div", { className: "dsh_tlm_mem" }, body);
      }

      // 1. 任务标题
      body.push(section(t("memTask"), null,
        React.createElement("p", { className: "dsh_tlm_memText" },
          view.taskTitle || t("memNoTask"),
          view.taskTitle ? quoteButton(t("memQuoteTask"), view.taskTitle, "q-task") : null), "task"));

      // 2. 主线骨架
      var mainline = view.mainline;
      body.push(section(t("memMainline"),
        t("memTokens", { tokens: view.mainlineTokens }),
        mainline.length === 0
          ? React.createElement("p", { className: "dsh_tlm_memEmpty" }, t("memMainlineEmpty"))
          : React.createElement("ol", { className: "dsh_tlm_memList" }, mainline.map(function (entry, index) {
              var span = spanLabel(t, entry.turn, entry.turnTo);
              var line = span + ": " + entry.title + " — " + entry.cause;
              return React.createElement("li", { className: "dsh_tlm_memItem", key: index },
                React.createElement("span", null, span + ": " + entry.title + " "),
                React.createElement("span", { className: "dsh_tlm_memCause" }, "— " + entry.cause),
                quoteButton(t("memQuoteMainline", { span: span }), line, "q-main-" + index));
            })), "mainline"));

      // 3. L2 摘要
      var l2 = view.l2;
      var l2Span = l2 === null ? null : spanLabel(t, l2.turnFrom, l2.turnTo);
      body.push(section(t("memL2"),
        l2 === null ? null : t("memL2Cover", { span: l2Span, mode: l2.mode }),
        React.createElement("p", { className: "dsh_tlm_memText" },
          l2 === null ? t("memL2Empty") : l2.summary,
          l2 === null ? null : quoteButton(t("memQuoteL2", { span: l2Span }), l2Span + ": " + l2.summary, "q-l2")), "l2"));

      // 4. L3 记忆网络（记录列表可折叠：正文可能很长，默认收起）
      var l3 = view.l3;
      var records = l3.records;
      body.push(section(t("memL3"),
        t("memL3Meta", {
          count: l3.count,
          tokens: l3.tokens,
          // 本会话口径：L3 是共享库，只报整库会被读成"本会话有这么多"。
          sessionCount: l3.sessionCount,
          sessionTokens: l3.sessionTokens,
          backend: l3.backend || t("memBackendNone"),
        }),
        React.createElement("div", null,
          React.createElement("p", { className: "dsh_tlm_memNote" }, t("memL3Shared")),
          records.length === 0
            ? React.createElement("p", { className: "dsh_tlm_memEmpty" }, t("memL3Empty"))
            : React.createElement("details", { className: "dsh_tlm_memDetails" },
                React.createElement("summary", null, t("memRecords", { n: records.length })),
                React.createElement("ul", { className: "dsh_tlm_memRecs" }, records.map(function (record, index) {
                  var recSpan = spanLabel(t, record.turnFrom, record.turnTo);
                  // 列表是**整库**的（能看得到别的会话蒸馏了什么），所以每一条都必须自报
                  // 所属会话：L3 是跨会话共享的库，别的会话的「第 3 轮」不带标记就和本会话的
                  // 「第 3 轮」长得一模一样——那是个真实的误读风险。本会话的显式标出来，
                  // 而不是"不标就是本会话"：后者在整库列表里靠默认值猜，猜错就是误读。
                  var own = record.own === true;
                  var shortId = typeof record.sessionId === "string" && record.sessionId.length > 0
                    ? record.sessionId.replace(/^session-/, "").slice(0, 8)
                    : "?";
                  return React.createElement("li", { className: "dsh_tlm_memRec", key: record.id || index },
                    React.createElement("span", { className: "dsh_tlm_memRecKind" },
                      recSpan + " · " + record.kind + " · "
                      + t("memTokens", { tokens: record.tokens }) + " · "
                      + (own ? t("memOwnSession") : t("memOtherSession", { id: shortId })),
                      quoteButton(
                        t("memQuoteL3", { id: record.id, span: recSpan, kind: record.kind }),
                        recSpan + " · " + record.kind + ": " + record.text,
                        "q-rec-" + (record.id || index))),
                    React.createElement("span", { className: "dsh_tlm_memRecText" }, record.text));
                })))), "l3"));

      if (quoteNote !== null) {
        body.push(React.createElement("p", { className: "dsh_tlm_memQuoteNote", key: "quoteNote" }, quoteNote));
      }

      body.push(React.createElement("p", { className: "dsh_tlm_memNote", key: "recall" },
        t("memRecall", { tool: view.recallTool })));

      return React.createElement("div", { className: "dsh_tlm_mem" }, body);
    }

    // ── 插件本体 ───────────────────────────────────────────────────────
    // 这里只声明**必需**的服务。`settingsScope` 刻意不列进来：
    // `exports.inject` 是**硬依赖**，服务缺席时整个插件 fiber 会永远停在 pending，
    // 宿主启动时据此判定"有条目未激活"并拒绝启动。实测崩溃信息就是：
    //   web boot: 1 entry did not activate
    //     dsh-tri-layer-memory: pending (waiting for service: settingsScope)
    // 一个设置面板绝不该有能力阻止应用启动，因此它属于可降级能力：
    // 改用 ctx.inject() 软等待，服务不来就只是不注册卡片，插件本身照常 active。
    var inject = ["slots", "locale"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, NS + ": settings dictionary");
      useStyleOnce(ctx);

      // 思维栏：对话/轨迹旁边的第三个标签页（`conversation.view` 是 list 槽位，
      // 因此必须给 id）。数据走 session projection，`useProjection(NS)` 是 session
      // 作用域槽位的标准 prop、由框架自动绑定，**所以这里不需要新增任何服务依赖**
      // ——inject 数组保持 ["slots", "locale"] 不变。多一个硬依赖就多一次
      // "fiber 永远 pending → 宿主判启动失败"的机会，这个面板不值得那种能力。
      ctx.slots.inject("conversation.view", function* () {
        yield ctx.slots.register({
          name: "conversation.view",
          id: "memory",
          order: 20,
          locale: NS,
          // label 是 thunk：切换语言时框架重新求值即可，不需要重新注册槽位。
          label: function () { return t("view.memory"); },
        }, TriLayerMemoryView);
      });

      /** 真正注册设置卡片；只有在 settingsScope 可用时才调用。 */
      function registerCard(scoped) {
        var scope = scoped.settingsScope.bind({ namespace: NS });
        var controller = new CardController(scope).prepare(GROUPS);

        // 投影：把 scope 快照 + 暂存状态折成组件要读的纯数据。
        var project = function () {
          var shell = controller.shell();
          var out = {
            available: shell.available,
            writable: shell.writable,
            dirty: shell.dirty,
            saving: shell.saving,
            failed: shell.failed,
            fields: {},
          };
          GROUPS.forEach(function (group) {
            group.fields.forEach(function (f) { out.fields[f.field] = controller.fieldView(f.spec); });
          });
          return out;
        };
        var store = controller.bind(project);

        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register({
            name: "settings.plugin.item",
            key: NS,
            locale: NS,
            inject: function () {
              return {
                hooks: { triLayerCard: store },
                actions: controller.actions(),
                t: t,
              };
            },
          }, TriLayerCard);
        });
      }

      // 软等待 settingsScope：可用即注册卡片，不可用则安静跳过。
      // 兜底判一次 ctx.inject 是否存在，避免宿主换实现时把 apply 打挂。
      if (typeof ctx.inject === "function") {
        ctx.inject(["settingsScope"], registerCard);
      } else if (typeof ctx.get === "function" && ctx.get("settingsScope")) {
        registerCard(ctx);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }

  window.__ModuleLoader__.load({
    id: "dsh-tri-layer-memory",
    factory: triLayerMemoryClientFactory,
  });
})();
