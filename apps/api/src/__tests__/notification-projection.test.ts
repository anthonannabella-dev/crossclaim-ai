// MSG-20260929-32 验收（离线部分）：事件目录、幂等键、收件人解析、权限裁剪、有限聚合（D4）。
// 纯离线：不触库、不投递、不发任何外部渠道。

import { describe, expect, it } from 'vitest';

import {
  EVENT_CATALOG,
  NOTIFICATION_EVENTS,
  canSeeAmounts,
  deriveNotifications,
  idempotencyKey,
  resolveRecipients,
  utcDayKey,
  type MembershipRef,
} from '../services/operations/notification-projection';

const NOW = new Date('2026-09-29T09:00:00Z');

const members: MembershipRef[] = [
  { userId: 'u-owner', role: 'OWNER' },
  { userId: 'u-admin', role: 'ADMIN' },
  { userId: 'u-ops', role: 'OPS' },
  { userId: 'u-finance', role: 'FINANCE' },
  { userId: 'u-viewer', role: 'VIEWER' },
];

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  status: 'SUBMITTED',
  dueAt: new Date('2026-10-02T00:00:00Z'),
  deadlineSource: 'PLATFORM_NOTICE',
  respondedAt: null,
  ...overrides,
});

const base = {
  now: NOW,
  windowDays: 7,
  memberships: members,
  settlements: [],
  auditEvents: [],
};

describe('MSG-32 · 事件目录（D1）', () => {
  it('01 N6 overdue 默认关闭；N1 允许聚合；N4 携带金额', () => {
    expect(EVENT_CATALOG['claim.overdue'].defaultEnabled).toBe(false);
    expect(EVENT_CATALOG['claim.deadline_approaching'].aggregation).toBe(true);
    expect(EVENT_CATALOG['recovery.payout_discrepancy'].amounts).toBe(true);
    expect(NOTIFICATION_EVENTS).toHaveLength(6);
  });

  it('02 默认启用的只有 N1–N5', () => {
    const derived = deriveNotifications({ ...base, claims: [] });
    expect(derived.notifications).toHaveLength(0);
    const enabled = NOTIFICATION_EVENTS.filter((id) => EVENT_CATALOG[id].defaultEnabled);
    expect(enabled).toEqual([
      'claim.deadline_approaching',
      'claim.response_received',
      'recovery.confirmation_required',
      'recovery.payout_discrepancy',
      'review.required_high_value',
    ]);
  });
});

describe('MSG-32 · 幂等键（D2/D3）', () => {
  it('03 事件型含 transition，状态型含 UTC 日期', () => {
    expect(idempotencyKey('claim.response_received', 'c-1', '2026-09-29T10:00:00.000Z')).toBe(
      'claim.response_received|c-1|2026-09-29T10:00:00.000Z',
    );
    expect(idempotencyKey('claim.deadline_approaching', 'c-1', utcDayKey(NOW))).toBe(
      'claim.deadline_approaching|c-1|2026-09-29',
    );
  });

  it('04 同一实体同一事件同一日只产生一条（进入即通知，不周期提醒）', () => {
    const first = deriveNotifications({ ...base, claims: [claim()] });
    const second = deriveNotifications({ ...base, claims: [claim()] });
    const keys = first.notifications.map((item) => item.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(second.notifications.map((item) => item.idempotencyKey)).toEqual(keys);
  });
});

describe('MSG-32 · 收件人解析与权限裁剪', () => {
  it('05 VIEWER 永不入选；OPS 只拿回执类；FINANCE 只拿金额类', () => {
    expect(resolveRecipients(members, 'claimTrackingApprove').map((m) => m.role)).toEqual(['OWNER', 'ADMIN']);
    expect(resolveRecipients(members, 'claimTrackingReceive').map((m) => m.role)).toEqual(['OWNER', 'ADMIN', 'OPS']);
    expect(resolveRecipients(members, 'recoveryPayoutRecord').map((m) => m.role)).toEqual([
      'OWNER',
      'ADMIN',
      'FINANCE',
    ]);
    expect(resolveRecipients([{ userId: 'u-viewer', role: 'VIEWER' }], 'claimTrackingReceive')).toHaveLength(0);
  });

  it('06 canSeeAmounts：OWNER/ADMIN/FINANCE 为真，OPS/VIEWER 为假', () => {
    expect(canSeeAmounts('OWNER')).toBe(true);
    expect(canSeeAmounts('FINANCE')).toBe(true);
    expect(canSeeAmounts('OPS')).toBe(false);
    expect(canSeeAmounts('VIEWER')).toBe(false);
    expect(canSeeAmounts('')).toBe(false);
  });

  it('07 N1 只发 OWNER/ADMIN，不含 OPS/FINANCE/VIEWER', () => {
    const derived = deriveNotifications({ ...base, claims: [claim()] });
    const notification = derived.notifications[0];
    expect(notification.audienceUserIds.sort()).toEqual(['u-admin', 'u-owner']);
  });

  it('08 N2 发 OWNER/ADMIN/OPS（回执权限）', () => {
    const derived = deriveNotifications({
      ...base,
      claims: [claim({ status: 'ACKNOWLEDGED', respondedAt: NOW })],
    });
    const notification = derived.notifications.find((item) => item.eventId === 'claim.response_received');
    expect(notification?.audienceUserIds.sort()).toEqual(['u-admin', 'u-ops', 'u-owner']);
  });
});

describe('MSG-32 · 事件派生', () => {
  it('09 N1：到期在窗口内才通知，过期/终局/已回执都不通知', () => {
    const derived = deriveNotifications({
      ...base,
      claims: [
        claim({ id: 'in-window' }),
        claim({ id: 'past', dueAt: new Date('2026-09-20T00:00:00Z') }),
        claim({ id: 'terminal', status: 'REJECTED' }),
        claim({ id: 'answered', respondedAt: NOW }),
        claim({ id: 'far', dueAt: new Date('2026-12-01T00:00:00Z') }),
      ],
    });
    const ids = derived.notifications
      .filter((item) => item.eventId === 'claim.deadline_approaching')
      .map((item) => item.entity.id);
    expect(ids).toContain('in-window');
    expect(ids).not.toContain('past');
    expect(ids).not.toContain('terminal');
    expect(ids).not.toContain('answered');
    expect(ids).not.toContain('far');
  });

  it('10 N2：respondedAt 落在窗口内才通知', () => {
    const inside = deriveNotifications({ ...base, claims: [claim({ respondedAt: NOW })] });
    expect(inside.notifications.some((item) => item.eventId === 'claim.response_received')).toBe(true);
    const outside = deriveNotifications({
      ...base,
      claims: [claim({ respondedAt: new Date('2026-08-01T00:00:00Z') })],
    });
    expect(outside.notifications.some((item) => item.eventId === 'claim.response_received')).toBe(false);
  });

  it('11 N3：PENDING_CONFIRMATION 才通知', () => {
    const derived = deriveNotifications({
      ...base,
      claims: [],
      settlements: [
        { id: 's-pending', confirmationStatus: 'PENDING_CONFIRMATION', reconciliationStatus: 'NOT_STARTED' },
        { id: 's-confirmed', confirmationStatus: 'CONFIRMED', reconciliationStatus: 'NOT_STARTED' },
      ],
    });
    const ids = derived.notifications.map((item) => item.entity.id);
    expect(ids).toContain('s-pending');
    expect(ids).not.toContain('s-confirmed');
  });

  it('12 N4：DISPUTED 通知带金额，且只有具备金额权限的收件人收到', () => {
    const derived = deriveNotifications({
      ...base,
      claims: [],
      settlements: [
        {
          id: 's-disputed',
          confirmationStatus: 'CONFIRMED',
          reconciliationStatus: 'DISPUTED',
          confirmedAmount: '100.0000',
          receivedAmount: '112.0000',
        },
      ],
    });
    const notification = derived.notifications.find((item) => item.eventId === 'recovery.payout_discrepancy');
    expect(notification?.visibility).toBe('WITH_AMOUNTS');
    expect(notification?.audienceUserIds.sort()).toEqual(['u-admin', 'u-finance', 'u-owner']);
    expect(notification?.amounts).toEqual({ confirmed: '100.0000', received: '112.0000', variance: '12.0000' });
  });

  it('13 N5：由既有复核审计动作触发', () => {
    const derived = deriveNotifications({
      ...base,
      claims: [],
      auditEvents: [
        {
          action: 'recovery.review_required',
          entityType: 'Case',
          entityId: 'case-1',
          createdAt: NOW,
        },
      ],
    });
    expect(derived.notifications.some((item) => item.eventId === 'review.required_high_value')).toBe(true);
  });
});

describe('MSG-32 · 有限聚合（D4）', () => {
  it('14 同事件同窗口多实体 → 一条聚合摘要，含总数与样本', () => {
    const claims = Array.from({ length: 8 }, (_, index) =>
      claim({ id: `c-${index + 1}`, dueAt: new Date(`2026-10-0${(index % 3) + 1}T00:00:00Z`) }),
    );
    const derived = deriveNotifications({ ...base, claims });
    const aggregate = derived.notifications.find((item) => item.aggregation);
    expect(aggregate?.aggregation?.count).toBe(8);
    expect(aggregate?.aggregation?.entityIds).toHaveLength(5);
    expect(aggregate?.title).toContain('8 个 Claim');
  });

  it('15 单实体不产生聚合摘要；禁跨事件聚合', () => {
    const single = deriveNotifications({ ...base, claims: [claim()] });
    expect(single.notifications.some((item) => item.aggregation)).toBe(false);

    // 到期桶只有 1 个实体（另一个已回执），不得跨事件把 N2 也聚合进来
    const mixed = deriveNotifications({
      ...base,
      claims: [claim({ id: 'c-a' }), claim({ id: 'c-b', respondedAt: NOW })],
    });
    const aggregates = mixed.notifications.filter((item) => item.aggregation);
    expect(aggregates).toHaveLength(0);
    expect(mixed.notifications.some((item) => item.eventId === 'claim.response_received')).toBe(true);
  });
});

describe('MSG-32 · 无收件人可观测', () => {
  it('16 收件人集合为空 → 记为 unroutable，不静默丢弃', () => {
    const derived = deriveNotifications({
      ...base,
      memberships: [{ userId: 'u-viewer', role: 'VIEWER' }],
      claims: [claim()],
    });
    expect(derived.notifications).toHaveLength(0);
    expect(derived.unroutable).toEqual([{ eventId: 'claim.deadline_approaching', entityId: 'c-1' }]);
  });
});
