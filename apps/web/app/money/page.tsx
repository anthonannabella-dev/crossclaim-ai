import { getServerMessages } from '../../i18n/server';
import RecoveryMoneyView from './recovery-money-view';

/**
 * TRACK A / PC-05 —— 客户可见「已追回多少钱」（/money）。
 * MONEY VISIBILITY（非 MONEY MOVEMENT）：只读展示，Payment / collection 仍为 0 / OFF。
 */
export default async function MoneyPage() {
  const t = await getServerMessages();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t.moneyPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t.moneyPage.description}
          <strong>{t.moneyPage.feeNoteStrong}</strong>
          {t.moneyPage.feeNoteRest}
        </p>
      </div>
      <RecoveryMoneyView t={t} />
    </div>
  );
}
