/**
 * UI-1 / UI-2 渲染验收（esbuild + react-dom/server；由 scripts/ui-render-check.mjs 驱动）。
 * 覆盖：Shell 导航/响应式标记/ADMIN 隔离、金额按币种、平台状态客户语言、待办 CTA、
 * 机会卡工程字段折叠、空/错/权限状态文案、i18n 键接线、CTA 选择矩阵。
 */
import { renderToStaticMarkup } from 'react-dom/server';

import CustomerShell from '../app/components/customer-shell';
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
  buildTasks,
  selectPrimaryCta,
  type AccountsResponse,
  type MoneyBucket,
  type OpportunityApiItem,
  type RecoveryStateItem,
} from '../app/lib/dashboard-view';
import enUS from '../i18n/dictionaries/en-US';
import zhCN from '../i18n/dictionaries/zh-CN';

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
    labels={{ impact: zhCN.dashboardPage.taskImpact, why: zhCN.dashboardPage.taskWhyUser, empty: zhCN.dashboardPage.tasksEmpty }}
  />,
);
check('task.renders.what.impact.why', taskHtml.includes('授权已过期') && taskHtml.includes(zhCN.dashboardPage.taskImpactRecoverable) && taskHtml.includes(zhCN.dashboardPage.taskWhyUser));
const emptyTaskHtml = render(
  <TaskCenter
    tasks={[]}
    labels={{ impact: zhCN.dashboardPage.taskImpact, why: zhCN.dashboardPage.taskWhyUser, empty: zhCN.dashboardPage.tasksEmpty }}
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
check('claim.package.hold.wording.dictionary', zhCN.claimPackagePage.readyToSubmitBody.includes('External Write = HOLD'));

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
check('customs.submit.hold.wording', zhCN.customsPage.submitNote.includes('HOLD') && zhCN.customsPage.holdBadge.length > 0);
check('customs.refund.no.custody', zhCN.customsPage.refundNote.includes('CrossClaim'));
check('customs.advanced.basis.key', zhCN.customsPage.calculationBasis.length > 0 && zhCN.customsPage.advancedNote.includes('DUTY_TRUTH'));
check('customs.no.blocker.code.as.primary', !zhCN.customsPage.subtitle.includes('BROKER_POA_REQUIRED') && !zhCN.customsPage.actionNote.includes('IOR_'));
check(
  'customs.en.dictionary',
  enUS.customsPage.estimatedLabel !== enUS.customsPage.confirmedLabel && enUS.customsPage.submitNote.includes('HOLD'),
);

console.log(results.join('\n'));
if (failures.length > 0) {
  console.error('UI_RENDER_CHECK=FAIL count=' + failures.length);
  for (const failure of failures) console.error(' - ' + failure);
  process.exit(1);
}
console.log('UI_RENDER_CHECK=OK checks=' + results.length);
