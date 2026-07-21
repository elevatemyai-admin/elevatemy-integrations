// Cache-only by design: this route NEVER calls Zoho directly, even if the
// cache is empty. Only /api/cron/sync talks to Zoho's API. That way, simply
// viewing campaign data in the CRM can never itself trigger a rate limit —
// worth it, since a first-run empty cache (before sync has run once) is a
// much smaller problem than accidentally hammering Zoho's API on page loads.
const { getCache } = require("../../lib/store");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const items = await getCache("cache:campaigns", []);
    res.status(200).json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
