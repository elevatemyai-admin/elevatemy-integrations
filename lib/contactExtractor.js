// Extracts structured contact info from a screenshot (LinkedIn "Contact
// info" popup, a business card photo, an email signature, etc.) using
// Claude's vision input. This ONLY ever produces a suggestion — the
// frontend always shows the extracted fields in an editable form for a
// human to review/correct before anything gets saved as a real client
// record, same trust model as everything else AI-drafted in this CRM.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

const EXTRACT_PROMPT = `Extract contact information from this screenshot — it's likely a LinkedIn "Contact info" popup, a business card, an email signature, or something similar.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"firstName": "", "lastName": "", "company": "", "title": "", "email": "", "phone": "", "linkedInUrl": "", "address": ""}

Rules:
- Leave any field as an empty string if it isn't actually visible in the image — never invent or guess information that isn't shown.
- If a name is shown as "First Last", split it into firstName/lastName correctly.
- For phone, include the full number as shown (extension included if present), but drop labels like "(Work)".
- For linkedInUrl, use the full profile URL if visible (e.g. "linkedin.com/in/username").`;

async function extractContactFromImage({ imageBase64, mediaType }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  if (!imageBase64) throw new Error("imageBase64 is required");

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: imageBase64 } },
            { type: "text", text: EXTRACT_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      firstName: parsed.firstName || "",
      lastName: parsed.lastName || "",
      company: parsed.company || "",
      title: parsed.title || "",
      email: parsed.email || "",
      phone: parsed.phone || "",
      linkedInUrl: parsed.linkedInUrl || "",
      address: parsed.address || "",
    };
  } catch (e) {
    throw new Error("Couldn't parse contact info from the screenshot — try a clearer image, or enter the details manually");
  }
}

module.exports = { extractContactFromImage };
