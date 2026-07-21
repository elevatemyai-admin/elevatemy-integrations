// The "agent": runs daily after the sync job, finds assessment completions
// nobody has triaged yet, has Claude draft an outreach email + a suggested
// next action for each, and emails the whole batch to your team as one digest.
// It never sends anything to the lead directly — a human reviews and sends.

const { getCache, getSeenIds, addSeenIds } = require("../../lib/store");
const { draftLeadTriage } = require("../../lib/claude");
const { sendEmail } = require("../../lib/email");

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  return req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  try {
    const assessments = await getCache("cache:assessments", []);
    const seen = await getSeenIds("triaged-assessments");
    const fresh = assessments.filter((a) => a.id && !seen.has(a.id));

    if (fresh.length === 0) {
      return res.status(200).json({ triaged: 0, message: "Nothing new since last run." });
    }

    const drafts = [];
    for (const lead of fresh) {
      try {
        const draft = await draftLeadTriage(lead);
        drafts.push({ lead, draft });
      } catch (e) {
        drafts.push({ lead, draft: `(Claude drafting failed: ${e.message})` });
      }
    }

    const html = drafts
      .map(
        ({ lead, draft }) => `
        <h3>${lead.name || "Unnamed lead"} — ${lead.company || "no company"}</h3>
        <p><b>Score:</b> ${lead.overallScore ?? "n/a"}% (${lead.path})</p>
        <pre style="white-space:pre-wrap;font-family:inherit;">${draft}</pre>
        <hr/>`
      )
      .join("");

    if (process.env.RESEND_API_KEY && process.env.TEAM_DIGEST_EMAIL) {
      await sendEmail({
        to: process.env.TEAM_DIGEST_EMAIL,
        subject: `${fresh.length} new assessment lead${fresh.length > 1 ? "s" : ""} to triage`,
        html,
      });
    }

    await addSeenIds("triaged-assessments", fresh.map((a) => a.id));
    res.status(200).json({ triaged: fresh.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
