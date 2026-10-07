// chroma.js — ChromaDB vector store for interview session embeddings.
// Works alongside src/db.js (MongoDB). ChromaDB generates embeddings
// internally using all-MiniLM-L6-v2 — no external embedding API needed.
//
// Prerequisites: ChromaDB must be running locally via Docker:
//   docker run -p 8000:8000 chromadb/chroma
//
// Call initChroma() once after the app starts (e.g. in main.js app.whenReady).
// All other calls are safe to make without waiting — they check isReady() first.

const CHROMA_URL      = 'http://localhost:8000';
const COLLECTION_NAME = 'interviews';

let client     = null;
let collection = null;

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Connect to ChromaDB and get-or-create the 'interviews' collection.
 * Safe to call multiple times — returns immediately if already connected.
 * Does NOT throw on failure so a missing Docker container never crashes the app.
 */
async function initChroma() {
  if (collection) return collection; // already initialized
  try {
    const { ChromaClient } = require('chromadb');
    client = new ChromaClient({ path: CHROMA_URL });

    // Heartbeat confirms ChromaDB is actually listening
    await client.heartbeat();

    collection = await client.getOrCreateCollection({ name: COLLECTION_NAME });

    const count = await collection.count();
    console.log(`[chroma] connected. Collection "${COLLECTION_NAME}" has ${count} documents.`);
    return collection;
  } catch (err) {
    console.warn('[chroma] could not connect to ChromaDB:', err.message);
    console.warn('[chroma] RAG context will be skipped. Start ChromaDB with: docker run -p 8000:8000 chromadb/chroma');
    client     = null;
    collection = null;
    return null;
  }
}

/** True if ChromaDB is connected and the collection is ready. */
function isReady() {
  return collection !== null;
}

// ── Text building ─────────────────────────────────────────────────────────────

/**
 * Build the searchable text from a session document.
 * We embed the high-signal structured fields ONLY.
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
 * @param {object} doc — saved MongoDB document (must have _id)
 * @param {string} mongoId — string form of MongoDB _id
 * @returns {string|null} stored document ID, or null if skipped/failed
 */
async function storeInterview(doc, mongoId) {
  if (!isReady()) return null;

  const id   = mongoId || (doc._id && doc._id.toString());
  const text = buildSearchableText(doc);

  if (!id || !text) {
    console.warn('[chroma] storeInterview: skipped — no id or empty text.');
    return null;
  }

  try {
    await collection.upsert({
      ids:       [id],
      documents: [text],
      metadatas: [{
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
 * Processes in batches of 100 to avoid overwhelming ChromaDB.
 *
 * @param {object[]} docs — array of MongoDB session documents with _id
 */
async function storeBatch(docs) {
  if (!isReady()) { console.warn('[chroma] storeBatch: ChromaDB not ready.'); return; }

  const ids       = [];
  const documents = [];
  const metadatas = [];

  for (const doc of docs) {
    const text = buildSearchableText(doc);
    if (!text) continue;
    const id = doc._id && doc._id.toString();
    if (!id) continue;
    ids.push(id);
    documents.push(text);
    metadatas.push({
      sessionContext: String(doc.sessionContext || '').slice(0, 200),
      savedAt:        doc.savedAt || Date.now(),
    });
  }

  if (ids.length === 0) { console.log('[chroma] storeBatch: nothing to store.'); return; }

  const BATCH_SIZE = 100;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await collection.upsert({
      ids:       ids.slice(i, i + BATCH_SIZE),
      documents: documents.slice(i, i + BATCH_SIZE),
      metadatas: metadatas.slice(i, i + BATCH_SIZE),
    });
    console.log(`[chroma] batch stored ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}`);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Find past interviews semantically similar to a live query.
 *
 * Distance guide for all-MiniLM-L6-v2:
 *   < 0.7  = very relevant
 *   0.7–1.0 = somewhat relevant
 *   > 1.0  = probably not relevant
 *
 * @param {string} queryText — the user's transcribed question
 * @param {number} limit     — max results (default 3)
 * @returns {Array<{mongoId, document, distance, metadata}>}
 */
async function searchInterviews(queryText, limit = 3) {
  if (!isReady() || !queryText || !queryText.trim()) return [];

  try {
    const results = await collection.query({
      queryTexts: [queryText],
      nResults:   limit,
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

module.exports = {
  initChroma,
  isReady,
  buildSearchableText,
  storeInterview,
  storeBatch,
  searchInterviews,
  deleteInterview,
  getCount,
};
