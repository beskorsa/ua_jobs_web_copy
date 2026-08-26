/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg и pdf-parse — нативные/файловые Node-модули, их не нужно (и нельзя
  // корректно) тащить через webpack-бандлер серверных компонентов.
  // canvas — нативный аддон (.node бинарник) для рендера PDF в OCR-фоллбеке.
  // pdfjs-dist/tesseract.js/mammoth сами по себе не нативные, но грузят
  // файлы по относительным путям в рантайме (воркеры, .wasm, .traineddata) —
  // бандлинг через webpack это ломает, поэтому тоже держим их внешними.
  experimental: {
    serverComponentsExternalPackages: [
      "pg",
      "pdf-parse",
      "canvas",
      "pdfjs-dist",
      "tesseract.js",
      "tesseract.js-core",
      "wasm-feature-detect",
      "mammoth",
    ],
    // Автотрасування файлів (@vercel/nft) саме по собі не завжди підхоплює
    // файли, на які немає статичного require()/import() в коді. Два таких
    // випадки:
    // 1. воркер pdf.js — резолвиться по обчисленому шляху в рантаймі;
    // 2. tesseract.js-core — сам пакет обирає конкретний .wasm-файл
    //    (simd/relaxedsimd/lstm-варіанти) залежно від можливостей CPU в
    //    рантаймі через `require('tesseract.js-core/tesseract-core-...')`
    //    з обчисленим ім'ям — статично невідомо, який саме буде обрано,
    //    тож включаємо весь пакет цілком.
    outputFileTracingIncludes: {
      "/api/resume": [
        "./node_modules/pdfjs-dist/legacy/build/pdf.worker.js",
        "./node_modules/tesseract.js-core/**",
        "./node_modules/wasm-feature-detect/**",
        "./tessdata/**",
      ],
    },
  },
};

export default nextConfig;
