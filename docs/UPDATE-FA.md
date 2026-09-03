# بسته نصبی قابل‌آپدیت + انتشار (Update & Release Guide — FA)

این سند دقیقاً توضیح می‌دهد چطور یک نسخهٔ جدید «بیرون» منتشر شود و نصب‌های
موجود بدون دست‌زدن به داده‌ها (DB، `.env`، رمزها، رکوردها) آپدیت شوند.

---

## ۱. بسته‌های انتشار — چه چیزی بیرون می‌رود

هر انتشار از **دو بسته** تشکیل می‌شود که هر دو به‌صورت Release asset روی GitHub
می‌نشینند:

| بسته | محتوا | مصرف‌کننده |
|---|---|---|
| `callcenter-web-<ver>.tar.gz` (+`.sha256`) | کل سورس + پنل‌ها + installer + updater + docs | `update.sh` و نصب تازه |
| `asterisk-configured-bundle-*.tar.gz` | کانفیگ‌های **واقعاً نصب‌شدهٔ** استریسکِ مرجع (۱۹۲.۱۶۸.۱۰۰.۸۵) + صداهای فارسی IVR + `install-bundle.sh` + `manifest.json` (sha256 تک‌تک فایل‌ها) | `install.sh --asterisk-bundle` |

> ⚠️ بستهٔ استریسک شامل رمزهای واقعی SIP/AMI است — فقط در ریپوی خصوصی نگه دارید.

---

## ۲. ساخت و انتشار یک نسخهٔ جدید (روی ماشین توسعه)

```bash
# ۱) نسخه را در دو جا هم‌تراز کن:
echo "3.1.0" > VERSION
#    و backend/package.json → "version": "3.1.0"

# ۲) یادداشت تغییرات را بالای CHANGELOG.md اضافه کن (بخش ## [3.1.0])

# ۳) بسته بساز + ریلیز GitHub منتشر کن:
bash scripts/release.sh --upload <GITHUB_TOKEN> v3.1.0
```

اسکریپت خودش: نسخه‌ها را چک می‌کند، tarball می‌سازد، sha256 می‌نویسد، ساختار
را تست می‌کند، ریلیز می‌سازد (یا اگر وجود داشت همان را پیدا می‌کند) و assetها
را بالا می‌برد.

---

## ۳. آپدیت نصبِ موجود — روی سرورِ نصب‌شده

### حالت الف — از فایل (آفلاین / انتقال دستی)
```bash
# tarball را روی سرور ببر (scp/SFTP)، بعد:
sudo bash installer/update.sh \
  --config /opt/callcenter/install.conf \
  --from-file callcenter-web-3.1.0.tar.gz
```

### حالت ب — مستقیم از GitHub Releases
```bash
export GITHUB_TOKEN=ghp_...          # توکن با دسترسی repo
sudo -E bash installer/update.sh \
  --config /opt/callcenter/install.conf \
  --from-github            # آخرین ریلیز
#   --from-github v3.1.0   # نسخهٔ مشخص
```

### چه اتفاقی می‌افتد (۷ مرحله)
1. **preflight** — نصب موجود، `.env`، فضای دیسک
2. **backup** — dump کامل دیتابیس + tar از کل `app/` + کانفیگ‌های nginx/asterisk/turn/systemd
3. **fetch** — دانلود tarball + تأیید sha256 (اگر mismatch: هیچ‌چیز دست نمی‌خورد)
4. **stage** — بازکردن در `staging-<ts>` (نسخهٔ داخل tarball خوانده و چک می‌شود)
5. **apply** — `install.sh --upgrade` (idempotent؛ `.env` **merge** می‌شود نه بازنویسی؛
   `npm install` فقط اگر `package.json` عوض شده باشد؛ node_modules حفظ می‌شود)
6. **verify** — سرویس active + endpoint `/health` جواب دهد
7. **rollback** — اگر هر مرحله شکست خورد: برگرداندن app + دیتابیس از بکاپ، خودکار

تاریخچه: `update-history.log` (یک خط برای هر تلاش) — جزئیات: `update.log`.

---

## ۴. استریسکِ کانفیگ‌شده — بستهٔ بیرونی

به‌جای رندر قالب‌ها، می‌توان **دقیقاً همان نسخه‌ای که روی PBX مرجع نصب است** را
روی هر سرور دیگری پیاده کرد:

```bash
sudo bash installer/install.sh --config my.conf --only pbx \
  --asterisk-bundle asterisk-configured-bundle-18.10-20260903.tar.gz
```

یا مستقل از installer، روی خودِ PBX:
```bash
tar -xzf asterisk-configured-bundle-18.10-20260903.tar.gz
bash asterisk-configured-bundle-*/install-bundle.sh \
  asterisk-configured-bundle-* /etc/asterisk /usr/share/asterisk/sounds
asterisk -rx "core restart now"
```

کانفیگ‌های قبلی به‌صورت `*.pre-bundle-<ts>` بکاپ می‌شوند (idempotent).

### به‌روزرسانی خودِ بسته
```bash
python3 scripts/export-asterisk-bundle.py   # از dev85 خروجی می‌گیرد (نیازمند دسترسی SSH)
bash scripts/release.sh --upload <TOKEN>    # یا آپلود دستی asset به ریلیز
```

---

## ۵. تست خودکار این جریان

- محلی: `bash installer/check.sh --selftest` (۵۷+ چک) + تست انتگرال hermetic:
  `CC_TEST_MODE=1 installer/update.sh --config test.conf --from-file dist/…`
- CI: ورک‌فلو **«08 · Updater»** همین جریان کامل (ساخت بسته → آپدیت → assert → rollback)
  را روی هر push به `installer/**` اجرا می‌کند.
