export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import {
  extractResumeText,
  summarizeResume,
  upsertResume,
  storeResumeEmbedding,
  matchVacanciesForResume,
} from "@/lib/resumes";
import { checkRateLimit, rateLimitResponseBody } from "@/lib/rateLimit";
import { logSearchQuery } from "@/lib/searchLog";

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 МБ — щедро для резюме, отсекает случайный не-тот файл

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const limit = await checkRateLimit(userId, "resume", 5, 3600); // 5 завантажень / год
    if (!limit.allowed) {
      return NextResponse.json(rateLimitResponseBody(limit.retryAfterSeconds, "завантаження резюме"), { status: 429 });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Файл не передано (поле 'file')" }, { status: 400 });
    }
    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: "Очікується PDF" }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "Файл завеликий (максимум 10 МБ)" }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const text = await extractResumeText(buf);
    if (!text.trim()) {
      return NextResponse.json(
        { error: "Не вдалось витягти текст з PDF — можливо, це скан без текстового шару (OCR не підтримується)" },
        { status: 422 },
      );
    }

    const resumeId = await upsertResume(userId, file.name, text);
    await storeResumeEmbedding(resumeId, text);

    const [summary, results] = await Promise.all([
      summarizeResume(text),
      matchVacanciesForResume(resumeId, 30),
    ]);

    await logSearchQuery(userId, "resume", summary, results.length);

    return NextResponse.json({ resumeId, summary, results });
  } catch (e: any) {
    console.error("[api/resume]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
