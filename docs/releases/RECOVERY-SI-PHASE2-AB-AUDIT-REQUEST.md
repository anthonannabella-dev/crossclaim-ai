# Recovery SI Phase 2 A/B Implementation Audit —— 送审请求

- 分支：`gate/7-commercial-validation`
- **REVIEWED_HEAD = `f1f6607d`**（本批次实现提交；P2-A + P2-B 全部代码与测试都在该 SHA 上）
- 前置：**MSG-20261005-13 = PASS WITH REVISE**（`REVIEWED_HEAD = 25d0b764`；FNV `220ab1c8` / 339 行 / FULL_COPY_OK），其中授权 `P2-A = AUTHORIZED_WITH_CONDITIONS`、`P2-B = AUTHORIZED_WITH_CONDITIONS`，并要求「完成后送一次 Recovery SI Phase 2 A/B Implementation Audit；不要顺带做 PREPARE、Action Guard handoff、Schema、模型调用或真实执行」。
- 耐久记录：`docs/releases/RECOVERY-SI-PHASE2-AB-EVIDENCE.md`（含 P2-A 硬前置、P2-B 调用路径、10 条最小证据对照表）。

## 1. scope（本轮只做这两件）

1. **P2-A**：`recovery-outcome-signal.ts` —— SI 决策 → RSI Outcome Signal 映射，硬前置 `RECOVERY_OUTCOME_TO_RSI = AGGREGATED_ANONYMIZED_CAPABILITY_SIGNAL_ONLY`；只允许匿名聚合能力级指标（`estimate_error_bucket / authorization_block_rate / evidence_missing_rate / median_time_to_ready`）与 `rule-version:... / algorithm-version:...` 版本引用；禁止一切客户事实、标识符与客户金额；cohort 小于 5 不产生信号；违规即整条 fail-closed（不脱敏重发）；无 RSI sink → 零写入。
2. **P2-B**：`recovery-read-tools.ts` + `recovery-read-tool-adapters.ts` —— 三个只读工具实接现有确定性只读服务，路径固定为 `verified action → 静态 READ 绑定 → input schema → tenant context → 现有只读服务 → output schema → 敏感字段扫描 → 回 SI`；仅**已验证**的 plan action 可能触发调用；未登记 / 非 READ / 陈旧 / 跨租户 / 输出越界一律 fail-closed。

## 2. invariant

- 不建第二套 Runtime：复用 Phase 1 的 state / prioritizer / planner / verifier / policy 与既有 RSI policy engine；本轮**零运行时接线**（无 route、无 event loop、无 `rsi:run` 调用方）。
- 只读：DB 写入 0、网络调用 0、凭据读取 0；`READY_FOR_EXECUTION` 仍只是决策标记（`executionAuthorized = false`），不接 Action Guard。
- tenant：跨租户整单拒绝（`TENANT_MISMATCH`），调用数为 0；读取查询全部带 `organizationId`。
- 敏感性：工具输出的 secret / token / 文件路径 / 存储引用 / 邮箱命中即丢弃（`SENSITIVE_OUTPUT_REJECTED`），不落日志、不回传。
- 权限：`SECOND_RUNTIME = FORBIDDEN`、`L5_RELAXATION = FORBIDDEN`；PREPARE / Action Guard / Schema / 模型 / 真实执行均未触碰。

## 3. tests（本地实测）

```text
api tsc --noEmit → exit 0
recovery-si-phase2-ab：13/13 PASS（P2A-01..05 + P2B-01..10）
回归：recovery-si 11 + recovery-si-e2e 5 + recovery-si-revise 6 = 22/22 PASS
```

## 4. schema delta

```text
SCHEMA_DELTA_REQUIRED = NO（本轮无 Prisma schema / migration 变更）
```

## 5. requested verdict

1. `P2-A`（匿名聚合能力信号）是否可记 **PASS**？硬前置与禁止清单是否符合裁决要求，是否还需要最小补证？
2. `P2-B`（只读 Tool 实接）是否可记 **PASS**？10 条最小验收证据是否足够？
3. 是否同意 **P2-C（PREPARE Tool）仍不授权**、`P2-D` 仍需按 D1–D8 单独送审、`P2-E` 仍需单独 Schema Delta 审、`P2-F / P2-G` 维持 HOLD？
4. 若需修订，请只列最小集合（不要扩大本轮范围）。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本轮未改动）

```text
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD
CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
SECOND_RUNTIME = FORBIDDEN
L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
