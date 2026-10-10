/* 思维栏 v0 — 运行时（无依赖）。数据全部来自内联的 DATA。 */
(function () {
  'use strict';
  var DATA = window.__TLM__;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var root = document.documentElement;

  // ── 状态 ────────────────────────────────────────────────────────
  var S = {
    group: 'turn',      // turn | category | none
    bucket: 8,          // 按轮次聚类时的桶宽
    density: 'compact', // compact | comfort
    theme: 'dark',
    now: true,
    quote: 'hover',
    tokbar: true,
    hideNoise: false,
    l2: 'fold',         // fold | open
  };
  var SAVE_KEY = 'tlm-thinking-column-v0';

  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { /* 隐私模式 */ } }
  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      for (var k in S) if (k in o) S[k] = o[k];
    } catch (e) { /* 坏值就用默认 */ }
  }

  function apply() {
    root.setAttribute('data-theme', S.theme);
    root.setAttribute('data-density', S.density === 'comfort' ? 'comfort' : 'compact');
    root.setAttribute('data-quote', S.quote === 'always' ? 'always' : 'hover');
    root.setAttribute('data-tokbar', S.tokbar ? 'on' : 'off');
    root.setAttribute('data-now', S.now ? 'on' : 'off');
  }

  // ── 引用：真实实现是 inputActions.setDraft **追加**进输入框；原型里落到剪贴板 ──
  // 失败必须说出来（对应实现的 memQuoteFailed）——一个点了没反应的按钮，在这个插件里
  // 就是第三次"看起来在工作"的静默故障。
  var noteTimer = null;
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false }
  }
  function quote(label, body) {
    var block = '[' + label + ']\n' + body;
    function fallback() {
      // 只试一次：user gesture 只能消费一次，重复调用必然失败
      if (legacyCopy(block)) note('已引用 ' + label + '（回退复制；实际会追加进输入框）', false);
      else note('引用失败：原型拿不到剪贴板（实际实现会追加进输入框）', true);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(block).then(
        function () { note('已引用 ' + label + '（原型写入剪贴板；实际会追加进输入框）', false) },
        fallback,
      );
    } else fallback();
  }
  function note(text, bad) {
    var el = $('#note');
    el.textContent = text;
    el.classList.add('on');
    el.style.borderColor = bad ? 'var(--error)' : 'var(--border-l2)';
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  // ── 小工具 ──────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function span(from, to) {
    return (to === undefined || to === null || to === from) ? ('第 ' + from + ' 轮') : ('第 ' + from + '–' + to + ' 轮');
  }
  function shortSpan(from, to) {
    return (to === undefined || to === null || to === from) ? ('第' + from + '轮') : (from + '–' + to);
  }
  function fmtTokens(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  // 内联 markdown：只处理 `code` 和 **bold**（正文一字不改）
  function rich(text) {
    var frag = document.createDocumentFragment();
    var re = /(`[^`]+`|\*\*[^*]+\*\*)/g, last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      if (tok.charAt(0) === '`') frag.appendChild(el('code', null, tok.slice(1, -1)));
      else frag.appendChild(el('strong', null, tok.slice(2, -2)));
      last = m.index + tok.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  // ── 页头 ────────────────────────────────────────────────────────
  function renderHead() {
    var m = DATA.meta;
    $('#head-title').textContent = '思维栏';
    var meta = $('#head-meta');
    meta.appendChild(el('span', null, '会话 '));
    meta.appendChild(el('b', 'tnum', m.shortId));
    meta.appendChild(el('span', null, '· 抽取于 ' + m.extractedAt.replace('T', ' ').slice(0, 19) + ' UTC'));
    $('#head-sub').textContent = m.turnCount + ' 轮 · ' + m.events.toLocaleString() + ' 事件 · ' +
      m.frames.toLocaleString() + ' 个 zstd 帧 · 日志 ' + (m.logBytes / 1048576).toFixed(1) + ' MB';
    $('#head-sub').appendChild(el('code', null, '  session.v4.jsonl.zstd'));
  }

  // ── 1 · 任务标题 ────────────────────────────────────────────────
  function renderTask() {
    $('#task-title').textContent = DATA.taskTitle || '（尚未识别出任务标题）';
    var btn = el('button', 'qbtn', '引用');
    btn.type = 'button';
    btn.title = '引用 · 任务标题';
    btn.addEventListener('click', function () { quote('记忆引用 · 任务标题', DATA.taskTitle); });
    $('#task-row').appendChild(btn);
  }

  // ── 2 · 骨架：分组 ──────────────────────────────────────────────
  // 分组标签报**实际包含的轮次**，不是「最小–最大」：跨轮里程碑（如「第 8–14 轮」）
  // 会让相邻桶的标签互相重叠（实测出现「第 1–14 轮」紧接着「第 12–17 轮」），
  // 那种标签在扫读时会读成"这段覆盖到 14 轮"，是错的。
  function turnLabel(turns) {
    // 去重：多条里程碑可以同轮（实测第 1 轮有 3 条），不去重会印出「第 1、1、1–2 轮」
    var u = [];
    turns.forEach(function (t) { if (u.indexOf(t) < 0) u.push(t) });
    u.sort(function (a, b) { return a - b; });
    var runs = [], s = u[0], p = u[0];
    for (var i = 1; i < u.length; i++) {
      if (u[i] === p + 1) { p = u[i]; continue }
      runs.push([s, p]); s = p = u[i];
    }
    runs.push([s, p]);
    return '第 ' + runs.map(function (r) { return r[0] === r[1] ? r[0] : (r[0] + '–' + r[1]) }).join('、') + ' 轮';
  }

  function groupMainline(items) {
    if (S.group === 'none') return [{ key: 'all', label: null, items: items }];
    if (S.group === 'category') {
      var order = ['任务', '目标', '转向', '决策', '指令', '交付', '验证', '压缩', '回退', '失败', '中断', '事件'];
      var map = {};
      items.forEach(function (it) { (map[it.category] = map[it.category] || []).push(it); });
      return order.filter(function (c) { return map[c]; }).map(function (c) {
        var turns = map[c].map(function (i) { return i.turn; });
        return {
          key: 'c-' + c, label: c, cat: c, items: map[c],
          stat: map[c].length + ' 条 · ' + map[c].reduce(function (s, i) { return s + i.tokens; }, 0) + ' tok',
          span: turnLabel(turns),
          from: Math.min.apply(null, turns), to: Math.max.apply(null, turns),
        };
      });
    }
    // 按轮次聚类：桶宽 = S.bucket
    var buckets = [], cur = null;
    items.forEach(function (it) {
      var b = Math.floor((it.turn - 1) / S.bucket);
      if (!cur || cur.b !== b) { cur = { b: b, items: [] }; buckets.push(cur); }
      cur.items.push(it);
    });
    return buckets.map(function (bk) {
      var turns = bk.items.map(function (i) { return i.turn; });
      return {
        key: 'b-' + bk.b,
        label: turnLabel(turns),
        stat: bk.items.length + ' 条 · ' + bk.items.reduce(function (s, i) { return s + i.tokens; }, 0) + ' tok',
        items: bk.items,
        from: Math.min.apply(null, turns),
        to: Math.max.apply(null, bk.items.map(function (i) { return i.turnTo === undefined ? i.turn : i.turnTo; })),
      };
    });
  }

  var MAX_ROW_TOK = Math.max.apply(null, DATA.mainline.map(function (m) { return m.tokens; }));

  function renderMainline() {
    var host = $('#mainline');
    host.textContent = '';
    var items = DATA.mainline.filter(function (m) { return !(S.hideNoise && (m.category === '事件' || m.category === '指令')); });
    var groups = groupMainline(items);
    var track = el('div', 'track');
    var nowGroup = null;

    groups.forEach(function (g) {
      var box = el('section', 'grp');
      var isNow = S.now && g.to !== undefined && DATA.meta.currentTurn >= g.from && DATA.meta.currentTurn <= g.to;
      if (isNow) { box.classList.add('is-now'); nowGroup = g; }
      var head = el('div', 'grp-head');
      head.appendChild(el('span', 'dot'));
      if (g.label) head.appendChild(el('span', 'span', g.label));
      else head.appendChild(el('span', 'span', '全部 ' + g.items.length + ' 条'));
      head.appendChild(el('span', 'stat', g.stat));
      head.appendChild(el('span', 'bar'));
      if (isNow) head.appendChild(el('span', 'stat', '当前'));
      var q = el('button', 'qbtn', '引用');
      q.type = 'button';
      q.title = '引用 · 主线骨架 · ' + (g.label || '全部');
      q.addEventListener('click', function () {
        quote('记忆引用 · 主线骨架 · ' + (g.label || '全部'), g.items.map(function (i) {
          return span(i.turn, i.turnTo) + ': ' + i.title + ' — ' + i.cause;
        }).join('\n'));
      });
      head.appendChild(q);
      box.appendChild(head);

      var ol = el('ol', 'rows');
      g.items.forEach(function (it) {
        var isNowRow = S.now && (it.turn === DATA.meta.currentTurn || (it.turnTo !== undefined && DATA.meta.currentTurn >= it.turn && DATA.meta.currentTurn <= it.turnTo));
        var li = el('li', 'row' + (isNowRow ? ' is-now' : ''));
        li.tabIndex = 0;
        li.setAttribute('data-turn', it.turn);

        var anchor = el('span', 'anchor tnum');
        anchor.appendChild(el('i', 'tick'));
        anchor.appendChild(document.createTextNode(it.turnTo === undefined ? String(it.turn) : (it.turn + '–' + it.turnTo)));
        li.appendChild(anchor);

        var body = el('div', 'body-col');
        var titleRow = el('div', 'row-title');
        titleRow.appendChild(el('h4', null, it.title));
        titleRow.appendChild(el('span', 'cat', it.category)).setAttribute('data-cat', it.category);
        body.appendChild(titleRow);
        body.appendChild(el('p', 'row-cause', it.cause));
        li.appendChild(body);

        var right = el('div', 'tokbar');
        right.appendChild(el('span', 'num tnum', it.tokens));
        var t2 = el('span', 'track2');
        var fill = el('i', 'fill');
        fill.style.width = Math.max(8, Math.round(it.tokens / MAX_ROW_TOK * 100)) + '%';
        t2.appendChild(fill);
        right.appendChild(t2);
        var qb = el('button', 'qbtn', '引用');
        qb.type = 'button';
        qb.title = '引用 · ' + span(it.turn, it.turnTo) + ' · ' + it.title;
        qb.addEventListener('click', function (e) {
          e.stopPropagation();
          quote('记忆引用 · 主线骨架 · ' + span(it.turn, it.turnTo), span(it.turn, it.turnTo) + ': ' + it.title + ' — ' + it.cause);
        });
        right.appendChild(qb);
        li.appendChild(right);

        ol.appendChild(li);
      });
      box.appendChild(ol);
      track.appendChild(box);
    });
    host.appendChild(track);

    // 定位读数：当前轮 + 覆盖范围
    var loc = $('#locate');
    loc.textContent = '';
    var now = el('span', 'now', '当前 第 ' + DATA.meta.currentTurn + ' 轮');
    loc.appendChild(now);
    var covered = items.length ? Math.min.apply(null, items.map(function (i) { return i.turn; })) + '–' + Math.max.apply(null, items.map(function (i) { return Math.max(i.turn, i.turnTo === undefined ? i.turn : i.turnTo); })) : '—';
    loc.appendChild(el('span', null, '骨架覆盖 ' + covered + ' 轮'));
    loc.appendChild(el('span', null, '· 分组 ' + groups.length + ' 段'));
    if (S.hideNoise) {
      var hidden = DATA.mainline.length - items.length;
      if (hidden > 0) loc.appendChild(el('span', null, '· 已折叠 ' + hidden + ' 条低信息量（指令/事件）'));
    }    $('#mainline-stat').textContent = DATA.mainline.length + ' 条 · ' + DATA.mainlineTokens + ' tok';
  }

  // ── 3 · L2 ──────────────────────────────────────────────────────
  function renderL2() {
    var l2 = DATA.l2;
    $('#l2-stat').textContent = span(l2.turnFrom, l2.turnTo) + ' · ' + l2.mode + ' · ' + l2.chars.toLocaleString() + ' 字符';
    var q = $('#l2-quote');
    q.addEventListener('click', function () {
      quote('记忆引用 · L2 摘要 · ' + span(l2.turnFrom, l2.turnTo),
        span(l2.turnFrom, l2.turnTo) + ': ' + l2.sections.map(function (s) {
          return s.h + '\n' + s.items.map(function (i) { return '- ' + i.v; }).join('\n');
        }).join('\n\n'));
    });
    $('#l2-note').textContent = '摘要遮蔽了 ' + l2.shadowedTokenCount.toLocaleString() + ' tokens（' +
      l2.totalSummaries + ' 次压缩中的最后一次，seq ' + l2.atSeq + '）。';
    var sum = $('#l2-sum');
    var body = $('#l2-body');
    var full = l2.sections;
    var visible = S.l2 === 'open' ? full : full.slice(0, 2);
    function draw() {
      body.textContent = '';
      (S.l2 === 'open' ? full : full.slice(0, 2)).forEach(function (sec) {
        var box = el('section', 'l2-sec');
        box.appendChild(el('h5', null, sec.h));
        var ul = el('ul');
        sec.items.forEach(function (it) {
          if (it.t === 'li') { var li = el('li'); li.appendChild(rich(it.v)); ul.appendChild(li); }
          else if (it.t === 'sub') { var li2 = el('li', 'sub'); li2.appendChild(rich(it.v)); ul.appendChild(li2); }
          else { var p = el('p'); p.appendChild(rich(it.v)); box.appendChild(p); }
        });
        if (ul.children.length) box.appendChild(ul);
        body.appendChild(box);
      });
      var fold = el('div', 'l2-fold');
      var b = el('button', null, S.l2 === 'open' ? '收起，只看前 2 节' : '展开全部 ' + full.length + ' 节');
      b.type = 'button';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        S.l2 = S.l2 === 'open' ? 'fold' : 'open';
        sum.open = true;
        save(); draw();
      });
      fold.appendChild(b);
      body.appendChild(fold);
    }
    draw();
    sum.open = true;
  }

  // ── 4 · L3 ──────────────────────────────────────────────────────
  function renderL3() {
    var l3 = DATA.l3;
    $('#l3-stat').textContent = l3.count + ' 条 / ' + fmtTokens(l3.tokens) + ' tok（整库）· 本会话 ' +
      l3.sessionCount + ' 条 / ' + fmtTokens(l3.sessionTokens) + ' tok';
    $('#l3-note').textContent = 'L3 是跨会话共享的库：下面按会话分组，' + l3.sessionTotal +
      ' 个会话有记录。视图口径是整库前 ' + l3.viewRecords + ' 条；原型内联 ' + l3.shownRecords +
      ' 条（里程碑全留，轮次摘要抽最近 ' + l3.kindQuota.turn + ' 条，略过 ' + l3.droppedRecords + ' 条）。';

    var host = $('#l3');
    host.textContent = '';
    l3.groups.forEach(function (g) {
      var d = el('details', 'sess');
      d.open = g.own;
      var sum = el('summary', 'sess-sum');
      sum.appendChild(el('span', 'caret'));
      sum.appendChild(el('span', 'sess-id', g.own ? (DATA.meta.shortId + '（本会话）') : g.sessionId.replace(/^session-/, '').slice(0, 8)));
      sum.appendChild(el('span', 'badge' + (g.own ? ' own' : ''), g.own ? '本会话' : '其它会话'));
      sum.appendChild(el('span', 'grow'));
      sum.appendChild(el('span', 'stat tnum', '显示 ' + g.shown + ' / 库内 ' + g.count + ' 条 · ' + fmtTokens(g.tokens) + ' tok'));
      d.appendChild(sum);

      var body = el('div', 'sess-body');
      g.records.forEach(function (r) {
        var row = el('div', 'rec');
        var left = el('div');
        var meta = el('div', 'rec-meta');
        var k = el('span', 'kind', r.kindLabel);
        k.setAttribute('data-kind', r.kind);
        meta.appendChild(k);
        meta.appendChild(el('span', 'tnum', span(r.turnFrom, r.turnTo)));
        meta.appendChild(el('span', 'tnum', r.tokens + ' tok'));
        meta.appendChild(el('span', 'id', r.id));
        left.appendChild(meta);
        var p = el('p', 'rec-text');
        // 轮次/摘要记录的正文本身是多行 markdown。**保留换行**（pre-wrap + 2 行截断），
        // 不压平成一段：压平之后「## 任务主线」和「## 已完成的子任务」挤成一堵墙，
        // 而它们的前两行恰好就是最该先读到的那句。
        var lines = String(r.text).split('\n').map(function (l) { return l.replace(/\s+$/, '') }).filter(function (l) { return l.trim().length });
        lines.forEach(function (line, i) {
          if (i > 0) p.appendChild(document.createTextNode('\n'));
          if (/^#/.test(line)) p.appendChild(el('span', 'h', line.replace(/^#+\s*/, '')));
          else p.appendChild(rich(line));
        });
        left.appendChild(p);
        row.appendChild(left);

        var acts = el('div', 'rec-actions');
        var tg = el('button', 'rec-toggle', '展开');
        tg.type = 'button';
        tg.addEventListener('click', function () {
          row.classList.toggle('open');
          tg.textContent = row.classList.contains('open') ? '收起' : '展开';
        });
        acts.appendChild(tg);
        var qb = el('button', 'qbtn', '引用');
        qb.type = 'button';
        qb.title = '引用 · ' + r.id;
        qb.addEventListener('click', function () {
          quote('记忆引用 · L3 · ' + r.id + ' · ' + span(r.turnFrom, r.turnTo) + ' · ' + r.kind,
            span(r.turnFrom, r.turnTo) + ' · ' + r.kind + ': ' + r.text);
        });
        acts.appendChild(qb);
        row.appendChild(acts);
        body.appendChild(row);
      });
      d.appendChild(body);
      host.appendChild(d);
    });
  }

  // ── 页脚 ────────────────────────────────────────────────────────
  function renderFoot() {
    var m = DATA.meta;
    $('#foot').textContent = '数据来源：' + m.sessionId + ' 的会话日志（' + m.events.toLocaleString() + ' 事件）经插件 extractMilestones 抽取；' +
      'L3 读自 deep-memory.sqlite 的 records 表。本页是只读设计原型，不是插件运行时。';
  }

  // ── Tweaks ──────────────────────────────────────────────────────
  function seg(label, key, options, onChange) {
    var f = el('div', 'tw-field');
    f.appendChild(el('label', null, label));
    var box = el('div', 'seg');
    options.forEach(function (o) {
      var b = el('button', null, o.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(S[key] === o.value));
      b.addEventListener('click', function () {
        S[key] = o.value; save(); onChange();
      });
      box.appendChild(b);
    });
    f.appendChild(box);
    f._sync = function () { [].forEach.call(box.children, function (b, i) { b.setAttribute('aria-pressed', String(S[key] === options[i].value)); }); };
    return f;
  }
  function toggle(label, key, onChange) {
    var f = el('div', 'sw');
    f.appendChild(el('span', null, label));
    var b = el('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!S[key]));
    b.addEventListener('click', function () { S[key] = !S[key]; save(); b.setAttribute('aria-pressed', String(!!S[key])); onChange(); });
    f.appendChild(b);
    f._sync = function () { b.setAttribute('aria-pressed', String(!!S[key])); };
    return f;
  }

  var fields = [];
  function renderTweaks() {
    var box = $('#tw-body');
    box.textContent = '';
    fields = [];
    function add(f) { fields.push(f); box.appendChild(f); }

    add(seg('骨架分组粒度', 'group', [
      { label: '按轮次', value: 'turn' }, { label: '按 category', value: 'category' }, { label: '不分组', value: 'none' },
    ], function () { renderMainline(); fields.forEach(function (f) { f._sync && f._sync(); }); }));

    add(seg('轮次聚类桶宽', 'bucket', [
      { label: '4 轮', value: 4 }, { label: '8 轮', value: 8 }, { label: '16 轮', value: 16 },
    ], function () { renderMainline(); fields.forEach(function (f) { f._sync && f._sync(); }); }));

    add(seg('密度', 'density', [
      { label: '紧凑', value: 'compact' }, { label: '舒适', value: 'comfort' },
    ], function () { apply(); fields.forEach(function (f) { f._sync && f._sync(); }); }));

    add(seg('主题', 'theme', [
      { label: '深色', value: 'dark' }, { label: '浅色', value: 'light' },
    ], function () { apply(); fields.forEach(function (f) { f._sync && f._sync(); }); }));

    add(seg('引用按钮', 'quote', [
      { label: 'hover 显示', value: 'hover' }, { label: '常显', value: 'always' },
    ], function () { apply(); fields.forEach(function (f) { f._sync && f._sync(); }); }));

    add(toggle('当前轮高亮', 'now', function () { apply(); renderMainline(); }));
    add(toggle('token 微条', 'tokbar', function () { apply(); fields.forEach(function (f) { f._sync && f._sync(); }); }));
    add(toggle('折叠低信息量条目', 'hideNoise', function () { renderMainline(); fields.forEach(function (f) { f._sync && f._sync(); }); }));

    var foot = el('div', 'tw-foot');
    foot.appendChild(document.createTextNode('j / k 在骨架条目间移动，'));
    foot.appendChild(el('kbd', null, 'Enter'));
    foot.appendChild(document.createTextNode(' 引用。分组/密度/主题会记进 localStorage。'));
    box.appendChild(foot);
  }

  function setTweaks(open) {
    root.setAttribute('data-tweaks', open ? 'open' : 'closed');
    try { localStorage.setItem(SAVE_KEY + ':open', open ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // ── 键盘：j/k 移动（刻意不用 scrollIntoView，避免影响外层容器滚动） ──
  function focusStep(dir) {
    var rows = [].slice.call(document.querySelectorAll('.row'));
    if (!rows.length) return;
    var idx = rows.indexOf(document.activeElement);
    var next = idx < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, idx + dir));
    rows[next].focus({ preventScroll: true });
    var r = rows[next].getBoundingClientRect();
    var vh = window.innerHeight;
    if (r.top < 90) window.scrollBy({ top: r.top - 110, behavior: 'auto' });
    else if (r.bottom > vh - 20) window.scrollBy({ top: r.bottom - vh + 40, behavior: 'auto' });
  }

  // ── 启动 ────────────────────────────────────────────────────────
  load();
  apply();
  renderHead();
  renderTask();
  renderMainline();
  renderL2();
  renderL3();
  renderFoot();
  renderTweaks();
  var wasOpen = false;
  try { wasOpen = localStorage.getItem(SAVE_KEY + ':open') === '1'; } catch (e) { /* ignore */ }
  setTweaks(wasOpen);

  $('#tw-open').addEventListener('click', function () { setTweaks(true); });
  $('#tw-close').addEventListener('click', function () { setTweaks(false); });
  document.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'j') { focusStep(1); e.preventDefault(); }
    else if (e.key === 'k') { focusStep(-1); e.preventDefault(); }
    else if (e.key === 'Enter' && document.activeElement && document.activeElement.classList.contains('row')) {
      var b = document.activeElement.querySelector('.qbtn');
      if (b) b.click();
    } else if (e.key === 'Escape') { setTweaks(false); }
  });
})();
