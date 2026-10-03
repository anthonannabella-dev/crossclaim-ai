/** P0-1 — Import ↔ Return/Export/Destruction 匹配回归（契约 + 确定性 + fail-closed）。 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_RETURN_MATCHING_BOUNDARY,
  CustomsReturnMatchError,
  matchCustomsLinesToReturns,
  normalizeCustomsReturnFact,
} from '../services/customs/customs-return-matching';

const ORG = 'org-1';
const ACCOUNT = 'acct-1';

function returnFact(overrides: Record<string, unknown> = {}) {
  return normalizeCustomsReturnFact({
    organizationId: ORG,
    platformAccountId: ACCOUNT,
    entryNumber: 'ABI-2026-000123',
    htsCode: '9901.00.10',
    sku: 'SKU-1',
    kind: 'RETURN',
    quantity: '100.00',
    currency: 'USD',
    jurisdiction: 'US',
    importerOfRecordRef: 'ior_1',
    source: 'BROKER_DOCUMENT',
    rawReference: 'ret:1',
    observedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  } as never);
}

function entryLine(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    platformAccountId: ACCOUNT,
    lineOrdinal: 0,
    htsCode: '9901.00.10',
    sku: 'SKU-1',
    quantity: '100.00',
    currency: 'USD',
    jurisdiction: 'US',
    ...overrides,
  };
}

const POLICY = { policyId: 'customs-return-2026', policyVersion: '1.0.0', requireHtsMatch: true, requireSkuMatchWhenPresent: true };

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof CustomsReturnMatchError ? error.code : 'NOT_A_MATCH_ERROR';
  }
  return 'NO_ERROR';
};

describe('P0-1 — customs return matching', () => {
  it('exact import↔return match → EXACT 且 eligible quantity 等于行数量', () => {
    const result = matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [returnFact()], policy: POLICY });
    expect(result.lines[0].status).toBe('EXACT');
    expect(result.lines[0].eligibleQuantity).toBe('100.000000');
    expect(result.lines[0].reasonCodes).toContain('QUANTITY_COVERED');
    expect(result.autoFiling).toBe(false);
    expect(result.transportEnabled).toBe(false);
  });

  it('partial match → 只按已证明匹配的部分计算（禁止放大）', () => {
    const result = matchCustomsLinesToReturns({
      entryLines: [entryLine()],
      returnFacts: [returnFact({ quantity: '40.00' })],
      policy: POLICY,
    });
    expect(result.lines[0].status).toBe('PARTIAL');
    expect(result.lines[0].eligibleQuantity).toBe('40.000000');
    expect(result.lines[0].reasonCodes).toContain('QUANTITY_PARTIAL');
    expect(result.partialScaledUp).toBe(false);
  });

  it('同一 SKU 多笔数量不一致 → AMBIGUOUS，eligible = 0（绝不自动转 ELIGIBLE）', () => {
    const result = matchCustomsLinesToReturns({
      entryLines: [entryLine()],
      returnFacts: [returnFact({ quantity: '100.00', rawReference: 'ret:1' }), returnFact({ quantity: '30.00', rawReference: 'ret:2' })],
      policy: POLICY,
    });
    expect(result.lines[0].status).toBe('AMBIGUOUS');
    expect(result.lines[0].eligibleQuantity).toBe('0.000000');
    expect(result.ambiguousTreatedAsEligible).toBe(false);
  });

  it('HTS mismatch → NO_MATCH + HTS_MISMATCH（不产生可追回数量）', () => {
    const result = matchCustomsLinesToReturns({
      entryLines: [entryLine()],
      returnFacts: [returnFact({ htsCode: '9999.00.00' })],
      policy: POLICY,
    });
    expect(result.lines[0].status).toBe('NO_MATCH');
    expect(result.lines[0].eligibleQuantity).toBe('0.000000');
    expect(result.lines[0].reasonCodes).toContain('HTS_MISMATCH');
  });

  it('currency / jurisdiction mismatch → NO_MATCH（拒绝）', () => {
    const currency = matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [returnFact({ currency: 'CAD' })], policy: POLICY });
    expect(currency.lines[0].reasonCodes).toContain('CURRENCY_MISMATCH');
    const jurisdiction = matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [returnFact({ jurisdiction: 'CA' })], policy: POLICY });
    expect(jurisdiction.lines[0].reasonCodes).toContain('JURISDICTION_MISMATCH');
  });

  it('无证据 → NO_MATCH + NO_RETURN_EVIDENCE', () => {
    const result = matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [], policy: POLICY });
    expect(result.lines[0].status).toBe('NO_MATCH');
    expect(result.lines[0].reasonCodes).toEqual(['NO_RETURN_EVIDENCE']);
  });

  it('跨租户 / 跨账户 lineage → 抛错拒绝', () => {
    expect(
      codeOf(() =>
        matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [returnFact({ organizationId: 'org-2' })], policy: POLICY }),
      ),
    ).toBe('CROSS_TENANT_LINEAGE');
    expect(
      codeOf(() =>
        matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [returnFact({ platformAccountId: 'acct-2' })], policy: POLICY }),
      ),
    ).toBe('CROSS_ACCOUNT_LINEAGE');
  });

  it('重复 fact ingest（同 contentDigest）→ 去重为一笔', () => {
    const one = returnFact();
    const result = matchCustomsLinesToReturns({ entryLines: [entryLine()], returnFacts: [one, { ...one }], policy: POLICY });
    expect(result.lines[0].status).toBe('EXACT');
    expect(result.lines[0].matchedReturnFactIds).toHaveLength(1);
  });

  it('事实层 fail-closed：非法数量 / 币种 / kind / source / PII', () => {
    expect(codeOf(() => returnFact({ quantity: '0' }))).toBe('INVALID_QUANTITY');
    expect(codeOf(() => returnFact({ currency: 'usd' }))).toBe('INVALID_CURRENCY');
    expect(codeOf(() => returnFact({ kind: 'REFUND' }))).toBe('INVALID_RETURN_KIND');
    expect(codeOf(() => returnFact({ source: 'GUESS' }))).toBe('INVALID_SOURCE');
    expect(codeOf(() => returnFact({ importerName: 'ACME LLC' }))).toBe('RAW_PII_NOT_ALLOWED');
    expect(codeOf(() => returnFact({ credential: 'x' }))).toBe('RAW_PII_NOT_ALLOWED');
  });

  it('确定性：同一输入两次匹配完全一致（含 reasonCodes 顺序）', () => {
    const input = { entryLines: [entryLine()], returnFacts: [returnFact()], policy: POLICY };
    expect(JSON.stringify(matchCustomsLinesToReturns(input))).toBe(JSON.stringify(matchCustomsLinesToReturns(input)));
    expect(CUSTOMS_RETURN_MATCHING_BOUNDARY.ambiguousTreatedAsEligible).toBe(false);
    expect(CUSTOMS_RETURN_MATCHING_BOUNDARY.autoFiling).toBe(false);
    expect(CUSTOMS_RETURN_MATCHING_BOUNDARY.crossAccountRejected).toBe(true);
    expect(CUSTOMS_RETURN_MATCHING_BOUNDARY.credentials).toBe('ABSENT');
  });
});
