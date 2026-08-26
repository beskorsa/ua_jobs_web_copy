import { query } from "./db";

export type KeywordKind = "include" | "exclude";

// Автопідказки для тег-інпутів на головній сторінці (ключові слова /
// мінус-слова). "Словник" — не статичний файл, а таблиця search_keywords:
// росте органічно з кожного пошуку (touchKeyword) плюс одноразово засіяна
// реальними ключовими словами парсера (seedKeywordDictionary).
export async function suggestKeywords(
  prefix: string,
  kind: KeywordKind,
  limit = 8,
): Promise<string[]> {
  const p = prefix.trim();
  if (!p) {
    // Порожній префікс — топ найпопулярніших, щоб дропдаун не був пустим
    // одразу після кліку в поле.
    const rows = await query<{ term: string }>(
      `select term from search_keywords where kind = $1 order by usage_count desc, term asc limit $2`,
      [kind, limit],
    );
    return rows.map((r) => r.term);
  }
  const rows = await query<{ term: string }>(
    `select term from search_keywords
     where kind = $1 and term ilike $2 || '%'
     order by usage_count desc, term asc
     limit $3`,
    [kind, p, limit],
  );
  return rows.map((r) => r.term);
}

// Викликається при реальному застосуванні пошуку (не під час набору
// тексту) — нове слово додається в словник, вже відоме отримує +1 до
// usage_count, тож частіше вживані підказки спливають вище.
export async function touchKeyword(term: string, kind: KeywordKind): Promise<void> {
  const t = term.trim();
  if (!t) return;
  await query(
    `insert into search_keywords (term, kind, usage_count)
     values ($1, $2, 1)
     on conflict (lower(term), kind) do update set usage_count = search_keywords.usage_count + 1`,
    [t, kind],
  );
}

// Самонавчальна система релевантності: коли користувач в одному пошуку
// вказує і ключові, і мінус-слова, — це реальний сигнал "хто шукає X,
// той часто НЕ хоче Y" (наприклад, "python" + мінус "django" — шукає щось
// не веб-бекендне на python). Кожна пара (include, exclude) накопичує вагу
// в keyword_associations; чим частіше пара зустрічається в реальних
// пошуках різних користувачів, тим сильніший сигнал. Викликається з
// /api/search на кожен реальний пошук (не на кожне натискання клавіші) —
// база "навчається" безперервно, без окремого перенавчання.
export async function recordKeywordAssociations(
  includeTerms: string[],
  excludeTerms: string[],
): Promise<void> {
  const inc = includeTerms.map((t) => t.trim()).filter(Boolean);
  const exc = excludeTerms.map((t) => t.trim()).filter(Boolean);
  if (!inc.length || !exc.length) return;

  const pairs: Array<[string, string]> = [];
  for (const i of inc) {
    for (const e of exc) {
      if (i.toLowerCase() === e.toLowerCase()) continue; // те саме слово і в +, і в - — шуму не додаємо
      pairs.push([i, e]);
    }
  }
  await Promise.all(
    pairs.map(([includeTerm, excludeTerm]) =>
      query(
        `insert into keyword_associations (include_term, exclude_term, weight)
         values ($1, $2, 1)
         on conflict (lower(include_term), lower(exclude_term)) do update set
           weight = keyword_associations.weight + 1,
           updated_at = now()`,
        [includeTerm, excludeTerm],
      ),
    ),
  );
}

// Для поточних ключових слів пошуку — які мінус-слова історично найчастіше
// додавали разом з ними інші користувачі (а цей користувач ще не додав).
// Використовується двояко (див. api/search/route.ts): (1) як м'яка
// пенальті в ранжуванні semanticSearch — вакансії з цими термінами не
// відсіюються повністю, а лише опускаються нижче; (2) повертається на
// фронт як підказка "можливо, варто виключити" — користувач сам вирішує,
// додавати її в явний мінус-фільтр чи ні.
export async function suggestLearnedExclusions(
  includeTerms: string[],
  alreadyExcluded: string[],
  limit = 5,
): Promise<string[]> {
  const inc = includeTerms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!inc.length) return [];
  const excludedLower = new Set(alreadyExcluded.map((t) => t.trim().toLowerCase()).filter(Boolean));

  const rows = await query<{ exclude_term: string; total_weight: string }>(
    `select exclude_term, sum(weight)::int as total_weight
     from keyword_associations
     where lower(include_term) = any($1::text[])
     group by exclude_term
     order by total_weight desc
     limit $2`,
    [inc, limit + excludedLower.size + 5],
  );

  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of rows) {
    const key = row.exclude_term.toLowerCase();
    if (excludedLower.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(row.exclude_term);
    if (result.length >= limit) break;
  }
  return result;
}

let seeded = false;

// Одноразове (в межах життя процесу) заповнення словника реальними
// ключовими словами, якими парсер вже скрейпив вакансії (vacancies.keyword,
// див. ua_jobs_parser/keywords.csv) — це і є "список ключів з бази", а не
// вигаданий заново список. Ідемпотентно (ON CONFLICT), тож безпечно
// перевикликати.
export async function seedKeywordDictionary(): Promise<void> {
  if (seeded) return;
  seeded = true;
  const rows = await query<{ keyword: string; cnt: string }>(
    `select keyword, count(*)::int as cnt from vacancies group by keyword`,
  );
  for (const row of rows) {
    const term = row.keyword?.trim();
    if (!term) continue;
    await query(
      `insert into search_keywords (term, kind, usage_count)
       values ($1, 'include', $2)
       on conflict (lower(term), kind) do update set
         usage_count = greatest(search_keywords.usage_count, excluded.usage_count)`,
      [term, Number(row.cnt) || 1],
    );
  }
}
