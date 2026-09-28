/**
 * Recovery Closure（C-0004 Checkpoint 2）
 * ---------------------------------------------------------------
 *   RecoveryOpportunity(DETECTED/QUALIFIED, recoverable>0)
 *     → Case + CaseOpportunity + RecoveryRoute(CARRIER) + 3×EvidenceArtifact/CaseEvidence
 *     → Claim DRAFT（模板文本；金额依据只来自 Opportunity）
 *     → （仅 test/demo）Settlement RECEIVED → RecoveryLedgerEntry RECOVERED
 *     → FeeCalculation（费率来自数据）→ BillingInvoice DRAFT
 *
 * 硬边界：不改 Schema / 不加 migration；Claim 只到 DRAFT；不调用第三方接口；
 *         合成 Settlement 仅测试/演示；Ledger 金额必须等于 Settlement.amount；
 *         费率来自数据（Decimal）；Case/Claim 状态跃迁写 AuditLog。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

const Decimal = Prisma.Decimal;
const MONEY_SCALE = 4;

const money = (value: string | InstanceType<typeof Decimal>): string =>
  new Decimal(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);

export interface CommercialTerms {
  /** 成功费率（十进制字符串，来自 fixture / 合同数据，禁止硬编码） */
  successFeeRate: string;
  /** 费率来源标识，写入 FeeCalculation.computation.source */
  source: string;
}

export interface ClosureScope {
  domain: 'LOGISTICS';
  channel: 'OTHER';
}

export const CLOSURE_SCOPE: ClosureScope = { domain: 'LOGISTICS', channel: 'OTHER' };

export interface ClosureRunResult {
  opportunitiesConsidered: number;
  casesCreated: number;
  casesReused: number;
  claimsCreated: number;
  evidenceCreated: number;
  settlementsCreated: number;
  ledgerEntriesCreated: number;
  feeCalculationsCreated: number;
  billingInvoicesCreated: number;
  cases: Array<{ caseId: string; caseNo: string; opportunityId: string; claimId: string }>;
}

export class ClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClosureError';
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/;

/**
 * CHANGE #52：金额输入必须 fail closed —— 缺金额绝不静默当 0。
 * 缺 amountExpected / amountActual / recoverableAmount 或 recoverable <= 0 时直接抛错。
 */
function assertClosableOpportunity(opportunity: {
  id: string;
  amountExpected: InstanceType<typeof Decimal> | null;
  amountActual: InstanceType<typeof Decimal> | null;
  recoverableAmount: InstanceType<typeof Decimal> | null;
  currency: string;
}): { recoverable: string } {
  if (!opportunity.amountExpected) {
    throw new ClosureError(`机会 ${opportunity.id} 缺 amountExpected：金额未知不得进入闭环`);
  }
  if (!opportunity.amountActual) {
    throw new ClosureError(`机会 ${opportunity.id} 缺 amountActual：金额未知不得进入闭环`);
  }
  if (!opportunity.recoverableAmount) {
    throw new ClosureError(`机会 ${opportunity.id} 缺 recoverableAmount：金额未知不得进入闭环`);
  }
  const recoverable = money(opportunity.recoverableAmount);
  if (!new Decimal(recoverable).gt(0)) {
    throw new ClosureError(`机会 ${opportunity.id} 的 recoverableAmount 必须 > 0`);
  }
  if (!CURRENCY_RE.test(opportunity.currency)) {
    throw new ClosureError(`机会 ${opportunity.id} 的 currency 非法: ${opportunity.currency}`);
  }
  return { recoverable };
}

/** CHANGE #52：成功费率必须是 0 < rate <= 1 的十进制字符串，且 source 非空 */
function assertCommercialTerms(terms: CommercialTerms): InstanceType<typeof Decimal> {
  if (typeof terms.successFeeRate !== 'string' || !DECIMAL_STRING_RE.test(terms.successFeeRate)) {
    throw new ClosureError('successFeeRate 必须是十进制字符串');
  }
  if (!terms.source || terms.source.trim() === '') {
    throw new ClosureError('commercialTerms.source 不能为空');
  }
  const rate = new Decimal(terms.successFeeRate);
  if (!rate.gt(0) || rate.gt(1)) {
    throw new ClosureError(`successFeeRate 必须在 (0, 1] 之间，收到 ${terms.successFeeRate}`);
  }
  return rate;
}

/** 确定性案件号：同租户同一 opportunity 永远得到同一个 caseNo（幂等基础） */
export function caseNoFor(opportunityId: string): string {
  return `CASE-${opportunityId}`;
}

export function billingInvoiceNoFor(caseNo: string): string {
  return `BILL-${caseNo}`;
}

/** 确定性 Claim 草稿文本：金额只引用 Opportunity，不重新计算 */
export function renderClaimDraft(input: {
  caseNo: string;
  opportunityType: string;
  amountExpected: string;
  amountActual: string;
  recoverableAmount: string;
  currency: string;
}): string {
  return [
    `Claim draft (${input.caseNo}) — ${input.opportunityType}`,
    `Expected charge: ${input.amountExpected} ${input.currency}`,
    `Invoiced charge: ${input.amountActual} ${input.currency}`,
    `Recoverable amount: ${input.recoverableAmount} ${input.currency}`,
    'Basis: carrier invoice vs contracted rate card (FREIGHT_RATE_V1).',
    'Draft for manual submission — Phase 1 does not auto-submit.',
  ].join('\n');
}

async function audit(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'recovery-closure-service',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes as Prisma.InputJsonValue,
    },
  });
}

/** 状态跃迁 + 审计（同一服务内成对出现；CHANGE #51 会进一步并入事务） */
async function setClaimStatus(
  prisma: PrismaClient,
  organizationId: string,
  claimId: string,
  from: string,
  to: string,
): Promise<void> {
  const current = await prisma.claim.findUniqueOrThrow({ where: { id: claimId }, select: { status: true } });
  if (current.status !== from) return; // 幂等：已是后续状态则不回退
  await prisma.claim.update({ where: { id: claimId }, data: { status: to as never } });
  await audit(prisma, {
    organizationId,
    action: 'claim.status_changed',
    entityType: 'Claim',
    entityId: claimId,
    changes: { from, to },
  });
}

async function setCaseStatus(
  prisma: PrismaClient,
  organizationId: string,
  caseId: string,
  from: string,
  to: string,
): Promise<void> {
  const current = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, select: { status: true } });
  if (current.status !== from) return;
  await prisma.case.update({ where: { id: caseId }, data: { status: to as never } });
  await audit(prisma, {
    organizationId,
    action: 'case.status_changed',
    entityType: 'Case',
    entityId: caseId,
    changes: { from, to },
  });
}

export interface RunClosureInput {
  organizationId: string;
  prisma: PrismaClient;
  commercialTerms: CommercialTerms;
  scope?: ClosureScope;
  /** 测试/演示专用：为每条新案件合成“承运商已赔付”的 Settlement */
  simulateSettlement?: boolean;
}

export async function runRecoveryClosure(input: RunClosureInput): Promise<ClosureRunResult> {
  const { organizationId, prisma, commercialTerms } = input;
  const scope = input.scope ?? CLOSURE_SCOPE;

  // CHANGE #47：人工卡口 —— 闭环只处理已确认（QUALIFIED）与已转案件（CONVERTED）的机会，
  // 普通 DETECTED 必须保持不动，由人工确认后再进入（DETECTED → QUALIFIED 不由本服务执行）。
  const opportunities = await prisma.recoveryOpportunity.findMany({
    where: {
      organizationId,
      domain: scope.domain,
      channel: scope.channel,
      status: { in: ['QUALIFIED', 'CONVERTED'] },
      recoverableAmount: { gt: new Decimal(0) },
    },
    orderBy: { detectedAt: 'asc' },
  });

  const feeRate = input.simulateSettlement ? assertCommercialTerms(commercialTerms) : null;

  const result: ClosureRunResult = {
    opportunitiesConsidered: opportunities.length,
    casesCreated: 0,
    casesReused: 0,
    claimsCreated: 0,
    evidenceCreated: 0,
    settlementsCreated: 0,
    ledgerEntriesCreated: 0,
    feeCalculationsCreated: 0,
    billingInvoicesCreated: 0,
    cases: [],
  };

  for (const opportunity of opportunities) {
    const caseNo = caseNoFor(opportunity.id);
    const { recoverable } = assertClosableOpportunity(opportunity);

    // 1) Case（幂等：organizationId + caseNo 唯一）
    let kase = await prisma.case.findUnique({
      where: { organizationId_caseNo: { organizationId, caseNo } },
    });
    if (kase) {
      result.casesReused += 1;
    } else {
      try {
        kase = await prisma.case.create({
          data: {
            organizationId,
            caseNo,
            title: opportunity.title,
            domain: scope.domain,
            status: 'OPEN',
            claimedAmount: new Decimal(recoverable),
            currency: opportunity.currency,
          },
        });
        result.casesCreated += 1;
        await audit(prisma, {
          organizationId,
          action: 'case.status_changed',
          entityType: 'Case',
          entityId: kase.id,
          changes: { to: 'OPEN', caseNo, opportunityId: opportunity.id },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        kase = await prisma.case.findUniqueOrThrow({
          where: { organizationId_caseNo: { organizationId, caseNo } },
        });
        result.casesReused += 1;
      }
    }

    // 2) CaseOpportunity（复合主键 → upsert 幂等）
    await prisma.caseOpportunity.upsert({
      where: { caseId_opportunityId: { caseId: kase.id, opportunityId: opportunity.id } },
      update: {},
      create: { organizationId, caseId: kase.id, opportunityId: opportunity.id },
    });

    // 3) RecoveryRoute → CARRIER（同案件同 target 只留一条）
    const existingRoute = await prisma.recoveryRoute.findFirst({
      where: { organizationId, caseId: kase.id, target: 'CARRIER' },
    });
    if (!existingRoute) {
      await prisma.recoveryRoute.create({
        data: {
          organizationId,
          caseId: kase.id,
          opportunityId: opportunity.id,
          target: 'CARRIER',
          status: 'PROPOSED',
          rationale: `freight rate overcharge vs contracted rate card (${opportunity.opportunityType})`,
        },
      });
    }

    // 4) 三份语义证据（fixture-only：不造假 FileAsset）
    const evidenceSpecs: Array<{ kind: 'INVOICE' | 'RATE_CARD' | 'TRACKING'; title: string; role: string }> = [
      { kind: 'INVOICE', title: `Carrier invoice — ${caseNo}`, role: 'INVOICE' },
      { kind: 'RATE_CARD', title: `Contract rate card — ${caseNo}`, role: 'RATE_CARD' },
      { kind: 'TRACKING', title: `Tracking / weight evidence — ${caseNo}`, role: 'TRACKING' },
    ];
    for (const spec of evidenceSpecs) {
      const existing = await prisma.evidenceArtifact.findFirst({
        where: { organizationId, title: spec.title, kind: spec.kind },
      });
      const evidence =
        existing ??
        (await prisma.evidenceArtifact.create({
          data: {
            organizationId,
            kind: spec.kind,
            title: spec.title,
            description: `fixture-derived ${spec.kind} evidence for ${caseNo}`,
            capturedAt: opportunity.detectedAt,
          },
        }));
      if (!existing) result.evidenceCreated += 1;
      await prisma.caseEvidence.upsert({
        where: { caseId_evidenceId: { caseId: kase.id, evidenceId: evidence.id } },
        update: {},
        create: { organizationId, caseId: kase.id, evidenceId: evidence.id, role: spec.role },
      });
    }

    // 5) Claim DRAFT（第 1 轮；同案件同轮次只留一条）
    let claim = await prisma.claim.findFirst({ where: { organizationId, caseId: kase.id, round: 1 } });
    if (!claim) {
      claim = await prisma.claim.create({
        data: {
          organizationId,
          caseId: kase.id,
          round: 1,
          status: 'DRAFT',
          target: 'CARRIER',
          aiDraftText: renderClaimDraft({
            caseNo,
            opportunityType: opportunity.opportunityType,
            amountExpected: money(opportunity.amountExpected ?? '0'),
            amountActual: money(opportunity.amountActual ?? '0'),
            recoverableAmount: recoverable,
            currency: opportunity.currency,
          }),
        },
      });
      result.claimsCreated += 1;
      await audit(prisma, {
        organizationId,
        action: 'claim.created',
        entityType: 'Claim',
        entityId: claim.id,
        changes: { caseId: kase.id, round: 1, target: 'CARRIER', status: 'DRAFT' },
      });
      await audit(prisma, {
        organizationId,
        action: 'claim.status_changed',
        entityType: 'Claim',
        entityId: claim.id,
        changes: { from: null, to: 'DRAFT', recoverableAmount: recoverable },
      });
    }

    // 6) Case / Claim 生命周期（CHANGE #48）
    //    simulateSettlement = false → 停在 READY_TO_CLAIM + DRAFT（Phase 1 半自动边界）
    //    simulateSettlement = true  → 显式推进到 APPROVED / SETTLED（仅 test/demo 模拟，不调用任何第三方）
    await setCaseStatus(prisma, organizationId, kase.id, 'OPEN', 'COLLECTING_EVIDENCE');
    await setCaseStatus(prisma, organizationId, kase.id, 'COLLECTING_EVIDENCE', 'READY_TO_CLAIM');

    // 7) Opportunity 状态推进（QUALIFIED → CONVERTED，人工确认已在上游完成）
    if (opportunity.status !== 'CONVERTED') {
      await prisma.recoveryOpportunity.update({
        where: { id: opportunity.id },
        data: { status: 'CONVERTED', qualifiedAt: opportunity.qualifiedAt ?? new Date() },
      });
      await audit(prisma, {
        organizationId,
        action: 'opportunity.status_changed',
        entityType: 'RecoveryOpportunity',
        entityId: opportunity.id,
        changes: { from: opportunity.status, to: 'CONVERTED' },
      });
    }

    // 8) 仅测试/演示：合成批准 → 到账证据 → 到账 → 账本 → 费用 → 账单（严格顺序）
    if (input.simulateSettlement) {
      await setClaimStatus(prisma, organizationId, claim.id, 'DRAFT', 'SUBMITTED');
      await setClaimStatus(prisma, organizationId, claim.id, 'SUBMITTED', 'ACKNOWLEDGED');
      await setClaimStatus(prisma, organizationId, claim.id, 'ACKNOWLEDGED', 'APPROVED');
      await setCaseStatus(prisma, organizationId, kase.id, 'READY_TO_CLAIM', 'CLAIMED');
      await setCaseStatus(prisma, organizationId, kase.id, 'CLAIMED', 'WON');

      const existingSettlement = await prisma.settlement.findFirst({
        where: { organizationId, caseId: kase.id },
      });
      if (!existingSettlement) {
        // CHANGE #49：到账必须有独立到账证据（CREDIT_NOTE），不能拿 INVOICE 冒充
        const creditTitle = `Synthetic carrier credit confirmation — ${caseNo}`;
        const existingCredit = await prisma.evidenceArtifact.findFirst({
          where: { organizationId, title: creditTitle, kind: 'CREDIT_NOTE' },
        });
        const credit =
          existingCredit ??
          (await prisma.evidenceArtifact.create({
            data: {
              organizationId,
              kind: 'CREDIT_NOTE',
              title: creditTitle,
              description: 'synthetic carrier credit confirmation (test/demo only)',
              capturedAt: new Date(),
            },
          }));
        if (!existingCredit) result.evidenceCreated += 1;
        await prisma.caseEvidence.upsert({
          where: { caseId_evidenceId: { caseId: kase.id, evidenceId: credit.id } },
          update: {},
          create: { organizationId, caseId: kase.id, evidenceId: credit.id, role: 'CREDIT_NOTE' },
        });

        const settlement = await prisma.settlement.create({
          data: {
            organizationId,
            caseId: kase.id,
            evidenceId: credit.id,
            status: 'RECEIVED',
            source: 'CARRIER_CREDIT',
            amount: new Decimal(recoverable),
            currency: opportunity.currency,
            receivedAt: new Date(),
            confirmedAt: new Date(),
            note: 'synthetic settlement (test/demo only)',
          },
        });
        result.settlementsCreated += 1;

        const settlementAmount = money(settlement.amount);
        await prisma.recoveryLedgerEntry.create({
          data: {
            organizationId,
            caseId: kase.id,
            opportunityId: opportunity.id,
            settlementId: settlement.id,
            entryType: 'RECOVERED',
            amount: new Decimal(settlementAmount),
            currency: settlement.currency,
            counterparty: 'DEMO_CARRIER',
            reference: `settlement:${settlement.id}`,
          },
        });
        result.ledgerEntriesCreated += 1;

        const rate = feeRate ?? assertCommercialTerms(commercialTerms);
        const base = new Decimal(settlementAmount);
        const fee = base.times(rate).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
        const feeAmount = fee.toFixed(MONEY_SCALE);

        const feeCalculation = await prisma.feeCalculation.create({
          data: {
            organizationId,
            settlementId: settlement.id,
            caseId: kase.id,
            basis: 'RECOVERED_AMOUNT_PCT',
            rate,
            baseAmount: base,
            feeAmount: fee,
            currency: settlement.currency,
            computation: {
              settlementId: settlement.id,
              baseAmount: settlementAmount,
              rate: commercialTerms.successFeeRate,
              feeAmount,
              rounding: { scale: MONEY_SCALE, mode: 'HALF_UP' },
              source: commercialTerms.source,
            } as Prisma.InputJsonValue,
          },
        });
        result.feeCalculationsCreated += 1;

        const invoiceNo = billingInvoiceNoFor(caseNo);
        await prisma.billingInvoice.create({
          data: {
            organizationId,
            caseId: kase.id,
            invoiceNo,
            status: 'DRAFT',
            subtotal: fee,
            taxAmount: new Decimal(0),
            total: fee,
            currency: settlement.currency,
            fees: { connect: { id: feeCalculation.id } },
          },
        });
        result.billingInvoicesCreated += 1;

        await prisma.case.update({
          where: { id: kase.id },
          data: { recoveredAmount: new Decimal(settlementAmount) },
        });
        await setCaseStatus(prisma, organizationId, kase.id, 'WON', 'SETTLED');
      }
    }

    result.cases.push({
      caseId: kase.id,
      caseNo,
      opportunityId: opportunity.id,
      claimId: claim.id,
    });
  }

  return result;
}
