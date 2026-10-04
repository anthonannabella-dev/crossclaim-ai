/** CA-3 真实 PostgreSQL 验收：append-only 生命周期写入 + 读模型（revoke / renew / latest usable）。 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appendAuthorizationLifecycle,
  createPrismaAuthorizationLifecycleStores,
  readAuthorizationState,
} from '../services/customs/authorization-lifecycle';

const prisma = new PrismaClient();
const stores = createPrismaAuthorizationLifecycleStores(prisma);
const digest = () => randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

const context = {
  customsAgreementSigned: true,
  iorConfirmed: true,
  claimantConfirmed: true,
  recoveryRightForRemedy: true,
  filingPermissionValid: true,
  providerCapabilityReady: true,
  payeeIdentityConfirmed: true,
  refundDestinationVerified: true,
  aceEnrollmentReady: true,
  brokerConnected: true,
};

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: 'ca3-' + label, slug: 'ca3-' + label + '-' + randomUUID().slice(0, 8) },
    select: { id: true },
  });
  return org.id;
}

async function seedIor(organizationId: string) {
  const principalRef = 'ior:' + randomUUID().slice(0, 8);
  await prisma.customsIorIdentityFact.create({
    data: {
      id: randomUUID(),
      organizationId,
      jurisdiction: 'US',
      principalType: 'IMPORTER_OF_RECORD',
      importerOfRecordRef: principalRef,
      legalEntityRef: 'entity:' + randomUUID().slice(0, 8),
      verificationStatus: 'VERIFIED',
      verificationSource: 'CUSTOMER_DOCUMENT',
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      contentDigest: digest(),
      sourceReference: 'doc:' + randomUUID().slice(0, 8),
      observedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  return principalRef;
}

async function seedUser(organizationId: string) {
  const user = await prisma.user.create({
    data: { email: 'ca3-' + randomUUID().slice(0, 8) + '@example.com', displayName: 'CA3 Actor', status: 'ACTIVE' },
    select: { id: true },
  });
  await prisma.membership.create({
    data: { organizationId, userId: user.id, role: 'OWNER', invitedBy: 'test', isActive: true },
  });
  return user.id;
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "CustomsAuthorizedSignerFact", "CustomsBrokerPoaFact", "CustomsRightLineageFact", "CustomsIorIdentityFact", "Membership", "User", "Organization" CASCADE;',
  );
});

describe('CA-3 — authorization lifecycle persistence（真实 PostgreSQL）', () => {
  it('GRANT → RENEW：追加两条事实，历史行不被修改，读模型取最新', async () => {
    const organizationId = await seedOrg('renew');
    const principalRef = await seedIor(organizationId);
    const actorUserId = await seedUser(organizationId);

    await appendAuthorizationLifecycle(
      {
        organizationId,
        actorUserId,
        subject: 'BROKER_POA',
        action: 'GRANT',
        principalRef,
        brokerRef: 'broker:1',
        scope: ['DUTY_REFUND'],
        jurisdiction: 'US',
        effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
        evidenceArtifactRef: 'evidence:poa',
        verificationSource: 'BROKER_ATTESTATION',
      },
      { stores, now: () => new Date('2026-09-01T00:00:00.000Z') },
    );
    await appendAuthorizationLifecycle(
      {
        organizationId,
        actorUserId,
        subject: 'BROKER_POA',
        action: 'RENEW',
        principalRef,
        brokerRef: 'broker:1',
        scope: ['DUTY_REFUND'],
        jurisdiction: 'US',
        effectiveAt: new Date('2026-10-01T00:00:00.000Z'),
        evidenceArtifactRef: 'evidence:poa-2',
        verificationSource: 'BROKER_ATTESTATION',
      },
      { stores, now: () => new Date('2026-10-01T00:00:00.000Z') },
    );

    const rows = await prisma.customsBrokerPoaFact.findMany({ where: { organizationId } });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.observedAt.toISOString()).sort()).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
    ]);

    const state = await readAuthorizationState(
      {
        organizationId,
        principalRef,
        remedy: 'DUTY_REFUND',
        route: 'BROKER_FILED',
        at: new Date('2026-10-02T00:00:00.000Z'),
        context,
      },
      { stores },
    );
    expect(state.brokerPoa.status).toBe('VERIFIED');
    expect(state.brokerPoa.scopeCoversRemedy).toBe(true);
    expect(state.readiness.READY_TO_FILE).toBe(true);
    expect(state.serverDerived).toBe(true);
  });

  it('REVOKE → 追加 REVOKED 事实，读模型 READY_TO_FILE=false（历史行保留）', async () => {
    const organizationId = await seedOrg('revoke');
    const principalRef = await seedIor(organizationId);
    const actorUserId = await seedUser(organizationId);

    const base = {
      organizationId,
      actorUserId,
      subject: 'AUTHORIZED_SIGNER' as const,
      principalRef,
      signerRef: 'person:cfo',
      signerType: 'LEGAL_REPRESENTATIVE' as const,
      authorityBasis: 'board:resolution',
      scope: ['DUTY_REFUND'],
      jurisdiction: 'US',
      evidenceArtifactRef: 'evidence:poa',
      verificationSource: 'CUSTOMER_DOCUMENT' as const,
    };
    await appendAuthorizationLifecycle({ ...base, action: 'GRANT' }, { stores, now: () => new Date('2026-09-01T00:00:00.000Z') });
    const revoked = await appendAuthorizationLifecycle(
      { ...base, action: 'REVOKE', evidenceArtifactRef: null },
      { stores, now: () => new Date('2026-10-02T00:00:00.000Z') },
    );
    expect(revoked.lifecycleStatus).toBe('REVOKED');

    const rows = await prisma.customsAuthorizedSignerFact.findMany({
      where: { organizationId },
      orderBy: { observedAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.verificationStatus).toBe('VERIFIED');
    expect(rows[0]!.revokedAt).toBeNull();
    expect(rows[1]!.verificationStatus).toBe('REVOKED');
    expect(rows[1]!.revokedAt).not.toBeNull();

    const state = await readAuthorizationState(
      {
        organizationId,
        principalRef,
        remedy: 'DUTY_REFUND',
        route: 'SELF_FILED',
        at: new Date('2026-10-03T00:00:00.000Z'),
        context,
      },
      { stores },
    );
    expect(state.signer.status).toBe('REVOKED');
    expect(state.readiness.READY_TO_FILE).toBe(false);
    expect(state.readiness.file.blockers).toContain('SIGNER_NOT_USABLE');
  });

  it('tenant scoping：另一租户的同名 principal 事实不可见', async () => {
    const own = await seedOrg('own');
    const other = await seedOrg('other');
    const ownPrincipal = await seedIor(own);
    const otherPrincipal = await seedIor(other);
    const otherActor = await seedUser(other);

    await appendAuthorizationLifecycle(
      {
        organizationId: other,
        actorUserId: otherActor,
        subject: 'BROKER_POA',
        action: 'GRANT',
        principalRef: otherPrincipal,
        brokerRef: 'broker:1',
        scope: ['DUTY_REFUND'],
        jurisdiction: 'US',
        evidenceArtifactRef: 'evidence:poa',
        verificationSource: 'BROKER_ATTESTATION',
      },
      { stores },
    );

    const state = await readAuthorizationState(
      {
        organizationId: own,
        principalRef: ownPrincipal,
        remedy: 'DUTY_REFUND',
        route: 'BROKER_FILED',
        context,
      },
      { stores },
    );
    expect(state.brokerPoa.status).toBe('MISSING');
    expect(state.readiness.READY_TO_FILE).toBe(false);
  });

  it('append-only：CRUD UPDATE 仍被数据库拒绝（生命周期只能追加新事实）', async () => {
    const organizationId = await seedOrg('append');
    const principalRef = await seedIor(organizationId);
    const actorUserId = await seedUser(organizationId);
    const granted = await appendAuthorizationLifecycle(
      {
        organizationId,
        actorUserId,
        subject: 'BROKER_POA',
        action: 'GRANT',
        principalRef,
        brokerRef: 'broker:1',
        scope: ['DUTY_REFUND'],
        jurisdiction: 'US',
        evidenceArtifactRef: 'evidence:poa',
        verificationSource: 'BROKER_ATTESTATION',
      },
      { stores },
    );
    await expect(
      prisma.customsBrokerPoaFact.update({
        where: { id: granted.factId },
        data: { verificationStatus: 'REVOKED', contentDigest: digest() },
      }),
    ).rejects.toThrow();
  });
});
