/* ============================================================
 * firuzo.online Call Center — backend v3 (server + panel host)
 * Node.js on 192.168.100.65:3006 (systemd: callcenter-app)
 * - Express REST API + static panels
 * - Socket.IO live hub (admin/operator rooms, chat, presence)
 * - AMI client → internal Asterisk on 192.168.100.85
 * - Remote DB connector (CRM enrichment, read-only)
 * - Recording pull via SFTP from Asterisk spool
 * v3: transfers, monitoring, team chat, callbacks, quality,
 *     wallboard, health, dispositions, audit trail
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
const pbx = require("./lib/pbx");
const { LiveMonitor } = require("./lib/livemon");

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
  version: require("./package.json").version,
};
CFG.ami.host = process.env.CC_AMI_HOST || CFG.ami.host;

/* ---------- singletons ---------- */
const ami = new AmiClient(CFG.ami);
const live = new LiveMonitor();
pbx.bindAmi(ami);

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
const socketsByExt = new Map(); // ext -> Set(socket.id)

/* static */
app.use("/admin", express.static(path.join(__dirname, "public/admin"), { maxAge: 0 }));
app.use("/operator", express.static(path.join(__dirname, "public/operator"), { maxAge: 0 }));
app.use("/assets", express.static(path.join(__dirname, "public/assets"), { maxAge: "1h" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

/* landing: redirect root to admin login */
app.get("/", (req, res) => res.redirect("/admin"));
app.get("/health", (req, res) => res.json({ status: "ok", service: "callcenter", version: CFG.version, time: new Date().toISOString() }));

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
const audit = (ext, kind, detail) =>
  q("INSERT INTO op_events (ext,kind,detail) VALUES (?,?,?)", [String(ext || ""), kind, String(detail || "").slice(0, 490)]).catch(() => {});

/* ================= auth ================= */
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const rows = await q("SELECT * FROM users WHERE username=? AND active=1 LIMIT 1", [username]);
  if (!rows.length || !bcrypt.compareSync(password || "", rows[0].pass_hash))
    return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است" });
  const u = rows[0];
  q("UPDATE users SET last_active=NOW() WHERE id=?", [u.id]).catch(() => {});
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

app.post("/api/auth/pass", auth(), async (req, res) => {
  const { oldpass, newpass } = req.body || {};
  const rows = await q("SELECT * FROM users WHERE id=?", [req.user.uid]);
  if (!rows.length || !bcrypt.compareSync(oldpass || "", rows[0].pass_hash))
    return res.status(400).json({ error: "رمز فعلی اشتباه است" });
  await q("UPDATE users SET pass_hash=? WHERE id=?", [bcrypt.hashSync(newpass, 10), req.user.uid]);
  res.json({ ok: true });
});

/* ================= team (presence) ================= */
app.get("/api/team", auth(), async (req, res) => {
  const rows = await q("SELECT username,name,sip_ext,role,active,pause_reason,last_active FROM users WHERE role IN ('admin','operator') ORDER BY id");
  res.json(rows.map(u => ({
    ...u,
    in_queue: state.queueMemberSet.has(String(u.sip_ext)),
    online: socketsByExt.has(String(u.sip_ext)),
    on_call: !!(live.byExt(String(u.sip_ext))),
  })));
});

/* ================= widget public API ================= */
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

/* ================= live calls (admin) ================= */
app.get("/api/live", auth(["admin"]), (req, res) => {
  res.json({ calls: live.getLive(), summary: live.summary(), alerts: live.lastAlerts });
});

/* ================= transfers (operator/admin) ================= */
app.post("/api/call/transfer", auth(["admin", "operator"]), async (req, res) => {
  const { mode, target } = req.body || {};
  const ext = String(req.user.ext || "");
  const act = live.byExt(ext);
  if (!act || !act.visitor) return res.status(400).json({ error: "تماس فعالی برای انتقال وجود ندارد" });
  try {
    if (mode === "blind") {
      await pbx.blindTransfer(act.visitor.chan, String(target));
      await q("UPDATE calls SET status='completed', ended_at=NOW(), duration_sec=TIMESTAMPDIFF(SECOND,COALESCE(answered_at,started_at),NOW()), transferred_to=?, disposition='transferred' WHERE unique_id=?", [String(target), act.visitor.uid]).catch(() => {});
      audit(ext, "transfer-blind", `${act.visitor.chan} → ${target}`);
      io.emit("call:transferred", { by: ext, to: String(target) });
      res.json({ ok: true, mode: "blind" });
    } else {
      res.status(400).json({ error: "mode must be blind (attended completes via /api/call/transfer/complete)" });
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/call/transfer/complete", auth(["admin", "operator"]), async (req, res) => {
  const ext = String(req.user.ext || "");
  const act = live.byExt(ext);
  if (!act || !act.visitor) return res.status(400).json({ error: "تماس فعالی وجود ندارد" });
  /* consult channel: explicit, or auto-resolve the operator's 2nd agent channel */
  let consult = String(req.body.consultChan || "");
  if (!consult) {
    const c = live.consultChan(ext, act.agent.uid);
    if (c) consult = c.chan;
  }
  if (!/^PJSIP\//.test(consult)) return res.status(400).json({ error: "کانال تماس مشاوره پیدا نشد" });
  try {
    await pbx.completeAttended(act.visitor.chan, consult);
    await q("UPDATE calls SET transferred_to=? WHERE unique_id=?", [String(req.body.target || ""), act.visitor.uid]).catch(() => {});
    audit(ext, "transfer-attended", `${act.visitor.chan} + ${consult}`);
    io.emit("call:transferred", { by: ext, to: String(req.body.target || "") });
    res.json({ ok: true, mode: "attended" });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ================= monitoring (admin listen/whisper/barge) ================= */
app.post("/api/call/monitor", auth(["admin"]), async (req, res) => {
  const { bridge, mode } = req.body || {};
  const m = ["listen", "whisper", "barge"].includes(mode) ? mode : "listen";
  const act = live.getLive().find((c) => c.bridge === bridge);
  if (!act || !act.visitor) return res.status(400).json({ error: "تماس فعال پیدا نشد" });
  const adminExt = String(req.user.ext || "");
  if (!SIP_CREDS[adminExt]) return res.status(400).json({ error: "داخلی SIP برای مدیر تعریف نشده است" });
  try {
    await pbx.monitor(adminExt, act.visitor.chan, m);
    audit(adminExt, "monitor-" + m, act.visitor.chan);
    res.json({ ok: true, mode: m });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ================= calls / CDR ================= */
app.get("/api/calls", auth(["admin", "operator"]), async (req, res) => {
  const { date, date2, status, op, q: search, limit = 100, offset = 0 } = req.query;
  const where = [], params = [];
  if (date && date2) { where.push("DATE(started_at) BETWEEN ? AND ?"); params.push(date, date2); }
  else if (date) { where.push("DATE(started_at)=?"); params.push(date); }
  if (status) { const list = status.split(",").filter(Boolean); where.push(`status IN (${list.map(() => "?").join(",")})`); params.push(...list); }
  if (op) { where.push("operator_ext=?"); params.push(op); }
  if (search) { where.push("(visitor_phone LIKE ? OR visitor_name LIKE ? OR unique_id LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
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
  audit(req.user.ext, "note", "call#" + req.params.id);
  res.json({ ok: true });
});

app.post("/api/calls/:id/disposition", auth(["admin", "operator"]), async (req, res) => {
  const d = String(req.body.disposition || "").slice(0, 38);
  await q("UPDATE calls SET disposition=? WHERE id=?", [d, req.params.id]);
  audit(req.user.ext, "disposition", `call#${req.params.id}=${d}`);
  res.json({ ok: true });
});

app.get("/api/records/:uniqueid", auth(["admin", "operator"]), async (req, res) => {
  const f = path.join(CFG.recLocal, path.basename(req.params.uniqueid) + ".wav");
  if (!fs.existsSync(f)) return res.status(404).json({ error: "recording not found" });
  res.set("Content-Type", "audio/wav");
  fs.createReadStream(f).pipe(res);
});

app.get("/api/export/cdr.csv", auth(["admin"]), async (req, res) => {
  const { date, date2 } = req.query;
  const where = [], params = [];
  if (date && date2) { where.push("DATE(started_at) BETWEEN ? AND ?"); params.push(date, date2); }
  else if (date) { where.push("DATE(started_at)=?"); params.push(date); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await q(`SELECT * FROM calls ${w} ORDER BY started_at DESC LIMIT 5000`, params);
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const cols = ["id","unique_id","visitor_name","visitor_phone","status","disposition","operator_ext","started_at","wait_sec","duration_sec","survey_rating","transferred_to"];
  const out = [cols.join(",")].concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\r\n");
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="cdr-${date || "all"}.csv"`);
  res.send("\uFEFF" + out);
});

/* ================= missed calls + callbacks ================= */
app.get("/api/missed", auth(["admin", "operator"]), async (req, res) => {
  const rows = await q(`SELECT c.*,
      (SELECT id FROM callbacks cb WHERE cb.call_id=c.id ORDER BY id DESC LIMIT 1) callback_id,
      (SELECT status FROM callbacks cb WHERE cb.call_id=c.id ORDER BY id DESC LIMIT 1) callback_status
    FROM calls c WHERE c.status='missed' ORDER BY c.started_at DESC LIMIT 200`);
  res.json(rows);
});

app.get("/api/callbacks", auth(["admin", "operator"]), async (req, res) => {
  const { status } = req.query;
  const w = status ? "WHERE status=?" : "";
  const rows = await q(`SELECT * FROM callbacks ${w} ORDER BY id DESC LIMIT 200`, status ? [status] : []);
  res.json(rows);
});

app.post("/api/callbacks", auth(["admin", "operator"]), async (req, res) => {
  const { call_id, phone, name, reason, assigned_to } = req.body || {};
  if (!phone) return res.status(400).json({ error: "شماره تماس لازم است" });
  const r = await q(`INSERT INTO callbacks (call_id,phone,name,reason,assigned_to,assigned_by,status)
    VALUES (?,?,?,?,?,?,'assigned')`,
    [call_id || null, String(phone).slice(0, 38), String(name || "").slice(0, 118),
     String(reason || "").slice(0, 248), String(assigned_to || "").slice(0, 9), String(req.user.ext || "")]);
  audit(req.user.ext, "callback-new", phone);
  io.emit("callback:new", { id: r.insertId, phone, assigned_to });
  postChatSystem(`🔔 کال‌بک جدید برای ${name || phone} ثبت شد${assigned_to ? ` (مسئول: داخلی ${assigned_to})` : ""}`);
  res.json({ ok: true, id: r.insertId });
});

app.post("/api/callbacks/:id", auth(["admin", "operator"]), async (req, res) => {
  const { status, note, assigned_to } = req.body || {};
  const sets = [], params = [];
  if (status && ["new", "assigned", "done", "failed"].includes(status)) {
    sets.push("status=?"); params.push(status);
    if (status === "done" || status === "failed") sets.push("done_at=NOW()");
  }
  if (note !== undefined) { sets.push("note=?"); params.push(String(note).slice(0, 1900)); }
  if (assigned_to !== undefined) { sets.push("assigned_to=?"); params.push(String(assigned_to).slice(0, 9)); }
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at=NOW()");
  params.push(req.params.id);
  await q(`UPDATE callbacks SET ${sets.join(",")} WHERE id=?`, params);
  audit(req.user.ext, "callback-upd", `#${req.params.id} ${status || ""}`);
  io.emit("callback:update", { id: +req.params.id, status });
  res.json({ ok: true });
});

/* ================= team chat ================= */
const dmChannel = (a, b) => "dm:" + [a, b].map((x) => String(x)).sort().join("-");

function postChatSystem(body, channel) {
  const chan = channel || "team";
  return q("INSERT INTO chat_messages (channel,from_ext,from_name,kind,body) VALUES (?,?,?,?,?)",
    [chan, "", "سیستم", "system", String(body).slice(0, 1900)])
    .then(() => io.to(chan).emit("chat:message", { channel: chan, from_ext: "", from_name: "سیستم", kind: "system", body: String(body).slice(0, 1900), ts: Date.now() }))
    .catch(() => {});
}

app.get("/api/chat/history", auth(), async (req, res) => {
  let { channel, after = 0, limit = 80 } = req.query;
  if (String(channel).startsWith("dm:")) {
    const parts = channel.split(":")[1].split("-").filter(Boolean);
    const myExt = String(req.user.ext || "");
    if (!parts.includes(myExt)) return res.status(403).json({ error: "forbidden" });
  }
  const rows = await q(`SELECT * FROM chat_messages WHERE channel=? AND id>? ORDER BY id DESC LIMIT ?`,
    [String(channel).slice(0, 58), +after, Math.min(+limit, 200)]);
  res.json(rows.reverse());
});

app.post("/api/chat/send", auth(), async (req, res) => {
  const { channel = "team", to, body } = req.body || {};
  const text = String(body || "").trim().slice(0, 1900);
  if (!text) return res.status(400).json({ error: "متن خالی است" });
  let chan = String(channel).slice(0, 58);
  if (chan === "dm") chan = dmChannel(req.user.ext, to);
  const r = await q(`INSERT INTO chat_messages (channel,from_ext,from_name,kind,body) VALUES (?,?,?,?,?)`,
    [chan, String(req.user.ext || ""), req.user.name || "", "user", text]);
  const msg = { id: r.insertId, channel: chan, from_ext: String(req.user.ext || ""), from_name: req.user.name, kind: "user", body: text, ts: Date.now() };
  io.to(chan).emit("chat:message", msg);
  res.json({ ok: true, msg });
});

/* ================= network quality ================= */
app.post("/api/quality/report", auth(["admin", "operator"]), async (req, res) => {
  const { rtt_ms = 0, jitter_ms = 0, loss_pct = 0, mos = 0, unique_id = "", detail = "" } = req.body || {};
  const ext = String(req.user.ext || "visitor");
  await q(`INSERT INTO quality_samples (ext,unique_id,side,rtt_ms,jitter_ms,loss_pct,mos,detail) VALUES (?,?,?,?,?,?,?,?)`,
    [ext.slice(0, 15), String(unique_id).slice(0, 62), req.user.role === "admin" ? "admin" : "agent",
     +rtt_ms || 0, +jitter_ms || 0, +loss_pct || 0, +mos || 0, String(detail).slice(0, 480)]).catch(() => {});
  /* degraded-network alerting */
  if ((+loss_pct > 8) || (+mos > 0 && +mos < 3.1)) {
    const a = { level: "bad", ext, loss_pct: +loss_pct, mos: +mos, rtt_ms: +rtt_ms, jitter_ms: +jitter_ms };
    io.to("admin").emit("quality:alert", a);
    live.alert(`کیفیت شبکه ضعیف — داخلی ${ext} (MOS ${(+mos).toFixed(1)}, اتلاف ${(+loss_pct).toFixed(0)}٪)`, "bad");
  }
  res.json({ ok: true });
});

/* visitor-side quality (widget has no JWT) */
app.post("/api/quality/visitor", (req, res) => {
  const { rtt_ms = 0, jitter_ms = 0, loss_pct = 0, mos = 0, unique_id = "", detail = "" } = req.body || {};
  q(`INSERT INTO quality_samples (ext,unique_id,side,rtt_ms,jitter_ms,loss_pct,mos,detail) VALUES (?,?,?,?,?,?,?,?)`,
    ["visitor", String(unique_id).slice(0, 62), "visitor", +rtt_ms || 0, +jitter_ms || 0, +loss_pct || 0, +mos || 0, String(detail).slice(0, 480)]).catch(() => {});
  if ((+loss_pct > 8) || (+mos > 0 && +mos < 3.1)) {
    live.alert(`کیفیت شبکه بازدیدکننده ضعیف است (MOS ${(+mos).toFixed(1)})`, "bad");
  }
  res.json({ ok: true });
});

app.get("/api/quality/summary", auth(["admin"]), async (req, res) => {
  const perExt = await q(`SELECT ext,
      ROUND(AVG(rtt_ms)) rtt, ROUND(AVG(jitter_ms)) jitter,
      ROUND(AVG(loss_pct),1) loss, ROUND(AVG(mos),2) mos, COUNT(*) n
    FROM quality_samples WHERE created_at > DATE_SUB(NOW(), INTERVAL 1 DAY) AND ext<>''
    GROUP BY ext ORDER BY mos ASC`);
  const trend = await q(`SELECT DATE_FORMAT(created_at,'%H:00') h, ROUND(AVG(mos),2) mos, ROUND(AVG(loss_pct),1) loss
    FROM quality_samples WHERE created_at > DATE_SUB(NOW(), INTERVAL 12 HOUR) GROUP BY h ORDER BY h`);
  const alerts = await q(`SELECT ext,mos,loss_pct,rtt_ms,jitter_ms,created_at FROM quality_samples
    WHERE (mos>0 AND mos<3.1) OR loss_pct>8 ORDER BY created_at DESC LIMIT 30`);
  res.json({ perExt, trend, alerts });
});

/* ================= operator stats / wallboard ================= */
app.get("/api/stats", auth(["admin", "operator"]), async (req, res) => {
  const today = await q(`SELECT
    COUNT(*) total,
    SUM(status IN ('answered','completed')) answered,
    SUM(status='missed') missed,
    COALESCE(ROUND(AVG(NULLIF(wait_sec,0))),0) avg_wait,
    COALESCE(ROUND(AVG(NULLIF(survey_rating,0)),2),0) avg_rating,
    COALESCE(SUM(survey_rating IS NOT NULL),0) rated
    FROM calls WHERE DATE(started_at)=CURDATE()`);
  const last7 = await q(`SELECT DATE(started_at) d, COUNT(*) c, SUM(status IN ('answered','completed')) a, SUM(status='missed') m
    FROM calls WHERE started_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY DATE(started_at) ORDER BY d`);
  const hourly = await q(`SELECT HOUR(started_at) h, COUNT(*) c, SUM(status='missed') m
    FROM calls WHERE DATE(started_at)=CURDATE() GROUP BY h ORDER BY h`);
  res.json({ today: today[0], last7, hourly });
});

app.get("/api/wallboard", auth(), async (req, res) => {
  const t = await q(`SELECT
    COUNT(*) total,
    SUM(status IN ('answered','completed')) answered,
    SUM(status='missed') missed,
    SUM(CASE WHEN status IN ('answered','completed') AND wait_sec<=20 THEN 1 ELSE 0 END) inSL,
    COALESCE(ROUND(AVG(CASE WHEN status IN ('answered','completed') THEN NULLIF(wait_sec,0) END)),0) avg_wait,
    COALESCE(ROUND(AVG(CASE WHEN duration_sec>0 THEN duration_sec END)),0) aht,
    COALESCE(ROUND(AVG(NULLIF(survey_rating,0)),2),0) avg_rating
    FROM calls WHERE DATE(started_at)=CURDATE()`);
  const x = t[0] || {};
  const answeredN = +(x.answered || 0);
  res.json({
    waiting: live.summary().visitorChans,
    active: live.summary().active,
    ringing: live.summary().ringing,
    agentsReady: state.queueMemberSet.size,
    total: +(x.total || 0), answered: answeredN, missed: +(x.missed || 0),
    sl: answeredN ? Math.round(100 * +(x.inSL || 0) / answeredN) : 100,
    avg_wait: +(x.avg_wait || 0), aht: +(x.aht || 0), avg_rating: +(x.avg_rating || 0),
  });
});

app.get("/api/operator/perf", auth(["admin", "operator"]), async (req, res) => {
  const ext = req.query.ext || (req.user.role === "operator" ? req.user.ext : null);
  if (!ext) {
    const rows = await q(`SELECT u.sip_ext, u.name,
        COUNT(k.id) answered,
        COALESCE(ROUND(AVG(NULLIF(k.wait_sec,0))),0) avg_wait,
        COALESCE(ROUND(AVG(CASE WHEN k.duration_sec>0 THEN k.duration_sec END)),0) aht,
        COALESCE(ROUND(AVG(NULLIF(k.survey_rating,0)),2),0) rating,
        SUM(k.disposition='transferred') transfers
      FROM users u LEFT JOIN calls k ON k.operator_ext=u.sip_ext AND DATE(k.started_at)=CURDATE() AND k.status IN ('answered','completed')
      WHERE u.role IN ('admin','operator') AND u.active=1
      GROUP BY u.sip_ext,u.name ORDER BY answered DESC`);
    return res.json(rows);
  }
  const rows = await q(`SELECT
      COUNT(*) answered,
      COALESCE(ROUND(AVG(NULLIF(wait_sec,0))),0) avg_wait,
      COALESCE(ROUND(AVG(CASE WHEN duration_sec>0 THEN duration_sec END)),0) aht,
      COALESCE(ROUND(AVG(NULLIF(survey_rating,0)),2),0) rating,
      SUM(disposition='transferred') transfers
    FROM calls WHERE operator_ext=? AND DATE(started_at)=CURDATE() AND status IN ('answered','completed')`, [ext]);
  res.json(rows[0] || {});
});

/* ================= surveys ================= */
app.get("/api/survey/stats", auth(["admin"]), async (req, res) => {
  const dist = await q(`SELECT rating, COUNT(*) c FROM surveys WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY rating ORDER BY rating`);
  const perOp = await q(`SELECT operator_ext ext, ROUND(AVG(survey_rating),2) rating, COUNT(*) n FROM calls
    WHERE survey_rating IS NOT NULL AND operator_ext<>'' GROUP BY operator_ext ORDER BY rating DESC`);
  const recent = await q(`SELECT s.rating,s.source,s.created_at,c.visitor_name,c.visitor_phone,c.operator_ext FROM surveys s
    LEFT JOIN calls c ON c.unique_id=s.unique_id ORDER BY s.created_at DESC LIMIT 30`);
  res.json({ dist, perOp, recent });
});

/* ================= customers / CRM ================= */
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

/* ================= operators (admin) ================= */
app.get("/api/operators", auth(["admin"]), async (req, res) => {
  const rows = await q("SELECT id,username,name,role,sip_ext,active,pause_reason,last_active,created_at FROM users ORDER BY id");
  res.json(rows.map(u => ({ ...u, in_queue: state.queueMemberSet.has(String(u.sip_ext)), on_call: !!live.byExt(String(u.sip_ext)) })));
});

app.post("/api/operators", auth(["admin"]), async (req, res) => {
  const { username, password, name, role, sip_ext } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: "مقادیر ناقص است" });
  if (sip_ext && !/^1\d{3}$/.test(sip_ext)) return res.status(400).json({ error: "داخلی باید 4 رقم و با 1 شروع شود" });
  try {
    await q("INSERT INTO users (username,pass_hash,name,role,sip_ext) VALUES (?,?,?,?,?)",
      [username, bcrypt.hashSync(password, 10), name, role === "admin" ? "admin" : "operator", sip_ext || null]);
    audit(req.user.ext, "op-create", username);
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
  audit(req.user.ext, "op-edit", `#${req.params.id}`);
  res.json({ ok: true });
});

/* pause/unpause with reason (admin force, operator self) */
app.post("/api/operators/:ext/pause", auth(["admin", "operator"]), async (req, res) => {
  const ext = String(req.params.ext);
  if (req.user.role === "operator" && String(req.user.ext) !== ext)
    return res.status(403).json({ error: "forbidden" });
  const { paused, reason = "" } = req.body || {};
  try {
    await pbx.queuePause(ext, !!paused, String(reason).slice(0, 38));
    await q("UPDATE users SET pause_reason=? WHERE sip_ext=?", [paused ? String(reason).slice(0, 38) : "", ext]);
    audit(req.user.ext, paused ? "pause" : "unpause", `${ext} ${reason}`);
    io.emit("queue:members-refresh", {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ================= queue controls ================= */
app.get("/api/queue/members", auth(["admin", "operator"]), async (req, res) => {
  const rows = await q("SELECT username,name,sip_ext,role,active FROM users WHERE role IN ('admin','operator') ORDER BY id");
  res.json(rows.map(u => ({ ...u, in_queue: state.queueMemberSet.has(String(u.sip_ext)) })));
});

app.post("/api/queue/member", auth(["admin", "operator"]), async (req, res) => {
  const { ext, action } = req.body || {};
  if (req.user.role === "operator" && String(ext) !== String(req.user.ext))
    return res.status(403).json({ error: "forbidden" });
  let act = action;
  if (act === "toggle") act = state.queueMemberSet.has(String(ext)) ? "remove" : "add";
  try {
    if (act === "add") await pbx.queueAdd(ext);
    else await pbx.queueRemove(ext);
    audit(req.user.ext, "queue-" + act, ext);
    res.json({ ok: true, action: act });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ================= settings ================= */
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
    audit(req.user.ext, "settings-remote-db", "");
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ================= system health (admin) ================= */
app.get("/api/health/full", auth(["admin"]), async (req, res) => {
  const out = { version: CFG.version, uptime: Math.round(process.uptime()), time: new Date().toISOString() };
  out.ami = { connected: !!ami.logged, host: CFG.ami.host };
  try { out.ami.ping = await pbx.ping(); } catch { out.ami.ping = false; }
  try {
    const dbv = await q("SELECT VERSION() v");
    out.db = { ok: true, version: dbv[0].v };
  } catch (e) { out.db = { ok: false, error: e.message }; }
  try {
    const cnt = await q(`SELECT COUNT(*) n, COALESCE(SUM(status='missed'),0) missed FROM calls WHERE DATE(started_at)=CURDATE()`);
    out.today = { calls: cnt[0].n, missed: cnt[0].missed };
  } catch {}
  try {
    const rec = await q(`SELECT COUNT(*) n FROM calls WHERE recording_path<>'' AND recording_path IS NOT NULL`);
    out.recordings = rec[0].n;
  } catch {}
  out.turn = { host: CFG.turn.publicIp, port: 3478 };
  out.wss = { url: `wss://${CFG.publicOrigin.replace(/^https?:\/\//, "")}/ws` };
  res.json(out);
});

/* ================= API 404 ================= */
app.use("/api", (req, res) => res.status(404).json({ error: "no such endpoint" }));

module.exports = { app, server, io, CFG, ami, live, pbx, postChatSystem, socketsByExt };
