import { cookies } from 'next/headers';

import ManualResponseForm from './manual-response-form';
import StartRecoveryForm from './start-recovery-form';

/**
 * G5-UI（MASTER GAP CLOSURE）：只读接线 —— carrier response 读模型 + customs filing status。
 * 本页**只读**：不提交 claim、不执行 filing、不触发扣款、不修改任何事实；仅展示既有事实与投影。
 * 用法：/integration-status?packageId=<carrier package id>&opportunityId=<customs opportunity id>
 */

const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

interface CarrierResponses {
  responses: {
    currentStatus: string | null;
    currentVerificationLevel: string | null;
    currentFactId: string | null;
    history: Array<{ factId: string; status: string; source: string; verificationLevel: string; observedAt: string }>;
    factCount: number;
    hasProviderVerifiedFact: boolean;
  };
}

interface CustomsFilingStatus {
  filingStatus: {
    currentStatus: string | null;
    currentSourceLevel: string | null;
    history: Array<{ factId: string; status: string; sourceLevel: string; observedAt: string }>;
    factCount: number;
    hasAuthorityVerifiedFact: boolean;
  };
}

async function apiGet<T>(path: string): Promise<{ ok: boolean; status: number; body: T | null; code: string | null }> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => c.name + '=' + c.value)
    .join('; ');
  const res = await fetch(API_BASE + path, {
    headers: cookieHeader.length > 0 ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
  if (!res.ok) {
    let code: string | null = null;
    try {
      const payload = (await res.json()) as { code?: string; error?: string };
      code = payload.code ?? payload.error ?? null;
    } catch {
      code = null;
    }
    return { ok: false, status: res.status, body: null, code };
  }
  return { ok: true, status: res.status, body: (await res.json()) as T, code: null };
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-900">{value}</span>
    </div>
  );
}

export default async function IntegrationStatusPage({
  searchParams,
}: {
  searchParams?: Promise<{ packageId?: string; opportunityId?: string }>;
}) {
  const params = await searchParams;
  const packageId = params?.packageId ?? '';
  const opportunityId = params?.opportunityId ?? '';

  const carrier = packageId
    ? await apiGet<CarrierResponses>('/carrier-claim-packages/' + encodeURIComponent(packageId) + '/responses')
    : null;
  const customs = opportunityId
    ? await apiGet<CustomsFilingStatus>('/customs-opportunities/' + encodeURIComponent(opportunityId) + '/filing-status')
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">集成状态（只读） / Integration status</h1>
        <p className="mt-2 text-sm text-slate-600">
          Carrier 响应事实与 Customs filing 状态的**只读**视图。本页不会提交 claim、不会执行 filing、不会触发任何扣款或外部写。
        </p>
        <p className="mt-1 text-xs text-slate-500">
          用法：/integration-status?packageId=&lt;carrier package id&gt;&amp;opportunityId=&lt;customs opportunity id&gt;
        </p>
      </div>

      <section className="rounded border border-slate-200 p-4">
        <h2 className="text-base font-medium">Carrier claim responses（Queue #10 读模型）</h2>
        {packageId === '' ? (
          <p className="mt-2 text-sm text-slate-500">未提供 packageId。</p>
        ) : carrier === null ? (
          <p className="mt-2 text-sm text-slate-500">未请求。</p>
        ) : !carrier.ok || carrier.body === null ? (
          <p className="mt-2 text-sm text-rose-600">
            读取失败：HTTP {carrier.status}
            {carrier.code !== null ? ' · ' + carrier.code : ''}
          </p>
        ) : (
          <div className="mt-2">
            <StatusRow label="currentStatus" value={carrier.body.responses.currentStatus ?? '（无事实）'} />
            <StatusRow
              label="currentVerificationLevel"
              value={carrier.body.responses.currentVerificationLevel ?? '（无事实）'}
            />
            <StatusRow label="factCount" value={String(carrier.body.responses.factCount)} />
            <StatusRow
              label="hasProviderVerifiedFact"
              value={carrier.body.responses.hasProviderVerifiedFact ? 'true' : 'false'}
            />
            <h3 className="mt-3 text-sm font-medium text-slate-700">status history</h3>
            {carrier.body.responses.history.length === 0 ? (
              <p className="text-sm text-slate-500">（暂无事实）</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {carrier.body.responses.history.map((h) => (
                  <li key={h.factId} className="font-mono text-xs text-slate-700">
                    {h.observedAt} · {h.status} · source={h.source} · verification={h.verificationLevel}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 p-4">
        <h2 className="text-base font-medium">Customs filing status（C19 读模型）</h2>
        {opportunityId === '' ? (
          <p className="mt-2 text-sm text-slate-500">未提供 opportunityId。</p>
        ) : customs === null ? (
          <p className="mt-2 text-sm text-slate-500">未请求。</p>
        ) : !customs.ok || customs.body === null ? (
          <p className="mt-2 text-sm text-rose-600">
            读取失败：HTTP {customs.status}
            {customs.code !== null ? ' · ' + customs.code : ''}
          </p>
        ) : (
          <div className="mt-2">
            <StatusRow label="currentStatus" value={customs.body.filingStatus.currentStatus ?? '（无事实）'} />
            <StatusRow label="currentSourceLevel" value={customs.body.filingStatus.currentSourceLevel ?? '（无事实）'} />
            <StatusRow label="factCount" value={String(customs.body.filingStatus.factCount)} />
            <StatusRow
              label="hasAuthorityVerifiedFact"
              value={customs.body.filingStatus.hasAuthorityVerifiedFact ? 'true' : 'false'}
            />
            <h3 className="mt-3 text-sm font-medium text-slate-700">status history</h3>
            {customs.body.filingStatus.history.length === 0 ? (
              <p className="text-sm text-slate-500">（暂无事实）</p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {customs.body.filingStatus.history.map((h) => (
                  <li key={h.factId} className="font-mono text-xs text-slate-700">
                    {h.observedAt} · {h.status} · source={h.sourceLevel}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <ManualResponseForm />

      <StartRecoveryForm />

      <p className="text-xs text-slate-500">
        边界：真实 carrier provider 读取与 customs filing 仍为 HOLD_EXTERNAL；上述两个表单只产生内部事实/准备状态，不触发任何对外动作或扣款。
      </p>
    </div>
  );
}
