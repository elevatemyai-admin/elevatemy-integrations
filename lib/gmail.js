// Gmail integration: reads recent incoming email (to detect messages from
// known CRM clients) and, later, sends real email from inside the CRM.
//
// tracy@elevatemy.ai and matt@elevatemy.ai are the SAME Gmail inbox —
// matt@ is configured as a "send mail as" alias on Tracy's account, not a
// separate mailbox — so one OAuth connection (to Tracy's account) covers
// both addresses. No need to connect a second Gmail account.
//
// Setup: one-time OAuth consent via Google Cloud Console + OAuth
// Playground (see project notes), producing GMAIL_CLIENT_ID,
// GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN — same
// refresh-token-in-KV pattern as lib/zoho.js, so we don't re-auth on
// every request.

const { getCache, setCache } = require("./store");

async function getGmailAccessToken() {
  const cached = await getCache("gmail:token", null);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const params = new URLSearchParams({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Gmail token refresh failed: " + JSON.stringify(data));
  }

  await setCache("gmail:token", {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

async function gmailFetch(url, opts = {}) {
  const token = await getGmailAccessToken();
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Pulls a header value out of a Gmail API message payload (headers are a
// flat array of {name, value} pairs, not an object).
function getHeader(message, name) {
  const h = (message.payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// Parses a "Display Name <email@domain.com>" or bare "email@domain.com"
// From header into its parts.
function parseFromHeader(raw) {
  const match = (raw || "").match(/^(.*?)\s*<(.+?)>\s*$/);
  if (match) return { name: match[1].replace(/"/g, "").trim(), email: match[2].trim().toLowerCase() };
  return { name: "", email: (raw || "").trim().toLowerCase() };
}

// Fetches inbox messages received after a given timestamp (ms since epoch).
// Only returns the handful of fields we actually need (from, subject,
// date, snippet) — not full message bodies, to keep this fast and cheap.
// Caps at 50 messages per run; a daily sync catching up on a genuinely
// larger backlog would need pagination, but that's not expected in normal
// day-to-day use.
async function fetchRecentIncomingEmails(sinceMs) {
  const afterSeconds = Math.floor(sinceMs / 1000);
  const listData = await gmailFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:inbox after:${afterSeconds}`)}&maxResults=50`
  );
  const ids = (listData.messages || []).map(m => m.id);
  const results = [];
  for (const id of ids) {
    try {
      const msg = await gmailFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const from = parseFromHeader(getHeader(msg, "From"));
      const subject = getHeader(msg, "Subject") || "(no subject)";
      const ts = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
      results.push({ messageId: id, fromEmail: from.email, fromName: from.name, subject, snippet: msg.snippet || "", ts });
    } catch (e) {
      console.warn(`[gmail] failed to fetch message ${id}:`, e.message);
    }
  }
  return results;
}

// Fetches Sent-folder messages after a given timestamp (ms since epoch).
// Used to detect whether a client has already been replied to — whether
// that reply went out through the CRM's send/approve buttons, or Tracy
// replying directly in Gmail. Keeps the raw "To" header (lowercased)
// rather than trying to parse a single address out of it, since a Sent
// message's To header can contain multiple comma-separated recipients —
// a substring match against a known client email is simpler and more
// robust than a strict parse here.
async function fetchRecentSentEmails(sinceMs) {
  const afterSeconds = Math.floor(sinceMs / 1000);
  const listData = await gmailFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent after:${afterSeconds}`)}&maxResults=50`
  );
  const ids = (listData.messages || []).map(m => m.id);
  const results = [];
  for (const id of ids) {
    try {
      const msg = await gmailFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const toRaw = (getHeader(msg, "To") || "").toLowerCase();
      const subject = getHeader(msg, "Subject") || "(no subject)";
      const ts = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString();
      results.push({ messageId: id, toRaw, subject, ts });
    } catch (e) {
      console.warn(`[gmail] failed to fetch sent message ${id}:`, e.message);
    }
  }
  return results;
}

// RFC 2047 encodes a header value if it contains non-ASCII characters —
// needed because raw UTF-8 bytes dropped directly into a header (which is
// what this file used to do) get misinterpreted by mail clients following
// header-specific decoding rules distinct from the body's declared
// charset. This showed up in production as garbled subject lines — an em
// dash or curly quote turning into "Ã¢Â€Â"”-style mojibake — even though
// the body rendered fine, since the body's charset was correctly declared
// but the Subject header's wasn't encoded at all.
function encodeHeaderValue(value) {
  if (/^[\x00-\x7F]*$/.test(value)) return value; // pure ASCII — nothing to encode
  const b64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

// Known links the reply agent (lib/claude.js) can include, mapped to a
// friendly button label — matched by a distinctive substring rather than
// an exact URL, since each includes a UUID/query string that varies.
const BUTTON_LABELS = [
  { test: (url) => url.includes("meetings.hubspot.com"), label: "Schedule a Call →" },
  { test: (url) => url.includes("/pricing"), label: "View Pricing →" },
  { test: (url) => url.includes("beehiiv.com"), label: "Subscribe to the Newsletter →" },
];
function labelForUrl(url) {
  const match = BUTTON_LABELS.find((b) => b.test(url));
  return match ? match.label : "Open Link →";
}

// Converts a plain-text email body (what the AI drafts and what gets
// edited in the CRM's textarea) into simple HTML — turning any bare
// http(s) URL into an actual styled button rather than a plain pasted
// link, and preserving paragraph breaks. This is what actually lets
// "links be buttons": Gmail (and every other client) can only render a
// button-looking link inside an HTML email, not a plain-text one.
function plainTextToHtmlWithButtons(text) {
  const escaped = (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const withButtons = escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    // A URL at the end of a sentence often has trailing punctuation
    // (a period, a closing paren) that isn't actually part of the link —
    // strip it off the button target and put it back after the button.
    const trailingMatch = url.match(/[)\].,;:!?]+$/);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
    const label = labelForUrl(cleanUrl);
    return `</p><p style="margin:16px 0;"><a href="${cleanUrl}" style="display:inline-block; background:#1B3A6B; color:#ffffff; padding:11px 22px; border-radius:6px; text-decoration:none; font-weight:600; font-family:Arial,sans-serif; font-size:14px;">${label}</a></p><p style="margin:0 0 16px; font-family:Arial,sans-serif; font-size:15px; color:#1a1a1a; line-height:1.5;">${trailing}`;
  });

  const paragraphs = withButtons
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px; font-family:Arial,sans-serif; font-size:15px; color:#1a1a1a; line-height:1.5;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  return `<div>${paragraphs}</div>`;
}

// Sends real email through Gmail as either tracy@elevatemy.ai or
// matt@elevatemy.ai (both work — matt@ is a "send mail as" alias already
// configured on Tracy's account, so Gmail accepts either address in the
// From header without needing a second OAuth connection).
//
// Gmail's API wants the whole message as a base64url-encoded raw RFC 2822
// blob, not separate fields — this builds that manually rather than
// pulling in a mail-formatting library for something this simple.
async function sendEmail({ to, from, subject, body }) {
  const htmlBody = plainTextToHtmlWithButtons(body);
  const messageLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    htmlBody,
  ];
  const raw = Buffer.from(messageLines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return gmailFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
}

module.exports = { getGmailAccessToken, gmailFetch, fetchRecentIncomingEmails, fetchRecentSentEmails, sendEmail };
