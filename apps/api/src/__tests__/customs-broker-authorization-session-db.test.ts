/** CA-4 REVISE D 真实 PostgreSQL 验收：受控状态机 + CAS 并发 + append-only 事件 + 租户隔离 + 迁移白名单。 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createBrokerAuthorizationSession,
  type BrokerAuthorizationSession,
} from '../services/customs/broker-authorization-session';
import {
  createPrismaBrokerAuthorizationSessionStores,
  persistBrokerAuthorizationSession,
  transitionBrokerAuthorizationSessionPersisted,
} from '../services/customs/broker-authorization-session-store';

const prisma = new PrismaClient();
const stores = createPrismaBrokerAuthorizationSessionStores(prisma);
const deps = { stores };
const actorUserId = 'actor:ca4';

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: 'ca4-' + label, slug: 'ca4-' + label + '-' + randomUUID().slice(0, 8) },
    select: { id: true },
  });
  return org.id;
}

function newSession(organizationId: string, sessionId: string): BrokerAuthorizationSession {
  return createBrokerAuthorizationSession({
    sessionId,
    organizationId,
    principalRef: 'ior:' + sessionId,
    brokerRef: 'broker:1',
    providerRef: 'provider:fixture',
    jurisdiction: 'US',
    requestedScope: ['DUTY_REFUND'],
    externalAuthorizationUrlRef: 'provider-portal:' + sessionId,
    now: new Date('2026-10-04T00:00:00.000Z'),
  });
}

async function persistedSession(organizationId: string, sessionId: string) {
  await persistBrokerAuthorizationSession(newSession(organizationId, sessionId), deps, actorUserId);
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsBrokerAuthorizationSessionEvent", "CustomsBrokerAuthorizationSession", "Organization" CASCADE;',
  );
});

describe('CA-4 — broker authorization session persistence（真实 PostgreSQL）', () => {
  it('创建会话：CREATED + version 1 + 一行 append-only 事件', async () => {
    const organizationId = await seedOrg('create');
    await persistedSession(organizationId, 's-create');

    const row = await stores.find(organizationId, 's-create');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('CREATED');
    expect(row?.version).toBe(1);
    const events = await stores.listEvents(organizationId, 's-create');
    expect(events).toHaveLength(1);
    expect(events[0]?.fromStatus).toBe('CREATED');
    expect(events[0]?.toStatus).toBe('CREATED');
  });

  it('合法迁移链：每次 +1 version，VERIFIED 持久化 verificationSource / verifiedAt', async () => {
    const organizationId = await seedOrg('chain');
    await persistedSession(organizationId, 's-chain');

    const step = async (next: Parameters<typeof transitionBrokerAuthorizationSessionPersisted>[0]['next'], context = {}) =>
      transitionBrokerAuthorizationSessionPersisted(
        { organizationId, sessionId: 's-chain', next, actorUserId, context },
        deps,
      );

    expect((await step('CUSTOMER_ACTION_REQUIRED')).applied).toBe(true);
    expect((await step('SIGNED')).applied).toBe(true);
    expect((await step('PROVIDER_VERIFYING')).applied).toBe(true);
    const verified = await step('VERIFIED', {
      verificationSource: 'MANUAL_REVIEW',
      providerAuthorizationRef: 'provider-auth:abc',
      evidenceArtifactRef: 'evidence:poa',
      at: new Date('2026-10-04T00:04:00.000Z'),
    });
    expect(verified.applied).toBe(true);

    const row = await stores.find(organizationId, 's-chain');
    expect(row?.status).toBe('VERIFIED');
    expect(row?.version).toBe(5);
    expect(row?.verificationSource).toBe('MANUAL_REVIEW');
    expect(row?.verifiedAt).toEqual(new Date('2026-10-04T00:04:00.000Z'));
    expect(row?.completedAt).not.toBeNull();
    expect(row?.evidenceArtifactRef).toBe('evidence:poa');

    const events = await stores.listEvents(organizationId, 's-chain');
    expect(events.map((event) => event.toStatus)).toEqual([
      'CREATED',
      'CUSTOMER_ACTION_REQUIRED',
      'SIGNED',
      'PROVIDER_VERIFYING',
      'VERIFIED',
    ]);
    expect(events[4]?.verificationSource).toBe('MANUAL_REVIEW');
  });

  it('证据门槛：缺 evidenceArtifactRef 的 VERIFIED 被拒绝且不落库', async () => {
    const organizationId = await seedOrg('evidence');
    await persistedSession(organizationId, 's-evidence');
    await transitionBrokerAuthorizationSessionPersisted(
      { organizationId, sessionId: 's-evidence', next: 'SIGNED', actorUserId },
      deps,
    );
    await expect(
      transitionBrokerAuthorizationSessionPersisted(
        {
          organizationId,
          sessionId: 's-evidence',
          next: 'VERIFIED',
          actorUserId,
          context: { verificationSource: 'PROVIDER_EVIDENCE', providerAuthorizationRef: 'provider-auth:abc' },
        },
        deps,
      ),
    ).rejects.toThrow();
    const row = await stores.find(organizationId, 's-evidence');
    expect(row?.status).toBe('SIGNED');
  });

  it('终态不可迁出：DB 触发器拒绝直接 UPDATE', async () => {
    const organizationId = await seedOrg('terminal');
    await persistedSession(organizationId, 's-terminal');
    await transitionBrokerAuthorizationSessionPersisted(
      { organizationId, sessionId: 's-terminal', next: 'REVOKED', actorUserId },
      deps,
    );
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "CustomsBrokerAuthorizationSession" SET "status" = \'SIGNED\', "version" = "version" + 1 WHERE "organizationId" = $1 AND "sessionId" = \'s-terminal\'',
        organizationId,
      ),
    ).rejects.toThrow();
    // service 侧同样 fail-closed
    await expect(
      transitionBrokerAuthorizationSessionPersisted(
        { organizationId, sessionId: 's-terminal', next: 'SIGNED', actorUserId },
        deps,
      ),
    ).rejects.toThrow();
  });

  it('身份字段不可 UPDATE（principalRef / scope / route）', async () => {
    const organizationId = await seedOrg('identity');
    await persistedSession(organizationId, 's-identity');
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "CustomsBrokerAuthorizationSession" SET "principalRef" = \'ior:other\', "version" = "version" + 1 WHERE "organizationId" = $1',
        organizationId,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "CustomsBrokerAuthorizationSession" SET "requestedScope" = \'["OTHER_TOKEN"]\'::jsonb, "version" = "version" + 1 WHERE "organizationId" = $1',
        organizationId,
      ),
    ).rejects.toThrow();
  });

  it('CAS 并发：同 version 双写只有一个 applied=true（exactly-one，无 lost update）', async () => {
    const organizationId = await seedOrg('cas');
    await persistedSession(organizationId, 's-cas');
    const rowBefore = await stores.find(organizationId, 's-cas');

    const [a, b] = await Promise.all([
      transitionBrokerAuthorizationSessionPersisted(
        { organizationId, sessionId: 's-cas', next: 'SIGNED', actorUserId, expectedVersion: rowBefore?.version },
        deps,
      ),
      transitionBrokerAuthorizationSessionPersisted(
        { organizationId, sessionId: 's-cas', next: 'CUSTOMER_ACTION_REQUIRED', actorUserId, expectedVersion: rowBefore?.version },
        deps,
      ),
    ]);
    const appliedCount = [a, b].filter((result) => result.applied).length;
    expect(appliedCount).toBe(1);
    const events = await stores.listEvents(organizationId, 's-cas');
    expect(events).toHaveLength(2);
    const rowAfter = await stores.find(organizationId, 's-cas');
    expect(rowAfter?.version).toBe(2);
  });

  it('租户隔离：跨租户不可读，事件不得引用其它租户会话', async () => {
    const orgA = await seedOrg('tenant-a');
    const orgB = await seedOrg('tenant-b');
    await persistedSession(orgA, 's-tenant');

    expect(await stores.find(orgB, 's-tenant')).toBeNull();
    const rowA = await stores.find(orgA, 's-tenant');

    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO "CustomsBrokerAuthorizationSessionEvent" ("id", "organizationId", "sessionRowId", "fromStatus", "toStatus", "contentDigest", "observedAt") VALUES ($1, $2, $3, \'CREATED\', \'SIGNED\', $4, now())',
        randomUUID(),
        orgB,
        rowA?.id,
        'a'.repeat(64),
      ),
    ).rejects.toThrow();
  });

  it('append-only：事件行不可 UPDATE / DELETE', async () => {
    const organizationId = await seedOrg('append');
    await persistedSession(organizationId, 's-append');
    const events = await stores.listEvents(organizationId, 's-append');
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "CustomsBrokerAuthorizationSessionEvent" SET "reason" = \'tampered\' WHERE "id" = $1',
        events[0]?.id,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "CustomsBrokerAuthorizationSessionEvent" WHERE "id" = $1', events[0]?.id),
    ).rejects.toThrow();
  });

  it('未知会话 / 过期 version → 不落库', async () => {
    const organizationId = await seedOrg('stale');
    const missing = await transitionBrokerAuthorizationSessionPersisted(
      { organizationId, sessionId: 'nope', next: 'SIGNED', actorUserId },
      deps,
    );
    expect(missing).toEqual({ applied: false, reason: 'NOT_FOUND' });

    await persistedSession(organizationId, 's-stale');
    const stale = await transitionBrokerAuthorizationSessionPersisted(
      { organizationId, sessionId: 's-stale', next: 'SIGNED', actorUserId, expectedVersion: 99 },
      deps,
    );
    expect(stale).toEqual({ applied: false, reason: 'STALE' });
    const row = await stores.find(organizationId, 's-stale');
    expect(row?.status).toBe('CREATED');
  });

  it('FINAL-D1：同状态 UPDATE（改 evidence/digest 但不迁移）被 DB 拒绝，且不产生事件', async () => {
    const organizationId = await seedOrg('same-status');
    await persistedSession(organizationId, 's-same');
    await transitionBrokerAuthorizationSessionPersisted(
      { organizationId, sessionId: 's-same', next: 'SIGNED', actorUserId },
      deps,
    );
    const before = await stores.find(organizationId, 's-same');
    expect(before?.status).toBe('SIGNED');
    expect(before?.version).toBe(2);

    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "CustomsBrokerAuthorizationSession" SET "evidenceArtifactRef" = \'evidence:bypass\', "contentDigest" = $2, "version" = "version" + 1 WHERE "organizationId" = $1 AND "sessionId" = \'s-same\'',
        organizationId,
        'b'.repeat(64),
      ),
    ).rejects.toThrow();

    const after = await stores.find(organizationId, 's-same');
    expect(after?.status).toBe('SIGNED');
    expect(after?.version).toBe(2);
    expect(after?.evidenceArtifactRef).toBeNull();
    const events = await stores.listEvents(organizationId, 's-same');
    expect(events).toHaveLength(2);
  });
});
