// 控制面 × 真实 Kill Switch × 真实审计落地（PostgreSQL 集成；授权项 ③「补真实配置、有效 Kill Switch 与审计依赖的组合入口」）
// 纪律：只读/写入都基于合成数据；不触碰真实平台；被拒与放行分别断言审计落地。

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createKillSwitchReadPort } from '../services/action-guard/kill-switch-adapter';
import { createWiredControlPlane } from '../services/action-guard/control-plane-wiring';
import { projectControlPlaneStatus } from '../services/action-guard/control-plane-status';
import { ACTION_GUARD_CATALOG } from '../services/action-guard/action-guard';
import type { ActionGuardAuditRecord } from '../services/action-guard/runtime-guard';
import type { ControlPlaneConfig } from '../services/action-guard/control-plane';
import { createEffectiveKillSwitchResolver } from '../services/operations/kill-switch-resolver';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000e1';
const ACTOR = 'cf000000-0000-4000-8000-0000000000e2';

const READ_ONLY: ControlPlaneConfig = { globalDisabled: false, mode: 'READ_ONLY' };
const WRITE_ENABLED: ControlPlaneConfig = {
  globalDisabled: false,
  mode: 'WRITE_ENABLED',
  platformEnabled: { 'claim.submit': true },
  tenantFeatureEnabled: { 'claim.submit': true },
  hostApprovalGranted: true,
};

let currentConfig: ControlPlaneConfig | Error = READ_ONLY;
let configReadCount = 0;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  currentConfig = READ_ONLY;
  configReadCount = 0;
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "KillSwitchRequest", "AuditLog", "Organization" CASCADE;');
  await prisma.organization.create({ data: { id: ORG, name: '控制面接线租户', slug: 'cp-wiring-org' } });
});

/** 真实 resolver + 真实审计落地（每条评估写一行 AuditLog，actorType=AI） */
function wiredPlane() {
  const resolver = createEffectiveKillSwitchResolver({
    controlRequests: { findMany: (args) => prisma.killSwitchRequest.findMany(args) },
  });
  return createWiredControlPlane({
    killSwitch: createKillSwitchReadPort(resolver),
    audit: {
      async write(record: ActionGuardAuditRecord) {
        await prisma.auditLog.create({
          data: {
            id: randomUUID(),
            organizationId: record.organizationId,
            actorType: 'AI',
            // cc_audit_actor_shape_check：非 USER 角色必须 actorUserId IS NULL 且 actorRef IS NOT NULL
            actorRef: 'action-guard-runtime/v1',
            action: record.action,
            entityType: 'ActionGuardDecision',
            changes: {
              actionName: record.actionName,
              decision: record.decision,
              code: record.code,
              risk: record.risk,
              reasonCodes: record.reasonCodes,
              evaluatedAt: record.evaluatedAt,
            } as never,
            createdAt: new Date(),
          },
        });
      },
    },
    config: {
      read: () => {
        configReadCount += 1;
        if (currentConfig instanceof Error) throw currentConfig;
        return currentConfig;
      },
    },
  });
}

async function enableSubmission(organizationId: string) {
  await prisma.killSwitchRequest.create({
    data: {
      id: randomUUID(),
      organizationId,
      scope: 'submission',
      target: 'ENABLED',
      state: 'APPLIED',
      reasonCode: 'TESTING',
      requestedBy: 'host-test',
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      confirmedBy: 'host-test-2',
      confirmedAt: new Date(),
      appliedAt: new Date(),
      idempotencyKey: 'cp-wiring-' + randomUUID(),
      createdAt: new Date(),
    },
  });
}

function auditRows() {
  return prisma.auditLog.findMany({ where: { organizationId: ORG, action: 'action_guard.evaluated' } });
}

describe('Control plane × real Kill Switch × real audit sink', () => {
  it('01 默认姿态：READ_ONLY + Kill Switch 默认 disabled → 外部写入 DENY，且审计落地一行', async () => {
    const plane = wiredPlane();
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe('AI');
    expect((rows[0].changes as { decision?: string }).decision).toBe('DENY');
  });

  it('02 真实 Kill Switch 打开 submission（APPLIED）+ WRITE_ENABLED + 平台/租户 enablement → ALLOW 且审计落地 ALLOW', async () => {
    await enableSubmission(ORG);
    currentConfig = WRITE_ENABLED;
    const plane = wiredPlane();

    const result = await plane.guard.assertAllowed({
      action: 'claim.submit',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'a-1',
    });
    expect(result.decision).toBe('ALLOW');

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect((rows[0].changes as { decision?: string; actionName?: string }).decision).toBe('ALLOW');
    expect((rows[0].changes as { actionName?: string }).actionName).toBe('claim.submit');
  });

  it('03 Kill Switch 未开启的 scope 仍然拒绝（platform.write → platform_connector 默认 disabled）', async () => {
    await enableSubmission(ORG);
    currentConfig = { ...WRITE_ENABLED, platformEnabled: { 'platform.write': true }, tenantFeatureEnabled: { 'platform.write': true } };
    const plane = wiredPlane();
    await expect(
      plane.guard.assertAllowed({ action: 'platform.write', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('04 配置源异常 → 回落 READ_ONLY（即使 Kill Switch 已开启也拒绝，且不沿用上次配置）', async () => {
    await enableSubmission(ORG);
    currentConfig = WRITE_ENABLED;
    const plane = wiredPlane();
    expect((await plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })).decision).toBe('ALLOW');

    currentConfig = new Error('config source down');
    await expect(
      plane.guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    expect((await plane.currentConfig()).mode).toBe('READ_ONLY');
  });

  it('05 只读状态投影：覆盖全部目录动作、零审计事件、真实 Kill Switch 生效值参与判定', async () => {
    await enableSubmission(ORG);
    currentConfig = WRITE_ENABLED;
    const plane = wiredPlane();

    const status = await projectControlPlaneStatus({ plane, organizationId: ORG });
    expect(status.rows.map((r) => r.action)).toEqual(Object.keys(ACTION_GUARD_CATALOG).sort());
    expect(status.mode).toBe('WRITE_ENABLED');
    const claimSubmit = status.rows.find((r) => r.action === 'claim.submit');
    expect(claimSubmit?.decision).toBe('REQUIRE_APPROVAL'); // 投影不携带 approvalId，不冒充放行
    expect(await auditRows()).toHaveLength(0); // 投影不写审计
  });
});
