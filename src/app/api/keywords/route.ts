export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/schema";
import { suggestKeywords, touchKeyword, seedKeywordDictionary, type KeywordKind } from "@/lib/keywords";

function parseKind(v: string | null): KeywordKind | null {
  return v === "include" || v === "exclude" ? v : null;
}

// GET — автопідказки під час набору тексту в тег-інпуті (не змінює словник).
export async function GET(req: NextRequest) {
  try {
    await ensureSchema();
    await seedKeywordDictionary();

    const { searchParams } = new URL(req.url);
    const kind = parseKind(searchParams.get("kind"));
    const q = searchParams.get("q") ?? "";
    if (!kind) {
      return NextResponse.json({ error: "kind має бути 'include' або 'exclude'" }, { status: 400 });
    }

    const suggestions = await suggestKeywords(q, kind, 8);
    return NextResponse.json({ suggestions });
  } catch (e: any) {
    console.error("[api/keywords GET]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}

// POST — фіксує реальне використання слова (при застосуванні пошуку, а не
// під час набору): нове слово додається в словник, відоме — отримує +1.
export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const body = await req.json().catch(() => ({}));
    const kind = parseKind(body.kind ?? null);
    const term = String(body.term ?? "").trim();
    if (!kind) {
      return NextResponse.json({ error: "kind має бути 'include' або 'exclude'" }, { status: 400 });
    }
    if (!term) {
      return NextResponse.json({ error: "Порожній term" }, { status: 400 });
    }
    await touchKeyword(term, kind);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[api/keywords POST]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
