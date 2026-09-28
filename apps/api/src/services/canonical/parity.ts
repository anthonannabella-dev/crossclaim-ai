/**
 * C-0006-A shadow detection parity + migration audit report.
 * ---------------------------------------------------------------
 * The architecture review requires C-0006-A to prove, before any switch, that
 * the legacy input path and the canonical-fact input path produce the same
 * detection result:
 *
 *   legacy : SourceTransaction            → Detection
 *   shadow : SourceTransaction(+ACTIVE fact) → Detection
 *
 * Both runs use the *same* detection engine, but persist into an in-memory
 * repository, so the report never pollutes RuleEvaluation / RecoveryOpportunity.
 *
 * Detector inputs are identical except that the shadow path only sees raw rows
 * that belong to an ACTIVE CanonicalFact — CONFLICT facts (and rows without a
 * fact) are excluded, which is exactly the semantic change C-0006-B will make.
 */

import type { PrismaClient } from '@prisma/client';

import {
  DETECTION_ENGINE_VERSION,
  runFreightRateDetection,
  type DetectionPersistenceInput,
  type DetectionRepository,
  type DetectionRowOutcome,
  type DetectionRunResult,
  type DetectionScope,
  type InvoiceRow,
  type RuleCandidate,
  type TrackingRow,
} from '../rules';

export interface DetectionInputs {
  invoices: InvoiceRow[];
  tracking: TrackingRow[];
  candidates: RuleCandidate[];
}

export interface InMemoryDetectionRepository extends DetectionRepository {
  readonly persisted: DetectionPersistenceInput[];
}

/** Read-only detection repository used for both parity runs. */
export function createInMemoryDetectionRepository(
  inputs: DetectionInputs,
): InMemoryDetectionRepository {
  const persisted: DetectionPersistenceInput[] = [];
  let counter = 0;
  return {
    persisted,
    async listInvoices() {
      return inputs.invoices;
    },
    async listTracking() {
      return inputs.tracking;
    },
    async listFreightRateRuleCandidates() {
      return inputs.candidates;
    },
    async persistDetectionOutcome(row: DetectionPersistenceInput) {
      counter += 1;
      persisted.push(row);
      return {
        evaluationId: `parity-eval-${counter}`,
        created: true,
        result: row.result,
        computed: row.computed,
        opportunityId: row.opportunity ? `parity-opp-${counter}` : null,
      };
    },
  };
}

/** Raw rows that belong to an ACTIVE canonical fact inside the detection scope. */
export async function loadActiveFactTransactionIds(
  prisma: PrismaClient,
  scope: { organizationId: string; domain: DetectionScope['domain']; channel: DetectionScope['channel'] },
): Promise<Set<string>> {
  const links = await prisma.canonicalFactSource.findMany({
    where: {
      organizationId: scope.organizationId,
      canonicalFact: { status: 'ACTIVE', domain: scope.domain, channel: scope.channel },
    },
    select: { sourceTransactionId: true },
  });
  return new Set(links.map((link) => link.sourceTransactionId));
}

export interface InvoiceParityRow {
  key: string;
  invoiceExternalId: string | null;
  trackingExternalId: string | null;
  legacyResult: string;
  shadowResult: string | null;
  legacyExpected: string | null;
  shadowExpected: string | null;
  legacyActual: string | null;
  shadowActual: string | null;
  legacyRecoverable: string | null;
  shadowRecoverable: string | null;
  ruleVersionId: string | null;
  equal: boolean;
  note?: string;
}

export interface MigrationAuditReport {
  engineVersion: string;
  generatedAt: string;
  organizationId: string;
  scope: { domain: string; channel: string };
  counts: {
    legacyInvoices: number;
    shadowInvoices: number;
    legacyTracking: number;
    shadowTracking: number;
    activeFactTransactions: number;
    excludedTransactions: number;
  };
  legacy: { evaluationsCreated: number; opportunitiesCreated: number; unmatchedTracking: number };
  shadow: { evaluationsCreated: number; opportunitiesCreated: number; unmatchedTracking: number };
  moneyTrace: { legacyRecoverableTotal: string; shadowRecoverableTotal: string };
  rows: InvoiceParityRow[];
  mismatches: string[];
  parity: 'OK' | 'MISMATCH';
}

function scaled(value: string | null): bigint | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  const padded = (fracPart + '0000').slice(0, 4);
  const total = BigInt(intPart) * 10_000n + BigInt(padded === '' ? '0' : padded);
  return negative ? -total : total;
}

function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const intPart = abs / 10_000n;
  const fracPart = (abs % 10_000n).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

function sumRecoverable(outcomes: readonly DetectionRowOutcome[]): string {
  let total = 0n;
  for (const outcome of outcomes) {
    const value = scaled(outcome.recoverable);
    if (value !== null) total += value;
  }
  return formatScaled(total);
}

function keyOf(outcome: DetectionRowOutcome, index: number): string {
  const invoice = outcome.invoiceExternalId ?? `<no-invoice-${index}>`;
  const tracking = outcome.trackingExternalId ?? '<no-tracking>';
  return `${invoice}#${tracking}`;
}

function indexOutcomes(outcomes: readonly DetectionRowOutcome[]): Map<string, DetectionRowOutcome> {
  const map = new Map<string, DetectionRowOutcome>();
  outcomes.forEach((outcome, index) => {
    let key = keyOf(outcome, index);
    while (map.has(key)) key = `${key}~${index}`;
    map.set(key, outcome);
  });
  return map;
}

export interface BuildParityReportInput {
  organizationId: string;
  scope: DetectionScope;
  legacyInputs: DetectionInputs;
  shadowInputs: DetectionInputs;
  counts: {
    activeFactTransactions: number;
    excludedTransactions: number;
  };
  generatedAt?: Date;
}

export async function buildDetectionParityReport(
  input: BuildParityReportInput,
): Promise<MigrationAuditReport> {
  const legacyResult: DetectionRunResult = await runFreightRateDetection({
    organizationId: input.organizationId,
    scope: input.scope,
    repository: createInMemoryDetectionRepository(input.legacyInputs),
  });
  const shadowResult: DetectionRunResult = await runFreightRateDetection({
    organizationId: input.organizationId,
    scope: input.scope,
    repository: createInMemoryDetectionRepository(input.shadowInputs),
  });

  const legacyByKey = indexOutcomes(legacyResult.outcomes);
  const shadowByKey = indexOutcomes(shadowResult.outcomes);
  const rows: InvoiceParityRow[] = [];
  const mismatches: string[] = [];

  for (const [key, legacyOutcome] of legacyByKey) {
    const shadowOutcome = shadowByKey.get(key) ?? null;
    const equal =
      shadowOutcome !== null &&
      shadowOutcome.result === legacyOutcome.result &&
      shadowOutcome.expected === legacyOutcome.expected &&
      shadowOutcome.actual === legacyOutcome.actual &&
      shadowOutcome.recoverable === legacyOutcome.recoverable &&
      shadowOutcome.ruleVersionId === legacyOutcome.ruleVersionId;

    rows.push({
      key,
      invoiceExternalId: legacyOutcome.invoiceExternalId,
      trackingExternalId: legacyOutcome.trackingExternalId,
      legacyResult: legacyOutcome.result,
      shadowResult: shadowOutcome?.result ?? null,
      legacyExpected: legacyOutcome.expected,
      shadowExpected: shadowOutcome?.expected ?? null,
      legacyActual: legacyOutcome.actual,
      shadowActual: shadowOutcome?.actual ?? null,
      legacyRecoverable: legacyOutcome.recoverable,
      shadowRecoverable: shadowOutcome?.recoverable ?? null,
      ruleVersionId: legacyOutcome.ruleVersionId,
      equal,
      ...(shadowOutcome === null ? { note: 'EXCLUDED_IN_SHADOW (no ACTIVE canonical fact)' } : {}),
    });

    if (!equal) {
      mismatches.push(
        shadowOutcome === null
          ? `${key}: 旧路径 ${legacyOutcome.result}，shadow 未评估（被排除）`
          : `${key}: 旧路径 ${legacyOutcome.result}/${legacyOutcome.recoverable ?? '-'} ≠ shadow ${shadowOutcome.result}/${shadowOutcome.recoverable ?? '-'}`,
      );
    }
  }

  for (const [key, shadowOutcome] of shadowByKey) {
    if (legacyByKey.has(key)) continue;
    mismatches.push(`${key}: shadow 多出评估 ${shadowOutcome.result}`);
  }

  const legacyMoney = sumRecoverable(legacyResult.outcomes);
  const shadowMoney = sumRecoverable(shadowResult.outcomes);
  if (legacyMoney !== shadowMoney) {
    mismatches.push(`money trace 不一致：旧 ${legacyMoney} ≠ shadow ${shadowMoney}`);
  }
  if (legacyResult.opportunitiesCreated !== shadowResult.opportunitiesCreated) {
    mismatches.push(
      `Opportunity 数量不一致：旧 ${legacyResult.opportunitiesCreated} ≠ shadow ${shadowResult.opportunitiesCreated}`,
    );
  }

  return {
    engineVersion: DETECTION_ENGINE_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    organizationId: input.organizationId,
    scope: { domain: input.scope.domain, channel: input.scope.channel },
    counts: {
      legacyInvoices: legacyResult.invoicesConsidered,
      shadowInvoices: shadowResult.invoicesConsidered,
      legacyTracking: input.legacyInputs.tracking.length,
      shadowTracking: input.shadowInputs.tracking.length,
      activeFactTransactions: input.counts.activeFactTransactions,
      excludedTransactions: input.counts.excludedTransactions,
    },
    legacy: {
      evaluationsCreated: legacyResult.evaluationsCreated,
      opportunitiesCreated: legacyResult.opportunitiesCreated,
      unmatchedTracking: legacyResult.unmatchedTracking,
    },
    shadow: {
      evaluationsCreated: shadowResult.evaluationsCreated,
      opportunitiesCreated: shadowResult.opportunitiesCreated,
      unmatchedTracking: shadowResult.unmatchedTracking,
    },
    moneyTrace: { legacyRecoverableTotal: legacyMoney, shadowRecoverableTotal: shadowMoney },
    rows,
    mismatches,
    parity: mismatches.length === 0 ? 'OK' : 'MISMATCH',
  };
}

export function renderMigrationAuditReport(report: MigrationAuditReport): string {
  const lines: string[] = [];
  lines.push('# C-0006-A Migration Audit Report (shadow detection parity)');
  lines.push('');
  lines.push(`- engine: ${report.engineVersion}`);
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- organization: ${report.organizationId}`);
  lines.push(`- scope: ${report.scope.domain} / ${report.scope.channel}`);
  lines.push(`- parity: **${report.parity}**`);
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push(`- legacy invoices: ${report.counts.legacyInvoices}`);
  lines.push(`- shadow invoices（仅 ACTIVE 事实）: ${report.counts.shadowInvoices}`);
  lines.push(`- legacy tracking: ${report.counts.legacyTracking}`);
  lines.push(`- shadow tracking: ${report.counts.shadowTracking}`);
  lines.push(`- ACTIVE fact transactions: ${report.counts.activeFactTransactions}`);
  lines.push(`- excluded transactions: ${report.counts.excludedTransactions}`);
  lines.push('');
  lines.push('## Detection comparison');
  lines.push('');
  lines.push(`- legacy: evaluations=${report.legacy.evaluationsCreated} opportunities=${report.legacy.opportunitiesCreated} unmatchedTracking=${report.legacy.unmatchedTracking}`);
  lines.push(`- shadow: evaluations=${report.shadow.evaluationsCreated} opportunities=${report.shadow.opportunitiesCreated} unmatchedTracking=${report.shadow.unmatchedTracking}`);
  lines.push(`- money trace: legacy=${report.moneyTrace.legacyRecoverableTotal} shadow=${report.moneyTrace.shadowRecoverableTotal}`);
  lines.push('');
  lines.push('| invoice | tracking | result (legacy → shadow) | expected | actual | recoverable | ruleVersion | equal |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of report.rows) {
    lines.push(
      `| ${row.invoiceExternalId ?? '-'} | ${row.trackingExternalId ?? '-'} | ${row.legacyResult} → ${row.shadowResult ?? '-'} | ${row.legacyExpected ?? '-'} / ${row.shadowExpected ?? '-'} | ${row.legacyActual ?? '-'} / ${row.shadowActual ?? '-'} | ${row.legacyRecoverable ?? '-'} / ${row.shadowRecoverable ?? '-'} | ${row.ruleVersionId ?? '-'} | ${row.equal ? 'yes' : 'NO'} |`,
    );
  }
  lines.push('');
  lines.push('## Mismatches');
  lines.push('');
  if (report.mismatches.length === 0) {
    lines.push('- none');
  } else {
    for (const mismatch of report.mismatches) lines.push(`- ${mismatch}`);
  }
  lines.push('');
  return lines.join('\n');
}
