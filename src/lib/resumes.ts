import pdfParse from "pdf-parse";
import { query } from "./db";
import { embedTexts, getOpenAI, CHAT_MODEL } from "./openai";
import { embedAsSingleVector } from "./chunk";
import { vecToPg, pgToVec } from "./vector";
import { semanticSearch, type VacancyResult } from "./vacancies";

export async function extractResumeText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text;
}

export async function summarizeResume(text: string): Promise<string> {
  const openai = getOpenAI();
  const resp = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "Стисло підсумуй резюме кандидата українською: ключові навички, роки досвіду, " +
          "домен, орієнтовний рівень (junior/middle/senior). 3-5 речень, без води, без привітань.",
      },
      { role: "user", content: text.slice(0, 12000) },
    ],
  });
  return resp.choices[0].message.content?.trim() || "";
}

export async function upsertResume(userId: string, filename: string, rawText: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `insert into resumes (filename, raw_text, user_id) values ($1, $2, $3) returning id`,
    [filename, rawText, userId],
  );
  return rows[0].id;
}

export async function storeResumeEmbedding(resumeId: number, text: string): Promise<void> {
  const vec = await embedAsSingleVector(text, embedTexts);
  await query(`delete from resume_sections where resume_id = $1`, [resumeId]);
  await query(
    `insert into resume_sections (resume_id, section, content, embedding) values ($1, 'full', $2, $3)`,
    [resumeId, text, vecToPg(vec)],
  );
}

export async function matchVacanciesForResume(resumeId: number, topK = 10): Promise<VacancyResult[]> {
  const rows = await query<{ embedding: string }>(
    `select embedding from resume_sections where resume_id = $1 and section = 'full'`,
    [resumeId],
  );
  if (!rows.length) {
    throw new Error(`У резюме id=${resumeId} нет эмбеддинга — сначала storeResumeEmbedding()`);
  }
  const vec = pgToVec(rows[0].embedding);
  return semanticSearch(vec, topK);
}
