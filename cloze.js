'use strict';
/* 穴埋め問題: ノート本文の段落のうち、概念へのリンクを2つ以上含むものを出題する */
(function () {
  const Q = window.Q, S = Q.S, NEW = window.FSRS.State.New;
  const A = () => window.Notes.api;
  const LINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
  const cache = new Map(); let ready = false, poolAll = null;
  const shuf = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const isProse = b => !/^(#|[-*+]\s|>|\||```|\d+[.)]\s)/.test(b);
  const isKey = id => /\|w$/.test(id);
  async function ensure() { await A().ensure(); ready = true; }

  /* 本文 → ノート全体で1問。空欄にできる概念リンクが2つ以上あるノートだけが対象 */
  const MAXB = 8;
  function parse(i, body) {
    const N = A().N;
    const bl = body.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/).map(s => s.trim()).filter(Boolean);
    const blocks = [], occ = new Map(); let plain = '';
    bl.forEach(raw => {
      const head = /^#{1,6}\s/.test(raw), list = !head && /^([-*+]\s|\d+[.)]\s)/.test(raw);
      if (/^(>|\||```)/.test(raw)) return;
      const text = raw.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/([^\x00-\x7f]) (\[\[)/g, '$1$2').replace(/(\]\]) ([^\x00-\x7f])/g, '$1$2');
      const parts = []; let last = 0, m; LINK.lastIndex = 0;
      while ((m = LINK.exec(text))) {
        parts.push({t: text.slice(last, m.index)});
        const target = m[1].trim(), lab = m[2] !== undefined && m[2].trim() ? m[2].trim() : target;
        parts.push({lk: target, lab}); plain += text.slice(last, m.index) + lab; last = m.index + m[0].length;
        (occ.get(target) || occ.set(target, []).get(target)).push(lab);
      }
      parts.push({t: text.slice(last)}); plain += text.slice(last) + '\n';
      blocks.push({parts, head, list});
    });
    const cand = [];
    occ.forEach((labs, target) => {
      const j = A().resolve(target), lab = labs[0];
      if (j === undefined || j === i || N.list[j].t !== 'c' || labs.some(x => x !== lab) || lab.length < 2 || lab.length > 20) return;
      if (plain.split(lab).length - 1 !== labs.length) return; // 答えがリンク以外の場所にも書かれている
      cand.push(target);
    });
    return cand.length >= 2 ? {blocks, cand, plain, labelOf: new Map(cand.map(t => [t, occ.get(t)[0]]))} : null;
  }
  async function note(i) {
    if (!cache.has(i)) cache.set(i, parse(i, await A().bodyOf(i)));
    return cache.get(i);
  }

  /* 対象のノート(概念)。分野を絞っているときは、その分野の概念だけ */
  function pool(st) {
    const N = A().N;
    if (st.field >= 0) { const fi = N.fields.indexOf(S.data.fields[st.field]); return (N.members.get(fi) || []).filter(j => N.list[j].t === 'c'); }
    return poolAll || (poolAll = N.list.map((n, j) => j).filter(j => N.list[j].t === 'c'));
  }
  function dueKeys(st, now) {
    const N = A().N, fi = st.field >= 0 ? N.fields.indexOf(S.data.fields[st.field]) : -1, out = [];
    S.cards.forEach((c, id) => {
      if (!isKey(id) || c.state === NEW || c.due > now) return;
      const j = N.byName.get(id.slice(0, id.lastIndexOf('|'))); if (j === undefined) return;
      if (fi >= 0 && !(N.list[j].f || []).includes(fi)) return;
      out.push(c);
    });
    out.sort((a, b) => a.due - b.due); return out.map(c => c.id);
  }
  /* まだ出していない段落を、ランダムなノートからneed個集める(本文は必要な塊だけ取り寄せる) */
  async function newKeys(st, need, seen) {
    if (need <= 0) return [];
    await ensure(); const N = A().N, CH = N.CH, byChunk = new Map();
    pool(st).forEach(j => { const c = Math.floor(j / CH); (byChunk.get(c) || byChunk.set(c, []).get(c)).push(j); });
    const out = []; let used = 0;
    for (const c of shuf([...byChunk.keys()])) {
      await A().chunk(c); used++;
      for (const j of byChunk.get(c)) { const key = N.list[j].n + '|w'; if (!S.cards.has(key) && !seen.has(key) && await note(j)) out.push(key); }
      if (out.length >= need * 2 && used >= Math.min(3, byChunk.size)) break;
    }
    return shuf(out).slice(0, need);
  }

  function distract(i, p, answers, d) {
    const N = A().N, n = N.list[i]; let pl = [];
    (n.f || []).forEach(fi => (N.members.get(fi) || []).forEach(j => { if (j !== i && N.list[j].t === 'c') pl.push(j); }));
    pl = [...new Set(pl)];
    for (let t = 0; pl.length < 40 && t < 300; t++) { const j = Math.floor(Math.random() * N.list.length); if (j !== i && N.list[j].t === 'c') pl.push(j); }
    const avg = answers.reduce((a, w) => a + w.length, 0) / answers.length;
    const bad = w => answers.some(a => a === w || (a.length >= 2 && w.includes(a)) || (w.length >= 2 && a.includes(w)));
    const cand = pl.map(j => N.list[j]).filter(o => o.n.length >= 2 && o.n.length <= 20 && !p.plain.includes(o.n) && !bad(o.n) && !(o.a || []).some(a => answers.includes(a)))
      .map(o => [Math.abs(o.n.length - avg) + Math.random() * 6, o.n]).sort((x, y) => x[0] - y[0]);
    return shuf([...new Set(cand.slice(0, 16).map(x => x[1]))]).slice(0, d);
  }
  async function make(id) {
    await ensure(); const N = A().N, name = id.slice(0, id.lastIndexOf('|'));
    const i = N.byName.get(name); if (i === undefined) return null;
    const p = await note(i); if (!p) return null;
    const chosen = new Set(shuf(p.cand).slice(0, MAXB));
    // 空欄の番号は、本文に出てくる順
    const order = []; p.blocks.forEach(b => b.parts.forEach(pt => { if (pt.lk && chosen.has(pt.lk) && !order.includes(pt.lk)) order.push(pt.lk); }));
    const blocks = p.blocks.map(b => {
      const segs = []; const push = g => { const l = segs[segs.length - 1]; if (g.v !== undefined && l && l.v !== undefined) l.v += g.v; else segs.push(g); };
      b.parts.forEach(pt => { if (pt.t !== undefined) push({v: b.list ? pt.t : pt.t.replace(/\n/g, '')}); else push(chosen.has(pt.lk) ? {b: order.indexOf(pt.lk)} : {v: pt.lab}); });
      return {segs, head: b.head, list: b.list};
    });
    const answers = order.map(t => p.labelOf.get(t));
    const dis = distract(i, p, answers, Math.max(2, Math.min(4, Math.round(answers.length / 2))));
    const bank = shuf([...answers.map((w, b) => ({w, b})), ...dis.map(w => ({w, b: -1}))]);
    const n = N.list[i], fs = S.settings.field >= 0 ? N.fields.indexOf(S.data.fields[S.settings.field]) : -1;
    const fld = N.fields[(fs >= 0 && (n.f || []).includes(fs)) ? fs : (n.f || [])[0]] || '';
    return {id, cloze: true, opts: [], note: name, field: fld, blocks, answers, bank};
  }
  window.Cloze = {ensure, ready: () => ready, make, dueKeys, newKeys, poolSize: st => pool(st).length};
})();
