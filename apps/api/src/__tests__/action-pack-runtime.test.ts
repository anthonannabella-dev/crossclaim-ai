/**
 * PHASE 3 U5/U6 —— Action Pack 执行运行时：HITL 落点 + audit/evidence 输出
 * 边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT /
 *      PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD；允许路径只走 sandbox mock adapter。
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_PACK_RUNTIME_BOUNDARY,
  EXTERNAL_WRITE_ACTIONS,
  decideHitlRequirement,
  isExternalWriteAction,
  runActionPack,
} from '../services/action-runtime/action-pack-runtime';
import { GUARD_ENFORCED_ACTIONS } from '../services/action-guard/guard-enforcement';
import {
  createMockProviderAdapter,
  scanCredentialFields,
  type ProviderAdapter,
  type ProviderInvokeRequest,
} from '../services/action-runtime/provider-adapter-contract';
import {
  createInMemoryIdempotencyStore,
  type ProviderCredentialPort,
} from '../services/action-runtime/provider-execution-guard';

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

const opaquePort = (ref: string | null): ProviderCredentialPort => ({
  async resolveRef() {
    return ref === null ? null : { credentialRef: ref, providerName: 'p', organizationId: 'org-1' };
  },
});

/** 去掉白名单 opaque ref 键后的 evidence，用于凭据字段扫描回归 */
const scannable = (evidence: object): Record<string, unknown> => {
  const probe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (key === 'credentialRef') continue;
    probe[key] = value;
  }
  return probe;
};

describe('PHASE 3 U5 —— HITL 落点（缺 approval 一律 BLOCKED，provider invoke = 0）', () => {
  it('P3U5_1 HITL 判定：guard=REQUIRES_APPROVAL / HIGH risk / owner-gated 一率为 REQUIRED', () => {
    expect(decideHitlRequirement({ action: 'evidence.read', riskClass: 'LOW' }).decision).toBe('NOT_REQUIRED');
    expect(decideHitlRequirement({ action: 'evidence.read', guardDecision: 'REQUIRES_APPROVAL' })).toEqual({
      decision: 'REQUIRED',
      reason: 'GUARD_REQUIRES_APPROVAL',
    });
    expect(decideHitlRequirement({ action: 'evidence.read', riskClass: 'HIGH' }).reason).toBe('HIGH_RISK');
    expect(decideHitlRequirement({ action: 'platform.write' }).reason).toBe('OWNER_GATED_ACTION');
  });

  it('P3U5_2 guard=REQUIRES_APPROVAL 且无 approvalRef → BLOCKED，不 invoke', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
      guardDecision: 'REQUIRES_APPROVAL',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.disposition).toBe('BLOCKED');
    expect(outcome.reason).toBe('HITL_APPROVAL_REQUIRED:GUARD_REQUIRES_APPROVAL');
    expect(calls.count).toBe(0);
    expect(outcome.evidence.status).toBe('NOT_EXECUTED');
  });

  it('P3U5_3 riskClass=HIGH 且无 approvalRef → BLOCKED，不 invoke', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
      riskClass: 'HIGH',
      guardDecision: 'ALLOW',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.reason).toBe('HITL_APPROVAL_REQUIRED:HIGH_RISK');
    expect(calls.count).toBe(0);
  });

  it('P3U5_4 owner-gated action（claim.submit）无 approvalRef → BLOCKED，不 invoke', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'claim.submit' }),
      guardDecision: 'ALLOW',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('HITL_APPROVAL_REQUIRED:OWNER_GATED_ACTION');
    expect(calls.count).toBe(0);
  });

  it('P3U5_5 补齐 approvalRef 后，非外写只读动作在 sandbox mock 上可完成（invoke = 1）', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
      guardDecision: 'ALLOW',
      approvalRef: 'hitl:approval-1',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(true);
    expect(outcome.disposition).toBe('COMPLETED');
    expect(calls.count).toBe(1);
  });
});

describe('PHASE 3 U5 —— 外写 HOLD（external-write action 永不 invoke provider）', () => {
  it('P3U5_6 外写动作判定：claim/appeal/customs/platform/payment 为外写；只读为否', () => {
    for (const action of ['claim.submit', 'appeal.submit', 'customs.filing', 'platform.write', 'payment.capture']) {
      expect(isExternalWriteAction(action)).toBe(true);
    }
    expect(isExternalWriteAction('evidence.read')).toBe(false);
  });

  it('P3U5_6b 外写集合直接复用共享 Action Guard 强制清单（单一事实来源，无第二份动作清单）', () => {
    for (const action of GUARD_ENFORCED_ACTIONS) {
      expect(EXTERNAL_WRITE_ACTIONS).toContain(action);
    }
    expect(EXTERNAL_WRITE_ACTIONS).toContain('customs.filing');
    expect(GUARD_ENFORCED_ACTIONS as readonly string[]).not.toContain('customs.filing');
  });

  it('P3U5_7 customs.filing 即使补齐 approvalRef → EXTERNAL_WRITE_HOLD，invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'customs.filing' }),
      guardDecision: 'ALLOW',
      transportEnabled: true,
      approvalRef: 'hitl:approval-1',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.disposition).toBe('BLOCKED');
    expect(outcome.reason.startsWith('EXTERNAL_WRITE_HOLD')).toBe(true);
    expect(calls.count).toBe(0);
    expect(outcome.evidence.externalWritePerformed).toBe(false);
  });

  it('P3U5_8 platform.write + transport 打开 + guard=ALLOW → 仍 HOLD，invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ action: 'platform.write' }),
      guardDecision: 'ALLOW',
      transportEnabled: true,
      approvalRef: 'hitl:approval-1',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason.startsWith('EXTERNAL_WRITE_HOLD')).toBe(true);
    expect(calls.count).toBe(0);
  });
});

describe('PHASE 3 U5 —— exactly-once（重复投递不重放 provider）', () => {
  it('P3U5_9 同 idempotencyKey 第二次 → DUPLICATE_REPLAY，provider invoke 总数 = 1', async () => {
    const calls = counting();
    const store = createInMemoryIdempotencyStore();
    const adapter = createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump });
    const first = await runActionPack({ adapter, request: request(), guardDecision: 'ALLOW', idempotency: store });
    const second = await runActionPack({ adapter, request: request(), guardDecision: 'ALLOW', idempotency: store });
    expect(first.disposition).toBe('COMPLETED');
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(second.disposition).toBe('DUPLICATE_REPLAY');
    expect(second.reason).toBe('IDEMPOTENT_REPLAY');
    expect(calls.count).toBe(1);
  });
});

describe('PHASE 3 U6 —— audit/evidence（结构化输出，不含凭据 / 原始 payload）', () => {
  it('P3U6_1 mock SUCCESS → COMPLETED，evidence 结构化且 externalWritePerformed=false / modelCallCount=0', async () => {
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a' }),
      request: request(),
      guardDecision: 'ALLOW',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.disposition).toBe('COMPLETED');
    expect(outcome.evidence.externalWritePerformed).toBe(false);
    expect(outcome.evidence.modelCallCount).toBe(0);
    expect(outcome.evidence.credentialRef).toBe(null);
    expect(outcome.evidence.reasonCodes).toContain('retry=STOP');
    expect(outcome.evidence.evidenceRef.startsWith('action-evidence:')).toBe(true);
    // 白名单：opaque ref 键本身匹配 credential 关键词，但扫描时必须被显式排除
    expect(scanCredentialFields(scannable(outcome.evidence))).toEqual([]);
    expect(scanCredentialFields(outcome.evidence)).toContain('credentialRef');
    expect(Object.keys(outcome.evidence)).not.toContain('payload');
    expect(Object.keys(outcome.evidence)).not.toContain('response');
  });

  it('P3U6_2 mock FAIL（确认无副作用）→ RETRY_ELIGIBLE；mock DEGRADED → MANUAL_REVIEW', async () => {
    const failed = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', behavior: 'FAIL' }),
      request: request(),
      guardDecision: 'ALLOW',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(failed.allowed).toBe(true);
    expect(failed.disposition).toBe('RETRY_ELIGIBLE');
    expect(failed.evidence.status).toBe('FAILED');
    expect(failed.evidence.reasonCodes).toContain('retry=RETRY');

    const degraded = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', behavior: 'DEGRADED' }),
      request: request(),
      guardDecision: 'ALLOW',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(degraded.disposition).toBe('MANUAL_REVIEW');
    expect(degraded.evidence.status).toBe('UNKNOWN');
    expect(degraded.evidence.reasonCodes).toContain('retry=MANUAL_REVIEW');
    expect(degraded.evidence.externalWritePerformed).toBe(false);
  });
});

describe('PHASE 3 —— 契约边界（凭据 opaque / guard DENY / 缺幂等键 / 非模拟 adapter）', () => {
  it('P3B_1 非模拟 adapter：非 opaque ref → REJECT；opaque ref → 仍 fail-closed 不 invoke', async () => {
    const nonSimulated: ProviderAdapter = {
      providerName: 'real-ish',
      capability: { simulated: false },
      async invoke() {
        throw new Error('MUST_NOT_INVOKE');
      },
    };
    const keyLike = await runActionPack({
      adapter: nonSimulated,
      request: request(),
      guardDecision: 'ALLOW',
      transportEnabled: true,
      credentialPort: opaquePort('A'.repeat(40)),
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(keyLike.allowed).toBe(false);
    expect(keyLike.reason).toBe('PROVIDER_CREDENTIAL_REF_NOT_OPAQUE');

    const opaque = await runActionPack({
      adapter: nonSimulated,
      request: request(),
      guardDecision: 'ALLOW',
      transportEnabled: true,
      credentialPort: opaquePort('vault:providers/amazon/org-1'),
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(opaque.allowed).toBe(false);
    expect(opaque.reason.startsWith('EXTERNAL_WRITE_HOLD')).toBe(true);
    expect(opaque.evidence.credentialRef).toBe('vault:providers/amazon/org-1');
  });

  it('P3B_2 guard=DENY → BLOCKED 且 invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request(),
      guardDecision: 'DENY',
      transportEnabled: true,
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('EXTERNAL_WRITE_GUARD_NOT_ALLOW:DENY');
    expect(calls.count).toBe(0);
  });

  it('P3B_3 缺 idempotencyKey → BLOCKED（fail-closed），invoke = 0', async () => {
    const calls = counting();
    const outcome = await runActionPack({
      adapter: createMockProviderAdapter({ providerName: 'mock-a', onInvoke: calls.bump }),
      request: request({ idempotencyKey: '   ' }),
      guardDecision: 'ALLOW',
      idempotency: createInMemoryIdempotencyStore(),
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('ACTION_PACK_IDEMPOTENCY_KEY_REQUIRED');
    expect(calls.count).toBe(0);
  });

  it('P3B_4 边界声明：外写 HOLD / 无第二 Action Runtime', () => {
    expect(ACTION_PACK_RUNTIME_BOUNDARY.externalWritePerformed).toBe(false);
    expect(ACTION_PACK_RUNTIME_BOUNDARY.secondActionRuntime).toBe('FORBIDDEN');
    expect(ACTION_PACK_RUNTIME_BOUNDARY.externalWrite).toContain('HOLD');
  });
});
