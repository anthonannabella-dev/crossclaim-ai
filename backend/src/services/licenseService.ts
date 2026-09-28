import prisma from '../config/database';

export interface LicenseInput {
  licenseType: string;
  licenseCode?: string | null;
  licenseNo: string;
  holder?: string | null;
  relatedHsCodes?: string | null;
  issuingAuthority?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  notes?: string | null;
}

const db = () => (prisma as any).licenseRecord;

function daysUntil(expiry: Date | null): number | null {
  if (!expiry) return null;
  const ms = expiry.getTime() - Date.now();
  return Math.ceil(ms / (24 * 3600 * 1000));
}

// 依据有效期推导实时状态（不改库，展示用）
function deriveStatus(raw: any): string {
  if (raw.status === 'revoked') return 'revoked';
  const d = daysUntil(raw.expiryDate ? new Date(raw.expiryDate) : null);
  if (d == null) return raw.status || 'active';
  if (d < 0) return 'expired';
  return 'active';
}

function decorate(raw: any) {
  const expiry = raw.expiryDate ? new Date(raw.expiryDate) : null;
  return {
    ...raw,
    status: deriveStatus(raw),
    daysToExpiry: daysUntil(expiry),
  };
}

export async function listLicenses(tenantId: string, opts?: { q?: string }) {
  const where: any = { tenantId };
  if (opts?.q && opts.q.trim()) {
    where.OR = [
      { licenseNo: { contains: opts.q.trim() } },
      { licenseType: { contains: opts.q.trim() } },
      { holder: { contains: opts.q.trim() } },
    ];
  }
  const rows = await db().findMany({ where, orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }] });
  return rows.map(decorate);
}

export async function createLicense(tenantId: string, input: LicenseInput) {
  if (!input.licenseType || !input.licenseNo) {
    throw new Error('证件类型与证件编号为必填');
  }
  const row = await db().create({
    data: {
      tenantId,
      licenseType: input.licenseType,
      licenseCode: input.licenseCode || null,
      licenseNo: input.licenseNo,
      holder: input.holder || null,
      relatedHsCodes: input.relatedHsCodes || null,
      issuingAuthority: input.issuingAuthority || null,
      issueDate: input.issueDate ? new Date(input.issueDate) : null,
      expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
      notes: input.notes || null,
    },
  });
  return decorate(row);
}

export async function updateLicense(tenantId: string, id: string, input: Partial<LicenseInput> & { status?: string }) {
  const existing = await db().findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('证件不存在');
  const data: any = {};
  for (const k of ['licenseType', 'licenseCode', 'licenseNo', 'holder', 'relatedHsCodes', 'issuingAuthority', 'notes', 'status'] as const) {
    if ((input as any)[k] !== undefined) data[k] = (input as any)[k];
  }
  if (input.issueDate !== undefined) data.issueDate = input.issueDate ? new Date(input.issueDate) : null;
  if (input.expiryDate !== undefined) data.expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;
  const row = await db().update({ where: { id }, data });
  return decorate(row);
}

export async function deleteLicense(tenantId: string, id: string) {
  const existing = await db().findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('证件不存在');
  await db().delete({ where: { id } });
  return { deleted: true };
}

// 到期预警：已过期 + 在 withinDays 天内到期
export async function licenseAlerts(tenantId: string, withinDays = 30) {
  const rows = await db().findMany({ where: { tenantId, NOT: { status: 'revoked' } } });
  const decorated = rows.map(decorate).filter((r: any) => r.daysToExpiry != null);
  const expired = decorated.filter((r: any) => r.daysToExpiry < 0)
    .sort((a: any, b: any) => a.daysToExpiry - b.daysToExpiry);
  const expiring = decorated.filter((r: any) => r.daysToExpiry >= 0 && r.daysToExpiry <= withinDays)
    .sort((a: any, b: any) => a.daysToExpiry - b.daysToExpiry);
  return { withinDays, expiredCount: expired.length, expiringCount: expiring.length, expired, expiring };
}
