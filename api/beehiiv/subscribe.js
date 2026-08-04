// Subscribes one person to the newsletter directly from the CRM — the
// write counterpart to subscribers.js (which is deliberately cache-only).
// This one talks to Beehiiv live, on-demand, because it's a single manual
// click by someone in the CRM, not a bulk/scheduled job — nothing here can
// run away and hammer Beehiiv's API the way a cache-miss-triggered fetch
// could.

const { subscribeToBeehiiv } = require("../../lib/beehiiv");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { email, firstName, lastName, sendWelcomeEmail } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "A valid email is required" });
  }

  try {
    const subscription = await subscribeToBeehiiv({
      email,
      firstName,
      lastName,
      sendWelcomeEmail: sendWelcomeEmail !== false, // default true unless explicitly turned off
    });
    res.status(200).json({ ok: true, subscription });
  } catch (e) {
    console.error("[beehiiv/subscribe] failed:", e.message);
    res.status(502).json({ error: e.message });
  }
};
