import Link from 'next/link';

import { apiGet, consoleLang, consoleText, renderCell, tableRows } from '../../lib/console';

interface AuditBody {
  items?: unknown;
  nextCursor?: string | null;
  window?: string;
}

const PREFERRED = ['action', 'entityType', 'entityId', 'createdAt', 'actorType', 'actorUserId', 'severity'] as const;

export default async function AuditExplorerPage({ searchParams }: { searchParams?: Promise<{ cursor?: string }> }) {
  const t = consoleText(await consoleLang());
  const cursor = (await searchParams)?.cursor;
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const result = await apiGet<AuditBody>(`/admin/audit${query}`);
  if (result.status !== 'ok' || !result.data) {
    return <p className="rounded-lg border bg-white p-6 text-sm">{t[result.status]}</p>;
  }
  const rows = tableRows(result.data.items);
  const columns = rows.length > 0 ? PREFERRED.filter((key) => key in (rows[0] ?? {})) : PREFERRED.slice(0, 4);
  return (
    <section className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">{t.auditExplorer}</h1>
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
      {result.data.nextCursor ? (
        <Link
          href={`/admin/audit?cursor=${encodeURIComponent(result.data.nextCursor)}`}
          className="mt-4 inline-block text-slate-700 underline"
        >
          {t.nextPage}
        </Link>
      ) : (
        <p className="mt-4 text-xs text-slate-500">{t.noMore}</p>
      )}
    </section>
  );
}
