// CUSTOMS / DUTY RECOVERY — slice B-S9 — Broker / ABI / Filing provider readiness
// ---------------------------------------------------------------------------
// 定位：把「是否已具备交给报关行/申报通道的条件」做成一**只读 15 项门槛清单**，逐项给出来源与阻断原因；
//   缺任何一项 → 不得 READY：POA / broker 相关缺口 → BROKER_HANDOFF，其余 → NEEDS_MANUAL。
// 复用（不新建重复引擎）：
//   * POA 可用性判定复用既有 `evaluateBrokerAuthorization`（CBP Form 5291 语义；4811 不得当 POA）；
//   * 证据链状态复用 B-S5（CustomsEvidenceChainResult.chainStatus）；
//   * 路线结论复用 B-S8（DrawbackCandidateRoute.disposition）。
// 硬边界：
//   ① 只评估就绪度：不申报、不写外部、不申请凭据（filingSubmitted=false / externalWritePerformed=false /
//      productionCredentials='ABSENT'）；
//   ② **不判 eligibility / 不算金额 / 不判佣金**；
//   ③ POA 复用规则：只有「已验证 + 覆盖 remedy + 辖区一致 + 未过期」的既有授权才可复用，否则必须重新取得；
//   ④ RFI 补件只准备**草稿**：不真实 respond（willSend=false / realRespondPerformed=false）。

import { digestOf } from '../config-execution-durability/digests';
import { evaluateBrokerAuthorization, type BrokerAuthorizationInput } from './enterprise-ior/broker-poa';

export const BROKER_FILING_READINESS_VERSION = 'broker-filing-readiness/v1';
export const BROKER_FILING_READINESS_GATE_COUNT = 15;

export const READINESS_GATE_KEYS = [
  'CUSTOMS_AGREEMENT_SIGNED',
  'IOR_CONFIRMED',
  'CLAIMANT_CONFIRMED',
  'RECOVERY_RIGHT_FOR_REMEDY',
  'BROKER_CONNECTED',
  'BROKER_POA_VALID',
  'BROKER_POA_SCOPE_COVERS_REMEDY',
  'BROKER_POA_JURISDICTION_MATCH',
  'FILING_PERMISSION_VALID',
  'PROVIDER_CAPABILITY_READY',
  'PAYEE_IDENTITY_CONFIRMED',
  'REFUND_DESTINATION_VERIFIED',
  'ACE_ENROLLMENT_READY',
  'EVIDENCE_CHAIN_COMPLETE',
  'CLAIM_ROUTE_READY',
] as const;
export type ReadinessGateKey = (typeof READINESS_GATE_KEYS)[number];

/** POA / broker 相关缺口 → 必须交报关行（而非内部继续） */
export const BROKER_HANDOFF_GATE_KEYS: readonly ReadinessGateKey[] = [
  'BROKER_CONNECTED',
  'BROKER_POA_VALID',
  'BROKER_POA_SCOPE_COVERS_REMEDY',
  'BROKER_POA_JURISDICTION_MATCH',
];

export const READINESS_DISPOSITIONS = [
  'READY_FOR_FILING_PROVIDER',
  'NEEDS_MANUAL',
  'BROKER_HANDOFF',
] as const;
export type ReadinessDisposition = (typeof READINESS_DISPOSITIONS)[number];

export interface ReadinessGateItem {
  key: ReadinessGateKey;
  label: string;
  satisfied: boolean;
  /** 事实来源（既有模型/字段/上游 slice），便于审计 */
  source: string;
  blockingReason: string | null;
}

export interface DrawbackLikeRouteDisposition {
  disposition: 'NOT_CANDIDATE' | 'NEEDS_EVIDENCE' | 'NEEDS_MANUAL_REVIEW' | 'CLAIM_READY';
}

export interface BrokerFilingReadinessInput {
  scope: { organizationId: string; platformAccountId: string };
  remedy: string;
  jurisdiction: string;
  facts: {
    customsAgreementSigned: boolean;
    iorConfirmed: boolean;
    claimantConfirmed: boolean;
    recoveryRightForRemedy: boolean;
    brokerConnected: boolean;
    filingPermissionValid: boolean;
    providerCapabilityReady: boolean;
    payeeIdentityConfirmed: boolean;
    refundDestinationVerified: boolean;
    aceEnrollmentReady: boolean;
  };
  /** 既有 POA 授权事实（可为空 = 尚未取得） */
  poa?: BrokerAuthorizationInput | null;
  /** B-S5 证据链状态 */
  evidenceChainStatus?: 'COMPLETE' | 'PARTIAL' | 'BLOCKED' | 'INSUFFICIENT' | null;
  /** B-S8 路线结论 */
  claimRoute?: DrawbackLikeRouteDisposition | null;
  now: Date;
}

export interface BrokerFilingReadiness {
  kind: 'BROKER_FILING_READINESS';
  version: string;
  organizationId: string;
  platformAccountId: string;
  remedy: string;
  jurisdiction: string;
  items: ReadinessGateItem[];
  totalCount: number;
  readyCount: number;
  ready: boolean;
  disposition: ReadinessDisposition;
  blockingKeys: ReadinessGateKey[];
  poa: {
    present: boolean;
    usable: boolean;
    reused: boolean;
    requiresRecollection: boolean;
    reasonCodes: readonly string[];
    reuseRule: string;
  };
  rfi: {
    prepared: boolean;
    missingKeys: ReadinessGateKey[];
    draft: { subject: string; body: string } | null;
    willSend: false;
    realRespondPerformed: false;
  };
  filingSubmitted: false;
  externalWritePerformed: false;
  productionCredentials: 'ABSENT';
  evaluatesOnly: true;
  decidesEligibility: false;
  reasons: string[];
  evaluatedAt: string;
  readinessDigest: string;
}

export type BrokerFilingReadinessErrorCode = 'BROKER_READINESS_CANNOT_FILE';

export class BrokerFilingReadinessError extends Error {
  readonly code: BrokerFilingReadinessErrorCode;

  constructor(code: BrokerFilingReadinessErrorCode, message: string) {
    super(message);
    this.name = 'BrokerFilingReadinessError';
    this.code = code;
  }
}

const GATE_LABELS: Record<ReadinessGateKey, string> = {
  CUSTOMS_AGREEMENT_SIGNED: '通关服务协议已签署',
  IOR_CONFIRMED: '进口商（IOR）已确认',
  CLAIMANT_CONFIRMED: '主张人已确认',
  RECOVERY_RIGHT_FOR_REMEDY: '该 remedy 的追索权已确认',
  BROKER_CONNECTED: '报关行已连接',
  BROKER_POA_VALID: '报关行 POA 有效（CBP Form 5291 语义）',
  BROKER_POA_SCOPE_COVERS_REMEDY: 'POA 授权范围覆盖该 remedy',
  BROKER_POA_JURISDICTION_MATCH: 'POA 辖区与案件一致',
  FILING_PERMISSION_VALID: '申报权限有效',
  PROVIDER_CAPABILITY_READY: '申报通道能力就绪',
  PAYEE_IDENTITY_CONFIRMED: '收款人身份已确认',
  REFUND_DESTINATION_VERIFIED: '退款去向已核验',
  ACE_ENROLLMENT_READY: 'ACE 注册就绪',
  EVIDENCE_CHAIN_COMPLETE: '证据链完整',
  CLAIM_ROUTE_READY: '路线结论已达 CLAIM_READY',
};

const GATE_SOURCES: Record<ReadinessGateKey, string> = {
  CUSTOMS_AGREEMENT_SIGNED: 'CustomsAgreement.fact',
  IOR_CONFIRMED: 'IOR qualification fact',
  CLAIMANT_CONFIRMED: 'Claimant fact',
  RECOVERY_RIGHT_FOR_REMEDY: 'RecoveryRight fact (per remedy)',
  BROKER_CONNECTED: 'BrokerConnection.fact',
  BROKER_POA_VALID: 'evaluateBrokerAuthorization(BrokerAuthorizationInput)',
  BROKER_POA_SCOPE_COVERS_REMEDY: 'BrokerAuthorization.scope',
  BROKER_POA_JURISDICTION_MATCH: 'BrokerAuthorization.jurisdiction',
  FILING_PERMISSION_VALID: 'FilingPermission.fact',
  PROVIDER_CAPABILITY_READY: 'Filing provider capability registry',
  PAYEE_IDENTITY_CONFIRMED: 'PayeeIdentity.fact',
  REFUND_DESTINATION_VERIFIED: 'RefundDestination readiness',
  ACE_ENROLLMENT_READY: 'ACE enrollment fact',
  EVIDENCE_CHAIN_COMPLETE: 'CustomsEvidenceChainResult.chainStatus (B-S5)',
  CLAIM_ROUTE_READY: 'DrawbackCandidateRoute.disposition (B-S8)',
};

const POA_REUSE_RULE =
  '复用条件：verificationStatus=VERIFIED 且 scope 覆盖 remedy 且 jurisdiction 一致 且未过期且提供证据引用';

function gate(
  key: ReadinessGateKey,
  satisfied: boolean,
  blockingReason: string | null,
): ReadinessGateItem {
  return {
    key,
    label: GATE_LABELS[key],
    satisfied,
    source: GATE_SOURCES[key],
    blockingReason: satisfied ? null : blockingReason,
  };
}

/**
 * 评估报关行 / ABI / 申报通道就绪度（只读，15 项门槛逐项证明）。
 * 缺任何一项 → 不 READY；POA 相关缺口 → BROKER_HANDOFF，其余 → NEEDS_MANUAL。
 */
export function evaluateBrokerFilingReadiness(input: BrokerFilingReadinessInput): BrokerFilingReadiness {
  const { facts } = input;
  const nowIso = input.now.toISOString();
  const poaInput = input.poa ?? null;
  const poaResult = poaInput ? evaluateBrokerAuthorization(poaInput, nowIso) : null;
  const poaUsable = poaResult?.usable === true;
  const scopeCovers = poaInput ? poaInput.scope.includes(input.remedy) : false;
  const jurisdictionMatches = poaInput
    ? String(poaInput.jurisdiction ?? '').toUpperCase() === input.jurisdiction.toUpperCase()
    : false;
  const poaReused = poaUsable && scopeCovers && jurisdictionMatches;
  const poaRequiresRecollection = !poaReused;

  const evidenceComplete = input.evidenceChainStatus === 'COMPLETE';
  const claimRouteReady = input.claimRoute?.disposition === 'CLAIM_READY';

  const items: ReadinessGateItem[] = [
    gate('CUSTOMS_AGREEMENT_SIGNED', facts.customsAgreementSigned, 'CUSTOMS_AGREEMENT_REQUIRED'),
    gate('IOR_CONFIRMED', facts.iorConfirmed, 'IOR_NOT_CONFIRMED'),
    gate('CLAIMANT_CONFIRMED', facts.claimantConfirmed, 'CLAIMANT_NOT_CONFIRMED'),
    gate('RECOVERY_RIGHT_FOR_REMEDY', facts.recoveryRightForRemedy, 'RECOVERY_RIGHT_NOT_CONFIRMED'),
    gate('BROKER_CONNECTED', facts.brokerConnected, 'BROKER_NOT_CONNECTED'),
    gate('BROKER_POA_VALID', poaUsable, poaInput ? 'BROKER_POA_INVALID' : 'BROKER_POA_REQUIRED'),
    gate(
      'BROKER_POA_SCOPE_COVERS_REMEDY',
      scopeCovers,
      poaInput ? 'BROKER_POA_SCOPE_MISMATCH' : 'BROKER_POA_REQUIRED',
    ),
    gate(
      'BROKER_POA_JURISDICTION_MATCH',
      jurisdictionMatches,
      poaInput ? 'BROKER_POA_JURISDICTION_MISMATCH' : 'BROKER_POA_REQUIRED',
    ),
    gate('FILING_PERMISSION_VALID', facts.filingPermissionValid, 'FILING_PERMISSION_REQUIRED'),
    gate('PROVIDER_CAPABILITY_READY', facts.providerCapabilityReady, 'FILING_PROVIDER_NOT_READY'),
    gate('PAYEE_IDENTITY_CONFIRMED', facts.payeeIdentityConfirmed, 'PAYEE_IDENTITY_NOT_CONFIRMED'),
    gate('REFUND_DESTINATION_VERIFIED', facts.refundDestinationVerified, 'REFUND_DESTINATION_NOT_VERIFIED'),
    gate('ACE_ENROLLMENT_READY', facts.aceEnrollmentReady, 'ACE_ENROLLMENT_NOT_READY'),
    gate(
      'EVIDENCE_CHAIN_COMPLETE',
      evidenceComplete,
      input.evidenceChainStatus ? `EVIDENCE_CHAIN_${input.evidenceChainStatus}` : 'EVIDENCE_CHAIN_MISSING',
    ),
    gate(
      'CLAIM_ROUTE_READY',
      claimRouteReady,
      input.claimRoute ? `CLAIM_ROUTE_${input.claimRoute.disposition}` : 'CLAIM_ROUTE_MISSING',
    ),
  ];

  const blockingKeys = items.filter((item) => !item.satisfied).map((item) => item.key);
  const ready = blockingKeys.length === 0;
  const brokerBlocked = blockingKeys.some((key) => BROKER_HANDOFF_GATE_KEYS.includes(key));

  const disposition: ReadinessDisposition = ready
    ? 'READY_FOR_FILING_PROVIDER'
    : brokerBlocked
      ? 'BROKER_HANDOFF'
      : 'NEEDS_MANUAL';

  const reasons: string[] = [];
  if (ready) reasons.push('ALL_FIFTEEN_GATES_SATISFIED');
  reasons.push('READINESS_GATE_COUNT=' + items.length);
  if (poaReused) reasons.push('POA_REUSED_FROM_EXISTING_AUTHORIZATION');
  if (poaRequiresRecollection) reasons.push('POA_RECOLLECTION_REQUIRED');
  if (brokerBlocked) reasons.push('BROKER_ACTION_REQUIRED');

  const rfiPrepared = !ready;
  const rfiDraft = rfiPrepared
    ? {
        subject: `Additional information required for ${input.remedy} (${input.jurisdiction})`,
        body: [
          `The following items are still outstanding for remedy ${input.remedy}:`,
          ...items.filter((item) => !item.satisfied).map((item) => `- ${item.label} (${item.key})`),
          '',
          'Please provide the above so preparation can continue.',
        ].join('\n'),
      }
    : null;

  const body = {
    version: BROKER_FILING_READINESS_VERSION,
    organizationId: input.scope.organizationId,
    platformAccountId: input.scope.platformAccountId,
    remedy: input.remedy,
    jurisdiction: input.jurisdiction,
    items,
    totalCount: items.length,
    readyCount: items.filter((item) => item.satisfied).length,
    ready,
    disposition,
    blockingKeys,
    poa: {
      present: poaInput !== null,
      usable: poaUsable,
      reused: poaReused,
      requiresRecollection: poaRequiresRecollection,
      reasonCodes: poaResult?.reasonCodes ?? ['MISSING_POA'],
      reuseRule: POA_REUSE_RULE,
    },
    rfi: {
      prepared: rfiPrepared,
      missingKeys: blockingKeys,
      draft: rfiDraft,
      willSend: false as const,
      realRespondPerformed: false as const,
    },
    filingSubmitted: false as const,
    externalWritePerformed: false as const,
    productionCredentials: 'ABSENT' as const,
    evaluatesOnly: true as const,
    decidesEligibility: false as const,
    reasons,
    evaluatedAt: nowIso,
  };

  return {
    kind: 'BROKER_FILING_READINESS',
    ...body,
    readinessDigest: digestOf(body),
  };
}

export const BROKER_FILING_READINESS_BOUNDARY = {
  readOnly: true,
  gateCount: BROKER_FILING_READINESS_GATE_COUNT,
  filingSubmitted: false,
  externalWritePerformed: false,
  productionCredentials: 'ABSENT',
  decidesEligibility: false,
  computesRecoverableAmount: false,
  determinesSuccessFeeEligibility: false,
  poaReuseRequiresVerifiedScopeAndJurisdiction: true,
  rfiIsDraftOnly: true,
  missingGateNeverReady: true,
  forbidden: [
    'filing or transmitting anything through a broker / ABI / filing provider',
    'requesting or storing production credentials',
    'treating Form 4811 as a broker POA',
    'reusing a POA that does not cover the remedy or jurisdiction',
    'actually responding to a provider RFI',
    'marking readiness complete while any of the 15 gates is unsatisfied',
  ],
} as const;

/** 边界断言：任何声称已申报 / 已写外部 / 已有生产凭据 / 已实际 respond 的记录都必须被拒绝 */
export function assertBrokerReadinessDidNotFile(record: {
  filingSubmitted?: boolean;
  externalWritePerformed?: boolean;
  productionCredentials?: string;
  rfi?: { willSend?: boolean; realRespondPerformed?: boolean };
}): void {
  if (
    record.filingSubmitted === true ||
    record.externalWritePerformed === true ||
    (record.productionCredentials !== undefined && record.productionCredentials !== 'ABSENT') ||
    record.rfi?.willSend === true ||
    record.rfi?.realRespondPerformed === true
  ) {
    throw new BrokerFilingReadinessError(
      'BROKER_READINESS_CANNOT_FILE',
      '本模块只评估就绪度：不得申报、不得写外部、不得持有生产凭据、不得真实 respond RFI。',
    );
  }
}

/** 缺任何一项门槛都不得判 READY（供上游/回归断言使用） */
export function assertNoReadyWithMissingGates(record: {
  ready?: boolean;
  items?: readonly { satisfied: boolean }[];
}): void {
  if (record.ready === true && (record.items ?? []).some((item) => !item.satisfied)) {
    throw new BrokerFilingReadinessError(
      'BROKER_READINESS_CANNOT_FILE',
      '存在未满足门槛时不得判 READY。',
    );
  }
}
