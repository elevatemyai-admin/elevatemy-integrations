// ONE-TIME RESET — delete this file after running it once.
//
// Clears the engagementNurture flag on every CPA Lead-tagged client, so the
// NEXT scheduled /api/cron/sync run (already running automatically every
// 10 minutes — no change needed there) treats them as brand-new again and
// re-attempts the real Zoho listsubscribe call. This does not touch
// anything else about the client record (status, tags, history, etc.) —
// only the enrollment flag that was blocking retries.
//
// Safe to run more than once — if enrollment already genuinely succeeded
// for someone, re-calling listsubscribe for them is a harmless no-op on
// Zoho's side (per the existing code's own comments).
//
// Usage: GET /api/debug/reset-nurture-flags
// Protected the same way as cron — requires the CRON_SECRET bearer token.

const { getCache, setCache } = require("../../lib/store");

const CRM_DATA_KEY = "crm:data";

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const crmData = await getCache(CRM_DATA_KEY, null);
    if (!crmData) return res.status(404).json({ error: "no crm:data found in cache" });

    let resetCount = 0;
    const clients = (crmData.clients || []).map((c) => {
      if (c.engagementNurture && (c.tags || []).includes("CPA Lead")) {
        resetCount++;
        const { engagementNurture, ...rest } = c;
        return rest;
      }
      return c;
    });

    crmData.clients = clients;
    await setCache(CRM_DATA_KEY, crmData);

    res.status(200).json({
      ok: true,
      resetCount,
      note: "engagementNurture cleared for these clients — next /api/cron/sync run will re-attempt enrollment automatically",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
