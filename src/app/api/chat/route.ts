export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { ensureSchema } from "@/lib/schema";
import { getOrCreateUserId } from "@/lib/user";
import { getOpenAI, CHAT_MODEL, embedText } from "@/lib/openai";
import { logTokenUsage } from "@/lib/tokenUsage";
import {
  semanticSearch,
  getVacancy,
  getVacancyByUrl,
  storeExternalVacancy,
  upsertVacancyFromText,
  type Vacancy,
} from "@/lib/vacancies";
import { fetchVacancyPage } from "@/lib/fetchExternalVacancy";
import { scoreVacancy, saveGeneration, getResumeImprovementTips, answerAboutVacancy, classifyLinkContent } from "@/lib/generate";
import { resolveOwnedResumeId, ingestResumeText, cleanResumeText } from "@/lib/resumes";
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
      return NextResponse.json(rateLimitResponseBody(limit.retryAfterSeconds, "повідомлень у чаті"), { status: 429 });
    }

    const body = await req.json();
    const message: string = body.message;
    const shownVacancies: ShownVacancy[] = Array.isArray(body.shownVacancies) ? body.shownVacancies : [];

    // resumeId от клієнта — це React-стан на сторінці: губиться при
    // перезавантаженні сторінки і не з'являється, якщо саме завантаження
    // PDF цього разу не вдалось. userId — стабільний cookie, тож якщо
    // клієнт не передав resumeId, підхоплюємо останнє успішно завантажене
    // резюме цього user_id з бази — це і є "пам'ять" між повідомленнями.
    // resolveOwnedResumeId ОБОВ'ЯЗКОВО звіряє, що переданий клієнтом
    // resumeId належить саме цьому user_id (bigint id легко перебираємий —
    // без цієї перевірки будь-хто міг підставити чужий resumeId і отримати
    // cover letter/поради з чужого резюме).
    const resumeId: number | undefined =
      (await resolveOwnedResumeId(userId, body.resumeId ? Number(body.resumeId) : undefined)) ?? undefined;

    if (!message || !message.trim()) {
      return NextResponse.json({ error: "Порожнє повідомлення" }, { status: 400 });
    }

    // Історія чату цього user_id вже писалась в chat_messages, але ніколи
    // не читалась назад — саме тому чат "не пам'ятав" попередні репліки
    // (запитання на кшталт "розкажи про мої скіли" чи "ти пам'ятаєш моє
    // резюме?" отримували відповідь без жодного контексту). Підтягуємо
    // останні кілька повідомлень ДО того, як вставити нове — і в router, і
    // в загальну відповідь нижче.
    const HISTORY_LIMIT = 10;
    const historyRows = await query<{ role: string; content: string }>(
      `select role, content from chat_messages where user_id = $1 order by created_at desc limit $2`,
      [userId, HISTORY_LIMIT],
    );
    const history = historyRows
      .reverse()
      .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));

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
            "жоден інструмент не підходить (загальне питання, привітання, подяка, питання про власне " +
            "резюме користувача — навички, досвід, чи воно завантажене) — просто відповідай сам, " +
            "коротко, українською, без інструменту; на такі загальні питання нижче буде додано " +
            "окремий контекст із резюме.",
        },
        ...history,
        { role: "user", content: message },
      ],
    });
    await logTokenUsage("chat_router", CHAT_MODEL, routerResp.usage, userId);

    const choice = routerResp.choices[0];
    const toolCall = choice.message.tool_calls?.[0];

    let reply = "";
    let payload: Record<string, unknown> = {};

    if (!toolCall || toolCall.type !== "function") {
      // Жоден інструмент не підійшов — типово це загальне питання, зокрема
      // про власне резюме користувача ("розкажи про мої скіли", "ти
      // пам'ятаєш моє резюме?"). Router-виклик вище не бачив тексту резюме
      // взагалі (тільки tool-описи), тому без цього другого виклику він
      // завжди чесно відповідав "не маю доступу" — хоча резюме в базі є.
      const resumeRow = resumeId
        ? (await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [resumeId]))[0]
        : undefined;

      if (resumeRow?.raw_text) {
        const grounded = await openai.chat.completions.create({
          model: CHAT_MODEL,
          temperature: 0.3,
          messages: [
            {
              role: "system",
              content:
                "Ти — асистент пошуку роботи. У користувача є завантажене резюме — використовуй його " +
                "зміст, щоб відповідати на питання про навички, досвід, освіту тощо. Відповідай коротко " +
                "й по суті, українською.\n\nРЕЗЮМЕ КОРИСТУВАЧА:\n" +
                resumeRow.raw_text.slice(0, 8000),
            },
            ...history,
            { role: "user", content: message },
          ],
        });
        await logTokenUsage("chat_grounded_fallback", CHAT_MODEL, grounded.usage, userId);
        reply =
          grounded.choices[0].message.content?.trim() ||
          choice.message.content?.trim() ||
          "Не зовсім зрозумів запит — спробуйте переформулювати.";
      } else {
        reply = choice.message.content?.trim() || "Не зовсім зрозумів запит — спробуйте переформулювати.";
      }
    } else {
      const args = JSON.parse(toolCall.function.arguments || "{}");

      if (toolCall.function.name === "search_vacancies") {
        const q = String(args.query || message);
        const vec = await embedText(q, "embed_chat_search", userId);
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
            const result = await scoreVacancy(resumeRows[0].raw_text, vacancy, userId);
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
            const tips = await getResumeImprovementTips(rows[0].raw_text, userId);
            payload = { action: "recommendations", tips };
            reply = "Ось що можна покращити в резюме:";
          }
        }
      } else if (toolCall.function.name === "analyze_vacancy_link") {
        const url = String(args.url || "").trim();
        const linkLimit = await checkRateLimit(userId, "vacancy_link", 10, 3600); // 10 посилань / год — важче за пошук
        if (!linkLimit.allowed) {
          reply = rateLimitResponseBody(linkLimit.retryAfterSeconds, "аналіз вакансій за посиланням").error;
        } else if (!url) {
          reply = "Не бачу посилання — надішліть URL вакансії.";
        } else {
          try {
            // Спершу перевіряємо базу — якщо цю вакансію вже затягнув
            // нічний watchdog.py (work.ua/robota.ua/dou.ua/djinni.co тощо),
            // вона там вже лежить з повним описом і http-запит з сервера
            // взагалі не потрібен (а саме він ловить 403 від бот-захисту).
            const known = await getVacancyByUrl(url);
            let vacancy: Vacancy;
            let fromDb: boolean;
            if (known) {
              vacancy = known;
              fromDb = true;
            } else {
              // Люди плутають поле "посилання на вакансію" зі своїм резюме
              // (типовий приклад — публічна анкета work.ua/resumes/NNN/, вона
              // не приватна, тож fetchVacancyPage успішно її завантажить) —
              // або взагалі шлють щось стороннє (статтю, документацію тощо).
              // Без цієї перевірки будь-яке з них зберігалось би в vacancies
              // як ніби-вакансія і псувало базу/палило токени на scoreVacancy.
              const page = await fetchVacancyPage(url);
              const contentType = await classifyLinkContent(page.text, userId);

              if (contentType === "resume") {
                // Не просто відмовляємо — людина явно хотіла, щоб її резюме
                // врахували, просто прислала його лінком, а не файлом. Той
                // самий конвеєр, що і /api/resume: зберегти + підібрати
                // вакансії, а не змушувати завантажувати файл вручну.
                const cleanedText = await cleanResumeText(page.text, userId);
                const ingested = await ingestResumeText(userId, page.title || url, cleanedText);
                const intro = ingested.alreadyKnown
                  ? "Це резюме вже є в базі — ми його пам'ятаємо, повторно не обробляли."
                  : ingested.summary;
                reply = `${intro}\n\nПідібрав ${ingested.results.length} вакансій під це резюме.`;
                payload = { action: "search", results: ingested.results, resumeId: ingested.resumeId };
                await query(`insert into chat_messages (user_id, role, content) values ($1, 'assistant', $2)`, [
                  userId,
                  reply,
                ]);
                return NextResponse.json({ reply, ...payload });
              }
              if (contentType === "other") {
                reply =
                  "Це посилання не схоже на вакансію (і не на резюме) — сюди вставляйте посилання саме " +
                  "на оголошення про роботу.";
                await query(`insert into chat_messages (user_id, role, content) values ($1, 'assistant', $2)`, [
                  userId,
                  reply,
                ]);
                return NextResponse.json({ reply });
              }

              vacancy = await storeExternalVacancy(page);
              fromDb = false;
            }
            payload = { action: "search", results: [vacancy] };
            if (resumeId) {
              const resumeRows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [
                resumeId,
              ]);
              if (resumeRows.length) {
                const result = await scoreVacancy(resumeRows[0].raw_text, vacancy, userId);
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
          reply = rateLimitResponseBody(linkLimit.retryAfterSeconds, "аналіз вакансій за посиланням").error;
        } else if (text.length < 50) {
          reply = "Текст вакансії закороткий — вставте повний опис.";
        } else {
          try {
            // Той самий випадок, що і з посиланням: людина може вставити
            // сюди текст СВОГО резюме (чи щось стороннє) замість опису
            // вакансії. Перевіряємо ДО збереження в vacancies і ДО
            // scoreVacancy нижче.
            const contentType = await classifyLinkContent(text, userId);

            if (contentType === "resume") {
              // Так само, як з лінком: людина хотіла, щоб врахували резюме —
              // просто вставила текст замість завантаження файлу. Обробляємо
              // тим самим конвеєром, що і /api/resume.
              const cleanedText = await cleanResumeText(text, userId);
              const ingested = await ingestResumeText(userId, title, cleanedText);
              const intro = ingested.alreadyKnown
                ? "Це резюме вже є в базі — ми його пам'ятаємо, повторно не обробляли."
                : ingested.summary;
              reply = `${intro}\n\nПідібрав ${ingested.results.length} вакансій під це резюме.`;
              payload = { action: "search", results: ingested.results, resumeId: ingested.resumeId };
              await query(`insert into chat_messages (user_id, role, content) values ($1, 'assistant', $2)`, [
                userId,
                reply,
              ]);
              return NextResponse.json({ reply, ...payload });
            }
            if (contentType === "other") {
              reply = "Це не схоже на опис вакансії — вставте текст конкретного оголошення про роботу.";
              await query(`insert into chat_messages (user_id, role, content) values ($1, 'assistant', $2)`, [
                userId,
                reply,
              ]);
              return NextResponse.json({ reply });
            }

            const vacancy = await upsertVacancyFromText(title, text);
            payload = { action: "search", results: [vacancy] };
            if (resumeId) {
              const resumeRows = await query<{ raw_text: string }>(`select raw_text from resumes where id = $1`, [
                resumeId,
              ]);
              if (resumeRows.length) {
                const result = await scoreVacancy(resumeRows[0].raw_text, vacancy, userId);
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
            reply = await answerAboutVacancy(vacancy, question, resumeText, userId);
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
