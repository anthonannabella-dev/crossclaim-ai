import prisma from '../config/database';
import { env } from '../config/env';
import {
  TRANSPORT_MODE_CODES, CURRENCY_CODES, COUNTRY_CODES, UNIT_CODES,
  toCustomsCode, resolvesToCode, isStrictCodeMode,
} from './customsCodes';

// ============================================================
// 报关单数据结构
// ============================================================

export interface DeclarationItem {
  lineNo?: number;          // 项号(优先)
  itemNo?: number;          // 兼容旧字段
  hsCode: string;
  description: string;
  model?: string;           // 商品规格型号(GModel, 海关必填)
  quantity: number;         // 成交数量
  unit: string;             // 成交计量单位
  legalUnit?: string;       // 法定第一计量单位
  legalQty?: number;        // 法定第一数量
  legalUnit2?: string;      // 法定第二计量单位
  legalQty2?: number;       // 法定第二数量
  unitPrice: number;
  totalPrice: number;
  currency: string;
  originCountry: string;
  destinationCountry?: string; // 最终目的国(地区)
  tradeTerms?: string;      // 成交方式(可在项级覆盖表头)
  tariffRate?: number | null;
  ftaRate?: number | null;
  ftaName?: string | null;
}

export type CustomsMode = 'normal' | '9610' | '9710' | '9810' | '1210' | '1239' | '1039';
export type DeliveryMethod = '邮政' | '快递' | '专线物流' | '其他';
export const ECOMMERCE_PLATFORM_CODES: Record<string, string> = {
  'Amazon': 'AMZ', '速卖通': 'AE', 'eBay': 'EBY', 'Wish': 'WSH',
  'Shopee': 'SP', 'Lazada': 'LZD', 'Temu': 'TM', 'TikTok Shop': 'TTS', 'Shein': 'SHN', '独立站/其他': 'OTHER',
};
export interface CustomsModeConfig {
  label: string;
  supervisionCode: string;
  taxMethod: string;
  description: string;
  requiredFields: string[];
  logisticsRequired: boolean;
  allowedTransportModes: string[];
}
export const CUSTOMS_MODE_INFO: Record<CustomsMode, CustomsModeConfig> = {
  normal: { label: '一般贸易', supervisionCode: '0110', taxMethod: '一般征税',
    description: '普通一般贸易进出口申报', requiredFields: ['transportMode', 'portOfEntry', 'tradeTerms', 'currency', 'importerExporter', 'contractNo', 'declarant'],
    logisticsRequired: true, allowedTransportModes: ['海运', '空运', '陆运', '铁路'], },
  '9610': { label: '跨境电商零售出口', supervisionCode: '9610', taxMethod: '汇总征税',
    description: '适合小包裹直邮，三单对碰', requiredFields: ['transportMode', 'portOfEntry', 'currency', 'logisticsNo', 'ecommercePlatform', 'orderNo', 'paymentNo', 'deliveryMethod'],
    logisticsRequired: true, allowedTransportModes: ['空运', '海运', '陆运'], },
  '9710': { label: '跨境电商B2B直接出口', supervisionCode: '9710', taxMethod: '一般征税',
    description: '企业对企业直接出口', requiredFields: ['transportMode', 'portOfEntry', 'tradeTerms', 'currency', 'contractNo', 'b2bOrderNo', 'b2bPlatform', 'b2bOrderAmount'],
    logisticsRequired: true, allowedTransportModes: ['海运', '空运', '陆运', '铁路'], },
  '9810': { label: '出口海外仓', supervisionCode: '9810', taxMethod: '一般征税',
    description: '先入仓再销售', requiredFields: ['transportMode', 'portOfEntry', 'tradeTerms', 'currency', 'warehouseAddress', 'warehouseCode', 'destinationCountry', 'inboundOrderNo'],
    logisticsRequired: true, allowedTransportModes: ['海运', '空运', '陆运', '铁路'], },
  '1210': { label: '保税电商出口', supervisionCode: '1210', taxMethod: '一般征税',
    description: '保税电商出口，适用跨境电商综合试验区', requiredFields: ['transportMode', 'portOfEntry', 'currency', 'orderNo', 'paymentNo', 'logisticsNo', 'ecommercePlatform'],
    logisticsRequired: true, allowedTransportModes: ['海运', '空运', '铁路', '陆运'], },
  '1239': { label: '保税电商出口A', supervisionCode: '1239', taxMethod: '一般征税',
    description: '保税电商出口（非试点城市适用）', requiredFields: ['transportMode', 'portOfEntry', 'currency', 'orderNo', 'paymentNo', 'logisticsNo', 'ecommercePlatform'],
    logisticsRequired: true, allowedTransportModes: ['海运', '空运', '铁路', '陆运'], },
  '1039': { label: '市场采购贸易', supervisionCode: '1039', taxMethod: '免征不退',
    description: '专业市场多品种拼箱出口', requiredFields: ['transportMode', 'portOfEntry', 'portOfDischarge', 'currency', 'tradeTerms', 'importerExporter'],
    logisticsRequired: true, allowedTransportModes: ['海运', '空运', '陆运', '铁路'], },
};

export interface DeclarationData {
  declarationNo?: string;
  declarant?: string;            // 申报单位
  importerExporter?: string;     // 兼容旧字段(单一主体)
  consignee?: string;            // 境内收发货人
  consignor?: string;            // 消费使用单位 / 生产销售单位
  transportMode: string;
  vesselFlight?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  portOfEntry: string;
  tradeTerms: string;
  // 运费 / 保费 / 杂费 (mark: 1=率 2=单价 3=总价)
  freightMark?: string; freightRate?: number; freightCurrency?: string;
  insuranceMark?: string; insuranceRate?: number; insuranceCurrency?: string;
  otherMark?: string; otherRate?: number; otherCurrency?: string;
  items: DeclarationItem[];
  documents: string[];
  totalValue: number;
  currency: string;
  customsMode?: CustomsMode; supervisionCode?: string; taxMethod?: string;
  declarantCode?: string; agentName?: string; agentCode?: string;
  contractNo?: string; licenseNo?: string; billOfLading?: string;
  containerNo?: string; packageType?: string; grossWeight?: number;
  netWeight?: number; purpose?: string; dutyMode?: string; taxPreference?: string;
  logisticsNo?: string; ecommercePlatform?: string; ecommercePlatformCode?: string;
  orderNo?: string; paymentNo?: string; deliveryMethod?: DeliveryMethod;
  receiverIdType?: string; receiverIdNumber?: string;
  b2bPlatform?: string; b2bOrderAmount?: number; b2bProductUrl?: string; b2bOrderNo?: string;
  warehouseAddress?: string; warehouseCode?: string; inboundOrderNo?: string;
  destinationCountry?: string; fnSku?: string; returnAddress?: string; estimatedSalesChannel?: string;
  bondedWarehouseId?: string; bondedWarehouseName?: string;
  consumerIdType?: string; consumerIdNumber?: string; consumerName?: string;
  consumerPhone?: string; tariffRateApplied?: number; taxReductionType?: string;
  totalTaxAmount?: number; singleItemLimit?: string; annualPurchaseAmount?: number;
  marketName?: string; marketCode?: string; supplierName?: string;
  supplierIdNo?: string; consolidatedDeclaration?: string; customhouseCode?: string;
  originPlace?: string; numberOfPackages?: number; totalGrossWeight?: number; destinationPort?: string;
  receiverName?: string; packageCount?: number; senderName?: string;
}

export interface ComplianceIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  category?: string;
  field?: string;
  message: string;
  suggestion?: string;
  legalBasis?: string;   // 法规依据(自动附加，可追溯到具体公告)
}

export interface PreCheckResult {
  passed: boolean;
  score: number;            // 0-100
  issues: ComplianceIssue[];
  checkedRules: number;
  recommendation: string;
}

export interface DeclarationExport {
  declaration: DeclarationData;
  preCheck: PreCheckResult;
  xmlContent: string;
  exportedAt: string;
}

// ============================================================
// 常见退单规则库
// ============================================================

// 零售/保税电商：共享「三单(订单/支付/物流)+电商平台」申报要求。
// 1210/1239(保税电商)与 9610 同口径，原先仅 9610 被校验，导致 1210/1239 缺三单也能通过预检。
function isRetailEcomMode(mode?: string): boolean {
  return mode === '9610' || mode === '1210' || mode === '1239';
}

const COMPLIANCE_RULES: { code: string; category: string; check: (data: DeclarationData) => ComplianceIssue | null }[] = [
  {
    code: 'HS001',
    category: 'classification',
    check: (data) => {
      const missingDesc = data.items.filter(i => !i.description || i.description.length < 2);
      const idx = data.items.findIndex(i => !i.description || i.description.length < 2);
      if (missingDesc.length > 0) {
        return {
          severity: 'error', code: 'HS001', category: 'classification',
          field: `items.${idx}.description`,
          message: `${missingDesc.length}项商品描述不完整`,
          suggestion: '商品描述应包含品名、材质、用途等关键信息，至少4个字符',
        };
      }
      return null;
    },
  },
  {
    code: 'HS002',
    category: 'classification',
    check: (data) => {
      // 中国进出口申报商品编号(CodeTS)为纯数字连写: 8位HS + 监管/附加码, 实际申报位数为 10 位(部分 13 位)。
      // 去掉分隔符后必须为 8/10/13 位纯数字; HS6(如 8471.30)不可用于申报, 应判不合格。
      const isValidDeclCode = (raw: string) => {
        const digits = (raw || '').replace(/[^0-9]/g, '');
        return /^(\d{8}|\d{10}|\d{13})$/.test(digits);
      };
      const invalidCodes = data.items.filter(i => !isValidDeclCode(i.hsCode));
      const idx2 = data.items.findIndex(i => !isValidDeclCode(i.hsCode));
      if (invalidCodes.length > 0) {
        return {
          severity: 'error', code: 'HS002', category: 'classification',
          field: `items.${idx2}.hsCode`,
          message: `${invalidCodes.length}项HS编码不符合申报位数: ${invalidCodes.map(i => i.hsCode.slice(0, 13)).join(', ')}`,
          suggestion: '申报商品编号须为 10 位(或 13 位)纯数字连写, 如 8517120000; HS6(如 8471.30)不可直接申报, 请补全监管码或通过AI归类确认',
        };
      }
      return null;
    },
  },
  {
    code: 'VAL001',
    category: 'valuation',
    check: (data) => {
      const lowValue = data.items.filter(i => i.unitPrice > 0 && i.unitPrice < 0.01);
      const idx3 = data.items.findIndex(i => i.unitPrice > 0 && i.unitPrice < 0.01);
      if (lowValue.length > 0) {
        return {
          severity: 'warning', code: 'VAL001', category: 'valuation',
          field: `items.${idx3}.unitPrice`,
          message: `${lowValue.length}项单价异常偏低`,
          suggestion: '请核实申报价格的真实性和完整性，过低价格可能触发海关审价',
        };
      }
      return null;
    },
  },
  {
    code: 'VAL002',
    category: 'valuation',
    check: (data) => {
      const calculatedTotal = data.items.reduce((s, i) => s + i.totalPrice, 0);
      if (Math.abs(calculatedTotal - data.totalValue) / Math.max(calculatedTotal, 1) > 0.05) {
        return {
          severity: 'error', code: 'VAL002', category: 'valuation',
          field: 'totalValue',
          message: `申报总金额(${data.totalValue.toFixed(2)})与明细合计(${calculatedTotal.toFixed(2)})不一致`,
          suggestion: '请核对总金额是否等于各项金额之和',
        };
      }
      return null;
    },
  },
  {
    code: 'WGT001',
    category: 'valuation',
    check: (data) => {
      const g = (data as any).grossWeight, n = (data as any).netWeight;
      if (g != null && n != null && Number(g) > 0 && Number(n) > 0 && Number(g) < Number(n)) {
        return {
          severity: 'error', code: 'WGT001', category: 'valuation',
          field: 'grossWeight',
          message: `毛重(${g}) 小于 净重(${n})，逻辑不成立`,
          suggestion: '毛重应大于等于净重；请核对毛重/净重申报值（含包装重量）',
        };
      }
      return null;
    },
  },
  {
    code: 'ORI001',
    category: 'origin',
    check: (data) => {
      const missingOrigin = data.items.filter(i => !i.originCountry || i.originCountry.length < 2);
      const idx4 = data.items.findIndex(i => !i.originCountry || i.originCountry.length < 2);
      if (missingOrigin.length > 0) {
        return {
          severity: 'error', code: 'ORI001', category: 'origin',
          field: `items.${idx4}.originCountry`,
          message: `${missingOrigin.length}项缺少原产国信息`,
          suggestion: '每项商品必须注明原产国（两位国家代码），如CN、JP、KR',
        };
      }
      return null;
    },
  },
  {
    code: 'ORI002',
    category: 'origin',
    check: (data) => {
      const hasFtaRate = data.items.some(i => i.ftaRate != null);
      const missingDocs = !data.documents?.some(d => /原产地|origin|certificate|coo|form/i.test(d));
      if (hasFtaRate && missingDocs) {
        return {
          severity: 'warning', code: 'ORI002', category: 'origin',
          field: 'documents',
          message: '申报适用FTA优惠税率但未随附原产地证书',
          suggestion: '享受协定税率必须提供有效的原产地证书（正本），否则只能按MFN税率申报',
        };
      }
      return null;
    },
  },
  {
    code: 'DOC001',
    category: 'document',
    check: (data) => {
      if (!data.documents || data.documents.length < 2) {
        return {
          severity: 'error', code: 'DOC001', category: 'document',
          field: 'documents',
          message: '随附单证不完整，至少需要商业发票和装箱单',
          suggestion: '基本单证要求: 商业发票、装箱单、提单/运单，涉及FTA还需原产地证书',
        };
      }
      return null;
    },
  },
  {
    code: 'DOC002',
    category: 'document',
    check: (data) => {
      const hasInvoice = data.documents?.some(d => /发票|invoice/i.test(d));
      const hasPacking = data.documents?.some(d => /装箱|packing/i.test(d));
      if (!hasInvoice) {
        return { severity: 'error', code: 'DOC002', category: 'document',
          field: 'documents',
          message: '缺少商业发票', suggestion: '必须随附商业发票（Commercial Invoice）' };
      }
      if (!hasPacking) {
        return { severity: 'warning', code: 'DOC002', category: 'document',
          field: 'documents',
          message: '缺少装箱单', suggestion: '建议随附装箱单（Packing List）' };
      }
      return null;
    },
  },
  {
    code: 'TRA001',
    category: 'transport',
    check: (data) => {
      if (!data.portOfEntry || data.portOfEntry.length < 2) {
        return {
          severity: 'error', code: 'TRA001', category: 'transport',
          field: 'portOfEntry',
          message: '缺少入境口岸信息',
          suggestion: '请填写具体的入境口岸名称（如：上海外高桥、宁波北仑、青岛前湾）',
        };
      }
      return null;
    },
  },
  {
    code: 'TRA002',
    category: 'transport',
    check: (data) => {
      if (!data.transportMode) {
        return {
          severity: 'error', code: 'TRA002', category: 'transport',
          field: 'transportMode',
          message: '缺少运输方式',
          suggestion: '请选择运输方式: 海运、空运、陆运、铁路',
        };
      }
      return null;
    },
  },
  {
    code: 'CUR001',
    category: 'currency',
    check: (data) => {
      const currencies = new Set(data.items.map(i => i.currency).filter(Boolean));
      const curArr = [...currencies];
      const idx5 = data.items.findIndex(i => !!i.currency && i.currency !== curArr[0]);
      if (currencies.size > 1) {
        return {
          severity: 'warning', code: 'CUR001', category: 'currency',
          field: `items.${idx5 >= 0 ? idx5 : 0}.currency`,
          message: `同一报关单包含${currencies.size}种币种: ${[...currencies].join(', ')}`,
          suggestion: '建议统一使用一种结算币种，多币种可能增加审核时间',
        };
      }
      return null;
    },
  },
  {
    code: 'RCP001',
    category: 'rcep',
    check: (data) => {
      const hasRCEPItem = data.items.some(i => i.ftaName === 'RCEP');
      const idx6 = data.items.findIndex(i => i.ftaName === 'RCEP');
      if (hasRCEPItem) {
        return {
          severity: 'info', code: 'RCP001', category: 'rcep',
          field: `items.${idx6}.ftaName`,
          message: '申报适用RCEP协定税率，请确认已满足原产地规则要求',
          suggestion: '建议使用「原产地合规自动化」工具验证RCEP原产地资格，并通过AEO自主声明或Form RCEP证书享受优惠',
        };
      }
      return null;
    },
  },
  // ===== 表头主体 / 规格型号 / 运保杂费(67号公告必备项) =====
  {
    code: 'HDR001',
    category: 'header',
    check: (data) => {
      const consignee = data.consignee || data.importerExporter;
      if (!consignee || consignee.length < 2) {
        return { severity: 'error', code: 'HDR001', category: 'header',
          field: 'consignee',
          message: '缺少境内收发货人',
          suggestion: '请填写境内收发货人（出口为发货人/进口为收货人）名称' };
      }
      return null;
    },
  },
  {
    code: 'HDR002',
    category: 'header',
    check: (data) => {
      if (!data.consignor || data.consignor.length < 2) {
        return { severity: 'warning', code: 'HDR002', category: 'header',
          field: 'consignor',
          message: '缺少消费使用单位/生产销售单位',
          suggestion: '出口填生产销售单位、进口填消费使用单位；与境内收发货人可相同但需各自申报' };
      }
      return null;
    },
  },
  {
    code: 'SPEC001',
    category: 'classification',
    check: (data) => {
      const missing = data.items.filter(i => !i.model || i.model.trim().length < 1);
      const idx = data.items.findIndex(i => !i.model || i.model.trim().length < 1);
      if (missing.length > 0) {
        return { severity: 'error', code: 'SPEC001', category: 'classification',
          field: `items.${idx}.model`,
          message: `${missing.length}项缺少商品规格型号`,
          suggestion: '规格型号为海关必填项，应按申报规范填写品牌/型号/材质/成分等要素，缺失将被退单' };
      }
      return null;
    },
  },
  {
    code: 'FEE001',
    category: 'valuation',
    check: (data) => {
      const t = (data.tradeTerms || '').toUpperCase();
      const needFreight = t.includes('CIF') || t.includes('CFR') || t.includes('C&F') || t.includes('CNF');
      if (needFreight && data.freightRate == null) {
        return { severity: 'warning', code: 'FEE001', category: 'valuation',
          field: 'freightRate',
          message: `成交方式为${data.tradeTerms}，但未申报运费`,
          suggestion: 'CIF/CFR 成交价已含运费，须在表头申报运费（标记+金额+币制）以正确计算完税价格' };
      }
      return null;
    },
  },
  // ===== 海关代码可解析性守卫(国别/币制/计量单位) =====
  {
    code: 'CODE001',
    category: 'code_table',
    check: (data) => {
      const bad: string[] = [];
      if (data.destinationCountry && !resolvesToCode(COUNTRY_CODES, data.destinationCountry)) bad.push(`运抵国"${data.destinationCountry}"`);
      data.items.forEach((it, i) => {
        if (it.originCountry && !resolvesToCode(COUNTRY_CODES, it.originCountry)) bad.push(`第${i + 1}项原产国"${it.originCountry}"`);
        if (it.currency && !resolvesToCode(CURRENCY_CODES, it.currency)) bad.push(`第${i + 1}项币制"${it.currency}"`);
        if (it.unit && !resolvesToCode(UNIT_CODES, it.unit)) bad.push(`第${i + 1}项计量单位"${it.unit}"`);
        if (it.legalUnit && !resolvesToCode(UNIT_CODES, it.legalUnit)) bad.push(`第${i + 1}项法定单位"${it.legalUnit}"`);
      });
      if (bad.length > 0) {
        const strict = isStrictCodeMode();
        return {
          severity: strict ? 'error' : 'warning', code: 'CODE001', category: 'code_table',
          message: `${bad.length}处未能映射为海关代码: ${bad.slice(0, 5).join('、')}${bad.length > 5 ? '…' : ''}`,
          suggestion: strict
            ? '严格模式已开启：这些字段必须填海关代码方可申报。请按官方代码表填写，或配置 CUSTOMS_CODE_TABLE_PATH 加载全表'
            : '系统仅内置常用代码子集，导出报文这些字段将保留原文。请按官方代码表填海关代码，或配置 CUSTOMS_CODE_TABLE_PATH 加载全表',
        };
      }
      return null;
    },
  },

  {
    code: 'ECM001',
    category: 'ecommerce',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.orderNo) {
        return { severity: 'error', code: 'ECM001', category: 'ecommerce',
          field: 'orderNo',
          message: '跨境电商(9610/1210/1239)缺少订单号',
          suggestion: '请填写电商平台的订单号' };
      }
      return null;
    },
  },
  {
    code: 'ECM002',
    category: 'ecommerce',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.paymentNo) {
        return { severity: 'error', code: 'ECM002', category: 'ecommerce',
          field: 'paymentNo',
          message: '跨境电商(9610/1210/1239)缺少支付单号',
          suggestion: '请填写支付机构的支付单号' };
      }
      return null;
    },
  },
  {
    code: 'ECM003',
    category: 'ecommerce',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.logisticsNo) {
        return { severity: 'error', code: 'ECM003', category: 'ecommerce',
          field: 'logisticsNo',
          message: '跨境电商(9610/1210/1239)缺少物流单号',
          suggestion: '请填写物流企业的运单号' };
      }
      return null;
    },
  },
  {
    code: 'ECM004',
    category: 'triple_check',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.orderNo || !data.paymentNo || !data.logisticsNo) return null;
      // 三单对碰校验（海关总署2018年第194号公告）：
      // 电商平台发送订单（含订单号）→ 支付企业发送支付单（含订单号+支付单号）
      // → 物流企业发送运单（含订单号+物流单号）→ 海关比对三个单的订单号一致
      // 校验：支付单号和物流单号中应包含关联的订单号信息
      // 实际海关三单对碰是系统级校验，这里做字段逻辑验证
      const orderPrefix = data.orderNo.replace(/\d+$/, ''); // 取订单号前缀
      const payPrefix = data.paymentNo.replace(/\d+$/, '');
      const logPrefix = data.logisticsNo.replace(/\d+$/, '');
      // 三个号码不能完全一样（防复制粘贴）
      if (data.orderNo === data.paymentNo && data.orderNo === data.logisticsNo) {
        return { severity: 'error', code: 'ECM004', category: 'triple_check',
          field: 'orderNo',
          message: '三单对碰异常：订单号、支付单号、物流单号不能完全相同',
          suggestion: '订单号来自电商平台，支付单号来自支付机构，物流单号来自物流企业，三者应不同但指向同一笔交易' };
      }
      return null;
    },
  },
  {
    code: 'ECM005',
    category: 'ecommerce',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.ecommercePlatform) {
        return { severity: 'error', code: 'ECM005', category: 'ecommerce',
          field: 'ecommercePlatform',
          message: '跨境电商(9610/1210/1239)缺少电商平台名称',
          suggestion: '如 Amazon、eBay、Shopify、Temu，海关三单对碰需要电商平台信息' };
      }
      return null;
    },
  },
  {
    code: 'ECM006',
    category: 'ecommerce',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.ecommercePlatformCode) {
        return { severity: 'error', code: 'ECM006', category: 'ecommerce',
          field: 'ecommercePlatformCode',
          message: '跨境电商(9610/1210/1239)缺少电商平台代码',
          suggestion: '海关三单对碰需要eCommercePlatformCode（电商平台代码）校验' };
      }
      return null;
    },
  },
  {
    code: 'ECM007',
    category: 'ecommerce',
    check: (data) => {
      if (!isRetailEcomMode(data.customsMode)) return null;
      if (!data.deliveryMethod) {
        return { severity: 'warning', code: 'ECM007', category: 'ecommerce',
          field: 'deliveryMethod',
          message: '跨境电商(9610/1210/1239)建议填写物流方式',
          suggestion: '如 邮政、快递、海运、空运' };
      }
      return null;
    },
  },
  // ===== 9710 B2B 字段校验 =====
  {
    code: 'ECM011',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9710') return null;
      if (!data.b2bOrderNo) {
        return { severity: 'error', code: 'ECM011', category: 'ecommerce',
          field: 'b2bOrderNo',
          message: '9710模式缺少跨境电商B2B出口单号',
          suggestion: '请填写B2B平台上的订单号，海关要求B2B出口单号与平台订单一致' };
      }
      return null;
    },
  },
  {
    code: 'ECM012',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9710') return null;
      if (!data.b2bPlatform) {
        return { severity: 'error', code: 'ECM012', category: 'ecommerce',
          field: 'b2bPlatform',
          message: '9710模式缺少电商平台名称',
          suggestion: '如 Alibaba.com、GlobalSources、Made-in-China，海关B2B出口要求申报电商平台信息' };
      }
      return null;
    },
  },
  {
    code: 'ECM013',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9710') return null;
      if (!data.contractNo) {
        return { severity: 'warning', code: 'ECM013', category: 'ecommerce',
          field: 'contractNo',
          message: '9710模式建议填写合同协议号',
          suggestion: 'B2B出口建议提供合同/协议号，便于海关审核贸易真实性' };
      }
      return null;
    },
  },
  {
    code: 'ECM014',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9710') return null;
      if (!data.logisticsNo) {
        return { severity: 'warning', code: 'ECM014', category: 'ecommerce',
          field: 'logisticsNo',
          message: '9710模式建议填写物流单号',
          suggestion: 'B2B出口建议填写物流单号便于跟踪' };
      }
      return null;
    },
  },
  // ===== 9810 海外仓字段校验 =====
  {
    code: 'ECM021',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9810') return null;
      if (!data.warehouseAddress) {
        return { severity: 'error', code: 'ECM021', category: 'ecommerce',
          field: 'warehouseAddress',
          message: '9810模式缺少海外仓地址',
          suggestion: '请填写海外仓的完整地址（国家+城市+具体地址），海关出口海外仓必须申报海外仓地址' };
      }
      return null;
    },
  },
  {
    code: 'ECM022',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9810') return null;
      if (!data.warehouseCode) {
        return { severity: 'error', code: 'ECM022', category: 'ecommerce',
          field: 'warehouseCode',
          message: '9810模式缺少海外仓代码',
          suggestion: '海关出口海外仓要求海外仓企业代码，如 USLAX1、DEFRA1' };
      }
      return null;
    },
  },
  {
    code: 'ECM023',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9810') return null;
      if (!data.destinationCountry) {
        return { severity: 'error', code: 'ECM023', category: 'ecommerce',
          field: 'destinationCountry',
          message: '9810模式缺少目的国',
          suggestion: '请填写海外仓所在国代码，如 US（美国）、DE（德国）、JP（日本）' };
      }
      return null;
    },
  },
  {
    code: 'ECM024',
    category: 'ecommerce',
    check: (data) => {
      if (data.customsMode !== '9810') return null;
      if (!data.inboundOrderNo) {
        return { severity: 'warning', code: 'ECM024', category: 'ecommerce',
          field: 'inboundOrderNo',
          message: '9810模式建议填写入仓单号',
          suggestion: '海外仓入仓单号如 FBA Inbound ID，便于后续跟踪' };
      }
      return null;
    },
  },
];

// ============================================================
// 合规预检
// ============================================================

// 法规依据自动映射（确定性、可追溯；公告号经核实，非 LLM 生成）
const GENERAL_LEGAL_BASIS = '《中华人民共和国海关进出口货物报关单填制规范》(海关总署2018年第60号公告)';
function legalBasisFor(code: string): string {
  if (/^ECM00[1-7]$/.test(code)) return '海关总署2018年第194号公告《关于跨境电子商务零售进出口商品有关监管事宜的公告》(三单比对/电商平台·支付·物流数据传输)';
  if (/^ECM01[1-4]$/.test(code)) return '海关总署2020年第75号公告《关于开展跨境电子商务企业对企业出口监管试点的公告》(9710 B2B直接出口)';
  if (/^ECM02[1-4]$/.test(code)) return '海关总署2020年第75号公告《关于开展跨境电子商务企业对企业出口监管试点的公告》(9810 出口海外仓)';
  return GENERAL_LEGAL_BASIS;
}

export function runPreCheck(data: DeclarationData, items?: DeclarationItem[]): PreCheckResult {
  // 兼容流水线调用 runPreCheck(declarationData, items): 若单独传入 items 则并入 data
  if (items && items.length > 0) {
    data = { ...data, items };
  }
  const issues: ComplianceIssue[] = [];

  for (const rule of COMPLIANCE_RULES) {
    const issue = rule.check(data);
    if (issue) {
      if (!issue.legalBasis) issue.legalBasis = legalBasisFor(issue.code);
      issues.push(issue);
    }
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;

  // Scoring: each error -20, each warning -5, each info -2
  const score = Math.max(0, 100 - errors * 20 - warnings * 5 - issues.filter(i => i.severity === 'info').length * 2);
  const passed = errors === 0 && score >= 60;

  let recommendation: string;
  if (passed && score >= 90) {
    recommendation = '合规预检通过，可导出XML进行正式申报';
  } else if (passed) {
    recommendation = `基本合规，${warnings}条警告建议在申报前修正`;
  } else {
    recommendation = `合规预检未通过，${errors}条错误必须修正后才能申报`;
  }

  return {
    passed,
    score,
    issues,
    checkedRules: COMPLIANCE_RULES.length,
    recommendation,
  };
}

// ============================================================
// AI 智能预检补充分析
// ============================================================

export async function aiPreCheckSupplement(data: DeclarationData, _aiResult?: any): Promise<string | null> {
  try {
    const config = env();
    if (!config.DEEPSEEK_API_KEY) {
      return null;
    }

    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: config.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com/v1',
    });

    const itemsSummary = data.items.map(i =>
      `HS${i.hsCode} ${i.description} ${i.quantity}${i.unit} @${i.unitPrice}${i.currency} 原产国:${i.originCountry}`
    ).join('\n');

    const prompt = `你是一位资深海关合规专家。请对以下报关单进行快速风险评估:

运输方式: ${data.transportMode}
入境口岸: ${data.portOfEntry}
贸易条款: ${data.tradeTerms}
申报总金额: ${data.totalValue} ${data.currency}

申报明细:
${itemsSummary}

请分析:
1. HS编码归类是否合理
2. 申报价格是否存在异常
3. 贸易条款与运输方式的匹配性
4. 是否有其他潜在合规风险
5. 总体建议

请用简洁中文回答，200字以内。`;

    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0].message.content || null;
  } catch {
    return null;
  }
}

// ============================================================
// 中国海关XML生成 (基于海关总署2018版报文规范)
// ============================================================

// ── 海关代码表(运输方式/币制/国别/计量单位)已抽到 customsCodes 模块 ──
// 全量替换见 customsCodes.ts 顶部说明。下面保留旧别名以兼容本文件内已有调用。
const TRAF_MODE_MAP = TRANSPORT_MODE_CODES;
const CURRENCY_MAP = CURRENCY_CODES;
const COUNTRY_MAP = COUNTRY_CODES;
const toCode = toCustomsCode;

// HS 编码归一化为纯数字连写(去掉小数点/空格)
function normalizeHsCode(raw?: string): string {
  return (raw || '').replace(/[^0-9]/g, '');
}

// 成交方式映射(TransMode): 详见海关成交方式代码表
function mapTransMode(terms?: string): string {
  const t = (terms || '').toUpperCase();
  if (t.includes('CIF')) return '1';
  if (t.includes('C&F') || t.includes('CFR') || t.includes('CNF')) return '2';
  if (t.includes('FOB')) return '3';
  if (t.includes('C&I')) return '4';
  if (t.includes('EXW')) return '7';
  return '';
}

/**
 * 生成符合「海关总署2018年第67号公告 - 进出口货物报关单申报电子报文格式」
 * 字段命名规范的报关单 XML(DecHead 表头 + DecLists/DecList 表体)。
 * 多数海关编号类字段(SeqNo/PreEntryId/EntryId)首次导入传空值,由系统生成。
 * 注意:不同单一窗口客户端的最外层根节点/信封可能不同(如 <DecMessage> / 客户端私有包裹),
 *      若客户端要求其它根名,只需改下面最外层标签即可,内部 DecHead/DecLists 字段通用。
 */
// ============================================================
// 跨境电商附加段
//   依据: 海关总署2018年第194号公告(跨境电商零售 / 三单比对)
//         海关总署2020年第75号公告(9710 B2B / 9810 海外仓)
// ------------------------------------------------------------
// 只在跨境电商监管方式下输出 <EcommerceInfo>;一般贸易保持 67 号公告报文纯净。
//   9610 / 1210 / 1239 零售·保税电商 → 三单(订单/支付/物流) + 平台 + 配送方式
//   9710               B2B 直接出口   → B2B 订单号/金额 + 平台
//   9810               出口海外仓     → 海外仓代码/地址 + 入仓单号
// ============================================================

/** 零售/保税电商(共享「三单+平台」口径) */
const RETAIL_ECOM_MODES: readonly string[] = ['9610', '1210', '1239'];
/** B2B 直接出口 */
const B2B_ECOM_MODES: readonly string[] = ['9710'];
/** 出口海外仓 */
const WAREHOUSE_ECOM_MODES: readonly string[] = ['9810'];

/** 是否为跨境电商监管方式(广义,含 9710/9810)。mode 与 supervisionCode 任一命中即可。 */
export function isEcommerceMode(data: DeclarationData): boolean {
  const mode = String(data.customsMode || '');
  const sup = String(data.supervisionCode || '');
  return [...RETAIL_ECOM_MODES, ...B2B_ECOM_MODES, ...WAREHOUSE_ECOM_MODES]
    .some((c) => mode === c || sup === c);
}

/**
 * 生成 <EcommerceInfo> 附加段。非跨境电商模式返回空串(不污染一般贸易报文)。
 * 所有值经 escapeXml 转义,避免平台名/单号里的 & < > " 破坏报文具构。
 */
export function buildEcommerceXml(data: DeclarationData): string {
  if (!isEcommerceMode(data)) return '';

  const esc = (v: any) => escapeXml(String(v == null ? '' : v));
  const mode = String(data.customsMode || data.supervisionCode || '');
  const rows: string[] = [];

  if (RETAIL_ECOM_MODES.includes(mode)) {
    rows.push(`    <EbpName>${esc(data.ecommercePlatform)}</EbpName>`);
    rows.push(`    <EbpCode>${esc(data.ecommercePlatformCode)}</EbpCode>`);
    rows.push(`    <OrderNo>${esc(data.orderNo)}</OrderNo>`);
    rows.push(`    <PayNo>${esc(data.paymentNo)}</PayNo>`);
    rows.push(`    <LogisticsNo>${esc(data.logisticsNo)}</LogisticsNo>`);
    if (data.deliveryMethod) {
      rows.push(`    <DeliveryMode>${esc(data.deliveryMethod)}</DeliveryMode>`);
    }
  } else if (B2B_ECOM_MODES.includes(mode)) {
    rows.push(`    <B2BOrderNo>${esc(data.b2bOrderNo)}</B2BOrderNo>`);
    if (data.b2bOrderAmount != null) {
      rows.push(`    <B2BAmount>${Number(data.b2bOrderAmount).toFixed(2)}</B2BAmount>`);
    }
    rows.push(`    <EbpName>${esc(data.b2bPlatform || data.ecommercePlatform)}</EbpName>`);
    if (data.b2bProductUrl) {
      rows.push(`    <B2BProductUrl>${esc(data.b2bProductUrl)}</B2BProductUrl>`);
    }
  } else {
    rows.push(`    <OverseasWarehouseCode>${esc(data.warehouseCode)}</OverseasWarehouseCode>`);
    rows.push(`    <OverseasWarehouseAddr>${esc(data.warehouseAddress)}</OverseasWarehouseAddr>`);
    rows.push(`    <InboundOrderNo>${esc(data.inboundOrderNo)}</InboundOrderNo>`);
  }

  return `
  <EcommerceInfo>
${rows.join('\n')}
  </EcommerceInfo>`;
}

export function generateCustomsXML(data: DeclarationData): string {
  const E = (v: any) => escapeXml(String(v == null ? '' : v));
  const ieFlag = 'E'; // 平台以出口为主;进口改为 'I'
  const billNo = data.billOfLading || data.vesselFlight || '';

  const listsXml = data.items.map((item, idx) => `
    <DecList>
      <GNo>${item.lineNo != null ? item.lineNo : (item.itemNo != null ? item.itemNo : idx + 1)}</GNo>
      <CodeTS>${E(normalizeHsCode(item.hsCode))}</CodeTS>
      <GName>${E(item.description)}</GName>
      <GModel>${E(item.model || (item as any).spec || '')}</GModel>
      <GQty>${Number(item.quantity).toFixed(5)}</GQty>
      <GUnit>${E(toCustomsCode(UNIT_CODES, item.unit))}</GUnit>
      <FirstQty>${item.legalQty != null ? Number(item.legalQty).toFixed(5) : ''}</FirstQty>
      <FirstUnit>${E(toCustomsCode(UNIT_CODES, item.legalUnit ?? ''))}</FirstUnit>
      <SecondQty>${item.legalQty2 != null ? Number(item.legalQty2).toFixed(5) : ''}</SecondQty>
      <SecondUnit>${E(toCustomsCode(UNIT_CODES, item.legalUnit2 ?? ''))}</SecondUnit>
      <DeclPrice>${Number(item.unitPrice).toFixed(4)}</DeclPrice>
      <DeclTotal>${Number(item.totalPrice).toFixed(2)}</DeclTotal>
      <TradeCurr>${E(toCode(CURRENCY_MAP, item.currency))}</TradeCurr>
      <OriginCountry>${E(toCode(COUNTRY_MAP, item.originCountry))}</OriginCountry>
      <DestinationCountry>${E(toCode(COUNTRY_MAP, item.destinationCountry || data.destinationCountry || ''))}</DestinationCountry>
      <DutyMode>${E(item.tariffRate != null ? '1' : '')}</DutyMode>
    </DecList>`).join('');

  // 运费/保费/杂费段(标记+数值+币制); 无值则输出空标记, 结构齐全便于客户端导入
  const feeXml = `
    <FreightMark>${E(data.freightMark)}</FreightMark>
    <FreightRate>${data.freightRate != null ? Number(data.freightRate).toFixed(2) : ''}</FreightRate>
    <FreightCurr>${E(toCode(CURRENCY_MAP, data.freightCurrency ?? ''))}</FreightCurr>
    <InsurMark>${E(data.insuranceMark)}</InsurMark>
    <InsurRate>${data.insuranceRate != null ? Number(data.insuranceRate).toFixed(2) : ''}</InsurRate>
    <InsurCurr>${E(toCode(CURRENCY_MAP, data.insuranceCurrency ?? ''))}</InsurCurr>
    <OtherMark>${E(data.otherMark)}</OtherMark>
    <OtherRate>${data.otherRate != null ? Number(data.otherRate).toFixed(2) : ''}</OtherRate>
    <OtherCurr>${E(toCode(CURRENCY_MAP, data.otherCurrency ?? ''))}</OtherCurr>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 字段命名依据: 海关总署2018年第67号公告《进出口货物报关单申报电子报文格式》 -->
<DecMessage>
  <DecHead>
    <SeqNo></SeqNo>
    <PreEntryId></PreEntryId>
    <EntryId></EntryId>
    <IEFlag>${ieFlag}</IEFlag>
    <CustomMaster>${E(data.customhouseCode)}</CustomMaster>
    <IEPort>${E(data.destinationPort || data.portOfEntry)}</IEPort>
    <ManualNo></ManualNo>
    <ContrNo>${E(data.contractNo)}</ContrNo>
    <TradeName>${E(data.consignee || data.importerExporter)}</TradeName>
    <OwnerName>${E(data.consignor || data.consignee || data.importerExporter)}</OwnerName>
    <AgentName>${E(data.agentName || data.declarant)}</AgentName>
    <AgentCode>${E(data.agentCode)}</AgentCode>
    <TrafMode>${E(toCode(TRAF_MODE_MAP, data.transportMode))}</TrafMode>
    <TrafName>${E(data.vesselFlight)}</TrafName>
    <BillNo>${E(billNo)}</BillNo>
    <TradeMode>${E(data.supervisionCode)}</TradeMode>
    <CutMode>${E(data.taxPreference)}</CutMode>
    <LicenseNo>${E(data.licenseNo)}</LicenseNo>
    <TradeCountry>${E(toCode(COUNTRY_MAP, data.destinationCountry ?? ''))}</TradeCountry>
    <DistinatePort>${E(data.destinationPort)}</DistinatePort>
    <TransMode>${mapTransMode(data.tradeTerms)}</TransMode>
    <PackNo>${E(data.numberOfPackages != null ? data.numberOfPackages : data.packageCount)}</PackNo>
    <WrapType>${E(data.packageType)}</WrapType>${feeXml}
    <GrossWet>${data.grossWeight != null ? Number(data.grossWeight).toFixed(5) : (data.totalGrossWeight != null ? Number(data.totalGrossWeight).toFixed(5) : '')}</GrossWet>
    <NetWt>${data.netWeight != null ? Number(data.netWeight).toFixed(5) : ''}</NetWt>
    <IEDate></IEDate>
    <NoteS></NoteS>
    <MarkNo></MarkNo>
  </DecHead>
  <DecLists>${listsXml}
  </DecLists>${buildEcommerceXml(data)}
</DecMessage>`;
}

/**
 * 按监管方式返回对应的报关单 XML 生成器。
 * 目前各模式共用同一套符合 67 号公告字段的标准报文生成器,
 * 仅在生成前注入该模式的 customsMode/监管方式; 后续如需差异化报文,
 * 可在此 switch(mode) 返回不同实现。供 ocrParser 与测试统一调用。
 */
export function getXmlGenerator(mode: CustomsMode): (data: DeclarationData) => string {
  const supervisionCode = CUSTOMS_MODE_INFO[mode]?.supervisionCode;
  return (data: DeclarationData) =>
    generateCustomsXML({ ...data, customsMode: mode, supervisionCode: data.supervisionCode || supervisionCode });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// 从平台数据构建报关单
// ============================================================

export async function buildDeclaration(tenantId: string, input: {
  hsCodes?: string[];
  importerExporter?: string;
  transportMode?: string;
  vesselFlight?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  portOfEntry?: string;
  tradeTerms?: string;
  currency?: string;
  customsMode?: string;
  consignee?: string;
  consignor?: string;
  contractNo?: string;
  destinationCountry?: string;
  freightMark?: string; freightRate?: number; freightCurrency?: string;
  insuranceMark?: string; insuranceRate?: number; insuranceCurrency?: string;
  otherMark?: string; otherRate?: number; otherCurrency?: string;
  // 跨境电商 9610 / 三单对碰
  logisticsNo?: string; ecommercePlatform?: string; ecommercePlatformCode?: string;
  orderNo?: string; paymentNo?: string; deliveryMethod?: DeliveryMethod;
  receiverIdType?: string; receiverIdNumber?: string;
  // 9710 B2B
  b2bOrderNo?: string; b2bPlatform?: string; b2bOrderAmount?: number; b2bProductUrl?: string;
  // 9810 海外仓
  warehouseAddress?: string; warehouseCode?: string; inboundOrderNo?: string;
  fnSku?: string; returnAddress?: string; estimatedSalesChannel?: string;
  // 1210/1239 保税备货进口
  bondedWarehouseId?: string; bondedWarehouseName?: string;
  consumerIdType?: string; consumerIdNumber?: string; consumerName?: string; consumerPhone?: string;
  tariffRateApplied?: number; taxReductionType?: string;
  itemDetails?: { hsCode: string; quantity?: number; unitPrice?: number; description?: string;
    originCountry?: string; model?: string; unit?: string;
    legalQty?: number; legalUnit?: string; legalQty2?: number; legalUnit2?: string }[];
}): Promise<DeclarationExport> {
  // 从平台查询HS编码和税率数据
  const hsCodes = input.hsCodes || [];
  const items: DeclarationItem[] = [];

  const detailsMap = new Map((input.itemDetails || []).map(d => [d.hsCode, d]));

  for (let i = 0; i < hsCodes.length; i++) {
    const code = hsCodes[i];
    const detail = detailsMap.get(code);
    const hsRecord = await prisma.hSCode.findUnique({ where: { code } }).catch(() => null);

    // 查询最优FTA税率（用4位前缀匹配）
    const prefix4 = code.replace(/[^0-9]/g, '').slice(0, 4);
    const originRules = await prisma.originRule.findMany({
      where: { hsCode: { startsWith: prefix4 } },
      include: { ftaAgreement: { select: { shortName: true } } },
      take: 10,
    }).catch(() => []);

    const bestFta = originRules
      .filter((r: any) => r.tariffReduction != null)
      .sort((a: any, b: any) => (a.tariffReduction!) - (b.tariffReduction!))[0];

    const quantity = detail?.quantity ?? 1;
    const unitPrice = detail?.unitPrice ?? 0;
    const totalPrice = unitPrice * quantity;

    items.push({
      lineNo: i + 1,
      itemNo: i + 1,
      hsCode: code,
      description: detail?.description || hsRecord?.description || `商品 ${code}`,
      model: detail?.model || '',
      quantity,
      unit: detail?.unit || hsRecord?.unit || '件',
      legalQty: detail?.legalQty,
      legalUnit: detail?.legalUnit,
      legalQty2: detail?.legalQty2,
      legalUnit2: detail?.legalUnit2,
      unitPrice,
      totalPrice,
      currency: input.currency || 'USD',
      originCountry: detail?.originCountry || 'CN',
      tariffRate: hsRecord?.tariffRate ?? null,
      ftaRate: bestFta?.tariffReduction ?? null,
      ftaName: bestFta?.ftaAgreement?.shortName || null,
    });
  }

  // 查询关联单证
  const docs = await prisma.document.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  // 自动生成报关单号: 年月日+序列号
  const today = new Date();
  const dateStr = today.getFullYear().toString().slice(2) +
    String(today.getMonth() + 1).padStart(2, '0') +
    String(today.getDate()).padStart(2, '0');
  const seq = String(Math.floor(Math.random() * 99999)).padStart(5, '0');
  const declarationNo = `CUS${dateStr}${seq}`;

  const declaration: DeclarationData = {
    declarationNo,
    declarant: '平台用户',
    importerExporter: input.importerExporter || input.consignee || '',
    consignee: input.consignee || input.importerExporter || '',
    consignor: input.consignor || '',
    contractNo: input.contractNo,
    destinationCountry: input.destinationCountry,
    transportMode: input.transportMode || '海运',
    vesselFlight: input.vesselFlight || '',
    portOfLoading: input.portOfLoading || '',
    portOfDischarge: input.portOfDischarge || '',
    portOfEntry: input.portOfEntry || '',
    tradeTerms: input.tradeTerms || 'FOB',
    currency: input.currency || 'USD',
    freightMark: input.freightMark, freightRate: input.freightRate, freightCurrency: input.freightCurrency,
    insuranceMark: input.insuranceMark, insuranceRate: input.insuranceRate, insuranceCurrency: input.insuranceCurrency,
    otherMark: input.otherMark, otherRate: input.otherRate, otherCurrency: input.otherCurrency,
    // 跨境电商 / B2B / 海外仓 / 保税备货 字段透传(供对应模式预检与报文使用)
    logisticsNo: input.logisticsNo, ecommercePlatform: input.ecommercePlatform, ecommercePlatformCode: input.ecommercePlatformCode,
    orderNo: input.orderNo, paymentNo: input.paymentNo, deliveryMethod: input.deliveryMethod,
    receiverIdType: input.receiverIdType, receiverIdNumber: input.receiverIdNumber,
    b2bOrderNo: input.b2bOrderNo, b2bPlatform: input.b2bPlatform, b2bOrderAmount: input.b2bOrderAmount, b2bProductUrl: input.b2bProductUrl,
    warehouseAddress: input.warehouseAddress, warehouseCode: input.warehouseCode, inboundOrderNo: input.inboundOrderNo,
    fnSku: input.fnSku, returnAddress: input.returnAddress, estimatedSalesChannel: input.estimatedSalesChannel,
    bondedWarehouseId: input.bondedWarehouseId, bondedWarehouseName: input.bondedWarehouseName,
    consumerIdType: input.consumerIdType, consumerIdNumber: input.consumerIdNumber,
    consumerName: input.consumerName, consumerPhone: input.consumerPhone,
    tariffRateApplied: input.tariffRateApplied, taxReductionType: input.taxReductionType,
    customsMode: (input.customsMode || 'normal') as any,
    items,
    documents: docs.map((d: any) => d.fileName),
    totalValue: items.reduce((s, i) => s + i.totalPrice, 0),
  };

  // 合规预检
  const preCheck = runPreCheck(declaration);

  // AI补充分析（不阻塞）
  const aiInsight = await aiPreCheckSupplement(declaration).catch(() => null);
  if (aiInsight) {
    preCheck.issues.push({
      severity: 'info', code: 'AI001', category: 'ai_analysis',
      message: aiInsight,
      suggestion: 'AI分析仅供参考',
    });
  }

  // 生成XML
  const xmlContent = generateCustomsXML(declaration);

  // 记录审计日志
  await prisma.auditLog.create({
    data: {
      tenantId,
      action: 'declaration_build',
      detail: `报关单构建: ${items.length}项商品 | 合规得分: ${preCheck.score} | ${preCheck.passed ? '通过' : '未通过'}`,
    },
  }).catch(() => {});

  // Webhook事件: declaration.build
  import('./webhook/eventEmitter').then(({ eventEmitter }) =>
    eventEmitter.fire('declaration.build', tenantId, {
      items: items.map(i => ({ hsCode: i.hsCode, description: i.description.slice(0, 100), quantity: i.quantity, totalPrice: i.totalPrice })),
      totalValue: declaration.totalValue,
      score: preCheck.score,
      passed: preCheck.passed,
    }).catch(() => {}),
  );

  return {
    declaration,
    preCheck,
    xmlContent,
    exportedAt: new Date().toISOString(),
  };
}

// ============================================================
// 批量导出 (多票报关单)
// ============================================================

export async function batchBuildDeclarations(
  tenantId: string,
  batches: Parameters<typeof buildDeclaration>[1][]
): Promise<DeclarationExport[]> {
  const results: DeclarationExport[] = [];
  for (const batch of batches) {
    const result = await buildDeclaration(tenantId, batch);
    results.push(result);
  }
  return results;
}
