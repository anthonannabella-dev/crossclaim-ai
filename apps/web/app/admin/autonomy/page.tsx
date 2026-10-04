import { getServerMessages } from '../../../i18n/server';
import { loadRsiAdminSnapshot } from '../../../lib/rsi-admin-snapshot';
import CostPanel from './cost-panel';
import HealthPanel from './health-panel';

/**
 * /admin/autonomy —— RSI 管理页（只读）。
 *
 * 数据来自 RSI 生成的内部快照 artifact；**不读 DB、不调模型、不外写**。
 * 快照缺失/非法 → fail-closed：只显示「加载失败」，不编造任何状态或金额。
 */
export const dynamic = 'force-dynamic';

export default async function AutonomyAdminPage() {
  const t = await getServerMessages();
  const loaded = loadRsiAdminSnapshot();

  if (!loaded.ok) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          {t.common.loadFailed}
        </div>
      </main>
    );
  }

  const { health, cost } = loaded.snapshot;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-10">
      <HealthPanel health={health} />
      <CostPanel today={cost.today} month={cost.month} costSafeMode={cost.costSafeMode} />
    </main>
  );
}
