import { apiGet, consoleLang, consoleText, renderCell, statusLabel } from '../../lib/console';
import { sourceLabel, valueLabel } from '../../lib/kill-switch-labels';

/**
 * S1（MSG-20260929-68）：Admin Console 只读展示。
 * - 只展示 value / source 文案 / evaluatedAt；
 * - OWNER/ADMIN 可展开查看原始 source（详情）；
 * - **不提供任何写入口**（无 enable/disable 按钮、无确认表单、无 reason 输入）。
 */

interface SwitchItem {
  scope?: string;
  value?: string;
  source?: string;
  controlState?: string;
  degraded?: boolean;
  stale?: boolean;
  evaluatedAt?: string;
}

interface KillSwitchBody {
  visibility?: string;
  switches?: SwitchItem[];
}

export default async function KillSwitchPage() {
  const lang = await consoleLang();
  const t = consoleText(lang);
  const result = await apiGet<KillSwitchBody>('/admin/kill-switch');

  if (result.status !== 'ok' || !result.data) {
    return <p className="rounded-lg border bg-white p-6 text-sm">{statusLabel(t, result.status)}</p>;
  }

  const items = Array.isArray(result.data.switches) ? result.data.switches : [];

  return (
    <section className="rounded-lg border bg-white p-6">
      <h1 className="text-xl font-semibold">{t.killSwitch}</h1>
      <p className="mt-2 text-sm text-slate-600">{t.killSwitchNote}</p>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1">{t.killSwitchScope}</th>
            <th className="py-1">{t.killSwitchState}</th>
            <th className="py-1">{t.killSwitchReason}</th>
            <th className="py-1">{t.killSwitchEvaluatedAt}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.scope ?? index} className="border-t align-top">
              <td className="py-2 pr-3 font-mono text-xs">{renderCell(item.scope)}</td>
              <td className="py-2 pr-3">
                {valueLabel(lang, item.value)}
                {item.stale ? <span className="ml-2 text-xs text-amber-700">{t.killSwitchStale}</span> : null}
                {item.degraded ? (
                  <span className="ml-2 text-xs text-amber-700">{t.killSwitchDegraded}</span>
                ) : null}
              </td>
              <td className="py-2 pr-3">{sourceLabel(lang, item.source)}</td>
              <td className="py-2 pr-3 text-xs text-slate-500">{renderCell(item.evaluatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {items.some((item) => typeof item.source === 'string') ? (
        <details className="mt-4 text-xs text-slate-600">
          <summary className="cursor-pointer">{t.killSwitchRawDetail}</summary>
          <ul className="mt-2 space-y-1">
            {items.map((item, index) => (
              <li key={`raw-${item.scope ?? index}`} className="font-mono">
                {renderCell(item.scope)}: source={renderCell(item.source)}
                {item.controlState ? ` controlState=${renderCell(item.controlState)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
