import { getOpenAI, CHAT_MODEL } from "./openai";
import { query } from "./db";
import { logTokenUsage } from "./tokenUsage";
import type { Vacancy, VacancyResult } from "./vacancies";

// Тот же промпт, что в ua_jobs_parser/generate.py (SYSTEM_PROMPT) — держим
// в синхроне вручную: логика одна и та же (grounding на резюме+вакансии),
// два места (CLI и веб), потому что веб-часть на TS/Vercel не может
// импортировать Python-модуль напрямую.
const SYSTEM_PROMPT =
  "Ти — асистент з пошуку роботи. Тобі дають текст резюме кандидата і текст " +
  "вакансії. Оціни, наскільки вакансія релевантна для кандидата, СПИРАЮЧИСЬ " +
  "ЛИШЕ на текст резюме та вакансії нижче — нічого не вигадуй про досвід " +
  "кандидата чи вимоги вакансії, якого там немає.\n\n" +
  "Відповідай ЛИШЕ JSON-об'єктом з ключами:\n" +
  '  "relevance": ціле число від 1 до 10 (10 — ідеальний збіг вимог і досвіду),\n' +
  '  "reasoning": 2-4 речення — чому саме така оцінка, з конкретними збігами ' +
  "чи розбіжностями (навички, роки досвіду, рівень позиції, домен),\n" +
  '  "cover_letter_sentences": масив РІВНО з 3 рядків — три варіанти першого ' +
  "речення cover letter для цієї вакансії, різними підходами (акцент на " +
  "релевантному досвіді; на мотивації/інтересі до компанії чи домену; на " +
  "конкретному проєкті або навичці, що напряму відповідає вимозі з вакансії). " +
  "Пиши тією ж мовою, що і текст вакансії.";

export type GenerationResult = {
  relevance: number;
  reasoning: string;
  coverLetterSentences: string[];
};

export async function scoreVacancy(
  resumeText: string,
  vacancy: Pick<Vacancy, "title" | "company" | "description">,
  userId?: string | null,
): Promise<GenerationResult> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `### Резюме кандидата\n${resumeText.trim()}\n\n` +
          `### Вакансія\nПосада: ${vacancy.title}\nКомпанія: ${vacancy.company ?? "—"}\n` +
          `Опис:\n${(vacancy.description ?? "").trim()}`,
      },
    ],
  });
  await logTokenUsage("score_vacancy", CHAT_MODEL, resp.usage, userId);

  const raw = resp.choices[0].message.content || "{}";
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`LLM вернула не-JSON: ${raw.slice(0, 200)}`);
  }

  const relevance = Math.max(1, Math.min(10, Number(data.relevance) || 1));
  const sentences = Array.isArray(data.cover_letter_sentences)
    ? data.cover_letter_sentences.slice(0, 3).map((s: unknown) => String(s).trim())
    : [];
  if (!sentences.length) {
    throw new Error(`LLM не вернула cover_letter_sentences: ${JSON.stringify(data)}`);
  }

  return { relevance, reasoning: String(data.reasoning || "").trim(), coverLetterSentences: sentences };
}

export async function saveGeneration(resumeId: number, vacancyId: number, result: GenerationResult): Promise<void> {
  await query(
    `insert into generations (resume_id, vacancy_id, model, relevance, reasoning, cover_letter_sentences)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (resume_id, vacancy_id) do update set
       model = excluded.model,
       relevance = excluded.relevance,
       reasoning = excluded.reasoning,
       cover_letter_sentences = excluded.cover_letter_sentences,
       created_at = now()`,
    [resumeId, vacancyId, CHAT_MODEL, result.relevance, result.reasoning, JSON.stringify(result.coverLetterSentences)],
  );
}

// Свободный вопрос про конкретную вакансию (в т.ч. присланную ссылкой) —
// grounding на её описание (+резюме, если оно загружено), без семантического
// поиска: тут уже известно, про какую именно вакансию спрашивают.
export async function answerAboutVacancy(
  vacancy: Pick<Vacancy, "title" | "company" | "description" | "url">,
  question: string,
  resumeText: string | null,
  userId?: string | null,
): Promise<string> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "Ти — асистент з пошуку роботи. Відповідай на питання користувача про конкретну вакансію, " +
          "спираючись ЛИШЕ на текст вакансії (і резюме кандидата нижче, якщо воно надане) — нічого не " +
          "вигадуй, чого там немає. Якщо в описі вакансії немає відповіді на питання — чесно скажи це. " +
          "Відповідай коротко (2-5 речень), українською.",
      },
      {
        role: "user",
        content:
          `### Вакансія\nПосада: ${vacancy.title}\nКомпанія: ${vacancy.company ?? "—"}\n` +
          `Опис:\n${(vacancy.description ?? "").trim()}\n\n` +
          (resumeText ? `### Резюме кандидата\n${resumeText.trim()}\n\n` : "") +
          `### Питання\n${question}`,
      },
    ],
  });
  await logTokenUsage("ask_about_vacancy", CHAT_MODEL, resp.usage, userId);
  return resp.choices[0].message.content?.trim() || "Не вдалось сформувати відповідь.";
}

// Векторний пошук (semanticSearch у vacancies.ts) знаходить N найближчих за
// cosine distance, БЕЗ жодного порогу релевантності — тому завжди повертає
// рівно topK записів, навіть якщо реально влучних менше, а решту місць
// займають слабкі збіги (наприклад, PHP Developer для Python/LLM-резюме —
// vector search ловить збіг за загальними словами "розробник", "API",
// "команда" тощо, хоча стек геть інший). Це другий прохід — LLM дивиться на
// повний текст резюме і список кандидатів та відкидає ті, що не підходять
// за стеком/рівнем/доменом, а не просто найближчі за embedding-відстанню.
export async function filterRelevantVacancies(
  resumeText: string,
  candidates: VacancyResult[],
  maxResults = 15,
  userId?: string | null,
): Promise<VacancyResult[]> {
  if (!candidates.length) return [];

  const openai = getOpenAI();
  const listing = candidates
    .map(
      (c) =>
        `id=${c.id} | ${c.title}${c.company ? ` — ${c.company}` : ""}\n` +
        `${c.matched_chunk.slice(0, 300).trim()}`,
    )
    .join("\n\n");

  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Ти — асистент з підбору вакансій. Тобі дають резюме кандидата і список вакансій-кандидатів, " +
          "знайдених семантичним (векторним) пошуком — серед них трапляються слабо релевантні: інший " +
          "стек технологій, інший рівень позиції (junior/senior) чи зовсім інший домен, які потрапили " +
          "в список лише через збіг загальних слів. Твоя задача — залишити ТІЛЬКИ ті вакансії, які " +
          "дійсно підходять кандидату за стеком технологій, рівнем позиції та доменом, судячи з тексту " +
          "резюме. Не бійся відкинути більшість — краще показати кілька влучних вакансій, ніж багато " +
          "випадкових.\n\n" +
          'Відповідай ЛИШЕ JSON {"relevant_ids": [id, id, ...]} — id вакансій, які варто показати, ' +
          "у порядку спадання релевантності (найкраща перша). Якщо жодна не підходить — порожній масив.",
      },
      {
        role: "user",
        content: `### Резюме кандидата\n${resumeText.slice(0, 6000)}\n\n### Вакансії-кандидати\n${listing}`,
      },
    ],
  });
  await logTokenUsage("relevance_filter", CHAT_MODEL, resp.usage, userId);

  const raw = resp.choices[0].message.content || "{}";
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    // LLM повернула не-JSON — не ламаємо пошук, показуємо як є (перші за
    // векторною відстанню), просто без додаткового відсіву.
    return candidates.slice(0, maxResults);
  }

  const ids: number[] = Array.isArray(data.relevant_ids) ? data.relevant_ids.map((x: unknown) => Number(x)) : [];
  // Number(c.id) навмисно — id з pg.query теоретично може прийти строкою
  // (bigint-колонки; глобально виправлено в lib/db.ts type parser'ом, але
  // ключі Map порівнюються строго, тож зайва підстраховка тут не завадить).
  const byId = new Map(candidates.map((c) => [Number(c.id), c]));
  const ranked = ids.map((id) => byId.get(id)).filter((c): c is VacancyResult => Boolean(c));
  return ranked.slice(0, maxResults);
}

export async function getResumeImprovementTips(
  resumeText: string,
  userId?: string | null,
): Promise<string[]> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.5,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Ти — кар'єрний консультант. Дай 4-6 конкретних порад, як покращити резюме " +
          "(структура, формулювання досягнень цифрами, навички, що варто додати/прибрати). " +
          'Відповідай ЛИШЕ JSON {"tips": ["...", ...]}, українською, без води.',
      },
      { role: "user", content: resumeText.slice(0, 12000) },
    ],
  });
  await logTokenUsage("resume_tips", CHAT_MODEL, resp.usage, userId);
  const raw = resp.choices[0].message.content || "{}";
  const data = JSON.parse(raw);
  return Array.isArray(data.tips) ? data.tips.map((t: unknown) => String(t).trim()) : [];
}
