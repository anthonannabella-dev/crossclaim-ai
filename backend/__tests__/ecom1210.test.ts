// 验证：1210/1239(保税电商)缺三单/平台，现在能被预检拦下（修复前为 0 拦截）
jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));
import { runPreCheck } from '../src/services/declarationBuilder';

const baseMissing: any = {
  transportMode: '海运', portOfEntry: '5300', currency: 'USD',
  items: [{ lineNo:1, itemNo:1, hsCode:'8517120000', description:'手机', quantity:10, unit:'台', unitPrice:80, totalPrice:800, currency:'USD', originCountry:'CN', tariffRate:0 }],
  // 故意不填 orderNo/paymentNo/logisticsNo/ecommercePlatform
};

function ecomErrors(mode: string) {
  const r = runPreCheck({ ...baseMissing, customsMode: mode });
  return (r.issues || []).filter((i: any) => i.category === 'triple_check' || i.code?.startsWith('ECM00'));
}

describe('跨境电商 1210/1239 预检拦截', () => {
  test('9610 缺三单被拦（基准）', () => {
    expect(ecomErrors('9610').length).toBeGreaterThan(0);
  });
  test('1210 缺三单现在也被拦（修复点）', () => {
    const e = ecomErrors('1210');
    expect(e.length).toBeGreaterThan(0);
    expect(e.some((i: any) => i.field === 'orderNo')).toBe(true);
  });
  test('每条电商结论自动附带可追溯法规依据', () => {
    const e = ecomErrors('9610');
    expect(e.every((i: any) => typeof i.legalBasis === 'string' && i.legalBasis.length > 0)).toBe(true);
    expect(e.some((i: any) => i.legalBasis.includes('194号公告'))).toBe(true);
  });
  test('1239 缺三单现在也被拦', () => {
    expect(ecomErrors('1239').length).toBeGreaterThan(0);
  });
  test('normal(一般贸易) 不触发电商三单校验', () => {
    expect(ecomErrors('normal').length).toBe(0);
  });
});
