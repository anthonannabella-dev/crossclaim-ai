// B2 引用行为测试（TASK 1）：A/B 可引用 SYSTEM RuleVersion；跨租户引用 TENANT RuleVersion 被拒且关系不变

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const ORG_A = 'b2f00000-0000-4000-8000-00000000000a';
const ORG_B = 'b2f00000-0000-4000-8000-00000000000b';
const RS_SYS = 'b2e10000-0000-4000-8000-000000000001';
const RS_A = 'b2e10000-0000-4000-8000-000000000002';
const RV_SYS = 'b2e20000-0000-4000-8000-000000000001';
const RV_A = 'b2e20000-0000-4000-8000-000000000002';
const EV_A_SYS = 'b2e30000-0000-4000-8000-000000000001';
const EV_B_SYS = 'b2e30000-0000-4000-8000-000000000002';

async function insertEvaluation(id: string, organizationId: string, ruleVersionId: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleEvaluation" ("id","organizationId","ruleVersionId","result","computed","evaluatedAt")
     VALUES ($1,$2,$3,$4::"RuleEvaluationResult",'{}'::jsonb,now())`,
    id,
    organizationId,
    ruleVersionId,
    'PASS',
  );
}

beforeAll(async () => {
  await cleanup();
  for (const [id, name, slug] of [
    [ORG_A, 'B2 Ref Tenant A', 'b2-ref-tenant-a'],
    [ORG_B, 'B2 Ref Tenant B', 'b2-ref-tenant-b'],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Organization" ("id","name","slug","status","plan","locale","timezone","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','TRIAL','zh-CN','Asia/Shanghai',now(),now()) ON CONFLICT DO NOTHING`,
      id,
      name,
      slug,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleSet" ("id","name","ownerType","ownerKey","organizationId","domain","channel","scope","createdAt","updatedAt")
     VALUES ('${RS_SYS}','B2 REF SYSTEM RULESET','SYSTEM','GLOBAL',NULL,'LOGISTICS','UPS','FREIGHT_RATE',now(),now())
     ON CONFLICT DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleSet" ("id","name","ownerType","ownerKey","organizationId","domain","channel","scope","createdAt","updatedAt")
     VALUES ('${RS_A}','B2 REF TENANT A RULESET','TENANT','${ORG_A}','${ORG_A}','LOGISTICS','UPS','FREIGHT_RATE',now(),now())
     ON CONFLICT DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleVersion" ("id","ruleSetId","organizationId","tier","source","version","effectiveFrom","definition","isActive","createdAt")
     VALUES ('${RV_SYS}','${RS_SYS}',NULL,'DEFAULT','B2-FIX','v1',now(),'{}'::jsonb,true,now())
     ON CONFLICT DO NOTHING`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleVersion" ("id","ruleSetId","organizationId","tier","source","version","effectiveFrom","definition","isActive","createdAt")
     VALUES ('${RV_A}','${RS_A}','${ORG_A}','DEFAULT','B2-FIX','v1',now(),'{}'::jsonb,true,now())
     ON CONFLICT DO NOTHING`,
  );
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleVersion" WHERE "source" = 'B2-FIX' OR "ruleSetId" IN (SELECT "id" FROM "RuleSet" WHERE "name" LIKE 'B2 %')`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleSet" WHERE "name" LIKE 'B2 %'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleEvaluation" WHERE "organizationId" IN ($1,$2)`, ORG_A, ORG_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleVersion" WHERE "id" IN ($1,$2)`, RV_SYS, RV_A).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleSet" WHERE "id" IN ($1,$2)`, RS_SYS, RS_A).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" IN ($1,$2)`, ORG_A, ORG_B).catch(() => {});
}

describe('B2 引用行为 — 真实 PostgreSQL（自带夹具）', () => {
  it('01 A 租户可引用 SYSTEM RuleVersion', async () => {
    await insertEvaluation(EV_A_SYS, ORG_A, RV_SYS);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "id" = $1 AND "organizationId" = $2`,
      EV_A_SYS,
      ORG_A,
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('02 B 租户也可引用同一 SYSTEM RuleVersion（系统规则对所有租户合法）', async () => {
    await insertEvaluation(EV_B_SYS, ORG_B, RV_SYS);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "id" = $1`,
      EV_B_SYS,
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('03 跨租户引用 TENANT RuleVersion 被拒绝，且引用关系不变', async () => {
    let rejected = false;
    let message = '';
    try {
      await insertEvaluation('b2e30000-0000-4000-8000-000000000009', ORG_B, RV_A);
    } catch (error) {
      rejected = true;
      message = String((error as { message?: string })?.message ?? '');
    }
    expect(rejected).toBe(true);
    expect(message.toLowerCase()).toMatch(/cross-tenant|tenant/);
    const leaked = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "organizationId" = $1 AND "ruleVersionId" = $2`,
      ORG_B,
      RV_A,
    );
    expect(Number(leaked[0].n)).toBe(0);
    const rv = await prisma.$queryRawUnsafe<Array<{ organizationId: string }>>(
      `SELECT "organizationId" FROM "RuleVersion" WHERE "id" = $1`,
      RV_A,
    );
    expect(rv[0].organizationId).toBe(ORG_A);
  });

  it('04 同租户引用 TENANT RuleVersion 正常', async () => {
    await insertEvaluation('b2e30000-0000-4000-8000-00000000000a', ORG_A, RV_A);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "ruleVersionId" = $1 AND "organizationId" = $2`,
      RV_A,
      ORG_A,
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
