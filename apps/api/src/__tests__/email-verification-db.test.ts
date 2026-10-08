/**
 * PC-01B / P0 — EMAIL VERIFICATION + PASSWORD RECOVERY（真实 PostgreSQL）
 * 验收 A–E 的 DB 级证据：只存 digest / UNIQUE tokenHash / supersede / 原子消费（并发只有一个成功）/
 * email 验证不改 passwordChangedAt / reset 撤销全部 session。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import {
  createPrismaAuthTokenAccountPort,
  createPrismaEmailVerificationPort,
  createPrismaPasswordResetPort,
} from '../services/auth/auth-prisma';
import {
  createFakeEmailDelivery,
  hashAuthToken,
  requestEmailVerification,
  requestPasswordReset,
  resetPasswordWithToken,
  verifyEmailWithToken,
  type AuthLifecycleDeps,
} from '../services/auth/email-verification';
import { verifyPassword } from '../services/auth/password';

const prisma = new PrismaClient();
const ipSalt = 'db-test-ip-salt-0123456789';

const delivery = createFakeEmailDelivery();
const deps: AuthLifecycleDeps = {
  accounts: createPrismaAuthTokenAccountPort(prisma),
  emailVerification: createPrismaEmailVerificationPort(prisma),
  passwordReset: createPrismaPasswordResetPort(prisma),
  delivery,
  audit: createAuditWriter(createPrismaAuditSink(prisma), { ipSalt }),
  ipSalt,
};

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const TRUNCATE_ALL_SQL =
  'TRUNCATE TABLE "AuditLog", "Session", "EmailVerificationToken", "PasswordResetToken", "Membership", "User", "Organization" CASCADE;';

/**
 * 间歇失败修复（第二次全量回归实测：本文件某个用例报 `Hook timed out in 10000ms`）。
 *
 * 实测失败发生在**钩子**而不是用例断言：`TRUNCATE … CASCADE` 需要 ACCESS EXCLUSIVE 锁，
 * 共享开发库上若有其它连接持有相关表的锁（本机后台 `rsi-run` 进程、或上一个测试文件尚未释放的连接），
 * TRUNCATE 会一直等待到 Vitest 默认 hookTimeout（10s）⇒ 报 "Hook timed out"。
 * 该用例本身在单文件隔离运行时 8/8 通过。
 *
 * 处置（只让等待**有界且可重试**，不改任何判据）：
 *   ① 事务内 `SET LOCAL lock_timeout`，把「无限等待」变成「最多等 3 秒」；
 *   ② 失败按退避重试最多 6 次；
 *   ③ 该 beforeEach 显式放宽到 30s（覆盖建连 + 退避重试的合法开销）。
 */
async function truncateAll(attempts = 6): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '3s'");
        await tx.$executeRawUnsafe(TRUNCATE_ALL_SQL);
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

beforeEach(
  async () => {
    delivery.outbox.length = 0;
    await truncateAll();
  },
  30_000,
);

async function seedUser(options: { emailVerified?: boolean } = {}) {
  const organization = await prisma.organization.create({
    data: { name: 'lifecycle-org', slug: 'lifecycle-' + randomUUID().slice(0, 8) },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      email: 'lifecycle-' + randomUUID().slice(0, 8) + '@example.com',
      passwordHash: null,
      displayName: 'Lifecycle User',
      status: 'ACTIVE',
      emailVerified: options.emailVerified ?? false,
    },
    select: { id: true, email: true },
  });
  await prisma.membership.create({
    data: {
      organizationId: organization.id,
      userId: user.id,
      role: 'OWNER',
      invitedBy: 'self_signup',
      isActive: true,
    },
  });
  return { organizationId: organization.id, userId: user.id, email: user.email };
}

describe('PC-01B — email verification / password recovery（真实 PostgreSQL）', () => {
  it('A：签发后库内只有 digest（明文 token 不存在于表内）', async () => {
    const user = await seedUser();
    const result = await requestEmailVerification({ userId: user.userId, ip: '203.0.113.10' }, deps);
    expect(result.issued).toBe(true);
    const token = delivery.outbox.at(-1)!.token;

    const rows = await prisma.emailVerificationToken.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashAuthToken(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.consumedAt).toBeNull();
    expect(rows[0]!.supersededAt).toBeNull();
    expect(rows[0]!.requesterIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);

    const audits = await prisma.auditLog.findMany({ where: { organizationId: user.organizationId } });
    expect(audits.map((row) => row.action)).toContain('user.email_verification_requested');
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it('B：重发 supersede 旧 token（旧链接 SUPERSEDED，新链接可用）', async () => {
    const user = await seedUser();
    await requestEmailVerification({ userId: user.userId }, deps);
    const firstToken = delivery.outbox.at(-1)!.token;
    const second = await requestEmailVerification({ userId: user.userId }, deps);
    expect(second.supersededTokens).toBe(1);
    const secondToken = delivery.outbox.at(-1)!.token;

    expect((await verifyEmailWithToken({ token: firstToken }, deps)).outcome).toBe('SUPERSEDED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).emailVerified).toBe(false);
    expect((await verifyEmailWithToken({ token: secondToken }, deps)).outcome).toBe('OK');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).emailVerified).toBe(true);
  });

  it('C：同一 token 并发消费 → 恰好一个成功（DB 级 CAS）', async () => {
    const user = await seedUser();
    await requestEmailVerification({ userId: user.userId }, deps);
    const token = delivery.outbox.at(-1)!.token;

    const results = await Promise.all([
      verifyEmailWithToken({ token }, deps),
      verifyEmailWithToken({ token }, deps),
    ]);
    const outcomes = results.map((row) => row.outcome).sort();
    expect(outcomes).toEqual(['ALREADY_CONSUMED', 'OK']);

    const rows = await prisma.emailVerificationToken.findMany({ where: { userId: user.userId } });
    expect(rows.filter((row) => row.consumedAt !== null)).toHaveLength(1);
  });

  it('C2：过期 token = EXPIRED（不改变 emailVerified）', async () => {
    const user = await seedUser();
    const token = 'expired-' + randomUUID().slice(0, 8);
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.userId,
        tokenHash: hashAuthToken(token),
        expiresAt: new Date(Date.now() - 60_000),
        createdAt: new Date(Date.now() - 120_000),
      },
    });
    expect((await verifyEmailWithToken({ token }, deps)).outcome).toBe('EXPIRED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).emailVerified).toBe(false);
  });

  it('D：邮箱验证成功不改写 passwordChangedAt', async () => {
    const user = await seedUser();
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    await requestEmailVerification({ userId: user.userId }, deps);
    await verifyEmailWithToken({ token: delivery.outbox.at(-1)!.token }, deps);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(after.emailVerified).toBe(true);
    expect(after.passwordChangedAt).toEqual(before.passwordChangedAt);
    expect(after.passwordChangedAt).toBeNull();
  });

  it('E：reset 原子生效（新 hash + passwordChangedAt + 撤销全部 session）', async () => {
    const user = await seedUser({ emailVerified: true });
    for (const index of [0, 1]) {
      await prisma.session.create({
        data: {
          organizationId: user.organizationId,
          userId: user.userId,
          tokenHash: 'session-' + index + '-' + randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }

    await requestPasswordReset({ email: user.email }, deps);
    const token = delivery.outbox.at(-1)!.token;
    const resetTokenRow = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.userId } });
    expect(resetTokenRow.tokenHash).toBe(hashAuthToken(token));

    const result = await resetPasswordWithToken({ token, newPassword: 'db-reset-pass-1234' }, deps);
    expect(result.outcome).toBe('OK');
    expect(result.revokedSessions).toBe(2);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(updated.passwordChangedAt).not.toBeNull();
    expect(verifyPassword('db-reset-pass-1234', updated.passwordHash ?? '')).toBe(true);
    expect(await prisma.session.count({ where: { userId: user.userId, revokedAt: null } })).toBe(0);
    expect(
      (await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.userId } })).consumedAt,
    ).not.toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: user.organizationId, action: 'user.password_reset_completed' },
    });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  it('F：forgot-password 不暴露存在性（存在/不存在同形，且不签发多余 token）', async () => {
    const user = await seedUser({ emailVerified: true });
    const existing = await requestPasswordReset({ email: user.email }, deps);
    const unknown = await requestPasswordReset({ email: 'missing-' + randomUUID().slice(0, 8) + '@example.com' }, deps);
    expect(existing).toEqual(unknown);
    expect(await prisma.passwordResetToken.count()).toBe(1);
    expect(delivery.outbox.filter((row) => row.kind === 'PASSWORD_RESET')).toHaveLength(1);
  });

  it('tokenHash UNIQUE：同一 digest 不得并存两行', async () => {
    const user = await seedUser();
    const token = 'unique-' + randomUUID();
    const data = {
      userId: user.userId,
      tokenHash: hashAuthToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await prisma.emailVerificationToken.create({ data });
    await expect(prisma.emailVerificationToken.create({ data })).rejects.toThrow();
  });
});
