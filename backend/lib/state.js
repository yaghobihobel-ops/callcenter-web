/* lib/state.js — shared runtime state between server.js and runtime.js */
module.exports = {
  queueMemberSet: new Set(),   // exts currently in queue, e.g. "1001"
  amiLogged: false,
};
