import RecoveryMoneyView from './recovery-money-view';

/**
 * TRACK A / PC-05 —— 客户可见「已追回多少钱」（/money）。
 * MONEY VISIBILITY（非 MONEY MOVEMENT）：只读展示，Payment / collection 仍为 0 / OFF。
 */
export default function MoneyPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">追回金额 / Recovered money</h1>
        <p className="mt-2 text-sm text-slate-600">
          下列金额来自已确认的到账事实与账单事实；按币种分组展示，不做跨币种换算。
          <strong>「已计算费用」不等于「已收费」</strong>：当前收费通道未开启。
        </p>
      </div>
      <RecoveryMoneyView />
    </div>
  );
}
