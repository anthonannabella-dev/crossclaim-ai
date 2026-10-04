import { getServerLocale, getServerMessages } from '../../i18n/server';
import AccountManagementView from './account-management-view';

/**
 * TRACK A / PC-06 —— 账户管理（/accounts）。
 * PlatformAccount = business identity；SourceConnection = transport/auth lifecycle（两者不混）。
 * 只读展示；连接与显式重绑入口指向既有安全 capability；真实 provider OAuth 仍为 EXTERNAL INTEGRATION GATE。
 */
export default async function AccountsPage() {
  const [t, locale] = await Promise.all([getServerMessages(), getServerLocale()]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t.accountsPage.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.accountsPage.description}</p>
      </div>
      <AccountManagementView t={t} locale={locale} />
    </div>
  );
}
