// ONE-TIME FIX (v2) — delete this file after running it once.
//
// The first version of this script (fix-chris-brown-tag.js) removed "CPA
// Lead" and added "Financial Planner Lead", but the very next scheduled
// sync run silently re-added "CPA Lead" — the auto-tagging logic in
// sync.js re-derives tags from campaign name on every run, with no memory
// that a human already corrected this. His engagement genuinely traces
// back to the CPA campaign (he was just on the wrong list), so that
// re-derivation will never stop matching him as long as this script
// doesn't also set the new tagsLocked flag (added to sync.js alongside
// this fix) that tells future sync runs to leave his tags alone entirely.
//
// This version:
//   1. Finds his client record by email (case-insensitive)
//   2. Sets tags to exactly ["Financial Planner Lead"] (removes CPA Lead
//      if present again, whether from the original mistake or from the
//      first fix script's correction being silently reverted)
//   3. Sets leadSource to "Financial Planner campaign" (was blank before —
//      sync.js never set this field for engagement-created clients; see
//      the separate sync.js update that now sets it for NEW clients going
//      forward, which doesn't retroactively help existing records like his)
//   4. Sets tagsLocked: true so no future sync run re-adds CPA Lead
//   5. Logs one activity note describing the correction
//
// Safe to run more than once — it always sets the same end state rather
// than toggling, so a second run is a harmless no-op.
//
// Usage: GET /api/debug/fix-chris-brown-tag-v2
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
        note: `No client record found for ${TARGET_EMAIL} — nothing to correct.`,
      });
    }

    const existing = clients[idx];
    const before = { tags: existing.tags || [], leadSource: existing.leadSource || "" };

    clients[idx] = {
      ...existing,
      tags: ["Financial Planner Lead"],
      leadSource: "Financial Planner campaign",
      tagsLocked: true,
    };
    crmData.clients = clients;

    const note = `Corrected ${existing.name || TARGET_EMAIL}'s record — tags locked to Financial Planner Lead, lead source set to Financial Planner campaign (he's a financial advisor, not a CPA; this correction is now protected from future auto-sync overwrites)`;
    crmData.activityLog = [
      { id: crypto.randomBytes(4).toString("hex"), text: note, ts: new Date().toISOString() },
      ...(crmData.activityLog || []),
    ].slice(0, 50);

    await setCache(CRM_DATA_KEY, crmData);

    res.status(200).json({
      ok: true,
      found: true,
      before,
      after: { tags: clients[idx].tags, leadSource: clients[idx].leadSource, tagsLocked: clients[idx].tagsLocked },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
