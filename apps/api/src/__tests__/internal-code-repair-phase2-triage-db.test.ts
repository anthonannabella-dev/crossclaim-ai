/**
 * INTERNAL CODE REPAIR V1 / PHASE 2 —— 分流在**真实 PostgreSQL 落库载荷**上的往返验收（GATE-2 证据）
 * ---------------------------------------------------------------
 * 目的：证明分流消费的是**真实持久化行**（PHASE 1 写入的 sourceRefs 白名单载荷），
 * 而不是测试里手写的理想对象；并证明外部写 / 未分类等路径在真实数据上同样 fail-closed。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { FaultObservation } from '../services/self-repair/fault-classification';
import { createPrismaFaultIncidentIntake } from '../services/self-repair/fault-incident-intake';
import { triageFaultIncident } from '../services/self-repair/fault-triage';

import { testDatabaseMarker } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-09T06:30:00.000Z');
const BASE: FaultObservation = {
  sourceModule: 'services/autonomy/rsi-si-model-gateway',
  environment: 'TEST',
  organizationRef: 'org-phase2-db',
  providerRef: 'AMAZON',
};
const TRUSTED = {
  organizationIdResolved: true,
  authorizationActive: true,
  operationRecheck: 'CONFIRMED_READ_ONLY',
} as const;

const intake = (): ReturnType<typeof createPrismaFaultIncidentIntake> =>
  createPrismaFaultIncidentIntake({ prisma, now: () => T0 });

const persistAndTriage = async (
  observation: FaultObservation,
  trusted: typeof TRUSTED = TRUSTED,
): Promise<ReturnType<typeof triageFaultIncident>> => {
  const recorded = await intake().record(observation);
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error('expected incident to be recorded');
  const persisted = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id: recorded.incidentId } });
  return triageFaultIncident({
    incident: {
      id: persisted.id,
      kind: persisted.kind,
      dedupeKey: persisted.dedupeKey,
      status: persisted.status,
      riskClass: persisted.riskClass,
      sourceRefs: persisted.sourceRefs,
    },
    trusted: { ...trusted },
  });
};

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE;',
  );
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe(`PHASE 2 分流 × 真实 PostgreSQL 往返（${testDatabaseMarker()}）`, () => {
  it('DB-T1 只读超时（真实落库行）⇒ A 路径交回既有运行时', async () => {
    const decision = await persistAndTriage({
      ...BASE,
      errorCode: 'PROVIDER_TIMEOUT',
      operationKind: 'READ_ONLY',
    });
    expect(decision.disposition).toBe('AUTO_RECOVER_VIA_RUNTIME');
    expect(decision.runtimeHandoffAuthorized).toBe(true);
    expect(decision.checks.every((check) => check.ok)).toBe(true);
  });

  it('DB-T2 外部写故障（真实落库行）⇒ 先对账，零交接；且不产生任何任务/租约', async () => {
    const decision = await persistAndTriage({
      ...BASE,
      errorCode: 'PROVIDER_TIMEOUT',
      operationKind: 'EXTERNAL_WRITE',
    });
    expect(decision.disposition).toBe('RECONCILE');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-T3 真实落库的解析缺陷 ⇒ 修复候选（不执行、不建任务）', async () => {
    const decision = await persistAndTriage({ ...BASE, errorName: 'AdapterMappingError' });
    expect(decision.disposition).toBe('CODE_REPAIR_CANDIDATE');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
    expect(await prisma.autonomyTask.count()).toBe(0);
  });

  it('DB-T4 未分类故障（真实落库行）⇒ NEEDS_CLASSIFICATION（禁止自动恢复）', async () => {
    const decision = await persistAndTriage({ ...BASE, errorName: 'WibbleFault', operationKind: 'READ_ONLY' });
    expect(decision.disposition).toBe('NEEDS_CLASSIFICATION');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
  });

  it('DB-T5 终态化的真实行不可再分流（生命周期前置条件）', async () => {
    const recorded = await intake().record({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error('expected recorded');
    await prisma.autonomyIncident.update({ where: { id: recorded.incidentId }, data: { status: 'CLOSED' } });
    const persisted = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id: recorded.incidentId } });
    const decision = triageFaultIncident({
      incident: {
        id: persisted.id,
        kind: persisted.kind,
        dedupeKey: persisted.dedupeKey,
        status: persisted.status,
        riskClass: persisted.riskClass,
        sourceRefs: persisted.sourceRefs,
      },
      trusted: { ...TRUSTED },
    });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('INCIDENT_NOT_DIAGNOSED');
  });
});
