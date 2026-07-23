// Drafts marketing content (campaign/nurture emails, and social posts for
// LinkedIn/Facebook) for the elevatemy.ai Marketing Hub. Same trust model as
// lib/claude.js's reply agent: this only ever produces a draft that lands
// in the marketing approval queue — nothing sends or publishes without a
// human clicking Approve first (see api/marketing/approve.js).

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

const PLATFORM_GUIDANCE = {
  email: "Write a real marketing/nurture campaign email — a subject line plus a plain-text body formatted for email. Warm and consultative, never salesy or hypey.",
  linkedin_post: "Write a LinkedIn post for a B2B audience of financial advisors and small/mid-size business owners. Aim for roughly 100-250 words. Open with a strong hook in the first line/sentence — LinkedIn truncates after ~2-3 lines before \"see more\". End with a light, natural call to action. Use 0-3 relevant hashtags at most, never hashtag-stuff.",
  facebook_post: "Write a Facebook post for the same audience and brand voice. Slightly more conversational than LinkedIn, roughly 50-150 words. A relevant emoji or two is fine if it fits the brand voice — don't force it. End with a clear call to action.",
};

function buildPrompt({ type, campaign, brief, templates }) {
  const templateBlock = (templates || []).length
    ? templates.map((t, i) => `--- Example ${i + 1}: "${t.name}" ---\n${t.body}`).join("\n\n")
    : "(No saved brand-voice examples yet — write in a warm, professional, consultative tone fitting a boutique AI-readiness consulting firm serving both general businesses and financial advisory practices.)";

  const campaignBlock = campaign
    ? [
        `Campaign: ${campaign.name || "(unnamed)"}`,
        campaign.goal ? `Goal: ${campaign.goal}` : null,
        campaign.audience ? `Audience: ${campaign.audience}` : null,
        campaign.notes ? `Notes: ${campaign.notes}` : null,
      ].filter(Boolean).join("\n")
    : "(Standalone content — not part of a named campaign.)";

  return `You are drafting marketing content on behalf of Tracy Siri at elevatemy.ai, an AI-readiness consulting firm serving general businesses and financial advisory practices.

CONTENT TYPE: ${type}
${PLATFORM_GUIDANCE[type] || ""}

CAMPAIGN CONTEXT:
${campaignBlock}

BRIEF / TOPIC FOR THIS SPECIFIC PIECE:
${brief || "(No specific brief given — use your judgment based on the campaign context above.)"}

EXAMPLES FOR TONE/VOICE (inspiration only — do not copy verbatim; write something new and specific to this brief):
${templateBlock}

Respond with ONLY a JSON object, no other text, no markdown fences:
${type === "email" ? `{"subject": "...", "body": "..."}` : `{"body": "..."}`}`;
}

async function draftContent({ type, campaign, brief, templates }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  if (!["email", "linkedin_post", "facebook_post"].includes(type)) {
    throw new Error(`Unknown content type: ${type}`);
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: buildPrompt({ type, campaign, brief, templates }) }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Same resilient fallback pattern as lib/claude.js — a slightly
    // imperfect draft reaching the approval queue beats a silent failure.
    const subjectMatch = cleaned.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bodyMatch = cleaned.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!bodyMatch) throw new Error(`Failed to parse content draft (and fallback regex found nothing usable): ${e.message}`);
    const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    parsed = {
      subject: subjectMatch ? unescape(subjectMatch[1]) : "",
      body: unescape(bodyMatch[1]) + (!cleaned.trim().endsWith('"}') ? "\n\n[Draft may have been cut short — please review before approving.]" : ""),
    };
  }

  if (type === "email" && (!parsed.subject || !parsed.body)) throw new Error("Draft response missing subject or body");
  if (type !== "email" && !parsed.body) throw new Error("Draft response missing body");
  return parsed;
}

module.exports = { draftContent };
