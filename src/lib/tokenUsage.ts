import { query } from "./db";

// Тип запиту — навіщо саме витрачені токени. Кожна нова точка виклику
// OpenAI (embeddings чи chat.completions) повинна мати свій "kind" тут, а
// не переюзати чужий, — інакше звіт по типах перестає бути чесним.
export type TokenUsageKind =
  | "embed_search" // ембеддинг пошукового запиту (/api/search)
  | "embed_chat_search" // ембеддинг для search_vacancies-тула в чаті
  | "embed_resume" // ембеддинг тексту резюме після завантаження
  | "chat_router" // перший (маршрутизуючий) виклик у /api/chat — визначає tool
  | "chat_grounded_fallback" // другий виклик у /api/chat, коли жоден tool не підійшов і є резюме
  | "score_vacancy" // оцінка релевантності вакансії + cover letter (generate.ts)
  | "ask_about_vacancy" // вільне питання про конкретну вакансію
  | "relevance_filter" // LLM-відсів нерелевантних вакансій після векторного пошуку по резюме
  | "resume_tips" // поради по покращенню резюме
  | "resume_summary"; // короткий підсумок резюме одразу після завантаження

type UsageLike =
  | { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null }
  | null
  | undefined;

// Не блокуємо основний запит, якщо лог не записався (як і searchLog.ts) —
// це допоміжні дані для аналітики, а не критична частина відповіді юзеру.
export async function logTokenUsage(
  kind: TokenUsageKind,
  model: string,
  usage: UsageLike,
  userId?: string | null,
): Promise<void> {
  if (!usage) return;
  try {
    await query(
      `insert into token_usage (kind, model, prompt_tokens, completion_tokens, total_tokens, user_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        kind,
        model,
        usage.prompt_tokens ?? 0,
        usage.completion_tokens ?? 0,
        usage.total_tokens ?? 0,
        userId ?? null,
      ],
    );
  } catch (e) {
    console.error("[tokenUsage] failed to log usage", e);
  }
}

// Приблизні публічні ціни OpenAI за 1M токенів (input/output) — орієнтир
// для сторінки /admin/tokens, НЕ бухгалтерський розрахунок. OpenAI час від
// часу міняє прайс — онови вручну, якщо цифри розійдуться з реальним
// рахунком помітно. Модель, якої немає в таблиці, порахується як $0 (а не
// впаде помилкою) — краще занижена оцінка, ніж зламана сторінка.
const PRICING_PER_1M_USD: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICING_PER_1M_USD[model];
  if (!price) return 0;
  return (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output;
}

export type KindModelUsage = {
  kind: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type KindUsage = {
  kind: string;
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type DayUsage = { day: string; totalTokens: number };

export type UsageStats = {
  periodDays: number;
  byKindModel: KindModelUsage[];
  byKind: KindUsage[];
  byDay: DayUsage[];
  totals: { requests: number; totalTokens: number; estimatedCostUsd: number };
};

// periodDays = 0 означає "за весь час" — без фільтра по created_at.
export async function getUsageStats(periodDays = 30): Promise<UsageStats> {
  const whereClause = periodDays > 0 ? `where created_at >= now() - ($1::text || ' days')::interval` : "";
  const params = periodDays > 0 ? [periodDays] : [];

  const rows = await query<{
    kind: string;
    model: string;
    requests: string;
    prompt_tokens: string;
    completion_tokens: string;
    total_tokens: string;
  }>(
    `select kind, model, count(*)::bigint as requests,
            coalesce(sum(prompt_tokens),0)::bigint as prompt_tokens,
            coalesce(sum(completion_tokens),0)::bigint as completion_tokens,
            coalesce(sum(total_tokens),0)::bigint as total_tokens
     from token_usage
     ${whereClause}
     group by kind, model
     order by total_tokens desc`,
    params,
  );

  const byKindModel: KindModelUsage[] = rows.map((r) => {
    const promptTokens = Number(r.prompt_tokens);
    const completionTokens = Number(r.completion_tokens);
    return {
      kind: r.kind,
      model: r.model,
      requests: Number(r.requests),
      promptTokens,
      completionTokens,
      totalTokens: Number(r.total_tokens),
      estimatedCostUsd: estimateCostUsd(r.model, promptTokens, completionTokens),
    };
  });

  const byKindMap = new Map<string, KindUsage>();
  for (const r of byKindModel) {
    const acc = byKindMap.get(r.kind) ?? { kind: r.kind, requests: 0, totalTokens: 0, estimatedCostUsd: 0 };
    acc.requests += r.requests;
    acc.totalTokens += r.totalTokens;
    acc.estimatedCostUsd += r.estimatedCostUsd;
    byKindMap.set(r.kind, acc);
  }
  const byKind = Array.from(byKindMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);

  const dayRows = await query<{ day: string; total_tokens: string }>(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
            coalesce(sum(total_tokens),0)::bigint as total_tokens
     from token_usage
     ${whereClause}
     group by day
     order by day asc`,
    params,
  );
  const byDay = dayRows.map((r) => ({ day: r.day, totalTokens: Number(r.total_tokens) }));

  const totals = byKind.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      totalTokens: acc.totalTokens + r.totalTokens,
      estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd,
    }),
    { requests: 0, totalTokens: 0, estimatedCostUsd: 0 },
  );

  return { periodDays, byKindModel, byKind, byDay, totals };
}
