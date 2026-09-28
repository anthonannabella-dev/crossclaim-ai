/**
 * C-0013-B — 编排器（真实 PostgreSQL）：幂等、quarantine、cursor 推进、版本变化、边界。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { sourceFingerprintV1 } from '../services/claim/source-fingerprint';
import { FileCursorStore } from '../services/connectors/cursor-store';
import { FixtureFetcher } from '../services/connectors/fixture-fetcher';
import { InMemoryQuarantineSink } from '../services/connectors/quarantine';
import { CONNECTOR_AUDIT, runConnectorPull } from '../services/connectors/runner';
import type { ConnectorDescriptor, FetcherRecord, Normalizer } from '../services/connectors/types';

const prisma = new PrismaClient();
const ORG = 'b7000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-28T18:00:00Z');

let ownerId = '';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ClaimItemEvidence", "ClaimItem", "RuleEvaluation", "PaymentProcessingAttempt", "Payment", "PaymentEvent", "AuditLog", "BillingInvoice", "FeeCalculation", "RecoveryLedgerEntry", "Settlement", "Claim", "CaseEvidence", "EvidenceArtifact", "RecoveryRoute", "CaseOpportunity", "Case", "RecoveryOpportunity", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: '连接器租户', slug: 'connector-org' } });
  const owner = await prisma.user.create({
    data: { email: 'connector-owner@example.com', displayName: '负责人', status: 'ACTIVE' },
  });
  ownerId = owner.id;
  await prisma.membership.createMany({
    data: [{ organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true }],
  });
});

const descriptor: ConnectorDescriptor = {
  connectorId: 'amazon-inventory-v1',
  platformType: 'AMAZON',
  authKind: 'FILE_UPLOAD',
  readonlyScopes: ['inventory:read'],
  resources: ['inventory-ledger'],
};

function makeNormalizer(version = 'test-normalizer-v1'): Normalizer {
  return {
    normalizerVersion: version,
    platformType: 'AMAZON',
    normalize(record: FetcherRecord) {
      const payload = record.payload as Record<string, unknown>;
      if (typeof payload.adjustmentId !== 'string') {
        return { ok: false, reasonCode: 'MISSING_FIELD' } as const;
      }
      const occurredAt = new Date(String(payload.occurredAt ?? ''));
      if (Number.isNaN(occurredAt.getTime())) {
        return { ok: false, reasonCode: 'INVALID_TYPE' } as const;
      }
      const candidate = sourceFingerprintV1({
        platformType: 'AMAZON',
        claimType: 'FBA_LOSS',
        occurredAt,
        normalizedRef: payload.adjustmentId,
        currency: 'USD',
      });
      return {
        ok: true,
        output: {
          platformType: 'AMAZON',
          claimType: 'FBA_LOSS',
          occurredAt,
          amountActual: String(payload.amount ?? '0.0000'),
          currency: 'USD',
          responsibleParty: 'PLATFORM_WAREHOUSE',
          normalizedRef: payload.adjustmentId,
          normalizerVersion: version,
          sourceFingerprintCandidate: candidate.fingerprint,
        },
      } as const;
    },
  };
}

function makeFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-connector-'));
  const file = path.join(dir, 'records.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ resourceRef: 'r1', payload: { adjustmentId: 'a1', occurredAt: '2026-09-10T00:00:00Z', amount: '100.0000' } }),
      JSON.stringify({ resourceRef: 'r2', payload: { adjustmentId: 'a2', occurredAt: '2026-09-11T00:00:00Z', amount: '50.0000' } }),
      JSON.stringify({ resourceRef: 'r3', payload: { occurredAt: '2026-09-11T00:00:00Z' } }),
    ].join('\n'),
    'utf8',
  );
  return file;
}

function deps() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-run-'));
  return {
    dir,
    cursorStore: new FileCursorStore(path.join(dir, 'cursors')),
    quarantine: new InMemoryQuarantineSink(),
  };
}

const base = () => ({ organizationId: ORG, actorUserId: ownerId, role: 'OWNER' }) as const;

describe('C-0013-B — 编排器（真实 PostgreSQL）', () => {
  it('拉取 → 归一化 → 落 ClaimItem（带指纹）；畸形记录进 quarantine；cursor 前进', async () => {
    const file = makeFixture();
    const d = deps();
    const result = await runConnectorPull(
      prisma,
      {
        ...base(),
        connector: descriptor,
        connectionRef: 'conn-1',
        resource: 'inventory-ledger',
        fetcher: new FixtureFetcher(file, () => NOW),
        normalizer: makeNormalizer(),
      },
      { ...d, now: () => NOW },
    );

    expect(result).toMatchObject({ fetched: 3, created: 2, idempotent: 0, quarantined: 1, exhausted: true });
    expect(d.quarantine.entries).toHaveLength(1);
    expect(d.quarantine.entries[0].reasonCode).toBe('MISSING_FIELD');
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(2);
    const withFingerprint = await prisma.claimItem.findMany({ where: { organizationId: ORG } });
    expect(withFingerprint.every((row) => row.sourceFingerprint !== null && row.fingerprintVersion === 'v1')).toBe(true);
    expect(await d.cursorStore.read({ connectionRef: 'conn-1', resource: 'inventory-ledger' })).toBeNull(); // 已到末尾不再写新游标
  });

  it('重复拉取同一页 → 全部幂等，ClaimItem 计数不变', async () => {
    const file = makeFixture();
    const first = deps();
    await runConnectorPull(
      prisma,
      { ...base(), connector: descriptor, connectionRef: 'conn-1', resource: 'inventory-ledger', fetcher: new FixtureFetcher(file, () => NOW), normalizer: makeNormalizer() },
      { ...first, now: () => NOW },
    );
    const second = deps();
    const again = await runConnectorPull(
      prisma,
      { ...base(), connector: descriptor, connectionRef: 'conn-1', resource: 'inventory-ledger', fetcher: new FixtureFetcher(file, () => NOW), normalizer: makeNormalizer() },
      { ...second, now: () => NOW },
    );
    expect(again).toMatchObject({ created: 0, idempotent: 2, quarantined: 1 });
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(2);
  });

  it('归一化器版本变化 → 写 connector.normalizer_version_changed（不重建记录）', async () => {
    const file = makeFixture();
    await runConnectorPull(
      prisma,
      { ...base(), connector: descriptor, connectionRef: 'conn-1', resource: 'inventory-ledger', fetcher: new FixtureFetcher(file, () => NOW), normalizer: makeNormalizer('v1') },
      { ...deps(), now: () => NOW },
    );
    const before = await prisma.claimItem.count({ where: { organizationId: ORG } });
    await runConnectorPull(
      prisma,
      { ...base(), connector: descriptor, connectionRef: 'conn-1', resource: 'inventory-ledger', fetcher: new FixtureFetcher(file, () => NOW), normalizer: makeNormalizer('v2') },
      { ...deps(), now: () => NOW },
    );
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(before);
    const changed = await prisma.auditLog.findMany({
      where: { organizationId: ORG, action: CONNECTOR_AUDIT.versionChanged },
    });
    expect(changed).toHaveLength(1);
    expect(changed[0].changes).toMatchObject({ from: 'v1', to: 'v2' });
  });

  it('只读边界：编排器不调用规则引擎，也不碰 Settlement / Payment / Billing', async () => {
    const file = makeFixture();
    const before = {
      evaluations: await prisma.ruleEvaluation.count(),
      settlements: await prisma.settlement.count(),
      payments: await prisma.payment.count(),
      invoices: await prisma.billingInvoice.count(),
    };
    await runConnectorPull(
      prisma,
      { ...base(), connector: descriptor, connectionRef: 'conn-1', resource: 'inventory-ledger', fetcher: new FixtureFetcher(file, () => NOW), normalizer: makeNormalizer() },
      { ...deps(), now: () => NOW },
    );
    expect({
      evaluations: await prisma.ruleEvaluation.count(),
      settlements: await prisma.settlement.count(),
      payments: await prisma.payment.count(),
      invoices: await prisma.billingInvoice.count(),
    }).toEqual(before);

    const audits = await prisma.auditLog.findMany({ where: { organizationId: ORG }, orderBy: { createdAt: 'asc' } });
    const actions = audits.map((row) => row.action);
    expect(actions).toContain(CONNECTOR_AUDIT.pullStarted);
    expect(actions).toContain(CONNECTOR_AUDIT.pullFinished);
  });

  it('connector 缺 connectorId / 只读 scope → 直接拒绝，零写入', async () => {
    const file = makeFixture();
    await expect(
      runConnectorPull(
        prisma,
        {
          ...base(),
          connector: { ...descriptor, connectorId: ' ' },
          connectionRef: 'conn-1',
          resource: 'inventory-ledger',
          fetcher: new FixtureFetcher(file, () => NOW),
          normalizer: makeNormalizer(),
        },
        { ...deps(), now: () => NOW },
      ),
    ).rejects.toThrow();
    expect(await prisma.claimItem.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
