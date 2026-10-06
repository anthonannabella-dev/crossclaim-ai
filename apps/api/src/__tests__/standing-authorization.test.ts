// STANDING AUTHORIZATION / RISK-TIERED EXECUTION — 验收回归（覆盖 HOST 第 9 条 1–12 项）
// ---------------------------------------------------------------------------
// 1 有效授权 + 低风险 → 授权满足守卫 / 2 无授权 → REQUIRE_APPROVAL / 3 已撤销 → DENY / 4 已过期 → DENY /
// 5 金额超 scope → REQUIRE_APPROVAL / 6 action 超 scope → REQUIRE_APPROVAL / 7 account·provider 不匹配 → DENY /
// 8 高金额规则不可绕过 / 9 Customs POA 不能被 Standing Authorization 替代 /
// 10 Production Gate=false 时即使授权有效也不得外写 / 11 并发·重复执行保持 exactly-once（判定稳定、无副作用）/
// 12 authorization version change 后旧执行权不能继续使用。

import { describe, expect, it } from 'vitest';

import {
  ACTION_GUARD_WIRING_BOUNDARY,
  CUSTOMS_POA_BOUNDARY,
  ActionGuardWiringError,
  assertNoNonBypassableGateSatisfiedByStanding,
  assertStandingAuthorizationIsNotBrokerPoa,
  evaluateAutonomousExecution,
  type AutonomousExecutionInput,
} from '../services/standing-authorization/action-guard-wiring';
import {
  ACTION_GUARD_CATALOG,
  evaluateActionGuard,
  type ActionGuardResult,
} from '../services/action-guard/action-guard';
import { classifyRiskTier, RISK_TIER_BOUNDARY, type RiskTierInput } from '../services/standing-authorization/risk-tier-policy';
import {
  STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES,
  StandingAuthorizationError,
  bumpStandingAuthorizationVersion,
  computeStandingAuthorizationScopeDigest,
  createStandingAuthorization,
  evaluateStandingAuthorization,
  revokeStandingAuthorization,
  type StandingAuthorizationRecord,
} from '../services/standing-authorization/standing-authorization';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const LATER = new Date('2027-01-01T00:00:00.000Z');
const ORG = 'org-sa-1';
const ACCT = 'acct-sa-a';
const ACTION = 'recovery.manual_submit';

function authorization(overrides: Partial<Parameters<typeof createStandingAuthorization>[0]> = {}): StandingAuthorizationRecord {
  return createStandingAuthorization({
    serverDerived: true,
    authorizationId: 'sa-1',
    organizationId: ORG,
    platformAccountId: ACCT,
    provider: 'AMAZON',
    allowedActionTypes: [ACTION],
    monetaryLimitUsd: 1_000,
    currency: 'USD',
    domain: 'PLATFORM',
    jurisdiction: 'US',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-10-01T00:00:00.000Z',
    authorizationVersion: 1,
    termsPolicyVersion: 'terms/v1',
    consentEvidenceRef: 'consent:1',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  });
}

function guardFor(action = ACTION): ActionGuardResult {
  return evaluateActionGuard({
    action,
    actorUserId: 'user-1',
    organizationId: ORG,
    capabilities: {
      featureEnabled: { [action]: true },
      tenantEnabled: true,
      writeEnabled: false,
      productionGate: 'NOT_SATISFIED',
    },
  });
}

function riskTier(overrides: Partial<RiskTierInput> = {}) {
  return classifyRiskTier(
    {
      action: ACTION,
      amountUsd: 500,
      provider: 'AMAZON',
      domain: 'PLATFORM',
      jurisdiction: 'US',
      evidence: { completeness: 'COMPLETE', conflicts: [] },
      authorization: { valid: true, withinScope: true, amountWithinLimit: true },
      experienceDecisionSupport: 'ADVISORY',
      experienceSuccessRateBp: 7_000,
      providerTermsFlags: [],
      regulatoryFlags: [],
      ...overrides,
    },
    NOW,
  );
}

function decide(overrides: Partial<AutonomousExecutionInput> = {}) {
  return evaluateAutonomousExecution({
    guard: guardFor(),
    authorization: authorization(),
    request: {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: 'AMAZON',
      action: ACTION,
      amountUsd: 500,
      currency: 'USD',
      domain: 'PLATFORM',
      jurisdiction: 'US',
      expectedAuthorizationVersion: 1,
      expectedTermsPolicyVersion: 'terms/v1',
    },
    riskTier: riskTier(),
    gates: {
      productionGate: 'SATISFIED',
      platformEnablement: true,
      killSwitchActive: false,
      providerCapabilityReady: true,
      credentialReady: true,
      regulatoryRestriction: null,
      tenantAccountIsolationOk: true,
    },
    now: NOW,
    ...overrides,
  });
}

describe('SA 验收 1–4：有效 / 缺失 / 撤销 / 过期', () => {
  it('① 有效授权 + 低风险动作 → 授权满足 humanApproval，ALLOW（authorizedBy=STANDING_AUTHORIZATION）', () => {
    const result = decide();
    expect(result.decision).toBe('ALLOW');
    expect(result.authorizedBy).toBe('STANDING_AUTHORIZATION');
    expect(result.satisfiedGates).toEqual(['humanApproval']);
    expect(result.standingAuthorizationDecision).toBe('SATISFIED');
    expect(result.riskTier).toBe('TIER_1_LOW_RISK_RECOVERY');
    expect(result.executionPerformed).toBe(false);
    expect(result.externalWritePerformed).toBe(false);
    expect(ACTION_GUARD_CATALOG[ACTION].requires).toContain('humanApproval');
  });

  it('② 无授权 → REQUIRE_APPROVAL（一次性人工审批路径保留）', () => {
    const result = decide({ authorization: null, riskTier: riskTier({ authorization: null }) });
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.authorizedBy).toBe('NONE');
    expect(result.riskTierRequiresHitl).toBe(true);
    expect(result.reasonCodes).toContain('RISK_TIER_REQUIRES_HITL:TIER_2_ELEVATED');
  });

  it('③ 已撤销 → DENY（立即 fail-closed，不使用旧授权）', () => {
    const revokedAuth = revokeStandingAuthorization(authorization(), {
      revokedBy: 'owner-1',
      reason: 'customer revoked',
      at: '2026-10-05T00:00:00.000Z',
    });
    const result = decide({
      authorization: revokedAuth,
      riskTier: riskTier({ authorization: { valid: false, withinScope: true, amountWithinLimit: true } }),
    });
    expect(result.decision).toBe('DENY');
    expect(result.standingAuthorizationDecision).toBe('DENY');
    expect(result.standingAuthorizationReasonCodes).toContain('STANDING_AUTH_REVOKED');
  });

  it('④ 已过期 → DENY', () => {
    const result = evaluateStandingAuthorization({
      authorization: authorization(),
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
      },
      now: new Date('2027-11-01T00:00:00.000Z'),
    });
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toContain('STANDING_AUTH_EXPIRED');
  });
});

describe('SA 验收 5–8：超范围 / 高金额不可绕过', () => {
  it('⑤ 金额超 scope → REQUIRE_APPROVAL（不是放行）', () => {
    const result = evaluateStandingAuthorization({
      authorization: authorization(),
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 1_500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
      },
      now: NOW,
    });
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCodes).toContain('STANDING_AUTH_AMOUNT_EXCEEDS_LIMIT');
  });

  it('⑥ action 超 scope → REQUIRE_APPROVAL', () => {
    const result = evaluateStandingAuthorization({
      authorization: authorization({ allowedActionTypes: ['claim.prepare'] }),
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
      },
      now: NOW,
    });
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCodes).toContain('STANDING_AUTH_ACTION_NOT_ALLOWED');
  });

  it('⑦ account / provider 不匹配 → DENY（隔离不可被授权绕过）', () => {
    const otherAccount = evaluateStandingAuthorization({
      authorization: authorization(),
      request: {
        organizationId: ORG,
        platformAccountId: 'acct-other',
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
      },
      now: NOW,
    });
    expect(otherAccount.decision).toBe('DENY');
    expect(otherAccount.reasonCodes).toContain('STANDING_AUTH_ACCOUNT_MISMATCH');

    const otherProvider = evaluateStandingAuthorization({
      authorization: authorization(),
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'TIKTOK',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
      },
      now: NOW,
    });
    expect(otherProvider.decision).toBe('DENY');
    expect(otherProvider.reasonCodes).toContain('STANDING_AUTH_PROVIDER_MISMATCH');
  });

  it('⑧ 高金额规则不可绕过：>1,000 → TIER_2/OWNER；≥10,000 → TIER_3/ADMIN', () => {
    const elevated = riskTier({ amountUsd: 1_500 });
    expect(elevated.tier).toBe('TIER_2_ELEVATED');
    expect(elevated.requiredApprovalRole).toBe('OWNER');
    expect(elevated.highValueHitl.applicable).toBe(true);

    const admin = riskTier({ amountUsd: 12_000 });
    expect(admin.tier).toBe('TIER_3_REGULATED_HIGH_RISK');
    expect(admin.requiredApprovalRole).toBe('ADMIN');
    expect(RISK_TIER_BOUNDARY.highValueHitl).toBe('KEEP');

    // 即使授权允许到 5,000，2,000 仍必须 HITL
    const result = decide({
      authorization: authorization({ monetaryLimitUsd: 5_000 }),
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 2_000,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
        expectedAuthorizationVersion: 1,
        expectedTermsPolicyVersion: 'terms/v1',
      },
      riskTier: riskTier({ amountUsd: 2_000 }),
    });
    expect(result.decision).toBe('REQUIRE_APPROVAL');
    expect(result.reasonCodes).toContain('HIGH_VALUE_HITL_KEPT');
  });
});

describe('SA 验收 9–12：POA 边界 / 生产 gate / exactly-once / 版本失效', () => {
  it('⑨ Customs POA 不能被 Standing Authorization 替代（受监管 → TIER_3 + REGULATORY；POA 未满足 → DENY）', () => {
    const customsAction = 'customs.recovery.start';
    const customsGuard = evaluateActionGuard({
      action: customsAction,
      actorUserId: 'user-1',
      organizationId: ORG,
      capabilities: { featureEnabled: { [customsAction]: true }, tenantEnabled: true },
    });
    const customsAuthorization = authorization({
      allowedActionTypes: [customsAction],
      provider: 'CBP',
      domain: 'CUSTOMS',
      monetaryLimitUsd: 5_000,
    });
    const result = evaluateAutonomousExecution({
      guard: customsGuard,
      authorization: customsAuthorization,
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'CBP',
        action: customsAction,
        amountUsd: 500,
        currency: 'USD',
        domain: 'CUSTOMS',
        jurisdiction: 'US',
        expectedAuthorizationVersion: 1,
        expectedTermsPolicyVersion: 'terms/v1',
      },
      riskTier: classifyRiskTier(
        {
          action: customsAction,
          amountUsd: 500,
          provider: 'CBP',
          domain: 'CUSTOMS',
          jurisdiction: 'US',
          evidence: { completeness: 'COMPLETE', conflicts: [] },
          authorization: { valid: true, withinScope: true, amountWithinLimit: true },
          experienceDecisionSupport: 'ADVISORY',
          experienceSuccessRateBp: 8_000,
        },
        NOW,
      ),
      gates: { productionGate: 'SATISFIED' },
      now: NOW,
    });
    expect(result.riskTier).toBe('TIER_3_REGULATED_HIGH_RISK');
    expect(result.decision).toBe('REQUIRE_APPROVAL');

    const poaMissing = decide({ gates: { productionGate: 'SATISFIED', customsPoaRequired: true, customsPoaSatisfied: false } });
    expect(poaMissing.decision).toBe('DENY');
    expect(poaMissing.blockingGates).toContain('customsPoaGate');

    expect(CUSTOMS_POA_BOUNDARY.standingAuthorizationIsBrokerPoa).toBe(false);
    expect(CUSTOMS_POA_BOUNDARY.platformOAuthIsBrokerPoa).toBe(false);
    expect(() => assertStandingAuthorizationIsNotBrokerPoa({ standingAuthorizationIsBrokerPoa: true })).toThrowError(
      ActionGuardWiringError,
    );
  });

  it('⑩ Production Gate=false 时，即使授权有效也不得外写（DENY，非 REQUIRE_APPROVAL）', () => {
    const result = decide({ gates: { productionGate: 'NOT_SATISFIED' } });
    expect(result.decision).toBe('DENY');
    expect(result.blockingGates).toContain('productionGate');
    expect(result.reasonCodes).toContain('NON_BYPASSABLE_GATE_BLOCKED:productionGate');
    expect(result.externalWritePerformed).toBe(false);
  });

  it('⑩b Kill Switch / 凭据 / 通道能力 / 法规限制 / 隔离 任一不满足 → DENY', () => {
    const cases: Array<[string, AutonomousExecutionInput['gates']]> = [
      ['killSwitch', { productionGate: 'SATISFIED', killSwitchActive: true }],
      ['credentialGate', { productionGate: 'SATISFIED', credentialReady: false }],
      ['providerCapability', { productionGate: 'SATISFIED', providerCapabilityReady: false }],
      ['regulatoryRestriction', { productionGate: 'SATISFIED', regulatoryRestriction: 'CUSTOMS_FILING_SUSPENDED' }],
      ['tenantAccountIsolation', { productionGate: 'SATISFIED', tenantAccountIsolationOk: false }],
      ['platformEnablement', { productionGate: 'SATISFIED', platformEnablement: false }],
    ];
    for (const [gate, gates] of cases) {
      const result = decide({ gates });
      expect(result.decision).toBe('DENY');
      expect(result.blockingGates).toContain(gate);
    }
  });

  it('⑪ 重复调用保持 exactly-once 语义：判定稳定、摘要一致、无任何执行副作用', () => {
    const a = decide();
    const b = decide();
    expect(a.decision).toBe(b.decision);
    expect(a.wiringDigest).toBe(b.wiringDigest);
    expect(a.executionPerformed).toBe(false);
    expect(b.executionPerformed).toBe(false);
    expect(a.satisfiedGates).toEqual(['humanApproval']);
  });

  it('⑫ authorization version change 后旧执行权不能继续使用（版本不匹配 → DENY）', () => {
    const bumped = bumpStandingAuthorizationVersion(authorization(), { authorizationVersion: 2 });
    const stale = evaluateStandingAuthorization({
      authorization: bumped,
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
        expectedAuthorizationVersion: 1,
      },
      now: NOW,
    });
    expect(stale.decision).toBe('DENY');
    expect(stale.reasonCodes).toContain('STANDING_AUTH_VERSION_STALE');

    const aligned = evaluateStandingAuthorization({
      authorization: bumped,
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
        expectedAuthorizationVersion: 2,
        expectedTermsPolicyVersion: 'terms/v1',
      },
      now: NOW,
    });
    expect(aligned.decision).toBe('SATISFIED');
  });
});

describe('SA — 记录完整性、防伪与边界常量', () => {
  it('客户端自报授权被拒绝；scope digest 被篡改 → DENY', () => {
    expect(() => authorization({ serverDerived: false })).toThrowError(StandingAuthorizationError);

    const tampered = { ...authorization(), monetaryLimitUsd: 999_999 };
    const result = evaluateStandingAuthorization({
      authorization: tampered,
      request: {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: 'AMAZON',
        action: ACTION,
        amountUsd: 500,
        currency: 'USD',
        domain: 'PLATFORM',
        jurisdiction: 'US',
      },
      now: NOW,
    });
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toContain('STANDING_AUTH_SCOPE_DIGEST_MISMATCH');
  });

  it('scope digest 对 scope 变化敏感（版本 / 上限 / 动作集合）', () => {
    const base = authorization();
    const baseish = computeStandingAuthorizationScopeDigest(base);
    expect(baseish).toBe(base.scopeDigest);
    const changed = computeStandingAuthorizationScopeDigest({ ...base, monetaryLimitUsd: base.monetaryLimitUsd + 1 });
    expect(changed).not.toBe(base.scopeDigest);
  });

  it('风险分级是多维的（≥8 维参与；自定义/受监管动作即使金额为 0 也是 TIER_3）', () => {
    const tier = riskTier({ amountUsd: 0 });
    expect(tier.evaluatedDimensions.length).toBeGreaterThanOrEqual(8);
    expect(tier.evaluatedDimensions).toContain('ACTION_TYPE');
    expect(tier.evaluatedDimensions).toContain('REGULATORY_REQUIREMENTS');

    const regulatedZeroAmount = classifyRiskTier(
      {
        action: 'customs.recovery.start',
        amountUsd: 0,
        provider: 'CBP',
        domain: 'CUSTOMS',
        jurisdiction: 'US',
        evidence: { completeness: 'COMPLETE', conflicts: [] },
        authorization: { valid: true, withinScope: true, amountWithinLimit: true },
        experienceDecisionSupport: 'ADVISORY',
        experienceSuccessRateBp: 9_000,
      },
      NOW,
    );
    expect(regulatedZeroAmount.tier).toBe('TIER_3_REGULATED_HIGH_RISK');
    expect(regulatedZeroAmount.triggeredDimensions).toContain('REGULATORY_REQUIREMENTS');
  });

  it('边界常量：复用既有 Guard、不建第二 Guard、只满足 humanApproval、高金额保留、不执行', () => {
    expect(ACTION_GUARD_WIRING_BOUNDARY.reusesExistingActionGuard).toBe(true);
    expect(ACTION_GUARD_WIRING_BOUNDARY.createsSecondGuard).toBe(false);
    expect(ACTION_GUARD_WIRING_BOUNDARY.keepsOneTimeHumanApproval).toBe(true);
    expect(ACTION_GUARD_WIRING_BOUNDARY.standingAuthorizationSatisfiesOnly).toEqual(['humanApproval']);
    expect(ACTION_GUARD_WIRING_BOUNDARY.highValueHitl).toBe('KEEP');
    expect(ACTION_GUARD_WIRING_BOUNDARY.executesActions).toBe(false);
    expect(ACTION_GUARD_WIRING_BOUNDARY.externalWritePerformed).toBe(false);
    expect(ACTION_GUARD_WIRING_BOUNDARY.nonBypassableGates).toEqual(STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES);
  });

  it('越权断言：授权不得声称满足任何非可绕过 gate', () => {
    expect(() => assertNoNonBypassableGateSatisfiedByStanding(['humanApproval'])).not.toThrow();
    for (const gate of STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES) {
      expect(() => assertNoNonBypassableGateSatisfiedByStanding([gate])).toThrowError(ActionGuardWiringError);
    }
  });

  it('确定性：同一判定重复计算摘要一致；授权不同 → 摘要不同', () => {
    const a = decide();
    const b = decide();
    const c = decide({ authorization: null });
    expect(a.wiringDigest).toBe(b.wiringDigest);
    expect(a.wiringDigest).not.toBe(c.wiringDigest);
    expect(a.wiringDigest).toHaveLength(64);
    expect(a.evaluatedAt).toBe(NOW.toISOString());
    expect(LATER.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
