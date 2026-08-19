/**
 * Roof Claim Decoder — Worker
 *
 * Routes:
 *   POST /api/lead              -> store qualified lead in D1 (no documents involved)
 *   POST /api/fallback-upload   -> temporary R2 storage for scanned/unreadable PDFs only
 *   ANY  /*                     -> falls through to static assets (env.ASSETS)
 *
 * Scheduled:
 *   Hourly cron deletes any R2 object whose expires_at has passed.
 *   (An R2 lifecycle rule set to 1 day is the backstop — see README.)
 *
 * Design intent: this app is a document PROCESSOR, not a document REPOSITORY.
 * Text-based PDFs never touch this worker or R2 at all — they're parsed
 * entirely in the browser. Only scanned/unreadable PDFs reach fallback-upload,
 * and those are deleted within 24 hours (usually much sooner).
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const FALLBACK_RETENTION_SECONDS = 24 * 60 * 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function badRequest(msg) {
  return json({ error: msg }, 400);
}

async function verifyTurnstile(token, secret, ip) {
  if (!secret) return true; // Turnstile not configured yet — allow through in dev.
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  const outcome = await res.json();
  return !!outcome.success;
}

// Sends a new-lead notification email via Resend (https://resend.com).
// Controlled entirely by dashboard config, not code:
//   - env.ADMIN_EMAIL      -> who receives the notification (swap anytime, no redeploy needed if set as a var)
//   - env.NOTIFY_FROM      -> the "from" address (defaults to Resend's shared test sender)
//   - env.RESEND_API_KEY   -> secret; if unset, notifications are silently skipped (lead is still saved)
// A failure here NEVER blocks lead capture — it's best-effort on top of the D1 write.
async function sendLeadNotification(env, { lead, fields, confidence, needsReview, scanned, leadId }) {
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return { skipped: true };

  const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  const statusLine = scanned
    ? 'Scanned PDF — needs manual review'
    : needsReview
      ? `Needs review (confidence ${Math.round((confidence ?? 0) * 100)}%)`
      : `Auto-read OK (confidence ${Math.round((confidence ?? 0) * 100)}%)`;

  const html = `
    <h2 style="margin:0 0 12px">New Claim Decoder lead</h2>
    <p style="margin:0 0 16px;color:#444">${statusLine}</p>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td><strong>Name</strong></td><td>${lead.firstName} ${lead.lastName}</td></tr>
      <tr><td><strong>Phone</strong></td><td>${lead.phone}</td></tr>
      <tr><td><strong>Email</strong></td><td>${lead.email}</td></tr>
      <tr><td><strong>Address</strong></td><td>${lead.address}</td></tr>
      <tr><td><strong>Carrier</strong></td><td>${fields?.carrier ?? '—'}</td></tr>
      <tr><td><strong>Claim #</strong></td><td>${fields?.claimNumber ?? '—'}</td></tr>
      <tr><td><strong>RCV</strong></td><td>${money(fields?.rcv)}</td></tr>
      <tr><td><strong>ACV</strong></td><td>${money(fields?.acv)}</td></tr>
      <tr><td><strong>Deductible</strong></td><td>${money(fields?.deductible)}</td></tr>
      <tr><td><strong>Net claim</strong></td><td>${money(fields?.netClaim)}</td></tr>
    </table>
    <p style="margin-top:16px;color:#888;font-size:12px">Lead ID: ${leadId}</p>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM || 'Roof Claim Decoder <onboarding@resend.dev>',
        to: [env.ADMIN_EMAIL],
        subject: `New claim lead: ${lead.firstName} ${lead.lastName}`,
        html,
      }),
    });
    if (!res.ok) {
      console.error('Resend notification failed:', res.status, await res.text());
      return { skipped: false, ok: false };
    }
    return { skipped: false, ok: true };
  } catch (err) {
    console.error('Resend notification error:', err);
    return { skipped: false, ok: false };
  }
}

async function handleLead(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return badRequest('Invalid JSON body.');
  }

  const { lead, fields, confidence, needsReview, scanned, turnstileToken } = payload;
  if (!lead || !lead.firstName || !lead.lastName || !lead.phone || !lead.email || !lead.address) {
    return badRequest('Missing required contact fields.');
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ok = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, ip);
  if (!ok) return json({ error: 'Verification failed. Please try again.' }, 403);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Deliberately narrow: we keep only what's useful for a sales/qualification
  // follow-up. We never store policy numbers, signatures, banking info, or
  // the full estimate text.
  await env.DB.prepare(
    `INSERT INTO leads (
       id, created_at, first_name, last_name, phone, email, address,
       carrier, claim_number, date_of_loss,
       rcv, acv, deductible, net_claim, depreciation,
       confidence, needs_review, scanned_fallback, source_ip
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, now,
    lead.firstName, lead.lastName, lead.phone, lead.email, lead.address,
    fields?.carrier ?? null, fields?.claimNumber ?? null, fields?.dateOfLoss ?? null,
    fields?.rcv ?? null, fields?.acv ?? null, fields?.deductible ?? null,
    fields?.netClaim ?? null,
    (fields?.recoverableDepreciation ?? 0) + (fields?.nonRecoverableDepreciation ?? 0) + (fields?.depreciation ?? 0),
    confidence ?? null, needsReview ? 1 : 0, scanned ? 1 : 0, ip
  ).run();

  // Best-effort — never lets an email hiccup fail the lead capture itself.
  const notify = await sendLeadNotification(env, { lead, fields, confidence, needsReview, scanned, leadId: id });

  return json({ ok: true, leadId: id, notified: notify.ok ?? false });
}

// Only reached for scanned/unreadable PDFs the browser couldn't parse.
// Stored in R2 with a short-lived expiry; deleted immediately after any
// staff-triggered enhanced review, or by the hourly cleanup, or by the
// R2 lifecycle rule — whichever comes first.
async function handleFallbackUpload(request, env) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/pdf')) {
    return badRequest('Only PDF uploads are accepted.');
  }
  const contentLength = Number(request.headers.get('Content-Length') || '0');
  if (contentLength > MAX_UPLOAD_BYTES) {
    return badRequest('File too large.');
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `fallback/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.pdf`;
  const expiresAt = new Date(Date.now() + FALLBACK_RETENTION_SECONDS * 1000).toISOString();

  const body = await request.arrayBuffer();
  await env.CLAIM_BUCKET.put(key, body, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { expiresAt, sourceIp: ip },
  });

  return json({ ok: true, key, expiresAt });
}

// Staff-only override to delete a fallback object immediately after review
// (called from an internal tool, not exposed to the public form).
async function handleFallbackDelete(request, env) {
  const auth = request.headers.get('X-Staff-Key');
  if (!auth || auth !== env.STAFF_KEY) return json({ error: 'Unauthorized' }, 401);
  const { key } = await request.json();
  if (!key) return badRequest('Missing key.');
  await env.CLAIM_BUCKET.delete(key);
  return json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,X-Staff-Key',
        },
      });
    }

    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLead(request, env);
    }
    if (url.pathname === '/api/fallback-upload' && request.method === 'POST') {
      return handleFallbackUpload(request, env);
    }
    if (url.pathname === '/api/fallback-delete' && request.method === 'POST') {
      return handleFallbackDelete(request, env);
    }

    // Fall through to static assets (public/ directory).
    return env.ASSETS.fetch(request);
  },

  // Hourly safeguard: delete any R2 fallback object past its expiry.
  // The R2 lifecycle rule (see README) is the backstop in case this
  // ever fails to run.
  async scheduled(event, env, ctx) {
    const now = Date.now();
    let cursor;
    let deleted = 0;
    do {
      const listing = await env.CLAIM_BUCKET.list({ prefix: 'fallback/', cursor });
      for (const obj of listing.objects) {
        const head = await env.CLAIM_BUCKET.head(obj.key);
        const expiresAt = head?.customMetadata?.expiresAt;
        if (!expiresAt || new Date(expiresAt).getTime() < now) {
          await env.CLAIM_BUCKET.delete(obj.key);
          deleted++;
        }
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
    console.log(`Cleanup run: deleted ${deleted} expired fallback object(s).`);
  },
};
