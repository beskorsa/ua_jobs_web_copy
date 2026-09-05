export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { embedText } from "@/lib/openai";
import { semanticSearch, isQueryWithinScrapedScope } from "@/lib/vacancies";
import { filterRelevantVacanciesByQuery } from "@/lib/generate";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { checkRateLimit, rateLimitResponseBody } from "@/lib/rateLimit";
import { logSearchQuery } from "@/lib/searchLog";
import {
  touchKeyword,
  seedKeywordDictionary,
  recordKeywordAssociations,
  suggestLearnedExclusions,
} from "@/lib/keywords";

function cleanTerms(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    await seedKeywordDictionary();
    const userId = await getOrCreateUserId();

    const limit = await checkRateLimit(userId, "search", 20, 600); // 20 пошуків / 10 хв
    if (!limit.allowed) {
      return NextResponse.json(rateLimitResponseBody(limit.retryAfterSeconds, "пошукових запитів"), { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const topK: number = Number(body.topK) || 30;

    // Нові тег-інпути (ключові слова / мінус-слова, див. keywords.ts) —
    // пріоритетні; body.query лишається для зворотної сумісності (старі
    // клієнти, прямі виклики API).
    const keywords = cleanTerms(body.keywords);
    const minusKeywords = cleanTerms(body.minusKeywords);
    const legacyQuery = typeof body.query === "string" ? body.query.trim() : "";
    const queryText = keywords.length ? keywords.join(", ") : legacyQuery;

    if (!queryText) {
      return NextResponse.json({ error: "Порожній пошуковий запит" }, { status: 400 });
    }

    // Самонавчальна система (див. keywords.ts): для цих ключових слів —
    // які мінус-слова інші користувачі історично додавали разом з ними.
    // Рахуємо ДО пошуку, щоб одразу передати їх у semanticSearch як м'яку
    // пенальті в ранжуванні (не жорсткий фільтр — користувач їх сам не
    // вказав, тож вакансія лише опускається нижче, а не зникає).
    const learnedExclusions = keywords.length
      ? await suggestLearnedExclusions(keywords, minusKeywords, 5)
      : [];

    // Мінус-слова НЕ підмішуємо в текст для ембеддингу (це зіпсувало б сам
    // пошуковий вектор, притягуючи саме те, що треба виключити) — вони йдуть
    // окремим SQL-фільтром у semanticSearch.
    const [vec, inScope] = await Promise.all([
      embedText(queryText, "embed_search", userId),
      isQueryWithinScrapedScope(queryText),
    ]);
    // Поза словником скрейпленого — не показуємо semanticSearch: pgvector
    // все одно поверне topK "найближчих" рядків, навіть якщо жоден не
    // релевантний (limit завжди заповнюється), тож чесніше нічого не
    // показувати, ніж 30 випадкових вакансій поруч із попередженням.
    const rawResults = inScope
      ? await semanticSearch(vec, topK, minusKeywords, learnedExclusions)
      : [];
    // Другий прохід LLM (див. коментар у filterRelevantVacanciesByQuery) —
    // відсіює те, що потрапило в топ лише через збіг загальних слів у
    // векторі, а не за суттю запиту.
    const results = await filterRelevantVacanciesByQuery(queryText, rawResults, topK, userId);

    const logLabel = minusKeywords.length ? `${queryText} (-${minusKeywords.join(", -")})` : queryText;
    await logSearchQuery(userId, "search", logLabel, results.length);

    // Словник ключових слів росте тільки від реально застосованого пошуку
    // (не від кожного натискання клавіші в автопідказках) — нове слово
    // додається, відоме отримує +1 до популярності. recordKeywordAssociations
    // тут же накопичує пари (ключове, мінус) — це і є "навчання" системи:
    // наступного разу, коли хтось введе ці самі ключові слова, ці мінус-слова
    // спливуть як learnedExclusions вище.
    await Promise.all([
      ...keywords.map((k) => touchKeyword(k, "include")),
      ...minusKeywords.map((k) => touchKeyword(k, "exclude")),
      recordKeywordAssociations(keywords, minusKeywords),
    ]);

    return NextResponse.json({ results, suggestedMinusKeywords: learnedExclusions, inScope });
  } catch (e: any) {
    console.error("[api/search]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
