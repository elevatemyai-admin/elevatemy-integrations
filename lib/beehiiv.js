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

module.exports = { fetchBeehiivSubscribers };
