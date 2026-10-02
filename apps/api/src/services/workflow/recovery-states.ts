/**
 * TRACK A / PC-04 — ERROR / RECOVERY STATES（customer-visible failure projection）.
 * ---------------------------------------------------------------
 * 授权：MSG-20261003-84 ④（PC-04 ERROR / RECOVERY STATES）。
 *
 * 冻结规则：
 *   1. 统一客户错误投影：只从既有事实聚合（SourceConnection / ImportBatch / ClaimItem / ClaimPackage readiness）。
 *   2. 稳定 recovery code：label / explanation / nextAction / recoverable，稳定 code 面向客户。
 *   3. 错误披露政策：**绝不**返回 stack / SQL / Prisma error / credentialRef / token / secret /
 *      storageKey / internal audit payload / provider raw auth response；raw lastError 只做分类，不回传文本。
 *   4. retry 语义：只有存在安全 retry endpoint 时才能 actionable=true；当前无此类 endpoint → 只给 guidance。
 *   5. 只读：不修改连接 / 导入 / 案件状态，不触发任何外写。
 *
 * 边界：NO platform write · Payment = 0 · TRANSPORT=false · 无生产凭据。
 */

import type { PrismaClient } from '@prisma/client';

import { assertPermission } from './permissions';

export type RecoveryCode =
  | 'RECONNECT_REQUIRED'
  | 'REUPLOAD_REQUIRED'
  | 'IMPORT_PARTIAL'
  | 'RETRY_AVAILABLE'
  | 'MANUAL_ACTION_REQUIRED'
  | 'EVIDENCE_REQUIRED'
  | 'APPEAL_REQUIRED'
  | 'CONTACT_SUPPORT';

export interface RecoveryCodeDefinition {
  label: string;
  explanation: string;
  nextAction: string;
  recoverable: boolean;
}

/** 稳定客户 code 目录（面向客户展示；不得包含内部错误文本）。 */
export const RECOVERY_CATALOG: Record<RecoveryCode, RecoveryCodeDefinition> = {
  RECONNECT_REQUIRED: {
    label: '需要重新连接',
    explanation: '该连接需要重新授权或重新绑定后才能继续同步。',
    nextAction: '前往「连接」页面重新连接该账户。',
    recoverable: true,
  },
  REUPLOAD_REQUIRED: {
    label: '需要重新上传',
    explanation: '最近一次导入未能完成，需要重新上传文件。',
    nextAction: '重新上传同一批次的文件后再次导入。',
    recoverable: true,
  },
  IMPORT_PARTIAL: {
    label: '部分导入成功',
    explanation: '该批次中部分行导入成功，部分行失败。',
    nextAction: '查看错误报告，修正失败行后补传。',
    recoverable: true,
  },
  RETRY_AVAILABLE: {
    label: '可重试',
    explanation: '该动作上次因临时原因失败，可以安全重试。',
    nextAction: '稍后重试；若持续失败请联系支持。',
    recoverable: true,
  },
  MANUAL_ACTION_REQUIRED: {
    label: '需要人工处理',
    explanation: '该对象需要人工确认或补充操作后才能继续。',
    nextAction: '按提示完成人工步骤。',
    recoverable: true,
  },
  EVIDENCE_REQUIRED: {
    label: '需要补充材料',
    explanation: '材料包尚缺必要证据。',
    nextAction: '补齐缺失材料后重新生成材料包。',
    recoverable: true,
  },
  APPEAL_REQUIRED: {
    label: '需要申诉',
    explanation: '该主张已被拒绝，可进入申诉流程。',
    nextAction: '查看拒绝原因并提交申诉。',
    recoverable: true,
  },
  CONTACT_SUPPORT: {
    label: '需要联系支持',
    explanation: '该问题需要人工排查。',
    nextAction: '联系支持并提供对象编号（无需提供凭据）。',
    recoverable: false,
  },
};

export interface RecoveryStateItem {
  scope: 'CONNECTION' | 'IMPORT' | 'CASE';
  refId: string;
  title: string;
  code: RecoveryCode;
  label: string;
  explanation: string;
  nextAction: string;
  recoverable: boolean;
  safeSummary: string;
  occurredAt: string | null;
  details: Record<string, unknown>;
  retry: { available: boolean; actionable: boolean; reason: string };
}

export interface RecoveryStatesActor {
  organizationId: string;
  actorUserId: string;
  role: string;
}

/** 无安全 retry endpoint 时的统一口径（PC-04 只给 guidance，不渲染假重试按钮）。 */
const NO_SAFE_RETRY = {
  available: false,
  actionable: false,
  reason: 'NO_SAFE_RETRY_ENDPOINT',
} as const;

/**
 * 把 connection.lastError 分类为稳定 code。**只分类，不回传原文**。
 * 分类是保守的：无法归类 → CONTACT_SUPPORT（recoverable=false）。
 */
export function classifyConnectionError(lastError: string | null): RecoveryCode {
  if (!lastError) return 'CONTACT_SUPPORT';
  const text = lastError.toLowerCase();
  if (/auth|401|403|credential|token|expired|unauthor/.test(text)) return 'RECONNECT_REQUIRED';
  if (/timeout|timed out|network|temporar|429|50\d|unavailable|reset/.test(text)) {
    return 'RETRY_AVAILABLE';
  }
  return 'CONTACT_SUPPORT';
}

const sanitizeTitle = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').slice(0, 120);

function item(
  base: Omit<RecoveryStateItem, 'label' | 'explanation' | 'nextAction' | 'recoverable' | 'retry'> & {
    retry?: RecoveryStateItem['retry'];
  },
): RecoveryStateItem {
  const definition = RECOVERY_CATALOG[base.code];
  return {
    ...base,
    label: definition.label,
    explanation: definition.explanation,
    nextAction: definition.nextAction,
    recoverable: definition.recoverable,
    retry: base.retry ?? NO_SAFE_RETRY,
  };
}

export async function listRecoveryStates(
  prisma: PrismaClient,
  actor: RecoveryStatesActor,
): Promise<{ items: RecoveryStateItem[]; catalog: Record<RecoveryCode, RecoveryCodeDefinition> }> {
  // 与连接管理 / 导入诊断同一权限口径（OWNER / ADMIN / OPS）。
  assertPermission(actor.role, 'reviewOpportunities');

  const items: RecoveryStateItem[] = [];

  // 1) Connection recovery states
  const connections = await prisma.sourceConnection.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ updatedAt: 'desc' }],
    take: 50,
    select: {
      id: true,
      label: true,
      status: true,
      platformAccountId: true,
      lastError: true,
      lastErrorAt: true,
      updatedAt: true,
    },
  });
  for (const connection of connections) {
    let code: RecoveryCode | null = null;
    let safeSummary = '';
    if (connection.status === 'REVOKED') {
      code = 'RECONNECT_REQUIRED';
      safeSummary = '连接已被吊销，需要重新连接。';
    } else if (connection.platformAccountId === null) {
      // legacy unbound：即使 status 为 NEEDS_AUTH，也必须先绑定账户（MSG-20261003-84 ③）。
      code = 'MANUAL_ACTION_REQUIRED';
      safeSummary = '该连接尚未绑定账户（legacy unbound），需要显式绑定后才能同步。';
    } else if (connection.status === 'NEEDS_AUTH') {
      code = 'RECONNECT_REQUIRED';
      safeSummary = '连接尚未完成授权，需要重新授权。';
    } else if (connection.status === 'ERROR') {
      code = classifyConnectionError(connection.lastError);
      safeSummary =
        code === 'RECONNECT_REQUIRED'
          ? '最近一次同步因授权问题失败（详细信息已记录在内部日志）。'
          : code === 'RETRY_AVAILABLE'
            ? '最近一次同步因临时原因失败，可稍后重试。'
            : '最近一次同步失败，需要人工排查。';
    } else if (connection.status === 'PAUSED') {
      code = 'MANUAL_ACTION_REQUIRED';
      safeSummary = '连接已绑定账户但处于暂停状态，尚未启用同步。';
    }
    if (!code) continue;
    items.push(
      item({
        scope: 'CONNECTION',
        refId: connection.id,
        title: sanitizeTitle(connection.label),
        code,
        safeSummary,
        occurredAt: connection.lastErrorAt ? connection.lastErrorAt.toISOString() : connection.updatedAt.toISOString(),
        details: {
          status: connection.status,
          accountState: connection.platformAccountId === null ? 'UNBOUND' : 'BOUND',
        },
      }),
    );
  }

  // 2) Import recovery states
  const batches = await prisma.importBatch.findMany({
    where: { organizationId: actor.organizationId, status: { in: ['FAILED', 'PARTIAL'] } },
    orderBy: [{ startedAt: 'desc' }],
    take: 30,
    select: {
      id: true,
      status: true,
      channel: true,
      rowsTotal: true,
      rowsOk: true,
      rowsFailed: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  for (const batch of batches) {
    const partial = batch.status === 'PARTIAL';
    items.push(
      item({
        scope: 'IMPORT',
        refId: batch.id,
        title: '导入批次 · ' + batch.channel,
        code: partial ? 'IMPORT_PARTIAL' : 'REUPLOAD_REQUIRED',
        safeSummary: partial
          ? '部分行导入成功（成功 ' + batch.rowsOk + ' / 失败 ' + batch.rowsFailed + '）。'
          : '该导入批次未完成（失败行 ' + batch.rowsFailed + '）。',
        occurredAt: (batch.finishedAt ?? batch.startedAt).toISOString(),
        details: {
          status: batch.status,
          rowsTotal: batch.rowsTotal,
          rowsOk: batch.rowsOk,
          rowsFailed: batch.rowsFailed,
          ...(batch.rowsFailed > 0 ? { errorReportRef: '/imports/' + batch.id + '/error-report' } : {}),
        },
      }),
    );
  }

  // 3) Claim / package recovery states（复用既有 claim item 事实，不新增判定逻辑）
  const claimItems = await prisma.claimItem.findMany({
    where: { organizationId: actor.organizationId, caseId: { not: null } },
    orderBy: [{ occurredAt: 'desc' }],
    take: 200,
    select: { id: true, caseId: true, status: true, closedReason: true, claimType: true },
  });
  const byCase = new Map<string, typeof claimItems>();
  for (const claimItem of claimItems) {
    const caseId = claimItem.caseId as string;
    const list = byCase.get(caseId) ?? [];
    list.push(claimItem);
    byCase.set(caseId, list);
  }
  for (const [caseId, list] of byCase) {
    const needsAppeal = list.some(
      (claimItem) => claimItem.status === 'READY_TO_APPEAL' || claimItem.closedReason === 'REJECTED',
    );
    const needsReview = list.some((claimItem) => claimItem.status === 'REVIEW_REQUIRED');
    const needsEvidence = list.some((claimItem) => claimItem.status === 'DISCOVERED');
    if (!needsAppeal && !needsReview && !needsEvidence) continue;
    const code: RecoveryCode = needsAppeal
      ? 'APPEAL_REQUIRED'
      : needsReview
        ? 'MANUAL_ACTION_REQUIRED'
        : 'EVIDENCE_REQUIRED';
    items.push(
      item({
        scope: 'CASE',
        refId: caseId,
        title: '案件 · ' + caseId.slice(0, 8),
        code,
        safeSummary: needsAppeal
          ? '该案件中有主张被拒绝，可进入申诉流程。'
          : needsReview
            ? '该案件中有主张需要人工复核。'
            : '该案件中有主张尚未完成验证，可能需要补充材料。',
        occurredAt: null,
        details: { claimItems: list.length },
      }),
    );
  }

  return { items, catalog: RECOVERY_CATALOG };
}
