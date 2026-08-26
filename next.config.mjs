/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg и pdf-parse — нативные/файловые Node-модули, их не нужно (и нельзя
  // корректно) тащить через webpack-бандлер серверных компонентов.
  // canvas — нативный аддон (.node бинарник) для рендера PDF в OCR-фоллбеке.
  // pdfjs-dist/tesseract.js/mammoth сами по себе не нативные, но грузят
  // файлы по относительным путям в рантайме (воркеры, .wasm, .traineddata) —
  // бандлинг через webpack это ломает, поэтому тоже держим их внешними.
  experimental: {
    serverComponentsExternalPackages: ["pg", "pdf-parse", "canvas", "pdfjs-dist", "tesseract.js", "mammoth"],
  },
};

export default nextConfig;
