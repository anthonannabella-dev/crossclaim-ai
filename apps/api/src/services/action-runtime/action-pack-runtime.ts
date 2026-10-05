/**
 * PHASE 3 U5/U6 + FINAL —— Action Pack 执行运行时：HITL 落点 + external-write gate + exactly-once + audit/evidence
 * ---------------------------------------------------------------
 * 调用顺序固定，任一步 fail-closed 即停止：
 *   幂等键校验 → adapter 契约 → credential ref（opaque + 绑定）→ **共享 Action Guard 判定**
 *   → HITL（共享 approval verifier）→ external-write gate → idempotency.begin（key + fingerprint）
 *   → provider invoke（仅 trusted sandbox adapter）→ 结果归一化 → complete → retry/reconcile → evidence
 *
 * 硬约束（PHASE 3 FINAL）：
 *   - **授权只来自共享 Action Guard**：`guardDecision` 不再由 caller 传入，必须由 server-owned
 *     `RuntimeActionGuard` 实例（createRuntimeActionGuard / createAppActionGuard）实际求值；缺失即 BLOCKED。
 *   - **真实外写 HOLD**：外写动作一律 `EXTERNAL_WRITE_HOLD`，绝不 invoke provider。
 *   - **trusted sandbox provenance**：sandbox 路径只认 factory 登记的 adapter
 *     （`isTrustedSandboxProviderAdapter`）；caller 自报 `capability.simulated = true` 不授权。
 *   - **HITL 不可自证**：guard=REQUIRES_APPROVAL / riskClass=HIGH / owner-gated 时必须经共享
 *     `ActionGuardApprovalVerifier` 校验 `approvalRef`，失败即 BLOCKED（不自动继续）。
 *   - **exactly-once**：idempotencyKey 绑定 fingerprint；同 key 不同 fingerprint → `IDEMPOTENCY_KEY_CONFLICT`。
 *   - evidence 只做结构化引用：无凭据、无原始 payload/响应；`externalWritePerformed` 恒为 false。
 */

import { verifyApprovalOrThrow, type ActionGuardApprovalVerifier } from '../action-guard/approval-verifier';
import { GUARD_ENFORCED_ACTIONS } from '../action-guard/guard-enforcement';
import type { RuntimeActionGuard } from '../action-guard/runtime-guard';
import {
  assertProviderAdapter,
  decideExternalWriteGate,
  isTrustedSandboxProviderAdapter,
  normalizeProviderResult,
  scanCredentialFields,
  type ProviderAdapter,
  type ProviderInvokeRequest,
  type ProviderInvokeResult,
} from './provider-adapter-contract';
import {
  buildProviderIdempotencyFingerprint,
  decideProviderReconcile,
  decideProviderRetry,
  resolveProviderCredential,
  type ProviderCredentialPort,
  type ProviderIdempotencyStore,
  type ProviderExecutionRecord,
} from './provider-execution-guard';

export const ACTION_PACK_RUNTIME_BOUNDARY = {
  externalWrite: 'HOLD（外写动作一律 EXTERNAL_WRITE_HOLD，不 invoke provider）',
  authorization: 'SHARED_ACTION_GUARD（server-owned RuntimeActionGuard 实例；caller 自报 guardDecision 不被接受）',
  hitl: 'REQUIRED when guard=REQUIRES_APPROVAL / riskClass=HIGH / owner-gated action（须共享 approval verifier 校验）',
  sandboxProvenance: 'FACTORY_WEAKSET（caller 自报 simulated 无效）',
  exactlyOnce: 'idempotencyKey + fingerprint；同 key 不同 fingerprint → IDEMPOTENCY_KEY_CONFLICT',
  evidence: 'STRUCTURED_ONLY（无凭据 / 无原始 payload / 响应）',
  externalWritePerformed: false,
  secondActionRuntime: 'FORBIDDEN',
} as const;

/** 真实报关申报：不在共享 Action Guard 强制清单中，但同属外写，必须一并 HOLD + HITL。 */
const CUSTOMS_FILING_ACTION = 'customs.filing';

/**
 * 外写动作集合 = 共享 Action Guard 强制覆盖清单 ∪ {customs.filing}。
 * 单一事实来源：直接复用 `GUARD_ENFORCED_ACTIONS`，本模块**不**另行维护动作清单（避免漂移）。
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
  if (OWNER_GATED_ACTIONS.includes(input.action)) return { decision: 'REQUIRED', reason: 'OWNER_GATED_ACTION' };
  return { decision: 'NOT_REQUIRED', reason: 'NO_HITL_NEEDED' };
}

export interface ActionPackEvidence {
  action: string;
  organizationId: string;
  provider: string;
  idempotencyKey: string;
  fingerprint: string;
  guardCode: string;
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
  /** 共享 Action Guard 的鉴权主体（server-derived，不接受客户端自报） */
  actorUserId: string;
  /** server-owned 共享 Action Guard 实例；缺失即 fail-closed */
  guard: RuntimeActionGuard | null | undefined;
  /** 共享审批校验端口；HITL 命中时缺失即 fail-closed */
  approvalVerifier?: ActionGuardApprovalVerifier | null;
  riskClass?: 'LOW' | 'MEDIUM' | 'HIGH';
  transportEnabled?: boolean;
  approvalRef?: string | null;
  credentialPort?: ProviderCredentialPort | null;
  idempotency: ProviderIdempotencyStore;
  maxAttempts?: number;
}): Promise<ActionPackOutcome> {
  const { adapter, request } = input;
  const fingerprint = buildProviderIdempotencyFingerprint({
    organizationId: request.organizationId,
    providerName: adapter.providerName,
    action: request.action,
    payloadRef: request.payloadRef,
    payloadDigest: request.payloadDigest,
  });
  const base = {
    action: request.action,
    organizationId: request.organizationId,
    provider: adapter.providerName,
    idempotencyKey: request.idempotencyKey,
    fingerprint,
    guardCode: 'NOT_EVALUATED',
    modelCallCount: 0 as const,
    externalWritePerformed: false as const,
  };
  const blocked = (
    reason: string,
    amount = 0,
    credentialRef: string | null = null,
    guardCode = base.guardCode,
  ): ActionPackOutcome => ({
    allowed: false,
    reason,
    disposition: 'BLOCKED',
    evidence: {
      ...base,
      guardCode,
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

  // ⓪ 授权来源：必须是 server-owned 共享 Action Guard；caller 无法自报
  if (!input.guard || typeof input.guard.evaluate !== 'function') {
    return blocked('ACTION_PACK_ACTION_GUARD_NOT_CONFIGURED', 0, null);
  }

  // ① adapter 契约
  const contract = assertProviderAdapter(adapter);
  if (!contract.ok) return blocked(contract.reason);

  // ② credential ref（trusted sandbox 不取真实凭据；其余必须 opaque 且绑定 provider/organization）
  const trustedSandbox = isTrustedSandboxProviderAdapter(adapter);
  let credentialRef: string | null = null;
  if (!trustedSandbox) {
    const resolved = await resolveProviderCredential(input.credentialPort ?? null, {
      providerName: adapter.providerName,
      organizationId: request.organizationId,
    });
    if (!resolved.ok) return blocked(resolved.reason);
    credentialRef = resolved.ref.credentialRef;
  }

  // ③ 共享 Action Guard 求值（真实执行链的一环）
  const guardResult = await input.guard.evaluate({
    action: request.action,
    actorUserId: input.actorUserId,
    organizationId: request.organizationId,
    ...((input.approvalRef ?? '').trim() === '' ? {} : { approvalId: String(input.approvalRef).trim() }),
  });
  const guardDecision = guardResult.decision;
  // 共享 Action Guard 的判定集为 ALLOW / DENY / REQUIRE_APPROVAL；本模块统一映射后再走 HITL。
  const hitlDecision: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' =
    guardDecision === 'ALLOW' ? 'ALLOW' : guardDecision === 'REQUIRE_APPROVAL' ? 'REQUIRES_APPROVAL' : 'DENY';
  if (hitlDecision === 'DENY') {
    return blocked('ACTION_GUARD_DENY:' + guardResult.code, 0, credentialRef, guardResult.code);
  }

  // ④ HITL：需要人工授权时，必须由共享 approval verifier 校验 approvalRef
  const hitl = decideHitlRequirement({ action: request.action, guardDecision: hitlDecision, riskClass: input.riskClass });
  if (hitl.decision === 'REQUIRED') {
    const approvalId = (input.approvalRef ?? '').trim();
    if (approvalId === '') {
      return blocked('HITL_APPROVAL_REQUIRED:' + hitl.reason, 0, credentialRef, guardResult.code);
    }
    try {
      await verifyApprovalOrThrow({
        verifier: input.approvalVerifier ?? undefined,
        query: {
          approvalId,
          organizationId: request.organizationId,
          action: request.action,
          actorUserId: input.actorUserId,
          targetRef: request.payloadRef,
        },
      });
    } catch (err) {
      const reason = String((err as { reason?: unknown })?.reason ?? 'VERIFIER_ERROR');
      return blocked('ACTION_GUARD_APPROVAL_NOT_VERIFIED:' + reason, 0, credentialRef, guardResult.code);
    }
  }

  // ⑤ external-write gate：外写动作一律 HOLD；sandbox 管道只允许 trusted provenance
  const gate = decideExternalWriteGate({
    adapter,
    request,
    transportEnabled: input.transportEnabled,
    guardDecision: hitlDecision,
  });
  if (isExternalWriteAction(request.action)) return blocked('EXTERNAL_WRITE_HOLD:' + gate.reason, 0, credentialRef, guardResult.code);
  if (!gate.allowed) {
    const sandboxOk = trustedSandbox && hitlDecision === 'ALLOW';
    if (!sandboxOk) return blocked(gate.reason, 0, credentialRef, guardResult.code);
  }

  // ⑥ exactly-once：先占「key + fingerprint」
  const begin = await input.idempotency.begin({ idempotencyKey: request.idempotencyKey, fingerprint });
  if (begin.outcome === 'CONFLICT') {
    return blocked('IDEMPOTENCY_KEY_CONFLICT', 0, credentialRef, guardResult.code);
  }
  if (begin.outcome === 'DUPLICATE') {
    const record = begin.record;
    return {
      allowed: true,
      reason: 'IDEMPOTENT_REPLAY',
      disposition: 'DUPLICATE_REPLAY',
      evidence: {
        ...base,
        guardCode: guardResult.code,
        status: record.status,
        reasonCodes: ['IDEMPOTENT_REPLAY'],
        attempts: record.attempts,
        credentialRef,
        evidenceRef: evidenceRefOf([request.idempotencyKey, 'REPLAY', record.status]),
      },
    };
  }

  // ⑦ provider invoke（出口唯一：只可能是 trusted sandbox adapter）
  const raw = await adapter.invoke(request);
  const result = normalizeProviderResult(raw);

  // ⑧ 结算
  const record: ProviderExecutionRecord = await input.idempotency.complete({
    idempotencyKey: request.idempotencyKey,
    status: result.status,
    providerRef: result.providerRef,
  });

  // ⑨ retry / reconcile
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
    guardCode: guardResult.code,
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
    return blocked('ACTION_PACK_EVIDENCE_CREDENTIAL_FIELDS', record.attempts, credentialRef, guardResult.code);
  }
  return { allowed: true, reason: 'ACTION_PACK_EXECUTED', disposition, evidence };
}
