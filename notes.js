'use strict';
/* ノートを読む画面: 検索、分野の一覧、本文のリンクで概念から概念へ移動、被リンク */
(function () {
  const Q = window.Q, S = Q.S, esc = Q.esc;
  const N = {loaded: false, list: [], byName: new Map(), byAlias: new Map(), fields: [], back: new Map(), members: new Map(), fieldNote: new Map()};
  let loading = null, token = 0;
  const TYPE = {c: '概念', p: '人物', d: '分野'};
  const norm = s => s.normalize('NFKC').toLowerCase();
  const enc = encodeURIComponent;

  /* ---------- データ ---------- */
  async function ensure() {
    if (N.loaded) return;
    if (!loading) loading = Q.loadAux('notes-index').then(init).catch(e => { loading = null; throw e; });
    await loading;
  }
  function parseFlow(s) {
    s = (s || '').trim();
    if (!(s.startsWith('[') && s.endsWith(']'))) return s ? [s] : [];
    try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map(String); } catch (e) {}
    return s.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const linkName = x => { const m = /^\[\[([^\]|#]+)/.exec(x); return m ? m[1].trim() : null; };
  function init(d) {
    N.fields = d.fields; N.list = d.notes; N.CH = d.chunk;
    d.notes.forEach((n, i) => N.byName.set(n.n, i));
    d.notes.forEach((n, i) => (n.a || []).forEach(a => { if (!N.byName.has(a) && !N.byAlias.has(a)) N.byAlias.set(a, i); }));
    d.notes.forEach((n, i) => {
      if (n.t === 'd') { const fi = N.fields.indexOf(n.n); if (fi >= 0) N.fieldNote.set(fi, i); }
      if (n.t !== 'd') (n.f || []).forEach(fi => { (N.members.get(fi) || N.members.set(fi, []).get(fi)).push(i); });
    });
    N.loaded = true;
  }
  /* 本文は600件ずつの塊を、読むときに取り寄せる */
  const chunkP = new Map(), chunkD = new Map();
  const chunk = c => { if (!chunkP.has(c)) chunkP.set(c, Q.loadAux('notes-' + String(c).padStart(2, '0')).then(d => (chunkD.set(c, d), d)).catch(e => { chunkP.delete(c); throw e; })); return chunkP.get(c); };
  async function bodyOf(i) { const c = Math.floor(i / N.CH); const d = await chunk(c); return d.b[i - c * N.CH]; }
  const bodySync = i => { const d = chunkD.get(Math.floor(i / N.CH)); return d ? d.b[i - Math.floor(i / N.CH) * N.CH] : ''; };
  async function loadAll(progress) {
    const nC = Math.ceil(N.list.length / N.CH);
    for (let c = 0; c < nC; c += 6) { await Promise.all([0, 1, 2, 3, 4, 5].map(k => c + k < nC ? chunk(c + k) : null)); if (progress) progress(Math.min(nC, c + 6), nC); }
    N.allLoaded = true;
  }
  const resolve = name => { const i = N.byName.get(name); return i !== undefined ? i : N.byAlias.get(name); };

  /* ---------- 本文の表示(Obsidianの書き方の一部) ---------- */
  function wlink(inner) {
    const parts = inner.split('|'); const target = parts[0].trim(); const tn = target.split('#')[0].trim();
    const label = (parts[1] || target.replace('#', ' › ')).trim(); const i = resolve(tn);
    if (i === undefined) return '<span class="wl dead" title="ノートがありません">' + esc(label) + '</span>';
    const nm = N.list[i].n; return '<a class="wl" href="#/n/' + enc(nm) + '" data-n="' + esc(nm) + '">' + esc(label) + '</a>';
  }
  function inline(s) {
    const re = /(`[^`\n]+`|\[\[[^\]\n]+\]\]|\*\*(?:[^*\n]|\*(?!\*))+\*\*)/g; let out = '', last = 0, m;
    while ((m = re.exec(s))) {
      out += esc(s.slice(last, m.index)); const t = m[0];
      out += t[0] === '`' ? '<code>' + esc(t.slice(1, -1)) + '</code>' : t[0] === '[' ? wlink(t.slice(2, -2)) : '<strong>' + inline(t.slice(2, -2)) + '</strong>';
      last = m.index + t.length;
    }
    return out + esc(s.slice(last));
  }
  function md(body) {
    const lines = body.replace(/\r\n/g, '\n').split('\n'); let html = '', para = []; const st = [];
    const flush = () => { if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; } };
    const closeTo = ind => { while (st.length && st[st.length - 1].ind > ind) { html += '</li></' + st.pop().ty + '>'; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }
      let m;
      if ((m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line))) {
        flush(); const ind = m[1].replace(/\t/g, '    ').length, ty = /\d/.test(m[2]) ? 'ol' : 'ul';
        closeTo(ind);
        if (st.length && st[st.length - 1].ind === ind) { if (st[st.length - 1].ty !== ty) { html += '</li></' + st.pop().ty + '>'; html += '<' + ty + '>'; st.push({ind, ty}); } else html += '</li>'; }
        else { html += '<' + ty + '>'; st.push({ind, ty}); }
        html += '<li>' + inline(m[3]); continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); closeTo(-1); const lv = Math.min(3, Math.max(2, m[1].length)); html += '<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>'; continue; }
      if (/^(---|\*\*\*|___)\s*$/.test(line)) { flush(); closeTo(-1); html += '<hr>'; continue; }
      if (st.length && /^\s/.test(line)) { html += '<br>' + inline(line.trim()); continue; }
      closeTo(-1); para.push(line);
    }
    flush(); closeTo(-1); return html;
  }

  /* ---------- 部品 ---------- */
  const chip = (name, cls) => { const i = resolve(name); return i === undefined ? '<span class="chip dead">' + esc(name) + '</span>' : '<a class="chip' + (cls || '') + '" href="#/n/' + enc(N.list[i].n) + '" data-n="' + esc(N.list[i].n) + '">' + esc(N.list[i].n) + '</a>'; };
  const chips = idxs => idxs.map(i => '<a class="chip" href="#/n/' + enc(N.list[i].n) + '" data-n="' + esc(N.list[i].n) + '">' + esc(N.list[i].n) + '</a>').join('');
  const byJa = (a, b) => N.list[a].n.localeCompare(N.list[b].n, 'ja');
  const snippet = (n, len) => (n.s || '').length > len ? n.s.slice(0, len) + '…' : (n.s || '');
  function tabs(active) { return Q.tabsHTML(active); }

  function noteHTML(n, body) {
    let h = '<div class="nhead"><span class="badge">' + TYPE[n.t] + '</span><h1 class="nt">' + esc(n.n) + '</h1></div>';
    if (n.t !== 'd' && n.f && n.f.length) h += '<div class="chips">' + n.f.map(fi => N.fieldNote.has(fi) ? chip(N.fields[fi], ' field') : '<span class="chip dead">' + esc(N.fields[fi]) + '</span>').join('') + '</div>';
    if (n.a && n.a.length) h += '<p class="sub" style="margin:6px 0 0">別名: ' + n.a.map(esc).join('、') + '</p>';
    if (n.p && Object.keys(n.p).length) {
      h += '<details class="props"><summary>分野の情報</summary><dl>' + Object.entries(n.p).map(([k, v]) => {
        const items = parseFlow(v); if (!items.length) return '';
        return '<dt>' + esc(k) + '</dt><dd>' + items.map(x => inline(x)).join('<span class="sep">、</span>') + '</dd>';
      }).join('') + '</dl></details>';
    }
    h += '<div class="md">' + md(body) + '</div>';
    if (n.t === 'd') {
      const fi = N.fields.indexOf(n.n); const mem = (N.members.get(fi) || []).slice().sort(byJa);
      if (mem.length) h += '<details class="sec"><summary>この分野の概念(' + mem.length + ')</summary><input class="flt" type="search" placeholder="この分野の中を絞り込む" data-flt><div class="chips big" data-list>' + chips(mem) + '</div></details>';
    }
    const bl = (n.bl || []).slice().sort(byJa);
    if (bl.length) h += '<details class="sec"><summary>このノートにリンクしているノート(' + bl.length + ')</summary><div class="chips big" data-list>' + chips(bl.slice(0, 80)) + '</div>' + (bl.length > 80 ? '<button class="ghost" data-more>残り' + (bl.length - 80) + '件も表示</button>' : '') + '</details>';
    return h;
  }
  function wireNote(root, n) {
    const f = root.querySelector('[data-flt]');
    if (f) f.oninput = () => { const q = norm(f.value); root.querySelectorAll('[data-list] .chip').forEach(c => { c.hidden = q && !norm(c.textContent).includes(q); }); };
    const mb = root.querySelector('[data-more]');
    if (mb) mb.onclick = () => { const list = root.querySelector('details.sec:last-of-type [data-list]'); const bl = (n.bl || []).slice().sort(byJa); list.innerHTML = chips(bl); mb.remove(); };
  }
  function addRecent(name) {
    const r = (S.meta.recent || []).filter(x => x !== name); r.unshift(name); S.meta.recent = r.slice(0, 20); Q.saveMeta('recent', S.meta.recent);
  }

  /* ---------- 画面: ノート一覧(検索) ---------- */
  function search(q, full) {
    const nq = norm(q.trim()); if (!nq) return []; const res = [];
    N.list.forEach((n, i) => {
      const nn = n._nn || (n._nn = norm(n.n)); let sc = 99;
      if (nn === nq) sc = 0; else if (nn.startsWith(nq)) sc = 1;
      else {
        const na = n._na || (n._na = (n.a || []).map(norm));
        if (na.some(a => a === nq)) sc = 2; else if (na.some(a => a.startsWith(nq))) sc = 3;
        else if (nn.includes(nq)) sc = 4; else if (na.some(a => a.includes(nq))) sc = 5;
        else if (full && bodySync(i).includes(q.trim())) sc = 6;
      }
      if (sc < 99) res.push([sc, nn.length, i]);
    });
    res.sort((a, b) => a[0] - b[0] || a[1] - b[1]); return res.slice(0, 60).map(x => x[2]);
  }
  function resItem(i) {
    const n = N.list[i]; const fl = n.t === 'd' ? '分野' : (n.f && n.f.length ? N.fields[n.f[0]] : TYPE[n.t]);
    return '<a class="res" href="#/n/' + enc(n.n) + '" data-n="' + esc(n.n) + '"><b>' + esc(n.n) + '</b><span class="sub">' + esc(fl) + ' ・ ' + esc(snippet(n, 44)) + '</span></a>';
  }
  function tree() {
    const discs = N.list.map((n, i) => [n, i]).filter(x => x[0].t === 'd'); const kids = new Map(), hasParent = new Set();
    discs.forEach(([n, i]) => parseFlow((n.p || {})['上位分野']).map(linkName).filter(Boolean).forEach(pn => { const pi = N.byName.get(pn); if (pi !== undefined && N.list[pi].t === 'd') { (kids.get(pi) || kids.set(pi, []).get(pi)).push(i); hasParent.add(i); } }));
    const cnt = i => (N.members.get(N.fields.indexOf(N.list[i].n)) || []).length;
    const node = (i, path) => {
      const n = N.list[i], ks = (kids.get(i) || []).filter(k => !path.has(k)).sort(byJa);
      const a = '<a href="#/n/' + enc(n.n) + '" data-n="' + esc(n.n) + '">' + esc(n.n) + '</a> <span class="sub">' + cnt(i) + '</span>';
      if (!ks.length) return '<div class="leaf">' + a + '</div>';
      const p2 = new Set(path); p2.add(i);
      return '<details><summary>' + a + '</summary><div class="kids">' + ks.map(k => node(k, p2)).join('') + '</div></details>';
    };
    const roots = discs.map(x => x[1]).filter(i => !hasParent.has(i)).sort(byJa);
    return roots.map(i => node(i, new Set())).join('');
  }
  async function hub() {
    const my = ++token;
    Q.$app.innerHTML = '<main>' + tabs('notes') + '<p class="sub">ノートを読み込んでいます(初回は少し時間がかかります)…</p></main>';
    try { await ensure(); } catch (e) { if (my === token) Q.$app.innerHTML = '<main>' + tabs('notes') + '<div class="notice">ノートのデータを読み込めませんでした。(' + esc(e.message) + ')</div></main>'; Q.bindTabs(); return; }
    if (my !== token) return;
    const recent = (S.meta.recent || []).map(x => N.byName.get(x)).filter(i => i !== undefined);
    Q.$app.innerHTML = '<main>' + tabs('notes') +
      '<div class="card"><input id="q" class="srch" type="search" placeholder="概念・分野・人物を検索(別名も対象)" autocomplete="off"><label class="chk"><input id="full" type="checkbox"> 本文も検索する</label>' +
      '<div class="row" style="margin-top:10px"><button class="ghost" id="rnd">ランダムに開く</button><span class="sub">' + N.list.length.toLocaleString() + '件</span></div></div>' +
      '<div id="results"></div><div id="browse">' +
      (recent.length ? '<div class="card"><h2>最近見たノート</h2><div class="chips">' + chips(recent) + '</div></div>' : '') +
      '<div class="card"><h2>分野から探す</h2><div class="tree">' + tree() + '</div></div></div></main>';
    Q.bindTabs();
    const qi = document.getElementById('q'), fu = document.getElementById('full'), rs = document.getElementById('results'), br = document.getElementById('browse'); let t;
    let runId = 0;
    const run = async () => { const id = ++runId, q = qi.value; if (!q.trim()) { rs.innerHTML = ''; br.hidden = false; return; } br.hidden = true;
      if (fu.checked && !N.allLoaded) { rs.innerHTML = '<p class="sub" id="ld">本文を読み込んでいます(初回のみ)…</p>'; try { await loadAll((a, b) => { const l = document.getElementById('ld'); if (l) l.textContent = '本文を読み込んでいます(初回のみ)… ' + a + '/' + b; }); } catch (e) { rs.innerHTML = '<div class="notice">本文を読み込めませんでした。</div>'; return; } if (id !== runId) return; }
      const r = search(q, fu.checked); rs.innerHTML = r.length ? '<div class="card list">' + r.map(resItem).join('') + '</div>' : '<p class="sub">見つかりませんでした。</p>'; };
    qi.oninput = () => { clearTimeout(t); t = setTimeout(run, 120); }; fu.onchange = run;
    document.getElementById('rnd').onclick = () => { const cs = N.list.map((n, i) => i).filter(i => N.list[i].t === 'c'); location.hash = '#/n/' + enc(N.list[cs[Math.floor(Math.random() * cs.length)]].n); };
    wireLinks(Q.$app, null);
  }

  /* ---------- 画面: ノート本体 ---------- */
  async function page(name) {
    const my = ++token;
    Q.$app.innerHTML = '<main>' + tabs('notes') + '<p class="sub">読み込んでいます…</p></main>'; Q.bindTabs();
    try { await ensure(); } catch (e) { if (my === token) { Q.$app.innerHTML = '<main>' + tabs('notes') + '<div class="notice">ノートのデータを読み込めませんでした。(' + esc(e.message) + ')</div></main>'; Q.bindTabs(); } return; }
    if (my !== token) return;
    const i = resolve(name); window.scrollTo(0, 0);
    if (i === undefined) { Q.$app.innerHTML = '<main>' + tabs('notes') + '<div class="card"><p>「' + esc(name) + '」というノートはありません。</p><a href="#/notes">ノート一覧へ</a></div></main>'; Q.bindTabs(); return; }
    const n = N.list[i]; addRecent(n.n); let body;
    try { body = await bodyOf(i); } catch (e) { if (my === token) { Q.$app.innerHTML = '<main>' + tabs('notes') + '<div class="notice">ノートを読み込めませんでした。(' + esc(e.message) + ')</div></main>'; Q.bindTabs(); } return; }
    if (my !== token) return;
    Q.$app.innerHTML = '<main>' + tabs('notes') + '<div class="top"><button class="link" id="bk">← 戻る</button><a class="link" href="#/notes">検索</a></div><article class="card note">' + noteHTML(n, body) + '</article></main>';
    Q.bindTabs(); document.getElementById('bk').onclick = () => { history.length > 1 ? history.back() : (location.hash = '#/notes'); };
    wireNote(Q.$app, n); wireLinks(Q.$app, null);
  }

  /* ---------- 小窓(クイズの途中でノートを開く) ---------- */
  const sheet = {stack: []};
  function wireLinks(root, onNav) {
    root.addEventListener('click', e => {
      const a = e.target.closest('a[data-n]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (onNav) { e.preventDefault(); onNav(a.dataset.n); }
    });
  }
  async function openSheet(name) {
    const el = document.createElement('div'); el.className = 'sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    el.innerHTML = '<div class="sheet-bar"><button class="link" id="sb">← 戻る</button><span class="sub" id="sn"></span><button class="link" id="sx">閉じる</button></div><div class="sheet-body"><p class="sub">読み込んでいます…</p></div>';
    document.body.appendChild(el); document.body.style.overflow = 'hidden';
    const body = el.querySelector('.sheet-body'), back = el.querySelector('#sb'); const stack = [];
    const close = () => { el.remove(); document.body.style.overflow = ''; };
    const show = async nm => {
      const i = resolve(nm); if (i === undefined) return; const n = N.list[i]; if (stack[stack.length - 1] !== n.n) stack.push(n.n); addRecent(n.n);
      back.hidden = stack.length < 2; let bd;
      try { bd = await bodyOf(i); } catch (e) { body.innerHTML = '<div class="notice">ノートを読み込めませんでした。</div>'; return; }
      if (stack[stack.length - 1] !== n.n) return;
      body.innerHTML = '<article class="note">' + noteHTML(n, bd) + '</article>'; body.scrollTop = 0; el.querySelector('#sn').textContent = '';
      wireNote(body, n);
    };
    el.querySelector('#sx').onclick = close; back.onclick = () => { stack.pop(); const p = stack.pop(); if (p) show(p); };
    wireLinks(el, show);
    el.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    try { await ensure(); show(name); } catch (e) { body.innerHTML = '<div class="notice">ノートのデータを読み込めませんでした。(' + esc(e.message) + ')</div>'; }
  }

  function route(h) {
    const m = /^#\/n\/(.+)$/.exec(h);
    if (m) { let nm; try { nm = decodeURIComponent(m[1]); } catch (e) { nm = m[1]; } page(nm); } else hub();
  }
  window.Notes = {route, openSheet};
})();
