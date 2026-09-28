// CBAM (Carbon Border Adjustment Mechanism) 碳关税计算引擎
// 基于 EU Regulation 2023/956 及 Implementing Regulation (EU) 2024/1789
// 参考 EU JRC 最佳可用数据及行业基准排放因子

// ============================================================
// 1. CBAM 六大行业定义
// ============================================================

export type CBAMSector = 'steel' | 'aluminum' | 'cement' | 'fertilizer' | 'electricity' | 'hydrogen';

export interface SectorInfo {
  sector: CBAMSector;
  name: string;
  cnName: string;
  cnCodes: string[];         // Combined Nomenclature codes (EU)
  hsPrefixes: string[];       // 对应 HS 编码前缀
  defaultUnit: string;
}

export const CBAM_SECTORS: SectorInfo[] = [
  {
    sector: 'steel', name: 'Iron & Steel', cnName: '钢铁',
    cnCodes: ['7206-7229', '7301-7326'],
    hsPrefixes: ['72', '7301', '7302', '7303', '7304', '7305', '7306', '7307', '7308', '7309', '7310', '7311', '7312', '7313', '7314', '7315', '7316', '7317', '7318', '7319', '7320', '7321', '7322', '7323', '7324', '7325', '7326'],
    defaultUnit: '吨',
  },
  {
    sector: 'aluminum', name: 'Aluminum', cnName: '铝',
    cnCodes: ['7601-7616'],
    hsPrefixes: ['7601', '7602', '7603', '7604', '7605', '7606', '7607', '7608', '7609', '7610', '7611', '7612', '7613', '7614', '7615', '7616'],
    defaultUnit: '吨',
  },
  {
    sector: 'cement', name: 'Cement', cnName: '水泥',
    cnCodes: ['2523', '252310'],
    hsPrefixes: ['2523'],
    defaultUnit: '吨',
  },
  {
    sector: 'fertilizer', name: 'Fertilizers', cnName: '化肥',
    cnCodes: ['2808', '2814', '2834', '3102', '3105'],
    hsPrefixes: ['3102', '3103', '3104', '3105', '2808', '2814', '2834'],
    defaultUnit: '吨',
  },
  {
    sector: 'electricity', name: 'Electricity', cnName: '电力',
    cnCodes: ['2716'],
    hsPrefixes: ['2716'],
    defaultUnit: 'MWh',
  },
  {
    sector: 'hydrogen', name: 'Hydrogen', cnName: '氢',
    cnCodes: ['2804.10'],
    hsPrefixes: ['280410', '2804'],
    defaultUnit: '吨',
  },
];

// ============================================================
// 2. 排放因子基准 (tCO₂/吨产品，基于 EU JRC 及行业平均水平)
// ============================================================

export interface EmissionDefaults {
  directEmissions: number;    // Scope 1: 直接排放 (tCO₂/吨)
  indirectEmissions: number;  // Scope 2: 间接排放 (tCO₂/吨，基于电网平均)
  unit: string;
  description: string;
}

export interface ProductionMethod {
  name: string;
  cnName: string;
  directMultiplier: number;   // 相对基准的直接排放倍率
  indirectMultiplier: number; // 相对基准的间接排放倍率
  description: string;
}

export interface SectorDefaults {
  sector: CBAMSector;
  base: EmissionDefaults;
  methods: ProductionMethod[];
  euBenchmark: number;        // EU ETS 免费配额基准值 (tCO₂/吨)
}

export const SECTOR_DEFAULTS: Record<CBAMSector, SectorDefaults> = {
  steel: {
    sector: 'steel',
    base: {
      directEmissions: 1.85,
      indirectEmissions: 0.15,
      unit: '吨',
      description: '粗钢 (BF-BOF 高炉-转炉路线)',
    },
    methods: [
      {
        name: 'BF-BOF', cnName: '高炉-转炉 (主流)',
        directMultiplier: 1.0, indirectMultiplier: 1.0,
        description: '铁矿石→高炉炼铁→转炉炼钢，中国约90%产能使用此路线，碳排放最高',
      },
      {
        name: 'EAF (Scrap)', cnName: '电弧炉-废钢',
        directMultiplier: 0.25, indirectMultiplier: 2.5,
        description: '废钢→电弧炉，碳排放约为BF-BOF的25%，但电力消耗高',
      },
      {
        name: 'EAF (DRI)', cnName: '电弧炉-直接还原铁',
        directMultiplier: 0.55, indirectMultiplier: 1.8,
        description: '直接还原铁(DRI)+电弧炉，使用天然气还原，碳排放介于BF和废钢之间',
      },
      {
        name: 'H2-DRI', cnName: '氢基直接还原 (绿色钢铁)',
        directMultiplier: 0.05, indirectMultiplier: 3.0,
        description: '绿氢直接还原铁+电弧炉，近零碳排放，但需大量绿电',
      },
    ],
    euBenchmark: 1.328,
  },

  aluminum: {
    sector: 'aluminum',
    base: {
      directEmissions: 12.5,
      indirectEmissions: 3.2,
      unit: '吨',
      description: '电解铝 (原铝，含阳极效应PFC排放)',
    },
    methods: [
      {
        name: 'Primary (Coal)', cnName: '煤电电解铝 (中国主流)',
        directMultiplier: 1.0, indirectMultiplier: 1.0,
        description: '煤电为主的电解铝，中国约65%产能，碳排放极高',
      },
      {
        name: 'Primary (Hydro)', cnName: '水电电解铝',
        directMultiplier: 1.0, indirectMultiplier: 0.05,
        description: '水电为主的电解铝，间接排放极低，云南/四川较多',
      },
      {
        name: 'Secondary (Recycled)', cnName: '再生铝 (回收)',
        directMultiplier: 0.04, indirectMultiplier: 0.02,
        description: '废铝重熔，碳排放仅为原铝的5%，但受废铝供应限制',
      },
    ],
    euBenchmark: 1.464,
  },

  cement: {
    sector: 'cement',
    base: {
      directEmissions: 0.62,
      indirectEmissions: 0.08,
      unit: '吨',
      description: '硅酸盐水泥 (熟料+粉磨)',
    },
    methods: [
      {
        name: 'Dry Kiln (Standard)', cnName: '新型干法 (主流)',
        directMultiplier: 1.0, indirectMultiplier: 1.0,
        description: '新型干法水泥窑，中国约95%产能，煅烧石灰石释放大量CO₂',
      },
      {
        name: 'Dry Kiln (AF)', cnName: '替代燃料+混合材',
        directMultiplier: 0.75, indirectMultiplier: 0.85,
        description: '使用替代燃料(生物质/废轮胎)+高混合材比例(矿渣/粉煤灰)，可降低25%碳排放',
      },
      {
        name: 'CCS-Equipped', cnName: '碳捕集(CCS)水泥',
        directMultiplier: 0.3, indirectMultiplier: 1.2,
        description: '加装碳捕集与封存装置，可捕获60-70%工艺排放，但增加能耗',
      },
    ],
    euBenchmark: 0.693,
  },

  fertilizer: {
    sector: 'fertilizer',
    base: {
      directEmissions: 1.95,
      indirectEmissions: 0.25,
      unit: '吨',
      description: '合成氨 (天然气蒸汽重整 SMR)',
    },
    methods: [
      {
        name: 'SMR (Gas)', cnName: '天然气制氨 (主流)',
        directMultiplier: 1.0, indirectMultiplier: 1.0,
        description: '天然气蒸汽重整制氨，中国约75%产能，吨氨排放约1.9-2.2 tCO₂',
      },
      {
        name: 'Coal Gasification', cnName: '煤气化制氨',
        directMultiplier: 2.0, indirectMultiplier: 0.85,
        description: '煤气化制氨，中国约23%产能，碳排放约为天然气路线的2倍',
      },
      {
        name: 'Green Ammonia', cnName: '绿氨 (电解水制氢)',
        directMultiplier: 0.05, indirectMultiplier: 6.0,
        description: '可再生能源电解水制氢+合成氨，近零直接排放，但需大量绿电',
      },
    ],
    euBenchmark: 1.619,
  },

  electricity: {
    sector: 'electricity',
    base: {
      directEmissions: 0.58,
      indirectEmissions: 0,
      unit: 'MWh',
      description: '电网平均排放因子 (中国2024年全国电网)',
    },
    methods: [
      {
        name: 'National Grid', cnName: '全国电网平均 (2024)',
        directMultiplier: 1.0, indirectMultiplier: 0,
        description: '中国全国电网平均排放因子 0.58 tCO₂/MWh (生态环境部2024年数据)',
      },
      {
        name: 'Regional Grid - North', cnName: '华北电网',
        directMultiplier: 1.25, indirectMultiplier: 0,
        description: '华北区域电网，煤电占比较高，排放因子约0.73 tCO₂/MWh',
      },
      {
        name: 'Regional Grid - South', cnName: '南方电网',
        directMultiplier: 0.75, indirectMultiplier: 0,
        description: '南方区域电网，水电占比较高，排放因子约0.44 tCO₂/MWh',
      },
      {
        name: 'Green Power (PPA)', cnName: '绿电直购 (PPA)',
        directMultiplier: 0.03, indirectMultiplier: 0,
        description: '通过绿色电力购买协议(PPA)获取风电/光伏，排放因子接近零',
      },
    ],
    euBenchmark: 0,
  },

  hydrogen: {
    sector: 'hydrogen',
    base: {
      directEmissions: 10.5,
      indirectEmissions: 0.5,
      unit: '吨',
      description: '灰氢 (天然气SMR，无CCS)',
    },
    methods: [
      {
        name: 'SMR (Grey)', cnName: '灰氢 (天然气重整)',
        directMultiplier: 1.0, indirectMultiplier: 1.0,
        description: '天然气蒸汽重整制氢，主流工艺，吨氢排放约9-12 tCO₂',
      },
      {
        name: 'Coal Gasification (Brown)', cnName: '褐氢 (煤气化)',
        directMultiplier: 1.9, indirectMultiplier: 0.8,
        description: '煤气化制氢，碳排放约为天然气路线的1.9倍',
      },
      {
        name: 'Blue Hydrogen', cnName: '蓝氢 (SMR + CCS)',
        directMultiplier: 0.3, indirectMultiplier: 1.2,
        description: '天然气重整+碳捕集封存，可捕获60-90%排放',
      },
      {
        name: 'Green Hydrogen', cnName: '绿氢 (电解水)',
        directMultiplier: 0, indirectMultiplier: 8.0,
        description: '可再生能源电解水制氢，零直接排放，间接排放取决于电力来源',
      },
    ],
    euBenchmark: 0,
  },
};

// ============================================================
// 3. 碳价格数据
// ============================================================

export interface CarbonPricing {
  euEtsPrice: number;         // EU ETS 碳配额价格 (€/tCO₂)
  chinaEtsPrice: number;      // 中国全国碳市场碳价 (€/tCO₂，已换算)
  exchangeRate: number;       // EUR/CNY
  effectiveCarbonPrice: number; // 有效碳价差 = EU ETS - 中国碳价
  updatedAt: string;
}

// 2026年6月市场参考数据
export function getCarbonPricing(): CarbonPricing {
  return {
    euEtsPrice: 78.5,           // EU ETS 2026年6月约 €78.5/tCO₂
    chinaEtsPrice: 8.2,         // 中国碳市场约 ¥62/tCO₂ ≈ €8.2
    exchangeRate: 7.56,         // EUR/CNY ≈ 7.56
    effectiveCarbonPrice: 70.3,  // €78.5 - €8.2 = €70.3/tCO₂
    updatedAt: '2026-06-02',
  };
}

// ============================================================
// 4. HS编码 → CBAM行业自动识别
// ============================================================

export function detectCBAMSector(hsCode: string): SectorInfo | null {
  const normalized = hsCode.replace(/[^0-9]/g, '');
  for (const sector of CBAM_SECTORS) {
    for (const prefix of sector.hsPrefixes) {
      if (normalized.startsWith(prefix)) return sector;
    }
  }
  // 尝试2位编码匹配
  const prefix2 = normalized.slice(0, 2);
  for (const sector of CBAM_SECTORS) {
    for (const prefix of sector.hsPrefixes) {
      if (prefix.startsWith(prefix2)) return sector;
    }
  }
  return null;
}

// ============================================================
// 5. 核心计算接口
// ============================================================

export interface CBAMInput {
  hsCode: string;
  productDesc?: string;
  sector?: CBAMSector;
  productionMethod?: string;
  quantity: number;            // 产品数量
  unit?: string;               // 吨 / MWh
  directEmissionsOverride?: number;  // 用户自定义直接排放 (tCO₂/单位)
  indirectEmissionsOverride?: number;
}

export interface EmissionBreakdown {
  directEmissions: number;
  indirectEmissions: number;
  totalEmbeddedEmissions: number;  // 单位产品隐含排放 (tCO₂/单位)
  unit: string;
}

export interface CostBreakdown {
  totalEmissions: number;      // 总排放量 (tCO₂)
  euCarbonPrice: number;
  chinaCarbonPrice: number;
  effectivePrice: number;
  grossCBAMCost: number;       // 毛碳成本 (按EU碳价)
  chinaCarbonCostPaid: number; // 已在中国碳市场支付的碳成本
  netCBAMCost: number;         // 净CBAM应缴费用
  costPerUnit: number;         // 单位产品CBAM成本
}

export interface CBAMReportDeadline {
  quarter: string;
  label: string;
  deadline: string;
  daysRemaining: number;
}

export interface CBAMResult {
  hsCode: string;
  productDesc: string;
  sector: SectorInfo;
  productionMethod: ProductionMethod;
  quantity: number;
  unit: string;
  emissions: EmissionBreakdown;
  costs: CostBreakdown;
  pricing: CarbonPricing;
  euBenchmark: number | null;
  exceedsBenchmark: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  riskFactors: string[];
  reportDeadline: CBAMReportDeadline;
  methodology: string;
}

// ============================================================
// 6. 计算函数
// ============================================================

export function calculateCBAMCost(input: CBAMInput): CBAMResult {
  // Step 1: 确定CBAM行业
  const sectorInfo = input.sector
    ? CBAM_SECTORS.find(s => s.sector === input.sector)!
    : detectCBAMSector(input.hsCode);

  if (!sectorInfo) {
    throw new Error(`HS编码 ${input.hsCode} 不属于CBAM覆盖的六大行业。CBAM目前覆盖：钢铁(72-73章)、铝(76章)、水泥(2523)、化肥(31章)、电力(2716)、氢(2804)。`);
  }

  const defaults = SECTOR_DEFAULTS[sectorInfo.sector];

  // Step 2: 确定生产工艺
  const method = input.productionMethod
    ? defaults.methods.find(m => m.name === input.productionMethod)!
    : defaults.methods[0];

  // Step 3: 计算隐含排放量
  const directEmissions = input.directEmissionsOverride
    ?? (defaults.base.directEmissions * method.directMultiplier);

  const indirectEmissions = input.indirectEmissionsOverride
    ?? (defaults.base.indirectEmissions * method.indirectMultiplier);

  const totalEmbeddedEmissions = directEmissions + indirectEmissions;

  const emissionResult: EmissionBreakdown = {
    directEmissions: Math.round(directEmissions * 1000) / 1000,
    indirectEmissions: Math.round(indirectEmissions * 1000) / 1000,
    totalEmbeddedEmissions: Math.round(totalEmbeddedEmissions * 1000) / 1000,
    unit: defaults.base.unit,
  };

  // Step 4: 获取碳价
  const pricing = getCarbonPricing();
  const unit = input.unit || defaults.base.unit;

  // Step 5: 计算碳成本
  const totalEmissions = totalEmbeddedEmissions * input.quantity;
  const grossCBAMCost = totalEmissions * pricing.euEtsPrice;
  const chinaCarbonCostPaid = totalEmissions * pricing.chinaEtsPrice;
  const netCBAMCost = totalEmissions * pricing.effectiveCarbonPrice;

  const costResult: CostBreakdown = {
    totalEmissions: Math.round(totalEmissions * 100) / 100,
    euCarbonPrice: pricing.euEtsPrice,
    chinaCarbonPrice: pricing.chinaEtsPrice,
    effectivePrice: pricing.effectiveCarbonPrice,
    grossCBAMCost: Math.round(grossCBAMCost * 100) / 100,
    chinaCarbonCostPaid: Math.round(chinaCarbonCostPaid * 100) / 100,
    netCBAMCost: Math.round(netCBAMCost * 100) / 100,
    costPerUnit: Math.round(netCBAMCost / input.quantity * 100) / 100,
  };

  // Step 6: 风险评估
  const riskFactors: string[] = [];
  let riskScore = 0;

  // 与EU基准对比
  const exceedsBenchmark = defaults.euBenchmark > 0 && totalEmbeddedEmissions > defaults.euBenchmark;
  if (exceedsBenchmark) {
    riskFactors.push(`单位排放(${totalEmbeddedEmissions.toFixed(2)} tCO₂/${unit})超过EU免费配额基准(${defaults.euBenchmark} tCO₂/${unit})`);
    riskScore += 3;
  }

  // 绝对排放水平
  if (totalEmbeddedEmissions > 5) {
    riskFactors.push(`高碳排放产品(${totalEmbeddedEmissions.toFixed(1)} tCO₂/${unit})，每单位CBAM成本€${(totalEmbeddedEmissions * pricing.effectiveCarbonPrice).toFixed(1)}`);
    riskScore += 2;
  } else if (totalEmbeddedEmissions > 1) {
    riskFactors.push(`中等碳排放产品，建议关注CBAM合规要求`);
    riskScore += 1;
  }

  // 碳价波动风险
  if (pricing.euEtsPrice > 80) {
    riskFactors.push(`EU ETS碳价处于高位(€${pricing.euEtsPrice}/tCO₂)，碳价波动风险较大`);
    riskScore += 1;
  }

  // 净CBAM成本占比评估
  if (costResult.netCBAMCost > 100000) {
    riskFactors.push(`CBAM年化成本较高(€${costResult.netCBAMCost.toFixed(0)})，建议评估供应链调整方案`);
    riskScore += 2;
  } else if (costResult.netCBAMCost > 10000) {
    riskFactors.push(`CBAM成本显著，建议建立碳数据管理体系`);
    riskScore += 1;
  }

  let riskLevel: 'low' | 'medium' | 'high';
  if (riskScore >= 5) riskLevel = 'high';
  else if (riskScore >= 2) riskLevel = 'medium';
  else riskLevel = 'low';

  // Step 7: 季度报告截止日期
  const now = new Date();
  const currentQuarter = Math.ceil((now.getMonth() + 1) / 3);
  const deadlineMonth = currentQuarter * 3 + 1; // 季度结束后一个月
  const deadlineDate = new Date(now.getFullYear(), deadlineMonth - 1, 1);
  if (deadlineDate <= now) {
    deadlineDate.setMonth(deadlineDate.getMonth() + 3);
  }
  const daysRemaining = Math.ceil((deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const quarterLabels: Record<number, string> = { 1: 'Q1 (1-3月)', 2: 'Q2 (4-6月)', 3: 'Q3 (7-9月)', 4: 'Q4 (10-12月)' };
  const reportDeadline: CBAMReportDeadline = {
    quarter: `2026 Q${currentQuarter}`,
    label: quarterLabels[currentQuarter] || `Q${currentQuarter}`,
    deadline: deadlineDate.toISOString().slice(0, 10),
    daysRemaining,
  };

  return {
    hsCode: input.hsCode,
    productDesc: input.productDesc || sectorInfo.cnName + '产品',
    sector: sectorInfo,
    productionMethod: method,
    quantity: input.quantity,
    unit,
    emissions: emissionResult,
    costs: costResult,
    pricing,
    euBenchmark: defaults.euBenchmark || null,
    exceedsBenchmark,
    riskLevel,
    riskFactors,
    reportDeadline,
    methodology: 'EU Regulation 2023/956 — CBAM过渡期方法学 (2025.12.31前)，基于EU JRC行业基准数据及中国生态环境部电网排放因子',
  };
}
