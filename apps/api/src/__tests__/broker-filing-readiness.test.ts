// CUSTOMS / DUTY RECOVERY — slice B-S9 — Broker / ABI / Filing readiness 回归
// ---------------------------------------------------------------------------
// 覆盖：15 项门槛逐项判定与阻断原因、缺一不得 READY、POA 复用规则（验证+范围+辖区+未过期）、
//   POA 缺口 → BROKER_HANDOFF 其余 → NEEDS_MANUAL、RFI 只出草稿不真实 respond、
//   边界断言、确定性摘要。

import { describe, expect, it } from 'vitest';

import {
  BROKER_FILING_READINESS_BOUNDARY,
  BROKER_FILING_READINESS_GATE_COUNT,
  BROKER_FILING_READINESS_VERSION,
  BROKER_HANDOFF_GATE_KEYS,
  BrokerFilingReadinessError,
  READINESS_GATE_KEYS,
  assertBrokerReadinessDidNotFile,
  assertNoReadyWithMissingGates,
  evaluateBrokerFilingReadiness,
  type BrokerFilingReadinessInput,
} from '../services/customs/broker-filing-readiness';

const NOW = new Date('2026-10-06T20:00:00.000Z');
const SCOPE = { organizationId: 'org-br-1', platformAccountId: 'acct-br-a' };

function poa(overrides: Partial<NonNullable<BrokerFilingReadinessInput['poa']>> = {}) {
  return {
    organizationId: SCOPE.organizationId,
    principalRef: 'principal-1',
    brokerRef: 'broker-1',
    jurisdiction: 'US',
    authorizationType: 'CBP_FORM_5291',
    scope: ['DRAWBACK'],
    effectiveAt: '2026-01-01',
    expiresAt: '2027-01-01',
    evidenceArtifactRef: 'ev-poa-1',
    verificationStatus: 'VERIFIED',
    verificationSource: 'BROKER_POA_FACT',
    ...overrides,
  };
}

function input(overrides: Partial<BrokerFilingReadinessInput> = {}): BrokerFilingReadinessInput {
  return {
    scope: SCOPE,
    remedy: 'DRAWBACK',
    jurisdiction: 'US',
    facts: {
      customsAgreementSigned: true,
      iorConfirmed: true,
      claimantConfirmed: true,
      recoveryRightForRemedy: true,
      brokerConnected: true,
      filingPermissionValid: true,
      providerCapabilityReady: true,
      payeeIdentityConfirmed: true,
      refundDestinationVerified: true,
      aceEnrollmentReady: true,
    },
    poa: poa(),
    evidenceChainStatus: 'COMPLETE',
    claimRoute: { disposition: 'CLAIM_READY' },
    now: NOW,
    ...overrides,
  };
}

describe('B-S9 报关就绪度 — 15 项门槛', () => {
  it('全部满足 → READY_FOR_FILING_PROVIDER（15/15，仍不申报）', () => {
    const readiness = evaluateBrokerFilingReadiness(input());
    expect(readiness.kind).toBe('BROKER_FILING_READINESS');
    expect(readiness.version).toBe(BROKER_FILING_READINESS_VERSION);
    expect(readiness.items).toHaveLength(BROKER_FILING_READINESS_GATE_COUNT);
    expect(readiness.items).toHaveLength(15);
    expect(readiness.readyCount).toBe(15);
    expect(readiness.ready).toBe(true);
    expect(readiness.disposition).toBe('READY_FOR_FILING_PROVIDER');
    expect(readiness.blockingKeys).toEqual([]);
    expect(readiness.filingSubmitted).toBe(false);
    expect(readiness.externalWritePerformed).toBe(false);
    expect(readiness.productionCredentials).toBe('ABSENT');
    expect(readiness.rfi.prepared).toBe(false);
    expect(readiness.rfi.draft).toBeNull();
    expect(readiness.reasons).toContain('ALL_FIFTEEN_GATES_SATISFIED');
    expect(() => assertBrokerReadinessDidNotFile(readiness)).not.toThrow();
    expect(() => assertNoReadyWithMissingGates(readiness)).not.toThrow();
  });

  it('门槛键与顺序固定，每项都有 label / source / 阻断原因语义', () => {
    const readiness = evaluateBrokerFilingReadiness(input());
    expect(readiness.items.map((item) => item.key)).toEqual([...READINESS_GATE_KEYS]);
    for (const item of readiness.items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.satisfied ? item.blockingReason === null : item.blockingReason?.length).toBeTruthy();
    }
  });

  it('缺一项（ACE 未就绪）→ 不 READY，NEEDS_MANUAL，并给出阻断键与 RFI 草稿', () => {
    const readiness = evaluateBrokerFilingReadiness(
      input({ facts: { ...input().facts, aceEnrollmentReady: false } }),
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.readyCount).toBe(14);
    expect(readiness.disposition).toBe('NEEDS_MANUAL');
    expect(readiness.blockingKeys).toEqual(['ACE_ENROLLMENT_READY']);
    expect(readiness.rfi.prepared).toBe(true);
    expect(readiness.rfi.missingKeys).toEqual(['ACE_ENROLLMENT_READY']);
    expect(readiness.rfi.draft?.body).toContain('ACE 注册就绪');
    expect(readiness.rfi.willSend).toBe(false);
    expect(readiness.rfi.realRespondPerformed).toBe(false);
    expect(() => assertNoReadyWithMissingGates(readiness)).not.toThrow();
  });

  it('证据链未完整 / 路线未达 CLAIM_READY → 对应门槛不满足', () => {
    const noEvidence = evaluateBrokerFilingReadiness(input({ evidenceChainStatus: 'INSUFFICIENT' }));
    expect(noEvidence.blockingKeys).toContain('EVIDENCE_CHAIN_COMPLETE');
    expect(noEvidence.items.find((i) => i.key === 'EVIDENCE_CHAIN_COMPLETE')?.blockingReason).toBe(
      'EVIDENCE_CHAIN_INSUFFICIENT',
    );

    const notReadyRoute = evaluateBrokerFilingReadiness(input({ claimRoute: { disposition: 'NEEDS_MANUAL_REVIEW' } }));
    expect(notReadyRoute.blockingKeys).toContain('CLAIM_ROUTE_READY');
    expect(notReadyRoute.items.find((i) => i.key === 'CLAIM_ROUTE_READY')?.blockingReason).toBe(
      'CLAIM_ROUTE_NEEDS_MANUAL_REVIEW',
    );
  });

  it('缺少证据链/路线输入时给出 MISSING 阻断（不猜）', () => {
    const readiness = evaluateBrokerFilingReadiness(input({ evidenceChainStatus: null, claimRoute: null }));
    expect(readiness.items.find((i) => i.key === 'EVIDENCE_CHAIN_COMPLETE')?.blockingReason).toBe(
      'EVIDENCE_CHAIN_MISSING',
    );
    expect(readiness.items.find((i) => i.key === 'CLAIM_ROUTE_READY')?.blockingReason).toBe('CLAIM_ROUTE_MISSING');
  });
});

describe('B-S9 — POA 复用规则', () => {
  it('已验证 + 覆盖 remedy + 辖区一致 + 未过期 → 复用既有 POA（不重复取得）', () => {
    const readiness = evaluateBrokerFilingReadiness(input());
    expect(readiness.poa.present).toBe(true);
    expect(readiness.poa.usable).toBe(true);
    expect(readiness.poa.reused).toBe(true);
    expect(readiness.poa.requiresRecollection).toBe(false);
    expect(readiness.reasons).toContain('POA_REUSED_FROM_EXISTING_AUTHORIZATION');
    expect(readiness.poa.reuseRule).toContain('VERIFIED');
  });

  it('未提供 POA → BROKER_HANDOFF + requiresRecollection', () => {
    const readiness = evaluateBrokerFilingReadiness(input({ poa: null }));
    expect(readiness.poa.present).toBe(false);
    expect(readiness.poa.requiresRecollection).toBe(true);
    expect(readiness.disposition).toBe('BROKER_HANDOFF');
    expect(readiness.blockingKeys).toContain('BROKER_POA_VALID');
    expect(readiness.items.find((i) => i.key === 'BROKER_POA_VALID')?.blockingReason).toBe('BROKER_POA_REQUIRED');
    expect(readiness.reasons).toContain('POA_RECOLLECTION_REQUIRED');
    expect(readiness.reasons).toContain('BROKER_ACTION_REQUIRED');
  });

  it('POA 过期 / 未验证 / 错授权类型 → 不可复用（沿用既有判定原因码）', () => {
    const expired = evaluateBrokerFilingReadiness(input({ poa: poa({ expiresAt: '2026-09-01' }) }));
    expect(expired.poa.usable).toBe(false);
    expect(expired.poa.reasonCodes).toContain('EXPIRED');
    expect(expired.disposition).toBe('BROKER_HANDOFF');

    const unverified = evaluateBrokerFilingReadiness(input({ poa: poa({ verificationStatus: 'PENDING' }) }));
    expect(unverified.poa.reasonCodes).toContain('UNVERIFIED');

    const wrongType = evaluateBrokerFilingReadiness(input({ poa: poa({ authorizationType: 'CBP_FORM_4811' }) }));
    expect(wrongType.poa.reasonCodes).toContain('WRONG_AUTHORIZATION_TYPE');
    expect(wrongType.poa.reused).toBe(false);
  });

  it('POA 覆盖范围不含 remedy → 该门槛不满足，需重新取得', () => {
    const readiness = evaluateBrokerFilingReadiness(input({ poa: poa({ scope: ['PROTEST'] }) }));
    expect(readiness.poa.usable).toBe(true); // POA 本身有效
    expect(readiness.poa.reused).toBe(false); // 但不覆盖该 remedy
    expect(readiness.items.find((i) => i.key === 'BROKER_POA_SCOPE_COVERS_REMEDY')?.blockingReason).toBe(
      'BROKER_POA_SCOPE_MISMATCH',
    );
    expect(readiness.disposition).toBe('BROKER_HANDOFF');
  });

  it('POA 辖区不一致 → 不满足，需重新取得', () => {
    const readiness = evaluateBrokerFilingReadiness(input({ poa: poa({ jurisdiction: 'CA' }) }));
    expect(readiness.items.find((i) => i.key === 'BROKER_POA_JURISDICTION_MATCH')?.blockingReason).toBe(
      'BROKER_POA_JURISDICTION_MISMATCH',
    );
    expect(readiness.disposition).toBe('BROKER_HANDOFF');
  });

  it('POA / broker 相关缺口 → BROKER_HANDOFF；其它缺口 → NEEDS_MANUAL', () => {
    const brokerGap = evaluateBrokerFilingReadiness(
      input({ facts: { ...input().facts, brokerConnected: false } }),
    );
    expect(brokerGap.disposition).toBe('BROKER_HANDOFF');
    expect(BROKER_HANDOFF_GATE_KEYS).toContain('BROKER_CONNECTED');

    const manualGap = evaluateBrokerFilingReadiness(
      input({ facts: { ...input().facts, payeeIdentityConfirmed: false } }),
    );
    expect(manualGap.disposition).toBe('NEEDS_MANUAL');
  });
});

describe('B-S9 — RFI 草稿与制度边界', () => {
  it('RFI 只准备草稿：willSend=false、realRespondPerformed=false、不自称已发送', () => {
    const readiness = evaluateBrokerFilingReadiness(
      input({ facts: { ...input().facts, filingPermissionValid: false } }),
    );
    expect(readiness.rfi.prepared).toBe(true);
    expect(readiness.rfi.willSend).toBe(false);
    expect(readiness.rfi.realRespondPerformed).toBe(false);
    expect(readiness.rfi.draft?.subject).toContain('DRAWBACK');
    expect(readiness.rfi.draft?.body).toContain('FILING_PERMISSION_VALID');
  });

  it('边界常量：只评估、不申报、不写外部、无凭据、不判权利/金额/佣金', () => {
    expect(BROKER_FILING_READINESS_BOUNDARY.readOnly).toBe(true);
    expect(BROKER_FILING_READINESS_BOUNDARY.gateCount).toBe(15);
    expect(BROKER_FILING_READINESS_BOUNDARY.filingSubmitted).toBe(false);
    expect(BROKER_FILING_READINESS_BOUNDARY.externalWritePerformed).toBe(false);
    expect(BROKER_FILING_READINESS_BOUNDARY.productionCredentials).toBe('ABSENT');
    expect(BROKER_FILING_READINESS_BOUNDARY.decidesEligibility).toBe(false);
    expect(BROKER_FILING_READINESS_BOUNDARY.computesRecoverableAmount).toBe(false);
    expect(BROKER_FILING_READINESS_BOUNDARY.determinesSuccessFeeEligibility).toBe(false);
    expect(BROKER_FILING_READINESS_BOUNDARY.rfiIsDraftOnly).toBe(true);
    expect(BROKER_FILING_READINESS_BOUNDARY.missingGateNeverReady).toBe(true);
    expect(BROKER_FILING_READINESS_BOUNDARY.forbidden).toContain(
      'filing or transmitting anything through a broker / ABI / filing provider',
    );
    expect(BROKER_FILING_READINESS_BOUNDARY.forbidden).toContain('treating Form 4811 as a broker POA');
  });

  it('边界断言：已申报 / 已写外部 / 持有凭据 / 真实 respond 一律拒绝', () => {
    const readiness = evaluateBrokerFilingReadiness(input());
    expect(() => assertBrokerReadinessDidNotFile(readiness)).not.toThrow();
    expect(() => assertBrokerReadinessDidNotFile({ filingSubmitted: true as never })).toThrowError(
      BrokerFilingReadinessError,
    );
    expect(() => assertBrokerReadinessDidNotFile({ externalWritePerformed: true as never })).toThrowError(
      BrokerFilingReadinessError,
    );
    expect(() => assertBrokerReadinessDidNotFile({ productionCredentials: 'PRESENT' })).toThrowError(
      BrokerFilingReadinessError,
    );
    expect(() =>
      assertBrokerReadinessDidNotFile({ rfi: { willSend: true, realRespondPerformed: true } }),
    ).toThrowError(BrokerFilingReadinessError);
  });

  it('assertNoReadyWithMissingGates：伪造 READY 被拒绝', () => {
    expect(() =>
      assertNoReadyWithMissingGates({ ready: true, items: [{ satisfied: true }, { satisfied: false }] }),
    ).toThrowError(BrokerFilingReadinessError);
    expect(() => assertNoReadyWithMissingGates({ ready: false, items: [{ satisfied: false }] })).not.toThrow();
  });

  it('确定性：同输入同 now → 同 readinessDigest；门槛变化 → 摘要变', () => {
    const a = evaluateBrokerFilingReadiness(input());
    const b = evaluateBrokerFilingReadiness(input());
    const c = evaluateBrokerFilingReadiness(input({ poa: null }));
    expect(a.readinessDigest).toBe(b.readinessDigest);
    expect(a.readinessDigest).not.toBe(c.readinessDigest);
    expect(a.readinessDigest).toHaveLength(64);
    expect(a.evaluatedAt).toBe(NOW.toISOString());
  });
});
