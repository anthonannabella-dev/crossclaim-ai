/**
 * PHASE 3 U5/U6 —— Action Pack 执行运行时：HITL 落点 + audit/evidence 输出
 * ---------------------------------------------------------------
 * 调用顺序固定，任一步 fail-closed 即停止：
 *   adapter 契约 → credential ref（opaque）→ HITL 判定 → external-write gate
 *   → idempotency.begin（EXACTLY-ONCE）→ provider invoke（仅 mock / simulated）→ 结果归一化
 *   → idempotency.complete → retry / reconcile 判定 → evidence 记录
 *
 * 硬约束：
 *   - **真实外写 HOLD**：`isExternalWriteAction(action) === true` 时一律进入 `EXTERNAL_WRITE_HOLD`，绝不 invoke provider。
 *   - 非外写动作（读取/准备类）仅在 simulated adapter 下可端到端跑通，用于验证管道。
 *   - evidence 只做结构化引用：无凭据、无原始 payload/响应；`externalWritePerformed` 恒为 false。
 *   - 无第二 Action Runtime / 第二 Control Plane；HITL 与 gate 只做**判定**，授权仍归共享 Action Guard。
 */

import {
  assertProviderAdapter,
  decideExternalWriteGate,
  normalizeProviderResult,
  scanCredentialFields,
  type ProviderAdapter,
  type ProviderInvokeRequest,
  type ProviderInvokeResult,
} from './provider-adapter-contract';
import { GUARD_ENFORCED_ACTIONS } from '../action-guard/guard-enforcement';
import {
  decideProviderReconcile,
  decideProviderRetry,
  resolveProviderCredential,
  type ProviderCredentialPort,
  type ProviderIdempotencyStore,
  type ProviderExecutionRecord,
} from './provider-execution-guard';

export const ACTION_PACK_RUNTIME_BOUNDARY = {
  externalWrite: 'HOLD（外写动作一律 EXTERNAL_WRITE_HOLD，不 invoke provider）',
  hitl: 'REQUIRED when guard=REQUIRES_APPROVAL / riskClass=HIGH / owner-gated action',
  exactlyOnce: 'idempotency.begin 先于 provider invoke；DUPLICATE 不重复执行',
  evidence: 'STRUCTURED_ONLY（无凭据 / 无原始 payload / 响应）',
  externalWritePerformed: false,
  secondActionRuntime: 'FORBIDDEN',
} as const;

/** 真实报关申报：不在共享 Action Guard 强制清单中，但同属外写，必须一并 HOLD + HITL。 */
const CUSTOMS_FILING_ACTION = 'customs.filing';

/**
 * 外写动作集合 = 共享 Action Guard 强制覆盖清单 ∪ {customs.filing}。
 * 单一事实来源：直接复用 `GUARD_ENFORCED_ACTIONS`，本模块**不**另行维护动作清单（避免漂移）。
 * 集合内动作在 Action Pack 运行时一律 `EXTERNAL_WRITE_HOLD`，绝不 invoke provider。
 */
export const EXTERNAL_WRITE_ACTIONS: readonly string[] = [...GUARD_ENFORCED_ACTIONS, CUSTOMS_FILING_ACTION];

/** 外写动作一律视为 owner-gated：除 guard/risk 判定外，仍需人工 owner 授权（HITL）。 */
const OWNER_GATED_ACTIONS = EXTERNAL_WRITE_ACTIONS;

export function isExternalWriteAction(action: string): boolean {
  return EXTERNAL_WRITE_ACTIONS.includes(action);
}

export type HitlDecision = 'REQUIRED' | 'NOT_REQUIRED';

export function decideHitlRequirement(input: {
  action: string;
  guardDecision?: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';
  riskClass?: 'LOW' | 'MEDIUM' | 'HIGH';
}): { decision: HitlDecision; reason: string } {
  if (input.guardDecision === 'REQUIRES_APPROVAL') return { decision: 'REQUIRED', reason: 'GUARD_REQUIRES_APPROVAL' };
  if (input.riskClass === 'HIGH') return { decision: 'REQUIRED', reason: 'HIGH_RISK' };
  if ((OWNER_GATED_ACTIONS as readonly string[]).includes(input.action)) {
    return { decision: 'REQUIRED', reason: 'OWNER_GATED_ACTION' };
  }
  return { decision: 'NOT_REQUIRED', reason: 'NO_HITL_NEEDED' };
}

export interface ActionPackEvidence {
  action: string;
  organizationId: string;
  provider: string;
  idempotencyKey: string;
  status: ProviderInvokeResult['status'] | 'NOT_EXECUTED';
  reasonCodes: readonly string[];
  attempts: number;
  modelCallCount: 0;
  externalWritePerformed: false;
  /** opaque 引用；simulated adapter 下恒为 null。**不是**密钥本身。 */
  credentialRef: string | null;
  evidenceRef: string;
}

export interface ActionPackOutcome {
  allowed: boolean;
  reason: string;
  disposition: 'COMPLETED' | 'DUPLICATE_REPLAY' | 'RETRY_ELIGIBLE' | 'MANUAL_REVIEW' | 'BLOCKED';
  evidence: ActionPackEvidence;
}

const evidenceRefOf = (parts: readonly string[]): string => 'action-evidence:' + parts.join('|');

export async function runActionPack(input: {
  adapter: ProviderAdapter;
  request: ProviderInvokeRequest;
  riskClass?: 'LOW' | 'MEDIUM' | 'HIGH';
  guardDecision?: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';
  transportEnabled?: boolean;
  approvalRef?: string | null;
  credentialPort?: ProviderCredentialPort | null;
  idempotency: ProviderIdempotencyStore;
  maxAttempts?: number;
}): Promise<ActionPackOutcome> {
  const { adapter, request } = input;
  const base = {
    action: request.action,
    organizationId: request.organizationId,
    provider: adapter.providerName,
    idempotencyKey: request.idempotencyKey,
    modelCallCount: 0 as const,
    externalWritePerformed: false as const,
  };
  const blocked = (reason: string, amount = 0, credentialRef: string | null = null): ActionPackOutcome => ({
    allowed: false,
    reason,
    disposition: 'BLOCKED',
    evidence: {
      ...base,
      status: 'NOT_EXECUTED',
      reasonCodes: [reason, 'attempts=' + String(amount)],
      attempts: amount,
      credentialRef,
      evidenceRef: evidenceRefOf([request.idempotencyKey, 'BLOCKED', reason]),
    },
  });

  // 幂等键先校验：缺失即 fail-closed（不进入任何下游）
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '') {
    return blocked('ACTION_PACK_IDEMPOTENCY_KEY_REQUIRED', 0, null);
  }

  // ① adapter 契约
  const contract = assertProviderAdapter(adapter);
  if (!contract.ok) return blocked(contract.reason);

  // ② credential ref（simulated adapter 不取真实凭据；simulated 也不允许 opaque ref）
  let credentialRef: string | null = null;
  if (adapter.capability.simulated !== true) {
    const resolved = await resolveProviderCredential(input.credentialPort ?? null, {
      providerName: adapter.providerName,
      organizationId: request.organizationId,
    });
    if (!resolved.ok) return blocked(resolved.reason);
    credentialRef = resolved.ref.credentialRef;
  }

  // ③ HITL
  const hitl = decideHitlRequirement({ action: request.action, guardDecision: input.guardDecision, riskClass: input.riskClass });
  if (hitl.decision === 'REQUIRED' && (input.approvalRef ?? '').trim() === '') {
    return blocked('HITL_APPROVAL_REQUIRED:' + hitl.reason, 0, credentialRef);
  }

  // ④ external-write gate：外写动作一律 HOLD；非外写动作仅在 transport + guard ALLOW 下才能继续
  const gate = decideExternalWriteGate({
    adapter,
    request,
    transportEnabled: input.transportEnabled,
    guardDecision: input.guardDecision,
  });
  if (isExternalWriteAction(request.action)) return blocked('EXTERNAL_WRITE_HOLD:' + gate.reason, 0, credentialRef);
  if (!gate.allowed) {
    // 非外写动作：simulated adapter 且 guard 非 DENY/REQUIRES_APPROVAL 时才允许管道演练，且不产生任何外写。
    const simulatedOk = adapter.capability.simulated === true && input.guardDecision !== 'DENY' && input.guardDecision !== 'REQUIRES_APPROVAL';
    if (!simulatedOk) return blocked(gate.reason, 0, credentialRef);
  }

  // ⑤ exactly-once：先占幂等键
  const begin = input.idempotency.begin({ idempotencyKey: request.idempotencyKey });
  if (begin.outcome === 'DUPLICATE') {
    const record = begin.record;
    return {
      allowed: true,
      reason: 'IDEMPOTENT_REPLAY',
      disposition: 'DUPLICATE_REPLAY',
      evidence: {
        ...base,
        status: record.status,
        reasonCodes: ['IDEMPOTENT_REPLAY'],
        attempts: record.attempts,
        credentialRef,
        evidenceRef: evidenceRefOf([request.idempotencyKey, 'REPLAY', record.status]),
      },
    };
  }

  // ⑥ provider invoke（出口唯一：真实 provider 在 HOLD 期间不接入）
  const raw = await adapter.invoke(request);
  const result = normalizeProviderResult(raw);

  // ⑦ 结算
  const record: ProviderExecutionRecord = input.idempotency.complete({
    idempotencyKey: request.idempotencyKey,
    status: result.status,
    providerRef: result.providerRef,
  });

  // ⑧ retry / reconcile
  const retry = decideProviderRetry({
    attempts: record.attempts,
    lastStatus: result.status,
    sideEffectConfirmedAbsent: result.sideEffectConfirmedAbsent,
    ...(input.maxAttempts === undefined ? {} : { policy: { maxAttempts: input.maxAttempts } }),
  });
  const reconcile = decideProviderReconcile({
    status: result.status,
    providerRef: result.providerRef,
    sideEffectConfirmedAbsent: result.sideEffectConfirmedAbsent,
  });
  const disposition: ActionPackOutcome['disposition'] =
    result.status === 'SUCCEEDED' ? 'COMPLETED' : retry === 'MANUAL_REVIEW' || reconcile.action === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'RETRY_ELIGIBLE';

  const evidence: ActionPackEvidence = {
    ...base,
    status: result.status,
    reasonCodes: [...result.reasonCodes, 'retry=' + retry, 'reconcile=' + reconcile.action],
    attempts: record.attempts,
    credentialRef,
    evidenceRef: evidenceRefOf([request.idempotencyKey, result.status, String(record.attempts), result.providerRef ?? '-']),
  };
  // evidence 只允许结构化字段；opaque credentialRef 是显式白名单键（其**键名**含 credential 关键词），
  // 因此扫描前必须先剔除该键，避免 happy-path 被误判为携带凭据。
  const scannableEvidence: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (key === 'credentialRef') continue;
    scannableEvidence[key] = value;
  }
  if (scanCredentialFields(scannableEvidence).length > 0) {
    return blocked('ACTION_PACK_EVIDENCE_CREDENTIAL_FIELDS', record.attempts, credentialRef);
  }
  return { allowed: true, reason: 'ACTION_PACK_EXECUTED', disposition, evidence };
}
