// AGENT EXPERIENCE LAYER / P0 —— Standing Authorization 耐久承载 · 真实 PostgreSQL 验收
// ---------------------------------------------------------------------------
// 覆盖（HOST P0 要求 13–15 + 安全断言）：
//   * 落库后**进程重启仍可加载**（新 PrismaClient 读取同一行）；
//   * 追加式版本：v2 落库后 v1 行保留；旧 expectedAuthorizationVersion → DENY（VERSION_STALE）；
//   * 撤销留痕（谁/何时/为什么）+ 撤销后 fail-closed（DENY，不回退为 REQUIRE_APPROVAL）+ 重复撤销幂等；
//   * 过期 → DENY；account / provider 不匹配 → DENY；金额超限 → REQUIRE_APPROVAL（不是 DENY）；
//   * tenant 隔离：跨租户加载恒 null；
//   * 数据库级兜底：scope 不可改写 / 负额度 / 非法版本 / 非法状态 / digest 长度 / 撤销不留痕 一律被拒；
//   * 接入既有 resolver 端口（`createPrismaStandingAuthorizationResolverDeps`）→ ALLOW / DENY 与内存端口一致。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { evaluateStandingAuthorization } from '../services/standing-authorization/standing-authorization';
import { resolveStandingAuthorizationAlternative } from '../services/standing-authorization/standing-authorization-resolver';
import {
  StandingAuthorizationStoreError,
  createPrismaStandingAuthorizationResolverDeps,
  listStandingAuthorizations,
  loadStandingAuthorization,
  loadStandingAuthorizationById,
  persistStandingAuthorization,
  revokeStandingAuthorizationScope,
  type StandingAuthorizationDraft,
} from '../services/standing-authorization/standing-authorization-store';

const prisma = new PrismaClient();
const NOW = new Date('2026-10-07T09:00:00.000Z');
const ORG = 'org-sa-p0-1';
const OTHER_ORG = 'org-sa-p0-2';
const ACCT = 'acct-sa-p0-a';
const PROVIDER = 'AMAZON';
const ACTION = 'recovery.manual_submit';

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE "StandingAuthorization" RESTART IDENTITY CASCADE');
}

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
});

function draft(overrides: Partial<StandingAuthorizationDraft> = {}): StandingAuthorizationDraft {
  return {
    serverDerived: true,
    authorizationId: 'sa-p0-1',
    organizationId: ORG,
    platformAccountId: ACCT,
    provider: PROVIDER,
    allowedActionTypes: [ACTION, 'claim.submit', 'appeal.submit'],
    monetaryLimitUsd: 1_000,
    currency: 'USD',
    domain: 'PLATFORM',
    jurisdiction: 'US',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-10-01T00:00:00.000Z',
    authorizationVersion: 1,
    termsPolicyVersion: 'terms/v1',
    consentEvidenceRef: 'consent:ev-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function request(overrides: Partial<Parameters<typeof evaluateStandingAuthorization>[0]['request']> = {}) {
  return {
    organizationId: ORG,
    platformAccountId: ACCT,
    provider: PROVIDER,
    action: ACTION,
    amountUsd: 400,
    currency: 'USD',
    domain: 'PLATFORM',
    jurisdiction: 'US',
    ...overrides,
  };
}

async function countRows(): Promise<number> {
  return prisma.standingAuthorization.count();
}

async function rawInsert(overrides: Record<string, string> = {}): Promise<void> {
  const columns: Record<string, string> = {
    id: `'sa-raw-1'`,
    organizationId: `'${ORG}'`,
    platformAccountId: `'${ACCT}'`,
    provider: `'${PROVIDER}'`,
    allowedActionTypes: `'["recovery.manual_submit"]'::jsonb`,
    monetaryLimitUsd: '100.0000',
    currency: `'USD'`,
    domain: `'PLATFORM'`,
    jurisdiction: `'US'`,
    effectiveAt: `'2026-10-01T00:00:00Z'::timestamp`,
    expiresAt: `'2027-10-01T00:00:00Z'::timestamp`,
    authorizationVersion: '1',
    termsPolicyVersion: `'terms/v1'`,
    consentEvidenceRef: `'consent:1'`,
    revocationState: `'ACTIVE'`,
    revokedAt: 'NULL',
    revokedBy: 'NULL',
    revocationReason: 'NULL',
    scopeDigest: `'${'a'.repeat(64)}'`,
    createdAt: `'2026-10-01T00:00:00Z'::timestamp`,
    ...overrides,
  };
  const names = Object.keys(columns)
    .map((name) => `"${name}"`)
    .join(', ');
  const values = Object.values(columns).join(', ');
  await prisma.$executeRawUnsafe(`INSERT INTO "StandingAuthorization" (${names}) VALUES (${values})`);
}

describe('P0 · Standing Authorization 耐久承载（真实 PostgreSQL）', () => {
  it('PG-SA1 首次落库 → 新连接（进程重启等价）仍可加载，且判定为 SATISFIED', async () => {
    const result = await persistStandingAuthorization(prisma, draft());
    expect(result.kind).toBe('APPENDED');
    expect(result.authorizationId).toBe('sa-p0-1');

    const restarted = new PrismaClient();
    try {
      const loaded = await loadStandingAuthorization(restarted, {
        organizationId: ORG,
        platformAccountId: ACCT,
        provider: PROVIDER,
      });
      expect(loaded).not.toBeNull();
      expect(loaded?.authorizationId).toBe('sa-p0-1');
      // createStandingAuthorization 对 allowedActionTypes 做规范化排序（稳定身份的一部分）
      expect(loaded?.allowedActionTypes).toEqual(['appeal.submit', 'claim.submit', ACTION]);
      expect(loaded?.monetaryLimitUsd).toBe(1_000);
      expect(loaded?.revocation).toEqual({ state: 'ACTIVE', revokedAt: null, revokedBy: null, reason: null });

      const evaluation = evaluateStandingAuthorization({
        authorization: loaded,
        request: request(),
        now: NOW,
      });
      expect(evaluation.decision).toBe('SATISFIED');
      expect(evaluation.satisfiedGate).toBe('humanApproval');
    } finally {
      await restarted.$disconnect();
    }
  });

  it('PG-SA2 同版本重复写入幂等（REUSED，不产生第二行）；scope 不一致 → VERSION_CONFLICT', async () => {
    await persistStandingAuthorization(prisma, draft());
    const replay = await persistStandingAuthorization(prisma, draft());
    expect(replay.kind).toBe('REUSED');
    expect(await countRows()).toBe(1);

    await expect(
      persistStandingAuthorization(prisma, draft({ monetaryLimitUsd: 5_000 })),
    ).rejects.toBeInstanceOf(StandingAuthorizationStoreError);
    expect(await countRows()).toBe(1);
  });

  it('PG-SA2b 并发写入同一版本：恰好 APPENDED 一次 + REUSED 一次，行数 1', async () => {
    const results = await Promise.all([
      persistStandingAuthorization(prisma, draft()),
      persistStandingAuthorization(prisma, draft()),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(['APPENDED', 'REUSED']);
    expect(await countRows()).toBe(1);
  });

  it('PG-SA3 撤销留痕 + 撤销后 DENY（不回退为人工审批）+ 重复撤销幂等', async () => {
    await persistStandingAuthorization(prisma, draft());
    const revoked = await revokeStandingAuthorizationScope(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
      revokedBy: 'owner-1',
      reason: '客户主动撤销',
      at: NOW,
    });
    expect(revoked).toEqual({ revoked: 1, alreadyInactive: 0 });

    const loaded = await loadStandingAuthorization(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
    });
    expect(loaded?.revocation.state).toBe('REVOKED');
    expect(loaded?.revocation.revokedBy).toBe('owner-1');
    expect(loaded?.revocation.reason).toBe('客户主动撤销');
    expect(loaded?.revocation.revokedAt).toBe(NOW.toISOString());

    const evaluation = evaluateStandingAuthorization({
      authorization: loaded,
      request: request(),
      now: NOW,
    });
    expect(evaluation.decision).toBe('DENY');
    expect(evaluation.reasonCodes).toContain('STANDING_AUTH_REVOKED');

    const replay = await revokeStandingAuthorizationScope(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
      revokedBy: 'owner-1',
      reason: '客户主动撤销',
      at: NOW,
    });
    expect(replay).toEqual({ revoked: 0, alreadyInactive: 1 });
  });

  it('PG-SA4 已过期授权 → DENY（STANDING_AUTH_EXPIRED）', async () => {
    await persistStandingAuthorization(
      prisma,
      draft({ authorizationId: 'sa-expired', effectiveAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-06-01T00:00:00.000Z' }),
    );
    const loaded = await loadStandingAuthorization(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
    });
    const evaluation = evaluateStandingAuthorization({ authorization: loaded, request: request(), now: NOW });
    expect(evaluation.decision).toBe('DENY');
    expect(evaluation.reasonCodes).toContain('STANDING_AUTH_EXPIRED');
  });

  it('PG-SA5 追加式版本：v1 行保留、加载取最新版本、旧版本请求 DENY（VERSION_STALE）、撤销覆盖全部版本', async () => {
    await persistStandingAuthorization(prisma, draft());
    await persistStandingAuthorization(
      prisma,
      draft({
        authorizationId: 'sa-p0-2',
        authorizationVersion: 2,
        monetaryLimitUsd: 2_000,
        termsPolicyVersion: 'terms/v2',
        createdAt: '2026-10-05T00:00:00.000Z',
      }),
    );
    expect(await countRows()).toBe(2);

    const loaded = await loadStandingAuthorization(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
    });
    expect(loaded?.authorizationVersion).toBe(2);

    const stale = evaluateStandingAuthorization({
      authorization: loaded,
      request: request({ expectedAuthorizationVersion: 1 }),
      now: NOW,
    });
    expect(stale.decision).toBe('DENY');
    expect(stale.reasonCodes).toContain('STANDING_AUTH_VERSION_STALE');

    const revocation = await revokeStandingAuthorizationScope(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
      revokedBy: 'owner-1',
      reason: 'scope revoke',
      at: NOW,
    });
    expect(revocation.revoked).toBe(2);
    const all = await listStandingAuthorizations(prisma, { organizationId: ORG });
    expect(all).toHaveLength(2);
    expect(all.every((record) => record.revocation.state === 'REVOKED')).toBe(true);
  });

  it('PG-SA6 account 不匹配 → DENY；金额超限 → REQUIRE_APPROVAL（不是 DENY）', async () => {
    await persistStandingAuthorization(prisma, draft());
    const loaded = await loadStandingAuthorization(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
    });

    const accountMismatch = evaluateStandingAuthorization({
      authorization: loaded,
      request: request({ platformAccountId: 'acct-other' }),
      now: NOW,
    });
    expect(accountMismatch.decision).toBe('DENY');
    expect(accountMismatch.reasonCodes).toContain('STANDING_AUTH_ACCOUNT_MISMATCH');

    const amountOverflow = evaluateStandingAuthorization({
      authorization: loaded,
      request: request({ amountUsd: 1_500 }),
      now: NOW,
    });
    expect(amountOverflow.decision).toBe('REQUIRE_APPROVAL');
    expect(amountOverflow.reasonCodes).toContain('STANDING_AUTH_AMOUNT_EXCEEDS_LIMIT');
  });

  it('PG-SA7 tenant 隔离：跨租户加载恒 null（按 scope 与按 id 都如此）', async () => {
    await persistStandingAuthorization(prisma, draft());
    expect(
      await loadStandingAuthorization(prisma, {
        organizationId: OTHER_ORG,
        platformAccountId: ACCT,
        provider: PROVIDER,
      }),
    ).toBeNull();
    expect(
      await loadStandingAuthorizationById(prisma, { organizationId: OTHER_ORG, authorizationId: 'sa-p0-1' }),
    ).toBeNull();
    expect(await listStandingAuthorizations(prisma, { organizationId: OTHER_ORG })).toEqual([]);
  });

  it('PG-SA8 数据库级兜底：scope 改写 / 归属改写 / 非法行 一律被拒', async () => {
    await persistStandingAuthorization(prisma, draft());

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "StandingAuthorization" SET "scopeDigest" = '${'b'.repeat(64)}' WHERE "id" = 'sa-p0-1'`,
      ),
    ).rejects.toThrow(/STANDING_AUTHORIZATION_SCOPE_IMMUTABLE/);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "StandingAuthorization" SET "monetaryLimitUsd" = 999999 WHERE "id" = 'sa-p0-1'`,
      ),
    ).rejects.toThrow(/STANDING_AUTHORIZATION_SCOPE_IMMUTABLE/);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "StandingAuthorization" SET "organizationId" = '${OTHER_ORG}' WHERE "id" = 'sa-p0-1'`,
      ),
    ).rejects.toThrow(/STANDING_AUTHORIZATION_SCOPE_IMMUTABLE|tenant|租户/i);

    await expect(rawInsert({ monetaryLimitUsd: '-1.0000' })).rejects.toThrow(/StandingAuthorization_limit_chk/);
    await expect(rawInsert({ authorizationVersion: '0' })).rejects.toThrow(/StandingAuthorization_version_chk/);
    await expect(rawInsert({ revocationState: `'WEIRD'` })).rejects.toThrow(
      /StandingAuthorization_(state|revocation)_chk/,
    );
    await expect(rawInsert({ scopeDigest: `'short'` })).rejects.toThrow(/StandingAuthorization_digest_chk/);
    await expect(
      rawInsert({ revocationState: `'REVOKED'`, revokedAt: 'NULL', revokedBy: 'NULL' }),
    ).rejects.toThrow(/StandingAuthorization_revocation_chk/);
    await expect(
      rawInsert({ allowedActionTypes: `'{}'::jsonb` }),
    ).rejects.toThrow(/StandingAuthorization_actions_chk/);
  });

  it('PG-SA9 接入既有 resolver 端口：有效授权 → ALLOW；撤销后 → DENY', async () => {
    await persistStandingAuthorization(prisma, draft());
    const deps = createPrismaStandingAuthorizationResolverDeps(prisma);
    const base = {
      deps,
      request: request(),
      requestedAutoExecution: true,
      riskContext: {
        evidence: { completeness: 'COMPLETE' as const, conflicts: [] },
        experienceDecisionSupport: 'ADVISORY' as const,
        experienceSuccessRateBp: 7_000,
        providerTermsFlags: [],
        regulatoryFlags: [],
      },
      gates: {
        productionGate: 'SATISFIED' as const,
        platformEnablement: true,
        killSwitchActive: false,
        providerCapabilityReady: true,
        credentialReady: true,
        regulatoryRestriction: null,
        tenantAccountIsolationOk: true,
      },
      guard: {
        decision: 'REQUIRE_APPROVAL' as const,
        code: 'ACTION_GUARD_HUMAN_APPROVAL_REQUIRED',
        action: ACTION,
        risk: 'INTERNAL_WRITE',
        requiredGates: ['humanApproval'],
      },
      now: NOW,
    };

    const allowed = await resolveStandingAuthorizationAlternative(base);
    expect(allowed).toEqual({
      decision: 'ALLOW',
      authorizedBy: 'STANDING_AUTHORIZATION',
      satisfiedGates: ['humanApproval'],
      action: ACTION,
    });

    await revokeStandingAuthorizationScope(prisma, {
      organizationId: ORG,
      platformAccountId: ACCT,
      provider: PROVIDER,
      revokedBy: 'owner-1',
      reason: 'revoked before execution',
      at: NOW,
    });
    const denied = await resolveStandingAuthorizationAlternative(base);
    expect(denied?.decision).toBe('DENY');
  });
});
