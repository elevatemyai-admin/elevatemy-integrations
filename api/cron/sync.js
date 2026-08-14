// Runs on a schedule (see vercel.json) so the CRM's Import tab and dashboard
// are always reading fresh data instead of hitting live APIs on every click.
// Vercel Cron calls this automatically with an Authorization header matching
// CRON_SECRET — verified below so nobody else can trigger it.

const crypto = require("crypto");
const { getCache, setCache } = require("../../lib/store");
const { fetchZohoCampaigns, fetchZohoLeadsBySource, fetchZohoCampaignClickers, fetchZohoCampaignOpeners, addContactToEngagementNurture, removeContactFromRegularCpaList, fetchNurtureMessageEngagement } = require("../../lib/zoho");
const { fetchBeehiivSubscribers } = require("../../lib/beehiiv");
const { fetchRecentIncomingEmails, fetchRecentSentEmails } = require("../../lib/gmail");
const { draftReply } = require("../../lib/claude");

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
    // cache:assessments (HubSpot) removed — the one-time historical import
    // is done, and all new assessments now come in directly through the
    // CRM's own api/assessments/submit.js, not HubSpot. This job was just
    // failing every run with an auth error for data no longer needed here.
    ["cache:subscribers", fetchBeehiivSubscribers],
  ];

  const results = {};
  for (const [key, fn] of jobs) {
    let items;
    try {
      items = await fn();
    } catch (e) {
      // The upstream fetch (Zoho/Beehiiv) itself failed.
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

  // Same heuristic, for financial planner/advisor outreach — independent
  // regex since a contact could in principle match neither, either, or
  // (rarely) both patterns. Default pattern covers "financial planner",
  // "financial advisor", and a bare "FP" campaign-name prefix (matching
  // the existing FP-tier assessment lists' naming convention). Override
  // with ZOHO_FP_CAMPAIGN_MATCH if actual campaign naming differs.
  const FP_CAMPAIGN_RE = new RegExp(process.env.ZOHO_FP_CAMPAIGN_MATCH || "financial.?planner|financial.?advisor|\\bfp\\b", "i");

  function upsertFromEngagement(clients, entry, targetStatus, activityNotes) {
    const email = (entry.email || "").toLowerCase().trim();
    if (!email) return clients;
    const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === email);
    const isCpa = CPA_CAMPAIGN_RE.test(entry.campaignName || "");
    const isFp = FP_CAMPAIGN_RE.test(entry.campaignName || "");

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
        tags: [...(isCpa ? ["CPA Lead"] : []), ...(isFp ? ["Financial Planner Lead"] : [])],
        // Matches the LEAD_SOURCES dropdown options in the CRM UI exactly
        // ("CPA campaign" / "Financial Planner campaign") — previously this
        // field was never set for engagement-created clients at all, so it
        // sat blank even when the campaign source was known. If a contact
        // matches neither pattern, leave it unset for manual entry, same as
        // before.
        leadSource: isCpa ? "CPA campaign" : (isFp ? "Financial Planner campaign" : ""),
        createdAt: new Date().toISOString(),
        assessment: { path: "general", completed: false, date: "", categories: {}, overallScore: null, tier: "", grade: "", topOpportunity: "", deliveryModel: "", consultationBooked: false, consultationDate: "", notes: "" },
        newsletter: { subscribed: false, link: "" },
        zoho: { link: entry.campaignLink || "", status: targetStatus, lastSent: (entry.openedAt || entry.clickedAt || "").slice(0, 10) },
        // Real per-contact click/open history, not just a single "last
        // sent" date — powers the client detail "Recent activity" tab.
        engagementHistory: (entry.events || []).slice(-100),
        social: [],
        dashboard: { vercelUrl: "", githubUrl: "", lastInterview: "", notes: "" },
        tasks: [],
        billing: [],
      });
      const leadTagNote = [isCpa && "CPA Lead", isFp && "Financial Planner Lead"].filter(Boolean).join(", ");
      activityNotes.push(`Added ${entry.name || entry.email} as a ${targetStatus}${leadTagNote ? ` (${leadTagNote})` : ""} from ${entry.campaignName || "a campaign"}`);
      return clients;
    }

    // Existing client — only move them UP the funnel, never down, and never
    // touch active/inactive (those are manually-managed relationship states).
    // Tags are additive regardless of status tier — a CPA campaign click
    // should tag them even if their status doesn't change this run.
    //
    // tagsLocked is a manual escape hatch: without it, this auto-tagging
    // logic re-derives isCpa/isFp from campaign name on EVERY sync run, so
    // a one-off manual correction (e.g. removing a wrong "CPA Lead" tag
    // from someone who was on the wrong list by mistake, like a financial
    // planner who received CPA outreach) gets silently re-added the very
    // next time sync runs — the underlying campaign-name match never
    // changes, so nothing here previously remembered that a human already
    // fixed it. Once tagsLocked is true on a client record, this whole
    // auto-tag block is skipped entirely for them — their tags become
    // fully manually managed going forward, until someone unsets the flag.
    const existing = clients[idx];
    const currentTier = STATUS_TIER[existing.status] || 1;
    const targetTier = STATUS_TIER[targetStatus];
    const existingTags = existing.tags || [];
    let nextTags = existingTags;
    const newlyAddedTagNames = [];
    if (!existing.tagsLocked) {
      if (isCpa && !existingTags.includes("CPA Lead")) {
        nextTags = [...nextTags, "CPA Lead"];
        newlyAddedTagNames.push("CPA Lead");
      }
      if (isFp && !existingTags.includes("Financial Planner Lead")) {
        nextTags = [...nextTags, "Financial Planner Lead"];
        newlyAddedTagNames.push("Financial Planner Lead");
      }
    }

    // Self-heal firstName/lastName on records THIS sync created (id starts
    // with "zoho_") using Zoho's authoritative firstname/lastname fields —
    // fixes any client created before this splitting logic was corrected,
    // without ever touching a name on a client someone added/edited by hand.
    const isZohoCreated = (existing.id || "").startsWith("zoho_");
    const nameFixNeeded = isZohoCreated && (entry.firstName || entry.lastName) &&
      (existing.firstName !== (entry.firstName || "") || existing.lastName !== (entry.lastName || ""));

    // Engagement history should grow every time someone opens/clicks again,
    // independent of whether that changes their status tier — a returning
    // Opportunity clicking a 3rd campaign is still real activity worth
    // showing on their record, even though their tier doesn't move.
    const existingHistory = existing.engagementHistory || [];
    const incomingEvents = entry.events || [];
    const seen = new Set(existingHistory.map(e => `${e.type}|${e.campaignName}|${e.ts}`));
    const newEvents = incomingEvents.filter(e => !seen.has(`${e.type}|${e.campaignName}|${e.ts}`));
    const nextHistory = newEvents.length ? [...existingHistory, ...newEvents].slice(-100) : existingHistory;

    if (targetTier > currentTier || nextTags !== existingTags || nameFixNeeded || newEvents.length) {
      clients[idx] = {
        ...existing,
        status: targetTier > currentTier ? targetStatus : existing.status,
        tags: nextTags,
        firstName: nameFixNeeded ? (entry.firstName || "") : existing.firstName,
        lastName: nameFixNeeded ? (entry.lastName || "") : existing.lastName,
        name: nameFixNeeded ? (entry.name || [entry.firstName, entry.lastName].filter(Boolean).join(" ")) : existing.name,
        engagementHistory: nextHistory,
        zoho: { ...existing.zoho, status: targetTier > currentTier ? targetStatus : existing.zoho?.status, link: existing.zoho?.link || entry.campaignLink || "", lastSent: (entry.openedAt || entry.clickedAt || "").slice(0, 10) || existing.zoho?.lastSent || "" },
      };
      if (targetTier > currentTier) {
        activityNotes.push(`${existing.name || existing.email} upgraded to ${targetStatus} (clicked ${entry.campaignName || "a campaign"})`);
      } else if (nextTags !== existingTags) {
        activityNotes.push(`${existing.name || existing.email} tagged ${newlyAddedTagNames.join(", ")} (${entry.campaignName || "a campaign"})`);
      } else if (nameFixNeeded) {
        activityNotes.push(`Corrected name for ${entry.email}`);
      }
    }
    return clients;
  }

  // Enrolls a contact in the appropriate Zoho nurture list (opened or
  // clicked) and removes them from the regular cold-send list, once per
  // contact per kind — guarded by engagementNurture[kind] so a contact
  // already enrolled doesn't get re-processed (re-adding an already-
  // subscribed Zoho contact is harmless, but calling the API twice a day
  // for the same ~1,200 contacts is wasteful, and more importantly avoids
  // risking a re-trigger of the "On List Entry" workflow message sequence
  // for someone already partway through it).
  async function enrollInNurtureAndDropFromRegularList(clients, entry, kind, activityNotes) {
    const email = (entry.email || "").toLowerCase().trim();
    const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === email);
    if (idx === -1) return clients; // shouldn't happen — upsertFromEngagement just created/updated this record

    const existing = clients[idx];
    const nurture = existing.engagementNurture || {};
    if (nurture[kind]) {
      console.log(`[debug2] SKIP ${kind} ${email} — already flagged enrolled at ${nurture[kind].enrolledAt || "?"}`);
      return clients;
    }

    let nurtureResult = { skipped: true };
    let removeResult = { skipped: true };
    try {
      nurtureResult = await addContactToEngagementNurture(existing, kind);
      console.log(`[debug2] ATTEMPT ${kind} ${email} — raw response: ${JSON.stringify(nurtureResult).slice(0, 300)}`);
    } catch (e) {
      console.error(`[sync] engagement nurture add (${kind}) failed for ${email}:`, e.message);
    }
    try {
      removeResult = await removeContactFromRegularCpaList(email);
    } catch (e) {
      console.error(`[sync] regular-list removal failed for ${email}:`, e.message);
    }

    clients[idx] = {
      ...existing,
      engagementNurture: {
        ...nurture,
        [kind]: {
          enrolledAt: new Date().toISOString(),
          nurtureOk: nurtureResult && nurtureResult.ok !== false && !nurtureResult.skipped,
          removedFromRegularList: removeResult && removeResult.ok !== false && !removeResult.skipped,
        },
      },
    };

    if (nurtureResult && !nurtureResult.skipped) {
      activityNotes.push(`${existing.name || email} enrolled in ${kind} nurture and dropped from the regular CPA list`);
    }
    return clients;
  }

  // Marks a contact's CRM tags with "Completed - Opened Nurture" /
  // "Completed - Clicked Nurture" once enough time has passed since they
  // were enrolled (engagementNurture[kind].enrolledAt) for the whole Zoho
  // "On List Entry" message sequence to have finished sending.
  //
  // This is a TIME-BASED estimate, not a live check against Zoho. Zoho's
  // own workflow already removes the contact from the list as its own
  // final action (Tag Contact + Remove from List, added directly in the
  // Zoho workflow builder) — that's what actually frees room on the list
  // and marks them "Exited" in Zoho's own reporting. This function exists
  // purely because Zoho's native contact tags don't sync back into this
  // CRM's `tags` array automatically — completion needs its own signal
  // here, independent of what Zoho does on its side.
  //
  // IMPORTANT: these day counts must be >= the sum of every Wait step's
  // duration in the matching Zoho workflow, plus a small buffer for send
  // lag (a day or two is plenty). If the Wait durations in Zoho ever
  // change, update the matching env var too — otherwise contacts could
  // get tagged "Completed" in the CRM before they've actually received
  // the last real email.
  const NURTURE_COMPLETION_DAYS = {
    opened: Number(process.env.NURTURE_COMPLETION_DAYS_OPENED || 14),
    clicked: Number(process.env.NURTURE_COMPLETION_DAYS_CLICKED || 14),
  };
  const NURTURE_COMPLETION_TAG = {
    opened: "Completed - Opened Nurture",
    clicked: "Completed - Clicked Nurture",
  };

  // Only tags contacts who were actually successfully enrolled
  // (nurture.nurtureOk — mirrors the same success flag already written by
  // enrollInNurtureAndDropFromRegularList above) and haven't already been
  // tagged complete (nurture.completedAt guards against re-tagging/
  // re-logging the same contact every single sync run once they pass the
  // threshold).
  function tagCompletedNurture(clients, kind, activityNotes) {
    const thresholdMs = NURTURE_COMPLETION_DAYS[kind] * 24 * 60 * 60 * 1000;
    const tag = NURTURE_COMPLETION_TAG[kind];

    return clients.map((c) => {
      const nurture = c.engagementNurture?.[kind];
      if (!nurture || !nurture.nurtureOk || nurture.completedAt) return c;

      const enrolledAt = new Date(nurture.enrolledAt).getTime();
      if (Date.now() - enrolledAt < thresholdMs) return c;

      const tags = c.tags || [];
      const nextTags = tags.includes(tag) ? tags : [...tags, tag];
      activityNotes.push(`${c.name || c.email} marked "${tag}" (sequence should be finished)`);

      return {
        ...c,
        tags: nextTags,
        engagementNurture: {
          ...c.engagementNurture,
          [kind]: { ...nurture, completedAt: new Date().toISOString() },
        },
      };
    });
  }

  try {
    const clickers = results["cache:campaignClickers"]?.ok ? await getCache("cache:campaignClickers", []) : [];
    const openers = results["cache:campaignOpeners"]?.ok ? await getCache("cache:campaignOpeners", []) : [];

    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
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

    // Enroll into the matching Zoho nurture list + drop from the regular
    // cold-send list. A contact who both opened AND clicked only goes on
    // the "clicked" nurture list, not both — clicked is the stronger signal,
    // and being on both lists would mean two separate autoresponder
    // sequences firing for the same person.
    const clickedEmails = new Set(clickers.map((c) => (c.email || "").toLowerCase().trim()));
    for (const opener of openers) {
      const email = (opener.email || "").toLowerCase().trim();
      if (clickedEmails.has(email)) continue; // clicked takes priority — skip the opened-only path
      clients = await enrollInNurtureAndDropFromRegularList(clients, opener, "opened", activityNotes);
    }
    for (const clicker of clickers) {
      clients = await enrollInNurtureAndDropFromRegularList(clients, clicker, "clicked", activityNotes);
    }

    clients = tagCompletedNurture(clients, "opened", activityNotes);
    clients = tagCompletedNurture(clients, "clicked", activityNotes);

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

  // Nurture-message engagement — did contacts open/click the follow-up
  // email itself (sent by the "On List Entry" workflow), as distinct from
  // the original CPA campaign. This is logged purely as activity history —
  // it deliberately never touches status, tags, or engagementNurture[kind]
  // flags, since re-running this shouldn't re-trigger enrollment into a
  // list a contact is already on. Skips cleanly (0 changes, no error) if
  // ZOHO_OPENED_NURTURE_MESSAGE_KEY / ZOHO_CLICKED_NURTURE_MESSAGE_KEY
  // aren't set yet, or if the report-page ID format turns out not to be a
  // valid campaignkey for this endpoint — check the [zoho] warn logs for
  // "nurture-message ... failed" to tell those two cases apart.
  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
    let clients = crmData.clients || [];
    let loggedCount = 0;

    for (const kind of ["opened", "clicked"]) {
      const { opens, clicks } = await fetchNurtureMessageEngagement(kind);
      const eventsByEmail = new Map();
      for (const email of opens) {
        eventsByEmail.set(email, [...(eventsByEmail.get(email) || []), { type: `nurture_open_${kind}`, ts: new Date().toISOString() }]);
      }
      for (const email of clicks) {
        eventsByEmail.set(email, [...(eventsByEmail.get(email) || []), { type: `nurture_click_${kind}`, ts: new Date().toISOString() }]);
      }

      for (const [email, newEvents] of eventsByEmail) {
        const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === email);
        if (idx === -1) continue; // should already exist from the original campaign upsert above
        const existing = clients[idx];
        const history = existing.engagementHistory || [];
        // Dedup on type — since we don't have a real per-event timestamp
        // from Zoho for these (only a snapshot "did they ever open/click"
        // list), re-running this job would otherwise log a duplicate event
        // every single sync. One logged event per contact per type is
        // enough to show "engaged with nurture email" on their record.
        const alreadyLogged = new Set(history.map((e) => e.type));
        const toAdd = newEvents.filter((e) => !alreadyLogged.has(e.type));
        if (!toAdd.length) continue;
        clients[idx] = { ...existing, engagementHistory: [...history, ...toAdd].slice(-100) };
        loggedCount += toAdd.length;
      }
    }

    if (loggedCount) {
      crmData.clients = clients;
      await setCache(CRM_DATA_KEY, crmData);
    }
    results["crm:nurtureMessageEngagement"] = { ok: true, logged: loggedCount };
  } catch (e) {
    results["crm:nurtureMessageEngagement"] = { ok: false, error: e.message };
    console.error("[sync] nurture-message engagement sync failed:", e.message);
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
      const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
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
            engagementHistory: [],
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

  // Incoming email from known clients — reads Tracy's Gmail inbox (which
  // also covers matt@elevatemy.ai, a send-as alias on the same mailbox,
  // not a separate account) and matches senders against existing CRM
  // clients by email. Only ever reads/logs — never marks emails read,
  // archives, or modifies anything in the actual inbox.
  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
    const clients = crmData.clients || [];
    const settings = crmData.settings || {};
    // First run ever: look back 7 days rather than the beginning of time,
    // so a first sync doesn't try to pull someone's entire inbox history.
    const sinceMs = settings.gmailLastSyncTs || (Date.now() - 7 * 24 * 60 * 60 * 1000);

    const emails = await fetchRecentIncomingEmails(sinceMs);

    // Also pull recent Sent mail so we can tell whether a client has
    // already been replied to — whether that reply went out through the
    // CRM's own send/approve buttons, or Tracy replying directly in Gmail.
    // Without this, the AI would happily draft (and leave sitting in the
    // approval queue) a reply to a thread a human already answered by hand.
    // A failure here shouldn't break incoming-email logging — it just means
    // reply-detection is skipped for this run.
    let sentEmails = [];
    try {
      sentEmails = await fetchRecentSentEmails(sinceMs);
    } catch (e) {
      console.warn("[sync] fetching sent mail failed (skipping reply-detection this run):", e.message);
    }

    // Durable "already handled" ledger — separate from engagementHistory,
    // which is capped at the last 100 events per client for Activity-tab
    // display purposes. Without this, a message's dedup record could get
    // pushed out of that 100-item window by later activity (more emails,
    // campaign opens/clicks), causing sync to treat an old, already-drafted
    // or already-rejected message as brand new and draft it again. This set
    // is the single source of truth for "have we ever considered this
    // message for drafting" — checked first, before anything else, and
    // never trimmed by anything other than its own generous cap below.
    const handledIds = new Set(settings.gmailHandledMessageIds || []);

    const emailActivityNotes = [];
    const templates = crmData.emailTemplates || [];
    const newPendingDrafts = [];
    let matchedCount = 0;
    let draftedCount = 0;
    let skippedAlreadyRepliedCount = 0;

    for (const msg of emails) {
      if (!msg.fromEmail) continue;
      if (handledIds.has(msg.messageId)) continue; // already handled in a prior run — never reconsider

      const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === msg.fromEmail);
      if (idx === -1) continue; // not a known client — nothing to log

      const existing = clients[idx];
      const history = existing.engagementHistory || [];
      // Dedup by Gmail's own message id — the one truly unique key here,
      // unlike campaign click/open events which don't have one. This is a
      // secondary check (handledIds above is now the primary one) — kept
      // so a message logged before this ledger existed doesn't get
      // reprocessed the first time it's seen under the new logic.
      if (history.some((e) => e.messageId === msg.messageId)) {
        handledIds.add(msg.messageId); // backfill into the durable ledger
        continue;
      }

      const event = { type: "email_received", campaignName: msg.subject, messageId: msg.messageId, ts: msg.ts };
      clients[idx] = { ...existing, engagementHistory: [...history, event].slice(-100) };
      // Carry msg.ts (the real time Gmail says this was sent/received)
      // alongside the text — previously this pushed a plain string and
      // every note from a sync run got stamped with the sync's own
      // current time below, which is why the dashboard's "Emails
      // Received" group showed identical "Xm ago" for every entry in a
      // batch instead of each email's actual send time.
      emailActivityNotes.push({ text: `${existing.name || existing.email} emailed us: "${msg.subject}"`, ts: msg.ts });
      matchedCount++;

      // Mark handled now, regardless of what happens below (drafted,
      // skipped-as-already-replied, or draft attempt fails) — once we've
      // looked at a message once, we never want to look at it again.
      handledIds.add(msg.messageId);

      // Has this sender already been replied to (via Gmail directly, or
      // through the CRM) since they sent this message? If so, skip
      // drafting entirely — an AI-drafted reply to an already-answered
      // email would just be a stale, confusing item in the approval queue.
      const msgTs = new Date(msg.ts).getTime();
      const alreadyReplied = sentEmails.some(
        (s) => s.toRaw.includes(msg.fromEmail) && new Date(s.ts).getTime() > msgTs
      );
      if (alreadyReplied) {
        skippedAlreadyRepliedCount++;
        continue;
      }

      // Draft a suggested reply — never sent automatically. Lands in
      // pendingEmails for a human to review/edit/approve or reject. A
      // failed draft attempt (bad API key, model error, etc.) shouldn't
      // break the rest of the sync — the email is still logged above
      // either way.
      try {
        const draft = await draftReply({ client: clients[idx], incomingEmail: msg, templates });
        newPendingDrafts.push({
          id: crypto.randomBytes(6).toString("hex"),
          clientId: clients[idx].id,
          to: clients[idx].email,
          from: "tracy@elevatemy.ai",
          subject: draft.subject,
          body: draft.body,
          sourceMessageId: msg.messageId,
          sourceSubject: msg.subject,
          createdAt: new Date().toISOString(),
        });
        draftedCount++;
      } catch (e) {
        console.warn(`[sync] AI draft failed for message ${msg.messageId}:`, e.message);
      }
    }

    // Log Gmail-native sent mail (replies Tracy typed directly in Gmail,
    // not through the CRM's send/approve buttons — those already log
    // themselves in send.js/approve.js) against the matching client, so
    // the Activity tab shows the full back-and-forth regardless of which
    // channel was used to reply. Dedup by messageId, same as incoming.
    for (const sent of sentEmails) {
      const idx = clients.findIndex((c) => {
        const email = (c.email || "").toLowerCase().trim();
        return email && sent.toRaw.includes(email);
      });
      if (idx === -1) continue;
      const existing = clients[idx];
      const history = existing.engagementHistory || [];
      if (history.some((e) => e.messageId === sent.messageId)) continue;
      const event = { type: "email_sent", campaignName: sent.subject, messageId: sent.messageId, ts: sent.ts };
      clients[idx] = { ...existing, engagementHistory: [...history, event].slice(-100) };
    }

    // Now that engagementHistory reflects any newly-detected replies
    // (Gmail-native or CRM-native), drop any pending approval whose client
    // has since been replied to — covers the case where a draft was
    // created by an earlier sync run, then Tracy answered by hand in Gmail
    // before getting to the approval queue.
    const stillPending = (crmData.pendingEmails || []).filter((draft) => {
      const client = clients.find((c) => c.id === draft.clientId);
      if (!client) return true; // nothing to check against — keep it
      const history = client.engagementHistory || [];
      const draftCreatedTs = new Date(draft.createdAt).getTime();
      const repliedSinceDraft = history.some(
        (e) => e.type === "email_sent" && new Date(e.ts).getTime() >= draftCreatedTs
      );
      return !repliedSinceDraft;
    });
    const removedStaleCount = (crmData.pendingEmails || []).length - stillPending.length;

    crmData.clients = clients;
    crmData.settings = {
      ...settings,
      gmailLastSyncTs: Date.now(),
      // Capped generously (not the tight 100-item Activity-tab limit) —
      // this only needs to hold message IDs, not full event objects, so a
      // much larger cap costs little and gives real protection against a
      // message's dedup record ever silently expiring.
      gmailHandledMessageIds: Array.from(handledIds).slice(-2000),
    };
    crmData.pendingEmails = newPendingDrafts.length
      ? [...newPendingDrafts, ...stillPending].slice(-50)
      : stillPending;
    if (emailActivityNotes.length) {
      const newEntries = emailActivityNotes.map((note) => ({ id: crypto.randomBytes(4).toString("hex"), text: note.text, ts: note.ts }));
      crmData.activityLog = [...newEntries, ...(crmData.activityLog || [])].slice(0, 50);
    }
    await setCache(CRM_DATA_KEY, crmData);
    results["crm:gmailIncoming"] = {
      ok: true,
      checked: emails.length,
      matched: matchedCount,
      drafted: draftedCount,
      skippedAlreadyReplied: skippedAlreadyRepliedCount,
      removedStalePending: removedStaleCount,
    };
  } catch (e) {
    results["crm:gmailIncoming"] = { ok: false, error: e.message };
    console.error("[sync] Gmail incoming email check failed:", e.message);
  }

  try {
    await setCache("cache:lastSyncedAt", new Date().toISOString());
  } catch (e) {
    console.error("[sync] failed to write lastSyncedAt:", e.message);
  }

  res.status(200).json({ syncedAt: new Date().toISOString(), results });
};
