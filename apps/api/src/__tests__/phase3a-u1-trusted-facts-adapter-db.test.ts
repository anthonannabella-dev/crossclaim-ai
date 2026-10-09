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
/** CHANGE 32 并发回归使用的第二 / 第三个组织（同一端口实例、不同租户） */
const ORG_A = 'org-u1-db-a';
const ORG_B = 'org-u1-db-b';
const ORG_MISSING = 'org-u1-db-missing';
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

async function seedOrganization(organizationId: string = ORG): Promise<void> {
  await prisma.organization.upsert({
    where: { id: organizationId },
    create: { id: organizationId, name: organizationId, slug: organizationId },
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
    organizationId?: string;
  } = {},
): Promise<void> {
  const organizationId = overrides.organizationId ?? ORG;
  await seedOrganization(organizationId);
  await prisma.standingAuthorization.create({
    data: {
      organizationId,
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
const CONTENT_TABLES = [
  'Organization',
  'StandingAuthorization',
  'AuditLog',
  'RecoveryOpportunity',
  'AutonomyTask',
  'AutonomyLease',
  'AutonomyIncident',
] as const;

/**
 * CHANGE 31：整表**内容级**摘要 —— 对每张表的全部行做 canonical JSON 排序后取 md5，
 * 因此「计数相同」不再是唯一证据：任何行的任何字段变化都会改变该摘要。
 * 仅在本测试（隔离库）内使用；产品代码不含任何原生查询。
 */
async function tableContentDigests(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of CONTENT_TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint; digest: string }[]>(
      `SELECT count(*)::bigint AS n, coalesce(md5(string_agg(row_to_json(t)::text, chr(10) ORDER BY row_to_json(t)::text)), 'empty') AS digest FROM "${table}" t`,
    );
    const row = rows[0];
    out[table] = `${String(row === undefined ? 0 : Number(row.n))}:${String(row === undefined ? '' : row.digest)}`;
  }
  return out;
}

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
    tableContent: await tableContentDigests(),
    organization: organization === null ? null : { id: organization.id, updatedAt: organization.updatedAt.toISOString() },
    authorizationDigests: authorizations.map(
      (row) => `${row.id}:${row.authorizationVersion}:${row.revocationState}:${row.scopeDigest}`,
    ),
  };
}

/**
 * CHANGE 36：读取数据库级事务计数（PostgreSQL 真实事务数，而非测试里的回调进入次数）。
 * 说明：测量查询自身的提交不计入其返回值，因此「Q1 → 被测代码 → Q2」的差值 = Q1 自身提交 1 + 被测代码开启的事务数。
 */
async function pgTransactionCount(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ txs: bigint }[]>(
    `SELECT (xact_commit + xact_rollback)::bigint AS txs FROM pg_stat_database WHERE datname = current_database()`,
  );
  return Number(rows[0]?.txs ?? 0n);
}

beforeEach(async () => {
  for (const organizationId of [ORG, ORG_A, ORG_B, ORG_MISSING]) {
    await prisma.standingAuthorization.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
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

  it('U1-DB7（CHANGE 20/25/31）解析前后七张相关表**内容级**摘要与关键记录摘要一致', async () => {
    await seedAuthorization();
    const before = await snapshot();
    const resolved = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(resolved.ok).toBe(true);
    const after = await snapshot();
    expect(after).toEqual(before);
    evidence({
      kind: 'TABLE_SNAPSHOT',
      method: 'per-table canonical row-JSON md5 (count:digest) via SELECT md5(string_agg(row_to_json(t)::text, chr(10) ORDER BY row_to_json(t)::text))',
      before,
      after,
      identical: JSON.stringify(before) === JSON.stringify(after),
    });
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

  it('U1-DB9（CHANGE 32）同一端口实例、双组织并发交错：事务归属独立 / 无跨调用复用 / 无跨租户串扰 / 异常路径 fail-closed', async () => {
    const scopeA: TrustedFactsResourceScope = {
      platformAccountId: 'acct-a',
      provider: 'AMAZON',
      domain: 'LOGISTICS',
      jurisdiction: 'US',
    };
    const scopeB: TrustedFactsResourceScope = {
      platformAccountId: 'acct-b',
      provider: 'SHOPIFY',
      domain: 'FINANCE',
      jurisdiction: 'JP',
    };
    await seedAuthorization({ organizationId: ORG_A, platformAccountId: 'acct-a', provider: 'AMAZON', authorizationVersion: 3 });
    await seedAuthorization({
      organizationId: ORG_B,
      platformAccountId: 'acct-b',
      provider: 'SHOPIFY',
      domain: 'FINANCE',
      jurisdiction: 'JP',
      authorizationVersion: 5,
    });
    const rowA = await prisma.standingAuthorization.findFirstOrThrow({ where: { organizationId: ORG_A }, select: { id: true } });
    const rowB = await prisma.standingAuthorization.findFirstOrThrow({ where: { organizationId: ORG_B }, select: { id: true } });

    // 同一个 readPort 实例被两个租户的调用共用（正是评审指出的场景）
    const sharedPort = createPrismaTrustedFactsReadPort({ prisma });
    const txSeq = new WeakMap<object, number>();
    let nextSeq = 0;
    const handles: { call: string; seq: number; readOnly: string | null; writeRejected: boolean }[] = [];
    const gate = { release: (): void => {}, aInside: (): void => {}, bInside: (): void => {} };
    const bothRelease = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const aInside = new Promise<void>((resolve) => {
      gate.aInside = resolve;
    });
    const bInside = new Promise<void>((resolve) => {
      gate.bInside = resolve;
    });
    /** CHANGE 34：门闩等待必须确定性 —— 超时即**失败**（不允许“超时后继续跑”） */
    const entered: Record<string, boolean> = {};
    const intervals: Record<string, { enteredAt: number; leftAt: number }> = {};
    const waitOrFail = async (label: string, signal: Promise<void>): Promise<void> => {
      const outcome = await Promise.race([
        signal.then(() => 'entered' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
      ]);
      if (outcome !== 'entered') throw new Error('GATE_TIMEOUT_NOT_ENTERED:' + label);
    };
    const releaseGuard = (): Promise<never> =>
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('GATE_RELEASE_TIMEOUT')), 15000));

    const wrap = (call: string): TrustedFactsReadPort => ({
      findOrganization: (input) => sharedPort.findOrganization(input),
      listStandingAuthorizations: (input) => sharedPort.listStandingAuthorizations(input),
      withReadOnlyTransaction: (run) =>
        sharedPort.withReadOnlyTransaction(async (tx) => {
          const key = tx as unknown as object;
          if (!txSeq.has(key)) {
            nextSeq += 1;
            txSeq.set(key, nextSeq);
          }
          const settings = await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>(
            `SELECT current_setting('transaction_read_only') AS transaction_read_only`,
          );
          entered[call] = true;
          intervals[call] = { enteredAt: Date.now(), leftAt: Number.MAX_SAFE_INTEGER };
          handles.push({
            call,
            seq: txSeq.get(key)!,
            readOnly: settings[0]?.transaction_read_only ?? null,
            writeRejected: false,
          });
          // 交错编排：A 先进入自己的只读事务并停住；B 在 A **仍然在事务内**时才开始
          if (call === 'A') {
            gate.aInside();
            await Promise.race([bothRelease, releaseGuard()]);
          } else if (call === 'B') {
            gate.bInside();
            await Promise.race([bothRelease, releaseGuard()]);
          }
          const result = await run(tx);
          // 读完之后再做写入探针（若先写，事务进入 aborted 状态会让后续读取失败）
          let writeRejected = false;
          try {
            await tx.$executeRawUnsafe(`DELETE FROM "StandingAuthorization" WHERE "id" = 'u1-r7-probe-${call}'`);
          } catch {
            writeRejected = true;
          }
          const record = handles.find((h) => h.call === call);
          if (record !== undefined) record.writeRejected = writeRejected;
          intervals[call].leftAt = Date.now();
          return result;
        }),
    });

    const mkAdapter = (readPort: TrustedFactsReadPort, scope: TrustedFactsResourceScope) =>
      createTrustedFactsAdapter({
        readPort,
        executionContext: { subjectRef: 'runtime-member-1', caller: 'RUNTIME_MEMBER', operationRecheck: 'CONFIRMED_READ_ONLY', resourceScope: scope },
        now: () => AT,
      });

    // 先启动 A，等它确实进入只读事务后，再启动 B（“后发请求”场景）；超时即失败
    const pendingA = mkAdapter(wrap('A'), scopeA).resolve({ organizationId: ORG_A, actionType: 'recovery.read', monetaryAction: false });
    await waitOrFail('A', aInside);
    const pendingB = mkAdapter(wrap('B'), scopeB).resolve({ organizationId: ORG_B, actionType: 'recovery.read', monetaryAction: false });
    await waitOrFail('B', bInside);
    // CHANGE 34：释放门闩前断言 A、B 都已进入事务，并在**同一重叠窗口内**完成句柄独立性检查
    expect(entered.A).toBe(true);
    expect(entered.B).toBe(true);
    expect(new Set(handles.filter((h) => h.call === 'A' || h.call === 'B').map((h) => h.seq)).size).toBe(2);
    gate.release();
    const [resA, resB] = await Promise.all([pendingA, pendingB]);
    // CHANGE 34：两个事务的活动区间确实重叠
    const realConcurrentOverlap =
      Math.max(intervals.A!.enteredAt, intervals.B!.enteredAt) < Math.min(intervals.A!.leftAt, intervals.B!.leftAt);
    expect(realConcurrentOverlap).toBe(true);

    expect(resA.ok && resB.ok).toBe(true);
    if (resA.ok && resB.ok) {
      // 无跨租户事实串扰：各自拿到本租户的授权行
      expect(resA.provenance.authorizationActive?.authorizationId).toBe(rowA.id);
      expect(resB.provenance.authorizationActive?.authorizationId).toBe(rowB.id);
      expect(resA.provenance.authorizationActive?.authorizationVersion).toBe(3);
      expect(resB.provenance.authorizationActive?.authorizationVersion).toBe(5);
    }
    // 事务归属独立：并发调用不得复用同一事务句柄
    expect(handles).toHaveLength(2);
    const seqA = handles.find((h) => h.call === 'A')!.seq;
    const seqB = handles.find((h) => h.call === 'B')!.seq;
    expect(seqA).not.toBe(seqB);
    expect(handles.every((h) => h.readOnly === 'on')).toBe(true);
    expect(handles.every((h) => h.writeRejected)).toBe(true);

    // 异常路径 fail-closed：不存在的组织被拒绝，且后续调用获得**全新**独立事务（无残留句柄复用）
    const missing = await mkAdapter(wrap('C'), scopeA).resolve({
      organizationId: ORG_MISSING,
      actionType: 'recovery.read',
      monetaryAction: false,
    });
    expect(!missing.ok && missing.reason).toBe('ORGANIZATION_NOT_FOUND');
    const afterFailure = await mkAdapter(wrap('D'), scopeA).resolve({
      organizationId: ORG_A,
      actionType: 'recovery.read',
      monetaryAction: false,
    });
    expect(afterFailure.ok).toBe(true);
    const seqC = handles.find((h) => h.call === 'C')!.seq;
    const seqD = handles.find((h) => h.call === 'D')!.seq;
    expect(new Set([seqA, seqB, seqC, seqD]).size).toBe(4);
    expect(afterFailure.ok && afterFailure.provenance.authorizationActive?.authorizationId).toBe(rowA.id);

    evidence({
      kind: 'CONCURRENT_TRANSACTION_ISOLATION',
      sameReadPortInstance: true,
      forcedInterleaving: true,
      mechanism: 'AsyncLocalStorage（按调用链隔离事务句柄）',
      handles,
      distinctHandlesForConcurrentCalls: seqA !== seqB,
      allReadOnly: handles.every((h) => h.readOnly === 'on'),
      writeProbeRejectedPerCall: handles.filter((h) => h.writeRejected).length,
      results: { A_version: 3, B_version: 5, A_authorizationId: rowA.id, B_authorizationId: rowB.id },
      crossTenantLeak: false,
      realConcurrentOverlap,
      intervals,
      exceptionPath: { org: ORG_MISSING, reason: 'ORGANIZATION_NOT_FOUND', laterCallFreshTransaction: new Set([seqA, seqB, seqC, seqD]).size === 4 },
    });
  });

  it('U1-DB10（CHANGE 33）同一调用链内嵌套 withReadOnlyTransaction 复用同一事务（只开一个事务）', async () => {
    await seedOrganization(ORG_A);
    const port = createPrismaTrustedFactsReadPort({ prisma });
    const txSeq = new WeakMap<object, number>();
    let txCounter = 0;
    const seqOf = (tx: unknown): number => {
      const key = tx as object;
      if (!txSeq.has(key)) {
        txCounter += 1;
        txSeq.set(key, txCounter);
      }
      return txSeq.get(key)!;
    };
    const seen: number[] = [];
    let opened = 0;
    const txsBefore = await pgTransactionCount();
    // CHANGE 36：直接统计**真实事务开启次数**（Prisma $transaction 每次调用 = 一次真实 BEGIN/COMMIT），
    // 而不是只统计测试回调进入次数；pg_stat_database 计数作为补充记录（其刷新有延迟，故不作断言）。
    const originalTransaction = prisma.$transaction.bind(prisma);
    let transactionsOpenedAtDb = 0;
    (prisma as unknown as { $transaction: (...args: unknown[]) => unknown }).$transaction = (...args: unknown[]) => {
      transactionsOpenedAtDb += 1;
      return (originalTransaction as unknown as (...a: unknown[]) => unknown)(...args);
    };
    let result: string;
    try {
      result = await port.withReadOnlyTransaction(async (tx) => {
        opened += 1;
        seen.push(seqOf(tx));
        // 同一调用链内再次进入 ⇒ 必须复用同一事务句柄，且不得新开第二个只读事务
        const inner = await port.withReadOnlyTransaction(async (tx2) => {
          seen.push(seqOf(tx2));
          // 通过端口读取：db() 应命中当前调用链的事务（而非裸 client / 别人的事务）
          const org = await port.findOrganization({ organizationId: ORG_A });
          return org === null ? 'MISS' : 'HIT';
        });
        return inner;
      });
    } finally {
      (prisma as unknown as { $transaction: unknown }).$transaction = originalTransaction;
    }
    const txsAfter = await pgTransactionCount();
    expect(result).toBe('HIT');
    expect(opened).toBe(1);
    expect(transactionsOpenedAtDb).toBe(1);
    expect(seen).toEqual([1, 1]);
    evidence({
      kind: 'NESTED_TRANSACTION_REUSE',
      sameCallChain: true,
      callbackEntries: opened,
      transactionsOpenedAtDb,
      handleSequences: seen,
      reusedSameHandle: seen[0] === seen[1],
      readInsideNestedCall: result === 'HIT',
      pgTransactionCountBefore: txsBefore,
      pgTransactionCountAfter: txsAfter,
      pgTransactionCountNote: 'pg_stat_database 计数刷新有延迟，仅作补充记录；断言使用 $transaction 调用次数（每次 = 一次真实 BEGIN/COMMIT）',
    });
  });

  it('U1-DB11（CHANGE 33）事务结束后脱离生命周期的异步任务不得回落裸 client（fail-closed）', async () => {
    await seedOrganization(ORG_A);
    const port = createPrismaTrustedFactsReadPort({ prisma });
    let leaked: Promise<unknown> | null = null;
    const endGate = { release: (): void => {} };
    const transactionEnded = new Promise<void>((resolve) => {
      endGate.release = resolve;
    });

    await port.withReadOnlyTransaction(async () => {
      // CHANGE 36：在事务作用域内派生一个“超出事务生命周期”的任务，等待**显式事务结束信号**（不再用 setTimeout）
      leaked = (async () => {
        await transactionEnded;
        return port.findOrganization({ organizationId: ORG_A });
      })();
      return true;
    });
    // 事务已结束（withReadOnlyTransaction 已返回）——此刻才释放信号，消除基于时间的验证
    endGate.release();

    let threw = false;
    let value: unknown = null;
    try {
      value = await leaked;
    } catch {
      threw = true;
    }
    // 已失效事务句柄必须报错（fail-closed）；不得静默改用裸 client 返回数据
    expect(threw).toBe(true);
    expect(value).toBeNull();
    evidence({
      kind: 'DEAD_TRANSACTION_ACCESS',
      detachedFromTransactionLifecycle: true,
      signalSource: 'EXPLICIT_TRANSACTION_END_SIGNAL（取代 setTimeout）',
      threw,
      returnedValue: value,
      failClosed: threw && value === null,
    });
  });

  it('U1-DB12（CHANGE 35）四个写入探针分别捕获 PostgreSQL SQLSTATE 25006（且均位于只读事务内）', async () => {
    await seedOrganization(ORG_A);
    const probes: readonly string[] = [
      `DELETE FROM "StandingAuthorization" WHERE "id" = 'u1-r7-sqlstate-nonexistent'`,
      `CREATE TABLE IF NOT EXISTS "u1_r7_sqlstate_probe" ("x" int)`,
      `UPDATE "StandingAuthorization" SET "currency" = 'USD' WHERE "id" = 'u1-r7-sqlstate-nonexistent'`,
      `INSERT INTO "StandingAuthorization" ("id") SELECT 'u1-r7-sqlstate' WHERE false`,
    ];
    const captured: { sql: string; sqlstate: string | null; readOnlyInsideTx: string | null; errorName: string | null }[] = [];

    for (const sql of probes) {
      let sqlstate: string | null = null;
      let readOnlyInsideTx: string | null = null;
      let errorName: string | null = null;
      await runInReadOnlyTransaction(prisma, async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>(
          `SELECT current_setting('transaction_read_only') AS transaction_read_only`,
        );
        readOnlyInsideTx = rows[0]?.transaction_read_only ?? null;
        try {
          await tx.$executeRawUnsafe(sql);
        } catch (error) {
          const e = error as { constructor?: { name?: string }; meta?: { code?: unknown }; message?: unknown };
          errorName = e.constructor?.name ?? null;
          // SQLSTATE 提取：优先 Prisma meta.code，其次错误消息中的 Code: 25006
          const metaCode = e.meta?.code;
          const matched = /Code: `(\d{5})`/.exec(typeof e.message === 'string' ? e.message : '');
          sqlstate = metaCode === undefined || metaCode === null ? (matched === null ? null : matched[1]) : String(metaCode);
        }
      });
      captured.push({ sql, sqlstate, readOnlyInsideTx, errorName });
    }

    expect(captured).toHaveLength(4);
    expect(captured.every((c) => c.readOnlyInsideTx === 'on')).toBe(true);
    expect(captured.every((c) => c.errorName === 'PrismaClientKnownRequestError')).toBe(true);
    expect(captured.map((c) => c.sqlstate)).toEqual(['25006', '25006', '25006', '25006']);
    evidence({
      kind: 'PG_SQLSTATE_PROBES',
      probeCount: captured.length,
      extraction: 'Prisma error meta.code，回退到错误消息正则 Code: (5 位数字)',
      rejectionInsideReadOnlyTransaction: captured.every((c) => c.readOnlyInsideTx === 'on'),
      sqlstates: captured.map((c) => c.sqlstate),
      allSqlState25006: captured.every((c) => c.sqlstate === '25006'),
      probes: captured.map((c) => ({ sql: c.sql, sqlstate: c.sqlstate, readOnly: c.readOnlyInsideTx })),
    });
  });
});
