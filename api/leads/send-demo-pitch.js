// Called from the CRM's Clients view ("Send demo pitch" bulk action) once
// you've filtered the 50k list down to a confirmed set (people who actually
// clicked in the test campaigns). For each lead, this builds their
// personalized Ledgerline demo link and adds them to the Zoho "CPA Demo
// Pitch" list, whose Autoresponder sends the actual email (video + link).

const { addContactToDemoPitchList } = require("../../lib/zoho");

function buildDemoLink(company) {
  const base = (process.env.LEDGERLINE_DEMO_BASE_URL || "").replace(/\/$/, "");
  const slug = encodeURIComponent((company || "your business").trim());
  return `${base}/demo/${slug}`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Accept either a single lead or an array, so the CRM can send one bulk request.
  const body = req.body || {};
  const leads = Array.isArray(body.leads) ? body.leads : [body];

  const results = [];
  for (const lead of leads) {
    if (!lead.email) {
      results.push({ email: null, ok: false, error: "missing email" });
      continue;
    }
    const demoLink = buildDemoLink(lead.company);
    try {
      await addContactToDemoPitchList({ ...lead, demoLink });
      results.push({ email: lead.email, ok: true, demoLink });
    } catch (e) {
      results.push({ email: lead.email, ok: false, error: e.message, demoLink });
    }
  }

  res.status(200).json({ results });
};
