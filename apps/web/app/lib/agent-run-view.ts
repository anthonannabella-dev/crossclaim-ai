import type { Messages } from '../../i18n/dictionaries/zh-CN';

/**
 * AGENT EXPERIENCE LAYER / P6 —— 执行详情（Agent Run）**业务语言投影**。
 * 只做「既有 server-derived 事实 → 客户语言」的映射：
 *   * 不出现 runner / judge / task namespace / policy engine / model router / raw blocker code；
 *   * 没有事实就不显示（空状态），绝不编造进度或金额。
 */

export interface AgentRunPayload {
  goalId: string;
  status: string;
  intent: string;
  interpretation: {
    goalType: string;
    domains: string[];
    timeRange: { kind: string; months?: number };
    executionMode: string;
    approvalThreshold?: { currency: string; amount: number } | null;
  };
  createdAt: string;
  runs: Array<{
    runId: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    summary: unknown;
  }>;
}

export type AgentRunStepState = 'DONE' | 'ACTIVE' | 'PENDING';

export interface AgentRunView {
  goalId: string;
  intent: string;
  statusLabel: string;
  scopeLabel: string;
  timeRangeLabel: string;
  approvalLabel: string | null;
  progress: Array<{ key: string; label: string; state: AgentRunStepState }>;
  results: Array<{ key: string; label: string; value: string }>;
  activity: Array<{ key: string; at: string | null; text: string }>;
}

const GOAL_STATUS_KEYS: Record<string, keyof Messages['agentRun']> = {
  PROPOSED: 'statusProposed',
  ADMITTED: 'statusAdmitted',
  RUNNING: 'statusRunning',
  COMPLETED: 'statusCompleted',
  FAILED: 'statusFailed',
  CANCELLED: 'statusCancelled',
};

const RUN_STATUS_KEYS: Record<string, keyof Messages['agentRun']> = {
  QUEUED: 'runStatusQueued',
  RUNNING: 'runStatusRunning',
  COMPLETED: 'runStatusCompleted',
  BLOCKED: 'runStatusBlocked',
  FAILED: 'runStatusFailed',
  CANCELLED: 'runStatusCancelled',
};

const DOMAIN_KEYS: Record<string, keyof Messages['agentRun']> = {
  PLATFORM: 'scopePlatform',
  LOGISTICS: 'scopeLogistics',
  CUSTOMS: 'scopeCustoms',
  INDEPENDENT_SITE: 'scopeIndependentSite',
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function buildProgress(status: string, t: Messages): AgentRunView['progress'] {
  const labels = [t.agentRun.stepRecorded, t.agentRun.stepPlanned, t.agentRun.stepChecking, t.agentRun.stepSummary];
  const keys = ['recorded', 'planned', 'checking', 'summary'];
  // 只按**真实状态**推进：未发生的步骤保持 PENDING
  const reached =
    status === 'COMPLETED' ? 4 : status === 'RUNNING' ? 3 : status === 'ADMITTED' ? 2 : 1;
  return keys.map((key, index) => ({
    key,
    label: labels[index],
    state: index < reached - 1 ? 'DONE' : index === reached - 1 ? (status === 'COMPLETED' ? 'DONE' : 'ACTIVE') : 'PENDING',
  }));
}

function buildResults(payload: AgentRunPayload, t: Messages): AgentRunView['results'] {
  const latest = payload.runs[0];
  if (!latest) return [];
  const summary = asRecord(latest.summary);
  const rows: AgentRunView['results'] = [];
  const opportunities = asCount(summary.opportunitiesFound);
  if (opportunities !== null) rows.push({ key: 'opportunities', label: t.agentRun.resultOpportunities, value: String(opportunities) });
  const autoProcessing = asCount(summary.autoProcessing);
  if (autoProcessing !== null) rows.push({ key: 'autoProcessing', label: t.agentRun.resultAutoProcessing, value: String(autoProcessing) });
  const needsApproval = asCount(summary.needsApproval);
  if (needsApproval !== null) rows.push({ key: 'needsApproval', label: t.agentRun.resultNeedsApproval, value: String(needsApproval) });
  const waitingEvidence = asCount(summary.waitingEvidence);
  if (waitingEvidence !== null) rows.push({ key: 'waitingEvidence', label: t.agentRun.resultWaitingEvidence, value: String(waitingEvidence) });
  const recovered = asCount(summary.recovered);
  if (recovered !== null) rows.push({ key: 'recovered', label: t.agentRun.resultRecovered, value: String(recovered) });
  // 金额只接受**逐币种**结构，绝不跨币种求和
  const estimated = Array.isArray(summary.estimatedRecoverableByCurrency) ? summary.estimatedRecoverableByCurrency : [];
  for (const entry of estimated) {
    const row = asRecord(entry);
    if (typeof row.currency === 'string' && typeof row.amount === 'string') {
      rows.push({ key: 'estimated:' + row.currency, label: t.agentRun.resultEstimated, value: row.currency + ' ' + row.amount });
    }
  }
  return rows;
}

function buildActivity(payload: AgentRunPayload, t: Messages): AgentRunView['activity'] {
  const rows: AgentRunView['activity'] = [
    { key: 'goal-recorded', at: payload.createdAt, text: t.agentRun.activityGoalRecorded },
  ];
  for (const run of payload.runs) {
    rows.push({
      key: 'run-start:' + run.runId,
      at: run.startedAt,
      text: t.agentRun.activityRunStarted + ' · ' + (t.agentRun[RUN_STATUS_KEYS[run.status] ?? 'runStatusQueued'] as string),
    });
    if (run.completedAt) {
      rows.push({ key: 'run-end:' + run.runId, at: run.completedAt, text: t.agentRun.activityRunFinished });
    }
  }
  return rows.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

export function buildAgentRunView(payload: AgentRunPayload, t: Messages): AgentRunView {
  const domains = payload.interpretation.domains ?? [];
  const scopeLabel = domains.map((domain) => t.agentRun[DOMAIN_KEYS[domain] ?? 'scopePlatform'] as string).join(' · ');
  const range = payload.interpretation.timeRange ?? { kind: 'ALL_TIME' };
  const timeRangeLabel =
    range.kind === 'LAST_N_MONTHS'
      ? t.agentRun.lastNMonths.replace('{months}', String(range.months ?? 12))
      : range.kind === 'YEAR_TO_DATE'
        ? t.agentRun.yearToDate
        : t.agentRun.allTime;
  const threshold = payload.interpretation.approvalThreshold ?? null;
  const approvalLabel = threshold
    ? t.agentRun.approvalLimit.replace('{currency}', threshold.currency).replace('{amount}', String(threshold.amount))
    : null;

  return {
    goalId: payload.goalId,
    intent: payload.intent,
    statusLabel: (t.agentRun[GOAL_STATUS_KEYS[payload.status] ?? 'statusProposed'] as string) ?? t.agentRun.statusProposed,
    scopeLabel,
    timeRangeLabel,
    approvalLabel,
    progress: buildProgress(payload.status, t),
    results: buildResults(payload, t),
    activity: buildActivity(payload, t),
  };
}

export const AGENT_RUN_VIEW_BOUNDARY = {
  businessLanguageOnly: true,
  exposesRunnerInternals: false,
  exposesJudge: false,
  exposesTaskNamespace: false,
  exposesPolicyEngine: false,
  exposesModelRouter: false,
  exposesRawBlockerCodes: false,
  fabricatesProgressOrMoney: false,
  crossCurrencySumming: false,
} as const;
