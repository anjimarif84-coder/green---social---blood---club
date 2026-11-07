require("dotenv").config();

const Database = require("better-sqlite3");
const { Pool } = require("pg");
const path = require("path");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL পাওয়া যায়নি। .env পরীক্ষা করুন।");
  process.exit(1);
}

const sqlitePath = path.resolve("./data/club.sqlite");
const sqlite = new Database(sqlitePath, { readonly: true });

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("neon.tech")
    ? { rejectUnauthorized: false }
    : undefined
});

async function migrate() {
  const client = await pool.connect();

  try {
    // প্রথমে Neon-এ প্রয়োজনীয় টেবিল তৈরি
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS donors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        blood_group TEXT NOT NULL,
        phone TEXT NOT NULL,
        department TEXT DEFAULT '',
        district TEXT NOT NULL,
        area TEXT DEFAULT '',
        last_donation DATE,
        consent BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS blood_requests (
        id SERIAL PRIMARY KEY,
        requester_name TEXT NOT NULL,
        phone TEXT NOT NULL,
        blood_group TEXT NOT NULL,
        units INTEGER NOT NULL,
        hospital TEXT NOT NULL,
        district TEXT NOT NULL,
        needed_at TIMESTAMPTZ,
        details TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS donors_status_idx
        ON donors(status);

      CREATE INDEX IF NOT EXISTS donors_blood_group_idx
        ON donors(blood_group);
    `);

    console.log("Neon-এ টেবিল তৈরি হয়েছে।");

    await client.query("BEGIN");

    const admins = sqlite.prepare("SELECT * FROM admins").all();
    const donors = sqlite.prepare("SELECT * FROM donors").all();
    const requests = sqlite.prepare("SELECT * FROM blood_requests").all();

    console.log(`অ্যাডমিন: ${admins.length}`);
    console.log(`ডোনার: ${donors.length}`);
    console.log(`রক্তের আবেদন: ${requests.length}`);

    for (const a of admins) {
      await client.query(`
        INSERT INTO admins (id, username, password_hash, created_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO NOTHING
      `, [a.id, a.username, a.password_hash, a.created_at]);
    }

    for (const d of donors) {
      await client.query(`
        INSERT INTO donors (
          id, name, blood_group, phone, department, district,
          area, last_donation, consent, status, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING
      `, [
        d.id,
        d.name,
        d.blood_group,
        d.phone,
        d.department || "",
        d.district,
        d.area || "",
        d.last_donation || null,
        Boolean(d.consent),
        d.status,
        d.created_at
      ]);
    }

    for (const r of requests) {
      await client.query(`
        INSERT INTO blood_requests (
          id, requester_name, phone, blood_group, units,
          hospital, district, needed_at, details, status, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING
      `, [
        r.id,
        r.requester_name,
        r.phone,
        r.blood_group,
        r.units,
        r.hospital,
        r.district,
        r.needed_at,
        r.details || "",
        r.status,
        r.created_at
      ]);
    }

    for (const table of ["admins", "donors", "blood_requests"]) {
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('${table}', 'id'),
          COALESCE((SELECT MAX(id) FROM ${table}), 1),
          EXISTS(SELECT 1 FROM ${table})
        )
      `);
    }

    await client.query("COMMIT");

    console.log("স্থানান্তর সফলভাবে সম্পন্ন হয়েছে!");
    console.log("SQLite ডেটাবেস অপরিবর্তিত আছে।");

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("স্থানান্তর ব্যর্থ:", error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

migrate();