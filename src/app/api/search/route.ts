export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { embedText } from "@/lib/openai";
import { semanticSearch } from "@/lib/vacancies";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    await getOrCreateUserId();

    const body = await req.json().catch(() => ({}));
    const q: unknown = body.query;
    const topK: number = Number(body.topK) || 10;

    if (typeof q !== "string" || !q.trim()) {
      return NextResponse.json({ error: "Порожній пошуковий запит" }, { status: 400 });
    }

    const vec = await embedText(q);
    const results = await semanticSearch(vec, topK);
    return NextResponse.json({ results });
  } catch (e: any) {
    console.error("[api/search]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
