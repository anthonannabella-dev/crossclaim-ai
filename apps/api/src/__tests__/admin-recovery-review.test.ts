// MSG-20260929-37 验收（离线）：既有状态映射、projection flag、常量阈值、无审批捷径、金额禁键。

import { describe, expect, it } from 'vitest';

import {
  AGED_THRESHOLD_DAYS,
  APPROVAL_FORBIDDEN_PATTERNS,
  FORBIDDEN_AMOUNT_KEYS,
  RECOVERY_REVIEW_BUCKETS,
  RECOVERY_REVIEW_FLAGS,
  bucketForReviewAudit,
  flagsForReview,
} from '../services/operations/admin-recovery-review';
import { canAccessAdminModule, adminVisibilityFor } from '../services/operations/admin-console';

const NOW = new Date('2026-09-29T10:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe('MSG-37 · D1 状态来自既有审核记录（Admin 不推导）', () => {
  it('01 映射：required → pending_review；approved → approved；rejected（较新）优先', () => {
    expect(bucketForReviewAudit({ requiredAt: daysAgo(1), approvedAt: null, rejectedAt: null })).toBe('pending_review');
    expect(bucketForReviewAudit({ requiredAt: daysAgo(3), approvedAt: daysAgo(2), rejectedAt: null })).toBe('approved');
    expect(
      bucketForReviewAudit({ requiredAt: daysAgo(3), approvedAt: daysAgo(2), rejectedAt: daysAgo(1) }),
    ).toBe('rejected');
    expect(bucketForReviewAudit({ requiredAt: daysAgo(3), approvedAt: null, rejectedAt: daysAgo(2) })).toBe('rejected');
  });

  it('02 无任何审核记录 → null（不在队列中，绝不推断为待审）', () => {
    expect(bucketForReviewAudit({ requiredAt: null, approvedAt: null, rejectedAt: null })).toBeNull();
  });

  it('03 桶集合固定为三个（不新增运营状态）', () => {
    expect([...RECOVERY_REVIEW_BUCKETS]).toEqual(['pending_review', 'approved', 'rejected']);
  });
});

describe('MSG-37 · D1/D5 角标是 projection flag，AGED 为常量', () => {
  it('04 待审 → HIGH_VALUE_REVIEW_REQUIRED（事实标签，不含金额与阈值数字）', () => {
    const flags = flagsForReview({ bucket: 'pending_review', requiredAt: daysAgo(1), evidenceRefCount: 2, now: NOW });
    expect(flags).toEqual(['HIGH_VALUE_REVIEW_REQUIRED']);
    expect(JSON.stringify(flags)).not.toContain('1000');
    expect(JSON.stringify(flags)).not.toContain('$');
  });

  it('05 AGED 阈值 = 常量 7 天（恰好在阈值日即为 AGED）', () => {
    expect(AGED_THRESHOLD_DAYS).toBe(7);
    expect(flagsForReview({ bucket: 'pending_review', requiredAt: daysAgo(7), evidenceRefCount: 1, now: NOW })).toContain('AGED');
    expect(flagsForReview({ bucket: 'pending_review', requiredAt: daysAgo(6), evidenceRefCount: 1, now: NOW })).not.toContain('AGED');
  });

  it('06 无证据引用 → MISSING_EVIDENCE_REF；已决案件不再带 HIGH_VALUE 角标', () => {
    expect(flagsForReview({ bucket: 'pending_review', requiredAt: daysAgo(1), evidenceRefCount: 0, now: NOW })).toEqual([
      'HIGH_VALUE_REVIEW_REQUIRED',
      'MISSING_EVIDENCE_REF',
    ]);
    expect(flagsForReview({ bucket: 'approved', requiredAt: daysAgo(2), evidenceRefCount: 1, now: NOW })).toEqual([]);
  });

  it('07 角标集合固定为三个', () => {
    expect([...RECOVERY_REVIEW_FLAGS]).toEqual(['HIGH_VALUE_REVIEW_REQUIRED', 'AGED', 'MISSING_EVIDENCE_REF']);
  });
});

describe('MSG-37 · D3 无审批捷径（硬约束）', () => {
  it('08 模块不导出任何审批/状态变更函数', async () => {
    const module = await import('../services/operations/admin-recovery-review');
    const exported = Object.keys(module);
    for (const pattern of APPROVAL_FORBIDDEN_PATTERNS) {
      const offenders = exported.filter((name) => name.toLowerCase().includes(pattern));
      expect(offenders, `${pattern}: ${offenders.join(',')}`).toEqual([]);
    }
  });

  it('09 导出面只包含读取与映射工具（白名单断言）', async () => {
    const module = await import('../services/operations/admin-recovery-review');
    const exported = Object.keys(module).sort();
    for (const name of exported) {
      expect(name).toMatch(/^(list|get|bucketFor|flagsFor|AGED_|RECOVERY_|REVIEW_|FORBIDDEN_|APPROVAL_|Evidence)/);
    }
  });
});

describe('MSG-37 · D4 金额禁键与权限', () => {
  it('10 金额/阈值禁键清单包含 threshold 与 recoveredAmount', () => {
    expect([...FORBIDDEN_AMOUNT_KEYS]).toEqual(
      expect.arrayContaining(['amount', 'currency', 'recoveredAmount', 'settlementAmount', 'payoutAmount', 'threshold']),
    );
  });

  it('11 A5 仅 OWNER/ADMIN 可见；OPS/FINANCE/VIEWER fail-closed', () => {
    expect(canAccessAdminModule('OWNER', 'recoveryReview')).toBe(true);
    expect(canAccessAdminModule('ADMIN', 'recoveryReview')).toBe(true);
    for (const role of ['OPS', 'FINANCE', 'VIEWER', '']) {
      expect(canAccessAdminModule(role, 'recoveryReview'), role).toBe(false);
    }
    expect(adminVisibilityFor('OPS').recoveryReview).toBe(false);
  });
});
