export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getResumeImprovementTips } from "@/lib/generate";
import { getResumeForUser } from "@/lib/resumes";

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const { resumeId } = await req.json();
    if (!resumeId) {
      return NextResponse.json({ error: "resumeId обов'язковий" }, { status: 400 });
    }

    // Звіряємо user_id — без цього будь-хто міг підставити чужий resumeId і
    // отримати поради, згенеровані з чужого резюме (витік ПІБ/досвіду через
    // відповідь LLM).
    const resume = await getResumeForUser(Number(resumeId), userId);
    if (!resume) {
      return NextResponse.json({ error: "Резюме не знайдено" }, { status: 404 });
    }

    const tips = await getResumeImprovementTips(resume.raw_text, userId);
    return NextResponse.json({ tips });
  } catch (e: any) {
    console.error("[api/recommendations]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
