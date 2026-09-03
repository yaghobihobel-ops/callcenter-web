/* lib/pbx.js — high-level PBX operations over AMI (Asterisk 18/20, PJSIP)
 *
 * Transfer semantics:
 *   blindTransfer(visitorChan, targetExt):
 *     AMI Redirect → drops visitor channel into [cc-transfer] dialplan which
 *     dials PJSIP/<targetExt>. Agent leg receives BYE automatically.
 *   completeAttended(chanA, chanB):
 *     AMI Bridge → directly bridges the visitor channel with the consult
 *     channel (agent placed the first call on hold via SIP re-INVITE and
 *     consulted a second party). Both agent legs drop out of the PBX.
 *
 * Monitor semantics (admin listen/whisper/barge):
 *   Originate PJSIP/<adminExt> → [cc-monitor] spy → ChanSpy(target,mode)
 *     listen:  q   (spy hears call only)
 *     whisper: qw  (spy hears call; ONLY the spied channel hears the spy — coach)
 *     barge:   qB  (spy hears call; BOTH sides hear the spy)
 */
let _ami = null;
function bindAmi(amiClient) { _ami = amiClient; }

async function ping() {
  const res = await _ami.sendAction("Ping");
  return res && res.Ping === "Pong";
}

async function getVar(channel, variable) {
  const res = await _ami.sendAction("GetVar", { Channel: channel, Variable: variable });
  return res && res.Value;
}

/* ---------- transfers ---------- */
async function blindTransfer(visitorChan, targetExt) {
  if (!/^PJSIP\//.test(visitorChan)) throw new Error("bad channel");
  if (!/^1\d{3}$/.test(String(targetExt))) throw new Error("bad target extension");
  await _ami.sendAction("Redirect", {
    Channel: visitorChan,
    Context: "cc-transfer",
    Exten: String(targetExt),
    Priority: 1,
  });
  return true;
}

async function completeAttended(chanA, chanB) {
  if (!/^PJSIP\//.test(chanA) || !/^PJSIP\//.test(chanB)) throw new Error("bad channel(s)");
  await _ami.sendAction("Bridge", { Channel1: chanA, Channel2: chanB });
  return true;
}

/* ---------- monitoring (admin) ---------- */
async function monitor(adminExt, targetChan, mode) {
  if (!/^1\d{3}$/.test(String(adminExt))) throw new Error("bad admin ext");
  if (!/^PJSIP\//.test(targetChan)) throw new Error("bad target channel");
  const opts = { listen: "q", whisper: "qw", barge: "qB" };
  const spyOpts = opts[mode] || "q";
  await _ami.sendAction("Originate", {
    Channel: `PJSIP/${adminExt}`,
    Context: "cc-monitor",
    Exten: "spy",
    Priority: 1,
    CallerID: `Monitor <${adminExt}>`,
    Timeout: 30000,
    Variable: `SPY_TARGET=${targetChan},SPY_MODE=${spyOpts}`,
    Async: "true",
  });
  return true;
}

/* ---------- queue member ops ---------- */
async function queueAdd(ext) {
  await _ami.sendAction("QueueAdd", {
    Queue: "support", Interface: `PJSIP/${ext}`,
    MemberName: `operator-${ext}`, Penalty: 0,
  });
}
async function queueRemove(ext) {
  await _ami.sendAction("QueueRemove", { Queue: "support", Interface: `PJSIP/${ext}` });
}
async function queuePause(ext, paused, reason) {
  await _ami.sendAction("QueuePause", {
    Queue: "support", Interface: `PJSIP/${ext}`,
    Paused: paused ? "true" : "false",
    Reason: reason || "",
  });
}

/* ---------- channels ---------- */
async function listChannels() {
  const res = await _ami.sendAction("CoreShowChannels");
  const list = [];
  const events = Array.isArray(res) ? res : (res && res.channels) || [];
  for (const ev of events) {
    if (!ev || !ev.Channel || !/^PJSIP\//.test(ev.Channel)) continue;
    list.push({
      name: ev.Channel,
      callerID: ev.CallerIDNum || "",
      state: ev.ChannelStateDesc || ev.State || "",
      duration: parseInt(ev.Duration || "0", 10),
      bridgeId: ev.BridgeNum || ev.BridgedTo || "",
    });
  }
  return list;
}

/* ---------- health ---------- */
async function registrations() {
  /* SIPpevents stream is async; use PJSIPShowRegistrationsInbound? For WebRTC
     endpoints contacts matter. Return AMI liveness only; livemon holds detail. */
  return { ok: await ping() };
}

module.exports = {
  bindAmi, ping, getVar, listChannels,
  blindTransfer, completeAttended, monitor,
  queueAdd, queueRemove, queuePause,
  registrations,
};
