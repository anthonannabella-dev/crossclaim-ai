// PROVIDER FOLLOW-UP INTELLIGENCE / P1 — slice A-S7 — Follow-up Package（草稿层）
// ---------------------------------------------------------------------------
// 定位：把「平台要求补料」的结构化事实 + 证据解析结果，组装成**只读草稿包**：
//   输入：CaseResponseInterpretation（advisory）+ EvidenceResolutionResult[] + 案件金额/范围
//   输出：FollowUpPackage（status=DRAFT/BLOCKED/NOT_REQUIRED，externalWrite=false，transport=DISABLED）
// 硬边界：
//   ① 只出草稿；**永不**发送到平台（本模块没有任何 transport，也没有 submit/send 出口）；
//   ② 附件只允许引用**已存在**的证据 id，禁止新增上传 / 禁止跨 tenant·account 引用；
//   ③ high-value（USD > 1000）必须 OWNER/ADMIN 审批，Follow-up Agent **不得绕过**（显式请求绕过即 fail-closed）；
//   ④ 草稿正文不得包含「已批准 / 保证回款 / 金额结论 / 凭据」这类越权或机密内容；
//   ⑤ provider 原文一律视为不可信输入：命中注入特征则不回显（只留人工复核标记）。

import { digestOf } from '../config-execution-durability/digests';
import {
  assertInterpretationIsAdvisory,
  readUntrustedProviderText,
  type CaseResponseInterpretation,
  type RecommendedNextAction,
} from './case-response-intelligence';
import type { EvidenceResolutionResult, EvidenceScope } from './evidence-resolver';
import type { ProviderContact } from './provider-case';

export const FOLLOW_UP_PACKAGE_VERSION = 'follow-up-package/v1';

export const DEFAULT_HIGH_VALUE_THRESHOLD_USD = 1_000;
export const DEFAULT_ADMIN_APPROVAL_THRESHOLD_USD = 10_000;
export const MAX_DRAFT_CHARS = 4_000;

export const FOLLOW_UP_STATUSES = ['DRAFT', 'BLOCKED', 'NOT_REQUIRED'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_CHANNELS = ['PROVIDER_CASE_MESSAGE', 'EMAIL_DRAFT', 'PHONE_SCRIPT'] as const;
export type FollowUpChannel = (typeof FOLLOW_UP_CHANNELS)[number];

export const FOLLOW_UP_TONES = ['NEUTRAL', 'FIRM', 'APPRECIATIVE'] as const;
export type FollowUpTone = (typeof FOLLOW_UP_TONES)[number];

export const FOLLOW_UP_APPROVAL_ROLES = ['REVIEWER', 'OWNER', 'ADMIN'] as const;
export type FollowUpApprovalRole = (typeof FOLLOW_UP_APPROVAL_ROLES)[number];

export type FollowUpPackageErrorCode =
  | 'FOLLOW_UP_SCOPE_MISMATCH'
  | 'FOLLOW_UP_HIGH_VALUE_HITL_CANNOT_BE_BYPASSED'
  | 'FOLLOW_UP_INTERPRETATION_NOT_ADVISORY'
  | 'FOLLOW_UP_NOT_DRAFT_ONLY';

export class FollowUpPackageError extends Error {
  readonly code: FollowUpPackageErrorCode;

  constructor(code: FollowUpPackageErrorCode, message: string) {
    super(message);
    this.name = 'FollowUpPackageError';
    this.code = code;
  }
}

/** 草稿正文禁止出现的越权/机密内容（命中即阻断人工复核，不静默放行） */
const DRAFT_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /we (have )?approved/i,
  /guarantee(d)?\b/i,
  /recoverable amount is/i,
  /amount owed is/i,
  /irrevocable/i,
  /api[_ -]?key/i,
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /password/i,
  /secret/i,
];

export function scanDraftForSafety(draft: { subject: string; body: string }): {
  safe: boolean;
  matchedPatterns: string[];
  truncated: boolean;
} {
  const haystack = `${draft.subject}\n${draft.body}`;
  const matchedPatterns = DRAFT_FORBIDDEN_PATTERNS.filter((p) => p.test(haystack)).map((p) => p.source);
  const truncated = haystack.length > MAX_DRAFT_CHARS;
  return { safe: matchedPatterns.length === 0, matchedPatterns, truncated };
}

/** 草稿撰写端口：真实实现可以是本地模板或经人工确认的 LLM；**不得**产生执行权或平台写入 */
export interface FollowUpDraftComposerPort {
  readonly composerId: string;
  readonly composerVersion: string;
  compose(input: {
    organizationId: string;
    platformAccountId: string;
    providerCaseId: string;
    caseRef: string | null;
    requestedKinds: readonly string[];
    language: string;
    tone: FollowUpTone;
    /** provider 原文摘要：命中注入特征时为空字符串（不回显） */
    providerTextExcerpt: string;
    providerTextInjectionSuspected: boolean;
  }): Promise<{ subject: string; body: string }>;
}

/** 本地模板实现（无网络、无模型）；仅用于离线装配与测试 */
export function createTemplateFollowUpComposer(): FollowUpDraftComposerPort {
  return {
    composerId: 'follow-up:template',
    composerVersion: 'template/v1',
    async compose(input) {
      const subject = `Additional documents needed for case ${input.providerCaseId}`;
      const body = [
        'Hello,',
        '',
        `We are reviewing case ${input.providerCaseId} and still need the following supporting documents:`,
        ...input.requestedKinds.map((k) => `- ${k}`),
        '',
        'Please upload them to the case thread so the review can continue.',
        '',
        'Thank you,',
        'CrossClaim Recovery Support',
      ].join('\n');
      return { subject, body };
    },
  };
}

export interface FollowUpPackageInput {
  scope: EvidenceScope;
  providerCaseId: string;
  caseRef?: string | null;
  interpretation?: CaseResponseInterpretation | null;
  evidenceResolutions?: readonly EvidenceResolutionResult[];
  /** 预计可追回金额（用于 high-value HITL 判定）；未知则传 null */
  amountUsd?: number | null;
  channel?: FollowUpChannel;
  language?: string;
  tone?: FollowUpTone;
  providerTextSource?: ProviderContact | null;
  composer: FollowUpDraftComposerPort;
  createdAt: Date;
  highValueThresholdUsd?: number;
  adminApprovalThresholdUsd?: number;
  /** 任何试图绕过 high-value HITL 的调用（含 Follow-up Agent 自主尝试）必须 fail-closed */
  requestBypassHighValueHitl?: boolean;
}

export interface FollowUpRequestedEvidence {
  kind: string;
  resolutionStatus: EvidenceResolutionResult['status'] | 'UNRESOLVED';
  missingKeys: string[];
  /** 只引用既有证据 id（可审计）；不含跨 tenant·account 被拒候选 */
  evidenceReferences: string[];
}

export interface FollowUpDraft {
  subject: string;
  body: string;
  language: string;
  tone: FollowUpTone;
  composerId: string;
  composerVersion: string;
  providerTextExcerpted: boolean;
  /** 相对 MAX_DRAFT_CHARS 的长度（仅审计用，不静默截断正文） */
  charCount: number;
}

export interface FollowUpPackage {
  kind: 'FOLLOW_UP_PACKAGE';
  version: string;
  /** 永远不是 SENT：本模块没有发送能力 */
  status: FollowUpStatus;
  draftOnly: true;
  externalWrite: false;
  transportEnabled: false;
  grantsExecutionRights: false;
  cannotBypassHighValueHitl: true;
  organizationId: string;
  platformAccountId: string;
  providerCaseId: string;
  caseRef: string | null;
  channel: FollowUpChannel;
  recipientRef: string;
  classification: CaseResponseInterpretation['classification'] | null;
  recommendedNextAction: RecommendedNextAction | null;
  requestedEvidence: FollowUpRequestedEvidence[];
  missingEvidenceKinds: string[];
  attachmentEvidenceIds: string[];
  highValue: {
    thresholdUsd: number;
    adminThresholdUsd: number;
    amountUsd: number | null;
    isHighValue: boolean;
    requiresOwnerOrAdmin: boolean;
  };
  approval: {
    required: boolean;
    role: FollowUpApprovalRole | null;
    reasons: string[];
  };
  blockedReasons: string[];
  reasons: string[];
  draft: FollowUpDraft | null;
  sourceDigests: {
    interpretation: string | null;
    evidenceResolutions: string[];
    providerTextBody: string | null;
  };
  createdAt: string;
  packageDigest: string;
}

const BLOCKING_RESOLUTION_STATUSES: readonly EvidenceResolutionResult['status'][] = ['CONFLICT', 'AMBIGUOUS'];
const NON_FOUND_STATUSES: readonly EvidenceResolutionResult['status'][] = [
  'MISSING',
  'PARTIAL',
  'LOW_CONFIDENCE',
];

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * 组装 Follow-up Package（**只出草稿**）。
 * 注意：本函数不写库、不发送、不授予执行权；high-value 必须 OWNER/ADMIN。
 */
export async function buildFollowUpPackage(input: FollowUpPackageInput): Promise<FollowUpPackage> {
  const { scope } = input;
  const threshold = input.highValueThresholdUsd ?? DEFAULT_HIGH_VALUE_THRESHOLD_USD;
  const adminThreshold = input.adminApprovalThresholdUsd ?? DEFAULT_ADMIN_APPROVAL_THRESHOLD_USD;

  if (input.requestBypassHighValueHitl === true) {
    throw new FollowUpPackageError(
      'FOLLOW_UP_HIGH_VALUE_HITL_CANNOT_BE_BYPASSED',
      'high-value HITL 不可绕过：Follow-up Agent 无权申请豁免。',
    );
  }

  const interpretation = input.interpretation ?? null;
  if (interpretation) {
    if (
      interpretation.organizationId !== scope.organizationId ||
      interpretation.platformAccountId !== scope.platformAccountId
    ) {
      throw new FollowUpPackageError(
        'FOLLOW_UP_SCOPE_MISMATCH',
        'interpretation 不属于当前 tenant / account，禁止组装 follow-up。',
      );
    }
    assertInterpretationIsAdvisory(interpretation);
  }

  const resolutions = input.evidenceResolutions ?? [];
  for (const resolution of resolutions) {
    if (
      resolution.scope.organizationId !== scope.organizationId ||
      resolution.scope.platformAccountId !== scope.platformAccountId
    ) {
      throw new FollowUpPackageError(
        'FOLLOW_UP_SCOPE_MISMATCH',
        '证据解析结果不属于当前 tenant / account，禁止组装 follow-up。',
      );
    }
  }

  const reasons: string[] = [];
  const blockedReasons: string[] = [];
  const approvalReasons: string[] = [];

  const requestedEvidence: FollowUpRequestedEvidence[] = resolutions.map((resolution) => ({
    kind: resolution.requirementKind,
    resolutionStatus: resolution.status,
    missingKeys: uniqueSorted(resolution.missingEvidence.flatMap((m) => [...m.missingKeys])),
    evidenceReferences: uniqueSorted([...resolution.evidenceReferences]),
  }));

  const missingEvidenceKinds = uniqueSorted(
    resolutions
      .filter((r) => NON_FOUND_STATUSES.includes(r.status))
      .map((r) => r.requirementKind),
  );

  // 附件只引用 FOUND / PARTIAL 的证据 id；CONFLICT / AMBIGUOUS / MISSING 一律不附
  const attachmentEvidenceIds = uniqueSorted(
    resolutions
      .filter((r) => r.status === 'FOUND' || r.status === 'PARTIAL')
      .flatMap((r) => [...r.evidenceReferences]),
  );
  reasons.push('ATTACHMENTS_EXISTING_EVIDENCE_ONLY');

  for (const resolution of resolutions) {
    if (BLOCKING_RESOLUTION_STATUSES.includes(resolution.status)) {
      blockedReasons.push(`EVIDENCE_UNRESOLVED_${resolution.status}:${resolution.requirementKind}`);
      approvalReasons.push(`EVIDENCE_UNRESOLVED_${resolution.status}`);
    } else if (resolution.status === 'LOW_CONFIDENCE') {
      approvalReasons.push(`LOW_CONFIDENCE_EVIDENCE:${resolution.requirementKind}`);
    }
  }

  const amountUsd = typeof input.amountUsd === 'number' ? input.amountUsd : null;
  const isHighValue = amountUsd !== null && amountUsd > threshold;
  if (isHighValue) {
    approvalReasons.push('HIGH_VALUE_HITL');
    if (amountUsd !== null && amountUsd >= adminThreshold) approvalReasons.push('HIGH_VALUE_ADMIN_TIER');
  }

  if (interpretation?.disposition === 'NEEDS_MANUAL_REVIEW') {
    blockedReasons.push('AWAITING_MANUAL_REVIEW');
    approvalReasons.push(...interpretation.dispositionReasons.map((r) => `INTERPRETATION_${r}`));
  }

  // provider 原文：不可信输入，命中注入特征一律不回显
  let providerTextExcerpt = '';
  let providerTextInjectionSuspected = false;
  let providerTextBodyDigest: string | null = null;
  if (input.providerTextSource) {
    const untrusted = readUntrustedProviderText(input.providerTextSource);
    providerTextInjectionSuspected = untrusted.injectionSuspected;
    providerTextBodyDigest = input.providerTextSource.bodyDigest ?? null;
    if (untrusted.injectionSuspected) {
      reasons.push('PROVIDER_TEXT_NOT_ECHOED');
      approvalReasons.push('PROVIDER_TEXT_INJECTION_SUSPECTED');
    } else {
      providerTextExcerpt = untrusted.text.slice(0, 500);
    }
  }

  const needsFollowUp = missingEvidenceKinds.length > 0;
  let status: FollowUpStatus;
  if (blockedReasons.length > 0) {
    status = 'BLOCKED';
  } else if (!needsFollowUp) {
    status = 'NOT_REQUIRED';
    reasons.push('NO_MISSING_EVIDENCE');
  } else {
    status = 'DRAFT';
  }

  let draft: FollowUpDraft | null = null;
  if (status === 'DRAFT') {
    const tone = input.tone ?? 'NEUTRAL';
    const language = input.language ?? 'en';
    try {
      const composed = await input.composer.compose({
        organizationId: scope.organizationId,
        platformAccountId: scope.platformAccountId,
        providerCaseId: input.providerCaseId,
        caseRef: input.caseRef ?? null,
        requestedKinds: missingEvidenceKinds,
        language,
        tone,
        providerTextExcerpt,
        providerTextInjectionSuspected,
      });
      const safety = scanDraftForSafety(composed);
      if (!safety.safe) {
        status = 'BLOCKED';
        blockedReasons.push('DRAFT_CONTAINS_AUTHORITATIVE_OR_SECRET_CONTENT');
        approvalReasons.push('DRAFT_SAFETY_REVIEW');
      }
      if (safety.truncated) {
        reasons.push('DRAFT_EXCEEDS_MAX_CHARS');
        blockedReasons.push('DRAFT_TOO_LONG_FOR_REVIEW');
        approvalReasons.push('DRAFT_SAFETY_REVIEW');
        status = 'BLOCKED';
      }
      if (status === 'DRAFT') {
        const subject = composed.subject.trim().slice(0, 200);
        const body = composed.body.trim();
        draft = {
          subject,
          body,
          language,
          tone,
          composerId: input.composer.composerId,
          composerVersion: input.composer.composerVersion,
          providerTextExcerpted: providerTextExcerpt.length > 0,
          charCount: subject.length + body.length,
        };
        reasons.push('DRAFT_READY');
      }
    } catch (error) {
      status = 'BLOCKED';
      blockedReasons.push('DRAFT_COMPOSITION_FAILED');
      approvalReasons.push('DRAFT_COMPOSITION_FAILED');
      reasons.push('COMPOSER_ERROR:' + (error instanceof Error ? error.message : String(error)));
    }
  }

  // approval 必须在所有分支（含草稿安全扫描）之后再定稿，避免漏掉后置阻断原因
  const finalApprovalReasons = uniqueSorted(approvalReasons);
  const requiresApproval = finalApprovalReasons.length > 0;
  const approvalRole: FollowUpApprovalRole | null = isHighValue
    ? amountUsd !== null && amountUsd >= adminThreshold
      ? 'ADMIN'
      : 'OWNER'
    : requiresApproval
      ? 'REVIEWER'
      : null;
  const approval = {
    required: requiresApproval || status === 'BLOCKED',
    role: approvalRole,
    reasons: finalApprovalReasons,
  };

  const body = {
    version: FOLLOW_UP_PACKAGE_VERSION,
    status,
    organizationId: scope.organizationId,
    platformAccountId: scope.platformAccountId,
    providerCaseId: input.providerCaseId,
    caseRef: input.caseRef ?? null,
    channel: input.channel ?? 'PROVIDER_CASE_MESSAGE',
    recipientRef: `provider-case:${input.providerCaseId}`,
    classification: interpretation?.classification ?? null,
    recommendedNextAction: interpretation?.recommendedNextAction ?? null,
    requestedEvidence,
    missingEvidenceKinds,
    attachmentEvidenceIds,
    highValue: {
      thresholdUsd: threshold,
      adminThresholdUsd: adminThreshold,
      amountUsd,
      isHighValue,
      requiresOwnerOrAdmin: isHighValue,
    },
    approval,
    blockedReasons: uniqueSorted(blockedReasons),
    reasons: uniqueSorted(reasons),
    draft,
    sourceDigests: {
      interpretation: interpretation ? interpretation.interpretationDigest : null,
      evidenceResolutions: resolutions.map((r) => r.resultDigest),
      providerTextBody: providerTextBodyDigest,
    },
    createdAt: input.createdAt.toISOString(),
  };

  return {
    kind: 'FOLLOW_UP_PACKAGE',
    draftOnly: true,
    externalWrite: false,
    transportEnabled: false,
    grantsExecutionRights: false,
    cannotBypassHighValueHitl: true,
    ...body,
    packageDigest: digestOf(body),
  };
}

export const FOLLOW_UP_BOUNDARY = {
  draftOnly: true,
  externalWrite: false,
  transportEnabled: false,
  grantsExecutionRights: false,
  highValueApprovalRoles: ['OWNER', 'ADMIN'],
  forbidden: [
    'sending any message to the platform',
    'attaching evidence that does not already exist',
    'referencing evidence from another tenant or platform account',
    'bypassing high-value HITL',
    'writing canonical truth or amounts',
    'echoing untrusted provider text into an outbound draft',
    'embedding credentials or secrets in drafts',
  ],
} as const;

/** 边界断言：任何把草稿包当成「已发送 / 可执行」的记录都必须被拒绝 */
export function assertFollowUpPackageIsDraftOnly(record: {
  status?: FollowUpStatus;
  draftOnly?: boolean;
  externalWrite?: boolean;
  transportEnabled?: boolean;
  grantsExecutionRights?: boolean;
}): void {
  if (
    record.draftOnly !== true ||
    record.externalWrite !== false ||
    record.transportEnabled !== false ||
    record.grantsExecutionRights !== false ||
    (record.status !== undefined && !FOLLOW_UP_STATUSES.includes(record.status))
  ) {
    throw new FollowUpPackageError(
      'FOLLOW_UP_NOT_DRAFT_ONLY',
      'Follow-up Package 只能处于 DRAFT/BLOCKED/NOT_REQUIRED，且不得具备发送或执行能力。',
    );
  }
}
