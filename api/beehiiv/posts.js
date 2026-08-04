// Cache-only, same reasoning as api/zoho/campaigns.js — only /api/cron/sync
// talks to Beehiiv's post-stats endpoint directly. Viewing the Performance
// tab should never itself be able to trigger a live Beehiiv API call.
const { getCache } = require("../../lib/store");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const items = await getCache("cache:newsletterPosts", []);
    res.status(200).json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
