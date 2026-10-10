// _headcheck.mjs — 组头遮挡探针（只读，不改交付文件）
// 用法: node _headcheck.mjs <tag> [htmlPath]
//   例: node _headcheck.mjs before            → 探 design/思维栏 v0.html
//       node _headcheck.mjs after             → 探修复后的同一文件
//
// 判定「标签被压住」的三重证据：
//   ① 几何：dot 矩形（含 box-shadow 扩散环，环是不透明色，同样吃像素）
//      与**逐字符 ink 矩形**（Range 拆字）求交，报告每个被吃到的字与重叠像素数。
//   ② 绘制顺序：在被吃掉的区域里用 elementsFromPoint 取最上层元素 —— 必须是 .dot。
//   ③ 视觉：按组头裁剪截图（放大），人工可读。
// 注意：采样**不能只取文字中线**。dot 的 top 是 grp-head.top + s3 + 7，
// 而文字中线约在 grp-head.top + 12 + 6.6 —— 两者相差不到 1px，
// 只采中线会得出「没有遮挡」的假阴性（上一版探针就踩了这个坑）。
import { spawn } from 'node:child_process'
import { copyFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'

const TAG = process.argv[2] || 'run'
const SRC = process.argv[3] || 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design\\思维栏 v0.html'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const TMP = `${DIR}\\_headcheck.html`
const OUT = `${DIR}\\_headcheck-out`
mkdirSync(OUT, { recursive: true })
copyFileSync(SRC, TMP)

const PORT = 9338 + (TAG === 'after' ? 1 : 0)
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-headcheck', '--remote-debugging-port=' + PORT, 'about:blank',
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
await send('Page.navigate', { url: 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_headcheck.html' })
await sleep(2500)
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true })
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }
  return r.result?.result?.value
}

const PROBE = `(() => {
  const heads = [...document.querySelectorAll('.grp-head')];
  const R = (e) => { const r = e.getBoundingClientRect(); return { l:+r.left.toFixed(2), t:+r.top.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2), r:+r.right.toFixed(2), b:+r.bottom.toFixed(2) }; };
  const ov = (a, b) => ({ dx:+Math.max(0, Math.min(a.r,b.r)-Math.max(a.l,b.l)).toFixed(2), dy:+Math.max(0, Math.min(a.b,b.b)-Math.max(a.t,b.t)).toFixed(2) });
  // 逐字符 ink 矩形：Range 拆字
  const charRects = (node) => {
    const t = node.textContent, out = [];
    for (let i = 0; i < t.length; i++) {
      const rg = document.createRange(); rg.setStart(node, i); rg.setEnd(node, i + 1);
      const r = rg.getBoundingClientRect(); if (!r.width && !r.height) continue;
      out.push({ ch: t[i], i, l:+r.left.toFixed(2), r:+r.right.toFixed(2), t:+r.top.toFixed(2), b:+r.bottom.toFixed(2) });
    }
    return out;
  };
  const topAt = (x, y) => { const st = document.elementsFromPoint(x, y); return st.length ? (st[0].className || st[0].tagName) : null; };
  return heads.map((h, gi) => {
    const span = h.querySelector('.span');
    const dot = h.querySelector('.dot');
    const sr = R(span), dr = R(dot);
    const ds = getComputedStyle(dot);
    const spread = parseFloat((ds.boxShadow.match(/(\\d+(?:\\.\\d+)?)px\\s+(\\d+(?:\\.\\d+)?)px\\s+(\\d+(?:\\.\\d+)?)px/) || [])[3] || '0') || 0;
    // dot 的实际吃像素范围 = 矩形 + 扩散环
    const drPainted = { l: dr.l - spread, t: dr.t - spread, r: dr.r + spread, b: dr.b + spread };
    const tn = [...span.childNodes].find(n => n.nodeType === 3);
    const chars = tn ? charRects(tn) : [];
    const eaten = chars.map(c => {
      const o = ov(c, drPainted);
      const area = o.dx * o.dy;
      return { ch: c.ch, i: c.i, charRect: { l: c.l, t: c.t, r: c.r, b: c.b }, ovDx: o.dx, ovDy: o.dy, area: +area.toFixed(2) };
    }).filter(c => c.area > 0);
    // 绘制顺序：在被吃区域里取点，看最上层是不是 dot
    let topmost = null, sample = null;
    if (eaten.length) {
      const c = eaten[0];
      const x = +((Math.max(c.charRect.l, drPainted.l) + Math.min(c.charRect.r, drPainted.r)) / 2).toFixed(2);
      const y = +((Math.max(c.charRect.t, drPainted.t) + Math.min(c.charRect.b, drPainted.b)) / 2).toFixed(2);
      topmost = topAt(x, y); sample = { x, y, stack: document.elementsFromPoint(x, y).slice(0, 3).map(e => e.className || e.tagName) };
    }
    // 扫描整条文字带（每 1px 高 × 每 1px 宽）统计被 dot 盖住的像素点
    let coveredPts = 0;
    for (let y = Math.ceil(sr.t); y < sr.b; y++) {
      for (let x = Math.ceil(sr.l); x < sr.r; x++) {
        const st = document.elementsFromPoint(x, y);
        if (st.length && st[0] === dot) coveredPts++;
      }
    }
    return {
      gi, label: span.textContent,
      spanRect: sr, dotRect: dr, dotPaintedRect: drPainted, shadowSpread: spread,
      dotStyle: { position: ds.position, zIndex: ds.zIndex, left: ds.left, top: ds.top, width: ds.width, height: ds.height, background: ds.backgroundColor, boxShadow: ds.boxShadow, borderRadius: ds.borderRadius },
      spanStyle: { fontSize: getComputedStyle(span).fontSize, color: getComputedStyle(span).color, fontWeight: getComputedStyle(span).fontWeight },
      headPadLeft: getComputedStyle(h).paddingLeft,
      eatenChars: eaten.map(c => ({ ch: c.ch, i: c.i, ovDx: c.ovDx, ovDy: c.ovDy, area: c.area, charRect: c.charRect })),
      eatenCount: eaten.length,
      topmostAtEaten: topmost, samplePoint: sample,
      coveredPoints: coveredPts,
    };
  });
})()`

const report = { tag: TAG, file: SRC, widths: {}, console: [] }
for (const w of [1280, 1440, 420]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w <= 420 })
  await sleep(600)
  // 滚到主线骨架，保证组头在视口内（探针自己的滚动，不影响交付文件）
  await ev(`(() => { const g=document.querySelector('.grp-head'); const t=g.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, Math.max(0, t-40)); return Math.round(window.scrollY); })()`)
  await sleep(250)
  const heads = await ev(PROBE)
  const bad = Array.isArray(heads) ? heads.filter((h) => h.eatenCount > 0) : []
  report.widths[w] = {
    groups: Array.isArray(heads) ? heads.length : heads,
    spineX: await ev(`getComputedStyle(document.documentElement).getPropertyValue('--spine-x').trim()`),
    density: await ev(`document.documentElement.getAttribute('data-density')`),
    innerW: await ev('window.innerWidth'), scrollW: await ev('document.documentElement.scrollWidth'),
    occludedHeads: bad.length,
    occluded: bad.map((h) => ({ gi: h.gi, label: h.label, eatenChars: h.eatenChars.map(c => c.ch).join(''), eatenCount: h.eatenCount, coveredPoints: h.coveredPoints, topmostAtEaten: h.topmostAtEaten, spanRect: h.spanRect, dotRect: h.dotRect, dotPaintedRect: h.dotPaintedRect, shadowSpread: h.shadowSpread, headPadLeft: h.headPadLeft })),
    all: Array.isArray(heads) ? heads.map((h) => ({ gi: h.gi, label: h.label, eatenChars: h.eatenChars.map(c => c.ch).join(''), eatenCount: h.eatenCount, coveredPoints: h.coveredPoints, topmost: h.topmostAtEaten, spanL: h.spanRect.l, dotL: h.dotRect.l })) : [],
  }
  // 截图：把第一个组头裁出来（放大 3 倍，肉眼可判）
  const clip = await ev(`(() => { const g=document.querySelector('.grp-head'); const r=g.getBoundingClientRect(); return { x:0, y:Math.max(0,Math.round(r.top+window.scrollY-10)), width:${Math.min(w, 900)}, height:Math.round(r.height)+22, scale:3 }; })()`)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
  if (shot.result?.data) writeFileSync(`${OUT}\\${TAG}-head-${w}.png`, Buffer.from(shot.result.data, 'base64'))
}
report.console = logs
writeFileSync(`${DIR}\\_headcheck-${TAG}.json`, JSON.stringify(report, null, 2), 'utf8')
for (const w of Object.keys(report.widths)) {
  const s = report.widths[w]
  console.log(`[${TAG}] ${w}px  groups=${s.groups} spineX=${s.spineX} density=${s.density} innerW=${s.innerW} scrollW=${s.scrollW} 遮挡组头=${s.occludedHeads}`)
  for (const a of s.all) console.log(`   [${String(a.gi).padStart(2)}] ${a.label.padEnd(24)} 被吃字=${a.eatenChars || '无'} 面积点=${a.coveredPoints} 最上层=${a.topmost || '-'}`)
}
console.log('CONSOLE ' + JSON.stringify(logs))
ws.close(); child.kill()
await sleep(600)
rmSync(TMP, { force: true })
rmSync(DIR + '\\.edge-headcheck', { recursive: true, force: true })
process.exit(0)
