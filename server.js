const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('void.db');
app.use(express.json());

// ── Таблицы ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    avatar   TEXT DEFAULT '💬',
    type     TEXT DEFAULT 'Чат',
    room_key TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   INTEGER,
    text      TEXT,
    is_sent   INTEGER DEFAULT 0,
    time      TEXT,
    sender    TEXT DEFAULT 'Аноним',
    created   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Добавить колонки если их нет (миграция старых баз)
try { db.exec(`ALTER TABLE chats ADD COLUMN room_key TEXT`); } catch(e){}
try { db.exec(`ALTER TABLE messages ADD COLUMN sender TEXT DEFAULT 'Аноним'`); } catch(e){}

// Дефолтный общий чат
const count = db.prepare('SELECT COUNT(*) as n FROM chats').get();
if (count.n === 0) {
  db.prepare("INSERT INTO chats (name, avatar, type, room_key) VALUES (?,?,?,?)")
    .run('Общий чат', '💬', 'Чат', 'general');
}

// ── Статика ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────
// Все чаты
app.get('/api/chats', (req, res) => {
  res.json(db.prepare('SELECT * FROM chats').all());
});

// История сообщений комнаты
app.get('/api/messages/:roomKey', (req, res) => {
  const chat = db.prepare('SELECT id FROM chats WHERE room_key = ?').get(req.params.roomKey);
  if (!chat) return res.json([]);
  res.json(db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created LIMIT 100'
  ).all(chat.id));
});

// Создать или получить ЛС комнату
app.post('/api/dm', (req, res) => {
  const { user1, user2 } = req.body;
  if (!user1 || !user2) return res.status(400).json({ error: 'нужны user1 и user2' });

  // Ключ комнаты — отсортированные имена, всегда одинаковый для двух юзеров
  const roomKey = 'dm_' + [user1, user2].sort().join('_');
  const name = user2; // для user1 это имя собеседника

  let chat = db.prepare('SELECT * FROM chats WHERE room_key = ?').get(roomKey);
  if (!chat) {
    const info = db.prepare(
      "INSERT INTO chats (name, avatar, type, room_key) VALUES (?,?,?,?)"
    ).run(name, '👤', 'ЛС', roomKey);
    chat = { id: info.lastInsertRowid, name, avatar: '👤', type: 'ЛС', room_key: roomKey };
  }
  res.json(chat);
});

// ── WebSocket ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

// rooms: Map<roomKey, Set<ws>>
const rooms = new Map();
// users: Map<ws, { username, roomKey }>
const users = new Map();

wss.on('connection', (ws) => {

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      // ── Войти в комнату ───────────────────────────────
      if (data.type === 'join') {
        const { username, roomKey } = data;

        // Выйти из предыдущей комнаты
        const prev = users.get(ws);
        if (prev) {
          const prevRoom = rooms.get(prev.roomKey);
          if (prevRoom) prevRoom.delete(ws);
        }

        users.set(ws, { username, roomKey });
        if (!rooms.has(roomKey)) rooms.set(roomKey, new Set());
        rooms.get(roomKey).add(ws);

        // Подтверждение
        ws.send(JSON.stringify({ type: 'joined', roomKey }));
        return;
      }

      // ── Сообщение ─────────────────────────────────────
      if (data.type === 'message') {
        const { roomKey, text, sender, time, tmpId } = data;

        // Найти или создать чат в БД
        let chat = db.prepare('SELECT id FROM chats WHERE room_key = ?').get(roomKey);
        if (!chat) return;

        const info = db.prepare(
          'INSERT INTO messages (chat_id, text, is_sent, time, sender) VALUES (?,?,?,?,?)'
        ).run(chat.id, text, 1, time, sender || 'Аноним');

        const broadcast = JSON.stringify({
          type: 'message',
          msg: {
            id: info.lastInsertRowid,
            chat_id: chat.id,
            room_key: roomKey,
            text, time, sender,
            tmpId
          }
        });

        // Разослать всем в комнате
        const room = rooms.get(roomKey);
        if (room) {
          room.forEach(client => {
            if (client.readyState === 1) client.send(broadcast);
          });
        }
      }

    } catch(e) {
      console.error('WS error:', e.message);
    }
  });

  ws.on('close', () => {
    const info = users.get(ws);
    if (info) {
      const room = rooms.get(info.roomKey);
      if (room) room.delete(ws);
    }
    users.delete(ws);
  });
});
