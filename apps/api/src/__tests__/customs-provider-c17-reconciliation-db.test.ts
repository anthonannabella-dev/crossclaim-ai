/**
 * C18-8（MSG-20261004-18 ③）— AMBIGUOUS → C17 ledger reconciliation（真实 PostgreSQL）
 * ---------------------------------------------------------------
 * 证明 C18 的写操作歧义处理**真的接到 C17 既有 ledger**，而不是只跑离线策略：
 *   open root → ATTEMPTED → CREATE_SUBMISSION 结果 AMBIGUOUS → append UNKNOWN_PROVIDER_RESPONSE
 *   → append RECONCILING → provider lookup（同 idempotencyKey）找到 same digest 的既有 submission
 *   → append SUBMITTED(既有 providerSubmissionId) → CustomsSubmissionAttempt 根数恒为 1，且从未再次 POST。
 * 以及 mismatch 分支：same key + different digest → conflict → 根数仍为 1、无盲重发。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  openCustomsSubmissionAttempt,
  recordCustomsSubmissionAttemptFact,
} from '../services/customs/customs-submission-ledger';
import { createPrismaCustomsSubmissionLedgerStore } from '../services/customs/customs-submission-ledger-prisma-store';
import { createSandboxFilingProvider } from '../services/customs/customs-sandbox-filing-provider';
import {
  assertResubmitAllowed,
  buildProviderReconciliationPlan,
  classifyProviderOutcome,
  ProviderBlindRetryError,
} from '../services/customs/customs-provider-reconciliation';
import {
  decideProviderReconciliation,
  providerSubmissionPayloadDigest,
} from '../services/customs/customs-provider-reconciliation-lookup';

const prisma = new PrismaClient();
const ORG = 'cc180000-0000-4000-8000-000000000001';
const USER = 'cc180000-0000-4000-8000-000000000002';
const OPP = 'opp-c18-8';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const NOW = new Date('2026-10-04T06:00:00.000Z');

const rootInput = (overrides: Record<string, unknown> = {}) =>
  ({
    organizationId: ORG,
    opportunityId: OPP,
    caseId: null,
    claimItemId: null,
    packageId: 'pkg-c18-8',
    packageDigest: DIGEST_A,
    provider: 'provider:customs-a',
    operation: 'FILING_CREATE',
    jurisdiction: 'US',
    remedyType: 'DRAWBACK',
    idempotencyKey: 'idem-c18-8',
    ...overrides,
  }) as never;

const sandboxInput = (idempotencyKey: string, packageDigest = DIGEST_A) => ({
  organizationId: ORG,
  opportunityId: OPP,
  claimItemId: 'claim-item:1',
  packageId: 'pkg-c18-8',
  packageDigest,
  jurisdiction: 'US',
  remedyType: 'DRAWBACK',
  idempotencyKey,
});

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CustomsSubmissionAttemptFact", "CustomsSubmissionAttempt", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'C18-8 租户', slug: 'c18-8-org' } });
  await prisma.user.create({
    data: {
      id: USER,
      email: 'c18-8@example.com',
      passwordHash: 'x',
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true },
  });
});

describe('C18-8 — AMBIGUOUS → C17 ledger reconciliation (PostgreSQL)', () => {
  it('same key + same digest：adopt 既有 submission，根数恒为 1，且从未再次 POST', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const provider = createSandboxFilingProvider({ now: () => NOW });
    let createSubmissionCalls = 0;
    let lookupCalls = 0;

    const opened = await openCustomsSubmissionAttempt(rootInput(), { store, now: () => NOW });
    if (!opened.ok) throw new Error('expected root');
    const attemptId = opened.root.id;
    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);

    // 第一次写操作：传输中断/无响应 → AMBIGUOUS（不是 CONFLICT，也不是 PERMANENT_FAILURE）。
    createSubmissionCalls += 1;
    const ambiguous = classifyProviderOutcome(
      { httpStatus: 500, transportCompleted: true },
      { operation: 'CREATE_SUBMISSION' },
    );
    expect(ambiguous).toBe('AMBIGUOUS');
    const plan = buildProviderReconciliationPlan({ operation: 'CREATE_SUBMISSION', outcome: ambiguous });
    expect(plan.required).toBe(true);
    expect(plan.actions).toContain('NEVER_RESUBMIT_BLIND');
    expect(() => assertResubmitAllowed({ operation: 'CREATE_SUBMISSION', outcome: ambiguous })).toThrow(
      ProviderBlindRetryError,
    );

    // 实际上 provider 已经执行了这次写（模拟）：同 key 同 payload → 同一 providerSubmissionId。
    const applied = await provider.createSubmission(sandboxInput('idem-c18-8'));

    const steps = [
      { status: 'ATTEMPTED', providerSubmissionId: null, observedAt: '2026-10-04T05:50:00.000Z' },
      { status: 'UNKNOWN_PROVIDER_RESPONSE', providerSubmissionId: null, observedAt: '2026-10-04T05:51:00.000Z' },
      {
        status: 'RECONCILING',
        providerSubmissionId: null,
        observedAt: '2026-10-04T05:52:00.000Z',
        reconciliationAttempt: 1,
      },
    ] as const;
    for (const step of steps) {
      const outcome = await recordCustomsSubmissionAttemptFact(
        {
          organizationId: ORG,
          attemptId,
          verificationLevel: 'PROVIDER_VERIFIED',
          source: 'PROVIDER_API',
          ...step,
        } as never,
        { store, now: () => NOW },
      );
      if (!outcome.ok) throw new Error('expected fact, got ' + outcome.reason);
    }

    // 对账必须走**只读** lookup（不是第二次 createSubmission）。
    lookupCalls += 1;
    const lookup = await provider.lookupByIdempotencyKey({
      organizationId: ORG,
      idempotencyKey: 'idem-c18-8',
    });
    expect(lookup.outcome).toBe('FOUND');
    const decision = decideProviderReconciliation({
      lookup,
      expectedPayloadDigest: providerSubmissionPayloadDigest(sandboxInput('idem-c18-8')),
    });
    expect(decision.verdict).toBe('ADOPT_EXISTING');
    expect(decision.providerSubmissionId).toBe(applied.providerSubmissionId);
    expect(decision.resubmitAllowed).toBe(false);
    expect(provider.listSubmissions(ORG)).toHaveLength(1);

    const adopted = await recordCustomsSubmissionAttemptFact(
      {
        organizationId: ORG,
        attemptId,
        status: 'SUBMITTED',
        providerSubmissionId: decision.providerSubmissionId,
        source: 'PROVIDER_API',
        verificationLevel: 'PROVIDER_VERIFIED',
        observedAt: '2026-10-04T05:53:00.000Z',
        reconciliationAttempt: 1,
      },
      { store, now: () => NOW },
    );
    if (!adopted.ok) throw new Error('expected adopt, got ' + adopted.reason);

    const facts = await store.listFacts(ORG, attemptId);
    expect(facts.map((f) => f.status)).toEqual([
      'ATTEMPTED',
      'UNKNOWN_PROVIDER_RESPONSE',
      'RECONCILING',
      'SUBMITTED',
    ]);
    // 关键不变式：整个歧义→对账→采用过程中，submission root 始终只有 1 个。
    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);
    expect(provider.listSubmissions(ORG)).toHaveLength(1);
    // 关键：整条歧义→对账→采用链路上，写操作永远只有 1 次；对账只走只读查询。
    expect(createSubmissionCalls).toBe(1);
    expect(lookupCalls).toBe(1);
  });

  it('same key + different digest：conflict，根数仍为 1，绝不盲重发', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const provider = createSandboxFilingProvider({ now: () => NOW });
    let createSubmissionCalls = 0;
    let lookupCalls = 0;

    const opened = await openCustomsSubmissionAttempt(rootInput({ idempotencyKey: 'idem-c18-8-b' }), {
      store,
      now: () => NOW,
    });
    if (!opened.ok) throw new Error('expected root');
    const attemptId = opened.root.id;

    // provider 侧已存在「同 key + 不同 digest」的提交（1 次写，模拟第一次写其实已生效）。
    await provider.createSubmission(sandboxInput('idem-c18-8-b', DIGEST_A));
    createSubmissionCalls += 1;

    for (const step of [
      { status: 'ATTEMPTED', observedAt: '2026-10-04T05:50:00.000Z' },
      { status: 'UNKNOWN_PROVIDER_RESPONSE', observedAt: '2026-10-04T05:51:00.000Z' },
      { status: 'RECONCILING', observedAt: '2026-10-04T05:52:00.000Z', reconciliationAttempt: 1 },
    ] as const) {
      const outcome = await recordCustomsSubmissionAttemptFact(
        {
          organizationId: ORG,
          attemptId,
          verificationLevel: 'PROVIDER_VERIFIED',
          source: 'PROVIDER_API',
          providerSubmissionId: null,
          ...step,
        } as never,
        { store, now: () => NOW },
      );
      if (!outcome.ok) throw new Error('expected fact, got ' + outcome.reason);
    }

    // 对账只读查询拿回 provider 侧已有 digest，内部比较得出 mismatch（不得用第二次 createSubmission 去"查询冲突"）。
    lookupCalls += 1;
    const lookup = await provider.lookupByIdempotencyKey({
      organizationId: ORG,
      idempotencyKey: 'idem-c18-8-b',
    });
    expect(lookup.outcome).toBe('FOUND');
    const decision = decideProviderReconciliation({
      lookup,
      expectedPayloadDigest: providerSubmissionPayloadDigest(sandboxInput('idem-c18-8-b', DIGEST_B)),
    });
    expect(decision.verdict).toBe('CONFLICT_MISMATCH');
    expect(decision.providerPayloadDigest).toBe(
      providerSubmissionPayloadDigest(sandboxInput('idem-c18-8-b', DIGEST_A)),
    );
    expect(decision.providerSubmissionId).toBeNull();

    // digest 不一致 → 不得 adopt；进入人工复核，且不产生第二根、不盲目 POST。
    const conflict = await recordCustomsSubmissionAttemptFact(
      {
        organizationId: ORG,
        attemptId,
        status: 'MANUAL_REVIEW',
        providerSubmissionId: null,
        source: 'PROVIDER_API',
        verificationLevel: 'PROVIDER_VERIFIED',
        observedAt: '2026-10-04T05:53:00.000Z',
        errorCode: decision.reasonCode,
        reconciliationAttempt: 1,
      },
      { store, now: () => NOW },
    );
    if (!conflict.ok) throw new Error('expected manual review, got ' + conflict.reason);

    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);
    expect(provider.listSubmissions(ORG)).toHaveLength(1);
    expect(createSubmissionCalls).toBe(1);
    expect(lookupCalls).toBe(1);
    const facts = await store.listFacts(ORG, attemptId);
    expect(facts.map((f) => f.status)).toEqual([
      'ATTEMPTED',
      'UNKNOWN_PROVIDER_RESPONSE',
      'RECONCILING',
      'MANUAL_REVIEW',
    ]);
    expect(facts.some((f) => f.status === 'SUBMITTED')).toBe(false);
  });

  it('同 key + 同 packageDigest 但不同 remedyType：digest 不同 → CONFLICT_MISMATCH（绝不误采用）', async () => {
    const store = createPrismaCustomsSubmissionLedgerStore(prisma);
    const provider = createSandboxFilingProvider({ now: () => NOW });
    let createSubmissionCalls = 0;
    let lookupCalls = 0;

    const opened = await openCustomsSubmissionAttempt(
      rootInput({ idempotencyKey: 'idem-c18-8-c', remedyType: 'PROTEST' }),
      { store, now: () => NOW },
    );
    if (!opened.ok) throw new Error('expected root');
    const attemptId = opened.root.id;

    // provider 侧已有：同 key + 同 packageDigest，但 remedyType 不同（DRAWBACK）。
    await provider.createSubmission(sandboxInput('idem-c18-8-c', DIGEST_A));
    createSubmissionCalls += 1;

    lookupCalls += 1;
    const lookup = await provider.lookupByIdempotencyKey({
      organizationId: ORG,
      idempotencyKey: 'idem-c18-8-c',
    });
    expect(lookup.outcome).toBe('FOUND');
    const decision = decideProviderReconciliation({
      lookup,
      expectedPayloadDigest: providerSubmissionPayloadDigest({
        ...sandboxInput('idem-c18-8-c', DIGEST_A),
        remedyType: 'PROTEST',
      }),
    });
    expect(decision.verdict).toBe('CONFLICT_MISMATCH');
    expect(decision.providerSubmissionId).toBeNull();
    expect(decision.resubmitAllowed).toBe(false);

    for (const step of [
      { status: 'ATTEMPTED', observedAt: '2026-10-04T05:50:00.000Z' },
      { status: 'UNKNOWN_PROVIDER_RESPONSE', observedAt: '2026-10-04T05:51:00.000Z' },
      { status: 'RECONCILING', observedAt: '2026-10-04T05:52:00.000Z', reconciliationAttempt: 1 },
      {
        status: 'MANUAL_REVIEW',
        observedAt: '2026-10-04T05:53:00.000Z',
        errorCode: decision.reasonCode,
        reconciliationAttempt: 1,
      },
    ] as const) {
      const outcome = await recordCustomsSubmissionAttemptFact(
        {
          organizationId: ORG,
          attemptId,
          verificationLevel: 'PROVIDER_VERIFIED',
          source: 'PROVIDER_API',
          providerSubmissionId: null,
          ...step,
        } as never,
        { store, now: () => NOW },
      );
      if (!outcome.ok) throw new Error('expected fact, got ' + outcome.reason);
    }

    const facts = await store.listFacts(ORG, attemptId);
    expect(facts.map((f) => f.status)).toEqual([
      'ATTEMPTED',
      'UNKNOWN_PROVIDER_RESPONSE',
      'RECONCILING',
      'MANUAL_REVIEW',
    ]);
    expect(await prisma.customsSubmissionAttempt.count()).toBe(1);
    expect(provider.listSubmissions(ORG)).toHaveLength(1);
    expect(createSubmissionCalls).toBe(1);
    expect(lookupCalls).toBe(1);
  });
});
