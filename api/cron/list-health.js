// api/cron/list-health.js
//
// Runs on a schedule (add to vercel.json alongside the existing sync job).
// Each run:
//   1. Fetches real bounce/opt-out sets for the campaign, checks guardrails
//      against them BEFORE doing anything else — a tripped breaker stops
//      this job cold. (FIXED: previously always passed, since the fields
//      it checked were never actually populated by fetchZohoCampaigns.)
//   2. Removes any NEWLY bounced/opted-out contacts from the regular list
//      — tracked against a small KV set so already-removed contacts aren't
//      re-processed every run. (FIXED: this step was documented in the
//      original file's header comment but never actually implemented.)
//   3. Computes the full "already contacted" exclusion set — everyone ever
//      sent this campaign, regardless of outcome.
//   4. Gets the REAL current size of the regular list directly from Zoho,
//      instead of approximating it as sentUniverse.size. (FIXED: the old
//      approximation overestimated current size, since it never subtracted
//      people already removed — causing systematic under-replenishment.)
//   5. Pulls the next geo-sorted batch from the master list (nearest to
//      home base first), validates emails, and adds them — capped by
//      guardrails.capBatchSize so this never over-adds in one run.
//
// KNOWN LIMITATION, documented rather than faked: no Zoho Campaigns (not
// Marketing Automation) endpoint was found that exposes spam-complaint
// counts at the contact level. Complaint-rate checking is skipped rather
// than silently treated as always-passing — bounce-rate is the enforced
// breaker, which is what the original ~26% bounce incident actually was.

const { getCache, setCache } = require("../../lib/store");
const {
  fetchZohoCampaigns,
  fetchZohoCampaignSentUniverse,
  fetchZohoCampaignBounceAndOptoutSets,
  getRegularCpaListCount,
  addContactToRegularCpaList,
  removeContactFromRegularCpaList,
} = require("../../lib/zoho");
const { checkCampaignHealth, capBatchSize, pauseCampaign, isPaused } = require("../../lib/guardrails");
const { nextBatchByDistance } = require("../../lib/geo");
const { filterValidEmails } = require("../../lib/emailCheck");

const CAMPAIGN_NAME = process.env.ZOHO_CPA_CAMPAIGN_NAME || "CPAs Newsletter A/B";
const TARGET_LIST_SIZE = Number(process.env.CAMPAIGN_TARGET_LIST_SIZE || 1500);

// Single-key storage, matching the migration script — the master pool
// lives here as one array, not chunked.
const MASTER_LIST_KEY = "cache:masterList";

// Tracks who's already been removed from the regular list for being
// bounced/opted-out, so repeat runs don't re-call removeContactFromRegularCpaList
// for the same people over and over.
const ALREADY_REMOVED_KEY = "cache:regularListRemovedEmails";

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const paused = await isPaused();
  if (paused) {
    return res.status(200).json({ skipped: true, reason: "campaign paused", pauseInfo: paused });
  }

  const results = {};

  // --- Step 1: fetch real bounce/optout sets, then check guardrails ---
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
    // Fail closed — don't proceed if we can't even confirm current health.
    return res.status(200).json({ skipped: true, results });
  }

  try {
    const sentUniverse = await fetchZohoCampaignSentUniverse(CAMPAIGN_NAME);
    const sentCount = sentUniverse.size;

    // Complaint-rate intentionally omitted — see KNOWN LIMITATION above.
    // Passing complaints: 0, delivered: sentCount as a neutral stand-in
    // (0/anything = 0% complaint rate) means this axis never fails, which
    // is honest about the limitation rather than pretending it's enforced.
    const health = checkCampaignHealth({
      sent: sentCount,
      delivered: sentCount - bounced.size,
      bounced: bounced.size,
      complaints: 0,
    });

    results.health = health;
    results.health.complaintRateNote = "Not measurable via Zoho Campaigns API — bounce-rate is the enforced breaker";

    if (!health.ok) {
      await pauseCampaign(health.reasons.join("; "));
      return res.status(200).json({ paused: true, results });
    }
  } catch (e) {
    results.health = { ok: false, error: e.message };
    console.error("[list-health] guardrail check failed:", e.message);
    return res.status(200).json({ skipped: true, results });
  }

  // --- Step 2: remove any NEWLY bounced/opted-out contacts from the regular list ---
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

  // --- Step 3: compute the full "already contacted" exclusion set ---
  let sentUniverse;
  try {
    sentUniverse = await fetchZohoCampaignSentUniverse(CAMPAIGN_NAME);
    results.sentUniverseSize = sentUniverse.size;
  } catch (e) {
    results.sentUniverseError = e.message;
    console.error("[list-health] fetching sent universe failed:", e.message);
    return res.status(200).json({ skipped: true, results });
  }

  // --- Step 4: get REAL current list size, compute deficit, pull next batch ---
  try {
    const masterList = (await getCache(MASTER_LIST_KEY, null)) || [];
    if (!masterList.length) {
      results.replenish = { skipped: true, reason: "master list cache empty — nothing to pull from. Run the migration script if this is unexpected." };
    } else {
      let currentActiveSize = await getRegularCpaListCount();
      if (currentActiveSize === null) {
        // Fallback to the old approximation ONLY if the real count couldn't
        // be fetched — logged clearly so this doesn't silently degrade.
        currentActiveSize = sentUniverse.size - bounced.size - optedOut.size;
        results.usedFallbackSizeEstimate = true;
        console.warn("[list-health] Could not get real list count — using fallback estimate:", currentActiveSize);
      }
      results.currentActiveSize = currentActiveSize;

      const deficit = Math.max(0, TARGET_LIST_SIZE - currentActiveSize);
      const batchSize = capBatchSize(deficit);

      if (batchSize === 0) {
        results.replenish = { skipped: true, reason: "list already at or above target size" };
      } else {
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
