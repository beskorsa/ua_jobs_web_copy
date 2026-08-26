import { query } from "./db";

/**
 * Простой rate-limit на анонимный uuid пользователя (см. user.ts) — без
 * Redis/KV, просто таблица в той же Postgres-базе (rate_limit_hits, см.
 * schema.ts). Для MVP-трафика этого достаточно: одна лишняя строка/запрос —
 * не проблема, а от бесполезного спама (сотни поисков подряд, накрутка
 * OpenAI-счёта) защищает.
 *
 * bucket — отдельный лимит на вид запроса (поиск дешевле, чем загрузка
 * резюме или чат, поэтому у каждого свой bucket/лимит, см. вызовы в
 * api/*\/route.ts).
 */
export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

// Персональный обхід лімітів для власного тестування (Ліза) — без нього
// кожен ручний тест (аплоад резюме, повторні запити в чат) з'їдає той самий
// бюджет, що і в реальних користувачів, і швидко впирається в 429.
// Значення — anonymous uid з httpOnly-cookie (див. lib/user.ts, DevTools →
// Application → Cookies → uid). Це не секрет (просто випадковий UUID без
// прав), тому зберігати його прямо в коді нормально.
const RATE_LIMIT_BYPASS_USER_IDS = new Set<string>([
  "7f4da38d-ecfc-4049-bb5c-695c69c829af",
]);

export async function checkRateLimit(
  userId: string,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (RATE_LIMIT_BYPASS_USER_IDS.has(userId)) {
    return { allowed: true };
  }

  const rows = await query<{ count: string; oldest: string | null }>(
    `select count(*)::int as count, min(created_at) as oldest
     from rate_limit_hits
     where user_id = $1 and bucket = $2 and created_at > now() - ($3 || ' seconds')::interval`,
    [userId, bucket, windowSeconds],
  );
  const count = Number(rows[0]?.count ?? 0);

  if (count >= limit) {
    const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : Date.now();
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowSeconds * 1000 - Date.now()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  await query(`insert into rate_limit_hits (user_id, bucket) values ($1, $2)`, [userId, bucket]);

  // Лёгкая пробная очистка старья (не под каждый запрос — иначе лишняя
  // нагрузка): без крон-джобы таблица иначе растёт бесконечно. 1 шанс из
  // ~200 запросов достаточно, чтобы не дать ей разрастись без дополнительной
  // инфраструктуры.
  if (Math.random() < 0.005) {
    await query(`delete from rate_limit_hits where created_at < now() - interval '2 days'`);
  }

  return { allowed: true };
}

export function rateLimitResponseBody(retryAfterSeconds: number, subject?: string) {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  const what = subject ? `ліміт (${subject})` : "ліміт запитів";
  return {
    error:
      minutes <= 1
        ? `Ви вичерпали ${what} — спробуйте ще раз за хвилину.`
        : `Ви вичерпали ${what} — спробуйте ще раз через ${minutes} хв.`,
  };
}
