# EXPERIENCE MEMORY v1 — 最小 Schema Delta 审计请求（**未实施**）

授权依据：HOST 2026-10-06「SI/RSI GAP-CLOSURE DIRECTIVE」步骤 C；工程纪律「Schema Delta 必须先做最小审计、
不静默改 Production Schema」。

状态：**REQUEST ONLY / NOT APPLIED**。本次交付的 Experience Memory v1 为**端口 + 纯函数**实现
（`ExperienceMemoryStorePort` + `createInMemoryExperienceMemoryStore`），**未新增任何表、未新增 migration**。

---

## 1. 为什么需要（真实缺口）

Experience Memory v1 的语义要求「raw experience **append-only**」且跨重启可重建聚合。
内存 store 只在进程内有效，无法满足「可审计 / 可回滚 / 跨重启」的持久化要求。因此需要**最小**持久化承载。

## 2. 提议的最小 Delta（1 表，无新增枚举）

| 项目 | 内容 |
|---|---|
| 表名 | `ExperienceRecord` |
| 主键 | `id String @id`（= 现有 `experienceId`，由记录 digest 派生，天然幂等） |
| 关键列 | `experienceClass String`（FACT/AGGREGATE/HEURISTIC，CHECK 约束）· `organizationId String` · `accountId String?` · `provider String` · `domain String` · `ruleVersion String` · `windowFrom DateTime` · `windowTo DateTime` · `sourceCount Int` · `confidenceBp Int` · `sourceRefs Json` · `dimension Json`（稳定 code，不含自由文本 payload） · `recordedAt DateTime` · `recordDigest String` |
| 约束 | `@@unique([id])`（幂等追加）· `@@index([organizationId, accountId, recordedAt])` · `@@index([provider, domain, recordedAt])` · CHECK：`experienceClass IN ('FACT','AGGREGATE','HEURISTIC')`、`confidenceBp BETWEEN 0 AND 10000`、`sourceCount >= 1`、`recordDigest` 长度 64 |
| append-only | 与既有 RSI 证据表同口径：拒绝 `UPDATE` / `DELETE`（现有 `RSI_EVIDENCE_APPEND_ONLY` 机制复用，不新建第二套） |
| 租户隔离 | 与现有 tenant-owned 表一致：`organizationId` 非空 + tenant guard 触发器清单登记（`tools/tenant-triggers/*`） |

**明确不做**：不建向量库、不建 embedding 表、不建第二套证据库、不建第二套 cost ledger。

## 3. 安全要求（Delta 实施时必须一并满足）

1. 只允许 server-derived 写入（写入路径必须来自服务端派生，不接受客户端自报）。
2. 禁止写入凭据类内容或原始 provider payload（沿用 `assertNoForbiddenExperienceContent`）。
3. append-only：UPDATE / DELETE 一律拒绝（与既有证据表机制一致）。
4. 不改变任何 Policy / Guard / Control Plane / Action Catalog 归属；不授予任何 External Write。

## 4. 影响面与回滚

* 影响：新增 1 表 + 触发器清单登记 + 架构契约（模型计数）同步；**不改动既有表**。
* 回滚：Drop 该表即回到本请求之前的形态；本单元代码在无表时可继续用内存 store 运行（fail-open 到内存，不影响既有链路）。

## 5. 请求

请架构方裁定：**APPROVE / APPROVE WITH REVISE / REJECT**，并指定：
`EXPERIENCE_MEMORY_SCHEMA_DELTA = APPROVED(_WITH_REVISIONS) | REJECTED`，以及是否要求在本程序内立即实施
（若要求实施，将按 A-S1/A-S3 的既有流程：migration → tenant/append-only 触发器登记 → 架构契约同步 → PG 级测试）。

