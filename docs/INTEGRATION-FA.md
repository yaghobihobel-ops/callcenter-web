# 🔗 اتصال ویجت به دکمه‌های تماس موجود سایت

> هدف: بازدیدکننده روی دکمه/لینک تماسی که **الان در سایت دارید** کلیک کند و
> پنل تماس WebRTC باز شود — بدون تعویض شماره، بدون تماس سیم‌کارتی.

---

## ۱. نصب اسکریپت (یک‌بار، در همه صفحات)

در قالب سایت، قبل از `</body>`:

```html
<script src="https://call.firuzo.online/widget.js" defer></script>
```

ویجت idle دیده نمی‌شود جز یک دکمه شناور کوچک (FAB) که در تنظیمات `/api/widget/config`
قابل تغییر است؛ اگر FAB نمی‌خواهید، از نمایشگر CSS استفاده کنید — هوک دکمه‌ها
مستقل از FAB کار می‌کند.

## ۲. سه راه هوک (به‌ترتیب اولویت)

### الف) لینک‌های `tel:` — بدون هیچ تغییری

هر `<a href="tel:+982191000000">` که در سایت دارید، به‌صورت خودکار به‌جای تماس
سیم‌کارتی، پنل ویجت را باز می‌کند (با delegation، پس برای محتوای داینامیک هم کار می‌کند).
اگر خواستید یک لینک tel استثنا باشد و همان tel: بماند:

```html
<a href="tel:+982191000000" data-fz-native>...</a>
```

### ب) دکمه‌های دلخواه — اتریبیوت

```html
<button data-fz-call>تماس با کارشناس</button>
<div data-fz-call data-fz-name="حاجی‌آقا" data-fz-phone="0912...">...</div>
```

`data-fz-name` و `data-fz-phone` اختیاری‌اند و در پاپ‌آپ CRM اپراتور ظاهر می‌شوند.

### ج) کلاس آماده

```html
<a class="fz-call-trigger">پشتیبانی تلفنی</a>
```

## ۳. JS API

```js
window.FiruzoCall.open();          // باز کردن پنل
window.FiruzoCall.close();
window.FiruzoCall.startCall();     // پرش مستقیم به تماس (پرمیشن می‌گیرد)
window.FiruzoCall.isOpen();        // وضعیت
```

نمونه — شمارنده کلیک برای تحلیل:

```js
document.addEventListener('click', e => {
  if (e.target.closest('[data-fz-call]')) {
    gtag('event', 'call_widget_open');
  }
});
```

## ۴. نکات SPA (React/Next/Vue)

- هوک دکمه‌ها **delegation** روی `document` است؛ رندر مجدد کامپوننت‌ها مشکلی ندارد.
- بعد از تغییر مسیر (route)، نیازی به فراخوانی مجدد نیست.
- در Next.js اسکریپت را در `app/[locale]/layout.tsx` (قبل از `</body>`) با تگ
  `<Script src="..." strategy="afterInteractive" />` بگذارید.

## ۵. چیدمان و ظاهر

- موبایل: **bottom-sheet** تمام‌عرض با دستگیره، انیمیشن نرم، z-index بالا.
- دسکتاپ: کارت شیک پایین-راست با سایه و گوشه گرد.
- رنگ برند از `/api/widget/config` (`brand.color`) می‌آید — بدون تغییر کد ویجت.
- ویجت RTL/LTR را از `dir` صفحه تشخیص می‌دهد.

## ۶. جریان پرمیشن میکروفون

```
کلیک تماس → پنل باز → دکمه «شروع تماس»
    → توضیح کوتاه چرا میکروفون لازم است
    → getUserMedia
        ✓ موفق → اتصال SIP و زنگ خوردن
        ✗ رد شد → کارت راهنمای همان مرورگر + دکمه «دوباره تلاش»
        ✗ پشتیبانی نمی‌شود → کارت شماره پشتیبانی (tel:)
```

## ۷. تست سریع اتصال

```bash
# 1) ویجت از CDN سرو می‌شود؟
curl -sI https://call.firuzo.online/widget.js | head -3

# 2) کانفیگ ران‌تایم با CORS درست؟
curl -s -H "Origin: https://firuzo.online" https://call.firuzo.online/api/widget/config | head -c 300
```

سپس در مرورگر (کنسول):

```js
FiruzoCall.startCall();   // باید پرمیشن بگیرد و زنگ بخورد
```

اگر دکمه‌ای جواب نداد: کنسول مرورگر را باز کنید؛ اگر `fzw2-` در لاگ نبود یعنی
اسکریپت اصلاً لود نشده (نکته: هدر CSP سایت نباید اسکریپت خارجی را بلاک کند —
`script-src` را با دامنه call خودتان به‌روز کنید).
