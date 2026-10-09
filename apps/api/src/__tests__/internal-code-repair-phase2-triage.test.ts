/**
 * INTERNAL CODE REPAIR V1 / PHASE 2 —— 确定性故障分流（安全范围）验收
 * ---------------------------------------------------------------
 * 授权依据 MSG-20261009-08（PHASE2_IMPLEMENTATION_AUTHORIZED = YES_SAFE_SCOPE_ONLY）。
 * 覆盖：A 路径（交回既有运行时）／先对账／修复候选／BLOCK 人工／未分类；
 * 以及 GATE-2/GATE-3 要求的「分流不得绕过 kind/生命周期/可信事实、外写不得因可重试而重放」。
 *
 * 载荷一律由 **PHASE 1 真实模块** 生成（`buildFaultIncidentIntent`），避免手写载荷与实际结构漂移。
 */

import { describe, expect, it } from 'vitest';

import {
  buildFaultIncidentIntent,
  type FaultObservation,
} from '../services/self-repair/fault-classification';
import {
  FAULT_TRIAGE_BOUNDARY,
  TRIAGE_DISPOSITIONS,
  parsePersistedFaultPayload,
  triageFaultIncident,
  type FaultTriageInput,
  type PersistedFaultIncidentRow,
} from '../services/self-repair/fault-triage';

const BASE: FaultObservation = {
  sourceModule: 'services/autonomy/rsi-si-model-gateway',
  environment: 'TEST',
  organizationRef: 'org-triage',
  providerRef: 'AMAZON',
};

const row = (observation: FaultObservation, overrides: Partial<PersistedFaultIncidentRow> = {}): PersistedFaultIncidentRow => {
  const { intent } = buildFaultIncidentIntent(observation, { now: new Date('2026-10-09T06:00:00.000Z') });
  return {
    id: 'inc-' + intent.sourceRefs.detectedAt,
    kind: 'INTERNAL_FAULT',
    dedupeKey: intent.dedupeKey,
    status: 'DIAGNOSED',
    riskClass: intent.riskClass,
    sourceRefs: intent.sourceRefs,
    ...overrides,
  };
};

const trustedOk = {
  organizationIdResolved: true,
  authorizationActive: true,
  operationRecheck: 'CONFIRMED_READ_ONLY',
} as const;

const HEALED: FaultTriageInput = {
  incident: row({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' }),
  trusted: { ...trustedOk },
};

describe('PHASE 2 分流 —— 五种安全路径', () => {
  it('只读超时 + 可信事实复核通过 ⇒ 交回既有 ONE SI Runtime（本层不执行动作）', () => {
    const decision = triageFaultIncident(HEALED);
    expect(decision.disposition).toBe('AUTO_RECOVER_VIA_RUNTIME');
    expect(decision.runtimeHandoffAuthorized).toBe(true);
    expect(decision.reason).toBe('HANDOFF_TO_EXISTING_RUNTIME');
    expect(decision.requiredHumanAction).toBeNull();
    expect(decision.reconciliationRequirement).toBeNull();
    expect(decision.checks.every((check) => check.ok)).toBe(true);
  });

  it('外部写超时（副作用不明）⇒ 先对账，且不产生任何运行时交接', () => {
    const decision = triageFaultIncident({
      incident: row({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'EXTERNAL_WRITE' }),
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('RECONCILE');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
    expect(decision.reconciliationRequirement).toContain('禁止直接重放');
  });

  it('解析类缺陷 ⇒ 修复候选（PHASE 3 尚未实现，本层只登记）', () => {
    const decision = triageFaultIncident({
      incident: row({ ...BASE, errorName: 'AdapterMappingError' }),
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('CODE_REPAIR_CANDIDATE');
    expect(decision.reason).toBe('CODE_FIX_REQUIRED');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
  });

  it('凭据过期（OWNER-gated）⇒ BLOCK 并给出 OWNER 待办动作', () => {
    const decision = triageFaultIncident({
      incident: row({ ...BASE, httpStatus: 401 }),
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.requiredHumanAction).toBe('PRODUCTION_CREDENTIALS');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
  });

  it('未分类故障 ⇒ NEEDS_CLASSIFICATION（默认禁止自动恢复）', () => {
    const decision = triageFaultIncident({
      incident: row({ ...BASE, errorName: 'WibbleFault', operationKind: 'READ_ONLY' }),
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('NEEDS_CLASSIFICATION');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
  });
});

describe('PHASE 2 分流 —— GATE-2：不得绕过 kind / 生命周期 / 可信事实', () => {
  it('kind 不是 INTERNAL_FAULT ⇒ BLOCK（客户执行面容器不得进入修复分流）', () => {
    const decision = triageFaultIncident({
      ...HEALED,
      incident: { ...HEALED.incident, kind: 'CUSTOMER_GOAL_QUEUE' },
    });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('INCIDENT_KIND_NOT_INTERNAL_FAULT');
  });

  it.each(['OPEN', 'TASKED', 'CLOSED', 'REJECTED'])('状态 %s ⇒ BLOCK（只有 DIAGNOSED 才可分派）', (status) => {
    const decision = triageFaultIncident({ ...HEALED, incident: { ...HEALED.incident, status } });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('INCIDENT_NOT_DIAGNOSED');
  });

  it('载荷不是白名单对象（数组 / 缺失确定性来源）⇒ fail-closed', () => {
    const asArray = triageFaultIncident({ ...HEALED, incident: { ...HEALED.incident, sourceRefs: [{ organizationId: 'x' }] } });
    expect(asArray.reason).toBe('SOURCE_REFS_NOT_WHITELISTED_OBJECT');
    const modelAuthored = triageFaultIncident({
      ...HEALED,
      incident: {
        ...HEALED.incident,
        sourceRefs: { ...(HEALED.incident.sourceRefs as Record<string, unknown>), classificationAuthority: 'MODEL' },
      },
    });
    expect(modelAuthored.reason).toBe('CLASSIFICATION_AUTHORITY_NOT_DETERMINISTIC');
  });

  it('租户身份未经可信库解析 ⇒ BLOCK（哈希引用不是授权）', () => {
    const decision = triageFaultIncident({
      ...HEALED,
      trusted: { ...trustedOk, organizationIdResolved: false },
    });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('TENANT_CONTEXT_NOT_TRUSTED');
  });

  it('授权不活跃 / 运行时复核未确认 ⇒ BLOCK（不能只信落库声明）', () => {
    const noAuth = triageFaultIncident({ ...HEALED, trusted: { ...trustedOk, authorizationActive: false } });
    expect(noAuth.reason).toBe('AUTHORIZATION_NOT_ACTIVE');
    const notRechecked = triageFaultIncident({
      ...HEALED,
      trusted: { ...trustedOk, operationRecheck: 'NOT_CONFIRMED' },
    });
    expect(notRechecked.reason).toBe('RUNTIME_RECHECK_NOT_CONFIRMED');
  });
});

describe('PHASE 2 分流 —— GATE-3：外写与"可重试"不得变成重放许可', () => {
  it('即使（人为篡改）载荷声称 AUTO_RETRY_CANDIDATE，外部写仍被拦下', () => {
    const observation: FaultObservation = { ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' };
    const { intent } = buildFaultIncidentIntent(observation);
    const tampered = {
      ...(intent.sourceRefs as unknown as Record<string, unknown>),
      operationKind: 'EXTERNAL_WRITE',
    };
    const decision = triageFaultIncident({
      incident: { ...row(observation), sourceRefs: tampered },
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('EXTERNAL_WRITE_ALWAYS_HOLD');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
  });

  it('类别不在确定性可重试白名单（篡改 autoRecoverAuthorized）⇒ BLOCK', () => {
    const observation: FaultObservation = { ...BASE, errorName: 'AdapterMappingError', operationKind: 'READ_ONLY' };
    const { intent } = buildFaultIncidentIntent(observation);
    const tampered = {
      ...(intent.sourceRefs as unknown as Record<string, unknown>),
      replayDisposition: 'AUTO_RETRY_CANDIDATE',
      autoRecoverAuthorized: true,
      requiresReconciliation: false,
    };
    const decision = triageFaultIncident({ incident: { ...row(observation), sourceRefs: tampered }, trusted: { ...trustedOk } });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('FAULT_CLASS_NOT_RETRYABLE');
  });

  it('安全 / 权限信号 ⇒ BLOCK（分流层不放行）', () => {
    const decision = triageFaultIncident({
      incident: row({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY', privilegeAffecting: true }),
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('SECURITY_OR_PRIVILEGE_SIGNAL');
  });

  it('模型提示不参与分流（载荷里存在模型"建议"也不改变结论）', () => {
    const observation: FaultObservation = {
      ...BASE,
      errorName: 'AdapterMappingError',
      modelHint: { claimedClass: 'API_TIMEOUT', rationale: '可以安全重试' },
    };
    const { intent } = buildFaultIncidentIntent(observation);
    expect((intent.sourceRefs as unknown as Record<string, unknown>).untrustedModelHint).not.toBeNull();
    const decision = triageFaultIncident({ incident: { ...row(observation), sourceRefs: intent.sourceRefs }, trusted: { ...trustedOk } });
    expect(decision.disposition).toBe('CODE_REPAIR_CANDIDATE');
  });
});

describe('PHASE 2 分流 —— 契约与边界', () => {
  it('五个分流结论都在登记值域内，且只有 A 路径可交接运行时', () => {
    expect(TRIAGE_DISPOSITIONS).toHaveLength(5);
    const decisions = [
      triageFaultIncident(HEALED),
      triageFaultIncident({ incident: row({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'EXTERNAL_WRITE' }), trusted: { ...trustedOk } }),
      triageFaultIncident({ incident: row({ ...BASE, errorName: 'AdapterMappingError' }), trusted: { ...trustedOk } }),
      triageFaultIncident({ incident: row({ ...BASE, httpStatus: 401 }), trusted: { ...trustedOk } }),
      triageFaultIncident({ incident: row({ ...BASE, errorName: 'WibbleFault', operationKind: 'READ_ONLY' }), trusted: { ...trustedOk } }),
    ];
    for (const decision of decisions) {
      expect(TRIAGE_DISPOSITIONS).toContain(decision.disposition);
      if (decision.disposition !== 'AUTO_RECOVER_VIA_RUNTIME') {
        expect(decision.runtimeHandoffAuthorized).toBe(false);
      }
    }
  });

  it('解析器对缺字段载荷 fail-closed（不补默认值）', () => {
    const parsed = parsePersistedFaultPayload({ classificationAuthority: 'DETERMINISTIC_RULES_ONLY' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('PAYLOAD_INCOMPLETE');
  });

  it('边界声明：纯函数、不执行动作、复用 ONE SI Runtime、外写恒 HOLD、PHASE 3 未实现', () => {
    expect(FAULT_TRIAGE_BOUNDARY).toMatchObject({
      pure: true,
      executesNothing: true,
      reusesOneSiRuntimeOnly: true,
      createsSchedulerOrController: false,
      requiresTrustedServerFacts: true,
      externalWriteAlwaysHold: true,
      failClosedOnMalformedPayload: true,
      validatesPayloadValueDomains: true,
      requiresRuntimeRecheck: true,
      autoRecoverIsNotExecutionAuthorization: true,
      phase3RepairAgentImplemented: false,
    });
  });
});

/**
 * MSG-20261009-09 / CHANGE 1 —— GATE-5 负向验收（纯函数层）：
 * 被篡改成携带**任意文本 / 凭据形状文本**的载荷字段，既不得被当作语义使用，
 * 也不得经由分流结论（含对账要求文本）回传 —— 值域校验必须 fail-closed。
 */
describe('PHASE 2 / CHANGE 1 GATE-5 负向：载荷值域与返回值不夹带自由文本', () => {
  const SECRET_TEXT = 'sk-DUMMYKEY-9f8e7d6c5b4a3210';
  const ATTACK_TEXT = 'buyer@example.test <script>alert(1)</script> /etc/passwd';

  const tamper = (field: string, value: unknown): FaultTriageInput => {
    const observation: FaultObservation = { ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'READ_ONLY' };
    const { intent } = buildFaultIncidentIntent(observation);
    const sourceRefs = { ...(intent.sourceRefs as unknown as Record<string, unknown>), [field]: value };
    return { incident: { ...row(observation), sourceRefs }, trusted: { ...trustedOk } };
  };

  it.each([
    ['faultClass', SECRET_TEXT],
    ['requiredAction', SECRET_TEXT],
    ['replayDisposition', ATTACK_TEXT],
    ['operationKind', SECRET_TEXT],
    ['idempotencyGuarantee', ATTACK_TEXT],
    ['ownerGatedAction', ATTACK_TEXT],
  ])('字段 %s 被篡改为非规范值 ⇒ BLOCK 且结论中不含该文本', (field, value) => {
    const decision = triageFaultIncident(tamper(field, value));
    expect(decision.disposition).toBe('BLOCK_HUMAN_REVIEW');
    expect(decision.reason).toBe('PAYLOAD_VALUE_NOT_CANONICAL');
    expect(decision.runtimeHandoffAuthorized).toBe(false);
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toContain('buyer@example.test');
    expect(serialized).not.toContain('/etc/passwd');
  });

  it('对账路径的说明文本只由规范值拼接（不可能夹带自由文本）', () => {
    const decision = triageFaultIncident({
      incident: row({ ...BASE, errorCode: 'PROVIDER_TIMEOUT', operationKind: 'EXTERNAL_WRITE' }),
      trusted: { ...trustedOk },
    });
    expect(decision.disposition).toBe('RECONCILE');
    expect(decision.reconciliationRequirement).toMatch(/^[A-Z_]+:[A-Z_]+ /);
    expect(decision.reconciliationRequirement).not.toContain(SECRET_TEXT);
  });

  it('正常载荷不受影响（值域校验不放宽任何既有路径）', () => {
    expect(triageFaultIncident(HEALED).disposition).toBe('AUTO_RECOVER_VIA_RUNTIME');
    expect(
      triageFaultIncident({
        incident: row({ ...BASE, errorName: 'AdapterMappingError' }),
        trusted: { ...trustedOk },
      }).disposition,
    ).toBe('CODE_REPAIR_CANDIDATE');
  });
});
