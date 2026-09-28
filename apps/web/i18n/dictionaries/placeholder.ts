import type { Messages } from './zh-CN';
import zhCN from './zh-CN';

/**
 * C-0009.2 Step 1 — 预留语言的占位字典。
 * 键必须齐全（类型 + 测试保证），值留空：UI 会把未翻译语言标为「即将支持」并置灰，
 * 避免出现中英混杂的"假多语言"。
 */
function blank(value: unknown): unknown {
  if (typeof value === 'string') return '';
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, blank(nested)]),
  );
}

export function placeholderMessages(): Messages {
  return blank(zhCN) as Messages;
}

/** 字典是否含有真实翻译（占位语言全为空字符串）。 */
export function isPlaceholder(messages: Messages): boolean {
  const flatten = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Object.values(value as Record<string, unknown>).flatMap((nested) => flatten(nested));
  return flatten(messages).every((entry) => entry === '');
}
