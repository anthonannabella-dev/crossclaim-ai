import { getServerMessages } from '../../i18n/server';
import UploadForm from './upload-form';
import RecoveryBanner from '../components/recovery-banner';

export default async function UploadPage() {
  const t = await getServerMessages();
  return (
    <div className="space-y-4">
      {/* PC-04：客户可见的失败 / 恢复状态（导入维度） */}
      <RecoveryBanner scope="IMPORT" t={t} />
      <UploadForm t={t} />
    </div>
  );
}
