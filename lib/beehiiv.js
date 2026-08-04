// Beehiiv v2 public API — well documented, no OAuth dance needed, just an API key.
// Get BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID from Beehiiv dashboard -> Settings -> API.

async function fetchBeehiivSubscribers() {
  const res = await fetch(
    // expand=stats adds per-subscriber engagement — open_rate, click_through_rate,
    // emails_received. CONFIRMED against Beehiiv's docs: these are lifetime
    // aggregates across every post this subscriber has received, NOT per-post
    // and NOT timestamped. Beehiiv's public API does not expose a per-click,
    // per-timestamp event the way Zoho's campaign clickers/openers endpoints do
    // — that level of detail only exists in Beehiiv's own dashboard UI. Don't
    // add a "last clicked" field here; there's nothing real to put in it.
    `https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/subscriptions?limit=100&status=active&expand=stats`,
    { headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Beehiiv API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return (data.data || []).map((s) => ({
    id: s.id,
    name: s.name || "",
    email: s.email,
    subscribedAt: s.created ? new Date(s.created * 1000).toISOString() : null,
    link: "",
    openRate: s.stats?.open_rate ?? null,
    clickThroughRate: s.stats?.click_through_rate ?? null,
    emailsReceived: s.stats?.emails_received ?? null,
  }));
}

// Adds one person to the newsletter — used by the CRM's "Subscribe via
// Beehiiv" button so a CRM user can subscribe a client without leaving the
// app. `reactivateExisting` defaults to true here (unlike Beehiiv's own
// default of false) because this is always a deliberate, one-off action by
// someone looking at a specific client record — exactly the case Beehiiv's
// own docs say reactivate_existing is for ("only if the subscriber is
// knowingly resubscribing").
async function subscribeToBeehiiv({ email, firstName, lastName, sendWelcomeEmail = true, reactivateExisting = true }) {
  if (!email) throw new Error("email is required");

  const customFields = [];
  if (firstName) customFields.push({ name: "First Name", value: firstName });
  if (lastName) customFields.push({ name: "Last Name", value: lastName });

  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/subscriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        reactivate_existing: reactivateExisting,
        send_welcome_email: sendWelcomeEmail,
        utm_source: "crm",
        utm_medium: "manual_add",
        ...(customFields.length ? { custom_fields: customFields } : {}),
      }),
    }
  );
  if (!res.ok) throw new Error(`Beehiiv API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data;
}

// Per-issue newsletter performance — CONFIRMED against Beehiiv's current
// public API docs: GET /posts?expand=stats returns a stats.email block per
// post with real per-send opens/clicks (recipients, opens, unique_opens,
// open_rate, clicks, unique_clicks, click_rate). This is a genuinely
// different thing from fetchBeehiivSubscribers' per-subscriber lifetime
// aggregates above — this is per-issue, the same shape Zoho's campaign
// reports give us in lib/zoho.js's fetchZohoCampaigns. platform=email
// excludes web-only posts, since those never had an email send to report on.
async function fetchBeehiivPosts() {
  const params = new URLSearchParams({
    expand: "stats",
    platform: "email",
    status: "confirmed",
    limit: "25",
    order_by: "publish_date",
    direction: "desc",
  });
  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/posts?${params.toString()}`,
    { headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Beehiiv API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return (data.data || []).map((p) => {
    const emailStats = p.stats?.email || {};
    return {
      id: p.id,
      name: p.title || p.subject_line || "Untitled post",
      subjectLine: p.subject_line || "",
      publishDate: p.publish_date ? new Date(p.publish_date * 1000).toISOString() : null,
      status: p.status || "",
      link: p.web_url || "",
      recipients: emailStats.recipients ?? null,
      opens: emailStats.unique_opens ?? emailStats.opens ?? 0,
      openRate: emailStats.open_rate ?? null, // Beehiiv returns this as a whole percentage (e.g. 45), not a 0-1 fraction
      clicks: emailStats.unique_clicks ?? emailStats.clicks ?? 0,
      clickRate: emailStats.click_rate ?? null,
    };
  });
}

module.exports = { fetchBeehiivSubscribers, subscribeToBeehiiv, fetchBeehiivPosts };
