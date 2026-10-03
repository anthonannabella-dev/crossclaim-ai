export {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  getDictionary,
  isLocalePlaceholder,
  isSupportedLocale,
  rawDictionary,
  resolveLocale,
  type Locale,
} from './locales';
export type { Messages } from './dictionaries/zh-CN';

export {
  BUSINESS_LANGUAGE_BOUNDARY,
  CUSTOMER_STATUS_CODES,
  JURISDICTION_DEFAULT_LOCALES,
  PROVIDER_LANGUAGE_RULES,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
  resolveClaimLocale,
  resolveFrozenLocale,
  resolveProviderLocale,
  resolveReportLocale,
  resolveUiLocale,
  statusLabel,
} from './business-language';
export type { BusinessLanguageSource, ResolvedLocale } from './business-language';
