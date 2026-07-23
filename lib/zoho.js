// Zoho OAuth: exchanges a long-lived refresh token for a short-lived access
// token, and caches it in KV so we don't re-auth on every single request.
// Get ZOHO_REFRESH_TOKEN by doing the one-time "self client" OAuth flow in the
// Zoho API console (https://api-console.zoho.com) with the scopes you need,
// e.g. ZohoCampaigns.campaign.READ,ZohoCRM.modules.leads.READ

const { getCache, setCache } = require("./store");

const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com";

async function getZohoAccessToken() {
  const cached = await getCache("zoho:token", null);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch(`${ACCOUNTS_DOMAIN}/oauth/v2/token?${params.toString()}`, { method: "POST" });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Zoho token refresh failed: " + JSON.stringify(data));
  }

  await setCache("zoho:token", {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

async function zohoFetch(url) {
  const token = await getZohoAccessToken();
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error(`Zoho API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Campaign performance stats from Zoho Campaigns.
// CONFIRMED against Zoho's current official docs. recentcampaigns for the
// list, then getcampaigndetails per campaign for open/click counts — A/B
// test campaigns need campaigntype=abtesting passed here or the reports
// come back empty; regular campaigns need campaigntype=normal. Email
// campaigns don't have a "spend" concept the way paid ads do, so spend is
// always 0 here.
async function fetchZohoCampaigns() {
  const data = await zohoFetch(
    "https://campaigns.zoho.com/api/v1.1/recentcampaigns?resfmt=JSON&sort=desc&fromindex=1&range=100&status=all"
  );
  const list = data.recent_campaigns || [];

  const withStats = await Promise.all(list.map(async (c) => {
    let opens = 0, clicks = 0;
    let sendKeys = [c.campaign_key]; // every key that actually sent mail for this campaign
    try {
      const campaignType = c.campaigntype || "normal";
      const reportData = await zohoFetch(
        `https://campaigns.zoho.com/api/v1.1/getcampaigndetails?resfmt=JSON&campaignkey=${encodeURIComponent(c.campaign_key)}&campaigntype=${campaignType}`
      );
      const reports = reportData["campaign-reports"] || [];
      // CONFIRMED (July 20, 2026): for A/B test campaigns, this "campaign-reports"
      // entry ONLY covers the final send to the remaining list — NOT the initial
      // A/B test-phase sends. Those live under entirely separate campaign keys
      // in a distinct "AB-split-details" object, with their own opens/clicks
      // counts. Without adding these in, both campaign-level stats AND the
      // clickers/openers lists used to create CRM contacts were silently
      // missing everyone who engaged during the A/B test phase itself (in one
      // real case: 28 vs the true 102 opens — a ~3.6x undercount).
      opens = reports.reduce((sum, r) => sum + Number(r.opens_count || 0), 0);
      clicks = reports.reduce((sum, r) => sum + Number(r.unique_clicks_count || 0), 0);

      const abInfo = (reportData["AB-split-details"] || [])[0];
      if (abInfo) {
        opens += Number(abInfo.a_open_count || 0) + Number(abInfo.b_open_count || 0);
        clicks += Number(abInfo.a_click_count || 0) + Number(abInfo.b_click_count || 0);
        if (abInfo.a_child_campaignkey) sendKeys.push(abInfo.a_child_campaignkey);
        if (abInfo.b_child_campaignkey) sendKeys.push(abInfo.b_child_campaignkey);
      }
    } catch (e) {
      // Campaigns still in draft often don't have reports yet — that's fine, leave as 0.
    }
    return {
      id: c.campaign_key,
      sendKeys, // used by fetchZohoCampaignClickers/Openers to cover A/B variants too
      name: c.campaign_name,
      platform: "Zoho Email",
      spend: 0, // not applicable to email campaigns
      leads: clicks, // unique clicks is the closest thing to "responders" for an email send
      opens,
      status: (c.campaign_status || "").toLowerCase(),
      link: c.campaign_preview || "",
    };
  }));

  return withStats;
}

// Leads captured through Zoho CRM, filtered by a Lead Source value.
// Set ZOHO_CPA_LEAD_SOURCE / ZOHO_SOCIAL_LEAD_SOURCE to whatever string your
// team actually uses in the "Lead Source" field for each channel — these are
// placeholders until confirmed.
// NOTE: this requires an actual Zoho CRM account (a different product from
// Zoho Campaigns) — if your org only has Campaigns, this will error, and
// that's expected until/unless CRM is added.
async function fetchZohoLeadsBySource(sourceValue) {
  const criteria = encodeURIComponent(`(Lead_Source:equals:${sourceValue})`);
  const data = await zohoFetch(
    `https://www.zohoapis.com/crm/v3/Leads/search?criteria=${criteria}`
  );
  const list = data.data || [];
  return list.map((l) => ({
    id: l.id,
    name: [l.First_Name, l.Last_Name].filter(Boolean).join(" ") || l.Company || "Unnamed lead",
    email: l.Email || "",
    phone: l.Phone || "",
    campaignName: l.Campaign_Name || sourceValue,
    campaignLink: "",
    platform: l.Lead_Source || sourceValue,
  }));
}

// Everyone who clicked any campaign — aggregated across all campaigns, since
// "which contacts clicked" is naturally a cross-campaign question for lead
// capture. Dedupes by email, keeping their most recent click + which
// campaign it was.
// CONFIRMED endpoint: getcampaignrecipientsdata with action=clickedcontacts
// (there is no "getclickedlist" endpoint — that was wrong).
async function fetchZohoCampaignClickers() {
  const campaigns = await fetchZohoCampaigns();
  const byEmail = new Map();

  for (const c of campaigns) {
    // A/B test campaigns need every send-key covered (final send + each
    // variant) — see fetchZohoCampaigns for why. Non-A/B campaigns just have
    // one key here, so this loop is a no-op change for them.
    for (const sendKey of c.sendKeys || [c.id]) {
      let data;
      try {
        data = await zohoFetch(
          `https://campaigns.zoho.com/api/v1.1/getcampaignrecipientsdata?resfmt=JSON&campaignkey=${encodeURIComponent(sendKey)}&action=clickedcontacts&fromindex=1&range=200`
        );
      } catch (e) {
        console.warn(`[zoho] clicked recipients failed for campaign ${sendKey}:`, e.message);
        continue;
      }
      const list = data.list_of_details || [];
      for (const entry of list) {
        const email = entry.contactemailaddress || entry.contact_email;
        if (!email) continue;
        const clickedAt = entry.sent_time || entry.clicked_time || null;
        const existing = byEmail.get(email);
        // CONFIRMED against a real response (July 20, 2026): Zoho's docs claim
        // "firstname"/"lastname", but this endpoint actually returns
        // "contactfn"/"contactln". Use the confirmed real field names.
        const firstName = entry.contactfn && entry.contactfn !== "null" ? entry.contactfn : "";
        const lastName = entry.contactln && entry.contactln !== "null" ? entry.contactln : "";
        const record = existing || {
          id: email, name: [firstName, lastName].filter(Boolean).join(" "), firstName, lastName, email,
          company: entry.companyname && entry.companyname !== "null" ? entry.companyname : "",
          campaignName: c.name, campaignLink: c.link || "", clickedAt: null,
          events: [], // full click history for this contact, not just the latest — powers the per-client "recent activity" feed
        };
        record.events.push({ type: "click", campaignName: c.name, campaignLink: c.link || "", ts: clickedAt });
        if (!record.clickedAt || (clickedAt && clickedAt > record.clickedAt)) {
          record.clickedAt = clickedAt;
          record.campaignName = c.name;
          record.campaignLink = c.link || "";
        }
        byEmail.set(email, record);
      }
    }
  }
  return Array.from(byEmail.values());
}

// Everyone who opened any campaign (but may or may not have clicked) —
// same aggregation pattern as fetchZohoCampaignClickers above. Used to build
// the CRM's "Prospect" tier (opened, not yet clicked) as distinct from
// "Opportunity" (clicked) — see fetchZohoCampaignClickers.
// NOTE: action=openedcontacts follows the same documented shape as
// clickedcontacts, but the exact field name Zoho uses for the open
// timestamp hasn't been separately confirmed the way clickedcontacts was —
// verify field names against a real response before relying on openedAt
// for anything beyond rough "most recent" ordering.
async function fetchZohoCampaignOpeners() {
  const campaigns = await fetchZohoCampaigns();
  const byEmail = new Map();

  for (const c of campaigns) {
    // A/B test campaigns need every send-key covered (final send + each
    // variant) — see fetchZohoCampaigns for why.
    for (const sendKey of c.sendKeys || [c.id]) {
      let data;
      try {
        data = await zohoFetch(
          `https://campaigns.zoho.com/api/v1.1/getcampaignrecipientsdata?resfmt=JSON&campaignkey=${encodeURIComponent(sendKey)}&action=openedcontacts&fromindex=1&range=200`
        );
      } catch (e) {
        console.warn(`[zoho] opened recipients failed for campaign ${sendKey}:`, e.message);
        continue;
      }
      const list = data.list_of_details || [];
      for (const entry of list) {
        const email = entry.contactemailaddress || entry.contact_email;
        if (!email) continue;
        const openedAt = entry.sent_time || entry.opened_time || entry.open_time || null;
        const existing = byEmail.get(email);
        const firstName = entry.contactfn && entry.contactfn !== "null" ? entry.contactfn : "";
        const lastName = entry.contactln && entry.contactln !== "null" ? entry.contactln : "";
        const record = existing || {
          id: email, name: [firstName, lastName].filter(Boolean).join(" "), firstName, lastName, email,
          company: entry.companyname && entry.companyname !== "null" ? entry.companyname : "",
          campaignName: c.name, campaignLink: c.link || "", openedAt: null,
          events: [], // full open history for this contact — powers the per-client "recent activity" feed
        };
        record.events.push({ type: "open", campaignName: c.name, campaignLink: c.link || "", ts: openedAt });
        if (!record.openedAt || (openedAt && openedAt > record.openedAt)) {
          record.openedAt = openedAt;
          record.campaignName = c.name;
          record.campaignLink = c.link || "";
        }
        byEmail.set(email, record);
      }
    }
  }
  return Array.from(byEmail.values());
}

// Adds/updates a contact in the Zoho Campaigns list matching their assessment
// tier. Each list should have a Zoho Campaigns "Autoresponder" configured to
// fire 2-3 days after a contact is added — that's what actually sends the
// nurture email, on Zoho's own schedule, not our code. Our job is just to
// put the right contact in the right list with the right merge-field data.
//
// IMPORTANT: this only adds contacts silently (no confirmation email) if the
// target list has NO signup form attached. If a list has a signup form, Zoho
// sends a confirmation email first and the contact won't be fully on the
// list — and won't get the nurture email — until they click it. See
// ZOHO_SETUP.md step 5.
//
// NOTE: verify this endpoint/param shape against current Zoho Campaigns API
// docs before relying on it — Zoho's contact-add API has shifted across
// versions and this follows the commonly documented v1.1 pattern.
// FIXED: this previously only mapped the 4 General Business tiers, so every
// Financial Services assessment completion (tier = "Early Stage",
// "Developing", "Intermediate", or "Advanced") silently hit the
// `if (!listkey) return { skipped: true }` branch below — no Zoho list add,
// no nurture emails, no error surfaced anywhere except a console.warn.
// Both tracks' tiers now map here.
const TIER_LIST_KEYS = {
  // General Business
  Exploring: process.env.ZOHO_LIST_KEY_EXPLORING,
  Building: process.env.ZOHO_LIST_KEY_BUILDING,
  Emerging: process.env.ZOHO_LIST_KEY_EMERGING,
  "AI-Ready": process.env.ZOHO_LIST_KEY_AI_READY,
  // Financial Services
  "Early Stage": process.env.ZOHO_LIST_KEY_FP_EARLY_STAGE,
  Developing: process.env.ZOHO_LIST_KEY_FP_DEVELOPING,
  Intermediate: process.env.ZOHO_LIST_KEY_FP_INTERMEDIATE,
  Advanced: process.env.ZOHO_LIST_KEY_FP_ADVANCED,
};

// Tier names that belong to the Financial Services track — used below to
// decide whether a contact's custom-field writes go to the GB_* or FP_*
// fields. Kept as an explicit set here (not derived from TIER_LIST_KEYS'
// object shape) so this stays correct even if TIER_LIST_KEYS' structure
// ever changes.
const FP_TIER_NAMES = new Set(["Early Stage", "Developing", "Intermediate", "Advanced"]);

async function addContactToNurtureList(lead) {
  const listkey = TIER_LIST_KEYS[lead.tier];
  if (!listkey) {
    console.warn(`[zoho] no list configured for tier "${lead.tier}" — skipping nurture add for ${lead.email}`);
    return { skipped: true };
  }

  // FIXED: this previously always wrote to a single shared set of fields
  // ("Biggest Opportunity Area", "AI Readiness Tier", "Overall Score",
  // "Results URL") regardless of which track the contact came from. Since
  // these are per-CONTACT fields (not per-list), a contact who completed
  // both the General and Financial Services assessments would have one
  // track's data silently overwrite the other's — the exact bug described
  // in the project notes as already fixed, which it turns out it wasn't,
  // in the actually-deployed code. Now writes into track-specific GB_*/FP_*
  // fields instead, so the two tracks can never collide.
  //
  // IMPORTANT: the fields "GB Biggest Opportunity Area", "GB AI Readiness
  // Tier", "GB Overall Score", "GB Results URL" (and the FP_ equivalents)
  // must actually exist in Zoho (Settings -> Manage Fields) with these
  // exact display names before this works — Zoho auto-generates each
  // field's merge tag from its display name (spaces -> underscores, all
  // caps), confirmed against Zoho's own Merge Tags settings page. Verify
  // the real tags there once the fields are created, rather than assuming.
  const prefix = FP_TIER_NAMES.has(lead.tier) ? "FP" : "GB";

  const token = await getZohoAccessToken();
  const contactinfo = JSON.stringify({
    "Contact Email": lead.email,
    "First Name": (lead.name || "").split(" ")[0] || "",
    "Last Name": (lead.name || "").split(" ").slice(1).join(" ") || "",
    [`${prefix} Biggest Opportunity Area`]: lead.topOpportunity || "",
    [`${prefix} AI Readiness Tier`]: lead.tier || "",
    [`${prefix} Overall Score`]: lead.overallScore != null ? String(lead.overallScore) : "",
    // Enables a real per-contact "View My Results" link in the email
    // (the HubSpot version of this link was actually broken — its href was
    // literally the text "Your AI Results", never a real URL — so this is a
    // genuine fix, not just a port).
    [`${prefix} Results URL`]: lead.resultsUrl || "",
    // FIXED: company was never sent to Zoho at all before, for anyone —
    // this field simply didn't exist in this function's contactinfo,
    // unrelated to the submit.js update-branch bug (that one only affected
    // the CRM, not Zoho).
    "Company Name": lead.company || "",
  });

  const params = new URLSearchParams({
    resfmt: "JSON",
    listkey,
    contactinfo,
  });

  const res = await fetch(`https://campaigns.zoho.com/api/v1.1/json/listsubscribe?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) throw new Error(`Zoho Campaigns list-add error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Pushes a confirmed CPA prospect into the "demo pitch" Zoho Campaigns list
// with their personalized Ledgerline demo link as a merge field. Separate
// from the assessment-tier nurture lists — this track is for the CPA
// outreach campaign specifically (test → confirmed → demo pitch).
async function addContactToDemoPitchList(lead) {
  const listkey = process.env.ZOHO_LIST_KEY_CPA_DEMO_PITCH;
  if (!listkey) {
    console.warn(`[zoho] ZOHO_LIST_KEY_CPA_DEMO_PITCH not set — skipping demo pitch add for ${lead.email}`);
    return { skipped: true };
  }

  const token = await getZohoAccessToken();
  const contactinfo = JSON.stringify({
    "Contact Email": lead.email,
    "First Name": (lead.name || "").split(" ")[0] || "",
    "Last Name": (lead.name || "").split(" ").slice(1).join(" ") || "",
    "Company Name": lead.company || "",
    "Demo Link": lead.demoLink || "",
  });

  const params = new URLSearchParams({ resfmt: "JSON", listkey, contactinfo });
  const res = await fetch(`https://campaigns.zoho.com/api/v1.1/json/listsubscribe?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  if (!res.ok) throw new Error(`Zoho Campaigns demo-pitch add error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------
// Ad-hoc campaign creation/sending — for the Marketing Hub's one-off
// broadcasts (newsletters, campaign emails), distinct from the 8
// tier-autoresponder lists above (those fire automatically when a contact
// is added; these are built and approved through the CRM directly).
//
// CONFIRMED against Zoho's official developer docs (checked July 2026):
//   https://www.zoho.com/campaigns/help/developers/create-campaign.html
//   https://www.zoho.com/campaigns/help/developers/send-campaign.html
//   https://www.zoho.com/campaigns/help/developers/schedule-campaign.html
// NOT yet live-tested against this account — test against an internal/test
// list before trusting this with a real client list.
//
// Important real quirk: createCampaign does NOT accept raw HTML/text
// inline. It takes a content_url that Zoho's own servers fetch the HTML
// from — see api/marketing/render-content.js, a public unauthenticated
// route built specifically so Zoho can reach it.
// ---------------------------------------------------------------------

// Turns a plain-text content-item body into simple HTML — just enough
// structure (paragraphs + line breaks) for Zoho to send something
// reasonable-looking, without pulling in a template/design system.
function contentToHtml(body) {
  const escaped = (body || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

// Creates (but does not send) a new campaign. `contentUrl` must be a
// publicly-fetchable URL — Zoho's servers request it directly, so it
// cannot require auth or point at localhost/a private network.
// `listKey` targets a whole Zoho Campaigns mailing list; list_details'
// empty array means "everyone currently on this list" (per Zoho's docs) —
// segment-level targeting (specific contact IDs) isn't wired up here, but
// the shape supports it later if needed.
async function createCampaign({ name, subject, fromEmail, listKey, contentUrl }) {
  const token = await getZohoAccessToken();
  const listDetails = JSON.stringify({ [listKey]: [] });
  const params = new URLSearchParams({
    resfmt: "JSON",
    campaignname: name,
    from_email: fromEmail,
    subject,
    list_details: listDetails,
    content_url: contentUrl,
  });
  const res = await fetch(`https://campaigns.zoho.com/api/v1.1/createCampaign?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (!res.ok || !data.campaignKey) throw new Error(`Zoho createCampaign error: ${JSON.stringify(data)}`);
  return { campaignKey: data.campaignKey };
}

// Sends an already-created campaign immediately.
async function sendCampaignNow(campaignKey) {
  const token = await getZohoAccessToken();
  const params = new URLSearchParams({ resfmt: "JSON", campaignkey: campaignKey });
  const res = await fetch(`https://campaigns.zoho.com/api/v1.1/sendcampaign?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  // Zoho's own docs show this endpoint occasionally wrapping the real
  // payload in {response: {...}} even when resfmt=JSON is requested —
  // handle both shapes rather than assuming one.
  const inner = data.response || data;
  if (!res.ok) throw new Error(`Zoho sendcampaign error: ${JSON.stringify(data)}`);
  return inner;
}

// Schedules an already-created campaign for a future send time. Zoho's API
// wants the time split into separate date/hour/minute/am-pm fields, not a
// single ISO timestamp — this function does that splitting so callers can
// just pass a normal JS Date (or anything `new Date()` accepts).
async function scheduleCampaign(campaignKey, scheduledFor, sendingTZ) {
  const d = new Date(scheduledFor);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  let hour = d.getHours();
  const am_pm = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  const minute = String(d.getMinutes()).padStart(2, "0");

  const token = await getZohoAccessToken();
  const params = new URLSearchParams({
    resfmt: "JSON",
    campaignkey: campaignKey,
    scheduledate: `${mm}/${dd}/${yyyy}`,
    schedulehour: String(hour),
    scheduleminute: minute,
    am_pm,
  });
  if (sendingTZ) params.set("sendingTZ", sendingTZ);
  const res = await fetch(`https://campaigns.zoho.com/api/v1.1/sendcampaign?isschedule=true&${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  const inner = data.response || data;
  if (!res.ok) throw new Error(`Zoho schedulecampaign error: ${JSON.stringify(data)}`);
  return inner;
}

module.exports = {
  getZohoAccessToken,
  zohoFetch,
  fetchZohoCampaigns,
  fetchZohoLeadsBySource,
  fetchZohoCampaignClickers,
  fetchZohoCampaignOpeners,
  addContactToNurtureList,
  addContactToDemoPitchList,
  contentToHtml,
  createCampaign,
  sendCampaignNow,
  scheduleCampaign,
};
