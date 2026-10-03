import PlanView from './plan-view';

/**
 * TRACK A / PC-07 —— 套餐与解锁（/plan）。
 * 只展示权益与解锁资格；付款通道未启用（Payment = 0 / collection = OFF），不做假 checkout。
 */
export default function PlanPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">套餐与解锁 / Plan &amp; entitlements</h1>
        <p className="mt-2 text-sm text-slate-600">
          这里说明当前套餐包含哪些能力、哪些被限制及原因、剩余额度，以及升级后可获得什么。
          <strong>升级与付款尚未启用</strong>，本页不会发起任何扣款。
        </p>
      </div>
      <PlanView />
    </div>
  );
}
