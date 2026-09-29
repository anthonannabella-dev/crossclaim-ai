// MSG-20260929-30 验收（离线部分）：运营看板投影、窗口约束、桶谓词、权限裁剪。
// 纯离线：不触库、不写任何状态、不发对外请求。

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  CLAIM_BUCKETS,
  composeClaimBuckets,
  composeDashboard,
  composeLossPool,
  composeRecoveryMetrics,
  dashboardVisibilityFor,
  parseDashboardWindow,
  projectClaimRow,
  type ClaimProjectionRow,
} from '../services/operations/dashboard-projection';
import { WorkflowError } from '../services/workflow/opportunity-review';

const NOW = new Date('2026-09-29T09:00:00Z');
const window7d = parseDashboardWindow(undefined, NOW);

const claim = (overrides: Partial<ClaimProjectionRow> = {}): ClaimProjectionRow => ({
  id: 'c-1',
  caseId: 'case-1',
  status: 'SUBMITTED',
  dueAt: null,
  deadlineSource: null,
  respondedAt: null,
  platformCaseRef: null,
  updatedAt: NOW,
  hasResponseEvent: false,
  caseHasCommercialTerms: true,
  ...overrides,
});

describe('MSG-30 · D3 窗口约束', () => {
  it('01 缺省 = 7d', () => {
    expect(window7d.label).toBe('7d');
    expect(window7d.days).toBe(7);
    expect(window7d.horizonEnd.toISOString()).toBe('2026-10-06T09:00:00.000Z');
  });

  it('02 白名单 1d / 14d / 30d 通过', () => {
    for (const label of ['1d', '14d', '30d']) {
      expect(parseDashboardWindow(label, NOW).days, label).toBe(Number(label.slice(0, -1)));
    }
  });

  it('03 31d / 3650 / abc 一律拒绝（INVALID_WINDOW）', () => {
    for (const bad of ['31d', '3650', 'abc', '7']) {
      try {
        parseDashboardWindow(bad, NOW);
        throw new Error('should have thrown: ' + bad);
      } catch (error) {
        expect((error as WorkflowError).code, bad).toBe('INVALID_WINDOW');
      }
    }
  });
});

describe('MSG-30 · D1 待回执判定（不看 dueAt）', () => {
  it('04 SUBMITTED + dueAt 非空 + 无回执 → 仍属待回执（且同时进入到期临近）', () => {
    const projection = projectClaimRow(
      claim({ dueAt: new Date('2026-10-03T00:00:00Z'), deadlineSource: 'PLATFORM_NOTICE' }),
      window7d,
    );
    expect(projection.buckets).toContain('awaiting_response');
    expect(projection.buckets).toContain('deadline_approaching');
    expect(projection.buckets).not.toContain('overdue');
  });

  it('05 有 respondedAt → 不再属于待回执', () => {
    const projection = projectClaimRow(claim({ respondedAt: NOW }), window7d);
    expect(projection.buckets).not.toContain('awaiting_response');
  });

  it('06 仅有 AuditLog 事件（respondedAt 为空）→ 视为有回执，但必须标注异常', () => {
    const projection = projectClaimRow(claim({ hasResponseEvent: true }), window7d);
    expect(projection.buckets).not.toContain('awaiting_response');
    expect(projection.anomalies).toContain('RESPONSE_EVENT_WITHOUT_TIMESTAMP');
  });

  it('07 已逾期（dueAt < now）进入 overdue，且不进入到期临近', () => {
    const projection = projectClaimRow(
      claim({ dueAt: new Date('2026-09-20T00:00:00Z'), deadlineSource: 'CONTRACT' }),
      window7d,
    );
    expect(projection.buckets).toContain('overdue');
    expect(projection.buckets).not.toContain('deadline_approaching');
  });
});

describe('MSG-30 · 桶与异常角标', () => {
  it('08 DRAFT 只在已完成商务确认的案件上计数', () => {
    const withTerms = projectClaimRow(claim({ status: 'DRAFT', caseHasCommercialTerms: true }), window7d);
    const withoutTerms = projectClaimRow(claim({ status: 'DRAFT', caseHasCommercialTerms: false }), window7d);
    expect(withTerms.buckets).toContain('draft');
    expect(withoutTerms.buckets).not.toContain('draft');
  });

  it('09 dueAt 无来源 → DEADLINE_WITHOUT_SOURCE 异常（不隐藏）', () => {
    const projection = projectClaimRow(claim({ dueAt: NOW, deadlineSource: null }), window7d);
    expect(projection.anomalies).toContain('DEADLINE_WITHOUT_SOURCE');
  });

  it('10 终局态只进 terminal 桶', () => {
    const projection = projectClaimRow(claim({ status: 'REJECTED', respondedAt: NOW }), window7d);
    expect(projection.buckets).toEqual(['terminal']);
  });

  it('11 汇总：七个桶齐全，异常行数单独统计', () => {
    const summary = composeClaimBuckets(
      [
        claim({ id: 'a', status: 'DRAFT' }),
        claim({ id: 'b', status: 'SUBMITTED' }),
        claim({ id: 'c', status: 'APPROVED', respondedAt: NOW }),
        claim({ id: 'd', status: 'REJECTED', respondedAt: NOW }),
        claim({ id: 'e', status: 'SUBMITTED', dueAt: NOW, deadlineSource: null }),
      ],
      window7d,
    );
    expect(summary.buckets.map((row) => row.bucket)).toEqual([...CLAIM_BUCKETS]);
    expect(summary.buckets.find((row) => row.bucket === 'draft')?.count).toBe(1);
    expect(summary.buckets.find((row) => row.bucket === 'approved')?.count).toBe(1);
    expect(summary.buckets.find((row) => row.bucket === 'terminal')?.count).toBe(1);
    expect(summary.anomalyTotal).toBe(1);
  });
});

describe('MSG-30 · Loss Pool', () => {
  it('12 分组映射（含 VERIFIED → ready_to_appeal）', () => {
    const pool = composeLossPool(['DISCOVERED', 'VERIFIED', 'REVIEW_REQUIRED', 'RECOVERED', 'CLOSED', 'UNKNOWN']);
    const byGroup = Object.fromEntries(pool.map((row) => [row.group, row.count]));
    expect(byGroup.pending_verification).toBe(1);
    expect(byGroup.ready_to_appeal).toBe(1);
    expect(byGroup.needs_review).toBe(1);
    expect(byGroup.recovered).toBe(1);
    expect(byGroup.closed).toBe(1);
    expect(pool.reduce((sum, row) => sum + row.count, 0)).toBe(5);
  });
});

describe('MSG-30 · Recovery 汇总与金额裁剪（不得被聚合绕过）', () => {
  const rows = [
    { confirmationStatus: 'CONFIRMED', reconciliationStatus: 'RECONCILED', amount: '100.0000', receivedAmount: '100.0000' },
    { confirmationStatus: 'CONFIRMED', reconciliationStatus: 'PARTIAL', amount: '50.0000', receivedAmount: '20.0000' },
    { confirmationStatus: 'PENDING_CONFIRMATION', reconciliationStatus: 'NOT_STARTED', amount: '30.0000', receivedAmount: '0.0000' },
    { confirmationStatus: 'CONFIRMED', reconciliationStatus: 'DISPUTED', amount: '10.0000', receivedAmount: '12.0000' },
  ];

  it('13 计数与状态分布', () => {
    const metrics = composeRecoveryMetrics(rows, true);
    expect(metrics.confirmation).toEqual({ confirmed: 3, pending: 1, rejectedByReview: 0 });
    expect(metrics.reconciliation.reconciled).toBe(1);
    expect(metrics.reconciliation.partial).toBe(1);
    expect(metrics.reconciliation.disputed).toBe(1);
    expect(metrics.reconciliation.notStarted).toBe(1);
  });

  it('14 金额投影：confirmed = Settlement.amount、received = Σ payouts、outstanding 只累加正缺口', () => {
    const metrics = composeRecoveryMetrics(rows, true);
    expect(metrics.amounts?.confirmedTotal).toBe('160.0000');
    expect(metrics.amounts?.receivedTotal).toBe('132.0000');
    expect(metrics.amounts?.outstandingTotal).toBe('30.0000');
    expect(metrics.amounts?.varianceTotal).toBe('-28.0000');
  });

  it('15 无金额权限：响应中根本不存在 amounts 键（不是 0）', () => {
    const metrics = composeRecoveryMetrics(rows, false);
    expect(metrics).not.toHaveProperty('amounts');
    expect(Object.keys(metrics)).toEqual(['confirmation', 'reconciliation']);
    // 计数无法反推金额：即使有 count，也无任何金额字段可推导
    expect(JSON.stringify(metrics)).not.toContain('160');
  });
});

describe('MSG-30 · 角色可见性与整卷装配', () => {
  it('16 VIEWER 三块全不可见（fail-closed）', () => {
    const visibility = dashboardVisibilityFor('VIEWER');
    expect(Object.values(visibility).every((value) => value === false)).toBe(true);
  });

  it('17 FINANCE：Recovery 金额可见、Claim 金额/文本不可见', () => {
    const visibility = dashboardVisibilityFor('FINANCE');
    expect(visibility.recoveryCounts).toBe(false); // 计数需 claimTrackingApprove；FINANCE 无
    expect(visibility.recoveryAmounts).toBe(true);
    expect(visibility.claimAmounts).toBe(false);
    expect(visibility.claimText).toBe(false);
  });

  it('18 OWNER：全部可见', () => {
    const visibility = dashboardVisibilityFor('OWNER');
    expect(Object.values(visibility).every((value) => value === true)).toBe(true);
  });

  it('19 装配：denied 显式列出无权区块，且不出现在响应数据里', () => {
    const payload = composeDashboard({
      now: NOW,
      window: window7d,
      visibility: dashboardVisibilityFor('VIEWER'),
      claims: [claim()],
      claimItemStatuses: ['DISCOVERED'],
      settlements: [
        { confirmationStatus: 'CONFIRMED', reconciliationStatus: 'RECONCILED', amount: '100.0000', receivedAmount: '100.0000' },
      ],
    });
    expect(payload.claimPipeline).toBeNull();
    expect(payload.recovery).toBeNull();
    expect(payload.lossPool).toBeNull();
    expect(payload.denied).toEqual(['claimPipeline', 'recovery', 'lossPool']);
    expect(JSON.stringify(payload)).not.toContain('100.0000');
    expect(payload.window.label).toBe('7d');
  });

  it('20 金额精度：Decimal 输入按 4 位 HALF_UP 输出字符串', () => {
    const metrics = composeRecoveryMetrics(
      [
        {
          confirmationStatus: 'CONFIRMED',
          reconciliationStatus: 'PARTIAL',
          amount: new Prisma.Decimal('33.33335'),
          receivedAmount: new Prisma.Decimal('0.00005'),
        },
      ],
      true,
    );
    expect(metrics.amounts?.confirmedTotal).toBe('33.3334');
    expect(metrics.amounts?.receivedTotal).toBe('0.0001');
  });
});
