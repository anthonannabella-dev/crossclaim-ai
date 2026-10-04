/** C18-8 单元验收：只读对账 lookup 判定（adopt / conflict / not-found / 非法结果）。 */

import { describe, expect, it } from 'vitest';

import {
  CUSTOMS_PROVIDER_RECONCILIATION_LOOKUP_BOUNDARY,
  decideProviderReconciliation,
  providerSubmissionPayloadDigest,
} from '../services/customs/customs-provider-reconciliation-lookup';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const identity = (overrides: Record<string, string> = {}) => ({
  organizationId: 'org:acme',
  opportunityId: 'opportunity:1',
  claimItemId: 'claim-item:1',
  packageId: 'package:1',
  packageDigest: DIGEST_A,
  jurisdiction: 'US',
  remedyType: 'DRAWBACK',
  ...overrides,
});

describe('C18-8 — read-only reconciliation lookup', () => {
  it('payloadDigest 是完整 immutable payload 的 canonical SHA-256（名实一致）', () => {
    const base = providerSubmissionPayloadDigest(identity());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    // 稳定：同一身份重复计算一致。
    expect(providerSubmissionPayloadDigest(identity())).toBe(base);
    // 与 packageDigest 区分开：完整的载荷摘要不等于 packageDigest。
    expect(base).not.toBe(DIGEST_A);
    // 对任一分量敏感。
    for (const [field, value] of [
      ['organizationId', 'org:other'],
      ['opportunityId', 'opportunity:2'],
      ['claimItemId', 'claim-item:2'],
      ['packageId', 'package:2'],
      ['packageDigest', DIGEST_B],
      ['jurisdiction', 'DE'],
      ['remedyType', 'PROTEST'],
    ] as const) {
      expect(providerSubmissionPayloadDigest(identity({ [field]: value }))).not.toBe(base);
    }
  });

  it('同 key + 同 packageDigest 但不同 jurisdiction/remedy → digest 不同 → 绝不 ADOPT_EXISTING', () => {
    const providerSide = providerSubmissionPayloadDigest(identity());
    const attemptSide = providerSubmissionPayloadDigest(identity({ remedyType: 'PROTEST' }));
    expect(attemptSide).not.toBe(providerSide);
    const decision = decideProviderReconciliation({
      lookup: {
        outcome: 'FOUND',
        providerSubmissionId: 'sandbox-sub-0001',
        payloadDigest: providerSide,
        status: 'SUBMITTED',
      },
      expectedPayloadDigest: attemptSide,
    });
    expect(decision.verdict).toBe('CONFLICT_MISMATCH');
    expect(decision.providerSubmissionId).toBeNull();
    expect(decision.resubmitAllowed).toBe(false);
  });

  it('FOUND + digest 一致 → ADOPT_EXISTING（采用既有 id，且不重发、不外写）', () => {
    const decision = decideProviderReconciliation({
      lookup: {
        outcome: 'FOUND',
        providerSubmissionId: 'sandbox-sub-0001',
        payloadDigest: DIGEST_A,
        status: 'SUBMITTED',
      },
      expectedPayloadDigest: DIGEST_A,
    });
    expect(decision.verdict).toBe('ADOPT_EXISTING');
    expect(decision.providerSubmissionId).toBe('sandbox-sub-0001');
    expect(decision.reasonCode).toBe('RECONCILIATION_DIGEST_MATCH');
    expect(decision.resubmitAllowed).toBe(false);
    expect(decision.externalWritePerformed).toBe(false);
    expect(decision.transportEnabled).toBe(false);
    expect(decision.productionCredentials).toBe('ABSENT');
  });

  it('FOUND + digest 不一致 → CONFLICT_MISMATCH（不给出可采用的 id）', () => {
    const decision = decideProviderReconciliation({
      lookup: {
        outcome: 'FOUND',
        providerSubmissionId: 'sandbox-sub-0001',
        payloadDigest: DIGEST_B,
        status: 'SUBMITTED',
      },
      expectedPayloadDigest: DIGEST_A,
    });
    expect(decision.verdict).toBe('CONFLICT_MISMATCH');
    expect(decision.providerSubmissionId).toBeNull();
    expect(decision.providerPayloadDigest).toBe(DIGEST_B);
    expect(decision.reasonCode).toBe('RECONCILIATION_DIGEST_MISMATCH');
    expect(decision.resubmitAllowed).toBe(false);
  });

  it('NOT_FOUND → NOT_FOUND_MANUAL_REVIEW（无法证明已提交，也绝不自动重发）', () => {
    const decision = decideProviderReconciliation({
      lookup: { outcome: 'NOT_FOUND' },
      expectedPayloadDigest: DIGEST_A,
    });
    expect(decision.verdict).toBe('NOT_FOUND_MANUAL_REVIEW');
    expect(decision.reasonCode).toBe('RECONCILIATION_NOT_FOUND');
    expect(decision.resubmitAllowed).toBe(false);
  });

  it('非法结果一律 fail-closed：坏 expected digest / 缺 id / 坏 digest / URL-like id', () => {
    const bad = [
      decideProviderReconciliation({ lookup: { outcome: 'NOT_FOUND' }, expectedPayloadDigest: 'not-a-digest' }),
      decideProviderReconciliation({
        lookup: { outcome: 'FOUND', providerSubmissionId: '', payloadDigest: DIGEST_A, status: 'SUBMITTED' },
        expectedPayloadDigest: DIGEST_A,
      }),
      decideProviderReconciliation({
        lookup: { outcome: 'FOUND', providerSubmissionId: 'sub-1', payloadDigest: 'short', status: 'SUBMITTED' },
        expectedPayloadDigest: DIGEST_A,
      }),
      decideProviderReconciliation({
        lookup: {
          outcome: 'FOUND',
          providerSubmissionId: 'https://provider.example/sub-1',
          payloadDigest: DIGEST_A,
          status: 'SUBMITTED',
        },
        expectedPayloadDigest: DIGEST_A,
      }),
    ];
    for (const decision of bad) {
      expect(decision.verdict).toBe('INVALID_LOOKUP_RESULT');
      expect(decision.providerSubmissionId).toBeNull();
      expect(decision.resubmitAllowed).toBe(false);
    }
  });

  it('边界自证：对账查询是只读路径（无外写、无 provider 状态变更、无凭据）', () => {
    expect(CUSTOMS_PROVIDER_RECONCILIATION_LOOKUP_BOUNDARY).toEqual({
      readOnly: true,
      externalWritePerformed: false,
      providerStateMutationPerformed: false,
      filingSubmitted: false,
      transportEnabled: false,
      credentialReadPerformed: false,
      productionCredentials: 'ABSENT',
    });
  });
});
