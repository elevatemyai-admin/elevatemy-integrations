// One-time import: 4 real General Business assessment completions pulled
// from a HubSpot contacts export (July 20, 2026). Zero Financial Services
// completions exist to import — confirmed none were ever saved on that side.
// One record ("Tled Workflow-Testing" / cwmteammarketing@gmail.com) was
// excluded as an obvious internal test submission, not a real lead.
//
// SAFE BY DESIGN: fetches current CRM data first, matches by email (updates
// an existing client's assessment info if they're already in the CRM,
// creates a new one only if not), and posts the WHOLE merged object back —
// since /api/crm/data's POST fully overwrites rather than merges.
//
// Run with: node import-hubspot-assessments.js

const CRM_BASE = "https://elevatemy-integrations.vercel.app";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// NOTE: GEN_CATEGORIES in App.jsx was updated to use the real dimension
// keys (bf/dt/oa/cg/air) matching this data, so the actual scores now go
// into the category sliders directly. The dimension breakdown is ALSO kept
// in `notes` as readable text for quick reference, alongside the adoption
// blocker / desired outcome answers, which have nowhere else to live.
const RECORDS = [
  {
    firstName: "Devon", lastName: "", company: "Devon Vernetti, Inc.", email: "acu.devon@gmail.com",
    tier: "Building", overallScore: 52, topOpportunity: "Business Foundations", completedDate: "2026-07-01",
    dims: { bf: 25, dt: 75, oa: 58, cg: 50, air: 50 },
    blocker: "Not knowing where to start or what's relevant for us",
    desiredOutcome: "Getting more leads and converting more sales",
  },
  {
    firstName: "Dale", lastName: "", company: "Dale Ledbetter & Assoc", email: "daleledbetter48@gmail.com",
    tier: "Exploring", overallScore: 30, topOpportunity: "Data & Technology", completedDate: "2026-06-26",
    dims: { bf: 33, dt: 17, oa: 17, cg: 67, air: 17 },
    blocker: "Not knowing where to start or what's relevant for us",
    desiredOutcome: "Saving time on admin and repetitive tasks",
  },
  {
    firstName: "Aransas", lastName: "Savas", company: "LiveUp Daily", email: "aransas@liveupdaily.com",
    tier: "Emerging", overallScore: 55, topOpportunity: "Business Foundations", completedDate: "2026-06-25",
    dims: { bf: 42, dt: 42, oa: 75, cg: 58, air: 58 },
    blocker: "Concerns about data privacy or accuracy",
    desiredOutcome: "Saving time on admin and repetitive tasks",
  },
  {
    firstName: "Skyler", lastName: "Pinto", company: "RemoteLink Solutions", email: "spinto@remotelinksolutions.com",
    tier: "Emerging", overallScore: 62, topOpportunity: "Operations & Automation", completedDate: "2026-07-08",
    dims: { bf: 67, dt: 67, oa: 50, cg: 58, air: 67 },
    blocker: "Not knowing where to start or what's relevant for us",
    desiredOutcome: "Reducing costs and improving profit margins",
  },
];

function buildNotes(r) {
  return [
    `Imported from HubSpot (General Business assessment, completed ${r.completedDate}).`,
    `Dimension breakdown — Business Foundations: ${r.dims.bf}, Data & Technology: ${r.dims.dt}, Operations & Automation: ${r.dims.oa}, Customer & Growth: ${r.dims.cg}, AI Readiness: ${r.dims.air}.`,
    `Biggest AI adoption blocker: ${r.blocker}`,
    `Most desired outcome: ${r.desiredOutcome}`,
  ].join("\n");
}

async function main() {
  console.log("Fetching current CRM data...");
  const getRes = await fetch(`${CRM_BASE}/api/crm/data`);
  if (!getRes.ok) throw new Error(`GET failed: ${getRes.status} ${await getRes.text()}`);
  const current = await getRes.json();
  let clients = current.clients || [];

  // Completing a full assessment is a stronger signal than a campaign click
  // (which is already "opportunity") — so this lands at opportunity too, not
  // prospect. Never downgrades an existing active/inactive client.
  const STATUS_TIER = { lead: 1, prospect: 1, opportunity: 2, active: 3, inactive: 3 };

  let createdCount = 0;
  let updatedCount = 0;

  for (const r of RECORDS) {
    const email = r.email.toLowerCase().trim();
    const idx = clients.findIndex((c) => (c.email || "").toLowerCase().trim() === email);
    const assessment = {
      path: "general",
      completed: true,
      date: r.completedDate,
      categories: { bf: r.dims.bf, dt: r.dims.dt, oa: r.dims.oa, cg: r.dims.cg, air: r.dims.air },
      overallScore: r.overallScore,
      tier: r.tier,
      grade: "",
      topOpportunity: r.topOpportunity,
      deliveryModel: "",
      consultationBooked: false,
      consultationDate: "",
      notes: buildNotes(r),
    };

    if (idx === -1) {
      const now = new Date().toISOString();
      clients.push({
        id: uid(),
        name: [r.firstName, r.lastName].filter(Boolean).join(" "),
        firstName: r.firstName,
        lastName: r.lastName,
        company: r.company,
        email: r.email,
        phone: "",
        status: "opportunity",
        tags: [],
        hidden: false,
        proBono: false,
        createdAt: now,
        assessment,
        newsletter: { subscribed: false, link: "" },
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
    } else {
      // Already a client — attach the real assessment data, and upgrade
      // status to opportunity if they're currently at a lower tier
      // (lead/prospect). Never downgrades active/inactive.
      const existing = clients[idx];
      const currentTier = STATUS_TIER[existing.status] || 1;
      const nextStatus = currentTier < STATUS_TIER.opportunity ? "opportunity" : existing.status;
      clients[idx] = { ...existing, status: nextStatus, assessment };
      updatedCount++;
    }
  }

  const merged = {
    ...current,
    clients,
    activityLog: [
      { id: uid(), text: `Imported ${RECORDS.length} HubSpot assessment completions (${createdCount} new, ${updatedCount} updated)`, ts: new Date().toISOString() },
      ...(current.activityLog || []),
    ].slice(0, 50),
  };

  console.log(`Posting merged data back (${createdCount} created, ${updatedCount} updated)...`);
  const postRes = await fetch(`${CRM_BASE}/api/crm/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });
  if (!postRes.ok) throw new Error(`POST failed: ${postRes.status} ${await postRes.text()}`);
  console.log("Done. Refresh the CRM and check the Clients tab for these 4 assessment completions.");
}

main().catch((e) => {
  console.error("Import failed:", e.message);
  process.exit(1);
});
