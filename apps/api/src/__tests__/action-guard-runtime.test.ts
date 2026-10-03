// ACTION GUARD runtime enforcement 单测（MSG-20260930-03 授权项 ②）：
// 覆盖 fail-closed、审计不可用降级、审批缺失、错误码稳定性、无旁路副作用（纯函数 + 注入端口）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ActionGuardApprovalRequiredError,
  ActionGuardDeniedError,
  createRuntimeActionGuard,
  type ActionGuardAuditRecord,
} from '../services/action-guard/runtime-guard';

// vitest 以 apps/api 为工作目录运行
const GUARD_SOURCE = join(process.cwd(), 'src', 'services', 'action-guard', 'runtime-guard.ts');

const ORG = 'b2a00000-0000-4000-8000-0000000000aa';
const ACTOR = 'b2b00000-0000-4000-8000-0000000000bb';

const satisfiedCaps = {
  tenantEnabled: true,
  writeEnabled: true,
  featureEnabled: { 'claim.submit': true },
  platformEnablement: { 'claim.submit': true },
  productionGate: 'SATISFIED' as const,
};

function recorder() {
  const events: ActionGuardAuditRecord[] = [];
  return {
    events,
    port: {
      write(record: ActionGuardAuditRecord) {
        events.push(record);
      },
    },
  };
}

describe('Action Guard runtime enforcement', () => {
  it('01 闸门全满足 + approvalId：ALLOW 且写入审计事件', async () => {
    const audit = recorder();
    const guard = createRuntimeActionGuard({
      capabilities: { resolve: async () => satisfiedCaps },
      audit: audit.port,
      now: () => '2026-09-30T00:00:00.000Z',
    });
    const result = await guard.assertAllowed({
      action: 'claim.submit',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'approval-1',
    });
    expect(result.decision).toBe('ALLOW');
    expect(result.code).toBe('ACTION_GUARD_ALLOWED');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: 'action_guard.evaluated',
      actionName: 'claim.submit',
      decision: 'ALLOW',
      actorUserId: ACTOR,
      organizationId: ORG,
      approvalId: 'approval-1',
      evaluatedAt: '2026-09-30T00:00:00.000Z',
    });
  });

  it('02 未知动作：DENY（不猜测、不放行）并写审计', async () => {
    const audit = recorder();
    const guard = createRuntimeActionGuard({ capabilities: { resolve: async () => satisfiedCaps }, audit: audit.port });
    await expect(
      guard.assertAllowed({ action: 'platform.delete_everything', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ name: 'ActionGuardDeniedError', code: 'ACTION_GUARD_UNKNOWN_ACTION' });
    expect(audit.events[0]?.decision).toBe('DENY');
    expect(audit.events[0]?.risk).toBe('UNKNOWN');
  });

  it('03 能力快照端口抛异常：fail closed → DENY / STATE_UNAVAILABLE', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: {
        resolve: async () => {
          throw new Error('flag service down');
        },
      },
      audit: recorder().port,
    });
    const error = await guard
      .assertAllowed({ action: 'claim.prepare', actorUserId: ACTOR, organizationId: ORG })
      .catch((e) => e as ActionGuardDeniedError);
    expect(error).toBeInstanceOf(ActionGuardDeniedError);
    expect(error.code).toBe('ACTION_GUARD_STATE_UNAVAILABLE');
  });

  it('04 能力快照缺失（undefined）：DENY / STATE_UNAVAILABLE', async () => {
    const guard = createRuntimeActionGuard({ capabilities: { resolve: async () => undefined }, audit: recorder().port });
    await expect(
      guard.assertAllowed({ action: 'evidence.read', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_STATE_UNAVAILABLE' });
  });

  it('05 审计写入失败：ALLOW 降级为 DENY / AUDIT_UNAVAILABLE（不可审计的动作不得执行）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: { resolve: async () => satisfiedCaps },
      audit: {
        write: async () => {
          throw new Error('audit sink down');
        },
      },
    });
    const error = (await guard
      .assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })
      .catch((e) => e)) as ActionGuardDeniedError;
    expect(error).toBeInstanceOf(ActionGuardDeniedError);
    expect(error.code).toBe('ACTION_GUARD_AUDIT_UNAVAILABLE');
  });

  it('06 未注入审计端口：ALLOW 同样降级为 DENY / AUDIT_UNAVAILABLE', async () => {
    const guard = createRuntimeActionGuard({ capabilities: { resolve: async () => satisfiedCaps } });
    await expect(
      guard.assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_AUDIT_UNAVAILABLE' });
  });

  it('07 高危动作缺写能力：DENY / REQUIREMENTS_NOT_MET（含具体原因）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: { resolve: async () => ({ ...satisfiedCaps, writeEnabled: false }) },
      audit: recorder().port,
    });
    const error = (await guard
      .assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' })
      .catch((e) => e)) as ActionGuardDeniedError;
    expect(error.code).toBe('ACTION_GUARD_REQUIREMENTS_NOT_MET');
    expect(error.reasons.join('|')).toContain('writeEnabled=false');
  });

  it('08 闸门满足但缺 approvalId：REQUIRE_APPROVAL 抛错，且审计记录该状态', async () => {
    const audit = recorder();
    const guard = createRuntimeActionGuard({ capabilities: { resolve: async () => satisfiedCaps }, audit: audit.port });
    const error = (await guard
      .assertAllowed({ action: 'claim.submit', actorUserId: ACTOR, organizationId: ORG })
      .catch((e) => e)) as ActionGuardApprovalRequiredError;
    expect(error).toBeInstanceOf(ActionGuardApprovalRequiredError);
    expect(error.code).toBe('ACTION_GUARD_HUMAN_APPROVAL_REQUIRED');
    expect(audit.events[0]?.decision).toBe('REQUIRE_APPROVAL');
    expect(audit.events[0]?.approvalId).toBeNull();
  });

  it('09 资金/密钥动作在未启用时一律拒绝（生产 HOLD 不变）', async () => {
    const guard = createRuntimeActionGuard({
      capabilities: {
        resolve: async () => ({ tenantEnabled: true, writeEnabled: false, featureEnabled: {}, productionGate: 'NOT_SATISFIED' }),
      },
      audit: recorder().port,
    });
    await expect(
      guard.assertAllowed({ action: 'commission.charge', actorUserId: ACTOR, organizationId: ORG, approvalId: 'a-1' }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
    await expect(
      guard.assertAllowed({ action: 'secret.rotate', actorUserId: ACTOR, organizationId: ORG }),
    ).rejects.toMatchObject({ code: 'ACTION_GUARD_REQUIREMENTS_NOT_MET' });
  });

  it('10 静态不变量：模块不读 env / 不写库 / 不发请求（无旁路副作用）', () => {
    const source = readFileSync(GUARD_SOURCE, 'utf8');
    for (const forbidden of ['process.env', 'PrismaClient', 'node:fs', 'from \'fs\'', 'fetch(', 'axios', 'http.request']) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });
});
