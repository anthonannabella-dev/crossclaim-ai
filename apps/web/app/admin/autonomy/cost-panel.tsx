import { getServerMessages } from '../../../i18n/server';

/**
 * RSI 成本面板（RSI-COST-04）—— /admin/autonomy 的 Cost 区块。
 *
 * · 纯展示：数据由调用方（服务端）通过 `snapshot` 注入；本组件不读 DB、不调模型、不写任何东西；
 * · 文案只来自 i18n key（5 语言 parity），数字如实展示，不做夸张格式化；
 * · COST_SAFE_MODE 显示为显式状态标签（规则引擎 / 健康监控仍在运行）。
 */
export interface RsiCostAggregateView {
  events: number;
  incidents: number;
  ruleResolved: number;
  lowCostCalls: number;
  strongCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  budgetRemaining: number;
}

export interface RsiCostPanelProps {
  today: RsiCostAggregateView;
  month: RsiCostAggregateView;
  costSafeMode: boolean;
}

const Row = ({ label, today, month }: { label: string; today: string; month: string }) => (
  <tr className="border-t border-slate-100">
    <th scope="row" className="py-2 pr-4 text-left text-sm font-medium text-slate-700">
      {label}
    </th>
    <td className="py-2 pr-4 text-sm text-slate-900">{today}</td>
    <td className="py-2 text-sm text-slate-900">{month}</td>
  </tr>
);

export default async function RsiCostPanel({ today, month, costSafeMode }: RsiCostPanelProps) {
  const t = await getServerMessages();
  const c = t.rsi.cost;
  const money = (value: number) => value.toFixed(4);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{c.title}</h2>
        {costSafeMode && (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
            {c.costSafeMode}
          </span>
        )}
      </header>

      <table className="mt-4 w-full border-collapse">
        <thead>
          <tr>
            <th className="py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-slate-500"> </th>
            <th className="py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-slate-500">{c.today}</th>
            <th className="py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">{c.month}</th>
          </tr>
        </thead>
        <tbody>
          <Row label={c.events} today={String(today.events)} month={String(month.events)} />
          <Row label={c.incidents} today={String(today.incidents)} month={String(month.incidents)} />
          <Row label={c.ruleResolved} today={String(today.ruleResolved)} month={String(month.ruleResolved)} />
          <Row label={c.lowCostCalls} today={String(today.lowCostCalls)} month={String(month.lowCostCalls)} />
          <Row label={c.strongCalls} today={String(today.strongCalls)} month={String(month.strongCalls)} />
          <Row
            label={c.tokens}
            today={`${today.inputTokens} / ${today.outputTokens}`}
            month={`${month.inputTokens} / ${month.outputTokens}`}
          />
          <Row label={c.cost} today={money(today.cost)} month={money(month.cost)} />
          <Row
            label={c.budgetRemaining}
            today={money(today.budgetRemaining)}
            month={money(month.budgetRemaining)}
          />
        </tbody>
      </table>
    </section>
  );
}
