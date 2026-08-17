// READ-ONLY DIAGNOSTIC — checks whether the new "CPA - Regular Outreach"
// workflow messages are actually being discovered by fetchZohoCampaigns(),
// and whether their real opens are making it into cache:campaignOpeners.
//
// Usage: GET /api/debug/check-campaign-tracking
// Protected the same way as other debug/cron routes.

const { getCache } = require("../../lib/store");

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  const report = {};

  try {
    const campaigns = await getCache("cache:campaigns", null);
    report.campaigns = {
      exists: campaigns !== null,
      count: Array.isArray(campaigns) ? campaigns.length : null,
      // Look specifically for anything matching this new sequence's known
      // subject lines, so we know for certain whether they're discovered.
      matchingRegularOutreach: Array.isArray(campaigns)
        ? campaigns.filter((c) =>
            /busy season|our own practice|never really about the software/i.test(c.name || "")
          )
        : [],
      // Also show the 10 most recent campaign names overall, regardless of
      // match — useful to see what Zoho IS returning if the above is empty.
      mostRecentNames: Array.isArray(campaigns) ? campaigns.slice(0, 10).map((c) => c.name) : [],
    };
  } catch (e) {
    report.campaigns = { error: e.message };
  }

  try {
    const openers = await getCache("cache:campaignOpeners", null);
    report.campaignOpeners = {
      exists: openers !== null,
      count: Array.isArray(openers) ? openers.length : null,
      // Check for any of the specific emails we know actually opened
      // Message 1, per the Zoho report (Jon Strickland, Robin McIntire).
      sampleKnownOpeners: Array.isArray(openers)
        ? openers.filter((o) =>
            ["jon.strickland@elliottdavis.com", "robin.mcintire@rrmcpa.com"].includes(
              (o.email || "").toLowerCase()
            )
          )
        : [],
    };
  } catch (e) {
    report.campaignOpeners = { error: e.message };
  }

  res.status(200).json(report);
};
