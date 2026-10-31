'use strict';
// Self-test: plays many random games against the rules engine, then a short
// game over real WebSockets. Run with: npm test
const assert = require('assert');
const { spawn } = require('child_process');
const { Game, handScore } = require('./game');

const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];

function countCards(g) {
  let n = g.dk.length + g.dp.length + (g.dr ? 1 : 0);
  for (const p of g.pl) n += p.c.filter(Boolean).length;
  return n;
}
function slots(g, filter) {
  const out = [];
  g.pl.forEach((p, pi) => p.c.forEach((c, i) => { if (c && (!filter || filter(pi, i))) out.push([pi, i]); }));
  return out;
}
function checkViews(g) {
  const on = new Set(g.pl.map(p => p.id));
  g.pl.forEach((p, me) => {
    const v = g.view(p.id, on, g.host);
    assert.strictEqual(v.me, me);
    v.pl.forEach((q, pi) => {
      if (pi !== me) assert.ok(!q.id.startsWith('tok'), 'another player token leaked');
      q.c.forEach((c, i) => {
        if (!c || c === 'B' || g.ph === 'end') return;
        const viaReveal = g.rv && g.rv.to === p.id && g.rv.s.some(s => s[0] === pi && s[1] === i);
        const viaPeek = g.ph === 'peek' && pi === me && (i === 2 || i === 3);
        assert.ok(viaReveal || viaPeek, 'card shown that should be hidden');
      });
    });
    if (g.dr && g.df === 'd' && g.tn !== me) assert.strictEqual(v.dr, 'B', 'drawn card leaked');
    // Memory aid: everything a player remembers must still be the card in that spot.
    for (const [k, c] of Object.entries(g.kn[p.id] || {})) {
      const [pi, i] = k.split(':').map(Number);
      assert.strictEqual(g.pl[pi].c[i], c, 'memory drifted from the real card at ' + k);
    }
    if (!g.op.mem || g.ph !== 'play') assert.strictEqual(v.mem.length, 0, 'memory sent while the aid is off');
    assert.ok(!('dk' in v), 'deck order leaked');
  });
}

function randomGame(players, rounds, opts) {
  const g = new Game('tok0');
  for (let i = 0; i < players; i++) g.apply('tok' + i, { t: 'join', nm: 'P' + i }, i === 0);
  g.apply('tok0', { t: 'opts', ...opts }, true);
  const total = 52 + (opts.jk ? 2 : 0);
  g.apply('tok0', { t: 'start' }, true);
  let steps = 0, finished = 0;
  while (finished < rounds) {
    assert.ok(++steps < 200000, 'game did not finish');
    if (g.ph === 'peek') {
      for (const p of g.pl) { g.apply(p.id, { t: 'peek' }); checkViews(g); g.apply(p.id, { t: 'ready' }); }
      assert.strictEqual(g.ph, 'play');
      continue;
    }
    if (g.ph === 'end') {
      finished++;
      const sum = g.res.reduce((s, r) => s + r.a, 0);
      assert.ok(Number.isFinite(sum));
      g.apply('tok0', { t: 'next' }, true);
      continue;
    }
    assert.strictEqual(countCards(g), total, 'cards were created or lost');
    checkViews(g);

    // Random interruptions: snaps and gives from any player.
    if (g.sg && Math.random() < 0.7) {
      const by = g.pl[g.sg.by];
      const own = slots(g, (pi) => pi === g.sg.by);
      if (own.length && Math.random() < 0.6) g.apply(by.id, { t: 'give', i: pick(own)[1] });
      else g.apply(by.id, { t: 'nogive' });
      continue;
    }
    if (Math.random() < 0.08 && g.dp.length) {
      const who = pick(g.pl), s = slots(g);
      if (s.length) { const t = pick(s); g.apply(who.id, { t: 'snap', p: t[0], i: t[1] }); continue; }
    }

    const P = g.pl[g.tn], me = g.tn;
    switch (g.st) {
      case 'start': {
        const r = Math.random();
        if (!g.kb && r < 0.04) g.apply(P.id, { t: 'kaboo' });
        else if (g.kb && r < 0.2) g.apply(P.id, { t: 'counter' });
        else if (r < 0.3 && g.dp.length) g.apply(P.id, { t: 'take' });
        else g.apply(P.id, { t: 'draw' });
        if (g.st === 'start' && g.tn === me && g.ph === 'play') g.apply('tok0', { t: 'skipturn', tn: g.tn }, true); // deck empty edge
        break;
      }
      case 'drawn':
        if (g.df === 'd' && Math.random() < 0.5) g.apply(P.id, { t: 'disc' });
        else g.apply(P.id, { t: 'swap', i: rnd(P.c.length) });
        break;
      case 'eff': {
        const k = g.ef.k;
        if (Math.random() < 0.1) { g.apply(P.id, { t: 'skip' }); break; }
        const mine = slots(g, pi => pi === me), others = slots(g, pi => pi !== me), all = slots(g);
        let sel = null;
        if (k === 'own' && mine.length) sel = [pick(mine)];
        else if (k === 'opp' && others.length) sel = [pick(others)];
        else if ((k === 'jack' || k === 'king') && all.length >= 2) { const a = pick(all); let b; do b = pick(all); while (b === a); sel = [a, b]; }
        else if (k === 'queen' && mine.length && others.length) sel = [pick(mine), pick(others)];
        if (sel) g.apply(P.id, { t: 'eff', sel }); else g.apply(P.id, { t: 'skip' });
        if (g.st === 'eff') g.apply(P.id, { t: 'skip' });
        break;
      }
      case 'look': checkViews(g); g.apply(P.id, { t: 'done' }); break;
      case 'king': checkViews(g); g.apply(P.id, { t: 'kswap', yes: Math.random() < 0.5 ? 1 : 0 }); break;
      default: throw new Error('unexpected step ' + g.st);
    }
  }
  return g;
}

// Scoring rules
assert.strictEqual(handScore(['KH', 'KD', 'AS', null], false), -1);
assert.strictEqual(handScore(['5S', '5H', 'KH', 'KD'], true), -2, 'pairs score 0 except red kings');
assert.strictEqual(handScore(['KS', 'KC', '2H'], true), 2);
assert.strictEqual(handScore(['X1', 'X2', '3C'], false), 3);

// Tie rule: caller who ties does not win.
{
  const g = new Game('a');
  g.apply('a', { t: 'join', nm: 'A' }, true); g.apply('b', { t: 'join', nm: 'B' });
  g.apply('a', { t: 'start' }, true);
  g.pl[0].c = ['AS', '2S', null, null]; g.pl[1].c = ['AH', '2H', null, null];
  g.kb = { by: 0, ctr: [], left: 0 }; g.endRound();
  assert.deepStrictEqual(g.res.map(r => r.w), [0, 1]);
  assert.strictEqual(g.pl[0].s, 23, 'tied caller scores cards + 20');
  assert.strictEqual(g.pl[1].s, 0);
}

let games = 0;
for (const n of [2, 3, 5, 8]) for (const jk of [false, true]) for (const pr of [false, true]) for (const mem of [false, true]) {
  for (let k = 0; k < 10; k++) { randomGame(n, 3, { jk, pr, mem }); games++; }
}
console.log('Rules engine: ' + games + ' random games, 3 rounds each, passed.');

// Real server over WebSockets
const WebSocket = require('ws');
const PORT = 3999;
const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'] });
function client(pid) {
  return new Promise(res => {
    const ws = new WebSocket('ws://localhost:' + PORT + '/ws');
    ws.last = null; ws.waiters = [];
    ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'state') { ws.last = m; ws.waiters.splice(0).forEach(f => f(m)); } });
    ws.next = () => new Promise(r => ws.waiters.push(r));
    ws.on('open', () => res(ws));
    ws.pid = pid;
  });
}
srv.stdout.once('data', async () => {
  try {
    const page = await fetch('http://localhost:' + PORT + '/t/ABCDE');
    assert.strictEqual(page.status, 200);
    const a = await client('aaaaaaaaaaaaaaaaaaaa'), b = await client('bbbbbbbbbbbbbbbbbbbb');
    a.send(JSON.stringify({ type: 'hello', pid: a.pid, create: true, nm: 'Asha' }));
    const s1 = await a.next(); const code = s1.code;
    assert.ok(/^[A-Z0-9]{5}$/.test(code));
    b.send(JSON.stringify({ type: 'hello', pid: b.pid, table: code })); await b.next();
    b.send(JSON.stringify({ type: 'act', a: { t: 'join', nm: 'Ravi' } })); await b.next();
    a.send(JSON.stringify({ type: 'act', a: { t: 'start' } }));
    const s2 = await b.next();
    assert.strictEqual(s2.s.ph, 'peek');
    assert.ok(s2.s.pl.every(p => p.c.every(c => c === 'B')), 'cards visible before peeking');
    b.send(JSON.stringify({ type: 'act', a: { t: 'peek' } }));
    const s3 = await b.next();
    assert.ok(s3.s.pl[1].c[2] !== 'B' && s3.s.pl[1].c[0] === 'B', 'peek shows only bottom two');
    assert.ok(s3.s.pl[0].c.every(c => c === 'B'), "opponent's cards leaked");
    // Reconnect keeps the seat
    b.close();
    const b2 = await client(b.pid);
    b2.send(JSON.stringify({ type: 'hello', pid: b.pid, table: code }));
    const s4 = await b2.next();
    assert.strictEqual(s4.s.me, 1, 'seat lost on reconnect');
    console.log('WebSocket server: create, join, deal, peek, reconnect passed.');
    a.close(); b2.close(); srv.kill(); process.exit(0);
  } catch (e) { console.error(e); srv.kill(); process.exit(1); }
});
