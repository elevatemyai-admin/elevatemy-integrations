// Approves (and, for emails, actually sends/schedules via Zoho) or rejects
// a pending Marketing Hub content item. Nothing an AI drafts ever goes out
// without a human approving here first — same trust model as
// api/gmail/approve.js for email replies.

const { getCache, setCache } = require("../../lib/store");
const { createCampaign, sendCampaignNow, scheduleCampaign, TIER_LIST_KEYS } = require("../../lib/zoho");

const CRM_DATA_KEY = "crm:data";
const FROM_EMAIL = process.env.MARKETING_FROM_EMAIL || "tracy@elevatemy.ai";
// Your own deployed CRM's base URL — e.g. https://elevatemy-integrations.vercel.app
// Needed to build the public content_url Zoho's servers fetch the HTML
// from (see api/marketing/render-content.js). Must be set in Vercel env
// vars before email sends will work; social-post approval doesn't need it.
const SITE_BASE_URL = process.env.SITE_BASE_URL;

// No direct, reliable "compose with prefilled text" URL exists for either
// platform's organic posting flow as of this writing — both have removed
// or restricted text-prefill params over the years for anti-spam reasons.
// So this is copy-the-text-then-open-the-composer, not a single magic
// link. Worth re-checking if either platform changes this later.
const PLATFORM_COMPOSE_LINKS = {
  linkedin_post: "https://www.linkedin.com/feed/?shareActive=true",
  facebook_post: "https://www.facebook.com/",
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { itemId, action, editedSubject, editedBody, scheduledFor, targetTier: overrideTier } = req.body || {};
  if (!itemId || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "itemId and action ('approve' or 'reject') are required" });
  }

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || {};
    if (!crmData.marketingHub) crmData.marketingHub = { campaigns: [], contentItems: [] };
    const items = crmData.marketingHub.contentItems;
    const idx = items.findIndex((c) => c.id === itemId);
    if (idx === -1) return res.status(404).json({ error: "Content item not found — it may have already been approved or rejected" });

    const item = items[idx];

    if (action === "reject") {
      items[idx] = { ...item, status: "rejected", rejectedAt: new Date().toISOString() };
      await setCache(CRM_DATA_KEY, crmData);
      return res.status(200).json({ ok: true, action: "rejected" });
    }

    // action === "approve" — track how much a human had to edit the AI's
    // draft. This is the same maturity signal discussed for the email
    // agent: as edits shrink over time, that's the trigger to eventually
    // let a content type auto-approve without a human step.
    const finalSubject = editedSubject != null ? editedSubject : item.subject;
    const finalBody = editedBody != null ? editedBody : item.body;
    const wasEdited = finalSubject !== item.subject || finalBody !== item.body;

    if (item.type === "email") {
      const tier = overrideTier || item.targetTier;
      const listKey = tier ? TIER_LIST_KEYS[tier] : null;
      if (!listKey) {
        items[idx] = { ...item, subject: finalSubject, body: finalBody, wasEdited, targetTier: tier || item.targetTier, status: "approved", approvedAt: new Date().toISOString() };
        await setCache(CRM_DATA_KEY, crmData);
        return res.status(200).json({ ok: true, action: "approved", note: "Approved, but no valid target tier is set yet — pick one, then approve again to actually send." });
      }
      if (!SITE_BASE_URL) {
        return res.status(500).json({ error: "SITE_BASE_URL env var not set — required to build the public content URL Zoho fetches from" });
      }

      // Mark approved BEFORE calling Zoho: render-content.js only serves
      // items already at approved/scheduled/sent status, and Zoho fetches
      // that URL itself immediately inside createCampaign, so the flag
      // must already be flipped by the time that call goes out.
      items[idx] = { ...item, subject: finalSubject, body: finalBody, wasEdited, targetTier: tier, status: "approved", approvedAt: new Date().toISOString() };
      await setCache(CRM_DATA_KEY, crmData);

      try {
        const contentUrl = `${SITE_BASE_URL}/api/marketing/render-content?id=${item.id}`;
        const { campaignKey } = await createCampaign({
          name: finalSubject || `Campaign ${item.id}`,
          subject: finalSubject,
          fromEmail: FROM_EMAIL,
          listKey,
          contentUrl,
        });

        if (scheduledFor) {
          await scheduleCampaign(campaignKey, scheduledFor);
          items[idx] = { ...items[idx], status: "scheduled", zohoCampaignKey: campaignKey, scheduledFor };
        } else {
          await sendCampaignNow(campaignKey);
          items[idx] = { ...items[idx], status: "sent", zohoCampaignKey: campaignKey, sentAt: new Date().toISOString() };
        }
        crmData.marketingHub.contentItems = items;
        await setCache(CRM_DATA_KEY, crmData);
        return res.status(200).json({ ok: true, action: scheduledFor ? "scheduled" : "sent", campaignKey });
      } catch (e) {
        // Approved in our system already, but the Zoho call itself failed —
        // surface this clearly rather than silently leaving it stuck.
        console.error("[marketing/approve] Zoho send failed:", e.message);
        return res.status(502).json({ error: "Approved, but sending via Zoho failed: " + e.message, status: "approved" });
      }
    }

    // Social posts — per current scope, no direct auto-posting yet. Mark
    // approved/ready and hand back the drafted text plus a link to the
    // platform's composer (see PLATFORM_COMPOSE_LINKS note above on why
    // this is copy + open, not a single prefilled link).
    items[idx] = { ...item, subject: finalSubject, body: finalBody, wasEdited, status: "approved", approvedAt: new Date().toISOString() };
    crmData.marketingHub.contentItems = items;
    await setCache(CRM_DATA_KEY, crmData);
    return res.status(200).json({
      ok: true,
      action: "approved",
      body: finalBody,
      postLink: PLATFORM_COMPOSE_LINKS[item.type] || null,
      note: "Copy the text, then use the link to open the platform's post composer — most platforms don't support prefilling post text via URL, so this is a copy-then-paste step, not a single auto-fill link.",
    });
  } catch (e) {
    console.error("[marketing/approve] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
};
