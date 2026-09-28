/**
 * C-0008-A — auth foundation against real PostgreSQL.
 * ------------------------------------------------------------------
 * Covers: login → session row (hashed token) → membership 3-step check;
 * cross-tenant denial; failed-login lockout; invitation lifecycle
 * (invite → accept → reject reuse / bad token with attempt counting).
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_POLICY,
  acceptInvitation,
  createInvitation,
  createPrismaAuthUserPort,
  createPrismaInvitationMembershipPort,
  createPrismaInvitationPort,
  createPrismaInvitationUserPort,
  createPrismaMembershipLookup,
  createPrismaSessionPort,
  hashPassword,
  hashSessionToken,
  loginWithPassword,
  resolveSession,
  type SessionDeps,
} from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';

const prisma = new PrismaClient();
const ORG = 'f0000000-0000-4000-8000-00000000000a';
const ORG_B = 'f0000000-0000-4000-8000-00000000000b';
const SALT = 'gate6-auth-db-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const NOW = new Date('2026-09-28T18:00:00Z');
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'admin-password-1';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const sessionDeps: SessionDeps = {
  sessions: createPrismaSessionPort(prisma),
  memberships: createPrismaMembershipLookup(prisma),
  audit,
  ipSalt: SALT,
  policy: DEFAULT_SESSION_POLICY,
  now: () => NOW,
};

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '认证租户', slug: 'auth-org' },
      { id: ORG_B, name: '另一租户', slug: 'auth-org-b' },
    ],
  });
  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash: hashPassword(ADMIN_PASSWORD, FAST_PARAMS),
      displayName: '管理员',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: admin.id, role: 'OWNER', isActive: true },
  });
});

const login = (password: string, email = ADMIN_EMAIL) =>
  loginWithPassword({ email, password }, { users: createPrismaAuthUserPort(prisma), session: sessionDeps, audit, now: () => NOW });

describe('C-0008-A — auth foundation（真实 PostgreSQL）', () => {
  it('登录成功写入哈希会话，并通过 tokenHash→Session→Membership 三步校验', async () => {
    const result = await login(ADMIN_PASSWORD);
    expect(result.organizationId).toBe(ORG);
    expect(result.role).toBe('OWNER');

    const rows = await prisma.session.findMany({ where: { organizationId: ORG } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashSessionToken(result.token));
    expect(rows[0].tokenHash).not.toBe(result.token);

    const context = await resolveSession(result.token, sessionDeps, ORG);
    expect(context).toMatchObject({ organizationId: ORG, role: 'OWNER' });
    expect(await resolveSession(result.token, sessionDeps, ORG_B)).toBeNull();
    expect(await resolveSession('not-a-real-token', sessionDeps)).toBeNull();

    const actions = (await prisma.auditLog.findMany({ where: { organizationId: ORG } })).map(
      (row) => row.action,
    );
    expect(actions).toContain('auth.login_succeeded');
  });

  it('连续 5 次密码错误锁定账号，并留下不含秘密的失败审计', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(login('wrong-password-1')).rejects.toThrow();
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    expect(user.failedLogins).toBe(5);
    expect(user.lockedUntil?.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);

    await expect(login(ADMIN_PASSWORD)).rejects.toThrow(/锁定/);

    const failures = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'auth.login_failed' },
    });
    expect(failures.length).toBeGreaterThanOrEqual(5);
    const serialized = JSON.stringify(failures.map((row) => row.changes));
    expect(serialized).not.toContain('wrong-password-1');
    expect(serialized).not.toContain(ADMIN_PASSWORD);
  });

  it('邀请生命周期：创建 → 接受 → 拒绝重复使用 / 无效令牌（累计 attemptCount）', async () => {
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN_EMAIL } });
    const invitationDeps = {
      invitations: createPrismaInvitationPort(prisma),
      users: createPrismaInvitationUserPort(prisma),
      memberships: createPrismaInvitationMembershipPort(prisma),
      audit,
      scrypt: FAST_PARAMS,
      now: () => NOW,
    };

    const invitation = await createInvitation(
      { organizationId: ORG, email: 'invitee@example.com', role: 'OPS', createdBy: adminUser.id },
      invitationDeps,
    );
    expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const stored = await prisma.userInvitation.findUniqueOrThrow({ where: { id: invitation.invitationId } });
    expect(stored.tokenHash).not.toBe(invitation.token);

    const accepted = await acceptInvitation(
      { token: invitation.token, password: 'invitee-password-1', displayName: '被邀请人' },
      invitationDeps,
    );
    expect(accepted.organizationId).toBe(ORG);
    expect(accepted.role).toBe('OPS');

    const invitee = await prisma.user.findUniqueOrThrow({ where: { email: 'invitee@example.com' } });
    expect(invitee.emailVerified).toBe(true);
    const membership = await prisma.membership.findFirstOrThrow({
      where: { organizationId: ORG, userId: invitee.id },
    });
    expect(membership.role).toBe('OPS');
    const acceptedRow = await prisma.userInvitation.findUniqueOrThrow({ where: { id: invitation.invitationId } });
    expect(acceptedRow.acceptedAt).not.toBeNull();

    // 重复使用同一令牌 → 拒绝并计数
    await expect(
      acceptInvitation({ token: invitation.token, password: 'another-password-1' }, invitationDeps),
    ).rejects.toThrow(/已被使用/);
    expect(
      (await prisma.userInvitation.findUniqueOrThrow({ where: { id: invitation.invitationId } })).attemptCount,
    ).toBe(1);

    // 无效令牌 → 拒绝（未知令牌不计数，因为没有可归属的邀请行）
    await expect(
      acceptInvitation({ token: 'invalid-token-value', password: 'another-password-1' }, invitationDeps),
    ).rejects.toThrow(/无效/);

    const actions = (await prisma.auditLog.findMany({ where: { organizationId: ORG } })).map(
      (row) => row.action,
    );
    expect(actions).toContain('user.invited');
    expect(actions).toContain('user.invitation_accepted');
    expect(actions).toContain('user.invitation_failed');
  });
});
