// rag.js — Retrieval-Augmented Generation enrichment.
// Searches ChromaDB for past interviews similar to the user's live question,
// then fetches the full documents from MongoDB and injects them into the context
// block that gets sent to the LLM.
//
// This module sits between stt-final → runFeature.
// It is intentionally lightweight: if ChromaDB is unavailable, it returns
// null and the caller falls back to the normal (non-RAG) context.

const { searchInterviews, isReady } = require('./chroma');

// Distance threshold for cosine space (Gemini text-embedding-004):
//   0.0–0.3 = very relevant
//   0.3–0.6 = somewhat relevant (still included)
//   > 0.6   = probably irrelevant — excluded
const RELEVANCE_THRESHOLD = 0.6;

/**
 * Retrieve semantically relevant past interview snippets for a live query.
 *
 * Returns a formatted context block (string) ready to be prepended to the
 * LLM system prompt, or null if ChromaDB is not ready or no relevant
 * matches are found above the relevance threshold.
 *
 * @param {string} queryText     — the user's transcribed question / utterance
 * @param {object} db            — connected MongoDB Db instance from src/db.js connect()
 * @returns {string|null}        — formatted past-context block, or null
 */
async function buildRagContext(queryText, db) {
  if (!isReady() || !queryText || !queryText.trim()) return null;

  let matches;
  try {
    matches = await searchInterviews(queryText, 3);
  } catch (err) {
    console.error('[rag] searchInterviews error:', err.message);
    return null;
  }

  // Filter to only relevant matches
  const relevant = matches.filter(m => m.distance < RELEVANCE_THRESHOLD);
  if (relevant.length === 0) return null;

  // Fetch full documents from MongoDB (ChromaDB only holds the embedded text)
  let pastDocs = [];
  try {
    const { ObjectId } = require('mongodb');
    const col = db.collection('sessions');
    const ids = relevant.map(m => {
      try { return new ObjectId(m.mongoId); } catch { return null; }
    }).filter(Boolean);

    if (ids.length > 0) {
      pastDocs = await col.find(
        { _id: { $in: ids } },
        { projection: { sessionContext: 1, summary: 1, keyPoints: 1, decisions: 1, actionItems: 1, transcript: 0 } }
      ).toArray();
    }
  } catch (err) {
    console.error('[rag] MongoDB fetch for RAG context error:', err.message);
    return null;
  }

  if (pastDocs.length === 0) return null;

  // Build the context block
  const lines = pastDocs.map(doc => {
    const parts = [
      `- Interview: ${doc.sessionContext || '(no context)'}`,
      doc.summary ? `  Summary: ${doc.summary}` : null,
      doc.keyPoints && doc.keyPoints.length ? `  Key Points: ${doc.keyPoints.join(', ')}` : null,
      doc.decisions && doc.decisions.length ? `  Decisions: ${doc.decisions.join(', ')}` : null,
      doc.actionItems && doc.actionItems.length ? `  Action Items: ${doc.actionItems.join(', ')}` : null,
    ];
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');

  return (
    '=== RELEVANT PAST INTERVIEWS ===\n' +
    lines + '\n' +
    'Use past interview data only if it is directly relevant to this question. ' +
    'Do not mention that past data was retrieved. Do not reference "past interviews" in your response.'
  );
}

module.exports = { buildRagContext };
