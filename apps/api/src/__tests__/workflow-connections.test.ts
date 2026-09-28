/**
 * C-0008-B1 — connection management validation (unit, no database).
 * ---------------------------------------------------------------
 * Everything that can be rejected before touching the database is rejected
 * here: permission, label/kind/channel vocabulary, registered-adapter platform
 * rule, and "credentialRef is a reference, never a secret".
 */

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  createManagedConnection,
  rotateConnectionCredentialRef,
  setConnectionStatus,
  type ConnectionManagementDeps,
} from '../services/workflow';
import { ForbiddenError } from '../services/workflow';

const ORG = 'f0000000-0000-4000-8000-00000000000e';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-28T18:00:00Z');

/** A client that fails the test if any query is attempted. */
function untouchable() {
  const transaction = vi.fn(() => {
    throw new Error('DB_SHOULD_NOT_BE_TOUCHED');
  });
  return { prisma: { $transaction: transaction } as unknown as PrismaClient, transaction };
}

interface FakeConnectionTx {
  sourceConnection: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function fakeTx(
  existing: { id: string; status: string; credentialRef?: string | null } | null = null,
  casHits = true,
) {
  // 真实数据库里 credentialRef 是 NULL（不是 undefined），CAS 的 where 会带上它。
  const row = existing ? { credentialRef: null, ...existing } : null;
  const tx: FakeConnectionTx = {
    sourceConnection: {
      findFirst: vi.fn(async () => row),
      create: vi.fn(async () => ({ id: 'conn-1' })),
      updateMany: vi.fn(async () => ({ count: casHits ? 1 : 0 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
  const transaction = vi.fn(async (fn: (client: FakeConnectionTx) => Promise<unknown>) => fn(tx));
  return { prisma: { $transaction: transaction } as unknown as PrismaClient, tx, transaction };
}

const baseCreate = {
  organizationId: ORG,
  actorUserId: ACTOR,
  role: 'ADMIN',
  label: 'UPS 月度账单',
  kind: 'FILE_UPLOAD',
  domain: 'LOGISTICS',
  channel: 'UPS',
} as const;

const deps: ConnectionManagementDeps = { now: () => NOW };

describe('C-0008-B1 — 连接管理：权限与输入校验', () => {
  it('OPS / FINANCE / VIEWER 不能创建或迁移连接', async () => {
    const { prisma } = untouchable();
    for (const role of ['OPS', 'FINANCE', 'VIEWER', 'UNKNOWN']) {
      await expect(
        createManagedConnection(prisma, { ...baseCreate, role }, deps),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        setConnectionStatus(prisma, { organizationId: ORG, actorUserId: ACTOR, role, connectionId: 'c', to: 'PAUSED' }, deps),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        rotateConnectionCredentialRef(
          prisma,
          { organizationId: ORG, actorUserId: ACTOR, role, connectionId: 'c', credentialRef: 'ref-1' },
          deps,
        ),
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it('label / kind / domain / channel 词表校验在触库前完成', async () => {
    const { prisma, transaction } = untouchable();
    const cases: Array<Record<string, unknown>> = [
      { label: '   ' },
      { label: 'x'.repeat(101) },
      { kind: 'SFTP' },
      { kind: 'MANUAL' },
      { domain: 'SHIPPING' },
      { channel: 'NOT_A_CHANNEL' },
    ];
    for (const patch of cases) {
      await expect(
        createManagedConnection(prisma, { ...baseCreate, ...patch }, deps),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('credentialRef 拒绝真实密钥/令牌，只接受引用名', async () => {
    const { prisma, transaction } = untouchable();
    for (const credentialRef of [
      'AKIAIOSFODNN7EXAMPLE',
      'sk-abcdefgh12345',
      'ghp_abcdefgh1234',
      'Bearer abcdef123456',
    ]) {
      await expect(
        createManagedConnection(prisma, { ...baseCreate, credentialRef }, deps),
      ).rejects.toMatchObject({ code: 'SECRET_NOT_ACCEPTED' });
    }
    await expect(
      createManagedConnection(prisma, { ...baseCreate, credentialRef: 'bad\nref' }, deps),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      createManagedConnection(prisma, { ...baseCreate, credentialRef: 'x'.repeat(129) }, deps),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('API 连接必须指定已注册适配器 platform', async () => {
    const { prisma, transaction } = untouchable();
    const api = { ...baseCreate, kind: 'API', credentialRef: 'aws-prod-key-01' } as const;

    await expect(
      createManagedConnection(prisma, { ...api, platform: '' }, deps),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      createManagedConnection(prisma, { ...api, platform: 'UPS_API' }, deps),
    ).rejects.toMatchObject({ code: 'PLATFORM_NOT_REGISTERED' });
    await expect(
      createManagedConnection(
        prisma,
        { ...api, platform: 'UPS_API', credentialRef: undefined },
        { now: () => NOW, registeredPlatforms: ['UPS_API'] },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // 缺 credentialRef
    expect(transaction).not.toHaveBeenCalled();
  });

  it('FILE_UPLOAD 初始状态即 ACTIVE；状态迁移非法值被拒', async () => {
    const { prisma, tx } = fakeTx();
    const created = await createManagedConnection(prisma, baseCreate, deps);
    expect(created).toEqual({ id: 'conn-1', status: 'ACTIVE' });
    expect(tx.sourceConnection.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'FILE_UPLOAD',
        label: 'UPS 月度账单',
        credentialRef: null,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const audit = tx.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({
      actorType: 'USER',
      actorUserId: ACTOR,
      action: 'source_connection.created',
      entityId: 'conn-1',
    });
  });

  it('已注册 platform 的 API 连接把 platform 写入 config，且状态为 NEEDS_AUTH', async () => {
    const { prisma, tx } = fakeTx();
    const created = await createManagedConnection(
      prisma,
      {
        ...baseCreate,
        kind: 'API',
        channel: 'UPS',
        credentialRef: 'aws-prod-key-01',
        platform: 'UPS_API',
      },
      { now: () => NOW, registeredPlatforms: ['UPS_API'] },
    );
    expect(created.status).toBe('NEEDS_AUTH');
    expect(tx.sourceConnection.create.mock.calls[0][0].data.config).toEqual({ platform: 'UPS_API' });
    // hasCredentialRef 命中审计脱敏键（含 "credentialref"），值必然为 [REDACTED]；
    // 与 Gate 5 source_connection.credential_rotated 的历史行为保持一致。
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      platform: 'UPS_API',
      hasCredentialRef: '[REDACTED]',
    });
  });

  it('重复创建同一渠道同名连接 → DUPLICATE_CONNECTION', async () => {
    const { prisma } = fakeTx({ id: 'conn-existing', status: 'ACTIVE' });
    await expect(createManagedConnection(prisma, baseCreate, deps)).rejects.toMatchObject({
      code: 'DUPLICATE_CONNECTION',
    });
  });
});

describe('C-0008-B1 — 连接状态迁移与凭据轮换（单元）', () => {
  it('未定义的迁移被拒（NEEDS_AUTH → PAUSED）', async () => {
    const { prisma, tx } = fakeTx({ id: 'conn-1', status: 'NEEDS_AUTH' });
    await expect(
      setConnectionStatus(
        prisma,
        { organizationId: ORG, actorUserId: ACTOR, role: 'OWNER', connectionId: 'conn-1', to: 'PAUSED' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(tx.sourceConnection.updateMany).not.toHaveBeenCalled();
  });

  it('相同状态重复迁移被拒，且不写审计', async () => {
    const { prisma, tx } = fakeTx({ id: 'conn-1', status: 'ACTIVE' });
    await expect(
      setConnectionStatus(
        prisma,
        { organizationId: ORG, actorUserId: ACTOR, role: 'OWNER', connectionId: 'conn-1', to: 'ACTIVE' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('非法状态值被拒', async () => {
    const { prisma } = fakeTx({ id: 'conn-1', status: 'ACTIVE' });
    await expect(
      setConnectionStatus(
        prisma,
        { organizationId: ORG, actorUserId: ACTOR, role: 'OWNER', connectionId: 'conn-1', to: 'DELETED' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('轮换凭据引用只记录形状，绝不记录取值', async () => {
    const { prisma, tx } = fakeTx({ id: 'conn-1', status: 'ACTIVE' });
    const result = await rotateConnectionCredentialRef(
      prisma,
      { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN', connectionId: 'conn-1', credentialRef: 'vault:ups-2026-q4' },
      deps,
    );
    expect(result).toEqual({ hasCredentialRef: true, status: 'ACTIVE' });
    const changes = tx.auditLog.create.mock.calls[0][0].data.changes;
    expect(changes).toEqual({
      hadCredentialRef: '[REDACTED]',
      hasCredentialRef: '[REDACTED]',
      credentialRefChanged: '[REDACTED]',
      status: 'ACTIVE',
      at: NOW.toISOString(),
    });
    expect(JSON.stringify(changes)).not.toContain('vault:ups-2026-q4');
    expect(tx.sourceConnection.updateMany).toHaveBeenCalledWith({
      where: { id: 'conn-1', organizationId: ORG, status: 'ACTIVE', credentialRef: null },
      data: { credentialRef: 'vault:ups-2026-q4', status: 'ACTIVE' },
    });
  });

  it('清空凭据引用 → NEEDS_AUTH；已吊销连接不允许轮换', async () => {
    const cleared = fakeTx({ id: 'conn-1', status: 'ACTIVE' });
    const result = await rotateConnectionCredentialRef(
      cleared.prisma,
      { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN', connectionId: 'conn-1', credentialRef: null },
      deps,
    );
    expect(result).toEqual({ hasCredentialRef: false, status: 'NEEDS_AUTH' });

    const revoked = fakeTx({ id: 'conn-1', status: 'REVOKED' });
    await expect(
      rotateConnectionCredentialRef(
        revoked.prisma,
        { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN', connectionId: 'conn-1', credentialRef: 'ref' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });

  it('CAS 未命中（并发修改）→ ILLEGAL_TRANSITION，且不写审计', async () => {
    const statusRace = fakeTx({ id: 'conn-1', status: 'ACTIVE' }, false);
    await expect(
      setConnectionStatus(
        statusRace.prisma,
        { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN', connectionId: 'conn-1', to: 'PAUSED' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(statusRace.tx.auditLog.create).not.toHaveBeenCalled();

    const refRace = fakeTx({ id: 'conn-1', status: 'ACTIVE' }, false);
    await expect(
      rotateConnectionCredentialRef(
        refRace.prisma,
        { organizationId: ORG, actorUserId: ACTOR, role: 'ADMIN', connectionId: 'conn-1', credentialRef: 'vault:new' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(refRace.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
