import type { AccountsResponse } from './dashboard-view';

/**
 * GOAL INPUT UX GUIDANCE —— 只做「输入引导」的纯函数。
 *
 * 边界（本单元硬约束）：
 *  - 只影响 Goal Hero / Goal Console 的**排列与提示文案**；
 *  - 不改变提交逻辑、不做业务判定、不声称已执行、不新增事实源；
 *  - 建议优先级只依据首页**已经在读**的 `GET /accounts` 只读事实（真实存在的 ACTIVE 连接），
 *    不新建第二份 connection 状态、不猜测用户拥有某个平台；
 *  - 无数据时回退默认 4 条顺序。
 */

/** 4 类默认建议的稳定 key（仅前端排序用；不渲染、不作为客户文案）。 */
export type GoalSuggestionKey = 'PLATFORM' | 'LOGISTICS' | 'CUSTOMS' | 'INDEPENDENT_SITE';

export const DEFAULT_GOAL_SUGGESTION_ORDER: readonly GoalSuggestionKey[] = [
  'PLATFORM',
  'LOGISTICS',
  'CUSTOMS',
  'INDEPENDENT_SITE',
];

export interface KeyedGoalSuggestion {
  key: GoalSuggestionKey;
  text: string;
}

/**
 * 只改变**排列**：命中的（已连接）类别前置，其余保持默认相对顺序。
 * 不增删建议项，也不改变任何执行能力。
 */
export function orderGoalSuggestions(
  items: readonly KeyedGoalSuggestion[],
  signals: readonly GoalSuggestionKey[] = [],
): KeyedGoalSuggestion[] {
  const priority = new Set(signals);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const pa = priority.has(a.item.key) ? 0 : 1;
      const pb = priority.has(b.item.key) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    })
    .map((row) => row.item);
}

const LOGISTICS_CHANNELS: readonly string[] = ['UPS', 'FEDEX', 'DHL', 'FREIGHT_FORWARDER'];
const PLATFORM_CHANNELS: readonly string[] = ['AMAZON_FBA', 'AMAZON_OTHER'];
const CUSTOMS_CHANNELS: readonly string[] = ['CUSTOMS_BROKER'];

/**
 * 从既有只读事实（首页已获取的 `/accounts` 响应）推导建议优先级。
 * 只有**真实存在且状态为 ACTIVE** 的连接才会命中；没有任何命中时返回 []（→ 默认顺序）。
 */
export function connectedGoalSignals(accounts: AccountsResponse | null | undefined): GoalSuggestionKey[] {
  const connections = (accounts?.platforms ?? []).flatMap((group) =>
    group.accounts.flatMap((account) => account.connections),
  );
  const active = connections.filter((connection) => connection.status === 'ACTIVE');
  const has = (predicate: (connection: (typeof active)[number]) => boolean): boolean => active.some(predicate);

  const signals: GoalSuggestionKey[] = [];
  if (has((c) => PLATFORM_CHANNELS.includes(c.channel))) signals.push('PLATFORM');
  if (has((c) => LOGISTICS_CHANNELS.includes(c.channel) || c.domain === 'LOGISTICS')) signals.push('LOGISTICS');
  if (has((c) => CUSTOMS_CHANNELS.includes(c.channel) || c.domain === 'CUSTOMS')) signals.push('CUSTOMS');
  if (has((c) => c.domain === 'INDEPENDENT_SITE')) signals.push('INDEPENDENT_SITE');
  return signals;
}

/**
 * 「过于宽泛」判定（仅前端提示用，**不参与**任何校验）：
 * 文本很短、且不含任何对象线索（平台名 / 业务对象 / 时间数字 / 币种符号）时，视为过于宽泛。
 * 命中时只显示一句自然语言提示；提交仍然可用，后端 validation / admission 规则不变。
 */
const SPECIFICITY_PATTERNS: readonly RegExp[] = [
  /\d/, // 天数 / 月数 / 金额
  /[¥$€£]/,
  /amazon|walmart|tiktok|ebay|shopify|stripe|paypal|ups|fedex|dhl|亚马逊|沃尔玛|物流|快递|关税|报关|进口|支付|退款|赔偿|索赔|账单|订单|记录|账户|平台|货代|保险/i,
];

export function isBroadGoalIntent(input: string): boolean {
  const text = input.trim();
  if (text === '') return false;
  if (SPECIFICITY_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return [...text].length <= 8;
}
