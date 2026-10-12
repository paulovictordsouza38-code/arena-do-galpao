"use strict";
// Servidor da Arena do Galpão: entrega o jogo (index.html) e junta todos os jogadores na mesma partida.
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, "index.html");
const W = 150, H = 96;          // tamanho do mapa (igual ao do jogo)
const MAX_PLAYERS = 16;
const MAX_WEAPON = 5;           // 0 pistolas duplas, 1 MP40, 2 UMP, 3 FAMAS, 4 SCAR, 5 M4A1

// ---------- HTTP ----------
let indexBuf = null, indexGz = null;
function loadIndex() {
  try { indexBuf = fs.readFileSync(INDEX); indexGz = zlib.gzipSync(indexBuf, { level: 9 }); } catch (e) { indexBuf = null; indexGz = null; }
}
loadIndex();

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/" || req.url.startsWith("/?")) {
    if (!indexBuf) loadIndex();
    if (!indexBuf) { res.writeHead(500); res.end("index.html não encontrado"); return; }
    const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
    if (/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers); res.end(indexGz);
    } else {
      res.writeHead(200, headers); res.end(indexBuf);
    }
    return;
  }
  res.writeHead(404); res.end("Não encontrado");
});

// ---------- Partida ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const conns = new Set();       // jogadores que já entraram
const byName = new Map();      // nome em minúsculas -> conexão
const scores = new Map();      // nome em minúsculas -> { name, k, d } (vale enquanto o servidor estiver ligado)

function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(o) {
  const msg = JSON.stringify(o);
  for (const c of conns) if (c.ws.readyState === 1) c.ws.send(msg);
}
function freeColor() {
  const used = new Set();
  for (const c of conns) used.add(c.ci);
  for (let i = 0; i < 8; i++) if (!used.has(i)) return i;
  return Math.floor(Math.random() * 8);
}
function num(v, lo, hi, def) {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

// ---------- Armas espalhadas pelo mapa ----------
// Pontos livres do mapa (conferidos contra as paredes e objetos do jogo).
const SLOTS = [
  [48, 24], [48, 36], [48, 54], [30, 36], [72, 36], [84, 30], [84, 48], [42, 60], [54, 48], [66, 36],
  [96, 36], [102, 48], [114, 24], [132, 24], [132, 54], [120, 42], [144, 36], [102, 30],
  [24, 78], [48, 78], [72, 84], [84, 72], [102, 84], [126, 84], [144, 84], [60, 72],
  [6, 42], [6, 60], [54, 6], [84, 6], [120, 6], [18, 36],
];
const MAX_PICKUPS = 8;
const PICKUP_RESPAWN_MS = 15000;
const TIER_WEIGHTS = [0, 30, 25, 20, 15, 10];   // chance de cada arma (1 = MP40 ... 5 = M4A1)
let pickups = [];
let nextPickupId = 1;

function randomTier() {
  let total = 0;
  for (let i = 1; i <= MAX_WEAPON; i++) total += TIER_WEIGHTS[i];
  let r = Math.random() * total;
  for (let i = 1; i <= MAX_WEAPON; i++) { r -= TIER_WEIGHTS[i]; if (r <= 0) return i; }
  return 1;
}
function spawnPickup() {
  if (pickups.length >= MAX_PICKUPS) return;
  const used = new Set(pickups.map((p) => p.slot));
  const free = [];
  for (let i = 0; i < SLOTS.length; i++) if (!used.has(i)) free.push(i);
  if (!free.length) return;
  const slot = free[Math.floor(Math.random() * free.length)];
  pickups.push({ i: nextPickupId++, w: randomTier(), x: SLOTS[slot][0], y: SLOTS[slot][1], slot });
}
function pickupList() { return pickups.map((p) => ({ i: p.i, w: p.w, x: p.x, y: p.y })); }
function broadcastPickups() { broadcast({ t: "pk", list: pickupList() }); }
for (let i = 0; i < MAX_PICKUPS; i++) spawnPickup();

// ---------- Entrada na partida ----------
function handleJoin(c, m) {
  const re = m.re ? 1 : 0;
  const reply = (o) => send(c.ws, Object.assign({ t: "auth", re }, o));
  const name = String(m.name || "").trim();
  const sid = String(m.sid || "").slice(0, 40);
  if (!/^[A-Za-z0-9_-]{3,12}$/.test(name)) return reply({ ok: false, err: "Use de 3 a 12 letras, números, _ ou -, sem espaço." });
  const key = name.toLowerCase();

  const old = byName.get(key);
  if (old && old !== c) {
    // o mesmo aparelho voltando depois de uma queda pode retomar o nome; outra pessoa não
    if (old.sid && old.sid === sid) { conns.delete(old); old.ws.close(); }
    else return reply({ ok: false, err: "Esse nome já está em uso agora. Escolha outro." });
  }
  if (conns.size >= MAX_PLAYERS && !(old && old.sid === sid)) return reply({ ok: false, err: "Partida cheia." });

  let sc = scores.get(key);
  if (!sc) { sc = { name, k: 0, d: 0 }; scores.set(key, sc); }
  c.authed = true; c.key = key; c.sid = sid; c.acc = sc; c.name = sc.name; c.ci = freeColor();
  c.x = 48; c.y = 40; c.w = 0; c.al = 1; c.hp = 100;
  byName.set(key, c); conns.add(c);
  reply({ ok: true, id: c.id, name: sc.name, k: sc.k, d: sc.d, ci: c.ci, pk: pickupList() });
}

wss.on("connection", (ws) => {
  const c = {
    ws, id: crypto.randomBytes(4).toString("hex"), sid: "",
    authed: false, key: null, acc: null, name: "", ci: 0,
    x: 48, y: 40, a: 0, hp: 100, al: 1, w: 0, shots: [], lastKill: 0,
  };
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  send(ws, { t: "hello", online: conns.size, pk: pickupList() });

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "auth") {
      if (!c.authed) handleJoin(c, m);
      return;
    }
    if (!c.authed) return;

    if (m.t === "s") {
      c.x = num(m.x, 0, W, c.x); c.y = num(m.y, 0, H, c.y); c.a = num(m.a, -7, 7, c.a);
      c.hp = num(m.hp, 0, 100, c.hp); c.al = m.al ? 1 : 0;
    } else if (m.t === "shot") {
      const now = Date.now();
      c.shots = c.shots.filter((t) => now - t < 1000);
      if (c.shots.length >= 14) return;
      c.shots.push(now);
      // quem decide qual arma disparou é o servidor, não o aparelho
      const msg = JSON.stringify({ t: "shot", id: c.id, w: c.w, x: num(m.x, 0, W, c.x), y: num(m.y, 0, H, c.y), a: num(m.a, -7, 7, 0) });
      for (const o of conns) if (o !== c && o.ws.readyState === 1) o.ws.send(msg);
    } else if (m.t === "kill") {
      // quem morreu avisa quem o derrubou
      const now = Date.now();
      if (now - c.lastKill < 2000) return;
      let killer = null;
      for (const o of conns) if (o.id === m.killer) killer = o;
      if (!killer || killer === c) return;
      c.lastKill = now;
      killer.acc.k++; c.acc.d++;
      killer.w = Math.min(MAX_WEAPON, killer.w + 1);   // cada abate dá uma arma melhor
      c.w = 0;                                          // quem caiu volta às pistolas
      broadcast({ t: "kill", k: killer.name, v: c.name, kid: killer.id });
    } else if (m.t === "grab") {
      const idx = pickups.findIndex((p) => p.i === m.i);
      if (idx < 0 || !c.al) return;
      const p = pickups[idx];
      if (p.w <= c.w) return;                           // só vale se for melhor que a atual
      if (Math.hypot(p.x - c.x, p.y - c.y) > 6) return; // precisa estar perto
      c.w = p.w;
      pickups.splice(idx, 1);
      broadcastPickups();
      setTimeout(() => { spawnPickup(); broadcastPickups(); }, PICKUP_RESPAWN_MS);
    }
  });

  ws.on("close", () => {
    conns.delete(c);
    if (c.key && byName.get(c.key) === c) byName.delete(c.key);
  });
  ws.on("error", () => {});
});

// 20 atualizações por segundo para todo mundo
setInterval(() => {
  if (!conns.size) return;
  const p = [];
  for (const c of conns) {
    p.push({ id: c.id, n: c.name, x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, a: Math.round(c.a * 100) / 100, hp: c.hp, al: c.al, k: c.acc.k, d: c.acc.d, ci: c.ci, w: c.w });
  }
  broadcast({ t: "snap", p });
}, 50);

// derruba conexões que sumiram (celular que desligou a tela, por exemplo)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 15000);

server.listen(PORT, () => console.log("Arena do Galpão no ar na porta " + PORT));
