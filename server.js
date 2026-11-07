require("dotenv").config();

const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

if (SESSION_SECRET.length < 32 || SESSION_SECRET.startsWith("replace-with")) {
  console.error("Set a real SESSION_SECRET in .env.");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing in .env.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("neon.tech")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on("error", err => console.error("Database pool error:", err.message));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS donors (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      blood_group TEXT NOT NULL CHECK (
        blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')
      ),
      phone TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '',
      district TEXT NOT NULL,
      area TEXT NOT NULL DEFAULT '',
      last_donation DATE,
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending','approved','inactive','rejected')
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS donors_phone_idx ON donors(phone);
    CREATE INDEX IF NOT EXISTS donors_status_idx ON donors(status);

    CREATE TABLE IF NOT EXISTS blood_requests (
      id BIGSERIAL PRIMARY KEY,
      requester_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      blood_group TEXT NOT NULL CHECK (
        blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')
      ),
      units INTEGER NOT NULL CHECK (units BETWEEN 1 AND 20),
      hospital TEXT NOT NULL,
      district TEXT NOT NULL,
      needed_at TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending','contacted','fulfilled','cancelled')
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire BIGINT NOT NULL
    );
  `);

  const username = (process.env.ADMIN_USERNAME || "").trim();
  const password = process.env.ADMIN_PASSWORD || "";

  if (username && password.length >= 12 &&
      password !== "change-this-password-now") {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM admins"
    );

    if (result.rows[0].count === 0) {
      await pool.query(
        "INSERT INTO admins (username,password_hash) VALUES ($1,$2)",
        [username, await bcrypt.hash(password, 12)]
      );
      console.log("Initial admin account created:", username);
    }
  }
}

class PostgresStore extends session.Store {
  get(sid, callback) {
    pool.query(
      "SELECT sess FROM sessions WHERE sid=$1 AND expire>$2",
      [sid, Date.now()]
    ).then(result => {
      callback(null, result.rows[0] ? JSON.parse(result.rows[0].sess) : null);
    }).catch(callback);
  }

  set(sid, sess, callback) {
    const expire = sess.cookie && sess.cookie.expire
      ? new Date(sess.cookie.expire).getTime()
      : Date.now() + 4 * 60 * 60 * 1000;

    pool.query(`
      INSERT INTO sessions (sid,sess,expire)
      VALUES ($1,$2,$3)
      ON CONFLICT (sid)
      DO UPDATE SET sess=EXCLUDED.sess, expire=EXCLUDED.expire
    `, [sid, JSON.stringify(sess), expire])
      .then(() => callback && callback(null))
      .catch(err => callback && callback(err));
  }

  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }

  destroy(sid, callback) {
    pool.query("DELETE FROM sessions WHERE sid=$1", [sid])
      .then(() => callback && callback(null))
      .catch(err => callback && callback(err));
  }
}

setInterval(() => {
  pool.query("DELETE FROM sessions WHERE expire<$1", [Date.now()])
    .catch(err => console.error("Session cleanup error:", err.message));
}, 60 * 60 * 1000).unref();

const GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];

function clean(value, max = 160) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";

function phoneBD(value) {
  let phone = String(value ?? "")
    .replace(/[০-৯]/g, d => BN_DIGITS.indexOf(d))
    .replace(/[^\d+]/g, "");

  if (phone.startsWith("+880")) phone = "0" + phone.slice(4);
  if (/^8801\d{9}$/.test(phone)) phone = "0" + phone.slice(3);

  return /^01[3-9]\d{8}$/.test(phone) ? phone : null;
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + "T00:00:00Z");
  return !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validDate(value) {
  if (!value) return null;
  const date = String(value);
  if (!isRealDate(date)) return null;

  const timestamp = Date.parse(date + "T00:00:00Z");
  return timestamp <= Date.now() + 86400000 &&
    timestamp > Date.parse("1990-01-01T00:00:00Z")
    ? date : null;
}

function requireCsrf(req, res, next) {
  const token = req.get("x-csrf-token");

  if (!token || !req.session.csrfToken ||
      token !== req.session.csrfToken) {
    return res.status(403).json({
      error: "Security check failed. Refresh the page and try again."
    });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: "Admin login required." });
  }
  next();
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.disable("x-powered-by");

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

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
  store: new PostgresStore(),
  name: "gssbdc.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 4 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many submissions. Try again later." }
});

app.get("/healthz", (req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/api/csrf", (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.json({ token: req.session.csrfToken });
});

app.get("/api/public/stats", asyncRoute(async (req, res) => {
  const approved = await pool.query(
    "SELECT COUNT(*)::int AS count FROM donors WHERE status='approved'"
  );

  const groups = await pool.query(`
    SELECT blood_group AS grp, COUNT(*)::int AS count
    FROM donors
    WHERE status='approved'
    GROUP BY blood_group
  `);

  res.json({
    approvedDonors: approved.rows[0].count,
    groups: groups.rows.map(g => ({
      group: g.grp,
      count: g.count
    })),
    serviceArea: "ঢাকা"
  });
}));

app.post("/api/public/donors", publicFormLimiter, requireCsrf,
  asyncRoute(async (req, res) => {
    const name = clean(req.body.name, 100);
    const group = clean(req.body.blood_group, 3);
    const phone = phoneBD(req.body.phone);
    const department = clean(req.body.department, 120);
    const district = clean(req.body.district, 80);
    const area = clean(req.body.area, 100);
    const lastDonation = validDate(req.body.last_donation);
    const consent = req.body.consent === true || req.body.consent === "on";

    if (name.length < 2 || !GROUPS.includes(group) ||
        !phone || !district || !consent) {
      return res.status(400).json({
        error: "নাম, সঠিক মোবাইল নম্বর, রক্তের গ্রুপ, জেলা ও সম্মতি দিতে হবে।"
      });
    }

    if (req.body.last_donation && !lastDonation) {
      return res.status(400).json({ error: "শেষ রক্তদানের তারিখ সঠিক নয়।" });
    }

    const exists = await pool.query(`
      SELECT 1 FROM donors
      WHERE phone=$1 AND status IN ('pending','approved')
    `, [phone]);

    if (exists.rowCount) {
      return res.status(409).json({
        error: "এই মোবাইল নম্বর দিয়ে ইতিমধ্যে আবেদন জমা আছে।"
      });
    }

    const result = await pool.query(`
      INSERT INTO donors
      (name,blood_group,phone,department,district,area,last_donation,consent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
      RETURNING id
    `, [name, group, phone, department, district, area, lastDonation]);

    res.status(201).json({
      message: "আপনার আবেদন জমা হয়েছে। যাচাই শেষে তালিকায় যুক্ত হবে।",
      id: result.rows[0].id
    });
  })
);

app.post("/api/public/requests", publicFormLimiter, requireCsrf,
  asyncRoute(async (req, res) => {
    const name = clean(req.body.requester_name, 100);
    const phone = phoneBD(req.body.phone);
    const group = clean(req.body.blood_group, 3);
    const units = Number(req.body.units);
    const hospital = clean(req.body.hospital, 160);
    const district = clean(req.body.district, 80);
    const neededAt = clean(req.body.needed_at, 40);
    const details = clean(req.body.details, 1000);

    if (name.length < 2 || !phone || !GROUPS.includes(group) ||
        !Number.isInteger(units) || units < 1 || units > 20 ||
        !hospital || !district || !neededAt) {
      return res.status(400).json({
        error: "সব প্রয়োজনীয় তথ্য সঠিকভাবে পূরণ করুন।"
      });
    }

    const neededTs = Date.parse(neededAt);

    if (Number.isNaN(neededTs) ||
        !isRealDate(neededAt.slice(0, 10))) {
      return res.status(400).json({
        error: "প্রয়োজনের সময় সঠিক নয়।"
      });
    }

    const result = await pool.query(`
      INSERT INTO blood_requests
      (requester_name,phone,blood_group,units,hospital,district,needed_at,details)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [name, phone, group, units, hospital, district, neededAt, details]);

    res.status(201).json({
      message: "জরুরি রক্তের আবেদন জমা হয়েছে।",
      id: result.rows[0].id
    });
  })
);

app.post("/api/admin/login", loginLimiter, requireCsrf,
  asyncRoute(async (req, res) => {
    const username = clean(req.body.username, 80);
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT id,username,password_hash FROM admins WHERE username=$1",
      [username]
    );

    const admin = result.rows[0];
    const ok = admin && await bcrypt.compare(password, admin.password_hash);

    if (!ok) {
      return res.status(401).json({
        error: "ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়।"
      });
    }

    req.session.regenerate(err => {
      if (err) {
        return res.status(500).json({ error: "লগইন সম্পন্ন করা যায়নি।" });
      }

      req.session.adminId = admin.id;
      req.session.username = admin.username;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");

      res.json({
        message: "লগইন সফল।",
        username: admin.username,
        csrfToken: req.session.csrfToken
      });
    });
  })
);

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ username: req.session.username });
});

app.post("/api/admin/logout", requireAdmin, requireCsrf, (req, res) => {
  req.session.destroy(() => {
    res.json({ message: "লগআউট হয়েছে।" });
  });
});

app.post("/api/admin/password", requireAdmin, requireCsrf,
  asyncRoute(async (req, res) => {
    const current = String(req.body.current || "");
    const next = String(req.body.next || "");

    if (next.length < 12) {
      return res.status(400).json({
        error: "নতুন পাসওয়ার্ড অন্তত ১২ অক্ষরের হতে হবে।"
      });
    }

    if (next === current) {
      return res.status(400).json({
        error: "নতুন পাসওয়ার্ড আগেরটির মতো হতে পারবে না।"
      });
    }

    const result = await pool.query(
      "SELECT id,password_hash FROM admins WHERE id=$1",
      [req.session.adminId]
    );

    const admin = result.rows[0];

    if (!admin || !(await bcrypt.compare(current, admin.password_hash))) {
      return res.status(400).json({
        error: "বর্তমান পাসওয়ার্ড সঠিক নয়।"
      });
    }

    await pool.query(
      "UPDATE admins SET password_hash=$1 WHERE id=$2",
      [await bcrypt.hash(next, 12), admin.id]
    );

    res.json({ message: "পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে।" });
  })
);

app.get("/api/admin/summary", requireAdmin, asyncRoute(async (req, res) => {
  const donors = await pool.query(`
    SELECT status, COUNT(*)::int AS count
    FROM donors GROUP BY status
  `);

  const requests = await pool.query(`
    SELECT status, COUNT(*)::int AS count
    FROM blood_requests GROUP BY status
  `);

  const groups = await pool.query(`
    SELECT blood_group AS grp, COUNT(*)::int AS count
    FROM donors WHERE status='approved'
    GROUP BY blood_group
  `);

  const latest = await pool.query(
    "SELECT COALESCE(MAX(id),0)::int AS id FROM blood_requests"
  );

  res.json({
    donors: donors.rows,
    requests: requests.rows,
    groups: groups.rows.map(g => ({
      group: g.grp,
      count: g.count
    })),
    latestRequestId: latest.rows[0].id
  });
}));

app.get("/api/admin/donors", requireAdmin, asyncRoute(async (req, res) => {
  const status = clean(req.query.status, 20);
  const group = clean(req.query.group, 3);
  const q = clean(req.query.q, 60);

  let sql = "SELECT * FROM donors WHERE 1=1";
  const args = [];

  if (["pending","approved","inactive","rejected"].includes(status)) {
    args.push(status);
    sql += ` AND status=$${args.length}`;
  }

  if (GROUPS.includes(group)) {
    args.push(group);
    sql += ` AND blood_group=$${args.length}`;
  }

  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    args.push(like);
    const n = args.length;
    sql += ` AND (name ILIKE $${n} OR phone ILIKE $${n} OR area ILIKE $${n} OR district ILIKE $${n} OR department ILIKE $${n})`;
  }

  sql += " ORDER BY created_at DESC, id DESC LIMIT 500";

  const result = await pool.query(sql, args);
  res.json(result.rows);
}));

app.patch("/api/admin/donors/:id", requireAdmin, requireCsrf,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const status = clean(req.body.status, 20);

    if (!Number.isInteger(id) ||
        !["pending","approved","inactive","rejected"].includes(status)) {
      return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
    }

    const result = await pool.query(
      "UPDATE donors SET status=$1 WHERE id=$2",
      [status, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "ডোনার পাওয়া যায়নি।" });
    }

    res.json({ message: "ডোনারের অবস্থা আপডেট হয়েছে।" });
  })
);

app.delete("/api/admin/donors/:id", requireAdmin, requireCsrf,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
    }

    const result = await pool.query(
      "DELETE FROM donors WHERE id=$1",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "ডোনার পাওয়া যায়নি।" });
    }

    res.json({ message: "ডোনারের তথ্য মুছে ফেলা হয়েছে।" });
  })
);

app.get("/api/admin/requests", requireAdmin,
  asyncRoute(async (req, res) => {
    const status = clean(req.query.status, 20);

    let sql = `
      SELECT r.*,
      (SELECT COUNT(*)::int FROM donors d
       WHERE d.blood_group=r.blood_group
       AND d.status IN ('approved','pending')) AS match_count
      FROM blood_requests r
    `;

    const args = [];

    if (["pending","contacted","fulfilled","cancelled"].includes(status)) {
      args.push(status);
      sql += ` WHERE r.status=$1`;
    }

    sql += " ORDER BY r.created_at DESC, r.id DESC LIMIT 500";

    const result = await pool.query(sql, args);
    res.json(result.rows);
  })
);

app.get("/api/admin/requests/:id/matches", requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
    }

    const requestResult = await pool.query(
      "SELECT * FROM blood_requests WHERE id=$1",
      [id]
    );

    const request = requestResult.rows[0];

    if (!request) {
      return res.status(404).json({ error: "আবেদন পাওয়া যায়নি।" });
    }

    const donorResult = await pool.query(
      "SELECT * FROM donors WHERE blood_group=$1 AND status IN ('approved','pending')",
      [request.blood_group]
    );

    const now = Date.now();

    const donors = donorResult.rows.map(d => {
      const days = d.last_donation
        ? Math.floor((now - Date.parse(String(d.last_donation).slice(0, 10) + "T00:00:00Z")) / 864e5)
        : null;

      const eligible = days === null || days >= 90;
      let score = 0;

      if (d.status === "approved") score += 4;
      if (eligible) score += 3;
      if (d.district && request.district &&
          d.district === request.district) score += 2;
      if (d.area && request.hospital &&
          (request.hospital.includes(d.area) ||
           (request.details || "").includes(d.area))) score += 1;

      return {
        ...d,
        days_since_donation: days,
        eligible,
        score
      };
    }).sort((a, b) => b.score - a.score || b.id - a.id);

    res.json({ request, donors });
  })
);

app.patch("/api/admin/requests/:id", requireAdmin, requireCsrf,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const status = clean(req.body.status, 20);

    if (!Number.isInteger(id) ||
        !["pending","contacted","fulfilled","cancelled"].includes(status)) {
      return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
    }

    const result = await pool.query(
      "UPDATE blood_requests SET status=$1 WHERE id=$2",
      [status, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "আবেদন পাওয়া যায়নি।" });
    }

    res.json({ message: "আবেদনের অবস্থা আপডেট হয়েছে।" });
  })
);

app.delete("/api/admin/requests/:id", requireAdmin, requireCsrf,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "তথ্য সঠিক নয়।" });
    }

    const result = await pool.query(
      "DELETE FROM blood_requests WHERE id=$1",
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "আবেদন পাওয়া যায়নি।" });
    }

    res.json({ message: "আবেদন মুছে ফেলা হয়েছে।" });
  })
);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "পাওয়া যায়নি।" });
});

app.use("/api", (err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "অনুরোধের ফরম্যাট সঠিক নয়।" });
  }

  console.error(err);
  res.status(500).json({
    error: "সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।"
  });
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("*", (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type("text/plain").send("Not found");
  }

  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  try {
    await initDatabase();
    await pool.query("SELECT 1");
    app.listen(PORT, () => {
      console.log(`GSSBDC running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Database startup failed:", err.message);
    process.exit(1);
  }
}

start();