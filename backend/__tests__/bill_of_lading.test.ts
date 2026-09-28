// 提单管理 listBillOfLading / getDeclarationsByBL 测试(mock prisma, 沙箱可跑)
// 覆盖:按 billOfLading 列分组、金额求和、状态/监管方式去重、
//       多币种标记 MIXED、单币种保留原币种、按列直接查单个提单、空结果返回 null。

jest.mock('../src/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../src/config/database', () => {
  const prisma = { declaration: { findMany: jest.fn(async () => []) } };
  return { __esModule: true, default: prisma, prisma };
});

import prisma from '../src/config/database';
import { listBillOfLading, getDeclarationsByBL } from '../src/services/declarationService';

const db = prisma as any;
const row = (o: any) => ({
  id: o.id, declarationNo: o.declarationNo ?? null, status: o.status ?? 'draft',
  customsMode: o.customsMode ?? 'normal', totalValue: o.totalValue ?? 0,
  currency: o.currency ?? 'USD', billOfLading: o.billOfLading,
  createdAt: new Date(o.createdAt ?? '2026-01-01T00:00:00Z'),
  updatedAt: new Date(o.updatedAt ?? '2026-01-01T00:00:00Z'),
});

beforeEach(() => jest.clearAllMocks());

describe('listBillOfLading 按提单归集', () => {
  test('按 billOfLading 列分组、求和、去重状态/监管方式', async () => {
    db.declaration.findMany.mockResolvedValueOnce([
      row({ id: '1', billOfLading: 'BL-A', totalValue: 100, status: 'draft', customsMode: 'normal' }),
      row({ id: '2', billOfLading: 'BL-A', totalValue: 250, status: 'submitted', customsMode: 'normal' }),
      row({ id: '3', billOfLading: 'BL-B', totalValue: 70, status: 'draft', customsMode: '9610' }),
    ]);
    const res = await listBillOfLading('t');
    const a = res.find((g) => g.billOfLading === 'BL-A')!;
    expect(a.declarationCount).toBe(2);
    expect(a.totalValue).toBe(350);
    expect(a.statuses.sort()).toEqual(['draft', 'submitted']);
    expect(a.customsModes).toEqual(['normal']); // 去重
    expect(res.find((g) => g.billOfLading === 'BL-B')!.declarationCount).toBe(1);
    // 查询走列且过滤非空
    expect(db.declaration.findMany.mock.calls[0][0].where).toEqual({ tenantId: 't', billOfLading: { not: null } });
  });

  test('同提单单一币种 → 保留该币种', async () => {
    db.declaration.findMany.mockResolvedValueOnce([
      row({ id: '1', billOfLading: 'BL-A', currency: 'CNY', totalValue: 10 }),
      row({ id: '2', billOfLading: 'BL-A', currency: 'CNY', totalValue: 20 }),
    ]);
    const [g] = await listBillOfLading('t');
    expect(g.currency).toBe('CNY');
  });

  test('同提单多币种 → 标记 MIXED(不静默相加成误导币种)', async () => {
    db.declaration.findMany.mockResolvedValueOnce([
      row({ id: '1', billOfLading: 'BL-A', currency: 'USD', totalValue: 10 }),
      row({ id: '2', billOfLading: 'BL-A', currency: 'CNY', totalValue: 20 }),
    ]);
    const [g] = await listBillOfLading('t');
    expect(g.currency).toBe('MIXED');
  });
});

describe('getDeclarationsByBL 按列直查', () => {
  test('直接按 billOfLading 列查询单个提单(不加载全部)', async () => {
    db.declaration.findMany.mockResolvedValueOnce([
      row({ id: '1', billOfLading: 'BL-X', totalValue: 99 }),
    ]);
    const g = await getDeclarationsByBL('t', 'BL-X');
    expect(g?.billOfLading).toBe('BL-X');
    expect(g?.totalValue).toBe(99);
    expect(db.declaration.findMany.mock.calls[0][0].where).toEqual({ tenantId: 't', billOfLading: 'BL-X' });
  });

  test('无匹配 → null', async () => {
    db.declaration.findMany.mockResolvedValueOnce([]);
    expect(await getDeclarationsByBL('t', 'NOPE')).toBeNull();
  });
});
