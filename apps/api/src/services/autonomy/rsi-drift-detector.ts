/**
 * RSI Functional Drift Detection（纯函数，零 IO）
 * ---------------------------------------------------------------
 * 依据 OWNER《Continuous Inspection / Functional Drift Detection》第 4、6 节：
 *   · 比较 CURRENT SYSTEM vs KNOWN GOOD BASELINE（route/contract/DB 状态转移/工作流输出/parser/
 *     evidence/claim package 权限行为/AI 结构化输出）；
 *   · 差异必须分类：EXPECTED_CHANGE / REGRESSION / UNKNOWN_DRIFT / IMPROVEMENT /
 *     SECURITY_RELEVANT_CHANGE / PRIVILEGE_CHANGE；
 *   · **UNKNOWN_DRIFT / REGRESSION / SECURITY_RELEVANT_CHANGE / PRIVILEGE_CHANGE 必须建 Incident**；
 *   · 业务不变量（VIEWER 不得 privileged submit、External Write HOLD 期间不得真实外写、
 *     Payment HOLD 期间不得 capture、生产凭据不得被 RSI 使用）由纯函数判定，违反即 incident。
 */

export const RSI_DRIFT_CLASSES = [
  'EXPECTED_CHANGE',
  'REGRESSION',
  'UNKNOWN_DRIFT',
  'IMPROVEMENT',
  'SECURITY_RELEVANT_CHANGE',
  'PRIVILEGE_CHANGE',
] as const;
export type RsiDriftClass = (typeof RSI_DRIFT_CLASSES)[number];

export const RSI_INSPECTED_SURFACES = [
  'ROUTE_BEHAVIOR',
  'API_RESPONSE_CONTRACT',
  'DB_STATE_TRANSITION',
  'WORKFLOW_OUTPUT',
  'PARSER_OUTPUT',
  'EVIDENCE_OUTPUT',
  'CLAIM_PACKAGE_OUTPUT',
  'PERMISSION_BEHAVIOR',
  'AI_STRUCTURED_OUTPUT',
] as const;
export type RsiInspectedSurface = (typeof RSI_INSPECTED_SURFACES)[number];

export interface RsiDriftObservation {
  surface: RsiInspectedSurface;
  /** 基线摘要（hash 或 canonical 值）。 */
  baseline: string;
  /** 当前系统摘要。 */
  current: string;
  /** 是否属于已声明的预期变更（例如本次发布本就要改）。 */
  expectedChangeDeclared?: boolean;
  /** 该面上是否发生权限/授权语义变化。 */
  privilegeAffecting?: boolean;
  /** 该面上是否涉及安全边界（Action Guard / HOLD / 租户隔离）。 */
  securityAffecting?: boolean;
  /** 是否由基线对比判定为改进（例如精度提升且无副作用）。 */
  improvementDeclared?: boolean;
}

export interface RsiDriftFinding {
  surface: RsiInspectedSurface;
  classification: RsiDriftClass;
  incidentRequired: boolean;
  changed: boolean;
  reasonCode: string;
}

/** 单个面的分类（顺序即优先级：权限 > 安全 > 回归/未知 > 预期 > 改进）。 */
export function classifyDrift(observation: RsiDriftObservation): RsiDriftFinding {
  const changed = observation.baseline !== observation.current;
  if (!changed) {
    return {
      surface: observation.surface,
      classification: 'EXPECTED_CHANGE',
      incidentRequired: false,
      changed: false,
      reasonCode: 'NO_CHANGE',
    };
  }
  if (observation.privilegeAffecting === true) {
    return {
      surface: observation.surface,
      classification: 'PRIVILEGE_CHANGE',
      incidentRequired: true,
      changed,
      reasonCode: 'PRIVILEGE_SEMANTICS_CHANGED',
    };
  }
  if (observation.securityAffecting === true) {
    return {
      surface: observation.surface,
      classification: 'SECURITY_RELEVANT_CHANGE',
      incidentRequired: true,
      changed,
      reasonCode: 'SECURITY_BOUNDARY_AFFECTED',
    };
  }
  if (observation.improvementDeclared === true) {
    return {
      surface: observation.surface,
      classification: 'IMPROVEMENT',
      incidentRequired: false,
      changed,
      reasonCode: 'IMPROVEMENT_WITH_EVIDENCE',
    };
  }
  if (observation.expectedChangeDeclared === true) {
    return {
      surface: observation.surface,
      classification: 'EXPECTED_CHANGE',
      incidentRequired: false,
      changed,
      reasonCode: 'EXPECTED_BY_RELEASE',
    };
  }
  // 未声明任何理由的行为变化 → 视为 REGRESSION（保守；需 Incident 与证据）。
  return {
    surface: observation.surface,
    classification: 'REGRESSION',
    incidentRequired: true,
    changed,
    reasonCode: 'UNDECLARED_BEHAVIOR_CHANGE',
  };
}

export function inspectSurfaces(observations: readonly RsiDriftObservation[]): readonly RsiDriftFinding[] {
  return observations.map(classifyDrift);
}

export interface RsiInvariantSnapshot {
  /** 触发 privileged submit 的调用者角色。 */
  submitActorRole: 'VIEWER' | 'OPERATOR' | 'OWNER' | null;
  /** 本次尝试是否产生真实外部写。 */
  externalWriteAttempted: boolean;
  externalWriteHold: boolean;
  /** 是否尝试 capture 资金。 */
  paymentCaptureAttempted: boolean;
  paymentHold: boolean;
  /** 是否读取/使用生产凭据。 */
  productionCredentialUsed: boolean;
}

export interface RsiInvariantViolation {
  code:
    | 'VIEWER_PRIVILEGED_SUBMIT'
    | 'EXTERNAL_WRITE_DURING_HOLD'
    | 'PAYMENT_CAPTURE_DURING_HOLD'
    | 'PRODUCTION_CREDENTIAL_USE';
  incidentRequired: true;
  riskClass: 'HIGH';
}

/** 业务不变量：违反即 HIGH 风险 Incident（不因「测试通过」而豁免）。 */
export function evaluateBusinessInvariants(snapshot: RsiInvariantSnapshot): readonly RsiInvariantViolation[] {
  const violations: RsiInvariantViolation[] = [];
  if (snapshot.submitActorRole === 'VIEWER') {
    violations.push({ code: 'VIEWER_PRIVILEGED_SUBMIT', incidentRequired: true, riskClass: 'HIGH' });
  }
  if (snapshot.externalWriteHold && snapshot.externalWriteAttempted) {
    violations.push({ code: 'EXTERNAL_WRITE_DURING_HOLD', incidentRequired: true, riskClass: 'HIGH' });
  }
  if (snapshot.paymentHold && snapshot.paymentCaptureAttempted) {
    violations.push({ code: 'PAYMENT_CAPTURE_DURING_HOLD', incidentRequired: true, riskClass: 'HIGH' });
  }
  if (snapshot.productionCredentialUsed) {
    violations.push({ code: 'PRODUCTION_CREDENTIAL_USE', incidentRequired: true, riskClass: 'HIGH' });
  }
  return violations;
}

/** 巡检调度契约：Daily / Weekly 属于系统内部任务，**不用聊天心跳代替**。 */
export const RSI_INSPECTION_SCHEDULE = {
  daily: { cron: '0 3 * * *', job: 'RSI_DAILY_HEALTH_INSPECTION' },
  weekly: { cron: '0 4 * * 1', job: 'RSI_WEEKLY_FULL_SYSTEM_REVIEW' },
  silentWhenHealthy: true,
  heartbeatIsNotInspection: true,
} as const;
