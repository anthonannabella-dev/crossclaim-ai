import { cookies, headers } from 'next/headers';

import { getDictionary, LOCALE_COOKIE, resolveLocale, type Locale, type Messages } from './index';

/** 取服务端语言偏好：cookie → Accept-Language → 默认；仅供 server component 使用。 */
export async function getServerLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language') ?? undefined,
  });
}

/**
 * 取界面文案。
 * SEO-4（MSG-20261005-03 OPTION_A）：带 `[locale]` 的 URL 路由必须**按 URL 决定语言**，
 * 因此允许显式传入 locale；不传时保持原行为（cookie → Accept-Language → 默认）。
 */
export async function getServerMessages(locale?: Locale): Promise<Messages> {
  return getDictionary(locale ?? (await getServerLocale()));
}
