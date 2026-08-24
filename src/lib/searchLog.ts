import { query } from "./db";

/**
 * Лог реальных запросов пользователей сайта (поиск по ключевым словам, поиск
 * из чата, факт загрузки резюме) — обратная связь для Python-парсера: он
 * читает эту таблицу (см. ua_jobs_parser/suggest_keywords.py) и предлагает,
 * какие ключевые слова добавить в keywords.csv, чтобы скрапинг покрывал то,
 * что реально ищут, а не только изначальный список.
 *
 * Не блокирует основной запрос при ошибке логирования — это вспомогательные
 * данные, поиск важнее.
 */
export type SearchSource = "search" | "chat" | "resume";

export async function logSearchQuery(
  userId: string,
  source: SearchSource,
  text: string,
  resultsCount: number | null,
): Promise<void> {
  try {
    await query(
      `insert into search_queries (user_id, source, query, results_count) values ($1, $2, $3, $4)`,
      [userId, source, text.slice(0, 500), resultsCount],
    );
  } catch (e) {
    console.error("[searchLog] failed to log query", e);
  }
}
