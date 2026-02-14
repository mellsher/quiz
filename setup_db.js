const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./quiz.db');

db.serialize(() => {

  // пользователи
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT
  )`);

  // квизы
  db.run(`CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER,
    title TEXT,
    description TEXT,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  )`);

  // вопросы
  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER,
    text TEXT,
    options TEXT,
    correct_indices TEXT,
    image_url TEXT,
    time_limit INTEGER DEFAULT 20,
    FOREIGN KEY(quiz_id) REFERENCES quizzes(id)
  )`);

  // история
  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    quiz_title TEXT,
    role TEXT,
    score INTEGER,
    date TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  console.log("База готова! Добавлена история игр.");
});

db.close();
