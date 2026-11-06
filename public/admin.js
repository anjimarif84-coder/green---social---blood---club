"use strict";
let token = "";
let donorCache = [];
const $ = s => document.querySelector(s);
const GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
const donorStatuses = ["pending","approved","inactive","rejected"];
const requestStatuses = ["pending","contacted","fulfilled","cancelled"];
const donorBn = { pending:"অপেক্ষমাণ", approved:"অনুমোদিত", inactive:"নিষ্ক্রিয়", rejected:"বাতিল" };
const requestBn = { pending:"অপেক্ষমাণ", contacted:"যোগাযোগ হয়েছে", fulfilled:"সম্পন্ন", cancelled:"বাতিল" };
const titles = { overview:"ড্যাশবোর্ড", donors:"ডোনার ম্যানেজমেন্ট", requests:"রক্তের আবেদন", settings:"সেটিংস" };
const BN = n => Number(n).toLocaleString("bn-BD");

async function csrf() { token = (await (await fetch("/api/csrf", { credentials: "same-origin" })).json()).token; }
async function api(url, opts = {}) {
  const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };
  if (opts.method && opts.method !== "GET") headers["X-CSRF-Token"] = token;
  const r = await fetch(url, { ...opts, headers, credentials: "same-origin" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && url !== "/api/admin/login" && url !== "/api/admin/me") { location.reload(); }
    throw new Error(d.error || "সমস্যা হয়েছে");
  }
  return d;
}
let toastTimer;
function toast(t, err = false) {
  const el = $("#adminToast");
  el.textContent = t; el.classList.toggle("error", err); el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}
function cell(row, content, label) {
  const td = document.createElement("td");
  if (label) td.dataset.label = label;
  if (content instanceof Node) td.append(content); else td.textContent = content ?? "—";
  row.append(td);
  return td;
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function emptyRow(body, cols, text) {
  const tr = document.createElement("tr"); const td = el("td", "empty", text); td.colSpan = cols; tr.append(td); body.append(tr);
}
function statusSelect(values, labels, current, cb) {
  const s = document.createElement("select");
  s.setAttribute("aria-label", "অবস্থা পরিবর্তন");
  values.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = labels[v]; s.append(o); });
  s.value = current;
  s.addEventListener("change", () => cb(s.value));
  return s;
}
function phoneCell(row, phone) {
  const box = document.createElement("span");
  box.append(document.createTextNode(phone));
  const a = el("a", "", "কল"); a.href = "tel:" + phone; box.append(a);
  cell(row, box, "যোগাযোগ");
}
function fmtDate(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? (v || "—") : d.toLocaleString("bn-BD", { dateStyle: "medium", timeStyle: "short" }); }

function switchView(name, preset) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("#" + name + "View").classList.add("active");
  document.querySelectorAll(".side-link").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $("#pageTitle").textContent = titles[name];
  $("#sidebar").classList.remove("open");
  if (name === "donors") { if (preset !== undefined) $("#donorStatus").value = preset; loadDonors(); }
  if (name === "requests") { if (preset !== undefined) $("#requestStatus").value = preset; loadRequests(); }
  if (name === "overview") loadSummary();
  scrollTo({ top: 0 });
}

async function loadSummary() {
  const d = await api("/api/admin/summary");
  const donor = Object.fromEntries(d.donors.map(x => [x.status, x.count]));
  const req = Object.fromEntries(d.requests.map(x => [x.status, x.count]));
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  const items = [
    ["মোট ডোনার", sum(donor), ""], ["অনুমোদিত ডোনার", donor.approved || 0, ""],
    ["অপেক্ষমাণ ডোনার", donor.pending || 0, "warn"], ["মোট রক্তের আবেদন", sum(req), ""],
    ["অপেক্ষমাণ আবেদন", req.pending || 0, "red"], ["যোগাযোগ হয়েছে", req.contacted || 0, ""],
    ["সম্পন্ন আবেদন", req.fulfilled || 0, ""], ["বাতিল আবেদন", req.cancelled || 0, ""]
  ];
  const holder = $("#metrics"); holder.replaceChildren();
  items.forEach(([label, n, cls]) => {
    const card = el("div", "metric " + cls); card.append(el("span", "", label), el("b", "", BN(n))); holder.append(card);
  });
  const gc = Object.fromEntries((d.groups || []).map(x => [x.group, x.count]));
  const max = Math.max(1, ...GROUPS.map(g => gc[g] || 0));
  const bars = $("#groupBars"); bars.replaceChildren();
  GROUPS.forEach(g => {
    const col = el("div", "bar-col"); const n = gc[g] || 0;
    const track = el("div", "bar-track"); const fill = el("i"); fill.style.height = "0%"; track.append(fill);
    col.append(el("span", "bar-n", BN(n)), track, el("span", "bar-l", g)); bars.append(col);
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.height = Math.max(n ? 8 : 0, Math.round(n / max * 100)) + "%"; }));
  });
  if (lastRequestId === null) lastRequestId = d.latestRequestId;
  loadUrgent();
  setBadge("#badgeDonors", donor.pending || 0);
  setBadge("#badgeRequests", req.pending || 0);
}
async function loadUrgent() {
  const box = $("#urgentList");
  let data;
  try { data = await api("/api/admin/requests?status=pending"); } catch { return; }
  const known = new Set([...box.querySelectorAll("[data-id]")].map(n => n.dataset.id));
  box.replaceChildren();
  if (!data.length) { box.append(el("div", "u-empty", "এই মুহূর্তে কোনো অপেক্ষমাণ জরুরি আবেদন নেই। ✅")); return; }
  data.slice(0, 6).forEach(r => {
    const c = el("div", "u-card" + (known.size && !known.has(String(r.id)) ? " fresh" : "")); c.dataset.id = r.id;
    c.append(el("span", "grp", r.blood_group));
    const info = el("div", "u-info"); info.append(el("b", "", `${r.requester_name} · ${BN(r.units)} ব্যাগ`), el("small", "", `${r.hospital}, ${r.district} · ${fmtDate(r.needed_at)}`));
    const b = el("button", "btn-match", ""); b.append(document.createTextNode("🔎 ডোনার ম্যাচ করুন "), el("small", "", `(${BN(r.match_count || 0)} জন)`));
    b.addEventListener("click", () => openMatch(r.id));
    c.append(info, b); box.append(c);
  });
}
function setBadge(sel, n) { const b = $(sel); b.hidden = !n; b.textContent = BN(n); }

async function loadDonors() {
  const params = new URLSearchParams();
  if ($("#donorStatus").value) params.set("status", $("#donorStatus").value);
  if ($("#donorGroup").value) params.set("group", $("#donorGroup").value);
  if ($("#donorSearch").value.trim()) params.set("q", $("#donorSearch").value.trim());
  const body = $("#donorRows");
  try { donorCache = await api("/api/admin/donors?" + params); } catch (e) { toast(e.message, true); return; }
  body.replaceChildren();
  donorCache.forEach(d => {
    const tr = document.createElement("tr");
    const nm = el("span", "nm", d.name); const who = el("span"); who.append(nm);
    if (d.department) who.append(el("span", "sub", d.department));
    cell(tr, who, "নাম");
    cell(tr, el("span", "grp", d.blood_group), "গ্রুপ");
    phoneCell(tr, d.phone);
    cell(tr, [d.area, d.district].filter(Boolean).join(" · "), "এলাকা");
    cell(tr, d.last_donation || "জানা নেই", "শেষ দান");
    cell(tr, el("span", "tag " + d.status, donorBn[d.status]), "অবস্থা");
    const wrap = el("div", "row-actions");
    wrap.append(statusSelect(donorStatuses, donorBn, d.status, async v => {
      try { await api("/api/admin/donors/" + d.id, { method: "PATCH", body: JSON.stringify({ status: v }) }); toast("ডোনারের অবস্থা আপডেট হয়েছে"); loadSummary(); loadDonors(); }
      catch (e) { toast(e.message, true); loadDonors(); }
    }));
    const del = el("button", "", "মুছুন");
    del.addEventListener("click", async () => {
      if (!confirm(d.name + " — এই ডোনারের তথ্য স্থায়ীভাবে মুছবেন?")) return;
      try { await api("/api/admin/donors/" + d.id, { method: "DELETE" }); toast("ডোনার মুছে ফেলা হয়েছে"); loadDonors(); loadSummary(); }
      catch (e) { toast(e.message, true); }
    });
    wrap.append(del);
    cell(tr, wrap, "অ্যাকশন");
    body.append(tr);
  });
  if (!donorCache.length) emptyRow(body, 7, "কোনো ডোনার পাওয়া যায়নি।");
}

async function loadRequests() {
  const q = $("#requestStatus").value;
  const body = $("#requestRows");
  let data;
  try { data = await api("/api/admin/requests" + (q ? "?status=" + q : "")); } catch (e) { toast(e.message, true); return; }
  body.replaceChildren();
  data.forEach(d => {
    const tr = document.createElement("tr");
    const who = el("span"); who.append(el("span", "nm", d.requester_name));
    if (d.details) who.append(el("span", "sub", d.details.length > 60 ? d.details.slice(0, 60) + "…" : d.details));
    cell(tr, who, "আবেদনকারী");
    const bl = el("span"); bl.append(el("span", "grp", d.blood_group), document.createTextNode(" · " + BN(d.units) + " ব্যাগ"));
    cell(tr, bl, "রক্ত");
    cell(tr, d.hospital + " · " + d.district, "হাসপাতাল");
    cell(tr, fmtDate(d.needed_at), "প্রয়োজনের সময়");
    phoneCell(tr, d.phone);
    cell(tr, el("span", "tag " + d.status, requestBn[d.status]), "অবস্থা");
    const wrap = el("div", "row-actions");
    wrap.append(statusSelect(requestStatuses, requestBn, d.status, async v => {
      try { await api("/api/admin/requests/" + d.id, { method: "PATCH", body: JSON.stringify({ status: v }) }); toast("আবেদনের অবস্থা আপডেট হয়েছে"); loadSummary(); loadRequests(); }
      catch (e) { toast(e.message, true); loadRequests(); }
    }));
    const mt = el("button", "match", "🔎 ডোনার (" + BN(d.match_count || 0) + ")");
    mt.title = "মিলে যাওয়া ডোনার দেখুন ও মেসেজ পাঠান";
    mt.addEventListener("click", () => openMatch(d.id));
    wrap.prepend(mt);
    const del = el("button", "", "মুছুন");
    del.addEventListener("click", async () => {
      if (!confirm("এই আবেদন মুছে ফেলবেন?")) return;
      try { await api("/api/admin/requests/" + d.id, { method: "DELETE" }); toast("আবেদন মুছে ফেলা হয়েছে"); loadRequests(); loadSummary(); }
      catch (e) { toast(e.message, true); }
    });
    wrap.append(del);
    cell(tr, wrap, "অ্যাকশন");
    body.append(tr);
  });
  if (!data.length) emptyRow(body, 7, "কোনো আবেদন নেই।");
}

function exportCsv() {
  if (!donorCache.length) return toast("এক্সপোর্ট করার মতো তথ্য নেই", true);
  const safe = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ["নাম","রক্তের গ্রুপ","ফোন","বিভাগ","জেলা","এলাকা","শেষ দান","অবস্থা","আবেদনের সময়"];
  const rows = donorCache.map(d => [d.name, d.blood_group, d.phone, d.department, d.district, d.area, d.last_donation, donorBn[d.status], d.created_at]);
  const csv = "﻿" + [head, ...rows].map(r => r.map(safe).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "donors-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- জরুরি আবেদন: ম্যাচ ও মেসেজ ---------- */
const waNum = p => "88" + p;                       // 01XXXXXXXXX → 8801XXXXXXXXX
const fmtNeed = v => fmtDate(v);
const GROUP_BN = g => g.replace("AB", "এবি ").replace(/^A/, "এ ").replace(/^B/, "বি ").replace(/^O/, "ও ").replace(/\s+([+-])/, " $1").trim();
function dayPeriod(h) { return h >= 4 && h < 12 ? "সকাল" : h < 15 ? "দুপুর" : h < 18 ? "বিকাল" : h < 20 ? "সন্ধ্যা" : "রাত"; }
function needParts(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { date: v || "—", time: "—" };
  const h12 = d.getHours() % 12 || 12;
  return {
    date: d.toLocaleDateString("bn-BD", { day: "numeric", month: "long" }),
    time: `${dayPeriod(d.getHours())} ${BN(h12)}:${String(d.getMinutes()).padStart(2, "0").replace(/\d/g, x => BN(x))}`
  };
}
function donorMsg(d, r) {
  const n = needParts(r.needed_at);
  return `আসসালামু আলাইকুম ${d.name}। জরুরি রক্তের প্রয়োজন, দয়া করে সহযোগিতা করুন।

🔵রোগীর সমস্যাঃ ${r.details || "—"}
🔵রক্তের গ্রুপঃ ${GROUP_BN(r.blood_group)}
🔵রক্তের পরিমাণঃ ${BN(r.units)} ব্যাগ
🔵রক্তদানের তারিখঃ ${n.date}
🔵রক্তদানের সময়ঃ ${n.time}
🔵রক্তদানের স্থানঃ ${r.hospital}, ${r.district}
🔵যোগাযোগঃ ${r.phone} (${r.requester_name})

আপনি কি রক্ত দিতে পারবেন? অনুগ্রহ করে দ্রুত জানান। ধন্যবাদ। — গ্রিন সোশ্যাল ব্লাড ডোনেশন ক্লাব`;
}
function requesterMsg(r, d) {
  return `আসসালামু আলাইকুম ${r.requester_name}। গ্রিন সোশ্যাল ব্লাড ডোনেশন ক্লাব থেকে বলছি। আপনার ${r.blood_group} রক্তের আবেদনের জন্য একজন ডোনারকে জানানো হয়েছে${d ? "" : " (ডোনার খোঁজা হচ্ছে)"}। ডোনার সম্মত হলে আমরা আপনাকে জানাব বা তিনি সরাসরি যোগাযোগ করবেন। এর মধ্যে ${r.hospital}-এর ব্লাড ব্যাংকেও যোগাযোগ রাখুন।`;
}
function msgButtons(phone, text) {
  const box = el("div", "mbtns");
  const wa = el("a", "mbtn wa", "WhatsApp"); wa.href = `https://wa.me/${waNum(phone)}?text=${encodeURIComponent(text)}`; wa.target = "_blank"; wa.rel = "noopener noreferrer";
  const sms = el("a", "mbtn sms", "SMS"); sms.href = `sms:${phone}?body=${encodeURIComponent(text)}`;
  const call = el("a", "mbtn call", "📞 কল"); call.href = "tel:" + phone;
  const cp = el("button", "mbtn", "কপি");
  cp.type = "button";
  cp.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); toast("মেসেজ কপি হয়েছে"); } catch { prompt("মেসেজ কপি করুন:", text); } });
  box.append(wa, sms, call, cp);
  return box;
}
let currentMatch = null;
async function openMatch(id) {
  let data;
  try { data = await api(`/api/admin/requests/${id}/matches`); } catch (e) { toast(e.message, true); return; }
  currentMatch = data.request;
  const r = data.request;
  $("#mdTitle").textContent = `${r.blood_group} রক্ত — ${BN(r.units)} ব্যাগ`;
  $("#mdSub").textContent = `${r.hospital}, ${r.district} · ${fmtNeed(r.needed_at)}`;
  const rb = $("#mdRequester"); rb.replaceChildren();
  const who = el("div", "who"); who.append(el("b", "", "আবেদনকারী: " + r.requester_name), el("span", "", r.phone));
  rb.append(who, msgButtons(r.phone, requesterMsg(r, data.donors.length > 0)));
  $("#mdCount").textContent = `(${BN(data.donors.length)} জন)`;
  const list = $("#mdDonors"); list.replaceChildren();
  if (!data.donors.length) list.append(el("div", "md-empty", `${r.blood_group} গ্রুপের কোনো ডোনার অনুমোদিত/অপেক্ষমাণ তালিকায় নেই। আবেদনকারীকে হাসপাতালের ব্লাড ব্যাংকে যোগাযোগ করতে বলুন।`));
  data.donors.forEach((d, i) => {
    const card = el("div", "md-d" + (i === 0 ? " best" : ""));
    const top = el("div", "top");
    top.append(el("span", "grp", d.blood_group), el("b", "", d.name),
      el("span", "chip " + (d.status === "approved" ? "ok" : "warn"), donorBn[d.status]));
    if (d.district === r.district) top.append(el("span", "chip same", "একই জেলা"));
    top.append(el("span", "chip " + (d.eligible ? "ok" : "warn"), d.days_since_donation === null ? "শেষ দান: জানা নেই" : d.eligible ? `শেষ দান ${BN(d.days_since_donation)} দিন আগে` : `মাত্র ${BN(d.days_since_donation)} দিন আগে দিয়েছেন`));
    const meta = el("div", "meta", [d.area, d.district, d.department].filter(Boolean).join(" · ") + " · " + d.phone);
    card.append(top, meta);
    card.append(msgButtons(d.phone, donorMsg(d, r)));
    list.append(card);
  });
  $("#matchDialog").showModal();
}

/* ---------- নতুন আবেদনের নোটিফিকেশন ---------- */
let lastRequestId = null, notifyOn = false, audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175, 880].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = "sine"; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * .22;
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.25, t + .03); g.gain.exponentialRampToValueAtTime(.0001, t + .2);
      o.start(t); o.stop(t + .22);
    });
  } catch {}
}
function setBell(on) {
  notifyOn = on;
  $("#bell").classList.toggle("on", on);
  $("#bellState").textContent = on ? "চালু" : "বন্ধ";
  try { localStorage.setItem("gssNotify", on ? "1" : "0"); } catch {}
}
async function toggleBell() {
  if (notifyOn) { setBell(false); return; }
  setBell(true); beep();
  if ("Notification" in window && Notification.permission === "default") { try { await Notification.requestPermission(); } catch {} }
  toast("নতুন জরুরি আবেদন এলে শব্দ ও নোটিফিকেশন পাবেন (এই পেজ খোলা থাকলে)");
}
function announceNew(count) {
  $("#bell").classList.remove("ring"); void $("#bell").offsetWidth; $("#bell").classList.add("ring");
  toast(`🚨 নতুন জরুরি রক্তের আবেদন এসেছে (${BN(count)}টি)`);
  document.title = "🚨 নতুন আবেদন · Admin";
  if (notifyOn) {
    beep();
    if ("Notification" in window && Notification.permission === "granted") {
      try { new Notification("জরুরি রক্তের নতুন আবেদন", { body: "অ্যাডমিন প্যানেলে ডোনার ম্যাচ করুন।" }); } catch {}
    }
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "Admin · Green Social Services"; });
async function pollNew() {
  if ($("#appView").hidden) return;
  try {
    const d = await api("/api/admin/summary");
    if (lastRequestId !== null && d.latestRequestId > lastRequestId) {
      announceNew(1);
      await refreshAfterSummary(d);
    }
    lastRequestId = d.latestRequestId;
  } catch {}
}
async function refreshAfterSummary() {
  await loadSummary();
  if ($("#requestsView").classList.contains("active")) loadRequests();
}

async function enterApp(username) {
  $("#loginView").hidden = true; $("#appView").hidden = false;
  $("#adminName").textContent = username; $("#welcomeName").textContent = username;
  $("#avatar").textContent = username.slice(0, 1);
  switchView("overview");
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

document.addEventListener("DOMContentLoaded", async () => {
  try { await csrf(); } catch {}
  GROUPS.forEach(g => { const o = document.createElement("option"); o.value = g; o.textContent = g; $("#donorGroup").append(o); });
  document.querySelectorAll(".side-link").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => switchView(b.dataset.go, b.dataset.status)));
  $("#hamb").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#sideBackdrop").addEventListener("click", () => $("#sidebar").classList.remove("open"));
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("#sidebar").classList.remove("open"); });
  $("#refreshDonors").addEventListener("click", loadDonors);
  $("#refreshRequests").addEventListener("click", loadRequests);
  $("#exportDonors").addEventListener("click", exportCsv);
  $("#donorStatus").addEventListener("change", loadDonors);
  $("#donorGroup").addEventListener("change", loadDonors);
  $("#requestStatus").addEventListener("change", loadRequests);
  $("#donorSearch").addEventListener("input", debounce(loadDonors, 300));
  document.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", () => {
    const i = $(b.dataset.toggle); i.type = i.type === "password" ? "text" : "password";
  }));

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, b = f.querySelector(".primary"), m = $("#loginMessage");
    b.disabled = true; m.textContent = "";
    try {
      if (!token) await csrf();
      const payload = JSON.stringify(Object.fromEntries(new FormData(f)));
      let d;
      try { d = await api("/api/admin/login", { method: "POST", body: payload }); }
      catch (err) {
        if (!/নিরাপত্তা যাচাই/.test(err.message)) throw err;   // সেশন/CSRF পুরোনো হলে নতুন টোকেন নিয়ে একবার আবার চেষ্টা
        await csrf();
        d = await api("/api/admin/login", { method: "POST", body: payload });
      }
      token = d.csrfToken; f.reset(); await enterApp(d.username);
    } catch (err) { m.textContent = err.message; }
    finally { b.disabled = false; }
  });
  $("#logoutBtn").addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST", body: "{}" }); } catch {}
    location.reload();
  });
  $("#pwForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = e.target, m = $("#pwMessage"), v = Object.fromEntries(new FormData(f));
    m.className = "message";
    if (v.next !== v.again) { m.textContent = "নতুন পাসওয়ার্ড দুটি মিলছে না।"; return; }
    try {
      const d = await api("/api/admin/password", { method: "POST", body: JSON.stringify({ current: v.current, next: v.next }) });
      m.className = "message ok"; m.textContent = d.message; f.reset(); toast(d.message);
    } catch (err) { m.textContent = err.message; }
  });

  $("#bell").addEventListener("click", toggleBell);
  $("#mdClose").addEventListener("click", () => $("#matchDialog").close());
  $("#matchDialog").addEventListener("click", e => { if (e.target.id === "matchDialog") e.target.close(); });
  $("#mdMark").addEventListener("click", async () => {
    if (!currentMatch) return;
    try { await api("/api/admin/requests/" + currentMatch.id, { method: "PATCH", body: JSON.stringify({ status: "contacted" }) }); toast("আবেদন 'যোগাযোগ হয়েছে' চিহ্নিত হলো"); $("#matchDialog").close(); loadSummary(); if ($("#requestsView").classList.contains("active")) loadRequests(); }
    catch (e) { toast(e.message, true); }
  });
  try { if (localStorage.getItem("gssNotify") === "1") setBell(true); } catch {}
  setInterval(pollNew, 15000);
  try { const me = await api("/api/admin/me"); await enterApp(me.username); }
  catch { $("#loginView").hidden = false; $("#appView").hidden = true; }
});
