// lib/emailCheck.js
//
// Free, no-API-key validation to catch obviously-bad addresses before they
// go into a new batch — not a substitute for a real verification service
// (won't catch a syntactically-valid address at a domain that accepts all
// mail then silently drops it, a full mailbox, etc.), but it filters out
// typos, fake domains, and made-up addresses at zero cost.
//
// Two checks:
//   1. Syntax — a reasonably strict (not fully RFC 5322, nobody implements
//      that correctly) regex that catches the obvious junk.
//   2. MX record — does the domain even have a mail server configured?
//      A domain with no MX record can't receive mail, full stop, so this
//      alone screens out a meaningful chunk of dead/fake domains.
//
// MX lookups are cached in-memory for the life of the process (many
// contacts in a batch often share a domain — no reason to look up
// "gmail.com" 200 times in one run) AND in the KV cache across runs, since
// a domain's MX status rarely changes day to day.

const dns = require("dns").promises;
const { getCache, setCache } = require("./store");

const MX_CACHE_KEY_PREFIX = "mxcheck:";
const MX_CACHE_TTL_DAYS = 30; // re-check occasionally in case a domain's mail setup changes

// Deliberately not a full RFC 5322 implementation — just strict enough to
// catch missing @, missing TLD, spaces, and other obvious junk without
// false-positiving on legitimate-but-unusual addresses (e.g. + aliases).
const EMAIL_SYNTAX_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function hasValidSyntax(email) {
  return typeof email === "string" && EMAIL_SYNTAX_RE.test(email.trim());
}

async function domainHasMx(domain) {
  const cacheKey = `${MX_CACHE_KEY_PREFIX}${domain.toLowerCase()}`;
  const cached = await getCache(cacheKey, null);
  if (cached && Date.now() - cached.checkedAt < MX_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
    return cached.hasMx;
  }

  let hasMx = false;
  try {
    const records = await dns.resolveMx(domain);
    hasMx = Array.isArray(records) && records.length > 0;
  } catch (e) {
    // ENOTFOUND / ENODATA -> no MX record, genuinely no mail server.
    // Any other error (timeout, etc.) — treat as "unknown," don't penalize
    // a real domain for a transient DNS hiccup. Caller decides what to do
    // with unknown vs. confirmed-false.
    hasMx = e.code === "ENOTFOUND" || e.code === "ENODATA" ? false : null;
  }

  await setCache(cacheKey, { hasMx, checkedAt: Date.now() });
  return hasMx;
}

// Returns { ok: true } if the address passes both checks, or
// { ok: false, reason } if it fails one. `null` MX results (DNS lookup
// itself failed, not "no MX found") are treated as passing — a transient
// DNS error shouldn't permanently exclude someone from a batch.
async function validateEmail(email) {
  if (!hasValidSyntax(email)) {
    return { ok: false, reason: "invalid syntax" };
  }
  const domain = email.trim().split("@")[1];
  const mx = await domainHasMx(domain);
  if (mx === false) {
    return { ok: false, reason: "no MX record for domain" };
  }
  return { ok: true };
}

// Filters a batch of contacts down to only those passing validation.
// Returns both the surviving contacts and a log of who got filtered and why
// — useful for a periodic sanity check on how much this is actually catching.
async function filterValidEmails(contacts) {
  const kept = [];
  const rejected = [];
  for (const contact of contacts) {
    const result = await validateEmail(contact.email || "");
    if (result.ok) {
      kept.push(contact);
    } else {
      rejected.push({ email: contact.email, reason: result.reason });
    }
  }
  return { kept, rejected };
}

module.exports = { validateEmail, hasValidSyntax, domainHasMx, filterValidEmails };
