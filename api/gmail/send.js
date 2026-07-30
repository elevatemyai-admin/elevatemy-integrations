// Sends a real email through Gmail (as tracy@ or matt@elevatemy.ai) from
// inside the CRM, and logs it against the client record it was sent to —
// same self-contained read-modify-write pattern as the other api/*.js
// routes (each is its own serverless function with its own KV access,
// not sharing a module graph with sync.js or submit.js).

const { getCache, setCache } = require("../../lib/store");
const { sendEmail } = require("../../lib/gmail");
const crypto = require("crypto");

const CRM_DATA_KEY = "crm:data";
const ALLOWED_FROM = ["tracy@elevatemy.ai", "matt@elevatemy.ai"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { to, from, subject, body, clientId } = req.body || {};
  if (!to || !subject || !body) return res.status(400).json({ error: "to, subject, and body are required" });
  const fromAddress = ALLOWED_FROM.includes(from) ? from : "tracy@elevatemy.ai";

  let sendResult;
  try {
    sendResult = await sendEmail({ to, from: fromAddress, subject, body });
  } catch (e) {
    console.error("[gmail/send] send failed:", e.message);
    return res.status(502).json({ error: "Send failed: " + e.message });
  }

  // Email genuinely sent at this point — a logging failure below shouldn't
  // be reported back as a send failure, since the message did go out.
  let logResult = { ok: false };
  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
    const clients = crmData.clients || [];
    const idx = clientId
      ? clients.findIndex((c) => c.id === clientId)
      : clients.findIndex((c) => (c.email || "").toLowerCase().trim() === to.toLowerCase().trim());

    if (idx !== -1) {
      const existing = clients[idx];
      const event = { type: "email_sent", campaignName: subject, messageId: sendResult.id || "", ts: new Date().toISOString() };
      clients[idx] = { ...existing, engagementHistory: [...(existing.engagementHistory || []), event].slice(-100) };
      crmData.clients = clients;
      crmData.activityLog = [
        { id: crypto.randomBytes(4).toString("hex"), text: `Emailed ${existing.name || existing.email}: "${subject}"`, ts: new Date().toISOString() },
        ...(crmData.activityLog || []),
      ].slice(0, 300);
      await setCache(CRM_DATA_KEY, crmData);
      logResult = { ok: true, loggedTo: existing.id };
    } else {
      logResult = { ok: true, loggedTo: null }; // sent fine, just not tied to a known client
    }
  } catch (e) {
    console.error("[gmail/send] logging to CRM failed (email still sent):", e.message);
  }

  res.status(200).json({ ok: true, messageId: sendResult.id, log: logResult });
};
