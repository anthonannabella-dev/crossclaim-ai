/**
 * R45 S4（第二批）—— 受保护动作 override / 人工 provider outcome 录入（真实 PostgreSQL）
 * 依据：MSG-20261002-49 S4 特别要求（evidence 逐条校验；零推进；每笔独立审批；不修改原事实）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  RECONCILIATION_OVERRIDE_ACTION,
  RECONCILIATION_PROVIDER_OUTCOME_ACTION,
} from '../services/action-guard/approval-verifier';
import {
  RECONCILIATION_OVERRIDE_RECORDED_ACTION,
  RECONCILIATION_PROVIDER_OUTCOME_RECORDED_ACTION,
  recordManualProviderOutcomeFact,
  recordReconciliationOverride,
} from '../services/reconciliation/manual-actions';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r45-s4b-pass-1';

let ORG_A = '';
let ORG_B = '';
let caseA = '';
let caseB = '';
let claimA = '';
let claimA2 = '';
let ownerId = '';

const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);

async function seedOrg(slugSuffix: string): Promise<{ organizationId: string; ownerId: string }> {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R45 S4B ' + slugSuffix, slug: 'r45-s4b-' + slugSuffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r45-s4b-' + slugSuffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, ownerId: owner.id };
}

async function seedCase(organizationId: string): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'R45S4B-' + randomUUID().slice(0, 8),
      title: 'R45 S4B fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  return created.id;
}

async function seedClaimItem(organizationId: string, caseId: string): Promise<string> {
  const created = await prisma.claimItem.create({
    data: {
      organizationId,
      caseId,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'r45s4b-' + uuid(),
      sourceFingerprint: hex64(),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  return created.id;
}

async function seedEvidence(organizationId: string, usable = true): Promise<string> {
  const created = await prisma.evidenceArtifact.create({
    data: {
      organizationId,
      kind: 'EMAIL',
      title: 'evidence-' + randomUUID().slice(0, 6),
      externalUrl: usable ? 'https://evidence.example.com/' + uuid() : null,
    },
    select: { id: true },
  });
  return created.id;
}

async function seedObserved(organizationId: string, claimItemId: string): Promise<string> {
  const created = await prisma.reimbursementFact.create({
    data: {
      organizationId,
      claimItemId,
      provider: 'amazon',
      kind: 'OBSERVED',
      amount: '100.0000',
      currency: 'USD',
      occurredAt: new Date('2026-09-04T00:00:00.000Z'),
      providerEventId: 'evt-' + uuid(),
      providerEventFingerprint: hex64(),
      fingerprintVersion: 'v1',
      sourceKind: 'OFFICIAL_API',
      sourceRef: 'sp-api/finances/' + uuid(),
      capturedAt: new Date('2026-09-04T01:00:00.000Z'),
      ingestedByUserId: uuid(),
      evidenceArtifactIds: [],
    },
    select: { id: true },
  });
  return created.id;
}

async function issueApproval(input: {
  organizationId: string;
  caseId: string;
  approverUserId: string;
  action: string;
  payload: { amount: string | null; currency: string | null; basisReference: string; evidenceArtifactId: string | null };
  extra: Record<string, string>;
}): Promise<string> {
  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.approverUserId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: input.caseId,
      changes: { boundAction: input.action } as never,
      createdAt: new Date(Date.now() - 1000),
    },
    select: { id: true },
  });
  const row = await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.approverUserId,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: input.caseId,
      changes: {
        boundAction: input.action,
        boundPayload: { ...input.payload, fingerprintVersion: 'v1', ...input.extra },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      createdAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error as Error & { code?: string; reason?: string };
    expect(`${err.code ?? ''} ${err.reason ?? ''} ${err.message}`).toMatch(pattern);
    return;
  }
  throw new Error('EXPECTED_MANUAL_ACTION_REJECTION_MISSING: ' + String(pattern));
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const seededA = await seedOrg('a-' + suffix);
  const seededB = await seedOrg('b-' + suffix);
  ORG_A = seededA.organizationId;
  ORG_B = seededB.organizationId;
  ownerId = seededA.ownerId;
  caseA = await seedCase(ORG_A);
  caseB = await seedCase(ORG_B);
  claimA = await seedClaimItem(ORG_A, caseA);
  claimA2 = await seedClaimItem(ORG_A, caseA);
  // ORG_B 侧 ClaimItem 仅用于跨租户 evidence/fact 场景的对照，不单独断言
  await seedClaimItem(ORG_B, caseB);
});

describe('R45 S4 · recovery.reconciliation_override', () => {
  async function overrideScenario(overrides: Record<string, unknown> = {}) {
    const factId = await seedObserved(ORG_A, claimA);
    const evidenceId = await seedEvidence(ORG_A);
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_OVERRIDE_ACTION,
      payload: { amount: null, currency: null, basisReference: 'NOT_OUR_CLAIM', evidenceArtifactId: evidenceId },
      extra: { claimItemId: claimA, reimbursementFactId: factId, decisionKind: 'UNMATCHED' },
    });
    const input = {
      organizationId: ORG_A,
      role: 'OWNER',
      actorUserId: ownerId,
      claimItemId: claimA,
      reimbursementFactId: factId,
      decisionKind: 'UNMATCHED' as const,
      reasonCode: 'NOT_OUR_CLAIM',
      reasonText: '该笔赔付不属于本 Claim（人工裁定）',
      evidenceIds: [evidenceId],
      approvalId,
      ...overrides,
    };
    return { factId, evidenceId, approvalId, input };
  }

  it('成功记录：决策落库 + 业务审计 + approval 消费；原始事实未被修改', async () => {
    const { factId, evidenceId, input } = await overrideScenario();
    const before = await prisma.reimbursementFact.findUniqueOrThrow({ where: { id: factId } });

    const result = await recordReconciliationOverride({ prisma }, input);

    expect(result.decisionKind).toBe('UNMATCHED');
    expect(result.approvalConsumed).toBe(true);
    expect(result.evidenceArtifactIds).toEqual([evidenceId]);
    const decision = await prisma.reconciliationOverrideDecision.findFirstOrThrow({
      where: { organizationId: ORG_A, reimbursementFactId: factId },
    });
    expect(decision.decisionKind).toBe('UNMATCHED');
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: RECONCILIATION_OVERRIDE_RECORDED_ACTION } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(1);

    const after = await prisma.reimbursementFact.findUniqueOrThrow({ where: { id: factId } });
    expect(after.amount?.toString()).toBe(before.amount?.toString());
    expect(after.kind).toBe(before.kind);
  });

  it('evidence 缺失 / 不存在 / 重复 / 跨租户 / 无来源 → 零写入（不消费 approval）', async () => {
    const cases: Array<Record<string, unknown>> = [];
    const noEvidence = await overrideScenario({ evidenceIds: [] });
    cases.push(noEvidence.input);
    const missing = await overrideScenario({ evidenceIds: [uuid()] });
    cases.push(missing.input);
    const noUsableSource = await seedEvidence(ORG_A, false);
    const unusable = await overrideScenario({ evidenceIds: [noUsableSource] });
    cases.push(unusable.input);
    const crossTenantEvidence = await seedEvidence(ORG_B);
    const crossTenant = await overrideScenario({ evidenceIds: [crossTenantEvidence] });
    cases.push(crossTenant.input);

    for (const input of cases) {
      await expectRejection(() => recordReconciliationOverride({ prisma }, input as never), /INVALID_INPUT|EvidenceArtifact/);
    }
    expect(await prisma.reconciliationOverrideDecision.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(0);
  });

  it('错误 fact binding（事实属于另一 claimItem）→ fail-closed，零写入', async () => {
    const factId = await seedObserved(ORG_A, claimA2);
    const evidenceId = await seedEvidence(ORG_A);
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_OVERRIDE_ACTION,
      payload: { amount: null, currency: null, basisReference: 'WRONG_BINDING', evidenceArtifactId: evidenceId },
      extra: { claimItemId: claimA, reimbursementFactId: factId, decisionKind: 'MATCHED' },
    });
    await expectRejection(
      () =>
        recordReconciliationOverride(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            reimbursementFactId: factId,
            decisionKind: 'MATCHED',
            reasonCode: 'WRONG_BINDING',
            reasonText: 'x',
            evidenceIds: [evidenceId],
            approvalId,
          },
        ),
      /INVALID_INPUT|绑定不一致/,
    );
    expect(await prisma.reconciliationOverrideDecision.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('同一 reimbursement fact 只能有一条 override 决策（一票制）', async () => {
    const first = await overrideScenario();
    await recordReconciliationOverride({ prisma }, first.input);

    const evidenceId = await seedEvidence(ORG_A);
    const secondApproval = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_OVERRIDE_ACTION,
      payload: { amount: null, currency: null, basisReference: 'SECOND', evidenceArtifactId: evidenceId },
      extra: { claimItemId: claimA, reimbursementFactId: first.factId, decisionKind: 'MATCHED' },
    });
    await expectRejection(
      () =>
        recordReconciliationOverride(
          { prisma },
          {
            ...first.input,
            decisionKind: 'MATCHED',
            reasonCode: 'SECOND',
            evidenceIds: [evidenceId],
            approvalId: secondApproval,
          },
        ),
      /ILLEGAL_TRANSITION|已存在 override/,
    );
    expect(await prisma.reconciliationOverrideDecision.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it('审批动作不匹配 → APPROVAL_NOT_VERIFIED（零写入、不消费）', async () => {
    const factId = await seedObserved(ORG_A, claimA);
    const evidenceId = await seedEvidence(ORG_A);
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_PROVIDER_OUTCOME_ACTION,
      payload: { amount: null, currency: null, basisReference: 'X', evidenceArtifactId: evidenceId },
      extra: { caseId: caseA, provider: 'amazon', kind: 'ACCEPTED', occurredAt: new Date().toISOString(), canonicalSourceIdentity: 'src-1' },
    });
    await expectRejection(
      () =>
        recordReconciliationOverride(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            reimbursementFactId: factId,
            decisionKind: 'UNMATCHED',
            reasonCode: 'X',
            reasonText: 'x',
            evidenceIds: [evidenceId],
            approvalId,
          },
        ),
      /APPROVAL_ACTION_MISMATCH|APPROVAL_NOT_VERIFIED/,
    );
    expect(await prisma.reconciliationOverrideDecision.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});

describe('R45 S4 · recovery.reconciliation_provider_outcome_record（人工录入）', () => {
  async function outcomeScenario(overrides: Record<string, unknown> = {}) {
    const evidenceId = await seedEvidence(ORG_A);
    const occurredAt = new Date('2026-09-06T00:00:00.000Z');
    // 允许用例固定 canonicalSourceIdentity（重复事件场景需要 approval 绑定同一身份）
    const canonicalSourceIdentity =
      typeof overrides.canonicalSourceIdentity === 'string' ? overrides.canonicalSourceIdentity : 'manual-case:' + uuid();
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_PROVIDER_OUTCOME_ACTION,
      payload: { amount: null, currency: null, basisReference: canonicalSourceIdentity, evidenceArtifactId: evidenceId },
      extra: {
        caseId: caseA,
        provider: 'amazon',
        kind: 'ACCEPTED',
        occurredAt: occurredAt.toISOString(),
        canonicalSourceIdentity,
      },
    });
    const input = {
      organizationId: ORG_A,
      role: 'OWNER',
      actorUserId: ownerId,
      caseId: caseA,
      claimItemId: claimA,
      provider: 'AMAZON',
      kind: 'ACCEPTED' as const,
      sourceResource: 'returns/outcomes',
      canonicalSourceIdentity,
      occurredAt,
      evidenceIds: [evidenceId],
      reasonCode: 'PROVIDER_EMAIL',
      approvalId,
      ...overrides,
    };
    return { evidenceId, approvalId, input };
  }

  it('成功录入：MANUAL_WITH_EVIDENCE 事实 + 证据引用 + 审计 + 消费；不推导 providerAccepted', async () => {
    const { evidenceId, input } = await outcomeScenario();
    const result = await recordManualProviderOutcomeFact({ prisma }, input);

    expect(result.sourceKind).toBe('MANUAL_WITH_EVIDENCE');
    expect(result.evidenceArtifactIds).toEqual([evidenceId]);
    expect(result.providerAcceptedInferred).toBe(false);
    expect(result.platformWriteExecuted).toBe(false);
    expect(result.providerEventFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const fact = await prisma.providerOutcomeFact.findUniqueOrThrow({ where: { id: result.providerOutcomeFactId } });
    expect(fact.sourceKind).toBe('MANUAL_WITH_EVIDENCE');
    expect(fact.evidenceArtifactIds).toEqual([evidenceId]);
    expect(fact.providerEventId).toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: RECONCILIATION_PROVIDER_OUTCOME_RECORDED_ACTION } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(1);
  });

  it('evidence 缺失 / 不存在 / 重复 / 跨租户 / 无来源 → 事实、审计、消费全部零推进', async () => {
    const base = await outcomeScenario();
    const dupEvidence = await seedEvidence(ORG_A);
    const crossEvidence = await seedEvidence(ORG_B);
    const noSource = await seedEvidence(ORG_A, false);

    const rejected: Array<Record<string, unknown>> = [
      { evidenceIds: [] },
      { evidenceIds: [uuid()] },
      { evidenceIds: [base.evidenceId, base.evidenceId] },
      { evidenceIds: [crossEvidence] },
      { evidenceIds: [noSource] },
      { evidenceIds: [base.evidenceId, dupEvidence, dupEvidence] },
    ];
    for (const override of rejected) {
      const scenario = await outcomeScenario(override);
      await expectRejection(() => recordManualProviderOutcomeFact({ prisma }, scenario.input), /INVALID_INPUT|EvidenceArtifact/);
    }
    expect(await prisma.providerOutcomeFact.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: RECONCILIATION_PROVIDER_OUTCOME_RECORDED_ACTION } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(0);
  });

  it('同一人工事件重复录入 → ILLEGAL_TRANSITION（不新建第二条事实）', async () => {
    const first = await outcomeScenario();
    await recordManualProviderOutcomeFact({ prisma }, first.input);

    const second = await outcomeScenario({ canonicalSourceIdentity: first.input.canonicalSourceIdentity });
    await expectRejection(
      () => recordManualProviderOutcomeFact({ prisma }, second.input),
      /ILLEGAL_TRANSITION|已录入/,
    );
    expect(await prisma.providerOutcomeFact.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it('claimItem 与 caseId 不一致 → fail-closed（零写入）', async () => {
    const scenario = await outcomeScenario({ caseId: caseA, claimItemId: claimA2 });
    const mismatch = await outcomeScenario({ caseId: caseB, claimItemId: claimA });
    await expectRejection(
      () => recordManualProviderOutcomeFact({ prisma }, mismatch.input),
      /NOT_FOUND|INVALID_INPUT|绑定不一致/,
    );
    // 合法场景仍可成功（证明上面的拒绝不是环境因素）
    const ok = await recordManualProviderOutcomeFact({ prisma }, scenario.input);
    expect(ok.providerOutcomeFactId).toBeTruthy();
    expect(await prisma.providerOutcomeFact.count({ where: { organizationId: ORG_A } })).toBe(1);
  });
});
