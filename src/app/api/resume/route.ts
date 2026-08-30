export const runtime = "nodejs";
// OCR-фоллбек (рендер сторінок + tesseract.js) для PDF без текстового шару
// може займати 5-15с на кожну сторінку — дефолтні 10с serverless-функції
// на Vercel цього не вистачить. Потрібен план/конфігурація, де maxDuration
// підтримується (Hobby з Fluid Compute — до 300с, або Pro).
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import {
  extractResumeText,
  looksLikeResume,
  summarizeResume,
  upsertResume,
  storeResumeEmbedding,
  matchVacanciesForResume,
  hashResumeText,
  findResumeByUserAndHash,
  saveResumeSummary,
  RESUME_MIME_TYPES,
  resumeFileTypeFromName,
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
    const fileType = RESUME_MIME_TYPES[file.type] ?? resumeFileTypeFromName(file.name);
    if (!fileType) {
      return NextResponse.json({ error: "Очікується PDF або DOCX" }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "Файл завеликий (максимум 10 МБ)" }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const text = await extractResumeText(buf, fileType);
    if (!text.trim()) {
      const reason =
        fileType === "pdf"
          ? "можливо, це скан без текстового шару, і навіть OCR не впорався"
          : "файл пошкоджений або порожній";
      return NextResponse.json(
        { error: `Не вдалось витягти текст з файлу — ${reason}` },
        { status: 422 },
      );
    }

    const contentHash = hashResumeText(text);

    // Той самий користувач вже завантажував саме цей текст резюме раніше —
    // не платимо повторно за embedding і LLM-сумаризацію, а просто
    // підбираємо вакансії заново (база вакансій оновлюється парсером, тож
    // цю частину має сенс освіжити) і кажемо, що резюме вже пам'ятаємо.
    const existing = await findResumeByUserAndHash(userId, contentHash);
    if (existing) {
      const results = await matchVacanciesForResume(existing.id, text, 15, userId);
      const summary = existing.summary ?? "";
      await logSearchQuery(userId, "resume", summary, results.length);
      return NextResponse.json({ resumeId: existing.id, summary, results, alreadyKnown: true });
    }

    // Дешева перевірка ПЕРЕД дорогою обробкою (embedding + сумаризація +
    // LLM-фільтр по десяткам вакансій) — щоб не палити токени на файл, який
    // виявився не резюме (вакансія, стаття, договір, не той файл узагалі).
    // Йде ПІСЛЯ перевірки на дублікат вище — для вже відомого резюме сенсу
    // перевіряти вдруге немає.
    const isResume = await looksLikeResume(text, userId);
    if (!isResume) {
      return NextResponse.json(
        {
          error:
            "Це не схоже на резюме — не бачу опису досвіду роботи, навичок чи освіти. " +
            "Завантажте файл із вашим CV/резюме (PDF або DOCX).",
        },
        { status: 422 },
      );
    }

    const resumeId = await upsertResume(userId, file.name, text, contentHash);
    await storeResumeEmbedding(resumeId, text, userId);

    const [summary, results] = await Promise.all([
      summarizeResume(text, userId),
      matchVacanciesForResume(resumeId, text, 15, userId),
    ]);
    await saveResumeSummary(resumeId, summary);

    await logSearchQuery(userId, "resume", summary, results.length);

    return NextResponse.json({ resumeId, summary, results, alreadyKnown: false });
  } catch (e: any) {
    console.error("[api/resume]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
