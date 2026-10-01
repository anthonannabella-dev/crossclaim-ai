/**
 * R45 S2 —— Outcome / Reimbursement ingest（真实 PostgreSQL）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-47 Q3（S2 只做 ingest；不含 projector；不含人工 outcome 受保护 HTTP 路径）。
 * 断言重点：
 *   - same external event → same existing fact（幂等复用，不新建、不双计）；
 *   - same providerEventId + different resource identity → distinct facts；
 *   - same reversal replay → existing reversal；different reversal event → 同一 OBSERVED → fail-closed；
 *   - 跨租户 / 归属不一致 / 非法金额 / 人工来源 → 零写入。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ReconciliationIngestError,
  ingestProviderOutcomeFact,
  ingestReimbursementFact,
} from '../services/reconciliation/ingest';
import { hashPassword } from '../services/auth';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r45-s2-pass-1';

let ORG_A = '';
let ORG_B = '';
let caseA = '';
let caseB = '';
let claimA = '';
let claimB = '';
let actor = '';

const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);

async function seedOrg(slugSuffix: string): Promise<{ organizationId: string; userId: string }> {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R45 S2 ' + slugSuffix, slug: 'r45-s2-' + slugSuffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r45-s2-' + slugSuffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: owner.id };
}

async function seedCase(organizationId: string): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'R45S2-' + randomUUID().slice(0, 8),
      title: 'R45 S2 fixture',
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
      platformRef: 'r45s2-' + randomUUID(),
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

function observedInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_A,
    claimItemId: claimA,
    caseId: caseA,
    provider: 'AMAZON',
    sourceResource: 'finances/reimbursements',
    providerEventId: 'evt-' + uuid(),
    kind: 'OBSERVED' as const,
    amount: '120.5000',
    currency: 'USD',
    occurredAt: new Date('2026-09-04T00:00:00.000Z'),
    sourceKind: 'OFFICIAL_API' as const,
    sourceRef: 'sp-api/finances/' + uuid(),
    capturedAt: new Date('2026-09-04T01:00:00.000Z'),
    ingestedByUserId: actor,
    evidenceArtifactIds: [],
    ...overrides,
  } as Parameters<typeof ingestReimbursementFact>[1];
}

function outcomeInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG_A,
    caseId: caseA,
    claimItemId: claimA,
    provider: 'AMAZON',
    sourceResource: 'returns/outcomes',
    providerEventId: 'outcome-' + uuid(),
    kind: 'ACCEPTED' as const,
    occurredAt: new Date('2026-09-03T00:00:00.000Z'),
    sourceKind: 'OFFICIAL_API' as const,
    sourceRef: 'sp-api/returns/' + uuid(),
    capturedAt: new Date('2026-09-03T01:00:00.000Z'),
    ingestedByUserId: actor,
    evidenceArtifactIds: [],
    ...overrides,
  } as Parameters<typeof ingestProviderOutcomeFact>[1];
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReconciliationIngestError);
    expect((error as ReconciliationIngestError).code).toBe(code);
    return;
  }
  throw new Error('EXPECTED_REJECTION_MISSING: ' + code);
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
  caseA = await seedCase(ORG_A);
  caseB = await seedCase(ORG_B);
  claimA = await seedClaimItem(ORG_A, caseA);
  claimB = await seedClaimItem(ORG_B, caseB);
  actor = seededA.userId;
});

describe('R45 S2 · ReimbursementFact ingest（幂等与身份）', () => {
  it('same external event → same existing fact（REUSED，不双计）', async () => {
    const eventId = 'evt-' + uuid();
    const first = await ingestReimbursementFact(prisma, observedInput({ providerEventId: eventId }));
    const second = await ingestReimbursementFact(prisma, observedInput({ providerEventId: eventId }));
    expect(first.outcome).toBe('CREATED');
    expect(second.outcome).toBe('REUSED');
    expect(second.fact.id).toBe(first.fact.id);
    const rows = await prisma.reimbursementFact.findMany({ where: { organizationId: ORG_A } });
    expect(rows).toHaveLength(1);
  });

  it('same providerEventId + different resource identity → distinct facts', async () => {
    const eventId = 'evt-' + uuid();
    const a = await ingestReimbursementFact(prisma, observedInput({ providerEventId: eventId }));
    const b = await ingestReimbursementFact(
      prisma,
      observedInput({ providerEventId: eventId, sourceResource: 'finances/settlements' }),
    );
    expect(a.outcome).toBe('CREATED');
    expect(b.outcome).toBe('CREATED');
    expect(b.fact.id).not.toBe(a.fact.id);
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } })).toBe(2);
  });

  it('无事件身份 → MISSING_EVENT_IDENTITY，零写入', async () => {
    await expectCode(
      () => ingestReimbursementFact(prisma, observedInput({ providerEventId: null })),
      'MISSING_EVENT_IDENTITY',
    );
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('amount ≤ 0 / 缺失 → 拒绝，零写入（冲正不得用负金额表达）', async () => {
    await expectCode(() => ingestReimbursementFact(prisma, observedInput({ amount: '0' })), 'AMOUNT_MUST_BE_POSITIVE');
    await expectCode(() => ingestReimbursementFact(prisma, observedInput({ amount: '-5' })), 'AMOUNT_MUST_BE_POSITIVE');
    await expectCode(() => ingestReimbursementFact(prisma, observedInput({ amount: null })), 'AMOUNT_REQUIRED');
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('人工来源在 S2 不被接受（留到 S4 受保护路径），零写入', async () => {
    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({ sourceKind: 'MANUAL_WITH_EVIDENCE', reasonCode: 'MANUAL_REVIEW' }),
        ),
      'MANUAL_PATH_DEFERRED',
    );
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('currency 服务端 canonical 化（usd → USD）；非法币种拒绝', async () => {
    const created = await ingestReimbursementFact(prisma, observedInput({ currency: ' usd ' }));
    expect(created.fact.currency).toBe('USD');
    await expectCode(() => ingestReimbursementFact(prisma, observedInput({ currency: 'US' })), 'INVALID_CURRENCY');
  });

  it('providerCaseRef：canonical 由服务端构造（trim/折叠空白/去零宽；不 lower-case）', async () => {
    const created = await ingestReimbursementFact(
      prisma,
      observedInput({ providerCaseRefRaw: '  Case\u200b-001   ABC  ' }),
    );
    expect(created.fact.providerCaseRefCanonical).toBe('Case-001 ABC');
  });
});

describe('R45 S2 · ProviderOutcomeFact ingest', () => {
  it('重复 ingest 幂等复用；ACCEPTED 与 ACCEPTANCE_REVOKED 是不同事实', async () => {
    const eventId = 'outcome-' + uuid();
    const accepted = await ingestProviderOutcomeFact(prisma, outcomeInput({ providerEventId: eventId }));
    const replay = await ingestProviderOutcomeFact(prisma, outcomeInput({ providerEventId: eventId }));
    const revoked = await ingestProviderOutcomeFact(
      prisma,
      outcomeInput({ providerEventId: eventId, kind: 'ACCEPTANCE_REVOKED' }),
    );
    expect(accepted.outcome).toBe('CREATED');
    expect(replay.outcome).toBe('REUSED');
    expect(replay.fact.id).toBe(accepted.fact.id);
    expect(revoked.outcome).toBe('CREATED');
    expect(revoked.fact.id).not.toBe(accepted.fact.id);
    expect(await prisma.providerOutcomeFact.count({ where: { organizationId: ORG_A } })).toBe(2);
  });

  it('跨租户 claimItem / 错案件绑定 → 拒绝，零写入', async () => {
    await expectCode(
      () => ingestProviderOutcomeFact(prisma, outcomeInput({ claimItemId: claimB })),
      'CROSS_TENANT_REFERENCE',
    );
    await expectCode(
      () => ingestProviderOutcomeFact(prisma, outcomeInput({ caseId: caseB, organizationId: ORG_A })),
      'CASE_BINDING_MISMATCH',
    );
    expect(await prisma.providerOutcomeFact.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});

describe('R45 S2 · 冲正 ingest', () => {
  it('同一冲正事件 replay → 复用既有冲正事实；不产生第二条', async () => {
    const observed = await ingestReimbursementFact(prisma, observedInput());
    const reversalEvent = 'rev-' + uuid();
    const reversalInput = observedInput({
      kind: 'REIMBURSEMENT_REVERSED' as const,
      amount: null,
      reversesFactId: observed.fact.id,
      providerEventId: reversalEvent,
    });
    // 冲正意图不携带金额语义：ingest 的 amount 字段被忽略前必须先校验为空
    const first = await ingestReimbursementFact(prisma, reversalInput);
    const replay = await ingestReimbursementFact(prisma, reversalInput);
    expect(first.outcome).toBe('CREATED');
    expect(first.fact.amount).toBeNull();
    expect(first.fact.reversesFactId).toBe(observed.fact.id);
    expect(replay.outcome).toBe('REUSED');
    expect(replay.fact.id).toBe(first.fact.id);
    const reversals = await prisma.reimbursementFact.findMany({
      where: { organizationId: ORG_A, kind: 'REIMBURSEMENT_REVERSED' },
    });
    expect(reversals).toHaveLength(1);
  });

  it('不同冲正事件指向同一 OBSERVED → fail-closed（REVERSAL_ALREADY_APPLIED），仍只有一条冲正', async () => {
    const observed = await ingestReimbursementFact(prisma, observedInput());
    await ingestReimbursementFact(
      prisma,
      observedInput({
        kind: 'REIMBURSEMENT_REVERSED' as const,
        amount: null,
        reversesFactId: observed.fact.id,
        providerEventId: 'rev-' + uuid(),
      }),
    );
    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: null,
            reversesFactId: observed.fact.id,
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_ALREADY_APPLIED',
    );
    expect(
      await prisma.reimbursementFact.count({ where: { organizationId: ORG_A, kind: 'REIMBURSEMENT_REVERSED' } }),
    ).toBe(1);
  });

  it('冲正同源性前置校验：跨租户 / 目标非 OBSERVED / provider / currency / 携带金额 → 零写入', async () => {
    const observed = await ingestReimbursementFact(prisma, observedInput());
    const otherObserved = await ingestReimbursementFact(prisma, observedInput({ provider: 'WALMART', currency: 'USD' }));

    // 目标非 OBSERVED：用冲正事实当目标
    const reversalForShape = await ingestReimbursementFact(
      prisma,
      observedInput({
        kind: 'REIMBURSEMENT_REVERSED' as const,
        amount: null,
        reversesFactId: otherObserved.fact.id,
        provider: 'WALMART',
        providerEventId: 'rev-' + uuid(),
      }),
    );
    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: null,
            reversesFactId: reversalForShape.fact.id,
            provider: 'WALMART',
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_TARGET_NOT_OBSERVED',
    );

    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            organizationId: ORG_B,
            claimItemId: claimB,
            caseId: caseB,
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: null,
            reversesFactId: observed.fact.id,
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_CROSS_TENANT',
    );

    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: null,
            reversesFactId: observed.fact.id,
            provider: 'WALMART',
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_PROVIDER_MISMATCH',
    );

    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: null,
            reversesFactId: observed.fact.id,
            currency: 'EUR',
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_CURRENCY_MISMATCH',
    );

    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: '10.0000',
            reversesFactId: observed.fact.id,
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_AMOUNT_NOT_ALLOWED',
    );

    await expectCode(
      () =>
        ingestReimbursementFact(
          prisma,
          observedInput({
            kind: 'REIMBURSEMENT_REVERSED' as const,
            amount: null,
            reversesFactId: uuid(),
            providerEventId: 'rev-' + uuid(),
          }),
        ),
      'REVERSAL_TARGET_NOT_FOUND',
    );

    expect(otherObserved.outcome).toBe('CREATED');
    // ORG_A 中只有为「目标非 OBSERVED」场景准备的那一条冲正；其余非法请求全部零写入
    expect(
      await prisma.reimbursementFact.count({ where: { organizationId: ORG_A, kind: 'REIMBURSEMENT_REVERSED' } }),
    ).toBe(1);
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_B } })).toBe(0);
  });
});
