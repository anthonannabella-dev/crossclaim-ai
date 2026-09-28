// groupCrossCheckByBL 缓存行为测试(mock prisma + redis, 沙箱可跑)
// 覆盖:缓存命中直接返回不重算/不回写;未命中计算后写缓存(TTL 3600);
//       缓存键含文档指纹,文档 updatedAt 变化时键随之改变(自动失效)。

jest.mock('../src/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../src/config/database', () => {
  const prisma = { document: { findMany: jest.fn(async () => []) } };
  return { __esModule: true, default: prisma, prisma };
});
jest.mock('../src/services/ai/deepseek', () => ({
  getClient: jest.fn(),
  callAI: jest.fn(async () => ''),
  completionJSON: jest.fn(async () => null),
  completion: jest.fn(async () => ''),
}));
jest.mock('../src/config/redis', () => ({
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => {}),
  cacheDel: jest.fn(async () => {}),
}));

import prisma from '../src/config/database';
import { cacheGet, cacheSet } from '../src/config/redis';
import { groupCrossCheckByBL } from '../src/services/documentAuditService';

const db = prisma as any;
const cGet = cacheGet as jest.Mock;
const cSet = cacheSet as jest.Mock;

const doc = (o: any) => ({
  id: o.id, fileName: o.fileName ?? 'invoice.pdf',
  ocrResult: o.ocrResult ?? '商业发票 Commercial Invoice 金额 100 USD',
  billOfLading: o.billOfLading ?? 'BL-X',
  updatedAt: new Date(o.updatedAt ?? '2026-01-01T00:00:00Z'),
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DEEPSEEK_API_KEY; // 确保不触发真实 AI, 走免费正则
});

describe('groupCrossCheckByBL 缓存', () => {
  test('缓存命中 → 直接返回, 不计算、不回写', async () => {
    db.document.findMany.mockResolvedValueOnce([doc({ id: '1' })]);
    const cached = { blNo: 'BL-X', documents: [], crossChecks: [], overallPassed: true, summary: { total: 0, passed: 0, warnings: 0 } };
    cGet.mockResolvedValueOnce(JSON.stringify(cached));

    const res = await groupCrossCheckByBL('t', 'BL-X');
    expect(res).toEqual(cached);
    expect(cSet).not.toHaveBeenCalled();
  });

  test('缓存未命中 → 计算后写缓存(键含 crosscheck 前缀, TTL 3600)', async () => {
    db.document.findMany.mockResolvedValueOnce([doc({ id: '1' })]);
    cGet.mockResolvedValueOnce(null);

    const res = await groupCrossCheckByBL('t', 'BL-X');
    expect(res.blNo).toBe('BL-X');
    expect(cSet).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = cSet.mock.calls[0];
    expect(key).toMatch(/^crosscheck:t:BL-X:/);
    expect(ttl).toBe(3600);
    expect(() => JSON.parse(value)).not.toThrow();
  });

  test('文档 updatedAt 变化 → 缓存键随之改变(自动失效)', async () => {
    cGet.mockResolvedValue(null);
    db.document.findMany.mockResolvedValueOnce([doc({ id: '1', updatedAt: '2026-01-01T00:00:00Z' })]);
    await groupCrossCheckByBL('t', 'BL-X');
    const key1 = cGet.mock.calls[0][0];

    db.document.findMany.mockResolvedValueOnce([doc({ id: '1', updatedAt: '2026-02-02T00:00:00Z' })]);
    await groupCrossCheckByBL('t', 'BL-X');
    const key2 = cGet.mock.calls[1][0];

    expect(key1).not.toEqual(key2);
  });
});
