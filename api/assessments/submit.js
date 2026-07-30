// This is the endpoint the rebuilt (non-HubSpot) assessment tool POSTs to
// the moment someone finishes. On every submission it:
//   1. Auto-creates or updates a real client record in the CRM immediately
//      (status "opportunity" — completing a full assessment is at least as
//      strong a signal as a campaign click, same reasoning used for that).
//      Matches the same never-downgrade-active/inactive pattern used
//      everywhere else in this CRM.
//   2. Still writes to cache:assessments too, for backward compatibility
//      with the Import tab and anything else reading from it.
//   3. Adds the contact to the matching tier's Zoho Campaigns nurture list,
//      so Zoho sends the immediate results email + delayed nurture email
//      automatically (once those lists/autoresponders exist in Zoho).
//
// This is the replacement for /api/hubspot/assessments going forward. Keep
// that route around only for a one-time historical import of contacts who
// completed the assessment while it still lived on HubSpot.
//
// EXPECTED PAYLOAD SHAPE (flat JSON, not HubSpot's field-array format):
// {
//   firstName, lastName, email, company, phone,
//   path: "general" | "financial",
//   tier: "Emerging" (display label, matches the CRM's tier dropdown exactly),
//   overallScore: 69,
//   categories: { bf: 75, dt: 67, oa: 67, cg: 67, air: 67 }  (general track keys)
//               or financial-track equivalent keys,
//   topOpportunity: "Data & Technology",
//   resultsUrl: "https://.../general/results?...",
//   submissionToken: "1782315059993"
// }

const { getCache, setCache } = require("../../lib/store");
const { addContactToNurtureList } = require("../../lib/zoho");
const crypto = require("crypto");

const CRM_DATA_KEY = "crm:data"; // same key used by api/crm/data.js and api/cron/sync.js
const STATUS_TIER = { lead: 1, prospect: 1, opportunity: 2, active: 3, inactive: 3 };

function corsHeaders(res) {
  // Loosen this to your actual assessment tool's domain once it's deployed,
  // e.g. res.setHeader("Access-Control-Allow-Origin", "https://elevatemy.ai")
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function emptyClientShape() {
  return {
    tags: [], hidden: false, proBono: false,
    website: "",
    newsletter: { subscribed: false, link: "" },
    zoho: { link: "", status: "not started", lastSent: "" },
    engagementHistory: [],
    social: [],
    dashboard: { vercelUrl: "", githubUrl: "", lastInterview: "", notes: "" },
    tasks: [], billing: [],
    contract: {
      legalName: "", entityType: "", address: "", sameAsContact: false,
      signerName: "", signerTitle: "", signerEmail: "",
      billingContactName: "", billingContactEmail: "",
      package: "", effectiveDate: "", termLength: "", autoRenew: false, scopeNotes: "",
      feeAmount: "", feeFrequency: "monthly", paymentTerms: "",
      status: "draft", signatureLink: "", signedDate: "", signedDocLink: "",
      stripeCustomerId: "", stripeSubscriptionId: "", stripeCheckoutLink: "",
    },
  };
}

module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = req.body || {};
  const {
    firstName, lastName, email, phone, company, path,
    tier, overallScore, categories, topOpportunity, deliveryModel,
    resultsUrl, submissionToken,
  } = body;

  if (!email) return res.status(400).json({ error: "email is required" });

  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const record = {
    id: email.toLowerCase().trim(),
    name: fullName,
    email,
    phone: phone || "",
    company: company || "",
    path: path || "general",
    tier: tier || "",
    overallScore: overallScore != null ? Number(overallScore) : null,
    categories: categories || {},
    topOpportunity: topOpportunity || "",
    deliveryModel: deliveryModel || "",
    resultsUrl: resultsUrl || "",
    submissionToken: submissionToken || "",
    completedAt: new Date().toISOString(),
  };

  // 1. Cache write — kept for backward compatibility with the Import tab.
  try {
    const existing = await getCache("cache:assessments", []);
    const next = [record, ...existing.filter((r) => r.id !== record.id)];
    await setCache("cache:assessments", next);
  } catch (e) {
    console.error("[assessments/submit] cache write failed:", e.message);
  }

  // 2. Zoho nurture list add — fires the immediate + delayed emails once
  // the corresponding list/autoresponder exists in Zoho Campaigns. Run
  // this BEFORE the CRM write below so we can log a guaranteed
  // "enrolled in nurture list" event on the client record in the same
  // write — this is real, code-controlled activity, unlike email
  // opens/clicks on Zoho Workflow-triggered sends, which aren't confirmed
  // to be trackable back to a per-contact history the way regular
  // Campaign clicks/opens are (see lib/zoho.js's fetchZohoCampaignClickers
  // comments).
  let nurtureResult = { skipped: true };
  try {
    nurtureResult = await addContactToNurtureList(record);
  } catch (e) {
    console.error("[assessments/submit] Zoho nurture add failed:", e.message);
  }

  // 3. Auto-create/update the real client record immediately.
  let crmResult = { ok: false };
  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
    const clients = crmData.clients || [];
    const emailKey = email.toLowerCase().trim();
    const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === emailKey);

    const assessment = {
      path: record.path,
      completed: true,
      date: record.completedAt.slice(0, 10),
      categories: record.categories,
      overallScore: record.overallScore,
      tier: record.tier,
      grade: "",
      topOpportunity: record.topOpportunity,
      deliveryModel: record.deliveryModel,
      consultationBooked: false,
      consultationDate: "",
      notes: resultsUrl ? `Results: ${resultsUrl}` : "",
    };

    // Only log a real, confirmed enrollment event — not a guess at whether
    // the email actually sent or was opened.
    const enrollmentEvent = nurtureResult && nurtureResult.ok !== false && !nurtureResult.skipped
      ? [{ type: "email_enrolled", campaignName: `${record.path === "financial" ? "FP" : "General"} - ${record.tier} nurture list`, ts: record.completedAt }]
      : [];

    let activityText;
    if (idx === -1) {
      clients.push({
        id: `assess_${Buffer.from(emailKey).toString("hex").slice(0, 12)}`,
        name: fullName,
        firstName: firstName || "",
        lastName: lastName || "",
        company: company || "",
        email,
        phone: phone || "",
        status: "opportunity",
        createdAt: new Date().toISOString(),
        assessment,
        ...emptyClientShape(),
        engagementHistory: enrollmentEvent,
      });
      activityText = `${fullName || email} completed the ${assessment.path} assessment (new client)`;
    } else {
      const existing = clients[idx];
      const currentTier = STATUS_TIER[existing.status] || 1;
      const nextStatus = currentTier < STATUS_TIER.opportunity ? "opportunity" : existing.status;
      // FIXED: previously only status + assessment were updated here, so a
      // completed assessment's fresh name/company/phone was silently
      // discarded whenever the person already existed as a client (e.g.
      // from an earlier campaign import with those fields blank). A
      // completed assessment is a direct, authoritative signal from the
      // person themselves, so it should be allowed to fill in/update these
      // fields — but only when the new value is non-empty, so we never
      // overwrite a real existing value with a blank one.
      clients[idx] = {
        ...existing,
        status: nextStatus,
        assessment,
        name: fullName || existing.name,
        firstName: firstName || existing.firstName,
        lastName: lastName || existing.lastName,
        company: company || existing.company,
        phone: phone || existing.phone,
        engagementHistory: [...(existing.engagementHistory || []), ...enrollmentEvent].slice(-100),
      };
      activityText = `${existing.name || email} completed the ${assessment.path} assessment`;
    }

    crmData.clients = clients;
    crmData.activityLog = [
      { id: crypto.randomBytes(4).toString("hex"), text: activityText, ts: new Date().toISOString() },
      ...(crmData.activityLog || []),
    ].slice(0, 300);
    await setCache(CRM_DATA_KEY, crmData);
    crmResult = { ok: true, created: idx === -1 };
  } catch (e) {
    console.error("[assessments/submit] CRM client upsert failed:", e.message);
    crmResult = { ok: false, error: e.message };
  }

  res.status(200).json({ ok: true, crm: crmResult, nurture: nurtureResult });
};
