/**
 * Operations Console v1 — 共享读取层（只读）
 * ------------------------------------------------------------------
 * 纪律（架构方 MSG-20260929-50）：
 *   - API 是唯一安全边界；本层只做 GET，不存在任何写请求。
 *   - 错误统一映射为 LOGIN_REQUIRED / NO_PERMISSION / NOT_FOUND / SYSTEM_ERROR，
 *     绝不把 SQL / 堆栈 / Prisma / 连接串透出到页面（REVISE-2）。
 *   - /admin 模块入口来自**静态白名单**，不扫描后端（REVISE-1）。
 */
import { cookies } from 'next/headers';

export const API_BASE = process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000';

export type ConsoleStatus = 'ok' | 'LOGIN_REQUIRED' | 'NO_PERMISSION' | 'NOT_FOUND' | 'SYSTEM_ERROR';

export interface ConsoleResult<T> {
  status: ConsoleStatus;
  data: T | null;
}

function mapStatus(httpStatus: number): ConsoleStatus {
  if (httpStatus === 401) return 'LOGIN_REQUIRED';
  if (httpStatus === 403) return 'NO_PERMISSION';
  if (httpStatus === 404) return 'NOT_FOUND';
  return 'SYSTEM_ERROR';
}

/** 只读 GET；非 2xx 一律折叠为受控状态码，不透出后端细节。 */
export async function apiGet<T>(path: string): Promise<ConsoleResult<T>> {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
    if (!response.ok) return { status: mapStatus(response.status), data: null };
    return { status: 'ok', data: (await response.json()) as T };
  } catch {
    return { status: 'SYSTEM_ERROR', data: null };
  }
}

/** 静态白名单：六个 Admin 模块（不含任何未来端点）。 */
export const ADMIN_MODULES = [
  { id: 'tenantOverview', path: '/admin/tenant-overview', api: '/admin/tenant-overview' },
  { id: 'auditExplorer', path: '/admin/audit', api: '/admin/audit' },
  { id: 'importValidation', path: '/admin/imports', api: '/admin/imports' },
  { id: 'recoveryReview', path: '/admin/recovery-review', api: '/admin/recovery-review' },
  { id: 'userMembership', path: '/admin/members', api: '/admin/members' },
  // MSG-20260929-68 S1：Kill Switch 只读展示（READ_ONLY；无任何写入口）
  { id: 'killSwitch', path: '/admin/kill-switch', api: '/admin/kill-switch' },
  { id: 'systemHealth', path: '/admin/system-health', api: '/admin/system-health' },
] as const;

export type AdminModuleId = (typeof ADMIN_MODULES)[number]['id'];

const TEXT: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    consoleTitle: '运营控制台（只读）',
    adminTitle: 'Admin Console（只读）',
    consoleNote: '只读视图：不提供写入、导出、下载、审批或提交入口。',
    loginRequired: '需要登录',
    goToLogin: '前往登录',
    noPermission: '当前角色无权查看该内容',
    notFound: '未找到',
    systemError: '系统错误，请稍后重试',
    backHome: '返回工作台',
    loading: '读取中',
    empty: '暂无数据',
    nextPage: '下一页',
    noMore: '没有更多数据',
    generatedAt: '生成时间',
    window: '时间窗口',
    tenantOverview: '租户概览',
    auditExplorer: '审计浏览器',
    importValidation: '导入/校验',
    recoveryReview: '追回复核',
    userMembership: '成员与权限',
    systemHealth: '系统健康',
    killSwitch: 'Kill Switch（只读）',
    killSwitchNote: '只读视图：状态由系统安全策略与控制面请求决定；本页面不提供任何开关操作。',
    killSwitchScope: '范围',
    killSwitchState: '状态',
    killSwitchReason: '原因',
    killSwitchEvaluatedAt: '评估时间',
    killSwitchRawDetail: '展开查看原始来源（排障用）',
    killSwitchStale: '（陈旧值）',
    killSwitchDegraded: '（降级）',
    ok: '正常',
    failed: '异常',
  },
  en: {
    consoleTitle: 'Operations Console (read-only)',
    adminTitle: 'Admin Console (read-only)',
    consoleNote: 'Read-only view: no write, export, download, approval or submission entry points.',
    loginRequired: 'Login required',
    goToLogin: 'Go to login',
    noPermission: 'Your role may not view this content',
    notFound: 'Not found',
    systemError: 'System error, please retry later',
    backHome: 'Back to workspace',
    loading: 'Loading',
    empty: 'No data',
    nextPage: 'Next page',
    noMore: 'No more data',
    generatedAt: 'Generated at',
    window: 'Window',
    tenantOverview: 'Tenant overview',
    auditExplorer: 'Audit explorer',
    importValidation: 'Import / validation',
    recoveryReview: 'Recovery review',
    userMembership: 'Membership',
    systemHealth: 'System health',
    killSwitch: 'Kill switch (read-only)',
    killSwitchNote: 'Read-only view: state is determined by safety policy and control-plane requests; no switch operations here.',
    killSwitchScope: 'Scope',
    killSwitchState: 'State',
    killSwitchReason: 'Reason',
    killSwitchEvaluatedAt: 'Evaluated at',
    killSwitchRawDetail: 'Show raw source (for troubleshooting)',
    killSwitchStale: '(stale)',
    killSwitchDegraded: '(degraded)',
    ok: 'OK',
    failed: 'FAILED',
  },
};

export type ConsoleLang = 'zh' | 'en';

export async function consoleLang(): Promise<ConsoleLang> {
  const cookieStore = await cookies();
  return cookieStore.get('cc_lang')?.value === 'en-US' ? 'en' : 'zh';
}

export function consoleText(lang: ConsoleLang): Record<string, string> {
  return TEXT[lang];
}

/** 受控状态 → 文案键（不透出任何后端细节）。 */
export function statusLabel(t: Record<string, string>, status: ConsoleStatus): string {
  if (status === 'LOGIN_REQUIRED') return t.loginRequired;
  if (status === 'NO_PERMISSION') return t.noPermission;
  if (status === 'NOT_FOUND') return t.notFound;
  return t.systemError;
}

/** 只渲染 API 已返回的白名单字段；不做任何补算。 */
export function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}

export function tableRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
}

export function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length} 项` : '—';
  return String(value);
}
