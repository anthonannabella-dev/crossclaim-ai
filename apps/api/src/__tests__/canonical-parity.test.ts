/**
 * C-0006-A — shadow detection parity unit tests (no database needed).
 *
 * The parity report must show that the legacy input path and the
 * canonical-fact input path agree, and that it *detects* a divergence when a
 * raw row is excluded (which is what a CONFLICT fact will do in C-0006-B).
 */

import { describe, expect, it } from 'vitest';

import {
  buildDetectionParityReport,
  renderMigrationAuditReport,
  type DetectionInputs,
} from '../services/canonical';
import { toRuleCandidate, type InvoiceRow, type TrackingRow } from '../services/rules';

const ORG = '99999999-9999-4999-8999-999999999999';
const SCOPE = { domain: 'LOGISTICS', channel: 'OTHER' } as const;

const candidate = toRuleCandidate({
  ruleVersionId: 'rv-rate-card-1',
  tier: 'CUSTOMER_RATE_CARD',
  version: 'v1-cn-sha-us-lax-ground',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  definition: {
    schemaVersion: 1,
    kind: 'FREIGHT_RATE_V1',
    match: { lane: 'CN-SHA>US-LAX', service: 'Ground' },
    pricing: { currency: 'USD', baseRate: '80.0000', perKg: '3.2000', fuelPct: '12.50' },
    rounding: { scale: 4, mode: 'HALF_UP' },
  },
});

const invoice = (externalId: string, trackingNumber: string, amount: string): InvoiceRow => ({
  sourceTransactionId: `invoice-tx-${externalId}`,
  externalId,
  occurredAt: new Date('2026-09-01T00:00:00Z'),
  amount,
  currency: 'USD',
  trackingNumber,
});

const tracking = (trackingNumber: string): TrackingRow => ({
  sourceTransactionId: `tracking-tx-${trackingNumber}`,
  externalId: trackingNumber,
  lane: 'CN-SHA>US-LAX',
  service: 'Ground',
  weightKg: '12.5000',
});

const inputs = (invoices: InvoiceRow[], trackingRows: TrackingRow[]): DetectionInputs => ({
  invoices,
  tracking: trackingRows,
  candidates: [candidate],
});

const allInvoices = [invoice('INV-1001', '1ZDEMO001', '152.7500'), invoice('INV-1002', '1ZDEMO002', '140.0000')];
const allTracking = [tracking('1ZDEMO001'), tracking('1ZDEMO002')];

describe('C-0006-A — shadow detection parity', () => {
  it('reports OK when both paths see the same rows (golden freight numbers)', async () => {
    const report = await buildDetectionParityReport({
      organizationId: ORG,
      scope: SCOPE,
      legacyInputs: inputs(allInvoices, allTracking),
      shadowInputs: inputs(allInvoices, allTracking),
      counts: { activeFactTransactions: 4, excludedTransactions: 0 },
      generatedAt: new Date('2026-09-28T12:00:00Z'),
    });

    expect(report.parity).toBe('OK');
    expect(report.mismatches).toHaveLength(0);
    expect(report.rows).toHaveLength(2);
    expect(report.legacy.opportunitiesCreated).toBe(2);
    expect(report.shadow.opportunitiesCreated).toBe(2);

    const first = report.rows[0];
    expect(first.invoiceExternalId).toBe('INV-1001');
    expect(first.legacyExpected).toBe('135.0000');
    expect(first.legacyActual).toBe('152.7500');
    expect(first.legacyRecoverable).toBe('17.7500');
    expect(first.shadowRecoverable).toBe('17.7500');
    expect(first.ruleVersionId).toBe('rv-rate-card-1');
    expect(first.equal).toBe(true);

    expect(report.moneyTrace.legacyRecoverableTotal).toBe(report.moneyTrace.shadowRecoverableTotal);
    expect(report.coverage.sourceTransactions).toBe(4);
    expect(report.coverage.activeFactTransactions).toBe(4);
    expect(report.coverage.conflictFactTransactions).toBe(0);
    expect(report.coverage.factCoverageRatio).toBe('1.0000');
  });

  it('reports MISMATCH and names the excluded invoice when the shadow path sees fewer rows', async () => {
    const report = await buildDetectionParityReport({
      organizationId: ORG,
      scope: SCOPE,
      legacyInputs: inputs(allInvoices, allTracking),
      shadowInputs: inputs([allInvoices[0]], [allTracking[0]]),
      counts: { activeFactTransactions: 2, excludedTransactions: 2 },
      generatedAt: new Date('2026-09-28T12:00:00Z'),
    });

    expect(report.parity).toBe('MISMATCH');
    expect(report.mismatches.length).toBeGreaterThan(0);
    expect(report.mismatches.some((line) => line.includes('INV-1002'))).toBe(true);

    const excluded = report.rows.find((row) => row.invoiceExternalId === 'INV-1002');
    expect(excluded?.shadowResult).toBeNull();
    expect(excluded?.note).toContain('EXCLUDED_IN_SHADOW');
    expect(report.counts.excludedTransactions).toBe(2);
    expect(report.shadow.opportunitiesCreated).toBe(1);
    expect(report.moneyTrace.shadowRecoverableTotal).not.toBe(report.moneyTrace.legacyRecoverableTotal);
    expect(report.coverage.factCoverageRatio).toBe('0.5000');
    expect(report.mismatches.some((line) => line.includes('fact coverage 不完整'))).toBe(true);
  });

  it('renders the audit report with the required comparison fields', async () => {
    const report = await buildDetectionParityReport({
      organizationId: ORG,
      scope: SCOPE,
      legacyInputs: inputs(allInvoices, allTracking),
      shadowInputs: inputs(allInvoices, allTracking),
      counts: { activeFactTransactions: 4, excludedTransactions: 0 },
      generatedAt: new Date('2026-09-28T12:00:00Z'),
    });
    const markdown = renderMigrationAuditReport(report);

    expect(markdown).toContain('# C-0006-A Migration Audit Report');
    expect(markdown).toContain('Detection comparison');
    expect(markdown).toContain('Fact coverage');
    expect(markdown).toContain('money trace');
    expect(markdown).toContain('INV-1001');
    expect(markdown).toContain('17.7500');
    expect(markdown).toContain('parity: **OK**');
  });
});
