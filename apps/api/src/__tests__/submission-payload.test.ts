/**
 * MSG-20260929-17 Q2 验收：提交载荷构造器 + 干跑校验器（离线、无网络、无凭据）
 */

import { describe, expect, it } from 'vitest';

import {
  SUBMISSION_TRANSPORT_ENABLED,
  buildSubmissionPayload,
  describeManualGate,
  validateSubmissionDryRun,
  type SubmissionInput,
} from '../services/submission/payload';

const FIXED_NOW = () => new Date('2026-09-29T08:00:00Z');

function input(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    platform: 'AMAZON',
    claimType: 'FBA_REIMBURSEMENT',
    orderRef: '112-0000000-0000001',
    trackingNo: '1Z999',
    amount: '120.5000',
    currency: 'USD',
    appealText: 'Reimbursement request for lost inventory per FBA policy.',
    evidenceRefs: ['pod-2026-09-01.pdf'],
    ...overrides,
  };
}

describe('MSG-17 Q2 · Submission Payload Builder + Dry Run Validator', () => {
  it('01 Amazon 载荷构造 → 干跑 DRY_RUN_OK，且标记 dryRunOnly', () => {
    const payload = buildSubmissionPayload(input(), { now: FIXED_NOW });
    expect(payload.platform).toBe('AMAZON');
    expect(payload.meta.dryRunOnly).toBe(true);
    expect(payload.body.case_category).toBe('SELLER_FULFILLMENT');
    const result = validateSubmissionDryRun(payload);
    expect(result.status).toBe('DRY_RUN_OK');
    expect(result.blockers).toEqual([]);
  });

  it('02 TikTok / Walmart 使用各自 dispute_reason', () => {
    const tiktok = buildSubmissionPayload(input({ platform: 'TIKTOK' }), { now: FIXED_NOW });
    const walmart = buildSubmissionPayload(input({ platform: 'WALMART' }), { now: FIXED_NOW });
    expect(tiktok.body.dispute_reason).toBe('SHIPMENT_NOT_RECEIVED');
    expect(walmart.body.dispute_reason).toBe('WAREHOUSE_LOSS');
  });

  it('03 无证据引用 → DRY_RUN_BLOCKED(EVIDENCE_PRESENT)', () => {
    const payload = buildSubmissionPayload(input({ evidenceRefs: [] }), { now: FIXED_NOW });
    const result = validateSubmissionDryRun(payload);
    expect(result.status).toBe('DRY_RUN_BLOCKED');
    expect(result.blockers).toContain('EVIDENCE_PRESENT');
  });

  it('04 空申诉正文 → BLOCKED(APPEAL_TEXT_PRESENT / LENGTH)', () => {
    const payload = buildSubmissionPayload(input({ appealText: '   ' }), { now: FIXED_NOW });
    const result = validateSubmissionDryRun(payload);
    expect(result.blockers).toContain('APPEAL_TEXT_PRESENT');
    expect(result.blockers).toContain('APPEAL_TEXT_LENGTH');
  });

  it('05 自由文本含邮箱 / 电话 → BLOCKED（必须先掩码）', () => {
    const withEmail = buildSubmissionPayload(input({ appealText: 'Contact buyer at a@b.com' }), {
      now: FIXED_NOW,
    });
    expect(validateSubmissionDryRun(withEmail).blockers).toContain('APPEAL_TEXT_FREE_TEXT_CLEAN');
    const withPhone = buildSubmissionPayload(input({ appealText: 'Call +1 555 123 4567 now' }), {
      now: FIXED_NOW,
    });
    expect(validateSubmissionDryRun(withPhone).blockers).toContain('APPEAL_TEXT_FREE_TEXT_CLEAN');
  });

  it('06 金额格式非法 / 超过 4 位小数 → BLOCKED', () => {
    expect(
      validateSubmissionDryRun(buildSubmissionPayload(input({ amount: '1.23456' }), { now: FIXED_NOW }))
        .blockers,
    ).toContain('AMOUNT_FORMAT');
    expect(
      validateSubmissionDryRun(buildSubmissionPayload(input({ amount: 'abc' }), { now: FIXED_NOW }))
        .blockers,
    ).toContain('AMOUNT_FORMAT');
  });

  it('07 币种非法 → BLOCKED(CURRENCY_FORMAT)', () => {
    const payload = buildSubmissionPayload(input({ currency: 'usd' }), { now: FIXED_NOW });
    expect(validateSubmissionDryRun(payload).blockers).toContain('CURRENCY_FORMAT');
  });

  it('08 凭据类字段名 / token 形态值 → BLOCKED', () => {
    const payload = buildSubmissionPayload(input(), { now: FIXED_NOW });
    payload.body.apiKey = 'should-not-be-here';
    expect(validateSubmissionDryRun(payload).blockers).toContain('NO_SECRET_KEYS');

    const payload2 = buildSubmissionPayload(input(), { now: FIXED_NOW });
    payload2.body.note = 'Authorization: Bearer abcdefghijklmnop123456';
    expect(validateSubmissionDryRun(payload2).blockers).toContain('NO_SECRET_VALUES');
  });

  it('09 高额（> $1000）→ 干跑仍 OK，但强制人工与 OWNER 复核', () => {
    const payload = buildSubmissionPayload(input({ amount: '1500.0000' }), { now: FIXED_NOW });
    expect(validateSubmissionDryRun(payload).status).toBe('DRY_RUN_OK');
    expect(payload.meta.requiresHumanReview).toBe(true);
    expect(describeManualGate(payload)).toMatchObject({
      supportsClaimSubmission: false,
      requiresManualApproval: true,
      requiresOwnerApproval: true,
    });
  });

  it('10 传输开关恒为 false，且闸门强制人工', () => {
    const payload = buildSubmissionPayload(input(), { now: FIXED_NOW });
    expect(SUBMISSION_TRANSPORT_ENABLED).toBe(false);
    expect(describeManualGate(payload).supportsClaimSubmission).toBe(false);
  });

  it('11 同输入两次 → 载荷指纹一致（除 builtAt）', () => {
    const a = buildSubmissionPayload(input(), { now: FIXED_NOW });
    const b = buildSubmissionPayload(input(), { now: FIXED_NOW });
    expect(a.meta.payloadSha256).toBe(b.meta.payloadSha256);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  it('12 载荷不含任何凭据字段，且校验结果可复核', () => {
    const payload = buildSubmissionPayload(input(), { now: FIXED_NOW });
    const result = validateSubmissionDryRun(payload);
    expect(result.checks.every((check) => check.detail.trim() !== '')).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/api[_-]?key|secret|bearer/i);
  });
});
