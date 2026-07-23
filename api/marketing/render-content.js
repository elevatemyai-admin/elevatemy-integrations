// PUBLIC, deliberately unauthenticated — Zoho Campaigns' createCampaign API
// requires a content_url it fetches itself with no way to pass an auth
// header, so this route can't have a CRON_SECRET-style gate like the other
// api/*.js routes do.
//
// Mitigations given that: only ever serves items already at status
// approved/scheduled/sent — never raw drafts — and content item ids are
// opaque random hex strings (crypto.randomBytes, generated in
// api/marketing/generate.js), not sequential or guessable. This is "not
// indexed/not guessable" rather than truly access-controlled — acceptable
// here since the content itself is just marketing copy, not sensitive
// client data, but worth keeping in mind if that ever changes.

const { getCache } = require("../../lib/store");
const { contentToHtml } = require("../../lib/zoho");

const CRM_DATA_KEY = "crm:data";

module.exports = async (req, res) => {
  const { id } = req.query || {};
  if (!id) return res.status(400).send("Missing id");

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || {};
    const items = (crmData.marketingHub && crmData.marketingHub.contentItems) || [];
    const item = items.find((c) => c.id === id);

    if (!item || !["approved", "scheduled", "sent"].includes(item.status)) {
      return res.status(404).send("Not found");
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(contentToHtml(item.body));
  } catch (e) {
    console.error("[marketing/render-content] failed:", e.message);
    res.status(500).send("Error rendering content");
  }
};
