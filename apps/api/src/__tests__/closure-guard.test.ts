/**
 * Wave 2 - C-0004 Checkpoint 2 Round 2 - closure guards (no database needed)
 * ---------------------------------------------------------------
 * CHANGE #53  production runtime must never create a synthetic settlement
 * CHANGE #54  opportunity closability gate + money preconditions
 * CHANGE #55  closure audit rows reuse the Gate 1 audit safety path
 * CHANGE #56  money inputs and success fee rate fail closed
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { REDACTED } from '../services/audit';
import {
  ClosureError,
  assertCommercialTerms,
  assertClosableOpportunity,
  assertSyntheticSettlementAllowed,
  buildClosureAuditRow,
  isOpportunityClosable,
  resolveRuntimeMode,
} from '../services/recovery';

const ORG = '44444444-4444-4444-8444-444444444444';
const moneyField = (value: string | null) => (value === null ? null : new Prisma.Decimal(value));

const opportunity = (overrides: Partial<Record<'amountExpected' | 'amountActual' | 'recoverableAmount', string | null>> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  amountExpected: moneyField('amountExpected' in overrides ? overrides.amountExpected! : '152.7500'),
  amountActual: moneyField('amountActual' in overrides ? overrides.amountActual! : '152.7500'),
  recoverableAmount: moneyField('recoverableAmount' in overrides ? overrides.recoverableAmount! : '17.7500'),
  currency: 'USD',
});

describe('C-0004 CP2 R2 - CHANGE #53 runtime guard', () => {
  it('refuses synthetic settlement in production and allows it in test/development', () => {
    expect(() => assertSyntheticSettlementAllowed('production', true)).toThrow(ClosureError);
    expect(() => assertSyntheticSettlementAllowed('production', true)).toThrow(/production/);
    expect(() => assertSyntheticSettlementAllowed('production', false)).not.toThrow();
    expect(() => assertSyntheticSettlementAllowed('test', true)).not.toThrow();
    expect(() => assertSyntheticSettlementAllowed('development', true)).not.toThrow();
  });

  it('resolves the runtime mode from an explicit value first', () => {
    expect(resolveRuntimeMode('production')).toBe('production');
    expect(resolveRuntimeMode('test')).toBe('test');
    expect(['test', 'development', 'production']).toContain(resolveRuntimeMode());
  });
});

describe('C-0004 CP2 R2 - CHANGE #54 state gate', () => {
  it('only QUALIFIED / CONVERTED opportunities may enter the closure', () => {
    expect(isOpportunityClosable('QUALIFIED')).toBe(true);
    expect(isOpportunityClosable('CONVERTED')).toBe(true);
    for (const blocked of ['DETECTED', 'REJECTED', 'EXPIRED']) {
      expect(isOpportunityClosable(blocked)).toBe(false);
    }
  });
});

describe('C-0004 CP2 R2 - CHANGE #56 fail closed money inputs', () => {
  it('accepts a complete opportunity', () => {
    expect(assertClosableOpportunity(opportunity()).recoverable).toBe('17.7500');
  });

  it('rejects missing or non-positive money inputs instead of coercing to 0', () => {
    expect(() => assertClosableOpportunity(opportunity({ amountExpected: null }))).toThrow(/amountExpected/);
    expect(() => assertClosableOpportunity(opportunity({ amountActual: null }))).toThrow(/amountActual/);
    expect(() => assertClosableOpportunity(opportunity({ recoverableAmount: null }))).toThrow(/recoverableAmount/);
    expect(() => assertClosableOpportunity(opportunity({ recoverableAmount: '0' }))).toThrow(ClosureError);
    expect(() =>
      assertClosableOpportunity({ ...opportunity(), currency: 'usd' }),
    ).toThrow(/usd/);
  });

  it('requires a decimal-string success fee rate inside (0, 1] with a source', () => {
    const source = 'fixtures/logistics/commercial-terms.json';
    expect(assertCommercialTerms({ successFeeRate: '0.1500', source }).toFixed(4)).toBe('0.1500');
    expect(() => assertCommercialTerms({ successFeeRate: '-0.15', source })).toThrow(ClosureError);
    expect(() => assertCommercialTerms({ successFeeRate: '0', source })).toThrow(ClosureError);
    expect(() => assertCommercialTerms({ successFeeRate: '1.50', source })).toThrow(ClosureError);
    expect(() =>
      assertCommercialTerms({ successFeeRate: 0.15 as unknown as string, source }),
    ).toThrow(ClosureError);
    expect(() => assertCommercialTerms({ successFeeRate: '0.1500', source: '  ' })).toThrow(ClosureError);
  });
});

describe('C-0004 CP2 R2 - CHANGE #55 audit safety path', () => {
  it('runs closure audit rows through the Gate 1 validation + sanitize path', () => {
    const row = buildClosureAuditRow({
      organizationId: ORG,
      action: 'claim.status_changed',
      entityType: 'Claim',
      entityId: '22222222-2222-4222-8222-222222222222',
      changes: { from: 'DRAFT', to: 'SUBMITTED', apiKey: 'sk-abcdefgh12345678' },
    });
    expect(row.actorType).toBe('SYSTEM');
    expect(row.actorRef).toBe('recovery-closure-service');
    expect(row.changes!['apiKey']).toBe(REDACTED);
  });

  it('rejects actions that Gate 1 would reject instead of writing raw rows', () => {
    expect(() =>
      buildClosureAuditRow({
        organizationId: ORG,
        action: 'Claim Status Changed',
        entityType: 'Claim',
        entityId: '22222222-2222-4222-8222-222222222222',
        changes: { to: 'SUBMITTED' },
      }),
    ).toThrow(/action/);
  });
});
