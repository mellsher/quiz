const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcrypt');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new sqlite3.Database('./quiz.db');


app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: 'secret-key-123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password_hash) VALUES (?, ?)", [username, hash], function(err) {
            if (err) return res.status(400).json({ error: 'Занято' });
            req.session.userId = this.lastID;
            req.session.username = username;
            res.json({ status: 'ok' });
        });
    } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (!user) return res.status(400).json({ error: 'Неверный логин' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            req.session.userId = user.id;
            req.session.username = user.username;
            res.json({ status: 'ok' });
        } else {
            res.status(400).json({ error: 'Неверный пароль' });
        }
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ status: 'ok' }); });

app.get('/api/me', (req, res) => {
    if (req.session.userId) res.json({ id: req.session.userId, username: req.session.username });
    else res.status(401).json({ error: 'Guest' });
});


// 1. для редактирования
app.get('/api/quizzes/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const quizId = req.params.id;

    db.get("SELECT * FROM quizzes WHERE id = ? AND owner_id = ?", [quizId, req.session.userId], (err, quiz) => {
        if (!quiz) return res.status(404).json({error: "Not found"});

        db.all("SELECT * FROM questions WHERE quiz_id = ?", [quizId], (err, questions) => {
            res.json({ ...quiz, questions });
        });
    });
});

// 2. создать/обновить
app.post('/api/save-quiz', upload.any(), (req, res) => {
    if (!req.session.userId) return res.status(401).send();

    const { id, title, description, questionsData } = req.body;
    let questions = [];
    try { questions = JSON.parse(questionsData); } catch(e) {}

    const saveQuestions = (quizId) => {
        db.run("DELETE FROM questions WHERE quiz_id = ?", [quizId], () => {
            const stmt = db.prepare("INSERT INTO questions (quiz_id, text, options, correct_indices, image_url, time_limit) VALUES (?, ?, ?, ?, ?, ?)");

            questions.forEach((q, index) => {
                let imgUrl = q.image_url || null;

                const file = req.files.find(f => f.fieldname === `image_${q.tempId}`);
                if (file) imgUrl = `/uploads/${file.filename}`;

                stmt.run(quizId, q.text, q.options, q.correct_indices, imgUrl, q.time_limit);
            });
            stmt.finalize();
            res.json({ status: 'ok', id: quizId });
        });
    };

    if (id && id !== 'null') {
        db.run("UPDATE quizzes SET title=?, description=? WHERE id=? AND owner_id=?",
            [title, description, id, req.session.userId],
            function(err) {
                if (this.changes === 0) return res.status(403).json({error: "Нет прав"});
                saveQuestions(id);
            }
        );
    } else {
        db.run("INSERT INTO quizzes (owner_id, title, description) VALUES (?, ?, ?)",
            [req.session.userId, title, description],
            function(err) {
                saveQuestions(this.lastID);
            }
        );
    }
});

// 3. удалить
app.delete('/api/quizzes/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const quizId = req.params.id;

    db.run("DELETE FROM quizzes WHERE id = ? AND owner_id = ?", [quizId, req.session.userId], function(err) {
        if (this.changes > 0) {
            db.run("DELETE FROM questions WHERE quiz_id = ?", [quizId]);
            res.json({ status: 'ok' });
        } else {
            res.status(403).json({ error: 'Ошибка доступа' });
        }
    });
});

// список квизов
app.get('/api/my-quizzes', (req, res) => {
    if (!req.session.userId) return res.status(401).json({});
    db.all("SELECT * FROM quizzes WHERE owner_id = ?", [req.session.userId], (err, rows) => res.json(rows));
});

// история
app.get('/api/my-history', (req, res) => {
    if (!req.session.userId) return res.status(401).json({});
    db.all("SELECT * FROM history WHERE user_id = ? ORDER BY id DESC", [req.session.userId], (err, rows) => res.json(rows));
});

// очистить историю
app.delete('/api/my-history', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });

    db.run("DELETE FROM history WHERE user_id = ?", [req.session.userId], function(err) {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Ошибка базы данных' });
        }
        res.json({ status: 'ok' });
    });
});




let games = {};

function sendQuestion(pin) {
    const game = games[pin];
    if (!game) return;
    const question = game.questions[game.currentIndex];
    game.acceptingAnswers = true;
    const data = {
        text: question.text,
        options: JSON.parse(question.options),
        current: game.currentIndex + 1,
        total: game.questions.length,
        image: question.image_url,
        timeLimit: question.time_limit
    };
    io.to(game.hostSocket).emit('new_question', data);
    io.to(pin).emit('player_question_start', data);

    const timeMs = (question.time_limit + 1) * 1000;
    if (game.timerFunc) clearTimeout(game.timerFunc);
    game.timerFunc = setTimeout(() => { finishQuestion(pin); }, timeMs);
}

function finishQuestion(pin) {
    const game = games[pin];
    if (!game) return;
    game.acceptingAnswers = false;
    io.to(pin).emit('time_up');
    if (game.autoMove) setTimeout(() => { nextQuestionLogic(pin); }, 5000);
}

function nextQuestionLogic(pin) {
    const game = games[pin];
    if (!game) return;
    game.currentIndex++;
    if (game.currentIndex < game.questions.length) {
        sendQuestion(pin);
    } else {
        finishGame(pin);
    }
}

function finishGame(pin) {
    const game = games[pin];
    game.status = 'finished';
    const leaderboard = game.players.sort((a, b) => b.score - a.score);
    io.to(pin).emit('game_over', leaderboard);
    io.to(game.hostSocket).emit('game_over', leaderboard);


    const date = new Date().toLocaleString("ru-RU");
    const stmt = db.prepare("INSERT INTO history (user_id, quiz_title, role, score, date) VALUES (?, ?, ?, ?, ?)");
    db.get("SELECT title FROM quizzes WHERE id = ?", [game.quizId], (err, row) => {
        const title = row ? row.title : 'Квиз';
        game.players.forEach(p => {
            if (p.dbUserId) stmt.run(p.dbUserId, title, 'player', p.score, date);
        });
        if (game.hostDbId) stmt.run(game.hostDbId, title, 'host', 0, date);
        stmt.finalize();
    });
}

io.on('connection', (socket) => {
    socket.on('host_init_game', (data) => {
        const pin = Math.floor(1000 + Math.random() * 9000).toString();
        games[pin] = {
            quizId: data.quizId, hostDbId: data.hostDbId, hostSocket: socket.id,
            players: [], questions: [], currentIndex: 0, status: 'waiting', acceptingAnswers: false
        };
        socket.join(pin);
        socket.emit('game_created', { pin });
    });

    socket.on('host_toggle_auto', (data) => { if (games[data.pin]) games[data.pin].autoMove = data.enabled; });
    socket.on('player_join', (data) => {
        const game = games[data.pin];
        if (game) {
            game.players.push({ id: socket.id, name: data.nickname, score: 0, dbUserId: data.dbUserId || null });
            socket.join(data.pin);
            socket.emit('player_joined_success');
            io.to(game.hostSocket).emit('update_player_list', game.players);
        } else { socket.emit('error_msg', 'Неверный PIN!'); }
    });

    socket.on('host_start_game', (pin) => {
        const game = games[pin];
        if (!game) return;
        db.all("SELECT * FROM questions WHERE quiz_id = ?", [game.quizId], (err, rows) => {
            if (!rows || rows.length === 0) return;
            game.questions = rows;
            game.currentIndex = 0;
            game.status = 'active';
            sendQuestion(pin);
        });
    });

    socket.on('player_answer', (data) => {
        const game = games[data.pin];
        if (game && game.status === 'active' && game.acceptingAnswers) {
            const question = game.questions[game.currentIndex];
            const correctIndices = JSON.parse(question.correct_indices).map(Number).sort((a,b)=>a-b);
            const playerIndices = (data.answerIndices || []).map(Number).sort((a,b)=>a-b);
            if (JSON.stringify(correctIndices) === JSON.stringify(playerIndices)) {
                const p = game.players.find(pl => pl.id === socket.id);
                if (p) { p.score += 100; io.to(socket.id).emit('answer_received'); }
            }
        }
    });

    socket.on('host_next_question', (pin) => {
        const game = games[pin];
        if(game && game.timerFunc) clearTimeout(game.timerFunc);
        nextQuestionLogic(pin);
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`SuperPuperUltraMegaQuizProMax is running on port ${PORT}`);
});
