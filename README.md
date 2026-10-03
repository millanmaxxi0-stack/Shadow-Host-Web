# SH4D0W HOST — پلتفرم هاستینگ سایت استاتیک (PaaS-native)

کاربر ثبت‌نام می‌کند، ZIP سایتش را آپلود می‌کند و روی `slug.BASE_DOMAIN` سرو می‌شود.
فایل‌ها در Object Storage (R2/S3) هستند، نه روی دیسک. Session با JWT cookie است (مناسب چند-instance). هیچ وابستگی به VPS ندارد.

## معماری
- **Web** (Express): داشبورد + API + سرو سایت‌ها بر اساس Host header
- **PostgreSQL** (Managed)
- **Object Storage** (Cloudflare R2 / AWS S3 / Supabase S3)
- **Worker**: پاک‌سازی دیپلوی‌های قدیمی (سرویس جداگانه)

## نصب و اجرای Local
```bash
npm install
cp .env.example .env      # مقادیر را پر کنید
export $(grep -v '^#' .env | xargs)
npm run migrate
npm run dev
```
برای تست Local: `BASE_DOMAIN=localhost` و باز کردن `http://mysite.localhost:3000` (مرورگرهای مدرن `*.localhost` را resolve می‌کنند).

## Environment Variables
| نام | توضیح |
|---|---|
| DATABASE_URL | آدرس PostgreSQL (الزامی) |
| DATABASE_SSL | `true` برای دیتابیس‌هایی که SSL می‌خواهند (Render) |
| JWT_SECRET | رشته‌ی تصادفی بلند (الزامی) |
| BASE_DOMAIN | دامنه‌ی اصلی سایت‌ها، مثل `example.com` (الزامی) |
| S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | تنظیمات Storage (الزامی) |
| S3_ENDPOINT | برای R2: `https://<account>.r2.cloudflarestorage.com` |
| S3_REGION | پیش‌فرض `auto` |
| S3_FORCE_PATH_STYLE | `true` برای برخی providerها |
| PORT | توسط Railway/Render تنظیم می‌شود |

## Build و Production
```bash
npm run build
npm start          # بدون migrate
npm run start:prod # اول migrate، بعد start (پیش‌فرض Docker)
```
Migration هنگام هر استارت اجرا می‌شود و idempotent است. Health check: `GET /api/health`.

## ساخت PostgreSQL
- Railway: New → Database → PostgreSQL، سپس `DATABASE_URL` را با Reference Variable به سرویس وب وصل کنید.
- Render: در `render.yaml` تعریف شده؛ یا New → PostgreSQL.

## Deploy روی Railway
1. Repo را در GitHub بگذارید → New Project → Deploy from GitHub.
2. PostgreSQL اضافه کنید و Variableها را از جدول بالا ست کنید.
3. Worker: یک سرویس دوم از همان Repo بسازید و Start Command را `npm run worker` بگذارید (فقط DB و S3 vars لازم است).
4. Settings → Networking → Generate Domain.

## Deploy روی Render
New → Blueprint → Repo را انتخاب کنید (از `render.yaml` استفاده می‌شود). متغیرهای `sync: false` را دستی پر کنید.

## دامنه و HTTPS (مهم)
سایت‌ها روی subdomain سرو می‌شوند، پس **Wildcard domain** لازم است:
1. در پلتفرم، هم `BASE_DOMAIN` و هم `*.BASE_DOMAIN` را Custom Domain اضافه کنید (پشتیبانی wildcard را در مستندات پلتفرم/پلن خود چک کنید).
2. رکوردهای DNS (CNAME) که پلتفرم می‌دهد را بسازید. HTTPS خودکار صادر می‌شود.
3. داشبورد روی خود `BASE_DOMAIN` (یا هر Host غیر از `*.BASE_DOMAIN`) باز می‌شود.
بدون wildcard، فقط داشبورد کار می‌کند و سایت‌ها قابل دسترسی نیستند.

## WebSocket
استفاده نمی‌شود.

## Troubleshooting
- **Health check fail**: `DATABASE_URL`/`DATABASE_SSL` را چک کنید.
- **Upload error 500**: کلیدها/endpoint/bucket را چک کنید.
- **404 روی سایت**: wildcard DNS، یا deploy نشدن پروژه (کش ۱۵ ثانیه‌ای).
- **ZIP رد می‌شود**: `index.html` باید در ریشه باشد؛ حداکثر ۲۵MB و ۲۰۰۰ فایل.
