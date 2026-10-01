# R45 — Outcome / Reimbursement Reconciliation（Design / Boundary Proposal）

> 依据：**MSG-20261001-43 = PASS**（R44-B CLOSED；Manual Recovery HTTP approval + execution boundary 整体 CLOSED）
> → 架构方批准进入 **R45 — Outcome / Reimbursement Reconciliation**，且明确要求**第一批只提交 Design / Boundary Proposal，不实现**。
> 策略：《冻结底座 + 加速交付》（`.autopilot/RULES.md` R1–R10）+ 增量风险审计。
> 本文件**不含实现**，不含 Schema 变更，不触碰已冻结底座。

---

## 1. 目标与非目标

### 1.1 目标（本批次只定义边界，不实现）

把「人工已提交 / provider 已受理 / 观察到赔付 / 已对账」四类事实**分离建模**，并定义从 provider 侧 outcome 到 claim 级 reconciliation 的**可信、可审计、幂等、fail-closed** 路径。

### 1.2 非目标（明确禁止）

- 不创建 Settlement；不创建 Billing / Fee；不改写 RecoveryLedger。
- 不自动向 Amazon（或任何 provider）写入；不开启 transport；不使用生产凭据。
- **不得**把 observed reimbursement 直接等同于「可收费 recovered amount」。
- 不在本批次实现任何代码（含 Schema / migration / service / route）。

## 2. 四类事实必须分离（MSG-20261001-43 硬要求）

| 事实 | 含义 | 价值语义 | 现有承载 |
| --- | --- | --- | --- |
| `SUBMITTED_MANUAL` | 人工确认已向 provider 提交（含 package/basis 与 reference 记录） | **提交事实**，与 provider 受理无关 | R43 `ClaimItem.SUBMITTED_MANUAL` + `RecoveryManualSubmission` + `RecoveryManualSubmissionReference` |
| `PROVIDER_ACCEPTED` | provider 侧明确受理（case opened / accepted） | 受理事实，不代表赔付 | **尚无承载**（R45 定义） |
| `REIMBURSEMENT_OBSERVED` | 观察到 provider 赔付/退款（金额、币种、时间、来源） | 观察事实，**不代表与某 Claim 已对账** | **尚无承载**（R45 定义） |
| `RECONCILED` | 某笔 observed reimbursement 与某 Claim 建立**经确认的**对账关系 | 对账事实，仍**不是**可收费收入 | **尚无承载**（R45 定义） |

**不变量 R45-INV-1**：四类事实**不得互相推导**（不得因 submitted 而置 accepted；不得因 observed 而置 reconciled；不得因 reconciled 而置 recovered/可收费）。

## 3. 数据来源与信任等级（设计项 ①）

| 来源 | 信任等级 | 用途 | 备注 |
| --- | --- | --- | --- |
| 人工录入（带证据引用） | MEDIUM（人证 + 证据） | observed / accepted 的补充 | 必须走受保护动作 + 审批 + 审计 |
| 平台导出文件（报告 / 结算清单） | MEDIUM（文件指纹 + 解析版本） | observed | 需文件指纹、解析器版本、行级 provenance |
| 官方 API 只读查询 | HIGH（需授权与凭据，**继续 HOLD**） | observed / accepted | 本批次**不接入**；仅在 R45 后续批次并单独裁决 |
| 客户端自行声明 | **不可信** | —— | 一律拒绝（沿用 R44 的 anti-self-attestation 口径） |

**设计约束**：每条 observed/accepted 事实必须携带 `sourceKind`、`sourceRef`（文件 id / 报告 id）、`capturedAt`、`evidenceArtifactId[]`、`parserVersion`（如适用）、`ingestedByUserId`；缺失即 fail-closed。

## 4. 匹配与对账规则（设计项 ②–⑦）

### 4.1 匹配键

1. `providerCaseRefCanonical`（R43 S4 已有；**canonical 恒服务端构造**）→ 最高优先；
2. provider 侧 reimbursement 行自带的 case / claim / order 引用；
3. 组合键（order + date window + amount + currency）→ 仅作为**候选**，不得单独成立对账。

### 4.2 结果分类

| 结果 | 定义 | 系统行为 |
| --- | --- | --- |
| `MATCHED` | 唯一确定：reimbursement 行与**恰好一个** Claim 建立一对一关系 | 允许进入人工确认（见 §5） |
| `UNMATCHED` | 无法关联任何 Claim | 记录为待处理，**不**产生任何 Claim 级事实 |
| `AMBIGUOUS` | 可能关联多个 Claim（重复引用 / 金额与时间窗口重合） | **fail-closed**：不得自动选择；必须人工澄清 |

### 4.3 多对一 / 一对多 / 部分赔付

- **多笔 reimbursement → 一个 Claim**：允许逐笔记录 observed；对账关系为「claim ↔ N 笔 reimbursement」，需定义累计口径与完成判定（`PARTIALLY_RECONCILED` / `FULLY_RECONCILED`）。
- **一笔 reimbursement 疑似关联多个 Claim**：一律 `AMBIGUOUS`，fail-closed。
- **Partial reimbursement**：以**单笔事实**为单位记录，禁止把 partial 直接视为 claim 已恢复。

### 4.4 金额与币种

- 币种必须与 Claim 一致；不一致 → `CURRENCY_MISMATCH`（fail-closed，不得自动换算）。
- 允许 `amountTolerance`（绝对 + 相对）由**配置项**给出并审计；超出容差 → `AMBIGUOUS`，不得自动对账。
- 金额精度沿用既有 Decimal 契约（固定 4 位小数）。

### 4.5 冲正与更正

- `reversal` / `correction` **不修改**原 observed 事实（append-only）；以新的**反向/更正事实**表达，并在对账层重新计算。
- 已 `RECONCILED` 的 Claim 在冲正后必须回到 `PARTIALLY_RECONCILED` / `UNMATCHED`，且必须留下审计链。

## 5. 对账生命周期与幂等（设计项 ⑧–⑩）

1. observed 事实（append-only）→ 候选匹配（纯计算，无副作用）→ 人工确认（受保护动作 + 审批）→ reconciliation 事实（append-only）。
2. `reconciliationIdempotencyKey`：`rr1:<claimItemId>:<reimbursementFactId>`（服务端构造，客户端不得自证）。
3. 同一幂等键重复提交 → 复用已有 reconciliation（不新增事实、不重复消费审批）。
4. 所有写路径必须与既有事务/CAS/行锁口径一致（复用 R43/R44 的事务模式，不新造并发模型）。
5. 证据 provenance：对账必须引用可追溯的 observed 事实与其原始证据，不得只存裸金额。

## 6. 人工 override（设计项 ⑪）

- override 是**受保护动作**（建议命名风格：`recovery.reconciliation_override`，动作/命令式），风险等级 `INTERNAL_WRITE`，`requires: [humanApproval]`。
- 权限沿用 `claimTrackingApprove`（OWNER/ADMIN）+ **锁后实时角色重验**；FINANCE 不入执行集合（与既有口径一致）。
- override 必须携带：理由（结构化 reason code + 自由文本）、目标 observed 事实、目标 Claim、期望结果（`MATCHED` / `UNMATCHED`）、证据引用。
- override **不得**：绕过 tenant/path binding、跳过审批、修改原始 observed 事实、产生 Settlement/Billing 语义。
- override 与自动匹配结果不一致时，必须同时保留两者事实（可追溯）。

## 7. 与既有底座的复用映射（R10 复用优先）

| 能力 | 分类 | 复用对象 |
| --- | --- | --- |
| canonical identity（providerCaseRef / package digest） | `EXISTING` | R43 S2/S4 builder（唯一 builder，禁止第二套） |
| 证据引用与 provenance | `EXISTING` | `EvidenceArtifact` + 既有链接表模式 |
| 受保护动作 / HITL / 审批消费 | `EXISTING` | Action Guard + approval-tx-verify（R44-A/B 已验证的 creation→execution 模式） |
| 事务 / CAS / 行锁 / 幂等 | `EXISTING` | R43 S3 模式（advisory lock + FOR UPDATE + CAS） |
| 审计 | `EXISTING` | `AuditLog`（动作命名沿用「动作/命令」风格） |
| 只读一致性检查 | `EXISTING` | `tools/consistency/`（detect ≠ repair） |
| 解析 provider 报告文件 | `OSS_NOW`（仅在真正需要时） | 矩阵既有候选（ExcelJS / PapaParse / Docling 代码；权重另登记）；**本批次不引入** |
| 新增第三方依赖 | —— | 预计 **0 个**；若出现必须按 R10 登记 + LEVEL A/B/C 判定 |

## 8. 测试与验收草案（未来实现批次；本批次不实现）

建议编号延续 R43/R44：`M29+`（事实分离与匹配）、`RR1–RRn`（reconciliation 专属）：

- 四类事实互不推导（submitted ≠ accepted ≠ observed ≠ reconciled）；
- 匹配：唯一 / 无匹配 / 歧义 / 部分 / 多对一 / 一对多疑似；
- 币种不符 fail-closed；容差边界；
- 冲正 / 更正后对账重算且原事实不被修改；
- 幂等键重复提交不产生第二个 reconciliation；
- override：非法角色 / 无审批 / 跨租户 / 理由缺失 → fail-closed；
- 全链路零副作用断言：Settlement / Billing / RecoveryLedger / Payment 不变；
- 只读 checker：observed 与 reconciliation 的一致性与漂移检测（detect ≠ repair）。

## 9. 需要架构方裁决的问题（请逐条裁决）

1. **容差默认值**：金额容差（绝对 + 相对）默认应为多少？是否允许按 provider 配置？
2. **完成判定**：`FULLY_RECONCILED` 的判定是否必须「累计 observed ≥ claim 金额 且 全部证据可追溯」？
3. **歧义处置**：`AMBIGUOUS` 是否一律只能人工 override（不得有任何自动消歧）？
4. **冲正范围**：冲正仅影响对账层，还是也允许标记 provider accepted 事实为 `REVOKED`（仍 append-only）？
5. **override 审批粒度**：每笔 override 单独审批，还是允许「批量 override + 逐笔审计」？
6. **数据来源优先级**：人工录入与平台导出文件冲突时，是否一律 fail-closed 而非按来源优先级自动择优？
7. **Schema 批次**：R45 实现是否按 R43 模式拆为「Schema Delta Request → Implementation Plan → S1…Sn」，且每个 Schema 变更单独送审？

## 10. 风险声明

- **不得**把本设计或后续 R45 实现解读为「Recovery 商业闭环完成」：provider outcome → reimbursement observation → claim reconciliation 与 recovered money → Settlement → Billing 仍是**独立事实层**，后者仍属 R46 独立 Gate。
- 生产启用 / 真实外写 / 资金 / 客户提交 / 生产凭据继续 HOLD；Amazon write、transport、Settlement/Billing linkage 全部保持关闭。
