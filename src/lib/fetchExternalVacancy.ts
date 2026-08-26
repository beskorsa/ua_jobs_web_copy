// Пользователь может прислать в чат прямую ссылку на вакансию (с любого
// сайта, не только тех, что скрапит ua_jobs_parser). Тут — server-side
// fetch этой страницы + грубое извлечение текста из HTML, без внешних
// зависимостей (cheerio и т.п.) — regex-парсинг достаточно надёжен для
// вытаскивания читаемого текста из произвольной HTML-страницы вакансии.

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1", "metadata.google.internal"]);

// Грубая защита от SSRF: не даём дёргать внутренние/приватные адреса с
// сервера по ссылке, присланной анонимным пользователем.
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === "127.0.0.1" || h.endsWith(".localhost")) return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–");
}

function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

// Деякі посилання, які надсилають користувачі, — це не публічна вакансія, а
// приватна сторінка їхнього ж кабінету (моє резюме, профіль, дашборд тощо):
// work.ua/jobseeker/my/resumes/view/?id=... і подібні. Такі сторінки НЕ
// віддаються без логіну взагалі — жоден User-Agent-трюк це не обійде (на
// відміну від бот-захисту публічних сторінок вакансій, де 403 іноді можна
// обійти). Розпізнаємо за URL заздалегідь і одразу пояснюємо користувачу, що
// сталось, замість голого "сайт повернув 403" — саме так сталось, коли
// надіслали посилання на власне резюме work.ua замість вакансії.
const PRIVATE_ACCOUNT_PATH_HINTS = [
  /\/jobseeker\/my\//i,
  /\/employer\/my\//i,
  /\/my\/(resumes?|profile|account|cabinet|dashboard)/i,
  /\/(account|profile|dashboard|cabinet)\//i,
];

function looksLikePrivateAccountPage(url: URL): boolean {
  return PRIVATE_ACCOUNT_PATH_HINTS.some((re) => re.test(url.pathname));
}

// work.ua — окремий випадок: приватне посилання на власне резюме
// (/jobseeker/my/resumes/view/?id=NNN, видно лише залогіненому власнику)
// насправді має публічний відповідник — /resumes/NNN/ (та сама анкета,
// як її бачить роботодавець без входу в акаунт власника). Переписуємо URL
// на публічний ДО перевірки looksLikePrivateAccountPage, тож такі посилання
// не відхиляються, а обробляються як звичайна публічна сторінка.
function normalizeVacancyUrl(url: URL): URL {
  const isWorkUa = /(^|\.)work\.ua$/i.test(url.hostname);
  if (isWorkUa && /^\/jobseeker\/my\/resumes\/view\/?$/i.test(url.pathname)) {
    const id = url.searchParams.get("id");
    if (id && /^\d+$/.test(id)) {
      return new URL(`https://www.work.ua/resumes/${id}/`);
    }
  }
  return url;
}

export type FetchedVacancyPage = { title: string; text: string; finalUrl: string };

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_CHARS = 8000;

export async function fetchVacancyPage(rawUrl: string): Promise<FetchedVacancyPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Некоректне посилання");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Підтримуються лише http/https посилання");
  }
  url = normalizeVacancyUrl(url);
  if (isPrivateHostname(url.hostname)) {
    throw new Error("Це посилання недоступне");
  }
  if (looksLikePrivateAccountPage(url)) {
    throw new Error(
      "Схоже, це посилання на приватну сторінку особистого кабінету (потрібен вхід у ваш акаунт на сайті) — " +
        "сайт не віддасть її без логіну. Якщо хотіли, щоб я врахував ваше резюме, — завантажте його файлом " +
        "через кнопку «Завантажити резюме» вище. Якщо це мала бути вакансія — вставте публічне посилання на " +
        "саме оголошення (сторінка, яку видно без входу в акаунт).",
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Деякі сайти (work.ua тощо) віддають 403 будь-якому UA, що не
        // виглядає як звичайний браузер — кастомний бот-рядок і мінімум
        // заголовків тут не проходили. Видаємо себе за звичайний Chrome.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7",
      },
    });
  } catch (e: any) {
    throw new Error(e?.name === "AbortError" ? "Сторінка не відповіла вчасно" : `Не вдалось завантажити сторінку: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        `Сайт заблокував автоматичне завантаження сторінки (${res.status}). ` +
          "Спробуйте скопіювати текст вакансії вручну і надіслати його в чат.",
      );
    }
    throw new Error(`Сторінка повернула помилку ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("html") && !contentType.includes("text")) {
    throw new Error("Це посилання веде не на HTML-сторінку");
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error("Сторінка завелика для аналізу");
  }
  const html = Buffer.from(buf).toString("utf-8");

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : url.hostname;

  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (!text) {
    throw new Error("Не вдалось витягти текст зі сторінки");
  }

  return { title: title || url.hostname, text, finalUrl: res.url || url.toString() };
}
