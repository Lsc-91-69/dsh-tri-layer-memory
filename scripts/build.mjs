/**
 * scripts/build.mjs — 构建 dsh-tri-layer-memory。
 *
 * 三个产物：
 * - src/host/index.ts → lib/impl.js（esbuild 打包，真正的实现）
 *   外部化 @deepseek-ai/* 与 dsh-*：这些包若被内联会产生两份 cordis Service
 *   定义，于是 ctx.tools / ctx.settings 不再是同一个服务实例。
 * - src/entry.js     → lib/index.js（逐字复制，薄壳）
 *   入口用「带时间戳的动态 import」加载 impl.js，绕开 Node 的 ESM 按 URL 缓存，
 *   使改完实现只需停用/启用一次插件即可生效。
 * - src/client.js    → lib/client.js（逐字复制）
 *   浏览器半边是 plain-JS factory，运行时按原样 materialize，不做任何转换。
 *
 * esbuild 解析顺序：`$DSH_ESBUILD` 显式指定 → 常规 node_modules → 若干本地
 * 候选路径。找不到时给出可执行的修复指引，而不是抛一个 ENOENT。
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 依次尝试解析 esbuild；返回模块命名空间或 null。 */
async function loadEsbuild() {
  const candidates = []
  if (process.env.DSH_ESBUILD) candidates.push(pathToFileURL(join(process.env.DSH_ESBUILD, 'lib/main.js')).href)
  // 本机部署根/兄弟工程的 node_modules 链（开发期常见位置）。
  for (const guess of [
    'D:/deepseek/deepseekh_work/node_modules/esbuild/lib/main.js',
    'D:/deepseek/deepseekh_work/meridian/node_modules/esbuild/lib/main.js',
  ]) {
    if (existsSync(guess)) candidates.push(pathToFileURL(guess).href)
  }
  try {
    return await import('esbuild')
  } catch {
    // 常规解析失败，继续走候选路径。
  }
  for (const href of candidates) {
    try {
      return await import(href)
    } catch {
      // 这个候选不可用，试下一个。
    }
  }
  return null
}

const esbuild = await loadEsbuild()
if (esbuild === null) {
  console.error(
    '[dsh-tri-layer-memory] 找不到 esbuild。\n'
    + '  修复方式（任选其一）：\n'
    + '    1) 在包目录执行 `npm install`（devDependencies 里已声明 esbuild）；\n'
    + '    2) 设置环境变量 DSH_ESBUILD 指向某个 esbuild 包目录。\n'
    + '  说明：lib/ 产物随仓库提交，最终用户安装本插件时**不需要** esbuild。',
  )
  process.exit(1)
}

mkdirSync(join(root, 'lib'), { recursive: true })

await esbuild.build({
  entryPoints: [join(root, 'src/host/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: join(root, 'lib/impl.js'),
  sourcemap: true,
  // `zod` 被内联（外部模块名在 profile 里解析不到，静态 import 会让整个插件
  // failed to import），未压缩时产物 ~850 KB。minify 把它压到约三分之一；
  // sourcemap 保留，栈里仍能看到原始位置。
  minify: true,
  // esbuild 默认 charset 是 ascii，会把中文串转义成 \uXXXX：既让产物里搜不到
  // 中文（排查时误以为代码没进去），又比 UTF-8 多占字节。显式设 utf8。
  charset: 'utf8',
  logLevel: 'info',
  external: ['@deepseek-ai/*', 'dsh-*', '@wanyantiande/*', 'node:*'],
})
copyFileSync(join(root, 'src/entry.js'), join(root, 'lib/entry.js'))
copyFileSync(join(root, 'src/client.js'), join(root, 'lib/client.js'))
console.log('[dsh-tri-layer-memory] built lib/entry.js + lib/impl.js + lib/client.js')
