// Пользователь может прислать в чат прямую ссылку на вакансию (с любого
// сайта, не только тех, что скрапит ua_jobs_parser). Тут — server-side
// fetch этой страницы + грубое извлечение текста из HTML, без внешних
// зависимостей (cheerio и т.п.) — regex-парсинг достаточно надёжен для
// вытаскивания читаемого текста из произвольной HTML-страницы вакансии.

import { Agent } from "undici";
import { lookup as dnsLookup, type LookupOptions } from "node:dns";
import { promisify } from "node:util";
import net from "node:net";

const dnsLookupAsync = promisify(dnsLookup);

const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "::1", "metadata.google.internal"]);

function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // сюди ж потрапляє cloud metadata (169.254.169.254)
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // fe80::/10
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7, unique local
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // невідомий формат — краще відмовити, ніж пропустити
}

// Груба перевірка hostname (без DNS) — швидко відсіює очевидне (localhost,
// літеральний приватний IP в самому посиланні) ще ДО мережевого запиту.
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === "127.0.0.1" || h.endsWith(".localhost")) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return false;
}

// Справжній захист від SSRF/DNS rebinding: hostname-перевірка вище
// перевіряє лише те, що написано в посиланні, а не те, куди воно РЕАЛЬНО
// резолвиться — зловмисник може зареєструвати публічний домен, DNS якого
// повертає приватну/metadata-адресу (169.254.169.254 тощо), і hostname-
// перевірка це пропустить. Крім того, fetch() робить власний DNS lookup
// у момент з'єднання — окрема перевірка "резолвнули, перевірили, потім
// зробили fetch" має вікно (TOCTOU): DNS може віддати іншу адресу другим
// запитом. Тому підміняємо сам lookup, який undici використовує ПІД ЧАС
// з'єднання (включно з кожним редіректом — свій lookup на кожен хоп): яку
// адресу перевірили, до тієї й підключаємось, без розриву в часі.
function ssrfSafeLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true } as LookupOptions & { all: true }, (err, addresses) => {
    if (err) return callback(err, [] as any);
    const list = addresses as unknown as { address: string; family: number }[];
    const safe = list.filter((a) => !isPrivateIp(a.address));
    if (!safe.length) {
      callback(new Error(`SSRF protection: "${hostname}" resolves only to disallowed addresses`), [] as any);
      return;
    }
    callback(null, safe as any);
  });
}

const ssrfSafeDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });

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
const BROWSER_TIMEOUT_MS = 20_000;

// Той самий SSRF-захист, що й для fetch() (isPrivateHostname/ssrfSafeLookup),
// але для Playwright — окрема перевірка, бо браузер не дає підмінити lookup
// на кожен hop, як undici. TOCTOU-вікно тут ширше (DNS резолвиться тут, а
// підключається сама сторінка Chromium трохи пізніше) — прийнятно для
// внутрішнього інструменту з rate-limit, але не для довільного untrusted-
// трафіку. Кидає, якщо жодна резолвнута адреса не є публічною.
async function assertHostnameResolvesPublicly(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("SSRF protection");
    return;
  }
  const addresses = await dnsLookupAsync(hostname, { all: true });
  const list = addresses as unknown as { address: string; family: number }[];
  if (!list.length || list.every((a) => isPrivateIp(a.address))) {
    throw new Error("SSRF protection");
  }
}

// Фолбек, коли звичайний fetch() ловить 403/429 (бот-захист по заголовках/
// TLS-фінгерпринту) — той самий випадок, який ua_jobs_parser (Playwright,
// справжній Chromium) читає без проблем: реальний браузер виконує JS,
// проходить Cloudflare-челлендж і має TLS-відбиток звичайного Chrome, чого
// підробленими заголовками в голому HTTP-запиті не досягти. Використовується
// ЛИШЕ як другий рубіж (fetchVacancyPage викликає це сам після 403/429) —
// піднімати Chromium на кожен лінк дорожче й повільніше за звичайний fetch.
async function fetchViaBrowser(url: URL): Promise<FetchedVacancyPage> {
  await assertHostnameResolvesPublicly(url.hostname);

  // Динамічний import — playwright важкий (сам пакет + бінарник Chromium),
  // не тягнемо його в кожен серверless-бандл модуля заради шляху, який
  // спрацьовує лише як фолбек на 403.
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "uk-UA",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
    // Даємо час можливому Cloudflare/JS-челленджу відпрацювати й
    // перенаправити на справжню сторінку, перш ніж читати контент.
    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    const title = decodeEntities((await page.title()) || url.hostname).trim();
    const html = await page.content();
    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    if (!text) {
      throw new Error("Не вдалось витягти текст зі сторінки");
    }
    return { title: title || url.hostname, text, finalUrl: finalUrl || url.toString() };
  } finally {
    await browser.close();
  }
}

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
      // @ts-expect-error dispatcher — undici-специфічна опція, відсутня в
      // стандартному DOM-типі RequestInit, але підтримується Node-реалізацією
      // fetch (built on undici). Саме через неї підмінюється DNS lookup.
      dispatcher: ssrfSafeDispatcher,
      headers: {
        // Деякі сайти (work.ua тощо) віддають 403 будь-якому UA, що не
        // виглядає як звичайний браузер. Одного лише User-Agent виявилось
        // замало (403 лишався) — бот-захист дивиться на набір заголовків
        // разом (sec-ch-ua/Sec-Fetch-*/Referer теж перевіряються, справжній
        // Chrome завжди шле їх усі одночасно), тож імітуємо повний набір,
        // який реальний браузер надсилає при переході за посиланням.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "uk-UA,uk;q=0.9,ru;q=0.8,en;q=0.7",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        Referer: `${url.protocol}//${url.hostname}/`,
      },
    });
  } catch (e: any) {
    // undici загортає нашу ssrfSafeLookup-помилку в TypeError "fetch failed"
    // з .cause — дістаємо справжню причину, щоб не плутати SSRF-блок зі
    // звичайним мережевим збоєм і не показувати користувачу деталі захисту.
    const cause = e?.cause?.message ?? e?.message ?? "";
    if (typeof cause === "string" && cause.includes("SSRF protection")) {
      throw new Error("Це посилання недоступне");
    }
    throw new Error(e?.name === "AbortError" ? "Сторінка не відповіла вчасно" : `Не вдалось завантажити сторінку: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      try {
        return await fetchViaBrowser(url);
      } catch (browserErr: any) {
        throw new Error(
          `Сайт заблокував автоматичне завантаження сторінки (${res.status}), і резервний спосіб через ` +
            `браузер теж не спрацював (${browserErr?.message ?? browserErr}). ` +
            "Спробуйте скопіювати текст вакансії вручну і надіслати його в чат.",
        );
      }
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
