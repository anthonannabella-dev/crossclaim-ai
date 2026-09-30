/**
 * MSG-20260930-33 CHANGE A 验收：**精确约束白名单映射**
 *   · 已知约束（成功来源 / 进行中 attempt）→ 稳定领域错误
 *   · 未知 P2002 / meta 不完整 / 非唯一约束错误 → 一律 null（调用方原样抛出）
 */
import { describe, expect, it } from 'vitest';

import { mapKnownPaymentUniqueConflict } from '../services/workflow/payment-conflict-map';

describe('支付域唯一约束白名单映射', () => {
  it('已知：成功 Payment 来源约束（按约束名）→ PAYMENT_SOURCE_CONFLICT', () => {
    const mapped = mapKnownPaymentUniqueConflict({
      code: 'P2002',
      message: 'Unique constraint failed on the constraint: `PaymentProcessingAttempt_succeeded_payment_key`',
      meta: { target: ['paymentId'] },
    });
    expect(mapped?.code).toBe('PAYMENT_SOURCE_CONFLICT');
  });

  it('已知：成功 Payment 来源约束（按 paymentId + organizationId 目标组合）→ PAYMENT_SOURCE_CONFLICT', () => {
    const mapped = mapKnownPaymentUniqueConflict({
      code: 'P2002',
      meta: { target: ['organizationId', 'paymentId'] },
    });
    expect(mapped?.code).toBe('PAYMENT_SOURCE_CONFLICT');
  });

  it('已知：同事件进行中 attempt（paymentEventId + organizationId）→ ATTEMPT_ALREADY_RUNNING', () => {
    const mapped = mapKnownPaymentUniqueConflict({
      code: 'P2002',
      meta: { target: ['organizationId', 'paymentEventId'] },
    });
    expect(mapped?.code).toBe('ATTEMPT_ALREADY_RUNNING');
  });

  it('未知 P2002（未知目标组合）→ null（原样抛出）', () => {
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['organizationId', 'auditId'] } }),
    ).toBeNull();
  });

  it('P2002 但 meta 不完整（无 target）→ null（原样抛出）', () => {
    expect(mapKnownPaymentUniqueConflict({ code: 'P2002' })).toBeNull();
    expect(mapKnownPaymentUniqueConflict({ code: 'P2002', meta: {} })).toBeNull();
  });

  it('非唯一约束错误（P2025 / 普通异常）→ null（原样抛出）', () => {
    expect(mapKnownPaymentUniqueConflict({ code: 'P2025', message: 'Record not found' })).toBeNull();
    expect(mapKnownPaymentUniqueConflict(new Error('boom'))).toBeNull();
  });
});
