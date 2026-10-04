/**
 * SEO-2 — RECOVERY RULE DEFINITION v1（TRACK C / SEO P3 单源契约）
 * ---------------------------------------------------------------
 * SEO 页面、公开 Checker、公开 Calculator 只能消费**生效中的统一规则**：
 *   Recovery Rule（本契约）→ Checker / Calculator → Evidence / Claim Package → SEO Landing Page
 * 禁止在页面硬编码规则 / 资格 / 截止日 / 计算 / 费率，也禁止为 SEO 维护第二套判定。
 *
 * 本模块是**纯契约 + 校验 + 收录门**（零外写、无 Schema 变更、不发明规则）：
 *   · `validateRecoveryRuleDefinition()` —— fail-closed 结构校验；
 *   · `seoIndexabilityGate()` —— 只有满足全部条件才允许 INDEX，否则 NOINDEX；
 *   · `selectCanonicalRecoveryRuleVersion()` —— 同 slug 多版本时的确定性 canonical 选择。
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

export const RECOVERY_SUBMISSION_ROUTES = ['BROKER_FILED', 'SELF_FILED', 'SERVICE_PROVIDER_TRANSMIT'] as const;
export type RecoverySubmissionRoute = (typeof RECOVERY_SUBMISSION_ROUTES)[number];

export const RECOVERY_FEE_MODELS = ['SUCCESS_FEE', 'FLAT_FEE', 'NONE'] as const;
export type RecoveryFeeModel = (typeof RECOVERY_FEE_MODELS)[number];

export const RECOVERY_CTA_MODES = ['FREE_AUDIT_THEN_START', 'CLAIM_PACKAGE_UNLOCK', 'CHECKER_ONLY'] as const;
export type RecoveryCtaMode = (typeof RECOVERY_CTA_MODES)[number];

const SLUG_TOKEN_RE = /^[a-z][a-z0-9-]{2,63}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

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

export interface RecoveryRuleDeadline {
  kind: 'STATUTORY' | 'POLICY' | 'NONE';
  /** 相对事件的天数（STATUTORY/POLICY 时必填）。 */
  days?: number;
  /** 依据来源（STATUTORY/POLICY 时必填）。 */
  sourceReferenceId?: string;
}

export interface RecoveryRuleCalculationMethod {
  kind: 'DUTY_DIFFERENCE' | 'FEE_DIFFERENCE' | 'CONTRACTUAL_REFUND' | 'DISPUTE_AMOUNT' | 'NONE';
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

export interface RecoveryRuleDefinition {
  definitionVersion: typeof RECOVERY_RULE_DEFINITION_VERSION;
  platform: RecoveryRulePlatform;
  category: string;
  recoveryType: string;
  country: string;
  region: string | null;
  title: string;
  slug: string;
  problemDescription: string;
  eligibility: RecoveryRuleEligibility;
  requiredEvidence: readonly string[];
  calculationMethod: RecoveryRuleCalculationMethod;
  filingDeadline: RecoveryRuleDeadline;
  submissionMethod: RecoverySubmissionRoute;
  feeModel: RecoveryFeeModel;
  supportedMode: string;
  ruleVersion: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceReferences: readonly RecoveryRuleSourceReference[];
  capabilities: RecoveryRuleCapabilities;
  ctaMode: RecoveryCtaMode;
}

export type RecoveryRuleValidationError =
  | 'INVALID_DEFINITION_VERSION'
  | 'INVALID_PLATFORM'
  | 'INVALID_SLUG'
  | 'INVALID_COUNTRY'
  | 'INVALID_RECOVERY_TYPE'
  | 'MISSING_TITLE_OR_PROBLEM'
  | 'MISSING_SOURCE_REFERENCES'
  | 'CHECKER_REQUIRES_ELIGIBILITY'
  | 'CALCULATOR_REQUIRES_CALCULATION_METHOD'
  | 'STATUTORY_DEADLINE_REQUIRES_SOURCE'
  | 'INVALID_EFFECTIVE_WINDOW'
  | 'INVALID_FEE_MODEL'
  | 'INVALID_SUBMISSION_ROUTE';

export function validateRecoveryRuleDefinition(
  rule: RecoveryRuleDefinition,
): { ok: true } | { ok: false; errors: readonly RecoveryRuleValidationError[] } {
  const errors: RecoveryRuleValidationError[] = [];
  if (rule.definitionVersion !== RECOVERY_RULE_DEFINITION_VERSION) errors.push('INVALID_DEFINITION_VERSION');
  if (!(RECOVERY_RULE_PLATFORMS as readonly string[]).includes(rule.platform)) errors.push('INVALID_PLATFORM');
  if (!SLUG_TOKEN_RE.test(rule.slug)) errors.push('INVALID_SLUG');
  if (!COUNTRY_RE.test(rule.country)) errors.push('INVALID_COUNTRY');
  if (!SLUG_TOKEN_RE.test(rule.recoveryType)) errors.push('INVALID_RECOVERY_TYPE');
  if (rule.title.trim() === '' || rule.problemDescription.trim() === '') errors.push('MISSING_TITLE_OR_PROBLEM');
  if (rule.sourceReferences.length === 0) errors.push('MISSING_SOURCE_REFERENCES');
  if (rule.capabilities.checker && rule.eligibility === undefined) errors.push('CHECKER_REQUIRES_ELIGIBILITY');
  if (rule.capabilities.calculator && rule.calculationMethod.kind === 'NONE') {
    errors.push('CALCULATOR_REQUIRES_CALCULATION_METHOD');
  }
  if (rule.filingDeadline.kind === 'STATUTORY' && !rule.filingDeadline.sourceReferenceId) {
    errors.push('STATUTORY_DEADLINE_REQUIRES_SOURCE');
  }
  const from = Date.parse(rule.effectiveFrom);
  const to = rule.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(rule.effectiveTo);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) errors.push('INVALID_EFFECTIVE_WINDOW');
  if (!(RECOVERY_FEE_MODELS as readonly string[]).includes(rule.feeModel)) errors.push('INVALID_FEE_MODEL');
  if (!(RECOVERY_SUBMISSION_ROUTES as readonly string[]).includes(rule.submissionMethod)) {
    errors.push('INVALID_SUBMISSION_ROUTE');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export type SeoIndexabilityReason =
  | 'RULE_NOT_EFFECTIVE'
  | 'NO_RECOVERY_CAPABILITY'
  | 'NO_CHECKER_OR_CALCULATOR'
  | 'THIN_CONTENT'
  | 'MISSING_SOURCE_REFERENCES'
  | 'RULE_VERSION_CONFLICT'
  | 'CANONICAL_NOT_EXPLICIT'
  | 'INVALID_DEFINITION';

export interface SeoIndexabilityInput {
  rule: RecoveryRuleDefinition;
  now: Date;
  /** 页面核心段落完整性（problem / eligibility / evidence / calculation 是否都有实质内容）。 */
  sections: { problem: boolean; eligibility: boolean; evidence: boolean; calculation: boolean };
  /** 同 slug 是否存在其它生效版本（存在则冲突 → NOINDEX）。 */
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

  const from = Date.parse(input.rule.effectiveFrom);
  const to = input.rule.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(input.rule.effectiveTo);
  const nowMs = input.now.getTime();
  if (!(from <= nowMs && nowMs < to)) reasons.push('RULE_NOT_EFFECTIVE');

  if (input.rule.submissionMethod === undefined) reasons.push('NO_RECOVERY_CAPABILITY');
  if (!input.rule.capabilities.checker && !input.rule.capabilities.calculator) {
    reasons.push('NO_CHECKER_OR_CALCULATOR');
  }
  if (
    !input.sections.problem ||
    !input.sections.eligibility ||
    !input.sections.evidence ||
    !input.sections.calculation
  ) {
    reasons.push('THIN_CONTENT');
  }
  if (input.rule.sourceReferences.length === 0) reasons.push('MISSING_SOURCE_REFERENCES');
  if (input.conflictingVersions) reasons.push('RULE_VERSION_CONFLICT');
  if (!input.canonicalExplicit) reasons.push('CANONICAL_NOT_EXPLICIT');

  return { indexable: reasons.length === 0, reasons };
}

/**
 * canonical 版本选择：同 slug 多个版本时取「生效窗口最晚开始」的版本；
 * 相同 effectiveFrom 时取 ruleVersion 字典序更大者，保证确定性。
 */
export function selectCanonicalRecoveryRuleVersion(
  rules: readonly RecoveryRuleDefinition[],
): RecoveryRuleDefinition | null {
  if (rules.length === 0) return null;
  return [...rules].sort((a, b) => {
    const fromDiff = Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom);
    if (fromDiff !== 0) return fromDiff;
    return b.ruleVersion < a.ruleVersion ? -1 : b.ruleVersion > a.ruleVersion ? 1 : 0;
  })[0]!;
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
    const effective = entries.filter((rule) => {
      const from = Date.parse(rule.effectiveFrom);
      const to = rule.effectiveTo === null ? Number.POSITIVE_INFINITY : Date.parse(rule.effectiveTo);
      return from <= now.getTime() && now.getTime() < to;
    });
    if (effective.length > 1) conflicting.push(slug);
  }
  return conflicting;
}
