import { getServerMessages } from '../../i18n/server';
import PlanView from './plan-view';

/**
 * TRACK A / PC-07 —— 套餐与解锁（/plan）。
 * 只展示权益与解锁资格；付款通道未启用（Payment = 0 / collection = OFF），不做假 checkout。
 */
export default async function PlanPage() {
  const t = await getServerMessages();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t.planPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t.planPage.description}
          <strong>{t.planPage.upgradeDisabled}</strong>
          {t.planPage.noChargeNote}
        </p>
      </div>
      <PlanView t={t} />
    </div>
  );
}
