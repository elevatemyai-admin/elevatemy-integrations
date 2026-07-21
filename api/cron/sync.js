// Runs on a schedule (see vercel.json) so the CRM's Import tab and dashboard
// are always reading fresh data instead of hitting live APIs on every click.
// Vercel Cron calls this automatically with an Authorization header matching
// CRON_SECRET — verified below so nobody else can trigger it.

const crypto = require("crypto");
const { getCache, setCache } = require("../../lib/store");
const { fetchZohoCampaigns, fetchZohoLeadsBySource, fetchZohoCampaignClickers, fetchZohoCampaignOpeners } = require("../../lib/zoho");
const { fetchHubspotAssessments } = require("../../lib/hubspot");
const { fetchBeehiivSubscribers } = require("../../lib/beehiiv");

// Same key api/crm/data.js reads/writes — kept as a literal string in both
// places rather than a shared import, since api/*.js files are deployed as
// independent serverless functions and don't share a module graph.
const CRM_DATA_KEY = "crm:data";

function authorized(req) {
  if (!process.env.CRON_SECRET) return true; // no secret set — open (fine for local testing only)
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const jobs = [
    ["cache:campaigns", fetchZohoCampaigns],
    ["cache:cpaLeads", () => fetchZohoLeadsBySource(process.env.ZOHO_CPA_LEAD_SOURCE || "CPA Campaign")],
    ["cache:socialLeads", () => fetchZohoLeadsBySource(process.env.ZOHO_SOCIAL_LEAD_SOURCE || "Social Media")],
    ["cache:campaignClickers", fetchZohoCampaignClickers],
    ["cache:campaignOpeners", fetchZohoCampaignOpeners],
    ["cache:assessments", fetchHubspotAssessments],
    ["cache:subscribers", fetchBeehiivSubscribers],
  ];

  const results = {};
  for (const [key, fn] of jobs) {
    let items;
    try {
      items = await fn();
    } catch (e) {
      // The upstream fetch (Zoho/HubSpot/Beehiiv) itself failed.
      results[key] = { ok: false, stage: "fetch", error: e.message };
      console.error(`[sync] ${key} fetch failed:`, e.message);
      continue;
    }

    try {
      await setCache(key, items);
      // Only report ok:true once BOTH the fetch and the KV write succeeded.
      results[key] = { ok: true, count: Array.isArray(items) ? items.length : undefined };
      // TEMP — surface raw per-variant report entries to find A/B sub-campaign
      // keys. Remove once confirmed.
      if (key === "cache:campaigns" && items && items._debugRawReports) {
        results["debug:rawCampaignReports"] = items._debugRawReports;
      }
    } catch (e) {
      // The fetch worked but writing to KV failed — this is the case that
      // was previously invisible: sync.js used to report {ok:true} here
      // because it never checked whether setCache actually succeeded.
      results[key] = { ok: false, stage: "kv-write", fetchedCount: Array.isArray(items) ? items.length : undefined, error: e.message };
      console.error(`[sync] ${key} KV write failed:`, e.message);
    }
  }

  // Turn campaign opens/clicks into real client records — automatically,
  // on every sync. Opens create a brand-new "prospect"; clicks create a
  // brand-new "opportunity" OR upgrade an existing lead/contact up to
  // opportunity. Never downgrades or touches an existing "active"/"inactive"
  // client — marketing engagement data should never silently overwrite a
  // real client relationship. Matches api/crm/data.js's client shape.
  //
  // Merged directly into the crm:data blob (not a separate cache:* key +
  // route) for the same reason as before: Vercel Hobby caps a deployment at
  // 12 functions and this project is already at 11.
  const STATUS_TIER = { lead: 1, prospect: 1, opportunity: 2, active: 3, inactive: 3 };

  // Anyone whose engagement traces back to a campaign with "CPA" in its name
  // gets tagged "CPA Lead" — independent of their contact/opportunity status.
  // This is a simple name-match heuristic since there's no other reliable
  // signal from Zoho to distinguish CPA outreach from other campaign types.
  // Override with ZOHO_CPA_CAMPAIGN_MATCH (a regex, case-insensitive) if
  // your actual campaign naming ever changes and "cpa" stops being a safe
  // substring match.
  const CPA_CAMPAIGN_RE = new RegExp(process.env.ZOHO_CPA_CAMPAIGN_MATCH || "cpa", "i");

  function upsertFromEngagement(clients, entry, targetStatus, activityNotes) {
    const email = (entry.email || "").toLowerCase().trim();
    if (!email) return clients;
    const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === email);
    const isCpa = CPA_CAMPAIGN_RE.test(entry.campaignName || "");

    if (idx === -1) {
      // Brand new client — only opens/clicks with no prior record land here.
      // Use Zoho's own separate firstname/lastname fields directly (passed
      // through as entry.firstName/entry.lastName by lib/zoho.js) rather than
      // splitting the combined display name — splitting on whitespace breaks
      // on compound first or last names (e.g. "Mary Ann Smith").
      const firstName = entry.firstName || "";
      const lastName = entry.lastName || "";
      const fullName = entry.name || [firstName, lastName].filter(Boolean).join(" ");
      clients.push({
        // Previously: Buffer.from(email).toString("hex").slice(0, 12) — this
        // truncated to the first 6 BYTES of the raw email (not a hash), so
        // any two emails sharing the same first 6 characters (e.g.
        // "chris.brown@..." and "chris.hardy@...") collided on the exact
        // same id. Hashing first means truncation is safe — collisions would
        // require an actual SHA-256 collision within the truncated space,
        // not just a shared prefix.
        id: `zoho_${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
        name: fullName,
        firstName,
        lastName,
        company: entry.company || "",
        email: entry.email,
        phone: "",
        status: targetStatus,
        tags: isCpa ? ["CPA Lead"] : [],
        createdAt: new Date().toISOString(),
        assessment: { path: "general", completed: false, date: "", categories: {}, overallScore: null, tier: "", grade: "", topOpportunity: "", deliveryModel: "", consultationBooked: false, consultationDate: "", notes: "" },
        newsletter: { subscribed: false, link: "" },
        zoho: { link: entry.campaignLink || "", status: targetStatus, lastSent: (entry.openedAt || entry.clickedAt || "").slice(0, 10) },
        social: [],
        dashboard: { vercelUrl: "", githubUrl: "", lastInterview: "", notes: "" },
        tasks: [],
        billing: [],
      });
      activityNotes.push(`Added ${entry.name || entry.email} as a ${targetStatus}${isCpa ? " (CPA Lead)" : ""} from ${entry.campaignName || "a campaign"}`);
      return clients;
    }

    // Existing client — only move them UP the funnel, never down, and never
    // touch active/inactive (those are manually-managed relationship states).
    // Tags are additive regardless of status tier — a CPA campaign click
    // should tag them even if their status doesn't change this run.
    const existing = clients[idx];
    const currentTier = STATUS_TIER[existing.status] || 1;
    const targetTier = STATUS_TIER[targetStatus];
    const existingTags = existing.tags || [];
    const nextTags = isCpa && !existingTags.includes("CPA Lead") ? [...existingTags, "CPA Lead"] : existingTags;

    // Self-heal firstName/lastName on records THIS sync created (id starts
    // with "zoho_") using Zoho's authoritative firstname/lastname fields —
    // fixes any client created before this splitting logic was corrected,
    // without ever touching a name on a client someone added/edited by hand.
    const isZohoCreated = (existing.id || "").startsWith("zoho_");
    const nameFixNeeded = isZohoCreated && (entry.firstName || entry.lastName) &&
      (existing.firstName !== (entry.firstName || "") || existing.lastName !== (entry.lastName || ""));

    if (targetTier > currentTier || nextTags !== existingTags || nameFixNeeded) {
      clients[idx] = {
        ...existing,
        status: targetTier > currentTier ? targetStatus : existing.status,
        tags: nextTags,
        firstName: nameFixNeeded ? (entry.firstName || "") : existing.firstName,
        lastName: nameFixNeeded ? (entry.lastName || "") : existing.lastName,
        name: nameFixNeeded ? (entry.name || [entry.firstName, entry.lastName].filter(Boolean).join(" ")) : existing.name,
        zoho: { ...existing.zoho, status: targetTier > currentTier ? targetStatus : existing.zoho?.status, link: existing.zoho?.link || entry.campaignLink || "", lastSent: (entry.openedAt || entry.clickedAt || "").slice(0, 10) || existing.zoho?.lastSent || "" },
      };
      if (targetTier > currentTier) {
        activityNotes.push(`${existing.name || existing.email} upgraded to ${targetStatus} (clicked ${entry.campaignName || "a campaign"})`);
      } else if (nextTags !== existingTags) {
        activityNotes.push(`${existing.name || existing.email} tagged CPA Lead (${entry.campaignName || "a campaign"})`);
      } else if (nameFixNeeded) {
        activityNotes.push(`Corrected name for ${entry.email}`);
      }
    }
    return clients;
  }

  try {
    const clickers = results["cache:campaignClickers"]?.ok ? await getCache("cache:campaignClickers", []) : [];
    const openers = results["cache:campaignOpeners"]?.ok ? await getCache("cache:campaignOpeners", []) : [];

    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {} };
    let clients = crmData.clients || [];
    const activityNotes = [];

    // One-time migration: "contact" was renamed to "prospect" (opens are a
    // lower-commitment signal than clicks — someone who merely opens an email
    // isn't yet the same as an active contact, so "prospect" fits better,
    // with "opportunity" reserved for clicks). This status was ONLY ever set
    // automatically by this sync — it was never a manually-selectable option
    // anywhere in the UI — so it's safe to rename on every existing client
    // that has it, no id-prefix safety check needed here.
    let migratedCount = 0;
    clients = clients.map((c) => {
      if (c.status === "contact") {
        migratedCount++;
        return { ...c, status: "prospect", zoho: { ...c.zoho, status: c.zoho?.status === "contact" ? "prospect" : c.zoho?.status } };
      }
      return c;
    });
    if (migratedCount) activityNotes.push(`Renamed ${migratedCount} existing "contact" client${migratedCount === 1 ? "" : "s"} to "prospect"`);

    // Opens first (only ever create new prospects, never touch existing clients)...
    for (const opener of openers) {
      clients = upsertFromEngagement(clients, opener, "prospect", activityNotes);
    }
    // ...then clicks (create new opportunities, or upgrade existing lead/prospect).
    for (const clicker of clickers) {
      clients = upsertFromEngagement(clients, clicker, "opportunity", activityNotes);
    }

    crmData.clients = clients;
    if (activityNotes.length) {
      const newEntries = activityNotes.map((text) => ({ id: crypto.randomBytes(4).toString("hex"), text, ts: new Date().toISOString() }));
      crmData.activityLog = [...newEntries, ...(crmData.activityLog || [])].slice(0, 50);
    }
    await setCache(CRM_DATA_KEY, crmData);

    results["crm:zohoEngagementSync"] = { ok: true, changes: activityNotes.length };
  } catch (e) {
    results["crm:zohoEngagementSync"] = { ok: false, error: e.message };
    console.error("[sync] upserting contacts/opportunities into crm:data failed:", e.message);
  }

  // Beehiiv newsletter subscribers: enrich an EXISTING client's newsletter
  // stats if their email already matches one in the CRM, OR create a
  // brand-new client (status "opportunity" — a newsletter subscriber is
  // treated as further along than a bare campaign open) if no match exists. This
  // used to only enrich, never create — changed on request so every
  // subscriber ends up in the CRM. Stats are lifetime aggregates (open rate,
  // click-through rate, emails received) — see the comment in lib/beehiiv.js
  // for why there's no timestamp: Beehiiv's public API doesn't expose one.
  // Beehiiv also has no reliable first/last name field (only an optional,
  // publication-specific custom field) — whatever "name" string is available
  // is used as-is, not split, since there's nothing reliable to split.
  try {
    const subscribers = results["cache:subscribers"]?.ok ? await getCache("cache:subscribers", []) : [];
    if (subscribers.length) {
      const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {} };
      let clients = crmData.clients || [];
      let enrichedCount = 0;
      let createdCount = 0;
      const beehiivActivityNotes = [];

      for (const sub of subscribers) {
        const subEmail = (sub.email || "").toLowerCase().trim();
        if (!subEmail) continue;
        const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === subEmail);
        const newsletterFields = {
          subscribed: true,
          openRate: sub.openRate,
          clickThroughRate: sub.clickThroughRate,
          emailsReceived: sub.emailsReceived,
          statsAsOf: new Date().toISOString(), // when THIS sync ran, not an actual open/click time
        };

        if (idx === -1) {
          clients.push({
            // Same fix as the Zoho branch above — hash the email before
            // truncating, instead of truncating raw email bytes, to avoid
            // collisions between emails that merely share a prefix.
            id: `beehiiv_${crypto.createHash("sha256").update(subEmail).digest("hex").slice(0, 16)}`,
            name: sub.name || "",
            firstName: "",
            lastName: "",
            company: "",
            email: sub.email,
            phone: "",
            status: "opportunity",
            tags: [],
            createdAt: new Date().toISOString(),
            assessment: { path: "general", completed: false, date: "", categories: {}, overallScore: null, tier: "", grade: "", topOpportunity: "", deliveryModel: "", consultationBooked: false, consultationDate: "", notes: "" },
            newsletter: newsletterFields,
            zoho: { link: "", status: "not started", lastSent: "" },
            social: [],
            dashboard: { vercelUrl: "", githubUrl: "", lastInterview: "", notes: "" },
            tasks: [],
            billing: [],
            contract: {
              legalName: "", entityType: "", address: "", sameAsContact: false,
              signerName: "", signerTitle: "", signerEmail: "",
              billingContactName: "", billingContactEmail: "",
              package: "", effectiveDate: "", termLength: "", autoRenew: false, scopeNotes: "",
              feeAmount: "", feeFrequency: "monthly", paymentTerms: "",
              status: "draft", signatureLink: "", signedDate: "", signedDocLink: "",
              stripeCustomerId: "", stripeSubscriptionId: "", stripeCheckoutLink: "",
            },
          });
          createdCount++;
          beehiivActivityNotes.push(`Added ${sub.name || sub.email} as an opportunity from Beehiiv`);
        } else {
          // One-time correction: subscribers created before this file changed
          // their default status from "prospect" to "opportunity" are stuck
          // at "prospect" forever otherwise — this branch never used to touch
          // status at all. Only upgrades records THIS importer created (id
          // starts with "beehiiv_"), and only ever upgrades, never downgrades
          // an active/inactive client.
          const existing = clients[idx];
          const isBeehiivCreated = (existing.id || "").startsWith("beehiiv_");
          const statusFix = isBeehiivCreated && existing.status === "prospect" ? "opportunity" : existing.status;
          clients[idx] = { ...existing, status: statusFix, newsletter: { ...existing.newsletter, ...newsletterFields } };
          if (statusFix !== existing.status) beehiivActivityNotes.push(`${existing.name || existing.email} upgraded to opportunity (Beehiiv subscriber)`);
          enrichedCount++;
        }
      }

      crmData.clients = clients;
      if (beehiivActivityNotes.length) {
        const newEntries = beehiivActivityNotes.map((text) => ({ id: crypto.randomBytes(4).toString("hex"), text, ts: new Date().toISOString() }));
        crmData.activityLog = [...newEntries, ...(crmData.activityLog || [])].slice(0, 50);
      }
      await setCache(CRM_DATA_KEY, crmData);
      results["crm:beehiivEnrichment"] = { ok: true, enriched: enrichedCount, created: createdCount };
    } else {
      results["crm:beehiivEnrichment"] = { ok: true, enriched: 0, created: 0 };
    }
  } catch (e) {
    results["crm:beehiivEnrichment"] = { ok: false, error: e.message };
    console.error("[sync] enriching clients with Beehiiv stats failed:", e.message);
  }

  try {
    await setCache("cache:lastSyncedAt", new Date().toISOString());
  } catch (e) {
    console.error("[sync] failed to write lastSyncedAt:", e.message);
  }

  res.status(200).json({ syncedAt: new Date().toISOString(), results });
};
