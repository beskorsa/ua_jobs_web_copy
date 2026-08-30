import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

// Регресійний тест на реальну IDOR-вразливість, знайдену під час аудиту
// безпеки: /api/cover-letter, /api/recommendations і /api/chat раніше
// довіряли resumeId, надісланому клієнтом, БЕЗ перевірки, що він належить
// саме цьому user_id. resumes.id — звичайний послідовний bigint (1, 2, 3...),
// тобто легко перебираємий: будь-хто міг підставити чужий resumeId і
// отримати cover letter/поради, згенеровані з чужого резюме (ПІБ, місця
// роботи тощо просочувались через відповідь LLM). Фікс — getResumeForUser()
// завжди фільтрує за user_id у самому SQL, і resolveOwnedResumeId()
// перевіряє власника ПЕРЕД тим, як довіряти клієнтському resumeId.
//
// db.ts тут підміняється мок-реалізацією query(), яка веде себе як реальна
// база (фільтрує за user_id у WHERE) — тест не б'є в живий Postgres,
// DATABASE_URL не потрібен.

type FakeResumeRow = { id: number; raw_text: string; user_id: string; uploaded_at: string };

const FAKE_RESUMES: FakeResumeRow[] = [
  { id: 1, raw_text: "resume of user A", user_id: "user-a", uploaded_at: "2026-08-20T00:00:00Z" },
  { id: 2, raw_text: "resume of user B (secret)", user_id: "user-b", uploaded_at: "2026-08-21T00:00:00Z" },
  { id: 3, raw_text: "second resume of user A", user_id: "user-a", uploaded_at: "2026-08-22T00:00:00Z" },
];

mock.module("../src/lib/db", {
  namedExports: {
    // Емуляція саме тих двох запитів, які реально виконує resumes.ts:
    // 1) "select id, raw_text from resumes where id = $1 and user_id = $2" (getResumeForUser)
    // 2) "select id from resumes where user_id = $1 order by uploaded_at desc limit 1" (getLatestResumeIdForUser)
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("where id = $1 and user_id = $2")) {
        const [id, userId] = params as [number, string];
        const row = FAKE_RESUMES.find((r) => r.id === id && r.user_id === userId);
        return row ? [{ id: row.id, raw_text: row.raw_text }] : [];
      }
      if (sql.includes("where user_id = $1 order by uploaded_at desc")) {
        const [userId] = params as [string];
        const rows = FAKE_RESUMES.filter((r) => r.user_id === userId).sort((a, b) =>
          b.uploaded_at.localeCompare(a.uploaded_at),
        );
        return rows.length ? [{ id: rows[0].id }] : [];
      }
      throw new Error(`unexpected SQL in test mock: ${sql}`);
    },
  },
});

// Динамічний import (не top-level await — esbuild/tsx у cjs-режимі його не
// підтримує) ПІСЛЯ mock.module() вище, щоб resumes.ts підхопив мок ./db.
let getResumeForUser: typeof import("../src/lib/resumes").getResumeForUser;
let resolveOwnedResumeId: typeof import("../src/lib/resumes").resolveOwnedResumeId;

before(async () => {
  const mod = await import("../src/lib/resumes");
  getResumeForUser = mod.getResumeForUser;
  resolveOwnedResumeId = mod.resolveOwnedResumeId;
});

test("getResumeForUser: returns the resume when it belongs to the requesting user", async () => {
  const row = await getResumeForUser(1, "user-a");
  assert.equal(row?.raw_text, "resume of user A");
});

test("getResumeForUser: returns null for someone else's resume id (IDOR guard)", async () => {
  // user-a намагається прочитати резюме user-b, підставивши id=2 напряму
  const row = await getResumeForUser(2, "user-a");
  assert.equal(row, null);
});

test("resolveOwnedResumeId: falls back to the caller's own latest resume when candidateId belongs to another user", async () => {
  // Це і є регресійний кейс самої вразливості: клієнт (React-стан на
  // сторінці) присилає resumeId=2 (чуже резюме) разом із запитом від
  // user-a. Раніше цей id довіряли напряму — тепер має повернутись власне
  // резюме user-a (id=3, найновіше), а НЕ чуже id=2.
  const resolved = await resolveOwnedResumeId("user-a", 2);
  assert.equal(resolved, 3);
  assert.notEqual(resolved, 2);
});

test("resolveOwnedResumeId: uses the candidateId as-is when it really belongs to the caller", async () => {
  const resolved = await resolveOwnedResumeId("user-a", 1);
  assert.equal(resolved, 1);
});

test("resolveOwnedResumeId: no candidateId -> latest own resume", async () => {
  const resolved = await resolveOwnedResumeId("user-b", undefined);
  assert.equal(resolved, 2);
});

test("resolveOwnedResumeId: user with no resumes at all -> null, not someone else's", async () => {
  const resolved = await resolveOwnedResumeId("user-with-no-resume", 1);
  assert.equal(resolved, null);
});
