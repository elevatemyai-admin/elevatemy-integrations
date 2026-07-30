// Approves (sends) or rejects (discards) an AI-drafted reply sitting in
// the pending-approval queue. Nothing an AI drafts ever sends without a
// human clicking Approve here first.

const { getCache, setCache } = require("../../lib/store");
const { sendEmail } = require("../../lib/gmail");
const crypto = require("crypto");

const CRM_DATA_KEY = "crm:data";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { pendingEmailId, action, editedSubject, editedBody } = req.body || {};
  if (!pendingEmailId || !["approve", "reject"].includes(action)) {
    return res.status(400).json({ error: "pendingEmailId and action ('approve' or 'reject') are required" });
  }

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] };
    const pending = crmData.pendingEmails || [];
    const idx = pending.findIndex((p) => p.id === pendingEmailId);
    if (idx === -1) return res.status(404).json({ error: "Pending email not found — it may have already been approved or rejected" });

    const draft = pending[idx];
    // A person may have edited the subject/body in the approval UI before
    // clicking Approve — use their edited version if provided, otherwise
    // send the AI's original draft as-is.
    const subject = editedSubject || draft.subject;
    const body = editedBody || draft.body;

    if (action === "reject") {
      crmData.pendingEmails = pending.filter((p) => p.id !== pendingEmailId);
      // Belt-and-suspenders: explicitly record this message as handled so
      // it can never resurface as a new draft on a future sync, even if
      // sync.js's own tracking somehow missed it for this message.
      if (draft.sourceMessageId) {
        const settings = crmData.settings || {};
        const handled = new Set(settings.gmailHandledMessageIds || []);
        handled.add(draft.sourceMessageId);
        crmData.settings = { ...settings, gmailHandledMessageIds: Array.from(handled).slice(-2000) };
      }
      await setCache(CRM_DATA_KEY, crmData);
      return res.status(200).json({ ok: true, action: "rejected" });
    }

    // action === "approve"
    let sendResult;
    try {
      sendResult = await sendEmail({ to: draft.to, from: draft.from, subject, body });
    } catch (e) {
      console.error("[gmail/approve] send failed:", e.message);
      return res.status(502).json({ error: "Send failed: " + e.message });
    }

    const clients = crmData.clients || [];
    const cIdx = clients.findIndex((c) => c.id === draft.clientId);
    if (cIdx !== -1) {
      const existing = clients[cIdx];
      const event = { type: "email_sent", campaignName: subject, messageId: sendResult.id || "", ts: new Date().toISOString() };
      clients[cIdx] = { ...existing, engagementHistory: [...(existing.engagementHistory || []), event].slice(-100) };
      crmData.clients = clients;
      crmData.activityLog = [
        { id: crypto.randomBytes(4).toString("hex"), text: `Approved and sent AI-drafted reply to ${existing.name || existing.email}: "${subject}"`, ts: new Date().toISOString() },
        ...(crmData.activityLog || []),
      ].slice(0, 300);
    }

    crmData.pendingEmails = pending.filter((p) => p.id !== pendingEmailId);
    await setCache(CRM_DATA_KEY, crmData);
    res.status(200).json({ ok: true, action: "approved", messageId: sendResult.id });
  } catch (e) {
    console.error("[gmail/approve] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
};
