// scripts/testChroma.js
// Verifies the full ChromaDB integration end-to-end:
//   1. Connect
//   2. Store a fake interview embedding
//   3. Search with a relevant query (should get a low distance score)
//   4. Search with an unrelated query (should get a high distance score)
//   5. Clean up the test document
//
// Usage:
//   node scripts/testChroma.js
//
// Prerequisites:
//   ChromaDB must be running: docker run -p 8000:8000 chromadb/chroma

'use strict';

const { initChroma, storeInterview, searchInterviews, getCount, deleteInterview } = require('../src/chroma');

const FAKE_ID = 'test-rag-001';

async function test() {
  console.log('=== ChromaDB Integration Test ===\n');

  // 1. Connect
  const chromaReady = await initChroma();
  if (!chromaReady) {
    console.error('[FAIL] Could not connect to ChromaDB.');
    console.error('  Start it with: docker run -p 8000:8000 chromadb/chroma');
    process.exit(1);
  }
  console.log('[PASS] Connected to ChromaDB\n');

  // 2. Store a fake interview document
  const fakeDoc = {
    _id: FAKE_ID,
    sessionContext: 'Senior Backend Engineer interview at Stripe. Focus on Kafka and distributed systems.',
    summary: 'Candidate discussed partition rebalancing, idempotent consumers, and dead-letter queues.',
    keyPoints: [
      'Kafka partition rebalancing strategies',
      'Idempotent consumer design with Redis locks',
      'Dead-letter queue with exponential backoff',
    ],
    decisions: ['Round 2 will focus on system architecture'],
    actionItems: ['Send GitHub repo for distributed systems project'],
    followUp: ['Prepare questions about deployment automation'],
  };

  await storeInterview(fakeDoc, FAKE_ID);
  console.log('[PASS] Stored fake interview document\n');

  // 3. Check count
  const count = await getCount();
  console.log(`[INFO] Total documents in ChromaDB: ${count}\n`);

  // 4a. Relevant search — should return a LOW distance (< 1.0 ideally)
  console.log('--- Search: "How did you handle message loss in Kafka?" ---');
  const results1 = await searchInterviews('How did you handle message loss in Kafka?');
  if (results1.length === 0) {
    console.warn('[WARN] No results returned. Collection may be empty or too small for nResults=3.');
  }
  results1.forEach(r => {
    const relevance = r.distance < 0.7 ? 'VERY RELEVANT' : r.distance < 1.0 ? 'SOMEWHAT RELEVANT' : 'WEAK';
    console.log(`  Match: ${r.mongoId} | Distance: ${r.distance.toFixed(4)} | ${relevance}`);
  });

  // 4b. Unrelated search — should return a HIGHER distance
  console.log('\n--- Search: "Tell me about your React frontend experience" ---');
  const results2 = await searchInterviews('Tell me about your React frontend experience');
  results2.forEach(r => {
    const relevance = r.distance < 0.7 ? 'VERY RELEVANT' : r.distance < 1.0 ? 'SOMEWHAT RELEVANT' : 'WEAK';
    console.log(`  Match: ${r.mongoId} | Distance: ${r.distance.toFixed(4)} | ${relevance}`);
  });

  // 4c. Compare distances
  const kafkaDist = results1[0]?.distance ?? Infinity;
  const reactDist = results2[0]?.distance ?? Infinity;
  if (kafkaDist < reactDist) {
    console.log('\n[PASS] Kafka query scored closer (more relevant) than React query — semantic search is working correctly.');
  } else {
    console.warn('\n[WARN] Semantic scoring looks off. The Kafka query distance should be lower than the React query distance.');
  }

  // 5. Cleanup
  await deleteInterview(FAKE_ID);
  const finalCount = await getCount();
  console.log(`\n[PASS] Cleaned up test document. Final count: ${finalCount}`);
  console.log('\n=== Test Complete ===');
  process.exit(0);
}

test().catch(err => {
  console.error('\n[FAIL] Test error:', err.message);
  process.exit(1);
});
