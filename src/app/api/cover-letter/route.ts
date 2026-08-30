export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getVacancy } from "@/lib/vacancies";
import { scoreVacancy, saveGeneration } from "@/lib/generate";
import { getResumeForUser } from "@/lib/resumes";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const { resumeId, vacancyId } = await req.json();
    if (!resumeId || !vacancyId) {
      return NextResponse.json({ error: "resumeId та vacancyId обов'язкові" }, { status: 400 });
    }

    // Обов'язково звіряємо user_id — інакше будь-хто міг підставити чужий
    // (перебираємий, bigint identity) resumeId і отримати cover letter,
    // згенерований з чужого резюме.
    const resume = await getResumeForUser(Number(resumeId), userId);
    if (!resume) {
      return NextResponse.json({ error: "Резюме не знайдено" }, { status: 404 });
    }
    const vacancy = await getVacancy(vacancyId);
    if (!vacancy) {
      return NextResponse.json({ error: "Вакансію не знайдено" }, { status: 404 });
    }

    const result = await scoreVacancy(resume.raw_text, vacancy, userId);
    await saveGeneration(resume.id, vacancyId, result);

    return NextResponse.json({ ...result, vacancy });
  } catch (e: any) {
    console.error("[api/cover-letter]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
