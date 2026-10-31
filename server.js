'use strict';
// Kaboo server: serves the page and runs every table over WebSockets.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const IDLE_TABLE_MS = 3 * 60 * 60 * 1000; // forget tables nobody has touched for 3 hours

const tables = new Map(); // code -> { game, socks:Set<ws>, touched }

function newCode() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 5; i++) c += a[crypto.randomInt(a.length)]; } while (tables.has(c));
  return c;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || /^\/t\/[A-Za-z0-9]{3,8}\/?$/.test(url)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(PAGE);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

function online(t) {
  const s = new Set();
  for (const ws of t.socks) if (ws.pid) s.add(ws.pid);
  return s;
}
// The host is whoever opened the table; if they are offline, the first seated player who is online.
function effHost(t) {
  const on = online(t), g = t.game;
  if (on.has(g.host)) return g.host;
  const p = g.pl.find(p => on.has(p.id));
  return p ? p.id : g.host;
}
function broadcast(t) {
  const on = online(t), host = effHost(t);
  for (const ws of t.socks) {
    if (ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: 'state', code: ws.table, s: t.game.view(ws.pid, on, host) }));
  }
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'ping') return send(ws, { type: 'pong' });

    if (m.type === 'hello') {
      // pid is a secret per-browser token; it is how a player gets their seat back after a reload.
      if (typeof m.pid !== 'string' || !/^[a-z0-9]{16,40}$/.test(m.pid)) return send(ws, { type: 'error', msg: 'Bad player token.' });
      ws.pid = m.pid;
      let code = typeof m.table === 'string' ? m.table.toUpperCase() : '';
      if (m.create) {
        code = newCode();
        tables.set(code, { game: new Game(ws.pid), socks: new Set(), touched: Date.now() });
      }
      const t = tables.get(code);
      if (!t) return send(ws, { type: 'error', msg: 'That table does not exist any more. Open a new one.', code: 'no_table' });
      if (ws.table && ws.table !== code) { const old = tables.get(ws.table); if (old) { old.socks.delete(ws); broadcast(old); } }
      ws.table = code;
      t.socks.add(ws);
      t.touched = Date.now();
      if (m.create && m.nm) t.game.apply(ws.pid, { t: 'join', nm: m.nm }, true);
      return broadcast(t);
    }

    if (m.type === 'act') {
      const t = ws.table && tables.get(ws.table);
      if (!t || !ws.pid) return;
      t.touched = Date.now();
      try { t.game.apply(ws.pid, m.a, effHost(t) === ws.pid); } catch (e) { console.error(e); }
      return broadcast(t);
    }
  });
  ws.on('close', () => {
    const t = ws.table && tables.get(ws.table);
    if (t) { t.socks.delete(ws); broadcast(t); }
  });
});

// Drop dead sockets and forgotten tables.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, t] of tables) if (!t.socks.size && now - t.touched > IDLE_TABLE_MS) tables.delete(code);
}, 30000);

server.listen(PORT, () => console.log('Kaboo is running on http://localhost:' + PORT));
