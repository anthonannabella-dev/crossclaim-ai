// PROVIDER FOLLOW-UP INTELLIGENCE / P8 — slice A-S9 — Customer UX / API projection contract
// ---------------------------------------------------------------------------
// 把 A-S8 生命周期投影翻译成**客户可见状态**，并把各环节严格区分开：
//   缺料 / 需人工复核 / 内部准备中 / 内部准备完成（尚未提交）/ 等待审批 / 已提交 /
//   平台已受理 / 已到账 / 已对账 / 已结束。
// 硬边界：
//   ① **禁止**用单一 "SUBMITTED" 混淆「内部准备完成」与「平台已收到」——
//      READY_INTERNAL 与 SENT 是两个状态；PLATFORM_ACKNOWLEDGED 必须有 VERIFIED 来源；
//   ② 只读投影：不写库、不发通知、不把未确认金额当作已到账；
//   ③ 客户文案不得泄漏内部细节（栈 / SQL / ORM / 凭据 / token / secret / storageKey）。

import { digestOf } from '../config-execution-durability/digests';
import {
  isVerifiedFactSource,
  type FactSourceLevel,
  type RecoveryCaseLifecycleProjection,
} from './recovery-case-lifecycle';

export const CUSTOMER_RECOVERY_STATUS_VERSION = 'customer-recovery-status/v1';

export const CUSTOMER_VISIBLE_STATES = [
  'EVIDENCE_NEEDED',
  'NEEDS_MANUAL_REVIEW',
  'PREPARING',
  'READY_INTERNAL',
  'APPROVAL_REQUIRED',
  'SENT',
  'PLATFORM_ACKNOWLEDGED',
  'SETTLED',
  'RECONCILED',
  'CLOSED',
] as const;
export type CustomerVisibleState = (typeof CUSTOMER_VISIBLE_STATES)[number];

export interface CustomerVisibleCopy {
  title: string;
  detail: string;
  nextStep: string;
}

/** 稳定 state → 客户文案。文案只描述**事实**，不含内部术语、不承诺金额。 */
export const CUSTOMER_VISIBLE_COPY: Record<CustomerVisibleState, CustomerVisibleCopy> = {
  EVIDENCE_NEEDED: {
    title: '还缺一些材料',
    detail: '所需的材料尚未齐备，我们已列出缺口。',
    nextStep: '按清单补齐材料后，我们会继续处理。',
  },
  NEEDS_MANUAL_REVIEW: {
    title: '需要人工复核',
    detail: '当前材料存在互相矛盾或无法自动确认的内容。',
    nextStep: '我们会安排人工核对，必要时再向您确认。',
  },
  PREPARING: {
    title: '正在准备',
    detail: '我们正在核对材料并准备申请内容。',
    nextStep: '无需操作，准备好后我们会继续下一步。',
  },
  READY_INTERNAL: {
    title: '材料已准备完成（尚未提交）',
    detail: '申请材料已在我们这边准备完成，但尚未提交到平台。',
    nextStep: '等待提交；提交后会更新状态。',
  },
  APPROVAL_REQUIRED: {
    title: '等待审批',
    detail: '该案件金额较高，需要负责人审批后才能继续。',
    nextStep: '等待审批，无需操作。',
  },
  SENT: {
    title: '已提交',
    detail: '申请已提交，正在等待平台受理。',
    nextStep: '等待平台处理结果。',
  },
  PLATFORM_ACKNOWLEDGED: {
    title: '平台已受理',
    detail: '平台已确认收到我们的申请。',
    nextStep: '等待平台审核结果。',
  },
  SETTLED: {
    title: '已到账（平台/官方确认）',
    detail: '回款已由平台或官方来源确认。',
    nextStep: '等待对账完成。',
  },
  RECONCILED: {
    title: '已完成对账',
    detail: '回款与账目已核对一致。',
    nextStep: '无需操作。',
  },
  CLOSED: {
    title: '已结束',
    detail: '该案件已关闭。',
    nextStep: '如有疑问请联系支持。',
  },
};

export interface CustomerStatusFacts {
  internalPrepared: boolean;
  /** 真实提交/派发事实（不是「内部准备完成」） */
  sentToPlatform: boolean;
  providerAcknowledged: boolean;
  settlementReceived: boolean;
  reconciled: boolean;
  approvalRequired: boolean;
  approvalGranted: boolean;
  missingEvidenceKinds: string[];
  requiresHumanAttention: boolean;
}

export interface CustomerRecoveryStatus {
  kind: 'CUSTOMER_RECOVERY_STATUS';
  version: string;
  readOnly: true;
  organizationId: string;
  caseId: string;
  caseNo: string | null;
  state: CustomerVisibleState;
  lifecycleStage: RecoveryCaseLifecycleProjection['stage'];
  copy: CustomerVisibleCopy;
  facts: CustomerStatusFacts;
  /** 恒为 true：READY_INTERNAL 与 SENT 是两个独立状态 */
  distinguishesInternalReadyFromSent: true;
  disclaimers: string[];
  omittedBecauseUnverified: string[];
  observedAt: string;
  statusDigest: string;
}

export type CustomerRecoveryStatusErrorCode =
  | 'CUSTOMER_STATUS_TENANT_MISMATCH'
  | 'CUSTOMER_STATUS_CONFLATES_INTERNAL_READY_WITH_SENT'
  | 'CUSTOMER_STATUS_UNVERIFIED_ACKNOWLEDGEMENT'
  | 'CUSTOMER_STATUS_COPY_LEAKS_INTERNAL_DETAIL';

export class CustomerRecoveryStatusError extends Error {
  readonly code: CustomerRecoveryStatusErrorCode;

  constructor(code: CustomerRecoveryStatusErrorCode, message: string) {
    super(message);
    this.name = 'CustomerRecoveryStatusError';
    this.code = code;
  }
}

/** 客户可见文案禁止出现的内部细节（栈 / SQL / ORM / 凭据 / 内部键） */
const INTERNAL_DETAIL_PATTERNS: readonly RegExp[] = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/,
  /prisma/i,
  /\bsql\b/i,
  /select\s+.+\s+from/i,
  /credentialref/i,
  /\btoken\b/i,
  /\bsecret\b/i,
  /api[_ -]?key/i,
  /storagekey/i,
];

export function assertCustomerCopyIsSafe(text: string): void {
  for (const pattern of INTERNAL_DETAIL_PATTERNS) {
    if (pattern.test(text)) {
      throw new CustomerRecoveryStatusError(
        'CUSTOMER_STATUS_COPY_LEAKS_INTERNAL_DETAIL',
        '客户可见文案不得包含内部细节（栈/SQL/ORM/凭据/内部键）。',
      );
    }
  }
}

export interface CustomerDispatchFact {
  source: FactSourceLevel;
  dispatchedAt: string | null;
  channel: 'PROVIDER_CASE_MESSAGE' | 'EMAIL' | 'PHONE' | 'MANUAL_PORTAL';
}

/** 由生命周期投影派生客户可见状态（纯函数） */
export function deriveCustomerVisibleState(lifecycle: RecoveryCaseLifecycleProjection): CustomerVisibleState {
  const stage = lifecycle.stage;
  const base: CustomerVisibleState =
    stage === 'RECONCILED'
      ? 'RECONCILED'
      : stage === 'SETTLED'
        ? 'SETTLED'
        : stage === 'PROVIDER_ACKNOWLEDGED'
          ? 'PLATFORM_ACKNOWLEDGED'
          : stage === 'SUBMISSION_RECORDED' || stage === 'PROVIDER_REFERENCE_RECORDED'
            ? 'SENT'
            : stage === 'AWAITING_APPROVAL'
              ? 'APPROVAL_REQUIRED'
              : stage === 'PACKAGE_EXPORTED'
                ? 'READY_INTERNAL'
                : stage === 'EVIDENCE_INCOMPLETE'
                  ? // 只有确实列出缺口时才说「缺料」，否则退回「正在准备」（避免误导）
                    lifecycle.missingEvidenceKinds.length > 0
                    ? 'EVIDENCE_NEEDED'
                    : 'PREPARING'
                  : stage === 'CLOSED'
                    ? 'CLOSED'
                    : 'PREPARING';

  const manualReview =
    lifecycle.blockers.includes('AWAITING_MANUAL_REVIEW') ||
    lifecycle.blockers.some((b) => b.startsWith('EVIDENCE_UNRESOLVED'));
  const overrideable: readonly CustomerVisibleState[] = [
    'EVIDENCE_NEEDED',
    'PREPARING',
    'READY_INTERNAL',
    'APPROVAL_REQUIRED',
  ];
  if (manualReview && overrideable.includes(base)) return 'NEEDS_MANUAL_REVIEW';
  return base;
}

/**
 * 生成客户可见状态记录（只读）。
 * @throws CUSTOMER_STATUS_TENANT_MISMATCH 投影与范围不一致
 */
export function projectCustomerRecoveryStatus(input: {
  scope: { organizationId: string };
  lifecycle: RecoveryCaseLifecycleProjection;
  dispatch?: CustomerDispatchFact | null;
  observedAt: Date;
}): CustomerRecoveryStatus {
  const { lifecycle } = input;
  if (lifecycle.organizationId !== input.scope.organizationId) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_TENANT_MISMATCH',
      '生命周期投影与客户可见范围不一致，禁止跨 tenant 投影。',
    );
  }

  const dispatch = input.dispatch ?? null;
  const sentToPlatform = lifecycle.internal.submissionRecorded || dispatch !== null;
  const providerAcknowledged = lifecycle.provider.acknowledgement === 'VERIFIED';

  // 「内部准备完成」不得被当成「已提交」
  if (dispatch !== null && !isVerifiedFactSource(dispatch.source) && providerAcknowledged) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_UNVERIFIED_ACKNOWLEDGEMENT',
      '未验证来源不得支撑「平台已受理」。',
    );
  }
  const state = deriveCustomerVisibleState(lifecycle);

  const facts: CustomerStatusFacts = {
    internalPrepared: lifecycle.internal.internalReady || lifecycle.internal.packageGenerated,
    sentToPlatform,
    providerAcknowledged,
    settlementReceived: lifecycle.provider.settlementConfirmed,
    reconciled:
      lifecycle.provider.reconciliationStatus === 'MATCHED' ||
      lifecycle.provider.reconciliationStatus === 'FULLY_RECONCILED',
    approvalRequired: lifecycle.internal.approvalRequired,
    approvalGranted: lifecycle.internal.approvalGranted,
    missingEvidenceKinds: [...lifecycle.missingEvidenceKinds],
    requiresHumanAttention:
      lifecycle.blockers.includes('AWAITING_MANUAL_REVIEW') ||
      lifecycle.blockers.some((b) => b.startsWith('EVIDENCE_UNRESOLVED')),
  };

  const disclaimers: string[] = [];
  if (facts.internalPrepared && !facts.sentToPlatform) disclaimers.push('INTERNAL_READY_NOT_YET_SUBMITTED');
  if (facts.sentToPlatform && !facts.providerAcknowledged) {
    disclaimers.push('AWAITING_PLATFORM_ACKNOWLEDGEMENT');
  }
  disclaimers.push(
    facts.settlementReceived ? 'AMOUNT_REFLECTS_VERIFIED_SETTLEMENT' : 'NO_PAYMENT_CONFIRMED_YET',
  );
  if (facts.missingEvidenceKinds.length > 0) {
    disclaimers.push('MISSING_EVIDENCE_NOT_YET_COMPLETE');
  }
  if (lifecycle.omittedBecauseUnverified.length > 0) {
    disclaimers.push('SOME_FACTS_OMITTED_BECAUSE_UNVERIFIED');
  }

  const copy = CUSTOMER_VISIBLE_COPY[state];
  assertCustomerCopyIsSafe(`${copy.title}\n${copy.detail}\n${copy.nextStep}`);

  const body = {
    version: CUSTOMER_RECOVERY_STATUS_VERSION,
    organizationId: lifecycle.organizationId,
    caseId: lifecycle.caseId,
    caseNo: lifecycle.caseNo,
    state,
    lifecycleStage: lifecycle.stage,
    copy,
    facts,
    distinguishesInternalReadyFromSent: true as const,
    disclaimers: [...new Set(disclaimers)].sort(),
    omittedBecauseUnverified: [...lifecycle.omittedBecauseUnverified],
    observedAt: input.observedAt.toISOString(),
  };

  return {
    kind: 'CUSTOMER_RECOVERY_STATUS',
    readOnly: true,
    ...body,
    statusDigest: digestOf(body),
  };
}

/** 一致性断言（防回归）：客户可见状态必须与事实相符 */
export function assertCustomerStatusConsistent(status: {
  state?: CustomerVisibleState;
  facts?: Partial<CustomerStatusFacts>;
}): void {
  const state = status.state;
  const facts = status.facts ?? {};
  if (state === 'SENT' && facts.sentToPlatform !== true) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_CONFLATES_INTERNAL_READY_WITH_SENT',
      'SENT 状态必须有真实提交事实。',
    );
  }
  if (state === 'READY_INTERNAL' && facts.sentToPlatform === true) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_CONFLATES_INTERNAL_READY_WITH_SENT',
      'READY_INTERNAL 不得同时标记为已提交。',
    );
  }
  if (state === 'PLATFORM_ACKNOWLEDGED' && facts.providerAcknowledged !== true) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_UNVERIFIED_ACKNOWLEDGEMENT',
      'PLATFORM_ACKNOWLEDGED 必须有 VERIFIED 来源。',
    );
  }
  if (state === 'SETTLED' && facts.settlementReceived !== true) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_UNVERIFIED_ACKNOWLEDGEMENT',
      'SETTLED 必须由已确认结算支撑。',
    );
  }
  if (state === 'RECONCILED' && facts.reconciled !== true) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_UNVERIFIED_ACKNOWLEDGEMENT',
      'RECONCILED 必须由对账事实支撑。',
    );
  }
  if (state === 'EVIDENCE_NEEDED' && (facts.missingEvidenceKinds ?? []).length === 0) {
    throw new CustomerRecoveryStatusError(
      'CUSTOMER_STATUS_CONFLATES_INTERNAL_READY_WITH_SENT',
      'EVIDENCE_NEEDED 必须列出缺口。',
    );
  }
}

export const CUSTOMER_STATUS_BOUNDARY = {
  readOnly: true,
  distinguishesInternalReadyFromSent: true,
  singleSubmittedStatusForbidden: true,
  settlementIsNeverEstimated: true,
  sendsNotifications: false,
  mutatesFacts: false,
  forbidden: [
    'using a single SUBMITTED status for both internal readiness and provider receipt',
    'showing a platform acknowledgement without a verified source',
    'presenting an unconfirmed amount as received payment',
    'leaking internal details (stack / SQL / ORM / credentials / storage keys) to customers',
    'sending any notification or platform message from this module',
  ],
} as const;

export function isCustomerVisibleState(value: string): value is CustomerVisibleState {
  return (CUSTOMER_VISIBLE_STATES as readonly string[]).includes(value);
}
