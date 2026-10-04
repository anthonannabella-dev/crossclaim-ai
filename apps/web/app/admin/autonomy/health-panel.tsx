import { getServerMessages } from '../../../i18n/server';

/**
 * RSI System Health 面板（/admin/autonomy，只读展示）。
 * 数据由服务端注入；文案只取 i18n key；不读 DB、不调模型、不写任何东西。
 */
export interface RsiHealthView {
  health: 'STARTING' | 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'BLOCKED' | 'FAILED';
  openIncidents: number;
  activeTasks: number;
  failedTasks: number;
  pendingOwnerApprovals: number;
  lastScanAt: string | null;
}

export default async function RsiHealthPanel({ health }: { health: RsiHealthView }) {
  const t = await getServerMessages();
  const h = t.rsiHealth;
  const rows: [string, string][] = [
    [h.status, health.health],
    [h.openIncidents, String(health.openIncidents)],
    [h.activeTasks, String(health.activeTasks)],
    [h.failedTasks, String(health.failedTasks)],
    [h.pendingOwner, String(health.pendingOwnerApprovals)],
    [h.lastScan, health.lastScanAt ?? '—'],
  ];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{h.title}</h2>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <dt className="text-sm text-slate-600">{label}</dt>
            <dd className="text-sm font-medium text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
