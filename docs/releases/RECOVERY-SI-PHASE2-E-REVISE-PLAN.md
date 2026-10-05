# Recovery SI P2-E v1 — REVISE 修订方案（DRAFT / 依据部分裁决）

> **状态：DRAFT — 未授权实现。**
> 依据：MSG-20261005-22（P2-E 设计裁决 = `PASS WITH REVISE`，`REVIEWED_HEAD = 48e6e2a3`）。裁决全文 10521 字符 / 731 行尚未完成逐字归档（见 `AUDIT-CAPTURE-LIMITATION-AND-P2E-VERDICT-CURSOR.md`），其中「事务原子性」「lineage 表述」两项必修的**正文条款尚未读取**。
> 因此本文件只固化**已确认条款**的修订方向，不构成实现授权；待全文归档后补齐并重新送审。

## 1. 已确认必修（可直接据此改设计）

### 必修 1 — 入口门禁：`P2_E_GUARD_ACTION = claim.prepare`

裁决明确否定了我提交的写法「只有 P2-D `ALLOW` 才允许 P2-E 写入」，理由是 P2-D 对 `PLATFORM / CARRIER / INDEPENDENT_SITE` 使用的是 `claim.submit`，而真实 Control Plane 下

```
claim.submit + 无 approvalId → REQUIRE_APPROVAL
```

这是 P2-D 刚验证通过的正确行为；若把 P2-E 写入绑到它，等于要求「包必须先取得真实提交审批」，把内部 preparation 错绑到 external submission 门上。

修订后的 v1 入口链路（裁决原文）：

```
fresh state
→ canonical READY alignment
→ verified P2-C package preview / deterministic facts
→ trusted ProductionControlPlane
→ evaluate claim.prepare
→ ALLOW
→ persistence transaction
```

即：

```
P2_E_GUARD_ACTION = claim.prepare          # 不是 claim.submit
P2_E_REQUIRES_P2D_ALLOW = NO               # 不再要求 P2-D ALLOW
保留：canonical READY 对齐（沿用 P2-D CHANGE D1 的 SUPLIED_READY == CANONICAL_PLANNER_READY）
保留：verified P2-C preview 作为事实来源（manifest / digest 原样落库，不重算）
新增：写入前必须先过一次可信 Control Plane 的 claim.prepare 判定（ALLOW 才进入持久化事务）
```

## 2. 仍需读取全文后才能定稿的部分（不得猜测实现）

| 编号 | 必修 | 状态 |
| --- | --- | --- |
| 必修 2 | **事务原子性**（标题已确认，正文待读） | `PENDING_FULL_VERDICT` |
| 必修 3 | **lineage 表述**（标题已确认，正文待读） | `PENDING_FULL_VERDICT` |
| 第 ②③④⑤ 条裁定 | P2E-01..10 是否足够 / OWNER approval 前置 / P2-F·P2-G 独立送审确认 / 最小修订集合 | `PENDING_FULL_VERDICT` |

在正文读到之前，**不开始** P2-E 实现；已确认的必修 1 只作为设计修订方向记录。

## 3. 与既有证据集合的映射（预排，待终稿确认）

| 证据 | 与必修 1 的关系 |
| --- | --- |
| `P2E-01`（写入门禁） | 改为断言：`claim.prepare` DENY / REQUIRE_APPROVAL → 零写入；`claim.prepare` ALLOW → 才允许持久化事务 |
| `P2E-02`（tenant 四点） | 不变 |
| `P2E-03`（幂等/并发） | 加入「事务内 CAS + 唯一约束」断言（待必修 2 定稿后细化） |
| `P2E-05`（lineage） | 按必修 3 的表述重写（待定稿） |
| `P2E-06/07`（零外写 / 零网络零凭据） | 不变 |
| `P2E-09`（真实 PostgreSQL 迁移 + 触发器清单） | 不变（既有 tenant / append-only / controlled-mutation 触发器复用） |

## 4. 边界（不变）

```
P2_E_V1_OPTION = A（AUTHORIZED_WITH_CONDITIONS）
P2_E_OPTION_B = NOT_AUTHORIZED
SCHEMA_DELTA_REQUIRED = NO（当前阶段）
RUNTIME_WIRING = NONE
APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN
P2_F = HOLD
P2_G = HOLD（真实执行必须另开 P2-G）
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
