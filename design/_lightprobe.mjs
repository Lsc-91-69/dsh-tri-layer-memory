// _lightprobe.mjs — 浅色主题下再看一遍：面板颜色全部来自 --dsw-*，
// 宿主换主题时它必须跟着变（不能有硬编码 hex 把某一块钉死在深色上）。
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const OUT = `${DIR}\\_headcheck-out`
const PORT = 9354
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-lightprobe', '--remote-debugging-port=' + PORT, 'about:blank',
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
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_pluginview-light.html' })
await sleep(2000)
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value

const res = await ev(`(() => {
  const cs = (sel, pseudo) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e, pseudo || null);
    return { color: s.color, background: s.backgroundColor, borderColor: s.borderTopColor, boxShadow: s.boxShadow }; };
  const lum = (rgb) => { const m = String(rgb).match(/\\d+/g); return m ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 : null; };
  const title = cs('.dsh_tlm_memRowTitle'), anchor = cs('.dsh_tlm_memAnchor'), cause = cs('.dsh_tlm_memRowCause');
  const now = document.querySelector('.dsh_tlm_memRow.isNow');
  return {
    bodyBg: getComputedStyle(document.body).backgroundColor,
    title, anchor, cause,
    titleOnBg: lum(title.color) - lum(getComputedStyle(document.body).backgroundColor),
    anchorOnBg: lum(anchor.color) - lum(getComputedStyle(document.body).backgroundColor),
    nowShadow: now ? getComputedStyle(now).boxShadow : null,
    nowBg: now ? getComputedStyle(now).backgroundColor : null,
    chip: cs('.dsh_tlm_memNowChip'),
    sessBg: cs('.dsh_tlm_memSess'),
    grpLabel: cs('.dsh_tlm_memGrpLabel'),
    quoteBorder: cs('.dsh_tlm_memQuote'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
})()`)
console.log('LIGHT ' + JSON.stringify(res, null, 1))
const clip = await ev(`({ w: document.documentElement.scrollWidth, h: Math.min(document.documentElement.scrollHeight, 6000) })`)
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: clip.w, height: clip.h, scale: 1 } })
if (shot.result?.data) writeFileSync(`${OUT}\\plugin-light-top.png`, Buffer.from(shot.result.data, 'base64'))
console.log('saved plugin-light-top.png')
ws.close(); child.kill()
await sleep(500)
rmSync(DIR + '\\.edge-lightprobe', { recursive: true, force: true })
process.exit(0)
