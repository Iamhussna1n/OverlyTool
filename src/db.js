// db.js — MongoDB persistence for cue interview sessions.
// Uses a lazy singleton connection so the driver is only loaded when
// the user actually saves a session (not at startup). Keeps the happy
// path fast and avoids crashing if MongoDB is not running.

const MONGO_URI = 'mongodb://localhost:27017/';
const DB_NAME = 'cue';
const COL_NAME = 'sessions';

let client = null;
let db = null;

async function connect() {
  if (db) return db;
  const { MongoClient } = require('mongodb');
  client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 4000,
    connectTimeoutMS: 4000,
  });
  await client.connect();
  db = client.db(DB_NAME);
  console.log('[db] connected to MongoDB');
  return db;
}

/**
 * Save one complete interview session document.
 *
 * @param {object} session
 *   {
 *     sessionContext : string   — freeform pre-session brief the user typed
 *     summary       : string   — LLM-generated recap text
 *     transcript    : [{channel,text,ts}] — full turn-by-turn transcript
 *     startedAt     : number   — ms timestamp
 *     savedAt       : number   — ms timestamp
 *   }
 * @returns {string} Inserted document id (hex string)
 */
async function saveSession(session) {
  const database = await connect();
  const col = database.collection(COL_NAME);
  const doc = {
    ...session,
    savedAt: Date.now(),
  };
  const result = await col.insertOne(doc);
  console.log('[db] session saved:', result.insertedId.toString());
  return result.insertedId.toString();
}

/**
 * Retrieve the N most recent saved sessions (summaries only — no transcript).
 * Used if you ever want to surface history in the UI.
 */
async function recentSessions(n = 10) {
  const database = await connect();
  const col = database.collection(COL_NAME);
  return col
    .find({}, { projection: { transcript: 0 } })
    .sort({ savedAt: -1 })
    .limit(n)
    .toArray();
}

module.exports = { connect, saveSession, recentSessions };
