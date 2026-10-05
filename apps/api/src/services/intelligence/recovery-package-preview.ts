/**
 * Recovery SI —— P2-C Option A：确定性 PREPARE（纯内存包预览，零落库）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-16（Option A 批准）+ MSG-20261005-17（REVISE：C1/C2/C3）。
 *
 * 固定路径（到此停止）：
 *   verified PREPARE action
 *     → **可信** PREPARE registry（C1：只能来自 createRecoveryPrepareRegistry 的闭包品牌）
 *     → tenant 三角校验（input / ctx / actor）
 *     → fact source 读取 { opportunityRef, fact }（C2：身份 + 金额与 verified 切片一致）
 *     → buildRecoveryManifest → serializeCanonicalManifest → computePackageDigest → 内存 PDF
 *     → validatePreparedRecoveryPackagePreview + 敏感扫描（C3：key 与字符串值都扫）
 *     → 返回 PreparedRecoveryPackagePreview
 *
 * 硬约束：零落库、零外写、零 submission、零 provider、零凭据；不得调用
 * `generateRecoveryPackage() / persistPackageArtifacts() / transitionRecoveryPackage()`；
 * 不引用 `@prisma/client`。
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

export const RECOVERY_PREPARE_TOOL = {
  PLATFORM: 'recovery.package_preview.prepare',
  CARRIER: 'recovery.carrier.package_preview.prepare',
  CUSTOMS: 'recovery.customs.package_preview.prepare',
  INDEPENDENT_SITE: 'recovery.independent_site.package_preview.prepare',
} as const;
export type RecoveryPrepareToolName = (typeof RECOVERY_PREPARE_TOOL)[keyof typeof RECOVERY_PREPARE_TOOL];

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

export interface RecoveryPrepareToolSafetyProof {
  PURE_DETERMINISTIC: true;
  DB_WRITE: false;
  NETWORK: false;
  CREDENTIAL_READ: false;
  TENANT_SCOPED: true;
  PERSISTS_PACKAGE: false;
}

const SAFE_PREPARE_PROOF: RecoveryPrepareToolSafetyProof = {
  PURE_DETERMINISTIC: true,
  DB_WRITE: false,
  NETWORK: false,
  CREDENTIAL_READ: false,
  TENANT_SCOPED: true,
  PERSISTS_PACKAGE: false,
};

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

/** C2：fact source 必须同时返回身份与事实 */
export interface RecoveryPrepareFact {
  opportunityRef: string;
  fact: RecoveryManifestFactInput;
}

export interface RecoveryPrepareFactSource {
  load(input: { organizationId: string; opportunityRef: string }): Promise<RecoveryPrepareFact | null>;
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

export interface RecoveryPrepareToolInput {
  organizationId: string;
  opportunityRef: string;
  expectedCurrency: string;
  expectedRecoverableAmount: string;
}

/** C1：可信 registry 品牌（只有工厂创建的实例在 WeakSet 里） */
const TRUSTED_PREPARE_REGISTRIES = new WeakSet<object>();

export interface RecoveryPrepareRegistry {
  readonly kind: 'RECOVERY_PREPARE_REGISTRY';
  /** 供 planner `pickTool(domain, 'PREPARE')` 使用的通用注册表视图 */
  readonly registry: RecoveryToolRegistry;
  readonly proofs: Readonly<Record<RecoveryPrepareToolName, RecoveryPrepareToolSafetyProof>>;
}

export function isTrustedPrepareRegistry(candidate: unknown): candidate is RecoveryPrepareRegistry {
  if (typeof candidate !== 'object' || candidate === null) return false;
  if (!TRUSTED_PREPARE_REGISTRIES.has(candidate)) return false;
  const record = candidate as Partial<RecoveryPrepareRegistry>;
  return record.kind === 'RECOVERY_PREPARE_REGISTRY' && typeof record.registry === 'object' && record.registry !== null;
}

/** C3：敏感扫描（key **与字符串值**都扫） */
const SENSITIVE_KEY =
  /(secret|credential|password|passwd|token|api_?key|private_?key|storage_?key|signed_?url|download_?url|raw_?payload|raw_?provider|card_?number|cvv|iban|bank_?account)/i;
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
  /[?&](?:X-Amz-Signature|Signature|token|access_token|refresh_token|api_key|key)=[^&\s]+/i,
  /\bsk-[A-Za-z0-9]{12,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT-ish
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/, // IBAN-ish
  /\b(?:\d[ -]?){13,19}\b/, // 卡号样式（13–19 位数字）
];

export function scanPreparedPackage(candidate: unknown): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const pattern of SENSITIVE_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          found.push(`${path}:SENSITIVE_VALUE`);
          return;
        }
      }
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) found.push(`${path}.${key}:SENSITIVE_KEY`);
      walk(nested, `${path}.${key}`, depth + 1);
    }
  };
  walk(candidate, '$', 0);
  return found.sort();
}

export type PreparedPreviewViolation =
  | 'NOT_AN_OBJECT'
  | 'WRONG_KIND'
  | 'OPPORTUNITY_MISMATCH'
  | 'PERSISTED_FLAG'
  | 'SUBMITTED_FLAG'
  | 'EXECUTION_AUTHORIZED_FLAG'
  | 'EXECUTOR_INVOKED_FLAG'
  | 'PACKAGE_VERSION_MISMATCH'
  | 'DIGEST_VERSION_MISMATCH'
  | 'DIGEST_FORMAT'
  | 'DIGEST_MISMATCH'
  | 'CANONICAL_JSON_MISMATCH'
  | 'PDF_DIGEST_FORMAT'
  | 'PDF_BYTES_INVALID'
  | 'MANIFEST_MISSING'
  | 'SENSITIVE_CONTENT';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const requireNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * C3：统一 preview validator —— 工厂工具与执行入口**共用**。
 * 外部（不可信）registry 返回的 preview 也必须过这一关。
 */
export function validatePreparedRecoveryPackagePreview(
  candidate: unknown,
  expected: { opportunityRef: string },
): readonly PreparedPreviewViolation[] {
  const violations: PreparedPreviewViolation[] = [];
  if (!isRecord(candidate)) return ['NOT_AN_OBJECT'];
  if (candidate.kind !== 'RECOVERY_PACKAGE_PREVIEW') violations.push('WRONG_KIND');
  if (candidate.opportunityRef !== expected.opportunityRef) violations.push('OPPORTUNITY_MISMATCH');
  if (candidate.persisted !== false) violations.push('PERSISTED_FLAG');
  if (candidate.submitted !== false) violations.push('SUBMITTED_FLAG');
  if (candidate.executionAuthorized !== false) violations.push('EXECUTION_AUTHORIZED_FLAG');
  if (candidate.executorInvoked !== false) violations.push('EXECUTOR_INVOKED_FLAG');
  if (candidate.packageVersion !== RECOVERY_PACKAGE_VERSION) violations.push('PACKAGE_VERSION_MISMATCH');
  if (candidate.digestVersion !== RECOVERY_PACKAGE_DIGEST_VERSION) violations.push('DIGEST_VERSION_MISMATCH');
  if (typeof candidate.packageDigest !== 'string' || !HEX64.test(candidate.packageDigest)) violations.push('DIGEST_FORMAT');
  if (typeof candidate.pdfDigest !== 'string' || !HEX64.test(candidate.pdfDigest)) violations.push('PDF_DIGEST_FORMAT');
  if (typeof candidate.pdfBytes !== 'number' || !Number.isInteger(candidate.pdfBytes) || candidate.pdfBytes <= 0) {
    violations.push('PDF_BYTES_INVALID');
  }
  if (!isRecord(candidate.manifest)) {
    violations.push('MANIFEST_MISSING');
  } else {
    const manifest = candidate.manifest as unknown as RecoveryManifest;
    const canonical = serializeCanonicalManifest(manifest);
    if (candidate.canonicalJson !== canonical) violations.push('CANONICAL_JSON_MISMATCH');
    if (candidate.packageDigest !== computePackageDigest(manifest)) violations.push('DIGEST_MISMATCH');
  }
  if (scanPreparedPackage({ manifest: candidate.manifest, canonicalJson: candidate.canonicalJson }).length > 0) {
    violations.push('SENSITIVE_CONTENT');
  }
  return [...new Set(violations)].sort();
}

/** 金额/币种规范化比较（避免 "300" vs "300.0000" 的假冲突） */
const normalizeAmount = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? text.slice(1) : text).split('.');
  return (negative ? '-' : '') + intPart.replace(/^0+(?=\d)/, '') + '.' + (fracPart + '0000').slice(0, 4);
};

export interface RecoveryPrepareToolRegistryBundle {
  prepareRegistry: RecoveryPrepareRegistry;
  registrationErrors: readonly { name: string; reason: string }[];
  safety: typeof RECOVERY_PREPARE_TOOL_SAFETY;
  invokeCounts: Readonly<Record<string, number>>;
  factLoadCount: () => number;
}

export function createRecoveryPrepareRegistry(
  deps: { facts: RecoveryPrepareFactSource; actorOrganizationId: string },
  options: { onInvoke?: (tool: string) => void } = {},
): RecoveryPrepareToolRegistryBundle {
  const invokeCounts: Record<string, number> = {};
  const registrationErrors: { name: string; reason: string }[] = [];
  let factLoadCount = 0;

  const buildPreview = async (
    input: RecoveryPrepareToolInput,
    ctx: { organizationId: string },
  ): Promise<PreparedRecoveryPackagePreview> => {
    if (input.organizationId !== ctx.organizationId || input.organizationId !== deps.actorOrganizationId) {
      throw new Error('TENANT_MISMATCH:PREPARE_ACTOR');
    }
    factLoadCount += 1;
    const loaded = await deps.facts.load({
      organizationId: input.organizationId,
      opportunityRef: input.opportunityRef,
    });
    if (loaded === null) throw new Error('FACTS_NOT_FOUND');
    // C2：事实必须绑定到被请求的机会
    if (loaded.opportunityRef !== input.opportunityRef) throw new Error('FACT_IDENTITY_MISMATCH');
    if (loaded.fact.organizationId !== input.organizationId) throw new Error('TENANT_MISMATCH:FACTS');
    // C2：money truth 必须与 verified 切片一致
    if (
      loaded.fact.currency.trim().toUpperCase() !== input.expectedCurrency.trim().toUpperCase() ||
      normalizeAmount(loaded.fact.recoverableAmount) !== normalizeAmount(input.expectedRecoverableAmount)
    ) {
      throw new Error('FACT_PLAN_MISMATCH');
    }

    const manifest = buildRecoveryManifest(loaded.fact);
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
    const violations = validatePreparedRecoveryPackagePreview(preview, { opportunityRef: input.opportunityRef });
    if (violations.length > 0) throw new Error(`PREVIEW_VALIDATION_FAILED:${violations.join('|')}`);
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
          !requireNonEmptyString(rawInput.opportunityRef) ||
          !requireNonEmptyString(rawInput.expectedCurrency) ||
          !requireNonEmptyString(rawInput.expectedRecoverableAmount)
        ) {
          throw new Error('INPUT_SCHEMA_REJECTED:PREPARE');
        }
        invokeCounts[toolName] = (invokeCounts[toolName] ?? 0) + 1;
        options.onInvoke?.(toolName);
        return buildPreview(rawInput as unknown as RecoveryPrepareToolInput, ctx);
      },
    });
  }

  const registry = createRecoveryToolRegistry(tools);
  registrationErrors.push(...registry.registrationErrors);

  const brand: RecoveryPrepareRegistry = { kind: 'RECOVERY_PREPARE_REGISTRY', registry, proofs: RECOVERY_PREPARE_TOOL_SAFETY };
  TRUSTED_PREPARE_REGISTRIES.add(brand);

  return {
    prepareRegistry: brand,
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
      reason: 'TENANT_MISMATCH' | 'STALE_STATE' | 'UNTRUSTED_PREPARE_REGISTRY';
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
 * PREPARE 执行入口（C1：只接受可信 PREPARE registry；C3：输出再走同一 validator）。
 */
export async function prepareRecoveryPackages(input: {
  state: CustomerRecoveryState;
  plan: RecoveryPlan;
  prepareRegistry: RecoveryPrepareRegistry;
  nowMs: number;
  maxSnapshotAgeMs?: number;
}): Promise<RecoveryPrepareRunResult> {
  const maxAgeMs = input.maxSnapshotAgeMs ?? 15 * 60 * 1000;
  const invocations: RecoveryPrepareInvocation[] = [];
  const skipped: RecoveryPrepareSkip[] = [];

  // C1：可信 registry 前置（非工厂闭包品牌 → fail-closed，零调用）
  if (!isTrustedPrepareRegistry(input.prepareRegistry)) {
    return { ok: false, reason: 'UNTRUSTED_PREPARE_REGISTRY', invocations, skipped };
  }
  const registry = input.prepareRegistry.registry;

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
    registry,
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
    const slice = input.state.opportunities.find((entry) => entry.opportunityRef === action.opportunityRef);
    if (slice === undefined || slice.recoverable === null) {
      skipAll('STALE_STATE');
      continue;
    }

    for (const toolName of boundTools) {
      if (!registry.has(toolName)) {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef: toolName, reason: 'TOOL_NOT_REGISTERED' });
        continue;
      }
      const listed = registry.list().find((entry) => entry.name === toolName);
      if (listed === undefined || listed.access !== 'PREPARE') {
        skipped.push({ opportunityRef: action.opportunityRef, toolRef: toolName, reason: 'TOOL_ACCESS_NOT_PREPARE' });
        continue;
      }
      const result = await registry.invoke<unknown>(
        toolName,
        {
          organizationId: input.state.organizationId,
          opportunityRef: action.opportunityRef,
          expectedCurrency: slice.recoverable.currency,
          expectedRecoverableAmount: String(slice.recoverable.amount),
        },
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
      // C3：外部/任一 registry 输出都必须过同一 validator
      const violations = validatePreparedRecoveryPackagePreview(result.output, {
        opportunityRef: action.opportunityRef,
      });
      if (violations.length > 0) {
        invocations.push({
          tool: toolName,
          opportunityRef: action.opportunityRef,
          ok: false,
          detail: `PREVIEW_VALIDATION_FAILED:${violations.join('|')}`,
          preview: null,
        });
        continue;
      }
      invocations.push({
        tool: toolName,
        opportunityRef: action.opportunityRef,
        ok: true,
        detail: null,
        preview: result.output as PreparedRecoveryPackagePreview,
      });
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
  /** C1：只接受工厂闭包品牌 */
  trustedPrepareRegistryOnly: true,
  /** C2：事实身份 + 金额与 verified 切片绑定 */
  factIdentityBound: true,
  factPlanMoneyBound: true,
  /** C3：统一 preview validator（key + string value 敏感扫描） */
  sharedPreviewValidator: true,
  sensitiveValueScan: true,
  runtimeWiring: 'NONE',
  packageVersion: RECOVERY_PACKAGE_VERSION,
} as const;
