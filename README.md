# 🤖 Bale Freebuff Bot

پل ارتباطی بین ربات بله (Bale Messenger) و Freebuff CLI

این پروژه به شما امکان می‌دهد از طریق یک ربات در پیام‌رسان بله، با Freebuff تعامل کنید.

## ✨ ویژگی‌ها

- 🔄 Session مستقل برای هر کاربر
- 📝 ارسال دستورات متنی به Freebuff و دریافت پاسخ
- ⚡ اندیکاتور تایپ در Bale
- 🔒 سیستم مجوز (محدود کردن کاربران)
- ⏰ Session خودکار با timeout
- 🔄 دستورات مدیریتی (/new, /stop, /status)

## 📋 پیش‌نیازها

- Node.js >= 18
- نصب Freebuff CLI (`npm install -g freebuff`)
- حساب بله و توکن ربات

## ⚙️ نصب و راه‌اندازی

### ۱. ساخت ربات در بله

1. به پیام‌رسان بله بروید
2. با `@BotFather` چت کنید
3. دستور `/newbot` را بزنید
4. نام و username ربات را مشخص کنید
5. توکن دریافتی را ذخیره کنید

### ۲. نصب پروژه

```bash
cd bale-freebuff-bot
npm install
```

### ۳. پیکربندی

روش اول: فایل `config.json`
```bash
cp config.example.json config.json
# فایل config.json را ویرایش کنید
```

روش دوم: متغیرهای محیطی
```bash
cp .env.example .env
# فایل .env را ویرایش کنید
```

### ۴. اجرا

```bash
npm start
```

یا برای توسعه (با auto-reload):
```bash
npm run dev
```

## 📖 استفاده

### دستورات ربات

| دستور | توضیح |
|-------|--------|
| `/start` | نمایش راهنمای ربات |
| `/new` | شروع session جدید Freebuff |
| `/stop` | متوقف کردن session فعلی |
| `/status` | بررسی وضعیت session |
| `/help` | نمایش راهنمای کامل |

### نحوه کار

1. هر پیام متنی که به ربات بفرستید، مستقیماً به عنوان ورودی Freebuff ارسال می‌شود
2. خروجی Freebuff برگردانده شده و در بله نمایش داده می‌شود
3. هر کاربر یک session مستقل دارد
4. پس از ۳۰ دقیقه عدم فعالیت، session منقضی می‌شود

### مثال

```
کاربر: یک فایل hello.py بساز که Hello World چاپ کند

ربات: [خروجی Freebuff - فایل ایجاد شد]
```

## ⚠️ محدودیت‌ها

- **پیام‌های طولانی**: حداکثر اندازه پیام در بله حدود ۴۰۹۶ کاراکتر است. خروجی‌های طولانی بریده می‌شوند.
- **KHTML**: Freebuff CLI به TTY نیاز دارد. از `node-pty` برای شبیه‌سازی TTY استفاده می‌شود.
- **تبلیغات**: Freebuff ممکن است اعلان‌های تبلیغاتی در خروجی نشان دهد.

## 🏗️ ساختار پروژه

```
bale-freebuff-bot/
├── src/
│   ├── index.js      # نقطه ورود اصلی
│   ├── bale.js       # کلاینت Bale Bot API
│   ├── freebuff.js   # رپر PTY Freebuff
│   ├── bridge.js     # پل ارتباطی Bale ↔ Freebuff
│   └── config.js     # مدیریت پیکربندی
├── config.example.json
├── .env.example
├── package.json
└── README.md
```

## 🔧 عیب‌یابی

### ربات پاسخ نمی‌دهد
- توکن ربات را بررسی کنید
- اتصال اینترنت را چک کنید
- لاگ‌های کنسول را بررسی کنید

### Freebuff اجرا نمی‌شود
- مطمئن شوید Freebuff نصب است: `freebuff --version`
- مسیر `freebuffPath` در config را بررسی کنید

### پاسخ‌ها خالی هستند
- `SESSION_TIMEOUT_MS` را افزایش دهید
- `FLUSH_DELAY` را در `freebuff.js` بررسی کنید
