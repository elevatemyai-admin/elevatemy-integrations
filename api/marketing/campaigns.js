// CRUD for Marketing Hub campaign containers — the grouping wrapper that
// content items (emails, LinkedIn/Facebook posts) belong to. Same
// read-modify-write pattern as api/crm/data.js and the gmail routes: each
// api/*.js file is its own serverless function, so this reads/writes the
// shared crm:data blob directly rather than importing shared route logic.

const { getCache, setCache } = require("../../lib/store");
const crypto = require("crypto");

const CRM_DATA_KEY = "crm:data";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || {};
    if (!crmData.marketingHub) crmData.marketingHub = { campaigns: [], contentItems: [] };

    if (req.method === "GET") {
      return res.status(200).json({ campaigns: crmData.marketingHub.campaigns });
    }

    if (req.method === "POST") {
      const { name, goal, notes, audience, startDate, endDate } = req.body || {};
      if (!name) return res.status(400).json({ error: "name is required" });
      const campaign = {
        id: crypto.randomBytes(6).toString("hex"),
        name,
        goal: goal || "",
        notes: notes || "",
        audience: audience || "",
        startDate: startDate || "",
        endDate: endDate || "",
        status: "draft", // draft | active | completed
        createdAt: new Date().toISOString(),
      };
      crmData.marketingHub.campaigns = [campaign, ...crmData.marketingHub.campaigns];
      await setCache(CRM_DATA_KEY, crmData);
      return res.status(200).json({ ok: true, campaign });
    }

    if (req.method === "PATCH") {
      const { campaignId, updates } = req.body || {};
      if (!campaignId) return res.status(400).json({ error: "campaignId is required" });
      const idx = crmData.marketingHub.campaigns.findIndex((c) => c.id === campaignId);
      if (idx === -1) return res.status(404).json({ error: "Campaign not found" });
      crmData.marketingHub.campaigns[idx] = { ...crmData.marketingHub.campaigns[idx], ...(updates || {}) };
      await setCache(CRM_DATA_KEY, crmData);
      return res.status(200).json({ ok: true, campaign: crmData.marketingHub.campaigns[idx] });
    }

    return res.status(405).json({ error: "GET, POST, or PATCH only" });
  } catch (e) {
    console.error("[marketing/campaigns] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
};
