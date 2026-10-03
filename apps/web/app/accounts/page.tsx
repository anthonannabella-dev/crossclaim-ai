import AccountManagementView from './account-management-view';

/**
 * TRACK A / PC-06 —— 账户管理（/accounts）。
 * PlatformAccount = business identity；SourceConnection = transport/auth lifecycle（两者不混）。
 * 只读展示；连接与显式重绑入口指向既有安全 capability；真实 provider OAuth 仍为 EXTERNAL INTEGRATION GATE。
 */
export default function AccountsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">账户管理 / Accounts</h1>
        <p className="mt-2 text-sm text-slate-600">
          按平台分组展示你的账户与连接状态。业务身份（账户）与连接（授权/传输）是两层，分别管理。
        </p>
      </div>
      <AccountManagementView />
    </div>
  );
}
