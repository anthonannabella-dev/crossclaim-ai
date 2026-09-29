import Link from 'next/link';

import { ADMIN_MODULES, apiGet, consoleLang, consoleText } from '../lib/console';

export default async function AdminIndexPage() {
  const t = consoleText(await consoleLang());

  // REVISE-1：入口仅来自静态白名单；逐个探测（GET），403/404/500 一律不显示。
  const probes = await Promise.all(
    ADMIN_MODULES.map(async (module) => ({ module, result: await apiGet<unknown>(module.api) })),
  );

  if (probes.every((probe) => probe.result.status === 'LOGIN_REQUIRED')) {
    return (
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.loginRequired}</h1>
        <Link href="/login" className="mt-4 inline-block rounded bg-slate-900 px-4 py-2 text-white">
          {t.goToLogin}
        </Link>
      </section>
    );
  }

  const visible = probes.filter((probe) => probe.result.status === 'ok');

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-6">
        <h1 className="text-xl font-semibold">{t.adminTitle}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.consoleNote}</p>
      </section>

      <section className="rounded-lg border bg-white p-6">
        {visible.length === 0 ? (
          <p className="text-sm text-slate-600">{t.noPermission}</p>
        ) : (
          <ul className="space-y-2">
            {visible.map((probe) => (
              <li key={probe.module.id}>
                <Link href={probe.module.path} className="text-slate-900 underline">
                  {t[probe.module.id]}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
