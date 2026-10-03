/** R46 S5-A —— billing.invoice_issue 受保护写路径 真实 PostgreSQL 验收（MSG-20261002-63 TEST 映射） */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { issueInvoice, type InvoiceIssueDeps } from '../services/billing/invoice-issue';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
/** invoice 独立 approval 白名单（与 fee approval 刻意分离 —— TEST 3/4） */
const INVOICE_ALLOW = new Set<string>();
/** fee approval 白名单：invoice issue 不得接受 */
const FEE_ALLOW = new Set<string>();
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let actor = '';

const deps: InvoiceIssueDeps = {
  prisma,
  verifyApproval: async (r) => INVOICE_ALLOW.has(r.approvalId),
  assertActiveMembership: async (organizationId, userId) => {
    const row = await prisma.membership.findFirst({
      where: { organizationId, userId, isActive: true },
      select: { id: true },
    });
    if (!row) throw new Error('NO_ACTIVE_MEMBERSHIP');
  },
};

async function seedOrg(suffix: string) {
  const id = uuid();
  await prisma.organization.create({
    data: { id, name: 'R46 S5 ' + suffix, slug: 'r46-s5-' + suffix + '-' + uuid().slice(0, 8) },
  });
  const user = await prisma.user.create({
    data: {
      email: 'r46-s5-' + suffix + '-' + uuid().slice(0, 8) + '@example.com',
      passwordHash: hashPassword('r46-s5-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: user.id };
}

async function seedDraftInvoice(
  organizationId: string,
  options: { feeAmount?: string; currency?: string; invoiceCurrency?: string } = {},
) {
  const currency = options.currency ?? 'USD';
  const amount = options.feeAmount ?? '150.0000';
  const claimItemId = (
    await prisma.claimItem.create({
      data: {
        organizationId,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    })
  ).id;
  const kase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'CASE-' + uuid().slice(0, 8),
      title: 'R46 S5 invoice basis',
      domain: 'PLATFORM',
      status: 'OPEN',
      currency,
    },
    select: { id: true, caseNo: true },
  });
  const fee = await prisma.feeCalculation.create({
    data: {
      organizationId,
      caseId: kase.id,
      claimItemId,
      feeChainId: uuid(),
      basis: 'RECOVERED_AMOUNT_PCT',
      rate: '0.15',
      baseAmount: '1000.0000',
      feeAmount: amount,
      currency,
      computation: { algorithmVersion: 'settlement-fee/v1' },
      membershipDigest: 'a'.repeat(64),
      feeBasisVersion: 'v1',
      policyRef: 'policy-2026-01',
    },
    select: { id: true },
  });
  const invoice = await prisma.billingInvoice.create({
    data: {
      organizationId,
      caseId: kase.id,
      invoiceNo: 'BILL-' + kase.caseNo,
      status: 'DRAFT',
      subtotal: amount,
      taxAmount: '0.0000',
      total: amount,
      currency: options.invoiceCurrency ?? currency,
      fees: { connect: { id: fee.id } },
    },
    select: { id: true, invoiceNo: true },
  });
  return { caseId: kase.id, caseNo: kase.caseNo, feeCalculationId: fee.id, invoiceId: invoice.id, invoiceNo: invoice.invoiceNo };
}

function input(over: Record<string, unknown> = {}) {
  const approvalId = uuid();
  INVOICE_ALLOW.add(approvalId);
  return { organizationId: ORG_A, actorUserId: actor, approvalId, ...over };
}

function depsFailingAt(failPoint: 'INVOICE_UPDATE' | 'SUCCESS_AUDIT'): InvoiceIssueDeps {
  const client = new Proxy(prisma as unknown as Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (target.$transaction as (f: (tx: unknown) => Promise<unknown>, ...r: unknown[]) => Promise<unknown>)(
            async (tx: unknown) => {
              const inner = tx as Record<string, unknown>;
              const wrapped = new Proxy(inner, {
                get(d, p, r) {
                  const value = Reflect.get(d, p, r);
                  if (p === 'billingInvoice' && failPoint === 'INVOICE_UPDATE') {
                    return new Proxy(value as Record<string, unknown>, {
                      get(m2, mm, rr) {
                        if (mm === 'update') return async () => {
                          throw new Error('INJECTED_INVOICE_UPDATE_FAILURE');
                        };
                        const fn = Reflect.get(m2, mm, rr);
                        return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(m2) : fn;
                      },
                    });
                  }
                  if (p === 'auditLog') {
                    return new Proxy(value as Record<string, unknown>, {
                      get(m2, mm, rr) {
                        const fn = Reflect.get(m2, mm, rr);
                        if (mm === 'create' && failPoint === 'SUCCESS_AUDIT') {
                          return async (args: { data?: { action?: string } }) => {
                            if (args?.data?.action === 'billing.invoice_issued') {
                              throw new Error('INJECTED_SUCCESS_AUDIT_FAILURE');
                            }
                            return (fn as (a: unknown) => Promise<unknown>).call(m2, args);
                          };
                        }
                        return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(m2) : fn;
                      },
                    });
                  }
                  return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(d) : value;
                },
              });
              return fn(wrapped);
            },
            ...rest,
          );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...deps, prisma: client as never };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  actor = a.userId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R46 S5-A billing.invoice_issue（真实 PostgreSQL）', () => {
  it('TEST 1/3/22/23：DRAFT → ISSUED（canonical basis 落库）；Payment / RecoveryLedger 不变', async () => {
    const seeded = await seedDraftInvoice(ORG_A);
    const r = await issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never);
    expect(r.status).toBe('ISSUED');
    expect(r.invoiceBasisDigest).toMatch(/^[0-9a-f]{64}$/);
    const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { id: seeded.invoiceId } });
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.issuedAt).not.toBeNull();
    expect(invoice.invoiceBasisDigest).toBe(r.invoiceBasisDigest);
    expect(invoice.invoiceBasisVersion).toBe('invoice-basis/v1');
    expect(invoice.customerAccountIdentity).toBe(seeded.caseNo);
    const fee = await prisma.feeCalculation.findFirstOrThrow({ where: { id: seeded.feeCalculationId } });
    expect(String(fee.feeAmount)).toBe('150');
    expect(fee.membershipDigest).toBe('a'.repeat(64));
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('TEST 2/3/4：客户端自证字段拒绝；无 approval → APPROVAL_REQUIRED；fee approval 不能执行 invoice issue', async () => {
    const seeded = await seedDraftInvoice(ORG_A);
    await expect(
      issueInvoice(
        deps,
        input({
          feeCalculationId: seeded.feeCalculationId,
          clientFields: {
            invoiceBasisDigest: 'f'.repeat(64),
            invoiceTotal: '0.0000',
            currency: 'EUR',
            customerAccountIdentity: 'evil',
            policyRef: 'evil',
            feeBasisVersion: 'v9',
          },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_INVOICE_FIELDS_NOT_TRUSTED' });
    await expect(
      issueInvoice(deps, {
        organizationId: ORG_A,
        actorUserId: actor,
        approvalId: uuid(),
        feeCalculationId: seeded.feeCalculationId,
      } as never),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const feeApproval = uuid();
    FEE_ALLOW.add(feeApproval);
    await expect(
      issueInvoice(deps, {
        organizationId: ORG_A,
        actorUserId: actor,
        approvalId: feeApproval,
        feeCalculationId: seeded.feeCalculationId,
      } as never),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { id: seeded.invoiceId } });
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.invoiceBasisDigest).toBeNull();
  });

  it('TEST 5/6/7/8：approval 后 policy/amount 漂移 → APPROVAL_REQUIRED 且不新增 invoice identity', async () => {
    const boundDigest = new Map<string, string>();
    const tofu: InvoiceIssueDeps = {
      ...deps,
      verifyApproval: async (r) => {
        const digest = r.boundExtra.invoiceBasisDigest ?? '';
        const prior = boundDigest.get(r.approvalId);
        if (prior === undefined) {
          boundDigest.set(r.approvalId, digest);
          return true;
        }
        return prior === digest;
      },
    };
    const seeded = await seedDraftInvoice(ORG_A);
    const approvalId = uuid();
    const payload = { organizationId: ORG_A, actorUserId: actor, approvalId, feeCalculationId: seeded.feeCalculationId };
    const first = await issueInvoice(tofu, payload as never);
    expect(first.status).toBe('ISSUED');
    await prisma.feeCalculation.update({ where: { id: seeded.feeCalculationId }, data: { policyRef: 'policy-2026-02' } });
    await expect(issueInvoice(tofu, payload as never)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { id: seeded.invoiceId } });
    expect(invoice.invoiceBasisDigest).toBe(first.invoiceBasisDigest);
    expect(
      await prisma.billingInvoice.count({ where: { organizationId: ORG_A, invoiceBasisDigest: first.invoiceBasisDigest } }),
    ).toBe(1);
  });

  it('TEST 9/10：exact replay → 同一 invoice / REUSED；VOID 不释放 basis identity', async () => {
    const seeded = await seedDraftInvoice(ORG_A);
    const first = await issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never);
    expect(first.status).toBe('ISSUED');
    const replay = await issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never);
    expect(replay.status).toBe('REUSED');
    expect(replay.invoiceId).toBe(first.invoiceId);
    await prisma.billingInvoice.update({ where: { id: first.invoiceId }, data: { status: 'VOID' } });
    const afterVoid = await issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never);
    expect(afterVoid.status).toBe('REUSED');
    expect(afterVoid.invoiceId).toBe(first.invoiceId);
    expect(
      await prisma.billingInvoice.count({ where: { organizationId: ORG_A, invoiceBasisDigest: first.invoiceBasisDigest } }),
    ).toBe(1);
  });

  it('TEST 11/12：同 basis 并发 issue → at most one identity；loser 稳定领域错误', async () => {
    const seeded = await seedDraftInvoice(ORG_A);
    const results = await Promise.allSettled([
      issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never),
      issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never),
    ]);
    for (const f of results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]) {
      expect(['INVOICE_BASIS_CONFLICT', 'APPROVAL_ALREADY_CONSUMED']).toContain((f.reason as { code?: string })?.code);
      expect(String(f.reason)).not.toMatch(/P2002|Unique constraint/);
    }
    const invoice = await prisma.billingInvoice.findMany({
      where: { organizationId: ORG_A, id: seeded.invoiceId },
      select: { status: true, invoiceBasisDigest: true },
    });
    expect(invoice).toHaveLength(1);
    expect(invoice[0].status).toBe('ISSUED');
    expect(
      await prisma.billingInvoice.count({ where: { organizationId: ORG_A, invoiceBasisDigest: invoice[0].invoiceBasisDigest } }),
    ).toBe(1);
  });

  it('TEST 13：same approval + 两个不同 execution 并发 → exactly once，loser APPROVAL_ALREADY_CONSUMED', async () => {
    const a = await seedDraftInvoice(ORG_A);
    const b = await seedDraftInvoice(ORG_A);
    const approvalId = uuid();
    INVOICE_ALLOW.add(approvalId);
    const results = await Promise.allSettled([
      issueInvoice(deps, { organizationId: ORG_A, actorUserId: actor, approvalId, feeCalculationId: a.feeCalculationId } as never),
      issueInvoice(deps, { organizationId: ORG_A, actorUserId: actor, approvalId, feeCalculationId: b.feeCalculationId } as never),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const f of results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]) {
      expect((f.reason as { code?: string })?.code).toBe('APPROVAL_ALREADY_CONSUMED');
      expect(String(f.reason)).not.toMatch(/P2002|Unique constraint/);
    }
    expect(await prisma.auditLog.count({ where: { id: 'invoice-issue-approval-' + approvalId } })).toBe(1);
    const statuses = await prisma.billingInvoice.findMany({
      where: { id: { in: [a.invoiceId, b.invoiceId] } },
      select: { status: true, invoiceBasisDigest: true },
    });
    expect(statuses.filter((s) => s.status === 'ISSUED')).toHaveLength(1);
    expect(statuses.filter((s) => s.status === 'DRAFT' && s.invoiceBasisDigest === null)).toHaveLength(1);
  });

  it('TEST 14/15/16：post-link mutation / issued content mutation / invalid transition / basis identity → DB 拒绝', async () => {
    const seeded = await seedDraftInvoice(ORG_A);
    await issueInvoice(deps, input({ feeCalculationId: seeded.feeCalculationId }) as never);
    await expect(
      prisma.feeCalculation.update({ where: { id: seeded.feeCalculationId }, data: { billingInvoiceId: null } }),
    ).rejects.toThrow(/FEE_INVOICE_LINK_IMMUTABLE/);
    await expect(
      prisma.$executeRawUnsafe('UPDATE "BillingInvoice" SET "total" = 1.0000 WHERE "id" = $1', seeded.invoiceId),
    ).rejects.toThrow(/INVOICE_CONTENT_IMMUTABLE_AFTER_ISSUE/);
    await expect(
      prisma.feeCalculation.update({ where: { id: seeded.feeCalculationId }, data: { feeAmount: '999.0000' } }),
    ).rejects.toThrow(/FEE_CALCULATION_IMMUTABLE_AFTER_ISSUE/);
    await expect(
      prisma.billingInvoice.update({ where: { id: seeded.invoiceId }, data: { invoiceBasisDigest: 'b'.repeat(64) } }),
    ).rejects.toThrow(/INVOICE_BASIS_IDENTITY_IMMUTABLE/);
    const draft = await seedDraftInvoice(ORG_A);
    await expect(
      prisma.$executeRawUnsafe('UPDATE "BillingInvoice" SET "status" = \'PAID\' WHERE "id" = $1', draft.invoiceId),
    ).rejects.toThrow(/INVALID_INVOICE_STATUS_TRANSITION/);
  });

  it('TEST 17/18/19：invoice currency != fee currency → DB 拒绝 INVOICE_CURRENCY_MISMATCH；多费聚合 → fail-closed', async () => {
    const base = await seedDraftInvoice(ORG_A);
    const eurClaim = await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    });
    const eurFee = await prisma.feeCalculation.create({
      data: {
        organizationId: ORG_A,
        caseId: base.caseId,
        claimItemId: eurClaim.id,
        feeChainId: uuid(),
        basis: 'RECOVERED_AMOUNT_PCT',
        rate: '0.15',
        baseAmount: '1000.0000',
        feeAmount: '150.0000',
        currency: 'EUR',
        computation: { algorithmVersion: 'settlement-fee/v1' },
        membershipDigest: 'd'.repeat(64),
        feeBasisVersion: 'v1',
        policyRef: 'policy-2026-01',
      },
      select: { id: true },
    });
    await expect(
      prisma.billingInvoice.update({ where: { id: base.invoiceId }, data: { fees: { connect: { id: eurFee.id } } } }),
    ).rejects.toThrow(/INVOICE_CURRENCY_MISMATCH/);
    const extraClaim = await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    });
    const extraFee = await prisma.feeCalculation.create({
      data: {
        organizationId: ORG_A,
        caseId: base.caseId,
        claimItemId: extraClaim.id,
        feeChainId: uuid(),
        basis: 'RECOVERED_AMOUNT_PCT',
        rate: '0.15',
        baseAmount: '1000.0000',
        feeAmount: '150.0000',
        currency: 'USD',
        computation: { algorithmVersion: 'settlement-fee/v1' },
        membershipDigest: 'b'.repeat(64),
        feeBasisVersion: 'v1',
        policyRef: 'policy-2026-01',
      },
      select: { id: true },
    });
    await expect(
      prisma.billingInvoice.update({ where: { id: base.invoiceId }, data: { fees: { connect: { id: extraFee.id } } } }),
    ).rejects.toThrow(/Unique constraint|FeeCalculation_org_invoice_key/);
  });

  it('TEST 20：invoice 写入失败 / success audit 失败 → approval consumption 与 ISSUED 全部 rollback', async () => {
    for (const failPoint of ['INVOICE_UPDATE', 'SUCCESS_AUDIT'] as const) {
      const seeded = await seedDraftInvoice(ORG_A);
      const approvalId = uuid();
      INVOICE_ALLOW.add(approvalId);
      await expect(
        issueInvoice(depsFailingAt(failPoint), {
          organizationId: ORG_A,
          actorUserId: actor,
          approvalId,
          feeCalculationId: seeded.feeCalculationId,
        } as never),
      ).rejects.toThrow(/INJECTED_/);
      const invoice = await prisma.billingInvoice.findFirstOrThrow({ where: { id: seeded.invoiceId } });
      expect(invoice.status).toBe('DRAFT');
      expect(invoice.invoiceBasisDigest).toBeNull();
      expect(await prisma.auditLog.count({ where: { id: 'invoice-issue-approval-' + approvalId } })).toBe(0);
      expect(
        await prisma.auditLog.count({
          where: { organizationId: ORG_A, action: 'billing.invoice_issued', entityId: seeded.invoiceId },
        }),
      ).toBe(0);
    }
  });

  it('TEST 21/12：跨租户 fee → CROSS_TENANT_REFERENCE；无 case → INVALID_INPUT；无 DRAFT → INVOICE_DRAFT_REQUIRED', async () => {
    const foreign = await seedDraftInvoice(ORG_B);
    await expect(issueInvoice(deps, input({ feeCalculationId: foreign.feeCalculationId }) as never)).rejects.toMatchObject({
      code: 'CROSS_TENANT_REFERENCE',
    });
    const orphanClaim = await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    });
    const orphanFee = await prisma.feeCalculation.create({
      data: {
        organizationId: ORG_A,
        caseId: null,
        claimItemId: orphanClaim.id,
        feeChainId: uuid(),
        basis: 'RECOVERED_AMOUNT_PCT',
        rate: '0.15',
        baseAmount: '1000.0000',
        feeAmount: '150.0000',
        currency: 'USD',
        computation: { algorithmVersion: 'settlement-fee/v1' },
        membershipDigest: 'c'.repeat(64),
        feeBasisVersion: 'v1',
        policyRef: 'policy-2026-01',
      },
      select: { id: true },
    });
    await expect(issueInvoice(deps, input({ feeCalculationId: orphanFee.id }) as never)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const unlinkedClaim = await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    });
    const seededCase = await seedDraftInvoice(ORG_A);
    const unlinked = await prisma.feeCalculation.create({
      data: {
        organizationId: ORG_A,
        caseId: seededCase.caseId,
        claimItemId: unlinkedClaim.id,
        feeChainId: uuid(),
        basis: 'RECOVERED_AMOUNT_PCT',
        rate: '0.15',
        baseAmount: '1000.0000',
        feeAmount: '150.0000',
        currency: 'USD',
        computation: { algorithmVersion: 'settlement-fee/v1' },
        membershipDigest: 'e'.repeat(64),
        feeBasisVersion: 'v1',
        policyRef: 'policy-2026-01',
      },
      select: { id: true },
    });
    await expect(issueInvoice(deps, input({ feeCalculationId: unlinked.id }) as never)).rejects.toMatchObject({
      code: 'INVOICE_DRAFT_REQUIRED',
    });
  });
});
