// ACTION GUARD v1（MSG-20260930-03）：默认 deny / fail closed / 审批边界 / 禁止真实外部写入

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const modulePath = path.join(__dirname, '..', 'services', 'action-guard', 'action-guard.ts');

let guard: Record<string, any>;

beforeAll(async () => {
  guard = (await import(pathToFileURL(modulePath).href)) as Record<string, any>;
});

const base = { actorUserId: 'u1', organizationId: 'o1' };
const allOn = {
  tenantEnabled: true,
  featureEnabled: new Proxy({}, { get: () => true }) as unknown as Record<string, boolean>,
  platformEnablement: new Proxy({}, { get: () => true }) as unknown as Record<string, boolean>,
  productionGate: 'SATISFIED' as const,
  writeEnabled: true,
  hostApprovalGranted: true,
};

describe('ACTION GUARD v1 — fail closed', () => {
  it('01 未知动作 → DENY（不猜测、不放行）', () => {
    const r = guard.evaluateActionGuard({ ...base, action: 'claim.unknown', capabilities: allOn });
    expect(r.decision).toBe('DENY');
    expect(r.code).toBe('ACTION_GUARD_UNKNOWN_ACTION');
    expect(r.risk).toBe('UNKNOWN');
  });

  it('02 能力状态缺失 → DENY（fail closed）', () => {
    const r = guard.evaluateActionGuard({ ...base, action: 'claim.submit' });
    expect(r.decision).toBe('DENY');
    expect(r.code).toBe('ACTION_GUARD_STATE_UNAVAILABLE');
  });

  it('03 高风险动作在默认配置（无 flag / 无 write）下全部 DENY', () => {
    for (const action of ['claim.submit', 'appeal.submit', 'platform.write', 'commission.charge', 'payment.capture']) {
      const r = guard.evaluateActionGuard({ ...base, action, capabilities: {} });
      expect(r.decision, action).toBe('DENY');
      expect(r.code, action).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    }
  });

  it('04 缺 approvalId → REQUIRE_APPROVAL（AI Prepare → Human Approve → Submit）', () => {
    const r = guard.evaluateActionGuard({ ...base, action: 'claim.submit', capabilities: allOn });
    expect(r.decision).toBe('REQUIRE_APPROVAL');
    expect(r.code).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
  });

  it('05 全部门闸 + approvalId 才 ALLOW（工程路径可验证，真实外部写入仍由 capability 决定）', () => {
    const r = guard.evaluateActionGuard({ ...base, action: 'claim.submit', capabilities: allOn, approvalId: 'a1' });
    expect(r.decision).toBe('ALLOW');
    expect(r.code).toBe('ACTION_GUARD_ALLOWED');
  });

  it('06 production gate 未满足 → DENY（不得绕过）', () => {
    const r = guard.evaluateActionGuard({
      ...base,
      action: 'claim.submit',
      capabilities: { ...allOn, productionGate: 'NOT_SATISFIED' },
      approvalId: 'a1',
    });
    expect(r.decision).toBe('DENY');
    expect(r.reasons.join(' ')).toContain('production gate');
  });

  it('07 只读动作无需写能力即可 ALLOW', () => {
    const r = guard.evaluateActionGuard({ ...base, action: 'evidence.read', capabilities: {} });
    expect(r.decision).toBe('ALLOW');
  });

  it('08 secret 轮换需 HOST APPROVAL，否则 DENY', () => {
    const denied = guard.evaluateActionGuard({
      ...base,
      action: 'secret.rotate',
      capabilities: { ...allOn, hostApprovalGranted: false },
    });
    expect(denied.decision).toBe('DENY');
    expect(denied.reasons.join(' ')).toContain('HOST APPROVAL');
  });

  it('09 审计事件字段白名单：只含允许字段，且拒绝 payload 类字段', () => {
    const result = guard.evaluateActionGuard({ ...base, action: 'claim.prepare', capabilities: allOn });
    const event = guard.buildActionGuardAuditEvent(result, { ...base, action: 'claim.prepare' });
    expect(Object.keys(event).sort()).toEqual(
      ['action', 'actionName', 'actorUserId', 'approvalId', 'code', 'decision', 'organizationId', 'reasonCodes', 'risk'].sort(),
    );
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('10 决策枚举与风险分类冻结', () => {
    expect(guard.ACTION_GUARD_DECISIONS).toEqual(['ALLOW', 'DENY', 'REQUIRE_APPROVAL']);
    expect(guard.ACTION_RISK_CLASSES).toEqual([
      'READ_ONLY',
      'INTERNAL_WRITE',
      'EXTERNAL_WRITE',
      'MONEY_MOVEMENT',
      'SECRET_ACCESS',
    ]);
  });
});
