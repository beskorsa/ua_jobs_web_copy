// Портировано 1-в-1 по логике из ua_jobs_parser/embeddings.py (chunk_text +
// embed_as_single_vector) — режем длинный текст на чанки по границам
// предложений/абзацев с нахлёстом, эмбеддим каждый и берём mean-pooling
// нормализованный вектор, чтобы в него вносил вклад весь текст, а не
// только первые ~пара страниц (лимит токенов у embedding-моделей).

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 150;

export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP,
): string[] {
  const t = (text || "").trim();
  if (!t) return [];
  if (t.length <= chunkSize) return [t];

  const sentences = t
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const sent of sentences) {
    if (current && current.length + 1 + sent.length > chunkSize) {
      chunks.push(current.trim());
      const tail = overlap > 0 ? current.slice(-overlap) : "";
      current = (tail + " " + sent).trim();
    } else {
      current = current ? (current + " " + sent).trim() : sent;
    }

    while (current.length > chunkSize * 1.5) {
      chunks.push(current.slice(0, chunkSize).trim());
      current = current.slice(chunkSize - overlap);
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function embedAsSingleVector(
  text: string,
  embedMany: (texts: string[]) => Promise<number[][]>,
): Promise<number[]> {
  const t = (text || "").trim();
  if (!t) throw new Error("Пустой текст — нечего эмбеддить");

  const chunks = chunkText(t);
  const vectors = await embedMany(chunks);
  if (vectors.length === 1) return vectors[0];

  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i] / vectors.length;
  }
  const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? mean.map((x) => x / norm) : mean;
}
