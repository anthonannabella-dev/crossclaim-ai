/**
 * RSI-RT-06 平台级自治状态持久化 —— 数据库级不变量（真实 PG）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261005-01 = PASS WITH REVISE（RSI_SCHEMA_DELTA = APPROVED_WITH_REVISIONS）
 * 只允许跑在一次性库上（tools/verification/run-db-test-on-ephemeral.mjs）；
 * 证据表是 append-only，清理只能靠 afterAll 的表级 TRUNCATE，绝不逐行 DELETE。
 *
 * 本用例证明的正是裁决要求的四件事：
 *   ① UNIQUE(dedupeKey)：reboot 后同因不重复建 incident / task / candidate / promotion
 *   ② 生命周期状态 TEXT + CHECK：非法状态写不进去
 *   ③ 证据表 append-only：MetricResult / PromotionDecision / RollbackRecord 拒绝 UPDATE/DELETE
 *   ④ PromotionDecision fail-closed：judgeRef 不得等于 candidate.builderRef
 * 以及 AutonomyLease 的 taskId 唯一 + 时间单调。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const suffix = () => randomUUID().replace(/-/g, '').slice(0, 12);

const seedIncident = (over = {}) =>
  prisma.autonomyIncident.create({
    data: {
      kind: 'CI_RED',
      dedupeKey: 'inc-' + suffix(),
      status: 'OPEN',
      riskClass: 'LOW',
      sourceRefs: [{ ref: 'ci/run/1' }],
      detectedAt: new Date('2026-10-05T00:00:00.000Z'),
      ...over,
    },
  });

const seedTask = async (incidentId: string, over = {}) =>
  prisma.autonomyTask.create({
    data: {
      incidentId,
      status: 'READY',
      riskClass: 'LOW',
      ownerGateRequired: false,
      dedupeKey: 'task-' + suffix(),
      ...over,
    },
  });

const seedCandidate = async (taskId: string, over = {}) =>
  prisma.autonomyCandidate.create({
    data: {
      taskId,
      status: 'CREATED',
      builderRef: 'builder-a',
      baselineRef: 'commit:baseline',
      codeCommitRef: 'commit:candidate',
      promptVersion: 'p1',
      dedupeKey: 'cand-' + suffix(),
      ...over,
    },
  });

const reject = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error('EXPECTED_REJECTION_BUT_WRITE_SUCCEEDED');
};

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

describe('RSI-RT-06 平台级状态表 DB 不变量', () => {
  it('① UNIQUE(dedupeKey)：同一 dedupeKey 的 incident 只能建一次', async () => {
    const dedupeKey = 'inc-dedupe-' + suffix();
    const first = await seedIncident({ dedupeKey });
    expect(first.id).toBeTruthy();
    const message = await reject(() => seedIncident({ dedupeKey }));
    expect(message).toMatch(/Unique constraint|P2002|dedupeKey/i);
  });

  it('① UNIQUE(dedupeKey)：task / candidate / promotion 同样幂等', async () => {
    const incident = await seedIncident();
    const taskKey = 'task-dedupe-' + suffix();
    const task = await seedTask(incident.id, { dedupeKey: taskKey });
    expect(await reject(() => seedTask(incident.id, { dedupeKey: taskKey }))).toMatch(/Unique constraint|P2002|dedupeKey/i);

    const candKey = 'cand-dedupe-' + suffix();
    const candidate = await seedCandidate(task.id, { dedupeKey: candKey });
    expect(await reject(() => seedCandidate(task.id, { dedupeKey: candKey }))).toMatch(
      /Unique constraint|P2002|dedupeKey/i,
    );

    const promoKey = 'promo-dedupe-' + suffix();
    const promo = () =>
      prisma.autonomyPromotionDecision.create({
        data: {
          candidateId: candidate.id,
          dedupeKey: promoKey,
          decision: 'PROMOTED',
          reason: 'judge approved',
          judgeRef: 'judge-a',
          decidedAt: new Date('2026-10-05T00:01:00.000Z'),
        },
      });
    await promo();
    expect(await reject(promo)).toMatch(/Unique constraint|P2002|dedupeKey/i);
  });

  it('② 生命周期状态 CHECK：非法 status 写不进去（incident / task / candidate / lease）', async () => {
    const incident = await seedIncident();
    const task = await seedTask(incident.id);
    const candidate = await seedCandidate(task.id);

    expect(await reject(() => seedIncident({ status: 'BOGUS' }))).toMatch(/check constraint|AutonomyIncident_status_chk/i);
    expect(await reject(() => seedTask(incident.id, { status: 'BOGUS' }))).toMatch(
      /check constraint|AutonomyTask_status_chk/i,
    );
    expect(await reject(() => seedCandidate(task.id, { status: 'BOGUS' }))).toMatch(
      /check constraint|AutonomyCandidate_status_chk/i,
    );
    expect(await reject(() => seedIncident({ riskClass: 'CATASTROPHIC' }))).toMatch(
      /check constraint|AutonomyIncident_risk_class_chk/i,
    );
    expect(
      await reject(() =>
        prisma.autonomyLease.create({
          data: {
            taskId: candidate.taskId,
            ownerRef: 'controller-1',
            acquiredAt: new Date('2026-10-05T00:00:00.000Z'),
            renewedAt: new Date('2026-10-05T00:00:00.000Z'),
            expiresAt: new Date('2026-10-05T00:05:00.000Z'),
            status: 'BOGUS',
          },
        }),
      ),
    ).toMatch(/check constraint|AutonomyLease_status_chk/i);
  });

  it('AutonomyLease：taskId 唯一 + 时间单调（expiresAt > acquiredAt）', async () => {
    const incident = await seedIncident();
    const task = await seedTask(incident.id);
    const base = {
      ownerRef: 'controller-1',
      acquiredAt: new Date('2026-10-05T00:00:00.000Z'),
      renewedAt: new Date('2026-10-05T00:00:00.000Z'),
    };

    await prisma.autonomyLease.create({
      data: { ...base, taskId: task.id, expiresAt: new Date('2026-10-05T00:05:00.000Z'), status: 'ACTIVE' },
    });

    expect(
      await reject(() =>
        prisma.autonomyLease.create({
          data: { ...base, taskId: task.id, expiresAt: new Date('2026-10-05T00:09:00.000Z'), status: 'ACTIVE' },
        }),
      ),
    ).toMatch(/Unique constraint|P2002|taskId/i);

    const other = await seedTask(incident.id);
    expect(
      await reject(() =>
        prisma.autonomyLease.create({
          data: { ...base, taskId: other.id, expiresAt: base.acquiredAt, status: 'ACTIVE' },
        }),
      ),
    ).toMatch(/check constraint|AutonomyLease_time_order_chk/i);
  });

  it('③ 证据表 append-only：MetricResult 拒绝 UPDATE 与 DELETE', async () => {
    const incident = await seedIncident();
    const task = await seedTask(incident.id);
    const candidate = await seedCandidate(task.id);
    const run = await prisma.autonomyEvaluationRun.create({
      data: {
        candidateId: candidate.id,
        kind: 'TEST',
        status: 'PASSED',
        startedAt: new Date('2026-10-05T00:00:00.000Z'),
        finishedAt: new Date('2026-10-05T00:01:00.000Z'),
      },
    });
    const metric = await prisma.autonomyMetricResult.create({
      data: { evaluationRunId: run.id, name: 'tests_passed', value: '12', unit: 'count' },
    });

    expect(
      await reject(() =>
        prisma.$executeRawUnsafe('UPDATE "AutonomyMetricResult" SET "name" = ' + "'tampered'" + ' WHERE "id" = ' + "'" + metric.id + "'"),
      ),
    ).toMatch(/RSI_EVIDENCE_APPEND_ONLY/);
    expect(
      await reject(() => prisma.$executeRawUnsafe('DELETE FROM "AutonomyMetricResult" WHERE "id" = ' + "'" + metric.id + "'")),
    ).toMatch(/RSI_EVIDENCE_APPEND_ONLY/);
  });

  it('③ 证据表 append-only：PromotionDecision / RollbackRecord 拒绝 UPDATE 与 DELETE', async () => {
    const incident = await seedIncident();
    const task = await seedTask(incident.id);
    const candidate = await seedCandidate(task.id);
    const promo = await prisma.autonomyPromotionDecision.create({
      data: {
        candidateId: candidate.id,
        dedupeKey: 'promo-' + suffix(),
        decision: 'REJECTED',
        reason: 'insufficient evidence',
        judgeRef: 'judge-a',
        decidedAt: new Date('2026-10-05T00:02:00.000Z'),
      },
    });
    const rollback = await prisma.autonomyRollbackRecord.create({
      data: {
        candidateId: candidate.id,
        targetRef: 'commit:candidate',
        reason: 'drift detected',
        triggeredBy: 'observer',
      },
    });

    expect(
      await reject(() =>
        prisma.$executeRawUnsafe('UPDATE "AutonomyPromotionDecision" SET "reason" = ' + "'x'" + ' WHERE "id" = ' + "'" + promo.id + "'"),
      ),
    ).toMatch(/RSI_EVIDENCE_APPEND_ONLY/);
    expect(
      await reject(() => prisma.$executeRawUnsafe('DELETE FROM "AutonomyRollbackRecord" WHERE "id" = ' + "'" + rollback.id + "'")),
    ).toMatch(/RSI_EVIDENCE_APPEND_ONLY/);
  });

  it('④ Builder/Judge 分离：同一 actor 自我批准被 fail-closed 拒绝，独立判定者通过', async () => {
    const incident = await seedIncident();
    const task = await seedTask(incident.id);
    const candidate = await seedCandidate(task.id, { builderRef: 'agent-self' });

    expect(
      await reject(() =>
        prisma.autonomyPromotionDecision.create({
          data: {
            candidateId: candidate.id,
            dedupeKey: 'promo-self-' + suffix(),
            decision: 'PROMOTED',
            reason: 'self approved',
            judgeRef: 'agent-self',
            decidedAt: new Date('2026-10-05T00:03:00.000Z'),
          },
        }),
      ),
    ).toMatch(/RSI_BUILDER_JUDGE_SAME_ACTOR/);

    const ok = await prisma.autonomyPromotionDecision.create({
      data: {
        candidateId: candidate.id,
        dedupeKey: 'promo-independent-' + suffix(),
        decision: 'PROMOTED',
        reason: 'independent judge approved',
        judgeRef: 'judge-independent',
        decidedAt: new Date('2026-10-05T00:04:00.000Z'),
      },
    });
    expect(ok.id).toBeTruthy();
  });

  it('⑤ 平台级：RSI 表不落任何租户列（schema 层已保证，这里用 information_schema 复核）', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      "SELECT table_name, column_name FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name LIKE 'Autonomy%' " +
        "AND column_name IN ('organizationId', 'tenantId', 'customerId')",
    );
    expect(rows).toEqual([]);
  });
});
