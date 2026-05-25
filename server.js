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
    created  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Добавляем тестовый чат если база пустая
const count = db.prepare('SELECT COUNT(*) as n FROM chats').get();
if (count.n === 0) {
  db.prepare("INSERT INTO chats (name, avatar, type) VALUES (?, ?, ?)")
    .run('Основной чат', '💬', 'Чат');
}

// ── 4. Раздаём HTML-файл ──────────────────────
// Положи messenger.html в папку public/index.html
app.use(express.static(path.join(__dirname, 'public')));

// ── 5. API маршруты ───────────────────────────
// Получить все чаты
app.get('/api/chats', (req, res) => {
  const chats = db.prepare('SELECT * FROM chats').all();
  res.json(chats);
});

// Получить сообщения конкретного чата
app.get('/api/messages/:chatId', (req, res) => {
  const msgs = db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? ORDER BY created'
  ).all(req.params.chatId);
  res.json(msgs);
});

// Создать новый чат
app.post('/api/chats', (req, res) => {
  const { name, avatar, type } = req.body;
  const info = db.prepare(
    'INSERT INTO chats (name, avatar, type) VALUES (?, ?, ?)'
  ).run(name, avatar || '💬', type || 'Чат');
  res.json({ id: info.lastInsertRowid, name, avatar, type });
});

// ── 6. WebSocket + запуск сервера ─────────────
const server = app.listen(3000, () => {
  console.log('Сервер запущен: http://localhost:3000');
});

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);

  ws.on('message', (raw) => {
    const data = JSON.parse(raw);

    if (data.type === 'message') {
      const info = db.prepare(
        'INSERT INTO messages (chat_id, text, is_sent, time) VALUES (?, ?, ?, ?)'
      ).run(data.chat_id, data.text, data.is_sent ? 1 : 0, data.time);

      const broadcast = JSON.stringify({
        type: 'message',
        msg: { id: info.lastInsertRowid, ...data }
      });

      clients.forEach(c => {
        if (c.readyState === 1) c.send(broadcast);
      });
    }
  });

  ws.on('close', () => clients.delete(ws));
});