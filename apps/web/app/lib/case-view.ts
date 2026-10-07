import type { Messages } from '../../i18n/dictionaries/zh-CN';

/**
 * UI-5 —— 案件「这笔钱进行到哪一步」可视化管线（MSG-20261004-01 §八）。
 * 纯函数：只把后端持久化状态 / 状态码映射为 8 个阶段，不重算任何金额，不伪造提交。
 */

export type PipelineStageState = 'DONE' | 'CURRENT' | 'PENDING' | 'BLOCKED';

export interface PipelineStage {
  key: string;
  label: string;
  state: PipelineStageState;
  hint: string | null;
}

export interface CaseProgressInput {
  /** RecoveryDomain：PLATFORM / LOGISTICS / CUSTOMS */
  domain: string;
  /** CaseStatus 原始码 */
  caseStatus: string;
  /** ClaimStatus 原始码（无 claim 时 null） */
  claimStatus: string | null;
  /** 关联机会的 status 原始码集合 */
  opportunityStatuses: readonly string[];
  evidenceCount: number;
  /** 后端持久化的已回收金额（十进制字符串） */
  recoveredAmount: string | null;
}

const CLAIM_SUBMITTED_STATES = ['SUBMITTED', 'ACKNOWLEDGED', 'APPROVED', 'PARTIALLY_APPROVED'];
const CLAIM_REJECTED_STATES = ['REJECTED', 'NO_RESPONSE', 'WITHDRAWN'];
const CLAIM_APPROVED_STATES = ['APPROVED', 'PARTIALLY_APPROVED'];
const CASE_PACKAGE_READY_STATES = ['READY_TO_CLAIM', 'CLAIMED', 'APPEALING', 'WON', 'PARTIALLY_WON', 'SETTLED', 'CLOSED'];
const CASE_SUBMITTED_STATES = ['CLAIMED', 'APPEALING', 'WON', 'PARTIALLY_WON', 'SETTLED', 'CLOSED'];
const CASE_APPROVED_STATES = ['WON', 'PARTIALLY_WON', 'SETTLED'];
const OPPORTUNITY_QUALIFIED_STATES = ['QUALIFIED', 'CONVERTED'];

function stageLabels(domain: string, t: Messages): string[] {
  if (domain === 'CUSTOMS') {
    return [
      t.casePipeline.customsStageDetected,
      t.casePipeline.customsStageDataCheck,
      t.casePipeline.customsStageMatching,
      t.casePipeline.customsStageEligibility,
      t.casePipeline.customsStagePackage,
      t.casePipeline.customsStageSubmitted,
      t.casePipeline.customsStageInReview,
      t.casePipeline.customsStageReceived,
    ];
  }
  return [
    t.casePipeline.stageDetected,
    t.casePipeline.stageQualified,
    t.casePipeline.stageEvidence,
    t.casePipeline.stagePackage,
    t.casePipeline.stageSubmitted,
    t.casePipeline.stageInReview,
    t.casePipeline.stageApproved,
    t.casePipeline.stageReceived,
  ];
}

export function buildRecoveryPipeline(input: CaseProgressInput, t: Messages): PipelineStage[] {
  const labels = stageLabels(input.domain, t);
  const claimStatus = input.claimStatus ?? '';

  const receivedAmount = Number(input.recoveredAmount ?? '0');
  const flags = [
    true, // 已发现：案件存在即成立
    input.opportunityStatuses.some((status) => OPPORTUNITY_QUALIFIED_STATES.includes(status)),
    input.evidenceCount > 0 && input.caseStatus !== 'OPEN',
    CASE_PACKAGE_READY_STATES.includes(input.caseStatus),
    CLAIM_SUBMITTED_STATES.includes(claimStatus) || CASE_SUBMITTED_STATES.includes(input.caseStatus),
    ['ACKNOWLEDGED', ...CLAIM_APPROVED_STATES].includes(claimStatus),
    CLAIM_APPROVED_STATES.includes(claimStatus) || CASE_APPROVED_STATES.includes(input.caseStatus),
    (Number.isFinite(receivedAmount) && receivedAmount > 0) || input.caseStatus === 'SETTLED',
  ];
  const rejected = CLAIM_REJECTED_STATES.includes(claimStatus);

  const firstPending = flags.findIndex((flag) => !flag);
  const submissionKey = input.domain === 'CUSTOMS' ? 'customsStageSubmitted' : 'stageSubmitted';

  return labels.map((label, index) => {
    let state: PipelineStageState;
    if (flags[index] === true) state = 'DONE';
    else if (firstPending === index) state = rejected ? 'BLOCKED' : 'CURRENT';
    else state = 'PENDING';
    const isSubmissionStage = index === 4;
    const hint =
      isSubmissionStage && state !== 'DONE'
        ? input.domain === 'CUSTOMS'
          ? t.casePipeline.customsSubmissionHold
          : t.casePipeline.submissionHold
        : null;
    return { key: submissionKey && isSubmissionStage ? submissionKey : 'stage-' + index, label, state, hint };
  });
}

export function pipelineStateLabel(state: PipelineStageState, t: Messages): string {
  switch (state) {
    case 'DONE':
      return t.casePipeline.stateDone;
    case 'CURRENT':
      return t.casePipeline.stateCurrent;
    case 'BLOCKED':
      return t.casePipeline.stateBlocked;
    default:
      return t.casePipeline.statePending;
  }
}

/** CaseStatus → 客户语言（字典键；缺失时回落到原始码，不伪造状态含义）。 */
export function caseStatusLabel(code: string, t: Messages): string {
  const table = t.caseStatus as unknown as Record<string, string>;
  return table[code] ?? t.status.UNKNOWN;
}
