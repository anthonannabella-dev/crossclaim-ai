import Link from 'next/link';

import { apiGet, consoleLang, consoleText, renderCell, statusLabel, tableRows } from '../lib/console';
import { sourceLabel, valueLabel } from '../lib/kill-switch-labels';

interface DashboardBody {
  generatedAt?: string;
  window?: string;
  claimPipeline?: { buckets?: unknown; anomalyTotal?: number } | null;
  recovery?: Record<string, unknown> | null;
  counts?: Record<string, unknown> | null;
}

export default async function OperationsConsolePage({ searchParams }: { searchParams?: Promise<{ window?: string }> }) {
  const lang = await consoleLang();
  const t = consoleText(lang);
  const window = (await searchParams)?.window ?? '7d';
  const result = await apiGet<DashboardBody>(`/operations/dashboard?window=${encodeURIComponent(window)}`);
  // S2（MSG-20260929-68）：只读标识；无权限或失败时不渲染，且**不影响页面行为**
  const killSwitch = await apiGet<{ switches?: unknown }>('/admin/kill-switch');
  const killSwitchSwitches =
    killSwitch.status === 'ok' && Array.isArray(killSwitch.data?.switches)
      ? (killSwitch.data?.switches as Array<Record<string, unknown>>).filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object',
        )
      : [];

  if (result.status === 'LOGIN_REQUIRED') {
    return (
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.loginRequired}</h1>
        <Link href="/login" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-white">
          {t.goToLogin}
        </Link>
      </section>
    );
  }
  if (result.status !== 'ok' || !result.data) {
    return (
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{statusLabel(t, result.status)}</h1>
        <Link href="/" className="mt-4 inline-block text-slate-700 underline">
          {t.backHome}
        </Link>
      </section>
    );
  }

  const body = result.data;
  const buckets = tableRows(body.claimPipeline?.buckets);
  const recoveryRows = Object.entries(body.recovery ?? {}).filter(([, value]) => typeof value !== 'object');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.consoleTitle}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.consoleNote}</p>
        <p className="mt-2 text-xs text-slate-500">
          {t.generatedAt}: {renderCell(body.generatedAt)} · {t.window}: {renderCell(body.window ?? window)}
        </p>
      </section>

      {killSwitchSwitches.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold">{t.killSwitch}</h2>
          <ul className="mt-2 space-y-1 text-xs text-amber-900">
            {killSwitchSwitches.map((item, index) => (
              <li key={String(item.scope ?? index)}>
                {renderCell(item.scope)}: {valueLabel(lang, item.value)} · {sourceLabel(lang, item.source)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-700">{t.killSwitchNote}</p>
        </section>
      )}

      {buckets.length > 0 && (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-semibold">{t.importValidation}</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                {Object.keys(buckets[0] ?? {}).map((key) => (
                  <th key={key} className="py-1">
                    {key}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((row, index) => (
                <tr key={index} className="border-t">
                  {Object.keys(buckets[0] ?? {}).map((key) => (
                    <td key={key} className="py-1">
                      {renderCell(row[key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {recoveryRows.length > 0 && (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-semibold">{t.recoveryReview}</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {recoveryRows.map(([key, value]) => (
              <li key={key}>
                {key}: {renderCell(value)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
