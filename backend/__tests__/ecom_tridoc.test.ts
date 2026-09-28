// 跨境电商三单 + 报关委托书：识别 & 三单对碰(订单号一致性)
jest.mock('../src/config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/ai/deepseek', () => ({ getClient: () => null, smartClassify: jest.fn(), aiDiagnose: jest.fn() }));
import { detectDocType, crossCheckDocuments, DOC_TYPE_LABELS } from '../src/services/documentAuditService';

const mkDoc = (id: string, docType: any, orderNo: string) => ({
  id, fileName: id + '.pdf',
  auditResult: {
    documentId: id, fileName: id + '.pdf', docType, docTypeLabel: DOC_TYPE_LABELS[docType as keyof typeof DOC_TYPE_LABELS],
    ocrText: '', fields: [{ field: 'orderNo', label: '订单号', value: orderNo, confidence: 1, source: 'ocr' }],
    issues: [],
  } as any,
});
const findTri = (results: any[]) => results.flatMap(r => r.checks).filter((c: any) => c.name === '三单对碰(订单号)');

describe('跨境电商三单 + 报关委托书', () => {
  test('单证类型识别', () => {
    expect(detectDocType('电商平台订单 订单号: SO20240617001 平台: Amazon', 'order.pdf')).toBe('order_document');
    expect(detectDocType('支付单 支付企业: PingPong 支付单号: PAY998 订单号: SO20240617001', 'pay.pdf')).toBe('payment_document');
    expect(detectDocType('物流单 物流企业: 顺丰 运单号: SF123 订单号: SO20240617001', 'log.pdf')).toBe('logistics_document');
    expect(detectDocType('代理报关委托书 委托方: 某公司 受托方: 某报关行', 'poa.pdf')).toBe('customs_power_of_attorney');
  });

  test('三单订单号一致 → 对碰通过', () => {
    const docs = [
      mkDoc('order', 'order_document', 'SO20240617001'),
      mkDoc('pay', 'payment_document', 'SO20240617001'),
      mkDoc('log', 'logistics_document', 'SO20240617001'),
    ];
    const tri = findTri(crossCheckDocuments(docs));
    expect(tri.length).toBe(3);          // 订单↔支付, 订单↔物流, 支付↔物流
    expect(tri.every((c: any) => c.passed)).toBe(true);
  });

  test('物流单订单号不符 → 对碰失败被抓出', () => {
    const docs = [
      mkDoc('order', 'order_document', 'SO20240617001'),
      mkDoc('pay', 'payment_document', 'SO20240617001'),
      mkDoc('log', 'logistics_document', 'WRONG-999'),
    ];
    const tri = findTri(crossCheckDocuments(docs));
    const failed = tri.filter((c: any) => !c.passed);
    expect(failed.length).toBe(2);       // 与 order、pay 两对都不符
  });
});
