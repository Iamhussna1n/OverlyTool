// chroma.js — ChromaDB vector store for interview session embeddings.
// Works alongside src/db.js (MongoDB).
//
// EMBEDDING STRATEGY:
// We use the Gemini text-embedding-004 API (via @google/genai) instead of the
// default @xenova/transformers local model. Reasons:
//   - No 80MB model download needed
//   - Works immediately with an existing Gemini API key
//   - Embeddings are stored in ChromaDB; searches use cosine similarity
//   - Falls back gracefully if Gemini key is absent
//
// Prerequisites: ChromaDB must be running locally via Docker:
//   docker run -p 8000:8000 chromadb/chroma
//
// Call initChroma(apiKey) once at app startup.
// All subsequent calls are safe — they check isReady() first.

const CHROMA_URL      = 'http://localhost:8000';
const COLLECTION_NAME = 'interviews';

let client     = null;
let collection = null;
let geminiKey  = '';      // stored at init time

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Connect to ChromaDB and get-or-create the 'interviews' collection.
 * Safe to call multiple times — returns immediately if already connected.
 * Does NOT throw on failure so a missing Docker container never crashes the app.
 *
 * @param {string} apiKey — Gemini API key (from store.getSettings().apiKeys.gemini)
 */
async function initChroma(apiKey) {
  if (collection) return collection;
  geminiKey = apiKey || '';
  try {
    const { ChromaClient } = require('chromadb');
    client = new ChromaClient({ path: CHROMA_URL });

    // Heartbeat confirms ChromaDB is listening
    await client.heartbeat();

    // We provide our own embeddings, so we use the 'hnsw:space' metadata to
    // declare cosine distance and set embeddingFunction to undefined so
    // ChromaDB never tries to invoke a local model.
    collection = await client.getOrCreateCollection({
      name:     COLLECTION_NAME,
      metadata: { 'hnsw:space': 'cosine' },
    });

    const count = await collection.count();
    console.log(`[chroma] connected. Collection "${COLLECTION_NAME}" has ${count} documents.`);
    return collection;
  } catch (err) {
    console.warn('[chroma] could not connect to ChromaDB:', err.message);
    console.warn('[chroma] RAG will be skipped. Start ChromaDB with: docker run -p 8000:8000 chromadb/chroma');
    client     = null;
    collection = null;
    return null;
  }
}

/** True if ChromaDB is connected and the collection is ready. */
function isReady() {
  return collection !== null;
}

// ── Embedding via Gemini ──────────────────────────────────────────────────────

/**
 * Generate embedding vectors for an array of texts using Gemini text-embedding-004.
 * Returns a parallel array of float32 vectors (each 768-dimensional).
 * Throws if the Gemini API call fails.
 *
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts) {
  if (!texts || texts.length === 0) return [];
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: geminiKey });

  const result = await ai.models.embedContent({
    model:    'gemini-embedding-001',
    contents: texts,
  });

  if (!result || !result.embeddings) {
    throw new Error('Gemini embedContent returned no embeddings');
  }

  return result.embeddings.map(e => e.values);
}

// ── Text building ─────────────────────────────────────────────────────────────

/**
 * Build the searchable text from a session document.
 * Embeds high-signal structured fields ONLY.
 * The raw transcript is intentionally excluded — it's too noisy.
 *
 * @param {object} doc — MongoDB session document
 * @returns {string}
 */
function buildSearchableText(doc) {
  const parts = [
    doc.sessionContext,
    doc.summary,
    Array.isArray(doc.keyPoints)   ? doc.keyPoints.join('. ')   : doc.keyPoints,
    Array.isArray(doc.decisions)   ? doc.decisions.join('. ')   : doc.decisions,
    Array.isArray(doc.actionItems) ? doc.actionItems.join('. ') : doc.actionItems,
    Array.isArray(doc.followUp)    ? doc.followUp.join('. ')    : doc.followUp,
  ];
  return parts.filter(Boolean).join('\n').trim();
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Store a single interview's embedding in ChromaDB.
 * Uses upsert so re-saving an updated session updates the embedding.
 *
 * @param {object} doc    — saved MongoDB document (must have _id)
 * @param {string} mongoId — string form of MongoDB _id
 * @returns {string|null} stored ID, or null if skipped/failed
 */
async function storeInterview(doc, mongoId) {
  if (!isReady()) return null;
  if (!geminiKey) {
    console.warn('[chroma] no Gemini API key — skipping embedding for', mongoId);
    return null;
  }

  const id   = mongoId || (doc._id && doc._id.toString());
  const text = buildSearchableText(doc);

  if (!id || !text) {
    console.warn('[chroma] storeInterview: skipped — no id or empty text.');
    return null;
  }

  try {
    const [embedding] = await embedTexts([text]);
    await collection.upsert({
      ids:        [id],
      embeddings: [embedding],
      documents:  [text],
      metadatas:  [{
        sessionContext: String(doc.sessionContext || '').slice(0, 200),
        savedAt:        doc.savedAt || Date.now(),
      }],
    });
    console.log('[chroma] stored embedding for session:', id);
    return id;
  } catch (err) {
    console.error('[chroma] storeInterview error:', err.message);
    return null;
  }
}

/**
 * Batch-store multiple sessions.
 * Used by the backfill script for existing MongoDB data.
 * Processes in batches of 20 (Gemini embedding API rate limit friendly).
 *
 * @param {object[]} docs — array of MongoDB session documents with _id
 */
async function storeBatch(docs) {
  if (!isReady()) { console.warn('[chroma] storeBatch: ChromaDB not ready.'); return; }
  if (!geminiKey) { console.warn('[chroma] storeBatch: no Gemini API key.'); return; }

  // Build text and id pairs, filtering empties
  const pairs = docs
    .map(doc => ({ id: doc._id && doc._id.toString(), text: buildSearchableText(doc), doc }))
    .filter(p => p.id && p.text);

  if (pairs.length === 0) { console.log('[chroma] storeBatch: nothing to store.'); return; }

  const BATCH_SIZE = 20; // keep Gemini API load manageable
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const chunk = pairs.slice(i, i + BATCH_SIZE);
    const embeddings = await embedTexts(chunk.map(p => p.text));

    await collection.upsert({
      ids:        chunk.map(p => p.id),
      embeddings,
      documents:  chunk.map(p => p.text),
      metadatas:  chunk.map(p => ({
        sessionContext: String(p.doc.sessionContext || '').slice(0, 200),
        savedAt:        p.doc.savedAt || Date.now(),
      })),
    });
    console.log(`[chroma] batch stored ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Find past interviews semantically similar to a live query.
 *
 * Cosine distance guide:
 *   0.0–0.3 = very relevant
 *   0.3–0.6 = somewhat relevant
 *   > 0.6   = probably not relevant
 *
 * @param {string} queryText — the user's transcribed question
 * @param {number} limit     — max results (default 3)
 * @returns {Array<{mongoId, document, distance, metadata}>}
 */
async function searchInterviews(queryText, limit = 3) {
  if (!isReady() || !queryText || !queryText.trim()) return [];
  if (!geminiKey) return [];

  try {
    const [queryEmbedding] = await embedTexts([queryText]);
    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults:        limit,
    });

    if (!results.ids?.[0]?.length) return [];

    return results.ids[0].map((id, i) => ({
      mongoId:  id,
      document: results.documents[0][i],
      distance: results.distances[0][i],
      metadata: results.metadatas[0][i],
    }));
  } catch (err) {
    console.error('[chroma] searchInterviews error:', err.message);
    return [];
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Remove an interview embedding from ChromaDB.
 * @param {string} mongoId — MongoDB _id as string
 */
async function deleteInterview(mongoId) {
  if (!isReady()) return;
  try {
    await collection.delete({ ids: [mongoId.toString()] });
    console.log('[chroma] deleted embedding:', mongoId);
  } catch (err) {
    console.error('[chroma] deleteInterview error:', err.message);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Total number of stored embeddings. Useful for debugging. */
async function getCount() {
  if (!isReady()) return 0;
  try { return await collection.count(); }
  catch { return 0; }
}

/** Update the Gemini API key (e.g. when user changes it in settings). */
function setApiKey(apiKey) {
  geminiKey = apiKey || '';
}

module.exports = {
  initChroma,
  isReady,
  setApiKey,
  buildSearchableText,
  storeInterview,
  storeBatch,
  searchInterviews,
  deleteInterview,
  getCount,
};
