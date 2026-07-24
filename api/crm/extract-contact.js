// Extracts contact info from an uploaded screenshot (LinkedIn contact
// card, business card, etc.) via lib/contactExtractor.js. Returns
// suggested fields only — the frontend shows these in an editable form,
// nothing gets saved as a real client until a human confirms.

const { extractContactFromImage } = require("../../lib/contactExtractor");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: "imageBase64 is required" });

  try {
    const contact = await extractContactFromImage({ imageBase64, mediaType });
    res.status(200).json({ ok: true, contact });
  } catch (e) {
    console.error("[crm/extract-contact] failed:", e.message);
    res.status(502).json({ error: e.message });
  }
};
