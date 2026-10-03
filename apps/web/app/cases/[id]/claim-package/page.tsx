import { getServerMessages } from '../../../../i18n/server';
import ClaimPackageView from './claim-package-view';
import RecoveryBanner from '../../../components/recovery-banner';

/**
 * TRACK A / PC-03 —— 客户可见 Claim Package（/cases/[id]/claim-package）。
 * 回答：能追回多少钱 / 为什么 / 证据有哪些 / 还缺什么 / 现在能不能提交 / 下一步是什么。
 */
export default async function CaseClaimPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getServerMessages();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t.claimPackagePage.pageTitle}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {t.claimPackagePage.pageDescriptionPrefix}
          <strong>{t.claimPackagePage.pageDescriptionStrong}</strong>
          {t.claimPackagePage.pageDescriptionSuffix}
        </p>
      </div>
      {/* PC-04：案件维度的失败 / 恢复状态 */}
      <RecoveryBanner scope="CASE" t={t} />
      <ClaimPackageView caseId={id} t={t} />
    </div>
  );
}
