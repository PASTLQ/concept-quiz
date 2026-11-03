'use strict';
/* 概念クイズ: ノート→questions.json、復習日はFSRS、記録は端末内(IndexedDB) */
(function () {
  const {fsrs, generatorParameters, createEmptyCard, Rating, State} = window.FSRS;
  const $app = document.getElementById('app');
  const DAY = 86400000;
  const DEFAULTS = {method: 'choice', mode: 'both', field: -1, size: 20, newPerDay: 20, unlimited: false};

  const S = {data: null, byName: new Map(), byField: new Map(), cards: new Map(), settings: {...DEFAULTS},
             meta: {}, log: [], db: null, session: null, dbOk: true};
  const sched = fsrs(generatorParameters({enable_fuzz: true, enable_short_term: false, request_retention: 0.9}));

  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  /* ---------- IndexedDB ---------- */
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('concept-quiz', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('cards', {keyPath: 'id'});
        d.createObjectStore('meta', {keyPath: 'k'});
        d.createObjectStore('log', {autoIncrement: true});
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const tx = (store, mode, fn) => new Promise((res, rej) => {
    if (!S.db) return res(null);
    const t = S.db.transaction(store, mode); const st = t.objectStore(store); const out = fn(st);
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : null); t.onerror = () => rej(t.error);
  });
  const getAll = store => new Promise((res, rej) => {
    if (!S.db) return res([]);
    const r = S.db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const saveCard = c => tx('cards', 'readwrite', s => s.put(ser(c)));
  const saveMeta = (k, v) => tx('meta', 'readwrite', s => s.put({k, v}));
  const addLog = e => { S.log.push(e); return tx('log', 'readwrite', s => s.add(e)); };

  function ser(c) { return {...c, due: +new Date(c.due), last_review: c.last_review ? +new Date(c.last_review) : null}; }
  function de(o) { return {...o, due: new Date(o.due), last_review: o.last_review ? new Date(o.last_review) : undefined}; }

  /* ---------- データ ---------- */
  /* 暗号化データ(questions.enc): AES-GCM、鍵は合言葉からPBKDF2で導出。gzip済みJSONを暗号化 */
  const b64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
  async function deriveKey(pass, enc) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
  }
  async function decryptWith(key, enc) {
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: b64(enc.iv)}, key, b64(enc.ct));
    const out = new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip')));
    return JSON.parse(await out.text());
  }
  function view(html, tab) { $app.innerHTML = '<main class="wrap">' + html + '</main>'; setTab(tab || null); }
  function setTab(t) {
    const nav = document.getElementById('tabbar'); nav.hidden = !t; document.body.classList.toggle('has-tabs', !!t);
    nav.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
  }
  /* 下から出るシート。背景は操作できなくする */
  function modal(o) {
    const nav = document.getElementById('tabbar'), prev = document.activeElement;
    const el = document.createElement('div'); el.className = 'sheet';
    el.innerHTML = '<div class="sheet-panel" role="dialog" aria-modal="true" aria-label="' + esc(o.title || 'ノート') + '" tabindex="-1"><div class="sheet-bar"><span class="slot-l"></span><span class="t">' + esc(o.title || '') + '</span><button class="btn btn-quiet" data-x>閉じる</button></div><div class="sheet-body"></div></div>';
    document.body.appendChild(el); document.body.style.overflow = 'hidden'; $app.inert = true; nav.inert = true;
    const close = () => {
      if (!el.isConnected) return; el.remove(); document.body.style.overflow = ''; $app.inert = false; nav.inert = false;
      try { if (prev && prev.isConnected) prev.focus(); } catch (e) {}
      if (o.onClose) o.onClose();
    };
    el.addEventListener('click', e => { if (e.target === el) close(); });
    el.querySelector('[data-x]').onclick = close;
    el.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    el.querySelector('.sheet-panel').focus();
    return {el, body: el.querySelector('.sheet-body'), left: el.querySelector('.slot-l'), close};
  }

  function askPassphrase(note) {
    return new Promise(res => {
      view('<h1 class="title">概念クイズ</h1><form class="stack" id="pf" style="gap:var(--s4)"><p class="para">問題データは暗号化されています。合言葉を入れてください。この端末では、次回から聞きません。</p>' +
        '<div class="field"><label for="pp">合言葉</label><input id="pp" type="password" autocomplete="current-password"></div>' +
        (note ? '<p class="notice" role="alert">' + esc(note) + '</p>' : '') + '<button class="btn btn-primary btn-block" id="pb">開く</button></form>');
      document.getElementById('pp').focus();
      document.getElementById('pf').onsubmit = ev => { ev.preventDefault(); const v = document.getElementById('pp').value; if (v) res(v); };
    });
  }
  // 保存済みの鍵で開けなければ、合言葉を聞いて開く
  async function decryptAny(enc) {
    if (S.meta.key) { try { return await decryptWith(S.meta.key, enc); } catch (e) {} }
    let note = '';
    for (;;) {
      const pass = await askPassphrase(note);
      try { const key = await deriveKey(pass, enc); const data = await decryptWith(key, enc); S.meta.key = key; await saveMeta('key', key); return data; }
      catch (e) { note = '開けませんでした。合言葉を確かめてください。'; }
    }
  }
  let fmt = null; // 'json' か 'enc'。最初に見つかった形式を使い続ける(無駄な404を出さない)
  async function loadAux(base) {
    if (fmt !== 'enc') { try { const r = await fetch(base + '.json'); if (r.ok) { fmt = 'json'; return await r.json(); } } catch (e) {} }
    if (fmt === 'json') throw new Error('データが見つかりません(' + base + ')');
    const r = await fetch(base + '.enc'); if (!r.ok) throw new Error('データが見つかりません(' + base + ')');
    fmt = 'enc'; return decryptAny(await r.json());
  }
  async function loadData() {
    try { const r = await fetch('questions.json'); if (r.ok) return await r.json(); } catch (e) {}
    const r = await fetch('questions.enc'); if (!r.ok) throw new Error('問題データが見つかりません');
    return decryptAny(await r.json());
  }

  async function load() {
    try { S.db = await openDB(); } catch (e) { S.dbOk = false; S.db = null; }
    (await getAll('meta')).forEach(m => S.meta[m.k] = m.v);
    S.data = await loadData();
    S.data.items.forEach((it, i) => {
      S.byName.set(it.n, i);
      it.f.forEach(f => S.byField.has(f) ? S.byField.get(f).push(i) : S.byField.set(f, [i]));
    });
    const cs = await getAll('cards'); cs.forEach(o => S.cards.set(o.id, de(o)));
    S.log = await getAll('log');
    S.settings = {...DEFAULTS, ...(S.meta.settings || {})};
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  /* ---------- 出題 ---------- */
  const dirOk = (it, d) => ((it.k === undefined ? 3 : it.k) & (d.slice(-1) === 'd' ? 1 : 2)) !== 0;
  // 方式: choice=4択(d,n)、card=単語帳(fd,fn)。単語帳は同じ概念でも別カードとして記録する
  const dirsFor = st => (st.mode === 'both' ? ['d', 'n'] : [st.mode]).map(d => (st.method === 'card' ? 'f' : '') + d);
  const inField = (it, f) => f < 0 || it.f.includes(f);

  function newKeysAvailable(st) {
    const out = [];
    const ds = dirsFor(st);
    S.data.items.forEach(it => {
      if (!inField(it, st.field)) return;
      for (const d of ds) if (dirOk(it, d) && !S.cards.has(it.n + '|' + d)) out.push(it.n + '|' + d);
    });
    return out;
  }
  function dueKeys(st, now) {
    const ds = dirsFor(st), out = [];
    S.cards.forEach((c, id) => {
      if (c.state === State.New || c.due > now) return;
      const [n, d] = splitKey(id); const i = S.byName.get(n);
      if (i === undefined || !ds.includes(d)) return;
      const it = S.data.items[i]; if (!inField(it, st.field) || !dirOk(it, d)) return;
      out.push(c);
    });
    out.sort((a, b) => a.due - b.due);
    return out.map(c => c.id);
  }
  const splitKey = id => { const k = id.lastIndexOf('|'); return [id.slice(0, k), id.slice(k + 1)]; };
  const newQuota = () => { const m = S.meta.newCount; return Math.max(0, S.settings.newPerDay - (m && m.date === today() ? m.n : 0)); };

  function related(a, b) {
    const x = a.n, y = b.n;
    if ((x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y))) return true;
    const aa = new Set([x, ...(a.a || [])]);
    return [y, ...(b.a || [])].some(z => aa.has(z));
  }
  function distractors(it, d, field) {
    const pick = (pool, n) => {
      const cand = pool.map(i => S.data.items[i]).filter(o => o !== it && dirOk(o, d) && !related(it, o));
      const sameStart = o => d === 'n' && o.d.slice(0, 10) === it.d.slice(0, 10);
      const len = o => d === 'd' ? o.n.length : o.d.length;
      const base = d === 'd' ? it.n.length : it.d.length;
      const scored = cand.filter(o => !sameStart(o)).map(o => [Math.abs(len(o) - base) + Math.random() * 25, o]).sort((a, b) => a[0] - b[0]);
      return scored.slice(0, 18).map(x => x[1]);
    };
    let c = pick(S.byField.get(field) || [], 3);
    if (c.length < 12) { const more = []; S.data.items.forEach((o, i) => { if (o.f.some(f => it.f.includes(f))) more.push(i); }); c = pick(more, 3); }
    if (c.length < 3) c = pick(S.data.items.map((_, i) => i).sort(() => Math.random() - .5).slice(0, 200), 3);
    return shuffle(c.slice()).slice(0, 3);
  }
  function makeQuestion(id) {
    const [name, d0] = splitKey(id); const it = S.data.items[S.byName.get(name)];
    // 分野を絞っているときは、その分野を表示し、選択肢もその分野から選ぶ
    const fsel = S.session ? S.session.fieldSel : -1; const fld = (fsel >= 0 && it.f.includes(fsel)) ? fsel : it.f[0];
    if (d0[0] === 'f') {
      const d = d0.slice(1);
      return {id, d, flash: true, it, opts: [], answer: -1, field: S.data.fields[fld],
              stem: d === 'd' ? '「＿＿は、' + (it.m || it.d) + '」\nこの説明があてはまる概念を思い出してください。' : '「' + it.n + '」とは何か、思い出してください。'};
    }
    const d = d0;
    const ds = distractors(it, d, fld); const opts = shuffle([it, ...ds]);
    return {id, d, it, opts, answer: opts.indexOf(it),
            field: S.data.fields[fld],
            stem: d === 'd' ? '「＿＿は、' + (it.m || it.d) + '」\nこの説明にあてはまる概念はどれ?' : '「' + it.n + '」の説明として正しいものはどれ?'};
  }

  const isCloze = id => /\|w$/.test(id);
  async function startCloze(o) {
    const st = S.settings, now = new Date(), unl = !!(st.unlimited || (o && o.unl));
    view('<p class="para">問題を用意しています(初回は少し時間がかかります)…</p>');
    let q;
    try {
      await window.Cloze.ensure();
      const due = window.Cloze.dueKeys(st, now); q = due.slice(0, unl ? 40 : st.size);
      const room = unl ? 40 - q.length : Math.min(st.size - q.length, newQuota());
      if (room > 0) q = q.concat(await window.Cloze.newKeys(st, room, new Set(q)));
    } catch (e) { view('<div class="notice" role="alert"><b>用意できませんでした。</b>' + esc(e.message) + '</div><button class="btn" id="hm">今日に戻る</button>'); document.getElementById('hm').onclick = home; return; }
    if (!q.length) { home(); return; }
    S.session = {queue: q.map(id => ({id, redo: false})), pos: 0, total: q.length, correct: 0, wrong: 0, newDone: 0, q: null, answered: false,
                 fieldSel: st.field, unlimited: unl, seen: new Set(q), exhausted: false, pending: null};
    showQuestion();
  }
  function startSession(o) {
    if (S.settings.method === 'cloze') { startCloze(o); return; }
    const st = S.settings, now = new Date(), unl = !!(st.unlimited || (o && o.unl));
    let q;
    if (unl) { q = dueKeys(st, now).slice(0, 40); q = q.concat(shuffle(newKeysAvailable(st)).slice(0, 40 - q.length)); }
    else {
      q = dueKeys(st, now).slice(0, st.size);
      const room = Math.min(st.size - q.length, newQuota());
      if (room > 0) q = q.concat(shuffle(newKeysAvailable(st)).slice(0, room));
    }
    if (!q.length) return;
    S.session = {queue: q.map(id => ({id, redo: false})), pos: 0, total: q.length, correct: 0, wrong: 0, newDone: 0, q: null, answered: false,
                 fieldSel: st.field, unlimited: unl, seen: new Set(q), exhausted: false};
    showQuestion();
  }
  // 上限なしのとき、残りが少なくなったら次の問題を足す(期限の来た復習→新規の順)
  function refill() {
    const se = S.session; if (!se.unlimited || se.exhausted || se.queue.length - se.pos > 5) return;
    if (S.settings.method === 'cloze') {
      if (se.pending) return;
      se.pending = (async () => {
        const st = S.settings; let add = window.Cloze.dueKeys(st, new Date()).filter(id => !se.seen.has(id)).slice(0, 30);
        if (add.length < 30) add = add.concat(await window.Cloze.newKeys(st, 30 - add.length, se.seen));
        if (!add.length) { se.exhausted = true; return; }
        add.forEach(id => { se.seen.add(id); se.queue.push({id, redo: false}); });
      })().catch(() => { se.exhausted = true; }).finally(() => { se.pending = null; });
      return;
    }
    const st = S.settings; let add = dueKeys(st, new Date()).filter(id => !se.seen.has(id)).slice(0, 30);
    if (add.length < 30) add = add.concat(shuffle(newKeysAvailable(st).filter(id => !se.seen.has(id))).slice(0, 30 - add.length));
    if (!add.length) { se.exhausted = true; return; }
    add.forEach(id => { se.seen.add(id); se.queue.push({id, redo: false}); });
  }

  /* ---------- 画面: 今日 ---------- */
  function stats() {
    const learned = [...S.cards.values()].filter(c => c.state !== State.New).length;
    const since = Date.now() - 7 * DAY, recent = S.log.filter(e => e.t >= since), ok = recent.filter(e => e.r >= 2).length;
    return {learned, recent: recent.length, rate: recent.length ? Math.round(ok / recent.length * 100) : null};
  }
  function counts() {
    const st = S.settings, now = new Date();
    let due, avail, loading = false;
    if (st.method === 'cloze') {
      if (window.Cloze && window.Cloze.ready()) { due = window.Cloze.dueKeys(st, now).length; avail = window.Cloze.poolSize(st); }
      else { due = 0; avail = 0; loading = true; window.Cloze && window.Cloze.ensure().then(() => { if (!S.session && S.settings.method === 'cloze' && !location.hash.startsWith('#/')) home(); }).catch(() => {}); }
    } else { due = dueKeys(st, now).length; avail = newKeysAvailable(st).length; }
    return {due, avail, loading};
  }
  const persistSettings = () => { S.meta.settings = S.settings; return saveMeta('settings', S.settings); };
  const METHODS = [['choice', '4択'], ['card', '単語帳'], ['cloze', '穴埋め']];
  const MODES = [['d', '定義→概念名'], ['n', '概念名→定義'], ['both', '両方向']];

  function home() {
    S.session = null;
    const st = S.settings, c = counts(), quota = newQuota();
    const will = st.unlimited ? c.due + c.avail : Math.min(st.size, c.due + Math.min(quota, c.avail));
    const rev = st.unlimited ? c.due : Math.min(st.size, c.due), add = will - rev;
    const cloze = st.method === 'cloze';
    const dirL = cloze ? 'ノート1つで1問' : MODES.find(m => m[0] === st.mode)[1];
    const fldL = st.field >= 0 && S.data.fields[st.field] ? S.data.fields[st.field] : 'すべての分野';
    const sizeL = st.unlimited ? '上限なし' : st.size + '問';
    const date = new Date().toLocaleDateString('ja-JP', {month: 'long', day: 'numeric', weekday: 'short'});
    view('<header class="head"><h1 class="title">今日</h1><span class="aside">' + esc(date) + '</span></header>' +
      (S.dbOk ? '' : '<div class="notice" role="alert"><b>保存できません。</b>この環境では学習記録を保存できません。閉じると消えます。</div>') +
      '<section class="well hero" aria-label="今日の問題数"><p class="cap">' + (c.loading ? 'ノートを読み込んでいます' : st.unlimited ? '上限なしで出題' : '今日の問題') + '</p>' +
      '<p class="num">' + (c.loading ? '–' : will.toLocaleString() + '<small>問</small>') + '</p>' +
      (c.loading ? '' : '<p class="sub"><span>復習<b>' + rev.toLocaleString() + '</b></span><span>新規<b>' + add.toLocaleString() + '</b></span></p>') + '</section>' +
      '<div class="stack">' +
      (will && !c.loading ? '<button class="btn btn-primary btn-block" id="go">始める</button>'
        : '<button class="btn btn-primary btn-block" id="go" disabled>' + (c.loading ? '読み込み中' : '今日はここまで') + '</button>' +
          (!c.loading && c.avail > 0 ? '<button class="btn btn-block" id="more">上限を外して続ける</button>' : '')) +
      '</div>' +
      '<section class="stack"><div class="seg" role="group" aria-label="出題の方式">' + METHODS.map(m => '<button data-method="' + m[0] + '" aria-pressed="' + (st.method === m[0]) + '">' + m[1] + '</button>').join('') + '</div>' +
      '<button class="cond" id="cond" aria-haspopup="dialog"><span><small>' + (cloze ? '形式' : '向き') + '</small><b>' + esc(dirL) + '</b></span><span><small>分野</small><b>' + esc(fldL) + '</b></span><span><small>1回</small><b>' + esc(sizeL) + '</b></span></button></section>',
      'today');
    $app.querySelectorAll('[data-method]').forEach(b => b.onclick = () => { S.settings.method = b.dataset.method; persistSettings(); home(); });
    document.getElementById('cond').onclick = openSettings;
    document.getElementById('go').onclick = () => startSession();
    const mb = document.getElementById('more'); if (mb) mb.onclick = () => startSession({unl: true});
  }

  function openSettings() {
    const m = modal({title: '出題の条件', onClose: home});
    const draw = focusId => {
      const st = S.settings, cloze = st.method === 'cloze';
      const fopts = '<option value="-1">すべての分野</option>' + S.data.fields.map((f, i) => ({f, i})).sort((a, b) => a.f.localeCompare(b.f, 'ja')).map(o => '<option value="' + o.i + '"' + (o.i === st.field ? ' selected' : '') + '>' + esc(o.f) + '(' + (S.byField.get(o.i) || []).length + ')</option>').join('');
      m.body.innerHTML = '<div class="stack" style="gap:var(--s5)">' +
        (cloze ? '<p class="para">穴埋めは、ノート1つを丸ごと1問にして、本文にある概念のリンクを空欄にします。下の語から選んで埋めます。</p>'
          : '<div class="field"><span class="label" id="dl">向き</span><div class="seg" role="group" aria-labelledby="dl">' + MODES.map(x => '<button data-mode="' + x[0] + '" aria-pressed="' + (st.mode === x[0]) + '">' + x[1] + '</button>').join('') + '</div></div>') +
        '<div class="field"><label for="fld">分野</label><div class="sel"><select id="fld">' + fopts + '</select></div></div>' +
        '<div class="row" style="flex-wrap:nowrap;align-items:flex-start"><div class="field grow"><label for="size">1回の問題数</label><input id="size" type="number" inputmode="numeric" min="1" max="9999" value="' + st.size + '"' + (st.unlimited ? ' disabled' : '') + '></div>' +
        '<div class="field grow"><label for="npd">新規の上限(1日)</label><input id="npd" type="number" inputmode="numeric" min="0" max="9999" value="' + st.newPerDay + '"' + (st.unlimited ? ' disabled' : '') + '></div></div>' +
        '<label class="switch-row"><span><b>上限なし</b><small>やめるまで続けます(新規の上限なし)</small></span><input id="unl" class="switch" type="checkbox"' + (st.unlimited ? ' checked' : '') + '></label>' +
        '<button class="btn btn-primary btn-block" id="done">完了</button></div>';
      m.body.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { S.settings.mode = b.dataset.mode; persistSettings(); draw(); });
      m.body.querySelector('#fld').onchange = e => { S.settings.field = +e.target.value; persistSettings(); };
      m.body.querySelector('#size').onchange = e => { S.settings.size = Math.max(1, Math.min(9999, Math.round(+e.target.value) || 20)); e.target.value = S.settings.size; persistSettings(); };
      m.body.querySelector('#npd').onchange = e => { S.settings.newPerDay = Math.max(0, Math.min(9999, Math.round(+e.target.value) || 0)); e.target.value = S.settings.newPerDay; persistSettings(); };
      m.body.querySelector('#unl').onchange = e => { S.settings.unlimited = e.target.checked; persistSettings(); draw('unl'); };
      m.body.querySelector('#done').onclick = m.close;
      if (focusId) { const f = m.body.querySelector('#' + focusId); if (f) f.focus(); }
    };
    draw();
  }

  /* ---------- 画面: 出題 ---------- */
  function fmtIv(date, now) {
    const m = Math.max(0, Math.round((date - now) / 60000));
    if (m < 60) return m + '分後'; const h = Math.round(m / 60); if (h < 24) return h + '時間後';
    const d = Math.round(h / 24); if (d < 31) return d + '日後'; const mo = Math.round(d / 30.4); return mo < 12 ? mo + 'か月後' : (Math.round(d / 36.5) / 10) + '年後';
  }
  function qHead(se) {
    return '<header class="qhead"><button class="btn btn-quiet" id="quit">終了</button><span class="cnt">' + (se.pos + 1) + (se.unlimited ? '問目' : ' / ' + se.queue.length) + '</span></header>' +
      (se.unlimited ? '' : '<div class="track" role="progressbar" aria-label="進み具合" aria-valuemin="0" aria-valuemax="' + se.queue.length + '" aria-valuenow="' + se.pos + '"><i style="width:' + (se.pos / se.queue.length * 100) + '%"></i></div>');
  }
  function showQuestion() {
    const se = S.session; const cur = se.queue[se.pos];
    if (isCloze(cur.id)) { showCloze(se, cur); return; }
    se.q = makeQuestion(cur.id); se.answered = false; se.t0 = Date.now();
    const q = se.q, parts = q.stem.split('\n'), lead = parts.shift();
    view(qHead(se) + '<section class="stack" style="gap:var(--s5)"><div><div class="q-meta"><span>' + esc(q.field) + '</span><span>' + (q.flash ? '単語帳' : '4択') + '</span><span>' + (q.d === 'd' ? '定義から概念' : '概念から定義') + '</span>' + (cur.redo ? '<span>もう一度(記録なし)</span>' : '') + '</div>' +
      '<p class="q-stem">' + esc(lead) + '</p>' + (parts.length ? '<p class="q-ask">' + esc(parts.join(' ')) + '</p>' : '') + '</div>' +
      (q.flash ? '<button class="btn btn-primary btn-block" id="show">答えを見る</button>' : '') +
      (q.opts.length ? '<div class="opts">' + q.opts.map((o, k) => '<button class="opt" data-k="' + k + '"><span class="k" aria-hidden="true">' + (k + 1) + '</span><span class="t">' + esc(q.d === 'd' ? o.n : o.d) + '<small hidden></small></span><span class="mark" aria-hidden="true"></span></button>').join('') + '</div>' : '') +
      '<div id="fb" role="status"></div></section>');
    $app.querySelectorAll('.opt').forEach(b => b.onclick = () => answer(+b.dataset.k));
    if (q.flash) { const sb = document.getElementById('show'); sb.onclick = reveal; sb.focus(); }
    document.getElementById('quit').onclick = () => { se.correct + se.wrong > 0 ? finish() : home(); };
    window.scrollTo(0, 0);
  }

  function answer(k) {
    const se = S.session; if (se.answered) return; se.answered = true;
    const q = se.q, cur = se.queue[se.pos], ok = k === q.answer;
    $app.querySelectorAll('.opt').forEach((b, j) => {
      b.disabled = true;
      if (j === q.answer) { b.classList.add('ok'); b.querySelector('.mark').textContent = '✓'; b.querySelector('.t').insertAdjacentHTML('beforeend', '<span class="sr">(正解)</span>'); }
      else if (j === k) { b.classList.add('ng'); b.querySelector('.mark').textContent = '×'; b.querySelector('.t').insertAdjacentHTML('beforeend', '<span class="sr">(あなたの回答・不正解)</span>'); }
      if (q.d === 'n') { const s = b.querySelector('small'); s.hidden = false; s.textContent = '→ ' + q.opts[j].n; }
    });
    const fb = document.getElementById('fb'); fb.className = 'fb';
    const label = '<p class="v ' + (ok ? 'ok' : 'ng') + '">' + (ok ? '正解' : '不正解') + '</p>';
    const ans = q.d === 'd' ? '<p class="ans">答え: <b>' + esc(q.it.n) + '</b>' + (q.it.a && q.it.a.length ? '<span class="muted small">　別名: ' + esc(q.it.a.slice(0, 4).join('、')) + '</span>' : '') + '</p>' : '';
    fb.innerHTML = '<hr class="rule">' + label + ans + '<button class="btn btn-primary btn-block" id="nx">次へ</button>';
    bindNext(); noteLink(q.it.n);
    if (cur.redo) return;
    if (!ok) { record(cur.id, Rating.Again, false); requeue(cur); } else record(cur.id, Rating.Good, true);
  }
  function reveal() {
    const se = S.session; if (se.answered) return; se.answered = true;
    const q = se.q, cur = se.queue[se.pos], it = q.it;
    document.getElementById('show').hidden = true;
    const al = it.a && it.a.length ? '<span class="muted small">　別名: ' + esc(it.a.slice(0, 4).join('、')) + '</span>' : '';
    const ans = q.d === 'd' ? '<p class="big">' + esc(it.n) + al + '</p>' : '<p class="big">' + esc(it.d) + '</p>';
    const fb = document.getElementById('fb'); fb.className = 'fb';
    if (cur.redo) { fb.innerHTML = '<hr class="rule">' + ans + '<button class="btn btn-primary btn-block" id="nx">次へ</button>'; bindNext(); noteLink(it.n); return; }
    const card = S.cards.get(cur.id) || createEmptyCard(new Date()); const now = new Date(); const pre = sched.repeat(card, now);
    const rb = [[Rating.Again, 'もう一度'], [Rating.Hard, '難しい'], [Rating.Good, '普通'], [Rating.Easy, '簡単']];
    fb.innerHTML = '<hr class="rule">' + ans + '<p class="muted small">思い出せましたか</p><div class="rate" role="group" aria-label="自己評価">' + rb.map(r => '<button data-r="' + r[0] + '">' + r[1] + '<small>' + fmtIv(pre[r[0]].card.due, now) + '</small></button>').join('') + '</div>';
    noteLink(it.n);
    fb.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { const r = +b.dataset.r; record(cur.id, r, r >= Rating.Hard); if (r === Rating.Again) requeue(cur); next(); });
  }
  function noteLink(name) {
    const fb = document.getElementById('fb'); if (!fb || !window.Notes) return;
    fb.insertAdjacentHTML('beforeend', '<button class="btn btn-block" id="nl">この概念のノートを見る</button>');
    document.getElementById('nl').onclick = () => window.Notes.openSheet(name);
  }
  function bindNext() { document.getElementById('nx').onclick = next; document.getElementById('nx').focus(); }
  function requeue(cur) { const se = S.session; if (cur.redo) return; const at = Math.min(se.queue.length, se.pos + 5); se.queue.splice(at, 0, {id: cur.id, redo: true}); }

  async function record(id, rating, ok) {
    const se = S.session, now = new Date(); const card = S.cards.get(id) || createEmptyCard(now);
    const wasNew = card.state === State.New;
    const next = sched.next(card, now, rating).card; next.id = id;
    S.cards.set(id, next); ok ? se.correct++ : se.wrong++;
    if (wasNew) { se.newDone++; const m = S.meta.newCount; const n = (m && m.date === today() ? m.n : 0) + 1; S.meta.newCount = {date: today(), n}; saveMeta('newCount', S.meta.newCount); }
    try { await saveCard(next); await addLog({id, r: rating, t: +now}); } catch (e) { S.dbOk = false; }
  }
  async function next() {
    const se = S.session; se.pos++; refill();
    if (se.pos >= se.queue.length && se.pending) { view('<p class="para">次の問題を用意しています…</p>'); await se.pending; if (S.session !== se) return; }
    se.pos < se.queue.length ? showQuestion() : finish();
  }

  /* ---------- 穴埋め ---------- */
  async function showCloze(se, cur) {
    const quit = () => { se.correct + se.wrong > 0 ? finish() : home(); };
    view('<header class="qhead"><button class="btn btn-quiet" id="quit">終了</button><span class="cnt">読み込んでいます…</span></header>');
    document.getElementById('quit').onclick = quit;
    let q = null; try { q = await window.Cloze.make(cur.id); } catch (e) { q = null; }
    if (S.session !== se || se.queue[se.pos] !== cur) return;
    if (!q) { next(); return; } // ノートが書き換わって段落が無くなった
    se.q = q; se.answered = false; se.t0 = Date.now();
    const nb = q.answers.length, slots = new Array(nb).fill(-1); let sel = -1, checked = false;
    const blk = g => g.map(x => x.b === undefined ? esc(x.v).replace(/\n/g, '<br>') : '<button class="blank" data-b="' + x.b + '" data-n="' + (x.b + 1) + '" aria-label="空欄' + (x.b + 1) + '"></button>').join('');
    view(qHead(se) + '<section class="stack" style="gap:var(--s5)"><div><div class="q-meta"><span>' + esc(q.field) + '</span><span>穴埋め</span><span>空欄' + nb + '個</span>' + (cur.redo ? '<span>もう一度(記録なし)</span>' : '') + '</div>' +
      '<h2 class="cz-title">' + esc(q.note) + '</h2></div>' +
      '<div class="cz-body">' + q.blocks.map(b => b.head ? '<h3 class="czh">' + blk(b.segs) + '</h3>' : '<p class="cz">' + blk(b.segs) + '</p>').join('') + '</div>' +
      '<div id="fb" class="fb" role="status" hidden></div></section>' +
      '<div class="czp" id="panel"><div class="bank">' + q.bank.map((w, k) => '<button class="word" data-w="' + k + '">' + esc(w.w) + '</button>').join('') + '</div>' +
      '<button class="btn btn-primary btn-block" id="chk" disabled>答え合わせ</button></div>');
    document.getElementById('quit').onclick = quit;
    const blanks = [...$app.querySelectorAll('.blank')], words = [...$app.querySelectorAll('.word')], chk = document.getElementById('chk');
    const paint = () => {
      blanks.forEach(b => { const i = +b.dataset.b, w = slots[i]; b.textContent = checked ? q.answers[i] : (w >= 0 ? q.bank[w].w : ''); b.classList.toggle('sel', !checked && sel === i); });
      words.forEach((b, k) => { b.classList.toggle('used', slots.includes(k)); b.disabled = checked || slots.includes(k); });
      chk.disabled = slots.includes(-1);
    };
    blanks.forEach(b => b.onclick = () => { if (checked) return; const i = +b.dataset.b; if (slots[i] >= 0) { slots[i] = -1; sel = i; } else sel = i; paint(); });
    words.forEach((b, k) => b.onclick = () => {
      if (checked || slots.includes(k)) return;
      let t = sel >= 0 && slots[sel] < 0 ? sel : slots.indexOf(-1); if (t < 0) return;
      slots[t] = k; sel = -1; paint();
      const nx = slots.indexOf(-1); const nb2 = nx >= 0 ? blanks.find(x => +x.dataset.b === nx) : null; if (nb2 && nb2.getBoundingClientRect().top > window.innerHeight * .55) nb2.scrollIntoView({block: 'center', behavior: 'smooth'});
    });
    chk.onclick = () => {
      if (checked || chk.disabled) return; checked = true; se.answered = true; sel = -1;
      const res = slots.map((w, i) => q.bank[w].w === q.answers[i]), bad = res.filter(r => !r).length;
      const rating = bad === 0 ? Rating.Good : bad <= Math.floor(nb / 4) ? Rating.Hard : Rating.Again, ok = rating >= Rating.Hard;
      paint();
      blanks.forEach(b => { const good = res[+b.dataset.b]; b.classList.add(good ? 'ok' : 'ng'); b.insertAdjacentHTML('beforeend', '<span class="sr">' + (good ? '(正解)' : '(不正解)') + '</span>'); });
      document.getElementById('panel').hidden = true;
      const wrong = res.map((r, i) => r ? '' : '<li>(' + (i + 1) + ') 「' + esc(q.bank[slots[i]].w) + '」→ 正しくは「<b>' + esc(q.answers[i]) + '</b>」</li>').join('');
      const fb = document.getElementById('fb'); fb.hidden = false;
      fb.innerHTML = '<hr class="rule"><p class="v ' + (ok ? 'ok' : 'ng') + '">' + (bad === 0 ? '全問正解' : (nb - bad) + ' / ' + nb + ' 正解' + (ok ? '(おしい)' : '')) + '</p>' + (wrong ? '<ul class="wr">' + wrong + '</ul>' : '') + '<button class="btn btn-primary btn-block" id="nx">次へ</button>';
      bindNext(); noteLink(q.note); fb.scrollIntoView({block: 'nearest', behavior: 'smooth'});
      if (cur.redo) return;
      record(cur.id, rating, ok); if (rating === Rating.Again) requeue(cur);
    };
    paint(); window.scrollTo(0, 0);
  }

  function finish() {
    const se = S.session; const n = se.correct + se.wrong;
    view('<section class="well hero done" aria-label="結果"><p class="cap">おつかれさまでした</p><p class="num">' + se.correct + '<small>/ ' + n + '</small></p><p class="sub"><span>新しく覚え始めた概念<b>' + se.newDone + '件</b></span></p></section>' +
      '<div class="stack"><button class="btn btn-primary btn-block" id="more">続ける</button><button class="btn btn-block" id="hm">今日に戻る</button></div>', 'today');
    document.getElementById('hm').onclick = home;
    document.getElementById('more').onclick = () => { const u = se.unlimited; S.session = null; startSession({unl: u}); if (!S.session) home(); };
  }

  /* ---------- 画面: 記録 ---------- */
  function logPage() {
    S.session = null;
    const s = stats(), st0 = new Date(); st0.setHours(0, 0, 0, 0); const t0 = +st0 - 13 * DAY;
    const days = new Array(14).fill(0); S.log.forEach(e => { const k = Math.floor((e.t - t0) / DAY); if (k >= 0 && k < 14) days[k]++; });
    const max = Math.max(1, ...days), total = days.reduce((a, b) => a + b, 0);
    const first = new Date(t0).toLocaleDateString('ja-JP', {month: 'numeric', day: 'numeric'});
    view('<header class="head"><h1 class="title">記録</h1></header>' +
      '<section class="figs"><div class="fig"><b>' + s.learned.toLocaleString() + '</b><span>学習済み</span></div><div class="fig"><b>' + s.recent.toLocaleString() + '</b><span>7日間の回答</span></div><div class="fig"><b>' + (s.rate === null ? '–' : s.rate + '<small style="font-size:var(--t-md)">%</small>') + '</b><span>7日間の正答率</span></div></section>' +
      '<section><h2 class="sec-h">直近14日の回答数</h2><div class="days" role="img" aria-label="直近14日の回答数。合計' + total + '問、最も多い日は' + (total ? max : 0) + '問">' + days.map(n => '<i class="' + (n ? '' : 'z') + '" style="height:' + (n ? Math.max(8, n / max * 100) : 0) + '%"></i>').join('') + '</div><div class="days-x" aria-hidden="true"><span>' + esc(first) + '</span><span>今日</span></div></section>' +
      '<section class="stack"><h2 class="sec-h" style="margin:0">データ</h2><p class="para">学習記録はこの端末の中だけに保存されます。端末を変えるときは、書き出して、新しい端末で取り込んでください。</p>' +
      '<div class="row"><button class="btn" id="exp">書き出し</button><button class="btn" id="imp">取り込み</button><input type="file" id="file" accept="application/json" hidden></div><p class="para" id="msg" role="status"></p></section>' +
      '<p class="para">収録 ' + S.data.items.length.toLocaleString() + ' 概念</p>', 'log');
    document.getElementById('exp').onclick = exportData;
    document.getElementById('imp').onclick = () => document.getElementById('file').click();
    document.getElementById('file').onchange = importData;
  }

  /* ---------- 書き出し・取り込み ---------- */
  function exportData() {
    const payload = {app: 'concept-quiz', version: 1, exported: new Date().toISOString(), cards: [...S.cards.values()].map(ser), log: S.log, meta: {settings: S.settings, newCount: S.meta.newCount || null}};
    const blob = new Blob([JSON.stringify(payload)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'concept-quiz-' + today() + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    msg('書き出しました(' + payload.cards.length + '件)。');
  }
  async function importData(ev) {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const p = JSON.parse(await f.text()); if (p.app !== 'concept-quiz') throw new Error('形式が違います');
      let added = 0, upd = 0;
      for (const o of p.cards) {
        const mine = S.cards.get(o.id), c = de(o);
        const t = x => x && x.last_review ? +x.last_review : 0;
        if (!mine) { S.cards.set(o.id, c); await saveCard(c); added++; } else if (t(c) > t(mine)) { S.cards.set(o.id, c); await saveCard(c); upd++; }
      }
      const have = new Set(S.log.map(e => e.id + '@' + e.t));
      for (const e of p.log || []) if (!have.has(e.id + '@' + e.t)) await addLog(e);
      logPage(); msg('取り込みました(追加' + added + '件、更新' + upd + '件)。');
    } catch (e) { msg('取り込めませんでした: ' + e.message); }
    ev.target.value = '';
  }
  function msg(t) { const m = document.getElementById('msg'); if (m) m.textContent = t; }

  /* ---------- キー操作 ---------- */
  document.addEventListener('keydown', e => {
    const se = S.session; if (!se || !se.q || e.metaKey || e.ctrlKey || document.querySelector('.sheet')) return;
    if (se.q.cloze && !se.answered) { if (e.key === 'Enter') { const c = document.getElementById('chk'); if (c && !c.disabled) { e.preventDefault(); c.click(); } } return; }
    if (!se.answered && se.q.flash && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); reveal(); return; }
    if (!se.answered && /^[1-4]$/.test(e.key) && se.q.opts[+e.key - 1]) { answer(+e.key - 1); return; }
    if (se.answered) {
      const rb = document.querySelectorAll('[data-r]');
      if (rb.length && /^[1-4]$/.test(e.key) && rb[+e.key - 1]) { rb[+e.key - 1].click(); return; }
      const nx = document.getElementById('nx'); if (nx && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); nx.click(); }
    }
  });

  /* ---------- 下のタブと画面の切り替え ---------- */
  document.getElementById('tabbar').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    const to = {today: '', find: '#/notes', log: '#/log'}[b.dataset.tab];
    if (to === '' && !location.hash.startsWith('#/')) { home(); return; }
    if (location.hash === to) route(); else location.hash = to;
  });
  function route() {
    const h = location.hash;
    if (h === '#/log') logPage();
    else if (h.startsWith('#/')) window.Notes.route(h);
    else home();
  }
  window.Q = {S, $app, esc, shuffle, home, loadAux, saveMeta, view, setTab, modal};
  window.addEventListener('hashchange', route);

  /* ---------- 起動 ---------- */
  load().then(route).catch(e => { view('<div class="notice" role="alert"><b>読み込めませんでした。</b>' + esc(e.message) + '</div>'); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
