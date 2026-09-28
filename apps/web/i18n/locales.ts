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
