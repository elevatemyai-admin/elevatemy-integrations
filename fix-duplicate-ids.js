// ONE-TIME MIGRATION — run this once, after deploying the sync.js fix.
//
// The old id generator did:
//   `zoho_${Buffer.from(email).toString("hex").slice(0,12)}`
// which is just the first 6 characters of the raw email (hex-encoded),
// NOT a hash — so "chris.brown@..." and "chris.hardy@..." collided on the
// exact same id. This script recomputes every zoho_*/beehiiv_* client's id
// using the same hashed scheme now in sync.js, so ids stop colliding.
//
// Safe to run: client records are self-contained (tasks/billing/social are
// nested inside each client object, not referenced by id from anywhere
// else in the data), so changing a client's id doesn't orphan anything.
//
// Usage:
//   node fix-duplicate-ids.js https://elevatemy-integrations.vercel.app
//
// (Pass your actual CRM API base URL as the one argument.)

const crypto = require("crypto");

const BASE_URL = (process.argv[2] || "").replace(/\/$/, "");
if (!BASE_URL) {
  console.error("Usage: node fix-duplicate-ids.js <crm-api-base-url>");
  process.exit(1);
}

function newIdFor(prefix, email) {
  return `${prefix}_${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
}

async function main() {
  console.log(`Fetching current CRM data from ${BASE_URL}/api/crm/data ...`);
  const getRes = await fetch(`${BASE_URL}/api/crm/data`);
  if (!getRes.ok) throw new Error(`GET failed: ${getRes.status}`);
  const data = await getRes.json();
  const clients = data.clients || [];

  console.log(`Loaded ${clients.length} client records.`);

  // Track how many ids actually change, and watch for any id collisions
  // that survive the fix (should be ~impossible, but worth checking).
  let changed = 0;
  const seenIds = new Map(); // newId -> [emails]
  const before = new Map(clients.map((c) => [c.id, c]));

  const fixed = clients.map((c) => {
    const email = (c.email || "").toLowerCase().trim();
    let newId = c.id;

    if (email && (c.id || "").startsWith("zoho_")) newId = newIdFor("zoho", email);
    else if (email && (c.id || "").startsWith("beehiiv_")) newId = newIdFor("beehiiv", email);

    if (newId !== c.id) changed++;

    const list = seenIds.get(newId) || [];
    list.push(email || "(no email)");
    seenIds.set(newId, list);

    return newId === c.id ? c : { ...c, id: newId };
  });

  // Report any ids that STILL collide after the fix — this would only
  // happen for two genuinely-identical emails (a real duplicate entry),
  // not a hashing coincidence.
  const stillColliding = [...seenIds.entries()].filter(([, emails]) => emails.length > 1);
  if (stillColliding.length) {
    console.log("\n⚠️  These ids still collide after the fix (likely true duplicate emails, needs manual review):");
    stillColliding.forEach(([id, emails]) => console.log(`  ${id}: ${emails.join(", ")}`));
  } else {
    console.log("\n✅ No remaining id collisions.");
  }

  console.log(`\n${changed} client id(s) will be updated.`);
  if (changed === 0) {
    console.log("Nothing to do — exiting without writing.");
    return;
  }

  data.clients = fixed;
  console.log(`Writing corrected data back to ${BASE_URL}/api/crm/data ...`);
  const postRes = await fetch(`${BASE_URL}/api/crm/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!postRes.ok) throw new Error(`POST failed: ${postRes.status}`);
  console.log("✅ Done. Ids fixed and saved.");
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
