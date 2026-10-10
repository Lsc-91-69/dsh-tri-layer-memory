// _verify-final.mjs — 在**最终交付文件**上跑一次浏览器验收（ASCII 临时副本绕开 file:// 中文名）。
// 不修改交付文件；跑完删掉临时副本。
import { spawn } from 'node:child_process'
import { copyFileSync, rmSync, writeFileSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const SRC = DIR + '\\思维栏 v0.html'
const TMP = DIR + '\\_final-check.html'
const PORT = 9336
copyFileSync(SRC, TMP)

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-verify', '--remote-debugging-port=' + PORT, 'about:blank',
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
if (!wsUrl) { console.error('FAIL: CDP 没起来'); process.exit(1) }
const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
const logs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300))
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('ERROR ' + m.params.entry.text)
})
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_final-check.html' })
await sleep(2500)
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value
const res = await ev(`(() => {
  const q=(s)=>document.querySelectorAll(s).length;
  const rows=[...document.querySelectorAll('.row')];
  return {
    rows: rows.length, groups: q('.grp'), recs: q('.rec'), sessions: q('.sess'),
    nowRows: rows.filter(r=>r.classList.contains('is-now')).length,
    taskTitle: document.querySelector('#task-title').textContent.slice(0,30),
    l2sec: q('.l2-sec'), l2stat: document.querySelector('#l2-stat').textContent,
    l3stat: document.querySelector('#l3-stat').textContent.slice(0,40),
    twDisplay: getComputedStyle(document.querySelector('.tw')).display,
    launchDisplay: getComputedStyle(document.querySelector('#tw-open')).display,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    blank: [...document.querySelectorAll('.row-title h4,.row-cause,.rec-text,.task-title')].filter(e=>!e.textContent.trim()).length,
    quoteOpacity: getComputedStyle(rows[0].querySelector('.qbtn')).opacity,
  };
})()`)
console.log('FINAL RENDER ' + JSON.stringify(res, null, 1))
console.log('CONSOLE ' + JSON.stringify(logs))
writeFileSync(DIR + '\\_verify-final.json', JSON.stringify({ res, logs }, null, 2), 'utf8')
ws.close(); child.kill()
await sleep(600)
rmSync(TMP, { force: true })
rmSync(DIR + '\\.edge-verify', { recursive: true, force: true })
console.log('cleaned tmp')
process.exit(0)
