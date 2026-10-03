/**
 * C-0013-A — 来源指纹与幂等（真实 PostgreSQL）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createClaimItem } from '../services/claim/claim-items';
import { FINGERPRINT_VERSION, sourceFingerprintV1 } from '../services/claim/source-fingerprint';
import { WorkflowError } from '../services/workflow';

const prisma = new PrismaClient();
const ORG = 'b6000000-0000-4000-8000-000000000001';
let B2_CONNECTION_ID = '';
const NOW = new Date('2026-09-10T12:00:00Z');

let ownerId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItemEvidence", "ClaimItem", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "SourceConnection", "PlatformAccount", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '指纹租户', slug: 'fp-org' } });
  // TRACK B BATCH 2：连接器/内部调用方必须提供可信连接上下文（同租户 + 已绑定 PlatformAccount）。
  const b2Account = await prisma.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: 'AMAZON',
      externalAccountId: 'fixture-' + ORG,
      displayName: 'fixture account',
    },
  });
  const b2Connection = await prisma.sourceConnection.create({
    data: {
      id: undefined,
      organizationId: ORG,
      domain: 'LOGISTICS',
      channel: 'OTHER',
      kind: 'API',
      status: 'ACTIVE',
      label: 'fingerprint fixture',
      platformAccountId: b2Account.id,
    },
  });
  B2_CONNECTION_ID = b2Connection.id;
  const owner = await prisma.user.create({
    data: { email: 'fp-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });
});

const base = () => ({ organizationId: ORG, actorUserId: ownerId, role: 'OWNER' }) as const;

async function create(overrides: Record<string, unknown> = {}) {
  return createClaimItem(
    prisma,
    {
      ...base(),
      platformType: 'AMAZON',
      claimType: 'FBA_LOSS',
      occurredAt: NOW,
      normalizerVersion: 'normalizer-1.0.0',
      trustedConnectionId: B2_CONNECTION_ID,
      ...overrides,
    } as never,
    { now: () => NOW },
  );
}

const count = () => prisma.claimItem.count({ where: { organizationId: ORG } });

describe('C-0013-A — 幂等优先级与 NULL 契约（真实 PostgreSQL）', () => {
  it('platformRef 优先：指纹不同仍命中既有行', async () => {
    const first = await create({ platformRef: 'REF-A', normalizedRef: 'ship-001' });
    const second = await create({ platformRef: 'REF-A', normalizedRef: 'ship-999' });
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ id: first.id, created: false, idempotency: 'PLATFORM_REF' });
    expect(await count()).toBe(1);
  });

  it('无 platformRef 时用指纹幂等；金额变化不拆单（金额不入指纹）', async () => {
    const first = await create({ normalizedRef: 'ship-001', amountActual: '100.0000' });
    const second = await create({ normalizedRef: 'ship-001', amountActual: '95.0000' });
    expect(second).toMatchObject({ id: first.id, created: false, idempotency: 'SOURCE_FINGERPRINT' });
    expect(await count()).toBe(1);

    const row = await prisma.claimItem.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(row.sourceFingerprint).not.toBeNull();
    expect(row.fingerprintVersion).toBe(FINGERPRINT_VERSION);
  });

  it('跨 UTC 日 → 不同指纹（同引用不同期的事件各自成单）', async () => {
    await create({ normalizedRef: 'ship-001' });
    await create({ normalizedRef: 'ship-001', occurredAt: new Date('2026-10-10T12:00:00Z') });
    expect(await count()).toBe(2);
  });

  it('CONNECTOR_IMPORT 两者皆空 → SOURCE_IDENTITY_REQUIRED（零写入）；MANUAL 维持允许+告警', async () => {
    await expect(create({ creationContext: 'CONNECTOR_IMPORT' })).rejects.toMatchObject({
      code: 'SOURCE_IDENTITY_REQUIRED',
    });
    expect(await count()).toBe(0);

    const manual = await create({ creationContext: 'MANUAL_IMPORT' });
    expect(manual.idempotency).toBe('UNAVAILABLE');
    expect(await count()).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: 'claim.item_created_without_platform_ref' },
      }),
    ).toBe(1);
  });

  it('fingerprintVersion 必须等于当前版本（v1）', async () => {
    await expect(
      create({ normalizedRef: 'ship-001', fingerprintVersion: 'v2' }),
    ).rejects.toThrow(WorkflowError);
    expect(await count()).toBe(0);
  });

  it('部分唯一索引生效：绕过服务层直插同一指纹 → 唯一冲突', async () => {
    const { fingerprint } = sourceFingerprintV1({
      platformType: 'AMAZON',
      claimType: 'FBA_LOSS',
      occurredAt: NOW,
      normalizedRef: 'ship-001',
      currency: 'USD',
    });
    await create({ normalizedRef: 'ship-001' });
    await expect(
      prisma.claimItem.create({
        data: {
          organizationId: ORG,
          platformType: 'AMAZON',
          claimType: 'FBA_LOSS',
          occurredAt: NOW,
          normalizerVersion: 'normalizer-1.0.0',
          sourceFingerprint: fingerprint,
          fingerprintVersion: FINGERPRINT_VERSION,
        },
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(1);
  });

  it('审计不扩散指纹值：只记 fingerprintPresent 与版本', async () => {
    const created = await create({ normalizedRef: 'ship-001' });
    const row = await prisma.claimItem.findUniqueOrThrow({ where: { id: created.id } });
    const audits = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: 'claim.item_created' },
    });
    expect(audits).toHaveLength(1);
    const changes = audits[0].changes as Record<string, unknown>;
    expect(changes.fingerprintPresent).toBe(true);
    expect(changes.fingerprintVersion).toBe(FINGERPRINT_VERSION);
    expect(JSON.stringify(changes)).not.toContain(row.sourceFingerprint as string);
  });
});
