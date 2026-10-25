#!/usr/bin/env node
/**
 * compat-check.mjs — 对着**真实安装的宿主**核对本插件依赖的 API 面。
 *
 * **为什么需要它**：`npm run verify` 里的 75 项「契约检查」读的是本仓库自己的
 * `src/host/*.ts`，全是自洽检查——宿主升级时它们一项都不会失败。历史上三次
 * 兼容性事故（客户端硬注入服务、`session.events` 字段不存在、`usage` 塞错位置）
 * 全都是「本仓库自洽 + 宿主已变」造成的，没有一次被契约检查拦住。
 *
 * 本脚本只读 `app.asar`，不改任何东西，也不连宿主运行时。
 * 它证明的是「我依赖的符号在装好的宿主里还在、签名没变」，
 * 不能证明「跑起来行为一致」——后者只能靠真机。
 *
 * 用法：
 *   node scripts/compat-check.mjs                 # 自动找 app.asar
 *   node scripts/compat-check.mjs --asar <path>   # 指定 app.asar
 *   node scripts/compat-check.mjs --json          # 机器可读输出
 *
 * 退出码：0 全部通过 / 1 有 FAIL / 2 找不到 app.asar
 */
import { openSync, readSync, closeSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─────────────────────────── app.asar 只读访问 ───────────────────────────

/**
 * asar 文件格式：8 字节 pickle 头 + 4 字节 headerSize（偏移 12）+ JSON 目录树 + 数据段。
 * 刻意不依赖 `@electron/asar`：这个脚本要在没装任何依赖的机器上也能跑。
 */
function openAsar(path) {
  const fd = openSync(path, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const raw = Buffer.alloc(headerSize)
  readSync(fd, raw, 0, headerSize, 16)
  const tree = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''))
  const base = 16 + headerSize

  /** 按 '/' 分段走到目录树节点；不存在返回 null。 */
  function node(p) {
    let cur = tree
    for (const seg of p.split('/').filter(Boolean)) {
      if (!cur || !cur.files || !cur.files[seg]) return null
      cur = cur.files[seg]
    }
    return cur
  }

  return {
    /** 列目录；不是目录返回 null。 */
    list(p) {
      const n = node(p)
      return n && n.files ? Object.keys(n.files) : null
    },
    /** 读文本；不存在或不是文件返回 null。 */
    read(p) {
      const n = node(p)
      if (!n || n.files) return null
      const off = Number(n.offset)
      if (!Number.isFinite(off) || !Number.isFinite(n.size)) return null
      const buf = Buffer.alloc(n.size)
      readSync(fd, buf, 0, n.size, base + off)
      return buf.toString('utf8')
    },
    close() { closeSync(fd) },
  }
}

/** 在若干候选路径里找一个存在的 app.asar。 */
function findAsar(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null
  const candidates = [
    'D:/deepseek/deepseek_win/resources/app.asar',
    'C:/Program Files/DeepSeek Harness/resources/app.asar',
    join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar'),
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

// ─────────────────────────── 断言工具 ───────────────────────────

const DSH = 'dsh/node_modules/@deepseek-ai'

/**
 * 一次检查的三种必需信息：
 * @param what  - 断了会怎样（人话，写清后果）
 * @param check - () => { ok, actual } —— actual 会原样打出来当证据
 */
function contract(check, what, name) {
  let r
  try { r = check() } catch (e) { r = { ok: false, actual: `异常: ${e.message}` } }
  return { name, what, ok: Boolean(r.ok), actual: r.actual ?? '' }
}

// ─────────────────────────── 契约清单 ───────────────────────────

/**
 * 每条都对应插件里一处**真实依赖**，不是"顺便测测"。
 * grep 源码能看到对应位置（注释里标了）。
 */
function buildContracts(asar) {
  const read = (p) => asar.read(p)
  const list = (p) => asar.list(p)
  const has = (text, needle) => text !== null && text.includes(needle)

  // 宿主包清单：后面很多检查要先确认包在不在。
  const pkgs = list(`${DSH}`) ?? []
  const pkgExists = (n) => pkgs.includes(n)

  return [
    // ── 投影注册：src/host/projection.ts 的 register({ stateVersion, stateSchema, init, apply, wire })
    contract(() => {
      const t = read(`${DSH}/dsh-session-projection/lib/index.js`)
      const missing = ['stateVersion', 'stateSchema', 'wire', 'init', 'apply', 'register']
        .filter((k) => !has(t, k))
      return { ok: t !== null && missing.length === 0, actual: t === null ? '包不存在' : (missing.length ? `缺 ${missing.join(', ')}` : '六个字段齐全') }
    }, '投影注册失败 → 思维栏永远空白', 'sessionProjections.register 契约'),

    // session/created 的补算路径靠它（src/host/index.ts 的 session/created 监听）
    contract(() => {
      const t = read(`${DSH}/dsh-session-projection/lib/index.js`)
      // 版本不匹配时宿主会丢弃落盘行 —— 这是 stateVersion 必须 bump 的依据
      const ok = has(t, 'stateVersion !== ')
      return { ok, actual: ok ? '版本不匹配会丢弃落盘行（bump 依据仍成立）' : '校验逻辑变了，需重读' }
    }, '投影缓存复用了旧语义的状态 → 修复静默失效', 'stateVersion 失配丢弃行'),

    // ── 事件读取：src/host/index.ts 的 readEvents() 走 snapshotEvents
    contract(() => {
      const t = read(`${DSH}/dsh-session/lib/index.js`)
      const ok = has(t, 'snapshotEvents(') && has(t, 'ownEvents(')
      return { ok, actual: ok ? 'snapshotEvents / ownEvents 均在' : 'readEvents 会恒返回空 → L1/L2/骨架全静默失效' }
    }, 'L1/L2/主线骨架全部静默失效', 'Session.snapshotEvents'),

    // ── 事件形状：src/host/l1-working.ts 的 messageBody()
    //    user/message 体在 data；assistant/message、tool/result 体在 data.message
    contract(() => {
      const t = read(`${DSH}/dsh-session/lib/types/index.js`)
      const userAtData = has(t, "case 'user/message':") && /case 'user\/message':\s*\n\s*deepFreeze\(event\.data\)/.test(t)
      const msgAtMessage = /case 'assistant\/message':[\s\S]{0,200}?deepFreeze\(event\.data\.message\)/.test(t)
      return {
        ok: userAtData && msgAtMessage,
        actual: userAtData && msgAtMessage
          ? 'user→data / assistant·tool→data.message（与 messageBody 一致）'
          : `形状变了：user@data=${userAtData} msg@data.message=${msgAtMessage}`,
      }
    }, 'L1 只读到用户文本、L2 从残缺素材生成（曾发生，charCount 少算 ~75×）', '消息体落点 data / data.message'),

    // 插件逐字依赖这些事件类型名
    contract(() => {
      const t = (read(`${DSH}/dsh-session/lib/types/known-event-types.js`) ?? '')
        + (read(`${DSH}/dsh-session/lib/types/index.js`) ?? '')
      const need = ['user/message', 'assistant/message', 'tool/call', 'tool/result',
        'agent/inbox', 'compaction/summary', 'turn/start']
      const missing = need.filter((n) => !has(t, n))
      return { ok: missing.length === 0, actual: missing.length ? `缺 ${missing.join(', ')}` : `${need.length} 个事件类型齐全` }
    }, '对应那一部分记忆直接缺失', '事件类型名'),

    // ── 客户端：src/client.js 的 require / 槽位 / 标准 props
    contract(() => {
      const t = read(`${DSH}/dsh-client-ui-conversation/lib/client.js`)
      const ok = has(t, 'conversation.view')
      return { ok, actual: ok ? '槽位存在' : '思维栏注册不到位置' }
    }, '思维栏整个消失（没有挂载点）', 'conversation.view 槽位'),

    contract(() => {
      const t = read(`${DSH}/dsh-client-ui-conversation/lib/client.js`)
      const need = ['inputActions', 'useInput', 'useProjection']
      const missing = need.filter((k) => !has(t, k))
      return { ok: missing.length === 0, actual: missing.length ? `缺 ${missing.join(', ')}` : '三个标准 prop 都在' }
    }, '「引用」按钮失效 / 面板读不到投影 / 渲染降级', 'conversation.view 标准 props'),

    // client.js 顶部 require 的两个模块必须由客户端模块表提供。
    // **不要在本机 node_modules 里找它们**：dsh-client-store 不是 npm 包，
    // 是构建期注入的虚拟模块（宿主自己的 client 包也用同一个 require）。
    contract(() => {
      const t = read(`${DSH}/dsh-client-ui-trajectory/lib/client.js`)
      const ok = has(t, 'require("@deepseek-ai/dsh-client-store")')
      return { ok, actual: ok ? '宿主自己的 client 包在用同一个 require（虚拟模块由模块表提供）' : '既有写法变了，需重查模块来源' }
    }, '客户端 import 失败 → 整个 web boot 起不来', 'dsh-client-store 虚拟模块'),

    // ── LLM seam：src/host/l2-short.ts 的 callWithEffortRetry
    contract(() => {
      const t = read(`${DSH}/dsh-llm-pi-ai/lib/index.js`)
      const ok = has(t, 'reasoningEffort') || has(t, 'reasoningEfforts')
      return { ok, actual: ok ? '档位字段存在' : 'L2/cause 推理档位失效 → 退回抽取式' }
    }, 'L2 摘要与 cause 回填退回机械抽取', 'reasoningEffort 字段'),

    // ── 部署与自更新链路
    contract(() => {
      const ok = pkgExists('dsh-plugin-manager')
      const t = ok ? read(`${DSH}/dsh-plugin-manager/lib/index.js`) : null
      return { ok: ok && has(t, 'writePluginEnabled'), actual: ok ? (has(t, 'writePluginEnabled') ? 'set_bundle 链路在' : 'writePluginEnabled 不见了') : '包不存在' }
    }, '自更新流程（set_bundle 重新激活）断掉', 'dsh-plugin-manager'),

    // A 类事故：致命错误恢复会把 bundles 整体替换成出厂集合
    contract(() => {
      const t = read(`${DSH}/dsh-app-boot/lib/index.js`)
      const ok = has(t, 'sanitizeProfile')
      return { ok, actual: ok ? 'sanitizeProfile 仍在（致命错误时会抹 patch 并把 bundles 换成出厂集合）' : '恢复机制变了，profile-guard.mjs 的判据需重读' }
    }, 'profile-guard 的「恢复指纹」判据失效', 'sanitizeProfile'),
  ]
}

// ─────────────────────────── 主流程 ───────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const asarPath = findAsar(argv.includes('--asar') ? argv[argv.indexOf('--asar') + 1] : undefined)
  const asJson = argv.includes('--json')

  if (!asarPath) {
    console.error('找不到 app.asar。用 --asar <path> 指定。')
    process.exit(2)
  }

  const asar = openAsar(asarPath)
  let results
  let version = '?'
  try {
    const pj = asar.read('dsh/package.json')
    if (pj) version = JSON.parse(pj).version
    results = buildContracts(asar)
  } catch (e) {
    asar.close()
    console.error(`读取 app.asar 失败：${e.message}`)
    process.exit(2)
  }
  asar.close()

  const fail = results.filter((r) => !r.ok)

  if (asJson) {
    console.log(JSON.stringify({ asar: asarPath, version, results }, null, 2))
  } else {
    console.log(`宿主: ${asarPath}`)
    console.log(`版本: ${version}`)
    console.log(`本插件依赖的契约: ${results.length} 项\n`)
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
      console.log(`        ${r.actual}`)
      if (!r.ok) console.log(`        后果：${r.what}`)
    }
    console.log('')
    console.log(fail.length === 0
      ? `${results.length}/${results.length} 契约通过`
      : `${fail.length}/${results.length} 项不兼容 —— 先修这些再部署`)
  }

  process.exit(fail.length === 0 ? 0 : 1)
}

main()
