// lib/geo.js
//
// Sorts the never-contacted portion of master_list.csv by distance from home
// base, nearest first — so each new batch pulled by the list-health job
// naturally expands outward in concentric circles instead of pulling random
// or arbitrarily-ordered contacts.
//
// Uses the `zipcodes` npm package, which bundles US zip-code centroids
// directly in the package (no external API call, no ongoing cost, works
// offline) — install with: npm install zipcodes
//
// Assumes each contact row has EITHER a zip-like field (zip, zipcode,
// postal_code) OR city + state fields — checks for a zip first since it's
// far more precise, falls back to city/state only if no zip is present.

const zipcodes = require("zipcodes");

// Downtown San Diego — change to your actual office zip if different.
const HOME_ZIP = process.env.CAMPAIGN_HOME_ZIP || "92101";

function extractZip(contact) {
  return (
    contact.zip || contact.zipcode || contact.postal_code || contact.Zip || contact.ZipCode || ""
  ).toString().trim().slice(0, 5); // zipcodes package wants 5-digit strings; strips any ZIP+4 suffix
}

function extractCityState(contact) {
  const city = contact.city || contact.City || "";
  const state = contact.state || contact.State || "";
  return { city, state };
}

// Returns distance in miles from home base, or null if the contact's
// location can't be resolved at all (missing/invalid zip AND no city/state).
function distanceFromHome(contact) {
  const zip = extractZip(contact);
  if (zip && /^\d{5}$/.test(zip)) {
    const d = zipcodes.distance(HOME_ZIP, zip);
    // zipcodes.distance returns undefined for an unrecognized zip rather
    // than throwing — treat that the same as "unresolvable."
    if (typeof d === "number" && !Number.isNaN(d)) return d;
  }

  // Fallback: no usable zip, try city/state -> pick the first matching
  // zip's coordinates as a rough stand-in (city-level precision, not
  // exact, but still meaningfully orders "same metro" before "cross-country").
  const { city, state } = extractCityState(contact);
  if (city && state) {
    const matches = zipcodes.lookupByName(city, state);
    if (matches && matches.length) {
      const d = zipcodes.distance(HOME_ZIP, matches[0].zip);
      if (typeof d === "number" && !Number.isNaN(d)) return d;
    }
  }

  return null; // genuinely unresolvable — sorted to the end, not excluded
}

// Sorts an array of contacts nearest-first. Contacts with no resolvable
// location are pushed to the end (in their original relative order) rather
// than dropped, so nobody silently disappears from the master list just
// because their row is missing a zip.
function sortByDistanceFromHome(contacts) {
  const withDistance = contacts.map((c) => ({ contact: c, distance: distanceFromHome(c) }));
  withDistance.sort((a, b) => {
    if (a.distance === null && b.distance === null) return 0;
    if (a.distance === null) return 1;  // unresolvable -> end
    if (b.distance === null) return -1;
    return a.distance - b.distance;     // nearest first
  });
  return withDistance.map((w) => w.contact);
}

// Convenience for the replenishment job: given the full master list and the
// set of emails already contacted (any status — sent, bounced, engaged,
// doesn't matter, just "already used"), returns the next N nearest
// not-yet-contacted contacts.
function nextBatchByDistance(masterList, alreadyContactedEmails, batchSize) {
  const contactedSet = new Set(
    Array.from(alreadyContactedEmails, (e) => (e || "").toLowerCase().trim())
  );
  const remaining = masterList.filter(
    (c) => !contactedSet.has((c.email || "").toLowerCase().trim())
  );
  const sorted = sortByDistanceFromHome(remaining);
  return sorted.slice(0, batchSize);
}

module.exports = {
  distanceFromHome,
  sortByDistanceFromHome,
  nextBatchByDistance,
  HOME_ZIP,
};
