# CPA demo pitch — outreach plan

The pipeline: 50k CPA list → test campaigns (already built: Zoho + click
tracking) → filter to a confirmed list (people who actually clicked) → each
confirmed prospect gets an email with a short video + a live demo link
personalized with their firm's name.

## How "confirmed" flows through what's already built

1. Test campaigns run in Zoho Campaigns against the 50k list.
2. `fetchZohoCampaignClickers()` (already built) pulls everyone who clicked
   into the CRM's Import tab automatically.
3. You review and decide who's genuinely confirmed (real firm, real intent —
   this filtering step is a human judgment call, not something to automate
   away).
4. In the CRM's Clients view, select the confirmed leads and hit **Send demo
   pitch** (new button — see CRM update). That calls
   `POST /api/leads/send-demo-pitch`, which builds each lead's personalized
   demo link (`{LEDGERLINE_DEMO_BASE_URL}/demo/{Firm+Name}`) and adds them to
   the Zoho "CPA Demo Pitch" list.
5. That list's Autoresponder sends the actual email below.

## Video script (record once, same video for everyone)

**Target length: 60–90 seconds.** The personalization comes from the email
and the demo link, not the video itself — don't try to name-drop the firm
in the video.

---

**[0:00–0:10] Hook**
"Every CPA firm we talk to has the same three problems every tax season:
chasing missing 1099s, re-typing the same intake questions, and losing track
of who's actually ready to file. Here's a tool that fixes all three."

**[0:10–0:30] Show the dashboard**
Screen recording: open the dashboard. "This is Ledgerline. At a glance, you
see every client, sorted by who needs attention — incomplete intake forms
first, then whoever's got the most missing documents. No more digging
through email to figure out who to chase."

**[0:30–0:50] Show the rollover + checklist**
Screen recording: open a client, click Rollover. "One click pulls forward
last year's forms as this year's checklist — so you already know what to
expect from every client before they send anything. Mark things received as
they come in, and you always know exactly who's ready."

**[0:50–1:10] Show campaigns**
Screen recording: campaigns list. "And when you need to chase a specific
group — say, everyone who hasn't finished their intake form — build one
message, target the rule, and it queues up automatically."

**[1:10–1:20] Close**
"This is a live preview, set up with your firm's name on it — click through
it yourself using the link below, and if it's useful, let's talk about
setting it up for real."

---

## Outreach email (paste into the "CPA Demo Pitch" Autoresponder)

**Subject suggestion:** A CRM built for [Company Name] — take a look

Hi [First Name],

We put together a quick preview of what a tax-season CRM would look like for
[Company Name] specifically.

[Watch the 90-second walkthrough → VIDEO_LINK]

It's a real, working tool — not a mockup. Client dashboard sorted by who
needs the most attention, one-click rollover of last year's forms into this
year's checklist, and reminder campaigns you can send to exactly the clients
who need them.

[See it live, set up for [Company Name] → DEMO_LINK]

It's a shared preview environment, so feel free to click around — just
can't save changes there. If it looks like something worth having for real,
reply here or grab 30 minutes on our calendar and we'll talk about getting
it built for your actual client list.

— The elevatemy.ai Team
hello@elevatemy.ai

---

## Notes on scale

- **Video:** one generic recording, hosted anywhere (YouTube unlisted, Loom,
  Wistia) — `VIDEO_LINK` above is a single static URL for everyone, not
  personalized. True per-lead personalized video (name spoken in the video
  itself) is a separate, much heavier lift — tools like HeyGen or Synthesia
  can do it, but that's a real added cost/complexity and isn't built here.
  Worth revisiting once you see response rates from the static-video version.
- **Demo link:** personalized per lead via the firm name in the URL — no
  per-lead deployment, no per-lead database. One running Ledgerline
  instance, read-only for anyone arriving via a `/demo/*` link.
- **Volume:** Zoho Campaigns' own sending limits and reputation/deliverability
  practices apply here same as any bulk send — don't blast all 50k through
  this personalized track at once; it's meant for the filtered, confirmed
  subset only.
