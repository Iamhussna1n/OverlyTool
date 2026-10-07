// scripts/backfillChroma.js
// One-time script to populate ChromaDB with embeddings for ALL existing
// MongoDB sessions. Run this after setting up ChromaDB for the first time.
//
// Usage:
//   GEMINI_API_KEY=your_key_here node scripts/backfillChroma.js
//
// Prerequisites:
//   1. MongoDB must be running on localhost:27017
//   2. ChromaDB must be running:  docker run -p 8000:8000 chromadb/chroma
//   3. GEMINI_API_KEY environment variable must be set

'use strict';

const { MongoClient } = require('mongodb');
const { initChroma, storeBatch, getCount } = require('../src/chroma');

const MONGO_URI = 'mongodb://localhost:27017/';
const DB_NAME   = 'cue';
const COL_NAME  = 'sessions';

async function backfill() {
  console.log('=== ChromaDB Backfill ===\n');

  const geminiKey = process.env.GEMINI_API_KEY || '';
  if (!geminiKey) {
    console.error('[ERROR] GEMINI_API_KEY environment variable is not set.');
    console.error('  Usage: GEMINI_API_KEY=your_key node scripts/backfillChroma.js');
    process.exit(1);
  }

  // 1. Connect to MongoDB
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db  = client.db(DB_NAME);
  const col = db.collection(COL_NAME);
  console.log('[MongoDB] Connected to', DB_NAME);

  // 2. Connect to ChromaDB
  const chromaReady = await initChroma(geminiKey);
  if (!chromaReady) {
    console.error('[ChromaDB] Could not connect. Is Docker running?');
    console.error('  Start ChromaDB with: docker run -p 8000:8000 chromadb/chroma');
    await client.close();
    process.exit(1);
  }

  // 3. Fetch all sessions
  const sessions = await col.find({}).toArray();
  console.log(`[MongoDB] Found ${sessions.length} sessions to backfill.\n`);

  if (sessions.length === 0) {
    console.log('Nothing to backfill. Save at least one interview session first.');
    await client.close();
    process.exit(0);
  }

  // 4. Store all in ChromaDB (in batches of 20)
  await storeBatch(sessions);

  // 5. Verify final count
  const count = await getCount();
  console.log(`\n[ChromaDB] Total embeddings after backfill: ${count}`);
  console.log('\n=== Backfill Complete ===');

  await client.close();
  process.exit(0);
}

backfill().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
