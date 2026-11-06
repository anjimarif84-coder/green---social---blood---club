require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "";
if (SESSION_SECRET.length < 32 || SESSION_SECRET.startsWith("replace-with")) {
  console.error("SESSION_SECRET must be a real random secret of at least 32 characters. Set it in .env.");
  process.exit(1);
}
const dbFile = path.resolve(process.env.DATABASE_FILE || "./data/club.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  blood_group TEXT NOT NULL CHECK(blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  phone TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  district TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  last_donation TEXT,
  consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','inactive','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS blood_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  blood_group TEXT NOT NULL CHECK(blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  units INTEGER NOT NULL CHECK(units BETWEEN 1 AND 20),
  hospital TEXT NOT NULL,
  district TEXT NOT NULL,
  needed_at TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','contacted','fulfilled','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);


db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
)`);
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare("SELECT sess FROM sessions WHERE sid=? AND expires>?").get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 4 * 3600e3;
      db.prepare("INSERT INTO sessions (sid,sess,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires").run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) {
    try { db.prepare("DELETE FROM sessions WHERE sid=?").run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}
setInterval(() => { try { db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now()); } catch {} }, 3600e3).unref();

// প্রথমবার চালালে .env-এর ADMIN_USERNAME / ADMIN_PASSWORD দিয়ে অ্যাডমিন তৈরি হবে
(function seedAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM admins").get().c;
  const u = (process.env.ADMIN_USERNAME || "").trim();
  const p = process.env.ADMIN_PASSWORD || "";
  if (count > 0 || !u || p.length < 12 || p === "change-this-password-now") return;
  db.prepare("INSERT INTO admins (username,password_hash) VALUES (?,?)").run(u, bcrypt.hashSync(p, 12));
  console.log(`প্রথম অ্যাডমিন তৈরি হয়েছে: ${u} (লগইনের পর পাসওয়ার্ড বদলে নিন)`);
})();

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  store: new SqliteStore(),
  name: "gssbdc.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 1000 * 60 * 60 * 4
  }
}));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "অনেকবার ভুল চেষ্টা হয়েছে। ১৫ মিনিট পরে আবার চেষ্টা করুন।" } });
const publicFormLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "অনেকবার আবেদন পাঠানো হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।" } });

function clean(v, max = 160) {
  return String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
function phoneBD(v) {
  let p = String(v ?? "").replace(/[০-৯]/g, d => BN_DIGITS.indexOf(d)).replace(/[^\d+]/g, "");
  if (p.startsWith("+880")) p = "0" + p.slice(4);
  if (/^8801\d{9}$/.test(p)) p = "0" + p.slice(3);
  return /^01[3-9]\d{8}$/.test(p) ? p : null;
}
// "2026-02-31" কে JS চুপচাপ ৩ মার্চ বানিয়ে ফেলে — তাই তারিখটি ঘুরে এসে একই আছে কি না যাচাই করা হয়
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function validDate(v) {
  if (!v) return null;
  const s = String(v);
  if (!isRealDate(s)) return null;
  const t = Date.parse(s + "T00:00:00Z");
  return t <= Date.now() + 864e5 && t > Date.parse("1990-01-01T00:00:00Z") ? s : null;
}
function requireCsrf(req, res, next) {
  const token = req.get("x-csrf-token");
  if (!token || !req.session.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: "নিরাপত্তা যাচাই ব্যর্থ হয়েছে। পেজটি রিফ্রেশ করে আবার চেষ্টা করুন।" });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: "প্রথমে অ্যাডমিন হিসেবে লগইন করুন।" });
  next();
}
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

app.get("/api/csrf", (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  res.json({ token: req.session.csrfToken });
});

app.get("/api/public/stats", (req, res) => {
  const approved = db.prepare("SELECT COUNT(*) AS count FROM donors WHERE status='approved'").get().count;
  const groups = db.prepare("SELECT blood_group AS grp, COUNT(*) AS count FROM donors WHERE status='approved' GROUP BY blood_group").all();
  res.json({ approvedDonors: approved, groups: groups.map(g => ({ group: g.grp, count: g.count })), serviceArea: "ঢাকা" });
});

app.post("/api/public/donors", publicFormLimiter, requireCsrf, (req, res) => {
  const name = clean(req.body.name, 100);
  const group = clean(req.body.blood_group, 3);
  const phone = phoneBD(req.body.phone);
  const department = clean(req.body.department, 120);
  const district = clean(req.body.district, 80);
  const area = clean(req.body.area, 100);
  const lastDonation = validDate(req.body.last_donation);
  const consent = req.body.consent === true || req.body.consent === "on";
  if (name.length < 2 || !GROUPS.includes(group) || !phone || !district || !consent) {
    return res.status(400).json({ error: "নাম, সঠিক মোবাইল নম্বর (01XXXXXXXXX), রক্তের গ্রুপ, জেলা এবং সম্মতি দিতে হবে।" });
  }
  if (req.body.last_donation && !lastDonation) return res.status(400).json({ error: "শেষ রক্তদানের তারিখ সঠিক নয়।" });
  if (db.prepare("SELECT 1 FROM donors WHERE phone=? AND status IN ('pending','approved')").get(phone)) {
    return res.status(409).json({ error: "এই মোবাইল নম্বর দিয়ে ইতিমধ্যে আবেদন জমা আছে।" });
  }
  const result = db.prepare(`
    INSERT INTO donors (name,blood_group,phone,department,district,area,last_donation,consent)
    VALUES (?,?,?,?,?,?,?,1)
  `).run(name, group, phone, department, district, area, lastDonation);
  res.status(201).json({ message: "আপনার আবেদন জমা হয়েছে। যাচাই শেষে অ্যাডমিন অনুমোদন করলে তালিকায় যুক্ত হবে।", id: result.lastInsertRowid });
});

app.post("/api/public/requests", publicFormLimiter, requireCsrf, (req, res) => {
  const name = clean(req.body.requester_name, 100);
  const phone = phoneBD(req.body.phone);
  const group = clean(req.body.blood_group, 3);
  const units = Number(req.body.units);
  const hospital = clean(req.body.hospital, 160);
  const district = clean(req.body.district, 80);
  const neededAt = clean(req.body.needed_at, 40);
  const details = clean(req.body.details, 1000);
  if (name.length < 2 || !phone || !GROUPS.includes(group) || !Number.isInteger(units) || units < 1 || units > 20 || !hospital || !district || !neededAt) {
    return res.status(400).json({ error: "সব প্রয়োজনীয় তথ্য সঠিকভাবে পূরণ করুন (মোবাইল নম্বর 01XXXXXXXXX ফরম্যাটে)।" });
  }
  const neededTs = Date.parse(neededAt);
  if (Number.isNaN(neededTs) || !isRealDate(neededAt.slice(0, 10))) return res.status(400).json({ error: "প্রয়োজনের সময় সঠিক নয়।" });
  const result = db.prepare(`
    INSERT INTO blood_requests (requester_name,phone,blood_group,units,hospital,district,needed_at,details)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(name, phone, group, units, hospital, district, neededAt, details);
  res.status(201).json({ message: "জরুরি রক্তের আবেদন জমা হয়েছে। ক্লাবের টিম যাচাই করে যোগাযোগ করবে।", id: result.lastInsertRowid });
});

app.post("/api/admin/login", loginLimiter, requireCsrf, asyncRoute(async (req, res) => {
  const username = clean(req.body.username, 80);
  const password = String(req.body.password || "");
  const admin = db.prepare("SELECT id, username, password_hash FROM admins WHERE username=?").get(username);
  const ok = admin && await bcrypt.compare(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: "ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়।" });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "লগইন সম্পন্ন করা যায়নি।" });
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    res.json({ message: "লগইন সফল।", username: admin.username, csrfToken: req.session.csrfToken });
  });
}));

app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ username: req.session.username }));
app.post("/api/admin/logout", requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ message: "লগআউট হয়েছে।" }));
});

app.post("/api/admin/password", requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
  const current = String(req.body.current || "");
  const next = String(req.body.next || "");
  if (next.length < 12) return res.status(400).json({ error: "নতুন পাসওয়ার্ড অন্তত ১২ অক্ষরের হতে হবে।" });
  if (next === current) return res.status(400).json({ error: "নতুন পাসওয়ার্ড পুরোনোটির মতো হতে পারবে না।" });
  const admin = db.prepare("SELECT id, password_hash FROM admins WHERE id=?").get(req.session.adminId);
  if (!admin || !(await bcrypt.compare(current, admin.password_hash))) return res.status(400).json({ error: "বর্তমান পাসওয়ার্ড সঠিক নয়।" });
  db.prepare("UPDATE admins SET password_hash=? WHERE id=?").run(await bcrypt.hash(next, 12), admin.id);
  res.json({ message: "পাসওয়ার্ড সফলভাবে বদলানো হয়েছে।" });
}));

app.get("/api/admin/summary", requireAdmin, (req, res) => {
  const donors = db.prepare("SELECT status, COUNT(*) AS count FROM donors GROUP BY status").all();
  const requests = db.prepare("SELECT status, COUNT(*) AS count FROM blood_requests GROUP BY status").all();
  const groups = db.prepare("SELECT blood_group AS grp, COUNT(*) AS count FROM donors WHERE status='approved' GROUP BY blood_group").all()
    .map(g => ({ group: g.grp, count: g.count }));
  const latest = db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM blood_requests").get().id;
  res.json({ donors, requests, groups, latestRequestId: latest });
});
app.get("/api/admin/donors", requireAdmin, (req, res) => {
  const status = clean(req.query.status, 20);
  const group = clean(req.query.group, 3);
  let sql = "SELECT * FROM donors WHERE 1=1";
  const args = [];
  if (["pending","approved","inactive","rejected"].includes(status)) { sql += " AND status=?"; args.push(status); }
  if (GROUPS.includes(group)) { sql += " AND blood_group=?"; args.push(group); }
  const q = clean(req.query.q, 60);
  if (q) { sql += " AND (name LIKE ? OR phone LIKE ? OR area LIKE ? OR district LIKE ? OR department LIKE ?)"; const like = `%${q.replace(/[%_]/g, "")}%`; args.push(like, like, like, like, like); }
  sql += " ORDER BY created_at DESC, id DESC LIMIT 500";
  res.json(db.prepare(sql).all(...args));
});
app.patch("/api/admin/donors/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const status = clean(req.body.status, 20);
  if (!Number.isInteger(id) || !["pending","approved","inactive","rejected"].includes(status)) return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
  const result = db.prepare("UPDATE donors SET status=? WHERE id=?").run(status, id);
  if (!result.changes) return res.status(404).json({ error: "ডোনার পাওয়া যায়নি।" });
  res.json({ message: "ডোনারের অবস্থা আপডেট হয়েছে।" });
});
app.delete("/api/admin/donors/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
  const result = db.prepare("DELETE FROM donors WHERE id=?").run(id);
  if (!result.changes) return res.status(404).json({ error: "ডোনার পাওয়া যায়নি।" });
  res.json({ message: "ডোনারের তথ্য মুছে ফেলা হয়েছে।" });
});
app.get("/api/admin/requests", requireAdmin, (req, res) => {
  const status = clean(req.query.status, 20);
  if (["pending","contacted","fulfilled","cancelled"].includes(status)) {
    return res.json(db.prepare("SELECT r.*, (SELECT COUNT(*) FROM donors d WHERE d.blood_group=r.blood_group AND d.status IN ('approved','pending')) AS match_count FROM blood_requests r WHERE r.status=? ORDER BY r.created_at DESC, r.id DESC LIMIT 500").all(status));
  }
  res.json(db.prepare("SELECT r.*, (SELECT COUNT(*) FROM donors d WHERE d.blood_group=r.blood_group AND d.status IN ('approved','pending')) AS match_count FROM blood_requests r ORDER BY r.created_at DESC, r.id DESC LIMIT 500").all());
});
app.get("/api/admin/requests/:id/matches", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
  const r = db.prepare("SELECT * FROM blood_requests WHERE id=?").get(id);
  if (!r) return res.status(404).json({ error: "আবেদন পাওয়া যায়নি।" });
  const rows = db.prepare("SELECT * FROM donors WHERE blood_group=? AND status IN ('approved','pending')").all(r.blood_group);
  const now = Date.now();
  const donors = rows.map(d => {
    const days = d.last_donation ? Math.floor((now - Date.parse(d.last_donation + "T00:00:00Z")) / 864e5) : null;
    const eligible = days === null || days >= 90;
    let score = 0;
    if (d.status === "approved") score += 4;
    if (eligible) score += 3;
    if (d.district && r.district && d.district === r.district) score += 2;
    if (d.area && r.hospital && (r.hospital.includes(d.area) || (r.details || "").includes(d.area))) score += 1;
    return { ...d, days_since_donation: days, eligible, score };
  }).sort((a, b) => b.score - a.score || b.id - a.id);
  res.json({ request: r, donors });
});
app.patch("/api/admin/requests/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const status = clean(req.body.status, 20);
  if (!Number.isInteger(id) || !["pending","contacted","fulfilled","cancelled"].includes(status)) return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
  const result = db.prepare("UPDATE blood_requests SET status=? WHERE id=?").run(status, id);
  if (!result.changes) return res.status(404).json({ error: "আবেদন পাওয়া যায়নি।" });
  res.json({ message: "আবেদনের অবস্থা আপডেট হয়েছে।" });
});
app.delete("/api/admin/requests/:id", requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
  const result = db.prepare("DELETE FROM blood_requests WHERE id=?").run(id);
  if (!result.changes) return res.status(404).json({ error: "আবেদন পাওয়া যায়নি।" });
  res.json({ message: "আবেদন মুছে ফেলা হয়েছে।" });
});

app.use("/api", (req, res) => res.status(404).json({ error: "পাওয়া যায়নি।" }));
app.use("/api", (err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "অনুরোধের ফরম্যাট সঠিক নয়।" });
  console.error(err);
  res.status(500).json({ error: "সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।" });
});
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => {
  if (path.extname(req.path)) return res.status(404).type("text/plain").send("Not found");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`GSSBDC running at http://localhost:${PORT}`));
