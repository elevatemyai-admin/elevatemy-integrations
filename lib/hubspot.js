// Pulls completed AI Readiness Assessments from HubSpot.
//
// CONFIRMED from the live nurture-email templates: the "biggest opportunity"
// property is really named ai_assessment__biggest_opportunity_area, and
// merge-tags like {{contact.firstname}} confirm HubSpot contact properties
// are the right place to look. The nurture emails also confirm the real tier
// vocabulary is Exploring / Building / Emerging / AI-Ready (used below).
//
// STILL A GUESS: the other property names follow the same
// "ai_assessment__x" naming convention as a best guess, but only
// biggest_opportunity_area is confirmed. Open a Contact in HubSpot who
// completed the assessment, check the properties panel for the rest, and
// correct PROPERTY_MAP below if any differ.

const HUBSPOT_BASE = "https://api.hubapi.com";

const PROPERTY_MAP = {
  path: "ai_assessment__path", // 'general' | 'financial' — unconfirmed name
  overallScore: "ai_assessment__overall_score", // unconfirmed name
  tier: "ai_assessment__tier", // expected values: Exploring | Building | Emerging | AI-Ready — unconfirmed name
  categories: "ai_assessment__category_scores", // expected to be a JSON string — unconfirmed name
  topOpportunity: "ai_assessment__biggest_opportunity_area", // CONFIRMED — used directly in the nurture emails
  deliveryModel: "ai_assessment__delivery_model", // unconfirmed name
  completedAt: "ai_assessment__completed_at", // unconfirmed name
};

async function fetchHubspotAssessments() {
  const properties = [
    "firstname", "lastname", "email", "phone", "company",
    ...Object.values(PROPERTY_MAP),
  ];

  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: PROPERTY_MAP.topOpportunity, operator: "HAS_PROPERTY" }] },
      ],
      properties,
      limit: 100,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    }),
  });

  if (!res.ok) throw new Error(`HubSpot API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return (data.results || []).map((r) => {
    const p = r.properties || {};
    let categories = {};
    try { categories = p[PROPERTY_MAP.categories] ? JSON.parse(p[PROPERTY_MAP.categories]) : {}; } catch { /* leave empty if not valid JSON */ }
    return {
      id: r.id,
      name: [p.firstname, p.lastname].filter(Boolean).join(" "),
      email: p.email || "",
      phone: p.phone || "",
      company: p.company || "",
      path: p[PROPERTY_MAP.path] || "general",
      overallScore: p[PROPERTY_MAP.overallScore] ? Number(p[PROPERTY_MAP.overallScore]) : null,
      tier: p[PROPERTY_MAP.tier] || "", // Exploring | Building | Emerging | AI-Ready
      categories,
      topOpportunity: p[PROPERTY_MAP.topOpportunity] || "",
      deliveryModel: p[PROPERTY_MAP.deliveryModel] || "",
      completedAt: p[PROPERTY_MAP.completedAt] || null,
    };
  });
}

module.exports = { fetchHubspotAssessments };
