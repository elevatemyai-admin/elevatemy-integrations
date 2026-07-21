# Connecting Zoho — step by step

This is the one-time setup to get real credentials. Takes about 15 minutes.
You'll end up with 4 values to paste into Vercel's Environment Variables.

## Step 1 — Register a Self Client

1. Go to https://api-console.zoho.com and sign in with the account that owns
   your Zoho Campaigns/CRM data (likely `admin@elevatemy.ai`, per the Alpine
   Acres setup).
2. Click **Add Client** → **Self Client**. This client type is specifically
   for backend/server jobs like this one — no redirect URI, no login screen
   for anyone else, exactly what a CRM sync needs.
3. Click **Create**. You'll immediately see a **Client ID** and **Client
   Secret** under the Client Secret tab — copy both now.

## Step 2 — Generate an authorization code with the right scopes

Still in the Self Client screen, go to the **Generate Code** tab. If your org
only has Zoho Campaigns (not Zoho CRM), use this scope — confirmed working:

```
ZohoCampaigns.campaign.READ,ZohoCampaigns.contact.ALL
```

If your org *also* has Zoho CRM and you want the CPA/social lead-pull
features working too, add the CRM scope:

```
ZohoCampaigns.campaign.READ,ZohoCampaigns.contact.ALL,ZohoCRM.modules.leads.READ
```

(Trying to include the CRM scope without actually having Zoho CRM will fail
with "You are not part of any CRM service orgs" — just drop it if that
happens.)

- Set the authorization code expiry to whatever's most convenient (3–10
  minutes — you'll use it right away in Step 3).
- Add any description, click **CREATE**.
- Copy the authorization code shown — it's single-use and expires fast.

## Step 3 — Exchange the code for a refresh token

Run this once (swap in your real values), from a terminal or Postman:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "code=YOUR_AUTHORIZATION_CODE"
```

Use `accounts.zoho.eu`, `.in`, or `.com.au` instead of `.com` if your Zoho
account is on a different data center — check which one by looking at the
domain in your browser when you're logged into Zoho.

The response includes an `access_token` (expires in an hour, ignore it — our
code refreshes its own) and a `refresh_token` (**this one doesn't expire**,
this is the one you need). Copy the refresh token.

## Step 4 — Set the environment variables

In Vercel (Project → Settings → Environment Variables), add:

```
ZOHO_CLIENT_ID=<from step 1>
ZOHO_CLIENT_SECRET=<from step 1>
ZOHO_REFRESH_TOKEN=<from step 3>
ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.com   (adjust for your data center)
```

## Step 5 — Set up the 4 nurture lists in Zoho Campaigns

1. Zoho Campaigns → Contacts → Manage Lists → **Create List** — make 4:
   `Nurture - Exploring`, `Nurture - Building`, `Nurture - Emerging`,
   `Nurture - AI-Ready`.
2. **Don't attach a signup form to any of them** — that's what keeps adds
   silent/immediate instead of triggering a confirmation email.
3. Each list needs 3 custom fields (Settings → Manage Fields, or List →
   Field Settings): **Biggest Opportunity Area**, **AI Readiness Tier**,
   **Overall Score** — these are what the code merges into the emails.
4. Open each list and grab its **list key** (List page → the key shown when
   you view/export the list — Zoho's UI calls this out directly on the list
   details page).
5. Set those 4 keys as env vars:

```
ZOHO_LIST_KEY_EXPLORING=<list key>
ZOHO_LIST_KEY_BUILDING=<list key>
ZOHO_LIST_KEY_EMERGING=<list key>
ZOHO_LIST_KEY_AI_READY=<list key>
```

6. Paste the 4 templates from `nurture-emails-for-zoho.md` into each list's
   **Autoresponder** (Campaigns → Autoresponders → New, tied to that list),
   set the delay to 2-3 days, and use Zoho's **Personalize** button in the
   editor to swap the bracketed placeholders for real merge tags.

## Step 6 — Test it

Once deployed, hit `/api/cron/sync` manually with the `Authorization: Bearer
{CRON_SECRET}` header — check the response for `cache:campaigns` and
`cache:cpaLeads` counts to confirm the Zoho connection itself works before
worrying about the nurture-list piece.

Then test the nurture path directly: `POST /api/assessments/submit` with a
test payload (fake email, a real tier value) and check that contact shows up
in the matching Zoho Campaigns list within a minute or two.

## What I can't do from here

I can't click through Zoho's console for you — Steps 1-3 need your login.
Once you have the 4 values from Step 4 (and later the 4 list keys from Step
5), paste them into Vercel's environment variables directly rather than into
this chat — that's the one place they should live.
