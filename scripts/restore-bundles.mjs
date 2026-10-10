// restore-bundles.mjs — 把被丢掉的两项 bundle 加回 profile 清单。
//
// 背景：2026-10-07 18:01 重新激活插件后，profile 的 bundle 选中列表从 11 项变成 9 项，
// 少了 dsh-live2d-avatar 与 @smalltailqwq/dsh-client-ui-skin-maid-atelier。
// 两者的 link 目标都存在、包也都在 node_modules 里，只是没被选中。
//
// 本脚本**只增不减**：按原始顺序补齐缺失项，不重排、不删除任何现有条目。
// 顺序取自 2026-10-06 的原始备份。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dryRun = process.argv.includes('--dry-run')

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

const manifestPath = join(dshHome(), 'profiles', 'desktop', 'package.json')
if (!existsSync(manifestPath)) throw new Error(`找不到清单：${manifestPath}`)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh.profile.bundles

/** 原始顺序（来自 2026-10-06 备份），作为补齐时的插入位置依据。 */
const canonical = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-schedule-bundle',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@smalltailqwq/dsh-client-ui-skin-deep-whale-manager',
  'dsh-meme',
  '@smalltailqwq/dsh-client-ui-skin-maid-atelier',
  'dsh-live2d-avatar',
  'dsh-tri-layer-memory',
]

const missing = canonical.filter((name) => !bundles.includes(name))
if (missing.length === 0) {
  console.log('清单已完整，无需改动。')
  process.exit(0)
}

// 只补 canonical 里存在、且 dependencies 里有对应声明的项。
const unknown = missing.filter((name) => !(name in (manifest.dependencies ?? {})))
if (unknown.length > 0) {
  console.log(`以下缺失项没有对应的 dependencies 声明，跳过：${unknown.join(', ')}`)
}

const toAdd = missing.filter((name) => name in (manifest.dependencies ?? {}))
// 按 canonical 顺序重建：已选中的保持原位，缺失项插到它在 canonical 里的位置。
const merged = []
for (const name of canonical) {
  if (bundles.includes(name) || toAdd.includes(name)) merged.push(name)
}
// 现有列表里 canonical 之外的条目原样保留在末尾，不丢。
for (const name of bundles) if (!merged.includes(name)) merged.push(name)

console.log('将补充:')
for (const name of toAdd) console.log(`  + ${name}`)
console.log('')
console.log(`条数 ${bundles.length} → ${merged.length}`)
for (const [i, name] of merged.entries()) console.log(`  ${i + 1}. ${name}`)

if (dryRun) {
  console.log('\ndry-run 结束，没有写入。')
  process.exit(0)
}

const backup = `${manifestPath}.before-bundle-restore-${Date.now()}`
copyFileSync(manifestPath, backup)
manifest.dsh.profile.bundles = merged
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`\n已写入。备份 → ${backup}`)
