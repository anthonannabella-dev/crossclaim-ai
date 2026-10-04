import { getServerMessages } from '../../i18n/server';
import OpportunityList from './opportunity-list';

/**
 * TRACK A / PC-02 —— 客户可见机会列表入口（/opportunities）。
 * UI-3（MSG-20261004-01 §七）：客户默认看到「来源 / 问题 / 预计可追回 / 可信度 / 截止时间 / 状态 / 下一步」，
 * 工程字段（domain / channel / accountId / DETECTED）降级到高级筛选与高级详情。
 */
export default async function OpportunitiesPage() {
  const t = await getServerMessages();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">{t.opportunitiesPage.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{t.opportunitiesPage.description}</p>
      </header>
      <OpportunityList t={t} />
    </div>
  );
}
