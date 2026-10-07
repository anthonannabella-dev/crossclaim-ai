import type { Messages } from '../../i18n/dictionaries/zh-CN';

/**
 * CUSTOMER-UI-PRODUCTIZATION-V2 FINAL2 / CHANGE 2：连接状态 → 客户语言。
 * 关键：ERROR（同步失败 / provider error / 数据问题）**不等于** authorization expired，
 * 不得说成“需要重新授权”；未知状态也必须有安全的客户语言回落。
 */
export function connectionContinueLabel(status: string, labels: Messages['connectionsPage']): string {
  const table = labels as unknown as Record<string, string>;
  switch (status) {
    case 'ACTIVE':
      return table.summaryCanContinue ?? '';
    case 'PAUSED':
      return table.summaryPaused ?? '';
    case 'REVOKED':
      return table.summaryStopped ?? '';
    case 'NEEDS_AUTH':
      return table.summaryNeedsReauth ?? '';
    case 'ERROR':
      return table.summaryError ?? '';
    default:
      return table.summaryUnknown ?? '';
  }
}
