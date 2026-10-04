/**
 * SEO-2 — RECOVERY RULE DEFINITION v1（TRACK C / SEO P3 单源契约）
 * ---------------------------------------------------------------
 * SEO 页面、公开 Checker、公开 Calculator 只能消费**生效中的统一规则**：
 *   Recovery Rule（本契约）→ Checker / Calculator → Evidence / Claim Package → SEO Landing Page
 * 禁止在页面硬编码规则 / 资格 / 截止日 / 计算 / 费率，也禁止为 SEO 维护第二套判定。
 *
 * MSG-20261004-17 五组必修已落地：
 *   ① `submissionMode` 替代 Customs-only 的 submissionMethod（跨域执行语义）+ `jurisdictionScope`
 *      = GLOBAL / COUNTRY / REGION，不再为页面伪造 US；
 *   ② Checker 与 Calculator 对称的**真实引擎绑定**（eligibilityMethod.basisKey /
 *      calculationMethod.basisKey）+ `relatedRuleRefs`（opaque，不依赖可变 slug）；
 *   ③ canonical 选择改为「按当前 now 过滤后的唯一生效版本」：0 个 = 无 canonical，
 *      1 个 = canonical，>1 个 = conflict → NOINDEX，**不再**用 ruleVersion 字符串排序偷偷选一个；
 *   ④ THIN_CONTENT 不再接受调用方 boolean 自证：生产 INDEX 必须提供 renderer 计算的
 *      renderMetrics（各段落长度 / 唯一内容摘要 / 有来源支撑的段落数），否则 RENDER_METRICS_REQUIRED；
 *   ⑤ 保持 RuleVersion.definition JSON（不改 Schema）：新增 typed codec
 *      `parseRecoveryRuleDefinition(row)`，`version/effectiveFrom/effectiveTo` 只由 DB row 注入，
 *      JSON 里出现这三个字段即 DEFINITION_ROW_COLUMN_DUPLICATE（消灭双事实源）+ 完整 runtime 校验。
 *
 * 本模块是**纯契约 + 校验 + 收录门**（零外写、无 Schema 变更、不发明规则）。
 */

export const RECOVERY_RULE_DEFINITION_VERSION = 'v1' as const;

export const RECOVERY_RULE_PLATFORMS = [
  'CUSTOMS',
  'AMAZON',
  'UPS',
  'FEDEX',
  'DHL',
  'TIKTOK_SHOP',
  'WALMART',
  'SHOPIFY',
  'STRIPE',
  'PAYPAL',
] as const;
export type RecoveryRulePlatform = (typeof RECOVERY_RULE_PLATFORMS)[number];

/**
 * 跨域提交/执行模式（provider-neutral）：
 * Amazon 赔付、UPS 索赔、Stripe 争议不再被迫伪装成 Customs 的 SERVICE_PROVIDER_TRANSMIT。
 */
export const RECOVERY_SUBMISSION_MODES = [
  'AUTHORITY_FILING',
  'BROKER_FILED',
  'SELF_FILED',
  'PLATFORM_CLAIM',
  'CARRIER_CLAIM',
  'PAYMENT_NETWORK_DISPUTE',
  'MERCHANT_BACKOFFICE_CLAIM',
] as const;
export type RecoverySubmissionMode = (typeof RECOVERY_SUBMISSION_MODES)[number];

export const RECOVERY_JURISDICTION_SCOPES = ['GLOBAL', 'COUNTRY', 'REGION'] as const;
export type RecoveryJurisdictionScope = (typeof RECOVERY_JURISDICTION_SCOPES)[number];

export const RECOVERY_SUPPORTED_MODES = ['AUTO', 'ASSISTED', 'PREPARE_ONLY', 'CHECKER_ONLY'] as const;
export type RecoverySupportedMode = (typeof RECOVERY_SUPPORTED_MODES)[number];

export const RECOVERY_ELIGIBILITY_METHOD_KINDS = ['DECISION_TABLE', 'THRESHOLD', 'COMPOSITE'] as const;
export type RecoveryEligibilityMethodKind = (typeof RECOVERY_ELIGIBILITY_METHOD_KINDS)[number];

export const RECOVERY_CALCULATION_KINDS = [
  'DUTY_DIFFERENCE',
  'FEE_DIFFERENCE',
  'CONTRACTUAL_REFUND',
  'DISPUTE_AMOUNT',
  'PLATFORM_REIMBURSEMENT',
  'NONE',
] as const;
export type RecoveryCalculationKind = (typeof RECOVERY_CALCULATION_KINDS)[number];

export const RECOVERY_FEE_MODELS = ['SUCCESS_FEE', 'FLAT_FEE', 'NONE'] as const;
export type RecoveryFeeModel = (typeof RECOVERY_FEE_MODELS)[number];

export const RECOVERY_CTA_MODES = ['FREE_AUDIT_THEN_START', 'CLAIM_PACKAGE_UNLOCK', 'CHECKER_ONLY'] as const;
export type RecoveryCtaMode = (typeof RECOVERY_CTA_MODES)[number];

/** 生产 INDEX 的成文内容下限（renderer 计算的字符数，非调用方自述）。 */
export const SEO_MIN_SECTION_CONTENT_LENGTH = 200;
/** 至少要有这么多段落是「有 sourceReferences 支撑」的。 */
export const SEO_MIN_SOURCE_BACKED_SECTIONS = 2;

const SLUG_TOKEN_RE = /^[a-z][a-z0-9-]{2,63}$/;
const OPAQUE_REF_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const RAW_URL_SCHEME_RE = /^(https?:\/\/|javascript:|data:|file:)/i;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const REGION_CODE_RE = /^[A-Z0-9-]{2,16}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export interface RecoveryRuleEligibility {
  /** 需要 IOR 身份（如 customs drawback）。 */
  requiresIorIdentity: boolean;
  /** 需要授权签署人（SELF_FILED）。 */
  requiresAuthorizedSigner: boolean;
  /** 需要 Broker POA（BROKER_FILED）。 */
  requiresBrokerPoa: boolean;
  /** 需要合法申报权限（追回权 ≠ 申报授权）。 */
  requiresFilingAuthorization: boolean;
  /** 最少证据件数（>0 表示必须有材料）。 */
  minimumEvidenceCount: number;
}

/** Checker 的真实引擎绑定（与 Calculator 的 basisKey 对称；Checker 不得自己发明业务逻辑）。 */
export interface RecoveryRuleEligibilityMethod {
  kind: RecoveryEligibilityMethodKind;
  /** 已注册且可执行的引擎 capability key（由 indexability gate 对照 registry 校验）。 */
  basisKey: string;
}

export interface RecoveryRuleDeadline {
  kind: 'STATUTORY' | 'POLICY' | 'NONE';
  /** 相对事件的天数（STATUTORY/POLICY 时必填且 > 0）。 */
  days?: number;
  /** 依据来源（STATUTORY/POLICY 时必填，且必须存在于 sourceReferences[].id）。 */
  sourceReferenceId?: string;
}

export interface RecoveryRuleCalculationMethod {
  kind: RecoveryCalculationKind;
  /** 计算口径说明键（不承载金额；金额只能来自引擎）。 */
  basisKey: string;
}

export interface RecoveryRuleSourceReference {
  id: string;
  label: string;
  url?: string;
}

export interface RecoveryRuleCapabilities {
  checker: boolean;
  calculator: boolean;
}

/** RuleVersion.definition JSON 的正文：**不含** version / effectiveFrom / effectiveTo（由 DB row 注入）。 */
export interface RecoveryRuleDefinitionJson {
  definitionVersion: typeof RECOVERY_RULE_DEFINITION_VERSION;
  platform: RecoveryRulePlatform;
  category: string;
  recoveryType: string;
  jurisdictionScope: RecoveryJurisdictionScope;
  /** GLOBAL 时必须为空或 ['*']；COUNTRY 时为 ISO-3166 alpha-2；REGION 时为区域码。 */
  jurisdictionCodes: readonly string[];
  region: string | null;
  title: string;
  slug: string;
  problemDescription: string;
  eligibility: RecoveryRuleEligibility;
  eligibilityMethod: RecoveryRuleEligibilityMethod;
  requiredEvidence: readonly string[];
  calculationMethod: RecoveryRuleCalculationMethod;
  filingDeadline: RecoveryRuleDeadline;
  submissionMode: RecoverySubmissionMode;
  feeModel: RecoveryFeeModel;
  supportedMode: RecoverySupportedMode;
  /** opaque 关联规则引用（不用可变 slug 做外键）。 */
  relatedRuleRefs: readonly string[];
  sourceReferences: readonly RecoveryRuleSourceReference[];
  capabilities: RecoveryRuleCapabilities;
  ctaMode: RecoveryCtaMode;
}

/** 解析后的完整定义 = JSON 正文 + RuleVersion row 的权威列。 */
export interface RecoveryRuleDefinition extends RecoveryRuleDefinitionJson {
  ruleVersion: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Prisma `RuleVersion` row 的最小形状（version/effectiveFrom/effectiveTo 为权威列）。 */
export interface RecoveryRuleVersionRow {
  version: string;
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
  definition: unknown;
}

export type RecoveryRuleValidationError =
  | 'INVALID_DEFINITION_VERSION'
  | 'INVALID_PLATFORM'
  | 'INVALID_SLUG'
  | 'INVALID_RECOVERY_TYPE'
  | 'MISSING_TITLE_OR_PROBLEM'
  | 'MISSING_SOURCE_REFERENCES'
  | 'INVALID_SOURCE_REFERENCES'
  | 'CHECKER_REQUIRES_ELIGIBILITY'
  | 'CALCULATOR_REQUIRES_CALCULATION_METHOD'
  | 'INVALID_ELIGIBILITY_METHOD'
  | 'INVALID_CALCULATION_METHOD'
  | 'DEADLINE_REQUIRES_POSITIVE_DAYS'
  | 'STATUTORY_DEADLINE_REQUIRES_SOURCE'
  | 'DEADLINE_SOURCE_NOT_FOUND'
  | 'INVALID_EFFECTIVE_WINDOW'
  | 'INVALID_FEE_MODEL'
  | 'INVALID_SUBMISSION_MODE'
  | 'INVALID_SUPPORTED_MODE'
  | 'INVALID_CTA_MODE'
  | 'INVALID_JURISDICTION_SCOPE'
  | 'INVALID_JURISDICTION_CODE'
  | 'EVIDENCE_COUNT_MISMATCH'
  | 'INVALID_RELATED_RULE_REFS'
  | 'INVALID_RULE_VERSION'
  | 'DEFINITION_ROW_COLUMN_DUPLICATE'
  | 'INVALID_DEFINITION_JSON';

const includes = <T extends readonly string[]>(whitelist: T, value: unknown): boolean =>
  typeof value === 'string' && (whitelist as readonly string[]).includes(value);

/** opaque-only 引用：不接受裸 URL / 数据 URI（沿用 C18-2 / CA-5 口径）。 */
export function isOpaqueRecoveryRef(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (RAW_URL_SCHEME_RE.test(value)) return false;
  return OPAQUE_REF_RE.test(value);
}

/** 生效窗口判定（now 必须落在 [effectiveFrom, effectiveTo) 内）。 */
export function isRecoveryRuleEffective(rule: RecoveryRuleDefinition, now: Date): boolean {
  const from = Date.parse(rule.effectiveFrom);
  const to = rule.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(rule.effectiveTo);
  const nowMs = now.getTime();
  return from <= nowMs && nowMs < to;
}

/** fail-closed 结构 + runtime 校验（覆盖 DB JSON 内容，TypeScript 类型保护不了数据库）。 */
export function validateRecoveryRuleDefinition(
  rule: RecoveryRuleDefinition,
): { ok: true } | { ok: false; errors: readonly RecoveryRuleValidationError[] } {
  const errors: RecoveryRuleValidationError[] = [];

  if (rule.definitionVersion !== RECOVERY_RULE_DEFINITION_VERSION) errors.push('INVALID_DEFINITION_VERSION');
  if (!includes(RECOVERY_RULE_PLATFORMS, rule.platform)) errors.push('INVALID_PLATFORM');
  if (!SLUG_TOKEN_RE.test(rule.slug)) errors.push('INVALID_SLUG');
  if (!SLUG_TOKEN_RE.test(rule.recoveryType)) errors.push('INVALID_RECOVERY_TYPE');
  if (rule.title.trim() === '' || rule.problemDescription.trim() === '') errors.push('MISSING_TITLE_OR_PROBLEM');
  if (typeof rule.ruleVersion !== 'string' || rule.ruleVersion.trim() === '') errors.push('INVALID_RULE_VERSION');

  // sourceReferences：非空、id 唯一且可作引用目标。
  if (!Array.isArray(rule.sourceReferences) || rule.sourceReferences.length === 0) {
    errors.push('MISSING_SOURCE_REFERENCES');
  } else {
    const ids = rule.sourceReferences.map((entry) => entry?.id);
    if (ids.some((id) => !isOpaqueRecoveryRef(id)) || new Set(ids).size !== ids.length) {
      errors.push('INVALID_SOURCE_REFERENCES');
    }
  }
  const sourceIds = new Set((rule.sourceReferences ?? []).map((entry) => entry?.id));

  // ① jurisdictionScope（不再伪造国家码）。
  if (!includes(RECOVERY_JURISDICTION_SCOPES, rule.jurisdictionScope)) {
    errors.push('INVALID_JURISDICTION_SCOPE');
  } else {
    const codes = rule.jurisdictionCodes ?? [];
    if (!Array.isArray(codes)) {
      errors.push('INVALID_JURISDICTION_CODE');
    } else if (rule.jurisdictionScope === 'GLOBAL') {
      if (!(codes.length === 0 || (codes.length === 1 && codes[0] === '*'))) {
        errors.push('INVALID_JURISDICTION_CODE');
      }
    } else if (rule.jurisdictionScope === 'COUNTRY') {
      if (codes.length === 0 || codes.some((code) => !COUNTRY_CODE_RE.test(code))) {
        errors.push('INVALID_JURISDICTION_CODE');
      }
    } else if (codes.length === 0 || codes.some((code) => !REGION_CODE_RE.test(code))) {
      errors.push('INVALID_JURISDICTION_CODE');
    }
  }

  if (!includes(RECOVERY_SUBMISSION_MODES, rule.submissionMode)) errors.push('INVALID_SUBMISSION_MODE');
  if (!includes(RECOVERY_SUPPORTED_MODES, rule.supportedMode)) errors.push('INVALID_SUPPORTED_MODE');
  if (!includes(RECOVERY_CTA_MODES, rule.ctaMode)) errors.push('INVALID_CTA_MODE');
  if (!includes(RECOVERY_FEE_MODELS, rule.feeModel)) errors.push('INVALID_FEE_MODEL');

  // ② 真实引擎绑定：Checker / Calculator 各自必须有可执行 basisKey。
  const eligibilityOk =
    rule.eligibilityMethod !== undefined &&
    includes(RECOVERY_ELIGIBILITY_METHOD_KINDS, rule.eligibilityMethod.kind) &&
    isOpaqueRecoveryRef(rule.eligibilityMethod.basisKey);
  if (!eligibilityOk) errors.push('INVALID_ELIGIBILITY_METHOD');
  if (rule.capabilities?.checker === true && !eligibilityOk) errors.push('CHECKER_REQUIRES_ELIGIBILITY');

  const calculationNone = rule.calculationMethod?.kind === 'NONE';
  const calculationOk =
    rule.calculationMethod !== undefined &&
    includes(RECOVERY_CALCULATION_KINDS, rule.calculationMethod.kind) &&
    (calculationNone
      ? true
      : isOpaqueRecoveryRef(rule.calculationMethod.basisKey));
  if (!calculationOk) errors.push('INVALID_CALCULATION_METHOD');
  if (rule.capabilities?.calculator === true && (calculationNone || !calculationOk)) {
    errors.push('CALCULATOR_REQUIRES_CALCULATION_METHOD');
  }

  // ③ 截止日：STATUTORY/POLICY 必须有 > 0 的 days 和**真实存在**的 sourceReferenceId。
  if (rule.filingDeadline?.kind === 'STATUTORY' || rule.filingDeadline?.kind === 'POLICY') {
    const days = rule.filingDeadline.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
      errors.push('DEADLINE_REQUIRES_POSITIVE_DAYS');
    }
    const sourceId = rule.filingDeadline.sourceReferenceId;
    if (typeof sourceId !== 'string' || sourceId.trim() === '') {
      errors.push('STATUTORY_DEADLINE_REQUIRES_SOURCE');
    } else if (!sourceIds.has(sourceId)) {
      errors.push('DEADLINE_SOURCE_NOT_FOUND');
    }
  }

  // ④ 证据一致性：minimumEvidenceCount 不得超过 requiredEvidence 实际条数。
  const minEvidence = rule.eligibility?.minimumEvidenceCount;
  if (typeof minEvidence !== 'number' || !Number.isInteger(minEvidence) || minEvidence < 0) {
    errors.push('EVIDENCE_COUNT_MISMATCH');
  } else if (minEvidence > 0) {
    const declared = Array.isArray(rule.requiredEvidence)
      ? rule.requiredEvidence.filter((entry) => typeof entry === 'string' && entry.trim() !== '').length
      : 0;
    if (declared < minEvidence) errors.push('EVIDENCE_COUNT_MISMATCH');
  }

  // ⑤ relatedRuleRefs：opaque、去重、不得自引用。
  const refs = rule.relatedRuleRefs;
  if (!Array.isArray(refs)) {
    errors.push('INVALID_RELATED_RULE_REFS');
  } else {
    const bad =
      refs.some((ref) => !isOpaqueRecoveryRef(ref) || ref === rule.slug) ||
      new Set(refs).size !== refs.length;
    if (bad) errors.push('INVALID_RELATED_RULE_REFS');
  }

  const from = Date.parse(rule.effectiveFrom);
  const to = rule.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(rule.effectiveTo);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) errors.push('INVALID_EFFECTIVE_WINDOW');

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

const toIso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);

/**
 * typed codec：`RuleVersion DB row → parse/validate definition JSON → ResolvedRecoveryRuleDefinition`。
 * `version` / `effectiveFrom` / `effectiveTo` 只认 DB row；JSON 里出现同名字段即拒绝（消灭双事实源）。
 */
export function parseRecoveryRuleDefinition(
  row: RecoveryRuleVersionRow,
): { ok: true; rule: RecoveryRuleDefinition } | { ok: false; errors: readonly RecoveryRuleValidationError[] } {
  const errors: RecoveryRuleValidationError[] = [];
  if (row === null || typeof row !== 'object') return { ok: false, errors: ['INVALID_DEFINITION_JSON'] };
  if (typeof row.version !== 'string' || row.version.trim() === '') errors.push('INVALID_RULE_VERSION');

  const definition = row.definition;
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return { ok: false, errors: ['INVALID_DEFINITION_JSON'] };
  }
  const body = definition as Record<string, unknown>;
  for (const column of ['ruleVersion', 'effectiveFrom', 'effectiveTo']) {
    if (column in body) errors.push('DEFINITION_ROW_COLUMN_DUPLICATE');
  }
  if (errors.length > 0) return { ok: false, errors };

  const rule = {
    ...(body as unknown as RecoveryRuleDefinitionJson),
    ruleVersion: row.version,
    effectiveFrom: toIso(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : toIso(row.effectiveTo),
  } as RecoveryRuleDefinition;

  const validation = validateRecoveryRuleDefinition(rule);
  return validation.ok ? { ok: true, rule } : { ok: false, errors: validation.errors };
}

export type SeoIndexabilityReason =
  | 'RULE_NOT_EFFECTIVE'
  | 'NO_RECOVERY_CAPABILITY'
  | 'NO_CHECKER_OR_CALCULATOR'
  | 'THIN_CONTENT'
  | 'RENDER_METRICS_REQUIRED'
  | 'MISSING_SOURCE_REFERENCES'
  | 'RULE_VERSION_CONFLICT'
  | 'CANONICAL_NOT_EXPLICIT'
  | 'INVALID_DEFINITION';

/** renderer 计算的机器可验证信号（生产 INDEX 的唯一 THIN_CONTENT 证据）。 */
export interface SeoRenderMetrics {
  problemContentLength: number;
  eligibilityContentLength: number;
  evidenceContentLength: number;
  calculationContentLength: number;
  uniqueContentDigest: string;
  sourceBackedSections: number;
}

export interface SeoIndexabilityInput {
  rule: RecoveryRuleDefinition;
  now: Date;
  /** 已注册且可执行的引擎 capability key 集合（basisKey 必须在其中）。 */
  registeredBasisKeys: readonly string[];
  /** renderer 产出的页面指标；缺失即 NOINDEX（不允许调用方 boolean 自证）。 */
  renderMetrics?: SeoRenderMetrics;
  /** 同 slug 是否存在其它同时生效版本（存在则冲突 → NOINDEX）。 */
  conflictingVersions: boolean;
  /** 页面是否已声明 canonical。 */
  canonicalExplicit: boolean;
}

/** 收录门：默认 NOINDEX，仅当全部条件满足才 INDEX。 */
export function seoIndexabilityGate(input: SeoIndexabilityInput): {
  indexable: boolean;
  reasons: readonly SeoIndexabilityReason[];
} {
  const reasons: SeoIndexabilityReason[] = [];
  const validation = validateRecoveryRuleDefinition(input.rule);
  if (!validation.ok) return { indexable: false, reasons: ['INVALID_DEFINITION'] };

  if (!isRecoveryRuleEffective(input.rule, input.now)) reasons.push('RULE_NOT_EFFECTIVE');

  // NO_RECOVERY_CAPABILITY：检查 basisKey 是否**真实注册并可执行**，而不是字段是否存在。
  const registered = new Set(input.registeredBasisKeys ?? []);
  const checkerCapable = input.rule.capabilities.checker && registered.has(input.rule.eligibilityMethod.basisKey);
  const calculatorCapable =
    input.rule.capabilities.calculator &&
    input.rule.calculationMethod.kind !== 'NONE' &&
    registered.has(input.rule.calculationMethod.basisKey);
  if (input.rule.capabilities.checker && !registered.has(input.rule.eligibilityMethod.basisKey)) {
    reasons.push('NO_RECOVERY_CAPABILITY');
  }
  if (
    input.rule.capabilities.calculator &&
    input.rule.calculationMethod.kind !== 'NONE' &&
    !registered.has(input.rule.calculationMethod.basisKey)
  ) {
    reasons.push('NO_RECOVERY_CAPABILITY');
  }
  if (!checkerCapable && !calculatorCapable) reasons.push('NO_CHECKER_OR_CALCULATOR');

  if (input.rule.sourceReferences.length === 0) reasons.push('MISSING_SOURCE_REFERENCES');

  const metrics = input.renderMetrics;
  if (metrics === undefined) {
    reasons.push('RENDER_METRICS_REQUIRED');
  } else if (
    metrics.problemContentLength < SEO_MIN_SECTION_CONTENT_LENGTH ||
    metrics.eligibilityContentLength < SEO_MIN_SECTION_CONTENT_LENGTH ||
    metrics.evidenceContentLength < SEO_MIN_SECTION_CONTENT_LENGTH ||
    metrics.calculationContentLength < SEO_MIN_SECTION_CONTENT_LENGTH ||
    metrics.sourceBackedSections < SEO_MIN_SOURCE_BACKED_SECTIONS ||
    !DIGEST_RE.test(metrics.uniqueContentDigest)
  ) {
    reasons.push('THIN_CONTENT');
  }

  if (input.conflictingVersions) reasons.push('RULE_VERSION_CONFLICT');
  if (!input.canonicalExplicit) reasons.push('CANONICAL_NOT_EXPLICIT');

  return { indexable: reasons.length === 0, reasons };
}

export interface CanonicalRecoveryRuleSelection {
  /** 恰好一个当前生效版本时才有值；0 个或冲突时为 null。 */
  canonical: RecoveryRuleDefinition | null;
  effectiveCount: number;
  /** 多个版本同时生效 = 冲突，必须 NOINDEX 并人工裁决。 */
  conflict: boolean;
}

/**
 * canonical 选择（MSG-20261004-17 ③）：按当前 `now` 过滤有效版本 → 0 个无 canonical、
 * 1 个即 canonical、>1 个直接 conflict。**不再**用 ruleVersion 字符串排序偷偷选一个。
 */
export function selectCurrentlyEffectiveRecoveryRuleVersion(
  rules: readonly RecoveryRuleDefinition[],
  now: Date,
): CanonicalRecoveryRuleSelection {
  const effective = rules.filter((rule) => {
    const valid = validateRecoveryRuleDefinition(rule);
    return valid.ok && isRecoveryRuleEffective(rule, now);
  });
  if (effective.length === 1) return { canonical: effective[0]!, effectiveCount: 1, conflict: false };
  return { canonical: null, effectiveCount: effective.length, conflict: effective.length > 1 };
}

/** 同 slug 冲突检测（多个版本同时生效 = 冲突，必须 NOINDEX 并人工裁决）。 */
export function detectRecoveryRuleVersionConflicts(
  rules: readonly RecoveryRuleDefinition[],
  now: Date,
): readonly string[] {
  const bySlug = new Map<string, RecoveryRuleDefinition[]>();
  for (const rule of rules) {
    bySlug.set(rule.slug, [...(bySlug.get(rule.slug) ?? []), rule]);
  }
  const conflicting: string[] = [];
  for (const [slug, entries] of bySlug) {
    const effective = entries.filter((rule) => isRecoveryRuleEffective(rule, now));
    if (effective.length > 1) conflicting.push(slug);
  }
  return conflicting;
}
