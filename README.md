# Elevatemy.ai CRM — full app (frontend + backend)

**Update:** this project now includes the CRM itself (`src/App.jsx`), not just
the backend. It turns out Claude artifacts can't make direct calls to
external APIs — a platform restriction, not a bug in anything built here —
so the CRM has been converted into a real deployed web app that lives
alongside its own backend in this same project. Same-origin calls, no CORS
needed, no "API base URL" to configure — it just works once deployed.

**What changed:**
- `src/App.jsx` — the CRM, adapted to call `/api/...` routes directly (relative paths) instead of `window.storage`
- `index.html`, `src/main.jsx`, `vite.config.js` — standard Vite scaffold
- `api/crm/data.js` — new route that replaces `window.storage`; GET loads the whole CRM dataset, POST saves it, both backed by the same Vercel KVtest
- `package.json` — now includes `react`, `react-dom`, `lucide-react`, and `vite` alongside the existing backend dependency

**Deploy is the same as before** — `npm install`, then `npx vercel --prod` in
this folder. Vercel auto-detects Vite and builds/serves the frontend
automatically alongside the existing `/api` functions. Once deployed, open
the printed URL directly in a browser — that's the real, permanent home for
the CRM now, not something you reopen from inside a Claude conversation.



This is the backend the CRM's Import tab and Marketing tab are already wired to
call. Drop this into (or alongside) Tracy's existing Vercel + GitHub client
dashboard project — it doesn't need its own separate project, just its own
`/api` folder and environment variables.

## What's automated right now

**Sync job** (`/api/cron/sync`) — runs every 2 hours (edit `vercel.json` to
change that). Pulls fresh data from Zoho Campaigns, Zoho CRM (CPA + social
leads), HubSpot (assessment completions), and Beehiiv (subscribers), and
caches it in Vercel KV. The five public routes the CRM calls
(`/api/zoho/campaigns`, `/api/zoho/leads/cpa`, `/api/zoho/leads/social`,
`/api/hubspot/assessments`, `/api/beehiiv/subscribers`) read from that cache
first, so the CRM stays fast and never waits on a live API call. If the cache
is empty (first run, before cron has fired), each route falls back to a live
fetch automatically.

**Triage agent** (`/api/cron/triage`) — runs daily at 1pm UTC. Finds
assessment completions nobody's triaged yet, has Claude draft a short
outreach email and a one-line "next best action" for each, and emails the
whole batch to `TEAM_DIGEST_EMAIL` as one digest. Nothing is ever sent to a
lead automatically — a human reviews and sends. This is the one genuinely
"agentic" piece: an LLM making a judgment call per lead, not just moving data.

## What's confirmed vs. still a guess (updated from the Alpine Acres build docs)

- **Confirmed:** the HubSpot property for the top opportunity is really
  `ai_assessment__biggest_opportunity_area` — `lib/hubspot.js` uses this
  directly now.
- **Confirmed:** the real tier vocabulary is **Exploring → Building →
  Emerging → AI-Ready** (from the live nurture email templates), not the
  "Advanced/Intermediate/Developing/Early Stage" labels from an older
  internal script. The CRM and this fetcher both use the real names now.
- **Still a guess:** the other `ai_assessment__*` property names in
  `PROPERTY_MAP` follow the same naming convention as the confirmed one, but
  aren't verified — check a completed contact in HubSpot and correct any
  that don't match.

## Reuse your existing infrastructure — don't set up new accounts

The Alpine Acres build already created everything this needs:

- GitHub: `elevatemyai-admin` account — put this repo there as its own repo
  (e.g. `elevatemy-crm-api`), separate from individual client dashboard repos
  like Alpine's, since this one serves the whole business, not one client.
- Vercel: same account, "Continue with GitHub" import, same as every other
  project in that setup.
- Anthropic: the Console account under `admin@elevatemy.ai` already has a
  live `ANTHROPIC_API_KEY` powering Alpine's chat widget — reuse that same
  key here rather than creating a second Anthropic account. Just be mindful
  it's a small prepaid-credit account with auto-reload off; keep an eye on
  usage once both the chat widget and this triage agent are drawing on it.

## Moving off HubSpot for Elevate clients (CWM/Whiz stays on HubSpot)

Per your call: CWM/The Whiz keeps its hard HubSpot requirement, untouched.
Everything Elevate-side moves off. Here's the plan and what's built so far:

**1. Nurture emails now go through Zoho, not HubSpot.** `lib/zoho.js` has
`addContactToNurtureList()` — set up 4 lists in Zoho Campaigns (Exploring /
Building / Emerging / AI-Ready), each with an **Autoresponder** configured to
send 2-3 days after a contact is added to that list. That autoresponder is
what actually sends the email — our code's only job is dropping the right
contact into the right list with the right merge fields. This means Zoho
handles the timing/sending exactly like HubSpot's workflow did, just on a
different platform.

You'll need to recreate the 4 email templates inside Zoho Campaigns using
your real copy (unchanged) — see `nurture-emails-for-zoho.md` in this folder,
which has all 4 templates with the HubSpot `{{contact.x}}` merge tags
replaced by bracketed placeholders `[First Name]`, `[Biggest Opportunity
Area]` for you to swap using Zoho's own "Personalize" insert in its editor
(Zoho's exact merge-tag syntax depends on your account's field setup, so I
didn't guess at it).

You'll also need 3 custom fields on the Zoho Campaigns list: Biggest
Opportunity Area, AI Readiness Tier, Overall Score — under each list's
Settings → Manage Fields — matching the names used in
`addContactToNurtureList()`.

**2. New endpoint: `POST /api/assessments/submit`.** This is what the
*rebuilt* assessment tool should call the instant someone finishes — it
caches the result for the CRM immediately and pushes the contact into the
right Zoho nurture list in the same request. No polling, no HubSpot
property-name guessing, because the data never touches HubSpot at all going
forward.

**3. The assessment tool itself still needs to be rebuilt off HubSpot.**
This is the one piece I couldn't safely reconstruct — the actual 20/22
real questions and their answer options live only in a file
(`assessment_original.html`) that was uploaded in a past session and isn't
retrievable now. Re-upload that file and I'll rebuild it as a standalone
Vercel-hosted page that posts to `/api/assessments/submit` instead of
HubSpot, keeping every real question, option, and scoring rule intact.

**4. `/api/hubspot/assessments` (GET, polling) becomes migration-only.**
Keep it around just long enough to pull in everyone who completed the
assessment *while it still lived on HubSpot*, via the CRM's Import tab, then
it can be retired once that historical batch is in.

## Deploy steps





1. Copy this whole folder into Tracy's Vercel project repo (or a new repo —
   either works, since the CRM just needs a base URL).
2. `npm install` to pull in `@vercel/kv`.
3. In the Vercel dashboard: **Storage → Create Database → KV**, attach it to
   the project. This sets `KV_REST_API_URL` / `KV_REST_API_TOKEN` for you.
4. Copy `.env.example` to `.env.local` for local testing, and add the real
   values as Environment Variables in the Vercel project settings for
   production. See the comments in `.env.example` for where each credential
   comes from.
5. Deploy (`git push` or `vercel deploy`).
6. In the elevatemy CRM, go to **Settings** and set the API base URL to your
   deployed domain + `/api`, e.g. `https://your-project.vercel.app/api`. Click
   **Test connection** — the Marketing and Import tabs should light up.
7. Optional but recommended: hit `/api/cron/sync` once manually (with the
   `Authorization: Bearer {CRON_SECRET}` header) right after deploying, so the
   cache isn't empty while waiting for the first scheduled run.

## Two things to confirm before this is fully live

- **HubSpot property names** (`lib/hubspot.js`) — I don't know your actual
  custom property internal names for assessment results. Open a contact
  record in HubSpot who completed the assessment, find the real property
  names in the sidebar, and update `PROPERTY_MAP` at the top of that file.
- **Zoho Lead Source values** (`ZOHO_CPA_LEAD_SOURCE` / `ZOHO_SOCIAL_LEAD_SOURCE`
  in `.env`) — set these to whatever string actually appears in the Lead
  Source field for CPA vs. social leads in your Zoho CRM.

## Vercel Cron plan limits

Vercel's free (Hobby) tier historically limits cron jobs to once/day and only
2 jobs total — check your current plan. If you're on Hobby, either upgrade to
Pro or just call `/api/cron/sync` from a free external scheduler (e.g.
cron-job.org hitting the URL with the Authorization header) at whatever
frequency you want.

## Phase 2 (not built yet): closing the loop on tasks

Right now, client records, tasks, and billing live in the CRM's own
per-artifact storage, which only the browser-side CRM can read — a backend
cron job has no way to see "what tasks are overdue" or "who just paid."
That's why the triage agent above only works with the *incoming lead* data
(which does live in a real, backend-reachable cache), not with tasks or
revenue.

To fully automate task nudges, overdue reminders, and a revenue digest, the
CRM's data would need to move from artifact storage into a real shared
database (e.g. the same Vercel KV, or Postgres if you want proper querying)
that both the browser CRM and these serverless functions read from. That's a
bigger, well-scoped follow-up project — happy to build it if you want to go
there next. Once it exists, natural next agents to add:

- **Task nudge agent** — daily digest of overdue/upcoming tasks, split by
  "client owes us" vs. "we owe client," emailed to the team and optionally
  to the client for their own items.
- **Revenue digest agent** — weekly rollup of paid/pending revenue and
  campaign spend-per-lead, so nobody has to open the dashboard to know how
  the month is going.
- **Dashboard refresh agent** — since Tracy's client dashboards are already a
  Vercel + GitHub project, a scheduled **Claude Code** run could pull updated
  CRM data and regenerate each client's dashboard automatically after an
  interview or assessment update, instead of that being a manual rebuild
  each time.

## On "agents to run everything"

Two different things are worth keeping separate:

1. **Scheduled automation** (what's built here) — cron jobs on a timer,
   deterministic code, no judgment calls except the one Claude call in
   triage. This is the reliable, cheap way to keep data flowing.
2. **An actual coding agent** (Claude Code) — worth using not to *run* the
   CRM day-to-day, but to *build and maintain* this integration layer over
   time: adding new sources, fixing a broken Zoho field mapping, or building
   Phase 2's database migration. Point Claude Code at this repo and it can
   iterate on it directly, including deploying and checking logs.

I'd avoid one thing: don't wire an agent to *autonomously message clients* or
*charge cards* without a human in the loop. The triage agent here stops at
"draft + digest" on purpose.
