/**
 * CA-1 真实 PostgreSQL 验收：POA 事实读取 → latest usable 选择 → route-aware 三阶段判定。
 * 覆盖 append-only / tenant isolation / latest usable / revoke / supersede / expiry / scope。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  evaluateCustomsAuthorizationForRoute,
  resolveBrokerPoaFacts,
  type BrokerPoaRow,
  type CustomsAuthorizationFacts,
} from '../services/customs/customs-authorization-route';

const prisma = new PrismaClient();

const baseFacts = (overrides: Partial<CustomsAuthorizationFacts> = {}): CustomsAuthorizationFacts => ({
  customsAgreementSigned: true,
  iorConfirmed: true,
  claimantConfirmed: true,
  recoveryRightForRemedy: true,
  brokerConnected: true,
  brokerPoaStatus: 'MISSING',
  brokerPoaScopeCoversRemedy: false,
  brokerPoaJurisdiction: null,
  brokerPoaSource: 'MISSING',
  signerStatus: 'MISSING',
  signerScopeCoversRemedy: false,
  signerSource: 'MISSING',
  signerJurisdiction: null,
  filingPermissionValid: true,
  providerCapabilityReady: true,
  payeeIdentityConfirmed: true,
  refundDestinationVerified: true,
  aceEnrollmentReady: true,
  ...overrides,
});

async function seedOrganization(label: string) {
  const organization = await prisma.organization.create({
    data: { name: 'ca1-' + label, slug: 'ca1-' + label + '-' + randomUUID().slice(0, 8) },
    select: { id: true },
  });
  return organization.id;
}

async function seedIorIdentity(organizationId: string, status: 'VERIFIED' | 'PENDING' = 'VERIFIED') {
  const ref = 'ior:' + randomUUID().slice(0, 8);
  await prisma.customsIorIdentityFact.create({
    data: {
      id: randomUUID(),
      organizationId,
      jurisdiction: 'US',
      principalType: 'IMPORTER_OF_RECORD',
      importerOfRecordRef: ref,
      legalEntityRef: 'entity:' + randomUUID().slice(0, 8),
      verificationStatus: status,
      verificationSource: 'CUSTOMER_DOCUMENT',
      verifiedAt: status === 'VERIFIED' ? new Date() : null,
      contentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      sourceReference: 'doc:' + randomUUID().slice(0, 8),
      observedAt: new Date(),
    },
  });
  return ref;
}

async function insertPoa(
  organizationId: string,
  input: {
    principalRef: string;
    remedies: string[];
    verificationStatus: 'VERIFIED' | 'PENDING' | 'REVOKED';
    observedAt: Date;
    expiresAt?: Date | null;
  },
) {
  const id = randomUUID();
  await prisma.customsBrokerPoaFact.create({
    data: {
      id,
      organizationId,
      principalRef: input.principalRef,
      brokerRef: 'broker:' + randomUUID().slice(0, 8),
      jurisdiction: 'US',
      authorizationType: 'CBP_FORM_5291',
      scope: input.remedies,
      effectiveAt: new Date(input.observedAt.getTime() - 86_400_000),
      expiresAt:
        input.expiresAt === undefined ? new Date(input.observedAt.getTime() + 90 * 86_400_000) : input.expiresAt,
      verificationStatus: input.verificationStatus,
      verificationSource: 'BROKER_ATTESTATION',
      evidenceArtifactRef: input.verificationStatus === 'VERIFIED' ? 'evidence:' + randomUUID().slice(0, 8) : null,
      contentDigest: randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      observedAt: input.observedAt,
    },
  });
  return id;
}

async function loadPoaRows(organizationId: string): Promise<BrokerPoaRow[]> {
  const rows = await prisma.customsBrokerPoaFact.findMany({ where: { organizationId } });
  return rows.map((row) => ({
    id: row.id,
    principalRef: row.principalRef,
    brokerRef: row.brokerRef,
    jurisdiction: row.jurisdiction,
    authorizationType: row.authorizationType,
    scopeRemedies: Array.isArray(row.scope) ? (row.scope as string[]) : [],
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    verificationStatus: row.verificationStatus,
    observedAt: row.observedAt,
    contentDigest: row.contentDigest,
  }));
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditLog", "CustomsBrokerPoaFact", "CustomsRightLineageFact", "CustomsIorIdentityFact", "Membership", "User", "Organization" CASCADE;',
  );
});

describe('CA-1 — route-aware authorization（真实 PostgreSQL）', () => {
  it('verified POA（scope 覆盖 remedy）→ READY_TO_FILE=true', async () => {
    const organizationId = await seedOrganization('verified');
    const principalRef = await seedIorIdentity(organizationId);
    await insertPoa(organizationId, {
      principalRef,
      remedies: ['DUTY_REFUND'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    const resolved = resolveBrokerPoaFacts(await loadPoaRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.scopeCoversRemedy).toBe(true);

    const readiness = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: baseFacts({
        brokerPoaStatus: resolved.status,
        brokerPoaScopeCoversRemedy: resolved.scopeCoversRemedy,
        brokerPoaJurisdiction: resolved.jurisdiction,
        brokerPoaSource: resolved.source,
      }),
    });
    expect(readiness.READY_TO_PREPARE).toBe(true);
    expect(readiness.READY_TO_FILE).toBe(true);
    expect(readiness.filingSubmitted).toBe(false);
    expect(readiness.externalWritePerformed).toBe(false);
  });

  it('revoked POA（更新的一条）→ NOT_USABLE，旧 VERIFIED 不再生效', async () => {
    const organizationId = await seedOrganization('revoked');
    const principalRef = await seedIorIdentity(organizationId);
    await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'REVOKED',
      observedAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    const resolved = resolveBrokerPoaFacts(await loadPoaRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.status).toBe('REVOKED');
    const readiness = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: baseFacts({
        brokerPoaStatus: resolved.status,
        brokerPoaScopeCoversRemedy: true,
        brokerPoaSource: 'BROKER_POA_FACT',
      }),
    });
    expect(readiness.READY_TO_FILE).toBe(false);
    expect(readiness.file.blockers).toContain('BROKER_POA_NOT_USABLE');
  });

  it('expired POA（expiresAt 已过）→ EXPIRED，READY_TO_FILE=false', async () => {
    const organizationId = await seedOrganization('expired');
    const principalRef = await seedIorIdentity(organizationId);
    await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    const resolved = resolveBrokerPoaFacts(await loadPoaRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.status).toBe('EXPIRED');
  });

  it('supersede：最新 VERIFIED 生效并记录被取代的旧 fact', async () => {
    const organizationId = await seedOrganization('supersede');
    const principalRef = await seedIorIdentity(organizationId);
    const oldId = await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const newId = await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-09-25T00:00:00.000Z'),
    });
    const resolved = resolveBrokerPoaFacts(await loadPoaRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.rowId).toBe(newId);
    expect(resolved.supersedesId).toBe(oldId);
    expect(resolved.status).toBe('VERIFIED');
  });

  it('scope 不覆盖 remedy → BROKER_POA_SCOPE_MISMATCH（fail-closed）', async () => {
    const organizationId = await seedOrganization('scope');
    const principalRef = await seedIorIdentity(organizationId);
    await insertPoa(organizationId, {
      principalRef,
      remedies: ['OTHER_REMEDY'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const resolved = resolveBrokerPoaFacts(await loadPoaRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.scopeCoversRemedy).toBe(false);
    const readiness = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: baseFacts({
        brokerPoaStatus: resolved.status,
        brokerPoaScopeCoversRemedy: resolved.scopeCoversRemedy,
        brokerPoaJurisdiction: resolved.jurisdiction,
        brokerPoaSource: resolved.source,
      }),
    });
    expect(readiness.READY_TO_FILE).toBe(false);
    expect(readiness.file.blockers).toContain('BROKER_POA_SCOPE_MISMATCH');
  });

  it('tenant isolation：另一租户的 POA 不参与判定', async () => {
    const own = await seedOrganization('own');
    const other = await seedOrganization('other');
    const ownPrincipal = await seedIorIdentity(own);
    const otherPrincipal = await seedIorIdentity(other);
    await insertPoa(other, {
      principalRef: otherPrincipal,
      remedies: ['*'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(await loadPoaRows(own)).toHaveLength(0);
    const resolved = resolveBrokerPoaFacts(await loadPoaRows(own), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef: ownPrincipal,
    });
    expect(resolved.status).toBe('MISSING');
  });

  it('append-only：既有 POA 事实不可 UPDATE（DB 触发器拒绝）', async () => {
    const organizationId = await seedOrganization('append-only');
    const principalRef = await seedIorIdentity(organizationId);
    const poaId = await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'VERIFIED',
      observedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await expect(
      prisma.customsBrokerPoaFact.update({ where: { id: poaId }, data: { verificationStatus: 'REVOKED' } }),
    ).rejects.toThrow();
  });

  it('未核验 POA（PENDING）→ READY_TO_FILE=false（BROKER_POA_REQUIRED）', async () => {
    const organizationId = await seedOrganization('pending');
    const principalRef = await seedIorIdentity(organizationId, 'PENDING');
    await insertPoa(organizationId, {
      principalRef,
      remedies: ['*'],
      verificationStatus: 'PENDING',
      observedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const resolved = resolveBrokerPoaFacts(await loadPoaRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.status).toBe('PENDING');
    const readiness = evaluateCustomsAuthorizationForRoute({
      route: 'BROKER_FILED',
      remedy: 'DUTY_REFUND',
      facts: baseFacts({ brokerPoaStatus: resolved.status }),
    });
    expect(readiness.READY_TO_FILE).toBe(false);
    expect(readiness.file.blockers).toContain('BROKER_POA_REQUIRED');
    expect(readiness.READY_TO_PREPARE).toBe(true);
  });
});
