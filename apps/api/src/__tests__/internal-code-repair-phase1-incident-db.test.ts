/**
 * INTERNAL CODE REPAIR V1 / PHASE 1 —— 故障 Incident 持久化（真实 PostgreSQL 验收）
 * ---------------------------------------------------------------
 * 真实验收：
 *   · 同因多次故障 ⇒ **1 行** Incident + occurrenceCount 精确聚合（真实 PG 原子 UPDATE）；
 *   · 并发（**≥20 路同时**，MSG-20261009-07 CHANGE 1 要求） ⇒ 仍然 **1 行**、计数无丢失、
 *     且**恰好一次**被判定为「新建」（数据库级原子 upsert：唯一约束 + 冲突分支前置条件）；
 *   · 混合创建/更新并发 ⇒ 新键各建一行、旧键仅聚合，互不串扰；
 *   · 终态 / 外来容器在**并发**下也不被写（WHERE 前置条件 ⇒ 0 行，只读定位原因）；
 *   · 容器隔离 ⇒ 同 dedupeKey 已被别人（`CUSTOMER_GOAL_QUEUE`）占用时**拒绝写入**，绝不劫持；
 *   · 终态不复活 ⇒ CLOSED 后不静默重开、计数不涨（fail-closed 交回调用方）；
 *   · 权限隔离 ⇒ 修复平面 Incident 下的任务**无法被客户执行面领取**（持久化 BLOCKED、零租约）。
 * 无任何 mock：真实 PrismaClient + 真实 durable 任务源。
 */

import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CLAIM_AUTHORIZATION_DENY,
  CUSTOMER_GOAL_QUEUE_INCIDENT_KIND,
  RECOVERY_QUEUE_TASK_PREFIX,
  createAutonomyTaskSource,
} from '../runtime/rsi-durable-task-source';
import {
  buildFaultIncidentIntent,
  faultOrganizationRef,
  faultProviderRef,
  INTERNAL_FAULT_INCIDENT_KIND,
  type FaultObservation,
} from '../services/self-repair/fault-classification';
import { createPrismaFaultIncidentIntake } from '../services/self-repair/fault-incident-intake';

import { testDatabaseMarker } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const T0 = new Date('2026-10-09T02:30:00.000Z');
const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

const faultObservation = (overrides: Partial<FaultObservation> = {}): FaultObservation => ({
  sourceModule: 'services/adapters',
  environment: 'TEST',
  errorName: 'AdapterMappingError',
  organizationRef: 'org-self-repair',
  providerRef: 'AMAZON',
  domain: 'LOGISTICS',
  ...overrides,
});

const dedupeKeyOf = (observation: FaultObservation): string =>
  buildFaultIncidentIntent(observation, { now: T0 }).intent.dedupeKey;

const refsOf = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;

async function truncateAutonomy(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AutonomyLease", "AutonomyTask", "AutonomyIncident" RESTART IDENTITY CASCADE;',
  );
}

const intake = (): ReturnType<typeof createPrismaFaultIncidentIntake> =>
  createPrismaFaultIncidentIntake({ prisma, now: () => T0 });

beforeEach(truncateAutonomy);
afterAll(async () => {
  await prisma.$disconnect();
});

describe(`PHASE 1 故障 Incident 持久化（真实 PG：${testDatabaseMarker()}）`, () => {
  it('DB-P1 同因聚合：两次故障 ⇒ 1 行、occurrenceCount=2、状态 DIAGNOSED', async () => {
    const observation = faultObservation();
    const dedupeKey = dedupeKeyOf(observation);

    const first = await intake().record(observation);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first record to be accepted');
    expect(first.created).toBe(true);
    expect(first.occurrenceCount).toBe(1);
    expect(first.status).toBe('DIAGNOSED');

    const second = await intake().record(observation);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected second record to be accepted');
    expect(second.created).toBe(false);
    expect(second.occurrenceCount).toBe(2);
    expect(second.incidentId).toBe(first.incidentId);

    const rows = await prisma.autonomyIncident.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(INTERNAL_FAULT_INCIDENT_KIND);
    expect(rows[0]!.status).toBe('DIAGNOSED');
    expect(rows[0]!.riskClass).toBe(first.diagnosis.riskClass);
    expect(rows[0]!.detectedAt.toISOString()).toBe(T0.toISOString());
    expect(refsOf(rows[0]!.sourceRefs).occurrenceCount).toBe(2);

    // 修复平面 Incident 不派生任何任务 / 租约
    expect(await prisma.autonomyTask.count({ where: { incidentId: first.incidentId } })).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-P2 并发安全（CHANGE 1）：20 路同时记录同一故障 ⇒ 仍然 1 行、计数精确为 20、恰好一次新建', async () => {
    const observation = faultObservation({ errorName: 'TypeError', message: 'undefined is not a function' });
    const dedupeKey = dedupeKeyOf(observation);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => intake().record(observation)),
    );
    // 20 路全部被接纳（不得因唯一约束冲突/重试预算耗尽而丢接纳）
    expect(results.filter((result) => result.ok).length).toBe(20);
    // 恰好一次「新建」赢家（其余全是聚合）
    expect(results.filter((result) => result.ok && result.created).length).toBe(1);
    const incidentIds = new Set(results.filter((r) => r.ok).map((r) => (r.ok ? r.incidentId : '')));
    expect(incidentIds.size).toBe(1);

    const rows = await prisma.autonomyIncident.findMany({ where: { dedupeKey } });
    expect(rows).toHaveLength(1);
    expect(refsOf(rows[0]!.sourceRefs).occurrenceCount).toBe(20);
    expect(rows[0]!.status).toBe('DIAGNOSED');
    expect(rows[0]!.kind).toBe(INTERNAL_FAULT_INCIDENT_KIND);
    expect(await prisma.autonomyTask.count()).toBe(0);
    expect(await prisma.autonomyLease.count()).toBe(0);
  });

  it('DB-P7 混合创建/更新并发（CHANGE 1）：旧键只聚合、新键各建一行，互不串扰', async () => {
    const known = faultObservation({ errorName: 'AdapterMappingError', message: 'legacy key' });
    const fresh = faultObservation({ errorName: 'TypeError', message: 'fresh key' });
    const knownKey = dedupeKeyOf(known);
    const freshKey = dedupeKeyOf(fresh);
    expect(knownKey).not.toBe(freshKey);

    const seeded = await intake().record(known);
    expect(seeded.ok).toBe(true);

    const results = await Promise.all([
      ...Array.from({ length: 12 }, () => intake().record(known)),
      ...Array.from({ length: 8 }, () => intake().record(fresh)),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(20);
    // 旧键：没有任何一次被判为新建；新键：恰好一次新建
    expect(results.filter((r) => r.ok && r.created).map((r) => (r.ok ? r.incidentId : '')).length).toBe(1);

    const knownRow = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey: knownKey } });
    const freshRow = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey: freshKey } });
    expect(refsOf(knownRow.sourceRefs).occurrenceCount).toBe(13); // 1（种子）+ 12
    expect(refsOf(freshRow.sourceRefs).occurrenceCount).toBe(8);
    expect(await prisma.autonomyIncident.count()).toBe(2);
    // 诊断载荷按各自故障归档（未串写）
    expect(refsOf(knownRow.sourceRefs).faultClass).toBe('PARSER_FAILURE');
    expect(refsOf(freshRow.sourceRefs).faultClass).toBe('RUNTIME_EXCEPTION');
  });

  it('DB-P8 终态保护并发（CHANGE 1）：CLOSED 后 10 路并发 ⇒ 全部拒绝、状态与计数不变', async () => {
    const observation = faultObservation();
    const dedupeKey = dedupeKeyOf(observation);
    const accepted = await intake().record(observation);
    expect(accepted.ok).toBe(true);
    await prisma.autonomyIncident.update({ where: { dedupeKey }, data: { status: 'CLOSED' } });

    const results = await Promise.all(Array.from({ length: 10 }, () => intake().record(observation)));
    expect(results.filter((r) => r.ok).length).toBe(0);
    expect(results.every((r) => !r.ok && r.reason === 'INCIDENT_NOT_OPEN')).toBe(true);

    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey } });
    expect(row.status).toBe('CLOSED');
    expect(refsOf(row.sourceRefs).occurrenceCount).toBe(1); // 未被复活、未被加计数
    expect(await prisma.autonomyIncident.count()).toBe(1); // 也未另建新行
  });

  it('DB-P9 外来容器并发（CHANGE 1）：客户执行面占位时 10 路并发全部 KIND_MISMATCH 且不改动该行', async () => {
    const observation = faultObservation();
    const dedupeKey = dedupeKeyOf(observation);
    const foreignRefs = [{ organizationId: 'org-customer-2' }];
    const foreign = await prisma.autonomyIncident.create({
      data: {
        kind: CUSTOMER_GOAL_QUEUE_INCIDENT_KIND,
        dedupeKey,
        status: 'OPEN',
        riskClass: 'LOW',
        sourceRefs: foreignRefs,
        detectedAt: T0,
      },
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => intake().record(observation)));
    expect(results.filter((r) => r.ok).length).toBe(0);
    expect(results.every((r) => !r.ok && r.reason === 'KIND_MISMATCH')).toBe(true);

    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey } });
    expect(row.id).toBe(foreign.id);
    expect(row.kind).toBe(CUSTOMER_GOAL_QUEUE_INCIDENT_KIND);
    expect(row.status).toBe('OPEN');
    expect(row.riskClass).toBe('LOW');
    expect(row.sourceRefs).toEqual(foreignRefs);
  });

  it('DB-P3 容器隔离：同名 dedupeKey 已被客户执行面占用 ⇒ 拒绝写入（不劫持、不改动）', async () => {
    const observation = faultObservation();
    const dedupeKey = dedupeKeyOf(observation);
    const foreignRefs = [{ organizationId: 'org-customer' }];
    await prisma.autonomyIncident.create({
      data: {
        kind: CUSTOMER_GOAL_QUEUE_INCIDENT_KIND,
        dedupeKey,
        status: 'OPEN',
        riskClass: 'LOW',
        sourceRefs: foreignRefs,
        detectedAt: T0,
      },
    });

    const result = await intake().record(observation);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected kind mismatch rejection');
    expect(result.reason).toBe('KIND_MISMATCH');

    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey } });
    expect(row.kind).toBe(CUSTOMER_GOAL_QUEUE_INCIDENT_KIND);
    expect(row.status).toBe('OPEN');
    expect(row.sourceRefs).toEqual(foreignRefs);
  });

  it('DB-P4 终态不复活：CLOSED 后再次发生同一故障 ⇒ 拒绝且不涨计数', async () => {
    const observation = faultObservation();
    const dedupeKey = dedupeKeyOf(observation);
    const accepted = await intake().record(observation);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('expected acceptance');

    await prisma.autonomyIncident.update({ where: { dedupeKey }, data: { status: 'CLOSED' } });

    const rejected = await intake().record(observation);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('expected terminal rejection');
    expect(rejected.reason).toBe('INCIDENT_NOT_OPEN');
    expect(rejected.status).toBe('CLOSED');
    expect(rejected.incidentId).toBe(accepted.incidentId);

    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey } });
    expect(row.status).toBe('CLOSED');
    expect(refsOf(row.sourceRefs).occurrenceCount).toBe(1);
  });

  it('DB-P5 权限隔离：修复平面 Incident 下的任务无法被客户执行面领取（BLOCKED、零租约、零执行）', async () => {
    const observation = faultObservation();
    const recorded = await intake().record(observation);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error('expected acceptance');

    const taskDedupeKey = `${RECOVERY_QUEUE_TASK_PREFIX}INTERNAL_REPAIR_MUST_NOT_EXECUTE:${suffix()}`;
    const task = await prisma.autonomyTask.create({
      data: {
        incidentId: recorded.incidentId,
        status: 'READY',
        riskClass: 'LOW',
        ownerGateRequired: false,
        dedupeKey: taskDedupeKey,
      },
    });

    const source = createAutonomyTaskSource({ prisma, ownerRef: 'self-repair-plane', now: () => T0 });
    const claimed = await source.claim(5);
    expect(claimed).toHaveLength(0);

    const after = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('BLOCKED');
    expect(after.lastErrorCode).toBe(CLAIM_AUTHORIZATION_DENY.UNTRUSTED_INCIDENT_KIND);
    expect(await prisma.autonomyLease.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('DB-P6 落库脱敏：原始组织 id 与密钥形状文本不出现在持久化载荷中', async () => {
    const observation = faultObservation({
      environment: 'PRODUCTION',
      organizationRef: 'org-raw-tenant-uuid',
      message: 'upstream rejected Bearer sk-live-9f8e7d6c5b4a3210',
    });
    const dedupeKey = dedupeKeyOf(observation);
    const recorded = await intake().record(observation);
    expect(recorded.ok).toBe(true);

    const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey } });
    const serialized = JSON.stringify(row.sourceRefs);
    expect(serialized).not.toContain('org-raw-tenant-uuid');
    expect(serialized).not.toContain('sk-live-9f8e7d6c5b4a3210');
    expect(refsOf(row.sourceRefs).organizationRef).toMatch(/^org-[0-9a-f]{16}$/);
    expect(String(refsOf(row.sourceRefs).summary)).toContain('[redacted');
  });

  it('DB-P10 生命周期矩阵（CHANGE 3）：OPEN 聚合并转 DIAGNOSED；CLOSED/REJECTED/TASKED 一律拒绝', async () => {
    const observation = faultObservation({ message: 'lifecycle matrix' });
    const dedupeKey = dedupeKeyOf(observation);
    const { intent } = buildFaultIncidentIntent(observation, { now: T0 });
    // 手工种一条 OPEN（计数 5），模拟"先建后诊断"的既有行
    await prisma.autonomyIncident.create({
      data: {
        kind: INTERNAL_FAULT_INCIDENT_KIND,
        dedupeKey,
        status: 'OPEN',
        riskClass: intent.riskClass,
        sourceRefs: { ...intent.sourceRefs, occurrenceCount: 5 } as unknown as Prisma.InputJsonValue,
        detectedAt: T0,
      },
    });

    const opened = await intake().record(observation);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('expected OPEN incident to be aggregated');
    expect(opened.created).toBe(false);
    expect(opened.occurrenceCount).toBe(6);
    expect(opened.status).toBe('DIAGNOSED'); // OPEN → DIAGNOSED（既有合法跃迁）

    for (const terminal of ['CLOSED', 'REJECTED', 'TASKED']) {
      await prisma.autonomyIncident.update({ where: { dedupeKey }, data: { status: terminal } });
      const rejected = await intake().record(observation);
      expect(rejected.ok).toBe(false);
      if (rejected.ok) throw new Error('expected terminal incident to reject');
      expect(rejected.reason).toBe('INCIDENT_NOT_OPEN');
      const row = await prisma.autonomyIncident.findUniqueOrThrow({ where: { dedupeKey } });
      expect(row.status).toBe(terminal);
      expect(refsOf(row.sourceRefs).occurrenceCount).toBe(6); // 终态不被加计数、不被复活
    }

    // 回到 DIAGNOSED 仍可继续聚合
    await prisma.autonomyIncident.update({ where: { dedupeKey }, data: { status: 'DIAGNOSED' } });
    const again = await intake().record(observation);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('expected DIAGNOSED incident to aggregate');
    expect(again.occurrenceCount).toBe(7);
  });

  it('DB-P11 跨租户隔离（CHANGE 3）：同签名不同组织 ⇒ 2 行、互不可见', async () => {
    const base = faultObservation({ message: 'tenant scoped fault', providerRef: 'AMAZON' });
    const tenantA = { ...base, organizationRef: 'org-tenant-a' };
    const tenantB = { ...base, organizationRef: 'org-tenant-b' };
    const keyA = dedupeKeyOf(tenantA);
    const keyB = dedupeKeyOf(tenantB);
    expect(keyA).not.toBe(keyB);

    expect((await intake().record(tenantA)).ok).toBe(true);
    expect((await intake().record(tenantB)).ok).toBe(true);
    // 全局（无租户）故障：既不与租户故障合并，也不出现在任何租户视图里
    const globalFault = { ...base, organizationRef: null };
    expect((await intake().record(globalFault)).ok).toBe(true);

    expect(await prisma.autonomyIncident.count()).toBe(3);
    const viewA = await intake().listForOrganization({ organizationId: 'org-tenant-a' });
    const viewB = await intake().listForOrganization({ organizationId: 'org-tenant-b' });
    expect(viewA.map((row) => row.dedupeKey)).toEqual([keyA]);
    expect(viewB.map((row) => row.dedupeKey)).toEqual([keyB]);
    // 租户视图里不得出现其它租户，也不得出现 global 故障
    expect(viewA.map((row) => row.dedupeKey)).not.toContain(keyB);
    expect(viewA.map((row) => row.dedupeKey)).not.toContain(dedupeKeyOf(globalFault));
    // 视图字段是脱敏后的摘要，不含原始组织 id
    expect(JSON.stringify(viewA)).not.toContain('org-tenant-a');
    expect(viewA[0]!.faultClass).toBe('PARSER_FAILURE');
  });

  it('DB-P12 哈希不是授权（CHANGE 3）：拿哈希当租户 id 查不到任何行；空租户上下文 fail-closed', async () => {
    const tenant = faultObservation({ message: 'hash is not authorization' });
    expect((await intake().record(tenant)).ok).toBe(true);
    expect(await intake().listForOrganization({ organizationId: 'org-self-repair' })).toHaveLength(1);

    // 用「不可逆引用本身」冒充租户 id ⇒ 会推导出另一个引用 ⇒ 什么都查不到
    const asHash = await intake().listForOrganization({
      organizationId: faultOrganizationRef('org-self-repair'),
    });
    expect(asHash).toHaveLength(0);
    // 空 / 缺失租户上下文 ⇒ 不返回任何行（不是"返回全部"）
    expect(await intake().listForOrganization({ organizationId: '   ' })).toHaveLength(0);
  });

  it('DB-P13 Provider 参与身份（CHANGE 3）：同组织跨 Provider ⇒ 2 行，各自带自己的 Provider 引用', async () => {
    const base = faultObservation({ message: 'provider identity', organizationRef: 'org-provider-scope' });
    const amazon = { ...base, providerRef: 'AMAZON' };
    const dhl = { ...base, providerRef: 'DHL' };
    expect(dedupeKeyOf(amazon)).not.toBe(dedupeKeyOf(dhl));

    expect((await intake().record(amazon)).ok).toBe(true);
    expect((await intake().record(dhl)).ok).toBe(true);
    const rows = await prisma.autonomyIncident.findMany({ orderBy: { dedupeKey: 'asc' } });
    expect(rows).toHaveLength(2);
    const refs = rows.map((row) => refsOf(row.sourceRefs).providerRef);
    expect(new Set(refs)).toEqual(new Set([faultProviderRef('AMAZON'), faultProviderRef('DHL')]));
    // 两行都属于同一组织（身份只在 Provider 维度分流）
    expect(new Set(rows.map((row) => refsOf(row.sourceRefs).organizationRef))).toEqual(
      new Set([faultOrganizationRef('org-provider-scope')]),
    );
    expect(await intake().listForOrganization({ organizationId: 'org-provider-scope' })).toHaveLength(2);
  });

  it('DB-P14 同名键 / 伪造型 sourceRefs 不产生执行权限（CHANGE 3）', async () => {
    const organizationId = 'org-forge-' + suffix();
    await prisma.organization.upsert({
      where: { id: organizationId },
      create: { id: organizationId, name: organizationId, slug: organizationId },
      update: {},
    });
    await prisma.standingAuthorization.deleteMany({ where: { organizationId } });
    await prisma.standingAuthorization.create({
      data: {
        organizationId,
        platformAccountId: 'acct-forge',
        provider: 'AMAZON',
        allowedActionTypes: ['recovery.read'],
        monetaryLimitUsd: '0',
        currency: 'USD',
        domain: 'LOGISTICS',
        jurisdiction: 'US',
        effectiveAt: new Date('2026-10-08T00:00:00.000Z'),
        expiresAt: new Date('2026-11-08T00:00:00.000Z'),
        authorizationVersion: 1,
        termsPolicyVersion: 'v1',
        consentEvidenceRef: 'evidence://forge-seed',
        scopeDigest: 'b'.repeat(64),
        revocationState: 'ACTIVE',
        createdAt: T0,
      },
    });

    /**
     * 伪造最优条件：kind 仍是 INTERNAL_FAULT，但 dedupeKey 用客户任务前缀形状、
     * sourceRefs 用**客户容器形状**（数组 + organizationId）、且该组织确有 ACTIVE 长期授权。
     * 预期：既有 claim() 仍以 kind 为准拒绝（结构隔离），不产生任何执行权限。
     */
    const incident = await prisma.autonomyIncident.create({
      data: {
        kind: INTERNAL_FAULT_INCIDENT_KIND,
        dedupeKey: `${RECOVERY_QUEUE_TASK_PREFIX}FORGED:${suffix()}`,
        status: 'DIAGNOSED',
        riskClass: 'LOW',
        sourceRefs: [{ organizationId }],
        detectedAt: T0,
      },
    });
    const task = await prisma.autonomyTask.create({
      data: {
        incidentId: incident.id,
        status: 'READY',
        riskClass: 'LOW',
        ownerGateRequired: false,
        dedupeKey: `${RECOVERY_QUEUE_TASK_PREFIX}FORGED-TASK:${suffix()}`,
      },
    });

    const claimed = await createAutonomyTaskSource({ prisma, ownerRef: 'self-repair-plane', now: () => T0 }).claim(5);
    expect(claimed).toHaveLength(0);
    const after = await prisma.autonomyTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('BLOCKED');
    expect(after.lastErrorCode).toBe(CLAIM_AUTHORIZATION_DENY.UNTRUSTED_INCIDENT_KIND);
    expect(await prisma.autonomyLease.count({ where: { taskId: task.id } })).toBe(0);
    // 修复平面自己的读取也只认自己的形状（数组式 sourceRefs 不会被当成本租户的故障）
    expect(await intake().listForOrganization({ organizationId })).toHaveLength(0);
  });
});
