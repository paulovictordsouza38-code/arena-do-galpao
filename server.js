"use strict";
// Servidor da Arena do Galpão: entrega o jogo (index.html) e junta todos os jogadores na mesma partida.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, "index.html");
const W = 2800, H = 1800;
const MAX_PLAYERS = 40;

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  if (req.url === "/" || req.url.startsWith("/?")) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end("index.html não encontrado"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(buf);
    });
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
  c.x = 140; c.y = 140;
  byName.set(key, c); conns.add(c);
  reply({ ok: true, id: c.id, name: sc.name, k: sc.k, d: sc.d, ci: c.ci });
}

wss.on("connection", (ws) => {
  const c = {
    ws, id: crypto.randomBytes(4).toString("hex"), sid: "",
    authed: false, key: null, acc: null, name: "", ci: 0,
    x: 140, y: 140, a: 0, hp: 100, al: 1, shots: [], lastKill: 0,
  };
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  send(ws, { t: "hello", online: conns.size });

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
      if (c.shots.length >= 8) return;
      c.shots.push(now);
      const msg = JSON.stringify({ t: "shot", id: c.id, x: num(m.x, 0, W, c.x), y: num(m.y, 0, H, c.y), a: num(m.a, -7, 7, 0) });
      for (const o of conns) if (o !== c && o.ws.readyState === 1) o.ws.send(msg);
    } else if (m.t === "kill") {
      const now = Date.now();
      if (now - c.lastKill < 2000) return;
      let killer = null;
      for (const o of conns) if (o.id === m.killer) killer = o;
      if (!killer || killer === c) return;
      c.lastKill = now;
      killer.acc.k++; c.acc.d++;
      const msg = JSON.stringify({ t: "kill", k: killer.name, v: c.name, kid: killer.id });
      for (const o of conns) if (o.ws.readyState === 1) o.ws.send(msg);
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
    p.push({ id: c.id, n: c.name, x: Math.round(c.x), y: Math.round(c.y), a: Math.round(c.a * 100) / 100, hp: c.hp, al: c.al, k: c.acc.k, d: c.acc.d, ci: c.ci });
  }
  const msg = JSON.stringify({ t: "snap", p });
  for (const c of conns) if (c.ws.readyState === 1) c.ws.send(msg);
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
