# ARCH REVIEW REQUEST — BG-012（Customs 内部触发接线）

- 时间：2026-10-03T15:06:37.798Z；REVIEWED_HEAD：`1bf8d7b`
- 依据：MSG-20261003-133 Q3 明确「EXTERNAL_WRITE Action Guard 接线」属于必须停止该分支并**重新送审**的情形。

## 1. 请求裁决的事项

BG-012 拟实现「Customs G4 内部触发」HTTP 端点（例如 `POST /customs-entry-facts/:id/recovery-chain`），用于服务端运行确定性恢复链并持久化投影。请裁决：

1. 是否允许新增该**内部触发**端点（非 filing、非外部写；仅服务端重算 + append-only 投影写入）？
2. Action Guard 边界：该端点应注册为哪个 action（例如 `customs.recovery.chain_runs`）？允许哪些角色（OWNER/ADMIN/OPS/FINANCE/VIEWER）？是否需要 capability-source / kill switch 覆盖？
3. 是否需要额外的幂等键（例如同一 factId + policyVersion + computedAt 的重复触发返回既有投影）？
4. 该端点是否必须保持 `filingSubmitted=false` / `externalWritePerformed=false` / `transportEnabled=false` 的响应字段（当前设计：是）？
5. 是否授权 dispatcher 在本项获批后按上述边界自动 materialize 并执行（含路由级 E2E 与 API.md 同步）？

## 2. 现状（已 CLOSED 部分）

- Customs G4 C1–C7 已 CLOSED；只读 GET `/customs-entry-facts/:entryFactId/return-claim-evidence` 已接线并有路由级 E2E（401/403/404/200）。
- 服务层 `runCustomsRecoveryChain` 已有真实 PG 4/4 回归（重算 + 投影 append + 历史保留）。
- 本项只是把该服务层暴露为受保护的内部触发端点；不涉及真实 filing / broker / 外部写。

## 3. 边界（请求裁决期间保持不变）

Production Enablement=HOLD · External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY。
