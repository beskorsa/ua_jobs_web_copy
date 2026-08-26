import OpenAI from "openai";
import { logTokenUsage, type TokenUsageKind } from "./tokenUsage";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY не задан (см. .env.example)");
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

// Веб-часть — serverless (Vercel), локальных embedding-моделей тут не
// погонять, поэтому провайдер только один — OpenAI. См. .env.example про
// важность совпадения размерности с тем, чем насчитаны vacancy_chunks.
export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

export async function embedText(
  text: string,
  kind: TokenUsageKind = "embed_search",
  userId?: string | null,
): Promise<number[]> {
  const vectors = await embedTexts([text], kind, userId);
  return vectors[0];
}

export async function embedTexts(
  texts: string[],
  kind: TokenUsageKind = "embed_search",
  userId?: string | null,
): Promise<number[][]> {
  const openai = getOpenAI();
  const out: number[][] = [];
  const batchSize = 96; // тот же лимит, что в embeddings.py OpenAIEmbedder
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    out.push(...resp.data.map((d) => d.embedding));
    await logTokenUsage(kind, EMBEDDING_MODEL, resp.usage, userId);
  }
  return out;
}
