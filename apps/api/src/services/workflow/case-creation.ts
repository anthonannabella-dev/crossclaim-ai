/**
 * C-0008-B2-1 — case creation from a human-confirmed opportunity.
 * ---------------------------------------------------------------
 * Approved rulings (MSG-20260928-53):
 *   · endpoint              : POST /opportunities/:id/case
 *   · roles                 : OWNER / ADMIN / OPS may create a case; only
 *                             OWNER / ADMIN may fill the success fee rate
 *   · entry state           : QUALIFIED or CONVERTED only (never DETECTED)
 *   · commercial terms      : supplied per case, audited as
 *                             `commercial_terms.created` (no bank data)
 *   · synthetic settlement  : never accepted from a user-facing call
 *
 * The case itself is **not** re-implemented here: this service reuses
 * `runRecoveryClosure` (Gate 2), which already owns the Case / CaseOpportunity /
 * Evidence / Claim-DRAFT / opportunity → CONVERTED transaction and its
 * idempotency (`caseNo = CASE-<opportunityId>`).
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import {
  CLOSURE_SCOPE,
  ClosureError,
  assertCommercialTerms,
  caseNoFor,
  isOpportunityClosable,
  runRecoveryClosure,
  type CommercialTerms,
} from '../recovery';
import { WorkflowError } from './opportunity-review';
import { assertPermission } from './permissions';

export interface CreateCaseInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  opportunityId: string;
  /**
   * 可选：{ successFeeRate, source }。
   * 只有 OWNER / ADMIN 可以随建案一起确认费率；OPS 建案时省略，费率进入
   * 「待商务确认（pending）」状态（MSG-20260928-54 裁定 Step 1）。
   */
  commercialTerms?: unknown;
}

export interface CreateCaseResult {
  caseId: string;
  caseNo: string;
  opportunityId: string;
  claimId: string;
  /** true = 本次调用创建；false = 复用既有案件（幂等） */
  created: boolean;
  /** 本次是否已确认费率 */
  commercialTerms: CommercialTerms | null;
  /** 费率是否仍待 OWNER / ADMIN 确认（业务条件，不新增 Schema） */
  commercialTermsPending: boolean;
}

export interface ConfirmCommercialTermsInput {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
  commercialTerms: unknown;
}

export interface ConfirmCommercialTermsResult {
  caseId: string;
  caseNo: string;
  confirmed: boolean;
  /** true = 该案件此前已有商务确认（本次为再次确认，仍会留审计） */
  alreadyConfirmed: boolean;
}

/** 审计行写入形状（与 B1 一致：actorType=USER + actorUserId）。 */
function auditData(row: ReturnType<typeof prepareAuditInsert>, at: Date) {
  return {
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
    createdAt: at,
  };
}

function parseCommercialTerms(raw: unknown): CommercialTerms {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkflowError('INVALID_COMMERCIAL_TERMS', 'commercialTerms 必须是对象');
  }
  const value = raw as Record<string, unknown>;
  const terms: CommercialTerms = {
    successFeeRate: typeof value.successFeeRate === 'string' ? value.successFeeRate : '',
    source: typeof value.source === 'string' ? value.source.trim() : '',
  };
  try {
    // 复用 Gate 2 的校验：十进制字符串 + (0, 1] + source 非空
    assertCommercialTerms(terms);
  } catch (error) {
    if (error instanceof ClosureError) {
      throw new WorkflowError('INVALID_COMMERCIAL_TERMS', error.message);
    }
    throw error;
  }
  return terms;
}

export async function createCaseForOpportunity(
  prisma: PrismaClient,
  input: CreateCaseInput,
  now: () => Date = () => new Date(),
): Promise<CreateCaseResult> {
  assertPermission(input.role, 'createCase');
  // 裁定 Step 1：OPS 可以建案；只有 OWNER / ADMIN 能同时（或事后）确认费率。
  const hasTerms = input.commercialTerms !== undefined && input.commercialTerms !== null;
  let terms: CommercialTerms | null = null;
  if (hasTerms) {
    assertPermission(input.role, 'setCommercialTerms');
    terms = parseCommercialTerms(input.commercialTerms);
  }

  const opportunity = await prisma.recoveryOpportunity.findFirst({
    where: { id: input.opportunityId, organizationId: input.organizationId },
    select: { id: true, status: true, domain: true, channel: true },
  });
  if (!opportunity) {
    throw new WorkflowError('NOT_FOUND', `机会 ${input.opportunityId} 不存在或不属于该租户`);
  }
  if (!isOpportunityClosable(opportunity.status)) {
    throw new WorkflowError(
      'ILLEGAL_TRANSITION',
      `机会状态 ${opportunity.status} 不允许建案（只有 QUALIFIED / CONVERTED）`,
    );
  }
  // Gate 2 的 Closure 目前只覆盖 LOGISTICS / OTHER 这一组合；超出范围时明确失败，
  // 绝不静默返回「什么都没发生」。
  if (opportunity.domain !== CLOSURE_SCOPE.domain || opportunity.channel !== CLOSURE_SCOPE.channel) {
    throw new WorkflowError(
      'SCOPE_NOT_SUPPORTED',
      `当前建案仅支持 domain=${CLOSURE_SCOPE.domain} / channel=${CLOSURE_SCOPE.channel}，该机会为 ${opportunity.domain}/${opportunity.channel}`,
    );
  }

  const caseNo = caseNoFor(opportunity.id);
  const existing = await prisma.case.findUnique({
    where: { organizationId_caseNo: { organizationId: input.organizationId, caseNo } },
    select: { id: true },
  });

  let closure;
  try {
    closure = await runRecoveryClosure({
      organizationId: input.organizationId,
      prisma,
      // 非合成路径不需要费率；待确认的费率在此为 null，绝不使用默认值或推测值。
      commercialTerms: terms,
      // 用户侧永不触发合成 Settlement（裁定 3）。
      simulateSettlement: false,
    });
  } catch (error) {
    if (error instanceof ClosureError) {
      throw new WorkflowError('INVALID_INPUT', error.message);
    }
    throw error;
  }

  const outcome = closure.cases.find((entry) => entry.opportunityId === opportunity.id);
  if (!outcome) {
    throw new WorkflowError(
      'CASE_NOT_CREATED',
      `建案未产生案件（opportunitiesConsidered=${closure.opportunitiesConsidered}）`,
    );
  }

  const at = now();
  // 先记录「谁建的案」（含费率是否待确认）：用户触发的变更一律带 actorUserId。
  const createdRow = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: 'case.created',
      entityType: 'Case',
      entityId: outcome.caseId,
      changes: {
        opportunityId: opportunity.id,
        caseNo: outcome.caseNo,
        caseCreated: existing === null,
        commercialTermsPending: terms === null,
      },
    },
    { maxStringLength: 512 },
  );
  await prisma.auditLog.create({ data: auditData(createdRow, at) });

  // 费率只有在本次明确给出时才落审计（不推测、不使用默认值）
  if (terms) {
    const termsRow = prepareAuditInsert(
      {
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'commercial_terms.created',
        entityType: 'Case',
        entityId: outcome.caseId,
        // 裁定 1：只记录费率与来源，绝不记录银行信息 / 支付凭证 / 合同正文。
        changes: {
          successFeeRate: terms.successFeeRate,
          source: terms.source,
          opportunityId: opportunity.id,
          caseNo: outcome.caseNo,
          caseCreated: existing === null,
        },
      },
      { maxStringLength: 512 },
    );
    await prisma.auditLog.create({ data: auditData(termsRow, at) });
  }

  return {
    caseId: outcome.caseId,
    caseNo: outcome.caseNo,
    opportunityId: opportunity.id,
    claimId: outcome.claimId,
    created: existing === null,
    commercialTerms: terms,
    commercialTermsPending: terms === null,
  };
}

/**
 * 商务确认（OWNER / ADMIN）：为已经存在的案件确认成功费率。
 * 「费率是否待确认」是业务条件：以该案件是否存在 commercial_terms.created 审计为准，
 * 不新增 Schema 字段。
 */
export async function confirmCommercialTerms(
  prisma: PrismaClient,
  input: ConfirmCommercialTermsInput,
  now: () => Date = () => new Date(),
): Promise<ConfirmCommercialTermsResult> {
  assertPermission(input.role, 'setCommercialTerms');
  const terms = parseCommercialTerms(input.commercialTerms);

  const kase = await prisma.case.findFirst({
    where: { id: input.caseId, organizationId: input.organizationId },
    select: { id: true, caseNo: true },
  });
  if (!kase) {
    throw new WorkflowError('NOT_FOUND', `案件 ${input.caseId} 不存在或不属于该租户`);
  }

  const alreadyConfirmed =
    (await prisma.auditLog.count({
      where: {
        organizationId: input.organizationId,
        entityType: 'Case',
        entityId: kase.id,
        action: 'commercial_terms.created',
      },
    })) > 0;

  const at = now();
  const row = prepareAuditInsert(
    {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.actorUserId,
      action: 'commercial_terms.created',
      entityType: 'Case',
      entityId: kase.id,
      changes: {
        successFeeRate: terms.successFeeRate,
        source: terms.source,
        caseNo: kase.caseNo,
        reConfirmed: alreadyConfirmed,
      },
    },
    { maxStringLength: 512 },
  );
  await prisma.auditLog.create({ data: auditData(row, at) });

  return { caseId: kase.id, caseNo: kase.caseNo, confirmed: true, alreadyConfirmed };
}
