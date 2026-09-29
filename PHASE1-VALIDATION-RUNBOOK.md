# PHASE1 VALIDATION RUNBOOK（P2-4）

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

## 2. 步骤

```text
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
