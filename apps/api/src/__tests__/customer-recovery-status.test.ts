// PROVIDER FOLLOW-UP INTELLIGENCE / P8 — slice A-S9 — Customer UX/API projection contract 回归
// ---------------------------------------------------------------------------
// 覆盖：七环节严格区分（缺料 / 内部准备中 / 内部准备完成 / 已提交 / 平台已受理 / 需审批 / 已到账 / 已对账）、
// 单一 SUBMITTED 禁止、未验证来源不得显示平台受理、未确认金额不得呈现为已到账、
// 客户文案不泄漏内部细节、租户隔离、确定性摘要。

import { describe, expect, it } from 'vitest';

import * as providerSupport from '../services/provider-support';
import {
  CUSTOMER_STATUS_BOUNDARY,
  CUSTOMER_VISIBLE_COPY,
  CUSTOMER_VISIBLE_STATES,
  CustomerRecoveryStatusError,
  assertCustomerCopyIsSafe,
  assertCustomerStatusConsistent,
  deriveCustomerVisibleState,
  isCustomerVisibleState,
  projectCustomerRecoveryStatus,
  projectRecoveryCaseLifecycle,
  type RecoveryCaseLifecycleSnapshot,
} from '../services/provider-support';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const ORG = 'org-1';

function snapshot(overrides: Partial<RecoveryCaseLifecycleSnapshot> = {}): RecoveryCaseLifecycleSnapshot {
  return {
    organizationId: ORG,
    caseId: 'case-1',
    caseNo: 'C-0001',
    domain: 'PLATFORM',
    caseStatus: 'OPEN',
    openedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function lifecycle(overrides: Partial<RecoveryCaseLifecycleSnapshot> = {}) {
  return projectRecoveryCaseLifecycle({
    scope: { organizationId: ORG },
    snapshot: snapshot(overrides),
    observedAt: NOW,
  });
}

function status(overrides: Partial<RecoveryCaseLifecycleSnapshot> = {}, dispatch = null) {
  return projectCustomerRecoveryStatus({
    scope: { organizationId: ORG },
    lifecycle: lifecycle(overrides),
    dispatch,
    observedAt: NOW,
  });
}

const FOUND_POD = { kind: 'POD', status: 'FOUND' as const, evidenceReferences: ['ev-pod'], resultDigest: 'd-pod' };
const EXPORTED_PACKAGE = [
  { packageId: 'p1', status: 'EXPORTED' as const, packageDigest: 'dig-1', generatedAt: '2026-10-02T00:00:00.000Z' },
];

describe('A-S9 客户可见状态 — 七环节严格区分', () => {
  it('缺料 → EVIDENCE_NEEDED（列出缺口，不显示任何「已提交」）', () => {
    const record = status({ caseStatus: 'COLLECTING_EVIDENCE', requiredEvidenceKinds: ['POD'] });
    expect(record.state).toBe('EVIDENCE_NEEDED');
    expect(record.facts.missingEvidenceKinds).toEqual(['POD']);
    expect(record.facts.sentToPlatform).toBe(false);
    expect(record.facts.internalPrepared).toBe(false);
  });

  it('内部处理中 → PREPARING', () => {
    const record = status({ caseStatus: 'COLLECTING_EVIDENCE' });
    expect(record.state).toBe('PREPARING');
  });

  it('材料齐备但未提交 → PREPARING（EVIDENCE_COMPLETE 不显示为已提交）', () => {
    const record = status({ evidenceResolutions: [FOUND_POD] });
    expect(record.state).toBe('PREPARING');
    expect(record.facts.internalPrepared).toBe(false);
  });

  it('包已导出但未提交 → READY_INTERNAL（明确「尚未提交」），且给出免责说明', () => {
    const record = status({ packages: EXPORTED_PACKAGE });
    expect(record.state).toBe('READY_INTERNAL');
    expect(record.facts.internalPrepared).toBe(true);
    expect(record.facts.sentToPlatform).toBe(false);
    expect(record.copy.title).toContain('尚未提交');
    expect(record.disclaimers).toContain('INTERNAL_READY_NOT_YET_SUBMITTED');
    expect(record.disclaimers).toContain('NO_PAYMENT_CONFIRMED_YET');
  });

  it('high-value 未审批 → APPROVAL_REQUIRED（优先于 READY_INTERNAL）', () => {
    const record = status({
      packages: EXPORTED_PACKAGE,
      followUp: { status: 'DRAFT', approvalRequired: true, approvalRole: 'OWNER', highValue: true },
    });
    expect(record.state).toBe('APPROVAL_REQUIRED');
    expect(record.facts.approvalRequired).toBe(true);
    expect(record.facts.approvalGranted).toBe(false);
  });

  it('已记录提交事实 → SENT，且仍提示「等待平台受理」', () => {
    const record = status({
      packages: EXPORTED_PACKAGE,
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
    });
    expect(record.state).toBe('SENT');
    expect(record.facts.sentToPlatform).toBe(true);
    expect(record.facts.providerAcknowledged).toBe(false);
    expect(record.disclaimers).toContain('AWAITING_PLATFORM_ACKNOWLEDGEMENT');
  });

  it('平台 VERIFIED 受理 → PLATFORM_ACKNOWLEDGED（不再提示等待受理）', () => {
    const record = status({
      providerAcknowledgement: { source: 'PROVIDER_VERIFIED', acknowledgedAt: '2026-10-04T00:00:00.000Z' },
    });
    expect(record.state).toBe('PLATFORM_ACKNOWLEDGED');
    expect(record.facts.providerAcknowledged).toBe(true);
    expect(record.disclaimers).not.toContain('AWAITING_PLATFORM_ACKNOWLEDGEMENT');
  });

  it('结算经 VERIFIED 确认 → SETTLED，并标注金额来自已验证结算', () => {
    const record = status({
      settlement: {
        settlementId: 'st-1',
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'PARTIAL',
        verifiedSource: 'PROVIDER_VERIFIED',
        amountUsd: 800,
      },
    });
    expect(record.state).toBe('SETTLED');
    expect(record.facts.settlementReceived).toBe(true);
    expect(record.disclaimers).toContain('AMOUNT_REFLECTS_VERIFIED_SETTLEMENT');
  });

  it('对账 MATCHED → RECONCILED', () => {
    const record = status({ reconciliation: { status: 'MATCHED', reconciledAt: '2026-10-05T00:00:00.000Z' } });
    expect(record.state).toBe('RECONCILED');
    expect(record.facts.reconciled).toBe(true);
  });

  it('证据冲突 / 人工复核 → NEEDS_MANUAL_REVIEW 覆盖「缺料」，但不覆盖已提交及之后的环节', () => {
    const conflict = status({
      caseStatus: 'COLLECTING_EVIDENCE',
      requiredEvidenceKinds: ['POD'],
      evidenceResolutions: [
        { kind: 'POD', status: 'CONFLICT', evidenceReferences: ['a', 'b'], resultDigest: 'd' },
      ],
    });
    expect(conflict.state).toBe('NEEDS_MANUAL_REVIEW');
    expect(conflict.facts.requiresHumanAttention).toBe(true);

    const sentWithConflict = status({
      packages: EXPORTED_PACKAGE,
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
      evidenceResolutions: [
        { kind: 'POD', status: 'CONFLICT', evidenceReferences: ['a', 'b'], resultDigest: 'd' },
      ],
    });
    expect(sentWithConflict.state).toBe('SENT');
    expect(sentWithConflict.facts.requiresHumanAttention).toBe(true);
  });

  it('案件关闭 → CLOSED', () => {
    const record = status({ caseStatus: 'CLOSED', closedAt: '2026-10-05T09:00:00.000Z' });
    expect(record.state).toBe('CLOSED');
  });

  it('没有任何缺口时不得显示 EVIDENCE_NEEDED', () => {
    const record = status({ evidenceResolutions: [FOUND_POD] });
    expect(record.state).not.toBe('EVIDENCE_NEEDED');
  });
});

describe('A-S9 — 单一 SUBMITTED 禁止 & 未验证来源不得升级', () => {
  it('READY_INTERNAL 与 SENT 是两个状态（记录显式声明）', () => {
    const ready = status({ packages: EXPORTED_PACKAGE });
    const sent = status({
      packages: EXPORTED_PACKAGE,
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
    });
    expect(ready.state).not.toBe(sent.state);
    expect(ready.distinguishesInternalReadyFromSent).toBe(true);
    expect(sent.distinguishesInternalReadyFromSent).toBe(true);
    expect(CUSTOMER_STATUS_BOUNDARY.singleSubmittedStatusForbidden).toBe(true);
  });

  it('assertCustomerStatusConsistent：SENT 无提交事实 → 抛错；READY_INTERNAL 标记已提交 → 抛错', () => {
    expect(() => assertCustomerStatusConsistent({ state: 'SENT', facts: { sentToPlatform: false } })).toThrowError(
      CustomerRecoveryStatusError,
    );
    expect(() =>
      assertCustomerStatusConsistent({ state: 'READY_INTERNAL', facts: { sentToPlatform: true } }),
    ).toThrowError(CustomerRecoveryStatusError);
    expect(() =>
      assertCustomerStatusConsistent({
        state: 'PLATFORM_ACKNOWLEDGED',
        facts: { providerAcknowledged: false },
      }),
    ).toThrowError(CustomerRecoveryStatusError);
    expect(() =>
      assertCustomerStatusConsistent({ state: 'SETTLED', facts: { settlementReceived: false } }),
    ).toThrowError(CustomerRecoveryStatusError);
    expect(() =>
      assertCustomerStatusConsistent({ state: 'RECONCILED', facts: { reconciled: false } }),
    ).toThrowError(CustomerRecoveryStatusError);
    expect(() =>
      assertCustomerStatusConsistent({ state: 'EVIDENCE_NEEDED', facts: { missingEvidenceKinds: [] } }),
    ).toThrowError(CustomerRecoveryStatusError);
    expect(() =>
      assertCustomerStatusConsistent({
        state: 'READY_INTERNAL',
        facts: { sentToPlatform: false, missingEvidenceKinds: [] },
      }),
    ).not.toThrow();
  });

  it('未验证派发来源 + 平台受理 → 抛错（不得以未验证来源支撑平台受理）', () => {
    const projected = lifecycle({
      providerAcknowledgement: { source: 'PROVIDER_VERIFIED', acknowledgedAt: '2026-10-04T00:00:00.000Z' },
    });
    expect(() =>
      projectCustomerRecoveryStatus({
        scope: { organizationId: ORG },
        lifecycle: projected,
        dispatch: { source: 'USER_RECORDED', dispatchedAt: null, channel: 'MANUAL_PORTAL' },
        observedAt: NOW,
      }),
    ).toThrowError(CustomerRecoveryStatusError);
  });

  it('未确认金额不会呈现为「已到账」（状态与免责说明一致）', () => {
    const record = status({
      packages: EXPORTED_PACKAGE,
      settlement: {
        settlementId: 'st-1',
        confirmationStatus: 'PENDING_CONFIRMATION',
        reconciliationStatus: 'NOT_STARTED',
        amountUsd: 5_000,
      },
    });
    expect(record.state).not.toBe('SETTLED');
    expect(record.facts.settlementReceived).toBe(false);
    expect(record.disclaimers).toContain('NO_PAYMENT_CONFIRMED_YET');
  });

  it('被省略的未验证事实会在客户状态里显式标注', () => {
    const record = status({
      providerAcknowledgement: { source: 'UNVERIFIED', acknowledgedAt: null },
    });
    expect(record.state).not.toBe('PLATFORM_ACKNOWLEDGED');
    expect(record.disclaimers).toContain('SOME_FACTS_OMITTED_BECAUSE_UNVERIFIED');
    expect(record.omittedBecauseUnverified.length).toBeGreaterThan(0);
  });
});

describe('A-S9 — 客户文案安全与完整性', () => {
  it('每个客户可见状态都有稳定文案（title/detail/nextStep 非空）', () => {
    for (const state of CUSTOMER_VISIBLE_STATES) {
      const copy = CUSTOMER_VISIBLE_COPY[state];
      expect(copy.title.trim().length).toBeGreaterThan(0);
      expect(copy.detail.trim().length).toBeGreaterThan(0);
      expect(copy.nextStep.trim().length).toBeGreaterThan(0);
      expect(() => assertCustomerCopyIsSafe(`${copy.title} ${copy.detail} ${copy.nextStep}`)).not.toThrow();
    }
  });

  it('文案不得泄漏内部细节（栈 / SQL / ORM / 凭据 / token / secret / storageKey）', () => {
    expect(() => assertCustomerCopyIsSafe('正常文案')).not.toThrow();
    for (const bad of [
      'at Object.<anonymous> (server.ts:10:5)',
      'prisma error P2002',
      'SELECT * FROM Case',
      'credentialRef#abcd***',
      'token=abc',
      'secret leaked',
      'api_key=xyz',
      'storageKey=foo',
    ]) {
      expect(() => assertCustomerCopyIsSafe(bad)).toThrowError(CustomerRecoveryStatusError);
    }
  });

  it('isCustomerVisibleState 只承认稳定 code', () => {
    expect(isCustomerVisibleState('READY_INTERNAL')).toBe(true);
    expect(isCustomerVisibleState('SUBMITTED')).toBe(false);
    expect(isCustomerVisibleState('SENT')).toBe(true);
  });

  it('边界常量：只读、区分内部就绪与已提交、不发通知、不改事实', () => {
    expect(CUSTOMER_STATUS_BOUNDARY.readOnly).toBe(true);
    expect(CUSTOMER_STATUS_BOUNDARY.distinguishesInternalReadyFromSent).toBe(true);
    expect(CUSTOMER_STATUS_BOUNDARY.settlementIsNeverEstimated).toBe(true);
    expect(CUSTOMER_STATUS_BOUNDARY.sendsNotifications).toBe(false);
    expect(CUSTOMER_STATUS_BOUNDARY.mutatesFacts).toBe(false);
    expect(CUSTOMER_STATUS_BOUNDARY.forbidden).toContain(
      'using a single SUBMITTED status for both internal readiness and provider receipt',
    );
  });
});

describe('A-S9 — 隔离、确定性与纯派生', () => {
  it('投影与范围不一致 → CUSTOMER_STATUS_TENANT_MISMATCH', () => {
    expect(() =>
      projectCustomerRecoveryStatus({
        scope: { organizationId: 'org-2' },
        lifecycle: lifecycle(),
        observedAt: NOW,
      }),
    ).toThrowError(CustomerRecoveryStatusError);
  });

  it('deriveCustomerVisibleState 与 projectCustomerRecoveryStatus 结论一致', () => {
    const life = lifecycle({ packages: EXPORTED_PACKAGE });
    expect(deriveCustomerVisibleState(life)).toBe(
      projectCustomerRecoveryStatus({ scope: { organizationId: ORG }, lifecycle: life, observedAt: NOW }).state,
    );
  });

  it('确定性：同生命周期同 observedAt → 同 statusDigest；生命周期变化 → 摘要变', () => {
    const a = status({ packages: EXPORTED_PACKAGE });
    const b = status({ packages: EXPORTED_PACKAGE });
    const c = status({
      packages: EXPORTED_PACKAGE,
      submission: { submissionId: 's1', submittedAt: '2026-10-03T00:00:00.000Z', packageDigest: 'dig-1' },
    });
    expect(a.statusDigest).toBe(b.statusDigest);
    expect(a.statusDigest).not.toBe(c.statusDigest);
    expect(a.statusDigest).toHaveLength(64);
  });

  it('生命周期阶段与客户状态一一映射且不引入新状态机（readOnly=true）', () => {
    const record = status({ packages: EXPORTED_PACKAGE });
    expect(record.readOnly).toBe(true);
    expect(record.kind).toBe('CUSTOMER_RECOVERY_STATUS');
    expect(record.lifecycleStage).toBe('PACKAGE_EXPORTED');
    expect(record.state).toBe('READY_INTERNAL');
  });

  it('模块不导出任何发送通知 / 写库入口', () => {
    for (const name of Object.keys(providerSupport)) {
      expect(name).not.toMatch(/sendNotification|notifyCustomer|pushStatus|persistCustomerStatus/i);
    }
  });
});
