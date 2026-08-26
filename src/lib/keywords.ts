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
