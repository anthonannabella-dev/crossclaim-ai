/**
 * R45 Implementation S1 —— Outcome / Reimbursement Reconciliation（Schema / 约束 / 触发器）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-45（4 项裁决 + CHANGE A–D）+ MSG-20261001-46
 *       （七表 + CHANGE A–C 批准；basis supersede 同事务 CAS；授权进入 R45 S1）。
 * 范围（S1）：**只验数据结构与数据库不变量** —— 七表 / 七枚举、租户与归属触发器、
 *   append-only、basis 受控 supersede、provider 指纹唯一、冲正语义与同源性、
 *   partial unique（effective basis / full reversal / policy scope）、
 *   projection 受控更新与 membership generation 一致性、跨租户引用拒绝。
 * 不含：ingest / projector / 受保护动作 HTTP·service / provider API /
 *   Settlement · Billing · Fee / RecoveryLedger 改写 / 平台外写 / 生产凭据。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r45-s1-pass-1';
const SYSTEM_EXACT_POLICY_ID = 'cc0f0000-0000-4000-8000-000000000001';

let ORG_A = '';
let ORG_B = '';
let caseA = '';
let caseB = '';
let claimA = '';
let claimB = '';

const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);
const uuid = (): string => randomUUID();

const TABLES = [
  'ProviderOutcomeFact',
  'ReimbursementFact',
  'ExpectedRecoveryBasis',
  'ReconciliationOverrideDecision',
  'ClaimReconciliationProjection',
  'ClaimReconciliationProjectionFact',
  'ReconciliationTolerancePolicy',
];

const ENUMS = [
  'ProviderOutcomeFactKind',
  'ProviderOutcomeSourceKind',
  'ReimbursementFactKind',
  'ReimbursementSourceKind',
  'ExpectedRecoveryBasisKind',
  'ReconciliationOverrideDecisionKind',
  'ReconciliationProjectionStatus',
];

async function seedOrg(slugSuffix: string): Promise<string> {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R45 S1 ' + slugSuffix, slug: 'r45-s1-' + slugSuffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r45-s1-' + slugSuffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER', isActive: true } });
  return id;
}

async function seedCase(organizationId: string): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'R45-' + randomUUID().slice(0, 8),
      title: 'R45 S1 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  return created.id;
}

async function seedClaimItem(organizationId: string, caseId: string): Promise<string> {
  const created = await prisma.claimItem.create({
    data: {
      organizationId,
      caseId,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'r45-' + randomUUID(),
      sourceFingerprint: hex64(),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  return created.id;
}

async function createOutcomeFact(
  organizationId: string,
  targetCaseId: string,
  claimItemId: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await prisma.providerOutcomeFact.create({
    data: {
      organizationId,
      caseId: targetCaseId,
      claimItemId,
      provider: 'AMAZON',
      kind: 'ACCEPTED',
      occurredAt: new Date('2026-09-03T00:00:00.000Z'),
      providerEventId: 'evt-' + randomUUID(),
      providerEventFingerprint: hex64(),
      fingerprintVersion: 'v1',
      sourceKind: 'OFFICIAL_API',
      sourceRef: 'sp-api/reimbursements/' + randomUUID(),
      capturedAt: new Date('2026-09-03T01:00:00.000Z'),
      ingestedByUserId: uuid(),
      evidenceArtifactIds: [],
      ...overrides,
    },
  });
  return created.id;
}

async function createObserved(
  organizationId: string,
  claimItemId: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await prisma.reimbursementFact.create({
    data: {
      organizationId,
      claimItemId,
      provider: 'AMAZON',
      kind: 'OBSERVED',
      amount: '120.5000',
      currency: 'USD',
      occurredAt: new Date('2026-09-04T00:00:00.000Z'),
      providerEventId: 'rmb-' + randomUUID(),
      providerEventFingerprint: hex64(),
      fingerprintVersion: 'v1',
      sourceKind: 'OFFICIAL_API',
      sourceRef: 'sp-api/finances/' + randomUUID(),
      capturedAt: new Date('2026-09-04T01:00:00.000Z'),
      ingestedByUserId: uuid(),
      evidenceArtifactIds: [],
      ...overrides,
    },
  });
  return created.id;
}

async function createReversal(
  organizationId: string,
  reversesFactId: string,
  claimItemId: string | null,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await prisma.reimbursementFact.create({
    data: {
      organizationId,
      claimItemId,
      provider: 'AMAZON',
      kind: 'REIMBURSEMENT_REVERSED',
      reversesFactId,
      amount: null,
      currency: 'USD',
      occurredAt: new Date('2026-09-05T00:00:00.000Z'),
      providerEventId: 'rev-' + randomUUID(),
      providerEventFingerprint: hex64(),
      fingerprintVersion: 'v1',
      sourceKind: 'OFFICIAL_API',
      sourceRef: 'sp-api/finances/' + randomUUID(),
      capturedAt: new Date('2026-09-05T01:00:00.000Z'),
      ingestedByUserId: uuid(),
      evidenceArtifactIds: [],
      ...overrides,
    },
  });
  return created.id;
}

async function createBasis(
  organizationId: string,
  claimItemId: string,
  targetCaseId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await prisma.expectedRecoveryBasis.create({
    data: {
      organizationId,
      claimItemId,
      caseId: targetCaseId,
      expectedRecoveryAmount: '250.0000',
      currency: 'USD',
      basisKind: 'CARRIER_CLAIM',
      basisVersion: 'basis/v1',
      basisSource: 'carrier-claim-report/' + randomUUID(),
      effectiveAt: new Date('2026-09-06T00:00:00.000Z'),
      createdByUserId: uuid(),
      ...overrides,
    },
  });
  return created.id;
}

async function createProjection(
  organizationId: string,
  claimItemId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await prisma.claimReconciliationProjection.create({
    data: {
      organizationId,
      claimItemId,
      status: 'UNMATCHED',
      basisId: null,
      expectedAmount: null,
      currency: 'USD',
      netMatchedObservedAmount: '0',
      matchedFactIds: [],
      tolerancePolicyId: SYSTEM_EXACT_POLICY_ID,
      policyVersion: 'v1',
      inputDigest: hex64(),
      projectionVersion: 1,
      computedAt: new Date('2026-09-07T00:00:00.000Z'),
      ...overrides,
    },
  });
  return created.id;
}

async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error as Error & { code?: string; meta?: unknown };
    const text = `${err.code ?? ''} ${err.message} ${JSON.stringify(err.meta ?? {})}`;
    expect(text).toMatch(pattern);
    return;
  }
  throw new Error('EXPECTED_DB_REJECTION_MISSING: ' + String(pattern));
}

beforeAll(async () => {
  await prisma.$connect();
  // 迁移播种的「显式系统 exact policy」是 CHANGE C 的常量记录；测试库的 afterAll 会 TRUNCATE
  // 所有表，因此这里幂等确保其存在（与服务层无关，仅用于让断言顺序无关）。
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ReconciliationTolerancePolicy"
       ("id","organizationId","provider","operation","policyVersion","absoluteTolerance","relativeTolerance","effectiveAt","createdByUserId")
     VALUES ($1, NULL, NULL, NULL, 'v1', 0, 0, CURRENT_TIMESTAMP, 'SYSTEM_EXACT_POLICY')
     ON CONFLICT ("id") DO NOTHING`,
    SYSTEM_EXACT_POLICY_ID,
  );
});

afterAll(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  ORG_A = await seedOrg('a-' + suffix);
  ORG_B = await seedOrg('b-' + suffix);
  caseA = await seedCase(ORG_A);
  caseB = await seedCase(ORG_B);
  claimA = await seedClaimItem(ORG_A, caseA);
  claimB = await seedClaimItem(ORG_B, caseB);
});

describe('R45 S1 · 结构（七表 / 七枚举 / 触发器覆盖）', () => {
  it('七张表全部存在', async () => {
    const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
      TABLES,
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual([...TABLES].sort());
  });

  it('七个枚举全部存在', async () => {
    const rows = await prisma.$queryRawUnsafe<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typtype = 'e' AND typname = ANY($1::text[])`,
      ENUMS,
    );
    expect(rows.map((r) => r.typname).sort()).toEqual([...ENUMS].sort());
  });

  it('七表均挂租户保护 + 归属不可变触发器', async () => {
    const rows = await prisma.$queryRawUnsafe<{ relname: string; tgname: string; tgtype: number }[]>(
      `SELECT c.relname, g.tgname, g.tgtype
         FROM pg_trigger g
         JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND c.relname = ANY($1::text[])`,
      TABLES,
    );
    const names = new Set(rows.map((r) => r.tgname));
    for (const table of TABLES) {
      expect(names.has('cc_tenant_' + table.toLowerCase()), `缺少 cc_tenant_${table.toLowerCase()}`).toBe(true);
      expect(names.has('cc_tenant_immutable__' + table), `缺少 cc_tenant_immutable__${table}`).toBe(true);
    }
    expect(rows.filter((r) => r.tgname === 'cc_tenant_immutable__ProviderOutcomeFact')[0].tgtype).toBe(19);
  });

  it('事实域挂 append-only；basis / projection 为受控变更；冲正与 generation 守卫存在', async () => {
    const rows = await prisma.$queryRawUnsafe<{ relname: string; tgname: string; tgtype: number }[]>(
      `SELECT c.relname, g.tgname, g.tgtype
         FROM pg_trigger g
         JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE NOT g.tgisinternal AND g.tgenabled = 'O' AND c.relname = ANY($1::text[])`,
      TABLES,
    );
    const byName = new Map(rows.map((r) => [r.tgname, r]));
    expect(byName.get('cc_append_only__ProviderOutcomeFact')?.tgtype).toBe(27);
    expect(byName.get('cc_append_only__ReimbursementFact')?.tgtype).toBe(27);
    expect(byName.get('cc_append_only__ReconciliationOverrideDecision')?.tgtype).toBe(27);
    expect(byName.get('cc_expectedrecoverybasis_controlled_supersede')?.tgtype).toBe(27);
    expect(byName.get('cc_reconciliationprojection_controlled_mutation')?.tgtype).toBe(19);
    expect(byName.get('cc_reimbursementfact_reversal_guard')?.tgtype).toBe(7);
    expect(byName.get('cc_reconciliationprojectionfact_version_match')?.tgtype).toBe(7);
    // generation 一致性一律**立即判定**：不得出现 DEFERRABLE 约束触发器
    // （实测 Prisma 客户端会吞掉 COMMIT 阶段 deferred 约束错误 → 静默回滚不可观测）
    const deferred = await prisma.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT g.tgname FROM pg_trigger g
         JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE NOT g.tgisinternal AND g.tgdeferrable AND c.relname = ANY($1::text[])`,
      TABLES,
    );
    expect(deferred).toHaveLength(0);
  });

  it('显式系统 exact policy 记录存在（CHANGE C：不得代码隐式 fallback）', async () => {
    const rows = await prisma.$queryRawUnsafe<{ id: string; absoluteTolerance: string; relativeTolerance: string }[]>(
      `SELECT "id", "absoluteTolerance"::text, "relativeTolerance"::text
         FROM "ReconciliationTolerancePolicy" WHERE "id" = $1`,
      SYSTEM_EXACT_POLICY_ID,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].absoluteTolerance)).toBe(0);
    expect(Number(rows[0].relativeTolerance)).toBe(0);
  });
});

describe('R45 S1 · ProviderOutcomeFact', () => {
  it('同一指纹重复 ingest → 唯一冲突（幂等由上层复用既有事实）', async () => {
    const fingerprint = hex64();
    await createOutcomeFact(ORG_A, caseA, claimA, { providerEventFingerprint: fingerprint });
    await expectRejection(
      () => createOutcomeFact(ORG_A, caseA, claimA, { providerEventFingerprint: fingerprint }),
      /P2002|unique/i,
    );
  });

  it('同一 providerEventId + 不同 resource（不同指纹）→ 不误冲突（CHANGE B）', async () => {
    const sharedEventId = 'evt-shared-' + randomUUID();
    const first = await createOutcomeFact(ORG_A, caseA, claimA, {
      providerEventId: sharedEventId,
      providerEventFingerprint: hex64(),
    });
    const second = await createOutcomeFact(ORG_A, caseA, claimA, {
      providerEventId: sharedEventId,
      providerEventFingerprint: hex64(),
    });
    expect(first).not.toBe(second);
  });

  it('指纹格式与版本被收口（64 hex / v1）', async () => {
    await expectRejection(
      () => createOutcomeFact(ORG_A, caseA, claimA, { providerEventFingerprint: 'not-a-hex' }),
      /fingerprint_hex64|23514/,
    );
    await expectRejection(
      () => createOutcomeFact(ORG_A, caseA, claimA, { fingerprintVersion: 'v2' }),
      /fingerprint_version_v1|23514/,
    );
  });

  it('人工录入（MANUAL_WITH_EVIDENCE）必须带证据 + reasonCode', async () => {
    await expectRejection(
      () =>
        createOutcomeFact(ORG_A, caseA, claimA, {
          sourceKind: 'MANUAL_WITH_EVIDENCE',
          evidenceArtifactIds: [],
          reasonCode: 'MANUAL_REVIEW',
        }),
      /manual_requires_evidence|23514/,
    );
    const ok = await createOutcomeFact(ORG_A, caseA, claimA, {
      sourceKind: 'MANUAL_WITH_EVIDENCE',
      evidenceArtifactIds: [uuid()],
      reasonCode: 'MANUAL_REVIEW',
    });
    expect(ok).toBeTruthy();
  });

  it('append-only：UPDATE / DELETE 一律拒绝', async () => {
    const id = await createOutcomeFact(ORG_A, caseA, claimA);
    await expectRejection(
      () => prisma.$executeRawUnsafe(`UPDATE "ProviderOutcomeFact" SET "note" = 'x' WHERE "id" = $1`, id),
      /APPEND_ONLY_TABLE|23514/,
    );
    await expectRejection(
      () => prisma.$executeRawUnsafe(`DELETE FROM "ProviderOutcomeFact" WHERE "id" = $1`, id),
      /APPEND_ONLY_TABLE|23514/,
    );
  });
});

describe('R45 S1 · ReimbursementFact（CHANGE A / B）', () => {
  it('OBSERVED.amount 必须 > 0（0 / 负数 / NULL 均拒绝）', async () => {
    await expectRejection(() => createObserved(ORG_A, claimA, { amount: '0' }), /amount_semantics|23514/);
    await expectRejection(() => createObserved(ORG_A, claimA, { amount: '-1.0000' }), /amount_semantics|23514/);
    await expectRejection(() => createObserved(ORG_A, claimA, { amount: null }), /amount_semantics|23514/);
  });

  it('冲正行不携带独立金额语义；自指被拒绝', async () => {
    const observed = await createObserved(ORG_A, claimA);
    await expectRejection(
      () => createReversal(ORG_A, observed, claimA, { amount: '10.0000' }),
      /amount_semantics|23514/,
    );
    const selfId = uuid();
    await expectRejection(
      () =>
        prisma.reimbursementFact.create({
          data: {
            id: selfId,
            organizationId: ORG_A,
            claimItemId: claimA,
            provider: 'AMAZON',
            kind: 'REIMBURSEMENT_REVERSED',
            reversesFactId: selfId,
            amount: null,
            currency: 'USD',
            occurredAt: new Date('2026-09-05T00:00:00.000Z'),
            providerEventFingerprint: hex64(),
            fingerprintVersion: 'v1',
            sourceKind: 'OFFICIAL_API',
            sourceRef: 'sp-api/finances/' + uuid(),
            capturedAt: new Date('2026-09-05T01:00:00.000Z'),
            ingestedByUserId: uuid(),
            evidenceArtifactIds: [],
          },
        }),
      /reversal_shape|REVERSAL_TARGET_NOT_FOUND|23514/,
    );
  });

  it('冲正只能指向同租户 / 同 provider / 同 currency 的 OBSERVED 事实', async () => {
    const observed = await createObserved(ORG_A, claimA);
    await expectRejection(
      () => createReversal(ORG_A, observed, claimA, { provider: 'WALMART' }),
      /REVERSAL_PROVIDER_MISMATCH|23514/,
    );
    await expectRejection(
      () => createReversal(ORG_A, observed, claimA, { currency: 'EUR' }),
      /REVERSAL_CURRENCY_MISMATCH|23514/,
    );
    // 跨租户：租户触发器 / 冲正守卫任一生效即拒绝
    await expectRejection(() => createReversal(ORG_B, observed, claimB), /23514|check_violation|REVERSAL_/);
    // 目标为冲正行（非 OBSERVED）也拒绝
    const reversal = await createReversal(ORG_A, observed, claimA);
    await expectRejection(() => createReversal(ORG_A, reversal, claimA), /REVERSAL_TARGET_NOT_OBSERVED|23514/);
  });

  it('同一 OBSERVED 至多一个有效 full reversal（partial unique 兜底）', async () => {
    const observed = await createObserved(ORG_A, claimA);
    await createReversal(ORG_A, observed, claimA);
    await expectRejection(() => createReversal(ORG_A, observed, claimA), /P2002|unique|23505/i);
  });

  it('同一 reversal event 重复 ingest → 指纹唯一冲突（服务层幂等复用既有事实）', async () => {
    const observed = await createObserved(ORG_A, claimA);
    const fingerprint = hex64();
    await createReversal(ORG_A, observed, claimA, { providerEventFingerprint: fingerprint });
    const other = await createObserved(ORG_A, claimA);
    await expectRejection(
      () => createReversal(ORG_A, other, claimA, { providerEventFingerprint: fingerprint }),
      /P2002|unique/i,
    );
  });

  it('append-only：UPDATE / DELETE 一律拒绝', async () => {
    const observed = await createObserved(ORG_A, claimA);
    await expectRejection(
      () => prisma.$executeRawUnsafe(`UPDATE "ReimbursementFact" SET "note" = 'x' WHERE "id" = $1`, observed),
      /APPEND_ONLY_TABLE|23514/,
    );
    await expectRejection(
      () => prisma.$executeRawUnsafe(`DELETE FROM "ReimbursementFact" WHERE "id" = $1`, observed),
      /APPEND_ONLY_TABLE|23514/,
    );
  });
});

describe('R45 S1 · ExpectedRecoveryBasis（CHANGE C / Q1）', () => {
  it('同一 claimItem 至多一个 effective（partial unique 最终防线）', async () => {
    await createBasis(ORG_A, claimA, caseA);
    await expectRejection(() => createBasis(ORG_A, claimA, caseA), /P2002|unique|23505/i);
  });

  it('受控 supersede：白名单外变更 / DELETE / 二次 supersede 一律拒绝', async () => {
    const first = await createBasis(ORG_A, claimA, caseA);
    await expectRejection(
      () =>
        prisma.$executeRawUnsafe(
          `UPDATE "ExpectedRecoveryBasis" SET "expectedRecoveryAmount" = 999 WHERE "id" = $1`,
          first,
        ),
      /CORE_IMMUTABLE|23514/,
    );
    await expectRejection(
      () => prisma.$executeRawUnsafe(`DELETE FROM "ExpectedRecoveryBasis" WHERE "id" = $1`, first),
      /REJECTS_DELETE|23514/,
    );
    await expectRejection(
      () =>
        prisma.$executeRawUnsafe(
          `UPDATE "ExpectedRecoveryBasis" SET "supersededAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
          first,
        ),
      /REQUIRES_SUCCESSOR|23514/,
    );
  });

  it('supersede 事务（UPDATE old → INSERT new → COMMIT）保持恰一个 effective；失败回滚不改变旧 basis', async () => {
    const first = await createBasis(ORG_A, claimA, caseA);

    await expectRejection(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "ExpectedRecoveryBasis" SET "supersededAt" = CURRENT_TIMESTAMP, "supersededByBasisId" = $2 WHERE "id" = $1`,
            first,
            uuid(),
          );
          // 后继 basis 金额非法 → 整个事务回滚
          await tx.$executeRawUnsafe(
            `INSERT INTO "ExpectedRecoveryBasis"
               ("id","organizationId","claimItemId","caseId","expectedRecoveryAmount","currency","basisKind","basisVersion","basisSource","effectiveAt","createdByUserId")
             VALUES ($1,$2,$3,$4,0,'USD','CONTRACTUAL','basis/v2','rollback-probe',CURRENT_TIMESTAMP,$5)`,
            uuid(),
            ORG_A,
            claimA,
            caseA,
            uuid(),
          );
        }),
      /amount_positive|23514/,
    );

    const after = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "ExpectedRecoveryBasis" WHERE "organizationId" = $1 AND "claimItemId" = $2 AND "supersededAt" IS NULL`,
      ORG_A,
      claimA,
    );
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first);

    const successor = uuid();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "ExpectedRecoveryBasis" SET "supersededAt" = CURRENT_TIMESTAMP, "supersededByBasisId" = $2 WHERE "id" = $1 AND "supersededAt" IS NULL`,
        first,
        successor,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ExpectedRecoveryBasis"
           ("id","organizationId","claimItemId","caseId","expectedRecoveryAmount","currency","basisKind","basisVersion","basisSource","effectiveAt","createdByUserId")
         VALUES ($1,$2,$3,$4,310.0000,'USD','CONTRACTUAL','basis/v2','supersede-ok',CURRENT_TIMESTAMP,$5)`,
        successor,
        ORG_A,
        claimA,
        caseA,
        uuid(),
      );
    });

    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "ExpectedRecoveryBasis" WHERE "organizationId" = $1 AND "claimItemId" = $2 AND "supersededAt" IS NULL`,
      ORG_A,
      claimA,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(successor);
    const all = await prisma.expectedRecoveryBasis.count({ where: { organizationId: ORG_A, claimItemId: claimA } });
    expect(all).toBe(2);
  });

  it('并发 supersede → 最终恰一个 effective', async () => {
    const first = await createBasis(ORG_A, claimA, caseA);
    const attempt = (successor: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT "id" FROM "ExpectedRecoveryBasis" WHERE "organizationId" = $1 AND "claimItemId" = $2 AND "supersededAt" IS NULL FOR UPDATE`,
          ORG_A,
          claimA,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "ExpectedRecoveryBasis" SET "supersededAt" = CURRENT_TIMESTAMP, "supersededByBasisId" = $2 WHERE "id" = $1 AND "supersededAt" IS NULL`,
          first,
          successor,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "ExpectedRecoveryBasis"
             ("id","organizationId","claimItemId","caseId","expectedRecoveryAmount","currency","basisKind","basisVersion","basisSource","effectiveAt","createdByUserId")
           VALUES ($1,$2,$3,$4,410.0000,'USD','PROVIDER_POLICY','basis/v2','concurrent',CURRENT_TIMESTAMP,$5)`,
          successor,
          ORG_A,
          claimA,
          caseA,
          uuid(),
        );
      });

    const results = await Promise.allSettled([attempt(uuid()), attempt(uuid())]);
    const effective = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "ExpectedRecoveryBasis" WHERE "organizationId" = $1 AND "claimItemId" = $2 AND "supersededAt" IS NULL`,
      ORG_A,
      claimA,
    );
    expect(effective).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected').length;
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled + rejected).toBe(2);
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(fulfilled).toBeGreaterThanOrEqual(1);
  });
});

describe('R45 S1 · ReconciliationOverrideDecision', () => {
  it('每笔 reimbursement 至多一个决策；同 approval 不得授权两次；append-only', async () => {
    const observed = await createObserved(ORG_A, claimA);
    const approvalId = uuid();
    const created = await prisma.reconciliationOverrideDecision.create({
      data: {
        organizationId: ORG_A,
        claimItemId: claimA,
        reimbursementFactId: observed,
        decisionKind: 'MATCHED',
        reasonCode: 'PARTIAL_ACCEPTED',
        reasonText: '平台只确认了部分金额',
        approvalId,
        decidedByUserId: uuid(),
        decidedAt: new Date('2026-09-06T00:00:00.000Z'),
      },
    });
    await expectRejection(
      () =>
        prisma.reconciliationOverrideDecision.create({
          data: {
            organizationId: ORG_A,
            claimItemId: claimA,
            reimbursementFactId: observed,
            decisionKind: 'UNMATCHED',
            reasonCode: 'DUP',
            reasonText: 'dup',
            approvalId: uuid(),
            decidedByUserId: uuid(),
            decidedAt: new Date('2026-09-06T00:00:00.000Z'),
          },
        }),
      /P2002|unique/i,
    );

    const other = await createObserved(ORG_A, claimA);
    await expectRejection(
      () =>
        prisma.reconciliationOverrideDecision.create({
          data: {
            organizationId: ORG_A,
            claimItemId: claimA,
            reimbursementFactId: other,
            decisionKind: 'MATCHED',
            reasonCode: 'REUSE_APPROVAL',
            reasonText: 'reuse',
            approvalId,
            decidedByUserId: uuid(),
            decidedAt: new Date('2026-09-06T00:00:00.000Z'),
          },
        }),
      /P2002|unique/i,
    );

    await expectRejection(
      () =>
        prisma.$executeRawUnsafe(
          `UPDATE "ReconciliationOverrideDecision" SET "reasonText" = 'x' WHERE "id" = $1`,
          created.id,
        ),
      /APPEND_ONLY_TABLE|23514/,
    );
  });
});

describe('R45 S1 · Projection（derived materialization，CHANGE A / D）', () => {
  it('投影 identity 不可变；projectionVersion 只能 +1', async () => {
    const projection = await createProjection(ORG_A, claimA);
    await expectRejection(
      () =>
        prisma.$executeRawUnsafe(
          `UPDATE "ClaimReconciliationProjection" SET "claimItemId" = $2 WHERE "id" = $1`,
          projection,
          claimB,
        ),
      /IDENTITY_IMMUTABLE|23514/,
    );
    await expectRejection(
      () =>
        prisma.$executeRawUnsafe(
          `UPDATE "ClaimReconciliationProjection" SET "projectionVersion" = 5 WHERE "id" = $1`,
          projection,
        ),
      /VERSION_STEP_INVALID|23514/,
    );
  });

  it('成员关系必须绑定当前 generation：旧版本写入被拒绝；未清理上一代即提升版本被拒绝（立即判定）', async () => {
    const projection = await createProjection(ORG_A, claimA);
    const observed = await createObserved(ORG_A, claimA);

    await expectRejection(
      () =>
        prisma.claimReconciliationProjectionFact.create({
          data: {
            organizationId: ORG_A,
            projectionId: projection,
            projectionVersion: 2,
            reimbursementFactId: observed,
          },
        }),
      /STALE_GENERATION|23514/,
    );

    await prisma.claimReconciliationProjectionFact.create({
      data: {
        organizationId: ORG_A,
        projectionId: projection,
        projectionVersion: 1,
        reimbursementFactId: observed,
      },
    });

    // 未删除上一代 membership 就提升 header 版本 → 立即被拒绝（不使用 deferred 约束）
    await expectRejection(
      () =>
        prisma.$executeRawUnsafe(
          `UPDATE "ClaimReconciliationProjection" SET "projectionVersion" = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
          projection,
        ),
      /STALE_GENERATION|23514/,
    );

    // 合法重算（同事务整体替换）：DELETE 旧 membership → header +1 → INSERT 新 membership
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM "ClaimReconciliationProjectionFact" WHERE "projectionId" = $1`, projection);
      await tx.$executeRawUnsafe(
        `UPDATE "ClaimReconciliationProjection" SET "projectionVersion" = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
        projection,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "ClaimReconciliationProjectionFact"
           ("id","organizationId","projectionId","projectionVersion","reimbursementFactId")
         VALUES ($1,$2,$3,2,$4)`,
        uuid(),
        ORG_A,
        projection,
        observed,
      );
    });

    const members = await prisma.claimReconciliationProjectionFact.findMany({ where: { projectionId: projection } });
    expect(members).toHaveLength(1);
    expect(members[0].projectionVersion).toBe(2);
  });

  it('跨租户成员关系被拒绝', async () => {
    const projectionA = await createProjection(ORG_A, claimA);
    const observedB = await createObserved(ORG_B, claimB);
    await expectRejection(
      () =>
        prisma.claimReconciliationProjectionFact.create({
          data: {
            organizationId: ORG_A,
            projectionId: projectionA,
            projectionVersion: 1,
            reimbursementFactId: observedB,
          },
        }),
      /cross-tenant|check_violation|23514/,
    );
  });
});

describe('R45 S1 · ReconciliationTolerancePolicy（CHANGE C）', () => {
  it('同一 scope 不能产生两个 effective policy；不同 provider 允许共存', async () => {
    await prisma.reconciliationTolerancePolicy.create({
      data: {
        organizationId: ORG_A,
        provider: 'AMAZON',
        operation: 'REIMBURSEMENT',
        policyVersion: 'v1',
        absoluteTolerance: '0.0100',
        relativeTolerance: '0',
        effectiveAt: new Date('2026-09-08T00:00:00.000Z'),
        createdByUserId: uuid(),
      },
    });
    await expectRejection(
      () =>
        prisma.reconciliationTolerancePolicy.create({
          data: {
            organizationId: ORG_A,
            provider: 'AMAZON',
            operation: 'REIMBURSEMENT',
            policyVersion: 'v1',
            absoluteTolerance: '0.0200',
            relativeTolerance: '0',
            effectiveAt: new Date('2026-09-08T01:00:00.000Z'),
            createdByUserId: uuid(),
          },
        }),
      /P2002|unique/i,
    );
    const other = await prisma.reconciliationTolerancePolicy.create({
      data: {
        organizationId: ORG_A,
        provider: 'WALMART',
        operation: 'REIMBURSEMENT',
        policyVersion: 'v1',
        absoluteTolerance: '0.0100',
        relativeTolerance: '0',
        effectiveAt: new Date('2026-09-08T02:00:00.000Z'),
        createdByUserId: uuid(),
      },
    });
    expect(other.id).toBeTruthy();
  });

  it('系统 scope（provider / operation 为空）不得重复登记', async () => {
    await expectRejection(
      () =>
        prisma.reconciliationTolerancePolicy.create({
          data: {
            organizationId: null,
            provider: null,
            operation: null,
            policyVersion: 'v1',
            absoluteTolerance: '0',
            relativeTolerance: '0',
            effectiveAt: new Date('2026-09-08T03:00:00.000Z'),
            createdByUserId: 'PROBE',
          },
        }),
      /P2002|unique/i,
    );
  });
});
