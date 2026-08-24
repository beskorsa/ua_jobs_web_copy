export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getOpenAI, CHAT_MODEL, embedText } from "@/lib/openai";
import { semanticSearch, getVacancy } from "@/lib/vacancies";
import { scoreVacancy, saveGeneration, getResumeImprovementTips } from "@/lib/generate";
import { query } from "@/lib/db";
import { checkRateLimit, rateLimitResponseBody } from "@/lib/rateLimit";
import { logSearchQuery } from "@/lib/searchLog";

// Интерактивный чат — единая точка входа для всех 4 сценариев с главной
// страницы: (1) поиск за ключовими словами, (2) — сам факт завантаження
// резюме обробляється окремим /api/resume (файл, не текст чату), а от
// текстовий запит "підбери вакансії під моє резюме" тут теж підтримано
// через search — (3) cover letter по вакансії зі списку, (4) поради по
// резюме. Маршрутизація — через OpenAI tool calling: модель сама вирішує,
// який інструмент викликати (або жоден — просто відповідає).
const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_vacancies",
      description:
        "Знайти вакансії за ключовими словами чи критеріями (посада, стек, місто, зарплата, remote/офіс).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Пошуковий запит природною мовою" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cover_letter",
      description:
        "Згенерувати варіанти cover letter (супровідного листа) для конкретної вакансії зі списку, який вже показано користувачу. Потребує завантаженого резюме.",
      parameters: {
        type: "object",
        properties: {
          vacancyIndex: {
            type: "integer",
            description: "Номер вакансії у показаному списку карток, починаючи з 1",
          },
        },
        required: ["vacancyIndex"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_recommendations",
      description: "Дати конкретні поради, як покращити завантажене резюме користувача.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type ShownVacancy = { id: number; title: string };

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const userId = await getOrCreateUserId();

    const limit = await checkRateLimit(userId, "chat", 20, 600); // 20 повідомлень / 10 хв
    if (!limit.allowed) {
      return NextResponse.json(rateLimitResponseBody(limit.retryAfterSeconds), { status: 429 });
    }

    const body = await req.json();
    const message: string = body.message;
    const resumeId: number | undefined = body.resumeId || undefined;
    const shownVacancies: ShownVacancy[] = Array.isArray(body.shownVacancies) ? body.shownVacancies : [];

    if (!message || !message.trim()) {
      return NextResponse.json({ error: "Порожнє повідомлення" }, { status: 400 });
    }

    await query(`insert into chat_messages (user_id, role, content) values ($1, 'user', $2)`, [userId, message]);

    const openai = getOpenAI();
    const routerResp = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      tools: TOOLS,
      tool_choice: "auto",
      messages: [
        {
          role: "system",
          content:
            "Ти — асистент пошуку роботи на українському сайті. Визнач намір користувача і виклич " +
            "відповідний інструмент, якщо це доречно (пошук вакансій; cover letter для вакансії зі " +
            "списку; поради по резюме). Якщо жоден інструмент не підходить (загальне питання, " +
            "привітання, подяка) — просто відповідай сам, коротко, українською, без інструменту.",
        },
        { role: "user", content: message },
      ],
    });

    const choice = routerResp.choices[0];
    const toolCall = choice.message.tool_calls?.[0];

    let reply = "";
    let payload: Record<string, unknown> = {};

    if (!toolCall || toolCall.type !== "function") {
      reply = choice.message.content?.trim() || "Не зовсім зрозумів запит — спробуйте переформулювати.";
    } else {
      const args = JSON.parse(toolCall.function.arguments || "{}");

      if (toolCall.function.name === "search_vacancies") {
        const q = String(args.query || message);
        const vec = await embedText(q);
        const results = await semanticSearch(vec, 30);
        await logSearchQuery(userId, "chat", q, results.length);
        payload = { action: "search", results };
        reply = results.length
          ? `Знайшов ${results.length} вакансій за запитом «${q}».`
          : `Нічого не знайшов за запитом «${q}» — спробуйте інші ключові слова.`;
      } else if (toolCall.function.name === "cover_letter") {
        const idx = Number(args.vacancyIndex) - 1;
        const target = shownVacancies[idx];
        if (!resumeId) {
          reply = "Спершу завантажте резюме (PDF) — без нього cover letter писати нема з чого.";
        } else if (!target) {
          reply = "Не бачу такої вакансії у показаному списку — спочатку знайдіть вакансії пошуком.";
        } else {
          const resumeRows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [
            resumeId,
          ]);
          const vacancy = await getVacancy(target.id);
          if (!resumeRows.length || !vacancy) {
            reply = "Не вдалось знайти резюме або вакансію в базі.";
          } else {
            const result = await scoreVacancy(resumeRows[0].raw_text, vacancy);
            await saveGeneration(resumeId, target.id, result);
            payload = { action: "cover_letter", coverLetter: result, vacancy };
            reply = `Ось варіанти cover letter для «${vacancy.title}» (релевантність ${result.relevance}/10):`;
          }
        }
      } else if (toolCall.function.name === "resume_recommendations") {
        if (!resumeId) {
          reply = "Спершу завантажте резюме (PDF) — тоді дам конкретні поради.";
        } else {
          const rows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [resumeId]);
          if (!rows.length) {
            reply = "Резюме не знайдено в базі.";
          } else {
            const tips = await getResumeImprovementTips(rows[0].raw_text);
            payload = { action: "recommendations", tips };
            reply = "Ось що можна покращити в резюме:";
          }
        }
      }
    }

    await query(`insert into chat_messages (user_id, role, content) values ($1, 'assistant', $2)`, [userId, reply]);

    return NextResponse.json({ reply, ...payload });
  } catch (e: any) {
    console.error("[api/chat]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
