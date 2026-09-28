import { cookies, headers } from 'next/headers';

import { getDictionary, LOCALE_COOKIE, resolveLocale, type Locale, type Messages } from './index';

/** 服务端解析语言（cookie → Accept-Language → 默认），供 server component 使用。 */
export async function getServerLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get('accept-language') ?? undefined,
  });
}

export async function getServerMessages(): Promise<Messages> {
  return getDictionary(await getServerLocale());
}
