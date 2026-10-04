/**
 * CA-5 — CUSTOMS AUTHORIZATION CENTER（客户视角授权中心，MSG-20261004-02 §9）
 * ---------------------------------------------------------------
 * 纯投影：把 CA-1 的三阶段 route-aware 判定翻译成客户能读懂的六项清单。
 * 客户默认只看到「已确认 / 需要处理 / 本路线不需要 / 待判定 / 准备中 / 可以提交 / 等待授权」，
 * 工程 blocker code（IOR_NOT_CONFIRMED / BROKER_POA_REQUIRED / providerWrite / lineage …）只出现在 advancedBlockerCodes。
 *
 * MSG-20261004-08 REVISE（CA-5 = REVISE）：
 *   A = ③/④ 的 required 必须来自 CA-1 **实际应用的 policy**（readiness.requirements），不得按 route 二次推断；
 *       policyApplied=false 时不得声称 NOT_REQUIRED，改记 PENDING_POLICY。
 *   B = 消除 filing readiness 死区：FILING_PERMISSION_REQUIRED 归 provider/authority 侧 → WAITING_AUTHORIZATION；
 *       剩余 blocker 全是 provider/authority 侧时一律 WAITING_AUTHORIZATION（不再出现 IN_PREPARATION + nextAction=null）。
 *   C = ⑥ 已 READY_TO_SUBMIT 时主 CTA 必须是 START_RECOVERY；退款账户（⑤）是独立 refund-stage 待办，不反向阻塞 filing。
 *
 * 本模块不做任何授权获取、不写库、不外写：真实 filing / provider transport 继续 HOLD。
 */

import type {
  CustomsFilingRoute,
  CustomsRouteAuthorizationReadiness,
  CustomsStageBlocker,
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

/** ①–⑤ 的状态词表（客户可见）。PENDING_POLICY = 该路线授权要求尚未由 policy 确定（保守显示，不得声称"不需要"）。 */
export type CustomsAuthorizationChecklistState =
  | 'CONFIRMED'
  | 'NEEDS_ACTION'
  | 'NOT_REQUIRED'
  | 'PENDING_POLICY';

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
  /** 客户此刻应该做的事：⑥ 已可提交 → START_RECOVERY；否则按 ①→⑤ 取第一个需要动作的项目。 */
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

/**
 * REVISE B：这些 blocker 由 provider / authority / 系统侧完成，客户无法在六项清单里"补一份"，
 * 因此统一定义为「等待授权 / 代理提交」，而不是停在"准备中"。
 * FILING_PERMISSION_REQUIRED = 合法申报权限（provider/Broker/监管侧取得），不是客户自填项。
 */
export const CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS: readonly CustomsStageBlocker[] = [
  'FILING_PROVIDER_NOT_READY',
  'PROVIDER_POLICY_REQUIRED',
  'FILING_PERMISSION_REQUIRED',
];

function pick(blockers: readonly CustomsStageBlocker[], wanted: readonly CustomsStageBlocker[]): CustomsStageBlocker[] {
  return blockers.filter((code) => wanted.includes(code));
}

/** 六项清单投影（只消费 CA-1 server-derived snapshot，不做任何 policy 二次推断）。 */
export function buildCustomsAuthorizationCenter(input: {
  readiness: CustomsRouteAuthorizationReadiness;
}): CustomsAuthorizationCenter {
  const { readiness } = input;
  const requirements = readiness.requirements;
  const policyResolved = readiness.policyApplied && requirements !== null;

  const identityCodes = pick(readiness.prepare.blockers, IDENTITY_BLOCKERS);
  const recoveryRightCodes = pick(readiness.prepare.blockers, ['RECOVERY_RIGHT_NOT_CONFIRMED']);
  const signerCodes = pick(readiness.file.blockers, SIGNER_BLOCKERS);
  const brokerCodes = pick(readiness.file.blockers, BROKER_BLOCKERS);
  const refundCodes = pick(readiness.refund.blockers, [
    'PAYEE_IDENTITY_NOT_CONFIRMED',
    'REFUND_DESTINATION_NOT_VERIFIED',
    'ACE_ENROLLMENT_NOT_READY',
  ]);

  const authItemState = (
    required: boolean,
    codes: CustomsStageBlocker[],
  ): { state: CustomsAuthorizationChecklistState; action: CustomsAuthorizationNextAction | null; codes: CustomsStageBlocker[] } => {
    if (!policyResolved) return { state: 'PENDING_POLICY', action: null, codes: [] };
    if (!required) return { state: 'NOT_REQUIRED', action: null, codes: [] };
    if (codes.length === 0) return { state: 'CONFIRMED', action: null, codes: [] };
    return { state: 'NEEDS_ACTION', action: null, codes };
  };

  const signer = authItemState(requirements?.authorizedSignerRequired ?? false, signerCodes);
  const broker = authItemState(requirements?.brokerPoaRequired ?? false, brokerCodes);

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
      state: signer.state,
      action: signer.state === 'NEEDS_ACTION' ? 'CONFIRM_SIGNING_AUTHORITY' : null,
      blockerCodes: signer.codes,
    },
    {
      key: 'BROKER_AUTHORIZATION',
      state: broker.state,
      action: broker.state === 'NEEDS_ACTION' ? 'COMPLETE_BROKER_AUTHORIZATION' : null,
      blockerCodes: broker.codes,
    },
    {
      key: 'REFUND_ACCOUNT',
      state: refundCodes.length > 0 ? 'NEEDS_ACTION' : 'CONFIRMED',
      action: refundCodes.length > 0 ? 'CONFIRM_REFUND_ACCOUNT' : null,
      blockerCodes: refundCodes,
    },
  ];

  // REVISE B：客户侧 blocker（身份 / 追回权 / route 授权）与 provider 侧 blocker 分开判定
  const providerSide = readiness.file.blockers.filter((code) =>
    CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS.includes(code),
  );
  const customerSide = readiness.file.blockers.filter(
    (code) => !CUSTOMS_AUTHORIZATION_PROVIDER_SIDE_BLOCKERS.includes(code),
  );
  const submitState: CustomsAuthorizationSubmitState = readiness.file.ready
    ? 'READY_TO_SUBMIT'
    : customerSide.length === 0 && providerSide.length > 0
      ? 'WAITING_AUTHORIZATION'
      : 'IN_PREPARATION';

  items.push({
    key: 'SUBMISSION_READINESS',
    state: submitState,
    action: submitState === 'READY_TO_SUBMIT' ? 'START_RECOVERY' : null,
    blockerCodes: providerSide,
  });

  // REVISE C：⑥ 可提交时，主 CTA 就是 START_RECOVERY（退款账户属于独立 refund-stage 待办，不反向阻塞 filing）
  const firstActionable = items.find((item) => item.key !== 'SUBMISSION_READINESS' && item.action !== null);
  const nextAction: CustomsAuthorizationNextAction | null =
    submitState === 'READY_TO_SUBMIT' ? 'START_RECOVERY' : firstActionable?.action ?? null;

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
