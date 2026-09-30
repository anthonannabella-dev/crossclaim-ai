// B2-FIX R1 行为测试（MSG-20260930-06/07：自带夹具、识别目标保护、失败后状态不变）
// 夹具：自建 Organization A/B + Case(A) + Claim(A->caseA)，全部由本测试创建，不依赖其他测试数据。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const ORG_A = 'b2a00000-0000-4000-8000-00000000000a';
const ORG_B = 'b2a00000-0000-4000-8000-00000000000b';
const CASE_A = 'b2c00000-0000-4000-8000-00000000000a';
const CLAIM_A = 'b2d00000-0000-4000-8000-00000000000a';
const SLUG_A = 'b2-tenant-a';
const SLUG_B = 'b2-tenant-b';

beforeAll(async () => {
  await cleanup();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Organization" ("id","name","slug","status","plan","locale","timezone","createdAt","updatedAt")
     VALUES ($1,'B2 Tenant A',$3,'ACTIVE','TRIAL','zh-CN','Asia/Shanghai',now(),now()),
            ($2,'B2 Tenant B',$4,'ACTIVE','TRIAL','zh-CN','Asia/Shanghai',now(),now())
     ON CONFLICT DO NOTHING`,
    ORG_A,
    ORG_B,
    SLUG_A,
    SLUG_B,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Case" ("id","organizationId","caseNo","title","domain","currency","openedAt","updatedAt")
     VALUES ($1,$2,'B2-CASE-1','B2 fixture case','LOGISTICS','USD',now(),now()) ON CONFLICT DO NOTHING`,
    CASE_A,
    ORG_A,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Claim" ("id","organizationId","caseId","round","target","updatedAt")
     VALUES ($1,$2,$3,1,'CARRIER',now()) ON CONFLICT DO NOTHING`,
    CLAIM_A,
    ORG_A,
    CASE_A,
  );
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM "Claim" WHERE "id" = $1`, CLAIM_A).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "Case" WHERE "id" = $1`, CASE_A).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "id" IN ($1,$2)`, ORG_A, ORG_B).catch(() => {});
}

async function orgOfCase(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ organizationId: string }>>(
    `SELECT "organizationId" FROM "Case" WHERE "id" = $1`,
    CASE_A,
  );
  return rows[0]?.organizationId ?? '';
}

describe('B2 归属不可变 — 真实 PostgreSQL 行为（自带夹具）', () => {
  it('01 夹具存在且父对象归属正确（前置断言，缺失即失败而非跳过）', async () => {
    expect(await orgOfCase()).toBe(ORG_A);
    const claims = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "Claim" WHERE "caseId" = $1 AND "organizationId" = $2`,
      CASE_A,
      ORG_A,
    );
    expect(Number(claims[0].n)).toBe(1);
  });

  it('02 父对象改租户被拒绝：错误标记 + SQLSTATE 23514 + 失败后归属与关系不变', async () => {
    let code = '';
    let message = '';
    try {
      await prisma.$executeRawUnsafe(`UPDATE "Case" SET "organizationId" = $1 WHERE "id" = $2`, ORG_B, CASE_A);
    } catch (error) {
      const e = error as { code?: string; meta?: { code?: string }; message?: string };
      code = e?.meta?.code ?? e?.code ?? '';
      message = e?.message ?? '';
    }
    expect(message).toContain('TENANT_REASSIGNMENT_FORBIDDEN');
    expect(code).toBe('23514'); // 目标保护：CHECK VIOLATION，而非"任意异常"
    expect(await orgOfCase()).toBe(ORG_A); // 失败后原归属未变
    const rel = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "Claim" c JOIN "Case" k ON k."id" = c."caseId"
        WHERE c."id" = $1 AND c."organizationId" = k."organizationId"`,
      CLAIM_A,
    );
    expect(Number(rel[0].n)).toBe(1); // 关系仍同租户
  });

  it('03 同租户同值更新仍允许（不过度封锁；影响行数必须 >0）', async () => {
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE "Case" SET "organizationId" = "organizationId" WHERE "id" = $1`,
      CASE_A,
    );
    expect(Number(affected)).toBeGreaterThan(0);
    expect(await orgOfCase()).toBe(ORG_A);
  });

  it('04 并发非法改归属：全部被拒，不能有一个成功', async () => {
    const attempt = () =>
      prisma.$executeRawUnsafe(`UPDATE "Case" SET "organizationId" = $1 WHERE "id" = $2`, ORG_B, CASE_A);
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        const e = r.reason as { message?: string };
        expect(String(e?.message)).toContain('TENANT_REASSIGNMENT_FORBIDDEN');
      }
    }
    expect(await orgOfCase()).toBe(ORG_A);
  });
});
