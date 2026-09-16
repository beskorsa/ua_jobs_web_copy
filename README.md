# ua-jobs-web

Веб-частина до [`ua_jobs_parser`](../ua_jobs_parser): Next.js (App Router) на
Vercel, українською. Пошук вакансій за ключовими словами (з автопідказками
та навчанням на зв'язках ключ+/ключ-), завантаження резюме (PDF або DOCX,
з OCR-фоллбеком для сканів) з автопідбором вакансій, аналіз вакансії за
посиланням або вставленим текстом, і чат, який уміє: (1) шукати вакансії,
(2) підбирати під завантажене резюме, (3) писати cover letter для вакансії
зі списку, (4) давати поради, як покращити резюме, (5) аналізувати вакансію
за посиланням/текстом поза базою.

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
npm run db:setup             # створити/донакотити схему
npm run dev                  # http://localhost:3000
```

## Деплой на Vercel

1. Залити цю папку як окремий проєкт у Vercel (Import Project → обрати
   `ua_jobs_web` як корінь, якщо репозиторій монорепо).
2. Project Settings → Environment Variables:
   - `DATABASE_URL`, `OPENAI_API_KEY` — обов'язкові.
   - `OPENAI_EMBEDDING_MODEL` / `OPENAI_CHAT_MODEL` — за бажанням, є дефолти.
   - `ADMIN_KEY` — опціонально, захищає `/admin/tokens` (порівняння
     constant-time, `timingSafeEqual`); без нього сторінка недоступна.
   - `ADMIN_BYPASS_USER_IDS` — опціонально, список `uid` (через кому), для
     яких rate-limit не застосовується (свій акаунт при тестуванні).
3. Деплой. Схема БД застосовується автоматично при першому запиті до будь-
   якого `/api/*` (`ensureSchema()`, ідемпотентно) — окремо `npm run
   db:setup` ганяти не обов'язково, але можна для перевірки заздалегідь.

## Унікальний ID користувача

Анонімний `uuid` в httpOnly-cookie (`uid`), виставляється при першому
запиті до будь-якого `/api/*` (`getOrCreateUserId()` в `src/lib/user.ts`).
Без реєстрації. Прив'язується до `resumes.user_id` і `chat_messages.user_id`
— тому повторний візит з того ж браузера бачить своє завантажене резюме, а
`GET /api/chat` підвантажує на фронт історію попередніх текстових реплік
цього ж `uid` (без прикріплених карток вакансій/cover letter — ті в базі не
зберігаються, тільки role+content).

## Конвертація зарплат у USD

Усі зарплати на сайті показуються в доларах, незалежно від валюти, у якій
вакансію завантажив парсер чи вказав роботодавець (UAH/EUR конвертуються,
USD лишається як є). Курс — живий курс НБУ (`bank.gov.ua`), кешується в
таблиці `exchange_rates` на 12 годин, щоб не смикати зовнішній API на
кожен запит (`src/lib/currency.ts`, `getNbuRates()`/`toUsdSalary()`). При
недоступності bank.gov.ua використовується останній збережений курс із
бази. Конвертація застосовується один раз, централізовано, у
`src/lib/vacancies.ts` — тому компонент картки (`VacancyCard.tsx`) її не
знає і просто показує вже перераховане значення. Стосується лише
веб-частини: `ua_jobs_parser` (CLI-фільтри `--min-salary`/`--currency`
в `sync_supabase.py`, `resume_match.py`, `telegram_report.py`) працює з
зарплатами в оригінальній валюті без змін.

## Rate-limiting

На всіх ключових ендпоінтах є Postgres-бекенд rate-limit (таблиця
`rate_limit_hits`, без Redis/Vercel KV) — лічильник по `uid` за ковзне
вікно часу:

- `/api/search` — 20 запитів / 10 хв
- `/api/chat` — 20 запитів / 10 хв
- `/api/resume` — 5 завантажень / год
- `/api/keywords` — 60 запитів / 10 хв
- аналіз вакансії за посиланням/текстом (у чаті) — 10 запитів / год

`ADMIN_BYPASS_USER_IDS` (env-змінна) знімає ліміт для вказаних `uid` —
зручно для власного тестування, щоб не впертися в ліміт разом зі
звичайними користувачами.

## Архітектура

- **API-роути (Node runtime, не Edge — потрібні `pg` і `pdf-parse`):**
  - `POST /api/search` — семантичний пошук вакансій за текстовим запитом.
  - `POST /api/resume` — завантаження PDF/DOCX, парсинг тексту (з OCR-
    фоллбеком для сканованих PDF), summary, підбір вакансій
    (`multipart/form-data`, поле `file`).
  - `POST /api/chat` — єдина точка входу для чату: OpenAI tool calling сам
    визначає намір (пошук / cover letter / поради / аналіз вакансії за
    посиланням чи текстом) і викликає потрібну функцію на сервері.
  - `POST /api/cover-letter`, `POST /api/recommendations` — ті самі дії
    напряму, без чату (для окремих кнопок в UI, якщо знадобляться).
  - `POST /api/keywords` — словник ключових/мінус-слів для автопідказок в
    UI, з навчанням на зв'язках ключ+/ключ- (`keyword_associations`).
  - `GET /admin/tokens` — сторінка статистики використання токенів OpenAI
    (`token_usage`), захищена `ADMIN_KEY`.
- **`src/lib/`** — вся логіка (без API route wrapper'ів), симетрична
  Python-модулям з `ua_jobs_parser`: `vacancies.ts` ~ `semantic_search()` в
  `postgres_store.py` (плюс класифікація режиму роботи — remote/office/
  hybrid — `work_mode`), `resumes.ts` ~ `resume_parser.py`+`resume_match.py`
  (плюс DOCX і OCR, яких немає в Python-частині), `generate.ts` ~
  `generate.py` (той самий SYSTEM_PROMPT, вручну синхронізований — TS не
  може імпортувати Python), `chunk.ts` ~ `embeddings.py` (chunk_text +
  mean-pooling), `keywords.ts` — словник ключових/мінус-слів і навчання на
  асоціаціях, `rateLimit.ts` — rate-limit по `uid`, `tokenUsage.ts` — облік
  токенів OpenAI для `/admin/tokens`.
- **`schema.ts`** — ідемпотентний DDL, повторює `postgres_store.ensure_schema()`
  плюс веб-специфічні таблиці: `web_users`, `chat_messages`,
  `resumes.user_id`, `rate_limit_hits`, `search_queries` (лог запитів
  користувачів — читає `ua_jobs_parser/suggest_keywords.py` для
  авто-підбору ключових слів), `search_keywords`, `keyword_associations`,
  `token_usage`, `exchange_rates` (кеш курсів НБУ для конвертації зарплат
  у USD), а також колонку `vacancies.work_mode`.

## Обмеження MVP

- Історія чату на фронті відновлюється лише як текст реплік (role+content)
  — картки вакансій/cover letter/поради, показані раніше, при
  перезавантаженні сторінки не повертаються (у базі не зберігаються).
