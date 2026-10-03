/**
 * C16 / C19 / C21 契约层验收（HOST DIRECTIVE 2026-10-03 补充四；MSG-20261003-123 ⑧）。
 * 断言：C16 授权就绪 fail-closed；C19 状态/来源分离且无隐含升级；C21 one-click 全 server-derived、
 *       全前置条件 fail-closed、绝不提交 filing。
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateCustomsAuthorizationReadiness,
  type CustomsAuthorizationFlags,
} from '../services/customs/customs-authorization-readiness';
import {
  CUSTOMS_FILING_SOURCE_LEVELS,
  CUSTOMS_FILING_STATUSES,
  CUSTOMS_FORBIDDEN_INFERRED_TRANSITIONS,
  projectCustomsFilingStatus,
  type CustomsFilingStatusFact,
} from '../services/customs/customs-filing-status';
import {
  CUSTOMS_ONE_CLICK_FORBIDDEN_CLIENT_FIELDS,
  prepareCustomsOneClickStart,
  type CustomsOpportunityTruth,
} from '../services/customs/customs-one-click-start';

const ORG = 'ccf00000-0000-4000-8000-000000000001';
const USER = 'ccf00000-0000-4000-8000-000000000002';
const OPP = 'opp-customs-1';
const CAP = 'customs.recovery.start';

const FULL_AUTH: CustomsAuthorizationFlags = {
  customsAgreementSigned: true,
  importerOfRecordConfirmed: true,
  claimantConfirmed: true,
  recoveryRightConfirmed: true,
  brokerConnected: true,
  brokerAuthorizationValid: true,
  filingPermissionValid: true,
  providerCapabilityReady: true,
};

const TRUTH: CustomsOpportunityTruth = {
  opportunityId: OPP,
  organizationId: ORG,
  entryFactPresent: true,
  evidenceBundleCompleteness: 'COMPLETE',
  eligibilityDecision: 'ELIGIBLE',
  recoverableAmounts: [{ currency: 'USD', amount: '18620.00' }],
  remedyRoute: 'DRAWBACK',
  filingDeadline: '2027-05-01',
  recoveryPackageStatus: 'READY',
  ruleVersion: 'us-customs-v1',
};

const PROVIDER = {
  providerId: 'broker-a',
  capabilities: { DATA_READ: true, FILING_CREATE: true, DOCUMENT_UPLOAD: true, STATUS_READ: true },
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    opportunities: {
      async load(organizationId: string, opportunityId: string) {
        return organizationId === ORG && opportunityId === OPP ? TRUTH : null;
      },
    },
    authorization: FULL_AUTH,
    provider: PROVIDER,
    now: () => new Date('2026-10-03T00:00:00.000Z'),
    ...overrides,
  } as never;
}

function start(request: Record<string, unknown>, overrides: Record<string, unknown> = {}, deps2 = deps(overrides)) {
  return prepareCustomsOneClickStart(
    {
      opportunityId: OPP,
      request,
      context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [CAP] },
      requiredCapability: CAP,
    },
    deps2,
  );
}

describe('C16 — customs authorization readiness', () => {
  it('全部就绪 → READY_TO_FILE（判定不代表已申报/已外写）', () => {
    const readiness = evaluateCustomsAuthorizationReadiness(FULL_AUTH);
    expect(readiness.ready).toBe(true);
    expect(readiness.disposition).toBe('READY_TO_FILE');
    expect(readiness.blockers).toEqual([]);
    expect(readiness.filingSubmitted).toBe(false);
    expect(readiness.externalWritePerformed).toBe(false);
    expect(readiness.productionCredentials).toBe('ABSENT');
  });

  it('缺项 → 对应拒绝码（逐个可解释）', () => {
    const cases: Array<[keyof CustomsAuthorizationFlags, string]> = [
      ['customsAgreementSigned', 'CUSTOMS_AGREEMENT_REQUIRED'],
      ['importerOfRecordConfirmed', 'IOR_NOT_CONFIRMED'],
      ['claimantConfirmed', 'CLAIMANT_NOT_CONFIRMED'],
      ['recoveryRightConfirmed', 'RECOVERY_RIGHT_NOT_CONFIRMED'],
      ['brokerConnected', 'BROKER_NOT_CONNECTED'],
      ['brokerAuthorizationValid', 'BROKER_POA_REQUIRED'],
      ['filingPermissionValid', 'FILING_PERMISSION_REQUIRED'],
      ['providerCapabilityReady', 'FILING_PROVIDER_NOT_READY'],
    ];
    for (const [flag, code] of cases) {
      const readiness = evaluateCustomsAuthorizationReadiness({ ...FULL_AUTH, [flag]: false });
      expect(readiness.ready).toBe(false);
      expect(readiness.disposition).toBe('AUTHORIZATION_INCOMPLETE');
      expect(readiness.blockers).toContain(code);
    }
  });

  it('确定性：同输入 → 同判定（blockers 顺序稳定）', () => {
    const a = evaluateCustomsAuthorizationReadiness({ ...FULL_AUTH, brokerConnected: false, claimantConfirmed: false });
    const b = evaluateCustomsAuthorizationReadiness({ ...FULL_AUTH, brokerConnected: false, claimantConfirmed: false });
    expect(b).toEqual(a);
    expect(a.blockers).toEqual(['CLAIMANT_NOT_CONFIRMED', 'BROKER_NOT_CONNECTED']);
  });
});

describe('C19 — filing status read model', () => {
  it('状态与来源等级集合固定', () => {
    expect([...CUSTOMS_FILING_STATUSES]).toHaveLength(10);
    expect([...CUSTOMS_FILING_STATUSES]).toContain('NEEDS_MORE_INFO');
    expect([...CUSTOMS_FILING_SOURCE_LEVELS]).toEqual(['USER_REPORTED', 'PROVIDER_VERIFIED', 'AUTHORITY_VERIFIED']);
  });

  it('投影：latest-wins + history 保留 + 排序确定性（含乱序输入）', () => {
    const facts: CustomsFilingStatusFact[] = [
      { factId: 'f2', organizationId: ORG, opportunityId: OPP, status: 'ACCEPTED', sourceLevel: 'AUTHORITY_VERIFIED', providerReference: 'R2', observedAt: '2026-10-03T02:00:00.000Z', recordedAt: '2026-10-03T02:00:00.000Z', derivesRecoveredCash: false, derivesFee: false },
      { factId: 'f1', organizationId: ORG, opportunityId: OPP, status: 'SUBMITTED', sourceLevel: 'USER_REPORTED', providerReference: null, observedAt: '2026-10-03T01:00:00.000Z', recordedAt: '2026-10-03T01:00:00.000Z', derivesRecoveredCash: false, derivesFee: false },
    ];
    const projection = projectCustomsFilingStatus(facts, { organizationId: ORG, opportunityId: OPP });
    expect(projection.currentStatus).toBe('ACCEPTED');
    expect(projection.currentSourceLevel).toBe('AUTHORITY_VERIFIED');
    expect(projection.history.map((h) => h.status)).toEqual(['SUBMITTED', 'ACCEPTED']);
    expect(projection.hasAuthorityVerifiedFact).toBe(true);
    const reversed = projectCustomsFilingStatus(facts.slice().reverse(), { organizationId: ORG, opportunityId: OPP });
    expect(reversed).toEqual(projection);
  });

  it('禁止隐含升级：仅 USER_REPORTED SUBMITTED → 仍是 SUBMITTED（不得变 ACCEPTED）', () => {
    const facts: CustomsFilingStatusFact[] = [
      { factId: 'f1', organizationId: ORG, opportunityId: OPP, status: 'SUBMITTED', sourceLevel: 'USER_REPORTED', providerReference: 'REF', observedAt: '2026-10-03T01:00:00.000Z', recordedAt: '2026-10-03T01:00:00.000Z', derivesRecoveredCash: false, derivesFee: false },
    ];
    const projection = projectCustomsFilingStatus(facts, { organizationId: ORG, opportunityId: OPP });
    expect(projection.currentStatus).toBe('SUBMITTED');
    expect(projection.currentStatus).not.toBe('ACCEPTED');
    expect(projection.inferredTransitions).toEqual([]);
  });

  it('禁止隐含升级：APPROVED 不得自动变 PAID', () => {
    const facts: CustomsFilingStatusFact[] = [
      { factId: 'f1', organizationId: ORG, opportunityId: OPP, status: 'APPROVED', sourceLevel: 'AUTHORITY_VERIFIED', providerReference: 'REF', observedAt: '2026-10-03T01:00:00.000Z', recordedAt: '2026-10-03T01:00:00.000Z', derivesRecoveredCash: false, derivesFee: false },
    ];
    const projection = projectCustomsFilingStatus(facts, { organizationId: ORG, opportunityId: OPP });
    expect(projection.currentStatus).toBe('APPROVED');
    expect(projection.derivesRecoveredCash).toBe(false);
    expect(projection.derivesFee).toBe(false);
    expect([...CUSTOMS_FORBIDDEN_INFERRED_TRANSITIONS]).toContain('APPROVED_TO_PAID');
  });

  it('tenant / opportunity 隔离：只统计本租户本 opportunity', () => {
    const facts: CustomsFilingStatusFact[] = [
      { factId: 'f1', organizationId: 'other-org', opportunityId: OPP, status: 'PAID', sourceLevel: 'AUTHORITY_VERIFIED', providerReference: null, observedAt: '2026-10-03T01:00:00.000Z', recordedAt: '2026-10-03T01:00:00.000Z', derivesRecoveredCash: false, derivesFee: false },
    ];
    const projection = projectCustomsFilingStatus(facts, { organizationId: ORG, opportunityId: OPP });
    expect(projection.factCount).toBe(0);
    expect(projection.currentStatus).toBeNull();
  });
});

describe('C21 — one-click start recovery', () => {
  it('客户端注入禁止字段 → INVALID_REQUEST（BLOCKED）且零申报', async () => {
    const res = await start({ recoverableAmount: '999999.00' });
    expect(res.ready).toBe(false);
    if (res.ready) return;
    expect(res.reasonCode).toBe('INVALID_REQUEST');
    expect(res.disposition).toBe('BLOCKED');
    expect(res.blockers).toEqual(['FIELD_NOT_ALLOWED:recoverableAmount']);
    expect(res.filingSubmitted).toBe(false);
    expect([...CUSTOMS_ONE_CLICK_FORBIDDEN_CLIENT_FIELDS]).toContain('feeRate');
  });

  it('无 capability → CAPABILITY_REQUIRED', async () => {
    const res = await prepareCustomsOneClickStart(
      {
        opportunityId: OPP,
        request: {},
        context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [] },
        requiredCapability: CAP,
      },
      deps(),
    );
    expect(res.ready).toBe(false);
    if (!res.ready) expect(res.reasonCode).toBe('CAPABILITY_REQUIRED');
  });

  it('未知 opportunity（含跨租户）→ OPPORTUNITY_NOT_FOUND', async () => {
    const res = await prepareCustomsOneClickStart(
      { opportunityId: 'opp-missing', request: {}, context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [CAP] }, requiredCapability: CAP },
      deps(),
    );
    expect(res.ready).toBe(false);
    if (!res.ready) expect(res.reasonCode).toBe('OPPORTUNITY_NOT_FOUND');
  });

  it('前置条件逐项 fail-closed（evidence / eligibility / amount / remedy / deadline / package）', async () => {
    const cases: Array<[Partial<CustomsOpportunityTruth>, string]> = [
      [{ entryFactPresent: false }, 'ENTRY_FACT_MISSING'],
      [{ evidenceBundleCompleteness: 'PARTIAL' }, 'EVIDENCE_INCOMPLETE'],
      [{ eligibilityDecision: 'INDETERMINATE' }, 'NOT_ELIGIBLE'],
      [{ recoverableAmounts: [] }, 'AMOUNT_NOT_READY'],
      [{ remedyRoute: null }, 'REMEDY_ROUTE_MISSING'],
      [{ recoveryPackageStatus: 'NEEDS_REVIEW' }, 'PACKAGE_NOT_READY'],
      [{ filingDeadline: '2020-01-01' }, 'DEADLINE_PASSED'],
    ];
    for (const [patch, code] of cases) {
      const truth = { ...TRUTH, ...patch };
      const res = await prepareCustomsOneClickStart(
        { opportunityId: OPP, request: {}, context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [CAP] }, requiredCapability: CAP },
        deps({ opportunities: { async load() { return truth; } } }),
      );
      expect(res.ready).toBe(false);
      if (!res.ready) expect(res.reasonCode).toBe(code);
    }
  });

  it('授权未就绪 → AUTHORIZATION_NOT_READY（BROKER_HANDOFF + C16 blockers）', async () => {
    const res = await prepareCustomsOneClickStart(
      { opportunityId: OPP, request: {}, context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [CAP] }, requiredCapability: CAP },
      deps({ authorization: { ...FULL_AUTH, brokerAuthorizationValid: false } }),
    );
    expect(res.ready).toBe(false);
    if (res.ready) return;
    expect(res.reasonCode).toBe('AUTHORIZATION_NOT_READY');
    expect(res.disposition).toBe('BROKER_HANDOFF');
    expect(res.blockers).toContain('BROKER_POA_REQUIRED');
  });

  it('provider 缺失或缺能力 → FILING_CAPABILITY_MISSING（BROKER_HANDOFF）', async () => {
    const noProvider = await prepareCustomsOneClickStart(
      { opportunityId: OPP, request: {}, context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [CAP] }, requiredCapability: CAP },
      deps({ provider: null }),
    );
    expect(noProvider.ready).toBe(false);
    if (!noProvider.ready) expect(noProvider.reasonCode).toBe('FILING_CAPABILITY_MISSING');
    const readOnly = await prepareCustomsOneClickStart(
      { opportunityId: OPP, request: {}, context: { organizationId: ORG, actorUserId: USER, actorCapabilities: [CAP] }, requiredCapability: CAP },
      deps({ provider: { providerId: 'broker-ro', capabilities: { DATA_READ: true, STATUS_READ: true } } }),
    );
    expect(readOnly.ready).toBe(false);
    if (!readOnly.ready) expect(readOnly.blockers).toContain('FILING_CREATE');
  });

  it('全部就绪 → READY_TO_FILE + immutable snapshot（仍不提交 filing）', async () => {
    const res = await start({});
    expect(res.ready).toBe(true);
    if (!res.ready) return;
    expect(res.disposition).toBe('READY_TO_FILE');
    expect(res.snapshot.opportunityId).toBe(OPP);
    expect(res.snapshot.ruleVersion).toBe('us-customs-v1');
    expect(res.snapshot.recoverableAmounts).toEqual([{ currency: 'USD', amount: '18620.00' }]);
    expect(res.snapshot.remedyRoute).toBe('DRAWBACK');
    expect(res.snapshot.providerId).toBe('broker-a');
    expect(res.filingSubmitted).toBe(false);
    expect(res.externalWritePerformed).toBe(false);
    expect(res.authoritySubmissionPerformed).toBe(false);
    expect(res.transportEnabled).toBe(false);
    expect(res.productionCredentials).toBe('ABSENT');
  });
});
