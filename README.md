# Roof Claim Decoder

**Live:** https://roof-quote-decoder.steve-722.workers.dev

Homeowner uploads their insurance adjuster's estimate → gets a free,
plain-English explanation → becomes a qualified lead for My Family Roofer,
*before* anyone spends sales time on them. Standalone from the MFR Command
Center app — no shared code, database, or infrastructure.

This file reflects what's **actually deployed right now**, not just the
original design. See "Change log" at the bottom for how it got here.

---

## Architecture (why it's free by default)

1. **PDF read in the browser.** `pdf.js` extracts text client-side. The
   original file never leaves the homeowner's device for the normal
   (text-based) path.
2. **Deterministic rules, not AI.** `public/parser.js` finds RCV, ACV,
   depreciation, deductible, net claim, O&P, and common roofing line items by
   label-matching — the same vocabulary Xactimate/Symbility estimates use —
   and sanity-checks the math (RCV − depreciation ≈ ACV, etc). Runs instantly,
   costs $0.
3. **Templated report.** `public/report.js` turns the structured fields into
   plain-English explanations. No generated prose, no hallucination risk.
4. **Low confidence → human, not a dead end.** If we can't find/verify the
   core fields, the homeowner is told a specialist will review it — still a
   qualified lead, just routed differently.
5. **AI is reserved, not default.** Scanned/image PDFs are the only case that
   reaches the server (`/api/fallback-upload` → R2, briefly). No public AI
   trigger is wired up. Treat "Enhanced Review" as a future staff-only
   feature using Workers AI's free tier — not Claude/OpenAI.

## What gets stored, and for how long

- **Text-based PDFs (the normal case):** never touch the server. Nothing to
  clean up.
- **Scanned/unreadable PDFs:** land in R2 under `fallback/`, tagged with an
  `expiresAt` 24 hours out. Three layers delete them:
  1. Staff can call `/api/fallback-delete` immediately after reviewing one.
  2. The Worker's hourly cron (`scheduled()` in `worker/index.js`) deletes
     anything past its `expiresAt`.
  3. An **R2 lifecycle rule** (already set, see below) is the backstop.
- **D1 (`leads` table):** only sales-qualification data — name, contact info,
  address, carrier, claim totals, confidence score. No policy numbers, no
  signatures, no banking details, no full estimate text, ever.

## Lead notifications

Every successful `/api/lead` submission tries to send an email via
[Resend](https://resend.com). This is best-effort — a failed/missing email
config never blocks the lead from being saved to D1.

Controlled by **Cloudflare dashboard variables**, deliberately kept out of
`wrangler.toml` so they survive future deploys without a code change:

| Name | Type | Purpose |
|---|---|---|
| `RESEND_API_KEY` | Secret | Enables sending. Unset = notifications silently skipped. |
| `ADMIN_EMAIL` | Variable | Who receives the notification. **This is the "control" — change it any time in the dashboard, no redeploy.** |
| `NOTIFY_FROM` | Variable (optional) | Custom from-address once a domain is verified in Resend. Defaults to `onboarding@resend.dev`. |

Set these at: **Cloudflare dashboard → Workers & Pages → roof-quote-decoder →
Settings → Variables and Secrets.**

`ADMIN_EMAIL` and `RESEND_API_KEY` aren't set yet — that's the one manual
step left (dashboard-only, see the step-by-step in chat). Until then, leads
still save to D1 normally; the email step just gets silently skipped.

## Live infrastructure

Already created on the connected Cloudflare account — nothing further to
provision:

| Resource | Name | ID |
|---|---|---|
| D1 database | `roof-claim-decoder` | `469869a2-d011-46d3-808e-879bdc0aa038` |
| D1 schema | `leads` table + indexes | applied |
| R2 bucket | `roof-claim-decoder-fallback` | — |
| R2 lifecycle rule | `expire-fallback`, prefix `fallback/`, 1 day | applied |
| Worker | `roof-quote-decoder` | deployed via Cloudflare Workers Builds |

**Deploys are automatic.** This repo is connected to Cloudflare Workers
Builds — every push to `main` triggers `npx wrangler deploy` in Cloudflare's
build environment. No local CLI, no manual `wrangler deploy`, ever.

## Branding

Real My Family Roofer identity — pulled from the actual site and a real
Brian Barnes quote PDF, not a placeholder:
- Logo: `public/assets/logo.png`
- Brand blue: `#0A46BF` · Brand orange (CTA): `#F39C20`
- Trust badges: BBB Torch Award for Ethics, Owens Corning Platinum Preferred
  Contractor, Google 5-star reviews (`public/assets/badge-*.png`)
- "Talk to a specialist" button dials the real business line: `970-501-8125`
- Layout tuned specifically for iPad portrait/landscape and touch targets

## Turning on Turnstile (not yet active)

The worker already verifies a `turnstileToken` field if sent in the
`/api/lead` payload. To activate it:
1. Create a widget at Cloudflare dashboard → Turnstile.
2. Add the Turnstile script tag + widget div to `public/index.html`.
3. In the `leadForm` submit handler, read the widget's token and include it
   as `turnstileToken` in the JSON body sent to `/api/lead`.
4. Add `TURNSTILE_SECRET_KEY` as a dashboard Secret.

Left off on purpose so the core flow could be verified first.

## What's intentionally not built yet

- **Enhanced (AI) review path for scanned PDFs** — `/api/fallback-upload`
  stub exists, but no Workers AI call is wired in. Add as a **staff-only**
  trigger, not public, per the cost-control plan.
- **Rate limiting / abuse controls** beyond file-size and content-type
  checks — add via Cloudflare dashboard rate-limiting rules on `/api/*`, or a
  Durable-Object based limiter for per-IP counts.
- **Turnstile** — see above.
- **Real "from" email domain** — currently sends via Resend's shared test
  sender; verify a domain (e.g. `mail.myfamilyroofer.com`) in Resend and set
  `NOTIFY_FROM` once ready.

## If you ever need to deploy manually (CLI, not required)

```bash
npx wrangler login
npx wrangler deploy
```
Everything else (D1, R2, lifecycle rule) is already provisioned — this would
just push a code change outside of the normal git-push-to-deploy flow.

---

## Change log

1. **Initial build** — deterministic parser, templated report, Worker with
   D1/R2, hourly cleanup cron, placeholder navy/blue branding.
2. **Infrastructure provisioned** on live Cloudflare account: D1 database +
   schema, R2 bucket.
3. **Pushed to GitHub** (`Memphisslim74/roof-quote-decoder`) via a
   short-lived, narrowly-scoped personal access token (repo-only, contents
   read/write), used once and discarded per push.
4. **Connected to Cloudflare Workers Builds** — dashboard-only, Git-based
   auto-deploy. Fixed a Worker-name mismatch (`roof-claim-decoder` vs.
   `roof-quote-decoder`) flagged by the build system.
5. **R2 lifecycle rule** added via dashboard (24h auto-delete backstop for
   scanned-PDF fallback objects).
6. **Rebrand** to the real My Family Roofer identity — real logo, real brand
   colors, trust badges, iPad-tuned responsive layout — replacing the
   original placeholder design.
7. **Lead notification email** added via Resend, controlled by dashboard
   variables (`ADMIN_EMAIL`, `NOTIFY_FROM`, `RESEND_API_KEY`) so the
   recipient can change without a code push.
