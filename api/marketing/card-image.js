// Serves the raw PNG bytes for a content item's generated branded card
// (see api/marketing/design-card.js, which creates it). Kept as a
// separate GET route rather than embedding the image as base64 in
// crm:data's JSON payload, so the frontend can just point an <img> tag
// straight at this URL.

const { getCache } = require("../../lib/store");

module.exports = async (req, res) => {
  const { itemId } = req.query || {};
  if (!itemId) return res.status(400).send("Missing itemId");

  try {
    const b64 = await getCache(`marketing:image:${itemId}`, null);
    if (!b64) return res.status(404).send("No generated image for this item yet");

    const buffer = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(buffer);
  } catch (e) {
    console.error("[marketing/card-image] failed:", e.message);
    res.status(500).send("Error serving image");
  }
};
