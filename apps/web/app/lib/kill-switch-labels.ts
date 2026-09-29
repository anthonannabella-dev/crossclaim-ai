/**
 * Kill Switch — 展示层映射（READ_ONLY）
 * ------------------------------------------------------------------
 * 纪律（MSG-20260929-68）：
 *   Resolver Source → Presentation Mapping → Human Label
 *   - 内部枚举（machine value）不得直接暴露给最终使用者；
 *   - UI 只做渲染，**绝不参与判定**（判定只依据 API 返回的 value/source）；
 *   - 未识别的 source 一律按「已关闭（原因未知）」呈现（fail closed 的展示面）；
 *   - 映射集中在本文件，其他页面不得自行解释 source。
 */

export type KillSwitchLang = 'zh' | 'en';

const SOURCE_LABELS: Record<KillSwitchLang, Record<string, string>> = {
  zh: {
    'global-hard-disabled': '已由系统全局安全策略关闭',
    'tenant-control': '已由本租户的控制面请求设置',
    'tenant-config': '已由本租户配置设置',
    'global-config': '已由系统配置开启',
    'environment-default': '系统默认（未启用）',
    'fail-closed': '因无法确认状态而保持关闭',
  },
  en: {
    'global-hard-disabled': 'Disabled by system-wide safety policy',
    'tenant-control': 'Set by this tenant control request',
    'tenant-config': 'Set by this tenant configuration',
    'global-config': 'Enabled by system configuration',
    'environment-default': 'System default (not enabled)',
    'fail-closed': 'Disabled because state could not be verified',
  },
};

const UNKNOWN_SOURCE_LABEL: Record<KillSwitchLang, string> = {
  zh: '已关闭（原因未知）',
  en: 'Closed (reason unknown)',
};

const VALUE_LABELS: Record<KillSwitchLang, Record<string, string>> = {
  zh: { enabled: '已开启', disabled: '已关闭' },
  en: { enabled: 'Enabled', disabled: 'Closed' },
};

/** 内部 source → 人类可读文案；未知取值按「已关闭（原因未知）」。 */
export function sourceLabel(lang: KillSwitchLang, source: unknown): string {
  if (typeof source !== 'string') return UNKNOWN_SOURCE_LABEL[lang];
  return SOURCE_LABELS[lang][source] ?? UNKNOWN_SOURCE_LABEL[lang];
}

/** 开关值 → 文案；未知/非法取值按「已关闭」（fail closed 展示面）。 */
export function valueLabel(lang: KillSwitchLang, value: unknown): string {
  if (typeof value !== 'string') return VALUE_LABELS[lang].disabled;
  return VALUE_LABELS[lang][value] ?? VALUE_LABELS[lang].disabled;
}

/** 是否可展示「原始枚举」的详情（仅 OWNER/ADMIN 全量视图会带出这些字段）。 */
export function hasRawSourceDetail(item: Record<string, unknown>): boolean {
  return typeof item.source === 'string';
}
