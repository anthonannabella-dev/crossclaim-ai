// STANDING AUTHORIZATION — SA-3b — 调用点解析器（把持久化授权 + 风险分级 + gate 快照组合成可用判定）
// ---------------------------------------------------------------------------
// 真实调用点（hitl-submission / action-pack-runtime / settlement·billing 等）只需要拿到：
//   `{ decision, authorizedBy, satisfiedGates, action }`，即可把它作为 `standingAuthorization`
//   传给既有 `verifyApprovalOrThrow` / `withActionGuard`（SA-3 已支持的参数）。
// 本模块负责该判定的**唯一来源**（不新建第二套 Guard，只组合既有 Action Guard 语义与风险分级）。
//
// 语义（fail-closed）：
//   ① 没有可用授权：
//      - 调用方未声明自动执行（`requestedAutoExecution=false`）→ 返回 `null`（**行为与既有完全一致**，仍走一次性审批）；
//      - 调用方声明自动执行 → `DENY`（不得在没有授权时自动执行）。
//   ② 授权存在但被撤销 / 过期 / 未生效 / 篡改 / 范围或身份不匹配：
//      - 声明自动执行 → `DENY`（旧授权不得继续使用）；
//      - 未声明 → `null`（一次性人工审批路径不受影响）。
//   ③ 授权有效但超范围 / 高金额 / 受监管 / 证据冲突 / 无历史置信度 → `REQUIRE_APPROVAL`（回退 HITL）。
//   ④ 授权有效且 TIER_0/TIER_1 且非可绕过 gate 全部满足 → `ALLOW`（authorizedBy=STANDING_AUTHORIZATION）。

import type { ExperienceDecisionSupport } from '../experience-memory/experience-memory';
import {
  evaluateAutonomousExecution,
  type NonBypassableGateSnapshot,
} from './action-guard-wiring';
import { classifyRiskTier } from './risk-tier-policy';
import {
  evaluateStandingAuthorization,
  type StandingAuthorizationRecord,
  type StandingAuthorizationRequest,
} from './standing-authorization';

export const STANDING_AUTHORIZATION_RESOLVER_VERSION = 'standing-authorization-resolver/v1';

export interface StandingAuthorizationLookupQuery {
  organizationId: string;
  platformAccountId: string;
  provider: string;
}

export interface StandingAuthorizationResolverDeps {
  /** 只读加载该 scope 下的授权（server-derived 存储；不外泄原始行） */
  loadAuthorization: (
    query: StandingAuthorizationLookupQuery,
  ) => Promise<StandingAuthorizationRecord | null>;
}

/** 与 `verifyApprovalOrThrow` 的 `standingAuthorization` 参数完全同构 */
export interface StandingAuthorizationAlternative {
  decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  authorizedBy: 'ONE_TIME_APPROVAL' | 'STANDING_AUTHORIZATION' | 'NONE';
  satisfiedGates: readonly string[];
  action: string;
}

export interface ResolveStandingAuthorizationInput {
  deps: StandingAuthorizationResolverDeps;
  request: StandingAuthorizationRequest;
  /** 调用方是否声明「按自动执行处理」——声明后授权不可用即 fail-closed */
  requestedAutoExecution: boolean;
  riskContext: {
    evidence: { completeness: 'COMPLETE' | 'PARTIAL' | 'MISSING'; conflicts: readonly string[] };
    experienceDecisionSupport: ExperienceDecisionSupport | null;
    experienceSuccessRateBp: number | null;
    providerTermsFlags?: readonly string[];
    regulatoryFlags?: readonly string[];
  };
  /** 非可绕过 gate 快照（来自既有 control plane / provider / POA readiness；未提供项不参与阻断） */
  gates: NonBypassableGateSnapshot;
  /** 既有 Action Guard 的判定（调用点已在之前求值；用于保持 Guard 权威） */
  guard: {
    decision: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
    code: string;
    action: string;
    risk: string;
    requiredGates: readonly string[];
  };
  now: Date;
}

export async function resolveStandingAuthorizationAlternative(
  input: ResolveStandingAuthorizationInput,
): Promise<StandingAuthorizationAlternative | null> {
  const authorization = await input.deps.loadAuthorization({
    organizationId: input.request.organizationId,
    platformAccountId: input.request.platformAccountId,
    provider: input.request.provider,
  });

  const deny = (): StandingAuthorizationAlternative => ({
    decision: 'DENY',
    authorizedBy: 'NONE',
    satisfiedGates: [],
    action: input.request.action,
  });
  const requireApproval = (): StandingAuthorizationAlternative => ({
    decision: 'REQUIRE_APPROVAL',
    authorizedBy: 'NONE',
    satisfiedGates: [],
    action: input.request.action,
  });

  if (authorization === null) {
    // 未声明自动执行 → 不改变既有行为（仍走一次性审批）
    return input.requestedAutoExecution ? deny() : null;
  }

  const evaluation = evaluateStandingAuthorization({
    authorization,
    request: input.request,
    now: input.now,
  });

  if (evaluation.decision === 'DENY') {
    // 无效 / 撤销 / 过期 / 未生效 / 篡改 / 身份与范围不匹配
    return input.requestedAutoExecution ? deny() : null;
  }

  if (evaluation.decision === 'REQUIRE_APPROVAL') {
    // 超范围 / 金额超限 / 金额未知 → 一律交回 HITL
    return requireApproval();
  }

  const riskTier = classifyRiskTier(
    {
      action: input.request.action,
      amountUsd: input.request.amountUsd,
      provider: input.request.provider,
      domain: input.request.domain,
      jurisdiction: input.request.jurisdiction,
      evidence: input.riskContext.evidence,
      authorization: { valid: true, withinScope: true, amountWithinLimit: true },
      experienceDecisionSupport: input.riskContext.experienceDecisionSupport,
      experienceSuccessRateBp: input.riskContext.experienceSuccessRateBp,
      providerTermsFlags: input.riskContext.providerTermsFlags ?? [],
      regulatoryFlags: input.riskContext.regulatoryFlags ?? [],
    },
    input.now,
  );

  const decision = evaluateAutonomousExecution({
    guard: {
      decision: input.guard.decision,
      code: input.guard.code,
      action: input.guard.action,
      risk: input.guard.risk as never,
      requiredGates: input.guard.requiredGates as never,
    },
    authorization,
    request: input.request,
    riskTier,
    gates: input.gates,
    now: input.now,
  });

  if (decision.decision === 'ALLOW' && decision.authorizedBy === 'STANDING_AUTHORIZATION') {
    return {
      decision: 'ALLOW',
      authorizedBy: 'STANDING_AUTHORIZATION',
      satisfiedGates: decision.satisfiedGates,
      action: input.request.action,
    };
  }
  if (decision.decision === 'DENY') return deny();
  return requireApproval();
}

export const STANDING_AUTHORIZATION_RESOLVER_BOUNDARY = {
  singleSourceOfDecision: true,
  createsSecondGuard: false,
  reusesExistingActionGuard: true,
  silentCallersUnaffected: true,
  autoExecutionWithoutAuthorizationIsDenied: true,
  revokedOrExpiredNeverAutoExecutes: true,
  highValueAndRegulatedFallBackToHitl: true,
  nonBypassableGatesStillApply: true,
} as const;

