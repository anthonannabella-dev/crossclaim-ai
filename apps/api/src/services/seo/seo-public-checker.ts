/**
 * SEO-3 — PUBLIC READ-ONLY CHECKER / CALCULATOR（TRACK C / SEO P3）
 * ---------------------------------------------------------------
 * 面向匿名访客的**只读**资格快检与金额估算。硬规则（MSG-20261004-17 ⑤ 的约束）：
 *   · 业务结果只能来自 server-resolved 的**当前生效 RuleVersion** + 已注册的真实
 *     eligibility/calculation basisKey + 既有引擎；SEO 层**不得**自己硬编码
 *     Amazon / Customs / Carrier 判断；
 *   · 匿名、无租户数据、无 PII、不写库、零外写、不创建 submission、不绕过 Action Guard、不扣费；
 *   · estimate 必须显式标注 ESTIMATE_ONLY（并带免责声明键），绝不冒充真实金额或 provider 状态；
 *   · 任何缺失（规则不存在 / 未生效 / 无能力 / 引擎未注册 / 输入含 PII）一律 fail-closed。
 *
 * 本模块是纯服务层 + 端口定义，**不注册任何 HTTP 路由**：公开入口的暴露属于
 * PUBLIC API SECURITY AUDIT 范围，审计通过后才接线。
 */

import {
  isRecoveryRuleEffective,
  validateRecoveryRuleDefinition,
  type RecoveryRuleDefinition,
} from '../recovery-rules/recovery-rule-definition';

/** 匿名输入白名单约束。 */
export const SEO_PUBLIC_ANSWER_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const SEO_PUBLIC_MAX_ANSWERS = 12;
export const SEO_PUBLIC_MAX_STRING_LENGTH = 120;

const URL_LIKE_RE = /(https?:\/\/|www\.|javascript:|data:)/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d[\s().-]?){7,}/;
const TAX_ID_RE = /\b\d{2}-\d{7}\b/;
const LONG_DIGITS_RE = /\b\d{6,}\b/;

export type SeoPublicDenialCode =
  | 'INVALID_REQUEST'
  | 'SLUG_NOT_FOUND'
  | 'RULE_NOT_EFFECTIVE'
  | 'NO_RECOVERY_CAPABILITY'
  | 'CHECKER_NOT_AVAILABLE'
  | 'CALCULATOR_NOT_AVAILABLE'
  | 'ENGINE_OUTPUT_INVALID'
  | 'PII_REJECTED';

export type SeoPublicAnswerValue = string | number | boolean;

export interface SeoPublicRequest {
  slug: string;
  /** 匿名答案；键受白名单约束，不含任何身份信息。 */
  answers?: Record<string, SeoPublicAnswerValue>;
}

export interface SeoPublicEligibilityOutcome {
  eligible: boolean;
  reasonCodes: readonly string[];
}

export interface SeoPublicEstimate {
  min: number;
  max: number;
  currency: string;
}

export interface SeoPublicCalculationOutcome {
  estimate: SeoPublicEstimate | null;
  /** 估算口径键（来自规则，不由 SEO 层发明）。 */
  basisKey: string;
  /** 免责声明文案键（i18n 单一来源；页面不得硬编码字符串）。 */
  disclaimerKey: string;
}

export interface SeoPublicCheckerPorts {
  /** server-resolved 当前生效规则（必须已按 now 过滤 + canonical 唯一）。 */
  resolveActiveRule(input: { slug: string; now: Date }): Promise<RecoveryRuleDefinition | null>;
  /** 已注册且可执行的引擎 capability key。 */
  listRegisteredBasisKeys(): Promise<readonly string[]>;
  /** 既有 eligibility 引擎（不在 SEO 层重写业务判断）。 */
  runEligibility(input: {
    basisKey: string;
    rule: RecoveryRuleDefinition;
    answers: Record<string, SeoPublicAnswerValue>;
  }): Promise<SeoPublicEligibilityOutcome>;
  /** 既有 calculation 引擎；返回的是估算区间，不是承诺金额。 */
  runCalculation(input: {
    basisKey: string;
    rule: RecoveryRuleDefinition;
    answers: Record<string, SeoPublicAnswerValue>;
  }): Promise<SeoPublicCalculationOutcome>;
  now?: () => Date;
}

export interface SeoPublicCheckerOutcome {
  ok: boolean;
  code: SeoPublicDenialCode | 'CHECKER_RESULT';
  ruleVersion: string | null;
  slug: string | null;
  eligible: boolean | null;
  reasonCodes: readonly string[];
  estimate: SeoPublicEstimate | null;
  /** estimate 必须带此标记；无 calculator 能力时为 null。 */
  estimateLabel: 'ESTIMATE_ONLY' | null;
  disclaimerKey: string | null;
  /** 边界自证：公开工具永不产生副作用。 */
  externalWritePerformed: false;
  tenantDataIncluded: false;
  submissionCreated: false;
  chargingPerformed: false;
  productionCredentials: 'ABSENT';
}

const DENIED = (code: SeoPublicDenialCode): SeoPublicCheckerOutcome => ({
  ok: false,
  code,
  ruleVersion: null,
  slug: null,
  eligible: null,
  reasonCodes: [],
  estimate: null,
  estimateLabel: null,
  disclaimerKey: null,
  externalWritePerformed: false,
  tenantDataIncluded: false,
  submissionCreated: false,
  chargingPerformed: false,
  productionCredentials: 'ABSENT',
});

/** PII / 身份信息探测：公开工具不接受邮箱、电话、税号/EIN-like、裸 URL 或超长数字串。 */
export function containsPersonalData(value: string): boolean {
  return (
    EMAIL_RE.test(value) ||
    PHONE_RE.test(value) ||
    TAX_ID_RE.test(value) ||
    LONG_DIGITS_RE.test(value) ||
    URL_LIKE_RE.test(value)
  );
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * engine 输出校验（架构方新增要求）：公开边界不得直接信任 engine 返回值。
 * 非法 → ENGINE_OUTPUT_INVALID → fail-closed（防止某个 engine 意外返回异常值/超大内容/自由文本穿透到公开 API）。
 */
export function isSafeEligibilityOutcome(outcome: SeoPublicEligibilityOutcome): boolean {
  if (outcome === null || typeof outcome !== 'object') return false;
  if (typeof outcome.eligible !== 'boolean') return false;
  if (!Array.isArray(outcome.reasonCodes) || outcome.reasonCodes.length > 20) return false;
  return outcome.reasonCodes.every((code) => typeof code === 'string' && SAFE_TOKEN_RE.test(code));
}

export function isSafeCalculationOutcome(outcome: SeoPublicCalculationOutcome): boolean {
  if (outcome === null || typeof outcome !== 'object') return false;
  if (typeof outcome.basisKey !== 'string' || !SAFE_TOKEN_RE.test(outcome.basisKey)) return false;
  if (typeof outcome.disclaimerKey !== 'string' || !SAFE_TOKEN_RE.test(outcome.disclaimerKey)) return false;
  const estimate = outcome.estimate;
  if (estimate === null) return true; // 允许"无可用估算"，但字段本身仍须合法
  if (typeof estimate !== 'object') return false;
  if (!Number.isFinite(estimate.min) || !Number.isFinite(estimate.max)) return false;
  if (estimate.min < 0 || estimate.max < estimate.min) return false;
  return typeof estimate.currency === 'string' && CURRENCY_RE.test(estimate.currency);
}

/** 匿名输入校验（键白名单、值类型/长度、无 PII）。 */
export function validatePublicSeoRequest(
  request: SeoPublicRequest,
): { ok: true; slug: string; answers: Record<string, SeoPublicAnswerValue> } | { ok: false; code: SeoPublicDenialCode } {
  if (request === null || typeof request !== 'object') return { ok: false, code: 'INVALID_REQUEST' };
  const slug = typeof request.slug === 'string' ? request.slug.trim() : '';
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(slug)) return { ok: false, code: 'INVALID_REQUEST' };

  const answers = request.answers ?? {};
  if (typeof answers !== 'object' || Array.isArray(answers)) return { ok: false, code: 'INVALID_REQUEST' };
  const keys = Object.keys(answers);
  if (keys.length > SEO_PUBLIC_MAX_ANSWERS) return { ok: false, code: 'INVALID_REQUEST' };

  for (const key of keys) {
    if (!SEO_PUBLIC_ANSWER_KEY_RE.test(key)) return { ok: false, code: 'INVALID_REQUEST' };
    const value = answers[key];
    if (typeof value === 'number' || typeof value === 'boolean') continue;
    if (typeof value !== 'string') return { ok: false, code: 'INVALID_REQUEST' };
    if (value.length > SEO_PUBLIC_MAX_STRING_LENGTH) return { ok: false, code: 'INVALID_REQUEST' };
    if (/[\r\n\t]/.test(value)) return { ok: false, code: 'INVALID_REQUEST' };
    if (containsPersonalData(value)) return { ok: false, code: 'PII_REJECTED' };
  }
  return { ok: true, slug, answers };
}

/**
 * 公开只读 Checker/Calculator 主流程（无副作用）。
 * 结果只来自 server-resolved 生效规则 + 已注册引擎；缺失一律 fail-closed。
 */
export async function runPublicSeoChecker(
  request: SeoPublicRequest,
  ports: SeoPublicCheckerPorts,
): Promise<SeoPublicCheckerOutcome> {
  const validation = validatePublicSeoRequest(request);
  if (!validation.ok) return DENIED(validation.code);

  const now = (ports.now ?? (() => new Date()))();
  const rule = await ports.resolveActiveRule({ slug: validation.slug, now });
  if (rule === null) return DENIED('SLUG_NOT_FOUND');
  if (!validateRecoveryRuleDefinition(rule).ok) return DENIED('SLUG_NOT_FOUND');
  if (!isRecoveryRuleEffective(rule, now)) return DENIED('RULE_NOT_EFFECTIVE');

  const registered = new Set(await ports.listRegisteredBasisKeys());
  const checkerReady = rule.capabilities.checker && registered.has(rule.eligibilityMethod.basisKey);
  const calculatorReady =
    rule.capabilities.calculator &&
    rule.calculationMethod.kind !== 'NONE' &&
    registered.has(rule.calculationMethod.basisKey);

  if (!checkerReady && !calculatorReady) {
    return rule.capabilities.checker || rule.capabilities.calculator
      ? DENIED('NO_RECOVERY_CAPABILITY')
      : DENIED('CHECKER_NOT_AVAILABLE');
  }

  let eligible: boolean | null = null;
  let reasonCodes: readonly string[] = [];
  if (checkerReady) {
    const outcome = await ports.runEligibility({
      basisKey: rule.eligibilityMethod.basisKey,
      rule,
      answers: validation.answers,
    });
    // engine 输出校验：不合法即 fail-closed，绝不把异常值透传给公开调用方。
    if (!isSafeEligibilityOutcome(outcome)) return DENIED('ENGINE_OUTPUT_INVALID');
    eligible = outcome.eligible;
    reasonCodes = outcome.reasonCodes;
  }

  let estimate: SeoPublicEstimate | null = null;
  let estimateLabel: 'ESTIMATE_ONLY' | null = null;
  let disclaimerKey: string | null = null;
  if (calculatorReady && (eligible === null || eligible === true)) {
    const calculation = await ports.runCalculation({
      basisKey: rule.calculationMethod.basisKey,
      rule,
      answers: validation.answers,
    });
    if (!isSafeCalculationOutcome(calculation)) return DENIED('ENGINE_OUTPUT_INVALID');
    estimate = calculation.estimate;
    estimateLabel = 'ESTIMATE_ONLY';
    disclaimerKey = calculation.disclaimerKey;
  }

  return {
    ok: true,
    code: 'CHECKER_RESULT',
    ruleVersion: rule.ruleVersion,
    slug: rule.slug,
    eligible,
    reasonCodes,
    estimate,
    estimateLabel,
    disclaimerKey,
    externalWritePerformed: false,
    tenantDataIncluded: false,
    submissionCreated: false,
    chargingPerformed: false,
    productionCredentials: 'ABSENT',
  };
}

/** 边界自证：公开 Checker/Calculator 不产生任何副作用。 */
export const SEO_PUBLIC_TOOL_BOUNDARY = {
  anonymousOnly: true,
  externalWritePerformed: false,
  databaseWritePerformed: false,
  submissionCreated: false,
  chargingPerformed: false,
  tenantDataIncluded: false,
  piiAccepted: false,
  estimateLabelRequired: true,
  productionCredentials: 'ABSENT',
  actionGuardBypassed: false,
} as const;
