import { apiGet, consoleLang, consoleText, renderCell, statusLabel, tableRows } from '../../lib/console';

interface HealthBody {
  status?: string;
  checkedAt?: string;
  checks?: unknown;
}

export default async function SystemHealthPage() {
  const t = consoleText(await consoleLang());
  const result = await apiGet<HealthBody>('/admin/system-health');
  if (result.status !== 'ok' || !result.data) {
    return <p className="rounded-lg border bg-white p-6 text-sm">{statusLabel(t, result.status)}</p>;
  }
  const checks = tableRows(result.data.checks);
  return (
    <section className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">{t.systemHealth}</h1>
      <p className="mt-2 text-sm text-slate-600">
        {result.data.status === 'ok' ? t.ok : t.failed} · {renderCell(result.data.checkedAt)}
      </p>
      <table className="mt-4 w-full text-sm">
        <tbody>
          {checks.map((row, index) => (
            <tr key={index} className="border-t">
              {Object.entries(row).map(([key, value]) => (
                <td key={key} className="py-1 pr-3">
                  {key}: {renderCell(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
