/**
 * C-0006-A — migration audit report generator (fixture mode).
 * ---------------------------------------------------------------
 * Regenerates the shadow-detection parity report from the repository fixtures
 * without a database, so the artifact committed under `reports/` can be
 * reproduced byte-for-byte:
 *
 *   cd apps/api
 *   npx tsx src/tools/canonical-parity-report.ts --out ../../reports/C-0006-A-migration-audit-report.md
 *
 * Fixture mode has no conflicting sources, so the legacy input set and the
 * canonical-fact input set are identical (parity OK). The real-PostgreSQL
 * equivalent — including a CONFLICT fact that must surface as a mismatch — is
 * `src/__tests__/canonical-parity-db.test.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  buildDetectionParityReport,
  renderMigrationAuditReport,
  type DetectionInputs,
} from '../services/canonical';
import { toRuleCandidate, type InvoiceRow, type TrackingRow } from '../services/rules';

const API_ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(API_ROOT, 'fixtures', 'logistics');
const REPORT_ORG = 'fixture-org';

function parseCsv(file: string): Array<Record<string, string>> {
  const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8').trim();
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const header = headerLine.split(',').map((cell) => cell.trim());
  return lines.map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((column, index) => [column, (cells[index] ?? '').trim()]));
  });
}

function invoices(): InvoiceRow[] {
  return parseCsv('carrier-invoice.csv').map((row) => ({
    sourceTransactionId: `fixture-invoice-${row['Invoice No']}`,
    externalId: row['Invoice No'] ?? null,
    occurredAt: new Date(`${row['Invoice Date']}T00:00:00Z`),
    amount: row['Net Charge'] ?? null,
    currency: row.Currency || 'USD',
    trackingNumber: row['Tracking Number'] ?? null,
  }));
}

function tracking(): TrackingRow[] {
  return parseCsv('tracking.csv').map((row) => ({
    sourceTransactionId: `fixture-tracking-${row['Tracking Number']}`,
    externalId: row['Tracking Number'] ?? null,
    lane: row.Lane ?? null,
    service: row.Service ?? null,
    weightKg: row['Weight Kg'] ?? null,
  }));
}

function ruleCandidates() {
  const seed = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rules.json'), 'utf8')) as {
    ruleSets: Array<{
      versions: Array<{ tier: string; version: string; effectiveFrom: string; definition: unknown }>;
    }>;
  };
  return seed.ruleSets.flatMap((set, setIndex) =>
    set.versions.map((version, versionIndex) =>
      toRuleCandidate({
        ruleVersionId: `fixture-rv-${setIndex}-${versionIndex}`,
        tier: version.tier as Parameters<typeof toRuleCandidate>[0]['tier'],
        version: version.version,
        effectiveFrom: new Date(version.effectiveFrom),
        definition: version.definition,
      }),
    ),
  );
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex === -1 ? null : process.argv[outIndex + 1];

  const invoiceRows = invoices();
  const trackingRows = tracking();
  const candidates = ruleCandidates();
  const inputs: DetectionInputs = { invoices: invoiceRows, tracking: trackingRows, candidates };

  const report = await buildDetectionParityReport({
    organizationId: REPORT_ORG,
    scope: { domain: 'LOGISTICS', channel: 'OTHER' },
    legacyInputs: inputs,
    shadowInputs: inputs,
    counts: {
      activeFactTransactions: invoiceRows.length + trackingRows.length,
      excludedTransactions: 0,
    },
    generatedAt: new Date(process.env.PARITY_REPORT_TIME ?? Date.now()),
  });

  const markdown = renderMigrationAuditReport(report);
  if (out) {
    const target = path.resolve(API_ROOT, out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
    return;
  }
  process.stdout.write(markdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
