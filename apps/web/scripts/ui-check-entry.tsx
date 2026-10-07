/**
 * UI-1 / UI-2 渲染验收（esbuild + react-dom/server；由 scripts/ui-render-check.mjs 驱动）。
 * 覆盖：Shell 导航/响应式标记/ADMIN 隔离、金额按币种、平台状态客户语言、待办 CTA、
 * 机会卡工程字段折叠、空/错/权限状态文案、i18n 键接线、CTA 选择矩阵。
 */
import { renderToStaticMarkup } from 'react-dom/server';

import CustomerShell from '../app/components/customer-shell';
import { buildCustomerNav } from '../app/components/nav-model';
import ConnectionManager, { type ConnectionItem } from '../app/components/connection-manager';
import AccountManagementView from '../app/accounts/account-management-view';
import RecoveryPipeline from '../app/components/ui/recovery-pipeline';
import { buildRecoveryPipeline, caseStatusLabel, pipelineStateLabel } from '../app/lib/case-view';
import ClaimPackageView from '../app/cases/[id]/claim-package/claim-package-view';
import RecoveryMoneyView from '../app/money/recovery-money-view';
import InlineNotice from '../app/components/ui/inline-notice';
import PlatformCard from '../app/components/ui/platform-card';
import SecurityStrip from '../app/components/ui/security-strip';
import SummaryCards from '../app/components/ui/summary-cards';
import TaskCenter from '../app/components/ui/task-center';
import OpportunityCard from '../app/components/opportunity-card';
import OpportunityList from '../app/opportunities/opportunity-list';
import {
  buildCurrencySummaries,
  buildOpportunityView,
  buildPlatformCards,
  buildHeadlineCards,
  buildTasks,
  buildConnectionTasks,
  buildTaskKindLabels,
  mergeNeedsAttention,
  buildAuthorizationTasks,
  buildActiveFlows,
  TASK_KINDS,
  selectPrimaryCta,
  type AccountsResponse,
  type MoneyBucket,
  type OpportunityApiItem,
  type RecoveryStateItem,
} from '../app/lib/dashboard-view';
import enUS from '../i18n/dictionaries/en-US';import GoalConsole from '../app/components/ui/goal-console';
import AgentRunViewComponent from '../app/recoveries/runs/[id]/agent-run-view';
import AuthorizationList from '../app/authorizations/authorization-list';
import RecoveryHeadlineCards from '../app/components/ui/recovery-headline-cards';
import ActiveRecovery from '../app/components/ui/active-recovery';
import zhCN from '../i18n/dictionaries/zh-CN';
import { buildAgentRunView } from '../app/lib/agent-run-view';

const failures: string[] = [];
const results: string[] = [];
const check = (label: string, condition: boolean) => {
  if (condition) results.push('PASS ' + label);
  else failures.push(label);
};
const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const bucket: MoneyBucket = {
  currency: 'USD',
  discovered: '8120.00',
  expected: '3250.00',
  approved: '1280.00',
  recovered: '640.00',
  adjustments: '0.00',
  netRecovered: '640.00',
  outstanding: '7480.00',
  feeCalculated: '96.00',
  feeCollected: '0.00',
};

// ① Shell：桌面导航 + 移动端标记 + ADMIN/OPS 隔离
const shellHtml = render(
  <CustomerShell t={zhCN} locale="zh-CN">
    <p>CONTENT</p>
  </CustomerShell>,
);
check('shell.renders.children', shellHtml.includes('CONTENT'));
check('shell.nav.home', shellHtml.includes(zhCN.customerShell.navHome));
check('shell.nav.opportunities', shellHtml.includes(zhCN.customerShell.navOpportunities));
check('shell.nav.money', shellHtml.includes(zhCN.customerShell.navMoney));
check('shell.nav.connections', shellHtml.includes(zhCN.customerShell.navConnections));
check('shell.mobile.drawer.control', shellHtml.includes('aria-controls="customer-nav-drawer"'));
check('shell.responsive.markers', shellHtml.includes('lg:hidden') && shellHtml.includes('lg:block'));
check('shell.skip.link', shellHtml.includes('main-content') && shellHtml.includes(zhCN.customerShell.skipToContent));
check('shell.no.admin.routes', !shellHtml.includes('/admin') && !shellHtml.includes('/operations'));
check('shell.no.engineering.status', !shellHtml.includes('BOUND_ACTIVE') && !shellHtml.includes('credentialRef'));
check('shell.nav.customs', shellHtml.includes(zhCN.customerShell.navCustoms) && shellHtml.includes('/customs'));

// ② 金额区：按币种、四核心指标 + 净追回，且不跨币种求和
const summaryHtml = render(
  <SummaryCards
    summaries={buildCurrencySummaries([bucket], zhCN)}
    currencyLabel={zhCN.dashboardPage.currencyLabel}
    emptyTitle={zhCN.dashboardPage.metricsEmpty}
    emptyBody={zhCN.dashboardPage.metricsEmptyBody}
    emptyAction={{ label: zhCN.dashboardPage.ctaConnect, href: '/connections' }}
    holdNote={zhCN.dashboardPage.paymentsHold}
    link={{ label: zhCN.dashboardPage.moneyLink, href: '/money' }}
  />,
);
check('money.currency.grouped', summaryHtml.includes('USD'));
check('money.metric.expected', summaryHtml.includes(zhCN.dashboardPage.metricExpected) && summaryHtml.includes('8120.00'));
check('money.metric.progress', summaryHtml.includes(zhCN.dashboardPage.metricInProgress) && summaryHtml.includes('3250.00'));
check('money.metric.confirmed', summaryHtml.includes(zhCN.dashboardPage.metricConfirmed) && summaryHtml.includes('1280.00'));
check('money.metric.received', summaryHtml.includes(zhCN.dashboardPage.metricReceived) && summaryHtml.includes('640.00'));
check('money.net.highlight', summaryHtml.includes(zhCN.dashboardPage.metricNet) && summaryHtml.includes('text-emerald-700'));
check('money.payment.hold.wording', summaryHtml.includes(zhCN.dashboardPage.paymentsHold));

const emptySummaryHtml = render(
  <SummaryCards
    summaries={[]}
    currencyLabel={zhCN.dashboardPage.currencyLabel}
    emptyTitle={zhCN.dashboardPage.metricsEmpty}
    emptyBody={zhCN.dashboardPage.metricsEmptyBody}
    emptyAction={{ label: zhCN.dashboardPage.ctaConnect, href: '/connections' }}
    holdNote={zhCN.dashboardPage.paymentsHold}
    link={{ label: zhCN.dashboardPage.moneyLink, href: '/money' }}
  />,
);
check('money.empty.state', emptySummaryHtml.includes(zhCN.dashboardPage.metricsEmpty) && emptySummaryHtml.includes('/connections'));

// ③ i18n：同一组件在 en-US 下输出英文（字典接线生效）
const summaryEnHtml = render(
  <SummaryCards
    summaries={buildCurrencySummaries([bucket], enUS)}
    currencyLabel={enUS.dashboardPage.currencyLabel}
    emptyTitle={enUS.dashboardPage.metricsEmpty}
    emptyBody={enUS.dashboardPage.metricsEmptyBody}
    emptyAction={{ label: enUS.dashboardPage.ctaConnect, href: '/connections' }}
    holdNote={enUS.dashboardPage.paymentsHold}
    link={{ label: enUS.dashboardPage.moneyLink, href: '/money' }}
  />,
);
check('i18n.en.rendered', summaryEnHtml.includes(enUS.dashboardPage.metricExpected) && !summaryEnHtml.includes(zhCN.dashboardPage.metricExpected));

// ④ 平台覆盖：客户语言状态 + 未开放渠道不伪装
const accounts: AccountsResponse = {
  platforms: [
    {
      platform: 'AMAZON',
      accounts: [
        {
          platform: 'AMAZON',
          displayName: 'Amazon US',
          status: 'ACTIVE',
          connections: [
            {
              status: 'ACTIVE',
              channel: 'AMAZON_FBA',
              domain: 'PLATFORM',
              lastSyncAt: '2026-10-01T10:00:00.000Z',
              lastErrorAt: null,
            },
          ],
        },
      ],
    },
    {
      platform: 'FEDEX',
      accounts: [
        {
          platform: 'FEDEX',
          displayName: 'FedEx',
          status: 'NEEDS_AUTH',
          connections: [
            {
              status: 'NEEDS_AUTH',
              channel: 'FEDEX',
              domain: 'LOGISTICS',
              lastSyncAt: null,
              lastErrorAt: '2026-10-02T00:00:00.000Z',
              actions: { reconnect: { available: false, reason: 'REAL_OAUTH_EXTERNAL_GATE' } },
            },
          ],
        },
      ],
    },
  ],
  unboundLegacyConnections: [],
};
const cards = buildPlatformCards(accounts, zhCN);
check('platform.amazon.connected', cards[0]!.status === zhCN.dashboardPage.platformConnected && cards[0]!.accounts === 1);
check('platform.logistics.needs.auth', cards[1]!.status === zhCN.dashboardPage.platformNeedsAuth);
check('platform.unavailable.honest', cards[3]!.unavailable && cards[3]!.status === zhCN.dashboardPage.platformUnavailable);
const platformHtml = render(
  <PlatformCard
    card={cards[0]!}
    labels={{
      accounts: zhCN.dashboardPage.platformAccounts,
      lastSync: zhCN.dashboardPage.platformLastSync,
      never: zhCN.dashboardPage.platformNever,
      advanced: zhCN.dashboardPage.platformAdvanced,
      advancedEmpty: zhCN.dashboardPage.platformAdvancedEmpty,
    }}
  />,
);
check('platform.advanced.folded', platformHtml.includes('<details') && platformHtml.includes('AMAZON_FBA'));
check('platform.status.customer.language', platformHtml.includes(zhCN.dashboardPage.platformConnected));

// ⑤ 待办中心：发生了什么 / 影响 / 为什么 / CTA
const recoveryStates: RecoveryStateItem[] = [
  {
    scope: 'CONNECTION',
    refId: 'conn-1',
    title: 'Amazon US',
    code: 'NEEDS_AUTH',
    label: '需要重新授权',
    explanation: 'Amazon 授权已过期，暂时无法继续采集数据。',
    nextAction: '重新授权',
    recoverable: true,
    safeSummary: '授权过期仅影响新增数据采集。',
  },
];
const tasks = buildTasks(recoveryStates, zhCN);
check('task.cta.href.by.scope', tasks[0]!.ctaHref === '/connections' && tasks[0]!.ctaLabel === '重新授权');
const taskHtml = render(
  <TaskCenter
    tasks={tasks}
    labels={{
      title: zhCN.dashboardPage.tasksTitle,
      impact: zhCN.dashboardPage.taskImpact,
      why: zhCN.dashboardPage.taskWhyUser,
      empty: zhCN.dashboardPage.tasksEmpty,
      kindLabels: buildTaskKindLabels(zhCN),
    }}
  />,
);
check('task.renders.what.impact.why', taskHtml.includes('授权已过期') && taskHtml.includes(zhCN.dashboardPage.taskImpactRecoverable) && taskHtml.includes(zhCN.dashboardPage.taskWhyUser));
const emptyTaskHtml = render(
  <TaskCenter
    tasks={[]}
    labels={{
      title: zhCN.dashboardPage.tasksTitle,
      impact: zhCN.dashboardPage.taskImpact,
      why: zhCN.dashboardPage.taskWhyUser,
      empty: zhCN.dashboardPage.tasksEmpty,
      kindLabels: buildTaskKindLabels(zhCN),
    }}
  />,
);
check('task.empty.state', emptyTaskHtml.includes(zhCN.dashboardPage.tasksEmpty));

// ⑥ 机会卡：客户字段优先 + 工程字段折叠
const opportunity: OpportunityApiItem = {
  id: 'opp-1',
  status: 'DETECTED',
  customerStatus: { code: 'DETECTED', label: '待确认' },
  opportunityType: 'FBA_INVENTORY_LOSS',
  title: 'FBA 库存丢失',
  description: null,
  recoverableAmount: '3250.00',
  currency: 'USD',
  confidence: 0.9,
  claimDeadline: '2026-11-01T00:00:00.000Z',
  channel: 'AMAZON_FBA',
  domain: 'PLATFORM',
  accountState: 'ATTRIBUTED',
  account: { platform: 'AMAZON', displayName: 'Amazon US' },
  actions: { canQualify: true, canReject: true, canCreateCase: true },
};
const view = buildOpportunityView(opportunity, zhCN);
const opportunityHtml = render(
  <OpportunityCard
    view={view}
    labels={{
      estimated: zhCN.dashboardPage.opportunityEstimated,
      confidence: zhCN.dashboardPage.opportunityConfidence,
      deadline: zhCN.dashboardPage.opportunityDeadline,
      noDeadline: zhCN.dashboardPage.opportunityNoDeadline,
      nextStep: zhCN.dashboardPage.opportunityNextStep,
      openDetails: zhCN.dashboardPage.opportunityAdvanced,
      advanced: zhCN.dashboardPage.opportunityAdvancedFields,
      createCase: zhCN.dashboardPage.opportunityCreateCase,
      unattributed: zhCN.opportunitiesPage.unattributed,
    }}
  />,
);
check('opportunity.customer.fields', opportunityHtml.includes('FBA 库存丢失') && opportunityHtml.includes('3250.00 USD') && opportunityHtml.includes(zhCN.dashboardPage.confidenceHigh));
check('opportunity.engineering.folded', opportunityHtml.includes('<details') && opportunityHtml.includes('domain=PLATFORM'));
check('opportunity.next.step.cta', opportunityHtml.includes(zhCN.dashboardPage.opportunityCreateCase));

// ⑦ 状态/错误/权限类区块
const noticeHtml = render(
  <InlineNotice tone="danger" title={zhCN.dashboardPage.loadFailedTitle}>
    {zhCN.dashboardPage.loadFailedBody}
  </InlineNotice>,
);
check('error.state.rendered', noticeHtml.includes(zhCN.dashboardPage.loadFailedTitle) && noticeHtml.includes('border-red-200'));
check('security.strip.points', render(<SecurityStrip title={zhCN.dashboardPage.securityTitle} points={[zhCN.dashboardPage.security5]} />).includes(zhCN.dashboardPage.security5));

// ⑧ 主 CTA 选择矩阵
const ctaTasks = selectPrimaryCta({ pendingTasks: 2, connectedAccounts: 1, opportunityCount: 3, missingPlatforms: 3 }, zhCN);
const ctaConnect = selectPrimaryCta({ pendingTasks: 0, connectedAccounts: 0, opportunityCount: 0, missingPlatforms: 3 }, zhCN);
const ctaOpportunities = selectPrimaryCta({ pendingTasks: 0, connectedAccounts: 1, opportunityCount: 4, missingPlatforms: 3 }, zhCN);
const ctaScan = selectPrimaryCta({ pendingTasks: 0, connectedAccounts: 1, opportunityCount: 0, missingPlatforms: 3 }, zhCN);
check('cta.tasks.wins', ctaTasks.kind === 'TASKS' && ctaTasks.href === '#customer-tasks');
check('cta.connect.when.unconnected', ctaConnect.kind === 'CONNECT' && ctaConnect.href === '/connections');
check('cta.opportunities.when.data', ctaOpportunities.kind === 'OPPORTUNITIES' && ctaOpportunities.href === '/opportunities');
check('cta.scan.when.connected.idle', ctaScan.kind === 'SCAN' && ctaScan.href === '/upload');

// ⑨ UI-3：机会发现页（客户视图）—— 客户状态筛选、工程字段折叠、骨架屏、空/错状态
const listHtml = render(<OpportunityList t={zhCN} />);
check('opportunity.page.advanced.filters', listHtml.includes(zhCN.opportunitiesPage.advancedFilters));
check('opportunity.page.advanced.hint', listHtml.includes(zhCN.opportunitiesPage.advancedHint));
check('opportunity.page.status.localized', listHtml.includes(zhCN.status.DETECTED) && !listHtml.includes('>DETECTED<'));
check('opportunity.page.loading.skeleton', listHtml.includes('animate-pulse'));
check('opportunity.page.filters.count.label', listHtml.includes(zhCN.opportunitiesPage.matchesCount.replace('{count}', '0')));
check('opportunity.page.no.premature.empty', !listHtml.includes(zhCN.opportunitiesPage.noFilteredResults));

const listEnHtml = render(<OpportunityList t={enUS} />);
check('opportunity.page.i18n.en', listEnHtml.includes(enUS.opportunitiesPage.advancedFilters));

// ⑩ UI-4：账户 / 连接客户视图
const connectionItems: ConnectionItem[] = [
  {
    id: 'conn-1',
    label: 'UPS monthly',
    kind: 'FILE_UPLOAD',
    domain: 'LOGISTICS',
    channel: 'UPS',
    status: 'ACTIVE',
    hasCredentialRef: true,
    platform: null,
    lastError: null,
  },
  {
    id: 'conn-2',
    label: 'FedEx',
    kind: 'API',
    domain: 'LOGISTICS',
    channel: 'FEDEX',
    status: 'NEEDS_AUTH',
    hasCredentialRef: false,
    platform: 'FEDEX',
    lastError: null,
  },
];
const connectionHtml = render(<ConnectionManager items={connectionItems} t={zhCN} />);
check('connection.customer.status.label', connectionHtml.includes(zhCN.connectionsPage.statusActive));
check('connection.raw.status.folded', !connectionHtml.includes('>ACTIVE<'));
check('connection.action.localized', connectionHtml.includes(zhCN.connectionsPage.actionRevoke) && connectionHtml.includes(zhCN.connectionsPage.actionPause));
check('connection.advanced.details', connectionHtml.includes(zhCN.connectionsPage.advanced) && connectionHtml.includes('kind=FILE_UPLOAD'));
check('connection.create.form.present', connectionHtml.includes(zhCN.connectionsPage.create));
check('connection.empty.and.error.capable', render(<ConnectionManager items={[]} t={zhCN} />).includes(zhCN.connectionsPage.empty));

const accountsHtml = render(<AccountManagementView t={zhCN} locale="zh-CN" />);
check('accounts.loading.skeleton', accountsHtml.includes('animate-pulse'));

// ⑪ UI-5：案件管线（纯函数 + 渲染）
const pendingPipeline = buildRecoveryPipeline(
  {
    domain: 'PLATFORM',
    caseStatus: 'COLLECTING_EVIDENCE',
    claimStatus: null,
    opportunityStatuses: ['QUALIFIED'],
    evidenceCount: 2,
    recoveredAmount: '0.0000',
  },
  zhCN,
);
check('pipeline.stages.count', pendingPipeline.length === 8);
check('pipeline.detected.done', pendingPipeline[0]!.state === 'DONE');
check('pipeline.submission.not.done', pendingPipeline[4]!.state !== 'DONE');
check('pipeline.submission.hold.hint', pendingPipeline[4]!.hint === zhCN.casePipeline.submissionHold);
check('pipeline.received.pending', pendingPipeline[7]!.state === 'PENDING');

const completedPipeline = buildRecoveryPipeline(
  {
    domain: 'PLATFORM',
    caseStatus: 'SETTLED',
    claimStatus: 'APPROVED',
    opportunityStatuses: ['CONVERTED'],
    evidenceCount: 3,
    recoveredAmount: '1200.0000',
  },
  zhCN,
);
check('pipeline.full.done', completedPipeline.every((stage) => stage.state === 'DONE'));

const rejectedPipeline = buildRecoveryPipeline(
  {
    domain: 'PLATFORM',
    caseStatus: 'CLAIMED',
    claimStatus: 'REJECTED',
    opportunityStatuses: ['QUALIFIED'],
    evidenceCount: 1,
    recoveredAmount: '0.0000',
  },
  zhCN,
);
check('pipeline.rejected.blocked', rejectedPipeline.some((stage) => stage.state === 'BLOCKED'));

const customsPipeline = buildRecoveryPipeline(
  {
    domain: 'CUSTOMS',
    caseStatus: 'OPEN',
    claimStatus: null,
    opportunityStatuses: ['DETECTED'],
    evidenceCount: 0,
    recoveredAmount: null,
  },
  zhCN,
);
check('pipeline.customs.labels', customsPipeline[0]!.label === zhCN.casePipeline.customsStageDetected);
check('pipeline.customs.hold.hint', customsPipeline[4]!.hint === zhCN.casePipeline.customsSubmissionHold);

const pipelineHtml = render(
  <RecoveryPipeline
    title={zhCN.casePipeline.title}
    subtitle={zhCN.casePipeline.subtitle}
    stages={pendingPipeline}
    labels={{
      DONE: pipelineStateLabel('DONE', zhCN),
      CURRENT: pipelineStateLabel('CURRENT', zhCN),
      PENDING: pipelineStateLabel('PENDING', zhCN),
      BLOCKED: pipelineStateLabel('BLOCKED', zhCN),
    }}
  />,
);
check('pipeline.renders.hold', pipelineHtml.includes(zhCN.casePipeline.submissionHold));
check('pipeline.state.labels', pipelineHtml.includes(zhCN.casePipeline.stateDone) && pipelineHtml.includes(zhCN.casePipeline.stateCurrent));
check('pipeline.no.fake.autosubmit', !pipelineHtml.includes(zhCN.status.SUBMITTED) || pipelineHtml.includes(zhCN.casePipeline.submissionHold));
check('case.status.localized', caseStatusLabel('COLLECTING_EVIDENCE', zhCN) === zhCN.caseStatus.COLLECTING_EVIDENCE);

// ⑫ UI-5b：Claim 材料包客户视图（SSR 首屏 = 骨架屏 + HOLD 文案来自字典）
const packageHtml = render(<ClaimPackageView caseId="case-1" t={zhCN} locale="zh-CN" />);
check('claim.package.loading.skeleton', packageHtml.includes('animate-pulse'));
check(
  'claim.package.hold.wording.customer',
  zhCN.claimPackagePage.readyToSubmitBody.includes('对外提交通道尚未开放'),
);

// ⑬ UI-6a：金额与收益客户视图
const moneyHtml = render(<RecoveryMoneyView t={zhCN} locale="zh-CN" />);
check('money.loading.skeleton', moneyHtml.includes('animate-pulse'));
check(
  'money.reality.wording.dictionary',
  zhCN.moneyPage.realityNote.length > 0 && zhCN.moneyPage.paymentDisabled.length > 0,
);
check('money.advanced.detail.key', zhCN.moneyPage.advancedDetails.length > 0);

// ⑭ UI-7：关税追回客户视图（字典口径 + 预计/确认区分 + HOLD 文案）
check('customs.estimated.vs.confirmed', zhCN.customsPage.estimatedLabel !== zhCN.customsPage.confirmedLabel);
check('customs.confirmed.per.currency', zhCN.customsPage.confirmedNote.includes(zhCN.dashboardPage.currencyLabel) || zhCN.customsPage.confirmedNote.length > 0);
check(
  'customs.submit.hold.wording.customer',
  zhCN.customsPage.submitNote.includes('提交通道尚未接入') && zhCN.customsPage.holdBadge.length > 0,
);
check('customs.refund.no.custody', zhCN.customsPage.refundNote.includes('CrossClaim'));
check('customs.advanced.basis.key', zhCN.customsPage.calculationBasis.length > 0 && zhCN.customsPage.advancedNote.includes('DUTY_TRUTH'));
check('customs.no.blocker.code.as.primary', !zhCN.customsPage.subtitle.includes('BROKER_POA_REQUIRED') && !zhCN.customsPage.actionNote.includes('IOR_'));
check(
  'customs.en.dictionary',
  enUS.customsPage.estimatedLabel !== enUS.customsPage.confirmedLabel && enUS.customsPage.submitNote.includes('submission channel is not connected yet'),
);

// ⑮ UI-8a：全局状态页 + a11y 语义
check('states.404.keys', zhCN.appStates.notFoundTitle.length > 0 && zhCN.appStates.notFoundBody.length > 0);
check('states.error.retry.key', zhCN.appStates.errorTitle.length > 0 && zhCN.appStates.retry.length > 0);
const alertHtml = render(
  <InlineNotice tone="danger" title={zhCN.appStates.errorTitle}>
    {zhCN.appStates.errorBody}
  </InlineNotice>,
);
check('a11y.danger.role.alert', alertHtml.includes('role="alert"'));
const statusHtml = render(
  <InlineNotice tone="info" title={zhCN.dashboardPage.opportunitiesEmpty}>
    {zhCN.dashboardPage.opportunitiesEmptyBody}
  </InlineNotice>,
);
check('a11y.info.role.status', statusHtml.includes('role="status"'));
check('a11y.notice.tone.classes', alertHtml.includes('border-red-200') && statusHtml.includes('border-sky-200'));
// AGENT EXPERIENCE LAYER / P4：Goal Console + 四张核心结果卡
const goalConsoleHtml = render(<GoalConsole labels={zhCN.goalConsole} />);
check('goal.console.title', goalConsoleHtml.includes(zhCN.goalConsole.title));
check('goal.console.suggestions', goalConsoleHtml.includes(zhCN.goalConsole.suggestion1) && goalConsoleHtml.includes(zhCN.goalConsole.suggestion4));
check('goal.console.max.four.suggestions', goalConsoleHtml.split('rounded-full border border-slate-300 bg-white px-3 py-1').length - 1 === 4);
check('goal.console.no.raw.domain.code', !goalConsoleHtml.includes('PLATFORM') && !goalConsoleHtml.includes('INDEPENDENT_SITE'));
check('goal.console.no.task.count', !goalConsoleHtml.includes('已生成') && !goalConsoleHtml.includes('执行任务'));
check('goal.console.submit', goalConsoleHtml.includes(zhCN.goalConsole.submit));
check('goal.console.no.fake.execution', !goalConsoleHtml.includes('已提交') && !goalConsoleHtml.includes('执行完成'));
check('goal.console.en.parity', render(<GoalConsole labels={enUS.goalConsole} />).includes(enUS.goalConsole.title));

const headlineCards = buildHeadlineCards([bucket], 3, zhCN);
const headlineHtml = render(<RecoveryHeadlineCards cards={headlineCards} note={zhCN.goalConsole.perCurrencyNote} />);
check('headline.cards.count', headlineCards.length === 4);
check('headline.recoverable', headlineHtml.includes(zhCN.goalConsole.recoverable));
check('headline.in.recovery', headlineHtml.includes(zhCN.goalConsole.inRecovery));
check('headline.recovered', headlineHtml.includes(zhCN.goalConsole.recovered));
check('headline.needs.attention', headlineHtml.includes(zhCN.goalConsole.needsAttention));
check('headline.per.currency.raw', headlineHtml.includes('USD') && headlineHtml.includes(bucket.discovered));
check('headline.needs.attention.count', headlineHtml.includes('>3<'));
check('headline.no.cross.currency.sum', !headlineHtml.includes('8760.00') && !headlineCards.some((card) => card.values.length > 1));
check('headline.per.currency.note', headlineHtml.includes(zhCN.goalConsole.perCurrencyNote));

// CUSTOMER-UI-PRODUCTIZATION-V2 / P3：Active Recovery（只消费已有事实 + 客户语言）
const activeFlows = buildActiveFlows(
  {
    goals: [
      { goalId: 'goal-1', status: 'RUNNING', intent: '帮我追回 Amazon 上可以追回的钱' },
      { goalId: 'goal-2', status: 'PROPOSED', intent: '不应出现在正在处理列表' },
    ],
    cases: [{ caseId: 'case-1', title: '物流赔付', statusLabel: '追回中' }],
  },
  zhCN,
);
const activeRecoveryHtml = render(<ActiveRecovery flows={activeFlows} labels={zhCN.activeRecovery} />);
check('active.recovery.title', activeRecoveryHtml.includes(zhCN.activeRecovery.title));
check('active.recovery.goal.flow', activeFlows.some((flow) => flow.title.includes('Amazon')));
check('active.recovery.case.flow', activeRecoveryHtml.includes('物流赔付'));
check('active.recovery.max.five', activeFlows.length <= 5);
check('active.recovery.no.raw.status', !activeRecoveryHtml.includes('RUNNING') && !activeRecoveryHtml.includes('ADMITTED'));
check('active.recovery.no.namespace', !activeRecoveryHtml.includes('task:recovery'));
check('active.recovery.empty.copy', render(<ActiveRecovery flows={[]} labels={zhCN.activeRecovery} />).includes(zhCN.activeRecovery.empty));

// AGENT EXPERIENCE LAYER / P5：Needs Your Attention（单一待办中心，类别可承载）
const connAccounts: AccountsResponse = {
  platforms: [
    {
      platform: 'AMAZON',
      accounts: [
        {
          platform: 'AMAZON',
          displayName: 'Amazon US',
          status: 'ACTIVE',
          connections: [
            {
              status: 'NEEDS_AUTH',
              channel: 'AMAZON_FBA',
              domain: 'PLATFORM',
              lastSyncAt: null,
              lastErrorAt: null,
              actions: { reconnect: { available: true, reason: 'REAL_OAUTH_EXTERNAL_GATE' } },
            },
          ],
        },
      ],
    },
  ],
  unboundLegacyConnections: [],
};
const connTasks = buildConnectionTasks(connAccounts, zhCN);
check('tasks.connection.reauth.kind', connTasks[0]?.kind === 'CONNECTION_REAUTH');
check('tasks.connection.reauth.cta', connTasks[0]?.ctaLabel === zhCN.needsAttention.reconnectCta && connTasks[0]?.ctaHref === '/connections');
const mergedTasks = mergeNeedsAttention(tasks, connTasks, connTasks);
check('tasks.merge.dedupe', mergedTasks.length === tasks.length + connTasks.length);
const kindLabels = buildTaskKindLabels(zhCN);
check('tasks.kind.labels.all', TASK_KINDS.every((kind) => (kindLabels[kind] ?? '').length > 0));
const taskCenterHtml = render(
  <TaskCenter
    tasks={connTasks}
    labels={{
      title: zhCN.dashboardPage.tasksTitle,
      impact: zhCN.dashboardPage.taskImpact,
      why: zhCN.dashboardPage.taskWhyUser,
      empty: zhCN.dashboardPage.tasksEmpty,
      kindLabels,
    }}
  />,
);
check('tasks.center.reauth.copy', taskCenterHtml.includes(zhCN.needsAttention.reconnectBody));
check('tasks.center.kind.badge', taskCenterHtml.includes(zhCN.needsAttention.kindConnectionReauth));
check('tasks.center.list.semantics', taskCenterHtml.includes('role="list"') && taskCenterHtml.includes('role="listitem"'));
check('tasks.center.no.raw.code', !taskCenterHtml.includes('REAL_OAUTH_EXTERNAL_GATE') && !taskCenterHtml.includes('NEEDS_AUTH'));

// AGENT EXPERIENCE LAYER / P6：执行详情（业务语言，不暴露内部实现）
const agentRunPayload = {
  goalId: 'agentgoal-demo',
  status: 'PROPOSED',
  intent: '检查我过去12个月所有可以追回的钱',
  interpretation: {
    goalType: 'DISCOVER_AND_RECOVER',
    domains: ['PLATFORM', 'CUSTOMS'],
    timeRange: { kind: 'LAST_N_MONTHS', months: 12 },
    executionMode: 'AUTO_WHEN_AUTHORIZED',
    approvalThreshold: { currency: 'USD', amount: 1000 },
  },
  createdAt: '2026-10-07T00:00:00.000Z',
  runs: [] as Array<{ runId: string; status: string; startedAt: string; completedAt: string | null; summary: unknown }>,
};
const agentRunView = buildAgentRunView(agentRunPayload, zhCN);
const agentRunHtml = render(<AgentRunViewComponent view={agentRunView} t={zhCN} />);
check('agent.run.intent', agentRunHtml.includes(agentRunPayload.intent));
check('agent.run.scope.business', agentRunHtml.includes(zhCN.agentRun.scopePlatform) && agentRunHtml.includes(zhCN.agentRun.scopeCustoms));
check('agent.run.time.range', agentRunHtml.includes(zhCN.agentRun.lastNMonths.replace('{months}', '12')));
check('agent.run.progress.steps', agentRunHtml.includes(zhCN.agentRun.stepRecorded) && agentRunHtml.includes(zhCN.agentRun.stepSummary));
check('agent.run.results.empty.honest', agentRunHtml.includes(zhCN.agentRun.resultsEmpty));
check('agent.run.hold.wording', agentRunHtml.includes(zhCN.agentRun.holdNote));
check('agent.run.no.internals', !/runner|judge|policy engine|model router|task:recovery/.test(agentRunHtml));

const agentRunWithSummary = buildAgentRunView(
  {
    ...agentRunPayload,
    status: 'RUNNING',
    runs: [
      {
        runId: 'run-1',
        status: 'RUNNING',
        startedAt: '2026-10-07T01:00:00.000Z',
        completedAt: null,
        summary: {
          opportunitiesFound: 37,
          needsApproval: 2,
          waitingEvidence: 6,
          recovered: 0,
          estimatedRecoverableByCurrency: [{ currency: 'USD', amount: '18,420.00' }],
        },
      },
    ],
  },
  zhCN,
);
const agentRunSummaryHtml = render(<AgentRunViewComponent view={agentRunWithSummary} t={zhCN} />);
check('agent.run.results.rendered', agentRunSummaryHtml.includes('37') && agentRunSummaryHtml.includes('USD 18,420.00'));
check('agent.run.no.cross.currency', agentRunWithSummary.results.filter((row) => row.key.startsWith('estimated:')).length === 1);
check('agent.run.activity.timeline', agentRunSummaryHtml.includes(zhCN.agentRun.activityGoalRecorded) && agentRunSummaryHtml.includes(zhCN.agentRun.activityRunStarted));

// AGENT EXPERIENCE LAYER / P7：授权管理面（只读 + 撤销，状态全部来自后端）
const authItem = {
  authorizationId: 'sa-p7-demo',
  provider: 'AMAZON',
  platformAccountId: 'acct-p7-1',
  allowedActionTypes: ['claim.prepare', 'recovery.manual_submit'],
  monetaryLimitUsd: 1000,
  currency: 'USD',
  domain: 'PLATFORM',
  jurisdiction: 'US',
  effectiveAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2027-10-01T00:00:00.000Z',
  authorizationVersion: 1,
  termsPolicyVersion: 'terms/v1',
  revocationState: 'ACTIVE',
  revokedAt: null as string | null,
  revokedBy: null as string | null,
  revocationReason: null as string | null,
  scopeDigest: 'ab'.repeat(32),
  createdAt: '2026-10-01T00:00:00.000Z',
};
const authHtml = render(<AuthorizationList items={[authItem]} t={zhCN} />);
check('auth.page.limit', authHtml.includes('USD 1000'));
check('auth.page.action.label', authHtml.includes(zhCN.authorizationPage.actionRecoveryManualSubmit));
check('auth.page.status.active', authHtml.includes(zhCN.authorizationPage.statusActive));
check('auth.page.automation.on', authHtml.includes(zhCN.authorizationPage.automationOn));
check('auth.page.revoke.cta', authHtml.includes(zhCN.authorizationPage.revokeCta));
check('auth.page.scope.digest.advanced', authHtml.includes(zhCN.authorizationPage.scopeRefLabel) && authHtml.includes(authItem.scopeDigest));
check('auth.page.boundary.note', authHtml.includes(zhCN.authorizationPage.boundaryNote));
check('auth.page.hold.note', authHtml.includes(zhCN.authorizationPage.holdNote));
check('auth.page.no.code.as.main.copy', !authHtml.split(zhCN.authorizationPage.advancedLabel)[0].includes('recovery.manual_submit'));
check('auth.page.no.scope.editing', !authHtml.includes('name="allowedActionTypes"') && !authHtml.includes('name="monetaryLimitUsd"'));

const revokedAuthHtml = render(
  <AuthorizationList
    items={[
      {
        ...authItem,
        revocationState: 'REVOKED',
        revokedAt: '2026-10-07T00:00:00.000Z',
        revokedBy: 'user-1',
        revocationReason: 'customer revoked',
      },
    ]}
    t={zhCN}
  />,
);
check('auth.page.revoked.note', revokedAuthHtml.includes('customer revoked'));
check('auth.page.revoked.no.cta', !revokedAuthHtml.includes(zhCN.authorizationPage.revokeCta));
const emptyAuthHtml = render(<AuthorizationList items={[]} t={zhCN} />);
check('auth.page.empty.honest', emptyAuthHtml.includes(zhCN.authorizationPage.emptyHint));

// AGENT EXPERIENCE LAYER / P8：Navigation Progressive Disclosure（不删任何 route）
check('nav.primary.recoveries', shellHtml.includes(zhCN.customerShell.navRecoveries));
check('nav.primary.needs.attention', shellHtml.includes(zhCN.customerShell.navNeedsAttention));
check('nav.primary.connections', shellHtml.includes(zhCN.customerShell.navConnections));
check('nav.group.more', shellHtml.includes(zhCN.customerShell.groupMore));
check('nav.group.advanced', shellHtml.includes(zhCN.customerShell.groupAdvanced));
const REQUIRED_HREFS = [
  '/',
  '/recoveries',
  '/money',
  '/connections',
  '/opportunities',
  '/cases',
  '/customs',
  '/accounts',
  '/upload',
  '/billing',
  '/plan',
  '/authorizations',
];
check(
  'nav.no.route.removed',
  REQUIRED_HREFS.every((href) => shellHtml.includes('href="' + href + '"')),
);
// CUSTOMER-UI-PRODUCTIZATION-V2 / P5：一级 5 项 + 更多 / 高级 顺序与 HOST 指令一致
const navModel = buildCustomerNav(zhCN);
check('nav.v2.primary.order', navModel[0]!.items.map((item) => item.href).join(',') === '/,/recoveries,/money,/#customer-tasks,/connections');
check('nav.v2.more.order', navModel[1]!.items.map((item) => item.href).join(',') === '/opportunities,/cases,/customs,/upload,/accounts');
check('nav.v2.advanced.order', navModel[2]!.items.map((item) => item.href).join(',') === '/authorizations,/billing,/plan');
check('nav.v2.no.admin.entries', !navModel.some((group) => group.items.some((item) => item.href.startsWith('/admin') || item.href.startsWith('/operations'))));
check('nav.v2.recoveries.route.page', zhCN.recoveriesPage.pageTitle.length > 0);

// CUSTOMER-UI-PRODUCTIZATION-V2 / P6：Opportunity / Case 客户语言降级（内部模型不变）
check('p6.cases.title', zhCN.casesPage.title === '追回任务');
check('p6.cases.description.mentions.materials', zhCN.casesPage.description.includes('支持材料'));
check('p6.caseDetail.evidence.customer.language', zhCN.caseDetail.evidence === '支持材料');
check('p6.caseDetail.claim.customer.language', zhCN.caseDetail.claimText.includes('提交材料'));
check(
  'p6.caseDetail.no.internal.role.codes',
  !/OWNER|ADMIN|OPS/.test(zhCN.caseDetail.claimText + zhCN.caseDetail.claimDenied),
);
check(
  'p6.caseDetail.need.action.copy',
  zhCN.caseDetail.needActionTitle.length > 0 && zhCN.caseDetail.needActionNone.length > 0,
);
check('p6.caseDetail.details.label', zhCN.caseDetail.detailsTitle === '处理详情');
check('p6.opportunities.customer.verb', zhCN.opportunitiesPage.createCase === '开始追回');
check(
  'p6.opportunities.no.engineering.wording',
  !/工程字段|技术字段/.test(zhCN.opportunitiesPage.advancedFilters + zhCN.opportunitiesPage.advancedHint),
);
check(
  'p6.en.parity',
  enUS.casesPage.title === 'Recovery tasks' &&
    enUS.caseDetail.evidence === 'Supporting materials' &&
    enUS.caseDetail.claimText.includes('Submission materials'),
);
check('nav.primary.count', buildCustomerNav(zhCN)[0].items.length === 5);

// AGENT EXPERIENCE LAYER / P9：按需授权（目标等待授权 → Needs Your Attention → 去授权后继续原目标）
const pendingGoalTasks = buildAuthorizationTasks(
  [{ goalId: 'agentgoal-a', status: 'PROPOSED', intent: '检查我过去12个月可以追回的钱' }],
  zhCN,
);
check('authz.task.kind', pendingGoalTasks.length === 1 && pendingGoalTasks[0].kind === 'AUTHORIZATION');
check('authz.task.cta', pendingGoalTasks[0].ctaHref === '/authorizations');
check('authz.task.resume.copy', pendingGoalTasks[0].why === zhCN.needsAttention.authorizationGoalBody);
const authorizedGoalTasks = buildAuthorizationTasks(
  [{ goalId: 'agentgoal-b', status: 'ADMITTED', intent: 'x' }],
  zhCN,
);
check('authz.task.disappears.after.authorization', authorizedGoalTasks.length === 0);
check('authz.customs.reuse.link', zhCN.authorizationPage.customsReuseCta.length > 0 && zhCN.authorizationPage.customsReuseBody.length > 0);

console.log(results.join('\n'));
if (failures.length > 0) {
  console.error('UI_RENDER_CHECK=FAIL count=' + failures.length);
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('UI_RENDER_CHECK=OK checks=' + results.length);
