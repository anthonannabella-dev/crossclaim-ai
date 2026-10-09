/**
 * PHASE 3-A — U1：只读权威可信事实适配器 → 真实 PostgreSQL 只读端口测试
 * 修订：CHANGE 17–20（MSG-20261009-15）+ **CHANGE 24–25**（MSG-20261009-16 / U1 FINAL-R3）
 * 说明：被测对象是**只读**端口；本文件中的写入仅用于**准备夹具**（seed）与**只读探针**（探针必定被拒绝）。
 *
 * 独立证据（CHANGE 25）—— 通过 `U1_EVIDENCE {...}` 结构化行输出，供证据包构建器采集：
 *   ① 两条拒绝写入探针**各自独立事务**，并分别带出自身 PostgreSQL 原始错误（错误文本含 verb，证明第二条不是「事务已中止」）；
 *   ② 在**公共 U1 入口**（`resolve()` → 端口 `withReadOnlyTransaction`）实际使用的只读事务内，
 *      读取 `current_setting('transaction_read_only')` 并再次尝试写入，证明真实路径确实位于只读事务；
 *   ③ 七张相关表的计数 + **关键记录摘要**（Organization.updatedAt、授权行 id/version/revocationState/scopeDigest）前后一致。
 */

import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  READ_ONLY_TRANSACTION_SQL,
  createPrismaTrustedFactsReadPort,
  createTrustedFactsAdapter,
  runInReadOnlyTransaction,
  type TrustedFactsReadPort,
  type TrustedFactsResourceScope,
  type TrustedFactsScopeDimension,
} from '../services/self-repair/trusted-facts-adapter';

import { testDatabaseMarker } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const AT = new Date('2026-10-09T04:00:00.000Z');
const ORG = 'org-u1-db';
const SCOPE: TrustedFactsResourceScope = {
  platformAccountId: 'acct-u1',
  provider: 'AMAZON',
  domain: 'LOGISTICS',
  jurisdiction: 'US',
};

const evidence = (payload: Record<string, unknown>): void => {
  console.log('U1_EVIDENCE ' + JSON.stringify(payload));
};

const adapter = (
  options: {
    caller?: string;
    scope?: TrustedFactsResourceScope;
    notApplicable?: readonly TrustedFactsScopeDimension[];
    wrapPort?: (port: TrustedFactsReadPort) => TrustedFactsReadPort;
  } = {},
) => {
  const basePort = createPrismaTrustedFactsReadPort({ prisma });
  const readPort = options.wrapPort === undefined ? basePort : options.wrapPort(basePort);
  return createTrustedFactsAdapter({
    readPort,
    executionContext: {
      subjectRef: 'runtime-member-1',
      caller: options.caller ?? 'RUNTIME_MEMBER',
      operationRecheck: 'CONFIRMED_READ_ONLY',
      resourceScope: 'scope' in options ? options.scope : SCOPE,
      notApplicableScopeDimensions: options.notApplicable,
    },
    now: () => AT,
  });
};

async function seedOrganization(): Promise<void> {
  await prisma.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: ORG, slug: ORG },
    update: {},
  });
}

async function seedAuthorization(
  overrides: {
    authorizationVersion?: number;
    revocationState?: string;
    effectiveAt?: Date;
    expiresAt?: Date;
    allowedActionTypes?: string[];
    monetaryLimitUsd?: string;
    currency?: string;
    provider?: string;
    platformAccountId?: string;
    domain?: string;
    jurisdiction?: string;
  } = {},
): Promise<void> {
  await seedOrganization();
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: overrides.platformAccountId ?? 'acct-u1',
      provider: overrides.provider ?? 'AMAZON',
      allowedActionTypes: overrides.allowedActionTypes ?? ['recovery.read'],
      monetaryLimitUsd: overrides.monetaryLimitUsd ?? '50.0000',
      currency: overrides.currency ?? 'USD',
      domain: overrides.domain ?? 'LOGISTICS',
      jurisdiction: overrides.jurisdiction ?? 'US',
      effectiveAt: overrides.effectiveAt ?? new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: overrides.expiresAt ?? new Date('2026-11-01T00:00:00.000Z'),
      authorizationVersion: overrides.authorizationVersion ?? 3,
      termsPolicyVersion: 'v1',
      consentEvidenceRef: 'evidence://u1-seed',
      scopeDigest: 'b'.repeat(64),
      revocationState: overrides.revocationState ?? 'ACTIVE',
      createdAt: AT,
      ...(overrides.revocationState === undefined || overrides.revocationState === 'ACTIVE'
        ? {}
        : { revokedAt: AT, revokedBy: 'owner@example.test', revocationReason: 'TEST_REVOKE' }),
    },
  });
}

/** CHANGE 25：七张相关表计数 + 关键记录摘要（内容级证据，不止计数） */
async function snapshot(): Promise<Record<string, unknown>> {
  const organization = await prisma.organization.findUnique({
    where: { id: ORG },
    select: { id: true, updatedAt: true },
  });
  const authorizations = await prisma.standingAuthorization.findMany({
    where: { organizationId: ORG },
    orderBy: { authorizationVersion: 'asc' },
    select: { id: true, authorizationVersion: true, revocationState: true, scopeDigest: true },
  });
  return {
    counts: {
      organization: await prisma.organization.count(),
      standingAuthorization: await prisma.standingAuthorization.count(),
      auditLog: await prisma.auditLog.count(),
      recoveryOpportunity: await prisma.recoveryOpportunity.count(),
      autonomyTask: await prisma.autonomyTask.count(),
      autonomyLease: await prisma.autonomyLease.count(),
      autonomyIncident: await prisma.autonomyIncident.count(),
    },
    organization: organization === null ? null : { id: organization.id, updatedAt: organization.updatedAt.toISOString() },
    authorizationDigests: authorizations.map(
      (row) => `${row.id}:${row.authorizationVersion}:${row.revocationState}:${row.scopeDigest}`,
    ),
  };
}

beforeEach(async () => {
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe(`PHASE 3-A / U1 可信事实适配器 — 真实 PostgreSQL（${testDatabaseMarker()}）`, () => {
  it('U1-DB1 真实组织 + 有效授权 + 可信范围 ⇒ 解析成功，provenance 含 authorizationId / scopePolicy / factVersion', async () => {
    await seedAuthorization();
    const result = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.facts.organizationIdResolved).toBe(true);
    expect(result.facts.authorizationActive).toBe(true);
    expect(result.provenance.authorizationActive?.authorizationId).toMatch(/\S/);
    expect(result.provenance.authorizationActive?.authorizationVersion).toBe(3);
    expect(result.provenance.readScope.statement).toBe(READ_ONLY_TRANSACTION_SQL);
    expect(result.provenance.scopePolicy.required).toEqual(['platformAccountId', 'provider']);
    expect(result.provenance.factVersion).toMatch(/^org:.+\|auth:3$/);
  });

  it('U1-DB2 组织不存在 ⇒ ORGANIZATION_NOT_FOUND（fail-closed）', async () => {
    const result = await adapter().resolve({ organizationId: 'org-does-not-exist', actionType: 'recovery.read', monetaryAction: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('U1-DB3 撤销 / 过期 / 动作不允许 / 币种不符 / 超限 / 缺金额声明 / 缺必需范围 ⇒ 一律 fail-closed', async () => {
    await seedAuthorization({ revocationState: 'REVOKED' });
    const revoked = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(!revoked.ok && revoked.reason).toBe('AUTHORIZATION_REVOKED');
    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });

    await seedAuthorization({ expiresAt: new Date('2026-10-08T00:00:00.000Z') });
    const expired = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(!expired.ok && expired.reason).toBe('AUTHORIZATION_NOT_EFFECTIVE');
    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });

    await seedAuthorization({ allowedActionTypes: ['recovery.read'] });
    const notAllowed = await adapter().resolve({ organizationId: ORG, actionType: 'internal.repair.propose', monetaryAction: false });
    expect(!notAllowed.ok && notAllowed.reason).toBe('ACTION_TYPE_NOT_ALLOWED');

    const missingMonetaryDeclaration = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
    } as never);
    expect(!missingMonetaryDeclaration.ok && missingMonetaryDeclaration.reason).toBe('MONETARY_INPUT_INVALID');

    const missingScope = await adapter({ scope: undefined }).resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
    });
    expect(!missingScope.ok && missingScope.reason).toBe('REQUIRED_SCOPE_MISSING');

    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
    await seedAuthorization({ currency: 'EUR' });
    const currencyMismatch = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: true,
      amountUsd: '1.0000',
      currency: 'USD',
    });
    expect(!currencyMismatch.ok && currencyMismatch.reason).toBe('MONETARY_INPUT_INVALID');
    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });

    await seedAuthorization({ monetaryLimitUsd: '10.0000' });
    const overLimit = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: true,
      amountUsd: '10.0001',
      currency: 'USD',
    });
    expect(!overLimit.ok && overLimit.reason).toBe('MONETARY_LIMIT_EXCEEDED');
  });

  it('U1-DB4 同组织同范围两条有效授权 ⇒ AUTHORIZATION_AMBIGUOUS（不取「最高版本」）', async () => {
    await seedAuthorization({ authorizationVersion: 3 });
    await seedAuthorization({ authorizationVersion: 4 });
    const ambiguous = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(!ambiguous.ok && ambiguous.reason).toBe('AUTHORIZATION_AMBIGUOUS');
  });

  it('U1-DB5（CHANGE 24）单授权错误范围：跨账户 / 跨 Provider / 跨 jurisdiction / 跨 domain 一律 fail-closed', async () => {
    await seedAuthorization();
    const cases: readonly (readonly [string, TrustedFactsResourceScope])[] = [
      ['跨账户', { ...SCOPE, platformAccountId: 'acct-other' }],
      ['跨 Provider', { ...SCOPE, provider: 'SHOPIFY' }],
      ['跨 jurisdiction（可选维度）', { ...SCOPE, jurisdiction: 'JP' }],
      ['跨 domain（可选维度）', { ...SCOPE, domain: 'FINANCE' }],
    ];
    const observed: string[] = [];
    for (const [label, scope] of cases) {
      const result = await adapter({ scope }).resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
      expect([label, result.ok, result.ok ? null : result.reason]).toEqual([label, false, 'AUTHORIZATION_NOT_FOUND']);
      observed.push(`${label}=${result.ok ? 'OK' : (result as { reason: string }).reason}`);
    }
    evidence({ kind: 'SINGLE_AUTHORIZATION_SCOPE_NEGATIVES', org: ORG, results: observed });
  });

  it('U1-DB6（CHANGE 20/25）只读证据：两条独立事务拒写探针 + 公共入口事务内写入被拒', async () => {
    await seedAuthorization();

    // ① 两条拒写探针：各自独立事务，各自带出 PostgreSQL 原始错误
    const probes = [
      { label: 'DELETE_IN_READ_ONLY_TX', verb: 'DELETE', sql: `DELETE FROM "StandingAuthorization" WHERE "id" = 'u1-probe-nonexistent'` },
      { label: 'CREATE_TABLE_IN_READ_ONLY_TX', verb: 'CREATE TABLE', sql: 'CREATE TABLE IF NOT EXISTS "u1_readonly_probe" ("x" int)' },
    ] as const;
    const probeResults: { label: string; errorName: string | null; errorMessage: string | null }[] = [];
    for (const probe of probes) {
      let errorName: string | null = null;
      let errorMessage: string | null = null;
      try {
        await runInReadOnlyTransaction(prisma, (tx) => tx.$executeRawUnsafe(probe.sql));
      } catch (error) {
        errorName = error instanceof Error ? error.constructor.name : 'NonError';
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      probeResults.push({ label: probe.label, errorName, errorMessage });
      evidence({
        kind: 'WRITE_PROBE',
        label: probe.label,
        verb: probe.verb,
        independentTransaction: true,
        statement: probe.sql,
        errorName,
        errorMessage,
      });
      expect(errorName).not.toBeNull();
      expect(errorMessage ?? '').toMatch(/read-only/i);
    }
    // 独立性证明：两条错误分别指向自身语句的动词（不是「事务已中止」的连带错误）
    expect(probeResults[0]!.errorMessage ?? '').toMatch(/DELETE/i);
    expect(probeResults[1]!.errorMessage ?? '').toMatch(/CREATE TABLE/i);

    // ② 公共入口（resolve → 端口 withReadOnlyTransaction）实际使用的只读事务内再做写入
    let publicEntry: Record<string, unknown> | null = null;
    const wrapPort = (basePort: TrustedFactsReadPort): TrustedFactsReadPort => ({
      findOrganization: (input) => basePort.findOrganization(input),
      listStandingAuthorizations: (input) => basePort.listStandingAuthorizations(input),
      withReadOnlyTransaction: async <T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
        basePort.withReadOnlyTransaction(async (tx) => {
          const result = await run(tx);
          const settings = await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>(
            `SELECT current_setting('transaction_read_only') AS transaction_read_only`,
          );
          let writeError: unknown = null;
          try {
            await tx.$executeRawUnsafe(`DELETE FROM "StandingAuthorization" WHERE "id" = 'u1-public-entry-probe'`);
          } catch (error) {
            writeError = error;
          }
          publicEntry = {
            path: 'createTrustedFactsAdapter.resolve → TrustedFactsReadPort.withReadOnlyTransaction',
            transactionReadOnly: settings[0]?.transaction_read_only ?? null,
            resolvedOk: (result as { ok?: boolean } | null)?.ok === true,
            writeRejected: writeError !== null,
            writeErrorName: writeError === null ? null : (writeError as Error).constructor?.name ?? 'Error',
            writeErrorMessage: writeError === null ? null : String((writeError as Error).message),
          };
          return result;
        }),
    });
    const resolved = await adapter({ wrapPort }).resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(resolved.ok).toBe(true);
    expect(publicEntry).not.toBeNull();
    const entry = publicEntry as unknown as {
      transactionReadOnly: string | null;
      resolvedOk: boolean;
      writeRejected: boolean;
      writeErrorMessage: string | null;
    };
    expect(entry.transactionReadOnly).toBe('on');
    expect(entry.resolvedOk).toBe(true);
    expect(entry.writeRejected).toBe(true);
    expect(entry.writeErrorMessage ?? '').toMatch(/read-only/i);
    evidence({ kind: 'PUBLIC_ENTRY_PROBE', ...entry, independentTransaction: false });

    // ③ 调用方白名单在真实路径同样生效
    const untrustedCaller = await adapter({ caller: 'MODEL' }).resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
    });
    expect(!untrustedCaller.ok && untrustedCaller.reason).toBe('CALLER_NOT_TRUSTED');
  });

  it('U1-DB7（CHANGE 20/25）解析前后七张相关表计数与关键记录摘要一致', async () => {
    await seedAuthorization();
    const before = await snapshot();
    const resolved = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(resolved.ok).toBe(true);
    const after = await snapshot();
    expect(after).toEqual(before);
    evidence({ kind: 'TABLE_SNAPSHOT', before, after, identical: JSON.stringify(before) === JSON.stringify(after) });
  });

  it('U1-DB8（CHANGE 27）范围声明链：省略可选维度必须显式声明不适用；请求侧夹带 resourceScope 无效', async () => {
    await seedAuthorization();
    const observed: Record<string, string> = {};

    // ① 省略可选维度且未声明不适用 ⇒ fail-closed（不得靠「没传」放大范围）
    const undeclared = await adapter({ scope: { platformAccountId: 'acct-u1', provider: 'AMAZON' } }).resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
    });
    observed.omittedOptionalWithoutDeclaration = undeclared.ok ? 'OK' : undeclared.reason;
    expect(!undeclared.ok && undeclared.reason).toBe('OPTIONAL_SCOPE_UNDECLARED');

    // ② 同一省略 + 服务端显式声明不适用 ⇒ 通过，且 provenance 留痕
    const declared = await adapter({
      scope: { platformAccountId: 'acct-u1', provider: 'AMAZON' },
      notApplicable: ['domain', 'jurisdiction'],
    }).resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(declared.ok).toBe(true);
    if (declared.ok) {
      observed.explicitNotApplicable = 'OK';
      observed.providedDimensions = declared.provenance.scopePolicy.providedDimensions.join('+');
      observed.notApplicableDimensions = declared.provenance.scopePolicy.notApplicableDimensions.join('+');
      expect(declared.provenance.scopePolicy.providedDimensions).toEqual(['provider', 'platformAccountId']);
      expect(declared.provenance.scopePolicy.notApplicableDimensions).toEqual(['domain', 'jurisdiction']);
    }

    // ③ 请求侧夹带 resourceScope：既不改变匹配结果，也不能替代可信上下文的必需维度
    const smuggled = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
      resourceScope: { provider: 'SHOPIFY', platformAccountId: 'acct-other' },
    } as never);
    expect(smuggled.ok).toBe(true);
    observed.requestSideScopeIgnored = smuggled.ok ? 'IGNORED_OK' : 'NOT_OK';

    const smuggledCannotSatisfyRequired = await adapter({ scope: { provider: 'AMAZON' } }).resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
      resourceScope: { platformAccountId: 'acct-u1' },
    } as never);
    expect(!smuggledCannotSatisfyRequired.ok && smuggledCannotSatisfyRequired.reason).toBe('REQUIRED_SCOPE_MISSING');
    observed.requestSideScopeCannotSatisfyRequired = 'REQUIRED_SCOPE_MISSING';

    evidence({
      kind: 'SCOPE_DECLARATION_CHAIN',
      scopeSource: 'executionContext.resourceScope（服务端注入）；请求入参无该字段',
      notApplicableSource: 'executionContext.notApplicableScopeDimensions（服务端显式声明）',
      results: observed,
    });
  });
});
