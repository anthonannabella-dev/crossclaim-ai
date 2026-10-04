import { cookies } from 'next/headers';
import Link from 'next/link';

import { getServerMessages } from '../../../i18n/server';
import InlineNotice from '../../components/ui/inline-notice';
import SectionCard from '../../components/ui/section-card';
import StatusBadge, { type BadgeTone } from '../../components/ui/status-badge';
import type { OpportunityApiItem } from '../../lib/dashboard-view';

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

async function apiGet<T>(path: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    cache: 'no-store',
  });
  if (!response.ok) return { ok: false, status: response.status, body: null };
  return { ok: true, status: response.status, body: (await response.json()) as T };
}

interface AuthorizationCenterItem {
  key: string;
  state: string;
  action: string | null;
  blockerCodes: readonly string[];
}

interface AuthorizationCenter {
  route: string;
  remedy: string;
  jurisdiction: string | null;
  items: readonly AuthorizationCenterItem[];
  nextAction: string | null;
  stages: {
    READY_TO_PREPARE: boolean;
    READY_TO_FILE: boolean;
    READY_TO_RECEIVE_REFUND: boolean;
  };
  advancedBlockerCodes: readonly string[];
}

/**
 * CA-5 —— 关税追回授权中心（客户视角）。
 * 只组合既有只读端点（/opportunities?domain=CUSTOMS + /customs-opportunities/:id/authorization-center）；
 * 六项清单由服务端投影，客户默认只看到「已确认 / 需要处理 / 本路线不需要 / 准备中 / 可以提交 / 等待授权」，
 * 工程 blocker code 与阶段判定放在「高级详情」；真实提交保持 HOLD（尚未向海关提交）。
 */
export default async function CustomsAuthorizationPage({
  searchParams,
}: {
  searchParams?: Promise<{ opportunityId?: string }>;
}) {
  const t = await getServerMessages();
  const params = await searchParams;
  const opportunities = await apiGet<{ items: OpportunityApiItem[] }>('/opportunities?domain=CUSTOMS&limit=20');
  const items = opportunities.body?.items ?? [];
  const selectedId = params?.opportunityId ?? items[0]?.id ?? null;
  const centerResponse = selectedId
    ? await apiGet<{ authorizationCenter: AuthorizationCenter }>(
        '/customs-opportunities/' + encodeURIComponent(selectedId) + '/authorization-center',
      )
    : null;
  const center = centerResponse?.ok ? centerResponse.body?.authorizationCenter ?? null : null;

  const itemLabels: Record<string, string> = {
    ENTERPRISE_IDENTITY: t.customsAuthorization.itemEnterpriseIdentity,
    RECOVERY_RIGHT: t.customsAuthorization.itemRecoveryRight,
    SIGNER_AUTHORITY: t.customsAuthorization.itemSignerAuthority,
    BROKER_AUTHORIZATION: t.customsAuthorization.itemBrokerAuthorization,
    REFUND_ACCOUNT: t.customsAuthorization.itemRefundAccount,
    SUBMISSION_READINESS: t.customsAuthorization.itemSubmissionReadiness,
  };
  const stateLabels: Record<string, string> = {
    CONFIRMED: t.customsAuthorization.stateConfirmed,
    NEEDS_ACTION: t.customsAuthorization.stateNeedsAction,
    NOT_REQUIRED: t.customsAuthorization.stateNotRequired,
    IN_PREPARATION: t.customsAuthorization.stateInPreparation,
    READY_TO_SUBMIT: t.customsAuthorization.stateReadyToSubmit,
    WAITING_AUTHORIZATION: t.customsAuthorization.stateWaitingAuthorization,
  };
  const stateTones: Record<string, BadgeTone> = {
    CONFIRMED: 'ok',
    NEEDS_ACTION: 'warn',
    NOT_REQUIRED: 'neutral',
    IN_PREPARATION: 'pending',
    READY_TO_SUBMIT: 'ok',
    WAITING_AUTHORIZATION: 'warn',
  };
  const actionLabels: Record<string, string> = {
    CONFIRM_ENTERPRISE_IDENTITY: t.customsAuthorization.actionConfirmEnterpriseIdentity,
    SUPPLY_DOCUMENTS: t.customsAuthorization.actionSupplyDocuments,
    CONFIRM_SIGNING_AUTHORITY: t.customsAuthorization.actionConfirmSigningAuthority,
    COMPLETE_BROKER_AUTHORIZATION: t.customsAuthorization.actionCompleteBrokerAuthorization,
    CONFIRM_REFUND_ACCOUNT: t.customsAuthorization.actionConfirmRefundAccount,
    START_RECOVERY: t.customsAuthorization.actionStartRecovery,
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">{t.customsAuthorization.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.customsAuthorization.subtitle}</p>
      </header>

      <InlineNotice tone="warn" title={t.customsAuthorization.boundaryTitle}>
        {t.customsAuthorization.boundaryNote}
      </InlineNotice>

      {opportunities.status === 403 ? (
        <InlineNotice tone="danger" title={t.common.permissionDenied}>
          {t.customsAuthorization.loadFailedBody}
        </InlineNotice>
      ) : !opportunities.ok ? (
        <InlineNotice tone="danger" title={t.customsAuthorization.loadFailedTitle}>
          {t.customsAuthorization.loadFailedBody}
        </InlineNotice>
      ) : items.length === 0 ? (
        <InlineNotice tone="info" title={t.customsAuthorization.emptyTitle}>
          {t.customsAuthorization.emptyBody}
        </InlineNotice>
      ) : (
        <>
          <SectionCard title={t.customsAuthorization.selectLabel}>
            <ul className="flex flex-wrap gap-2">
              {items.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={'/customs/authorization?opportunityId=' + encodeURIComponent(entry.id)}
                    className={
                      entry.id === selectedId
                        ? 'inline-block rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white'
                        : 'inline-block rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:border-slate-300'
                    }
                  >
                    {entry.title}
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>

          {center === null ? (
            <InlineNotice tone="danger" title={t.customsAuthorization.loadFailedTitle}>
              {t.customsAuthorization.loadFailedBody}
            </InlineNotice>
          ) : (
            <>
              <SectionCard
                title={t.customsAuthorization.nextStepLabel}
                subtitle={center.nextAction === null ? t.customsAuthorization.noActionNeeded : undefined}
                actions={
                  center.nextAction === null ? null : (
                    <Link
                      href="/opportunities"
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      {actionLabels[center.nextAction] ?? t.customsAuthorization.openOpportunities}
                    </Link>
                  )
                }
              >
                <ol className="space-y-2">
                  {center.items.map((entry) => (
                    <li
                      key={entry.key}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <span className="text-sm text-slate-800">{itemLabels[entry.key] ?? entry.key}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        {entry.action === null ? null : (
                          <span className="text-xs text-slate-500">{actionLabels[entry.action] ?? entry.action}</span>
                        )}
                        <StatusBadge tone={stateTones[entry.state] ?? 'neutral'}>
                          {stateLabels[entry.state] ?? entry.state}
                        </StatusBadge>
                      </span>
                    </li>
                  ))}
                </ol>
              </SectionCard>

              <SectionCard title={t.customsAuthorization.stageTitle}>
                <ul className="space-y-1 text-sm text-slate-700">
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>{t.customsAuthorization.stagePrepare}</span>
                    <span className="text-xs text-slate-500">
                      {center.stages.READY_TO_PREPARE
                        ? t.customsAuthorization.stageReady
                        : t.customsAuthorization.stageNotReady}
                    </span>
                  </li>
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>{t.customsAuthorization.stageFile}</span>
                    <span className="text-xs text-slate-500">
                      {center.stages.READY_TO_FILE
                        ? t.customsAuthorization.stageReady
                        : t.customsAuthorization.stageNotReady}
                    </span>
                  </li>
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>{t.customsAuthorization.stageRefund}</span>
                    <span className="text-xs text-slate-500">
                      {center.stages.READY_TO_RECEIVE_REFUND
                        ? t.customsAuthorization.stageReady
                        : t.customsAuthorization.stageNotReady}
                    </span>
                  </li>
                </ul>
              </SectionCard>

              <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm sm:p-6">
                <summary className="cursor-pointer text-base font-semibold text-slate-900">
                  {t.customsAuthorization.advancedTitle}
                </summary>
                <p className="mt-2 text-xs text-slate-500">{t.customsAuthorization.advancedNote}</p>
                <p className="mt-3 text-xs font-medium text-slate-600">
                  {t.customsAuthorization.advancedCodesLabel}
                </p>
                <p className="mt-1 break-words text-xs text-slate-500">
                  {center.advancedBlockerCodes.length > 0
                    ? center.advancedBlockerCodes.join(', ')
                    : t.customsAuthorization.noAdvancedCodes}
                </p>
              </details>

              <div className="flex flex-wrap items-center gap-2">
                <Link href="/customs" className="text-sm text-slate-500 underline hover:text-slate-800">
                  {t.customsPage.title}
                </Link>
                <Link href="/opportunities" className="text-sm text-slate-500 underline hover:text-slate-800">
                  {t.customsAuthorization.openOpportunities}
                </Link>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
