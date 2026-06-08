import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";
import { searchKnowledge } from "@/app/lib/chroma";

// Knowledge search endpoint. Used by the realtime agent (whose tool calls execute
// in the browser) to reach the server-side Chroma + OpenAI embedding pipeline.
//   POST { query, limit? } -> { hits: [{ sourceId, title, text, score }] }
const NAMESPACE = "default";

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-openai-key");
    if (!apiKey) {
      return NextResponse.json({ error: "Missing OpenAI API key." }, { status: 401 });
    }

    const body = await req.json().catch(() => ({} as any));
    const query: string = typeof body.query === "string" ? body.query.trim() : "";
    const limit = Number.isFinite(body.limit) ? Math.max(1, Math.min(10, body.limit)) : 5;
    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey });
    const hits = await searchKnowledge(NAMESPACE, openai, query, limit);
    return NextResponse.json({ hits });
  } catch (error: any) {
    console.error("Error in knowledge search:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
