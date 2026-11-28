/* Wildborn game server: accounts, invite codes and play-together rooms for the Wildborn website.
   One small Node program. It keeps accounts in a Postgres database (a Railway Postgres service) and passes room updates between players.

   Settings (Railway > service > Variables):
     ADMIN_KEY        SECRET. Long random password for the admin page (/admin). Never share it or put it in the game.
     ALLOWED_ORIGINS  Websites allowed to connect, comma separated. Example: https://petradavis.github.io
     DATABASE_URL     The Postgres address. On Railway set it to ${{Postgres.DATABASE_URL}}.
     GAME_URL         Where the home page sends people. Default: https://petradavis.github.io/Wildborn/
     PORT             Set by Railway automatically.

   The game talks to it over one WebSocket at /ws with small JSON messages:
     signup {name,pw,code} | login {name,pw} | resume {token} | logout | chpw {old,pw}  ->  auth {ok,name,token,err}
     myinvites -> invites {list:[[code, usedBy]]}   (every player gets 3 single-use invite codes of their own)
     join {room} -> peers {room,me,list:[[peer,presence]]};  p {room,patch} -> pu {room,peer,patch};  leave {room}
     others: pj {room,peer,presence} (joined), pl {room,peer} (left)
   Presence works like Claude's rooms: each player owns a few fields; a patch replaces fields, null removes one. */
"use strict";
const http = require("node:http"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { WebSocketServer } = require("ws");
const { Pool, types } = require("pg");
const { mpFilter, mpPersonal, mpClean } = require("./filter.js");

const PORT = +process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL || "";
const GAME_URL = process.env.GAME_URL || "https://petradavis.github.io/Wildborn/";
const PLAYER_INVITES = 3;   /* Petra: each player gets 3 invites to share */
const LIMITS = { field: 4600, presence: 7000, roomPlayers: 40, rooms: 4, msgsPerSec: 40, nameRe: /^[a-z0-9_]{3,16}$/, sessionDays: 60 };

/* ---------- database (Postgres) ---------- */
if (!DATABASE_URL) { console.error("DATABASE_URL is not set. On Railway add the variable DATABASE_URL = ${{Postgres.DATABASE_URL}} to this service. Not starting."); process.exit(1); }
types.setTypeParser(20, v => Number(v));   /* BIGINT (our millisecond times) as plain numbers */
const db = new Pool({ connectionString: DATABASE_URL, max: 5, ssl: /sslmode=require/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
db.on("error", e => console.error("database", e.message));
const one = async (sql, a) => (await db.query(sql, a)).rows[0];
const all = async (sql, a) => (await db.query(sql, a)).rows;
const run = async (sql, a, c) => (await (c || db).query(sql, a)).rowCount;
const SCHEMA = `CREATE TABLE IF NOT EXISTS users (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, invite TEXT, created BIGINT, last_seen BIGINT, banned INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, note TEXT, created BIGINT, used_by INTEGER, used_at BIGINT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created BIGINT, last BIGINT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS owner INTEGER;
CREATE INDEX IF NOT EXISTS invites_owner ON invites (owner);
CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT);`;
const q = {
  userByName: n => one("SELECT * FROM users WHERE name = $1", [n]), userById: id => one("SELECT * FROM users WHERE id = $1", [id]),
  setPw: (salt, hash, id) => run("UPDATE users SET salt = $1, hash = $2 WHERE id = $3", [salt, hash, id]), seen: (t, id) => run("UPDATE users SET last_seen = $1 WHERE id = $2", [t, id]),
  ban: (b, id) => run("UPDATE users SET banned = $1 WHERE id = $2", [b, id]), delUser: id => run("DELETE FROM users WHERE id = $1", [id]),
  users: () => all("SELECT id, name, invite, created, last_seen, banned FROM users ORDER BY created"),
  invite: c => one("SELECT * FROM invites WHERE code = $1", [c]), addInvite: (c, note, t) => run("INSERT INTO invites (code, note, created) VALUES ($1, $2, $3)", [c, note, t]),
  delInvite: c => run("DELETE FROM invites WHERE code = $1 AND used_by IS NULL", [c]), invites: () => all("SELECT * FROM invites ORDER BY created"),
  session: t => one("SELECT * FROM sessions WHERE token = $1", [t]), addSession: (t, uid, a, b) => run("INSERT INTO sessions (token, user_id, created, last) VALUES ($1, $2, $3, $4)", [t, uid, a, b]),
  touchSession: (t, tok) => run("UPDATE sessions SET last = $1 WHERE token = $2", [t, tok]), delSession: t => run("DELETE FROM sessions WHERE token = $1", [t]),
  delSessionsOf: id => run("DELETE FROM sessions WHERE user_id = $1", [id]), oldSessions: t => run("DELETE FROM sessions WHERE last < $1", [t]),
  getCfg: k => one("SELECT v FROM config WHERE k = $1", [k]), setCfg: (k, v) => run("INSERT INTO config (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [k, v]),
};
/* settings are read often (every new connection), so they are kept in memory and saved to the database when changed */
const CFG = {};
const cfg = (k, d) => k in CFG ? CFG[k] : d;
const setCfg = async (k, v) => { CFG[k] = v; await q.setCfg(k, JSON.stringify(v)); };
const inviteOnly = () => cfg("inviteOnly", true) !== false;
const now = () => Date.now();
async function tx(f) { const c = await db.connect(); try { await c.query("BEGIN"); const r = await f(c); await c.query("COMMIT"); return r; } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); } }

/* invite codes look like WILD-7K2QX; stored without the dash. No 0/O/1/I so they are easy to read out loud. */
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => "WILD" + Array.from(crypto.randomBytes(5), b => CODE_ABC[b % CODE_ABC.length]).join("");
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const showCode = c => c.slice(0, 4) + "-" + c.slice(4);
async function makeInvites(n, note, owner, k) { const out = []; for (let i = 0; i < n; i++) { let c; do c = newCode(); while (await q.invite(c));
    await (k || db).query("INSERT INTO invites (code, note, created, owner) VALUES ($1, $2, $3, $4)", [c, mpClean(note || "", 60), now(), owner || null]); out.push(showCode(c)); } return out; }
/* players who don't have their own invites yet (accounts made before this rule) get theirs */
async function giveMissingInvites() { for (const u of await all("SELECT id, name FROM users WHERE NOT EXISTS (SELECT 1 FROM invites WHERE owner = users.id)")) await makeInvites(PLAYER_INVITES, "from " + u.name, u.id); }
async function dbStart() { await db.query(SCHEMA); for (const r of await all("SELECT k, v FROM config")) { try { CFG[r.k] = JSON.parse(r.v); } catch (e) {} }
  if (!cfg("seeded", false)) { await makeInvites(10, "first 10"); await setCfg("seeded", true); await setCfg("inviteOnly", true); console.log("First start: made 10 invite codes. See them on the admin page (/admin)."); }
  await giveMissingInvites(); await q.oldSessions(now() - LIMITS.sessionDays * 864e5); }

/* passwords: scrypt with a random salt per account */
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
function checkPw(u, pw) { const h = Buffer.from(hashPw(pw, u.salt), "hex"), want = Buffer.from(u.hash, "hex"); return h.length === want.length && crypto.timingSafeEqual(h, want); }
const tokenHash = t => crypto.createHash("sha256").update(String(t)).digest("hex");
async function newSession(uid) { const t = crypto.randomBytes(32).toString("base64url"); await q.addSession(tokenHash(t), uid, now(), now()); return t; }
setInterval(() => q.oldSessions(now() - LIMITS.sessionDays * 864e5).catch(() => {}), 864e5).unref();

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
  for (const o of conns) if (o !== c && o.peer === c.peer) { signOut(o); o.ws.close(4001, "replaced"); } q.seen(now(), u.id).catch(() => {}); send(c, { t: "auth", ok: true, name: u.name, token, re: c.req }); }
async function onAuth(c, m) { if (m.tab) c.tab = m.tab; c.req = m.t; const fail = err => send(c, { t: "auth", ok: false, err, for: m.t, re: m.t });
  if (m.t === "logout") { if (m.token) await q.delSession(tokenHash(m.token)); signOut(c); return send(c, { t: "auth", ok: false, err: "", re: "logout" }); }
  if (m.t === "resume") { const s = await q.session(tokenHash(m.token)); const u = s && await q.userById(s.user_id); if (!u) return fail("signed_out"); if (u.banned) return fail("banned"); await q.touchSession(now(), tokenHash(m.token)); return signedIn(c, u, m.token); }
  if (m.t === "myinvites") { if (!c.uid) return fail("signed_out"); const rows = await all("SELECT i.code, u.name FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.owner = $1 ORDER BY i.created, i.code", [c.uid]);
    return send(c, { t: "invites", list: rows.map(r => [showCode(r.code), r.name || ""]) }); }
  if (tooMany(c.ip)) return fail("slow_down");
  const name = String(m.name || "").trim().toLowerCase(), pw = String(m.pw || "");
  if (m.t === "login") { const u = await q.userByName(name); if (!u || !checkPw(u, pw)) return fail("wrong"); if (u.banned) return fail("banned"); return signedIn(c, u, await newSession(u.id)); }
  if (m.t === "signup") {
    if (!LIMITS.nameRe.test(name)) return fail("bad_name"); if (mpFilter(name) !== name || mpPersonal(name)) return fail("rude_name");
    if (pw.length < 6 || pw.length > 64) return fail("short_pw"); if (await q.userByName(name)) return fail("name_taken");
    const code = normCode(m.code), only = inviteOnly();
    try { const salt = crypto.randomBytes(16).toString("hex"), hash = hashPw(pw, salt);
      const u = await tx(async k => { if (only) { const inv = (await k.query("SELECT * FROM invites WHERE code = $1 FOR UPDATE", [code])).rows[0]; if (!inv) throw new Error("bad_code"); if (inv.used_by) throw new Error("used_code"); }
        const nu = (await k.query("INSERT INTO users (name, salt, hash, invite, created, last_seen) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *", [name, salt, hash, only ? code : "", now(), now()])).rows[0];
        if (only && !(await k.query("UPDATE invites SET used_by = $1, used_at = $2 WHERE code = $3 AND used_by IS NULL", [nu.id, now(), code])).rowCount) throw new Error("used_code");
        await makeInvites(PLAYER_INVITES, "from " + name, nu.id, k); return nu; });
      console.log("New account:", name); return signedIn(c, u, await newSession(u.id)); }
    catch (e) { return fail(e.code === "23505" ? "name_taken" : ["bad_code", "used_code"].includes(e.message) ? e.message : "error"); } }
  if (m.t === "chpw") { if (!c.uid) return fail("signed_out"); const u = await q.userById(c.uid); if (!u || !checkPw(u, m.old)) return fail("wrong_old"); if (pw.length < 6 || pw.length > 64) return fail("short_pw");
    const salt = crypto.randomBytes(16).toString("hex"); await q.setPw(salt, hashPw(pw, salt), u.id); await q.delSessionsOf(u.id); return send(c, { t: "auth", ok: true, name: u.name, token: await newSession(u.id), changed: 1, re: "chpw" }); } }

/* ---------- admin page + API (needs ADMIN_KEY) ---------- */
function isAdmin(req) { const k = String(req.headers["x-admin-key"] || ""); if (!ADMIN_KEY || ADMIN_KEY.length < 12 || !k) return false; const a = Buffer.from(tokenHash(k)), b = Buffer.from(tokenHash(ADMIN_KEY)); return crypto.timingSafeEqual(a, b); }
async function summary() { const online = new Set([...conns].filter(c => c.uid).map(c => c.uid));
  const us = await q.users(), invs = await q.invites(), names = new Map(us.map(u => [u.id, u.name]));
  return { inviteOnly: inviteOnly(), online: online.size, sentMB: Math.round(sentBytes() / 1e5) / 10, sentBytes: sentBytes(), since: SENT.since,
    rooms: [...rooms.entries()].map(([k, r]) => ({ room: k, players: [...r.values()].map(c => c.name) })),
    users: us.map(u => ({ name: u.name, created: u.created, lastSeen: u.last_seen, banned: !!u.banned, online: online.has(u.id), invite: u.invite ? showCode(u.invite) : "" })),
    gameUrl: GAME_URL, invites: invs.map(i => ({ code: showCode(i.code), note: i.note, owner: i.owner ? names.get(i.owner) || "" : "", created: i.created, usedBy: i.used_by ? names.get(i.used_by) || "(deleted account)" : "" })) }; }
async function adminDo(a, b) { const u = b.name ? await q.userByName(String(b.name).toLowerCase()) : null;
  switch (a) {
    case "invites": return { made: await makeInvites(Math.max(1, Math.min(50, +b.count || 1)), b.note) };
    case "delete-invite": return { ok: await q.delInvite(normCode(b.code)) > 0 };
    case "invite-only": await setCfg("inviteOnly", !!b.on); return { inviteOnly: inviteOnly() };
    case "ban": if (!u) return { err: "no such player" }; await q.ban(1, u.id); await q.delSessionsOf(u.id); dropUser(u.id, "banned"); return { ok: true };
    case "unban": if (!u) return { err: "no such player" }; await q.ban(0, u.id); return { ok: true };
    case "reset-password": { if (!u) return { err: "no such player" }; const pw = Array.from(crypto.randomBytes(8), x => CODE_ABC[x % CODE_ABC.length]).join("").toLowerCase(); const salt = crypto.randomBytes(16).toString("hex"); await q.setPw(salt, hashPw(pw, salt), u.id); await q.delSessionsOf(u.id); dropUser(u.id, "signed_out"); return { tempPassword: pw }; }
    case "delete-account": if (!u) return { err: "no such player" }; dropUser(u.id, "signed_out"); await q.delSessionsOf(u.id); await q.delUser(u.id); return { ok: true };
    case "kick-all": for (const c of conns) c.ws.close(4000, "restart"); return { ok: true };
  } return { err: "unknown action" }; }
const ADMIN_HTML = fs.readFileSync(path.join(__dirname, "admin.html"));
function readBody(req) { return new Promise((ok, no) => { let s = ""; req.on("data", d => { s += d; if (s.length > 1e4) { no(new Error("big")); req.destroy(); } }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); }); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), j = (code, o) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  try {
    if (url.pathname === "/health") { await db.query("SELECT 1"); return j(200, { ok: true, online: [...conns].filter(c => c.uid).length }); }
    if (url.pathname === "/admin") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }); return res.end(ADMIN_HTML); }
    if (url.pathname.startsWith("/api/admin/")) { if (!isAdmin(req)) return j(401, { err: ADMIN_KEY.length < 12 ? "ADMIN_KEY is not set (needs 12+ characters)" : "wrong admin key" });
      const a = url.pathname.slice(11); if (a === "summary") return j(200, await summary()); if (req.method !== "POST") return j(405, { err: "POST" });
      const r = await adminDo(a, await readBody(req)); console.log("Admin:", a, r.err || "ok"); return j(r.err ? 400 : 200, r); }
    /* the server has no game of its own: send anyone who opens it to the game website */
    if (url.pathname === "/" || url.pathname === "/index.html") { res.writeHead(302, { location: GAME_URL, "cache-control": "no-store" }); return res.end(); }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("Not here. The game is at " + GAME_URL + "\n");
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
      if (["signup", "login", "resume", "logout", "chpw", "myinvites"].includes(m.t)) return void onAuth(c, m).catch(e => { console.error("auth", e.message); send(c, { t: "auth", ok: false, err: "error", for: m.t, re: m.t }); });
      if (!c.uid) return send(c, { t: "auth", ok: false, err: "signed_out" });
      if (m.t === "p") return presence(c, roomName(m.room), m.patch);
      if (m.t === "join") return join(c, m.room);
      if (m.t === "leave") return leave(c, roomName(m.room));
    } catch (e) { console.error("message", e); } });
  ws.on("close", () => { SENT.closed += (ws._socket && ws._socket.bytesWritten) || 0; signOut(c); conns.delete(c); });
  ws.on("error", () => {}); });
setInterval(() => { for (const c of conns) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) {} } }, 25000).unref();
dbStart().then(() => server.listen(PORT, () => console.log("Wildborn server listening on port " + PORT + (ORIGINS.length ? " for " + ORIGINS.join(", ") : " (any website: set ALLOWED_ORIGINS)") + ". Data in Postgres" + (ADMIN_KEY.length >= 12 ? "" : ". WARNING: ADMIN_KEY not set, admin page is off."))), e => { console.error("Can't reach the database:", e.message); process.exit(1); });
process.on("SIGTERM", () => { for (const c of conns) c.ws.close(1012, "restart"); server.close(); db.end().finally(() => process.exit(0)); });
