import { getServerMessages } from '../../i18n/server';
import UploadForm from './upload-form';

export default async function UploadPage() {
  const t = await getServerMessages();
  return <UploadForm t={t} />;
}
