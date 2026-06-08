import { NextRequest, NextResponse } from "next/server";
import { OpenAI } from "openai";
import { indexDocuments, listKnowledgeSources, type KnowledgeDoc } from "@/app/lib/chroma";

// Knowledge base management endpoint.
//   POST { title, text }  -> chunk + embed (OpenAI) + upsert into Chroma Cloud
//   GET                   -> list the distinct source documents in the namespace
// All knowledge for this demo lives in a single "default" namespace (collections
// are sharded per-namespace in chroma.ts, so this is where you'd key off a user/org).
const NAMESPACE = "default";

const newId = () => Math.random().toString(36).substring(2, 9);

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("x-openai-key");
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OpenAI API key. Add your key in Settings to use the knowledge base." },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({} as any));
    const title: string = typeof body.title === "string" ? body.title.trim() : "";
    const text: string = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "Missing knowledge text" }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey });
    const doc: KnowledgeDoc = { id: newId(), title: title || "Untitled", text };
    const chunks = await indexDocuments(NAMESPACE, openai, [doc]);

    return NextResponse.json({ ok: true, sourceId: doc.id, title: doc.title, chunks });
  } catch (error: any) {
    console.error("Error in knowledge POST:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const sources = await listKnowledgeSources(NAMESPACE);
    return NextResponse.json({ sources });
  } catch (error: any) {
    console.error("Error in knowledge GET:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
