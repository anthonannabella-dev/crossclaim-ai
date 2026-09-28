jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));
import { generateCustomsXML } from '../src/services/declarationBuilder';

const base: any = {
  supervisionCode: '', customsMode: 'normal', transportMode: '水路运输',
  portOfEntry: '5300', currency: 'USD', tradeTerms: 'FOB', contractNo: 'PO-1',
  destinationCountry: 'US', grossWeight: 100, netWeight: 90, billOfLading: 'BL123',
  items: [{ lineNo:1, hsCode:'8517120000', description:'手机', quantity:10, unit:'台', unitPrice:5, totalPrice:50, currency:'USD', originCountry:'CN' }],
};

describe('报关XML 跨境电商附加段', () => {
  test('一般贸易：不输出 EcommerceInfo', () => {
    const xml = generateCustomsXML({ ...base, customsMode: 'normal', supervisionCode: '0110' });
    expect(xml).not.toContain('<EcommerceInfo>');
  });
  test('9610 零售：输出三单+平台', () => {
    const xml = generateCustomsXML({ ...base, customsMode: '9610', supervisionCode: '9610',
      ecommercePlatform: 'Amazon', ecommercePlatformCode: 'PL001',
      orderNo: 'SO1', paymentNo: 'PAY1', logisticsNo: 'LOG1', deliveryMethod: 'express' });
    expect(xml).toContain('<EcommerceInfo>');
    expect(xml).toContain('<OrderNo>SO1</OrderNo>');
    expect(xml).toContain('<PayNo>PAY1</PayNo>');
    expect(xml).toContain('<LogisticsNo>LOG1</LogisticsNo>');
    expect(xml).toContain('<EbpName>Amazon</EbpName>');
    expect(xml).toContain('<EbpCode>PL001</EbpCode>');
  });
  test('9710 B2B：输出 B2B 出口单号', () => {
    const xml = generateCustomsXML({ ...base, customsMode: '9710', supervisionCode: '9710',
      b2bOrderNo: 'B2B-9', b2bPlatform: 'Alibaba', b2bOrderAmount: 12345.6 });
    expect(xml).toContain('<B2BOrderNo>B2B-9</B2BOrderNo>');
    expect(xml).toContain('<B2BAmount>12345.60</B2BAmount>');
    expect(xml).toContain('<EbpName>Alibaba</EbpName>');
    expect(xml).not.toContain('<OrderNo>');   // B2B 不走零售三单
  });
  test('9810 海外仓：输出仓码/地址/入仓单', () => {
    const xml = generateCustomsXML({ ...base, customsMode: '9810', supervisionCode: '9810',
      warehouseCode: 'WH-LA', warehouseAddress: '123 LA St', inboundOrderNo: 'IN-1' });
    expect(xml).toContain('<OverseasWarehouseCode>WH-LA</OverseasWarehouseCode>');
    expect(xml).toContain('<InboundOrderNo>IN-1</InboundOrderNo>');
  });
  test('特殊字符转义安全', () => {
    const xml = generateCustomsXML({ ...base, customsMode: '9610', supervisionCode: '9610',
      ecommercePlatform: 'A&B<>"', orderNo: 'O&1', paymentNo: 'P', logisticsNo: 'L' });
    expect(xml).toContain('A&amp;B&lt;&gt;');
    expect(xml).not.toMatch(/<EbpName>A&B/);
  });
});
