// Generates a branded graphic for a Content Studio item on demand, using
// lib/designAgent.js (AI headline + SVG template + sharp rasterization).
//
// The resulting PNG is stored under its OWN cache key
// (marketing:image:{itemId}), deliberately separate from the main
// crm:data blob — embedding base64 images directly inside crm:data would
// bloat that JSON on every save/load and risk hitting size limits on
// whatever store lib/store.js is backed by. The content item itself just
// gets a small `hasImage: true` flag; the actual image bytes are fetched
// separately via GET api/marketing/card-image.js.

const { getCache, setCache } = require("../../lib/store");
const { renderBrandedCard } = require("../../lib/designAgent");

const CRM_DATA_KEY = "crm:data";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });

  try {
    const crmData = (await getCache(CRM_DATA_KEY, null)) || {};
    if (!crmData.marketingHub) crmData.marketingHub = { campaigns: [], contentItems: [] };
    const items = crmData.marketingHub.contentItems;
    const idx = items.findIndex((c) => c.id === itemId);
    if (idx === -1) return res.status(404).json({ error: "Content item not found" });

    const item = items[idx];
    let headline, pngBuffer;
    try {
      ({ headline, pngBuffer } = await renderBrandedCard({ body: item.body, type: item.type }));
    } catch (e) {
      return res.status(502).json({ error: "Card generation failed: " + e.message });
    }

    // Store the image bytes as base64 under a dedicated key — small
    // metadata (not the image itself) goes into the main crm:data blob.
    await setCache(`marketing:image:${itemId}`, pngBuffer.toString("base64"));

    items[idx] = { ...item, hasImage: true, imageHeadline: headline, imageGeneratedAt: new Date().toISOString() };
    crmData.marketingHub.contentItems = items;
    await setCache(CRM_DATA_KEY, crmData);

    res.status(200).json({ ok: true, headline, imageUrl: `/api/marketing/card-image?itemId=${itemId}` });
  } catch (e) {
    console.error("[marketing/design-card] failed:", e.message);
    res.status(500).json({ error: e.message });
  }
};
