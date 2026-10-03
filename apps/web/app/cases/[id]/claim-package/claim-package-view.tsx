'use client';

import { useEffect, useState } from 'react';

import type { Messages } from '../../../../i18n/dictionaries/zh-CN';

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

export default function ClaimPackageView({ caseId, t }: { caseId: string; t: Messages }) {
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

  if (loading) return <p className="text-sm text-slate-600">{t.common.loading}</p>;
  if (error) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
        {copy.loadFailed.replace('{message}', error)}
      </div>
    );
  }
  if (!view) return <p className="text-sm text-slate-600">{copy.empty}</p>;

  return (
    <div className="space-y-4">
      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">{view.case.caseNo} · {view.case.title}</div>
        <div className="mt-1 text-slate-600">
          {copy.expectedRecoverable.replace(
            '{amount}',
            view.case.recoverableAmount ? view.case.recoverableAmount + ' ' + view.case.currency : '—',
          )}
          {view.case.deadline ? copy.deadlineSuffix.replace('{date}', view.case.deadline.slice(0, 10)) : ''}
        </div>
        <div className="mt-2">
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
            {copy.statusWithCode.replace('{label}', view.readiness.label).replace('{state}', view.readiness.state)}
          </span>
        </div>
        <div className="mt-2 text-xs text-slate-600">
          {copy.accountLabel}
          {view.account.state === 'ATTRIBUTED'
            ? (view.account.displayName ?? '') + ' · ' + (view.account.platform ?? '') + ' · ' + (view.account.externalAccountId ?? '')
            : copy.unattributed}
        </div>
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">{copy.whyTitle}</div>
        <p className="mt-1 text-slate-700">{view.why.basisSummary}</p>
        <p className="mt-1 text-xs text-slate-600">
          {copy.amountBasis.replace('{value}', view.why.amountBasis ?? '—')}
        </p>
        <p className="mt-1 text-xs text-slate-600">
          {copy.evidenceCounts
            .replace('{total}', String(view.why.evidenceCount))
            .replace('{linked}', String(view.why.linkedEvidenceCount))}
        </p>
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">{copy.packageTitle}</div>
        {view.package ? (
          <div className="mt-1 text-xs text-slate-700">
            <div>
              {copy.packageMeta
                .replace('{version}', view.package.packageVersion)
                .replace('{status}', view.package.status)}
            </div>
            <div>
              {copy.packageTarget
                .replace('{platformType}', view.package.target.platformType)
                .replace('{claimType}', view.package.target.claimType)
                .replace('{domain}', view.package.target.domain)
                .replace('{channel}', view.package.target.channel)}
            </div>
            <div className="break-all">digest：{view.package.packageDigest}</div>
            <div>{copy.packageGeneratedAt.replace('{at}', view.package.generatedAt.slice(0, 19))}</div>
          </div>
        ) : (
          <p className="mt-1 text-slate-600">{copy.packageMissing}</p>
        )}
        <div className="mt-2 text-xs text-slate-600">
          <div>
            PACKAGE READY：{view.readiness.packageReady ? copy.yes : copy.no}
          </div>
          <div>
            CLAIM ACTUALLY SUBMITTED：{view.readiness.claimSubmitted ? copy.claimSubmittedYes : copy.no}
          </div>
          <div>{copy.providerWriteNote.replace('{state}', view.readiness.providerWrite)}</div>
        </div>
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">{copy.evidenceTitle}</div>
        {view.evidence.length === 0 ? (
          <p className="mt-1 text-slate-600">{copy.noEvidence}</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-1">{copy.colKind}</th>
                <th className="py-1">{copy.colTitle}</th>
                <th className="py-1">{copy.colSource}</th>
                <th className="py-1">{copy.colExportedAt}</th>
                <th className="py-1">{copy.colDownload}</th>
              </tr>
            </thead>
            <tbody>
              {view.evidence.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="py-1">{item.kind}</td>
                  <td className="py-1">{item.title}</td>
                  <td className="py-1">{item.sourceType}</td>
                  <td className="py-1">{item.capturedAt.slice(0, 19)}</td>
                  <td className="py-1">{item.downloadable ? copy.downloadable : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">{copy.missingTitle}</div>
        {view.missingItems.length === 0 ? (
          <p className="mt-1 text-slate-600">{copy.noMissing}</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
            {view.missingItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-xs text-slate-600">
          {copy.actionsLabel}
          {view.actions.canPrepare ? ' ' + copy.actionPrepare : ''}
          {view.actions.canDownloadPackage ? ' ' + copy.actionDownload : ''}
          {view.actions.canRecordManualSubmission ? ' ' + copy.actionRecordManual : ''}
          {view.actions.canAppeal ? ' ' + copy.actionAppeal : ''}
          {!view.actions.canPrepare && !view.actions.canDownloadPackage && !view.actions.canRecordManualSubmission && !view.actions.canAppeal
            ? ' ' + copy.actionNone
            : ''}
        </div>
      </div>
    </div>
  );
}
