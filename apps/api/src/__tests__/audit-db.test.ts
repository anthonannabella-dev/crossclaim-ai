/**
 * Wave 1 · 审计 actor 身份的**数据库级**测试
 * （C-0003 Checkpoint 1 · CHANGE #16）
 * ---------------------------------------------------------------
 * 这些断言只有真实 PostgreSQL 才能证明：
 *   - USER actor 保引用完整性（FK → User.id）
 *   - SYSTEM / AI / EXTERNAL 不要求存在 User 记录
 *   - 无效用户引用被数据库拒绝
 *   - actor 身份形状由 CHECK 约束兜底（一个字段不再承担两种语义）
 *
 * 前置：DATABASE_URL 指向已执行 `prisma migrate deploy` 的 PostgreSQL（CI 已具备）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuditWriter, createPrismaAuditSink } from '../services/audit';

const prisma = new PrismaClient();

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const GHOST_USER_ID = '66666666-6666-4666-8666-666666666666';
const FOREIGN_USER_ID = '77777777-7777-4777-8777-777777777777';
const SALT = 'audit-db-salt-0123456789';

const writer = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '审计租户', slug: 'audit-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: '另一个租户', slug: 'audit-org-b' } });
  await prisma.user.create({
    data: { id: USER_ID, email: 'auditor@example.com', displayName: '审计员' },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER_ID, role: 'OWNER' } });
  await prisma.user.create({
    data: { id: FOREIGN_USER_ID, email: 'outsider@example.com', displayName: '外部用户' },
  });
  await prisma.membership.create({
    data: { organizationId: ORG_B, userId: FOREIGN_USER_ID, role: 'OWNER' },
  });
});

describe('CHANGE #16：AuditLog actor 身份', () => {
  it('USER + 合法用户 id → 落库成功，且指向该用户', async () => {
    const record = await writer.record({
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: USER_ID,
      action: 'case.opened',
      entityType: 'Case',
      entityId: 'case-1',
    });

    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.actorType).toBe('USER');
    expect(row.actorUserId).toBe(USER_ID);
    expect(row.actorRef).toBeNull();
  });

  it('SYSTEM / AI / EXTERNAL + ref → 不需要存在对应用户', async () => {
    const cases: Array<{ actorType: 'SYSTEM' | 'AI' | 'EXTERNAL'; actorRef: string }> = [
      { actorType: 'SYSTEM', actorRef: 'crossclaim-api' },
      { actorType: 'AI', actorRef: 'deepseek' },
      { actorType: 'EXTERNAL', actorRef: 'ups-portal' },
    ];

    for (const item of cases) {
      const record = await writer.record({
        organizationId: ORG,
        actorType: item.actorType,
        actorRef: item.actorRef,
        action: 'case.opened',
      });
      const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.actorType).toBe(item.actorType);
      expect(row.actorRef).toBe(item.actorRef);
      expect(row.actorUserId).toBeNull();
    }
  });

  it('无效的 USER 引用 → 被数据库外键拒绝（不会留下脏审计行）', async () => {
    await expect(
      writer.record({
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: GHOST_USER_ID,
        action: 'case.opened',
      }),
    ).rejects.toThrow();

    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('CHECK 兜底：非 USER 行不得挂用户引用（绕过应用层直接写库也会失败）', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id","organizationId","actorType","actorUserId","action","createdAt")
         VALUES (gen_random_uuid()::text, $1, 'SYSTEM', $2, 'illegal.actor', now())`,
        ORG,
        USER_ID,
      ),
    ).rejects.toThrow(/cc_audit_actor_shape_check|violates/i);
  });

  it('organizationId 不允许为空（数据库层拒绝"无租户审计"）', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id","organizationId","actorType","actorRef","action","createdAt")
         VALUES (gen_random_uuid()::text, NULL, 'SYSTEM', 'migration-runner', 'illegal.global', now())`,
      ),
    ).rejects.toThrow(/null value|not-null|violates/i);
  });

  it('租户 A 的审计不得挂"只属于租户 B"的用户（跨租户 actor）', async () => {
    await expect(
      writer.record({
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: FOREIGN_USER_ID,
        action: 'case.opened',
      }),
    ).rejects.toThrow(/membership|cross-tenant|check_violation|violates/i);

    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('租户内的合法成员可以正常写审计（正向基线）', async () => {
    const record = await writer.record({
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: USER_ID,
      action: 'case.opened',
    });
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.organizationId).toBe(ORG);
    expect(row.actorUserId).toBe(USER_ID);
  });

  it('绕过应用层直插跨租户 actor 也会被触发器拒绝', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id","organizationId","actorType","actorUserId","action","createdAt")
         VALUES (gen_random_uuid()::text, $1, 'USER', $2, 'illegal.actor', now())`,
        ORG,
        FOREIGN_USER_ID,
      ),
    ).rejects.toThrow(/membership|cross-tenant|check_violation|violates/i);
  });

  it('审计载荷里的敏感值在真实库里仍是脱敏后的形态', async () => {
    const storageKey = `${ORG}/ab/33333333-3333-4333-8333-333333333333`;
    const record = await writer.record({
      organizationId: ORG,
      actorType: 'EXTERNAL',
      actorRef: 'signed-url',
      action: 'file.downloaded',
      entityType: 'FileAsset',
      entityId: '33333333-3333-4333-8333-333333333333',
      changes: { storageKey, apiKey: 'sk-should-not-appear' },
      ip: '203.0.113.9',
    });

    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: record.id } });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(storageKey);
    expect(serialized).not.toContain('sk-should-not-appear');
    expect(serialized).not.toContain('203.0.113.9');
    expect(row.ip).toMatch(/^[0-9a-f]{32}$/);
  });
});
