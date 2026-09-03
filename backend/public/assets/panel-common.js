/* ============================================================
 * callcenter-web v3 — panel-common.js
 * Shared runtime for admin & operator panels:
 *   CC.api        fetch wrapper with JWT
 *   CC.sock       socket.io with auth + auto-reconnect
 *   CC.toast()    notifications
 *   CC.modal()    modal open/close
 *   CC.Quality    live WebRTC quality monitor → MOS + server report
 *   CC.Chat       reusable team chat component
 *   CC.ring()     ringtone via WebAudio (no asset needed)
 *   helpers: esc, faNum, faTime, faDur, faStatus, faType, faDisp
 * ============================================================ */
window.CC = (function () {
  const T = localStorage.getItem("cc_token") || "";
  let ME = null;
  let sock = null;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const faNum = (x) => String(x == null ? "" : x).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
  const faTime = (s) => { if (!s) return "—"; const d = new Date(s); return faNum(d.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })); };
  const faDate = (s) => { if (!s) return "—"; const d = new Date(s); return faNum(d.toLocaleDateString("fa-IR", { month: "2-digit", day: "2-digit" })) + " " + faTime(s); };
  const faDur = (sec) => { sec = +sec || 0; const m = Math.floor(sec / 60), s = sec % 60; return faNum(m + ":" + String(s).padStart(2, "0")); };
  const faStatus = (s) => ({ waiting: "در انتظار", ringing: "در حال زنگ", answered: "پاسخ داده شد", completed: "تکمیل شد", missed: "ازدست‌رفته" }[s] || s || "—");
  const faType = (t) => ({ FLIGHT: "پرواز", HOTEL: "هتل", TOUR: "تور", TRAIN: "قطار", VISA: "ویزا", INSURANCE: "بیمه", ESIM: "ایسیم" }[String(t || "").toUpperCase()] || t || "—");
  const faDisp = (d) => ({ solved: "حل شد", followup: "نیازمند پیگیری", booked: "رزرو/فروش", irrelevant: "نامربوط", transferred: "انتقال داده شد" }[d] || d || "—");
  const statusBdg = (s) => ({ waiting: "warn", ringing: "info", answered: "info", completed: "ok", missed: "bad" }[s] || "gray");

  /* ---------- api ---------- */
  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + T }, opts.headers || {}),
      body: opts.body,
    });
    if (r.status === 401) { localStorage.removeItem("cc_token"); location.reload(); throw new Error("unauthorized"); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || "خطای سرور"), { data: d });
    return d;
  }

  /* ---------- toast ---------- */
  let toastT = null;
  function toast(m, kind, ms) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
    el.textContent = m;
    el.className = "on" + (kind ? " " + kind : "");
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.className = ""; }, ms || 2800);
  }

  /* ---------- modal ---------- */
  function modal(id, on) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("on", on !== false);
  }

  /* ---------- ringtone (WebAudio, zero assets) ---------- */
  let actx = null, ringI = null;
  function beep(freq, dur, when, vol) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; o.type = "sine";
    g.gain.setValueAtTime(0, actx.currentTime + when);
    g.gain.linearRampToValueAtTime(vol || 0.14, actx.currentTime + when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + when + dur);
    o.connect(g).connect(actx.destination);
    o.start(actx.currentTime + when); o.stop(actx.currentTime + when + dur + 0.05);
  }
  function ring() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume().catch(() => {});
      stopRing();
      const twoTone = () => { beep(440, 0.4, 0); beep(480, 0.4, 0); beep(440, 0.4, 0.5); beep(480, 0.4, 0.5); };
      twoTone();
      ringI = setInterval(twoTone, 2000);
    } catch (e) {}
  }
  function stopRing() { if (ringI) { clearInterval(ringI); ringI = null; } }
  function ding() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); beep(880, 0.12, 0, 0.1); beep(1174, 0.18, 0.12, 0.1); } catch (e) {} }

  /* ---------- network quality monitor (WebRTC stats → MOS) ----------
   * MOS (simplified ITU-T G.107):
   *   effective latency = rtt + 2*jitter + 10
   *   R = 93.2 - (effLat-160)/40 - loss*2.5   (clamped)
   *   MOS = 1 + 0.035R + 7e-6*R*(R-60)*(100-R)  for R<100 else 4.5
   */
  function mosFromStats(rtt, jitter, lossPct) {
    const eff = (rtt || 0) + 2 * (jitter || 0) + 10;
    let R = 93.2 - Math.max(0, (eff - 160) / 40) - (lossPct || 0) * 2.5;
    R = Math.max(0, Math.min(100, R));
    const mos = R >= 100 ? 4.5 : 1 + 0.035 * R + 7e-6 * R * (R - 60) * (100 - R);
    return Math.max(1, Math.min(4.5, +mos.toFixed(2)));
  }

  const Quality = {
    timer: null, last: { rtt: 0, jitter: 0, loss: 0, mos: 0 }, pc: null,
    start(pc, uniqueId) {
      this.stop(); this.pc = pc; this._uid = uniqueId || "";
      this.timer = setInterval(() => this.sample(), 10000);
      setTimeout(() => this.sample(), 2500);
    },
    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.pc = null; },
    async sample() {
      const pc = this.pc; if (!pc || pc.connectionState === "closed") return;
      try {
        const stats = await pc.getStats();
        let rtt = 0, jitter = 0, lost = 0, recv = 0;
        stats.forEach((r) => {
          if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) rtt = Math.round(r.currentRoundTripTime * 1000);
          if (r.type === "inbound-rtp" && r.kind === "audio") {
            jitter = Math.round((r.jitter || 0) * 1000);
            lost = r.packetsLost || 0; recv = r.packetsReceived || 0;
          }
        });
        const loss = (lost + recv) > 0 ? +(100 * lost / (lost + recv)).toFixed(1) : 0;
        const mos = mosFromStats(rtt, jitter, loss);
        this.last = { rtt, jitter, loss, mos };
        api("/api/quality/report", { method: "POST", body: JSON.stringify({ rtt_ms: rtt, jitter_ms: jitter, loss_pct: loss, mos, unique_id: this._uid, detail: "panel" }) }).catch(() => {});
        this.onupdate && this.onupdate(this.last);
      } catch (e) {}
    },
    badgeHTML(q) {
      const m = q ? q.mos : 0;
      const cls = m >= 4 ? "g" : m >= 3.1 ? "m" : "b";
      const label = !m ? "کیفیت شبکه" : (m >= 4 ? "شبکه عالی" : m >= 3.1 ? "شبکه قابل‌قبول" : "شبکه ضعیف!");
      return `<span class="qm ${cls}" id="qbadge" title="تأخیر ${q ? q.rtt : 0}ms • جیتر ${q ? q.jitter : 0}ms • اتلاف ${q ? q.loss : 0}% • MOS ${m}"><span class="bars"><i></i><i></i><i></i><i></i></span>${esc(label)}</span>`;
    },
  };

  /* ---------- socket ---------- */
  function connectSocket(handlers) {
    sock = io({ auth: { token: T } });
    sock.on("connect", () => handlers && handlers.onConnect && handlers.onConnect());
    sock.on("disconnect", () => handlers && handlers.onDisconnect && handlers.onDisconnect());
    sock.on("sys:alert", (a) => { toast(a.text, a.level === "bad" ? "err" : ""); handlers && handlers.onAlert && handlers.onAlert(a); });
    sock.on("chat:message", (m) => handlers && handlers.onChat && handlers.onChat(m));
    sock.on("presence", (p) => handlers && handlers.onPresence && handlers.onPresence(p));
    sock.on("quality:alert", (a) => handlers && handlers.onQuality && handlers.onQuality(a));
    sock.on("callback:new", (c) => { ding(); handlers && handlers.onCallback && handlers.onCallback(c); });
    return sock;
  }

  /* ---------- reusable chat ---------- */
  function Chat(opts) {
    // opts: {mount, meExt, meName, teamList(), canDM}
    const root = document.getElementById(opts.mount);
    const state = { chan: "team", unread: { team: 0 }, dms: {}, typingT: null, typingTo: null };

    root.innerHTML = `
      <div class="chatbox card dark" style="padding:0;overflow:hidden">
        <div class="chathead" id="ch_tabs"></div>
        <div class="chatmsg" id="ch_msgs"></div>
        <div class="typing" id="ch_typing"></div>
        <div class="chatinput">
          <input id="ch_in" placeholder="پیام به تیم…" maxlength="1800">
          <button class="btn p" id="ch_send">ارسال</button>
        </div>
      </div>`;

    const tabs = root.querySelector("#ch_tabs"), msgs = root.querySelector("#ch_msgs"),
      input = root.querySelector("#ch_in"), sendB = root.querySelector("#ch_send"), typingEl = root.querySelector("#ch_typing");

    function chanId(c) { return c; }
    function renderTabs() {
      const team = opts.teamList ? opts.teamList() : [];
      let h = `<button class="ch ${state.chan === "team" ? "on" : ""}" data-c="team">👥 کل تیم ${state.unread.team ? `<b style="color:#fca5a5">(${faNum(state.unread.team)})</b>` : ""}</button>`;
      team.forEach((t) => {
        if (String(t.ext) === String(opts.meExt)) return;
        const dm = "dm:" + [opts.meExt, t.ext].sort().join("-");
        h += `<button class="ch ${state.chan === dm ? "on" : ""}" data-c="${esc(dm)}">${esc(t.name)} ${t.online ? '<span class="u"></span>' : ""} ${state.dms[dm] ? `<b style="color:#fca5a5">(${faNum(state.dms[dm])})</b>` : ""}</button>`;
      });
      tabs.innerHTML = h;
      tabs.querySelectorAll(".ch").forEach((b) => b.addEventListener("click", () => switchChan(b.dataset.c)));
    }
    async function switchChan(c) {
      state.chan = c;
      if (c === "team") state.unread.team = 0; else state.dms[c] = 0;
      input.placeholder = c === "team" ? "پیام به تیم…" : "پیام مستقیم…";
      msgs.innerHTML = `<div class="empty">در حال بارگذاری…</div>`;
      try {
        const hist = await api("/api/chat/history?channel=" + encodeURIComponent(c) + "&after=0");
        msgs.innerHTML = hist.map(bubbleHTML).join("") || `<div class="empty">گفتگو را شروع کنید 👋</div>`;
        msgs.scrollTop = msgs.scrollHeight;
      } catch (e) { msgs.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
      renderTabs();
    }
    function bubbleHTML(m) {
      const mine = String(m.from_ext) === String(opts.meExt);
      const cls = m.kind === "system" ? "sys" : mine ? "me" : "them";
      const who = m.kind === "system" ? "" : `<div class="who2">${esc(m.from_name || "")}${m.from_ext ? " • داخلی " + faNum(m.from_ext) : ""} • ${faTime(m.ts ? new Date(m.ts).toISOString() : m.created_at)}</div>`;
      return `<div class="bub ${cls}">${esc(m.body).replace(/\n/g, "<br>")}${who}</div>`;
    }
    function push(m) {
      if (String(m.channel) !== String(state.chan)) {
        if (m.channel === "team") state.unread.team++; else state.dms[m.channel] = (state.dms[m.channel] || 0) + 1;
        renderTabs(); ding();
        if (m.kind !== "system" && String(m.from_ext) !== String(opts.meExt)) toast("💬 پیام از " + (m.from_name || "داخلی " + faNum(m.from_ext || "")));
        return;
      }
      const near = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 120;
      msgs.insertAdjacentHTML("beforeend", bubbleHTML(m));
      if (near) msgs.scrollTop = msgs.scrollHeight;
    }
    function send() {
      const v = input.value.trim(); if (!v) return;
      const isDM = state.chan.startsWith("dm:");
      sock.emit("chat:join", state.chan);
      api("/api/chat/send", { method: "POST", body: JSON.stringify({ channel: isDM ? "dm" : "team", to: isDM ? state.chan.split(":")[1].split("-").find((x) => x !== String(opts.meExt)) : undefined, body: v }) }).catch((e) => toast(e.message, "err"));
      input.value = "";
    }
    sendB.addEventListener("click", send);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    input.addEventListener("input", () => {
      sock.emit("chat:typing", { channel: state.chan });
    });
    sock && sock.on && null;

    return {
      push, renderTabs, switchChan,
      typing: (d) => { typingEl.textContent = d && d.channel === state.chan ? `${d.from} در حال نوشتن…` : ""; clearTimeout(typingTo); typingTo = setTimeout(() => { typingEl.textContent = ""; }, 2200); },
      refresh: () => switchChan(state.chan),
    };
  }

  /* ---------- live clock ---------- */
  function clock(el) {
    const f = () => { el.textContent = faNum(new Date().toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })); };
    f(); setInterval(f, 15000);
  }

  return { T, setMe: (m) => { ME = m; }, me: () => ME, api, toast, modal, esc, faNum, faTime, faDate, faDur, faStatus, faType, faDisp, statusBdg, ring, stopRing, ding, Quality, mosFromStats, connectSocket, Chat, clock, get sock() { return sock; } };
})();
