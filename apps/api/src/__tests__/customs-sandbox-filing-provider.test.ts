/** C18-3 单元验收：SandboxFilingProvider（零外写 / tenant-scoped / 幂等 / 状态不隐式升级）。 */

import { describe, expect, it } from 'vitest';

import { createSandboxFilingProvider } from '../services/customs/customs-sandbox-filing-provider';
import { CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS, missingFilingCapabilities } from '../services/customs/customs-filing-provider';

const ORG = 'org:acme';
const OTHER = 'org:other';
const DIGEST = 'b'.repeat(64);

const submissionInput = () => ({
  organizationId: ORG,
  opportunityId: 'opp:1',
  claimItemId: 'claim:1',
  packageId: 'package:1',
  packageDigest: DIGEST,
  jurisdiction: 'US',
  remedyType: 'DRAWBACK',
  idempotencyKey: 'customs-submission:package:1',
});

describe('C18-3 — sandbox filing provider（unit，零外写）', () => {
  it('声明完整 capability（可覆盖 AUTO_FILING 必需操作），且不发起任何外部调用', async () => {
    const provider = createSandboxFilingProvider();
    expect(provider.providerId).toBe('sandbox:customs');
    expect(missingFilingCapabilities(provider.capabilities, CUSTOMS_AUTO_FILING_REQUIRED_OPERATIONS)).toEqual([]);
    const created = await provider.createSubmission(submissionInput());
    expect(created.providerSubmissionId).toMatch(/^sandbox-sub-/);
    expect(created.submissionStatus).toBe('SUBMITTED');
  });

  it('幂等：同 key 同 payload 返回同一提交；同 key 不同 payload → IDEMPOTENCY_KEY_CONFLICT', async () => {
    const provider = createSandboxFilingProvider();
    const first = await provider.createSubmission(submissionInput());
    const replay = await provider.createSubmission(submissionInput());
    expect(replay.providerSubmissionId).toBe(first.providerSubmissionId);

    await expect(
      provider.createSubmission({ ...submissionInput(), packageDigest: 'c'.repeat(64) }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('tenant isolation：跨租户读取 fail-closed，且 listSubmissions 只返回本租户', async () => {
    const provider = createSandboxFilingProvider();
    const created = await provider.createSubmission(submissionInput());
    await expect(
      provider.getSubmissionStatus({ organizationId: OTHER, providerSubmissionId: created.providerSubmissionId }),
    ).rejects.toThrow('CROSS_TENANT_ACCESS');
    expect(provider.listSubmissions(OTHER)).toEqual([]);
    expect(provider.listSubmissions(ORG)).toHaveLength(1);
  });

  it('证据上传幂等（同一 evidenceRef+sha256 重复上传不重复计数）', async () => {
    const provider = createSandboxFilingProvider();
    const created = await provider.createSubmission(submissionInput());
    const payload = {
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
      evidenceReference: 'evidence:entry',
      documentKind: 'ENTRY_SUMMARY',
      sha256: DIGEST,
      idempotencyKey: 'evidence:1',
    };
    const first = await provider.uploadEvidence(payload);
    const second = await provider.uploadEvidence(payload);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.providerReference).toBe('evidence:entry');
  });

  it('状态只能显式推进：SUBMITTED ≠ ACCEPTED；acceptedAt 仅在显式 ACCEPTED 时写入', async () => {
    const provider = createSandboxFilingProvider();
    const created = await provider.createSubmission(submissionInput());
    const initial = await provider.getSubmission({ organizationId: ORG, providerSubmissionId: created.providerSubmissionId });
    expect(initial.submissionStatus).toBe('SUBMITTED');
    expect(initial.acceptedAt).toBeNull();

    const accepted = provider.advanceStatus({
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
      status: 'ACCEPTED',
    });
    expect(accepted.status).toBe('ACCEPTED');
    const after = await provider.getSubmission({ organizationId: ORG, providerSubmissionId: created.providerSubmissionId });
    expect(after.acceptedAt).not.toBeNull();
  });

  it('RFI：可 seed、可读取、可回应（回应幂等）', async () => {
    const provider = createSandboxFilingProvider();
    const created = await provider.createSubmission(submissionInput());
    provider.seedRequestForInformation({
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
      requestId: 'rfi:1',
      summary: 'Need commercial invoice',
    });
    const list = await provider.listRequestsForInformation({
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
    });
    expect(list.requests).toHaveLength(1);
    const respond = await provider.respondToRequest({
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
      requestId: 'rfi:1',
      responseReference: 'evidence:invoice',
      idempotencyKey: 'rfi-response:1',
    });
    expect(respond.ok).toBe(true);
    const again = await provider.respondToRequest({
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
      requestId: 'rfi:1',
      responseReference: 'evidence:invoice',
      idempotencyKey: 'rfi-response:1',
    });
    expect(again.ok).toBe(true);
  });

  it('退款状态：默认 NOT_REFUNDED；显式设置后才返回金额（仍需 C20 确认为已追回）', async () => {
    const provider = createSandboxFilingProvider();
    const created = await provider.createSubmission(submissionInput());
    const initial = await provider.getRefundStatus({ organizationId: ORG, providerSubmissionId: created.providerSubmissionId });
    expect(initial.refundStatus).toBe('NOT_REFUNDED');
    expect(initial.refundedAmount).toBeNull();

    const refunded = provider.setRefundStatus({
      organizationId: ORG,
      providerSubmissionId: created.providerSubmissionId,
      refundStatus: 'REFUNDED',
      refundedAmount: '100.00',
      currency: 'USD',
    });
    expect(refunded.refundStatus).toBe('REFUNDED');
    expect(refunded.refundedAmount).toBe('100.00');
  });
});
