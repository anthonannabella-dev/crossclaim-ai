// B2 引用行为测试（TASK 1 / MSG-20260930-09 TEST 清单）：
//   A/B 租户可引用合法 SYSTEM RuleVersion；跨租户引用 TENANT RuleVersion（INSERT 与 UPDATE）被拒绝；
//   伪全局版本（organizationId NULL 却指向 TENANT RuleSet）被拒绝；不存在的版本由外键拒绝。
//   所有拒绝均断言目标保护标记与 SQLSTATE（跨租户=23514、外键=23503），并确认失败后无非法行且原引用未变。
//   夹具全部自建、零跳过；夹具缺失、未执行或零行影响均直接失败。

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
const EV_A_TENANT = 'b2e30000-0000-4000-8000-00000000000a';
const EV_B_TO_A = 'b2e30000-0000-4000-8000-00000000000b';
const EV_CROSS_INSERT = 'b2e30000-0000-4000-8000-000000000009';
const EV_MISSING_RV = 'b2e30000-0000-4000-8000-00000000000c';

const RV_MISSING = 'b2e20000-0000-4000-8000-00000000dead';
const RV_PSEUDO_GLOBAL = 'b2e20000-0000-4000-8000-0000000000f2';

interface RawFailure {
  sqlstate?: string;
  message: string;
}

/** 执行语句并断言数据库确实拒绝；未被拒绝时直接抛错，避免验收被静默跳过。 */
async function expectRejected(run: () => Promise<unknown>): Promise<RawFailure> {
  try {
    await run();
  } catch (error) {
    const e = error as { code?: string; meta?: { code?: string; message?: string }; message?: string };
    return {
      sqlstate: e?.meta?.code ?? e?.code,
      message: String(e?.meta?.message ?? e?.message ?? ''),
    };
  }
  throw new Error('EXPECTED_REJECTION_MISSING: 数据库没有拒绝该语句，保护可能缺失');
}

async function insertEvaluation(id: string, organizationId: string, ruleVersionId: string) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "RuleEvaluation" ("id","organizationId","ruleVersionId","result","computed","evaluatedAt")
     VALUES ($1,$2,$3,$4::"RuleEvaluationResult",'{}'::jsonb,now())`,
    id,
    organizationId,
    ruleVersionId,
    'PASS',
  );
}

async function countRows(sql: string, ...params: unknown[]): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...params);
  return Number(rows[0].n);
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
     VALUES ($1,'B2 REF SYSTEM RULESET','SYSTEM','GLOBAL',NULL,'LOGISTICS','UPS','FREIGHT_RATE',now(),now())
     ON CONFLICT DO NOTHING`,
    RS_SYS,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleSet" ("id","name","ownerType","ownerKey","organizationId","domain","channel","scope","createdAt","updatedAt")
     VALUES ($1,'B2 REF TENANT A RULESET','TENANT',$2,$2,'LOGISTICS','UPS','FREIGHT_RATE',now(),now())
     ON CONFLICT DO NOTHING`,
    RS_A,
    ORG_A,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleVersion" ("id","ruleSetId","organizationId","tier","source","version","effectiveFrom","definition","isActive","createdAt")
     VALUES ($1,$2,NULL,'DEFAULT','B2-REF','v1',now(),'{}'::jsonb,true,now())
     ON CONFLICT DO NOTHING`,
    RV_SYS,
    RS_SYS,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleVersion" ("id","ruleSetId","organizationId","tier","source","version","effectiveFrom","definition","isActive","createdAt")
     VALUES ($1,$2,$3,'DEFAULT','B2-REF','v1',now(),'{}'::jsonb,true,now())
     ON CONFLICT DO NOTHING`,
    RV_A,
    RS_A,
    ORG_A,
  );

  // 夹具存在性与归属自检：防止「无夹具 / 夹具被静默跳过」导致的假绿（MSG-20260930-06 CHANGE A）。
  const rulesets = await prisma.$queryRawUnsafe<Array<{ id: string; ownerType: string; organizationId: string | null; ownerKey: string }>>(
    `SELECT "id","ownerType"::text AS "ownerType","organizationId","ownerKey" FROM "RuleSet" WHERE "id" IN ($1,$2)`,
    RS_SYS,
    RS_A,
  );
  expect(rulesets).toHaveLength(2);
  const rsSys = rulesets.find((row) => row.id === RS_SYS);
  const rsA = rulesets.find((row) => row.id === RS_A);
  expect(rsSys?.ownerType).toBe('SYSTEM');
  expect(rsSys?.organizationId).toBeNull();
  expect(rsSys?.ownerKey).toBe('GLOBAL');
  expect(rsA?.ownerType).toBe('TENANT');
  expect(rsA?.organizationId).toBe(ORG_A);
  expect(rsA?.ownerKey).toBe(ORG_A);

  const versions = await prisma.$queryRawUnsafe<Array<{ id: string; organizationId: string | null }>>(
    `SELECT "id","organizationId" FROM "RuleVersion" WHERE "id" IN ($1,$2)`,
    RV_SYS,
    RV_A,
  );
  expect(versions).toHaveLength(2);
  expect(versions.find((row) => row.id === RV_SYS)?.organizationId).toBeNull();
  expect(versions.find((row) => row.id === RV_A)?.organizationId).toBe(ORG_A);
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "RuleEvaluation" WHERE "id" IN ($1,$2,$3,$4,$5,$6)`,
    EV_A_SYS,
    EV_B_SYS,
    EV_A_TENANT,
    EV_B_TO_A,
    EV_CROSS_INSERT,
    EV_MISSING_RV,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleEvaluation" WHERE "organizationId" IN ($1,$2)`, ORG_A, ORG_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleVersion" WHERE "source" = 'B2-REF'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleVersion" WHERE "id" IN ($1,$2,$3)`, RV_SYS, RV_A, RV_PSEUDO_GLOBAL).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleSet" WHERE "name" LIKE 'B2 REF %'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleSet" WHERE "id" IN ($1,$2)`, RS_SYS, RS_A).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" IN ($1,$2)`, ORG_A, ORG_B).catch(() => {});
}

describe('B2 引用行为 —— 真实 PostgreSQL（合成夹具）', () => {
  it('01 A 租户引用合法 SYSTEM RuleVersion：允许并持久化一行', async () => {
    const affected = await insertEvaluation(EV_A_SYS, ORG_A, RV_SYS);
    expect(Number(affected)).toBe(1);
    expect(
      await countRows(
        `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "id" = $1 AND "organizationId" = $2 AND "ruleVersionId" = $3`,
        EV_A_SYS,
        ORG_A,
        RV_SYS,
      ),
    ).toBe(1);
  });

  it('02 B 租户引用同一 SYSTEM RuleVersion：允许（SYSTEM 版本可被各租户引用）', async () => {
    const affected = await insertEvaluation(EV_B_SYS, ORG_B, RV_SYS);
    expect(Number(affected)).toBe(1);
    expect(
      await countRows(`SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "id" = $1 AND "organizationId" = $2`, EV_B_SYS, ORG_B),
    ).toBe(1);
  });

  it('03 跨租户 INSERT 引用 TENANT 版本：拒绝（cross-tenant 标记 + 23514），无非法行且原引用未变', async () => {
    const failure = await expectRejected(() => insertEvaluation(EV_CROSS_INSERT, ORG_B, RV_A));
    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toMatch(/cross-tenant reference blocked/i);
    expect(failure.message).toContain('RuleEvaluation.ruleVersionId');
    expect(failure.message).toContain('RuleVersion');

    expect(
      await countRows(
        `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "organizationId" = $1 AND "ruleVersionId" = $2`,
        ORG_B,
        RV_A,
      ),
    ).toBe(0);
    expect(await countRows(`SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "id" = $1`, EV_CROSS_INSERT)).toBe(0);

    const owner = await prisma.$queryRawUnsafe<Array<{ organizationId: string | null }>>(
      `SELECT "organizationId" FROM "RuleVersion" WHERE "id" = $1`,
      RV_A,
    );
    expect(owner[0]?.organizationId).toBe(ORG_A);
  });

  it('04 同租户 A 引用 TENANT A 版本：允许', async () => {
    const affected = await insertEvaluation(EV_A_TENANT, ORG_A, RV_A);
    expect(Number(affected)).toBe(1);
    expect(
      await countRows(
        `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "ruleVersionId" = $1 AND "organizationId" = $2`,
        RV_A,
        ORG_A,
      ),
    ).toBe(1);
  });

  it('05 已有评估（B 租户）改 ruleVersionId 为 A 的 TENANT 版本：UPDATE 拒绝且原引用未变', async () => {
    const created = await insertEvaluation(EV_B_TO_A, ORG_B, RV_SYS);
    expect(Number(created)).toBe(1);

    const failure = await expectRejected(() =>
      prisma.$executeRawUnsafe(`UPDATE "RuleEvaluation" SET "ruleVersionId" = $1 WHERE "id" = $2`, RV_A, EV_B_TO_A),
    );
    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toMatch(/cross-tenant reference blocked/i);
    expect(failure.message).toContain('RuleEvaluation.ruleVersionId');

    const row = await prisma.$queryRawUnsafe<Array<{ ruleVersionId: string; organizationId: string }>>(
      `SELECT "ruleVersionId","organizationId" FROM "RuleEvaluation" WHERE "id" = $1`,
      EV_B_TO_A,
    );
    expect(row).toHaveLength(1);
    expect(row[0]?.ruleVersionId).toBe(RV_SYS);
    expect(row[0]?.organizationId).toBe(ORG_B);
    expect(
      await countRows(
        `SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "organizationId" = $1 AND "ruleVersionId" = $2`,
        ORG_B,
        RV_A,
      ),
    ).toBe(0);
  });

  it('06 伪全局版本（organizationId NULL 却指向 TENANT A RuleSet）：拒绝', async () => {
    const failure = await expectRejected(() =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "RuleVersion" ("id","ruleSetId","organizationId","tier","source","version","effectiveFrom","definition","isActive","createdAt")
         VALUES ($1,$2,NULL,'DEFAULT','B2-REF','v1',now(),'{}'::jsonb,true,now())`,
        RV_PSEUDO_GLOBAL,
        RS_A,
      ),
    );
    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toMatch(/rule ownership violation/i);
    expect(await countRows(`SELECT count(*)::bigint AS n FROM "RuleVersion" WHERE "id" = $1`, RV_PSEUDO_GLOBAL)).toBe(0);
  });

  it('07 不存在的 RuleVersion：由外键拒绝（23503），不得作为跨租户保护证据', async () => {
    const failure = await expectRejected(() => insertEvaluation(EV_MISSING_RV, ORG_A, RV_MISSING));
    expect(failure.sqlstate).toBe('23503');
    expect(failure.message).toMatch(/foreign key/i);
    expect(failure.message).not.toMatch(/cross-tenant/i);
    expect(await countRows(`SELECT count(*)::bigint AS n FROM "RuleEvaluation" WHERE "id" = $1`, EV_MISSING_RV)).toBe(0);
  });
});
