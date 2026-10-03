/**
 * C-0007 Phase 1 — SourceConnection lifecycle against real PostgreSQL.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createConnection,
  createPrismaConnectionLifecyclePort,
  markConnectionError,
  rotateCredentialRef,
  transitionConnection,
} from '../services/acquisition';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';

const prisma = new PrismaClient();
const ORG = 'f0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'f0000000-0000-4000-8000-000000000002';
const SALT = 'gate5-lifecycle-db-salt-0123456789';

let ACCOUNT_ID = '';
const connections = createPrismaConnectionLifecyclePort(prisma);
const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const deps = { connections, audit, now: () => new Date('2026-09-28T14:30:00Z') };

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "SourceConnection", "PlatformAccount", "Organization" CASCADE;',
  );
  await prisma.organization.createMany({
    data: [
      { id: ORG, name: '生命周期租户', slug: 'lifecycle-org' },
      { id: OTHER_ORG, name: '其他租户', slug: 'lifecycle-other' },
    ],
  });
  // MSG-20261002-77：ACTIVE 连接必须绑定 canonical PlatformAccount。
  ACCOUNT_ID = (
    await prisma.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: 'OTHER',
        externalAccountId: 'LIFECYCLE-ACCOUNT',
        displayName: 'lifecycle account',
      },
      select: { id: true },
    })
  ).id;
});

describe('C-0007 Phase 1 — SourceConnection lifecycle（真实 PostgreSQL）', () => {
  it('创建 → 激活 → 轮换凭据 → 错误 → 暂停 → 恢复 → 吊销，全程留审计', async () => {
    const created = await createConnection(
      {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'UPS',
        kind: 'API',
        label: 'ups lifecycle',
        credentialRef: 'CROSSCLAIM_UPS_RO',
        platformAccountId: ACCOUNT_ID,
      },
      deps,
    );
    expect(created.status).toBe('NEEDS_AUTH');

    await transitionConnection({ organizationId: ORG, connectionId: created.id, to: 'ACTIVE' }, deps);
    expect((await connections.find(ORG, created.id))?.status).toBe('ACTIVE');

    await rotateCredentialRef(
      { organizationId: ORG, connectionId: created.id, credentialRef: 'CROSSCLAIM_UPS_RO_V2' },
      deps,
    );
    const afterRotate = await connections.find(ORG, created.id);
    expect(afterRotate?.credentialRef).toBe('CROSSCLAIM_UPS_RO_V2');
    expect(afterRotate?.status).toBe('ACTIVE');

    await markConnectionError(
      { organizationId: ORG, connectionId: created.id, message: 'upstream 503' },
      deps,
    );
    const afterError = await connections.find(ORG, created.id);
    expect(afterError?.status).toBe('ERROR');

    await transitionConnection({ organizationId: ORG, connectionId: created.id, to: 'PAUSED' }, deps);
    await transitionConnection({ organizationId: ORG, connectionId: created.id, to: 'ACTIVE' }, deps);
    const row = await prisma.sourceConnection.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.lastError).toBeNull();
    expect(row.lastErrorAt).toBeNull();

    await transitionConnection({ organizationId: ORG, connectionId: created.id, to: 'REVOKED' }, deps);
    await expect(
      transitionConnection({ organizationId: ORG, connectionId: created.id, to: 'ACTIVE' }, deps),
    ).rejects.toThrow(/不允许/);

    const actions = (
      await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } })
    ).map((entry) => entry.action);
    expect(actions).toContain('source_connection.created');
    expect(actions).toContain('source_connection.status_changed');
    expect(actions).toContain('source_connection.credential_rotated');

    const rotated = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'source_connection.credential_rotated' },
    });
    expect(JSON.stringify(rotated.changes)).not.toContain('CROSSCLAIM_UPS_RO_V2');
  });

  it('文件上传连接初始即 ACTIVE，且跨租户不可见', async () => {
    const created = await createConnection(
      {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'FILE_UPLOAD',
        label: 'upload lifecycle',
        platformAccountId: ACCOUNT_ID,
      },
      deps,
    );
    expect(created.status).toBe('ACTIVE');
    expect(await connections.find(OTHER_ORG, created.id)).toBeNull();
    await expect(
      transitionConnection({ organizationId: OTHER_ORG, connectionId: created.id, to: 'PAUSED' }, deps),
    ).rejects.toThrow(/不存在或不属于该租户/);
  });

  it('未绑定账户的连接不得被激活（MSG-20261002-77 B3-1 / B3-4 DB 不变量）', async () => {
    const unbound = await createConnection(
      {
        organizationId: ORG,
        domain: 'LOGISTICS',
        channel: 'OTHER',
        kind: 'FILE_UPLOAD',
        label: 'unbound cannot activate',
      },
      deps,
    );
    expect(unbound.status).toBe('NEEDS_AUTH');
    await expect(
      transitionConnection({ organizationId: ORG, connectionId: unbound.id, to: 'ACTIVE' }, deps),
    ).rejects.toThrow(/PLATFORM_ACCOUNT_REQUIRED/);
    expect((await connections.find(ORG, unbound.id))?.status).toBe('NEEDS_AUTH');
  });
});
