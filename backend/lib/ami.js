/* lib/ami.js — minimal Asterisk Manager Interface client */
const net = require("net");
const { EventEmitter } = require("events");

class AmiClient extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host;
    this.port = opts.port || 5038;
    this.user = opts.user;
    this.pass = opts.pass;
    this.sock = null;
    this.buf = "";
    this.logged = false;
    this.reconnectDelay = 3000;
    this.actionId = 0;
    this.pending = new Map();
  }

  connect() {
    this.sock = net.createConnection({ host: this.host, port: this.port });
    this.sock.setEncoding("utf8");
    this.sock.on("data", (d) => this._onData(d));
    this.sock.on("error", (e) => this._onClose(`socket ${e.code || e.message}`));
    this.sock.on("close", () => this._onClose("closed"));
    this.sock.on("connect", () => {
      this.sendAction("Login", { Username: this.user, Secret: this.pass });
    });
  }

  _onClose(reason) {
    if (this.logged || this._wasConnected) {
      this.logged = false;
      this.emit("disconnected", reason);
      setTimeout(() => this.connect(), this.reconnectDelay);
    }
    this._wasConnected = false;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\r\n\r\n")) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 4);
      this._handlePacket(raw);
    }
  }

  _handlePacket(raw) {
    const lines = raw.split("\r\n");
    const ev = {};
    let lastKey = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const ci = line.indexOf(":");
      if (ci > 0) {
        const key = line.slice(0, ci).trim();
        ev[key] = line.slice(ci + 1).trim();
        lastKey = key;
      } else if (lastKey) {
        ev[lastKey] += "\n" + line.trim(); // multiline (e.g. variables)
      }
    }
    if (ev.Response && !ev.Event) {
      // action response
      const p = this.pending.get(ev.ActionID);
      if (p) {
        this.pending.delete(ev.ActionID);
        if (ev.Response === "Success") p.resolve(ev);
        else p.reject(new Error(ev.Message || "AMI error"));
      }
      if (ev.Message === "Authentication accepted") {
        this.logged = true;
        this._wasConnected = true;
        this.emit("connected");
      }
      if (ev.Message === "Authentication failed") {
        this.emit("auth-failed");
      }
      return;
    }
    if (ev.Event) {
      if (ev.Event === "FullyBooted") {
        this.logged = true;
        this._wasConnected = true;
        this.emit("connected");
      }
      this.emit("event", ev);
      this.emit(ev.Event, ev);
    }
  }

  sendAction(action, params = {}) {
    const id = `cc${Date.now()}${++this.actionId}`;
    let out = `Action: ${action}\r\nActionID: ${id}\r\n`;
    for (const [k, v] of Object.entries(params)) out += `${k}: ${v}\r\n`;
    out += "\r\n";
    if (this.sock && this.sock.writable) this.sock.write(out);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("AMI timeout"));
        }
      }, 8000);
    });
  }
}

module.exports = { AmiClient };
