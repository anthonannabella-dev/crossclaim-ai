// MSG-20260929-40 硬化：A2 身份只读视图的真实 PostgreSQL 验证。
// 覆盖架构方点名的三件事：租户隔离（跨租户一律 404，不泄露存在性）、
// 只读快照（调用前后事实行数完全一致）、PII 深度扫描（禁键 + 完整邮箱不得泄露）。

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { containsForbiddenKey } from '../services/operations/admin-imports';
import { getMember, getPermissionMatrix, listMembers, maskEmail } from '../services/operations/admin-membership';

const prisma = new PrismaClient();
const ORG = 'cd000000-0000-4000-8000-0000000000a1';
const ORG_B = 'cd000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-09-29T09:00:00Z');
const FUTURE = new Date('2026-10-30T09:00:00Z');
const PAST = new Date('2026-08-01T09:00:00Z');

const OWNER_EMAIL = 'owner.a2@example.com';
const OPS_EMAIL = 'ops.a2@example.com';
const PENDING_EMAIL = 'invited.pending@example.com';
const EXPIRED_EMAIL = 'invited.expired@example.com';
const FOREIGN_EMAIL = 'foreign.tenant@example.com';

const PASSWORD_MARKER = 'pbkdf2:marker-must-not-leak';
const IP_MARKER = 'ip-marker-must-not-leak';
const TOKEN_MARKERS = ['c'.repeat(64), 'd'.repeat(64)];

let ownerId = '';
let opsId = '';
let pendingId = '';
let expiredId = '';
let foreignUserId = '';
const UNKNOWN_USER_ID = 'cd000000-0000-4000-8000-0000000000ff';

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
      { id: ORG, name: '身份只读租户', slug: 'a2-membership-org' },
      { id: ORG_B, name: '外部租户', slug: 'a2-membership-org-b' },
    ],
  });

  const owner = await prisma.user.create({
    data: {
      email: OWNER_EMAIL,
      displayName: '负责人',
      status: 'ACTIVE',
      emailVerified: true,
      lastLoginAt: NOW,
      passwordHash: PASSWORD_MARKER,
    },
  });
  ownerId = owner.id;

  const ops = await prisma.user.create({
    data: {
      email: OPS_EMAIL,
      displayName: '运营',
      status: 'ACTIVE',
      emailVerified: true,
      failedLogins: 3,
      lockedUntil: FUTURE,
      passwordHash: PASSWORD_MARKER,
    },
  });
  opsId = ops.id;

  const pending = await prisma.user.create({
    data: { email: PENDING_EMAIL, displayName: '待接受邀请', status: 'INVITED' },
  });
  pendingId = pending.id;

  const expired = await prisma.user.create({
    data: { email: EXPIRED_EMAIL, displayName: '邀请已过期', status: 'INVITED' },
  });
  expiredId = expired.id;

  const foreign = await prisma.user.create({
    data: { email: FOREIGN_EMAIL, displayName: '外部成员', status: 'ACTIVE' },
  });
  foreignUserId = foreign.id;

  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: ownerId, role: 'OWNER', isActive: true, joinedAt: NOW },
      { organizationId: ORG, userId: opsId, role: 'OPS', isActive: true, joinedAt: new Date(NOW.getTime() - 60_000) },
      { organizationId: ORG, userId: pendingId, role: 'VIEWER', isActive: true, joinedAt: new Date(NOW.getTime() - 120_000) },
      { organizationId: ORG, userId: expiredId, role: 'VIEWER', isActive: false, joinedAt: new Date(NOW.getTime() - 180_000) },
      { organizationId: ORG_B, userId: foreignUserId, role: 'OWNER', isActive: true, joinedAt: NOW },
    ],
  });

  // 会话：一条活跃（未来过期）+ 一条过期；tokenHash / ipHash 均带 marker，用于泄露扫描
  await prisma.session.createMany({
    data: [
      {
        organizationId: ORG,
        userId: ownerId,
        tokenHash: 'session-active-marker',
        expiresAt: FUTURE,
        ipHash: IP_MARKER,
      },
      {
        organizationId: ORG,
        userId: ownerId,
        tokenHash: 'session-expired-marker',
        expiresAt: PAST,
      },
    ],
  });

  await prisma.userInvitation.createMany({
    data: [
      {
        organizationId: ORG,
        email: PENDING_EMAIL,
        role: 'VIEWER',
        tokenHash: TOKEN_MARKERS[0] as string,
        expiresAt: FUTURE,
        createdBy: ownerId,
        attemptCount: 2,
      },
      {
        organizationId: ORG,
        email: EXPIRED_EMAIL,
        role: 'VIEWER',
        tokenHash: TOKEN_MARKERS[1] as string,
        expiresAt: PAST,
        createdBy: ownerId,
        attemptCount: 0,
      },
    ],
  });

  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      createdAt: NOW,
      action: 'a2.snapshot_marker',
      entityType: 'User',
      entityId: ownerId,
      changes: { marker: true },
    },
  });

});

const deps = { prisma, now: () => NOW };
const ownerActor = { organizationId: ORG, role: 'OWNER' } as const;

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

const snapshot = async () => ({
  users: await prisma.user.count(),
  memberships: await prisma.membership.count(),
  sessions: await prisma.session.count(),
  invitations: await prisma.userInvitation.count(),
  audits: await prisma.auditLog.count(),
});

describe('MSG-40 硬化 — A2 租户隔离（真实 PostgreSQL）', () => {
  it('01 列表只含本租户成员，外部租户成员不出现', async () => {
    const list = await listMembers(deps, { ...ownerActor });
    const ids = list.items.map((row) => row.userId);
    expect(ids.sort()).toEqual([ownerId, opsId, pendingId, expiredId].sort());
    expect(ids).not.toContain(foreignUserId);
  });

  it('02 跨租户详情一律 404（NOT_FOUND），不泄露成员是否存在', async () => {
    expect(await codeOf(() => getMember(deps, { ...ownerActor, userId: foreignUserId }))).toBe('NOT_FOUND');
    expect(await codeOf(() => getMember(deps, { ...ownerActor, userId: UNKNOWN_USER_ID }))).toBe('NOT_FOUND');
    expect(await codeOf(() => getMember(deps, { ...ownerActor, userId: 'not-a-uuid' }))).toBe('NOT_FOUND');
  });

  it('03 外部租户会话/邀请不会串入本租户视图', async () => {
    const foreignMember = await prisma.membership.findFirstOrThrow({
      where: { organizationId: ORG_B, userId: foreignUserId },
    });
    expect(foreignMember.role).toBe('OWNER');
    const list = await listMembers(deps, { ...ownerActor });
    expect(list.items.some((row) => row.userId === foreignUserId)).toBe(false);
    expect(containsForbiddenKey(list)).toBeNull();
  });
});

describe('MSG-40 硬化 — A2 PII 深度扫描', () => {
  it('04 邮箱默认掩码：响应内不出现任何完整邮箱', async () => {
    const list = await listMembers(deps, { ...ownerActor });
    const detail = await getMember(deps, { ...ownerActor, userId: ownerId });
    const text = JSON.stringify({ list, detail });
    for (const email of [OWNER_EMAIL, OPS_EMAIL, PENDING_EMAIL, EXPIRED_EMAIL, FOREIGN_EMAIL]) {
      expect(text).not.toContain(email);
    }
    expect(text).not.toContain('owner.a2@');
    expect(list.items.find((row) => row.userId === ownerId)?.emailMasked).toBe(maskEmail(OWNER_EMAIL));
    expect(detail.emailMasked).toBe('o***@example.com');
  });

  it('05 仅 locked 布尔：不出失败次数与解锁时间', async () => {
    const detail = await getMember(deps, { ...ownerActor, userId: opsId });
    expect(detail.locked).toBe(true);
    const text = JSON.stringify(detail);
    expect(text).not.toContain('lockedUntil');
    expect(text).not.toContain('failedLogins');
    expect(text).not.toContain('2026-10-30');
  });

  it('06 会话仅计数：不出 tokenHash / ipHash / 单条会话明细', async () => {
    const detail = await getMember(deps, { ...ownerActor, userId: ownerId });
    expect(detail.sessions).toEqual({ total: 2, active: 1, expired: 1 });
    const text = JSON.stringify(detail);
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('session-active-marker');
    expect(text).not.toContain('session-expired-marker');
    expect(text).not.toContain(IP_MARKER);
    expect(text).not.toContain('userAgent');
  });

  it('07 邀请状态由既有时间戳推导，且不泄露 tokenHash / 邀请链接', async () => {
    const pending = await getMember(deps, { ...ownerActor, userId: pendingId });
    expect(pending.invitations[0]?.status).toBe('PENDING');
    expect(pending.invitations[0]?.attemptCount).toBe(2);

    const expired = await getMember(deps, { ...ownerActor, userId: expiredId });
    expect(expired.invitations[0]?.status).toBe('EXPIRED');

    const text = JSON.stringify({ pending, expired });
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('inviteToken');
    for (const marker of TOKEN_MARKERS) expect(text).not.toContain(marker);
  });

  it('08 凭据与禁键全链路扫描为空（含 passwordHash marker）', async () => {
    const payloads = [
      await listMembers(deps, { ...ownerActor }),
      await getMember(deps, { ...ownerActor, userId: ownerId }),
      await getMember(deps, { ...ownerActor, userId: opsId }),
      getPermissionMatrix(),
    ];
    for (const payload of payloads) {
      expect(containsForbiddenKey(payload)).toBeNull();
      expect(JSON.stringify(payload)).not.toContain(PASSWORD_MARKER);
      expect(JSON.stringify(payload)).not.toContain('passwordHash');
    }
  });
});

describe('MSG-40 硬化 — A2 只读快照', () => {
  it('09 调用前后 User / Membership / Session / UserInvitation / AuditLog 行数完全一致', async () => {
    const before = await snapshot();
    await listMembers(deps, { ...ownerActor });
    await getMember(deps, { ...ownerActor, userId: ownerId });
    await getMember(deps, { ...ownerActor, userId: pendingId });
    getPermissionMatrix();
    expect(await snapshot()).toEqual(before);
  });

  it('10 只读快照在重复调用（分页 + 详情）下依然稳定', async () => {
    const before = await snapshot();
    const first = await listMembers(deps, { ...ownerActor, filter: { limit: 2 } });
    expect(first.items).toHaveLength(2);
    if (first.nextCursor) {
      const second = await listMembers(deps, { ...ownerActor, filter: { limit: 2, cursor: first.nextCursor } });
      expect(second.items.length).toBeGreaterThan(0);
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('MSG-40 硬化 — A2 权限 fail-closed', () => {
  it('11 OPS / FINANCE / VIEWER / 空角色一律 FORBIDDEN', async () => {
    for (const role of ['OPS', 'FINANCE', 'VIEWER', '', null]) {
      expect(await codeOf(() => listMembers(deps, { organizationId: ORG, role }))).toBe('FORBIDDEN');
      expect(await codeOf(() => getMember(deps, { organizationId: ORG, role, userId: ownerId }))).toBe('FORBIDDEN');
    }
  });

  it('12 权限矩阵只读，且来源为代码常量（VIEWER 全 false）', async () => {
    const view = getPermissionMatrix();
    expect(view.readonly).toBe(true);
    expect(view.roles).toEqual(['OWNER', 'ADMIN', 'OPS', 'FINANCE', 'VIEWER']);
    expect(Object.values(view.matrix.VIEWER ?? {}).every((value) => value === false)).toBe(true);
    expect(containsForbiddenKey(view)).toBeNull();
  });
});
