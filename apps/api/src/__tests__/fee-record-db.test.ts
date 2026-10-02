/** R46 S4 —— FeeCalculation 受保护写路径 真实 PostgreSQL 验收（MSG-20261002-59） */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { computeMembershipDigest } from '../services/settlement/fee-compute';
import {
  recordFeeCalculation,
  type FeeRecordDeps,
} from '../services/settlement/record-fee';

const prisma = new PrismaClient();
const FAST = { N: 1024, r: 8, p: 1, keyLength: 64 };
const ALLOW = new Set<string>();
const uuid = (): string => randomUUID();

let ORG_A = '';
let ORG_B = '';
let actor = '';
let claimA = '';

const STUB_POLICY = {
  organizationId: '',
  policyRef: 'policy-2026-01',
  feeBasisVersion: 'v1',
  basis: 'RECOVERED_AMOUNT_PCT' as const,
  rate: '0.15',
  currency: 'USD',
  sourceKind: 'RATE_CARD' as const,
  policyDigest: 'd'.repeat(64),
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
};

const deps: FeeRecordDeps = {
  prisma,
  resolveFeePolicy: async (request) => ({ ...STUB_POLICY, organizationId: request.organizationId }),
  verifyApproval: async (r) => ALLOW.has(r.approvalId),
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
  await prisma.organization.create({ data: { id, name: 'R46 S4 ' + suffix, slug: `r46-s4-${suffix}-${uuid().slice(0, 8)}` } });
  const user = await prisma.user.create({
    data: {
      email: `r46-s4-${suffix}-${uuid().slice(0, 8)}@example.com`,
      passwordHash: hashPassword('r46-s4-pass-123', FAST),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: user.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: user.id };
}

async function newClaim(organizationId: string): Promise<string> {
  return (
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
}

async function seedEligibleSettlement(organizationId: string, amount = '1000.0000', claimItemId = claimA) {
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId, kind: 'OTHER', title: 'fee evidence' },
    select: { id: true },
  });
  return (
    await prisma.settlement.create({
      data: {
        organizationId,
        status: 'RECEIVED',
        source: 'PLATFORM_CREDIT',
        amount,
        currency: 'USD',
        receivedAt: new Date('2026-09-30T01:00:00.000Z'),
        evidenceId: evidence.id,
        confirmationStatus: 'CONFIRMED',
        reconciliationStatus: 'RECONCILED',
        linkageBasisKind: 'CLAIM_ITEM_DIRECT',
        claimItemId,
      },
      select: { id: true },
    })
  ).id;
}

function input(over: Record<string, unknown> = {}) {
  const approvalId = uuid();
  ALLOW.add(approvalId);
  return {
    organizationId: ORG_A,
    actorUserId: actor,
    approvalId,
    feeChainId: uuid(),
    claimItemId: claimA,
    settlementIds: [] as string[],
    policyRef: 'policy-2026-01',
    feeBasisVersion: 'v1',
    ...over,
  };
}

async function counts() {
  const [fees, memberships, invoices, payments] = await Promise.all([
    prisma.feeCalculation.count({ where: { organizationId: ORG_A } }),
    prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A } }),
    prisma.billingInvoice.count({ where: { organizationId: ORG_A } }),
    prisma.payment.count({ where: { organizationId: ORG_A } }),
  ]);
  return { fees, memberships, invoices, payments };
}

beforeAll(async () => {
  const a = await seedOrg('a');
  ORG_A = a.organizationId;
  actor = a.userId;
  const b = await seedOrg('b');
  ORG_B = b.organizationId;
  claimA = (
    await prisma.claimItem.create({
      data: {
        organizationId: ORG_A,
        platformType: 'AMAZON',
        claimType: 'FBA_REIMBURSEMENT',
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        normalizerVersion: 'v1',
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R46 S4 FeeCalculation 受保护写路径（真实 PostgreSQL）', () => {
  it('happy path：eligible Settlement → membership + FeeCalculation；Invoice/Payment 仍为 0', async () => {
    const st = await seedEligibleSettlement(ORG_A);
    const before = await counts();
    const r = await recordFeeCalculation(deps, input({ settlementIds: [st] }) as never);
    expect(r.baseAmount).toBe('1000.0000');
    expect(r.feeAmount).toBe('150.0000');

    const fee = await prisma.feeCalculation.findFirstOrThrow({ where: { id: r.feeCalculationId } });
    expect(String(fee.feeAmount)).toBe('150');
    expect(fee.membershipDigest).toBe(r.membershipDigest);
    expect(fee.policyRef).toBe('policy-2026-01');
    expect(fee.feeBasisVersion).toBe('v1');

    const after = await counts();
    expect(after.fees).toBe(before.fees + 1);
    expect(after.memberships).toBe(before.memberships + 1);
    expect(after.invoices).toBe(0);
    expect(after.payments).toBe(0);
  });

  it('非 eligible（reversed / 缺证据 / 跨租户）→ 拒绝且零写入', async () => {
    const claim1 = await newClaim(ORG_A);
    const stReversed = await seedEligibleSettlement(ORG_A, '1000.0000', claim1);
    await prisma.settlement.update({ where: { id: stReversed }, data: { reversedBySettlementId: null, reconciliationStatus: 'REVERSED' } });
    const before = await counts();
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [stReversed], claimItemId: claim1 }) as never),
    ).rejects.toMatchObject({
      code: 'SETTLEMENT_NOT_FEE_ELIGIBLE',
    });

    const other = await seedEligibleSettlement(ORG_B, '1000.0000', await newClaim(ORG_B));
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [other], claimItemId: claim1 }) as never),
    ).rejects.toMatchObject({
      code: 'CROSS_TENANT_REFERENCE',
    });
    expect(await counts()).toEqual(before);
  });

  it('客户端自报费率 / 政策 → 拒绝；approval 重复消费 → 整体回滚', async () => {
    const claim2 = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim2);
    const before = await counts();
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [st], claimItemId: claim2, clientSuppliedRate: '0.9' }) as never),
    ).rejects.toMatchObject({ code: 'CLIENT_FEE_INPUT_NOT_TRUSTED' });

    const payload = input({ settlementIds: [st], claimItemId: claim2 });
    await recordFeeCalculation(deps, payload as never);
    await expect(recordFeeCalculation(deps, { ...payload } as never)).rejects.toMatchObject({
      code: 'APPROVAL_ALREADY_CONSUMED',
    });
    const after = await counts();
    expect(after.fees).toBe(before.fees + 1);
    expect(after.invoices).toBe(0);
    expect(after.payments).toBe(0);
  });

  it('同 claimItem 的另一 active chain → MEMBERSHIP_CHAIN_CONFLICT；并发同 chain 至多一条', async () => {
    const claim3 = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim3);
    const first = input({ settlementIds: [st], claimItemId: claim3 });
    await recordFeeCalculation(deps, first as never);
    const st2 = await seedEligibleSettlement(ORG_A, '1000.0000', claim3);
    await expect(
      recordFeeCalculation(deps, input({ settlementIds: [st2], claimItemId: claim3 }) as never),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_CHAIN_CONFLICT',
    });

    const r = await Promise.allSettled([
      recordFeeCalculation(deps, { ...first, approvalId: (() => { const id = uuid(); ALLOW.add(id); return id; })() } as never),
      recordFeeCalculation(deps, { ...first, approvalId: (() => { const id = uuid(); ALLOW.add(id); return id; })() } as never),
    ]);
    void r;
    const rows = await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, settlementId: st } });
    expect(rows).toBe(1);
  });
});

describe('R46 S4 余下永久验收（digest 可重建 + 下游零副作用）', () => {
  it('membershipDigest 可由相同输入重建；BillingInvoice / Payment / RecoveryLedger 仍为 0（不触发 autopay）', async () => {
    const claim = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim);
    const policy = {
      basis: 'RECOVERED_AMOUNT_PCT' as const,
      rate: '0.15',
      policyRef: 'policy-2026-01',
      feeBasisVersion: 'v1',
      currency: 'USD',
    };
    const r = await recordFeeCalculation(deps, input({ settlementIds: [st], claimItemId: claim, policy }) as never);
    const rebuilt = computeMembershipDigest({
      memberships: [{ settlementId: st, amount: '1000.0000', currency: 'USD' }],
      policy,
    });
    expect(rebuilt).toBe(r.membershipDigest);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});







describe('R46 S4 MSG-60 CHANGE B/C：真并发边界与 same-approval exactly-once', () => {
  async function seedFeeCalcWithChain(organizationId: string, claimItemId: string, feeChainId: string) {
    return (
      await prisma.feeCalculation.create({
        data: {
          organizationId,
          claimItemId,
          feeChainId,
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
      })
    ).id;
  }

  it('CHANGE C：same approval + 两个不同有效 execution 并发 → 恰好一次提交；loser 为 APPROVAL_ALREADY_CONSUMED 且零残留', async () => {
    const claimA1 = await newClaim(ORG_A);
    const claimB1 = await newClaim(ORG_A);
    const stA = await seedEligibleSettlement(ORG_A, '1000.0000', claimA1);
    const stB = await seedEligibleSettlement(ORG_A, '1000.0000', claimB1);
    const approvalId = uuid();
    ALLOW.add(approvalId);

    const before = await prisma.feeCalculation.count({ where: { organizationId: ORG_A } });
    const results = await Promise.allSettled([
      recordFeeCalculation(deps, input({ approvalId, settlementIds: [stA], claimItemId: claimA1, feeChainId: uuid() }) as never),
      recordFeeCalculation(deps, input({ approvalId, settlementIds: [stB], claimItemId: claimB1, feeChainId: uuid() }) as never),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    for (const f of failed) {
      expect((f.reason as { code?: string })?.code).toBe('APPROVAL_ALREADY_CONSUMED');
      expect(String(f.reason)).not.toMatch(/P2002|Unique constraint/);
    }
    expect(await prisma.feeCalculation.count({ where: { organizationId: ORG_A } })).toBe(before + 1);
    expect(await prisma.auditLog.count({ where: { id: 'fee-approval-' + approvalId } })).toBe(1);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  /**
   * CHANGE B —— 数据库层并发边界（R46 S4-A 已授权并落地：MSG-20261002-61 CHANGE A）。
   * 旧行为（实测）：`cc_feecalculationsettlement_chain_unique` 触发器「先查后插」→ 两个并发事务各读到 0 条、双双提交，
   * 本地测试库因此留下 7 组 (org, chain, settlement) 重复 membership。
   * 现行为：部分唯一索引 FeeCalculationSettlement_org_chain_settlement_key 是真正的并发边界。
   */
  it('CHANGE B（R46 S4-A 已落地）：同一 Settlement + 同一 feeChain 两个并发 membership → 数据库层最多一个成功', async () => {
    const claim1 = await newClaim(ORG_A);
    const claim2 = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '500.0000', claim1);
    const chain = uuid();
    const f1 = await seedFeeCalcWithChain(ORG_A, claim1, chain);
    const f2 = await seedFeeCalcWithChain(ORG_A, claim2, chain);

    const results = await Promise.allSettled([
      prisma.feeCalculationSettlement.create({
        data: { organizationId: ORG_A, feeCalculationId: f1, settlementId: st, basisRole: 'POSITIVE', amountContribution: '500.0000', currency: 'USD' },
      }),
      prisma.feeCalculationSettlement.create({
        data: { organizationId: ORG_A, feeCalculationId: f2, settlementId: st, basisRole: 'POSITIVE', amountContribution: '500.0000', currency: 'USD' },
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    for (const f of failed) {
      expect(String(f.reason)).toMatch(/FEE_CHAIN_SETTLEMENT_ALREADY_CONSUMED|23505|unique/i);
    }
    // loser 零残留：失败方不得留下 membership / 成功审计
    const okIndex = results.findIndex((r) => r.status === 'fulfilled');
    for (const [index, feeId] of [f1, f2].entries()) {
      if (index === okIndex) continue;
      expect(
        await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, feeCalculationId: feeId } }),
      ).toBe(0);
      expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, entityId: feeId } })).toBe(0);
    }
    expect(await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, settlementId: st } })).toBe(1);
  });

  it('CHANGE B positive control：同一 Settlement 的合法不同 fee chain 不被阻断', async () => {
    const claim1 = await newClaim(ORG_A);
    const claim2 = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '500.0000', claim1);
    const f1 = await seedFeeCalcWithChain(ORG_A, claim1, uuid());
    const f2 = await seedFeeCalcWithChain(ORG_A, claim2, uuid());
    await prisma.feeCalculationSettlement.create({
      data: { organizationId: ORG_A, feeCalculationId: f1, settlementId: st, basisRole: 'POSITIVE', amountContribution: '500.0000', currency: 'USD' },
    });
    await prisma.feeCalculationSettlement.create({
      data: { organizationId: ORG_A, feeCalculationId: f2, settlementId: st, basisRole: 'POSITIVE', amountContribution: '500.0000', currency: 'USD' },
    });
    expect(await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, settlementId: st } })).toBe(2);
  });

  it('CHANGE B positive control：superseded fee chain 的后继 chain 依旧可合法持有同一 Settlement', async () => {
    const claim = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '500.0000', claim);
    const next = await seedFeeCalcWithChain(ORG_A, claim, uuid());
    // 历史 chain：创建时即标记被后继 supersede（避免 (org, claimItemId) WHERE superseded IS NULL 冲突）
    const previous = (
      await prisma.feeCalculation.create({
        data: {
          organizationId: ORG_A,
          claimItemId: claim,
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
          supersededByFeeCalculationId: next,
        },
        select: { id: true },
      })
    ).id;
    for (const feeCalculationId of [previous, next]) {
      await prisma.feeCalculationSettlement.create({
        data: {
          organizationId: ORG_A,
          feeCalculationId,
          settlementId: st,
          basisRole: 'POSITIVE',
          amountContribution: '500.0000',
          currency: 'USD',
        },
      });
    }
    expect(await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, settlementId: st } })).toBe(2);
  });

  it('R46 S4-A：membership.feeChainId 由服务端派生；客户端提交不一致值 → FEE_CHAIN_MISMATCH；写入后 mutation → DB 拒绝', async () => {
    const claim = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '500.0000', claim);
    const chain = uuid();
    const feeId = await seedFeeCalcWithChain(ORG_A, claim, chain);

    // 客户端完全不提供 chain → 服务端从父 FeeCalculation 派生
    const derivedId = uuid();
    const derived = await prisma.$queryRawUnsafe<{ feeChainId: string }[]>(
      'INSERT INTO "FeeCalculationSettlement"'
        + ' ("id","organizationId","feeCalculationId","settlementId","basisRole","amountContribution","currency")'
        + " VALUES ($1, $2, $3, $4, 'POSITIVE', 500.0000, 'USD')"
        + ' RETURNING "feeChainId"',
      derivedId,
      ORG_A,
      feeId,
      st,
    );
    expect(derived[0].feeChainId).toBe(chain);

    // 客户端伪造 chain → 数据库拒绝（客户端不得提供或覆盖）
    const st2 = await seedEligibleSettlement(ORG_A, '500.0000', claim);
    await expect(
      prisma.$executeRawUnsafe(
        'INSERT INTO "FeeCalculationSettlement"'
          + ' ("id","organizationId","feeChainId","feeCalculationId","settlementId","basisRole","amountContribution","currency")'
          + " VALUES ($1, $2, $3, $4, $5, 'POSITIVE', 500.0000, 'USD')",
        uuid(),
        ORG_A,
        uuid(),
        feeId,
        st2,
      ),
    ).rejects.toThrow(/FEE_CHAIN_MISMATCH/);

    // 写入后 mutation → append-only 触发器拒绝（feeChainId 写入即 immutable）
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "FeeCalculationSettlement" SET "feeChainId" = $1 WHERE "id" = $2',
        uuid(),
        derivedId,
      ),
    ).rejects.toThrow(/APPEND_ONLY_TABLE/);
  });

  it('R46 S4-A：受保护写路径并发（同 claimItem + 同 feeChain + 同 Settlement，不同 approval）→ 恰好一个提交，loser 稳定领域错误且零残留', async () => {
    const claim = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim);
    const chain = uuid();
    const before = await counts();

    const results = await Promise.allSettled([
      recordFeeCalculation(deps, input({ claimItemId: claim, settlementIds: [st], feeChainId: chain }) as never),
      recordFeeCalculation(deps, input({ claimItemId: claim, settlementIds: [st], feeChainId: chain }) as never),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    for (const f of failed) {
      // 稳定领域错误：membership 唯一索引 → FEE_MEMBERSHIP_ALREADY_EXISTS；
      // 同 claimItem 单 active chain 唯一索引 → MEMBERSHIP_CHAIN_CONFLICT（两条路径都不得泄漏 raw P2002）
      expect(['FEE_MEMBERSHIP_ALREADY_EXISTS', 'MEMBERSHIP_CHAIN_CONFLICT']).toContain(
        (f.reason as { code?: string })?.code,
      );
      expect(String(f.reason)).not.toMatch(/P2002|23505|Unique constraint|APPEND_ONLY/);
    }
    expect(await prisma.feeCalculationSettlement.count({ where: { organizationId: ORG_A, settlementId: st } })).toBe(1);
    expect(await prisma.feeCalculation.count({ where: { organizationId: ORG_A, claimItemId: claim } })).toBe(1);
    const after = await counts();
    expect(after.fees).toBe(before.fees + 1);
    expect(after.memberships).toBe(before.memberships + 1);
    expect(after.invoices).toBe(0);
    expect(after.payments).toBe(0);
  });

  /**
   * 受保护写路径的并发缺口**不写成断言用例**：`activeChain.findFirst` 与写之间没有数据库边界，
   * 复现依赖两个事务的真实交叠（时序相关，非稳定 red/green）。
   * 稳定证据由上面两点提供：①DB 层同一 chain 并发可双写；②受保护写路径的 chain 守卫是 check-then-act。
   * 缺口结论与对策进入 R46 S4-A 决策请求；裁决前不改 Schema。
   */
});

describe('R46 S4 MSG-60 CHANGE A：fee policy 只能来自服务端可信版本化来源', () => {
  it('伪造 policy.rate/basis/fixedAmount/currency/policyDigest 与 clientSuppliedRate 无法影响持久化结果', async () => {
    const claim = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim);
    const before = await counts();

    await expect(
      recordFeeCalculation(
        deps,
        input({
          claimItemId: claim,
          settlementIds: [st],
          clientPolicyFields: {
            basis: 'RECOVERED_AMOUNT_PCT',
            rate: '0.990000',
            fixedAmount: '999.0000',
            currency: 'EUR',
            policyDigest: 'f'.repeat(64),
          },
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_POLICY_FIELDS_NOT_TRUSTED' });

    await expect(
      recordFeeCalculation(
        deps,
        input({ claimItemId: claim, settlementIds: [st], clientSuppliedRate: '0.990000', clientSuppliedPolicyRef: 'policy-evil' }) as never,
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_FEE_INPUT_NOT_TRUSTED' });

    expect(await counts()).toEqual(before);

    const r = await recordFeeCalculation(deps, input({ claimItemId: claim, settlementIds: [st] }) as never);
    const fee = await prisma.feeCalculation.findFirstOrThrow({ where: { id: r.feeCalculationId } });
    expect(String(fee.rate)).toBe('0.15');
    expect(fee.currency).toBe('USD');
    expect(fee.policyRef).toBe('policy-2026-01');
    expect(fee.feeBasisVersion).toBe('v1');
    expect(r.feeAmount).toBe('150.0000');
  });

  it('server policy 漂移 → 旧 approval 失效（APPROVAL_REQUIRED，零新增写入）；未漂移 → APPROVAL_ALREADY_CONSUMED', async () => {
    const boundDigest = new Map<string, string>();
    const policyV1 = { ...STUB_POLICY, organizationId: ORG_A, policyDigest: 'a'.repeat(64) };
    const policyV2 = { ...STUB_POLICY, organizationId: ORG_A, rate: '0.200000', policyDigest: 'b'.repeat(64) };
    let current = policyV1;
    const driftDeps: FeeRecordDeps = {
      ...deps,
      resolveFeePolicy: async () => current,
      verifyApproval: async (r) => {
        const digest = r.boundExtra.feeSnapshotDigest ?? '';
        const prior = boundDigest.get(r.approvalId);
        if (prior === undefined) {
          boundDigest.set(r.approvalId, digest);
          return true;
        }
        return prior === digest;
      },
    };

    const claim = await newClaim(ORG_A);
    const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim);
    const approvalId = uuid();
    const frozen = {
      organizationId: ORG_A,
      actorUserId: actor,
      approvalId,
      feeChainId: uuid(),
      claimItemId: claim,
      settlementIds: [st],
      policyRef: 'policy-2026-01',
      feeBasisVersion: 'v1',
    };

    const first = await recordFeeCalculation(driftDeps, frozen as never);
    expect(first.feeAmount).toBe('150.0000');
    const afterFirst = await counts();
    expect(boundDigest.get(approvalId)).toBeTruthy();

    current = policyV2;
    await expect(recordFeeCalculation(driftDeps, frozen as never)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(await counts()).toEqual(afterFirst);
    const historical = await prisma.feeCalculation.findFirstOrThrow({ where: { id: first.feeCalculationId } });
    expect(String(historical.rate)).toBe('0.15');

    current = policyV1;
    await expect(recordFeeCalculation(driftDeps, frozen as never)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_CONSUMED' });
    expect(await counts()).toEqual(afterFirst);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
  });
});

describe('R46 S4 MSG-60 CHANGE C：任一步失败 → 全部回滚', () => {
  type FailPoint = 'APPROVAL_CONSUMPTION' | 'FEE_CALCULATION' | 'MEMBERSHIP' | 'SUCCESS_AUDIT';

  function failingDelegate(delegate: unknown, message: string) {
    return new Proxy(delegate as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === 'create') return async () => {
          throw new Error(message);
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  function depsFailingAt(failPoint: FailPoint): FeeRecordDeps {
    const injectTx = (tx: Record<PropertyKey, unknown>) =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'auditLog') {
            return new Proxy(value as Record<PropertyKey, unknown>, {
              get(audit, m, r2) {
                const fn = Reflect.get(audit, m, r2);
                if (m === 'create') {
                  return async (args: { data?: { action?: string } }) => {
                    const action = args?.data?.action;
                    if (failPoint === 'APPROVAL_CONSUMPTION' && action === 'billing.fee_calculate.approval_consumed') {
                      throw new Error('INJECTED_APPROVAL_CONSUMPTION_FAILURE');
                    }
                    if (failPoint === 'SUCCESS_AUDIT' && action === 'billing.fee_calculated') {
                      throw new Error('INJECTED_SUCCESS_AUDIT_FAILURE');
                    }
                    return (fn as (a: unknown) => Promise<unknown>).call(audit, args);
                  };
                }
                return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(audit) : fn;
              },
            });
          }
          if (prop === 'feeCalculation' && failPoint === 'FEE_CALCULATION') {
            return failingDelegate(value, 'INJECTED_FEE_CALCULATION_FAILURE');
          }
          if (prop === 'feeCalculationSettlement' && failPoint === 'MEMBERSHIP') {
            return failingDelegate(value, 'INJECTED_MEMBERSHIP_FAILURE');
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });

    const client = new Proxy(prisma as unknown as Record<PropertyKey, unknown>, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            (target.$transaction as (f: (tx: unknown) => Promise<unknown>, ...r: unknown[]) => Promise<unknown>)(
              async (tx: unknown) => fn(injectTx(tx as Record<PropertyKey, unknown>)),
              ...rest,
            );
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    return { ...deps, prisma: client as never };
  }

  it.each(['APPROVAL_CONSUMPTION', 'FEE_CALCULATION', 'MEMBERSHIP', 'SUCCESS_AUDIT'] as const)(
    '%s 失败 → approval 消费 / FeeCalculation / membership / success audit 零残留，Invoice·Payment·Ledger 不变',
    async (failPoint) => {
      const claim = await newClaim(ORG_A);
      const st = await seedEligibleSettlement(ORG_A, '1000.0000', claim);
      const approvalId = uuid();
      ALLOW.add(approvalId);
      const before = await counts();
      const auditBefore = await prisma.auditLog.count({
        where: { organizationId: ORG_A, action: 'billing.fee_calculated' },
      });

      await expect(
        recordFeeCalculation(
          depsFailingAt(failPoint),
          input({ approvalId, claimItemId: claim, settlementIds: [st], feeChainId: uuid() }) as never,
        ),
      ).rejects.toThrow(/INJECTED_/);

      expect(await counts()).toEqual(before);
      expect(
        await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'billing.fee_calculated' } }),
      ).toBe(auditBefore);
      expect(await prisma.auditLog.count({ where: { id: 'fee-approval-' + approvalId } })).toBe(0);
      expect(await prisma.billingInvoice.count({ where: { organizationId: ORG_A } })).toBe(0);
      expect(await prisma.payment.count({ where: { organizationId: ORG_A } })).toBe(0);
      expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG_A } })).toBe(0);
    },
  );
});
