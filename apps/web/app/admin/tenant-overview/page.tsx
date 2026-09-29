import { apiGet, consoleLang, consoleText, renderCell } from '../../lib/console';

export default async function TenantOverviewPage() {
  const t = consoleText(await consoleLang());
  const result = await apiGet<Record<string, unknown>>('/admin/tenant-overview');
  if (result.status !== 'ok' || !result.data) {
    return <p className="rounded-lg border bg-white p-6 text-sm">{t[result.status]}</p>;
  }
  const entries = Object.entries(result.data).filter(([, value]) => typeof value !== 'object');
  return (
    <section className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">{t.tenantOverview}</h1>
      <p className="mt-2 text-sm text-slate-600">{t.consoleNote}</p>
      <ul className="mt-4 space-y-1 text-sm">
        {entries.map(([key, value]) => (
          <li key={key}>
            {key}: {renderCell(value)}
          </li>
        ))}
      </ul>
    </section>
  );
}
