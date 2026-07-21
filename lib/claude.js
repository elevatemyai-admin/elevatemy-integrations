// Calls Claude directly via the Messages API. Requires ANTHROPIC_API_KEY
// (from console.anthropic.com — this is a real API key, unrelated to your
// claude.ai login). Uses Sonnet for drafting quality; swap to
// 'claude-haiku-4-5-20251001' if you want something cheaper/faster for
// higher volumes.

async function draftLeadTriage(lead) {
  const prompt = `You're helping a small AI-consulting practice (elevatemy.ai) triage a new AI Readiness Assessment result.

Lead: ${lead.name || "Unknown"}
Company: ${lead.company || "n/a"}
Path: ${lead.path}
Tier: ${lead.tier || "n/a"} (Exploring / Building / Emerging / AI-Ready)
Overall score: ${lead.overallScore ?? "n/a"}%
Category scores: ${JSON.stringify(lead.categories || {})}
Top opportunity flagged by the report: ${lead.topOpportunity || "n/a"}

Write two things, clearly separated with the headers below and nothing else:

## Outreach draft
A short, warm, non-salesy follow-up email (under 120 words) from Tracy, referencing their actual score and top opportunity, ending with an invite to the free 30-minute strategy call.

## Suggested internal task
One sentence: the single most useful next action for the team with this lead (e.g. "Call within 48 hours — high-readiness lead", or "Send DIY resource pack — low urgency").`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("\n");
  return text;
}

module.exports = { draftLeadTriage };
