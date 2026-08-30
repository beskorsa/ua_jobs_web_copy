import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBypassUserIds } from "../src/lib/rateLimit";

// Регресійний тест на реальний security-інцидент: раніше персональний
// bypass rate-limit'у був хардкод-uid прямо в коді (публічний git-репозиторій
// -> будь-хто міг виставити собі таку саму cookie і отримати безлімітний
// доступ до OpenAI-викликів за чужий рахунок). Фікс — значення виключно з
// ADMIN_BYPASS_USER_IDS env var. Цей тест не про env як такий (той факт, що
// значення береться з process.env, і так очевидний з коду) — а про те, щоб
// парсинг списку (пробіли, порожні елементи, зайві коми) поводився
// передбачувано, і про те, щоб порожнє/невизначене значення НЕ давало
// bypass "усім" (порожній рядок після split(",") міг би дати Set{""},
// що match'илось б з чимось хибним, якби userId теж був порожнім рядком).
test("parseBypassUserIds: empty/undefined input never yields a bypass for an empty userId", () => {
  assert.equal(parseBypassUserIds(undefined).has(""), false);
  assert.equal(parseBypassUserIds("").has(""), false);
});

test("parseBypassUserIds: parses comma-separated ids, trims whitespace", () => {
  const set = parseBypassUserIds(" uid-1 , uid-2,uid-3 ");
  assert.deepEqual([...set].sort(), ["uid-1", "uid-2", "uid-3"]);
});

test("parseBypassUserIds: ignores stray commas / empty segments", () => {
  const set = parseBypassUserIds("uid-1,,uid-2,");
  assert.deepEqual([...set].sort(), ["uid-1", "uid-2"]);
});

test("parseBypassUserIds: a random/guessed uid is not in the bypass set by default", () => {
  const set = parseBypassUserIds("7f4da38d-ecfc-4049-bb5c-695c69c829af");
  assert.equal(set.has("some-other-random-uuid"), false);
});
