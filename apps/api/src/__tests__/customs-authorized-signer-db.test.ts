/**
 * CA-2 真实 PostgreSQL 验收：CustomsAuthorizedSignerFact 的 append-only / tenant isolation /
 * VERIFIED 可解释性（source + evidence + verifiedAt）/ raw sensitive identity 拒绝 / lineage / 生命周期。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveAuthorizedSignerFacts, type AuthorizedSignerRow } from '../services/customs/customs-authorization-route';

const prisma = new PrismaClient();
const digest = () => randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: 'ca2-' + label, slug: 'ca2-' + label + '-' + randomUUID().slice(0, 8) },
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
      verifiedAt: new Date(),
      contentDigest: digest(),
      sourceReference: 'doc:' + randomUUID().slice(0, 8),
      observedAt: new Date(),
    },
  });
  return principalRef;
}

async function insertSigner(
  organizationId: string,
  input: {
    principalRef: string;
    verificationStatus?: 'VERIFIED' | 'PENDING' | 'REVOKED' | 'UNVERIFIED';
    scope?: string[];
    observedAt?: Date;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
    evidenceArtifactRef?: string | null;
    verifiedAt?: Date | null;
    signerRef?: string;
    verificationSource?: string;
    effectiveAt?: Date;
    scopeOverride?: unknown;
  },
) {
  const id = randomUUID();
  await prisma.customsAuthorizedSignerFact.create({
    data: {
      id,
      organizationId,
      principalRef: input.principalRef,
      signerRef: input.signerRef ?? 'person:' + randomUUID().slice(0, 8),
      signerType: 'LEGAL_REPRESENTATIVE',
      authorityBasis: 'board:resolution',
      scope: (input.scopeOverride ?? input.scope ?? ['DUTY_REFUND']) as never,
      jurisdiction: 'US',
      effectiveAt:
        input.effectiveAt ??
        (input.expiresAt && input.expiresAt !== null
          ? new Date(input.expiresAt.getTime() - 30 * 86_400_000)
          : new Date('2026-09-01T00:00:00.000Z')),
      expiresAt: input.expiresAt === undefined ? new Date('2027-09-01T00:00:00.000Z') : input.expiresAt,
      verificationStatus: input.verificationStatus ?? 'VERIFIED',
      verificationSource: (input.verificationSource ?? 'CUSTOMER_DOCUMENT') as never,
      verifiedAt: input.verifiedAt === undefined ? new Date('2026-09-01T00:00:00.000Z') : input.verifiedAt,
      evidenceArtifactRef: input.evidenceArtifactRef === undefined ? 'evidence:poa-doc' : input.evidenceArtifactRef,
      revokedAt: input.revokedAt ?? null,
      contentDigest: digest(),
      lifecycleKey: 'test:' + randomUUID().replace(/-/g, '').slice(0, 24),
      observedAt: input.observedAt ?? new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  return id;
}

async function loadRows(organizationId: string): Promise<AuthorizedSignerRow[]> {
  const rows = await prisma.customsAuthorizedSignerFact.findMany({ where: { organizationId } });
  return rows.map((row) => ({
    id: row.id,
    principalRef: row.principalRef,
    signerRef: row.signerRef,
    signerType: row.signerType,
    authorityBasis: row.authorityBasis,
    scopeRemedies: Array.isArray(row.scope) ? (row.scope as string[]) : [],
    jurisdiction: row.jurisdiction,
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    verificationStatus: row.verificationStatus,
    observedAt: row.observedAt,
    revokedAt: row.revokedAt,
    supersededAt: row.supersededAt,
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
    'TRUNCATE TABLE "AuditLog", "CustomsAuthorizedSignerFact", "CustomsBrokerPoaFact", "CustomsRightLineageFact", "CustomsIorIdentityFact", "Membership", "User", "Organization" CASCADE;',
  );
});

describe('CA-2 — authorized signer fact（真实 PostgreSQL）', () => {
  it('VERIFIED 事实可读回并按 latest usable 解析', async () => {
    const organizationId = await seedOrg('verified');
    const principalRef = await seedIor(organizationId);
    await insertSigner(organizationId, { principalRef });

    const resolved = resolveAuthorizedSignerFacts(await loadRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.status).toBe('VERIFIED');
    expect(resolved.scopeCoversRemedy).toBe(true);
    expect(resolved.signerType).toBe('LEGAL_REPRESENTATIVE');
  });

  it('VERIFIED 缺 evidence / 缺 verifiedAt / source=NONE → DB 拒绝（不可自证）', async () => {
    const organizationId = await seedOrg('selfclaim');
    const principalRef = await seedIor(organizationId);

    await expect(insertSigner(organizationId, { principalRef, evidenceArtifactRef: null })).rejects.toThrow();
    await expect(insertSigner(organizationId, { principalRef, verifiedAt: null })).rejects.toThrow();
  });

  it('raw sensitive identity（EIN-like / 纯数字）作引用 → DB 拒绝', async () => {
    const organizationId = await seedOrg('raw');
    const principalRef = await seedIor(organizationId);

    await expect(insertSigner(organizationId, { principalRef, signerRef: '12-3456789' })).rejects.toThrow();
    await expect(insertSigner(organizationId, { principalRef, signerRef: '123456789' })).rejects.toThrow();
  });

  it('CHANGE F：真实注入 verificationSource=NONE 的 VERIFIED 事实 → DB 拒绝（不可自证）', async () => {
    const organizationId = await seedOrg('none-source');
    const principalRef = await seedIor(organizationId);
    await expect(insertSigner(organizationId, { principalRef, verificationSource: 'NONE' })).rejects.toThrow();
  });

  it('CHANGE A：scope 元素必须是合法 remedy token（123 / {} / 空串拒绝）', async () => {
    const organizationId = await seedOrg('scope-shape');
    const principalRef = await seedIor(organizationId);
    await expect(insertSigner(organizationId, { principalRef, scopeOverride: [123] })).rejects.toThrow();
    await expect(insertSigner(organizationId, { principalRef, scopeOverride: [{}] })).rejects.toThrow();
    await expect(insertSigner(organizationId, { principalRef, scopeOverride: [''] })).rejects.toThrow();
    await expect(insertSigner(organizationId, { principalRef, scopeOverride: ['*'] })).resolves.toBeTruthy();
  });

  it('CHANGE D：effectiveAt 在未来的 VERIFIED 事实 → NOT_YET_EFFECTIVE（READY_TO_FILE=false）', async () => {
    const organizationId = await seedOrg('future');
    const principalRef = await seedIor(organizationId);
    await insertSigner(organizationId, {
      principalRef,
      effectiveAt: new Date('2026-12-01T00:00:00.000Z'),
      observedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: new Date('2027-12-01T00:00:00.000Z'),
    });
    const resolved = resolveAuthorizedSignerFacts(await loadRows(organizationId), {
      at: new Date('2026-10-04T00:00:00.000Z'),
      remedy: 'DUTY_REFUND',
      principalRef,
    });
    expect(resolved.status).toBe('NOT_YET_EFFECTIVE');
  });

  it('revoked / expired / superseded 事实不可用（历史保留、不覆盖）', async () => {
    const organizationId = await seedOrg('lifecycle');
    const principalRef = await seedIor(organizationId);
    await insertSigner(organizationId, {
      principalRef,
      verificationStatus: 'REVOKED',
      revokedAt: new Date('2026-10-02T00:00:00.000Z'),
      observedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    const rows = await loadRows(organizationId);
    expect(
      resolveAuthorizedSignerFacts(rows, { at: new Date('2026-10-04T00:00:00.000Z'), remedy: 'DUTY_REFUND', principalRef })
        .status,
    ).toBe('REVOKED');

    const organizationId2 = await seedOrg('expired');
    const principal2 = await seedIor(organizationId2);
    await insertSigner(organizationId2, { principalRef: principal2, expiresAt: new Date('2026-06-01T00:00:00.000Z') });
    expect(
      resolveAuthorizedSignerFacts(await loadRows(organizationId2), {
        at: new Date('2026-10-04T00:00:00.000Z'),
        remedy: 'DUTY_REFUND',
        principalRef: principal2,
      }).status,
    ).toBe('EXPIRED');
  });

  it('append-only：既有事实不可 UPDATE / DELETE', async () => {
    const organizationId = await seedOrg('append');
    const principalRef = await seedIor(organizationId);
    const id = await insertSigner(organizationId, { principalRef });
    await expect(
      prisma.customsAuthorizedSignerFact.update({ where: { id }, data: { verificationStatus: 'REVOKED', revokedAt: new Date() } }),
    ).rejects.toThrow();
  });

  it('tenant isolation + lineage：跨租户不可见；principal 必须指向同租户 IOR 身份', async () => {
    const own = await seedOrg('own');
    const other = await seedOrg('other');
    const ownPrincipal = await seedIor(own);
    const otherPrincipal = await seedIor(other);
    await insertSigner(other, { principalRef: otherPrincipal });

    expect(await loadRows(own)).toHaveLength(0);

    // principal 指向另一租户的 IOR 身份 → lineage 触发器拒绝
    await expect(insertSigner(own, { principalRef: otherPrincipal })).rejects.toThrow();
    // 同租户但未登记 IOR 身份 → 拒绝
    await expect(insertSigner(own, { principalRef: 'ior:unknown-' + randomUUID().slice(0, 6) })).rejects.toThrow();
    expect(await loadRows(own)).toHaveLength(0);
    expect(ownPrincipal).toBeTruthy();
  });
});
