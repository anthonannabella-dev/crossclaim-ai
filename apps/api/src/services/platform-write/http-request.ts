/**
 * platform.write HTTP 入口（R37 P1/P2；MSG-20261001-22 CHANGE A/B）
 * ---------------------------------------------------------------
 * 逐层不变量（与 docs/releases/INTEGRATION-BOUNDARY-REVIEW-PLAN.md §1 一致）：
 *   · 身份 / 租户来自服务端会话与路径，**不接受**请求体自述 organizationId；
 *   · 目标对象必须属于会话租户的案件（跨租户一律 404，不泄露存在性）；
 *   · 快照与摘要由服务端从 DB 事实重算；客户端提交的 digest / basisReference / payload 一律拒绝（禁止自证）；
 *   · 幂等键由服务端派生；客户端若显式给出，必须与服务端派生结果逐字节一致，否则 409；
 *   · Action Guard（platform.write · EXTERNAL_WRITE · humanApproval）必须先于任何副作用；
 *   · transport 恒关（PLATFORM_WRITE_TRANSPORT_ENABLED=false）：零投递、零账本写入、不消费审批；
 *   · HTTP 层不得直接调用投递端口；投递只可能由编排层在取得执行权（T1）之后发生。
 */

import type { PrismaClient } from '@prisma/client';

import { PLATFORM_WRITE_ACTION } from '../action-guard/approval-verifier';
import { ActionGuardNotConfiguredError } from '../action-guard/guard-enforcement';
import { createHitlSubmissionBoundary } from '../action-guard/hitl-submission';
import { createPrismaActionGuardAuditPort } from '../action-guard/runtime-guard-composition';
import type { RuntimeActionGuard } from '../action-guard/runtime-guard';
import {
  assertNoProviderSuccessFields,
  buildPlatformWriteResponse,
  type PlatformWriteHttpResponse,
  type PlatformWriteInternalResult,
} from './response-contract';
import { buildPlatformWriteSnapshot, deriveIdempotencyKey, snapshotDigest } from './snapshot';
import { createPrismaPlatformWriteApprovalInTxPort } from './approval-tx-port';
import { runPlatformWriteAttempt } from './orchestrator';
import {
  PLATFORM_WRITE_SNAPSHOT_VERSION,
  PLATFORM_WRITE_TARGET_KINDS,
  PLATFORM_WRITE_TRANSPORT_ENABLED,
  type PlatformWriteTargetKind,
} from './types';

export const PLATFORM_WRITE_REQUEST_CODES = [
  'PLATFORM_WRITE_INVALID_BODY',
  'PLATFORM_WRITE_CLIENT_ASSERTION_REJECTED',
  'PLATFORM_WRITE_IDEMPOTENCY_KEY_MISMATCH',
  'PLATFORM_WRITE_PLATFORM_REQUIRED',
  'PLATFORM_WRITE_TARGET_NOT_FOUND',
  'PLATFORM_WRITE_TARGET_AMBIGUOUS',
  'PLATFORM_WRITE_TRANSPORT_NOT_WIRED',
  'PLATFORM_WRITE_SINK_CALLED_WITHOUT_TRANSPORT',
] as const;
export type PlatformWriteRequestCode = (typeof PLATFORM_WRITE_REQUEST_CODES)[number];

/** 请求/入口层的结构化错误（带稳定 HTTP 映射） */
export class PlatformWriteRequestError extends Error {
  readonly code: PlatformWriteRequestCode;
  readonly httpStatus: number;

  constructor(code: PlatformWriteRequestCode, httpStatus: number, message: string) {
    super(code + ': ' + message);
    this.name = 'PlatformWriteRequestError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 客户端**不得**自证的服务端事实字段（出现在请求体即结构化拒绝） */
export const PLATFORM_WRITE_CLIENT_ASSERTION_FIELDS: readonly string[] = [
  'organizationId',
  'snapshotDigest',
  'basisReference',
  'payloadDigest',
  'payload',
];

export interface PlatformWriteRouteContext {
  organizationId: string;
  actorUserId: string;
  role: string;
  caseId: string;
}

export interface PlatformWriteRequestDeps {
  prisma: PrismaClient;
  /** 未注入时受保护入口一律拒绝（fail closed） */
  actionGuard?: RuntimeActionGuard;
  /** 仅组合根 / 测试可覆盖；生产默认取硬开关（恒 false） */
  transportEnabled?: boolean;
}

export interface PlatformWriteTargetFact {
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  targetStatus: string;
  targetRound: number;
}

export interface ServerSidePlatformWriteSnapshot {
  target: PlatformWriteTargetFact;
  snapshot: ReturnType<typeof buildPlatformWriteSnapshot>;
  digest: string;
  idempotencyKey: string;
}

function targetNotFound(message: string): PlatformWriteRequestError {
  return new PlatformWriteRequestError('PLATFORM_WRITE_TARGET_NOT_FOUND', 404, message);
}

/** 客户端自证一律拒绝：服务端事实只能由服务端重算 */
function rejectClientAssertions(body: Record<string, unknown>, caseId: string): void {
  for (const field of PLATFORM_WRITE_CLIENT_ASSERTION_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === '') continue;
    throw new PlatformWriteRequestError(
      'PLATFORM_WRITE_CLIENT_ASSERTION_REJECTED',
      400,
      '请求体不得包含服务端事实字段: ' + field,
    );
  }
  const bodyCaseId = typeof body.caseId === 'string' ? body.caseId.trim() : '';
  if (bodyCaseId !== '' && bodyCaseId !== caseId) {
    throw new PlatformWriteRequestError(
      'PLATFORM_WRITE_CLIENT_ASSERTION_REJECTED',
      400,
      '请求体 caseId 与路径不一致',
    );
  }
}

/** 目标解析（租户 + 案件双重限定；跨租户一律 404） */
export async function resolvePlatformWriteTarget(
  prisma: PrismaClient,
  args: {
    organizationId: string;
    caseId: string;
    targetKind: PlatformWriteTargetKind;
    targetId?: string;
  },
): Promise<PlatformWriteTargetFact> {
  if (args.targetKind === 'CLAIM') {
    if (args.targetId) {
      const claim = await prisma.claim.findFirst({
        where: { id: args.targetId, organizationId: args.organizationId, caseId: args.caseId },
        select: { id: true, status: true, round: true },
      });
      if (!claim) throw targetNotFound('目标 Claim 不存在或不属于该案件');
      return { targetKind: 'CLAIM', targetId: claim.id, targetStatus: claim.status, targetRound: claim.round };
    }
    const claim = await prisma.claim.findFirst({
      where: { organizationId: args.organizationId, caseId: args.caseId, round: 1 },
      select: { id: true, status: true, round: true },
    });
    if (!claim) throw targetNotFound('案件没有第 1 轮 Claim');
    return { targetKind: 'CLAIM', targetId: claim.id, targetStatus: claim.status, targetRound: claim.round };
  }

  if (args.targetId) {
    const appeal = await prisma.appeal.findFirst({
      where: { id: args.targetId, organizationId: args.organizationId, caseId: args.caseId },
      select: { id: true, status: true, round: true },
    });
    if (!appeal) throw targetNotFound('目标 Appeal 不存在或不属于该案件');
    return { targetKind: 'APPEAL', targetId: appeal.id, targetStatus: appeal.status, targetRound: appeal.round };
  }

  const appeals = await prisma.appeal.findMany({
    where: { organizationId: args.organizationId, caseId: args.caseId },
    orderBy: { round: 'desc' },
    take: 2,
    select: { id: true, status: true, round: true },
  });
  if (appeals.length === 0) throw targetNotFound('案件没有 Appeal');
  const latest = appeals[0]!;
  if (appeals.length > 1 && appeals[1]!.round === latest.round) {
    throw new PlatformWriteRequestError(
      'PLATFORM_WRITE_TARGET_AMBIGUOUS',
      409,
      '同一轮次存在多条 Appeal，需人工澄清后再提交',
    );
  }
  return { targetKind: 'APPEAL', targetId: latest.id, targetStatus: latest.status, targetRound: latest.round };
}

/**
 * 服务端快照：载荷只由 DB 事实构成，绝不接收 / 回显客户端自由文本或指纹。
 * 审批创建与执行核验必须用同一函数得到的 digest（否则审批绑定必然不匹配）。
 */
export async function buildServerSidePlatformWriteSnapshot(
  prisma: PrismaClient,
  args: {
    organizationId: string;
    caseId: string;
    targetKind: PlatformWriteTargetKind;
    targetId?: string;
    platform: string;
  },
): Promise<ServerSidePlatformWriteSnapshot> {
  const kase = await prisma.case.findFirst({
    where: { id: args.caseId, organizationId: args.organizationId },
    select: {
      id: true,
      caseNo: true,
      domain: true,
      status: true,
      claimedAmount: true,
      recoveredAmount: true,
      currency: true,
    },
  });
  if (!kase) throw targetNotFound('案件不存在或不属于当前租户');

  const target = await resolvePlatformWriteTarget(prisma, args);
  const evidenceCount = await prisma.caseEvidence.count({
    where: { organizationId: args.organizationId, caseId: args.caseId },
  });

  const payload: Record<string, unknown> = {
    snapshotVersion: PLATFORM_WRITE_SNAPSHOT_VERSION,
    caseNo: kase.caseNo,
    domain: kase.domain,
    caseStatus: kase.status,
    claimedAmount: kase.claimedAmount === null ? null : kase.claimedAmount.toFixed(4),
    recoveredAmount: kase.recoveredAmount.toFixed(4),
    currency: kase.currency,
    targetKind: target.targetKind,
    targetId: target.targetId,
    targetStatus: target.targetStatus,
    targetRound: target.targetRound,
    evidenceCount,
  };

  const snapshot = buildPlatformWriteSnapshot({
    organizationId: args.organizationId,
    caseId: args.caseId,
    targetKind: target.targetKind,
    targetId: target.targetId,
    platform: args.platform,
    payload,
  });
  const digest = snapshotDigest(snapshot);
  return { target, snapshot, digest, idempotencyKey: deriveIdempotencyKey(digest) };
}

/**
 * 入口编排（HTTP → 守卫 → 快照/审批绑定 → 执行）。transport 关闭时为本阶段的终态：
 * 只登记「需人工处置」，零投递、零账本写入、不消费审批。
 */
export async function requestPlatformWrite(
  context: PlatformWriteRouteContext,
  body: Record<string, unknown>,
  deps: PlatformWriteRequestDeps,
): Promise<{ httpStatus: number; body: PlatformWriteHttpResponse }> {
  rejectClientAssertions(body, context.caseId);

  const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
  if (platform === '') {
    throw new PlatformWriteRequestError('PLATFORM_WRITE_PLATFORM_REQUIRED', 400, 'platform 必填');
  }
  const rawKind = typeof body.targetKind === 'string' ? body.targetKind.trim().toUpperCase() : 'CLAIM';
  if (!(PLATFORM_WRITE_TARGET_KINDS as readonly string[]).includes(rawKind)) {
    throw new PlatformWriteRequestError('PLATFORM_WRITE_INVALID_BODY', 400, 'targetKind 必须是 CLAIM 或 APPEAL');
  }
  const targetKind = rawKind as PlatformWriteTargetKind;
  const targetId =
    typeof body.targetId === 'string' && body.targetId.trim() !== '' ? body.targetId.trim() : undefined;

  const bundle = await buildServerSidePlatformWriteSnapshot(deps.prisma, {
    organizationId: context.organizationId,
    caseId: context.caseId,
    targetKind,
    platform,
    ...(targetId ? { targetId } : {}),
  });

  const declaredKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (declaredKey !== '' && declaredKey !== bundle.idempotencyKey) {
    throw new PlatformWriteRequestError(
      'PLATFORM_WRITE_IDEMPOTENCY_KEY_MISMATCH',
      409,
      '客户端声明的幂等键与服务端派生结果不一致',
    );
  }

  if (!deps.actionGuard) {
    // fail closed：受保护入口必须在组合根注入 Action Guard
    throw new ActionGuardNotConfiguredError(PLATFORM_WRITE_ACTION);
  }

  const approvalId =
    typeof body.approvalId === 'string' && body.approvalId.trim() !== '' ? body.approvalId.trim() : undefined;
  const transportEnabled = deps.transportEnabled ?? PLATFORM_WRITE_TRANSPORT_ENABLED;

  const boundary = createHitlSubmissionBoundary({
    guard: deps.actionGuard,
    prisma: deps.prisma,
    audit: createPrismaActionGuardAuditPort(deps.prisma),
  });

  const internal = await boundary.submit<PlatformWriteInternalResult>({
    action: PLATFORM_WRITE_ACTION,
    organizationId: context.organizationId,
    actorUserId: context.actorUserId,
    targetRef: context.caseId,
    ...(approvalId ? { approvalId } : {}),
    // 审批指纹绑定：只绑定服务端重算的快照摘要（客户端无法自证）
    payload: { basisReference: bundle.digest },
    perform: async () => {
      if (transportEnabled) {
        // transport 一旦开启必须走 T1（执行权）→ T2（事务外投递）→ T3（独立事务收敛），
        // 且真实响应语义尚未定义（MSG-20261001-23 CHANGE C）：失败关闭，绝不静默降级。
        throw new PlatformWriteRequestError(
          'PLATFORM_WRITE_TRANSPORT_NOT_WIRED',
          503,
          'transport 开启路径尚未接线（需真实 adapter 与响应契约单独裁决）',
        );
      }
      // HTTP 层唯一执行入口 = 编排器（T1/T2/T3 只能由它触发）。
      // 门控在编排器内判定：transport 恒关 → 拒绝 → NEEDS_MANUAL，
      // 零账本、零审批消费、零投递（CHANGE A）。
      const orchestrated = await runPlatformWriteAttempt(
        deps.prisma,
        {
          approvals: createPrismaPlatformWriteApprovalInTxPort(),
          // HTTP 层不持有任何 write sink：即使门控被放开也不存在投递面
          sink: null,
          // 守卫已放行才会执行到这里（withActionGuard ALLOW）
          authorizationValid: true,
        },
        {
          organizationId: context.organizationId,
          caseId: context.caseId,
          targetKind: bundle.target.targetKind,
          targetId: bundle.target.targetId,
          platform,
          snapshotVersion: bundle.snapshot.version,
          snapshotDigest: bundle.digest,
          idempotencyKey: bundle.idempotencyKey,
          actorUserId: context.actorUserId,
          approvalId: approvalId ?? null,
        },
      );
      return {
        status: orchestrated.status,
        attemptId: orchestrated.attemptId,
        sinkCalls: orchestrated.sinkCalls,
        code: orchestrated.code ?? null,
      };
    },
  });

  if (!transportEnabled && (internal.sinkCalls ?? 0) !== 0) {
    throw new PlatformWriteRequestError(
      'PLATFORM_WRITE_SINK_CALLED_WITHOUT_TRANSPORT',
      500,
      'transport 关闭时不得发生任何投递',
    );
  }

  if (internal.status !== 'NEEDS_MANUAL') {
    // transport=true 的「已执行」响应语义未定义（MSG-20261001-23 CHANGE C）：不得输出 200
    throw new PlatformWriteRequestError(
      'PLATFORM_WRITE_TRANSPORT_NOT_WIRED',
      503,
      'transport 已执行路径的响应契约尚未获批',
    );
  }

  const response = buildPlatformWriteResponse(internal, { transportEnabled });
  assertNoProviderSuccessFields(response as unknown as Record<string, unknown>);
  return { httpStatus: 200, body: response };
}
