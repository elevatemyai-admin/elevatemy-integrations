// Generates a new AI-drafted content item (email, LinkedIn post, or
// Facebook post) and drops it into the Marketing Hub's pending-approval
// queue. Never sends or publishes anything itself — see
// api/marketing/approve.js for the human-in-the-loop step that does.

const { getCache, setCache } = require("../../lib/store");
const { draftContent } = require("../../lib/contentAgent");
const crypto = require("crypto");

const CRM_DATA_KEY = "crm:data";
const VALID_TYPES = ["email", "linkedin_post", "facebook_post"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { campaignId, type, brief, targetListKey } = req.body || {};
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
  }

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || {};
    if (!crmData.marketingHub) crmData.marketingHub = { campaigns: [], contentItems: [] };

    const campaign = campaignId ? crmData.marketingHub.campaigns.find((c) => c.id === campaignId) : null;
    if (campaignId && !campaign) return res.status(404).json({ error: "Campaign not found" });

    // Separate library from the email-reply templates (lib/claude.js uses
    // crmData.emailTemplates) — marketing content wants its own brand-voice
    // examples, not reply-tone ones. Fine if this doesn't exist yet; the
    // content agent writes from scratch with sensible defaults either way.
    const templates = crmData.marketingTemplates || [];

    let draft;
    try {
      draft = await draftContent({ type, campaign, brief, templates });
    } catch (e) {
      return res.status(502).json({ error: "Content generation failed: " + e.message });
    }

    const item = {
      id: crypto.randomBytes(6).toString("hex"),
      campaignId: campaignId || null,
      type,
      status: "pending_approval", // pending_approval | approved | scheduled | sent | rejected
      subject: draft.subject || "",
      body: draft.body,
      targetListKey: targetListKey || "", // only meaningful for type === "email"
      aiGenerated: true,
      wasEdited: false,
      createdAt: new Date().toISOString(),
    };

    crmData.marketingHub.contentItems = [item, ...crmData.marketingHub.contentItems];
    await setCache(CRM_DATA_KEY, crmData);
    res.status(200).json({ ok: true, item });
  } catch (e) {
    console.error("[marketing/generate] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
};
