// _probe.mjs — 用 Edge 的 CDP 通道跑真实渲染并取回结构化结果。
// 覆盖：默认态 + 每个 Tweaks 控件的切换效果 + 浅色主题 + 窄屏 + 截图。
// 只读：打开设计原型，读 DOM 计数、计算样式与控制台报错。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const DIR = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-tri-layer-memory\\design'
const PORT = 9334
const PAGE = 'file:///D:/deepseek/deepseekh_work/plugins/dsh-tri-layer-memory/design/_probe.html'

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + DIR + '\\.edge-profile2',
  '--remote-debugging-port=' + PORT,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch { /* not up yet */ }
  await sleep(500)
}
if (!wsUrl) { console.error('FAIL: CDP 没起来'); child.kill(); process.exit(1) }

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
const consoleMsgs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.consoleAPICalled') consoleMsgs.push({ t: m.params.type, text: (m.params.args || []).map((a) => a.value ?? a.description).join(' ') })
  else if (m.method === 'Runtime.exceptionThrown') consoleMsgs.push({ t: 'exception', text: m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails).slice(0, 300) })
  else if (m.method === 'Log.entryAdded') consoleMsgs.push({ t: 'log:' + m.params.entry.level, text: m.params.entry.text })
})
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: PAGE })
await sleep(2200)

const evaluate = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }
  return r.result?.result?.value
}

// 通用探针表达式
const SNAP = `(() => {
  const q=(s)=>document.querySelectorAll(s).length;
  const rows=[...document.querySelectorAll('.row')];
  const sesses=[...document.querySelectorAll('.sess')];
  const zeroSized=[...document.querySelectorAll('.row, .grp, .sess, .rec, .seg button')].filter(e=>e.offsetWidth===0&&e.offsetHeight===0).length;
  return {
    rows:rows.length, groups:q('.grp'), recs:q('.rec'), sessions:sesses.length,
    nowRows:rows.filter(r=>r.classList.contains('is-now')).length,
    nowGroup:q('.grp.is-now'),
    zeroSized, overflowX: document.documentElement.scrollWidth > window.innerWidth+1,
    blank: [...document.querySelectorAll('.row-title h4,.row-cause,.rec-text,.task-title,.grp-head .span,.l2-sec h5')].filter(e=>!e.textContent.trim()).length,
    locate: document.querySelector('#locate').textContent,
    theme: document.documentElement.getAttribute('data-theme'),
    density: document.documentElement.getAttribute('data-density'),
    quoteAttr: document.documentElement.getAttribute('data-quote'),
    twOpen: document.documentElement.getAttribute('data-tweaks'),
    twDisplay: getComputedStyle(document.querySelector('.tw')).display,
    launchDisplay: getComputedStyle(document.querySelector('#tw-open')).display,
    rowPadTop: getComputedStyle(rows[0]).paddingTop,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    quoteOpacity: getComputedStyle(rows[0].querySelector('.qbtn')).opacity,
    l2sections: q('.l2-sec'),
    openSessions: sesses.filter(d=>d.open).length,
    docH: document.documentElement.scrollHeight,
    grpLabels: [...document.querySelectorAll('.grp-head .span')].map(e=>e.textContent).slice(0,12),
  };
})()`

const out = {}
out.default = await evaluate(SNAP)

// 点开 Tweaks
await evaluate(`document.querySelector('#tw-open').click()`)
out.tweaksOpen = await evaluate(SNAP)

// 逐项切换：通过 Tweaks 面板里的按钮点击（走真实交互路径）
const clickSeg = (fieldIdx, btnIdx) => `(() => {
  const f = document.querySelectorAll('.tw-field')[${fieldIdx}];
  const b = f.querySelectorAll('button')[${btnIdx}];
  const label = b.textContent; b.click(); return label;
})()`
const clickSw = (idx) => `(() => {
  const b = document.querySelectorAll('.sw button')[${idx}];
  const on = b.getAttribute('aria-pressed'); b.click();
  return on + '->' + b.getAttribute('aria-pressed');
})()`

out.grp_category = { clicked: await evaluate(clickSeg(0, 1)), snap: await evaluate(SNAP) }
out.grp_none = { clicked: await evaluate(clickSeg(0, 2)), snap: await evaluate(SNAP) }
out.grp_turn = { clicked: await evaluate(clickSeg(0, 0)), snap: await evaluate(SNAP) }
out.bucket_4 = { clicked: await evaluate(clickSeg(1, 0)), snap: await evaluate(SNAP) }
out.bucket_16 = { clicked: await evaluate(clickSeg(1, 2)), snap: await evaluate(SNAP) }
out.bucket_8 = { clicked: await evaluate(clickSeg(1, 1)), snap: await evaluate(SNAP) }
out.density_comfort = { clicked: await evaluate(clickSeg(2, 1)), snap: await evaluate(SNAP) }
out.light = { clicked: await evaluate(clickSeg(3, 1)), snap: await evaluate(SNAP) }
out.dark = { clicked: await evaluate(clickSeg(3, 0)), snap: await evaluate(SNAP) }
out.quote_always = { clicked: await evaluate(clickSeg(4, 1)), snap: await evaluate(SNAP) }
out.quote_hover = { clicked: await evaluate(clickSeg(4, 0)), snap: await evaluate(SNAP) }
out.now_off = { clicked: await evaluate(clickSw(0)), snap: await evaluate(SNAP) }
out.now_on = { clicked: await evaluate(clickSw(0)), snap: await evaluate(SNAP) }
out.tokbar_off = { clicked: await evaluate(clickSw(1)), snap: await evaluate(SNAP) }
out.tokbar_on = { clicked: await evaluate(clickSw(1)), snap: await evaluate(SNAP) }
out.hideNoise_on = { clicked: await evaluate(clickSw(2)), snap: await evaluate(SNAP) }
out.hideNoise_off = { clicked: await evaluate(clickSw(2)), snap: await evaluate(SNAP) }

// L2 展开全部
out.l2_open = {
  clicked: await evaluate(`(() => { const b=[...document.querySelectorAll('#l2-body button')].pop(); const l=b.textContent; b.click(); return l; })()`),
  snap: await evaluate(SNAP),
}
// 一条 L3 记录展开
out.rec_open = await evaluate(`(() => {
  const r=document.querySelector('.rec'); const b=r.querySelector('.rec-toggle'); b.click();
  return { open:r.classList.contains('open'), btn:b.textContent, clamp:getComputedStyle(r.querySelector('.rec-text')).webkitLineClamp };
})()`)
// 引用按钮走一遍（file:// 下剪贴板可能被拒 → 必须给失败回执，不能静默）
out.quote_click = await evaluate(`(() => {
  document.querySelector('.row .qbtn').click();
  return new Promise(res=>setTimeout(()=>res({ note: document.querySelector('#note').textContent, on: document.querySelector('#note').classList.contains('on') }), 600));
})()`, true)
// L2 头部引用按钮
out.quote_l2 = await evaluate(`(() => {
  document.querySelector('#l2-quote').click();
  return new Promise(res=>setTimeout(()=>res({ note: document.querySelector('#note').textContent }), 600));
})()`, true)
// L3 记录引用按钮
out.quote_l3 = await evaluate(`(() => {
  document.querySelector('.rec .qbtn').click();
  return new Promise(res=>setTimeout(()=>res({ note: document.querySelector('#note').textContent }), 600));
})()`, true)
// 分组标签重叠自检：相邻分组的轮次集合不能有交集
out.label_disjoint = await evaluate(`(() => {
  const nums = (s) => { const out=[]; const re=/(\\\\d+)(?:–(\\\\d+))?/g; let m; while((m=re.exec(s))){ const a=+m[1], b=m[2]?+m[2]:a; for(let i=a;i<=b;i++) out.push(i); } return out; };
  const sets = [...document.querySelectorAll('.grp-head .span')].map(e=>new Set(nums(e.textContent)));
  const bad = [];
  for(let i=0;i<sets.length;i++) for(let j=i+1;j<sets.length;j++){
    const inter=[...sets[i]].filter(x=>sets[j].has(x)); if(inter.length) bad.push([i,j,inter]);
  }
  return { groups: sets.length, overlappingPairs: bad.length, sample: bad.slice(0,3) };
})()`)
// 键盘 j/k
out.keyboard = await evaluate(`(() => {
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}));
  const a = document.activeElement.className;
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}));
  return { afterJ:a, afterK:document.activeElement.className, tag:document.activeElement.tagName };
})()`)
// 关闭 Tweaks 后必须完全隐藏
await evaluate(`document.querySelector('#tw-close').click()`)
out.tweaksClosed = await evaluate(SNAP)

// 窄屏
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: true })
await sleep(400)
out.narrow = await evaluate(SNAP)
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(400)

// 截图：分段（整页会超过 8192px 限制）
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) })
  if (r.result?.data) writeFileSync(`${DIR}\\_shot-${name}.png`, Buffer.from(r.result.data, 'base64'))
  return r.result?.data ? 'ok' : JSON.stringify(r).slice(0, 200)
}
const rectOf = (sel) => evaluate(`(() => { const e=document.querySelector('${sel}'); if(!e) return null; const r=e.getBoundingClientRect(); return { x:0, y:Math.max(0,Math.floor(r.top+window.scrollY-8)), width:1280, height:Math.min(3000, Math.ceil(r.height)+24), scale:1 }; })()`)
out.shots = {
  viewport: await shot('viewport', { x: 0, y: 0, width: 1280, height: 900, scale: 1 }),
  mainline: await shot('mainline', await rectOf('#mainline')),
  l2: await shot('l2', await rectOf('.sec:nth-of-type(3)')),
  l3: await shot('l3', await rectOf('#l3')),
}
// 当前轮附近（第 81 轮高亮 + 分组标题）
out.nowRegion = await evaluate(`(() => {
  const r=document.querySelector('.row.is-now'); const gr=r.closest('.grp');
  const rb=r.getBoundingClientRect(), gb=gr.getBoundingClientRect();
  const top=Math.floor(gb.top+window.scrollY-16);
  return { y:Math.max(0,top), x:0, width:1280, height:Math.min(700, Math.ceil(gb.height)+40), scale:1,
    nowRows: document.querySelectorAll('.row.is-now').length,
    nowBg: getComputedStyle(r).backgroundColor,
    anchorColor: getComputedStyle(r.querySelector('.anchor')).color,
    tickBg: getComputedStyle(r.querySelector('.anchor .tick')).backgroundColor,
    grpLabel: gr.querySelector('.grp-head .span').textContent };
})()`)
out.shots.now = await shot('now', out.nowRegion)
delete out.nowRegion.y; delete out.nowRegion.x; delete out.nowRegion.width; delete out.nowRegion.height; delete out.nowRegion.scale
// 浅色截图（顶部视口）
await evaluate(`(() => { const f=document.querySelectorAll('.tw-field')[3]; f.querySelectorAll('button')[1].click(); })()`)
await sleep(300)
out.shots.light = await shot('light', { x: 0, y: 0, width: 1280, height: 900, scale: 1 })
await evaluate(`(() => { const f=document.querySelectorAll('.tw-field')[3]; f.querySelectorAll('button')[0].click(); })()`)
await sleep(200)
// 舒适密度截图
await evaluate(`(() => { const f=document.querySelectorAll('.tw-field')[2]; f.querySelectorAll('button')[1].click(); })()`)
await sleep(300)
out.shots.comfort = await shot('comfort', { x: 0, y: 0, width: 1280, height: 900, scale: 1 })

writeFileSync(`${DIR}\\_probe-result.json`, JSON.stringify({ out, console: consoleMsgs }, null, 2), 'utf8')

// 打印摘要
const brief = (k) => {
  const v = out[k]
  const s = v && v.snap ? v.snap : v
  console.error(`${k.padEnd(16)} rows=${s.rows} groups=${s.groups} nowRows=${s.nowRows} zero=${s.zeroSized} ovf=${s.overflowX} blank=${s.blank} theme=${s.theme} dens=${s.density} tw=${s.twDisplay} fs=${s.bodyFontSize} pad=${s.rowPadTop} l2sec=${s.l2sections}`)
}
for (const k of Object.keys(out)) if (out[k] && out[k].snap) brief(k)
console.error('default        ' + JSON.stringify(out.default, null, 1))
console.error('tweaksOpen     ' + JSON.stringify(out.tweaksOpen, null, 1))
console.error('narrow         ' + JSON.stringify(out.narrow, null, 1))
console.error('rec_open       ' + JSON.stringify(out.rec_open))
console.error('quote_click    ' + JSON.stringify(out.quote_click))
console.error('keyboard       ' + JSON.stringify(out.keyboard))
console.error('shots          ' + JSON.stringify(out.shots))
console.error('grpLabels(cat) ' + JSON.stringify(out.grp_category.snap.grpLabels))
console.error('grpLabels(none)' + JSON.stringify(out.grp_none.snap.grpLabels))
console.error('console        ' + JSON.stringify(consoleMsgs))
ws.close(); child.kill(); process.exit(0)
