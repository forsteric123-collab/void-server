// ── 1. Подключаем библиотеки ──────────────────
const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

// ── 2. Создаём приложение и базу данных ───────
const app = express();
const db = new Database('void.db');

app.use(express.json());

// ── 3. Создаём таблицы ────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL,
    avatar TEXT DEFAULT '💬',
    type   TEXT DEFAULT 'Чат'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id  INTEGER,
    text     TEXT,
    is_sent  INTEGER DEFAULT 0,
    time     TEXT,
    sender   TEXT DEFAULT 'Аноним',
    created  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Добавляем колонку sender если её нет (для старых баз)
try {
  db.exec(`ALTER TABLE messages ADD COLUMN sender TEXT DEFAULT 'Аноним'`);
} catch(e) { /* колонка уже есть */ }

// Добавляем тестовый чат если база пустая
const count = db.prepare('SELECT COUNT(*) as n FROM chats').get();
if (count.n === 0) {
  db.prepare("INSERT INTO chats (name, avatar, type) VALUES (?, ?, ?)")
    .run('Основной чат', '💬', 'Чат');
}

// ── 4. Раздаём HTML-файл ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── 5. API маршруты ───────────────────────────
app.get('/api/chats', (req, res) => {
  res.json(db.prepare('SELECT * FROM chats').all());
});

app.get('/api/messages/:chatId', (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created'
  ).all(req.params.chatId));
});

app.post('/api/chats', (req, res) => {
  const { name, avatar, type } = req.body;
  const info = db.prepare(
    'INSERT INTO chats (name, avatar, type) VALUES (?, ?, ?)'
  ).run(name, avatar || '💬', type || 'Чат');
  res.json({ id: info.lastInsertRowid, name, avatar, type });
});

// ── 6. WebSocket + запуск сервера ─────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === 'message') {
        // Сохраняем в БД с sender
        const info = db.prepare(
          'INSERT INTO messages (chat_id, text, is_sent, time, sender) VALUES (?, ?, ?, ?, ?)'
        ).run(
          data.chat_id,
          data.text,
          data.is_sent ? 1 : 0,
          data.time,
          data.sender || 'Аноним'
        );

        // Рассылаем всем — включаем tmpId чтобы отправитель мог заменить временный id
        const broadcast = JSON.stringify({
          type: 'message',
          msg: {
            id: info.lastInsertRowid,
            chat_id: data.chat_id,
            text: data.text,
            is_sent: data.is_sent,
            time: data.time,
            sender: data.sender || 'Аноним',
            tmpId: data.tmpId
          }
        });

        clients.forEach(c => {
          if (c.readyState === 1) c.send(broadcast);
        });
      }
    } catch(e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => clients.delete(ws));
});
