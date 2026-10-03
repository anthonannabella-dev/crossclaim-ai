/** R46 S4 —— Fee policy 可信来源（MSG-20261002-60 CHANGE A）纯函数测试 */

import { describe, expect, it } from 'vitest';

import {
  assertNoClientPolicyFields,
  FeePolicyError,
  resolveServerFeePolicy,
  type FeePolicyRecord,
  type FeePolicySource,
} from '../services/settlement/fee-policy-source';

const record = (over: Partial<FeePolicyRecord> = {}): FeePolicyRecord => ({
  organizationId: 'org-1',
  policyRef: 'policy-2026-01',
  feeBasisVersion: 'v1',
  basis: 'RECOVERED_AMOUNT_PCT',
  rate: '0.15',
  currency: 'USD',
  sourceKind: 'RATE_CARD',
  policyDigest: 'd'.repeat(64),
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  ...over,
});

const source = (value: FeePolicyRecord | null): FeePolicySource => ({
  resolve: async () => value as FeePolicyRecord,
});

const request = { organizationId: 'org-1', policyRef: 'policy-2026-01', feeBasisVersion: 'v1', now: '2026-06-01T00:00:00.000Z' };

describe('R46 S4 Fee policy 可信来源', () => {
  it('调用方提交 basis/rate/fixedAmount/currency/policyDigest → 一律拒绝（防 policy tampering）', () => {
    for (const field of ['basis', 'rate', 'fixedAmount', 'currency', 'policyDigest']) {
      expect(() => assertNoClientPolicyFields({ [field]: 'x' })).toThrowError(FeePolicyError);
      expect(() => assertNoClientPolicyFields({ [field]: 'x' })).toThrowError(/CLIENT_POLICY_FIELDS_NOT_TRUSTED/);
    }
    expect(() => assertNoClientPolicyFields({ policyRef: 'p', feeBasisVersion: 'v1' })).not.toThrow();
  });

  it('服务端解析生效中的 policy；租户/版本/生效期不一致 → fail-closed', async () => {
    await expect(resolveServerFeePolicy(source(record()), request)).resolves.toMatchObject({ policyRef: 'policy-2026-01' });

    await expect(
      resolveServerFeePolicy(source(record({ organizationId: 'org-2' })), request),
    ).rejects.toMatchObject({ code: 'POLICY_TENANT_MISMATCH' });

    await expect(
      resolveServerFeePolicy(source(record({ feeBasisVersion: 'v9' })), request),
    ).rejects.toMatchObject({ code: 'POLICY_NOT_FOUND' });

    await expect(
      resolveServerFeePolicy(source(record({ effectiveFrom: '2027-01-01T00:00:00.000Z' })), request),
    ).rejects.toMatchObject({ code: 'POLICY_NOT_EFFECTIVE' });

    await expect(
      resolveServerFeePolicy(source(record({ effectiveTo: '2026-02-01T00:00:00.000Z' })), request),
    ).rejects.toMatchObject({ code: 'POLICY_NOT_EFFECTIVE' });

    await expect(resolveServerFeePolicy({ resolve: async () => null as never }, request)).rejects.toMatchObject({
      code: 'POLICY_NOT_FOUND',
    });
  });
});
