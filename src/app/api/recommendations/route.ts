export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getResumeImprovementTips } from "@/lib/generate";
import { query } from "@/lib/db";
import { checkRateLimit, rateLimitResponseBody } from "@/lib/rateLimit";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const limit = await checkRateLimit(userId, "recommendations", 15, 3600); // 15 / год
    if (!limit.allowed) {
      return NextResponse.json(rateLimitResponseBody(limit.retryAfterSeconds), { status: 429 });
    }

    const { resumeId } = await req.json();
    if (!resumeId) {
      return NextResponse.json({ error: "resumeId обов'язковий" }, { status: 400 });
    }

    const rows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [resumeId]);
    if (!rows.length) {
      return NextResponse.json({ error: "Резюме не знайдено" }, { status: 404 });
    }

    const tips = await getResumeImprovementTips(rows[0].raw_text);
    return NextResponse.json({ tips });
  } catch (e: any) {
    console.error("[api/recommendations]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
