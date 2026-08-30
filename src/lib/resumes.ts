import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { createHash } from "crypto";
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

/**
 * Резюме за id, ЛИШЕ якщо воно належить цьому user_id. resumes.id — звичайний
 * bigint identity (1, 2, 3...), тобто легко перебираємий — раніше
 * /api/cover-letter, /api/recommendations і /api/chat читали raw_text за
 * будь-яким переданим клієнтом resumeId БЕЗ перевірки власника: будь-хто міг
 * підставити чужий resumeId і отримати cover letter/поради, згенеровані з
 * чужого резюме (ПІБ, місця роботи тощо просочувались через відповідь LLM).
 * Це — виправлення: єдина крапка доступу до тексту резюме за id.
 */
export async function getResumeForUser(
  resumeId: number,
  userId: string,
): Promise<{ id: number; raw_text: string } | null> {
  const rows = await query<{ id: number; raw_text: string }>(
    `select id, raw_text from resumes where id = $1 and user_id = $2`,
    [resumeId, userId],
  );
  return rows[0] ?? null;
}

/**
 * resumeId від клієнта (React-стан) довіряти не можна (див. getResumeForUser
 * вище) — перевіряємо, що він реально належить цьому user_id, і лише тоді
 * використовуємо; інакше (або якщо клієнт взагалі не передав resumeId)
 * підхоплюємо останнє власне резюме користувача з бази.
 */
export async function resolveOwnedResumeId(
  userId: string,
  candidateId?: number | null,
): Promise<number | null> {
  if (candidateId) {
    const owned = await getResumeForUser(candidateId, userId);
    if (owned) return owned.id;
  }
  return getLatestResumeIdForUser(userId);
}

// Нормалізуємо (тримаємо тільки суттєві пробіли) перед хешем, щоб той самий
// PDF, перезбережений/перезавантажений повторно (де можуть трохи розійтись
// невидимі пробіли/переноси рядків від pdf-parse), все одно впізнавався як
// той самий текст резюме.
export function hashResumeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Чи вже завантажував цей user_id резюме з таким самим текстом раніше —
 * щоб не платити знову за embedding і LLM-сумаризацію того самого файлу
 * (наприклад, коли людина випадково завантажує той самий PDF вдруге).
 */
export async function findResumeByUserAndHash(
  userId: string,
  contentHash: string,
): Promise<{ id: number; summary: string | null } | null> {
  const rows = await query<{ id: number; summary: string | null }>(
    `select id, summary from resumes where user_id = $1 and content_hash = $2 order by uploaded_at desc limit 1`,
    [userId, contentHash],
  );
  return rows[0] ?? null;
}

export async function upsertResume(
  userId: string,
  filename: string,
  rawText: string,
  contentHash: string,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `insert into resumes (filename, raw_text, user_id, content_hash) values ($1, $2, $3, $4) returning id`,
    [filename, rawText, userId, contentHash],
  );
  return rows[0].id;
}

export async function saveResumeSummary(resumeId: number, summary: string): Promise<void> {
  await query(`update resumes set summary = $1 where id = $2`, [summary, resumeId]);
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
