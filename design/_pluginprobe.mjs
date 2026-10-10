// _pluginprobe.mjs — 在浏览器里检查**插件渲染出来的面板**（_pluginview.html）。
// 覆盖：几何与遮挡（隐藏装饰做像素差分）、计算样式（字号/颜色/不透明度）、
// 悬停交互（引用按钮 opacity 0 → 1）、窄屏媒体查询、横向溢出。
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const OUT = `${DIR}\\_headcheck-out`
mkdirSync(OUT, { recursive: true })
const PORT = 9350
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-pluginprobe', '--remote-debugging-port=' + PORT, 'about:blank',
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
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_pluginview.html' })
await sleep(2000)
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true })
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }
  return r.result?.result?.value
}
const setDecor = (css) => ev(`(() => { let s=document.getElementById('__probe'); if(!s){s=document.createElement('style');s.id='__probe';document.head.appendChild(s);} s.textContent=${JSON.stringify(css)}; return 'ok'; })()`)
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) })
  if (r.result?.data) writeFileSync(`${OUT}\\${name}.png`, Buffer.from(r.result.data, 'base64'))
  return r.result?.data ? 'ok' : 'FAIL'
}

const report = { widths: {}, console: [] }
for (const w of [800, 420]) {
  // mobile:false —— mobile 模式在**没有** <meta name="viewport"> 的页面上会把布局视口
  // 固定成 980px，媒体查询根本不匹配（第一版就是这么得出"窄屏没生效"的假象）。
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  await setDecor('')
  const doc = await ev(`({ w: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight })`)
  const clip = { x: 0, y: 0, width: Math.min(w, doc.w), height: Math.min(doc.h, 12000), scale: 1 }
  await shot(`plugin-${w}-base`, clip)
  await setDecor('.dsh_tlm_memGrpHead::before{visibility:hidden !important}')
  await shot(`plugin-${w}-nodot`, clip)
  await setDecor('.dsh_tlm_memAnchor::before{visibility:hidden !important}')
  await shot(`plugin-${w}-notick`, clip)
  await setDecor('.dsh_tlm_memTrack::before{visibility:hidden !important}')
  await shot(`plugin-${w}-nospine`, clip)
  await setDecor('')

  // 计算样式：分权（字号/颜色/粗细）、当前轮签名、引用按钮
  const styles = await ev(`(() => {
    const g = (sel) => document.querySelector(sel);
    const cs = (sel, pseudo) => { const e = g(sel); if (!e) return null; const s = getComputedStyle(e, pseudo || null);
      return { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, fontFamily: s.fontFamily.slice(0, 40),
        opacity: s.opacity, boxShadow: s.boxShadow, background: s.backgroundColor, borderTop: s.borderTopWidth,
        whiteSpace: s.whiteSpace, display: s.display, textAlign: s.textAlign, paddingLeft: s.paddingLeft }; };
    const rows = [...document.querySelectorAll('.dsh_tlm_memRow')];
    const now = rows.filter(r => r.classList.contains('isNow'));
    const heads = [...document.querySelectorAll('.dsh_tlm_memGrpHead')];
    const labels = heads.map(h => h.querySelector('.dsh_tlm_memGrpLabel').textContent);
    const dot = heads[0] ? getComputedStyle(heads[0], '::before') : null;
    const head0 = heads[0] ? heads[0].getBoundingClientRect() : null;
    const label0 = heads[0] ? heads[0].querySelector('.dsh_tlm_memGrpLabel').getBoundingClientRect() : null;
    return {
      groups: heads.length, labels,
      rows: rows.length, nowRows: now.length,
      nowRowTexts: now.map(r => r.querySelector('.dsh_tlm_memAnchor').textContent + r.querySelector('.dsh_tlm_memRowTitle').textContent.trim()),
      nowBadges: document.querySelectorAll('.dsh_tlm_memNowBadge').length,
      sessions: [...document.querySelectorAll('.dsh_tlm_memSess')].map(d => ({ open: d.open, text: d.querySelector('.dsh_tlm_memSessSum').textContent })),
      anchor: cs('.dsh_tlm_memAnchor'), anchorTick: cs('.dsh_tlm_memAnchor', '::before'),
      title: cs('.dsh_tlm_memRowTitle'), cause: cs('.dsh_tlm_memRowCause'),
      grpHead: cs('.dsh_tlm_memGrpHead'), grpLabel: cs('.dsh_tlm_memGrpLabel'),
      quote: cs('.dsh_tlm_memQuote'), quoteVisible: [...document.querySelectorAll('.dsh_tlm_memQuote')].filter(b => getComputedStyle(b).opacity === '1').length,
      nowRow: now[0] ? { boxShadow: getComputedStyle(now[0]).boxShadow, background: getComputedStyle(now[0]).backgroundColor, anchorColor: getComputedStyle(now[0].querySelector('.dsh_tlm_memAnchor')).color } : null,
      dotPseudo: dot ? { left: dot.left, top: dot.top, width: dot.width, height: dot.height, background: dot.backgroundColor, position: dot.position } : null,
      dotOverlapsLabel: (dot && head0 && label0) ? (parseFloat(dot.left) + parseFloat(dot.width) > (label0.left - head0.left) ? true : false) : null,
      grpLabelLeftInHead: (head0 && label0) ? +(label0.left - head0.left).toFixed(1) : null,
      chipText: document.querySelector('.dsh_tlm_memNowChip') ? document.querySelector('.dsh_tlm_memNowChip').textContent : null,
      chipTitle: document.querySelector('.dsh_tlm_memNowChip') ? document.querySelector('.dsh_tlm_memNowChip').title : null,
      locate: document.querySelector('.dsh_tlm_memLocate') ? document.querySelector('.dsh_tlm_memLocate').textContent : null,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight,
      bg: getComputedStyle(document.body).backgroundColor,
    };
  })()`)

  // 悬停：鼠标移到某一行上，引用按钮应当从 opacity:0 变成 1
  const box = await ev(`(() => { const r=document.querySelectorAll('.dsh_tlm_memRow')[3].getBoundingClientRect(); return { x: Math.round(r.left+8), y: Math.round(r.top+r.height/2) }; })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
  await sleep(400)
  const hoverQuote = await ev(`(() => { const r=document.querySelectorAll('.dsh_tlm_memRow')[3]; const b=r.querySelector('.dsh_tlm_memQuote'); return b ? getComputedStyle(b).opacity : null; })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, buttons: 0 })
  await sleep(300)
  const idleQuote = await ev(`(() => { const b=document.querySelectorAll('.dsh_tlm_memRow')[3].querySelector('.dsh_tlm_memQuote'); return b ? getComputedStyle(b).opacity : null; })()`)

  report.widths[w] = { doc, styles, hoverQuote, idleQuote, mouseAt: box }
  console.log(`[plugin] ${w}px groups=${styles.groups} rows=${styles.rows} nowRows=${styles.nowRows} badges=${styles.nowBadges} sessions=${styles.sessions.length} overflowX=${styles.overflowX} docW=${styles.docW} docH=${styles.docH}`)
  console.log(`         当前行=${JSON.stringify(styles.nowRowTexts)}`)
  console.log(`         组头标签=${JSON.stringify(styles.labels)}`)
  console.log(`         锚点=${styles.anchor.fontSize}/${styles.anchor.color} 标题=${styles.title.fontSize}/w${styles.title.fontWeight} 因果=${styles.cause.fontSize} 引用opacity idle=${idleQuote} hover=${hoverQuote} 常显数=${styles.quoteVisible}`)
  console.log(`         当前行 boxShadow=${styles.nowRow ? styles.nowRow.boxShadow : '-'}`)
  console.log(`         chip=${styles.chipText} | locate=${styles.locate}`)
  console.log(`         会话分组=${JSON.stringify(styles.sessions.map(s => (s.open ? '展开:' : '收起:') + s.text))}`)
}
report.console = logs
writeFileSync(`${DIR}\\_pluginprobe.json`, JSON.stringify(report, null, 2), 'utf8')
console.log('CONSOLE ' + JSON.stringify(logs))
ws.close(); child.kill()
await sleep(600)
rmSync(DIR + '\\.edge-pluginprobe', { recursive: true, force: true })
process.exit(0)
