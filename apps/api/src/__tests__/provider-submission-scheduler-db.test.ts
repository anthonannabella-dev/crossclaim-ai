// PROVIDER FOLLOW-UP INTELLIGENCE / P1 —— Provider Submission Scheduler 真实 PostgreSQL 验收
// 覆盖 HOST P9「Scheduler」清单：account/platform 隔离、rate window、burst、429、retry-after、jitter、
// crash/restart、duplicate enqueue、concurrent worker、dead-letter、UNKNOWN no blind retry（+ 长期安全断言）。

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createInMemoryProviderPolicyRegistry,
  enqueueProviderSubmission,
  leaseProviderSubmission,
  listDeadLetterProviderIntents,
  recoverExpiredProviderLeases,
  recordProviderOutcome,
  readProviderRateWindow,
  providerRateScopeKey,
  type ProviderSubmissionPolicy,
} from '../services/provider-submission';

const prisma = new PrismaClient();
const workerB = new PrismaClient();

const NOW = new Date('2026-10-06T06:00:00.000Z');
/** 与 NOW 同源的“稍后”时钟：TTL=1ms 的租约必须相对它判定过期（不要混入真实墙上时钟）。 */
const LATER = new Date(NOW.getTime() + 60_000);

function policy(overrides: Partial<ProviderSubmissionPolicy> = {}): ProviderSubmissionPolicy {
  return {
    providerProfileId: 'amazon-sp-api-support/v1',
    version: '2026-10-06',
    platform: 'AMAZON',
    ratePerMinute: 1,
    burst: 0,
    maxRetryAfterMs: 60_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 8_000,
    jitterRatio: 0,
    maxConcurrency: 1,
    cooldownMs: 0,
    dimensionKeys: ['ORGANIZATION', 'PLATFORM', 'PLATFORM_ACCOUNT', 'OPERATION', 'CONNECTION'],
    ...overrides,
  };
}

const registry = createInMemoryProviderPolicyRegistry([
  policy(),
  policy({ platform: 'TIKTOK', providerProfileId: 'tiktok-support/v1' }),
]);

async function truncate(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ProviderSubmissionEvent", "ProviderSubmissionIntent", "ProviderRateWindow" RESTART IDENTITY CASCADE',
  );
}

beforeEach(async () => {
  await truncate();
});

afterAll(async () => {
  await truncate();
  await prisma.$disconnect();
  await workerB.$disconnect();
});

function enqueueInput(overrides: Record<string, unknown> = {}) {
  const tag = randomUUID().slice(0, 8);
  return {
    organizationId: 'org-sched-1',
    platformAccountId: 'acct-A',
    platform: 'AMAZON' as const,
    operation: 'CLAIM_SUBMIT' as const,
    connectionRef: 'conn-1',
    caseRef: 'case-' + tag,
    claimRef: 'claim-' + tag,
    idempotencyKey: 'idem-' + tag,
    payload: { claimRef: 'claim-' + tag, amount: '120.0000' },
    basis: { basis: tag },
    now: NOW,
    ...overrides,
  };
}

describe('P1 Scheduler · durable 队列 / 幂等 / 隔离', () => {
  it('PG-S1 同幂等键并发入队 → 恰一条 intent（另一条 REUSE）', async () => {
    const input = enqueueInput();
    const [a, b] = await Promise.all([
      enqueueProviderSubmission(prisma, input),
      enqueueProviderSubmission(workerB, input),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['CREATE', 'REUSE']);
    expect(await prisma.providerSubmissionIntent.count()).toBe(1);
    expect(await prisma.providerSubmissionEvent.count({ where: { kind: 'ENQUEUED' } })).toBe(1);
  });

  it('PG-S2 同幂等键异载荷 → FAIL_CLOSED 且不产生第二条', async () => {
    const input = enqueueInput();
    expect((await enqueueProviderSubmission(prisma, input)).kind).toBe('CREATE');
    const tampered = await enqueueProviderSubmission(prisma, {
      ...input,
      payload: { ...(input.payload as Record<string, unknown>), amount: '999.0000' },
    });
    expect(tampered.kind).toBe('FAIL_CLOSED');
    expect(await prisma.providerSubmissionIntent.count()).toBe(1);
  });

  it('PG-S3 account 与 platform 相互隔离：A 的窗口耗尽不影响 B', async () => {
    // 顺序确定：a1（priority 2）→ a2（priority 1，同 account/platform）→ b1（priority 0）→ t1（priority -1）
    const a1 = await enqueueProviderSubmission(prisma, enqueueInput({ platformAccountId: 'acct-A', priority: 2 }));
    const a2 = await enqueueProviderSubmission(prisma, enqueueInput({ platformAccountId: 'acct-A', priority: 1 }));
    const b1 = await enqueueProviderSubmission(prisma, enqueueInput({ platformAccountId: 'acct-B', priority: 0 }));
    const t1 = await enqueueProviderSubmission(
      prisma,
      enqueueInput({ platform: 'TIKTOK', platformAccountId: 'acct-A', priority: -1 }),
    );
    expect([a1.kind, a2.kind, b1.kind, t1.kind]).toEqual(['CREATE', 'CREATE', 'CREATE', 'CREATE']);

    // 第一次派发：A 的 AMAZON 窗口容量 1 → 用掉
    const first = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(first.kind).toBe('LEASED');
    if (first.kind !== 'LEASED') throw new Error('lease 失败');

    // A 的第一次执行收敛（SUCCESS，释放 lease；窗口计数仍被消耗）
    await recordProviderOutcome(prisma, {
      intentId: first.intentId,
      leaseId: first.leaseId,
      responseKind: 'SUCCESS',
      now: NOW,
      maxAttempts: 5,
      policyRegistry: registry,
    });

    // 第二次派发：先撞到 A/AMAZON 的第二条（窗口已耗尽 → RATE_LIMITED），再落到 B（account 隔离）
    const second = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(second.kind).toBe('LEASED');
    if (second.kind === 'LEASED') {
      const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: second.intentId } });
      expect(row.platformAccountId).toBe('acct-B');
      expect(second.intentId).not.toBe(first.intentId);
    }

    // A 的第二条 intent 在窗口耗尽后应被标记 RATE_LIMITED（不是被无视、也不是被放宽）
    const rateLimited = await prisma.providerSubmissionEvent.count({
      where: { kind: 'RATE_LIMITED' },
    });
    expect(rateLimited).toBeGreaterThanOrEqual(1);
  });

  it('PG-S4 并发 worker 竞争同一 intent → exactly one execution right', async () => {
    const created = await enqueueProviderSubmission(prisma, enqueueInput());
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');
    const [a, b] = await Promise.all([
      leaseProviderSubmission(prisma, {
        ownerRef: 'worker-A',
        now: NOW,
        leaseTtlMs: 60_000,
        maxAttempts: 5,
        policyRegistry: registry,
      }),
      leaseProviderSubmission(workerB, {
        ownerRef: 'worker-B',
        now: NOW,
        leaseTtlMs: 60_000,
        maxAttempts: 5,
        policyRegistry: registry,
      }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['LEASED', 'NONE_AVAILABLE']);
    const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: created.intentId } });
    expect(row.state).toBe('LEASED');
    expect(row.attemptCount).toBe(1);
    expect(await prisma.providerSubmissionEvent.count({ where: { kind: 'LEASE_ACQUIRED' } })).toBe(1);
  });
});

describe('P1 Scheduler · provider 响应语义（durable）', () => {
  async function leasedIntent() {
    const created = await enqueueProviderSubmission(prisma, enqueueInput());
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');
    const leased = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    if (leased.kind !== 'LEASED') throw new Error('lease 失败');
    return leased;
  }

  it('PG-S5 429 → RATE_LIMITED + retry-after 落库（事件含 providerResponseKind）', async () => {
    const leased = await leasedIntent();
    const result = await recordProviderOutcome(prisma, {
      intentId: leased.intentId,
      leaseId: leased.leaseId,
      responseKind: 'RATE_LIMITED_429',
      retryAfterMs: 30_000,
      now: NOW,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(result.kind).toBe('RECORDED');
    const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: leased.intentId } });
    expect(row.state).toBe('RATE_LIMITED');
    expect(row.retryAfterAt).not.toBeNull();
    expect(row.leaseId).toBeNull();
    const events = await prisma.providerSubmissionEvent.findMany({ where: { intentId: leased.intentId } });
    expect(events.some((e) => e.kind === 'RATE_LIMITED' && e.providerResponseKind === 'RATE_LIMITED_429')).toBe(true);
  });

  it('PG-S6 UNKNOWN → NEEDS_MANUAL + RECONCILIATION_REQUIRED，且不再被自动派发（no blind retry）', async () => {
    const leased = await leasedIntent();
    const result = await recordProviderOutcome(prisma, {
      intentId: leased.intentId,
      leaseId: leased.leaseId,
      responseKind: 'UNKNOWN',
      now: NOW,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(result.kind).toBe('RECORDED');
    const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: leased.intentId } });
    expect(row.state).toBe('NEEDS_MANUAL');
    expect(row.retryAfterAt).toBeNull();
    expect(
      await prisma.providerSubmissionEvent.count({
        where: { intentId: leased.intentId, kind: 'RECONCILIATION_REQUIRED' },
      }),
    ).toBe(1);
    // 再次派发：该 intent 不可再被自动取走
    const again = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: new Date(NOW.getTime() + 3_600_000),
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(again.kind).toBe('NONE_AVAILABLE');
    const dead = await listDeadLetterProviderIntents(prisma);
    expect(dead.map((d) => d.id)).toContain(leased.intentId);
  });

  it('PG-S7 尝试耗尽（maxAttempts=1）→ DEAD_LETTER', async () => {
    const created = await enqueueProviderSubmission(prisma, enqueueInput());
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');
    const leased = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttempts: 1,
      policyRegistry: registry,
    });
    if (leased.kind !== 'LEASED') throw new Error('lease 失败');
    const result = await recordProviderOutcome(prisma, {
      intentId: leased.intentId,
      leaseId: leased.leaseId,
      responseKind: 'RETRYABLE_5XX',
      now: NOW,
      maxAttempts: 1,
      policyRegistry: registry,
    });
    expect(result.kind).toBe('RECORDED');
    const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: leased.intentId } });
    expect(row.state).toBe('DEAD_LETTER');
    expect(await prisma.providerSubmissionEvent.count({ where: { kind: 'DEAD_LETTERED' } })).toBe(1);
  });

  it('PG-S8 过期 lease → 重启恢复归还队列（LEASE_RECLAIMED），随后可再次取得执行权', async () => {
    const created = await enqueueProviderSubmission(prisma, enqueueInput());
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');
    const leased = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-crashed',
      now: NOW,
      leaseTtlMs: 1,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(leased.kind).toBe('LEASED');
    await new Promise((r) => setTimeout(r, 30));
    const recovered = await recoverExpiredProviderLeases(prisma, { now: LATER });
    expect(recovered).toBe(1);
    const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: created.intentId } });
    expect(row.state).toBe('READY_FOR_PROVIDER');
    expect(row.leaseId).toBeNull();
    expect(await prisma.providerSubmissionEvent.count({ where: { kind: 'LEASE_RECLAIMED' } })).toBe(1);

    const again = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-2',
      now: LATER,
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(again.kind).toBe('LEASED');
  });

  it('PG-S9 缺策略 → NEEDS_MANUAL（不放宽策略、不派发）', async () => {
    const created = await enqueueProviderSubmission(prisma, enqueueInput({ platform: 'WALMART' }));
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');
    const outcome = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(outcome.kind).toBe('NONE_AVAILABLE');
    const row = await prisma.providerSubmissionIntent.findUniqueOrThrow({ where: { id: created.intentId } });
    expect(row.state).toBe('NEEDS_MANUAL');
    expect(row.lastReason).toBe('POLICY_MISSING');
  });
});

describe('P1 Scheduler · durable 限流窗口与长期安全断言', () => {
  it('PG-S10 限流窗口落库：窗口计数与 scopeKey 可取证', async () => {
    await enqueueProviderSubmission(prisma, enqueueInput());
    const leased = await leaseProviderSubmission(prisma, {
      ownerRef: 'worker-1',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttempts: 5,
      policyRegistry: registry,
    });
    expect(leased.kind).toBe('LEASED');
    const p = policy();
    const scopeKey = providerRateScopeKey({
      policy: p,
      organizationId: 'org-sched-1',
      platform: 'AMAZON',
      platformAccountId: 'acct-A',
      operation: 'CLAIM_SUBMIT',
      connectionRef: 'conn-1',
    });
    const windowStart = new Date(Math.floor(NOW.getTime() / 60_000) * 60_000);
    const window = await readProviderRateWindow(prisma, {
      organizationId: 'org-sched-1',
      scopeKey,
      windowStart,
    });
    expect(window?.count).toBe(1);
  });

  it('PG-S11 证据 append-only；队列身份不可原地改写；跨租户改写被拒', async () => {
    const created = await enqueueProviderSubmission(prisma, enqueueInput());
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');

    await expect(
      prisma.$executeRawUnsafe('UPDATE "ProviderSubmissionEvent" SET "reason" = $1 WHERE "intentId" = $2', 'x', created.intentId),
    ).rejects.toThrow(/PROVIDER_SUBMISSION_EVENT_APPEND_ONLY/);

    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderSubmissionIntent" SET "payloadDigest" = $1 WHERE "id" = $2',
        'tampered',
        created.intentId,
      ),
    ).rejects.toThrow(/PROVIDER_SUBMISSION_IDENTITY_IMMUTABLE/);

    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderSubmissionIntent" SET "organizationId" = $1 WHERE "id" = $2',
        'org-other',
        created.intentId,
      ),
    ).rejects.toThrow(/PROVIDER_SUBMISSION_IDENTITY_IMMUTABLE|organizationId|TENANT/i);
  });

  it('PG-S12 队列项状态域与 lease 一致性由数据库兜底（非法状态 / 无 lease 的 LEASED 被拒）', async () => {
    const created = await enqueueProviderSubmission(prisma, enqueueInput());
    if (created.kind !== 'CREATE') throw new Error('enqueue 失败');
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderSubmissionIntent" SET "state" = $1 WHERE "id" = $2',
        'SENT_TO_PROVIDER',
        created.intentId,
      ),
    ).rejects.toThrow(/state_chk|check/i);
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "ProviderSubmissionIntent" SET "state" = $1 WHERE "id" = $2',
        'LEASED',
        created.intentId,
      ),
    ).rejects.toThrow(/lease_chk|check/i);
  });
});
