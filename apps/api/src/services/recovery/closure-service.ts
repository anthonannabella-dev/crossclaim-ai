/**
 * Recovery Closure（C-0004 Checkpoint 2）
 * ---------------------------------------------------------------
 *   Opportunity(QUALIFIED/CONVERTED, recoverable>0)
 *     → Case + CaseOpportunity + RecoveryRoute(CARRIER) + 3×Evidence/CaseEvidence
 *     → Claim DRAFT（Phase 1 半自动边界）
 *     →（仅 test/demo）合成批准 → CREDIT_NOTE 到账证据 → Settlement RECEIVED
 *       → RecoveryLedgerEntry RECOVERED → FeeCalculation → BillingInvoice DRAFT
 *
 * CP2 复审约束（CHANGE #47–#52）：
 *   #47 只处理 QUALIFIED/CONVERTED，DETECTED 保持不动
 *   #48 非模拟 → READY_TO_CLAIM + DRAFT 且无资金记录；模拟 → 逐级推进并逐步审计
 *   #49 Settlement 必须挂 CREDIT_NOTE 到账证据
 *   #50 单案全部写操作在同一事务内，事务级 advisory lock 串行化（crash-safe + 并发幂等）
 *   #51 状态跃迁与 AuditLog 同事务，审计复用 Gate 1 sanitizeChanges
 *   #52 金额 / 成功率 fail closed
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { sanitizeChanges } from '../audit/sanitize';

const Decimal = Prisma.Decimal;
const MONEY_SCALE = 4;

const money = (value: string | InstanceType<typeof Decimal>): string =>
  new Decimal(value).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);

export interface CommercialTerms {
  successFeeRate: string;
  source: string;
}
export interface ClosureScope {
  domain: 'LOGISTICS';
  channel: 'OTHER';
}
export const CLOSURE_SCOPE: ClosureScope = { domain: 'LOGISTICS', channel: 'OTHER' };
export const CLOSURE_ACTOR_REF = 'recovery-closure-service';

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

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/;

function assertClosableOpportunity(opportunity: {
  id: string;
  amountExpected: InstanceType<typeof Decimal> | null;
  amountActual: InstanceType<typeof Decimal> | null;
  recoverableAmount: InstanceType<typeof Decimal> | null;
  currency: string;
}): { recoverable: string; amountExpected: InstanceType<typeof Decimal>; amountActual: InstanceType<typeof Decimal> } {
  if (!opportunity.amountExpected) throw new ClosureError(`机会 ${opportunity.id} 缺 amountExpected`);
  if (!opportunity.amountActual) throw new ClosureError(`机会 ${opportunity.id} 缺 amountActual`);
  if (!opportunity.recoverableAmount) throw new ClosureError(`机会 ${opportunity.id} 缺 recoverableAmount`);
  const recoverable = money(opportunity.recoverableAmount);
  if (!new Decimal(recoverable).gt(0)) throw new ClosureError(`机会 ${opportunity.id} 可追回金额必须 > 0`);
  if (!CURRENCY_RE.test(opportunity.currency)) {
    throw new ClosureError(`机会 ${opportunity.id} 币种非法: ${opportunity.currency}`);
  }
  return { recoverable, amountExpected: opportunity.amountExpected, amountActual: opportunity.amountActual };
}

function assertCommercialTerms(terms: CommercialTerms): InstanceType<typeof Decimal> {
  if (typeof terms.successFeeRate !== 'string' || !DECIMAL_STRING_RE.test(terms.successFeeRate)) {
    throw new ClosureError('successFeeRate 必须是十进制字符串');
  }
  if (!terms.source || terms.source.trim() === '') throw new ClosureError('commercialTerms.source 不能为空');
  const rate = new Decimal(terms.successFeeRate);
  if (!rate.gt(0) || rate.gt(1)) throw new ClosureError(`successFeeRate 必须在 (0, 1]，收到 ${terms.successFeeRate}`);
  return rate;
}

export function caseNoFor(opportunityId: string): string {
  return `CASE-${opportunityId}`;
}
export function billingInvoiceNoFor(caseNo: string): string {
  return `BILL-${caseNo}`;
}

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

async function auditTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
    actorRef?: string;
  },
): Promise<void> {
  const actorRef = input.actorRef ?? CLOSURE_ACTOR_REF;
  if (!actorRef) throw new ClosureError('审计 actorRef 不能为空');
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: sanitizeChanges(input.changes) as Prisma.InputJsonValue,
    },
  });
}

type Tx = Prisma.TransactionClient;

async function setClaimStatus(tx: Tx, organizationId: string, claimId: string, from: string, to: string) {
  const current = await tx.claim.findUniqueOrThrow({ where: { id: claimId }, select: { status: true } });
  if (current.status !== from) return;
  await tx.claim.update({ where: { id: claimId }, data: { status: to as never } });
  await auditTx(tx, {
    organizationId,
    action: 'claim.status_changed',
    entityType: 'Claim',
    entityId: claimId,
    changes: { from, to },
  });
}

async function setCaseStatus(tx: Tx, organizationId: string, caseId: string, from: string, to: string) {
  const current = await tx.case.findUniqueOrThrow({ where: { id: caseId }, select: { status: true } });
  if (current.status !== from) return;
  await tx.case.update({ where: { id: caseId }, data: { status: to as never } });
  await auditTx(tx, {
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
  simulateSettlement?: boolean;
}

interface CaseOutcome {
  caseId: string;
  caseNo: string;
  opportunityId: string;
  claimId: string;
  createdCase: boolean;
  createdClaim: boolean;
  evidenceCreated: number;
  settlementsCreated: number;
  ledgerEntriesCreated: number;
  feeCalculationsCreated: number;
  billingInvoicesCreated: number;
}

export async function runRecoveryClosure(input: RunClosureInput): Promise<ClosureRunResult> {
  const { organizationId, prisma, commercialTerms } = input;
  const scope = input.scope ?? CLOSURE_SCOPE;
  const feeRate = input.simulateSettlement ? assertCommercialTerms(commercialTerms) : null;

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
    const { recoverable, amountExpected, amountActual } = assertClosableOpportunity(opportunity);
    const caseNo = caseNoFor(opportunity.id);

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`closure:${organizationId}:${caseNo}`}))`;

      const local: CaseOutcome = {
        caseId: '',
        caseNo,
        opportunityId: opportunity.id,
        claimId: '',
        createdCase: false,
        createdClaim: false,
        evidenceCreated: 0,
        settlementsCreated: 0,
        ledgerEntriesCreated: 0,
        feeCalculationsCreated: 0,
        billingInvoicesCreated: 0,
      };

      let kase = await tx.case.findUnique({ where: { organizationId_caseNo: { organizationId, caseNo } } });
      if (!kase) {
        kase = await tx.case.create({
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
        local.createdCase = true;
        await auditTx(tx, {
          organizationId,
          action: 'case.status_changed',
          entityType: 'Case',
          entityId: kase.id,
          changes: { to: 'OPEN', caseNo, opportunityId: opportunity.id },
        });
      }
      local.caseId = kase.id;

      await tx.caseOpportunity.upsert({
        where: { caseId_opportunityId: { caseId: kase.id, opportunityId: opportunity.id } },
        update: {},
        create: { organizationId, caseId: kase.id, opportunityId: opportunity.id },
      });

      const existingRoute = await tx.recoveryRoute.findFirst({
        where: { organizationId, caseId: kase.id, target: 'CARRIER' },
      });
      if (!existingRoute) {
        await tx.recoveryRoute.create({
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

      const specs: Array<{ kind: 'INVOICE' | 'RATE_CARD' | 'TRACKING'; title: string; role: string }> = [
        { kind: 'INVOICE', title: `Carrier invoice — ${caseNo}`, role: 'INVOICE' },
        { kind: 'RATE_CARD', title: `Contract rate card — ${caseNo}`, role: 'RATE_CARD' },
        { kind: 'TRACKING', title: `Tracking / weight evidence — ${caseNo}`, role: 'TRACKING' },
      ];
      for (const spec of specs) {
        const existing = await tx.evidenceArtifact.findFirst({
          where: { organizationId, title: spec.title, kind: spec.kind },
        });
        const evidence =
          existing ??
          (await tx.evidenceArtifact.create({
            data: {
              organizationId,
              kind: spec.kind,
              title: spec.title,
              description: `fixture-derived ${spec.kind} evidence for ${caseNo}`,
              capturedAt: opportunity.detectedAt,
            },
          }));
        if (!existing) local.evidenceCreated += 1;
        await tx.caseEvidence.upsert({
          where: { caseId_evidenceId: { caseId: kase.id, evidenceId: evidence.id } },
          update: {},
          create: { organizationId, caseId: kase.id, evidenceId: evidence.id, role: spec.role },
        });
      }

      let claim = await tx.claim.findFirst({ where: { organizationId, caseId: kase.id, round: 1 } });
      if (!claim) {
        claim = await tx.claim.create({
          data: {
            organizationId,
            caseId: kase.id,
            round: 1,
            status: 'DRAFT',
            target: 'CARRIER',
            aiDraftText: renderClaimDraft({
              caseNo,
              opportunityType: opportunity.opportunityType,
              amountExpected: money(amountExpected),
              amountActual: money(amountActual),
              recoverableAmount: recoverable,
              currency: opportunity.currency,
            }),
          },
        });
        local.createdClaim = true;
        await auditTx(tx, {
          organizationId,
          action: 'claim.created',
          entityType: 'Claim',
          entityId: claim.id,
          changes: { caseId: kase.id, round: 1, target: 'CARRIER', status: 'DRAFT' },
        });
        await auditTx(tx, {
          organizationId,
          action: 'claim.status_changed',
          entityType: 'Claim',
          entityId: claim.id,
          changes: { from: null, to: 'DRAFT', recoverableAmount: recoverable },
        });
      }
      local.claimId = claim.id;

      await setCaseStatus(tx, organizationId, kase.id, 'OPEN', 'COLLECTING_EVIDENCE');
      await setCaseStatus(tx, organizationId, kase.id, 'COLLECTING_EVIDENCE', 'READY_TO_CLAIM');

      if (opportunity.status === 'QUALIFIED') {
        await tx.recoveryOpportunity.update({
          where: { id: opportunity.id },
          data: { status: 'CONVERTED', qualifiedAt: opportunity.qualifiedAt ?? new Date() },
        });
        await auditTx(tx, {
          organizationId,
          action: 'opportunity.status_changed',
          entityType: 'RecoveryOpportunity',
          entityId: opportunity.id,
          changes: { from: 'QUALIFIED', to: 'CONVERTED' },
        });
      }

      if (input.simulateSettlement) {
        await setClaimStatus(tx, organizationId, claim.id, 'DRAFT', 'SUBMITTED');
        await setClaimStatus(tx, organizationId, claim.id, 'SUBMITTED', 'ACKNOWLEDGED');
        await setClaimStatus(tx, organizationId, claim.id, 'ACKNOWLEDGED', 'APPROVED');
        await setCaseStatus(tx, organizationId, kase.id, 'READY_TO_CLAIM', 'CLAIMED');
        await setCaseStatus(tx, organizationId, kase.id, 'CLAIMED', 'WON');

        const existingSettlement = await tx.settlement.findFirst({
          where: { organizationId, caseId: kase.id },
        });
        if (!existingSettlement) {
          const creditTitle = `Synthetic carrier credit confirmation — ${caseNo}`;
          const existingCredit = await tx.evidenceArtifact.findFirst({
            where: { organizationId, title: creditTitle, kind: 'CREDIT_NOTE' },
          });
          const credit =
            existingCredit ??
            (await tx.evidenceArtifact.create({
              data: {
                organizationId,
                kind: 'CREDIT_NOTE',
                title: creditTitle,
                description: 'synthetic carrier credit confirmation (test/demo only)',
                capturedAt: new Date(),
              },
            }));
          if (!existingCredit) local.evidenceCreated += 1;
          await tx.caseEvidence.upsert({
            where: { caseId_evidenceId: { caseId: kase.id, evidenceId: credit.id } },
            update: {},
            create: { organizationId, caseId: kase.id, evidenceId: credit.id, role: 'CREDIT_NOTE' },
          });

          const settlement = await tx.settlement.create({
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
          local.settlementsCreated += 1;

          const settlementAmount = money(settlement.amount);
          await tx.recoveryLedgerEntry.create({
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
          local.ledgerEntriesCreated += 1;

          const rate = feeRate ?? assertCommercialTerms(commercialTerms);
          const base = new Decimal(settlementAmount);
          const fee = base.times(rate).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
          const feeCalculation = await tx.feeCalculation.create({
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
                feeAmount: fee.toFixed(MONEY_SCALE),
                rounding: { scale: MONEY_SCALE, mode: 'HALF_UP' },
                source: commercialTerms.source,
              } as Prisma.InputJsonValue,
            },
          });
          local.feeCalculationsCreated += 1;

          await tx.billingInvoice.create({
            data: {
              organizationId,
              caseId: kase.id,
              invoiceNo: billingInvoiceNoFor(caseNo),
              status: 'DRAFT',
              subtotal: fee,
              taxAmount: new Decimal(0),
              total: fee,
              currency: settlement.currency,
              fees: { connect: { id: feeCalculation.id } },
            },
          });
          local.billingInvoicesCreated += 1;

          await tx.case.update({
            where: { id: kase.id },
            data: { recoveredAmount: new Decimal(settlementAmount) },
          });
          await setCaseStatus(tx, organizationId, kase.id, 'WON', 'SETTLED');
        }
      }

      return local;
    });

    if (outcome.createdCase) result.casesCreated += 1;
    else result.casesReused += 1;
    if (outcome.createdClaim) result.claimsCreated += 1;
    result.evidenceCreated += outcome.evidenceCreated;
    result.settlementsCreated += outcome.settlementsCreated;
    result.ledgerEntriesCreated += outcome.ledgerEntriesCreated;
    result.feeCalculationsCreated += outcome.feeCalculationsCreated;
    result.billingInvoicesCreated += outcome.billingInvoicesCreated;
    result.cases.push({
      caseId: outcome.caseId,
      caseNo: outcome.caseNo,
      opportunityId: outcome.opportunityId,
      claimId: outcome.claimId,
    });
  }

  return result;
}
