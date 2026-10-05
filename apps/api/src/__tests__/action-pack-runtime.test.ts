/**
 * PHASE 3 U5/U6 + FINAL —— Action Pack 执行运行时：共享 Action Guard 授权链 + HITL + external-write HOLD +
 * trusted sandbox provenance + exactly-once（key + fingerprint）+ audit/evidence
 * 边界：真实外写 / 真实凭据 / 网络 = HOLD；允许路径只走 factory 创建的 sandbox mock adapter。
 */

import { describe, expect, it } from 'vitest';

import { GUARD_ENFORCED_ACTIONS } from '../services/action-guard/guard-enforcement';
import { createRuntimeActionGuard } from '../services/action-guard/runtime-guard';
import {
  ACTION_PACK_RUNTIME_BOUNDARY,
  EXTERNAL_WRITE_ACTIONS,
  decideHitlRequirement,
  isExternalWriteAction,
  runActionPack,
  type ActionPackOutcome,
} from '../services/action-runtime/action-pack-runtime';
import {
  createMockProviderAdapter,
  isTrustedSandboxProviderAdapter,
  scanCredentialFields,
  type ProviderAdapter,
  type ProviderInvokeRequest,
} from '../services/action-runtime/provider-adapter-contract';
import {
  createInMemoryIdempotencyStore,
  type ProviderCredentialPort,
} from '../services/action-runtime/provider-execution-guard';

const GUARD_CAPS = {
  tenantEnabled: true,
  writeEnabled: true,
  featureEnabled: Object.fromEntries(GUARD_ENFORCED_ACTIONS.map((a) => [a, true])),
  platformEnablement: Object.fromEntries(GUARD_ENFORCED_ACTIONS.map((a) => [a, true])),
  productionGate: 'SATISFIED' as const,
  hostApprovalGranted: true,
};

/** 真实共享 Action Guard（非 stub）：全部能力满足 → 走 ALLOW 分支 */
const guardAllow = () =>
  createRuntimeActionGuard({
    capabilities: { resolve: async () => GUARD_CAPS },
    audit: { write: () => {} },
  });

const request = (over: Partial<ProviderInvokeRequest> = {}): ProviderInvokeRequest => ({
  idempotencyKey: 'idem-1',
  action: 'evidence.read',
  organizationId: 'org-1',
  payloadRef: 'recovery-basis:1',
  payloadDigest: 'a'.repeat(64),
  ...over,
});

const counting = () => {
  let n = 0;
  return {
    get count() {
      return n;
    },
    bump: () => {
      n += 1;
    },
  };
};

const opaquePort = (ref: string | null, over: { providerName?: string; organizationId?: string } = {}): ProviderCredentialPort => ({
  async resolveRef() {
    return ref === null
      ? null
      : {
          credentialRef: ref,
          providerName: over.providerName ?? 'real-ish',
          organizationId: over.organizationId ?? 'org-1',
        };
  },
});

const verifier = (valid: boolean) => ({
  async verify() {
    return valid ? { valid: true } : { valid: false, reason: 'APPROVAL_NOT_FOUND' as const };
  },
});

const scannable = (evidence: object): Record<string, unknown> => {
  const probe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (key === 'credentialRef') continue;
    probe[key] = value;
  }
  return probe;
};

const base = (over: Partial<Parameters<typeof runActionPack>[0]> = {}) => ({
  actorUserId: 'user-1',
  guard: guardAllow(),
  idempotency: createInMemoryIdempotencyStore(),
  ...over,
});

describe('PHASE 3 FINAL U5/U6 —— 授权只来自共享 Action Guard', () => {
  it('P3F_A1 未配置共享 Action Guard → BLOCKED（ACTION_PACK_ACTION_GUARD_NOT_CONFIGURED），invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base({ guard: null, idempotency: createInMemoryIdempotencyStore() }),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('ACTION_PACK_ACTION_GUARD_NOT_CONFIGURED');
    expect(calls.count).toBe(0);
  });

  it('P3F_A2 caller 自报 guardDecision="ALLOW" 不能绕过：guard 拒绝即 BLOCKED，invoke = 0', async () => {
    const calls = counting();
    const spoof = {
      ...base({ idempotency: createInMemoryIdempotencyStore() }),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'not.in.catalog' }),
      guardDecision: 'ALLOW',
      approvalRef: 'anything',
    } as unknown as Parameters<typeof runActionPack>[0];
    const outcome = await runActionPack(spoof);
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason.startsWith('ACTION_GUARD_DENY:')).toBe(true);
    expect(calls.count).toBe(0);
  });

  it('P3F_A3 factory sandbox adapter + guard ALLOW → COMPLETED，invoke = 1', async () => {
    const calls = counting();
    const adapter = createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump });
    expect(isTrustedSandboxProviderAdapter(adapter)).toBe(true);
    const outcome = await runActionPack({ ...base(), adapter, request: request() });
    expect(outcome.allowed).toBe(true);
    expect(outcome.disposition).toBe('COMPLETED');
    expect(calls.count).toBe(1);
    expect(outcome.evidence.guardCode.length).toBeGreaterThan(0);
  });

  it('P3F_A4 非 factory adapter 自报 capability.simulated=true → 不授权，invoke = 0', async () => {
    const calls = counting();
    const fake: ProviderAdapter = {
      providerName: 'real-ish',
      capability: { simulated: true, network: false, paid: false },
      async invoke() {
        calls.bump();
        return { status: 'SUCCEEDED', providerRef: 'fake:1', reasonCodes: ['FAKE'], sideEffectConfirmedAbsent: false };
      },
    };
    expect(isTrustedSandboxProviderAdapter(fake)).toBe(false);
    const outcome = await runActionPack({
      ...base(),
      adapter: fake,
      request: request(),
      transportEnabled: true,
      credentialPort: opaquePort('vault:providers/amazon/org-1'),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason.startsWith('EXTERNAL_WRITE_HOLD')).toBe(true);
    expect(calls.count).toBe(0);
  });
});

describe('PHASE 3 FINAL U2 —— credential 绑定进入执行链', () => {
  it('P3F_A5 provider mismatch → BLOCKED（PROVIDER_CREDENTIAL_PROVIDER_MISMATCH），invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
    });
    expect(outcome.allowed).toBe(true); // sandbox 不取真实凭据

    const fake: ProviderAdapter = {
      providerName: 'amazon',
      capability: { simulated: false },
      async invoke() {
        calls.bump();
        return { status: 'SUCCEEDED', providerRef: 'x', reasonCodes: [], sideEffectConfirmedAbsent: false };
      },
    };
    const mismatched = await runActionPack({
      ...base({ idempotency: createInMemoryIdempotencyStore() }),
      adapter: fake,
      request: request(),
      transportEnabled: true,
      credentialPort: opaquePort('vault:providers/amazon/org-1', { providerName: 'tiktok' }),
    });
    expect(mismatched.allowed).toBe(false);
    expect(mismatched.reason).toBe('PROVIDER_CREDENTIAL_PROVIDER_MISMATCH');
  });

  it('P3F_A6 organization mismatch → BLOCKED（PROVIDER_CREDENTIAL_TENANT_MISMATCH），invoke = 0', async () => {
    const calls = counting();
    const fake: ProviderAdapter = {
      providerName: 'real-ish',
      capability: { simulated: false },
      async invoke() {
        calls.bump();
        return { status: 'SUCCEEDED', providerRef: 'x', reasonCodes: [], sideEffectConfirmedAbsent: false };
      },
    };
    const outcome = await runActionPack({
      ...base(),
      adapter: fake,
      request: request(),
      transportEnabled: true,
      credentialPort: opaquePort('vault:providers/amazon/org-2', { organizationId: 'org-2' }),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('PROVIDER_CREDENTIAL_TENANT_MISMATCH');
    expect(calls.count).toBe(0);
  });
});

describe('PHASE 3 U5 —— HITL 与外部写入边界', () => {
  it('P3F_A7 HITL 判定：HIGH risk / guard=REQUIRES_APPROVAL / owner-gated 一率为 REQUIRED', () => {
    expect(decideHitlRequirement({ action: 'evidence.read', riskClass: 'LOW' }).decision).toBe('NOT_REQUIRED');
    expect(decideHitlRequirement({ action: 'evidence.read', guardDecision: 'REQUIRES_APPROVAL' }).reason).toBe('GUARD_REQUIRES_APPROVAL');
    expect(decideHitlRequirement({ action: 'evidence.read', riskClass: 'HIGH' }).reason).toBe('HIGH_RISK');
    expect(decideHitlRequirement({ action: 'platform.write' }).reason).toBe('OWNER_GATED_ACTION');
  });

  it('P3F_A8 riskClass=HIGH 且缺 approvalRef → BLOCKED，invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
      riskClass: 'HIGH',
    });
    expect(outcome.reason).toBe('HITL_APPROVAL_REQUIRED:HIGH_RISK');
    expect(calls.count).toBe(0);
  });

  it('P3F_A9 owner-gated（claim.submit）无 approvalRef → HITL BLOCKED，invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'claim.submit' }),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason.startsWith('HITL_APPROVAL_REQUIRED:')).toBe(true);
    expect(calls.count).toBe(0);
  });

  it('P3F_A10 approvalRef 经共享 verifier 校验失败 → BLOCKED（不自动继续），invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'claim.submit' }),
      approvalRef: 'approval-does-not-exist',
      approvalVerifier: verifier(false),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('ACTION_GUARD_APPROVAL_NOT_VERIFIED:APPROVAL_NOT_FOUND');
    expect(calls.count).toBe(0);
  });

  it('P3F_A11 approval 校验通过后仍因外写 HOLD（EXTERNAL_WRITE_HOLD），invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'claim.submit' }),
      approvalRef: 'approval-1',
      approvalVerifier: verifier(true),
      transportEnabled: true,
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason.startsWith('EXTERNAL_WRITE_HOLD')).toBe(true);
    expect(outcome.evidence.externalWritePerformed).toBe(false);
    expect(calls.count).toBe(0);
  });

  it('P3F_A12 外写集合复用共享 Action Guard 强制清单（无第二份动作清单）', () => {
    for (const action of GUARD_ENFORCED_ACTIONS) expect(EXTERNAL_WRITE_ACTIONS).toContain(action);
    expect(EXTERNAL_WRITE_ACTIONS).toContain('customs.filing');
    expect(GUARD_ENFORCED_ACTIONS as readonly string[]).not.toContain('customs.filing');
    expect(isExternalWriteAction('evidence.read')).toBe(false);
  });
});

describe('PHASE 3 FINAL U3 —— exactly-once 进入执行链', () => {
  it('P3F_A13 同 key 同 fingerprint 二次 → DUPLICATE_REPLAY，provider invoke 总数 = 1', async () => {
    const calls = counting();
    const store = createInMemoryIdempotencyStore();
    const adapter = createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump });
    const first = await runActionPack({ ...base({ idempotency: store }), adapter, request: request() });
    const second = await runActionPack({ ...base({ idempotency: store }), adapter, request: request() });
    expect(first.disposition).toBe('COMPLETED');
    expect(second.allowed).toBe(true);
    expect(second.disposition).toBe('DUPLICATE_REPLAY');
    expect(calls.count).toBe(1);
  });

  it('P3F_A14 同 key 但 payload 变化 → IDEMPOTENCY_KEY_CONFLICT，且不重复 invoke', async () => {
    const calls = counting();
    const store = createInMemoryIdempotencyStore();
    const adapter = createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump });
    await runActionPack({ ...base({ idempotency: store }), adapter, request: request() });
    const conflicting = await runActionPack({
      ...base({ idempotency: store }),
      adapter,
      request: request({ payloadDigest: 'b'.repeat(64) }),
    });
    expect(conflicting.allowed).toBe(false);
    expect(conflicting.disposition).toBe('BLOCKED');
    expect(conflicting.reason).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(calls.count).toBe(1);
  });

  it('P3F_A15 缺 idempotencyKey → BLOCKED（fail-closed），invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ idempotencyKey: '   ' }),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('ACTION_PACK_IDEMPOTENCY_KEY_REQUIRED');
    expect(calls.count).toBe(0);
  });
});

describe('PHASE 3 U6 —— audit/evidence + 边界', () => {
  it('P3F_A16 evidence 结构化（无凭据 / 无原始 payload）；失败与 degraded 路径可控', async () => {
    const ok: ActionPackOutcome = await runActionPack({
      ...base(),
      adapter: createMockProviderAdapter({ providerName: 'mock-a' }),
      request: request(),
    });
    expect(ok.evidence.externalWritePerformed).toBe(false);
    expect(ok.evidence.modelCallCount).toBe(0);
    expect(ok.evidence.credentialRef).toBe(null);
    expect(scanCredentialFields(scannable(ok.evidence))).toEqual([]);
    expect(scanCredentialFields(ok.evidence)).toContain('credentialRef');
    expect(Object.keys(ok.evidence)).not.toContain('payload');
    expect(Object.keys(ok.evidence)).not.toContain('response');

    const failed = await runActionPack({
      ...base({ idempotency: createInMemoryIdempotencyStore() }),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', behavior: 'FAIL' }),
      request: request({ idempotencyKey: 'idem-fail' }),
    });
    expect(failed.disposition).toBe('RETRY_ELIGIBLE');
    expect(failed.evidence.reasonCodes).toContain('retry=RETRY');

    const degraded = await runActionPack({
      ...base({ idempotency: createInMemoryIdempotencyStore() }),
      adapter: createMockProviderAdapter({ providerName: 'mock-a', behavior: 'DEGRADED' }),
      request: request({ idempotencyKey: 'idem-degraded' }),
    });
    expect(degraded.disposition).toBe('MANUAL_REVIEW');
    expect(degraded.evidence.status).toBe('UNKNOWN');
  });

  it('P3F_A17 边界声明：外写 HOLD / 授权来自共享 Guard / sandbox provenance / 无第二 Action Runtime', () => {
    expect(ACTION_PACK_RUNTIME_BOUNDARY.externalWrite).toContain('HOLD');
    expect(ACTION_PACK_RUNTIME_BOUNDARY.authorization).toContain('SHARED_ACTION_GUARD');
    expect(ACTION_PACK_RUNTIME_BOUNDARY.sandboxProvenance).toContain('FACTORY_WEAKSET');
    expect(ACTION_PACK_RUNTIME_BOUNDARY.externalWritePerformed).toBe(false);
    expect(ACTION_PACK_RUNTIME_BOUNDARY.secondActionRuntime).toBe('FORBIDDEN');
  });
});
