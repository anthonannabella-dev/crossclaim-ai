import { cookies } from 'next/headers';

/**
 * BG-019（CHANGE E · MSG-20261003-139）— Platform **Golden Path Critical-State Read Surface**。
 * ---------------------------------------------------------------
 * 只读：不提交 claim、不执行 platform.write、不触发扣款。组合既有只读端点：
 *   /cases/:id（Opportunity / Claim / Recovered）
 *   /cases/:id/claim-package（claim-ready 包就绪 + 是否已登记人工提交 + provider 写入状态）
 *   /recovery-money?caseId=（Recovered / Fee / Billing 真值 + 收费通道状态）
 *
 * 关键状态必须分开呈现，且必须显式显示「External submission: NOT ENABLED / NEEDS_MANUAL」——
 * 不允许让验收人员误以为系统已自动对外提交。
 */

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface CaseDetail {
  id: string;
  caseNo: string;
  title: string;
  status: string;
  currency: string;
  claimedAmount: string | null;
  recoveredAmount: string | null;
  opportunities: Array<{ id: string; status: string; title: string }>;
  claims: Array<{ id: string; round: number; status: string; target: string }>;
}

interface ClaimPackageState {
  readiness: { state: string; label: string; packageReady: boolean; claimSubmitted: boolean; providerWrite: string };
}

interface MoneyBucket {
  currency: string;
  expected?: string;
  recovered?: string;
  fee?: string;
  invoiced?: string;
}

interface RecoveryMoney {
  organization: { byCurrency: MoneyBucket[]; collection: string; payment: string };
  cases: unknown[];
  feeNote: string;
}

async function apiGet<T>(path: string): Promise<{ ok: boolean; status: number; body: T | null }> {
  const token = (await cookies()).get('cc_session')?.value ?? '';
  const res = await fetch(API_BASE + '/api' + path, {
    headers: token ? { cookie: 'cc_session=' + token } : {},
    cache: 'no-store',
  });
  if (!res.ok) return { ok: false, status: res.status, body: null };
  return { ok: true, status: res.status, body: (await res.json()) as T };
}

function StateRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-900">
        {value}
        {note ? ' · ' + note : ''}
      </span>
    </div>
  );
}

export default async function PlatformRecoveryStatePage({
  searchParams,
}: {
  searchParams?: Promise<{ caseId?: string }>;
}) {
  const params = await searchParams;
  const caseId = params?.caseId ?? '';

  const detail = caseId ? await apiGet<CaseDetail>('/cases/' + encodeURIComponent(caseId)) : null;
  const claimPackage = caseId ? await apiGet<ClaimPackageState>('/cases/' + encodeURIComponent(caseId) + '/claim-package') : null;
  const money = await apiGet<RecoveryMoney>(caseId ? '/recovery-money?caseId=' + encodeURIComponent(caseId) : '/recovery-money');

  const opportunities = detail?.ok && detail.body ? detail.body.opportunities : [];
  const claims = detail?.ok && detail.body ? detail.body.claims : [];
  const readiness = claimPackage?.ok && claimPackage.body ? claimPackage.body.readiness : null;
  const providerWrite = readiness?.providerWrite ?? 'UNKNOWN';
  const externalSubmission = providerWrite === 'NOT_ENABLED' || providerWrite === 'MANUAL_REQUIRED' ? 'NOT ENABLED / NEEDS_MANUAL' : String(providerWrite);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Platform 关键状态（只读） / Platform recovery critical states</h1>
        <p className="mt-2 text-sm text-slate-600">
          本页只读展示 Platform 域 Golden Path 的关键状态与真值；不会提交 claim、不会执行 platform.write、不会触发任何扣款。
        </p>
        <p className="mt-1 text-xs text-slate-500">用法：/platform-recovery-state?caseId=&lt;case id&gt;</p>
      </div>

      <section className="rounded border border-amber-300 bg-amber-50 p-4">
        <h2 className="text-base font-medium">External submission</h2>
        <p className="mt-1 font-mono text-sm text-amber-900">External submission: {externalSubmission}</p>
        <p className="mt-1 text-xs text-amber-800">
          平台写入通道保持 HOLD_EXTERNAL（TRANSPORT=false）。系统**不会**自动对外提交；需要人工提交时必须有显式人工步骤与审批。
        </p>
      </section>

      <section className="rounded border border-slate-200 p-4">
        <h2 className="text-base font-medium">1) Opportunity → Qualification</h2>
        {caseId === '' ? (
          <p className="mt-2 text-sm text-slate-500">未提供 caseId。</p>
        ) : !detail || !detail.ok || detail.body === null ? (
          <p className="mt-2 text-sm text-rose-600">读取失败：HTTP {detail?.status ?? 'n/a'}</p>
        ) : (
          <div className="mt-2">
            <StateRow label="case" value={detail.body.caseNo + '（' + detail.body.status + '）'} />
            {opportunities.length === 0 ? (
              <p className="text-sm text-slate-500">（无关联 opportunity）</p>
            ) : (
              opportunities.map((opportunity) => (
                <StateRow
                  key={opportunity.id}
                  label={'opportunity ' + opportunity.id}
                  value={opportunity.status}
                  note={opportunity.title}
                />
              ))
            )}
            <p className="mt-1 text-xs text-slate-500">
              说明：本读模型不返回 qualification 细分字段；若需判定细节请以 Qualification Gate 的持久化判定为准（本页不重算）。
            </p>
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 p-4">
        <h2 className="text-base font-medium">2) Claim-ready Package → Submission status（platform.write）</h2>
        {readiness === null ? (
          <p className="mt-2 text-sm text-slate-500">（无 claim-ready 包读模型）</p>
        ) : (
          <div className="mt-2">
            <StateRow label="package state" value={readiness.state} note={readiness.label} />
            <StateRow label="PACKAGE READY" value={readiness.packageReady ? 'YES' : 'NO'} />
            <StateRow label="CLAIM ACTUALLY SUBMITTED" value={readiness.claimSubmitted ? 'YES（已登记人工提交事实）' : 'NO'} />
            <StateRow label="platform.write providerWrite" value={providerWrite} />
            {claims.map((claim) => (
              <StateRow key={claim.id} label={'claim round ' + claim.round} value={claim.status} note={claim.target} />
            ))}
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 p-4">
        <h2 className="text-base font-medium">3) Settlement / Recovered / Fee / Billing（资金真值，只读）</h2>
        {!money.ok || money.body === null ? (
          <p className="mt-2 text-sm text-rose-600">读取失败：HTTP {money.status}</p>
        ) : (
          <div className="mt-2">
            <StateRow label="collection" value={money.body.organization.collection} />
            <StateRow label="payment" value={money.body.organization.payment} />
            {money.body.organization.byCurrency.length === 0 ? (
              <p className="text-sm text-slate-500">（暂无资金事实）</p>
            ) : (
              money.body.organization.byCurrency.map((bucket) => (
                <StateRow
                  key={bucket.currency}
                  label={bucket.currency}
                  value={'expected=' + String(bucket.expected ?? '—') + ' recovered=' + String(bucket.recovered ?? '—') + ' fee=' + String(bucket.fee ?? '—') + ' invoiced=' + String(bucket.invoiced ?? '—')}
                />
              ))
            )}
            <p className="mt-2 text-xs text-slate-500">{money.body.feeNote}</p>
            <p className="mt-1 text-xs text-slate-500">
              EXPECTED ≠ RECEIVED；fee calculated ≠ collected。15% 成功费只以**已验证实际追回**为计费基础。
            </p>
          </div>
        )}
      </section>

      <p className="text-xs text-slate-500">
        边界：External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY。
      </p>
    </div>
  );
}
