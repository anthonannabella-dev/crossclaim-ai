// 证件台账逻辑测试：到期天数/已过期-即将到期分桶/CRUD（用内存 prisma 模拟）
const store: any[] = [];
const fakeModel = {
  findMany: async ({ where, orderBy }: any = {}) => {
    let rows = store.filter(r => r.tenantId === where?.tenantId);
    if (where?.NOT?.status) rows = rows.filter(r => r.status !== where.NOT.status);
    return [...rows];
  },
  create: async ({ data }: any) => { const row = { id: 'L' + (store.length + 1), createdAt: new Date(), updatedAt: new Date(), ...data }; store.push(row); return row; },
  findFirst: async ({ where }: any) => store.find(r => r.id === where.id && r.tenantId === where.tenantId) || null,
  update: async ({ where, data }: any) => { const r = store.find(x => x.id === where.id); Object.assign(r, data); return r; },
  delete: async ({ where }: any) => { const i = store.findIndex(x => x.id === where.id); store.splice(i, 1); return {}; },
};
jest.mock('../src/config/database', () => ({ __esModule: true, default: { licenseRecord: fakeModel } }));

import { createLicense, listLicenses, licenseAlerts, updateLicense, deleteLicense } from '../src/services/licenseService';

const T = 'tenant-1';
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

describe('证件台账', () => {
  beforeAll(async () => {
    await createLicense(T, { licenseType: '进出口许可证', licenseNo: 'IMP-001', expiryDate: inDays(10) });   // 即将到期
    await createLicense(T, { licenseType: '3C认证', licenseNo: '3C-002', expiryDate: inDays(-5) });          // 已过期
    await createLicense(T, { licenseType: '卫生证书', licenseNo: 'HC-003', expiryDate: inDays(200) });        // 远期
    await createLicense(T, { licenseType: '无期限证', licenseNo: 'NA-004' });                                  // 无有效期
  });

  test('必填校验', async () => {
    await expect(createLicense(T, { licenseType: '', licenseNo: '' } as any)).rejects.toThrow();
  });

  test('列表按有效期升序、状态自动推导', async () => {
    const rows = await listLicenses(T);
    expect(rows.length).toBe(4);
    const c3 = rows.find((r: any) => r.licenseNo === '3C-002');
    expect(c3.status).toBe('expired');       // 过期自动推导
    expect(c3.daysToExpiry).toBeLessThan(0);
  });

  test('到期预警分桶（30天内）', async () => {
    const a = await licenseAlerts(T, 30);
    expect(a.expiredCount).toBe(1);                      // 3C-002
    expect(a.expiringCount).toBe(1);                     // IMP-001(10天)
    expect(a.expiring[0].licenseNo).toBe('IMP-001');
    expect(a.expired[0].licenseNo).toBe('3C-002');
    // 远期/无期限不进预警
    expect(a.expiring.some((r: any) => r.licenseNo === 'HC-003')).toBe(false);
  });

  test('更新有效期后重新分桶', async () => {
    const rows = await listLicenses(T);
    const hc = rows.find((r: any) => r.licenseNo === 'HC-003');
    await updateLicense(T, hc.id, { expiryDate: inDays(3) });   // 改成3天后到期
    const a = await licenseAlerts(T, 30);
    expect(a.expiringCount).toBe(2);
  });

  test('删除', async () => {
    const rows = await listLicenses(T);
    await deleteLicense(T, rows[0].id);
    expect((await listLicenses(T)).length).toBe(3);
  });
});
