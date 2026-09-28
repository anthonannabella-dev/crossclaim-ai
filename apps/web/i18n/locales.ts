import type { Messages } from './dictionaries/zh-CN';
import zhCN from './dictionaries/zh-CN';
import enUS from './dictionaries/en-US';
import { isPlaceholder, placeholderMessages } from './dictionaries/placeholder';

/** C-0009.2 Step 1 — 支持的语言与解析规则（不引入 i18n 库）。 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'de', 'ja', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const LOCALE_COOKIE = 'cc_lang';

const DICTIONARIES: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  de: placeholderMessages(),
  ja: placeholderMessages(),
  es: placeholderMessages(),
};

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** 该语言是否只有占位翻译（UI 上置灰、不可选）。 */
export function isLocalePlaceholder(locale: Locale): boolean {
  return isPlaceholder(DICTIONARIES[locale]);
}

/**
 * 解析优先级：用户 cookie → Accept-Language → 默认 zh-CN。
 * 纯函数，便于单测；`de`/`ja`/`es` 目前是占位语言，解析后回落到默认语言。
 */
export function resolveLocale(input: {
  cookie?: string | undefined;
  acceptLanguage?: string | undefined;
}): Locale {
  const fromCookie = normalize(input.cookie);
  if (fromCookie) return fromCookie;

  for (const part of (input.acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim();
    const normalized = normalize(tag);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

function normalize(tag: string | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  if (lower.startsWith('de')) return 'de';
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('es')) return 'es';
  return null;
}

export function getDictionary(locale: Locale): Messages {
  // 占位语言不对外展示半成品翻译：直接回落到默认字典
  return isLocalePlaceholder(locale) ? DICTIONARIES[DEFAULT_LOCALE] : DICTIONARIES[locale];
}

/** 供测试使用：某语言的原始（可能为占位）字典。 */
export function rawDictionary(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

/** 展平字典键（用于一致性不变量）。 */
export function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenKeys(nested, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/**
 * 构建期不变量（`next build` 与运行时都会执行）：
 * 1. 所有语言的键集合必须与 zh-CN 完全一致；
 * 2. de / ja / es 必须保持占位（不得混入真实翻译）。
 * 这样"i18n 键一致性"由 CI 强制，而不是靠人工检查。
 */
function assertDictionaryIntegrity(): void {
  const base = flattenKeys(DICTIONARIES[DEFAULT_LOCALE]).join('|');
  for (const locale of SUPPORTED_LOCALES) {
    const keys = flattenKeys(DICTIONARIES[locale]).join('|');
    if (keys !== base) {
      throw new Error(`[i18n] 字典键与 ${DEFAULT_LOCALE} 不一致：${locale}`);
    }
  }
  for (const locale of ['de', 'ja', 'es'] as const) {
    if (!isPlaceholder(DICTIONARIES[locale])) {
      throw new Error(`[i18n] 预留语言 ${locale} 应保持占位（值为空），不能混入半成品翻译`);
    }
  }
}

assertDictionaryIntegrity();
