/**
 * C-0009.3 P0 — display masking for sensitive identifiers.
 * ---------------------------------------------------------------
 * Architect ruling (MSG-20260928-71/72): masking is a **display convenience**
 * for the data owner — it never hides the customer's own data. Authorized users
 * keep full access (raw values are still returned on the unmasked view and the
 * original files stay downloadable). Masking only applies to the rendered
 * diagnostic report so screenshots/shares do not leak identifiers.
 */

export type MaskKind = 'ORDER_ID' | 'FNSKU' | 'TRACKING' | 'GENERIC';

export const MASK_TOKEN = '****';

/**
 * 掩码规则（确定性）：
 * → ORDER_ID ：保留首段 + 末 4 位，中间 `****`（示例：112-****-4821）
 * → FNSKU    ：保留前 3 + 末 3
 * → TRACKING ：保留前 2 + 末 4
 * → GENERIC  ：保留前 2 + 末 2
 * 过短（去掉分隔符后不足 8 个字符）时整体掩码为 `****`，避免"掩了等于没掩"。
 */
export function maskIdentifier(value: string | null | undefined, kind: MaskKind = 'GENERIC'): string | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw === '') return '';

  const compact = raw.replace(/[^0-9A-Za-z]/g, '');
  if (compact.length < 8) return MASK_TOKEN;

  if (kind === 'ORDER_ID' && raw.includes('-')) {
    const segments = raw.split('-');
    if (segments.length >= 2) {
      const last = segments[segments.length - 1] ?? '';
      return `${segments[0]}-${MASK_TOKEN}-${last.length > 4 ? last.slice(-4) : last}`;
    }
  }

  const [head, tail] =
    kind === 'ORDER_ID'
      ? [1, 4]
      : kind === 'FNSKU'
        ? [3, 3]
        : kind === 'TRACKING'
          ? [2, 4]
          : [2, 2];

  if (compact.length <= head + tail) return MASK_TOKEN;
  return `${raw.slice(0, head)}${MASK_TOKEN}${raw.slice(-tail)}`;
}
