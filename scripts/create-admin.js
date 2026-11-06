require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const dbFile = path.resolve(process.env.DATABASE_FILE || "./data/club.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.exec(`CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));
(async () => {
  try {
    const username = (await ask("Admin username: ")).trim();
    const password = await ask("Admin password (minimum 12 characters): ");
    if (!/^[a-zA-Z0-9_.-]{4,40}$/.test(username)) throw new Error("Username must be 4-40 characters (letters, numbers, _, ., -).");
    if (password.length < 12) throw new Error("Password must be at least 12 characters.");
    const hash = await bcrypt.hash(password, 12);
    db.prepare("INSERT INTO admins (username,password_hash) VALUES (?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash").run(username, hash);
    console.log("Admin account created/updated. Keep the password private.");
  } catch (e) {
    console.error("Could not create admin:", e.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    db.close();
  }
})();
