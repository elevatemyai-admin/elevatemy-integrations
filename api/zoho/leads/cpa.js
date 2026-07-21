// Cache-only — see api/zoho/campaigns.js for why.
const { getCache } = require("../../../lib/store");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const items = await getCache("cache:cpaLeads", []);
    res.status(200).json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
