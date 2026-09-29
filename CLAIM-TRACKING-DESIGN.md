# CLAIM TRACKING DESIGN — CrossClaim AI

> 状态：**DESIGN ONLY（未实现）** · 依据架构方 **MSG-20260929-20：Claim Tracking = DESIGN-FIRST**
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29
> 纪律：自动提交仍为 FORBIDDEN；本设计不改变任何现行冻结，也不含 migration。

---

## 1. 现状基线（已存在的 Track 能力）

| 层 | 现状 |
|---|---|
| Claim | `Claim{ round, status, target, externalRef, submittedAt/By, dueAt, respondedAt, responseAmount/Note, aiDraftText, finalText, attachmentKey }` |
| 状态机 | `ClaimStatus = DRAFT/SUBMITTED/ACKNOWLEDGED/APPROVED/PARTIALLY_APPROVED/REJECTED/NO_RESPONSE/WITHDRAWN` |
| Appeal | `Appeal{ round(默认2), status, submittedAt, externalRef }`，`AppealStatus = DRAFT/SUBMITTED/UNDER_REVIEW/UPHELD/OVERTURNED/REJECTED/WITHDRAWN` |
| 目标 | `RouteTarget = PLATFORM/CARRIER/FREIGHT_FORWARDER/INSURER/CUSTOMS_AUTHORITY/CUSTOMS_BROKER/CUSTOMER_SELF/NONE` |
| 金额回流 | `Settlement` / `RecoveryLedgerEntry` / `FeeCalculation` / `BillingInvoice`（回收确认走 `recovery-outcome` 服务） |
| 审计 | 每次状态迁移写 `AuditLog`（actor / 时间 / from→to） |

**结论**：Claim 的「结果态」字段齐备，缺的是**时间轴与外部追踪**：平台侧案件号语义、时效/Deadline 计算、响应时限监控、逐事件留痕、与回收确认的显式交接。

---

## 2. 目标与非目标

目标：
1. 一条 Claim 从「准备」到「终局」的**完整可追踪时间轴**，任何人可回答「现在卡在哪、下一步谁做什么、什么时候到期」。
2. 与既有 `recovery-outcome`（回收确认）**显式交接**：终局为 APPROVED/PARTIALLY_APPROVED 时才允许进入回收确认。
3. 对 Dashboard / Admin / Notifications 提供**稳定只读模型**（避免三个界面各写一套查询）。

非目标：
- 不实现对外提交（仍 FORBIDDEN，`AI Prepare → Human Approve → Submit`）。
- 不做平台侧自动化轮询（连接器/API 仍 HOLD）。
- 不改变金额口径、佣金与账单语义。

---

## 3. 生命周期与状态机（建议）

```
DRAFT ──(人工批准并记录提交)──▶ SUBMITTED ──▶ ACKNOWLEDGED ──▶ {APPROVED|PARTIALLY_APPROVED|REJECTED|NO_RESPONSE}
  │                                   │                              │
  └──(放弃)──▶ WITHDRAWN              └──(超时未响应)──▶ NO_RESPONSE ──┘
```

规则（建议）：
1. 只有 `DRAFT → SUBMITTED` 需要**人工批准**证据（`approvedByUserId` + 载荷指纹）。
2. `SUBMITTED → ACKNOWLEDGED` 允许由人工录入外部回执（平台案件号写 `externalRef`）。
3. 终局态（APPROVED / PARTIALLY_APPROVED / REJECTED / NO_RESPONSE / WITHDRAWN）**不可回退**；更正走新一轮 `round+1`。
4. `dueAt` 由创建时的参照数据（承运商/平台时限）计算；缺参照数据时**留空并给 ACTION**，不猜。
5. `PARTIALLY_APPROVED` 必须带 `responseAmount`，否则不允许进入回收确认。
6. `NO_RESPONSE` 仅在超过 `dueAt + 宽限期` 后由人工确认（不自动判定）。

---

## 4. 时间轴（新增只读视图，不新增核心模型）

建议**不新增核心表**，时间轴由三处合成：

| 事件源 | 内容 |
|---|---|
| `AuditLog`（已存在） | 状态迁移、人工批准、字段变更（含 from/to） |
| `Claim` 字段（已存在） | 提交时间、回执时间、响应金额/备注、`externalRef` |
| 交付物状态（已存在） | 申诉包 LOCKED/释放、附件指纹 |

→ 输出 `ClaimTimelineEntry{ at, actor, kind, from?, to?, ref?, noteRef }`（只读投影，不落库）。

**理由**：避免为「看历史」新增表；`AuditLog` 已是同一事务内的权威来源（audit-coverage 闸门在管）。

---

## 5. 建议的 Schema Delta（仅在获批后才提交正式 Delta Request）

| # | 变更 | 目的 | 备注 |
|---|---|---|---|
| S1 | `Claim.platformCaseRef String?` | 区分「我方提交引用」与「平台案件号」 | 与 `externalRef` 并存，语义分离 |
| S2 | `Claim.deadlineSource String?` | 记录 `dueAt` 的来源（参照数据版本 / 人工录入） | 无来源则不得有 `dueAt` |
| S3 | `Claim.approvedByUserId String?` + `approvedAt DateTime?` | 人工批准证据（HITL 留痕） | 仅 OWNER/ADMIN 可写 |
| S4 | `Claim.terminalReasonCode String?` | 终局原因（REJECTED/NO_RESPONSE 等） | 枚举化，禁止自由文本入库 |
| S5 | `@@index([organizationId, status, dueAt])` | 到期看板查询 | 普通索引 |

> 规模提示：S1–S4 属**字段扩展**，不改现有语义；S5 仅索引。全部需架构方批准后走 Schema Delta Request。

---

## 6. 角色与权限（沿用既有矩阵）

| 动作 | OWNER | ADMIN | OPS | FINANCE | VIEWER |
|---|---|---|---|---|---|
| 查看 Claim 时间轴 | ✅ | ✅ | ✅ | ✅（受限字段） | ❌ |
| 记录提交（人工批准） | ✅ | ✅ | ❌ | ❌ | ❌ |
| 录入外部回执 / 案件号 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 判定终局（含 NO_RESPONSE） | ✅ | ✅ | ❌ | ❌ | ❌ |
| 触发回收确认 | ✅ | ✅ | ✅ | ✅ | ❌ |

所有动作写 `AuditLog`；FINANCE 仍看不到证据正文（沿用 C-0011 边界）。

---

## 7. 幂等与并发

1. 状态迁移用 **CAS**（`updateMany({ where: { id, status: expectedFrom } })`），冲突返回稳定错误码而非 500。
2. 外部回执录入以 `(organizationId, platformCaseRef)` 幂等；重复录入不新增时间轴事件。
3. 终局不可回退由服务层 + 数据库约束共同保证（沿用现有 CAS 风格）。
4. 与回收确认的交界：`recovery-outcome` 必须校验对应 Claim 处于 APPROVED/PARTIALLY_APPROVED。

---

## 8. 失败模式

| 场景 | 处理 |
|---|---|
| 缺 `dueAt` 来源 | 留空 + ACTION（不猜时限） |
| 平台回执格式未知 | 人工录入为主，字段白名单校验 |
| 重复回执 | 幂等命中，时间轴不重复 |
| 终局后收到更正 | 不开新轮次不允许改；建议 `round+1` |
| 长时间无响应 | 到期看板提示（由 Dashboard 读，不在本层判定） |

---

## 9. 只读接口（供 Dashboard / Admin / Notifications）

- `listClaimsForTracking(orgId, filters{status, dueBefore, target})` → 列表 + 到期标记
- `getClaimTimeline(orgId, claimId)` → `ClaimTimelineEntry[]`
- `listExpiringClaims(orgId, withinDays)` → 供通知与看板

（均为只读投影；写操作仍走既有服务层与权限矩阵。）

---

## 10. 已知限制与不做的部分

- 不自动轮询平台状态（连接器 HOLD）。
- 不自动判定 NO_RESPONSE 与胜败（人工确认）。
- 不生成申诉文本、不触发对外提交（保持 FORBIDDEN）。
- 不引入新依赖。

---

## 11. 请裁决

NEED: **GO / REVISE / HOLD**（CLAIM-TRACKING-DESIGN）

若 GO，我将按 §5 提交独立的 **Schema Delta Request**（S1–S5），获准后再实现服务层、只读投影与测试（单测 + 真实库集成 + 幂等/并发用例），并提交 Implementation Checkpoint。
