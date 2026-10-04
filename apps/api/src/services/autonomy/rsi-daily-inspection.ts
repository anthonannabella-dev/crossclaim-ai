/**
 * RSI Daily Health Inspection（RSI-INSP-02，纯函数 + 注入式只读探针）
 * ---------------------------------------------------------------
 * 依据 OWNER《Continuous Inspection》：每天检查 Runtime / API-Provider / Application 三类；
 * **健康时不产生任何信号**（巡检是系统内部任务，不用聊天心跳代替）。
 *
 * 本模块只做编排与判定：探针由宿主注入（只读、不得写库、不得外写、不得读凭据）。
 */

import { RSI_INSPECTION_SCHEDULE } from './rsi-drift-detector';

export const RSI_DAILY_CHECK_CATEGORIES = ['RUNTIME', 'API_PROVIDER', 'APPLICATION'] as const;
export type RsiDailyCheckCategory = (typeof RSI_DAILY_CHECK_CATEGORIES)[number];

export interface RsiDailyCheckDefinition {
  id: string;
  category: RsiDailyCheckCategory;
  /** 该检查失败时的严重度。 */
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}

/** 每日检查项（覆盖 OWNER 列出的三类关键项）。 */
export const RSI_DAILY_CHECKS: readonly RsiDailyCheckDefinition[] = [
  { id: 'API_AVAILABILITY', category: 'RUNTIME', severity: 'HIGH' },
  { id: 'WORKER_HEALTH', category: 'RUNTIME', severity: 'HIGH' },
  { id: 'QUEUE_HEALTH', category: 'RUNTIME', severity: 'MEDIUM' },
  { id: 'DB_HEALTH', category: 'RUNTIME', severity: 'HIGH' },
  { id: 'RUNTIME_ERRORS', category: 'RUNTIME', severity: 'MEDIUM' },
  { id: 'RETRY_SPIKE', category: 'RUNTIME', severity: 'MEDIUM' },
  { id: 'TIMEOUT_SPIKE', category: 'RUNTIME', severity: 'MEDIUM' },
  { id: 'RESOURCE_ABNORMALITY', category: 'RUNTIME', severity: 'MEDIUM' },
  { id: 'CONTRACT_DRIFT', category: 'API_PROVIDER', severity: 'HIGH' },
  { id: 'NEW_STATUS', category: 'API_PROVIDER', severity: 'MEDIUM' },
  { id: 'UNKNOWN_ERROR', category: 'API_PROVIDER', severity: 'MEDIUM' },
  { id: 'OAUTH_FAILURE', category: 'API_PROVIDER', severity: 'HIGH' },
  { id: 'WEBHOOK_MISMATCH', category: 'API_PROVIDER', severity: 'HIGH' },
  { id: 'RATE_LIMIT_BEHAVIOR', category: 'API_PROVIDER', severity: 'MEDIUM' },
  { id: 'LATENCY_REGRESSION', category: 'API_PROVIDER', severity: 'MEDIUM' },
  { id: 'KEY_ROUTES_AVAILABLE', category: 'APPLICATION', severity: 'HIGH' },
  { id: 'FRONTEND_BACKEND_CONTRACT', category: 'APPLICATION', severity: 'MEDIUM' },
  { id: 'CRITICAL_WORKFLOW_STATES', category: 'APPLICATION', severity: 'HIGH' },
  { id: 'FAILED_BACKGROUND_TASKS', category: 'APPLICATION', severity: 'MEDIUM' },
  { id: 'MISSING_CONFIGURATION', category: 'APPLICATION', severity: 'MEDIUM' },
];

/** 探针返回值（只读观察结果，不含客户数据/凭据）。 */
export interface RsiDailyProbeResult {
  ok: boolean;
  /** 观察到的客观数值（可选）。 */
  metric?: number;
  /** 期望阈值（可选）；仅当 metric 可用时参与判定。 */
  threshold?: number;
  /** 该异常是否触及安全边界（Action Guard / HOLD / 租户隔离）。 */
  securityAffecting?: boolean;
  /** 该异常是否改变权限语义。 */
  privilegeAffecting?: boolean;
}

export interface RsiDailyInspectionSignal {
  checkId: string;
  category: RsiDailyCheckCategory;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  /** 脱敏后的一句话（不含客户数据/凭据）。 */
  summary: string;
  incidentRequired: boolean;
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
  dedupeKey: string;
}

export interface RsiDailyInspectionReport {
  job: string;
  checkedAt: string;
  checked: number;
  healthy: boolean;
  /** 健康时为空数组（**静默**）。 */
  signals: readonly RsiDailyInspectionSignal[];
}

export async function runDailyInspection(input: {
  probes: Record<string, () => Promise<RsiDailyProbeResult>>;
  now?: Date;
}): Promise<RsiDailyInspectionReport> {
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const signals: RsiDailyInspectionSignal[] = [];
  let checked = 0;

  for (const check of RSI_DAILY_CHECKS) {
    const probe = input.probes[check.id];
    if (probe === undefined) continue; // 未提供的探针不参与（不猜结果）
    checked += 1;
    const result = await probe();

    const thresholdBreached =
      result.threshold !== undefined && result.metric !== undefined && result.metric > result.threshold;
    if (result.ok && !thresholdBreached) continue; // 健康 → 静默

    const incidentRequired = check.severity === 'HIGH' || result.securityAffecting === true || result.privilegeAffecting === true;
    signals.push({
      checkId: check.id,
      category: check.category,
      severity: check.severity,
      summary: `${check.id} unhealthy${result.metric !== undefined ? ` (metric=${result.metric})` : ''}`,
      incidentRequired,
      riskClass: result.privilegeAffecting === true ? 'HIGH' : check.severity,
      dedupeKey: `DAILY_INSPECTION:${check.id}:${checkedAt.slice(0, 10)}`,
    });
  }

  return {
    job: RSI_INSPECTION_SCHEDULE.daily.job,
    checkedAt,
    checked,
    healthy: signals.length === 0,
    signals,
  };
}

export const RSI_DAILY_INSPECTION_BOUNDARY = {
  readOnlyProbes: true,
  writesDatabase: false,
  performsExternalWrite: false,
  readsCredentials: false,
  silentWhenHealthy: true,
} as const;
