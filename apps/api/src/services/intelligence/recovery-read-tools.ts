/**
 * Recovery SI —— P2-B：只读 Tool 实接（READ_ONLY · 零外写 · fail-closed）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-13（P2-B = AUTHORIZED_WITH_CONDITIONS）。调用路径被**固定**为：
 *
 *   verified RecoveryPlan action
 *     → explicit registered READ tool（静态绑定表，模型/planner 不得构造 service 名）
 *     → input schema（只有 organizationId + opportunityRef）
 *     → tenant context（registry 强制非空 organizationId）
 *     → existing deterministic read service（见 recovery-read-tool-adapters.ts）
 *     → output schema（字段/类型白名单）
 *     → sensitive-field scan（secret / credential / token / PII）
 *     → return to SI
 *
 * 每个 adapter 必须证明：`READ_ONLY = true / DB_WRITE = false / NETWORK = false /
 * CREDENTIAL_READ = false / TENANT_SCOPED = true`；证明与声明不符 → 拒绝注册（fail-closed）。
 * 继续沿用 Phase 1 语义：`UNKNOWN_TOOL / STALE_STATE / TENANT_MISMATCH = FAIL_CLOSED`。
 *
 * 本模块**不接线运行时**（无 route / event-loop 调用方），P2-C / P2-D 前不得自动执行。
 */

import type { CustomerRecoveryState, RecoveryDomain } from './customer-recovery-state';
import type { RecoveryPlan, RecoveryPlanAction } from './recovery-planner';
import { createRecoveryToolRegistry, type RecoveryTool, type RecoveryToolRegistry } from './recovery-tool-registry';
import type { RecoveryVerificationResult } from './recovery-verifier';

export const RECOVERY_READ_TOOL = {
  OPPORTUNITY: 'recovery.opportunity.read',
  EVIDENCE: 'recovery.evidence.read',
  CUSTOMS_AUTHORIZATION_READINESS: 'recovery.customs.authorization_readiness.read',
} as const;
export type RecoveryReadToolName = (typeof RECOVERY_READ_TOOL)[keyof typeof RECOVERY_READ_TOOL];

export interface RecoveryReadToolSafetyProof {
  READ_ONLY: true;
  DB_WRITE: false;
  NETWORK: false;
  CREDENTIAL_READ: false;
  TENANT_SCOPED: true;
}

const SAFE_READ_PROOF: RecoveryReadToolSafetyProof = {
  READ_ONLY: true,
  DB_WRITE: false,
  NETWORK: false,
  CREDENTIAL_READ: false,
  TENANT_SCOPED: true,
};

/** adapter 安全证明（逐工具；注册时强校验，任何一项不符 → 不注册） */
export const RECOVERY_READ_TOOL_SAFETY: Record<RecoveryReadToolName, RecoveryReadToolSafetyProof> = {
  [RECOVERY_READ_TOOL.OPPORTUNITY]: { ...SAFE_READ_PROOF },
  [RECOVERY_READ_TOOL.EVIDENCE]: { ...SAFE_READ_PROOF },
  [RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS]: { ...SAFE_READ_PROOF },
};

/**
 * domain → 允许调用的 READ 工具（**静态**，不由 plan/LLM 决定）。
 * planner 的 `action.toolRef` 只作为可读性提示，绝不是调用目标。
 */
export const RECOVERY_DOMAIN_READ_TOOL: Record<RecoveryDomain, readonly RecoveryReadToolName[]> = {
  PLATFORM: [RECOVERY_READ_TOOL.OPPORTUNITY, RECOVERY_READ_TOOL.EVIDENCE],
  CARRIER: [RECOVERY_READ_TOOL.OPPORTUNITY, RECOVERY_READ_TOOL.EVIDENCE],
  CUSTOMS: [RECOVERY_READ_TOOL.OPPORTUNITY, RECOVERY_READ_TOOL.EVIDENCE, RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS],
  INDEPENDENT_SITE: [RECOVERY_READ_TOOL.OPPORTUNITY, RECOVERY_READ_TOOL.EVIDENCE],
};

export interface RecoveryReadToolDomainMapping {
  OPPORTUNITY: 'PLATFORM' | 'CARRIER' | 'CUSTOMS' | 'INDEPENDENT_SITE' | 'SETTLEMENT' | 'PAYMENT' | 'CLAIM';
  EVIDENCE: 'PLATFORM' | 'CARRIER' | 'CUSTOMS' | 'INDEPENDENT_SITE' | 'SETTLEMENT' | 'PAYMENT' | 'CLAIM';
  CUSTOMS_AUTHORIZATION_READINESS: 'PLATFORM' | 'CARRIER' | 'CUSTOMS' | 'INDEPENDENT_SITE' | 'SETTLEMENT' | 'PAYMENT' | 'CLAIM';
}

export const RECOVERY_READ_TOOL_DOMAIN: RecoveryReadToolDomainMapping = {
  OPPORTUNITY: 'PLATFORM',
  EVIDENCE: 'CLAIM',
  CUSTOMS_AUTHORIZATION_READINESS: 'CUSTOMS',
};

export interface OpportunityReadOutput {
  opportunityRef: string;
  status: string;
  currency: string;
  hasRecoverableAmount: boolean;
  hasRuleEvaluation: boolean;
}

export interface EvidenceReadOutput {
  opportunityRef: string;
  caseRef: string | null;
  evidenceCount: number;
  kinds: readonly string[];
}

export interface CustomsAuthorizationReadinessReadOutput {
  opportunityRef: string;
  route: string;
  readyToFile: boolean;
  blockerCodes: readonly string[];
}

export interface RecoveryReadToolInput {
  organizationId: string;
  opportunityRef: string;
}

export interface RecoveryReadPorts {
  opportunityRead(input: RecoveryReadToolInput): Promise<OpportunityReadOutput>;
  evidenceRead(input: RecoveryReadToolInput): Promise<EvidenceReadOutput>;
  customsAuthorizationReadinessRead(input: RecoveryReadToolInput): Promise<CustomsAuthorizationReadinessReadOutput>;
}

const SENSITIVE_OUTPUT_KEY = /(secret|credential|password|passwd|token|api_?key|private_?key|file_?path|storage_?ref|download_?url|signed_?url|raw_?payload|source_?transaction)/i;
const EMAIL_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** 敏感字段扫描（输出侧第二道闸：registry 已拦 secret 类键，这里再拦文件/存储/邮箱等） */
export function scanRecoveryReadOutput(candidate: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (EMAIL_VALUE.test(value)) found.push(`${path}:EMAIL_VALUE`);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_OUTPUT_KEY.test(key)) found.push(`${path}.${key}:SENSITIVE_KEY`);
      walk(nested, `${path}.${key}`, depth + 1);
    }
  };
  walk(candidate, '$', 0);
  return found.sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const requireBoolean = (value: unknown): boolean => typeof value === 'boolean';
const requireNonNegativeInt = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const requireStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

interface RecoveryReadToolSpec {
  name: RecoveryReadToolName;
  description: string;
  validateOutput(candidate: unknown): readonly string[];
}

const READ_TOOL_SPECS: readonly RecoveryReadToolSpec[] = [
  {
    name: RECOVERY_READ_TOOL.OPPORTUNITY,
    description: 'read-only opportunity projection (no money truth recomputation, no canonical fact mutation)',
    validateOutput: (candidate) => {
      if (!isRecord(candidate)) return ['NOT_AN_OBJECT'];
      const problems: string[] = [];
      if (!requireString(candidate.opportunityRef)) problems.push('opportunityRef');
      if (!requireString(candidate.status)) problems.push('status');
      if (!requireString(candidate.currency)) problems.push('currency');
      if (!requireBoolean(candidate.hasRecoverableAmount)) problems.push('hasRecoverableAmount');
      if (!requireBoolean(candidate.hasRuleEvaluation)) problems.push('hasRuleEvaluation');
      return problems;
    },
  },
  {
    name: RECOVERY_READ_TOOL.EVIDENCE,
    description: 'read-only evidence metadata projection (no file content, no storage reference)',
    validateOutput: (candidate) => {
      if (!isRecord(candidate)) return ['NOT_AN_OBJECT'];
      const problems: string[] = [];
      if (!requireString(candidate.opportunityRef)) problems.push('opportunityRef');
      if (!(candidate.caseRef === null || requireString(candidate.caseRef))) problems.push('caseRef');
      if (!requireNonNegativeInt(candidate.evidenceCount)) problems.push('evidenceCount');
      if (!requireStringArray(candidate.kinds)) problems.push('kinds');
      return problems;
    },
  },
  {
    name: RECOVERY_READ_TOOL.CUSTOMS_AUTHORIZATION_READINESS,
    description: 'read-only customs authorization readiness projection (no filing, no transport, no credentials)',
    validateOutput: (candidate) => {
      if (!isRecord(candidate)) return ['NOT_AN_OBJECT'];
      const problems: string[] = [];
      if (!requireString(candidate.opportunityRef)) problems.push('opportunityRef');
      if (!requireString(candidate.route)) problems.push('route');
      if (!requireBoolean(candidate.readyToFile)) problems.push('readyToFile');
      if (!requireStringArray(candidate.blockerCodes)) problems.push('blockerCodes');
      return problems;
    },
  },
];

const specFor = (name: string): RecoveryReadToolSpec | undefined =>
  READ_TOOL_SPECS.find((spec) => spec.name === name);

const proveSafety = (name: RecoveryReadToolName): readonly string[] => {
  const proof = RECOVERY_READ_TOOL_SAFETY[name];
  const problems: string[] = [];
  if (proof.READ_ONLY !== true) problems.push('READ_ONLY');
  if (proof.DB_WRITE !== false) problems.push('DB_WRITE');
  if (proof.NETWORK !== false) problems.push('NETWORK');
  if (proof.CREDENTIAL_READ !== false) problems.push('CREDENTIAL_READ');
  if (proof.TENANT_SCOPED !== true) problems.push('TENANT_SCOPED');
  return problems;
};

export interface RecoveryReadToolRegistryBundle {
  registry: RecoveryToolRegistry;
  registrationErrors: readonly { name: string; reason: string }[];
  safety: typeof RECOVERY_READ_TOOL_SAFETY;
  invokeCounts: Readonly<Record<string, number>>;
}

/**
 * 只读工具注册表工厂。所有 `invoke` 只可能调用**注入的 port**（生产 port 见 adapters），
 * 且调用前显式校验 `input.organizationId === ctx.organizationId`（跨租户 → 抛错 → TOOL_THREW）。
 */
export function createRecoveryReadToolRegistry(
  ports: RecoveryReadPorts,
  options: { onInvoke?: (tool: string) => void } = {},
): RecoveryReadToolRegistryBundle {
  const invokeCounts: Record<string, number> = {};
  const registrationErrors: { name: string; reason: string }[] = [];
  const tools: RecoveryTool[] = [];

  const guard = (name: RecoveryReadToolName, run: (input: RecoveryReadToolInput, ctx: { organizationId: string }) => Promise<unknown>) => async (
    rawInput: unknown,
    ctx: { organizationId: string },
  ): Promise<unknown> => {
    if (!isRecord(rawInput) || !requireString(rawInput.organizationId) || !requireString(rawInput.opportunityRef)) {
      throw new Error(`INPUT_SCHEMA_REJECTED:${name}`);
    }
    const input = rawInput as unknown as RecoveryReadToolInput;
    if (input.organizationId !== ctx.organizationId) {
      throw new Error(`TENANT_MISMATCH:${name}`);
    }
    invokeCounts[name] = (invokeCounts[name] ?? 0) + 1;
    options.onInvoke?.(name);
    const output = await run(input, ctx);
    const problems = specFor(name)?.validateOutput(output) ?? ['NO_SPEC'];
    if (problems.length > 0) throw new Error(`OUTPUT_SCHEMA_REJECTED:${name}:${problems.join('|')}`);
    const sensitive = scanRecoveryReadOutput(output);
    if (sensitive.length > 0) throw new Error(`SENSITIVE_OUTPUT_REJECTED:${name}:${sensitive.join('|')}`);
    return output;
  };

  for (const spec of READ_TOOL_SPECS) {
    const proofProblems = proveSafety(spec.name);
    if (proofProblems.length > 0) {
      registrationErrors.push({ name: spec.name, reason: `SAFETY_PROOF_MISMATCH:${proofProblems.join('|')}` });
      continue;
    }
    const domainKey = spec.name === RECOVERY_READ_TOOL.OPPORTUNITY
      ? 'OPPORTUNITY'
      : spec.name === RECOVERY_READ_TOOL.EVIDENCE
        ? 'EVIDENCE'
        : 'CUSTOMS_AUTHORIZATION_READINESS';
    tools.push({
      name: spec.name,
      domain: RECOVERY_READ_TOOL_DOMAIN[domainKey],
      access: 'READ',
      description: spec.description,
      invoke: guard(
        spec.name,
        spec.name === RECOVERY_READ_TOOL.OPPORTUNITY
          ? (input) => ports.opportunityRead(input)
          : spec.name === RECOVERY_READ_TOOL.EVIDENCE
            ? (input) => ports.evidenceRead(input)
            : (input) => ports.customsAuthorizationReadinessRead(input),
      ),
    });
  }

  const registry = createRecoveryToolRegistry(tools);
  registrationErrors.push(...registry.registrationErrors);
  return { registry, registrationErrors, safety: RECOVERY_READ_TOOL_SAFETY, invokeCounts };
}

export type RecoveryReadSkipReason =
  | 'PLAN_NOT_VERIFIED'
  | 'NO_DOMAIN_BINDING'
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_ACCESS_NOT_READ'
  | 'STALE_STATE'
  | 'INPUT_SCHEMA_REJECTED';

export interface RecoveryReadSkip {
  opportunityRef: string;
  toolRef: string;
  reason: RecoveryReadSkipReason;
}

export type RecoveryReadInvocationReason =
  | 'TOOL_THREW'
  | 'INPUT_SCHEMA_REJECTED'
  | 'TENANT_MISMATCH'
  | 'OUTPUT_SCHEMA_REJECTED'
  | 'SENSITIVE_OUTPUT_REJECTED'
  | 'FORBIDDEN_TOOL_OUTPUT'
  | 'TOOL_NOT_REGISTERED'
  | 'TENANT_CONTEXT_REQUIRED';

export interface RecoveryReadInvocation {
  tool: string;
  opportunityRef: string;
  ok: boolean;
  reason: RecoveryReadInvocationReason | null;
  detail: string | null;
  output: unknown;
}

export type RecoveryReadRunResult =
  | {
      ok: false;
      reason: 'TENANT_MISMATCH' | 'STALE_STATE';
      invocations: readonly RecoveryReadInvocation[];
      skipped: readonly RecoveryReadSkip[];
    }
  | { ok: true; invocations: readonly RecoveryReadInvocation[]; skipped: readonly RecoveryReadSkip[] };

const describeError = (reason: string, detail: string | undefined): string => detail ?? reason;

const READ_INVOCATION_REASONS: readonly RecoveryReadInvocationReason[] = [
  'TOOL_THREW',
  'INPUT_SCHEMA_REJECTED',
  'TENANT_MISMATCH',
  'OUTPUT_SCHEMA_REJECTED',
  'SENSITIVE_OUTPUT_REJECTED',
  'FORBIDDEN_TOOL_OUTPUT',
  'TOOL_NOT_REGISTERED',
  'TENANT_CONTEXT_REQUIRED',
];

/** registry 的失败原因 → P2-B 记录的稳定原因码（未知一律按 TOOL_THREW 处理） */
const mapInvokeReason = (reason: string): RecoveryReadInvocationReason =>
  (READ_INVOCATION_REASONS as readonly string[]).includes(reason) ? (reason as RecoveryReadInvocationReason) : 'TOOL_THREW';

const actionIsFresh = (action: RecoveryPlanAction, state: CustomerRecoveryState, nowMs: number, maxAgeMs: number): boolean => {
  const slice = state.opportunities.find((entry) => entry.opportunityRef === action.opportunityRef);
  if (slice === undefined) return false;
  const observedMs = Date.parse(slice.observedAt);
  return Number.isFinite(observedMs) && nowMs - observedMs <= maxAgeMs && observedMs <= nowMs;
};

/**
 * 只读执行入口：只有**已验证**的 plan action 才可能触发只读工具调用。
 * 未通过验证的 action（篡改/陈旧/跨租户/未登记）一律不调用工具。
 */
export async function runRecoveryReadTools(input: {
  state: CustomerRecoveryState;
  plan: RecoveryPlan;
  verification: RecoveryVerificationResult;
  registry: RecoveryToolRegistry;
  nowMs: number;
  maxSnapshotAgeMs?: number;
}): Promise<RecoveryReadRunResult> {
  const maxAgeMs = input.maxSnapshotAgeMs ?? 15 * 60 * 1000;
  const invocations: RecoveryReadInvocation[] = [];
  const skipped: RecoveryReadSkip[] = [];

  const tenantBroken =
    input.state.tenantVerified !== true ||
    input.plan.organizationId !== input.state.organizationId ||
    input.state.opportunities.some((slice) => slice.organizationId !== input.state.organizationId);
  if (tenantBroken) return { ok: false, reason: 'TENANT_MISMATCH', invocations, skipped };

  const observedMs = Date.parse(input.state.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > maxAgeMs || observedMs > input.nowMs) {
    return { ok: false, reason: 'STALE_STATE', invocations, skipped };
  }

  const verifiedActions = input.verification.ok ? input.verification.verifiedActions : [];
  const verifiedKeys = new Set(verifiedActions.map((action) => `${action.opportunityRef}|${action.proposedAction}`));

  for (const action of input.plan.actions) {
    const boundTools = RECOVERY_DOMAIN_READ_TOOL[action.domain];
    const verificationKey = `${action.opportunityRef}|${action.proposedAction}`;
    const skipAll = (reason: RecoveryReadSkipReason): void => {
      for (const toolRef of boundTools.length > 0 ? boundTools : ['(none)']) {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef, reason });
      }
    };

    if (!input.verification.ok || !verifiedKeys.has(verificationKey)) {
      skipAll('PLAN_NOT_VERIFIED');
      continue;
    }
    if (boundTools.length === 0) {
      skipAll('NO_DOMAIN_BINDING');
      continue;
    }
    if (!actionIsFresh(action, input.state, input.nowMs, maxAgeMs)) {
      skipAll('STALE_STATE');
      continue;
    }

    for (const toolName of boundTools) {
      if (!input.registry.has(toolName)) {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef: toolName, reason: 'TOOL_NOT_REGISTERED' });
        continue;
      }
      const listed = input.registry.list().find((entry) => entry.name === toolName);
      if (listed === undefined || listed.access !== 'READ') {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef: toolName, reason: 'TOOL_ACCESS_NOT_READ' });
        continue;
      }
      const readInput: RecoveryReadToolInput = {
        organizationId: input.state.organizationId,
        opportunityRef: action.opportunityRef,
      };
      const spec = specFor(toolName);
      if (spec === undefined) {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef: toolName, reason: 'INPUT_SCHEMA_REJECTED' });
        continue;
      }
      const result = await input.registry.invoke<unknown>(toolName, readInput, {
        organizationId: input.state.organizationId,
      });
      if (!result.ok) {
        const detail = describeError(result.reason, result.detail);
        invocations.push({
          tool: toolName,
          opportunityRef: action.opportunityRef,
          ok: false,
          reason: mapInvokeReason(result.reason),
          detail,
          output: null,
        });
        continue;
      }
      invocations.push({
        tool: toolName,
        opportunityRef: action.opportunityRef,
        ok: true,
        reason: null,
        detail: null,
        output: result.output,
      });
    }
  }

  return { ok: true, invocations, skipped };
}

export const RECOVERY_READ_TOOLS_BOUNDARY = {
  readOnly: true,
  databaseWrites: 0,
  networkCalls: 0,
  credentialReads: 0,
  tenantScoped: true,
  modelCannotInventToolNames: true,
  staticDomainBinding: true,
  invokeOnlyVerifiedActions: true,
  unknownToolFailsClosed: true,
  staleStateFailsClosed: true,
  tenantMismatchFailsClosed: true,
  sensitiveOutputFailsClosed: true,
  runtimeWiring: 'NONE',
  phase2ToolAccess: 'READ_ONLY',
  prepareToolsAuthorized: false,
} as const;
