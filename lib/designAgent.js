// Template-based "design agent" for Content Studio — generates a branded
// graphic (PNG) for a piece of content, reliably on-brand every time since
// it composites onto a fixed SVG template using your actual confirmed
// brand colors and real logo file, rather than a general-purpose image
// generation model that might drift off-brand.
//
// Two-step pipeline:
//   1. Ask Claude for a short (6-12 word), punchy headline distilled from
//      the post's body — a full post caption is almost always too long to
//      read on a graphic card.
//   2. Render that headline onto a branded SVG (gradient background using
//      the same per-type color logic as the tile covers in App.jsx,
//      real logo watermark, wrapped text), then rasterize to PNG with
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

async function generateHeadline({ body, type }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const prompt = `You're distilling a ${type === "linkedin_post" ? "LinkedIn" : type === "facebook_post" ? "Facebook" : "marketing email"} post down to a short, punchy headline for a branded graphic card — think "the one line someone would remember," not a summary of everything in the post.

THE FULL POST:
${body}

Respond with ONLY the headline text, 6-12 words, no quotation marks, no punctuation at the end, no other text.`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 60, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("").trim();
  return text.replace(/^["']|["']$/g, ""); // strip stray leading/trailing quotes if the model adds them anyway
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

function buildCardSvg({ headline, type, logoBase64 }) {
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

  return `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${colorA}" />
        <stop offset="100%" stop-color="${colorB}" />
      </linearGradient>
    </defs>
    <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#bg)" />
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

  const headline = await generateHeadline({ body, type });
  const svg = buildCardSvg({ headline, type, logoBase64 });

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT_PATH],
      loadSystemFonts: false, // don't even attempt a system font lookup — that's what produced tofu boxes before
      defaultFontFamily: FONT_FAMILY,
    },
  });
  const pngBuffer = resvg.render().asPng();

  return { headline, pngBuffer };
}

module.exports = { renderBrandedCard, generateHeadline, buildCardSvg };
