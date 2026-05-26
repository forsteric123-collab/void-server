const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const db = new Database('void.db');
app.use(express.json({ limit: '10mb' }));

// ── Таблицы ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username    TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    password    TEXT NOT NULL,
    avatar      TEXT DEFAULT '',
    status      TEXT DEFAULT 'online',
    status_msg  TEXT DEFAULT '',
    bio         TEXT DEFAULT '',
    birthday    TEXT DEFAULT '',
    city        TEXT DEFAULT '',
    website     TEXT DEFAULT '',
    job         TEXT DEFAULT '',
    phone       TEXT DEFAULT '',
    accent      TEXT DEFAULT '#6b8afd',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chats (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    avatar    TEXT DEFAULT '💬',
    type      TEXT DEFAULT 'Чат',
    room_key  TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER,
    text       TEXT,
    is_sent    INTEGER DEFAULT 0,
    time       TEXT,
    sender     TEXT DEFAULT 'Аноним',
    reply_to   TEXT DEFAULT '',
    e2e        INTEGER DEFAULT 0,
    created    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Миграции
['room_key','avatar'].forEach(col => {
  try { db.exec(`ALTER TABLE chats ADD COLUMN ${col} TEXT`); } catch(e){}
});
['sender','reply_to','e2e'].forEach(col => {
  try { db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT DEFAULT ""`); } catch(e){}
});

// Дефолтный общий чат
const count = db.prepare('SELECT COUNT(*) as n FROM chats').get();
if (count.n === 0) {
  db.prepare("INSERT INTO chats (name, avatar, type, room_key) VALUES (?,?,?,?)")
    .run('Общий чат', '💬', 'Чат', 'general');
}

// ── Хелперы ───────────────────────────────────────────────
function hashPass(pass) {
  return crypto.createHash('sha256').update(pass + 'void_salt_2024').digest('hex');
}

// ── Статика ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH API ──────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, name, password } = req.body;
  if (!username || !name || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  if (!/^[a-zа-я0-9_]+$/i.test(username)) return res.status(400).json({ error: 'Только буквы, цифры и _' });
  const exists = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: 'Имя пользователя занято' });
  db.prepare('INSERT INTO users (username, name, password) VALUES (?,?,?)')
    .run(username, name, hashPass(password));
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
  if (user.password !== hashPass(password)) return res.status(401).json({ error: 'Неверный пароль' });
  db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE username = ?')
    .run('online', username);
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/logout', (req, res) => {
  const { username } = req.body;
  if (username) db.prepare('UPDATE users SET status = ? WHERE username = ?').run('offline', username);
  res.json({ ok: true });
});

// ── USERS API ─────────────────────────────────────────────
// Поиск пользователей
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  const exclude = req.query.exclude || '';
  let users;
  if (!q) {
    users = db.prepare('SELECT * FROM users WHERE username != ? ORDER BY status DESC, last_seen DESC LIMIT 50')
      .all(exclude);
  } else {
    users = db.prepare(`
      SELECT * FROM users WHERE username != ? AND (
        LOWER(username) LIKE ? OR
        LOWER(name) LIKE ? OR
        LOWER(city) LIKE ? OR
        replace(replace(replace(phone,' ',''),'-',''),'+','') LIKE ?
      ) ORDER BY status DESC, last_seen DESC LIMIT 30
    `).all(exclude, `%${q}%`, `%${q}%`, `%${q}%`, `%${q.replace(/\D/g,'')}%`);
  }
  res.json(users.map(sanitizeUser));
});

// Получить профиль пользователя
app.get('/api/users/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(sanitizeUser(user));
});

// Обновить профиль
app.post('/api/users/:username/update', (req, res) => {
  const { name, status, statusMsg, bio, birthday, city, website, job, phone, accent, avatar } = req.body;
  db.prepare(`UPDATE users SET name=?, status=?, status_msg=?, bio=?, birthday=?, city=?, website=?, job=?, phone=?, accent=?, avatar=?, last_seen=CURRENT_TIMESTAMP WHERE username=?`)
    .run(name||'', status||'online', statusMsg||'', bio||'', birthday||'', city||'', website||'', job||'', phone||'', accent||'#6b8afd', avatar||'', req.params.username);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  res.json({ ok: true, user: sanitizeUser(user) });
});

// Сменить юзернейм
app.post('/api/users/:username/rename', (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || !/^[a-zа-я0-9_]+$/i.test(newUsername)) return res.status(400).json({ error: 'Некорректный юзернейм' });
  const exists = db.prepare('SELECT username FROM users WHERE username = ?').get(newUsername);
  if (exists) return res.status(400).json({ error: 'Занято' });
  db.prepare('UPDATE users SET username = ? WHERE username = ?').run(newUsername, req.params.username);
  res.json({ ok: true });
});

function sanitizeUser(u) {
  const { password, ...safe } = u;
  return safe;
}

// ── CHATS & MESSAGES API ──────────────────────────────────
app.get('/api/chats', (req, res) => {
  res.json(db.prepare('SELECT * FROM chats').all());
});

app.get('/api/messages/:roomKey', (req, res) => {
  const chat = db.prepare('SELECT id FROM chats WHERE room_key = ?').get(req.params.roomKey);
  if (!chat) return res.json([]);
  res.json(db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created DESC LIMIT 100'
  ).all(chat.id).reverse());
});

// Получить все ЛС чаты пользователя
app.get('/api/my-dms', (req, res) => {
  const username = req.query.username;
  if (!username) return res.json([]);
  // Ищем все комнаты где есть этот юзер в room_key
  const dms = db.prepare(
    "SELECT * FROM chats WHERE type = 'ЛС' AND room_key LIKE ?"
  ).all('%' + username + '%');
  // Фильтруем точнее — юзер должен быть в dm_user1_user2
  const filtered = dms.filter(c => {
    if (!c.room_key) return false;
    const parts = c.room_key.replace('dm_', '').split('_');
    return parts.includes(username);
  });
  res.json(filtered);
});

app.post('/api/dm', (req, res) => {
  const { user1, user2 } = req.body;
  if (!user1 || !user2) return res.status(400).json({ error: 'нужны user1 и user2' });
  const roomKey = 'dm_' + [user1, user2].sort().join('_');
  let chat = db.prepare('SELECT * FROM chats WHERE room_key = ?').get(roomKey);
  if (!chat) {
    const info = db.prepare("INSERT INTO chats (name, avatar, type, room_key) VALUES (?,?,?,?)")
      .run(user2, '👤', 'ЛС', roomKey);
    chat = { id: info.lastInsertRowid, name: user2, avatar: '👤', type: 'ЛС', room_key: roomKey };
  }
  res.json(chat);
});

// ── WebSocket ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Сервер: http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });

const rooms = new Map();  // roomKey → Set<ws>
const online = new Map(); // ws → { username, roomKey }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'join') {
        const prev = online.get(ws);
        if (prev) { const r = rooms.get(prev.roomKey); if (r) r.delete(ws); }
        online.set(ws, { username: data.username, roomKey: data.roomKey });
        if (!rooms.has(data.roomKey)) rooms.set(data.roomKey, new Set());
        rooms.get(data.roomKey).add(ws);
        ws.send(JSON.stringify({ type: 'joined', roomKey: data.roomKey }));

        // Уведомить всех об онлайн статусе
        broadcastAll({ type: 'user_online', username: data.username });
        return;
      }

      if (data.type === 'message') {
        let chat = db.prepare('SELECT id FROM chats WHERE room_key = ?').get(data.roomKey);
        if (!chat) return;
        const info = db.prepare(
          'INSERT INTO messages (chat_id, text, is_sent, time, sender, reply_to, e2e) VALUES (?,?,?,?,?,?,?)'
        ).run(chat.id, data.text, 1, data.time, data.sender||'', JSON.stringify(data.replyTo||null), data.e2e ? 1 : 0);

        const broadcast = JSON.stringify({
          type: 'message',
          msg: { id: info.lastInsertRowid, room_key: data.roomKey,
                 text: data.text, time: data.time, sender: data.sender,
                 replyTo: data.replyTo, e2e: data.e2e, tmpId: data.tmpId }
        });
        const room = rooms.get(data.roomKey);
        if (room) room.forEach(c => { if (c.readyState === 1) c.send(broadcast); });
      }

      if (data.type === 'typing') {
        const room = rooms.get(data.roomKey);
        if (room) room.forEach(c => {
          if (c !== ws && c.readyState === 1)
            c.send(JSON.stringify({ type: 'typing', username: data.username, roomKey: data.roomKey }));
        });
      }

    } catch(e) { console.error('WS:', e.message); }
  });

  ws.on('close', () => {
    const info = online.get(ws);
    if (info) {
      const room = rooms.get(info.roomKey);
      if (room) room.delete(ws);
      db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE username = ?')
        .run('offline', info.username);
      broadcastAll({ type: 'user_offline', username: info.username });
    }
    online.delete(ws);
  });
});

function broadcastAll(msg) {
  const str = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
}
