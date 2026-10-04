/** C18-2 单元验收：provider-neutral 线上 DTO（opaque-only / 授权门槛 / digest 稳定 / 状态不升级）。 */

import { describe, expect, it } from 'vitest';

import {
  buildCustomsProviderSubmissionRequest,
  customsProviderRequestDigest,
  mapProviderRefundStatusToRevision,
  mapProviderStatus,
  mapProviderStatusToRevision,
} from '../services/customs/customs-provider-dto';

const DIGEST = 'a'.repeat(64);

const base = () => ({
  tenantRef: 'org:acme',
  principalRef: 'ior:acme',
  jurisdiction: 'US',
  remedy: 'DRAWBACK',
  brokerRef: 'broker:a',
  poaRef: 'evidence:poa',
  signerRef: null,
  filingAuthorized: true,
  packageRef: 'package:1',
  packageDigest: DIGEST,
  evidenceRefs: [{ evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: DIGEST }],
  idempotencyKey: 'customs-submission:package:1',
  requestedAt: '2026-10-04T05:00:00.000Z',
});

describe('C18-2 — provider-neutral wire DTO（unit）', () => {
  it('构造合法请求：opaque-only + 无外写声明 + digest 稳定且不随 requestedAt 变化', () => {
    const first = buildCustomsProviderSubmissionRequest(base());
    const second = buildCustomsProviderSubmissionRequest({ ...base(), requestedAt: '2026-10-04T09:30:00.000Z' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.envelope.requestDigest).toBe(second.envelope.requestDigest);
    expect(first.envelope.requestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.envelope.externalWritePerformed).toBe(false);
    expect(first.envelope.transportEnabled).toBe(false);
    expect(first.envelope.productionCredentials).toBe('ABSENT');
    expect(first.envelope.request.filingAuthorized).toBe(true);
  });

  it('digest 对同一语义载荷稳定，对内容变化敏感', () => {
    const { requestedAt, ...stable } = base();
    void requestedAt;
    const digest = customsProviderRequestDigest(stable);
    expect(customsProviderRequestDigest({ ...stable })).toBe(digest);
    expect(customsProviderRequestDigest({ ...stable, remedy: 'PROTEST' })).not.toBe(digest);
  });

  it('REVISE：digest 必须深入嵌套证据（改 evidenceRef / sha256 必须变化；仅顺序不同必须相同）', () => {
    const { requestedAt, ...stable } = base();
    void requestedAt;
    const withTwoEvidence = {
      ...stable,
      evidenceRefs: [
        { evidenceRef: 'evidence:entry', documentKind: 'ENTRY_SUMMARY', sha256: 'a'.repeat(64) },
        { evidenceRef: 'evidence:invoice', documentKind: 'COMMERCIAL_INVOICE', sha256: 'b'.repeat(64) },
      ],
    };
    const digestTwo = customsProviderRequestDigest(withTwoEvidence);

    const changedRef = {
      ...withTwoEvidence,
      evidenceRefs: [withTwoEvidence.evidenceRefs[0], { ...withTwoEvidence.evidenceRefs[1], evidenceRef: 'evidence:other' }],
    };
    expect(customsProviderRequestDigest(changedRef)).not.toBe(digestTwo);

    const changedSha = {
      ...withTwoEvidence,
      evidenceRefs: [withTwoEvidence.evidenceRefs[0], { ...withTwoEvidence.evidenceRefs[1], sha256: 'c'.repeat(64) }],
    };
    expect(customsProviderRequestDigest(changedSha)).not.toBe(digestTwo);

    const reordered = { ...withTwoEvidence, evidenceRefs: [...withTwoEvidence.evidenceRefs].reverse() };
    expect(customsProviderRequestDigest(reordered)).toBe(digestTwo);
  });

  it('裸 URL / EIN-like / 纯数字引用一律拒绝（opaque-only）', () => {
    for (const bad of ['https://broker.example/poa', 'HTTPS://Broker.example/poa', '12-3456789', '123456789']) {
      const result = buildCustomsProviderSubmissionRequest({ ...base(), poaRef: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_OPAQUE_REF');
    }
  });

  it('digest / 辖区 / remedy 形状校验 fail-closed', () => {
    const badDigest = buildCustomsProviderSubmissionRequest({ ...base(), packageDigest: 'not-a-digest' });
    expect(badDigest.ok).toBe(false);
    if (!badDigest.ok) expect(badDigest.code).toBe('INVALID_DIGEST');

    const badJurisdiction = buildCustomsProviderSubmissionRequest({ ...base(), jurisdiction: 'USA' });
    expect(badJurisdiction.ok).toBe(false);
    if (!badJurisdiction.ok) expect(badJurisdiction.code).toBe('INVALID_JURISDICTION');

    const badRemedy = buildCustomsProviderSubmissionRequest({ ...base(), remedy: 'FREE_TEXT' });
    expect(badRemedy.ok).toBe(false);
    if (!badRemedy.ok) expect(badRemedy.code).toBe('INVALID_REMEDY');
  });

  it('追回权 ≠ 申报授权：filingAuthorized=false 不得构造提交请求', () => {
    const result = buildCustomsProviderSubmissionRequest({ ...base(), filingAuthorized: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('FILING_NOT_AUTHORIZED');
  });

  it('空证据包不得提交（EMPTY_EVIDENCE）', () => {
    const result = buildCustomsProviderSubmissionRequest({ ...base(), evidenceRefs: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('EMPTY_EVIDENCE');
  });

  it('provider 状态白名单映射：未知 → UNKNOWN，且 SUBMITTED ≠ ACCEPTED / APPROVED ≠ PAID', () => {
    expect(mapProviderStatus('submitted')).toBe('SUBMITTED');
    expect(mapProviderStatus('Accepted')).toBe('ACCEPTED');
    expect(mapProviderStatus('approved')).toBe('APPROVED');
    expect(mapProviderStatus('paid')).toBe('PAID');
    expect(mapProviderStatus('some_vendor_specific_state')).toBe('UNKNOWN');
    expect(mapProviderStatus('')).toBe('UNKNOWN');

    const submitted = mapProviderStatusToRevision({
      providerSubmissionId: 'sub:1',
      status: 'SUBMITTED',
      observedAt: '2026-10-04T05:10:00.000Z',
      rawStatusText: 'submitted',
    });
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.sourceLevel).toBe('PROVIDER_VERIFIED');
    expect(submitted.derivesRecoveredCash).toBe(false);
    expect(submitted.derivesFee).toBe(false);

    const approved = mapProviderStatusToRevision({
      providerSubmissionId: 'sub:1',
      status: 'APPROVED',
      observedAt: '2026-10-04T05:20:00.000Z',
      rawStatusText: 'approved',
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.status).not.toBe('PAID');
  });

  it('provider 报告的退款金额不得直接成为已追回现金 / 计费依据', () => {
    const refund = mapProviderRefundStatusToRevision({
      providerSubmissionId: 'sub:1',
      refundStatus: 'REFUNDED',
      refundedAmount: '18620.00',
      currency: 'USD',
      observedAt: '2026-10-04T06:00:00.000Z',
    });
    expect(refund.sourceLevel).toBe('PROVIDER_VERIFIED');
    expect(refund.derivesRecoveredCash).toBe(false);
    expect(refund.derivesFee).toBe(false);
    expect(refund.refundedAmount).toBe('18620.00');
  });
});
