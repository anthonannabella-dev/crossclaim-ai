# RSI-P1-05 —— 不可变证据账本（append-only + supersedes）

- 分支：`gate/7-commercial-validation`
- 模块：`apps/api/src/services/autonomy/rsi-evidence-ledger.ts`（纯函数，零 IO / 零外写）
- 依据：MSG-20261005-02 —— `MetricResult` / `PromotionDecision` / `RollbackRecord` 必须 append-only，
  变更只能「写新记录 + supersedes 指向旧记录」，禁止原地改写或删除。

## 1. 契约

| 规则 | 结果 |
| --- | --- |
| 同 `evidenceId` 写入第二次 | `EVIDENCE_IMMUTABLE` |
| `supersedesId` 指向不存在的记录 | `SUPERSEDES_NOT_FOUND` |
| `supersedesId` 指向已被取代的记录（分叉） | `ALREADY_SUPERSEDED` |
| `supersedesId === evidenceId` | `SELF_SUPERSEDES_FORBIDDEN` |
| 取代跨 subject | `SUBJECT_MISMATCH` |
| 取代但 digest 完全相同（无实质变化） | `NO_OP_SUPERSEDE` |
| 追加成功 | 返回**新数组** + `head`；入参数组永不被改写 |

配套查询与校验：

- `chainOf(records, subjectRef)`：按 supersedes 链返回最早 → 最新
- `headsOf` / `headOf`：未被取代的记录；**多于一条时 `headOf` 返回 `null`**（分叉不猜，fail-closed）
- `verifyEvidenceLedger(records)`：检出重复 id、悬空 supersedes、跨 subject、自取代、一条被取代两次、环

## 2. 验收

`apps/api/src/__tests__/rsi-evidence-ledger.test.ts` 11 例：追加不改入参、重复 id 拒绝、三级 supersedes 链 +
head、悬空引用、自取代、分叉取代、跨 subject、无实质变化取代、多 head 时 `headOf = null`、
手工构造坏账本被 `verifyEvidenceLedger` 检出（重复 id / 悬空 / 环）、边界常量。

`tsc --noEmit` exit 0；门禁 `api-contract` / `audit-coverage` / `autopilot-rules` 全 OK。

## 3. 边界不变

```
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
```

本模块只定义**契约与纯函数**；真正落库仍由 RSI-RT-06 状态表承担（staging apply 已获批，
生产迁移仍 HOLD），本地数据库尚未建表。
