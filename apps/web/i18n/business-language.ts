/**
 * BUSINESS LANGUAGE LAYER（HOST DIRECTIVE 2026-10-04 §六/§七/§十/§十二）
 * ---------------------------------------------------------------
 * 明确区分四种语言，禁止把它们当成同一个 locale：
 *   uiLocale       — 客户操作界面语言（cookie → Accept-Language → zh-CN）
 *   reportLocale   — 客户查看/下载报告的语言（可显式选择；保存后冻结）
 *   claimLocale    — Claim / Appeal / Evidence Package 文本语言（按 Provider/Jurisdiction 解析；生成后冻结）
 *   providerLocale — 目标 Provider / Jurisdiction 要求使用的语言
 *
 * 约束：
 *   · 业务内容语言不得直接继承 UI locale。
 *   · 解析一律 fail-safe：未知输入回落到明确记录的 fallback，绝不抛错中断业务。
 *   · 本模块只做「语言决策 + 显示格式化」，不做任何 authoritative 金额计算。
 */

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveLocale, type Locale } from './index';

export type BusinessLanguageSource = 'override' | 'frozen' | 'provider' | 'marketplace' | 'jurisdiction' | 'ui' | 'fallback';

export interface ResolvedLocale {
  locale: Locale;
  source: BusinessLanguageSource;
  /** 当输入无法判定时置 true（调用方应记录以便审计）。 */
  failSafe: boolean;
}

export interface ProviderLanguageRule {
  provider: string;
  defaultLocale: Locale;
  marketplaceLocales?: Record<string, Locale>;
}

/** Provider 规则表（品牌名不翻译；这里只决定文本语言）。 */
export const PROVIDER_LANGUAGE_RULES: readonly ProviderLanguageRule[] = [
  { provider: 'AMAZON', defaultLocale: 'en-US', marketplaceLocales: { us: 'en-US', de: 'de', jp: 'ja', es: 'es', cn: 'zh-CN' } },
  { provider: 'TIKTOK_SHOP', defaultLocale: 'en-US', marketplaceLocales: { us: 'en-US', de: 'de', jp: 'ja', es: 'es' } },
  { provider: 'WALMART', defaultLocale: 'en-US' },
  { provider: 'SHOPIFY', defaultLocale: 'en-US' },
  { provider: 'UPS', defaultLocale: 'en-US' },
  { provider: 'FEDEX', defaultLocale: 'en-US' },
  { provider: 'DHL', defaultLocale: 'en-US', marketplaceLocales: { de: 'de' } },
  { provider: 'STRIPE', defaultLocale: 'en-US' },
  { provider: 'PAYPAL', defaultLocale: 'en-US' },
  { provider: 'CBP', defaultLocale: 'en-US' },
  { provider: 'EU_CUSTOMS', defaultLocale: 'de' },
  { provider: 'JP_CUSTOMS', defaultLocale: 'ja' },
];

/**
 * Jurisdiction 默认语言。不是「国家 = 单一语言」的硬规则——它只是默认值，
 * 允许 provider-specific 规则与用户 override 覆盖（§十）。
 */
export const JURISDICTION_DEFAULT_LOCALES: Readonly<Record<string, Locale>> = {
  US: 'en-US',
  GB: 'en-US',
  CA: 'en-US',
  AU: 'en-US',
  DE: 'de',
  AT: 'de',
  CH: 'de',
  JP: 'ja',
  CN: 'zh-CN',
  HK: 'zh-CN',
  TW: 'zh-CN',
  ES: 'es',
  MX: 'es',
  AR: 'es',
  CO: 'es',
};

const FALLBACK_LOCALE: Locale = 'en-US';

function asLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const raw = String(value).trim();
  if ((SUPPORTED_LOCALES as readonly string[]).includes(raw)) return raw as Locale;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('es')) return 'es';
  return null;
}

/** uiLocale：沿用既有 cookie → Accept-Language → zh-CN 规则（唯一 UI 语言来源）。 */
export function resolveUiLocale(input: { cookie?: string | undefined; acceptLanguage?: string | undefined }): ResolvedLocale {
  const locale = resolveLocale(input);
  return { locale, source: 'ui', failSafe: false };
}

/**
 * reportLocale：显式选择 > 冻结值 > uiLocale。
 * 报告一经保存必须冻结（frozen），此后 UI 切换语言不得改变历史报告语言（§八）。
 */
export function resolveReportLocale(input: {
  uiLocale: Locale;
  explicit?: string | null;
  frozen?: string | null;
}): ResolvedLocale {
  const explicit = asLocale(input.explicit);
  if (explicit) return { locale: explicit, source: 'override', failSafe: false };
  const frozen = asLocale(input.frozen);
  if (frozen) return { locale: frozen, source: 'frozen', failSafe: false };
  return { locale: input.uiLocale, source: 'ui', failSafe: false };
}

/**
 * claimLocale：显式 > providerLocale > jurisdiction 默认 > uiLocale。
 * Claim / Appeal 生成后必须把结果与 language 一起冻结（§九）。
 */
export function resolveClaimLocale(input: {
  uiLocale: Locale;
  explicit?: string | null;
  providerLocale?: Locale | null;
  jurisdiction?: string | null;
}): ResolvedLocale {
  const explicit = asLocale(input.explicit);
  if (explicit) return { locale: explicit, source: 'override', failSafe: false };
  if (input.providerLocale) return { locale: input.providerLocale, source: 'provider', failSafe: false };
  const jurisdiction = input.jurisdiction ? JURISDICTION_DEFAULT_LOCALES[String(input.jurisdiction).toUpperCase()] : undefined;
  if (jurisdiction) return { locale: jurisdiction, source: 'jurisdiction', failSafe: false };
  return { locale: input.uiLocale, source: 'ui', failSafe: false };
}

/**
 * providerLocale：user override > marketplace > provider 默认 > jurisdiction 默认 > fail-safe(en-US)。
 * 任何一步无法判定都不抛错；failSafe=true 表示走了兜底，调用方应记录审计。
 */
export function resolveProviderLocale(input: {
  provider?: string | null;
  marketplace?: string | null;
  jurisdiction?: string | null;
  override?: string | null;
}): ResolvedLocale {
  const override = asLocale(input.override);
  if (override) return { locale: override, source: 'override', failSafe: false };

  const providerKey = String(input.provider ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const rule = PROVIDER_LANGUAGE_RULES.find((item) => item.provider === providerKey);

  const marketplace = input.marketplace ? String(input.marketplace).trim().toLowerCase() : '';
  const suffix = marketplace.split('.').pop() ?? '';
  if (rule?.marketplaceLocales && suffix && rule.marketplaceLocales[suffix]) {
    return { locale: rule.marketplaceLocales[suffix], source: 'marketplace', failSafe: false };
  }
  if (rule) return { locale: rule.defaultLocale, source: 'provider', failSafe: false };

  const jurisdiction = input.jurisdiction ? JURISDICTION_DEFAULT_LOCALES[String(input.jurisdiction).toUpperCase()] : undefined;
  if (jurisdiction) return { locale: jurisdiction, source: 'jurisdiction', failSafe: false };

  return { locale: FALLBACK_LOCALE, source: 'fallback', failSafe: true };
}

/** 已冻结的 Claim/Report 语言不得被 UI 切换改写。 */
export function resolveFrozenLocale(input: { frozen?: string | null; requested?: string | null; fallback: Locale }): ResolvedLocale {
  const frozen = asLocale(input.frozen);
  if (frozen) return { locale: frozen, source: 'frozen', failSafe: false };
  const requested = asLocale(input.requested);
  if (requested) return { locale: requested, source: 'override', failSafe: false };
  return { locale: input.fallback, source: 'fallback', failSafe: false };
}

/* ------------------------------------------------------------------ *
 * 显示格式化（§十二/§十三）：只做 display formatting，不做金额计算。
 * 金额与数值一律来自后端；多币种不得相加（调用方按 currency 分组展示）。
 * ------------------------------------------------------------------ */

export function formatMoney(
  amount: string | number,
  options: { locale: Locale; currency: string; timezone?: string },
): string {
  const numeric = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(numeric)) return String(amount);
  return new Intl.NumberFormat(options.locale, {
    style: 'currency',
    currency: options.currency,
    ...(options.timezone ? { timeZone: options.timezone } : {}),
  }).format(numeric);
}

export function formatDate(value: string | Date, options: { locale: Locale; timezone?: string }): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: 'medium',
    ...(options.timezone ? { timeZone: options.timezone } : {}),
  }).format(date);
}

export function formatDateTime(value: string | Date, options: { locale: Locale; timezone?: string }): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(options.timezone ? { timeZone: options.timezone } : {}),
  }).format(date);
}

export function formatNumber(value: string | number, options: { locale: Locale; maximumFractionDigits?: number }): string {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat(options.locale, {
    ...(options.maximumFractionDigits !== undefined ? { maximumFractionDigits: options.maximumFractionDigits } : {}),
  }).format(numeric);
}

export function formatPercent(value: string | number, options: { locale: Locale; maximumFractionDigits?: number }): string {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat(options.locale, {
    style: 'percent',
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(numeric);
}

/* ------------------------------------------------------------------ *
 * 状态本地化（§五）：Backend code = stable；Frontend label = localized。
 * 未知 code 一律走 fallback 文案，绝不把原始 code 直接当用户文案。
 * ------------------------------------------------------------------ */

export const CUSTOMER_STATUS_CODES = [
  'DETECTED',
  'QUALIFIED',
  'REJECTED',
  'CONVERTED',
  'EXPIRED',
  'SUBMITTED',
  'APPROVED',
  'PAID',
  'RECEIVED',
  'NEEDS_DATA',
  'NEEDS_REVIEW',
  'PROCESSING',
  'FAILED',
] as const;
export type CustomerStatusCode = (typeof CUSTOMER_STATUS_CODES)[number];

export function statusLabel(code: string | null | undefined, messages: { status: Record<string, string> }): string {
  const key = String(code ?? '').trim().toUpperCase();
  const label = messages.status[key];
  return label ?? messages.status.UNKNOWN ?? '—';
}

export const BUSINESS_LANGUAGE_BOUNDARY = {
  uiLocaleSource: 'cc_lang cookie → Accept-Language → zh-CN',
  businessLocaleInheritsUi: false,
  reportLocaleFrozenOnSave: true,
  claimLocaleFrozenOnGeneration: true,
  providerFallback: FALLBACK_LOCALE,
  defaultUiLocale: DEFAULT_LOCALE,
  frontendDoesFinancialCalculation: false,
  multiCurrencyNeverSummedWithoutFxSnapshot: true,
  brandNamesTranslated: false,
} as const;
