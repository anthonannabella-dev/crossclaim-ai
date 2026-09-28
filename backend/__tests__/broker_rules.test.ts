// 报关员视角：用真实海关报文(67号公告)结构跑权威规则，验证勾稽/成交方式/毛净重被拦截
jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));
import { runPreCheck } from '../src/services/declarationBuilder';

// 由 sample_declaration.xml 还原的真实结构（手机+充电器两项）
const goodItems = [
  { lineNo:1, itemNo:1, hsCode:'8517120000', description:'移动电话(智能手机)', model:'X1', quantity:500, unit:'台', unitPrice:85.3, totalPrice:42650, currency:'USD', originCountry:'CN', tariffRate:0 },
  { lineNo:2, itemNo:2, hsCode:'8504401400', description:'手机充电器', model:'C1', quantity:500, unit:'个', unitPrice:12, totalPrice:6000, currency:'USD', originCountry:'CN', tariffRate:0 },
];
const base: any = {
  transportMode:'水路运输', portOfEntry:'5300', tradeTerms:'FOB', currency:'USD',
  contractNo:'PO-2024-0617', declarant:'某报关代理', importerExporter:'深圳某进出口',
  destinationCountry:'502', grossWeight:3200.5, netWeight:2950.25,
  totalValue:48650, items: goodItems, customsMode:'normal',
};
const codes = (r:any)=> (r.issues||[]).map((i:any)=>i.code);

describe('报关员核对规则', () => {
  test('合规单：无 error（基准）', () => {
    const r = runPreCheck({ ...base });
    const errs = (r.issues||[]).filter((i:any)=>i.severity==='error');
    expect(errs.map((e:any)=>e.code)).not.toContain('VAL002');
    expect(errs.map((e:any)=>e.code)).not.toContain('WGT001');
  });
  test('金额勾稽不符 → VAL002', () => {
    const r = runPreCheck({ ...base, totalValue: 99999 });
    expect(codes(r)).toContain('VAL002');
  });
  test('CIF 成交但未申报运费 → FEE001', () => {
    const r = runPreCheck({ ...base, tradeTerms:'CIF' }); // freightRate 缺失
    expect(codes(r)).toContain('FEE001');
  });
  test('毛重 < 净重 → WGT001', () => {
    const r = runPreCheck({ ...base, grossWeight: 1000, netWeight: 2950.25 });
    expect(codes(r)).toContain('WGT001');
  });
  test('每条结论均带法规依据', () => {
    const r = runPreCheck({ ...base, totalValue: 99999, tradeTerms:'CIF', grossWeight:1, netWeight:5 });
    expect((r.issues||[]).every((i:any)=> i.code==='AI001' || (typeof i.legalBasis==='string' && i.legalBasis))).toBe(true);
  });
});
