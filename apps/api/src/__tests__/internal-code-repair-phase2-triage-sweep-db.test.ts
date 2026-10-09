/**
 * INTERNAL CODE REPAIR V1 / PHASE 2 —— 分流扫描（真实 PostgreSQL）验收
 * ---------------------------------------------------------------
 * 证明：
 *   · 扫描只处理 kind = INTERNAL_FAULT 且 status = DIAGNOSED 的行；
 *   · 缺少可信事实（未注入解析器）⇒ 一律 fail-closed（BLOCK），拿不到 A 路径；
 *   · A 路径候选**只被登记**，不建任务、不建租约、不调用运行时；
 *   · 登记只写固定三项，且不覆盖 PHASE 1 原有键。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { FaultObservation } from '../services/self-repair/fault-classification';
import { createPrismaFaultIncidentIntake } from '../services/self-repair/fault-incident-intake';
import {
  FAULT_TRIAGE_SWEEP_BOUNDARY,
  TRIAGE_REGISTRATION_FIELDS,
  createPrismaFaultTriageSweep,
} from '../services/self-repair/fault-triage-sweep';

import { testDatabaseMarker } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-09T07:00:00.000Z');
const BASE: FaultObservation = {
  sourceModule: 'services/autonomy/rsi-si-model-gateway',
  environment: 'TEST',
  organizationRef: 'org-sweep',
  providerRef: 'AMAZON',
};
const TRUSTED = {
  organizationIdResolved: true,
  authorizationActive: true,
  operationRecheck: 'CONFIRMED_READ_ONLY',
} as const;

const intake = (): ReturnType<typeof createPrismaFaultIncidentIntake> =>
  createPrismaFaultIncidentIntake({ prisma, now: () => T0 });

async function seed(observation: FaultObservation): Promise<string> {
  const recorded = await intake().record(observation);
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error('expected recorded');
  return recorded.incidentId;
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE;',
  );
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe(`PHASE 2 分流扫描 × 真实 PostgreSQL（${testDatabaseMarker()}）`, () => {
  it('DB-S1 注入可信事实 ⇒ A 路径候选与修复候选各得其所，且只登记不执行', async () => {
    const healable = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    const bug = await seed({ ...BASE, errorName: 'AdapterMappingError' });

    const sweep = createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    });
    const result = await sweep.sweepOnce({ limit: 10 });

    expect(result.scanned).toBe(2);
    expect(result.registered).toBe(2);
    expect(result.tasksCreated).toBe(0);
    expect(result.leasesCreated).toBe(0);
    expect(result.runtimeInvocations).toBe(0);
    expect(result.decisions.map((d) => d.disposition).sort()).toEqual(['AUTO_RECOVER_VIA_RUNTIME', 'CODE_REPAIR_CANDIDATE']);

    const healableRow = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id: healable } });
    const bugRow = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id: bug } });
    const healableRefs = healableRow.sourceRefs as Record<string, unknown>;
    const bugRefs = bugRow.sourceRefs as Record<string, unknown>;
    expect(healableRefs.triageDecision).toBe('AUTO_RECOVER_VIA_RUNTIME');
    expect(healableRefs.triageReason).toBe('HANDOFF_TO_EXISTING_RUNTIME');
    expect(bugRefs.triageDecision).toBe('CODE_REPAIR_CANDIDATE');
    // 登记不覆盖 PHASE 1 原有键
    expect(healableRefs.faultClass).toBe('API_TIMEOUT');
    expect(healableRefs.organizationRef).toMatch(/^org-[0-9a-f]{16}$/);
    expect(Object.keys(healableRefs).length).toBeGreaterThanOrEqual(24 + TRIAGE_REGISTRATION_FIELDS.length - 1);
    // 零执行：无任务、无租约
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-S2 未注入可信事实 ⇒ 全部 fail-closed（BLOCK），绝不产生 A 路径候选', async () => {
    await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    const result = await createPrismaFaultTriageSweep({ prisma, now: () => T0 }).sweepOnce();
    expect(result.scanned).toBe(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(result.decisions[0]!.runtimeHandoffAuthorized).toBe(false);
    // 首道未过的是「租户身份未经可信库解析」（fail-closed 默认值），结论恒为 BLOCK
    expect(result.decisions[0]!.reason).toBe('TENANT_CONTEXT_NOT_TRUSTED');
  });

  it('DB-S3 只扫描 DIAGNOSED：OPEN 与终态行不进入分流', async () => {
    const open = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY', message: 'open one' });
    const closed = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY', message: 'closed one' });
    await prisma.autonomyIncident.update({ where: { id: open }, data: { status: 'OPEN' } });
    await prisma.autonomyIncident.update({ where: { id: closed }, data: { status: 'CLOSED' } });

    const result = await createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    }).sweepOnce();
    expect(result.scanned).toBe(0);
    expect(result.registered).toBe(0);
  });

  it('DB-S4 扫描只登记固定三项（无自由文本键）', async () => {
    await seed({ ...BASE, errorName: 'AdapterMappingError' });
    await createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    }).sweepOnce();
    const row = await prisma.autonomyIncident.findFirstOrThrow();
    const keys = Object.keys(row.sourceRefs as Record<string, unknown>);
    for (const field of TRIAGE_REGISTRATION_FIELDS) expect(keys).toContain(field);
    // 登记值都是稳定码 / ISO 时间，不含自由文本
    const refs = row.sourceRefs as Record<string, unknown>;
    expect(String(refs.triageDecision)).toMatch(/^[A-Z_]+$/);
    expect(String(refs.triageReason)).toMatch(/^[A-Z_]+$/);
    expect(String(refs.triagedAt)).toBe(T0.toISOString());
  });

  it('DB-S5 静态证据：扫描模块不引用任何运行时/任务/租约写入面', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../services/self-repair/fault-triage-sweep.ts'),
      'utf8',
    );
    expect(source.includes("from '../runtime/")).toBe(false);
    expect(source.includes('autonomyTask')).toBe(false);
    expect(source.includes('autonomyLease')).toBe(false);
    expect(source.includes('console.')).toBe(false);
    expect(FAULT_TRIAGE_SWEEP_BOUNDARY).toMatchObject({
      createsTasks: false,
      createsLeases: false,
      invokesRuntime: false,
      performsExternalWrites: false,
      defaultTrustedFacts: 'FAIL_CLOSED',
    });
  });
});
