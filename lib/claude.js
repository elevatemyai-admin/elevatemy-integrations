// Drafts a suggested reply to an incoming client email, using Claude.
// Templates are inspiration, not fill-in-the-blank forms — the model is
// asked to write something genuinely fitted to this specific client and
// their specific email, in the voice/spirit of the templates rather than
// mechanically substituting merge fields.
//
// Drafts are NEVER sent automatically — this only produces a suggestion
// that lands in the CRM's pending-approval queue (see api/gmail/approve.js
// and the "Pending Email Approvals" dashboard section).

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// Env-overridable so these can be updated without a code change later —
// falls back to the current live links if not set.
const SCHEDULING_LINK = process.env.EAI_SCHEDULING_LINK || "https://meetings.hubspot.com/matt-barnhart/eai-meeting?uuid=072dd418-e1a3-4571-b424-2951706488d7";
const NEWSLETTER_LINK = process.env.EAI_NEWSLETTER_LINK || "https://elevatemyai.beehiiv.com/";
const PRICING_LINK = process.env.EAI_PRICING_LINK || "https://elevatemy-web.vercel.app/general/pricing.html";

function buildPrompt({ client, incomingEmail, templates }) {
  const a = client.assessment || {};
  const clientContext = [
    `Name: ${client.name || "(unknown)"}`,
    `Company: ${client.company || "(unknown)"}`,
    `Status: ${client.status || "(unknown)"}`,
    a.completed ? `Assessment: ${a.path === "financial" ? "Financial Services" : "General Business"} track, tier "${a.tier}", score ${a.overallScore}/84, biggest opportunity: ${a.topOpportunity}` : "Assessment: not completed",
  ].join("\n");

  const templateBlock = (templates || []).length
    ? templates.map((t, i) => `--- Template ${i + 1}: "${t.name}" ---\n${t.body}`).join("\n\n")
    : "(No templates saved yet — write from scratch in a warm, professional, consultative tone.)";

  const linksBlock = [
    `- Scheduling a call (this books a meeting with BOTH Tracy and Matt — phrase it as "time to connect with us" or similar, not "time with me"): ${SCHEDULING_LINK}`,
    `- Newsletter signup: ${NEWSLETTER_LINK}`,
    `- Pricing page: ${PRICING_LINK}`,
  ].join("\n");

  const linkRules = `LINK RULES (these are not optional suggestions — follow them exactly):
1. If the email you're replying to proposes, asks for, or agrees to a call/meeting/time to connect in ANY way (e.g. "do you have 20-30 minutes", "can we hop on a call", "let's schedule something") — you MUST include the scheduling link in your reply. Do not just say "let me know what time works" without the link.
2. If the email asks about cost, pricing, rates, or "how much" in ANY way — you MUST include the pricing link in your reply, even if you also explain ranges in your own words. Do not describe pricing without also linking to the pricing page.
3. The newsletter link is genuinely optional — include it only if it naturally fits (e.g. they're not ready to buy yet, or ask about resources/content).
4. CRITICAL: when you include a link, write out the FULL LITERAL URL (e.g. "https://meetings.hubspot.com/...") directly in the body text. NEVER write a placeholder like "[scheduling link]", "[link]", "[insert URL]", or similar bracketed text — this draft gets sent to the client exactly as written, with no further editing pass, so a placeholder would be visible to them verbatim. Copy the actual URL string from the list above character-for-character.
Failing to include the scheduling or pricing link when rules 1 or 2 apply, or writing a placeholder instead of the real URL, is a mistake — check your draft against all four rules before finalizing it.`;

  const gameplanBlock = a.completed
    ? `This client HAS completed their assessment (${a.path === "financial" ? "Financial Services" : "General Business"} track, tier "${a.tier}", score ${a.overallScore}/84, biggest opportunity: "${a.topOpportunity}"). If it fits naturally with what they emailed about, include a brief (2-3 sentence) "gameplan" — one or two concrete next steps tied specifically to their tier and biggest opportunity area. Keep it short and actionable, not a full strategy writeup.`
    : `This client has NOT completed their assessment yet. Do not invent gameplan details they haven't earned from real results — if relevant, you can mention the assessment as a next step instead.`;

  return `You are drafting a reply on behalf of Tracy Siri at elevatemy.ai, an AI-readiness consulting firm. A client just emailed in. Draft a genuine, specific reply — not a generic template fill-in.

CLIENT CONTEXT:
${clientContext}

THE EMAIL THEY JUST SENT:
Subject: ${incomingEmail.subject}
${incomingEmail.snippet ? `Preview: ${incomingEmail.snippet}` : "(no preview text available)"}

EXISTING TEMPLATES (use these for tone/voice/structure inspiration only — do not just insert their text verbatim; write something that actually responds to what this specific person said):
${templateBlock}

AVAILABLE LINKS:
${linksBlock}

${linkRules}

GAMEPLAN GUIDANCE:
${gameplanBlock}

Respond with ONLY a JSON object, no other text, no markdown fences:
{"subject": "...", "body": "..."}

The subject should be a natural reply subject (e.g. "Re: their subject" or a clearer one if warranted). The body should be plain text, ready to send, signed off as Tracy.`;
}

async function draftReply({ client, incomingEmail, templates }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      // Was 1000 — too tight. The prompt asks for a full drafted email body
      // plus JSON-wrapper overhead, and 1000 was getting hit mid-sentence,
      // leaving an unterminated JSON string (seen in production as
      // "Unterminated string in JSON at position ..." parse failures).
      max_tokens: 2000,
      messages: [{ role: "user", content: buildPrompt({ client, incomingEmail, templates }) }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("").trim();

  // Strip stray markdown fences in case the model wraps the JSON anyway.
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Fallback: pull subject/body out with regex even if the JSON itself
    // is malformed or was cut short (e.g. hit max_tokens, or the model
    // included an unescaped raw newline inside the body string). This is
    // deliberately permissive — a slightly-imperfect draft that still
    // reaches the human approval queue is far better than a silent
    // failure that leaves the client's email completely unanswered.
    const subjectMatch = cleaned.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const bodyMatch = cleaned.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)/); // no trailing quote required — may be truncated
    if (!subjectMatch || !bodyMatch) {
      throw new Error(`Failed to parse draft response (and fallback regex found nothing usable): ${e.message}`);
    }
    const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    parsed = {
      subject: unescape(subjectMatch[1]),
      body: unescape(bodyMatch[1]) + (bodyMatch[1].length && !cleaned.trim().endsWith('"}') ? "\n\n[Draft may have been cut short — please review before sending.]" : ""),
    };
  }
  if (!parsed.subject || !parsed.body) throw new Error("Draft response missing subject or body");
  return parsed;
}

module.exports = { draftReply };
