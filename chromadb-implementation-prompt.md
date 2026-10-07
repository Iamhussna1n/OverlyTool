# ChromaDB RAG Integration — Implementation Prompt

## Project Context

This is an AI-powered interview preparation tool. Here is the current architecture:

1. **User opens the app** → a pop-up collects interview context (role, company, focus areas)
2. **Interview starts** → user speaks into the mic → DeepGram performs live speech-to-text transcription via WebSockets
3. **Each transcribed query** is padded with the interview context and sent to the LLM for a response
4. **At the end** → the complete conversation is saved to MongoDB

### What We Are Adding

We are adding **RAG (Retrieval-Augmented Generation)** using **ChromaDB** as a local vector database. The goal: before sending the user's query to the LLM, search past interviews stored in the database for relevant context, and include that context in the prompt so the LLM gives smarter, more informed answers.

### New Architecture Flow

```
User speaks → DeepGram transcribes → raw query
                                       ↓
                            ChromaDB: find semantically similar past interviews
                            MongoDB:  fetch full documents for those matches
                                       ↓
                            Build enriched prompt:
                              - Interview context (from pop-up)
                              - Relevant past interview data (from DB)
                              - User's actual question
                                       ↓
                                      LLM → response
                                       ↓
                            At interview end:
                              MongoDB: store full conversation
                              ChromaDB: store embedding for future searches
```

---

## Tech Stack

- **Runtime:** Node.js with Express
- **Database:** MongoDB (local, with Mongoose)
- **Vector DB:** ChromaDB (local, running via Docker on port 8000)
- **Language:** JavaScript (CommonJS — use `require`, not `import`)

---

## Current MongoDB Conversation Schema

This is the existing schema for stored interviews. **Do NOT modify this schema.** The new ChromaDB integration works alongside it.

```javascript
{
  "_id": "66fd58b291a84f33b1e941a2",
  "sessionContext": "Senior Backend Engineer interview at Stripe. Focusing on distributed systems and Kafka.",
  "summary": "The candidate discussed past experience designing high-throughput message brokers and answered behavioral questions regarding incident response.",
  "keyPoints": [
    "Discussed partition rebalancing strategies in Kafka",
    "Explained idempotent consumer design using Redis locks",
    "STAR response on handling an outage in Q3"
  ],
  "decisions": [
    "Agreed that round 2 will focus on system architecture",
    "Recruiter to follow up by Friday"
  ],
  "actionItems": [
    "Send GitHub repository link for past distributed systems project",
    "Review Stripe API idempotency key documentation"
  ],
  "followUp": [
    "Prepare questions regarding deployment automation for hiring manager"
  ],
  "transcript": [
    {
      "channel": "them",
      "text": "Can you explain how you handled message loss in your pipeline?",
      "ts": 1727829000123
    },
    {
      "channel": "you",
      "text": "We configured acks to all and implemented a dead-letter queue with exponential backoff.",
      "ts": 1727829015456
    }
  ],
  "startedAt": 1727828950000,
  "savedAt": 1727832600000
}
```

---

## Prerequisites (Already Done)

- ChromaDB is running locally via Docker Compose on port 8000
- Docker Compose file is already configured
- MongoDB is running locally

---

## Implementation Steps

### Step 1: Install the ChromaDB npm client

```bash
npm install chromadb
```

### Step 2: Add environment variable

Add this to the `.env` file:

```
CHROMA_URL=http://localhost:8000
```

### Step 3: Create `services/chromaService.js`

This is the core module. It handles all ChromaDB operations: connecting, storing embeddings, searching, deleting, and batch operations.

**Key design decisions:**

- **ChromaDB uses its built-in embedding model** (`all-MiniLM-L6-v2`). We do NOT need OpenAI's embedding API. We send plain text to ChromaDB and it generates vectors internally. Zero API cost.

- **We embed a combination of structured fields, NOT the raw transcript.** The transcript is noisy (filler words, incomplete sentences, "um", "so basically"). Noisy text produces bad embeddings which produce bad search results. We embed: `sessionContext`, `summary`, `keyPoints`, `decisions`, `actionItems`, `followUp`. The transcript stays in MongoDB for reference but is not embedded.

- **We use `upsert` instead of `add`** so that if a conversation is updated (e.g., summary is added after the interview), the embedding is updated too without throwing duplicate ID errors.

- **The collection name is `interviews`.**

- **MongoDB `_id` (as string) is used as the ChromaDB document ID.** This creates a direct link between the two databases.

```javascript
// services/chromaService.js

const { ChromaClient } = require('chromadb');

// --- Configuration ---
const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const COLLECTION_NAME = 'interviews';

// --- Module-level state ---
let client = null;
let collection = null;

// ========================================
// INITIALIZATION
// ========================================

/**
 * Connect to ChromaDB and create/get the interviews collection.
 * Call this once when your server starts, AFTER MongoDB connects.
 * Throws if ChromaDB is unreachable so the server fails fast.
 */
async function initChroma() {
  try {
    client = new ChromaClient({ path: CHROMA_URL });

    // Test connection
    const heartbeat = await client.heartbeat();
    console.log('[ChromaDB] Connected. Heartbeat:', heartbeat);

    // getOrCreateCollection: use existing collection or create a new one.
    // ChromaDB uses "all-MiniLM-L6-v2" embedding model by default.
    // This model runs INSIDE ChromaDB — no external API calls, no cost.
    // It converts text into a vector of 384 numbers.
    collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
    });

    const count = await collection.count();
    console.log(`[ChromaDB] Collection "${COLLECTION_NAME}" ready. Documents: ${count}`);

    return collection;
  } catch (error) {
    console.error('[ChromaDB] Failed to connect:', error.message);
    console.error('[ChromaDB] Is ChromaDB running? Try: docker-compose up -d');
    throw error;
  }
}

// ========================================
// HELPER
// ========================================

/**
 * Build the searchable text from a conversation document.
 *
 * This combines the high-signal fields into one string for embedding.
 * DO NOT include the transcript — it's noisy and dilutes embedding quality.
 *
 * @param {Object} doc - A MongoDB conversation document
 * @returns {string} - Combined text for embedding
 */
function buildSearchableText(doc) {
  const parts = [
    doc.sessionContext,
    doc.summary,
    doc.keyPoints?.join('. '),
    doc.decisions?.join('. '),
    doc.actionItems?.join('. '),
    doc.followUp?.join('. '),
  ];

  return parts.filter(Boolean).join('\n');
}

/**
 * Ensure ChromaDB is initialized before any operation.
 * Throws a clear error if initChroma() was not called.
 */
function ensureInitialized() {
  if (!collection) {
    throw new Error('[ChromaDB] Not initialized. Call initChroma() when your server starts.');
  }
}

// ========================================
// STORE
// ========================================

/**
 * Store a single interview's embedding in ChromaDB.
 * Call this right after saving a conversation to MongoDB.
 *
 * Uses upsert so re-saving an updated conversation updates its embedding.
 *
 * @param {Object} doc - The saved MongoDB document (must have _id)
 * @returns {string|null} - The stored document ID, or null if skipped
 */
async function storeInterview(doc) {
  ensureInitialized();

  const mongoId = doc._id.toString();
  const searchableText = buildSearchableText(doc);

  if (!searchableText.trim()) {
    console.warn(`[ChromaDB] Skipping ${mongoId} — empty searchable text.`);
    return null;
  }

  await collection.upsert({
    ids: [mongoId],
    documents: [searchableText],
    metadatas: [{
      sessionContext: doc.sessionContext || '',
      savedAt: doc.savedAt || Date.now(),
    }],
  });

  console.log(`[ChromaDB] Stored: ${mongoId}`);
  return mongoId;
}

/**
 * Store multiple interviews at once. Used for backfilling existing data.
 * Processes in batches of 100 to avoid overwhelming ChromaDB.
 *
 * @param {Array} docs - Array of MongoDB conversation documents
 */
async function storeBatch(docs) {
  ensureInitialized();

  const ids = [];
  const documents = [];
  const metadatas = [];

  for (const doc of docs) {
    const text = buildSearchableText(doc);
    if (!text.trim()) continue;

    ids.push(doc._id.toString());
    documents.push(text);
    metadatas.push({
      sessionContext: doc.sessionContext || '',
      savedAt: doc.savedAt || Date.now(),
    });
  }

  if (ids.length === 0) {
    console.log('[ChromaDB] No documents to store in this batch.');
    return;
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await collection.upsert({
      ids: ids.slice(i, i + BATCH_SIZE),
      documents: documents.slice(i, i + BATCH_SIZE),
      metadatas: metadatas.slice(i, i + BATCH_SIZE),
    });
    console.log(`[ChromaDB] Batch stored: ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}`);
  }
}

// ========================================
// SEARCH
// ========================================

/**
 * Find past interviews relevant to the user's live query.
 *
 * How it works:
 * 1. You send plain text (the user's transcribed question)
 * 2. ChromaDB converts it to a vector using its built-in model
 * 3. ChromaDB finds the most similar stored vectors
 * 4. Returns matched document IDs, text, and distance scores
 *
 * Distance: lower = more similar. 0 = identical. >1.5 = probably not relevant.
 *
 * @param {string} queryText - The user's transcribed question
 * @param {number} limit - Maximum results to return (default 3)
 * @returns {Array<{mongoId: string, document: string, distance: number, metadata: Object}>}
 */
async function searchInterviews(queryText, limit = 3) {
  ensureInitialized();

  if (!queryText?.trim()) return [];

  const results = await collection.query({
    queryTexts: [queryText],
    nResults: limit,
  });

  // ChromaDB returns arrays of arrays (supports batch queries).
  // We send one query, so results are at index [0].
  if (!results.ids?.[0]?.length) return [];

  return results.ids[0].map((id, i) => ({
    mongoId: id,
    document: results.documents[0][i],
    distance: results.distances[0][i],
    metadata: results.metadatas[0][i],
  }));
}

// ========================================
// DELETE
// ========================================

/**
 * Remove an interview's embedding from ChromaDB.
 * Call this when a user deletes a conversation from MongoDB.
 *
 * @param {string} mongoId - The MongoDB document _id as a string
 */
async function deleteInterview(mongoId) {
  ensureInitialized();
  await collection.delete({ ids: [mongoId.toString()] });
  console.log(`[ChromaDB] Deleted: ${mongoId}`);
}

// ========================================
// UTILITY
// ========================================

/**
 * Get total number of stored embeddings.
 * Useful for health checks and debugging.
 */
async function getCount() {
  ensureInitialized();
  return collection.count();
}

module.exports = {
  initChroma,
  buildSearchableText,
  storeInterview,
  storeBatch,
  searchInterviews,
  deleteInterview,
  getCount,
};
```

### Step 4: Create `services/queryEnrichment.js`

This module takes the user's raw transcribed query, searches ChromaDB for relevant past interviews, fetches the full data from MongoDB, and builds an enriched prompt.

**Key design decisions:**

- **Distance threshold of 1.0**: ChromaDB distances below 1.0 are generally relevant for the `all-MiniLM-L6-v2` model. Above 1.0, matches are weak and including them would add noise to the prompt.

- **We fetch full documents from MongoDB** (not from ChromaDB) because ChromaDB only stores the searchable text, not the complete interview data.

- **If no relevant past data is found, we return the plain prompt** without any past context. No filler, no empty sections.

```javascript
// services/queryEnrichment.js

const { searchInterviews } = require('./chromaService');
const Conversation = require('../models/Conversation'); // <-- adjust this import to match your actual Mongoose model path

// Distance threshold: only include matches below this value.
// For ChromaDB's default model (all-MiniLM-L6-v2):
//   < 0.7  = very relevant
//   0.7-1.0 = somewhat relevant
//   > 1.0  = probably not relevant
const RELEVANCE_THRESHOLD = 1.0;

/**
 * Build an enriched prompt by combining:
 * 1. Current interview context (from the pop-up)
 * 2. Relevant past interview data (from ChromaDB + MongoDB)
 * 3. The user's actual question
 *
 * @param {string} rawQuery - The user's transcribed speech from DeepGram
 * @param {string} interviewContext - The session context from the pre-interview pop-up
 * @returns {string} - The enriched prompt to send to the LLM
 */
async function buildEnrichedPrompt(rawQuery, interviewContext) {
  // 1. Search ChromaDB for semantically similar past interviews
  const matches = await searchInterviews(rawQuery, 3);

  // 2. Filter out weak matches
  const relevant = matches.filter((m) => m.distance < RELEVANCE_THRESHOLD);

  // 3. If no relevant past data found, return a clean prompt without past context
  if (relevant.length === 0) {
    return `## Interview Context\n${interviewContext}\n\n## Question\n${rawQuery}`;
  }

  // 4. Fetch full documents from MongoDB for the matched interviews
  const mongoIds = relevant.map((m) => m.mongoId);
  const pastInterviews = await Conversation.find(
    { _id: { $in: mongoIds } },
    {
      sessionContext: 1,
      summary: 1,
      keyPoints: 1,
      decisions: 1,
      actionItems: 1,
    }
  ).lean();

  // 5. Build the past context section
  const pastContext = pastInterviews
    .map((doc) => {
      return [
        `- Interview: ${doc.sessionContext}`,
        `  Summary: ${doc.summary}`,
        doc.keyPoints?.length ? `  Key Points: ${doc.keyPoints.join(', ')}` : null,
        doc.decisions?.length ? `  Decisions: ${doc.decisions.join(', ')}` : null,
        doc.actionItems?.length ? `  Action Items: ${doc.actionItems.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  // 6. Assemble the enriched prompt
  return `## Current Interview Context
${interviewContext}

## Relevant Past Interviews
${pastContext}

## User's Question
${rawQuery}

Use the past interview data only if it is directly relevant to the current question.
Do not mention that past data was retrieved.
Do not reference "past interviews" in your response.`;
}

module.exports = { buildEnrichedPrompt };
```

**IMPORTANT:** The `Conversation` model import path (`../models/Conversation`) must be adjusted to match the actual path in the project. Search the codebase for the Mongoose model definition for conversations and use that path.

### Step 5: Initialize ChromaDB in the Server Entry Point

Find the main server file (likely `server.js`, `app.js`, or `index.js`) where MongoDB connects and the Express app starts. Add ChromaDB initialization **after** MongoDB connects.

```javascript
const { initChroma } = require('./services/chromaService');

// Inside your server startup function, AFTER mongoose.connect():
await initChroma();
```

**Do NOT replace existing startup code.** Just add the `initChroma()` call after MongoDB is connected and before `app.listen()`.

### Step 6: Hook into Conversation Save

Find the place in the codebase where conversations are saved to MongoDB (the function/route that creates a new Conversation document). After the MongoDB save succeeds, add:

```javascript
const { storeInterview } = require('./services/chromaService');

// After saving to MongoDB:
// const saved = await Conversation.create(conversationData);
// OR
// const saved = await conversation.save();

// Add this line right after:
await storeInterview(saved);
```

If the save happens inside a try/catch, wrap the `storeInterview` call in its own try/catch so that a ChromaDB failure does not break the conversation save:

```javascript
try {
  await storeInterview(saved);
} catch (chromaError) {
  console.error('[ChromaDB] Failed to store embedding:', chromaError.message);
  // Don't throw — MongoDB save already succeeded, that's the primary store
}
```

### Step 7: Hook into the Query Pipeline

Find the place where the user's transcribed query is sent to the LLM. Replace the direct prompt with the enriched prompt.

```javascript
const { buildEnrichedPrompt } = require('./services/queryEnrichment');

// BEFORE (current code sends raw query + context):
// const prompt = sessionContext + '\n' + rawTranscript;
// const response = await callLLM(prompt);

// AFTER (enriched with past interview data):
const enrichedPrompt = await buildEnrichedPrompt(rawTranscript, sessionContext);
const response = await callLLM(enrichedPrompt);
```

**Search the codebase** for where DeepGram's final transcript is processed and sent to the LLM. That's where this change goes.

### Step 8: Create `scripts/backfillChroma.js`

This one-time script populates ChromaDB with embeddings for all existing conversations in MongoDB.

```javascript
// scripts/backfillChroma.js

require('dotenv').config();
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation'); // adjust path
const { initChroma, storeBatch, getCount } = require('../services/chromaService');

async function backfill() {
  console.log('=== ChromaDB Backfill Script ===\n');

  // 1. Connect to MongoDB
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[MongoDB] Connected.');

  // 2. Connect to ChromaDB
  await initChroma();

  // 3. Fetch all conversations
  const conversations = await Conversation.find({}).lean();
  console.log(`[MongoDB] Found ${conversations.length} conversations to backfill.\n`);

  if (conversations.length === 0) {
    console.log('Nothing to backfill. Exiting.');
    process.exit(0);
  }

  // 4. Store all in ChromaDB
  await storeBatch(conversations);

  // 5. Verify
  const count = await getCount();
  console.log(`\n[ChromaDB] Total documents after backfill: ${count}`);
  console.log('\n=== Backfill Complete ===');

  process.exit(0);
}

backfill().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
```

### Step 9: Create `scripts/testChroma.js`

A test script to verify the entire ChromaDB integration works end to end.

```javascript
// scripts/testChroma.js

require('dotenv').config();
const { initChroma, storeInterview, searchInterviews, getCount, deleteInterview } = require('../services/chromaService');

async function test() {
  console.log('=== ChromaDB Integration Test ===\n');

  // 1. Connect
  await initChroma();

  // 2. Store a fake interview
  const fakeDoc = {
    _id: 'test-001',
    sessionContext: 'Senior Backend Engineer interview at Stripe. Focus on Kafka and distributed systems.',
    summary: 'Discussed partition rebalancing, idempotent consumers, and dead-letter queues.',
    keyPoints: [
      'Kafka partition rebalancing strategies',
      'Idempotent consumer design with Redis locks',
      'Dead-letter queue with exponential backoff',
    ],
    decisions: ['Round 2 will focus on system architecture'],
    actionItems: ['Send GitHub repo for distributed systems project'],
    followUp: ['Prepare questions about deployment automation'],
  };

  await storeInterview(fakeDoc);
  console.log('Stored fake interview.\n');

  // 3. Check count
  const count = await getCount();
  console.log(`Total documents: ${count}\n`);

  // 4. Relevant search
  console.log('--- Search: "How did you handle message loss in Kafka?" ---');
  const results1 = await searchInterviews('How did you handle message loss in Kafka?');
  results1.forEach((r) => {
    console.log(`  Match: ${r.mongoId} | Distance: ${r.distance.toFixed(4)}`);
  });

  // 5. Unrelated search
  console.log('\n--- Search: "Tell me about your React frontend experience" ---');
  const results2 = await searchInterviews('Tell me about your React frontend experience');
  results2.forEach((r) => {
    console.log(`  Match: ${r.mongoId} | Distance: ${r.distance.toFixed(4)}`);
  });

  // The Kafka query should have a LOWER distance than the React query.
  console.log('\nExpected: Kafka distance < React distance');

  // 6. Cleanup
  await deleteInterview('test-001');
  console.log('\nCleaned up test document.');

  const finalCount = await getCount();
  console.log(`Final document count: ${finalCount}`);

  console.log('\n=== Test Complete ===');
  process.exit(0);
}

test().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `services/chromaService.js` | Core ChromaDB service — init, store, search, delete |
| `services/queryEnrichment.js` | Builds enriched prompts using ChromaDB + MongoDB |
| `scripts/backfillChroma.js` | One-time script to populate ChromaDB from existing MongoDB data |
| `scripts/testChroma.js` | Test script to verify the integration works |

## Files to Modify

| File | Change |
|------|--------|
| `.env` | Add `CHROMA_URL=http://localhost:8000` |
| Server entry point (`server.js` / `app.js`) | Add `await initChroma()` after MongoDB connects |
| Conversation save function | Add `await storeInterview(saved)` after MongoDB save |
| Query-to-LLM function | Replace raw prompt with `buildEnrichedPrompt()` |

## Critical Rules

1. **Do NOT modify the existing MongoDB conversation schema.** ChromaDB works alongside it.
2. **Do NOT embed the transcript.** Only embed: `sessionContext`, `summary`, `keyPoints`, `decisions`, `actionItems`, `followUp`.
3. **Use CommonJS** (`require` / `module.exports`), not ES modules.
4. **Search the codebase first** to find the actual file paths for: the Mongoose Conversation model, the server entry point, the conversation save logic, and the query-to-LLM pipeline. Adjust import paths accordingly.
5. **Wrap ChromaDB calls in try/catch** wherever they are secondary to a MongoDB operation (e.g., after saving a conversation). ChromaDB failures should log errors but not break primary functionality.
6. **ChromaDB generates embeddings internally.** Do NOT install or use OpenAI's embedding API.

## Verification Steps

1. Run `node scripts/testChroma.js` — should store, search, and delete without errors
2. Run `node scripts/backfillChroma.js` — should populate ChromaDB with existing conversations
3. Start the server — should see `[ChromaDB] Connected` and `[ChromaDB] Collection "interviews" ready` in logs
4. Conduct a test interview — after saving, verify ChromaDB count increased
5. Start a new interview and ask a question related to a past interview — verify the response shows awareness of past context
