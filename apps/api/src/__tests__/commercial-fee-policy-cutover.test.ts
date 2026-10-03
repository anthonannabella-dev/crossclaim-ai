/**
 * COMMERCIAL 20% → 15% VERSIONED CUTOVER 验收（MSG-20261003-124 ㉖–㉛㊱）。
 * 断言：历史 20% 条款在其有效窗口内仍解析为 20%；cutover 之后解析为 15%；
 *       同一 family 任一时点恰好一条策略（无歧义）；旧策略不被重写。
 */

import { describe, expect, it } from 'vitest';

import {
  FEE_POLICY_REGISTRY,
  FeePolicyNotEffectiveError,
  evaluateFeeGuard,
  resolveFeePolicy,
  resolveFeePolicyByRef,
} from '../services/commercial/fee-policy';

const BEFORE_CUTOVER = '2026-09-15';
const CUTOVER = '2026-10-01';
const AFTER_CUTOVER = '2026-10-03';

describe('COMMERCIAL 20% → 15% versioned cutover', () => {
  it('注册表同时保留历史 20% 与当前 15%（同一 family 两个版本）', () => {
    const standard = FEE_POLICY_REGISTRY.filter((p) => p.policyRef === 'STANDARD_SUCCESS');
    expect(standard).toHaveLength(2);
    const old = standard.find((p) => p.rateBps === 2000);
    const current = standard.find((p) => p.rateBps === 1500);
    expect(old).toBeDefined();
    expect(current).toBeDefined();
    expect(old?.effectiveTo).toBe('2026-09-30');
    expect(current?.effectiveFrom).toBe('2026-10-01');
  });

  it('按 family + 时点解析：cutover 前 = 20%，cutover 后 = 15%', () => {
    expect(resolveFeePolicyByRef('STANDARD_SUCCESS', BEFORE_CUTOVER).rateBps).toBe(2000);
    expect(resolveFeePolicyByRef('STANDARD_SUCCESS', CUTOVER).rateBps).toBe(1500);
    expect(resolveFeePolicyByRef('STANDARD_SUCCESS', AFTER_CUTOVER).rateBps).toBe(1500);
    expect(resolveFeePolicyByRef('CUSTOMS_SUCCESS', BEFORE_CUTOVER).rateBps).toBe(2000);
    expect(resolveFeePolicyByRef('CUSTOMS_SUCCESS', AFTER_CUTOVER).rateBps).toBe(1500);
  });

  it('family 任一时点恰好命中一条（无歧义窗口）', () => {
    for (const at of ['2026-01-01', '2026-09-30', '2026-10-01', '2026-12-31']) {
      expect(() => resolveFeePolicyByRef('STANDARD_SUCCESS', at)).not.toThrow();
    }
    expect(() => resolveFeePolicyByRef('STANDARD_SUCCESS', '2025-12-31')).toThrow(FeePolicyNotEffectiveError);
  });

  it('历史 20% policyId 仍可按 id 解析（其有效窗口内），窗口外 fail-closed', () => {
    const old = resolveFeePolicy('STANDARD_SUCCESS_20', BEFORE_CUTOVER);
    expect(old.rateBps).toBe(2000);
    expect(() => resolveFeePolicy('STANDARD_SUCCESS_20', AFTER_CUTOVER)).toThrow(FeePolicyNotEffectiveError);
  });

  it('㊱ 历史绑定的 20% 条款：其窗口内 fee due 仍按 20% 计算（不被 15% 回写）', () => {
    const historicalPolicy = resolveFeePolicy('STANDARD_SUCCESS_20', BEFORE_CUTOVER);
    const decision = evaluateFeeGuard({
      policy: historicalPolicy,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: { settlementId: 'stl-old', verifiedAmount: '100.00', currency: 'USD', confirmationStatus: 'CONFIRMED', reconciliationStatus: 'RECONCILED' },
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.fee.feeAmount).toBe('20.00');
    expect(decision.fee.rateBps).toBe(2000);
  });

  it('㊱ cutover 之后的新条款：15%', () => {
    const currentPolicy = resolveFeePolicy('STANDARD_SUCCESS_15', AFTER_CUTOVER);
    const decision = evaluateFeeGuard({
      policy: currentPolicy,
      basis: 'VERIFIED_ACTUAL_INCREMENTAL_RECOVERED',
      verifiedRecovered: { settlementId: 'stl-new', verifiedAmount: '100.00', currency: 'USD', confirmationStatus: 'CONFIRMED', reconciliationStatus: 'RECONCILED' },
    });
    if (!decision.allowed) throw new Error('expected allowed');
    expect(decision.fee.feeAmount).toBe('15.00');
    expect(decision.fee.rateBps).toBe(1500);
  });

  it('历史策略对象不可被就地改写（cutover 不迁移历史费率）', () => {
    const before = resolveFeePolicy('STANDARD_SUCCESS_20', BEFORE_CUTOVER);
    const after = resolveFeePolicy('STANDARD_SUCCESS_20', BEFORE_CUTOVER);
    expect(after).toEqual(before);
    expect(before.rateBps).toBe(2000);
    expect(before.effectiveTo).toBe('2026-09-30');
  });
});
