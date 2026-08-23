import { Pool, type QueryResultRow } from "pg";

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
