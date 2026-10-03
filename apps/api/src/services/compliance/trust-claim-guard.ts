/**
 * CHANGE A（MSG-20261003-129 REVISE）— Enterprise Trust 禁自证 guard（occurrence / 局部语境）。
 * ---------------------------------------------------------------
 *  · 判定单位是**每一次出现**（occurrence），而不是整个文件：
 *    只有在该 occurrence 的局部窗口内存在否定/未取得语境时，才视为合规表述。
 *  · 文件别处的 NOT_AVAILABLE 不能豁免一句肯定式的 SOC2_COMPLIANT。
 *  · 认证类词汇一律不得被内部自证：SOC2_COMPLIANT / ISO27001_CERTIFIED / BANK_GRADE_SECURITY。
 */

export const FORBIDDEN_TRUST_CLAIMS = ['SOC2_COMPLIANT', 'ISO27001_CERTIFIED', 'BANK_GRADE_SECURITY'] as const;

/** 局部否定语境标记（必须与被禁词出现在同一窗口内才放行）。 */
export const NEGATION_MARKERS = [
  '未取得',
  '不得宣称',
  '不得对外宣称',
  '不得声称',
  '不得自证',
  '不得被内部自证',
  '禁止',
  '不予宣称',
  'NOT_AVAILABLE',
  'not available',
  'not obtained',
] as const;

export const DEFAULT_CONTEXT_WINDOW = 160;

export interface SelfAssertedClaim {
  claim: string;
  index: number;
  excerpt: string;
}

/**
 * 逐 occurrence 判定：返回仍然“肯定式自证”的命中列表（空数组 = 合规）。
 * 语境 = **该 occurrence 所在行**（同一句/同一行内的否定才放行）；若同一行过长则回退到固定窗口。
 * 这样「文件别处出现 NOT_AVAILABLE」不会豁免肯定式的 SOC2_COMPLIANT。
 */
export function findSelfAssertedClaims(
  text: string,
  options: { window?: number } = {},
): readonly SelfAssertedClaim[] {
  const window = options.window ?? DEFAULT_CONTEXT_WINDOW;
  const hits: SelfAssertedClaim[] = [];
  for (const claim of FORBIDDEN_TRUST_CLAIMS) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(claim, from);
      if (index < 0) break;
      const lineStart = text.lastIndexOf('\n', index) + 1;
      const lineEndRaw = text.indexOf('\n', index);
      const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
      const line = text.slice(lineStart, lineEnd);
      const context =
        line.length <= window * 4
          ? line
          : text.slice(Math.max(0, index - window), Math.min(text.length, index + claim.length + window));
      const negated = NEGATION_MARKERS.some((marker) => context.includes(marker));
      if (!negated) {
        hits.push({ claim, index, excerpt: context.replace(/\s+/g, ' ').slice(0, 240) });
      }
      from = index + claim.length;
    }
  }
  return hits.sort((left, right) => left.index - right.index);
}
