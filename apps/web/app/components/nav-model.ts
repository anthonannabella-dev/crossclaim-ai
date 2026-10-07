import type { Messages } from '../../i18n/dictionaries/zh-CN';

/**
 * CUSTOMER APP SHELL 导航模型（MSG-20261004-01 §三）。
 * 只做「已有 route 的重组入口」：不新增 / 不删除 route，保持 URL 与 API contract 兼容。
 * ADMIN / OPS / DEBUG 路由（/admin/*、/operations、/integration-status、/platform-recovery-state）
 * 刻意不出现在客户导航里。
 */

export interface NavItem {
  href: string;
  label: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** 认证页使用「裸」外壳（无导航）。 */
export const BARE_ROUTES = ['/login', '/signup'] as const;

export function isBareRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return BARE_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));
}

/**
 * P8：Navigation Progressive Disclosure。
 * 一级只保留 Home / Recoveries / Money / Needs Attention / Connections；
 * 其余入口进 More / Advanced —— **所有既有 route 仍然可达**（不删任何入口、不破坏 URL / API contract）。
 */
export function buildCustomerNav(t: Messages): NavGroup[] {
  return [
    {
      title: t.customerShell.groupMain,
      items: [
        { href: '/', label: t.customerShell.navHome },
        { href: '/recoveries', label: t.customerShell.navRecoveries },
        { href: '/money', label: t.customerShell.navMoney },
        { href: '/#customer-tasks', label: t.customerShell.navNeedsAttention },
        { href: '/connections', label: t.customerShell.navConnections },
      ],
    },
    {
      title: t.customerShell.groupMore,
      items: [
        { href: '/opportunities', label: t.customerShell.navOpportunities },
        { href: '/cases', label: t.customerShell.navCases },
        { href: '/customs', label: t.customerShell.navCustoms },
        { href: '/accounts', label: t.customerShell.navAccounts },
        { href: '/upload', label: t.customerShell.navUpload },
      ],
    },
    {
      title: t.customerShell.groupAdvanced,
      items: [
        { href: '/billing', label: t.customerShell.navBilling },
        { href: '/plan', label: t.customerShell.navPlan },
        { href: '/authorizations', label: t.customerShell.navAuthorizations },
      ],
    },
  ];
}

/** 客户端高亮：`/` 只在根路径点亮；其余按前缀匹配（/cases/:id 命中 /cases）。 */
export function isActivePath(current: string | null | undefined, href: string): boolean {
  if (!current) return false;
  if (href === '/') return current === '/';
  return current === href || current.startsWith(href + '/');
}
