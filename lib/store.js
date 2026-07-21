// Thin wrapper around Vercel KV so the rest of the code doesn't care where
// the cache actually lives. Requires the Vercel KV (Upstash Redis) add-on —
// add it from the Vercel dashboard: Project -> Storage -> Create Database -> KV.
// That automatically sets KV_REST_API_URL / KV_REST_API_TOKEN for you.
const { kv } = require("@vercel/kv");

async function getCache(key, fallback = []) {
  try {
    const val = await kv.get(key);
    return val === null || val === undefined ? fallback : val;
  } catch (e) {
    console.warn(`[store] getCache(${key}) failed:`, e.message);
    return fallback;
  }
}

// IMPORTANT: this now THROWS on failure instead of swallowing the error.
// Previously, a failed write was caught here and only logged with
// console.warn, so callers (like /api/cron/sync) had no way to know the
// write didn't actually happen — they'd report {ok:true} based only on
// whatever upstream fetch succeeded, even if the KV write silently failed.
async function setCache(key, value) {
  try {
    await kv.set(key, value);
  } catch (e) {
    console.error(`[store] setCache(${key}) FAILED:`, e.message);
    throw e; // let the caller know — don't swallow
  }
}

// Track which record IDs we've already seen, so cron jobs can diff
// "what's new since last run" without re-processing everything each time.
async function getSeenIds(key) {
  const arr = await getCache(`seen:${key}`, []);
  return new Set(arr);
}
async function addSeenIds(key, ids) {
  const existing = await getSeenIds(key);
  ids.forEach((id) => existing.add(id));
  await setCache(`seen:${key}`, Array.from(existing));
}

module.exports = { getCache, setCache, getSeenIds, addSeenIds };
