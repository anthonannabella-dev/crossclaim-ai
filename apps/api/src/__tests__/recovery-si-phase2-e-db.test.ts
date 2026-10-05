/**
 * Recovery SI P2-E1/E4 —— DB 级 DELETE guard 证据（真实 PostgreSQL）
 * 依据 MSG-20261005-22 必修 4：RecoveryPackage / RecoveryPackageArtifact 必须存在 DB 层 DELETE 拒绝。
 * 本测试只做**只读**取证（pg_trigger / pg_get_triggerdef），不写入业务事实。
 */

import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('Recovery SI P2-E DB · DELETE guard 触发器取证', () => {
  it('P2E-DB1 cc_no_delete__RecoveryPackage / __RecoveryPackageArtifact 已部署且为 BEFORE DELETE', async () => {
    const rows = await prisma.$queryRawUnsafe<{ tgname: string; def: string }[]>(
      `SELECT t.tgname AS tgname, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND t.tgname IN ('cc_no_delete__RecoveryPackage', 'cc_no_delete__RecoveryPackageArtifact')`,
    );
    const byName = new Map(rows.map((r) => [r.tgname, r.def]));
    expect([...byName.keys()].sort()).toEqual([
      'cc_no_delete__RecoveryPackage',
      'cc_no_delete__RecoveryPackageArtifact',
    ]);
    for (const def of byName.values()) {
      expect(def).toMatch(/BEFORE DELETE/i);
    }
  });

  it('P2E-DB2 DELETE guard 函数体仍抛 RECOVERY_PACKAGE_DELETE_FORBIDDEN（迁移可追溯）', async () => {
    const rows = await prisma.$queryRawUnsafe<{ src: string }[]>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname IN ('cc_recovery_package_no_delete', 'cc_recovery_package_artifact_no_delete')`,
    );
    const all = rows.map((r) => r.src).join('\n');
    expect(all).toContain('RECOVERY_PACKAGE_DELETE_FORBIDDEN');
    expect(all).toContain('RECOVERY_PACKAGE_ARTIFACT_DELETE_FORBIDDEN');
  });
});
