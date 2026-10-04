'use client';

import { useEffect, useState } from 'react';

import { formatDateTime } from '../../../../i18n/business-language';
import type { Locale } from '../../../../i18n';
import type { Messages } from '../../../../i18n/dictionaries/zh-CN';
import InlineNotice from '../../../components/ui/inline-notice';
import SectionCard from '../../../components/ui/section-card';
import StatusBadge from '../../../components/ui/status-badge';

interface ClaimPackage {
  case: {
    id: string;
    caseNo: string;
    title: string;
    status: string;
    currency: string;
    claimedAmount: string | null;
    recoverableAmount: string | null;
    deadline: string | null;
    openedAt: string;
  };
  account: {
    state: 'ATTRIBUTED' | 'LEGACY_UNATTRIBUTED';
    id: string | null;
    platform: string | null;
    externalAccountId: string | null;
    displayName: string | null;
  };
  package: {
    id: string;
    packageVersion: string;
    status: string;
    packageDigest: string;
    generatedAt: string;
    target: { platformType: string; claimType: string; channel: string; domain: string };
  } | null;
  why: {
    opportunities: Array<{ id: string; title: string; opportunityType: string; status: string; recoverableAmount: string | null }>;
    basisSummary: string;
    amountBasis: string | null;
    evidenceCount: number;
    linkedEvidenceCount: number;
  };
  evidence: Array<{ id: string; kind: string; title: string; sourceType: string; capturedAt: string; downloadable: boolean; sha256: string }>;
  missingItems: string[];
  readiness: { state: string; label: string; packageReady: boolean; claimSubmitted: boolean; providerWrite: string };
  actions: { canPrepare: boolean; canDownloadPackage: boolean; canRecordManualSubmission: boolean; canAppeal: boolean };
}

/**
 * UI-5b —— Claim 材料包（客户视图）。
 * 顶部明确「材料已准备好 / 需要人工提交 / 准备中」，绝不暗示自动提交；
 * 证据与缺失项用卡片/清单呈现，digest / sha256 / providerWrite 等工程字段进「高级详情」。
 */
export default function ClaimPackageView({
  caseId,
  t,
  locale,
}: {
  caseId: string;
  t: Messages;
  locale: Locale;
}) {
  const copy = t.claimPackagePage;
  const [view, setView] = useState<ClaimPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/cases/' + caseId + '/claim-package', { cache: 'no-store' });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
          if (!cancelled) setError(body.message ?? body.error ?? 'API error');
          return;
        }
        const body = (await response.json()) as ClaimPackage;
        if (!cancelled) setView(body);
      } catch {
        if (!cancelled) setError(t.common.networkError);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, t]);

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1].map((index) => (
          <div key={index} className="h-32 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        ))}
        <span className="sr-only">{t.common.loading}</span>
      </div>
    );
  }
  if (error) {
    return (
      <InlineNotice tone="danger" title={t.dashboardPage.loadFailedTitle}>
        {copy.loadFailed.replace('{message}', error)}
      </InlineNotice>
    );
  }
  if (!view) return <p className="text-sm text-slate-600">{copy.empty}</p>;

  const actions = [
    view.actions.canPrepare ? copy.actionPrepare : null,
    view.actions.canDownloadPackage ? copy.actionDownload : null,
    view.actions.canRecordManualSubmission ? copy.actionRecordManual : null,
    view.actions.canAppeal ? copy.actionAppeal : null,
  ].filter((item): item is string => item !== null);

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <p className="text-xs text-slate-500">
          {view.case.caseNo}
          {' · '}
          {view.case.title}
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">{copy.expectedRecoverable.split('{amount}')[0]}</dt>
              <dd className="mt-0.5 text-base font-semibold text-slate-900">
                {view.case.recoverableAmount ? view.case.recoverableAmount + ' ' + view.case.currency : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{copy.colExportedAt}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {view.package ? formatDateTime(view.package.generatedAt, { locale }) : copy.packageMissing}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">{copy.accountLabel}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {view.account.state === 'ATTRIBUTED'
                  ? (view.account.displayName ?? '') + (view.account.platform ? ' · ' + view.account.platform : '')
                  : copy.unattributed}
              </dd>
            </div>
          </dl>
          <StatusBadge tone={view.readiness.packageReady ? 'pending' : 'neutral'}>
            {copy.statusWithCode.replace('{label}', view.readiness.label).replace('{state}', view.readiness.state)}
          </StatusBadge>
        </div>
        {view.case.deadline ? (
          <p className="mt-3 text-xs text-slate-500">
            {copy.deadlineSuffix.replace('{date}', view.case.deadline.slice(0, 10))}
          </p>
        ) : null}
      </section>

      {view.readiness.claimSubmitted ? (
        <InlineNotice tone="info" title={copy.submittedTitle}>
          {copy.claimSubmittedYes}
        </InlineNotice>
      ) : view.readiness.packageReady ? (
        <InlineNotice tone="warn" title={copy.readyToSubmitTitle}>
          {copy.readyToSubmitBody}
        </InlineNotice>
      ) : (
        <InlineNotice tone="warn" title={copy.preparingTitle}>
          {copy.preparingBody}
        </InlineNotice>
      )}

      <SectionCard title={copy.whyTitle}>
        <p className="text-sm text-slate-700">{view.why.basisSummary}</p>
        <p className="mt-2 text-xs text-slate-600">{copy.amountBasis.replace('{value}', view.why.amountBasis ?? '—')}</p>
        <p className="mt-1 text-xs text-slate-600">
          {copy.evidenceCounts
            .replace('{total}', String(view.why.evidenceCount))
            .replace('{linked}', String(view.why.linkedEvidenceCount))}
        </p>
      </SectionCard>

      <SectionCard title={copy.packageTitle}>
        {view.package ? (
          <>
            <p className="text-sm text-slate-800">
              {copy.packageMeta
                .replace('{version}', view.package.packageVersion)
                .replace('{status}', view.package.status)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {copy.packageTarget
                .replace('{platformType}', view.package.target.platformType)
                .replace('{claimType}', view.package.target.claimType)
                .replace('{domain}', view.package.target.domain)
                .replace('{channel}', view.package.target.channel)}
            </p>
            <div className="mt-3 text-xs text-slate-600">
              <p>
                {copy.packageReadyLabel}
                {': '}
                {view.readiness.packageReady ? copy.yes : copy.no}
              </p>
              <p className="mt-0.5">
                {copy.claimSubmittedLabel}
                {': '}
                {view.readiness.claimSubmitted ? copy.claimSubmittedYes : copy.no}
              </p>
            </div>
            <details className="mt-3 text-[11px] text-slate-500">
              <summary className="cursor-pointer">{copy.advancedDetails}</summary>
              <ul className="mt-1 space-y-0.5 font-mono">
                <li>packageDigest={view.package.packageDigest}</li>
                <li>packageId={view.package.id}</li>
                <li>providerWrite={view.readiness.providerWrite}</li>
                <li>readinessState={view.readiness.state}</li>
              </ul>
            </details>
          </>
        ) : (
          <p className="text-sm text-slate-600">{copy.packageMissing}</p>
        )}
      </SectionCard>

      <SectionCard title={copy.evidenceTitle}>
        {view.evidence.length === 0 ? (
          <p className="text-sm text-slate-600">{copy.noEvidence}</p>
        ) : (
          <ul className="space-y-3">
            {view.evidence.map((item) => (
              <li key={item.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {item.kind}
                      {' · '}
                      {item.sourceType}
                    </p>
                  </div>
                  <StatusBadge tone={item.downloadable ? 'ok' : 'neutral'}>
                    {item.downloadable ? copy.downloadable : copy.colDownloadUnavailable}
                  </StatusBadge>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {copy.colExportedAt}
                  {': '}
                  {formatDateTime(item.capturedAt, { locale })}
                </p>
                <details className="mt-1 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">{copy.advancedDetails}</summary>
                  <p className="mt-1 break-all font-mono">sha256={item.sha256}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title={copy.missingTitle}>
        {view.missingItems.length === 0 ? (
          <p className="text-sm text-slate-600">{copy.noMissing}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
            {view.missingItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-600">
          <p className="font-medium text-slate-700">{copy.actionsServerDecided}</p>
          {actions.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">{copy.noActions}</p>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
