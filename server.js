const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const FRONTEND = path.join(__dirname, 'index.html');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: {}, messages: [] };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
if (!db.users) db.users = {};
if (!Array.isArray(db.messages)) db.messages = [];
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
function hash(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function cleanNick(v) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, 20); }
function userPublic(u) { return { id: u.id, nick: u.nick, online: sockets.has(u.id) }; }
function findByToken(token) {
  const h = hash(String(token || ''));
  return Object.values(db.users).find(u => u.tokenHash === h) || null;
}
function findByNick(nick) {
  const q = cleanNick(nick).toLowerCase();
  return Object.values(db.users).filter(u => u.nick.toLowerCase().includes(q)).slice(0, 30);
}
function pair(a, b) { return [a, b].sort().join(':'); }

const app = express();
app.use(express.json({ limit: '300kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'Ceko Hub Chat' }));

app.post('/api/register', (req, res) => {
  const nick = cleanNick(req.body?.nickname) || `Guest-${crypto.randomBytes(3).toString('hex')}`;
  const requestedId = String(req.body?.clientId || '');
  let u = requestedId ? db.users[requestedId] : null;
  if (u) {
    const conflict = Object.values(db.users).find(x => x.id !== u.id && x.nick.toLowerCase() === nick.toLowerCase());
    if (conflict) return res.status(409).json({ error: 'Этот ник уже занят' });
    u.nick = nick;
    saveDb();
    return res.json({ token: u.tokenPlain, user: userPublic(u) });
  }
  if (Object.values(db.users).some(x => x.nick.toLowerCase() === nick.toLowerCase())) {
    return res.status(409).json({ error: 'Этот ник уже занят' });
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  u = { id, nick, tokenHash: hash(token), tokenPlain: token, createdAt: Date.now() };
  db.users[id] = u;
  saveDb();
  res.json({ token, user: userPublic(u) });
});

app.post('/api/profile', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const u = findByToken(token);
  if (!u) return res.status(401).json({ error: 'Сессия недействительна' });
  const nick = cleanNick(req.body?.nickname);
  if (!nick) return res.status(400).json({ error: 'Ник не может быть пустым' });
  const conflict = Object.values(db.users).find(x => x.id !== u.id && x.nick.toLowerCase() === nick.toLowerCase());
  if (conflict) return res.status(409).json({ error: 'Этот ник уже занят' });
  u.nick = nick;
  saveDb();
  broadcast({ type: 'user_updated', user: userPublic(u) });
  res.json({ user: userPublic(u) });
});

app.get('/api/users', (req, res) => {
  const q = cleanNick(req.query.q);
  if (q.length < 2) return res.json([]);
  res.json(findByNick(q).map(userPublic));
});

app.get('/api/messages/:userId', (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const me = findByToken(token);
  if (!me) return res.status(401).json({ error: 'Сессия недействительна' });
  const other = db.users[req.params.userId];
  if (!other || other.id === me.id) return res.status(404).json({ error: 'Пользователь не найден' });
  const key = pair(me.id, other.id);
  const out = db.messages.filter(m => m.pair === key).slice(-100).map(m => ({
    id: m.id, from: m.from, to: m.to, text: m.text, createdAt: m.createdAt
  }));
  res.json(out);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map();
const rate = new Map();
function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(data) { for (const ws of sockets.values()) send(ws, data); }
function tooFast(id) {
  const now = Date.now();
  const arr = (rate.get(id) || []).filter(t => now - t < 60000);
  arr.push(now); rate.set(id, arr);
  return arr.length > 45;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const u = findByToken(url.searchParams.get('token'));
  if (!u) { ws.close(1008, 'Unauthorized'); return; }
  sockets.set(u.id, ws);
  send(ws, { type: 'ready', user: userPublic(u) });
  broadcast({ type: 'presence', userId: u.id, online: true });

  ws.on('message', raw => {
    let data; try { data = JSON.parse(raw.toString()); } catch (_) { return; }
    if (tooFast(u.id)) return send(ws, { type: 'error', error: 'Слишком много сообщений. Подожди немного.' });
    if (data.type !== 'dm') return;
    const to = String(data.to || '');
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!to || !text || to === u.id || !db.users[to]) return;
    const msg = { id: crypto.randomUUID(), pair: pair(u.id, to), from: u.id, to, text, createdAt: Date.now() };
    db.messages.push(msg);
    if (db.messages.length > 20000) db.messages.splice(0, db.messages.length - 20000);
    saveDb();
    const payload = { type: 'dm', message: { id: msg.id, from: msg.from, to: msg.to, text: msg.text, createdAt: msg.createdAt } };
    send(ws, payload);
    send(sockets.get(to), payload);
  });
  ws.on('close', () => {
    if (sockets.get(u.id) === ws) sockets.delete(u.id);
    broadcast({ type: 'presence', userId: u.id, online: false });
  });
});

// If index.html is placed beside server.js, this server can host the whole app too.
app.get('/', (req, res) => {
  if (fs.existsSync(FRONTEND)) return res.sendFile(FRONTEND);
  res.json({ ok: true, message: 'Ceko Hub Chat API is running' });
});

server.listen(PORT, () => console.log(`Ceko Hub server listening on ${PORT}`));
