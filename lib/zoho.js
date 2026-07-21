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
        if (!existing || (clickedAt && (!existing.clickedAt || clickedAt > existing.clickedAt))) {
          // CONFIRMED against a real response (July 20, 2026): Zoho's docs claim
          // "firstname"/"lastname", but this endpoint actually returns
          // "contactfn"/"contactln". Use the confirmed real field names.
          const firstName = entry.contactfn && entry.contactfn !== "null" ? entry.contactfn : "";
          const lastName = entry.contactln && entry.contactln !== "null" ? entry.contactln : "";
          byEmail.set(email, {
            id: email,
            name: [firstName, lastName].filter(Boolean).join(" "),
            firstName,
            lastName,
            email,
            company: entry.companyname && entry.companyname !== "null" ? entry.companyname : "",
            campaignName: c.name,
            campaignLink: c.link || "",
            clickedAt,
          });
        }
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
        if (!existing || (openedAt && (!existing.openedAt || openedAt > existing.openedAt))) {
          // CONFIRMED against a real response (July 20, 2026): Zoho's docs claim
          // "firstname"/"lastname", but this endpoint actually returns
          // "contactfn"/"contactln". Use the confirmed real field names.
          const firstName = entry.contactfn && entry.contactfn !== "null" ? entry.contactfn : "";
          const lastName = entry.contactln && entry.contactln !== "null" ? entry.contactln : "";
          byEmail.set(email, {
            id: email,
            name: [firstName, lastName].filter(Boolean).join(" "),
            firstName,
            lastName,
            email,
            company: entry.companyname && entry.companyname !== "null" ? entry.companyname : "",
            campaignName: c.name,
            campaignLink: c.link || "",
            openedAt,
          });
        }
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
const TIER_LIST_KEYS = {
  Exploring: process.env.ZOHO_LIST_KEY_EXPLORING,
  Building: process.env.ZOHO_LIST_KEY_BUILDING,
  Emerging: process.env.ZOHO_LIST_KEY_EMERGING,
  "AI-Ready": process.env.ZOHO_LIST_KEY_AI_READY,
};

async function addContactToNurtureList(lead) {
  const listkey = TIER_LIST_KEYS[lead.tier];
  if (!listkey) {
    console.warn(`[zoho] no list configured for tier "${lead.tier}" — skipping nurture add for ${lead.email}`);
    return { skipped: true };
  }

  const token = await getZohoAccessToken();
  const contactinfo = JSON.stringify({
    "Contact Email": lead.email,
    "First Name": (lead.name || "").split(" ")[0] || "",
    "Last Name": (lead.name || "").split(" ").slice(1).join(" ") || "",
    // Custom fields — these must already exist on the Zoho Campaigns list
    // (Settings -> Manage Fields) with matching names before this will merge.
    "Biggest Opportunity Area": lead.topOpportunity || "",
    "AI Readiness Tier": lead.tier || "",
    "Overall Score": lead.overallScore != null ? String(lead.overallScore) : "",
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

module.exports = { getZohoAccessToken, zohoFetch, fetchZohoCampaigns, fetchZohoLeadsBySource, fetchZohoCampaignClickers, fetchZohoCampaignOpeners, addContactToNurtureList, addContactToDemoPitchList };
