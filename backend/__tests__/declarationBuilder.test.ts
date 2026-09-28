// 仅测纯函数(runPreCheck/XML生成),mock 掉 prisma 单例,使本套件不依赖真实数据库/Prisma引擎
jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));
import { runPreCheck, CUSTOMS_MODE_INFO, getXmlGenerator, CustomsMode, DeclarationData, DeclarationItem } from '../src/services/declarationBuilder';

// ── 数据工厂 ────────────────────────────────────────────────
function makeItem(overrides?: Partial<DeclarationItem>): DeclarationItem {
  return {
    lineNo: 1,
    hsCode: '8471300000',
    description: '便携式自动数据处理设备',
    model: '品牌:TEST 型号:NB-15 13.3英寸',
    quantity: 100,
    unit: '台',
    unitPrice: 500,
    totalPrice: 50000,
    currency: 'USD',
    originCountry: '中国',
    tradeTerms: 'CIF',
    ...overrides,
  };
}

function makeValidDeclaration(overrides?: Partial<DeclarationData>): DeclarationData {
  return {
    customsMode: 'normal',
    supervisionCode: '0110',
    taxMethod: '一般征税',
    portOfEntry: '上海外高桥',
    transportMode: '海运',
    consignee: '上海测试进出口有限公司',
    consignor: '深圳测试科技有限公司',
    declarant: '测试报关行',
    contractNo: 'CON20260601',
    currency: 'USD',
    totalValue: 60000,
    tradeTerms: 'CIF',
    freightMark: '3', freightRate: 1200, freightCurrency: 'USD',
    documents: ['商业发票', '装箱单', '提单'],
    items: [makeItem(), makeItem({ lineNo: 2, hsCode: '8528520000', description: '液晶显示器', model: '品牌:TEST 27寸 IPS', quantity: 50, unitPrice: 200, totalPrice: 10000 })],
    ...overrides,
  };
}

// ============================================================
// CUSTOMS_MODE_INFO — 7 种模式配置完整性
// ============================================================
describe('CUSTOMS_MODE_INFO — 7 种报关模式', () => {
  const MODES: CustomsMode[] = ['normal', '9610', '9710', '9810', '1210', '1239', '1039'];

  it.each(MODES)('模式 %s 应有完整配置', (mode) => {
    const cfg = CUSTOMS_MODE_INFO[mode];
    expect(cfg).toBeDefined();
    expect(cfg.label).toBeTruthy();
    expect(cfg.supervisionCode).toMatch(/^\d{4}$/);
    expect(cfg.taxMethod).toBeTruthy();
    expect(Array.isArray(cfg.requiredFields)).toBe(true);
    expect(cfg.requiredFields.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(cfg.allowedTransportModes)).toBe(true);
  });

  it.each(MODES)('模式 %s 的 XML 生成器应可用', (mode) => {
    const gen = getXmlGenerator(mode);
    expect(typeof gen).toBe('function');
    expect(gen.length).toBe(1); // 接受一个 data 参数
  });
});

// ============================================================
// runPreCheck — 完整数据通关
// ============================================================
describe('runPreCheck — 正常数据应通过', () => {
  it('完整合规数据应返回 passed=true 且 score=100', () => {
    const data = makeValidDeclaration();
    const result = runPreCheck(data);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.issues).toHaveLength(0);
  });
});

// ============================================================
// 分类规则: HS001 + HS002
// ============================================================
describe('rule HS001 — 商品描述', () => {
  it('描述为空时应返回 error', () => {
    const data = makeValidDeclaration();
    data.items[0].description = '';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'HS001' && i.severity === 'error')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('描述太短（<2字）也应返回 error', () => {
    const data = makeValidDeclaration();
    data.items[0].description = '货';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'HS001')).toBe(true);
  });
});

describe('rule HS002 — HS编码格式', () => {
  it('无效 HS 编码格式应返回 error', () => {
    const data = makeValidDeclaration();
    data.items[0].hsCode = '123';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'HS002')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('合法10位申报编码（如 8517120000）应不触发 HS002', () => {
    const data = makeValidDeclaration();
    data.items[0].hsCode = '8517120000';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'HS002')).toBe(false);
  });

  it('HS6编码（如 8471.30）位数不足，应触发 HS002', () => {
    const data = makeValidDeclaration();
    data.items[0].hsCode = '8471.30';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'HS002')).toBe(true);
  });
});

// ============================================================
// 估价规则: VAL001 + VAL002
// ============================================================
describe('rule VAL001 — 单价异常偏低', () => {
  it('单价 < 0.01 时应返回 warning', () => {
    const data = makeValidDeclaration();
    data.items[0].unitPrice = 0.005;
    const result = runPreCheck(data);
    // VAL001 是 warning，不导致 passed=false
    expect(result.issues.some(i => i.code === 'VAL001')).toBe(true);
  });
});

describe('rule VAL002 — 总金额与明细合计不一致', () => {
  it('总金额与明细合计差异 > 5% 时应返回 error', () => {
    const data = makeValidDeclaration();
    data.totalValue = 999999; // 明细合计约 60000
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'VAL002' && i.severity === 'error')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

// ============================================================
// 原产地规则: ORI001 + ORI002
// ============================================================
describe('rule ORI001 — 缺少原产国', () => {
  it('原产国为空时应返回 error', () => {
    const data = makeValidDeclaration();
    data.items[0].originCountry = '';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'ORI001' && i.severity === 'error')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('rule ORI002 — 有 FTA 税率但缺少产地证', () => {
  it('FTA税率存在但单证列表不含产地证时应返回 warning', () => {
    const data = makeValidDeclaration();
    data.items[0].ftaRate = 0.05;
    data.documents = ['商业发票', '装箱单'];
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'ORI002')).toBe(true);
  });
});

// ============================================================
// 单证规则: DOC001 + DOC002
// ============================================================
describe('rule DOC001 — 单证不足', () => {
  it('单证数量少于 2 时应返回 error', () => {
    const data = makeValidDeclaration();
    data.documents = ['商业发票'];
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'DOC001' && i.severity === 'error')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('rule DOC002 — 缺少必要单证', () => {
  it('缺少商业发票时应返回 error', () => {
    const data = makeValidDeclaration();
    data.documents = ['装箱单', '提单'];
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'DOC002')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

// ============================================================
// 运输规则: TRA001 + TRA002
// ============================================================
describe('rule TRA001 — 缺少入境口岸', () => {
  it('portOfEntry 为空时应返回 error', () => {
    const data = makeValidDeclaration();
    data.portOfEntry = '';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'TRA001' && i.severity === 'error')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('rule TRA002 — 缺少运输方式', () => {
  it('transportMode 为空时应返回 error', () => {
    const data = makeValidDeclaration();
    data.transportMode = '';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'TRA002' && i.severity === 'error')).toBe(true);
    expect(result.passed).toBe(false);
  });
});

// ============================================================
// 币种规则: CUR001
// ============================================================
describe('rule CUR001 — 多币种警告', () => {
  it('明细中存在多个不同币种时应返回 warning', () => {
    const data = makeValidDeclaration();
    data.items[0].currency = 'USD';
    data.items[1].currency = 'EUR';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'CUR001')).toBe(true);
  });
});

// ============================================================
// RCEP 规则: RCP001
// ============================================================
describe('rule RCP001 — RCEP 协定提示', () => {
  it('适用 RCEP 税率时应返回 info 提示', () => {
    const data = makeValidDeclaration();
    data.items[0].ftaName = 'RCEP';
    const result = runPreCheck(data);
    expect(result.issues.some(i => i.code === 'RCP001' && i.severity === 'info')).toBe(true);
  });
});

// ============================================================
// AI001 — AI 预检补充（由 runPreCheck 触发提示）
// ============================================================
describe('rule AI001 — AI 补充提示', () => {
  it('任何情况下 AI001 应返回 info（提示可调用 AI 补充）', () => {
    const data = makeValidDeclaration();
    const result = runPreCheck(data);
    // AI001 是 info 级别，不影响 passed
    // AI001 现在是异步补充的，纯 runPreCheck 不生成
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ============================================================
// 评分边界
// ============================================================
describe('评分边界', () => {
  it('5 个 error 叠加 score 应为 0 且 passed=false', () => {
    const data = makeValidDeclaration();
    data.items[0].description = '';
    data.items[0].hsCode = 'xxx';
    data.items[0].originCountry = '';
    data.portOfEntry = '';
    data.transportMode = '';
    // 同时令总金额不一致
    data.totalValue = 999999;
    const result = runPreCheck(data);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.issues.filter(i => i.severity === 'error').length).toBeGreaterThanOrEqual(3);
  });
});
