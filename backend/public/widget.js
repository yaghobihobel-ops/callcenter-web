/* ============================================================
 * firuzo.online — Web Call Widget v2.0
 * Embed: <script src="https://call.firuzo.online/widget.js" defer></script>
 * - Beautiful launcher + panel (mobile bottom-sheet / desktop card, RTL)
 * - Hooks onto existing contact buttons:
 *     a[href="tel:+982191000000"], [data-fz-call], .fz-call-trigger
 * - JS API: window.FiruzoCall.open() / .close() / .startCall()
 * - Microphone permission flow with per-browser recovery guidance
 * - Cross-browser fallbacks (tel: card) when WebRTC/mic unavailable
 * - Audio via SIP over WSS (SIP.js loaded lazily on first open)
 * ============================================================ */
(function () {
  "use strict";
  if (window.__firuzoCallWidget) return;
  window.__firuzoCallWidget = true;

  var API = "https://call.firuzo.online";
  var P = "fzw2-";
  var Z = 2147483000;

  /* ---------------- tiny utils ---------------- */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function uid() {
    try {
      var v = localStorage.getItem("fzw_vid");
      if (v) return v;
      v = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
      localStorage.setItem("fzw_vid", v); return v;
    } catch (e) { return "vanon-" + Math.random().toString(36).slice(2, 9); }
  }
  var vid = uid();

  var DEFAULT_PHONE = "+982191000000";
  var cfg = null;
  var supportPhone = DEFAULT_PHONE;

  /* ---------------- feature detection ---------------- */
  function hasWebRTC() {
    try {
      return !!(window.RTCPeerConnection || window.webkitRTCPeerConnection)
        && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket);
    } catch (e) { return false; }
  }
  function browserName() {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua)) return "ios";
    if (/SamsungBrowser/.test(ua)) return "samsung";
    if (/Android/.test(ua)) return "android";
    if (/Firefox\//.test(ua)) return "firefox";
    if (/Edg\//.test(ua)) return "edge";
    if (/Chrome\//.test(ua)) return "chrome";
    if (/Safari\//.test(ua)) return "safari";
    return "other";
  }
  function isMobile() { return window.matchMedia("(max-width: 820px)").matches; }

  var PHONE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z"/></svg>';
  var MIC_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>';
  var MUTE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.98 6.98 0 0 0 19 11zM15 11.16 9 5.18V5a3 3 0 0 1 5.83-1H17a5 5 0 0 0-9.9-.14L15 11.16zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 4.24 2.72l1.55 1.55A5 5 0 0 1 7 11H5a7 7 0 0 0 6.83 6.99V21h2.17v-3.01c.34-.05.67-.12 1-.22l4.73 4.73 1.27-1.27z"/></svg>';
  var END_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';

  /* ---------------- CSS ---------------- */
  var css =
    "." + P + "host,." + P + "host *{box-sizing:border-box;margin:0;padding:0;font-family:Vazirmatn,'Segoe UI',Tahoma,-apple-system,sans-serif;direction:rtl}"
    + "." + P + "host{line-height:1.55}"
    + "@keyframes " + P + "ping{80%,100%{transform:scale(1.9);opacity:0}0%{transform:scale(1);opacity:.75}}"
    + "@keyframes " + P + "bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}"
    + "@keyframes " + P + "bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}"
    + "@keyframes " + P + "pop{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}"

    /* FAB */
    + "." + P + "fabwrap{position:fixed;bottom:20px;left:20px;z-index:" + Z + ";display:flex;align-items:center;gap:10px;flex-direction:row-reverse}"
    + "@media(max-width:820px){." + P + "fabwrap{bottom:calc(86px + env(safe-area-inset-bottom,0px));left:14px}}"
    + "." + P + "fab{position:relative;width:58px;height:58px;border:none;border-radius:50%;cursor:pointer;"
    + "background:linear-gradient(135deg,#38bdf8 0%,#0284c7 60%,#075985 100%);color:#fff;"
    + "box-shadow:0 10px 26px rgba(2,132,199,.45),inset 0 1px 0 rgba(255,255,255,.35);"
    + "display:flex;align-items:center;justify-content:center;transition:transform .2s,box-shadow .2s;-webkit-tap-highlight-color:transparent}"
    + "." + P + "fab:hover{transform:translateY(-3px) scale(1.03);box-shadow:0 14px 34px rgba(2,132,199,.55)}"
    + "." + P + "fab:active{transform:scale(.95)}"
    + "." + P + "fab svg{width:26px;height:26px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.2))}"
    + "." + P + "ring{position:absolute;inset:0;border-radius:50%;border:3px solid #38bdf8;animation:" + P + "ping 2.4s cubic-bezier(0,0,.2,1) infinite;pointer-events:none}"
    + "." + P + "ring.r2{animation-delay:1.2s}"
    + "." + P + "badge{position:absolute;top:-2px;left:-2px;min-width:16px;height:16px;border-radius:9px;background:#22c55e;border:2px solid #fff;display:none;align-items:center;justify-content:center}"
    + "." + P + "badge::after{content:'';width:6px;height:6px;border-radius:50%;background:#fff}"
    + "." + P + "label{background:#fff;color:#0c4a6e;font-size:13px;font-weight:800;padding:8px 14px;border-radius:14px;"
    + "box-shadow:0 6px 20px rgba(2,60,100,.18);border:1px solid #e0f2fe;white-space:nowrap;opacity:0;transform:translateX(6px);transition:.25s;pointer-events:none}"
    + "@media(min-width:821px){." + P + "fabwrap:hover ." + P + "label{opacity:1;transform:none}}"

    /* overlay */
    + "." + P + "ovl{position:fixed;inset:0;background:rgba(8,47,73,.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);z-index:" + (Z - 1) + ";opacity:0;pointer-events:none;transition:.25s}"
    + "." + P + "ovl.on{opacity:1;pointer-events:auto}"

    /* panel */
    + "." + P + "panel{position:fixed;z-index:" + Z + ";width:348px;max-width:calc(100vw - 24px);left:20px;bottom:92px;"
    + "background:#fff;border-radius:22px;overflow:hidden;color:#0f172a;"
    + "box-shadow:0 24px 70px rgba(2,60,100,.35),0 4px 16px rgba(0,0,0,.12);border:1px solid #e6f3fb;"
    + "opacity:0;pointer-events:none;transform:translateY(16px) scale(.98);transition:.28s cubic-bezier(.2,.9,.3,1.2)}"
    + "." + P + "panel.on{opacity:1;pointer-events:auto;transform:none;animation:" + P + "pop .28s}"
    + "@media(max-width:820px){"
    + "." + P + "panel{left:0;right:0;bottom:0;width:100%;max-width:100vw;border-radius:24px 24px 0 0;transform:translateY(100%);"
    + "max-height:calc(92dvh - 60px);overflow:auto;-webkit-overflow-scrolling:touch;transition:transform .32s cubic-bezier(.2,.9,.3,1)}"
    + "." + P + "panel.on{transform:none}}"
    + "." + P + "head{position:relative;background:linear-gradient(140deg,#0ea5e9 0%,#0369a1 55%,#0c4a6e 100%);color:#fff;padding:20px 18px 16px;overflow:hidden}"
    + "." + P + "head::before{content:'';position:absolute;width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.09);top:-70px;left:-40px}"
    + "." + P + "head::after{content:'';position:absolute;width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,.08);bottom:-40px;right:-20px}"
    + "." + P + "hicon{width:44px;height:44px;border-radius:14px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;margin-bottom:10px;position:relative}"
    + "." + P + "hicon svg{width:23px;height:23px}"
    + "." + P + "htitle{font-size:16.5px;font-weight:900;position:relative}"
    + "." + P + "hsub{font-size:11.5px;opacity:.85;margin-top:2px;position:relative;font-weight:500}"
    + "." + P + "x{position:absolute;top:12px;left:12px;width:32px;height:32px;border:none;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;transition:.2s}"
    + "." + P + "x:hover{background:rgba(255,255,255,.28)}"
    + "." + P + "body{padding:16px 18px 18px;background:#fff}"

    /* status chip */
    + "." + P + "chip{display:flex;align-items:center;justify-content:center;gap:7px;background:#f0f9ff;border:1px solid #e0f2fe;color:#0369a1;"
    + "font-size:12px;font-weight:700;border-radius:12px;padding:8px 10px;margin-bottom:14px}"
    + "." + P + "chip i{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;animation:" + P + "bob 1.6s infinite}"
    + "." + P + "chip.off{background:#fffbeb;border-color:#fde68a;color:#92400e}"
    + "." + P + "chip.off i{background:#f59e0b;box-shadow:none;animation:none}"

    /* form */
    + "." + P + "inp{width:100%;border:1.5px solid #e2e8f0;background:#f8fafc;border-radius:13px;padding:11px 13px;font-size:13.5px;transition:.2s;color:#0f172a}"
    + "." + P + "inp:focus{outline:none;border-color:#38bdf8;background:#fff;box-shadow:0 0 0 3px rgba(56,189,248,.18)}"
    + "." + P + "gap{height:9px}"
    + "." + P + "cta{width:100%;border:none;border-radius:15px;padding:14px;font-size:15.5px;font-weight:900;color:#fff;cursor:pointer;"
    + "background:linear-gradient(135deg,#22c55e,#15803d);display:flex;align-items:center;justify-content:center;gap:9px;"
    + "box-shadow:0 8px 20px rgba(21,128,61,.35);transition:.2s;margin-top:14px;-webkit-tap-highlight-color:transparent}"
    + "." + P + "cta:hover{filter:brightness(1.06);transform:translateY(-1px)}"
    + "." + P + "cta:disabled{background:#94a3b8;box-shadow:none;cursor:not-allowed;transform:none}"
    + "." + P + "cta svg{width:19px;height:19px}"
    + "." + P + "note{font-size:10.5px;color:#94a3b8;text-align:center;margin-top:10px;line-height:1.8}"

    /* stages */
    + "." + P + "stage{text-align:center;padding:6px 0 2px;display:none}"
    + "." + P + "stage.on{display:block;animation:" + P + "pop .3s}"
    + "." + P + "avatar{width:78px;height:78px;border-radius:50%;margin:6px auto 12px;position:relative;"
    + "background:linear-gradient(135deg,#38bdf8,#0369a1);display:flex;align-items:center;justify-content:center;animation:" + P + "bob 2.2s ease-in-out infinite}"
    + "." + P + "avatar svg{width:34px;height:34px}"
    + "." + P + "avatar ." + P + "ring{border-color:rgba(56,189,248,.6)}"
    + "." + P + "st1{font-size:15.5px;font-weight:900;color:#0f172a}"
    + "." + P + "st2{font-size:12px;color:#64748b;margin-top:4px;min-height:18px}"
    + "." + P + "bars{display:flex;gap:4px;align-items:center;justify-content:center;height:26px;margin:10px 0 2px}"
    + "." + P + "bars i{width:4.5px;height:100%;border-radius:3px;background:linear-gradient(#38bdf8,#0284c7);transform-origin:center;animation:" + P + "bar 1s ease-in-out infinite}"
    + "." + P + "bars i:nth-child(2){animation-delay:.12s}"
    + "." + P + "bars i:nth-child(3){animation-delay:.24s}"
    + "." + P + "bars i:nth-child(4){animation-delay:.36s}"
    + "." + P + "bars i:nth-child(5){animation-delay:.48s}"
    + "." + P + "timer{font-size:27px;font-weight:900;color:#0369a1;font-variant-numeric:tabular-nums;direction:ltr;letter-spacing:1px;margin-top:6px}"
    + "." + P + "rowbtns{display:flex;gap:9px;margin-top:14px}"
    + "." + P + "sbtn{flex:1;border:none;border-radius:13px;padding:12px;font-size:13.5px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;transition:.2s;-webkit-tap-highlight-color:transparent}"
    + "." + P + "sbtn svg{width:17px;height:17px}"
    + "." + P + "sbtn.gray{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}"
    + "." + P + "sbtn.gray:hover{background:#e2e8f0}"
    + "." + P + "sbtn.red{background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;box-shadow:0 6px 16px rgba(185,28,28,.3)}"

    /* stars */
    + "." + P + "stars{display:flex;justify-content:center;gap:8px;margin:12px 0 4px}"
    + "." + P + "stars button{width:42px;height:42px;border:1.5px solid #e2e8f0;background:#f8fafc;border-radius:13px;cursor:pointer;font-size:19px;color:#cbd5e1;transition:.15s;line-height:1}"
    + "." + P + "stars button.on{color:#f59e0b;border-color:#fcd34d;background:#fffbeb;transform:scale(1.08)}"

    /* error */
    + "." + P + "warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:14px;padding:12px 14px;font-size:12.5px;margin-bottom:12px;line-height:1.9;text-align:right}"
    + "." + P + "warn b{display:block;font-size:13px;margin-bottom:4px}"
    + "." + P + "warn ol{padding-right:18px;font-size:12px;line-height:2}"
    + "." + P + "telbox{display:none;align-items:center;gap:10px;background:#f0f9ff;border:1px dashed #7dd3fc;border-radius:14px;padding:11px 13px;margin-top:12px}"
    + "." + P + "telbox svg{width:18px;height:18px;fill:#0284c7;flex-shrink:0}"
    + "." + P + "telbox a{color:#0369a1;font-weight:900;font-size:14px;text-decoration:none;direction:ltr}"
    + "." + P + "telbox span{font-size:10.5px;color:#64748b;display:block}"
    + "." + P + "copy{margin-right:auto;border:none;background:#e0f2fe;color:#075985;font-size:11px;font-weight:800;border-radius:9px;padding:6px 10px;cursor:pointer}"

    /* toast */
    + "." + P + "toast{position:fixed;bottom:92px;left:50%;transform:translateX(-50%) translateY(8px);background:#0f172a;color:#fff;"
    + "padding:10px 18px;border-radius:13px;font-size:13px;font-weight:700;z-index:" + (Z + 1) + ";opacity:0;transition:.25s;pointer-events:none;"
    + "box-shadow:0 10px 30px rgba(0,0,0,.3);max-width:90vw;text-align:center}"
    + "." + P + "toast.on{opacity:1;transform:translateX(-50%) translateY(0)}";

  /* ---------------- DOM ---------------- */
  var host = el("div", P + "host");
  var style = el("style"); style.textContent = css; host.appendChild(style);

  var fabwrap = el("div", P + "fabwrap");
  fabwrap.innerHTML =
    '<button class="' + P + 'fab" id="' + P + 'fab" aria-label="تماس با ما">'
    + '<span class="' + P + 'ring"></span><span class="' + P + 'ring r2"></span>'
    + PHONE_SVG
    + '<span class="' + P + 'badge" id="' + P + 'badge"></span></button>'
    + '<span class="' + P + 'label">تماس با ما</span>';

  var ovl = el("div", P + "ovl");
  var panel = el("div", P + "panel");
  panel.setAttribute("role", "dialog");
  panel.innerHTML =
    '<div class="' + P + 'head">'
    + '<button class="' + P + 'x" id="' + P + 'x" aria-label="بستن">✕</button>'
    + '<div class="' + P + 'hicon">' + PHONE_SVG + '</div>'
    + '<div class="' + P + 'htitle">تماس تلفنی با فیرزو</div>'
    + '<div class="' + P + 'hsub">رایگان • بدون شماره‌گیری • پاسخگویی ۲۴ ساعته</div>'
    + '</div>'
    + '<div class="' + P + 'body">'
    + '<div class="' + P + 'chip" id="' + P + 'chip"><i></i><span id="' + P + 'chiptext">در حال دریافت وضعیت پشتیبانی…</span></div>'

    /* idle form */
    + '<div class="' + P + 'stage on" id="' + P + 'idle">'
    + '<input class="' + P + 'inp" id="' + P + 'n" placeholder="نام شما (اختیاری)" value="' + String(lsGet("fzw_name")).replace(/"/g, "&quot;") + '">'
    + '<div class="' + P + 'gap"></div>'
    + '<input class="' + P + 'inp" id="' + P + 't" placeholder="شماره تماس شما (اختیاری)" inputmode="tel" value="' + String(lsGet("fzw_phone")).replace(/"/g, "&quot;") + '">'
    + '<button class="' + P + 'cta" id="' + P + 'c">' + PHONE_SVG + '<span>شروع تماس رایگان</span></button>'
    + '<div class="' + P + 'note">تماس از طریق اینترنت (WebRTC) برقرار می‌شود<br>تماس شما برای کنترل کیفیت ضبط می‌شود</div>'
    + '</div>'

    /* calling */
    + '<div class="' + P + 'stage" id="' + P + 'calling">'
    + '<div class="' + P + 'avatar"><span class="' + P + 'ring"></span>' + PHONE_SVG + '</div>'
    + '<div class="' + P + 'st1" id="' + P + 'call1">در حال برقراری تماس…</div>'
    + '<div class="' + P + 'st2" id="' + P + 'call2">لحظه‌ای صبر کنید</div>'
    + '<div class="' + P + 'bars"><i></i><i></i><i></i><i></i><i></i></div>'
    + '<div class="' + P + 'rowbtns"><button class="' + P + 'sbtn red" id="' + P + 'cancel">' + END_SVG + '<span>لغو تماس</span></button></div>'
    + '</div>'

    /* active */
    + '<div class="' + P + 'stage" id="' + P + 'active">'
    + '<div class="' + P + 'avatar" style="animation:none"><span class="' + P + 'ring"></span>' + MIC_SVG + '</div>'
    + '<div class="' + P + 'st1">تماس برقرار است ✓</div>'
    + '<div class="' + P + 'st2">با پشتیبانی فیرزو صحبت می‌کنید</div>'
    + '<div class="' + P + 'timer" id="' + P + 'tmr">0:00</div>'
    + '<div class="' + P + 'rowbtns">'
    + '<button class="' + P + 'sbtn gray" id="' + P + 'mute">' + MIC_SVG + '<span>میکروفون</span></button>'
    + '<button class="' + P + 'sbtn red" id="' + P + 'end">' + END_SVG + '<span>پایان تماس</span></button>'
    + '</div>'
    + '</div>'

    /* ended / rating */
    + '<div class="' + P + 'stage" id="' + P + 'ended">'
    + '<div class="' + P + 'st1" id="' + P + 'endtitle">تماس پایان یافت</div>'
    + '<div class="' + P + 'st2">کیفیت پاسخگویی را ارزیابی کنید</div>'
    + '<div class="' + P + 'stars" id="' + P + 'stars">'
    + [1, 2, 3, 4, 5].map(function (i) { return '<button data-i="' + i + '" aria-label="' + i + ' ستاره">★</button>'; }).join("")
    + '</div>'
    + '<div class="' + P + 'rowbtns"><button class="' + P + 'sbtn gray" id="' + P + 'again">' + PHONE_SVG + '<span>تماس مجدد</span></button></div>'
    + '</div>'

    /* error */
    + '<div class="' + P + 'stage" id="' + P + 'err">'
    + '<div class="' + P + 'warn" id="' + P + 'warnbox"></div>'
    + '<div class="' + P + 'rowbtns">'
    + '<button class="' + P + 'sbtn gray" id="' + P + 'retry" style="display:none">تلاش مجدد</button>'
    + '<button class="' + P + 'sbtn gray" id="' + P + 'back">بازگشت</button>'
    + '</div>'
    + '</div>'

    /* tel fallback */
    + '<div class="' + P + 'telbox" id="' + P + 'telbox">'
    + '<svg viewBox="0 0 24 24"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z"/></svg>'
    + '<div><a href="tel:' + DEFAULT_PHONE + '" id="' + P + 'teln">۰۲۱-۹۱۰۰۰۰۰۰</a><span>تماس معمولی تلفنی</span></div>'
    + '<button class="' + P + 'copy" id="' + P + 'copy">کپی</button>'
    + '</div>'
    + '</div>';

  var toast = el("div", P + "toast");
  var remoteAudio = el("audio");
  remoteAudio.autoplay = true;
  remoteAudio.setAttribute("playsinline", "");
  remoteAudio.style.display = "none";

  function mount() {
    host.appendChild(fabwrap); host.appendChild(ovl); host.appendChild(panel);
    host.appendChild(toast); host.appendChild(remoteAudio);
    (document.body || document.documentElement).appendChild(host);
  }

  /* ---------------- state machine ---------------- */
  var st = "idle";            // idle | calling | active | ended | err
  var ua = null, reg = null, inviter = null;
  var muted = false, tmrI = null, pollI = null;
  var sipLoading = false, configLoading = null, opened = false;

  function q(id) { return host.querySelector("#" + P + id); }
  function showStage(name) {
    ["idle", "calling", "active", "ended", "err"].forEach(function (s) {
      q(s).classList.toggle("on", s === name);
    });
    q("telbox").style.display = (name === "err") ? "flex" : "none";
  }
  function showToast(msg, ms) {
    toast.textContent = msg; toast.classList.add("on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toast.classList.remove("on"); }, ms || 3200);
  }

  /* ---------------- config / queue ---------------- */
  function loadConfig(cb) {
    if (cfg) return cb(cfg);
    if (!configLoading) {
      configLoading = fetch(API + "/api/widget/config")
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (c) { cfg = c; if (c.support_phone) supportPhone = c.support_phone; return cfg; })
        .catch(function () { configLoading = null; return null; });
    }
    configLoading.then(cb);
  }
  function refreshQueue() {
    fetch(API + "/api/queue/status").then(function (r) { return r.json(); }).then(function (d) {
      var chip = q("chip"), txt = q("chiptext");
      if (d.online > 0) {
        chip.classList.remove("off");
        txt.textContent = "پشتیبانی آنلاین است" + (d.waiting > 0 ? " — " + d.waiting + " نفر در صف انتظار" : " ✓");
      } else {
        chip.classList.add("off");
        txt.textContent = "اپراتورها در دسترس نیستند — تماس به صف می‌رود";
      }
      q("badge").style.display = d.online > 0 ? "flex" : "none";
    }).catch(function () { q("chiptext").textContent = "وضعیت پشتیبانی دریافت نشد"; });
  }

  /* ---------------- open / close ---------------- */
  function open() {
    if (opened) return;
    opened = true;
    panel.classList.add("on");
    if (isMobile()) ovl.classList.add("on");
    loadConfig(function (c) {
      refreshQueue();
      if (c) {
        q("teln").setAttribute("href", "tel:" + c.support_phone);
        q("teln").textContent = c.support_phone_display || c.support_phone;
      }
      if (!hasWebRTC()) showUnsupported();
    });
    clearInterval(pollI);
    pollI = setInterval(refreshQueue, 30000);
  }
  function close() {
    opened = false;
    panel.classList.remove("on"); ovl.classList.remove("on");
    clearInterval(pollI);
    if (st === "calling") hangup(true);
  }
  function showUnsupported() {
    st = "err";
    q("warnbox").innerHTML = "<b>مرورگر شما از تماس اینترنتی پشتیبانی نمی‌کند</b>"
      + "برای تماس رایگان با پشتیبانی از مرورگر به‌روز (Chrome، Safari یا Firefox) استفاده کنید "
      + "یا مستقیماً با شماره زیر تماس بگیرید:";
    q("retry").style.display = "none";
    showStage("err");
  }

  /* ---------------- SIP engine ---------------- */
  function ensureSip(cb) {
    if (window.SIP) return cb();
    if (sipLoading) return;
    sipLoading = true;
    var s = document.createElement("script");
    s.src = API + "/sip.js";
    s.onload = function () { sipLoading = false; cb(); };
    s.onerror = function () { sipLoading = false; showError("engine", "موتور تماس بارگذاری نشد."); };
    document.head.appendChild(s);
  }

  function initUA() {
    if (ua || !cfg || !window.SIP) return;
    var SIP = window.SIP;
    ua = new SIP.UserAgent({
      uri: SIP.UserAgent.makeURI("sip:visitor@" + cfg.sip_server_domain),
      transportOptions: { server: cfg.ws_url },
      authorizationUsername: cfg.auth.username,
      authorizationPassword: cfg.auth.password,
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: {
          iceServers: cfg.ice_servers || [],
          iceTransportPolicy: "all"
        }
      },
      displayName: "v:" + vid + "|" + lsGet("fzw_name") + "|" + lsGet("fzw_phone"),
      delegate: { onInvite: function () {} }
    });
    reg = new SIP.Registerer(ua, { regId: 0 });
    /* IMPORTANT: register only after transport is connected (sip.js will not
       flush a REGISTER queued before ua.start() resolves) */
    ua.start().then(function () { doRegister(); }).catch(function () {});
    ua.transport.stateChange.addListener(function (st) {
      if (st === SIP.TransportState.Connected) { try { doRegister(); } catch (e) {} }
      if (st === SIP.TransportState.Disconnected) {
        setTimeout(function () { try { ua.transport.connect(); } catch (e) {} }, 2500);
      }
    });
  }
  function doRegister() {
    if (doRegister._busy) return;
    doRegister._busy = true;
    try {
      reg.register({
        onRequest: function (req) { try { req.message.params["X-Visitor-Id"] = vid; } catch (e) {} }
      }).catch(function () {}).then(function () { doRegister._busy = false; });
    } catch (e) { doRegister._busy = false; }
  }

  /* ---------------- mic permission ---------------- */
  function requestMic() {
    return new Promise(function (resolve, reject) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
        return reject({ type: "unsupported" });
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        .then(function (stream) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          resolve(true);
        })
        .catch(function (e) {
          var name = e && e.name;
          var type = (name === "NotAllowedError" || name === "PermissionDeniedError") ? "denied"
            : (name === "NotFoundError" || name === "OverconstrainedError") ? "nodevice" : "error";
          reject({ type: type, raw: e });
        });
    });
  }

  var PERM_HELP = {
    chrome: "روی آیکون 🔒 یا 🎤 در نوار آدرس کلیک کنید، «مجوز میکروفون» را روی «اجازه دادن» بگذارید و صفحه را دوباره باز کنید.",
    edge: "روی آیکون قفل در نوار آدرس کلیک کنید ← «مجوزهای این سایت» ← میکروفون ← «اجازه دادن» ← رفرش.",
    firefox: "روی آیکون 🔒 در نوار آدرس کلیک کنید ← فلش کنار «میکروفون» ← «حذف مجوز» سپس رفرش و اجازه دادن.",
    safari: "منوی Safari ← «تنظیمات برای این وب‌سایت…» ← میکروفون ← «اجازه دادن».",
    ios: "تنظیمات ← Safari (یا مرورگر شما) ← میکروفون ← «اجازه دادن»؛ سپس صفحه را کامل ببندید و دوباره باز کنید.",
    android: "لمس روی آیکون 🔒 در نوار آدرس ← «مجوزها» ← میکروفون ← «اجازه دادن»، سپس رفرش.",
    samsung: "تنظیمات مرورگر ← «مجوزهای سایت» ← میکروفون ← «اجازه دادن»، سپس رفرش.",
    other: "مجوز میکروفون را در تنظیمات مرورگر برای این سایت روی «اجازه دادن» بگذارید و صفحه را رفرش کنید."
  };
  function showError(kind, extra) {
    st = "err";
    var help = PERM_HELP[browserName()] || PERM_HELP.other;
    var title, body;
    if (kind === "denied") {
      title = "دسترسی به میکروفون داده نشد";
      body = "<ol><li>" + help + "</li></ol><div style='margin-top:6px'>یا همین حالا با شماره زیر تماس بگیرید:</div>";
    } else if (kind === "nodevice") {
      title = "میکروفونی پیدا نشد";
      body = "به دستگاه میکروفون متصل نیست. با هندزفری امتحان کنید یا با شماره زیر تماس بگیرید:";
    } else if (kind === "engine") {
      title = "خطا در راه‌اندازی تماس";
      body = (extra || "") + "اتصال اینترنت را بررسی کنید یا با شماره زیر تماس بگیرید:";
    } else {
      title = "تماس برقرار نشد";
      body = "مشکل در اتصال رخ داد. چند لحظه بعد تلاش کنید یا با شماره زیر تماس بگیرید:";
    }
    q("warnbox").innerHTML = "<b>" + title + "</b>" + body;
    q("retry").style.display = (kind === "denied" || kind === "nodevice") ? "none" : "flex";
    showStage("err");
  }

  /* ---------------- call flow ---------------- */
  function startCall() {
    if (st === "calling" || st === "active") return;
    if (!hasWebRTC()) { showUnsupported(); return; }
    lsSet("fzw_name", q("n").value.trim());
    lsSet("fzw_phone", q("t").value.trim());

    st = "calling";
    q("call1").textContent = "در حال بررسی میکروفون…";
    q("call2").textContent = "اگر مرورگر اجازه خواست، «اجازه دادن» را بزنید";
    showStage("calling");

    requestMic().then(function () {
      q("call1").textContent = "در حال برقراری تماس…";
      q("call2").textContent = "در حال اتصال به پشتیبانی فیرزو";
      announce();
      loadConfig(function (c) {
        if (!c) return showError("error");
        ensureSip(function () {
          initUA();
          setTimeout(doInvite, 350);
        });
      });
    }).catch(function (e) {
      if (e.type === "unsupported") showUnsupported();
      else showError(e.type || "error");
    });
  }

  function announce() {
    try {
      fetch(API + "/api/visitor/announce", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visitorId: vid, name: lsGet("fzw_name"), phone: lsGet("fzw_phone"),
          page: location.href.slice(0, 400)
        })
      }).catch(function () {});
    } catch (e) {}
  }

  function doInvite() {
    var SIP = window.SIP;
    function go() {
      var target = SIP.UserAgent.makeURI("sip:" + (cfg.dial_ext || "200") + "@" + cfg.sip_server_domain);
      var inv = new SIP.Inviter(ua, target, {
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } }
      });
      inviter = inv;
      inv.stateChange.addListener(function (s) {
        if (s === SIP.SessionState.Established) onEstablished(inv);
        if (s === SIP.SessionState.Terminated) onTerminated();
      });
      inv.invite().catch(function () { if (st === "calling") showError("error"); });
      playRing(true);
      inv._wd = setTimeout(function () {
        if (st === "calling") {
          try { inv.cancel(); } catch (e) {}
          showError("error");
        }
      }, 30000);
    }
    /* wait until the WebSocket transport is actually connected */
    if (ua.transport && ua.transport.state === SIP.TransportState.Connected) { go(); return; }
    var waited = 0;
    var iv = setInterval(function () {
      waited += 250;
      if (ua.transport && ua.transport.state === SIP.TransportState.Connected) { clearInterval(iv); go(); }
      else if (waited > 9000) { clearInterval(iv); if (st === "calling") showError("error"); }
    }, 250);
  }

  function attachRemote(inv) {
    try {
      var pc = inv.sessionDescriptionHandler.peerConnection;
      var stream = new MediaStream();
      pc.getReceivers().forEach(function (r) { if (r.track) stream.addTrack(r.track); });
      remoteAudio.srcObject = stream;
      var p = remoteAudio.play();
      if (p && p.catch) p.catch(function () {});
      pc.ontrack = function (ev) {
        if (ev.streams && ev.streams[0]) remoteAudio.srcObject = ev.streams[0];
        remoteAudio.play().catch(function () {});
      };
    } catch (e) {}
  }

  function onEstablished(inv) {
    if (inviter) clearTimeout(inviter._wd);
    st = "active";
    playRing(false);
    attachRemote(inv);
    showStage("active");
    setMuteUI(false);
    var t = 0;
    q("tmr").textContent = "0:00";
    clearInterval(tmrI);
    tmrI = setInterval(function () {
      t++; q("tmr").textContent = Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
    }, 1000);
  }

  function onTerminated() {
    if (inviter) clearTimeout(inviter._wd);
    playRing(false);
    clearInterval(tmrI);
    remoteAudio.srcObject = null;
    if (st === "active" || st === "calling") showEnded();
    inviter = null;
  }

  function showEnded() {
    st = "ended";
    q("endtitle").textContent = "تماس پایان یافت";
    panel.querySelectorAll("." + P + "stars button").forEach(function (x) { x.classList.remove("on"); });
    showStage("ended");
  }

  function hangup(silent) {
    clearInterval(tmrI);
    try {
      if (!inviter) return finishIdle();
      var S = window.SIP.SessionState;
      if (inviter.state === S.Initial || inviter.state === S.Establishing) inviter.cancel().catch(function () {});
      else if (inviter.state === S.Established) inviter.bye().catch(function () {});
    } catch (e) {}
    if (silent) finishIdle();
  }
  function finishIdle() {
    st = "idle"; playRing(false); clearInterval(tmrI);
    remoteAudio.srcObject = null;
    showStage("idle");
  }

  /* ---------------- ring tone ---------------- */
  var actx = null, toneTimer = null;
  function playRing(on) {
    try {
      if (!on) {
        clearInterval(toneTimer); toneTimer = null;
        if (actx) { try { actx.close(); } catch (e) {} actx = null; }
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      if (actx.state === "suspended") actx.resume().catch(function () {});
      toneTimer = setInterval(function () {
        if (!actx) return;
        var o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = 440; g.gain.value = 0.025;
        o.connect(g); g.connect(actx.destination);
        o.start(); o.stop(actx.currentTime + 0.35);
      }, 1100);
    } catch (e) {}
  }

  function setMuteUI(isMuted) {
    q("mute").innerHTML = (isMuted ? MUTE_SVG : MIC_SVG) + "<span>" + (isMuted ? "بی‌صدا" : "میکروفون") + "</span>";
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    q("fab").addEventListener("click", function () { opened ? close() : open(); });
    q("x").addEventListener("click", close);
    ovl.addEventListener("click", close);
    q("c").addEventListener("click", startCall);
    q("retry").addEventListener("click", function () { st = "idle"; showStage("idle"); });
    q("back").addEventListener("click", function () { st = "idle"; showStage("idle"); });
    q("again").addEventListener("click", function () { st = "idle"; showStage("idle"); });
    q("cancel").addEventListener("click", function () { hangup(); });
    q("end").addEventListener("click", function () { hangup(); });
    q("mute").addEventListener("click", function () {
      try {
        var pc = inviter && inviter.sessionDescriptionHandler && inviter.sessionDescriptionHandler.peerConnection;
        if (!pc) return;
        muted = !muted;
        pc.getSenders().forEach(function (s) { if (s.track && s.track.kind === "audio") s.track.enabled = !muted; });
        setMuteUI(muted);
      } catch (e) {}
    });
    q("copy").addEventListener("click", function () {
      try { navigator.clipboard.writeText(supportPhone); showToast("شماره کپی شد ✓"); } catch (e) {}
    });
    q("stars").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      var r = parseInt(b.getAttribute("data-i"), 10);
      panel.querySelectorAll("." + P + "stars button").forEach(function (x, i) { x.classList.toggle("on", i < r); });
      try {
        fetch(API + "/api/widget/survey", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visitorId: vid, rating: r })
        }).catch(function () {});
      } catch (e2) {}
      q("endtitle").textContent = "سپاسگزاریم! 💙";
      setTimeout(function () { close(); finishIdle(); }, 900);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && opened) close(); });
    window.addEventListener("resize", function () { if (opened) ovl.classList.toggle("on", isMobile()); });

    /* ---- hook EXISTING contact buttons (delegation = SPA-safe) ---- */
    document.addEventListener("click", function (e) {
      var t = e.target.closest('[data-fz-call], .fz-call-trigger, a[href^="tel:"]');
      if (!t) return;
      var ours = t.hasAttribute("data-fz-call") || t.classList.contains("fz-call-trigger");
      var href = (t.getAttribute("href") || "").toLowerCase().replace(/[\s()\-]/g, "");
      var isTel = href.indexOf("tel:") === 0;
      var norm = supportPhone.toLowerCase().replace(/[\s()\-]/g, "");
      var isSupport = isTel && norm && href.indexOf("tel:" + norm) === 0;
      if (!ours && !isSupport) return; /* other tel: numbers keep native dialer */
      e.preventDefault();
      open();
    }, false);
  }

  /* ---------------- public API ---------------- */
  window.FiruzoCall = {
    open: open,
    close: close,
    startCall: function () { open(); setTimeout(function () { startCall(); }, 350); },
    version: "2.0.0"
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { mount(); bind(); });
  else { mount(); bind(); }
})();
