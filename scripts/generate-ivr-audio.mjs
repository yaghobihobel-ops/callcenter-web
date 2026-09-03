/**
 * تولید تمام صداهای IVR فارسی برای مرکز تماس آژانس
 * خروجی: public/audio/*.wav
 */
import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';
import path from 'path';

const OUT = '/home/z/my-project/public/audio';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const prompts = [
  ['welcome', 'به آژانس هواپیمایی پرواز گستر خوش آمدید.'],
  ['menu', 'برای بلیط داخلی یک، برای بلیط خارجی دو، برای تور سه، و برای ویزا و پاسپورت چهار را بزنید. برای گفتگو با اپراتور، صفر را بزنید.'],
  ['recording-notice', 'توجه: این مکالمه برای ارتقای کیفیت خدمات ضبط می‌شود.'],
  ['queue-announce', 'شما در صف انتظار هستید. لطفاً منتظر بمانید.'],
  ['connecting', 'در حال وصل کردن تماس شما به مشاور مربوطه هستیم. لطفاً چند لحظه صبر کنید.'],
  ['all-busy', 'در حال حاضر همه مشاوران مشغول هستند. لطفاً کمی بعد دوباره تماس بگیرید.'],
  ['survey', 'مکالمه شما به پایان رسید. رضایت شما از این گفتگو، از یک تا پنج، چند است؟ لطفاً امتیاز را بزنید.'],
  ['callback', 'ساعت کاری ما از نه صبح تا شش عصر است. اگر مایل باشید، درخواست تماس مجدد شما ثبت شد. صبح فردا با شما تماس می‌گیریم. از تماس شما سپاسگزاریم.'],
  ['goodbye', 'از تماس شما سپاسگزاریم. سفر خوشی داشته باشید.'],
  ['thanks-rating', 'از پاسخ شما سپاسگزاریم. نظر شما ثبت شد.'],
];

async function main() {
  const zai = await ZAI.create();
  for (const [name, text] of prompts) {
    const outPath = path.join(OUT, `${name}.wav`);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
      console.log(`skip ${name} (exists)`);
      continue;
    }
    try {
      const response = await zai.audio.tts.create({
        input: text,
        voice: 'tongtong',
        speed: 0.95,
        response_format: 'wav',
        stream: false,
      });
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(new Uint8Array(arrayBuffer));
      fs.writeFileSync(outPath, buffer);
      console.log(`OK ${name}: ${buffer.length} bytes`);
    } catch (e) {
      console.log(`FAIL ${name}: ${e && e.message}`);
    }
  }
}
main();
