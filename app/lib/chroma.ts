/**
 * Chroma Cloud integration for knowledge-base RAG.
 *
 * Dense vectors are produced by OpenAI's `text-embedding-3-small` and stored in
 * Chroma Cloud as pre-computed embeddings (no Chroma-side embedding function).
 * Search embeds the query with the same model and runs a vector KNN, then
 * de-duplicates across chunks of the same source document via GroupBy.
 *
 * Data is sharded into one collection per namespace (e.g. per organization or
 * user) so that mutually exclusive data never shares an index.
 */
import { CloudClient, Search, Knn, GroupBy, MinK, K, type Collection } from "chromadb";
import type { OpenAI } from "openai";

/** OpenAI embedding model used for both indexing and querying. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** Chroma's hard per-document limit. Documents larger than this must be chunked. */
const MAX_DOC_BYTES = 16 * 1024;
/** Leave headroom under the 16 KiB cap so chunk + overhead stays valid. */
const CHUNK_TARGET_BYTES = 12 * 1024;

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** A source document to index into the knowledge base. */
export interface KnowledgeDoc {
  /** Stable identifier for the source document (used for GroupBy dedup). */
  id: string;
  /** Human-readable title surfaced in search results. */
  title: string;
  /** Full document text; chunked automatically if over the size limit. */
  text: string;
}

/** A single search hit, already de-duplicated to one chunk per source. */
export interface KnowledgeHit {
  sourceId: string;
  title: string;
  text: string;
  score: number | null;
}

let _client: CloudClient | null = null;

export function getCloudClient(): CloudClient {
  if (_client) return _client;
  const apiKey = process.env.CHROMA_API_KEY;
  const tenant = process.env.CHROMA_TENANT;
  const database = process.env.CHROMA_DATABASE;
  if (!apiKey || !tenant || !database) {
    throw new Error(
      "Chroma Cloud is not configured. Set CHROMA_API_KEY, CHROMA_TENANT and CHROMA_DATABASE."
    );
  }
  _client = new CloudClient({ apiKey, tenant, database });
  return _client;
}

/** Collection name for a namespace. Sharding keeps tenants' data isolated. */
function collectionName(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "default";
  return `knowledge_${safe}`;
}

/**
 * Get (or create) the knowledge collection for a namespace. Embeddings are
 * supplied pre-computed (OpenAI), so the collection has no Chroma-side
 * embedding function.
 */
export async function getKnowledgeCollection(namespace: string): Promise<Collection> {
  const client = getCloudClient();
  return client.getOrCreateCollection({
    name: collectionName(namespace),
    metadata: { embeddingModel: EMBEDDING_MODEL },
    embeddingFunction: null,
  });
}

/** Embed a batch of texts with OpenAI `text-embedding-3-small`. */
export async function embedTexts(openai: OpenAI, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  // Preserve input order (the API returns objects carrying their index).
  return res.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

/**
 * Split a document into <16 KiB chunks using line-based chunking. Each chunk
 * carries the source id + chunk index so results can be de-duplicated per
 * source document with GroupBy.
 */
export function chunkDocument(doc: KnowledgeDoc): {
  id: string;
  document: string;
  metadata: { sourceId: string; chunkIndex: number; title: string };
}[] {
  const lines = doc.text.split("\n");
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.length) {
      chunks.push(buf);
      buf = "";
    }
  };

  for (const line of lines) {
    // A single line larger than the cap is hard-split on byte boundaries.
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
    if (byteLength(candidate) > CHUNK_TARGET_BYTES) {
      flush();
      buf = line;
    } else {
      buf = candidate;
    }
  }
  flush();

  return chunks.map((document, chunkIndex) => ({
    id: `${doc.id}::${chunkIndex}`,
    document,
    metadata: { sourceId: doc.id, chunkIndex, title: doc.title },
  }));
}

/** Chunk, embed (OpenAI), and upsert documents into a namespace's collection. */
export async function indexDocuments(
  namespace: string,
  openai: OpenAI,
  docs: KnowledgeDoc[]
): Promise<number> {
  const collection = await getKnowledgeCollection(namespace);
  const records = docs.flatMap(chunkDocument);
  if (!records.length) return 0;

  const embeddings = await embedTexts(openai, records.map((r) => r.document));

  await collection.add({
    ids: records.map((r) => r.id),
    documents: records.map((r) => r.document),
    metadatas: records.map((r) => r.metadata),
    embeddings,
  });
  return records.length;
}

/** List the distinct source documents currently stored in a namespace. */
export async function listKnowledgeSources(
  namespace: string
): Promise<{ sourceId: string; title: string; chunks: number }[]> {
  const collection = await getKnowledgeCollection(namespace);
  const res = await collection.get({ include: ["metadatas"] });
  const bySource = new Map<string, { sourceId: string; title: string; chunks: number }>();
  for (const meta of res.metadatas ?? []) {
    const sourceId = String(meta?.sourceId ?? "");
    if (!sourceId) continue;
    const existing = bySource.get(sourceId);
    if (existing) existing.chunks += 1;
    else bySource.set(sourceId, { sourceId, title: String(meta?.title ?? "Untitled"), chunks: 1 });
  }
  return [...bySource.values()];
}

/**
 * Vector search over the knowledge base: embed the query with OpenAI, run a
 * KNN over the stored vectors, then de-duplicate to a single best chunk per
 * source document via GroupBy.
 */
export async function searchKnowledge(
  namespace: string,
  openai: OpenAI,
  query: string,
  limit = 5
): Promise<KnowledgeHit[]> {
  const collection = await getKnowledgeCollection(namespace);
  const [queryVector] = await embedTexts(openai, [query]);

  const search = new Search()
    .rank(Knn({ query: queryVector, limit: 200 }))
    // Collapse chunks of the same source document to the best-ranking one.
    .groupBy(new GroupBy([K("sourceId")], new MinK([K.SCORE], 1)))
    .limit(limit)
    .select(K.DOCUMENT, K.SCORE, "sourceId", "title");

  const result = await collection.search(search);
  const rows = result.rows()[0] ?? [];

  return rows.map((row) => ({
    sourceId: String(row.metadata?.sourceId ?? row.id),
    title: String(row.metadata?.title ?? "Untitled"),
    text: row.document ?? "",
    score: row.score ?? null,
  }));
}
