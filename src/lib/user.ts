import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import { query } from "./db";

export const USER_COOKIE = "uid";
const ONE_YEAR_SEC = 60 * 60 * 24 * 365;

/**
 * Анонимный уникальный ID пользователя: UUID в httpOnly-cookie, без
 * регистрации. При первом запросе от браузера cookie ещё нет — создаём и
 * сразу же выставляем на ответ (Route Handler'ы в App Router, в отличие от
 * серверных компонентов страниц, могут писать cookies() прямо по ходу
 * обработки запроса — поэтому вызывать это нужно из API route, не из
 * page.tsx). Одноимённая строка кладётся и в web_users (для FK с resumes/
 * chat_messages), upsert идемпотентен.
 */
export async function getOrCreateUserId(): Promise<string> {
  const store = cookies();
  let uid = store.get(USER_COOKIE)?.value;
  if (!uid) {
    uid = randomUUID();
    store.set(USER_COOKIE, uid, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: ONE_YEAR_SEC,
      path: "/",
    });
  }
  await query(`insert into web_users (id) values ($1) on conflict (id) do nothing`, [uid]);
  return uid;
}
