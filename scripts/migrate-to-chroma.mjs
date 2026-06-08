/**
 * Migration / seed script for the Chroma Cloud knowledge base.
 *
 * Copies source documents into Chroma Cloud, embedding them with OpenAI
 * `text-embedding-3-small` and chunking anything over Chroma's 16 KiB document
 * limit (line-based). Each chunk records its source id + chunk index so search
 * results can be de-duplicated per source document via GroupBy.
 *
 * Usage:
 *   node --env-file=.env.local scripts/migrate-to-chroma.mjs
 *
 * Reads .txt/.md files from scripts/seed-knowledge/ if present; otherwise seeds
 * a small built-in sample corpus. Re-running re-embeds (ids are stable per file).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { CloudClient } from "chromadb";
import { OpenAI } from "openai";

const NAMESPACE = "default";
const EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_TARGET_BYTES = 12 * 1024;
const MAX_DOC_BYTES = 16 * 1024;
const SEED_DIR = join(process.cwd(), "scripts", "seed-knowledge");

const enc = new TextEncoder();
const byteLength = (s) => enc.encode(s).length;

const SAMPLE_DOCS = [
  {
    id: "company-hours",
    title: "Support Hours",
    text: "Our support team is available Monday through Friday, 9am to 6pm Eastern Time. Weekend support is limited to critical outages. The fastest way to reach us is via the in-app chat.",
  },
  {
    id: "refund-policy",
    title: "Refund Policy",
    text: "Customers may request a full refund within 30 days of purchase, no questions asked. After 30 days, refunds are prorated for annual plans. Refunds are processed to the original payment method within 5 business days.",
  },
  {
    id: "product-overview",
    title: "Product Overview",
    text: "VoiceTodo is a voice-controlled task manager. You speak to add, complete, update, or delete tasks, and the agent can also answer questions from a knowledge base using retrieval-augmented generation backed by Chroma Cloud.",
  },
];

function chunkDocument(doc) {
  const lines = doc.text.split("\n");
  const chunks = [];
  let buf = "";
  const flush = () => { if (buf.length) { chunks.push(buf); buf = ""; } };

  for (const line of lines) {
    if (byteLength(line) > MAX_DOC_BYTES) {
      flush();
      let rest = line;
      while (byteLength(rest) > CHUNK_TARGET_BYTES) {
        let cut = rest.length;
        while (byteLength(rest.slice(0, cut)) > CHUNK_TARGET_BYTES) cut = Math.floor(cut * 0.9);
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      buf = rest;
      continue;
    }
    const candidate = buf ? `${buf}\n${line}` : line;
    if (byteLength(candidate) > CHUNK_TARGET_BYTES) { flush(); buf = line; }
    else buf = candidate;
  }
  flush();

  return chunks.map((document, chunkIndex) => ({
    id: `${doc.id}::${chunkIndex}`,
    document,
    metadata: { sourceId: doc.id, chunkIndex, title: doc.title },
  }));
}

async function loadDocs() {
  try {
    const files = await readdir(SEED_DIR);
    const docs = [];
    for (const f of files) {
      if (!/\.(txt|md)$/i.test(f)) continue;
      const text = await readFile(join(SEED_DIR, f), "utf8");
      const id = basename(f).replace(/\.[^.]+$/, "");
      docs.push({ id, title: id, text });
    }
    if (docs.length) return docs;
  } catch {
    /* no seed dir — fall through to samples */
  }
  return SAMPLE_DOCS;
}

async function main() {
  const { CHROMA_API_KEY, CHROMA_TENANT, CHROMA_DATABASE, OPENAI_API_KEY } = process.env;
  if (!CHROMA_API_KEY || !CHROMA_TENANT || !CHROMA_DATABASE) {
    throw new Error("Set CHROMA_API_KEY, CHROMA_TENANT, CHROMA_DATABASE (see .env.local).");
  }
  if (!OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY (see .env.local).");

  const client = new CloudClient({
    apiKey: CHROMA_API_KEY,
    tenant: CHROMA_TENANT,
    database: CHROMA_DATABASE,
  });
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const collection = await client.getOrCreateCollection({
    name: `knowledge_${NAMESPACE}`,
    metadata: { embeddingModel: EMBEDDING_MODEL },
    embeddingFunction: null,
  });

  const docs = await loadDocs();
  const records = docs.flatMap(chunkDocument);
  console.log(`Embedding ${records.length} chunks from ${docs.length} documents...`);

  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: records.map((r) => r.document),
  });
  const embeddings = res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);

  await collection.add({
    ids: records.map((r) => r.id),
    documents: records.map((r) => r.document),
    metadatas: records.map((r) => r.metadata),
    embeddings,
  });

  console.log(`Done. Indexed ${records.length} chunks into "knowledge_${NAMESPACE}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
