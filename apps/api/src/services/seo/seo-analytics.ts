/**
 * SEO-7 — PROVIDER-NEUTRAL SEO FUNNEL EVENT CONTRACT（TRACK C / SEO P3）
 * ---------------------------------------------------------------
 * 为 SEO 漏斗预留**与第三方分析供应商无关**的事件契约（analytics provider 未定时不硬绑定）。
 *
 * 硬规则：
 *   · 无 PII、无租户数据：不接受邮箱/电话/税号/裸 URL/长数字串，不接受 organizationId / tenantRef；
 *   · 金额只能是**估算区间 + ESTIMATE_ONLY 标记**，绝不允许"保证追回"类语义；
 *   · 事件只描述漏斗步骤，不承载 submission / payment / provider 状态；
 *   · 本模块只做纯校验 + 规范化，不发送任何请求（sink 由调用方注入）。
 */

export const SEO_FUNNEL_EVENTS = [
  'seo_page_view',
  'checker_started',
  'checker_completed',
  'calculator_started',
  'calculator_completed',
  'estimated_recovery_shown',
  'connect_clicked',
  'upload_clicked',
  'signup_started',
  'signup_completed',
  'recovery_started',
] as const;
export type SeoFunnelEvent = (typeof SEO_FUNNEL_EVENTS)[number];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d[\s().-]?){7,}/;
const TAX_ID_RE = /\b\d{2}-\d{7}\b/;
const LONG_DIGITS_RE = /\b\d{6,}\b/;
const URL_RE = /(https?:\/\/|www\.|javascript:|data:)/i;
const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;

/** 明确禁止出现在事件里的字段名（租户 / 身份 / 凭据）。 */
export const SEO_EVENT_FORBIDDEN_FIELDS = [
  'organizationId',
  'tenantRef',
  'providerTenantRef',
  'providerAccountRef',
  'email',
  'phone',
  'taxId',
  'ein',
  'credentialReference',
  'clientSecret',
  'accessToken',
] as const;

export type SeoEventRejectionCode =
  | 'UNKNOWN_EVENT'
  | 'FORBIDDEN_FIELD'
  | 'PII_DETECTED'
  | 'INVALID_SLUG'
  | 'INVALID_LOCALE'
  | 'INVALID_ESTIMATE'
  | 'INVALID_PROPERTY';

export interface SeoEstimateBand {
  min: number;
  max: number;
  currency: string;
  /** 永远必须是 ESTIMATE_ONLY —— 事件层不接受"保证金额"。 */
  label: 'ESTIMATE_ONLY';
}

export interface SeoFunnelEventInput {
  event: string;
  /** 页面 slug（opaque，用于聚合，不含 PII）。 */
  slug?: string | null;
  locale?: string | null;
  /** 匿名会话指纹哈希（只允许哈希，不允许原始标识）。 */
  sessionHash?: string | null;
  /** 估算区间（仅 estimated_recovery_shown 等事件使用）。 */
  estimate?: SeoEstimateBand | null;
  /** 其它标量属性（键受白名单约束、值不得含 PII）。 */
  properties?: Record<string, string | number | boolean>;
}

export interface SeoFunnelEventRecord {
  event: SeoFunnelEvent;
  slug: string | null;
  locale: string | null;
  sessionHash: string | null;
  estimate: SeoEstimateBand | null;
  properties: Record<string, string | number | boolean>;
  /** 边界自证：事件记录不含租户数据 / PII，也不代表任何真实提交或扣费。 */
  piiIncluded: false;
  tenantDataIncluded: false;
  submissionCreated: false;
  chargingPerformed: false;
}

export interface SeoFunnelEventSink {
  emit(record: SeoFunnelEventRecord): Promise<void>;
}

const containsPii = (value: string): boolean =>
  EMAIL_RE.test(value) || PHONE_RE.test(value) || TAX_ID_RE.test(value) || LONG_DIGITS_RE.test(value) || URL_RE.test(value);

/** 纯校验 + 规范化：非法事件一律拒绝，绝不"尽力发出"。 */
export function buildSeoFunnelEventRecord(
  input: SeoFunnelEventInput,
): { ok: true; record: SeoFunnelEventRecord } | { ok: false; code: SeoEventRejectionCode; detail: string } {
  if (!(SEO_FUNNEL_EVENTS as readonly string[]).includes(input?.event)) {
    return { ok: false, code: 'UNKNOWN_EVENT', detail: 'event is not in the provider-neutral funnel vocabulary' };
  }

  const properties = input.properties ?? {};
  for (const key of Object.keys(properties)) {
    if ((SEO_EVENT_FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, code: 'FORBIDDEN_FIELD', detail: 'forbidden property: ' + key };
    }
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) {
      return { ok: false, code: 'INVALID_PROPERTY', detail: 'invalid property key: ' + key };
    }
    const value = properties[key];
    if (typeof value === 'string') {
      if (value.length > 120 || /[\r\n\t]/.test(value)) {
        return { ok: false, code: 'INVALID_PROPERTY', detail: 'invalid property value for ' + key };
      }
      if (containsPii(value)) return { ok: false, code: 'PII_DETECTED', detail: 'property ' + key + ' contains PII' };
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      return { ok: false, code: 'INVALID_PROPERTY', detail: 'unsupported property type for ' + key };
    }
  }

  const slug = input.slug ?? null;
  if (slug !== null && !SLUG_RE.test(slug)) return { ok: false, code: 'INVALID_SLUG', detail: 'slug must be a token' };

  const locale = input.locale ?? null;
  if (locale !== null && !/^[a-z]{2}$/.test(locale)) {
    return { ok: false, code: 'INVALID_LOCALE', detail: 'locale must be a two-letter code' };
  }

  const sessionHash = input.sessionHash ?? null;
  if (sessionHash !== null && !/^[0-9a-f]{64}$/.test(sessionHash)) {
    return { ok: false, code: 'INVALID_PROPERTY', detail: 'sessionHash must be a 64-char lowercase hex digest' };
  }

  const estimate = input.estimate ?? null;
  if (estimate !== null) {
    const valid =
      Number.isFinite(estimate.min) &&
      Number.isFinite(estimate.max) &&
      estimate.min >= 0 &&
      estimate.max >= estimate.min &&
      typeof estimate.currency === 'string' &&
      /^[A-Z]{3}$/.test(estimate.currency) &&
      estimate.label === 'ESTIMATE_ONLY';
    if (!valid) {
      return { ok: false, code: 'INVALID_ESTIMATE', detail: 'estimate must be a labelled ESTIMATE_ONLY band' };
    }
  }

  return {
    ok: true,
    record: {
      event: input.event as SeoFunnelEvent,
      slug,
      locale,
      sessionHash,
      estimate,
      properties,
      piiIncluded: false,
      tenantDataIncluded: false,
      submissionCreated: false,
      chargingPerformed: false,
    },
  };
}

/**
 * 通过注入的 sink 发送（provider-neutral）。校验失败时**不发送**，并返回拒绝原因。
 */
export async function emitSeoFunnelEvent(
  input: SeoFunnelEventInput,
  sink: SeoFunnelEventSink,
): Promise<{ ok: true } | { ok: false; code: SeoEventRejectionCode; detail: string }> {
  const built = buildSeoFunnelEventRecord(input);
  if (!built.ok) return built;
  await sink.emit(built.record);
  return { ok: true };
}

/** 边界自证：事件契约不产生副作用、不含租户/PII、不代表提交或扣费。 */
export const SEO_ANALYTICS_BOUNDARY = {
  providerNeutral: true,
  piiAccepted: false,
  tenantDataAccepted: false,
  requiresEstimateLabel: true,
  externalWritePerformed: false,
  submissionCreated: false,
  chargingPerformed: false,
  productionCredentials: 'ABSENT',
} as const;
