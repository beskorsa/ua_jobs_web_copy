import path from "path";
import { createRequire } from "module";
import { createWorker } from "tesseract.js";

// pdfjs-dist і tesseract.js — CommonJS-пакети без нормальних ESM-типів для
// Next.js App Router; підключаємо через createRequire, як і задокументовано
// в офіційних прикладах pdf.js для Node (legacy build — саме вона працює
// поза браузером, без DOM).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDocument, GlobalWorkerOptions } = require("pdfjs-dist/legacy/build/pdf.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCanvas } = require("canvas");

// Без явного workerSrc pdf.js у Node намагається зробити
// `eval("require")("./pdf.worker.js")` (відносний шлях), що ламається
// всередині serverless-бандла Vercel ("Cannot find module './pdf.worker.js'").
// ВАЖЛИВО: обчислюємо шлях через звичайний path.join, а НЕ через
// `require.resolve(...)` — навіть викликаний із createRequire-похідного
// require, цей виклик все одно підмінюється Next.js/webpack на build-етапі
// (статичний аналізатор бандлера ловить синтаксичний патерн
// "require.resolve(літерал)" незалежно від того, звідки взявся `require`),
// і в рантаймі повертає не реальний абсолютний шлях, а щось на кшталт
// внутрішнього ідентифікатора модуля — звідси інша помилка ("e.endsWith is
// not a function") замість очікуваного результату. Простий рядковий шлях
// такому статичному аналізу не піддається, і файл однаково потрапляє в
// serverless-бандл через `outputFileTracingIncludes` (next.config.mjs).
GlobalWorkerOptions.workerSrc = path.join(
  process.cwd(),
  "node_modules/pdfjs-dist/legacy/build/pdf.worker.js",
);

// Мовні дані лежать прямо в репозиторії (tessdata/*.traineddata.gz), а не
// тягнуться з jsdelivr CDN у рантаймі: на serverless (Vercel) зовнішній CDN —
// зайва точка відмови (мережеві обмеження, холодний старт, латентність), а
// самі файли достатньо маленькі (~2-3 МБ кожен), щоб просто закомітити.
const TESSDATA_PATH = path.join(process.cwd(), "tessdata");

const MAX_OCR_PAGES = 5; // захист від величезних PDF і таймауту serverless-функції
const RENDER_SCALE = 2; // вищий scale = краща якість OCR, але повільніше

// Жорсткий дедлайн для всього OCR-фоллбеку. maxDuration функції — 60с
// (api/resume/route.ts); якщо OCR десь зависне (наприклад, знову зламане
// завантаження wasm-ядра tesseract), краще самим впасти з зрозумілою
// помилкою за 45с, ніж дати Vercel вбити всю функцію по Runtime Timeout —
// у такому разі клієнт замість JSON отримує голу HTML/текстову сторінку
// платформи і падає на "Unexpected token... is not valid JSON".
const OCR_TIMEOUT_MS = 45_000;

async function extractTextViaOcrInner(buffer: Buffer): Promise<string> {
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const numPages = Math.min(pdf.numPages, MAX_OCR_PAGES);

  const worker = await createWorker("ukr+eng", 1, {
    langPath: TESSDATA_PATH,
    gzip: true,
  });

  try {
    let fullText = "";
    for (let i = 1; i <= numPages; i += 1) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      // eslint-disable-next-line no-await-in-loop
      await page.render({ canvasContext: ctx, viewport }).promise;
      const imageBuffer = canvas.toBuffer("image/png");
      // eslint-disable-next-line no-await-in-loop
      const { data } = await worker.recognize(imageBuffer);
      fullText += `${data.text}\n`;
    }
    return fullText;
  } finally {
    await worker.terminate();
  }
}

/**
 * Фоллбек для PDF без текстового шару — наприклад, резюме, збережене через
 * браузерний "Друк у PDF" (Microsoft Print to PDF), де текст перетворюється
 * на контури/картинку і pdf-parse нічого не витягує (див. lib/resumes.ts).
 * Рендеримо кожну сторінку в растрове зображення і розпізнаємо текст через
 * tesseract.js (укр+англ).
 */
export async function extractTextViaOcr(buffer: Buffer): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<string>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`OCR timed out after ${OCR_TIMEOUT_MS}ms`)),
      OCR_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([extractTextViaOcrInner(buffer), timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}
