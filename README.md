# Roof Claim Decoder

Standalone from the MFR Command Center app. Homeowner uploads their insurance
adjuster's estimate → gets a free, plain-English explanation → becomes a
qualified lead for My Family Roofer, *before* anyone spends sales time on them.

## Architecture (why it's free by default)

1. **PDF read in the browser.** `pdf.js` extracts text client-side. The
   original file never leaves the homeowner's device for the normal (text-based)
   path.
2. **Deterministic rules, not AI.** `public/parser.js` finds RCV, ACV,
   depreciation, deductible, net claim, O&P, and common roofing line items by
   label-matching — the same vocabulary Xactimate/Symbility estimates use —
   and sanity-checks the math (RCV − depreciation ≈ ACV, etc). Runs instantly,
   costs $0.
3. **Templated report.** `public/report.js` turns the structured fields into
   plain-English explanations. No generated prose, no hallucination risk.
4. **Low confidence → human, not a dead end.** If we can't find/verify the
   core fields, the homeowner is told a specialist will review it — that's
   still a qualified lead, just routed differently.
5. **AI is reserved, not default.** Scanned/image PDFs are the only case that
   reaches the server (`/api/fallback-upload` → R2, briefly). There's no public
   AI trigger wired up yet — treat "Enhanced Review" as a staff-only feature to
   add later using Workers AI's free tier, not Claude/OpenAI.

## What gets stored, and for how long

- **Text-based PDFs (the normal case):** never touch the server. Nothing to
  clean up.
- **Scanned/unreadable PDFs:** land in R2 under `fallback/`, tagged with an
  `expiresAt` 24 hours out. Three layers delete them:
  1. Staff can call `/api/fallback-delete` immediately after reviewing one.
  2. The Worker's hourly cron (`scheduled()` in `worker/index.js`) deletes
     anything past its `expiresAt`.
  3. An R2 lifecycle rule (set up below) is the backstop in case 1 and 2 both
     fail.
- **D1 (`leads` table):** only sales-qualification data — name, contact info,
  address, carrier, claim totals, confidence score. No policy numbers, no
  signatures, no banking details, no full estimate text, ever.

## Deploy

Requires a Cloudflare account and `wrangler` (`npm install -g wrangler`, or
`npx wrangler`).

```bash
# 1. Log in
npx wrangler login

# 2. Create the D1 database, then paste the returned database_id into
#    wrangler.toml
npx wrangler d1 create roof-claim-decoder
npx wrangler d1 execute roof-claim-decoder --file=./worker/schema.sql --remote

# 3. Create the R2 bucket
npx wrangler r2 bucket create roof-claim-decoder-fallback

# 4. Set the 24h lifecycle rule as the backstop deletion layer
npx wrangler r2 bucket lifecycle add roof-claim-decoder-fallback \
  --id expire-fallback --expire-days 1 --prefix fallback/

# 5. (Optional, recommended before going live) Add Cloudflare Turnstile:
#    - create a widget at https://dash.cloudflare.com/?to=/:account/turnstile
#    - put the site key in wrangler.toml under [vars] TURNSTILE_SITE_KEY
#    - add the secret:
npx wrangler secret put TURNSTILE_SECRET_KEY

# 6. Set a staff key used to authorize manual fallback deletion
npx wrangler secret put STAFF_KEY

# 7. Deploy
npx wrangler deploy
```

## Turning on Turnstile in the UI

The worker already verifies a `turnstileToken` field if you send one in the
`/api/lead` payload. To activate it in the browser:
1. Add the Turnstile script tag and a widget div to `public/index.html`.
2. In the `leadForm` submit handler in `index.html`, read the widget's token
   and include it as `turnstileToken` in the JSON body sent to `/api/lead`.

Left out of this first pass on purpose so you can verify the core flow works
before adding the extra moving part.

## Branding

Colors and "My Family Roofer" / "MFR" mark were pulled from your existing
Command Center app (`--navy:#0D1B3E`, `--blue:#2563EB`) so this feels like the
same company, without sharing any code, database, or infrastructure with it.

## What's intentionally not built yet

- Enhanced (AI) review path for scanned PDFs — stub exists
  (`/api/fallback-upload`), but no Workers AI call is wired in. Add it as a
  **staff-only** trigger, not public, per the cost-control plan.
- Rate limiting / abuse controls beyond file-size and content-type checks —
  add Cloudflare's built-in rate limiting rules on `/api/*` from the dashboard,
  or a Durable-Object based limiter if you need per-IP counts.
- "Specialist" CTA currently just opens the phone dialer — wire it to
  whatever routes leads into the MFR pipeline today (a webhook into your
  existing D1/Supabase, a CRM API call, etc).
