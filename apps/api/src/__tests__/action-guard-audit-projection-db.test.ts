// CHANGE D：真实 Prisma 落库投影 —— 审批核验记录含 approvalId / 执行主体 / 目标 / operationId（真实 PostgreSQL）

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPrismaActionGuardAuditPort } from '../services/action-guard/runtime-guard-composition';

const prisma = new PrismaClient();
const ORG = 'cf000000-0000-4000-8000-0000000000e1';
const ACTOR = 'cf000000-0000-4000-8000-0000000000e2';
const TARGET = 'cf000000-0000-4000-8000-0000000000e3';

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog", "Membership", "User", "Organization" CASCADE;');
  await prisma.organization.create({ data: { id: ORG, name: '审计投影 租户', slug: 'audit-projection-org' } });
  await prisma.user.create({ data: { id: ACTOR, email: 'audit-projection@example.com', displayName: 'ACTOR', status: 'ACTIVE', emailVerified: true } });
  await prisma.membership.create({ data: { id: randomUUID(), organizationId: ORG, userId: ACTOR, role: 'OWNER', isActive: true } });
});

describe('Action guard audit projection（真实 Prisma）', () => {
  it('01 审批核验记录结构化落库：approvalId / operationId / target / actor / reason', async () => {
    const port = createPrismaActionGuardAuditPort(prisma);
    await port.write({
      action: 'action_guard.approval_decision',
      actionName: 'commission.charge',
      decision: 'ALLOW',
      code: 'ACTION_GUARD_APPROVAL_VERIFIED',
      risk: 'EXTERNAL_WRITE',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'appr-1',
      reasonCodes: [],
      targetRef: TARGET,
      operationId: 'approval:appr-1',
      reason: null,
      evaluatedAt: new Date().toISOString(),
    });

    const row = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: ORG, action: 'action_guard.approval_decision' } });
    expect(row.actorType).toBe('AI');
    expect(row.actorRef).toBeTruthy();
    expect(row.entityType).toBe('ActionGuardTarget');
    expect(row.entityId).toBe(TARGET);
    const changes = row.changes as Record<string, unknown>;
    expect(changes.approvalId).toBe('appr-1');
    // R3：执行主体落库（结构化字段）
    expect(changes.actorUserId).toBe(ACTOR);
    expect(changes.operationId).toBe('approval:appr-1');
    expect(changes.actionName).toBe('commission.charge');
    expect(changes.risk).toBe('EXTERNAL_WRITE');
    // 目标/操作 ID 不再混入 reasonCodes
    expect(changes.reasonCodes).toEqual([]);
  });

  it('02 拒绝记录同样结构化落库（reason 独立字段）', async () => {
    const port = createPrismaActionGuardAuditPort(prisma);
    await port.write({
      action: 'action_guard.approval_decision',
      actionName: 'commission.charge',
      decision: 'DENY',
      code: 'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
      risk: 'EXTERNAL_WRITE',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'appr-2',
      reasonCodes: ['APPROVAL_EXPIRED'],
      targetRef: TARGET,
      operationId: 'approval:appr-2',
      reason: 'APPROVAL_EXPIRED',
      evaluatedAt: new Date().toISOString(),
    });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'action_guard.approval_decision' } });
    const changes = row.changes as Record<string, unknown>;
    expect(changes.decision).toBe('DENY');
    expect(changes.reason).toBe('APPROVAL_EXPIRED');
    expect(changes.reasonCodes).toEqual(['APPROVAL_EXPIRED']);
  });
});
