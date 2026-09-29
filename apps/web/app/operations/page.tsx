import Link from 'next/link';

import { apiGet, consoleLang, consoleText, renderCell, tableRows } from '../lib/console';

interface DashboardBody {
  generatedAt?: string;
  window?: string;
  claimPipeline?: { buckets?: unknown; anomalyTotal?: number } | null;
  recovery?: Record<string, unknown> | null;
  counts?: Record<string, unknown> | null;
}

export default async function OperationsConsolePage({ searchParams }: { searchParams?: Promise<{ window?: string }> }) {
  const t = consoleText(await consoleLang());
  const window = (await searchParams)?.window ?? '7d';
  const result = await apiGet<DashboardBody>(`/operations/dashboard?window=${encodeURIComponent(window)}`);

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
        <h1 className="text-xl font-semibold">{t[result.status]}</h1>
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
