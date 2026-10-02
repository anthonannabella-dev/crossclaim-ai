import OpportunityList from './opportunity-list';

/**
 * TRACK A / PC-02 —— 客户可见机会列表入口（/opportunities）。
 * 这是「系统告诉客户有哪些可追回机会、预计能追回多少钱」的客户主流程入口。
 */
export default function OpportunitiesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">可追回机会 / Recovery opportunities</h1>
        <p className="mt-2 text-sm text-slate-600">
          下列机会来自已导入并已归因到账户的事实。金额与依据只读展示，不会触发任何平台提交。
        </p>
      </div>
      <OpportunityList />
    </div>
  );
}
