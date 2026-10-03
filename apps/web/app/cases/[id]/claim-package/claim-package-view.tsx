'use client';

import { useEffect, useState } from 'react';

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

export default function ClaimPackageView({ caseId }: { caseId: string }) {
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
        if (!cancelled) setError('网络错误 / Network error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  if (loading) return <p className="text-sm text-slate-600">加载中… / Loading…</p>;
  if (error) return <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">加载失败：{error}</div>;
  if (!view) return <p className="text-sm text-slate-600">无数据</p>;

  return (
    <div className="space-y-4">
      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">{view.case.caseNo} · {view.case.title}</div>
        <div className="mt-1 text-slate-600">
          预计可追回：{view.case.recoverableAmount ? view.case.recoverableAmount + ' ' + view.case.currency : '—'}
          {view.case.deadline ? ' · 截止 ' + view.case.deadline.slice(0, 10) : ''}
        </div>
        <div className="mt-2">
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{view.readiness.label}（{view.readiness.state}）</span>
        </div>
        <div className="mt-2 text-xs text-slate-600">
          账户：
          {view.account.state === 'ATTRIBUTED'
            ? (view.account.displayName ?? '') + ' · ' + (view.account.platform ?? '') + ' · ' + (view.account.externalAccountId ?? '')
            : '未归因（legacy，不按连接推断）'}
        </div>
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">为什么可以追回 / Why</div>
        <p className="mt-1 text-slate-700">{view.why.basisSummary}</p>
        <p className="mt-1 text-xs text-slate-600">金额依据：{view.why.amountBasis ?? '—'}</p>
        <p className="mt-1 text-xs text-slate-600">证据数量：{view.why.evidenceCount}（案件关联证据 {view.why.linkedEvidenceCount}）</p>
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">材料包 / Package</div>
        {view.package ? (
          <div className="mt-1 text-xs text-slate-700">
            <div>版本 {view.package.packageVersion} · 状态 {view.package.status}</div>
            <div>目标：{view.package.target.platformType} / {view.package.target.claimType}（{view.package.target.domain} · {view.package.target.channel}）</div>
            <div className="break-all">digest：{view.package.packageDigest}</div>
            <div>生成时间：{view.package.generatedAt.slice(0, 19)}</div>
          </div>
        ) : (
          <p className="mt-1 text-slate-600">尚未生成材料包。</p>
        )}
        <div className="mt-2 text-xs text-slate-600">
          <div>PACKAGE READY：{view.readiness.packageReady ? '是' : '否'}</div>
          <div>CLAIM ACTUALLY SUBMITTED：{view.readiness.claimSubmitted ? '是（已登记人工提交事实）' : '否'}</div>
          <div>真实平台写入：{view.readiness.providerWrite}（TRANSPORT=false，需人工提交）</div>
        </div>
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">证据清单 / Evidence manifest</div>
        {view.evidence.length === 0 ? (
          <p className="mt-1 text-slate-600">暂无已导出证据。</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b text-left text-slate-600">
                <th className="py-1">类型</th>
                <th className="py-1">标题</th>
                <th className="py-1">来源</th>
                <th className="py-1">导出时间</th>
                <th className="py-1">下载</th>
              </tr>
            </thead>
            <tbody>
              {view.evidence.map((item) => (
                <tr key={item.id} className="border-b">
                  <td className="py-1">{item.kind}</td>
                  <td className="py-1">{item.title}</td>
                  <td className="py-1">{item.sourceType}</td>
                  <td className="py-1">{item.capturedAt.slice(0, 19)}</td>
                  <td className="py-1">{item.downloadable ? '可下载（受既有权限控制）' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded border border-slate-200 p-3 text-sm">
        <div className="font-medium">还缺什么 / Missing items</div>
        {view.missingItems.length === 0 ? (
          <p className="mt-1 text-slate-600">无缺失项。</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
            {view.missingItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 text-xs text-slate-600">
          可执行动作（由服务端 capability 决定）：
          {view.actions.canPrepare ? ' 生成材料包' : ''}
          {view.actions.canDownloadPackage ? ' 下载材料包' : ''}
          {view.actions.canRecordManualSubmission ? ' 登记人工提交' : ''}
          {view.actions.canAppeal ? ' 发起申诉' : ''}
          {!view.actions.canPrepare && !view.actions.canDownloadPackage && !view.actions.canRecordManualSubmission && !view.actions.canAppeal ? ' 无' : ''}
        </div>
      </div>
    </div>
  );
}
