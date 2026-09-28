/**
 * C-0010-B2 — execution-attempt helpers, unit level（无数据库）。
 * 覆盖重试退避、错误分类与白名单、以及并发冲突的语义映射。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  ATTEMPT_STATUSES,
  MAX_ATTEMPTS,
  REPLAY_REASONS,
  RETRY_BACKOFF_MINUTES,
  RETRYABLE_ERROR_CODES,
  SYSTEM_RETRY_ACTOR_REF,
  WorkflowError,
  classifyAttemptError,
  finishAttempt,
  nextRetryDelayMinutes,
  redactErrorSummary,
  startAttempt,
} from '../services/workflow';

describe('C-0010-B2 — 白名单与退避', () => {
  it('状态集合与错误码白名单就是架构方指定的那一组', () => {
    expect([...ATTEMPT_STATUSES]).toEqual([
      'PENDING',
      'RUNNING',
      'SUCCEEDED',
      'RETRYABLE_FAILED',
      'DEAD_LETTER',
    ]);
    expect([...RETRYABLE_ERROR_CODES]).toEqual([
      'DATABASE_TIMEOUT',
      'CAS_CONFLICT',
      'UNKNOWN_PROVIDER_RESPONSE',
    ]);
    expect([...REPLAY_REASONS]).toEqual([
      'DATABASE_TIMEOUT',
      'CAS_CONFLICT',
      'UNKNOWN_PROVIDER_RESPONSE',
      'MANUAL_RECOVERY',
      'OTHER',
    ]);
    expect(SYSTEM_RETRY_ACTOR_REF).toBe('payment-retry-worker');
  });

  it('退避 1 / 5 / 15 分钟，超过上限不再排期', () => {
    expect(RETRY_BACKOFF_MINUTES).toEqual([1, 5, 15]);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(nextRetryDelayMinutes(1)).toBe(1);
    expect(nextRetryDelayMinutes(2)).toBe(5);
    expect(nextRetryDelayMinutes(3)).toBe(15);
    expect(nextRetryDelayMinutes(4)).toBeNull();
    expect(nextRetryDelayMinutes(0)).toBeNull();
  });

  it('错误摘要脱敏长 token 并截断', () => {
    const summary = redactErrorSummary(
      `failed with whsec_abcdefghijklmnopqrstuvwxyz123456 for evt_9f8e7d6c5b4a39281706 ${'x'.repeat(400)}`,
    );
    expect(summary).not.toContain('whsec_abcdefghijklmnopqrstuvwxyz123456');
    expect(summary).toContain('<redacted>');
    expect(summary.length).toBeLessThanOrEqual(160);
  });
});

describe('C-0010-B2 — 错误分类（只有技术失败可重试）', () => {
  it('领域错误（WorkflowError）与 CAS 冲突分别归类，且领域错误不重试', () => {
    const domain = classifyAttemptError(new WorkflowError('NOT_FOUND', 'invoice gone'));
    expect(domain.retryable).toBe(false);
    expect(domain.errorCode).toBe('UNKNOWN_PROVIDER_RESPONSE');

    const conflict = classifyAttemptError(
      new Prisma.PrismaClientKnownRequestError('write conflict', {
        code: 'P2034',
        clientVersion: '5.22.0',
      }),
    );
    expect(conflict).toMatchObject({ errorCode: 'CAS_CONFLICT', retryable: true });

    const timeout = classifyAttemptError(
      new Prisma.PrismaClientKnownRequestError('timed out', {
        code: 'P2024',
        clientVersion: '5.22.0',
      }),
    );
    expect(timeout).toMatchObject({ errorCode: 'DATABASE_TIMEOUT', retryable: true });

    const unknown = classifyAttemptError(new Error('boom'));
    expect(unknown).toMatchObject({ errorCode: 'UNKNOWN_PROVIDER_RESPONSE', retryable: true });
  });
});

function fakePrisma(options: { createError?: unknown; updateCount?: number } = {}) {
  const create = vi.fn(async (_args: { data: Record<string, unknown> }) => {
    if (options.createError) throw options.createError;
    return { id: 'attempt-1', attemptNo: 2 };
  });
  const updateMany = vi.fn(async (_args: { where: Record<string, unknown> }) => ({
    count: options.updateCount ?? 1,
  }));
  const prisma = {
    paymentProcessingAttempt: {
      findFirst: vi.fn(async () => ({ attemptNo: 1 })),
      create,
      updateMany,
    },
  } as unknown as PrismaClient;
  return { prisma, create, updateMany };
}

describe('C-0010-B2 — attempt 生命周期', () => {
  it('startAttempt 递增 attemptNo 并落 RUNNING', async () => {
    const { prisma, create } = fakePrisma();
    const attempt = await startAttempt(
      prisma,
      {
        organizationId: 'org-1',
        paymentEventId: 'evt-1',
        actorType: 'EXTERNAL',
        actorRef: 'STRIPE',
      },
      { now: () => new Date('2026-09-28T18:00:00Z') },
    );
    expect(attempt).toMatchObject({ id: 'attempt-1', attemptNo: 2 });
    expect(create.mock.calls[0][0].data).toMatchObject({
      attemptNo: 2,
      status: 'RUNNING',
      actorType: 'EXTERNAL',
      actorRef: 'STRIPE',
    });
  });

  it('并发冲突（部分唯一索引 P2002）→ ILLEGAL_TRANSITION，不静默吞掉', async () => {
    const { prisma } = fakePrisma({
      createError: new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '5.22.0',
      }),
    });
    await expect(
      startAttempt(prisma, {
        organizationId: 'org-1',
        paymentEventId: 'evt-1',
        actorType: 'OPERATOR',
        actorRef: 'user-1',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('finishAttempt 用 CAS 收口：非 RUNNING 的行不会被改动', async () => {
    const { prisma, updateMany } = fakePrisma({ updateCount: 0 });
    const ok = await finishAttempt(prisma, { attemptId: 'attempt-1', status: 'SUCCEEDED' });
    expect(ok).toBe(false);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ id: 'attempt-1', status: 'RUNNING' });
  });
});
