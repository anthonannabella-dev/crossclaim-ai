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

  /**
   * GATE-4 在 PHASE 2 层可覆盖的部分：**重复分流**与**并发扫描**的幂等性。
   * （运行时的 fencing / 断连 / 崩溃恢复属既有运行时路径，由既有 SI/RSI 门禁覆盖。）
   */
  it('DB-S6 重复分流幂等（CHANGE 2）：第二次不再写、triagedAt 不漂移、仍然零执行', async () => {
    const id = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    const sweep = createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    });
    const first = await sweep.sweepOnce();
    const afterFirst = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });
    const second = await sweep.sweepOnce();
    const afterSecond = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });

    expect(first.decisions[0]!.disposition).toBe('AUTO_RECOVER_VIA_RUNTIME');
    expect(second.decisions[0]!.disposition).toBe('AUTO_RECOVER_VIA_RUNTIME');
    // first-write-wins：第二次不写，登记字段逐字不变（时间戳不漂移、决策不被覆盖）
    expect(first.registered).toBe(1);
    expect(second.registered).toBe(0);
    expect(second.alreadyRegistered).toBe(1);
    expect(second.skipped).toBe(0);
    expect(afterSecond.sourceRefs).toEqual(afterFirst.sourceRefs);
    expect(Object.keys(afterSecond.sourceRefs as Record<string, unknown>)).toHaveLength(
      Object.keys(afterFirst.sourceRefs as Record<string, unknown>).length,
    );
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-S7 并发扫描（4 路同时，CHANGE 2）：只有一次有效登记、结论一致、零任务零租约', async () => {
    const id = await seed({ ...BASE, errorName: 'AdapterMappingError' });
    const make = (): ReturnType<typeof createPrismaFaultTriageSweep> =>
      createPrismaFaultTriageSweep({ prisma, now: () => T0, resolveTrustedFacts: async () => ({ ...TRUSTED }) });

    const results = await Promise.all([make().sweepOnce(), make().sweepOnce(), make().sweepOnce(), make().sweepOnce()]);
    // 四路都在算，但**只有一次**真正写入登记
    expect(results.reduce((sum, r) => sum + r.registered, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.alreadyRegistered, 0)).toBe(3);
    expect(results.reduce((sum, r) => sum + r.skipped, 0)).toBe(0);
    for (const result of results) {
      expect(result.scanned).toBe(1);
      expect(result.decisions[0]!.disposition).toBe('CODE_REPAIR_CANDIDATE');
      expect(result.tasksCreated).toBe(0);
      expect(result.runtimeInvocations).toBe(0);
    }
    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });
    const refs = row.sourceRefs as Record<string, unknown>;
    expect(refs.triageDecision).toBe('CODE_REPAIR_CANDIDATE');
    expect(refs.triagedAt).toBe(T0.toISOString());
    for (const field of TRIAGE_REGISTRATION_FIELDS) {
      expect(Object.keys(refs).filter((key) => key === field)).toHaveLength(1);
    }
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-S8 扫描 vs 状态变更竞争：转终态后登记被前置条件挡住（不写、不错、不抛）', async () => {
    const id = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    const sweep = createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => {
        // 模拟「分流过程中该 Incident 被人工置为 CLOSED」
        await prisma.autonomyIncident.update({ where: { id }, data: { status: 'CLOSED' } });
        return { ...TRUSTED };
      },
    });
    const result = await sweep.sweepOnce();
    expect(result.scanned).toBe(1); // 扫描时仍是 DIAGNOSED
    expect(result.registered).toBe(0); // 登记被 kind/status 前置条件挡住
    expect(result.alreadyRegistered).toBe(0);
    expect(result.skipped).toBe(1);
    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('CLOSED');
    expect((row.sourceRefs as Record<string, unknown>).triageDecision).toBeUndefined();
  });

  /**
   * MSG-20261009-09 / CHANGE 2 —— 并发与时间戳语义的确定性证明。
   */
  it('DB-S11 快照语义：可信事实变化后重扫，已登记结论与 triagedAt 不被覆盖', async () => {
    const id = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    // 首次：可信事实全绿 ⇒ A 路径候选
    const first = await createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    }).sweepOnce();
    expect(first.decisions[0]!.disposition).toBe('AUTO_RECOVER_VIA_RUNTIME');
    const afterFirst = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });

    // 第二次：授权已失效（可信事实变化）⇒ 当前计算结论为 BLOCK，但**不得覆盖**已登记快照
    const second = await createPrismaFaultTriageSweep({
      prisma,
      now: () => new Date('2026-10-09T08:00:00.000Z'),
      resolveTrustedFacts: async () => ({ ...TRUSTED, authorizationActive: false }),
    }).sweepOnce();
    expect(second.decisions[0]!.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(second.decisions[0]!.reason).toBe('AUTHORIZATION_NOT_ACTIVE');
    expect(second.registered).toBe(0);
    expect(second.alreadyRegistered).toBe(1);

    const afterSecond = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });
    expect(afterSecond.sourceRefs).toEqual(afterFirst.sourceRefs);
    const refs = afterSecond.sourceRefs as Record<string, unknown>;
    expect(refs.triageDecision).toBe('AUTO_RECOVER_VIA_RUNTIME'); // 旧决策未被新决策覆盖
    expect(refs.triageReason).toBe('HANDOFF_TO_EXISTING_RUNTIME');
    expect(refs.triagedAt).toBe(T0.toISOString()); // 时间戳不漂移
  });

  it('DB-S12 jsonb 合并不丢字段（CHANGE 2）：并发扫描后无关既有键仍完整', async () => {
    const id = await seed({ ...BASE, errorName: 'AdapterMappingError' });
    const extra = { unrelatedRefA: 'run:1', nested: { keep: true } };
    await prisma.$executeRaw`
      UPDATE "AutonomyIncident"
         SET "sourceRefs" = "sourceRefs" || ${JSON.stringify(extra)}::jsonb
       WHERE "id" = ${id}
    `;
    const make = (): ReturnType<typeof createPrismaFaultTriageSweep> =>
      createPrismaFaultTriageSweep({ prisma, now: () => T0, resolveTrustedFacts: async () => ({ ...TRUSTED }) });
    await Promise.all([make().sweepOnce(), make().sweepOnce(), make().sweepOnce(), make().sweepOnce()]);

    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });
    const refs = row.sourceRefs as Record<string, unknown>;
    expect(refs.unrelatedRefA).toBe('run:1');
    expect(refs.nested).toEqual({ keep: true });
    expect(refs.faultClass).toBe('PARSER_FAILURE'); // PHASE 1 原有键也未丢
    expect(refs.triageDecision).toBe('CODE_REPAIR_CANDIDATE');
  });

  /**
   * MSG-20261009-09 / CHANGE 1 —— GATE-5 负向验收（真实登记写入路径）。
   */
  it('DB-S9 恶意载荷：登记字段只写规范值，恶意自由文本不落库也不经返回值泄露', async () => {
    const id = await seed({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' });
    const secrets = [
      'sk-DUMMYKEY-9f8e7d6c5b4a3210',
      'buyer@example.test',
      '/etc/crossclaim/secrets/provider.key',
      'TOKEN=abcd1234efgh5678',
      '<img src=x onerror=alert(1)>',
    ];
    // 篡改「历史载荷」：把恶意文本塞进既有字段与一个未知键（**不修改历史保留策略**，只观察登记边界）
    await prisma.$executeRaw`
      UPDATE "AutonomyIncident"
         SET "sourceRefs" = "sourceRefs" || ${JSON.stringify({
           faultClass: secrets[0],
           operationKind: secrets[2],
           summary: secrets[1] + ' ' + secrets[4],
           attackerExtraKey: secrets[3],
         })}::jsonb
       WHERE "id" = ${id}
    `;

    const sweep = createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    });
    const result = await sweep.sweepOnce();

    // ① 结论本身不含任何注入文本
    const serialized = JSON.stringify(result);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(result.decisions[0]!.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(result.decisions[0]!.reason).toBe('PAYLOAD_VALUE_NOT_CANONICAL');

    // ② 登记字段只写规范值
    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { id } });
    const refs = row.sourceRefs as Record<string, unknown>;
    expect(String(refs.triageDecision)).toMatch(/^[A-Z_]+$/);
    expect(String(refs.triageReason)).toMatch(/^[A-Z_]+$/);
    expect(refs.triagedAt).toBe(T0.toISOString());
    for (const secret of secrets) {
      expect(String(refs.triageDecision)).not.toContain(secret);
      expect(String(refs.triageReason)).not.toContain(secret);
      expect(String(refs.triagedAt)).not.toContain(secret);
    }
    // ③ 历史载荷（含未知键）保持原样，未被登记流程改写
    expect(refs.attackerExtraKey).toBe(secrets[3]);
    expect(refs.summary).toBe(secrets[1] + ' ' + secrets[4]);

    // ④ 零执行
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-S10 历史载荷含敏感摘要时，扫描返回结果仍不夹带（登记边界不外泄）', async () => {
    const id = await seed({ ...BASE, errorName: 'AdapterMappingError' });
    await prisma.$executeRaw`
      UPDATE "AutonomyIncident"
         SET "sourceRefs" = "sourceRefs" || ${JSON.stringify({ summary: 'legacy residue token=abcd1234efgh5678' })}::jsonb
       WHERE "id" = ${id}
    `;
    const result = await createPrismaFaultTriageSweep({
      prisma,
      now: () => T0,
      resolveTrustedFacts: async () => ({ ...TRUSTED }),
    }).sweepOnce();
    expect(JSON.stringify(result)).not.toContain('abcd1234efgh5678');
    expect(result.decisions[0]!.disposition).toBe('CODE_REPAIR_CANDIDATE');
  });
});
