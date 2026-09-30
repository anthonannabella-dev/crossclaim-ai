// B2 RuleSet 归属不可变行为测试（MSG-20260930-08 配方：SYSTEM + A/B TENANT 夹具，自带、无 SKIP）

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const ORG_A = 'b2a00000-0000-4000-8000-00000000000a';
const ORG_B = 'b2a00000-0000-4000-8000-00000000000b';
const RS_SYS = 'b2e00000-0000-4000-8000-000000000001';
const RS_A = 'b2e00000-0000-4000-8000-000000000002';
const RS_B = 'b2e00000-0000-4000-8000-000000000003';

beforeAll(async () => {
  await cleanup();
  for (const [id, name, slug] of [
    [ORG_A, 'B2 Tenant A', 'b2-tenant-a'],
    [ORG_B, 'B2 Tenant B', 'b2-tenant-b'],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Organization" ("id","name","slug","status","plan","locale","timezone","createdAt","updatedAt")
       VALUES ($1,$2,$3,'ACTIVE','TRIAL','zh-CN','Asia/Shanghai',now(),now()) ON CONFLICT DO NOTHING`,
      id,
      name,
      slug,
    );
  }
  // SYSTEM 规则集（ownerKey=GLOBAL，organizationId=null）
  await prisma.$executeRawUnsafe(
    `INSERT INTO "RuleSet" ("id","name","ownerType","ownerKey","organizationId","domain","channel","scope","createdAt","updatedAt")
     VALUES ($1,'B2 SYSTEM RULESET','SYSTEM','GLOBAL',NULL,'LOGISTICS','UPS','FREIGHT_RATE',now(),now())
     ON CONFLICT DO NOTHING`,
    RS_SYS,
  );
  // A/B TENANT 规则集（ownerKey=organizatonId）
  for (const [id, org, name] of [
    [RS_A, ORG_A, 'B2 TENANT A RULESET'],
    [RS_B, ORG_B, 'B2 TENANT B RULESET'],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RuleSet" ("id","name","ownerType","ownerKey","organizationId","domain","channel","scope","createdAt","updatedAt")
       VALUES ($1,$2,'TENANT',$3,$3,'LOGISTICS','UPS','FREIGHT_RATE',now(),now()) ON CONFLICT DO NOTHING`,
      id,
      name,
      org,
    );
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM "RuleSet" WHERE "id" IN ($1,$2,$3)`, RS_SYS, RS_A, RS_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" IN ($1,$2)`, ORG_A, ORG_B).catch(() => {});
}

async function ownership(id: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ ownerType: string; ownerKey: string; organizationId: string | null }>>(
    `SELECT "ownerType"::text AS "ownerType", "ownerKey", "organizationId" FROM "RuleSet" WHERE "id" = $1`,
    id,
  );
  return rows[0];
}

async function expectRejected(sql: string, ...params: unknown[]) {
  let message = '';
  let code = '';
  try {
    await prisma.$executeRawUnsafe(sql, ...params);
  } catch (error) {
    const e = error as { meta?: { code?: string }; message?: string };
    message = e?.message ?? '';
    code = e?.meta?.code ?? '';
  }
  expect(message).toContain('RULESET_OWNERSHIP_IMMUTABLE');
  expect(code).toBe('23514');
}

describe('B2 RuleSet 所有权不可变 — 真实 PostgreSQL（自带夹具）', () => {
  it('01 夹具存在（SYSTEM + A/B TENANT），缺失即失败', async () => {
    expect((await ownership(RS_SYS)).ownerType).toBe('SYSTEM');
    expect((await ownership(RS_A)).ownerType).toBe('TENANT');
    expect((await ownership(RS_B)).ownerType).toBe('TENANT');
  });

  it('02 SYSTEM→TENANT：改后组合本来自洽，仍被不可变保护拒绝，且归属不变', async () => {
    await expectRejected(
      `UPDATE "RuleSet" SET "ownerType" = 'TENANT', "ownerKey" = $1, "organizationId" = $1 WHERE "id" = $2`,
      ORG_A,
      RS_SYS,
    );
    expect(await ownership(RS_SYS)).toEqual({ ownerType: 'SYSTEM', ownerKey: 'GLOBAL', organizationId: null });
  });

  it('03 TENANT→SYSTEM：改后组合本来自洽，仍被拒绝，且归属不变', async () => {
    await expectRejected(
      `UPDATE "RuleSet" SET "ownerType" = 'SYSTEM', "ownerKey" = 'GLOBAL', "organizationId" = NULL WHERE "id" = $1`,
      RS_A,
    );
    const after = await ownership(RS_A);
    expect(after.ownerType).toBe('TENANT');
    expect(after.organizationId).toBe(ORG_A);
  });

  it('04 单独改 ownerKey：识别 RULESET_OWNERSHIP_IMMUTABLE 与 23514', async () => {
    await expectRejected(`UPDATE "RuleSet" SET "ownerKey" = 'GLOBAL' WHERE "id" = $1`, RS_A);
    expect((await ownership(RS_A)).ownerKey).toBe(ORG_A);
  });

  it('05 TENANT A→B：目标组合自洽（B 租户存在）仍被拒，A 归属不变', async () => {
    await expectRejected(
      `UPDATE "RuleSet" SET "ownerKey" = $1, "organizationId" = $1 WHERE "id" = $2`,
      ORG_B,
      RS_A,
    );
    const after = await ownership(RS_A);
    expect(after.ownerKey).toBe(ORG_A);
    expect(after.organizationId).toBe(ORG_A);
  });

  it('06 合法更新：同值所有权更新与改非所有权字段均正常，影响行数>0', async () => {
    const same = await prisma.$executeRawUnsafe(
      `UPDATE "RuleSet" SET "ownerKey" = "ownerKey", "organizationId" = "organizationId" WHERE "id" = $1`,
      RS_A,
    );
    expect(Number(same)).toBeGreaterThan(0);
    const renamed = await prisma.$executeRawUnsafe(`UPDATE "RuleSet" SET "name" = 'B2 TENANT A RULESET v2' WHERE "id" = $1`, RS_A);
    expect(Number(renamed)).toBeGreaterThan(0);
    expect((await ownership(RS_A)).organizationId).toBe(ORG_A);
  });
});
