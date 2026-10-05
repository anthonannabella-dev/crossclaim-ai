/**
 * Recovery SI —— P2-C Option A：确定性 PREPARE（纯内存包预览，零落库）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-16（`P2_C_V1 = AUTHORIZED_WITH_CONDITIONS`、`P2_C_OPTION = A`、
 * `P2_C_PERSISTENCE = FORBIDDEN`、`P2_C_EXTERNAL_WRITE = FORBIDDEN`）。
 *
 * 固定路径（到此停止）：
 *   verified PREPARE action
 *     → tenant-scoped persisted facts（由注入的 fact source 提供）
 *     → buildRecoveryManifest()
 *     → serializeCanonicalManifest()（canonical JSON）
 *     → computePackageDigest()
 *     → optional in-memory PDF（renderManifestPdf）
 *     → return prepared package preview
 *
 * 硬约束：
 *   · 复用既有**纯函数**（`services/recovery/recovery-package.ts`）；
 *   · **禁止调用** `generateRecoveryPackage()` / `persistPackageArtifacts()` / `transitionRecoveryPackage()`
 *     以及任何 claim draft 的 DB mutation 路径；本模块**不引用 prisma**；
 *   · 返回对象**不是**数据库实体（`PreparedRecoveryPackagePreview`），并显式 `persisted = false`、
 *     `submitted = false`、`executionAuthorized = false`、`executorInvoked = false`；
 *   · 敏感边界：包内可以合法包含租户内部事实（claimItemId / caseId / normalizedRefs / evidenceId / 金额），
 *     但 `P2_C_TO_RSI_OUTCOME_SIGNAL = FORBIDDEN`、`P2_C_TO_MODEL_NETWORK = FORBIDDEN`；
 *     credential / token / raw provider payload / storage key / signed URL / bank·card secrets 一律拒绝；
 *   · 不要求 OWNER approval 前置（`P2_C_OWNER_APPROVAL_REQUIRED = NO`），但既有 RBAC / tenant / verified
 *     plan action / fresh facts 一项都不放宽；`READY_FOR_EXECUTION` 仍不是执行许可。
 */

import type { CustomerRecoveryState, RecoveryDomain } from './customer-recovery-state';
import { prioritizeOpportunities } from './recovery-prioritizer';
import type { RecoveryPlan, RecoveryPlanAction } from './recovery-planner';
import { createRecoveryToolRegistry, type RecoveryTool, type RecoveryToolRegistry } from './recovery-tool-registry';
import { verifyRecoveryPlan } from './recovery-verifier';
import {
  buildRecoveryManifest,
  computePackageDigest,
  RECOVERY_PACKAGE_DIGEST_VERSION,
  RECOVERY_PACKAGE_VERSION,
  renderManifestPdf,
  serializeCanonicalManifest,
  sha256Hex,
  type RecoveryManifest,
  type RecoveryManifestFactInput,
} from '../recovery/recovery-package';

/**
 * 逐 domain 的 PREPARE 工具名（与 planner 的 `pickTool(domain, 'PREPARE')` 语义一致；
 * 领域专属名字避免同一名字跨 domain 复用）。
 */
export const RECOVERY_PREPARE_TOOL = {
  PLATFORM: 'recovery.package_preview.prepare',
  CARRIER: 'recovery.carrier.package_preview.prepare',
  CUSTOMS: 'recovery.customs.package_preview.prepare',
  INDEPENDENT_SITE: 'recovery.independent_site.package_preview.prepare',
} as const;
export type RecoveryPrepareToolName = (typeof RECOVERY_PREPARE_TOOL)[keyof typeof RECOVERY_PREPARE_TOOL];

/** 静态 domain→PREPARE 绑定（planner / LLM 不得构造 service 名） */
export const RECOVERY_DOMAIN_PREPARE_TOOL: Record<RecoveryDomain, readonly RecoveryPrepareToolName[]> = {
  PLATFORM: [RECOVERY_PREPARE_TOOL.PLATFORM],
  CARRIER: [RECOVERY_PREPARE_TOOL.CARRIER],
  CUSTOMS: [RECOVERY_PREPARE_TOOL.CUSTOMS],
  INDEPENDENT_SITE: [RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE],
};

const PREPARE_TOOL_DOMAIN: Record<RecoveryPrepareToolName, RecoveryDomain> = {
  [RECOVERY_PREPARE_TOOL.PLATFORM]: 'PLATFORM',
  [RECOVERY_PREPARE_TOOL.CARRIER]: 'CARRIER',
  [RECOVERY_PREPARE_TOOL.CUSTOMS]: 'CUSTOMS',
  [RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE]: 'INDEPENDENT_SITE',
};

const ALL_PREPARE_TOOL_NAMES: readonly RecoveryPrepareToolName[] = [
  RECOVERY_PREPARE_TOOL.PLATFORM,
  RECOVERY_PREPARE_TOOL.CARRIER,
  RECOVERY_PREPARE_TOOL.CUSTOMS,
  RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE,
];

const SAFE_PREPARE_PROOF: RecoveryPrepareToolSafetyProof = {
  PURE_DETERMINISTIC: true,
  DB_WRITE: false,
  NETWORK: false,
  CREDENTIAL_READ: false,
  TENANT_SCOPED: true,
  PERSISTS_PACKAGE: false,
};

/** 安全证明（与 P2-B 同风格；注册时强校验） */
export interface RecoveryPrepareToolSafetyProof {
  PURE_DETERMINISTIC: true;
  DB_WRITE: false;
  NETWORK: false;
  CREDENTIAL_READ: false;
  TENANT_SCOPED: true;
  PERSISTS_PACKAGE: false;
}

export const RECOVERY_PREPARE_TOOL_SAFETY: Record<RecoveryPrepareToolName, RecoveryPrepareToolSafetyProof> = {
  [RECOVERY_PREPARE_TOOL.PLATFORM]: { ...SAFE_PREPARE_PROOF },
  [RECOVERY_PREPARE_TOOL.CARRIER]: { ...SAFE_PREPARE_PROOF },
  [RECOVERY_PREPARE_TOOL.CUSTOMS]: { ...SAFE_PREPARE_PROOF },
  [RECOVERY_PREPARE_TOOL.INDEPENDENT_SITE]: { ...SAFE_PREPARE_PROOF },
};

/** MSG-20261005-16 明确禁止调用的既有 API（同模块，极易 import 错） */
export const RECOVERY_PREPARE_FORBIDDEN_API_NAMES = [
  'generateRecoveryPackage',
  'persistPackageArtifacts',
  'transitionRecoveryPackage',
] as const;

/** tenant-scoped persisted facts：由 composition root 注入（本模块不读库） */
export interface RecoveryPrepareFactSource {
  load(input: { organizationId: string; opportunityRef: string }): Promise<RecoveryManifestFactInput | null>;
}

export interface PreparedRecoveryPackagePreview {
  kind: 'RECOVERY_PACKAGE_PREVIEW';
  opportunityRef: string;
  claimItemId: string;
  caseId: string | null;
  packageVersion: string;
  digestVersion: string;
  packageDigest: string;
  pdfDigest: string;
  pdfBytes: number;
  canonicalJson: string;
  manifest: RecoveryManifest;
  persisted: false;
  submitted: false;
  executionAuthorized: false;
  executorInvoked: false;
}

const SENSITIVE_KEY =
  /(secret|credential|password|passwd|token|api_?key|private_?key|storage_?key|signed_?url|download_?url|raw_?payload|raw_?provider|card_?number|cvv|iban|bank_?account)/i;

/** 敏感字段扫描（输出侧 fail-closed） */
export function scanPreparedPackage(candidate: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) found.push(`${path}.${key}`);
      walk(nested, `${path}.${key}`, depth + 1);
    }
  };
  walk(candidate, '$', 0);
  return found.sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requireNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

export interface RecoveryPrepareToolRegistryBundle {
  registry: RecoveryToolRegistry;
  registrationErrors: readonly { name: string; reason: string }[];
  safety: typeof RECOVERY_PREPARE_TOOL_SAFETY;
  invokeCounts: Readonly<Record<string, number>>;
  factLoadCount: () => number;
}

/**
 * 注册表工厂：唯一 PREPARE 工具 = 确定性包预览。
 * 传入的 `actorOrganizationId` 在**任何 fact 读取之前**与 input / ctx 做三角校验（B2 语义）。
 */
export function createRecoveryPrepareRegistry(
  deps: { facts: RecoveryPrepareFactSource; actorOrganizationId: string },
  options: { onInvoke?: (tool: string) => void } = {},
): RecoveryPrepareToolRegistryBundle {
  const invokeCounts: Record<string, number> = {};
  const registrationErrors: { name: string; reason: string }[] = [];
  let factLoadCount = 0;

  const buildPreview = async (
    input: { organizationId: string; opportunityRef: string },
    ctx: { organizationId: string },
  ): Promise<PreparedRecoveryPackagePreview> => {
    if (input.organizationId !== ctx.organizationId || input.organizationId !== deps.actorOrganizationId) {
      throw new Error('TENANT_MISMATCH:PREPARE_ACTOR');
    }
    factLoadCount += 1;
    const facts = await deps.facts.load({
      organizationId: input.organizationId,
      opportunityRef: input.opportunityRef,
    });
    if (facts === null) throw new Error('FACTS_NOT_FOUND');
    if (facts.organizationId !== input.organizationId) throw new Error('TENANT_MISMATCH:FACTS');

    // 复用既有纯函数（唯一事实载体 → canonical JSON → digest → 内存 PDF）
    const manifest = buildRecoveryManifest(facts);
    const canonicalJson = serializeCanonicalManifest(manifest);
    const packageDigest = computePackageDigest(manifest);
    const pdf = renderManifestPdf(manifest, packageDigest);
    const pdfDigest = sha256Hex(pdf);

    const preview: PreparedRecoveryPackagePreview = {
      kind: 'RECOVERY_PACKAGE_PREVIEW',
      opportunityRef: input.opportunityRef,
      claimItemId: manifest.claimItemId,
      caseId: manifest.caseId,
      packageVersion: manifest.packageVersion,
      digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
      packageDigest,
      pdfDigest,
      pdfBytes: pdf.byteLength,
      canonicalJson,
      manifest,
      persisted: false,
      submitted: false,
      executionAuthorized: false,
      executorInvoked: false,
    };
    const sensitive = scanPreparedPackage({ manifest, canonicalJson: undefined });
    if (sensitive.length > 0) throw new Error(`SENSITIVE_PACKAGE_CONTENT_REJECTED:${sensitive.join('|')}`);
    return preview;
  };

  const tools: RecoveryTool[] = [];
  for (const toolName of ALL_PREPARE_TOOL_NAMES) {
    const proof = RECOVERY_PREPARE_TOOL_SAFETY[toolName];
    const proofProblems: string[] = [];
    if (proof.PURE_DETERMINISTIC !== true) proofProblems.push('PURE_DETERMINISTIC');
    if (proof.DB_WRITE !== false) proofProblems.push('DB_WRITE');
    if (proof.NETWORK !== false) proofProblems.push('NETWORK');
    if (proof.CREDENTIAL_READ !== false) proofProblems.push('CREDENTIAL_READ');
    if (proof.TENANT_SCOPED !== true) proofProblems.push('TENANT_SCOPED');
    if (proof.PERSISTS_PACKAGE !== false) proofProblems.push('PERSISTS_PACKAGE');
    if (proofProblems.length > 0) {
      registrationErrors.push({ name: toolName, reason: `SAFETY_PROOF_MISMATCH:${proofProblems.join('|')}` });
      continue;
    }
    tools.push({
      name: toolName,
      domain: PREPARE_TOOL_DOMAIN[toolName],
      access: 'PREPARE',
      description:
        'deterministic in-memory recovery package preview (no persistence, no submission, no external write)',
      invoke: async (rawInput: unknown, ctx: { organizationId: string }) => {
        if (
          !isRecord(rawInput) ||
          !requireNonEmptyString(rawInput.organizationId) ||
          !requireNonEmptyString(rawInput.opportunityRef)
        ) {
          throw new Error('INPUT_SCHEMA_REJECTED:PREPARE');
        }
        invokeCounts[toolName] = (invokeCounts[toolName] ?? 0) + 1;
        options.onInvoke?.(toolName);
        return buildPreview(rawInput as unknown as { organizationId: string; opportunityRef: string }, ctx);
      },
    });
  }

  const registry = createRecoveryToolRegistry(tools);
  registrationErrors.push(...registry.registrationErrors);
  return {
    registry,
    registrationErrors,
    safety: RECOVERY_PREPARE_TOOL_SAFETY,
    invokeCounts,
    factLoadCount: () => factLoadCount,
  };
}

export type RecoveryPrepareSkipReason =
  | 'PLAN_NOT_VERIFIED'
  | 'NOT_A_PREPARE_ACTION'
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_ACCESS_NOT_PREPARE'
  | 'STALE_STATE';

export interface RecoveryPrepareSkip {
  opportunityRef: string;
  toolRef: string;
  reason: RecoveryPrepareSkipReason;
}

export interface RecoveryPrepareInvocation {
  tool: string;
  opportunityRef: string;
  ok: boolean;
  detail: string | null;
  preview: PreparedRecoveryPackagePreview | null;
}

export type RecoveryPrepareRunResult =
  | {
      ok: false;
      reason: 'TENANT_MISMATCH' | 'STALE_STATE';
      invocations: readonly RecoveryPrepareInvocation[];
      skipped: readonly RecoveryPrepareSkip[];
    }
  | { ok: true; invocations: readonly RecoveryPrepareInvocation[]; skipped: readonly RecoveryPrepareSkip[] };

const actionIsFresh = (
  action: RecoveryPlanAction,
  state: CustomerRecoveryState,
  nowMs: number,
  maxAgeMs: number,
): boolean => {
  const slice = state.opportunities.find((entry) => entry.opportunityRef === action.opportunityRef);
  if (slice === undefined) return false;
  const observedMs = Date.parse(slice.observedAt);
  return Number.isFinite(observedMs) && nowMs - observedMs <= maxAgeMs && observedMs <= nowMs;
};

/**
 * PREPARE 执行入口：只有**已验证**的 `PREPARE_PACKAGE` action 才可能触发；
 * 入口内部重新 verify（沿用 CHANGE B1），不接受外部 verification 快照。
 */
export async function prepareRecoveryPackages(input: {
  state: CustomerRecoveryState;
  plan: RecoveryPlan;
  registry: RecoveryToolRegistry;
  nowMs: number;
  maxSnapshotAgeMs?: number;
}): Promise<RecoveryPrepareRunResult> {
  const maxAgeMs = input.maxSnapshotAgeMs ?? 15 * 60 * 1000;
  const invocations: RecoveryPrepareInvocation[] = [];
  const skipped: RecoveryPrepareSkip[] = [];

  const tenantBroken =
    input.state.tenantVerified !== true ||
    input.plan.organizationId !== input.state.organizationId ||
    input.state.opportunities.some((slice) => slice.organizationId !== input.state.organizationId);
  if (tenantBroken) return { ok: false, reason: 'TENANT_MISMATCH', invocations, skipped };

  const observedMs = Date.parse(input.state.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > maxAgeMs || observedMs > input.nowMs) {
    return { ok: false, reason: 'STALE_STATE', invocations, skipped };
  }

  const priority = prioritizeOpportunities(input.state);
  const verification = verifyRecoveryPlan({
    plan: input.plan,
    state: input.state,
    registry: input.registry,
    priority,
    nowMs: input.nowMs,
    maxSnapshotAgeMs: maxAgeMs,
  });
  const verifiedKeys = new Set(
    (verification.ok ? verification.verifiedActions : []).map((action) => `${action.opportunityRef}|${action.proposedAction}`),
  );

  for (const action of input.plan.actions) {
    const boundTools = RECOVERY_DOMAIN_PREPARE_TOOL[action.domain];
    const key = `${action.opportunityRef}|${action.proposedAction}`;
    const skipAll = (reason: RecoveryPrepareSkipReason): void => {
      for (const toolRef of boundTools.length > 0 ? boundTools : ['(none)']) {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef, reason });
      }
    };

    if (!verification.ok || !verifiedKeys.has(key)) {
      skipAll('PLAN_NOT_VERIFIED');
      continue;
    }
    if (action.proposedAction !== 'PREPARE_PACKAGE') {
      skipAll('NOT_A_PREPARE_ACTION');
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
      if (listed === undefined || listed.access !== 'PREPARE') {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef: toolName, reason: 'TOOL_ACCESS_NOT_PREPARE' });
        continue;
      }
      const result = await input.registry.invoke<PreparedRecoveryPackagePreview>(
        toolName,
        { organizationId: input.state.organizationId, opportunityRef: action.opportunityRef },
        { organizationId: input.state.organizationId },
      );
      if (!result.ok) {
        invocations.push({
          tool: toolName,
          opportunityRef: action.opportunityRef,
          ok: false,
          detail: result.detail ?? result.reason,
          preview: null,
        });
        continue;
      }
      const preview = result.output;
      if (
        !isRecord(preview) ||
        preview.opportunityRef !== action.opportunityRef ||
        preview.persisted !== false ||
        preview.submitted !== false ||
        preview.executionAuthorized !== false ||
        preview.executorInvoked !== false
      ) {
        invocations.push({
          tool: toolName,
          opportunityRef: action.opportunityRef,
          ok: false,
          detail: 'PREVIEW_IDENTITY_OR_AUTHORIZATION_INVALID',
          preview: null,
        });
        continue;
      }
      invocations.push({ tool: toolName, opportunityRef: action.opportunityRef, ok: true, detail: null, preview });
    }
  }

  return { ok: true, invocations, skipped };
}

export const RECOVERY_PREPARE_BOUNDARY = {
  option: 'A' as const,
  pureDeterministicPrepare: true,
  inMemoryCanonicalManifest: true,
  inMemoryPackageDigest: true,
  inMemoryPdfDerivation: true,
  databasePersistence: false,
  recoveryPackageDbCreate: false,
  fileAssetCreate: false,
  claimDraftDbMutation: false,
  auditLogWrite: false,
  externalWrite: false,
  submission: false,
  networkCalls: 0,
  credentialReads: 0,
  tenantScoped: true,
  ownerApprovalRequired: false,
  customerFactsInternalAllowed: true,
  toRsiOutcomeSignal: false,
  toModelNetwork: false,
  l5Relaxation: false,
  secondRuntime: false,
  forbiddenApis: RECOVERY_PREPARE_FORBIDDEN_API_NAMES,
  runtimeWiring: 'NONE',
  packageVersion: RECOVERY_PACKAGE_VERSION,
} as const;
