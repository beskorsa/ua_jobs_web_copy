export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getOpenAI, CHAT_MODEL, embedText } from "@/lib/openai";
import { semanticSearch, getVacancy, getVacancyByUrl, upsertExternalVacancy, upsertVacancyFromText } from "@/lib/vacancies";
import { scoreVacancy, saveGeneration, getResumeImprovementTips, answerAboutVacancy } from "@/lib/generate";
import { getLatestResumeIdForUser } from "@/lib/resumes";
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
  {
    type: "function",
    function: {
      name: "analyze_vacancy_link",
      description:
        "Користувач надіслав пряме посилання (URL) на вакансію (необов'язково з відомих сайтів) і хоче її " +
        "розібрати/проаналізувати. Завантажує сторінку, показує вакансію карткою і, якщо є завантажене " +
        "резюме, одразу оцінює релевантність.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL вакансії з повідомлення користувача" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_vacancy_text",
      description:
        "Користувач вставив у чат сам текст вакансії (скопійований з сайту вручну, наприклад коли " +
        "посилання не вдалось завантажити) — не URL, а безпосередньо опис вакансії. Зберігає вакансію " +
        "карткою і, якщо є завантажене резюме, одразу оцінює релевантність, як і analyze_vacancy_link.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Назва посади, якщо видно з тексту" },
          text: { type: "string", description: "Повний вставлений текст вакансії" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_about_vacancy",
      description:
        "Відповісти на довільне питання користувача про конкретну вакансію, яку вже показано у списку " +
        "(наприклад, розібрану за посиланням) — не пошук, не cover letter, а саме питання про зміст вакансії.",
      parameters: {
        type: "object",
        properties: {
          vacancyIndex: {
            type: "integer",
            description: "Номер вакансії у показаному списку карток, починаючи з 1",
          },
          question: { type: "string", description: "Питання користувача про цю вакансію" },
        },
        required: ["vacancyIndex", "question"],
      },
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
    const shownVacancies: ShownVacancy[] = Array.isArray(body.shownVacancies) ? body.shownVacancies : [];

    // resumeId от клієнта — це React-стан на сторінці: губиться при
    // перезавантаженні сторінки і не з'являється, якщо саме завантаження
    // PDF цього разу не вдалось. userId — стабільний cookie, тож якщо
    // клієнт не передав resumeId, підхоплюємо останнє успішно завантажене
    // резюме цього user_id з бази — це і є "пам'ять" між повідомленнями.
    const resumeId: number | undefined =
      body.resumeId || (await getLatestResumeIdForUser(userId)) || undefined;

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
            "списку; поради по резюме; якщо в повідомленні є URL — analyze_vacancy_link; якщо " +
            "повідомлення — це вставлений цілий текст вакансії без URL (довгий опис посади, вимог " +
            "тощо, а не пошуковий запит) — analyze_vacancy_text; питання про вже показану вакансію, " +
            "яке не є проханням про cover letter — ask_about_vacancy). Якщо " +
            "жоден інструмент не підходить (загальне питання, привітання, подяка) — просто відповідай " +
            "сам, коротко, українською, без інструменту.",
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
      } else if (toolCall.function.name === "analyze_vacancy_link") {
        const url = String(args.url || "").trim();
        const linkLimit = await checkRateLimit(userId, "vacancy_link", 10, 3600); // 10 посилань / год — важче за пошук
        if (!linkLimit.allowed) {
          reply = rateLimitResponseBody(linkLimit.retryAfterSeconds).error;
        } else if (!url) {
          reply = "Не бачу посилання — надішліть URL вакансії.";
        } else {
          try {
            // Спершу перевіряємо базу — якщо цю вакансію вже затягнув
            // нічний watchdog.py (work.ua/robota.ua/dou.ua/djinni.co тощо),
            // вона там вже лежить з повним описом і http-запит з сервера
            // взагалі не потрібен (а саме він ловить 403 від бот-захисту).
            const known = await getVacancyByUrl(url);
            const vacancy = known ?? (await upsertExternalVacancy(url));
            const fromDb = Boolean(known);
            payload = { action: "search", results: [vacancy] };
            if (resumeId) {
              const resumeRows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [
                resumeId,
              ]);
              if (resumeRows.length) {
                const result = await scoreVacancy(resumeRows[0].raw_text, vacancy);
                await saveGeneration(resumeId, vacancy.id, result);
                payload = { action: "cover_letter", results: [vacancy], coverLetter: result, vacancy };
                reply = `Розібрав вакансію «${vacancy.title}» — релевантність ${result.relevance}/10:`;
              } else {
                reply = `Розібрав вакансію «${vacancy.title}». Завантажте резюме, щоб оцінити відповідність.`;
              }
            } else {
              reply =
                `${fromDb ? "Знайшов цю вакансію в базі" : "Розібрав вакансію"} «${vacancy.title}». ` +
                "Завантажте резюме, щоб оцінити відповідність, або запитайте про неї що завгодно.";
            }
          } catch (e: any) {
            reply =
              `Не вдалось обробити посилання: ${e.message ?? String(e)}. ` +
              "Можете скопіювати текст вакансії і вставити його прямо сюди в чат.";
          }
        }
      } else if (toolCall.function.name === "analyze_vacancy_text") {
        const text = String(args.text || "").trim();
        const title = String(args.title || "").trim() || "Вакансія (вставлений текст)";
        const linkLimit = await checkRateLimit(userId, "vacancy_link", 10, 3600); // той самий бакет, що й лінки
        if (!linkLimit.allowed) {
          reply = rateLimitResponseBody(linkLimit.retryAfterSeconds).error;
        } else if (text.length < 50) {
          reply = "Текст вакансії закороткий — вставте повний опис.";
        } else {
          try {
            const vacancy = await upsertVacancyFromText(title, text);
            payload = { action: "search", results: [vacancy] };
            if (resumeId) {
              const resumeRows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [
                resumeId,
              ]);
              if (resumeRows.length) {
                const result = await scoreVacancy(resumeRows[0].raw_text, vacancy);
                await saveGeneration(resumeId, vacancy.id, result);
                payload = { action: "cover_letter", results: [vacancy], coverLetter: result, vacancy };
                reply = `Розібрав вакансію «${vacancy.title}» — релевантність ${result.relevance}/10:`;
              } else {
                reply = `Зберіг вакансію «${vacancy.title}». Завантажте резюме, щоб оцінити відповідність.`;
              }
            } else {
              reply =
                `Зберіг вакансію «${vacancy.title}». Завантажте резюме, щоб оцінити відповідність, ` +
                `або запитайте про неї що завгодно.`;
            }
          } catch (e: any) {
            reply = `Не вдалось зберегти вакансію: ${e.message ?? String(e)}`;
          }
        }
      } else if (toolCall.function.name === "ask_about_vacancy") {
        const idx = Number(args.vacancyIndex) - 1;
        const target = shownVacancies[idx];
        const question = String(args.question || message);
        if (!target) {
          reply = "Не бачу такої вакансії у показаному списку.";
        } else {
          const vacancy = await getVacancy(target.id);
          if (!vacancy) {
            reply = "Не вдалось знайти вакансію в базі.";
          } else {
            let resumeText: string | null = null;
            if (resumeId) {
              const rows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [
                resumeId,
              ]);
              resumeText = rows[0]?.raw_text ?? null;
            }
            reply = await answerAboutVacancy(vacancy, question, resumeText);
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
