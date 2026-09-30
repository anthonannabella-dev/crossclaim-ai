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
import { ApprovalBoundaryError, verifyApprovalBoundary } from '../action-guard/approval-tx-verify';
import { requiresHighValueReview, resolveHighValueThreshold } from './recovery-review';
import { RECOVERY_CONFIRMATION_ACTION } from '../action-guard/approval-verifier';
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

  // R3 CHANGE B：既有资金链的判定移入「案件锁内 + 完整重验之后」（见下方事务），
  // 避免并发下先通过 wrapper、再因他人已建 Settlement 而跳过最终授权重验。

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
  // R3 CHANGE B：高额确认若缺操作级审批，直接拒绝（旧案件状态卡口不能替代操作级授权）
  if (
    approvalId === null &&
    requiresHighValueReview({ recoveredAmount, currency, threshold: resolveHighValueThreshold() })
  ) {
    // R3 CHANGE D：入口闸门的拒绝同样留证（审计失败不改变拒绝结果）
    await writeOutcomeRejectionAudit(prisma, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      caseId: kase.id,
      caseNo: kase.caseNo,
      approvalId: null,
      operationId: null,
      stage: 'ENTRY_GATE',
      reason: 'APPROVAL_ID_REQUIRED',
      at,
    }).catch(() => undefined);
    throw new WorkflowError('REVIEW_REQUIRED', '高额确认必须携带操作级审批（approvalId）');
  }
  const operationId =
    typeof input.operationId === 'string' && input.operationId.trim() !== ''
      ? input.operationId.trim()
      : approvalId ? `approval:${approvalId}` : null;

  try {
    return await prisma.$transaction(async (tx) => {
    // CHANGE B（MSG-20260930-17 §4）：审批消费与首次资金写入必须原子化。
    // R3 CHANGE B（MSG-20260930-19）：案件锁**无条件**获取（含缺 approvalId 的兼容调用），
    // 且「既有资金链的幂等返回」必须在**锁内 + 完整重验之后**，不再有绕过最终边界的早返回。
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-recovery-case:${kase.id}`);
    }
    let approvalConsumed = false;
    if (approvalId) {
      // R2 CHANGE B1：锁顺序固定为「案件 → 审批」，保证同案不同审批也只允许一条资金链
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `cc-approval:${approvalId}`);
      // R3 CHANGE A：锁获取后**重新读取服务端时间**，不得沿用等待前的时间
      const verificationTime = now();
      // 锁内重验审批绑定与生命周期（不能用事务外结论）
      const boundary = await verifyApprovalBoundary(tx, {
        organizationId: input.organizationId,
        approvalId,
        action: RECOVERY_CONFIRMATION_ACTION,
        caseId: kase.id,
        actorUserId: input.actorUserId,
        payload: {
          amount: recoveredAmount.toFixed(MONEY_SCALE),
          currency,
          basisReference,
          evidenceArtifactId: requestedEvidenceId,
        },
        now: verificationTime,
      });
      if (!boundary.ok) {
        throw new ApprovalBoundaryError(boundary.reason, kase.id);
      }
      approvalConsumed = boundary.consumed;
    }

    // R3 CHANGE B：锁内按**案件**核查既有资金链（无论本次 approvalId 是否已消费、也无论是否带 approvalId）。
    // 同案不同审批并发时，后到的请求在此看到第一条完整资金链并走幂等返回，而不是依赖唯一约束报错。
    const caseSettlement = await tx.settlement.findFirst({
      where: { organizationId: input.organizationId, caseId: kase.id },
      select: { id: true, amount: true },
    });
    if (caseSettlement) {
      const [ledgerRow, feeRow, invoiceRow] = await Promise.all([
        tx.recoveryLedgerEntry.findFirst({
          where: { organizationId: input.organizationId, settlementId: caseSettlement.id },
          select: { id: true },
        }),
        tx.feeCalculation.findFirst({
          where: { organizationId: input.organizationId, settlementId: caseSettlement.id },
          select: { id: true, feeAmount: true },
        }),
        tx.billingInvoice.findFirst({
          where: { organizationId: input.organizationId, caseId: kase.id },
          select: { id: true },
        }),
      ]);
      // 缺对象拒绝，不返回空 ID 冒充成功（R3 CHANGE B）
      if (!ledgerRow || !feeRow || !invoiceRow) {
        throw new WorkflowError(
          'ILLEGAL_TRANSITION',
          '既有资金链不完整（缺少 Ledger/Fee/Billing 之一），拒绝幂等返回',
        );
      }
      // 合法幂等返回必须能证明「这条链就是本审批消费产生的」：核对审批标识、同操作与规范化载荷
      if (approvalId) {
        const consumedRow = await tx.auditLog.findFirst({
          where: {
            organizationId: input.organizationId,
            action: 'recovery.approval_consumed',
            entityType: 'Case',
            entityId: kase.id,
            changes: { path: ['approvalId'], equals: approvalId } as never,
          },
          select: { changes: true },
        });
        if (!consumedRow) {
          // 既有资金链不是由本审批消费产生：不得据其返回成功
          throw new ApprovalBoundaryError('APPROVAL_NOT_APPROVED', kase.id);
        }
        const consumedChanges = (consumedRow.changes ?? null) as Record<string, unknown> | null;
        const consumedOperationId =
          typeof consumedChanges?.operationId === 'string' ? consumedChanges.operationId : null;
        const consumedAmount =
          typeof consumedChanges?.recoveredAmount === 'string' ? consumedChanges.recoveredAmount : null;
        const consumedCurrency =
          typeof consumedChanges?.currency === 'string' ? consumedChanges.currency : null;
        if (
          consumedOperationId !== operationId ||
          consumedAmount !== recoveredAmount.toFixed(MONEY_SCALE) ||
          consumedCurrency !== currency ||
          money(caseSettlement.amount).toFixed(MONEY_SCALE) !== recoveredAmount.toFixed(MONEY_SCALE)
        ) {
          throw new ApprovalBoundaryError('APPROVAL_PAYLOAD_MISMATCH', kase.id);
        }
      }
      return {
        caseId: kase.id,
        caseNo: kase.caseNo,
        settlementId: caseSettlement.id,
        ledgerEntryId: ledgerRow.id,
        feeCalculationId: feeRow.id,
        billingInvoiceId: invoiceRow.id,
        recoveredAmount: money(caseSettlement.amount).toFixed(MONEY_SCALE),
        feeAmount: money(feeRow.feeAmount).toFixed(MONEY_SCALE),
        created: false,
        exceedsClaim,
      };
    }
    if (approvalConsumed) {
      // 审批已消费却没有任何资金对象：链不完整，拒绝（不重复消费、不静默补写）
      throw new WorkflowError(
        'ILLEGAL_TRANSITION',
        '审批已消费但案件资金链缺失，拒绝重复消费',
      );
    }

    if (approvalId) {
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
        // R3 CHANGE D：成功记录必须能与审批/操作/执行主体对齐（entityId = Settlement.id）
        ...(approvalId ? { approvalId, operationId } : {}),
        result: 'CONFIRMED',
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
  } catch (error) {
    // R3 CHANGE D：锁内拒绝（含既有链缺项）必须留下可关联的最终拒绝审计。
    // 事务已回滚，故用独立连接写入；审计失败不得覆盖原始拒绝错误。
    const reason =
      error instanceof ApprovalBoundaryError
        ? error.reason
        : error instanceof WorkflowError
          ? error.code
          : null;
    if (reason !== null) {
      await writeOutcomeRejectionAudit(prisma, {
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        caseId: kase.id,
        caseNo: kase.caseNo,
        approvalId,
        operationId,
        stage: 'LOCKED_RECHECK',
        reason,
        at: now(),
      }).catch(() => undefined);
    }
    throw error;
  }
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

/**
 * R3 CHANGE D：最终拒绝审计（入口闸门 / 锁内重验）。
 * 记录执行主体、审批、操作、目标与结果；与 `recovery_outcome.confirmed` 成对使用。
 * 主体可能是「已停用用户 / 非有效成员」，故不以 USER actor 落库（成员触发器），
 * 执行主体 ID 记入 changes，保持 AI/SYSTEM 形状约束。
 */
async function writeOutcomeRejectionAudit(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    actorUserId: string;
    caseId: string;
    caseNo: string;
    approvalId: string | null;
    operationId: string | null;
    stage: 'ENTRY_GATE' | 'LOCKED_RECHECK';
    reason: string;
    at: Date;
  },
): Promise<void> {
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'SYSTEM',
      actorRef: 'recovery-outcome-guard',
      action: 'recovery.outcome_rejected',
      entityType: 'Case',
      entityId: input.caseId,
      changes: {
        caseId: input.caseId,
        caseNo: input.caseNo,
        actorUserId: input.actorUserId,
        approvalId: input.approvalId,
        operationId: input.operationId,
        stage: input.stage,
        reason: input.reason,
        result: 'REJECTED',
      },
    },
    { maxStringLength: 512, now: () => input.at },
  );
  await prisma.auditLog.create({
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
