/* lib/livemon.js — live call tracker built from AMI events.
 *
 * Tracks every PJSIP channel: state, bridges, linked legs, and exposes:
 *   getLive()   → array of active calls with sides {visitor, agent}, timers
 *   byExt(ext)  → the active call for one operator extension (for transfer UI)
 *   summary()   → counters for wallboard
 * Broadcasts "live:update" to room "admin" on every structural change.
 *
 * Channel naming conventions in this deployment:
 *   PJSIP/visitor-xxxx  → website visitor leg (customer side)
 *   PJSIP/1xxx-xxxx     → operator web phone
 *   Local/...           → monitor / dialplan helper legs (ignored)
 */
const { EventEmitter } = require("events");

class LiveMonitor extends EventEmitter {
  constructor() {
    super();
    this.chans = new Map();      // uniqueid -> chan info
    this.bridgeMembers = new Map(); // bridgeUniqueid -> Set(uniqueids)
    this.io = null;              // socket.io (admin room)
    this.lastAlerts = [];        // recent system alerts (kept small)
  }

  attach(io, ami) {
    this.io = io;
    const H = (name, fn) => ami.on(name, (ev) => { try { fn(ev); } catch (e) { console.error("[livemon]", name, e.message); } });

    H("Newchannel", (ev) => {
      if (!this._isPjsip(ev.Channel)) return;
      this.chans.set(ev.Uniqueid, {
        uid: ev.Uniqueid,
        chan: ev.Channel,
        kind: this._kind(ev.Channel),
        callerNum: ev.CallerIDNum || "",
        callerName: ev.CallerIDName || "",
        ext: this._ext(ev.Channel),
        state: "down",
        since: Date.now(),
        answeredAt: null,
        bridgedUid: null,
        dialedExt: null,
      });
      this._push();
    });

    H("Newstate", (ev) => {
      const c = this.chans.get(ev.Uniqueid);
      if (!c) return;
      c.state = (ev.ChannelStateDesc || "").toLowerCase();
      if (c.state === "up" && !c.answeredAt) c.answeredAt = Date.now();
      this._push();
    });

    H("DialBegin", (ev) => {
      const dest = this.chans.get(ev.DestUniqueid);
      const src = this.chans.get(ev.Uniqueid);
      if (dest && src) {
        dest.dialedExt = this._ext(ev.DestChannel || "") || dest.dialedExt;
        dest.dialFrom = src.uid;
      }
    });

    H("BridgeEnter", (ev) => {
      const c = this.chans.get(ev.Uniqueid);
      const b = ev.BridgeUniqueid;
      if (!c || !b) return;
      if (!this.bridgeMembers.has(b)) this.bridgeMembers.set(b, new Set());
      this.bridgeMembers.get(b).add(c.uid);
      c.bridgedUid = b;
      this._push();
    });

    H("BridgeLeave", (ev) => {
      const c = this.chans.get(ev.Uniqueid);
      const b = ev.BridgeUniqueid;
      if (!c || !b) return;
      const set = this.bridgeMembers.get(b);
      if (set) set.delete(c.uid);
      c.bridgedUid = null;
      this._push();
    });

    H("Hangup", (ev) => {
      const gone = this.chans.has(ev.Uniqueid);
      this.chans.delete(ev.Uniqueid);
      for (const [b, set] of this.bridgeMembers) set.delete(ev.Uniqueid);
      if (gone) this._push();
    });
  }

  _isPjsip(ch) { return String(ch || "").startsWith("PJSIP/"); }
  _kind(ch) {
    if (/^PJSIP\/visitor/i.test(ch)) return "visitor";
    const m = String(ch).match(/^PJSIP\/(1\d{3})/);
    if (m) return "agent";
    return "other";
  }
  _ext(ch) {
    const m = String(ch || "").match(/^PJSIP\/(1\d{3})/);
    return m ? m[1] : null;
  }

  /* active calls = bridges that pair a visitor leg with an agent leg */
  getLive() {
    const now = Date.now();
    const out = [];
    for (const [b, set] of this.bridgeMembers) {
      const legs = [...set].map((u) => this.chans.get(u)).filter(Boolean);
      const vis = legs.find((l) => l.kind === "visitor");
      const ag = legs.find((l) => l.kind === "agent");
      if (!vis && !ag) continue;
      const first = legs.sort((x, y) => x.since - y.since)[0];
      out.push({
        bridge: b,
        visitor: vis ? { chan: vis.chan, caller: vis.callerNum, name: vis.callerName, uid: vis.uid } : null,
        agent: ag ? { chan: ag.chan, ext: ag.ext, uid: ag.uid } : null,
        startedAt: first ? first.since : now,
        answeredAt: first && first.answeredAt,
        talkSec: first && first.answeredAt ? Math.floor((now - first.answeredAt) / 1000) : 0,
        ringing: !legs.some((l) => l.answeredAt),
      });
    }
    /* agent ringing (dialing) without bridge yet */
    for (const c of this.chans.values()) {
      if (c.kind === "agent" && c.dialedExt && !c.bridgedUid) {
        const src = c.dialFrom ? this.chans.get(c.dialFrom) : null;
        if (src && !src.bridgedUid) {
          out.push({
            bridge: "dial:" + c.uid,
            visitor: { chan: src.chan, caller: src.callerNum, name: src.callerName, uid: src.uid },
            agent: { chan: c.chan, ext: c.ext, uid: c.uid },
            startedAt: c.since, answeredAt: null, talkSec: 0, ringing: true,
          });
        }
      }
    }
    return out;
  }

  byExt(ext) {
    return this.getLive().find((c) => String(c.agent && c.agent.ext) === String(ext)) || null;
  }

  byVisitorUid(uid) {
    return this.getLive().find((c) => c.visitor && c.visitor.uid === uid) || null;
  }

  /* the operator's SECOND agent channel (attended-transfer consult leg) */
  consultChan(ext, excludeUid) {
    for (const c of this.chans.values()) {
      if (c.kind === "agent" && String(c.ext) === String(ext) && c.uid !== excludeUid) return c;
    }
    return null;
  }

  summary() {
    const live = this.getLive();
    return {
      active: live.filter((c) => !c.ringing).length,
      ringing: live.filter((c) => c.ringing).length,
      agentChans: [...this.chans.values()].filter((c) => c.kind === "agent").length,
      visitorChans: [...this.chans.values()].filter((c) => c.kind === "visitor").length,
    };
  }

  alert(text, level) {
    const a = { text, level: level || "warn", at: new Date().toISOString() };
    this.lastAlerts.unshift(a);
    this.lastAlerts = this.lastAlerts.slice(0, 30);
    if (this.io) this.io.to("admin").emit("sys:alert", a);
  }

  _push() {
    if (!this.io) return;
    this.io.to("admin").emit("live:update", { calls: this.getLive(), summary: this.summary() });
  }
}

module.exports = { LiveMonitor };
