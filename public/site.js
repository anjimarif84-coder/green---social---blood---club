"use strict";
const GROUPS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
const BN = n => Number(n).toLocaleString("bn-BD");
let csrfToken = "";
const $ = s => document.querySelector(s);
document.documentElement.classList.add("js");

async function getCsrf() {
  const r = await fetch("/api/csrf", { credentials: "same-origin" });
  csrfToken = (await r.json()).token;
}
async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  const r = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || "অনুরোধ সম্পন্ন হয়নি।");
    err.status = r.status;
    throw err;
  }
  return data;
}
let toastTimer;
function toast(text, error = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}
function showMessage(target, message, error = false) {
  target.textContent = message;
  target.classList.toggle("error", error);
}
function fillGroups() {
  document.querySelectorAll('select[name="blood_group"]').forEach(select => {
    GROUPS.forEach(g => {
      const o = document.createElement("option");
      o.value = g; o.textContent = g; select.append(o);
    });
  });
}
function fillDatalists() {
  const P = window.PLACES; if (!P) return;
  [["#hospitalList", P.hospitals], ["#areaList", P.areas], ["#districtList", P.districts]].forEach(([sel, items]) => {
    const dl = $(sel); items.forEach(v => { const o = document.createElement("option"); o.value = v; dl.append(o); });
  });
}
function renderGroups(counts) {
  const holder = $("#groupStats");
  const max = Math.max(1, ...GROUPS.map(g => counts[g] || 0));
  if (!holder.children.length) {
    GROUPS.forEach((g, i) => {
      const card = document.createElement("div");
      card.className = "group-card"; card.style.setProperty("--i", i);
      const label = document.createElement("b"); label.textContent = g;
      const right = document.createElement("div");
      const n = document.createElement("span"); n.textContent = BN(0);
      const small = document.createElement("small"); small.textContent = "ডোনার";
      right.append(n, small);
      const bar = document.createElement("div"); bar.className = "bar";
      bar.append(document.createElement("i"));
      card.append(label, right, bar);
      holder.append(card);
    });
  }
  GROUPS.forEach((g, i) => {
    const card = holder.children[i], v = counts[g] || 0;
    card.querySelector("span").textContent = BN(v);
    const fill = card.querySelector(".bar i");
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = Math.round(v / max * 100) + "%"; }));
  });
}
function countUp(el, to) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || to < 2) { el.textContent = BN(to); return; }
  const start = performance.now(), dur = 900;
  const tick = t => {
    const p = Math.min(1, (t - start) / dur);
    el.textContent = BN(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
async function loadStats() {
  if (!$("#groupStats").children.length) renderGroups({});
  try {
    const data = await api("/api/public/stats");
    countUp($("#statDonors"), data.approvedDonors);
    countUp($("#heroDonors"), data.approvedDonors);
    renderGroups(Object.fromEntries(data.groups.map(x => [x.group, x.count])));
  } catch {
    $("#statDonors").textContent = "—";
    $("#heroDonors").textContent = "—";
  }
}
function formObject(form) {
  const obj = Object.fromEntries(new FormData(form).entries());
  if (form.elements.consent) obj.consent = form.elements.consent.checked;
  if (obj.units) obj.units = Number(obj.units);
  return obj;
}
function setMinNeededAt() {
  const input = document.querySelector('input[name="needed_at"]');
  if (!input) return;
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  input.min = d.toISOString().slice(0, 16);
}
function setMaxDonationDate() {
  const input = document.querySelector('input[name="last_donation"]');
  if (input) input.max = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function bindForm(id, endpoint, messageId, label) {
  const form = $(id), message = $(messageId);
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener("submit", async e => {
    e.preventDefault();
    showMessage(message, "");
    if (!form.checkValidity()) { form.reportValidity(); return; }
    button.disabled = true; button.textContent = "জমা হচ্ছে…";
    try {
      if (!csrfToken) await getCsrf();
      let data;
      try {
        data = await api(endpoint, { method: "POST", body: JSON.stringify(formObject(form)) });
      } catch (err) {
        if (err.status !== 403) throw err;      // CSRF/সেশন পুরোনো হলে একবার নতুন টোকেন নিয়ে আবার চেষ্টা
        await getCsrf();
        data = await api(endpoint, { method: "POST", body: JSON.stringify(formObject(form)) });
      }
      showMessage(message, data.message);
      toast(data.message);
      confetti(button);
      form.reset();
      setMinNeededAt();
      loadStats();
    } catch (err) {
      showMessage(message, err.message, true);
      toast(err.message, true);
    } finally {
      button.disabled = false; button.innerHTML = label + " <span>→</span>";
    }
  });
}
function setupReveal() {
  const items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) { items.forEach(i => i.classList.add("in")); return; }
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
  }, { threshold: .12, rootMargin: "0px 0px -40px 0px" });
  items.forEach((el, i) => { el.style.transitionDelay = (i % 3) * 80 + "ms"; io.observe(el); });
}
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)").matches;

function splitHeading() {
  const h1 = $(".split"); if (!h1) return;
  let i = 0;
  const wrap = node => {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(t => {
          if (!t) return;
          if (/^\s+$/.test(t)) { frag.append(" "); return; }
          const s = document.createElement("span"); s.className = "w"; s.style.setProperty("--i", i++); s.textContent = t; frag.append(s);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && n.tagName !== "BR") wrap(n);
    });
  };
  wrap(h1);
}
function makeParticles() {
  const box = $("#particles"); if (!box || REDUCE) return;
  const n = innerWidth < 700 ? 10 : 22;
  for (let k = 0; k < n; k++) {
    const s = document.createElement("span"), size = 8 + Math.random() * 20;
    s.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;--d:${10 + Math.random() * 12}s;--delay:${-Math.random() * 20}s;--x:${(Math.random() - .5) * 120}px;--o:${.25 + Math.random() * .45}`;
    box.append(s);
  }
}
function setupProgress() {
  const bar = $("#progress i");
  const f = () => { const h = document.documentElement.scrollHeight - innerHeight; bar.style.transform = `scaleX(${h > 0 ? Math.min(1, scrollY / h) : 0})`; };
  addEventListener("scroll", f, { passive: true }); f();
}
function setupScrollSpy() {
  const links = [...document.querySelectorAll('#mainNav a[href^="#"]:not(.nav-cta)')];
  const map = new Map(links.map(a => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { links.forEach(l => l.classList.remove("active")); map.get(e.target.id)?.classList.add("active"); }
  }), { rootMargin: "-45% 0px -50% 0px" });
  map.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
}
function setupTilt() {
  if (REDUCE || !matchMedia("(hover:hover)").matches) return;
  document.querySelectorAll(".feature-card,.tip,.steps article,.group-card").forEach(el => {
    el.classList.add("tilt"); el.style.transitionDelay = "0ms";
    el.addEventListener("mousemove", e => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      el.classList.add("tilting");
      el.style.transform = `perspective(700px) rotateX(${(-y * 8).toFixed(2)}deg) rotateY(${(x * 8).toFixed(2)}deg) translateY(-4px)`;
    });
    el.addEventListener("mouseleave", () => { el.classList.remove("tilting"); el.style.transform = ""; });
  });
}
function setupRipple() {
  document.addEventListener("pointerdown", e => {
    const b = e.target.closest(".btn"); if (!b || REDUCE) return;
    const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 2;
    const s = document.createElement("span"); s.className = "ripple";
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
    b.append(s); setTimeout(() => s.remove(), 650);
  });
}
function confetti(origin) {
  if (REDUCE) return;
  const r = origin.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let k = 0; k < 26; k++) {
    const p = document.createElement("i"); p.className = "confetti";
    const a = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 160;
    p.style.cssText = `left:${cx}px;top:${cy}px;--dx:${Math.cos(a) * dist}px;--dy:${Math.sin(a) * dist + 80}px;--r:${Math.random() * 540 - 270}deg;background:${["#e51e45","#ff6a85","#16834f","#67d994","#e5ad43"][k % 5]}`;
    document.body.append(p); setTimeout(() => p.remove(), 1400);
  }
}
document.addEventListener("DOMContentLoaded", async () => {
  splitHeading(); makeParticles(); setupProgress(); setupScrollSpy(); setupRipple();
  $("#year").textContent = new Date().getFullYear();
  fillGroups(); fillDatalists(); setMinNeededAt(); setMaxDonationDate(); setupReveal();
  const topbar = $("#topbar");
  const onScroll = () => topbar.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true }); onScroll();
  const top = $("#toTop");
  addEventListener("scroll", () => { top.hidden = scrollY < 700; }, { passive: true });
  top.addEventListener("click", () => scrollTo({ top: 0, behavior: "smooth" }));
  const toggle = $("#menuToggle"), nav = $("#mainNav");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "মেনু বন্ধ করুন" : "মেনু খুলুন");
  });
  nav.querySelectorAll("a").forEach(a => a.addEventListener("click", () => { nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }));
  try { await getCsrf(); } catch {}
  loadStats(); setupTilt();
  bindForm("#donorForm", "/api/public/donors", "#donorMessage", "ডোনার আবেদন পাঠান");
  bindForm("#requestForm", "/api/public/requests", "#requestMessage", "আবেদন জমা দিন");
});
