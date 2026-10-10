// _occlpix.mjs — 像素级遮挡证据：同一区域截两次，一次隐藏可疑元素，一次正常，
// 然后由 _occlpix.py 做像素差分。若两次完全一致 → 该元素没有吃掉任何可见墨迹。
// 用法: node _occlpix.mjs <tag> [htmlPath]
import { spawn } from 'node:child_process'
import { copyFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'

const TAG = process.argv[2] || 'run'
const SRC = process.argv[3] || 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design\\思维栏 v0.html'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const TMP = `${DIR}\\_occlpix.html`
const OUT = `${DIR}\\_headcheck-out`
mkdirSync(OUT, { recursive: true })
copyFileSync(SRC, TMP)

const PORT = 9340 + (TAG === 'after' ? 1 : 0)
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-occlpix', '--remote-debugging-port=' + PORT, 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
  } catch { /* not up */ }
  if (!wsUrl) await sleep(500)
}
if (!wsUrl) { console.error('FAIL: CDP 没起来'); child.kill(); process.exit(1) }
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_occlpix.html' })
await sleep(2500)
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value

const meta = {}
for (const w of [1280, 1440, 420]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w <= 420 })
  await sleep(600)
  const clip = await ev(`(() => { const t=document.querySelector('#mainline').closest('.sec'); const r=t.getBoundingClientRect(); return { x:0, y:Math.max(0,Math.round(r.top+window.scrollY)), width:${w}, height:Math.round(r.height), scale:1 }; })()`)
  // 组头的页面坐标（用于把差分区域映射回具体组）
  meta[w] = {
    clip,
    heads: await ev(`[...document.querySelectorAll('.grp-head')].map(h=>{const r=h.getBoundingClientRect(); const d=h.querySelector('.dot').getBoundingClientRect(); return { top:Math.round(r.top+window.scrollY), h:Math.round(r.height), label:h.querySelector('.span').textContent, dotRect:[Math.round(d.left),Math.round(d.top+window.scrollY),Math.round(d.width),Math.round(d.height)] }; })`),
  }
  const shotA = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
  writeFileSync(`${OUT}\\${TAG}-on-${w}.png`, Buffer.from(shotA.result.data, 'base64'))
  // 隐藏可疑元素
  await ev(`[...document.querySelectorAll('.grp-head .dot')].forEach(d=>d.style.visibility='hidden'); 'ok'`)
  await sleep(200)
  const shotB = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
  writeFileSync(`${OUT}\\${TAG}-off-${w}.png`, Buffer.from(shotB.result.data, 'base64'))
  await ev(`[...document.querySelectorAll('.grp-head .dot')].forEach(d=>d.style.visibility=''); 'ok'`)
  console.log(`[${TAG}] ${w}px clip=${JSON.stringify(clip)} heads=${meta[w].heads.length}`)
}
writeFileSync(`${DIR}\\_occlpix-${TAG}.json`, JSON.stringify(meta, null, 2), 'utf8')
ws.close(); child.kill()
await sleep(600)
rmSync(TMP, { force: true })
rmSync(DIR + '\\.edge-occlpix', { recursive: true, force: true })
process.exit(0)
