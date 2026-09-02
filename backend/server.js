/* ============================================================
 * firuzo.online Call Center — backend + panel server
 * Node.js on 192.168.100.65:3006 (systemd: callcenter-app)
 * - Express REST API + static panel
 * - Socket.IO live events (admin/operator rooms)
 * - AMI client → internal Asterisk on 192.168.100.85
 * - Remote DB connector (CRM enrichment, read-only)
 * - Recording pull via SFTP from Asterisk spool
 * ============================================================ */
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const { pool, q, initSchema } = require("./lib/db");
const { AmiClient } = require("./lib/ami");
const remote = require("./lib/remote");
const state = require("./lib/state");

/* static SIP ext passwords (must match /etc/asterisk/pjsip.conf on the PBX host).
 * Override pattern via env CC_OP_SIP_PASS (use {ext} placeholder), e.g. FzOp{ext}!x */
const SIP_CREDS = {};
const OP_PASS = process.env.CC_OP_SIP_PASS || "FzOp{ext}!x";
for (let i = 1000; i <= 1005; i++) SIP_CREDS[String(i)] = OP_PASS.replace("{ext}", String(i));

/* All deployment-specific values can be overridden in .env (see .env.example).
 * Defaults below match the original firuzo.online deployment. */
const CFG = {
  port: parseInt(process.env.CC_PORT || "3006", 10),
  publicOrigin: process.env.CC_PUBLIC_ORIGIN || "https://call.firuzo.online",
  jwt: process.env.CC_JWT || "FzCcJwt#2026!s3cr3t",
  dialExt: process.env.CC_DIAL_EXT || "200",
  visitorPass: process.env.CC_VISITOR_SIP_PASS || "FzVis2026!x",
  turn: {
    publicIp: process.env.CC_TURN_PUBLIC_IP || "46.100.58.20",
    lanIp: process.env.CC_TURN_LAN_IP || "192.168.100.65",
    user: process.env.CC_TURN_USER || "callcenter",
    pass: process.env.CC_TURN_PASS || "FzTurn2026!x",
  },
  ami: {
    host: process.env.CC_AMI_HOST || "192.168.100.85",
    port: parseInt(process.env.CC_AMI_PORT || "5038", 10),
    user: process.env.CC_AMI_USER || "callcenter",
    pass: process.env.CC_AMI_PASS || "CcAmi2026!x",
  },
  sftp: { host: process.env.CC_PBX_HOST || "192.168.100.85", port: 22, user: "root",
          keyPath: process.env.CC_SFTP_KEY || "/opt/callcenter/secrets/cc_rsa" },
  recSpool: process.env.CC_REC_SPOOL || "/var/spool/asterisk/monitor",
  recLocal: process.env.CC_REC_LOCAL || "/opt/callcenter/recordings",
  supportPhone: process.env.CC_SUPPORT_PHONE || "+982191000000",
  supportPhoneDisplay: process.env.CC_SUPPORT_PHONE_DISPLAY || "۰۲۱-۹۱۰۰۰۰۰۰",
  brandName: process.env.CC_BRAND_NAME || "فیرزو",
  brandColor: process.env.CC_BRAND_COLOR || "#0ea5e9",
};
CFG.ami.host = process.env.CC_AMI_HOST || CFG.ami.host;

/* ---------- AMI singleton — shared with runtime.js (fix: routes using `ami`) ---------- */
const ami = new AmiClient(CFG.ami);

/* ---------- boot ---------- */
(async () => {
  fs.mkdirSync(CFG.recLocal, { recursive: true });
  await initSchema();
  const users = await q("SELECT COUNT(*) c FROM users");
  if (!users[0].c) {
    await q("INSERT INTO users (username,pass_hash,name,role,sip_ext) VALUES (?,?,?,?,?)", [
      "admin", bcrypt.hashSync("Firuzo@Admin2026", 10), "مدیر سیستم", "admin", "1000"]);
    await q("INSERT INTO users (username,pass_hash,name,role,sip_ext) VALUES (?,?,?,?,?)", [
      "operator", bcrypt.hashSync("Firuzo@Operator2026", 10), "اپراتور پشتیبانی", "operator", "1001"]);
    console.log("[seed] default users created");
  }
})();

/* ---------- express ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", true);

/* ---------- CORS — widget on firuzo.online calls these APIs cross-origin ---------- */
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* static */
app.use("/admin", express.static(path.join(__dirname, "public/admin"), { maxAge: 0 }));
app.use("/operator", express.static(path.join(__dirname, "public/operator"), { maxAge: 0 }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

/* landing: redirect root to admin login */
app.get("/", (req, res) => res.redirect("/admin"));
app.get("/health", (req, res) => res.json({ status: "ok", service: "callcenter", time: new Date().toISOString() }));

/* helpers */
const sign = (u) => jwt.sign({ uid: u.id, role: u.role, ext: u.sip_ext, name: u.name }, CFG.jwt, { expiresIn: "12h" });
const realIP = (req) => (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
function auth(roles) {
  return (req, res, next) => {
    const t = (req.headers.authorization || "").replace("Bearer ", "");
    try {
      const p = jwt.verify(t, CFG.jwt);
      if (roles && !roles.includes(p.role)) return res.status(403).json({ error: "forbidden" });
      req.user = p; next();
    } catch { res.status(401).json({ error: "unauthorized" }); }
  };
}

/* ---------- auth ---------- */
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const rows = await q("SELECT * FROM users WHERE username=? AND active=1 LIMIT 1", [username]);
  if (!rows.length || !bcrypt.compareSync(password || "", rows[0].pass_hash))
    return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است" });
  const u = rows[0];
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role, ext: u.sip_ext, username: u.username } });
});

app.get("/api/auth/me", auth(), async (req, res) => {
  const rows = await q("SELECT id,username,name,role,sip_ext FROM users WHERE id=?", [req.user.uid]);
  res.json(rows[0] || {});
});

app.get("/api/auth/sipcred", auth(), async (req, res) => {
  const ext = String(req.user.ext || "");
  if (!SIP_CREDS[ext]) return res.status(404).json({ error: "no sip ext for user" });
  res.json({ ext, password: SIP_CREDS[ext] });
});

app.get("/api/queue/members", auth(["admin", "operator"]), async (req, res) => {
  const rows = await q("SELECT username,name,sip_ext,role,active FROM users WHERE role IN ('admin','operator') ORDER BY id");
  res.json(rows.map(u => ({ ...u, in_queue: state.queueMemberSet.has(String(u.sip_ext)) })));
});

app.post("/api/auth/pass", auth(), async (req, res) => {
  const { oldpass, newpass } = req.body || {};
  const rows = await q("SELECT * FROM users WHERE id=?", [req.user.uid]);
  if (!rows.length || !bcrypt.compareSync(oldpass || "", rows[0].pass_hash))
    return res.status(400).json({ error: "رمز فعلی اشتباه است" });
  await q("UPDATE users SET pass_hash=? WHERE id=?", [bcrypt.hashSync(newpass, 10), req.user.uid]);
  res.json({ ok: true });
});

/* ---------- widget public API ---------- */
app.get("/api/widget/config", (req, res) => {
  res.set("Cache-Control", "public, max-age=120");
  const ccOrigin = CFG.publicOrigin.replace(/^https?:\/\//, "");
  const ice = [{ urls: "stun:stun.l.google.com:19302" }];
  if (CFG.turn.publicIp) {
    ice.push({ urls: `turn:${CFG.turn.publicIp}:3478?transport=tcp`, username: CFG.turn.user, credential: CFG.turn.pass });
    ice.push({ urls: `turn:${CFG.turn.publicIp}:3478?transport=udp`, username: CFG.turn.user, credential: CFG.turn.pass });
  }
  if (CFG.turn.lanIp) {
    ice.push({ urls: `turn:${CFG.turn.lanIp}:3478?transport=udp`, username: CFG.turn.user, credential: CFG.turn.pass });
  }
  res.json({
    enabled: true,
    sip_server_domain: ccOrigin,
    ws_url: `wss://${ccOrigin}/ws`,
    dial_ext: CFG.dialExt,
    auth: { username: "visitor", password: CFG.visitorPass },
    /* NOTE: TURN must target the origin IP directly when the DNS name is
       Cloudflare-proxied (TURN traffic cannot traverse the CF HTTP proxy). */
    ice_servers: ice,
    support_phone: CFG.supportPhone,
    support_phone_display: CFG.supportPhoneDisplay,
    brand: { name: CFG.brandName, color: CFG.brandColor },
  });
});

app.post("/api/visitor/announce", async (req, res) => {
  const { visitorId, page, name, phone, email } = req.body || {};
  if (!visitorId) return res.status(400).json({ error: "visitorId required" });
  await q(`INSERT INTO visitors (visitor_id,ip,name,phone,email,page_url,last_seen) VALUES (?,?,?,?,?,?,NOW())
           ON DUPLICATE KEY UPDATE ip=VALUES(ip), page_url=VALUES(page_url),
           name=COALESCE(NULLIF(VALUES(name),''),name), phone=COALESCE(NULLIF(VALUES(phone),''),phone),
           email=COALESCE(NULLIF(VALUES(email),''),email), last_seen=NOW()`,
    [String(visitorId).slice(0, 64), realIP(req), name || "", phone || "", email || "", (page || "").slice(0, 500)]);
  res.json({ ok: true });
});

app.get("/api/queue/status", async (req, res) => {
  res.set("Cache-Control", "no-store");
  let waiting = 0, longest = 0;
  try {
    const rows = await q(`SELECT COUNT(*) c, COALESCE(MAX(TIMESTAMPDIFF(SECOND,started_at,NOW())),0) m FROM calls WHERE status='waiting'`);
    waiting = rows[0].c; longest = rows[0].m;
  } catch {}
  res.json({ waiting, longest_wait: longest, online: (ami.logged ? state.queueMemberSet.size : 0) });
});

app.post("/api/widget/survey", async (req, res) => {
  const { visitorId, rating } = req.body || {};
  const r = Math.max(1, Math.min(5, parseInt(rating) || 0));
  if (!r) return res.status(400).json({ error: "rating 1..5" });
  const rows = await q("SELECT unique_id FROM calls WHERE visitor_id=? ORDER BY id DESC LIMIT 1", [visitorId || ""]);
  if (rows.length) {
    await q("INSERT INTO surveys (unique_id,rating,source) VALUES (?,?, 'widget')", [rows[0].unique_id, r]);
    await q("UPDATE calls SET survey_rating=? WHERE unique_id=?", [r, rows[0].unique_id]);
  }
  res.json({ ok: true });
});

/* dialplan internal callback */
const internalGuard = (req, res, next) => {
  const ip = req.socket.remoteAddress;
  const allowed = ["127.0.0.1", "::1", "::ffff:" + CFG.ami.host, "::ffff:" + (process.env.CC_APP_LAN_IP || "")];
  if (allowed.includes(ip)) return next();
  res.status(403).json({ error: "internal only" });
};
app.post("/api/internal/survey", internalGuard, async (req, res) => {
  const { call, rating } = req.query;
  const r = Math.max(0, Math.min(5, parseInt(rating) || 0));
  if (call) {
    await q("INSERT INTO surveys (unique_id,rating,source) VALUES (?,?, 'ivr')", [call, r]);
    await q("UPDATE calls SET survey_rating=? WHERE unique_id=?", [r, call]);
  }
  res.json({ ok: true });
});

/* ---------- admin/operator API ---------- */
app.get("/api/calls", auth(["admin", "operator"]), async (req, res) => {
  const { date, status, limit = 100, offset = 0 } = req.query;
  const where = [], params = [];
  if (date) { where.push("DATE(started_at)=?"); params.push(date); }
  if (status) { where.push("status=?"); params.push(status); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await q(`SELECT * FROM calls ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    [...params, +limit, +offset]);
  res.json(rows);
});

app.get("/api/calls/:id", auth(["admin", "operator"]), async (req, res) => {
  const rows = await q("SELECT * FROM calls WHERE id=?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not found" });
  const ev = await q("SELECT event,payload,created_at FROM call_events WHERE call_id=? ORDER BY id", [req.params.id]);
  res.json({ ...rows[0], events: ev });
});

app.post("/api/calls/:id/notes", auth(["admin", "operator"]), async (req, res) => {
  await q("UPDATE calls SET notes=? WHERE id=?", [req.body.notes || "", req.params.id]);
  res.json({ ok: true });
});

app.get("/api/records/:uniqueid", auth(["admin", "operator"]), async (req, res) => {
  const f = path.join(CFG.recLocal, path.basename(req.params.uniqueid) + ".wav");
  if (!fs.existsSync(f)) return res.status(404).json({ error: "recording not found" });
  res.set("Content-Type", "audio/wav");
  fs.createReadStream(f).pipe(res);
});

app.get("/api/customers", auth(["admin", "operator"]), async (req, res) => {
  const { s = "" } = req.query;
  const rows = await q(`SELECT c.*,
      (SELECT COUNT(*) FROM calls k WHERE k.visitor_id=c.visitor_id OR (c.phone<>'' AND k.visitor_phone=c.phone)) call_count,
      (SELECT MAX(started_at) FROM calls k WHERE k.visitor_id=c.visitor_id OR (c.phone<>'' AND k.visitor_phone=c.phone)) last_call
    FROM (
      SELECT visitor_id, MAX(name) name, MAX(phone) phone, MAX(email) email, MAX(ip) ip, MAX(last_seen) last_seen
      FROM visitors WHERE name<>'' OR phone<>'' OR email<>'' GROUP BY visitor_id
      ${s ? "HAVING name LIKE ? OR phone LIKE ? OR email LIKE ?" : ""}
    ) c ORDER BY last_seen DESC LIMIT 200`,
    s ? [`%${s}%`, `%${s}%`, `%${s}%`] : []);
  res.json(rows);
});

app.get("/api/crm/lookup", auth(["admin", "operator"]), async (req, res) => {
  const { phone, email } = req.query;
  res.json(await remote.lookupCustomer({ phone, email }));
});

app.get("/api/operators", auth(["admin"]), async (req, res) => {
  const rows = await q("SELECT id,username,name,role,sip_ext,active,created_at FROM users ORDER BY id");
  res.json(rows);
});

app.post("/api/operators", auth(["admin"]), async (req, res) => {
  const { username, password, name, role, sip_ext } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: "مقادیر ناقص است" });
  try {
    await q("INSERT INTO users (username,pass_hash,name,role,sip_ext) VALUES (?,?,?,?,?)",
      [username, bcrypt.hashSync(password, 10), name, role === "admin" ? "admin" : "operator", sip_ext || null]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: "نام کاربری تکراری است" }); }
});

app.post("/api/operators/:id", auth(["admin"]), async (req, res) => {
  const { name, password, active, sip_ext } = req.body || {};
  if (password) await q("UPDATE users SET pass_hash=? WHERE id=?", [bcrypt.hashSync(password, 10), req.params.id]);
  const sets = [];
  const params = [];
  if (name !== undefined) { sets.push("name=?"); params.push(name); }
  if (active !== undefined) { sets.push("active=?"); params.push(active ? 1 : 0); }
  if (sip_ext !== undefined) { sets.push("sip_ext=?"); params.push(sip_ext); }
  if (sets.length) { params.push(req.params.id); await q(`UPDATE users SET ${sets.join(",")} WHERE id=?`, params); }
  res.json({ ok: true });
});

app.get("/api/stats", auth(["admin", "operator"]), async (req, res) => {
  const today = await q(`SELECT
    COUNT(*) total,
    SUM(status IN ('answered','completed')) answered,
    SUM(status='missed') missed,
    COALESCE(ROUND(AVG(NULLIF(wait_sec,0))),0) avg_wait,
    COALESCE(ROUND(AVG(NULLIF(survey_rating,0)),2),0) avg_rating
    FROM calls WHERE DATE(started_at)=CURDATE()`);
  const last7 = await q(`SELECT DATE(started_at) d, COUNT(*) c, SUM(status IN ('answered','completed')) a
    FROM calls WHERE started_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY DATE(started_at) ORDER BY d`);
  res.json({ today: today[0], last7 });
});

/* settings */
app.get("/api/settings", auth(["admin"]), async (req, res) => {
  const rows = await q("SELECT * FROM settings");
  const out = {};
  rows.forEach(r => { out[r.skey] = r.sval; });
  if (!out.remote_db) out.remote_db = JSON.stringify(await remote.getConfig());
  res.json(out);
});

app.post("/api/settings/remote_db", auth(["admin"]), async (req, res) => {
  try {
    const cfg = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    await remote.saveConfig(cfg);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* queue controls (admin) */
app.post("/api/queue/member", auth(["admin", "operator"]), async (req, res) => {
  const { ext, action } = req.body || {};
  if (req.user.role === "operator" && String(ext) !== String(req.user.ext))
    return res.status(403).json({ error: "forbidden" });
  let act = action;
  if (act === "toggle") act = state.queueMemberSet.has(String(ext)) ? "remove" : "add";
  try {
    if (act === "add") await ami.sendAction("QueueAdd", { Queue: "support", Interface: `PJSIP/${ext}`, MemberName: `operator-${ext}`, Penalty: 0 });
    else await ami.sendAction("QueueRemove", { Queue: "support", Interface: `PJSIP/${ext}` });
    res.json({ ok: true, action: act });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { app, server, io, CFG, ami };
