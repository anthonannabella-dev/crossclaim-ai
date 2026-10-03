import { getServerMessages } from '../../i18n/server';
import OpportunityList from './opportunity-list';

/**
 * TRACK A / PC-02 —— 客户可见机会列表入口（/opportunities）。
 * 这是「系统告诉客户有哪些可追回机会、预计能追回多少钱」的客户主流程入口。
 */
export default async function OpportunitiesPage() {
  const t = await getServerMessages();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t.opportunitiesPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.opportunitiesPage.description}</p>
      </div>
      <OpportunityList t={t} />
    </div>
  );
}
