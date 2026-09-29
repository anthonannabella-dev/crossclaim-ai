import Link from 'next/link';

import { apiGet, consoleLang, consoleText, renderCell, statusLabel, tableRows } from '../../lib/console';

interface ImportsBody {
  items?: unknown;
  nextCursor?: string | null;
}

const PREFERRED = ['batchId', 'bucket', 'flags', 'channel', 'rowsTotal', 'rowsOk', 'rowsFailed', 'startedAt'] as const;

export default async function ImportValidationPage({ searchParams }: { searchParams?: Promise<{ cursor?: string }> }) {
  const t = consoleText(await consoleLang());
  const cursor = (await searchParams)?.cursor;
  const [list, quality] = await Promise.all([
    apiGet<ImportsBody>(`/admin/imports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    apiGet<{ projection?: boolean; buckets?: unknown }>('/admin/imports/quality-summary'),
  ]);
  if (list.status !== 'ok' || !list.data) {
    return <p className="rounded-lg border bg-white p-6 text-sm">{statusLabel(t, list.status)}</p>;
  }
  const rows = tableRows(list.data.items);
  const columns = rows.length > 0 ? PREFERRED.filter((key) => key in (rows[0] ?? {})) : PREFERRED.slice(0, 4);
  const qualityRows = quality.status === 'ok' ? tableRows(quality.data?.buckets) : [];
  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.importValidation}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.consoleNote}</p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              {columns.map((column) => (
                <th key={column} className="py-1">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t">
                {columns.map((column) => (
                  <td key={column} className="py-1">
                    {renderCell(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="mt-2 text-sm text-slate-600">{t.empty}</p>}
        {list.data.nextCursor && (
          <Link
            href={`/admin/imports?cursor=${encodeURIComponent(list.data.nextCursor)}`}
            className="mt-4 inline-block text-slate-700 underline"
          >
            {t.nextPage}
          </Link>
        )}
      </section>

      {qualityRows.length > 0 && (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-semibold">quality-summary (projection)</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {qualityRows.map((row, index) => (
              <li key={index}>
                {renderCell(row.bucket)}: {renderCell(row.count)} / flag {renderCell(row.flagCount)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
