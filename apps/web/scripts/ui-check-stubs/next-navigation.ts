/** UI 渲染测试用的 next/navigation 替身（仅测试注入）。 */
export function usePathname(): string {
  return '/';
}

export function useRouter(): { refresh: () => void; push: (href: string) => void; replace: (href: string) => void } {
  return {
    refresh: () => undefined,
    push: () => undefined,
    replace: () => undefined,
  };
}
