import ClaimPackageView from './claim-package-view';

/**
 * TRACK A / PC-03 —— 客户可见 Claim Package（/cases/[id]/claim-package）。
 * 回答：能追回多少钱 / 为什么 / 证据有哪些 / 还缺什么 / 现在能不能提交 / 下一步是什么。
 */
export default async function CaseClaimPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Claim Package</h1>
        <p className="mt-2 text-sm text-slate-600">
          这是系统为该案件准备的材料包与依据。<strong>材料包就绪不等于已提交</strong>：真实平台提交仍为人工执行。
        </p>
      </div>
      <ClaimPackageView caseId={id} />
    </div>
  );
}
