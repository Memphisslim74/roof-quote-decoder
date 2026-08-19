/**
 * Turns the structured output of parser.js into a plain-English report.
 * No AI. Every sentence below is a template — we fill in numbers, we don't
 * generate prose.
 */

function money(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-$' : '$') + v;
}

export function buildReport(parsed) {
  const f = parsed.fields;
  const sections = [];

  sections.push({
    title: 'What your insurer approved',
    items: [
      f.rcv != null && {
        label: 'Replacement Cost Value (RCV)',
        value: money(f.rcv),
        explain: 'This is the full estimated cost to replace your roof with new materials, before any deductions.',
      },
      f.acv != null && {
        label: 'Actual Cash Value (ACV)',
        value: money(f.acv),
        explain: 'This is what your insurer will pay you right now — the replacement cost minus depreciation for your roof\'s age and wear.',
      },
      (f.recoverableDepreciation != null || f.depreciation != null) && {
        label: 'Recoverable Depreciation',
        value: money(f.recoverableDepreciation ?? f.depreciation),
        explain: 'This amount was withheld from your first check, but most policies release it once you complete the repair or replacement and submit your final invoice. Ask your adjuster how to claim it.',
      },
      f.nonRecoverableDepreciation != null && {
        label: 'Non-Recoverable Depreciation',
        value: money(f.nonRecoverableDepreciation),
        explain: 'Unlike recoverable depreciation, this portion is not paid back to you — it is a permanent reduction based on your roof\'s age and condition.',
      },
      f.deductible != null && {
        label: 'Your Deductible',
        value: money(f.deductible),
        explain: 'This is the amount you\'re responsible for paying out of pocket before insurance coverage applies.',
      },
      f.netClaim != null && {
        label: 'Net Claim (what you receive now)',
        value: money(f.netClaim),
        explain: 'This is what the insurer expects to pay you today, after depreciation and your deductible are subtracted.',
      },
      f.overheadProfit != null && {
        label: 'Overhead & Profit (O&P)',
        value: money(f.overheadProfit),
        explain: 'This covers a contractor\'s project-management costs. It\'s typically only included when a claim involves multiple trades or complexity — if your roof-only claim doesn\'t have it, that\'s worth asking about.',
      },
    ].filter(Boolean),
  });

  if (parsed.mathChecks.length) {
    sections.push({
      title: 'Does the math add up?',
      checks: parsed.mathChecks,
    });
  }

  const flagged = parsed.lineItemsFound.filter(li => li.present && li.note);
  const missing = parsed.missingKeyItems;
  if (flagged.length || missing.length) {
    sections.push({
      title: 'Items worth discussing with your roofer',
      flagged,
      missing,
    });
  }

  sections.push({
    title: 'Suggested next step',
    text: parsed.needsReview
      ? 'We found details in your estimate that need a closer look than an automated check can give. A My Family Roofer claim specialist can walk through it with you at no cost.'
      : 'This looks like a fairly standard estimate. If any recoverable depreciation is listed above, keep it in mind for after the work is finished — that\'s money you\'re still owed. If you want a second set of eyes before signing anything, a My Family Roofer specialist can review it with you at no cost.',
  });

  return sections;
}

export function renderReportHTML(parsed) {
  const sections = buildReport(parsed);
  const conf = Math.round(parsed.confidence * 100);

  let html = `<div class="report">`;
  html += `<div class="conf-badge ${parsed.needsReview ? 'conf-low' : 'conf-ok'}">
    ${parsed.needsReview ? 'Needs human review' : `Automated read confidence: ${conf}%`}
  </div>`;

  for (const s of sections) {
    html += `<section class="report-section"><h3>${s.title}</h3>`;
    if (s.items) {
      html += `<div class="field-grid">`;
      for (const it of s.items) {
        html += `<div class="field-row">
          <div class="field-label">${it.label}</div>
          <div class="field-value">${it.value}</div>
          <div class="field-explain">${it.explain}</div>
        </div>`;
      }
      html += `</div>`;
    }
    if (s.checks) {
      html += `<ul class="check-list">`;
      for (const c of s.checks) {
        html += `<li class="${c.pass ? 'check-pass' : 'check-fail'}">
          <strong>${c.pass ? '✓' : '⚠'} ${c.label}</strong><br>
          <span>${c.detail}</span>
        </li>`;
      }
      html += `</ul>`;
    }
    if (s.flagged || s.missing) {
      if (s.flagged && s.flagged.length) {
        html += `<p class="sub-label">Found in your estimate:</p><ul>`;
        for (const li of s.flagged) html += `<li><strong>${li.label}</strong> — ${li.note}</li>`;
        html += `</ul>`;
      }
      if (s.missing && s.missing.length) {
        html += `<p class="sub-label">Not clearly found — worth asking about:</p><ul>`;
        for (const li of s.missing) html += `<li><strong>${li.label}</strong> — not clearly listed in this estimate.</li>`;
        html += `</ul>`;
      }
    }
    if (s.text) html += `<p>${s.text}</p>`;
    html += `</section>`;
  }
  html += `</div>`;
  return html;
}
