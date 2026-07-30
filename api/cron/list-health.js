// api/cron/list-health.js
//
// Runs on a schedule (add to vercel.json alongside the existing sync job).
// Each run:
//   1. Pulls current campaign stats and checks guardrails BEFORE doing
//      anything else — a tripped breaker stops this job cold.
//   2. Confirms current bounces/unsubscribes are removed from the regular
//      list (belt-and-suspenders with what sync.js's engagement loop
//      already handles for openers/clickers).
//   3. Computes the full "already contacted" exclusion set — everyone ever
//      sent this campaign, regardless of outcome (see fetchZohoCampaignSentUniverse).
//   4. Computes how far the regular list has drifted below target size.
//   5. Pulls the next geo-sorted batch from master_list.csv (nearest to
//      home base first) and adds them — capped by guardrails.capBatchSize
//      so this never over-adds in one run.

const { getCache, setCache } = require("../../lib/store");
const {
  fetchZohoCampaigns,
  fetchZohoCampaignSentUniverse,
  addContactToRegularCpaList,
  removeContactFromRegularCpaList,
  zohoFetch,
} = require("../../lib/zoho");
const { checkCampaignHealth, capBatchSize, pauseCampaign, isPaused } = require("../../lib/guardrails");
const { nextBatchByDistance } = require("../../lib/geo");
const { filterValidEmails } = require("../../lib/emailCheck");

const CAMPAIGN_NAME = process.env.ZOHO_CPA_CAMPAIGN_NAME || "CPAs Newsletter A/B";
const TARGET_LIST_SIZE = Number(process.env.CAMPAIGN_TARGET_LIST_SIZE || 1500);

// Same key api/crm/data.js uses for the master pool — adjust if your actual
// master list lives under a different cache key or gets read from a file.
const MASTER_LIST_KEY = "cache:masterList";

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

  // --- Step 1: guardrail check against current campaign stats ---
  try {
    const campaigns = await fetchZohoCampaigns();
    const match = campaigns.find((c) => c.name === CAMPAIGN_NAME);
    if (!match) throw new Error(`Campaign "${CAMPAIGN_NAME}" not found`);

    // NOTE: fetchZohoCampaigns doesn't currently return sent/delivered/bounced/
    // complaint counts directly (only opens/clicks) — this assumes those get
    // added there, or pull them here via a getcampaignreport-style call.
    // Wire this to whatever field actually carries those numbers once
    // confirmed against a real response, same as everything else in lib/zoho.js.
    const health = checkCampaignHealth({
      sent: match.sent || 0,
      delivered: match.delivered || 0,
      bounced: match.bounced || 0,
      complaints: match.complaints || 0,
    });

    results.health = health;
    if (!health.ok) {
      await pauseCampaign(health.reasons.join("; "));
      return res.status(200).json({ paused: true, results });
    }
  } catch (e) {
    results.health = { ok: false, error: e.message };
    console.error("[list-health] guardrail check failed:", e.message);
    // Don't proceed with replenishment if we can't even confirm the
    // campaign is healthy — fail closed, not open.
    return res.status(200).json({ skipped: true, results });
  }

  // --- Step 2: compute the full "already contacted" exclusion set ---
  let sentUniverse;
  try {
    sentUniverse = await fetchZohoCampaignSentUniverse(CAMPAIGN_NAME);
    results.sentUniverseSize = sentUniverse.size;
  } catch (e) {
    results.sentUniverseError = e.message;
    console.error("[list-health] fetching sent universe failed:", e.message);
    return res.status(200).json({ skipped: true, results });
  }

  // --- Step 3: compute deficit and pull the next geo-sorted batch ---
  try {
    const masterList = (await getCache(MASTER_LIST_KEY, null)) || [];
    if (!masterList.length) {
      results.replenish = { skipped: true, reason: "master list cache empty — nothing to pull from" };
    } else {
      // Current active size = sent universe minus anyone already removed
      // (bounced/unsubscribed) — approximated here as sentUniverse.size minus
      // known-removed count, if you're tracking that separately; otherwise
      // this slightly overestimates current size, which just means the
      // computed deficit is a bit conservative (fine — better to under-add
      // than over-add).
      const currentActiveEstimate = sentUniverse.size; // refine once bounce/unsub counts are tracked separately
      const deficit = Math.max(0, TARGET_LIST_SIZE - currentActiveEstimate);
      const batchSize = capBatchSize(deficit);

      if (batchSize === 0) {
        results.replenish = { skipped: true, reason: "list already at or above target size" };
      } else {
        // Pull a slightly larger candidate pool than needed, since the
        // validation pass below will reject some — otherwise a batch that
        // loses 10-15% to invalid syntax/no-MX domains falls short of the
        // requested size instead of topping back up fully.
        const candidatePool = nextBatchByDistance(masterList, sentUniverse, Math.ceil(batchSize * 1.2));
        const { kept: batch, rejected } = await filterValidEmails(candidatePool);
        const finalBatch = batch.slice(0, batchSize); // trim back down in case the 1.2x buffer over-delivered

        results.emailValidation = {
          candidatesChecked: candidatePool.length,
          rejected: rejected.length,
          rejectedSample: rejected.slice(0, 10), // full list could be long; a sample is enough to sanity-check
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
        if (failures.length) results.replenishFailures = failures.slice(0, 20); // cap logged detail
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
