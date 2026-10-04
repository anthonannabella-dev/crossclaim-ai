/**
 * CA-5 — CUSTOMS AUTHORIZATION CENTER（客户视角授权中心，MSG-20261004-02 §9）
 * ---------------------------------------------------------------
 * 纯投影：把 CA-1 的三阶段 route-aware 判定翻译成客户能读懂的六项清单。
 * 客户默认只看到「已确认 / 需要资料 / 需要确认 / 已完成 / 准备中 / 可以提交 / 等待授权 / 本路线不需要」，
 * 工程 blocker code（IOR_NOT_CONFIRMED / BROKER_POA_REQUIRED / providerWrite / lineage …）只出现在 advancedBlockerCodes，
 * 由调用方放进「高级详情」。
 *
 * 本模块不做任何授权获取、不写库、不外写：真实 filing / provider transport 继续 HOLD。
 */

import {
  defaultPolicyForRoute,
  type CustomsFilingRoute,
  type CustomsRouteAuthorizationReadiness,
  type CustomsStageBlocker,
} from './customs-authorization-route';

export const CUSTOMS_AUTHORIZATION_CENTER_ITEM_KEYS = [
  'ENTERPRISE_IDENTITY',
  'RECOVERY_RIGHT',
  'SIGNER_AUTHORITY',
  'BROKER_AUTHORIZATION',
  'REFUND_ACCOUNT',
  'SUBMISSION_READINESS',
] as const;

export type CustomsAuthorizationCenterItemKey = (typeof CUSTOMS_AUTHORIZATION_CENTER_ITEM_KEYS)[number];

/** ①–⑤ 的状态词表（客户可见）。 */
export type CustomsAuthorizationChecklistState = 'CONFIRMED' | 'NEEDS_ACTION' | 'NOT_REQUIRED';

/** ⑥ 提交准备的状态词表（客户可见）。 */
export type CustomsAuthorizationSubmitState = 'IN_PREPARATION' | 'READY_TO_SUBMIT' | 'WAITING_AUTHORIZATION';

/** 下一步动作：只描述动作，不承诺自动提交。 */
export type CustomsAuthorizationNextAction =
  | 'CONFIRM_ENTERPRISE_IDENTITY'
  | 'SUPPLY_DOCUMENTS'
  | 'CONFIRM_SIGNING_AUTHORITY'
  | 'COMPLETE_BROKER_AUTHORIZATION'
  | 'CONFIRM_REFUND_ACCOUNT'
  | 'START_RECOVERY';

export interface CustomsAuthorizationCenterItem {
  key: CustomsAuthorizationCenterItemKey;
  state: CustomsAuthorizationChecklistState | CustomsAuthorizationSubmitState;
  /** 该项目的下一步动作（客户视角）；无需动作时为 null。 */
  action: CustomsAuthorizationNextAction | null;
  /** 工程 blocker code（仅供高级详情）。 */
  blockerCodes: readonly CustomsStageBlocker[];
}

export interface CustomsAuthorizationCenter {
  route: CustomsFilingRoute;
  remedy: string;
  jurisdiction: string | null;
  items: readonly CustomsAuthorizationCenterItem[];
  /** 客户此刻唯一应该做的事（按 ①→⑤ 顺序取第一个需要动作的项目；全部就绪时为 START_RECOVERY）。 */
  nextAction: CustomsAuthorizationNextAction | null;
  stages: {
    READY_TO_PREPARE: boolean;
    READY_TO_FILE: boolean;
    READY_TO_RECEIVE_REFUND: boolean;
  };
  /** 工程 blocker code 全集（只给高级详情，不进入客户默认视图）。 */
  advancedBlockerCodes: readonly CustomsStageBlocker[];
  /** 外部动作边界：本投影永远不表示已提交。 */
  filingSubmitted: false;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
  serverDerived: true;
}

const IDENTITY_BLOCKERS: readonly CustomsStageBlocker[] = [
  'CUSTOMS_AGREEMENT_REQUIRED',
  'IOR_NOT_CONFIRMED',
  'CLAIMANT_NOT_CONFIRMED',
];

const SIGNER_BLOCKERS: readonly CustomsStageBlocker[] = [
  'SIGNER_AUTHORITY_REQUIRED',
  'SIGNER_NOT_USABLE',
  'SIGNER_SCOPE_MISMATCH',
  'SIGNER_JURISDICTION_MISMATCH',
  'AUTHORIZATION_SOURCE_NOT_ALLOWED',
];

const BROKER_BLOCKERS: readonly CustomsStageBlocker[] = [
  'BROKER_NOT_CONNECTED',
  'BROKER_POA_REQUIRED',
  'BROKER_POA_NOT_USABLE',
  'BROKER_POA_SCOPE_MISMATCH',
  'JURISDICTION_MISMATCH',
  'AUTHORIZATION_SOURCE_NOT_ALLOWED',
];

function pick(blockers: readonly CustomsStageBlocker[], wanted: readonly CustomsStageBlocker[]): CustomsStageBlocker[] {
  return blockers.filter((code) => wanted.includes(code));
}

/** route 是否需要某一类授权（与 CA-1 默认策略一致；无策略 = 都不要求，由 fail-closed blocker 表达）。 */
export function customsAuthorizationCenterRequirements(route: CustomsFilingRoute): {
  signerAuthorityRequired: boolean;
  brokerAuthorizationRequired: boolean;
  filingPermissionRequired: boolean;
  refundEnrollmentRequired: boolean;
} {
  const policy = defaultPolicyForRoute(route, '*');
  return {
    signerAuthorityRequired: policy?.authorizedSignerRequired ?? false,
    brokerAuthorizationRequired: policy?.brokerPoaRequired ?? false,
    filingPermissionRequired: policy?.filingPermissionRequired ?? false,
    refundEnrollmentRequired: policy?.refundEnrollmentRequired ?? false,
  };
}

/**
 * 六项清单投影。
 * 注意：**退款账户未就绪不阻塞 ⑥ 提交准备之外的分析/证据/材料准备**——
 * ⑥ 只由 file 阶段 + provider 提交能力决定（与 CA-1 三阶段分离一致）。
 */
export function buildCustomsAuthorizationCenter(input: {
  readiness: CustomsRouteAuthorizationReadiness;
}): CustomsAuthorizationCenter {
  const { readiness } = input;
  const requirements = customsAuthorizationCenterRequirements(readiness.route);

  const identityCodes = pick(readiness.prepare.blockers, IDENTITY_BLOCKERS);
  const recoveryRightCodes = pick(readiness.prepare.blockers, ['RECOVERY_RIGHT_NOT_CONFIRMED']);
  const signerCodes = pick(readiness.file.blockers, SIGNER_BLOCKERS);
  const brokerCodes = pick(readiness.file.blockers, BROKER_BLOCKERS);
  const refundCodes = pick(readiness.refund.blockers, [
    'PAYEE_IDENTITY_NOT_CONFIRMED',
    'REFUND_DESTINATION_NOT_VERIFIED',
    'ACE_ENROLLMENT_NOT_READY',
  ]);

  const items: CustomsAuthorizationCenterItem[] = [
    {
      key: 'ENTERPRISE_IDENTITY',
      state: identityCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: identityCodes.length > 0 ? 'CONFIRM_ENTERPRISE_IDENTITY' : null,
      blockerCodes: identityCodes,
    },
    {
      key: 'RECOVERY_RIGHT',
      state: recoveryRightCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: recoveryRightCodes.length > 0 ? 'SUPPLY_DOCUMENTS' : null,
      blockerCodes: recoveryRightCodes,
    },
    {
      key: 'SIGNER_AUTHORITY',
      state: !requirements.signerAuthorityRequired
        ? 'NOT_REQUIRED'
        : signerCodes.length > 0
          ? 'NEEDS_ACTION'
          : 'CONFIRMED',
      action:
        requirements.signerAuthorityRequired && signerCodes.length > 0 ? 'CONFIRM_SIGNING_AUTHORITY' : null,
      blockerCodes: requirements.signerAuthorityRequired ? signerCodes : [],
    },
    {
      key: 'BROKER_AUTHORIZATION',
      state: !requirements.brokerAuthorizationRequired
        ? 'NOT_REQUIRED'
        : brokerCodes.length > 0
          ? 'NEEDS_ACTION'
          : 'CONFIRMED',
      action:
        requirements.brokerAuthorizationRequired && brokerCodes.length > 0 ? 'COMPLETE_BROKER_AUTHORIZATION' : null,
      blockerCodes: requirements.brokerAuthorizationRequired ? brokerCodes : [],
    },
    {
      key: 'REFUND_ACCOUNT',
      state: refundCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: refundCodes.length > 0 ? 'CONFIRM_REFUND_ACCOUNT' : null,
      blockerCodes: refundCodes,
    },
  ];

  // ⑥：file 阶段就绪 = 可以提交；只剩 provider / 政策侧待办 = 等待授权（代理提交）；其它 = 准备中。
  const PROVIDER_SIDE_BLOCKERS: readonly CustomsStageBlocker[] = [
    'FILING_PROVIDER_NOT_READY',
    'PROVIDER_POLICY_REQUIRED',
  ];
  const customerSideFileBlockers = readiness.file.blockers.filter(
    (code) => !PROVIDER_SIDE_BLOCKERS.includes(code),
  );
  const submitState: CustomsAuthorizationSubmitState = readiness.file.ready
    ? 'READY_TO_SUBMIT'
    : customerSideFileBlockers.length === 0 && readiness.file.blockers.length > 0
      ? 'WAITING_AUTHORIZATION'
      : 'IN_PREPARATION';
  items.push({
    key: 'SUBMISSION_READINESS',
    state: submitState,
    action: submitState === 'READY_TO_SUBMIT' ? 'START_RECOVERY' : null,
    blockerCodes: readiness.file.blockers.filter((code) => PROVIDER_SIDE_BLOCKERS.includes(code)),
  });

  const firstActionable = items.find(
    (item) => item.key !== 'SUBMISSION_READINESS' && item.action !== null,
  );
  const nextAction = firstActionable?.action ?? items[5]?.action ?? null;

  return {
    route: readiness.route,
    remedy: readiness.remedy,
    jurisdiction: readiness.jurisdiction,
    items,
    nextAction,
    stages: {
      READY_TO_PREPARE: readiness.READY_TO_PREPARE,
      READY_TO_FILE: readiness.READY_TO_FILE,
      READY_TO_RECEIVE_REFUND: readiness.READY_TO_RECEIVE_REFUND,
    },
    advancedBlockerCodes: readiness.blockers,
    filingSubmitted: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
    serverDerived: true,
  };
}
