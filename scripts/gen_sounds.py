#!/usr/bin/env python3
"""Generate Persian IVR sounds via edge-tts -> 8kHz mono WAV for Asterisk."""
import asyncio, os, subprocess

OUT = "/home/z/my-project/sounds"
os.makedirs(OUT, exist_ok=True)
VOICE = "fa-IR-DilaraNeural"

scripts = {
    "welcome":      "به پشتیبانی فیرزو خوش آمدید. لطفاً توجه داشته باشید که تماس شما ضبط می‌شود.",
    "queue-wait":   "در حال وصل کردن شما به اپراتور هستیم. لطفاً چند لحظه منتظر بمانید.",
    "survey-intro": "برای ارزیابی کیفیت پاسخگویی، لطفاً عددی از یک تا پنج را فشار دهید.",
    "survey-thanks":"از همراهی شما سپاسگزاریم. روز خوبی داشته باشید.",
    "op-join":      "شما به صف پاسخگویی اضافه شدید.",
    "op-leave":     "شما از صف پاسخگویی خارج شدید.",
    "after-hours":  "ساعت کاری به پایان رسیده است. لطفاً در ساعات اداری دوباره تماس بگیرید.",
}

async def gen(name, text):
    import edge_tts
    mp3 = f"{OUT}/{name}.mp3"
    await edge_tts.Communicate(text, VOICE).save(mp3)
    return mp3

async def main():
    for name, text in scripts.items():
        mp3 = await gen(name, text)
        wav8 = f"{OUT}/{name}.wav"
        # Asterisk best format: 8kHz 16-bit PCM mono WAV
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3,
                        "-ar", "8000", "-ac", "1", "-acodec", "pcm_s16le", wav8], check=True)
        os.remove(mp3)
        print(f"{name}.wav  {os.path.getsize(wav8)} bytes")

asyncio.run(main())
