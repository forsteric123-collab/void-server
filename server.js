const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── База данных ───────────────────────────────────────────
const dbDir = process.env.DB_PATH
    ? path.dirname(process.env.DB_PATH)
    : path.join(__dirname, 'data');
const dbFile = process.env.DB_PATH || path.join(dbDir, 'void.db');

try { fs.mkdirSync(dbDir, { recursive: true }); } catch(e) {}

const db = new Database(dbFile);
// WAL режим — быстрее и надёжнее при конкурентных записях
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Таблицы ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    avatar     TEXT DEFAULT '💬',
    avatar_img TEXT DEFAULT '',
    type       TEXT DEFAULT 'Чат',
    owner      TEXT NOT NULL,
    desc       TEXT DEFAULT '',
    perms      TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER,
    username TEXT,
    role     TEXT DEFAULT 'member',
    PRIMARY KEY(group_id, username)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id  INTEGER,
    text      TEXT DEFAULT '',
    time      TEXT DEFAULT '',
    sender    TEXT DEFAULT '',
    reply_to  TEXT DEFAULT '',
    is_file   INTEGER DEFAULT 0,
    created   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_gm_group ON group_messages(group_id);
  CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(username);

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
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id   INTEGER NOT NULL,
    text      TEXT DEFAULT '',
    time      TEXT DEFAULT '',
    sender    TEXT DEFAULT '',
    reply_to  TEXT DEFAULT '',
    is_file   INTEGER DEFAULT 0,
    created   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
`);

// Дефолтный общий чат
const chatCount = db.prepare('SELECT COUNT(*) as n FROM chats').get();
if (chatCount.n === 0) {
    db.prepare("INSERT INTO chats (name, avatar, type, room_key) VALUES (?,?,?,?)")
        .run('Общий чат', '💬', 'Чат', 'general');
}

// ── Хелперы ───────────────────────────────────────────────
function hashPass(pass) {
    return crypto.createHash('sha256').update(pass + 'void_salt_2024').digest('hex');
}
function sanitizeUser(u) {
    if (!u) return null;
    const { password, ...safe } = u;
    return safe;
}

// ── Статика ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH ──────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
    try {
        const { username, name, password } = req.body;
        if (!username || !name || !password)
            return res.status(400).json({ error: 'Заполните все поля' });
        if (password.length < 6)
            return res.status(400).json({ error: 'Пароль минимум 6 символов' });
        if (!/^[a-zа-я0-9_]+$/i.test(username))
            return res.status(400).json({ error: 'Только буквы, цифры и _' });
        const exists = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
        if (exists) return res.status(400).json({ error: 'Имя пользователя занято' });
        db.prepare('INSERT INTO users (username, name, password) VALUES (?,?,?)')
            .run(username, name, hashPass(password));
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        res.json({ ok: true, user: sanitizeUser(user) });
    } catch(e) {
        console.error('Register error:', e);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ error: 'Заполните все поля' });
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
        if (user.password !== hashPass(password))
            return res.status(401).json({ error: 'Неверный пароль' });
        db.prepare('UPDATE users SET status=?, last_seen=CURRENT_TIMESTAMP WHERE username=?')
            .run('online', username);
        res.json({ ok: true, user: sanitizeUser(user) });
    } catch(e) {
        console.error('Login error:', e);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/logout', (req, res) => {
    try {
        const { username } = req.body;
        if (username)
            db.prepare('UPDATE users SET status=?, last_seen=CURRENT_TIMESTAMP WHERE username=?')
                .run('offline', username);
        res.json({ ok: true });
    } catch(e) { res.json({ ok: true }); }
});

// ── USERS ─────────────────────────────────────────────────
app.get('/api/users/search', (req, res) => {
    try {
        const q = (req.query.q || '').toLowerCase().trim();
        const exclude = req.query.exclude || '';
        let users;
        if (!q) {
            users = db.prepare(
                'SELECT * FROM users WHERE username != ? ORDER BY CASE status WHEN ? THEN 0 ELSE 1 END, last_seen DESC LIMIT 50'
            ).all(exclude, 'online');
        } else {
            users = db.prepare(`
                SELECT * FROM users WHERE username != ? AND (
                    LOWER(username) LIKE ? OR LOWER(name) LIKE ? OR
                    LOWER(city) LIKE ? OR replace(replace(phone,'-',''),' ','') LIKE ?
                ) ORDER BY CASE status WHEN 'online' THEN 0 ELSE 1 END LIMIT 30
            `).all(exclude, `%${q}%`, `%${q}%`, `%${q}%`, `%${q.replace(/\D/g,'')}%`);
        }
        res.json(users.map(sanitizeUser));
    } catch(e) {
        console.error('Search error:', e);
        res.json([]);
    }
});

app.get('/api/users/:username', (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
        if (!user) return res.status(404).json({ error: 'Не найден' });
        res.json(sanitizeUser(user));
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/users/:username/update', (req, res) => {
    try {
        const u = req.body;
        db.prepare(`UPDATE users SET name=?,status=?,status_msg=?,bio=?,birthday=?,city=?,website=?,job=?,phone=?,accent=?,avatar=?,last_seen=CURRENT_TIMESTAMP WHERE username=?`)
            .run(u.name||'', u.status||'online', u.status_msg||u.statusMsg||'', u.bio||'', u.birthday||'', u.city||'', u.website||'', u.job||'', u.phone||'', u.accent||'#6b8afd', u.avatar||'', req.params.username);
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
        res.json({ ok: true, user: sanitizeUser(user) });
    } catch(e) {
        console.error('Update error:', e);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// ── CHATS ─────────────────────────────────────────────────
app.get('/api/chats', (req, res) => {
    try {
        res.json(db.prepare("SELECT * FROM chats WHERE type != 'ЛС'").all());
    } catch(e) { res.json([]); }
});

app.get('/api/my-dms', (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.json([]);
        const dms = db.prepare("SELECT * FROM chats WHERE type='ЛС'").all();
        const filtered = dms.filter(c => {
            if (!c.room_key) return false;
            const parts = c.room_key.replace('dm_', '').split('_');
            return parts.includes(username);
        });
        res.json(filtered);
    } catch(e) { res.json([]); }
});

app.get('/api/messages/:roomKey', (req, res) => {
    try {
        const chat = db.prepare('SELECT id FROM chats WHERE room_key=?').get(req.params.roomKey);
        if (!chat) return res.json([]);
        const msgs = db.prepare(
            'SELECT * FROM messages WHERE chat_id=? ORDER BY created DESC LIMIT 100'
        ).all(chat.id).reverse();
        res.json(msgs);
    } catch(e) { res.json([]); }
});

app.post('/api/dm', (req, res) => {
    try {
        const { user1, user2 } = req.body;
        if (!user1 || !user2) return res.status(400).json({ error: 'нужны user1 и user2' });
        const roomKey = 'dm_' + [user1, user2].sort().join('_');
        let chat = db.prepare('SELECT * FROM chats WHERE room_key=?').get(roomKey);
        if (!chat) {
            const info = db.prepare("INSERT INTO chats (name,avatar,type,room_key) VALUES (?,?,?,?)")
                .run(user2, '👤', 'ЛС', roomKey);
            chat = { id: info.lastInsertRowid, name: user2, avatar: '👤', type: 'ЛС', room_key: roomKey };
        }
        res.json(chat);
    } catch(e) {
        console.error('DM error:', e);
        res.status(500).json({ error: 'Ошибка' });
    }
});

// ── GROUPS API ───────────────────────────────────────────

// Создать группу
app.post('/api/groups', (req, res) => {
    try {
        const { name, avatar, type, owner } = req.body;
        if (!name || !owner) return res.status(400).json({ error: 'нужны name и owner' });
        const info = db.prepare("INSERT INTO groups (name,avatar,type,owner) VALUES (?,?,?,?)")
            .run(name, avatar||'💬', type||'Чат', owner);
        db.prepare("INSERT INTO group_members (group_id,username,role) VALUES (?,?,?)")
            .run(info.lastInsertRowid, owner, 'owner');
        res.json({ id: info.lastInsertRowid, name, avatar, type, owner });
    } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

// Получить группы пользователя
app.get('/api/groups', (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.json([]);
        const groups = db.prepare(`
            SELECT g.*, GROUP_CONCAT(gm.username) as members_str,
                   GROUP_CONCAT(gm.role) as roles_str
            FROM groups g
            JOIN group_members gm ON g.id = gm.group_id
            WHERE g.id IN (SELECT group_id FROM group_members WHERE username=?)
            GROUP BY g.id
        `).all(username);
        res.json(groups.map(g => ({
            ...g,
            members: g.members_str ? g.members_str.split(',') : [],
            roles: g.roles_str ? g.roles_str.split(',') : []
        })));
    } catch(e) { res.json([]); }
});

// Добавить участника
app.post('/api/groups/:id/members', (req, res) => {
    try {
        const { username, role } = req.body;
        db.prepare("INSERT OR IGNORE INTO group_members (group_id,username,role) VALUES (?,?,?)")
            .run(req.params.id, username, role||'member');
        // Уведомить всех в группе через WS
        const roomKey = 'group_' + req.params.id;
        const msg = JSON.stringify({ type: 'group_update', groupId: Number(req.params.id) });
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Обновить роль
app.post('/api/groups/:id/role', (req, res) => {
    try {
        const { username, role } = req.body;
        db.prepare("UPDATE group_members SET role=? WHERE group_id=? AND username=?")
            .run(role, req.params.id, username);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Обновить группу
app.post('/api/groups/:id/update', (req, res) => {
    try {
        const { name, avatar, avatarImg, desc } = req.body;
        db.prepare("UPDATE groups SET name=?,avatar=?,avatar_img=?,desc=? WHERE id=?")
            .run(name||'', avatar||'💬', avatarImg||'', desc||'', req.params.id);
        res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// История сообщений группы
app.get('/api/groups/:id/messages', (req, res) => {
    try {
        const msgs = db.prepare(
            'SELECT * FROM messages WHERE chat_id=? ORDER BY created DESC LIMIT 100'
        ).all(req.params.id).reverse();
        res.json(msgs);
    } catch(e) { res.json([]); }
});

// ── WEBSOCKET ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
const wss = new WebSocketServer({ 
    server,
    perMessageDeflate: false  // отключить сжатие — стабильнее на Railway
});

// Heartbeat — закрывать мёртвые соединения
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { ws.terminate(); return; }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// roomKey → Set<ws>
const rooms = new Map();
// ws → { username, rooms: Set<roomKey> }
const clients = new Map();

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    clients.set(ws, { username: null, rooms: new Set() });

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);

            // Войти в комнату
            if (data.type === 'join') {
                const { username, roomKey } = data;
                if (!username || !roomKey) return;

                const clientInfo = clients.get(ws);
                clientInfo.username = username;
                clientInfo.rooms.add(roomKey);

                if (!rooms.has(roomKey)) rooms.set(roomKey, new Set());
                rooms.get(roomKey).add(ws);

                ws.send(JSON.stringify({ type: 'joined', roomKey }));

                // Обновить статус онлайн
                try {
                    db.prepare('UPDATE users SET status=?, last_seen=CURRENT_TIMESTAMP WHERE username=?')
                        .run('online', username);
                    broadcastAll({ type: 'user_online', username });
                } catch(e) {}
                return;
            }

            // Сообщение
            if (data.type === 'message') {
                const { roomKey, text, sender, time, tmpId, isFile, replyTo, fileName, fileType, caption } = data;
                if (!roomKey || !sender) return;

                let chat = db.prepare('SELECT id FROM chats WHERE room_key=?').get(roomKey);
                // Если комната не существует — создать (для ЛС)
                if (!chat && roomKey.startsWith('dm_')) {
                    const parts = roomKey.replace('dm_', '').split('_');
                    const info = db.prepare("INSERT OR IGNORE INTO chats (name,avatar,type,room_key) VALUES (?,?,?,?)")
                        .run(parts[1] || 'ЛС', '👤', 'ЛС', roomKey);
                    chat = db.prepare('SELECT id FROM chats WHERE room_key=?').get(roomKey);
                }
                if (!chat) return;

                const info = db.prepare(
                    'INSERT INTO messages (chat_id,text,time,sender,reply_to,is_file) VALUES (?,?,?,?,?,?)'
                ).run(chat.id, text||'', time||'', sender, JSON.stringify(replyTo||null), isFile ? 1 : 0);

                const broadcast = JSON.stringify({
                    type: 'message',
                    msg: {
                        id: info.lastInsertRowid,
                        room_key: roomKey,
                        text: text||'',
                        time: time||'',
                        sender,
                        replyTo: replyTo || null,
                        isFile: isFile || false,
                        fileName: fileName || '',
                        fileType: fileType || '',
                        caption: caption || '',
                        tmpId: tmpId || null
                    }
                });

                const room = rooms.get(roomKey);
                if (room) {
                    room.forEach(c => {
                        if (c.readyState === 1) c.send(broadcast);
                    });
                }
                return;
            }

            // Ping от клиента — отвечаем pong
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            // Обновление группы
            if (data.type === 'group_join') {
                // Войти в комнату группы
                const rk = 'group_' + data.groupId;
                const clientInfo2 = clients.get(ws);
                if (clientInfo2) {
                    clientInfo2.rooms.add(rk);
                    if (!rooms.has(rk)) rooms.set(rk, new Set());
                    rooms.get(rk).add(ws);
                }
                return;
            }

            // Typing индикатор
            if (data.type === 'typing') {
                const room = rooms.get(data.roomKey);
                if (room) room.forEach(c => {
                    if (c !== ws && c.readyState === 1)
                        c.send(JSON.stringify({ type: 'typing', username: data.username, roomKey: data.roomKey }));
                });
            }

        } catch(err) {
            console.error('WS message error:', err.message);
        }
    });

    ws.on('close', () => {
        const clientInfo = clients.get(ws);
        if (clientInfo) {
            // Удалить из всех комнат
            clientInfo.rooms.forEach(roomKey => {
                const room = rooms.get(roomKey);
                if (room) { room.delete(ws); if (room.size === 0) rooms.delete(roomKey); }
            });
            // Обновить статус офлайн
            if (clientInfo.username) {
                try {
                    db.prepare('UPDATE users SET status=?, last_seen=CURRENT_TIMESTAMP WHERE username=?')
                        .run('offline', clientInfo.username);
                    broadcastAll({ type: 'user_offline', username: clientInfo.username });
                } catch(e) {}
            }
        }
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error('WS error:', err.message);
    });
});

function broadcastAll(msg) {
    const str = JSON.stringify(msg);
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Завершение работы...');
    db.close();
    process.exit(0);
});
