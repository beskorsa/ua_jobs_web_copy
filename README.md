# ua-jobs-web

Веб-часть к [`ua_jobs_parser`](../ua_jobs_parser): Next.js (App Router) на
Vercel, українською. MVP — одна сторінка: пошук вакансій за ключовими
словами, завантаження резюме (PDF) з автопідбором вакансій, і чат, який
уміє: (1) шукати вакансії, (2) підбирати під завантажене резюме, (3)
писати cover letter для вакансії зі списку, (4) давати поради, як
покращити резюме.

## Важливо: спільна база з Python-частиною

Веб-частина ходить у ту саму Postgres/Supabase базу, що й `ua_jobs_parser`
(`DATABASE_URL` — той самий). Але вона serverless (Vercel Node-функції) —
локальні embedding-моделі (`sentence-transformers`, `EMBEDDING_PROVIDER=local`
у Python-частині) там не погонять, тому веб-части **завжди** використовує
OpenAI-ембеддинги (`text-embedding-3-small`, 1536 вимірів).

**Якщо `vacancy_chunks` у базі вже насчитані з `EMBEDDING_PROVIDER=local`
(384-вимірні, дефолт у `ua_jobs_parser/.env`) — пошук на сайті працювати не
буде** (pgvector кине помилку через невідповідність розмірності). Перед
першим запуском:

```bash
cd ../ua_jobs_parser
EMBEDDING_PROVIDER=openai python sync_supabase.py   # пересинкати з правильною розмірністю
```

## Установка (локально)

```bash
npm install
cp .env.example .env.local   # заповнити DATABASE_URL, OPENAI_API_KEY
npm run db:setup             # створити/донакотити схему (web_users, chat_messages, user_id у resumes)
npm run dev                  # http://localhost:3000
```

## Деплой на Vercel

1. Залити цю папку як окремий проєкт у Vercel (Import Project → обрати
   `ua_jobs_web` як корінь, якщо репозиторій монорепо).
2. Project Settings → Environment Variables: `DATABASE_URL`,
   `OPENAI_API_KEY`, за бажанням `OPENAI_EMBEDDING_MODEL`/`OPENAI_CHAT_MODEL`.
3. Деплой. Схема БД застосовується автоматично при першому запиті до будь-
   якого `/api/*` (`ensureSchema()`, ідемпотентно) — окремо `npm run
   db:setup` ганяти не обов'язково, але можна для перевірки заздалегідь.

## Унікальний ID користувача

Анонімний `uuid` в httpOnly-cookie (`uid`), виставляється при першому
запиті до будь-якого `/api/*` (`getOrCreateUserId()` в `src/lib/user.ts`).
Без реєстрації. Прив'язується до `resumes.user_id` і `chat_messages.user_id`
— тому повторний візит з того ж браузера бачить своє завантажене резюме
(хоча UI поки що не показує історію явно — це просто зберігається в базі
під тим самим ID, для майбутнього).

## Архітектура

- **API-роути (Node runtime, не Edge — потрібні `pg` і `pdf-parse`):**
  - `POST /api/search` — семантичний пошук вакансій за текстовим запитом.
  - `POST /api/resume` — завантаження PDF, парсинг тексту, summary, підбір
    вакансій (`multipart/form-data`, поле `file`).
  - `POST /api/chat` — єдина точка входу для чату: OpenAI tool calling сам
    визначає намір (пошук / cover letter / поради) і викликає потрібну
    функцію на сервері.
  - `POST /api/cover-letter`, `POST /api/recommendations` — ті самі дії
    напряму, без чату (для окремих кнопок в UI, якщо знадобляться).
- **`src/lib/`** — вся логіка (без API route wrapper'ів), симетрична
  Python-модулям з `ua_jobs_parser`: `vacancies.ts` ~ `semantic_search()` в
  `postgres_store.py`, `resumes.ts` ~ `resume_parser.py`+`resume_match.py`,
  `generate.ts` ~ `generate.py` (той самий SYSTEM_PROMPT, вручну
  синхронізований — TS не може імпортувати Python), `chunk.ts` ~
  `embeddings.py` (chunk_text + mean-pooling).
- **`schema.ts`** — ідемпотентний DDL, повторює `postgres_store.ensure_schema()`
  плюс `web_users`/`chat_messages`/`resumes.user_id` для веб-частини.

## Обмеження MVP

- OCR для сканованих PDF-резюме не підтримується (як і в Python-частині).
- Історія чату пишеться в `chat_messages`, але на фронті не підвантажується
  назад при повторному візиті — тільки поточна сесія в браузері (state в
  React, зникає при перезавантаженні сторінки).
- Немає rate-limiting на API — для публічного MVP з реальним трафіком варто
  додати (наприклад, Vercel KV + лічильник на `uid`), інакше хтось може
  накрутити витрати на OpenAI.
