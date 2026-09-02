/* runtime.js — AMI wiring, socket.io, recordings pull, server listen */
const fs = require("fs");
const { Client } = require("ssh2");
const { app, server, io, CFG, ami } = require("./server");
const remote = require("./lib/remote");
const { q } = require("./lib/db");
const state = require("./lib/state");

/* ---------- AMI (instance created in server.js, shared singleton) ---------- */
let queueMembers = [];

async function addEvent(callId, event, payload) {
  try { await q("INSERT INTO call_events (call_id,event,payload) VALUES (?,?,?)", [callId, event, JSON.stringify(payload || {}).slice(0, 2000)]); } catch {}
}

async function upsertCall(ev) {
  // ev: {unique_id, caller, cname}
  const meta = parseCallerName(ev.cname || "");
  const [vid, vname, vphone] = [meta.visitorId, meta.name, meta.phone];
  let extra = {};
  if (vid) {
    const rows = await q("SELECT * FROM visitors WHERE visitor_id=? ORDER BY last_seen DESC LIMIT 1", [vid]);
    if (rows.length) extra = rows[0];
  }
  const exist = await q("SELECT id FROM calls WHERE unique_id=?", [ev.unique_id]);
  if (exist.length) return exist[0].id;
  const r = await q(`INSERT INTO calls (unique_id,visitor_name,visitor_phone,visitor_email,visitor_ip,visitor_id,page_url,user_agent,status,started_at)
    VALUES (?,?,?,?,?,?,?,?, 'waiting', NOW())`,
    [ev.unique_id, vname || extra.name || "", vphone || extra.phone || "", extra.email || "", extra.ip || "", vid || "", extra.page_url || "", (extra.user_agent || "").slice(0, 300)]);
  return r.insertId;
}

function parseCallerName(cn) {
  // format: v:<visitorId>|<name>|<phone>
  const out = { visitorId: "", name: "", phone: "" };
  if (!cn) return out;
  const m = String(cn).match(/^v:([^|]*)\|([^|]*)\|(.*)$/);
  if (m) { out.visitorId = m[1]; out.name = m[2]; out.phone = m[3]; }
  return out;
}

async function findCallByUniqueId(uid) {
  const rows = await q("SELECT * FROM calls WHERE unique_id=?", [uid]);
  return rows[0] || null;
}

ami.on("connected", () => {
  console.log("[ami] connected to", CFG.ami.host);
  state.amiLogged = true;
  io.to("admin").emit("ami:status", { connected: true });
  refreshQueueMembers();
});
ami.on("disconnected", (r) => {
  console.log("[ami] disconnected:", r);
  state.amiLogged = false;
  state.queueMemberSet.clear();
  io.to("admin").emit("ami:status", { connected: false });
});
ami.on("auth-failed", () => console.error("[ami] AUTH FAILED"));

ami.on("event", async (ev) => {
  try {
    const E = ev.Event;
    if (E === "Newchannel" && (ev.Channel || "").startsWith("PJSIP/visitor")) {
      const id = await upsertCall({ unique_id: ev.Uniqueid, caller: ev.CallerIDNum, cname: ev.CallerIDName });
      await addEvent(id, "newchannel", { channel: ev.Channel });
      io.to("admin").emit("call:new", { unique_id: ev.Uniqueid });
      broadcastQueue();
    }
    if (E === "QueueCallerJoin") {
      const c = await findCallByUniqueId(ev.Uniqueid);
      if (c) await addEvent(c.id, "queue-join", { position: ev.Position, queue: ev.Queue });
      io.to("admin").emit("call:update", { unique_id: ev.Uniqueid, status: "waiting", position: ev.Position });
    }
    if (E === "QueueCallerAbandon") {
      const c = await findCallByUniqueId(ev.Uniqueid);
      if (c) {
        await q("UPDATE calls SET status='missed', ended_at=NOW(), wait_sec=TIMESTAMPDIFF(SECOND,started_at,NOW()) WHERE id=?", [c.id]);
        await addEvent(c.id, "abandon", { position: ev.Position });
        io.to("admin").emit("call:update", { unique_id: ev.Uniqueid, status: "missed" });
      }
    }
    if (E === "AgentConnect") {
      const extM = String(ev.Interface || ev.MemberName || ev.Channel || "").match(/(1\d{3})/);
      const ext = extM ? extM[1] : "";
      const c = await findCallByUniqueId(ev.Uniqueid);
      if (c) {
        await q("UPDATE calls SET status='answered', answered_at=NOW(), wait_sec=TIMESTAMPDIFF(SECOND,started_at,NOW()), operator_ext=? WHERE id=?", [ext, c.id]);
        await addEvent(c.id, "agent-connect", { ext, member: ev.MemberName });
        io.to("admin").emit("call:update", { unique_id: ev.Uniqueid, status: "answered", operator: ext });
        io.to("op:" + ext).emit("call:incoming", { call: c });
        enrichAndPush(c, ext);
      }
    }
    if (E === "AgentComplete") {
      const c = await findCallByUniqueId(ev.Uniqueid);
      if (c) {
        await addEvent(c.id, "agent-complete", { holdtime: ev.Holdtime, talktime: ev.TalkTime });
        io.to("admin").emit("call:update", { unique_id: ev.Uniqueid, status: "completed" });
      }
    }
    if (E === "Hangup" && (ev.Channel || "").startsWith("PJSIP/visitor")) {
      const c = await findCallByUniqueId(ev.Uniqueid);
      if (c) {
        const answered = !!c.answered_at;
        await q(`UPDATE calls SET status=?, ended_at=NOW(),
                 duration_sec=TIMESTAMPDIFF(SECOND, COALESCE(answered_at,started_at), NOW())
                 WHERE id=?`, [answered ? "completed" : "missed", c.id]);
        await addEvent(c.id, "hangup", { cause: ev["Cause-txt"] || ev.Cause });
        io.to("admin").emit("call:update", { unique_id: ev.Uniqueid, status: answered ? "completed" : "missed" });
        const opExt = c.operator_ext;
        if (opExt) io.to("op:" + opExt).emit("call:ended", { unique_id: ev.Uniqueid });
        setTimeout(() => pullRecording(ev.Uniqueid).catch(() => {}), 6000);
      }
    }
    if (E === "UserEvent" && ev.UserEvent === "CallSurvey") {
      const uid = ev.UniqueID || ev.Uniqueid;
      const r = Math.max(0, Math.min(5, parseInt(ev.Rating) || 0));
      const c = await findCallByUniqueId(uid);
      if (c) {
        await q("INSERT INTO surveys (unique_id,rating,source) VALUES (?,?, 'ivr') ON DUPLICATE KEY UPDATE rating=VALUES(rating)", [uid, r]);
        await q("UPDATE calls SET survey_rating=? WHERE id=?", [r, c.id]);
        io.to("admin").emit("call:update", { unique_id: uid, survey: r });
      }
    }
    if (E === "QueueMember" || E === "QueueMemberAdded") {
      /* AMI uses StateInterface in QueueStatus listings, Interface in Added events */
      const m = String(ev.Interface || ev.StateInterface || "").match(/PJSIP\/(1\d{3})/);
      if (m) { state.queueMemberSet.add(m[1]); pushMembers(); }
    }
    if (E === "QueueMemberRemoved") {
      const m = String(ev.Interface || ev.StateInterface || "").match(/PJSIP\/(1\d{3})/);
      if (m) { state.queueMemberSet.delete(m[1]); pushMembers(); }
    }
    if (E === "QueueMemberPause") refreshQueueMembers();
  } catch (e) { console.error("[ami-event]", e.message); }
});

let refreshTimer = null;
async function refreshQueueMembers() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      /* QueueStatus re-emits QueueMember events -> repopulates state.queueMemberSet
         (QueueSummary only returns counters, not members) */
      await ami.sendAction("QueueStatus", { Queue: "support" });
      pushMembers();
      broadcastQueue();
    } catch {}
  }, 300);
}

async function pushMembers() {
  try {
    const rows = await q("SELECT username,name,sip_ext,role,active FROM users WHERE role IN ('admin','operator') AND active=1");
    io.to("admin").to("operators").emit("queue:members", {
      members: rows.map(u => ({ ...u, in_queue: state.queueMemberSet.has(String(u.sip_ext)) })),
      waiting: null,
    });
    broadcastQueue();
  } catch {}
}

async function broadcastQueue() {
  try {
    const rows = await q(`SELECT COUNT(*) c, COALESCE(MAX(TIMESTAMPDIFF(SECOND,started_at,NOW())),0) m FROM calls WHERE status='waiting'`);
    io.to("admin").to("operators").emit("queue:status", { waiting: rows[0].c, longest_wait: rows[0].m, online: state.queueMemberSet.size });
  } catch {}
}

/* ---------- CRM enrichment + POP push ---------- */
async function enrichAndPush(call, ext) {
  const cust = await remote.lookupCustomer({ phone: call.visitor_phone, email: call.visitor_email });
  const past = await q(`SELECT id,started_at,status,operator_ext,survey_rating,notes FROM calls
    WHERE id<>? AND (visitor_id=? OR (visitor_phone<>'' AND visitor_phone=?)) ORDER BY started_at DESC LIMIT 8`,
    [call.id, call.visitor_id || "", call.visitor_phone || ""]);
  const pop = {
    call,
    visitor: { name: call.visitor_name, phone: call.visitor_phone, email: call.visitor_email, ip: call.visitor_ip, page: call.page_url },
    crm: cust,
    past_calls: past,
  };
  io.to("op:" + ext).emit("pop:data", pop);
}

/* ---------- recordings via SFTP ---------- */
async function pullRecording(uniqueId) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const local = CFG.recLocal + "/" + uniqueId + ".wav";
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        const remote = CFG.recSpool + "/" + uniqueId + ".wav";
        sftp.stat(remote, (e) => {
          if (e) { conn.end(); return resolve(false); }
          sftp.fastGet(remote, local, (e2) => {
            conn.end();
            if (e2) return reject(e2);
            q("UPDATE calls SET recording_path=? WHERE unique_id=?", ["recordings/" + uniqueId + ".wav", uniqueId]).catch(() => {});
            resolve(true);
          });
        });
      });
    });
    conn.on("error", reject);
    conn.connect({ host: CFG.sftp.host, port: CFG.sftp.port, username: CFG.sftp.user,
      privateKey: fs.readFileSync(CFG.sftp.keyPath) });
  });
}

/* ---------- socket.io ---------- */
io.use((socket, next) => {
  try {
    const p = require("jsonwebtoken").verify((socket.handshake.auth || {}).token || "", CFG.jwt);
    socket.user = p; next();
  } catch { next(new Error("unauthorized")); }
});
io.on("connection", (socket) => {
  if (socket.user.role === "admin") socket.join("admin");
  if (socket.user.ext) socket.join("op:" + socket.user.ext);
  socket.join("operators");
  socket.emit("hello", { user: socket.user });
});

/* ---------- listen ---------- */
ami.connect();
server.listen(CFG.port, "127.0.0.1", () => console.log(`[callcenter] listening on 127.0.0.1:${CFG.port}`));

process.on("uncaughtException", (e) => console.error("[uncaught]", e.message));
process.on("unhandledRejection", (e) => console.error("[unhandled]", (e && e.message) || e));
