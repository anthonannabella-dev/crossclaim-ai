// ============================================================
// HS编码查询服务 — 基础测试
// ============================================================
import { describe, it, expect, vi, beforeAll } from 'vitest';

describe('HSCode 查询服务', () => {
  
  it('应该正确格式化HS编码', () => {
    const formatCode = (code: string) => {
      const digits = code.replace(/[^0-9]/g, '');
      if (digits.length >= 6) {
        return digits.slice(0, 4) + '.' + digits.slice(4, 6) + (digits.length > 6 ? '.' + digits.slice(6) : '');
      }
      return code;
    };

    expect(formatCode('847130')).toBe('8471.30');
    expect(formatCode('84713000')).toBe('8471.30.00');
    expect(formatCode('8471.30')).toBe('8471.30');
  });

  it('应该正确识别商品品类', () => {
    const inferCategory = (chapterNum: number): string => {
      if (chapterNum >= 1 && chapterNum <= 24) return '农产品';
      if (chapterNum >= 72 && chapterNum <= 83) return '金属制品';
      if (chapterNum >= 84 && chapterNum <= 85) return '机电产品';
      if (chapterNum >= 28 && chapterNum <= 38) return '化工品';
      return '其他';
    };

    expect(inferCategory(1)).toBe('农产品');
    expect(inferCategory(72)).toBe('金属制品');
    expect(inferCategory(84)).toBe('机电产品');
    expect(inferCategory(29)).toBe('化工品');
    expect(inferCategory(99)).toBe('其他');
  });

  it('CBAM 行业检测应该正确', () => {
    const CBAM_SECTORS: Record<string, string> = {
      '72': '钢铁', '76': '铝', '2523': '水泥',
      '3102': '化肥', '2716': '电力', '2804': '氢',
    };

    const detect = (code: string): string | null => {
      const norm = code.replace(/[^0-9]/g, '');
      for (const [prefix, name] of Object.entries(CBAM_SECTORS)) {
        if (norm.startsWith(prefix)) return name;
      }
      return null;
    };

    expect(detect('7220.11')).toBe('钢铁');
    expect(detect('7601.10')).toBe('铝');
    expect(detect('8471.30')).toBeNull();
    expect(detect('2523.10')).toBe('水泥');
  });
});

describe('财税计算', () => {
  it('出口退税率应该正确匹配HS前缀', () => {
    const REBATE_RATES: Record<string, number> = {
      '03': 9, '04': 9, '16': 13, '17': 13,
      '84': 13, '85': 13, '01': 0, '10': 0,
    };

    const getRate = (hsPrefix: string): number => {
      return REBATE_RATES[hsPrefix] ?? 0;
    };

    expect(getRate('03')).toBe(9);
    expect(getRate('84')).toBe(13);
    expect(getRate('01')).toBe(0);
    expect(getRate('99')).toBe(0);
  });
});
