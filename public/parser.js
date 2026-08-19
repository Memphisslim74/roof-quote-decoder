/**
 * Roof Claim Decoder — deterministic parsing engine.
 * Runs 100% client-side on text already extracted from the PDF by PDF.js.
 * No network calls. No AI. This is the free, fast, default path.
 *
 * Strategy: adjuster estimates (Xactimate, Symbility, and most carrier-generated
 * PDFs) use predictable label vocabulary and a summary block near the end of the
 * document. We look for that vocabulary, pull the dollar figure that follows it,
 * and score how confident we are in the result. Low confidence -> hand off to
 * "needs human review" instead of guessing.
 */

const MONEY = /\$?\s?(-?\(?\$?[\d,]+\.\d{2}\)?)/;

function toNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()$,]/g, '').replace(/^-/, '');
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

// Field definitions: label variants -> canonical key.
// Order matters: more specific labels are tried first so "Non-Recoverable
// Depreciation" doesn't get swallowed by a loose "Depreciation" match.
const FIELD_RULES = [
  { key: 'rcv', labels: [
    'replacement cost value', 'rcv', 'total replacement cost value',
    'net claim if replacement cost value is claimed',
  ] },
  { key: 'acv', labels: [
    'actual cash value', 'acv', 'net claim if actual cash value is claimed',
  ] },
  { key: 'recoverableDepreciation', labels: [
    'recoverable depreciation', 'total recoverable depreciation',
  ] },
  { key: 'nonRecoverableDepreciation', labels: [
    'non-recoverable depreciation', 'nonrecoverable depreciation',
    'total non-recoverable depreciation',
  ] },
  { key: 'depreciation', labels: [
    'less depreciation', 'depreciation', 'total depreciation',
  ] },
  { key: 'deductible', labels: [
    'deductible', 'less deductible', 'insurance deductible',
  ] },
  { key: 'netClaim', labels: [
    'net claim', 'total net claim', 'amount payable',
  ] },
  { key: 'overheadProfit', labels: [
    "overhead and profit", "o&p", "overhead & profit",
  ] },
  { key: 'priceList', labels: [
    'price list', 'estimate price list',
  ] },
  { key: 'claimNumber', labels: [
    'claim number', 'claim #', 'claim no',
  ], money: false },
  { key: 'dateOfLoss', labels: [
    'date of loss', 'loss date',
  ], money: false },
  { key: 'carrier', labels: [
    'insurance company', 'carrier',
  ], money: false },
];

// Line items commonly found in roofing estimates — used to classify and
// flag items that homeowners often don't realize they're entitled to
// discuss with their roofer.
const ROOF_LINE_ITEM_PATTERNS = [
  { re: /ice\s*(and|&)?\s*water\s*(shield|barrier)?/i, label: 'Ice & water shield', note: 'Often required by code but sometimes underpriced or omitted.' },
  { re: /drip\s*edge/i, label: 'Drip edge', note: 'Code-required in most jurisdictions; check it\'s included for the full perimeter.' },
  { re: /ridge\s*vent/i, label: 'Ridge vent', note: 'Ventilation upgrades are frequently missed on the first estimate.' },
  { re: /flashing/i, label: 'Flashing (step/counter/chimney)', note: 'A common underscope item — reused flashing rarely meets code on a full replacement.' },
  { re: /pipe\s*(jack|boot)/i, label: 'Pipe boots/jacks', note: 'Cheap to replace; often missing from the first pass.' },
  { re: /(felt|underlayment|synthetic underlayment)/i, label: 'Underlayment', note: '' },
  { re: /(architectural|3[\s-]?tab|dimensional)\s*shingle/i, label: 'Shingles', note: '' },
  { re: /decking|sheathing|osb|plywood/i, label: 'Decking/sheathing replacement', note: 'Verify a realistic percentage was allowed — insurers sometimes lowball this.' },
  { re: /gutter/i, label: 'Gutters', note: '' },
  { re: /permit/i, label: 'Permit fee', note: '' },
  { re: /dumpster|debris|haul|disposal/i, label: 'Debris removal/disposal', note: '' },
  { re: /tarp/i, label: 'Emergency tarp', note: '' },
];

function findLabelValue(lines, labels) {
  const lower = labels.map(l => l.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lline = line.toLowerCase();
    for (const label of lower) {
      const idx = lline.indexOf(label);
      if (idx === -1) continue;
      // Try same line first (label ... $amount)
      const rest = line.slice(idx + label.length);
      let m = rest.match(MONEY);
      if (m) return { value: m[1], line: i, raw: line.trim() };
      // Then check the next 2 lines (some estimates wrap label/value)
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        m = lines[i + j].match(MONEY);
        if (m) return { value: m[1], line: i + j, raw: lines[i + j].trim() };
      }
    }
  }
  return null;
}

function findTextValue(lines, labels) {
  const lower = labels.map(l => l.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const lline = lines[i].toLowerCase();
    for (const label of lower) {
      const idx = lline.indexOf(label);
      if (idx === -1) continue;
      // Text after the label on the same line (e.g. "Claim Number: CLM-123")
      const after = lines[i].slice(idx + label.length).replace(/^[:\s-]+/, '').trim();
      if (after) return after.slice(0, 80);
      // Text before the label on the same line (e.g. "XYZ Insurance Company")
      const before = lines[i].slice(0, idx).replace(/[:\s-]+$/, '').trim();
      if (before) return before.slice(0, 80);
      // Only fall through to the next line if this line was the label alone
      if (lines[i + 1]) return lines[i + 1].trim().slice(0, 80);
    }
  }
  return null;
}

export function parseClaimText(fullText) {
  const lines = fullText
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const fields = {};
  let hitCount = 0;

  for (const rule of FIELD_RULES) {
    if (rule.money === false) {
      const found = findTextValue(lines, rule.labels);
      if (found) { fields[rule.key] = found; hitCount++; }
      continue;
    }
    const found = findLabelValue(lines, rule.labels);
    if (found) {
      fields[rule.key] = toNumber(found.value);
      hitCount++;
    }
  }

  // Collapse depreciation variants into one clear picture.
  const recoverable = fields.recoverableDepreciation ?? null;
  const nonRecoverable = fields.nonRecoverableDepreciation ?? null;
  const genericDep = fields.depreciation ?? null;

  // Detect line items present in the doc (for the "worth discussing" list).
  const lineItemsFound = [];
  for (const pat of ROOF_LINE_ITEM_PATTERNS) {
    const present = lines.some(l => pat.re.test(l));
    lineItemsFound.push({ label: pat.label, present, note: pat.note });
  }
  const missingKeyItems = lineItemsFound.filter(
    li => !li.present && ['Ice & water shield', 'Drip edge', 'Flashing (step/counter/chimney)', 'Pipe boots/jacks'].includes(li.label)
  );

  // Math sanity check: RCV - depreciation - deductible ≈ net claim (or ACV)
  let mathChecks = [];
  const dep = recoverable != null || nonRecoverable != null
    ? (Math.abs(recoverable || 0) + Math.abs(nonRecoverable || 0))
    : (genericDep != null ? Math.abs(genericDep) : null);

  if (fields.rcv != null && dep != null && fields.acv != null) {
    const expectedAcv = fields.rcv - dep;
    const diff = Math.abs(expectedAcv - fields.acv);
    mathChecks.push({
      label: 'RCV minus depreciation ≈ ACV',
      pass: diff < 5,
      detail: `RCV $${fields.rcv.toFixed(2)} − depreciation $${dep.toFixed(2)} = $${expectedAcv.toFixed(2)}, estimate lists ACV as $${fields.acv.toFixed(2)}`,
    });
  }
  if (fields.acv != null && fields.deductible != null && fields.netClaim != null) {
    const expectedNet = fields.acv - fields.deductible;
    const diff = Math.abs(expectedNet - fields.netClaim);
    mathChecks.push({
      label: 'ACV minus deductible ≈ net claim (initial check)',
      pass: diff < 5,
      detail: `ACV $${fields.acv.toFixed(2)} − deductible $${fields.deductible.toFixed(2)} = $${expectedNet.toFixed(2)}, estimate lists net claim as $${fields.netClaim.toFixed(2)}`,
    });
  }

  // Confidence score: how many core fields did we find, cleanly?
  const coreFields = ['rcv', 'acv', 'deductible'];
  const coreFound = coreFields.filter(k => fields[k] != null).length;
  const mathPassed = mathChecks.length === 0 ? null : mathChecks.every(c => c.pass);

  let confidence = coreFound / coreFields.length; // 0 - 1
  if (mathPassed === false) confidence *= 0.5;
  if (hitCount === 0) confidence = 0;

  const needsReview = confidence < 0.6 || (fullText.trim().length < 200);

  return {
    fields: {
      rcv: fields.rcv ?? null,
      acv: fields.acv ?? null,
      recoverableDepreciation: recoverable,
      nonRecoverableDepreciation: nonRecoverable,
      depreciation: genericDep,
      deductible: fields.deductible ?? null,
      netClaim: fields.netClaim ?? null,
      overheadProfit: fields.overheadProfit ?? null,
      claimNumber: fields.claimNumber ?? null,
      dateOfLoss: fields.dateOfLoss ?? null,
      carrier: fields.carrier ?? null,
    },
    lineItemsFound,
    missingKeyItems,
    mathChecks,
    confidence,
    needsReview,
    rawLineCount: lines.length,
  };
}
