# [RSI → ARCHITECT] Model Router → 真实 Provider Adapter 设计送审

## 0. 背景与现状（可复核）

- 已完成：RSI 续跑闭环真实化（真实 Runner / 无伪成功 / PASS 需真实且新鲜证据 / park-for-judge / 裁决取值接入 / 项目执行器 / 本地自举 PASS）。
- 已完成（本批之前）：Model Router（低成本优先、强模型升级）、cost policy（预算）、cost ledger，均有通过套件：
  `apps/api/src/services/autonomy/rsi-model-router.ts`、`rsi-cost-policy.ts`、`rsi-cost-ledger.ts`。
- 缺口：router 的实际调用仍是占位/本地仿真；没有把调用接到真实 Provider Adapter。
- 该点触及 Provider 凭据 / 外部调用 / 可能产生费用 → 属高风险边界，故先送设计裁定，本轮零代码改动。

## 1. 提议的最小端口（不改变 router 既有策略）

```ts
export interface RsiModelInvocation {
  taskKind: string;
  promptRef: string;
  tier: 'CHEAP' | 'STRONG';
  budget: { remainingUsd: number; maxUsdThisCall: number };
}

export interface RsiModelResult {
  ok: boolean;
  modelId: string | null;
  outputRef: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
  reason?: 'BUDGET_EXCEEDED' | 'ADAPTER_UNAVAILABLE' | 'PROVIDER_ERROR' | 'REFUSED';
}

export interface RsiModelProviderAdapter {
  invoke(input: RsiModelInvocation): Promise<RsiModelResult>;
}
```

- 低成本优先 / 强模型升级：沿用既有 router 决策，adapter 只做执行；本级不引入新的模型选择逻辑。
- 预算熔断：调用前用 cost policy 估算 maxUsdThisCall；若超过 remainingUsd 则不调用，返回 BUDGET_EXCEEDED（fail-closed），并记一次 ledger 事件。
- 凭据隔离：RSI 进程不持有 provider 凭据、不读环境中的 *_API_KEY；凭据由注入的 adapter 在受信边界内自行获取。

## 2. 明确禁止（沿用既有硬边界）

- RSI 不得通过该 adapter 进行 External Write / Payment / Provider Transport / 报关提交 / 资金操作；
- promptRef 与 outputRef 不得含客户数据、PII、凭据、token；adapter 输入输出不得写入 RSI 的 artifact 或日志原文（只允许 digest/引用）；
- RSI 不得把 provider 原文落库；ledger 只记模型标识、用量与费用（不含内容）。

## 3. 需要裁定

1. 上述 RsiModelProviderAdapter 端口形状是否可接受？是否需要 timeoutMs / maxRetries 显式入参（我倾向：超时沿用既有 runner 的 timeout 语义，重试由 supervisor 策略负责，adapter 内不重试）。
2. 凭据注入方式：由宿主在进程内注入 adapter（凭据只在该 adapter 内可见）是否可接受？是否要求独立 sidecar / 本地代理？
3. 网络与费用：是否同意本轮只允许本地/仿真 adapter 通过；真实 provider 网络调用与任何付费调用继续 HOLD，直到明确批准？
4. 是否需要为 adapter 增加输出 schema 校验 + 敏感内容过滤（fail-closed）作为通过前置？
5. 通过后下一步：先实现本地仿真 adapter（可测、零网络、零费用）并把 router 接上；真实 adapter 单独再送一次窄审计。

## 4. 边界（本轮未动）

EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD；TRANSPORT=false；
RSI 仍只做只读观察 + 内部编排；本轮零代码改动、零网络调用。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。
