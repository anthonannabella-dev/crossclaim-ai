/**
 * PHASE 6 U2 —— Controlled Adoption Execution Gate（EXECUTION_AUTHORIZATION_ONLY）
 * 冻结门来源：MSG-20261005-86 NEXT。只产出“可进入受控执行准备”的**授权契约**，
 * 不写配置、不 apply、不 mutate、不 rollout。真正配置 write 必须另开后续单元并重新裁决。
 *
 * 关键防线：
 *  - live config 只能来自 server-owned CurrentConfigStorePort（CUA：绝不接受 caller/request 自报 fingerprint）；
 *  - 双重 stale guard：live.configFingerprint === plan.expectedBaselineConfigFingerprint 且
 *    live.configValues[plan.path] === plan.from，否则 STALE_BASELINE（fail-closed）；
 *  - rollback anchor 固定 U2_BASELINE，禁止 LATEST / DEFAULT / CURRENT / HEAD；
 *  - reviewer gate：scope 精确 + role 白名单 + one ticket → one verdict + expiry/revoke/replay。
 */

import { createHash } from 'node:crypto';

import {
  isVerifiedControlledConfigProposal,
  isValidDeltaValue,
  TARGET_DELTA_PATHS,
} from './controlled-config-proposal';
import {
  isVerifiedControlledAdoptionPlan,
  type ControlledAdoptionPlan,
} from './controlled-adoption-plan';

export const CONTROLLED_EXECUTION_GATE_VERSION = 'controlled-execution-gate/v1';
export const CONTROLLED_EXECUTION_GATE_SCOPE = 'CONTROLLED_ADOPTION_EXECUTION_REVIEW';
export const CONTROLLED_EXECUTION_GATE_ROLES = ['EXTERNAL_JUDGE', 'HUMAN_OPERATOR'] as const;
export const CONTROLLED_EXECUTION_OUTCOMES = ['APPROVED', 'REJECTED'] as const;
export const CONTROLLED_EXECUTION_APPROVED_SEMANTICS = 'AUTHORIZED_FOR_CONTROLLED_EXECUTION_PREPARATION';
export const CONTROLLED_EXECUTION_REJECTED_SEMANTICS = 'REJECTED_NO_CONTROLLED_EXECUTION';
export const CONTROLLED_EXECUTION_FORBIDDEN_TARGET_LABELS = ['LATEST', 'DEFAULT', 'CURRENT', 'HEAD'] as const;

export const CONTROLLED_EXECUTION_GATE_BOUNDARY = {
  mode: 'EXECUTION_AUTHORIZATION_ONLY',
  planTrustGate:
    'isVerifiedControlledAdoptionPlan(plan) === true && plan.semantics === READY_FOR_CONTROLLED_EXECUTION_GATE_REVIEW',
  authorizationWindow:
    'plan.createdAt <= requestedAt <= expiresAt <= plan.expiresAt（过期 → EXECUTION_GATE_PLAN_EXPIRED；ticket 跨出 plan 生命周期 → EXECUTION_GATE_TICKET_EXCEEDS_PLAN_EXPIRY）',
  ticketLifetimeBoundedByPlan:
    'ticket.expiresAt <= plan.expiresAt（否则 EXECUTION_GATE_TICKET_EXCEEDS_PLAN_EXPIRY）',
  liveConfigSource: 'SERVER_OWNED_CURRENT_CONFIG_STORE（CUA：不得来自 HTTP body / caller 自报）',
  liveConfigReadShape: 'configFingerprint + configValues + capturedAt + version',
  staleGuard: 'double：live.configFingerprint === plan.expectedBaselineConfigFingerprint 且 live.configValues[plan.path] === plan.from（否则 STALE_BASELINE）',
  deltaReconfirmation: 'target/path/from/to 全部来自 verified plan；path 仍属 target allowlist；to 仍过 U3 value schema',
  rollbackAnchor: 'rollbackPlanDigest + expectedBaselineSnapshotDigest + expectedBaselineConfigFingerprint + rollbackTarget=U2_BASELINE',
  forbiddenRollbackLabels: CONTROLLED_EXECUTION_FORBIDDEN_TARGET_LABELS,
  scope: CONTROLLED_EXECUTION_GATE_SCOPE,
  roles: CONTROLLED_EXECUTION_GATE_ROLES,
  approvalSemantics: CONTROLLED_EXECUTION_APPROVED_SEMANTICS,
  rejectedSemantics: CONTROLLED_EXECUTION_REJECTED_SEMANTICS,
  apply: 'FORBIDDEN',
  execute: 'FORBIDDEN',
  configMutation: 'FORBIDDEN',
  productionRollout: 'FORBIDDEN',
  replayProtection: 'ONE_AUTHORIZATION_TICKET_TO_ONE_FINAL_VERDICT（digest-keyed）',
  expiry: 'ENFORCED',
  revocation: 'ENFORCED_ONE_WAY',
  binds: [
    'planDigest',
    'reviewVerdictDigest',
    'proposalDigest',
    'canaryEvaluationDigest',
    'rollbackPlanDigest',
    'target',
    'path',
    'from',
    'to',
    'liveConfigFingerprint',
    'livePathValue',
    'liveConfigCapturedAt',
    'liveConfigVersion',
    'requestedAt',
    'expiresAt',
    'nonce',
    'scope',
  ],
  liveConfigIdentityBinding:
    'ticketDigest preimage 绑定 liveConfigFingerprint + livePathValue + liveConfigCapturedAt + liveConfigVersion（durable 证明“依据的是哪次 read / 哪个 version”）',
  ticketProvenance: 'PROVENANCE_REGISTERED + fingerprint + deep-freeze',
  verdictProvenance: 'PROVENANCE_REGISTERED + fingerprint + deep-freeze（clone / 手造 APPROVED 不可信）',
  productionWrite: 'HOLD（真正写配置必须另开后续 execution 单元并重新裁决）',
} as const;

/** server-owned 端口：只读“当前正式配置”，由 composition root 注入，绝不来自 HTTP body。 */
export interface ControlledCurrentConfigRead {
  configFingerprint: string;
  configValues: Readonly<Record<string, string>>;
  capturedAt: string;
  version: string;
}

export interface ControlledCurrentConfigStorePort {
  read(target: string): Promise<ControlledCurrentConfigRead> | ControlledCurrentConfigRead;
}

export interface ControlledExecutionAuthorizationTicket {
  kind: 'CONTROLLED_EXECUTION_AUTHORIZATION_TICKET';
  mode: 'EXECUTION_AUTHORIZATION_ONLY';
  ticketId: string;
  ticketDigest: string;
  planDigest: string;
  reviewVerdictDigest: string;
  proposalDigest: string;
  canaryEvaluationDigest: string;
  rollbackPlanDigest: string;
  target: string;
  path: string;
  from: string;
  to: string;
  liveConfigFingerprint: string;
  livePathValue: string;
  liveConfigCapturedAt: string;
  liveConfigVersion: string;
  requestedAt: string;
  expiresAt: string;
  nonce: string;
  scope: typeof CONTROLLED_EXECUTION_GATE_SCOPE;
}

export interface ControlledExecutionAuthorizationVerdict {
  kind: 'CONTROLLED_EXECUTION_AUTHORIZATION_VERDICT';
  mode: 'EXECUTION_AUTHORIZATION_ONLY';
  verdictId: string;
  verdictDigest: string;
  ticketId: string;
  ticketDigest: string;
  outcome: 'APPROVED' | 'REJECTED';
  planDigest: string;
  reviewVerdictDigest: string;
  proposalDigest: string;
  canaryEvaluationDigest: string;
  rollbackPlanDigest: string;
  target: string;
  path: string;
  from: string;
  to: string;
  reviewerId: string;
  role: (typeof CONTROLLED_EXECUTION_GATE_ROLES)[number];
  scope: typeof CONTROLLED_EXECUTION_GATE_SCOPE;
  decidedAt: string;
  reason: string | null;
  semantics:
    | typeof CONTROLLED_EXECUTION_APPROVED_SEMANTICS
    | typeof CONTROLLED_EXECUTION_REJECTED_SEMANTICS;
  execution: {
    apply: 'FORBIDDEN';
    execute: 'FORBIDDEN';
    configMutation: 'FORBIDDEN';
    productionRollout: 'FORBIDDEN';
  };
}

const VERIFIED_AUTH_TICKETS = new WeakSet<ControlledExecutionAuthorizationTicket>();
const VERIFIED_AUTH_TICKET_FINGERPRINTS = new WeakMap<ControlledExecutionAuthorizationTicket, string>();
const VERIFIED_AUTH_VERDICTS = new WeakSet<ControlledExecutionAuthorizationVerdict>();
const VERIFIED_AUTH_VERDICT_FINGERPRINTS = new WeakMap<ControlledExecutionAuthorizationVerdict, string>();
const AUTH_DECIDED_TICKET_DIGESTS = new Set<string>();
const AUTH_REVOKED_TICKET_DIGESTS = new Set<string>();

const requireText = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const isIso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));

const ticketFingerprint = (t: ControlledExecutionAuthorizationTicket): string => JSON.stringify({ ...t });
const verdictFingerprint = (v: ControlledExecutionAuthorizationVerdict): string =>
  JSON.stringify({ ...v, execution: { ...v.execution } });

const freezeDeep = <T extends object>(value: T, nested: ReadonlyArray<object> = []): T => {
  nested.forEach((item) => Object.freeze(item));
  return Object.freeze(value);
};

export function isVerifiedControlledExecutionAuthorizationTicket(
  ticket: ControlledExecutionAuthorizationTicket | null | undefined,
): boolean {
  if (ticket === null || ticket === undefined) return false;
  if (!VERIFIED_AUTH_TICKETS.has(ticket)) return false;
  const fingerprint = VERIFIED_AUTH_TICKET_FINGERPRINTS.get(ticket);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === ticketFingerprint(ticket);
  } catch {
    return false;
  }
}

export function isVerifiedControlledExecutionAuthorizationVerdict(
  verdict: ControlledExecutionAuthorizationVerdict | null | undefined,
): boolean {
  if (verdict === null || verdict === undefined) return false;
  if (!VERIFIED_AUTH_VERDICTS.has(verdict)) return false;
  const fingerprint = VERIFIED_AUTH_VERDICT_FINGERPRINTS.get(verdict);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === verdictFingerprint(verdict);
  } catch {
    return false;
  }
}

const isForbiddenLabel = (v: string): boolean =>
  (CONTROLLED_EXECUTION_FORBIDDEN_TARGET_LABELS as readonly string[]).includes(v.toUpperCase());

const assertLiveConfigShape = (
  live: ControlledCurrentConfigRead | null | undefined,
  target: string,
): ControlledCurrentConfigRead => {
  if (live === null || live === undefined || typeof live !== 'object') {
    throw new Error('EXECUTION_GATE_LIVE_CONFIG_UNREADABLE:' + target);
  }
  const fingerprint = requireText(live.configFingerprint);
  const version = requireText(live.version);
  const values = live.configValues;
  const valuesOk = values !== null && typeof values === 'object' && !Array.isArray(values);
  if (fingerprint === '' || version === '' || !valuesOk || !isIso(live.capturedAt)) {
    throw new Error('EXECUTION_GATE_LIVE_CONFIG_UNREADABLE:' + target);
  }
  return live;
};

/**
 * Execution Gate 开票：只读验证 + 授权契约，**不写任何配置**。
 * live config 只能由 server-owned CurrentConfigStorePort 提供；caller 不能自报 fingerprint。
 */
export async function openControlledExecutionAuthorizationTicket(input: {
  plan: ControlledAdoptionPlan | null | undefined;
  configStore: ControlledCurrentConfigStorePort | null | undefined;
  reviewerScope: string;
  requestedAt: string;
  expiresAt: string;
  nonce: string;
} | null | undefined): Promise<ControlledExecutionAuthorizationTicket> {
  if (input === null || input === undefined) throw new Error('EXECUTION_GATE_INPUT_REQUIRED');

  // 1) Plan trust gate
  if (!isVerifiedControlledAdoptionPlan(input.plan)) throw new Error('EXECUTION_GATE_PLAN_NOT_VERIFIED');
  const plan = input.plan as ControlledAdoptionPlan;
  if (plan.semantics !== 'READY_FOR_CONTROLLED_EXECUTION_GATE_REVIEW') {
    throw new Error('EXECUTION_GATE_PLAN_SEMANTICS_INVALID:' + String(plan.semantics));
  }

  // 7) Reviewer scope（先于重活校验，避免无谓的外部读取）
  if (requireText(input.reviewerScope) !== CONTROLLED_EXECUTION_GATE_SCOPE) {
    throw new Error('EXECUTION_GATE_SCOPE_NOT_ALLOWED:' + requireText(input.reviewerScope));
  }
  const nonce = requireText(input.nonce);
  if (nonce === '') throw new Error('EXECUTION_GATE_NONCE_REQUIRED');

  // 时间窗：授权时间必须落在 plan 有效期内
  if (!isIso(input.requestedAt) || !isIso(input.expiresAt)) throw new Error('EXECUTION_GATE_SCHEDULE_INVALID');
  const requestedMs = Date.parse(input.requestedAt);
  const expiresMs = Date.parse(input.expiresAt);
  if (expiresMs <= requestedMs) throw new Error('EXECUTION_GATE_EXPIRY_INVALID');
  if (requestedMs < Date.parse(plan.createdAt)) throw new Error('EXECUTION_GATE_REQUESTED_BEFORE_PLAN_CREATED');
  if (requestedMs > Date.parse(plan.expiresAt)) throw new Error('EXECUTION_GATE_PLAN_EXPIRED');
  // AUTHORIZATION_WITHIN_PLAN_LIFETIME：授权不能活得比 Plan 更久（窄修 1）
  if (expiresMs > Date.parse(plan.expiresAt)) throw new Error('EXECUTION_GATE_TICKET_EXCEEDS_PLAN_EXPIRY');

  // 4) Delta 再确认（不重新创造 delta，只复核 verified plan 的值仍合法）
  const target = requireText(plan.target);
  const path = requireText(plan.path);
  const allowedPaths = (TARGET_DELTA_PATHS as Record<string, readonly string[]>)[target];
  if (allowedPaths === undefined || !allowedPaths.includes(path)) {
    throw new Error('EXECUTION_GATE_PATH_NOT_ALLOWED:' + target + ':' + path);
  }
  const to = requireText(plan.to);
  if (!isValidDeltaValue(path, to)) throw new Error('EXECUTION_GATE_TO_VALUE_INVALID:' + target + ':' + path);
  const from = requireText(plan.from);

  // 5) Rollback anchor 固定 U2_BASELINE
  const anchor = plan.rollbackTarget;
  if (
    anchor === null ||
    anchor === undefined ||
    requireText(anchor.target) !== 'U2_BASELINE' ||
    requireText(anchor.baselineSnapshotDigest) !== requireText(plan.expectedBaselineSnapshotDigest) ||
    requireText(anchor.baselineConfigFingerprint) !== requireText(plan.expectedBaselineConfigFingerprint)
  ) {
    throw new Error('EXECUTION_GATE_ROLLBACK_ANCHOR_INVALID');
  }
  if (
    isForbiddenLabel(requireText(anchor.target)) ||
    isForbiddenLabel(requireText(plan.rollbackPlanDigest)) ||
    isForbiddenLabel(requireText(anchor.baselineSnapshotDigest)) ||
    isForbiddenLabel(requireText(anchor.baselineConfigFingerprint))
  ) {
    throw new Error('EXECUTION_GATE_ROLLBACK_ANCHOR_INVALID:forbidden-label');
  }

  // 2) Server-owned live config read
  const store = input.configStore;
  if (store === null || store === undefined || typeof (store as { read?: unknown }).read !== 'function') {
    throw new Error('EXECUTION_GATE_CONFIG_STORE_REQUIRED');
  }
  const live = assertLiveConfigShape(await (store as ControlledCurrentConfigStorePort).read(target), target);

  // 3) 双重 stale guard
  const liveFingerprint = requireText(live.configFingerprint);
  if (liveFingerprint !== requireText(plan.expectedBaselineConfigFingerprint)) {
    throw new Error('STALE_BASELINE:fingerprint:' + liveFingerprint + '!=' + requireText(plan.expectedBaselineConfigFingerprint));
  }
  const livePathValue = requireText(live.configValues[path]);
  if (livePathValue !== from) {
    throw new Error('STALE_BASELINE:path-value:' + path + ':' + livePathValue + '!=' + from);
  }

  void isVerifiedControlledConfigProposal;

  // 6) Execution Authorization Ticket
  const ticketDigest = digest('controlled-execution-authorization-ticket', [
    CONTROLLED_EXECUTION_GATE_VERSION,
    plan.planDigest,
    plan.reviewVerdictDigest,
    plan.proposalDigest,
    plan.canaryEvaluationDigest,
    plan.rollbackPlanDigest,
    target,
    path,
    from,
    to,
    liveFingerprint,
    livePathValue,
    // LIVE_CONFIG_IDENTITY_DIGEST_BINDING：durable digest 必须证明依据的是哪一次 current-config read / 哪个 version（窄修 2）
    live.capturedAt,
    requireText(live.version),
    input.requestedAt,
    input.expiresAt,
    nonce,
    CONTROLLED_EXECUTION_GATE_SCOPE,
  ]);
  const ticket: ControlledExecutionAuthorizationTicket = {
    kind: 'CONTROLLED_EXECUTION_AUTHORIZATION_TICKET',
    mode: 'EXECUTION_AUTHORIZATION_ONLY',
    ticketId: 'controlled-execution-authorization:' + ticketDigest,
    ticketDigest,
    planDigest: plan.planDigest,
    reviewVerdictDigest: plan.reviewVerdictDigest,
    proposalDigest: plan.proposalDigest,
    canaryEvaluationDigest: plan.canaryEvaluationDigest,
    rollbackPlanDigest: plan.rollbackPlanDigest,
    target,
    path,
    from,
    to,
    liveConfigFingerprint: liveFingerprint,
    livePathValue,
    liveConfigCapturedAt: live.capturedAt,
    liveConfigVersion: requireText(live.version),
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    nonce,
    scope: CONTROLLED_EXECUTION_GATE_SCOPE,
  };
  freezeDeep(ticket);
  VERIFIED_AUTH_TICKETS.add(ticket);
  VERIFIED_AUTH_TICKET_FINGERPRINTS.set(ticket, ticketFingerprint(ticket));
  return ticket;
}

export function isControlledExecutionAuthorizationDecided(
  ticket: ControlledExecutionAuthorizationTicket | null | undefined,
): boolean {
  return ticket !== null && ticket !== undefined && AUTH_DECIDED_TICKET_DIGESTS.has(requireText(ticket.ticketDigest));
}

export function isControlledExecutionAuthorizationRevoked(
  ticket: ControlledExecutionAuthorizationTicket | null | undefined,
): boolean {
  return ticket !== null && ticket !== undefined && AUTH_REVOKED_TICKET_DIGESTS.has(requireText(ticket.ticketDigest));
}

export function revokeControlledExecutionAuthorization(
  ticket: ControlledExecutionAuthorizationTicket | null | undefined,
  revocation: { revokedBy: string; revokedAt: string; reason?: string | null },
): { ticketDigest: string; revokedBy: string; revokedAt: string; reason: string | null } {
  if (!isVerifiedControlledExecutionAuthorizationTicket(ticket)) throw new Error('EXECUTION_GATE_TICKET_NOT_VERIFIED');
  const verified = ticket as ControlledExecutionAuthorizationTicket;
  if (isControlledExecutionAuthorizationRevoked(verified)) throw new Error('EXECUTION_GATE_TICKET_ALREADY_REVOKED');
  if (isControlledExecutionAuthorizationDecided(verified)) throw new Error('EXECUTION_GATE_TICKET_ALREADY_DECIDED');
  const revokedBy = requireText(revocation?.revokedBy);
  if (revokedBy === '') throw new Error('EXECUTION_GATE_REVOCATION_ACTOR_REQUIRED');
  if (!isIso(revocation?.revokedAt)) throw new Error('EXECUTION_GATE_REVOCATION_TIME_INVALID');
  AUTH_REVOKED_TICKET_DIGESTS.add(verified.ticketDigest);
  return {
    ticketDigest: verified.ticketDigest,
    revokedBy,
    revokedAt: revocation.revokedAt,
    reason: requireText(revocation?.reason) || null,
  };
}

/**
 * 判决：只产出授权语义（APPROVED = AUTHORIZED_FOR_CONTROLLED_EXECUTION_PREPARATION），
 * 不 apply / 不 mutate / 不 rollout；真正写配置仍需后续独立单元。
 */
export function decideControlledExecutionAuthorization(
  ticket: ControlledExecutionAuthorizationTicket | null | undefined,
  decision: {
    reviewerId: string;
    role: (typeof CONTROLLED_EXECUTION_GATE_ROLES)[number];
    outcome: 'APPROVED' | 'REJECTED';
    decidedAt: string;
    reason?: string | null;
  },
): ControlledExecutionAuthorizationVerdict {
  if (!isVerifiedControlledExecutionAuthorizationTicket(ticket)) throw new Error('EXECUTION_GATE_TICKET_NOT_VERIFIED');
  const verified = ticket as ControlledExecutionAuthorizationTicket;
  if (isControlledExecutionAuthorizationRevoked(verified)) throw new Error('EXECUTION_GATE_VERDICT_TICKET_REVOKED');
  if (isControlledExecutionAuthorizationDecided(verified)) throw new Error('EXECUTION_GATE_VERDICT_REPLAY_BLOCKED');
  if (!CONTROLLED_EXECUTION_GATE_ROLES.includes(decision?.role)) throw new Error('EXECUTION_GATE_ROLE_NOT_ALLOWED');
  if (!CONTROLLED_EXECUTION_OUTCOMES.includes(decision?.outcome)) throw new Error('EXECUTION_GATE_OUTCOME_INVALID');
  const reviewerId = requireText(decision?.reviewerId);
  if (reviewerId === '') throw new Error('EXECUTION_GATE_REVIEWER_REQUIRED');
  if (!isIso(decision?.decidedAt)) throw new Error('EXECUTION_GATE_VERDICT_TIME_INVALID');
  const decidedMs = Date.parse(decision.decidedAt);
  if (decidedMs < Date.parse(verified.requestedAt)) throw new Error('EXECUTION_GATE_VERDICT_DECIDED_BEFORE_REQUEST');
  if (decidedMs > Date.parse(verified.expiresAt)) throw new Error('EXECUTION_GATE_VERDICT_TICKET_EXPIRED');

  const reason = requireText(decision?.reason) || null;
  const verdictDigest = digest('controlled-execution-authorization-verdict', [
    CONTROLLED_EXECUTION_GATE_VERSION,
    verified.ticketDigest,
    verified.planDigest,
    verified.reviewVerdictDigest,
    verified.proposalDigest,
    verified.canaryEvaluationDigest,
    verified.rollbackPlanDigest,
    verified.target,
    verified.path,
    verified.from,
    verified.to,
    verified.liveConfigFingerprint,
    verified.livePathValue,
    decision.outcome,
    reviewerId,
    decision.role,
    verified.scope,
    decision.decidedAt,
    reason ?? '',
  ]);
  const verdict: ControlledExecutionAuthorizationVerdict = {
    kind: 'CONTROLLED_EXECUTION_AUTHORIZATION_VERDICT',
    mode: 'EXECUTION_AUTHORIZATION_ONLY',
    verdictId: 'controlled-execution-authorization-verdict:' + verdictDigest,
    verdictDigest,
    ticketId: verified.ticketId,
    ticketDigest: verified.ticketDigest,
    outcome: decision.outcome,
    planDigest: verified.planDigest,
    reviewVerdictDigest: verified.reviewVerdictDigest,
    proposalDigest: verified.proposalDigest,
    canaryEvaluationDigest: verified.canaryEvaluationDigest,
    rollbackPlanDigest: verified.rollbackPlanDigest,
    target: verified.target,
    path: verified.path,
    from: verified.from,
    to: verified.to,
    reviewerId,
    role: decision.role,
    scope: verified.scope,
    decidedAt: decision.decidedAt,
    reason,
    semantics:
      decision.outcome === 'APPROVED'
        ? CONTROLLED_EXECUTION_APPROVED_SEMANTICS
        : CONTROLLED_EXECUTION_REJECTED_SEMANTICS,
    execution: {
      apply: 'FORBIDDEN',
      execute: 'FORBIDDEN',
      configMutation: 'FORBIDDEN',
      productionRollout: 'FORBIDDEN',
    },
  };
  freezeDeep(verdict, [verdict.execution]);
  VERIFIED_AUTH_VERDICTS.add(verdict);
  VERIFIED_AUTH_VERDICT_FINGERPRINTS.set(verdict, verdictFingerprint(verdict));
  AUTH_DECIDED_TICKET_DIGESTS.add(verified.ticketDigest);
  return verdict;
}

/**
 * 授权消费门：未来 execution 单元必须同时满足 verified + APPROVED + 授权语义，缺一 fail-closed。
 * 本单元只提供该断言，不提供任何 apply / mutate / rollout 入口。
 */
export function assertControlledExecutionPreparationAuthorized(
  verdict: ControlledExecutionAuthorizationVerdict | null | undefined,
): { ok: true; planDigest: string; semantics: string } {
  if (!isVerifiedControlledExecutionAuthorizationVerdict(verdict)) {
    throw new Error('EXECUTION_AUTHORIZATION_NOT_VERIFIED');
  }
  const verified = verdict as ControlledExecutionAuthorizationVerdict;
  if (verified.outcome !== 'APPROVED') throw new Error('EXECUTION_AUTHORIZATION_NOT_APPROVED:' + verified.outcome);
  if (verified.semantics !== CONTROLLED_EXECUTION_APPROVED_SEMANTICS) {
    throw new Error('EXECUTION_AUTHORIZATION_SEMANTICS_INVALID:' + verified.semantics);
  }
  if (
    verified.execution.apply !== 'FORBIDDEN' ||
    verified.execution.execute !== 'FORBIDDEN' ||
    verified.execution.configMutation !== 'FORBIDDEN' ||
    verified.execution.productionRollout !== 'FORBIDDEN'
  ) {
    throw new Error('EXECUTION_AUTHORIZATION_EXECUTION_NOT_FORBIDDEN');
  }
  return { ok: true, planDigest: verified.planDigest, semantics: verified.semantics };
}
