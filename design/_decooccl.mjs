// _decooccl.mjs — 同类问题自查：把设计里所有「装饰性元素」逐个隐藏，各截一张全页图，
// 交给 _decooccl.py 差分。若隐藏某装饰后**变亮**的像素亮度 >120（=文字级亮度），
// 说明该装饰压住了文字。覆盖：组头方块、轮次刻度、贯穿刻度线、分类竖条、L2 caret。
// 用法: node _decooccl.mjs <tag> [htmlPath]
import { spawn } from 'node:child_process'
import { copyFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'

const TAG = process.argv[2] || 'run'
const SRC = process.argv[3] || 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design\\思维栏 v0.html'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const TMP = `${DIR}\\_decooccl.html`
const OUT = `${DIR}\\_headcheck-out`
mkdirSync(OUT, { recursive: true })
copyFileSync(SRC, TMP)

// 每个装饰：注入的 CSS + 说明（注入 <style> 而不是改元素，伪元素也能关掉）
// 一律用 visibility:hidden 而不是 display:none —— 后者会让**参与布局**的装饰
// （.cat::before 是 inline-flex 的 flex item）触发重排，整行文字位移，
// 差分里就会冒出一大片假阳性（实测 420px 下假阳性 20 万像素）。
const DECOS = [
  { name: 'grp-dot', css: '.grp-head .dot{visibility:hidden !important}' },
  { name: 'row-tick', css: '.anchor .tick{visibility:hidden !important}' },
  { name: 'spine', css: '.track::before{visibility:hidden !important}' },
  { name: 'cat-bar', css: '.cat::before{visibility:hidden !important}' },
  { name: 'caret', css: '.caret{visibility:hidden !important}' },
]

const PORT = 9344
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-decooccl', '--remote-debugging-port=' + PORT, 'about:blank',
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
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_decooccl.html' })
await sleep(2600)
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value

const meta = {}
for (const w of [1280, 1440, 420]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w <= 420 })
  await sleep(600)
  // 全部展开，让 L2/L3 的 caret 与记录都在渲染树里
  await ev(`document.querySelectorAll('details').forEach(d=>d.open=true); 'ok'`)
  await sleep(400)
  const doc = await ev(`(() => { const h=document.documentElement.scrollHeight; return { w: document.documentElement.scrollWidth, h }; })()`)
  meta[w] = { doc, texts: await ev(`(() => {
    const out=[];
    for (const e of document.querySelectorAll('h1,h2,h3,h4,h5,p,span,button,summary,li,div,code,b,i')) {
      const t=[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
      if(!t) continue;
      const r=e.getBoundingClientRect(); if(!r.width||!r.height) continue;
      out.push({ tag:e.tagName, cls:String(e.className).slice(0,40), t:t.slice(0,24), y:Math.round(r.top+window.scrollY), x:Math.round(r.left), w:Math.round(r.width) });
    }
    return out;
  })()`) }
  const clip = { x: 0, y: 0, width: Math.min(w, doc.w), height: Math.min(doc.h, 16000), scale: 1 }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
    writeFileSync(`${OUT}\\deco-${TAG}-${w}-${name}.png`, Buffer.from(r.result.data, 'base64'))
  }
  await shot('base')
  for (const d of DECOS) {
    await ev(`(() => { let s=document.getElementById('__deco'); if(!s){ s=document.createElement('style'); s.id='__deco'; document.head.appendChild(s);} s.textContent=${JSON.stringify(d.css)}; return 'ok'; })()`)
    await sleep(250)
    await shot(d.name)
  }
  await ev(`(() => { const s=document.getElementById('__deco'); if(s) s.textContent=''; return 'ok'; })()`)
  console.log(`[${TAG}] ${w}px doc=${doc.w}x${doc.h} texts=${meta[w].texts.length}`)
}
writeFileSync(`${DIR}\\_decooccl-${TAG}.json`, JSON.stringify(meta, null, 2), 'utf8')
ws.close(); child.kill()
await sleep(600)
rmSync(TMP, { force: true })
rmSync(DIR + '\\.edge-decooccl', { recursive: true, force: true })
process.exit(0)
