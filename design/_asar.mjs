// _asar.mjs — 从 app.asar 里列出/读取文件（只读，不解包）。
// 用法：node _asar.mjs list <substr>
//       node _asar.mjs read <内路径>
import { readFileSync } from 'node:fs'

const ASAR = 'D:\\deepseek\\deepseek_win\\resources\\app.asar'
const fd = readFileSync(ASAR)
const headerSize = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'))
const base = 16 + headerSize

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix + '/' + name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, size: entry.size, offset: Number(entry.offset) })
  }
  return out
}
const all = walk(header, '', [])

const [, , cmd, arg] = process.argv
if (cmd === 'list') {
  const hit = all.filter((f) => f.path.includes(arg))
  for (const f of hit) console.log(f.size.toString().padStart(9), f.path)
  console.error(`[list] ${hit.length}/${all.length}`)
} else if (cmd === 'read') {
  const f = all.find((x) => x.path === arg)
  if (!f) { console.error('not found'); process.exit(1) }
  process.stdout.write(fd.subarray(base + f.offset, base + f.offset + f.size))
}
