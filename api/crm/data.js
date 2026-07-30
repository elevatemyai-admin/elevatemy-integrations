// Replaces the Claude-artifact-only window.storage API now that the CRM is
// a real deployed app. Same simple whole-blob pattern: GET returns the
// current state, POST overwrites it. Uses the same Vercel KV already set up
// for the integrations backend.

const { getCache, setCache } = require("../../lib/store");

const CRM_KEY = "crm:data";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    try {
      const data = await getCache(CRM_KEY, null);
      res.status(200).json(data || { clients: [], marketingCampaigns: [], activityLog: [], settings: {}, emailTemplates: [], pendingEmails: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (req.method === "POST") {
    try {
      await setCache(CRM_KEY, req.body);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: "GET or POST only" });
};
