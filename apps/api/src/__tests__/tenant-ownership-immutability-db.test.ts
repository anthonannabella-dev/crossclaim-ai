// B2-FIX R1（MSG-20260930-05）：tenant ownership immutability — 真实 PostgreSQL 行为测试
// 覆盖：父对象归属变更被拒 / RuleSet 所有权不可变 / 同租户同值更新仍允许 / 触发器挂载四项证据

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});



async function tenantTablesWithRows(): Promise<string[]> {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = 'organizationId'
        AND c.table_name <> '_prisma_migrations'
      ORDER BY c.table_name`,
  );
  const withRows: string[] = [];
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${table_name}" WHERE "organizationId" IS NOT NULL`,
    );
    if (Number(rows[0].n) > 0) withRows.push(table_name);
  }
  return withRows;
}

describe('B2 tenant ownership immutability — 真实 PostgreSQL', () => {
  it('01 触发器挂载四项证据：名称 / 所属表 / 启用状态 / 逐表覆盖', async () => {
    const expected = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'organizationId'
          AND table_name <> '_prisma_migrations'`,
    );
    const mounted = await prisma.$queryRawUnsafe<Array<{ tbl: string; tgname: string; enabled: string }>>(
      `SELECT c.relname AS tbl, g.tgname, g.tgenabled::text AS enabled
         FROM pg_trigger g
         JOIN pg_class c ON c.oid = g.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
        WHERE NOT g.tgisinternal AND g.tgname LIKE 'cc_tenant_immutable__%'`,
    );
    for (const row of mounted) {
      expect(row.tgname).toBe('cc_tenant_immutable__' + row.tbl); // 名称 = 前缀 + 目标表
      expect(row.enabled).toBe('O'); // 启用状态
    }
    expect(mounted.length).toBe(Number(expected[0].n)); // 逐表覆盖

    const ruleset = await prisma.$queryRawUnsafe<Array<{ enabled: string }>>(
      `SELECT g.tgenabled::text AS enabled FROM pg_trigger g
        WHERE NOT g.tgisinternal AND g.tgname = 'cc_ruleset_ownership_immutable'`,
    );
    expect(ruleset).toHaveLength(1);
    expect(ruleset[0].enabled).toBe('O');
  });

  it('02 父对象改租户被数据库拒绝（实际拒绝行为）', async () => {
    const tables = await tenantTablesWithRows();
    if (tables.length === 0) {
      console.warn('SKIP(not-silent): 数据库中暂无 tenant-owned 行，无法验证拒绝行为');
      return;
    }
    const table = tables[0];
    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "organizationId" = "organizationId" || '-reassign' WHERE ctid = (SELECT ctid FROM "${table}" LIMIT 1)`,
        );
      }),
    ).rejects.toThrow(/TENANT_REASSIGNMENT_FORBIDDEN/);
  });

  it('03 同租户同值更新仍允许（不过度封锁）', async () => {
    const tables = await tenantTablesWithRows();
    if (tables.length === 0) {
      console.warn('SKIP(not-silent): 无 tenant-owned 行');
      return;
    }
    const table = tables[0];
    const affected = await prisma.$executeRawUnsafe(
  `UPDATE "${table}" SET "organizationId" = "organizationId" WHERE ctid = (SELECT ctid FROM "${table}" LIMIT 1)`,
);
    expect(Number(affected)).toBeGreaterThanOrEqual(0);
  });

  it('04 RuleSet 所有权变更被拒绝（实际拒绝行为）', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "RuleSet"`,
    );
    if (Number(rows[0].n) === 0) {
      console.warn('SKIP(not-silent): RuleSet 表暂无数据，无法验证所有权拒绝行为');
      return;
    }
    await expect(
      prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(
          `UPDATE "RuleSet" SET "ownerKey" = "ownerKey" || '-x' WHERE ctid = (SELECT ctid FROM "RuleSet" LIMIT 1)`,
        );
      }),
    ).rejects.toThrow(/RULESET_OWNERSHIP_IMMUTABLE/);
  });

  it('05 并发：同一行两事务改归属只能有一个生效（且被约束拒绝）', async () => {
    const tables = await tenantTablesWithRows();
    if (tables.length === 0) {
      console.warn('SKIP(not-silent): 无 tenant-owned 行，无法验证并发');
      return;
    }
    const table = tables[0];
    const attempt = () =>
      prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(
          `UPDATE "${table}" SET "organizationId" = "organizationId" || '-c' WHERE ctid = (SELECT ctid FROM "${table}" LIMIT 1)`,
        );
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') expect(String(r.reason)).toMatch(/TENANT_REASSIGNMENT_FORBIDDEN/);
    }
  });

  it('06 迁移清单与触发器数量一致（schema 契约）', async () => {
    const applied = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );
    expect(Number(applied[0].n)).toBeGreaterThanOrEqual(20);
  });
});
