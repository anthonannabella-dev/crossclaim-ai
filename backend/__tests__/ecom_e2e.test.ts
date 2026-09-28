// 跨境电商整票流程「逻辑链」端到端：三单OCR文本 → 探测监管方式+抽三单 → 预检(ECM) → 报文(EcommerceInfo)
jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));
import { detectEcommerceFromDocs } from '../src/services/groupPipelineService';
import { runPreCheck, generateCustomsXML } from '../src/services/declarationBuilder';

// 模拟从订单/支付/物流三单 OCR 出来的文本（与样本单证一致）
const triDocs = [
  { ocrResult: 'Platform Order  Platform: Amazon US  Order No: SO20240617001  Buyer: ACME TRADING LLC' },
  { ocrResult: '支付单 Payment Document  Payment Enterprise: PingPong  Payment No: PAY20240617XYZ  Order No: SO20240617001' },
  { ocrResult: '物流单 Logistics Document  Logistics No: SF1234567890  Order No: SO20240617001' },
];

describe('跨境电商整票流程(逻辑链)', () => {
  test('① 制单探测：识别 9610 + 抽出三单/平台', () => {
    const e = detectEcommerceFromDocs(triDocs);
    expect(e.customsMode).toBe('9610');
    expect(e.orderNo).toBe('SO20240617001');
    expect(e.paymentNo).toBe('PAY20240617XYZ');
    expect(e.logisticsNo).toBe('SF1234567890');
    expect(e.ecommercePlatform).toMatch(/Amazon/);
  });

  test('② 一般贸易单证：不误判为电商', () => {
    const e = detectEcommerceFromDocs([{ ocrResult: 'COMMERCIAL INVOICE  Invoice No: INV-1  HS Code: 8517120000' }]);
    expect(e.customsMode).toBeUndefined();
  });

  test('③ 探测结果进预检：ECM 三单规则全过', () => {
    const e = detectEcommerceFromDocs(triDocs);
    const decl: any = {
      customsMode: e.customsMode, supervisionCode: e.supervisionCode,
      orderNo: e.orderNo, paymentNo: e.paymentNo, logisticsNo: e.logisticsNo,
      ecommercePlatform: e.ecommercePlatform, ecommercePlatformCode: 'PL001',
      deliveryMethod: 'express', tradeTerms: 'FOB', currency: 'USD',
      destinationCountry: 'US', grossWeight: 100, netWeight: 90, totalValue: 85300,
      items: [{ lineNo:1, hsCode:'8517120000', description:'智能手机', model:'X1', quantity:1000, unit:'台', unitPrice:85.3, totalPrice:85300, currency:'USD', originCountry:'CN' }],
    };
    const r = runPreCheck(decl);
    const ecmErrors = (r.issues||[]).filter((i:any)=> i.code?.startsWith('ECM') && i.severity==='error');
    expect(ecmErrors.length).toBe(0);   // 三单齐 → 无电商缺失类错误
  });

  test('④ 探测结果进报文：XML 含 EcommerceInfo + 三单', () => {
    const e = detectEcommerceFromDocs(triDocs);
    const xml = generateCustomsXML({
      customsMode: e.customsMode, supervisionCode: e.supervisionCode,
      orderNo: e.orderNo, paymentNo: e.paymentNo, logisticsNo: e.logisticsNo,
      ecommercePlatform: e.ecommercePlatform, tradeTerms:'FOB', currency:'USD',
      destinationCountry:'US', grossWeight:100, netWeight:90, billOfLading:'BL1',
      items:[{ lineNo:1, hsCode:'8517120000', description:'手机', quantity:1000, unit:'台', unitPrice:85.3, totalPrice:85300, currency:'USD', originCountry:'CN' }],
    } as any);
    expect(xml).toContain('<EcommerceInfo>');
    expect(xml).toContain('<OrderNo>SO20240617001</OrderNo>');
    expect(xml).toContain('<PayNo>PAY20240617XYZ</PayNo>');
    expect(xml).toContain('<LogisticsNo>SF1234567890</LogisticsNo>');
  });
});
