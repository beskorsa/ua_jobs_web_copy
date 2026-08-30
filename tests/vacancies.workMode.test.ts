import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWorkMode } from "../src/lib/vacancies";

// Ці ж кейси (title/description -> очікуваний work_mode) продубльовані у
// ua_jobs_parser/tests/test_work_mode.py для classify_work_mode() — щоб
// список маркерів REMOTE/HYBRID/OFFICE_ONLY, який вручну підтримується
// синхронним у vacancies.ts і scrapers/base.py (TS і Python не діляться
// одним пакетом), не розійшовся непомітно. Якщо змінюєш маркери в одному
// файлі — онови й другий, і обидва тестові набори мають лишитись зеленими.
test("classifyWorkMode: remote", () => {
  assert.equal(classifyWorkMode("Python Developer", "Формат роботи: віддалено, повна зайнятість"), "remote");
  assert.equal(classifyWorkMode("Remote QA Engineer", "We are looking for a remote engineer, work from home"), "remote");
});

test("classifyWorkMode: office-only", () => {
  assert.equal(classifyWorkMode("Офіс-менеджер", "Робота лише в офісі, віддалено не розглядаємо"), "office");
  assert.equal(classifyWorkMode("Support Specialist", "Office only position, on-site only"), "office");
});

test("classifyWorkMode: hybrid takes priority over a nearby remote mention", () => {
  assert.equal(
    classifyWorkMode("Backend Developer", "Гібридний формат — 2 дні в офісі, решта віддалено"),
    "hybrid",
  );
});

test("classifyWorkMode: office-only marker ignored when remote is also mentioned nearby", () => {
  // Навіть якщо в тексті є явний office-only маркер ("робота лише в
  // офісі"), поруч згаданий "віддалено" повинен переважити — інакше
  // вакансії на кшталт "переважно офіс, але буває віддалено" хибно
  // класифікувались би як суворо 'office'.
  assert.equal(
    classifyWorkMode("Java Developer", "Робота лише в офісі, але можливо іноді віддалено"),
    "remote",
  );
});

test("classifyWorkMode: no markers -> null (unknown, not guessed)", () => {
  assert.equal(classifyWorkMode("Product Manager", "Шукаємо досвідченого PM у команду"), null);
});
