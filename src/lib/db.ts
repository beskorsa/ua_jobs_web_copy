import { Pool, types, type QueryResultRow } from "pg";

// pg по умолчанию отдаёт bigint (OID 20 — тип наших id-колонок, generated
// always as identity) как JS-строку, а не number — так driver защищается от
// потери точности за пределами Number.MAX_SAFE_INTEGER. У нас id — обычные
// автоинкременты, до этого предела им далеко, а вот от строкового id уже
// был реальный баг: filterRelevantVacancies (подбор вакансій під резюме)
// строил Map по id-строке и искал в ней Number(id) из ответа LLM — типы не
// совпадали, Map.get() ничего не находил, и результат був 0 вакансій
// щоразу, хоча звичайний пошук за тегами (без цього Map) працював. Парсимо
// bigint як number глобально, щоб такий клас багів не повторювався в інших
// місцях, де id порівнюються.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

// Один Pool на весь serverless-инстанс (переиспользуется между вызовами
// функции, пока инстанс тёплый) — так же, как get_connection() в Python-части,
// только там соединение открывается на каждый CLI-запуск, а тут держим пул.
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL не задан (см. .env.example)");
    }
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params);
  return res.rows;
}
