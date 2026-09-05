import { randomUUID } from "crypto";
import { query } from "./db";
import { vecToPg } from "./vector";
import { fetchVacancyPage } from "./fetchExternalVacancy";

export type WorkMode = "remote" | "office" | "hybrid";

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
  work_mode: WorkMode | null;
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
  work_mode: WorkMode | null;
};

// Ключові слова — свідомо ширші за один точний вираз (укр/рос/eng варіанти,
// бо джерела — суміш українських і зросійщених сайтів). Порядок перевірки
// важливий: hybrid-маркер переважає (навіть якщо поруч згадано "віддалено" —
// це вже не суто remote), потім remote, і лише насамкінець — office-only
// маркер, який рахується ЛИШЕ якщо ніде поруч не згадано remote (інакше
// "переважно офіс, можливо віддалено за домовленістю" хибно стало б "office").
// Дзеркало classify_work_mode() у ua_jobs_parser/scrapers/base.py — тримати
// списки маркерів синхронізованими, якщо редагуєш один з двох.
const REMOTE_MARKERS = [
  "віддалено", "видалено", "удалённо", "удаленно", "дистанційно", "дистанционно",
  "remote", "work from home", "wfh", "з дому", "из дома", "фултайм ремоут",
  "remote-first", "remote work", "повністю віддалена", "полностью удалённая",
];
const HYBRID_MARKERS = [
  "гібридний формат", "гибридный формат", "гібрид", "гибрид", "hybrid",
  "частково віддалено", "частично удаленно", "частково в офісі", "частично в офисе",
  "2 дні в офісі", "3 дні в офісі", "2 дня в офисе", "3 дня в офисе",
  "2 days in office", "3 days in office", "hybrid work",
];
const OFFICE_ONLY_MARKERS = [
  "тільки офіс", "только офис", "офісний формат", "офисный формат",
  "office only", "on-site only", "onsite only", "робота лише в офісі",
  "работа только в офисе", "присутність в офісі обов'язкова",
  "присутствие в офисе обязательно", "без можливості віддаленої роботи",
  "без возможности удаленной работы", "виключно офлайн формат", "исключительно офлайн формат",
];

// Слова заперечення БІЛЯ маркера (до чи після) скасовують збіг — без цього
// фраза на кшталт "віддалено не розглядаємо" хибно матчилась би як
// REMOTE_MARKERS (простий includes() не бачить заперечення поруч). Заперечення
// природною мовою трапляється по обидва боки: "не працюємо віддалено"
// (перед маркером) і "віддалено не розглядаємо" (після маркера — "не"
// стосується самого слова "віддалено", хоч і йде за ним). Тому дивимось
// в обидва боки. Знайдено регресійним тестом tests/vacancies.workMode.test.ts
// на реальному прикладі "Робота лише в офісі, віддалено не розглядаємо",
// який спершу хибно класифікувався як 'remote' замість 'office'.
const NEGATION_WORDS = ["не ", "без ", "нема ", "немає ", "no ", "not "];
const NEGATION_LOOKAROUND = 20; // символів до/після маркера, де шукаємо заперечення
const CLAUSE_BOUNDARY = /[,.;!?\n]/; // заперечення в СУСІДНІЙ клаузі (через кому тощо) не рахується

// Обрізає вікно по першій межі клаузи (кома, крапка тощо), щоб заперечення з
// сусіднього, непов'язаного фрагмента речення не гасило маркер помилково —
// напр. у "робота лише в офісі, віддалено не розглядаємо" заперечення "не"
// стосується "віддалено" в іншій клаузі через кому, а не "офісі".
function clauseBoundedWindow(s: string, fromEnd: boolean): string {
  const boundaryIdx = fromEnd
    ? (() => {
        const m = [...s].reverse().join("").search(CLAUSE_BOUNDARY);
        return m === -1 ? -1 : s.length - m;
      })()
    : s.search(CLAUSE_BOUNDARY);
  if (fromEnd) return boundaryIdx === -1 ? s : s.slice(boundaryIdx);
  return boundaryIdx === -1 ? s : s.slice(0, boundaryIdx);
}

function hasMarker(text: string, markers: string[]): boolean {
  for (const marker of markers) {
    let idx = text.indexOf(marker);
    while (idx !== -1) {
      const rawBefore = text.slice(Math.max(0, idx - NEGATION_LOOKAROUND), idx);
      const rawAfter = text.slice(idx + marker.length, idx + marker.length + NEGATION_LOOKAROUND);
      const before = clauseBoundedWindow(rawBefore, true);
      const after = clauseBoundedWindow(rawAfter, false);
      const negated = NEGATION_WORDS.some((neg) => before.includes(neg) || after.includes(neg));
      if (!negated) return true;
      idx = text.indexOf(marker, idx + 1);
    }
  }
  return false;
}

/**
 * Евристична класифікація remote/office/hybrid для вакансій, які приходять
 * НЕ через парсер (ua_jobs_parser вже виставляє work_mode сам — див.
 * classify_work_mode у scrapers/base.py), а через чат: пряме посилання
 * (analyze_vacancy_link) чи вставлений текст (analyze_vacancy_text). Без
 * цього такі вакансії завжди мали б work_mode = null, і картка на фронті не
 * могла б показати бейдж — хоча текст вакансії найчастіше прямо про це каже.
 */
export function classifyWorkMode(title: string, description: string): WorkMode | null {
  const text = `${title}\n${description}`.toLowerCase();
  if (hasMarker(text, HYBRID_MARKERS)) return "hybrid";
  const hasRemote = hasMarker(text, REMOTE_MARKERS);
  const hasOfficeOnly = hasMarker(text, OFFICE_ONLY_MARKERS);
  if (hasOfficeOnly && !hasRemote) return "office";
  if (hasRemote) return "remote";
  return null;
}

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
           salary_min, salary_max, salary_currency, work_mode, matched_chunk, distance
    from (
      select distinct on (lower(title), coalesce(lower(company), ''))
        id, source, title, company, url, published_at, city,
        salary_min, salary_max, salary_currency, work_mode, matched_chunk, distance
      from (
        select id, source, title, company, url, published_at, city,
               salary_min, salary_max, salary_currency, work_mode, matched_chunk, distance
        from (
          select distinct on (v.id)
            v.id as id, v.source as source, v.title as title, v.company as company,
            v.url as url, v.published_at as published_at, v.city as city,
            v.salary_min as salary_min, v.salary_max as salary_max,
            v.salary_currency as salary_currency, v.work_mode as work_mode,
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

// pgvector `order by distance limit topK` ЗАВЖДИ повертає topK найближчих
// рядків, навіть якщо найближчі все одно нерелевантні — тому кількість
// результатів НЕ показник того, чи запит взагалі в межах того, що скрейпить
// парсер (напр. запит "hr" повертає 30 hr-подібних вакансій лише тому, що
// вони найближчі З ТОГО, ЩО Є в базі, а не тому, що дійсно релевантні).
// Натомість звіряємось з РЕАЛЬНИМ словником: vacancies.keyword — це
// ключові слова, якими watchdog.py фактично скрейпив (див.
// ua_jobs_parser/keywords.csv, дзеркало тут) — якщо жодне слово із запиту
// користувача не перетинається з цим словником, вакансій за темою запиту
// в базі закономірно нема/мало, і варто попередити про межі покриття.
let domainWordsCache: Set<string> | null = null;

async function getDomainWords(): Promise<Set<string>> {
  if (domainWordsCache) return domainWordsCache;
  const rows = await query<{ keyword: string | null }>(
    `select distinct keyword from vacancies where keyword is not null`,
  );
  const words = new Set<string>();
  for (const row of rows) {
    for (const w of (row.keyword ?? "").toLowerCase().split(/[^a-zа-яіїєґ0-9]+/i)) {
      // >=2, не >=3 — багато IT-акронімів рівно 2 літери (ai, ml, hr, bi,
      // qa, ux, pr) і губилися б повністю, зробивши "ai/ml" чи "hr" "поза
      // охопленням бази" попри те, що це реальні скрейплені ключі.
      if (w.length >= 2) words.add(w);
    }
  }
  domainWordsCache = words;
  return words;
}

export async function isQueryWithinScrapedScope(queryText: string): Promise<boolean> {
  const domainWords = await getDomainWords();
  if (!domainWords.size) return true; // словник ще порожній (свіжа база) — не блокуємо попередженням
  const queryWords = queryText
    .toLowerCase()
    .split(/[^a-zа-яіїєґ0-9]+/i)
    .filter((w) => w.length >= 2);
  return queryWords.some((qw) =>
    [...domainWords].some((dw) => dw === qw || dw.includes(qw) || qw.includes(dw)),
  );
}

export async function getVacancy(id: number): Promise<Vacancy | null> {
  const rows = await query<Vacancy>(
    `select id, source, title, company, description, url, published_at, city,
            salary_min, salary_max, salary_currency, work_mode
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
            salary_min, salary_max, salary_currency, work_mode
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
  const workMode = classifyWorkMode(page.title, page.text);
  const rows = await query<Vacancy>(
    `insert into vacancies (source, external_id, keyword, title, company, description, url, work_mode)
     values ('external_link', null, 'external_link', $1, null, $2, $3, $4)
     on conflict (url) do update set
       title = excluded.title,
       description = excluded.description,
       work_mode = excluded.work_mode,
       last_seen_at = now(),
       is_active = true
     returning id, source, title, company, description, url, published_at, city,
               salary_min, salary_max, salary_currency, work_mode`,
    [page.title.slice(0, 300), page.text, page.finalUrl, workMode],
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
  const workMode = classifyWorkMode(title, text);
  const rows = await query<Vacancy>(
    `insert into vacancies (source, external_id, keyword, title, company, description, url, work_mode)
     values ('pasted_text', null, 'pasted_text', $1, null, $2, $3, $4)
     returning id, source, title, company, description, url, published_at, city,
               salary_min, salary_max, salary_currency, work_mode`,
    [title.slice(0, 300), text.slice(0, 12000), syntheticUrl, workMode],
  );
  return rows[0];
}
