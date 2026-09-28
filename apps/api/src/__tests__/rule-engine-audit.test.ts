/**
 * C-0012 — Rule Engine Audit（单元）：分位、残差分类、漂移、只读报告口径。
 */

import { describe, expect, it } from 'vitest';

import {
  COMMERCIAL_CONCLUSION,
  DEFAULT_STALE_RULE_DAYS,
  REVIEW_ACTION,
  median,
  percentileAbs,
  renderRuleEngineAuditMarkdown,
  summarizeRuleEngineAudit,
} from '../services/audit/rule-engine-audit';

const NOW = new Date('2026-09-28T18:00:00Z');

const item = (id: string, amount: string | null, extra: Partial<{ platformType: string; claimType: string; ruleVersionId: string | null }> = {}) => ({
  id,
  platformType: extra.platformType ?? 'AMAZON',
  claimType: extra.claimType ?? 'FBA_LOSS',
  ruleVersionId: extra.ruleVersionId ?? null,
  recoverableAmount: amount,
});

const review = (
  id: string,
  claimItemId: string,
  ruleAmount: string,
  toAmount: string,
  createdAt: Date,
) => ({ id, claimItemId, ruleAmount, toAmount, decision: toAmount === ruleAmount ? ('CONFIRMED' as const) : ('ADJUSTED' as const), createdAt });

describe('C-0012 — 统计工具', () => {
  it('median 与 p90Abs 对样例数字精确', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentileAbs([], 90)).toBeNull();
    expect(percentileAbs([10, -20, 30, -40, 50], 90)).toBe(50);
  });

  it('常量与架构方口径一致', () => {
    expect(DEFAULT_STALE_RULE_DAYS).toBe(180);
    expect(REVIEW_ACTION).toBe('claim.recoverable_amount_reviewed');
    expect(COMMERCIAL_CONCLUSION).toBe('OPEN');
  });
});

describe('C-0012 — 聚合', () => {
  it('残差分三类；未复核数据不进分位', () => {
    const audit = summarizeRuleEngineAudit({
      organizationId: 'org-1',
      claimItems: [
        item('c1', '100.0000'),
        item('c2', '200.0000'),
        item('c3', '300.0000'),
        item('c4', null), // 没有规则金额：不算覆盖率，也不进残差
      ],
      reviews: [
        review('r1', 'c1', '100.0000', '100.0000', new Date(NOW.getTime() - 3000)),
        review('r2', 'c2', '200.0000', '150.0000', new Date(NOW.getTime() - 2000)),
        review('r3', 'c3', '300.0000', '250.0000', new Date(NOW.getTime() - 1000)),
      ],
      staleRuleCount: 2,
      now: () => NOW,
    });

    expect(audit.coverage).toEqual({ claimItems: 4, withRecoverableAmount: 3, coverageRate: 0.75 });
    expect(audit.residuals.classification).toEqual({
      NO_HUMAN_REVIEW: 0,
      CONFIRMED: 1,
      ADJUSTED: 2,
    });
    expect(audit.residuals.adjusted).toMatchObject({ count: 2, median: -50, p90Abs: 50, absSum: 100 });
    expect(audit.freshness).toEqual({ staleRuleCount: 2, thresholdDays: 180 });
    expect(audit.commercialConclusion).toBe('OPEN');
  });

  it('未复核的记入 NO_HUMAN_REVIEW；多次复核取最新一条（createdAt DESC, id DESC）', () => {
    const sameTimestamp = new Date(NOW.getTime() - 1000);
    const audit = summarizeRuleEngineAudit({
      organizationId: 'org-1',
      claimItems: [item('c1', '100.0000'), item('c2', '100.0000')],
      reviews: [
        review('r1', 'c1', '100.0000', '80.0000', sameTimestamp),
        review('r2', 'c1', '100.0000', '100.0000', sameTimestamp), // 同一毫秒、id 更大 → 生效
      ],
      staleRuleCount: 0,
      now: () => NOW,
    });
    expect(audit.residuals.classification).toEqual({ NO_HUMAN_REVIEW: 1, CONFIRMED: 1, ADJUSTED: 0 });
    expect(audit.residuals.adjusted.count).toBe(0);
  });

  it('版本漂移只读真实历史：同类事件出现两个不同金额才报告', () => {
    const audit = summarizeRuleEngineAudit({
      organizationId: 'org-1',
      claimItems: [
        item('c1', '100.0000', { ruleVersionId: 'rv-1' }),
        item('c2', '80.0000', { ruleVersionId: 'rv-2' }),
        item('c3', '100.0000', { ruleVersionId: 'rv-1' }),
        item('c4', '50.0000', { claimType: 'OTIF_PENALTY', ruleVersionId: 'rv-9' }),
      ],
      reviews: [],
      staleRuleCount: 0,
      now: () => NOW,
    });
    expect(audit.drift.changedPairs).toHaveLength(1);
    expect(audit.drift.changedPairs[0]).toMatchObject({
      claimType: 'FBA_LOSS',
      fromAmount: '100.0000',
      toAmount: '80.0000',
    });
  });

  it('报告带三层状态、只提示 stale，且不出现商业结论词', () => {
    const audit = summarizeRuleEngineAudit({
      organizationId: 'org-1',
      claimItems: [item('c1', '100.0000')],
      reviews: [],
      staleRuleCount: 3,
      now: () => NOW,
    });
    const md = renderRuleEngineAuditMarkdown(audit);
    expect(md).toContain('engineeringStatus   : PASS');
    expect(md).toContain('auditRunStatus      : RUN_RECORDED');
    expect(md).toContain('commercialConclusion: OPEN');
    expect(md).toContain('staleRuleCount=3');
    expect(md).toContain('阈值 180 天');
    for (const forbidden of ['VIABLE', 'PROFITABLE', 'GO', 'expired', 'invalid']) {
      expect(md).not.toContain(forbidden);
    }
  });
});
