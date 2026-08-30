import { randomUUID } from "crypto";
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
//
// excludeTerms — мінус-слова з тег-інпуту на фронті (див. keywords.ts):
// вакансія відсіюється, якщо будь-яке з них зустрічається в назві чи описі
// (регістронезалежно). Фільтр на рівні SQL, а не постфільтрація в JS —
// щоб LIMIT рахувався вже після відсіву, а не обрізав видачу до фільтра.
//
// Один і той самий job-пост часто скрейпиться з кількох сайтів одразу
// (work.ua/robota.ua/djinni тощо) — це різні рядки vacancies з різним
// source/url, але з однаковою назвою+компанією. Тому додатковий шар
// distinct on (lower(title), lower(company)) відсіює дублікати, лишаючи
// найрелевантнішу (найближчу за distance) копію. Внутрішній пул беремо з
// запасом (INNER_POOL_MULTIPLIER), інакше дедуп після LIMIT $2 міг би
// відсікти вакансії, які виглядали унікальними лише через те, що дублікат
// не потрапив у вибірку.
const INNER_POOL_MULTIPLIER = 4;

// learnedExcludeTerms — м'який сигнал від самонавчальної системи (див.
// suggestLearnedExclusions у keywords.ts): терміни, які інші користувачі
// історично додавали як мінус-слова разом з тими самими ключовими словами.
// На відміну від excludeTerms (жорсткий фільтр, введений САМИМ користувачем
// у цьому пошуку), тут вакансія НЕ відсіюється — лише отримує штраф до
// distance за кожен збіг, тобто опускається нижче у видачі. Так вакансія
// не зникає повністю через непідтверджений сигнал, але релевантність
// пошуку з часом підлаштовується під те, чого реально уникають користувачі.
const LEARNED_EXCLUDE_PENALTY = 0.05;

export async function semanticSearch(
  queryEmbedding: number[],
  topK = 10,
  excludeTerms: string[] = [],
  learnedExcludeTerms: string[] = [],
): Promise<VacancyResult[]> {
  // Обидва масиви завжди передаються як параметри (навіть порожні) — так
  // номери $-плейсхолдерів фіксовані незалежно від вмісту, і немає шансу
  // знову зсунути нумерацію умовним push (як сталось із попереднім
  // варіантом цієї функції). unnest('{}') дає 0 рядків — і NOT EXISTS з
  // порожнім excludeTerms, і штраф з порожнім learnedExcludeTerms коректно
  // не впливають на результат.
  const cleanExcludes = excludeTerms.map((t) => t.trim()).filter(Boolean);
  const cleanLearned = learnedExcludeTerms.map((t) => t.trim()).filter(Boolean);
  const innerLimit = topK * INNER_POOL_MULTIPLIER;
  const params: unknown[] = [vecToPg(queryEmbedding), topK, innerLimit, cleanExcludes, cleanLearned];

  const sql = `
    select id, source, title, company, url, published_at, city,
           salary_min, salary_max, salary_currency, matched_chunk, distance
    from (
      select distinct on (lower(title), coalesce(lower(company), ''))
        id, source, title, company, url, published_at, city,
        salary_min, salary_max, salary_currency, matched_chunk, distance
      from (
        select id, source, title, company, url, published_at, city,
               salary_min, salary_max, salary_currency, matched_chunk, distance
        from (
          select distinct on (v.id)
            v.id as id, v.source as source, v.title as title, v.company as company,
            v.url as url, v.published_at as published_at, v.city as city,
            v.salary_min as salary_min, v.salary_max as salary_max,
            v.salary_currency as salary_currency,
            c.content as matched_chunk,
            (c.embedding <=> $1)
              + ${LEARNED_EXCLUDE_PENALTY} * (
                  select count(*) from unnest($5::text[]) as le(term)
                  where v.title ilike '%' || le.term || '%' or v.description ilike '%' || le.term || '%'
                )
              as distance
          from vacancy_chunks c
          join vacancies v on v.id = c.vacancy_id
          where v.is_active = true
            and not exists (
              select 1 from unnest($4::text[]) as ex(term)
              where v.title ilike '%' || ex.term || '%' or v.description ilike '%' || ex.term || '%'
            )
          order by v.id, distance asc
        ) per_vacancy
        order by distance asc
        limit $3
      ) pool
      order by lower(title), coalesce(lower(company), ''), distance asc
    ) deduped
    order by distance asc
    limit $2
  `;
  return query<VacancyResult>(sql, params);
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

// Якщо посилання веде на вакансію, яку вже затягнув парсер (work.ua/
// robota.ua/dou.ua/djinni.co тощо — nightly watchdog.py) — вона вже лежить
// в базі з повним описом, і НЕ треба ходити за нею http-запитом з сервера
// (де це часто ловить 403 від бот-захисту, бо запит йде з датацентрового
// IP Vercel без рендеру сторінки — на відміну від парсера, який ходить
// через Playwright з локальної машини). rtrim по "/" — щоб не залежати
// від хвостового слеша в присланому лінку.
export async function getVacancyByUrl(rawUrl: string): Promise<Vacancy | null> {
  const rows = await query<Vacancy>(
    `select id, source, title, company, description, url, published_at, city,
            salary_min, salary_max, salary_currency
     from vacancies
     where rtrim(url, '/') = rtrim($1, '/') and is_active = true
     order by last_seen_at desc
     limit 1`,
    [rawUrl],
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
// Розділено на fetch (тут викликається) і store (нижче) — щоб виклик у чаті
// (analyze_vacancy_link) міг спершу перевірити ЩО завантажилось (див.
// looksLikeResume у route.ts), і НЕ зберігати в vacancies сторінку, яка
// виявилась чиїмось резюме, а не вакансією.
export async function storeExternalVacancy(page: Awaited<ReturnType<typeof fetchVacancyPage>>): Promise<Vacancy> {
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

// Зручна обгортка fetch+store для місць, де перевірка "це точно вакансія?"
// не потрібна (наразі — ніде окрім через analyze_vacancy_link у чаті, який
// тепер сам викликає fetchVacancyPage + storeExternalVacancy окремо).
export async function upsertExternalVacancy(rawUrl: string): Promise<Vacancy> {
  const page = await fetchVacancyPage(rawUrl);
  return storeExternalVacancy(page);
}

// Фолбек, коли пряме завантаження за посиланням не вдалось (403 від
// бот-захисту сайту тощо, див. fetchExternalVacancy.ts) — користувач сам
// копіює текст вакансії і вставляє в чат. url тут синтетичний (сайт її
// не видав), унікальність не потрібна — кожна вставка створює новий запис.
export async function upsertVacancyFromText(title: string, text: string): Promise<Vacancy> {
  const syntheticUrl = `pasted://${randomUUID()}`;
  const rows = await query<Vacancy>(
    `insert into vacancies (source, external_id, keyword, title, company, description, url)
     values ('pasted_text', null, 'pasted_text', $1, null, $2, $3)
     returning id, source, title, company, description, url, published_at, city,
               salary_min, salary_max, salary_currency`,
    [title.slice(0, 300), text.slice(0, 12000), syntheticUrl],
  );
  return rows[0];
}
