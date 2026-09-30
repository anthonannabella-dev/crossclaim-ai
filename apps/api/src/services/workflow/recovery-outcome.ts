/**
 * C-0008-B2-3a — manual confirmation of a real recovery outcome.
 * ---------------------------------------------------------------
 * Approved design + rulings (MSG-20260928-56):
 *   · name        : confirmRecoveryOutcome(caseId, { recoveredAmount, currency,
 *                   basisReference, evidenceArtifactId?, note? })
 *   · evidence    : basisReference is REQUIRED and non-empty; evidenceArtifactId
 *                   is optional (recommended). Never “AI decided the money arrived”.
 *   · amounts     : decimal strings only, 4-dp HALF_UP. recoveredAmount <= 0 or a
 *                   currency mismatch is rejected; recoveredAmount > claimedAmount
 *                   is allowed but writes `recovery_amount_exceeds_claim`.
 *   · status      : NEVER auto-advances Claim APPROVED / Case WON — both must
 *                   already be true (they are separate manual facts).
 *   · idempotency : at most one Settlement per case; a repeat returns the
 *                   existing money objects instead of creating more.
 *   · roles       : OWNER / ADMIN / FINANCE (advanceBilling), OPS read-only.
 *   · no payment gateway, no simulateSettlement — both forbidden here.
 *
 * Four objects stay separate (approved core boundary):
 *   Settlement (external recovery fact) → RecoveryLedgerEntry (ledger) →
 *   FeeCalculation (our service fee) → BillingInvoice (what we charge the client).
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { billingInvoiceNoFor, type CommercialTerms } from '../recovery';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';
import { assertHighValueReviewCleared } from './recovery-review';

const MONEY_SCALE = 4;
const REFERENCE_MAX = 256;
const NOTE_MAX = 500;
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/;

const money = (value: string | InstanceType<typeof Prisma.Decimal>): InstanceType<typeof Prisma.Decimal> =>
  new Prisma.Decimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);

export interface ConfirmRecoveryOutcomeInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
  recoveredAmount: unknown;
  currency: unknown;
  basisReference: unknown;
  evidenceArtifactId?: unknown;
  note?: unknown;
  /**
   * CHANGE B（MSG-20260930-17）：本次执行所依据的审批标识。
   * 提供时，审批消费与首次资金写入在同一事务内完成（advisory lock 串行化）。
   */
  approvalId?: string;
  /** 操作关联标识（缺省由 approvalId + caseId 生成） */
  operationId?: string;
}

export interface ConfirmRecoveryOutcomeResult {
  caseId: string;
  caseNo: string;
  settlementId: string;
  ledgerEntryId: string;
  feeCalculationId: string;
  billingInvoiceId: string;
  recoveredAmount: string;
  feeAmount: string;
  /** true = 本次确认产生；false = 复用既有 Settlement（幂等） */
  created: boolean;
  /** recoveredAmount > claimedAmount 时为 true（已写警告审计，不阻断） */
  exceedsClaim: boolean;
}

function assertMoney(value: unknown, field: string): InstanceType<typeof Prisma.Decimal> {
  if (typeof value !== 'string' || !DECIMAL_STRING_RE.test(value.trim())) {
    throw new WorkflowError('INVALID_INPUT', `${field} 必须是十进制字符串`);
  }
  const amount = new Prisma.Decimal(value.trim());
  if (!amount.gt(0)) {
    throw new WorkflowError('INVALID_INPUT', `${field} 必须 > 0`);
  }
  return money(amount);
}

function assertReference(value: unknown): string {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (ref === '') {
    throw new WorkflowError('INVALID_INPUT', 'basisReference 不能为空（禁止无依据确认到账）');
  }
  if (ref.length > REFERENCE_MAX) {
    throw new WorkflowError('INVALID_INPUT', `basisReference 不得超过 ${REFERENCE_MAX} 个字符`);
  }
  return ref;
}

/**
 * 「费率已确认」是业务条件：以该案件是否存在 commercial_terms.created 审计为准。
 * 返回已确认的费率（缺失即 409 COMMERCIAL_TERMS_PENDING）。
 */
async function loadConfirmedTerms(
  prisma: PrismaClient,
  organizationId: string,
  caseId: string,
): Promise<CommercialTerms> {
  const confirmed = await prisma.auditLog.findFirst({
    where: {
      organizationId,
      entityType: 'Case',
      entityId: caseId,
      action: 'commercial_terms.created',
    },
    orderBy: { createdAt: 'desc' },
    select: { changes: true },
  });
  const changes = (confirmed?.changes ?? null) as Record<string, unknown> | null;
  const successFeeRate = typeof changes?.successFeeRate === 'string' ? changes.successFeeRate : '';
  const source = typeof changes?.source === 'string' ? changes.source : '';
  if (!confirmed || successFeeRate === '') {
    throw new WorkflowError(
      'COMMERCIAL_TERMS_PENDING',
      '该案件尚未完成商务确认（setCommercialTerms），不能确认回收结果',
    );
  }
  return { successFeeRate, source };
}

export async function confirmRecoveryOutcome(
  prisma: PrismaClient,
  input: ConfirmRecoveryOutcomeInput,
  now: () => Date = () => new Date(),
): Promise<ConfirmRecoveryOutcomeResult> {
  assertPermission(input.role, 'advanceBilling');

  const recoveredAmount = assertMoney(input.recoveredAmount, 'recoveredAmount');
  const basisReference = assertReference(input.basisReference);
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, NOTE_MAX) : '';
  const requestedEvidenceId =
    typeof input.evidenceArtifactId === 'string' && input.evidenceArtifactId.trim() !== ''
      ? input.evidenceArtifactId.trim()
      : null;

  const kase = await prisma.case.findFirst({
    where: { id: input.caseId, organizationId: input.organizationId },
    select: { id: true, caseNo: true, status: true, currency: true, claimedAmount: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${input.caseId} 不存在或不属于该租户`);
  }

  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (currency === '' || currency !== kase.currency) {
    throw new WorkflowError(
      'CURRENCY_MISMATCH',
      `币种必须与案件一致（案件 ${kase.currency}，收到 ${currency || '(空)'}）`,
    );
  }

  const claimedAmount = kase.claimedAmount ? money(kase.claimedAmount) : new Prisma.Decimal(0);
  const exceedsClaim = recoveredAmount.gt(claimedAmount);

  // 幂等优先：该案件已有 Settlement 时，重复确认返回既有资金对象，
  // 不重复计费，也不因「案件已 SETTLED」而报错（下方守卫只约束首次确认）。
  const existingSettlement = await prisma.settlement.findFirst({
    where: { organizationId: input.organizationId, caseId: kase.id },
    select: { id: true, amount: true, currency: true },
  });
  if (existingSettlement) {
    const [ledger, fee, billing] = await Promise.all([
      prisma.recoveryLedgerEntry.findFirst({
        where: { organizationId: input.organizationId, settlementId: existingSettlement.id },
        select: { id: true },
      }),
      prisma.feeCalculation.findFirst({
        where: { organizationId: input.organizationId, settlementId: existingSettlement.id },
        select: { id: true, feeAmount: true },
      }),
      prisma.billingInvoice.findFirst({
        where: { organizationId: input.organizationId, caseId: kase.id },
        select: { id: true },
      }),
    ]);
    return {
      caseId: kase.id,
      caseNo: kase.caseNo,
      settlementId: existingSettlement.id,
      ledgerEntryId: ledger?.id ?? '',
      feeCalculationId: fee?.id ?? '',
      billingInvoiceId: billing?.id ?? '',
      recoveredAmount: money(existingSettlement.amount).toFixed(MONEY_SCALE),
      feeAmount: (fee?.feeAmount ? money(fee.feeAmount) : new Prisma.Decimal(0)).toFixed(MONEY_SCALE),
      created: false,
      exceedsClaim,
    };
  }

  // 人工事实必须已经存在：绝不自动推进（Q3）
  if (kase.status !== 'WON') {
    throw new WorkflowError(
      'ILLEGAL_TRANSITION',
      `案件状态 ${kase.status} 不允许确认回收结果（必须先是 WON，由人工推进）`,
    );
  }
  const claim = await prisma.claim.findFirst({
    where: { organizationId: input.organizationId, caseId: kase.id, round: 1 },
    select: { id: true, status: true },
  });
  if (!claim) {
    throw new WorkflowError('NOT_FOUND', `案件 ${kase.id} 没有第 1 轮 Claim`);
  }
  if (claim.status !== 'APPROVED') {
    throw new WorkflowError(
      'CLAIM_NOT_APPROVED',
      `Claim 状态 ${claim.status} 不允许确认回收结果（必须先是 APPROVED，由人工推进）`,
    );
  }

  const terms = await loadConfirmedTerms(prisma, input.organizationId, kase.id);

  // C-0009.2 Step 2：高额回收必须先通过人工复核（OWNER/ADMIN），
  // 未通过时写 review_required 审计并 409，且**不写任何资金记录**。
  await assertHighValueReviewCleared(
    prisma,
    {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      caseId: kase.id,
      caseNo: kase.caseNo,
      recoveredAmount,
      currency,
    },
    now,
  );

  if (requestedEvidenceId) {
    const evidence = await prisma.evidenceArtifact.findFirst({
      where: { id: requestedEvidenceId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!evidence) {
      throw new WorkflowError('NOT_FOUND', `EvidenceArtifact ${requestedEvidenceId} 不存在或不属于该租户`);
    }
  }

  const feeAmount = money(recoveredAmount.times(new Prisma.Decimal(terms.successFeeRate)));
  const at = now();

  const approvalId = typeof input.approvalId === 'string' && input.approvalId.trim() !== '' ? input.approvalId.trim() : null;
  const operationId =
    typeof input.operationId === 'string' && input.operationId.trim() !== ''
      ? input.operationId.trim()
      : approvalId ? `approval:${approvalId}` : null;

  return prisma.$transaction(async (tx) => {
    // CHANGE B（MSG-20260930-17 §4）：审批消费与首次资金写入必须原子化。
    // 以 approvalId 为粒度取事务级 advisory lock → 锁内重查消费 → 写消费事件；
    // 已消费时走幂等分支（返回既有资金对象，不重复创建）。
    if (approvalId) {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-approval:${approvalId}`);
      const consumed = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "AuditLog" WHERE "organizationId" = $1 AND action = 'recovery.approval_consumed' AND changes->>'approvalId' = $2`,
        input.organizationId,
        approvalId,
      );
      if (Number(consumed[0]?.n ?? 0) > 0) {
        const settled = await tx.settlement.findFirst({
          where: { organizationId: input.organizationId, caseId: kase.id },
          select: { id: true, amount: true },
        });
        const feeRow = settled
          ? await tx.feeCalculation.findFirst({ where: { organizationId: input.organizationId, settlementId: settled.id }, select: { id: true, feeAmount: true } })
          : null;
        const invoiceRow = await tx.billingInvoice.findFirst({ where: { organizationId: input.organizationId, caseId: kase.id }, select: { id: true } });
        const ledgerRow = settled
          ? await tx.recoveryLedgerEntry.findFirst({ where: { organizationId: input.organizationId, settlementId: settled.id }, select: { id: true } })
          : null;
        return {
          caseId: kase.id,
          caseNo: kase.caseNo,
          settlementId: settled?.id ?? '',
          ledgerEntryId: ledgerRow?.id ?? '',
          feeCalculationId: feeRow?.id ?? '',
          billingInvoiceId: invoiceRow?.id ?? '',
          recoveredAmount: (settled ? money(settled.amount) : recoveredAmount).toFixed(MONEY_SCALE),
          feeAmount: (feeRow?.feeAmount ? money(feeRow.feeAmount) : new Prisma.Decimal(0)).toFixed(MONEY_SCALE),
          created: false,
          exceedsClaim,
        };
      }
      // 消费事件：审批与首次资金写入同事务落库
      await tx.auditLog.create({
        data: {
          organizationId: input.organizationId,
          actorType: 'USER',
          actorUserId: input.actorUserId,
          action: 'recovery.approval_consumed',
          entityType: 'Case',
          entityId: kase.id,
          changes: { approvalId, operationId, caseNo: kase.caseNo, recoveredAmount: recoveredAmount.toFixed(MONEY_SCALE), currency } as never,
          createdAt: at,
        },
      });
    }

    // 凭证：优先使用用户指定的 EvidenceArtifact，否则为本次人工确认留一条可追溯凭证
    let evidenceId = requestedEvidenceId;
    if (!evidenceId) {
      const created = await tx.evidenceArtifact.create({
        data: {
          organizationId: input.organizationId,
          kind: 'CREDIT_NOTE',
          title: `Manual recovery confirmation — ${kase.caseNo}`,
          description: `basisReference: ${basisReference}`,
          capturedAt: at,
        },
      });
      evidenceId = created.id;
    }
    await tx.caseEvidence.upsert({
      where: { caseId_evidenceId: { caseId: kase.id, evidenceId } },
      update: {},
      create: { organizationId: input.organizationId, caseId: kase.id, evidenceId, role: 'CREDIT_NOTE' },
    });

    const settlement = await tx.settlement.create({
      data: {
        organizationId: input.organizationId,
        caseId: kase.id,
        evidenceId,
        status: 'RECEIVED',
        // SettlementSource 是既有枚举（无 MANUAL_CONFIRMATION 值）：人工确认使用 OTHER，
        // 真实依据由 basisReference + 本函数的 recovery_outcome.confirmed 审计承载。
        // 若架构方希望显式枚举值，需要一次 Schema Delta（见检查点）。
        source: 'OTHER',
        amount: recoveredAmount,
        currency,
        receivedAt: at,
        confirmedAt: at,
        ...(note ? { note } : {}),
      },
    });

    const ledger = await tx.recoveryLedgerEntry.create({
      data: {
        organizationId: input.organizationId,
        caseId: kase.id,
        opportunityId: null,
        settlementId: settlement.id,
        entryType: 'RECOVERED',
        amount: recoveredAmount,
        currency,
        counterparty: 'EXTERNAL_PAYER',
        reference: `settlement:${settlement.id}`,
      },
    });

    const fee = await tx.feeCalculation.create({
      data: {
        organizationId: input.organizationId,
        settlementId: settlement.id,
        caseId: kase.id,
        basis: 'RECOVERED_AMOUNT_PCT',
        rate: new Prisma.Decimal(terms.successFeeRate),
        baseAmount: recoveredAmount,
        feeAmount,
        currency,
        computation: {
          settlementId: settlement.id,
          baseAmount: recoveredAmount.toFixed(MONEY_SCALE),
          rate: terms.successFeeRate,
          feeAmount: feeAmount.toFixed(MONEY_SCALE),
          rounding: { scale: MONEY_SCALE, mode: 'HALF_UP' },
          source: terms.source,
          basisReference,
        } as Prisma.InputJsonValue,
      },
    });

    const billing = await tx.billingInvoice.create({
      data: {
        organizationId: input.organizationId,
        caseId: kase.id,
        invoiceNo: billingInvoiceNoFor(kase.caseNo),
        status: 'DRAFT',
        subtotal: feeAmount,
        taxAmount: new Prisma.Decimal(0),
        total: feeAmount,
        currency,
        fees: { connect: { id: fee.id } },
      },
    });

    // 只在案件上记录回收金额；**不**改动 Case.status。
    // MSG-20260928-57：Case 状态不得承担 Settlement 状态 —— 资金事实由
    // Settlement(RECEIVED) 表达，Case 保持 WON。
    await tx.case.update({
      where: { id: kase.id },
      data: { recoveredAmount },
    });
    await writeUserAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'recovery_outcome.confirmed',
      entityType: 'Settlement',
      entityId: settlement.id,
      changes: {
        caseId: kase.id,
        caseNo: kase.caseNo,
        recoveredAmount: recoveredAmount.toFixed(MONEY_SCALE),
        currency,
        basisReference,
        evidenceArtifactId: evidenceId,
        ...(note ? { hasNote: true } : {}),
      },
      at,
    });
    if (exceedsClaim) {
      // Q2：超出索赔金额不阻断，但必须留下警告审计
      await writeUserAudit(tx, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: 'recovery_amount_exceeds_claim',
        entityType: 'Case',
        entityId: kase.id,
        changes: {
          recoveredAmount: recoveredAmount.toFixed(MONEY_SCALE),
          claimedAmount: claimedAmount.toFixed(MONEY_SCALE),
          currency,
        },
        at,
      });
    }

    return {
      caseId: kase.id,
      caseNo: kase.caseNo,
      settlementId: settlement.id,
      ledgerEntryId: ledger.id,
      feeCalculationId: fee.id,
      billingInvoiceId: billing.id,
      recoveredAmount: recoveredAmount.toFixed(MONEY_SCALE),
      feeAmount: feeAmount.toFixed(MONEY_SCALE),
      created: true,
      exceedsClaim,
    };
  });
}

async function writeUserAudit(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes,
    },
    { maxStringLength: 512 },
  );
  await tx.auditLog.create({
    data: {
      organizationId: row.organizationId,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      actorRef: row.actorRef,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: input.at,
    },
  });
}
