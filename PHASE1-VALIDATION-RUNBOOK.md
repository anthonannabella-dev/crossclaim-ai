# PHASE1 VALIDATION RUNBOOK（P2-4）

> ⚠️ **SUPERSEDED（历史归档）** —— 自 2026-10-08 起，CrossClaim 唯一正式部署入口为仓库根目录 `DEPLOYMENT.md`
> （配合 `deploy/release-manifest.json` 与 `node deploy/verify-release.mjs` 门禁）。
> 本文仅作历史记录保留，**不得作为部署流程依据**；内容冲突时以 `DEPLOYMENT.md` + manifest 为准。
> 归档索引：`docs/archive/DEPLOYMENT-HISTORY.md`


> 依据：**MSG-20260929-73**（P2-4 = GO，验收标准冻结）
> 边界：**CODE READY ≠ PRODUCTION VALIDATED**；真实数据 **WAITING_HOST_DATA**（不得用真实客户数据做测试）
> 本 Runbook 只做**只读验证与报告**：不提交 Claim/Appeal、不扣佣、不收费、不承诺金额、不调用平台

---

## 1. 输入契约（宿主提供）

| 项 | 要求 |
|---|---|
| 形态 | 已脱敏的结算/账单导出（示例：Shopify 订单/退款 CSV） |
| 最小规模 | ≥500 行 |
| 必需列（Stage A） | `order_id`、`occurred_at`、`amount`、`currency` |
| 禁止 | 买家姓名/地址/邮箱等 PII；真实支付凭据；平台凭据 |
| 交付方式 | 宿主指定路径（不经聊天、不入仓库） |

> 交付清单、字段命名与登记表以 [`HOST-DATA-REQUEST.md`](HOST-DATA-REQUEST.md) 为**单一口径**。

## 2. 步骤

```text
0) 入场前置检查（Stage 0，只读）          → tools/validation/phase1-runbook.mjs preflight <csv>
1) 接收检查（结构 + 行数 + 必需列）      → tools/validation/phase1-runbook.mjs audit-input <csv>
2) 导入（既有 pipeline）                  → 产出 ImportBatch / SourceTransaction（幂等：dedupeKey）
3) 数据质量报告                            → templates/DATA-QUALITY-REPORT.md
4) 候选发现（只读；Candidate ≠ Claim）     → templates/IMPORT-REPORT.md
5) 人工复核抽样（≥5 例）                   → TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_DATA
6) 输出 PHASE1-RESULT.md（8 节 + Decision Gate）
```

## 3. 门槛（冻结）

| 阶段 | 门槛 | 说明 |
|---|---|---|
| **Stage A** 导入完整性 | `input rows = normalized rows + quarantine rows + rejected rows` | **禁止 silent drop**；禁止自动修正未知字段；禁止猜测金额 |
| **Stage B** 候选发现 | `Candidate >= 10` | **Candidate ≠ Claim**：候选仅为潜在线索，不代表已确认追回或已主张 |
| **Stage C** 人工确认 | `human verification >= 5` | 分类固定：`TRUE_POSITIVE` / `FALSE_POSITIVE` / `NEEDS_DATA` |

阶段一**禁止**判断：回收金额 / 成功率 / ARR / 收费能力（属商业验证阶段）。

## 4. Decision Gate（只能三选一）

| Gate | 触发 |
|---|---|
| `PASS_TO_MVP` | 三项门槛全部满足 |
| `CONTINUE_DATA_COLLECTION` | Candidate 不足或人工复核不足（需要更多/更干净的数据） |
| `STOP_REWORK` | 出现未知分类/记账异常（需要返工，不得臆造） |

## 5. 失败处理

| 失败 | 处理 |
|---|---|
| 数据不足 / 缺列 | 记录缺口清单，退回宿主补齐（不臆造、不自动补值） |
| 行级解析错误 | 计入 `rejected`（Stage A 记账），用既有 error report 修复后重跑 |
| 重复导入 | 依赖 `dedupeKey` 幂等；不得产生重复事实 |
| 租户错配 | 立即停止并隔离样本，报告宿主 |
| silent drop 检出 | 阶段一不通过（`STOP_REWORK`），先修导入记账 |

## 6. 输出物（模板）

- `templates/IMPORT-REPORT.md`：导入结果（批次、成功/失败/隔离行数、错误分类）
- `templates/DATA-QUALITY-REPORT.md`：数据质量（桶分布、异常清单、抽样）
- `templates/PHASE1-RESULT.md`：8 节报告 + Decision Gate（由 `renderPhase1Result` 生成）

## 7. 工具

```bash
node tools/validation/phase1-runbook.mjs plan                        # 打印门槛与流程
node tools/validation/phase1-runbook.mjs audit-input <dataset.csv>   # Stage A 结构/记账检查
node tools/validation/phase1-runbook.mjs gate <candidates> <verified> [分类...]
```

## 8. 与冻结边界的关系

- Kill Switch 仍只做**只读观察**（Action Guard = DESIGN ONLY / HOLD）
- 本 Runbook 不接线任何业务动作；Discovery/Candidate 只产出**线索**
- 真实轮换/生产部署/DNS/TLS 仍为 HOST APPROVAL REQUIRED
- Production Enablement = HOLD
---

## 7. 常见错误案例与处置（Runbook 错误案例 · 2026-09-30 增补）

> 依据：架构方 **MSG-20260930-02** 批准等待期「文档完善」范围。
> 纪律不变：**不猜字段、不自动改写表头、不自动补值**；`preflight` 只做结构与列名检查，不做金额运算、不读内容语义。

| 现象 | `preflight` 判定 | 处置 |
|---|---|---|
| 文件为空或只有空行 | `NEEDS_FIX`（`non-empty`） | 退回宿主补齐；不得创建空批次 |
| 首行不是表头 / 只有一列 | `NEEDS_FIX`（`header-present`） | 要求导出保留表头 |
| 缺 `order_id`/`occurred_at`/`amount`/`currency` | `NEEDS_FIX`（`required-columns: missing=…`） | 由**人工显式映射**（映射表书面确认）；禁止自动改写 |
| 平台原生列名（`Order ID`/`Created At`/`Total Price`） | `NEEDS_FIX` + `alias-hints`（非阻断提示） | 别名仅作提示；系统不会自动映射 |
| 行数 < 500 | `NEEDS_FIX`（`min-rows`） | 继续采集后再跑 |
| 出现 `buyer_name`/`ship_address`/`email` 等列 | `NEEDS_FIX`（`no-pii-columns`，按列名保守判定） | 整列占位后重交；不读取内容 |
| 某行字段数与表头不一致（含跨行引号） | `NEEDS_FIX`（`no-ragged-rows`） | 请宿主修正导出；Stage A 会把它计入 `rejected` |
| `order_id` 重复 | `NEEDS_FIX`（`unique-order-id`） | 确认是否同单多行；需要时先拆分/聚合再交付 |
| `occurred_at` 无法解析 | `NEEDS_FIX`（`dates-parsable`） | 统一为 ISO 日期 |
| 数据不在最近 3 个月 | 非阻断（`recent-window-preferred=false`） | 可继续，但报告须注明时间窗 |
| 字段内含逗号/引号 | ⚠️ `preflight` 只按逗号切分，可能误判裂行 | 用 `audit-input` 复核；必要时先产出规范化 CSV |
| `preflight` 通过但 Stage A 记账不平 | 属 `STOP_REWORK` 线索 | 先修导入记账；**禁止 silent drop** |

**退出码约定**：`preflight` 返回 `0 = READY_FOR_STAGE_A`、`1 = NEEDS_FIX`（便于脚本/CI 判定）。
