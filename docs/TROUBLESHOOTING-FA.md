# 🚑 عیب‌یابی (TROUBLESHOOTING)

> قدم اول همیشه: `sudo installer/check.sh --config my.conf --full --pbx --app --nginx --turn`
> و صفحه Actions ریپو (workflow ۰۷ وضعیت سرویس زنده را نشان می‌دهد).

---

## ۱. «دکمه تماس در سایت کار نمی‌کند»

علت‌های تاریخی این باگ و چک‌به‌ترتیب:

1. **CORS**: کنسول مرورگر؛ اگر خطای CORS روی `/api/widget/config` بود:
   هدر `Access-Control-Allow-Origin` باید در پاسخ باشد (بک‌اند این هدر را
   reflect می‌کند). چک: `curl -s -D - -o /dev/null -H "Origin: https://SITE" https://call.<domain>/api/widget/config`
2. **لود نشدن ویجت**: `curl -sI https://call.<domain>/widget.js` → 200. اگر
   Worker کش لبه دارید و نسخه قدیمی چسبیده، `VER` در کد Worker را بخرچنگانید.
3. **هوک‌های دکمه**: دکمه باید یکی از `tel:` / `[data-fz-call]` / `.fz-call-trigger` باشد.
4. **HTTPS**: بدون قفل، پرمیشن میکروفون و WSS هر دو بسته‌اند.

## ۲. «register/اتصال اپراتور برقرار نمی‌شود»

- هندشیک WSS باید 101 بدهد:
  `curl -sk -o /dev/null -w '%{http_code}' --http1.1 -H "Upgrade: websocket" -H "Connection: Upgrade" -H "Sec-WebSocket-Key: c2VsZW5pdW1jb2xsZWN0aXZl" -H "Sec-WebSocket-Version: 13" https://call.<domain>/ws`
- nginx باید `/ws` را به `:8088` PBX بفرستد (`proxy_set_header Upgrade`).
- رمز داخلی: الگوی `CC_OP_SIP_PASS` در `.env` بک‌اند باید با `pjsip.conf` یکی باشد.
- `asterisk -rx "pjsip show registrations"` و `pjsip show endpoints`.
- داخلی تکراری: دو کاربر با یک داخلی → تداخل REGISTER.

## ۳. «صدای طرف مقابل / IVR نمی‌آید» (one-way audio)

- NAT: TURN باید فعال باشد (`:3478`) و در `api/widget/config` آدرس عمومی TURN
  دیده شود. UDP ورودی در شبکه شما بسته است؟ `turn tcp` هم باید باشد (هست).
- کُدک: فقط `allow=ulaw` (opus بدون ماژول → IVR نامشنود).
- `external-ip` در `/etc/turnserver.conf` باید `PUBLIC_IP/LAN_IP` باشد.

## ۴. «ضبط خالی یا خیلی کوچک (۴۴ بایت)»

- یعنی MixMonitor از قبل از Answer ضبط کرده یا کدک جواب نمی‌دهد — قالب فعلی
  درست است (Answer قبل از MixMonitor)؛ اگر دستی تغییرش دادید برگردانید.
- انتقال SFTP: کلید `/opt/callcenter/secrets/cc_rsa` باید در
  `authorized_keys` ریشه PBX باشد و `CC_SFTP_KEY` در `.env` درست باشد.
- شش ثانیه بعد از قطع، ضبط باید در `/opt/callcenter/recordings` ظاهر شود.

## ۵. «پنل/ویجت صدا ندارد در iOS/سافاری»

- سافاری iOS: پخش صدا باید در همان ژست کاربر شروع شود — ویجت این‌طور طراحی شده؛
  پس از قطع/وصل سریع اینترنت، دوباره تماس بگیرید.
- iOS < 14.3 / WebViewها → ویجت به کارت `tel:` برمی‌گردد (طبیعی است).

## ۶. «AMI connected نمی‌شود»

- `:5038` فقط از LAN؛ `permit` در `manager.conf` باید IP سرور اپ باشد.
- چک: `telnet <PBX> 5038` از سرور اپ + `asterisk -rx "manager show users"`.

## ۷. «صف کار نمی‌کند / اپراتور در صف نیست»

- عضویت صف با دکمه آماده/استراحت کنترل می‌شود؛ `asterisk -rx "queue show support"`.
- پس از ری‌استارت بک‌اند، اعضا از رخداد `QueueMember` (فیلد `StateInterface`)
  بازسازی می‌شوند — چند ثانیه صبر کنید.
- `persistentmembers=yes` در `queues.conf` حفظ می‌کند اعضا را بین ری‌استارت‌ها.

## ۸. «امتیازدهی/نظرسنجی ثبت نمی‌شود»

- مسیر IVR: بعد از قطع صف، `Read(RATING,...)` امتیاز می‌گیرد؛ رخداد
  `CallSurvey` → بک‌اند → `surveys` جدول.
- چک: `SELECT * FROM surveys ORDER BY id DESC LIMIT 5;`

## ۹. مانیتورینگ دائمی

- Workflow `07-monitor` هر ۳۰ دقیقه سرویس زنده را چک می‌کند و در خرابی
  **issue حادثه** باز می‌کند و در رفع، می‌بندد. متغیر ریپو: `CC_MONITOR_URL`.
- `/health` برای لود‌بالنسر/مانیتور خارجی هم آماده است.

## ۱۰. جمع‌آوری لاگ برای پشتیبانی

```bash
sudo journalctl -u callcenter-app -n 200 --no-pager
sudo tail -n 100 /opt/callcenter/app.err.log
asterisk -rx "pjsip show endpoints" > /tmp/pjsip.txt
asterisk -rx "queue show support"   >> /tmp/pjsip.txt
sudo installer/check.sh --config my.conf --full --pbx --app --nginx --turn
```
