// PROVIDER FOLLOW-UP INTELLIGENCE / P4（A-S5）—— Prisma 只读证据端口 真实 PostgreSQL 验收

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPrismaEvidenceSource,
  resolveEvidence,
  type EvidenceResolutionRequest,
} from '../services/provider-support';

const prisma = new PrismaClient();

const ORG = randomUUID();
const ORG_OTHER = randomUUID();
const ACCT_A = randomUUID();
const ACCT_B = randomUUID();
let podAId = '';
let podBId = '';

const REQ: EvidenceResolutionRequest = {
  requirement: { kind: 'POD', acceptableKinds: ['POD'], requiredKeys: ['trackingNumber'] },
  expected: { trackingNumber: '1Z999AA10123456784' },
};

beforeAll(async () => {
  await prisma.organization.create({ data: { id: ORG, name: 'resolver-org', slug: 'resolver-' + ORG.slice(0, 8) } });
  await prisma.organization.create({
    data: { id: ORG_OTHER, name: 'resolver-org-2', slug: 'resolver2-' + ORG_OTHER.slice(0, 8) },
  });
  await prisma.platformAccount.create({
    data: { id: ACCT_A, organizationId: ORG, platform: 'AMAZON', externalAccountId: 'A-' + ACCT_A.slice(0, 6), displayName: 'acct A' },
  });
  await prisma.platformAccount.create({
    data: { id: ACCT_B, organizationId: ORG, platform: 'AMAZON', externalAccountId: 'B-' + ACCT_B.slice(0, 6), displayName: 'acct B' },
  });
  // 本 account 的可核对 POD
  const podA = await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_A,
      kind: 'POD',
      title: 'POD 1Z999AA10123456784 delivery photo',
      description: 'carrier POD for order 123-4567890-1234567',
      reliability: 0.95,
    },
  });
  // 同 org 但**其它 account** 的证据（必须不可见）
  const podB = await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: ACCT_B,
      kind: 'POD',
      title: 'POD 1Z999AA10123456784 other account',
      reliability: 0.99,
    },
  });
  podAId = podA.id;
  podBId = podB.id;
  // 其它组织（必须不可见）
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG_OTHER,
      accountId: null,
      kind: 'POD',
      title: 'POD 1Z999AA10123456784 other org',
      reliability: 0.99,
    },
  });
  // org 级（accountId null）无可核对键证据 → LOW_CONFIDENCE
  await prisma.evidenceArtifact.create({
    data: {
      organizationId: ORG,
      accountId: null,
      kind: 'POD',
      title: 'POD scan without reference',
      reliability: 0.9,
    },
  });
});

afterAll(async () => {
  await prisma.evidenceArtifact.deleteMany({ where: { organizationId: { in: [ORG, ORG_OTHER] } } });
  await prisma.platformAccount.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, ORG_OTHER] } } });
  await prisma.$disconnect();
});

describe('A-S5 Prisma 证据端口 · tenant/account 隔离', () => {
  it('PG-EV1 只返回本 org + 本 account（或 org 级）的候选；跨 account/tenant 不可见', async () => {
    const source = createPrismaEvidenceSource(prisma);
    const candidates = await source.findCandidates({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      acceptableKinds: ['POD'],
      requiredKeys: ['trackingNumber'],
    });
    expect(candidates.length).toBe(2); // 本 account 1 条 + org 级 1 条
    expect(candidates.every((c) => c.organizationId === ORG)).toBe(true);
    expect(candidates.some((c) => c.platformAccountId === ACCT_B)).toBe(false);
  });

  it('PG-EV2 本 account 的 POD 可解析为 FOUND（键来自 best-effort 抽取）', async () => {
    const source = createPrismaEvidenceSource(prisma);
    const candidates = await source.findCandidates({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      acceptableKinds: ['POD'],
      requiredKeys: ['trackingNumber'],
    });
    const result = resolveEvidence({
      scope: { organizationId: ORG, platformAccountId: ACCT_A },
      candidates,
      request: REQ,
    });
    expect(result.status).toBe('FOUND');
    expect(result.matchedFacts[0].matchedKeys).toEqual(['trackingNumber']);
  });

  it('PG-EV3 其它 account 视角看不到 A 的 POD（绝不串线：A 的证据 id 永不出现）', async () => {
    const source = createPrismaEvidenceSource(prisma);
    const candidates = await source.findCandidates({
      scope: { organizationId: ORG, platformAccountId: ACCT_B },
      acceptableKinds: ['POD'],
      requiredKeys: ['trackingNumber'],
    });
    expect(candidates.some((c) => c.evidenceId === podAId)).toBe(false);
    expect(candidates.some((c) => c.platformAccountId === ACCT_A)).toBe(false);
    const result = resolveEvidence({
      scope: { organizationId: ORG, platformAccountId: ACCT_B },
      candidates,
      request: REQ,
    });
    expect(result.evidenceReferences).not.toContain(podAId);
    // B 只能匹配到自己的证据（或落到 LOW_CONFIDENCE），绝不使用 A 的证据
    if (result.status === 'FOUND') {
      expect(result.evidenceReferences).toEqual([podBId]);
    } else {
      expect(['MISSING', 'LOW_CONFIDENCE', 'PARTIAL']).toContain(result.status);
    }
  });

  it('PG-EV4 其它 tenant 视角只看到自己的证据（跨租户不可见），且不存在的键 → MISSING', async () => {
    const source = createPrismaEvidenceSource(prisma);
    const candidates = await source.findCandidates({
      scope: { organizationId: ORG_OTHER, platformAccountId: ACCT_A },
      acceptableKinds: ['POD'],
      requiredKeys: ['trackingNumber'],
    });
    // 只应看到本租户的证据（1 条），绝不包含 ORG 的证据
    expect(candidates).toHaveLength(1);
    expect(candidates.every((c) => c.organizationId === ORG_OTHER)).toBe(true);
    expect(candidates.some((c) => c.organizationId === ORG)).toBe(false);

    // 用一个本租户不存在的 tracking → MISSING（不借道其它租户的证据）
    const missing = resolveEvidence({
      scope: { organizationId: ORG_OTHER, platformAccountId: ACCT_A },
      candidates,
      request: {
        requirement: { kind: 'POD', acceptableKinds: ['POD'], requiredKeys: ['trackingNumber'] },
        expected: { trackingNumber: '1Z00000000000000000' },
      },
    });
    expect(['MISSING', 'PARTIAL', 'LOW_CONFIDENCE']).toContain(missing.status);
    expect(missing.status).not.toBe('FOUND');
  });
});
