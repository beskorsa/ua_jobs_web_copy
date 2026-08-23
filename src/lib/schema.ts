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

  ensured = true;
}
