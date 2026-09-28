import { getServerMessages } from '../../i18n/server';
import LoginForm from './login-form';

export default async function LoginPage() {
  const t = await getServerMessages();
  return <LoginForm t={t} />;
}
