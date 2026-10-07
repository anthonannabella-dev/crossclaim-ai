import type { Messages } from '../../i18n/dictionaries/zh-CN';

/**
 * UI-2 Dashboard 视图模型（MSG-20261004-01 §四–§六、§九）。
 * 纯函数：只做「后端事实 → 客户语言」的映射，不在前端重算任何金额裁决，也不做跨币种求和。
 */

export interface MoneyBucket {
  currency: string;
  discovered: string;
  expected: string;
  approved: string;
  recovered: string;
  adjustments: string;
  netRecovered: string;
  outstanding: string;
  feeCalculated: string;
  feeCollected: string;
}

export interface MoneyMetricCell {
  key: 'expected' | 'inProgress' | 'confirmed' | 'received' | 'net' | 'outstanding' | 'feeCalculated' | 'feeCollected';
  label: string;
  value: string;
  hint: string | null;
  emphasis: boolean;
}

export interface CurrencySummary {
  currency: string;
  cells: MoneyMetricCell[];
}

/**
 * 4 个核心指标（+ 净追回 / 未追回 / 服务费），按币种分组，不跨币种求和。
 * 取值全部来自 /recovery-money 的持久化聚合：discovered=已检测待确认、expected=追回中、
 * approved=已确认、recovered=已到账。
 */
export function buildCurrencySummaries(
  buckets: MoneyBucket[] | null | undefined,
  t: Messages,
): CurrencySummary[] {
  return (buckets ?? []).map((bucket) => ({
    currency: bucket.currency,
    cells: [
      {
        key: 'expected',
        label: t.dashboardPage.metricExpected,
        value: bucket.discovered,
        hint: t.dashboardPage.metricExpectedHint,
        emphasis: false,
      },
      {
        key: 'inProgress',
        label: t.dashboardPage.metricInProgress,
        value: bucket.expected,
        hint: null,
        emphasis: false,
      },
      {
        key: 'confirmed',
        label: t.dashboardPage.metricConfirmed,
        value: bucket.approved,
        hint: null,
        emphasis: false,
      },
      {
        key: 'received',
        label: t.dashboardPage.metricReceived,
        value: bucket.recovered,
        hint: null,
        emphasis: false,
      },
      {
        key: 'net',
        label: t.dashboardPage.metricNet,
        value: bucket.netRecovered,
        hint: null,
        emphasis: true,
      },
      {
        key: 'outstanding',
        label: t.dashboardPage.metricOutstanding,
        value: bucket.outstanding,
        hint: null,
        emphasis: false,
      },
      {
        key: 'feeCalculated',
        label: t.dashboardPage.metricFeeCalculated,
        value: bucket.feeCalculated,
        hint: t.dashboardPage.metricFeeHint,
        emphasis: false,
      },
      {
        key: 'feeCollected',
        label: t.dashboardPage.metricFeeCollected,
        value: bucket.feeCollected,
        hint: null,
        emphasis: false,
      },
    ],
  }));
}

export type DashboardCtaKind = 'CONNECT' | 'SCAN' | 'OPPORTUNITIES' | 'TASKS';

export interface DashboardCta {
  kind: DashboardCtaKind;
  label: string;
  href: string;
}

/**
 * 首屏主 CTA 按客户真实状态切换（§四）：
 * 有待办 → 处理待办；有未连接平台 → 连接我的平台；已连接无机会 → 开始扫描；有机会 → 查看机会。
 */
export function selectPrimaryCta(
  input: { pendingTasks: number; connectedAccounts: number; opportunityCount: number; missingPlatforms: number },
  t: Messages,
): DashboardCta {
  if (input.pendingTasks > 0) {
    return { kind: 'TASKS', label: t.dashboardPage.ctaHandleTasks, href: '#customer-tasks' };
  }
  if (input.connectedAccounts === 0 && input.missingPlatforms > 0) {
    return { kind: 'CONNECT', label: t.dashboardPage.ctaConnect, href: '/connections' };
  }
  if (input.opportunityCount > 0) {
    return { kind: 'OPPORTUNITIES', label: t.dashboardPage.ctaViewOpportunities, href: '/opportunities' };
  }
  return { kind: 'SCAN', label: t.dashboardPage.ctaScan, href: '/upload' };
}

export type PlatformTone = 'ok' | 'warn' | 'pending' | 'neutral';

export interface PlatformCardView {
  key: string;
  name: string;
  status: string;
  tone: PlatformTone;
  accounts: number;
  lastSync: string | null;
  detail: string | null;
  cta: { label: string; href: string } | null;
  unavailable: boolean;
  /** 工程状态（BOUND_ACTIVE / credentialRef 等）只在这里出现，供「高级详情」折叠展示。 */
  advanced: string[];
}

export interface AccountsConnection {
  status: string;
  channel: string;
  domain: string;
  lastSyncAt: string | null;
  lastErrorAt: string | null;
  actions?: { reconnect?: { available: boolean; reason: string } };
}

export interface AccountsAccount {
  platform: string;
  displayName: string;
  status: string;
  connections: AccountsConnection[];
}

export interface AccountsResponse {
  platforms: Array<{ platform: string; accounts: AccountsAccount[] }>;
  unboundLegacyConnections: AccountsConnection[];
}

const LOGISTICS_CHANNELS = ['UPS', 'FEDEX', 'DHL', 'FREIGHT_FORWARDER'];

function connectionStatusLabel(connection: AccountsConnection, t: Messages): { label: string; tone: PlatformTone } {
  if (connection.actions?.reconnect?.reason === 'REAL_OAUTH_EXTERNAL_GATE') {
    return { label: t.dashboardPage.platformNeedsAuth, tone: 'warn' };
  }
  switch (connection.status) {
    case 'ACTIVE':
      return { label: t.dashboardPage.platformConnected, tone: 'ok' };
    case 'NEEDS_AUTH':
      return { label: t.dashboardPage.platformNeedsAuth, tone: 'warn' };
    case 'PAUSED':
      return { label: t.dashboardPage.platformWaitingData, tone: 'pending' };
    case 'ERROR':
      return { label: t.dashboardPage.platformNeedsConfig, tone: 'warn' };
    default:
      return { label: t.dashboardPage.platformNeedsConfig, tone: 'neutral' };
  }
}

function summarizeConnections(connections: AccountsConnection[], t: Messages) {
  if (connections.length === 0) {
    return { status: t.dashboardPage.platformNeedsConfig, tone: 'neutral' as PlatformTone, lastSync: null };
  }
  const labels = connections.map((connection) => connectionStatusLabel(connection, t));
  const priority: PlatformTone[] = ['warn', 'pending', 'neutral', 'ok'];
  const tone = priority.find((candidate) => labels.some((row) => row.tone === candidate)) ?? 'neutral';
  const status = labels.find((row) => row.tone === tone)?.label ?? t.dashboardPage.platformNeedsConfig;
  const lastSync =
    connections
      .map((connection) => connection.lastSyncAt)
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .sort()
      .at(-1) ?? null;
  return { status, tone, lastSync };
}

/**
 * 平台覆盖卡：只按真实系统能力展示。
 * Amazon / 物流 / Customs 来自真实连接与账号；TikTok Shop / Walmart / Shopify 目前没有
 * adapter 与 channel，一律显示「暂未开放」（不伪造已连接）。
 */
export function buildPlatformCards(accounts: AccountsResponse | null | undefined, t: Messages): PlatformCardView[] {
  const groups = accounts?.platforms ?? [];
  const allConnections = groups.flatMap((group) => group.accounts.flatMap((account) => account.connections));

  const amazonAccounts = groups.filter((group) => group.platform.toUpperCase().includes('AMAZON'));
  const amazonConnections = allConnections.filter(
    (connection) => connection.channel === 'AMAZON_FBA' || connection.channel === 'AMAZON_OTHER',
  );
  const logisticsConnections = allConnections.filter((connection) => LOGISTICS_CHANNELS.includes(connection.channel));
  const customsConnections = allConnections.filter(
    (connection) => connection.domain === 'CUSTOMS' || connection.channel === 'CUSTOMS_BROKER',
  );

  const card = (
    key: string,
    name: string,
    connections: AccountsConnection[],
    accountCount: number,
    href: string,
  ): PlatformCardView => {
    const summary = summarizeConnections(connections, t);
    return {
      key,
      name,
      status: summary.status,
      tone: summary.tone,
      accounts: accountCount,
      lastSync: summary.lastSync,
      detail: null,
      cta:
        summary.tone === 'ok'
          ? { label: t.dashboardPage.platformOpen, href }
          : { label: t.dashboardPage.platformConfigure, href },
      unavailable: false,
      advanced: connections.map(
        (connection) =>
          connection.channel + ' · ' + connection.domain + ' · ' + connection.status,
      ),
    };
  };

  const unavailable = (key: string, name: string): PlatformCardView => ({
    key,
    name,
    status: t.dashboardPage.platformUnavailable,
    tone: 'neutral',
    accounts: 0,
    lastSync: null,
    detail: t.dashboardPage.platformUnavailableDetail,
    cta: null,
    unavailable: true,
    advanced: [],
  });

  return [
    card('amazon', t.dashboardPage.platformAmazon, amazonConnections, amazonAccounts.reduce((total, group) => total + group.accounts.length, 0), '/accounts'),
    card('logistics', t.dashboardPage.platformLogistics, logisticsConnections, 0, '/accounts'),
    card('customs', t.dashboardPage.platformCustoms, customsConnections, 0, '/accounts'),
    unavailable('tiktok', t.dashboardPage.platformTiktok),
    unavailable('walmart', t.dashboardPage.platformWalmart),
    unavailable('shopify', t.dashboardPage.platformShopify),
  ];
}

export interface RecoveryStateItem {
  scope: 'CONNECTION' | 'IMPORT' | 'CASE';
  refId: string;
  title: string;
  code: string;
  label: string;
  explanation: string;
  nextAction: string;
  recoverable: boolean;
  safeSummary: string;
}

/**
 * P5：Needs Your Attention 的任务类别（**单一模型**，不新建第二套待办中心）。
 * 覆盖 HOST 要求的 10 类 + 既有 recovery-states 的 2 个 scope（保持能力不丢失）。
 */
export const TASK_KINDS = [
  'AUTHORIZATION',
  'APPROVAL',
  'CUSTOMS_POA',
  'CUSTOMS_SIGNER',
  'PROVIDER_AUTHORIZATION',
  'CONNECTION_REAUTH',
  'EVIDENCE_CONFLICT',
  'ACCOUNT_RECONNECT',
  'PAYMENT_ACTION',
  'CASE',
  'CONNECTION',
  'IMPORT',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface TaskView {
  id: string;
  kind: TaskKind;
  title: string;
  what: string;
  impact: string;
  why: string;
  ctaLabel: string;
  ctaHref: string;
}

/** 待办中心：发生了什么 / 影响什么 / 为什么需要你 / 一个明确 CTA（§九）。 */
export function buildTasks(items: RecoveryStateItem[] | null | undefined, t: Messages): TaskView[] {
  return (items ?? []).map((item) => ({
    id: item.scope + ':' + item.refId,
    kind: item.scope,
    title: item.title ? item.title + ' · ' + item.label : item.label,
    what: item.explanation,
    impact: item.recoverable ? t.dashboardPage.taskImpactRecoverable : t.dashboardPage.taskImpactBlocking,
    why: item.safeSummary || t.dashboardPage.taskWhyUser,
    ctaLabel: item.nextAction || t.dashboardPage.taskCta,
    ctaHref:
      item.scope === 'CONNECTION'
        ? '/connections'
        : item.scope === 'IMPORT'
          ? '/upload'
          : '/cases/' + item.refId,
  }));
}

/**
 * P5：从**既有 /accounts 事实**派生授权 / 重连类待办（不新增事实源）。
 * 只使用连接状态与既有 `actions.reconnect` 结论；不猜测原因、不伪造 CTA。
 */
export function buildConnectionTasks(accounts: AccountsResponse | null | undefined, t: Messages): TaskView[] {
  const rows: TaskView[] = [];
  for (const group of accounts?.platforms ?? []) {
    for (const account of group.accounts) {
      for (const connection of account.connections) {
        const needsReauth =
          connection.status === 'NEEDS_AUTH' || connection.actions?.reconnect?.available === true;
        const label = account.displayName + ' · ' + connection.channel;
        if (needsReauth) {
          rows.push({
            id: 'reauth:' + account.platform + ':' + account.displayName + ':' + connection.channel,
            kind: 'CONNECTION_REAUTH',
            title: label,
            what: t.needsAttention.reconnectTitle,
            impact: t.dashboardPage.taskImpactBlocking,
            why: t.needsAttention.reconnectBody,
            ctaLabel: t.needsAttention.reconnectCta,
            ctaHref: '/connections',
          });
          continue;
        }
        if (connection.status === 'ERROR') {
          rows.push({
            id: 'reconnect:' + account.platform + ':' + account.displayName + ':' + connection.channel,
            kind: 'ACCOUNT_RECONNECT',
            title: label,
            what: t.needsAttention.repairTitle,
            impact: t.dashboardPage.taskImpactBlocking,
            why: t.needsAttention.repairBody,
            ctaLabel: t.needsAttention.repairCta,
            ctaHref: '/connections',
          });
        }
      }
    }
  }
  return rows;
}

/** P5：多个来源合并为**一个**待办列表（按 id 去重，顺序稳定），不产生第二套待办中心。 */
export function mergeNeedsAttention(...sources: TaskView[][]): TaskView[] {
  const seen = new Set<string>();
  const merged: TaskView[] = [];
  for (const source of sources) {
    for (const task of source) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      merged.push(task);
    }
  }
  return merged;
}

export interface OpportunityView {
  id: string;
  source: string;
  problem: string;
  amount: string | null;
  currency: string;
  confidence: string;
  statusLabel: string;
  statusCode: string;
  deadline: string | null;
  account: string | null;
  canReview: boolean;
  canCreateCase: boolean;
  unattributed: boolean;
  channel: string;
  domain: string;
  opportunityType: string;
}

export interface OpportunityApiItem {
  id: string;
  status: string;
  customerStatus: { code: string; label: string };
  opportunityType: string;
  title: string;
  description: string | null;
  recoverableAmount: string | null;
  currency: string;
  confidence: number | null;
  claimDeadline: string | null;
  channel: string;
  domain: string;
  accountState: 'ATTRIBUTED' | 'LEGACY_UNATTRIBUTED';
  account: { platform: string; displayName: string } | null;
  actions: { canQualify: boolean; canReject: boolean; canCreateCase: boolean };
}

export function confidenceLabel(confidence: number | null, t: Messages): string {
  if (confidence === null || Number.isNaN(confidence)) return t.dashboardPage.confidenceUnknown;
  if (confidence >= 0.8) return t.dashboardPage.confidenceHigh;
  if (confidence >= 0.5) return t.dashboardPage.confidenceMedium;
  return t.dashboardPage.confidenceLow;
}

export function buildOpportunityView(item: OpportunityApiItem, t: Messages): OpportunityView {
  return {
    id: item.id,
    source: item.account?.platform ?? (item.domain || t.dashboardPage.opportunityUnattributed),
    problem: item.title || item.opportunityType,
    amount: item.recoverableAmount,
    currency: item.currency,
    confidence: confidenceLabel(item.confidence, t),
    statusLabel: item.customerStatus.label,
    statusCode: item.customerStatus.code,
    deadline: item.claimDeadline,
    account: item.account?.displayName ?? null,
    canReview: item.actions.canQualify,
    canCreateCase: item.actions.canCreateCase,
    unattributed: item.accountState === 'LEGACY_UNATTRIBUTED',
    channel: item.channel,
    domain: item.domain,
    opportunityType: item.opportunityType,
  };
}

// ============================================================
// AGENT EXPERIENCE LAYER / P4（HOST 2026-10-07）：首页核心结果收敛
// 四张卡：Recoverable / In recovery / Recovered / Needs your attention。
// 金额**逐币种原样展示**（后端持久化字符串），**不做任何跨币种求和或前端推导**；
// Needs your attention 展示的是**计数**（来自既有 recovery-states），不是金额。
// ============================================================

export interface ActiveFlowView {
  id: string;
  title: string;
  detail: string;
  href: string;
}

export interface ActiveFlowGoalItem {
  goalId: string;
  status: string;
  intent: string;
}

export interface ActiveFlowCaseItem {
  caseId: string;
  title: string;
  statusLabel: string;
}

/**
 * CUSTOMER-UI-PRODUCTIZATION-V2 / P3：CrossClaim 正在帮你做什么。
 * 只把**已有后端事实**翻译成客户语言：
 *   - goal 的 ADMITTED / RUNNING（客户自己的目标文本 + 由状态派生的业务语言）；
 *   - 已有 case 的后端标签（statusLabel 由服务端给出，前端不翻译状态码）。
 * 不新增事实源、不做金额计算、不展示 task namespace / queue id / provider 内部状态。
 */
export function buildActiveFlows(
  input: {
    goals?: ActiveFlowGoalItem[] | null;
    cases?: ActiveFlowCaseItem[] | null;
    limit?: number;
  },
  t: Messages,
): ActiveFlowView[] {
  const limit = input.limit ?? 5;
  const flows: ActiveFlowView[] = [];
  for (const goal of input.goals ?? []) {
    if (goal.status !== 'ADMITTED' && goal.status !== 'RUNNING') continue;
    flows.push({
      id: 'goal:' + goal.goalId,
      title: goal.intent,
      detail: goal.status === 'RUNNING' ? t.activeRecovery.goalRunningDetail : t.activeRecovery.goalAdmittedDetail,
      href: '/money',
    });
  }
  for (const item of input.cases ?? []) {
    if (typeof item.statusLabel !== 'string' || item.statusLabel.trim() === '') continue;
    flows.push({
      id: 'case:' + item.caseId,
      title: item.title,
      detail: item.statusLabel,
      href: '/cases/' + item.caseId,
    });
  }
  return flows.slice(0, limit);
}

export type HeadlineCardKey = 'recoverable' | 'inRecovery' | 'recovered' | 'needsAttention';

export interface HeadlineCardValue {
  currency: string;
  /** 后端返回的金额字符串，前端原样展示，不解析、不换算、不求和 */
  amount: string;
}

export interface HeadlineCard {
  key: HeadlineCardKey;
  label: string;
  values: HeadlineCardValue[];
  count: number | null;
  emptyLabel: string;
  href: string | null;
  linkLabel: string | null;
  hint: string | null;
}

export function buildHeadlineCards(
  buckets: MoneyBucket[] | null | undefined,
  needAttentionCount: number,
  t: Messages,
): HeadlineCard[] {
  const rows = buckets ?? [];
  const perCurrency = (pick: (bucket: MoneyBucket) => string): HeadlineCardValue[] =>
    rows.map((bucket) => ({ currency: bucket.currency, amount: pick(bucket) }));
  return [
    {
      key: 'recoverable',
      label: t.goalConsole.recoverable,
      values: perCurrency((bucket) => bucket.discovered),
      count: null,
      emptyLabel: t.goalConsole.amountUnknown,
      href: '/money',
      linkLabel: t.dashboardPage.moneyLink,
      hint: null,
    },
    {
      key: 'inRecovery',
      label: t.goalConsole.inRecovery,
      values: perCurrency((bucket) => bucket.expected),
      count: null,
      emptyLabel: t.goalConsole.amountUnknown,
      href: '/money',
      linkLabel: t.dashboardPage.moneyLink,
      hint: null,
    },
    {
      key: 'recovered',
      label: t.goalConsole.recovered,
      values: perCurrency((bucket) => bucket.recovered),
      count: null,
      emptyLabel: t.goalConsole.amountUnknown,
      href: '/money',
      linkLabel: t.dashboardPage.moneyLink,
      hint: null,
    },
    {
      key: 'needsAttention',
      label: t.goalConsole.needsAttention,
      values: [],
      count: needAttentionCount,
      emptyLabel: t.goalConsole.amountUnknown,
      href: '#customer-tasks',
      linkLabel: t.dashboardPage.ctaHandleTasks,
      hint: t.goalConsole.attentionHint,
    },
  ];
}

/** P5：任务类别 → 客户语言（技术 code 不上主文案；高级视图才看得到 code） */
export function buildTaskKindLabels(t: Messages): Record<TaskKind, string> {
  return {
    AUTHORIZATION: t.needsAttention.kindAuthorization,
    APPROVAL: t.needsAttention.kindApproval,
    CUSTOMS_POA: t.needsAttention.kindCustomsPoa,
    CUSTOMS_SIGNER: t.needsAttention.kindCustomsSigner,
    PROVIDER_AUTHORIZATION: t.needsAttention.kindProviderAuthorization,
    CONNECTION_REAUTH: t.needsAttention.kindConnectionReauth,
    EVIDENCE_CONFLICT: t.needsAttention.kindEvidenceConflict,
    ACCOUNT_RECONNECT: t.needsAttention.kindAccountReconnect,
    PAYMENT_ACTION: t.needsAttention.kindPaymentAction,
    CASE: t.needsAttention.kindCase,
    CONNECTION: t.needsAttention.kindConnection,
    IMPORT: t.needsAttention.kindImport,
  };
}

/**
 * 按需授权（P9 补强）：当**已记录的目标**还在等待授权时，在 Needs Your Attention 里出现一条
 * AUTHORIZATION 项 —— 客户完成授权后 CrossClaim 继续执行**原来那个目标**（无需重新提交）。
 * 数据来自既有 `GET /agent-goals`（客户意图投影），不新增事实源。
 */
export interface GoalForAuthorizationTask {
  goalId: string;
  status: string;
  intent: string;
}

export function buildAuthorizationTasks(
  goals: GoalForAuthorizationTask[] | null | undefined,
  t: Messages,
): TaskView[] {
  return (goals ?? [])
    .filter((goal) => goal.status === 'PROPOSED')
    .map((goal) => ({
      id: 'authorization:' + goal.goalId,
      kind: 'AUTHORIZATION' as const,
      title: goal.intent,
      what: t.needsAttention.authorizationGoalTitle,
      impact: t.dashboardPage.taskImpactBlocking,
      why: t.needsAttention.authorizationGoalBody,
      ctaLabel: t.needsAttention.authorizationGoalCta,
      ctaHref: '/authorizations',
    }));
}
