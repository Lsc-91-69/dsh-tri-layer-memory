// _anchordiag.mjs — 量准「轮次锚点」这一列的几何：锚点盒子、文字墨迹（逐字符 Range 矩形）、
// 刻度线伪元素的位置，看它们到底有没有互相压住。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const PORT = 9352
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-anchordiag', '--remote-debugging-port=' + PORT, 'about:blank',
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
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_pluginview.html' })
await sleep(1800)
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value

for (const w of [800, 420]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const out = await ev(`(() => {
    const rows = [...document.querySelectorAll('.dsh_tlm_memRow')];
    const R = (e) => { const r = e.getBoundingClientRect(); return { l:+r.left.toFixed(1), r:+r.right.toFixed(1), t:+r.top.toFixed(1), b:+r.bottom.toFixed(1), w:+r.width.toFixed(1) }; };
    const charRects = (node) => {
      const t = node.textContent, out = [];
      for (let i = 0; i < t.length; i++) {
        const rg = document.createRange(); rg.setStart(node, i); rg.setEnd(node, i + 1);
        const r = rg.getBoundingClientRect(); if (!r.width && !r.height) continue;
        out.push({ ch: t[i], l:+r.left.toFixed(1), r:+r.right.toFixed(1) });
      }
      return out;
    };
    // 全量扫描：每一行的锚点文字墨迹右缘 vs 刻度线左缘，谁被压住
    const scan = rows.map((row, idx) => {
      const a = row.querySelector('.dsh_tlm_memAnchor');
      const cs = getComputedStyle(a, '::before');
      const ar = R(a);
      const tn = [...a.childNodes].find(n => n.nodeType === 3);
      const chars = tn ? charRects(tn) : [];
      const inkR = chars.length ? Math.max(...chars.map(c => c.r)) : ar.l;
      const inkL = chars.length ? Math.min(...chars.map(c => c.l)) : ar.l;
      const tickX0 = ar.l + parseFloat(cs.left);
      const tickX1 = tickX0 + parseFloat(cs.width);
      const contentRight = ar.r - parseFloat(getComputedStyle(a).paddingRight);
      return {
        idx, text: a.textContent, inkW: +(inkR - inkL).toFixed(1),
        inkOverflowRight: +(inkR - contentRight).toFixed(1),
        tickCoversInk: +Math.max(0, Math.min(inkR, tickX1) - Math.max(inkL, tickX0)).toFixed(1),
        isNow: row.classList.contains('isNow'),
      };
    });
    const worst = scan.slice().sort((x, y) => y.tickCoversInk - x.tickCoversInk).slice(0, 5);
    const widest = scan.slice().sort((x, y) => y.inkW - x.inkW).slice(0, 5);
    const anchorW = getComputedStyle(document.querySelector('.dsh_tlm_memRow')).gridTemplateColumns;
    return { anchorW, rows: scan.length, covered: scan.filter(r => r.tickCoversInk > 0).length, worst, widest,
      anchorBoxW: R(document.querySelector('.dsh_tlm_memAnchor')).w };
  })()`)
  console.log(`===== ${w}px =====  grid-template-columns=${out.anchorW} 锚点盒宽=${out.anchorBoxW}`)
  console.log(`  61 行里被刻度线压到墨迹的行数 = ${out.covered} / ${out.rows}`)
  console.log('  最宽锚点：' + JSON.stringify(out.widest))
  console.log('  压得最狠：' + JSON.stringify(out.worst))
}
ws.close(); child.kill()
await sleep(500)
rmSync(DIR + '\\.edge-anchordiag', { recursive: true, force: true })
process.exit(0)
