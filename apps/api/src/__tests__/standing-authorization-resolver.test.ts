// STANDING AUTHORIZATION — SA-3b — 调用点解析器回归
// ---------------------------------------------------------------------------
// 覆盖：无授权（未声明自动执行 → null / 声明 → DENY）、撤销与过期（声明 → DENY；未声明 → null 不阻断一次性审批）、
// 有效授权 + TIER_1 → ALLOW、超金额/受监管/证据冲突/无历史置信度 → REQUIRE_APPROVAL、
// 非可绕过 gate 未满足 → DENY、确定性（重复调用一致）。

import { describe, expect, it } from 'vitest';

import {
  resolveStandingAuthorizationAlternative,
  type ResolveStandingAuthorizationInput,
} from '../services/standing-authorization/standing-authorization-resolver';
import {
  createStandingAuthorization,
  revokeStandingAuthorization,
  type StandingAuthorizationRecord,
} from '../services/standing-authorization/standing-authorization';

const NOW = new Date('2026-10-06T13:00:00.000Z');
const ORG = 'org-sa3b-1';
const ACCT = 'acct-sa3b-a';
const ACTION = 'recovery.manual_submit';

function authorization(overrides: Partial<Parameters<typeof createStandingAuthorization>[0]> = {}) {
  return createStandingAuthorization({
    serverDerived: true,
    authorizationId: 'sa-3b',
    organizationId: ORG,
    platformAccountId: ACCT,
    provider: 'AMAZON',
    allowedActionTypes: [ACTION, 'claim.submit'],
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

function input(
  record: StandingAuthorizationRecord | null,
  overrides: Partial<ResolveStandingAuthorizationInput> = {},
): ResolveStandingAuthorizationInput {
  return {
    deps: { loadAuthorization: async () => record },
    request: {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: 'AMAZON',
      action: ACTION,
      amountUsd: 400,
      currency: 'USD',
      domain: 'PLATFORM',
      jurisdiction: 'US',
      expectedAuthorizationVersion: record?.authorizationVersion ?? 1,
      expectedTermsPolicyVersion: record?.termsPolicyVersion ?? 'terms/v1',
    },
    requestedAutoExecution: true,
    riskContext: {
      evidence: { completeness: 'COMPLETE', conflicts: [] },
      experienceDecisionSupport: 'ADVISORY',
      experienceSuccessRateBp: 7_000,
      providerTermsFlags: [],
      regulatoryFlags: [],
    },
    gates: {
      productionGate: 'SATISFIED',
      platformEnablement: true,
      killSwitchActive: false,
      providerCapabilityReady: true,
      credentialReady: true,
      regulatoryRestriction: null,
      tenantAccountIsolationOk: true,
    },
    guard: {
      decision: 'REQUIRE_APPROVAL',
      code: 'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
      action: ACTION,
      risk: 'INTERNAL_WRITE',
      requiredGates: ['humanApproval'],
    },
    now: NOW,
    ...overrides,
  };
}

describe('SA-3b 解析器 — 授权可得性', () => {
  it('有效授权 + 低风险 + gate 满足 → ALLOW（authorizedBy=STANDING_AUTHORIZATION，satisfiedGates=[humanApproval]）', async () => {
    const alternative = await resolveStandingAuthorizationAlternative(input(authorization()));
    expect(alternative).toEqual({
      decision: 'ALLOW',
      authorizedBy: 'STANDING_AUTHORIZATION',
      satisfiedGates: ['humanApproval'],
      action: ACTION,
    });
  });

  it('无授权：未声明自动执行 → null（既有一次性审批路径完全不受影响）', async () => {
    expect(
      await resolveStandingAuthorizationAlternative(input(null, { requestedAutoExecution: false })),
    ).toBeNull();
  });

  it('无授权：声明自动执行 → DENY（没有授权不得自动执行）', async () => {
    const alternative = await resolveStandingAuthorizationAlternative(input(null));
    expect(alternative?.decision).toBe('DENY');
  });

  it('已撤销：声明自动执行 → DENY；未声明 → null（不阻断一次性人工审批）', async () => {
    const revoked = revokeStandingAuthorization(authorization(), {
      revokedBy: 'owner-1',
      reason: 'customer revoked',
      at: '2026-10-05T00:00:00.000Z',
    });
    expect((await resolveStandingAuthorizationAlternative(input(revoked)))?.decision).toBe('DENY');
    expect(
      await resolveStandingAuthorizationAlternative(input(revoked, { requestedAutoExecution: false })),
    ).toBeNull();
  });

  it('已过期：声明自动执行 → DENY', async () => {
    const alternative = await resolveStandingAuthorizationAlternative(
      input(authorization(), { now: new Date('2027-11-01T00:00:00.000Z') }),
    );
    expect(alternative?.decision).toBe('DENY');
  });

  it('授权版本过期（expectedAuthorizationVersion 落后）→ DENY', async () => {
    const record = authorization({ authorizationVersion: 2 });
    const alternative = await resolveStandingAuthorizationAlternative(
      input(record, { request: { ...input(record).request, expectedAuthorizationVersion: 1 } }),
    );
    expect(alternative?.decision).toBe('DENY');
  });

  it('account / provider 不匹配 → DENY（声明自动执行时）', async () => {
    const alternative = await resolveStandingAuthorizationAlternative(
      input(authorization(), {
        request: { ...input(authorization()).request, platformAccountId: 'acct-other' },
      }),
    );
    expect(alternative?.decision).toBe('DENY');
  });
});

describe('SA-3b 解析器 — 回退 HITL 与 gate 阻断', () => {
  it('金额超授权上限 → REQUIRE_APPROVAL（交回 HITL，而不是放行或拒绝）', async () => {
    const record = authorization();
    const alternative = await resolveStandingAuthorizationAlternative(
      input(record, { request: { ...input(record).request, amountUsd: 1_500 } }),
    );
    expect(alternative?.decision).toBe('REQUIRE_APPROVAL');
  });

  it('高金额（>1,000 且超授权上限 5,000 内仍触发规则）→ REQUIRE_APPROVAL', async () => {
    const record = authorization({ monetaryLimitUsd: 5_000 });
    const alternative = await resolveStandingAuthorizationAlternative(
      input(record, { request: { ...input(record).request, amountUsd: 2_000 } }),
    );
    expect(alternative?.decision).toBe('REQUIRE_APPROVAL');
  });

  it('受监管动作（customs.*）→ 即使授权有效也是 REQUIRE_APPROVAL（TIER_3）', async () => {
    const action = 'customs.recovery.start';
    const record = authorization({ allowedActionTypes: [action], domain: 'CUSTOMS', provider: 'CBP' });
    const alternative = await resolveStandingAuthorizationAlternative(
      input(record, {
        request: {
          organizationId: ORG,
          platformAccountId: ACCT,
          provider: 'CBP',
          action,
          amountUsd: 400,
          currency: 'USD',
          domain: 'CUSTOMS',
          jurisdiction: 'US',
          expectedAuthorizationVersion: record.authorizationVersion,
          expectedTermsPolicyVersion: record.termsPolicyVersion,
        },
        guard: { ...input(record).guard, action },
      }),
    );
    expect(alternative?.decision).toBe('REQUIRE_APPROVAL');
  });

  it('证据冲突 / 无历史置信度 → REQUIRE_APPROVAL（不得仅凭授权自动执行）', async () => {
    const conflict = await resolveStandingAuthorizationAlternative(
      input(authorization(), {
        riskContext: {
          evidence: { completeness: 'PARTIAL', conflicts: ['ENTRY_NUMBER'] },
          experienceDecisionSupport: 'ADVISORY',
          experienceSuccessRateBp: 7_000,
        },
      }),
    );
    expect(conflict?.decision).toBe('REQUIRE_APPROVAL');

    const noExperience = await resolveStandingAuthorizationAlternative(
      input(authorization(), {
        riskContext: {
          evidence: { completeness: 'COMPLETE', conflicts: [] },
          experienceDecisionSupport: null,
          experienceSuccessRateBp: null,
        },
      }),
    );
    expect(noExperience?.decision).toBe('REQUIRE_APPROVAL');
  });

  it('非可绕过 gate 未满足（Production Gate / Kill Switch / POA）→ DENY（授权无权满足）', async () => {
    const production = await resolveStandingAuthorizationAlternative(
      input(authorization(), { gates: { productionGate: 'NOT_SATISFIED' } }),
    );
    expect(production?.decision).toBe('DENY');

    const killSwitch = await resolveStandingAuthorizationAlternative(
      input(authorization(), { gates: { productionGate: 'SATISFIED', killSwitchActive: true } }),
    );
    expect(killSwitch?.decision).toBe('DENY');

    const poa = await resolveStandingAuthorizationAlternative(
      input(authorization(), {
        gates: { productionGate: 'SATISFIED', customsPoaRequired: true, customsPoaSatisfied: false },
      }),
    );
    expect(poa?.decision).toBe('DENY');
  });

  it('AEL FINAL2 / C3：非可绕过 gate 证明缺失 / UNKNOWN → DENY（授权无权满足）', async () => {
    const missing = await resolveStandingAuthorizationAlternative(input(authorization(), { gates: {} }));
    expect(missing?.decision).toBe('DENY');
    expect(missing?.authorizedBy).toBe('NONE');

    const unknownProduction = await resolveStandingAuthorizationAlternative(
      input(authorization(), {
        gates: { productionGate: 'UNKNOWN', killSwitchActive: false, tenantAccountIsolationOk: true },
      }),
    );
    expect(unknownProduction?.decision).toBe('DENY');
  });

  it('Guard 已 DENY → DENY（授权不得把 Guard 的拒绝变成放行）', async () => {
    const alternative = await resolveStandingAuthorizationAlternative(
      input(authorization(), {
        guard: { ...input(authorization()).guard, decision: 'DENY', code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' },
      }),
    );
    expect(alternative?.decision).toBe('DENY');
  });

  it('确定性：同一输入重复解析结果一致', async () => {
    const a = await resolveStandingAuthorizationAlternative(input(authorization()));
    const b = await resolveStandingAuthorizationAlternative(input(authorization()));
    expect(a).toEqual(b);
  });
});
