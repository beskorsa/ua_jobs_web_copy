export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getVacancy } from "@/lib/vacancies";
import { scoreVacancy, saveGeneration } from "@/lib/generate";
import { query } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const { resumeId, vacancyId } = await req.json();
    if (!resumeId || !vacancyId) {
      return NextResponse.json({ error: "resumeId та vacancyId обов'язкові" }, { status: 400 });
    }

    const resumeRows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [resumeId]);
    if (!resumeRows.length) {
      return NextResponse.json({ error: "Резюме не знайдено" }, { status: 404 });
    }
    const vacancy = await getVacancy(vacancyId);
    if (!vacancy) {
      return NextResponse.json({ error: "Вакансію не знайдено" }, { status: 404 });
    }

    const result = await scoreVacancy(resumeRows[0].raw_text, vacancy, userId);
    await saveGeneration(resumeId, vacancyId, result);

    return NextResponse.json({ ...result, vacancy });
  } catch (e: any) {
    console.error("[api/cover-letter]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
