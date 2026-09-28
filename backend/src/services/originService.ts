export interface RvcInput {
  fobValue: number;
  nonOriginatingValue: number;
}

export interface RvcResult {
  percentage: number;
  passed: boolean;
  threshold: number;
  formula: 'direct';
}

export function calculateRvc(input: RvcInput, threshold: number): RvcResult {
  if (input.fobValue <= 0) {
    throw new Error('FOB价值必须大于0');
  }
  if (input.nonOriginatingValue < 0) {
    throw new Error('非原产材料价值不能为负数');
  }
  if (input.nonOriginatingValue > input.fobValue) {
    return { percentage: 0, passed: false, threshold, formula: 'direct' };
  }
  const percentage = ((input.fobValue - input.nonOriginatingValue) / input.fobValue) * 100;
  return {
    percentage: Math.round(percentage * 100) / 100,
    passed: percentage >= threshold,
    threshold,
    formula: 'direct',
  };
}

export interface MaterialInput {
  hsCode: string;
  originCountry: string;
  value: number;
}

export interface OriginRuleInput {
  ruleType: string;
  ruleDetail: string | null;
  rvcThreshold: number | null;
}

export interface OriginDeterminationInput {
  ftaMemberCountries: string[];
  materials: MaterialInput[];
  fobValue: number;
  rule: OriginRuleInput;
}

export interface OriginDeterminationResult {
  qualifies: boolean;
  ruleType: string;
  rvcResult: RvcResult | null;
  reasons: string[];
  nonOriginatingTotal: number;
}

export function determineOrigin(input: OriginDeterminationInput): OriginDeterminationResult {
  const reasons: string[] = [];
  const nonOriginatingTotal = input.materials
    .filter(m => !input.ftaMemberCountries.includes(m.originCountry))
    .reduce((sum, m) => sum + m.value, 0);

  const { ruleType } = input.rule;

  switch (ruleType) {
    case 'WO': {
      const allOriginating = input.materials.every(m =>
        input.ftaMemberCountries.includes(m.originCountry)
      );
      reasons.push(allOriginating
        ? '所有原材料均来自成员国，符合完全获得标准'
        : '部分原材料来自非成员国，不符合完全获得标准'
      );
      return { qualifies: allOriginating, ruleType: 'WO', rvcResult: null, reasons, nonOriginatingTotal };
    }

    case 'RVC': {
      if (input.rule.rvcThreshold == null) {
        reasons.push('RVC规则缺少阈值配置');
        return { qualifies: false, ruleType: 'RVC', rvcResult: null, reasons, nonOriginatingTotal };
      }
      const rvcResult = calculateRvc(
        { fobValue: input.fobValue, nonOriginatingValue: nonOriginatingTotal },
        input.rule.rvcThreshold
      );
      reasons.push(`RVC计算: ${rvcResult.percentage}% (阈值≥${rvcResult.threshold}%) — ${rvcResult.passed ? '通过' : '未通过'}`);
      return { qualifies: rvcResult.passed, ruleType: 'RVC', rvcResult, reasons, nonOriginatingTotal };
    }

    case 'CC':
    case 'CTH':
    case 'PE':
    case 'SP': {
      reasons.push(`规则类型 ${ruleType} 需要详细税则归类比对确认`);
      if (input.rule.rvcThreshold != null) {
        const rvcResult = calculateRvc(
          { fobValue: input.fobValue, nonOriginatingValue: nonOriginatingTotal },
          input.rule.rvcThreshold
        );
        reasons.push(`RVC替代判定: ${rvcResult.percentage}% (阈值≥${rvcResult.threshold}%) — ${rvcResult.passed ? '通过' : '未通过'}`);
        return { qualifies: rvcResult.passed, ruleType, rvcResult, reasons, nonOriginatingTotal };
      }
      reasons.push('建议进行详细税则归类比对以最终确认');
      return { qualifies: false, ruleType, rvcResult: null, reasons, nonOriginatingTotal };
    }

    default:
      throw new Error(`未知规则类型: ${ruleType}`);
  }
}
