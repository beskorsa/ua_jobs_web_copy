import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { query } from "./db";
import { embedTexts, getOpenAI, CHAT_MODEL } from "./openai";
import { logTokenUsage } from "./tokenUsage";
import { embedAsSingleVector } from "./chunk";
import { vecToPg, pgToVec } from "./vector";
import { semanticSearch, type VacancyResult } from "./vacancies";
import { extractTextViaOcr } from "./ocr";
import { filterRelevantVacancies } from "./generate";

export type ResumeFileType = "pdf" | "docx";

export const RESUME_MIME_TYPES: Record<string, ResumeFileType> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// Деякі браузери/ОС віддають generic "application/octet-stream" замість
// нормального mime — тоді орієнтуємось на розширення файлу.
export function resumeFileTypeFromName(name: string): ResumeFileType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  return null;
}

// Нижче цієї довжини вважаємо, що з файлу нічого корисного не витягнули
// (буває порожній рядок з кількох переносів рядка "\n\n\n") — і для PDF йдемо
// у фоллбек через OCR, а не одразу віддаємо помилку користувачу.
const MIN_EXTRACTED_TEXT_LENGTH = 20;

async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  const text = data.text ?? "";
  if (text.trim().length >= MIN_EXTRACTED_TEXT_LENGTH) {
    return text;
  }

  // pdf-parse не знайшов текстового шару — типовий випадок: резюме
  // збережене через браузерний "Друк у PDF" (Microsoft Print to PDF), де
  // сторінка перетворюється на контури/картинку без вбудованих шрифтів.
  // Замість "не вдалось розпізнати" одразу пробуємо OCR.
  try {
    const ocrText = await extractTextViaOcr(buffer);
    if (ocrText.trim().length >= MIN_EXTRACTED_TEXT_LENGTH) {
      return ocrText;
    }
    return text; // OCR теж нічого не дав — повертаємо як є, виклик вище покаже помилку
  } catch (e) {
    console.error("[resumes] OCR fallback failed", e);
    return text;
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer });
  return value ?? "";
}

export async function extractResumeText(buffer: Buffer, fileType: ResumeFileType): Promise<string> {
  if (fileType === "docx") {
    return extractDocxText(buffer);
  }
  return extractPdfText(buffer);
}

export async function summarizeResume(text: string, userId?: string | null): Promise<string> {
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
  await logTokenUsage("resume_summary", CHAT_MODEL, resp.usage, userId);
  return resp.choices[0].message.content?.trim() || "";
}

/**
 * Фоллбек для чата: resumeId там приходит от клиента (React-состояние на
 * странице) и теряется при перезагрузке страницы или если само завантаження
 * резюме на этот раз не удалось (например скан PDF без текстового шару —
 * тоді користувач бачить помилку і resumeId у нього просто немає). Раз
 * userId — стабильный httpOnly-cookie (см. lib/user.ts), а не React-стан,
 * можем подхватить последнее УСПІШНО завантажене резюме цього user_id з
 * бази замість того, щоб щоразу просити завантажити знову.
 */
export async function getLatestResumeIdForUser(userId: string): Promise<number | null> {
  const rows = await query<{ id: number }>(
    `select id from resumes where user_id = $1 order by uploaded_at desc limit 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export async function upsertResume(userId: string, filename: string, rawText: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `insert into resumes (filename, raw_text, user_id) values ($1, $2, $3) returning id`,
    [filename, rawText, userId],
  );
  return rows[0].id;
}

export async function storeResumeEmbedding(
  resumeId: number,
  text: string,
  userId?: string | null,
): Promise<void> {
  const vec = await embedAsSingleVector(text, (chunks) => embedTexts(chunks, "embed_resume", userId));
  await query(`delete from resume_sections where resume_id = $1`, [resumeId]);
  await query(
    `insert into resume_sections (resume_id, section, content, embedding) values ($1, 'full', $2, $3)`,
    [resumeId, text, vecToPg(vec)],
  );
}

export async function matchVacanciesForResume(
  resumeId: number,
  resumeText: string,
  topK = 15,
  userId?: string | null,
): Promise<VacancyResult[]> {
  const rows = await query<{ embedding: string }>(
    `select embedding from resume_sections where resume_id = $1 and section = 'full'`,
    [resumeId],
  );
  if (!rows.length) {
    throw new Error(`У резюме id=${resumeId} нет эмбеддинга — сначала storeResumeEmbedding()`);
  }
  const vec = pgToVec(rows[0].embedding);
  // Ширший пул кандидатів за векторною відстанню, ніж фінальна кількість —
  // щоб LLM-фільтру (filterRelevantVacancies) було з чого реально обирати,
  // а не просто підтверджувати перші topK.
  const poolSize = Math.max(topK * 3, 40);
  const candidates = await semanticSearch(vec, poolSize);
  return filterRelevantVacancies(resumeText, candidates, topK, userId);
}
