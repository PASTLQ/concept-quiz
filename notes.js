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

  /* ---------- 画面: 分野別(学問ごとのタブで概念を一覧) ---------- */
  let DT = null;
  function dtree() {
    if (DT) return DT;
    const kids = new Map(), hasParent = new Set(), discs = [], fieldOf = new Map();
    N.fields.forEach((f, fi) => fieldOf.set(f, fi));
    N.list.forEach((n, i) => { if (n.t === 'd') discs.push(i); });
    discs.forEach(i => parseFlow((N.list[i].p || {})['上位分野']).map(linkName).filter(Boolean).forEach(pn => {
      const pi = N.byName.get(pn);
      if (pi !== undefined && pi !== i && N.list[pi].t === 'd') { (kids.get(pi) || kids.set(pi, []).get(pi)).push(i); hasParent.add(i); }
    }));
    const covered = new Set();
    const mk = (i, depth) => ({name: N.list[i].n, di: i, depth, fis: fieldOf.has(N.list[i].n) ? [fieldOf.get(N.list[i].n)] : []});
    const roots = discs.filter(i => !hasParent.has(i)).sort(byJa).map(ri => {
      const root = mk(ri, 0), subs = [], seen = new Set([ri]);
      const walk = (i, depth, owner) => (kids.get(i) || []).slice().sort(byJa).forEach(k => {
        if (seen.has(k)) return; seen.add(k);
        const e = mk(k, depth); subs.push(e); walk(k, depth + 1, e);
        owner.fis.push(...e.fis);
      });
      walk(ri, 1, root); root.subs = subs; return root;
    });
    roots.forEach(r => { r.fis.forEach(f => covered.add(f)); });
    // 分野ノートが無い分野(概念側にだけ書かれている分野)は「その他」にまとめる
    const orph = []; N.fields.forEach((f, fi) => { if (!covered.has(fi) && (N.members.get(fi) || []).length) orph.push({name: f, di: -1, depth: 1, fis: [fi]}); });
    orph.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    if (orph.length) roots.push({name: 'その他', di: -1, depth: 0, fis: orph.map(o => o.fis[0]), subs: orph});
    return (DT = {roots});
  }
  const F = {root: null, sub: -1, q: '', ppl: false, shown: 100, y: 0};
  const members = (fis, ppl) => {
    const set = new Set(); fis.forEach(fi => (N.members.get(fi) || []).forEach(i => { if (ppl || N.list[i].t === 'c') set.add(i); }));
    return set;
  };

  /* ---------- 部品 ---------- */
  const chip = (name, cls) => { const i = resolve(name); return i === undefined ? '<span class="chip dead">' + esc(name) + '</span>' : '<a class="chip' + (cls || '') + '" href="#/n/' + enc(N.list[i].n) + '" data-n="' + esc(N.list[i].n) + '">' + esc(N.list[i].n) + '</a>'; };
  const chips = idxs => idxs.map(i => '<a class="chip" href="#/n/' + enc(N.list[i].n) + '" data-n="' + esc(N.list[i].n) + '">' + esc(N.list[i].n) + '</a>').join('');
  const byJa = (a, b) => N.list[a].n.localeCompare(N.list[b].n, 'ja');
  const snippet = (n, len) => (n.s || '').length > len ? n.s.slice(0, len) + '…' : (n.s || '');
  const view = html => Q.view(html, 'find');
  const loadingView = () => view('<p class="para">ノートを読み込んでいます(初回は少し時間がかかります)…</p>');
  const failView = (what, e) => view('<div class="notice" role="alert"><b>読み込めませんでした。</b>' + what + '(' + esc(e.message) + ')</div><a class="btn" href="#/notes">探すに戻る</a>');
  const backBar = (to, label) => '<header class="qhead"><button class="btn btn-quiet" id="bk">← ' + label + '</button></header>';
  function bindBack(fallback) { const b = document.getElementById('bk'); if (b) b.onclick = () => { history.length > 1 ? history.back() : (location.hash = fallback); }; }

  function noteHTML(n, body) {
    let h = '<div class="nhead"><span class="kind">' + TYPE[n.t] + '</span><h1>' + esc(n.n) + '</h1></div>';
    if (n.t !== 'd' && n.f && n.f.length) h += '<div class="chips">' + n.f.map(fi => N.fieldNote.has(fi) ? chip(N.fields[fi], ' field') : '<span class="chip dead">' + esc(N.fields[fi]) + '</span>').join('') + '</div>';
    if (n.a && n.a.length) h += '<p class="muted small">別名　' + n.a.map(esc).join('、') + '</p>';
    if (n.p && Object.keys(n.p).length) {
      h += '<details class="props"><summary>分野の情報</summary><dl>' + Object.entries(n.p).map(([k, v]) => {
        const items = parseFlow(v); if (!items.length) return '';
        return '<dt>' + esc(k) + '</dt><dd>' + items.map(x => inline(x)).join('<span class="sep">、</span>') + '</dd>';
      }).join('') + '</dl></details>';
    }
    h += '<div class="md">' + md(body) + '</div>';
    if (n.t === 'd') {
      const fi = N.fields.indexOf(n.n); const mem = (N.members.get(fi) || []).slice().sort(byJa);
      if (mem.length) h += '<details class="sec"><summary>この分野の概念(' + mem.length + ')</summary><input class="srch" type="search" placeholder="この分野の中を絞り込む" aria-label="この分野の中を絞り込む" data-flt><div class="chips" data-list>' + chips(mem) + '</div></details>';
    }
    const bl = (n.bl || []).slice().sort(byJa);
    if (bl.length) h += '<details class="sec" data-bl><summary>このノートにリンクしているノート(' + bl.length + ')</summary><div class="chips" data-list>' + chips(bl.slice(0, 80)) + '</div>' + (bl.length > 80 ? '<button class="btn btn-sm" data-more>残り' + (bl.length - 80) + '件も表示</button>' : '') + '</details>';
    return h;
  }
  function wireNote(root, n) {
    const f = root.querySelector('[data-flt]');
    if (f) f.oninput = () => { const q = norm(f.value); root.querySelectorAll('[data-list] .chip').forEach(c => { c.hidden = q && !norm(c.textContent).includes(q); }); };
    const mb = root.querySelector('[data-more]');
    if (mb) mb.onclick = () => { const list = root.querySelector('details[data-bl] [data-list]'); const bl = (n.bl || []).slice().sort(byJa); list.innerHTML = chips(bl); mb.remove(); };
  }
  function addRecent(name) {
    const r = (S.meta.recent || []).filter(x => x !== name); r.unshift(name); S.meta.recent = r.slice(0, 20); Q.saveMeta('recent', S.meta.recent);
  }

  /* ---------- 画面: 探す(検索と、学問の入口) ---------- */
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
  function resItem(i, withField) {
    const n = N.list[i]; const fl = n.t === 'd' ? '分野' : (n.f && n.f.length ? N.fields[n.f[0]] : TYPE[n.t]);
    return '<a class="res" href="#/n/' + enc(n.n) + '" data-n="' + esc(n.n) + '"><span class="r1"><b>' + esc(n.n) + '</b>' + (withField === false ? (n.t === 'p' ? '<span class="f">人物</span>' : '') : '<span class="f">' + esc(fl) + '</span>') + '</span><span class="s">' + esc(snippet(n, 70)) + '</span></a>';
  }
  async function hub() {
    const my = ++token; loadingView();
    try { await ensure(); } catch (e) { if (my === token) failView('ノートのデータを読み込めませんでした。', e); return; }
    if (my !== token) return;
    const T = dtree();
    const recent = (S.meta.recent || []).map(x => N.byName.get(x)).filter(i => i !== undefined).slice(0, 12);
    view('<header class="head"><h1 class="title">探す</h1><button class="btn btn-sm" id="rnd">ランダム</button></header>' +
      '<div class="stack"><div class="search"><input id="q" class="srch" type="search" placeholder="概念・分野・人物を検索" aria-label="概念・分野・人物を検索" autocomplete="off" enterkeyhint="search"></div>' +
      '<div class="row"><button class="chip" id="full" aria-pressed="false">本文も検索する</button><span class="muted small">別名も対象になります</span></div></div>' +
      '<div id="results" class="stack" role="region" aria-live="polite"></div>' +
      '<div id="browse" class="stack" style="gap:var(--s5)">' +
      (recent.length ? '<section><h2 class="sec-h">最近見たノート</h2><div class="chips scroll-x">' + chips(recent) + '</div></section>' : '') +
      '<section><h2 class="sec-h">学問</h2><nav class="rows" aria-label="学問">' + T.roots.map(r => '<a class="row-link" href="#/fields/' + enc(r.name) + '"><span>' + esc(r.name) + '</span><span class="n">' + members(r.fis, false).size.toLocaleString() + '</span></a>').join('') + '</nav></section>' +
      '<p class="para">収録 ' + N.list.length.toLocaleString() + ' 件</p></div>');
    const qi = document.getElementById('q'), fu = document.getElementById('full'), rs = document.getElementById('results'), br = document.getElementById('browse'); let t, runId = 0, full = false;
    const run = async () => {
      const id = ++runId, q = qi.value; if (!q.trim()) { rs.innerHTML = ''; br.hidden = false; return; } br.hidden = true;
      if (full && !N.allLoaded) { rs.innerHTML = '<p class="para" id="ld">本文を読み込んでいます(初回のみ)…</p>'; try { await loadAll((a, b) => { const l = document.getElementById('ld'); if (l) l.textContent = '本文を読み込んでいます(初回のみ)… ' + a + '/' + b; }); } catch (e) { rs.innerHTML = '<div class="notice" role="alert">本文を読み込めませんでした。</div>'; return; } if (id !== runId) return; }
      const r = search(q, full); rs.innerHTML = r.length ? '<p class="muted small">' + r.length + '件' + (r.length >= 60 ? '(上位60件)' : '') + '</p><div class="rows">' + r.map(i => resItem(i)).join('') + '</div>' : '<p class="para">見つかりませんでした。</p>';
    };
    qi.oninput = () => { clearTimeout(t); t = setTimeout(run, 120); };
    fu.onclick = () => { full = !full; fu.setAttribute('aria-pressed', full); run(); };
    document.getElementById('rnd').onclick = () => { const cs = N.list.map((n, i) => i).filter(i => N.list[i].t === 'c'); location.hash = '#/n/' + enc(N.list[cs[Math.floor(Math.random() * cs.length)]].n); };
    wireLinks(Q.$app, null);
  }

  /* ---------- 画面: ノート本体 ---------- */
  async function page(name) {
    const my = ++token; loadingView();
    try { await ensure(); } catch (e) { if (my === token) failView('ノートのデータを読み込めませんでした。', e); return; }
    if (my !== token) return;
    const i = resolve(name); window.scrollTo(0, 0);
    if (i === undefined) { view(backBar('#/notes', '戻る') + '<p>「' + esc(name) + '」というノートはありません。</p><a class="btn" href="#/notes">探すに戻る</a>'); bindBack('#/notes'); return; }
    const n = N.list[i]; addRecent(n.n); let body;
    try { body = await bodyOf(i); } catch (e) { if (my === token) failView('ノートを読み込めませんでした。', e); return; }
    if (my !== token) return;
    view(backBar('#/notes', '戻る') + '<article class="note">' + noteHTML(n, body) + '</article>');
    bindBack('#/notes'); wireNote(Q.$app, n); wireLinks(Q.$app, null);
  }


  function fres(i) {
    const n = N.list[i], fl = n.t === 'p' ? '人物' : (n.f || []).slice(0, 2).map(f => N.fields[f]).join('、') + ((n.f || []).length > 2 ? '…' : '');
    return '<a class="res" href="#/n/' + enc(n.n) + '" data-n="' + esc(n.n) + '"><span class="r1"><b>' + esc(n.n) + '</b><span class="f">' + esc(fl) + '</span></span><span class="s">' + esc(snippet(n, 70)) + '</span></a>';
  }
  async function fieldsPage(rootName) {
    const my = ++token; loadingView();
    try { await ensure(); } catch (e) { if (my === token) failView('ノートのデータを読み込めませんでした。', e); return; }
    if (my !== token) return;
    const T = dtree(); const root = T.roots.find(r => r.name === rootName);
    if (!root) { hub(); return; }
    if (F.root !== root.name) { F.root = root.name; F.sub = -1; F.q = ''; F.shown = 100; }
    window.scrollTo(0, 0); render(true);
    function render(first) {
      const subIdx = F.sub >= 0 && root.subs[F.sub] ? F.sub : -1; F.sub = subIdx;
      const opts = '<option value="-1">' + esc(root.name) + ' の全体(' + members(root.fis, F.ppl).size.toLocaleString() + ')</option>' +
        root.subs.map((e, k) => '<option value="' + k + '"' + (k === subIdx ? ' selected' : '') + '>' + '　'.repeat(Math.max(0, e.depth - 1)) + esc(e.name) + '(' + members(e.fis, F.ppl).size.toLocaleString() + ')</option>').join('');
      const cur = subIdx >= 0 ? root.subs[subIdx] : root;
      view(backBar('#/notes', '探す') + '<header class="head"><h1 class="title">' + esc(root.name) + '</h1><span class="aside" id="fc"></span></header>' +
        '<div class="stack">' + (root.subs.length ? '<div class="field"><label for="fsub">分野を絞る</label><div class="sel"><select id="fsub">' + opts + '</select></div></div>' : '') +
        '<div class="search"><input id="fq" class="srch" type="search" placeholder="この範囲の中を絞り込む" aria-label="この範囲の中を絞り込む" autocomplete="off" value="' + esc(F.q) + '"></div>' +
        '<div class="row"><button class="chip" id="fp" aria-pressed="' + F.ppl + '">人物も含める</button>' + (cur.di >= 0 ? '<a class="btn btn-quiet btn-sm" href="#/n/' + enc(cur.name) + '" data-n="' + esc(cur.name) + '">' + esc(cur.name) + 'のノート</a>' : '') + '</div></div>' +
        '<div class="rows" id="flist"></div><button class="btn btn-block" id="fmore" hidden>さらに表示</button>');
      document.getElementById('bk').onclick = () => { location.hash = '#/notes'; };
      const list = document.getElementById('flist'), more = document.getElementById('fmore'), fc = document.getElementById('fc');
      const all = [...members(cur.fis, F.ppl)].sort(byJa); let ids = all;
      const draw = () => {
        const nq = norm(F.q.trim());
        ids = nq ? all.filter(i => { const n = N.list[i]; const nn = n._nn || (n._nn = norm(n.n)); return nn.includes(nq) || (n.a || []).some(a => norm(a).includes(nq)); }) : all;
        list.innerHTML = ids.length ? ids.slice(0, F.shown).map(fres).join('') : '<p class="para" style="padding:var(--s3) 0">該当するノートがありません。</p>';
        fc.textContent = ids.length.toLocaleString() + '件';
        more.hidden = ids.length <= F.shown; more.textContent = 'さらに表示(あと ' + Math.min(200, ids.length - F.shown).toLocaleString() + '件)';
      };
      draw();
      more.onclick = () => { F.shown += 200; draw(); };
      const fs = document.getElementById('fsub'); if (fs) fs.onchange = () => { F.sub = +fs.value; F.shown = 100; render(); };
      let t; const fq = document.getElementById('fq');
      fq.oninput = () => { clearTimeout(t); t = setTimeout(() => { F.q = fq.value; F.shown = 100; draw(); }, 150); };
      document.getElementById('fp').onclick = () => { F.ppl = !F.ppl; F.shown = 100; render(); };
      list.addEventListener('click', e => { if (e.target.closest('a[data-n]')) F.y = window.scrollY; });
      if (first && F.y) { window.scrollTo(0, F.y); F.y = 0; }
    }
  }

  /* ---------- 小窓(クイズの途中でノートを開く) ---------- */
  function wireLinks(root, onNav) {
    root.addEventListener('click', e => {
      const a = e.target.closest('a[data-n]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (onNav) { e.preventDefault(); onNav(a.dataset.n); }
    });
  }
  async function openSheet(name) {
    const m = Q.modal({title: ''}), body = m.body;
    const back = document.createElement('button'); back.className = 'btn btn-quiet'; back.textContent = '← 戻る'; back.hidden = true; m.left.appendChild(back);
    body.innerHTML = '<p class="para">読み込んでいます…</p>'; const stack = [];
    const show = async nm => {
      const i = resolve(nm); if (i === undefined) return; const n = N.list[i]; if (stack[stack.length - 1] !== n.n) stack.push(n.n); addRecent(n.n);
      back.hidden = stack.length < 2; let bd;
      try { bd = await bodyOf(i); } catch (e) { body.innerHTML = '<div class="notice" role="alert">ノートを読み込めませんでした。</div>'; return; }
      if (stack[stack.length - 1] !== n.n) return;
      body.innerHTML = '<article class="note">' + noteHTML(n, bd) + '</article>'; body.scrollTop = 0;
      wireNote(body, n);
    };
    back.onclick = () => { stack.pop(); const p = stack.pop(); if (p) show(p); };
    wireLinks(m.el, show);
    try { await ensure(); show(name); } catch (e) { body.innerHTML = '<div class="notice" role="alert"><b>読み込めませんでした。</b>' + esc(e.message) + '</div>'; }
  }

  function route(h) {
    const fm = /^#\/fields(?:\/(.*))?$/.exec(h);
    if (fm) { let nm = ''; try { nm = decodeURIComponent(fm[1] || ''); } catch (e) { nm = fm[1] || ''; } fieldsPage(nm); return; }
    const m = /^#\/n\/(.+)$/.exec(h);
    if (m) { let nm; try { nm = decodeURIComponent(m[1]); } catch (e) { nm = m[1]; } page(nm); } else hub();
  }
  window.Notes = {route, openSheet, api: {ensure, N, bodyOf, resolve, chunk, isLoaded: c => chunkD.has(c)}};
})();
