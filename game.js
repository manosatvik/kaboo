'use strict';
// Kaboo game rules. Pure state + rules; the server owns the state and sends
// each player a redacted view, so hidden cards never leave the server.
const crypto = require('crypto');

const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const EFF = {
  own: 'look at one of their cards',
  opp: "look at an opponent's card",
  jack: 'blind swap',
  queen: 'swap and look',
  king: 'look at two, maybe swap',
};

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function mkDeck(jokers) {
  const d = [];
  for (const s of 'SHDC') for (const r of 'A23456789TJQK') d.push(r + s);
  if (jokers) d.push('X1', 'X2');
  return shuffle(d);
}
function val(c) {
  const r = c[0];
  if (r === 'X') return 0;
  if (r === 'A') return 1;
  if (r === 'T' || r === 'J' || r === 'Q') return 10;
  if (r === 'K') return c[1] === 'H' || c[1] === 'D' ? -1 : 10;
  return +r;
}
function lbl(c) { return c[0] === 'X' ? 'Joker' : (c[0] === 'T' ? '10' : c[0]) + SUIT[c[1]]; }
function effKind(c) {
  const r = c[0];
  if (r === '7' || r === '8') return 'own';
  if (r === '9' || r === 'T') return 'opp';
  if (r === 'J') return 'jack';
  if (r === 'Q') return 'queen';
  if (r === 'K') return 'king';
  return null;
}
function handScore(cs, pairs) {
  cs = cs.filter(Boolean);
  let t = cs.reduce((s, c) => s + val(c), 0);
  if (pairs) {
    const g = {};
    for (const c of cs) { if (c === 'KH' || c === 'KD') continue; g[c[0]] = (g[c[0]] || 0) + 1; }
    for (const r of Object.keys(g)) { const n = g[r] - (g[r] % 2); if (n) t -= n * val(r + 'S'); }
  }
  return t;
}
function slotName(i) { return ['top-left', 'top-right', 'bottom-left', 'bottom-right'][i] || 'extra card ' + (i - 3); }
function clean(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿]/g, '').trim().slice(0, 14);
}

class Game {
  constructor(hostId) {
    this.host = hostId;
    this.ph = 'lobby';             // lobby | peek | play | end
    this.op = { jk: false, pr: false, mem: false };
    this.kn = {};                  // memory aid: player id -> { "p:i": card } for cards that player has legitimately seen
    this.pl = [];                  // {id, nm, c:[card|null], s:score, r:ready, pk:peeked}
    this.dk = []; this.dp = [];
    this.tn = 0; this.st = '';     // turn index, step: start|drawn|eff|look|king
    this.dr = null; this.df = '';  // drawn card, from 'd'eck or 'p'ile
    this.ef = null; this.rv = null; this.kb = null; this.sg = null;
    this.hl = []; this.lg = []; this.rd = 0; this.fs = 0; this.res = null;
  }

  idx(id) { return this.pl.findIndex(p => p.id === id); }
  nm(i) { return this.pl[i] ? this.pl[i].nm : '?'; }
  log(m) { this.lg.push(m); if (this.lg.length > 8) this.lg.shift(); }
  where(s) { return this.nm(s[0]) + "'s " + slotName(s[1]); }
  okSlot(s) {
    return Array.isArray(s) && this.pl[s[0]] && s[1] >= 0 && s[1] < this.pl[s[0]].c.length && !!this.pl[s[0]].c[s[1]];
  }
  swapSlots(a, b) {
    const A = this.pl[a[0]].c, B = this.pl[b[0]].c;
    [A[a[1]], B[b[1]]] = [B[b[1]], A[a[1]]];
    // Every swap is announced, so whoever knew a card can follow it to its new spot.
    const ka = a[0] + ':' + a[1], kb = b[0] + ':' + b[1];
    for (const m of Object.values(this.kn)) {
      const x = m[ka], y = m[kb];
      delete m[ka]; delete m[kb];
      if (x) m[kb] = x;
      if (y) m[ka] = y;
    }
  }
  // Memory-aid bookkeeping
  know(id, s) {
    const c = this.pl[s[0]] && this.pl[s[0]].c[s[1]];
    if (!c) return;
    (this.kn[id] || (this.kn[id] = {}))[s[0] + ':' + s[1]] = c;
  }
  knowAll(s) { for (const p of this.pl) this.know(p.id, s); }
  forget(s) { const k = s[0] + ':' + s[1]; for (const m of Object.values(this.kn)) delete m[k]; }
  moveKnown(from, to) {
    const kf = from[0] + ':' + from[1], kt = to[0] + ':' + to[1];
    for (const m of Object.values(this.kn)) { const x = m[kf]; delete m[kf]; delete m[kt]; if (x) m[kt] = x; }
  }
  drawFromDeck() {
    if (!this.dk.length && this.dp.length > 1) {
      const top = this.dp.pop();
      this.dk = shuffle(this.dp); this.dp = [top];
      this.log('The discard pile was reshuffled into the deck.');
    }
    return this.dk.pop() || null;
  }
  deal() {
    this.dk = mkDeck(this.op.jk); this.dp = []; this.kn = {};
    for (const p of this.pl) { p.c = [this.dk.pop(), this.dk.pop(), this.dk.pop(), this.dk.pop()]; p.r = 0; p.pk = 0; }
    this.rd++; this.ph = 'peek'; this.st = '';
    this.dr = null; this.df = ''; this.ef = null; this.rv = null; this.kb = null; this.sg = null; this.hl = []; this.res = null;
    this.fs = (this.rd - 1) % this.pl.length;
    this.log('Round ' + this.rd + ' is dealt. Look at your bottom two cards.');
  }
  endTurn() {
    this.dr = null; this.df = ''; this.ef = null; this.rv = null; this.st = 'start';
    const n = this.pl.length, cur = this.tn;
    if (this.kb) {
      if (cur !== this.kb.by) this.kb.left--;
      if (this.kb.left <= 0) { this.endRound(); return; }
    }
    let nx = (cur + 1) % n;
    if (this.kb && nx === this.kb.by) nx = (nx + 1) % n;
    this.tn = nx;
  }
  endRound() {
    this.ph = 'end'; this.st = ''; this.rv = null; this.sg = null; this.dr = null; this.ef = null;
    const tots = this.pl.map(p => handScore(p.c, this.op.pr));
    const min = Math.min(...tots);
    let win = tots.map((t, i) => (t === min ? i : -1)).filter(i => i >= 0);
    const kb = this.kb, callers = kb ? [kb.by, ...kb.ctr] : [];
    if (kb) {
      const ct = tots[kb.by];
      // A caller who only ties does not win; a counter-caller must beat the caller.
      if (win.length > 1 && win.includes(kb.by)) win = win.filter(i => i !== kb.by);
      win = win.filter(i => !kb.ctr.includes(i) || tots[i] < ct);
    }
    this.res = this.pl.map((p, i) => {
      const w = win.includes(i);
      const add = w ? 0 : tots[i] + (callers.includes(i) ? 20 : 0);
      p.s += add;
      return { t: tots[i], a: add, w: w ? 1 : 0, k: callers.includes(i) ? 1 : 0 };
    });
    this.log('Round ' + this.rd + ' is over. ' + (win.length ? win.map(i => this.nm(i)).join(' & ') + ' won.' : 'Nobody won.'));
  }
  checkEmpty() {
    if (this.kb) return;
    const e = this.pl.findIndex(p => p.c.length && !p.c.some(Boolean));
    if (e >= 0) {
      this.kb = { by: e, ctr: [], left: this.pl.length - 1, auto: 1 };
      this.log(this.nm(e) + ' has no cards left. Automatic KABOO!');
    }
  }

  // Apply one player action. isHost: whether this player may use host controls.
  apply(id, a, isHost) {
    if (!a || typeof a.t !== 'string') return;
    const me = this.idx(id), t = a.t;
    if (t === 'join') {
      const n = clean(a.nm) || 'Player';
      if (me >= 0) { this.pl[me].nm = n; return; }
      if ((this.ph !== 'lobby' && this.ph !== 'end') || this.pl.length >= 8) return;
      this.pl.push({ id, nm: n, c: [], s: 0, r: 0, pk: 0 });
      this.log(n + ' sat down.');
      return;
    }
    if (t === 'leave') {
      if ((this.ph === 'lobby' || this.ph === 'end') && me >= 0) {
        this.log(this.nm(me) + ' left the table.');
        this.pl.splice(me, 1);
        if (this.res) this.res.splice(me, 1);
        if (this.host === id && this.pl.length) this.host = this.pl[0].id;
      }
      return;
    }
    if (t === 'opts' && isHost && this.ph === 'lobby') { this.op = { jk: !!a.jk, pr: !!a.pr, mem: !!a.mem }; return; }
    if (t === 'start' && isHost && this.ph === 'lobby' && this.pl.length >= 2) { this.deal(); return; }
    if (t === 'next' && isHost && this.ph === 'end' && this.pl.length >= 2) { this.deal(); return; }
    if (t === 'reset' && isHost && this.ph === 'end') {
      this.ph = 'lobby';
      for (const p of this.pl) { p.s = 0; p.c = []; p.r = 0; p.pk = 0; }
      this.rd = 0; this.res = null; this.kb = null; this.hl = []; this.dk = []; this.dp = [];
      this.log('New game. Scores are back to 0.');
      return;
    }
    if (me < 0) return;
    if (this.ph === 'peek') {
      if (t === 'peek') { this.pl[me].pk = 1; this.know(id, [me, 2]); this.know(id, [me, 3]); return; }
      if (t === 'ready') {
        this.pl[me].r = 1;
        if (this.pl.every(p => p.r)) {
          this.ph = 'play'; this.tn = this.fs; this.st = 'start';
          this.log('Everyone has looked. ' + this.nm(this.tn) + ' goes first.');
        }
      }
      return;
    }
    if (this.ph !== 'play') return;
    if (t === 'snap') return this.snap(me, a);
    if (t === 'give') return this.give(me, a);
    if (t === 'nogive') { if (this.sg && this.sg.by === me) { this.sg = null; this.log(this.nm(me) + ' kept their cards.'); } return; }
    if (t === 'skipturn' && isHost && a.tn === this.tn) {
      if (this.dr) this.dp.push(this.dr);
      this.log(this.nm(this.tn) + "'s turn was skipped.");
      this.endTurn();
      return;
    }
    if (me !== this.tn) return;
    const P = this.pl[me];
    switch (t) {
      case 'draw': {
        if (this.st !== 'start') return;
        const c = this.drawFromDeck();
        if (!c) { this.log('The deck is empty.'); return; }
        this.dr = c; this.df = 'd'; this.st = 'drawn';
        this.log(P.nm + ' drew from the deck.');
        return;
      }
      case 'take':
        if (this.st !== 'start' || !this.dp.length) return;
        this.dr = this.dp.pop(); this.df = 'p'; this.st = 'drawn';
        this.log(P.nm + ' took ' + lbl(this.dr) + ' from the discard pile.');
        return;
      case 'swap': {
        if (this.st !== 'drawn') return;
        const i = a.i | 0;
        if (i < 0 || i >= P.c.length) return;
        const old = P.c[i];
        P.c[i] = this.dr; this.dr = null; this.hl = [[me, i]];
        this.forget([me, i]);
        if (this.df === 'p') this.knowAll([me, i]); else this.know(P.id, [me, i]);
        if (old) { this.dp.push(old); this.log(P.nm + ' swapped their ' + slotName(i) + ' card and discarded ' + lbl(old) + '.'); }
        else this.log(P.nm + ' filled their empty ' + slotName(i) + ' spot.');
        this.endTurn();
        return;
      }
      case 'disc': {
        if (this.st !== 'drawn' || this.df !== 'd') return;
        const c = this.dr; this.dr = null; this.dp.push(c);
        const k = effKind(c); this.hl = [];
        this.log(P.nm + ' discarded ' + lbl(c) + (k ? ' to ' + EFF[k] + '.' : '.'));
        if (k) { this.st = 'eff'; this.ef = { k }; } else this.endTurn();
        return;
      }
      case 'eff': return this.doEff(me, a);
      case 'skip': if (this.st === 'eff') { this.log(P.nm + ' skipped the power.'); this.endTurn(); } return;
      case 'done': if (this.st === 'look') this.endTurn(); return;
      case 'kswap': {
        if (this.st !== 'king') return;
        const s = this.ef.s;
        if (a.yes) { this.swapSlots(s[0], s[1]); this.log(P.nm + ' swapped ' + this.where(s[0]) + ' and ' + this.where(s[1]) + '.'); }
        else this.log(P.nm + ' looked and did not swap.');
        this.hl = s; this.endTurn();
        return;
      }
      case 'kaboo':
        if (this.st !== 'start' || this.kb) return;
        this.kb = { by: me, ctr: [], left: this.pl.length - 1 }; this.hl = [];
        this.log(P.nm + ' called KABOO! Everyone else gets one last turn.');
        this.endTurn();
        return;
      case 'counter':
        if (this.st !== 'start' || !this.kb || this.kb.by === me || this.kb.ctr.includes(me)) return;
        this.kb.ctr.push(me);
        this.log(P.nm + ' called Counter-KABOO!');
        this.endTurn();
        return;
    }
  }
  doEff(me, a) {
    if (this.st !== 'eff') return;
    const k = this.ef.k, P = this.pl[me];
    const sel = (Array.isArray(a.sel) ? a.sel : []).slice(0, 2).map(s => [s[0] | 0, s[1] | 0]);
    if (k === 'own' || k === 'opp') {
      const s = sel[0];
      if (!this.okSlot(s)) return;
      if (k === 'own' && s[0] !== me) return;
      if (k === 'opp' && s[0] === me) return;
      this.rv = { to: P.id, s: [s] }; this.hl = [s]; this.st = 'look'; this.know(P.id, s);
      this.log(P.nm + ' looked at ' + this.where(s) + '.');
      return;
    }
    if (sel.length !== 2 || !this.okSlot(sel[0]) || !this.okSlot(sel[1]) || (sel[0][0] === sel[1][0] && sel[0][1] === sel[1][1])) return;
    if (k === 'jack') {
      const w0 = this.where(sel[0]), w1 = this.where(sel[1]);
      this.swapSlots(sel[0], sel[1]); this.hl = sel;
      this.log(P.nm + ' blind-swapped ' + w0 + ' and ' + w1 + '.');
      this.endTurn();
      return;
    }
    if (k === 'queen') {
      const own = sel.find(s => s[0] === me), oth = sel.find(s => s[0] !== me);
      if (!own || !oth) return;
      const wo = this.where(own), wt = this.where(oth);
      this.swapSlots(own, oth);
      this.rv = { to: P.id, s: [own] }; this.hl = sel; this.st = 'look'; this.know(P.id, own);
      this.log(P.nm + ' swapped ' + wo + ' with ' + wt + '.');
      return;
    }
    if (k === 'king') {
      this.ef.s = sel; this.rv = { to: P.id, s: sel }; this.hl = sel; this.st = 'king';
      this.know(P.id, sel[0]); this.know(P.id, sel[1]);
      this.log(P.nm + ' is looking at ' + this.where(sel[0]) + ' and ' + this.where(sel[1]) + '.');
    }
  }
  snap(me, a) {
    if (this.sg || !this.dp.length) return;
    const s = [a.p | 0, a.i | 0];
    if (!this.okSlot(s)) return;
    const top = this.dp[this.dp.length - 1], c = this.pl[s[0]].c[s[1]], P = this.pl[me];
    if (c[0] === top[0]) {
      this.pl[s[0]].c[s[1]] = null; this.dp.push(c); this.hl = [s]; this.forget(s);
      this.log(P.nm + ' snapped ' + lbl(c) + (s[0] === me ? ' from their own cards.' : ' from ' + this.nm(s[0]) + '.'));
      if (s[0] !== me && P.c.some(Boolean)) this.sg = { by: me, p: s[0], i: s[1] };
      this.checkEmpty();
    } else {
      const pen = this.drawFromDeck(); this.hl = [s];
      this.knowAll(s); // the wrong card was shown to everyone before going back
      this.log(P.nm + ' tried to snap ' + lbl(c) + ' but it does not match.' + (pen ? ' Penalty card.' : ''));
      if (pen) { P.c.push(pen); this.hl.push([me, P.c.length - 1]); this.forget([me, P.c.length - 1]); }
    }
  }
  give(me, a) {
    const g = this.sg;
    if (!g || g.by !== me) return;
    const P = this.pl[me], i = a.i | 0;
    if (!P.c[i]) return;
    const T = this.pl[g.p];
    if (!T || T.c[g.i]) { this.sg = null; return; }
    T.c[g.i] = P.c[i]; P.c[i] = null; this.hl = [[me, i], [g.p, g.i]];
    this.moveKnown([me, i], [g.p, g.i]);
    this.log(P.nm + ' gave ' + T.nm + ' their ' + slotName(i) + ' card.');
    this.sg = null;
    this.checkEmpty();
  }

  // What one player is allowed to see. Hidden cards become 'B' (a card back).
  view(id, online, hostId) {
    const me = this.idx(id);
    const inRv = (p, i) => this.rv && this.rv.to === id && this.rv.s.some(s => s[0] === p && s[1] === i);
    const pl = this.pl.map((p, pi) => ({
      id: p.id === id ? id : 'p' + pi, me: p.id === id, nm: p.nm, s: p.s, r: p.r, on: online.has(p.id), host: p.id === hostId,
      c: p.c.map((c, i) => {
        if (!c) return null;
        if (this.ph === 'end') return c;
        if (inRv(pi, i)) return c;
        if (this.ph === 'peek' && pi === me && p.pk && !p.r && (i === 2 || i === 3)) return c;
        return 'B';
      }),
    }));
    let dr = null;
    if (this.dr) dr = this.df === 'p' || me === this.tn ? this.dr : 'B';
    return {
      ph: this.ph, op: this.op, pl, me, tn: this.tn, st: this.st, dr, df: this.df,
      ef: this.ef, kb: this.kb, sg: this.sg, hl: this.hl, lg: this.lg, rd: this.rd, res: this.res,
      top: this.dp.length ? this.dp[this.dp.length - 1] : null, dpn: this.dp.length, dkn: this.dk.length,
      pk: me >= 0 ? this.pl[me].pk : 0,
      mem: this.op.mem && this.ph === 'play' ? this.memoryOf(id) : [],
    };
  }
  // Cards this player has seen and could still be tracking, as [p, i, card].
  memoryOf(id) {
    const m = this.kn[id] || {}, out = [];
    for (const [k, c] of Object.entries(m)) {
      const [p, i] = k.split(':').map(Number);
      if (this.pl[p] && this.pl[p].c[i] === c) out.push([p, i, c]);
    }
    return out;
  }
}

module.exports = { Game, handScore, val, mkDeck };
