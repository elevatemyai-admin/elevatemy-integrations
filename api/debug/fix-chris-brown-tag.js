// ONE-TIME FIX — delete this file after running it once.
//
// Chris Brown (chris.brown@cpfguide.com, Compass Pointe Financial) got
// tagged "CPA Lead" because he ended up on the CPA outreach list/campaign
// by mistake — he's actually a financial planner/advisor, not a CPA. The
// new automatic FP_CAMPAIGN_RE tagging logic (added to sync.js) can't fix
// this retroactively, since it only tags based on which campaign a
// contact's engagement traces back to — his engagement legitimately
// traces back to the CPA campaign, even though he shouldn't have been on
// that list in the first place. So this is a one-off manual correction,
// not something the general rule was ever going to catch.
//
// This script:
//   1. Finds his client record by email (case-insensitive)
//   2. Removes "CPA Lead" from tags if present
//   3. Adds "Financial Planner Lead" if not already present
//   4. Logs one activity note describing the correction
//
// If no client record exists for this email yet (e.g. he never actually
// clicked/opened a tracked campaign send, just replied by email), this
// reports that clearly rather than silently doing nothing.
//
// Usage: GET /api/debug/fix-chris-brown-tag
// Protected the same way as cron — requires the CRON_SECRET bearer token.

const crypto = require("crypto");
const { getCache, setCache } = require("../../lib/store");

const CRM_DATA_KEY = "crm:data";
const TARGET_EMAIL = "chris.brown@cpfguide.com";

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const crmData = await getCache(CRM_DATA_KEY, null);
    if (!crmData) return res.status(404).json({ error: "no crm:data found in cache" });

    const clients = crmData.clients || [];
    const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === TARGET_EMAIL);

    if (idx === -1) {
      return res.status(200).json({
        ok: true,
        found: false,
        note: `No client record found for ${TARGET_EMAIL} — nothing to correct. He may not have a tracked click/open on file yet.`,
      });
    }

    const existing = clients[idx];
    const existingTags = existing.tags || [];
    const nextTags = existingTags
      .filter((t) => t !== "CPA Lead")
      .concat(existingTags.includes("Financial Planner Lead") ? [] : ["Financial Planner Lead"]);

    clients[idx] = { ...existing, tags: nextTags };
    crmData.clients = clients;

    const note = `Corrected ${existing.name || TARGET_EMAIL}'s tags — removed CPA Lead, added Financial Planner Lead (he's a financial advisor, not a CPA)`;
    crmData.activityLog = [
      { id: crypto.randomBytes(4).toString("hex"), text: note, ts: new Date().toISOString() },
      ...(crmData.activityLog || []),
    ].slice(0, 50);

    await setCache(CRM_DATA_KEY, crmData);

    res.status(200).json({
      ok: true,
      found: true,
      before: existingTags,
      after: nextTags,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
