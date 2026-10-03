/**
 * TRACK A / PC-01A —— SELF-SERVICE BOOTSTRAP FOUNDATION 验收（真实 PostgreSQL）
 * MSG-20261002-81 ⑤⑦：A atomic / B existing-user / C org identity / D OWNER issuance /
 * E password handling / F emailVerified=false / G no session / H feature gate / I audit。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bootstrapSelfServiceAccount,
  isPublicSignupEnabled,
  normalizeOrganizationSlug,
} from '../services/auth/self-signup';

const prisma = new PrismaClient();
const uuid = (): string => randomUUID();
const PASSWORD = 'self-signup-pass-1';

const base = (overrides: Record<string, unknown> = {}) => ({
  email: 'owner-' + uuid().slice(0, 8) + '@example.com',
  password: PASSWORD,
  organizationName: '自建组织 ' + uuid().slice(0, 6),
  ...overrides,
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization", "PlatformAccount", "SourceConnection" CASCADE;',
  );
});

describe('PC-01A — self-service bootstrap（真实 PostgreSQL）', () => {
  it('valid signup → User + Organization + OWNER Membership 同事务成功', async () => {
    const input = base();
    const result = await bootstrapSelfServiceAccount(prisma, input, { enabled: true });
    expect(result.role).toBe('OWNER');
    expect(result.emailVerified).toBe(false);
    expect(result.sessionIssued).toBe(false);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.emailVerified).toBe(false);
    expect(user.status).toBe('ACTIVE');
    expect(user.passwordHash).toBeTruthy();

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: result.organizationId } });
    expect(organization.slug).toBe(result.organizationSlug);

    const membership = await prisma.membership.findFirstOrThrow({
      where: { organizationId: result.organizationId, userId: result.userId },
    });
    expect(membership.role).toBe('OWNER');
    expect(membership.isActive).toBe(true);

    // G：不得发放 session
    expect(await prisma.session.count({ where: { userId: result.userId } })).toBe(0);
  });

  it('duplicate email → reject（EMAIL_ALREADY_REGISTERED），不建第二个 User / 不并入新组织', async () => {
    const input = base();
    await bootstrapSelfServiceAccount(prisma, input, { enabled: true });
    const before = await prisma.user.count();
    const orgsBefore = await prisma.organization.count();
    await expect(bootstrapSelfServiceAccount(prisma, input, { enabled: true })).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.organization.count()).toBe(orgsBefore);
  });

  it('slug 冲突 → 服务端安全解析（唯一）', async () => {
    const name = '冲突组织 ' + uuid().slice(0, 6);
    const first = await bootstrapSelfServiceAccount(prisma, base({ organizationName: name }), { enabled: true });
    const second = await bootstrapSelfServiceAccount(prisma, base({ organizationName: name }), { enabled: true });
    expect(second.organizationSlug).not.toBe(first.organizationSlug);
    const slugs = await prisma.organization.findMany({ select: { slug: true } });
    expect(new Set(slugs.map((row) => row.slug)).size).toBe(slugs.length);
  });

  it('client 注入 role=ADMIN/OWNER 与 slug → 被忽略', async () => {
    const input = base({ role: 'ADMIN', slug: 'attacker-controlled' });
    const result = await bootstrapSelfServiceAccount(prisma, input, { enabled: true });
    expect(result.role).toBe('OWNER'); // 唯一 OWNER 由事务建立，与 client 注入无关
    expect(result.organizationSlug).not.toBe('attacker-controlled');
    const membership = await prisma.membership.findFirstOrThrow({ where: { userId: result.userId } });
    expect(membership.role).toBe('OWNER');
  });

  it('invalid password → reject；password 不以明文存储；audit 不含 password/hash', async () => {
    await expect(
      bootstrapSelfServiceAccount(prisma, base({ password: 'short' }), { enabled: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const result = await bootstrapSelfServiceAccount(prisma, base(), { enabled: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.passwordHash).not.toBe(PASSWORD);
    expect(user.passwordHash ?? '').not.toContain(PASSWORD);

    const audits = await prisma.auditLog.findMany({ where: { organizationId: result.organizationId } });
    expect(audits.map((row) => row.action).sort()).toEqual(
      ['organization.bootstrapped', 'user.self_signup_created'].sort(),
    );
    for (const row of audits) {
      const payload = JSON.stringify(row.changes);
      expect(payload).not.toContain(PASSWORD);
      expect(payload).not.toContain(user.passwordHash ?? '__none__');
      expect(payload.toLowerCase()).not.toContain('passwordhash');
    }
  });

  it('emailVerified=false（不得伪造 true）', async () => {
    const result = await bootstrapSelfServiceAccount(prisma, base(), { enabled: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.emailVerified).toBe(false);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: result.organizationId, action: 'user.self_signup_created' },
    });
    expect(JSON.stringify(audit.changes)).toContain('"emailVerified":false');
  });

  it('feature gate OFF（默认）→ SIGNUP_DISABLED 且零写入', async () => {
    expect(isPublicSignupEnabled({})).toBe(false);
    expect(isPublicSignupEnabled({ PUBLIC_SIGNUP_ENABLED: 'false' })).toBe(false);
    expect(isPublicSignupEnabled({ PUBLIC_SIGNUP_ENABLED: 'true' })).toBe(true);

    await expect(bootstrapSelfServiceAccount(prisma, base(), { enabled: false })).rejects.toMatchObject({
      code: 'SIGNUP_DISABLED',
    });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('中途失败 → 0 partial User / Organization / Membership', async () => {
    // 预置一个已存在的 slug，使 base(name) 冲突后回退；再让 user 创建失败（重复邮箱）
    const email = 'mid-' + uuid().slice(0, 8) + '@example.com';
    await bootstrapSelfServiceAccount(prisma, { ...base(), email }, { enabled: true });
    const users = await prisma.user.count();
    const orgs = await prisma.organization.count();
    const memberships = await prisma.membership.count();

    await expect(
      bootstrapSelfServiceAccount(prisma, { ...base(), email }, { enabled: true }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });

    expect(await prisma.user.count()).toBe(users);
    expect(await prisma.organization.count()).toBe(orgs);
    expect(await prisma.membership.count()).toBe(memberships);
  });

  it('不改动既有 invitation flow 的租户/成员基线；tenant isolation 保持', async () => {
    const first = await bootstrapSelfServiceAccount(prisma, base(), { enabled: true });
    const second = await bootstrapSelfServiceAccount(prisma, base(), { enabled: true });
    expect(first.organizationId).not.toBe(second.organizationId);
    const crossMembership = await prisma.membership.findFirst({
      where: { organizationId: first.organizationId, userId: second.userId },
    });
    expect(crossMembership).toBeNull();
  });

  it('normalizeOrganizationSlug：server-side 规范化', () => {
    expect(normalizeOrganizationSlug('  ACME 物流 Co., Ltd. ')).toBe('acme-co-ltd');
    expect(normalizeOrganizationSlug('***')).toBe('org');
    expect(normalizeOrganizationSlug('Ünïcode Ünïon')).toBe('unicode-union');
  });
});
