/* Wildborn game server: accounts, invite codes and play-together rooms for the Wildborn website.
   One small Node program. It keeps accounts in a SQLite file on a Railway volume and passes room updates between players.

   Settings (Railway > service > Variables):
     ADMIN_KEY        SECRET. Long random password for the admin page (/admin). Never share it or put it in the game.
     ALLOWED_ORIGINS  Websites allowed to connect, comma separated. Example: https://petradavis.github.io
     DATA_DIR         Folder for the database. Defaults to the Railway volume (RAILWAY_VOLUME_MOUNT_PATH), else ./data
     PORT             Set by Railway automatically.

   The game talks to it over one WebSocket at /ws with small JSON messages:
     signup {name,pw,code} | login {name,pw} | resume {token} | logout | chpw {old,pw}  ->  auth {ok,name,token,err}
     join {room} -> peers {room,me,list:[[peer,presence]]};  p {room,patch} -> pu {room,peer,patch};  leave {room}
     others: pj {room,peer,presence} (joined), pl {room,peer} (left)
   Presence works like Claude's rooms: each player owns a few fields; a patch replaces fields, null removes one. */
"use strict";
const http = require("node:http"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { WebSocketServer } = require("ws");
const { DatabaseSync } = require("node:sqlite");
const { mpFilter, mpPersonal, mpClean } = require("./filter.js");

const PORT = +process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const LIMITS = { field: 4600, presence: 7000, roomPlayers: 40, rooms: 4, msgsPerSec: 40, nameRe: /^[a-z0-9_]{3,16}$/, sessionDays: 60 };

/* ---------- database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "wildborn.db"));
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, invite TEXT, created INTEGER, last_seen INTEGER, banned INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, note TEXT, created INTEGER, used_by INTEGER, used_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER, last INTEGER);
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT);`);
const q = {
  userByName: db.prepare("SELECT * FROM users WHERE name = ?"), userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  addUser: db.prepare("INSERT INTO users (name, salt, hash, invite, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)"),
  setPw: db.prepare("UPDATE users SET salt = ?, hash = ? WHERE id = ?"), seen: db.prepare("UPDATE users SET last_seen = ? WHERE id = ?"),
  ban: db.prepare("UPDATE users SET banned = ? WHERE id = ?"), delUser: db.prepare("DELETE FROM users WHERE id = ?"),
  users: db.prepare("SELECT id, name, invite, created, last_seen, banned FROM users ORDER BY created"),
  invite: db.prepare("SELECT * FROM invites WHERE code = ?"), addInvite: db.prepare("INSERT INTO invites (code, note, created) VALUES (?, ?, ?)"),
  useInvite: db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL"),
  delInvite: db.prepare("DELETE FROM invites WHERE code = ? AND used_by IS NULL"), invites: db.prepare("SELECT * FROM invites ORDER BY created"),
  session: db.prepare("SELECT * FROM sessions WHERE token = ?"), addSession: db.prepare("INSERT INTO sessions (token, user_id, created, last) VALUES (?, ?, ?, ?)"),
  touchSession: db.prepare("UPDATE sessions SET last = ? WHERE token = ?"), delSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  delSessionsOf: db.prepare("DELETE FROM sessions WHERE user_id = ?"), oldSessions: db.prepare("DELETE FROM sessions WHERE last < ?"),
  getCfg: db.prepare("SELECT v FROM config WHERE k = ?"), setCfg: db.prepare("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
};
const cfg = (k, d) => { const r = q.getCfg.get(k); return r ? JSON.parse(r.v) : d; };
const setCfg = (k, v) => q.setCfg.run(k, JSON.stringify(v));
const inviteOnly = () => cfg("inviteOnly", true) !== false;
const now = () => Date.now();
const tx = f => { db.exec("BEGIN"); try { const r = f(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } };

/* invite codes look like WILD-7K2QX; stored without the dash. No 0/O/1/I so they are easy to read out loud. */
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => "WILD" + Array.from(crypto.randomBytes(5), b => CODE_ABC[b % CODE_ABC.length]).join("");
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const showCode = c => c.slice(0, 4) + "-" + c.slice(4);
function makeInvites(n, note) { const out = []; for (let i = 0; i < n; i++) { let c; do c = newCode(); while (q.invite.get(c)); q.addInvite.run(c, mpClean(note || "", 60), now()); out.push(showCode(c)); } return out; }
if (!cfg("seeded", false)) { const codes = makeInvites(10, "first 10"); setCfg("seeded", true); setCfg("inviteOnly", true); console.log("First start: made 10 invite codes. See them on the admin page (/admin)."); void codes; }

/* passwords: scrypt with a random salt per account */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
function checkPw(u, pw) { const h = Buffer.from(hashPw(pw, u.salt), "hex"), want = Buffer.from(u.hash, "hex"); return h.length === want.length && crypto.timingSafeEqual(h, want); }
const tokenHash = t => crypto.createHash("sha256").update(String(t)).digest("hex");
function newSession(uid) { const t = crypto.randomBytes(32).toString("base64url"); q.addSession.run(tokenHash(t), uid, now(), now()); return t; }
q.oldSessions.run(now() - LIMITS.sessionDays * 864e5);

/* ---------- sign-in attempts: slow down guessing (per internet address) ---------- */
const tries = new Map();
function tooMany(ip) { const t = now(), r = tries.get(ip) || { n: 0, t }; if (t - r.t > 60000) { r.n = 0; r.t = t; } r.n++; tries.set(ip, r); return r.n > 12; }
setInterval(() => { const t = now(); for (const [k, r] of tries) if (t - r.t > 120000) tries.delete(k); }, 60000).unref();

/* ---------- rooms ---------- */
const rooms = new Map();          /* room name -> Map(peer -> conn) */
const conns = new Set();
const roomName = r => String(r || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
function send(c, m) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); }
function toRoom(room, m, except) { const r = rooms.get(room); if (!r) return; const s = JSON.stringify(m); for (const c of r.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(s); }
/* clean a presence patch: the server decides your name, filters chat, and keeps fields small */
function cleanPatch(c, patch) { const out = {};
  for (const k of Object.keys(patch || {}).slice(0, 40)) { if (!/^[A-Za-z0-9_]{1,12}$/.test(k)) continue; let v = patch[k];
    if (v === null || v === undefined) { out[k] = null; continue; }
    if (k === "n" || k === "mn") v = c.name;                                   /* nobody can pretend to be someone else */
    if (k === "c" && Array.isArray(v)) v = v.slice(-3).filter(Array.isArray).map(e => { const t = String(e[1] || ""); const keep = mpPersonal(t) ? "" : mpFilter(t); return e.length > 2 ? [e[0], keep, e[2]] : [e[0], keep]; }).filter(e => e[1]);
    if (k === "t" && typeof v === "string") v = mpFilter(mpClean(v, 32));       /* public room titles */
    const s = JSON.stringify(v); if (s === undefined || s.length > LIMITS.field) continue; out[k] = JSON.parse(s); }
  return out; }
function join(c, room) { room = roomName(room); if (!room) return; if (c.rooms.has(room)) { leave(c, room); }
  if (c.rooms.size >= LIMITS.rooms) return send(c, { t: "err", room, err: "too_many_rooms" });
  let r = rooms.get(room); if (!r) rooms.set(room, r = new Map());
  if (r.size >= LIMITS.roomPlayers && room !== "__lobby") return send(c, { t: "err", room, err: "room_full" });
  c.rooms.set(room, {}); r.set(c.peer, c);
  send(c, { t: "peers", room, me: c.peer, list: [...r.values()].filter(o => o !== c).map(o => [o.peer, o.rooms.get(room) || {}]) });
  toRoom(room, { t: "pj", room, peer: c.peer, presence: {} }, c); }
function leave(c, room) { if (!c.rooms.has(room)) return; c.rooms.delete(room); const r = rooms.get(room); if (r) { r.delete(c.peer); if (!r.size) rooms.delete(room); } toRoom(room, { t: "pl", room, peer: c.peer }); }
function presence(c, room, patch) { const mine = c.rooms.get(room); if (!mine) return; const p = cleanPatch(c, patch); if (!Object.keys(p).length) return;
  for (const k in p) { if (p[k] === null) delete mine[k]; else mine[k] = p[k]; }
  if (JSON.stringify(mine).length > LIMITS.presence) { for (const k in p) delete mine[k]; return send(c, { t: "err", room, err: "too_big" }); }
  toRoom(room, { t: "pu", room, peer: c.peer, patch: p }, c); }
function dropUser(uid, why) { for (const c of conns) if (c.uid === uid) { send(c, { t: "auth", ok: false, err: why }); signOut(c); } }
function signOut(c) { for (const room of [...c.rooms.keys()]) leave(c, room); c.uid = 0; c.name = ""; }

/* ---------- accounts ---------- */
function signedIn(c, u, token) { signOut(c); c.uid = u.id; c.name = u.name;
  /* the same browser tab keeps the same player id after a dropped connection, so friends don't see a "new" player */
  const tab = String(c.tab || "").replace(/[^a-z0-9]/gi, "").slice(0, 8) || crypto.randomBytes(3).toString("hex"); c.peer = "u" + u.id + "_" + tab;
  for (const o of conns) if (o !== c && o.peer === c.peer) { signOut(o); o.ws.close(4001, "replaced"); } q.seen.run(now(), u.id); send(c, { t: "auth", ok: true, name: u.name, token, re: c.req }); }
function onAuth(c, m) { if (m.tab) c.tab = m.tab; c.req = m.t; const fail = err => send(c, { t: "auth", ok: false, err, for: m.t, re: m.t });
  if (m.t === "logout") { if (m.token) q.delSession.run(tokenHash(m.token)); signOut(c); return send(c, { t: "auth", ok: false, err: "", re: "logout" }); }
  if (m.t === "resume") { const s = q.session.get(tokenHash(m.token)); const u = s && q.userById.get(s.user_id); if (!u) return fail("signed_out"); if (u.banned) return fail("banned"); q.touchSession.run(now(), tokenHash(m.token)); return signedIn(c, u, m.token); }
  if (tooMany(c.ip)) return fail("slow_down");
  const name = String(m.name || "").trim().toLowerCase(), pw = String(m.pw || "");
  if (m.t === "login") { const u = q.userByName.get(name); if (!u || !checkPw(u, pw)) return fail("wrong"); if (u.banned) return fail("banned"); return signedIn(c, u, newSession(u.id)); }
  if (m.t === "signup") {
    if (!LIMITS.nameRe.test(name)) return fail("bad_name"); if (mpFilter(name) !== name || mpPersonal(name)) return fail("rude_name");
    if (pw.length < 6 || pw.length > 64) return fail("short_pw"); if (q.userByName.get(name)) return fail("name_taken");
    const code = normCode(m.code), only = inviteOnly();
    try { const u = tx(() => { if (only) { const inv = q.invite.get(code); if (!inv) throw new Error("bad_code"); if (inv.used_by) throw new Error("used_code"); }
        const salt = crypto.randomBytes(16).toString("hex"); const r = q.addUser.run(name, salt, hashPw(pw, salt), only ? code : "", now(), now());
        if (only && !q.useInvite.run(Number(r.lastInsertRowid), now(), code).changes) throw new Error("used_code");
        return q.userById.get(Number(r.lastInsertRowid)); });
      console.log("New account:", name); return signedIn(c, u, newSession(u.id)); }
    catch (e) { return fail(/UNIQUE/.test(e.message) ? "name_taken" : ["bad_code", "used_code"].includes(e.message) ? e.message : "error"); } }
  if (m.t === "chpw") { if (!c.uid) return fail("signed_out"); const u = q.userById.get(c.uid); if (!checkPw(u, m.old)) return fail("wrong_old"); if (pw.length < 6 || pw.length > 64) return fail("short_pw");
    const salt = crypto.randomBytes(16).toString("hex"); q.setPw.run(salt, hashPw(pw, salt), u.id); q.delSessionsOf.run(u.id); return send(c, { t: "auth", ok: true, name: u.name, token: newSession(u.id), changed: 1, re: "chpw" }); } }

/* ---------- admin page + API (needs ADMIN_KEY) ---------- */
function isAdmin(req) { const k = String(req.headers["x-admin-key"] || ""); if (!ADMIN_KEY || ADMIN_KEY.length < 12 || !k) return false; const a = Buffer.from(tokenHash(k)), b = Buffer.from(tokenHash(ADMIN_KEY)); return crypto.timingSafeEqual(a, b); }
function summary() { const online = new Set([...conns].filter(c => c.uid).map(c => c.uid));
  const names = new Map(q.users.all().map(u => [u.id, u.name]));
  return { inviteOnly: inviteOnly(), online: online.size, sentMB: Math.round(sentBytes() / 1e5) / 10, sentBytes: sentBytes(), since: SENT.since,
    rooms: [...rooms.entries()].map(([k, r]) => ({ room: k, players: [...r.values()].map(c => c.name) })),
    users: q.users.all().map(u => ({ name: u.name, created: u.created, lastSeen: u.last_seen, banned: !!u.banned, online: online.has(u.id), invite: u.invite ? showCode(u.invite) : "" })),
    invites: q.invites.all().map(i => ({ code: showCode(i.code), note: i.note, created: i.created, usedBy: i.used_by ? names.get(i.used_by) || "(deleted account)" : "" })) }; }
function adminDo(a, b) { const u = b.name ? q.userByName.get(String(b.name).toLowerCase()) : null;
  switch (a) {
    case "invites": return { made: makeInvites(Math.max(1, Math.min(50, +b.count || 1)), b.note) };
    case "delete-invite": return { ok: q.delInvite.run(normCode(b.code)).changes > 0 };
    case "invite-only": setCfg("inviteOnly", !!b.on); return { inviteOnly: inviteOnly() };
    case "ban": if (!u) return { err: "no such player" }; q.ban.run(1, u.id); q.delSessionsOf.run(u.id); dropUser(u.id, "banned"); return { ok: true };
    case "unban": if (!u) return { err: "no such player" }; q.ban.run(0, u.id); return { ok: true };
    case "reset-password": { if (!u) return { err: "no such player" }; const pw = Array.from(crypto.randomBytes(8), x => CODE_ABC[x % CODE_ABC.length]).join("").toLowerCase(); const salt = crypto.randomBytes(16).toString("hex"); q.setPw.run(salt, hashPw(pw, salt), u.id); q.delSessionsOf.run(u.id); dropUser(u.id, "signed_out"); return { tempPassword: pw }; }
    case "delete-account": if (!u) return { err: "no such player" }; dropUser(u.id, "signed_out"); q.delSessionsOf.run(u.id); q.delUser.run(u.id); return { ok: true };
    case "kick-all": for (const c of conns) c.ws.close(4000, "restart"); return { ok: true };
  } return { err: "unknown action" }; }
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, "admin.html"));
function readBody(req) { return new Promise((ok, no) => { let s = ""; req.on("data", d => { s += d; if (s.length > 1e4) { no(new Error("big")); req.destroy(); } }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); }); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), j = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname === "/health") return j(200, { ok: true, online: [...conns].filter(c => c.uid).length });
    if (url.pathname === "/admin") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }); return res.end(ADMIN_HTML); }
    if (url.pathname.startsWith("/api/admin/")) { if (!isAdmin(req)) return j(401, { err: ADMIN_KEY.length < 12 ? "ADMIN_KEY is not set (needs 12+ characters)" : "wrong admin key" });
      const a = url.pathname.slice(11); if (a === "summary") return j(200, summary()); if (req.method !== "POST") return j(405, { err: "POST" });
      const r = adminDo(a, await readBody(req)); console.log("Admin:", a, r.err || "ok"); return j(r.err ? 400 : 200, r); }
    res.writeHead(200, { "content-type": "text/plain" }); res.end("Wildborn game server is running.\n");
  } catch (e) { console.error(e); j(500, { err: "server error" }); } });

/* ---------- connections ---------- */
/* compression shrinks the game's JSON updates about 4 to 8 times, which keeps the Railway data bill (egress) small */
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: { threshold: 128, serverMaxWindowBits: 13, clientMaxWindowBits: 13, memLevel: 7, concurrencyLimit: 4 } });
const SENT = { closed: 0, since: Date.now() };
const sentBytes = () => SENT.closed + [...conns].reduce((a, c) => a + ((c.ws._socket && c.ws._socket.bytesWritten) || 0), 0);
server.on("upgrade", (req, sock, head) => { const url = new URL(req.url, "http://x"), origin = String(req.headers.origin || "").replace(/\/$/, ""); if (process.env.DEBUG) console.log("upgrade", req.url, origin);
  const okOrigin = !ORIGINS.length || ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (url.pathname !== "/ws" || !okOrigin) { sock.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, ws => wss.emit("connection", ws, req)); });
wss.on("connection", (ws, req) => {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const c = { ws, ip, uid: 0, name: "", peer: "", rooms: new Map(), alive: true, n: 0, t: now() }; conns.add(c);
  send(c, { t: "hi", inviteOnly: inviteOnly() });
  if (process.env.DEBUG) { console.log("connected", ip); ws.on("close", (code) => console.log("closed", code)); }
  ws.on("pong", () => { c.alive = true; });
  ws.on("message", buf => { const t = now(); if (t - c.t > 1000) { c.t = t; c.n = 0; } if (++c.n > LIMITS.msgsPerSec) return;   /* too fast: drop */
    let m; try { m = JSON.parse(buf); } catch (e) { return; } if (!m || typeof m !== "object") return;
    try {
      if (["signup", "login", "resume", "logout", "chpw"].includes(m.t)) return onAuth(c, m);
      if (!c.uid) return send(c, { t: "auth", ok: false, err: "signed_out" });
      if (m.t === "p") return presence(c, roomName(m.room), m.patch);
      if (m.t === "join") return join(c, m.room);
      if (m.t === "leave") return leave(c, roomName(m.room));
    } catch (e) { console.error("message", e); } });
  ws.on("close", () => { SENT.closed += (ws._socket && ws._socket.bytesWritten) || 0; signOut(c); conns.delete(c); });
  ws.on("error", () => {}); });
setInterval(() => { for (const c of conns) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} } }, 25000).unref();
server.listen(PORT, () => console.log("Wildborn server listening on port " + PORT + (ORIGINS.length ? " for " + ORIGINS.join(", ") : " (any website: set ALLOWED_ORIGINS)") + ". Data in " + DATA_DIR + (ADMIN_KEY.length >= 12 ? "" : ". WARNING: ADMIN_KEY not set, admin page is off.")));
process.on("SIGTERM", () => { for (const c of conns) c.ws.close(1012, "restart"); server.close(); db.close(); process.exit(0); });
