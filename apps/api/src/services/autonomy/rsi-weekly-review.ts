/**
 * RSI Weekly Full-System Review（RSI-INSP-03，纯函数 + 注入式只读套件）
 * ---------------------------------------------------------------
 * 依据 OWNER《Continuous Inspection》第 3 节：每周做一次更完整审计，并产出**机器可读**结果
 * （不是只有自然语言报告）。缺套件必须显式 SKIPPED，**不得静默跳过**。
 *
 * 只读边界：套件由宿主注入；本模块不写库、不外写、不读凭据。
 */

import { RSI_INSPECTION_SCHEDULE } from './rsi-drift-detector';

export const RSI_WEEKLY_SUITES = [
  'REGRESSION_SUITE',
  'INTEGRATION_TESTS',
  'POSTGRES_E2E',
  'CONTRACT_TESTS',
  'GOLDEN_FIXTURES',
  'BUSINESS_INVARIANTS',
  'AI_BENCHMARK',
  'PROMPT_PERFORMANCE',
  'MODEL_ROUTING',
  'TOKEN_API_COST',
  'LATENCY',
  'PROVIDER_RELIABILITY',
  'RECOVERY_OUTCOME_QUALITY',
  'HUMAN_INTERVENTION',
  'CAPABILITY_GAP',
] as const;
export type RsiWeeklySuite = (typeof RSI_WEEKLY_SUITES)[number];

export interface RsiSuiteResult {
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  /** 客观指标（键值对，机器可读）。 */
  metrics?: Record<string, number>;
  /** 脱敏说明（无客户数据/凭据）。 */
  detail?: string;
  securityAffecting?: boolean;
  privilegeAffecting?: boolean;
}

export interface RsiWeeklySuiteFinding {
  suite: RsiWeeklySuite;
  status: RsiSuiteResult['status'];
  incidentRequired: boolean;
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
  reasonCode: 'SUITE_FAILED' | 'SUITE_SKIPPED' | 'CAPABILITY_GAP' | 'SECURITY_OR_PRIVILEGE';
  dedupeKey: string;
}

export interface RsiWeeklyReviewReport {
  job: string;
  reviewedAt: string;
  schema: 'rsi-weekly-review-v1';
  summary: { passed: number; failed: number; skipped: number };
  suites: readonly { suite: RsiWeeklySuite; status: RsiSuiteResult['status']; metrics: Record<string, number> }[];
  findings: readonly RsiWeeklySuiteFinding[];
  incidentRequired: boolean;
}

export function runWeeklyReview(input: {
  suites: Partial<Record<RsiWeeklySuite, () => Promise<RsiSuiteResult>>>;
  now?: Date;
}): Promise<RsiWeeklyReviewReport> {
  const now = input.now ?? new Date();
  return (async () => {
    const reviewedAt = now.toISOString();
    const weekKey = reviewedAt.slice(0, 10);
    const suites: RsiWeeklyReviewReport['suites'] = [] as never;
    const listed: { suite: RsiWeeklySuite; status: RsiSuiteResult['status']; metrics: Record<string, number> }[] = [];
    const findings: RsiWeeklySuiteFinding[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const suite of RSI_WEEKLY_SUITES) {
      const runner = input.suites[suite];
      const result: RsiSuiteResult = runner === undefined ? { status: 'SKIPPED' } : await runner();
      listed.push({ suite, status: result.status, metrics: result.metrics ?? {} });

      if (result.status === 'PASS') {
        passed += 1;
        continue;
      }
      if (result.status === 'SKIPPED') skipped += 1;
      else failed += 1;

      const securityOrPrivilege = result.securityAffecting === true || result.privilegeAffecting === true;
      const capabilityGap = suite === 'CAPABILITY_GAP' && result.status === 'FAIL';
      findings.push({
        suite,
        status: result.status,
        incidentRequired: true,
        riskClass: securityOrPrivilege ? 'HIGH' : result.status === 'FAIL' ? 'MEDIUM' : 'LOW',
        reasonCode: securityOrPrivilege
          ? 'SECURITY_OR_PRIVILEGE'
          : capabilityGap
            ? 'CAPABILITY_GAP'
            : result.status === 'SKIPPED'
              ? 'SUITE_SKIPPED'
              : 'SUITE_FAILED',
        dedupeKey: `WEEKLY_REVIEW:${suite}:${weekKey}`,
      });
    }

    void suites;
    return {
      job: RSI_INSPECTION_SCHEDULE.weekly.job,
      reviewedAt,
      schema: 'rsi-weekly-review-v1',
      summary: { passed, failed, skipped },
      suites: listed,
      findings,
      incidentRequired: findings.length > 0,
    };
  })();
}

export const RSI_WEEKLY_REVIEW_BOUNDARY = {
  machineReadable: true,
  silentlySkippedSuites: false,
  writesDatabase: false,
  performsExternalWrite: false,
  readsCredentials: false,
} as const;
