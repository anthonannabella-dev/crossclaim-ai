/**
 * C-0008-B1 — connection management against real PostgreSQL.
 * ------------------------------------------------------------------
 * Proves the human-triggered connection lifecycle:
 *   · create (FILE_UPLOAD ⇒ ACTIVE) with AuditLog.actorUserId in the same transaction
 *   · the approved role matrix (OWNER/ADMIN write; OPS/FINANCE/VIEWER forbidden)
 *   · state machine reuse from Gate 5 (ACTIVE ⇄ PAUSED → REVOKED, terminal)
 *   · credentialRef rotation stores a *reference* and never audits its value
 *   · tenant isolation and duplicate (channel + label) rejection
 *   · audit failure rolls the state change back
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createManagedConnection,
  listConnections,
  rotateConnectionCredentialRef,
  setConnectionStatus,
} from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'cc000000-0000-4000-8000-00000000000a';
const ORG_B = 'cc000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-09-28T18:00:00Z');
const deps = { now: () => NOW, registeredPlatforms: ['UPS_API'] as const };

let adminId = '';
let opsId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "SourceConnection", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '连接租户', slug: 'workflow-conn-org' },
      { id: ORG_B, name: '外部租户', slug: 'workflow-conn-org-b' },
    ],
  });
  const admin = await prisma.user.create({
    data: { email: 'conn-admin@example.com', displayName: '管理员', status: 'ACTIVE' },
  });
  const ops = await prisma.user.create({
    data: { email: 'conn-ops@example.com', displayName: '运营', status: 'ACTIVE' },
  });
  adminId = admin.id;
  opsId = ops.id;
  await prisma.membership.createMany({
    data: [
      { organizationId: ORG, userId: admin.id, role: 'ADMIN', isActive: true },
      { organizationId: ORG, userId: ops.id, role: 'OPS', isActive: true },
      // 同一管理员也是第二个租户的成员，用于跨租户同名的正例
      { organizationId: ORG_B, userId: admin.id, role: 'ADMIN', isActive: true },
    ],
  });
  // MSG-20261002-77：ACTIVE 连接必须绑定 canonical PlatformAccount（每个租户各自的账户）。
  acctA = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG, platform: 'OTHER', externalAccountId: 'WF-CONN-A', displayName: 'wf A' },
      select: { id: true },
    })
  ).id;
  acctB = (
    await prisma.platformAccount.create({
      data: { organizationId: ORG_B, platform: 'OTHER', externalAccountId: 'WF-CONN-B', displayName: 'wf B' },
      select: { id: true },
    })
  ).id;
});

let acctA = '';
let acctB = '';

const bindA = () => ({ mode: 'BIND_EXISTING', platformAccountId: acctA });
const bindB = () => ({ mode: 'BIND_EXISTING', platformAccountId: acctB });

const auditRows = (entityId: string) =>
  prisma.auditLog.findMany({
    where: { entityType: 'SourceConnection', entityId },
    orderBy: { createdAt: 'asc' },
  });

describe('C-0008-B1 — 连接管理（真实 PostgreSQL）', () => {
  it('创建 FILE_UPLOAD 连接：初始 ACTIVE，审计与写入同事务且带 actorUserId', async () => {
    const created = await createManagedConnection(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        label: 'UPS 月度账单',
        kind: 'FILE_UPLOAD',
        domain: 'LOGISTICS',
        channel: 'UPS',
        account: bindA(),
      },
      deps,
    );
    expect(created.status).toBe('ACTIVE');

    const row = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ status: 'ACTIVE', kind: 'FILE_UPLOAD', credentialRef: null });

    const audits = await auditRows(created.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: adminId,
      action: 'source_connection.created',
    });
    expect(audits[0].changes).toEqual({
      kind: 'FILE_UPLOAD',
      label: 'UPS 月度账单',
      domain: 'LOGISTICS',
      channel: 'UPS',
      status: 'ACTIVE',
      platform: null,
      platformAccountId: acctA,
      bindingMode: 'BIND_EXISTING',
      // 含 "credentialref" 的键会被审计脱敏（与 Gate 5 一致），布尔值不可见
      hasCredentialRef: '[REDACTED]',
    });
  });

  it('列表不返回 credentialRef 取值；跨租户不可见；OPS 无权读取', async () => {
    const created = await createManagedConnection(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        label: 'API 连接',
        kind: 'API',
        domain: 'LOGISTICS',
        channel: 'UPS',
        platform: 'UPS_API',
        credentialRef: 'vault:ups-2026',
      },
      deps,
    );
    await prisma.sourceConnection.create({
      data: {
        organizationId: ORG_B,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'FILE_UPLOAD',
        label: '外部租户连接',
        status: 'NEEDS_AUTH',
      },
    });

    const rows = await listConnections(prisma, { organizationId: ORG, actorUserId: adminId, role: 'ADMIN' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.id,
      status: 'NEEDS_AUTH',
      platform: 'UPS_API',
      hasCredentialRef: true,
    });
    expect(Object.keys(rows[0])).not.toContain('credentialRef');
    expect(JSON.stringify(rows)).not.toContain('vault:ups-2026');

    await expect(
      listConnections(prisma, { organizationId: ORG, actorUserId: opsId, role: 'OPS' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('状态迁移沿用 Gate 5 状态机：ACTIVE ⇄ PAUSED → REVOKED（终态），每步一条审计', async () => {
    const created = await createManagedConnection(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        label: 'FedEx 账单',
        kind: 'FILE_UPLOAD',
        domain: 'LOGISTICS',
        channel: 'FEDEX',
        account: bindA(),
      },
      deps,
    );

    await setConnectionStatus(
      prisma,
      { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'PAUSED', reason: '维护中' },
      deps,
    );
    await setConnectionStatus(
      prisma,
      { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'ACTIVE' },
      deps,
    );
    await setConnectionStatus(
      prisma,
      { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'REVOKED' },
      deps,
    );

    const row = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('REVOKED');

    // REVOKED 是终态
    await expect(
      setConnectionStatus(
        prisma,
        { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'ACTIVE' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });

    const audits = await auditRows(created.id);
    expect(audits.map((row) => row.action)).toEqual([
      'source_connection.created',
      'source_connection.status_changed',
      'source_connection.status_changed',
      'source_connection.status_changed',
    ]);
    expect(audits[1].changes).toMatchObject({ from: 'ACTIVE', to: 'PAUSED', reason: '维护中' });
    expect(audits.every((row) => row.actorUserId === adminId)).toBe(true);
  });

  it('凭据引用轮换：只记录形状变化，清空 → NEEDS_AUTH', async () => {
    const created = await createManagedConnection(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        label: 'DHL 账单',
        kind: 'FILE_UPLOAD',
        domain: 'LOGISTICS',
        channel: 'DHL',
        account: bindA(),
      },
      deps,
    );

    const first = await rotateConnectionCredentialRef(
      prisma,
      { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, credentialRef: 'vault:dhl-2026' },
      deps,
    );
    expect(first).toEqual({ hasCredentialRef: true, status: 'ACTIVE' });

    const cleared = await rotateConnectionCredentialRef(
      prisma,
      { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, credentialRef: null },
      deps,
    );
    expect(cleared).toEqual({ hasCredentialRef: false, status: 'NEEDS_AUTH' });

    const row = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.credentialRef).toBeNull();
    expect(row.status).toBe('NEEDS_AUTH');

    const rotations = (await auditRows(created.id)).filter(
      (r) => r.action === 'source_connection.credential_rotated',
    );
    expect(rotations).toHaveLength(2);
    expect(rotations[0].changes).toMatchObject({
      hadCredentialRef: '[REDACTED]',
      hasCredentialRef: '[REDACTED]',
      credentialRefChanged: '[REDACTED]',
    });
    expect(JSON.stringify(rotations)).not.toContain('vault:dhl-2026');
  });

  it('无权限角色：零写入、零审计', async () => {
    await expect(
      createManagedConnection(
        prisma,
        {
          organizationId: ORG,
          actorUserId: opsId,
          role: 'OPS',
          label: '越权连接',
          kind: 'FILE_UPLOAD',
          domain: 'LOGISTICS',
          channel: 'UPS',
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await prisma.sourceConnection.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('同一渠道同名连接 → DUPLICATE_CONNECTION；跨租户同名允许', async () => {
    const input = {
      organizationId: ORG,
      actorUserId: adminId,
      role: 'ADMIN',
      label: '重复连接',
      kind: 'FILE_UPLOAD',
      domain: 'LOGISTICS',
      channel: 'UPS',
    } as const;
    await createManagedConnection(prisma, input, deps);
    await expect(createManagedConnection(prisma, input, deps)).rejects.toMatchObject({
      code: 'DUPLICATE_CONNECTION',
    });

    const other = await createManagedConnection(
      prisma,
      { ...input, organizationId: ORG_B, account: bindB() },
      deps,
    );
    expect(other.status).toBe('ACTIVE');
    expect(await prisma.sourceConnection.count()).toBe(2);
  });

  it('审计写入失败 → 状态迁移回滚（不产生无痕变更）', async () => {
    const created = await createManagedConnection(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        label: '回滚用例',
        kind: 'FILE_UPLOAD',
        domain: 'LOGISTICS',
        channel: 'UPS',
        account: bindA(),
      },
      deps,
    );

    const flaky = {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get: (target, key, receiver) =>
                key === 'auditLog'
                  ? { create: () => Promise.reject(new Error('audit sink unavailable')) }
                  : Reflect.get(target, key, receiver),
            }),
          ),
        ),
    } as unknown as PrismaClient;

    await expect(
      setConnectionStatus(
        flaky,
        { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'PAUSED' },
        deps,
      ),
    ).rejects.toThrow('audit sink unavailable');

    const row = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('ACTIVE');
    expect(await auditRows(created.id)).toHaveLength(1);
  });

  it('并发状态迁移：CAS 只放行一个互斥目标，审计只留一条', async () => {
    const created = await createManagedConnection(
      prisma,
      {
        organizationId: ORG,
        actorUserId: adminId,
        role: 'ADMIN',
        label: '并发连接',
        kind: 'FILE_UPLOAD',
        domain: 'LOGISTICS',
        channel: 'UPS',
        account: bindA(),
      },
      deps,
    );

    // ACTIVE → PAUSED 与 ACTIVE → NEEDS_AUTH 各自都合法，但互为互斥结果：
    // 同一初始状态上并发执行时，只能有一个成功。
    const [first, second] = await Promise.allSettled([
      setConnectionStatus(
        prisma,
        { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'PAUSED' },
        deps,
      ),
      setConnectionStatus(
        prisma,
        { organizationId: ORG, actorUserId: adminId, role: 'ADMIN', connectionId: created.id, to: 'NEEDS_AUTH' },
        deps,
      ),
    ]);

    const winners = [first, second].filter((result) => result.status === 'fulfilled');
    const losers = [first, second].filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });

    const winner = (winners[0] as PromiseFulfilledResult<{ to: string }>).value;
    const row = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe(winner.to);

    const statusAudits = (await auditRows(created.id)).filter(
      (r) => r.action === 'source_connection.status_changed',
    );
    expect(statusAudits).toHaveLength(1);
    expect(statusAudits[0].changes).toMatchObject({ from: 'ACTIVE', to: winner.to });
  });
});
