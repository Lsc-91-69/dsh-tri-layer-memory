/**
 * scripts/lib-session-log.mjs — 只读工具：把 DSH 会话日志（zstd 多帧）读成事件数组。
 *
 * 为什么需要自己解帧：`session.v4.jsonl.zstd` **不是**一个 zstd 帧，而是"每次追加写一个
 * 独立帧"拼起来的文件（实测 session-5b59b635：8.2 MB / 3155 个帧）。Node 的
 * `zstdDecompressSync` 与流式解码器都**只解第一帧就停**——照直用会得到一个 206 字节的
 * 「日志」，里面只有 session 头，看起来像"这个会话没有历史"。这正是本次测量要避开的
 * 那类静默故障，所以在读日志这一层就把它修掉：按 zstd 帧魔数切分，逐帧解码。
 *
 * 切分策略不做假设：遇到某个候选起点解不开，就把它让给下一个候选（压缩数据里也可能
 * 偶然出现魔数字节）。解不开的字节只在真正解不出任何东西时才报错。
 *
 * 只读，不写任何文件。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** zstd 帧魔数（little-endian 0x28 B5 2F FD）。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志所在目录命名规则：`--<cwd 把非字母数字换成 ->>--`。 */
export function sessionDir(cwd = process.cwd()) {
  // 实测目录名会把 `_` 保留下来（`--D-deepseek-deepseekh_work--`），所以不能把
  // 非字母数字一律换成 `-`：那样会拼出一个不存在的目录，而报错信息看起来像
  // "这个会话没有日志"。
  const slug = cwd.replace(/[^A-Za-z0-9_]/g, '-').replace(/-+/g, '-')
  return join(homedir(), '.dsh', 'sessions', `--${slug.replace(/^-/, '')}--`)
}

/**
 * 把多帧 zstd 文件解成字节。
 * @param file - zstd 文件路径。
 * @returns 解压后的完整 UTF-8 文本。
 */
export function decodeZstdFrames(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) starts.push(i)
  const parts = []
  let cursor = 0
  let decoded = 0
  while (cursor < buf.length) {
    const start = starts.find((s) => s >= cursor)
    if (start === undefined) break
    let ok = false
    // 从最近的候选起点往后试：解不开就换下一个候选（可能是压缩数据里的假魔数）。
    for (const end of [...starts.filter((s) => s > start), buf.length]) {
      try {
        parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
        cursor = end
        decoded += 1
        ok = true
        break
      } catch {
        // 这个边界不对，继续往后扩展。
      }
    }
    if (!ok) break
  }
  if (decoded === 0) throw new Error(`无法从 ${file} 解出任何 zstd 帧`)
  return parts.join('')
}

/**
 * 读一个会话的全部事件。
 * @param sessionId - 会话 id。
 * @param cwd - 工作目录（决定 sessions 下的目录名）。
 * @returns 事件数组（按文件顺序）。
 */
export function readSessionEvents(sessionId, cwd = process.cwd()) {
  const dir = sessionDir(cwd)
  return readSessionFile(join(dir, sessionId, 'session.v4.jsonl.zstd'))
}

/**
 * 从一个**快照文件**读事件。
 *
 * 为什么必须有这条路径：会话是活的，测量期间日志还在增长（实测两次运行之间多出一条
 * turn，边界/约束类句数从 398 变 406）。不冻结快照，报告里的数字就无法复现——
 * 那不是测量，是取样。
 *
 * @param file - session.v4.jsonl.zstd 的路径（真实日志或 .tmp-diff 里的副本）。
 * @returns 事件数组与文件路径。
 */
export function readSessionFile(file) {
  const text = decodeZstdFrames(file)
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // 单行损坏：跳过，但要计数，不能让"解析失败"表现成"没有这条事件"。
      events.push({ type: '__unparsable__', raw: trimmed.slice(0, 200) })
    }
  }
  return { file, events }
}
