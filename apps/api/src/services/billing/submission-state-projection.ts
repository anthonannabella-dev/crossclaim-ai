/**
 * TRACK S（MSG-65 / PLATFORM SAFETY）—— 内部提交状态 vs 平台真实提交状态 投影
 * ------------------------------------------------------------------
 * 依据：HOST「区分『内部提交状态』和『平台真实提交状态』」——必须能明确回答 A–E，
 * 且禁止用一个含糊的 SUBMITTED 同时表示「CrossClaim 内部已推进」与「平台已收到」。
 *
 * 本模块是**纯函数**：只读现有字段组合，不写任何事实、不改变任何状态。
 */

export interface SubmissionStateInput {
  /** A. CrossClaim 内部是否已批准（Action Guard approval + approval_consumed 审计） */
  internalApproved: boolean;
  /** B. 是否已生成最终提交包（RecoveryManualSubmission + reference） */
  packageReady: boolean;
  /** C. 是否已由人工记录「准备提交」（内部提交事实） */
  recordedReadyToSubmit: boolean;
  /** D. 是否真的向第三方平台发送（当前恒为 false；仅 Production Gate 放行后才可能为 true） */
  platformWriteExecuted: boolean;
  /** E. 第三方是否 ACK / 返回 case reference */
  providerCaseRef: string | null;
  /** 现有响应字段：NEEDS_MANUAL / NOT_ATTEMPTED / … */
  externalSubmission: string;
}

export interface SubmissionStateProjection {
  A_internalApproved: boolean;
  B_packageReady: boolean;
  C_recordedReadyToSubmit: boolean;
  D_sentToPlatform: boolean;
  E_providerAcknowledged: boolean;
  /** 面向运营的显式措辞（避免把内部 SUBMITTED 误读为平台已收到） */
  operatorLabel: string;
  /** 是否为「已向平台发送」——只有 platformWriteExecuted === true 才成立 */
  everSentToPlatform: boolean;
}

export function projectSubmissionState(input: SubmissionStateInput): SubmissionStateProjection {
  // D 严格取决于 platformWriteExecuted；externalSubmission 不得把 D 抬升为 true。
  const sentToPlatform = input.platformWriteExecuted === true;
  const providerAcknowledged = input.providerCaseRef !== null && String(input.providerCaseRef).trim() !== '';

  const parts: string[] = [];
  parts.push(input.internalApproved ? 'Internal Approved' : 'Not Internally Approved');
  if (input.packageReady) parts.push('Package Ready');
  if (input.recordedReadyToSubmit) parts.push('Recorded Ready to Submit');
  parts.push(sentToPlatform ? 'Sent to Platform' : 'NOT SENT TO PLATFORM');
  if (providerAcknowledged) parts.push('Provider Acknowledged');

  return {
    A_internalApproved: input.internalApproved,
    B_packageReady: input.packageReady,
    C_recordedReadyToSubmit: input.recordedReadyToSubmit,
    D_sentToPlatform: sentToPlatform,
    E_providerAcknowledged: providerAcknowledged,
    operatorLabel: parts.join(' · '),
    everSentToPlatform: sentToPlatform,
  };
}

/** 现有响应（claim/appeal/manual submit）→ 投影输入的便捷映射 */
export function projectionInputFromSubmission(response: {
  platformWriteExecuted?: boolean | null;
  externalSubmission?: string | null;
  providerCaseRef?: string | null;
}): SubmissionStateInput {
  return {
    internalApproved: String(response.externalSubmission ?? '') !== 'NOT_ATTEMPTED',
    packageReady: String(response.externalSubmission ?? '') !== 'NOT_ATTEMPTED',
    recordedReadyToSubmit: String(response.externalSubmission ?? '') === 'NEEDS_MANUAL',
    platformWriteExecuted: response.platformWriteExecuted === true,
    providerCaseRef: response.providerCaseRef ?? null,
    externalSubmission: String(response.externalSubmission ?? 'NOT_ATTEMPTED'),
  };
}
