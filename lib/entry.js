/**
 * entry.js — 插件入口（薄壳）。
 *
 * 真正的实现在同目录的 `impl.js`（由 src/host/*.ts 打包而来）。这里刻意只做一次
 * 「带时间戳的动态 import」：模块会被 Node 的 ESM 缓存按 URL 记住，改完实现再
 * 启用插件时，只有换一个 URL 才能拿到新代码，否则会继续跑上一次加载的那份 ——
 * 症状是"改了代码、重载了插件，报错却一字不变"。
 *
 * 入口本身几乎不用改，因此日常迭代不会再撞上缓存。（同一手法见本工作区的
 * dsh-live2d-avatar/entry.js。）
 */
export const name = 'dsh-tri-layer-memory'

/**
 * **空数组是刻意的。**
 *
 * `exports.inject` 声明的是**硬依赖**：任何一项服务在宿主启动时缺席，插件 fiber 就会
 * 永远停在 `pending`，而宿主把"有条目未激活"判定为启动失败（实测崩溃信息：
 * `web boot: 1 entry did not activate / dsh-tri-layer-memory: pending (waiting for
 * service: ...)`），整个应用打不开。
 *
 * 三层记忆不值得拥有"拖死应用"的能力，因此所有服务都在 apply 内部用
 * `ctx.inject([...], cb)` **软等待**：来了就启用对应能力，不来就少一块功能，
 * 插件本身始终 active。见 src/host/index.ts 与 src/client.js 里的同款说明。
 */
export const inject = []

/**
 * 每次激活都重新加载实现。
 * @param ctx - Host Context（服务在实现内部软等待，不在这里硬声明）。
 * @param config - 组合行配置（cordis.patch.yml 中本插件行的 `config:`）。
 * @returns 实现侧 apply 的返回值。
 */
export async function apply(ctx, config) {
  const url = new URL('./impl.js', import.meta.url)
  url.searchParams.set('generation', String(Date.now()))
  const implementation = await import(url.href)
  return implementation.apply(ctx, config)
}
