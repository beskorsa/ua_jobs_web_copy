import { test } from "node:test";
import assert from "node:assert/strict";
import { types } from "pg";

// Просто імпортуємо db.ts заради побічного ефекту (types.setTypeParser) —
// саме цей побічний ефект і є регресійним захистом. Виклик getPool()/query()
// тут НЕ потрібен — тест не вимагає DATABASE_URL і не чіпає мережу.
import "../src/lib/db";

// Регресійний тест на реальний баг з продакшена: pg за замовчуванням віддає
// bigint (OID 20 — тип наших id-колонок) як JS-рядок, а не number. Через це
// filterRelevantVacancies() будував Map<number, Vacancy> за id з бази, а
// шукав у ній Number(id), який прийшов з JSON-відповіді LLM — типи не
// збігались (рядок "42" !== число 42 як ключ Map), Map.get() завжди
// повертав undefined, і результат був "Підібрав 0 вакансій" щоразу. Фікс —
// глобальний types.setTypeParser(20, ...) у db.ts. Якщо цей рядок колись
// приберуть чи зламають рефакторингом — цей тест має впасти.
test("bigint (OID 20) parsed as JS number, not string", () => {
  const parse = types.getTypeParser(20 as unknown as number);
  const result = parse("123456789");
  assert.equal(typeof result, "number");
  assert.equal(result, 123456789);
});

test("parsed bigint id matches Number() from LLM tool-call JSON — regression for the '0 вакансій' bug", () => {
  const parse = types.getTypeParser(20 as unknown as number);
  // Як id повертається з бази ПІСЛЯ нашого типового парсера (рядок з SQL-драйвера -> number)
  const dbId = parse("42");
  // Як id приходить з JSON, який згенерувала LLM у tool-call (завжди рядок або число з JSON.parse)
  const llmProvidedId = Number("42");

  const byId = new Map([[dbId, { title: "AI Automation Specialist" }]]);
  assert.equal(byId.get(llmProvidedId)?.title, "AI Automation Specialist");
});
