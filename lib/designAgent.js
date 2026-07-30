// Template-based "design agent" for Content Studio — generates a branded
// graphic (PNG) for a piece of content, reliably on-brand every time since
// it composites onto a fixed SVG template using your actual confirmed
// brand colors and real logo file, rather than a general-purpose image
// generation model that might drift off-brand.
//
// Pipeline:
//   1. One Claude call produces both a short (6-12 word) punchy headline
//      AND a short stock-photo search query distilled from the post.
//   2. If PEXELS_API_KEY is set, fetch a real photo for that query and use
//      it as the card's background, with a brand-colored gradient scrim
//      over it for text legibility. If the key isn't set, or the photo
//      fetch fails for any reason, falls back cleanly to the plain
//      brand-gradient background (the original design) — a missing photo
//      is never a hard failure.
//   3. Render onto the SVG template and rasterize to PNG with
//      @resvg/resvg-js. NOT a generative image model — this always looks
//      "on-brand" by construction, at the cost of every card sharing the
//      same layout/template rather than true visual variety.
//
// IMPORTANT — this originally used `sharp` for SVG-to-PNG rendering with a
// named system font ("Georgia"), which produced tofu boxes (missing-glyph
// placeholders) in production: Vercel's serverless environment has no
// installed fonts at all, not even generic families like "sans-serif".
// Switched to @resvg/resvg-js specifically because it can load a font file
// directly (fontFiles + loadSystemFonts:false below), guaranteeing text
// renders correctly regardless of what's installed on the server — a real
// bundled font (lib/fonts/RobotoSlab.ttf, Apache-licensed, pulled from
// Google's official font repo) ships with the deployment instead of being
// looked up by name.

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");
const { FP_ICON_BASE64 } = require("./brandAssets");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1080;
const FONT_FAMILY = "Roboto Slab";
const FONT_PATH = path.join(__dirname, "fonts", "RobotoSlab.ttf");

// Same brand-kit-confirmed hex values used in App.jsx's CSS variables —
// duplicated here since this runs server-side with no access to the
// frontend's CSS custom properties.
const COLORS = {
  navy: "#1B3A6B",
  navySoft: "#3D4E8A",
  teal: "#00A99D",
  paleTeal: "#5BC8C0",
  peach: "#E5C9B2",
};

function gradientForType(type) {
  if (type === "linkedin_post") return [COLORS.navy, COLORS.teal];
  if (type === "facebook_post") return [COLORS.navy, COLORS.peach];
  return [COLORS.navy, COLORS.navySoft]; // email
}

// One Claude call producing both the headline and a stock-photo search
// query — combined into a single request rather than two, since both are
// short, cheap generations distilled from the same input.
async function generateHeadlineAndPhotoQuery({ body, type }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const prompt = `You're distilling a ${type === "linkedin_post" ? "LinkedIn" : type === "facebook_post" ? "Facebook" : "marketing email"} post into two things for a branded graphic card:

1. A short, punchy headline (6-12 words) — think "the one line someone would remember," not a summary of everything in the post.
2. A short stock-photo search query (2-4 words) that would find a good, concrete, VISUAL background photo fitting the post's theme — favor tangible scenes (e.g. "office desk paperwork", "accountant working laptop", "small business owner") over abstract concepts a photo search can't actually depict.

THE FULL POST:
${body}

Respond with ONLY a JSON object, no other text, no markdown fences:
{"headline": "...", "photoQuery": "..."}`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 120, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      headline: (parsed.headline || "").replace(/^["']|["']$/g, ""),
      photoQuery: parsed.photoQuery || "",
    };
  } catch (e) {
    // Fallback: if JSON parsing fails for any reason, at least salvage a
    // headline via regex rather than failing the whole card generation —
    // no photo in that case, which is a fine degraded outcome.
    const match = cleaned.match(/"headline"\s*:\s*"([^"]*)"/);
    return { headline: match ? match[1] : cleaned.slice(0, 80), photoQuery: "" };
  }
}

// Fetches a real stock photo from Pexels for the given query, returning
// its raw bytes as base64 — or null if PEXELS_API_KEY isn't set, no
// results are found, or the request fails for any reason. Callers should
// treat null as "fall back to the plain gradient," never as a hard error;
// a missing/failed photo shouldn't block card generation.
async function fetchStockPhotoBase64(query) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey || !query) return null;

  try {
    const searchRes = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
      headers: { Authorization: apiKey },
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const photoUrl = searchData?.photos?.[0]?.src?.large;
    if (!photoUrl) return null;

    const imageRes = await fetch(photoUrl);
    if (!imageRes.ok) return null;
    const arrayBuffer = await imageRes.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  } catch (e) {
    console.warn("[designAgent] stock photo fetch failed (falling back to gradient):", e.message);
    return null;
  }
}

// Rough word-wrap for SVG <text> (which doesn't auto-wrap). Estimates
// character width as a fraction of font size — Roboto Slab Bold runs a
// bit wider than a generic sans, so this errs on the generous side
// (better to wrap one word too early than have text overflow the card).
function wrapText(text, maxWidth, fontSize) {
  const avgCharWidth = fontSize * 0.62;
  const maxChars = Math.floor(maxWidth / avgCharWidth);
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildCardSvg({ headline, type, logoBase64, photoBase64 }) {
  const [colorA, colorB] = gradientForType(type);
  const fontSize = 58;
  const lines = wrapText(headline, CARD_WIDTH - 160, fontSize);
  const lineHeight = fontSize * 1.25;
  const totalTextHeight = lines.length * lineHeight;
  const startY = (CARD_HEIGHT - totalTextHeight) / 2 + fontSize * 0.7;

  const textLines = lines
    .map((line, i) => `<text x="${CARD_WIDTH / 2}" y="${startY + i * lineHeight}" text-anchor="middle" font-family="${FONT_FAMILY}" font-weight="700" font-size="${fontSize}" fill="#ffffff">${escapeXml(line)}</text>`)
    .join("\n");

  // The real 3-bar icon motif, large and faint, as background texture —
  // same idea as the in-app tile watermark, scaled up for a full card.
  const watermark = `
    <g opacity="0.09" transform="translate(${CARD_WIDTH - 340}, ${CARD_HEIGHT - 340})">
      <rect x="60" y="90" width="220" height="42" rx="21" fill="#ffffff" />
      <rect x="60" y="160" width="220" height="42" rx="21" fill="#ffffff" />
      <rect x="60" y="230" width="220" height="42" rx="21" fill="#ffffff" />
    </g>`;

  const logoMark = logoBase64
    ? `<image x="48" y="${CARD_HEIGHT - 96}" width="48" height="48" href="data:image/png;base64,${logoBase64}" />
       <text x="106" y="${CARD_HEIGHT - 64}" font-family="${FONT_FAMILY}" font-weight="700" font-size="22" fill="#ffffff">elevatemy<tspan fill="${colorB === COLORS.teal ? COLORS.paleTeal : "#ffffff"}" font-weight="400">.ai</tspan></text>`
    : "";

  // With a real photo: the photo fills the card, a semi-transparent brand
  // gradient sits over it (scrim) purely for text legibility, at lower
  // opacity than the plain-gradient fallback since it doesn't need to
  // carry the whole background on its own.
  // Without one: same gradient as before, fully opaque, unchanged from
  // the original design.
  const background = photoBase64
    ? `<image x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" href="data:image/jpeg;base64,${photoBase64}" preserveAspectRatio="xMidYMid slice" />
       <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)" opacity="0.72" />`
    : `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)" />`;

  return `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colorA}" />
        <stop offset="100%" stop-color="${colorB}" />
      </linearGradient>
    </defs>
    ${background}
    ${watermark}
    ${textLines}
    ${logoMark}
  </svg>`;
}

// logoBase64: defaults to the real shared icon asset — callers can
// override, but normally shouldn't need to.
async function renderBrandedCard({ body, type, logoBase64 = FP_ICON_BASE64 }) {
  // Fail loudly and clearly if the bundled font file isn't actually present
  // at runtime — resvg-js otherwise seems to fall back silently (producing
  // tofu-box/missing-glyph text) rather than throwing, which made this
  // exact problem hard to diagnose the first time around. A file-not-found
  // here almost always means Vercel's build isn't including lib/fonts/ in
  // this function's deployment bundle — check vercel.json's
  // functions.*.includeFiles config first.
  if (!fs.existsSync(FONT_PATH)) {
    throw new Error(`Font file not found at ${FONT_PATH} — check vercel.json's includeFiles config for this function`);
  }

  const { headline, photoQuery } = await generateHeadlineAndPhotoQuery({ body, type });
  const photoBase64 = await fetchStockPhotoBase64(photoQuery);
  const svg = buildCardSvg({ headline, type, logoBase64, photoBase64 });

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false, // don't even attempt a system font lookup — that's what produced tofu boxes before
      defaultFontFamily: FONT_FAMILY,
    },
  });
  const pngBuffer = resvg.render().asPng();

  return { headline, pngBuffer, usedPhoto: !!photoBase64 };
}

module.exports = { renderBrandedCard, generateHeadlineAndPhotoQuery, buildCardSvg, fetchStockPhotoBase64 };
