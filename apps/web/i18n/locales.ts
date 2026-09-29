import type { Messages } from './dictionaries/zh-CN';
import zhCN from './dictionaries/zh-CN';
import enUS from './dictionaries/en-US';
import de from './dictionaries/de';
import ja from './dictionaries/ja';
import es from './dictionaries/es';
import { isPlaceholder } from './dictionaries/placeholder';

/**
 * C-0009.2 Step 1 / C-0015-I18N-LAYER — 支持的语言与解析规则（不引入 i18n 库）。
 * 架构方裁定（MSG-20260929-05）：i18n 轻量层仅限「字典结构 + locale 识别 + UI 文案切换」，
 * 不含 LLM 多语言业务输出、索赔信自动多语言生成与站点语言策略。
 */
export const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'de', 'ja', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';
export const LOCALE_COOKIE = 'cc_lang';

const DICTIONARIES: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  de,
  ja,
  es,
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
 * 纯函数，便于单测；五种语言均可直接命中，未知语言回落到默认 zh-CN。
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
  // 预留给未来新增语言：若某语言仍为占位字典（空值），回落到默认字典而不是展示半成品翻译。
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
 * 2. 已发布的语言不得留下空值（半成品翻译）。
 * 这样"i18n 键一致性"由 CI 强制，而不是靠人工检查。
 * `dictionaries/placeholder.ts` 保留给未来新增语言（第六种语言先占位、后翻译）。
 */
function assertDictionaryIntegrity(): void {
  const base = flattenKeys(DICTIONARIES[DEFAULT_LOCALE]).join('|');
  for (const locale of SUPPORTED_LOCALES) {
    const keys = flattenKeys(DICTIONARIES[locale]).join('|');
    if (keys !== base) {
      throw new Error(`[i18n] 字典键与 ${DEFAULT_LOCALE} 不一致：${locale}`);
    }
  }
  for (const locale of SUPPORTED_LOCALES) {
    const blanks = blankValues(DICTIONARIES[locale]);
    if (blanks.length > 0) {
      throw new Error(`[i18n] 语言 ${locale} 存在空值文案（半成品翻译）：${blanks.slice(0, 5).join(', ')}`);
    }
  }
}

/** 收集空字符串文案的键路径。 */
function blankValues(messages: Messages): string[] {
  const flatten = (value: unknown, prefix = ''): Array<[string, string]> =>
    typeof value === 'string'
      ? [[prefix, value]]
      : Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
          flatten(nested, prefix === '' ? key : `${prefix}.${key}`),
        );
  return flatten(messages)
    .filter(([, text]) => text.trim() === '')
    .map(([key]) => key);
}

assertDictionaryIntegrity();
