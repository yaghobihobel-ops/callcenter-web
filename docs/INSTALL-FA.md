# 🛠 راهنمای نصب — از صفر تا پروداکشن

> این بسته عمداً **چند-محیطی** است: می‌توانید همه اجزا را روی یک سرور بالا
> بیاورید یا PBX را روی یک ماشین داخلی و اپ/پنل را روی ماشین دیگر. هر دو سناریو
> با همان `installer/install.sh` انجام می‌شود.

---

## ۰. پیش‌نیازها

| نیاز | مقدار |
|---|---|
| سرور اپ (API+پنل+coturn+nginx) | Ubuntu 20.04+/Debian 11+ ، 2GB RAM ، Node 18+ |
| سرور PBX (اختیاری جدا) | Debian/Ubuntu ، Asterisk 18+ ، 1GB RAM |
| دیتابیس | MariaDB/MySQL روی سرور اپ (نصب‌کننده خودش می‌سازد) |
| DNS | رکورد `call.<domain>` → IP عمومی (کلادفلر: proxied) |
| پورت‌های خالی روی سرور اپ | 3006 (داخلی) ، 443/80 ، 3478 ، UDP 49160-49200 |
| پورت‌ها روی PBX | 8088 (WS) ، 5038 (AMI، فقط LAN) |

> توزیع‌های RHEL/Alma برای PBX به نصب دستی Asterisk نیاز دارند (نصب‌کننده پیام
> راهنما می‌دهد)؛ برای اپ کامل پشتیبانی می‌شوند.

## ۱. دریافت بسته

```bash
git clone https://github.com/<you>/callcenter-web.git
cd callcenter-web
```

## ۲. پیش‌بررسی (بدون هیچ تغییری)

```bash
cp installer/config.example.conf my.conf
vi my.conf     # حداقل: CC_DOMAIN ، APP_HOST ، PBX_HOST ، PUBLIC_IP
sudo installer/check.sh --config my.conf --preflight
```

خروجی، وضعیت OS/رمز/دیسک/نرم‌افزارهای موجود/پورت‌های خالی/IP عمومی را با
PASS/WARN/FAIL نشان می‌دهد. WARN ها فقط اطلاع‌اند.

## ۳. کانفیگ

`installer/config.example.conf` را کامل کنید:

- `CC_DOMAIN` — دامنه عمومی پنل/ویجت (مثلاً `call.firuzo.online`)
- `APP_HOST` / `PBX_HOST` — IPهای داخلی دو ماشین (می‌توانند یکی باشند)
- `PUBLIC_IP` — IP عمومی که بازدیدکننده می‌بیند (برای TURN)
- رمزها — هر مقداری که خالی بگذارید **خودکار تولید** و در
  `/opt/callcenter/.generated-creds` (chmod 600) ذخیره می‌شود.

## ۴. نصب

### سناریو A — همه‌چیز روی یک سرور

```bash
sudo installer/install.sh --config my.conf
# نقش‌ها از IPهای خود سرور تشخیص داده می‌شوند
```

### سناریو B — PBX جدا (مثل دیپلوی مرجع: اپ روی .65 ، PBX روی .85)

```bash
# روی PBX:
sudo installer/install.sh --config my.conf --only pbx
# کلید SFTP ضبط‌ها را به سرور اپ ببرید:
scp /opt/callcenter/secrets/cc_rsa* root@<APP_HOST>:/opt/callcenter/secrets/

# روی سرور اپ:
sudo installer/install.sh --config my.conf --only turn,app,nginx
```

جزئیات هر نقش:

| نقش | کارهایی که می‌کند |
|---|---|
| `pbx` | نصب Asterisk (apt) ، رندر `pjsip/extensions/manager` از قالب‌ها، کپی بقیه confها، نصب صداهای فارسی، ساخت کلید SSH ضبط‌ها، enable سرویس |
| `turn` | نصب coturn و رندر `turnserver.conf` با `external-ip` درست |
| `app` | Node 20 (در صورت نبود) ، MariaDB + ساخت DB/کاربر، کپی بک‌اند به `/opt/callcenter/app`، `npm install`، ساخت `.env`، برندسازی دامنه در widget.js، واحد systemd |
| `nginx` | گواهی self-signed (یا از پیش موجود)، رندر vhost (پروکسی پنل + WSS)، `nginx -t` و reload |

نصب‌کننده **idempotent** است: هر بار اجرا قبل از بازنویسی، از فایل موجود بکاپ
`.bak-<زمان>` می‌گیرد؛ اجرای مجدد بدون خطر است.

## ۵. راستی‌آزمایی دقیق

```bash
sudo installer/check.sh --config my.conf --full --pbx --app --nginx --turn
```

این دستور سرویس‌ها، پورت‌ها، CORS، هندشیک WSS (101)، AMI، اسکیمای DB، صداهای
فارسی، پنل‌ها، widget.js و URL عمومی را چک می‌کند. همه باید PASS شوند.

## ۶. DNS و TLS

- **کلادفلر (پیشنهادی)**: رکورد A با نام `call` → `PUBLIC_IP` و پروکسی روشن؛
  SSL/TLS = **Full**؛ Network → WebSockets = ON. گواهی self-signed سرور کافی است.
- بدون کلادفلر: گواهی معتبر بگیرید (LetsEncrypt) و `TLS_MODE=existing` +
  مسیر فایل‌ها را در `my.conf` بدهید.

### کش لبه ویجت (اختیاری ولی توصیه‌شده)

کد Worker در `worker/fz-call-widget-edge.js` آماده است. در کلادفلر:
Workers → Create → کد را paste کنید → Route: `call.<domain>/widget.js`.
هر نسخه جدید با کلید کش `VER` در همان فایل، لبه را بلافاصله رفرش می‌کند.

## ۷. اولین ورود

- پنل ادمین: `https://call.<domain>/admin` با `ADMIN_USER/ADMIN_PASS` از کانفیگ
  (پیش‌فرض مرجع: `admin / Firuzo@Admin2026` — بعد از اولین ورود عوضش کنید).
- پنل اپراتور: `https://call.<domain>/operator`
- کاربران پیش‌فرض فقط در اولین بوت ساخته می‌شوند (اگر جدول users خالی باشد).

## ۸. نصب ویجت در سایت

```html
<script src="https://call.<domain>/widget.js" defer></script>
```

+ نکات اتصال به دکمه‌های موجود: [INTEGRATION-FA.md](INTEGRATION-FA.md)

## ۹. بروزرسانی نسخه

```bash
cd callcenter-web && git pull
sudo installer/install.sh --config my.conf --only app   # بک‌اند/پنل/ویجت
sudo installer/install.sh --config my.conf --only pbx   # اگر کانفیگ PBX تغییر کرده
sudo installer/check.sh --config my.conf --full --pbx --app --nginx --turn
```

(اگر Worker کش لبه دارید، مقدار `VER` را در کد Worker بخرچنگانید و deploy کنید.)

## ۱۰. خطاهای رایج نصب

| خطا | علت/راه‌حل |
|---|---|
| `npm install failed` | Node < 18؛ Node 20 نصب کنید و `--only app` را تکرار کنید |
| `callcenter-app failed` | لاگ: `/opt/callcenter/app.err.log` — معمولاً DB/رمز |
| `nginx -t fails` | گواهی موجود نیست؛ `TLS_MODE` را با مسیر درست تنظیم کنید |
| PBX روی Alma/RHEL | Asterisk دستی نصب کنید، بعد `--only pbx --skip-deps` |
| پورت 8088/5038 اشغال | مقدار `PBX_WS_PORT/AMI_PORT` را در کانفیگ عوض کنید |
