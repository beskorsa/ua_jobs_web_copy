import { query } from "./db";
import { vecToPg } from "./vector";
import { fetchVacancyPage } from "./fetchExternalVacancy";

export type VacancyResult = {
  id: number;
  source: string;
  title: string;
  company: string | null;
  url: string;
  published_at: string | null;
  city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  matched_chunk: string;
  distance: number;
};

export type Vacancy = {
  id: number;
  source: string;
  title: string;
  company: string | null;
  description: string | null;
  url: string;
  published_at: string | null;
  city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
};

// Портировано из semantic_search() в postgres_store.py — тот же приём
// distinct on (v.id) + сортировка/limit во внешнем запросе (см. комментарий
// там же: LIMIT на внутреннем запросе резал бы по возрастанию id, а не по
// релевантности).
export async function semanticSearch(queryEmbedding: number[], topK = 10): Promise<VacancyResult[]> {
  const sql = `
    select id, source, title, company, url, published_at, city,
           salary_min, salary_max, salary_currency, matched_chunk, distance
    from (
      select distinct on (v.id)
        v.id, v.source, v.title, v.company, v.url, v.published_at, v.city,
        v.salary_min, v.salary_max, v.salary_currency,
        c.content as matched_chunk,
        c.embedding <=> $1 as distance
      from vacancy_chunks c
      join vacancies v on v.id = c.vacancy_id
      where v.is_active = true
      order by v.id, distance asc
    ) matched
    order by distance asc
    limit $2
  `;
  return query<VacancyResult>(sql, [vecToPg(queryEmbedding), topK]);
}

export async function getVacancy(id: number): Promise<Vacancy | null> {
  const rows = await query<Vacancy>(
    `select id, source, title, company, description, url, published_at, city,
            salary_min, salary_max, salary_currency
     from vacancies where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// Пользователь прислал в чат прямую ссылку на вакансию (необязательно с
// сайтов, которые скрапит ua_jobs_parser) — качаем страницу, вытаскиваем
// текст и кладём как обычную запись в vacancies (source='external_link'),
// чтобы дальше бесплатно переиспользовать весь существующий пайплайн
// (scoreVacancy/cover letter/ask_about_vacancy по id, карточка на фронте).
// ON CONFLICT(url) — повторная присылка той же ссылки просто обновляет текст,
// а не плодит дубли.
export async function upsertExternalVacancy(rawUrl: string): Promise<Vacancy> {
  const page = await fetchVacancyPage(rawUrl);
  const rows = await query<Vacancy>(
    `insert into vacancies (source, external_id, keyword, title, company, description, url)
     values ('external_link', null, 'external_link', $1, null, $2, $3)
     on conflict (url) do update set
       title = excluded.title,
       description = excluded.description,
       last_seen_at = now(),
       is_active = true
     returning id, source, title, company, description, url, published_at, city,
               salary_min, salary_max, salary_currency`,
    [page.title.slice(0, 300), page.text, page.finalUrl],
  );
  return rows[0];
}
