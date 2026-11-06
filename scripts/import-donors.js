// ব্যবহার:
//   node scripts/import-donors.js --dry        (কিছু না লিখে শুধু যাচাই)
//   node scripts/import-donors.js              (ডোনার "অপেক্ষমাণ" হিসেবে যোগ হবে)
//   node scripts/import-donors.js --approve    (সরাসরি "অনুমোদিত" হিসেবে যোগ হবে)
// সার্ভার বন্ধ রেখে চালানো ভালো। একই ফোন নম্বর আগে থেকে থাকলে বাদ যাবে।
const fs = require("fs");
const path = require("path");

const RAW = `
A- Negative 01933892321
A- Negative 01844464155
A- Negative 01676335830
A- Negative 01883586717
A+ 01706926694
A+ 01689223789
A+ 01703268335
A+ 01875024194
A+ 01710376348
A+ 01928275633
A+ 01890372558
A+ 01911303620
A+ 01910902996
A+ 01995362098
A+ 01715323084
A+ 01701833905
A+ 01877793861
A+ 01937906789
AB- Negative 01913545498
AB+  01626804795
AB+ 01925582350
AB+ 01790059606
AB+ 01558448484
AB+ 01919888277
AB+ 01770412286
AB+ 01925582350
Ab+ 01792208551
Ab+ 01863181279
AB+ 01626804795
B- Negative 01870435259
B- Negative 01722414689
B+ 01967507147
B+ 0130479265
B+ 01748446523
B+ 01949315386
B+ 01703778563
B+ 01712258706
O- Negative 01643105457
O- Negative 01406310948
O+ 01302900057
O+ 01634189232
O+ 01714501929
O+ 01571024605
O+ 01736582765
O+ 01812765772
O+ 01765606433
O+ 01521467763
O+ 01626822146
O+ 01841008718
O+ 01715826941
O+ 01834878727
O+ 01920869955
O+ 01921798307
O+ 01755700448
O+ 01300334793
O+ 01316916262
O+ 01940594244
`;

const DISTRICT = "ঢাকা";
const NAME = "নাম অজানা";          // তালিকায় নাম ছিল না — অ্যাডমিন যোগাযোগ করে পরে নাম আপডেট করবে

function parse(raw) {
  const ok = [], bad = [], dup = [], seen = new Set();
  for (const line of raw.split("\n").map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^(ab|a|b|o)\s*([+-]|positive|negative)?\s*(?:negative|positive)?\s+(\d+)$/i);
    if (!m) { bad.push([line, "ফরম্যাট বোঝা যায়নি"]); continue; }
    let g = m[1].toUpperCase();
    const neg = /negative/i.test(line) || m[2] === "-";
    g += neg ? "-" : "+";
    const phone = m[3];
    if (!/^01[3-9]\d{8}$/.test(phone)) { bad.push([line, "ফোন নম্বর সঠিক নয় (১১ ডিজিট হতে হবে)"]); continue; }
    if (seen.has(phone)) { dup.push([line, "তালিকায় দুইবার আছে"]); continue; }
    seen.add(phone); ok.push({ group: g, phone });
  }
  return { ok, bad, dup };
}

const { ok, bad, dup } = parse(RAW);
console.log(`যাচাই শেষ: ${ok.length} জন ঠিক, ${dup.length} টি ডুপ্লিকেট, ${bad.length} টি বাদ।`);
bad.concat(dup).forEach(([l, why]) => console.log(`  বাদ: "${l}" — ${why}`));
if (process.argv.includes("--dry")) {
  const c = {}; ok.forEach(d => c[d.group] = (c[d.group] || 0) + 1);
  console.log("গ্রুপ অনুযায়ী:", c);
  process.exit(0);
}

require("dotenv").config();
const Database = require("better-sqlite3");
const status = process.argv.includes("--approve") ? "approved" : "pending";
const dbFile = path.resolve(process.env.DATABASE_FILE || "./data/club.sqlite");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS donors (
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
)`);
const exists = db.prepare("SELECT 1 FROM donors WHERE phone=? AND status IN ('pending','approved')");
const insert = db.prepare("INSERT INTO donors (name,blood_group,phone,department,district,area,last_donation,consent,status) VALUES (?,?,?,?,?,?,NULL,0,?)");
let added = 0, skipped = 0;
db.transaction(() => {
  for (const d of ok) {
    if (exists.get(d.phone)) { skipped++; continue; }
    insert.run(NAME, d.group, d.phone, "Imported list", DISTRICT, "", status);
    added++;
  }
})();
db.close();
console.log(`যোগ হয়েছে: ${added} জন (${status}), আগে থেকেই ছিল তাই বাদ: ${skipped} জন।`);
