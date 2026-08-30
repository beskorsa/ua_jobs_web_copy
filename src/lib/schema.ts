import { query } from "./db";

// Размерность вектора для этой (веб-)части — всегда OpenAI text-embedding-3-small.
// Должна совпадать с тем, чем реально насчитаны vacancy_chunks в базе (см. .env.example).
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);

let ensured = false;

/**
 * Идемпотентная схема — полный аналог postgres_store.ensure_schema() из
 * Python-части (create table if not exists everywhere), плюс то, что
 * специфично для веб-сайта: анонимные пользователи (web_users) и лог чата.
 *
 * Обычно к моменту первого запроса к сайту таблицы vacancies/resumes/
 * generations уже созданы Python-стороной (main.py, sync_supabase.py,
 * generate.py) — но дублируем DDL здесь, чтобы веб-часть могла поднять
 * пустую Supabase-базу и самостоятельно, без обязательного порядка запуска.
 * Кэшируем факт применения в памяти процесса, чтобы не гонять 10+ DDL-команд
 * на каждый API-запрос — false negative после холодного старта не страшен,
 * DDL здесь безопасно перевызывать (if not exists).
 */
export async function ensureSchema(): Promise<void> {
  if (ensured) return;

  await query("create extension if not exists vector;");

  await query(`
    create table if not exists vacancies (
      id              bigint generated always as identity primary key,
      source          text not null,
      external_id     text,
      keyword         text not null,
      title           text not null,
      company         text,
      description     text,
      url             text not null unique,
      published_at    date,
      city            text,
      salary_min      numeric,
      salary_max      numeric,
      salary_currency text,
      salary_raw      text,
      first_seen_at   timestamptz not null default now(),
      last_seen_at    timestamptz not null default now(),
      is_active       boolean not null default true
    );
  `);
  await query("create index if not exists idx_vacancies_active on vacancies (is_active);");

  // work_mode — 'remote' | 'office' | 'hybrid' | null (невідомо/не вдалось
  // розпізнати). Раніше "віддалено/офіс" був лише неявним сигналом у
  // semantic search (embedding міг збігтись чи ні) — картка вакансії ніяк
  // цього не показувала, тож користувач не міг з першого погляду відрізнити
  // remote-вакансію від суто офісної. Заповнюється: парсером (evristika по
  // title+description, див. ua_jobs_parser/scrapers/base.py
  // classify_work_mode) для вакансій з нічного скрейпу; на веб-стороні —
  // classifyWorkMode() у vacancies.ts для посилань/вставленого тексту з чату
  // (analyze_vacancy_link/analyze_vacancy_text), які йдуть повз парсер.
  await query(`alter table vacancies add column if not exists work_mode text;`);

  await query(`
    create table if not exists vacancy_chunks (
      id           bigint generated always as identity primary key,
      vacancy_id   bigint not null references vacancies(id) on delete cascade,
      chunk_index  int not null,
      content      text not null,
      embedding    vector(${EMBEDDING_DIM}),
      unique (vacancy_id, chunk_index)
    );
  `);

  await query(`
    create table if not exists resumes (
      id            bigint generated always as identity primary key,
      filename      text,
      raw_text      text not null,
      uploaded_at   timestamptz not null default now()
    );
  `);

  // content_hash — sha256 витягнутого тексту резюме: дозволяє впізнати, що
  // цей самий користувач вже завантажував саме цей файл (той самий текст),
  // і не ганяти повторно embedding + LLM-сумаризацію за ті самі гроші/токени.
  // summary кешує результат summarizeResume(), щоб при повторному
  // завантаженні того самого резюме показати "ми вже пам'ятаємо" миттєво,
  // без нового виклику OpenAI.
  await query(`alter table resumes add column if not exists content_hash text;`);
  await query(`alter table resumes add column if not exists summary text;`);
  await query(
    "create unique index if not exists idx_resumes_user_hash on resumes (user_id, content_hash) where content_hash is not null;",
  );

  await query(`
    create table if not exists resume_sections (
      id           bigint generated always as identity primary key,
      resume_id    bigint not null references resumes(id) on delete cascade,
      section      text not null,
      content      text not null,
      embedding    vector(${EMBEDDING_DIM}),
      unique (resume_id, section)
    );
  `);

  await query(`
    create table if not exists generations (
      id                     bigint generated always as identity primary key,
      resume_id              bigint not null references resumes(id) on delete cascade,
      vacancy_id             bigint not null references vacancies(id) on delete cascade,
      model                  text not null,
      relevance              smallint not null check (relevance between 1 and 10),
      reasoning              text not null,
      cover_letter_sentences jsonb not null,
      created_at             timestamptz not null default now(),
      unique (resume_id, vacancy_id)
    );
  `);

  // --- специфика веб-части ---

  await query(`
    create table if not exists web_users (
      id          uuid primary key,
      created_at  timestamptz not null default now()
    );
  `);

  await query(`alter table resumes add column if not exists user_id uuid references web_users(id);`);
  await query(`create index if not exists idx_resumes_user on resumes (user_id);`);

  await query(`
    create table if not exists chat_messages (
      id          bigint generated always as identity primary key,
      user_id     uuid not null references web_users(id) on delete cascade,
      role        text not null,
      content     text not null,
      created_at  timestamptz not null default now()
    );
  `);
  await query("create index if not exists idx_chat_messages_user on chat_messages (user_id, created_at);");

  // rate-limit: по одной строке на каждый запрос, который стоит денег
  // (OpenAI вызовы) — см. src/lib/rateLimit.ts. bucket разделяет разные виды
  // запросов (search/resume/chat/...), чтобы лимиты не мешали друг другу.
  await query(`
    create table if not exists rate_limit_hits (
      id          bigint generated always as identity primary key,
      user_id     uuid not null references web_users(id) on delete cascade,
      bucket      text not null,
      created_at  timestamptz not null default now()
    );
  `);
  await query("create index if not exists idx_rate_limit_hits_lookup on rate_limit_hits (user_id, bucket, created_at);");

  // Обратная связь сайт -> парсер: реальные запросы пользователей (поиск,
  // чат, факт загрузки резюме), которые Python-скрипт suggest_keywords.py
  // читает, чтобы предложить новые ключевые слова для keywords.csv. См.
  // src/lib/searchLog.ts.
  await query(`
    create table if not exists search_queries (
      id             bigint generated always as identity primary key,
      user_id        uuid not null references web_users(id) on delete cascade,
      source         text not null,
      query          text not null,
      results_count  int,
      created_at     timestamptz not null default now()
    );
  `);
  await query("create index if not exists idx_search_queries_created on search_queries (created_at);");

  // Словник ключових слів / мінус-слів для автопідказок у пошуку (див.
  // src/lib/keywords.ts). "kind" розділяє два незалежних списки: звичайні
  // ключові слова (include) і мінус-слова для виключення (exclude) —
  // одне й те саме слово теоретично може бути в обох. usage_count росте
  // з кожним новим використанням — підказки сортуються за популярністю.
  await query(`
    create table if not exists search_keywords (
      id           bigint generated always as identity primary key,
      term         text not null,
      kind         text not null check (kind in ('include', 'exclude')),
      usage_count  int not null default 1,
      created_at   timestamptz not null default now()
    );
  `);
  await query(
    "create unique index if not exists idx_search_keywords_uniq on search_keywords (lower(term), kind);",
  );
  await query(
    "create index if not exists idx_search_keywords_prefix on search_keywords (kind, usage_count desc);",
  );

  // Самонавчальна система релевантності (див. src/lib/keywords.ts:
  // recordKeywordAssociations/suggestLearnedExclusions). Кожен реальний
  // пошук, де користувач ввів і ключові, і мінус-слова одночасно, — це
  // сигнал "хто шукає X — часто НЕ хоче Y". weight росте з кожним повторним
  // збігом пари (include_term, exclude_term), тож найчастіші асоціації
  // спливають нагору органічно, без окремого перенавчання/батч-джобу —
  // база "навчається" на кожному запиті.
  await query(`
    create table if not exists keyword_associations (
      id            bigint generated always as identity primary key,
      include_term  text not null,
      exclude_term  text not null,
      weight        int not null default 1,
      updated_at    timestamptz not null default now()
    );
  `);
  await query(
    "create unique index if not exists idx_keyword_assoc_uniq on keyword_associations (lower(include_term), lower(exclude_term));",
  );
  await query(
    "create index if not exists idx_keyword_assoc_lookup on keyword_associations (lower(include_term), weight desc);",
  );

  // Лічильник витрат токенів OpenAI (див. src/lib/tokenUsage.ts) — один
  // рядок на кожен виклик embeddings/chat.completions, з "kind" (типом
  // запиту: пошук, чат, cover letter тощо), щоб бачити не тільки скільки
  // токенів пішло всього, а й НА ЩО саме — це основа і для сторінки
  // /admin/tokens зараз, і для майбутньої системи оптимізації токенів.
  await query(`
    create table if not exists token_usage (
      id                 bigint generated always as identity primary key,
      kind               text not null,
      model              text not null,
      prompt_tokens      int not null default 0,
      completion_tokens  int not null default 0,
      total_tokens       int not null default 0,
      user_id            uuid references web_users(id) on delete set null,
      created_at         timestamptz not null default now()
    );
  `);
  await query("create index if not exists idx_token_usage_kind_created on token_usage (kind, created_at);");
  await query("create index if not exists idx_token_usage_created on token_usage (created_at);");

  ensured = true;
}
