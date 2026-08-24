export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { embedText } from "@/lib/openai";
import { semanticSearch } from "@/lib/vacancies";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { checkRateLimit, rateLimitResponseBody } from "@/lib/rateLimit";
import { logSearchQuery } from "@/lib/searchLog";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const limit = await checkRateLimit(userId, "search", 20, 600); // 20 пошуків / 10 хв
    if (!limit.allowed) {
      return NextResponse.json(rateLimitResponseBody(limit.retryAfterSeconds), { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const q: unknown = body.query;
    const topK: number = Number(body.topK) || 30;

    if (typeof q !== "string" || !q.trim()) {
      return NextResponse.json({ error: "Порожній пошуковий запит" }, { status: 400 });
    }

    const vec = await embedText(q);
    const results = await semanticSearch(vec, topK);
    await logSearchQuery(userId, "search", q, results.length);
    return NextResponse.json({ results });
  } catch (e: any) {
    console.error("[api/search]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
