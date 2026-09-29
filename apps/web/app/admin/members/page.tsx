import { apiGet, consoleLang, consoleText, renderCell, statusLabel, tableRows } from '../../lib/console';

interface MemberItem {
  userId?: string;
  displayName?: string;
  emailMasked?: string | null;
  role?: string;
  isActive?: boolean;
  status?: string;
  locked?: boolean;
  lastLoginAt?: string | null;
}

const COLUMNS = ['userId', 'displayName', 'emailMasked', 'role', 'isActive', 'status', 'locked', 'lastLoginAt'] as const;

export default async function MembersPage() {
  const t = consoleText(await consoleLang());
  const [list, matrix] = await Promise.all([
    apiGet<{ items?: MemberItem[]; nextCursor?: string | null }>('/admin/members'),
    apiGet<{ readonly?: boolean; roles?: string[]; permissions?: string[] }>('/admin/permission-matrix'),
  ]);
  if (list.status !== 'ok' || !list.data) {
    return <p className="rounded-lg border bg-white p-6 text-sm">{statusLabel(t, list.status)}</p>;
  }
  const rows = tableRows(list.data.items);
  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.userMembership}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.consoleNote}</p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              {COLUMNS.map((column) => (
                <th key={column} className="py-1">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t">
                {COLUMNS.map((column) => (
                  <td key={column} className="py-1">
                    {renderCell(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="mt-2 text-sm text-slate-600">{t.empty}</p>}
      </section>

      {matrix.status === 'ok' && matrix.data && (
        <section className="rounded-lg border bg-white p-6">
          <h2 className="text-lg font-semibold">
            {t.userMembership} · readonly={renderCell(matrix.data.readonly)}
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            roles: {(matrix.data.roles ?? []).join(', ')} · permissions: {(matrix.data.permissions ?? []).length}
          </p>
        </section>
      )}
    </div>
  );
}
