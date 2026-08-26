import path from "path";
import { createRequire } from "module";
import { createWorker } from "tesseract.js";

// pdfjs-dist і tesseract.js — CommonJS-пакети без нормальних ESM-типів для
// Next.js App Router; підключаємо через createRequire, як і задокументовано
// в офіційних прикладах pdf.js для Node (legacy build — саме вона працює
// поза браузером, без DOM).
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDocument } = require("pdfjs-dist/legacy/build/pdf.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createCanvas } = require("canvas");

// Мовні дані лежать прямо в репозиторії (tessdata/*.traineddata.gz), а не
// тягнуться з jsdelivr CDN у рантаймі: на serverless (Vercel) зовнішній CDN —
// зайва точка відмови (мережеві обмеження, холодний старт, латентність), а
// самі файли достатньо маленькі (~2-3 МБ кожен), щоб просто закомітити.
const TESSDATA_PATH = path.join(process.cwd(), "tessdata");

const MAX_OCR_PAGES = 5; // захист від величезних PDF і таймауту serverless-функції
const RENDER_SCALE = 2; // вищий scale = краща якість OCR, але повільніше

/**
 * Фоллбек для PDF без текстового шару — наприклад, резюме, збережене через
 * браузерний "Друк у PDF" (Microsoft Print to PDF), де текст перетворюється
 * на контури/картинку і pdf-parse нічого не витягує (див. lib/resumes.ts).
 * Рендеримо кожну сторінку в растрове зображення і розпізнаємо текст через
 * tesseract.js (укр+англ).
 */
export async function extractTextViaOcr(buffer: Buffer): Promise<string> {
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
