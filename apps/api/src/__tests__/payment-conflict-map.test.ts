/**
 * MSG-20260930-34 CHANGE A 验收：**严格结构化白名单**
 *   正例：两种已识别字段组合（顺序可互换）、已取证的完整约束名
 *   反例：缺 target、仅单字段、三字段、重复字段、混入非字符串、未知约束名、非唯一约束错误 → 一律 null
 */
import { describe, expect, it } from 'vitest';

import { mapKnownPaymentUniqueConflict } from '../services/workflow/payment-conflict-map';

describe('支付域唯一约束严格白名单映射', () => {
  it('已知组合：organizationId + paymentId（两种顺序）→ PAYMENT_SOURCE_CONFLICT', () => {
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['organizationId', 'paymentId'] } })?.code,
    ).toBe('PAYMENT_SOURCE_CONFLICT');
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['paymentId', 'organizationId'] } })?.code,
    ).toBe('PAYMENT_SOURCE_CONFLICT');
  });

  it('已知组合：organizationId + paymentEventId（两种顺序）→ ATTEMPT_ALREADY_RUNNING', () => {
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['organizationId', 'paymentEventId'] } })?.code,
    ).toBe('ATTEMPT_ALREADY_RUNNING');
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['paymentEventId', 'organizationId'] } })?.code,
    ).toBe('ATTEMPT_ALREADY_RUNNING');
  });

  it('已取证的完整约束名（meta.target 精确相等）→ PAYMENT_SOURCE_CONFLICT', () => {
    expect(
      mapKnownPaymentUniqueConflict({
        code: 'P2002',
        meta: { target: 'PaymentProcessingAttempt_succeeded_payment_key' },
      })?.code,
    ).toBe('PAYMENT_SOURCE_CONFLICT');
  });

  it('反例：无 target 但消息含约束名 → null（不做消息猜测）', () => {
    expect(
      mapKnownPaymentUniqueConflict({
        code: 'P2002',
        message: 'PaymentProcessingAttempt_succeeded_payment_key',
      }),
    ).toBeNull();
  });

  it('反例：仅 paymentEventId + 消息含 attempt → null（缺少 organizationId）', () => {
    expect(
      mapKnownPaymentUniqueConflict({
        code: 'P2002',
        meta: { target: ['paymentEventId'] },
        message: 'attempt conflict',
      }),
    ).toBeNull();
  });

  it('反例：三字段 / 未知字段组合 → null', () => {
    expect(
      mapKnownPaymentUniqueConflict({
        code: 'P2002',
        meta: { target: ['organizationId', 'paymentId', 'unknownField'] },
      }),
    ).toBeNull();
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['organizationId', 'auditId'] } }),
    ).toBeNull();
  });

  it('反例：重复字段 / 混入非字符串 / 空串 → null', () => {
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['paymentId', 'paymentId'] } }),
    ).toBeNull();
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['organizationId', 42] } }),
    ).toBeNull();
    expect(mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: ['organizationId', ''] } })).toBeNull();
  });

  it('反例：未知约束名 / 非唯一约束错误 → null', () => {
    expect(
      mapKnownPaymentUniqueConflict({ code: 'P2002', meta: { target: 'PaymentProcessingAttempt_running_key' } }),
    ).toBeNull();
    expect(mapKnownPaymentUniqueConflict({ code: 'P2025', meta: { target: ['organizationId', 'paymentId'] } })).toBeNull();
    expect(mapKnownPaymentUniqueConflict(new Error('boom'))).toBeNull();
  });
});
