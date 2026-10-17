"use strict";
// Servidor da Arena do Galpão: entrega o jogo, guarda contas/amigos e controla as salas.
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const https = require("https");
const { WebSocketServer } = require("ws");

/* ===== Base compartilhada (servidor e jogo usam exatamente isto) ===== */
const SH = (function () {
  "use strict";
  var W = 270, H = 96;
  var PR = 0.8, SPEED = 9.2;
  var MAXHP = 300, MAXEP = 100;
  var GAL = { x0: 12, y0: 12, x1: 90, y1: 66 };       // retângulo interno do galpão
  var NG = 9;                                          // armas de fogo: ids 0..8; brancas: 9..11

  // k: "g" fogo, "m" branca. dmg por tiro (escopeta: por bago), rate tiros/s
  var WEAPONS = [
    { n: "Pistolas duplas", k: "g", dmg: 7,   rate: 4.8, spread: 0.03,  life: 0.75, spd: 62,  pel: 1 },
    { n: "MP40",            k: "g", dmg: 5,   rate: 10,  spread: 0.07,  life: 0.65, spd: 60,  pel: 1 },
    { n: "UMP",             k: "g", dmg: 6,   rate: 10,  spread: 0.055, life: 0.70, spd: 62,  pel: 1 },
    { n: "Escopeta",        k: "g", dmg: 6,   rate: 1.4, spread: 0.17,  life: 0.38, spd: 58,  pel: 7 },
    { n: "FAMAS",           k: "g", dmg: 7,   rate: 9.5, spread: 0.04,  life: 0.85, spd: 66,  pel: 1 },
    { n: "AK-47",           k: "g", dmg: 9,   rate: 7.5, spread: 0.05,  life: 0.95, spd: 68,  pel: 1 },
    { n: "SCAR",            k: "g", dmg: 13,  rate: 6.5, spread: 0.025, life: 0.95, spd: 70,  pel: 1 },
    { n: "M4A1",            k: "g", dmg: 7.5, rate: 10,  spread: 0.03,  life: 0.95, spd: 70,  pel: 1 },
    { n: "Sniper AWM",      k: "g", dmg: 85,  rate: 0.9, spread: 0.004, life: 1.5,  spd: 120, pel: 1 },
    { n: "Soco inglês",     k: "m", dmg: 12,  rate: 3.2, range: 2.7 },
    { n: "Faca",            k: "m", dmg: 20,  rate: 2.4, range: 3.0 },
    { n: "Machado",         k: "m", dmg: 45,  rate: 1.1, range: 3.5 }
  ];
  var PROG = [0, 1, 2, 4, 5, 6, 7];                    // cada abate sobe um degrau
  // chance de aparecer no chão (armas de fogo 1..8) e brancas (9..11)
  var GUN_W = [0, 22, 18, 12, 16, 14, 10, 8, 4];
  var MELEE_W = [0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 40, 20];

  var solids = [];
  function S(t, x, y, w, h, hg, o) {
    var s = { t: t, x: x, y: y, w: w, h: h, hg: hg, c: (o && o.c) || null, v: !!(o && o.v), p: (o && o.p) || "", d: (o && o.d) || 1 };
    solids.push(s); return s;
  }
  var WALLH = 3.4;
  function wall(x, y, w, h) { S("wall", x, y, w, h, WALLH); }
  function fence(x, y, w, h) { S("fence", x, y, w, h, 2.4); }
  function crate(x, y, w, h, st) { S("crate", x, y, w, h, st ? 4.1 : 2.4, { v: st }); }
  function container(x, y, w, h, c) { S("container", x, y, w, h, 4.2, { c: c }); }
  function barrel(x, y) { S("barrel", x, y, 1.5, 1.5, 1.9); }
  function pallet(x, y) { S("pallet", x, y, 2.6, 2.6, 2.4); }
  function van(x, y, w, h) { S("van", x, y, w, h, 3.0); }
  // avião (sempre deitado no eixo x): fuselagem + asa + cauda
  function plane(cx, cy, len, span, d, c) {
    S("plane", cx - len / 2, cy - 1.6, len, 3.2, 3.6, { p: "f", d: d, c: c });
    S("plane", cx - 2.8 + (d > 0 ? 0.5 : -0.5), cy - span / 2, 5.6, span, 1.3, { p: "w", d: d, c: c });
    S("plane", cx + d * (len / 2 - 3.2) - 1.1 - (d > 0 ? 0 : 0), cy - span * 0.2, 2.2, span * 0.4, 1.0, { p: "t", d: d, c: c });
  }

  (function build() {
    // bordas
    wall(0, 0, W, 1.6); wall(0, H - 1.6, W, 1.6); wall(0, 1.6, 1.6, H - 3.2); wall(W - 1.6, 1.6, 1.6, H - 3.2);
    // galpão
    var x0 = 12, y0 = 12, x1 = 90, y1 = 66, t = 1.4, i, j;
    wall(x0, y0, 32, t); wall(52, y0, x1 - 52, t);
    wall(x0, y1 - t, 32, t); wall(52, y1 - t, x1 - 52, t);
    wall(x0, y0 + t, t, 34 - (y0 + t)); wall(x0, 42, t, y1 - t - 42);
    wall(x1 - t, y0 + t, t, 22 - (y0 + t)); wall(x1 - t, 30, t, 18); wall(x1 - t, 56, t, y1 - t - 56);
    var sx = [19.8, 27.8, 35.8, 57.8, 65.8, 73.8], ry = [18, 46];
    for (i = 0; i < sx.length; i++) for (j = 0; j < ry.length; j++) S("shelf", sx[i], ry[j], 2.4, 14, 4.4);
    crate(24, 36, 3, 3); crate(60, 38, 3.2, 3.2, true); crate(78, 41, 3, 3); crate(56, 43, 2.6, 2.6);
    crate(15, 15, 3, 3); crate(84, 15, 3, 3); crate(15, 60, 3, 3); crate(84, 60, 3, 3, true);
    // barris e paletes (cobertura extra)
    barrel(14.2, 22); barrel(14.2, 24.0); barrel(16, 23);
    barrel(86.4, 52); barrel(86.4, 53.9); barrel(84.6, 52.9);
    barrel(14.2, 54); barrel(16, 55.3);
    pallet(44, 33.4); pallet(70, 35); pallet(34, 43); pallet(48, 14.6); pallet(80, 60.6);
    // pátio
    container(98, 12, 14, 5.2, [0.75, 0.22, 0.20]); container(118, 12, 14, 5.2, [0.20, 0.40, 0.72]);
    container(98, 62, 14, 5.2, [0.90, 0.62, 0.15]); container(120, 62, 14, 5.2, [0.22, 0.55, 0.32]);
    container(106, 28, 5.2, 14, [0.20, 0.55, 0.58]); container(134, 34, 5.2, 14, [0.50, 0.32, 0.62]);
    van(120, 30, 8, 4); van(116, 50, 8, 4); van(140, 14, 4, 8); van(140, 58, 4, 8);
    crate(100, 22, 2.6, 2.6); crate(126, 42, 3, 3, true); crate(108, 50, 3, 3); crate(140, 46, 2.6, 2.6);
    // rua e laterais
    van(12, 80, 8, 4); van(34, 84, 8, 4); van(58, 80, 8, 4); van(108, 82, 8, 4); van(130, 78, 8, 4);
    S("booth", 88, 76, 7, 6, 3.4);
    van(30, 4, 8, 4); van(66, 4.5, 8, 4); van(108, 4, 8, 4);
    van(3.5, 22, 4, 8); van(3.5, 48, 4, 8); van(3.5, 72, 4, 8);
    barrel(100, 19.4); barrel(101.9, 19.9); barrel(136, 20); barrel(137.9, 20.6); barrel(100.5, 58.4); barrel(102.4, 58.9); barrel(144, 66);
    pallet(112, 42); pallet(128, 58); pallet(94, 40);
    barrel(160, 36); barrel(162, 36.3); barrel(214, 35.5); barrel(231, 17); barrel(233, 17.6); barrel(256, 20); barrel(236, 56);
    pallet(190, 36); pallet(240, 28);
    crate(46, 72, 3, 3); crate(80, 86, 3, 3, true); crate(122, 88, 3, 3);

    // cerca entre o pátio e o aeroporto (portões abertos em y 28..46 e 78..90)
    fence(148, 1.6, 1.4, 26.4); fence(148, 46, 1.4, 32); fence(148, 90, 1.4, 4.4);

    /* ---- Aeroporto (x 150..268) ---- */
    // terminal x 158..212, y 8..32 (portas ao sul e ao leste)
    wall(158, 8, 54, 1.4);
    wall(158, 9.4, 1.4, 22.6); wall(210.6, 9.4, 1.4, 8.6); wall(210.6, 24, 1.4, 8);
    wall(158, 30.6, 12, 1.4); wall(178, 30.6, 14, 1.4); wall(200, 30.6, 12, 1.4);
    S("counter", 166, 13, 12, 2.2, 1.7); S("counter", 184, 13, 12, 2.2, 1.7);
    S("counter", 200, 12, 7, 5, 2.0, { c: [0.25, 0.55, 0.75] });
    S("bench", 166, 21, 10, 1.8, 1.1); S("bench", 182, 21, 10, 1.8, 1.1); S("bench", 166, 25.5, 10, 1.8, 1.1); S("bench", 182, 25.5, 10, 1.8, 1.1);
    // torre de controle
    S("tower", 218, 10, 6, 6, 17);
    // hangar x 228..264, y 8..34 (porta ao sul)
    wall(228, 8, 36, 1.4); wall(228, 9.4, 1.4, 24.6); wall(262.6, 9.4, 1.4, 24.6);
    wall(228, 32.6, 10, 1.4); wall(254, 32.6, 10, 1.4);
    plane(244, 22, 12, 11, 1, [0.9, 0.35, 0.18]);
    crate(232, 12, 3, 3); crate(232, 26, 3, 3, true); crate(258, 12, 3, 3, true); crate(258, 27, 3, 3);
    S("shelf", 250, 10.5, 9, 2.4, 4.4);
    // pátio dos aviões (apron)
    plane(180, 47, 22, 22, 1, [0.20, 0.45, 0.80]);
    plane(214, 53, 22, 22, -1, [0.85, 0.20, 0.25]);
    plane(250, 48, 13, 11, 1, [0.25, 0.60, 0.40]);
    S("cart", 172, 35, 3.6, 2, 1.3); S("cart", 195, 35, 3.6, 2, 1.3); S("cart", 200, 38, 3.6, 2, 1.3);
    container(228, 38, 10, 4.4, [0.85, 0.50, 0.15]); container(240, 38, 4.4, 8, [0.30, 0.45, 0.70]);
    van(156, 56, 8, 4); van(196, 62, 8, 4); van(228, 60, 4, 8);
    S("tank", 252, 58, 7, 7, 4.2); S("tank", 261, 58, 5.5, 5.5, 3.6);
    // pista (só marcação) e faixa de baixo
    S("barrier", 168, 83.5, 6, 1.4, 1.1); S("barrier", 200, 83.5, 6, 1.4, 1.1); S("barrier", 236, 83.5, 6, 1.4, 1.1);
    van(160, 88, 8, 4); van(220, 88, 8, 4); crate(186, 88, 3, 3, true); crate(250, 88, 3, 3); crate(262, 72, 3, 3);
    for (i = 0; i < solids.length; i++) if (solids[i].t === "crate" && solids[i].v) solids[i].hg = 4.1;
  })();

  // grade para colisão rápida
  var CS = 6, GW = Math.ceil(W / CS), GH = Math.ceil(H / CS), grid = [];
  (function () {
    var n = GW * GH, i, gx, gy;
    for (i = 0; i < n; i++) grid.push([]);
    for (i = 0; i < solids.length; i++) {
      var s = solids[i], m = 1.6;
      var a = Math.max(0, Math.floor((s.x - m) / CS)), b = Math.min(GW - 1, Math.floor((s.x + s.w + m) / CS));
      var c = Math.max(0, Math.floor((s.y - m) / CS)), d = Math.min(GH - 1, Math.floor((s.y + s.h + m) / CS));
      for (gx = a; gx <= b; gx++) for (gy = c; gy <= d; gy++) grid[gy * GW + gx].push(s);
    }
  })();
  function cell(x, y) {
    var gx = Math.floor(x / CS), gy = Math.floor(y / CS);
    if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return null;
    return grid[gy * GW + gx];
  }
  function circleHit(x, y, r) {
    var l = cell(x, y); if (!l) return true;
    for (var i = 0; i < l.length; i++) {
      var s = l[i];
      var dx = x - (x < s.x ? s.x : x > s.x + s.w ? s.x + s.w : x), dy = y - (y < s.y ? s.y : y > s.y + s.h ? s.y + s.h : y);
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
  function pointHit(x, y) {
    var l = cell(x, y); if (!l) return true;
    for (var i = 0; i < l.length; i++) { var s = l[i]; if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return true; }
    return false;
  }
  function solidAt(x, y) {
    var l = cell(x, y); if (!l) return { hg: 99 };
    for (var i = 0; i < l.length; i++) { var s = l[i]; if (x > s.x && x < s.x + s.w && y > s.y && y < s.y + s.h) return s; }
    return null;
  }
  // ponto livre aleatório (dentro de um retângulo [x0,y0,x1,y1])
  function freePoint(r, rnd) {
    rnd = rnd || Math.random;
    for (var n = 0; n < 60; n++) {
      var x = r[0] + rnd() * (r[2] - r[0]), y = r[1] + rnd() * (r[3] - r[1]);
      if (!circleHit(x, y, 2.4)) return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    }
    return [48, 40];
  }
  var ZONES = { all: [6, 6, 264, 90], gal: [14, 14, 88, 64], yard: [94, 8, 144, 72] };

  return { W: W, H: H, PR: PR, SPEED: SPEED, MAXHP: MAXHP, MAXEP: MAXEP, GAL: GAL, NG: NG, WEAPONS: WEAPONS, PROG: PROG,
    GUN_W: GUN_W, MELEE_W: MELEE_W, solids: solids, circleHit: circleHit, pointHit: pointHit, solidAt: solidAt, freePoint: freePoint, ZONES: ZONES };
})();


const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PERMANENT = !!(UP_URL && UP_TOKEN);
const DATA_FILE = path.join(process.env.DATA_DIR || DIR, "accounts.json");

// ---------- Arquivos estáticos ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const FILES = { "/": "index.html", "/index.html": "index.html", "/manifest.webmanifest": "manifest.webmanifest", "/sw.js": "sw.js",
  "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png", "/icon-maskable-512.png": "icon-maskable-512.png", "/apple-touch-icon.png": "apple-touch-icon.png" };
const cache = {};
function loadFile(name) {
  try {
    const buf = fs.readFileSync(path.join(DIR, name));
    const ext = path.extname(name);
    cache[name] = { buf, gz: /html|js|webmanifest/.test(ext) ? zlib.gzipSync(buf, { level: 9 }) : null, type: MIME[ext] || "application/octet-stream" };
  } catch (e) { cache[name] = null; }
  return cache[name];
}
const server = http.createServer((req, res) => {
  const url = String(req.url || "/").split("?")[0];
  if (url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  const name = FILES[url];
  if (!name) { res.writeHead(404); res.end("Não encontrado"); return; }
  const f = cache[name] || loadFile(name);
  if (!f) { res.writeHead(500); res.end(name + " não encontrado"); return; }
  const h = { "Content-Type": f.type, "Cache-Control": name === "index.html" || name === "sw.js" ? "no-cache" : "public, max-age=86400" };
  if (f.gz && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) { h["Content-Encoding"] = "gzip"; res.writeHead(200, h); res.end(f.gz); }
  else { res.writeHead(200, h); res.end(f.buf); }
});

// ---------- Utilidades ----------
function num(v, lo, hi, def) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; }
function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }
function sha(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function rid(n) { return crypto.randomBytes(n).toString("hex"); }
const NAME_RE = /^[A-Za-z0-9_-]{3,12}$/;
const REC_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRecovery() { let s = ""; const b = crypto.randomBytes(8); for (let i = 0; i < 8; i++) s += REC_CHARS[b[i] % REC_CHARS.length]; return s; }

// ---------- Contas (arquivo local ou Upstash) ----------
let accts = {};           // id -> { id, name, key, th, rh, fr:[], req:[], k, w, created }
const byKey = new Map();  // nome em minúsculas -> id
let dirty = false, saving = false;
function indexAccts() { byKey.clear(); for (const id in accts) byKey.set(accts[id].key, id); }
function upstash(cmd) {
  return new Promise((resolve, reject) => {
    const u = new URL(UP_URL), body = JSON.stringify(cmd);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname || "/", method: "POST",
      headers: { Authorization: "Bearer " + UP_TOKEN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { const j = JSON.parse(d); if (j.error) reject(new Error(j.error)); else resolve(j.result); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}
async function loadAccts() {
  try {
    let txt = null;
    if (PERMANENT) txt = await upstash(["GET", "arena:accts"]);
    else if (fs.existsSync(DATA_FILE)) txt = fs.readFileSync(DATA_FILE, "utf8");
    if (txt) accts = JSON.parse(txt) || {};
  } catch (e) { console.log("Falha ao ler contas:", e.message); }
  indexAccts();
  console.log("Contas carregadas: " + Object.keys(accts).length + (PERMANENT ? " (Upstash)" : " (arquivo local, não permanente)"));
}
function markDirty() { dirty = true; }
async function saveNow() {
  if (!dirty || saving) return;
  saving = true; dirty = false;
  const txt = JSON.stringify(accts);
  try {
    if (PERMANENT) await upstash(["SET", "arena:accts", txt]);
    else fs.writeFileSync(DATA_FILE, txt);
  } catch (e) { dirty = true; console.log("Falha ao salvar contas:", e.message); }
  saving = false;
}
setInterval(saveNow, 4000);

// ---------- Conexões e sessões ----------
// P = sessão de um jogador (continua existindo por alguns segundos se a conexão cair)
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const sessions = new Map();   // id da conta -> P
let nidSeq = 1;
function sendP(P, o) { if (P.ws && P.ws.readyState === 1) P.ws.send(typeof o === "string" ? o : JSON.stringify(o)); }
function sendRaw(P, buf) { if (P.ws && P.ws.readyState === 1) P.ws.send(buf, { binary: true }); }
function statusOf(P) {
  if (!P || !P.ws || P.ws.readyState !== 1) return "off";
  if (P.room) return P.room.kind === "z" ? "zumbis" : P.room.kind === "duo" ? "duo" : "galpão";
  return "lobby";
}

// ---------- Amigos e grupos (duo) ----------
function pubAcc(a) { return { id: a.id, n: a.name }; }
function friendsPayload(a) {
  return {
    t: "friends",
    fr: a.fr.map((id) => accts[id]).filter(Boolean).map((f) => ({ id: f.id, n: f.name, st: statusOf(sessions.get(f.id)) })),
    req: a.req.map((id) => accts[id]).filter(Boolean).map(pubAcc),
  };
}
function pushFriends(id) { const P = sessions.get(id); if (P && P.ws) sendP(P, friendsPayload(P.acc)); }
function pushFriendsOf(a) { for (const id of a.fr) pushFriends(id); }
const parties = new Map();    // id da conta -> { m:[ids] } (mesmo objeto para os dois)
const invites = new Map();    // id convidado -> { from, at }
function partyMsg(P) {
  const pt = parties.get(P.acc.id);
  return { t: "party", m: pt ? pt.m.map((id) => ({ id, n: accts[id] ? accts[id].name : "?", st: statusOf(sessions.get(id)) })) : [] };
}
function pushParty(ids) { for (const id of ids) { const Q = sessions.get(id); if (Q) sendP(Q, partyMsg(Q)); } }
function leaveParty(P) {
  const pt = parties.get(P.acc.id);
  if (!pt) return;
  const ids = pt.m.slice();
  for (const id of ids) parties.delete(id);
  for (const id of ids) { const Q = sessions.get(id); if (Q) sendP(Q, partyMsg(Q)); }
  for (const id of ids) if (id !== P.acc.id) { const Q = sessions.get(id); if (Q) sendP(Q, { t: "note", s: P.acc.name + " saiu da dupla." }); }
}
function partnerOf(P) {
  const pt = parties.get(P.acc.id);
  if (!pt) return null;
  for (const id of pt.m) if (id !== P.acc.id) return sessions.get(id) || null;
  return null;
}

// ======================= SALAS =======================
const MAXP = 30, JOIN_WINDOW = 180000, MATCH_MS = 600000, CD_MS = 10000, END_MS = 10000, GHOST_MS = 20000;
const ZHP = 90, ZSPEED = 3.4, ZR = 0.9, ZDMG = 14;
const WN = SH.WEAPONS;
const HEAD_MUL = 2.2, BODY_MUL = 0.8;   // tiro na cabeça dá mais dano; no resto do corpo, menos
const rooms = new Map();
let roomSeq = 1;

function makeRoom(kind, id) {
  const r = { id: id || ("z" + roomSeq++), kind, players: new Set(), zombies: [], pickups: [], respawns: [], zid: 1, pid: 1,
    ph: kind === "z" ? "free" : "wait", phAt: Date.now(), mid: 0, playAt: 0, win: "", res: null, nextZ: 0, emptyAt: Date.now(), startTeams: 0, tick: 0, cdMs: CD_MS };
  rooms.set(r.id, r);
  resetWorld(r);
  return r;
}
const GALPAO = makeRoom("g", "G");
const DUOROOM = makeRoom("duo", "D");

function isPvp(r) { return r.kind !== "z"; }
function teamKey(P) {
  const pt = parties.get(P.acc.id);
  return pt && pt.m.length === 2 ? pt.m.slice().sort().join("+") : P.acc.id;
}
function pname(P) { return P.acc.name; }
function activeW(P) { return P.act === 1 && P.m >= 0 ? P.m : P.g; }

// ---------- Itens do chão ----------
function pickW(tbl) { let t = 0, i; for (i = 0; i < tbl.length; i++) t += tbl[i]; let x = Math.random() * t; for (i = 0; i < tbl.length; i++) { x -= tbl[i]; if (x <= 0) return i; } return 1; }
function spawnAmbient(r, ty) {
  const zone = ty === "mel" ? SH.ZONES.gal : SH.ZONES.all;
  let pos = null;
  for (let n = 0; n < 8; n++) {
    const p = SH.freePoint(zone);
    let ok = true;
    for (const q of r.pickups) if (Math.hypot(q.x - p[0], q.y - p[1]) < 5) { ok = false; break; }
    if (ok) { pos = p; break; }
  }
  if (!pos) return;
  const it = { i: r.pid++, ty: "w", w: 0, x: pos[0], y: pos[1], amb: ty, exp: 0 };
  if (ty === "gun") it.w = pickW(SH.GUN_W);
  else if (ty === "mel") it.w = pickW(SH.MELEE_W);
  else it.ty = ty;
  r.pickups.push(it);
}
function dropItem(r, ty, w, x, y, life) {
  const a = Math.random() * 6.28, d = 0.6 + Math.random() * 0.8;
  r.pickups.push({ i: r.pid++, ty, w, x: r1(x + Math.cos(a) * d), y: r1(y + Math.sin(a) * d), amb: "", exp: Date.now() + (life || 60000) });
}
function pkList(r) { return r.pickups.map((p) => [p.i, p.ty, p.w, p.x, p.y]); }
function bcastPk(r) { const m = JSON.stringify({ t: "pk", l: pkList(r) }); for (const P of r.players) sendP(P, m); }
function resetWorld(r) {
  r.pickups = []; r.respawns = []; r.zombies = [];
  const pv = isPvp(r);
  const guns = pv ? 9 : 7, mel = pv ? 6 : 4;
  for (let i = 0; i < guns; i++) spawnAmbient(r, "gun");
  for (let i = 0; i < mel; i++) spawnAmbient(r, "mel");
  for (let i = 0; i < 4; i++) spawnAmbient(r, "b");
  for (let i = 0; i < 2; i++) spawnAmbient(r, "m");
}

// ---------- Zumbis ----------
function zTarget(r) {
  const n = r.players.size;
  if (n === 0) return 0;
  if (r.kind === "z") return Math.min(30, 6 + n * 3);
  if (r.ph === "play") return Math.min(10, 3 + Math.ceil(n / 5));
  return Math.min(24, 8 + n * 2);
}
function fighters(r) { const o = []; for (const P of r.players) if (P.al && !P.out && (P.ws || P.bot) && P.hp > 0) o.push(P); return o; }
function spawnZombie(r, fs) {
  let best = null, bd = -1;
  for (let n = 0; n < 6; n++) {
    const p = SH.freePoint(SH.ZONES.all);
    let d = 1e9;
    for (const f of fs) d = Math.min(d, Math.hypot(f.x - p[0], f.y - p[1]));
    if (d > bd) { bd = d; best = p; }
    if (bd > 30) break;
  }
  if (best && bd > 18) r.zombies.push({ i: r.zid++, x: best[0], y: best[1], a: Math.random() * 6.28, hp: ZHP, hit: 0, wander: 0, wa: 0, idle: false });
}
function stepZombies(r, dt, now) {
  const fs = fighters(r);
  if (r.zombies.length < zTarget(r) && now >= r.nextZ) { spawnZombie(r, fs); r.nextZ = now + 700; }
  for (const z of r.zombies) {
    let tgt = null, bd = 45;
    for (const f of fs) { const d = Math.hypot(f.x - z.x, f.y - z.y); if (d < bd) { bd = d; tgt = f; } }
    let ang = z.a, sp = 0;
    if (tgt) { ang = Math.atan2(tgt.y - z.y, tgt.x - z.x); sp = bd > 1.5 ? ZSPEED : 0; }
    else {
      z.wander -= dt;
      if (z.wander <= 0) { z.wander = 1.5 + Math.random() * 2.5; z.wa = Math.random() * 6.283; z.idle = Math.random() < 0.3; }
      ang = z.wa; sp = z.idle ? 0 : 1.4;
    }
    let moved = false;
    if (sp > 0) {
      const tries = tgt ? [0, 0.7, -0.7, 1.4, -1.4] : [0];
      for (const off of tries) {
        const a2 = ang + off, nx = z.x + Math.cos(a2) * sp * dt, ny = z.y + Math.sin(a2) * sp * dt;
        let ok = false;
        if (!SH.circleHit(nx, ny, ZR)) { z.x = nx; z.y = ny; ok = true; }
        else if (!SH.circleHit(nx, z.y, ZR)) { z.x = nx; ok = true; }
        else if (!SH.circleHit(z.x, ny, ZR)) { z.y = ny; ok = true; }
        if (ok) { moved = true; if (off) ang = a2; break; }
      }
      if (!moved && !tgt) z.wander = 0;
    }
    z.a = ang;
    z.hit -= dt;
    if (tgt && bd < 2.0 && z.hit <= 0) { z.hit = 0.9; if (tgt.bot) hitBot(r, tgt, ZDMG, null); else sendP(tgt, { t: "zhit", d: ZDMG }); }
  }
}
function killZombie(r, z, P) {
  const i = r.zombies.indexOf(z);
  if (i >= 0) r.zombies.splice(i, 1);
  const x = Math.random();
  if (x < 0.22) dropItem(r, "w", 10, z.x, z.y);
  else if (x < 0.40) dropItem(r, "w", 9, z.x, z.y);
  else if (x < 0.62) dropItem(r, "b", 0, z.x, z.y);
  else if (x < 0.74) dropItem(r, "m", 0, z.x, z.y);
  bcastPk(r);
  if (P) {
    P.zk++; P.pts += 1;
    sendP(P, { t: "got", ty: "zk" });
    if (P.zk % 4 === 0) upgradeGun(P);
    sendSt(P);
  }
}

// ---------- Estado de cada jogador ----------
function upgradeGun(P) {
  const i = SH.PROG.indexOf(P.g);
  if (i >= 0 && i < SH.PROG.length - 1) { P.g = SH.PROG[i + 1]; if (P.act === 0) {} }
}
function sendSt(P) { sendP(P, { t: "st", g: P.g, m: P.m, act: P.act, pts: P.pts, mk: P.mk }); }
function resetLoadout(P) { P.g = 0; P.m = -1; P.act = 0; }
function dropLoadout(P) {
  const r = P.room; if (!r) return;
  if (P.g !== 0) dropItem(r, "w", P.g, P.x, P.y);
  if (P.m >= 0) dropItem(r, "w", P.m, P.x, P.y);
  if (P.g !== 0 || P.m >= 0) bcastPk(r);
}
function pickSpawn(r, P) {
  let best = null, bd = -1;
  for (let n = 0; n < 10; n++) {
    const p = SH.freePoint(SH.ZONES.all);
    let d = 1e9;
    for (const Q of r.players) if (Q !== P && Q.al && !Q.out) d = Math.min(d, Math.hypot(Q.x - p[0], Q.y - p[1]));
    for (const z of r.zombies) d = Math.min(d, Math.hypot(z.x - p[0], z.y - p[1]) * 1.5);
    if (d > bd) { bd = d; best = p; }
  }
  return best || [48, 40];
}
function freeCi(r) {
  const used = new Set(); for (const Q of r.players) used.add(Q.ci);
  for (let i = 0; i < 8; i++) if (!used.has(i)) return i;
  return Math.floor(Math.random() * 8);
}
function teamIdx(r) {
  const m = new Map(); let n = 0; const out = new Map();
  for (const Q of r.players) { if (!m.has(Q.team)) m.set(Q.team, n++); out.set(Q, m.get(Q.team)); }
  return out;
}
function rosterMsg(r) {
  const ti = teamIdx(r), l = [];
  for (const Q of r.players) l.push([Q.nid, pname(Q), Q.ci, ti.get(Q), Q.mk, Q.out ? 1 : 0, Q.bot ? 1 : 0]);
  return { t: "ro", l };
}
function bcastRoster(r) { const m = JSON.stringify(rosterMsg(r)); for (const P of r.players) sendP(P, m); }
function matchMsg(r) {
  const dur = r.ph === "cd" ? r.cdMs : r.ph === "end" ? END_MS : r.ph === "play" ? MATCH_MS : 0;
  let al = 0, tm = new Set();
  for (const Q of r.players) if (!Q.out) { al++; tm.add(Q.team); }
  const m = { t: "match", ph: r.ph, mid: r.mid, left: dur ? Math.max(0, Math.ceil((r.phAt + dur - Date.now()) / 1000)) : 0, kind: r.kind, al, tm: tm.size, n: r.players.size };
  if (r.ph === "end") { m.win = r.win; m.res = r.res; }
  return m;
}
function bcastMatch(r) { const m = JSON.stringify(matchMsg(r)); for (const P of r.players) sendP(P, m); }
function setPhase(r, ph) { r.ph = ph; r.phAt = Date.now(); bcastMatch(r); }

function initPlayerState(P, r) {
  P.room = r; P.nid = ++nidSeq;
  let used = false; for (const Q of r.players) if (Q.ci === P.acc.ci) used = true;
  P.ci = (P.acc.ci >= 0 && P.acc.ci < 8 && !used) ? P.acc.ci : freeCi(r);
  P.hp = SH.MAXHP; P.ep = 0; P.al = 1; P.out = false; P.team = teamKey(P);
  resetLoadout(P); P.pts = 0; P.mk = 0; P.zk = 0; P.shots = []; P.zh = []; P.lastMel = 0; P.lastKill = 0; P.offAt = 0;
  const sp = pickSpawn(r, P); P.x = sp[0]; P.y = sp[1]; P.a = 0;
}
function joinedMsg(P, r) {
  return { t: "joined", kind: r.kind, nid: P.nid, ci: P.ci, x: P.x, y: P.y, al: P.al && !P.out ? 1 : 0, out: P.out ? 1 : 0,
    g: P.g, m: P.m, act: P.act, pts: P.pts, mk: P.mk, hp: P.hp, ep: P.ep, pk: pkList(r), match: matchMsg(r), ro: rosterMsg(r).l, perm: PERMANENT };
}
function enterRoom(P, r) {
  leaveRoom(P, true);
  initPlayerState(P, r);
  r.players.add(P); r.emptyAt = 0;
  sendP(P, joinedMsg(P, r));
  bcastRoster(r); bcastMatch(r);
  pushFriendsOf(P.acc); pushParty([...(parties.get(P.acc.id) ? parties.get(P.acc.id).m : [])]);
}
function leaveRoom(P, silent) {
  const r = P.room; if (!r) return;
  if (!P.out) dropLoadout(P);
  r.players.delete(P); P.room = null;
  if (r.players.size === 0) r.emptyAt = Date.now();
  if (!silent) { sendP(P, { t: "tolobby" }); }
  if (isPvp(r) && r.ph === "play") checkEnd(r);
  else if (isPvp(r) && r.ph === "cd") { if (!enoughTeams(r)) setPhase(r, "wait"); }
  bcastRoster(r);
  if (!silent) { pushFriendsOf(P.acc); pushParty([...(parties.get(P.acc.id) ? parties.get(P.acc.id).m : [])]); }
}

// ---------- Fases da partida ----------
function enoughTeams(r) { const t = new Set(); for (const Q of r.players) if (!Q.out) t.add(Q.team); return t.size >= 2; }
function startMatch(r) {
  r.mid++; r.playAt = Date.now(); r.win = ""; r.res = null;
  resetWorld(r);
  const ts = new Set();
  for (const Q of r.players) {
    Q.team = teamKey(Q); ts.add(Q.team);
    Q.hp = SH.MAXHP; Q.ep = 0; Q.al = 1; Q.out = false; resetLoadout(Q); Q.pts = 0; Q.mk = 0; Q.zk = 0;
    if (Q.bot) botLoadout(Q);
  }
  for (const Q of r.players) { const sp = pickSpawn(r, Q); Q.x = sp[0]; Q.y = sp[1]; sendP(Q, { t: "spawn", x: Q.x, y: Q.y, hp: Q.hp, ep: 0, full: 1 }); sendSt(Q); }
  r.startTeams = ts.size;
  setPhase(r, "play");
  bcastRoster(r); bcastPk(r);
}
function endMatch(r, winTeam) {
  const list = [...r.players];
  list.sort((a, b) => (a.out - b.out) || (b.mk - a.mk));
  const names = winTeam ? list.filter((q) => q.team === winTeam).map(pname) : [];
  r.win = names.join(" e ");
  r.res = list.slice(0, 12).map((q) => ({ n: pname(q), k: q.mk, o: q.out ? 1 : 0, w: winTeam && q.team === winTeam ? 1 : 0 }));
  r.zombies = [];
  setPhase(r, "end");
}
function aliveTeams(r) { const t = new Map(); for (const Q of r.players) if (!Q.out) t.set(Q.team, (t.get(Q.team) || 0) + 1); return t; }
function checkEnd(r) {
  if (r.ph !== "play") return;
  const t = aliveTeams(r);
  if (t.size <= 1 && r.startTeams >= 2) endMatch(r, t.size ? [...t.keys()][0] : "");
  else if (r.players.size === 0) resetRoom(r);
}
function resetRoom(r) { r.ph = isPvp(r) ? "wait" : "free"; r.phAt = Date.now(); r.win = ""; r.res = null; resetWorld(r); }
function stepRoomSecond(r, now) {
  if (isPvp(r)) {
    if (r.ph === "wait" && enoughTeams(r)) setPhase(r, "cd");
    else if (r.ph === "cd") { if (!enoughTeams(r)) setPhase(r, "wait"); else if (now - r.phAt >= r.cdMs) startMatch(r); }
    else if (r.ph === "play") {
      if (now - r.playAt >= MATCH_MS) {
        let best = null; const t = new Map();
        for (const Q of r.players) if (!Q.out) t.set(Q.team, (t.get(Q.team) || 0) + Q.mk);
        for (const [k, v] of t) if (!best || v > best[1]) best = [k, v];
        endMatch(r, best ? best[0] : "");
      } else checkEnd(r);
    } else if (r.ph === "end" && now - r.phAt >= (r.endMs || END_MS)) {
      for (const Q of [...r.players]) leaveRoom(Q);
      resetRoom(r);
    }
    if (r.players.size) bcastMatch(r);
  }
  // fantasmas (conexão caiu) saem depois de um tempo
  for (const Q of [...r.players]) if (!Q.ws && Q.offAt && now - Q.offAt > GHOST_MS) leaveRoom(Q, true);
  // itens
  let ch = false;
  for (let i = r.respawns.length - 1; i >= 0; i--) if (r.respawns[i].at <= now) { spawnAmbient(r, r.respawns[i].ty); r.respawns.splice(i, 1); ch = true; }
  const nb = r.pickups.length;
  r.pickups = r.pickups.filter((p) => !p.exp || p.exp > now);
  if (r.pickups.length !== nb) ch = true;
  if (ch) bcastPk(r);
  if (r.kind === "z" && r.players.size === 0 && r.emptyAt && now - r.emptyAt > 15000) rooms.delete(r.id);
}

// ---------- Entrada nas salas (Trabalhar / Duo / Só zumbis) ----------
function zoneRoom() {
  for (const r of rooms.values()) if (r.kind === "z" && r.players.size < 15) return r;
  return makeRoom("z");
}
function lobbyMembers(P) {
  const pt = parties.get(P.acc.id), out = [P];
  if (pt) for (const id of pt.m) { const Q = sessions.get(id); if (Q && Q !== P && Q.ws && !Q.room) out.push(Q); }
  return out;
}
function requestPlay(P, mode) {
  if (!P.ws) return;
  const mem = lobbyMembers(P);
  const go = (r, notice) => { for (const Q of mem) { enterRoom(Q, r); if (notice) sendP(Q, { t: "notice", s: notice }); } };
  if (mode === "z") return go(zoneRoom());
  const pt = parties.get(P.acc.id);
  if (mode === "duo") {
    if (!pt || pt.m.length !== 2) return sendP(P, { t: "notice", s: "Para jogar em Duo, forme uma dupla com um amigo primeiro." });
    if (mem.length !== 2) return sendP(P, { t: "notice", s: "Seu parceiro precisa estar no almoço (lobby) para entrarem juntos." });
  }
  const r = mode === "duo" ? DUOROOM : GALPAO;
  const n = mem.length;
  if (r.ph === "end") return sendP(P, { t: "notice", s: "A partida está terminando. Tente de novo em instantes." });
  if (r.players.size + n > MAXP) return go(zoneRoom(), mode === "duo" ? "Sala Duo lotada (30/30). Você foi para uma sala só de zumbis." : "Galpão lotado (30/30). Você foi para uma sala só de zumbis.");
  if (r.ph === "play" && Date.now() - r.playAt > JOIN_WINDOW) return go(zoneRoom(), "Partida já passou de 3 min: não dá mais para entrar. Sala só de zumbis.");
  go(r);
}

// ---------- Eliminação (usada por jogadores e bots) ----------
function eliminate(r, P, killer) {
  if (!P.al || P.out) return;
  P.al = 0; P.hp = 0; P.ep = 0;
  dropLoadout(P); resetLoadout(P);
  let out = 0;
  if (isPvp(r) && r.ph === "play") { P.out = true; out = 1; }
  if (killer) { killer.mk++; killer.pts += 2; upgradeGun(killer); sendSt(killer); sendP(killer, { t: "got", ty: "pk" }); }
  const mk = JSON.stringify({ t: "kill", k: killer ? pname(killer) : "Zumbi", v: pname(P), kn: killer ? killer.nid : 0, out });
  for (const Q of r.players) sendP(Q, mk);
  sendSt(P);
  bcastRoster(r); bcastMatch(r);
  if (out) checkEnd(r);
}

// ---------- Mensagens do jogo ----------
function inRoomMsg(P, m, raw) {
  const r = P.room, W0 = SH.W, H0 = SH.H;
  switch (m.t) {
    case "s": {
      P.x = num(m.x, 0, W0, P.x); P.y = num(m.y, 0, H0, P.y); P.a = num(m.a, -7, 7, P.a);
      P.hp = num(m.hp, 0, SH.MAXHP, P.hp); P.ep = num(m.ep, 0, SH.MAXEP, P.ep);
      P.al = (m.al && !P.out) ? 1 : 0;
      break;
    }
    case "shot": {
      if (P.out || !P.al) return;
      const now = Date.now();
      P.shots = P.shots.filter((t) => now - t < 1000);
      if (P.shots.length >= 16) return;
      P.shots.push(now);
      const w = P.g;
      const msg = JSON.stringify({ t: "shot", n: P.nid, w, x: r1(num(m.x, 0, W0, P.x)), y: r1(num(m.y, 0, H0, P.y)), a: r2(num(m.a, -7, 7, 0)), v: r2(num(m.v, -1, 1, 0)) });
      for (const Q of r.players) if (Q !== P && Math.abs(Q.x - P.x) < 90 && Math.abs(Q.y - P.y) < 70) sendP(Q, msg);
      break;
    }
    case "mel": {
      if (P.out || !P.al || P.m < 0) return;
      const W1 = WN[P.m], now = Date.now();
      if (now - P.lastMel < 1000 / W1.rate - 40) return;
      P.lastMel = now;
      const a = num(m.a, -7, 7, P.a);
      const msg = JSON.stringify({ t: "mel", n: P.nid, a: r2(a), w: P.m });
      for (const Q of r.players) if (Q !== P && Math.abs(Q.x - P.x) < 90 && Math.abs(Q.y - P.y) < 70) sendP(Q, msg);
      const inArc = (x, y) => { const dx = x - P.x, dy = y - P.y, d = Math.hypot(dx, dy); if (d > W1.range + 0.6) return false; if (d < 0.8) return true; let da = Math.atan2(dy, dx) - a; da = Math.atan2(Math.sin(da), Math.cos(da)); return Math.abs(da) < 1.0; };
      for (const z of r.zombies.slice()) if (inArc(z.x, z.y)) { z.hp -= W1.dmg; if (z.hp <= 0) killZombie(r, z, P); }
      if (r.kind !== "z" && r.ph === "play") for (const Q of [...r.players]) if (Q !== P && Q.al && !Q.out && Q.team !== P.team && inArc(Q.x, Q.y)) { if (Q.bot) hitBot(r, Q, W1.dmg, P); else sendP(Q, { t: "mhit", n: P.nid, d: W1.dmg }); }
      break;
    }
    case "zh": {
      if (P.out || !P.al) return;
      const now = Date.now();
      P.zh = P.zh.filter((t) => now - t < 1000);
      if (P.zh.length >= 40) return;
      P.zh.push(now);
      const z = r.zombies.find((q) => q.i === m.i);
      if (!z || Math.hypot(z.x - P.x, z.y - P.y) > 60) return;
      z.hp -= WN[P.g].dmg * (m.hs ? HEAD_MUL : BODY_MUL);
      if (z.hp <= 0) killZombie(r, z, P);
      break;
    }
    case "ph": {
      if (P.out || !P.al || (isPvp(r) && r.ph !== "play")) return;
      const now = Date.now();
      P.zh = P.zh.filter((t) => now - t < 1000);
      if (P.zh.length >= 40) return;
      P.zh.push(now);
      let B = null; for (const Q of r.players) if (Q.nid === m.n && Q.bot) B = Q;
      if (!B || !B.al || B.out || B.team === P.team || B.inv > 0) return;
      if (Math.hypot(B.x - P.x, B.y - P.y) > 62) return;
      hitBot(r, B, WN[P.g].dmg * (m.hs ? HEAD_MUL : BODY_MUL), P);
      break;
    }
    case "kill": {
      const now = Date.now();
      if (!P.al || P.out || now - P.lastKill < 1500) return;
      let killer = null;
      if (m.k !== "z") {
        killer = [...r.players].find((q) => q.nid === m.k);
        if (!killer || killer === P || killer.out || !isPvp(r) || r.ph !== "play" || killer.team === P.team) killer = null;
      }
      P.lastKill = now;
      eliminate(r, P, killer);
      break;
    }
    case "resp": {
      if (P.out || P.al) return;
      if (isPvp(r) && r.ph === "play") return;
      const sp = pickSpawn(r, P); P.x = sp[0]; P.y = sp[1]; P.hp = SH.MAXHP; P.ep = 0; P.al = 1;
      sendP(P, { t: "spawn", x: P.x, y: P.y, hp: P.hp, ep: 0, full: 0 }); sendSt(P);
      break;
    }
    case "grab": {
      if (P.out || !P.al) return;
      const i = r.pickups.findIndex((p) => p.i === m.i);
      if (i < 0) return;
      const p = r.pickups[i];
      if (Math.hypot(p.x - P.x, p.y - P.y) > 5) return;
      if (p.ty === "w") {
        const W1 = WN[p.w];
        if (!W1) return;
        if (W1.k === "g") { if (P.g === p.w) return; const old = P.g; P.g = p.w; P.act = 0; r.pickups.splice(i, 1); if (old !== 0) dropItem(r, "w", old, P.x, P.y); }
        else { if (P.m === p.w) return; const old = P.m; P.m = p.w; P.act = 1; r.pickups.splice(i, 1); if (old >= 0) dropItem(r, "w", old, P.x, P.y); }
        sendSt(P);
      } else { r.pickups.splice(i, 1); sendP(P, { t: "got", ty: p.ty }); }
      if (p.amb) r.respawns.push({ at: Date.now() + (p.amb === "gun" ? 20000 : p.amb === "mel" ? 25000 : 30000), ty: p.amb });
      bcastPk(r);
      break;
    }
    case "drop": {
      if (P.out || !P.al) return;
      if (m.s === 0 && P.g !== 0) { dropItem(r, "w", P.g, P.x, P.y); P.g = 0; P.act = 0; }
      else if (m.s === 1 && P.m >= 0) { dropItem(r, "w", P.m, P.x, P.y); P.m = -1; P.act = 0; }
      else return;
      sendSt(P); bcastPk(r);
      break;
    }
    case "sw": {
      if (m.s === 1 && P.m >= 0) P.act = 1; else P.act = 0;
      sendSt(P);
      break;
    }
    case "resume": break;
  }
}

// ---------- Envio de estado (15 vezes por segundo) ----------
function snapFor(r, P, spectator, plist) {
  const p = [], z = [];
  for (const Q of plist) {
    if (Q === P) continue;
    const vis = Q.al && !Q.out;
    if (!vis) continue;
    if (!spectator && (Math.abs(Q.x - P.x) > 72 || Math.abs(Q.y - P.y) > 52)) continue;
    p.push([Q.nid, r1(Q.x), r1(Q.y), r2(Q.a), Math.round(Q.hp), Math.round(Q.ep), activeW(Q)]);
  }
  for (const q of r.zombies) {
    if (!spectator && (Math.abs(q.x - P.x) > 72 || Math.abs(q.y - P.y) > 52)) continue;
    z.push([q.i, r1(q.x), r1(q.y), r2(q.a), Math.round(q.hp)]);
  }
  return { t: "snap", p, z };
}
function startRoomLoops() {
  const ids = [];
  ids.push(setInterval(() => {
  const now = Date.now(), dt = 0.066;
  for (const r of rooms.values()) {
    if (!r.players.size) continue;
    r.tick++;
    if (r.hasBots) stepBots(r, dt, now);
    stepZombies(r, dt, now);
    const plist = [...r.players];
    for (const P of plist) {
      if (!P.ws || P.bot) continue;
      const spec = P.out || !P.al;
      sendP(P, snapFor(r, P, spec, plist));
    }
  }
}, 66));
  ids.push(setInterval(() => { const now = Date.now(); for (const r of [...rooms.values()]) stepRoomSecond(r, now); }, 1000));
  return ids;
}

// ======================= BOTS (modo offline) =======================
const BOT_NAMES = ["Rafa", "Bia", "Tião", "Jão", "Lu", "Cadu", "Nanda", "Zeca", "Mari", "Dudu", "Gabi", "Beto"];
function botLoadout(B) { B.g = 1; B.m = -1; B.act = 0; }
function addBots(r, n) {
  r.hasBots = true;
  for (let i = 0; i < n; i++) {
    const B = { bot: true, ws: null, acc: { id: "bot" + (nidSeq + 1), name: BOT_NAMES[i % BOT_NAMES.length], ci: -1 }, room: r, nid: ++nidSeq,
      shots: [], zh: [], lastMel: 0, lastKill: 0, offAt: 0, inv: 0, fireAt: 0, wa: Math.random() * 6.28, wt: 0, pts: 0, mk: 0, zk: 0, skill: 0.55 + Math.random() * 0.3 };
    B.ci = freeCi(r); B.team = "bot" + B.nid;
    B.hp = SH.MAXHP; B.ep = 0; B.al = 1; B.out = false; resetLoadout(B); botLoadout(B);
    const sp = pickSpawn(r, B); B.x = sp[0]; B.y = sp[1]; B.a = Math.random() * 6.28;
    r.players.add(B);
  }
}
function hitBot(r, B, dmg, killer) {
  if (!B.al || B.out) return;
  if (B.ep > 0) { const a = Math.min(B.ep, dmg * 0.5); B.ep -= a; dmg -= a; }
  B.hp -= dmg;
  if (B.hp <= 0) eliminate(r, B, killer);
}
function losClear(x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 1.2);
  for (let i = 1; i < n; i++) { const t = i / n; if (SH.pointHit(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false; }
  return true;
}
function botRange(w) { const W1 = WN[w]; return Math.min(46, W1.spd * W1.life * 0.9); }
function stepBots(r, dt, now) {
  const bots = []; for (const Q of r.players) if (Q.bot && Q.al && !Q.out) bots.push(Q);
  if (!bots.length) return;
  const pvp = isPvp(r) && r.ph === "play";
  if (!pvp && isPvp(r)) return;
  const all = []; for (const Q of r.players) if (Q.al && !Q.out) all.push(Q);
  for (const B of bots) {
    // alvo: inimigo mais próximo com linha de visão, senão caça o humano mais próximo
    let tgt = null, bd = 1e9, hunt = null, hd = 1e9;
    for (const Q of all) {
      if (Q === B || Q.team === B.team) continue;
      const d = Math.hypot(Q.x - B.x, Q.y - B.y);
      if (!Q.bot && d < hd) { hd = d; hunt = Q; }
      if (d < bd && d < 42 && losClear(B.x, B.y, Q.x, Q.y)) { bd = d; tgt = Q; }
    }
    let zt = null, zd = 1e9;
    for (const z of r.zombies) { const d = Math.hypot(z.x - B.x, z.y - B.y); if (d < zd && d < 16 && losClear(B.x, B.y, z.x, z.y)) { zd = d; zt = z; } }
    let ang = B.wa, sp = 0, aim = null;
    const rng = botRange(B.g);
    if (tgt && (!zt || bd < zd + 4)) {
      aim = [tgt.x, tgt.y]; const d = bd;
      ang = Math.atan2(tgt.y - B.y, tgt.x - B.x);
      if (d > rng * 0.65) sp = 6.2;
      else if (d < 7) { sp = 5; ang += Math.PI; }
      else { sp = 4.5; ang += (Math.sin(now / 700 + B.nid) > 0 ? 1.4 : -1.4); }
    } else if (zt) {
      aim = [zt.x, zt.y]; const d = zd;
      ang = Math.atan2(zt.y - B.y, zt.x - B.x);
      if (d < 6) { sp = 6; ang += Math.PI; } else sp = 0;
    } else if (hunt) {
      ang = Math.atan2(hunt.y - B.y, hunt.x - B.x); sp = 6.4;
    } else {
      B.wt -= dt; if (B.wt <= 0) { B.wt = 1.5 + Math.random() * 2; B.wa = Math.random() * 6.28; }
      ang = B.wa; sp = 4;
    }
    // movimento com desvio de obstáculos
    if (sp > 0) {
      const offs = [0, 0.7, -0.7, 1.4, -1.4, 2.2];
      let moved = false;
      for (const off of offs) {
        const a2 = ang + off, nx = B.x + Math.cos(a2) * sp * dt, ny = B.y + Math.sin(a2) * sp * dt;
        if (!SH.circleHit(nx, ny, SH.PR)) { B.x = nx; B.y = ny; moved = true; break; }
        if (!SH.circleHit(nx, B.y, SH.PR)) { B.x = nx; moved = true; break; }
        if (!SH.circleHit(B.x, ny, SH.PR)) { B.y = ny; moved = true; break; }
      }
      if (!moved) B.wt = 0;
    }
    if (aim) {
      const da = Math.atan2(aim[1] - B.y, aim[0] - B.x);
      let diff = Math.atan2(Math.sin(da - B.a), Math.cos(da - B.a));
      B.a += diff * Math.min(1, dt * 9);
      // atirar
      const W1 = WN[B.g], gap = (1000 / W1.rate) * (1.5 + (1 - B.skill) * 2);
      if (now >= B.fireAt && Math.abs(diff) < 0.35) {
        B.fireAt = now + gap;
        const err = (Math.random() - 0.5) * (0.16 + (1 - B.skill) * 0.28);
        const sa = B.a + err;
        const dist0 = Math.max(4, aim ? Math.hypot(aim[0] - B.x, aim[1] - B.y) : 20), th = 1.7 + (Math.random() < 0.1 + B.skill * 0.1 ? 1.5 : 0) + (Math.random() - 0.5) * 0.5;
        const msg = JSON.stringify({ t: "shot", n: B.nid, w: B.g, x: r1(B.x), y: r1(B.y), a: r2(sa), v: r2(Math.max(-1, Math.min(1, (th - 1.75) / dist0))) });
        for (const Q of r.players) if (Q !== B && !Q.bot && Math.abs(Q.x - B.x) < 90 && Math.abs(Q.y - B.y) < 70) sendP(Q, msg);
        // bots contra bots e zumbis: acerto por varredura (contra o humano, o cliente decide com a própria bala)
        const dx = Math.cos(sa), dy = Math.sin(sa), reach = W1.spd * W1.life;
        let best = null, bt = reach;
        const consider = (o, isZ) => {
          const rx = o.x - B.x, ry = o.y - B.y, t = rx * dx + ry * dy;
          if (t < 0 || t > bt) return;
          if (Math.abs(rx * dy - ry * dx) > (isZ ? ZR : SH.PR) + 0.25) return;
          if (!losClear(B.x, B.y, o.x, o.y)) return;
          bt = t; best = [o, isZ];
        };
        for (const Q of all) if (Q !== B && Q.bot && Q.team !== B.team) consider(Q, false);
        for (const z of r.zombies) consider(z, true);
        if (best) {
          const dmg = W1.dmg * (W1.pel || 1) * 0.6 * (Math.random() < 0.12 ? HEAD_MUL : BODY_MUL);
          if (best[1]) { best[0].hp -= dmg; if (best[0].hp <= 0) killZombie(r, best[0], B); }
          else hitBot(r, best[0], dmg, B);
        }
      }
    }
    // pegar item próximo (arma melhor, curativo)
    if (r.tick % 8 === (B.nid % 8)) {
      for (let i = 0; i < r.pickups.length; i++) {
        const p = r.pickups[i];
        if (Math.hypot(p.x - B.x, p.y - B.y) > 2.2) continue;
        if (p.ty === "w") {
          const W1 = WN[p.w];
          if (W1.k !== "g" || SH.PROG.indexOf(p.w) <= SH.PROG.indexOf(B.g) && p.w !== 3 && p.w !== 8) continue;
          if (p.w === B.g) continue;
          B.g = p.w; r.pickups.splice(i, 1);
        } else if (p.ty === "b" && B.hp < SH.MAXHP * 0.8) { B.hp = Math.min(SH.MAXHP, B.hp + 60); r.pickups.splice(i, 1); }
        else if (p.ty === "m" && B.hp < SH.MAXHP * 0.6) { B.hp = SH.MAXHP; r.pickups.splice(i, 1); }
        else continue;
        if (p.amb) r.respawns.push({ at: now + 25000, ty: p.amb });
        bcastPk(r);
        break;
      }
    }
    B.x = Math.max(1, Math.min(SH.W - 1, B.x)); B.y = Math.max(1, Math.min(SH.H - 1, B.y));
  }
}

// ======================= CONEXÕES =======================
function authReply(P, extra) {
  const a = P.acc;
  sendP(P, Object.assign({ t: "auth", ok: true, id: a.id, name: a.name, perm: PERMANENT, ci: a.ci }, extra || {}));
  sendP(P, friendsPayload(a));
  sendP(P, partyMsg(P));
  pushFriendsOf(a);
}
function attach(c, a, extra) {
  let P = sessions.get(a.id);
  if (P && P.ws && P.ws !== c.ws) { try { sendP(P, { t: "kicked" }); P.ws.close(); } catch (e) {} }
  if (!P) { P = { acc: a, ws: null, room: null, nid: 0, ci: 0, x: 0, y: 0, a: 0, hp: SH.MAXHP, ep: 0, al: 1, out: false, team: a.id, g: 0, m: -1, act: 0, pts: 0, mk: 0, zk: 0, shots: [], zh: [], lastMel: 0, lastKill: 0, offAt: 0, lastSeen: Date.now() }; sessions.set(a.id, P); }
  P.ws = c.ws; P.offAt = 0; c.P = P; P.acc = a;
  authReply(P, extra);
  if (P.room) sendP(P, joinedMsg(P, P.room));
  else sendP(P, { t: "lobby" });
  return P;
}
function validName(n) { return NAME_RE.test(n); }
function send(c, o) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); }
function handleAuth(c, m) {
  const now = Date.now();
  c.authTries = (c.authTries || []).filter((t) => now - t < 60000);
  if (c.authTries.length >= 12) return send(c, { t: "auth", ok: false, err: "Muitas tentativas. Aguarde um minuto." });
  c.authTries.push(now);
  if (m.t === "hello") {
    if (m.id && m.token) {
      const a = accts[String(m.id)];
      if (a && a.th === sha(m.token)) return attach(c, a);
      return send(c, { t: "auth", ok: false, code: "badtoken", err: "Sua conta não foi encontrada neste servidor (ele pode ter reiniciado). Entre com o código de recuperação ou crie de novo." });
    }
    const name = String(m.name || "").trim();
    if (!validName(name)) return send(c, { t: "auth", ok: false, err: "Use de 3 a 12 letras, números, _ ou -, sem espaço." });
    if (byKey.has(name.toLowerCase())) return send(c, { t: "auth", ok: false, code: "taken", err: "Esse nome já tem dono. Se é você, use \"Já tenho conta\" com seu código de recuperação." });
    const id = rid(6), token = rid(18), rec = newRecovery();
    const a = { id, name, key: name.toLowerCase(), th: sha(token), rh: sha(rec), fr: [], req: [], created: Date.now() };
    accts[id] = a; byKey.set(a.key, id); markDirty();
    return attach(c, a, { token, rec, fresh: 1 });
  }
  if (m.t === "recover") {
    const name = String(m.name || "").trim().toLowerCase(), code = String(m.code || "").trim().toUpperCase();
    const id = byKey.get(name), a = id && accts[id];
    if (!a || a.rh !== sha(code)) return send(c, { t: "auth", ok: false, err: "Nome ou código incorreto." });
    const token = rid(18); a.th = sha(token); markDirty();
    return attach(c, a, { token });
  }
}

function acceptFriend(a, t) {
  a.req = a.req.filter((x) => x !== t.id); t.req = t.req.filter((x) => x !== a.id);
  if (!a.fr.includes(t.id)) a.fr.push(t.id);
  if (!t.fr.includes(a.id)) t.fr.push(a.id);
  markDirty(); pushFriends(a.id); pushFriends(t.id);
  const Q = sessions.get(t.id); if (Q) sendP(Q, { t: "note", s: a.name + " agora é seu amigo." });
}
function handleLobbyMsg(P, m) {
  const a = P.acc;
  switch (m.t) {
    case "rename": {
      const now = Date.now();
      if (now - (P.lastRename || 0) < 5000) return;
      P.lastRename = now;
      const name = String(m.name || "").trim();
      if (!validName(name)) return sendP(P, { t: "err", s: "Nome inválido: use de 3 a 12 letras, números, _ ou -." });
      const key = name.toLowerCase(), other = byKey.get(key);
      if (other && other !== a.id) return sendP(P, { t: "err", s: "Esse nome já está em uso." });
      byKey.delete(a.key); a.name = name; a.key = key; byKey.set(key, a.id); markDirty();
      sendP(P, { t: "renamed", name });
      pushFriendsOf(a); pushFriends(a.id);
      const pt = parties.get(a.id); if (pt) pushParty(pt.m);
      if (P.room) bcastRoster(P.room);
      break;
    }
    case "color": { const c = m.ci | 0; if (c >= 0 && c < 8) { a.ci = c; markDirty(); } break; }
    case "newrec": { const rec = newRecovery(); a.rh = sha(rec); markDirty(); sendP(P, { t: "rec", rec }); break; }
    case "fsearch": {
      const q = String(m.q || "").trim();
      if (q[0] !== "@") return sendP(P, { t: "fres", q, list: [], err: "Comece a busca com @ (exemplo: @maria)." });
      const s = q.slice(1).trim().toLowerCase();
      if (s.length < 2) return sendP(P, { t: "fres", q, list: [], err: "Digite pelo menos 2 letras depois do @." });
      const list = [];
      const ex = byKey.get(s);
      if (ex && ex !== a.id) list.push(ex);
      for (const [k, id] of byKey) { if (list.length >= 8) break; if (id !== a.id && id !== ex && k.startsWith(s)) list.push(id); }
      sendP(P, { t: "fres", q, list: list.map((id) => ({ id, n: accts[id].name, fr: a.fr.includes(id) ? 1 : 0, sent: accts[id].req.includes(a.id) ? 1 : 0 })) });
      break;
    }
    case "fadd": {
      const t = accts[String(m.id)];
      if (!t || t.id === a.id || a.fr.includes(t.id)) return;
      if (a.req.includes(t.id)) return acceptFriend(a, t);
      if (!t.req.includes(a.id)) { t.req.push(a.id); if (t.req.length > 50) t.req.shift(); markDirty(); }
      pushFriends(t.id);
      const Q = sessions.get(t.id); if (Q) sendP(Q, { t: "note", s: a.name + " quer ser seu amigo. Abra Amigos+." });
      sendP(P, { t: "note", s: "Pedido enviado para " + t.name + "." });
      break;
    }
    case "facc": { const t = accts[String(m.id)]; if (t && a.req.includes(t.id)) acceptFriend(a, t); break; }
    case "frej": { a.req = a.req.filter((x) => x !== m.id); markDirty(); pushFriends(a.id); break; }
    case "fdel": {
      const t = accts[String(m.id)];
      a.fr = a.fr.filter((x) => x !== m.id); if (t) t.fr = t.fr.filter((x) => x !== a.id);
      markDirty(); pushFriends(a.id); if (t) pushFriends(t.id);
      break;
    }
    case "pinv": {
      const t = accts[String(m.id)];
      if (!t || !a.fr.includes(t.id)) return;
      const Q = sessions.get(t.id);
      if (!Q || !Q.ws) return sendP(P, { t: "note", s: t.name + " está offline." });
      if (parties.get(a.id)) return sendP(P, { t: "note", s: "Você já está em uma dupla." });
      if (parties.get(t.id)) return sendP(P, { t: "note", s: t.name + " já está em uma dupla." });
      invites.set(t.id, { from: a.id, at: Date.now() });
      sendP(Q, { t: "pinvite", id: a.id, n: a.name });
      sendP(P, { t: "note", s: "Convite de dupla enviado para " + t.name + "." });
      break;
    }
    case "pacc": {
      const inv = invites.get(a.id);
      if (!inv || inv.from !== m.id || Date.now() - inv.at > 120000) return sendP(P, { t: "note", s: "Esse convite expirou." });
      invites.delete(a.id);
      if (parties.get(a.id) || parties.get(inv.from)) return sendP(P, { t: "note", s: "Um dos dois já está em outra dupla." });
      const pt = { m: [inv.from, a.id] };
      parties.set(inv.from, pt); parties.set(a.id, pt);
      pushParty(pt.m);
      const F = sessions.get(inv.from); if (F) sendP(F, { t: "note", s: a.name + " aceitou. Dupla formada!" });
      break;
    }
    case "pdec": invites.delete(a.id); break;
    case "pleave": leaveParty(P); break;
    case "play": requestPlay(P, m.mode === "duo" ? "duo" : m.mode === "z" ? "z" : "g"); break;
  }
}

wss.on("connection", (ws) => {
  const c = { ws, P: null, authTries: [], cnt: 0, cntAt: 0 };
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  send(c, { t: "hello", perm: PERMANENT });
  ws.on("message", (raw, isBin) => {
    const now = Date.now();
    if (now - c.cntAt > 1000) { c.cntAt = now; c.cnt = 0; }
    if (++c.cnt > 120) return;
    const P = c.P;
    if (isBin) {
      // voz: só vai para o parceiro da dupla, e só na mesma sala
      if (!P || !P.room || raw.length > 1500) return;
      const Q = partnerOf(P);
      if (Q && Q.room === P.room) sendRaw(Q, raw);
      return;
    }
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;
    if (m.t === "hello" || m.t === "recover") { if (!P) handleAuth(c, m); return; }
    if (!P) return;
    P.lastSeen = now;
    if (m.t === "leave") { if (P.room) leaveRoom(P); return; }
    if (P.room) { if (m.t !== "play") inRoomMsg(P, m); return; }
    handleLobbyMsg(P, m);
  });
  ws.on("close", () => {
    const P = c.P;
    if (!P || P.ws !== ws) return;
    P.ws = null; P.offAt = Date.now();
    pushFriendsOf(P.acc);
    const pt = parties.get(P.acc.id); if (pt) pushParty(pt.m);
  });
  ws.on("error", () => {});
});

startRoomLoops();
setInterval(() => {
  const now = Date.now();
  for (const [id, P] of sessions) {
    if (!P.ws && !P.room && P.offAt && now - P.offAt > GHOST_MS) { leaveParty(P); sessions.delete(id); invites.delete(id); }
  }
  for (const [id, inv] of invites) if (now - inv.at > 120000) invites.delete(id);
}, 5000);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 15000);

const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) {
  const lib = SELF.startsWith("https") ? https : http;
  setInterval(() => { try { lib.get(SELF.replace(/\/$/, "") + "/healthz", (r) => r.resume()).on("error", () => {}); } catch (e) {} }, 10 * 60 * 1000);
}

loadAccts().then(() => server.listen(PORT, () => console.log("Arena do Galpão no ar na porta " + PORT)));
process.on("SIGTERM", async () => { dirty = true; try { await saveNow(); } catch (e) {} process.exit(0); });
