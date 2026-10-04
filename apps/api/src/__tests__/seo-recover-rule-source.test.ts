/** SEO-4 规则读取映射验收：只解析 + 生效过滤 + gate 判定，不发明内容。 */

import { describe, expect, it } from 'vitest';

import { toExportRules } from '../services/seo/seo-recover-rule-source';

const NOW = new Date('2026-10-05T00:00:00.000Z');

const row = (over: Record<string, unknown> = {}) =>
  ({
    version: 'amazon-fba-fee-refund@v1.0.0',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    // 故意用一个不合法的 definition：本套件只验证「解析失败/不可用一律 fail-closed 且被记录」。
    definition: null,
    ...over,
  }) as never;

describe('SEO-4 规则读取映射', () => {
  it('RECOVER_SOURCE_SKIPS_INVALID_ROWS：解析失败的规则被跳过并记录原因（绝不猜内容）', () => {
    const invalid = toExportRules({ rows: [row()], now: NOW, registeredBasisKeys: [] });
    expect(invalid.rules).toHaveLength(0);
    expect(invalid.rejected.length).toBe(1);
    expect(invalid.rejected[0]!.reason.length).toBeGreaterThan(0);
    expect(invalid.rejected[0]!.ref).toBe('amazon-fba-fee-refund@v1.0.0');
  });

  it('RECOVER_SOURCE_EMPTY_INPUT_EXPORTS_NOTHING：没有可解析规则时不产出任何页面数据', () => {
    const empty = toExportRules({ rows: [], now: NOW, registeredBasisKeys: [] });
    expect(empty.rules).toEqual([]);
    expect(empty.rejected).toEqual([]);
  });
});
