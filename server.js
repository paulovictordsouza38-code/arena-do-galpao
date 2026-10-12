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
const MAX_PLAYERS = 15;
const MAX_WEAPON = 5;           // 0 pistolas duplas, 1 MP40, 2 UMP, 3 FAMAS, 4 SCAR, 5 M4A1

// ---------- HTTP ----------
let indexBuf = null, indexGz = null;
function loadIndex() {
  try { indexBuf = fs.readFileSync(INDEX); indexGz = zlib.gzipSync(indexBuf, { level: 9 }); } catch (e) { indexBuf = null; indexGz = null; }
}
loadIndex();

// arquivos do app instalável (lidos uma vez ao ligar)
const STATIC = {};
for (const [url, file, type] of [
  ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"],
  ["/sw.js", "sw.js", "text/javascript; charset=utf-8"],
  ["/icon-192.png", "icon-192.png", "image/png"],
  ["/icon-512.png", "icon-512.png", "image/png"],
  ["/icon-maskable-512.png", "icon-maskable-512.png", "image/png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
]) {
  try { STATIC[url] = { buf: fs.readFileSync(path.join(__dirname, file)), type }; } catch (e) {}
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  const st = STATIC[String(req.url).split("?")[0]];
  if (st) {
    res.writeHead(200, { "Content-Type": st.type, "Cache-Control": st.type.startsWith("image") ? "public, max-age=86400" : "no-cache" });
    res.end(st.buf); return;
  }
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

// ---------- Regras da partida ----------
const MAX_DEATHS = 5;               // 5 quedas = fora da partida (vira espectador)
const COUNTDOWN_MS = 8000;          // contagem antes de começar
const END_MS = 14000;               // tela de resultado antes da próxima partida
const MATCH_MAX_MS = 6 * 60000;     // limite de tempo da partida
const LATE_JOIN_MS = 60000;         // depois disso, quem chega só assiste até a próxima
const GHOST_MS = 20000;             // tempo para quem caiu da internet voltar sem ser descartado
const DMG = [12, 9, 11, 14, 22, 17];   // dano de cada arma (usado contra zumbis; o cliente usa os mesmos valores)
const SOLIDS = [[0,0,150,1.6],[0,94.4,150,1.6],[0,1.6,1.6,92.8],[148.4,1.6,1.6,92.8],[12,12,32,1.4],[52,12,38,1.4],[12,64.6,32,1.4],[52,64.6,38,1.4],[12,13.4,1.4,20.6],[12,42,1.4,22.6],[88.6,13.4,1.4,8.6],[88.6,30,1.4,18],[88.6,56,1.4,8.6],[19.8,18,2.4,14],[19.8,46,2.4,14],[27.8,18,2.4,14],[27.8,46,2.4,14],[35.8,18,2.4,14],[35.8,46,2.4,14],[57.8,18,2.4,14],[57.8,46,2.4,14],[65.8,18,2.4,14],[65.8,46,2.4,14],[73.8,18,2.4,14],[73.8,46,2.4,14],[24,36,3,3],[60,38,3.2,3.2],[78,41,3,3],[56,43,2.6,2.6],[15,15,3,3],[84,15,3,3],[15,60,3,3],[84,60,3,3],[98,12,14,5.2],[118,12,14,5.2],[98,62,14,5.2],[120,62,14,5.2],[106,28,5.2,14],[134,34,5.2,14],[120,30,8,4],[116,50,8,4],[140,14,4,8],[140,58,4,8],[100,22,2.6,2.6],[126,42,3,3],[108,50,3,3],[140,46,2.6,2.6],[12,80,8,4],[34,84,8,4],[58,80,8,4],[108,82,8,4],[130,78,8,4],[88,76,7,6],[30,4,8,4],[66,4.5,8,4],[108,4,8,4],[3.5,22,4,8],[3.5,48,4,8],[3.5,72,4,8],[46,72,3,3],[80,86,3,3],[122,88,3,3]];   // paredes e objetos do mapa [x, y, largura, altura]

const wss = new WebSocketServer({ server, maxPayload: 2048 });
const conns = new Set();       // jogadores conectados e já dentro
const byName = new Map();      // nome em minúsculas -> conexão
const accs = new Map();        // nome em minúsculas -> conta { name, k, d, md, mk, out, part, w, lastSeen }
let ph = "lobby", phAt = Date.now(), mid = 1, matchAt = 0, winner = "", lastRes = null;

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
function circleHit(x, y, r) {
  for (let i = 0; i < SOLIDS.length; i++) {
    const s = SOLIDS[i];
    const dx = x - Math.min(Math.max(x, s[0]), s[0] + s[2]), dy = y - Math.min(Math.max(y, s[1]), s[1] + s[3]);
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

// ---------- Itens espalhados pelo mapa ----------
// Pontos livres do mapa (conferidos contra as paredes e objetos do jogo).
const SLOTS = [
  [48, 24], [48, 36], [48, 54], [30, 36], [72, 36], [84, 30], [84, 48], [42, 60], [54, 48], [66, 36],
  [96, 36], [102, 48], [114, 24], [132, 24], [132, 54], [120, 42], [144, 36], [102, 30],
  [24, 78], [48, 78], [72, 84], [84, 72], [102, 84], [126, 84], [144, 84], [60, 72],
  [6, 42], [6, 60], [54, 6], [84, 6], [120, 6], [18, 36],
];
const MAX_GUNS = 8, MAX_BANDAGES = 3;
const GUN_RESPAWN_MS = 15000, BANDAGE_RESPAWN_MS = 25000, DROP_LIFE_MS = 60000;
const TIER_WEIGHTS = [0, 30, 25, 20, 15, 10];
let pickups = [];              // { i, ty: "w"|"b"|"m", w, x, y, slot, exp }
let nextPickupId = 1;
let respawns = [];             // { at, ty }

function randomTier() {
  let total = 0;
  for (let i = 1; i <= MAX_WEAPON; i++) total += TIER_WEIGHTS[i];
  let r = Math.random() * total;
  for (let i = 1; i <= MAX_WEAPON; i++) { r -= TIER_WEIGHTS[i]; if (r <= 0) return i; }
  return 1;
}
function spawnPickup(ty) {
  const used = new Set(pickups.map((p) => p.slot));
  const free = [];
  for (let i = 0; i < SLOTS.length; i++) if (!used.has(i)) free.push(i);
  if (!free.length) return;
  const slot = free[Math.floor(Math.random() * free.length)];
  pickups.push({ i: nextPickupId++, ty, w: ty === "w" ? randomTier() : 0, x: SLOTS[slot][0], y: SLOTS[slot][1], slot, exp: 0 });
}
function dropItem(ty, x, y) {
  pickups.push({ i: nextPickupId++, ty, w: 0, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, slot: -1, exp: Date.now() + DROP_LIFE_MS });
}
function pickupList() { return pickups.map((p) => ({ i: p.i, ty: p.ty, w: p.w, x: p.x, y: p.y })); }
function broadcastPickups() { broadcast({ t: "pk", list: pickupList() }); }
function resetPickups() {
  pickups = []; respawns = [];
  for (let i = 0; i < MAX_GUNS; i++) spawnPickup("w");
  for (let i = 0; i < 2; i++) spawnPickup("b");
  broadcastPickups();
}
resetPickups();

// ---------- Zumbis ----------
const MAX_ZOMBIES = 3, ZOMBIE_HP = 150, ZOMBIE_SPEED = 3.4, ZOMBIE_R = 0.9;
let zombies = [], nextZid = 1, nextZombieAt = 0;
function fighters() {   // jogadores que podem ser atacados
  const out = [];
  for (const c of conns) if (c.al && !c.acc.out && c.hp > 0) out.push(c);
  return out;
}
function spawnZombie() {
  const fs_ = fighters();
  let best = null, bd = -1;
  for (let n = 0; n < 12; n++) {
    const s = SLOTS[Math.floor(Math.random() * SLOTS.length)];
    let d = 1e9;
    for (const f of fs_) d = Math.min(d, Math.hypot(f.x - s[0], f.y - s[1]));
    if (d > bd) { bd = d; best = s; }
  }
  if (!best) return;
  zombies.push({ i: nextZid++, x: best[0], y: best[1], a: Math.random() * 6, hp: ZOMBIE_HP, hit: 0, wander: 0, wa: 0 });
}
function stepZombies(dt) {
  const now = Date.now(), fs_ = fighters();
  for (const z of zombies) {
    let tgt = null, bd = 45;
    for (const f of fs_) { const d = Math.hypot(f.x - z.x, f.y - z.y); if (d < bd) { bd = d; tgt = f; } }
    let ang = z.a, sp = 0;
    if (tgt) { ang = Math.atan2(tgt.y - z.y, tgt.x - z.x); sp = bd > 1.5 ? ZOMBIE_SPEED : 0; }
    else {
      z.wander -= dt;
      if (z.wander <= 0) { z.wander = 1.5 + Math.random() * 2.5; z.wa = Math.random() * 6.283; z.idle = Math.random() < 0.3; }
      ang = z.wa; sp = z.idle ? 0 : 1.4;
    }
    z.a = ang;
    const nx = z.x + Math.cos(ang) * sp * dt, ny = z.y + Math.sin(ang) * sp * dt;
    if (!circleHit(nx, z.y, ZOMBIE_R) && nx > 1 && nx < W - 1) z.x = nx; else if (!tgt) z.wander = 0;
    if (!circleHit(z.x, ny, ZOMBIE_R) && ny > 1 && ny < H - 1) z.y = ny; else if (!tgt) z.wander = 0;
    z.hit -= dt;
    if (tgt && bd < 2.0 && z.hit <= 0) { z.hit = 0.9; send(tgt.ws, { t: "zhit", d: 22 }); }
  }
}

// ---------- Estado da partida ----------
function aliveAcc(a) { return a.part && !a.out && (a.on || Date.now() - a.lastSeen < GHOST_MS); }
function roster() {
  const p = [];
  for (const c of conns) p.push({ id: c.id, n: c.name, ci: c.ci, k: c.acc.k, d: c.acc.d, mk: c.acc.mk });
  return p;
}
function sendRoster() { broadcast({ t: "ro", p: roster() }); }
function matchMsg(withRes) {
  const dur = ph === "cd" ? COUNTDOWN_MS : ph === "end" ? END_MS : ph === "play" ? MATCH_MAX_MS : 0;
  const m = { t: "match", ph, mid, left: dur ? Math.max(0, Math.ceil((phAt + dur - Date.now()) / 1000)) : 0 };
  if (ph === "end" || withRes) { m.win = winner; m.res = lastRes; }
  return m;
}
function setPhase(p) { ph = p; phAt = Date.now(); broadcast(matchMsg(true)); }
function startMatch() {
  mid++; matchAt = Date.now(); winner = ""; lastRes = null;
  for (const a of accs.values()) { a.part = false; a.out = false; a.md = 0; a.mk = 0; a.w = 0; }
  for (const c of conns) { c.acc.part = true; c.hp = 200; c.al = 1; c.acc.on = true; }
  zombies = []; nextZombieAt = Date.now() + 15000;
  resetPickups();
  setPhase("play");
  sendRoster();
}
function endMatch() {
  const list = [];
  for (const a of accs.values()) if (a.part) list.push(a);
  list.sort((x, y) => x.md - y.md || (x.out - y.out) || (y.outAt || 0) - (x.outAt || 0) || y.mk - x.mk);
  winner = list.length ? list[0].name : "";
  lastRes = list.slice(0, 15).map((a) => ({ n: a.name, md: a.md, k: a.mk, o: a.out ? 1 : 0 }));
  zombies = [];
  setPhase("end");
}
function checkEnd() {
  if (ph !== "play") return;
  let part = 0, alive = 0;
  for (const a of accs.values()) if (a.part) { part++; if (aliveAcc(a)) alive++; }
  if (Date.now() - matchAt > MATCH_MAX_MS || (part >= 2 && alive <= 1) || part === 0) endMatch();
}

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
  if (conns.size >= MAX_PLAYERS && !(old && old.sid === sid)) return reply({ ok: false, err: "Partida cheia (máximo " + MAX_PLAYERS + " jogadores)." });

  let a = accs.get(key);
  if (!a) {
    a = { name, k: 0, d: 0, md: 0, mk: 0, out: false, part: false, w: 0, lastSeen: Date.now(), on: false, outAt: 0 };
    accs.set(key, a);
    if (ph === "play") {
      if (Date.now() - matchAt < LATE_JOIN_MS) a.part = true;
      else a.out = true;                       // chegou tarde: assiste até a próxima partida
    } else a.part = ph !== "end";
  }
  a.on = true;
  c.authed = true; c.key = key; c.sid = sid; c.acc = a; c.name = a.name; c.ci = freeColor();
  c.x = 48; c.y = 40; c.al = a.out ? 0 : 1; c.hp = 200; c.ep = 0;
  byName.set(key, c); conns.add(c);
  reply({ ok: true, id: c.id, name: a.name, k: a.k, d: a.d, ci: c.ci, pk: pickupList() });
  send(c.ws, matchMsg(true));
  sendRoster();
}

wss.on("connection", (ws) => {
  const c = {
    ws, id: crypto.randomBytes(4).toString("hex"), sid: "",
    authed: false, key: null, acc: null, name: "", ci: 0,
    x: 48, y: 40, a: 0, hp: 200, ep: 0, al: 1, shots: [], zh: [], lastKill: 0,
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
    const a = c.acc;

    if (m.t === "s") {
      c.x = num(m.x, 0, W, c.x); c.y = num(m.y, 0, H, c.y); c.a = num(m.a, -7, 7, c.a);
      c.hp = num(m.hp, 0, 200, c.hp); c.ep = num(m.ep, 0, 100, c.ep); c.al = (m.al && !a.out) ? 1 : 0;
    } else if (m.t === "shot") {
      if (a.out) return;
      const now = Date.now();
      c.shots = c.shots.filter((t) => now - t < 1000);
      if (c.shots.length >= 14) return;
      c.shots.push(now);
      // quem decide qual arma disparou é o servidor, não o aparelho
      const msg = JSON.stringify({ t: "shot", id: c.id, w: a.w, x: num(m.x, 0, W, c.x), y: num(m.y, 0, H, c.y), a: num(m.a, -7, 7, 0) });
      for (const o of conns) if (o !== c && o.ws.readyState === 1) o.ws.send(msg);
    } else if (m.t === "kill") {
      // quem morreu avisa quem o derrubou (ou "z" se foi um zumbi)
      const now = Date.now();
      if (now - c.lastKill < 1500 || a.out) return;
      let killer = null;
      if (m.killer !== "z") {
        for (const o of conns) if (o.id === m.killer) killer = o;
        if (!killer || killer === c || killer.acc.out) return;
      }
      c.lastKill = now;
      a.d++;
      a.w = 0;                                          // quem caiu volta às pistolas
      if (killer) { killer.acc.k++; killer.acc.mk++; killer.acc.w = Math.min(MAX_WEAPON, killer.acc.w + 1); }
      let outNow = false;
      if (ph === "play" && a.part) {
        a.md++;
        if (a.md >= MAX_DEATHS) { a.out = true; a.outAt = now; c.al = 0; outNow = true; }
      }
      broadcast({ t: "kill", k: killer ? killer.name : "Zumbi", v: c.name, kid: killer ? killer.id : "", out: outNow ? 1 : 0 });
      sendRoster();
      if (outNow) checkEnd();
    } else if (m.t === "grab") {
      const idx = pickups.findIndex((p) => p.i === m.i);
      if (idx < 0 || !c.al || a.out) return;
      const p = pickups[idx];
      if (Math.hypot(p.x - c.x, p.y - c.y) > 6) return;   // precisa estar perto
      if (p.ty === "w") {
        if (p.w <= a.w) return;                         // arma só vale se for melhor que a atual
        a.w = p.w;
      } else send(ws, { t: "got", ty: p.ty });          // atadura ou kit médico: o aparelho decide se usa ou guarda
      pickups.splice(idx, 1);
      if (p.slot >= 0) respawns.push({ at: Date.now() + (p.ty === "w" ? GUN_RESPAWN_MS : BANDAGE_RESPAWN_MS), ty: p.ty });
      broadcastPickups();
    } else if (m.t === "zh") {
      // acertou um zumbi
      const now = Date.now();
      c.zh = c.zh.filter((t) => now - t < 1000);
      if (c.zh.length >= 16 || a.out) return;
      c.zh.push(now);
      const z = zombies.find((q) => q.i === m.i);
      if (!z || Math.hypot(z.x - c.x, z.y - c.y) > 50) return;
      z.hp -= DMG[a.w] || 12;
      if (z.hp <= 0) {
        zombies.splice(zombies.indexOf(z), 1);
        dropItem(Math.random() < 0.5 ? "m" : "b", z.x, z.y);
        send(ws, { t: "got", ty: "zk" });              // recompensa direta: EP
        broadcast({ t: "zdead", n: c.name });
        broadcastPickups();
      }
    }
  });

  ws.on("close", () => {
    conns.delete(c);
    if (c.key && byName.get(c.key) === c) byName.delete(c.key);
    if (c.acc && !byName.has(c.key)) { c.acc.on = false; c.acc.lastSeen = Date.now(); }
    if (c.authed) sendRoster();
  });
  ws.on("error", () => {});
});

// 20 atualizações por segundo para todo mundo (mensagem enxuta: nomes e cores vão à parte, em "ro")
let tickN = 0;
setInterval(() => {
  if (!conns.size) return;
  tickN++;
  if (ph === "play" || ph === "lobby") stepZombies(0.05);
  const p = [];
  for (const c of conns) {
    p.push({ id: c.id, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10, a: Math.round(c.a * 100) / 100, hp: Math.round(c.hp), ep: Math.round(c.ep), al: c.al, w: c.acc.w, md: c.acc.md, o: c.acc.out ? 1 : 0 });
  }
  const z = zombies.map((q) => ({ i: q.i, x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10, a: Math.round(q.a * 100) / 100, hp: Math.round(q.hp) }));
  broadcast({ t: "snap", p, z });
  if (tickN % 60 === 0) sendRoster();
}, 50);

// relógio de 1 segundo: fases da partida, itens e zumbis
setInterval(() => {
  const now = Date.now();
  if (ph === "lobby" && conns.size >= 2) setPhase("cd");
  else if (ph === "cd") {
    if (conns.size < 2) setPhase("lobby");
    else if (now - phAt >= COUNTDOWN_MS) startMatch();
  } else if (ph === "play") {
    checkEnd();
    if (conns.size === 0) { winner = ""; ph = "lobby"; phAt = now; zombies = []; }
  } else if (ph === "end" && now - phAt >= END_MS) setPhase(conns.size >= 2 ? "cd" : "lobby");
  else if (ph === "end" && !conns.size) { ph = "lobby"; phAt = now; }
  if (ph === "lobby" && conns.size === 1) { for (const a of accs.values()) { a.out = false; a.md = 0; } }
  if (conns.size) broadcast(matchMsg(false));

  // itens: renascem depois de um tempo; os soltos por zumbis somem sozinhos
  let changed = false;
  for (let i = respawns.length - 1; i >= 0; i--) {
    if (respawns[i].at <= now) { spawnPickup(respawns[i].ty); respawns.splice(i, 1); changed = true; }
  }
  const before = pickups.length;
  pickups = pickups.filter((p) => !p.exp || p.exp > now);
  if (pickups.length !== before) changed = true;
  if (changed) broadcastPickups();

  // zumbis: de vez em quando, poucos
  if ((ph === "play" || ph === "lobby") && conns.size && zombies.length < MAX_ZOMBIES && now >= nextZombieAt) {
    spawnZombie(); nextZombieAt = now + 25000 + Math.random() * 20000;
  }
}, 1000);

// derruba conexões que sumiram (celular que desligou a tela, por exemplo)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 15000);

// Mantém o servidor acordado no plano grátis do Render: ele acessa o próprio endereço público a cada 10 minutos.
// (O Render define RENDER_EXTERNAL_URL sozinho; fora do Render isso não faz nada.)
const SELF = process.env.RENDER_EXTERNAL_URL;
if (SELF) {
  const lib = SELF.startsWith("https") ? require("https") : http;
  setInterval(() => {
    try { lib.get(SELF.replace(/\/$/, "") + "/healthz", (r) => r.resume()).on("error", () => {}); } catch (e) {}
  }, 10 * 60 * 1000);
}

server.listen(PORT, () => console.log("Arena do Galpão no ar na porta " + PORT));
