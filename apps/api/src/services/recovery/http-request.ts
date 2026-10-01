/**
 * R44 —— Manual Recovery HTTP/API Boundary（HOST DIRECTIVE 2026-10-01 · MSG-20261001-39 NEXT）
 * ---------------------------------------------------------------------------------------
 * 本层**只做入口边界**，绝不复制 R43 S3/S4 的事务逻辑：
 *   · 身份 / 租户来自服务端会话与路径；请求体不得自述 organizationId（一律 400）；
 *   · 目标必须在会话租户与案件内 —— 跨租户 / 错案件一律 **404**（不泄露存在性）；
 *   · package 与 versioned basis 由服务端从 DB 事实解析并重算；客户端自证
 *     packageDigest / approvalBasisReference / packageVersion / digestVersion 一律 400；
 *   · 幂等键由服务端派生（rms1-<claimItemId>）；客户端显式给出必须逐字节一致，否则 409；
 *   · Action Guard（recovery.manual_submit / recovery.manual_submit_reference_recorded · humanApproval）
 *     必须先于任何副作用；未注入 → 403（fail closed）；
 *   · 业务执行完全复用 R43 S3/S4 服务（锁内重验主体与审批、同事务原子提交 / 补录）；
 *   · 响应恒为 platformWriteExecuted=false：人工提交 externalSubmission='NEEDS_MANUAL'，
 *     补录 providerAccepted=false（不得被解释为 provider 已受理/已赔付）。
 */

import type { PrismaClient, RecoveryPackageStatus } from '@prisma/client';

import { ActionGuardNotConfiguredError } from '../action-guard/guard-enforcement';
import { createHitlSubmissionBoundary } from '../action-guard/hitl-submission';
import { createPrismaActionGuardAuditPort } from '../action-guard/runtime-guard-composition';
import type { RuntimeActionGuard } from '../action-guard/runtime-guard';
import { RECOVERY_MANUAL_REFERENCE_ACTION, RECOVERY_MANUAL_SUBMIT_ACTION } from '../action-guard/approval-verifier';
import {
  canonicalizeProviderCaseRef,
  buildRecoveryReferenceBasisReference,
  recordManualRecoveryReference,
} from './manual-reference';
import { submitManualRecoveryWithApproval } from './manual-submission';
import { submitRecoveryReview } from '../workflow/recovery-review';
import { buildRecoveryPackageBasisReference } from './recovery-package';

export const RECOVERY_MANUAL_HTTP_CODES = [
  'RECOVERY_MANUAL_INVALID_BODY',
  'RECOVERY_MANUAL_CLIENT_ASSERTION_REJECTED',
  'RECOVERY_MANUAL_IDEMPOTENCY_KEY_MISMATCH',
  'RECOVERY_MANUAL_CLAIM_NOT_FOUND',
  'RECOVERY_MANUAL_PACKAGE_NOT_FOUND',
  'RECOVERY_MANUAL_NO_SUBMITTABLE_PACKAGE',
  'RECOVERY_MANUAL_SUBMISSION_NOT_FOUND',
  'RECOVERY_MANUAL_REFERENCE_REQUIRED',
  'RECOVERY_MANUAL_APPROVAL_INVALID_DECISION',
  'RECOVERY_MANUAL_APPROVAL_PACKAGE_TERMINAL',
] as const;
export type RecoveryManualHttpCode = (typeof RECOVERY_MANUAL_HTTP_CODES)[number];

export class RecoveryManualHttpError extends Error {
  readonly code: RecoveryManualHttpCode;
  readonly httpStatus: number;

  constructor(code: RecoveryManualHttpCode, httpStatus: number, message: string) {
    super(code + ': ' + message);
    this.name = 'RecoveryManualHttpError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 客户端**不得**自证的服务端事实字段（出现即结构化拒绝） */
export const RECOVERY_MANUAL_CLIENT_ASSERTION_FIELDS: readonly string[] = [
  'organizationId',
  'packageDigest',
  'approvalBasisReference',
  'basisReference',
  'packageVersion',
  'digestVersion',
  'providerCaseRefCanonical',
  'status',
  'submittedAt',
  'providerAccepted',
  'platformWriteExecuted',
];

/** 可用于人工提交的 package 状态（终态 SUPERSEDED / WITHDRAWN 一律不可提交） */
export const RECOVERY_MANUAL_SUBMITTABLE_PACKAGE_STATUSES: readonly RecoveryPackageStatus[] = [
  'GENERATED',
  'EXPORTED',
];

export interface RecoveryManualRouteContext {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
}

export interface RecoveryManualRequestDeps {
  prisma: PrismaClient;
  /** 未注入时受保护入口一律拒绝（fail closed） */
  actionGuard?: RuntimeActionGuard;
  now?: () => Date;
}

export interface ResolvedManualSubmissionTarget {
  claimItemId: string;
  caseId: string;
  packageId: string;
  packageVersion: string;
  digestVersion: string;
  packageDigest: string;
  /** 服务端用唯一 builder 重算的 versioned basis（rmp1:…） */
  basisReference: string;
  /** 服务端派生幂等键（rms1-<claimItemId>） */
  idempotencyKey: string;
}

export interface ManualSubmissionHttpResponse {
  claimItemId: string;
  submissionId: string;
  caseId: string;
  packageId: string;
  packageDigest: string;
  approvalBasisReference: string;
  status: 'SUBMITTED_MANUAL';
  submittedAt: string;
  externalSubmission: 'NEEDS_MANUAL';
  platformWriteExecuted: false;
}

export interface ManualReferenceHttpResponse {
  referenceId: string;
  submissionId: string;
  claimItemId: string;
  providerCaseRefRaw: string;
  providerCaseRefCanonical: string;
  recordedAt: string;
  approvalBasisReference: string;
  providerAccepted: false;
  platformWriteExecuted: false;
}


export interface ManualSubmitApprovalHttpResponse {
  decision: 'REQUEST' | 'APPROVE';
  caseId: string;
  claimItemId: string;
  packageId: string;
  approvalBasisReference: string;
  /** REVIEW 阶段为 PENDING；APPROVE 阶段为 approvalId */
  state?: 'PENDING';
  approvalId?: string;
  expiresAt?: string | null;
  /** true = 复用了同 action + 同 basis 的既有未消费未过期审批（幂等） */
  idempotent: boolean;
  /** 审批创建恒不产生任何执行/资金副作用 */
  platformWriteExecuted: false;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function invalidBody(message: string): RecoveryManualHttpError {
  return new RecoveryManualHttpError('RECOVERY_MANUAL_INVALID_BODY', 400, message);
}

function notFound(code: RecoveryManualHttpCode, message: string): RecoveryManualHttpError {
  return new RecoveryManualHttpError(code, 404, message);
}

/** 客户端自证一律拒绝：服务端事实只能由服务端重算（禁止自证 digest / basis / version） */
function rejectClientAssertions(body: Record<string, unknown>, caseId: string): void {
  for (const field of RECOVERY_MANUAL_CLIENT_ASSERTION_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === '') continue;
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_CLIENT_ASSERTION_REJECTED',
      400,
      '请求体不得包含服务端事实字段: ' + field,
    );
  }
  const bodyCaseId = str(body.caseId);
  if (bodyCaseId !== '' && bodyCaseId !== caseId) {
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_CLIENT_ASSERTION_REJECTED',
      400,
      '请求体 caseId 与路径不一致',
    );
  }
}

/**
 * 服务端解析目标 package 与 versioned basis：
 *   · ClaimItem 必须在租户 + 案件内，否则 404；
 *   · 客户端给出 packageId 时必须同租户 / 同 ClaimItem / 同案件，否则 404（不泄露存在性）；
 *   · 未给出 packageId 时取该 ClaimItem 最近一个**非终态** package，缺失则 409；
 *   · basis 用唯一 builder 重算（客户端无法自证）。
 */
export async function resolveManualSubmissionTarget(
  prisma: PrismaClient,
  args: { organizationId: string; caseId: string; claimItemId: string; packageId?: string },
): Promise<ResolvedManualSubmissionTarget> {
  const claim = await prisma.claimItem.findFirst({
    where: { id: args.claimItemId, organizationId: args.organizationId, caseId: args.caseId },
    select: { id: true },
  });
  if (!claim) throw notFound('RECOVERY_MANUAL_CLAIM_NOT_FOUND', '目标 ClaimItem 不存在或不属于该案件');

  const select = {
    id: true,
    packageVersion: true,
    digestVersion: true,
    packageDigest: true,
    status: true,
  } as const;

  const pkg = args.packageId
    ? await prisma.recoveryPackage.findFirst({
        where: {
          id: args.packageId,
          organizationId: args.organizationId,
          claimItemId: claim.id,
          caseId: args.caseId,
        },
        select,
      })
    : await prisma.recoveryPackage.findFirst({
        where: {
          organizationId: args.organizationId,
          claimItemId: claim.id,
          status: { in: [...RECOVERY_MANUAL_SUBMITTABLE_PACKAGE_STATUSES] },
        },
        orderBy: { generatedAt: 'desc' },
        select,
      });

  if (!pkg) {
    if (args.packageId) {
      throw notFound('RECOVERY_MANUAL_PACKAGE_NOT_FOUND', '目标 RecoveryPackage 不存在或不属于该 ClaimItem');
    }
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_NO_SUBMITTABLE_PACKAGE',
      409,
      '该 ClaimItem 没有可提交的材料包（GENERATED / EXPORTED）',
    );
  }

  const basisReference = buildRecoveryPackageBasisReference({
    claimItemId: claim.id,
    caseId: args.caseId,
    packageVersion: pkg.packageVersion,
    digestVersion: pkg.digestVersion,
    packageDigest: pkg.packageDigest,
  });

  return {
    claimItemId: claim.id,
    caseId: args.caseId,
    packageId: pkg.id,
    packageVersion: pkg.packageVersion,
    digestVersion: pkg.digestVersion,
    packageDigest: pkg.packageDigest,
    basisReference,
    idempotencyKey: 'rms1-' + claim.id,
  };
}

/**
 * `POST /cases/:caseId/recovery/manual-submit`
 * 入口边界 → Action Guard（humanApproval）→ **复用 R43 S3 服务**（锁内重验 + 同事务原子提交）。
 */
export async function requestManualRecoverySubmit(
  context: RecoveryManualRouteContext,
  body: Record<string, unknown>,
  deps: RecoveryManualRequestDeps,
): Promise<{ httpStatus: number; body: ManualSubmissionHttpResponse }> {
  rejectClientAssertions(body, context.caseId);

  const claimItemId = str(body.claimItemId);
  if (claimItemId === '') throw invalidBody('claimItemId 必填');

  const packageId = str(body.packageId);
  const target = await resolveManualSubmissionTarget(deps.prisma, {
    organizationId: context.organizationId,
    caseId: context.caseId,
    claimItemId,
    ...(packageId !== '' ? { packageId } : {}),
  });

  const declaredKey = str(body.idempotencyKey);
  if (declaredKey !== '' && declaredKey !== target.idempotencyKey) {
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_IDEMPOTENCY_KEY_MISMATCH',
      409,
      '客户端声明的幂等键与服务端派生结果不一致',
    );
  }

  if (!deps.actionGuard) throw new ActionGuardNotConfiguredError(RECOVERY_MANUAL_SUBMIT_ACTION);

  const approvalId = str(body.approvalId);
  const note = str(body.note);
  const evidenceIds = Array.isArray(body.evidenceIds)
    ? body.evidenceIds.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];

  const boundary = createHitlSubmissionBoundary({
    guard: deps.actionGuard,
    prisma: deps.prisma,
    audit: createPrismaActionGuardAuditPort(deps.prisma),
  });

  const result = await boundary.submit<Awaited<ReturnType<typeof submitManualRecoveryWithApproval>>>({
    action: RECOVERY_MANUAL_SUBMIT_ACTION,
    organizationId: context.organizationId,
    actorUserId: context.actorUserId,
    targetRef: context.caseId,
    ...(approvalId !== '' ? { approvalId } : {}),
    // 审批指纹绑定 = 服务端重算的 versioned basis（与 S3 执行时同一 builder，客户端无法自证）
    payload: { recoveredAmount: null, currency: null, basisReference: target.basisReference, evidenceArtifactId: null },
    perform: () =>
      submitManualRecoveryWithApproval(
        {
          organizationId: context.organizationId,
          actorUserId: context.actorUserId,
          role: context.role,
          claimItemId: target.claimItemId,
          packageId: target.packageId,
          idempotencyKey: target.idempotencyKey,
          ...(approvalId !== '' ? { approvalId } : {}),
          ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
          ...(note !== '' ? { note } : {}),
        },
        { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) },
      ),
  });

  return {
    httpStatus: 200,
    body: {
      claimItemId: result.claimItemId,
      submissionId: result.submissionId,
      caseId: result.caseId,
      packageId: result.packageId,
      packageDigest: result.packageDigest,
      approvalBasisReference: result.approvalBasisReference,
      status: 'SUBMITTED_MANUAL',
      submittedAt: result.submittedAt,
      externalSubmission: 'NEEDS_MANUAL',
      platformWriteExecuted: false,
    },
  };
}

/**
 * `POST /cases/:caseId/recovery/manual-reference`
 * 入口边界 → Action Guard（humanApproval）→ **复用 R43 S4 服务**（独立动作 / 独立 binding / append-only）。
 * canonical 恒由服务端计算（客户端不得自证）。
 */
export async function requestManualRecoveryReference(
  context: RecoveryManualRouteContext,
  body: Record<string, unknown>,
  deps: RecoveryManualRequestDeps,
): Promise<{ httpStatus: number; body: ManualReferenceHttpResponse }> {
  rejectClientAssertions(body, context.caseId);

  const submissionId = str(body.submissionId);
  if (submissionId === '') throw invalidBody('submissionId 必填');

  const rawRef =
    typeof body.providerCaseRefRaw === 'string'
      ? body.providerCaseRefRaw
      : typeof body.providerCaseRef === 'string'
        ? body.providerCaseRef
        : '';
  if (rawRef.trim() === '') {
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_REFERENCE_REQUIRED',
      400,
      'providerCaseRefRaw 必填（原始输入由服务端 canonical 化）',
    );
  }

  const submission = await deps.prisma.recoveryManualSubmission.findFirst({
    where: { id: submissionId, organizationId: context.organizationId },
    select: { id: true, claimItemId: true, caseId: true },
  });
  if (!submission || submission.caseId !== context.caseId) {
    throw notFound('RECOVERY_MANUAL_SUBMISSION_NOT_FOUND', 'RecoveryManualSubmission 不存在或不属于该案件');
  }

  // canonical 化（含空值校验）恒在服务端完成；客户端传入 canonical 会在上面被结构化拒绝
  const canonical = canonicalizeProviderCaseRef(rawRef);
  const basisReference = buildRecoveryReferenceBasisReference({
    submissionId: submission.id,
    claimItemId: submission.claimItemId,
    providerCaseRefCanonical: canonical,
  });

  if (!deps.actionGuard) throw new ActionGuardNotConfiguredError(RECOVERY_MANUAL_REFERENCE_ACTION);

  const approvalId = str(body.approvalId);
  const note = str(body.note);

  const boundary = createHitlSubmissionBoundary({
    guard: deps.actionGuard,
    prisma: deps.prisma,
    audit: createPrismaActionGuardAuditPort(deps.prisma),
  });

  const result = await boundary.submit<Awaited<ReturnType<typeof recordManualRecoveryReference>>>({
    action: RECOVERY_MANUAL_REFERENCE_ACTION,
    organizationId: context.organizationId,
    actorUserId: context.actorUserId,
    targetRef: context.caseId,
    ...(approvalId !== '' ? { approvalId } : {}),
    payload: { recoveredAmount: null, currency: null, basisReference, evidenceArtifactId: null },
    perform: () =>
      recordManualRecoveryReference(
        {
          organizationId: context.organizationId,
          actorUserId: context.actorUserId,
          role: context.role,
          submissionId: submission.id,
          providerCaseRefRaw: rawRef,
          ...(approvalId !== '' ? { approvalId } : {}),
          ...(note !== '' ? { note } : {}),
        },
        { prisma: deps.prisma, ...(deps.now ? { now: deps.now } : {}) },
      ),
  });

  return {
    httpStatus: 200,
    body: {
      referenceId: result.referenceId,
      submissionId: result.submissionId,
      claimItemId: result.claimItemId,
      providerCaseRefRaw: result.providerCaseRefRaw,
      providerCaseRefCanonical: result.providerCaseRefCanonical,
      recordedAt: result.recordedAt,
      approvalBasisReference: result.approvalBasisReference,
      providerAccepted: false,
      platformWriteExecuted: false,
    },
  };
}

/**
 * `POST /cases/:caseId/recovery/manual-submit-approval`（R44-A）
 * -----------------------------------------------------------------
 * 职责：**只创建审批事实**，不执行提交、不改变 ClaimItem、不产生 Submission、不消费审批。
 * 与 execution 使用**同一个** server-side package/basis builder（resolveManualSubmissionTarget），
 * 客户端不得自证 digest / basis / version；creation 与 execution 的事实构造逻辑完全同源。
 *
 * decision：
 *   · `REQUEST` —— 建立待审批请求（PENDING）
 *   · `APPROVE` —— 在既有 PENDING 之上创建 approval（含 boundAction 与五元 versioned basis）
 *     · 幂等：同 action + 同 basis 的既有未消费且未过期 approval 直接复用（不新建事件）
 */
export async function requestManualRecoverySubmitApproval(
  context: RecoveryManualRouteContext,
  body: Record<string, unknown>,
  deps: RecoveryManualRequestDeps,
): Promise<{ httpStatus: number; body: ManualSubmitApprovalHttpResponse }> {
  rejectClientAssertions(body, context.caseId);

  const claimItemId = str(body.claimItemId);
  if (claimItemId === '') throw invalidBody('claimItemId 必填');

  const rawDecision = str(body.decision).toUpperCase();
  const decision = rawDecision === '' ? 'APPROVE' : rawDecision;
  if (decision !== 'REQUEST' && decision !== 'APPROVE') {
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_APPROVAL_INVALID_DECISION',
      400,
      'decision 必须是 REQUEST 或 APPROVE',
    );
  }

  const packageId = str(body.packageId);
  // 与 execution 同一个服务端解析器 / 同一个 basis builder（不得出现第二套事实构造）
  const target = await resolveManualSubmissionTarget(deps.prisma, {
    organizationId: context.organizationId,
    caseId: context.caseId,
    claimItemId,
    ...(packageId !== '' ? { packageId } : {}),
  });

  // 终态 package 不得创建新 approval（execution 侧同样拒绝使用终态 package）
  const pkg = await deps.prisma.recoveryPackage.findFirst({
    where: { id: target.packageId, organizationId: context.organizationId },
    select: { status: true },
  });
  if (!pkg) throw notFound('RECOVERY_MANUAL_PACKAGE_NOT_FOUND', '目标 RecoveryPackage 不存在');
  if (!RECOVERY_MANUAL_SUBMITTABLE_PACKAGE_STATUSES.includes(pkg.status)) {
    throw new RecoveryManualHttpError(
      'RECOVERY_MANUAL_APPROVAL_PACKAGE_TERMINAL',
      409,
      'RecoveryPackage 已处于终态（' + pkg.status + '），不得创建新 approval',
    );
  }

  const base = {
    caseId: context.caseId,
    claimItemId: target.claimItemId,
    packageId: target.packageId,
    approvalBasisReference: target.basisReference,
  };

  if (decision === 'APPROVE') {
    const reusable = await findReusableManualSubmitApproval(deps.prisma, {
      organizationId: context.organizationId,
      caseId: context.caseId,
      basisReference: target.basisReference,
    });
    if (reusable) {
      return {
        httpStatus: 200,
        body: { ...base, decision: 'APPROVE', approvalId: reusable.approvalId, expiresAt: reusable.expiresAt, idempotent: true, platformWriteExecuted: false },
      };
    }
  }

  const ttlRaw = body.approvalTtlMs;
  const note = str(body.note);
  const review = (await submitRecoveryReview(
    deps.prisma,
    {
      organizationId: context.organizationId,
      actorUserId: context.actorUserId,
      role: context.role,
      caseId: context.caseId,
      decision,
      ...(note !== '' ? { reason: undefined } : {}),
      ...(decision === 'APPROVE'
        ? {
            boundAction: RECOVERY_MANUAL_SUBMIT_ACTION,
            boundPayload: { basisReference: target.basisReference },
            boundExtra: {
              claimItemId: target.claimItemId,
              caseId: target.caseId,
              packageVersion: target.packageVersion,
              digestVersion: target.digestVersion,
              packageDigest: target.packageDigest,
            },
            ...(typeof ttlRaw === 'number' ? { approvalTtlMs: ttlRaw } : {}),
          }
        : {}),
    } as never,
    deps.now ?? (() => new Date()),
  )) as { approvalId?: string; state?: string; lastEventAt?: Date };

  if (decision === 'REQUEST') {
    return {
      httpStatus: 200,
      body: { ...base, decision: 'REQUEST', state: 'PENDING', idempotent: false, platformWriteExecuted: false },
    };
  }

  if (!review.approvalId) throw invalidBody('审批创建失败（未返回 approvalId）');
  return {
    httpStatus: 200,
    body: {
      ...base,
      decision: 'APPROVE',
      approvalId: review.approvalId,
      expiresAt: null,
      idempotent: false,
      platformWriteExecuted: false,
    },
  };
}

/** 复用同一 action + 同一 versioned basis 的既有审批（未消费、未过期）——creation 幂等 */
async function findReusableManualSubmitApproval(
  prisma: PrismaClient,
  args: { organizationId: string; caseId: string; basisReference: string },
): Promise<{ approvalId: string; expiresAt: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; expires_at: Date | null }>>(
    'SELECT a.id AS id, (a.changes ->> \'expiresAt\')::timestamptz AS expires_at\n' +
      '  FROM "AuditLog" a\n' +
      ' WHERE a."organizationId" = $1\n' +
      "   AND a.action = 'recovery.review_approved'\n" +
      "   AND a.\"entityType\" = 'Case' AND a.\"entityId\" = $2\n" +
      "   AND a.changes ->> 'boundAction' = $3\n" +
      "   AND a.changes -> 'boundPayload' ->> 'basisReference' = $4\n" +
      '   AND (a.changes ->> \'expiresAt\')::timestamptz > now()\n' +
      '   AND NOT EXISTS (\n' +
      '     SELECT 1 FROM "AuditLog" c\n' +
      '      WHERE c."organizationId" = a."organizationId"\n' +
      "        AND c.action = 'recovery.approval_consumed'\n" +
      "        AND c.changes ->> 'approvalId' = a.id)\n" +
      ' ORDER BY a."createdAt" DESC\n' +
      ' LIMIT 1',
    args.organizationId,
    args.caseId,
    RECOVERY_MANUAL_SUBMIT_ACTION,
    args.basisReference,
  );
  const row = rows[0];
  if (!row) return null;
  return { approvalId: row.id, expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null };
}
