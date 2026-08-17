// api/cron/list-health.js
//
// Runs on a schedule (see vercel.json). Each run:
//   1. Fetches real bounce/opt-out sets for the campaign, checks guardrails
//      against them BEFORE doing anything else — a tripped breaker stops
//      this job cold.
//   2. Removes any NEWLY bounced/opted-out contacts from the regular list
//      — tracked against a small KV set so already-removed contacts aren't
//      re-processed every run.
//   3. Computes the full "already contacted" exclusion set — everyone ever
//      sent this campaign, regardless of outcome.
//   4. Gets the REAL current size of the regular list directly from Zoho.
//   5. Uses a LOW-WATER / HIGH-WATER range, not a single target: only
//      replenishes once the list drops BELOW the min (1,500 by default),
//      and when it does, tops all the way up to the max (2,000 by default)
//      — not just back to the min. This avoids running a small top-up
//      almost every day and gives real headroom before the next
//      replenishment is needed at all.
//
// KNOWN LIMITATION, documented rather than faked: no Zoho Campaigns (not
// Marketing Automation) endpoint was found that exposes spam-complaint
// counts at the contact level. Complaint-rate checking is skipped rather
// than silently treated as always-passing — bounce-rate is the enforced
// breaker, which is what the original ~26% bounce incident actually was.

const { getCache, setCache } = require("../../lib/store");
const {
  fetchZohoCampaignSentUniverse,
  fetchZohoCampaignBounceAndOptoutSets,
  getTotalCpaFunnelActiveCount,
  addContactToRegularCpaList,
  removeContactFromRegularCpaList,
} = require("../../lib/zoho");
const { checkCampaignHealth, capBatchSize, pauseCampaign, isPaused } = require("../../lib/guardrails");
const { nextBatchByDistance } = require("../../lib/geo");
const { filterValidEmails } = require("../../lib/emailCheck");

const CAMPAIGN_NAME = process.env.ZOHO_CPA_CAMPAIGN_NAME || "CPAs Newsletter A/B";

const TARGET_LIST_SIZE_MIN = Number(process.env.CAMPAIGN_TARGET_LIST_SIZE_MIN || 1500);
const TARGET_LIST_SIZE_MAX = Number(process.env.CAMPAIGN_TARGET_LIST_SIZE_MAX || 2000);

// Master list is stored CHUNKED (see migrate-master-list-v3.js) — a single
// key hit Upstash's 1MB max-request-size limit at 75k+ contacts. Reading
// still assembles into one plain array for everything downstream
// (nextBatchByDistance, etc.), so nothing else needed to change.
const MASTER_LIST_META_KEY = "cache:masterList:meta";

async function loadMasterList() {
  const meta = await getCache(MASTER_LIST_META_KEY, null);
  if (!meta || !meta.chunkCount) return [];

  const chunks = await Promise.all(
    Array.from({ length: meta.chunkCount }, (_, i) =>
      getCache(`cache:masterList:chunk:${String(i).padStart(4, "0")}`, [])
    )
  );
  return chunks.flat();
}
const ALREADY_REMOVED_KEY = "cache:regularListRemovedEmails";

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

async function runReplenishment(batchSize, masterList, sentUniverse, results) {
  if (batchSize <= 0) {
    results.replenish = { skipped: true, reason: "guardrails capped this run's batch to 0" };
    return;
  }

  const candidatePool = nextBatchByDistance(masterList, sentUniverse, Math.ceil(batchSize * 1.2));
  const { kept: batch, rejected } = await filterValidEmails(candidatePool);
  const finalBatch = batch.slice(0, batchSize);

  results.emailValidation = {
    candidatesChecked: candidatePool.length,
    rejected: rejected.length,
    rejectedSample: rejected.slice(0, 10),
  };

  let added = 0;
  const failures = [];
  for (const contact of finalBatch) {
    try {
      await addContactToRegularCpaList(contact);
      added++;
    } catch (e) {
      failures.push({ email: contact.email, error: e.message });
    }
  }
  results.replenish = { requested: batchSize, added, failed: failures.length };
  if (failures.length) results.replenishFailures = failures.slice(0, 20);
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const paused = await isPaused();
  if (paused) {
    return res.status(200).json({ skipped: true, reason: "campaign paused", pauseInfo: paused });
  }

  const results = {};

  let bounced, optedOut;
  try {
    const sets = await fetchZohoCampaignBounceAndOptoutSets(CAMPAIGN_NAME);
    bounced = sets.bounced;
    optedOut = sets.optedOut;
    results.bounceCount = bounced.size;
    results.optoutCount = optedOut.size;
  } catch (e) {
    results.bounceOptoutFetchError = e.message;
    console.error("[list-health] fetching bounce/optout sets failed:", e.message);
    return res.status(200).json({ skipped: true, results });
  }

  let sentUniverse;
  try {
    sentUniverse = await fetchZohoCampaignSentUniverse(CAMPAIGN_NAME);
    results.sentUniverseSize = sentUniverse.size;

    const health = checkCampaignHealth({
      sent: sentUniverse.size,
      delivered: sentUniverse.size - bounced.size,
      bounced: bounced.size,
      complaints: 0,
    });
    health.complaintRateNote = "Not measurable via Zoho Campaigns API — bounce-rate is the enforced breaker";
    results.health = health;

    if (!health.ok) {
      await pauseCampaign(health.reasons.join("; "));
      return res.status(200).json({ paused: true, results });
    }
  } catch (e) {
    results.health = { ok: false, error: e.message };
    console.error("[list-health] guardrail check failed:", e.message);
    return res.status(200).json({ skipped: true, results });
  }

  try {
    const alreadyRemoved = new Set(await getCache(ALREADY_REMOVED_KEY, []));
    const toRemove = new Set([...bounced, ...optedOut].filter((e) => !alreadyRemoved.has(e)));

    let removedCount = 0;
    const removeFailures = [];
    for (const email of toRemove) {
      try {
        await removeContactFromRegularCpaList(email);
        alreadyRemoved.add(email);
        removedCount++;
      } catch (e) {
        removeFailures.push({ email, error: e.message });
      }
    }

    await setCache(ALREADY_REMOVED_KEY, Array.from(alreadyRemoved));
    results.removal = { newlyRemoved: removedCount, alreadyRemovedTotal: alreadyRemoved.size, failed: removeFailures.length };
    if (removeFailures.length) results.removalFailures = removeFailures.slice(0, 20);
  } catch (e) {
    results.removal = { ok: false, error: e.message };
    console.error("[list-health] bounce/unsub removal failed:", e.message);
  }

  try {
    const masterList = await loadMasterList();
    if (!masterList.length) {
      results.replenish = { skipped: true, reason: "master list cache empty — nothing to pull from. Run the migration script if this is unexpected." };
    } else {
      let currentActiveSize = await getTotalCpaFunnelActiveCount();
      if (currentActiveSize === null) {
        currentActiveSize = sentUniverse.size - bounced.size - optedOut.size;
        results.usedFallbackSizeEstimate = true;
        console.warn("[list-health] Could not get real list count — using fallback estimate:", currentActiveSize);
      }
      results.currentActiveSize = currentActiveSize;

      if (currentActiveSize >= TARGET_LIST_SIZE_MIN) {
        results.replenish = {
          skipped: true,
          reason: `list at ${currentActiveSize}, still within target range (${TARGET_LIST_SIZE_MIN}-${TARGET_LIST_SIZE_MAX}) — no action needed`,
        };
      } else {
        const deficit = TARGET_LIST_SIZE_MAX - currentActiveSize;
        const batchSize = capBatchSize(deficit);
        await runReplenishment(batchSize, masterList, sentUniverse, results);
      }
    }
  } catch (e) {
    results.replenish = { ok: false, error: e.message };
    console.error("[list-health] replenishment failed:", e.message);
  }

  try {
    await setCache("cache:lastListHealthRunAt", new Date().toISOString());
  } catch (e) {
    console.error("[list-health] failed to write lastListHealthRunAt:", e.message);
  }

  res.status(200).json({ ranAt: new Date().toISOString(), results });
};
